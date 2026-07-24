/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

import { randomUUID } from 'crypto'
import { app } from 'electron'
import { join } from 'path'
import { readFileSync, writeFileSync } from 'fs'
import { appendFile, readFile, stat, writeFile } from 'fs/promises'
import { getAppInfo } from '../app-info'
import { performanceTrace } from '../performance-trace'
import { PERF_TRACE_EVENT } from '../../../src/utils/perf-trace-names'
import { getTelemetryConsent, getTelemetryInstanceId } from './telemetry-consent'
import { getDailyAggregator } from './telemetry-aggregator'
import {
  clampEnumProperties,
  deriveFirstUseFeature,
  roundDurationMs,
  TELEMETRY_EVENT,
  TELEMETRY_LIVE_DAILY_DEDUP,
  TELEMETRY_TIER2_LIVE_EVENTS,
  type TelemetryFeatureId
} from './telemetry-event-names'
import {
  deterministicEventUuid,
  removeDayLines,
  removeLines,
  selectOutboxUpload,
  trimContentToBudget,
  type OutboxEntry,
  type OutboxUploadSelection
} from './telemetry-outbox'
import {
  TELEMETRY_BUILD_DISABLED,
  TELEMETRY_MAX_PROPERTY_LENGTH,
  TELEMETRY_OUTBOX_MAX_BYTES,
  TELEMETRY_OUTBOX_TRIM_TARGET_BYTES,
  TELEMETRY_POSTHOG_API_KEY,
  TELEMETRY_POSTHOG_CONFIGURED,
  TELEMETRY_POSTHOG_HOST
} from './telemetry-constants'
import { isThreadpoolStalled } from '../threadpool-watchdog'

/** Per-append ceiling: past this the chain head is abandoned, not awaited. */
const LOCAL_APPEND_TIMEOUT_MS = 10_000
/** Ceiling on `await writeQueue` during shutdown. */
const SHUTDOWN_QUEUE_TIMEOUT_MS = 3_000

type PostHogClient = import('posthog-node').PostHog
// posthog-node v5 accepts `timestamp` and `uuid` on capture at runtime
// (client.js `_prepareEventMessage` destructures both) but omits them from
// the public EventMessage type; this local type restores them.
type CaptureMessage = import('posthog-node').EventMessage & {
  timestamp?: Date
  uuid?: string
}

/**
 * Core telemetry service — singleton orchestrator.
 *
 * Events are routed to:
 * 1. Local JSONL outbox (`telemetry-events.jsonl`)
 * 2. Daily aggregator (accumulated throughout the day)
 *
 * Outbox semantics: a record on disk = not yet confirmed uploaded.
 * Records are deleted ONLY after the backend acknowledged receipt
 * (posthog-node `flush()` resolves — it rejects when any batch fails):
 * - a day's records are covered by that day's acknowledged daily/summary;
 * - records older than the aggregator's current day (their summary was
 *   never acknowledged) are re-uploaded raw by the remediation pass with
 *   original timestamps + deterministic UUIDs (idempotent re-delivery),
 *   then deleted on acknowledgement.
 * The outbox is capped at TELEMETRY_OUTBOX_MAX_BYTES (oldest dropped).
 */
class TelemetryService {
  private client: PostHogClient | null = null
  private sessionId: string = randomUUID()
  private instanceId: string | null = null
  private initialized = false
  private localLogPath: string | null = null
  private commonProperties: Record<string, string> = {}
  private writeQueue: Promise<void> = Promise.resolve()
  private outboxBytes: number | null = null
  private dailyUploadInFlight = false
  private remediationInFlight = false
  /** True once any renderer/GPU crash was tracked in this app run. */
  private sessionHadCrash = false
  private sessionGpuCrashCount = 0
  private sessionRendererCrashCount = 0
  /** Lazily loaded set of feature IDs whose first-use event already fired. */
  private firstUseFired: Set<string> | null = null
  private droppedLocalWrites = 0

