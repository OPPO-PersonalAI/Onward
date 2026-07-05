/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 *
 * Usage: node --experimental-strip-types --test test/unittest/git-diff-open-skeleton-entries.test.mts
 *
 * Locks the G4 mirror-snapshot → open-skeleton mapping (2026-07-04 spinner
 * analysis): defensive normalization, stable dedup keys, and the render cap,
 * so the loading shell can trust the entries without re-validating.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  buildOpenSkeletonEntries,
  OPEN_SKELETON_MAX_ENTRIES
} from '../../src/components/GitDiffViewer/openSkeletonEntries.ts'

test('maps well-formed mirror files to display rows, preserving order', () => {
  const rows = buildOpenSkeletonEntries([
    { filename: 'src/a.ts', status: 'M', changeType: 'unstaged' },
    { filename: 'docs/b.md', status: '?', changeType: 'untracked' }
  ])
  assert.deepEqual(rows.map((r) => r.filename), ['src/a.ts', 'docs/b.md'])
  assert.deepEqual(rows.map((r) => r.status), ['M', '?'])
  assert.deepEqual(rows.map((r) => r.key), ['unstaged::src/a.ts', 'untracked::docs/b.md'])
})

test('null / empty / malformed inputs degrade to an empty list (anonymous shimmer fallback)', () => {
  assert.deepEqual(buildOpenSkeletonEntries(null), [])
  assert.deepEqual(buildOpenSkeletonEntries(undefined), [])
  assert.deepEqual(buildOpenSkeletonEntries([]), [])
  assert.deepEqual(buildOpenSkeletonEntries([null, 42, 'nope', {}, { filename: '' }] as unknown[]), [])
})

test('missing status falls back to "?", missing changeType to empty — filename is the only hard requirement', () => {
  const rows = buildOpenSkeletonEntries([{ filename: 'x.txt' }])
  assert.equal(rows.length, 1)
  assert.equal(rows[0].status, '?')
  assert.equal(rows[0].changeType, '')
})

test('duplicate (filename, changeType) pairs dedup to one row; same file staged+unstaged keeps both', () => {
  const rows = buildOpenSkeletonEntries([
    { filename: 'a.ts', status: 'M', changeType: 'unstaged' },
    { filename: 'a.ts', status: 'M', changeType: 'unstaged' },
    { filename: 'a.ts', status: 'M', changeType: 'staged' }
  ])
  assert.equal(rows.length, 2)
})

test('caps at OPEN_SKELETON_MAX_ENTRIES so a pathological status cannot jank the shell', () => {
  const files = Array.from({ length: OPEN_SKELETON_MAX_ENTRIES + 50 }, (_, i) => ({
    filename: `f${i}.txt`,
    status: 'M',
    changeType: 'unstaged'
  }))
  assert.equal(buildOpenSkeletonEntries(files).length, OPEN_SKELETON_MAX_ENTRIES)
})
