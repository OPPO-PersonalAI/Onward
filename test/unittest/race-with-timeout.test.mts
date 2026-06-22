/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 *
 * Usage: node --experimental-strip-types --test test/unittest/race-with-timeout.test.mts
 *
 * Locks the pure timing-control core of GitDiffViewer's getDiff IPC watchdog
 * (raceWithTimeout): the helper that guarantees an awaited IPC invoke settles
 * within a ceiling so loadDiff's finally always runs (releasing the in-flight
 * lock + idle waiters). Regression target: a wedged renderer invoke that never
 * settled deadlocked Keep/Deny + every later load until the 180s autotest kill.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { raceWithTimeout } from '../../src/utils/race-with-timeout.ts'

// An injectable fake scheduler so tests are deterministic and instant — no real
// timers. fire() runs the scheduled callback exactly as setTimeout would.
function makeFakeScheduler() {
  let pending: { cb: () => void; ms: number } | null = null
  let cleared = false
  return {
    scheduler: {
      setTimeout: (cb: () => void, ms: number) => {
        pending = { cb, ms }
        return 1
      },
      clearTimeout: (_handle: unknown) => {
        cleared = true
        pending = null
      }
    },
    fire: () => {
      const p = pending
      pending = null
      p?.cb()
    },
    get cleared() {
      return cleared
    },
    get scheduledMs() {
      return pending?.ms ?? null
    }
  }
}

test('resolves with the work value when work wins, and clears the timer', async () => {
  const fake = makeFakeScheduler()
  const result = await raceWithTimeout(
    Promise.resolve('ok'),
    5000,
    undefined,
    undefined,
    fake.scheduler
  )
  assert.equal(result, 'ok')
  assert.equal(fake.cleared, true, 'watchdog timer must be cleared when work wins')
})

test('propagates a work rejection (real IPC error) and clears the timer', async () => {
  const fake = makeFakeScheduler()
  await assert.rejects(
    raceWithTimeout(
      Promise.reject(new Error('worker request timed out: getDiff')),
      5000,
      undefined,
      undefined,
      fake.scheduler
    ),
    /worker request timed out: getDiff/
  )
  assert.equal(fake.cleared, true)
})

test('rejects with the timeout error and fires onTimeout exactly once when work never settles', async () => {
  const fake = makeFakeScheduler()
  let onTimeoutCalls = 0
  // A promise that never settles — models the wedged renderer invoke.
  const neverSettles = new Promise<string>(() => {})
  const raced = raceWithTimeout(
    neverSettles,
    30000,
    () => {
      onTimeoutCalls += 1
    },
    (ms) => new Error(`getDiff IPC watchdog fired after ${ms}ms`),
    fake.scheduler
  )
  assert.equal(fake.scheduledMs, 30000, 'watchdog must be armed with the configured ceiling')
  fake.fire()
  await assert.rejects(raced, /getDiff IPC watchdog fired after 30000ms/)
  assert.equal(onTimeoutCalls, 1, 'onTimeout breadcrumb must fire exactly once')
})

test('does not fire onTimeout when work wins before the watchdog', async () => {
  const fake = makeFakeScheduler()
  let onTimeoutCalls = 0
  const result = await raceWithTimeout(
    Promise.resolve(42),
    1000,
    () => {
      onTimeoutCalls += 1
    },
    undefined,
    fake.scheduler
  )
  assert.equal(result, 42)
  assert.equal(onTimeoutCalls, 0, 'onTimeout must NOT fire for a successful operation')
  assert.equal(fake.cleared, true)
})

test('rejects synchronously on an invalid (negative / non-finite) timeout', () => {
  assert.throws(() => raceWithTimeout(Promise.resolve(1), -1), /finite, non-negative/)
  assert.throws(() => raceWithTimeout(Promise.resolve(1), Number.POSITIVE_INFINITY), /finite, non-negative/)
  assert.throws(() => raceWithTimeout(Promise.resolve(1), Number.NaN), /finite, non-negative/)
})

test('integration with real timers: a slow work loses to a short ceiling', async () => {
  // Uses real timers (no injected scheduler) to prove the default path works.
  const slow = new Promise<string>((resolve) => setTimeout(() => resolve('late'), 200))
  await assert.rejects(
    raceWithTimeout(slow, 20, () => {}, (ms) => new Error(`fired after ${ms}ms`)),
    /fired after 20ms/
  )
})

test('integration with real timers: a fast work beats a generous ceiling', async () => {
  const fast = new Promise<string>((resolve) => setTimeout(() => resolve('early'), 10))
  const result = await raceWithTimeout(fast, 5000)
  assert.equal(result, 'early')
})
