/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Prompt input latency baseline suite.
 *
 * This suite measures the user-facing prompt textarea response while multiple
 * visible terminal tasks stream output. It records scheduled-keystroke to next
 * paint latency, which captures renderer main-thread stalls before input can
 * be processed.
 */
import type { PerfSnapshot } from '../utils/perf-monitor'
import { buildChangeDirectoryCommand, type TerminalShellKind } from '../utils/terminal-command'
import type { AutotestContext, CpuSummary, TestResult } from './types'
import type { EventLoopStallMetrics, GitRuntimeMetrics, PerfTraceInfo } from '../types/electron'

const RESULT_PREFIX = '[PromptInputLatency:RESULT]'
const LONGTAIL_RESULT_PREFIX = '[PromptInputLongtail:RESULT]'
const SEARCH_TOKEN = 'ONWARD_PROMPT_INPUT_LATENCY_TOKEN'

type PerfMonitorLike = {
  isActive: () => boolean
  start: () => void
  onSnapshot: (cb: (snap: PerfSnapshot) => void) => () => void
}

type TerminalDebugApiLike = {
  getVisibleTerminalIds?: () => string[]
}

type LatencyStats = {
  samples: number
  avgMs: number
  stddevMs: number
  p50Ms: number
  p95Ms: number
  p99Ms: number
  p999Ms: number
  maxMs: number
}

type PromptInputSample = {
  index: number
  offsetMs: number
  inputLatencyMs: number
  eventLoopDelayMs: number
  paintDelayMs: number
}

type PromptInputBucket = {
  startMs: number
  endMs: number
  samples: number
  avgMs: number
  p95Ms: number
  p99Ms: number
  maxMs: number
  eventLoopMaxMs: number
  paintMaxMs: number
  over100Ms: number
  over250Ms: number
  over500Ms: number
}

type PromptInputStallWindow = {
  startIndex: number
  endIndex: number
  startOffsetMs: number
  endOffsetMs: number
  samples: number
  maxMs: number
}

type SnapshotStats = {
  samples: number
  avgFps: number
  minFps: number
  maxFrameDrops: number
  maxLongestFrameMs: number
  avgIpcMsgPerSec: number
  maxIpcMsgPerSec: number
  avgIpcMBPerSec: number
  avgXtermWritesPerSec: number
  maxXtermWriteMs: number
  avgReactRendersPerSec: number
  maxWebglContexts: number
}

type PressureStats = {
  started: boolean
  completed: number
  errors: number
  avgMs: number
  p95Ms: number
  maxMs: number
}

type PromptInputMeasurement = {
  inputLatency: LatencyStats
  eventLoopDelay: LatencyStats
  paintDelay: LatencyStats
  mismatches: number
  finalLength: number
  over100Ms?: number
  over250Ms?: number
  over500Ms?: number
  buckets?: PromptInputBucket[]
  topOutliers?: PromptInputSample[]
  stallWindows?: PromptInputStallWindow[]
}

type ScenarioResult = {
  id: string
  description: string
  outputTerminalCount: number
  sampleCount: number
  intervalMs: number
  promptInput: PromptInputMeasurement
  perf: SnapshotStats
  cpu: CpuSummary
  mainEventLoop?: EventLoopStallMetrics | null
  gitDiffPressure?: PressureStats
  gitHistoryPressure?: PressureStats
  searchPressure?: PressureStats
  sqlitePressure?: PressureStats
}

type GitRuntimeDelta = {
  scheduler: {
    totalScheduled: number
    totalCompleted: number
    totalFailed: number
    dedupHits: number
    queueDepthPeak: number
    inflightPeak: number
  }
  kinds: {
    gitScheduled: number
    gitCompleted: number
    gitFailed: number
    cwdScheduled: number
    cwdCompleted: number
    miscScheduled: number
    miscCompleted: number
  }
  latencies: {
    titleRefreshCount: number
    cwdProbeCount: number
  }
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0
  const index = Math.min(sorted.length - 1, Math.floor(sorted.length * p))
  return sorted[index]
}

function summarizeValues(values: number[]): LatencyStats {
  if (values.length === 0) {
    return { samples: 0, avgMs: 0, stddevMs: 0, p50Ms: 0, p95Ms: 0, p99Ms: 0, p999Ms: 0, maxMs: 0 }
  }
  const sorted = [...values].sort((a, b) => a - b)
  const avg = sorted.reduce((sum, value) => sum + value, 0) / sorted.length
  const variance = sorted.reduce((sum, value) => sum + ((value - avg) ** 2), 0) / sorted.length
  return {
    samples: sorted.length,
    avgMs: +avg.toFixed(1),
    stddevMs: +Math.sqrt(variance).toFixed(1),
    p50Ms: +percentile(sorted, 0.5).toFixed(1),
    p95Ms: +percentile(sorted, 0.95).toFixed(1),
    p99Ms: +percentile(sorted, 0.99).toFixed(1),
    p999Ms: +percentile(sorted, 0.999).toFixed(1),
    maxMs: +sorted[sorted.length - 1].toFixed(1)
  }
}

function summarizePressure(values: number[], errors: number, started: boolean): PressureStats {
  const stats = summarizeValues(values)
  return {
    started,
    completed: values.length,
    errors,
    avgMs: stats.avgMs,
    p95Ms: stats.p95Ms,
    maxMs: stats.maxMs
  }
}

async function readGitRuntimeMetrics(): Promise<GitRuntimeMetrics | null> {
  try {
    return await window.electronAPI.debug.getGitRuntimeMetrics()
  } catch {
    return null
  }
}

async function readPerfTraceInfo(): Promise<PerfTraceInfo | null> {
  try {
    return await window.electronAPI.debug.getPerfTraceInfo()
  } catch {
    return null
  }
}

async function resetPerfTraceMetrics(): Promise<EventLoopStallMetrics | null> {
  try {
    return await window.electronAPI.debug.resetPerfTraceMetrics()
  } catch {
    return null
  }
}

function counterDelta(after: number | undefined, before: number | undefined): number {
  return Math.max(0, (after ?? 0) - (before ?? 0))
}

