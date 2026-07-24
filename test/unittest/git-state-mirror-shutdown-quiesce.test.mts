/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 *
 * Usage: node --experimental-strip-types --test test/unittest/git-state-mirror-shutdown-quiesce.test.mts
 *
 * Locks the pure teardown decision logic behind the @parcel/watcher
 * worker-teardown SIGABRT fix (electron/main/git-state-mirror-teardown.ts):
 *   - the quiescence gate (zero live subscriptions AND zero pending unsubscribes),
 *   - the async quiesce barrier's ordering (drain BEFORE return; spin until empty,
 *     never return after only the first settle; give up at the deadline),
 *   - the respawn-suppression predicate (no fresh watcher-bearing worker spawns
 *     into a quitting app).
 *
 * All effects are injected, so these run in plain Node in milliseconds with NO
 * real timers — the failure signal is deterministic, not flaky.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  isGitStateMirrorQuiescent,
  awaitWatcherQuiescence,
  awaitWatcherQuiescenceWithSettle,
  shouldRespawnGitStateMirrorWorker
} from '../../electron/main/git-state-mirror-teardown.ts'

// ---------------------------------------------------------------------------
// isGitStateMirrorQuiescent
// ---------------------------------------------------------------------------

test('isGitStateMirrorQuiescent is true only at zero subscriptions AND zero pending', () => {
  assert.equal(isGitStateMirrorQuiescent(0, 0), true)
  assert.equal(isGitStateMirrorQuiescent(1, 0), false)
  assert.equal(isGitStateMirrorQuiescent(0, 1), false)
  assert.equal(isGitStateMirrorQuiescent(3, 2), false)
})

test('isGitStateMirrorQuiescent treats negative (leaked) counters as quiescent so a bug cannot hard-wedge teardown', () => {
  assert.equal(isGitStateMirrorQuiescent(-1, 0), true)
  assert.equal(isGitStateMirrorQuiescent(0, -2), true)
})

test('isGitStateMirrorQuiescent also requires zero in-flight native ops (call-time subscribe tracking, 2026-07-23 SIGABRT hole)', () => {
  assert.equal(isGitStateMirrorQuiescent(0, 0, 0), true)
  assert.equal(isGitStateMirrorQuiescent(0, 0, 1), false)
  assert.equal(isGitStateMirrorQuiescent(0, 0, -1), true)
})

// ---------------------------------------------------------------------------
// awaitWatcherQuiescence + pendingOps / awaitWatcherQuiescenceWithSettle
// ---------------------------------------------------------------------------

test('awaitWatcherQuiescence waits for an in-flight native op invisible to the two legacy counters', async () => {
  const clock = fakeClock()
  let ops = 1
  let settledOps = 0
  const result = await awaitWatcherQuiescence({
    getActive: () => 0,
    getPending: () => 0,
    settlePending: async () => {},
    getPendingOps: () => ops,
    settlePendingOps: async () => {
      settledOps += 1
      // The in-flight subscribe resolves on the second settle attempt.
      if (settledOps >= 2) ops = 0
    },
    delay: clock.delay,
    now: clock.now
  })
  assert.equal(result.deadlineHit, false)
  assert.equal(ops, 0)
  assert.ok(settledOps >= 2)
})

test('awaitWatcherQuiescenceWithSettle re-enters when an op appears during the settle window (H2) and reports requiesceCount', async () => {
  const clock = fakeClock()
  let ops = 0
  let opInjected = false
  const result = await awaitWatcherQuiescenceWithSettle({
    getActive: () => 0,
    getPending: () => 0,
    settlePending: async () => {},
    getPendingOps: () => ops,
    settlePendingOps: async () => { ops = 0 },
    delay: async (ms: number) => {
      await clock.delay(ms)
      // Simulate a subscribe resolving mid-settle and queueing its
      // compensating unsubscribe: an op appears during the settle window.
      if (ms >= 100 && !opInjected) {
        opInjected = true
        ops = 1
      }
    },
    now: clock.now,
    settleMs: 100
  })
  assert.equal(result.deadlineHit, false)
  assert.equal(result.requiesceCount, 1)
  assert.equal(ops, 0)
})

test('awaitWatcherQuiescenceWithSettle is bounded by the overall deadline when ops never drain', async () => {
  const clock = fakeClock()
  const result = await awaitWatcherQuiescenceWithSettle({
    getActive: () => 0,
    getPending: () => 0,
    settlePending: async () => {},
    getPendingOps: () => 1,
    settlePendingOps: async () => {},
    delay: clock.delay,
    now: clock.now,
    deadlineMs: 200,
    settleMs: 50
  })
  assert.equal(result.deadlineHit, true)
  // Overall deadline = 2*deadlineMs + 2*settleMs = 500; must not spin forever.
  assert.ok(result.spunMs <= 700)
})

