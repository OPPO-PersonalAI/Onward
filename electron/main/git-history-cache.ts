/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Git History request caches (prewarm-cache decision ⑦), modelled on the same
 * `GitDiffRequestCacheController` the Diff list uses (TTL + maxEntries + in-flight
 * dedupe + force invalidation). Three layers:
 *
 *   - L8 History LIST  — `getGitHistory`. Key
 *     `repoRoot::branchOid::refsDigest::limit::skip`. TWO freshness signals, both
 *     from the GitStateMirror snapshot (no extra git spawn): `branchOid` moves on
 *     commit / amend / checkout (HEAD moved); `refsDigest` moves on a ref-only
 *     change — `git push` / `git fetch` advancing origin/<branch> WITHOUT moving
 *     HEAD — so the cached `%D` branch/remote decorations re-key instead of going
 *     stale (the "phantom fork after push" bug, where origin/<branch> kept being
 *     drawn at its pre-push commit for the 30-min TTL). A new key just ages out.
 *
 *   - L9 commit DIFF   — `getGitHistoryDiff`. Key `repoRoot::<stable options>`.
 *     IMMUTABLE: a committed diff never changes, so this only evicts on capacity
 *     (long TTL + FIFO past maxEntries), never goes stale.
 *
 *   - History FILE content — `getGitHistoryFileContent`. Key
 *     `repoRoot::<stable options>`. Also immutable; warmed on demand, not prewarmed.
 *
 * The key builders + prewarm-commit selection are pure and unit-tested; the
 * controller singletons live here so `git-utils.ts` (worker side) wires through
 * them without re-implementing the TTL/dedupe bookkeeping.
 */

import { resolve } from 'path'

// Explicit `.ts` extensions (sanctioned by tsconfig `allowImportingTsExtensions`)
// so the `node --experimental-strip-types` unit-test loader can resolve these
// leaf imports; esbuild / electron-vite bundle them the same as extensionless.
import { GitDiffRequestCacheController } from './git-diff-request-cache.ts'
import { stableStringifyForWorkerKey as stableStringify } from './git-ipc-worker-client-helpers.ts'
import type {
  GitCommitInfo,
  GitHistoryDiffOptions,
  GitHistoryDiffResult,
  GitHistoryFileContentOptions,
  GitHistoryFileContentResult,
  GitHistoryResult
} from './git-utils'

/**
 * Git's well-known empty-tree object id — the synthetic `base` used when a
 * commit has no parent (the root commit). MUST stay in sync with the renderer's
 * `EMPTY_TREE_HASH` (GitHistoryViewer.tsx) so a prewarmed root-commit diff key
 * matches the renderer's click key. It is a fixed git constant, never changes.
 */
export const EMPTY_TREE_HASH = '4b825dc642cb6eb9a060e54bf8d69288fbee4904'

// L8 list cache: branchOid-keyed, so freshness is structural. 30 min backstop
// TTL (same as the Diff list) so a background-warmed first page is still
// resident when the user opens History minutes later.
const HISTORY_LIST_TTL_MS = 30 * 60 * 1000
const HISTORY_LIST_MAX_ENTRIES = 64

// L9 + file content: immutable. A long TTL means the controller never expires
// them on freshness grounds; the maxEntries FIFO is the only eviction path.
const HISTORY_IMMUTABLE_TTL_MS = 24 * 60 * 60 * 1000
const HISTORY_COMMIT_DIFF_MAX_ENTRIES = 128
const HISTORY_FILE_CONTENT_MAX_ENTRIES = 128

// ---------------------------------------------------------------------------
// Pure key builders (unit-tested)
// ---------------------------------------------------------------------------

// All three keys are prefixed with `resolve(cwd)` — the SAME normalization the
// Diff list cache uses (`getGitDiffRequestKey` → `resolve(cwd)::scope`). Keying
// on the request cwd (not the resolved repo root) means the key is available
// without a pre-lookup `rev-parse --show-toplevel` spawn, and both the prewarm
// coordinator and the renderer pass the same terminal cwd, so a prewarmed entry
// is a HIT on the user's click (the proven Diff-list-prewarm contract).

/**
 * L8 list key. TWO freshness signals: `branchOid` (HEAD moved) and `refsDigest`
 * (a ref-only move — push/fetch — that left HEAD put). `'nohead'` / `'norefs'`
 * are the fallbacks when the caller could not supply one (rare — all UI/prewarm
 * callers route through main, which reads both from the mirror snapshot). With a
 * fallback the entry still works but relies on the TTL rather than structural
 * freshness for that dimension. Prewarm MUST pass the same `refsDigest` as the
 * on-demand handler (both read the same `getLatest` snapshot) or the prewarmed
 * key would never be requested and every History open would miss.
 */
export function buildHistoryListCacheKey(
  cwd: string,
  branchOid: string | undefined,
  refsDigest: string | undefined,
  limit: number,
  skip: number
): string {
  return `${resolve(cwd)}::${branchOid ?? 'nohead'}::${refsDigest ?? 'norefs'}::${limit}::${skip}`
}

/** L9 commit-diff key. Immutable per (cwd, options) — a committed diff never changes. */
export function buildHistoryCommitDiffCacheKey(cwd: string, options: GitHistoryDiffOptions): string {
  return `${resolve(cwd)}::${stableStringify(options)}`
}

/** History file-content key. Immutable per (cwd, options). */
export function buildHistoryFileContentCacheKey(cwd: string, options: GitHistoryFileContentOptions): string {
  return `${resolve(cwd)}::${stableStringify(options)}`
}

// ---------------------------------------------------------------------------
// Pure prewarm-commit selection (unit-tested)
// ---------------------------------------------------------------------------

