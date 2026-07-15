/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 *
 * Usage: node --experimental-strip-types --test test/unittest/subpage-restore-decision.test.mts
 *
 * Locks the pure decision behind Git Diff subpage selection restore: restore the
 * saved snapshot ONLY on a genuine cross-subpage switch (SN-07 / CDP-06); a fresh
 * open or a same-subpage reopen must open BLANK (GDS-31). This is the math; the
 * end-to-end wiring is locked by run-subpage-navigation / run-subpage-cdp-clicks
 * (restore) and run-git-diff-staleness-and-submodule GDS-31 (blank).
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import {
  shouldRestoreStoredSubpageSnapshot,
  shouldRestoreSubpageOnEnter
} from '../../src/components/TerminalGrid/subpageRestoreDecision.ts'

test('genuine cross-subpage switch restores the saved snapshot', () => {
  // Editor -> Diff (SN-07) and History -> Diff (CDP-06): from a DIFFERENT subpage.
  assert.equal(shouldRestoreSubpageOnEnter('editor', 'diff'), true)
  assert.equal(shouldRestoreSubpageOnEnter('history', 'diff'), true)
  assert.equal(shouldRestoreSubpageOnEnter('diff', 'editor'), true)
})

test('fresh open (no source subpage) opens blank — never restores', () => {
  // GDS-31: git-diff:open after a full close has from === null.
  assert.equal(shouldRestoreSubpageOnEnter(null, 'diff'), false)
  assert.equal(shouldRestoreSubpageOnEnter(undefined, 'diff'), false)
})

test('same-subpage reopen (from === target) opens blank', () => {
  // A stale activeSubpage that still points at the target must not resurrect a
  // prior selection on what is really a fresh open.
  assert.equal(shouldRestoreSubpageOnEnter('diff', 'diff'), false)
  assert.equal(shouldRestoreSubpageOnEnter('editor', 'editor'), false)
})

test('explicit file jump wins over a stored target-page snapshot', () => {
  assert.equal(shouldRestoreStoredSubpageSnapshot({
    from: 'editor',
    target: 'diff',
    intent: 'jump',
    hasExplicitFileTarget: true
  }), false)

  assert.equal(shouldRestoreStoredSubpageSnapshot({
    from: 'editor',
    target: 'diff',
    intent: 'switch',
    hasExplicitFileTarget: false
  }), true)
})
