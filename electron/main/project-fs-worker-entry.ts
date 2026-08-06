/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

import { readdir } from 'fs/promises'
import { execFile } from 'child_process'
import { relative, resolve, sep } from 'path'
import { parentPort, workerData } from 'worker_threads'
import { resolveInRoot } from './path-containment'
import { isIgnoredRel } from './project-tree-watch-ignore'
import {
  FILE_INDEX_MAX_CACHED_PROJECTS,
  clampSearchOffset,
  clampSearchPageSize
} from '../../src/utils/file-index-constants'
import { applyFileIndexPatch, normalizeIndexRel } from '../../src/utils/file-index-patch'

type ProjectEntry = {
  name: string
  path: string
  type: 'file' | 'dir'
}

type WorkerMethod =
  | 'listDirectory'
  | 'buildFileIndex'
  | 'searchFilenames'
  | 'invalidateFileIndex'
  | 'patchFileIndex'

type WorkerRequest = {
  id: number
  method: WorkerMethod
  payload: Record<string, unknown>
}

type WorkerResponse = {
  id: number
  ok: boolean
  result?: unknown
  error?: string
}

/**
 * The AUTHORITATIVE filename index. Every Cmd+P / sidebar filename result is
 * served from here; the renderer-side cache is a mirror kept for UI status and
 * for the degraded path where this worker is unavailable.
 *
 * Two properties this store must hold, both of which the previous
 * `Map<string, string[]>` did not:
 *
 *   1. BOUNDED. Entries are evicted least-recently-used past
 *      FILE_INDEX_MAX_CACHED_PROJECTS. The old map only ever shrank via an
 *      explicit invalidate, so every project visited in a session leaked its
 *      full path list for the lifetime of the process.
 *   2. PATCHABLE. `patchFileIndex` applies an incremental add/remove/rename
 *      diff. Previously the only way to reflect a filesystem change was to drop
 *      the whole entry, which meant an ordinary file save cost a full recursive
 *      re-walk on the next search.
 */
type FileIndexEntry = {
  files: string[]
  fileSet: Set<string>
  lastTouched: number
}

const fileIndexCache = new Map<string, FileIndexEntry>()

function touchEntry(rootPath: string, entry: FileIndexEntry): void {
  entry.lastTouched = Date.now()
  // Re-insert so Map iteration order also reflects recency, which keeps the
  // eviction scan cheap and deterministic.
  fileIndexCache.delete(rootPath)
  fileIndexCache.set(rootPath, entry)
}

function evictFileIndexIfNeeded(): void {
  while (fileIndexCache.size > FILE_INDEX_MAX_CACHED_PROJECTS) {
    // Map preserves insertion order and `touchEntry` re-inserts on access, so
    // the first key is the least recently used.
    const oldestKey = fileIndexCache.keys().next().value
    if (oldestKey === undefined) return
    fileIndexCache.delete(oldestKey)
  }
}

function storeFileIndex(rootPath: string, files: string[]): FileIndexEntry {
  const entry: FileIndexEntry = {
    files,
    fileSet: new Set(files),
    lastTouched: Date.now()
  }
  fileIndexCache.delete(rootPath)
  fileIndexCache.set(rootPath, entry)
  evictFileIndexIfNeeded()
  return entry
}

function toStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
}

/**
 * Apply an incremental diff to a cached index.
 *
 * The diff RULES (ordering, prefix cascading, ignore gating, dedup) live in the
 * shared `applyFileIndexPatch` so there is exactly one implementation of them;
 * this function only owns cache bookkeeping (lookup, store, recency).
 *
 * Returns `applied: false` when the root is not cached — there is nothing to
 * patch and the next search will build a fresh (already-correct) index, so the
 * caller must NOT fall back to invalidation.
 */
function patchFileIndex(
  root: string,
  added: string[],
  removed: string[],
  renamed: Array<{ from: string; to: string }>
): { success: true; applied: boolean; fileCount: number; changed: boolean } {
  const rootPath = resolve(root)
  const entry = fileIndexCache.get(rootPath)
  if (!entry) return { success: true, applied: false, fileCount: 0, changed: false }

  const outcome = applyFileIndexPatch(entry.files, { added, removed, renamed }, isIndexPathIgnored)
  entry.files = outcome.files
  entry.fileSet = outcome.fileSet
  touchEntry(rootPath, entry)
  return { success: true, applied: true, fileCount: entry.files.length, changed: outcome.changed }
}

function toRelativePath(root: string, fullPath: string): string {
  return relative(root, fullPath).split(sep).join('/')
}

function sortEntries(entries: ProjectEntry[]): ProjectEntry[] {
  return entries.sort((a, b) => {
    if (a.type !== b.type) return a.type === 'dir' ? -1 : 1
    return a.name.localeCompare(b.name, 'zh-Hans-CN', { numeric: true })
  })
}

