/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 *
 * Usage: node --experimental-strip-types --test test/unittest/session-ledger.test.mts
 *
 * Locks the pure clean-shutdown-marker state machine
 * (electron/main/session-ledger-core.ts): first-run / clean / abnormal /
 * corrupt verdicts, the mark-clean transition, and uptime derivation. The
 * abnormal verdict is the load-bearing case — it is the only evidence a
 * SIGKILL / power-loss / freeze-force-quit death leaves behind.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  createLedgerRecord,
  evaluatePreviousLedger,
  ledgerUptimeMs,
  markLedgerClean
} from '../../electron/main/session-ledger-core.ts'

const fresh = () =>
  createLedgerRecord({ pid: 4242, appVersion: '2.0.1', nowIso: '2026-07-25T10:00:00.000Z' })

test('SLC-U-01: missing file is a first run, never abnormal', () => {
  assert.deepEqual(evaluatePreviousLedger(null), { kind: 'first-run' })
})

test('SLC-U-02: freshly created ledger judged later is abnormal (clean=false)', () => {
  const v = evaluatePreviousLedger(JSON.stringify(fresh()))
  assert.equal(v.kind, 'abnormal')
  if (v.kind === 'abnormal') assert.equal(v.previous.pid, 4242)
})

test('SLC-U-03: mark-clean transition yields a clean verdict with reason preserved', () => {
  const done = markLedgerClean(fresh(), {
    nowIso: '2026-07-25T11:30:00.000Z',
    quitReason: 'quit',
    terminatedActiveJobs: 2
  })
  const v = evaluatePreviousLedger(JSON.stringify(done))
  assert.equal(v.kind, 'clean')
  if (v.kind === 'clean') {
    assert.equal(v.previous.quitReason, 'quit')
    assert.equal(v.previous.terminatedActiveJobs, 2)
    assert.equal(v.previous.finishedAt, '2026-07-25T11:30:00.000Z')
  }
})

test('SLC-U-04: torn write (invalid JSON) is corrupt, with a bounded raw prefix', () => {
  const v = evaluatePreviousLedger('{"schema":"onward.session-le')
  assert.equal(v.kind, 'corrupt')
  if (v.kind === 'corrupt') assert.ok(v.rawPrefix.length <= 128)
})

test('SLC-U-05: wrong schema or non-object payload is corrupt, not clean', () => {
  assert.equal(evaluatePreviousLedger('{"schema":"other.v9","clean":true}').kind, 'corrupt')
  assert.equal(evaluatePreviousLedger('"just a string"').kind, 'corrupt')
  assert.equal(evaluatePreviousLedger('42').kind, 'corrupt')
})

test('SLC-U-06: clean must be exactly true — truthy junk stays abnormal', () => {
  const junk = { ...fresh(), clean: 1 as unknown as boolean }
  assert.equal(evaluatePreviousLedger(JSON.stringify(junk)).kind, 'abnormal')
})

test('SLC-U-07: uptime derives from start->lastSeen and clamps bad input', () => {
  const rec = { ...fresh(), lastSeenAt: '2026-07-25T10:05:00.000Z' }
  assert.equal(ledgerUptimeMs(rec), 5 * 60 * 1000)
  assert.equal(ledgerUptimeMs({ ...rec, startedAt: 'garbage' }), -1)
  assert.equal(ledgerUptimeMs({ ...rec, lastSeenAt: '2026-07-25T09:00:00.000Z' }), 0)
})
