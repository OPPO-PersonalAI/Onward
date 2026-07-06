/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 *
 * Usage: node --experimental-strip-types --test test/unittest/git-state-mirror-watcher-reattach.test.mts
 *
 * Locks the non-git → git watcher re-attach decision (2026-07-05 bundle,
 * "BattleProject not recognized"): a cwd attached while NOT a git repo gets no
 * watcher; when a later recompute (focus-resync / revalidate) resolves a
 * repoRoot, the watcher must be attached — but ONLY when the entry has no
 * watcher yet and is not tearing down / mid-attach, so we never double-attach.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { shouldReattachWatcherAfterRecompute } from '../../electron/main/git-state-mirror-worker-core.ts'

const base = { watcherGroupKey: null as string | null, detachRequested: false, attachInFlight: false }

test('attaches when a non-git cwd became git (no watcher yet)', () => {
  assert.equal(shouldReattachWatcherAfterRecompute({ ...base }, '/repo'), true)
})

test('does NOT attach when the recompute still found no repo', () => {
  assert.equal(shouldReattachWatcherAfterRecompute({ ...base }, null), false)
})

test('does NOT re-attach when a watcher is already present', () => {
  assert.equal(
    shouldReattachWatcherAfterRecompute({ ...base, watcherGroupKey: 'repo-key' }, '/repo'),
    false
  )
})

test('does NOT attach a detaching entry', () => {
  assert.equal(
    shouldReattachWatcherAfterRecompute({ ...base, detachRequested: true }, '/repo'),
    false
  )
})

test('does NOT attach while an attach is already in flight', () => {
  assert.equal(
    shouldReattachWatcherAfterRecompute({ ...base, attachInFlight: true }, '/repo'),
    false
  )
})
