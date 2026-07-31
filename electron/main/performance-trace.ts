/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

// Do NOT static-import `electron` or `./app-info` here. This module is pulled
// into the git-IPC / git-status / project-fs / sqlite / app-state worker
// bundles via `git-runtime-manager.ts`. Electron's `worker_threads` runtime
// cannot resolve the `electron` module — a synchronous `require('electron')`
// hoisted to the top of the worker chunk crashes the worker with
// "Cannot find module 'electron'" before any user-level uncaughtException
// handler can register, killing every git operation on the daily build.
// We lazy-require both `electron` and `./app-info` (which itself static-
// imports `electron`) so this trace stack is safe in worker contexts.
import { randomBytes, createHash } from 'crypto'
import { isMainThread, parentPort } from 'worker_threads'

import { traceStore, TRACE_STORE_ENABLED, type TraceStoreEvent } from './trace-store'
import { wallNowUs } from './trace-clock'
import { shouldReRaiseSignalAfterTraceFlush } from './perf-trace-signal-policy'
import { PERF_TRACE_EVENT } from '../../src/utils/perf-trace-names'

type ElectronApp = {
  isPackaged: boolean
  getAppPath: () => string
  getPath: (name: string) => string
  getVersion: () => string
  once: (event: string, cb: () => void) => void
}

function loadElectronApp(): ElectronApp | null {
  if (!isMainThread) return null
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return (require('electron') as { app: ElectronApp }).app
  } catch {
    return null
  }
}

function loadAppInfo(): { version: string; buildChannel: string } | null {
  if (!isMainThread) return null
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require('./app-info').getAppInfo()
  } catch {
    return null
  }
}

// ---------- Types ----------

type TracePhase = 'X' | 'i' | 'C' | 'M' | 's' | 't' | 'f'
type TraceScope = 'g' | 'p' | 't'
type TraceArgValue = string | number | boolean | null | string[] | number[] | boolean[]
type TraceArgs = Record<string, TraceArgValue | undefined>
type TraceTaskState = 'idle' | 'input_pending' | 'running' | 'output_active' | 'exited'
type TracePayload = Record<string, unknown> | undefined

export interface RendererTraceEvent {
  name: string
  cat?: string
  ph?: TracePhase
  ts?: number
  dur?: number
  tid?: number
  id?: string
  scope?: TraceScope
  args?: TraceArgs
}

export interface TraceContext {
  traceFlowId?: string
}

/**
 * Optional context supplied by IPC bridges forwarding events from
 * renderer / worker processes. Main-side emitters can omit this: the
 * default main-process track (pid=1, tid=1) is used when absent.
 *
 * Pass `terminalId` to route the event onto the per-Task virtual tid
 * managed by `assignTaskTid()`. The side is inferred from `process`.
 *
 * Pass `threadName` together with a stable `tid` to label a worker
 * thread lane in Perfetto UI.
 */
export interface RecordSource {
  process?: 'main' | 'renderer'
  tid?: number
  terminalId?: string
  threadName?: string
}

/**
 * Worker → main trace forwarding envelope.
 *
 * When a worker thread calls `performanceTrace.record(name, data, source)`
 * we `parentPort.postMessage` this envelope instead of writing on the
 * worker side. The main-side worker-client dispatches `'event' === 'trace'`
 * messages to `replayPerfTraceWorkerEvent`, which calls back into
 * `performanceTrace.record()` so every worker's events land in the single
 * main trace store with a consistent thread track.
 *
 * Shape mirrors `ripgrep-search-worker-entry.ts::postTrace` (the
 * established precedent — see `infra/trace.md` § 2.1) so the same
 * dispatcher pattern in worker-clients can be reused unchanged for any
 * future worker.
 */
export interface PerfTraceWorkerEvent {
  event: 'trace'
  name: string
  data?: Record<string, unknown>
  source?: RecordSource
}

export interface EventLoopStallMetrics {
  resetAt: number
  totalSamples: number
  stallCount: number
  maxDriftMs: number
  over100Ms: number
  over250Ms: number
  over500Ms: number
  over1000Ms: number
  over3000Ms: number
  over6000Ms: number
  lastStallAt: number | null
  recentStalls: Array<{ ts: number; driftMs: number }>
}

export interface PerfTraceInfo {
  enabled: boolean
  logPath: string | null
  latestPointerPath: string | null
  eventLoop: EventLoopStallMetrics
}

interface TaskActivity {
  state: TraceTaskState
  flowId: string | null
  idleTimer: ReturnType<typeof setTimeout> | null
}

// ---------- Constants ----------

