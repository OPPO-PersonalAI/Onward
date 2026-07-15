/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * GitStateMirrorRouter — main-process thin pub/sub bridge between Worker
 * Thread (`git-state-mirror-worker-entry.ts`) and renderer subscribers.
 *
 * Holds **no** mirror state of its own beyond the latest snapshot per cwd
 * (so a freshly-subscribed renderer receives the current value without a
 * round-trip through the worker). All recompute work happens in the worker;
 * router only routes.
 *
 * Subscribers are addressed by `webContents.id`. When a renderer process
 * is gone we drop its subscription set; if the cwd's last subscriber is
 * dropped we tell the worker to detach the watcher to keep our parcel-
 * watcher count bounded.
 */

import { Worker } from 'worker_threads'
import { join, resolve as resolvePath } from 'path'
import { realpathSync } from 'fs'
import { homedir } from 'os'
import { ipcMain, webContents, type BrowserWindow } from 'electron'

import { IPC } from '../shared/ipc-channels'
import {
  performanceTrace,
  isPerfTraceWorkerEvent,
  replayPerfTraceWorkerEvent,
  WORKER_TID
} from './performance-trace'
import { PERF_TRACE_EVENT } from '../../src/utils/perf-trace-names'
import { gitDiffCacheInvalidator } from './git-diff-cache-invalidator'
import { resolveExistingTerminalCwd } from './terminal-cwd-validation'
import { shouldRespawnGitStateMirrorWorker } from './git-state-mirror-teardown'
import type {
  MainToMirrorMessage,
  MirrorToMainMessage,
  MirrorState,
  MirrorDelta,
  MirrorFileBody,
  MirrorWatcherStatus
} from './git-state-mirror-types'

/**
 * Canonicalise a renderer-supplied cwd to its on-disk truth, so two
 * raw forms that point at the same physical directory map to the same
 * key. Critical on macOS where the system tmpdir is `/var/folders/...`
 * (a symlink) AND `/private/var/folders/...` (the realpath target):
 *   - Renderer's OSC parser pushes the `/var/...` form (mktemp output)
 *   - Renderer's legacy git polling supplies `/private/var/...` (because
 *     the syscall path `proc_pidinfo` returns realpath-resolved paths)
 *   - `path.resolve` does NOT follow symlinks, so it leaves both forms
 *     intact → router and worker would create two entries (and two
 *     parcel-watcher subscriptions) for the same physical repo, which
 *     destabilised the watcher in the GSM autotest.
 *
 * `realpathSync` follows every symlink in the chain and lands on the
 * canonical form. When the path doesn't exist (rare — usually just a
 * race against fixture cleanup) we fall back to `path.resolve` so the
 * caller still gets a stable string identity. The fallback case can in
 * theory leak a subscription if the path is later realpath-resolvable
 * because subscribe and unsubscribe would compute different canonical
 * forms; we accept that tiny edge case (it was already broken with the
 * pure-`path.resolve` baseline in a different way).
 */
export function canonicaliseMirrorCwd(rawCwd: string): string {
  const expanded = rawCwd === '~'
    ? homedir()
    : rawCwd.startsWith('~/') || rawCwd.startsWith('~\\')
      ? join(homedir(), rawCwd.slice(2))
      : rawCwd
  try {
    return realpathSync(expanded)
  } catch {
    return resolvePath(expanded)
  }
}

function canonicalise(rawCwd: string): string {
  return canonicaliseMirrorCwd(rawCwd)
}

interface FileBodyPending {
  resolve: (body: MirrorFileBody | null) => void
  reject: (error: Error) => void
  startedAt: number
  cwd: string
  fileKey: string
}

const WORKER_REQUEST_TIMEOUT_MS = 30_000
// Generous: the worker now proves native @parcel/watcher quiesce before exiting,
// which can take up to its settle ceiling under churn. terminate() only fires if
// this elapses with NO shutdown-complete ack (the unsafe last resort).
const WORKER_SHUTDOWN_TIMEOUT_MS = 15_000
// Once the worker HAS acked native quiesce, a slow exit can be terminated safely
// after this short grace (no live native async-work remains to corrupt teardown).
const ACK_TERMINATE_GRACE_MS = 1_000

type MirrorUpdateListener = (cwd: string, state: MirrorState, delta: MirrorDelta) => void
type CwdChangeListener = (terminalId: string, prevCwd: string | null, nextCwd: string | null) => void

class GitStateMirrorRouter {
  private worker: Worker | null = null
  private workerReady = false
  private respawnAttempt = 0
  private disposingWorkers = new WeakSet<Worker>()
  private workerShutdownTimers = new WeakMap<Worker, ReturnType<typeof setTimeout>>()
  private workerShutdownStartedAt = new WeakMap<Worker, number>()
  private workerShutdownTimedOut = new WeakSet<Worker>()
  private disposePromise: Promise<void> | null = null
  // Teardown-quiesce gating (the @parcel/watcher worker-teardown SIGABRT fix).
  // A worker that has emitted 'shutdown-complete' has PROVEN native quiescence,
  // so terminate() becomes safe; until then terminate is the unsafe last resort.
  private shutdownAcked = new WeakSet<Worker>()
  private ackTerminateTimers = new WeakMap<Worker, ReturnType<typeof setTimeout>>()
  // Respawn cancellation: dispose() must not let a worker that died near quit
  // respawn a fresh watcher-bearing worker into a quitting app (the compounding
  // teardown path). `disposed` latches the router as torn down; `respawnTimer`
  // holds any pending respawn so dispose() can cancel it.
  private respawnTimer: ReturnType<typeof setTimeout> | null = null
  private disposed = false

