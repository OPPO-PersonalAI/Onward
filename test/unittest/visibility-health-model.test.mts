/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 *
 * Unit tests for the renderer-visibility watchdog decision model
 * (2026-07-20 incident: visibilityState stranded at 'hidden' for ~10 h
 * while the window was frontmost — no rAF, no paint, DOM mutating
 * invisibly; native visibilitychange recovery proved non-deterministic).
 * Pairs with the autotest layer: `run-infra-watchdog` (IWD probe-transport
 * healthy path via /api/health).
 *
 * Usage: node --experimental-strip-types --test test/unittest/visibility-health-model.test.mts
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  judgeVisibilityProbe,
  reduceVisibilityCheck,
  initialVisibilityWatchState,
  VISIBILITY_MISMATCH_THRESHOLD,
  VISIBILITY_NUDGE_COOLDOWN_MS,
  type VisibilityWatchState,
  type VisibilityVerdict
} from '../../electron/main/visibility-health-model.ts'

const T0 = 5_000_000

const probe = (vis: 'visible' | 'hidden', raf: boolean) => ({
  visibilityState: vis,
  hasFocus: true,
  rafAlive: raf
})

// ─────────── VHM-U-01..06: judge table ───────────

test('VHM-U-01 window hidden per main → not-applicable regardless of probe', () => {
  assert.equal(judgeVisibilityProbe({ windowVisible: false, probe: 'timeout' }), 'not-applicable')
  assert.equal(judgeVisibilityProbe({ windowVisible: false, probe: probe('hidden', false) }), 'not-applicable')
})

test('VHM-U-02 window visible + probe timeout → mismatch (preload responder wedged)', () => {
  assert.equal(judgeVisibilityProbe({ windowVisible: true, probe: 'timeout' }), 'mismatch')
})

test('VHM-U-03 window visible + renderer hidden → mismatch (the incident signature)', () => {
  assert.equal(judgeVisibilityProbe({ windowVisible: true, probe: probe('hidden', false) }), 'mismatch')
})

test('VHM-U-04 window visible + renderer visible + rAF alive → healthy', () => {
  assert.equal(judgeVisibilityProbe({ windowVisible: true, probe: probe('visible', true) }), 'healthy')
})

test('VHM-U-05 window visible + renderer visible + rAF DEAD → mismatch (paint-dead overlap)', () => {
  assert.equal(judgeVisibilityProbe({ windowVisible: true, probe: probe('visible', false) }), 'mismatch')
})

test('VHM-U-06 hidden probe with rAF alive is still a mismatch (visibility wins)', () => {
  assert.equal(judgeVisibilityProbe({ windowVisible: true, probe: probe('hidden', true) }), 'mismatch')
})

// ─────────── VHM-U-10..: reducer / nudge ladder ───────────

function run(state: VisibilityWatchState, verdicts: Array<[VisibilityVerdict, number]>): {
  state: VisibilityWatchState
  actions: string[]
} {
  let s = state
  const actions: string[] = []
  for (const [verdict, at] of verdicts) {
    const r = reduceVisibilityCheck(s, verdict, at)
    s = r.next
    actions.push(...r.actions)
  }
  return { state: s, actions }
}

test('VHM-U-10 single mismatch does not nudge (threshold absorbs transients)', () => {
  const { state, actions } = run(initialVisibilityWatchState(), [['mismatch', T0]])
  assert.equal(state.status, 'ok')
  assert.equal(state.consecutiveMismatches, 1)
  assert.deepEqual(actions, [])
})

test('VHM-U-11 threshold mismatches → record-mismatch + level-1 nudge', () => {
  const verdicts: Array<[VisibilityVerdict, number]> = []
  for (let i = 0; i < VISIBILITY_MISMATCH_THRESHOLD; i++) verdicts.push(['mismatch', T0 + i])
  const { state, actions } = run(initialVisibilityWatchState(), verdicts)
  assert.equal(state.status, 'nudging')
  assert.equal(state.nudgeLevel, 1)
  assert.deepEqual(actions, ['record-mismatch', 'nudge-throttle-toggle'])
})