export interface PrewarmCommitSelectionOptions {
  /** Always include the first `topN` commits in log order (newest first). */
  topN: number
  /** Also include any commit whose author date is within this many days of `nowMs`. */
  withinDays: number
  /** Reference "now" in ms epoch. Injected so selection is deterministic in tests. */
  nowMs: number
}

/**
 * Select the commits to prewarm (decision ⑦: top-N ∪ commits within the last
 * `withinDays`). De-duplicated by sha; returned newest-first (top-N first, then
 * any additional recent commits) so the most-likely-viewed diffs warm first.
 * Pure — no I/O, no clock (now is injected).
 */
export function selectPrewarmCommits(
  commits: GitCommitInfo[],
  options: PrewarmCommitSelectionOptions
): GitCommitInfo[] {
  const topN = Math.max(0, Math.floor(options.topN))
  const windowMs = Math.max(0, options.withinDays) * 24 * 60 * 60 * 1000
  const selected: GitCommitInfo[] = []
  const seen = new Set<string>()
  const take = (commit: GitCommitInfo): void => {
    if (!commit.sha || seen.has(commit.sha)) return
    seen.add(commit.sha)
    selected.push(commit)
  }
  // 1. top-N in log order.
  for (let i = 0; i < Math.min(topN, commits.length); i += 1) take(commits[i])
  // 2. recent window (only meaningful when withinDays > 0).
  if (windowMs > 0) {
    for (const commit of commits) {
      const parsed = Date.parse(commit.authorDate)
      if (Number.isFinite(parsed) && options.nowMs - parsed <= windowMs) take(commit)
    }
  }
  return selected
}

/**
 * Map selected commits to the exact `{ base, head }` pairs the renderer's
 * single-commit diff click produces (`head = commit.sha`, `base =
 * commit.parents[0] ?? EMPTY_TREE_HASH`), so a prewarmed diff is a cache HIT on
 * click. Pure.
 */
export function buildPrewarmCommitDiffTargets(commits: GitCommitInfo[]): Array<{ base: string; head: string }> {
  return commits.map((commit) => ({
    base: commit.parents?.[0] ?? EMPTY_TREE_HASH,
    head: commit.sha
  }))
}

// ---------------------------------------------------------------------------
// Controller singletons (worker side; mirror getGitDiffRequestCacheController)
// ---------------------------------------------------------------------------

let historyListCache: GitDiffRequestCacheController<GitHistoryResult> | null = null
let historyCommitDiffCache: GitDiffRequestCacheController<GitHistoryDiffResult> | null = null
let historyFileContentCache: GitDiffRequestCacheController<GitHistoryFileContentResult> | null = null

export function getHistoryListCacheController(): GitDiffRequestCacheController<GitHistoryResult> {
  if (!historyListCache) {
    historyListCache = new GitDiffRequestCacheController<GitHistoryResult>({
      ttlMs: HISTORY_LIST_TTL_MS,
      maxEntries: HISTORY_LIST_MAX_ENTRIES,
      clone: (value) => structuredClone(value)
    })
  }
  return historyListCache
}

export function getHistoryCommitDiffCacheController(): GitDiffRequestCacheController<GitHistoryDiffResult> {
  if (!historyCommitDiffCache) {
    historyCommitDiffCache = new GitDiffRequestCacheController<GitHistoryDiffResult>({
      ttlMs: HISTORY_IMMUTABLE_TTL_MS,
      maxEntries: HISTORY_COMMIT_DIFF_MAX_ENTRIES,
      clone: (value) => structuredClone(value)
    })
  }
  return historyCommitDiffCache
}

export function getHistoryFileContentCacheController(): GitDiffRequestCacheController<GitHistoryFileContentResult> {
  if (!historyFileContentCache) {
    historyFileContentCache = new GitDiffRequestCacheController<GitHistoryFileContentResult>({
      ttlMs: HISTORY_IMMUTABLE_TTL_MS,
      maxEntries: HISTORY_FILE_CONTENT_MAX_ENTRIES,
      clone: (value) => structuredClone(value)
    })
  }
  return historyFileContentCache
}

// ---------------------------------------------------------------------------
// Failure-skipping cache wrapper
// ---------------------------------------------------------------------------

// Sentinel: a non-success result we deliberately do NOT want cached (a transient
// git failure must not be pinned for the cache's TTL — especially the 24 h
// immutable TTL). Thrown from inside `load` so the controller never reaches its
// `cache.set`, then unwrapped by the caller back into a plain result object.
class UncacheableHistoryResult<T> {
  readonly result: T
  // Explicit field assignment, not a TS parameter property — the strip-types
  // unit-test loader rejects `constructor(public readonly result)`.
  constructor(result: T) {
    this.result = result
  }
}

export interface CachedHistoryHooks {
  /** Fired when a fresh, non-expired entry served the request. */
  onCacheHit?: (ageMs: number) => void
  /** Fired exactly once per real (de-duped) load — i.e. on a true cache miss. */
  onMiss?: () => void
}

/**
 * Run `load` behind a request cache, but ONLY cache successful results. A
 * `{ success: false }` result is returned to the caller verbatim yet never
 * stored, so a transient failure self-heals on the next request instead of
 * being pinned for the (long) TTL.
 */
export async function cachedHistoryRequest<T extends { success: boolean }>(
  controller: GitDiffRequestCacheController<T>,
  key: string,
  load: () => Promise<T>,
  hooks?: CachedHistoryHooks
): Promise<T> {
  try {
    return await controller.get(key, {
      load: async () => {
        hooks?.onMiss?.()
        const result = await load()
        if (!result.success) throw new UncacheableHistoryResult<T>(result)
        return result
      },
      onCacheHit: hooks?.onCacheHit
    })
  } catch (error) {
    if (error instanceof UncacheableHistoryResult) return error.result as T
    throw error
  }
}