  /**
   * webContents.id → (canonical cwd → per-renderer subscribe refCount).
   *
   * Same `wcId` can subscribe to the same canonical cwd more than once
   * because the renderer commonly issues two `subscribeMirror` IPCs that
   * collapse to the same canonical form here (e.g. `/var/...` from the
   * OSC parser plus `/private/var/...` from the legacy git-info poll;
   * `repo/.` plus `repo`; symlink + realpath; etc.). Storing a plain
   * `Set<canonical>` lost this multiplicity — main saw a single entry
   * even after two subscribe IPCs, so a single unsubscribe IPC silently
   * killed the still-active second subscription. The refCount is the
   * fix: increment on every subscribe (attach watcher only on 0→1 of
   * the global `refCounts`), decrement on every unsubscribe (release
   * the per-renderer entry only when its own count reaches 0).
   */
  private subs = new Map<number, Map<string, number>>()
  /** cwd → subscriber count (>0 iff worker has attached its watcher). */
  private refCounts = new Map<string, number>()
  /**
   * cwd → main-process (internalSubscribe) share of `refCounts`.
   * Diagnostic bookkeeping only — `refCounts` stays authoritative. Lets
   * `inspect()` attribute a live watcher to "main bridge" vs "renderer
   * wc N", which is what the dead-repo-churn leak hunt needs (the
   * 2026-07-04 bundle showed 3 of 5 mirrored repos with no live
   * terminal, ~950 recomputes each).
   */
  private internalRefCounts = new Map<string, number>()
  /** cwd → latest known snapshot, served immediately on new subscription. */
  private latest = new Map<string, MirrorState>()
  /** cwd → latest watcher supervisor health, exposed to renderers/autotests. */
  private watcherStatuses = new Map<string, MirrorWatcherStatus>()
  /** terminalId → last cwd pushed through OSC/native cwd detection. */
  private terminalCwds = new Map<string, string | null>()

  /** Main-process subscribers (e.g. terminal-git-info-bridge). */
  private mirrorUpdateListeners = new Set<MirrorUpdateListener>()
  private cwdChangeListeners = new Set<CwdChangeListener>()

  /** request-file-body reply correlation. */
  private nextReplyId = 1
  private pendingBodies = new Map<number, FileBodyPending>()

  init(_mainWindow: BrowserWindow): void {
    // Clean (re-)entry: clear the torn-down latch so a dispose()-then-init()
    // (test harness / re-init) re-enables respawn.
    this.disposed = false
    this.spawnWorker()
    this.registerIpcHandlers()
    this.registerWebContentsCleanup()
  }

  dispose(): Promise<void> {
    // Latch torn-down and cancel any pending respawn FIRST so a worker that died
    // near quit cannot spawn a fresh watcher-bearing worker into a quitting app.
    this.disposed = true
    if (this.respawnTimer) {
      clearTimeout(this.respawnTimer)
      this.respawnTimer = null
      performanceTrace.record(PERF_TRACE_EVENT.MAIN_GIT_STATE_MIRROR_RESPAWN_CANCELLED, { reason: 'dispose' })
    }
    if (this.disposePromise) {
      this.clearLocalState()
      return this.disposePromise
    }
    const worker = this.worker
    this.clearLocalState()
    if (!worker) return Promise.resolve()

    this.disposingWorkers.add(worker)
    this.workerShutdownStartedAt.set(worker, Date.now())
    this.worker = null
    this.workerReady = false

    let timer: ReturnType<typeof setTimeout> | null = null
    const exitPromise = new Promise<void>((resolve) => {
      worker.once('exit', () => {
        if (timer) clearTimeout(timer)
        resolve()
      })
      timer = setTimeout(() => {
        this.workerShutdownTimedOut.add(worker)
        // Last resort: NO shutdown-complete ack within the timeout. Terminating
        // now is unsafe (a live @parcel/watcher PromiseRunner async-work may
        // still be queued in the worker loop) but necessary to avoid a hung
        // quit. The ack-gated safe-terminate path (handleWorkerMessage) is the
        // normal route; this fires only when the worker is genuinely wedged.
        if (!this.shutdownAcked.has(worker)) worker.terminate().catch(() => { /* ignore */ })
      }, WORKER_SHUTDOWN_TIMEOUT_MS)
      timer.unref?.()
      this.workerShutdownTimers.set(worker, timer)
    })

    try {
      worker.postMessage({ kind: 'shutdown' } satisfies MainToMirrorMessage)
      // Lifecycle breadcrumb: graceful-quit shutdown was requested. Pair with
      // 'worker EXITED' (result/acked) to see whether the worker quiesced.
      console.log('[GitStateMirrorRouter] shutdown posted to worker')
    } catch {
      worker.terminate().catch(() => { /* ignore */ })
    }
    worker.unref()

    const disposePromise = exitPromise.finally(() => {
      if (this.disposePromise === disposePromise) {
        this.disposePromise = null
      }
    })
    this.disposePromise = disposePromise
    return disposePromise
  }

  private clearLocalState(): void {
    this.subs.clear()
    this.refCounts.clear()
    this.internalRefCounts.clear()
    this.latest.clear()
    this.watcherStatuses.clear()
    this.terminalCwds.clear()
    for (const [, pending] of this.pendingBodies) {
      pending.reject(new Error('GitStateMirrorRouter disposed'))
    }
    this.pendingBodies.clear()
  }

  // ---------------------------------------------------------------------
  // Worker lifecycle (with auto-respawn for GSM-31)
  // ---------------------------------------------------------------------

