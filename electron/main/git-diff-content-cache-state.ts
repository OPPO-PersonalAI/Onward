/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

// Pure cache-state logic for the per-file Git Diff content cache. Kept as a
// LEAF module (no transitive `electron`, `git-utils`, IPC, or scheduler
// dependencies) so the cache-classification chain can be exercised by Node
// unit tests without spinning up the worker or the main-process singletons.
//
// The production wiring (`git-diff-content-cache-wiring.ts`) imports the
// factory below and binds it to the real cache + worker + scheduler, while
// tests bind it to mocks. The two paths share this exact same state machine.

import type { GitDiffContentCache } from './git-diff-content-cache'

export type GitDiffContentCacheMissReason =
  | 'first-load'
  | 'invalidated-mutation'
  | 'invalidated-watch'
  | 'invalidated-mirror'
  | 'invalidated-refresh'
  // Read-path stat revalidation proved the working-tree file changed since it was
  // cached (the watcher/mirror never fired for it) -> drop the hit and re-fetch.
  | 'invalidated-stat-revalidate'
  | 'renderer-force-refresh'
  | 'project-queue-evicted'
  | 'single-file-too-large'
  | 'precompute-pending'
  | 'entry-not-warmed'
  | 'worker-error'

export type GitDiffContentCacheSource =
  | 'renderer-memory'
  | 'main-content-cache'
  | 'worker-rebuild'

export interface GitDiffContentCacheInfo {
  state: 'hit' | 'miss'
  source: GitDiffContentCacheSource
  missReason?: GitDiffContentCacheMissReason
  project?: string
  key?: string
  stored?: boolean
  bytes?: number
}

export interface GitFileContentRequestOptions {
  force?: boolean
  missReason?: GitDiffContentCacheMissReason
  allowLargeFile?: boolean
  /**
   * Git-runtime scheduling priority for the content-fetch spawns. Foreground
   * clicks omit this (treated as 'high' by `getGitFileContent`) so they
   * preempt the background precompute, which sets 'low'.
   */
  priority?: 'high' | 'normal' | 'low'
}

/**
 * Subset of `GitFileStatus` that the cache-key path actually reads. Defined
 * here as a structural shape so this module stays free of `git-utils`.
 */
export interface ContentCacheFile {
  filename: string
  status: string
  /** Set for renames (status === 'R') and copies (status === 'C'); empty otherwise. */
  originalFilename?: string
  changeType: string
  isSubmoduleEntry?: boolean
}

/**
 * Minimal fetch-result shape the state machine needs. Real callers pass the
 * full `GitFileContentResult`; the generic `T` lets tests pass simpler shapes.
 */
export interface CacheableFetchResult {
  success: boolean
  cacheInfo?: GitDiffContentCacheInfo
}

/**
 * Build the per-file cache key used by both the scheduler-side prewarm and
 * the renderer-driven click path. **MUST** be deterministic and **MUST**
 * produce the same key for the same logical file regardless of which path
 * called it — otherwise a prewarmed entry will not be reused on click.
 */
export function buildCacheKey(file: ContentCacheFile): string {
  // changeType + status disambiguate the same path's working-tree-vs-index
  // vs index-vs-HEAD vs untracked variants. originalFilename is part of the
  // key for renames so a rename's two ends do not collide.
  return `${file.changeType}::${file.status}::${file.originalFilename ?? ''}::${file.filename}`
}

/**
 * Inverse of {@link buildCacheKey}. The filename is the 4th `::` segment;
 * rejoined defensively in case a path itself contained `::` (rare). Used by the
 * content-cache revalidation path to recover the changeType + filename for a
 * cached entry so it can re-stat the working-tree file.
 */
export function parseCacheKey(key: string): {
  changeType: string
  status: string
  originalFilename: string
  filename: string
} {
  const parts = key.split('::')
  return {
    changeType: parts[0] ?? '',
    status: parts[1] ?? '',
    originalFilename: parts[2] ?? '',
    filename: parts.slice(3).join('::')
  }
}

