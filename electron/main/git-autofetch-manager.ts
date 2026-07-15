/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Git auto-fetch manager (impure side of the background-fetch feature).
 *
 * Owns the timer + the hardened `git fetch` child spawns that keep the Task
 * badge's ↓behind count fresh. The WHEN decision is delegated to the pure
 * {@link GitAutofetchScheduler}; this module only:
 *   1. every tick, hands the scheduler the current set of in-use repo roots
 *      (from the mirror router) and spawns a hardened fetch for each due repo,
 *      capped at {@link MAX_CONCURRENT_FETCHES};
 *   2. hardens the fetch so it can NEVER hang or prompt (the two worst
 *      background-fetch failure modes documented across peer products):
 *        - `GIT_TERMINAL_PROMPT=0`  → no https credential prompt (fail fast)
 *        - `GIT_SSH_COMMAND … BatchMode=yes -o ConnectTimeout=10`
 *                                   → a passphrase-locked SSH key fails fast
 *                                     instead of hanging invisibly
 *        - `GCM_INTERACTIVE=never`  → git-credential-manager never pops UI
 *        - `GIT_OPTIONAL_LOCKS=0`   → no index.lock churn racing the user
 *        - a hard 20 s process timeout kills a wedged transport;
 *   3. on success, asks the mirror to revalidate that repo so the recompute
 *      re-reads `# branch.ab` and the badge's behind count refreshes.
 *
 * The fetch is spawned DIRECTLY (not through the shared git runtime queue) so a
 * slow network fetch never occupies a concurrency slot meant for the fast local
 * `git status` path — fetch stays fully off the status lane by construction.
 *
 * Default OFF-switch: `ONWARD_DISABLE_GIT_AUTOFETCH=1` parks the whole feature.
 * Period override: `ONWARD_GIT_AUTOFETCH_INTERVAL_MS` (>= 60 000 in normal
 * builds; any positive value under `ONWARD_AUTOTEST=1` so a test can drive it
 * fast). See docs/debug-env-variables.md and
 * docs/html/git-ahead-behind-fetch-strategy.html.
 */

import { execFile } from 'child_process'
import { performanceTrace } from './performance-trace'
import { PERF_TRACE_EVENT } from '../../src/utils/perf-trace-names'
import { getExecEnv, resolveGitExecutable } from './git-utils'
import { gitStateMirrorRouter } from './git-state-mirror-router'
import {
  GitAutofetchScheduler,
  GIT_AUTOFETCH_DEFAULT_INTERVAL_MS,
  GIT_AUTOFETCH_MAX_BACKOFF_MS,
  GIT_AUTOFETCH_MIN_INTERVAL_MS,
  computeAutofetchBackoffMs
} from './git-autofetch-scheduler'

/** Never run more than this many fetches at once (many-repo cost guard). */
const MAX_CONCURRENT_FETCHES = 3
/** Hard ceiling on one fetch — kills a wedged transport / DNS hang. */
const FETCH_TIMEOUT_MS = 20_000
/** Tick cadence floor / ceiling; derived from the interval so a small (test) interval still ticks promptly. */
const TICK_FLOOR_MS = 1_000
const TICK_CEIL_MS = 30_000

export type FetchFailureReason = 'timeout' | 'auth' | 'no-remote' | 'network' | 'other'

export interface AutofetchResult {
  ok: boolean
  reason?: FetchFailureReason
  durationMs: number
}

/** Classify a fetch failure from git's stderr so the diagnostic trace is actionable. */
export function classifyFetchFailure(stderr: string): FetchFailureReason {
  const s = stderr.toLowerCase()
  if (/authentication failed|could not read username|could not read password|permission denied|publickey|invalid username or password|terminal prompts disabled/.test(s)) {
    return 'auth'
  }
  if (/no remote repository|does not appear to be a git repository|no such remote|no configured push destination|'origin' does not appear/.test(s)) {
    return 'no-remote'
  }
  if (/could not resolve host|connection timed out|connection refused|unable to access|network is unreachable|failed to connect|timed out/.test(s)) {
    return 'network'
  }
  return 'other'
}