  private spawnWorker(): void {
    const workerPath = join(__dirname, 'git-state-mirror-worker-entry.js')
    this.workerReady = false
    try {
      this.worker = new Worker(workerPath)
    } catch (error) {
      console.error('[GitStateMirrorRouter] failed to spawn worker:', error)
      this.worker = null
      return
    }
    const worker = this.worker
    // Lifecycle breadcrumb (run-git-state-mirror-quit trial-5 hang): shows a new
    // worker was created; pair with 'worker ready' / 'worker EXITED' to locate a
    // stall between spawn and ready.
    console.log('[GitStateMirrorRouter] worker spawn', { respawnAttempt: this.respawnAttempt })
    worker.on('message', (msg: unknown) => {
      // Worker → main perf-trace forwarding lands on the dedicated tid
      // lane so Perfetto UI shows "git-state-mirror-worker" as its own row
      // (matches the convention used by git-ipc-worker / ripgrep-search).
      if (isPerfTraceWorkerEvent(msg)) {
        replayPerfTraceWorkerEvent(msg, {
          tid: WORKER_TID.GIT_STATE_MIRROR,
          threadName: 'git-state-mirror-worker'
        })
        return
      }
      this.handleWorkerMessage(msg as MirrorToMainMessage, worker)
    })
    worker.on('error', (error) => {
      // Loud — anything that hits this is a true worker-thread exception
      // (uncaught throw, native module crash). Always log with the full
      // error and stack so the autotest log captures it.
      console.error('[GitStateMirrorRouter] worker error:', error, error?.stack)
    })
    worker.on('exit', (code) => {
      const shutdownTimer = this.workerShutdownTimers.get(worker)
      if (shutdownTimer) clearTimeout(shutdownTimer)
      this.workerShutdownTimers.delete(worker)
      const ackTimer = this.ackTerminateTimers.get(worker)
      if (ackTimer) clearTimeout(ackTimer)
      this.ackTerminateTimers.delete(worker)
      // Capture the cooperative-quiesce ack BEFORE deleting it so the exit log
      // below can classify a code-1 exit: acked=true => SAFE (worker proved
      // quiescence via shutdown-complete, then the post-ack grace terminated it);
      // acked=false + terminated-after-timeout => UNSAFE 15s-no-ack wedge.
      const wasAcked = this.shutdownAcked.has(worker)
      this.shutdownAcked.delete(worker)

      const wasDisposing = this.disposingWorkers.delete(worker)
      const shutdownStartedAt = this.workerShutdownStartedAt.get(worker)
      this.workerShutdownStartedAt.delete(worker)
      const shutdownTimedOut = this.workerShutdownTimedOut.delete(worker)
      const shutdownResult = shutdownTimedOut
        ? 'terminated-after-timeout'
        : code === 0 ? 'clean-exit' : 'nonzero-exit'
      const shutdownDurationMs = shutdownStartedAt !== undefined ? Date.now() - shutdownStartedAt : null
      if (wasDisposing && shutdownStartedAt !== undefined) {
        performanceTrace.record(PERF_TRACE_EVENT.MAIN_GIT_STATE_MIRROR_WORKER_SHUTDOWN, {
          code,
          result: shutdownResult,
          durationMs: shutdownDurationMs
        })
      }
      if (this.worker === worker) {
        this.workerReady = false
        this.worker = null
      }
      // Loud — every exit gets logged with the exit code and a stack
      // capture of the call site that observed the exit, so we can
      // distinguish "main posted shutdown via dispose()" from "worker
      // crashed silently". Without this, a single death between tests
      // is invisible until 5 in a row trip the giveup branch.
      console.error('[GitStateMirrorRouter] worker EXITED', {
        code,
        respawnAttempt: this.respawnAttempt,
        exitedAt: new Date().toISOString(),
        // Diagnostic breadcrumbs (run-git-state-mirror-quit GSMQ-04): classify a
        // code-1 exit. disposing=true + acked=true + nonzero-exit = SAFE post-ack
        // terminate (by design under extreme churn); terminated-after-timeout +
        // acked=false = UNSAFE 15s wedge (real bug). durationMs = quit->exit.
        disposing: wasDisposing,
        result: shutdownResult,
        acked: wasAcked,
        durationMs: shutdownDurationMs
      })
      // Suppress respawn when disposing/disposed (quit in progress) or a worker
      // already exists — never spawn a fresh watcher-bearing worker into a
      // quitting app (the compounding teardown path).
      if (wasDisposing || this.disposed || this.worker !== null) {
        return
      }
      // Reject every pending file-body request — the renderer will retry.
      for (const [, pending] of this.pendingBodies) {
        pending.reject(new Error(`mirror worker exited (code=${code}) before reply`))
      }
      this.pendingBodies.clear()
      // Respawn with a tiny back-off; clamp to 5 retries before giving up
      // (consumers fall back to manual refresh until the next entry).
      // Canonical respawn decision (unit-tested in git-state-mirror-teardown).
      // disposed / hasLiveWorker are already false here (the early return above),
      // so this gates on the retry budget; kept explicit so the predicate is the
      // single source of truth for "may a fresh worker spawn?".
      if (!shouldRespawnGitStateMirrorWorker({
        disposed: this.disposed,
        hasLiveWorker: this.worker !== null,
        respawnAttempt: this.respawnAttempt,
        maxAttempts: 5
      })) {
        if (this.respawnAttempt >= 5) {
          console.error('[GitStateMirrorRouter] worker exited 5 times in a row; giving up')
        }
        return
      }
      this.respawnAttempt += 1
      this.respawnTimer = setTimeout(() => {
        this.respawnTimer = null
        // Re-check at fire time: a dispose() during the back-off window must win.
        if (this.disposed || this.worker) return
        this.spawnWorker()
        this.reattachAllAfterRespawn()
      }, Math.min(2000, 100 * this.respawnAttempt))
      this.respawnTimer.unref?.()
    })
  }

  private reattachAllAfterRespawn(): void {
    // A dispose() that landed between spawn and reattach must win — do not arm
    // fresh watchers into a quitting app.
    if (this.disposed) return
    // Re-subscribe every cwd that still has subscribers. The new worker
    // starts empty — we replay attach-watch so it rebuilds its state.
    for (const cwd of this.refCounts.keys()) {
      this.postToWorker({ kind: 'attach-watch', cwd })
    }
  }

