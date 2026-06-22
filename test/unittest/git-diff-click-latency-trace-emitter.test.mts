/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

import { strict as assert } from 'node:assert'
import { test } from 'node:test'

import { buildClickPhaseTraceRecords } from '../../src/components/GitDiffViewer/clickLatencyTraceEmitter.ts'
import { CLICK_PHASE_EVENT_NAMES } from '../../src/utils/click-phase-event-names.ts'
import type { ClickLatencyMeasurement } from '../../src/components/GitDiffViewer/clickLatencyTracker.ts'

const CTX = { cwd: '/repo', terminalId: 't1' }

const baseMeasurement = (overrides: Partial<ClickLatencyMeasurement> = {}): ClickLatencyMeasurement => ({
  fileKey: 'k',
  filename: 'a.ts',
  cacheState: 'hit',
  cacheSource: 'main-content-cache',
  cacheMissReason: null,
  clickAt: 0,
  ipcStartAt: 1,
  ipcEndAt: 5,
  stateSetAt: 6,
  modelBoundAt: 8,
  editorReadyAt: 12,
  diffComputedAt: 16,
  domCommittedAt: 17,
  paintReadyAt: 18,
  tokenizeSettleAt: 24,
  firstPaintMs: 18,
  totalMs: 24,
  settleReason: 'tokens-quiet',
  coldMountMs: null,
  cancelled: false,
  ...overrides
})

test('emits settled phase spans + total when measurement is complete', () => {
  const records = buildClickPhaseTraceRecords(baseMeasurement(), CTX)
  assert.equal(records.length, 9)
  const events = records.map((r) => r.event)
  assert.deepEqual(events, [
    CLICK_PHASE_EVENT_NAMES.IPC,
    CLICK_PHASE_EVENT_NAMES.STATE_SET,
    CLICK_PHASE_EVENT_NAMES.MODEL_BIND,
    CLICK_PHASE_EVENT_NAMES.MOUNT,
    CLICK_PHASE_EVENT_NAMES.DIFF_COMPUTE,
    CLICK_PHASE_EVENT_NAMES.DOM_COMMIT,
    CLICK_PHASE_EVENT_NAMES.PAINT,
    CLICK_PHASE_EVENT_NAMES.TOKENIZE_SETTLE,
    CLICK_PHASE_EVENT_NAMES.TOTAL
  ])
})

test('phase durationMs uses end - start with two-decimal rounding', () => {
  const records = buildClickPhaseTraceRecords(baseMeasurement(), CTX)
  const ipc = records.find((r) => r.event === CLICK_PHASE_EVENT_NAMES.IPC)
  const mount = records.find((r) => r.event === CLICK_PHASE_EVENT_NAMES.MOUNT)
  const settle = records.find((r) => r.event === CLICK_PHASE_EVENT_NAMES.TOKENIZE_SETTLE)
  assert.equal((ipc!.payload as Record<string, unknown>).durationMs, 4)
  assert.equal((mount!.payload as Record<string, unknown>).durationMs, 4)
  assert.equal((settle!.payload as Record<string, unknown>).durationMs, 6)
})

test('returns [] when measurement is cancelled', () => {
  const records = buildClickPhaseTraceRecords(baseMeasurement({ cancelled: true }), CTX)
  assert.deepEqual(records, [])
})

test('returns [] when settle never fired', () => {
  const records = buildClickPhaseTraceRecords(
    baseMeasurement({ tokenizeSettleAt: null, totalMs: null }),
    CTX
  )
  assert.deepEqual(records, [])
})

test('skips intermediate phases that are missing endpoints', () => {
  // The state-set timestamp is null — IPC span still emitted, state-set/mount/diff-compute
  // skipped because their boundary endpoints are missing or out of order.
  const records = buildClickPhaseTraceRecords(
    baseMeasurement({ stateSetAt: null, editorReadyAt: null, diffComputedAt: null }),
    CTX
  )
  const events = records.map((r) => r.event)
  assert.ok(events.includes(CLICK_PHASE_EVENT_NAMES.IPC))
  assert.ok(!events.includes(CLICK_PHASE_EVENT_NAMES.STATE_SET))
  assert.ok(!events.includes(CLICK_PHASE_EVENT_NAMES.MODEL_BIND))
  // Total is still emitted.
  assert.ok(events.includes(CLICK_PHASE_EVENT_NAMES.TOTAL))
})

test('payload carries cwd / terminalId / fileKey / filename / cacheState / cache reason / totalMs', () => {
  const records = buildClickPhaseTraceRecords(
    baseMeasurement({
      filename: 'x/y/z.ts',
      cacheState: 'miss',
      cacheSource: 'worker-rebuild',
      cacheMissReason: 'invalidated-refresh',
      totalMs: 23
    }),
    { cwd: '/abs/repo', terminalId: 'task-42' }
  )
  for (const r of records) {
    const p = r.payload as Record<string, unknown>
    assert.equal(p.cwd, '/abs/repo')
    assert.equal(p.terminalId, 'task-42')
    assert.equal(p.fileKey, 'k')
    assert.equal(p.filename, 'x/y/z.ts')
    assert.equal(p.cacheState, 'miss')
    assert.equal(p.cacheSource, 'worker-rebuild')
    assert.equal(p.cacheMissReason, 'invalidated-refresh')
    assert.equal(p.totalMs, 23)
    assert.equal(p.firstPaintMs, 18)
    assert.equal(p.settleReason, 'tokens-quiet')
    assert.ok(typeof p.durationMs === 'number')
  }
})

test('emits IPC span via clickAt fallback when ipcStartAt is null (EDR re-click race)', () => {
  // Under EDR a re-click of the same fileKey between markIpcStart and markIpcEnd
  // allocates a fresh active with ipcStartAt=null while the original markIpcEnd
  // still sets ipcEndAt. The sealed measurement then has ipcEndAt set but
  // ipcStartAt null. The emitter must still produce a click-phase.ipc record
  // (using clickAt as the start fallback) so the phase chain stays complete.
  const records = buildClickPhaseTraceRecords(
    baseMeasurement({ clickAt: 0, ipcStartAt: null, ipcEndAt: 5, tokenizeSettleAt: 24 }),
    CTX
  )
  const ipc = records.find((r) => r.event === CLICK_PHASE_EVENT_NAMES.IPC)
  assert.ok(ipc, 'click-phase.ipc must be emitted even when ipcStartAt is null')
  // Duration falls back to ipcEndAt - clickAt = 5 - 0.
  assert.equal((ipc.payload as Record<string, unknown>).durationMs, 5)
})

test('emits cold mount span when present', () => {
  const records = buildClickPhaseTraceRecords(baseMeasurement({ coldMountMs: 123.456 }), CTX)
  const coldMount = records.find((r) => r.event === CLICK_PHASE_EVENT_NAMES.COLD_MOUNT)
  assert.ok(coldMount)
  assert.equal((coldMount.payload as Record<string, unknown>).durationMs, 123.46)
})