function readIntervalMsFromEnv(): number {
  const raw = process.env.ONWARD_GIT_AUTOFETCH_INTERVAL_MS
  if (raw) {
    const n = Number.parseInt(raw, 10)
    if (Number.isFinite(n) && n >= GIT_AUTOFETCH_MIN_INTERVAL_MS) return n
    // Autotest may drive the loop far faster than the 60 s production floor.
    if (Number.isFinite(n) && n > 0 && process.env.ONWARD_AUTOTEST === '1') return n
  }
  return GIT_AUTOFETCH_DEFAULT_INTERVAL_MS
}

function buildFetchEnv(): NodeJS.ProcessEnv {
  const base = getExecEnv()
  const existingSsh = base.GIT_SSH_COMMAND || process.env.GIT_SSH_COMMAND || 'ssh'
  return {
    ...base,
    // Read-only-ish: fetch only writes remote-tracking refs; disabling optional
    // locks avoids index.lock churn racing the user's own git commands.
    GIT_OPTIONAL_LOCKS: '0',
    // The anti-hang / anti-prompt trio (see module doc).
    GIT_TERMINAL_PROMPT: '0',
    GIT_SSH_COMMAND: `${existingSsh} -o BatchMode=yes -o ConnectTimeout=10`,
    GCM_INTERACTIVE: 'never'
  }
}

class GitAutofetchManager {
  private scheduler = new GitAutofetchScheduler()
  private tickTimer: NodeJS.Timeout | null = null
  private activeFetches = 0
  private started = false
  private disposed = false
  private enabled = false
  private intervalMs = GIT_AUTOFETCH_DEFAULT_INTERVAL_MS
  private gitPathPromise: Promise<string | null> | null = null

  /**
   * Start the background loop. No-op if already started, or if the kill switch
   * `ONWARD_DISABLE_GIT_AUTOFETCH=1` is set (logged once so the trace shows the
   * feature was deliberately parked, not silently broken).
   */
  start(): void {
    if (this.started || this.disposed) return
    this.started = true

    if (process.env.ONWARD_DISABLE_GIT_AUTOFETCH === '1') {
      this.enabled = false
      console.log('[GitAutofetch] disabled via ONWARD_DISABLE_GIT_AUTOFETCH=1')
      performanceTrace.record(PERF_TRACE_EVENT.MAIN_GIT_AUTOFETCH_LIFECYCLE, { phase: 'start', enabled: false })
      return
    }

    this.enabled = true
    this.intervalMs = readIntervalMsFromEnv()
    this.scheduler = new GitAutofetchScheduler({
      intervalMs: this.intervalMs,
      maxBackoffMs: GIT_AUTOFETCH_MAX_BACKOFF_MS
    })

    const tickMs = Math.min(TICK_CEIL_MS, Math.max(TICK_FLOOR_MS, Math.floor(this.intervalMs / 2)))
    console.log(`[GitAutofetch] enabled; interval=${this.intervalMs}ms tick=${tickMs}ms`)
    performanceTrace.record(PERF_TRACE_EVENT.MAIN_GIT_AUTOFETCH_LIFECYCLE, {
      phase: 'start',
      enabled: true,
      intervalMs: this.intervalMs,
      tickMs
    })
    this.tickTimer = setInterval(() => this.runTick(), tickMs)
    this.tickTimer.unref?.()
  }

  /** App window visibility gate — hidden/minimized pauses fetching. */
  setAppVisible(visible: boolean): void {
    this.scheduler.setAppVisible(visible)
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.started = false
    if (this.tickTimer) {
      clearInterval(this.tickTimer)
      this.tickTimer = null
    }
    performanceTrace.record(PERF_TRACE_EVENT.MAIN_GIT_AUTOFETCH_LIFECYCLE, { phase: 'dispose' })
  }

  /** Diagnostics / autotest introspection. */
  inspect() {
    return { ...this.scheduler.inspect(), intervalMs: this.intervalMs, activeFetches: this.activeFetches }
  }

  private runTick(): void {
    if (this.disposed || !this.enabled) return
    const snap = this.scheduler.inspect()
    if (!snap.appVisible) {
      performanceTrace.record(PERF_TRACE_EVENT.MAIN_GIT_AUTOFETCH_SKIPPED_HIDDEN, {})
      return
    }
    this.scheduler.syncRepos(gitStateMirrorRouter.getAutofetchRepoRoots())
    const due = this.scheduler.tick(Date.now())
    for (const repoRoot of due) {
      if (this.activeFetches >= MAX_CONCURRENT_FETCHES) break
      void this.runScheduledFetch(repoRoot)
    }
  }

