/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * GitStateMirror Worker Thread entry.
 *
 * Owns:
 *   - parcel-watcher subscription per attached repo (one watcher covering
 *     both working tree and .git/**, filtered via `classifyEventPath`)
 *   - git command spawn (status / rev-parse / show)
 *   - MirrorState compute + delta short-circuit
 *   - per-file body cache keyed by stat token
 *
 * File watcher failures are supervised inside this Worker Thread: Parcel
 * stays the recursive fast path, while transient failures use restart
 * backoff and temporary low-frequency git-status polling.
 */

import { execFile } from 'child_process'
import { promises as fs, constants as fsConstants } from 'fs'
import { delimiter, isAbsolute, join, resolve as resolvePath } from 'path'
import { platform } from 'os'
import { parentPort } from 'worker_threads'
import { promisify } from 'util'
import * as parcelWatcher from '@parcel/watcher'

import {
  beginMirrorRecompute,
  classifyEventPath,
  completeMirrorAttach,
  computeMirrorWatcherBackoffMs,
  createMirrorWorkerEntry,
  finishMirrorRecomputeIfCurrent,
  hardenReadonlyGitEnv,
  isMirrorWatcherPathMissingError,
  MIRROR_WATCHER_DEGRADED_POLLING_INTERVAL_MS,
  MIRROR_WATCHER_IGNORE,
  MIRROR_WATCHER_POLLING_FAILURE_THRESHOLD,
  MIRROR_WATCHER_SUSPENDED_PROBE_INTERVAL_MS,
  normaliseMirrorRepoRootKey,
  requestMirrorAttach,
  requestMirrorDetach,
  resolveMirrorWatcherRoot,
  shouldReattachWatcherAfterRecompute,
  type MirrorWorkerEntryCore
} from './git-state-mirror-worker-core'
import { buildMirrorChangeFingerprint } from './git-state-mirror-change-fingerprint'
import { buildMirrorRefsDigest } from './git-state-mirror-refs-digest'
import {
  GitReconcileScheduler,
  RECONCILE_FOCUSED_INTERVAL_MS,
  RECONCILE_VISIBLE_INTERVAL_MS,
  RECONCILE_BACKOFF_FACTOR,
  RECONCILE_MAX_BACKOFF_INTERVAL_MS,
  MIRROR_DURATION_SANITY_CEILING_MS,
  computeEffectiveIntervalMs,
  sanitizeMeasuredDurationMs,
  type ReconcileReason
} from './git-reconcile-scheduler'
import { parseStatusPorcelainV2Z } from './git-porcelain-parse'
import { buildGitStatusPorcelainArgs } from './git-status-args'
import { gitignoreToWatchIgnoreGlobs } from './git-gitignore-watch-globs'
import { performanceTrace } from './performance-trace'
import { PERF_TRACE_EVENT } from '../../src/utils/perf-trace-names'
import { MirrorRecomputeGovernor, type RecomputeAdmitKind } from './git-state-mirror-recompute-governor'
import { classifyRepoProbeError, repoProbeBackoffTtlMs, type RepoProbeState } from './git-meta-cache-policy'

import type {
  MainToMirrorMessage,
  MirrorFileBody,
  MirrorState,
  MirrorToMainMessage,
  MirrorWatcherFailureKind,
  MirrorWatcherHealth,
  MirrorWatcherStatus
} from './git-state-mirror-types'
import {
  awaitWatcherQuiescenceWithSettle
} from './git-state-mirror-teardown'

const execFileAsync = promisify(execFile)

// Debounce window for parcel-watcher bursts (e.g. `git checkout` flipping
// many files at once). Coalesces inside this window — recompute happens
// once at the trailing edge, not per-event. This is debounce, not polling.
const DEBOUNCE_MS = 80

// G3 load governance: admission control over background recomputes —
// cross-repo concurrency budget (ONWARD_GSM_MAX_CONCURRENT_RECOMPUTES,
// default 2), foreground-yield while a user-visible getDiff runs, and the
// adaptive watcher duty-cycle floor (next watcher recompute no sooner than
// the previous one's duration after it ended; fast hosts unaffected).
const recomputeGovernor = new MirrorRecomputeGovernor({
  maxConcurrent: Math.max(1, Number(process.env.ONWARD_GSM_MAX_CONCURRENT_RECOMPUTES || '2') || 2)
})
// cwd → pending governor-retry timer. One retry chain per entry; the chain
// re-runs runRecompute which re-consults the governor.
const governorRetryTimers = new Map<string, ReturnType<typeof setTimeout>>()

function admitKindForReason(
  reason: 'attach' | 'watcher' | 'polling' | 'focus-resync' | 'osc-switch' | 'reconcile'
): RecomputeAdmitKind {
  switch (reason) {
    case 'watcher':
    case 'polling':
      return 'watcher'
    case 'reconcile':
      return 'reconcile'
    default:
      // attach / focus-resync / osc-switch are user-driven — never governed.
      return 'user'
  }
}
// The native-quiesce barrier + its constants (NATIVE_WATCHER_SETTLE_MS, the
// deadline) live in the pure leaf `git-state-mirror-teardown.ts` so the
// unsubscribe-settled -> drain -> close ordering is unit-tested without an
// Electron build. shutdownWorker proves real native quiescence (zero live
// @parcel/watcher subscriptions, zero pending unsubscribes) before closing the
// port, instead of the old blind 250 ms sleep — see that module for the why.

// Always-on reconcile heartbeat (parallel to the watcher; constraint H1 — runs
// in THIS worker thread, never main). The scheduler gates the real cadence
// (focused 1 s / visible 3 s); this timer just samples it every tick. See
// docs/git-status-reconcile-design.md.
const RECONCILE_TICK_MS = 500
// A heartbeat reconcile that finds a change while the watcher has been silent
// longer than this is treated as a silently-missed watcher event (drift).
const RECONCILE_DRIFT_WINDOW_MS = 3000

// Git command timing budgets. Deadlines (kill after N ms), not intervals.
const EXEC_TIMEOUT_MS = 10_000
const MAX_STATUS_OUTPUT = 32 * 1024 * 1024
const MAX_FILE_BODY = 16 * 1024 * 1024

// Per-entry state, keyed by canonical cwd.
const entries = new Map<string, MirrorWorkerEntryCore>()
const inFlightOperations = new Set<Promise<void>>()
let shuttingDown = false

interface MirrorWatcherGroup {
  repoRoot: string
  repoRootKey: string
  entries: Set<string>
  dispose: (() => Promise<void>) | null
  health: MirrorWatcherHealth
  message: string | null
  failureKind: MirrorWatcherFailureKind | null
  failureCount: number
  consecutivePollingFailures: number
  restartTimer: NodeJS.Timeout | null
  pollTimer: NodeJS.Timeout | null
  suspendedProbeTimer: NodeJS.Timeout | null
  pollInFlight: boolean
  attachInFlight: boolean
  restartGeneration: number
  nextRetryAt: number | null
  callbackFailureInjected: boolean
}

const watcherGroups = new Map<string, MirrorWatcherGroup>()
const entryToGroupKey = new Map<string, string>()

// Native-quiesce accounting for the @parcel/watcher teardown race. Every
// successful parcelWatcher.subscribe() bumps the counter; every unsubscribe()
// promise is tracked until it settles. shutdownWorker() waits on BOTH reaching
// zero before parentPort.close() so no PromiseRunner async-work outlives the env.
// INVARIANT: every increment MUST have a paired decrement on EVERY dispose path
// (success, throw, cancel) — a leaked count would wedge shutdown until the
// deadline. Enforced by the dispose closure's finally + a unit test.
let activeWatcherSubscriptions = 0
const pendingUnsubscribes = new Set<Promise<unknown>>()

// CALL-TIME tracking of EVERY native @parcel/watcher op (subscribes AND
// unsubscribes). The 2026-07-23 SIGABRT investigation proved the two counters
// above are not enough: binding.cc queues the napi_async_work synchronously
// inside the binding call, but activeWatcherSubscriptions is only bumped after
// the subscribe promise RESOLVES — an in-flight subscribe was invisible to the
// quiesce barrier, its completion drained into the dead env during
// Environment::CleanupHandles, and node-addon-api escalated to
// napi_fatal_error -> abort() (whole-process SIGABRT; identical stack on
// Electron 39 prod and Electron 43 dev). Every native call MUST go through one
// of the two wrappers below so the op is in this set before the binding runs.
const pendingNativeWatcherOps = new Set<Promise<unknown>>()

/** Track a native watcher op from call time. NO shutdown gate — used for
 * unsubscribes, which must remain callable during teardown. */
function trackNativeWatcherOp<T>(start: () => Promise<T>): Promise<T> {
  const promise = start()
  // The tracked copy never rejects so Promise.allSettled/finally bookkeeping
  // can't produce unhandled rejections; callers keep the original promise.
  const tracked = promise.catch(() => undefined)
  pendingNativeWatcherOps.add(tracked)
  void tracked.finally(() => pendingNativeWatcherOps.delete(tracked))
  return promise
}

/** Track a native watcher op AND refuse it once shutdown has begun. The gate
 * and the binding call share one synchronous tick, closing the async-gap class
 * (e.g. the .gitignore read between the old shuttingDown check and the
 * subscribe call). Used for subscribes. */
function runGatedNativeWatcherOp<T>(label: string, start: () => Promise<T>): Promise<T> {
  if (shuttingDown) {
    performanceTrace.record(PERF_TRACE_EVENT.WORKER_GIT_STATE_MIRROR_NATIVE_OP_REFUSED, {
      label
    })
    return Promise.reject(new Error('worker is shutting down'))
  }
  return trackNativeWatcherOp(start)
}

const autotestWatcherFailSubscribeOnce =
  process.env.ONWARD_AUTOTEST === '1' &&
  process.env.ONWARD_AUTOTEST_GSM_WATCHER_FAIL_SUBSCRIBE_ONCE === '1'
const autotestWatcherFailCallbackOnce =
  process.env.ONWARD_AUTOTEST === '1' &&
  process.env.ONWARD_AUTOTEST_GSM_WATCHER_FAIL_CALLBACK_ONCE === '1'
// Persistent SILENT failure: the watcher stays subscribed and reports no error,
// but every event it would deliver is dropped — the exact production failure
// mode (parcel-bundler/watcher#187). Exercises the always-on reconcile heartbeat
// as the only path that can still refresh the badge.
const autotestWatcherSilent =
  process.env.ONWARD_AUTOTEST === '1' &&
  process.env.ONWARD_AUTOTEST_GSM_WATCHER_SILENT === '1'
// Companion to WATCHER_SILENT: also silence the always-on reconcile heartbeat,
// leaving explicit `revalidate` / focus-resync / attach recomputes as the ONLY
// freshness sources. WATCHER_SILENT alone models "watcher dropped events, the
// heartbeat safety net still recovers"; the PAIR models "the mirror authority
// missed the change entirely" — the watcher-missed staleness class from the
// 2026-07-12 diagnostic bundle — deterministically, instead of a test racing
// the heartbeat's 1-3 s cadence. Used by the git-diff missed-watch repro group.
const autotestReconcileSilent =
  process.env.ONWARD_AUTOTEST === '1' &&
  process.env.ONWARD_AUTOTEST_GSM_RECONCILE_SILENT === '1'
let autotestSubscribeFailurePending = autotestWatcherFailSubscribeOnce

// Per-cwd MirrorState.generation counter. Bumped on every focus-resync
// (the "Refresh Changes" path) so the renderer's DiffEditor key changes
// and lifecycle resets even when underlying state is byte-identical.
// Regular FS-event-driven recomputes do NOT bump generation — they emit
// new content with the same generation, which is the correct invariant
// for "data changed but mount stays".
const mirrorGenerations = new Map<string, number>()

// Always-on reconcile state (all in this worker thread, constraint H1). The
// scheduler keys by repoRootKey so a repo runs at most one git status per cycle
// (min 1 s focused / max 3 s visible), never back-to-back.
const reconcileScheduler = new GitReconcileScheduler()
let focusedRepoRootKey: string | null = null
const lastWatcherFireAt = new Map<string, number>()
let reconcileTimer: NodeJS.Timeout | null = null

function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms))
}