/**
 * True when a cache key belongs to one of the given repo-relative paths —
 * matches the entry's filename or, for renames, its original filename, across
 * every changeType/status variant of the path. Drives the file-scoped
 * eviction after a known single-file mutation (2026-07-16 revert-scope fix):
 * evict exactly these, keep everything else warm.
 */
export function cacheKeyMatchesFiles(key: string, files: ReadonlySet<string>): boolean {
  const { filename, originalFilename } = parseCacheKey(key)
  return files.has(filename) || (originalFilename !== '' && files.has(originalFilename))
}

/**
 * Read-path freshness decision for a content-cache HIT (VS Code / GitLens model:
 * validate the working-tree side on read instead of trusting a path-only key +
 * a watcher that can miss an edit). `storedToken` is the working-tree stat token
 * captured when the entry was cached; `currentToken` is a fresh stat taken now.
 *
 * Returns `'stale'` ONLY when we can positively prove the file changed — both
 * tokens present and different. Everything else is `'fresh'` (serve the hit):
 *   - `storedToken === undefined`  → index-backed/staged content (no worktree
 *     token) or uncomputable at store time; its freshness rides the
 *     index-generation / mirror path, not this check.
 *   - `currentToken === undefined` → transient stat error (e.g. the atomic-save
 *     temp→rename window on Windows) or a deleted file; do not punish the hit —
 *     a real delete is a status change the mirror catches, and the next
 *     successful stat catches a completed edit.
 *
 * Conservative-on-read by design: never evict an unvalidatable hit (preserves
 * the "opens feel instant" latency), only re-fetch on a proven change (closes
 * the stale window even when the watcher missed the event).
 */
export function decideContentCacheReadFreshness(
  storedToken: string | undefined,
  currentToken: string | undefined
): 'fresh' | 'stale' {
  if (storedToken === undefined || currentToken === undefined) return 'fresh'
  return storedToken === currentToken ? 'fresh' : 'stale'
}

export interface FetchFileContentArgs {
  cwd: string
  file: ContentCacheFile
  repoRoot?: string
  options?: GitFileContentRequestOptions
}

export interface FetchFileContentDeps<T extends CacheableFetchResult> {
  cache: GitDiffContentCache<T>
  fetchFromWorker: (cwd: string, file: ContentCacheFile, repoRoot?: string, options?: GitFileContentRequestOptions) => Promise<T>
  schedulerPendingProjects: () => string[]
  schedulerInFlightProjects: () => string[]
  recentMissReason: (project: string) => GitDiffContentCacheMissReason | null
  rememberMissReason: (project: string, reason: GitDiffContentCacheMissReason) => void
  estimateBytes: (result: T) => number
  /**
   * Compute the file's freshness token stored with the cached entry (working-
   * tree stat for unstaged/untracked/conflict; undefined for index-backed
   * staged content, which `revalidateProject` then treats as always-stale).
   * Injected so this module stays fs-free and unit-testable.
   */
  computeStaleToken?: (project: string, file: ContentCacheFile) => Promise<string | undefined>
  recordHit?: (info: { project: string; filename: string; changeType: string }) => void
  recordMiss?: (info: { project: string; filename: string; changeType: string; reason: GitDiffContentCacheMissReason; force: boolean }) => void
  recordSkipTooLarge?: (info: { project: string; filename: string; bytes: number }) => void
  recordSkipStaleGeneration?: (info: { project: string; filename: string; changeType: string }) => void
  /**
   * Emitted when a content-cache HIT is dropped by the read-path stat
   * revalidation because the working-tree file's stat token no longer matches the
   * token captured at store time (i.e. the file changed since it was cached, even
   * though no watcher/mirror invalidation fired). Injected so this module stays
   * fs-free and unit-testable.
   */
  recordStatRevalidateStale?: (info: { project: string; filename: string; changeType: string }) => void
}

function withCacheInfo<T extends CacheableFetchResult>(result: T, info: GitDiffContentCacheInfo): T {
  return { ...result, cacheInfo: info }
}

