/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

import { normalizeProjectCwd } from '../../../utils/pathNormalize.ts'
import { FILE_INDEX_MAX_CACHED_PROJECTS } from '../../../utils/file-index-constants.ts'

/**
 * Renderer-side METADATA mirror of the project file index.
 *
 * This module deliberately does NOT hold the file list. The authoritative index
 * lives in the main-process `project-fs-worker`, which is what every Cmd+P and
 * sidebar result is served from. This mirror exists only to answer three
 * questions the UI needs synchronously:
 *
 *   - is an index being built right now (drives the "indexing…" affordance)?
 *   - is one ready for this root (drives the warm-up decision)?
 *   - how many files does it hold (status text, autotest observability)?
 *
 * It used to keep a parallel `string[]` + `Set<string>` and apply its own
 * incremental add/remove/rename patches. That was the root of a whole defect
 * class: two stores, two patch implementations, two ignore policies, and no
 * mechanism forcing them to agree — so the careful mirror could be perfectly
 * correct while the store that actually answered queries was stale. Counts now
 * come back FROM the authority (`patchFileIndex` returns `fileCount`), which
 * makes drift structurally impossible rather than merely unlikely.
 */

export type FileIndexStatus = 'idle' | 'building' | 'ready'

export interface FileIndexSnapshot {
  status: FileIndexStatus
  fileCount: number
}

export interface FileIndexWatcherAdapter {
  start(cwd: string): void
  stop(cwd: string): void
}

interface FileIndexEntry {
  status: FileIndexStatus
  fileCount: number
  buildPromise: Promise<string[]> | null
  buildToken: number
  listeners: Set<() => void>
  lastTouched: number
  watching: boolean
}

// Shared with the authoritative worker-side store so the mirror and the source
// of truth evict at the same point.
const MAX_ENTRIES = FILE_INDEX_MAX_CACHED_PROJECTS

const entries = new Map<string, FileIndexEntry>()
let watcherAdapter: FileIndexWatcherAdapter | null = null
let totalBuildCount = 0

function now(): number {
  return Date.now()
}

function touch(entry: FileIndexEntry): void {
  entry.lastTouched = now()
}

function notify(entry: FileIndexEntry): void {
  for (const listener of entry.listeners) {
    try {
      listener()
    } catch {
      // Listeners are best-effort; a crashing subscriber must not poison the others.
    }
  }
}

function createEmptyEntry(): FileIndexEntry {
  return {
    status: 'idle',
    fileCount: 0,
    buildPromise: null,
    buildToken: 0,
    listeners: new Set(),
    lastTouched: now(),
    watching: false
  }
}

function ensureEntry(cwd: string): FileIndexEntry {
  let entry = entries.get(cwd)
  if (!entry) {
    entry = createEmptyEntry()
    entries.set(cwd, entry)
    evictIfNeeded()
  }
  return entry
}

function evictIfNeeded(): void {
  if (entries.size <= MAX_ENTRIES) return
  const candidates: Array<[string, FileIndexEntry]> = []
  for (const [cwd, entry] of entries) {
    if (entry.listeners.size > 0) continue
    candidates.push([cwd, entry])
  }
  candidates.sort((a, b) => a[1].lastTouched - b[1].lastTouched)
  for (const [cwd] of candidates) {
    if (entries.size <= MAX_ENTRIES) break
    disposeCwd(cwd)
  }
}

function disposeCwd(cwd: string): void {
  const entry = entries.get(cwd)
  if (!entry) return
  entries.delete(cwd)
  if (entry.watching && watcherAdapter) {
    try {
      watcherAdapter.stop(cwd)
    } catch {
      // Best-effort cleanup; the main-process watcher will eventually time out.
    }
    entry.watching = false
  }
}

function startWatch(cwd: string, entry: FileIndexEntry): void {
  if (entry.watching || !watcherAdapter) return
  try {
    watcherAdapter.start(cwd)
    entry.watching = true
  } catch {
    entry.watching = false
  }
}

export function setFileIndexWatcherAdapter(adapter: FileIndexWatcherAdapter | null): void {
  watcherAdapter = adapter
}

export function subscribe(rawCwd: string, listener: () => void): () => void {
  const cwd = normalizeProjectCwd(rawCwd)
  const entry = ensureEntry(cwd)
  entry.listeners.add(listener)
  touch(entry)
  return () => {
    const current = entries.get(cwd)
    if (!current) return
    current.listeners.delete(listener)
  }
}

export function getIndexSnapshot(rawCwd: string): FileIndexSnapshot {
  const cwd = normalizeProjectCwd(rawCwd)
  const entry = entries.get(cwd)
  if (!entry) return { status: 'idle', fileCount: 0 }
  return { status: entry.status, fileCount: entry.fileCount }
}

