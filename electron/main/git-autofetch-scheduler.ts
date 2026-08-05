/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Git auto-fetch scheduler (pure logic).
 *
 * Decides WHEN each repo is due for a background `git fetch` so the Task git
 * badge's "behind" count (`↓M`) reflects the remote instead of freezing at the
 * last fetch. Ahead is always local-accurate and needs no network; behind is
 * only as fresh as the last fetch (it is measured against the LOCAL
 * remote-tracking ref), which is the whole reason this scheduler exists.
 *
 * Design (confirmed strategy, 2026-07-15 — see
 * docs/html/git-ahead-behind-fetch-strategy.html):
 *   - Period: configurable, default 10 min. Long on purpose — many Task repos
 *     multiply network/process cost, and a 10-min behind latency is fine for
 *     "am I behind?".
 *   - Scope: the set of unique repo roots currently in use, deduped. The host
 *     supplies that set each tick via {@link syncRepos}; the scheduler prunes
 *     repos that dropped out.
 *   - App-hidden pause: while the window is hidden/minimized {@link tick}
 *     returns nothing (save network/battery); returning to the foreground lets
 *     any already-elapsed repo fire on the very next tick (natural catch-up,
 *     no special path).
 *   - Kill switch: {@link setEnabled}(false) parks the whole scheduler.
 *   - Per-repo exponential backoff on failure: a fetch that fails (offline /
 *     no credentials / no remote) backs the NEXT attempt off from the base
 *     interval, doubling per consecutive failure, capped at
 *     {@link GIT_AUTOFETCH_MAX_BACKOFF_MS} (1 h). A success resets the streak.
 *     This is what keeps a dead / auth-walled repo from being retried every
 *     period forever.
 *   - Two "user is present" escape hatches (BUG-0005, confirmed strategy
 *     2026-08-04 — see docs/html/git-autofetch-recovery-strategy-options.html).
 *     The 1 h ceiling above is correct for an unattended dead repo, but it used
 *     to be the ONLY rule: a repo whose fetch always times out was pinned at
 *     1 h forever, and NOTHING the user did could shorten it. A user staring at
 *     a frozen ↓behind had no way to ask for a retry. So:
 *       1. {@link requestPriorityRetry} — the user focused a Task whose repo is
 *          backed off → grant ONE backoff-bypassing attempt, rate-limited by
 *          {@link GIT_AUTOFETCH_PRIORITY_COOLDOWN_MS} per repo. The streak is
 *          NOT reset, so an unattended repo keeps its 1 h cadence; the extra
 *          budget is spent only where the user is actually looking. Worst case
 *          per repo is one 20 s fetch per 5 min ≈ 6.7 % duty cycle.
 *       2. {@link setAppVisible} hidden → visible HALVES every streak. Failures
 *          accrued around a hidden stretch should not keep the user waiting the
 *          full ceiling now that they are back (during the hidden stretch we did
 *          not even attempt, so those failures are stale evidence).
 *     Deliberately NOT done: resetting the streak to 0 on visible. That would
 *     make the backoff vacuous — a dead remote would burn a 20 s fetch and one
 *     of the 3 concurrency slots every 10 min forever.
 *
 * Pure + dependency-free so `test/unittest` loads it with no Electron build.
 * `now` is always injected (the scheduler never reads the clock) so unit tests
 * are deterministic and the logic is resume-safe. The impure side — spawning
 * the hardened `git fetch`, its timeout, and triggering a mirror recompute on
 * success — lives in `git-autofetch-manager.ts`.
 */

/** Default fetch period: 10 minutes. */
export const GIT_AUTOFETCH_DEFAULT_INTERVAL_MS = 600_000
/** Backoff ceiling: a failing repo is retried at most once an hour. */
export const GIT_AUTOFETCH_MAX_BACKOFF_MS = 3_600_000
/** Lowest interval an env override is allowed to set (guards a runaway loop). */
export const GIT_AUTOFETCH_MIN_INTERVAL_MS = 60_000
/**
 * A focus-driven priority retry is refused unless at least this long has passed
 * since the repo's last attempt. Stops a focus/blur flap (or a click storm on
 * the Task list) from turning into back-to-back fetches.
 */
export const GIT_AUTOFETCH_PRIORITY_MIN_SINCE_ATTEMPT_MS = 60_000
/**
 * Per-repo cooldown between two granted priority retries. With the 20 s fetch
 * ceiling this bounds the focused repo's extra cost at 20 s / 5 min ≈ 6.7 %
 * duty cycle — the number the strategy decision was signed off against.
 */
export const GIT_AUTOFETCH_PRIORITY_COOLDOWN_MS = 300_000

/**
 * Effective gap before a repo's next fetch: the base interval when healthy,
 * `base × 2^failureStreak` when the last attempts failed, capped at `maxMs`.
 * Pure + exported so a diagnostic trace can compute the SAME number the
 * scheduler gates on. `failureStreak <= 0` → base (a healthy repo is never
 * delayed past its period).
 */
