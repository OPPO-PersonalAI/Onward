/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * MirrorRecomputeGovernor — pure admission control for git-state-mirror
 * status recomputes (G3 of the 2026-07-04 spinner analysis).
 *
 * Three independent rules, applied per admission kind:
 *
 *  1. FOREGROUND YIELD (kinds: watcher, reconcile) — while a foreground
 *     getDiff for the same repo is in flight (plus a short grace after it
 *     ends), background recomputes for that repo are deferred so their
 *     git spawns stop competing with the user-visible load for the
 *     EDR-throttled process-creation lane. Peer precedent: VS Code's
 *     `whenIdleAndFocused()` gate holds watcher-triggered status while an
 *     operation runs.
 *
 *  2. GLOBAL BUDGET (kinds: watcher, reconcile) — at most N recomputes
 *     may run concurrently across ALL repos (default 2; the user bundle
 *     showed 5 repos recomputing in parallel, each ~2 spawns × ~3 s under
 *     EDR, stacking ~10 concurrent git.exe against the same minifilter).
 *     Peer precedent: GitHub Desktop's indicator sweep refreshes repos
 *     strictly sequentially.
 *
 *  3. WATCHER DUTY-CYCLE FLOOR (kind: watcher only) — the next
 *     watcher-driven recompute may not START sooner than the previous
 *     one's duration after it ENDED (≤50% duty cycle). On a fast host a
 *     40 ms status makes the floor invisible; on an EDR host a 3 s status
 *     turns back-to-back churn into at most half time busy. The reconcile
 *     heartbeat keeps its own adaptive backoff (factor 4) and is exempt.
 *     Peer precedent: VS Code enforces a FIXED 5 s post-status cool-down
 *     on the watcher path; this floor is the adaptive equivalent.
 *
 *  Kind 'user' (attach / focus-resync / osc-switch / manual refresh)
 *  bypasses all three rules — an explicit user action must never wait
 *  behind background governance.
 *
 * Pure state machine over injected `now` timestamps — no timers, no fs,
 * no spawns — so the decision table is unit-testable in plain Node.
 */

export type RecomputeAdmitKind = 'watcher' | 'reconcile' | 'user'

export interface RecomputeAdmitDecision {
  admit: boolean
  /** Suggested retry delay when not admitted. */
  retryInMs?: number
  reason?: 'foreground-yield' | 'budget' | 'duty-cycle'
}

interface RepoGovernorState {
  lastEndedAt: number
  lastDurationMs: number
  /** Epoch ms until which the repo is foreground-busy (Infinity while active). */
  foregroundBusyUntil: number
}

export interface MirrorRecomputeGovernorOptions {
  /** Max concurrently-running recomputes across all repos. Default 2. */
  maxConcurrent?: number
  /** Grace after a foreground load ends before background resumes. Default 1500 ms. */
  foregroundGraceMs?: number
  /** Cap on a single duty-cycle deferral so one pathological duration cannot park a repo. Default 30000 ms. */
  maxDutyCycleDeferMs?: number
  /** Floor for suggested retry delays. Default 250 ms. */
  minRetryMs?: number
}

export class MirrorRecomputeGovernor {
  private readonly repos = new Map<string, RepoGovernorState>()
  private running = 0
  private readonly maxConcurrent: number
  private readonly foregroundGraceMs: number
  private readonly maxDutyCycleDeferMs: number
  private readonly minRetryMs: number

  constructor(options: MirrorRecomputeGovernorOptions = {}) {
    this.maxConcurrent = Math.max(1, options.maxConcurrent ?? 2)
    this.foregroundGraceMs = options.foregroundGraceMs ?? 1500
    this.maxDutyCycleDeferMs = options.maxDutyCycleDeferMs ?? 30_000
    this.minRetryMs = options.minRetryMs ?? 250
  }

  admit(repoKey: string, kind: RecomputeAdmitKind, now: number): RecomputeAdmitDecision {
    if (kind === 'user') return { admit: true }
    const state = this.repos.get(repoKey)

    if (state && state.foregroundBusyUntil > now) {
      const wait = state.foregroundBusyUntil === Number.POSITIVE_INFINITY
        ? this.foregroundGraceMs
        : state.foregroundBusyUntil - now
      return {
        admit: false,
        reason: 'foreground-yield',
        retryInMs: Math.max(this.minRetryMs, wait)
      }
    }

    if (this.running >= this.maxConcurrent) {
      return { admit: false, reason: 'budget', retryInMs: this.minRetryMs }
    }

    if (kind === 'watcher' && state) {
      const sinceEndMs = now - state.lastEndedAt
      const floorMs = Math.min(state.lastDurationMs, this.maxDutyCycleDeferMs)
      if (sinceEndMs < floorMs) {
        return {
          admit: false,
          reason: 'duty-cycle',
          retryInMs: Math.max(this.minRetryMs, floorMs - sinceEndMs)
        }
      }
    }

    return { admit: true }
  }

  onStart(_repoKey: string): void {
    this.running += 1
  }

  onEnd(repoKey: string, now: number, durationMs: number): void {
    this.running = Math.max(0, this.running - 1)
    const state = this.ensure(repoKey)
    state.lastEndedAt = now
    state.lastDurationMs = Math.max(0, durationMs)
  }

  setForegroundBusy(repoKey: string, busy: boolean, now: number): void {
    const state = this.ensure(repoKey)
    state.foregroundBusyUntil = busy ? Number.POSITIVE_INFINITY : now + this.foregroundGraceMs
  }

  removeRepo(repoKey: string): void {
    this.repos.delete(repoKey)
  }

  /** Test/diagnostic view. */
  inspect(): { running: number; repoCount: number } {
    return { running: this.running, repoCount: this.repos.size }
  }

  private ensure(repoKey: string): RepoGovernorState {
    let state = this.repos.get(repoKey)
    if (!state) {
      state = { lastEndedAt: 0, lastDurationMs: 0, foregroundBusyUntil: 0 }
      this.repos.set(repoKey, state)
    }
    return state
  }
}
