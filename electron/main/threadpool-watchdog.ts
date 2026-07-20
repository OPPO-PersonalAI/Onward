/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 *
 * libuv-threadpool watchdog — side-effect wiring.
 *
 * Decision logic lives in `threadpool-health-model.ts` (pure, unit-tested).
 * This module owns the probe mechanics and the blast-radius plumbing:
 *
 *  - every PROBE_INTERVAL_MS, submit a 1-byte `zlib.gzip` (pure CPU, always
 *    routed through the libuv threadpool, never touches disk) and race it
 *    against PROBE_TIMEOUT_MS;
 *  - an extra probe fires right after `powerMonitor` resume / unlock-screen —
 *    the 2026-07-20 incident began exactly at a display-sleep boundary;
 *  - on stall: record a trace event (the trace store is fully synchronous,
 *    so the breadcrumb lands on disk even while async fs is dead), flip the
 *    degraded flag consumed by telemetry / diagnostic-bundle / app-state
 *    fallbacks, and broadcast to every renderer so the UI can suggest a
 *    restart (the restart decision belongs to the user — this is a terminal
 *    app; restarting kills every running shell);
 *  - keep probing after a stall so a theoretical late recovery is also
 *    observed, reported, and un-degrades the process.
 *
 * The watchdog also aggregates the pty-write counters exposed by the
 * patched node-pty CustomWriteStream (globalThis.__onwardPtyEagainCount /
 * __onwardPtyWriteErrorCount) into rate-limited trace events, keeping the
 * patch itself free of any dependency on our modules.
 */

import { BrowserWindow, powerMonitor } from 'electron'
import { gzip } from 'zlib'
import { IPC } from '../shared/ipc-channels'
import { performanceTrace } from './performance-trace'
import { PERF_TRACE_EVENT } from '../../src/utils/perf-trace-names'
import {
  initialThreadpoolHealthState,
  reduceThreadpoolProbe,
  type ThreadpoolHealthState,
  type ThreadpoolProbeOutcome
} from './threadpool-health-model'

const PROBE_INTERVAL_MS = 15_000
const PROBE_TIMEOUT_MS = 5_000
const PROBE_PAYLOAD = Buffer.from([0])

interface PtyCounterGlobals {
  __onwardPtyEagainCount?: number
  __onwardPtyWriteErrorCount?: number
}

let state: ThreadpoolHealthState = initialThreadpoolHealthState()
let probeTimer: ReturnType<typeof setInterval> | null = null
let probeInFlight = false
let simulatedStall = false
let lastEagainCount = 0
let lastWriteErrorCount = 0

/** Degraded flag consumed by telemetry / diagnostic-bundle / app-state. */
export function isThreadpoolStalled(): boolean {
  return simulatedStall || state.status === 'stalled'
}

export function getThreadpoolHealthSnapshot(): {
  status: 'ok' | 'suspect' | 'stalled'
  stalledSince: number | null
  recoveries: number
} {
  return {
    status: simulatedStall ? 'stalled' : state.status,
    stalledSince: simulatedStall ? (state.stalledSince ?? Date.now()) : state.stalledSince,
    recoveries: state.recoveries
  }
}

/**
 * Autotest hook (DEBUG_SIMULATE_THREADPOOL_STALL): force the degraded state
 * and broadcast, without needing a genuinely wedged threadpool. Windows CI
 * cannot reproduce the POSIX fifo-based real stall, but the downstream
 * wiring (toast, degraded fallbacks, /api/health) is platform-neutral and
 * is exercised through this hook.
 */
export function simulateThreadpoolStallForAutotest(stalled: boolean): void {
  simulatedStall = stalled
  if (stalled) {
    performanceTrace.record(PERF_TRACE_EVENT.MAIN_THREADPOOL_WATCHDOG_STALL_DETECTED, {
      simulated: true,
      consecutiveFailures: state.consecutiveFailures
    })
    broadcastHealth()
  } else {
    performanceTrace.record(PERF_TRACE_EVENT.MAIN_THREADPOOL_WATCHDOG_RECOVERED, {
      simulated: true
    })
    broadcastHealth()
  }
}

function broadcastHealth(): void {
  const snapshot = getThreadpoolHealthSnapshot()
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed() || win.webContents.isDestroyed()) continue
    try {
      win.webContents.send(IPC.SYSTEM_THREADPOOL_HEALTH, snapshot)
    } catch {
      // Frame torn down mid-send (same guard as gpu-crash-recovery).
    }
  }
}

function runProbe(reason: 'interval' | 'power-event'): void {
  if (probeInFlight) return
  probeInFlight = true

  let settled = false
  const timeoutTimer = setTimeout(() => {
    if (settled) return
    settled = true
    probeInFlight = false
    onProbeOutcome('timeout', reason)
  }, PROBE_TIMEOUT_MS)
  timeoutTimer.unref()

  gzip(PROBE_PAYLOAD, () => {
    if (settled) return
    settled = true
    clearTimeout(timeoutTimer)
    probeInFlight = false
    onProbeOutcome('success', reason)
  })
}

function onProbeOutcome(outcome: ThreadpoolProbeOutcome, reason: 'interval' | 'power-event'): void {
  const { next, events } = reduceThreadpoolProbe(state, outcome, Date.now())
  state = next

  for (const event of events) {
    if (event === 'stall-detected') {
      performanceTrace.record(PERF_TRACE_EVENT.MAIN_THREADPOOL_WATCHDOG_STALL_DETECTED, {
        probeReason: reason,
        consecutiveFailures: state.consecutiveFailures,
        firstFailureAt: state.firstFailureAt
      })
      broadcastHealth()
    } else if (event === 'recovered') {
      performanceTrace.record(PERF_TRACE_EVENT.MAIN_THREADPOOL_WATCHDOG_RECOVERED, {
        probeReason: reason,
        recoveries: state.recoveries
      })
      broadcastHealth()
    }
  }

  flushPtyCounters()
}

/**
 * Fold the patched CustomWriteStream's counters into trace events at probe
 * cadence (≤ 1 event / PROBE_INTERVAL_MS per counter — never per keystroke).
 */
function flushPtyCounters(): void {
  const g = globalThis as PtyCounterGlobals
  const eagain = g.__onwardPtyEagainCount ?? 0
  const errors = g.__onwardPtyWriteErrorCount ?? 0
  if (eagain !== lastEagainCount) {
    performanceTrace.record(PERF_TRACE_EVENT.MAIN_PTY_WRITE_EAGAIN_REQUEUE, {
      total: eagain,
      delta: eagain - lastEagainCount
    })
    lastEagainCount = eagain
  }
  if (errors !== lastWriteErrorCount) {
    performanceTrace.record(PERF_TRACE_EVENT.MAIN_PTY_WRITE_SYNC_ERROR, {
      total: errors,
      delta: errors - lastWriteErrorCount
    })
    lastWriteErrorCount = errors
  }
}

export function startThreadpoolWatchdog(): void {
  if (probeTimer) return

  probeTimer = setInterval(() => runProbe('interval'), PROBE_INTERVAL_MS)
  probeTimer.unref()

  // The incident boundary: display sleep / session unlock. Probe immediately
  // so a wedged pool is detected within seconds of the risky transition
  // instead of waiting out the interval.
  powerMonitor.on('resume', () => runProbe('power-event'))
  powerMonitor.on('unlock-screen', () => runProbe('power-event'))

  runProbe('interval')
}

export function stopThreadpoolWatchdog(): void {
  if (probeTimer) {
    clearInterval(probeTimer)
    probeTimer = null
  }
}
