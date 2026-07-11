/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 *
 * Unit tests for the markdown session-cache eviction selector: protected keys
 * (each active Task's last markdown file) are exempt from eviction so one
 * Task's browsing cannot destroy another Task's instant-reopen cache.
 * Paired autotest: run-project-editor-markdown-session-restore-autotest.sh
 * (cache-hit reopen paths).
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  selectMarkdownSessionCacheEvictions,
  type MarkdownSessionCacheEvictionEntry
} from '../../src/components/ProjectEditor/utils/markdownSessionCacheEviction.ts'

const HALF_LIFE_MS = 30 * 60 * 1000
const NOW = 1_000_000_000

function entry(key: string, overrides: Partial<MarkdownSessionCacheEvictionEntry> = {}): MarkdownSessionCacheEvictionEntry {
  return {
    key,
    dwellMs: 1000,
    openCount: 1,
    lastAccessedAt: NOW - 1000,
    ...overrides
  }
}

function select(
  entries: MarkdownSessionCacheEvictionEntry[],
  limit: number,
  protectedKeys: string[] = []
): string[] {
  return selectMarkdownSessionCacheEvictions(entries, {
    limit,
    protectedKeys: new Set(protectedKeys),
    now: NOW,
    recencyHalfLifeMs: HALF_LIFE_MS
  })
}

test('MSCE-U-01 no eviction while within the limit', () => {
  assert.deepEqual(select([entry('a'), entry('b')], 2), [])
})

test('MSCE-U-02 evicts the lowest-scored entry when over the limit', () => {
  const cold = entry('cold', { dwellMs: 10, openCount: 1, lastAccessedAt: NOW - 10 * HALF_LIFE_MS })
  const hot = entry('hot', { dwellMs: 60_000, openCount: 9, lastAccessedAt: NOW - 100 })
  const warm = entry('warm', { dwellMs: 20_000, openCount: 3, lastAccessedAt: NOW - 5000 })
  assert.deepEqual(select([cold, hot, warm], 2), ['cold'])
})

test('MSCE-U-03 protected keys are never evicted even when lowest-scored', () => {
  const cold = entry('cold', { dwellMs: 10, openCount: 1, lastAccessedAt: NOW - 10 * HALF_LIFE_MS })
  const hot = entry('hot', { dwellMs: 60_000, openCount: 9 })
  const warm = entry('warm', { dwellMs: 20_000, openCount: 3 })
  assert.deepEqual(select([cold, hot, warm], 2, ['cold']), ['warm'])
})

test('MSCE-U-04 effective limit grows to protected.size + 1', () => {
  const entries = [entry('p1'), entry('p2'), entry('p3'), entry('x')]
  // limit 2 but 3 protected → effective limit 4 → nothing to evict
  assert.deepEqual(select(entries, 2, ['p1', 'p2', 'p3']), [])
})

test('MSCE-U-05 all-protected overshoot evicts nothing rather than a protected entry', () => {
  const entries = [entry('p1'), entry('p2'), entry('p3')]
  assert.deepEqual(select(entries, 1, ['p1', 'p2', 'p3']), [])
})

test('MSCE-U-06 evicts multiple entries when far over the limit, lowest scores first', () => {
  const entries = [
    entry('a', { dwellMs: 100, lastAccessedAt: NOW - 8 * HALF_LIFE_MS }),
    entry('b', { dwellMs: 200, lastAccessedAt: NOW - 6 * HALF_LIFE_MS }),
    entry('c', { dwellMs: 50_000, openCount: 5 }),
    entry('d', { dwellMs: 60_000, openCount: 6 })
  ]
  const evicted = select(entries, 2)
  assert.equal(evicted.length, 2)
  assert.ok(evicted.includes('a'))
  assert.ok(evicted.includes('b'))
})

test('MSCE-U-07 input entries are not mutated', () => {
  const a = entry('a')
  const snapshot = { ...a }
  select([a, entry('b'), entry('c')], 1)
  assert.deepEqual(a, snapshot)
})
