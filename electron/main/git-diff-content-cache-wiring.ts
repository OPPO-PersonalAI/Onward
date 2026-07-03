/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

// Singletons that glue the per-project content cache + precompute scheduler
// to the existing main-process IPC layer.
//
//   gitDiffContentCache         — pure data, eviction policy
//   gitDiffPrecomputeScheduler  — eager fetch orchestrator
//   fetchFileContentWithCache() — single fetch helper used by both the
//                                 ipcMain handler (synchronous demand) and
//                                 the scheduler (background prefill).
//
// Wiring contract:
//   - Whenever `gitDiffCacheInvalidator` fires for a cwd, the project bucket
//     is wiped AND a precompute burst is queued (see `installCacheInvalidator`
//     below). Caller invokes that hook exactly once at setup.
//   - The handler in `ipc-handlers.ts` calls `fetchFileContentWithCache` for
//     every renderer-driven `getFileContent` request. Cache hits return in
//     microseconds; misses fall through to the worker.
//   - The scheduler's `loadWorkingSet` re-uses `gitIpcWorkerClient.getDiff`
//     so it inherits the existing list-level cache and FS-watch invalidation.

import type {
  GitDiffContentCacheMissReason,
  GitFileContentResult,
  GitFileStatus
} from './git-utils'
import { getGitDiffRequestCacheStats } from './git-utils'
import type { GitDiffRequestCacheStats } from './git-diff-request-cache'
import { GitDiffContentCache } from './git-diff-content-cache'
import { GitDiffPrecomputeScheduler, isPrecomputeEligible, type DiffFile } from './git-diff-precompute-scheduler'
import { promises as fsp } from 'fs'
import { join } from 'path'

import {
  buildCacheKey,
  parseCacheKey,
  createFetchFileContentWithCache,
  type ContentCacheFile,
  type FetchFileContentArgs,
  type FetchFileContentDeps
} from './git-diff-content-cache-state'
import { formatStatTokenForFingerprint } from './git-state-mirror-change-fingerprint'
import { gitIpcWorkerClient } from './git-ipc-worker-client'
import { gitDiffCacheInvalidator } from './git-diff-cache-invalidator'
import { performanceTrace } from './performance-trace'
import { PERF_TRACE_EVENT } from '../../src/utils/perf-trace-names'

// Re-export so existing callers (and tests) can import these names from the
// wiring module too. The single source of truth is `git-diff-content-cache-state`.
export { buildCacheKey, createFetchFileContentWithCache } from './git-diff-content-cache-state'
export type { ContentCacheFile, FetchFileContentArgs, FetchFileContentDeps } from './git-diff-content-cache-state'


type InvalidationReason =
  | 'watcher'
  | 'watcher-error'
  | 'force'
  | 'lru'
  | 'manual'
  | 'mirror'

const RECENT_INVALIDATION_REASON_TTL_MS = 5 * 60 * 1000

const recentProjectMissReasons = new Map<string, {
  reason: GitDiffContentCacheMissReason
  at: number
}>()

function mapInvalidationReason(reason: InvalidationReason | 'mutation'): GitDiffContentCacheMissReason {
  switch (reason) {
    case 'watcher':
    case 'watcher-error':
      return 'invalidated-watch'
    case 'mirror':
      return 'invalidated-mirror'
    case 'force':
    case 'manual':
      return 'invalidated-refresh'
    case 'lru':
      return 'project-queue-evicted'
    case 'mutation':
      return 'invalidated-mutation'
  }
}

function rememberProjectMissReason(project: string, reason: GitDiffContentCacheMissReason): void {
  recentProjectMissReasons.set(project, { reason, at: Date.now() })
}

function getRecentProjectMissReason(project: string): GitDiffContentCacheMissReason | null {
  const entry = recentProjectMissReasons.get(project)
  if (!entry) return null
  if (Date.now() - entry.at > RECENT_INVALIDATION_REASON_TTL_MS) {
    recentProjectMissReasons.delete(project)
    return null
  }
  return entry.reason
}

