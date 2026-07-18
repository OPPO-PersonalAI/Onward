/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 *
 * Unit tests for the metrics-report computation model
 * (scripts/metrics/metrics-model.mjs) against the hand-computable fixture
 * snapshot in test/autotest/fixtures/metrics-report/. These lock the
 * indicator DEFINITIONS — DAU/WAU/MAU, unbounded D1/D7/D30 retention,
 * crash-free rates, adoption, update funnel, North Star — so a definition
 * drift shows up as a red test, not a silently different report.
 *
 * Usage:
 *   node --experimental-strip-types --test test/unittest/metrics-model.test.mts
 *
 * Coverage:
 *   MMD-01  scale        DAU/WAU/MAU/installs + stickiness from activity pairs
 *   MMD-02  retention    D1 2/3, D7 1/1, D30 null-eligible
 *   MMD-03  sessions     7d totals, crash-free sessions rate, weighted p50/p95
 *   MMD-04  adoption     cumulative + rate + last-7d per feature
 *   MMD-05  engagement   from deduplicated daily summaries
 *   MMD-06  stability    crash-free users rate + recovered kinds (7d)
 *   MMD-07  update       30d totals + downloaded→installComplete rate
 *   MMD-08  north star   weekly active agent users, ISO-week bucketing
 *   MMD-09  versions     reference-day version distribution
 *   MMD-10  headline     snapshot-over-snapshot trend row extraction
 *   MMD-11  empty snap   empty/missing queries degrade to zeros, no throw
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  computeMetricsModel,
  computeSnapshotHeadline,
  dateAddDays,
  isoWeekKey
} from '../../scripts/metrics/metrics-model.mjs'

const fixturePath = join(
  dirname(fileURLToPath(import.meta.url)),
  '..', 'autotest', 'fixtures', 'metrics-report', 'snapshot-fixture.json'
)
const snapshot = JSON.parse(readFileSync(fixturePath, 'utf-8'))
const model = computeMetricsModel(snapshot)

test('MMD-01 scale: DAU/WAU/MAU + stickiness', () => {
  assert.equal(model.asOf, '2026-07-16')
  assert.equal(model.scale.dau, 2) // A, B on 07-16
  assert.equal(model.scale.wau, 3) // A, B, C in 07-10..16
  assert.equal(model.scale.mau, 3)
  assert.equal(model.scale.totalInstalls, 3)
  assert.ok(Math.abs(model.scale.dauMau - 2 / 3) < 1e-9)
  assert.equal(model.scale.wauMau, 1)
})

test('MMD-02 retention: unbounded D1/D7/D30', () => {
  // D1: A(07-02 ✓), B(07-11 ✓), C(07-16 ✗) → 2/3
  assert.equal(model.retention.d1.eligible, 3)
  assert.equal(model.retention.d1.retained, 2)
  // D7: only A eligible (07-08 ✓) → 1/1
  assert.equal(model.retention.d7.eligible, 1)
  assert.equal(model.retention.d7.retained, 1)
  assert.equal(model.retention.d7.rate, 1)
  // D30: nobody eligible yet
  assert.equal(model.retention.d30.eligible, 0)
  assert.equal(model.retention.d30.rate, null)
})

test('MMD-03 sessions: 7d totals + crash-free rate + weighted percentiles', () => {
  assert.equal(model.sessions.total7d, 6)
  assert.equal(model.sessions.starts7d, 6)
  assert.ok(Math.abs(model.sessions.crashFreeRate7d - 5 / 6) < 1e-9)
  assert.equal(model.sessions.p50Ms7d, 500000) // (600000*4 + 300000*2) / 6
  assert.equal(model.sessions.p95Ms7d, 1500000)
})

test('MMD-04 adoption rows', () => {
  const byFeature = Object.fromEntries(model.adoption.map((a) => [a.feature, a]))
  assert.equal(byFeature['code-agent'].cumulative, 2)
  assert.ok(Math.abs(byFeature['code-agent'].rate - 2 / 3) < 1e-9)
  assert.equal(byFeature['code-agent'].last7d, 2)
  assert.equal(byFeature['prompt-send'].cumulative, 1)
  assert.equal(byFeature['prompt-send'].last7d, 0) // adopted on 07-01, outside 7d
  assert.equal(byFeature['git-diff'].last7d, 1)
})

test('MMD-05 engagement from deduplicated daily summaries', () => {
  assert.equal(model.engagement.installDays7d, 3)
  assert.equal(model.engagement.avgActiveMsPerInstallDay, 2000000)
  assert.equal(model.engagement.prompts7d, 17)
  assert.equal(model.engagement.agentLaunches7d, 4)
})

