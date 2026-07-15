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

interface RepoFetchState {
  inFlight: boolean
  // ms; NEGATIVE_INFINITY until the first fetch so a freshly-added repo is due
  // on the very first eligible tick (fetch soon after a repo appears).
  lastFetchAt: number
  // consecutive failures; drives the backoff. Reset to 0 on any success.
  failureStreak: number
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

  /** App window visible (not hidden/minimized). Hidden → tick pauses. */
  setAppVisible(visible: boolean): void {
    this.appVisible = visible
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
          failureStreak: 0
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
      const gap = computeAutofetchBackoffMs(this.intervalMs, state.failureStreak, this.maxBackoffMs)
      if (now - state.lastFetchAt >= gap) due.push(repoKey)
    }
    return due
  }

  /** Read-only snapshot for diagnostics / tests. */
  inspect(): {
    enabled: boolean
    appVisible: boolean
    repos: Array<{ repoKey: string; inFlight: boolean; failureStreak: number }>
  } {
    return {
      enabled: this.enabled,
      appVisible: this.appVisible,
      repos: Array.from(this.repos.entries()).map(([repoKey, s]) => ({
        repoKey,
        inFlight: s.inFlight,
        failureStreak: s.failureStreak
      }))
    }
  }
}
