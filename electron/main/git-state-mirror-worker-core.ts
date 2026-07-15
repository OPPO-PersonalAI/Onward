/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

import { resolve } from 'path'

import type {
  MirrorDelta,
  MirrorState,
  MirrorWatcherFailureKind,
  MirrorWatcherHealth
} from './git-state-mirror-types'

export type MirrorWatcherFilterReason = 'gitObjects' | 'lockfile' | 'tmpfile' | 'gitInternal' | 'allowed'

export const MIRROR_WATCHER_RESTART_BACKOFF_MS = [800, 1600, 3200] as const
export const MIRROR_WATCHER_RESTART_BACKOFF_CAP_MS = 5000
export const MIRROR_WATCHER_DEGRADED_POLLING_INTERVAL_MS = 3000
export const MIRROR_WATCHER_SUSPENDED_PROBE_INTERVAL_MS = 5000
export const MIRROR_WATCHER_POLLING_FAILURE_THRESHOLD = 3

export const MIRROR_WATCHER_IGNORE = [
  '.git/objects/**',
  'node_modules/**',
  'out/**',
  'release/**',
  'traces/**',
  '.parcel-cache/**'
] as const

export interface MirrorWorkerEntryCore {
  cwd: string
  watchedRoot: string
  state: MirrorState | null
  watcherDispose: (() => Promise<void>) | null
  attachInFlight: boolean
  detachRequested: boolean
  debounceTimer: NodeJS.Timeout | null
  pendingSince: number | null
  pendingPaths: Set<string>
  recomputeGeneration: number
  recomputeInFlight: boolean
  recomputeQueued: boolean
  watcherHealth: MirrorWatcherHealth
  watcherFailureCount: number
  lastWatcherError: string | null
  lastWatcherFailureKind: MirrorWatcherFailureKind | null
  lastWatcherHealthyAt: number | null
  restartTimer: NodeJS.Timeout | null
  pollTimer: NodeJS.Timeout | null
  suspendedProbeTimer: NodeJS.Timeout | null
  pollInFlight: boolean
  restartGeneration: number
  watcherGroupKey: string | null
}

export interface MirrorWatcherGroupCore {
  repoRoot: string
  repoRootKey: string
  entries: Set<string>
}

export function createMirrorWorkerEntry(cwd: string): MirrorWorkerEntryCore {
  const key = resolve(cwd)
  return {
    cwd: key,
    watchedRoot: key,
    state: null,
    watcherDispose: null,
    attachInFlight: false,
    detachRequested: false,
    debounceTimer: null,
    pendingSince: null,
    pendingPaths: new Set(),
    recomputeGeneration: 0,
    recomputeInFlight: false,
    recomputeQueued: false,
    watcherHealth: 'idle',
    watcherFailureCount: 0,
    lastWatcherError: null,
    lastWatcherFailureKind: null,
    lastWatcherHealthyAt: null,
    restartTimer: null,
    pollTimer: null,
    suspendedProbeTimer: null,
    pollInFlight: false,
    restartGeneration: 0,
    watcherGroupKey: null
  }
}

export function resolveMirrorWatcherRoot(state: MirrorState | null): string | null {
  if (!state?.repoRoot) return null
  return resolve(state.repoRoot)
}

/**
 * .git event filter used by the worker watcher.
 *
 * Worktree files such as Cargo.lock, pnpm-lock.yaml, and yarn.lock are real
 * project inputs and must trigger recompute. Only transient files inside a
 * `.git/` directory are filtered.
 *
 * IMPORTANT — nested (submodule) `.git/` dirs: the watcher is recursive over the
 * parent worktree, which CONTAINS each submodule's working tree (and, for a
 * classic-layout submodule, its real `.git/` directory at
 * `<submodule>/.git/...`). Any git activity inside a submodule — including the
 * USER's own git commands and our own (even read-only) probes — churns the
 * submodule's `.git/` (e.g. `index.lock` create/delete). Recognising ONLY the
 * top-level `.git/` let `<sub>/.git/index.lock` fall through as a "worktree
 * change", firing a recompute → diff-cache invalidation storm (observed on
 * Windows: every click cleared the renderer body cache). So we classify the
 * subpath after the LAST `.git/` segment, applying the same rules whether the
 * `.git/` is top-level or a nested submodule dir.
 */