function summarizeGitRuntimeDelta(before: GitRuntimeMetrics | null, after: GitRuntimeMetrics | null): GitRuntimeDelta | null {
  if (!before || !after) return null
  return {
    scheduler: {
      totalScheduled: counterDelta(after.scheduler.totalScheduled, before.scheduler.totalScheduled),
      totalCompleted: counterDelta(after.scheduler.totalCompleted, before.scheduler.totalCompleted),
      totalFailed: counterDelta(after.scheduler.totalFailed, before.scheduler.totalFailed),
      dedupHits: counterDelta(after.scheduler.dedupHits, before.scheduler.dedupHits),
      queueDepthPeak: after.scheduler.queueDepthPeak,
      inflightPeak: after.scheduler.inflightPeak
    },
    kinds: {
      gitScheduled: counterDelta(after.kinds.git.scheduled, before.kinds.git.scheduled),
      gitCompleted: counterDelta(after.kinds.git.completed, before.kinds.git.completed),
      gitFailed: counterDelta(after.kinds.git.failed, before.kinds.git.failed),
      cwdScheduled: counterDelta(after.kinds.cwd.scheduled, before.kinds.cwd.scheduled),
      cwdCompleted: counterDelta(after.kinds.cwd.completed, before.kinds.cwd.completed),
      miscScheduled: counterDelta(after.kinds.misc.scheduled, before.kinds.misc.scheduled),
      miscCompleted: counterDelta(after.kinds.misc.completed, before.kinds.misc.completed)
    },
    latencies: {
      titleRefreshCount: counterDelta(after.latencies.titleRefresh.count, before.latencies.titleRefresh.count),
      cwdProbeCount: counterDelta(after.latencies.cwdProbe.count, before.latencies.cwdProbe.count)
    }
  }
}

function summarizeSnapshots(snaps: PerfSnapshot[]): SnapshotStats {
  if (snaps.length === 0) {
    return {
      samples: 0,
      avgFps: 0,
      minFps: 0,
      maxFrameDrops: 0,
      maxLongestFrameMs: 0,
      avgIpcMsgPerSec: 0,
      maxIpcMsgPerSec: 0,
      avgIpcMBPerSec: 0,
      avgXtermWritesPerSec: 0,
      maxXtermWriteMs: 0,
      avgReactRendersPerSec: 0,
      maxWebglContexts: 0
    }
  }

  const sum = (selector: (snap: PerfSnapshot) => number) =>
    snaps.reduce((total, snap) => total + selector(snap), 0)
  const max = (selector: (snap: PerfSnapshot) => number) =>
    Math.max(...snaps.map(selector))

  return {
    samples: snaps.length,
    avgFps: +(sum(s => s.fps) / snaps.length).toFixed(1),
    minFps: Math.min(...snaps.map(s => s.fps)),
    maxFrameDrops: max(s => s.frameDrops),
    maxLongestFrameMs: +max(s => s.longestFrameMs).toFixed(1),
    avgIpcMsgPerSec: +(sum(s => s.ipcDataMsgCount) / snaps.length).toFixed(1),
    maxIpcMsgPerSec: max(s => s.ipcDataMsgCount),
    avgIpcMBPerSec: +(sum(s => s.ipcDataBytes) / snaps.length / 1024 / 1024).toFixed(2),
    avgXtermWritesPerSec: +(sum(s => s.xtermWriteCount) / snaps.length).toFixed(1),
    maxXtermWriteMs: +max(s => s.xtermWriteMaxMs).toFixed(1),
    avgReactRendersPerSec: +(sum(s => s.reactRenderCount) / snaps.length).toFixed(1),
    maxWebglContexts: max(s => s.webglContextCount)
  }
}

function getPerfMonitor(): PerfMonitorLike | null {
  return ((window as unknown as { __perfMonitor?: PerfMonitorLike }).__perfMonitor) ?? null
}

function getTerminalDebugApi(): TerminalDebugApiLike | null {
  return ((window as unknown as { __onwardTerminalDebug?: TerminalDebugApiLike }).__onwardTerminalDebug) ?? null
}

function dirname(value: string): string {
  const normalized = value.replace(/[\\/]+$/, '')
  const slashIndex = Math.max(normalized.lastIndexOf('/'), normalized.lastIndexOf('\\'))
  return slashIndex > 0 ? normalized.slice(0, slashIndex) : normalized
}

function joinPath(base: string, child: string): string {
  const trimmed = base.replace(/[\\/]+$/, '')
  const separator = base.includes('\\') ? '\\' : '/'
  return `${trimmed}${separator}${child}`
}