// Project-bucket ceiling. Default 24 — sized above a nested-submodule
// superproject's per-repoRoot bucket count (kar-qemu routes each of ~20
// submodules to its own bucket + the superproject) so a single Diff open no
// longer evicts its own submodule buckets mid-session. Overridable for stress
// or memory-constrained runs via env ONWARD_DIFF_CACHE_MAX_PROJECTS (read once
// at module load; see docs/debug-env-variables.md).
const DEFAULT_CONTENT_CACHE_MAX_PROJECTS = 24
function resolveContentCacheMaxProjects(): number {
  const raw = process.env.ONWARD_DIFF_CACHE_MAX_PROJECTS
  if (raw) {
    const parsed = Number.parseInt(raw, 10)
    if (Number.isFinite(parsed) && parsed >= 1 && parsed <= 256) {
      console.log(`[git-diff-content-cache] ONWARD_DIFF_CACHE_MAX_PROJECTS active: maxProjects=${parsed} (default ${DEFAULT_CONTENT_CACHE_MAX_PROJECTS})`)
      return parsed
    }
    console.warn(`[git-diff-content-cache] ignoring invalid ONWARD_DIFF_CACHE_MAX_PROJECTS=${JSON.stringify(raw)} (want integer 1..256)`)
  }
  return DEFAULT_CONTENT_CACHE_MAX_PROJECTS
}

export const gitDiffContentCache = new GitDiffContentCache<GitFileContentResult>({
  // Per-project budget as agreed in the design discussion. Smallest entries
  // evict first so the cache biases toward big files (whose first-click
  // latency is what users actually feel).
  projectByteLimit: 100 * 1024 * 1024,
  maxProjects: resolveContentCacheMaxProjects(),
  // Single-file cap matches the precompute scheduler's skip threshold so a
  // 50 MB lock file does not blow the bucket; it falls through to lazy load.
  singleFileByteLimit: 10 * 1024 * 1024
})

function estimateBytes(result: GitFileContentResult): number {
  // Sum the dominant string fields. UTF-16 byte underestimates non-ASCII
  // content but stays close enough for budget bookkeeping. Image data-URLs
  // count too since they dominate cache size for image-heavy projects.
  let total = 0
  total += result.originalContent?.length ?? 0
  total += result.modifiedContent?.length ?? 0
  total += result.originalImageUrl?.length ?? 0
  total += result.modifiedImageUrl?.length ?? 0
  return total
}

// Above this entry count, revalidation's synchronous re-stat loop is bounded
// out and we fall back to a whole-bucket wipe (keeps the main thread snappy on
// a pathological diff). Typical diffs are well under this.
const REVALIDATE_ENTRY_CAP = 1000

// changeType values whose cached diff content is determined by the WORKING-TREE
// file (so a worktree stat re-validates freshness). Index-backed (staged)
// content cannot be re-validated this way and is evicted conservatively.
function isWorktreeBackedChangeType(changeType: string): boolean {
  return changeType === 'unstaged' || changeType === 'untracked' || changeType === 'conflict'
}

async function computeWorktreeStaleToken(project: string, file: ContentCacheFile): Promise<string | undefined> {
  if (!isWorktreeBackedChangeType(file.changeType)) return undefined
  try {
    const st = await fsp.stat(join(project, file.filename), { bigint: true })
    return formatStatTokenForFingerprint(st)
  } catch {
    return undefined
  }
}

// Audit fix #1: the scoped revalidator pre-computes every cached file's fresh
// stat token through this (async fs.stat → libuv threadpool) BEFORE the
// synchronous eviction predicate, so the per-file re-stat no longer runs O(n) on
// the main thread — the EDR-throttled-Windows jank source the old inline
// statSync loop caused.
async function currentWorktreeStaleTokenAsync(absPath: string): Promise<string | undefined> {
  try {
    const st = await fsp.stat(absPath, { bigint: true })
    return formatStatTokenForFingerprint(st)
  } catch {
    return undefined
  }
}