export function classifyEventPath(eventPath: string, watchedRoot: string): {
  drop: boolean
  reason: MirrorWatcherFilterReason
} {
  const normWatched = watchedRoot.replace(/\\/g, '/').replace(/\/+$/, '')
  const normEvent = eventPath.replace(/\\/g, '/')
  const rel = normEvent.startsWith(normWatched + '/')
    ? normEvent.slice(normWatched.length + 1)
    : normEvent

  // The `.git` ENTRY itself (top-level dir node, or a submodule's gitfile/dir
  // node) is internal noise.
  if (rel === '.git' || rel.endsWith('/.git')) {
    return { drop: true, reason: 'gitInternal' }
  }

  // Subpath after the LAST `.git/` segment — handles top-level (`.git/...`) AND
  // nested submodule (`a/b/.git/...`, even submodule-in-submodule) git dirs.
  const lastGit = rel.lastIndexOf('/.git/')
  const sub = rel.startsWith('.git/')
    ? rel.slice('.git/'.length)
    : (lastGit >= 0 ? rel.slice(lastGit + '/.git/'.length) : null)

  if (sub !== null) {
    if (sub.endsWith('.lock')) return { drop: true, reason: 'lockfile' }
    if (/(?:^|\/)\.tmp_/.test(sub)) return { drop: true, reason: 'tmpfile' }
    if (/~\d+$/.test(sub)) return { drop: true, reason: 'tmpfile' }
    if (sub.startsWith('objects/')) return { drop: true, reason: 'gitObjects' }
    if (
      sub === 'HEAD' ||
      sub === 'ORIG_HEAD' ||
      sub === 'MERGE_HEAD' ||
      sub === 'CHERRY_PICK_HEAD' ||
      sub === 'REBASE_HEAD' ||
      sub === 'index' ||
      sub === 'packed-refs' ||
      sub === 'config' ||
      sub.startsWith('refs/') ||
      sub === 'logs/HEAD' ||
      sub.startsWith('logs/refs/') ||
      sub.startsWith('rebase-')
    ) {
      return { drop: false, reason: 'allowed' }
    }
    return { drop: true, reason: 'gitInternal' }
  }

  // Worktree-level atomic-save temp files. Many tools write a file by creating a
  // sibling temp, fsync'ing it, then renaming it over the target (write-temp-
  // then-rename). The temp churns the watcher even though the meaningful event
  // is the final rename to the REAL file (which fires its own allowed event and
  // still triggers a recompute). Observed on kar-qemu: a background process
  // rewriting `tools/kar_air_control.py` produced 11 events from
  // `kar_air_control.py.tmp.<pid>.<hash>` temps. Dropping these temp artifacts
  // avoids a redundant recompute per atomic save without losing the real change.
  const leaf = rel.slice(rel.lastIndexOf('/') + 1)
  // `.tmp.<pid>.<hash>` (write-file-atomic / similar atomic writers):
  // e.g. foo.py.tmp.7432.3fe8206c1a01. The `.tmp.` infix is an unambiguous temp
  // marker, so this is safe against real files (config.tmp.json, foo.tmp, and
  // version-like names do NOT match). A broader `.<pid>.<hash>` form was
  // deliberately NOT added — it risks matching legitimate dotted data files.
  if (/\.tmp\.\d+\.[0-9a-f]{4,}$/i.test(leaf)) {
    return { drop: true, reason: 'tmpfile' }
  }

  return { drop: false, reason: 'allowed' }
}

/**
 * Decide whether a just-completed recompute revealed a non-git → git
 * transition that needs the FS watcher (re)attached.
 *
 * WHY (2026-07-05 diagnostic bundle, "BattleProject not recognized"): a cwd
 * that is not a git repo when a terminal first attaches gets NO watcher
 * (`handleAttachWatch` skips it — there is nothing to watch). If the user then
 * runs `git init` / `git clone` inside that same open directory, the FS watcher
 * never existed to catch the `.git` creation, so the repo stays invisible until
 * a focus-resync recompute happens to re-detect it — and even then the watcher
 * is still missing, so the tab goes stale again on the next edit. A recompute
 * that discovers a repoRoot where the entry has no watcher group must therefore
 * trigger a watcher attach.
 *
 * Pure predicate so the transition table is unit-tested without a live worker:
 *   attach a watcher IFF the entry now resolves a repoRoot, has no watcher group
 *   yet, and is neither detaching nor already mid-attach.
 */
export function shouldReattachWatcherAfterRecompute(
  entry: Pick<MirrorWorkerEntryCore, 'watcherGroupKey' | 'detachRequested' | 'attachInFlight'>,
  nextRepoRoot: string | null
): boolean {
  if (!nextRepoRoot) return false
  if (entry.watcherGroupKey) return false
  if (entry.detachRequested) return false
  if (entry.attachInFlight) return false
  return true
}

