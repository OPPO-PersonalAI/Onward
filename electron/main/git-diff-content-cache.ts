/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

// Per-project Git diff content cache.
//
// What this caches: the body of `getFileContent` (originalContent +
// modifiedContent + binary/image flags) that the diff viewer needs to render
// any given file. NOT the diff list itself — that already lives behind
// `GitDiffRequestCacheController`.
//
// Why a new cache: the renderer used to drive a 4-file prefetch loop on its
// own. That hit a cliff the moment you clicked file #5. Moving the cache to
// main lets every renderer (multiple tabs / tasks pointing at the same
// project) share one warm bucket, and lets a precompute scheduler eagerly
// populate it for the entire working set.
//
// Eviction model:
//   1. Per-project byte budget (default 100 MB). Smallest entries evict
//      first — large files dominate first-click latency, so we bias the
//      cache toward keeping them resident.
//   2. Per-instance project budget (default 24 projects). Project buckets
//      are kept in a recent-access queue. Any get/put moves that project
//      to the front; when the 25th project appears, the tail bucket is
//      dropped. 24 is sized above a nested-submodule superproject's bucket
//      count (kar-qemu routes each of ~20 submodules to its own repoRoot
//      bucket + the superproject), so a single Diff open no longer thrashes
//      its own submodule buckets out of the cache between clicks. Override
//      with env ONWARD_DIFF_CACHE_MAX_PROJECTS.
//   3. HEAD-change / project-wide invalidation: callers that detect a
//      commit / checkout / external mutation invoke
//      `invalidateProject(project)` to wipe the bucket.

export interface GitDiffContentCacheOptions {
  /** Per-project byte budget. Default 100 MB. */
  projectByteLimit?: number
  /** Maximum number of project buckets retained simultaneously. Default 24. */
  maxProjects?: number
  /** Single-file hard cap. Entries larger than this are not stored. Default 10 MB. */
  singleFileByteLimit?: number
}

export interface GitDiffContentCacheEntry<T> {
  value: T
  bytes: number
  /** Monotonic access order, used only as a deterministic tie-breaker. */
  touchOrder: number
  /**
   * Opaque freshness token captured when the entry was stored (the file's
   * working-tree stat token for unstaged/untracked diffs, or undefined when not
   * computable — e.g. index-backed staged content). Used by
   * `revalidateProject` to evict ONLY entries whose underlying file actually
   * changed, instead of wiping the whole bucket on every mirror-update.
   */
  staleToken?: string
}

export interface GitDiffContentCacheStats {
  projects: Array<{
    project: string
    bytes: number
    entries: number
    entryDetails: Array<{
      key: string
      bytes: number
    }>
  }>
  totalBytes: number
  totalEntries: number
  projectByteLimit: number
  maxProjects: number
  singleFileByteLimit: number
}

export type GitDiffContentCacheGeneration = string

interface ProjectBucket<T> {
  project: string
  entries: Map<string, GitDiffContentCacheEntry<T>>
  bytes: number
}

const DEFAULT_PROJECT_BYTE_LIMIT = 100 * 1024 * 1024
// 24: sized above a nested-submodule superproject's per-repoRoot bucket count
// (kar-qemu ≈ 20 submodule buckets + the superproject) so one Diff open does
// not evict its own submodule buckets mid-session. See the eviction-model note
// at the top of this file. Override with env ONWARD_DIFF_CACHE_MAX_PROJECTS.
const DEFAULT_MAX_PROJECTS = 24
const DEFAULT_SINGLE_FILE_BYTE_LIMIT = 10 * 1024 * 1024

export class GitDiffContentCache<T> {
  private readonly projects = new Map<string, ProjectBucket<T>>()
  private readonly projectQueue: string[] = []
  private readonly projectByteLimit: number
  private readonly maxProjects: number
  private readonly singleFileByteLimit: number
  private readonly recentProjectQueueEvictions = new Map<string, number>()
  private readonly projectGenerations = new Map<string, number>()
  private globalGeneration = 0
  private touchCounter = 0

  constructor(options: GitDiffContentCacheOptions = {}) {
    this.projectByteLimit = options.projectByteLimit ?? DEFAULT_PROJECT_BYTE_LIMIT
    this.maxProjects = options.maxProjects ?? DEFAULT_MAX_PROJECTS
    this.singleFileByteLimit = options.singleFileByteLimit ?? DEFAULT_SINGLE_FILE_BYTE_LIMIT
  }

