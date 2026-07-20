/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 *
 * Unit tests for the libuv-threadpool watchdog decision model (2026-07-20
 * incident: workers lost their condvar wakeup after a macOS display-sleep
 * boundary; async fs/dns/zlib/crypto silently dead while timers/IPC stayed
 * healthy). Pairs with the autotest layer: `run-infra-watchdog` (IWD-01..05
 * simulated-stall downstream wiring) and the real-stall probe harness in
 * `threadpool-stall-probe.test.mts`.
 *
 * Usage: node --experimental-strip-types --test test/unittest/threadpool-health-model.test.mts
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  initialThreadpoolHealthState,
  reduceThreadpoolProbe,
  THREADPOOL_STALL_THRESHOLD
} from '../../electron/main/threadpool-health-model.ts'

const T0 = 1_000_000

test('TPH-U-01 ok + success stays ok with no events (steady state)', () => {
  const s0 = initialThreadpoolHealthState()
  const { next, events } = reduceThreadpoolProbe(s0, 'success', T0)
  assert.equal(next.status, 'ok')
  assert.equal(next.consecutiveFailures, 0)
  assert.deepEqual(events, [])
})

test('TPH-U-02 first timeout → suspect, no stall event yet', () => {
  const s0 = initialThreadpoolHealthState()
  const { next, events } = reduceThreadpoolProbe(s0, 'timeout', T0)
  assert.equal(next.status, 'suspect')
  assert.equal(next.consecutiveFailures, 1)
  assert.equal(next.firstFailureAt, T0)
  assert.deepEqual(events, [])
})

test('TPH-U-03 threshold consecutive timeouts → stalled + stall-detected exactly once', () => {
  let s = initialThreadpoolHealthState()
  let allEvents: string[] = []
  for (let i = 0; i < THREADPOOL_STALL_THRESHOLD; i++) {
    const r = reduceThreadpoolProbe(s, 'timeout', T0 + i * 15_000)
    s = r.next
    allEvents = allEvents.concat(r.events)
  }
  assert.equal(s.status, 'stalled')
  assert.equal(s.stalledSince, T0 + (THREADPOOL_STALL_THRESHOLD - 1) * 15_000)
  assert.deepEqual(allEvents, ['stall-detected'])
})

test('TPH-U-04 timeouts beyond the threshold do NOT re-emit stall-detected', () => {
  let s = initialThreadpoolHealthState()
  for (let i = 0; i < THREADPOOL_STALL_THRESHOLD; i++) {
    s = reduceThreadpoolProbe(s, 'timeout', T0 + i).next
  }
  const { next, events } = reduceThreadpoolProbe(s, 'timeout', T0 + 100)
  assert.equal(next.status, 'stalled')
  assert.deepEqual(events, [])
  assert.equal(next.consecutiveFailures, THREADPOOL_STALL_THRESHOLD + 1)
})

test('TPH-U-05 suspect + success resets to ok without any event (transient blip absorbed)', () => {
  const s1 = reduceThreadpoolProbe(initialThreadpoolHealthState(), 'timeout', T0).next
  const { next, events } = reduceThreadpoolProbe(s1, 'success', T0 + 15_000)
  assert.equal(next.status, 'ok')
  assert.equal(next.consecutiveFailures, 0)
  assert.equal(next.firstFailureAt, null)
  assert.deepEqual(events, [])
})

test('TPH-U-06 stalled + success → recovered event, counters reset, recoveries incremented', () => {
  let s = initialThreadpoolHealthState()
  for (let i = 0; i < THREADPOOL_STALL_THRESHOLD; i++) {
    s = reduceThreadpoolProbe(s, 'timeout', T0 + i).next
  }
  const { next, events } = reduceThreadpoolProbe(s, 'success', T0 + 500)
  assert.equal(next.status, 'ok')
  assert.equal(next.stalledSince, null)
  assert.equal(next.recoveries, 1)
  assert.deepEqual(events, ['recovered'])
})

test('TPH-U-07 firstFailureAt anchors to the FIRST timeout of the run, not the declaring one', () => {
  let s = initialThreadpoolHealthState()
  s = reduceThreadpoolProbe(s, 'timeout', T0).next
  s = reduceThreadpoolProbe(s, 'timeout', T0 + 15_000).next
  assert.equal(s.firstFailureAt, T0)
})

test('TPH-U-08 a full stall→recover→stall cycle emits both events again', () => {
  let s = initialThreadpoolHealthState()
  const events: string[] = []
  const feed = (outcome: 'success' | 'timeout', at: number) => {
    const r = reduceThreadpoolProbe(s, outcome, at)
    s = r.next
    events.push(...r.events)
  }
  feed('timeout', T0)
  feed('timeout', T0 + 1)
  feed('success', T0 + 2)
  feed('timeout', T0 + 3)
  feed('timeout', T0 + 4)
  assert.deepEqual(events, ['stall-detected', 'recovered', 'stall-detected'])
  assert.equal(s.recoveries, 1)
  assert.equal(s.status, 'stalled')
})
