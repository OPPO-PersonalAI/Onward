/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

import { join, resolve } from 'path'
import { Worker } from 'worker_threads'
import { gitRuntimeManager, type GitTaskPriority } from './git-runtime-manager'
import {
  buildGitDiffWorkerDedupeKey,
  buildGitFileContentWorkerDedupeKey,
  diffListLaneKey,
  fileContentLaneKey,
  historyLaneKey,
  repoKeyForWorker as repoKeyFor,
  stableStringifyForWorkerKey as stableStringify,
  type GitFileContentWorkerRequestOptions
} from './git-ipc-worker-client-helpers'
import type { GitDiffRequestCacheStats } from './git-diff-request-cache'
import type {
  GitDiffLoadOptions,
  GitDiffResult,
  GitFileActionResult,
  GitFileContentResult,
  GitFileSaveResult,
  GitFileStatus,
  GitHistoryDiffOptions,
  GitHistoryDiffResult,
  GitHistoryFileContentOptions,
  GitHistoryFileContentResult,
  GitHistoryResult,
  GitSubmoduleInfo
} from './git-utils'
import {
  performanceTrace,
  isPerfTraceWorkerEvent,
  replayPerfTraceWorkerEvent,
  WORKER_TID
} from './performance-trace'
import { PERF_TRACE_EVENT } from '../../src/utils/perf-trace-names'

type GitIpcWorkerMethod =
  | 'checkInstalled'
  | 'resolveRepoRoot'
  | 'getDiff'
  | 'getHistory'
  | 'getHistoryDiff'
  | 'getHistoryFileContent'
  | 'prewarmHistoryDiffs'
  | 'getFileContent'
  | 'saveFileContent'
  | 'stageFile'
  | 'unstageFile'
  | 'discardFile'
  | 'getSubmodules'
  | 'updateIndexContent'
  | 'warmDiffCache'
  | 'inspectListCacheStats'

type WorkerRequest = {
  id: number
  method: GitIpcWorkerMethod
  payload: Record<string, unknown>
}

type WorkerResponse = {
  id: number
  ok: boolean
  result?: unknown
  error?: string
}

type WorkerTaskOptions = {
  priority?: GitTaskPriority
  repoKey?: string | null
  repoConcurrencyLimit?: number
  dedupeKey?: string
  label?: string
}

type PendingRequest = {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
  method: GitIpcWorkerMethod
  startedAt: number
}

const WORKER_REQUEST_TIMEOUT_MS = 90000

class GitIpcWorkerClient {
  private worker: Worker | null = null
  private hasSpawnedWorkerOnce = false
  private respawnListeners = new Set<() => void>()
  // Quit latch (see git-state-mirror-router): no worker spawns after quit begins.
  private disposed = false
  private nextRequestId = 1
  private pending = new Map<number, PendingRequest>()

  checkInstalled(): Promise<boolean> {
    return this.enqueueWorkerTask<boolean>('checkInstalled', {}, {
      priority: 'low',
      repoKey: null,
      repoConcurrencyLimit: 1,
      dedupeKey: 'git-ipc:check-installed',
      label: 'worker git --version'
    })
  }

  resolveRepoRoot(cwd: string): Promise<string> {
    return this.enqueueWorkerTask<string>('resolveRepoRoot', { cwd }, {
      priority: 'normal',
      repoKey: cwd,
      dedupeKey: `git-ipc:resolve-root:${resolve(cwd)}`,
      label: 'worker git resolve repo root'
    })
  }

  getDiff(cwd: string, options?: GitDiffLoadOptions): Promise<GitDiffResult> {
    // Background prewarm (precompute scheduler) runs in a SEPARATE low-priority
    // per-repo lane so it never holds the foreground enter's concurrency-1 slot.
    // Without this, a slow background `getDiff(force)` recompute blocks the
    // user's enter for the same repo (measured: foreground enter cache-HITS
    // queued for seconds behind the prewarm on EDR-throttled hosts).
    const background = options?.background === true
    return this.enqueueWorkerTask<GitDiffResult>('getDiff', { cwd, options }, {
      priority: background ? 'low' : 'high',
      repoKey: diffListLaneKey(cwd, background),
      repoConcurrencyLimit: 1,
      dedupeKey: buildGitDiffWorkerDedupeKey(cwd, options),
      label: background ? 'worker git diff (precompute)' : 'worker git diff'
    })
  }