async function listDirectory(root: string, path: string) {
  const rootPath = resolve(root)
  const fullPath = resolveInRoot(rootPath, path)
  if (!fullPath) {
    return { success: false, root: rootPath, path, entries: [], error: 'Invalid path. It is outside the working directory.' }
  }

  try {
    const dirents = await readdir(fullPath, { withFileTypes: true })
    const entries = dirents.map((dirent): ProjectEntry => {
      const entryFullPath = resolve(fullPath, dirent.name)
      return {
        name: dirent.name,
        path: toRelativePath(rootPath, entryFullPath),
        type: dirent.isDirectory() ? 'dir' : 'file'
      }
    })
    return {
      success: true,
      root: rootPath,
      path,
      entries: sortEntries(entries)
    }
  } catch (error) {
    return {
      success: false,
      root: rootPath,
      path,
      entries: [],
      error: `Failed to read directory: ${String(error)}`
    }
  }
}

/**
 * Ignore predicate for anything that reaches the index INCREMENTALLY.
 *
 * The bundled `rg --files` decides what the initial walk collects (it applies
 * `.gitignore` / `.ignore` natively). Watcher events, however, arrive as bare
 * paths with no ignore evaluation attached, so incremental additions still need
 * a gate. This one is intentionally the coarse hard-coded list rather than a
 * gitignore re-implementation: a path that `.gitignore` covers but this list
 * does not will simply be dropped at the next rebuild, whereas hand-rolling
 * gitignore semantics here would be a second, inevitably-divergent matcher.
 */
function isIndexPathIgnored(rel: string): boolean {
  return isIgnoredRel(rel)
}

const RIPGREP_PATH: string = (() => {
  const provided = (workerData as { rgPath?: unknown } | null)?.rgPath
  return typeof provided === 'string' && provided.length > 0 ? provided : 'rg'
})()

const RIPGREP_LIST_TIMEOUT_MS = 20_000
// A very large project would otherwise buffer an unbounded string; 64 MB of
// newline-separated paths is far beyond any realistic checkout.
const RIPGREP_MAX_BUFFER_BYTES = 64 * 1024 * 1024

/**
 * List project files with `rg --files`, which applies `.gitignore`, `.ignore`
 * and `.git/info/exclude` with real git semantics (nesting, negation, anchoring)
 * — none of which a hand-written matcher would get right without becoming a
 * maintenance liability of its own.
 *
 * Flags, and why each is load-bearing:
 *   --files          list paths instead of searching content
 *   --no-require-git APPLY .gitignore even when the folder is not a git repo.
 *                    Without it ripgrep silently ignores .gitignore outside a
 *                    repo (verified), so opening a non-git project folder would
 *                    behave differently from opening the same folder after
 *                    `git init` — a difference the user has no way to predict.
 *   --hidden         KEEP dotfiles. ripgrep skips them by default, which would
 *                    silently drop `.github/workflows/**`, `.claude/**` and
 *                    `.gitattributes` — real project files users search for.
 *   --glob '!.git/'  re-exclude the VCS internals that --hidden just let back in
 *   --no-messages    permission errors on individual dirs must not fail the walk
 *   --null           NUL-delimited output, so paths containing newlines survive
 *
 * Returns null when ripgrep is unavailable or fails, so the caller can fall
 * back to the filesystem walk rather than presenting an empty index.
 */
async function listFilesViaRipgrep(rootPath: string): Promise<string[] | null> {
  return await new Promise<string[] | null>((resolvePromise) => {
    execFile(
      RIPGREP_PATH,
      ['--files', '--hidden', '--no-require-git', '--glob', '!.git/', '--no-messages', '--null'],
      {
        cwd: rootPath,
        timeout: RIPGREP_LIST_TIMEOUT_MS,
        maxBuffer: RIPGREP_MAX_BUFFER_BYTES,
        windowsHide: true
      },
      (error, stdout) => {
        // rg exits 1 for "no files matched", which is a legitimate empty
        // project rather than a failure. Anything else means we could not
        // trust the listing.
        const exitCode = (error as (Error & { code?: number }) | null)?.code
        if (error && exitCode !== 1) {
          resolvePromise(null)
          return
        }
        const paths: string[] = []
        for (const raw of stdout.split('\0')) {
          const rel = normalizeIndexRel(raw)
          if (rel) paths.push(rel)
        }
        resolvePromise(paths)
      }
    )
  })
}

/**
 * Filesystem-walk fallback, used only when ripgrep is unavailable.
 *
 * This path cannot honour `.gitignore` — it applies the coarse hard-coded
 * ignore list instead. That is a deliberate degradation: a slightly noisier
 * index beats no index at all, and the difference is observable in a trace via
 * `MAIN_FILE_INDEX_BUILD`'s `strategy` field.
 */
