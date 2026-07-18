/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * One-off importer: backfill locally captured telemetry events into PostHog.
 *
 * The app appends every consent-gated telemetry event to
 * `<userData>/telemetry-events.jsonl` (one JSON object per line, see
 * `electron/main/telemetry/telemetry-service.ts::writeLocal`). While the old
 * Azure backend was offline those lines kept accumulating locally. This
 * script replays them into PostHog with their original timestamps via the
 * `/batch/` endpoint's `historical_migration` mode, which ingests past-dated
 * events without tripping spike detection.
 *
 * `telemetry-daily.json` does NOT need importing: the app's own pending-upload
 * loop sends it as a `daily/summary` event once an upload client is configured.
 *
 * Usage:
 *   node scripts/telemetry-backfill-posthog.mjs \
 *     --file /path/to/telemetry-events.jsonl \
 *     --key phc_xxxxxxxx \
 *     [--host https://us.i.posthog.com] [--batch-size 200] [--dry-run]
 *
 * Cross-platform: pure Node (fs/path/fetch), no shell dependencies.
 */

import { readFileSync } from 'fs'
import { pathToFileURL } from 'url'

export const DEFAULT_HOST = 'https://us.i.posthog.com'
export const DEFAULT_BATCH_SIZE = 200

/**
 * Parse one JSONL line into a telemetry entry. Returns null for blank or
 * malformed lines (a tail-partial line from a crashed session is expected
 * and must not abort the import).
 */
export function parseJsonlLine(line) {
  const trimmed = line.trim()
  if (!trimmed) return null
  try {
    const obj = JSON.parse(trimmed)
    if (typeof obj !== 'object' || obj === null) return null
    if (typeof obj.name !== 'string' || obj.name === '') return null
    if (typeof obj.timestamp !== 'string' || Number.isNaN(Date.parse(obj.timestamp))) return null
    return obj
  } catch {
    return null
  }
}

/**
 * Map a local JSONL entry to a PostHog /batch event.
 * - distinct_id comes from the entry's own captured instanceId so imports
 *   from several machines keep their per-install grouping.
 * - `$process_person_profile: false` mirrors the live pipeline: events stay
 *   anonymous, no person profile is materialised server-side.
 */
export function mapEntryToBatchEvent(entry) {
  const common = entry.common && typeof entry.common === 'object' ? entry.common : {}
  const properties = entry.properties && typeof entry.properties === 'object' ? entry.properties : {}
  const distinctId =
    typeof common.instanceId === 'string' && common.instanceId !== ''
      ? common.instanceId
      : 'backfill-unknown-instance'
  return {
    event: entry.name,
    distinct_id: distinctId,
    timestamp: entry.timestamp,
    properties: {
      ...common,
      ...properties,
      $process_person_profile: false
    }
  }
}

/** Split events into fixed-size chunks for /batch requests. */
export function chunkBatch(events, size) {
  const chunks = []
  for (let i = 0; i < events.length; i += size) {
    chunks.push(events.slice(i, i + size))
  }
  return chunks
}

/**
 * POST one chunk to PostHog /batch/ in historical-migration mode.
 * Retries transient failures (network, 429, 5xx) with exponential backoff;
 * fails fast on other 4xx where retrying cannot help.
 */
async function sendBatch(host, apiKey, batch, attempt = 1) {
  const MAX_ATTEMPTS = 3
  try {
    const res = await fetch(`${host.replace(/\/$/, '')}/batch/`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ api_key: apiKey, historical_migration: true, batch })
    })
    if (res.ok) return
    const retriable = res.status === 429 || res.status >= 500
    const body = (await res.text().catch(() => '')).slice(0, 300)
    if (!retriable || attempt >= MAX_ATTEMPTS) {
      throw new Error(`PostHog /batch/ responded ${res.status}: ${body}`)
    }
  } catch (err) {
    if (attempt >= MAX_ATTEMPTS) throw err
  }
  const backoffMs = 1000 * 2 ** (attempt - 1)
  await new Promise((resolve) => setTimeout(resolve, backoffMs))
  return sendBatch(host, apiKey, batch, attempt + 1)
}

function parseArgs(argv) {
  const args = { host: DEFAULT_HOST, batchSize: DEFAULT_BATCH_SIZE, dryRun: false }
  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case '--file': args.file = argv[++i]; break
      case '--key': args.key = argv[++i]; break
      case '--host': args.host = argv[++i]; break
      case '--batch-size': args.batchSize = Number(argv[++i]) || DEFAULT_BATCH_SIZE; break
      case '--dry-run': args.dryRun = true; break
      default:
        throw new Error(`Unknown argument: ${argv[i]}`)
    }
  }
  if (!args.file) throw new Error('Missing required --file <telemetry-events.jsonl>')
  if (!args.key && !args.dryRun) throw new Error('Missing required --key <phc_...> (or use --dry-run)')
  return args
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const raw = readFileSync(args.file, 'utf-8')
  const lines = raw.split('\n')
  const entries = []
  let skipped = 0
  for (const line of lines) {
    if (!line.trim()) continue
    const entry = parseJsonlLine(line)
    if (entry) entries.push(entry)
    else skipped++
  }
  const events = entries.map(mapEntryToBatchEvent)
  const chunks = chunkBatch(events, args.batchSize)

  console.log(`[backfill] parsed ${entries.length} events (${skipped} malformed lines skipped)`)
  console.log(`[backfill] ${chunks.length} batch(es) of up to ${args.batchSize} events, target ${args.host}`)

  if (args.dryRun) {
    if (events.length > 0) {
      console.log('[backfill] dry-run — first mapped event:')
      console.log(JSON.stringify(events[0], null, 2))
    }
    console.log('[backfill] dry-run complete, nothing sent')
    return
  }

  let sent = 0
  for (const [index, chunk] of chunks.entries()) {
    await sendBatch(args.host, args.key, chunk)
    sent += chunk.length
    console.log(`[backfill] batch ${index + 1}/${chunks.length} sent (${sent}/${events.length} events)`)
  }
  console.log(`[backfill] done: ${sent} events imported into PostHog (historical_migration)`)
}

const invokedDirectly =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href
if (invokedDirectly) {
  main().catch((err) => {
    console.error(`[backfill] FAILED: ${err.message}`)
    process.exitCode = 1
  })
}
