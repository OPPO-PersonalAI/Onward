/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 *
 * Usage: node --experimental-strip-types --test test/unittest/git-cat-file-batch-mutable-ref.test.mts
 *
 * Locks the `isMutableIndexRef` classifier — the contract that decides which
 * cat-file refs read the MUTABLE index (`:<path>`) vs. an IMMUTABLE object
 * (HEAD:path, <commit>:path, blob oids). Index refs are NO LONGER barred from
 * the long-running `git cat-file --batch`; instead they carry an
 * index-generation token so the batch respawns when the index mutates (the
 * freshness decision is pinned in git-cat-file-index-freshness.test.mts). This
 * classifier still decides WHICH reads need that token (index refs) vs. a null
 * token (immutable refs), so its stability is what keeps the right reads gated.
 * The end-to-end staged/unstaged content behaviour is locked by
 * run-git-diff-staleness-and-submodule (GDS-22 / GDS-33).
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { isMutableIndexRef } from '../../electron/main/git-cat-file-ref.ts'

test('index refs (mutable) are classified as needing a freshness token', () => {
  assert.equal(isMutableIndexRef(':src/main.txt'), true)   // index entry
  assert.equal(isMutableIndexRef(':0:src/main.txt'), true) // stage 0 (merged)
  assert.equal(isMutableIndexRef(':1:src/main.txt'), true) // stage 1 (base, conflict)
  assert.equal(isMutableIndexRef(':2:src/main.txt'), true) // stage 2 (ours)
  assert.equal(isMutableIndexRef(':3:src/main.txt'), true) // stage 3 (theirs)
})

test('immutable refs are not flagged mutable (null token, no respawn)', () => {
  assert.equal(isMutableIndexRef('HEAD:src/main.txt'), false)
  assert.equal(isMutableIndexRef('abc1234:src/main.txt'), false) // <commit>:path
  assert.equal(isMutableIndexRef('e69de29bb2d1d6434b8b29ae775ad8c2e48c5391'), false) // blob oid
  assert.equal(isMutableIndexRef('main:src/main.txt'), false) // branch:path
})
