/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 *
 * Lifecycle tests for the renderer-side file-index MIRROR used by the
 * ProjectEditor filename search (Cmd+P).
 *
 * Usage: node --experimental-strip-types --test test/unittest/file-index-cache.test.mts
 *
 * Scope note: the mirror holds METADATA ONLY (status + fileCount). The path
 * list and the incremental add/remove/rename rules live in the authoritative
 * main-process worker and in the shared `src/utils/file-index-patch.ts`
 * respectively — the mutation cases that used to live in this file moved to
 * `file-index-authority.test.mts` (FIC-U-2) when that duplication was removed.
 * What remains here is the part the mirror still owns:
 *   - Open the same project from multiple Tabs/Tasks → walker runs ONCE per
 *     normalized cwd.
 *   - Repeatedly invoke global search → walker must not re-run while the entry
 *     is ready.
 *   - Subscription, LRU eviction, watcher-adapter lifecycle, and the guarantee
 *     that a stale in-flight build cannot overwrite newer state.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  disposeAll,
  dispose,
  ensureIndex,
  getIndexSnapshot,
  invalidate,
  isIndexReady,
  recordAuthoritativeCount,
  setFileIndexWatcherAdapter,
  subscribe,
  __getInternalStateForTest
} from '../../src/components/ProjectEditor/GlobalSearch/fileIndexCache.ts'

type WalkerCall = { cwd: string; at: number }

function makeWalker(files: string[], opts?: { delayMs?: number; track?: WalkerCall[] }) {
  const delay = opts?.delayMs ?? 0
  const track = opts?.track
  let calls = 0
  const walker = async (cwd: string): Promise<string[]> => {
    calls += 1
    if (track) track.push({ cwd, at: Date.now() })
    if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay))
    return [...files]
  }
  return {
    walker,
    get calls() {
      return calls
    }
  }
}

function resetCache() {
  setFileIndexWatcherAdapter(null)
  disposeAll()
}

test('ensureIndex builds once and serves the cached result on subsequent calls', async () => {
  resetCache()
  const w = makeWalker(['a.ts', 'b.ts'])
  const first = await ensureIndex('/project/alpha', w.walker)
  assert.deepEqual(first.files, ['a.ts', 'b.ts'], 'a fresh build passes the walked paths through')
  assert.equal(first.fileCount, 2)
  assert.equal(w.calls, 1)

  const second = await ensureIndex('/project/alpha', w.walker)
  assert.equal(w.calls, 1, 'walker must not run for a second search on the same cwd')
  assert.equal(second.files, null, 'a cache hit reports that nothing was walked')
  assert.equal(second.fileCount, 2, 'the count still comes back on a cache hit')

  const third = await ensureIndex('/project/alpha', w.walker)
  assert.equal(w.calls, 1, 'walker must not run for a third search either')
  assert.equal(third.files, null)
})

test('multiple concurrent ensureIndex calls dedupe to ONE walker invocation', async () => {
  resetCache()
  const w = makeWalker(['only.ts'], { delayMs: 30 })
  // Simulates: two Tabs both pointing at the same cwd opening Cmd+P at the same moment.
  const [a, b, c] = await Promise.all([
    ensureIndex('/project/beta', w.walker),
    ensureIndex('/project/beta', w.walker),
    ensureIndex('/project/beta', w.walker)
  ])
  assert.deepEqual(a.files, ['only.ts'])
  assert.deepEqual(b.files, ['only.ts'])
  assert.deepEqual(c.files, ['only.ts'])
  assert.equal(w.calls, 1, 'concurrent callers must share a single in-flight build')
})

test('distinct cwds keep independent cache entries', async () => {
  resetCache()
  const wA = makeWalker(['a1.ts', 'a2.ts'])
  const wB = makeWalker(['b1.ts', 'b2.ts'])
  const a1 = await ensureIndex('/project/a', wA.walker)
  const b1 = await ensureIndex('/project/b', wB.walker)
  const a2 = await ensureIndex('/project/a', wA.walker)
  const b2 = await ensureIndex('/project/b', wB.walker)
  assert.equal(wA.calls, 1)
  assert.equal(wB.calls, 1)
  assert.deepEqual(a1.files, ['a1.ts', 'a2.ts'])
  assert.equal(a2.files, null, 'second visit is a cache hit')
  assert.equal(a2.fileCount, 2)
  assert.deepEqual(b1.files, ['b1.ts', 'b2.ts'])
  assert.equal(b2.files, null)
  assert.equal(b2.fileCount, 2)
})

test('Windows-style backslashes normalize to the same entry as POSIX-style', async () => {
  resetCache()
  const w = makeWalker(['f.ts'])
  await ensureIndex('C:\\project\\gamma', w.walker)
  await ensureIndex('C:/project/gamma', w.walker)
  assert.equal(w.calls, 1, 'normalized cwd must match across platforms')
})