function nextGeneration(cwd: string): number {
  const next = (mirrorGenerations.get(cwd) ?? 0) + 1
  mirrorGenerations.set(cwd, next)
  return next
}
function currentGeneration(cwd: string): number {
  // Initial state has generation = 1 (the first emit after attach).
  const value = mirrorGenerations.get(cwd)
  if (value === undefined) {
    mirrorGenerations.set(cwd, 1)
    return 1
  }
  return value
}

// File-body cache: key = `${cwd}\0${fileKey}`. Invalidated implicitly by
// statToken mismatch on next read.
const bodyCache = new Map<string, { body: MirrorFileBody; statToken: string }>()

let cachedGitExecutable: string | null | undefined

// ---------------------------------------------------------------------------
// Cross-thread messaging
// ---------------------------------------------------------------------------

function emit(message: MirrorToMainMessage): void {
  if (!parentPort) return
  try {
    parentPort.postMessage(message)
  } catch (error) {
    console.error('[git-state-mirror-worker] postMessage failed:', error)
  }
}

function log(
  level: 'info' | 'warn' | 'error',
  message: string,
  data?: Record<string, unknown>
): void {
  emit({ kind: 'log', level, message, data })
}

if (autotestWatcherFailSubscribeOnce || autotestWatcherFailCallbackOnce || autotestWatcherSilent || autotestReconcileSilent) {
  log('warn', 'autotest watcher failure injection active', {
    subscribeOnce: autotestWatcherFailSubscribeOnce,
    callbackOnce: autotestWatcherFailCallbackOnce,
    silent: autotestWatcherSilent,
    reconcileSilent: autotestReconcileSilent
  })
}

function trackOperation(label: string, promise: Promise<void>): void {
  inFlightOperations.add(promise)
  promise.catch((error) => {
    log('warn', `${label} failed`, {
      error: error instanceof Error ? error.message : String(error)
    })
  }).finally(() => {
    inFlightOperations.delete(promise)
  })
}

// ---------------------------------------------------------------------------
// Git command plumbing
// ---------------------------------------------------------------------------

function getExecEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env }
  const pathKey = Object.keys(env).find((k) => k.toLowerCase() === 'path') || 'PATH'
  const currentPath = env[pathKey] || ''
  const extraPaths: string[] = []

  if (platform() === 'win32') {
    extraPaths.push(
      'C:\\Program Files\\Git\\cmd',
      'C:\\Program Files\\Git\\bin',
      'C:\\Program Files (x86)\\Git\\cmd',
      'C:\\Program Files (x86)\\Git\\bin'
    )
  } else {
    extraPaths.push('/usr/local/bin', '/opt/homebrew/bin', '/opt/local/bin', '/usr/bin', '/bin')
  }

  env[pathKey] = Array.from(
    new Set([...currentPath.split(delimiter).filter(Boolean), ...extraPaths])
  ).join(delimiter)
  // Mirror git calls are read-only; disable git's opportunistic index-refresh
  // lock so `git status` never rewrites .git/index and re-triggers the watcher.
  return hardenReadonlyGitEnv(env)
}

async function isExecutable(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath, platform() === 'win32' ? fsConstants.F_OK : fsConstants.X_OK)
    return true
  } catch {
    return false
  }
}

async function resolveGitExecutable(): Promise<string | null> {
  if (cachedGitExecutable !== undefined) return cachedGitExecutable

  const candidates: string[] = []
  if (process.env.GIT_PATH) candidates.push(process.env.GIT_PATH)
  if (platform() === 'win32') {
    candidates.push(
      'C:\\Program Files\\Git\\cmd\\git.exe',
      'C:\\Program Files\\Git\\bin\\git.exe',
      'C:\\Program Files (x86)\\Git\\cmd\\git.exe',
      'C:\\Program Files (x86)\\Git\\bin\\git.exe'
    )
  } else {
    candidates.push('/usr/bin/git', '/opt/homebrew/bin/git', '/usr/local/bin/git', '/opt/local/bin/git', '/bin/git')
  }
  for (const candidate of candidates) {
    if (await isExecutable(candidate)) {
      cachedGitExecutable = candidate
      return candidate
    }
  }
  try {
    await execFileAsync('git', ['--version'], { timeout: EXEC_TIMEOUT_MS, env: getExecEnv() })
    cachedGitExecutable = 'git'
    return cachedGitExecutable
  } catch {
    cachedGitExecutable = null
    return null
  }
}

async function spawnGit(args: string[], cwd: string, maxBuffer = MAX_STATUS_OUTPUT): Promise<string> {
  const exe = await resolveGitExecutable()
  if (!exe) throw new Error('git executable not found')
  const { stdout } = await execFileAsync(exe, args, {
    cwd,
    timeout: EXEC_TIMEOUT_MS,
    env: getExecEnv(),
    maxBuffer
  })
  return String(stdout)
}

async function spawnGitBinary(args: string[], cwd: string, maxBuffer = MAX_FILE_BODY): Promise<Buffer> {
  const exe = await resolveGitExecutable()
  if (!exe) throw new Error('git executable not found')
  const { stdout } = await execFileAsync(exe, args, {
    cwd,
    timeout: EXEC_TIMEOUT_MS,
    env: getExecEnv(),
    maxBuffer,
    encoding: 'buffer'
  })
  return stdout as Buffer
}

// ---------------------------------------------------------------------------
// MirrorState compute
// ---------------------------------------------------------------------------

interface RepoMeta {
  isRepo: boolean
  repoRoot: string | null
  gitDir: string | null
  probeState: RepoProbeState
}

// RC-2 backoff (2026-07 bundles): a cwd whose rev-parse was KILLED at the
// exec budget (hanging network volume) must not be re-probed on every
// focus/watcher/reconcile trigger — each re-probe stalls this worker for the
// full EXEC_TIMEOUT_MS. Consecutive timeouts climb the shared backoff ladder
// (30 s → 2 min → 5 min); any successful or clean-negative probe resets it.
const repoProbeTimeoutBackoff = new Map<string, { strikes: number; lastAt: number }>()

