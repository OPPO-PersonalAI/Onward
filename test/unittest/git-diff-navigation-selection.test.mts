/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import {
  nextGitDiffNavigationLoadSettledEpoch,
  resolvePendingGitDiffNavigationSelectionDecision,
  shouldApplyPendingGitDiffNavigationSelection
} from '../../src/components/GitDiffViewer/gitDiffNavigationSelection.ts'

test('closed Diff never consumes a pending file target from a retained list', () => {
  assert.equal(shouldApplyPendingGitDiffNavigationSelection({
    isOpen: false,
    loadInFlight: false,
    hasDiffResult: true,
    hasTarget: true
  }), false)
})

test('reopening Diff keeps the target pending until the current list load settles', () => {
  assert.equal(shouldApplyPendingGitDiffNavigationSelection({
    isOpen: true,
    loadInFlight: true,
    hasDiffResult: true,
    hasTarget: true
  }), false)
})

test('settled open Diff consumes a pending target', () => {
  assert.equal(shouldApplyPendingGitDiffNavigationSelection({
    isOpen: true,
    loadInFlight: false,
    hasDiffResult: true,
    hasTarget: true
  }), true)
})

test('load settlement changes the navigation effect signal before reconsidering a pending target', () => {
  const beforeSettlement = 4
  const afterSettlement = nextGitDiffNavigationLoadSettledEpoch(beforeSettlement)

  assert.equal(afterSettlement, 5)
  assert.notEqual(afterSettlement, beforeSettlement)
  assert.equal(shouldApplyPendingGitDiffNavigationSelection({
    isOpen: true,
    loadInFlight: false,
    hasDiffResult: true,
    hasTarget: true
  }), true)
})

test('selection waits for both a target and a diff result', () => {
  assert.equal(shouldApplyPendingGitDiffNavigationSelection({
    isOpen: true,
    loadInFlight: false,
    hasDiffResult: false,
    hasTarget: true
  }), false)
  assert.equal(shouldApplyPendingGitDiffNavigationSelection({
    isOpen: true,
    loadInFlight: false,
    hasDiffResult: true,
    hasTarget: false
  }), false)
})

test('a settled successful list discards a one-shot target that no longer exists', () => {
  assert.equal(resolvePendingGitDiffNavigationSelectionDecision({
    isOpen: true,
    loadInFlight: false,
    hasDiffResult: true,
    hasTarget: true,
    hasMatch: false
  }), 'discard')
})

test('a matching settled target is applied while an in-flight target keeps waiting', () => {
  assert.equal(resolvePendingGitDiffNavigationSelectionDecision({
    isOpen: true,
    loadInFlight: false,
    hasDiffResult: true,
    hasTarget: true,
    hasMatch: true
  }), 'apply')
  assert.equal(resolvePendingGitDiffNavigationSelectionDecision({
    isOpen: true,
    loadInFlight: true,
    hasDiffResult: true,
    hasTarget: true,
    hasMatch: true
  }), 'wait')
})
