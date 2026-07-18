/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Pure metric computations for the Onward analytics report — the single
 * place where indicator definitions live (metric system: docs/html/
 * telemetry-metrics-system-redesign.html, approved 2026-07-18).
 *
 * Input: a snapshot produced by pull-posthog-snapshot.mjs (raw HogQL
 * result arrays). Output: plain objects the report renderer templates
 * into HTML. No I/O here — unit-tested in plain Node.
 */

// ---------- date helpers (UTC, YYYY-MM-DD strings) ----------

export function dateAddDays(dateStr, n) {
  const d = new Date(`${dateStr}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + n)
  return d.toISOString().slice(0, 10)
}

/** ISO-8601 week key like `2026-W29` (Monday-based). */
export function isoWeekKey(dateStr) {
  const d = new Date(`${dateStr}T00:00:00Z`)
  const day = d.getUTCDay() || 7
  d.setUTCDate(d.getUTCDate() + 4 - day)
  const isoYear = d.getUTCFullYear()
  const yearStart = new Date(Date.UTC(isoYear, 0, 1))
  const week = Math.ceil(((d - yearStart) / 86400000 + 1) / 7)
  return `${isoYear}-W${String(week).padStart(2, '0')}`
}

function lastNDays(asOf, n) {
  const days = []
  for (let i = n - 1; i >= 0; i--) days.push(dateAddDays(asOf, -i))
  return days
}

function rows(snapshot, name) {
  const r = snapshot?.queries?.[name]
  return Array.isArray(r) ? r : []
}

// ---------- core model ----------

/**
 * Compute the full metrics model from one snapshot.
 * - `opts.asOf` overrides the reference day (defaults to the latest
 *   activity day in the snapshot — NOT the pull time, so a morning pull
 *   does not dilute "today" with a half-empty day).
 * - `opts.windowDays` sets the short reporting window (default 7; the
 *   report's `--range` maps to this). Update health stays on 30 days.
 */
export function computeMetricsModel(snapshot, opts = {}) {
  const windowDays = Number(opts.windowDays) > 0 ? Number(opts.windowDays) : 7
  const activityPairs = rows(snapshot, 'activityPairs') // [d, id]
  const firstSeen = rows(snapshot, 'firstSeen') // [id, firstDay]
  const sessionEnds = rows(snapshot, 'sessionEnds') // [d, count, crashFree, p50, p95]
  const sessionStarts = rows(snapshot, 'sessionStarts') // [d, count]
  const firstUse = rows(snapshot, 'firstUse') // [d, feature, count]
  const dailySummaries = rows(snapshot, 'dailySummaries') // [d, id, sessions, activeMs, prompts, agents, browser, crashes]
  const updateEvents = rows(snapshot, 'updateEvents') // [d, event, count]
  const crashPairs = rows(snapshot, 'crashPairs') // [d, id, count]
  const recovered = rows(snapshot, 'recovered') // [d, kind, count]
  const agentPairs = rows(snapshot, 'agentPairs') // [d, id]
  const versionsByDay = rows(snapshot, 'versionsByDay') // [d, version, uniq]
  const platforms = rows(snapshot, 'platforms') // [platform, uniq]

  const dailySummariesRaw = rows(snapshot, 'dailySummariesRaw') // [d, id, propsJson]

  const activesByDay = new Map()
  for (const [d, id] of activityPairs) {
    if (!activesByDay.has(d)) activesByDay.set(d, new Set())
    activesByDay.get(d).add(id)
  }
  const allDays = [...activesByDay.keys()].sort()
  const asOf = opts.asOf || allDays[allDays.length - 1] || (snapshot?.pulledAt || '').slice(0, 10)

  const uniquesInWindow = (days) => {
    const s = new Set()
    for (const d of days) for (const id of activesByDay.get(d) ?? []) s.add(id)
    return s.size
  }

  // 1. Scale
  const dau = activesByDay.get(asOf)?.size ?? 0
  const wau = uniquesInWindow(lastNDays(asOf, 7))
  const mau = uniquesInWindow(lastNDays(asOf, 30))
  const totalInstalls = firstSeen.length

  // 2. Stickiness + retention (unbounded day-N, aggregated across cohorts)
  const activeDaysById = new Map()
  for (const [d, id] of activityPairs) {
    if (!activeDaysById.has(id)) activeDaysById.set(id, new Set())
    activeDaysById.get(id).add(d)
  }
  const retentionAt = (n) => {
    let eligible = 0
    let retained = 0
    for (const [id, firstDay] of firstSeen) {
      if (dateAddDays(firstDay, n) > asOf) continue
      eligible++
      if (activeDaysById.get(id)?.has(dateAddDays(firstDay, n))) retained++
    }
    return { eligible, retained, rate: eligible > 0 ? retained / eligible : null }
  }

  // 3. Sessions & duration (short window, default 7 days)
  const win7 = new Set(lastNDays(asOf, windowDays))
  let sessions7 = 0
  let crashFree7 = 0
  let p50Weighted = 0
  let p95Weighted = 0
  for (const [d, count, crashFreeCount, p50, p95] of sessionEnds) {
    if (!win7.has(d)) continue
    sessions7 += Number(count) || 0
    crashFree7 += Number(crashFreeCount) || 0
    p50Weighted += (Number(p50) || 0) * (Number(count) || 0)
    p95Weighted += (Number(p95) || 0) * (Number(count) || 0)
  }
  let sessionStarts7 = 0
  for (const [d, count] of sessionStarts) if (win7.has(d)) sessionStarts7 += Number(count) || 0

  // 4. Adoption (cumulative first-use per feature + last-7d newly adopted)
  const adoption = new Map()
  for (const [d, feature, count] of firstUse) {
    if (!adoption.has(feature)) adoption.set(feature, { cumulative: 0, last7d: 0 })
    const a = adoption.get(feature)
    a.cumulative += Number(count) || 0
    if (win7.has(d)) a.last7d += Number(count) || 0
  }
  const adoptionRows = [...adoption.entries()]
    .map(([feature, a]) => ({
      feature,
      cumulative: a.cumulative,
      last7d: a.last7d,
      rate: totalInstalls > 0 ? a.cumulative / totalInstalls : null
    }))
    .sort((a, b) => b.cumulative - a.cumulative)

  // 5. Engagement (from deduplicated daily summaries, 7-day window)
  let activeMs7 = 0
  let prompts7 = 0
  let agentLaunches7 = 0
  let summaryInstallDays7 = 0
  for (const [d, , , activeMs, prompts, agents] of dailySummaries) {
    if (!win7.has(d)) continue
    summaryInstallDays7++
    activeMs7 += Number(activeMs) || 0
    prompts7 += Number(prompts) || 0
    agentLaunches7 += Number(agents) || 0
  }

  // 6. Stability
  const crashedUsers7 = new Set()
  for (const [d, id] of crashPairs.map((r) => [r[0], r[1]])) {
    if (win7.has(d)) crashedUsers7.add(id)
  }
  const recovered7 = new Map()
  for (const [d, kind, count] of recovered) {
    if (win7.has(d)) recovered7.set(kind, (recovered7.get(kind) ?? 0) + (Number(count) || 0))
  }

  // 7. Update health (30-day window)
  const win30 = new Set(lastNDays(asOf, 30))
  const updateTotals = {}
  for (const [d, event, count] of updateEvents) {
    if (!win30.has(d)) continue
    updateTotals[event] = (updateTotals[event] ?? 0) + (Number(count) || 0)
  }

  // 5b. Feature usage (P2 fu_* counters, generic extraction, short window).
  // Dedup rule: multiple summaries per (day, install) — quit-time partials
  // plus the rollover summary — carry cumulative counters, so take the MAX
  // per fu_* key per (day, install) before summing.
  const perInstallDay = new Map() // `${d}|${id}` → Map(fuKey → max count)
  for (const [d, id, propsJson] of dailySummariesRaw) {
    if (!win7.has(d)) continue
    let props
    try {
      props = typeof propsJson === 'string' ? JSON.parse(propsJson) : propsJson
    } catch {
      continue
    }
    if (typeof props !== 'object' || props === null) continue
    const key = `${d}|${id}`
    if (!perInstallDay.has(key)) perInstallDay.set(key, new Map())
    const bucket = perInstallDay.get(key)
    for (const [k, v] of Object.entries(props)) {
      if (!k.startsWith('fu_')) continue
      const n = Number(v) || 0
      if (n > (bucket.get(k) ?? 0)) bucket.set(k, n)
    }
  }
  const featureTotals = new Map() // fuKey → { total, installs: Set }
  const featuresPerInstall = new Map() // install → Set(fuKey)
  for (const [key, bucket] of perInstallDay) {
    const id = key.slice(key.indexOf('|') + 1)
    for (const [fuKey, n] of bucket) {
      if (n <= 0) continue
      if (!featureTotals.has(fuKey)) featureTotals.set(fuKey, { total: 0, installs: new Set() })
      const t = featureTotals.get(fuKey)
      t.total += n
      t.installs.add(id)
      if (!featuresPerInstall.has(id)) featuresPerInstall.set(id, new Set())
      featuresPerInstall.get(id).add(fuKey)
    }
  }
  const featureUsageRows = [...featureTotals.entries()]
    .map(([fuKey, t]) => ({
      feature: fuKey.slice(3).replace(/_/g, '-'),
      total: t.total,
      installs: t.installs.size
    }))
    .sort((a, b) => b.total - a.total)
  const breadthValues = [...featuresPerInstall.values()].map((s) => s.size)
  const featureBreadthAvg =
    breadthValues.length > 0
      ? breadthValues.reduce((s, v) => s + v, 0) / breadthValues.length
      : null

  // North Star: weekly active agent users (installs with any agent activity)
  const agentByWeek = new Map()
  for (const [d, id] of agentPairs) {
    const week = isoWeekKey(d)
    if (!agentByWeek.has(week)) agentByWeek.set(week, new Set())
    agentByWeek.get(week).add(id)
  }
  const northStarSeries = [...agentByWeek.entries()]
    .map(([week, ids]) => ({ week, count: ids.size }))
    .sort((a, b) => (a.week < b.week ? -1 : 1))

  // Weekly trend series (activity, sessions, crash-free, north star)
  const weeks = new Map()
  const weekOf = (d) => {
    const w = isoWeekKey(d)
    if (!weeks.has(w)) weeks.set(w, { week: w, actives: new Set(), sessions: 0, crashFree: 0, agentUsers: 0, prompts: 0 })
    return weeks.get(w)
  }
  for (const [d, id] of activityPairs) weekOf(d).actives.add(id)
  for (const [d, count, crashFreeCount] of sessionEnds) {
    const w = weekOf(d)
    w.sessions += Number(count) || 0
    w.crashFree += Number(crashFreeCount) || 0
  }
  for (const [d, , , , prompts] of dailySummaries) weekOf(d).prompts += Number(prompts) || 0
  for (const { week, count } of northStarSeries) {
    if (weeks.has(week)) weeks.get(week).agentUsers = count
  }
  const weeklyTrend = [...weeks.values()]
    .map((w) => ({
      week: w.week,
      actives: w.actives.size,
      sessions: w.sessions,
      crashFreeRate: w.sessions > 0 ? w.crashFree / w.sessions : null,
      agentUsers: w.agentUsers,
      prompts: w.prompts
    }))
    .sort((a, b) => (a.week < b.week ? -1 : 1))

  // Version distribution on the reference day (fallback: latest day present)
  const versionDays = [...new Set(versionsByDay.map((r) => r[0]))].sort()
  const versionDay = versionDays.includes(asOf) ? asOf : versionDays[versionDays.length - 1]
  const versionRows = versionsByDay
    .filter((r) => r[0] === versionDay)
    .map(([, version, uniq]) => ({ version, users: Number(uniq) || 0 }))
    .sort((a, b) => b.users - a.users)

  return {
    asOf,
    windowDays,
    scale: {
      dau,
      wau,
      mau,
      totalInstalls,
      dauMau: mau > 0 ? dau / mau : null,
      wauMau: mau > 0 ? wau / mau : null
    },
    retention: { d1: retentionAt(1), d7: retentionAt(7), d30: retentionAt(30) },
    sessions: {
      total7d: sessions7,
      starts7d: sessionStarts7,
      crashFreeRate7d: sessions7 > 0 ? crashFree7 / sessions7 : null,
      p50Ms7d: sessions7 > 0 ? Math.round(p50Weighted / sessions7) : 0,
      p95Ms7d: sessions7 > 0 ? Math.round(p95Weighted / sessions7) : 0
    },
    adoption: adoptionRows,
    featureUsage: { rows: featureUsageRows, breadthAvg: featureBreadthAvg },
    engagement: {
      installDays7d: summaryInstallDays7,
      avgActiveMsPerInstallDay: summaryInstallDays7 > 0 ? Math.round(activeMs7 / summaryInstallDays7) : 0,
      prompts7d: prompts7,
      agentLaunches7d: agentLaunches7
    },
    stability: {
      crashFreeUsersRate7d: wau > 0 ? (wau - crashedUsers7.size) / wau : null,
      crashedUsers7d: crashedUsers7.size,
      recovered7d: Object.fromEntries(recovered7)
    },
    updateHealth: {
      totals30d: updateTotals,
      installRate30d:
        (updateTotals['update/downloaded'] ?? 0) > 0
          ? (updateTotals['update/installComplete'] ?? 0) / updateTotals['update/downloaded']
          : null
    },
    northStar: {
      definition: 'weekly active agent users (installs with any Coding Agent activity that ISO week)',
      series: northStarSeries,
      currentWeek: northStarSeries[northStarSeries.length - 1] ?? null
    },
    weeklyTrend,
    versions: { day: versionDay ?? null, rows: versionRows },
    platforms: platforms.map(([platform, uniq]) => ({ platform, users: Number(uniq) || 0 }))
  }
}

/**
 * Headline extraction for the snapshot-over-snapshot trend table: one
 * compact row per historical snapshot, recomputed with today's definitions
 * so definition upgrades re-baseline the whole history consistently.
 */
export function computeSnapshotHeadline(snapshot) {
  const m = computeMetricsModel(snapshot)
  return {
    pulledAt: snapshot?.pulledAt ?? null,
    asOf: m.asOf ?? null,
    dau: m.scale.dau,
    wau: m.scale.wau,
    mau: m.scale.mau,
    wauMau: m.scale.wauMau,
    crashFreeSessions7d: m.sessions.crashFreeRate7d,
    northStar: m.northStar.currentWeek?.count ?? 0
  }
}