function withoutCacheInfo<T extends CacheableFetchResult>(result: T): T {
  const rest = { ...result }
  delete rest.cacheInfo
  return rest
}

function resolveMissReason<T extends CacheableFetchResult>(
  project: string,
  hadProjectBeforeLookup: boolean,
  explicitReason: GitDiffContentCacheMissReason | undefined,
  deps: FetchFileContentDeps<T>
): GitDiffContentCacheMissReason {
  if (explicitReason) return explicitReason
  const recentReason = deps.recentMissReason(project)
  if (recentReason) return recentReason
  if (deps.cache.consumeRecentProjectQueueEviction(project)) return 'project-queue-evicted'
  if (
    deps.schedulerPendingProjects().includes(project) ||
    deps.schedulerInFlightProjects().includes(project)
  ) {
    return 'precompute-pending'
  }
  return hadProjectBeforeLookup ? 'entry-not-warmed' : 'first-load'
}

/**
 * Factory: returns a `fetchFileContentWithCache` bound to the given deps.
 * The production binding wraps the module singletons; tests pass a fresh
 * `GitDiffContentCache<T>` and a mock worker so each scenario starts from a
 * clean slate.
 *
 * Branch matrix (every branch is exercised by the wiring unit-test suite):
 *
 *   force=false ∧ cache.get → entry  → state='hit'  source='main-content-cache'
 *   force=false ∧ cache.get → null   → fall through to worker
 *   force=true                       → fall through to worker, missReason from caller
 *   worker.success=false             → state='miss'  missReason='worker-error'  NOT cached
 *   worker.success=true ∧ stored=true→ state='miss'  missReason=resolved        cached
   *   worker.success=true ∧ stored=false (single-file-too-large)
   *                                    → state='miss'  missReason='single-file-too-large'  NOT cached
   *   worker.success=true ∧ generation changed during fetch
   *                                    → state='miss'  missReason=resolved  NOT cached
 *
 * Miss-reason resolution order:
 *   1. caller-provided `options.missReason` wins (renderer force-refresh,
 *      mutation invalidation, etc.)
 *   2. recent-invalidation reason from `deps.recentMissReason` (set by
 *      `gitDiffCacheInvalidator` listener via `rememberMissReason`)
 *   3. project-queue-evicted flag from the cache (consumed once)
 *   4. scheduler pending / in-flight → 'precompute-pending'
 *   5. project bucket existed → 'entry-not-warmed', else → 'first-load'
 */