function buildDefaultDeps(): FetchFileContentDeps<GitFileContentResult> {
  return {
    cache: gitDiffContentCache,
    computeStaleToken: computeWorktreeStaleToken,
    // The state module's ContentCacheFile has loose `status: string` so the
    // generic factory stays free of git-utils types. The IPC client's signature
    // pins status to `GitStatusCode`; we cast at this single boundary because
    // the runtime values are GitStatusCode-shaped (they originate from getDiff).
    fetchFromWorker: (cwd, file, repoRoot, options) => gitIpcWorkerClient.getFileContent(
      cwd,
      file as Pick<GitFileStatus, 'filename' | 'status' | 'originalFilename' | 'changeType' | 'isSubmoduleEntry'>,
      repoRoot,
      options
    ),
    schedulerPendingProjects: () => gitDiffPrecomputeScheduler.inspectStats().pendingProjects,
    schedulerInFlightProjects: () => gitDiffPrecomputeScheduler.inspectStats().inFlightProjects,
    recentMissReason: getRecentProjectMissReason,
    rememberMissReason: rememberProjectMissReason,
    estimateBytes,
    recordHit: ({ project, filename, changeType }) => {
      performanceTrace.record(PERF_TRACE_EVENT.MAIN_GIT_DIFF_CONTENT_CACHE_HIT, {
        project,
        filename,
        changeType,
        source: 'main-content-cache'
      })
    },
    recordMiss: ({ project, filename, changeType, reason, force }) => {
      performanceTrace.record(PERF_TRACE_EVENT.MAIN_GIT_DIFF_CONTENT_CACHE_MISS, {
        project,
        filename,
        changeType,
        reason,
        force
      })
    },
    recordSkipTooLarge: ({ project, filename, bytes }) => {
      performanceTrace.record(PERF_TRACE_EVENT.MAIN_GIT_DIFF_PRECOMPUTE_SKIP_TOO_LARGE, {
        project,
        filename,
        bytes,
        reason: 'single-file-cap'
      })
    },
    recordSkipStaleGeneration: ({ project, filename, changeType }) => {
      performanceTrace.record(PERF_TRACE_EVENT.MAIN_GIT_DIFF_CONTENT_CACHE_SKIP_STALE_GENERATION, {
        project,
        filename,
        changeType
      })
    },
    recordStatRevalidateStale: ({ project, filename, changeType }) => {
      performanceTrace.record(PERF_TRACE_EVENT.MAIN_GIT_DIFF_CONTENT_CACHE_STAT_REVALIDATE_STALE, {
        project,
        filename,
        changeType
      })
    }
  }
}

/**
 * Single canonical path for "give me this file's diff content". Used by
 * both the renderer-driven IPC handler and the background precompute
 * scheduler. Submodule entries get their own bucket via `repoRoot`; the
 * fallback is `cwd`.
 */
export const fetchFileContentWithCache = createFetchFileContentWithCache(buildDefaultDeps())