async function listFilesViaWalk(rootPath: string): Promise<string[]> {
  const files: string[] = []
  const queue: string[] = ['']

  while (queue.length > 0) {
    const current = queue.shift() ?? ''
    const result = await listDirectory(rootPath, current)
    if (!result.success) continue
    for (const entry of result.entries) {
      if (isIndexPathIgnored(entry.path)) continue
      if (entry.type === 'dir') {
        queue.push(entry.path)
      } else {
        files.push(entry.path)
      }
    }
  }
  return files
}

export type FileIndexBuildStrategy = 'ripgrep' | 'walk-fallback'

export type FileIndexBuildResult = {
  files: string[]
  /**
   * Which lister produced this index. Reported rather than kept in module state
   * so a concurrent build for another root cannot make the value lie, and so a
   * user-supplied trace shows whether `.gitignore` was actually honoured.
   */
  strategy: FileIndexBuildStrategy
}

async function buildFileIndex(root: string): Promise<FileIndexBuildResult> {
  const rootPath = resolve(root)
  const viaRipgrep = await listFilesViaRipgrep(rootPath)
  const files = viaRipgrep ?? await listFilesViaWalk(rootPath)
  storeFileIndex(rootPath, files)
  return { files, strategy: viaRipgrep ? 'ripgrep' : 'walk-fallback' }
}

function getBaseName(path: string): string {
  const slash = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
  return slash === -1 ? path : path.slice(slash + 1)
}

function fuzzyScore(query: string, target: string): number | null {
  if (!query) return 0
  let score = 0
  let lastIndex = -1
  for (let i = 0; i < query.length; i += 1) {
    const ch = query[i]
    let found = false
    for (let j = lastIndex + 1; j < target.length; j += 1) {
      if (target[j] === ch) {
        score += j === lastIndex + 1 ? 3 : 1
        lastIndex = j
        found = true
        break
      }
    }
    if (!found) return null
  }
  score += Math.max(0, 20 - (target.length - query.length))
  return score
}

export type FilenameSearchPage = {
  items: string[]
  /** Total matches BEFORE paging — this is what lets the UI say "50 of 312". */
  total: number
  offset: number
  limit: number
}

async function searchFilenames(
  root: string,
  query: string,
  limit: number,
  offset: number
): Promise<FilenameSearchPage> {
  const rootPath = resolve(root)
  const cached = fileIndexCache.get(rootPath)
  if (cached) touchEntry(rootPath, cached)
  const files = cached?.files ?? (await buildFileIndex(rootPath)).files
  const normalized = query.trim().toLowerCase()
  if (!normalized) {
    return { items: files.slice(offset, offset + limit), total: files.length, offset, limit }
  }

  const scored: Array<{ item: string; score: number }> = []
  for (const item of files) {
    const lower = item.toLowerCase()
    const baseScore = fuzzyScore(normalized, getBaseName(lower))
    const pathScore = fuzzyScore(normalized, lower)
    if (baseScore === null && pathScore === null) continue
    scored.push({
      item,
      score: (baseScore ?? 0) * 2 + (pathScore ?? 0)
    })
  }

  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score
    return a.item.length - b.item.length
  })
  return {
    items: scored.slice(offset, offset + limit).map((entry) => entry.item),
    total: scored.length,
    offset,
    limit
  }
}

async function dispatch(method: WorkerMethod, payload: Record<string, unknown>): Promise<unknown> {
  const root = typeof payload.root === 'string' ? payload.root : ''
  switch (method) {
    case 'listDirectory':
      return listDirectory(root, typeof payload.path === 'string' ? payload.path : '')
    case 'buildFileIndex':
      return buildFileIndex(root)
    case 'searchFilenames':
      return searchFilenames(
        root,
        typeof payload.query === 'string' ? payload.query : '',
        clampSearchPageSize(payload.limit),
        clampSearchOffset(payload.offset)
      )
    case 'invalidateFileIndex':
      fileIndexCache.delete(resolve(root))
      return { success: true }
    case 'patchFileIndex':
      return patchFileIndex(
        root,
        toStringArray(payload.added),
        toStringArray(payload.removed),
        Array.isArray(payload.renamed)
          ? payload.renamed.flatMap((pair) => {
            if (!pair || typeof pair !== 'object') return []
            const { from, to } = pair as { from?: unknown; to?: unknown }
            return typeof from === 'string' && typeof to === 'string' ? [{ from, to }] : []
          })
          : []
      )
    default:
      throw new Error(`Unknown Project FS worker method: ${method}`)
  }
}

parentPort?.on('message', async (request: WorkerRequest) => {
  const response: WorkerResponse = { id: request.id, ok: true }
  try {
    response.result = await dispatch(request.method, request.payload)
  } catch (error) {
    response.ok = false
    response.error = String(error)
  }
  parentPort?.postMessage(response)
})