function quotePosix(value: string): string {
  return "'" + value.replace(/'/g, "'\\''") + "'"
}

function quotePowerShell(value: string): string {
  return "'" + value.replace(/'/g, "''") + "'"
}

function quoteCmd(value: string): string {
  return '"' + value.replace(/([%^&|<>!])/g, '^$1').replace(/"/g, '""') + '"'
}

function quoteShellArg(platform: string, value: string, shellKind?: TerminalShellKind): string {
  if (platform === 'win32') {
    return shellKind === 'cmd' ? quoteCmd(value) : quotePowerShell(value)
  }
  return quotePosix(value)
}

function buildNodeScriptCommand(
  platform: string,
  shellKind: TerminalShellKind | undefined,
  scriptPath: string,
  args: Record<string, string | number>
): string {
  const renderedArgs = Object.entries(args).flatMap(([key, value]) => [
    `--${key}`,
    quoteShellArg(platform, String(value), shellKind)
  ])
  return `node ${quoteShellArg(platform, scriptPath, shellKind)} ${renderedArgs.join(' ')}\r`
}

async function resolveTerminalShellKind(terminalId: string): Promise<TerminalShellKind | undefined> {
  try {
    return (await window.electronAPI.terminal.getInputCapabilities(terminalId)).shellKind
  } catch {
    return undefined
  }
}

// The prompt editor is a contenteditable div (not a textarea): its value is
// read via innerText and set via textContent. These helpers keep the latency
// suites element-agnostic (they also create bare <textarea>s for comparison).
function getEditorValue(el: HTMLElement): string {
  return el instanceof HTMLTextAreaElement ? el.value : el.innerText
}
function setEditorValue(el: HTMLElement, value: string): void {
  if (el instanceof HTMLTextAreaElement) {
    const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value')?.set
    setter?.call(el, value)
  } else {
    el.textContent = value
  }
}

async function ensurePromptPanelVisible(ctx: AutotestContext): Promise<HTMLElement | null> {
  const { sleep, waitFor, log } = ctx

  await window.electronAPI.debug.focusWindow().catch(() => false)
  await sleep(200)

  document.dispatchEvent(new KeyboardEvent('keydown', {
    key: 'Escape',
    code: 'Escape',
    bubbles: true,
    cancelable: true
  }))
  await sleep(350)

  const findTextarea = () =>
    document.querySelector<HTMLElement>(
      '.prompt-notebook:not(.prompt-notebook-hidden) .prompt-editor-content'
    )

  if (!findTextarea()) {
    const promptButton = document.querySelector<HTMLButtonElement>(
      'button[title="Prompt notebook"]'
    )
    promptButton?.click()
    await sleep(350)
  }

  await waitFor('prompt-input-latency-editor-visible', () => Boolean(findTextarea()), 8000, 100)
  const textarea = findTextarea()
  window.__onwardPromptNotebookDebug?.setEditorContent('')
  textarea?.focus({ preventScroll: true })
  await window.electronAPI.debug.focusWindow().catch(() => false)
  textarea?.focus({ preventScroll: true })
  log('prompt-input-latency:prompt-panel', {
    visible: Boolean(textarea),
    activeElement: document.activeElement?.className ?? null
  })
  return textarea
}

async function ensureSixTerminalLayout(ctx: AutotestContext): Promise<string[]> {
  const { sleep, waitFor, log } = ctx

  const sixButton = document.querySelector<HTMLButtonElement>(
    'button[title="Six terminals"], button[title="Six-grid"]'
  )
  sixButton?.click()

  await waitFor(
    'prompt-input-latency-six-layout',
    () => (getTerminalDebugApi()?.getVisibleTerminalIds?.().length ?? 0) >= 6 ||
      document.querySelectorAll('[data-terminal-id]').length >= 6,
    12000,
    150
  )

  const debugIds = getTerminalDebugApi()?.getVisibleTerminalIds?.() ?? []
  const domIds = Array.from(document.querySelectorAll<HTMLElement>('[data-terminal-id]'))
    .map(node => node.dataset.terminalId ?? '')
    .filter(Boolean)
  const ids = Array.from(new Set([...debugIds, ...domIds])).slice(0, 6)

  log('prompt-input-latency:layout', {
    clickedSixButton: Boolean(sixButton),
    visibleTerminalIds: ids
  })
  await sleep(500)
  return ids
}

async function changeTerminalsToFixtureCwd(
  terminalIds: string[],
  rootPath: string,
  platform: string,
  sleep: AutotestContext['sleep']
): Promise<void> {
  for (const id of terminalIds) {
    const shellKind = await resolveTerminalShellKind(id)
    await window.electronAPI.terminal.write(id, buildChangeDirectoryCommand(platform, rootPath, shellKind))
    await sleep(120)
    await window.electronAPI.git.subscribeTerminalInfo(id).catch(() => {})
    await window.electronAPI.git.notifyTerminalActivity(id).catch(() => {})
  }
  await sleep(1000)
}

function beginSnapshotCollection(perfMon: PerfMonitorLike | null): { snapshots: PerfSnapshot[]; stop: () => void } {
  const snapshots: PerfSnapshot[] = []
  const unsubscribe = perfMon?.onSnapshot((snap) => {
    snapshots.push(snap)
  }) ?? (() => {})
  return {
    snapshots,
    stop: unsubscribe
  }
}

async function startOutputLoad(
  terminalIds: string[],
  scriptPath: string,
  scenarioId: string,
  platform: string,
  sleep: AutotestContext['sleep'],
  options?: {
    intervalMs?: number
    batchSize?: number
  }
): Promise<void> {
  const intervalMs = options?.intervalMs ?? 12
  const batchSize = options?.batchSize ?? 64
  for (let i = 0; i < terminalIds.length; i++) {
    const id = terminalIds[i]
    const shellKind = await resolveTerminalShellKind(id)
    const command = buildNodeScriptCommand(platform, shellKind, scriptPath, {
      label: `${scenarioId}-${i}`,
      'interval-ms': intervalMs,
      batch: batchSize
    })
    await window.electronAPI.terminal.write(id, command)
    await sleep(120)
  }
}

async function stopOutputLoad(terminalIds: string[], sleep: AutotestContext['sleep']): Promise<void> {
  for (const id of terminalIds) {
    await window.electronAPI.terminal.write(id, '\x03').catch(() => {})
  }
  await sleep(1200)
}

function startGitDiffPressure(rootPath: string, durationMs: number, concurrency: number): Promise<PressureStats> {
  const deadline = performance.now() + durationMs
  const latencies: number[] = []
  let errors = 0
  let started = false

  const worker = async () => {
    while (performance.now() < deadline) {
      started = true
      const start = performance.now()
      try {
        await window.electronAPI.git.getDiff(rootPath)
        latencies.push(performance.now() - start)
      } catch {
        errors++
        await new Promise(resolve => window.setTimeout(resolve, 150))
      }
    }
  }

  return Promise.all(Array.from({ length: concurrency }, () => worker()))
    .then(() => summarizePressure(latencies, errors, started))
}

function startGitHistoryPressure(rootPath: string, durationMs: number, concurrency: number): Promise<PressureStats> {
  const deadline = performance.now() + durationMs
  const latencies: number[] = []
  let errors = 0
  let started = false

  const worker = async () => {
    while (performance.now() < deadline) {
      started = true
      const start = performance.now()
      try {
        const history = await window.electronAPI.git.getHistory(rootPath, { limit: 80, skip: 0 })
        const first = history.commits[0]
        const second = history.commits[1]
        if (first?.sha && second?.sha) {
          await window.electronAPI.git.getHistoryDiff(rootPath, {
            base: second.sha,
            head: first.sha,
            includeFiles: true
          })
        }
        latencies.push(performance.now() - start)
      } catch {
        errors++
        await new Promise(resolve => window.setTimeout(resolve, 150))
      }
    }
  }

  return Promise.all(Array.from({ length: concurrency }, () => worker()))
    .then(() => summarizePressure(latencies, errors, started))
}

async function ensureSqlitePressureFixture(rootPath: string): Promise<void> {
  const setupSql = [
    'DROP TABLE IF EXISTS records;',
    'CREATE TABLE records (id INTEGER PRIMARY KEY, group_id INTEGER NOT NULL, payload TEXT NOT NULL, score INTEGER NOT NULL);',
    "WITH RECURSIVE seq(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM seq WHERE n < 20000) INSERT INTO records(group_id, payload, score) SELECT n % 101, printf('ONWARD_SQLITE_PRESSURE_%05d_%s', n, hex(randomblob(24))), (n * 17) % 1000 FROM seq;",
    'CREATE INDEX idx_records_group_score ON records(group_id, score);',
    'CREATE INDEX idx_records_payload ON records(payload);'
  ].join('\n')

  const result = await window.electronAPI.project.sqliteExecute(rootPath, 'main-pressure.sqlite', setupSql)
  if (!result.success) {
    throw new Error(result.error || 'Failed to create SQLite pressure fixture')
  }
}

function startSqlitePressure(rootPath: string, durationMs: number, concurrency: number): Promise<PressureStats> {
  const deadline = performance.now() + durationMs
  const latencies: number[] = []
  let errors = 0
  let started = false

  const worker = async () => {
    while (performance.now() < deadline) {
      started = true
      const start = performance.now()
      try {
        await window.electronAPI.project.sqliteGetSchema(rootPath, 'main-pressure.sqlite')
        await window.electronAPI.project.sqliteReadTableRows(rootPath, 'main-pressure.sqlite', 'records', 500, 0)
        await window.electronAPI.project.sqliteExecute(
          rootPath,
          'main-pressure.sqlite',
          'SELECT group_id, COUNT(*) AS c, AVG(score) AS avg_score, SUM(LENGTH(payload)) AS payload_bytes FROM records GROUP BY group_id ORDER BY payload_bytes DESC, avg_score DESC LIMIT 101'
        )
        latencies.push(performance.now() - start)
      } catch {
        errors++
        await new Promise(resolve => window.setTimeout(resolve, 150))
      }
    }
  }

  return Promise.all(Array.from({ length: concurrency }, () => worker()))
    .then(() => summarizePressure(latencies, errors, started))
}

function runSingleSearch(rootPath: string): Promise<number> {
  return new Promise((resolve, reject) => {
    let searchId = ''
    const start = performance.now()
    const timeout = window.setTimeout(() => {
      cleanup()
      reject(new Error('project search timed out'))
    }, 10000)

    const cleanupFns: Array<() => void> = []
    const cleanup = () => {
      window.clearTimeout(timeout)
      cleanupFns.forEach(fn => fn())
      void window.electronAPI.project.searchCancel().catch(() => {})
    }

    cleanupFns.push(window.electronAPI.project.onSearchDone((stats) => {
      if (stats.searchId !== searchId) return
      cleanup()
      resolve(performance.now() - start)
    }))

    window.electronAPI.project.searchStart({
      rootPath,
      query: SEARCH_TOKEN,
      isRegex: false,
      isCaseSensitive: true,
      isWholeWord: false,
      maxResults: 10000
    }).then((result) => {
      searchId = result.searchId
    }).catch((error) => {
      cleanup()
      reject(error)
    })
  })
}

function startSearchPressure(rootPath: string, durationMs: number): Promise<PressureStats> {
  const deadline = performance.now() + durationMs
  const latencies: number[] = []
  let errors = 0
  let started = false

  const loop = async () => {
    while (performance.now() < deadline) {
      started = true
      try {
        latencies.push(await runSingleSearch(rootPath))
      } catch {
        errors++
        await new Promise(resolve => window.setTimeout(resolve, 150))
      }
    }
  }

  return loop().then(() => summarizePressure(latencies, errors, started))
}

function nextPaint(): Promise<void> {
  return new Promise(resolve => {
    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => resolve())
    })
  })
}

