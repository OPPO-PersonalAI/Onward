/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 *
 * Usage: node --experimental-strip-types --test test/unittest/memory-pressure-detector.test.mts
 *
 * Pins the pure decision logic of the memory diagnostics closed loop
 * (MemoryWatcher Tier 2). Pairs with the autotest layer:
 * run-memory-watch-autotest.sh (MW-*) drives the real inject → report →
 * notification → bundle chain; this layer pins the math so a threshold or
 * unit-conversion change can never silently flip the trigger semantics.
 * Unit-conversion cases exist because Electron reports KB while Node
 * reports bytes — the VS Code `code --status` double-conversion defect is
 * the motivating precedent.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  bytesToKb,
  toFiniteKb,
  evaluateMemoryPressure,
  shouldPromptUser,
  hasSnapshotHeadroom,
  DEFAULT_MEMORY_PRESSURE_CONFIG,
  type MemoryPressureConfig,
  type RendererMemorySample
} from '../../electron/main/memory-pressure-detector.ts'

const CFG: MemoryPressureConfig = { ...DEFAULT_MEMORY_PRESSURE_CONFIG }
const NOW = 10_000_000

function samplesAt(offsetsMs: number[], make: (i: number) => Partial<RendererMemorySample>): RendererMemorySample[] {
  return offsetsMs.map((offset, i) => ({
    atMs: NOW - offset,
    workingSetKb: null,
    heapUsedKb: null,
    heapLimitKb: null,
    ...make(i)
  }))
}

// ---------- Unit conversion ----------

test('MPD-U-01 bytesToKb rounds and clamps non-finite/negative to 0', () => {
  assert.equal(bytesToKb(0), 0)
  assert.equal(bytesToKb(-5), 0)
  assert.equal(bytesToKb(Number.NaN), 0)
  assert.equal(bytesToKb(Number.POSITIVE_INFINITY), 0)
  assert.equal(bytesToKb(1024), 1)
  assert.equal(bytesToKb(1536), 2) // rounds, not floors
  assert.equal(bytesToKb(1073741824), 1048576) // 1 GiB in bytes → KB
})

test('MPD-U-02 toFiniteKb accepts numbers/numeric-like, rejects junk', () => {
  assert.equal(toFiniteKb(2048), 2048)
  assert.equal(toFiniteKb(2048.6), 2049)
  assert.equal(toFiniteKb('123'), 123)
  assert.equal(toFiniteKb(-1), null)
  assert.equal(toFiniteKb('abc'), null)
  assert.equal(toFiniteKb(undefined), null)
  assert.equal(toFiniteKb(null), null)
  assert.equal(toFiniteKb(Number.NaN), null)
})

// ---------- evaluateMemoryPressure: window + sustain semantics ----------

test('MPD-U-03 empty / too-few samples → none (insufficient-samples)', () => {
  const none = evaluateMemoryPressure([], CFG, NOW)
  assert.equal(none.level, 'none')
  assert.equal(none.reason, 'insufficient-samples')

  const two = samplesAt([30_000, 0], () => ({ workingSetKb: CFG.footprintWarnKb * 2 }))
  const verdict = evaluateMemoryPressure(two, CFG, NOW)
  assert.equal(verdict.level, 'none')
  assert.equal(verdict.reason, 'insufficient-samples')
})

test('MPD-U-04 sustained footprint above warn threshold → warn', () => {
  const s = samplesAt([90_000, 60_000, 30_000, 0], () => ({ workingSetKb: CFG.footprintWarnKb + 1024 }))
  const verdict = evaluateMemoryPressure(s, CFG, NOW)
  assert.equal(verdict.level, 'warn')
  assert.equal(verdict.reason, 'footprint-sustained')
  assert.equal(verdict.windowSamples, 4)
})

test('MPD-U-05 one dip below threshold inside window → none (a spike is not pressure)', () => {
  const s = samplesAt([90_000, 60_000, 30_000, 0], (i) => ({
    workingSetKb: i === 2 ? CFG.footprintWarnKb - 1024 : CFG.footprintWarnKb + 1024
  }))
  const verdict = evaluateMemoryPressure(s, CFG, NOW)
  assert.equal(verdict.level, 'none')
  assert.equal(verdict.reason, 'below-threshold')
})

test('MPD-U-06 old samples outside the window are ignored', () => {
  // 3 high samples but all older than windowMs → they fall outside.
  const s = samplesAt([300_000, 250_000, 200_000], () => ({ workingSetKb: CFG.footprintWarnKb * 2 }))
  const verdict = evaluateMemoryPressure(s, CFG, NOW)
  assert.equal(verdict.level, 'none')
  assert.equal(verdict.reason, 'insufficient-samples')
  assert.equal(verdict.windowSamples, 0)
})

test('MPD-U-07 sustained heap ratio above warn → warn even with unknown footprint', () => {
  const limit = 4 * 1024 * 1024 // 4 GB in KB
  const s = samplesAt([90_000, 60_000, 30_000, 0], () => ({
    heapUsedKb: Math.round(limit * (CFG.heapRatioWarn + 0.05)),
    heapLimitKb: limit
  }))
  const verdict = evaluateMemoryPressure(s, CFG, NOW)
  assert.equal(verdict.level, 'warn')
  assert.equal(verdict.reason, 'heap-ratio-sustained')
  assert.ok(verdict.heapRatio !== null && verdict.heapRatio > CFG.heapRatioWarn)
})

