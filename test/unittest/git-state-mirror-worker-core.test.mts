/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 *
 * Usage: node --experimental-strip-types --test test/unittest/git-state-mirror-worker-core.test.mts
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  addMirrorWatcherGroupEntry,
  beginMirrorRecompute,
  beginMirrorPoll,
  classifyEventPath,
  computeMirrorWatcherBackoffMs,
  completeMirrorAttach,
  computeMirrorDelta,
  createMirrorWorkerEntry,
  finishMirrorPoll,
  finishMirrorRecomputeIfCurrent,
  hardenReadonlyGitEnv,
  isMirrorWatcherPathMissingError,
  MIRROR_WATCHER_IGNORE,
  requestMirrorAttach,
  requestMirrorDetach,
  normaliseMirrorRepoRootKey,
  resolveMirrorWatcherRoot
} from '../../electron/main/git-state-mirror-worker-core.ts'

import type { MirrorState } from '../../electron/main/git-state-mirror-types.ts'

function snapshot(cwd: string, status: MirrorState['status'], capturedAt: number): MirrorState {
  return {
    cwd,
    repoRoot: cwd,
    repoName: 'repo',
    branch: 'main',
    status,
    files: status === 'clean'
      ? []
      : [{
          filename: 'Cargo.lock',
          status: 'M',
          additions: 1,
          deletions: 0,
          changeType: 'unstaged',
          resourceGroup: 'workingTree',
          originalRef: 'index',
          modifiedRef: 'workingTree'
        }],
    capturedAt,
    changeFingerprint: status === 'clean' ? 'clean' : 'modified-v1',
    generation: 1
  }
}

test('worktree lock files are allowed while git-internal lock files are filtered', () => {
  assert.deepEqual(classifyEventPath('/repo/Cargo.lock', '/repo'), {
    drop: false,
    reason: 'allowed'
  })
  assert.deepEqual(classifyEventPath('/repo/yarn.lock', '/repo'), {
    drop: false,
    reason: 'allowed'
  })
  assert.deepEqual(classifyEventPath('C:\\repo\\pnpm-lock.yaml', 'C:\\repo'), {
    drop: false,
    reason: 'allowed'
  })
  assert.deepEqual(classifyEventPath('/repo/.git/index.lock', '/repo'), {
    drop: true,
    reason: 'lockfile'
  })
  assert.deepEqual(classifyEventPath('C:\\repo\\.git\\index.lock', 'C:\\repo'), {
    drop: true,
    reason: 'lockfile'
  })
})

test('atomic-save temp files are dropped while the real file is allowed (kar-qemu kar_air_control.py churn)', () => {
  // `.tmp.<pid>.<hash>` write-temp-then-rename artifacts (observed: a background
  // process rewriting tools/kar_air_control.py fired 11 events from these temps).
  assert.deepEqual(
    classifyEventPath('/repo/tools/kar_air_control.py.tmp.7432.3fe8206c1a01', '/repo'),
    { drop: true, reason: 'tmpfile' }
  )
  assert.deepEqual(
    classifyEventPath('C:\\repo\\tools\\kar_air_control.py.tmp.7432.9ccfbe7edbb5', 'C:\\repo'),
    { drop: true, reason: 'tmpfile' }
  )
  // The REAL file (the rename target) must still be allowed -> triggers recompute.
  assert.deepEqual(
    classifyEventPath('/repo/tools/kar_air_control.py', '/repo'),
    { drop: false, reason: 'allowed' }
  )
  // Legitimate files that merely contain "tmp" or digits must NOT be dropped.
  assert.deepEqual(classifyEventPath('/repo/config.tmp.json', '/repo'), { drop: false, reason: 'allowed' })
  assert.deepEqual(classifyEventPath('/repo/foo.tmp', '/repo'), { drop: false, reason: 'allowed' })
  assert.deepEqual(classifyEventPath('/repo/v2.0.1.md', '/repo'), { drop: false, reason: 'allowed' })
  assert.deepEqual(classifyEventPath('/repo/main.c', '/repo'), { drop: false, reason: 'allowed' })
})

test('git watcher allowlist still permits durable git state files', () => {
  assert.deepEqual(classifyEventPath('/repo/.git/index', '/repo'), {
    drop: false,
    reason: 'allowed'
  })
  assert.deepEqual(classifyEventPath('/repo/.git/refs/heads/main', '/repo'), {
    drop: false,
    reason: 'allowed'
  })
  assert.deepEqual(classifyEventPath('/repo/.git/logs/HEAD', '/repo'), {
    drop: false,
    reason: 'allowed'
  })
  assert.deepEqual(classifyEventPath('/repo/.git/logs/refs/heads/main', '/repo'), {
    drop: false,
    reason: 'allowed'
  })
  assert.deepEqual(classifyEventPath('C:\\repo\\.git\\logs\\refs\\heads\\main', 'C:\\repo'), {
    drop: false,
    reason: 'allowed'
  })
  assert.deepEqual(classifyEventPath('/repo/.git/objects/ab/cdef', '/repo'), {
    drop: true,
    reason: 'gitObjects'
  })
  assert.deepEqual(classifyEventPath('/repo/.git/logs/HEAD.lock', '/repo'), {
    drop: true,
    reason: 'lockfile'
  })
})