function insertPromptCharacter(el: HTMLElement, value: string): void {
  el.focus({ preventScroll: true })
  const before = getEditorValue(el)
  // execCommand('insertText') works on both textarea and contenteditable.
  const inserted = document.execCommand('insertText', false, value)
  if (!inserted || getEditorValue(el) === before) {
    setEditorValue(el, `${before}${value}`)
    el.dispatchEvent(new InputEvent('input', {
      bubbles: true,
      inputType: 'insertText',
      data: value
    }))
  }
}

function roundMs(value: number): number {
  return +value.toFixed(1)
}

function buildPromptInputBuckets(samples: PromptInputSample[], bucketMs: number): PromptInputBucket[] {
  const buckets = new Map<number, PromptInputSample[]>()
  for (const sample of samples) {
    const bucketIndex = Math.floor(sample.offsetMs / bucketMs)
    const existing = buckets.get(bucketIndex) ?? []
    existing.push(sample)
    buckets.set(bucketIndex, existing)
  }

  return Array.from(buckets.entries())
    .sort(([left], [right]) => left - right)
    .map(([bucketIndex, bucketSamples]) => {
      const latencies = bucketSamples.map(sample => sample.inputLatencyMs)
      const stats = summarizeValues(latencies)
      return {
        startMs: roundMs(bucketIndex * bucketMs),
        endMs: roundMs((bucketIndex + 1) * bucketMs),
        samples: bucketSamples.length,
        avgMs: stats.avgMs,
        p95Ms: stats.p95Ms,
        p99Ms: stats.p99Ms,
        maxMs: stats.maxMs,
        eventLoopMaxMs: roundMs(Math.max(...bucketSamples.map(sample => sample.eventLoopDelayMs))),
        paintMaxMs: roundMs(Math.max(...bucketSamples.map(sample => sample.paintDelayMs))),
        over100Ms: bucketSamples.filter(sample => sample.inputLatencyMs > 100).length,
        over250Ms: bucketSamples.filter(sample => sample.inputLatencyMs > 250).length,
        over500Ms: bucketSamples.filter(sample => sample.inputLatencyMs > 500).length
      }
    })
}

function buildPromptInputStallWindows(samples: PromptInputSample[], thresholdMs: number): PromptInputStallWindow[] {
  const windows: PromptInputStallWindow[] = []
  let active: PromptInputSample[] = []

  const flush = () => {
    if (active.length === 0) return
    windows.push({
      startIndex: active[0].index,
      endIndex: active[active.length - 1].index,
      startOffsetMs: active[0].offsetMs,
      endOffsetMs: active[active.length - 1].offsetMs,
      samples: active.length,
      maxMs: roundMs(Math.max(...active.map(sample => sample.inputLatencyMs)))
    })
    active = []
  }

  for (const sample of samples) {
    if (sample.inputLatencyMs > thresholdMs) {
      active.push(sample)
    } else {
      flush()
    }
  }
  flush()

  return windows
}

