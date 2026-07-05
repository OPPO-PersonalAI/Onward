/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 *
 * Usage: node --experimental-strip-types --test test/unittest/git-state-mirror-recompute-governor.test.mts
 *
 * Locks the G3 admission decision table (2026-07-04 spinner analysis):
 * foreground-yield, cross-repo budget, and the adaptive watcher duty-cycle
 * floor. Pure state machine over injected timestamps — every case is
 * deterministic, no timers, no EDR dependence.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { MirrorRecomputeGovernor } from '../../electron/main/git-state-mirror-recompute-governor.ts'

test('user-driven kinds always admit, regardless of budget / foreground / floor', () => {
  const gov = new MirrorRecomputeGovernor({ maxConcurrent: 1 })
  gov.onStart('/a') // budget full
  gov.setForegroundBusy('/b', true, 1000)
  gov.onEnd('/b', 1000, 5000) // huge duty-cycle floor
  assert.equal(gov.admit('/b', 'user', 1001).admit, true)
})

test('foreground-yield defers watcher AND reconcile for the busy repo only', () => {
  const gov = new MirrorRecomputeGovernor()
  gov.setForegroundBusy('/repo', true, 1000)
  const watcher = gov.admit('/repo', 'watcher', 1001)
  const reconcile = gov.admit('/repo', 'reconcile', 1001)
  assert.equal(watcher.admit, false)
  assert.equal(watcher.reason, 'foreground-yield')
  assert.equal(reconcile.admit, false)
  assert.equal(gov.admit('/other', 'watcher', 1001).admit, true, 'other repos unaffected')
})

test('foreground grace: busy=false keeps deferring for foregroundGraceMs, then admits', () => {
  const gov = new MirrorRecomputeGovernor({ foregroundGraceMs: 1500 })
  gov.setForegroundBusy('/repo', true, 1000)
  gov.setForegroundBusy('/repo', false, 2000)
  assert.equal(gov.admit('/repo', 'watcher', 2100).admit, false, 'still inside the grace window')
  assert.equal(gov.admit('/repo', 'watcher', 3501).admit, true, 'grace elapsed')
})

test('global budget: at maxConcurrent running, background recomputes defer; a slot freeing admits', () => {
  const gov = new MirrorRecomputeGovernor({ maxConcurrent: 2 })
  gov.onStart('/a')
  gov.onStart('/b')
  const decision = gov.admit('/c', 'reconcile', 1000)
  assert.equal(decision.admit, false)
  assert.equal(decision.reason, 'budget')
  gov.onEnd('/a', 2000, 1000)
  assert.equal(gov.admit('/c', 'reconcile', 2001).admit, true)
})

test('watcher duty-cycle floor: next watcher recompute waits out lastDurationMs after the end', () => {
  const gov = new MirrorRecomputeGovernor()
  gov.onStart('/repo')
  gov.onEnd('/repo', 10_000, 3000) // a 3 s status ended at t=10s
  const early = gov.admit('/repo', 'watcher', 11_000) // 1 s after end < 3 s floor
  assert.equal(early.admit, false)
  assert.equal(early.reason, 'duty-cycle')
  assert.ok((early.retryInMs ?? 0) >= 2000, `retry should cover the remaining floor, got ${early.retryInMs}`)
  assert.equal(gov.admit('/repo', 'watcher', 13_001).admit, true, 'floor elapsed')
})

test('reconcile kind is EXEMPT from the duty-cycle floor (its own backoff governs cadence)', () => {
  const gov = new MirrorRecomputeGovernor()
  gov.onStart('/repo')
  gov.onEnd('/repo', 10_000, 3000)
  assert.equal(gov.admit('/repo', 'reconcile', 10_001).admit, true)
})

test('fast host: a small lastDuration makes the floor invisible (zero regression)', () => {
  const gov = new MirrorRecomputeGovernor()
  gov.onStart('/repo')
  gov.onEnd('/repo', 10_000, 40) // 40 ms status
  assert.equal(gov.admit('/repo', 'watcher', 10_041).admit, true)
})

test('duty-cycle deferral is capped by maxDutyCycleDeferMs', () => {
  const gov = new MirrorRecomputeGovernor({ maxDutyCycleDeferMs: 5000 })
  gov.onStart('/repo')
  gov.onEnd('/repo', 10_000, 60_000) // pathological 60 s status
  assert.equal(gov.admit('/repo', 'watcher', 15_001).admit, true, 'cap bounds the park time')
})

test('removeRepo drops per-repo state (detached repos admit freshly)', () => {
  const gov = new MirrorRecomputeGovernor()
  gov.onStart('/repo')
  gov.onEnd('/repo', 10_000, 3000)
  gov.removeRepo('/repo')
  assert.equal(gov.admit('/repo', 'watcher', 10_001).admit, true)
})
