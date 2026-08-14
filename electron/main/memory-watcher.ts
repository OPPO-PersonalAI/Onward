/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * MemoryWatcher — Tier 1/2/3 orchestrator of the memory diagnostics closed
 * loop (design: docs/html/memory-diagnostics-closed-loop-design.html).
 *
 * Tier 1: cheap sampling every ONWARD_MEM_WATCH_INTERVAL_SEC (default 30 s):
 *   app.getAppMetrics() (all Electron processes) + main v8 heap statistics
 *   + renderer preload self-reports (ingestRendererSample). Emitted on the
 *   default-on diagnostic trace channel so every user bundle carries the
 *   memory time series. Workers self-report independently
 *   (worker-memory-sampler.ts) because they share the main pid.
 *
 * Tier 2: pure detector (memory-pressure-detector.ts) over a ring buffer of
 *   renderer samples; edge-triggered pressure breadcrumbs; Discord-style
 *   prompt guards (uptime floor, session cap, cooldown).
 *
 * Tier 3: lightweight memory-report JSONL (auto, no PII) + consent-gated
 *   heap snapshots with OOM-spiral guards (single-flight, headroom check,
 *   oldest-eviction). Full snapshots are NEVER captured automatically.
 */

import { app, type BrowserWindow } from 'electron'
import { getHeapStatistics } from 'v8'
import { existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'fs'
import { join } from 'path'

import { performanceTrace } from './performance-trace'
import { traceStore } from './trace-store'
import { IPC } from '../shared/ipc-channels'
import { PERF_TRACE_EVENT } from '../../src/utils/perf-trace-names'
import {
  bytesToKb,
  toFiniteKb,
  evaluateMemoryPressure,
  shouldPromptUser,
  hasSnapshotHeadroom,
  DEFAULT_MEMORY_PRESSURE_CONFIG,
  type MemoryPressureConfig,
  type MemoryPressureVerdict,
  type RendererMemorySample
} from './memory-pressure-detector'

// ---------- Env configuration (read once at startup, per debug-env rules) ----------

export const MEM_WATCH_ENABLED = process.env.ONWARD_MEM_WATCH !== '0'

function envNumber(name: string, fallback: number, min: number): number {
  const raw = Number(process.env[name])
  if (!Number.isFinite(raw) || raw < min) return fallback
  return raw
}

const INTERVAL_MS = Math.round(envNumber('ONWARD_MEM_WATCH_INTERVAL_SEC', 30, 1) * 1000)

function configFromEnv(): MemoryPressureConfig {
  return {
    ...DEFAULT_MEMORY_PRESSURE_CONFIG,
    footprintWarnKb: Math.round(envNumber('ONWARD_MEM_WATCH_FOOTPRINT_MB', 1536, 64) * 1024),
    heapRatioWarn: envNumber('ONWARD_MEM_WATCH_HEAP_RATIO', 0.6, 0.05),
    windowMs: Math.round(envNumber('ONWARD_MEM_WATCH_WINDOW_SEC', 120, 5) * 1000),
    minUptimeMs: Math.round(envNumber('ONWARD_MEM_WATCH_MIN_UPTIME_SEC', 300, 0) * 1000),
    promptCooldownMs: Math.round(envNumber('ONWARD_MEM_WATCH_COOLDOWN_SEC', 1800, 0) * 1000),
    maxPromptsPerSession: Math.round(envNumber('ONWARD_MEM_WATCH_MAX_PROMPTS', 1, 0))
  }
}

// Ring capacity: keep well beyond the detection window so the memory report
// carries context before the threshold crossing (64 × 30 s ≈ 32 min).
const RING_CAPACITY = 64
const RENDERER_REPORT_STALE_MS_FACTOR = 2.5
const MAX_MEMORY_REPORT_FILES = 5
const MAX_HEAP_SNAPSHOT_FILES = 4

export interface MemoryPressureAlertPayload {
  level: 'warn' | 'critical'
  reason: string
  footprintMb: number | null
  heapRatioPct: number | null
}

export interface RendererMemoryReport {
  atMs: number
  heapUsedKb: number | null
  heapTotalKb: number | null
  heapLimitKb: number | null
  blinkAllocatedKb: number | null
  blinkTotalKb: number | null
  resourceCacheKb: number | null
  resourceCacheLiveKb: number | null
  resourceImageKb: number | null
  resourceScriptKb: number | null
  resourceCssKb: number | null
  resourceFontKb: number | null
}

export interface HeapSnapshotFileInfo {
  target: 'renderer' | 'main'
  path: string
  bytes: number
}

type WindowGetter = () => BrowserWindow | null

class MemoryWatcher {
  readonly enabled = MEM_WATCH_ENABLED

  private timer: ReturnType<typeof setInterval> | null = null
  private getWindow: WindowGetter = () => null
  private readonly config = configFromEnv()
  private readonly startedAtMs = Date.now()
  private samples: RendererMemorySample[] = []
  private rendererReport: RendererMemoryReport | null = null
  private lastVerdict: MemoryPressureVerdict | null = null
  private lastLevel: 'none' | 'warn' | 'critical' = 'none'
  private promptedCount = 0
  private lastPromptAtMs: number | null = null
  private lastPromptSkipReason: string | null = null
  private lastReportPath: string | null = null
  private snapshotInFlight = false
  private lastSnapshots: HeapSnapshotFileInfo[] = []

  start(getWindow: WindowGetter): void {
    if (!this.enabled) {
      console.log('[MemoryWatcher] disabled (ONWARD_MEM_WATCH=0)')
      return
    }
    if (this.timer) return
    this.getWindow = getWindow
    console.log(`[MemoryWatcher] active interval=${INTERVAL_MS}ms footprintWarnKb=${this.config.footprintWarnKb} heapRatioWarn=${this.config.heapRatioWarn}`)
    this.timer = setInterval(() => this.tick(), INTERVAL_MS)
    // First sample early so short sessions still carry one datapoint.
    setTimeout(() => this.tick(), Math.min(INTERVAL_MS, 5000))
    try {
      app.once('before-quit', () => this.stop())
    } catch {
      // App lifecycle unavailable (tests); the interval dies with the process.
    }
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
  }

  /** Renderer preload self-report (memory:renderer-sample). All fields KB. */
  ingestRendererSample(senderId: number, raw: unknown): void {
    if (!this.enabled || !raw || typeof raw !== 'object') return
    const r = raw as Record<string, unknown>
    const report: RendererMemoryReport = {
      atMs: Date.now(),
      heapUsedKb: toFiniteKb(r.heapUsedKb),
      heapTotalKb: toFiniteKb(r.heapTotalKb),
      heapLimitKb: toFiniteKb(r.heapLimitKb),
      blinkAllocatedKb: toFiniteKb(r.blinkAllocatedKb),
      blinkTotalKb: toFiniteKb(r.blinkTotalKb),
      resourceCacheKb: toFiniteKb(r.resourceCacheKb),
      resourceCacheLiveKb: toFiniteKb(r.resourceCacheLiveKb),
      resourceImageKb: toFiniteKb(r.resourceImageKb),
      resourceScriptKb: toFiniteKb(r.resourceScriptKb),
      resourceCssKb: toFiniteKb(r.resourceCssKb),
      resourceFontKb: toFiniteKb(r.resourceFontKb)
    }
    this.rendererReport = report
    performanceTrace.record(
      PERF_TRACE_EVENT.RENDERER_MEM_WATCH_SAMPLE,
      { ...report },
      { process: 'renderer', tid: senderId }
    )
  }

  /**
   * Autotest-only synthetic sample injection (debug:memory-inject-sample,
   * gated on ONWARD_AUTOTEST=1 at the IPC layer). Runs the same detection
   * tail as a real tick so the closed loop is exercised end-to-end.
   */
  injectSyntheticSample(raw: unknown): { accepted: boolean } {
    if (!this.enabled || !raw || typeof raw !== 'object') return { accepted: false }
    const r = raw as Record<string, unknown>
    const sample: RendererMemorySample = {
      atMs: Date.now(),
      workingSetKb: toFiniteKb(r.workingSetKb),
      heapUsedKb: toFiniteKb(r.heapUsedKb),
      heapLimitKb: toFiniteKb(r.heapLimitKb)
    }
    this.pushSample(sample)
    this.evaluateAndAct(Date.now())
    return { accepted: true }
  }

  getStateForDebug(): Record<string, unknown> {
    return {
      enabled: this.enabled,
      intervalMs: INTERVAL_MS,
      config: { ...this.config },
      sampleCount: this.samples.length,
      lastVerdict: this.lastVerdict ? { ...this.lastVerdict } : null,
      promptedCount: this.promptedCount,
      lastReportPath: this.lastReportPath,
      lastSnapshots: this.lastSnapshots.map((s) => ({ ...s })),
      rendererReportAtMs: this.rendererReport?.atMs ?? null
    }
  }

  // ---------- Tier 1: sampling ----------

  private tick(): void {
    try {
      const nowMs = Date.now()
      const metrics = app.getAppMetrics()
      const mainHeap = getHeapStatistics()
      const mainMem = process.memoryUsage()
      const window = this.getWindow()
      const rendererPid = (() => {
        try {
          return window && !window.isDestroyed() ? window.webContents.getOSProcessId() : null
        } catch {
          return null
        }
      })()

      const processes = metrics.map((m) => ({
        type: m.type,
        pid: m.pid,
        workingSetKb: toFiniteKb(m.memory?.workingSetSize),
        peakWorkingSetKb: toFiniteKb(m.memory?.peakWorkingSetSize),
        cpuPercent: Number.isFinite(m.cpu?.percentCPUUsage) ? Math.round(m.cpu.percentCPUUsage * 10) / 10 : null
      }))

      const rendererMetric = rendererPid !== null ? processes.find((p) => p.pid === rendererPid) : undefined
      const reportFresh =
        this.rendererReport !== null &&
        nowMs - this.rendererReport.atMs <= INTERVAL_MS * RENDERER_REPORT_STALE_MS_FACTOR

      performanceTrace.record(PERF_TRACE_EVENT.MAIN_MEM_WATCH_SAMPLE, {
        schema: 1,
        processes,
        rendererPid,
        mainHeapUsedKb: bytesToKb(mainHeap.used_heap_size),
        mainHeapLimitKb: bytesToKb(mainHeap.heap_size_limit),
        mainRssKb: bytesToKb(mainMem.rss),
        mainExternalKb: bytesToKb(mainMem.external),
        mainDetachedContexts: mainHeap.number_of_detached_contexts
      })

      const kbToMb = (kb: number | null | undefined): number =>
        typeof kb === 'number' ? Math.round(kb / 1024) : 0
      const gpuMetric = processes.find((p) => p.type === 'GPU')
      const mainMetric = processes.find((p) => p.type === 'Browser')
      performanceTrace.recordCounter(PERF_TRACE_EVENT.MAIN_MEM_WATCH_COUNTERS, {
        mainWorkingSetMb: kbToMb(mainMetric?.workingSetKb),
        rendererWorkingSetMb: kbToMb(rendererMetric?.workingSetKb),
        gpuWorkingSetMb: kbToMb(gpuMetric?.workingSetKb),
        mainHeapUsedMb: kbToMb(bytesToKb(mainHeap.used_heap_size)),
        rendererHeapUsedMb: kbToMb(reportFresh ? this.rendererReport?.heapUsedKb : null)
      })

      this.pushSample({
        atMs: nowMs,
        workingSetKb: rendererMetric?.workingSetKb ?? null,
        heapUsedKb: reportFresh ? (this.rendererReport?.heapUsedKb ?? null) : null,
        heapLimitKb: reportFresh ? (this.rendererReport?.heapLimitKb ?? null) : null
      })
      this.evaluateAndAct(nowMs)
    } catch (error) {
      // The watcher must never take the app down; log once per tick at most.
      console.warn('[MemoryWatcher] tick failed:', String(error))
    }
  }

  private pushSample(sample: RendererMemorySample): void {
    this.samples.push(sample)
    if (this.samples.length > RING_CAPACITY) {
      this.samples.splice(0, this.samples.length - RING_CAPACITY)
    }
  }

  // ---------- Tier 2: detection + prompt ----------

  private evaluateAndAct(nowMs: number): void {
    const verdict = evaluateMemoryPressure(this.samples, this.config, nowMs)
    this.lastVerdict = verdict

    if (verdict.level !== this.lastLevel) {
      performanceTrace.record(PERF_TRACE_EVENT.MAIN_MEM_WATCH_PRESSURE_DETECTED, {
        level: verdict.level,
        reason: verdict.reason,
        footprintKb: verdict.footprintKb,
        heapRatioPct: verdict.heapRatio !== null ? Math.round(verdict.heapRatio * 100) : null,
        windowSamples: verdict.windowSamples
      })
      this.lastLevel = verdict.level
    }
    if (verdict.level === 'none') return

    const decision = shouldPromptUser(
      verdict,
      { appStartedAtMs: this.startedAtMs, promptedCount: this.promptedCount, lastPromptAtMs: this.lastPromptAtMs },
      this.config,
      nowMs
    )
    if (!decision.prompt) {
      // Edge-triggered on reason changes: "pressure present but no
      // notification" must be explainable from a user bundle. The
      // 'below-threshold' reason never reaches here (level !== 'none').
      const reason = decision.skipReason ?? 'unknown'
      if (reason !== this.lastPromptSkipReason) {
        this.lastPromptSkipReason = reason
        performanceTrace.record(PERF_TRACE_EVENT.MAIN_MEM_WATCH_PROMPT_SKIPPED, {
          reason,
          level: verdict.level
        })
      }
      return
    }

    this.lastPromptSkipReason = null
    this.promptedCount += 1
    this.lastPromptAtMs = nowMs
    this.writeMemoryReport(`pressure-${verdict.level}`)

    const window = this.getWindow()
    if (window && !window.isDestroyed()) {
      const payload: MemoryPressureAlertPayload = {
        level: verdict.level as 'warn' | 'critical',
        reason: verdict.reason,
        footprintMb: verdict.footprintKb !== null ? Math.round(verdict.footprintKb / 1024) : null,
        heapRatioPct: verdict.heapRatio !== null ? Math.round(verdict.heapRatio * 100) : null
      }
      try {
        window.webContents.send(IPC.MEMORY_PRESSURE_ALERT, payload)
      } catch {
        // Window mid-teardown; the report on disk is the durable outcome.
      }
    }
  }

  // ---------- Tier 3: lightweight report + consent-gated snapshots ----------

  /**
   * Write the lightweight memory report as a single-line JSONL file inside
   * the trace-store directory. The diagnostic bundle collects every *.jsonl
   * in that directory, so the report ships with the next user bundle with
   * zero bundler changes. Numbers only — no paths, no user content.
   */
  writeMemoryReport(trigger: string): string | null {
    if (!this.enabled) return null
    try {
      const dir = traceStore.getDir()
      if (!dir) return null
      const stamp = new Date().toISOString().replace(/[:.]/g, '-')
      const path = join(dir, `memory-report-${stamp}.jsonl`)
      const report = {
        schema: 'onward.memory_report.v1',
        generatedAt: new Date().toISOString(),
        trigger,
        config: this.config,
        intervalMs: INTERVAL_MS,
        promptedCount: this.promptedCount,
        lastVerdict: this.lastVerdict,
        rendererReport: this.rendererReport,
        samples: this.samples
      }
      const line = `${JSON.stringify(report)}\n`
      writeFileSync(path, line)
      this.lastReportPath = path
      this.pruneOldest(dir, /^memory-report-.*\.jsonl$/, MAX_MEMORY_REPORT_FILES)
      performanceTrace.record(PERF_TRACE_EVENT.MAIN_MEM_WATCH_REPORT_WRITTEN, {
        trigger,
        reportBytes: line.length,
        sampleCount: this.samples.length
      })
      return path
    } catch (error) {
      console.warn('[MemoryWatcher] memory report write failed:', String(error))
      return null
    }
  }

  /**
   * Consent-gated heap snapshot capture (called from the diagnostic-bundle
   * IPC handler AFTER the user opted in). Captures renderer (via
   * webContents.takeHeapSnapshot — works for the frozen-UI case because
   * main drives it) then main (v8.writeHeapSnapshot, synchronous). Guards:
   * single-flight, system-headroom check, oldest-eviction on the heap dir.
   */
  async captureHeapSnapshotsForBundle(): Promise<{ snapshots: HeapSnapshotFileInfo[]; skipped: string[] }> {
    const skipped: string[] = []
    if (!this.enabled) {
      this.recordDumpSkipped('renderer', 'disabled')
      return { snapshots: [], skipped: ['disabled'] }
    }
    if (this.snapshotInFlight) {
      this.recordDumpSkipped('renderer', 'in-flight')
      return { snapshots: [], skipped: ['in-flight'] }
    }
    this.snapshotInFlight = true
    const snapshots: HeapSnapshotFileInfo[] = []
    try {
      const heapDir = this.resolveHeapDir()
      if (!heapDir) {
        this.recordDumpSkipped('renderer', 'write-failed')
        return { snapshots: [], skipped: ['no-heap-dir'] }
      }
      const stamp = new Date().toISOString().replace(/[:.]/g, '-')

      const systemFreeKb = (() => {
        try {
          return toFiniteKb(process.getSystemMemoryInfo().free)
        } catch {
          return null
        }
      })()

      // Renderer snapshot.
      const window = this.getWindow()
      if (!window || window.isDestroyed()) {
        this.recordDumpSkipped('renderer', 'no-window')
        skipped.push('renderer:no-window')
      } else if (!hasSnapshotHeadroom({ systemFreeKb, targetHeapUsedKb: this.rendererReport?.heapUsedKb ?? null })) {
        this.recordDumpSkipped('renderer', 'insufficient-headroom')
        skipped.push('renderer:insufficient-headroom')
      } else {
        const rendererPath = join(heapDir, `Heap-${stamp}-renderer.heapsnapshot`)
        const startMs = Date.now()
        try {
          await window.webContents.takeHeapSnapshot(rendererPath)
          const bytes = statSync(rendererPath).size
          snapshots.push({ target: 'renderer', path: rendererPath, bytes })
          performanceTrace.record(PERF_TRACE_EVENT.MAIN_MEM_WATCH_DUMP_WRITTEN, {
            target: 'renderer',
            snapshotBytes: bytes,
            elapsedMs: Date.now() - startMs
          })
        } catch (error) {
          this.recordDumpSkipped('renderer', 'write-failed')
          skipped.push(`renderer:write-failed:${String(error)}`)
        }
      }

      // Main-process snapshot (synchronous; blocks main for seconds — the
      // user consented to a capture pause when opting in).
      const mainHeapUsedKb = bytesToKb(getHeapStatistics().used_heap_size)
      if (!hasSnapshotHeadroom({ systemFreeKb, targetHeapUsedKb: mainHeapUsedKb })) {
        this.recordDumpSkipped('main', 'insufficient-headroom')
        skipped.push('main:insufficient-headroom')
      } else {
        const mainPath = join(heapDir, `Heap-${stamp}-main.heapsnapshot`)
        const startMs = Date.now()
        try {
          // Lazy require keeps v8.writeHeapSnapshot out of worker bundles.
          // eslint-disable-next-line @typescript-eslint/no-require-imports
          const written = (require('v8') as { writeHeapSnapshot: (p: string) => string }).writeHeapSnapshot(mainPath)
          const bytes = statSync(written).size
          snapshots.push({ target: 'main', path: written, bytes })
          performanceTrace.record(PERF_TRACE_EVENT.MAIN_MEM_WATCH_DUMP_WRITTEN, {
            target: 'main',
            snapshotBytes: bytes,
            elapsedMs: Date.now() - startMs
          })
        } catch (error) {
          this.recordDumpSkipped('main', 'write-failed')
          skipped.push(`main:write-failed:${String(error)}`)
        }
      }

      this.pruneOldest(heapDir, /^Heap-.*\.heapsnapshot$/, MAX_HEAP_SNAPSHOT_FILES)
      this.lastSnapshots = snapshots
      return { snapshots, skipped }
    } finally {
      this.snapshotInFlight = false
    }
  }

  private recordDumpSkipped(target: 'renderer' | 'main', reason: string): void {
    performanceTrace.record(PERF_TRACE_EVENT.MAIN_MEM_WATCH_DUMP_SKIPPED, { target, reason })
  }

  /**
   * Heap snapshots live OUTSIDE the flat *.jsonl scan of the diagnostic
   * bundler: dev → <repo>/traces/heap, prod → <userData>/traces/heap.
   * They reach a bundle only via the explicit opt-in copy path.
   */
  private resolveHeapDir(): string | null {
    const dir = traceStore.getDir()
    if (!dir) return null
    const heapDir = traceStore.getRootKind() === 'repo' ? join(dir, '..', 'heap') : join(dir, 'heap')
    try {
      mkdirSync(heapDir, { recursive: true })
      return heapDir
    } catch {
      return null
    }
  }

  private pruneOldest(dir: string, pattern: RegExp, keep: number): void {
    try {
      if (!existsSync(dir)) return
      const files = readdirSync(dir)
        .filter((f) => pattern.test(f))
        .sort()
      const excess = files.length - keep
      for (let i = 0; i < excess; i++) {
        try {
          rmSync(join(dir, files[i]), { force: true })
        } catch {
          // Eviction is best-effort; a stuck file only costs disk.
        }
      }
    } catch {
      // Directory races are benign here.
    }
  }
}

export const memoryWatcher = new MemoryWatcher()