test('VHM-U-12 mismatch after level-1 → escalate to hide-show (level 2)', () => {
  const { state, actions } = run(initialVisibilityWatchState(), [
    ['mismatch', T0],
    ['mismatch', T0 + 1],
    ['mismatch', T0 + 2]
  ])
  assert.equal(state.status, 'nudging')
  assert.equal(state.nudgeLevel, 2)
  assert.deepEqual(actions, ['record-mismatch', 'nudge-throttle-toggle', 'nudge-hide-show'])
})

test('VHM-U-13 mismatch after level-2 → gave-up with cooldown anchor, no further nudges', () => {
  const { state, actions } = run(initialVisibilityWatchState(), [
    ['mismatch', T0],
    ['mismatch', T0 + 1],
    ['mismatch', T0 + 2],
    ['mismatch', T0 + 3]
  ])
  assert.equal(state.status, 'gave-up')
  assert.equal(state.gaveUpAt, T0 + 3)
  assert.deepEqual(actions.slice(-1), ['record-gave-up'])
  // Mismatches during cooldown stay silent.
  const r = reduceVisibilityCheck(state, 'mismatch', T0 + 4)
  assert.deepEqual(r.actions, [])
  assert.equal(r.next.status, 'gave-up')
})

test('VHM-U-14 cooldown expiry restarts the ladder at level 1', () => {
  const gaveUp = run(initialVisibilityWatchState(), [
    ['mismatch', T0],
    ['mismatch', T0 + 1],
    ['mismatch', T0 + 2],
    ['mismatch', T0 + 3]
  ]).state
  const after = reduceVisibilityCheck(gaveUp, 'mismatch', T0 + 3 + VISIBILITY_NUDGE_COOLDOWN_MS + 1)
  assert.equal(after.next.status, 'nudging')
  assert.equal(after.next.nudgeLevel, 1)
  assert.deepEqual(after.actions, ['record-mismatch', 'nudge-throttle-toggle'])
})

test('VHM-U-15 healthy during nudging → record-recovered + full reset', () => {
  const nudging = run(initialVisibilityWatchState(), [
    ['mismatch', T0],
    ['mismatch', T0 + 1]
  ]).state
  const { next, actions } = reduceVisibilityCheck(nudging, 'healthy', T0 + 2)
  assert.equal(next.status, 'ok')
  assert.equal(next.nudgeLevel, 0)
  assert.equal(next.recoveries, 1)
  assert.deepEqual(actions, ['record-recovered'])
})

test('VHM-U-16 healthy from gave-up also records recovery (late native event)', () => {
  const gaveUp = run(initialVisibilityWatchState(), [
    ['mismatch', T0],
    ['mismatch', T0 + 1],
    ['mismatch', T0 + 2],
    ['mismatch', T0 + 3]
  ]).state
  const { next, actions } = reduceVisibilityCheck(gaveUp, 'healthy', T0 + 10)
  assert.equal(next.status, 'ok')
  assert.equal(next.gaveUpAt, null)
  assert.deepEqual(actions, ['record-recovered'])
})

test('VHM-U-17 not-applicable resets the mismatch run without claiming recovery', () => {
  const oneMiss = run(initialVisibilityWatchState(), [['mismatch', T0]]).state
  const { next, actions } = reduceVisibilityCheck(oneMiss, 'not-applicable', T0 + 1)
  assert.equal(next.consecutiveMismatches, 0)
  assert.equal(next.recoveries, 0)
  assert.deepEqual(actions, [])
})

test('VHM-U-18 healthy steady state emits nothing (30 s cadence must stay silent)', () => {
  const { state, actions } = run(initialVisibilityWatchState(), [
    ['healthy', T0],
    ['healthy', T0 + 1],
    ['healthy', T0 + 2]
  ])
  assert.equal(state.status, 'ok')
  assert.deepEqual(actions, [])
})
