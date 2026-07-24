/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Full-pull PostHog snapshot for the Onward metrics report.
 *
 * Runs a fixed set of HogQL queries against the PostHog project and stores
 * the raw result arrays as one timestamped JSON snapshot under
 * `traces/metrics/snapshots/`. Full pull by design (decision 2026-07-18):
 * no incremental-sync state to corrupt, and every snapshot alone can
 * rebuild the whole per-date history.
 *
 * Auth: a READ-ONLY personal API key (scope: Query Read, restricted to the
 * Onward project), taken from — in priority order —
 *   1. env ONWARD_POSTHOG_API_KEY
 *   2. file ~/.config/onward/posthog-api-key (single line)
 * The key never appears in argv, in the repo, or in the report output.
 *
 * Usage:
 *   node scripts/metrics/pull-posthog-snapshot.mjs [--host https://us.posthog.com] [--project 516735]
 *
 * Cross-platform: pure Node (fs/path/os/fetch), no shell dependencies.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'fs'
import { homedir } from 'os'
import { join, dirname } from 'path'
import { fileURLToPath, pathToFileURL } from 'url'

const DEFAULT_HOST = 'https://us.posthog.com'
const DEFAULT_PROJECT_ID = 516735

/** repoRoot/traces/metrics — resolved relative to this script's location. */
function metricsDir() {
  const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
  return join(repoRoot, 'traces', 'metrics')
}

export function resolveApiKey() {
  const fromEnv = process.env.ONWARD_POSTHOG_API_KEY
  if (fromEnv && fromEnv.trim() !== '') return fromEnv.trim()
  try {
    const keyPath = join(homedir(), '.config', 'onward', 'posthog-api-key')
    const fromFile = readFileSync(keyPath, 'utf-8').trim()
    if (fromFile !== '') return fromFile
  } catch {}
  return null
}

/**
 * The fixed query set. Result row shapes are the contract with
 * metrics-model.mjs — extend by APPENDING new named queries; never change
 * an existing row shape (snapshots are long-lived historical artifacts).
 */
export const SNAPSHOT_QUERIES = {
  activityPairs:
    'select toDate(timestamp) as d, distinct_id from events group by d, distinct_id order by d',
  firstSeen:
    'select distinct_id, toDate(min(timestamp)) as first_day from events group by distinct_id',
  sessionStarts:
    "select toDate(timestamp) as d, count() from events where event = 'session/start' group by d order by d",
  sessionEnds:
    "select toDate(timestamp) as d, count(), countIf(properties.crashFree = 'true'), quantile(0.5)(ifNull(toFloat(properties.durationMs), 0)), quantile(0.95)(ifNull(toFloat(properties.durationMs), 0)) from events where event = 'session/end' group by d order by d",
  firstUse:
    "select toDate(timestamp) as d, properties.feature, count() from events where event = 'feature/first-use' group by d, properties.feature order by d",
  dailySummaries:
    "select toDate(timestamp) as d, distinct_id, max(ifNull(toFloat(properties.sessionCount), 0)), max(ifNull(toFloat(properties.totalActiveMs), 0)), max(ifNull(toFloat(properties.promptSend), 0) + ifNull(toFloat(properties.promptExecute), 0) + ifNull(toFloat(properties.promptSendAndExecute), 0)), max(ifNull(toFloat(properties.dropdownToolsCodeAgent), 0) + ifNull(toFloat(properties.dropdownToolsClaudeCode), 0) + ifNull(toFloat(properties.dropdownToolsCodex), 0)), max(ifNull(toFloat(properties.dropdownToolsBrowser), 0)), max(ifNull(toFloat(properties.rendererCrashCount), 0)) from events where event = 'daily/summary' group by d, distinct_id order by d",
  updateEvents:
    "select toDate(timestamp) as d, event, count() from events where event like 'update/%' group by d, event order by d",
  crashPairs:
    "select toDate(timestamp) as d, distinct_id, count() from events where event in ('error/rendererCrash', 'error/gpuProcessCrash') group by d, distinct_id order by d",
  recovered:
    "select toDate(timestamp) as d, properties.kind, count() from events where event = 'error/recovered' group by d, properties.kind order by d",
  agentPairs:
    "select toDate(timestamp) as d, distinct_id from events where (event = 'dropdown/tools' and properties.action in ('codeAgent', 'claudeCode', 'codex')) or (event = 'feature/first-use' and properties.feature = 'code-agent') or (event = 'daily/summary' and (ifNull(toFloat(properties.dropdownToolsCodeAgent), 0) > 0 or ifNull(toFloat(properties.dropdownToolsClaudeCode), 0) > 0 or ifNull(toFloat(properties.dropdownToolsCodex), 0) > 0)) group by d, distinct_id order by d",
  versionsByDay:
    'select toDate(timestamp) as d, properties.appVersion, uniq(distinct_id) from events group by d, properties.appVersion order by d',
  platforms:
    'select properties.platform, uniq(distinct_id) from events group by properties.platform',
  // P2 (appended per the append-only rule): raw summary property blobs so
  // the model can extract the dynamic fu_* feature-use counters without a
  // parallel feature-ID list living outside the app registry.
  dailySummariesRaw:
    "select toDate(timestamp) as d, distinct_id, properties from events where event = 'daily/summary' order by d",
  // 2026-07-23 GPU-crash observability (appended per the append-only rule):
  // splits GPU crashes from renderer crashes per app version + reason —
  // crashPairs conflates the two classes, and the Electron-upgrade A/B is
  // judged on exactly this series.
  gpuCrashesByVersion:
    "select toDate(timestamp) as d, properties.appVersion, properties.reason, count() from events where event = 'error/gpuProcessCrash' group by d, properties.appVersion, properties.reason order by d",
  // Recovery health per version: 'sticky-fallback' rows = the N=2 session
  // fuse engaged (terminals degraded to the DOM renderer until restart).
  gpuRecoveryOutcomes:
    "select toDate(timestamp) as d, properties.appVersion, properties.outcome, count() from events where event = 'error/gpuCrashRecovery' group by d, properties.appVersion, properties.outcome order by d"
}

async function runQuery(host, projectId, apiKey, sql) {
  const res = await fetch(`${host.replace(/\/$/, '')}/api/projects/${projectId}/query/`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ query: { kind: 'HogQLQuery', query: sql } })
  })
  if (!res.ok) {
    const body = (await res.text().catch(() => '')).slice(0, 300)
    throw new Error(`query failed (${res.status}): ${body}`)
  }
  const json = await res.json()
  if (!Array.isArray(json.results)) {
    throw new Error(`query returned no results array: ${JSON.stringify(json).slice(0, 300)}`)
  }
  return json.results
}

