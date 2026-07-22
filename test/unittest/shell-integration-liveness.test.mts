/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 *
 * Usage: node --experimental-strip-types --test test/unittest/shell-integration-liveness.test.mts
 *
 * Locks the shell-integration liveness state machine (F2 of the 2026-07
 * bundle fixes): waiting → proven (OSC before the window), waiting → silent
 * (window elapses), silent → recovered (late OSC). Timers are injected so
 * the transitions are deterministic — no wall-clock sleeps.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { ShellIntegrationLivenessTracker } from '../../electron/main/shell-integration-liveness.ts'

/** Manual timer harness: fire() runs every pending timer callback. */
function makeHarness() {
  const pending = new Map<number, () => void>()
  let nextId = 1
  let now = 0
  const tracker = new ShellIntegrationLivenessTracker(
    (fn) => {
      const id = nextId++
      pending.set(id, fn)
      return id as unknown as ReturnType<typeof setTimeout>
    },
    (t) => { pending.delete(t as unknown as number) },
    () => now
  )
  return {
    tracker,
    fireTimers: () => {
      const fns = Array.from(pending.values())
      pending.clear()
      for (const fn of fns) fn()
    },
    hasPendingTimers: () => pending.size > 0,
    advance: (ms: number) => { now += ms }
  }
}

test('proof before the window → proven, timer cancelled, no callbacks', () => {
  const h = makeHarness()
  const events: string[] = []
  h.tracker.setCallbacks({
    onSilent: (id) => events.push(`silent:${id}`),
    onRecovered: (id) => events.push(`recovered:${id}`)
  })
  h.tracker.start('t1', 'powershell')
  h.tracker.markShellProof('t1')
  assert.equal(h.tracker.getState('t1'), 'proven')
  assert.equal(h.hasPendingTimers(), false, 'timer must be cancelled on proof')
  h.fireTimers()
  assert.deepEqual(events, [])
})

test('window elapses with no proof → silent fires exactly once', () => {
  const h = makeHarness()
  const events: string[] = []
  h.tracker.setCallbacks({
    onSilent: (id, shellKind) => events.push(`silent:${id}:${shellKind}`),
    onRecovered: (id) => events.push(`recovered:${id}`)
  })
  h.tracker.start('t1', 'powershell')
  h.advance(15_000)
  h.fireTimers()
  assert.equal(h.tracker.getState('t1'), 'silent')
  assert.deepEqual(events, ['silent:t1:powershell'])
  h.fireTimers()
  assert.deepEqual(events, ['silent:t1:powershell'], 'silent must not re-fire')
})

test('late proof after silent → recovered fires exactly once', () => {
  const h = makeHarness()
  const events: string[] = []
  h.tracker.setCallbacks({
    onSilent: (id) => events.push(`silent:${id}`),
    onRecovered: (id) => events.push(`recovered:${id}`)
  })
  h.tracker.start('t1', 'powershell')
  h.fireTimers()
  assert.equal(h.tracker.getState('t1'), 'silent')
  h.tracker.markShellProof('t1')
  assert.equal(h.tracker.getState('t1'), 'recovered')
  h.tracker.markShellProof('t1')
  assert.equal(h.tracker.getState('t1'), 'recovered', 'stays recovered')
  assert.deepEqual(events, ['silent:t1', 'recovered:t1'])
})

test('re-arming (terminal respawn) resets state; dispose cancels the window', () => {
  const h = makeHarness()
  const events: string[] = []
  h.tracker.setCallbacks({
    onSilent: (id) => events.push(`silent:${id}`),
    onRecovered: () => events.push('recovered')
  })
  h.tracker.start('t1', 'powershell')
  h.tracker.markShellProof('t1')
  assert.equal(h.tracker.getState('t1'), 'proven')
  h.tracker.start('t1', 'powershell')
  assert.equal(h.tracker.getState('t1'), 'waiting', 'respawn re-arms')
  h.tracker.dispose('t1')
  assert.equal(h.tracker.getState('t1'), null)
  h.fireTimers()
  assert.deepEqual(events, [], 'disposed terminal never reports')
})

test('proof for an unknown terminal is a safe no-op', () => {
  const h = makeHarness()
  h.tracker.markShellProof('nope')
  assert.equal(h.tracker.getState('nope'), null)
})