async function measurePromptInputLatency(
  textarea: HTMLElement,
  samples: number,
  intervalMs: number,
  details?: {
    collectTimeline?: boolean
    bucketMs?: number
    outlierCount?: number
    stallThresholdMs?: number
  }
): Promise<PromptInputMeasurement> {
  const inputLatencies: number[] = []
  const eventLoopDelays: number[] = []
  const paintDelays: number[] = []
  const sampleTimeline: PromptInputSample[] = []
  let mismatches = 0

  setEditorValue(textarea, '')
  textarea.dispatchEvent(new Event('input', { bubbles: true }))
  await nextPaint()

  let dueAt = performance.now() + intervalMs
  const firstDueAt = dueAt
  for (let i = 0; i < samples; i++) {
    const waitMs = Math.max(0, dueAt - performance.now())
    await new Promise(resolve => window.setTimeout(resolve, waitMs))

    const callbackAt = performance.now()
    const value = String.fromCharCode(97 + (i % 26))
    const expected = `${getEditorValue(textarea)}${value}`

    insertPromptCharacter(textarea, value)
    await nextPaint()

    const paintedAt = performance.now()
    const inputLatency = Math.max(0, paintedAt - dueAt)
    const eventLoopDelay = Math.max(0, callbackAt - dueAt)
    const paintDelay = Math.max(0, paintedAt - callbackAt)
    inputLatencies.push(inputLatency)
    eventLoopDelays.push(eventLoopDelay)
    paintDelays.push(paintDelay)
    if (details?.collectTimeline) {
      sampleTimeline.push({
        index: i,
        offsetMs: roundMs(dueAt - firstDueAt),
        inputLatencyMs: roundMs(inputLatency),
        eventLoopDelayMs: roundMs(eventLoopDelay),
        paintDelayMs: roundMs(paintDelay)
      })
    }

    if (getEditorValue(textarea) !== expected) {
      mismatches += 1
    }
    dueAt += intervalMs
  }

  const measurement: PromptInputMeasurement = {
    inputLatency: summarizeValues(inputLatencies),
    eventLoopDelay: summarizeValues(eventLoopDelays),
    paintDelay: summarizeValues(paintDelays),
    mismatches,
    finalLength: getEditorValue(textarea).length
  }

  if (details?.collectTimeline) {
    const outlierCount = details.outlierCount ?? 25
    const stallThresholdMs = details.stallThresholdMs ?? 250
    measurement.over100Ms = inputLatencies.filter(value => value > 100).length
    measurement.over250Ms = inputLatencies.filter(value => value > 250).length
    measurement.over500Ms = inputLatencies.filter(value => value > 500).length
    measurement.buckets = buildPromptInputBuckets(sampleTimeline, details.bucketMs ?? 1000)
    measurement.topOutliers = [...sampleTimeline]
      .sort((left, right) => right.inputLatencyMs - left.inputLatencyMs)
      .slice(0, outlierCount)
    measurement.stallWindows = buildPromptInputStallWindows(sampleTimeline, stallThresholdMs)
  }

  return measurement
}

async function runScenario(
  ctx: AutotestContext,
  options: {
    id: string
    description: string
    textarea: HTMLElement
    outputTerminalIds: string[]
    loadScriptPath: string
    sampleCount: number
    intervalMs: number
    gitDiffPressureConcurrency?: number
    gitHistoryPressureConcurrency?: number
    searchPressure?: boolean
    sqlitePressureConcurrency?: number
  }
): Promise<ScenarioResult> {
  const { sleep, rootPath, startCpuSampler, stopCpuSampler, log } = ctx
  const platform = window.electronAPI.platform
  const perfMon = getPerfMonitor()

  if (perfMon && !perfMon.isActive()) {
    perfMon.start()
  }

  log('prompt-input-latency:scenario-begin', {
    id: options.id,
    outputTerminalCount: options.outputTerminalIds.length,
    sampleCount: options.sampleCount,
    intervalMs: options.intervalMs,
    gitDiffPressureConcurrency: options.gitDiffPressureConcurrency ?? 0,
    gitHistoryPressureConcurrency: options.gitHistoryPressureConcurrency ?? 0,
    sqlitePressureConcurrency: options.sqlitePressureConcurrency ?? 0,
    searchPressure: Boolean(options.searchPressure)
  })

  const collector = beginSnapshotCollection(perfMon)
  startCpuSampler()
  await resetPerfTraceMetrics()

  try {
    if (options.outputTerminalIds.length > 0) {
      await startOutputLoad(options.outputTerminalIds, options.loadScriptPath, options.id, platform, sleep)
      await sleep(1500)
    }

    let gitDiffPressurePromise: Promise<PressureStats> | undefined
    let gitHistoryPressurePromise: Promise<PressureStats> | undefined
    let searchPressurePromise: Promise<PressureStats> | undefined
    let sqlitePressurePromise: Promise<PressureStats> | undefined
    const pressureDurationMs = Math.max(6000, options.sampleCount * options.intervalMs + 1000)
    if (options.gitDiffPressureConcurrency && options.gitDiffPressureConcurrency > 0) {
      gitDiffPressurePromise = startGitDiffPressure(rootPath, pressureDurationMs, options.gitDiffPressureConcurrency)
    }
    if (options.gitHistoryPressureConcurrency && options.gitHistoryPressureConcurrency > 0) {
      gitHistoryPressurePromise = startGitHistoryPressure(rootPath, pressureDurationMs, options.gitHistoryPressureConcurrency)
    }
    if (options.searchPressure) {
      searchPressurePromise = startSearchPressure(rootPath, pressureDurationMs)
    }
    if (options.sqlitePressureConcurrency && options.sqlitePressureConcurrency > 0) {
      await ensureSqlitePressureFixture(rootPath)
      sqlitePressurePromise = startSqlitePressure(rootPath, pressureDurationMs, options.sqlitePressureConcurrency)
    }

    const promptInput = await measurePromptInputLatency(
      options.textarea,
      options.sampleCount,
      options.intervalMs
    )

    const [gitDiffPressure, gitHistoryPressure, searchPressure, sqlitePressure] = await Promise.all([
      gitDiffPressurePromise ?? Promise.resolve(undefined),
      gitHistoryPressurePromise ?? Promise.resolve(undefined),
      searchPressurePromise ?? Promise.resolve(undefined),
      sqlitePressurePromise ?? Promise.resolve(undefined)
    ])
    const perfTraceInfo = await readPerfTraceInfo()
    const cpu = stopCpuSampler()
    collector.stop()

    return {
      id: options.id,
      description: options.description,
      outputTerminalCount: options.outputTerminalIds.length,
      sampleCount: options.sampleCount,
      intervalMs: options.intervalMs,
      promptInput,
      perf: summarizeSnapshots(collector.snapshots),
      cpu,
      mainEventLoop: perfTraceInfo?.eventLoop ?? null,
      ...(gitDiffPressure ? { gitDiffPressure } : {}),
      ...(gitHistoryPressure ? { gitHistoryPressure } : {}),
      ...(searchPressure ? { searchPressure } : {}),
      ...(sqlitePressure ? { sqlitePressure } : {})
    }
  } finally {
    await stopOutputLoad(options.outputTerminalIds, sleep)
    collector.stop()
    stopCpuSampler()
    await sleep(700)
  }
}