  private handleWorkerMessage(msg: MirrorToMainMessage, worker: Worker): void {
    switch (msg.kind) {
      case 'ready':
        this.workerReady = true
        this.respawnAttempt = 0
        // Lifecycle breadcrumb (trial-5 hang): worker reached ready; absence of
        // this line after 'worker spawn' localises a never-ready startup stall.
        console.log('[GitStateMirrorRouter] worker ready')
        return
      case 'shutdown-complete': {
        // The worker PROVED native @parcel/watcher quiescence before closing its
        // port. Record it, mark the ack (so the unsafe terminate timer is now
        // gated off), and schedule a SHORT safe-terminate grace as a backstop in
        // case the exit is slow — terminating after the ack cannot corrupt
        // teardown because no live native async-work remains.
        this.shutdownAcked.add(worker)
        // Diagnostic breadcrumb to the app log (rules-of-evidence): the worker
        // PROVED native @parcel/watcher quiescence (shutdown-complete ack) BEFORE
        // any teardown — the authoritative "drained cooperatively" signal,
        // regardless of whether the subsequent exit is a natural code-0 or a SAFE
        // post-ack-grace terminate (code 1); both are SIGABRT-free. Previously
        // this proof was only a trace-store perf event, invisible in a quit-bug
        // report's app log. The token 'shutdown-quiesced' matches the perf-event
        // name so the signal is greppable in either surface.
        console.log('[GitStateMirrorRouter] worker shutdown-quiesced (ack received)', { quiesce: msg.quiesce ?? null })
        performanceTrace.record(PERF_TRACE_EVENT.MAIN_GIT_STATE_MIRROR_WORKER_SHUTDOWN_ACK, {
          quiesce: msg.quiesce ?? null
        })
        if (!this.ackTerminateTimers.has(worker)) {
          const ackTimer = setTimeout(() => {
            this.ackTerminateTimers.delete(worker)
            if (this.disposingWorkers.has(worker)) worker.terminate().catch(() => { /* ignore */ })
          }, ACK_TERMINATE_GRACE_MS)
          ackTimer.unref?.()
          this.ackTerminateTimers.set(worker, ackTimer)
        }
        return
      }
      case 'mirror-update':
        this.latest.set(msg.cwd, msg.state)
        performanceTrace.record(PERF_TRACE_EVENT.MAIN_GIT_STATE_MIRROR_FANOUT, {
          cwd: msg.cwd,
          subscriberCount: this.refCounts.get(msg.cwd) ?? 0,
          // The authoritative 5-state badge status the worker just COMPUTED. The
          // renderer's `terminal-title.color-rendered` records what was RENDERED,
          // so a "wrong badge colour" trace can localise a classification bug
          // (this value wrong) vs a render/propagation bug (rendered != this).
          status: msg.state.status,
          deltaKeys: Object.keys(msg.delta).filter((k) => k !== 'capturedAt')
        })
        this.fanout(msg.cwd, msg.delta)
        // Notify main-process listeners (e.g. terminal-git-info-bridge).
        for (const listener of this.mirrorUpdateListeners) {
          try {
            listener(msg.cwd, msg.state, msg.delta)
          } catch (error) {
            console.warn('[GitStateMirrorRouter] mirror-update listener threw:', error)
          }
        }
        // Phase 2 (Codex review P1-1): drive the diff-cache invalidation
        // chain off the worker's authoritative mirror-update signal
        // instead of leaning on a main-process `git-diff-cache-
        // invalidator` watcher to detect `.git/**` changes. The worker
        // already (a) applied the .git event allowlist correctly, (b)
        // debounced via DEBOUNCE_MS, (c) computed a real `MirrorDelta`
        // via `computeDelta` — so by the time we get here, we KNOW
        // state actually changed (the worker only emits mirror-update
        // when delta has > capturedAt). That breaks the feedback loop
        // the old cache invalidator watcher was trapped in: our own
        // `git status` writes to `.git/index` no longer drive a
        // GitDiffViewer refetch chain that re-runs `git status`,
        // because the worker's `computeDelta` step short-circuits when
        // git status produces the same answer twice in a row.
        for (const invalidateCwd of new Set([msg.cwd, msg.state.repoRoot].filter(Boolean) as string[])) {
          gitDiffCacheInvalidator.invalidate(invalidateCwd, 'mirror')
        }
        return
      case 'file-body-update': {
        const pending = this.pendingBodies.get(msg.replyId)
        if (!pending) return
        this.pendingBodies.delete(msg.replyId)
        if (msg.error && !msg.body) {
          pending.reject(new Error(msg.error))
        } else {
          pending.resolve(msg.body)
        }
        return
      }
      case 'watcher-status':
        this.watcherStatuses.set(msg.status.cwd, msg.status)
        if (
          process.env.ONWARD_DEBUG === '1' ||
          msg.status.health === 'degraded-polling' ||
          msg.status.health === 'suspended' ||
          msg.status.health === 'failed'
        ) {
          console.log('[GitStateMirrorRouter] watcher-status', {
            cwd: msg.status.cwd,
            repoRoot: msg.status.repoRoot,
            health: msg.status.health,
            failureKind: msg.status.failureKind,
            failureCount: msg.status.failureCount,
            polling: msg.status.polling
          })
        }
        this.fanoutWatcherStatus(msg.status)
        return
      case 'log':
        if (msg.level === 'error') {
          console.error('[git-state-mirror-worker]', msg.message, msg.data ?? '')
        } else if (msg.level === 'warn') {
          console.warn('[git-state-mirror-worker]', msg.message, msg.data ?? '')
        } else if (process.env.ONWARD_DEBUG === '1') {
          console.log('[git-state-mirror-worker]', msg.message, msg.data ?? '')
        }
        return
      case 'watcher-error':
        // Phase 5: surface FS-watcher failure to all renderers as an
        // explicit banner-eligible event. No silent retry / polling.
        console.error('[GitStateMirrorRouter] watcher-error', { cwd: msg.cwd, message: msg.message })
        gitDiffCacheInvalidator.notifyWatcherError(msg.cwd)
        for (const [wcId] of this.subs) {
          const wc = webContents.fromId(wcId)
          if (!wc || wc.isDestroyed()) continue
          try {
            wc.send(IPC.GIT_STATE_MIRROR_WATCHER_ERROR, msg.cwd, msg.message)
          } catch (error) {
            console.warn('[GitStateMirrorRouter] watcher-error send failed:', error)
          }
        }
        return
      default: {
        const exhaustive: never = msg
        console.warn('[GitStateMirrorRouter] unknown msg kind', (exhaustive as { kind?: string })?.kind)
      }
    }
  }