// Chrome Trace Event Format constants.
//
// `pid=1` = main process.  `pid=2` = any renderer; the renderer's
// WebContents id is used as `tid` so each window / utility shows up as
// its own thread track in the Perfetto / Chrome DevTools UI.
//
// Per-Task virtual tids: any event tagged with a `terminalId` lands on
// its own row (`thread_name='task-<shortId>'`) under the relevant
// process. Main-side task tids start at `MAIN_TASK_TID_BASE`, renderer
// at `RENDERER_TASK_TID_BASE`. Real tids (1, WebContents.id) stay
// untouched, so Perfetto still shows the canonical main/renderer rows
// alongside the per-task lanes.
//
// `pid=3` = a virtual "Tasks" process that hosts the markTask* state
// machine emitted by `markTaskInput / markTaskRunning / etc.`. Disjoint
// from pid=1/2 so the per-task tid range can start at 1 without
// colliding with main tid=1.
const MAIN_PID = 1
const RENDERER_PID = 2
const TASK_PID = 3
const MAIN_TID = 1
const RENDERER_THREAD_ID = 1
const MAIN_TASK_TID_BASE = 10000
const RENDERER_TASK_TID_BASE = 20000

const TASK_IDLE_DELAY_MS = 1000

// Bounds for `record()`'s payload normalization (perf-trace-logger lineage).
const MAX_OBJECT_DEPTH = 5
const MAX_ARRAY_ITEMS = 80
const MAX_OBJECT_KEYS = 80
const MAX_STRING_LENGTH = 4000
const MAX_RECENT_EVENT_LOOP_STALLS = 40

// Bounds for the strict-redaction path used by `recordRendererEvent` /
// `markTask*` / `recordFlow*` (performance-trace lineage). Tighter than
// the `record()` path because these explicitly opt into PII redaction.
const MAX_CAPTURED_STRING_LENGTH = 240
const MAX_CAPTURED_ARRAY_LENGTH = 50

const SENSITIVE_KEY_RE = /(content|text|input|output|prompt|path|cwd|url|env|error|file|value|preview|raw|token|password|secret|apikey|authorization|email)/i
const ALLOWED_STRING_KEYS = new Set([
  'action',
  'bufferMode',
  'cat',
  'channel',
  'commandKind',
  'flowId',
  'inputKind',
  'kind',
  'mode',
  'phase',
  'reason',
  'result',
  'route',
  'schema',
  'shellKind',
  'state',
  'terminalId'
])

/**
 * Stable worker tids used by worker-client dispatchers. Each worker gets
 * its own thread track in the main trace so Perfetto SQL can group
 * events by worker without name parsing. Reserved range: 5000-5999
 * (well above the default main tid=1 and below MAIN_TASK_TID_BASE=10000).
 */
export const WORKER_TID = {
  GIT_IPC: 5001,
  GIT_STATUS: 5002,
  PROJECT_FS: 5003,
  SQLITE: 5004,
  APP_STATE: 5005,
  RIPGREP_SEARCH: 5006,
  GIT_STATE_MIRROR: 5007
} as const

// ---------- Pure helpers ----------

function createEventLoopStallMetrics(resetAt = Date.now()): EventLoopStallMetrics {
  return {
    resetAt,
    totalSamples: 0,
    stallCount: 0,
    maxDriftMs: 0,
    over100Ms: 0,
    over250Ms: 0,
    over500Ms: 0,
    over1000Ms: 0,
    over3000Ms: 0,
    over6000Ms: 0,
    lastStallAt: null,
    recentStalls: []
  }
}

function cloneEventLoopStallMetrics(metrics: EventLoopStallMetrics): EventLoopStallMetrics {
  return {
    ...metrics,
    recentStalls: metrics.recentStalls.map((entry) => ({ ...entry }))
  }
}

function normalizeTraceValue(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined) return value ?? null
  if (typeof value === 'string') {
    return value.length > MAX_STRING_LENGTH
      ? `${value.slice(0, MAX_STRING_LENGTH)}...[truncated:${value.length}]`
      : value
  }
  if (typeof value === 'number' || typeof value === 'boolean') return value
  if (typeof value === 'bigint') return value.toString()
  if (typeof value === 'function' || typeof value === 'symbol') return String(value)
  if (value instanceof Error) {
    return {
      name: value.name,
      message: value.message,
      stack: value.stack?.slice(0, MAX_STRING_LENGTH) ?? null
    }
  }
  if (depth >= MAX_OBJECT_DEPTH) return '[MaxDepth]'
  if (Array.isArray(value)) {
    return value.slice(0, MAX_ARRAY_ITEMS).map((item) => normalizeTraceValue(item, depth + 1))
  }
  if (typeof value === 'object') {
    const result: Record<string, unknown> = {}
    for (const [key, nestedValue] of Object.entries(value as Record<string, unknown>).slice(0, MAX_OBJECT_KEYS)) {
      result[key] = normalizeTraceValue(nestedValue, depth + 1)
    }
    return result
  }
  return String(value)
}

function safeNormalize(value: unknown): unknown {
  try {
    return normalizeTraceValue(value)
  } catch (error) {
    return { serializationError: String(error) }
  }
}

/**
 * Decide the Chrome trace "phase" (`ph`) for an event passed to
 * `record(name, data, source?)` based on the event name and payload.
 * Explicit rules first; anything unknown falls through to a safe
 * `ph:'i'` instant event.
 */
