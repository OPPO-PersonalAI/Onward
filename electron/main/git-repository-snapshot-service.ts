/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * GitRepositorySnapshotService — the single canonical answer to
 * "given a working-tree path, what are the parent + submodule structural
 * facts I need to honor?"
 *
 * # Why this exists
 *
 * Before this module the read-side surface had three independent code
 * paths each carrying partial submodule semantics:
 *   1. `parseStatusPorcelainV2Z`            — parses parent-side rows
 *   2. `collectSubmodulesFromGitmodules`    — discovers via `.gitmodules`
 *   3. `filterMeaninglessSubmoduleEntries`  — filters parent rows by c/m/u
 *
 * That fragmentation produced two real bugs in this codebase: a deinit-ed
 * submodule (Project_Forward repro — declared in `.gitmodules`, path on
 * disk is empty + not-a-repo) leaked into the file list because (2) only
 * checked `existsSync`; and a staged-but-c=. submodule pointer was hidden
 * because (3) only kept rows whose `<c>` flag was `C`. Each fix patched a
 * different node in the same conceptual graph; nothing forced them to
 * agree on what "is this row a submodule and is it valid?" means.
 *
 * The snapshot service consolidates that decision into one structural
 * model, derived ENTIRELY from the filesystem (zero git process spawns —
 * see `collectSubmoduleSnapshotsFromDisk`):
 *   - `declaredInGitmodules`   — does a `.gitmodules` along the chain
 *                                mention it (a single `fs.readFile`)?
 *   - `initialized`            — does `<path>/.git` exist as a dir or a
 *                                `gitdir:` gitfile (a single `fs.stat`)?
 *   - `isValidRepo`            — same as `initialized`: a path that is its
 *                                own checked-out repo is valid; empty
 *                                deinit-ed paths have no `.git` and fail.
 *
 * Downstream consumers (Diff today; History / Editor scope / Quick Open
 * later) ask the service rather than re-implementing the discovery.
 *
 * # Cache & invalidation (no TTL)
 *
 * The service caches one snapshot per resolved repo root with NO time-based
 * expiry. Freshness comes from two event-driven signals, never a clock:
 *   1. A cheap `.gitmodules` validity token (`mtimeMs:size`, one `fs.stat`)
 *      checked on every `getSnapshot` — repo *structure* only changes when
 *      `.gitmodules` changes, so an unchanged token is a hit.
 *   2. The watcher fan-out: `invalidateGitDiffCache(cwd)` calls
 *      `invalidate(cwd)` so a single FS-event clears every read-side cache
 *      for that cwd (backstop for nested-`.gitmodules` edits the top-level
 *      token cannot see).
 * A fixed TTL was removed because it was actively harmful on EDR-throttled
 * Windows: a single structural capture could outlast the TTL, so the cache
 * expired before it could ever be reused.
 *
 * Cache lives in BOTH main and the git-ipc-worker (each module instance
 * has its own Map). The watcher fires in main; `gitIpcWorkerClient
 * .invalidateDiffCache` already postMessages a control envelope that
 * triggers `invalidateGitDiffCache` in the worker, which now also
 * invalidates the worker's snapshot cache.
 *
 * # Migration scope (lesson #13 phases 1-3)
 *
 * - Phase 1: `loadGitDiff` migrated (Diff path).
 * - Phase 2: `getGitHistory` migrated (History path).
 * - Phase 3: `getSubmodules` IPC handler migrated (preserves the
 *            preload-bridged API surface for any external consumers).
 *
 * Editor scope and Quick Open intentionally have no submodule-aware
 * logic in the current codebase — they index every file under the
 * working tree without crossing-or-not-crossing decisions. If a future
 * feature needs them to consult submodule structure (e.g. "exclude
 * files inside un-initialized submodules from Quick Open"), the
 * snapshot service is the canonical answer-owner and migration is one
 * import + one call.
 *
 * The legacy `detectSubmodulesRecursive` compatibility wrapper has been
 * deleted now that no caller remains.
 */

import { resolve } from 'path'
import { isMainThread } from 'worker_threads'

import {
  collectStructuralTokenTargets,
  readStructuralToken
} from './git-snapshot-structural-token'

import {
  collectSubmoduleSnapshotsFromDisk,
  type GitSubmoduleSnapshot
} from './git-submodule-disk-discovery'
import { performanceTrace } from './performance-trace'
import { PERF_TRACE_EVENT } from '../../src/utils/perf-trace-names'

import {
  getGitRepoMeta,
  listGitlinkRelPaths,
  type GitSubmoduleInfo
} from './git-utils'

// Re-export the structural unit from its leaf home so existing
// `import { GitSubmoduleSnapshot } from './git-repository-snapshot-service'`
// call sites keep working.
export type { GitSubmoduleSnapshot } from './git-submodule-disk-discovery'

/**
 * Immutable structural snapshot of a working-tree path's git world.
 */
export interface GitRepositorySnapshot {
  /** The cwd as supplied to `getSnapshot()`. */
  cwd: string
  /**
   * Resolved repo root (output of `rev-parse --show-toplevel`). null
   * when cwd is not inside a git repo.
   */
  resolvedRepoRoot: string | null
  /** True iff git is on PATH. */
  gitInstalled: boolean
  /** True iff cwd resolves to a real repo. */
  isRepo: boolean
  /**
   * All recursive submodules — declared, initialized, or both. Consumers
   * that want only the "real" set filter by `s.isValidRepo`.
   */
  submodules: GitSubmoduleSnapshot[]
  /**
   * Stable hash of (resolvedRepoRoot + sorted submodule paths + their
   * (initialized, isValidRepo) flags). Cache key so a callback receiving
   * a snapshot can compare-by-identity to detect "same shape" without
   * walking the array.
   */
  fingerprint: string
  /** UNIX ms when the snapshot was captured. */
  capturedAt: number
}

interface CacheEntry {
  snapshot: GitRepositorySnapshot
  /** Pre-computed cache key (= `resolve(cwd)`) for fast invalidation. */
  key: string
  /**
   * Structural validity token captured with the snapshot: stat tokens
   * (`mtimeMs:size`) over the CLOSED set of files a structural change must
   * touch — root `.gitmodules`, root `.git/index` (gitlinks live in the
   * index), and each known submodule's `.gitmodules` + index. Zero git
   * spawns; checked on every `getSnapshot`. This replaces both the old
   * fixed TTL (harmful on EDR — a capture could outlast it) and the old
   * `.gitmodules`-only token + drop-on-watcher backstop: with the index
   * and nested files in the token, a `reason='mirror'` invalidation no
   * longer needs to drop the snapshot at all, which is what used to force
   * a fresh `git ls-files` spawn (~5 s under EDR) on every diff open of an
   * agent-churned repo (G2 of the 2026-07-04 spinner analysis).
   */
  structuralToken: string
  /** Files whose stats compose {@link structuralToken}; resolved at capture. */
  structuralTargets: string[]
  /**
   * Set when a mirror/watcher invalidation arrived since capture. Purely
   * diagnostic: the next served hit emits `snapshot.revalidate-served` so a
   * user trace shows the spawn-free survival explicitly.
   */
  revalidatePending: boolean
}

const SNAPSHOT_CACHE_MAX_ENTRIES = 32

/** Reasons forwarded from `invalidateGitDiffCache`. Content-churn reasons
 * (`mirror`, `watcher`) only ARM the diagnostic revalidate flag — the
 * per-get structural token owns freshness. Everything else (force, manual,
 * lru, watcher-error, unknown) drops the entry outright. */
const SNAPSHOT_KEEP_ON_INVALIDATE_REASONS = new Set(['mirror', 'watcher'])

/** Compute the structural targets + token for a snapshot. */
async function buildStructuralValidity(
  snapshot: GitRepositorySnapshot
): Promise<{ targets: string[]; token: string }> {
  if (!snapshot.resolvedRepoRoot) {
    return { targets: [], token: 'no-repo' }
  }
  const targets = await collectStructuralTokenTargets(
    snapshot.resolvedRepoRoot,
    snapshot.submodules.map((s) => s.absolutePath)
  )
  return { targets, token: await readStructuralToken(targets) }
}

class GitRepositorySnapshotServiceImpl {
  private cache = new Map<string, CacheEntry>()
  private inFlight = new Map<string, Promise<GitRepositorySnapshot>>()

  /**
   * Return a snapshot for `cwd`. By default reuses the cached snapshot as
   * long as the repo's `.gitmodules` validity token is unchanged (no TTL —
   * structure is stable until `.gitmodules` changes or the watcher fires).
   * Pass `force: true` to bypass the cache entirely. NOTE: the Diff
   * force-on-entry path deliberately does NOT force this — diff freshness is
   * about file content, not submodule structure, so both the root-only and
   * full phases reuse one structural capture.
   */
  async getSnapshot(cwd: string, opts?: { force?: boolean }): Promise<GitRepositorySnapshot> {
    const key = resolve(cwd)
    const force = opts?.force === true

    if (!force) {
      const cached = this.cache.get(key)
      if (cached) {
        const token = await readStructuralToken(cached.structuralTargets)
        if (token === cached.structuralToken) {
          if (cached.revalidatePending) {
            cached.revalidatePending = false
            // The load-bearing G2 breadcrumb: a mirror/watcher invalidation
            // arrived since capture, and the snapshot still survived on the
            // stat token — i.e. NO `git ls-files` respawn for this open.
            performanceTrace.record(PERF_TRACE_EVENT.MAIN_GIT_DIFF_SNAPSHOT_REVALIDATE_SERVED, {
              cwd: key,
              ageMs: Date.now() - cached.snapshot.capturedAt,
              targetCount: cached.structuralTargets.length,
              submoduleCount: cached.snapshot.submodules.length
            })
          }
          performanceTrace.record(PERF_TRACE_EVENT.MAIN_GIT_SNAPSHOT_CACHE_HIT, {
            cwd: key,
            fingerprint: cached.snapshot.fingerprint,
            ageMs: Date.now() - cached.snapshot.capturedAt,
            submoduleCount: cached.snapshot.submodules.length,
            validity: 'structural-token'
          })
          return cached.snapshot
        }
        // Token moved — a real structural edit (or a deinit/init flip).
        performanceTrace.record(PERF_TRACE_EVENT.MAIN_GIT_DIFF_SNAPSHOT_REVALIDATE_STALE, {
          cwd: key,
          ageMs: Date.now() - cached.snapshot.capturedAt,
          targetCount: cached.structuralTargets.length
        })
      }
    }

    const inFlight = this.inFlight.get(key)
    if (inFlight) return inFlight

    const promise = this.captureAndStore(cwd, key)
    this.inFlight.set(key, promise)
    try {
      return await promise
    } finally {
      this.inFlight.delete(key)
    }
  }

  /**
   * Invalidate the cached snapshot for `cwd`. Content-churn reasons
   * (`mirror` / `watcher`) only ARM the diagnostic revalidate flag — the
   * per-get structural token (root+nested `.gitmodules` and index stats)
   * owns structural freshness, so ordinary working-tree edits no longer
   * cost a `git ls-files` respawn on the next diff open. Every other
   * reason (force, manual, lru, watcher-error, or a legacy call with no
   * reason) drops the entry outright, exactly as before.
   */
  invalidate(cwd: string, reason?: string): number {
    const key = resolve(cwd)
    if (reason && SNAPSHOT_KEEP_ON_INVALIDATE_REASONS.has(reason)) {
      const entry = this.cache.get(key)
      if (entry) entry.revalidatePending = true
      return 0
    }
    const had = this.cache.delete(key)
    if (had) {
      performanceTrace.record(PERF_TRACE_EVENT.MAIN_GIT_SNAPSHOT_INVALIDATE, {
        cwd: key,
        reason: reason ?? 'unspecified'
      })
      return 1
    }
    return 0
  }

  /**
   * Test / debug hook. Production code should never need to clear all
   * snapshots; surfaced here so a future "force reload everything"
   * action has a deterministic entry point.
   */
  clearAll(): void {
    this.cache.clear()
  }

  private async captureAndStore(cwd: string, key: string): Promise<GitRepositorySnapshot> {
    const snapshot = await captureGitRepositorySnapshot(cwd)
    const { targets, token } = await buildStructuralValidity(snapshot)
    this.cache.set(key, {
      snapshot,
      key,
      structuralToken: token,
      structuralTargets: targets,
      revalidatePending: false
    })
    this.evictLRU()
    performanceTrace.record(PERF_TRACE_EVENT.MAIN_GIT_SNAPSHOT_CAPTURE, {
      cwd: key,
      isRepo: snapshot.isRepo,
      submoduleCount: snapshot.submodules.length,
      validSubmoduleCount: snapshot.submodules.filter((s) => s.isValidRepo).length,
      fingerprint: snapshot.fingerprint
    })
    return snapshot
  }

  /** Trim the cache to {@link SNAPSHOT_CACHE_MAX_ENTRIES} via insertion-order eviction. */
  private evictLRU(): void {
    if (this.cache.size <= SNAPSHOT_CACHE_MAX_ENTRIES) return
    const overflow = this.cache.size - SNAPSHOT_CACHE_MAX_ENTRIES
    let dropped = 0
    for (const key of Array.from(this.cache.keys())) {
      if (dropped >= overflow) break
      this.cache.delete(key)
      dropped += 1
    }
  }
}

/**
 * Build a snapshot from scratch — no caching. Exported because some
 * test scenarios want to bypass the singleton's cache without going
 * through the `force: true` path.
 */
export async function captureGitRepositorySnapshot(cwd: string): Promise<GitRepositorySnapshot> {
  const meta = await getGitRepoMeta(cwd)
  // GitRepoMeta uses `gitExecutable: string | null` as the
  // git-installed signal — a null value means git wasn't found on PATH.
  const gitInstalled = Boolean(meta.gitExecutable)
  if (!gitInstalled || !meta.isRepo || !meta.repoRoot || !meta.gitExecutable) {
    return {
      cwd,
      resolvedRepoRoot: null,
      gitInstalled,
      isRepo: false,
      submodules: [],
      fingerprint: 'no-repo',
      capturedAt: Date.now()
    }
  }

  const repoRoot = meta.repoRoot
  // Read the index's gitlink (mode 160000) set with ONE `git ls-files -s`, then
  // fold it into the pure-fs discovery. This surfaces nested repos the parent
  // tracks as a gitlink but never declared in `.gitmodules` (e.g. a `git add`-ed
  // nested repo) — the class the `.gitmodules`-only walk was structurally blind
  // to. Declared paths win on overlap, so a normal submodule does not double.
  // The single process amortizes against this service's no-TTL cache: it re-runs
  // only when a capture re-runs, never on a cache hit. A failure degrades to []
  // → discovery falls back to `.gitmodules`-only (today's behavior).
  const gitlinkRelPaths = await listGitlinkRelPaths(repoRoot, meta.gitExecutable)
  const submodules = await collectSubmoduleSnapshotsFromDisk(repoRoot, {
    extraGitlinkPaths: gitlinkRelPaths
  })
  const undeclaredGitlinkCount = submodules.filter((s) => !s.declaredInGitmodules).length
  if (undeclaredGitlinkCount > 0) {
    // Diagnostic breadcrumb: a bug report's trace shows whether undeclared
    // gitlinks were found for this repo (the winWatchRTOS-Build symptom class)
    // and how the index candidate count compares — without re-running the bug.
    performanceTrace.record(PERF_TRACE_EVENT.MAIN_GIT_SNAPSHOT_GITLINK_DISCOVERED, {
      cwd,
      repoRoot,
      undeclaredGitlinkCount,
      gitlinkCandidateCount: gitlinkRelPaths.length,
      submoduleCount: submodules.length
    })
  }
  return {
    cwd,
    resolvedRepoRoot: repoRoot,
    gitInstalled: true,
    isRepo: true,
    submodules,
    fingerprint: computeFingerprint(repoRoot, submodules),
    capturedAt: Date.now()
  }
}

function computeFingerprint(repoRoot: string, submodules: GitSubmoduleSnapshot[]): string {
  // Deliberately stable: only the structural facts that make
  // re-discovery worthwhile. We don't include the submodule's HEAD sha
  // here because that would require an extra git call per submodule and
  // is irrelevant to the "shape of the repo" question this fingerprint
  // answers. Diff's own fingerprint cache (`singleRepoDiffCache`) handles
  // content-level freshness via mtime tokens.
  const parts: string[] = [resolve(repoRoot)]
  for (const sub of submodules) {
    parts.push(`${sub.path}|${sub.declaredInGitmodules ? 'd' : '.'}|${sub.initialized ? 'i' : '.'}|${sub.isValidRepo ? 'v' : '.'}`)
  }
  return parts.join(';')
}

/**
 * Map a snapshot's valid submodule list to the legacy `GitSubmoduleInfo`
 * shape that the rest of the codebase still expects. Used by the
 * compatibility wrapper inside `detectSubmodulesRecursive`.
 */
export function snapshotToLegacySubmoduleInfos(snapshot: GitRepositorySnapshot): GitSubmoduleInfo[] {
  // Only the valid-repo set is exposed to legacy callers — that mirrors
  // the previous behavior of `detectSubmodulesRecursive` after the codex
  // fix that rejected deinit-ed paths.
  return snapshot.submodules
    .filter((sub) => sub.isValidRepo)
    .map((sub) => ({
      // `name` is just the last path segment for display purposes — the
      // legacy interface keeps it for History / Editor scope tab labels.
      name: sub.path.split('/').filter(Boolean).pop() ?? sub.path,
      path: sub.path,
      repoRoot: sub.absolutePath,
      depth: sub.depth,
      parentRoot: sub.parentRoot
    }))
}

/**
 * Process-wide singleton. Lives in BOTH main and the git-ipc-worker —
 * each module instance owns its own cache. Cross-instance invalidation
 * is handled by `invalidateGitDiffCache` which calls `invalidate()`
 * here in whichever process loaded this module.
 *
 * `isMainThread` gating is intentional NOT done here because the
 * snapshot service has no main-process-only side effects (no IPC, no
 * BrowserWindow refs). Both threads can capture and cache snapshots
 * independently — the only requirement is that they get the SAME
 * invalidation signal, which the watcher → IPC bridge already provides.
 */
export const gitRepositorySnapshotService = new GitRepositorySnapshotServiceImpl()

// Mark the singleton's hosting thread so logs / future debug surfaces
// can distinguish "snapshot captured in main" from "snapshot captured
// in worker" without a separate flag plumbed through.
if (process.env.ONWARD_DEBUG === '1') {
  // eslint-disable-next-line no-console
  console.log(
    `[GitRepositorySnapshotService] hosted in ${isMainThread ? 'main' : 'worker'} thread`
  )
}