  get(project: string, key: string): T | null {
    const bucket = this.projects.get(project)
    if (!bucket) return null
    const entry = bucket.entries.get(key)
    if (!entry) return null
    entry.touchOrder = this.nextTouchOrder()
    this.moveProjectToFront(project)
    return entry.value
  }

  /**
   * Like {@link get}, but also returns the stored freshness token so a read-path
   * stat-revalidation can compare it against the current working-tree stat before
   * serving the cached body. Same LRU bookkeeping as `get` (touch + move-to-front).
   */
  getEntry(project: string, key: string): { value: T; staleToken: string | undefined } | null {
    const bucket = this.projects.get(project)
    if (!bucket) return null
    const entry = bucket.entries.get(key)
    if (!entry) return null
    entry.touchOrder = this.nextTouchOrder()
    this.moveProjectToFront(project)
    return { value: entry.value, staleToken: entry.staleToken }
  }

  getProjectGeneration(project: string): GitDiffContentCacheGeneration {
    return `${this.globalGeneration}:${this.projectGenerations.get(project) ?? 0}`
  }

  isProjectGenerationCurrent(project: string, generation: GitDiffContentCacheGeneration): boolean {
    return this.getProjectGeneration(project) === generation
  }

  /**
   * Store a value under the given project / key. Returns `false` when the
   * entry exceeds the single-file cap (caller should still render it, just
   * skip caching). Returns `true` when stored — the caller does not need to
   * worry about eviction; this method does that internally.
   */
  put(project: string, key: string, value: T, bytes: number, staleToken?: string): boolean {
    if (!Number.isFinite(bytes) || bytes < 0) return false
    if (bytes > this.singleFileByteLimit) return false
    if (bytes > this.projectByteLimit) return false

    let bucket = this.projects.get(project)
    if (!bucket) {
      bucket = { project, entries: new Map(), bytes: 0 }
      this.projects.set(project, bucket)
    }
    this.moveProjectToFront(project)

    const previous = bucket.entries.get(key)
    if (previous) bucket.bytes -= previous.bytes
    bucket.entries.set(key, { value, bytes, touchOrder: this.nextTouchOrder(), staleToken })
    bucket.bytes += bytes

    this.evictWithinProjectIfOverLimit(bucket)
    this.evictProjectsIfOverLimit()
    return true
  }

  /** O(1) count of cached entries for a project (0 when absent). */
  getProjectEntryCount(project: string): number {
    return this.projects.get(project)?.entries.size ?? 0
  }

  /**
   * Snapshot of the cache keys currently resident in a project bucket. Used by
   * the scoped revalidator to pre-compute each file's fresh stat token OFF the
   * main thread (async `fs.stat`) BEFORE calling the synchronous
   * `revalidateProject` predicate — so the per-file re-stat no longer blocks the
   * main thread O(n) on EDR-throttled hosts.
   */
  getProjectKeys(project: string): string[] {
    const bucket = this.projects.get(project)
    return bucket ? [...bucket.entries.keys()] : []
  }

  /** Drops a single entry. Returns true when something was actually removed. */
  invalidateEntry(project: string, key: string): boolean {
    const bucket = this.projects.get(project)
    if (!bucket) return false
    const entry = bucket.entries.get(key)
    if (!entry) return false
    bucket.entries.delete(key)
    bucket.bytes -= entry.bytes
    if (bucket.entries.size === 0) {
      this.deleteProject(project)
    } else {
      this.bumpProjectGeneration(project)
    }
    return true
  }

  /**
   * Scoped invalidation: evict ONLY the entries the caller deems stale, keeping
   * the rest warm. `isStale(key, staleToken)` is invoked per entry (the caller
   * does the freshness check — e.g. re-stat the working-tree file and compare to
   * the stored token). Bumps the project generation once if anything was
   * evicted (so in-flight fetches of evicted files don't store stale results),
   * and deletes the bucket if it ends up empty. Returns kept / evicted counts.
   *
   * This is the resilient alternative to `invalidateProject` for mirror-update
   * churn: when one file changes, only that file's content is dropped, so a
   * click on any other file still hits the cache.
   */
  revalidateProject(
    project: string,
    isStale: (key: string, staleToken: string | undefined) => boolean
  ): { kept: number; evicted: number } {
    const bucket = this.projects.get(project)
    if (!bucket) return { kept: 0, evicted: 0 }
    let kept = 0
    let evicted = 0
    for (const [key, entry] of [...bucket.entries]) {
      if (isStale(key, entry.staleToken)) {
        bucket.entries.delete(key)
        bucket.bytes -= entry.bytes
        evicted += 1
      } else {
        kept += 1
      }
    }
    if (evicted > 0) {
      if (bucket.entries.size === 0) {
        this.deleteProject(project)
      } else {
        this.bumpProjectGeneration(project)
      }
    }
    return { kept, evicted }
  }