function resolvePhase(event: string, data: TracePayload): { ph: 'X' | 'i' | 'M'; dur?: number; scope?: string } {
  if (event === PERF_TRACE_EVENT.MAIN_TRACE_START) {
    return { ph: 'i', scope: 'g' }
  }
  if (
    event === PERF_TRACE_EVENT.MAIN_EVENT_LOOP_STALL ||
    event === PERF_TRACE_EVENT.RENDERER_EVENT_LOOP_STALL ||
    event === PERF_TRACE_EVENT.RENDERER_FRAME_STALL
  ) {
    const driftMs = Number((data as Record<string, unknown> | undefined)?.driftMs
      ?? (data as Record<string, unknown> | undefined)?.frameDeltaMs)
    if (Number.isFinite(driftMs) && driftMs > 0) {
      return { ph: 'X', dur: Math.round(driftMs * 1000) }
    }
    return { ph: 'i', scope: 't' }
  }
  if (event === PERF_TRACE_EVENT.RENDERER_LONGTASK) {
    const durationMs = Number((data as Record<string, unknown> | undefined)?.durationMs)
    if (Number.isFinite(durationMs) && durationMs > 0) {
      return { ph: 'X', dur: Math.round(durationMs * 1000) }
    }
    return { ph: 'i', scope: 't' }
  }
  if (event === PERF_TRACE_EVENT.RENDERER_PROMPT_INPUT_PAINT) {
    const totalMs = Number((data as Record<string, unknown> | undefined)?.eventToPaintMs)
    if (Number.isFinite(totalMs) && totalMs > 0) {
      return { ph: 'X', dur: Math.round(totalMs * 1000) }
    }
    return { ph: 'i', scope: 't' }
  }
  // Convention: any event carrying `elapsedMs`, `durationMs`, or
  // `workerDurationMs` in its payload is a completed span. We route
  // them to `ph:'X'` so Perfetto SQL's `slice.dur` column is usable for
  // percentile / aggregate queries (see infra/trace.md §5.4). This
  // catches the `main:*-worker-latency` family, `main:app-state-save`,
  // and any future slice-shaped events without requiring each emitter
  // to think about Chrome Trace Event Format phases.
  const d = data as Record<string, unknown> | undefined
  const inferredMs = Number(d?.elapsedMs ?? d?.durationMs ?? d?.workerDurationMs)
  if (Number.isFinite(inferredMs) && inferredMs > 0) {
    return { ph: 'X', dur: Math.round(inferredMs * 1000) }
  }
  return { ph: 'i', scope: 't' }
}

/**
 * Type guard for the worker→main trace forwarding envelope. Worker-
 * client `worker.on('message')` handlers should call this first so the
 * bridge is uniform across all workers (matches
 * `electron/main/ripgrep-search.ts::handleWorkerEvent`).
 */
export function isPerfTraceWorkerEvent(message: unknown): message is PerfTraceWorkerEvent {
  return typeof message === 'object'
    && message !== null
    && (message as { event?: unknown }).event === 'trace'
    && typeof (message as { name?: unknown }).name === 'string'
}

/**
 * Replay a worker's forwarded trace event on the main-side
 * `performanceTrace`. `defaultSource` lets each worker-client tag with
 * its own stable tid + threadName so the per-worker thread track in
 * Perfetto stays coherent even when the worker itself didn't set
 * `source`.
 */
export function replayPerfTraceWorkerEvent(
  envelope: PerfTraceWorkerEvent,
  defaultSource?: RecordSource
): void {
  const merged: RecordSource | undefined = envelope.source
    ? { ...defaultSource, ...envelope.source }
    : defaultSource
  performanceTrace.record(envelope.name, envelope.data as TracePayload, merged)
}

// ---------- Class ----------

class PerformanceTrace {
  // Default-on: trace store always captures unless ONWARD_PERF_TRACE=0.
  readonly enabled = TRACE_STORE_ENABLED && isMainThread
  // Sensitive-content capture stays opt-in. When disabled, free-text
  // payloads still get summarized (length, line count, salted hash) so
  // operators can correlate magnitudes without seeing the bytes.
  readonly captureContent = this.enabled && process.env.ONWARD_PERF_TRACE_CAPTURE_CONTENT === '1'

  private initialized = false
  // Counter of accepted events. Replaces the legacy in-memory ring's
  // `events.length`; surfaced via `getStatus()` so PT-08 / external
  // diagnostics keep working after the move to NDJSON chunks.
  private acceptedEvents = 0
  private droppedEvents = 0
  private flowCounter = 0
  private taskThreadCounter = 0
  private readonly salt = randomBytes(16).toString('hex')

  // Per-Task tid assignment for record(). Key = `${side}:${terminalId}`
  // so main / renderer lanes have independent auto-incrementing ranges.
  private taskTids = new Map<string, number>()
  private nextMainTaskTid = MAIN_TASK_TID_BASE
  private nextRendererTaskTid = RENDERER_TASK_TID_BASE
  private rendererThreadNamesEmitted = new Set<number>()
  private namedNonRendererTids = new Set<string>()