  initialize(): void {
    if (this.initialized) return
    this.initialized = true

    if (TELEMETRY_BUILD_DISABLED) return

    const consent = getTelemetryConsent()
    this.instanceId = getTelemetryInstanceId()
    if (!consent || !this.instanceId) return

    this.setupLocalLog()
    this.buildCommonProperties(this.instanceId)
    this.startUploadClient()
  }

  onConsentChanged(consent: boolean, instanceId: string | null): void {
    if (consent && instanceId) {
      this.sessionId = randomUUID()
      this.instanceId = instanceId
      this.sessionHadCrash = false
      this.sessionGpuCrashCount = 0
      this.sessionRendererCrashCount = 0
      this.setupLocalLog()
      this.buildCommonProperties(instanceId)
      this.startUploadClient()
      // Fresh anonymous identity → fresh adoption state
      this.resetFirstUseState()
      // Record session/start so the aggregator counts this session
      this.track('session/start')
      this.track(TELEMETRY_EVENT.CONSENT_GRANTED)
    } else {
      // Emit the revocation marker best-effort BEFORE teardown so the
      // consent rate itself is measurable; the identity dies right after.
      if (this.client && this.instanceId) {
        this.captureToBackend(TELEMETRY_EVENT.CONSENT_REVOKED, {})
        try {
          void Promise.resolve(this.client.flush()).catch(() => {})
        } catch {}
      }
      this.instanceId = null
      this.commonProperties = {}
      this.resetFirstUseState()
      this.stopUploadClient()
    }
  }

  /**
   * Track a named event. Routes to local outbox + daily aggregator; the
   * upload lanes (daily summary / Tier-2 live / backlog remediation) pick
   * it up from there. Enum-typed properties are allowlist-clamped;
   * session/end is enriched with the crash-free flag and a rounded
   * duration; qualifying events derive a once-per-install
   * `feature/first-use` (adoption funnel).
   */
  track(name: string, properties?: Record<string, string | number | boolean | null>): void {
    if (!this.instanceId) return
    let enriched = properties ? { ...properties } : undefined
    if (name === TELEMETRY_EVENT.SESSION_END) {
      enriched = {
        ...(enriched ?? {}),
        durationMs: roundDurationMs(Number(enriched?.durationMs) || 0),
        // crashFree stays derived from BOTH counters for series continuity
        // (the sessionEnds HogQL query and crashFreeRate depend on it); the
        // split counts enable crashes-per-session-hour normalization per
        // crash class (2026-07-23 GPU observability).
        crashFree: !this.sessionHadCrash,
        gpuCrashCount: this.sessionGpuCrashCount,
        rendererCrashCount: this.sessionRendererCrashCount
      }
    }
    if (name === TELEMETRY_EVENT.ERROR_RENDERER_CRASH || name === TELEMETRY_EVENT.ERROR_GPU_PROCESS_CRASH) {
      this.sessionHadCrash = true
      if (name === TELEMETRY_EVENT.ERROR_GPU_PROCESS_CRASH) this.sessionGpuCrashCount += 1
      else this.sessionRendererCrashCount += 1
    }
    const sanitized = enriched
      ? clampEnumProperties(name, this.sanitizeProperties(enriched))
      : undefined

    // Write to local JSONL outbox
    this.writeLocal(name, sanitized)

    // Route to daily aggregator
    this.routeToAggregator(name, sanitized)

    // Adoption: derive feature first-use from ordinary events (P1 subset)
    const feature = deriveFirstUseFeature(name, sanitized)
    if (feature) this.markFeatureFirstUse(feature)
  }

  /**
   * Emit `feature/first-use` for a feature at most once per install.
   * P1 derives calls from existing events; P2 call sites invoke this
   * directly from their UI handlers.
   */
  markFeatureFirstUse(feature: TelemetryFeatureId): void {
    if (!this.instanceId) return
    if (this.firstUseFired === null) this.firstUseFired = this.loadFirstUseState()
    if (this.firstUseFired.has(feature)) return
    this.firstUseFired.add(feature)
    this.persistFirstUseState()
    this.track(TELEMETRY_EVENT.FEATURE_FIRST_USE, { feature })
  }