  private postToWorker(msg: MainToMirrorMessage): void {
    if (!this.worker) return
    try {
      this.worker.postMessage(msg)
    } catch (error) {
      console.error('[GitStateMirrorRouter] postMessage failed:', error)
    }
  }

  // ---------------------------------------------------------------------
  // IPC plumbing (renderer ↔ router)
  // ---------------------------------------------------------------------

  private registerIpcHandlers(): void {
    ipcMain.handle(IPC.GIT_STATE_MIRROR_SUBSCRIBE, (event, rawCwd: string) => {
      if (typeof rawCwd !== 'string' || !rawCwd) return null
      // Use realpath canonicalisation (not path.resolve) so symlinked
      // forms like `/var/...` and `/private/var/...` collapse to the
      // same key. See `canonicalise()` for the full rationale.
      const cwd = canonicalise(rawCwd)
      const wcId = event.sender.id
      let perRenderer = this.subs.get(wcId)
      if (!perRenderer) {
        perRenderer = new Map()
        this.subs.set(wcId, perRenderer)
      }
      const prevPerRendererCount = perRenderer.get(cwd) ?? 0
      perRenderer.set(cwd, prevPerRendererCount + 1)
      // First subscribe for this canonical FROM THIS RENDERER bumps the
      // global refCount so a single renderer that legitimately holds N
      // raw-form subscriptions only counts once toward the worker's
      // attach-watch decision. Subsequent same-canonical subscribes from
      // the same renderer are no-ops at the worker level.
      if (prevPerRendererCount === 0) {
        const next = (this.refCounts.get(cwd) ?? 0) + 1
        this.refCounts.set(cwd, next)
        if (next === 1) this.postToWorker({ kind: 'attach-watch', cwd })
      }
      return this.latest.get(cwd) ?? null
    })

    ipcMain.on(IPC.GIT_STATE_MIRROR_UNSUBSCRIBE, (event, rawCwd: string) => {
      if (typeof rawCwd !== 'string' || !rawCwd) return
      this.dropSubscription(event.sender.id, canonicalise(rawCwd))
    })

    ipcMain.handle(IPC.GIT_STATE_MIRROR_GET, (_event, rawCwd: string) => {
      if (typeof rawCwd !== 'string' || !rawCwd) return null
      return this.latest.get(canonicalise(rawCwd)) ?? null
    })

    ipcMain.on(IPC.GIT_STATE_PUSH_CWD, (_event, terminalId: string, rawCwd: string | null) => {
      this.pushTerminalCwd(terminalId, rawCwd)
    })

    ipcMain.handle(IPC.GIT_STATE_MIRROR_REQUEST_FILE_BODY, (_event, rawCwd: string, fileKey: string, force: boolean) => {
      if (typeof rawCwd !== 'string' || !rawCwd) return null
      return this.requestFileBody(canonicalise(rawCwd), fileKey, Boolean(force))
    })

    // Phase 5 PART 2: Refresh Changes — renderer triggers a full
    // recompute + identity bump. Idempotent; safe to call repeatedly.
    ipcMain.handle(IPC.GIT_STATE_MIRROR_FORCE_REFRESH, (_event, rawCwd: string) => {
      if (typeof rawCwd !== 'string' || !rawCwd) return false
      this.internalForceRecompute(rawCwd)
      return true
    })

    // Autotest-only observability: the subscription-leak suite reads the
    // router's tables to prove every open/close/reload path releases its
    // watcher. Gated inside the handler (registration is unconditional so
    // an accidental production call gets a typed error, not a hang).
    ipcMain.handle(IPC.GIT_STATE_MIRROR_DEBUG_INSPECT, () => {
      if (process.env.ONWARD_AUTOTEST !== '1') {
        return { success: false, error: 'git-state-mirror:debug-inspect requires ONWARD_AUTOTEST=1' }
      }
      return { success: true, ...this.inspect() }
    })
  }

  private requestFileBody(cwd: string, fileKey: string, force: boolean): Promise<MirrorFileBody | null> {
    return new Promise<MirrorFileBody | null>((resolveCb, rejectCb) => {
      const replyId = this.nextReplyId++
      const startedAt = Date.now()
      const pending: FileBodyPending = { resolve: resolveCb, reject: rejectCb, startedAt, cwd, fileKey }
      this.pendingBodies.set(replyId, pending)
      this.postToWorker({ kind: 'request-file-body', cwd, fileKey, force, replyId })
      setTimeout(() => {
        if (this.pendingBodies.delete(replyId)) {
          rejectCb(new Error(`request-file-body timed out after ${WORKER_REQUEST_TIMEOUT_MS}ms (cwd=${cwd}, fileKey=${fileKey})`))
        }
      }, WORKER_REQUEST_TIMEOUT_MS)
    })
  }

