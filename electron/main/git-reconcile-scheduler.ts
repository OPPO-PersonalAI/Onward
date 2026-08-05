/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Git reconcile scheduler (pure logic).
 *
 * Unifies every "this repo's git status may be stale — recompute it" signal
 * into ONE dirty -> reconcile pipeline that runs IN PARALLEL with the
 * @parcel/watcher fast path and is NEVER gated on the watcher reporting an
 * error. This is the always-on safety net for the silent-watcher-failure
 * class: @parcel/watcher can stop delivering FSEvents with no error and no
 * callback (parcel-bundler/watcher#187), which leaves the task git badge
 * permanently stale until the user happens to focus the terminal. A real
 * production trace showed exactly this: the only mirror recompute in a 50-min
 * window was a `focus-resync`; zero `watcher-fire`, so a `docs/*.md` untracked
 * file sat green for ~5 hours.
 *
 * Design (per product spec):
 *   Dirty sources — all funnel here, in parallel with the watcher:
 *     - watcher file event (fast path)          -> markDirty('watcher')
 *     - tab switch: newly-visible git task      -> markDirty('tab-visible')
 *     - task activation / click                 -> markDirty('activate')
 *     - periodic heartbeat (always-on, tick()):
 *         focused task        -> reconcile every RECONCILE_FOCUSED_INTERVAL_MS (1 s)
 *         visible-unfocused   -> reconcile every RECONCILE_VISIBLE_INTERVAL_MS (3 s)
 *         hidden task         -> NO heartbeat (refreshed on tab-switch / activate)
 *
 *   Repo-keyed, not task-keyed: many tasks at the same repoRoot collapse to
 *   ONE git status; the repo's cadence is the FASTEST among its tasks
 *   (any focused -> 1 s, else any visible -> 3 s, else hidden -> heartbeat off).
 *
 * The watcher stays the fast path; this scheduler only decides WHEN a reconcile
 * is due. The actual git status + the per-repo in-flight/queued dedup and the
 * change-fingerprint short-circuit (a no-op reconcile emits nothing) live in
 * the mirror worker, so a heartbeat tick that finds no change is cheap.
 *
 * HOSTING (hard constraint H1, perf-critical): this scheduler AND the git status
 * it drives run inside the GitStateMirror WORKER thread, never the main thread —
 * the heartbeat timer and `git status` must stay off the main/render hot paths.
 * The main process (git-state-mirror-router) is forward-only: it relays renderer
 * focus / visibility / dirty signals to the worker and fans deltas back out, with
 * no git work and no reconcile timer of its own. The reconcile queue is keyed by
 * repoRoot so a repo runs at most one `git status` per cycle (min 1 s / max 3 s),
 * never back-to-back. See docs/git-status-reconcile-design.md.
 *
 * Pure + dependency-free so `test/unittest` loads it with no Electron build.
 * `now` is always injected (the scheduler never reads the clock) so unit tests
 * are deterministic and the logic is resume-safe.
 */

export const RECONCILE_FOCUSED_INTERVAL_MS = 1000
export const RECONCILE_VISIBLE_INTERVAL_MS = 3000

// Adaptive backoff (per the "interval must exceed probe duration" principle —
// cf. Prometheus' scrape_timeout < scrape_interval rule). The heartbeat cadence
// above is a FIXED gap measured AFTER status completes, so the real period is
// `statusDuration + interval`. That silently assumes statusDuration << interval.
// On a host whose EDR/anti-malware minifilter taxes every `git.exe` spawn for
// SECONDS (a real trace measured `git status` at 1.3 s median / 12.9 s peak),
// the assumption inverts: a 1 s gap is far smaller than status' own latency, so
// the heartbeat fires back-to-back and saturates the spawn budget, starving the
// foreground Diff/precompute. The fix: stretch the effective gap to
// `lastDurationMs × factor` when status is slow, pinning the git-spawn duty
// cycle at ~1/(1+factor). On a normal host (status ~50 ms) `max(base, 50×4)`
// stays at the base 1 s/3 s — ZERO regression — so this only engages under load
// (which is exactly when freshness is already bounded by the slow status, and
// the watcher fast path still covers it).
export const RECONCILE_BACKOFF_FACTOR = 4
// Sanity ceiling: a one-off multi-second spike can't push the gap arbitrarily
// far (worst-case heartbeat staleness bounded to 60 s; the watcher covers the
// gap). Mirrors the 60 s upper bound peers settled on (e.g. kilocode hidden=60 s).
export const RECONCILE_MAX_BACKOFF_INTERVAL_MS = 60_000

/**
 * Effective reconcile gap for a repo: never below the base cadence, stretched
 * to `lastDurationMs × factor` when status is slow, capped at `maxIntervalMs`.
 * Pure + exported so the worker's diagnostic trace computes the SAME number the
 * scheduler gates on (both use the exported defaults — keep them in sync).
 * A non-positive `lastDurationMs` (no prior status / first attach) yields the
 * base interval, so the very first reconcile is never delayed.
 */
export function computeEffectiveIntervalMs(
  baseIntervalMs: number,
  lastDurationMs: number,
  factor: number,
  maxIntervalMs: number
): number {
  if (!(lastDurationMs > 0)) return baseIntervalMs
  const stretched = Math.min(lastDurationMs * factor, maxIntervalMs)
  return Math.max(baseIntervalMs, stretched)
}

/**
 * Sanity ceiling for a SINGLE measured status/recompute duration (BUG-0005 R5).
 *
 * No real local `git status` takes 30 s — even the EDR-taxed host that motivated
 * the adaptive backoff above peaked at 12.9 s. A process suspended mid-measure
 * (system sleep, App Nap), however, trivially produces minutes.
 */
export const MIRROR_DURATION_SANITY_CEILING_MS = 30_000

/**
 * Reduce a dual-clock measurement to a duration that is safe to feed
 * {@link computeEffectiveIntervalMs}, or 0 when the sample is not believable.
 *
 * Why both clocks: `Date.now()` always includes suspend, and whether
 * `performance.now()` does is platform-dependent (macOS `mach_absolute_time`
 * stops across sleep while `mach_continuous_time` does not; Linux
 * `CLOCK_MONOTONIC` excludes suspend, `CLOCK_BOOTTIME` includes it). Believing
 * the SMALLER of the two is correct wherever the monotonic clock does exclude
 * suspend; the ceiling catches every platform where it does not.
 *
 * Why 0 and not the raw value: 0 already means "no measurement" to every
 * consumer — `computeEffectiveIntervalMs` returns the base interval for a
 * non-positive duration, and the recompute governor applies no duty-cycle floor.
 * So a suspended sample degrades to "we learned nothing this round" instead of
 * "this repo is catastrophically slow, back off to the 60 s ceiling", which is
 * exactly what the field bundle showed happening after every wake: a repo whose
 * true median is 79 ms was measured at ~925 s and pinned at the cap.
 */
export function sanitizeMeasuredDurationMs(
  wallMs: number,
  monotonicMs: number,
  ceilingMs: number = MIRROR_DURATION_SANITY_CEILING_MS
): number {
  const candidates = [wallMs, monotonicMs].filter((value) => Number.isFinite(value) && value >= 0)
  if (candidates.length === 0) return 0
  const believable = Math.min(...candidates)
  return believable > ceilingMs ? 0 : Math.round(believable)
}

export type TaskVisibility = 'focused' | 'visible' | 'hidden'

export type ReconcileReason =
  | 'watcher'
  | 'tab-visible'
  | 'activate'
  | 'heartbeat-focused'
  | 'heartbeat-visible'
  | 'manual'

export interface DueRepo {
  repoKey: string
  reason: ReconcileReason
}

interface TaskState {
  // null => host determined the cwd is NOT inside a git repo; contributes nothing.
  repoKey: string | null
  visibility: TaskVisibility
}

interface RepoState {
  dirty: boolean
  dirtyReason: ReconcileReason | null
  inFlight: boolean
  // ms; NEGATIVE_INFINITY until the first reconcile so a freshly-visible repo
  // is due on the very first tick.
  lastReconcileAt: number
  // ms; the last status duration the host reported via onReconcileDone, used to
  // adapt the next gap (0 until the first measured reconcile => no backoff).
  lastDurationMs: number
}

// focused beats visible beats hidden when aggregating a repo's tasks.
const VISIBILITY_RANK: Record<TaskVisibility, number> = { focused: 2, visible: 1, hidden: 0 }

export class GitReconcileScheduler {
  private readonly focusedIntervalMs: number
  private readonly visibleIntervalMs: number
  private readonly backoffFactor: number
  private readonly maxBackoffIntervalMs: number
  private readonly tasks = new Map<string, TaskState>()
  private readonly repos = new Map<string, RepoState>()

  constructor(
    options: {
      focusedIntervalMs?: number
      visibleIntervalMs?: number
      backoffFactor?: number
      maxBackoffIntervalMs?: number
    } = {}
  ) {
    this.focusedIntervalMs = options.focusedIntervalMs ?? RECONCILE_FOCUSED_INTERVAL_MS
    this.visibleIntervalMs = options.visibleIntervalMs ?? RECONCILE_VISIBLE_INTERVAL_MS
    this.backoffFactor = options.backoffFactor ?? RECONCILE_BACKOFF_FACTOR
    this.maxBackoffIntervalMs = options.maxBackoffIntervalMs ?? RECONCILE_MAX_BACKOFF_INTERVAL_MS
  }

  /**
   * Upsert a task's repo + visibility. `repoKey === null` means the host's
   * cheap `isRepo` check failed (cwd is not inside a git repo), so the task
   * never reconciles. Repos with no remaining live tasks are pruned.
   */
  setTaskState(taskId: string, repoKey: string | null, visibility: TaskVisibility): void {
    this.tasks.set(taskId, { repoKey, visibility })
    this.reconcileRepoMembership()
  }

  removeTask(taskId: string): void {
    if (!this.tasks.delete(taskId)) return
    this.reconcileRepoMembership()
  }

  /**
   * Mark a repo dirty so the next tick() returns it regardless of cadence.
   * Used by the watcher fast path AND the tab-switch / activate triggers.
   * No-op for a repoKey with no live tasks (nothing on screen to update).
   */
  markDirty(repoKey: string, reason: ReconcileReason): void {
    const state = this.repos.get(repoKey)
    if (!state) return
    state.dirty = true
    // Latest explicit trigger wins for the diagnostic reason; heartbeat marks
    // never call markDirty so an explicit reason is always the user-facing one.
    state.dirtyReason = reason
  }

  /** Host calls this right before it kicks off the git status for `repoKey`. */
  onReconcileStart(repoKey: string): void {
    const state = this.repos.get(repoKey)
    if (!state) return
    state.inFlight = true
    // Consume the dirty mark: the reconcile we're starting will observe the
    // current filesystem. A change that lands AFTER this point re-marks dirty
    // (markDirty) and is picked up on the next tick — same re-run guarantee as
    // the worker's recomputeQueued.
    state.dirty = false
    state.dirtyReason = null
  }

  /**
   * Host calls this when the git status for `repoKey` has completed.
   * `durationMs` (the wall time that status took) drives the adaptive backoff:
   * a slow status stretches the NEXT gap so the heartbeat can't run status
   * back-to-back. Omitted / non-positive => no backoff (keeps the base cadence,
   * preserving every existing caller's behaviour).
   */
  onReconcileDone(repoKey: string, now: number, durationMs = 0): void {
    const state = this.repos.get(repoKey)
    if (!state) return
    state.inFlight = false
    state.lastReconcileAt = now
    state.lastDurationMs = durationMs > 0 ? durationMs : 0
  }

  /**
   * Repos due for reconcile at `now`, deduped to one entry per repoKey:
   *   - explicitly dirty (watcher / tab-visible / activate), OR
   *   - focused and last reconcile >= focusedIntervalMs ago, OR
   *   - visible and last reconcile >= visibleIntervalMs ago.
   * Hidden repos are due only via markDirty. In-flight repos are skipped.
   * The host should call tick() on its own timer at an interval no larger than
   * focusedIntervalMs (e.g. 500–1000 ms) so the 1 s focused cadence is honored.
   */
  tick(now: number): DueRepo[] {
    const visibilityByRepo = this.aggregateVisibilityByRepo()
    const due: DueRepo[] = []
    for (const [repoKey, state] of this.repos) {
      if (state.inFlight) continue
      if (state.dirty) {
        due.push({ repoKey, reason: state.dirtyReason ?? 'manual' })
        continue
      }
      const visibility = visibilityByRepo.get(repoKey) ?? 'hidden'
      const elapsed = now - state.lastReconcileAt
      if (visibility === 'focused') {
        const effective = computeEffectiveIntervalMs(
          this.focusedIntervalMs,
          state.lastDurationMs,
          this.backoffFactor,
          this.maxBackoffIntervalMs
        )
        if (elapsed >= effective) due.push({ repoKey, reason: 'heartbeat-focused' })
      } else if (visibility === 'visible') {
        const effective = computeEffectiveIntervalMs(
          this.visibleIntervalMs,
          state.lastDurationMs,
          this.backoffFactor,
          this.maxBackoffIntervalMs
        )
        if (elapsed >= effective) due.push({ repoKey, reason: 'heartbeat-visible' })
      }
      // hidden: no heartbeat — only markDirty (tab-switch / activate) wakes it.
    }
    return due
  }

  /** Read-only snapshot for diagnostics / tests. */
  inspect(): { tasks: number; repos: string[] } {
    return { tasks: this.tasks.size, repos: Array.from(this.repos.keys()) }
  }

  private aggregateVisibilityByRepo(): Map<string, TaskVisibility> {
    const out = new Map<string, TaskVisibility>()
    for (const { repoKey, visibility } of this.tasks.values()) {
      if (!repoKey) continue
      const prev = out.get(repoKey)
      if (!prev || VISIBILITY_RANK[visibility] > VISIBILITY_RANK[prev]) {
        out.set(repoKey, visibility)
      }
    }
    return out
  }

  private reconcileRepoMembership(): void {
    const liveRepoKeys = new Set<string>()
    for (const { repoKey } of this.tasks.values()) {
      if (repoKey) liveRepoKeys.add(repoKey)
    }
    for (const repoKey of liveRepoKeys) {
      if (!this.repos.has(repoKey)) {
        this.repos.set(repoKey, {
          dirty: false,
          dirtyReason: null,
          inFlight: false,
          lastReconcileAt: Number.NEGATIVE_INFINITY,
          lastDurationMs: 0
        })
      }
    }
    for (const repoKey of this.repos.keys()) {
      if (!liveRepoKeys.has(repoKey)) this.repos.delete(repoKey)
    }
  }
}
