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
  classifyFetchFailure,
  classifyRemoteScheme,
  sanitizeGitStderr,
  type FetchFailureReason,
  type RemoteScheme
} from './git-fetch-failure-classify'
import {
  GitAutofetchScheduler,
  GIT_AUTOFETCH_DEFAULT_INTERVAL_MS,
  GIT_AUTOFETCH_MAX_BACKOFF_MS,
  GIT_AUTOFETCH_MIN_INTERVAL_MS,
  computeAutofetchBackoffMs,
  type PriorityRetryRefusal
} from './git-autofetch-scheduler'

/** Never run more than this many fetches at once (many-repo cost guard). */
const MAX_CONCURRENT_FETCHES = 3
/** Hard ceiling on one fetch — kills a wedged transport / DNS hang. */
const FETCH_TIMEOUT_MS = 20_000
/** Tick cadence floor / ceiling; derived from the interval so a small (test) interval still ticks promptly. */
const TICK_FLOOR_MS = 1_000
const TICK_CEIL_MS = 30_000

/**
 * How often the paused-while-hidden diagnostic may repeat when nothing changed.
 * The event used to fire on EVERY 30 s tick with an empty payload: a 4-day
 * bundle carried 935 identical `{}` records (BUG-0005 § 2.2). Now it fires on a
 * change of the owed-work signature, or at most once per this interval.
 */
const HIDDEN_SKIP_MIN_REPEAT_MS = 600_000
/** Own timeout for the (cached, failure-only) remote-URL lookup. */
const REMOTE_URL_TIMEOUT_MS = 5_000
/**
 * Priority-retry refusals that are ordinary steady state rather than a signal,
 * and so are NOT traced. Both fire on every Task focus: `not-backed-off` for any
 * healthy repo, `unknown-repo` for any repo the scheduler has not synced yet or
 * deliberately excludes (no upstream). See handleRepoFocused.
 */
const STEADY_STATE_REFUSALS: ReadonlySet<PriorityRetryRefusal> = new Set<PriorityRetryRefusal>([
  'not-backed-off',
  'unknown-repo'
])