test('MPD-U-08 heap ratio ≥ critical absolute (0.85) sustained → critical', () => {
  const limit = 4 * 1024 * 1024
  const s = samplesAt([90_000, 60_000, 30_000, 0], () => ({
    heapUsedKb: Math.round(limit * 0.9),
    heapLimitKb: limit
  }))
  const verdict = evaluateMemoryPressure(s, CFG, NOW)
  assert.equal(verdict.level, 'critical')
})

test('MPD-U-09 footprint ≥ warn × criticalMultiplier sustained → critical', () => {
  const s = samplesAt([90_000, 60_000, 30_000, 0], () => ({
    workingSetKb: Math.round(CFG.footprintWarnKb * CFG.criticalFootprintMultiplier) + 1024
  }))
  const verdict = evaluateMemoryPressure(s, CFG, NOW)
  assert.equal(verdict.level, 'critical')
})

test('MPD-U-10 zero/invalid heap limit never divides — ratio path stays null', () => {
  const s = samplesAt([90_000, 60_000, 30_000, 0], () => ({ heapUsedKb: 100, heapLimitKb: 0 }))
  const verdict = evaluateMemoryPressure(s, CFG, NOW)
  assert.equal(verdict.level, 'none')
  assert.equal(verdict.heapRatio, null)
})

test('MPD-U-11 mixed null footprint samples: only samples carrying the field count toward sustain', () => {
  // 3 valid high footprint samples + 2 null-footprint samples → still warn.
  const s = samplesAt([100_000, 75_000, 50_000, 25_000, 0], (i) => ({
    workingSetKb: i % 2 === 0 ? CFG.footprintWarnKb + 1024 : null
  }))
  const verdict = evaluateMemoryPressure(s, CFG, NOW)
  assert.equal(verdict.level, 'warn')
  assert.equal(verdict.reason, 'footprint-sustained')
})

// ---------- shouldPromptUser: Discord-style guardrails ----------

const WARN_VERDICT = evaluateMemoryPressure(
  samplesAt([90_000, 60_000, 30_000, 0], () => ({ workingSetKb: CFG.footprintWarnKb + 1024 })),
  CFG,
  NOW
)

test('MPD-U-12 verdict none → never prompt', () => {
  const none = evaluateMemoryPressure([], CFG, NOW)
  const d = shouldPromptUser(none, { appStartedAtMs: 0, promptedCount: 0, lastPromptAtMs: null }, CFG, NOW)
  assert.deepEqual(d, { prompt: false, skipReason: 'below-threshold' })
})

test('MPD-U-13 uptime below floor → skip (uptime)', () => {
  const d = shouldPromptUser(
    WARN_VERDICT,
    { appStartedAtMs: NOW - CFG.minUptimeMs + 1000, promptedCount: 0, lastPromptAtMs: null },
    CFG,
    NOW
  )
  assert.deepEqual(d, { prompt: false, skipReason: 'uptime' })
})

test('MPD-U-14 session cap reached → skip (session-cap)', () => {
  const d = shouldPromptUser(
    WARN_VERDICT,
    { appStartedAtMs: 0, promptedCount: CFG.maxPromptsPerSession, lastPromptAtMs: null },
    CFG,
    NOW
  )
  assert.deepEqual(d, { prompt: false, skipReason: 'session-cap' })
})

test('MPD-U-15 inside cooldown → skip (cooldown)', () => {
  const relaxed: MemoryPressureConfig = { ...CFG, maxPromptsPerSession: 5 }
  const d = shouldPromptUser(
    WARN_VERDICT,
    { appStartedAtMs: 0, promptedCount: 1, lastPromptAtMs: NOW - relaxed.promptCooldownMs + 1000 },
    relaxed,
    NOW
  )
  assert.deepEqual(d, { prompt: false, skipReason: 'cooldown' })
})

test('MPD-U-16 all guards pass → prompt', () => {
  const d = shouldPromptUser(
    WARN_VERDICT,
    { appStartedAtMs: 0, promptedCount: 0, lastPromptAtMs: null },
    CFG,
    NOW
  )
  assert.deepEqual(d, { prompt: true })
})

// ---------- hasSnapshotHeadroom: capture must not OOM the box ----------

test('MPD-U-17 unknown system free memory → fail closed', () => {
  assert.equal(hasSnapshotHeadroom({ systemFreeKb: null, targetHeapUsedKb: 100 }), false)
})

test('MPD-U-18 free ≥ 1.2 × heap → allowed; below → refused', () => {
  assert.equal(hasSnapshotHeadroom({ systemFreeKb: 1200, targetHeapUsedKb: 1000 }), true)
  assert.equal(hasSnapshotHeadroom({ systemFreeKb: 1199, targetHeapUsedKb: 1000 }), false)
})

test('MPD-U-19 unknown target heap (no renderer report yet) → fail open on heap size only', () => {
  assert.equal(hasSnapshotHeadroom({ systemFreeKb: 1, targetHeapUsedKb: null }), true)
})