// ---------------------------------------------------------------------------
// awaitWatcherQuiescence — the ordering barrier
// ---------------------------------------------------------------------------

function fakeClock() {
  let t = 0
  return { now: () => t, delay: async (ms: number) => { t += ms } }
}

test('awaitWatcherQuiescence returns immediately (no spin) when already quiescent', async () => {
  const clock = fakeClock()
  let delays = 0
  const result = await awaitWatcherQuiescence({
    getActive: () => 0,
    getPending: () => 0,
    settlePending: async () => {},
    delay: async (ms) => { delays += 1; await clock.delay(ms) },
    now: clock.now
  })
  assert.equal(result.deadlineHit, false)
  assert.equal(delays, 0)
})

test('awaitWatcherQuiescence drains a single in-flight unsubscribe via the pre-loop settle', async () => {
  const clock = fakeClock()
  // One live subscription + one in-flight unsubscribe. The first settlePending
  // resolves it: pending clears AND the paired live count decrements (the real
  // dispose-closure finally).
  let active = 1
  let pending = 1
  const result = await awaitWatcherQuiescence({
    getActive: () => active,
    getPending: () => pending,
    settlePending: async () => { if (pending > 0) { pending = 0; active = 0 } },
    delay: clock.delay,
    now: clock.now
  })
  assert.equal(result.deadlineHit, false)
  assert.equal(active, 0)
  assert.equal(pending, 0)
})

test('awaitWatcherQuiescence SPINS until pending reaches zero — never returns after only the first settle (GAP 4)', async () => {
  const clock = fakeClock()
  // Two in-flight unsubscribes; each settle clears exactly one (with its paired
  // live-count decrement). The barrier must NOT return when pending is still 1
  // after the first settle — it must spin and re-settle until BOTH drain.
  let active = 2
  let pending = 2
  let settles = 0
  const result = await awaitWatcherQuiescence({
    getActive: () => active,
    getPending: () => pending,
    settlePending: async () => { settles += 1; if (pending > 0) { pending -= 1; active -= 1 } },
    delay: clock.delay,
    now: clock.now,
    tickMs: 20
  })
  assert.equal(result.deadlineHit, false)
  assert.equal(pending, 0)
  assert.equal(active, 0)
  // First settle (pre-loop) cleared 1; at least one more settle inside the spin
  // cleared the second — proving it did not return after the first.
  assert.ok(settles >= 2, `expected >=2 settles, got ${settles}`)
})

test('awaitWatcherQuiescence gives up at the deadline when a leaked counter never drains (bounded, not forever)', async () => {
  const clock = fakeClock()
  const result = await awaitWatcherQuiescence({
    getActive: () => 1, // stuck forever (simulated bookkeeping leak)
    getPending: () => 0,
    settlePending: async () => {},
    delay: clock.delay,
    now: clock.now,
    tickMs: 20,
    deadlineMs: 100
  })
  assert.equal(result.deadlineHit, true)
  assert.ok(result.spunMs >= 100, `expected spunMs >= deadline, got ${result.spunMs}`)
})

// ---------------------------------------------------------------------------
// shouldRespawnGitStateMirrorWorker
// ---------------------------------------------------------------------------

test('shouldRespawnGitStateMirrorWorker respawns only when not disposed, no live worker, and budget remains', () => {
  const base = { disposed: false, hasLiveWorker: false, respawnAttempt: 0, maxAttempts: 5 }
  assert.equal(shouldRespawnGitStateMirrorWorker(base), true)
  assert.equal(shouldRespawnGitStateMirrorWorker({ ...base, respawnAttempt: 4 }), true)
})

test('shouldRespawnGitStateMirrorWorker suppresses respawn while disposing/disposed (the quitting-app guard, GAP 5/6)', () => {
  const base = { disposed: true, hasLiveWorker: false, respawnAttempt: 0, maxAttempts: 5 }
  assert.equal(shouldRespawnGitStateMirrorWorker(base), false)
  // disposed wins even with full budget remaining.
  assert.equal(shouldRespawnGitStateMirrorWorker({ ...base, respawnAttempt: 0 }), false)
})

test('shouldRespawnGitStateMirrorWorker suppresses respawn when a worker already exists', () => {
  assert.equal(
    shouldRespawnGitStateMirrorWorker({ disposed: false, hasLiveWorker: true, respawnAttempt: 0, maxAttempts: 5 }),
    false
  )
})

test('shouldRespawnGitStateMirrorWorker gives up once the retry budget is exhausted', () => {
  const base = { disposed: false, hasLiveWorker: false, maxAttempts: 5 }
  assert.equal(shouldRespawnGitStateMirrorWorker({ ...base, respawnAttempt: 5 }), false)
  assert.equal(shouldRespawnGitStateMirrorWorker({ ...base, respawnAttempt: 6 }), false)
})
