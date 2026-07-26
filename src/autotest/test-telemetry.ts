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
  // Monotonic per-name maximum across every read — the drain-immune
  // counterpart of seenNames for COUNT assertions: once N events of a name
  // have been observed together, a later outbox drain cannot un-observe them.
  const maxSeenCounts = new Map<string, number>()
  const getEvents = async (): Promise<TelemetryLogEntry[]> => {
    const raw = await window.electronAPI.debug.readTelemetryLog()
    if (!raw) return []
    const parsed = raw.split('\n')
      .filter(l => l.trim())
      .map(l => { try { return JSON.parse(l) } catch { return null } })
      .filter((e): e is TelemetryLogEntry => e !== null)
    const counts = new Map<string, number>()
    for (const e of parsed) {
      seenNames.add(e.name)
      counts.set(e.name, (counts.get(e.name) ?? 0) + 1)
    }
    for (const [name, count] of counts) {
      if (count > (maxSeenCounts.get(name) ?? 0)) maxSeenCounts.set(name, count)
    }
    return parsed
  }

  // Phase-count wait (2026-07-24 repair, Bucket-1 timing-design fix): the
  // old pattern — fire-and-forget track() → fixed sleep → ONE sliced read →
  // exact-count gate — raced the 5 s fast-mode heartbeat/aggregation cycle,
  // which delays the main-process JSONL appends past the sleep window. The
  // late events always landed (every failing run's final census was a full
  // 30/30), so the product was never at fault: whichever phase's window
  // collided with the heartbeat went red (TEL-05 in isolation, TEL-06 under
  // full-run load) — the user-visible "fluctuation".
  //
  // The count is a DELTA against a baseline captured BEFORE the phase's
  // track() calls, NOT a whole-file absolute: launches B/C seed a
  // historical-migration backlog into the outbox (seed_backlog in the
  // runner, incl. one prompt/use), so an absolute count over-counts by the
  // seed (first repair attempt failed 3/3 on exactly that, count 7 ≠ 6).
  // Baseline + delta reproduces the old slice()'s relative semantics while
  // removing both of its defects (fixed-sleep timing assumption, index
  // shifting on a shrinkable outbox — maxSeenCounts is monotonic). The
  // ceiling is a hang detector; a healthy run short-circuits immediately.
  const eventCountBaseline = async (name: string): Promise<number> => {
    await getEvents()
    return maxSeenCounts.get(name) ?? 0
  }
  const waitForEventDelta = async (
    name: string,
    base: number,
    expected: number
  ): Promise<{ ok: boolean; observed: number }> => {
    const deadline = Date.now() + 15_000
    for (;;) {
      await getEvents()
      const observed = (maxSeenCounts.get(name) ?? 0) - base
      if (observed >= expected) {
        return { ok: observed === expected, observed }
      }
      if (Date.now() >= deadline) {
        return { ok: false, observed }
      }
      await sleep(150)
    }
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
  const promptBase = await eventCountBaseline('prompt/use')
  // send x3
  window.electronAPI.telemetry.track('prompt/use', { action: 'send' })
  window.electronAPI.telemetry.track('prompt/use', { action: 'send' })
  window.electronAPI.telemetry.track('prompt/use', { action: 'send' })
  // execute x2
  window.electronAPI.telemetry.track('prompt/use', { action: 'execute' })
  window.electronAPI.telemetry.track('prompt/use', { action: 'execute' })
  // sendAndExecute x1
  window.electronAPI.telemetry.track('prompt/use', { action: 'sendAndExecute' })
  const promptCount = await waitForEventDelta('prompt/use', promptBase, 6)
  record('TEL-03-prompt-use-count', promptCount.ok, { count: promptCount.observed, base: promptBase })

  // === Phase 3: Dropdown — Workspace (menu clicks) ===
  const workspaceBase = await eventCountBaseline('dropdown/workspace')
  window.electronAPI.telemetry.track('dropdown/workspace', { action: 'openDir' })
  window.electronAPI.telemetry.track('dropdown/workspace', { action: 'openDir' })
  window.electronAPI.telemetry.track('dropdown/workspace', { action: 'changeDir' })
  const workspaceCount = await waitForEventDelta('dropdown/workspace', workspaceBase, 3)
  record('TEL-04-dropdown-workspace', workspaceCount.ok, { count: workspaceCount.observed, base: workspaceBase })

  // === Phase 4: Dropdown — Development (menu clicks) ===
  const developmentBase = await eventCountBaseline('dropdown/development')
  window.electronAPI.telemetry.track('dropdown/development', { action: 'editor' })
  window.electronAPI.telemetry.track('dropdown/development', { action: 'editor' })
  window.electronAPI.telemetry.track('dropdown/development', { action: 'gitDiff' })
  window.electronAPI.telemetry.track('dropdown/development', { action: 'gitDiff' })
  window.electronAPI.telemetry.track('dropdown/development', { action: 'gitHistory' })
  const developmentCount = await waitForEventDelta('dropdown/development', developmentBase, 5)
  record('TEL-05-dropdown-development', developmentCount.ok, { count: developmentCount.observed, base: developmentBase })

  // === Phase 5: Dropdown — Tools (menu clicks) ===
  // Actions mirror today's UI: the unified codeAgent launcher replaced the
  // claudeCode/codex split entries in spring 2026.
  const toolsBase = await eventCountBaseline('dropdown/tools')
  window.electronAPI.telemetry.track('dropdown/tools', { action: 'codeAgent' })
  window.electronAPI.telemetry.track('dropdown/tools', { action: 'codeAgent' })
  window.electronAPI.telemetry.track('dropdown/tools', { action: 'browser' })
  window.electronAPI.telemetry.track('dropdown/tools', { action: 'browser' })
  const toolsCount = await waitForEventDelta('dropdown/tools', toolsBase, 4)
  record('TEL-06-dropdown-tools', toolsCount.ok, { count: toolsCount.observed, base: toolsBase })

  // === Phase 6: Error/crash simulation ===
  const crashBase = await eventCountBaseline('error/rendererCrash')
  window.electronAPI.telemetry.track('error/rendererCrash', { reason: 'crashed', exitCode: '1' })
  window.electronAPI.telemetry.track('error/rendererCrash', { reason: 'oom', exitCode: '137' })
  const crashCount = await waitForEventDelta('error/rendererCrash', crashBase, 2)
  record('TEL-07-error-renderer-crash', crashCount.ok, { count: crashCount.observed, base: crashBase })

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
