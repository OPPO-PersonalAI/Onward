/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 *
 * Usage: node --experimental-strip-types --test test/unittest/git-autofetch-scheduler.test.mts
 *
 * Locks the pure WHEN-to-fetch decision table for the background git auto-fetch
 * (`GitAutofetchScheduler`): repo dedup/prune, the app-hidden pause, the kill
 * switch, first-tick eligibility, interval gating, and the per-repo exponential
 * backoff (10 min → … → 1 h cap, reset on success). `now` is injected so the
 * assertions are deterministic. The impure spawn side lives in
 * git-autofetch-manager and is covered by run-git-autofetch-ahead-behind.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  GitAutofetchScheduler,
  computeAutofetchBackoffMs,
  GIT_AUTOFETCH_DEFAULT_INTERVAL_MS,
  GIT_AUTOFETCH_MAX_BACKOFF_MS
} from '../../electron/main/git-autofetch-scheduler.ts'

const MIN = 60_000

// ---------------------------------------------------------------------------
// computeAutofetchBackoffMs
// ---------------------------------------------------------------------------

test('backoff: healthy repo (streak 0) uses the base interval', () => {
  assert.equal(computeAutofetchBackoffMs(10 * MIN, 0, GIT_AUTOFETCH_MAX_BACKOFF_MS), 10 * MIN)
})

test('backoff: doubles per consecutive failure', () => {
  assert.equal(computeAutofetchBackoffMs(10 * MIN, 1, GIT_AUTOFETCH_MAX_BACKOFF_MS), 20 * MIN)
  assert.equal(computeAutofetchBackoffMs(10 * MIN, 2, GIT_AUTOFETCH_MAX_BACKOFF_MS), 40 * MIN)
})

test('backoff: capped at the 1 h ceiling', () => {
  // 10min * 2^3 = 80min > 60min cap → clamps to 60min.
  assert.equal(computeAutofetchBackoffMs(10 * MIN, 3, GIT_AUTOFETCH_MAX_BACKOFF_MS), GIT_AUTOFETCH_MAX_BACKOFF_MS)
  assert.equal(computeAutofetchBackoffMs(10 * MIN, 50, GIT_AUTOFETCH_MAX_BACKOFF_MS), GIT_AUTOFETCH_MAX_BACKOFF_MS)
})

// ---------------------------------------------------------------------------
// GitAutofetchScheduler
// ---------------------------------------------------------------------------

test('a freshly-added repo is due on the very first tick', () => {
  const s = new GitAutofetchScheduler({ intervalMs: 10 * MIN })
  s.syncRepos(['/repo/a'])
  assert.deepEqual(s.tick(1000), ['/repo/a'])
})

test('syncRepos dedups and prunes removed repos', () => {
  const s = new GitAutofetchScheduler({ intervalMs: 10 * MIN })
  s.syncRepos(['/repo/a', '/repo/a', '/repo/b'])
  assert.deepEqual(s.tick(0).sort(), ['/repo/a', '/repo/b'])
  s.syncRepos(['/repo/a'])
  assert.deepEqual(s.inspect().repos.map((r) => r.repoKey), ['/repo/a'])
})

test('interval gating: not due again until the period elapses', () => {
  const s = new GitAutofetchScheduler({ intervalMs: 10 * MIN })
  s.syncRepos(['/repo/a'])
  s.onFetchStart('/repo/a')
  s.onFetchDone('/repo/a', 100_000, true)
  assert.deepEqual(s.tick(100_000 + 5 * MIN), []) // 5 min < 10 min
  assert.deepEqual(s.tick(100_000 + 10 * MIN), ['/repo/a']) // exactly due
})

test('in-flight repos are skipped', () => {
  const s = new GitAutofetchScheduler({ intervalMs: 10 * MIN })
  s.syncRepos(['/repo/a'])
  s.onFetchStart('/repo/a')
  assert.deepEqual(s.tick(999_999_999), [])
})

test('app-hidden pause → tick yields nothing; foreground resumes', () => {
  const s = new GitAutofetchScheduler({ intervalMs: 10 * MIN })
  s.syncRepos(['/repo/a'])
  s.setAppVisible(false)
  assert.deepEqual(s.tick(1000), [])
  s.setAppVisible(true)
  assert.deepEqual(s.tick(1000), ['/repo/a']) // already-elapsed repo catches up
})

