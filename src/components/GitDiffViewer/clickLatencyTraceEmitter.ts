/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

// Convert a sealed click-latency measurement into a flat list of perf-trace
// records. Pure data-in / data-out so it is unit-testable; the actual
// `perfTrace(...)` side effect lives at the call site.
//
// Why split this out: keeping the tracker module free of trace-system
// imports lets it run inside Node's test runner without mocking the
// renderer-side `perf-trace` shim.

import type { ClickLatencyMeasurement } from './clickLatencyTracker'
import { CLICK_PHASE_EVENT_NAMES } from '../../utils/click-phase-event-names.ts'

export { CLICK_PHASE_EVENT_NAMES } from '../../utils/click-phase-event-names.ts'

export interface ClickPhaseTraceRecord {
  event: string
  payload: Record<string, unknown>
}

export interface ClickPhaseTraceContext {
  cwd: string
  terminalId: string
}

const round2 = (value: number) => +value.toFixed(2)

/**
 * Build the per-phase span records (`ph='X'`) plus a total span. Returns
 * an empty array when the measurement was cancelled or settle never fired.
 * Each record's payload carries `durationMs` so `perf-trace-logger`'s
 * `resolvePhase` auto-routes it to `ph='X'`.
 */
export function buildClickPhaseTraceRecords(
  measurement: ClickLatencyMeasurement,
  context: ClickPhaseTraceContext
): ClickPhaseTraceRecord[] {
  if (measurement.cancelled) return []
  if (measurement.tokenizeSettleAt === null) return []

  const base = {
    cwd: context.cwd,
    terminalId: context.terminalId,
    fileKey: measurement.fileKey,
    filename: measurement.filename,
    cacheState: measurement.cacheState,
    cacheSource: measurement.cacheSource,
    cacheMissReason: measurement.cacheMissReason,
    totalMs: measurement.totalMs ?? 0,
    firstPaintMs: measurement.firstPaintMs ?? null,
    settleReason: measurement.settleReason ?? null,
    coldMountMs: measurement.coldMountMs ?? null
  }
  const records: ClickPhaseTraceRecord[] = []

  const pushSpan = (event: string, fromMs: number | null, toMs: number | null): void => {
    if (fromMs === null || toMs === null) return
    const durationMs = toMs - fromMs
    if (!Number.isFinite(durationMs) || durationMs < 0) return
    records.push({ event, payload: { ...base, durationMs: round2(durationMs) } })
  }

  // Use clickAt as the IPC start fallback when ipcStartAt is null. Under EDR a
  // re-click of the same fileKey between markIpcStart and markIpcEnd allocates a
  // fresh active with ipcStartAt=null while the original markIpcEnd still sets
  // ipcEndAt -> the sealed measurement has ipcEndAt set but ipcStartAt null.
  // clickAt is always set at start(), so it is the safe lower bound for the IPC
  // span. Mirrors the ?? fallback pattern used for the later spans below.
  pushSpan(CLICK_PHASE_EVENT_NAMES.IPC, measurement.ipcStartAt ?? measurement.clickAt, measurement.ipcEndAt)
  pushSpan(CLICK_PHASE_EVENT_NAMES.STATE_SET, measurement.ipcEndAt, measurement.stateSetAt)
  pushSpan(CLICK_PHASE_EVENT_NAMES.MODEL_BIND, measurement.stateSetAt, measurement.modelBoundAt)
  pushSpan(CLICK_PHASE_EVENT_NAMES.MOUNT, measurement.modelBoundAt ?? measurement.stateSetAt, measurement.editorReadyAt)
  pushSpan(CLICK_PHASE_EVENT_NAMES.DIFF_COMPUTE, measurement.editorReadyAt ?? measurement.modelBoundAt, measurement.diffComputedAt)
  pushSpan(CLICK_PHASE_EVENT_NAMES.DOM_COMMIT, measurement.diffComputedAt, measurement.domCommittedAt)
  pushSpan(CLICK_PHASE_EVENT_NAMES.PAINT, measurement.domCommittedAt ?? measurement.diffComputedAt, measurement.paintReadyAt)
  pushSpan(CLICK_PHASE_EVENT_NAMES.TOKENIZE_SETTLE, measurement.paintReadyAt ?? measurement.domCommittedAt ?? measurement.diffComputedAt, measurement.tokenizeSettleAt)
  if (measurement.coldMountMs !== null) {
    records.push({
      event: CLICK_PHASE_EVENT_NAMES.COLD_MOUNT,
      payload: { ...base, durationMs: round2(measurement.coldMountMs) }
    })
  }

  if (measurement.totalMs !== null) {
    records.push({
      event: CLICK_PHASE_EVENT_NAMES.TOTAL,
      payload: { ...base, durationMs: round2(measurement.totalMs) }
    })
  }

  return records
}
