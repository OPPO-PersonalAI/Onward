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

import {
  resolveGitSyncDisplay,
  resolveGitSyncFreshness,
  bucketSyncAge,
  SYNC_RELATIVE_WINDOW_MS
} from '../../src/components/TerminalGrid/gitSyncDisplay.ts'

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

// ---------------------------------------------------------------------------
// BUG-0005 R3 — sync freshness (reworked 2026-08-07 after peer research).
//
// `behind` is computed against the LOCAL remote-tracking ref, so it is only as
// fresh as the last successful `git fetch`. Without a freshness signal the badge
// cannot distinguish "up to date" from "never been able to ask" — the field
// report was a user trusting exactly that for 98.8 hours.
//
// Research across 7 products found none of them mark staleness on the count
// itself, so this is modelled as a KIND feeding a separate tooltip line, never
// as a boolean that could get re-attached to the arrow.
// ---------------------------------------------------------------------------

const NOW = 1_800_000_000_000
const MINUTE = 60_000
const HOUR = 3_600_000

const freshness = (over: Partial<Parameters<typeof resolveGitSyncFreshness>[0]> = {}) =>
  resolveGitSyncFreshness({
    lastFetchOkAt: null,
    lastFetchAttemptAt: null,
    remoteUnreachable: false,
    now: NOW,
    hasUpstream: true,
    ...over
  })

test('freshness: no upstream → say nothing', () => {
  const r = freshness({ hasUpstream: false, lastFetchAttemptAt: NOW - HOUR, remoteUnreachable: true })
  assert.equal(r.kind, 'no-upstream')
  assert.equal(r.remoteUnreachable, false, 'no upstream cannot be "unreachable"')
})

test('freshness: never attempted (cold launch) → say nothing', () => {
  // Flagging every cold start before the first tick fires would be pure noise.
  const r = freshness()
  assert.equal(r.kind, 'never-attempted')
  assert.equal(r.ageMs, null)
})

test('freshness: attempted but NEVER succeeded → never-succeeded (the field case)', () => {
  // Project_Books_Translation: 2 attempts in 98.8 h, both 20 s timeouts, 0
  // successes. The badge must not present its behind count as authoritative.
  const r = freshness({ lastFetchAttemptAt: NOW - 13 * MINUTE })
  assert.equal(r.kind, 'never-succeeded')
  assert.equal(r.ageMs, null)
})

test('freshness: one success → synced, with the age', () => {
  const r = freshness({ lastFetchOkAt: NOW - 4 * MINUTE, lastFetchAttemptAt: NOW - 4 * MINUTE })
  assert.equal(r.kind, 'synced')
  assert.equal(r.ageMs, 4 * MINUTE)
  assert.equal(r.useAbsoluteDate, false)
})

test('freshness: past the relative window → switch to an absolute date', () => {
  // GitHub Desktop (7 d) and GitLens (24 h) independently converged on this;
  // a relative time stops carrying meaning past a short window.
  const at = freshness({ lastFetchOkAt: NOW - SYNC_RELATIVE_WINDOW_MS })
  assert.equal(at.useAbsoluteDate, false, 'exactly at the window still reads relative')
  const past = freshness({ lastFetchOkAt: NOW - SYNC_RELATIVE_WINDOW_MS - 1 })
  assert.equal(past.useAbsoluteDate, true)
  assert.equal(past.kind, 'synced', 'an old success is still a success')
})

test('freshness: unreachable is the ONLY failure detail carried', () => {
  // 2026-08-07 user decision: auth / no-remote / bare-timeout text is not
  // actionable from a tooltip and stays in the perf trace. The pure function
  // therefore exposes one boolean, not a reason string — a shape that cannot
  // regress into leaking error text.
  const r = freshness({ lastFetchAttemptAt: NOW - MINUTE, remoteUnreachable: true })
  assert.equal(r.kind, 'never-succeeded')
  assert.equal(r.remoteUnreachable, true)
  assert.deepEqual(Object.keys(r).sort(), ['ageMs', 'kind', 'remoteUnreachable', 'useAbsoluteDate'])
})

test('freshness: unreachable is ignored before anything was attempted', () => {
  const r = freshness({ remoteUnreachable: true })
  assert.equal(r.kind, 'never-attempted')
  assert.equal(r.remoteUnreachable, false)
})

test('freshness: a success clears unreachable on the next report', () => {
  const r = freshness({ lastFetchOkAt: NOW - MINUTE, lastFetchAttemptAt: NOW - MINUTE, remoteUnreachable: false })
  assert.equal(r.remoteUnreachable, false)
})

test('freshness: a future success timestamp (clock skew) clamps to age 0', () => {
  const r = freshness({ lastFetchOkAt: NOW + 10 * MINUTE })
  assert.equal(r.ageMs, 0)
  assert.equal(r.kind, 'synced')
})

test('freshness: malformed success timestamps are treated as absent', () => {
  for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
    const r = freshness({ lastFetchOkAt: bad, lastFetchAttemptAt: NOW - MINUTE })
    assert.equal(r.kind, 'never-succeeded', `lastFetchOkAt=${String(bad)}`)
  }
})

test('freshness: malformed attempt timestamps keep it quiet rather than crying wolf', () => {
  for (const bad of [0, -1, Number.NaN]) {
    assert.equal(freshness({ lastFetchAttemptAt: bad }).kind, 'never-attempted', String(bad))
  }
})

// --- age bucketing (drives which i18n key the tooltip picks) ---

test('age bucket: under a minute reads "just now"', () => {
  assert.deepEqual(bucketSyncAge(0), { unit: 'just-now' })
  assert.deepEqual(bucketSyncAge(59_999), { unit: 'just-now' })
})

test('age bucket: minutes floor, and the boundary belongs to minutes', () => {
  assert.deepEqual(bucketSyncAge(MINUTE), { unit: 'minutes', value: 1 })
  assert.deepEqual(bucketSyncAge(4 * MINUTE + 59_000), { unit: 'minutes', value: 4 })
  assert.deepEqual(bucketSyncAge(HOUR - 1), { unit: 'minutes', value: 59 })
})

test('age bucket: hours from one hour up', () => {
  assert.deepEqual(bucketSyncAge(HOUR), { unit: 'hours', value: 1 })
  assert.deepEqual(bucketSyncAge(23 * HOUR), { unit: 'hours', value: 23 })
})

test('age bucket: garbage degrades to "just now", never NaN in the UI', () => {
  for (const bad of [Number.NaN, -5, Number.POSITIVE_INFINITY]) {
    const b = bucketSyncAge(bad)
    assert.ok(b.unit === 'just-now' || Number.isFinite((b as { value: number }).value), String(bad))
  }
})
