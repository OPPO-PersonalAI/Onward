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