  // markTask* state machine on pid=3.
  private taskThreadIds = new Map<string, number>()
  private taskActivities = new Map<string, TaskActivity>()

  // Event-loop / git-runtime monitors.
  private eventLoopTimer: ReturnType<typeof setInterval> | null = null
  private gitRuntimeTimer: ReturnType<typeof setInterval> | null = null
  private eventLoopMetrics: EventLoopStallMetrics = createEventLoopStallMetrics()

  isEnabled(): boolean {
    return this.enabled
  }

  /**
   * Initialize the trace pipeline. Idempotent. `start()` is an alias
   * for compatibility with the legacy `performanceTrace.start()` API.
   */
  initialize(): void {
    if (!this.enabled || this.initialized) return
    this.initialized = true

    // The shared trace-store is also idempotent; both this module and
    // any other entry point can call initialize().
    traceStore.initialize()

    if (this.captureContent) {
      console.log('[PerfTrace] Sensitive content capture active (ONWARD_PERF_TRACE_CAPTURE_CONTENT=1)')
    }

    // Process / thread metadata for the canonical Perfetto rows.
    this.recordMetadata(MAIN_PID, MAIN_TID, 'process_name', 'Onward main')
    this.recordMetadata(MAIN_PID, MAIN_TID, 'process_sort_index', 1)
    this.recordMetadata(MAIN_PID, MAIN_TID, 'thread_name', 'main')
    this.recordMetadata(RENDERER_PID, 0, 'process_name', 'Onward renderer')
    this.recordMetadata(RENDERER_PID, 0, 'process_sort_index', 2)
    this.recordMetadata(TASK_PID, 0, 'process_name', 'Onward Tasks')

    const appInfo = loadAppInfo()
    const dir = traceStore.getDir()
    const kind = traceStore.getRootKind()
    console.log(`[PerfTrace] enabled format=ndjson-chunked dir=${dir} (${kind})`)

    // Register signal handlers so SIGTERM / SIGINT (tests, CI, Ctrl-C)
    // still flush the trace store. The class is a singleton so these
    // handlers attach at most once; Electron `app.on('will-quit')`
    // still covers graceful menu-quit paths. Exit sequencing is NOT this
    // module's job: in the Electron main process the lifecycle signal
    // handlers (electron/main/index.ts) drive the bounded graceful quit,
    // while worker processes must RE-RAISE so the default termination still
    // happens — a flush-only `once` handler used to swallow the signal.
    const electronApp = loadElectronApp()
    const shutdown = () => {
      try { this.stop() } catch { /* already closing */ }
    }
    const onTerminationSignal = (signal: NodeJS.Signals) => {
      shutdown()
      if (shouldReRaiseSignalAfterTraceFlush(Boolean(electronApp))) {
        process.kill(process.pid, signal)
      }
    }
    process.once('SIGTERM', () => onTerminationSignal('SIGTERM'))
    process.once('SIGINT', () => onTerminationSignal('SIGINT'))
    if (electronApp) {
      try { electronApp.once('will-quit', shutdown) } catch { /* lifecycle missing */ }
      try { electronApp.once('before-quit', shutdown) } catch { /* lifecycle missing */ }
    }

    // Record the first real event after the metadata.
    const appVersion = electronApp
      ? (() => { try { return electronApp.getVersion() } catch { return 'unknown' } })()
      : 'worker'
    this.record(PERF_TRACE_EVENT.MAIN_TRACE_START, {
      schema: 'onward.perf_trace.v2',
      logDir: dir,
      pid: process.pid,
      platform: process.platform,
      appVersion,
      buildChannel: appInfo?.buildChannel ?? 'unknown',
      contentCaptured: this.captureContent,
      transport: 'trace-store-ndjson'
    })
  }

  /** Alias for `initialize()` so legacy `performanceTrace.start()` callers compile. */
  start(): void {
    this.initialize()
  }

  /** Idempotent shutdown. Closes the trace-store via the will-quit hook in main/index.ts. */
  stop(): void {
    if (this.eventLoopTimer) {
      clearInterval(this.eventLoopTimer)
      this.eventLoopTimer = null
    }
    if (this.gitRuntimeTimer) {
      clearInterval(this.gitRuntimeTimer)
      this.gitRuntimeTimer = null
    }
    if (this.initialized && isMainThread) {
      this.record(PERF_TRACE_EVENT.MAIN_TRACE_STOP)
    }
    this.initialized = false
  }

  getInfo(): PerfTraceInfo {
    if (this.enabled) this.start()
    const dir = traceStore.getDir()
    return {
      enabled: this.enabled,
      logPath: traceStore.getCurrentChunkPath(),
      latestPointerPath: dir ? `${dir}/latest.txt` : null,
      eventLoop: this.getEventLoopMetrics()
    }
  }