  private dropSubscription(wcId: number, cwd: string): void {
    const perRenderer = this.subs.get(wcId)
    if (!perRenderer) return
    const prevPerRendererCount = perRenderer.get(cwd) ?? 0
    if (prevPerRendererCount <= 0) return
    if (prevPerRendererCount > 1) {
      // Renderer still holds another raw-form subscription for the same
      // canonical (e.g. raw `/var/...` got dropped but the parallel raw
      // `/private/var/...` is still in `desired`). Decrement only —
      // don't touch the global refCount or detach the watcher.
      perRenderer.set(cwd, prevPerRendererCount - 1)
      return
    }
    perRenderer.delete(cwd)
    if (perRenderer.size === 0) this.subs.delete(wcId)
    const next = (this.refCounts.get(cwd) ?? 1) - 1
    if (next <= 0) {
      this.refCounts.delete(cwd)
      // Intentionally KEEP `this.latest.get(cwd)` here. A rapid resubscribe
      // (cd-burst pattern, terminal-grid cwd-flip, etc.) within the same
      // session expects to receive the last-known snapshot synchronously
      // from `subscribeMirror`'s return value. Worker still detaches its
      // parcel-watcher and a fresh recompute will overwrite this cache
      // when the next subscriber attaches. Memory cost is bounded by
      // distinct cwds visited per session.
      this.postToWorker({ kind: 'detach-watch', cwd })
    } else {
      this.refCounts.set(cwd, next)
    }
  }

  private fanout(cwd: string, delta: MirrorDelta): void {
    for (const [wcId, perRenderer] of this.subs) {
      if (!perRenderer.has(cwd)) continue
      const wc = webContents.fromId(wcId)
      if (!wc || wc.isDestroyed()) continue
      try {
        wc.send(IPC.GIT_STATE_MIRROR_UPDATE, cwd, delta)
      } catch (error) {
        console.warn('[GitStateMirrorRouter] fanout send failed:', error)
      }
    }
  }

  private fanoutWatcherStatus(status: MirrorWatcherStatus): void {
    for (const [wcId, perRenderer] of this.subs) {
      if (!perRenderer.has(status.cwd)) continue
      const wc = webContents.fromId(wcId)
      if (!wc || wc.isDestroyed()) continue
      try {
        wc.send(IPC.GIT_STATE_MIRROR_WATCHER_STATUS, status)
      } catch (error) {
        console.warn('[GitStateMirrorRouter] watcher-status send failed:', error)
      }
    }
  }

  /**
   * Notify every live renderer that a `pushTerminalCwd` raw value was
   * rejected by the main-side `resolveExistingTerminalCwd` filesystem
   * check. Renderers listen on `GIT_STATE_MIRROR_CWD_REJECTED` and roll
   * back the speculative `oscDetectedCwds` entry the renderer-side OSC
   * handler dispatched synchronously.
   *
   * Unlike `fanout`, this signal is per-terminal, not per-cwd: a rejected
   * cwd never enters `this.refCounts`, so we don't have a subscriber set
   * to address. Broadcast to every webContents instead — the renderer
   * filters by terminalId locally. The cost is one IPC message per live
   * window per rejection, which is bounded by how often inner programs
   * inject invalid OSC cwds (rare).
   */
  private broadcastCwdRejected(terminalId: string, rawCwd: string): void {
    let recipientCount = 0
    let sendFailures = 0
    for (const wc of webContents.getAllWebContents()) {
      if (wc.isDestroyed()) continue
      try {
        wc.send(IPC.GIT_STATE_MIRROR_CWD_REJECTED, terminalId, rawCwd)
        recipientCount += 1
      } catch (error) {
        sendFailures += 1
        console.warn('[GitStateMirrorRouter] cwd-rejected send failed:', error)
      }
    }
    // Diagnostic breadcrumb (Bug A reject channel). Pair with the renderer
    // counterpart `renderer:terminal.osc-cwd-rolled-back` to verify a future
    // "phantom cwd is back" report — if recipientCount is 0 the broadcast
    // never reached a live window; if recipient > 0 but the renderer event
    // is missing, the renderer listener regressed.
    performanceTrace.record(PERF_TRACE_EVENT.MAIN_GIT_STATE_MIRROR_CWD_REJECTED_BROADCAST, {
      terminalId,
      rawCwd: rawCwd.slice(0, 512),
      recipientCount,
      sendFailures
    })
  }

  /**
   * Drain every subscription a renderer holds. Shared by the two renderer
   * end-of-life signals below; also the G5 fix's core (2026-07-04 bundle:
   * 3 of 5 mirrored repos with no live terminal, ~950 recomputes each).
   */
  private drainRendererSubscriptions(wcId: number, reason: 'destroyed' | 'navigation'): void {
    const perRenderer = this.subs.get(wcId)
    if (!perRenderer || perRenderer.size === 0) return
    const cwdCount = perRenderer.size
    // Iterate a snapshot of (cwd, count) so we can fully drain each
    // canonical's per-renderer refCount in one pass — renderer teardown
    // must release the watcher even if the renderer held N raw-form
    // subscriptions for the same canonical.
    for (const [cwd, count] of Array.from(perRenderer)) {
      for (let i = 0; i < count; i += 1) this.dropSubscription(wcId, cwd)
    }
    performanceTrace.record(PERF_TRACE_EVENT.MAIN_GIT_STATE_MIRROR_RENDERER_SUBS_PURGED, {
      wcId,
      cwdCount,
      reason
    })
  }

