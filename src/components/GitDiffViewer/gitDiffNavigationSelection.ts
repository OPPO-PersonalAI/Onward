/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

export function shouldApplyPendingGitDiffNavigationSelection(params: {
  isOpen: boolean
  loadInFlight: boolean
  hasDiffResult: boolean
  hasTarget: boolean
}): boolean {
  return params.isOpen
    && !params.loadInFlight
    && params.hasDiffResult
    && params.hasTarget
}

export function nextGitDiffNavigationLoadSettledEpoch(current: number): number {
  return current >= Number.MAX_SAFE_INTEGER ? 0 : current + 1
}

export type PendingGitDiffNavigationSelectionDecision = 'wait' | 'apply' | 'discard'

export function resolvePendingGitDiffNavigationSelectionDecision(params: {
  isOpen: boolean
  loadInFlight: boolean
  hasDiffResult: boolean
  hasTarget: boolean
  hasMatch: boolean
}): PendingGitDiffNavigationSelectionDecision {
  if (!shouldApplyPendingGitDiffNavigationSelection(params)) return 'wait'
  return params.hasMatch ? 'apply' : 'discard'
}
