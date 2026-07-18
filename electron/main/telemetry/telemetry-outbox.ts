/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash } from 'crypto'

/**
 * Pure logic for the telemetry outbox (`telemetry-events.jsonl`).
 *
 * Semantics (decided 2026-07-17): the JSONL file IS the not-yet-delivered
 * queue. A record still on disk means its data has not been confirmed
 * uploaded; records are removed ONLY after the backend acknowledged
 * receipt (posthog-node `flush()` resolving). No function here touches
 * the filesystem or network — `telemetry-service.ts` owns the side
 * effects, unit tests lock the decisions.
 */

export interface OutboxEntry {
  timestamp: string
  name: string
  properties?: Record<string, string>
  common?: Record<string, string>
}

/**
 * Parse one JSONL line. Returns null for blank / malformed / tail-partial
 * lines (a crashed session can leave a truncated last line).
 */
export function parseOutboxLine(line: string): OutboxEntry | null {
  const trimmed = line.trim()
  if (!trimmed) return null
  try {
    const obj = JSON.parse(trimmed) as OutboxEntry
    if (typeof obj !== 'object' || obj === null) return null
    if (typeof obj.name !== 'string' || obj.name === '') return null
    if (typeof obj.timestamp !== 'string' || Number.isNaN(Date.parse(obj.timestamp))) return null
    return obj
  } catch {
    return null
  }
}

/** UTC calendar date of an entry — same convention as the daily aggregator. */
export function outboxEntryDate(entry: OutboxEntry): string {
  return new Date(entry.timestamp).toISOString().slice(0, 10)
}

export interface RemediationBacklog {
  /** Parsed entries strictly older than `beforeDate`, oldest first. */
  remediate: OutboxEntry[]
  /**
   * Raw line strings to delete once the upload is acknowledged: the
   * remediated lines plus malformed lines (which can never upload and
   * would otherwise sit in the outbox forever).
   */
  removalSet: Set<string>
}

export interface OutboxUploadSelection {
  /** Entries older than the aggregator day — historical-migration lane. */
  backlog: OutboxEntry[]
  /** Lines removed after the backlog acknowledgement (incl. malformed). */
  backlogRemoval: Set<string>
  /** Current-day Tier-2 discrete events — live lane, fresh upload. */
  live: OutboxEntry[]
  /** Lines removed after the live acknowledgement. */
  liveRemoval: Set<string>
}

/**
 * Partition the outbox into the two upload lanes:
 * - BACKLOG: every parseable line dated strictly before `beforeDate`
 *   (days whose summary never got through) → historical-migration client.
 * - LIVE: current-day lines whose event name is in `liveEventNames`
 *   (Tier-2 discrete events: session start/end, first-use, crash/update,
 *   consent) → the main client, uploaded raw on the next heartbeat.
 * Tier-1 current-day lines (heartbeats, prompt/dropdown counts) stay put —
 * they are represented by the daily summary and cleared by its ack.
 * Events listed in `dailyDedup` (event name → discriminating property)
 * upload at most once per (property value, day); the duplicates join the
 * removal set without being uploaded — the aggregate counters carry the
 * full occurrence counts.
 * Malformed lines can never upload and join the backlog removal set.
 */
export function selectOutboxUpload(
  rawContent: string,
  beforeDate: string,
  liveEventNames: ReadonlySet<string>,
  dailyDedup: Record<string, string> = {}
): OutboxUploadSelection {
  const backlog: OutboxEntry[] = []
  const live: OutboxEntry[] = []
  const backlogRemoval = new Set<string>()
  const liveRemoval = new Set<string>()
  const dedupSeen = new Set<string>()
  for (const line of rawContent.split('\n')) {
    if (!line.trim()) continue
    const entry = parseOutboxLine(line)
    if (entry === null) {
      backlogRemoval.add(line)
      continue
    }
    const date = outboxEntryDate(entry)
    if (date < beforeDate) {
      backlog.push(entry)
      backlogRemoval.add(line)
      continue
    }
    if (liveEventNames.has(entry.name)) {
      liveRemoval.add(line)
      const dedupProp = dailyDedup[entry.name]
      if (dedupProp) {
        const key = `${entry.name}|${entry.properties?.[dedupProp] ?? ''}|${date}`
        if (dedupSeen.has(key)) continue
        dedupSeen.add(key)
      }
      live.push(entry)
    }
  }
  return { backlog, live, backlogRemoval, liveRemoval }
}

