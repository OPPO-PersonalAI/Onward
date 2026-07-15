/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

import type { SubpageId } from '../../types/subpage'

/**
 * Decide whether a subpage RE-ENTRY should restore its previously-saved
 * snapshot. Restore ONLY on a genuine cross-subpage switch — the route came
 * FROM a different subpage (e.g. Editor → Diff, History → Diff). A fresh open
 * (`from === null`) or a same-subpage reopen (`from === target`) must open
 * blank, so callers clear the saved snapshot in those cases.
 *
 * Pure (no I/O, no React) so it is unit-testable in plain `node --test`.
 *
 * @param from   the subpage the route is leaving, or null for a fresh open
 * @param target the subpage being entered
 */
export function shouldRestoreSubpageOnEnter(
  from: SubpageId | null | undefined,
  target: SubpageId
): boolean {
  return from != null && from !== target
}

export function shouldRestoreStoredSubpageSnapshot(params: {
  from: SubpageId | null | undefined
  target: SubpageId
  intent: 'open' | 'switch' | 'jump' | 'close' | 'restore'
  hasExplicitFileTarget: boolean
}): boolean {
  if (!shouldRestoreSubpageOnEnter(params.from, params.target)) return false
  return !(params.intent === 'jump' && params.hasExplicitFileTarget)
}
