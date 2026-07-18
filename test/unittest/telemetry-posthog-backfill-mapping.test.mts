/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 *
 * Unit tests for the pure mapping layer of the PostHog telemetry backfill
 * importer (scripts/telemetry-backfill-posthog.mjs).
 *
 * Usage:
 *   node --experimental-strip-types --test test/unittest/telemetry-posthog-backfill-mapping.test.mts
 *
 * Coverage:
 *   TBF-01  parse valid line        JSONL line → entry object
 *   TBF-02  parse rejects garbage   blank / malformed / tail-partial /
 *                                    missing-name / bad-timestamp → null
 *   TBF-03  map full entry          distinct_id from common.instanceId,
 *                                    original timestamp preserved,
 *                                    common+properties merged,
 *                                    $process_person_profile === false
 *   TBF-04  map precedence          entry.properties wins over common on
 *                                    key collision; anonymous marker cannot
 *                                    be overridden
 *   TBF-05  map missing common      fallback distinct_id, no crash
 *   TBF-06  chunking                exact division, remainder, empty input
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  chunkBatch,
  mapEntryToBatchEvent,
  parseJsonlLine
} from '../../scripts/telemetry-backfill-posthog.mjs'

const VALID_LINE = JSON.stringify({
  timestamp: '2026-06-01T08:30:00.000Z',
  name: 'prompt/use',
  properties: { action: 'send' },
  common: {
    instanceId: '11111111-2222-3333-4444-555555555555',
    sessionId: 'aaaa',
    appVersion: '2.0.1',
    platform: 'darwin'
  }
})

test('TBF-01 parses a valid JSONL line', () => {
  const entry = parseJsonlLine(VALID_LINE)
  assert.ok(entry)
  assert.equal(entry.name, 'prompt/use')
  assert.equal(entry.timestamp, '2026-06-01T08:30:00.000Z')
  assert.deepEqual(entry.properties, { action: 'send' })
})

test('TBF-02 rejects blank, malformed, and incomplete lines', () => {
  assert.equal(parseJsonlLine(''), null)
  assert.equal(parseJsonlLine('   '), null)
  assert.equal(parseJsonlLine('not json at all'), null)
  // Tail-partial line from a session killed mid-append
  assert.equal(parseJsonlLine(VALID_LINE.slice(0, 40)), null)
  // JSON but not an object
  assert.equal(parseJsonlLine('"just a string"'), null)
  assert.equal(parseJsonlLine('null'), null)
  // Missing / empty event name
  assert.equal(parseJsonlLine('{"timestamp":"2026-06-01T00:00:00Z"}'), null)
  assert.equal(parseJsonlLine('{"timestamp":"2026-06-01T00:00:00Z","name":""}'), null)
  // Missing / unparseable timestamp
  assert.equal(parseJsonlLine('{"name":"x"}'), null)
  assert.equal(parseJsonlLine('{"name":"x","timestamp":"not-a-date"}'), null)
})

test('TBF-03 maps a full entry to a PostHog batch event', () => {
  const entry = parseJsonlLine(VALID_LINE)!
  const event = mapEntryToBatchEvent(entry)
  assert.equal(event.event, 'prompt/use')
  assert.equal(event.distinct_id, '11111111-2222-3333-4444-555555555555')
  assert.equal(event.timestamp, '2026-06-01T08:30:00.000Z')
  assert.equal(event.properties.action, 'send')
  assert.equal(event.properties.appVersion, '2.0.1')
  assert.equal(event.properties.platform, 'darwin')
  assert.equal(event.properties.$process_person_profile, false)
})

test('TBF-04 entry.properties wins over common; anonymous marker is fixed', () => {
  const event = mapEntryToBatchEvent({
    timestamp: '2026-06-02T00:00:00.000Z',
    name: 'session/heartbeat',
    properties: { platform: 'overridden', $process_person_profile: true },
    common: { instanceId: 'abc', platform: 'darwin' }
  })
  assert.equal(event.properties.platform, 'overridden')
  // The anonymous marker is applied last and cannot be overridden by data
  assert.equal(event.properties.$process_person_profile, false)
})

test('TBF-05 missing or empty common falls back to a stable distinct_id', () => {
  const noCommon = mapEntryToBatchEvent({
    timestamp: '2026-06-02T00:00:00.000Z',
    name: 'session/start'
  })
  assert.equal(noCommon.distinct_id, 'backfill-unknown-instance')
  const emptyInstance = mapEntryToBatchEvent({
    timestamp: '2026-06-02T00:00:00.000Z',
    name: 'session/start',
    common: { instanceId: '' }
  })
  assert.equal(emptyInstance.distinct_id, 'backfill-unknown-instance')
})

test('TBF-06 chunkBatch splits exactly and handles remainder + empty', () => {
  const items = Array.from({ length: 5 }, (_, i) => i)
  assert.deepEqual(chunkBatch(items, 2), [[0, 1], [2, 3], [4]])
  assert.deepEqual(chunkBatch(items, 5), [[0, 1, 2, 3, 4]])
  assert.deepEqual(chunkBatch(items, 10), [[0, 1, 2, 3, 4]])
  assert.deepEqual(chunkBatch([], 3), [])
})