export async function testPromptInputLatency(ctx: AutotestContext): Promise<TestResult[]> {
  const { assert, rootPath, sleep } = ctx
  const results: TestResult[] = []
  const record = (name: string, ok: boolean, detail?: Record<string, unknown>) => {
    assert(name, ok, detail)
    results.push({ name, ok, detail })
  }

  const platform = window.electronAPI.platform
  const fixtureDir = dirname(rootPath)
  const loadScriptPath = joinPath(fixtureDir, 'load-generator.mjs')
  const textarea = await ensurePromptPanelVisible(ctx)
  const visibleTerminalIds = await ensureSixTerminalLayout(ctx)
  const outputTerminalIds = visibleTerminalIds.slice(0, 5)

  if (!textarea || outputTerminalIds.length < 2) {
    record('PIL-00-setup', false, {
      hasTextarea: Boolean(textarea),
      outputTerminalIds,
      reason: 'Need prompt textarea and at least two output terminals.'
    })
    return results
  }

  await changeTerminalsToFixtureCwd(visibleTerminalIds, rootPath, platform, sleep)

  const sampleCount = 48
  const intervalMs = 80
  const scenarios: ScenarioResult[] = []

  scenarios.push(await runScenario(ctx, {
    id: 'idle-prompt-input',
    description: 'Prompt textarea input latency with no terminal output pressure.',
    textarea,
    outputTerminalIds: [],
    loadScriptPath,
    sampleCount,
    intervalMs
  }))

  scenarios.push(await runScenario(ctx, {
    id: 'visible-output-2-prompt-input',
    description: 'Prompt textarea input latency while two visible terminal tasks stream output.',
    textarea,
    outputTerminalIds: outputTerminalIds.slice(0, 2),
    loadScriptPath,
    sampleCount,
    intervalMs
  }))

  scenarios.push(await runScenario(ctx, {
    id: 'visible-output-5-prompt-input',
    description: 'Prompt textarea input latency while five visible terminal tasks stream output.',
    textarea,
    outputTerminalIds,
    loadScriptPath,
    sampleCount,
    intervalMs
  }))

  scenarios.push(await runScenario(ctx, {
    id: 'visible-output-5-git-diff-prompt-input',
    description: 'Prompt textarea input latency while five visible terminal tasks stream output and Git diff pressure runs.',
    textarea,
    outputTerminalIds,
    loadScriptPath,
    sampleCount,
    intervalMs,
    gitDiffPressureConcurrency: 3
  }))

  scenarios.push(await runScenario(ctx, {
    id: 'visible-output-5-search-prompt-input',
    description: 'Prompt textarea input latency while five visible terminal tasks stream output and project search pressure runs.',
    textarea,
    outputTerminalIds,
    loadScriptPath,
    sampleCount,
    intervalMs,
    searchPressure: true
  }))

  for (const id of visibleTerminalIds) {
    await window.electronAPI.git.unsubscribeTerminalInfo(id).catch(() => {})
  }

  const findScenario = (id: string) => scenarios.find(s => s.id === id)
  const idle = findScenario('idle-prompt-input')
  const output2 = findScenario('visible-output-2-prompt-input')
  const output5 = findScenario('visible-output-5-prompt-input')
  const output5Git = findScenario('visible-output-5-git-diff-prompt-input')
  const output5Search = findScenario('visible-output-5-search-prompt-input')
  const derived = {
    output2P95DeltaVsIdleMs: idle && output2
      ? +(output2.promptInput.inputLatency.p95Ms - idle.promptInput.inputLatency.p95Ms).toFixed(1)
      : null,
    output5P95DeltaVsIdleMs: idle && output5
      ? +(output5.promptInput.inputLatency.p95Ms - idle.promptInput.inputLatency.p95Ms).toFixed(1)
      : null,
    output5P95DeltaVsOutput2Ms: output2 && output5
      ? +(output5.promptInput.inputLatency.p95Ms - output2.promptInput.inputLatency.p95Ms).toFixed(1)
      : null,
    output2EventLoopP95DeltaVsIdleMs: idle && output2
      ? +(output2.promptInput.eventLoopDelay.p95Ms - idle.promptInput.eventLoopDelay.p95Ms).toFixed(1)
      : null,
    output5EventLoopP95DeltaVsIdleMs: idle && output5
      ? +(output5.promptInput.eventLoopDelay.p95Ms - idle.promptInput.eventLoopDelay.p95Ms).toFixed(1)
      : null,
    output5GitP95DeltaVsIdleMs: idle && output5Git
      ? +(output5Git.promptInput.inputLatency.p95Ms - idle.promptInput.inputLatency.p95Ms).toFixed(1)
      : null,
    output5SearchP95DeltaVsIdleMs: idle && output5Search
      ? +(output5Search.promptInput.inputLatency.p95Ms - idle.promptInput.inputLatency.p95Ms).toFixed(1)
      : null
  }

  const report = {
    schemaVersion: 1,
    suite: 'prompt-input-latency',
    capturedAt: new Date().toISOString(),
    platform,
    userAgent: navigator.userAgent,
    rootPath,
    fixtureDir,
    loadScriptPath,
    visibleTerminalIds,
    outputTerminalIds,
    scenarios,
    derived
  }

  const json = JSON.stringify(report)
  console.log(`${RESULT_PREFIX}${json}`)
  window.electronAPI.debug.log(`${RESULT_PREFIX}${json}`)

  record('PIL-01-baseline-recorded', true, {
    scenarios: scenarios.map(scenario => ({
      id: scenario.id,
      promptInputP95Ms: scenario.promptInput.inputLatency.p95Ms,
      promptInputMaxMs: scenario.promptInput.inputLatency.maxMs,
      eventLoopP95Ms: scenario.promptInput.eventLoopDelay.p95Ms,
      paintP95Ms: scenario.promptInput.paintDelay.p95Ms,
      mismatches: scenario.promptInput.mismatches,
      avgFps: scenario.perf.avgFps,
      avgIpcMsgPerSec: scenario.perf.avgIpcMsgPerSec,
      mainEventLoopMaxDriftMs: scenario.mainEventLoop?.maxDriftMs ?? null,
      mainEventLoopOver1000Ms: scenario.mainEventLoop?.over1000Ms ?? null,
      gitDiffPressure: scenario.gitDiffPressure ?? null,
      searchPressure: scenario.searchPressure ?? null
    })),
    derived
  })

  const output2P95Ok = (output2?.promptInput.inputLatency.p95Ms ?? Number.POSITIVE_INFINITY) <= 80
  const output5P95Ok = (output5?.promptInput.inputLatency.p95Ms ?? Number.POSITIVE_INFINITY) <= 120
  const output5GitP95Ok = (output5Git?.promptInput.inputLatency.p95Ms ?? Number.POSITIVE_INFINITY) <= 120
  const output5SearchP95Ok = (output5Search?.promptInput.inputLatency.p95Ms ?? Number.POSITIVE_INFINITY) <= 120
  const maxOk = scenarios.every(scenario => scenario.promptInput.inputLatency.maxMs <= 250)
  const mismatchOk = scenarios.every(scenario => scenario.promptInput.mismatches === 0)
  record('PIL-02-acceptance-thresholds', output2P95Ok && output5P95Ok && output5GitP95Ok && output5SearchP95Ok && maxOk && mismatchOk, {
    thresholds: {
      output2P95Ms: 80,
      output5P95Ms: 120,
      output5GitP95Ms: 120,
      output5SearchP95Ms: 120,
      maxMs: 250,
      mismatches: 0
    },
    actual: {
      output2P95Ms: output2?.promptInput.inputLatency.p95Ms ?? null,
      output5P95Ms: output5?.promptInput.inputLatency.p95Ms ?? null,
      output5GitP95Ms: output5Git?.promptInput.inputLatency.p95Ms ?? null,
      output5SearchP95Ms: output5Search?.promptInput.inputLatency.p95Ms ?? null,
      maxMs: Math.max(...scenarios.map(scenario => scenario.promptInput.inputLatency.maxMs)),
      mismatches: scenarios.reduce((sum, scenario) => sum + scenario.promptInput.mismatches, 0)
    }
  })

  return results
}