  /**
   * Drop subscriptions belonging to a webContents whose renderer world
   * ended. TWO signals are required:
   *   - 'destroyed'            — window close / webContents teardown.
   *   - 'did-start-navigation' — RELOAD and real navigations. Electron
   *     never fires 'destroyed' on reload: the WebContents object (and its
   *     wc.id) survives while the renderer world — including every React
   *     unmount cleanup that would have called unsubscribeMirror — is
   *     wiped. Pre-fix, pre-reload subscriptions therefore parked in
   *     `subs` forever; after the post-reload renderer re-subscribed and
   *     later unsubscribed once, the count sat at 1 with no live owner,
   *     pinning the worker's watcher + reconcile heartbeat until app quit
   *     (the dead-repo churn: SL-02/SL-03 reproduce it).
   */
  private registerWebContentsCleanup(): void {
    const handle = (wc: Electron.WebContents) => {
      wc.on('destroyed', () => {
        this.drainRendererSubscriptions(wc.id, 'destroyed')
      })
      wc.on('did-start-navigation', (details) => {
        // Only a main-frame, cross-document navigation tears down the
        // renderer world. In-page (hash / history.pushState) navigations
        // keep every live subscription — do not touch those.
        if (!details.isMainFrame || details.isSameDocument) return
        this.drainRendererSubscriptions(wc.id, 'navigation')
      })
    }
    // Hook every existing + future webContents.
    for (const wc of webContents.getAllWebContents()) handle(wc)
    const onCreate = (_event: Electron.Event, wc: Electron.WebContents) => handle(wc)
    require('electron').app.on('web-contents-created', onCreate)
  }

  /** Test hook for autotest — read-only. */
  inspect(): {
    workerReady: boolean
    subscribers: number
    cwds: string[]
    watcherStatuses: MirrorWatcherStatus[]
    refCounts: Record<string, number>
    internalRefCounts: Record<string, number>
    perRenderer: Array<{ wcId: number; entries: Record<string, number> }>
  } {
    let subscribers = 0
    const perRenderer: Array<{ wcId: number; entries: Record<string, number> }> = []
    for (const [wcId, entries] of this.subs) {
      const table: Record<string, number> = {}
      for (const [cwd, count] of entries) {
        subscribers += count
        table[cwd] = count
      }
      perRenderer.push({ wcId, entries: table })
    }
    return {
      workerReady: this.workerReady,
      subscribers,
      cwds: Array.from(this.refCounts.keys()),
      watcherStatuses: Array.from(this.watcherStatuses.values()),
      refCounts: Object.fromEntries(this.refCounts),
      internalRefCounts: Object.fromEntries(this.internalRefCounts),
      perRenderer
    }
  }

  // ---------------------------------------------------------------------
  // Main-process API for in-process subscribers (terminal-git-info-bridge,
  // future Authority bridges). Same ref-count semantics as the IPC path
  // but bypasses the per-webContents tracking.
  // ---------------------------------------------------------------------

  /**
   * Subscribe to a cwd from main process. Returns the latest known
   * snapshot (or null if none yet — the worker will compute one and
   * deliver via the mirror-update listener path).
   */
  internalSubscribe(rawCwd: string): MirrorState | null {
    if (!rawCwd) return null
    const cwd = canonicalise(rawCwd)
    const next = (this.refCounts.get(cwd) ?? 0) + 1
    this.refCounts.set(cwd, next)
    this.internalRefCounts.set(cwd, (this.internalRefCounts.get(cwd) ?? 0) + 1)
    if (next === 1) this.postToWorker({ kind: 'attach-watch', cwd })
    return this.latest.get(cwd) ?? null
  }

  /** Symmetric unsubscribe; sends detach-watch when refCount hits 0. */
  internalUnsubscribe(rawCwd: string): void {
    if (!rawCwd) return
    const cwd = canonicalise(rawCwd)
    const internalNext = (this.internalRefCounts.get(cwd) ?? 1) - 1
    if (internalNext <= 0) this.internalRefCounts.delete(cwd)
    else this.internalRefCounts.set(cwd, internalNext)
    const next = (this.refCounts.get(cwd) ?? 1) - 1
    if (next <= 0) {
      this.refCounts.delete(cwd)
      this.postToWorker({ kind: 'detach-watch', cwd })
    } else {
      this.refCounts.set(cwd, next)
    }
  }

  /**
   * Force a recompute for an attached cwd. Use sparingly — this is the
   * "Refresh Changes" / focus-resync path. Pure event-driven (the call
   * itself IS the event), not a polled retry.
   */
  internalForceRecompute(rawCwd: string): void {
    if (!rawCwd) return
    const cwd = canonicalise(rawCwd)
    if (!this.refCounts.has(cwd)) return
    this.postToWorker({ kind: 'focus-resync', cwd })
  }

  /**
   * Watcher-independent revalidation (2026-07-05 spinner bundles). Unlike
   * `internalForceRecompute`, this does NOT bump the per-cwd generation, so an
   * unchanged repo produces no delta and no DiffEditor re-mount — the diff view
   * paints its cached list instantly and only re-renders if the recompute finds
   * a REAL change the FS watcher missed. Drives (a) Git Diff revalidate-on-open
   * and (b) the terminal git-command trigger. No-op for an unsubscribed cwd.
   * `source` is diagnostic ('diff-open' | 'terminal-command').
   */
  revalidateCwd(rawCwd: string, source: string): void {
    if (!rawCwd) return
    const cwd = canonicalise(rawCwd)
    if (!this.refCounts.has(cwd)) return
    performanceTrace.record(PERF_TRACE_EVENT.MAIN_GIT_STATE_MIRROR_REVALIDATE_REQUESTED, {
      cwd,
      source
    })
    this.postToWorker({ kind: 'revalidate', cwd, source })
  }

