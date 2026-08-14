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

/**
 * Beyond this age the "last synced" line switches from a relative time
 * ("4 minutes ago") to an absolute date. Both GitHub Desktop and GitLens
 * independently converged on this treatment — a relative time only carries
 * meaning inside a short window; past that it is noise ("synced 23 days ago"
 * tells you less than a date). GitLens uses 24 h; we match it, which is also
 * ~144 fetch periods, far past any plausible "just a hiccup".
 */
export const SYNC_RELATIVE_WINDOW_MS = 86_400_000

/**
 * Which sentence the badge tooltip should carry about sync freshness.
 *
 * Deliberately a KIND rather than a boolean `stale`. Peer research (2026-08-07,
 * 7 products) found that no tool marks staleness on the ahead/behind count
 * itself; the count is left alone and the freshness lives in a separate,
 * always-present line. Modelling this as an enum keeps the component from
 * re-inventing a boolean and re-attaching it to the count.
 */
export type SyncFreshnessKind =
  /** No upstream — there is no remote to be in sync with. Say nothing. */
  | 'no-upstream'
  /** The fetch loop has not run yet (cold launch). Say nothing; not a problem. */
  | 'never-attempted'
  /** Attempted, never succeeded. The count cannot be trusted. */
  | 'never-succeeded'
  /** At least one success; `ageMs` says how long ago. */
  | 'synced'

export interface GitSyncFreshness {
  kind: SyncFreshnessKind
  /** ms since the last successful fetch. Non-null only when kind === 'synced'. */
  ageMs: number | null
  /** True when `ageMs` should render as an absolute date instead of "X ago". */
  useAbsoluteDate: boolean
  /**
   * True when the last attempt failed because the remote was unreachable.
   *
   * This is the ONLY failure detail the UI surfaces (2026-08-07 decision): auth
   * walls, missing remotes and bare timeouts are not actionable from a tooltip,
   * and their classification already reaches us through the perf trace.
   * Unreachability is different — it is outside the app's control and the user
   * can confirm it themselves in a second.
   */
  remoteUnreachable: boolean
}

/**
 * Describe how fresh the badge's behind count is, for the tooltip.
 *
 * `behind` is computed against the LOCAL remote-tracking ref, so it is only as
 * fresh as the last successful `git fetch`. Without this line the badge cannot
 * distinguish "you are up to date" from "we have never been able to ask" — the
 * exact confusion behind BUG-0005, where a repo went 98.8 h with zero
 * successful fetches and the UI never hinted at it.
 *
 * Pure so the decision table is locked by `test/unittest/git-sync-display.test.mts`
 * without a React render or a running fetch loop.
 */
export function resolveGitSyncFreshness(input: {
  lastFetchOkAt: number | null | undefined
  lastFetchAttemptAt: number | null | undefined
  remoteUnreachable: boolean | null | undefined
  now: number
  /** No upstream → there is no remote to be in sync with. */
  hasUpstream: boolean
}): GitSyncFreshness {
  const unreachable = input.remoteUnreachable === true

  if (!input.hasUpstream) {
    return { kind: 'no-upstream', ageMs: null, useAbsoluteDate: false, remoteUnreachable: false }
  }

  const okAt = toFiniteTimestamp(input.lastFetchOkAt)
  if (okAt === null) {
    const attempted = toFiniteTimestamp(input.lastFetchAttemptAt) !== null
    return {
      kind: attempted ? 'never-succeeded' : 'never-attempted',
      ageMs: null,
      useAbsoluteDate: false,
      // Only meaningful once something has actually been attempted.
      remoteUnreachable: attempted && unreachable
    }
  }

  // Clamp a negative age (clock adjustment / skew) to 0 rather than letting it
  // read as "synced in the future".
  const ageMs = Math.max(0, input.now - okAt)
  return {
    kind: 'synced',
    ageMs,
    useAbsoluteDate: ageMs > SYNC_RELATIVE_WINDOW_MS,
    remoteUnreachable: unreachable
  }
}

function toFiniteTimestamp(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null
}

/**
 * Coarse bucket for "how long ago was the last successful sync", so the
 * component can pick an i18n key without doing arithmetic in JSX.
 *
 * Buckets rather than a formatted string because the wording is per-locale and
 * belongs in the dictionary; the arithmetic is what deserves a unit test.
 * Anything past {@link SYNC_RELATIVE_WINDOW_MS} never reaches here — the
 * caller renders an absolute date instead.
 */
export type SyncAgeBucket =
  | { unit: 'just-now' }
  | { unit: 'minutes'; value: number }
  | { unit: 'hours'; value: number }

export function bucketSyncAge(ageMs: number): SyncAgeBucket {
  const safe = Number.isFinite(ageMs) && ageMs > 0 ? ageMs : 0
  if (safe < 60_000) return { unit: 'just-now' }
  if (safe < 3_600_000) return { unit: 'minutes', value: Math.floor(safe / 60_000) }
  return { unit: 'hours', value: Math.floor(safe / 3_600_000) }
}