test('classifyEventPath filters NESTED submodule .git churn (Windows invalidation-storm fix)', () => {
  // A submodule with a classic-layout .git directory: its index.lock churn
  // (from the user's git, or our own probes) must NOT fire the parent watcher.
  assert.deepEqual(
    classifyEventPath('/repo/src/third_party/KAR/.git/index.lock', '/repo'),
    { drop: true, reason: 'lockfile' }
  )
  assert.deepEqual(
    classifyEventPath('C:\\repo\\src\\third_party\\KAR\\.git\\index.lock', 'C:\\repo'),
    { drop: true, reason: 'lockfile' }
  )
  assert.deepEqual(
    classifyEventPath('/repo/sub/.git/objects/ab/cdef', '/repo'),
    { drop: true, reason: 'gitObjects' }
  )
  // A real submodule state change (HEAD / index) is still allowed to fire.
  assert.deepEqual(
    classifyEventPath('/repo/sub/.git/HEAD', '/repo'),
    { drop: false, reason: 'allowed' }
  )
  // A submodule WORKING-TREE file change is a real change → must still fire.
  assert.deepEqual(
    classifyEventPath('/repo/src/third_party/KAR/lib/widget.c', '/repo'),
    { drop: false, reason: 'allowed' }
  )
  // The submodule .git entry node itself is internal noise.
  assert.deepEqual(
    classifyEventPath('/repo/sub/.git', '/repo'),
    { drop: true, reason: 'gitInternal' }
  )
})

test('Parcel ignore list keeps durable git state files visible', () => {
  const ignored = new Set<string>(MIRROR_WATCHER_IGNORE as readonly string[])
  assert.equal(ignored.has('.git/objects/**'), true)
  assert.equal(ignored.has('node_modules/**'), true)
  assert.equal(ignored.has('.git/index'), false)
  assert.equal(ignored.has('.git/HEAD'), false)
  assert.equal(ignored.has('.git/refs/**'), false)
  assert.equal(ignored.has('.git/packed-refs'), false)
})

test('hardenReadonlyGitEnv disables git optional locks without mutating the input', () => {
  const base: NodeJS.ProcessEnv = { PATH: '/usr/bin:/bin', HOME: '/home/me' }
  const hardened = hardenReadonlyGitEnv(base)
  // GIT_OPTIONAL_LOCKS=0 stops `git status` from refreshing/rewriting .git/index,
  // which would otherwise re-trigger the mirror watcher (self-recompute storm).
  assert.equal(hardened.GIT_OPTIONAL_LOCKS, '0')
  // Upstream PATH augmentation and other env keys must survive untouched.
  assert.equal(hardened.PATH, '/usr/bin:/bin')
  assert.equal(hardened.HOME, '/home/me')
  // Pure function: the caller's env object is not mutated.
  assert.equal(base.GIT_OPTIONAL_LOCKS, undefined)
})

test('watcher backoff uses 800/1600/3200/5000 cap', () => {
  assert.equal(computeMirrorWatcherBackoffMs(0), 800)
  assert.equal(computeMirrorWatcherBackoffMs(1), 800)
  assert.equal(computeMirrorWatcherBackoffMs(2), 1600)
  assert.equal(computeMirrorWatcherBackoffMs(3), 3200)
  assert.equal(computeMirrorWatcherBackoffMs(4), 5000)
  assert.equal(computeMirrorWatcherBackoffMs(99), 5000)
})

test('path missing errors are classified for suspended watcher state', () => {
  assert.equal(isMirrorWatcherPathMissingError(Object.assign(new Error('ENOENT: no such file or directory'), { code: 'ENOENT' })), true)
  assert.equal(isMirrorWatcherPathMissingError(new Error('watched path does not exist')), true)
  assert.equal(isMirrorWatcherPathMissingError(new Error('permission denied')), false)
})

