/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 *
 * Unit tests for the production quit hard floor (2026-07-20 incident: the
 * quit chain wedged forever inside `await telemetryService.shutdown()`
 * behind a stalled-threadpool appendFile — the app could not even exit).
 * Pairs with the autotest layer: `run-infra-watchdog` /
 * `run-debug-quit-lifecycle` exercise the wired quit paths.
 *
 * Usage: node --experimental-strip-types --test test/unittest/quit-hard-floor.test.mts
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { raceQuitSequenceAgainstFloor } from '../../electron/main/quit-hard-floor.ts'

test('QHF-U-01 sequence completing under the floor → done', async () => {
  const outcome = await raceQuitSequenceAgainstFloor(
    () => new Promise((resolve) => setTimeout(resolve, 20)),
    2_000
  )
  assert.equal(outcome, 'done')
})

test('QHF-U-02 sequence hanging forever → timeout at the floor', async () => {
  const started = Date.now()
  const outcome = await raceQuitSequenceAgainstFloor(
    () => new Promise(() => { /* never settles — the incident shape */ }),
    150
  )
  assert.equal(outcome, 'timeout')
  const elapsed = Date.now() - started
  assert.ok(elapsed >= 140, `floor fired too early (${elapsed}ms)`)
  assert.ok(elapsed < 2_000, `floor fired far too late (${elapsed}ms)`)
})

test('QHF-U-03 sequence rejecting → done (quit errors mean proceed-to-exit, never hang)', async () => {
  const outcome = await raceQuitSequenceAgainstFloor(
    () => Promise.reject(new Error('teardown step failed')),
    2_000
  )
  assert.equal(outcome, 'done')
})

test('QHF-U-04 completion just before the floor still wins the race', async () => {
  const outcome = await raceQuitSequenceAgainstFloor(
    () => new Promise((resolve) => setTimeout(resolve, 50)),
    120
  )
  assert.equal(outcome, 'done')
})
