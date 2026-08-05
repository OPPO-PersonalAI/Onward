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
  GIT_SYNC_STALE_AFTER_MS
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
// BUG-0005 R3 — sync freshness.
//
// `behind` is computed against the LOCAL remote-tracking ref, so it is only as
// fresh as the last SUCCESSFUL fetch. When fetching has been failing the badge
// used to keep rendering a confident count (usually `↓0`) that actually meant
// "we have not been able to ask in hours" — the field report was a user
// trusting exactly that for 98.8 hours.
// ---------------------------------------------------------------------------

const NOW = 1_800_000_000_000
const MINUTE = 60_000

test('freshness: no upstream → never stale (there is no behind to age)', () => {
  const r = resolveGitSyncFreshness({
    lastFetchOkAt: null,
    lastFetchAttemptAt: NOW - 60 * MINUTE,
    now: NOW,
    hasUpstream: false
  })
  assert.equal(r.stale, false)
  assert.equal(r.ageMs, null)
  assert.equal(r.neverSynced, false)
})

test('freshness: recent success → fresh, with a real age', () => {
  const r = resolveGitSyncFreshness({
    lastFetchOkAt: NOW - 5 * MINUTE,
    lastFetchAttemptAt: NOW - 5 * MINUTE,
    now: NOW,
    hasUpstream: true
  })
  assert.equal(r.stale, false)
  assert.equal(r.ageMs, 5 * MINUTE)
  assert.equal(r.neverSynced, false)
})

test('freshness: past the threshold → stale', () => {
  const r = resolveGitSyncFreshness({
    lastFetchOkAt: NOW - 45 * MINUTE,
    lastFetchAttemptAt: NOW - MINUTE,
    now: NOW,
    hasUpstream: true
  })
  assert.equal(r.stale, true)
  assert.equal(r.ageMs, 45 * MINUTE)
})

test('freshness: threshold boundary — at it fresh, one ms past it stale', () => {
  const at = resolveGitSyncFreshness({
    lastFetchOkAt: NOW - GIT_SYNC_STALE_AFTER_MS,
    lastFetchAttemptAt: NOW,
    now: NOW,
    hasUpstream: true
  })
  assert.equal(at.stale, false, 'exactly at the threshold is still trusted')
  const past = resolveGitSyncFreshness({
    lastFetchOkAt: NOW - GIT_SYNC_STALE_AFTER_MS - 1,
    lastFetchAttemptAt: NOW,
    now: NOW,
    hasUpstream: true
  })
  assert.equal(past.stale, true)
})

test('freshness: attempted but NEVER succeeded → stale (the field case)', () => {
  // Project_Books_Translation: 2 attempts in 98.8 h, both 20 s timeouts, 0
  // successes. The badge must not present its behind count as authoritative.
  const r = resolveGitSyncFreshness({
    lastFetchOkAt: null,
    lastFetchAttemptAt: NOW - 13 * MINUTE,
    now: NOW,
    hasUpstream: true
  })
  assert.equal(r.stale, true)
  assert.equal(r.neverSynced, true)
  assert.equal(r.ageMs, null)
})

test('freshness: never attempted (cold launch) → NOT stale', () => {
  // Flagging every cold start before the first tick fires would be pure noise.
  const r = resolveGitSyncFreshness({
    lastFetchOkAt: null,
    lastFetchAttemptAt: null,
    now: NOW,
    hasUpstream: true
  })
  assert.equal(r.stale, false)
  assert.equal(r.neverSynced, true)
})

test('freshness: a future timestamp (clock skew) clamps to age 0, not stale', () => {
  const r = resolveGitSyncFreshness({
    lastFetchOkAt: NOW + 10 * MINUTE,
    lastFetchAttemptAt: NOW,
    now: NOW,
    hasUpstream: true
  })
  assert.equal(r.ageMs, 0)
  assert.equal(r.stale, false)
})

test('freshness: malformed timestamps are treated as absent', () => {
  for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
    const r = resolveGitSyncFreshness({
      lastFetchOkAt: bad,
      lastFetchAttemptAt: NOW - MINUTE,
      now: NOW,
      hasUpstream: true
    })
    assert.equal(r.neverSynced, true, `lastFetchOkAt=${String(bad)}`)
    assert.equal(r.stale, true)
  }
})

test('freshness: an explicit threshold override is honoured', () => {
  const r = resolveGitSyncFreshness({
    lastFetchOkAt: NOW - 2 * MINUTE,
    lastFetchAttemptAt: NOW,
    now: NOW,
    hasUpstream: true,
    staleAfterMs: MINUTE
  })
  assert.equal(r.stale, true)
})

test('freshness: the default threshold is two fetch periods (20 min)', () => {
  assert.equal(GIT_SYNC_STALE_AFTER_MS, 20 * MINUTE)
})
