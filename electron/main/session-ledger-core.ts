/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 *
 * Pure session-ledger state machine (clean-shutdown marker, the standard
 * Chromium/VS Code technique): every launch writes a ledger with
 * clean=false; every graceful-quit path marks clean=true as its last step.
 * A ledger found at startup with clean!==true is proof of an abnormal end
 * (SIGKILL, power loss, force-quit after a freeze) — the class of death
 * that leaves no crash report and, before this ledger, no evidence at all.
 *
 * Pure module (no electron/fs imports): the verdict table is locked by
 * test/unittest/session-ledger.test.mts in plain Node. Filesystem wiring
 * lives in session-ledger.ts.
 */

export interface SessionLedgerRecord {
  schema: 'onward.session-ledger.v1'
  pid: number
  appVersion: string
  startedAt: string
  /** Refreshed periodically while running; bounds the death time on abnormal end. */
  lastSeenAt: string
  clean: boolean
  finishedAt?: string
  /** Which graceful path marked the ledger clean (quit / debug-quit / restart-to-update). */
  quitReason?: string
  /** Count of terminals with active jobs the user chose to terminate at quit. */
  terminatedActiveJobs?: number
}

export type PreviousSessionVerdict =
  | { kind: 'first-run' }
  | { kind: 'clean'; previous: SessionLedgerRecord }
  | { kind: 'abnormal'; previous: SessionLedgerRecord }
  | { kind: 'corrupt'; rawPrefix: string }

/**
 * Judge the ledger left by the previous instance. `raw` is the file content
 * or null when the file does not exist (true first run, or pre-ledger build).
 */
export function evaluatePreviousLedger(raw: string | null): PreviousSessionVerdict {
  if (raw === null) return { kind: 'first-run' }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    // A torn write is itself abnormal-exit evidence (the process died mid-write),
    // but carries no usable fields — classify separately so telemetry can tell
    // "unclean marker" apart from "unreadable marker".
    return { kind: 'corrupt', rawPrefix: raw.slice(0, 128) }
  }
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    (parsed as { schema?: unknown }).schema !== 'onward.session-ledger.v1'
  ) {
    return { kind: 'corrupt', rawPrefix: raw.slice(0, 128) }
  }
  const record = parsed as SessionLedgerRecord
  return record.clean === true ? { kind: 'clean', previous: record } : { kind: 'abnormal', previous: record }
}

export function createLedgerRecord(input: {
  pid: number
  appVersion: string
  nowIso: string
}): SessionLedgerRecord {
  return {
    schema: 'onward.session-ledger.v1',
    pid: input.pid,
    appVersion: input.appVersion,
    startedAt: input.nowIso,
    lastSeenAt: input.nowIso,
    clean: false
  }
}

export function markLedgerClean(
  record: SessionLedgerRecord,
  input: { nowIso: string; quitReason: string; terminatedActiveJobs?: number }
): SessionLedgerRecord {
  return {
    ...record,
    clean: true,
    finishedAt: input.nowIso,
    lastSeenAt: input.nowIso,
    quitReason: input.quitReason,
    ...(input.terminatedActiveJobs !== undefined
      ? { terminatedActiveJobs: input.terminatedActiveJobs }
      : {})
  }
}

/** Milliseconds between the previous instance's last heartbeat and its start. */
export function ledgerUptimeMs(previous: SessionLedgerRecord): number {
  const start = Date.parse(previous.startedAt)
  const last = Date.parse(previous.lastSeenAt)
  if (Number.isNaN(start) || Number.isNaN(last)) return -1
  return Math.max(0, last - start)
}