function parseArgs(argv) {
  const args = { host: DEFAULT_HOST, projectId: DEFAULT_PROJECT_ID }
  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case '--host': args.host = argv[++i]; break
      case '--project': args.projectId = Number(argv[++i]) || DEFAULT_PROJECT_ID; break
      default:
        throw new Error(`Unknown argument: ${argv[i]}`)
    }
  }
  return args
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const apiKey = resolveApiKey()
  if (!apiKey) {
    console.error('[metrics-pull] No API key found. Provide a READ-ONLY personal API key via either:')
    console.error('  1. env  ONWARD_POSTHOG_API_KEY')
    console.error('  2. file ~/.config/onward/posthog-api-key (single line)')
    console.error('Create one at PostHog → Settings → Personal API Keys with ONLY the "Query Read" scope,')
    console.error('restricted to the Onward project. Never commit it or pass it as a CLI argument.')
    process.exitCode = 1
    return
  }

  const queries = {}
  const names = Object.keys(SNAPSHOT_QUERIES)
  for (const [index, name] of names.entries()) {
    process.stdout.write(`[metrics-pull] query ${index + 1}/${names.length}: ${name} ... `)
    queries[name] = await runQuery(args.host, args.projectId, apiKey, SNAPSHOT_QUERIES[name])
    console.log(`${queries[name].length} row(s)`)
  }

  const pulledAt = new Date().toISOString()
  const snapshot = {
    schemaVersion: 1,
    pulledAt,
    host: args.host,
    projectId: args.projectId,
    queries
  }
  const outDir = join(metricsDir(), 'snapshots')
  mkdirSync(outDir, { recursive: true })
  const outPath = join(outDir, `${pulledAt.replace(/[:.]/g, '-')}.json`)
  writeFileSync(outPath, JSON.stringify(snapshot), 'utf-8')
  console.log(`[metrics-pull] snapshot written: ${outPath}`)
}

const invokedDirectly =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href
if (invokedDirectly) {
  main().catch((err) => {
    console.error(`[metrics-pull] FAILED: ${err.message}`)
    process.exitCode = 1
  })
}
