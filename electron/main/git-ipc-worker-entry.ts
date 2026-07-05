/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

import { parentPort } from 'worker_threads'
import {
  checkGitInstalled,
  discardGitFile,
  getGitDiff,
  getGitDiffRequestCacheStats,
  getGitFileContent,
  getGitHistory,
  getGitHistoryDiff,
  getGitHistoryFileContent,
  prewarmHistoryCommitDiffs,
  getGitRepoMeta,
  invalidateGitDiffCache,
  resolveRepoRoot,
  saveGitFileContent,
  stageGitFile,
  unstageGitFile,
  updateGitIndexContent,
  type GitFileContentRequestOptions,
  type GitFileStatus,
  type GitHistoryDiffOptions,
  type GitHistoryFileContentOptions
} from './git-utils'
import {
  gitRepositorySnapshotService,
  snapshotToLegacySubmoduleInfos
} from './git-repository-snapshot-service'
import { performanceTrace } from './performance-trace'
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

/**
 * One-way control envelope (no reply). Used by main → worker bridges that
 * fan out a side-effect (cache invalidation, watcher events) without
 * waiting for an ack. Distinguishable from `WorkerRequest` by the absence
 * of a numeric `id` and the presence of a string `event` discriminator.
 */
type WorkerControlEnvelope =
  | { event: 'invalidate-diff-cache'; cwd: string; reason: string }

function isWorkerControlEnvelope(value: unknown): value is WorkerControlEnvelope {
  if (!value || typeof value !== 'object') return false
  return typeof (value as { event?: unknown }).event === 'string'
}

function stringPayload(payload: Record<string, unknown>, key: string): string {
  const value = payload[key]
  return typeof value === 'string' ? value : ''
}

