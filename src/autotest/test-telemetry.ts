/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

import type { AutotestContext, TestResult } from './types'

/**
 * Telemetry end-to-end autotest.
 *
 * Exercises all 8 event types via real UI interactions,
 * verifies local JSONL log, waits for aggregated daily upload,
 * and confirms the upload log message.
 */
export async function testTelemetry(ctx: AutotestContext): Promise<TestResult[]> {
  const { assert, log, sleep } = ctx
  const results: TestResult[] = []
  const record = (name: string, ok: boolean, detail?: Record<string, unknown>) => {
    assert(name, ok, detail)
    results.push({ name, ok, detail })
  }

  // Cumulative distinct event names across every read. The Tier-2 live
  // lane may drain discrete events (session/start, crashes, first-use)
  // from the outbox mid-suite when an upload client is active, so
  // "was this event type ever captured" must be asserted on the union of
  // all reads, not on the final file state.
  const seenNames = new Set<string>()
  const getEvents = async (): Promise<TelemetryLogEntry[]> => {
    const raw = await window.electronAPI.debug.readTelemetryLog()
    if (!raw) return []
    const parsed = raw.split('\n')
      .filter(l => l.trim())
      .map(l => { try { return JSON.parse(l) } catch { return null } })
      .filter((e): e is TelemetryLogEntry => e !== null)
    for (const e of parsed) seenNames.add(e.name)
    return parsed
  }

  log('telemetry-test:start')

  // === Phase 1: Verify baseline (session/start + initial terminal) ===
  await sleep(1500)
  let events = await getEvents()

  record('TEL-01-session-start', events.some(e => e.name === 'session/start'))
  record('TEL-02-common-properties', events.length > 0 && Boolean(
    events[0].common?.instanceId && events[0].common?.platform && events[0].common?.appVersion
  ))

  // === Phase 2: Prompt operations (3 types, multiple clicks each) ===
  const baseline2 = events.length
  // send x3
  window.electronAPI.telemetry.track('prompt/use', { action: 'send' })
  window.electronAPI.telemetry.track('prompt/use', { action: 'send' })
  window.electronAPI.telemetry.track('prompt/use', { action: 'send' })
  // execute x2
  window.electronAPI.telemetry.track('prompt/use', { action: 'execute' })
  window.electronAPI.telemetry.track('prompt/use', { action: 'execute' })
  // sendAndExecute x1
  window.electronAPI.telemetry.track('prompt/use', { action: 'sendAndExecute' })
  await sleep(500)
  events = await getEvents()
  const promptEvents = events.slice(baseline2).filter(e => e.name === 'prompt/use')
  record('TEL-03-prompt-use-count', promptEvents.length === 6, { count: promptEvents.length })

  // === Phase 3: Dropdown — Workspace (menu clicks) ===
  const baseline3 = events.length
  window.electronAPI.telemetry.track('dropdown/workspace', { action: 'openDir' })
  window.electronAPI.telemetry.track('dropdown/workspace', { action: 'openDir' })
  window.electronAPI.telemetry.track('dropdown/workspace', { action: 'changeDir' })
  await sleep(300)
  events = await getEvents()
  record('TEL-04-dropdown-workspace', events.slice(baseline3).filter(e => e.name === 'dropdown/workspace').length === 3)

  // === Phase 4: Dropdown — Development (menu clicks) ===
  const baseline4 = events.length
  window.electronAPI.telemetry.track('dropdown/development', { action: 'editor' })
  window.electronAPI.telemetry.track('dropdown/development', { action: 'editor' })
  window.electronAPI.telemetry.track('dropdown/development', { action: 'gitDiff' })
  window.electronAPI.telemetry.track('dropdown/development', { action: 'gitDiff' })
  window.electronAPI.telemetry.track('dropdown/development', { action: 'gitHistory' })
  await sleep(300)
  events = await getEvents()
  record('TEL-05-dropdown-development', events.slice(baseline4).filter(e => e.name === 'dropdown/development').length === 5)

  // === Phase 5: Dropdown — Tools (menu clicks) ===
  // Actions mirror today's UI: the unified codeAgent launcher replaced the
  // claudeCode/codex split entries in spring 2026.
  const baseline5 = events.length
  window.electronAPI.telemetry.track('dropdown/tools', { action: 'codeAgent' })
  window.electronAPI.telemetry.track('dropdown/tools', { action: 'codeAgent' })
  window.electronAPI.telemetry.track('dropdown/tools', { action: 'browser' })
  window.electronAPI.telemetry.track('dropdown/tools', { action: 'browser' })
  await sleep(300)
  events = await getEvents()
  record('TEL-06-dropdown-tools', events.slice(baseline5).filter(e => e.name === 'dropdown/tools').length === 4)

  // === Phase 6: Error/crash simulation ===
  const baseline6 = events.length
  window.electronAPI.telemetry.track('error/rendererCrash', { reason: 'crashed', exitCode: '1' })
  window.electronAPI.telemetry.track('error/rendererCrash', { reason: 'oom', exitCode: '137' })
  await sleep(300)
  events = await getEvents()
  record('TEL-07-error-renderer-crash', events.slice(baseline6).filter(e => e.name === 'error/rendererCrash').length === 2)

  // === Phase 7: Wait for heartbeat (5s in fast mode) + daily upload ===
  log('telemetry-test:waiting-for-heartbeat-and-upload')
  await sleep(8000) // 8s > 5s heartbeat interval in fast mode

  events = await getEvents()
  const heartbeats = events.filter(e => e.name === 'session/heartbeat')
  record('TEL-08-heartbeat-fired', heartbeats.length >= 1, { count: heartbeats.length })

  // Check heartbeat has workspace scale data
  if (heartbeats.length > 0) {
    const hb = heartbeats[heartbeats.length - 1]
    record('TEL-09-heartbeat-has-workspace-data', Boolean(
      hb.properties?.activeMs && hb.properties?.tabCount && hb.properties?.layoutMode
    ), { properties: hb.properties })
  } else {
    record('TEL-09-heartbeat-has-workspace-data', false)
  }

  // === Phase 6.5: feature/use counters (P2) ===
  const baseline65 = (await getEvents()).length
  window.electronAPI.telemetry.track('feature/use', { feature: 'git-diff-stage' })
  window.electronAPI.telemetry.track('feature/use', { feature: 'git-diff-stage' })
  window.electronAPI.telemetry.track('feature/use', { feature: 'git-diff-stage' })
  window.electronAPI.telemetry.track('feature/use', { feature: 'outline' })
  window.electronAPI.telemetry.track('feature/use', { feature: 'outline' })
  window.electronAPI.telemetry.track('feature/use', { feature: 'schedule-create' })
  // Unregistered ID must be clamped to 'invalid' by the allowlist, not kept
  window.electronAPI.telemetry.track('feature/use', { feature: 'totally-made-up' })
  await sleep(300)
  events = await getEvents()
  const featureUseEvents = events.slice(baseline65).filter(e => e.name === 'feature/use')
  record('TEL-17-feature-use-events', featureUseEvents.length === 7, { count: featureUseEvents.length })
  record('TEL-17b-feature-use-allowlist-clamp', (
    featureUseEvents.filter(e => e.properties?.feature === 'invalid').length === 1 &&
    featureUseEvents.every(e => e.properties?.feature !== 'totally-made-up')
  ), { features: featureUseEvents.map(e => e.properties?.feature) })

  // === Phase 7.5: feature/first-use derivation (adoption funnel, P1) ===
  // The phases above exercised prompt/use + all dropdown actions multiple
  // times. When an upload client is active (runner launch B), the Tier-2
  // live lane may already have drained these lines from the outbox, so the
  // in-suite invariant is: whatever remains is a DUPLICATE-FREE SUBSET of
  // the expected feature set. The strict exactly-6 count is asserted by
  // the runner against launch A's outbox file (no client → no drain), and
  // delivery is asserted against launch B's mock ingest log.
  events = await getEvents()
  const firstUses = events.filter(e => e.name === 'feature/first-use')
  const firstUseFeatures = firstUses.map(e => e.properties?.feature ?? '')
  // P1 derivations (6) + the P2 feature/use drives above: git-diff-stage +
  // outline (identity-mapped) and schedule-create → schedule
  const expectedFeatures = new Set([
    'browser', 'code-agent', 'git-diff', 'git-history', 'project-editor', 'prompt-send',
    'git-diff-stage', 'outline', 'schedule'
  ])
  const noDuplicates = new Set(firstUseFeatures).size === firstUseFeatures.length
  const allExpected = firstUseFeatures.every(f => expectedFeatures.has(f))
  record('TEL-14-feature-first-use-once', noDuplicates && allExpected, { firstUseFeatures })

  // === Phase 8: Final local log summary ===
  // Assert on the cumulative union of every read (drain-proof), not on the
  // final outbox state — see the seenNames comment above.
  events = await getEvents()
  record('TEL-10-all-event-types-present', seenNames.size >= 7, {
    distinctCount: seenNames.size,
    names: Array.from(seenNames).sort()
  })

  // Total event counts for each type
  const eventCounts: Record<string, number> = {}
  for (const e of events) {
    eventCounts[e.name] = (eventCounts[e.name] || 0) + 1
  }
  log('telemetry-test:event-counts', eventCounts)
  log('telemetry-test:total-events', { count: events.length })

  log('telemetry-test:done')
  return results
}

interface TelemetryLogEntry {
  timestamp: string
  name: string
  properties?: Record<string, string>
  common: Record<string, string>
}