test('invalidate clears the entry and the next ensureIndex rebuilds', async () => {
  resetCache()
  const w = makeWalker(['one.ts'])
  await ensureIndex('/p', w.walker)
  assert.equal(w.calls, 1)
  invalidate('/p')
  const after = await ensureIndex('/p', w.walker)
  assert.equal(w.calls, 2)
  assert.deepEqual(after.files, ['one.ts'], 'a rebuild walks again and returns the paths')
})

test('invalidating one cwd does not affect a sibling cwd', async () => {
  resetCache()
  const wA = makeWalker(['a.ts'])
  const wB = makeWalker(['b.ts'])
  await ensureIndex('/p/a', wA.walker)
  await ensureIndex('/p/b', wB.walker)
  invalidate('/p/a')
  await ensureIndex('/p/b', wB.walker)
  assert.equal(wB.calls, 1, 'sibling cwd must still serve from cache')
  await ensureIndex('/p/a', wA.walker)
  assert.equal(wA.calls, 2, 'invalidated cwd rebuilds on next ensure')
})

test('the mirror exposes a count, never a path list', async () => {
  resetCache()
  const w = makeWalker(['x.ts', 'y.ts', 'z.ts'])
  await ensureIndex('/p', w.walker)
  const snap = getIndexSnapshot('/p')
  assert.equal(snap.status, 'ready')
  assert.equal(snap.fileCount, 3)
  assert.ok(
    !('files' in (snap as Record<string, unknown>)),
    'the mirror must not carry a path list; the worker index is the authority'
  )
  assert.equal(isIndexReady('/p'), true)
})

test('recordAuthoritativeCount adopts the worker-reported count verbatim', async () => {
  resetCache()
  const w = makeWalker(['x.ts'])
  await ensureIndex('/p', w.walker)
  assert.equal(getIndexSnapshot('/p').fileCount, 1)

  // The worker applied a patch and reported the post-patch total. The mirror
  // records it rather than deriving its own, which is what makes the two
  // structurally unable to disagree.
  recordAuthoritativeCount('/p', 42)
  assert.equal(getIndexSnapshot('/p').fileCount, 42)
  assert.equal(w.calls, 1, 'adopting a count must never trigger a rebuild')
})

test('recordAuthoritativeCount no-ops when the entry is not ready', async () => {
  resetCache()
  recordAuthoritativeCount('/never-built', 99)
  const snap = getIndexSnapshot('/never-built')
  assert.equal(snap.status, 'idle')
  assert.equal(snap.fileCount, 0)
})

test('subscribe notifies on build, count change, and invalidation', async () => {
  resetCache()
  let count = 0
  const unsubscribe = subscribe('/p', () => {
    count += 1
  })
  const w = makeWalker(['a.ts'])
  await ensureIndex('/p', w.walker)
  assert.equal(count, 1, 'initial build notifies')
  recordAuthoritativeCount('/p', 5)
  assert.equal(count, 2, 'a changed authoritative count notifies')
  recordAuthoritativeCount('/p', 5)
  assert.equal(count, 2, 'an unchanged count must NOT wake every subscriber')
  invalidate('/p')
  assert.equal(count, 3, 'invalidate notifies')
  unsubscribe()
})

test('subscribe listener does not fire after unsubscribe', async () => {
  resetCache()
  let count = 0
  const unsubscribe = subscribe('/p', () => {
    count += 1
  })
  unsubscribe()
  const w = makeWalker(['a.ts'])
  await ensureIndex('/p', w.walker)
  recordAuthoritativeCount('/p', 7)
  assert.equal(count, 0)
})

test('watcher adapter.start runs after the initial build, adapter.stop on dispose', async () => {
  resetCache()
  const started: string[] = []
  const stopped: string[] = []
  setFileIndexWatcherAdapter({
    start: (cwd) => {
      started.push(cwd)
    },
    stop: (cwd) => {
      stopped.push(cwd)
    }
  })
  const w = makeWalker(['a.ts'])
  await ensureIndex('/project/wat', w.walker)
  assert.deepEqual(started, ['/project/wat'])
  // Ensure a second ensureIndex does not re-start the watcher.
  await ensureIndex('/project/wat', w.walker)
  assert.deepEqual(started, ['/project/wat'])
  dispose('/project/wat')
  assert.deepEqual(stopped, ['/project/wat'])
})