export function createFetchFileContentWithCache<T extends CacheableFetchResult>(deps: FetchFileContentDeps<T>) {
  return async function fetchFileContentWithCacheImpl(args: FetchFileContentArgs): Promise<T> {
    const project = args.repoRoot ?? args.cwd
    const key = buildCacheKey(args.file)
    const force = Boolean(args.options?.force)
    const hadProjectBeforeLookup = deps.cache.hasProject(project)
    const generationAtFetchStart = deps.cache.getProjectGeneration(project)

    let readRevalidateStale = false
    // Freshness token for the entry we may store below. MUST witness the
    // working-tree state at/before the worker READ, never after: capturing it
    // post-fetch let an external edit land between the worker's read and the
    // stat, storing OLD content under the NEW token — an entry the read-path
    // revalidation then validated as fresh forever (the 2026-07-12 bundle's
    // "stale diff until manual refresh"; unit-pinned by the wiring test's
    // "REPRO TOCTOU" case). The inverse race (edit between this stat and the
    // worker read) stores NEW content under the OLD token, which merely costs
    // one conservative refetch on the next read — never a stale serve.
    let preFetchStaleToken: string | undefined
    const cachedEntry = force ? null : deps.cache.getEntry(project, key)
    if (cachedEntry) {
      // Stat-validate the working-tree side ON READ (not only on a watcher/mirror
      // invalidation). The cache key is path-only, so a same-status re-edit maps to
      // the SAME key; the FS-watcher is the only automatic invalidation and it can
      // MISS an edit (dropped/coalesced under Windows EDR, or degraded worker
      // health). Re-stat the file now and compare to the token captured at store
      // time — using the SAME computeStaleToken fn as the store path, so the tokens
      // are comparable by construction. fs.stat is async (libuv threadpool) and
      // spawns no process, so an UNCHANGED file still hits in ~sub-ms (no RC-2
      // prewarm wipe, no git spawn); a CHANGED file is caught even when the watcher
      // never fired. Staged/index-backed content has no worktree token
      // (computeStaleToken -> undefined) and is served as-is (VS Code / GitLens
      // ref-tiering: only the working-tree side is validated on read).
      let currentToken: string | undefined
      try {
        currentToken = deps.computeStaleToken ? await deps.computeStaleToken(project, args.file) : undefined
      } catch {
        currentToken = undefined
      }
      // Reuse as the pre-fetch token when this hit proves stale below: it was
      // captured before any worker read, which is exactly the store contract.
      preFetchStaleToken = currentToken
      if (decideContentCacheReadFreshness(cachedEntry.staleToken, currentToken) === 'fresh') {
        deps.recordHit?.({
          project,
          filename: args.file.filename,
          changeType: args.file.changeType
        })
        return withCacheInfo(cachedEntry.value, {
          state: 'hit',
          source: 'main-content-cache',
          project,
          key
        })
      }
      // Proven stale: fall through to a fresh worker re-fetch below, whose put()
      // overwrites this entry (and its staleToken) in place. Do NOT invalidateEntry
      // here — that bumps the project generation, which would make the re-fetch's
      // store be skipped (isProjectGenerationCurrent === false), serving the fresh
      // body but never caching it. put() already replaces the same key.
      readRevalidateStale = true
      deps.recordStatRevalidateStale?.({
        project,
        filename: args.file.filename,
        changeType: args.file.changeType
      })
    }

    const missReason = readRevalidateStale
      ? 'invalidated-stat-revalidate'
      : resolveMissReason(project, hadProjectBeforeLookup, args.options?.missReason, deps)
    deps.recordMiss?.({
      project,
      filename: args.file.filename,
      changeType: args.file.changeType,
      reason: missReason,
      force
    })
    // No cached entry (first load / force) → the pre-fetch token was not
    // captured above; take it NOW, before the worker read (see the TOCTOU
    // comment at the top of this function).
    if (!cachedEntry) {
      try {
        preFetchStaleToken = deps.computeStaleToken ? await deps.computeStaleToken(project, args.file) : undefined
      } catch {
        preFetchStaleToken = undefined
      }
    }
    const result = await deps.fetchFromWorker(args.cwd, args.file, args.repoRoot, args.options)
    let stored = false
    let bytes = 0
    let finalMissReason: GitDiffContentCacheMissReason = result.success ? missReason : 'worker-error'
    if (result.success) {
      bytes = deps.estimateBytes(result)
      // Store under the PRE-fetch freshness token (captured before the worker
      // read — see the TOCTOU comment above) so a later mirror-update or
      // read-path revalidation compares against the state the cached body was
      // actually read from.
      if (deps.cache.isProjectGenerationCurrent(project, generationAtFetchStart)) {
        stored = deps.cache.put(project, key, withoutCacheInfo(result), bytes, preFetchStaleToken)
      } else {
        deps.recordSkipStaleGeneration?.({
          project,
          filename: args.file.filename,
          changeType: args.file.changeType
        })
      }
      if (
        !stored &&
        bytes > 0 &&
        deps.cache.isProjectGenerationCurrent(project, generationAtFetchStart)
      ) {
        finalMissReason = 'single-file-too-large'
        deps.recordSkipTooLarge?.({
          project,
          filename: args.file.filename,
          bytes
        })
      }
    }
    return withCacheInfo(result, {
      state: 'miss',
      source: 'worker-rebuild',
      missReason: finalMissReason,
      project,
      key,
      stored,
      bytes
    })
  }
}
