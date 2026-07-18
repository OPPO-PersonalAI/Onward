/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 *
 * Unit tests for the product-telemetry event registry
 * (electron/main/telemetry/telemetry-event-names.ts): allowlist clamping,
 * first-use derivation, duration rounding, tier classification.
 *
 * Usage:
 *   node --experimental-strip-types --test test/unittest/telemetry-event-names.test.mts
 *
 * Coverage:
 *   TEN-01  enum clamping         valid values pass; invalid become 'invalid';
 *                                  non-enum props untouched; unlisted events pass
 *   TEN-02  first-use derivation  prompt/use + dropdown actions map to the P1
 *                                  feature IDs; other events map to null
 *   TEN-03  duration rounding     10s buckets; non-finite/negative → 0
 *   TEN-04  tier-2 classification session/first-use/crash/update/consent are
 *                                  live; heartbeat/prompt/dropdown are not
 *   TEN-05  dedup map             error/recovered by kind, update/error by phase
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  clampEnumProperties,
  deriveFirstUseFeature,
  featureUseSummaryKey,
  roundDurationMs,
  TELEMETRY_EVENT,
  TELEMETRY_FEATURE_USE_IDS,
  TELEMETRY_INVALID_ENUM_VALUE,
  TELEMETRY_LIVE_DAILY_DEDUP,
  TELEMETRY_TIER2_LIVE_EVENTS
} from '../../electron/main/telemetry/telemetry-event-names.ts'

test('TEN-01 clampEnumProperties enforces allowlists', () => {
  assert.deepEqual(
    clampEnumProperties('prompt/use', { action: 'send' }),
    { action: 'send' }
  )
  assert.deepEqual(
    clampEnumProperties('prompt/use', { action: 'rm -rf /' }),
    { action: TELEMETRY_INVALID_ENUM_VALUE }
  )
  // Non-enum props pass through even on allowlisted events
  assert.deepEqual(
    clampEnumProperties('error/recovered', { kind: 'webgl-fallback', extra: 'kept' }),
    { kind: 'webgl-fallback', extra: 'kept' }
  )
  assert.deepEqual(
    clampEnumProperties('error/recovered', { kind: 'made-up-kind' }),
    { kind: TELEMETRY_INVALID_ENUM_VALUE }
  )
  // Events without an allowlist pass through untouched
  assert.deepEqual(
    clampEnumProperties('session/heartbeat', { tabCount: '3' }),
    { tabCount: '3' }
  )
})

test('TEN-02 deriveFirstUseFeature maps P1 events to feature IDs', () => {
  assert.equal(deriveFirstUseFeature('prompt/use', { action: 'send' }), 'prompt-send')
  assert.equal(deriveFirstUseFeature('dropdown/tools', { action: 'codeAgent' }), 'code-agent')
  assert.equal(deriveFirstUseFeature('dropdown/tools', { action: 'browser' }), 'browser')
  assert.equal(deriveFirstUseFeature('dropdown/development', { action: 'gitDiff' }), 'git-diff')
  assert.equal(deriveFirstUseFeature('dropdown/development', { action: 'gitHistory' }), 'git-history')
  assert.equal(deriveFirstUseFeature('dropdown/development', { action: 'editor' }), 'project-editor')
  assert.equal(deriveFirstUseFeature('dropdown/workspace', { action: 'openDir' }), null)
  assert.equal(deriveFirstUseFeature('session/heartbeat'), null)
  assert.equal(deriveFirstUseFeature('feature/first-use', { feature: 'prompt-send' }), null)
})

test('TEN-03 roundDurationMs rounds to 10-second buckets', () => {
  assert.equal(roundDurationMs(0), 0)
  assert.equal(roundDurationMs(4999), 0)
  assert.equal(roundDurationMs(5000), 10_000)
  assert.equal(roundDurationMs(123_456), 120_000)
  assert.equal(roundDurationMs(-5), 0)
  assert.equal(roundDurationMs(Number.NaN), 0)
  assert.equal(roundDurationMs(Number.POSITIVE_INFINITY), 0)
})

test('TEN-04 tier-2 live classification', () => {
  for (const name of [
    TELEMETRY_EVENT.SESSION_START,
    TELEMETRY_EVENT.SESSION_END,
    TELEMETRY_EVENT.FEATURE_FIRST_USE,
    TELEMETRY_EVENT.ERROR_RENDERER_CRASH,
    TELEMETRY_EVENT.ERROR_RECOVERED,
    TELEMETRY_EVENT.UPDATE_ERROR,
    TELEMETRY_EVENT.CONSENT_GRANTED
  ]) {
    assert.ok(TELEMETRY_TIER2_LIVE_EVENTS.has(name), `${name} should be live`)
  }
  for (const name of [
    TELEMETRY_EVENT.SESSION_HEARTBEAT,
    TELEMETRY_EVENT.PROMPT_USE,
    TELEMETRY_EVENT.DROPDOWN_TOOLS,
    TELEMETRY_EVENT.DAILY_SUMMARY
  ]) {
    assert.ok(!TELEMETRY_TIER2_LIVE_EVENTS.has(name), `${name} should be aggregate-only`)
  }
})

test('TEN-05 live-lane daily dedup map', () => {
  assert.equal(TELEMETRY_LIVE_DAILY_DEDUP[TELEMETRY_EVENT.ERROR_RECOVERED], 'kind')
  assert.equal(TELEMETRY_LIVE_DAILY_DEDUP[TELEMETRY_EVENT.UPDATE_ERROR], 'phase')
})

test('TEN-06 feature/use allowlist + summary key derivation (P2)', () => {
  // Registered IDs pass; unregistered clamp to 'invalid'
  assert.deepEqual(
    clampEnumProperties('feature/use', { feature: 'git-diff-stage' }),
    { feature: 'git-diff-stage' }
  )
  assert.deepEqual(
    clampEnumProperties('feature/use', { feature: 'not-a-feature' }),
    { feature: TELEMETRY_INVALID_ENUM_VALUE }
  )
  // feature/use is Tier-1 aggregate-only, never live
  assert.ok(!TELEMETRY_TIER2_LIVE_EVENTS.has('feature/use'))
  // Summary key flattening: fu_ prefix, dashes to underscores
  assert.equal(featureUseSummaryKey('git-diff-stage'), 'fu_git_diff_stage')
  assert.equal(featureUseSummaryKey('outline'), 'fu_outline')
  // Every registered ID produces a unique summary key
  const keys = TELEMETRY_FEATURE_USE_IDS.map((id) => featureUseSummaryKey(id))
  assert.equal(new Set(keys).size, TELEMETRY_FEATURE_USE_IDS.length)
})

test('TEN-07 feature/use derives first-use for adoption-mapped IDs (P2)', () => {
  // Identity-mapped
  assert.equal(deriveFirstUseFeature('feature/use', { feature: 'outline' }), 'outline')
  assert.equal(deriveFirstUseFeature('feature/use', { feature: 'sqlite-viewer' }), 'sqlite-viewer')
  // Renamed mapping: finer use ID → coarser adoption ID
  assert.equal(deriveFirstUseFeature('feature/use', { feature: 'schedule-create' }), 'schedule')
  // Actions without adoption signal derive nothing
  assert.equal(deriveFirstUseFeature('feature/use', { feature: 'tab-close' }), null)
  assert.equal(deriveFirstUseFeature('feature/use', { feature: 'shortcut-fired' }), null)
  assert.equal(deriveFirstUseFeature('feature/use', {}), null)
})