test('LRU evicts oldest unsubscribed entries when >8 are tracked', async () => {
  resetCache()
  for (let i = 0; i < 10; i += 1) {
    const w = makeWalker([`f${i}.ts`])
    // Space starts so lastTouched times differ.
    await ensureIndex(`/p/${i}`, w.walker)
    await new Promise((r) => setTimeout(r, 2))
  }
  const state = __getInternalStateForTest()
  assert.equal(state.size, 8, 'cache size is capped at 8')
  // The two oldest (indices 0 and 1) must have been evicted.
  assert.equal(state.snapshot('/p/0').status, 'idle', '/p/0 should have been evicted')
  assert.equal(state.snapshot('/p/1').status, 'idle', '/p/1 should have been evicted')
  assert.equal(state.snapshot('/p/9').status, 'ready', '/p/9 (most recent) still cached')
})

test('LRU respects subscribers — entries with listeners are not evicted', async () => {
  resetCache()
  // Pin /p/0 with a listener.
  const unsub = subscribe('/p/0', () => {})
  const w0 = makeWalker(['z.ts'])
  await ensureIndex('/p/0', w0.walker)
  // Fill up past the cap.
  for (let i = 1; i < 12; i += 1) {
    const w = makeWalker([`f${i}.ts`])
    await ensureIndex(`/p/${i}`, w.walker)
    await new Promise((r) => setTimeout(r, 1))
  }
  const state = __getInternalStateForTest()
  assert.equal(state.snapshot('/p/0').status, 'ready', 'subscribed entry must survive LRU')
  unsub()
})

test(
  'multi-tab scenario: two simulated Tabs, both searching the same project repeatedly, share ONE build',
  async () => {
    resetCache()
    const track: WalkerCall[] = []
    const w = makeWalker(
      Array.from({ length: 1000 }, (_, i) => `src/file${i}.ts`),
      { delayMs: 20, track }
    )
    // Tab A mounts, opens Cmd+P.
    const tabA_firstOpen = ensureIndex('/repo', w.walker)
    // Tab B mounts for the same project and opens Cmd+P at the same moment.
    const tabB_firstOpen = ensureIndex('/repo', w.walker)
    const [aList, bList] = await Promise.all([tabA_firstOpen, tabB_firstOpen])
    assert.equal(aList.fileCount, 1000)
    assert.equal(bList.fileCount, 1000)
    assert.equal(track.length, 1, 'both Tabs must share the same initial walker call')

    // Simulate each Tab typing a query 10 times: each keystroke reads the snapshot.
    for (let i = 0; i < 10; i += 1) {
      const snapA = getIndexSnapshot('/repo')
      const snapB = getIndexSnapshot('/repo')
      assert.equal(snapA.fileCount, 1000)
      assert.equal(snapB.fileCount, 1000)
    }
    // And re-trigger ensureIndex as each Tab re-opens the search.
    for (let i = 0; i < 5; i += 1) {
      await ensureIndex('/repo', w.walker)
      await ensureIndex('/repo', w.walker)
    }
    assert.equal(track.length, 1, 'no additional walker runs across 20 repeat opens')
  }
)

test('multi-project scenario: switching between projects never reloads the same cache twice', async () => {
  resetCache()
  const walkers: Record<string, { walker: (cwd: string) => Promise<string[]>; calls: number }> = {}
  for (const id of ['one', 'two', 'three']) {
    const w = makeWalker([`${id}/a.ts`, `${id}/b.ts`])
    walkers[id] = {
      walker: w.walker,
      get calls() {
        return w.calls
      }
    } as any
  }
  // User switches tabs 6 times across 3 projects.
  const sequence = ['one', 'two', 'three', 'one', 'two', 'three', 'one']
  for (const id of sequence) {
    await ensureIndex(`/repo/${id}`, walkers[id].walker)
  }
  for (const id of ['one', 'two', 'three']) {
    assert.equal(walkers[id].calls, 1, `project ${id} built exactly once across repeat visits`)
  }
})

test('invalidation during in-flight build does not let a stale walker overwrite newer state', async () => {
  resetCache()
  let firstWalkResolve: (value: string[]) => void = () => {}
  const firstWalk = new Promise<string[]>((resolve) => {
    firstWalkResolve = resolve
  })
  const walkerSlow = async (): Promise<string[]> => firstWalk
  const walkerFast = async (): Promise<string[]> => ['fast.ts']

  const slowBuild = ensureIndex('/p', walkerSlow)
  invalidate('/p')
  const fastBuild = await ensureIndex('/p', walkerFast)
  assert.deepEqual(fastBuild.files, ['fast.ts'])
  assert.equal(getIndexSnapshot('/p').fileCount, 1)

  // Now resolve the stale walker (2 files) — it must NOT overwrite the newer
  // ready state, which would show up here as a count of 2.
  firstWalkResolve(['stale-one.ts', 'stale-two.ts'])
  await slowBuild.catch(() => {})
  assert.equal(getIndexSnapshot('/p').fileCount, 1, 'stale walker must not clobber newer state')
})
