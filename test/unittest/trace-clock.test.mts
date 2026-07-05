/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 *
 * Usage: node --experimental-strip-types --test test/unittest/trace-clock.test.mts
 *
 * Pins the wall-anchored trace clock contract (trace-clock.ts). Background:
 * performance.timeOrigin + performance.now() drifts from Date.now() on
 * long-lived processes (a production bundle measured a constant 5.011 s skew
 * after ~4.2 days uptime), which split every recordComplete()/timeAsync()
 * span away from the Date.now()-stamped record() events of the same
 * operation. wallNowUs() MUST therefore stay Date.now()-anchored — if a
 * future refactor re-introduces a monotonic-origin sum, the tolerance
 * assertions here fail immediately on any host whose wall clock and
 * monotonic clock disagree, and the contract assertions document why.
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { wallNowUs } from '../../electron/main/trace-clock.ts'

test('wallNowUs is Date.now()-anchored within 10 ms', () => {
  // Sample around the call so scheduler jitter between the two clock reads
  // cannot fail the assertion: before*1000 <= wallNowUs <= after*1000.
  const beforeUs = Date.now() * 1000
  const nowUs = wallNowUs()
  const afterUs = Date.now() * 1000
  assert.ok(nowUs >= beforeUs, `wallNowUs ${nowUs} < before ${beforeUs}`)
  assert.ok(nowUs <= afterUs + 10_000, `wallNowUs ${nowUs} > after ${afterUs} + 10ms`)
})

test('wallNowUs returns integer microseconds (ms granularity)', () => {
  const nowUs = wallNowUs()
  assert.equal(Number.isSafeInteger(nowUs), true)
  // Date.now()*1000 is always a whole multiple of 1000 µs.
  assert.equal(nowUs % 1000, 0)
})

test('wallNowUs is non-decreasing across immediate calls', () => {
  const a = wallNowUs()
  const b = wallNowUs()
  assert.ok(b >= a)
})