/** True once an index exists for this root, so callers can skip a warm-up build. */
export function isIndexReady(rawCwd: string): boolean {
  return getIndexSnapshot(rawCwd).status === 'ready'
}

export interface EnsureIndexResult {
  fileCount: number
  /**
   * Paths produced by THIS walk, or null when the request was served from cache
   * and nothing was walked.
   *
   * Null rather than an empty array on purpose: "no walk happened" and "the walk
   * found nothing" are different facts, and collapsing them would let a caller
   * silently treat a cache hit as an empty project.
   */
  files: string[] | null
}

/**
 * Ensure an index exists, running `walker` at most once per root.
 *
 * Short-circuits when an index is already ready. That guarantee belongs HERE,
 * not in each caller: relying on every call site to check readiness first is
 * exactly the kind of by-convention invariant that decays — one new caller
 * forgets, and the project silently re-walks on every keystroke-triggered warm
 * up.
 *
 * The walker's `string[]` is passed through to the caller but NOT retained:
 * only the count is mirrored. Debug/profiling callers that want actual paths
 * take them from this return value, which keeps a second full path array from
 * living permanently in renderer memory alongside the worker's copy.
 */
export async function ensureIndex(
  rawCwd: string,
  walker: (cwd: string) => Promise<string[]>
): Promise<EnsureIndexResult> {
  const cwd = normalizeProjectCwd(rawCwd)
  const entry = ensureEntry(cwd)
  touch(entry)

  if (entry.status === 'ready') return { fileCount: entry.fileCount, files: null }
  if (entry.buildPromise) {
    const files = await entry.buildPromise
    return { fileCount: files.length, files }
  }

  entry.status = 'building'
  const token = ++entry.buildToken
  totalBuildCount += 1

  const promise = (async (): Promise<string[]> => {
    try {
      const files = await walker(cwd)
      const current = entries.get(cwd)
      if (current === entry && entry.buildToken === token) {
        entry.fileCount = files.length
        entry.status = 'ready'
        touch(entry)
        startWatch(cwd, entry)
        notify(entry)
      }
      return files
    } catch (error) {
      const current = entries.get(cwd)
      if (current === entry && entry.buildToken === token) {
        entry.status = 'idle'
        entry.fileCount = 0
        notify(entry)
      }
      throw error
    } finally {
      const current = entries.get(cwd)
      if (current === entry && entry.buildToken === token) {
        entry.buildPromise = null
      }
    }
  })()

  entry.buildPromise = promise
  const files = await promise
  return { fileCount: files.length, files }
}

export function invalidate(rawCwd: string): void {
  const cwd = normalizeProjectCwd(rawCwd)
  const entry = entries.get(cwd)
  if (!entry) return
  entry.buildToken += 1
  entry.status = 'idle'
  entry.fileCount = 0
  entry.buildPromise = null
  touch(entry)
  notify(entry)
}

/**
 * Record the authoritative file count reported by the worker after it applied a
 * patch.
 *
 * This replaces the mirror's former add/remove/rename methods. The renderer no
 * longer computes what the index contains — it only records what the authority
 * says it contains, so the two cannot disagree.
 */
export function recordAuthoritativeCount(rawCwd: string, fileCount: number): void {
  const cwd = normalizeProjectCwd(rawCwd)
  const entry = entries.get(cwd)
  if (!entry || entry.status !== 'ready') return
  if (entry.fileCount === fileCount) {
    touch(entry)
    return
  }
  entry.fileCount = fileCount
  touch(entry)
  notify(entry)
}

export function dispose(rawCwd: string): void {
  const cwd = normalizeProjectCwd(rawCwd)
  disposeCwd(cwd)
}

export function disposeAll(): void {
  for (const cwd of [...entries.keys()]) {
    disposeCwd(cwd)
  }
}

export function getCacheStats(): {
  totalBuilds: number
  entryCount: number
  entries: Array<{ cwd: string; status: FileIndexStatus; fileCount: number }>
} {
  return {
    totalBuilds: totalBuildCount,
    entryCount: entries.size,
    entries: [...entries.entries()].map(([cwd, entry]) => ({
      cwd,
      status: entry.status,
      fileCount: entry.fileCount
    }))
  }
}

export function __resetCacheStatsForTest(): void {
  totalBuildCount = 0
}

export function __getInternalStateForTest(): {
  size: number
  keys: string[]
  snapshot(cwd: string): FileIndexSnapshot
} {
  return {
    size: entries.size,
    keys: [...entries.keys()],
    snapshot(cwd: string) {
      return getIndexSnapshot(cwd)
    }
  }
}
