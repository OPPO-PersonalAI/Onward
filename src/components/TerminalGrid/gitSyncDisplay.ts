/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Pure decision table for the Task git badge's ahead/behind presentation.
 *
 * Two orthogonal dimensions feed one badge:
 *   1. Working-tree cleanliness → `TerminalGitStatus` (clean / added / deleted /
 *      modified / mixed / unknown), already classified by `git-status-classify`.
 *   2. Sync with upstream → `ahead` / `behind` commit counts (from `# branch.ab`).
 *
 * The badge encodes them like this (confirmed design, 2026-07-15):
 *   - The DOT colour follows "green = you have local commits to push": a clean
 *     tree that is ahead > 0 gets the distinct `ahead` green (#4ADE80), distinct
 *     from the plain-clean emerald. behind is NOT a dot colour — it rides the
 *     `↓M` arrow only, so a clean behind-only tree keeps the emerald dot.
 *   - A DIRTY tree always keeps its working-tree colour (yellow / purple / red /
 *     blue / slate); the arrows are appended regardless, because ahead/behind is
 *     orthogonal to dirtiness.
 *   - ARROWS: `↑N` shown when ahead > 0, `↓M` shown when behind > 0. Both can show
 *     at once (diverged). No upstream / 0-0 → no arrows.
 *
 * Extracted as a pure function so the decision table is locked by a unit test
 * (`test/unittest/git-sync-display.test.mts`) independent of any React render.
 */

import type { TerminalGitStatus } from '../../types/electron'

/** The class suffix the dot renders with — the six tree states plus `ahead`. */
export type GitBadgeDotState = TerminalGitStatus | 'ahead'

export interface GitSyncDisplay {
  /** Drives `terminal-grid-branch--<dotState>`; `clean` means the base class. */
  dotState: GitBadgeDotState
  ahead: number
  behind: number
  showAhead: boolean
  showBehind: boolean
}

const DIRTY_STATES: ReadonlySet<TerminalGitStatus> = new Set<TerminalGitStatus>([
  'added',
  'deleted',
  'modified',
  'mixed',
  'unknown'
])

/**
 * Resolve the badge's dot colour + arrow visibility from the tree status and
 * the upstream ahead/behind counts. `ahead`/`behind` accept `null | undefined`
 * (no upstream) and are treated as 0.
 */
export function resolveGitSyncDisplay(input: {
  status: TerminalGitStatus | null
  ahead: number | null | undefined
  behind: number | null | undefined
}): GitSyncDisplay {
  // Clamp to a non-negative integer; a malformed negative/NaN degrades to 0
  // (no arrow) rather than rendering a bogus count.
  const ahead = normalizeCount(input.ahead)
  const behind = normalizeCount(input.behind)
  const showAhead = ahead > 0
  const showBehind = behind > 0

  let dotState: GitBadgeDotState
  if (input.status && DIRTY_STATES.has(input.status)) {
    // Dirty tree: working-tree colour wins; arrows still ride along.
    dotState = input.status
  } else if (showAhead) {
    // Clean (or unknown-null) tree with unpushed commits → the distinct green.
    dotState = 'ahead'
  } else {
    // Clean up-to-date, or clean behind-only → plain emerald; behind rides ↓.
    dotState = 'clean'
  }

  return { dotState, ahead, behind, showAhead, showBehind }
}

function normalizeCount(value: number | null | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return 0
  return Math.floor(value)
}