async function getRepoMeta(cwd: string): Promise<RepoMeta> {
  const backoff = repoProbeTimeoutBackoff.get(cwd)
  if (backoff) {
    const ttl = repoProbeBackoffTtlMs(backoff.strikes)
    const elapsed = Date.now() - backoff.lastAt
    if (elapsed < ttl) {
      performanceTrace.record(PERF_TRACE_EVENT.WORKER_GIT_STATE_MIRROR_RECOMPUTE_DEFERRED, {
        cwd,
        reason: 'probe-backoff',
        retryInMs: ttl - elapsed,
        trigger: 'repo-meta'
      })
      return { isRepo: false, repoRoot: null, gitDir: null, probeState: 'timeout' }
    }
  }
  try {
    const out = await spawnGit(['rev-parse', '--is-inside-work-tree', '--show-toplevel', '--git-dir'], cwd)
    const lines = out.trim().split(/\r?\n/)
    const isRepo = lines[0]?.trim() === 'true'
    repoProbeTimeoutBackoff.delete(cwd)
    if (!isRepo) return { isRepo: false, repoRoot: null, gitDir: null, probeState: 'not-repo' }
    const repoRootRaw = lines[1]?.trim() || cwd
    const gitDirRaw = lines[2]?.trim() || null
    const repoRoot = repoRootRaw.replace(/\\/g, '/')
    const gitDir = gitDirRaw
      ? (isAbsolute(gitDirRaw) ? gitDirRaw : resolvePath(repoRootRaw, gitDirRaw)).replace(/\\/g, '/')
      : null
    return { isRepo: true, repoRoot, gitDir, probeState: 'ok' }
  } catch (error) {
    const probeState = classifyRepoProbeError(error as { killed?: boolean; signal?: string | null; code?: string | number | null })
    if (probeState === 'timeout') {
      const prev = repoProbeTimeoutBackoff.get(cwd)
      repoProbeTimeoutBackoff.set(cwd, { strikes: (prev?.strikes ?? 0) + 1, lastAt: Date.now() })
    } else {
      repoProbeTimeoutBackoff.delete(cwd)
    }
    return { isRepo: false, repoRoot: null, gitDir: null, probeState }
  }
}

// Porcelain v2 parser + GitFileStatus builders live in a sibling module
// (`git-porcelain-parse.ts`) so unit tests can load them without bringing
// the worker's top-level side effects (parentPort listener + ready emit).
// Imports are kept tight to avoid pulling main-process / Electron deps
// into the worker bundle.

async function computeMirrorState(cwd: string): Promise<MirrorState> {
  const capturedAt = Date.now()
  const generation = currentGeneration(cwd)
  const meta = await getRepoMeta(cwd)

  if (!meta.isRepo || !meta.repoRoot) {
    return {
      cwd,
      repoRoot: null,
      repoName: null,
      branch: null,
      status: null,
      files: [],
      capturedAt,
      changeFingerprint: '',
      generation,
      // RC-2: 'timeout' rides the snapshot to the renderer so Git surfaces
      // can render "probe timed out" instead of the misleading "not a repo".
      repoProbe: meta.probeState
    }
  }

  const repoName = (() => {
    const parts = meta.repoRoot.replace(/[\\/]+$/, '').split(/[\\/]/)
    return parts[parts.length - 1] || null
  })()

  try {
    // kar-qemu Git Diff optimization #2: `--ignore-submodules=dirty` stops this
    // superproject status from recursively walking each submodule's working tree
    // (the dominant cost — measured at up to 12.2s for one recompute on
    // kar-qemu). The parent still reports a submodule whose recorded commit
    // pointer changed (new commits / staged gitlink), so the terminal git-state
    // dot still flips for meaningful submodule changes; only submodule
    // working-tree dirt/untracked no longer forces the recursive enumeration.
    const stdout = await spawnGit(
      buildGitStatusPorcelainArgs({
        branch: true,
        z: true,
        untracked: 'all',
        ignoreSubmodules: 'dirty'
      }),
      meta.repoRoot
    )
    const parsed = parseStatusPorcelainV2Z(stdout, meta.repoRoot)
    const changeFingerprint = await buildMirrorChangeFingerprint(meta.repoRoot, stdout, parsed.files)
    performanceTrace.record(PERF_TRACE_EVENT.WORKER_GIT_STATE_MIRROR_CHANGE_FINGERPRINT, {
      repoRoot: meta.repoRoot,
      fileCount: changeFingerprint.fileCount,
      statCount: changeFingerprint.statCount,
      missingCount: changeFingerprint.missingCount,
      durationMs: changeFingerprint.durationMs
    })
    // Spawn-free ref digest (sibling freshness signal to branchOid). gitDir is
    // resolved from the same rev-parse as repoRoot; on a non-worktree checkout
    // it IS the repo's .git, on a linked worktree the helper resolves commondir.
    const refsDigest = meta.gitDir ? (await buildMirrorRefsDigest(meta.gitDir)).digest : undefined
    return {
      cwd,
      repoRoot: meta.repoRoot,
      repoName,
      branch: parsed.branch,
      branchOid: parsed.branchOid ?? undefined,
      refsDigest,
      ahead: parsed.ahead,
      behind: parsed.behind,
      status: parsed.status,
      files: parsed.files,
      capturedAt,
      changeFingerprint: changeFingerprint.fingerprint,
      generation,
      repoProbe: 'ok'
    }
  } catch (error) {
    log('warn', 'git status failed; emitting unknown state', {
      cwd,
      error: error instanceof Error ? error.message : String(error)
    })
    return {
      cwd,
      repoRoot: meta.repoRoot,
      repoName,
      branch: null,
      status: 'unknown',
      files: [],
      capturedAt,
      changeFingerprint: 'unknown',
      generation,
      // The repo probe itself succeeded (we have a repoRoot); only the
      // status call failed.
      repoProbe: 'ok'
    }
  }
}

// ---------------------------------------------------------------------------
// Event-driven recompute loop
// ---------------------------------------------------------------------------

function scheduleRecompute(entry: MirrorWorkerEntryCore): void {
  if (shuttingDown) return
  if (entry.debounceTimer) return
  if (entry.pendingSince === null) entry.pendingSince = Date.now()
  entry.debounceTimer = setTimeout(() => {
    entry.debounceTimer = null
    entry.pendingSince = null
    entry.pendingPaths.clear()
    void runRecompute(entry, 'watcher')
  }, DEBOUNCE_MS)
}

async function runRecompute(
  entry: MirrorWorkerEntryCore,
  reason: 'attach' | 'watcher' | 'polling' | 'focus-resync' | 'osc-switch' | 'reconcile',
  options: { queueIfBusy?: boolean } = {}
): Promise<boolean> {
  if (shuttingDown) return false
  if (entry.detachRequested) return false
  if (entry.recomputeInFlight) {
    if (options.queueIfBusy !== false) {
      entry.recomputeQueued = true
    }
    return false
  }

  // G3 admission control. A deferred recompute schedules ONE retry chain per
  // entry; the retry re-enters here and re-consults the governor (foreground
  // may still be busy, the budget may still be full, the duty-cycle floor
  // shrinks as time passes). User-driven reasons are never deferred.
  const decision = recomputeGovernor.admit(entry.cwd, admitKindForReason(reason), Date.now())
  if (!decision.admit) {
    if (!governorRetryTimers.has(entry.cwd)) {
      performanceTrace.record(PERF_TRACE_EVENT.WORKER_GIT_STATE_MIRROR_RECOMPUTE_DEFERRED, {
        cwd: entry.cwd,
        reason: decision.reason,
        retryInMs: decision.retryInMs,
        trigger: reason
      })
      const timer = setTimeout(() => {
        governorRetryTimers.delete(entry.cwd)
        if (!shuttingDown && !entry.detachRequested) {
          // Tracked: this chain can reach a watcher re-attach (focus-resync /
          // reconcile -> reattachWatcherIfBecameGit -> subscribe); shutdown
          // must be able to wait for its tail instead of racing it.
          trackOperation('governor-retry recompute', runRecompute(entry, reason, options).then(() => undefined))
        }
      }, decision.retryInMs ?? 250)
      timer.unref?.()
      governorRetryTimers.set(entry.cwd, timer)
    }
    return false
  }

  entry.recomputeInFlight = true
  const probe = startDurationProbe()
  recomputeGovernor.onStart(entry.cwd)
  const generation = beginMirrorRecompute(entry)
  let next: MirrorState
  try {
    next = await computeMirrorState(entry.cwd)
  } catch (error) {
    log('error', 'computeMirrorState threw', {
      cwd: entry.cwd,
      error: error instanceof Error ? error.message : String(error)
    })
    recomputeGovernor.onEnd(entry.cwd, Date.now(), settleDurationProbe(probe, entry.cwd, 'recompute-failed'))
    entry.recomputeInFlight = false
    if (entry.recomputeQueued && !entry.detachRequested && !shuttingDown) {
      entry.recomputeQueued = false
      scheduleRecompute(entry)
    }
    return false
  }
  const delta = finishMirrorRecomputeIfCurrent(entry, generation, next)
  const durationMs = settleDurationProbe(probe, next.repoRoot ?? entry.cwd, 'recompute')
  recomputeGovernor.onEnd(entry.cwd, Date.now(), durationMs)
  performanceTrace.record(PERF_TRACE_EVENT.WORKER_GIT_STATE_MIRROR_RECOMPUTE_DONE, {
    cwd: entry.cwd,
    repoRoot: next.repoRoot,
    reason,
    fileCount: next.files.length,
    branch: next.branch,
    status: next.status,
    // BUG-0005 P0: the VALUES, not just the fact that they changed. The mirror
    // fanout records `deltaKeys`, so a stale-badge trace could previously prove
    // "behind changed" but never "behind changed from 3 to 0" — which is the
    // only form that settles a "the number is wrong" report. Three integers,
    // well inside the payload budget.
    ahead: next.ahead ?? null,
    behind: next.behind ?? null,
    hasUpstream: next.ahead !== undefined || next.behind !== undefined,
    durationMs,
    // RC-2 classification: distinguishes "probe answered not-a-repo" from
    // "probe was killed at the budget" in user-attached traces.
    repoProbe: next.repoProbe ?? null
  })
  entry.recomputeInFlight = false
  if (entry.recomputeQueued && !entry.detachRequested && !shuttingDown) {
    entry.recomputeQueued = false
    scheduleRecompute(entry)
  }
  // Non-git → git transition backstop (2026-07-05): a user-driven recompute
  // (focus-resync / revalidate 'reconcile') that just resolved a repoRoot for an
  // entry with no watcher attaches it. Placed HERE — not in the callers — so a
  // governor-DEFERRED reconcile still re-attaches when its retry finally re-runs
  // runRecompute with the same reason. Guarded no-op for already-watched repos.
  if (reason === 'focus-resync' || reason === 'reconcile') {
    await reattachWatcherIfBecameGit(entry)
  }
  if (!delta) return false // stale, detached, or no-op
  // Short-circuit: only emit when delta has actual fields beyond capturedAt.
  if (Object.keys(delta).length <= 1) return false
  // Diagnostic breadcrumb: a ref-only move (push/fetch) surfaced through the
  // delta. Emitted here (not in the pure computeMirrorDelta, which is unit-tested
  // without a tracer) right before the broadcast that re-keys the History cache.
  if (delta.refsDigest !== undefined) {
    performanceTrace.record(PERF_TRACE_EVENT.WORKER_GIT_STATE_MIRROR_REFS_DIGEST_CHANGED, {
      cwd: entry.cwd,
      repoRoot: next.repoRoot,
      branchOid: next.branchOid ?? null
    })
  }
  emit({ kind: 'mirror-update', cwd: entry.cwd, state: next, delta })
  return true
}