export const gitDiffPrecomputeScheduler = new GitDiffPrecomputeScheduler({
  // Click-latency autotest showed 1-2 files still cache-missed at click time
  // because the previous concurrency=3 / burst=50 left tail entries behind
  // even after the 800 ms autotest dwell. Bumping concurrency to 6 and the
  // burst cap to 100 keeps tail-end fetches racing with the user instead of
  // stalling them.
  concurrency: 6,
  debounceMs: 100,
  // Per-burst candidate cap, locked at 100 in the prewarm-cache design review.
  // This is NOT the memory bound — the content cache's per-project byte budget
  // (100 MB) + single-file cap (10 MB) bound actual memory; this caps how many
  // files ONE prewarm burst enqueues so a pathological diff (thousands of
  // files) cannot flood the low-priority lane in a single pass and starve the
  // disk for the foreground repo. Viewport-priority ordering puts the
  // most-likely-first-clicked files at the head of each burst, so the visible
  // working set still warms first; the long tail fills in across subsequent
  // bursts (re-scheduled on invalidation) or lazily on click.
  maxCandidatesPerBurst: 100,
  isEligible: isPrecomputeEligible,
  loadWorkingSet: async (project) => {
    // Background prewarm: run in the low-priority `::diff-precompute` lane so
    // this never blocks a foreground enter for the same repo. Do NOT pass
    // `force` — the invalidator already cleared the request cache before
    // scheduling this burst, so a non-forced read recomputes a fresh list AND
    // stores it (warming the cache). Forcing here would re-invalidate the very
    // cache we are trying to warm and would hold the foreground lane.
    const result = await gitIpcWorkerClient.getDiff(project, { scope: 'full', background: true })
    if (!result || !result.success) return []
    // Map every field the scheduler / fetch path reads. Crucially,
    // `originalFilename` MUST be propagated for renames and copies — the
    // renderer-click path passes the same value through, and if the
    // scheduler-prewarm key omits it the two paths build different cache
    // keys and prewarmed entries never hit on click.
    return result.files.map<DiffFile>((file) => ({
      filename: file.filename,
      additions: file.additions,
      deletions: file.deletions,
      changeType: file.changeType,
      status: file.status,
      originalFilename: file.originalFilename,
      isSubmoduleEntry: file.isSubmoduleEntry,
      repoRoot: file.repoRoot
    }))
  },
  fetchFile: async (project, file) => {
    // The scheduler hands us a `DiffFile` shape; we need the real
    // GitFileStatus subset for the cache key. The `repoRoot` argument lives
    // on the original list entry — propagate it when present so submodules
    // route to their own bucket. originalFilename comes from `getDiff` for
    // renames / copies; pass it through unchanged so the cache key matches
    // what the renderer-driven click path will build.
    const repoRoot = file.repoRoot ?? project
    const cwd = repoRoot
    const cacheFile: ContentCacheFile = {
      filename: file.filename,
      status: file.status,
      originalFilename: file.originalFilename,
      changeType: file.changeType,
      isSubmoduleEntry: file.isSubmoduleEntry
    }
    await fetchFileContentWithCache({
      cwd,
      file: cacheFile,
      repoRoot,
      // Background prewarm runs at LOW git-runtime priority so a foreground
      // file click (which defaults to 'high' in getGitFileContent) always
      // preempts the precompute burst instead of queuing behind it.
      options: { missReason: 'precompute-pending', priority: 'low' }
    })
  }
})

let invalidatorInstalled = false

/**
 * Install the once-per-process listener that links the GitStateMirror-backed
 * invalidator to our content cache and scheduler. Idempotent —
 * subsequent calls are no-ops so test harnesses can call freely.
 */
export function installContentCacheInvalidatorOnce(): void {
  if (invalidatorInstalled) return
  invalidatorInstalled = true
  gitDiffCacheInvalidator.addListener((cwd, reason) => {
    if (reason === 'lru') {
      // Project was evicted from the watcher — drop the bucket too so we do
      // not keep a stale snapshot for a project we no longer track.
      invalidateContentCacheForProject(cwd, 'project-queue-evicted', { schedulePrecompute: false })
      return
    }
    if (reason === 'mirror') {
      // FS-watcher-driven churn: re-validate per file instead of wiping the
      // whole bucket, so an unrelated file changing (e.g. a background tool
      // rewriting one source file) does NOT evict every other file's content.
      // This is the fix for the kar-qemu content-cache thrash (one file's churn
      // forced a full-list re-fetch every ~20-80s → 160 misses / 6× re-reads).
      void revalidateContentCacheForProject(cwd, mapInvalidationReason(reason))
      return
    }
    // Force / mutation / other reasons keep the conservative whole-bucket wipe.
    invalidateContentCacheForProject(cwd, mapInvalidationReason(reason))
  })
}

/**
 * Scoped content-cache invalidation for FS-watcher (`mirror`) churn. Re-stats
 * each cached file's working-tree path and evicts ONLY the entries whose file
 * actually changed since it was cached; unchanged files stay warm. Index-backed
 * (staged) entries and entries with no captured token are evicted
 * conservatively. Falls back to a whole-bucket wipe above REVALIDATE_ENTRY_CAP.
 */