  getStatus(): Record<string, string | number | boolean | null> {
    return {
      enabled: this.enabled,
      captureContent: this.captureContent,
      initialized: this.initialized,
      filePath: traceStore.getCurrentChunkPath(),
      eventCount: this.acceptedEvents,
      droppedEvents: this.droppedEvents,
      // Of `droppedEvents`, how many were EXPECTED rate-limit decimation (a
      // high-frequency event exceeding the per-name 100/sec cap). The remainder
      // (droppedEvents - rateLimitedDropped) is genuine store-failure loss.
      rateLimitedDropped: traceStore.getRateLimitedDropped()
    }
  }

  resetEventLoopMetrics(): EventLoopStallMetrics {
    this.eventLoopMetrics = createEventLoopStallMetrics()
    this.record(PERF_TRACE_EVENT.MAIN_EVENT_LOOP_METRICS_RESET, {
      resetAt: this.eventLoopMetrics.resetAt
    })
    return this.getEventLoopMetrics()
  }

  getEventLoopMetrics(): EventLoopStallMetrics {
    return cloneEventLoopStallMetrics(this.eventLoopMetrics)
  }

  // ---------- record() — generic emit, perf-trace-logger lineage ----------

  /**
   * Record a generic trace event. Routes through the shared `traceStore`
   * after applying phase resolution (`ph='X'` slice vs `ph='i'` instant)
   * and tid routing.
   *
   * Worker thread context: the call is forwarded via `parentPort.postMessage`
   * as a `PerfTraceWorkerEvent` envelope; the main-side worker-client
   * replays it through `replayPerfTraceWorkerEvent`. The worker itself
   * never writes disk — every event lands in the single main store with
   * a consistent thread track.
   *
   * `source` lets IPC bridges tag renderer- or worker-forwarded events
   * so they appear on a dedicated thread row in Perfetto UI.
   */
  record(event: string, data?: TracePayload, source?: RecordSource): void {
    if (!this.enabled && isMainThread) return
    if (!isMainThread) {
      // Worker context: forward via parentPort. main writes the actual
      // trace event. See replayPerfTraceWorkerEvent + worker-client
      // dispatcher in electron/main/*-worker-client.ts.
      try {
        const envelope: PerfTraceWorkerEvent = { event: 'trace', name: event }
        if (data && typeof data === 'object') {
          envelope.data = data as Record<string, unknown>
        }
        if (source) envelope.source = source
        parentPort?.postMessage(envelope)
      } catch {
        // postMessage can throw when the worker is being torn down; safe to drop.
      }
      return
    }
    this.start()

    const isRenderer = source?.process === 'renderer'
    const pid = isRenderer ? RENDERER_PID : MAIN_PID
    let tid: number
    if (source?.terminalId) {
      tid = this.assignTaskTid(source.terminalId, isRenderer ? 'renderer' : 'main')
    } else if (isRenderer) {
      tid = source?.tid ?? 0
      if (tid > 0 && !this.rendererThreadNamesEmitted.has(tid)) {
        this.rendererThreadNamesEmitted.add(tid)
        this.writeStoreEvent({
          ph: 'M', name: 'thread_name', pid, tid,
          args: { name: `renderer#${tid}` }
        })
      }
    } else {
      // Main process — either the canonical tid=1 lane, or a worker's
      // dedicated WORKER_TID lane (forwarded from a worker-client). For
      // the worker case, emit a thread_name metadata packet on first
      // sight so Perfetto UI labels the row instead of just an integer.
      tid = source?.tid ?? MAIN_TID
      if (source?.threadName && tid !== MAIN_TID) {
        const key = `${pid}:${tid}`
        if (!this.namedNonRendererTids.has(key)) {
          this.namedNonRendererTids.add(key)
          this.writeStoreEvent({
            ph: 'M', name: 'thread_name', pid, tid,
            args: { name: source.threadName }
          })
        }
      }
    }

    const phase = resolvePhase(event, data)
    const tsUs = Date.now() * 1000
    const args = safeNormalize(data) as Record<string, unknown> | undefined
    const entry: TraceStoreEvent = {
      ph: phase.ph,
      name: event,
      ts: tsUs,
      pid,
      tid
    }
    if (phase.dur !== undefined) entry.dur = phase.dur
    if (phase.scope) entry.s = phase.scope
    if (args && Object.keys(args).length > 0) entry.args = args
    this.writeStoreEvent(entry)
  }

  private assignTaskTid(terminalId: string, side: 'main' | 'renderer'): number {
    const key = `${side}:${terminalId}`
    const existing = this.taskTids.get(key)
    if (existing !== undefined) return existing

    const tid = side === 'main' ? this.nextMainTaskTid++ : this.nextRendererTaskTid++
    this.taskTids.set(key, tid)

    const pid = side === 'main' ? MAIN_PID : RENDERER_PID
    const shortId = terminalId.length > 8 ? terminalId.slice(0, 8) : terminalId
    this.writeStoreEvent({
      ph: 'M', name: 'thread_name', pid, tid,
      args: { name: `task-${shortId}${side === 'renderer' ? '-rnd' : ''}` }
    })
    return tid
  }

