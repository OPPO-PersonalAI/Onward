/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 *
 * Usage: node --experimental-strip-types --test test/unittest/git-cat-file-index-freshness.test.mts
 *
 * Locks the PURE freshness decision that lets INDEX refs (`:<path>`, the
 * staged/index side of a changed file) be served by the long-running
 * `git cat-file --batch` process WITHOUT ever returning a stale index blob.
 *
 * Background (the invariant this guards — GDS-22 / GDS-33): `cat-file --batch`
 * snapshots the index in memory at PROCESS START. A long-lived batch spawned
 * BEFORE a `git add` / stage / partial-stage would serve the pre-mutation index
 * — surfaced historically as staged diffs showing HEAD/base content on both
 * sides. The fix tags every index read with an index-generation token
 * (`mtime:size` of `.git/index`) captured at read time and compares it to the
 * token the running process was spawned with; on mismatch the batch is disposed
 * + respawned so the new process snapshots the CURRENT index.
 *
 * `shouldRespawnForIndexGeneration` is that decision distilled to a pure
 * (spawnedToken, requestToken) -> boolean function. The end-to-end behaviour is
 * locked by run-git-diff-staleness-and-submodule (GDS-22/33); this unit test
 * pins the math so a future edit cannot silently re-open the stale-index hole.
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import {
  isMutableIndexRef,
  shouldRespawnForIndexGeneration
} from '../../electron/main/git-cat-file-ref.ts'

// ─────────────── Batch-eligibility predicate (unchanged classifier) ───────────────
// isMutableIndexRef still classifies WHICH refs read the mutable index. Index
// refs are no longer barred from the batch, but the classifier decides which
// reads need an index-generation token (index refs) vs. a null token (immutable
// refs). These cases pin that the classifier itself did not drift.
test('isMutableIndexRef flags index refs (need a freshness token)', () => {
  assert.equal(isMutableIndexRef(':src/main.txt'), true)   // index entry
  assert.equal(isMutableIndexRef(':0:src/main.txt'), true) // stage 0 (merged)
  assert.equal(isMutableIndexRef(':1:src/main.txt'), true) // stage 1 (base, conflict)
  assert.equal(isMutableIndexRef(':2:src/main.txt'), true) // stage 2 (ours)
  assert.equal(isMutableIndexRef(':3:src/main.txt'), true) // stage 3 (theirs)
})

test('isMutableIndexRef does NOT flag immutable refs (null token, no respawn)', () => {
  assert.equal(isMutableIndexRef('HEAD:src/main.txt'), false)
  assert.equal(isMutableIndexRef('abc1234:src/main.txt'), false) // <commit>:path
  assert.equal(isMutableIndexRef('e69de29bb2d1d6434b8b29ae775ad8c2e48c5391'), false) // blob oid
  assert.equal(isMutableIndexRef('main:src/main.txt'), false) // branch:path
})

// ─────────────── Freshness decision (the GDS-22/33 guard) ───────────────

test('immutable ref (null request token) never forces a respawn', () => {
  // Immutable objects (HEAD:path, commit:path, blob oid) carry a null token —
  // index churn cannot affect them, so the batch stays alive regardless of what
  // it spawned with. This is the common, hot, no-spawn path for the base side.
  assert.equal(shouldRespawnForIndexGeneration('1700:120', null), false)
  assert.equal(shouldRespawnForIndexGeneration(null, null), false)
  assert.equal(shouldRespawnForIndexGeneration('-', null), false)
})

test('index ref with an UNCHANGED token reuses the live batch (no respawn)', () => {
  // The hot fast path: repeated index reads while the index is stable answer
  // over the pipe with zero new spawns. This is the entire point of the
  // optimization — collapsing N per-file spawn-pairs into one batch.
  assert.equal(shouldRespawnForIndexGeneration('1700:120', '1700:120'), false)
  assert.equal(shouldRespawnForIndexGeneration('-', '-'), false) // no-index repo, stable
})

test('index ref AFTER an index mutation forces a respawn (GDS-22/33 freshness)', () => {
  // The exact regression GDS-22/33 catch: a stage/unstage rewrites `.git/index`,
  // so its stat token changes. The next index read must NOT reuse the stale
  // snapshot — it must respawn so the new process snapshots the post-mutation
  // index and returns the FRESH staged content.
  assert.equal(shouldRespawnForIndexGeneration('1700:120', '1701:140'), true) // staged: size+mtime changed
  assert.equal(shouldRespawnForIndexGeneration('1700:120', '1700:140'), true) // same mtime, size changed
  assert.equal(shouldRespawnForIndexGeneration('-', '1700:120'), true)        // index created after a no-index spawn
  assert.equal(shouldRespawnForIndexGeneration('1700:120', '-'), true)        // index removed (rare)
})

test('legacy batch (spawned with no token) respawns for the first index read', () => {
  // A process spawned before index-aware spawning (or after a dispose that
  // cleared the token) has spawnedToken === null. Any index read must respawn so
  // we never trust an unknown index snapshot — conservative = fresh, never stale.
  assert.equal(shouldRespawnForIndexGeneration(null, '1700:120'), true)
  assert.equal(shouldRespawnForIndexGeneration(null, '-'), true)
})

test('the freshness decision is monotonic in token equality (no false positives)', () => {
  // Property check: for any non-null tokens, respawn iff they differ. Guards
  // against a future refactor accidentally inverting the comparison (which would
  // either respawn on EVERY read — killing the perf win — or NEVER respawn —
  // re-opening the stale-index hole).
  const tokens = ['1700:120', '1700:121', '1701:120', '-', '0:0']
  for (const a of tokens) {
    for (const b of tokens) {
      assert.equal(
        shouldRespawnForIndexGeneration(a, b),
        a !== b,
        `respawn(${a}, ${b}) should equal (${a} !== ${b})`
      )
    }
  }
})