async function dispatch(method: GitIpcWorkerMethod, payload: Record<string, unknown>): Promise<unknown> {
  const cwd = stringPayload(payload, 'cwd')
  switch (method) {
    case 'checkInstalled':
      return await checkGitInstalled()
    case 'resolveRepoRoot':
      return await resolveRepoRoot(cwd)
    case 'getDiff':
      return await getGitDiff(cwd, payload.options as { scope?: 'root-only' | 'full'; force?: boolean } | undefined)
    case 'getHistory':
      return await getGitHistory(
        cwd,
        Number(payload.limit) || undefined,
        Number(payload.skip) || undefined,
        typeof payload.branchOid === 'string' ? payload.branchOid : undefined,
        typeof payload.refsDigest === 'string' ? payload.refsDigest : undefined
      )
    case 'getHistoryDiff':
      return await getGitHistoryDiff(cwd, payload.options as GitHistoryDiffOptions)
    case 'getHistoryFileContent':
      return await getGitHistoryFileContent(cwd, payload.options as GitHistoryFileContentOptions)
    case 'prewarmHistoryDiffs':
      return await prewarmHistoryCommitDiffs(
        cwd,
        typeof payload.branchOid === 'string' ? payload.branchOid : undefined,
        Number(payload.limit) || 50
      )
    case 'getFileContent':
      return await getGitFileContent(
        cwd,
        payload.file as Pick<GitFileStatus, 'filename' | 'status' | 'originalFilename' | 'changeType' | 'isSubmoduleEntry'>,
        typeof payload.repoRoot === 'string' ? payload.repoRoot : undefined,
        payload.options as GitFileContentRequestOptions | undefined
      )
    case 'saveFileContent':
      return await saveGitFileContent(cwd, stringPayload(payload, 'filename'), stringPayload(payload, 'content'))
    case 'stageFile':
      return await stageGitFile(cwd, stringPayload(payload, 'filename'), typeof payload.repoRoot === 'string' ? payload.repoRoot : undefined)
    case 'unstageFile':
      return await unstageGitFile(cwd, stringPayload(payload, 'filename'), typeof payload.repoRoot === 'string' ? payload.repoRoot : undefined)
    case 'discardFile':
      return await discardGitFile(
        cwd,
        payload.file as Pick<GitFileStatus, 'filename' | 'changeType' | 'status' | 'isSubmoduleEntry'>,
        typeof payload.repoRoot === 'string' ? payload.repoRoot : undefined
      )
    case 'getSubmodules': {
      // Phase 3 of the lesson #13 follow-up: route the IPC handler
      // through the snapshot service. Preserves the legacy
      // `GitSubmoduleInfo[]` API surface (a few external consumers may
      // depend on it via the preload bridge) while making the snapshot
      // service the only path that runs `.gitmodules + git submodule
      // status + getGitRepoMeta` discovery.
      const snapshot = await gitRepositorySnapshotService.getSnapshot(cwd)
      if (!snapshot.isRepo) return []
      return snapshotToLegacySubmoduleInfos(snapshot)
    }
    case 'updateIndexContent':
      return await updateGitIndexContent(cwd, stringPayload(payload, 'filename'), stringPayload(payload, 'content'))
    case 'warmDiffCache':
      try {
        // Warm BOTH scopes the subpage-entry two-phase load asks for. The
        // entry first requests `root-only` (fast first paint) and, when the
        // repo has submodules, then `full`. Warming only `full` (the old
        // behaviour) left the `root-only` cache key cold, so the very first
        // paint still recomputed. Warm both so a subsequent open is a pure
        // cache hit on both phases.
        //
        // G2 C-i: main forwards the mirror's fresh parent status when it has
        // one; getSingleRepoDiff age-gates it (15 s) and skips the root
        // `git status` spawn on a hit. `background: true` marks both loads
        // as warm-path so the presupplied status can never leak into a
        // foreground open's path.
        const presuppliedRootStatus = (payload as {
          presuppliedRootStatus?: { files: GitFileStatus[]; capturedAt: number }
        }).presuppliedRootStatus
        if (!presuppliedRootStatus) {
          performanceTrace.record(PERF_TRACE_EVENT.MAIN_GIT_DIFF_WARM_STATUS_REUSE, {
            cwd,
            result: 'unavailable'
          })
        }
        await Promise.all([
          getGitDiff(cwd, { scope: 'root-only', background: true, presuppliedRootStatus }),
          getGitDiff(cwd, { scope: 'full', background: true, presuppliedRootStatus })
        ])
        return { success: true }
      } catch {
        return { success: false }
      }
    case 'inspectListCacheStats':
      // Stats live in the worker's module instance because getGitDiff runs
      // here. Main reads them through this method so the diagnostics panel
      // sees the actual counters, not the empty main-process controller.
      return getGitDiffRequestCacheStats()
    default:
      throw new Error(`Unsupported Git IPC worker method: ${method}`)
  }
}

parentPort?.on('message', async (incoming: WorkerRequest | WorkerControlEnvelope) => {
  // One-way control envelopes (cache invalidation pushed by main when the
  // FS watcher fires) are processed in-place — no response is sent. This
  // path is intentionally synchronous-shaped: it must not allocate a
  // pending request slot in the client, otherwise a watcher storm could
  // exhaust the request id space.
  if (isWorkerControlEnvelope(incoming)) {
    if (incoming.event === 'invalidate-diff-cache') {
      try {
        invalidateGitDiffCache(incoming.cwd, incoming.reason)
      } catch {
        // Worker invalidation must never bring down the worker — if the
        // cache delete throws (e.g. a future cache structure change), the
        // worst case is one stale read until the next watcher fire.
      }
    }
    return
  }

  const request = incoming as WorkerRequest
  const response: WorkerResponse = {
    id: request.id,
    ok: false
  }

  try {
    response.result = await dispatch(request.method, request.payload || {})
    response.ok = true
  } catch (error) {
    response.error = error instanceof Error ? error.message : String(error)
  }

  parentPort?.postMessage(response)
})