/**
 * Harden the environment for the mirror's read-only git invocations.
 *
 * Every mirror git call (status / rev-parse / show) is strictly read-only, but
 * by default `git status` performs an opportunistic index refresh: it takes
 * `.git/index.lock` and rewrites `.git/index` to update the stat cache. The
 * mirror watcher observes that `.git/index` write as a change event and
 * schedules another recompute, which runs `git status` again, which rewrites
 * `.git/index` again — a self-perpetuating recompute storm that can stall the
 * mirror on a stale snapshot after a commit.
 *
 * Setting `GIT_OPTIONAL_LOCKS=0` makes git skip that side-effecting refresh
 * while still computing correct status output. This is the maintainer-blessed
 * fix (git commit 27344d6, git >= 2.15) and mirrors VS Code's
 * `extensions/git` `getStatus` (which scopes the same env var to its read
 * path). It is cross-platform (no `process.platform` branch needed) and safe:
 * the only trade-off is that stat-drifted files are re-hashed until a
 * foreground git command refreshes the index — never a correctness issue.
 */
export function hardenReadonlyGitEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return { ...env, GIT_OPTIONAL_LOCKS: '0' }
}

export function cleanupMirrorWorkerEntry(entry: MirrorWorkerEntryCore): void {
  if (entry.debounceTimer) {
    clearTimeout(entry.debounceTimer)
    entry.debounceTimer = null
  }
  clearMirrorWatcherTimers(entry)
  entry.pendingPaths.clear()
  entry.pendingSince = null
  entry.pollInFlight = false
  entry.recomputeQueued = false
}

export function clearMirrorWatcherTimers(entry: MirrorWorkerEntryCore): void {
  if (entry.restartTimer) {
    clearTimeout(entry.restartTimer)
    entry.restartTimer = null
  }
  if (entry.pollTimer) {
    clearTimeout(entry.pollTimer)
    entry.pollTimer = null
  }
  if (entry.suspendedProbeTimer) {
    clearTimeout(entry.suspendedProbeTimer)
    entry.suspendedProbeTimer = null
  }
}

export function computeMirrorWatcherBackoffMs(failureCount: number): number {
  const safeCount = Math.max(1, Math.floor(failureCount))
  return MIRROR_WATCHER_RESTART_BACKOFF_MS[safeCount - 1] ?? MIRROR_WATCHER_RESTART_BACKOFF_CAP_MS
}

export function isMirrorWatcherPathMissingError(error: unknown): boolean {
  const maybe = error as { code?: unknown; name?: unknown; message?: unknown } | null
  const code = typeof maybe?.code === 'string' ? maybe.code : ''
  const name = typeof maybe?.name === 'string' ? maybe.name : ''
  const message = typeof maybe?.message === 'string' ? maybe.message : String(error ?? '')
  return /ENOENT|ENOTDIR|not found|no such file|path.*missing|does not exist/i.test(`${code} ${name} ${message}`)
}

export function normaliseMirrorRepoRootKey(repoRoot: string): string {
  const slashNormalised = repoRoot.replace(/\\/g, '/').replace(/\/+$/, '')
  if (/^[A-Za-z]:\//.test(slashNormalised)) {
    return slashNormalised.replace(/^([A-Z]):/, (m) => m.toLowerCase())
  }
  return resolve(slashNormalised).replace(/\\/g, '/').replace(/\/+$/, '')
}

export function addMirrorWatcherGroupEntry(
  groups: Map<string, MirrorWatcherGroupCore>,
  repoRoot: string,
  cwd: string
): { group: MirrorWatcherGroupCore; created: boolean } {
  const repoRootKey = normaliseMirrorRepoRootKey(repoRoot)
  let group = groups.get(repoRootKey)
  if (!group) {
    group = {
      repoRoot: resolve(repoRoot),
      repoRootKey,
      entries: new Set()
    }
    groups.set(repoRootKey, group)
  }
  group.entries.add(resolve(cwd))
  return { group, created: group.entries.size === 1 }
}

export function beginMirrorPoll(entry: MirrorWorkerEntryCore): 'start' | 'skip-in-flight' {
  if (entry.pollInFlight) return 'skip-in-flight'
  entry.pollInFlight = true
  return 'start'
}

export function finishMirrorPoll(entry: MirrorWorkerEntryCore): void {
  entry.pollInFlight = false
}

export function requestMirrorAttach(entry: MirrorWorkerEntryCore): 'start' | 'already-attached' | 'already-in-flight' | 'resume-in-flight' {
  if (entry.watcherDispose) {
    entry.detachRequested = false
    return 'already-attached'
  }
  if (entry.attachInFlight) {
    if (entry.detachRequested) {
      entry.detachRequested = false
      return 'resume-in-flight'
    }
    return 'already-in-flight'
  }
  entry.detachRequested = false
  entry.attachInFlight = true
  return 'start'
}