test('kill switch → tick yields nothing while disabled', () => {
  const s = new GitAutofetchScheduler({ intervalMs: 10 * MIN })
  s.syncRepos(['/repo/a'])
  s.setEnabled(false)
  assert.deepEqual(s.tick(1000), [])
  s.setEnabled(true)
  assert.deepEqual(s.tick(1000), ['/repo/a'])
})

test('failure backs off the next attempt; success resets the streak', () => {
  const s = new GitAutofetchScheduler({ intervalMs: 10 * MIN })
  s.syncRepos(['/repo/a'])
  // First fetch fails at t=0 → next attempt at +20 min (2^1 backoff).
  s.onFetchStart('/repo/a')
  s.onFetchDone('/repo/a', 0, false)
  assert.equal(s.inspect().repos[0].failureStreak, 1)
  assert.deepEqual(s.tick(10 * MIN), []) // still backed off
  assert.deepEqual(s.tick(20 * MIN), ['/repo/a']) // 20 min → due

  // Second consecutive failure → +40 min.
  s.onFetchStart('/repo/a')
  s.onFetchDone('/repo/a', 20 * MIN, false)
  assert.equal(s.inspect().repos[0].failureStreak, 2)
  assert.deepEqual(s.tick(20 * MIN + 30 * MIN), []) // 30 min < 40 min
  assert.deepEqual(s.tick(20 * MIN + 40 * MIN), ['/repo/a'])

  // A success resets: back to the base 10 min cadence.
  s.onFetchStart('/repo/a')
  s.onFetchDone('/repo/a', 100 * MIN, true)
  assert.equal(s.inspect().repos[0].failureStreak, 0)
  assert.deepEqual(s.tick(100 * MIN + 5 * MIN), [])
  assert.deepEqual(s.tick(100 * MIN + 10 * MIN), ['/repo/a'])
})

test('onFetchDone for a pruned repo is a no-op (no throw)', () => {
  const s = new GitAutofetchScheduler({ intervalMs: 10 * MIN })
  s.syncRepos(['/repo/a'])
  s.onFetchStart('/repo/a')
  s.syncRepos([]) // repo dropped mid-flight
  assert.doesNotThrow(() => s.onFetchDone('/repo/a', 1000, true))
})

test('default interval constant is 10 minutes', () => {
  assert.equal(GIT_AUTOFETCH_DEFAULT_INTERVAL_MS, 10 * MIN)
})

// ---------------------------------------------------------------------------
// BUG-0005 R1-A — focused-repo priority retry
//
// The 1 h ceiling is right for an unattended dead repo, but it used to be the
// ONLY rule: a repo whose fetch always timed out was pinned there forever and
// nothing the user did could shorten it. These lock the escape hatch AND its
// rate limits, because an unbounded hatch would make the backoff vacuous.
// ---------------------------------------------------------------------------

test('priority retry: refused for a healthy repo (streak 0)', () => {
  const s = new GitAutofetchScheduler({ intervalMs: 10 * MIN })
  s.syncRepos(['/repo/a'])
  s.onFetchStart('/repo/a')
  s.onFetchDone('/repo/a', 0, true)
  // Focusing a healthy repo must NOT turn into a fetch-per-click loop.
  assert.deepEqual(s.requestPriorityRetry('/repo/a', 5 * MIN), {
    granted: false,
    reason: 'not-backed-off'
  })
  assert.deepEqual(s.tick(5 * MIN), [])
})

test('priority retry: grants a backed-off repo one bypass, and tick honours it', () => {
  const s = new GitAutofetchScheduler({ intervalMs: 10 * MIN })
  s.syncRepos(['/repo/a'])
  s.onFetchStart('/repo/a')
  s.onFetchDone('/repo/a', 0, false) // streak 1 → next gap 20 min

  // Two minutes later the normal gap has NOT elapsed…
  assert.deepEqual(s.tick(2 * MIN), [])
  // …but the user focused this Task, so one attempt is granted.
  assert.deepEqual(s.requestPriorityRetry('/repo/a', 2 * MIN), { granted: true })
  assert.deepEqual(s.tick(2 * MIN), ['/repo/a'])
})