test('watcher root is only armed for resolved git repositories', () => {
  // Use platform-native absolute paths so path.resolve() (called inside
  // resolveMirrorWatcherRoot) is an identity transform and does not prepend
  // the current drive letter to a POSIX-style /Users/... path on Windows.
  const testRepoRoot = process.platform === 'win32'
    ? 'C:\\Users\\test\\Projects\\repo'
    : '/Users/test/Projects/repo'
  const testSubdirCwd = process.platform === 'win32'
    ? 'C:\\Users\\test\\Projects\\repo\\packages\\app'
    : '/Users/test/Projects/repo/packages/app'

  const nonRepo: MirrorState = {
    cwd: testRepoRoot,
    repoRoot: null,
    repoName: null,
    branch: null,
    status: null,
    files: [],
    capturedAt: 100,
    changeFingerprint: '',
    generation: 1
  }
  const subdirRepo: MirrorState = {
    cwd: testSubdirCwd,
    repoRoot: testRepoRoot,
    repoName: 'repo',
    branch: 'main',
    status: 'clean',
    files: [],
    capturedAt: 100,
    changeFingerprint: 'clean',
    generation: 1
  }

  assert.equal(resolveMirrorWatcherRoot(nonRepo), null)
  assert.equal(resolveMirrorWatcherRoot(subdirRepo), testRepoRoot)
})

test('detach while attach is in flight disposes the late watcher handle', async () => {
  const entry = createMirrorWorkerEntry('/repo')
  const calls: string[] = []

  assert.equal(requestMirrorAttach(entry), 'start')
  assert.equal(await requestMirrorDetach(entry), 'pending-attach')
  assert.equal(entry.attachInFlight, true)
  assert.equal(entry.detachRequested, true)

  const completed = await completeMirrorAttach(entry, async () => {
    calls.push('unsubscribe')
  })

  assert.equal(completed, 'detached')
  assert.deepEqual(calls, ['unsubscribe'])
  assert.equal(entry.attachInFlight, false)
  assert.equal(entry.watcherDispose, null)
})

test('detach clears debounce/restart/poll/probe timers and pending paths', async () => {
  const entry = createMirrorWorkerEntry('/repo')
  entry.pendingPaths.add('/repo/file.txt')
  entry.pendingSince = 123
  entry.debounceTimer = setTimeout(() => {}, 10_000)
  entry.restartTimer = setTimeout(() => {}, 10_000)
  entry.pollTimer = setTimeout(() => {}, 10_000)
  entry.suspendedProbeTimer = setTimeout(() => {}, 10_000)

  const result = await requestMirrorDetach(entry)

  assert.equal(result, 'idle')
  assert.equal(entry.debounceTimer, null)
  assert.equal(entry.restartTimer, null)
  assert.equal(entry.pollTimer, null)
  assert.equal(entry.suspendedProbeTimer, null)
  assert.equal(entry.pendingSince, null)
  assert.equal(entry.pendingPaths.size, 0)
})

test('rapid resubscribe cancels a pending detach during attach', async () => {
  const entry = createMirrorWorkerEntry('/repo')
  const calls: string[] = []

  assert.equal(requestMirrorAttach(entry), 'start')
  assert.equal(await requestMirrorDetach(entry), 'pending-attach')
  assert.equal(requestMirrorAttach(entry), 'resume-in-flight')

  const completed = await completeMirrorAttach(entry, async () => {
    calls.push('unsubscribe')
  })

  assert.equal(completed, 'attached')
  assert.deepEqual(calls, [])
  assert.equal(entry.attachInFlight, false)
  assert.equal(entry.detachRequested, false)
  assert.equal(typeof entry.watcherDispose, 'function')
})

test('newer recompute wins over stale in-flight recompute completion', () => {
  const entry = createMirrorWorkerEntry('/repo')
  const oldGeneration = beginMirrorRecompute(entry)
  const newGeneration = beginMirrorRecompute(entry)

  const newDelta = finishMirrorRecomputeIfCurrent(entry, newGeneration, snapshot(entry.cwd, 'modified', 200))
  const oldDelta = finishMirrorRecomputeIfCurrent(entry, oldGeneration, snapshot(entry.cwd, 'clean', 100))

  assert.notEqual(newDelta, null)
  assert.equal(oldDelta, null)
  assert.equal(entry.state?.status, 'modified')
  assert.equal(entry.state?.capturedAt, 200)
})

test('poll in flight skips next tick until current poll finishes', () => {
  const entry = createMirrorWorkerEntry('/repo')
  assert.equal(beginMirrorPoll(entry), 'start')
  assert.equal(beginMirrorPoll(entry), 'skip-in-flight')
  finishMirrorPoll(entry)
  assert.equal(beginMirrorPoll(entry), 'start')
  finishMirrorPoll(entry)
})

test('repo root dedupe reuses one watcher for cwd and subdir', () => {
  const groups = new Map()
  const root = '/Users/test/Projects/repo'
  const first = addMirrorWatcherGroupEntry(groups, root, root)
  const second = addMirrorWatcherGroupEntry(groups, root, `${root}/packages/app`)

  assert.equal(first.created, true)
  assert.equal(second.created, false)
  assert.equal(groups.size, 1)
  assert.equal(first.group, second.group)
  assert.equal(second.group.entries.size, 2)
})