  getHistory(
    cwd: string,
    limit?: number,
    skip?: number,
    branchOid?: string,
    refsDigest?: string,
    background?: boolean
  ): Promise<GitHistoryResult> {
    // branchOid + refsDigest (both supplied by main from the GitStateMirror
    // snapshot) are the worker-side L8 list cache's two freshness signals; carry
    // them through and into the dedupe key so a prewarm and a foreground open at
    // the same HEAD + ref state coalesce, and a ref-only move (push/fetch) is a
    // structural miss. The background prewarm runs in the low
    // `::history-precompute` lane.
    const bg = background === true
    return this.enqueueWorkerTask<GitHistoryResult>('getHistory', { cwd, limit, skip, branchOid, refsDigest }, {
      priority: bg ? 'low' : 'normal',
      repoKey: historyLaneKey(cwd, bg),
      repoConcurrencyLimit: 1,
      dedupeKey: `git-ipc:history:${resolve(cwd)}:${branchOid ?? 'nohead'}:${refsDigest ?? 'norefs'}:${limit ?? 50}:${skip ?? 0}`,
      label: bg ? 'worker git history (precompute)' : 'worker git history'
    })
  }

  /**
   * A2: warm the L9 commit-diff cache for the first `limit` commits in ONE
   * `git log --raw --numstat` spawn (always background, low `::history-precompute`
   * lane). Returns how many commits were primed.
   */
  prewarmHistoryDiffs(cwd: string, branchOid: string | undefined, limit: number): Promise<{ warmed: number }> {
    return this.enqueueWorkerTask<{ warmed: number }>('prewarmHistoryDiffs', { cwd, branchOid, limit }, {
      priority: 'low',
      repoKey: historyLaneKey(cwd, true),
      repoConcurrencyLimit: 1,
      dedupeKey: `git-ipc:history-batch:${resolve(cwd)}:${branchOid ?? 'nohead'}:${limit}`,
      label: 'worker git history prewarm batch'
    })
  }

  getHistoryDiff(cwd: string, options: GitHistoryDiffOptions, background?: boolean): Promise<GitHistoryDiffResult> {
    const bg = background === true
    return this.enqueueWorkerTask<GitHistoryDiffResult>('getHistoryDiff', { cwd, options }, {
      priority: bg ? 'low' : 'high',
      repoKey: historyLaneKey(cwd, bg),
      repoConcurrencyLimit: 1,
      dedupeKey: `git-ipc:history-diff:${resolve(cwd)}:${stableStringify(options)}`,
      label: bg ? 'worker git history diff (precompute)' : 'worker git history diff'
    })
  }

  getHistoryFileContent(cwd: string, options: GitHistoryFileContentOptions): Promise<GitHistoryFileContentResult> {
    return this.enqueueWorkerTask<GitHistoryFileContentResult>('getHistoryFileContent', { cwd, options }, {
      priority: 'high',
      repoKey: cwd,
      repoConcurrencyLimit: 1,
      dedupeKey: `git-ipc:history-file-content:${resolve(cwd)}:${stableStringify(options)}`,
      label: 'worker git history file content'
    })
  }

  getFileContent(
    cwd: string,
    file: Pick<GitFileStatus, 'filename' | 'status' | 'originalFilename' | 'changeType' | 'isSubmoduleEntry'>,
    repoRoot?: string,
    options?: GitFileContentWorkerRequestOptions
  ): Promise<GitFileContentResult> {
    // Foreground clicks default to 'high'; the background precompute passes
    // 'low'. CRITICAL: give the 'low' lane its OWN per-repo key so a foreground
    // click never queues behind the prewarm. Previously both used the same
    // repoKey + concurrency-1 slot AND a hardcoded 'high' priority, so the
    // precompute's burst (enqueued first during enter/list) blocked the later
    // click FIFO — measured 18-29s first-click latency on EDR-throttled hosts.
    const priority: GitTaskPriority = options?.priority === 'low' || options?.priority === 'normal'
      ? options.priority
      : 'high'
    const baseRepoKey = repoKeyFor(cwd, repoRoot)
    const repoKey = fileContentLaneKey(baseRepoKey, priority)
    return this.enqueueWorkerTask<GitFileContentResult>('getFileContent', { cwd, file, repoRoot, options }, {
      priority,
      repoKey,
      repoConcurrencyLimit: 1,
      dedupeKey: buildGitFileContentWorkerDedupeKey(cwd, file, repoRoot, options),
      label: priority === 'low' ? 'worker git file content (precompute)' : 'worker git file content'
    })
  }

  saveFileContent(cwd: string, filename: string, content: string): Promise<GitFileSaveResult> {
    return this.enqueueWorkerTask<GitFileSaveResult>('saveFileContent', { cwd, filename, content }, {
      priority: 'high',
      repoKey: cwd,
      repoConcurrencyLimit: 1,
      label: 'worker save git file content'
    })
  }