export function computeAutofetchBackoffMs(
  baseIntervalMs: number,
  failureStreak: number,
  maxMs: number
): number {
  if (failureStreak <= 0) return baseIntervalMs
  // 2^streak grows fast; clamp the exponent so the shift can't overflow before
  // the min() caps it (streak of 30 already dwarfs any real maxMs).
  const exponent = Math.min(failureStreak, 30)
  const backed = baseIntervalMs * 2 ** exponent
  return Math.min(backed, maxMs)
}

/** Why a {@link GitAutofetchScheduler.requestPriorityRetry} call was refused. */
export type PriorityRetryRefusal =
  | 'unknown-repo'
  | 'in-flight'
  | 'not-backed-off'
  | 'attempted-recently'
  | 'cooldown'
  | 'already-pending'

export interface PriorityRetryDecision {
  granted: boolean
  /** Set only when `granted` is false — the specific gate that refused. */
  reason?: PriorityRetryRefusal
}

interface RepoFetchState {
  inFlight: boolean
  // ms; NEGATIVE_INFINITY until the first fetch so a freshly-added repo is due
  // on the very first eligible tick (fetch soon after a repo appears).
  lastFetchAt: number
  // consecutive failures; drives the backoff. Reset to 0 on any success.
  failureStreak: number
  // ms; NEGATIVE_INFINITY until the first granted priority retry. Drives the
  // per-repo cooldown so focus churn cannot buy unlimited retries.
  lastPriorityRetryAt: number
  // A priority retry was granted and has not been spawned yet. Makes the repo
  // due on the next tick regardless of its backoff gap; cleared by onFetchStart.
  priorityPending: boolean
}

export class GitAutofetchScheduler {
  private readonly intervalMs: number
  private readonly maxBackoffMs: number
  private readonly repos = new Map<string, RepoFetchState>()
  private enabled = true
  private appVisible = true

  constructor(options: { intervalMs?: number; maxBackoffMs?: number } = {}) {
    this.intervalMs = options.intervalMs ?? GIT_AUTOFETCH_DEFAULT_INTERVAL_MS
    this.maxBackoffMs = options.maxBackoffMs ?? GIT_AUTOFETCH_MAX_BACKOFF_MS
  }

  /** Kill switch. Disabled → {@link tick} yields nothing; state is retained. */
  setEnabled(enabled: boolean): void {
    this.enabled = enabled
  }

  /**
   * App window visible (not hidden/minimized). Hidden → tick pauses.
   *
   * A hidden → visible EDGE additionally halves every repo's failure streak
   * (BUG-0005 R1-B). Rationale: while hidden we never attempted, so a streak
   * carried across that stretch is stale evidence about the remote's health —
   * yet it was still pinning the gap at the 1 h ceiling exactly when the user
   * came back and started looking at the badge. Halving (rather than resetting)
   * keeps a genuinely dead remote backed off.
   *
   * Idempotent on repeated same-value calls: the host wires this to
   * show/hide/minimize/restore and fires it on every one of them, so only a real
   * transition may mutate state.
   *
   * @returns the number of repos whose streak actually changed (0 when this was
   *          not a hidden → visible edge, or nothing was backed off). Returned
   *          rather than traced here so this module stays pure.
   */
  setAppVisible(visible: boolean): number {
    const wasVisible = this.appVisible
    this.appVisible = visible
    if (!visible || wasVisible) return 0
    let halved = 0
    for (const state of this.repos.values()) {
      if (state.failureStreak <= 0) continue
      state.failureStreak = Math.floor(state.failureStreak / 2)
      halved += 1
    }
    return halved
  }

  /**
   * Replace the tracked repo set with `repoKeys` (unique repo roots in use).
   * New repos start due-immediately; repos no longer present are pruned. An
   * in-flight fetch for a pruned repo is dropped from tracking — its
   * onFetchDone becomes a no-op (guarded below).
   */
  syncRepos(repoKeys: readonly string[]): void {
    const live = new Set(repoKeys)
    for (const key of live) {
      if (!this.repos.has(key)) {
        this.repos.set(key, {
          inFlight: false,
          lastFetchAt: Number.NEGATIVE_INFINITY,
          failureStreak: 0,
          lastPriorityRetryAt: Number.NEGATIVE_INFINITY,
          priorityPending: false
        })
      }
    }
    for (const key of this.repos.keys()) {
      if (!live.has(key)) this.repos.delete(key)
    }
  }

  /** Host calls this right before it spawns the fetch for `repoKey`. */
  onFetchStart(repoKey: string): void {
    const state = this.repos.get(repoKey)
    if (!state) return
    state.inFlight = true
    // A granted priority retry is consumed by the spawn it caused, whether that
    // spawn was triggered by the priority grant or by the normal gap elapsing
    // first. Either way the user's request has been served.
    state.priorityPending = false
  }

