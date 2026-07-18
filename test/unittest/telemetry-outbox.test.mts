/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 *
 * Unit tests for the telemetry outbox pure logic
 * (electron/main/telemetry/telemetry-outbox.ts) — the
 * "record on disk = not yet confirmed uploaded" decision layer.
 *
 * Usage:
 *   node --experimental-strip-types --test test/unittest/telemetry-outbox.test.mts
 *
 * Coverage:
 *   TOB-01  line parsing            valid line → entry; malformed / partial /
 *                                    missing fields → null
 *   TOB-02  entry date              UTC calendar date, aggregator convention
 *   TOB-03  backlog selection       lines dated before the aggregator day are
 *                                    selected in file order; the current day is
 *                                    NOT; malformed lines enter the removal set
 *                                    without being uploaded
 *   TOB-04  removeLines             removes exactly the acknowledged set,
 *                                    keeps everything else, null on no-op
 *   TOB-05  removeDayLines          removes only the acknowledged day, keeps
 *                                    malformed lines, null on no-op
 *   TOB-06  trim to budget          within budget → null; over budget drops
 *                                    OLDEST lines down to the trim target
 *   TOB-07  deterministic uuid      stable across calls, distinct across
 *                                    entries, valid UUID shape
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  deterministicEventUuid,
  outboxEntryDate,
  parseOutboxLine,
  removeDayLines,
  removeLines,
  selectOutboxUpload,
  selectRemediationBacklog,
  trimContentToBudget
} from '../../electron/main/telemetry/telemetry-outbox.ts'

function line(timestamp: string, name: string, extra?: Record<string, unknown>): string {
  return JSON.stringify({
    timestamp,
    name,
    properties: { action: 'send' },
    common: { instanceId: 'inst-1', sessionId: 'sess-1' },
    ...extra
  })
}

test('TOB-01 parses valid lines and rejects malformed ones', () => {
  const valid = parseOutboxLine(line('2026-07-15T08:00:00.000Z', 'prompt/use'))
  assert.ok(valid)
  assert.equal(valid.name, 'prompt/use')
  assert.equal(parseOutboxLine(''), null)
  assert.equal(parseOutboxLine('{"broken'), null)
  assert.equal(parseOutboxLine('42'), null)
  assert.equal(parseOutboxLine('{"name":"x"}'), null)
  assert.equal(parseOutboxLine('{"name":"","timestamp":"2026-07-15T08:00:00Z"}'), null)
  assert.equal(parseOutboxLine('{"name":"x","timestamp":"garbage"}'), null)
})

test('TOB-02 entry date is the UTC calendar date', () => {
  // 23:30 UTC stays on the same UTC day regardless of local timezone
  const entry = parseOutboxLine(line('2026-07-15T23:30:00.000Z', 'session/start'))!
  assert.equal(outboxEntryDate(entry), '2026-07-15')
})

test('TOB-03 backlog selection: only days before the aggregator day', () => {
  const oldA = line('2026-07-14T10:00:00.000Z', 'session/start')
  const oldB = line('2026-07-15T10:00:00.000Z', 'prompt/use')
  const today = line('2026-07-16T09:00:00.000Z', 'session/heartbeat')
  const partial = oldA.slice(0, 25)
  const raw = [oldA, oldB, today, partial].join('\n') + '\n'

  const backlog = selectRemediationBacklog(raw, '2026-07-16')
  assert.deepEqual(backlog.remediate.map((e) => e.name), ['session/start', 'prompt/use'])
  assert.ok(backlog.removalSet.has(oldA))
  assert.ok(backlog.removalSet.has(oldB))
  assert.ok(backlog.removalSet.has(partial), 'malformed line joins the removal set')
  assert.ok(!backlog.removalSet.has(today), 'current-day line stays owned by the summary pipeline')

  // Nothing older than the day → nothing to remediate
  const none = selectRemediationBacklog(today + '\n', '2026-07-16')
  assert.equal(none.remediate.length, 0)
  assert.equal(none.removalSet.size, 0)
})

test('TOB-04 removeLines removes exactly the acknowledged set', () => {
  const a = line('2026-07-14T10:00:00.000Z', 'a')
  const b = line('2026-07-15T10:00:00.000Z', 'b')
  const c = line('2026-07-16T10:00:00.000Z', 'c')
  const raw = [a, b, c].join('\n') + '\n'

  const result = removeLines(raw, new Set([a, b]))
  assert.ok(result)
  assert.equal(result.removed, 2)
  assert.equal(result.content, c + '\n')

  assert.equal(removeLines(raw, new Set(['not-present'])), null)
  const all = removeLines(raw, new Set([a, b, c]))
  assert.ok(all)
  assert.equal(all.content, '')
})