  // ---------- Performance-trace lineage helpers (PII-safe path) ----------

  nowUs(): number {
    // Wall-anchored on purpose. The previous
    // `performance.timeOrigin + performance.now()` sum drifts from
    // Date.now() on long uptimes (measured 5.011 s after ~4.2 days),
    // splitting every recordComplete()/timeAsync() span away from the
    // record() events of the same operation. See trace-clock.ts.
    return wallNowUs()
  }

  createFlowId(prefix = 'flow'): string {
    this.flowCounter += 1
    return `${prefix}-${Date.now().toString(36)}-${this.flowCounter.toString(36)}`
  }

  /**
   * Summarize a free-text payload (PTY input, model output, file body)
   * for safe inclusion in a trace event. Always emits length, line
   * count, and a salted hash; only emits the actual bytes (truncated)
   * when `captureContent` is enabled.
   */
  summarizeText(prefix: string, value: string): TraceArgs {
    const normalizedPrefix = prefix || 'payload'
    const summary: TraceArgs = {
      [`${normalizedPrefix}Length`]: value.length,
      [`${normalizedPrefix}LineCount`]: value.length === 0 ? 0 : value.split(/\r\n|\r|\n/).length,
      [`${normalizedPrefix}Hash`]: this.hashText(value)
    }
    if (this.captureContent) {
      summary[`${normalizedPrefix}Preview`] = this.truncateString(value)
      summary.contentCaptured = true
    }
    return summary
  }

  recordRendererEvent(event: RendererTraceEvent): void {
    if (!this.enabled || !event || typeof event.name !== 'string') return
    this.writeNamedEvent({
      name: event.name,
      cat: event.cat ?? 'renderer',
      ph: event.ph ?? 'i',
      ts: typeof event.ts === 'number' ? Math.round(event.ts) : this.nowUs(),
      dur: typeof event.dur === 'number' ? Math.max(0, Math.round(event.dur)) : undefined,
      pid: RENDERER_PID,
      tid: typeof event.tid === 'number' ? event.tid : RENDERER_THREAD_ID,
      id: typeof event.id === 'string' ? event.id : undefined,
      s: event.scope,
      args: this.sanitizeArgs(event.args)
    })
  }

  recordInstant(name: string, args?: TraceArgs, cat = 'main'): void {
    if (!this.enabled) return
    this.writeNamedEvent({
      name, cat, ph: 'i', ts: this.nowUs(),
      pid: MAIN_PID, tid: MAIN_TID,
      args: this.sanitizeArgs(args)
    })
  }

  recordCounter(name: string, args?: TraceArgs, cat = 'counter'): void {
    if (!this.enabled) return
    this.writeNamedEvent({
      name, cat, ph: 'C', ts: this.nowUs(),
      pid: MAIN_PID, tid: MAIN_TID,
      args: this.sanitizeArgs(args)
    })
  }

  recordComplete(name: string, startUs: number, args?: TraceArgs, cat = 'main'): void {
    if (!this.enabled) return
    const now = this.nowUs()
    this.writeNamedEvent({
      name, cat, ph: 'X', ts: startUs, dur: Math.max(0, now - startUs),
      pid: MAIN_PID, tid: MAIN_TID,
      args: this.sanitizeArgs(args)
    })
  }

  timeSync<T>(name: string, args: TraceArgs | undefined, fn: () => T, cat = 'main'): T {
    if (!this.enabled) return fn()
    const startUs = this.nowUs()
    try {
      const result = fn()
      this.recordComplete(name, startUs, { ...args, result: 'success' }, cat)
      return result
    } catch (error) {
      this.recordComplete(name, startUs, { ...args, result: 'error', errorType: this.errorType(error) }, cat)
      throw error
    }
  }

  async timeAsync<T>(name: string, args: TraceArgs | undefined, fn: () => Promise<T>, cat = 'main'): Promise<T> {
    if (!this.enabled) return await fn()
    const startUs = this.nowUs()
    try {
      const result = await fn()
      this.recordComplete(name, startUs, { ...args, result: 'success' }, cat)
      return result
    } catch (error) {
      this.recordComplete(name, startUs, { ...args, result: 'error', errorType: this.errorType(error) }, cat)
      throw error
    }
  }

  recordFlowStart(name: string, flowId: string, args?: TraceArgs, cat = 'flow'): void {
    this.recordFlow(name, 's', flowId, args, cat)
  }

  recordFlowStep(name: string, flowId: string, args?: TraceArgs, cat = 'flow'): void {
    this.recordFlow(name, 't', flowId, args, cat)
  }

  recordFlowEnd(name: string, flowId: string, args?: TraceArgs, cat = 'flow'): void {
    this.recordFlow(name, 'f', flowId, args, cat)
  }

  markTaskInput(terminalId: string, flowId?: string | null, args?: TraceArgs): void {
    this.setTaskState(terminalId, 'input_pending', flowId ?? null, args)
  }