test('priority retry: refused while the last attempt is still recent', () => {
  const s = new GitAutofetchScheduler({ intervalMs: 10 * MIN })
  s.syncRepos(['/repo/a'])
  s.onFetchStart('/repo/a')
  s.onFetchDone('/repo/a', 0, false)
  // 30 s after the attempt — under the 60 s floor, nothing new could be learned.
  assert.deepEqual(s.requestPriorityRetry('/repo/a', 30_000), {
    granted: false,
    reason: 'attempted-recently'
  })
})

test('priority retry: per-repo cooldown blocks a second grant for 5 min', () => {
  const s = new GitAutofetchScheduler({ intervalMs: 10 * MIN })
  s.syncRepos(['/repo/a'])
  s.onFetchStart('/repo/a')
  s.onFetchDone('/repo/a', 0, false)

  assert.equal(s.requestPriorityRetry('/repo/a', 2 * MIN).granted, true)
  s.onFetchStart('/repo/a')                 // consumes the pending grant
  s.onFetchDone('/repo/a', 3 * MIN, false)  // and fails again

  // 4 min after the grant → still inside the 5 min cooldown.
  assert.deepEqual(s.requestPriorityRetry('/repo/a', 6 * MIN), {
    granted: false,
    reason: 'cooldown'
  })
  // Past the cooldown → granted again.
  assert.equal(s.requestPriorityRetry('/repo/a', 8 * MIN).granted, true)
})

test('priority retry: refused while a fetch is in flight, and for unknown repos', () => {
  const s = new GitAutofetchScheduler({ intervalMs: 10 * MIN })
  s.syncRepos(['/repo/a'])
  s.onFetchStart('/repo/a')
  s.onFetchDone('/repo/a', 0, false)
  s.onFetchStart('/repo/a')
  assert.deepEqual(s.requestPriorityRetry('/repo/a', 5 * MIN), {
    granted: false,
    reason: 'in-flight'
  })
  assert.deepEqual(s.requestPriorityRetry('/repo/ghost', 5 * MIN), {
    granted: false,
    reason: 'unknown-repo'
  })
})

test('priority retry: a second request before the spawn is not double-counted', () => {
  const s = new GitAutofetchScheduler({ intervalMs: 10 * MIN })
  s.syncRepos(['/repo/a'])
  s.onFetchStart('/repo/a')
  s.onFetchDone('/repo/a', 0, false)
  assert.equal(s.requestPriorityRetry('/repo/a', 2 * MIN).granted, true)
  assert.deepEqual(s.requestPriorityRetry('/repo/a', 2 * MIN + 1000), {
    granted: false,
    reason: 'already-pending'
  })
  // Still exactly one due entry, not two.
  assert.deepEqual(s.tick(2 * MIN + 1000), ['/repo/a'])
})

test('priority retry: a grant does not survive the app going hidden', () => {
  const s = new GitAutofetchScheduler({ intervalMs: 10 * MIN })
  s.syncRepos(['/repo/a'])
  s.onFetchStart('/repo/a')
  s.onFetchDone('/repo/a', 0, false)
  assert.equal(s.requestPriorityRetry('/repo/a', 2 * MIN).granted, true)
  s.setAppVisible(false)
  // The hidden pause still wins — a granted retry must not defeat it.
  assert.deepEqual(s.tick(2 * MIN), [])
})

// ---------------------------------------------------------------------------
// BUG-0005 R1-B — hidden → visible halves the failure streak
// ---------------------------------------------------------------------------

test('visible edge: halves every failure streak and reports how many changed', () => {
  const s = new GitAutofetchScheduler({ intervalMs: 10 * MIN })
  s.syncRepos(['/repo/a', '/repo/b'])
  for (const repo of ['/repo/a', '/repo/b']) {
    for (let i = 0; i < 4; i++) {
      s.onFetchStart(repo)
      s.onFetchDone(repo, i * MIN, false)
    }
  }
  assert.equal(s.inspect().repos[0].failureStreak, 4)

  s.setAppVisible(false)
  assert.equal(s.setAppVisible(true), 2, 'both repos were backed off')
  assert.equal(s.inspect().repos[0].failureStreak, 2)
  assert.equal(s.inspect().repos[1].failureStreak, 2)
})