export async function completeMirrorAttach(
  entry: MirrorWorkerEntryCore,
  dispose: () => Promise<void>
): Promise<'attached' | 'detached'> {
  entry.attachInFlight = false
  if (entry.detachRequested) {
    try {
      await dispose()
    } finally {
      entry.watcherDispose = null
      cleanupMirrorWorkerEntry(entry)
    }
    return 'detached'
  }
  entry.watcherDispose = dispose
  return 'attached'
}

export async function requestMirrorDetach(entry: MirrorWorkerEntryCore): Promise<'detached' | 'pending-attach' | 'idle'> {
  entry.detachRequested = true
  cleanupMirrorWorkerEntry(entry)
  if (entry.attachInFlight && !entry.watcherDispose) {
    return 'pending-attach'
  }
  if (!entry.watcherDispose) {
    return 'idle'
  }
  const dispose = entry.watcherDispose
  entry.watcherDispose = null
  try {
    await dispose()
  } finally {
    cleanupMirrorWorkerEntry(entry)
  }
  return 'detached'
}

export function beginMirrorRecompute(entry: MirrorWorkerEntryCore): number {
  entry.recomputeGeneration += 1
  return entry.recomputeGeneration
}

export function finishMirrorRecomputeIfCurrent(
  entry: MirrorWorkerEntryCore,
  generation: number,
  next: MirrorState
): MirrorDelta | null {
  if (entry.detachRequested || generation !== entry.recomputeGeneration) {
    return null
  }
  const delta = computeMirrorDelta(entry.state, next)
  entry.state = next
  return delta
}

export function computeMirrorDelta(prev: MirrorState | null, next: MirrorState): MirrorDelta {
  const out: MirrorDelta = { capturedAt: next.capturedAt }
  if (!prev) {
    out.repoRoot = next.repoRoot
    out.repoName = next.repoName
    out.branch = next.branch
    out.branchOid = next.branchOid
    out.refsDigest = next.refsDigest
    out.ahead = next.ahead
    out.behind = next.behind
    out.status = next.status
    out.files = next.files
    out.repos = next.repos
    out.submodulesLoading = next.submodulesLoading
    out.generation = next.generation
    return out
  }
  if (prev.repoRoot !== next.repoRoot) out.repoRoot = next.repoRoot
  if (prev.repoName !== next.repoName) out.repoName = next.repoName
  if (prev.branch !== next.branch) out.branch = next.branch
  if (prev.branchOid !== next.branchOid) out.branchOid = next.branchOid
  // refsDigest is the History-cache freshness signal for ref-only moves (push /
  // fetch advancing origin/<branch> without moving HEAD). Surfacing it here makes
  // such a move a non-empty delta, so the mirror-update broadcasts (otherwise the
  // ref-blind changeFingerprint would short-circuit it) and getLatest carries the
  // new digest into the next History cache key.
  if (prev.refsDigest !== next.refsDigest) out.refsDigest = next.refsDigest
  // ahead/behind move on local commit (branchOid) OR a ref-only change (push /
  // fetch advancing the upstream ref). Surface them so an ahead/behind-only
  // change (e.g. a background fetch that only moved origin/<branch>) is a
  // non-empty delta and reaches the badge, instead of being short-circuited by
  // the >1-key emit gate in the worker entry.
  if (prev.ahead !== next.ahead) out.ahead = next.ahead
  if (prev.behind !== next.behind) out.behind = next.behind
  if (prev.status !== next.status) out.status = next.status
  if (prev.submodulesLoading !== next.submodulesLoading) out.submodulesLoading = next.submodulesLoading
  if (!sameFileList(prev.files, next.files)) out.files = next.files
  if (!sameRepos(prev.repos, next.repos)) out.repos = next.repos
  if (prev.changeFingerprint !== next.changeFingerprint) out.changeFingerprint = next.changeFingerprint
  // Generation is always included when it changed — Refresh Changes
  // is the trigger that bumps generation even when underlying data
  // (branch/status/files) is byte-identical.
  if (prev.generation !== next.generation) out.generation = next.generation
  return out
}

function sameFileList(a: MirrorState['files'], b: MirrorState['files']): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i += 1) {
    const x = a[i]
    const y = b[i]
    if (x.filename !== y.filename
      || x.status !== y.status
      || x.changeType !== y.changeType
      || (x.originalFilename ?? null) !== (y.originalFilename ?? null)
      || (x.repoRoot ?? null) !== (y.repoRoot ?? null)
    ) {
      return false
    }
  }
  return true
}

function sameRepos(a: MirrorState['repos'], b: MirrorState['repos']): boolean {
  if (!a && !b) return true
  if (!a || !b) return false
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i += 1) {
    const x = a[i]
    const y = b[i]
    if (x.root !== y.root || x.label !== y.label || x.changeCount !== y.changeCount || (x.loading ?? false) !== (y.loading ?? false)) {
      return false
    }
  }
  return true
}