function activeEntriesForGroup(group: MirrorWatcherGroup): MirrorWorkerEntryCore[] {
  const active: MirrorWorkerEntryCore[] = []
  for (const cwd of group.entries) {
    const entry = entries.get(cwd)
    if (entry && !entry.detachRequested) {
      active.push(entry)
    }
  }
  return active
}

function createWatcherGroup(repoRoot: string): MirrorWatcherGroup {
  const repoRootKey = normaliseMirrorRepoRootKey(repoRoot)
  return {
    repoRoot,
    repoRootKey,
    entries: new Set(),
    dispose: null,
    health: 'idle',
    message: null,
    failureKind: null,
    failureCount: 0,
    consecutivePollingFailures: 0,
    restartTimer: null,
    pollTimer: null,
    suspendedProbeTimer: null,
    pollInFlight: false,
    attachInFlight: false,
    restartGeneration: 0,
    nextRetryAt: null,
    callbackFailureInjected: false
  }
}

function isWatcherGroupCurrent(group: MirrorWatcherGroup): boolean {
  return !shuttingDown && group.entries.size > 0 && watcherGroups.get(group.repoRootKey) === group
}

function setTimerUnref(timer: NodeJS.Timeout): NodeJS.Timeout {
  timer.unref?.()
  return timer
}

function clearGroupRestartTimer(group: MirrorWatcherGroup): void {
  if (group.restartTimer) {
    clearTimeout(group.restartTimer)
    group.restartTimer = null
  }
  group.nextRetryAt = null
}

function clearGroupPollTimer(group: MirrorWatcherGroup): void {
  if (group.pollTimer) {
    clearInterval(group.pollTimer)
    group.pollTimer = null
  }
  group.pollInFlight = false
}

function clearGroupProbeTimer(group: MirrorWatcherGroup): void {
  if (group.suspendedProbeTimer) {
    clearInterval(group.suspendedProbeTimer)
    group.suspendedProbeTimer = null
  }
}

function buildWatcherStatus(group: MirrorWatcherGroup, cwd: string): MirrorWatcherStatus {
  return {
    cwd,
    repoRoot: group.repoRoot,
    health: group.health,
    message: group.message,
    failureKind: group.failureKind,
    failureCount: group.failureCount,
    polling: Boolean(group.pollTimer),
    pollingIntervalMs: group.pollTimer ? MIRROR_WATCHER_DEGRADED_POLLING_INTERVAL_MS : null,
    nextRetryAt: group.nextRetryAt,
    updatedAt: Date.now()
  }
}

function emitWatcherStatus(group: MirrorWatcherGroup): void {
  for (const cwd of group.entries) {
    const status = buildWatcherStatus(group, cwd)
    const entry = entries.get(cwd)
    if (entry) {
      entry.watcherHealth = status.health
      entry.watcherFailureCount = status.failureCount
      entry.lastWatcherError = status.message
      entry.lastWatcherFailureKind = status.failureKind
      if (status.health === 'healthy') entry.lastWatcherHealthyAt = status.updatedAt
    }
    emit({ kind: 'watcher-status', status })
  }
}

function updateWatcherHealth(
  group: MirrorWatcherGroup,
  health: MirrorWatcherHealth,
  data: {
    message?: string | null
    failureKind?: MirrorWatcherFailureKind | null
  } = {}
): void {
  const prevHealth = group.health
  const prevMessage = group.message
  const prevKind = group.failureKind
  group.health = health
  if ('message' in data) group.message = data.message ?? null
  if ('failureKind' in data) group.failureKind = data.failureKind ?? null

  emitWatcherStatus(group)
  if (prevHealth !== group.health || prevMessage !== group.message || prevKind !== group.failureKind) {
    performanceTrace.record(PERF_TRACE_EVENT.WORKER_GIT_STATE_MIRROR_WATCHER_STATUS_CHANGED, {
      repoRoot: group.repoRoot,
      health: group.health,
      failureKind: group.failureKind,
      failureCount: group.failureCount,
      polling: Boolean(group.pollTimer)
    })
  }
}

async function disposeGroupWatcher(group: MirrorWatcherGroup): Promise<void> {
  const dispose = group.dispose
  group.dispose = null
  if (!dispose) return
  try {
    await dispose()
  } catch (error) {
    log('warn', 'parcel-watcher unsubscribe failed', {
      repoRoot: group.repoRoot,
      error: error instanceof Error ? error.message : String(error)
    })
  }
}

function scheduleGroupRecompute(group: MirrorWatcherGroup, paths: string[]): void {
  const activeEntries = activeEntriesForGroup(group)
  for (const entry of activeEntries) {
    for (const eventPath of paths) {
      entry.pendingPaths.add(eventPath)
    }
    scheduleRecompute(entry)
  }
}

function scheduleWatcherRestart(group: MirrorWatcherGroup, failureKind: MirrorWatcherFailureKind): void {
  if (shuttingDown || group.entries.size === 0) return
  if (group.restartTimer) return
  const delayMs = computeMirrorWatcherBackoffMs(group.failureCount)
  const generation = group.restartGeneration + 1
  group.restartGeneration = generation
  group.nextRetryAt = Date.now() + delayMs
  performanceTrace.record(PERF_TRACE_EVENT.WORKER_GIT_STATE_MIRROR_WATCHER_RESTART_SCHEDULED, {
    repoRoot: group.repoRoot,
    health: group.health,
    failureKind,
    failureCount: group.failureCount,
    delayMs,
    polling: Boolean(group.pollTimer)
  })
  group.restartTimer = setTimerUnref(setTimeout(() => {
    group.restartTimer = null
    group.nextRetryAt = null
    if (shuttingDown || group.entries.size === 0 || group.restartGeneration !== generation) return
    // Tracked: the restart chain issues a fresh subscribe; shutdown waits for
    // its tail via inFlightOperations instead of relying on the barrier alone.
    trackOperation('watcher-restart attach', ensureWatcherForGroup(group, 'restart'))
  }, delayMs))
  emitWatcherStatus(group)
}

async function runDegradedPoll(group: MirrorWatcherGroup): Promise<void> {
  if (shuttingDown || group.entries.size === 0) return
  if (group.pollInFlight) {
    performanceTrace.record(PERF_TRACE_EVENT.WORKER_GIT_STATE_MIRROR_WATCHER_POLL, {
      repoRoot: group.repoRoot,
      result: 'skip-in-flight',
      polling: true
    })
    return
  }
  group.pollInFlight = true
  const startedAt = Date.now()
  try {
    const activeEntries = activeEntriesForGroup(group)
    await Promise.all(activeEntries.map((entry) => runRecompute(entry, 'polling', { queueIfBusy: false })))
    group.consecutivePollingFailures = 0
    performanceTrace.record(PERF_TRACE_EVENT.WORKER_GIT_STATE_MIRROR_WATCHER_POLL, {
      repoRoot: group.repoRoot,
      result: 'success',
      entryCount: activeEntries.length,
      durationMs: Date.now() - startedAt
    })
  } catch (error) {
    group.consecutivePollingFailures += 1
    const message = error instanceof Error ? error.message : String(error)
    log('warn', 'degraded watcher polling failed', {
      repoRoot: group.repoRoot,
      failureCount: group.consecutivePollingFailures,
      error: message
    })
    performanceTrace.record(PERF_TRACE_EVENT.WORKER_GIT_STATE_MIRROR_WATCHER_POLL, {
      repoRoot: group.repoRoot,
      result: 'error',
      error: message,
      failureCount: group.consecutivePollingFailures,
      durationMs: Date.now() - startedAt
    })
    if (group.consecutivePollingFailures >= MIRROR_WATCHER_POLLING_FAILURE_THRESHOLD) {
      updateWatcherHealth(group, 'failed', {
        message,
        failureKind: 'polling-error'
      })
      for (const cwd of group.entries) {
        emit({ kind: 'watcher-error', cwd, message })
      }
    }
  } finally {
    group.pollInFlight = false
  }
}