export async function testPromptInputLongtail(ctx: AutotestContext): Promise<TestResult[]> {
  const { assert, log, rootPath, sleep, startCpuSampler, stopCpuSampler } = ctx
  const results: TestResult[] = []
  const record = (name: string, ok: boolean, detail?: Record<string, unknown>) => {
    assert(name, ok, detail)
    results.push({ name, ok, detail })
  }

  const platform = window.electronAPI.platform
  const fixtureDir = dirname(rootPath)
  const taskWorkloadPath = joinPath(fixtureDir, 'task-workload.mjs')
  const textarea = await ensurePromptPanelVisible(ctx)
  const visibleTerminalIds = await ensureSixTerminalLayout(ctx)
  const outputTerminalIds = visibleTerminalIds.slice(0, 6)

  if (!textarea || outputTerminalIds.length < 6) {
    record('PILT-00-setup', false, {
      hasTextarea: Boolean(textarea),
      outputTerminalIds,
      reason: 'Need prompt textarea and six visible output terminals.'
    })
    return results
  }

  await changeTerminalsToFixtureCwd(visibleTerminalIds, rootPath, platform, sleep)

  const perfMon = getPerfMonitor()
  if (perfMon && !perfMon.isActive()) {
    perfMon.start()
  }

  const scenarioId = 'visible-output-6-git-status-prompt-longtail'
  const sampleCount = 900
  const intervalMs = 80
  const stallThresholdMs = 250

  log('prompt-input-longtail:scenario-begin', {
    id: scenarioId,
    outputTerminalCount: outputTerminalIds.length,
    sampleCount,
    intervalMs,
    durationMs: sampleCount * intervalMs,
    stallThresholdMs
  })

  const collector = beginSnapshotCollection(perfMon)
  startCpuSampler()

  let promptInput: PromptInputMeasurement | null = null
  let perf: SnapshotStats = summarizeSnapshots([])
  let cpu: CpuSummary = {
    samples: 0,
    totalAvg: 0,
    totalMax: 0,
    rendererAvg: 0,
    rendererMax: 0,
    browserAvg: 0,
    browserMax: 0
  }
  let cpuStopped = false
  let gitRuntimeBefore: GitRuntimeMetrics | null = null
  let gitRuntimeAfter: GitRuntimeMetrics | null = null
  let perfTraceBefore: PerfTraceInfo | null = null
  let perfTraceAfter: PerfTraceInfo | null = null
  let gitDiffPressure: PressureStats | null = null
  let gitHistoryPressure: PressureStats | null = null
  let sqlitePressure: PressureStats | null = null

  try {
    perfTraceBefore = await readPerfTraceInfo()
    await ensureSqlitePressureFixture(rootPath)
    await resetPerfTraceMetrics()
    gitRuntimeBefore = await readGitRuntimeMetrics()
    await startOutputLoad(outputTerminalIds, taskWorkloadPath, scenarioId, platform, sleep, {
      intervalMs: 250,
      batchSize: 1
    })
    await sleep(2000)

    const pressureDurationMs = sampleCount * intervalMs + 1500
    const gitDiffPressurePromise = startGitDiffPressure(rootPath, pressureDurationMs, 2)
    const gitHistoryPressurePromise = startGitHistoryPressure(rootPath, pressureDurationMs, 1)
    const sqlitePressurePromise = startSqlitePressure(rootPath, pressureDurationMs, 1)

    promptInput = await measurePromptInputLatency(textarea, sampleCount, intervalMs, {
      collectTimeline: true,
      bucketMs: 1000,
      outlierCount: 40,
      stallThresholdMs
    })
    ;[gitDiffPressure, gitHistoryPressure, sqlitePressure] = await Promise.all([
      gitDiffPressurePromise,
      gitHistoryPressurePromise,
      sqlitePressurePromise
    ])

    cpu = stopCpuSampler()
    cpuStopped = true
    collector.stop()
    perf = summarizeSnapshots(collector.snapshots)
    perfTraceAfter = await readPerfTraceInfo()
  } finally {
    await stopOutputLoad(outputTerminalIds, sleep)
    collector.stop()
    if (!cpuStopped) {
      cpu = stopCpuSampler()
      cpuStopped = true
    }
    for (const id of visibleTerminalIds) {
      await window.electronAPI.git.unsubscribeTerminalInfo(id).catch(() => {})
    }
    await sleep(700)
    gitRuntimeAfter = await readGitRuntimeMetrics()
    if (!perfTraceAfter) {
      perfTraceAfter = await readPerfTraceInfo()
    }
  }

  if (!promptInput) {
    record('PILT-01-longtail-recorded', false, { reason: 'Prompt input measurement did not complete.' })
    return results
  }

  const stallWindows = promptInput.stallWindows ?? []
  const stallWindowGapsMs = stallWindows.slice(1).map((windowInfo, index) =>
    roundMs(windowInfo.startOffsetMs - stallWindows[index].startOffsetMs)
  )
  const worstBucket = (promptInput.buckets ?? []).reduce<PromptInputBucket | null>((worst, bucket) => {
    if (!worst || bucket.maxMs > worst.maxMs) return bucket
    return worst
  }, null)
  const scenario = {
    id: scenarioId,
    description: 'Prompt textarea long-tail latency while six visible terminal tasks stream output and Git/SQLite main-pressure IPC work runs.',
    outputTerminalCount: outputTerminalIds.length,
    sampleCount,
    intervalMs,
    durationMs: sampleCount * intervalMs,
    promptInput,
    perf,
    cpu,
    mainEventLoop: perfTraceAfter?.eventLoop ?? null,
    gitDiffPressure,
    gitHistoryPressure,
    sqlitePressure,
    gitRuntime: {
      before: gitRuntimeBefore,
      after: gitRuntimeAfter,
      delta: summarizeGitRuntimeDelta(gitRuntimeBefore, gitRuntimeAfter)
    }
  }
  const derived = {
    stallThresholdMs,
    stallWindowCount: stallWindows.length,
    stallWindowGapsMs,
    worstBucket,
    worstOutlier: promptInput.topOutliers?.[0] ?? null,
    mainEventLoop: perfTraceAfter?.eventLoop ?? null
  }
  const report = {
    schemaVersion: 1,
    suite: 'prompt-input-longtail',
    capturedAt: new Date().toISOString(),
    platform,
    userAgent: navigator.userAgent,
    rootPath,
    fixtureDir,
    taskWorkloadPath,
    visibleTerminalIds,
    outputTerminalIds,
    perfTrace: {
      before: perfTraceBefore,
      after: perfTraceAfter,
      logPath: perfTraceAfter?.logPath ?? perfTraceBefore?.logPath ?? null
    },
    scenarios: [scenario],
    derived
  }

  const json = JSON.stringify(report)
  console.log(`${LONGTAIL_RESULT_PREFIX}${json}`)
  window.electronAPI.debug.log(`${LONGTAIL_RESULT_PREFIX}${json}`)

  record('PILT-01-longtail-recorded', true, {
    id: scenario.id,
    promptInputAvgMs: promptInput.inputLatency.avgMs,
    promptInputStddevMs: promptInput.inputLatency.stddevMs,
    promptInputP99Ms: promptInput.inputLatency.p99Ms,
    promptInputP999Ms: promptInput.inputLatency.p999Ms,
    promptInputMaxMs: promptInput.inputLatency.maxMs,
    over100Ms: promptInput.over100Ms,
    over250Ms: promptInput.over250Ms,
    over500Ms: promptInput.over500Ms,
    stallWindowCount: stallWindows.length,
    worstBucket,
    avgFps: perf.avgFps,
    maxLongestFrameMs: perf.maxLongestFrameMs,
      avgIpcMsgPerSec: perf.avgIpcMsgPerSec,
      mainEventLoop: scenario.mainEventLoop,
      gitDiffPressure,
      gitHistoryPressure,
      sqlitePressure,
      gitRuntimeDelta: scenario.gitRuntime.delta
    })

  const over250Limit = Math.max(1, Math.floor(sampleCount * 0.002))
  const p99Ok = promptInput.inputLatency.p99Ms <= 160
  const p999Ok = promptInput.inputLatency.p999Ms <= 300
  const maxOk = promptInput.inputLatency.maxMs <= 600
  const stddevOk = promptInput.inputLatency.stddevMs <= 60
  const over250Ok = (promptInput.over250Ms ?? Number.POSITIVE_INFINITY) <= over250Limit
  const over500Ok = (promptInput.over500Ms ?? Number.POSITIVE_INFINITY) === 0
  const mismatchOk = promptInput.mismatches === 0
  const mainEventLoop = scenario.mainEventLoop
  const mainEventLoopAvailableOk = !window.electronAPI.debug.perfTraceEnabled || Boolean(mainEventLoop)
  const mainEventLoopMaxOk = !mainEventLoop || mainEventLoop.maxDriftMs <= 1000
  const mainEventLoopOver1000Ok = !mainEventLoop || mainEventLoop.over1000Ms === 0
  const mainEventLoopOver3000Ok = !mainEventLoop || mainEventLoop.over3000Ms === 0
  const mainEventLoopOver6000Ok = !mainEventLoop || mainEventLoop.over6000Ms === 0
  record('PILT-02-longtail-thresholds', p99Ok && p999Ok && maxOk && stddevOk && over250Ok && over500Ok && mismatchOk && mainEventLoopAvailableOk && mainEventLoopMaxOk && mainEventLoopOver1000Ok && mainEventLoopOver3000Ok && mainEventLoopOver6000Ok, {
    thresholds: {
      p99Ms: 160,
      p999Ms: 300,
      maxMs: 600,
      stddevMs: 60,
      over250Ms: over250Limit,
      over500Ms: 0,
      mismatches: 0,
      mainEventLoopMaxDriftMs: 1000,
      mainEventLoopOver1000Ms: 0,
      mainEventLoopOver3000Ms: 0,
      mainEventLoopOver6000Ms: 0
    },
    actual: {
      p99Ms: promptInput.inputLatency.p99Ms,
      p999Ms: promptInput.inputLatency.p999Ms,
      maxMs: promptInput.inputLatency.maxMs,
      stddevMs: promptInput.inputLatency.stddevMs,
      over250Ms: promptInput.over250Ms,
      over500Ms: promptInput.over500Ms,
      mismatches: promptInput.mismatches,
      stallWindowCount: stallWindows.length,
      stallWindowGapsMs,
      mainEventLoopMaxDriftMs: mainEventLoop?.maxDriftMs ?? null,
      mainEventLoopOver1000Ms: mainEventLoop?.over1000Ms ?? null,
      mainEventLoopOver3000Ms: mainEventLoop?.over3000Ms ?? null,
      mainEventLoopOver6000Ms: mainEventLoop?.over6000Ms ?? null,
      perfTraceLogPath: perfTraceAfter?.logPath ?? null
    }
  })

  return results
}