  /**
   * Unique repo roots that the background auto-fetch should keep fresh: one per
   * distinct `repoRoot` among currently-watched cwds (refCount > 0). A repo we
   * have already classified as having NO upstream (a real status with
   * ahead/behind both undefined for every one of its active cwds) is excluded —
   * fetching it would not change any badge (the "skip no-upstream" decision). A
   * repo with no snapshot yet is INCLUDED so its first fetch can discover an
   * upstream; a repo with any upstream-bearing cwd is included.
   */
  getAutofetchRepoRoots(): string[] {
    const byRoot = new Map<string, { hasUpstream: boolean; hasKnownState: boolean }>()
    for (const [cwd, count] of this.refCounts) {
      if (count <= 0) continue
      const state = this.latest.get(cwd)
      const repoRoot = state?.repoRoot
      if (!repoRoot) continue
      const agg = byRoot.get(repoRoot) ?? { hasUpstream: false, hasKnownState: false }
      // status !== null means the worker produced a real classification for this
      // cwd (repo resolved + git status parsed), so "no ahead/behind" is a
      // definitive "no upstream" rather than "not computed yet".
      if (state && state.status !== null) agg.hasKnownState = true
      if (state && (state.ahead !== undefined || state.behind !== undefined)) agg.hasUpstream = true
      byRoot.set(repoRoot, agg)
    }
    const out: string[] = []
    for (const [repoRoot, agg] of byRoot) {
      if (agg.hasUpstream || !agg.hasKnownState) out.push(repoRoot)
    }
    return out
  }

  /**
   * Revalidate every active cwd under `repoRoot` (used after a background fetch
   * advanced that repo's remote-tracking ref, so the mirror re-reads
   * `# branch.ab` and the badge's ↓behind count refreshes). Each cwd's recompute
   * dedups per repo in the worker, and emits only on a real delta — an unchanged
   * repo (fetch pulled nothing) produces no broadcast and no flicker.
   */
  revalidateRepoRoot(repoRoot: string, source: string): void {
    if (!repoRoot) return
    for (const [cwd, count] of this.refCounts) {
      if (count <= 0) continue
      if (this.latest.get(cwd)?.repoRoot !== repoRoot) continue
      this.postToWorker({ kind: 'revalidate', cwd, source })
    }
  }

  /**
   * Tell the worker which repo (by the focused terminal's cwd) is focused, so
   * its always-on reconcile heartbeat polls that repo at 1 s and the rest of
   * the visible repos at 3 s. Forward-only — no git work on main (constraint
   * H1 in docs/git-status-reconcile-design.md). Pass null to clear focus.
   */
  setReconcileFocus(rawCwd: string | null): void {
    const cwd = rawCwd ? canonicalise(rawCwd) : null
    this.postToWorker({ kind: 'reconcile-focus', cwd })
  }

  /**
   * G3 foreground yield: a user-visible getDiff for `cwd` started
   * (busy=true) or settled (busy=false). Forwarded to the worker so the
   * repo's background recomputes defer instead of competing for the
   * EDR-taxed process-creation lane. repoRoot rides along (when the mirror
   * already knows it) so subdir/root forms of the same repo match.
   */
  setForegroundBusy(rawCwd: string, busy: boolean): void {
    if (!rawCwd) return
    const cwd = canonicalise(rawCwd)
    const repoRoot = this.latest.get(cwd)?.repoRoot ?? null
    this.postToWorker({ kind: 'foreground-yield', cwd, repoRoot, busy })
  }

  /** Read-only access to the last-pushed cwd for a terminal (for bridge cold-start). */
  getTerminalCwd(terminalId: string): string | null {
    return this.terminalCwds.get(terminalId) ?? null
  }

  canonicaliseCwd(rawCwd: string): string {
    return canonicalise(rawCwd)
  }

  pushTerminalCwd(terminalId: string, rawCwd: string | null): void {
    if (typeof terminalId !== 'string' || !terminalId) return
    const newCwd = rawCwd ? resolveExistingTerminalCwd(rawCwd) : null
    if (rawCwd && !newCwd) {
      performanceTrace.record(PERF_TRACE_EVENT.MAIN_GIT_STATE_MIRROR_CWD_IGNORED, {
        terminalId,
        reason: 'invalid-cwd',
        rawCwd: rawCwd.slice(0, 512)
      })
      // Broadcast the rejection back to every renderer that has a
      // GitStateMirror subscription. Renderers use this to roll back any
      // speculative `oscDetectedCwds` entry they committed when they
      // parsed the OSC + dispatched `onward:terminal-cwd-detected`
      // synchronously, before the main-side `resolveExistingTerminalCwd`
      // filesystem check could run. Without this signal the renderer
      // would otherwise show a phantom cwd indefinitely (TTM-32 bug:
      // OSC 7 ; file:///<free-text> leaks into the task header).
      this.broadcastCwdRejected(terminalId, rawCwd)
      return
    }
    const prevCwd = this.terminalCwds.get(terminalId) ?? null
    this.terminalCwds.set(terminalId, newCwd)
    performanceTrace.record(PERF_TRACE_EVENT.MAIN_GIT_STATE_MIRROR_CWD_SWITCHED, {
      terminalId,
      prevCwd,
      nextCwd: newCwd
    })
    this.postToWorker({ kind: 'switch-cwd', terminalId, newCwd })
    // Notify main-process listeners after worker is informed so the
    // bridge can swap its mirror subscription onto the new cwd.
    for (const listener of this.cwdChangeListeners) {
      try {
        listener(terminalId, prevCwd, newCwd)
      } catch (error) {
        console.warn('[GitStateMirrorRouter] cwd-change listener threw:', error)
      }
    }
  }

  /** Read-only access to the last-known snapshot for a cwd. */
  getLatest(rawCwd: string): MirrorState | null {
    if (!rawCwd) return null
    return this.latest.get(canonicalise(rawCwd)) ?? null
  }

  /** Register a listener for mirror-update events. Returns dispose fn. */
  onMirrorUpdate(listener: MirrorUpdateListener): () => void {
    this.mirrorUpdateListeners.add(listener)
    return () => { this.mirrorUpdateListeners.delete(listener) }
  }

  /** Register a listener for terminal cwd-change events (PUSH_CWD). */
  onCwdChange(listener: CwdChangeListener): () => void {
    this.cwdChangeListeners.add(listener)
    return () => { this.cwdChangeListeners.delete(listener) }
  }
}

export const gitStateMirrorRouter = new GitStateMirrorRouter()