function startDegradedPolling(group: MirrorWatcherGroup, failureKind: MirrorWatcherFailureKind, message: string): void {
  if (!group.pollTimer) {
    group.pollTimer = setTimerUnref(setInterval(() => {
      void runDegradedPoll(group)
    }, MIRROR_WATCHER_DEGRADED_POLLING_INTERVAL_MS))
  }
  updateWatcherHealth(group, 'degraded-polling', {
    message,
    failureKind
  })
  void runDegradedPoll(group)
}

// ---------------------------------------------------------------------------
// Always-on reconcile heartbeat — parallel safety net for SILENT watcher
// failure (@parcel/watcher can stop delivering events with no error, leaving
// the badge stale). Runs in this worker thread (constraint H1); gated by
// GitReconcileScheduler so a repo polls at most once per cycle (focused 1 s /
// visible 3 s), never back-to-back. See docs/git-status-reconcile-design.md.
// ---------------------------------------------------------------------------

function resolveFocusedRepoRootKey(cwd: string | null): string | null {
  if (!cwd) return null
  return entryToGroupKey.get(resolvePath(cwd)) ?? null
}

interface DurationProbe {
  wallStart: number
  monoStart: number
}

/**
 * Begin a duration measurement, sampling BOTH clocks.
 *
 * Neither clock alone is sufficient: `Date.now()` always includes suspend, and
 * whether `performance.now()` does is platform-dependent (macOS
 * `mach_absolute_time` stops across sleep, `mach_continuous_time` does not;
 * Linux `CLOCK_MONOTONIC` excludes suspend, `CLOCK_BOOTTIME` includes it). Taking
 * both and believing the smaller makes the measurement correct wherever the
 * monotonic clock does exclude suspend, and the ceiling below catches the rest.
 */
function startDurationProbe(): DurationProbe {
  return { wallStart: Date.now(), monoStart: performance.now() }
}

/**
 * Settle a probe into a duration safe to feed the adaptive schedulers, emitting
 * the diagnostic when the sample is rejected.
 *
 * The decision itself lives in the pure `sanitizeMeasuredDurationMs` so it is
 * locked by `test/unittest/git-reconcile-scheduler.test.mts`; this wrapper only
 * reads the clocks and traces the rejection.
 */
function settleDurationProbe(probe: DurationProbe, repoRoot: string, phase: string): number {
  const wallMs = Date.now() - probe.wallStart
  const monotonicMs = Math.round(performance.now() - probe.monoStart)
  const durationMs = sanitizeMeasuredDurationMs(wallMs, monotonicMs)
  // Only a REJECTION is newsworthy: durationMs === 0 while a clock claims real
  // elapsed time means the process was suspended mid-measurement.
  if (durationMs === 0 && Math.min(wallMs, monotonicMs) > MIRROR_DURATION_SANITY_CEILING_MS) {
    performanceTrace.record(PERF_TRACE_EVENT.WORKER_GIT_STATE_MIRROR_DURATION_SUSPECT, {
      repoRoot,
      phase,
      wallMs,
      monotonicMs,
      ceilingMs: MIRROR_DURATION_SANITY_CEILING_MS
    })
  }
  return durationMs
}

async function runGroupReconcile(group: MirrorWatcherGroup, reason: ReconcileReason): Promise<void> {
  // Autotest: with the reconcile heartbeat silenced (paired with WATCHER_SILENT),
  // no AUTOMATIC path can refresh this repo — only explicit revalidate /
  // focus-resync / attach recomputes remain. Mark the scheduler cycle done so
  // the tick loop keeps its cadence bookkeeping instead of re-queueing forever.
  if (autotestReconcileSilent) {
    reconcileScheduler.onReconcileStart(group.repoRootKey)
    reconcileScheduler.onReconcileDone(group.repoRootKey, Date.now(), 0)
    return
  }
  reconcileScheduler.onReconcileStart(group.repoRootKey)
  const probe = startDurationProbe()
  let changed = false
  try {
    const results = await Promise.all(
      activeEntriesForGroup(group).map((entry) => runRecompute(entry, 'reconcile', { queueIfBusy: false }))
    )
    changed = results.some(Boolean)
  } catch (error) {
    log('warn', 'reconcile recompute failed', {
      repoRoot: group.repoRoot,
      error: error instanceof Error ? error.message : String(error)
    })
  } finally {
    // Feed the measured status duration back so the scheduler adapts the next
    // gap (Prometheus "interval > probe duration" principle). On an EDR host
    // where status takes seconds this stretches the heartbeat so it can't run
    // back-to-back; on a fast host duration×factor stays under the base, so the
    // cadence is unchanged.
    //
    // BUG-0005 R5: the sample is sanity-checked first. A measurement spanning a
    // system sleep used to be handed straight to the backoff, which read it as a
    // ~925 s status and pinned this repo's heartbeat at the 60 s ceiling right
    // after every wake. settleDurationProbe returns 0 for such a sample, and 0
    // means "no measurement" to computeEffectiveIntervalMs → base cadence.
    const durationMs = settleDurationProbe(probe, group.repoRoot, 'reconcile')
    reconcileScheduler.onReconcileDone(group.repoRootKey, Date.now(), durationMs)
    // Diagnostic: surface WHEN/by-how-much the backoff engaged, so a future
    // "Diff still slow on EDR" trace shows whether the heartbeat stopped
    // saturating the spawn budget. Off the hot path (per reconcile completion,
    // only when the gap actually stretched). base picked by current focus.
    const baseIntervalMs =
      group.repoRootKey === focusedRepoRootKey
        ? RECONCILE_FOCUSED_INTERVAL_MS
        : RECONCILE_VISIBLE_INTERVAL_MS
    const nextIntervalMs = computeEffectiveIntervalMs(
      baseIntervalMs,
      durationMs,
      RECONCILE_BACKOFF_FACTOR,
      RECONCILE_MAX_BACKOFF_INTERVAL_MS
    )
    if (nextIntervalMs > baseIntervalMs) {
      performanceTrace.record(PERF_TRACE_EVENT.WORKER_GIT_STATE_MIRROR_RECONCILE_BACKOFF, {
        repoRoot: group.repoRoot,
        lastStatusMs: durationMs,
        baseIntervalMs,
        nextIntervalMs,
        factor: RECONCILE_BACKOFF_FACTOR
      })
    }
  }
  // Drift: a heartbeat reconcile produced a real change while the watcher had
  // been silent — the watcher silently missed the event. Make it observable so
  // a future "badge went stale" report shows the watcher, not the badge, broke.
  if (changed && (reason === 'heartbeat-focused' || reason === 'heartbeat-visible')) {
    const lastFire = lastWatcherFireAt.get(group.repoRootKey) ?? Number.NEGATIVE_INFINITY
    const sinceFire = Date.now() - lastFire
    if (sinceFire > RECONCILE_DRIFT_WINDOW_MS) {
      performanceTrace.record(PERF_TRACE_EVENT.WORKER_GIT_STATE_MIRROR_RECONCILE_FOUND_DRIFT, {
        repoRoot: group.repoRoot,
        reason,
        sinceWatcherFireMs: Number.isFinite(lastFire) ? sinceFire : -1
      })
    }
  }
}

function reconcileTick(): void {
  if (shuttingDown) return
  const now = Date.now()
  // Visible repos = live watcher groups (one per repo). Feed each into the
  // scheduler with its cadence: the focused repo at 1 s, the rest at 3 s.
  const liveRepoKeys = new Set<string>()
  for (const [repoRootKey, group] of watcherGroups) {
    if (group.entries.size === 0) continue
    liveRepoKeys.add(repoRootKey)
    reconcileScheduler.setTaskState(
      repoRootKey,
      repoRootKey,
      repoRootKey === focusedRepoRootKey ? 'focused' : 'visible'
    )
  }
  // Drop scheduler entries for groups that detached (e.g. tab switched away).
  for (const repoKey of reconcileScheduler.inspect().repos) {
    if (!liveRepoKeys.has(repoKey)) reconcileScheduler.removeTask(repoKey)
  }
  const due = reconcileScheduler.tick(now)
  if (due.length === 0) return
  performanceTrace.record(PERF_TRACE_EVENT.WORKER_GIT_STATE_MIRROR_RECONCILE_TICK, {
    dueCount: due.length,
    focused: focusedRepoRootKey ? 1 : 0,
    reasons: due.map((d) => d.reason)
  })
  for (const { repoKey, reason } of due) {
    const group = watcherGroups.get(repoKey)
    if (!group) {
      reconcileScheduler.removeTask(repoKey)
      continue
    }
    trackOperation('reconcile', runGroupReconcile(group, reason))
  }
}