  /**
   * Heartbeat-driven upload pump. If a daily summary is due, upload it and
   * — only after the backend acknowledged — mark it uploaded and clear that
   * day's outbox records. Otherwise give the remediation pass a turn on any
   * older backlog. No acknowledgement → no state change; retried next tick.
   */
  tryDailyUpload(): void {
    if (!this.client) return // Don't consume data if the upload client is not active
    if (this.dailyUploadInFlight) return
    const aggregator = getDailyAggregator()
    const payload = aggregator.getUploadPayloadIfDue()
    if (!payload) {
      this.tryRemediateOutbox()
      return
    }
    this.dailyUploadInFlight = true
    void this.uploadSummaryWithAck(payload)
      .then((acked) => {
        if (acked) {
          aggregator.markUploaded()
          this.removeUploadedDayFromOutbox(String(payload.date ?? ''))
        }
      })
      .catch(() => {})
      .finally(() => {
        this.dailyUploadInFlight = false
      })
  }

  /**
   * App quit: best-effort upload of the current partial-day summary.
   * Deliberately NOT acknowledgement-gated and deletes nothing — the day
   * is still open, its outbox records stay pending until the day's final
   * summary (or the remediation pass) is acknowledged on a later run.
   */
  async shutdown(): Promise<void> {
    if (!this.instanceId) return

    const aggregator = getDailyAggregator()
    const summary = aggregator.getCurrentSummary()
    if (summary && this.client) {
      console.log('[Telemetry] Uploading partial daily summary at quit (best-effort):', JSON.stringify(summary))
      this.captureToBackend('daily/summary', summary)
    }

    // Wait for local writes (session/end must have landed in the outbox) —
    // bounded: with a stalled threadpool the queue head never settles, and
    // quit must not hang behind it.
    await Promise.race([
      this.writeQueue,
      new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, SHUTDOWN_QUEUE_TIMEOUT_MS)
        timer.unref()
      })
    ])

    // Best-effort push of today's pending Tier-2 events (session/end
    // especially) so they arrive without waiting for the next launch.
    // Nothing is deleted here — the next heartbeat's ack-gated live lane
    // re-sends with the same deterministic UUIDs and PostHog deduplicates.
    // Skipped entirely while the threadpool watchdog reports a stall: the
    // readFile below rides the libuv threadpool and would never settle
    // (.catch only covers rejection, not a never-settling promise), wedging
    // shutdown past its queue ceiling until the quit hard floor forces
    // app.exit(0) and the rest of the graceful teardown is lost. The race
    // covers the stall-just-began window the watchdog has not flagged yet.
    if (this.client && this.localLogPath && !isThreadpoolStalled()) {
      try {
        const raw = await Promise.race([
          readFile(this.localLogPath, 'utf-8').catch(() => ''),
          new Promise<string>((resolve) => {
            const timer = setTimeout(() => resolve(''), SHUTDOWN_QUEUE_TIMEOUT_MS)
            timer.unref()
          })
        ])
        if (raw) {
          const selection = selectOutboxUpload(
            raw,
            aggregator.getStatsDate(),
            TELEMETRY_TIER2_LIVE_EVENTS,
            TELEMETRY_LIVE_DAILY_DEDUP
          )
          for (const entry of selection.live) {
            this.client.capture({
              distinctId: entry.common?.instanceId || this.instanceId,
              event: entry.name,
              properties: {
                ...(entry.common ?? {}),
                ...(entry.properties ?? {}),
                $process_person_profile: false
              },
              timestamp: new Date(entry.timestamp),
              uuid: deterministicEventUuid(entry)
            } as CaptureMessage)
          }
          if (selection.live.length > 0) {
            performanceTrace.record(PERF_TRACE_EVENT.MAIN_TELEMETRY_SHUTDOWN_LIVE_PUSH, {
              count: selection.live.length
            })
          }
        }
      } catch {}
    }

    // Flush + close the upload client. shutdown() flushes the queue with an
    // internal timeout; cap it so app quit can never hang on a dead network.
    if (this.client) {
      const client = this.client
      this.client = null
      try {
        await Promise.resolve(client.shutdown(5000))
      } catch {}
      performanceTrace.record(PERF_TRACE_EVENT.MAIN_TELEMETRY_UPLOAD_CLIENT_STOPPED, { reason: 'shutdown' })
    }
  }

  get isActive(): boolean { return this.instanceId !== null }
  get logFilePath(): string | null { return this.localLogPath }

  // --- Aggregator routing ---

  private routeToAggregator(name: string, properties?: Record<string, string>): void {
    const agg = getDailyAggregator()

    switch (name) {
      case 'session/start':
        agg.recordSessionStart()
        break
      case 'session/end':
        agg.recordSessionEnd(Number(properties?.durationMs) || 0)
        break
      case 'session/heartbeat':
        agg.recordHeartbeat(
          Number(properties?.tabCount) || 0,
          Number(properties?.terminalCount) || 0,
          Number(properties?.layoutMode) || 1
        )
        break
      case 'prompt/use':
        agg.recordPrompt(properties?.action ?? '')
        break
      case 'dropdown/workspace':
      case 'dropdown/development':
      case 'dropdown/tools':
        agg.recordDropdown(name, properties?.action ?? '')
        break
      case 'feature/use':
        agg.recordFeatureUse(properties?.feature ?? '')
        break
      case 'error/rendererCrash':
        agg.recordRendererCrash()
        break
      case 'error/gpuProcessCrash':
        agg.recordGpuCrash()
        break
      case 'error/recovered':
        agg.recordRecovered(properties?.kind ?? '')
        break
      case 'update/check':
      case 'update/downloaded':
      case 'update/installStart':
      case 'update/installComplete':
      case 'update/error':
        agg.recordUpdateEvent(name)
        break
    }
  }

  // --- Feature first-use persistence (once per install) ---

  private firstUseStatePath(): string | null {
    try {
      return join(app.getPath('userData'), 'telemetry-firstuse.json')
    } catch {
      return null
    }
  }

  private loadFirstUseState(): Set<string> {
    const path = this.firstUseStatePath()
    if (!path) return new Set()
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf-8')) as unknown
      if (Array.isArray(parsed)) return new Set(parsed.filter((v): v is string => typeof v === 'string'))
    } catch {}
    return new Set()
  }

  private persistFirstUseState(): void {
    const path = this.firstUseStatePath()
    if (!path || this.firstUseFired === null) return
    try {
      writeFileSync(path, JSON.stringify([...this.firstUseFired]), 'utf-8')
    } catch {}
  }

  private resetFirstUseState(): void {
    this.firstUseFired = new Set()
    this.persistFirstUseState()
  }

  // --- Upload to backend (acknowledgement-gated) ---

  /**
   * Upload one daily summary and wait for the backend acknowledgement.
   * posthog-node `flush()` waits for pending captures to enqueue, sends
   * every batch, and REJECTS if any batch failed — resolving is therefore
   * a real delivery receipt, not a fire-and-forget hand-off.
   */
  private async uploadSummaryWithAck(summary: Record<string, string | number>): Promise<boolean> {
    console.log('[Telemetry] Uploading daily summary:', JSON.stringify(summary))
    if (!this.client) {
      performanceTrace.record(PERF_TRACE_EVENT.MAIN_TELEMETRY_DAILY_SUMMARY_LOCAL_ONLY, {
        date: String(summary.date ?? '')
      })
      console.log('[Telemetry] Upload client not active, summary logged locally only')
      return false
    }
    // PostHog properties keep native number types (unlike App Insights,
    // which required strings) so the backend can aggregate numerically.
    this.captureToBackend('daily/summary', summary)
    try {
      await this.client.flush()
    } catch (error) {
      performanceTrace.record(PERF_TRACE_EVENT.MAIN_TELEMETRY_DAILY_SUMMARY_UPLOAD_FAILED, {
        date: String(summary.date ?? ''),
        error: String(error).slice(0, 256)
      })
      console.error('[Telemetry] Daily summary upload not acknowledged, will retry:', error)
      return false
    }
    performanceTrace.record(PERF_TRACE_EVENT.MAIN_TELEMETRY_DAILY_SUMMARY_UPLOADED, {
      date: String(summary.date ?? ''),
      sessionCount: Number(summary.sessionCount ?? 0)
    })
    console.log('[Telemetry] Daily summary sent to PostHog (acknowledged)')
    return true
  }

  /**
   * After a day's summary was acknowledged, its raw outbox records are
   * covered data — remove exactly that day's lines (older days stay for
   * the remediation pass; today keeps accumulating).
   */
  private removeUploadedDayFromOutbox(date: string): void {
    if (!this.localLogPath || !date) return
    const logPath = this.localLogPath
    this.writeQueue = this.writeQueue
      .then(async () => {
        const raw = await readFile(logPath, 'utf-8').catch(() => '')
        if (!raw) return
        const result = removeDayLines(raw, date)
        if (!result) return
        await writeFile(logPath, result.content, 'utf-8')
        this.outboxBytes = Buffer.byteLength(result.content, 'utf-8')
        performanceTrace.record(PERF_TRACE_EVENT.MAIN_TELEMETRY_OUTBOX_DAY_CLEARED, {
          date,
          removed: result.removed
        })
        console.log(`[Telemetry] Outbox: cleared ${result.removed} event(s) for uploaded day ${date}`)
      })
      .catch(() => {})
  }

  // --- Outbox remediation (backlog re-upload) ---

  /**
   * Remedial upload of backlog records — outbox lines dated before the
   * aggregator's current day, i.e. days whose summary never got through
   * (e.g. the backend was unreachable, or the machine was off at rollover).
   * Raw records are re-sent with original timestamps via a dedicated
   * historical-migration client; the lines are deleted only after the
   * flush acknowledgement. Runs at most one pass at a time.
   */
  private tryRemediateOutbox(): void {
    if (!this.client || !this.instanceId || !this.localLogPath) return
    if (this.remediationInFlight) return
    this.remediationInFlight = true
    const logPath = this.localLogPath
    const beforeDate = getDailyAggregator().getStatsDate()

    void (async () => {
      // Snapshot both lanes under the write queue so no append interleaves.
      let snapshot: OutboxUploadSelection | null = null
      this.writeQueue = this.writeQueue.then(async () => {
        const raw = await readFile(logPath, 'utf-8').catch(() => '')
        snapshot = raw
          ? selectOutboxUpload(raw, beforeDate, TELEMETRY_TIER2_LIVE_EVENTS, TELEMETRY_LIVE_DAILY_DEDUP)
          : null
      })
      await this.writeQueue.catch(() => {})

      // The assignment happens inside the queue closure, which TS's flow
      // analysis cannot see — assert the widened type explicitly.
      const selection = snapshot as OutboxUploadSelection | null
      if (!selection) {
        this.remediationInFlight = false
        return
      }

      // Network phases run OUTSIDE the write queue: appends stay unblocked
      // and app quit is never gated on a slow upload.

      // Lane 1 — backlog (days whose summary never got through), via the
      // historical-migration client.
      if (selection.backlog.length > 0 || selection.backlogRemoval.size > 0) {
        const acked = selection.backlog.length === 0
          ? true // only malformed lines to sweep — nothing to upload
          : await this.uploadBacklog(selection.backlog)
        if (acked) {
          await this.removeAckedLines(
            logPath,
            selection.backlogRemoval,
            `[Telemetry] Outbox remediation: ${selection.backlog.length} backlog event(s) uploaded and cleared`,
            { lane: 'backlog', uploaded: selection.backlog.length }
          )
        }
      }

      // Lane 2 — live Tier-2 discrete events of the current day, via the
      // main client (fresh events, no historical-migration flag).
      if (selection.live.length > 0) {
        const acked = await this.uploadLiveEvents(selection.live)
        if (acked) {
          await this.removeAckedLines(
            logPath,
            selection.liveRemoval,
            `[Telemetry] Outbox live lane: ${selection.live.length} event(s) uploaded and cleared`,
            { lane: 'live', uploaded: selection.live.length }
          )
        }
      }
      this.remediationInFlight = false
    })().catch(() => {
      this.remediationInFlight = false
    })
  }

  /** Rewrite the outbox without the acknowledged lines (queue-serialized). */
  private async removeAckedLines(
    logPath: string,
    removalSet: Set<string>,
    logMessage: string,
    tracePayload: { lane: string; uploaded: number }
  ): Promise<void> {
    this.writeQueue = this.writeQueue
      .then(async () => {
        const raw = await readFile(logPath, 'utf-8').catch(() => '')
        if (!raw) return
        const result = removeLines(raw, removalSet)
        if (!result) return
        await writeFile(logPath, result.content, 'utf-8')
        this.outboxBytes = Buffer.byteLength(result.content, 'utf-8')
        performanceTrace.record(PERF_TRACE_EVENT.MAIN_TELEMETRY_OUTBOX_REMEDIATION_UPLOADED, {
          ...tracePayload,
          removed: result.removed
        })
        console.log(logMessage)
      })
      .catch(() => {})
    await this.writeQueue.catch(() => {})
  }

  /**
   * Upload current-day Tier-2 events through the main client. flush()
   * resolving is the delivery receipt (it rejects when any batch fails).
   * Deterministic UUIDs keep crash-window re-sends idempotent.
   */
  private async uploadLiveEvents(entries: OutboxEntry[]): Promise<boolean> {
    if (!this.client) return false
    try {
      for (const entry of entries) {
        this.client.capture({
          distinctId: entry.common?.instanceId || this.instanceId || 'unknown-instance',
          event: entry.name,
          properties: {
            ...(entry.common ?? {}),
            ...(entry.properties ?? {}),
            $process_person_profile: false
          },
          timestamp: new Date(entry.timestamp),
          uuid: deterministicEventUuid(entry)
        } as CaptureMessage)
      }
      await this.client.flush()
      return true
    } catch (error) {
      performanceTrace.record(PERF_TRACE_EVENT.MAIN_TELEMETRY_OUTBOX_REMEDIATION_FAILED, {
        lane: 'live',
        count: entries.length,
        error: String(error).slice(0, 256)
      })
      console.error('[Telemetry] Live event upload not acknowledged, will retry later:', error)
      return false
    }
  }

  /**
   * Send backlog entries through a dedicated historical-migration client.
   * Returns true only when the final flush resolved (delivery receipt).
   * Deterministic per-record UUIDs make re-delivery after a crash between
   * "acknowledged" and "deleted" idempotent server-side.
   */
  private async uploadBacklog(entries: OutboxEntry[]): Promise<boolean> {
    let migration: PostHogClient | null = null
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { PostHog } = require('posthog-node') as typeof import('posthog-node')
      migration = new PostHog(TELEMETRY_POSTHOG_API_KEY, {
        host: TELEMETRY_POSTHOG_HOST,
        historicalMigration: true,
        flushAt: 200,
        flushInterval: 60 * 60 * 1000, // manual flush below is the only sender
        disableGeoip: true
      })
      migration.on('error', () => {}) // failures surface via the flush rejection
      for (const entry of entries) {
        migration.capture({
          distinctId: entry.common?.instanceId || this.instanceId || 'unknown-instance',
          event: entry.name,
          properties: {
            ...(entry.common ?? {}),
            ...(entry.properties ?? {}),
            $process_person_profile: false
          },
          timestamp: new Date(entry.timestamp),
          uuid: deterministicEventUuid(entry)
        } as CaptureMessage)
      }
      await migration.flush()
      return true
    } catch (error) {
      performanceTrace.record(PERF_TRACE_EVENT.MAIN_TELEMETRY_OUTBOX_REMEDIATION_FAILED, {
        lane: 'backlog',
        count: entries.length,
        error: String(error).slice(0, 256)
      })
      console.error('[Telemetry] Outbox remediation upload not acknowledged, will retry later:', error)
      return false
    } finally {
      if (migration) {
        try {
          void Promise.resolve(migration.shutdown(2000)).catch(() => {})
        } catch {}
      }
    }
  }

  // --- Local JSONL logging ---

  private setupLocalLog(): void {
    try {
      this.localLogPath = join(app.getPath('userData'), 'telemetry-events.jsonl')
    } catch {
      this.localLogPath = null
    }
  }

  private writeLocal(name: string, properties?: Record<string, string>): void {
    if (!this.localLogPath || !this.instanceId) return
    // 2026-07-20 incident hardening: the serial writeQueue used to chain an
    // unbounded `appendFile` — with the libuv threadpool stalled, the chain
    // head never settled and every later telemetry write queued forever
    // (and quit hung behind `await writeQueue`). The queue now (a) drops
    // writes outright while the watchdog reports the pool stalled, and
    // (b) abandons any single append that exceeds LOCAL_APPEND_TIMEOUT_MS.
    // An abandoned append may still land later if the pool revives; a rare
    // out-of-order debug-log line is acceptable, an unbounded chain is not.
    if (isThreadpoolStalled()) {
      this.noteDroppedLocalWrite('threadpool-stalled')
      return
    }
    const entry = {
      timestamp: new Date().toISOString(),
      name,
      properties: properties || undefined,
      common: this.commonProperties
    }
    const line = JSON.stringify(entry) + '\n'
    const logPath = this.localLogPath
    this.writeQueue = this.writeQueue
      .then(() => this.appendWithTimeout(logPath, line))
      .catch(() => {})
  }

  /**
   * One outbox write (append + budget enforcement) under a hard ceiling.
   * BOTH steps use async fs and therefore both die with a stalled libuv
   * threadpool — guarding only the append would still let the trim step
   * wedge the serial queue head forever. An abandoned write may still land
   * later if the pool revives; a rare out-of-order outbox line is
   * acceptable, an unbounded chain is not.
   */
  private appendWithTimeout(logPath: string, line: string): Promise<void> {
    return new Promise((resolve) => {
      let settled = false
      const settle = (): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve()
      }
      const timer = setTimeout(() => {
        if (settled) return
        settled = true
        this.noteDroppedLocalWrite('append-timeout')
        resolve()
      }, LOCAL_APPEND_TIMEOUT_MS)
      timer.unref()
      void (async () => {
        await appendFile(logPath, line, 'utf-8')
        await this.enforceOutboxBudget(logPath, line)
      })().then(settle, settle)
    })
  }

  private noteDroppedLocalWrite(reason: string): void {
    this.droppedLocalWrites += 1
    // First drop announces the degradation; afterwards only every 100th, so
    // the trace is informative without becoming per-event noise.
    if (this.droppedLocalWrites === 1 || this.droppedLocalWrites % 100 === 0) {
      performanceTrace.record(PERF_TRACE_EVENT.MAIN_TELEMETRY_WRITE_QUEUE_DEGRADED, {
        reason,
        droppedLocalWrites: this.droppedLocalWrites
      })
    }
  }

  /**
   * Keep the outbox within its size cap. Size is tracked incrementally
   * (one stat() on first touch, then byte arithmetic); past the cap the
   * oldest lines are dropped down to the trim target so a long offline
   * stretch cannot grow the file unboundedly.
   */
  private async enforceOutboxBudget(logPath: string, appendedLine: string): Promise<void> {
    if (this.outboxBytes === null) {
      try {
        this.outboxBytes = (await stat(logPath)).size
      } catch {
        this.outboxBytes = 0
        return
      }
    } else {
      this.outboxBytes += Buffer.byteLength(appendedLine, 'utf-8')
    }
    if (this.outboxBytes <= TELEMETRY_OUTBOX_MAX_BYTES) return
    const raw = await readFile(logPath, 'utf-8').catch(() => '')
    const trimmed = trimContentToBudget(raw, TELEMETRY_OUTBOX_MAX_BYTES, TELEMETRY_OUTBOX_TRIM_TARGET_BYTES)
    if (!trimmed) {
      this.outboxBytes = Buffer.byteLength(raw, 'utf-8')
      return
    }
    await writeFile(logPath, trimmed.content, 'utf-8')
    this.outboxBytes = trimmed.bytes
    performanceTrace.record(PERF_TRACE_EVENT.MAIN_TELEMETRY_OUTBOX_TRIMMED, {
      droppedLines: trimmed.droppedLines,
      bytes: trimmed.bytes
    })
    console.warn(`[Telemetry] Outbox exceeded ${TELEMETRY_OUTBOX_MAX_BYTES} bytes, dropped ${trimmed.droppedLines} oldest event(s)`)
  }

  private buildCommonProperties(instanceId: string): void {
    const appInfo = getAppInfo()
    this.commonProperties = {
      instanceId,
      sessionId: this.sessionId,
      appVersion: appInfo.version,
      buildChannel: appInfo.buildChannel,
      releaseChannel: appInfo.releaseChannel,
      platform: process.platform,
      arch: process.arch,
      electronVersion: process.versions.electron ?? 'unknown'
    }
  }

  // --- PostHog upload client ---

  /**
   * Send one event to PostHog. `$process_person_profile: false` marks the
   * event anonymous — no person profile is materialised server-side; the
   * random instanceId only groups events from the same install.
   */
  private captureToBackend(
    name: string,
    properties: Record<string, string | number>
  ): void {
    if (!this.client || !this.instanceId) return
    this.client.capture({
      distinctId: this.instanceId,
      event: name,
      properties: {
        ...this.commonProperties,
        ...properties,
        $process_person_profile: false
      }
    })
  }

  private startUploadClient(): void {
    this.stopUploadClient()
    if (!TELEMETRY_POSTHOG_CONFIGURED) {
      performanceTrace.record(PERF_TRACE_EVENT.MAIN_TELEMETRY_UPLOAD_CLIENT_NOT_CONFIGURED, {})
      console.log('[Telemetry] PostHog API key not configured, uploads disabled (local pipeline active)')
      return
    }

    try {
      // Lazy require keeps SDK load off the consent-declined startup path.
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { PostHog } = require('posthog-node') as typeof import('posthog-node')
      this.client = new PostHog(TELEMETRY_POSTHOG_API_KEY, {
        host: TELEMETRY_POSTHOG_HOST,
        flushAt: 1, // ~1 event/day per install — send as soon as captured
        flushInterval: 10000,
        disableGeoip: true
      })
      this.client.on('error', (error: unknown) => {
        performanceTrace.record(PERF_TRACE_EVENT.MAIN_TELEMETRY_UPLOAD_ERROR, {
          error: String(error).slice(0, 256)
        })
        console.error('[Telemetry] PostHog upload error:', error)
      })
      performanceTrace.record(PERF_TRACE_EVENT.MAIN_TELEMETRY_UPLOAD_CLIENT_STARTED, {
        host: TELEMETRY_POSTHOG_HOST
      })
    } catch (error) {
      performanceTrace.record(PERF_TRACE_EVENT.MAIN_TELEMETRY_UPLOAD_CLIENT_START_FAILED, {
        error: String(error).slice(0, 256)
      })
      console.error('[Telemetry] Failed to initialize PostHog client:', error)
      this.client = null
    }
  }

  private stopUploadClient(): void {
    if (!this.client) return
    const client = this.client
    this.client = null
    try {
      // Fire-and-forget: flush whatever is queued, then close. Consent-off
      // must not block the caller.
      void Promise.resolve(client.shutdown(2000)).catch(() => {})
    } catch {}
    performanceTrace.record(PERF_TRACE_EVENT.MAIN_TELEMETRY_UPLOAD_CLIENT_STOPPED, { reason: 'stop' })
  }

  private sanitizeProperties(
    props: Record<string, string | number | boolean | null>
  ): Record<string, string> {
    const result: Record<string, string> = {}
    for (const [key, value] of Object.entries(props)) {
      if (value === null || value === undefined) continue
      const str = String(value)
      result[key] = str.length > TELEMETRY_MAX_PROPERTY_LENGTH
        ? str.slice(0, TELEMETRY_MAX_PROPERTY_LENGTH)
        : str
    }
    return result
  }
}

// Singleton
let instance: TelemetryService | null = null

export function getTelemetryService(): TelemetryService {
  if (!instance) {
    instance = new TelemetryService()
  }
  return instance
}