export async function revalidateContentCacheForProject(
  project: string | undefined | null,
  reason: GitDiffContentCacheMissReason
): Promise<void> {
  if (!project) return
  rememberProjectMissReason(project, reason)
  if (gitDiffContentCache.getProjectEntryCount(project) > REVALIDATE_ENTRY_CAP) {
    const dropped = gitDiffContentCache.invalidateProject(project)
    if (dropped > 0) {
      performanceTrace.record(PERF_TRACE_EVENT.MAIN_GIT_DIFF_CONTENT_CACHE_INVALIDATE_PROJECT, {
        project, reason, droppedEntries: dropped, scoped: false
      })
    }
    gitDiffPrecomputeScheduler.onProjectInvalidated(project)
    return
  }
  // Audit fix #1: pre-compute each worktree-backed entry's fresh stat token via
  // async fs.stat (libuv threadpool) so the per-file re-stat never blocks the
  // main thread O(n) on EDR-throttled Windows; the synchronous predicate below
  // then only compares against this pre-built map (no I/O on the main thread).
  const freshTokens = new Map<string, string | undefined>()
  await Promise.all(gitDiffContentCache.getProjectKeys(project).map(async (key) => {
    const { changeType, filename } = parseCacheKey(key)
    if (!isWorktreeBackedChangeType(changeType)) return
    freshTokens.set(key, await currentWorktreeStaleTokenAsync(join(project, filename)))
  }))
  const { kept, evicted } = gitDiffContentCache.revalidateProject(project, (key, staleToken) => {
    const { changeType } = parseCacheKey(key)
    if (!isWorktreeBackedChangeType(changeType)) return true // index-backed → can't worktree-validate
    if (!freshTokens.has(key)) return false // entry added after the async snapshot → freshly fetched, keep
    if (staleToken === undefined) return true // no token captured → conservative evict
    const current = freshTokens.get(key)
    if (current === undefined) return true // file gone/unreadable → evict
    return current !== staleToken // stat changed → stale → evict
  })
  if (evicted > 0) {
    performanceTrace.record(PERF_TRACE_EVENT.MAIN_GIT_DIFF_CONTENT_CACHE_INVALIDATE_PROJECT, {
      project, reason, droppedEntries: evicted, keptEntries: kept, scoped: true
    })
    // Re-warm the evicted files in the background (kept files are still cached).
    gitDiffPrecomputeScheduler.onProjectInvalidated(project)
  }
}

export function invalidateContentCacheForProject(
  project: string | undefined | null,
  reason: GitDiffContentCacheMissReason,
  options: { schedulePrecompute?: boolean } = {}
): void {
  if (!project) return
  rememberProjectMissReason(project, reason)
  const dropped = gitDiffContentCache.invalidateProject(project)
  if (reason === 'project-queue-evicted') {
    gitDiffPrecomputeScheduler.cancelProject(project)
    performanceTrace.record(PERF_TRACE_EVENT.MAIN_GIT_DIFF_CONTENT_CACHE_INVALIDATE_LRU, {
      project,
      reason
    })
    return
  }
  if (dropped > 0) {
    performanceTrace.record(PERF_TRACE_EVENT.MAIN_GIT_DIFF_CONTENT_CACHE_INVALIDATE_PROJECT, {
      project,
      reason,
      droppedEntries: dropped
    })
  }
  if (options.schedulePrecompute !== false) {
    gitDiffPrecomputeScheduler.onProjectInvalidated(project)
  }
}

export async function inspectContentCacheStats() {
  // List cache lives in the git-ipc worker (that is where getGitDiff runs),
  // so we have to ask the worker for the real counters. If the worker is
  // unavailable, fall back to the main-process controller stats — they are
  // usually empty, but at least keep the panel rendering.
  let listCache: GitDiffRequestCacheStats
  try {
    listCache = await gitIpcWorkerClient.inspectListCacheStats()
  } catch {
    listCache = getGitDiffRequestCacheStats()
  }
  return {
    cache: gitDiffContentCache.inspectStats(),
    scheduler: gitDiffPrecomputeScheduler.inspectStats(),
    listCache,
    watcher: gitDiffCacheInvalidator.inspectHealth()
  }
}