/**
 * Legacy single-lane view of the selection (backlog only). Kept for the
 * existing unit-test contract; the service uses selectOutboxUpload.
 */
export function selectRemediationBacklog(rawContent: string, beforeDate: string): RemediationBacklog {
  const selection = selectOutboxUpload(rawContent, beforeDate, new Set())
  return { remediate: selection.backlog, removalSet: selection.backlogRemoval }
}

/**
 * Rewrite content keeping every line NOT in `removalSet`. Used after an
 * acknowledged remedial upload. Returns null when nothing was removed so
 * the caller can skip the disk write.
 */
export function removeLines(rawContent: string, removalSet: Set<string>): { content: string; removed: number } | null {
  const kept: string[] = []
  let removed = 0
  for (const line of rawContent.split('\n')) {
    if (!line.trim()) continue
    if (removalSet.has(line)) {
      removed++
      continue
    }
    kept.push(line)
  }
  if (removed === 0) return null
  return { content: kept.length > 0 ? kept.join('\n') + '\n' : '', removed }
}

/**
 * Remove the lines of one UTC day. Used after that day's aggregated
 * daily/summary was acknowledged — the raw records are then covered by
 * the summary and no longer pending. Malformed lines are kept (the
 * remediation pass owns their cleanup). Returns null when nothing matched.
 */
export function removeDayLines(rawContent: string, date: string): { content: string; removed: number } | null {
  const kept: string[] = []
  let removed = 0
  for (const line of rawContent.split('\n')) {
    if (!line.trim()) continue
    const entry = parseOutboxLine(line)
    if (entry !== null && outboxEntryDate(entry) === date) {
      removed++
      continue
    }
    kept.push(line)
  }
  if (removed === 0) return null
  return { content: kept.length > 0 ? kept.join('\n') + '\n' : '', removed }
}

/**
 * Enforce the outbox size cap: when `rawContent` exceeds `maxBytes`,
 * drop OLDEST lines (file head) until the remainder fits `targetBytes`.
 * The hysteresis gap (target < max) keeps rewrites rare. Returns null
 * when the content is within budget.
 */
export function trimContentToBudget(
  rawContent: string,
  maxBytes: number,
  targetBytes: number
): { content: string; droppedLines: number; bytes: number } | null {
  const totalBytes = Buffer.byteLength(rawContent, 'utf-8')
  if (totalBytes <= maxBytes) return null
  const lines = rawContent.split('\n').filter((l) => l.trim() !== '').map((l) => l + '\n')
  let bytes = lines.reduce((sum, l) => sum + Buffer.byteLength(l, 'utf-8'), 0)
  let dropped = 0
  while (bytes > targetBytes && dropped < lines.length) {
    bytes -= Buffer.byteLength(lines[dropped], 'utf-8')
    dropped++
  }
  return { content: lines.slice(dropped).join(''), droppedLines: dropped, bytes }
}

/**
 * Deterministic, content-derived event UUID for idempotent re-delivery:
 * if the app crashes between "upload acknowledged" and "lines deleted",
 * the next remediation re-sends the same records with the same UUIDs and
 * PostHog deduplicates them server-side. SHA-1 over the stable identity
 * tuple, formatted as a valid UUID (version nibble 5, RFC variant).
 */
export function deterministicEventUuid(entry: OutboxEntry): string {
  const hash = createHash('sha1')
    .update(
      JSON.stringify([
        entry.timestamp,
        entry.name,
        entry.common?.instanceId ?? '',
        entry.common?.sessionId ?? '',
        entry.properties ?? {}
      ])
    )
    .digest('hex')
  return (
    hash.slice(0, 8) +
    '-' +
    hash.slice(8, 12) +
    '-5' +
    hash.slice(13, 16) +
    '-' +
    ((parseInt(hash[16], 16) & 0x3) | 0x8).toString(16) +
    hash.slice(17, 20) +
    '-' +
    hash.slice(20, 32)
  )
}
