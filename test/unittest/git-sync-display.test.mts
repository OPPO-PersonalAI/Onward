/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 *
 * Usage: node --experimental-strip-types --test test/unittest/git-sync-display.test.mts
 *
 * Locks the pure decision table for the Task git badge's ahead/behind
 * presentation (`resolveGitSyncDisplay`): which dot colour and which arrows
 * render for every (tree-status × ahead × behind) combination. This is the
 * "math" half of the paired deliverable; the "wiring" half is the amended
 * badge matrix in run-git-state-mirror-latency-static.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { resolveGitSyncDisplay } from '../../src/components/TerminalGrid/gitSyncDisplay.ts'

test('clean + up-to-date → plain clean dot, no arrows', () => {
  const r = resolveGitSyncDisplay({ status: 'clean', ahead: 0, behind: 0 })
  assert.equal(r.dotState, 'clean')
  assert.equal(r.showAhead, false)
  assert.equal(r.showBehind, false)
})

test('clean + ahead-only → the distinct ahead green + ↑N', () => {
  const r = resolveGitSyncDisplay({ status: 'clean', ahead: 2, behind: 0 })
  assert.equal(r.dotState, 'ahead')
  assert.equal(r.showAhead, true)
  assert.equal(r.ahead, 2)
  assert.equal(r.showBehind, false)
})

test('clean + behind-only → dot stays emerald (clean); only ↓M rides', () => {
  // Confirmed semantics: green === "you have local commits to push". Behind is
  // conveyed by the arrow, NOT a dot colour, so behind-only keeps the clean dot.
  const r = resolveGitSyncDisplay({ status: 'clean', ahead: 0, behind: 3 })
  assert.equal(r.dotState, 'clean')
  assert.equal(r.showAhead, false)
  assert.equal(r.showBehind, true)
  assert.equal(r.behind, 3)
})

test('clean + diverged → ahead green (has local to push) + both arrows', () => {
  const r = resolveGitSyncDisplay({ status: 'clean', ahead: 2, behind: 1 })
  assert.equal(r.dotState, 'ahead')
  assert.equal(r.showAhead, true)
  assert.equal(r.showBehind, true)
  assert.equal(r.ahead, 2)
  assert.equal(r.behind, 1)
})

test('dirty tree keeps its working-tree colour; arrows still ride along', () => {
  for (const status of ['modified', 'added', 'deleted', 'mixed', 'unknown'] as const) {
    const r = resolveGitSyncDisplay({ status, ahead: 2, behind: 1 })
    assert.equal(r.dotState, status, `dirty ${status} must NOT turn green`)
    assert.equal(r.showAhead, true)
    assert.equal(r.showBehind, true)
  }
})

test('dirty + ahead does not promote the dot to green', () => {
  const r = resolveGitSyncDisplay({ status: 'modified', ahead: 5, behind: 0 })
  assert.equal(r.dotState, 'modified')
  assert.equal(r.showAhead, true)
})

test('no upstream (null/undefined counts) → clean dot, no arrows', () => {
  const r = resolveGitSyncDisplay({ status: 'clean', ahead: null, behind: undefined })
  assert.equal(r.dotState, 'clean')
  assert.equal(r.showAhead, false)
  assert.equal(r.showBehind, false)
})

test('null status with ahead still greens (clean-equivalent)', () => {
  // A snapshot before a real classification lands (status null) but with an
  // ahead count should still read as "ahead" rather than dirty.
  const r = resolveGitSyncDisplay({ status: null, ahead: 1, behind: 0 })
  assert.equal(r.dotState, 'ahead')
})

test('malformed counts degrade to no arrow (never render a bogus number)', () => {
  const r = resolveGitSyncDisplay({ status: 'clean', ahead: -3, behind: Number.NaN })
  assert.equal(r.ahead, 0)
  assert.equal(r.behind, 0)
  assert.equal(r.showAhead, false)
  assert.equal(r.showBehind, false)
  assert.equal(r.dotState, 'clean')
})

test('fractional counts floor to an integer', () => {
  const r = resolveGitSyncDisplay({ status: 'clean', ahead: 2.9, behind: 0 })
  assert.equal(r.ahead, 2)
})