  private async runScheduledFetch(repoRoot: string): Promise<void> {
    this.scheduler.onFetchStart(repoRoot)
    this.activeFetches += 1
    performanceTrace.record(PERF_TRACE_EVENT.MAIN_GIT_AUTOFETCH_SCHEDULED, { repoRoot })
    performanceTrace.record(PERF_TRACE_EVENT.MAIN_GIT_AUTOFETCH_STARTED, { repoRoot })
    let result: AutofetchResult
    try {
      result = await this.executeFetch(repoRoot)
    } finally {
      this.activeFetches -= 1
    }
    this.scheduler.onFetchDone(repoRoot, Date.now(), result.ok)
    this.reportResult(repoRoot, result, 'autofetch')
  }

  /**
   * Autotest-only deterministic driver: fetch one repo NOW (bypassing due
   * timing), revalidate on success, and return the result. Gated by the caller
   * (`ONWARD_AUTOTEST=1`), never wired in production.
   */
  async forceFetchForAutotest(repoRoot: string): Promise<AutofetchResult> {
    performanceTrace.record(PERF_TRACE_EVENT.MAIN_GIT_AUTOFETCH_STARTED, { repoRoot, forced: true })
    const result = await this.executeFetch(repoRoot)
    this.reportResult(repoRoot, result, 'autofetch-forced')
    return result
  }

  private reportResult(repoRoot: string, result: AutofetchResult, source: string): void {
    if (result.ok) {
      performanceTrace.record(PERF_TRACE_EVENT.MAIN_GIT_AUTOFETCH_SUCCEEDED, {
        repoRoot,
        durationMs: result.durationMs
      })
      // A successful fetch advanced the remote-tracking ref → re-read behind.
      gitStateMirrorRouter.revalidateRepoRoot(repoRoot, source)
      performanceTrace.record(PERF_TRACE_EVENT.MAIN_GIT_AUTOFETCH_TRIGGERED_RECOMPUTE, { repoRoot })
      return
    }
    performanceTrace.record(PERF_TRACE_EVENT.MAIN_GIT_AUTOFETCH_FAILED, {
      repoRoot,
      reason: result.reason ?? 'other',
      durationMs: result.durationMs
    })
    const nextGapMs = computeAutofetchBackoffMs(
      this.intervalMs,
      this.scheduler.inspect().repos.find((r) => r.repoKey === repoRoot)?.failureStreak ?? 1,
      GIT_AUTOFETCH_MAX_BACKOFF_MS
    )
    performanceTrace.record(PERF_TRACE_EVENT.MAIN_GIT_AUTOFETCH_BACKOFF, { repoRoot, nextGapMs })
  }

  private async executeFetch(repoRoot: string): Promise<AutofetchResult> {
    if (!this.gitPathPromise) this.gitPathPromise = resolveGitExecutable()
    const gitPath = await this.gitPathPromise
    if (!gitPath) {
      return { ok: false, reason: 'other', durationMs: 0 }
    }
    return runFetchProcess(gitPath, repoRoot)
  }
}

/**
 * Spawn one hardened `git fetch` and resolve with its outcome. Never rejects —
 * a failed background fetch is safe to swallow (it touches only remote-tracking
 * refs + FETCH_HEAD, never the working tree) and the caller backs it off.
 */
export function runFetchProcess(gitPath: string, repoRoot: string): Promise<AutofetchResult> {
  return new Promise((resolve) => {
    const startMs = Date.now()
    execFile(
      gitPath,
      ['-C', repoRoot, 'fetch', '--quiet'],
      { env: buildFetchEnv(), timeout: FETCH_TIMEOUT_MS, windowsHide: true, maxBuffer: 1024 * 1024 },
      (error, _stdout, stderr) => {
        const durationMs = Date.now() - startMs
        if (!error) {
          resolve({ ok: true, durationMs })
          return
        }
        const killedByTimeout = (error as NodeJS.ErrnoException & { killed?: boolean }).killed === true
        const stderrText = typeof stderr === 'string' ? stderr : String(stderr ?? '')
        const reason: FetchFailureReason = killedByTimeout
          ? 'timeout'
          : classifyFetchFailure(stderrText || error.message || '')
        resolve({ ok: false, reason, durationMs })
      }
    )
  })
}

export const gitAutofetchManager = new GitAutofetchManager()