  markTaskRunning(terminalId: string, flowId?: string | null, args?: TraceArgs): void {
    this.setTaskState(terminalId, 'running', flowId ?? null, args)
  }

  markTaskOutput(terminalId: string, bytes: number): void {
    const current = this.taskActivities.get(terminalId)
    this.setTaskState(terminalId, 'output_active', current?.flowId ?? null, { bytes })
    this.scheduleTaskIdle(terminalId)
  }

  markTaskExited(terminalId: string, exitCode?: number, signal?: number): void {
    const current = this.taskActivities.get(terminalId)
    this.setTaskState(terminalId, 'exited', current?.flowId ?? null, { exitCode, signal })
  }

  markTaskIdle(terminalId: string, reason: string): void {
    const current = this.taskActivities.get(terminalId)
    this.setTaskState(terminalId, 'idle', current?.flowId ?? null, { reason })
  }

  getTaskFlowId(terminalId: string): string | null {
    return this.taskActivities.get(terminalId)?.flowId ?? null
  }

  /**
   * Legacy flush API. The trace-store is append-only and writes to disk
   * synchronously, so there is nothing to flush — kept as a no-op so any
   * existing caller (`requestQuit`, IPC handlers, tests) keeps compiling.
   */
  flush(reason = 'manual'): Record<string, string | number | boolean | null> {
    if (!this.enabled) return this.getStatus()
    this.recordInstant('trace.session.flush', { reason }, 'trace')
    return this.getStatus()
  }

  // ---------- Event-loop / git-runtime monitors ----------

  startEventLoopMonitor(): void {
    if (!this.enabled || this.eventLoopTimer) return
    this.start()
    const intervalMs = 250
    const stallThresholdMs = 100
    let expectedAt = Date.now() + intervalMs

    this.eventLoopTimer = setInterval(() => {
      const now = Date.now()
      const driftMs = now - expectedAt
      expectedAt = now + intervalMs
      this.eventLoopMetrics.totalSamples += 1
      if (driftMs >= stallThresholdMs) {
        this.recordEventLoopStall(now, driftMs)
        this.record(PERF_TRACE_EVENT.MAIN_EVENT_LOOP_STALL, {
          driftMs, intervalMs, stallThresholdMs
        })
      }
    }, intervalMs)
    this.eventLoopTimer.unref?.()
  }

  startGitRuntimeMonitor(getMetrics: () => unknown): void {
    if (!this.enabled || this.gitRuntimeTimer) return
    this.start()
    this.gitRuntimeTimer = setInterval(() => {
      try {
        this.record(PERF_TRACE_EVENT.MAIN_GIT_RUNTIME_SUMMARY, getMetrics() as TracePayload)
      } catch (error) {
        this.record(PERF_TRACE_EVENT.MAIN_GIT_RUNTIME_SUMMARY_ERROR, { error: String(error) })
      }
    }, 1000)
    this.gitRuntimeTimer.unref?.()
  }

  // ---------- Internal write paths ----------

  /**
   * Forward a Chrome-trace-format event into the shared store. Used by
   * `record()` (the perf-trace-logger lineage path — already
   * length-truncated via `safeNormalize`).
   */
  private writeStoreEvent(entry: TraceStoreEvent): void {
    const accepted = traceStore.writeEvent(entry)
    if (!accepted) this.droppedEvents += 1
  }

  /**
   * Forward a higher-level event from the recordX / recordFlow / markTask
   * lineage. Same store path; separate signature so the strict-redaction
   * lineage stays type-safe (TraceArgValue) rather than the looser
   * `unknown` of the perf-trace-logger lineage.
   */
  private writeNamedEvent(event: {
    name: string
    ph: TracePhase
    pid: number
    tid: number
    ts?: number
    dur?: number
    cat?: string
    id?: string
    s?: TraceScope
    args?: Record<string, TraceArgValue> | undefined
  }): void {
    if (!this.enabled) return
    const storeEvent: TraceStoreEvent = {
      ph: event.ph, name: event.name, pid: event.pid, tid: event.tid
    }
    if (event.ts !== undefined) storeEvent.ts = event.ts
    if (event.dur !== undefined) storeEvent.dur = event.dur
    if (event.cat) storeEvent.cat = event.cat
    if (event.id) storeEvent.id = event.id
    if (event.s) storeEvent.s = event.s
    if (event.args) storeEvent.args = event.args as Record<string, unknown>
    const accepted = traceStore.writeEvent(storeEvent)
    if (accepted) this.acceptedEvents += 1
    else this.droppedEvents += 1
  }

  private recordFlow(name: string, ph: 's' | 't' | 'f', flowId: string, args?: TraceArgs, cat = 'flow'): void {
    if (!this.enabled || !flowId) return
    this.writeNamedEvent({
      name, cat, ph, ts: this.nowUs(),
      pid: MAIN_PID, tid: MAIN_TID, id: flowId, s: 'g',
      args: this.sanitizeArgs(args)
    })
  }