async function runSuspendedProbe(group: MirrorWatcherGroup): Promise<void> {
  if (shuttingDown || group.entries.size === 0) return
  const startedAt = Date.now()
  try {
    await fs.access(group.repoRoot, fsConstants.F_OK)
    performanceTrace.record(PERF_TRACE_EVENT.WORKER_GIT_STATE_MIRROR_WATCHER_SUSPENDED_PROBE, {
      repoRoot: group.repoRoot,
      result: 'found',
      durationMs: Date.now() - startedAt
    })
    clearGroupProbeTimer(group)
    updateWatcherHealth(group, 'recovering', {
      message: null,
      failureKind: 'path-missing'
    })
    await ensureWatcherForGroup(group, 'suspended-probe')
  } catch (error) {
    performanceTrace.record(PERF_TRACE_EVENT.WORKER_GIT_STATE_MIRROR_WATCHER_SUSPENDED_PROBE, {
      repoRoot: group.repoRoot,
      result: 'missing',
      error: error instanceof Error ? error.message : String(error),
      durationMs: Date.now() - startedAt
    })
  }
}

async function enterSuspended(group: MirrorWatcherGroup, message: string): Promise<void> {
  clearGroupRestartTimer(group)
  clearGroupPollTimer(group)
  await disposeGroupWatcher(group)
  updateWatcherHealth(group, 'suspended', {
    message,
    failureKind: 'path-missing'
  })
  if (!group.suspendedProbeTimer) {
    group.suspendedProbeTimer = setTimerUnref(setInterval(() => {
      if (shuttingDown) return
      // Tracked: a probe that finds the path back issues a fresh subscribe.
      trackOperation('suspended-probe attach', runSuspendedProbe(group))
    }, MIRROR_WATCHER_SUSPENDED_PROBE_INTERVAL_MS))
  }
}

async function handleWatcherFault(
  group: MirrorWatcherGroup,
  failureKind: MirrorWatcherFailureKind,
  error: unknown
): Promise<void> {
  if (shuttingDown || group.entries.size === 0) return
  const message = error instanceof Error ? error.message : String(error)
  group.failureCount += 1
  group.message = message
  group.failureKind = failureKind
  log('warn', 'parcel-watcher fault; starting recovery supervisor', {
    repoRoot: group.repoRoot,
    failureKind,
    failureCount: group.failureCount,
    error: message
  })
  await disposeGroupWatcher(group)

  if (failureKind === 'path-missing' || isMirrorWatcherPathMissingError(error)) {
    await enterSuspended(group, message)
    return
  }

  updateWatcherHealth(group, 'recovering', {
    message,
    failureKind
  })
  startDegradedPolling(group, failureKind, message)
  scheduleWatcherRestart(group, failureKind)
}

// Read the repo-root .gitignore and convert its directory patterns into
// parcel-watcher ignore globs. Error-safe: a missing/unreadable .gitignore
// yields no extra globs (watcher behaves exactly as before). Only the root
// .gitignore is consulted (the common case); nested .gitignores are not parsed
// in this pass — those paths still fire and recompute as before.
async function readGitignoreWatchGlobs(repoRoot: string): Promise<string[]> {
  try {
    const content = await fs.readFile(join(repoRoot, '.gitignore'), 'utf-8')
    return gitignoreToWatchIgnoreGlobs(content)
  } catch {
    return []
  }
}

async function startWatcherForGroup(group: MirrorWatcherGroup): Promise<() => Promise<void>> {
  if (shuttingDown) {
    throw new Error('worker is shutting down')
  }
  if (autotestSubscribeFailurePending) {
    autotestSubscribeFailurePending = false
    throw new Error('autotest subscribe failure')
  }
  // Suppress churning git-IGNORED directories at the watcher level. kar-qemu (a
  // running QEMU emulator) continuously rewrites gitignored build artifacts
  // (build/framebuffer.raw, build/serial_output.txt); without this, every write
  // fired a watcher event and a debounced `git status` recompute that found
  // nothing changed but re-walked the huge worktree. We convert ONLY directory
  // patterns (negation-immune) from the repo's .gitignore into parcel ignore
  // globs, so those paths never produce an event in the first place.
  const gitignoreGlobs = await readGitignoreWatchGlobs(group.repoRoot)
  performanceTrace.record(PERF_TRACE_EVENT.WORKER_GIT_STATE_MIRROR_GITIGNORE_GLOBS, {
    repoRoot: group.repoRoot,
    globCount: gitignoreGlobs.length
  })

  // Single parcel-watcher subscription covering both working tree and
  // .git/**. The callback uses classifyEventPath to drop noise (objects,
  // lockfiles, tmpfiles) and keep state-relevant paths. Routed through the
  // gated choke point: the shutdown gate and the binding call share one tick
  // (the .gitignore read above used to leave an unguarded async gap), and the
  // op is barrier-visible from call time.
  const subscription = await runGatedNativeWatcherOp('subscribe', () => parcelWatcher.subscribe(group.repoRoot, (err, events) => {
    if (shuttingDown) return
    if (err) {
      log('error', 'parcel-watcher error', {
        repoRoot: group.repoRoot,
        error: err.message
      })
      void handleWatcherFault(group, 'callback-error', err)
      return
    }
    // Autotest: simulate a SILENT watcher (subscribed, no error, but delivers
    // nothing) so the test proves the reconcile heartbeat still refreshes.
    if (autotestWatcherSilent) return
    if (group.entries.size === 0) return
    const keptPaths: string[] = []
    for (const event of events) {
      const classified = classifyEventPath(event.path, group.repoRoot)
      if (classified.drop) {
        performanceTrace.record(PERF_TRACE_EVENT.WORKER_GIT_STATE_MIRROR_WATCHER_FILTERED, {
          repoRoot: group.repoRoot,
          path: event.path,
          kind: event.type,
          reason: classified.reason
        })
        continue
      }
      keptPaths.push(event.path)
      performanceTrace.record(PERF_TRACE_EVENT.WORKER_GIT_STATE_MIRROR_WATCHER_FIRE, {
        repoRoot: group.repoRoot,
        path: event.path,
        kind: event.type
      })
    }
    if (keptPaths.length > 0) {
      // Record fast-path liveness so the reconcile heartbeat can tell a change
      // it caught from one the watcher silently missed (drift detection).
      lastWatcherFireAt.set(group.repoRootKey, Date.now())
      scheduleGroupRecompute(group, keptPaths)
    }
  }, { ignore: [...MIRROR_WATCHER_IGNORE, ...gitignoreGlobs] }))

  // Subscription is live — count it for the shutdown quiesce barrier.
  activeWatcherSubscriptions += 1

  let disposed = false
  const dispose = async () => {
    // Idempotent: a group can be torn down via detach AND shutdown; only the
    // first call unsubscribes and adjusts the quiesce accounting so the counter
    // never double-decrements.
    if (disposed) return
    disposed = true
    const unsubscribePromise = trackNativeWatcherOp(() => subscription.unsubscribe())
    pendingUnsubscribes.add(unsubscribePromise)
    try {
      await unsubscribePromise
    } catch (error) {
      log('warn', 'parcel-watcher unsubscribe failed', {
        repoRoot: group.repoRoot,
        error: error instanceof Error ? error.message : String(error)
      })
    } finally {
      pendingUnsubscribes.delete(unsubscribePromise)
      activeWatcherSubscriptions -= 1
    }
  }

  // Shutdown may have begun while the subscribe was in flight (the gate can
  // only refuse ops that START after the flip). The compensating dispose runs
  // through the tracked-unsubscribe path so the barrier sees it too.
  if (shuttingDown) {
    await dispose()
    throw new Error('worker is shutting down')
  }
  return dispose
}

async function ensureWatcherForGroup(
  group: MirrorWatcherGroup,
  reason: 'initial' | 'restart' | 'suspended-probe' | 'reattach'
): Promise<void> {
  if (!isWatcherGroupCurrent(group) || group.attachInFlight) return
  group.attachInFlight = true
  clearGroupRestartTimer(group)
  updateWatcherHealth(group, reason === 'initial' || reason === 'reattach' ? 'attaching' : 'recovering', {
    message: group.message,
    failureKind: group.failureKind
  })
  const startedAt = Date.now()
  try {
    await fs.access(group.repoRoot, fsConstants.F_OK)
  } catch (error) {
    group.attachInFlight = false
    await handleWatcherFault(group, 'path-missing', error)
    return
  }
  if (!isWatcherGroupCurrent(group)) {
    group.attachInFlight = false
    return
  }

  try {
    const dispose = await startWatcherForGroup(group)
    if (!isWatcherGroupCurrent(group)) {
      group.attachInFlight = false
      await dispose()
      return
    }
    group.dispose = dispose
    group.attachInFlight = false
    group.failureCount = 0
    group.consecutivePollingFailures = 0
    group.message = null
    group.failureKind = null
    clearGroupPollTimer(group)
    clearGroupProbeTimer(group)
    updateWatcherHealth(group, 'healthy', {
      message: null,
      failureKind: null
    })
    performanceTrace.record(PERF_TRACE_EVENT.WORKER_GIT_STATE_MIRROR_WATCHER_RESTART_RESULT, {
      repoRoot: group.repoRoot,
      reason,
      result: 'success',
      durationMs: Date.now() - startedAt
    })
    await Promise.all(activeEntriesForGroup(group).map((entry) => runRecompute(entry, reason === 'initial' ? 'attach' : 'watcher')))
    if (autotestWatcherFailCallbackOnce && !group.callbackFailureInjected) {
      group.callbackFailureInjected = true
      setTimerUnref(setTimeout(() => {
        if (shuttingDown || group.entries.size === 0) return
        void handleWatcherFault(group, 'callback-error', new Error('autotest callback failure'))
      }, 20))
    }
  } catch (error) {
    group.attachInFlight = false
    performanceTrace.record(PERF_TRACE_EVENT.WORKER_GIT_STATE_MIRROR_WATCHER_RESTART_RESULT, {
      repoRoot: group.repoRoot,
      reason,
      result: 'error',
      error: error instanceof Error ? error.message : String(error),
      durationMs: Date.now() - startedAt
    })
    await handleWatcherFault(group, 'subscribe-error', error)
  }
}