test('TOB-05 removeDayLines removes only that day, keeps malformed', () => {
  const day14 = line('2026-07-14T10:00:00.000Z', 'a')
  const day15a = line('2026-07-15T08:00:00.000Z', 'b')
  const day15b = line('2026-07-15T22:00:00.000Z', 'c')
  const partial = '{"broken'
  const raw = [day14, day15a, day15b, partial].join('\n') + '\n'

  const result = removeDayLines(raw, '2026-07-15')
  assert.ok(result)
  assert.equal(result.removed, 2)
  assert.equal(result.content, day14 + '\n' + partial + '\n')

  assert.equal(removeDayLines(raw, '2026-07-13'), null)
})

test('TOB-06 trim drops oldest lines down to the target budget', () => {
  const mkLine = (i: number) => line('2026-07-15T08:00:00.000Z', `event/${String(i).padStart(4, '0')}`)
  const lines = Array.from({ length: 100 }, (_, i) => mkLine(i))
  const raw = lines.join('\n') + '\n'
  const totalBytes = Buffer.byteLength(raw, 'utf-8')

  // Within budget → untouched
  assert.equal(trimContentToBudget(raw, totalBytes, totalBytes), null)

  // Over budget → oldest dropped, newest kept, result under target
  const target = Math.floor(totalBytes / 2)
  const trimmed = trimContentToBudget(raw, totalBytes - 1, target)
  assert.ok(trimmed)
  assert.ok(trimmed.droppedLines > 0)
  assert.ok(trimmed.bytes <= target)
  assert.ok(!trimmed.content.includes('event/0000'), 'oldest line dropped')
  assert.ok(trimmed.content.includes('event/0099'), 'newest line kept')
  assert.equal(Buffer.byteLength(trimmed.content, 'utf-8'), trimmed.bytes)
})

test('TOB-08 selectOutboxUpload partitions backlog vs live lanes with dedup', () => {
  const LIVE = new Set(['session/start', 'session/end', 'error/recovered', 'update/error'])
  const DEDUP = { 'error/recovered': 'kind', 'update/error': 'phase' }
  const oldHeartbeat = line('2026-07-15T10:00:00.000Z', 'session/heartbeat')
  const todayStart = line('2026-07-16T08:00:00.000Z', 'session/start')
  const todayHeartbeat = line('2026-07-16T08:05:00.000Z', 'session/heartbeat')
  const recoveredA = JSON.stringify({
    timestamp: '2026-07-16T09:00:00.000Z', name: 'error/recovered',
    properties: { kind: 'webgl-fallback' }, common: { instanceId: 'inst-1' }
  })
  const recoveredDupA = JSON.stringify({
    timestamp: '2026-07-16T10:00:00.000Z', name: 'error/recovered',
    properties: { kind: 'webgl-fallback' }, common: { instanceId: 'inst-1' }
  })
  const recoveredB = JSON.stringify({
    timestamp: '2026-07-16T11:00:00.000Z', name: 'error/recovered',
    properties: { kind: 'unresponsive' }, common: { instanceId: 'inst-1' }
  })
  const raw = [oldHeartbeat, todayStart, todayHeartbeat, recoveredA, recoveredDupA, recoveredB].join('\n') + '\n'

  const sel = selectOutboxUpload(raw, '2026-07-16', LIVE, DEDUP)
  // Backlog lane: only the pre-aggregator-day line
  assert.deepEqual(sel.backlog.map((e) => e.name), ['session/heartbeat'])
  assert.ok(sel.backlogRemoval.has(oldHeartbeat))
  // Live lane: session/start + first webgl-fallback + unresponsive; the
  // duplicate webgl-fallback is NOT uploaded but IS removed on ack
  assert.deepEqual(sel.live.map((e) => e.name), ['session/start', 'error/recovered', 'error/recovered'])
  assert.deepEqual(sel.live.filter((e) => e.name === 'error/recovered').map((e) => e.properties?.kind),
    ['webgl-fallback', 'unresponsive'])
  assert.ok(sel.liveRemoval.has(recoveredDupA))
  assert.equal(sel.liveRemoval.size, 4)
  // Tier-1 current-day heartbeat stays owned by the summary pipeline
  assert.ok(!sel.backlogRemoval.has(todayHeartbeat))
  assert.ok(!sel.liveRemoval.has(todayHeartbeat))
})

test('TOB-07 deterministic uuid: stable, distinct, valid shape', () => {
  const entry = parseOutboxLine(line('2026-07-15T08:00:00.000Z', 'prompt/use'))!
  const uuidA = deterministicEventUuid(entry)
  const uuidB = deterministicEventUuid(parseOutboxLine(line('2026-07-15T08:00:00.000Z', 'prompt/use'))!)
  assert.equal(uuidA, uuidB, 'same content → same uuid (idempotent re-delivery)')

  const other = deterministicEventUuid(parseOutboxLine(line('2026-07-15T08:00:00.001Z', 'prompt/use'))!)
  assert.notEqual(uuidA, other)

  assert.match(uuidA, /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
})