test('visible edge: idempotent — repeated same-value calls do not re-halve', () => {
  const s = new GitAutofetchScheduler({ intervalMs: 10 * MIN })
  s.syncRepos(['/repo/a'])
  for (let i = 0; i < 4; i++) {
    s.onFetchStart('/repo/a')
    s.onFetchDone('/repo/a', i * MIN, false)
  }
  s.setAppVisible(false)
  assert.equal(s.setAppVisible(true), 1)
  // The host fires setAppVisible on show/hide/minimize/restore, so the same
  // value arrives repeatedly; only a real transition may mutate state.
  assert.equal(s.setAppVisible(true), 0)
  assert.equal(s.setAppVisible(true), 0)
  assert.equal(s.inspect().repos[0].failureStreak, 2)
})

test('visible edge: a healthy repo is untouched (no negative / no churn)', () => {
  const s = new GitAutofetchScheduler({ intervalMs: 10 * MIN })
  s.syncRepos(['/repo/a'])
  s.setAppVisible(false)
  assert.equal(s.setAppVisible(true), 0)
  assert.equal(s.inspect().repos[0].failureStreak, 0)
})

test('visible edge: halving actually shortens the effective gap', () => {
  const s = new GitAutofetchScheduler({ intervalMs: 10 * MIN })
  s.syncRepos(['/repo/a'])
  for (let i = 0; i < 4; i++) {
    s.onFetchStart('/repo/a')
    s.onFetchDone('/repo/a', 0, false)
  }
  // streak 4 → 10min * 2^4 = 160min, capped to the 1 h ceiling.
  assert.deepEqual(s.tick(30 * MIN), [])
  s.setAppVisible(false)
  s.setAppVisible(true)
  // streak 2 → 40 min. Still not due at 30 min…
  assert.deepEqual(s.tick(30 * MIN), [])
  // …but due at 40, where the un-halved streak would have needed 60.
  assert.deepEqual(s.tick(40 * MIN), ['/repo/a'])
})

// ---------------------------------------------------------------------------
// BUG-0005 P0 — overdueSnapshot feeds the paused-while-hidden diagnostic
// ---------------------------------------------------------------------------

test('overdueSnapshot: counts never-fetched repos separately and stays finite', () => {
  const s = new GitAutofetchScheduler({ intervalMs: 10 * MIN })
  s.syncRepos(['/repo/a', '/repo/b'])
  const snap = s.overdueSnapshot(5 * MIN)
  assert.equal(snap.repoCount, 2)
  assert.equal(snap.neverFetchedCount, 2)
  assert.equal(snap.overdueCount, 2)
  // A never-fetched repo must not contribute an infinite age to the payload.
  assert.equal(snap.maxOverdueMs, 0)
  assert.ok(Number.isFinite(snap.maxOverdueMs))
})

test('overdueSnapshot: reports how far past due, ignoring the visible gate', () => {
  const s = new GitAutofetchScheduler({ intervalMs: 10 * MIN })
  s.syncRepos(['/repo/a'])
  s.onFetchStart('/repo/a')
  s.onFetchDone('/repo/a', 0, true)
  s.setAppVisible(false) // hidden: tick() yields nothing…

  assert.deepEqual(s.tick(25 * MIN), [])
  // …but the diagnostic must still be able to say how much is owed.
  const snap = s.overdueSnapshot(25 * MIN)
  assert.equal(snap.overdueCount, 1)
  assert.equal(snap.neverFetchedCount, 0)
  assert.equal(snap.maxOverdueMs, 15 * MIN) // 25 min elapsed − 10 min gap
})

test('overdueSnapshot: a repo inside its gap is not overdue', () => {
  const s = new GitAutofetchScheduler({ intervalMs: 10 * MIN })
  s.syncRepos(['/repo/a'])
  s.onFetchStart('/repo/a')
  s.onFetchDone('/repo/a', 0, true)
  const snap = s.overdueSnapshot(5 * MIN)
  assert.equal(snap.overdueCount, 0)
  assert.equal(snap.maxOverdueMs, 0)
})
