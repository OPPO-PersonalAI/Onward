/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 *
 * Unit tests for the per-scope soft-close snapshot LRU store that replaced
 * the single global snapshot slot (multi-Task "instant reopen" isolation).
 * Paired autotest: run-project-editor-multi-terminal-scope-autotest.sh
 * (PEMS-25 retained-view reopen after A→B→A→B interleave).
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  LruSnapshotStore,
  SOFT_CLOSE_SNAPSHOT_CAP
} from '../../src/components/ProjectEditor/utils/softCloseSnapshotStore.ts'

test('PSCS-U-01 set/get round-trips per key without touching other keys', () => {
  const store = new LruSnapshotStore<string>(4)
  store.set('a', 'A')
  store.set('b', 'B')
  assert.equal(store.get('a'), 'A')
  assert.equal(store.get('b'), 'B')
  assert.equal(store.get('c'), null)
  assert.equal(store.size, 2)
})

test('PSCS-U-02 cap evicts the least-recently-used key and reports it', () => {
  const store = new LruSnapshotStore<string>(2)
  store.set('a', 'A')
  store.set('b', 'B')
  const evicted = store.set('c', 'C')
  assert.deepEqual(evicted, ['a'])
  assert.equal(store.get('a'), null)
  assert.equal(store.get('b'), 'B')
  assert.equal(store.get('c'), 'C')
})

test('PSCS-U-03 get refreshes recency; peek does not', () => {
  const lruStore = new LruSnapshotStore<string>(2)
  lruStore.set('a', 'A')
  lruStore.set('b', 'B')
  lruStore.get('a')
  assert.deepEqual(lruStore.set('c', 'C'), ['b'])

  const peekStore = new LruSnapshotStore<string>(2)
  peekStore.set('a', 'A')
  peekStore.set('b', 'B')
  peekStore.peek('a')
  assert.deepEqual(peekStore.set('c', 'C'), ['a'])
})

test('PSCS-U-04 re-set of an existing key replaces in place without eviction', () => {
  const store = new LruSnapshotStore<string>(2)
  store.set('a', 'A')
  store.set('b', 'B')
  assert.deepEqual(store.set('a', 'A2'), [])
  assert.equal(store.get('a'), 'A2')
  assert.equal(store.size, 2)
})

test('PSCS-U-05 delete removes only the named key; deleteWhere removes by predicate', () => {
  const store = new LruSnapshotStore<{ terminalId: string }>(4)
  store.set('a', { terminalId: 't1' })
  store.set('b', { terminalId: 't1' })
  store.set('c', { terminalId: 't2' })
  assert.equal(store.delete('a'), true)
  assert.equal(store.delete('a'), false)
  const removed = store.deleteWhere((_key, value) => value.terminalId === 't1')
  assert.deepEqual(removed, ['b'])
  assert.equal(store.size, 1)
  assert.ok(store.peek('c'))
})

test('PSCS-U-06 null keys are inert for every operation', () => {
  const store = new LruSnapshotStore<string>(2)
  assert.deepEqual(store.set(null, 'X'), [])
  assert.equal(store.get(null), null)
  assert.equal(store.peek(null), null)
  assert.equal(store.delete(null), false)
  assert.equal(store.size, 0)
})

test('PSCS-U-07 production cap constant stays at 4 (memory budget: content strings per slot)', () => {
  assert.equal(SOFT_CLOSE_SNAPSHOT_CAP, 4)
})
