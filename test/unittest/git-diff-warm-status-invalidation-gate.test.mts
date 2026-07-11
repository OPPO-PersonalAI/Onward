/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 *
 * Usage: node --experimental-strip-types --test test/unittest/git-diff-warm-status-invalidation-gate.test.mts
 *
 * Locks the pure decision table of the warm-status reuse gate
 * (electron/main/git-diff-warm-status-gate.ts). The gate is the GDS-07 fix:
 * a diff re-warm must never reuse a presupplied `git status` captured at or
 * before the repo's latest mutation-grade cache invalidation, otherwise the
 * re-warm scheduled BY that mutation rebuilds every cache from pre-mutation
 * state — permanently, because the invalidation authority is already spent.
 * The end-to-end companion is run-git-diff-staleness-autotest (GDS-06/07).
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import {
  shouldReuseWarmStatus,
  WARM_STATUS_REUSE_MAX_AGE_MS
} from '../../electron/main/git-diff-warm-status-gate.ts'

const NOW = 1_752_218_000_000

test('WSIG-U-01: fresh capture with no invalidation on record is reused', () => {
  const decision = shouldReuseWarmStatus({
    capturedAt: NOW - 2_000,
    now: NOW,
    lastInvalidatedAt: null
  })
  assert.deepEqual(decision, { reuse: true, ageMs: 2_000 })
})

test('WSIG-U-02: fresh capture strictly after the last invalidation is reused', () => {
  const decision = shouldReuseWarmStatus({
    capturedAt: NOW - 1_000,
    now: NOW,
    lastInvalidatedAt: NOW - 5_000
  })
  assert.deepEqual(decision, { reuse: true, ageMs: 1_000 })
})

test('WSIG-U-03: capture BEFORE the last invalidation is rejected as invalidated (GDS-07 shape)', () => {
  // The exact failing shape: status captured ~2s ago, save invalidated ~100ms
  // ago — young enough for the age gate, but pre-mutation.
  const decision = shouldReuseWarmStatus({
    capturedAt: NOW - 2_016,
    now: NOW,
    lastInvalidatedAt: NOW - 100
  })
  assert.deepEqual(decision, { reuse: false, ageMs: 2_016, reason: 'invalidated' })
})

test('WSIG-U-04: capture in the SAME millisecond as the invalidation is rejected', () => {
  const decision = shouldReuseWarmStatus({
    capturedAt: NOW - 100,
    now: NOW,
    lastInvalidatedAt: NOW - 100
  })
  assert.equal(decision.reuse, false)
  assert.equal((decision as { reason: string }).reason, 'invalidated')
})

test('WSIG-U-05: over-age capture is rejected as stale even with no invalidation', () => {
  const decision = shouldReuseWarmStatus({
    capturedAt: NOW - WARM_STATUS_REUSE_MAX_AGE_MS - 1,
    now: NOW,
    lastInvalidatedAt: null
  })
  assert.equal(decision.reuse, false)
  assert.equal((decision as { reason: string }).reason, 'stale')
})

test('WSIG-U-06: capture exactly at the age ceiling is still reused', () => {
  const decision = shouldReuseWarmStatus({
    capturedAt: NOW - WARM_STATUS_REUSE_MAX_AGE_MS,
    now: NOW,
    lastInvalidatedAt: null
  })
  assert.deepEqual(decision, { reuse: true, ageMs: WARM_STATUS_REUSE_MAX_AGE_MS })
})

test('WSIG-U-07: future-dated capture (clock skew) is rejected as stale', () => {
  const decision = shouldReuseWarmStatus({
    capturedAt: NOW + 500,
    now: NOW,
    lastInvalidatedAt: null
  })
  assert.equal(decision.reuse, false)
  assert.equal((decision as { reason: string }).reason, 'stale')
})

test('WSIG-U-08: age gate wins over invalidation gate in the reported reason', () => {
  // Both clauses reject — the age clause is evaluated first, so the reason
  // stays 'stale' (matches the pre-fix trace vocabulary for old payloads).
  const decision = shouldReuseWarmStatus({
    capturedAt: NOW - WARM_STATUS_REUSE_MAX_AGE_MS - 5_000,
    now: NOW,
    lastInvalidatedAt: NOW - 1_000
  })
  assert.equal(decision.reuse, false)
  assert.equal((decision as { reason: string }).reason, 'stale')
})

test('WSIG-U-09: maxAgeMs override is honored', () => {
  const decision = shouldReuseWarmStatus({
    capturedAt: NOW - 3_000,
    now: NOW,
    lastInvalidatedAt: null,
    maxAgeMs: 2_000
  })
  assert.equal(decision.reuse, false)
  assert.equal((decision as { reason: string }).reason, 'stale')
})