  stageFile(cwd: string, filename: string, repoRoot?: string): Promise<GitFileActionResult> {
    return this.enqueueWorkerTask<GitFileActionResult>('stageFile', { cwd, filename, repoRoot }, {
      priority: 'high',
      repoKey: repoKeyFor(cwd, repoRoot),
      repoConcurrencyLimit: 1,
      label: 'worker git stage file'
    })
  }

  unstageFile(cwd: string, filename: string, repoRoot?: string): Promise<GitFileActionResult> {
    return this.enqueueWorkerTask<GitFileActionResult>('unstageFile', { cwd, filename, repoRoot }, {
      priority: 'high',
      repoKey: repoKeyFor(cwd, repoRoot),
      repoConcurrencyLimit: 1,
      label: 'worker git unstage file'
    })
  }

  discardFile(
    cwd: string,
    file: Pick<GitFileStatus, 'filename' | 'changeType' | 'status' | 'isSubmoduleEntry'>,
    repoRoot?: string
  ): Promise<GitFileActionResult> {
    return this.enqueueWorkerTask<GitFileActionResult>('discardFile', { cwd, file, repoRoot }, {
      priority: 'high',
      repoKey: repoKeyFor(cwd, repoRoot),
      repoConcurrencyLimit: 1,
      label: 'worker git discard file'
    })
  }

  getSubmodules(cwd: string): Promise<GitSubmoduleInfo[]> {
    return this.enqueueWorkerTask<GitSubmoduleInfo[]>('getSubmodules', { cwd }, {
      priority: 'normal',
      repoKey: cwd,
      repoConcurrencyLimit: 1,
      dedupeKey: `git-ipc:submodules:${resolve(cwd)}`,
      label: 'worker git submodules'
    })
  }

  updateIndexContent(cwd: string, filename: string, content: string): Promise<GitFileActionResult> {
    return this.enqueueWorkerTask<GitFileActionResult>('updateIndexContent', { cwd, filename, content }, {
      priority: 'high',
      repoKey: cwd,
      repoConcurrencyLimit: 1,
      label: 'worker git update index content'
    })
  }

  warmDiffCache(
    cwd: string,
    presuppliedRootStatus?: { files: GitFileStatus[]; capturedAt: number }
  ): Promise<{ success: boolean }> {
    return this.enqueueWorkerTask<{ success: boolean }>('warmDiffCache', { cwd, presuppliedRootStatus }, {
      priority: 'low',
      // Separate background lane: the warm is slow (full recompute) and must not
      // hold the foreground enter's concurrency-1 slot for the same repo. Shares
      // the prewarm diff-list lane (it IS a full-list recompute).
      repoKey: diffListLaneKey(cwd, true),
      repoConcurrencyLimit: 1,
      dedupeKey: `git-ipc:warm-diff:${resolve(cwd)}`,
      label: 'worker warm git diff cache'
    })
  }

  /**
   * Read the list-cache hit/miss/force counters from the worker. The
   * `gitDiffRequestCache` is owned by the worker because that is where
   * `getGitDiff` runs, so the main-process module instance's controller
   * is always empty. The diagnostics panel must come through this path
   * to see the real numbers.
   */
  inspectListCacheStats(): Promise<GitDiffRequestCacheStats> {
    return this.enqueueWorkerTask<GitDiffRequestCacheStats>('inspectListCacheStats', {}, {
      priority: 'low',
      repoKey: null,
      repoConcurrencyLimit: 1,
      dedupeKey: 'git-ipc:inspect-list-cache-stats',
      label: 'worker inspect list cache stats'
    })
  }

  /**
   * One-way push: tell the worker to drop its `gitDiffRequestCache` /
   * `singleRepoDiffCache` entries for `cwd`. Fires when main's FS watcher
   * detects an external mutation. Side-effect only — no response is awaited.
   *
   * Why this exists: `getGitDiff` runs in the worker, so its cache lives in
   * the worker's module instance. The watcher fires in main, where its own
   * listener can only clear main's (usually empty) cache. Without this
   * bridge the worker would return a stale cached result for up to
   * `GIT_DIFF_REQUEST_TTL_MS` after an external file change.
   *
   * Defensive: if the worker hasn't been spawned yet, there is nothing to
   * invalidate (the next `getDiff` call will start fresh anyway).
   */
  invalidateDiffCache(cwd: string, reason: string): void {
    if (!this.worker) return
    try {
      this.worker.postMessage({ event: 'invalidate-diff-cache', cwd, reason })
    } catch {
      // Worker may have just exited / been replaced; the next getDiff will
      // re-spawn with a fresh cache.
    }
  }