  /** Drops every entry for the given project. Returns count of dropped entries. */
  invalidateProject(project: string): number {
    const bucket = this.projects.get(project)
    if (!bucket) {
      this.bumpProjectGeneration(project)
      return 0
    }
    const dropped = bucket.entries.size
    this.deleteProject(project)
    return dropped
  }

  /** Drops everything. Returns count of dropped entries. */
  invalidateAll(): number {
    let dropped = 0
    for (const bucket of this.projects.values()) dropped += bucket.entries.size
    this.projects.clear()
    this.projectQueue.length = 0
    this.projectGenerations.clear()
    this.globalGeneration += 1
    return dropped
  }

  inspectStats(): GitDiffContentCacheStats {
    const projects: GitDiffContentCacheStats['projects'] = []
    let totalBytes = 0
    let totalEntries = 0
    for (const project of this.projectQueue) {
      const bucket = this.projects.get(project)
      if (!bucket) continue
      projects.push({
        project: bucket.project,
        bytes: bucket.bytes,
        entries: bucket.entries.size,
        entryDetails: [...bucket.entries.entries()]
          .map(([key, entry]) => ({ key, bytes: entry.bytes }))
          .sort((a, b) => b.bytes - a.bytes)
      })
      totalBytes += bucket.bytes
      totalEntries += bucket.entries.size
    }
    return {
      projects,
      totalBytes,
      totalEntries,
      projectByteLimit: this.projectByteLimit,
      maxProjects: this.maxProjects,
      singleFileByteLimit: this.singleFileByteLimit
    }
  }

  hasProject(project: string): boolean {
    return this.projects.has(project)
  }

  consumeRecentProjectQueueEviction(project: string, maxAgeMs = 5 * 60 * 1000): boolean {
    const evictedAt = this.recentProjectQueueEvictions.get(project)
    if (typeof evictedAt !== 'number') return false
    this.recentProjectQueueEvictions.delete(project)
    return Date.now() - evictedAt <= maxAgeMs
  }

  // --- private ---

  private evictWithinProjectIfOverLimit(bucket: ProjectBucket<T>): void {
    if (bucket.bytes <= this.projectByteLimit) return
    // Smallest-first eviction: drop tiny entries before large ones, on the
    // theory that re-fetching a 1 KB file is fast enough to absorb a cache
    // miss, while re-fetching a 5 MB file is what the user actually feels.
    // Tie-break by oldest access order so two entries of equal size evict
    // the less recently used one first.
    const sorted = [...bucket.entries.entries()].sort((a, b) => {
      const sizeDelta = a[1].bytes - b[1].bytes
      if (sizeDelta !== 0) return sizeDelta
      return a[1].touchOrder - b[1].touchOrder
    })
    let evictedAny = false
    for (const [key, entry] of sorted) {
      if (bucket.bytes <= this.projectByteLimit) break
      bucket.entries.delete(key)
      bucket.bytes -= entry.bytes
      evictedAny = true
    }
    if (bucket.entries.size === 0) {
      this.deleteProject(bucket.project)
    } else if (evictedAny) {
      this.bumpProjectGeneration(bucket.project)
    }
  }

  private evictProjectsIfOverLimit(): void {
    while (this.projectQueue.length > this.maxProjects) {
      const victim = this.projectQueue.pop()
      if (!victim) return
      this.deleteProject(victim)
      this.recentProjectQueueEvictions.set(victim, Date.now())
    }
  }

  private moveProjectToFront(project: string): void {
    const existingIndex = this.projectQueue.indexOf(project)
    if (existingIndex >= 0) this.projectQueue.splice(existingIndex, 1)
    this.projectQueue.unshift(project)
  }

  private deleteProject(project: string): void {
    this.projects.delete(project)
    const existingIndex = this.projectQueue.indexOf(project)
    if (existingIndex >= 0) this.projectQueue.splice(existingIndex, 1)
    this.bumpProjectGeneration(project)
  }

  private bumpProjectGeneration(project: string): void {
    this.projectGenerations.set(project, (this.projectGenerations.get(project) ?? 0) + 1)
  }

  private nextTouchOrder(): number {
    this.touchCounter += 1
    return this.touchCounter
  }
}