  private setTaskState(terminalId: string, state: TraceTaskState, flowId: string | null, args?: TraceArgs): void {
    if (!this.enabled || !terminalId) return
    const current = this.taskActivities.get(terminalId)
    if (current?.idleTimer) {
      clearTimeout(current.idleTimer)
      current.idleTimer = null
    }
    const nextFlowId = flowId ?? current?.flowId ?? null
    const threadId = this.getTaskThreadId(terminalId)
    this.taskActivities.set(terminalId, { state, flowId: nextFlowId, idleTimer: null })
    this.writeNamedEvent({
      name: 'terminal.task.state',
      cat: 'task', ph: 'i', ts: this.nowUs(),
      pid: TASK_PID, tid: threadId,
      args: this.sanitizeArgs({
        terminalId, state,
        flowId: nextFlowId ?? undefined,
        ...args
      })
    })
  }

  private scheduleTaskIdle(terminalId: string): void {
    const current = this.taskActivities.get(terminalId)
    if (!current) return
    current.idleTimer = setTimeout(() => {
      this.markTaskIdle(terminalId, 'output-idle-timeout')
    }, TASK_IDLE_DELAY_MS)
  }

  private getTaskThreadId(terminalId: string): number {
    const existing = this.taskThreadIds.get(terminalId)
    if (existing !== undefined) return existing
    this.taskThreadCounter += 1
    const threadId = this.taskThreadCounter
    this.taskThreadIds.set(terminalId, threadId)
    this.recordMetadata(TASK_PID, threadId, 'thread_name', `task:${terminalId}`)
    return threadId
  }

  private recordMetadata(pid: number, tid: number, name: string, value: string | number): void {
    this.writeStoreEvent({
      ph: 'M', name, pid, tid,
      args: { [typeof value === 'number' ? 'sort_index' : 'name']: value }
    })
  }

  private recordEventLoopStall(ts: number, driftMs: number): void {
    const metrics = this.eventLoopMetrics
    metrics.stallCount += 1
    metrics.maxDriftMs = Math.max(metrics.maxDriftMs, driftMs)
    metrics.lastStallAt = ts
    if (driftMs >= 100) metrics.over100Ms += 1
    if (driftMs >= 250) metrics.over250Ms += 1
    if (driftMs >= 500) metrics.over500Ms += 1
    if (driftMs >= 1000) metrics.over1000Ms += 1
    if (driftMs >= 3000) metrics.over3000Ms += 1
    if (driftMs >= 6000) metrics.over6000Ms += 1
    metrics.recentStalls.push({ ts, driftMs: Math.round(driftMs) })
    if (metrics.recentStalls.length > MAX_RECENT_EVENT_LOOP_STALLS) {
      metrics.recentStalls.splice(0, metrics.recentStalls.length - MAX_RECENT_EVENT_LOOP_STALLS)
    }
  }

  // ---------- Sanitization (strict-redaction lineage) ----------

  private sanitizeArgs(args?: TraceArgs): Record<string, TraceArgValue> | undefined {
    if (!args) return undefined
    const result: Record<string, TraceArgValue> = {}
    for (const [key, rawValue] of Object.entries(args)) {
      if (rawValue === undefined) continue
      const sanitized = this.sanitizeValue(key, rawValue)
      if (sanitized !== undefined) result[key] = sanitized
    }
    return Object.keys(result).length > 0 ? result : undefined
  }

  private sanitizeValue(key: string, value: TraceArgValue): TraceArgValue | undefined {
    if (value === null || typeof value === 'number' || typeof value === 'boolean') {
      return value
    }
    if (typeof value === 'string') {
      if (this.isSensitiveKey(key) && !this.captureContent) return undefined
      return this.truncateString(value)
    }
    if (Array.isArray(value)) {
      const values = value.slice(0, MAX_CAPTURED_ARRAY_LENGTH)
      if (values.every(item => typeof item === 'string')) {
        if (this.isSensitiveKey(key) && !this.captureContent) return undefined
        return values.map(item => this.truncateString(item)) as string[]
      }
      if (values.every(item => typeof item === 'number')) return values as number[]
      if (values.every(item => typeof item === 'boolean')) return values as boolean[]
    }
    return undefined
  }

  private isSensitiveKey(key: string): boolean {
    if (ALLOWED_STRING_KEYS.has(key)) return false
    return SENSITIVE_KEY_RE.test(key)
  }

  private truncateString(value: string): string {
    if (value.length <= MAX_CAPTURED_STRING_LENGTH) return value
    return `${value.slice(0, MAX_CAPTURED_STRING_LENGTH)}...`
  }

  private hashText(value: string): string {
    return createHash('sha256').update(this.salt).update(value).digest('hex').slice(0, 16)
  }

  private errorType(error: unknown): string {
    if (error instanceof Error) return error.name || 'Error'
    return typeof error
  }
}

export const performanceTrace = new PerformanceTrace()