test('MMD-06 stability: crash-free users + recovered kinds', () => {
  assert.equal(model.stability.crashedUsers7d, 1) // B crashed on 07-16
  assert.ok(Math.abs(model.stability.crashFreeUsersRate7d - 2 / 3) < 1e-9)
  assert.deepEqual(model.stability.recovered7d, { 'webgl-fallback': 3 }) // 07-01 outside 7d
})

test('MMD-07 update health: 30d totals + install rate', () => {
  assert.equal(model.updateHealth.totals30d['update/check'], 15)
  assert.equal(model.updateHealth.totals30d['update/downloaded'], 2)
  assert.equal(model.updateHealth.totals30d['update/installComplete'], 1)
  assert.equal(model.updateHealth.installRate30d, 0.5)
})

test('MMD-08 north star: weekly active agent users', () => {
  // 2026-07-13 is a Monday: 07-15/07-16 share one ISO week, 07-08 the prior
  assert.equal(isoWeekKey('2026-07-15'), isoWeekKey('2026-07-16'))
  assert.notEqual(isoWeekKey('2026-07-08'), isoWeekKey('2026-07-15'))
  assert.equal(model.northStar.currentWeek.count, 2) // A + C this week
  assert.equal(model.northStar.series.length, 2)
  assert.equal(model.northStar.series[0].count, 1) // A in the prior week
})

test('MMD-09 versions on the reference day', () => {
  assert.equal(model.versions.day, '2026-07-16')
  assert.deepEqual(model.versions.rows, [
    { version: '2.1.0', users: 2 },
    { version: '2.0.9', users: 1 }
  ])
})

test('MMD-10 snapshot headline extraction', () => {
  const headline = computeSnapshotHeadline(snapshot)
  assert.equal(headline.asOf, '2026-07-16')
  assert.equal(headline.dau, 2)
  assert.equal(headline.wau, 3)
  assert.equal(headline.northStar, 2)
  assert.ok(Math.abs(headline.crashFreeSessions7d - 5 / 6) < 1e-9)
})

test('MMD-11 empty snapshot degrades gracefully', () => {
  const empty = computeMetricsModel({ pulledAt: '2026-07-17T00:00:00.000Z', queries: {} })
  assert.equal(empty.scale.dau, 0)
  assert.equal(empty.scale.mau, 0)
  assert.equal(empty.retention.d1.rate, null)
  assert.equal(empty.sessions.crashFreeRate7d, null)
  assert.deepEqual(empty.adoption, [])
  assert.equal(empty.northStar.currentWeek, null)
})

test('MMD-13 feature usage: generic fu_* extraction with per-install-day max dedup (P2)', () => {
  const byFeature = Object.fromEntries(model.featureUsage.rows.map((r) => [r.feature, r]))
  // A has two summaries on 07-16 (quit partial + final): MAX per key wins → 5, not 7
  assert.equal(byFeature['git-diff-stage'].total, 5)
  assert.equal(byFeature['git-diff-stage'].installs, 1)
  // outline: A max(1) + B max(4) = 5 across 2 installs
  assert.equal(byFeature['outline'].total, 5)
  assert.equal(byFeature['outline'].installs, 2)
  // sqlite-viewer used by C on 07-15 (inside 7d window)
  assert.equal(byFeature['sqlite-viewer'].total, 1)
  // Malformed properties JSON row is skipped, not fatal
  // Breadth: A→2 features, B→1, C→1 → avg 4/3
  assert.ok(Math.abs(model.featureUsage.breadthAvg - 4 / 3) < 1e-9)
})

test('MMD-14 windowDays override drives the short-window metrics', () => {
  // A 1-day window sees only 07-16: sessions 4, crash-free 3/4
  const narrow = computeMetricsModel(snapshot, { windowDays: 1 })
  assert.equal(narrow.windowDays, 1)
  assert.equal(narrow.sessions.total7d, 4)
  assert.ok(Math.abs(narrow.sessions.crashFreeRate7d - 3 / 4) < 1e-9)
  // 07-15's sqlite-viewer usage falls outside the 1-day window
  const narrowFeatures = new Set(narrow.featureUsage.rows.map((r) => r.feature))
  assert.ok(!narrowFeatures.has('sqlite-viewer'))
})

test('MMD-12 date helpers', () => {
  assert.equal(dateAddDays('2026-07-31', 1), '2026-08-01')
  assert.equal(dateAddDays('2026-01-01', -1), '2025-12-31')
})