async function detachEntryFromWatcherGroup(cwd: string): Promise<void> {
  const groupKey = entryToGroupKey.get(cwd)
  if (!groupKey) return
  const group = watcherGroups.get(groupKey)
  entryToGroupKey.delete(cwd)
  if (!group) return
  group.entries.delete(cwd)
  const entry = entries.get(cwd)
  if (entry) {
    entry.watcherGroupKey = null
    entry.watcherHealth = 'detached'
  }
  if (group.entries.size > 0) {
    emitWatcherStatus(group)
    return
  }
  clearGroupRestartTimer(group)
  clearGroupPollTimer(group)
  clearGroupProbeTimer(group)
  await disposeGroupWatcher(group)
  watcherGroups.delete(groupKey)
}

// ---------------------------------------------------------------------------
// Message handlers
// ---------------------------------------------------------------------------

async function handleAttachWatch(cwd: string): Promise<void> {
  if (shuttingDown) return
  let entry = entries.get(cwd)
  if (!entry) {
    entry = createMirrorWorkerEntry(cwd)
    entries.set(cwd, entry)
  }

  const transition = requestMirrorAttach(entry)
  if (transition !== 'start') {
    // Already attached or attach in flight; the original attach delivers
    // mirror-update naturally — nothing new to do here.
    return
  }

  // We own the attach. Compute initial state first so consumers receive
  // a snapshot immediately upon attach.
  try {
    await runRecompute(entry, 'attach')
  } catch (error) {
    log('warn', 'initial recompute failed during attach', {
      cwd,
      error: error instanceof Error ? error.message : String(error)
    })
  }
  if (entry.detachRequested) {
    entry.attachInFlight = false
    entries.delete(cwd)
    return
  }

  await attachWatcherForEntry(entry, 'attach')
}

/**
 * Attach the FS watcher for an entry whose current state resolves a repoRoot.
 * Extracted from `handleAttachWatch` so a non-git → git transition
 * (`git init`/`clone` inside an already-open dir) can (re)attach a watcher via
 * the same path without a full re-attach handshake. Idempotent: a no-op when
 * the entry already has a watcher group or is non-git. `origin` is diagnostic
 * ('attach' = initial attach, 'reattach' = post-recompute transition).
 */
async function attachWatcherForEntry(
  entry: MirrorWorkerEntryCore,
  origin: 'attach' | 'reattach'
): Promise<void> {
  if (entry.detachRequested || entry.watcherGroupKey) return

  const watcherRoot = resolveMirrorWatcherRoot(entry.state)
  if (!watcherRoot) {
    if (origin === 'attach') {
      log('info', 'skipping parcel-watcher for non-git cwd', { cwd: entry.cwd })
      performanceTrace.record(PERF_TRACE_EVENT.WORKER_GIT_STATE_MIRROR_WATCHER_SKIPPED, {
        cwd: entry.cwd,
        reason: 'non-git-cwd'
      })
    }
    entry.attachInFlight = false
    if (entry.detachRequested) {
      entries.delete(entry.cwd)
    }
    return
  }
  entry.watchedRoot = watcherRoot

  const repoRootKey = normaliseMirrorRepoRootKey(watcherRoot)
  let group = watcherGroups.get(repoRootKey)
  const created = !group
  if (!group) {
    group = createWatcherGroup(watcherRoot)
    watcherGroups.set(repoRootKey, group)
  }
  group.entries.add(entry.cwd)
  entryToGroupKey.set(entry.cwd, repoRootKey)
  entry.watcherGroupKey = repoRootKey

  const result = await completeMirrorAttach(entry, async () => {
    await detachEntryFromWatcherGroup(entry.cwd)
  })
  if (result === 'detached') {
    entries.delete(entry.cwd)
    return
  }
  if (origin === 'reattach') {
    performanceTrace.record(PERF_TRACE_EVENT.WORKER_GIT_STATE_MIRROR_WATCHER_REATTACHED, {
      cwd: entry.cwd,
      repoRoot: watcherRoot
    })
  }
  if (created) {
    await ensureWatcherForGroup(group, origin === 'attach' ? 'initial' : 'reattach')
  } else {
    emitWatcherStatus(group)
  }
}

/**
 * After a user-driven recompute (focus-resync / revalidate), attach the watcher
 * if the cwd just transitioned non-git → git (see
 * {@link shouldReattachWatcherAfterRecompute}). Backstop for the "BattleProject
 * not recognized" class: `git init` in an already-open dir now becomes watched
 * the moment the next recompute resolves its repoRoot.
 */
async function reattachWatcherIfBecameGit(entry: MirrorWorkerEntryCore): Promise<void> {
  if (!shouldReattachWatcherAfterRecompute(entry, entry.state?.repoRoot ?? null)) return
  await attachWatcherForEntry(entry, 'reattach')
}

async function handleDetachWatch(cwd: string): Promise<void> {
  const entry = entries.get(cwd)
  if (!entry) return
  const result = await requestMirrorDetach(entry)
  if (result === 'detached' || result === 'idle') {
    entries.delete(cwd)
    // Drop governor bookkeeping + any pending governed retry so a detached
    // repo cannot re-enter runRecompute from a stale timer.
    recomputeGovernor.removeRepo(cwd)
    const retry = governorRetryTimers.get(cwd)
    if (retry) {
      clearTimeout(retry)
      governorRetryTimers.delete(cwd)
    }
  }
}

async function handleFocusResync(cwd: string | null): Promise<void> {
  if (shuttingDown) return
  if (!cwd) return
  const entry = entries.get(cwd)
  if (!entry) return
  // Event-driven nudge — user focused this terminal OR clicked Refresh
  // Changes. Force recompute immediately (skip debounce) since this is
  // a high-priority user signal. Phase 2: bump the per-cwd generation
  // counter so the renderer's DiffEditor key changes even when the
  // underlying state is byte-identical. This is the cascade that makes
  // Refresh Changes actually re-mount the full chain.
  nextGeneration(cwd)
  if (entry.debounceTimer) {
    clearTimeout(entry.debounceTimer)
    entry.debounceTimer = null
    entry.pendingSince = null
    entry.pendingPaths.clear()
  }
  // runRecompute handles the non-git → git watcher re-attach for user-driven
  // reasons (incl. a governor-deferred retry), so no explicit re-attach here.
  await runRecompute(entry, 'focus-resync')
}

/**
 * Watcher-independent revalidation (2026-07-05 spinner bundles): a Git Diff
 * open or a completed terminal git command re-checks the mirror WITHOUT the
 * focus-resync generation bump — recompute and emit only on a real delta, so an
 * unchanged repo does not force a DiffEditor re-mount on every open. Also
 * (re)attaches the watcher when the cwd became a git repo.
 */
async function handleRevalidate(cwd: string, source: string): Promise<void> {
  if (shuttingDown) return
  if (!cwd) return
  const entry = entries.get(cwd)
  if (!entry) return
  performanceTrace.record(PERF_TRACE_EVENT.WORKER_GIT_STATE_MIRROR_REVALIDATE, {
    cwd,
    source
  })
  // runRecompute performs the non-git → git watcher re-attach for the
  // 'reconcile' reason (incl. a governor-deferred retry) — see runRecompute.
  await runRecompute(entry, 'reconcile')
}

async function handleRequestFileBody(
  cwd: string,
  fileKey: string,
  force: boolean,
  replyId: number
): Promise<void> {
  if (shuttingDown) return
  try {
    const body = await readFileBody(cwd, fileKey, force)
    emit({ kind: 'file-body-update', replyId, body })
  } catch (error) {
    emit({
      kind: 'file-body-update',
      replyId,
      body: null,
      error: error instanceof Error ? error.message : String(error)
    })
  }
}