export interface AutofetchResult {
  ok: boolean
  reason?: FetchFailureReason
  durationMs: number
  /** Failure only: git's exit code, or null when the process was killed. */
  exitCode?: number | null
  /** Failure only: true when the {@link FETCH_TIMEOUT_MS} ceiling killed it. */
  killedByTimeout?: boolean
  /**
   * Failure only: {@link classifyFetchFailure} applied to stderr **even when the
   * process was killed by the timeout**. `reason` stays `'timeout'` because that
   * is what happened to the process; a killed fetch still usually printed
   * something first ("Permission denied (publickey)", "Could not resolve host"),
   * and discarding it made auth-wall, unreachable-remote and slow-transport
   * indistinguishable in a user-attached trace.
   */
  classified?: FetchFailureReason
  /** Failure only: redacted tail of stderr. See {@link sanitizeGitStderr}. */
  stderrTail?: string
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
  /** Owed-work signature of the last emitted skipped-hidden event. */
  private hiddenSkipSignature: string | null = null
  private hiddenSkipEmittedAt = 0
  /** repoRoot → transport class of its `origin`. Resolved lazily, on failure only. */
  private readonly remoteSchemeCache = new Map<string, RemoteScheme>()

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
    // BUG-0005 R1-A: the mirror router owns the "which repo is the user looking
    // at" signal. Inverted as a listener (router → manager) because the manager
    // already imports the router; the reverse would be a cycle.
    gitStateMirrorRouter.setRepoFocusListener((repoRoot) => this.handleRepoFocused(repoRoot))
  }

  /**
   * App window visibility gate — hidden/minimized pauses fetching.
   *
   * A hidden → visible edge also halves every repo's failure streak inside the
   * scheduler (BUG-0005 R1-B); the count comes back so the transition is visible
   * in a trace rather than being a silent state mutation.
   */
  setAppVisible(visible: boolean): void {
    const halvedRepoCount = this.scheduler.setAppVisible(visible)
    if (halvedRepoCount > 0) {
      performanceTrace.record(PERF_TRACE_EVENT.MAIN_GIT_AUTOFETCH_STREAK_HALVED, { halvedRepoCount })
    }
    // Re-arm the hidden diagnostic so the NEXT hidden stretch reports itself even
    // if its owed-work signature happens to match the previous one.
    if (visible) this.hiddenSkipSignature = null
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.started = false
    if (this.tickTimer) {
      clearInterval(this.tickTimer)
      this.tickTimer = null
    }
    gitStateMirrorRouter.setRepoFocusListener(null)
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
      this.recordHiddenSkip()
      return
    }
    this.scheduler.syncRepos(gitStateMirrorRouter.getAutofetchRepoRoots())
    const due = this.scheduler.tick(Date.now())
    for (const repoRoot of due) {
      if (this.activeFetches >= MAX_CONCURRENT_FETCHES) break
      void this.runScheduledFetch(repoRoot)
    }
  }

  /**
   * Emit the paused-while-hidden diagnostic, but only when it carries new
   * information: the owed-work signature changed, or {@link HIDDEN_SKIP_MIN_REPEAT_MS}
   * elapsed. Previously this fired on every 30 s tick with an empty payload —
   * 935 identical `{}` records across a 4-day field bundle.
   *
   * The repo set is deliberately NOT re-synced here: syncing would run router
   * work on a path whose entire purpose is to do nothing while the user is away.
   * The numbers therefore describe the set as of the last visible tick, which is
   * exactly the question being asked ("how much was owed when we went quiet").
   */
  private recordHiddenSkip(): void {
    const now = Date.now()
    const owed = this.scheduler.overdueSnapshot(now)
    const signature = `${owed.repoCount}:${owed.overdueCount}:${owed.neverFetchedCount}`
    if (
      signature === this.hiddenSkipSignature &&
      now - this.hiddenSkipEmittedAt < HIDDEN_SKIP_MIN_REPEAT_MS
    ) {
      return
    }
    this.hiddenSkipSignature = signature
    this.hiddenSkipEmittedAt = now
    performanceTrace.record(PERF_TRACE_EVENT.MAIN_GIT_AUTOFETCH_SKIPPED_HIDDEN, {
      repoCount: owed.repoCount,
      overdueCount: owed.overdueCount,
      neverFetchedCount: owed.neverFetchedCount,
      maxOverdueMs: Math.round(owed.maxOverdueMs)
    })
  }

  /**
   * The user focused a Task whose repo is `repoRoot`. Ask the scheduler for one
   * backoff-bypassing fetch, and if granted, run a tick immediately rather than
   * waiting up to a full tick period.
   */
  private handleRepoFocused(repoRoot: string): void {
    if (this.disposed || !this.enabled || !repoRoot) return
    const decision = this.scheduler.requestPriorityRetry(repoRoot, Date.now())
    // Rate control. Only two outcomes are newsworthy: a GRANT, and a refusal
    // that means "the hatch was reached but rate-limited" (cooldown /
    // attempted-recently / already-pending / in-flight). The other two refusals
    // are steady state and fire on EVERY Task focus — `not-backed-off` for every
    // healthy repo, and `unknown-repo` for every repo the scheduler has not
    // synced yet (no visible tick since launch) or deliberately excludes (no
    // upstream). Tracing them swamps the very signal this event exists to carry:
    // a 30 s slice of a test run produced 36 `unknown-repo` records and zero
    // useful ones.
    if (!decision.granted && decision.reason && STEADY_STATE_REFUSALS.has(decision.reason)) return
    performanceTrace.record(PERF_TRACE_EVENT.MAIN_GIT_AUTOFETCH_PRIORITY_RETRY, {
      repoRoot,
      granted: decision.granted,
      reason: decision.reason ?? null
    })
    if (decision.granted) this.runTick()
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
    // Publish fetch freshness to the badge regardless of outcome, so a ↓behind
    // whose backing fetch has been failing can be RENDERED as stale instead of
    // silently presenting a days-old number as current (BUG-0005 R3).
    const settledAt = Date.now()
    // freshnessFanoutCount closes a diagnostic gap: without it, "published to
    // nobody because no cwd matched" and "published, but the renderer never
    // applied it" look identical in a bundle. Folded into the outcome events
    // below rather than getting an event of its own.
    const freshnessFanoutCount = gitStateMirrorRouter.setFetchFreshness(repoRoot, {
      lastFetchAttemptAt: settledAt,
      ...(result.ok ? { lastFetchOkAt: settledAt } : {})
    })
    if (result.ok) {
      performanceTrace.record(PERF_TRACE_EVENT.MAIN_GIT_AUTOFETCH_SUCCEEDED, {
        repoRoot,
        durationMs: result.durationMs,
        freshnessFanoutCount
      })
      // A successful fetch advanced the remote-tracking ref → re-read behind.
      gitStateMirrorRouter.revalidateRepoRoot(repoRoot, source)
      performanceTrace.record(PERF_TRACE_EVENT.MAIN_GIT_AUTOFETCH_TRIGGERED_RECOMPUTE, { repoRoot })
      return
    }
    void this.recordFailure(repoRoot, result, freshnessFanoutCount)
  }

  /**
   * Failure path. Enriches the diagnostic with the repo's transport class before
   * emitting, because "SSH timed out" and "HTTPS timed out" have entirely
   * different triage paths and the bundle previously carried neither.
   *
   * Async only for the cached remote-URL lookup; it runs at most once per repo
   * per process, and only after a failure (so a healthy repo never pays for it).
   */
  private async recordFailure(
    repoRoot: string,
    result: AutofetchResult,
    freshnessFanoutCount: number
  ): Promise<void> {
    const remoteScheme = await this.resolveRemoteScheme(repoRoot)
    performanceTrace.record(PERF_TRACE_EVENT.MAIN_GIT_AUTOFETCH_FAILED, {
      repoRoot,
      reason: result.reason ?? 'other',
      durationMs: result.durationMs,
      freshnessFanoutCount,
      killedByTimeout: result.killedByTimeout ?? false,
      classified: result.classified ?? null,
      exitCode: result.exitCode ?? null,
      remoteScheme,
      stderrTail: result.stderrTail ?? ''
    })
    const nextGapMs = computeAutofetchBackoffMs(
      this.intervalMs,
      this.scheduler.inspect().repos.find((r) => r.repoKey === repoRoot)?.failureStreak ?? 1,
      GIT_AUTOFETCH_MAX_BACKOFF_MS
    )
    performanceTrace.record(PERF_TRACE_EVENT.MAIN_GIT_AUTOFETCH_BACKOFF, { repoRoot, nextGapMs })
  }

  /**
   * Transport class of `repoRoot`'s `origin`, cached forever per repo. Only the
   * CLASS is retained — the URL, host and user never leave this function.
   */
  private async resolveRemoteScheme(repoRoot: string): Promise<RemoteScheme> {
    const cached = this.remoteSchemeCache.get(repoRoot)
    if (cached) return cached
    if (!this.gitPathPromise) this.gitPathPromise = resolveGitExecutable()
    const gitPath = await this.gitPathPromise
    if (!gitPath) return 'other'
    const scheme = await new Promise<RemoteScheme>((resolve) => {
      execFile(
        gitPath,
        ['-C', repoRoot, 'config', '--get', 'remote.origin.url'],
        {
          env: getExecEnv(),
          timeout: REMOTE_URL_TIMEOUT_MS,
          windowsHide: true,
          maxBuffer: 64 * 1024
        },
        (error, stdout) => resolve(error ? 'none' : classifyRemoteScheme(String(stdout ?? '')))
      )
    })
    this.remoteSchemeCache.set(repoRoot, scheme)
    return scheme
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
        const evidence = stderrText || error.message || ''
        // Classify ALWAYS, including on the timeout path. `reason` still
        // reports what happened to the PROCESS; `classified` reports what
        // git was complaining about while it hung. The timeout branch used to
        // short-circuit past classifyFetchFailure and drop stderr entirely,
        // which is why 6 of 9 field failures were undiagnosable.
        const classified = classifyFetchFailure(evidence)
        const reason: FetchFailureReason = killedByTimeout ? 'timeout' : classified
        const exitCode = (error as NodeJS.ErrnoException & { code?: number | string }).code
        resolve({
          ok: false,
          reason,
          durationMs,
          killedByTimeout,
          classified,
          exitCode: typeof exitCode === 'number' ? exitCode : null,
          stderrTail: sanitizeGitStderr(evidence)
        })
      }
    )
  })
}

export const gitAutofetchManager = new GitAutofetchManager()
