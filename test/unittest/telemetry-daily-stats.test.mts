/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 *
 * Unit tests for the pure daily-stats layer
 * (electron/main/telemetry/telemetry-daily-stats.ts) — the 2026-07 metric
 * redesign's extended counter set and schema-migration merge.
 *
 * Usage:
 *   node --experimental-strip-types --test test/unittest/telemetry-daily-stats.test.mts
 *
 * Coverage:
 *   TDS-01  empty stats            every counter (incl. new stability/update
 *                                   domains + codeAgent) present and zero
 *   TDS-02  schema merge           January-era persisted stats (no new keys)
 *                                   load with new counters defaulted to 0
 *   TDS-03  summary completeness   buildDailySummary emits every new field;
 *                                   percentiles and averages stay correct
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  buildDailySummary,
  createEmptyStats,
  mergeStatsWithDefaults
} from '../../electron/main/telemetry/telemetry-daily-stats.ts'

const NEW_COUNTER_KEYS = [
  'dropdownToolsCodeAgent',
  'gpuCrashCount',
  'unresponsiveCount',
  'webglFallbackCount',
  'watcherDegradedCount',
  'updateCheckCount',
  'updateDownloadedCount',
  'updateInstallStartCount',
  'updateInstallCompleteCount',
  'updateErrorCount'
] as const

test('TDS-01 createEmptyStats includes all new counters at zero', () => {
  const stats = createEmptyStats('2026-07-18')
  for (const key of NEW_COUNTER_KEYS) {
    assert.equal(stats[key], 0, `${key} should default to 0`)
  }
  assert.equal(stats.date, '2026-07-18')
  assert.equal(stats.rendererCrashCount, 0)
})

test('TDS-02 mergeStatsWithDefaults migrates January-era persisted stats', () => {
  // A persisted file written by the old schema: none of the new keys exist
  const legacy = {
    date: '2026-07-18',
    lastUploadedAt: 0,
    sessionCount: 3,
    sessionDurations: [1000],
    tabCounts: [2],
    terminalCounts: [2],
    layoutModes: [1],
    promptSend: 7,
    promptExecute: 0,
    promptSendAndExecute: 0,
    dropdownWorkspaceOpenDir: 0,
    dropdownWorkspaceChangeDir: 0,
    dropdownDevelopmentEditor: 1,
    dropdownDevelopmentGitDiff: 0,
    dropdownDevelopmentGitHistory: 0,
    dropdownToolsClaudeCode: 2,
    dropdownToolsCodex: 0,
    dropdownToolsBrowser: 1,
    rendererCrashCount: 0
  }
  const merged = mergeStatsWithDefaults(legacy, '2026-07-18')
  // Old values preserved
  assert.equal(merged.sessionCount, 3)
  assert.equal(merged.promptSend, 7)
  assert.equal(merged.dropdownToolsClaudeCode, 2)
  // New counters default to 0 (not undefined → no NaN after ++)
  for (const key of NEW_COUNTER_KEYS) {
    assert.equal(merged[key], 0, `${key} should be defaulted`)
  }
})

test('TDS-04 featureUse map: defaults, corrupt-merge guard, summary flatten (P2)', () => {
  const stats = createEmptyStats('2026-07-18')
  assert.deepEqual(stats.featureUse, {})
  // Counting via the map
  stats.featureUse['git-diff-stage'] = 3
  stats.featureUse['outline'] = 1
  const summary = buildDailySummary(stats)
  assert.equal(summary.fu_git_diff_stage, 3)
  assert.equal(summary.fu_outline, 1)
  // January-era persisted stats (no featureUse key) merge to {}
  const legacyMerged = mergeStatsWithDefaults({ date: '2026-07-18', sessionCount: 1 }, '2026-07-18')
  assert.deepEqual(legacyMerged.featureUse, {})
  // Corrupt persisted featureUse is reset, not propagated
  const corrupt = mergeStatsWithDefaults(
    { date: '2026-07-18', sessionCount: 1, featureUse: [1, 2] as unknown as Record<string, number> },
    '2026-07-18'
  )
  assert.deepEqual(corrupt.featureUse, {})
})

test('TDS-03 buildDailySummary emits the extended field set', () => {
  const stats = createEmptyStats('2026-07-18')
  stats.sessionCount = 2
  stats.sessionDurations = [10_000, 30_000]
  stats.dropdownToolsCodeAgent = 4
  stats.gpuCrashCount = 1
  stats.unresponsiveCount = 2
  stats.webglFallbackCount = 3
  stats.watcherDegradedCount = 4
  stats.updateCheckCount = 5
  stats.updateErrorCount = 1

  const summary = buildDailySummary(stats)
  assert.equal(summary.date, '2026-07-18')
  assert.equal(summary.sessionCount, 2)
  assert.equal(summary.totalActiveMs, 40_000)
  assert.equal(summary.sessionDurationAvg, 20_000)
  assert.equal(summary.sessionDurationP50, 10_000)
  assert.equal(summary.sessionDurationP95, 30_000)
  assert.equal(summary.dropdownToolsCodeAgent, 4)
  assert.equal(summary.gpuCrashCount, 1)
  assert.equal(summary.unresponsiveCount, 2)
  assert.equal(summary.webglFallbackCount, 3)
  assert.equal(summary.watcherDegradedCount, 4)
  assert.equal(summary.updateCheckCount, 5)
  assert.equal(summary.updateDownloadedCount, 0)
  assert.equal(summary.updateInstallStartCount, 0)
  assert.equal(summary.updateInstallCompleteCount, 0)
  assert.equal(summary.updateErrorCount, 1)
})