test('repo root key normalizes Windows drive letter and slashes', () => {
  assert.equal(normaliseMirrorRepoRootKey('C:\\Repo\\Project\\'), 'c:/Repo/Project')
  assert.equal(normaliseMirrorRepoRootKey('c:/Repo/Project'), 'c:/Repo/Project')
})

// ---------------------------------------------------------------------------
// computeMirrorDelta — Phase 2 generation propagation
// ---------------------------------------------------------------------------

function stateWithGen(cwd: string, status: MirrorState['status'], generation: number): MirrorState {
  return {
    cwd,
    repoRoot: cwd,
    repoName: 'repo',
    branch: 'main',
    status,
    files: [],
    capturedAt: Date.now(),
    changeFingerprint: 'same',
    generation
  }
}

test('computeMirrorDelta seeds generation on the first snapshot (prev === null)', () => {
  const next = stateWithGen('/repo', 'clean', 7)
  const delta = computeMirrorDelta(null, next)
  // First snapshot is treated as a full carry-through; generation must
  // be present so the renderer can seed its identity-key correctly.
  assert.equal((delta as MirrorState).generation, 7)
})

test('computeMirrorDelta carries generation only when it changed', () => {
  const prev = stateWithGen('/repo', 'clean', 5)
  const sameGen = stateWithGen('/repo', 'modified', 5)
  const bumpedGen = stateWithGen('/repo', 'modified', 6)

  const sameDelta = computeMirrorDelta(prev, sameGen)
  // status flipped clean → modified, but generation stayed the same:
  // the delta carries the status change without re-stating generation.
  assert.equal(sameDelta.status, 'modified')
  assert.equal((sameDelta as Partial<MirrorState>).generation, undefined)

  const bumpDelta = computeMirrorDelta(prev, bumpedGen)
  // Both status AND generation changed — both surface in the delta so
  // the renderer can both update branch chip AND remount the editor.
  assert.equal(bumpDelta.status, 'modified')
  assert.equal((bumpDelta as MirrorState).generation, 6)
})

test('computeMirrorDelta surfaces a pure-generation bump even when content is byte-identical', () => {
  // This is the "Refresh Changes" path. State is structurally the same
  // (same branch / status / files) — only generation incremented.
  // The delta MUST carry the new generation so the renderer's
  // DiffEditor key changes and the mount lifecycle resets.
  const prev = stateWithGen('/repo', 'modified', 3)
  const next = stateWithGen('/repo', 'modified', 4)
  const delta = computeMirrorDelta(prev, next)
  assert.equal((delta as MirrorState).generation, 4)
  // Other fields are unchanged and should NOT bloat the delta.
  assert.equal(delta.status, undefined)
  assert.equal(delta.repoRoot, undefined)
  assert.equal(delta.files, undefined)
})

test('computeMirrorDelta surfaces a changed-resource fingerprint when status shape is unchanged', () => {
  const prev = snapshot('/repo', 'modified', 100)
  const next = {
    ...snapshot('/repo', 'modified', 200),
    changeFingerprint: 'modified-v2'
  }

  const delta = computeMirrorDelta(prev, next)
  assert.equal(delta.changeFingerprint, 'modified-v2')
  assert.equal(delta.status, undefined)
  assert.equal(delta.files, undefined)
})

test('computeMirrorDelta surfaces a ref-only move (refsDigest changed) as a minimal NON-EMPTY delta — the push freshness signal', () => {
  // A `git push` advances origin/<branch> without moving HEAD: branchOid / status
  // / files are byte-identical, only refsDigest moves. The delta MUST carry
  // refsDigest so the worker-entry short-circuit (`Object.keys(delta).length <= 1`)
  // passes and a mirror-update broadcasts → the History cache re-keys. Without
  // this, the ref move would be swallowed (the original phantom-fork-after-push bug).
  const prev = { ...stateWithGen('/repo', 'clean', 1), refsDigest: 'refs-pre' }
  const next = { ...stateWithGen('/repo', 'clean', 1), refsDigest: 'refs-post' }
  const delta = computeMirrorDelta(prev, next)
  assert.equal(delta.refsDigest, 'refs-post')
  // Unchanged dimensions must NOT bloat the delta.
  assert.equal(delta.status, undefined)
  assert.equal(delta.files, undefined)
  assert.equal((delta as Partial<MirrorState>).branchOid, undefined)
  // Non-empty beyond capturedAt → the broadcast fires.
  assert.ok(Object.keys(delta).length > 1)
})

test('computeMirrorDelta seeds refsDigest on the first snapshot (prev === null)', () => {
  const next = { ...stateWithGen('/repo', 'clean', 1), refsDigest: 'refs-seed' }
  const delta = computeMirrorDelta(null, next)
  assert.equal(delta.refsDigest, 'refs-seed')
})