async function shutdownWorker(): Promise<void> {
  if (shuttingDown) return
  shuttingDown = true

  if (reconcileTimer) {
    clearInterval(reconcileTimer)
    reconcileTimer = null
  }

  for (const entry of entries.values()) {
    try {
      await requestMirrorDetach(entry)
    } catch { /* shutdown must continue */ }
  }

  if (inFlightOperations.size > 0) {
    await Promise.allSettled(Array.from(inFlightOperations))
  }

  for (const entry of entries.values()) {
    try {
      await requestMirrorDetach(entry)
    } catch { /* shutdown must continue */ }
  }

  // Explicit group sweep: per-entry detach is the normal disposal route, but a
  // group whose entries were already removed (or that a supervisor timer was
  // about to resurrect) must not ride into teardown with a live subscription
  // or an armed timer. Clearing timers here also guarantees no supervisor
  // chain can fire between the barrier and parentPort.close().
  for (const group of watcherGroups.values()) {
    clearGroupRestartTimer(group)
    clearGroupPollTimer(group)
    clearGroupProbeTimer(group)
    try {
      await group.dispose?.()
    } catch { /* shutdown must continue */ }
    group.dispose = null
  }

  entries.clear()
  watcherGroups.clear()
  entryToGroupKey.clear()
  bodyCache.clear()
  mirrorGenerations.clear()
  // Real native quiesce barrier with settle re-validation. Waits until: zero
  // live subscriptions, zero pending unsubscribes, AND zero call-time-tracked
  // in-flight native ops (the 2026-07-23 hole: an in-flight subscribe was
  // invisible to the old two-counter barrier, its PromiseRunner completion
  // drained into the freed env during CleanupHandles -> napi_fatal_error ->
  // whole-process SIGABRT). After the settle delay the barrier RE-VALIDATES —
  // a subscribe resolving mid-settle queues a compensating unsubscribe that a
  // single-pass barrier would have missed. Bounded by an overall deadline so
  // a leaked counter can never wedge teardown (the router's terminate
  // backstop is only provably safe AFTER shutdown-complete).
  const { deadlineHit, spunMs, requiesceCount } = await awaitWatcherQuiescenceWithSettle({
    getActive: () => activeWatcherSubscriptions,
    getPending: () => pendingUnsubscribes.size,
    settlePending: () => Promise.allSettled(Array.from(pendingUnsubscribes)).then(() => undefined),
    getPendingOps: () => pendingNativeWatcherOps.size,
    settlePendingOps: () => Promise.allSettled(Array.from(pendingNativeWatcherOps)).then(() => undefined),
    delay,
    now: Date.now
  })
  if (requiesceCount > 0) {
    performanceTrace.record(PERF_TRACE_EVENT.WORKER_GIT_STATE_MIRROR_SHUTDOWN_REQUIESCE, {
      requiesceCount,
      spunMs
    })
  }
  const quiesce = {
    activeSubscriptions: activeWatcherSubscriptions,
    pendingUnsubscribes: pendingUnsubscribes.size,
    pendingNativeOps: pendingNativeWatcherOps.size,
    settledMs: spunMs,
    requiesceCount,
    deadlineHit
  }
  performanceTrace.record(PERF_TRACE_EVENT.WORKER_GIT_STATE_MIRROR_SHUTDOWN_QUIESCED, quiesce)
  emit({ kind: 'shutdown-complete', quiesce })
  parentPort?.close()
}

async function readFileBody(cwd: string, fileKey: string, force: boolean): Promise<MirrorFileBody | null> {
  const entry = entries.get(cwd)
  const repoRoot = entry?.state?.repoRoot ?? cwd
  const filename = fileKey

  const absPath = isAbsolute(filename) ? filename : join(repoRoot, filename)
  let statToken = '-'
  try {
    const st = await fs.stat(absPath, { bigint: true })
    // Exclude ctime — see git-state-mirror-change-fingerprint.ts: on NTFS a
    // metadata-only touch bumps ctime without mtime, which would needlessly
    // invalidate a cached file body. mtimeNs + size + mode track real content.
    statToken = `${st.mtimeNs}:${st.size}:${st.mode}`
  } catch {
    statToken = 'missing'
  }

  const cacheKey = `${cwd}\0${fileKey}`
  if (!force) {
    const cached = bodyCache.get(cacheKey)
    if (cached && cached.statToken === statToken) {
      return cached.body
    }
  }

  let originalContent = ''
  try {
    const buf = await spawnGitBinary(['show', `HEAD:${filename}`], repoRoot)
    originalContent = buf.toString('utf8')
  } catch {
    originalContent = ''
  }

  let modifiedContent = ''
  let isBinary = false
  if (statToken === 'missing') {
    modifiedContent = ''
  } else {
    try {
      const buf = await fs.readFile(absPath)
      const probe = buf.subarray(0, Math.min(buf.length, 8192))
      isBinary = probe.includes(0)
      modifiedContent = isBinary ? '' : buf.toString('utf8')
    } catch {
      modifiedContent = ''
    }
  }

  const body: MirrorFileBody = {
    cwd,
    fileKey,
    filename,
    originalContent,
    modifiedContent,
    isBinary,
    statToken
  }
  bodyCache.set(cacheKey, { body, statToken })
  return body
}

// ---------------------------------------------------------------------------
// Wire-up
// ---------------------------------------------------------------------------

if (!parentPort) {
  console.error('[git-state-mirror-worker] no parentPort; refusing to start')
  process.exit(1)
}

parentPort.on('message', (msg: MainToMirrorMessage) => {
  switch (msg.kind) {
    case 'attach-watch':
      if (!shuttingDown) trackOperation('attach-watch', handleAttachWatch(msg.cwd))
      return
    case 'detach-watch':
      if (!shuttingDown) trackOperation('detach-watch', handleDetachWatch(msg.cwd))
      return
    case 'switch-cwd':
      // Terminal cwd hint; recompute belongs to the new cwd's entry if
      // anyone subscribed. attach/detach handle the subscription side —
      // here we just nudge a recompute for the new cwd's entry if it
      // exists. Still event-driven (this message IS the event).
      if (msg.newCwd) {
        const e = entries.get(msg.newCwd)
        if (e && !shuttingDown) trackOperation('switch-cwd', handleFocusResync(msg.newCwd))
      }
      return
    case 'request-file-body':
      if (!shuttingDown) trackOperation('request-file-body', handleRequestFileBody(msg.cwd, msg.fileKey, msg.force, msg.replyId))
      return
    case 'focus-resync':
      if (!shuttingDown) trackOperation('focus-resync', handleFocusResync(msg.cwd))
      return
    case 'revalidate':
      if (!shuttingDown) trackOperation('revalidate', handleRevalidate(msg.cwd, msg.source))
      return
    case 'reconcile-focus':
      // Which repo is focused (1 s cadence) vs the rest (3 s). Cheap — no git
      // work here; the heartbeat timer runs the reconcile. Mark the newly
      // focused repo dirty so a focus / activate gives an instant refresh.
      focusedRepoRootKey = resolveFocusedRepoRootKey(msg.cwd)
      if (focusedRepoRootKey) reconcileScheduler.markDirty(focusedRepoRootKey, 'activate')
      return
    case 'foreground-yield': {
      // G3: mark every entry belonging to the foreground repo busy/free.
      // Matched by exact cwd AND by the entries' known repoRoot so a subdir
      // terminal / root open cover each other.
      const now = Date.now()
      let matched = 0
      for (const entry of entries.values()) {
        const entryRepoRoot = entry.state?.repoRoot ?? null
        if (entry.cwd === msg.cwd || (msg.repoRoot && entryRepoRoot === msg.repoRoot)) {
          recomputeGovernor.setForegroundBusy(entry.cwd, msg.busy, now)
          matched += 1
        }
      }
      performanceTrace.record(PERF_TRACE_EVENT.WORKER_GIT_STATE_MIRROR_FOREGROUND_YIELD, {
        cwd: msg.cwd,
        repoRoot: msg.repoRoot,
        action: msg.busy ? 'start' : 'end',
        matchedEntries: matched
      })
      return
    }
    case 'shutdown':
      void shutdownWorker().catch((error) => {
        log('error', 'shutdown failed', {
          error: error instanceof Error ? error.message : String(error)
        })
        parentPort?.close()
      })
      return
    default: {
      const exhaustive: never = msg
      log('warn', 'unknown message kind', { kind: (exhaustive as { kind?: string })?.kind })
    }
  }
})

// Last-resort drain: an uncaught worker exception used to tear the env down
// with live @parcel/watcher ops in flight — the same napi_fatal_error ->
// whole-process SIGABRT as the quit-time race, but MID-SESSION and
// user-visible. Route through shutdownWorker's quiesce barrier first, capped
// so a broken barrier cannot hang a dying worker, then exit non-zero so the
// router's respawn logic sees a real failure.
let fatalDrainStarted = false
function drainThenExit(source: 'uncaughtException' | 'unhandledRejection', error: unknown): void {
  if (fatalDrainStarted) return
  fatalDrainStarted = true
  const message = error instanceof Error ? `${error.message}` : String(error)
  performanceTrace.record(PERF_TRACE_EVENT.WORKER_GIT_STATE_MIRROR_UNCAUGHT_EXCEPTION_DRAIN, {
    source,
    message: message.slice(0, 256)
  })
  log('error', `worker ${source} — draining native watcher ops before exit`, { error: message })
  const cap = delay(10_000).then(() => undefined)
  void Promise.race([shutdownWorker(), cap])
    .catch(() => undefined)
    .finally(() => process.exit(1))
}
process.on('uncaughtException', (error) => drainThenExit('uncaughtException', error))
process.on('unhandledRejection', (reason) => drainThenExit('unhandledRejection', reason))

// Announce readiness. From this point on the worker reacts to incoming
// messages and parcel-watcher events; supervisor timers are only armed
// while a watcher is recovering, polling, or suspended.
emit({ kind: 'ready' })

// Arm the always-on reconcile heartbeat (constraint H1: in this worker thread,
// never main). unref'd so it never keeps the process alive on its own; a tick
// with no visible repos returns immediately (cheap when idle).
// ONWARD_DISABLE_RECONCILE_HEARTBEAT=1 turns it off (debugging / A-B isolation).
if (process.env.ONWARD_DISABLE_RECONCILE_HEARTBEAT === '1') {
  log('warn', 'reconcile heartbeat disabled (ONWARD_DISABLE_RECONCILE_HEARTBEAT=1)')
} else {
  reconcileTimer = setInterval(reconcileTick, RECONCILE_TICK_MS)
  reconcileTimer.unref?.()
}