  dispose(): void {
    this.disposed = true
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer)
      this.pending.delete(id)
    }
    if (this.worker) {
      this.worker.terminate().catch(() => {})
      this.worker = null
    }
  }

  private enqueueWorkerTask<T>(
    method: GitIpcWorkerMethod,
    payload: Record<string, unknown>,
    options: WorkerTaskOptions = {}
  ): Promise<T> {
    return gitRuntimeManager.enqueueTask(
      {
        key: options.dedupeKey,
        repoKey: options.repoKey ?? undefined,
        repoConcurrencyLimit: options.repoConcurrencyLimit,
        priority: options.priority || 'normal',
        kind: 'git',
        label: options.label || `git-ipc-worker:${method}`
      },
      () => this.request<T>(method, payload)
    )
  }

  /**
   * Register a callback fired when the worker is RE-spawned after a
   * previous instance exited. A fresh worker starts with empty in-memory
   * caches (repo meta, request cache, structural snapshots) while
   * main-side state — the prewarm coordinator's dedup above all — still
   * says "already warmed". Q1 of the 2026-07-04 spinner analysis: a
   * mid-session worker exit turned every later diff open permanently cold
   * because nothing ever re-warmed. The prewarm coordinator subscribes
   * here to reset its dedup and re-warm live cwds.
   */
  onWorkerRespawn(listener: () => void): () => void {
    this.respawnListeners.add(listener)
    return () => this.respawnListeners.delete(listener)
  }

  private ensureWorker(): Worker {
    if (this.disposed) throw new Error('Git IPC worker client disposed (quit in progress)')
    if (this.worker) return this.worker

    const isRespawn = this.hasSpawnedWorkerOnce
    this.hasSpawnedWorkerOnce = true
    const workerPath = join(__dirname, 'git-ipc-worker-entry.js')
    this.worker = new Worker(workerPath)
    if (isRespawn) {
      for (const listener of this.respawnListeners) {
        try {
          listener()
        } catch {
          // A respawn listener must never break worker creation.
        }
      }
    }
    this.worker.on('message', (message: WorkerResponse | unknown) => {
      // Trace events forwarded from the worker thread land on a dedicated
      // tid lane so Perfetto UI shows "git-ipc-worker" as its own row.
      if (isPerfTraceWorkerEvent(message)) {
        replayPerfTraceWorkerEvent(message, {
          tid: WORKER_TID.GIT_IPC,
          threadName: 'git-ipc-worker'
        })
        return
      }
      this.handleMessage(message as WorkerResponse)
    })
    this.worker.on('error', (error) => {
      performanceTrace.record(PERF_TRACE_EVENT.WORKER_GIT_IPC_ERROR, { error: String(error) })
    })
    this.worker.on('exit', (code) => {
      performanceTrace.record(PERF_TRACE_EVENT.WORKER_GIT_IPC_EXIT, {
        code,
        pending: this.pending.size
      })
      this.rejectAllPending(new Error(`Git IPC worker exited with code ${code}`))
      this.worker = null
    })
    return this.worker
  }

  private request<T>(method: GitIpcWorkerMethod, payload: Record<string, unknown>): Promise<T> {
    const worker = this.ensureWorker()
    const id = this.nextRequestId++
    const startedAt = Date.now()

    return new Promise<T>((resolveTask, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        performanceTrace.record(PERF_TRACE_EVENT.WORKER_GIT_IPC_TIMEOUT, {
          id,
          method,
          elapsedMs: Date.now() - startedAt
        })
        reject(new Error(`Git IPC worker request timed out: ${method}`))
      }, WORKER_REQUEST_TIMEOUT_MS)

      this.pending.set(id, {
        resolve: resolveTask as (value: unknown) => void,
        reject,
        timer,
        method,
        startedAt
      })

      const request: WorkerRequest = { id, method, payload }
      worker.postMessage(request)
    })
  }

  private handleMessage(message: WorkerResponse): void {
    const pending = this.pending.get(message.id)
    if (!pending) return
    clearTimeout(pending.timer)
    this.pending.delete(message.id)

    const elapsedMs = Date.now() - pending.startedAt
    if (elapsedMs > 500) {
      performanceTrace.record(PERF_TRACE_EVENT.WORKER_GIT_IPC_LATENCY, {
        id: message.id,
        method: pending.method,
        elapsedMs
      })
    }

    if (message.ok) {
      pending.resolve(message.result)
    } else {
      pending.reject(new Error(message.error || `Git IPC worker failed: ${pending.method}`))
    }
  }

  private rejectAllPending(error: Error): void {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer)
      pending.reject(error)
      this.pending.delete(id)
    }
  }
}

export const gitIpcWorkerClient = new GitIpcWorkerClient()