  /**
   * The user focused a Task belonging to `repoKey`. Grant ONE fetch that
   * bypasses the failure backoff, if every gate allows it (BUG-0005 R1-A).
   *
   * Gates, in refusal order:
   *   - the repo is not tracked (no active cwd) → nothing to fetch;
   *   - a fetch is already in flight → the user is already being served;
   *   - `failureStreak === 0` → the repo is healthy and its normal 10 min
   *     cadence applies; a focus must NOT turn into a fetch-per-focus loop;
   *   - the last attempt was under {@link GIT_AUTOFETCH_PRIORITY_MIN_SINCE_ATTEMPT_MS}
   *     ago → too soon to learn anything new;
   *   - the last GRANT was under {@link GIT_AUTOFETCH_PRIORITY_COOLDOWN_MS} ago
   *     → per-repo rate limit;
   *   - a grant is already pending → do not double-count.
   *
   * A grant only marks the repo due; the host still spawns it from {@link tick},
   * so concurrency caps and the app-visible gate continue to apply.
   */
  requestPriorityRetry(repoKey: string, now: number): PriorityRetryDecision {
    const state = this.repos.get(repoKey)
    if (!state) return { granted: false, reason: 'unknown-repo' }
    if (state.inFlight) return { granted: false, reason: 'in-flight' }
    if (state.failureStreak <= 0) return { granted: false, reason: 'not-backed-off' }
    if (state.priorityPending) return { granted: false, reason: 'already-pending' }
    if (now - state.lastFetchAt < GIT_AUTOFETCH_PRIORITY_MIN_SINCE_ATTEMPT_MS) {
      return { granted: false, reason: 'attempted-recently' }
    }
    if (now - state.lastPriorityRetryAt < GIT_AUTOFETCH_PRIORITY_COOLDOWN_MS) {
      return { granted: false, reason: 'cooldown' }
    }
    state.lastPriorityRetryAt = now
    state.priorityPending = true
    return { granted: true }
  }

  /**
   * Host calls this when the fetch for `repoKey` settled. `success=false`
   * increments the failure streak (backoff); `success=true` resets it.
   */
  onFetchDone(repoKey: string, now: number, success: boolean): void {
    const state = this.repos.get(repoKey)
    if (!state) return
    state.inFlight = false
    state.lastFetchAt = now
    state.failureStreak = success ? 0 : state.failureStreak + 1
  }

  /**
   * Repo roots due for a fetch at `now`, deduped to one entry per repo:
   *   - not in-flight, AND
   *   - `now - lastFetchAt >= effectiveInterval(failureStreak)`.
   * Returns [] while disabled or the app is hidden. The host caps concurrency
   * itself and calls onFetchStart / onFetchDone around each spawn.
   */
  tick(now: number): string[] {
    if (!this.enabled || !this.appVisible) return []
    const due: string[] = []
    for (const [repoKey, state] of this.repos) {
      if (state.inFlight) continue
      // A granted priority retry makes the repo due regardless of its gap; its
      // own cooldown already rate-limited the grant (see requestPriorityRetry).
      if (state.priorityPending) {
        due.push(repoKey)
        continue
      }
      const gap = computeAutofetchBackoffMs(this.intervalMs, state.failureStreak, this.maxBackoffMs)
      if (now - state.lastFetchAt >= gap) due.push(repoKey)
    }
    return due
  }

  /**
   * How much fetch work is owed right now, IGNORING the app-visible gate.
   *
   * Exists so the paused-while-hidden diagnostic event can carry "how much is
   * piling up" instead of an empty payload — a 4-day bundle used to contain 935
   * identical `{}` records whose combined information content was one bit
   * (BUG-0005 § 2.2). All returned numbers are finite and bounded: repos that
   * have never been attempted are counted separately rather than contributing an
   * infinite overdue age.
   */
  overdueSnapshot(now: number): {
    repoCount: number
    overdueCount: number
    neverFetchedCount: number
    maxOverdueMs: number
  } {
    let overdueCount = 0
    let neverFetchedCount = 0
    let maxOverdueMs = 0
    for (const state of this.repos.values()) {
      if (state.inFlight) continue
      if (!Number.isFinite(state.lastFetchAt)) {
        neverFetchedCount += 1
        overdueCount += 1
        continue
      }
      const gap = computeAutofetchBackoffMs(this.intervalMs, state.failureStreak, this.maxBackoffMs)
      const overdueMs = now - state.lastFetchAt - gap
      if (overdueMs < 0) continue
      overdueCount += 1
      if (overdueMs > maxOverdueMs) maxOverdueMs = overdueMs
    }
    return { repoCount: this.repos.size, overdueCount, neverFetchedCount, maxOverdueMs }
  }

  /** Read-only snapshot for diagnostics / tests. */
  inspect(): {
    enabled: boolean
    appVisible: boolean
    repos: Array<{
      repoKey: string
      inFlight: boolean
      failureStreak: number
      priorityPending: boolean
    }>
  } {
    return {
      enabled: this.enabled,
      appVisible: this.appVisible,
      repos: Array.from(this.repos.entries()).map(([repoKey, s]) => ({
        repoKey,
        inFlight: s.inFlight,
        failureStreak: s.failureStreak,
        priorityPending: s.priorityPending
      }))
    }
  }
}
