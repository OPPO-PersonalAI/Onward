/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 *
 * Filesystem + lifecycle wiring for the session ledger (clean-shutdown
 * marker). Pure verdict logic lives in session-ledger-core.ts.
 *
 * Lifecycle: initializeSessionLedger() runs once at startup — it judges the
 * previous instance's ledger, retains abnormal evidence locally (append-only
 * jsonl, never cleared), and writes this instance's clean=false ledger.
 * A 60 s unref'd heartbeat refreshes lastSeenAt so an abnormal end is
 * bounded to the minute. Every graceful-quit path calls
 * markSessionLedgerClean() as part of its teardown.
 */

import { app } from 'electron'
import { appendFileSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { performanceTrace } from './performance-trace'
import { PERF_TRACE_EVENT } from '../../src/utils/perf-trace-names'
import {
  createLedgerRecord,
  evaluatePreviousLedger,
  ledgerUptimeMs,
  markLedgerClean,
  type PreviousSessionVerdict,
  type SessionLedgerRecord
} from './session-ledger-core'

const LEDGER_FILE = 'session-ledger.json'
const ABNORMAL_LOG_FILE = 'abnormal-exits.jsonl'
const HEARTBEAT_MS = 60_000

let currentRecord: SessionLedgerRecord | null = null
let heartbeatTimer: NodeJS.Timeout | null = null
let cleanMarked = false

function ledgerPath(): string {
  return join(app.getPath('userData'), LEDGER_FILE)
}

function writeLedger(record: SessionLedgerRecord): void {
  try {
    writeFileSync(ledgerPath(), JSON.stringify(record, null, 2))
  } catch (error) {
    console.warn('[SessionLedger] write failed:', error)
  }
}

/**
 * Judge the previous instance and start this instance's ledger. Call once,
 * after app identity (userData) is resolved. Returns the verdict so the
 * caller can emit telemetry / notify the renderer when it is ready.
 */
export function initializeSessionLedger(): PreviousSessionVerdict {
  let raw: string | null = null
  try {
    raw = readFileSync(ledgerPath(), 'utf8')
  } catch {
    raw = null
  }
  const verdict = evaluatePreviousLedger(raw)

  if (verdict.kind === 'abnormal' || verdict.kind === 'corrupt') {
    // Local retention first (never cleared by telemetry upload): this line is
    // the only durable evidence a SIGKILL / power-loss death leaves behind.
    try {
      const entry = {
        detectedAt: new Date().toISOString(),
        kind: verdict.kind,
        previous: verdict.kind === 'abnormal' ? verdict.previous : null,
        rawPrefix: verdict.kind === 'corrupt' ? verdict.rawPrefix : null
      }
      appendFileSync(join(app.getPath('userData'), ABNORMAL_LOG_FILE), JSON.stringify(entry) + '\n')
    } catch (error) {
      console.warn('[SessionLedger] abnormal-exit retention failed:', error)
    }
    const previous = verdict.kind === 'abnormal' ? verdict.previous : null
    performanceTrace.record(PERF_TRACE_EVENT.MAIN_SESSION_LEDGER_ABNORMAL_EXIT, {
      kind: verdict.kind,
      lastPid: previous?.pid ?? -1,
      lastAppVersion: previous?.appVersion ?? 'unknown',
      lastSeenAt: previous?.lastSeenAt ?? 'unknown',
      uptimeMs: previous ? ledgerUptimeMs(previous) : -1,
      terminatedActiveJobs: previous?.terminatedActiveJobs ?? 0
    })
    console.warn(
      `[SessionLedger] previous session ended abnormally (${verdict.kind});` +
        (previous ? ` pid=${previous.pid} lastSeenAt=${previous.lastSeenAt}` : ' ledger unreadable')
    )
  }

  currentRecord = createLedgerRecord({
    pid: process.pid,
    appVersion: app.getVersion(),
    nowIso: new Date().toISOString()
  })
  writeLedger(currentRecord)

  heartbeatTimer = setInterval(() => {
    if (!currentRecord || cleanMarked) return
    currentRecord = { ...currentRecord, lastSeenAt: new Date().toISOString() }
    writeLedger(currentRecord)
  }, HEARTBEAT_MS)
  heartbeatTimer.unref()

  return verdict
}

/**
 * Mark this session's ledger clean. Idempotent — the first caller wins, so
 * overlapping quit paths (menu quit + will-quit) record one reason.
 */
export function markSessionLedgerClean(quitReason: string, terminatedActiveJobs?: number): void {
  if (!currentRecord || cleanMarked) return
  cleanMarked = true
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer)
    heartbeatTimer = null
  }
  currentRecord = markLedgerClean(currentRecord, {
    nowIso: new Date().toISOString(),
    quitReason,
    terminatedActiveJobs
  })
  writeLedger(currentRecord)
  performanceTrace.record(PERF_TRACE_EVENT.MAIN_SESSION_LEDGER_MARKED_CLEAN, {
    quitReason,
    terminatedActiveJobs: terminatedActiveJobs ?? 0
  })
}
