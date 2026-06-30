/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

import { app, ipcMain, BrowserWindow, Menu, dialog, shell, clipboard } from 'electron'
import { dirname, join, resolve, sep } from 'path'
import { readFileSync, writeFileSync, statSync } from 'fs'
import { ptyManager, PtyOptions } from './pty-manager'
import { TerminalGitInfoBridge } from './terminal-git-info-bridge'
import { getPromptStorage, Prompt } from './prompt-storage'
import { getTerminalConfigStorage, TerminalWindowConfig } from './terminal-config-storage'
import { getCommandPresetStorage, CommandPreset } from './command-preset-storage'
import { getCodingAgentConfigStorage, CodingAgentConfigInput } from './coding-agent-config-storage'
import { getCodingAgentRuntimeInfo } from './coding-agent-runtime'
import { getAppStateStorage, AppState } from './app-state-storage'
import { readCurrentChangelog } from './changelog'
import { getTelemetryService } from './telemetry/telemetry-service'
import { getTelemetryConsent, setTelemetryConsent } from './telemetry/telemetry-consent'
import { applyTerminalUserEnvVars, buildColorCapableTerminalEnv } from './terminal-env'
import {
  getTerminalCwd,
  getTerminalGitInfo,
  setTerminalCwdAuthorityResolver,
  setTerminalCwdDetectedHandler
} from './git-utils'
import type {
  GitFileContentRequestOptions,
  GitFileStatus,
  GitHistoryDiffOptions,
  GitHistoryFileContentOptions
} from './git-utils'
import { gitIpcWorkerClient } from './git-ipc-worker-client'
import { RepoPrewarmCoordinator } from './git-repo-prewarm'
import {
  readProjectFile,
  readProjectFileChunk,
  resolveInRoot,
  saveProjectFile,
  createProjectFile,
  createProjectFolder,
  renameProjectPath,
  deleteProjectPath,
  projectFilesExist,
} from './project-editor-utils'
import { projectFsWorkerClient } from './project-fs-worker-client'
import { sqliteWorkerClient } from './sqlite-worker-client'
import { getSettingsStorage, SettingsState, ShortcutConfig } from './settings-storage'
import { getShortcutManager } from './shortcut-manager'
import { getAppInfo } from './app-info'
import { createDiagnosticBundle } from './diagnostic-bundle'
import { isUsableTerminalCwd } from './terminal-cwd-validation'
import { getFeedbackStorage } from './feedback-storage'
import { gitRuntimeManager } from './git-runtime-manager'
import { mainWorkScheduler } from './main-work-scheduler'
import { openExternalUrlWithConfirm } from './external-link-guard'
import { RipgrepSearchManager } from './ripgrep-search'
import { browserViewManager } from './browser-view-manager'
import { FileWatchManager } from './file-watch-manager'
import { ImageWatchManager } from './image-watch-manager'
import { ProjectTreeWatchManager } from './project-tree-watch-manager'
import { gitDiffCacheInvalidator } from './git-diff-cache-invalidator'
import {
  fetchFileContentWithCache,
  gitDiffPrecomputeScheduler,
  inspectContentCacheStats,
  invalidateContentCacheForProject,
  installContentCacheInvalidatorOnce
} from './git-diff-content-cache-wiring'
import { gitStateMirrorRouter } from './git-state-mirror-router'
import { getUpdateService } from './update-service'
import { PERF_TRACE_EVENT } from '../../src/utils/perf-trace-names'
import { IPC } from '../shared/ipc-channels'
import { performanceTrace, TraceContext } from './performance-trace'
import { traceStore } from './trace-store'

let gitWatchManager: TerminalGitInfoBridge | null = null
let ripgrepSearchManager: RipgrepSearchManager | null = null
let fileWatchManager: FileWatchManager | null = null
let imageWatchManager: ImageWatchManager | null = null
let projectTreeWatchManager: ProjectTreeWatchManager | null = null
let feedbackDebugLastOpenedUrl: string | null = null
let terminalIpcDiagTimer: ReturnType<typeof setInterval> | null = null

type TerminalInputSequencePayload = {
  kind: 'raw' | 'paste'
  content: string
  traceContext?: TraceContext
}

type DebugApiTerminalWriteResult = {
  ok: boolean
  status: number
  body?: string
  error?: string
}

function invalidateGitDiffAfterKnownMutation(project: string | undefined | null): void {
  if (!project) return
  gitDiffCacheInvalidator.invalidate(project, 'manual')
  invalidateContentCacheForProject(project, 'invalidated-mutation')
}

async function invalidateGitDiffAfterProjectFileSave(root: string, fullPath: string | null): Promise<void> {
  const projects = new Set<string>([resolve(root)])
  if (fullPath) {
    try {
      const repoRoot = await gitIpcWorkerClient.resolveRepoRoot(dirname(fullPath))
      if (repoRoot) projects.add(repoRoot)
    } catch {
      // Non-git project saves still invalidate the editor root bucket.
    }
  }
  for (const project of projects) {
    invalidateGitDiffAfterKnownMutation(project)
  }
}

const BRACKETED_PASTE_ENABLE_RE = /\x1b\[\?2004h/g
const BRACKETED_PASTE_DISABLE_RE = /\x1b\[\?2004l/g
const BRACKETED_PASTE_START = '\x1b[200~'
const BRACKETED_PASTE_END = '\x1b[201~'
const INTERACTIVE_BOOST_WINDOW_MS = 250

function prepareTextForPaste(text: string): string {
  return text.replace(/\r?\n/g, '\r')
}

function wrapBracketedPaste(text: string, enabled: boolean): string {
  return enabled ? `${BRACKETED_PASTE_START}${text}${BRACKETED_PASTE_END}` : text
}

function updateBracketedPasteMode(current: boolean, data: string): boolean {
  let next = current
  BRACKETED_PASTE_ENABLE_RE.lastIndex = 0
  BRACKETED_PASTE_DISABLE_RE.lastIndex = 0

  for (const _ of data.matchAll(BRACKETED_PASTE_ENABLE_RE)) {
    next = true
  }
  for (const _ of data.matchAll(BRACKETED_PASTE_DISABLE_RE)) {
    next = false
  }
  return next
}

/**
 * Batches PTY output data into periodic flushes to reduce IPC message rate.
 * Instead of sending one IPC message per onData callback (which can be
 * 400-1000/s across 4 terminals), data is buffered and flushed at ~60fps.
 */
type TerminalDataSendPath = 'fast' | 'boost' | 'batched'
type TerminalDataSend = (id: string, data: string, meta: { path: TerminalDataSendPath; bufferAgeMs: number }) => void

class TerminalDataBuffer {
  private chunks: string[] = []
  private totalBytes = 0
  private timer: ReturnType<typeof setTimeout> | null = null
  private disposed = false
  private interactiveBoostUntil = 0
  private visible = true
  private firstPushAt = 0

  // IPC flush interval.  The previous value of 16 ms (~60 fps) sent up to
  // 360 IPC messages/s across 6 terminals, saturating the renderer's main
  // thread with callback processing alone.  100 ms (~10 fps per terminal)
  // reduces IPC traffic to ~60 msgs/s while the renderer-side throttle
  // (50 ms rAF) still provides smooth visual updates by coalescing writes.
  // Terminal text remains highly responsive — 100 ms of buffering is
  // imperceptible for human reading of scrolling output.
  private static readonly FLUSH_INTERVAL_MS = 100
  // Force flush when buffer exceeds 64KB (keeps large bursts responsive)
  private static readonly FORCE_FLUSH_BYTES = 64 * 1024
  private static readonly HIDDEN_MAX_BYTES = 512 * 1024

  constructor(
    private readonly terminalId: string,
    private readonly send: TerminalDataSend
  ) {}

  // Small data threshold for the fast path.  Keystroke echoes from the PTY
  // are typically 1-4 bytes; ANSI escape sequences for cursor movement or
  // colour are ~10-30 bytes.  128 bytes is generous enough to cover all
  // interactive typing feedback while still routing bulk command output
  // through the batched path.
  private static readonly FAST_PATH_THRESHOLD = 128

  // Whether the fast path is enabled for this terminal.  Disabled for
  // hidden terminals to avoid generating high-rate IPC traffic with no
  // user-visible benefit (the renderer buffers hidden terminal data anyway).
  private _fastPathEnabled = true

  setFastPathEnabled(enabled: boolean): void {
    this._fastPathEnabled = enabled
  }

  setVisible(visible: boolean): void {
    if (this.disposed || this.visible === visible) return
    this.visible = visible
    if (visible) {
      this.flush()
      return
    }
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    this.trimToMaxBytes(TerminalDataBuffer.HIDDEN_MAX_BYTES)
  }

  notifyInteractiveInput(): void {
    this.interactiveBoostUntil = Date.now() + INTERACTIVE_BOOST_WINDOW_MS
    if (this.visible && this.chunks.length > 0) {
      this.flush()
    }
  }

  push(data: string): void {
    if (this.disposed) return

    if (!this.visible) {
      this.chunks.push(data)
      this.totalBytes += data.length
      this.trimToMaxBytes(TerminalDataBuffer.HIDDEN_MAX_BYTES)
      return
    }

    const interactiveBoostActive = this._fastPathEnabled && Date.now() < this.interactiveBoostUntil

    if (interactiveBoostActive && this.chunks.length > 0) {
      this.flush()
    }

    if (interactiveBoostActive) {
      this.send(this.terminalId, data, { path: 'boost', bufferAgeMs: 0 })
      return
    }

    // Fast path: small interactive data (keystroke echoes, short escape
    // sequences) is sent immediately when no data is already buffered.
    // This eliminates the 100 ms batching delay for interactive typing
    // while keeping the batched path for bulk output.
    // Only enabled for visible terminals — hidden terminals always batch.
    if (
      this._fastPathEnabled &&
      data.length <= TerminalDataBuffer.FAST_PATH_THRESHOLD &&
      this.chunks.length === 0
    ) {
      this.send(this.terminalId, data, { path: 'fast', bufferAgeMs: 0 })
      return
    }

    if (this.chunks.length === 0) {
      this.firstPushAt = Date.now()
    }
    this.chunks.push(data)
    this.totalBytes += data.length

    if (this.totalBytes >= TerminalDataBuffer.FORCE_FLUSH_BYTES) {
      this.flush()
      return
    }

    if (!this.timer) {
      this.timer = setTimeout(() => {
        this.timer = null
        this.flush()
      }, TerminalDataBuffer.FLUSH_INTERVAL_MS)
    }
  }

  flush(): void {
    const startUs = performanceTrace.nowUs()
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    if (this.chunks.length === 0) return
    const chunkCount = this.chunks.length
    const byteCount = this.totalBytes
    const merged = this.chunks.length === 1 ? this.chunks[0] : this.chunks.join('')
    const bufferAgeMs = this.firstPushAt > 0 ? Date.now() - this.firstPushAt : 0
    this.chunks = []
    this.totalBytes = 0
    this.firstPushAt = 0
    this.send(this.terminalId, merged, { path: 'batched', bufferAgeMs })
    performanceTrace.recordComplete('terminal.buffer.flush', startUs, {
      terminalId: this.terminalId,
      chunkCount,
      bytes: byteCount
    }, 'terminal')
  }

  private trimToMaxBytes(maxBytes: number): void {
    while (this.totalBytes > maxBytes && this.chunks.length > 1) {
      const dropped = this.chunks.shift()!
      this.totalBytes -= dropped.length
    }

    if (this.totalBytes <= maxBytes || this.chunks.length === 0) return

    const retained = this.chunks[0].slice(-maxBytes)
    this.chunks[0] = retained
    this.totalBytes = retained.length
  }

  dispose(): void {
    this.disposed = true
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    if (this.visible) {
      this.flush()
    } else {
      this.chunks = []
      this.totalBytes = 0
    }
  }
}

// Active data buffers keyed by terminal ID
const terminalDataBuffers = new Map<string, TerminalDataBuffer>()

// Tracks the desired fast-path state per terminal so that a
// `terminal:set-buffer-fast-path` message arriving before the buffer is
// created (race between renderer setVisibility and terminal:create) is
// not lost.  When a new buffer is created it reads from this map.
const terminalFastPathState = new Map<string, boolean>()
const terminalOutputVisibilityState = new Map<string, boolean>()
const terminalBracketedPasteState = new Map<string, boolean>()

// Buffer request waiting queue
interface TerminalBufferResult {
  success: boolean
  terminalId: string
  content?: string
  totalLines?: number
  returnedLines?: number
  returnedChars?: number
  truncated?: boolean
  capturedAt?: number
  bufferType?: 'normal' | 'alternate'
  error?: string
}

const bufferRequestCallbacks = new Map<string, {
  resolve: (result: TerminalBufferResult) => void
  timer: ReturnType<typeof setTimeout>
}>()

let bufferRequestCounter = 0

// Prompt Bridge request waiting queue
const promptBridgeCallbacks = new Map<string, {
  resolve: (result: PromptBridgeSendResult) => void
  timer: ReturnType<typeof setTimeout>
  startUs: number
  flowId: string
  terminalId: string
  action: PromptBridgeAction
}>()

let promptBridgeCounter = 0

interface RegisterIpcHandlersOptions {
  onSettingsChanged?: (settings: SettingsState) => void
  onRestartToApplyUpdate?: () => Promise<{ success: boolean; error?: string }>
  onGracefulQuitForDebug?: () => Promise<{ success: boolean; error?: string }>
  getApiPort?: () => number
}

/**
 * Get terminal buffer contents from the renderer process.
 * Requests xterm.js buffer data through IPC.
 */
export function getTerminalBuffer(
  mainWindow: BrowserWindow,
  terminalId: string,
  options?: { mode?: string; lastLines?: number; lastChars?: number; trimTrailingEmpty?: boolean; buffer?: string }
): Promise<TerminalBufferResult> {
  return new Promise((resolve) => {
    if (mainWindow.isDestroyed()) {
      resolve({ success: false, terminalId, error: 'Window was destroyed' })
      return
    }

    const requestId = `buf-${++bufferRequestCounter}-${Date.now()}`

    const timer = setTimeout(() => {
      bufferRequestCallbacks.delete(requestId)
      resolve({ success: false, terminalId, error: 'Request timed out (5 seconds)' })
    }, 5000)

    bufferRequestCallbacks.set(requestId, { resolve, timer })

    mainWindow.webContents.send(IPC.TERMINAL_REQUEST_BUFFER, requestId, terminalId, options)
  })
}

export type PromptBridgeAction = 'send' | 'execute' | 'send-and-execute'

export interface PromptBridgeSendResult {
  success: boolean
  successIds: string[]
  sentOnlyIds: string[]
  failedIds: string[]
  issues?: Array<{
    terminalId: string
    status: 'sent-only' | 'failed'
    reason: 'unsafe-multiline-send' | 'unsafe-multiline-execute' | 'send-failed' | 'execute-failed'
    message: string
    error?: string
  }>
  error?: string
}

/**
 * Send commands to the rendering process via Prompt Bridge
 * The rendering process calls the existing Prompt sending logic (including split-write and history records)
 */
export function sendPromptViaBridge(
  mainWindow: BrowserWindow,
  terminalId: string,
  content: string,
  action: PromptBridgeAction,
  traceContext?: TraceContext
): Promise<PromptBridgeSendResult> {
  return new Promise((resolve) => {
    if (mainWindow.isDestroyed()) {
      resolve({ success: false, successIds: [], sentOnlyIds: [], failedIds: [terminalId], error: 'Window was destroyed' })
      return
    }

    const requestId = `prompt-bridge-${++promptBridgeCounter}-${Date.now()}`
    const flowId = traceContext?.traceFlowId || performanceTrace.createFlowId('prompt-bridge')
    const startUs = performanceTrace.nowUs()
    performanceTrace.recordFlowStep('prompt.bridge.send', flowId, {
      requestId,
      terminalId,
      action,
      ...performanceTrace.summarizeText('payload', content)
    }, 'prompt')

    // 10 second timeout to cover prompt delivery plus any renderer-side coordination.
    const timer = setTimeout(() => {
      promptBridgeCallbacks.delete(requestId)
      performanceTrace.recordComplete('prompt.bridge', startUs, {
        requestId,
        terminalId,
        action,
        result: 'timeout'
      }, 'prompt')
      performanceTrace.recordFlowEnd('prompt.bridge.timeout', flowId, { requestId, terminalId, action }, 'prompt')
      resolve({ success: false, successIds: [], sentOnlyIds: [], failedIds: [terminalId], error: 'Request timed out (10 seconds)' })
    }, 10000)

    promptBridgeCallbacks.set(requestId, { resolve, timer, startUs, flowId, terminalId, action })

    mainWindow.webContents.send(IPC.PROMPT_BRIDGE_SEND, {
      requestId,
      terminalId,
      content,
      action,
      traceFlowId: flowId
    })
  })
}

export function registerIpcHandlers(mainWindow: BrowserWindow, options: RegisterIpcHandlersOptions = {}): void {
  const shouldLog = process.env.ONWARD_DEBUG === '1' || process.env.ELECTRON_ENABLE_LOGGING === '1'
  const log = (...args: unknown[]) => {
    if (shouldLog) {
      console.log(...args)
    }
  }

  performanceTrace.startGitRuntimeMonitor(() => gitRuntimeManager.getMetrics())

  // --- Diagnostic counters (ONWARD_DEBUG=1 / ONWARD_PERF_TRACE=1) ---
  const ipcDataCounters = new Map<string, { messages: number; bytes: number }>()
  if (shouldLog || performanceTrace.isEnabled()) {
    terminalIpcDiagTimer = setInterval(() => {
      for (const [tid, c] of ipcDataCounters) {
        if (c.messages > 0) {
          if (shouldLog) {
            console.log(`[PerfDiag] terminal:data tid=${tid} ipc/s=${c.messages} bytes/s=${c.bytes}`)
          }
          performanceTrace.record(PERF_TRACE_EVENT.MAIN_TERMINAL_DATA_IPC_SUMMARY, {
            terminalId: tid,
            messagesPerSecond: c.messages,
            bytesPerSecond: c.bytes
          })
          c.messages = 0
          c.bytes = 0
        }
      }
    }, 1000)
  }

  // GitStateMirror router — pub/sub bridge to the mirror Worker Thread.
  // Must initialise BEFORE TerminalGitInfoBridge because the bridge
  // registers main-process listeners on the router at construction time.
  gitStateMirrorRouter.init(mainWindow)
  setTerminalCwdAuthorityResolver((terminalId) => gitStateMirrorRouter.getTerminalCwd(terminalId))
  setTerminalCwdDetectedHandler((terminalId, cwd) => gitStateMirrorRouter.pushTerminalCwd(terminalId, cwd))

  // Bridge replaces the polling GitWatchManager. It subscribes each
  // terminal to the Authority Worker for its current cwd and emits
  // GIT_TERMINAL_INFO purely on event triggers (mirror-update / cwd-
  // change). No periodic polling anywhere.
  // Repo prewarm coordinator (prewarm-on-cwd-switch, decisions ⑥/⑦). Front-runs
  // the Git Diff list + per-file content (and, P4, the History caches) the
  // moment the bridge resolves a NEW cwd, so opening Diff / History only reads
  // warm caches. Injected into the bridge so the trigger fires on attach only;
  // dedup (lastPrewarmedCwds) + the low-priority lanes live in the coordinator.
  //
  // attachDelayMs: how long the prewarm waits after a cwd attach before warming,
  //   so a foreground open in that window wins the worker (yield-to-foreground).
  const REPO_PREWARM_ATTACH_DELAY_MS = 2500
  // Grace window after a cwd is abandoned (no live terminal) before its wasted
  // background precompute burst is cancelled. A quick A→B→A return within this
  // window aborts the cancel, so rapid switching does not discard half-warmed
  // work; past it, the abandoned burst stops competing for EDR git spawns.
  const REPO_PREWARM_DETACH_GRACE_MS = 2500
  const repoPrewarmCoordinator = new RepoPrewarmCoordinator({
    // Yield-to-foreground delay: the moment a terminal attaches, an imminent
    // foreground Diff/History open must win the (EDR-taxed) worker and populate
    // the request cache FIRST. Without this, the open coalesces onto the
    // low-priority background warm and inherits its slow timing. The prewarm
    // fires this long after attach, by which point the foreground open has
    // cached its result and the prewarm is a cheap cache-hit / no-op.
    attachDelayMs: REPO_PREWARM_ATTACH_DELAY_MS,
    detachGraceMs: REPO_PREWARM_DETACH_GRACE_MS,
    warmDiffList: (cwd) => gitIpcWorkerClient.warmDiffCache(cwd),
    kickContentPrecompute: (project) => gitDiffPrecomputeScheduler.onProjectInvalidated(project),
    // Abandoned-cwd cancel (burst lane only): cancelProject bumps the burst
    // generation so any in-flight precompute for the left cwd aborts; the
    // diff-list warm is untouched. Frees the EDR git-spawn budget for the cwd
    // the user landed on (the "boost latest" lever on a spawn-bound host).
    cancelContentPrecompute: (project) => { gitDiffPrecomputeScheduler.cancelProject(project) },
    // History prewarm (decision ⑦ + git-op aggregation A2): warm the L8 list
    // first page (one `git log`), then the L9 commit-diff set for that whole
    // page in a SINGLE `git log --raw --numstat` spawn (replacing the old N×2
    // per-commit `git diff` spawns — the dominant History-prewarm EDR tax). Both
    // run in the low `::history-precompute` lane; the batch keys each commit
    // exactly as the renderer's single-commit click does, so a click is an L9 HIT.
    prewarmHistory: async (cwd, repoRoot, branchOid, refsDigest) => {
      const startedMs = Date.now()
      // MUST pass the SAME refsDigest the on-demand handler injects (both read the
      // same getLatest snapshot) or the prewarmed key (…::norefs) is one the
      // renderer never requests → every open misses. background=true → low lane.
      const list = await gitIpcWorkerClient.getHistory(cwd, 50, 0, branchOid, refsDigest, true)
      if (!list?.success) return
      const batch = await gitIpcWorkerClient.prewarmHistoryDiffs(cwd, branchOid, 50).catch(() => ({ warmed: 0 }))
      performanceTrace.record(PERF_TRACE_EVENT.MAIN_GIT_PREWARM_HISTORY_DONE, {
        cwd, repoRoot, branchOid, commitsWarmed: batch.warmed, durationMs: Date.now() - startedMs
      })
    },
    trace: (event, payload) => performanceTrace.record(event, payload)
  })

  // ONWARD_DISABLE_REPO_PREWARM=1 turns off the prewarm-on-cwd-switch coordinator
  // entirely (the bridge gets no prewarm hooks), reverting to the pre-prewarm
  // behaviour (Diff/History warmed lazily on open + the renderer-fallback warm).
  // For A/B isolation when diagnosing whether the prewarm competes with a
  // foreground open on EDR-throttled hosts. Read once at handler setup.
  const repoPrewarmDisabled = process.env.ONWARD_DISABLE_REPO_PREWARM === '1'
  if (repoPrewarmDisabled) {
    console.log('[git-repo-prewarm] disabled (ONWARD_DISABLE_REPO_PREWARM=1)')
  }
  gitWatchManager = new TerminalGitInfoBridge((terminalId, info) => {
    if (mainWindow.isDestroyed()) return
    mainWindow.webContents.send(IPC.GIT_TERMINAL_INFO, terminalId, info)
  }, repoPrewarmDisabled ? undefined : {
    // Attach (new cwd) → warm Diff (once/cwd) + History (once/cwd::branchOid).
    onCwdAttached: (req) => { void repoPrewarmCoordinator.prewarm(req) },
    // Mirror update → History re-warm only when branchOid moved (dedup no-op otherwise).
    onMirrorUpdated: (req) => { void repoPrewarmCoordinator.prewarmHistory(req) },
    // cwd left (no other live terminal) → grace-windowed cancel of its abandoned
    // background precompute so rapid switching stops burning EDR git spawns.
    onCwdDetached: (cwd) => { repoPrewarmCoordinator.onCwdDetached(cwd) }
  })
  fileWatchManager = new FileWatchManager(mainWindow)
  imageWatchManager = new ImageWatchManager(mainWindow)
  projectTreeWatchManager = new ProjectTreeWatchManager(mainWindow)

  // When the GitStateMirror authority reports a repo mutation we need to:
  //   (1) drop the cached diff inside the git-ipc-worker (where getGitDiff
  //       and gitDiffRequestCache actually live in the normal IPC path), and
  //   (2) tell the renderer so an open GitDiffViewer can re-fetch.
  // Order matters: invalidate the worker cache BEFORE the renderer learns
  // about the change, so any reactive refetch the renderer kicks off lands
  // on a worker whose cache is already empty.
  gitDiffCacheInvalidator.addListener((cwd, reason) => {
    gitIpcWorkerClient.invalidateDiffCache(cwd, reason)
    if (mainWindow.isDestroyed()) return
    mainWindow.webContents.send(IPC.GIT_DIFF_CACHE_INVALIDATED, cwd, reason)
  })

  // Content cache + precompute scheduler. Subscribes to the same invalidator
  // signal above so per-project file-body cache stays in sync with the
  // GitStateMirror authority.
  installContentCacheInvalidatorOnce()

  ipcMain.on(IPC.DEBUG_LOG, (_event, payload: { message?: string; data?: unknown }) => {
    log('[RendererDebug]', payload?.message ?? '', payload?.data ?? '')
  })
  ipcMain.on(IPC.DEBUG_PERF_TRACE, (rawEvent, payload: { event?: string; data?: Record<string, unknown>; terminalId?: string }) => {
    if (!payload?.event) return
    // Tag the renderer's WebContents id so the logger can map it to a
    // stable `tid` on the Chrome-trace / Perfetto side. Renderers share
    // pid=2 with tid = wc.id, so individual windows / utilities land on
    // their own thread track in the UI.
    // If `terminalId` is present, the logger routes the event onto the
    // per-Task virtual tid (so every hop for that task lines up on one
    // Perfetto row under the renderer process).
    const wc = rawEvent.sender
    const tid = wc?.id ?? 0
    performanceTrace.record(payload.event, payload.data, {
      process: 'renderer',
      tid,
      terminalId: payload.terminalId
    })
  })

  // Autotest-only: synchronously emit the AUTOTEST_BUNDLE_MARKER event so
  // the V10 closed-loop check can find it after the bundle IPC runs
  // rotate + read + write. Production callers must never reach this —
  // we gate the side-effect on `ONWARD_AUTOTEST=1` and the rendered
  // payload's `feedback.diagnosticBundle.button` doesn't expose this
  // path. Returns once `traceStore.writeSync` has flushed the event
  // line into the kernel buffer of the active chunk fd, so the autotest
  // can immediately call the bundle IPC and trust that the marker is
  // already on disk.
  ipcMain.handle(
    IPC.DEBUG_EMIT_BUNDLE_MARKER,
    async (_, payload: { uuid: string; label?: string }) => {
      try {
        if (process.env.ONWARD_AUTOTEST !== '1') {
          return { success: false, error: 'debug:emit-bundle-marker requires ONWARD_AUTOTEST=1' }
        }
        if (!payload || typeof payload.uuid !== 'string' || payload.uuid.length === 0) {
          return { success: false, error: 'invalid payload: uuid required' }
        }
        performanceTrace.record(PERF_TRACE_EVENT.AUTOTEST_BUNDLE_MARKER, {
          uuid: payload.uuid,
          label: payload.label
        })
        return {
          success: true,
          chunkPath: traceStore.getCurrentChunkPath(),
          // Helpful for autotest debugging: the on-disk size right after
          // the writeSync. The marker line is the last bytes appended.
          chunkBytesAfterEmit: 0 // we don't expose internal counter; size is observable via fs.statSync if needed
        }
      } catch (error) {
        return { success: false, error: String(error) }
      }
    }
  )

  // Listen to buffer responses returned by the renderer process
  ipcMain.on(IPC.TERMINAL_BUFFER_RESPONSE, (_event, requestId: string, result: TerminalBufferResult) => {
    const pending = bufferRequestCallbacks.get(requestId)
    if (pending) {
      clearTimeout(pending.timer)
      bufferRequestCallbacks.delete(requestId)
      pending.resolve(result)
    }
  })

  // Listen to Prompt Bridge responses returned by the renderer process
  ipcMain.on(IPC.PROMPT_BRIDGE_RESPONSE, (_event, requestId: string, result: PromptBridgeSendResult) => {
    const pending = promptBridgeCallbacks.get(requestId)
    if (pending) {
      clearTimeout(pending.timer)
      promptBridgeCallbacks.delete(requestId)
      performanceTrace.recordComplete('prompt.bridge', pending.startUs, {
        requestId,
        terminalId: pending.terminalId,
        action: pending.action,
        successCount: result.successIds.length,
        sentOnlyCount: result.sentOnlyIds.length,
        failedCount: result.failedIds.length,
        result: result.success ? 'success' : 'partial-or-failed'
      }, 'prompt')
      performanceTrace.recordFlowStep('prompt.bridge.response', pending.flowId, {
        requestId,
        terminalId: pending.terminalId,
        action: pending.action,
        successCount: result.successIds.length,
        sentOnlyCount: result.sentOnlyIds.length,
        failedCount: result.failedIds.length
      }, 'prompt')
      pending.resolve(result)
    }
  })
  // --- Telemetry ---
  ipcMain.handle(IPC.TELEMETRY_TRACK, (_, name: string, properties?: Record<string, string | number | boolean | null>) => {
    getTelemetryService().track(name, properties ?? undefined)
  })
  ipcMain.handle(IPC.TELEMETRY_GET_CONSENT, () => {
    return getTelemetryConsent()
  })
  ipcMain.handle(IPC.TELEMETRY_SET_CONSENT, (_, consent: boolean) => {
    const instanceId = setTelemetryConsent(consent)
    getTelemetryService().onConsentChanged(consent, instanceId)
    return { instanceId }
  })

  ipcMain.handle(IPC.DEBUG_GET_APP_METRICS, () => {
    return app.getAppMetrics()
  })
  ipcMain.handle(IPC.DEBUG_FOCUS_WINDOW, () => {
    if (mainWindow.isDestroyed()) return false

    if (mainWindow.isMinimized()) {
      mainWindow.restore()
    }

    mainWindow.show()
    mainWindow.focus()
    mainWindow.moveTop()

    if (process.platform === 'darwin') {
      app.dock?.show()
      app.focus({ steal: true })
    }

    return mainWindow.isFocused()
  })
  ipcMain.handle(IPC.DEBUG_GET_GIT_RUNTIME_METRICS, () => {
    return gitRuntimeManager.getMetrics()
  })
  ipcMain.handle(IPC.DEBUG_GET_MAIN_WORK_METRICS, () => {
    return mainWorkScheduler.getMetrics()
  })
  ipcMain.handle(IPC.DEBUG_GET_PERF_TRACE_INFO, () => {
    return performanceTrace.getInfo()
  })
  ipcMain.handle(IPC.DEBUG_GIT_DIFF_GET_DEBUG_STATS, async () => {
    return await inspectContentCacheStats()
  })
  ipcMain.handle(IPC.DEBUG_RESET_PERF_TRACE_METRICS, () => {
    return performanceTrace.resetEventLoopMetrics()
  })
  ipcMain.handle('debug:get-api-server-port', () => {
    return options.getApiPort?.() ?? 0
  })
  ipcMain.handle('debug:post-api-terminal-write', async (
    _event,
    payload?: { terminalId?: unknown; text?: unknown; execute?: unknown }
  ): Promise<DebugApiTerminalWriteResult> => {
    const port = options.getApiPort?.() ?? 0
    const terminalId = typeof payload?.terminalId === 'string' ? payload.terminalId : ''
    const text = typeof payload?.text === 'string' ? payload.text : ''
    const execute = payload?.execute === true

    if (port <= 0) {
      return { ok: false, status: 0, error: 'API server is not available.' }
    }
    if (!terminalId) {
      return { ok: false, status: 0, error: 'Missing terminalId.' }
    }

    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/terminal/${encodeURIComponent(terminalId)}/write`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
        body: JSON.stringify({ text, execute })
      })
      return {
        ok: response.ok,
        status: response.status,
        body: await response.text()
      }
    } catch (error) {
      return { ok: false, status: 0, error: String(error) }
    }
  })
  ipcMain.handle('debug:autotest-write-external-file', async (
    _event,
    payload?: { root?: unknown; relPath?: unknown; content?: unknown }
  ): Promise<{ ok: boolean; error?: string }> => {
    // Autotest-only: write a file directly via the main process so a test can
    // simulate an EXTERNAL edit (one the app's save path never initiates)
    // deterministically, WITHOUT depending on an interactive shell executing a
    // queued PTY command. The git-diff staleness suite (GDS-44/46) used a PTY
    // shell write that is EDR-fragile under full-suite load (the command can sit
    // unexecuted past even the adaptive observe budget -> fileObserved:false). A
    // direct fs write is instant and the watcher / GitStateMirror still has to
    // DISCOVER the untracked mutation, so the external-edit contract is preserved.
    // Gated strictly on ONWARD_AUTOTEST so it never exists in production builds.
    if (process.env.ONWARD_AUTOTEST !== '1') {
      return { ok: false, error: 'debug:autotest-write-external-file requires ONWARD_AUTOTEST=1' }
    }
    const root = typeof payload?.root === 'string' ? payload.root : ''
    const relPath = typeof payload?.relPath === 'string' ? payload.relPath : ''
    const content = typeof payload?.content === 'string' ? payload.content : ''
    if (!root || !relPath) {
      return { ok: false, error: 'Missing root or relPath.' }
    }
    try {
      writeFileSync(resolve(root, relPath), content, 'utf-8')
      return { ok: true }
    } catch (error) {
      return { ok: false, error: String(error) }
    }
  })
  ipcMain.handle('performance-trace:record', (_event, payload) => {
    performanceTrace.recordRendererEvent(payload)
  })
  ipcMain.handle('performance-trace:get-status', () => {
    return performanceTrace.getStatus()
  })
  ipcMain.handle('performance-trace:flush', () => {
    return performanceTrace.flush('debug-ipc')
  })
  ipcMain.handle(IPC.DEBUG_FEEDBACK_RESET, () => {
    feedbackDebugLastOpenedUrl = null
    getFeedbackStorage().debugReset()
  })
  ipcMain.handle(IPC.DEBUG_FEEDBACK_SET_MOCK_ISSUES, (_, issues) => {
    getFeedbackStorage().debugSetMockIssues(Array.isArray(issues) ? issues : [])
  })
  ipcMain.handle(IPC.DEBUG_FEEDBACK_GET_LAST_OPENED_URL, () => {
    return feedbackDebugLastOpenedUrl
  })
  ipcMain.handle(IPC.DEBUG_READ_TELEMETRY_LOG, () => {
    try {
      const logPath = getTelemetryService().logFilePath
      if (!logPath) return ''
      const { readFileSync, existsSync } = require('fs')
      if (!existsSync(logPath)) return ''
      return readFileSync(logPath, 'utf-8')
    } catch {
      return ''
    }
  })
  ipcMain.handle(IPC.DEBUG_QUIT, async () => {
    if (options.onGracefulQuitForDebug) {
      const result = await options.onGracefulQuitForDebug()
      if (!result.success) {
        throw new Error(result.error ?? 'Debug quit failed.')
      }
      return
    }

    // Flush telemetry and stop PTYs before debug/autotest exit.
    const timeout = new Promise<void>((resolve) => setTimeout(resolve, 8000))
    const shutdown = Promise.all([
      getTelemetryService().shutdown().catch(() => {}),
      ptyManager.shutdownAll().then((result) => {
        if (result.timedOut > 0) {
          console.warn(`[PTY] debug quit shutdown timed out: ${result.timedOut}/${result.total}`)
        }
      }).catch((error) => {
        console.warn('[PTY] debug quit shutdown failed:', error)
      })
    ]).then(() => cleanupIpcHandlers())

    Promise.race([shutdown, timeout]).finally(() => app.exit(0))
  })

  // Saved cwd for terminals running coding agents, so that
  // when the agent exits and the renderer calls terminal:create
  // to restart, we can restore the original working directory.
  const agentRestartCwdMap = new Map<string, string>()

  const createTerminalProcess = (id: string, options?: PtyOptions) => {
    try {
      let restoredPersistedCwd: string | null = null

      // If no cwd provided but we have a saved agent cwd, use it
      if (!options?.cwd) {
        const savedCwd = agentRestartCwdMap.get(id)
        if (savedCwd) {
          options = { ...options, cwd: savedCwd }
        }
      }
      if (!options?.cwd) {
        const persistedCwd = appStateStorage.getTerminalLastCwd(id)
        if (persistedCwd) {
          restoredPersistedCwd = persistedCwd
          options = { ...options, cwd: persistedCwd }
        }
      }
      // Clear the saved cwd after using it once
      agentRestartCwdMap.delete(id)

      if (options?.cwd && !isUsableTerminalCwd(options.cwd)) {
        console.warn('[PTY] Ignoring unusable terminal cwd:', { id, cwd: options.cwd })
        if (restoredPersistedCwd === options.cwd) {
          appStateStorage.setTerminalLastCwd(id, null)
        }
        options = { ...options }
        delete options.cwd
      }

      let ptyProcess
      try {
        ptyProcess = ptyManager.create(id, options)
      } catch (error) {
        if (!restoredPersistedCwd) {
          throw error
        }
        console.warn('[PTY] Falling back to default cwd after persisted cwd restore failed:', {
          id,
          cwd: restoredPersistedCwd,
          error: String(error)
        })
        appStateStorage.setTerminalLastCwd(id, null)
        const fallbackOptions = options ? { ...options } : {}
        delete fallbackOptions.cwd
        ptyProcess = ptyManager.create(id, fallbackOptions)
      }

      // IPC data buffer: merge high-frequency PTY output into batched sends
      const dataBuffer = new TerminalDataBuffer(id, (tid, mergedData, meta) => {
        if (!mainWindow.isDestroyed()) {
          mainWindow.webContents.send(IPC.TERMINAL_DATA, tid, mergedData)
          performanceTrace.record(PERF_TRACE_EVENT.MAIN_TERMINAL_DATA_IPC_SEND, {
            path: meta.path,
            bytes: mergedData.length,
            bufferAgeMs: meta.bufferAgeMs
          }, { terminalId: tid })
        }
        performanceTrace.recordInstant('terminal.ipc.send', {
          terminalId: tid,
          bytes: mergedData.length,
          flowId: performanceTrace.getTaskFlowId(tid) ?? undefined
        }, 'terminal')
        // Diagnostic counter
        if (shouldLog) {
          let c = ipcDataCounters.get(tid)
          if (!c) { c = { messages: 0, bytes: 0 }; ipcDataCounters.set(tid, c) }
          c.messages += 1
          c.bytes += mergedData.length
        }
      })
      terminalDataBuffers.set(id, dataBuffer)
      terminalBracketedPasteState.set(id, false)

      // Apply any fast-path state that arrived before the buffer was created
      // (e.g. setVisibility(id, false) sent before terminal:create completed).
      const pendingFastPath = terminalFastPathState.get(id)
      if (pendingFastPath !== undefined) {
        dataBuffer.setFastPathEnabled(pendingFastPath)
      }
      const pendingOutputVisibility = terminalOutputVisibilityState.get(id)
      if (pendingOutputVisibility !== undefined) {
        dataBuffer.setVisible(pendingOutputVisibility)
      }

      const dataDisposable = ptyProcess.onData((data) => {
        // Parse OSC 9;9 CWD reports from shell integration (Windows)
        ptyManager.detectCwd(id, data)
        const bracketedPasteMode = terminalBracketedPasteState.get(id) ?? false
        terminalBracketedPasteState.set(id, updateBracketedPasteMode(bracketedPasteMode, data))
        performanceTrace.markTaskOutput(id, data.length)
        performanceTrace.recordInstant('pty.output', {
          terminalId: id,
          bytes: data.length,
          bracketedPasteMode,
          flowId: performanceTrace.getTaskFlowId(id) ?? undefined
        }, 'pty')
        dataBuffer.push(data)

        // PTY-output → git-activity nudge is no longer needed: the
        // GitStateMirror Worker reacts to parcel-watcher events directly,
        // so any tracked-file change inside the cwd already triggers a
        // recompute. PTY output that isn't reflected in FS state (e.g.
        // `cd` only) lands via OSC PUSH_CWD instead.
      })

      const exitDisposable = ptyProcess.onExit(({ exitCode, signal }) => {
        performanceTrace.markTaskExited(id, exitCode, signal)
        if (!mainWindow.isDestroyed()) {
          mainWindow.webContents.send(IPC.TERMINAL_EXIT, id, exitCode, signal)
        }
      })

      ptyManager.registerListeners(id, [dataDisposable, exitDisposable])

      return { success: true, id }
    } catch (error) {
      console.error('Failed to create terminal:', error)
      return { success: false, error: String(error) }
    }
  }
  // App info
  ipcMain.handle(IPC.APP_GET_INFO, () => {
    return getAppInfo()
  })

  ipcMain.handle(IPC.FEEDBACK_LOAD, () => {
    return getFeedbackStorage().get()
  })

  ipcMain.handle(IPC.FEEDBACK_UPDATE_PREFERENCES, (_, payload) => {
    return getFeedbackStorage().updatePreferences(
      payload && typeof payload === 'object' ? payload : {}
    )
  })

  ipcMain.handle(IPC.FEEDBACK_CREATE_SUBMISSION, async (_, payload) => {
    const storage = getFeedbackStorage()
    const appInfo = getAppInfo()
    const result = storage.createSubmission(payload, {
      locale: payload?.locale === 'zh-CN' ? 'zh-CN' : 'en',
      platform: appInfo.platform,
      productName: appInfo.productName,
      version: appInfo.version,
      buildChannel: appInfo.buildChannel,
      releaseChannel: appInfo.releaseChannel,
      releaseOs: appInfo.releaseOs,
      createdAt: Date.now()
    })

    if (!result.success || !result.record) {
      return result
    }

    try {
      if (process.env.ONWARD_AUTOTEST === '1') {
        feedbackDebugLastOpenedUrl = result.record.prefilledUrl
        storage.markBrowserOpened(result.record.id)
        return {
          success: true,
          record: storage.getRecord(result.record.id) ?? result.record
        }
      }

      await shell.openExternal(result.record.prefilledUrl)
      storage.markBrowserOpened(result.record.id)
      return {
        success: true,
        record: storage.getRecord(result.record.id) ?? result.record
      }
    } catch (error) {
      storage.removeRecord(result.record.id)
      return {
        success: false,
        error: String(error)
      }
    }
  })

  ipcMain.handle(IPC.FEEDBACK_SYNC, async (_, recordId?: string, force?: boolean) => {
    return await getFeedbackStorage().sync(recordId, force === true)
  })

  ipcMain.handle(IPC.FEEDBACK_REOPEN_IN_BROWSER, async (_, recordId: string) => {
    const storage = getFeedbackStorage()
    const record = storage.getRecord(recordId)
    if (!record) {
      return { success: false, error: 'Feedback record not found.' }
    }

    try {
      if (process.env.ONWARD_AUTOTEST === '1') {
        feedbackDebugLastOpenedUrl = record.prefilledUrl
        storage.markBrowserOpened(recordId)
        return { success: true }
      }

      await shell.openExternal(record.prefilledUrl)
      storage.markBrowserOpened(recordId)
      return { success: true }
    } catch (error) {
      return { success: false, error: String(error) }
    }
  })

  ipcMain.handle(IPC.FEEDBACK_REMOVE_RECORD, (_, recordId: string) => {
    const storage = getFeedbackStorage()
    storage.removeRecord(recordId)
    return storage.get()
  })

  // Read NOTICE / ThirdPartyNotices file for open-source license display
  ipcMain.handle(IPC.APP_READ_NOTICE, () => {
    const basePath = app.isPackaged ? process.resourcesPath : app.getAppPath()
    // Prefer auto-generated ThirdPartyNotices.txt, fall back to NOTICE.txt
    for (const filename of ['ThirdPartyNotices.txt', 'NOTICE.txt']) {
      try {
        return readFileSync(join(basePath, filename), 'utf-8')
      } catch {
        // Try next candidate
      }
    }
    return null
  })

  ipcMain.handle(IPC.CHANGELOG_GET_CURRENT, (_event, locale?: string) => {
    return readCurrentChangelog(locale)
  })

  // URL for the vendored PDF viewer (resources/pdfjs/app/viewer.html).
  // Returned as a properly-encoded file:// URL so the renderer can embed it
  // in an iframe without platform-specific path fiddling.
  ipcMain.handle(IPC.APP_GET_PDF_VIEWER_URL, () => {
    const basePath = app.isPackaged
      ? join(process.resourcesPath, 'resources')
      : join(app.getAppPath(), 'resources')
    const viewerPath = join(basePath, 'pdfjs', 'app', 'viewer.html')
    const segments = viewerPath.split(sep).join('/').split('/').map(seg => encodeURIComponent(seg))
    const leading = viewerPath.startsWith(sep) || viewerPath.startsWith('/') ? '' : '/'
    return `file://${leading}${segments.join('/')}`
  })

  ipcMain.handle(IPC.UPDATER_GET_STATUS, () => {
    return getUpdateService().getStatus()
  })

  ipcMain.handle(IPC.UPDATER_CHECK_NOW, async () => {
    return await getUpdateService().checkNow()
  })

  ipcMain.handle(IPC.UPDATER_DOWNLOAD_NOW, async () => {
    return await getUpdateService().downloadNow()
  })

  ipcMain.handle(IPC.UPDATER_RESTART_TO_UPDATE, async () => {
    if (!options.onRestartToApplyUpdate) {
      return { success: false, error: 'Restart action is unavailable.' }
    }
    return await options.onRestartToApplyUpdate()
  })

  ipcMain.handle(IPC.UPDATER_DISMISS_BANNER, () => {
    return getUpdateService().dismissBanner()
  })

  // Create a new terminal
  ipcMain.handle(IPC.TERMINAL_CREATE, (_, id: string, options?: PtyOptions) => {
    return performanceTrace.timeSync('ipc.invoke', {
      channel: 'terminal:create',
      terminalId: id,
      cols: options?.cols ?? null,
      rows: options?.rows ?? null,
      cwdProvided: Boolean(options?.cwd)
    }, () => createTerminalProcess(id, options), 'ipc')
  })

  // Write data to terminal
  ipcMain.handle(IPC.TERMINAL_WRITE, async (_, id: string, data: string, traceContext?: TraceContext) => {
    // Git activity notification moved to ptyProcess.onData with 500ms throttle
    // (user keystrokes don't change git state; PTY output means command execution)
    const flowId = traceContext?.traceFlowId
    const includesEnter = data.includes('\r') || data.includes('\n')
    performanceTrace.markTaskInput(id, flowId, {
      inputKind: includesEnter ? 'execute' : 'input',
      ...performanceTrace.summarizeText('payload', data)
    })
    if (includesEnter) {
      performanceTrace.markTaskRunning(id, flowId, { reason: 'terminal-write-enter' })
    }
    if (flowId) {
      performanceTrace.recordFlowStep('ipc.terminal.write', flowId, {
        terminalId: id,
        includesEnter,
        ...performanceTrace.summarizeText('payload', data)
      }, 'ipc')
    }
    return await performanceTrace.timeAsync('ipc.invoke', {
      channel: 'terminal:write',
      terminalId: id,
      includesEnter,
      flowId,
      ...performanceTrace.summarizeText('payload', data)
    }, async () => await ptyManager.write(id, data), 'ipc')
  })

  ipcMain.handle(IPC.TERMINAL_SEND_INPUT_SEQUENCE, async (_, id: string, payload: TerminalInputSequencePayload) => {
    const flowId = payload.traceContext?.traceFlowId
    performanceTrace.markTaskInput(id, flowId, {
      inputKind: payload.kind,
      ...performanceTrace.summarizeText('payload', payload.content)
    })
    if (flowId) {
      performanceTrace.recordFlowStep('ipc.terminal.send_input_sequence', flowId, {
        terminalId: id,
        kind: payload.kind,
        ...performanceTrace.summarizeText('payload', payload.content)
      }, 'ipc')
    }
    if (payload.kind === 'raw') {
      const ok = await performanceTrace.timeAsync('ipc.invoke', {
        channel: 'terminal:send-input-sequence',
        terminalId: id,
        kind: payload.kind,
        flowId,
        ...performanceTrace.summarizeText('payload', payload.content)
      }, async () => await ptyManager.write(id, payload.content), 'ipc')
      return ok ? { ok: true } : { ok: false, phase: 'content' as const, error: 'pty write failed' }
    }

    // 'paste' kind — send content without Enter
    const bracketedPasteEnabled = terminalBracketedPasteState.get(id) ?? false
    const prepared = wrapBracketedPaste(prepareTextForPaste(payload.content), bracketedPasteEnabled)
    return await performanceTrace.timeAsync('ipc.invoke', {
      channel: 'terminal:send-input-sequence',
      terminalId: id,
      kind: payload.kind,
      bracketedPasteEnabled,
      flowId,
      ...performanceTrace.summarizeText('payload', payload.content)
    }, async () => await ptyManager.sendInputSequence(id, prepared), 'ipc')
  })

  ipcMain.handle(IPC.TERMINAL_GET_INPUT_CAPABILITIES, (_, id: string) => {
    return {
      bracketedPasteEnabled: terminalBracketedPasteState.get(id) ?? false,
      shellKind: ptyManager.getShellKind(id)
    }
  })

  // Toggle fast-path on the IPC data buffer for a terminal.
  // Called by the renderer when terminal visibility changes so that hidden
  // terminals don't generate high-rate unbatched IPC traffic.
  // The state is also persisted in terminalFastPathState so that it survives
  // the race where setVisibility fires before the buffer is created.
  ipcMain.on(IPC.TERMINAL_SET_BUFFER_FAST_PATH, (_, id: string, enabled: boolean) => {
    terminalFastPathState.set(id, enabled)
    const buf = terminalDataBuffers.get(id)
    if (buf) buf.setFastPathEnabled(enabled)
  })

  ipcMain.on(IPC.TERMINAL_SET_OUTPUT_VISIBILITY, (_, id: string, visible: boolean) => {
    terminalOutputVisibilityState.set(id, visible)
    const buf = terminalDataBuffers.get(id)
    if (buf) buf.setVisible(visible)
  })

  ipcMain.on(IPC.TERMINAL_NOTIFY_INTERACTIVE_INPUT, (_, id: string) => {
    const buf = terminalDataBuffers.get(id)
    if (buf) buf.notifyInteractiveInput()
  })

  // Resize terminal
  ipcMain.handle(IPC.TERMINAL_RESIZE, (_, id: string, cols: number, rows: number) => {
    return performanceTrace.timeSync('ipc.invoke', {
      channel: 'terminal:resize',
      terminalId: id,
      cols,
      rows
    }, () => ptyManager.resize(id, cols, rows), 'ipc')
  })

  // Dispose terminal
  ipcMain.handle(IPC.TERMINAL_DISPOSE, (_, id: string) => {
    const startUs = performanceTrace.nowUs()
    // Flush and dispose the data buffer
    const buf = terminalDataBuffers.get(id)
    if (buf) {
      buf.dispose()
      terminalDataBuffers.delete(id)
    }
    terminalFastPathState.delete(id)
    terminalOutputVisibilityState.delete(id)
    terminalBracketedPasteState.delete(id)
    ipcDataCounters.delete(id)
    gitWatchManager?.unsubscribe(id)
    const result = ptyManager.dispose(id)
    performanceTrace.recordComplete('ipc.invoke', startUs, {
      channel: 'terminal:dispose',
      terminalId: id,
      result: result ? 'success' : 'not-found'
    }, 'ipc')
    return result
  })

  // Prompt storage handlers
  const promptStorage = getPromptStorage()

  // Load all prompts
  ipcMain.handle(IPC.PROMPT_LOAD, () => {
    return promptStorage.getAll()
  })

  // Save a prompt
  ipcMain.handle(IPC.PROMPT_SAVE, (_, prompt: Prompt) => {
    return promptStorage.save(prompt)
  })

  // Delete a prompt
  ipcMain.handle(IPC.PROMPT_DELETE, (_, id: string) => {
    return promptStorage.delete(id)
  })

  // Terminal config storage handlers
  const terminalConfigStorage = getTerminalConfigStorage()

  // Load terminal config
  ipcMain.handle(IPC.TERMINAL_CONFIG_LOAD, () => {
    return terminalConfigStorage.get()
  })

  // Save terminal config
  ipcMain.handle(IPC.TERMINAL_CONFIG_SAVE, (_, config: TerminalWindowConfig) => {
    return terminalConfigStorage.save(config)
  })

  // Update terminal config (partial)
  ipcMain.handle(IPC.TERMINAL_CONFIG_UPDATE, (_, partial: Partial<TerminalWindowConfig>) => {
    return terminalConfigStorage.update(partial)
  })

  // Dialog handlers
  ipcMain.handle(IPC.DIALOG_OPEN_DIRECTORY, async () => {
    try {
      const result = await dialog.showOpenDialog(mainWindow, {
        properties: ['openDirectory']
      })
      if (result.canceled || result.filePaths.length === 0) {
        return { success: false, canceled: true }
      }
      return { success: true, path: result.filePaths[0] }
    } catch (error) {
      console.error('Failed to open directory dialog:', error)
      return { success: false, error: String(error) }
    }
  })

  ipcMain.handle(IPC.DIALOG_OPEN_TEXT_FILE, async (_, payload?: {
    title?: string
    filters?: Array<{ name: string; extensions: string[] }>
  }) => {
    try {
      const result = await dialog.showOpenDialog(mainWindow, {
        title: payload?.title || 'Open file',
        properties: ['openFile'],
        filters: payload?.filters?.length
          ? payload.filters
          : [{ name: 'JSON', extensions: ['json'] }, { name: 'Text', extensions: ['txt', 'md'] }]
      })
      if (result.canceled || result.filePaths.length === 0) {
        return { success: false, canceled: true }
      }
      const path = result.filePaths[0]
      const content = readFileSync(path, 'utf-8')
      return { success: true, path, content }
    } catch (error) {
      console.error('Failed to open text file:', error)
      return { success: false, error: String(error) }
    }
  })

  ipcMain.handle(IPC.DIALOG_SAVE_TEXT_FILE, async (_, payload: { title?: string; defaultFileName?: string; content: string }) => {
    try {
      if (!payload || typeof payload.content !== 'string') {
        return { success: false, error: 'Invalid export content' }
      }

      const result = await dialog.showSaveDialog(mainWindow, {
        title: payload.title || 'Export file',
        defaultPath: payload.defaultFileName || 'onward-export.json',
        filters: [{ name: 'JSON', extensions: ['json'] }]
      })

      if (result.canceled || !result.filePath) {
        return { success: false, canceled: true }
      }

      writeFileSync(result.filePath, payload.content, 'utf-8')
      return { success: true, path: result.filePath }
    } catch (error) {
      console.error('Failed to save text file:', error)
      return { success: false, error: String(error) }
    }
  })

  // Diagnostic bundle export — packages userData state files + trace
  // chunks into a ZIP. Pops the native Save As dialog so the user picks
  // the destination. `forceOutputPath` lets the autotest harness drive
  // the path deterministically (only honored when ONWARD_AUTOTEST=1, so
  // production cannot accidentally bypass the dialog).
  ipcMain.handle(
    IPC.FEEDBACK_EXPORT_DIAGNOSTIC_BUNDLE,
    async (_, payload?: { forceOutputPath?: string; expectedMarker?: { uuid: string; label?: string } }) => {
      try {
        const appInfo = getAppInfo()
        const userDataDir = app.getPath('userData')
        const now = new Date()
        // Internal metadata (bundle manifest, AGENT-GUIDE) stays UTC ISO
        // so cross-machine analysis is unambiguous. The filename uses
        // LOCAL wall-clock time per user request — the user thinks in
        // local time when they look at "what bundle did I just save".
        const isoTs = now.toISOString()
        const pad = (n: number) => n.toString().padStart(2, '0')
        const localStamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}_${pad(now.getHours())}-${pad(now.getMinutes())}-${pad(now.getSeconds())}`
        const defaultName = `onward-diagnostic-${localStamp}.zip`

        let outputPath: string
        if (payload?.forceOutputPath && process.env.ONWARD_AUTOTEST === '1') {
          outputPath = payload.forceOutputPath
        } else {
          const result = await dialog.showSaveDialog(mainWindow, {
            title: 'Save diagnostic bundle',
            defaultPath: defaultName,
            filters: [{ name: 'ZIP', extensions: ['zip'] }]
          })
          if (result.canceled || !result.filePath) {
            return { success: false, canceled: true }
          }
          outputPath = result.filePath
        }

        // Flush app-state so the bundled JSON reflects the latest debounced
        // state (prompt height, editor drafts, terminal cwds). Telemetry
        // is append-only NDJSON; tail-partial lines are safe in the bundle.
        try {
          await getAppStateStorage().flush()
        } catch (error) {
          console.warn('[DiagnosticBundle] app-state flush failed (continuing):', String(error))
        }

        // Seal the active trace chunk: closeSync the current fd so the
        // existing chunks become static (safe to ZIP without racing
        // writeSync), and open a fresh chunk for subsequent writes. The
        // user-asked semantic — "stop the current capture, bundle what's
        // there, do NOT delete chunks". `rotate()` fsync+closes, runs
        // enforceBudget (the only deletion path, unchanged), then opens
        // the next chunk. Repeated bundle clicks each cut a fresh chunk
        // boundary; chunks captured between two clicks are independent.
        try {
          traceStore.rotate()
        } catch (error) {
          console.warn('[DiagnosticBundle] traceStore.rotate failed (continuing):', String(error))
        }

        // expectedMarker is honoured only in autotest mode — it drives the
        // verifier's V10 closed-loop check (autotest emits a marker via
        // debug:emit-bundle-marker, then expects it to round-trip into the
        // ZIP). Production builds must never receive this field; the
        // gate keeps the autotest plumbing fully out of the prod path.
        const expectedMarker = process.env.ONWARD_AUTOTEST === '1'
          ? payload?.expectedMarker
          : undefined

        const bundle = await createDiagnosticBundle({
          userDataDir,
          // Scan the trace store's ACTUAL directory, not the userData/traces
          // default. In autotest (and any ONWARD_REPO_ROOT-redirected) run the
          // store writes chunks to <repoRoot>/traces/perf, so the default
          // <userData>/traces is empty and the V10 bundle-marker (FB-DB-03) is
          // never found. getDir() == <userData>/traces in prod, so this is a
          // no-op there and a correctness fix under autotest.
          traceDir: traceStore.getDir() ?? undefined,
          outputPath,
          appInfo: {
            version: appInfo.version,
            buildChannel: appInfo.buildChannel,
            branch: appInfo.branch,
            tag: appInfo.tag,
            productName: appInfo.productName,
            electronVersion: process.versions.electron
          },
          timestamp: isoTs,
          expectedMarker
        })

        return bundle
      } catch (error) {
        console.error('Failed to generate diagnostic bundle:', error)
        return { success: false, error: String(error) }
      }
    }
  )

  // Shell handlers
  ipcMain.handle(IPC.SHELL_OPEN_PATH, async (_, targetPath: string) => {
    try {
      const result = await shell.openPath(targetPath)
      if (result) {
        return { success: false, error: result }
      }
      return { success: true }
    } catch (error) {
      console.error('Failed to open path:', error)
      return { success: false, error: String(error) }
    }
  })

  ipcMain.handle(IPC.SHELL_OPEN_EXTERNAL, async (_, url: string) => {
    const result = await openExternalUrlWithConfirm(mainWindow, url)
    if (!result.success && result.error && !result.canceled && !result.blocked) {
      console.error('Failed to open external url:', result.error)
    }
    return result
  })

  ipcMain.handle(IPC.CLIPBOARD_WRITE_TEXT, async (_, text: string) => {
    clipboard.writeText(text)
    return true
  })

  ipcMain.handle(IPC.CLIPBOARD_READ_TEXT, async () => {
    return clipboard.readText()
  })

  browserViewManager.init(mainWindow)

  ipcMain.handle(IPC.BROWSER_CREATE, (_, id: string, url?: string, options?: Parameters<typeof browserViewManager.create>[2]) => {
    return browserViewManager.create(id, url, options)
  })

  ipcMain.handle(IPC.BROWSER_DESTROY, (_, id: string) => {
    return browserViewManager.destroy(id)
  })

  ipcMain.handle(IPC.BROWSER_NAVIGATE, (_, id: string, url: string) => {
    return browserViewManager.navigate(id, url)
  })

  ipcMain.handle(IPC.BROWSER_GO_BACK, (_, id: string) => {
    return browserViewManager.goBack(id)
  })

  ipcMain.handle(IPC.BROWSER_GO_FORWARD, (_, id: string) => {
    return browserViewManager.goForward(id)
  })

  ipcMain.handle(IPC.BROWSER_RELOAD, (_, id: string) => {
    return browserViewManager.reload(id)
  })

  ipcMain.handle(IPC.BROWSER_STOP, (_, id: string) => {
    return browserViewManager.stop(id)
  })

  ipcMain.handle(IPC.BROWSER_EVALUATE_FOR_TEST, (_, id: string, script: string) => {
    return browserViewManager.evaluateForTest(id, script)
  })

  ipcMain.handle(IPC.BROWSER_GET_ZOOM_FACTOR, (_, id: string) => {
    return browserViewManager.getZoomFactor(id)
  })

  ipcMain.handle(IPC.BROWSER_SET_ZOOM_FACTOR, (_, id: string, zoomFactor: number) => {
    return browserViewManager.setZoomFactor(id, zoomFactor)
  })

  ipcMain.handle(IPC.BROWSER_GET_SCROLL_STATE, (_, id: string) => {
    return browserViewManager.getScrollState(id)
  })

  ipcMain.handle(IPC.BROWSER_RESTORE_SCROLL_STATE, (_, id: string, state: Parameters<typeof browserViewManager.restoreScrollState>[1]) => {
    return browserViewManager.restoreScrollState(id, state)
  })

  ipcMain.handle(IPC.BROWSER_FIND_IN_PAGE, (_, id: string, text: string, options?: Parameters<typeof browserViewManager.findInPage>[2]) => {
    return browserViewManager.findInPage(id, text, options)
  })

  ipcMain.handle(IPC.BROWSER_STOP_FIND_IN_PAGE, (_, id: string, action?: Parameters<typeof browserViewManager.stopFindInPage>[1]) => {
    return browserViewManager.stopFindInPage(id, action)
  })

  ipcMain.handle(IPC.BROWSER_SET_BOUNDS, (_, id: string, rect: { x: number; y: number; width: number; height: number }) => {
    return browserViewManager.setBounds(id, rect)
  })

  ipcMain.handle(IPC.BROWSER_SHOW, (_, id: string) => {
    return browserViewManager.show(id)
  })

  ipcMain.handle(IPC.BROWSER_HIDE, (_, id: string) => {
    return browserViewManager.hide(id)
  })

  ipcMain.handle(IPC.BROWSER_GET_NAV_STATE, (_, id: string) => {
    return browserViewManager.getNavState(id)
  })

  ipcMain.handle(IPC.BROWSER_CLEAR_COOKIES, (_, maxAge?: number) => {
    return browserViewManager.clearCookies(maxAge)
  })

  ipcMain.handle(IPC.BROWSER_SET_REMEMBER_COOKIES, (_, rememberCookies: boolean) => {
    return browserViewManager.setRememberCookies(rememberCookies)
  })

  ipcMain.handle(
    IPC.BROWSER_SHOW_AUTO_REFRESH_MENU,
    (
      _,
      options: { currentIntervalMs: number | null; labels: { off: string; items: Array<{ ms: number; label: string }> } }
    ) => {
      return new Promise<{ intervalMs: number | null } | null>((resolve) => {
        const { currentIntervalMs, labels } = options
        const items: Electron.MenuItemConstructorOptions[] = [
          {
            label: labels.off,
            type: 'radio',
            checked: currentIntervalMs == null,
            click: () => resolve({ intervalMs: null })
          },
          { type: 'separator' },
          ...labels.items.map((item) => ({
            label: item.label,
            type: 'radio' as const,
            checked: currentIntervalMs === item.ms,
            click: () => resolve({ intervalMs: item.ms })
          }))
        ]
        const menu = Menu.buildFromTemplate(items)
        menu.popup({
          window: mainWindow,
          callback: () => resolve(null)
        })
      })
    }
  )

  ipcMain.handle(
    IPC.BROWSER_SHOW_COOKIE_MENU,
    (_, options: { rememberCookies: boolean; labels: { remember: string; clearDay: string; clearWeek: string; clearAll: string } }) => {
      return new Promise<{ action: string; rememberCookies?: boolean } | null>((resolve) => {
        const { rememberCookies, labels } = options
        const items: Electron.MenuItemConstructorOptions[] = [
          {
            label: labels.remember,
            type: 'checkbox',
            checked: rememberCookies,
            click: () => resolve({ action: 'toggleRemember', rememberCookies: !rememberCookies })
          }
        ]

        if (rememberCookies) {
          items.push(
            { type: 'separator' },
            { label: labels.clearDay, click: () => resolve({ action: 'clear', rememberCookies: undefined }) },
            { label: labels.clearWeek, click: () => resolve({ action: 'clearWeek', rememberCookies: undefined }) },
            { type: 'separator' },
            { label: labels.clearAll, click: () => resolve({ action: 'clearAll', rememberCookies: undefined }) }
          )
        }

        const menu = Menu.buildFromTemplate(items)
        menu.popup({
          window: mainWindow,
          callback: () => resolve(null)
        })
      })
    }
  )

  // Command preset storage handlers
  const commandPresetStorage = getCommandPresetStorage()

  // Load all command presets
  ipcMain.handle(IPC.COMMAND_PRESET_LOAD, () => {
    return commandPresetStorage.getAll()
  })

  // Save a command preset
  ipcMain.handle(IPC.COMMAND_PRESET_SAVE, (_, preset: CommandPreset) => {
    return commandPresetStorage.save(preset)
  })

  // Delete a command preset
  ipcMain.handle(IPC.COMMAND_PRESET_DELETE, (_, id: string) => {
    return commandPresetStorage.delete(id)
  })

  // Coding Agent configuration storage
  const codingAgentConfigStorage = getCodingAgentConfigStorage()

  ipcMain.handle(IPC.CODING_AGENT_CONFIG_LOAD, (_, command?: string) => {
    return codingAgentConfigStorage.get(command)
  })

  ipcMain.handle(IPC.CODING_AGENT_CONFIG_SAVE, (_, config: CodingAgentConfigInput) => {
    return codingAgentConfigStorage.save(config)
  })

  ipcMain.handle(IPC.CODING_AGENT_CONFIG_UPDATE, (_, id: string, config: CodingAgentConfigInput) => {
    return codingAgentConfigStorage.update(id, config)
  })

  ipcMain.handle(IPC.CODING_AGENT_CONFIG_DELETE, (_, id: string) => {
    return codingAgentConfigStorage.delete(id)
  })

  ipcMain.handle(IPC.CODING_AGENT_PREPARE, async (_, command: string, executablePath?: string) => {
    const info = await performanceTrace.timeAsync('coding_agent.prepare', {
      commandKind: executablePath ? 'absolute-path' : 'path-lookup',
      executablePathProvided: Boolean(executablePath)
    }, async () => await getCodingAgentRuntimeInfo(command || '', executablePath || undefined), 'coding-agent')
    if (!info.success) {
      return { success: false, error: info.error }
    }
    return { success: true }
  })

  ipcMain.handle(IPC.CODING_AGENT_LAUNCH, async (_, payload: { terminalId: string; config: CodingAgentConfigInput; cols?: number; rows?: number }) => {
    const startUs = performanceTrace.nowUs()
    const terminalId = payload?.terminalId
    if (!terminalId) {
      performanceTrace.recordComplete('coding_agent.launch', startUs, { result: 'error', reason: 'missing-terminal-id' }, 'coding-agent')
      return { success: false, error: 'Terminal ID missing' }
    }

    const config = payload.config
    if (!config || !config.command) {
      performanceTrace.recordComplete('coding_agent.launch', startUs, { terminalId, result: 'error', reason: 'missing-config' }, 'coding-agent')
      return { success: false, error: 'Agent configuration missing' }
    }
    const flowId = performanceTrace.createFlowId('coding-agent')
    performanceTrace.recordFlowStart('coding_agent.launch', flowId, {
      terminalId,
      commandKind: config.executablePath ? 'absolute-path' : 'path-lookup'
    }, 'coding-agent')
    performanceTrace.markTaskRunning(terminalId, flowId, { reason: 'coding-agent-launch' })

    const runtimeInfo = await getCodingAgentRuntimeInfo(config.command, config.executablePath || undefined)
    if (!runtimeInfo.success || !runtimeInfo.executablePath) {
      performanceTrace.recordComplete('coding_agent.launch', startUs, {
        terminalId,
        commandKind: config.executablePath ? 'absolute-path' : 'path-lookup',
        result: 'error',
        reason: 'runtime-unavailable'
      }, 'coding-agent')
      performanceTrace.recordFlowEnd('coding_agent.launch.error', flowId, {
        terminalId,
        reason: 'runtime-unavailable'
      }, 'coding-agent')
      return { success: false, error: runtimeInfo.error || 'Agent not ready' }
    }

    const cwd = await getTerminalCwd(terminalId)
    const cols = payload.cols || 80
    const rows = payload.rows || 24
    const restartCwd = cwd || process.env.HOME || process.cwd()

    // Build environment: isolate inherited terminal color-disabling flags, then
    // merge user-specified environment variables so explicit overrides still win.
    const userEnvVars = Array.isArray(config.envVars) ? config.envVars : []
    const env = applyTerminalUserEnvVars(buildColorCapableTerminalEnv(process.env), userEnvVars)

    // Parse user-provided extra arguments with shell-aware quoting
    const extraArgs: string[] = []
    const rawArgs = (config.extraArgs || '').trim()
    if (rawArgs) {
      // Match: "quoted string", 'quoted string', or unquoted-token
      const tokens = rawArgs.match(/(?:"[^"]*"|'[^']*'|\S+)/g) || []
      for (const token of tokens) {
        // Strip surrounding quotes
        if ((token.startsWith('"') && token.endsWith('"')) || (token.startsWith("'") && token.endsWith("'"))) {
          extraArgs.push(token.slice(1, -1))
        } else {
          extraArgs.push(token)
        }
      }
    }

    // Save cwd so the renderer's restartShell can restore it after agent exit
    agentRestartCwdMap.set(terminalId, restartCwd)

    // Use the same cleanup path as terminal:dispose to drain buffers and unsubscribe watchers
    const buf = terminalDataBuffers.get(terminalId)
    if (buf) {
      buf.dispose()
      terminalDataBuffers.delete(terminalId)
    }
    ipcDataCounters.delete(terminalId)
    gitWatchManager?.unsubscribe(terminalId)
    ptyManager.dispose(terminalId)

    // Spawn the agent; on exit the renderer's global exit handler will prompt restart
    const result = createTerminalProcess(terminalId, {
      cols,
      rows,
      cwd: restartCwd,
      env,
      command: runtimeInfo.executablePath,
      args: extraArgs
    })
    performanceTrace.recordComplete('coding_agent.launch', startUs, {
      terminalId,
      commandKind: config.executablePath ? 'absolute-path' : 'path-lookup',
      argsCount: extraArgs.length,
      envVarCount: userEnvVars.length,
      result: result.success ? 'success' : 'error'
    }, 'coding-agent')
    if (result.success) {
      performanceTrace.recordFlowStep('coding_agent.pty.spawned', flowId, { terminalId }, 'coding-agent')
    } else {
      performanceTrace.recordFlowEnd('coding_agent.launch.error', flowId, { terminalId }, 'coding-agent')
    }
    return result
  })

  // App state storage handlers
  const appStateStorage = getAppStateStorage()

  // Load app state
  ipcMain.handle(IPC.APP_STATE_LOAD, () => {
    log('[IPC] app-state:load')
    return appStateStorage.get()
  })

  // Save app state
  ipcMain.handle(IPC.APP_STATE_SAVE, (_, state: AppState) => {
    return appStateStorage.save(state)
  })
  ipcMain.handle(IPC.APP_STATE_SAVE_PATCH, (_, patch: Partial<AppState>) => {
    return appStateStorage.savePatch(patch)
  })
  ipcMain.handle(IPC.APP_STATE_FLUSH, () => {
    return appStateStorage.flush()
  })

  // Git handlers
  // Check if Git is installed
  ipcMain.handle(IPC.GIT_CHECK_INSTALLED, async () => {
    return await gitIpcWorkerClient.checkInstalled()
  })

  // Resolve git repo root for a given path
  ipcMain.handle(IPC.GIT_RESOLVE_REPO_ROOT, async (_, cwd: string) => {
    return await gitIpcWorkerClient.resolveRepoRoot(cwd)
  })

  // Get Git diff for a directory
  ipcMain.handle(IPC.GIT_GET_DIFF, async (_, cwd: string, options?: { scope?: 'root-only' | 'full'; force?: boolean }) => {
    const result = await gitIpcWorkerClient.getDiff(cwd, options)
    // Register the resolved repo root with the invalidation bus for debug
    // health / LRU visibility. No watcher starts here; the GitStateMirror
    // Worker is the only FS-event authority. `result.cwd` falls back to the
    // input cwd when the path is not a git repo.
    if (result?.cwd) {
      gitDiffCacheInvalidator.registerWatch(result.cwd)
      if (options?.force) {
        invalidateContentCacheForProject(result.cwd, 'invalidated-refresh')
      }
      // Cold-start prefetch: the GitStateMirror's mirror-update is the
      // primary trigger, but the very first `getDiff` call after launch
      // happens before the mirror has emitted anything. Kick the scheduler
      // here so the user's first click on a file already finds a warm cache.
      // Idempotent: the scheduler debounces internally.
      gitDiffPrecomputeScheduler.onProjectInvalidated(result.cwd)
    } else {
      gitDiffCacheInvalidator.registerWatch(cwd)
      if (options?.force) {
        invalidateContentCacheForProject(cwd, 'invalidated-refresh')
      }
    }
    return result
  })

  // Get Git history list
  ipcMain.handle(IPC.GIT_GET_HISTORY, async (_, cwd: string, options?: { limit?: number; skip?: number }) => {
    // Inject branchOid + refsDigest from the GitStateMirror snapshot (no extra git
    // spawn) as the L8 list cache's two freshness keys: a new commit moves
    // branchOid; a ref-only move (push/fetch advancing origin/<branch> with HEAD
    // unchanged) moves refsDigest. Both structurally miss → fresh recompute, so a
    // prewarmed first page is a HIT and the `%D` decorations never go stale.
    const snapshot = gitStateMirrorRouter.getLatest(cwd)
    return await gitIpcWorkerClient.getHistory(cwd, options?.limit, options?.skip, snapshot?.branchOid, snapshot?.refsDigest)
  })

  // Get Git history diff (range + file)
  ipcMain.handle(IPC.GIT_GET_HISTORY_DIFF, async (_, cwd: string, options: GitHistoryDiffOptions) => {
    return await gitIpcWorkerClient.getHistoryDiff(cwd, options)
  })

  ipcMain.handle(IPC.GIT_GET_HISTORY_FILE_CONTENT, async (_, cwd: string, options: GitHistoryFileContentOptions) => {
    return await gitIpcWorkerClient.getHistoryFileContent(cwd, options)
  })

  // Get Git file content for diff view. Goes through the per-project content
  // cache so repeat clicks (and clicks on files the precompute scheduler has
  // already fetched) return in microseconds without touching the worker.
  ipcMain.handle(IPC.GIT_GET_FILE_CONTENT, async (
    _,
    cwd: string,
    file: Pick<GitFileStatus, 'filename' | 'status' | 'originalFilename' | 'changeType' | 'isSubmoduleEntry'>,
    repoRoot?: string,
    options?: GitFileContentRequestOptions
  ) => {
    const startedAt = Date.now()
    try {
      const result = await fetchFileContentWithCache({ cwd, file, repoRoot, options })
      performanceTrace.record(PERF_TRACE_EVENT.MAIN_IPC_GIT_GET_FILE_CONTENT, {
        cwd,
        repoRoot,
        filename: file.filename,
        status: file.status,
        changeType: file.changeType,
        cacheState: result.cacheInfo?.state ?? 'unknown',
        cacheMissReason: result.cacheInfo?.missReason ?? null,
        cacheSource: result.cacheInfo?.source ?? null,
        result: result.success ? 'success' : 'error',
        durationMs: Date.now() - startedAt
      })
      return result
    } catch (error) {
      performanceTrace.record(PERF_TRACE_EVENT.MAIN_IPC_GIT_GET_FILE_CONTENT, {
        cwd,
        repoRoot,
        filename: file.filename,
        status: file.status,
        changeType: file.changeType,
        cacheState: 'miss',
        cacheMissReason: 'worker-error',
        result: 'exception',
        error: String(error),
        durationMs: Date.now() - startedAt
      })
      throw error
    }
  })

  // Save file content to workspace
  // Mutating IPCs (stage / unstage / discard / save / index update) all
  // change the git working tree or index in ways that the renderer-facing
  // diff view depends on. The Mirror Worker observes both worktree and
  // selected .git paths, but mutation IPCs already know the affected project.
  // Wipe the project bucket explicitly after every successful mutation so the
  // next click refetches fresh without waiting for the async mirror delta.
  ipcMain.handle(IPC.GIT_SAVE_FILE_CONTENT, async (_, cwd: string, filename: string, content: string) => {
    const result = await gitIpcWorkerClient.saveFileContent(cwd, filename, content)
    if (result.success) invalidateGitDiffAfterKnownMutation(cwd)
    return result
  })

  ipcMain.handle(IPC.GIT_STAGE_FILE, async (_, cwd: string, filename: string, repoRoot?: string) => {
    const result = await gitIpcWorkerClient.stageFile(cwd, filename, repoRoot)
    if (result.success) invalidateGitDiffAfterKnownMutation(repoRoot ?? cwd)
    return result
  })

  ipcMain.handle(IPC.GIT_UNSTAGE_FILE, async (_, cwd: string, filename: string, repoRoot?: string) => {
    const result = await gitIpcWorkerClient.unstageFile(cwd, filename, repoRoot)
    if (result.success) invalidateGitDiffAfterKnownMutation(repoRoot ?? cwd)
    return result
  })

  ipcMain.handle(IPC.GIT_DISCARD_FILE, async (_, cwd: string, file: Pick<GitFileStatus, 'filename' | 'changeType' | 'status' | 'isSubmoduleEntry'>, repoRoot?: string) => {
    const result = await gitIpcWorkerClient.discardFile(cwd, file, repoRoot)
    if (result.success) invalidateGitDiffAfterKnownMutation(repoRoot ?? cwd)
    return result
  })

  ipcMain.handle(IPC.GIT_GET_SUBMODULES, async (_, cwd: string) => {
    return await gitIpcWorkerClient.getSubmodules(cwd)
  })

  ipcMain.handle(IPC.GIT_UPDATE_INDEX_CONTENT, async (_, cwd: string, filename: string, content: string) => {
    const result = await gitIpcWorkerClient.updateIndexContent(cwd, filename, content)
    if (result.success) invalidateGitDiffAfterKnownMutation(cwd)
    return result
  })

  // Get terminal's current working directory
  ipcMain.handle(IPC.GIT_GET_TERMINAL_CWD, async (_, terminalId: string) => {
    return await getTerminalCwd(terminalId)
  })

  // Get terminal's cwd + git branch
  ipcMain.handle(IPC.GIT_GET_TERMINAL_INFO, async (_, terminalId: string) => {
    return await getTerminalGitInfo(terminalId)
  })
  ipcMain.handle(IPC.GIT_SUBSCRIBE_TERMINAL_INFO, async (_event, terminalId: string) => {
    await gitWatchManager?.subscribe(terminalId)
    return { success: true }
  })
  ipcMain.handle(IPC.GIT_UNSUBSCRIBE_TERMINAL_INFO, async (_event, terminalId: string) => {
    gitWatchManager?.unsubscribe(terminalId)
    return { success: true }
  })
  // NOTIFY_TERMINAL_ACTIVITY / NOTIFY_TERMINAL_FOCUS were polling-era
  // boost hints. The event-driven bridge no longer needs them — kept as
  // no-op IPC handlers so old renderer builds don't error on unhandled
  // invoke. They will be removed once renderer code stops calling them.
  ipcMain.handle(IPC.GIT_NOTIFY_TERMINAL_ACTIVITY, async (_event, _terminalId: string) => {
    return { success: true }
  })
  ipcMain.handle(IPC.GIT_NOTIFY_TERMINAL_FOCUS, async (_event, terminalId: string) => {
    // Drive the GitStateMirror reconcile heartbeat's focused repo (1 s cadence).
    gitWatchManager?.notifyFocus(terminalId)
    return { success: true }
  })
  ipcMain.handle(IPC.GIT_NOTIFY_TERMINAL_GIT_UPDATE, async (_event, terminalId: string) => {
    gitWatchManager?.notifyTerminalGitUpdate(terminalId)
    return { success: true }
  })

  // Background diff cache warming — pre-compute diff so opening the panel is instant
  ipcMain.handle(IPC.GIT_WARM_DIFF_CACHE, async (_, cwd: string) => {
    const result = await gitIpcWorkerClient.warmDiffCache(cwd)
    // warmDiffCache only warms the LIST caches (request + single-repo) inside
    // the worker. Also kick the per-file content precompute so the user's FIRST
    // click lands on a warm body cache instead of a cold `git show`/`cat-file`
    // (multi-second on EDR-throttled Windows). The scheduler debounces and runs
    // in the low-priority lane, so this is safe to fire on every warm.
    if (result?.success && cwd) {
      gitDiffPrecomputeScheduler.onProjectInvalidated(cwd)
    }
    return result
  })

  // Project editor handlers
  ipcMain.handle(IPC.PROJECT_LIST_DIRECTORY, async (_, root: string, path: string) => {
    return await projectFsWorkerClient.listDirectory(root, path)
  })

  ipcMain.handle(IPC.PROJECT_BUILD_FILE_INDEX, async (_, root: string) => {
    const startMs = Date.now()
    const result = await projectFsWorkerClient.buildFileIndex(root)
    performanceTrace.record(PERF_TRACE_EVENT.MAIN_FILE_INDEX_BUILD, {
      fileCount: Array.isArray(result) ? result.length : 0,
      durationMs: Date.now() - startMs
    })
    return result
  })

  ipcMain.handle(IPC.PROJECT_INVALIDATE_FILE_INDEX, async (_, root: string) => {
    performanceTrace.record(PERF_TRACE_EVENT.MAIN_FILE_INDEX_UPDATE, { reason: 'invalidate' })
    return await projectFsWorkerClient.invalidateFileIndex(root)
  })

  ipcMain.handle(IPC.PROJECT_SEARCH_FILENAMES, async (_, root: string, query: string, limit?: number) => {
    return await projectFsWorkerClient.searchFilenames(root, query, limit ?? 80)
  })

  ipcMain.handle(IPC.PROJECT_READ_FILE, async (_, root: string, path: string, options: Parameters<typeof readProjectFile>[2]) => {
    const startedAt = performance.now()
    const result = await readProjectFile(root, path, options)
    performanceTrace.record(PERF_TRACE_EVENT.MAIN_IPC_PROJECT_READ_FILE, {
      pathLen: path.length,
      ok: Boolean(result?.success),
      openMode: options?.openMode ?? result?.openMode ?? 'auto',
      sizeBytes: result?.sizeBytes ?? 0,
      durationMs: +(performance.now() - startedAt).toFixed(1)
    })
    return result
  })

  // Batch existence check — see projectFilesExist for rationale. The
  // payload is a flat `boolean[]` aligned with the input `paths` array.
  ipcMain.handle(IPC.PROJECT_FILES_EXIST, async (_, root: string, paths: string[]) => {
    if (!Array.isArray(paths) || paths.length === 0) return []
    return projectFilesExist(root, paths)
  })

  ipcMain.handle(IPC.PROJECT_READ_FILE_CHUNK, async (_, root: string, path: string, offset: number, length: number, mode: Parameters<typeof readProjectFileChunk>[4]) => {
    const startedAt = performance.now()
    const result = await readProjectFileChunk(root, path, offset, length, mode)
    performanceTrace.record(PERF_TRACE_EVENT.MAIN_IPC_PROJECT_READ_FILE_CHUNK, {
      pathLen: path.length,
      ok: Boolean(result?.success),
      offset,
      length,
      mode,
      bytesRead: result?.bytesRead ?? 0,
      sizeBytes: result?.sizeBytes ?? 0,
      durationMs: +(performance.now() - startedAt).toFixed(1)
    })
    return result
  })

  ipcMain.handle(IPC.PROJECT_SAVE_FILE, async (_, root: string, path: string, content: string) => {
    const result = await saveProjectFile(root, path, content)
    let fullPath: string | null = null
    if (result.success && fileWatchManager) {
      fullPath = resolveInRoot(resolve(root), path)
      if (fullPath) {
        fileWatchManager.suppressNext(fullPath)
      }
    }
    if (result.success) {
      if (!fullPath) fullPath = resolveInRoot(resolve(root), path)
      await invalidateGitDiffAfterProjectFileSave(root, fullPath)
    }
    return result
  })

  ipcMain.handle(IPC.PROJECT_WATCH_FILE, async (_, root: string, path: string) => {
    const fullPath = resolveInRoot(resolve(root), path)
    if (!fullPath) {
      return { success: false, error: 'Invalid path.' }
    }
    fileWatchManager?.watch(fullPath)
    return { success: true }
  })

  ipcMain.handle(IPC.PROJECT_UNWATCH_FILE, async (_, root: string, path: string) => {
    const fullPath = resolveInRoot(resolve(root), path)
    if (!fullPath) {
      return { success: false }
    }
    fileWatchManager?.unwatch(fullPath)
    return { success: true }
  })

  ipcMain.handle(IPC.PROJECT_WATCH_IMAGE_FILES, async (_, root: string, relativePaths: string[]) => {
    if (!root || !Array.isArray(relativePaths)) return { success: false }
    imageWatchManager?.watchImages(root, relativePaths)
    return { success: true }
  })

  ipcMain.handle(IPC.PROJECT_UNWATCH_IMAGE_FILES, async (_, root: string, relativePaths: string[]) => {
    if (!root || !Array.isArray(relativePaths)) return { success: false }
    imageWatchManager?.unwatchImages(root, relativePaths)
    return { success: true }
  })

  ipcMain.handle(IPC.PROJECT_UNWATCH_ALL_IMAGE_FILES, async () => {
    imageWatchManager?.unwatchAll()
    return { success: true }
  })

  ipcMain.handle(IPC.PROJECT_CREATE_FILE, async (_, root: string, path: string, content: string) => {
    const result = await createProjectFile(root, path, content)
    // Direct-notify the renderer file index of this in-app create so Cmd+P sees
    // it deterministically without waiting on the OS watcher (which delivers
    // zero events on FSEvents-restricted hosts). createFile always creates a file.
    if (result.success) projectTreeWatchManager?.notifyMutation(root, [path], [])
    return result
  })

  ipcMain.handle(IPC.PROJECT_CREATE_FOLDER, async (_, root: string, path: string) => {
    // A new folder adds no file to the index (folders are never Cmd+P hits;
    // FIC-22), so there is nothing to notify here — files created inside it
    // arrive via their own PROJECT_CREATE_FILE notifications.
    return await createProjectFolder(root, path)
  })

  ipcMain.handle(IPC.PROJECT_RENAME_PATH, async (_, root: string, oldPath: string, newPath: string) => {
    const result = await renameProjectPath(root, oldPath, newPath)
    if (result.success) {
      // Only surface the new path as an index addition when it is a FILE; a
      // folder rename just removes the old subtree (the renderer cascades prefix
      // removals) and its contents re-enter via the watcher / manual refresh.
      let newIsFile = false
      try {
        newIsFile = statSync(join(root, newPath)).isFile()
      } catch {
        newIsFile = false
      }
      projectTreeWatchManager?.notifyMutation(root, newIsFile ? [newPath] : [], [oldPath])
    }
    return result
  })

  ipcMain.handle(IPC.PROJECT_DELETE_PATH, async (_, root: string, path: string) => {
    const result = await deleteProjectPath(root, path)
    // Removal cascades prefix matches on the renderer, so deleting a folder also
    // drops its indexed children.
    if (result.success) projectTreeWatchManager?.notifyMutation(root, [], [path])
    return result
  })

  ipcMain.handle(IPC.PROJECT_SQLITE_GET_SCHEMA, async (_, root: string, path: string) => {
    return await sqliteWorkerClient.getSchema(root, path)
  })

  ipcMain.handle(
    IPC.PROJECT_SQLITE_READ_TABLE_ROWS,
    async (_, root: string, path: string, table: string, limit?: number, offset?: number) => {
      return await sqliteWorkerClient.readTableRows(root, path, table, limit, offset)
    }
  )

  ipcMain.handle(
    IPC.PROJECT_SQLITE_INSERT_ROW,
    async (_, root: string, path: string, table: string, values: Record<string, unknown>) => {
      return await sqliteWorkerClient.insertRow(root, path, table, values)
    }
  )

  ipcMain.handle(
    IPC.PROJECT_SQLITE_UPDATE_ROW,
    async (_, root: string, path: string, table: string, key: unknown, values: Record<string, unknown>) => {
      return await sqliteWorkerClient.updateRow(root, path, table, key, values)
    }
  )

  ipcMain.handle(IPC.PROJECT_SQLITE_DELETE_ROW, async (_, root: string, path: string, table: string, key: unknown) => {
    return await sqliteWorkerClient.deleteRow(root, path, table, key)
  })

  ipcMain.handle(IPC.PROJECT_SQLITE_EXECUTE, async (_, root: string, path: string, sql: string) => {
    return await sqliteWorkerClient.execute(root, path, sql)
  })

  ripgrepSearchManager = new RipgrepSearchManager()

  ipcMain.handle(IPC.PROJECT_SEARCH_START, async (_, options: {
    searchId?: string
    rootPath: string
    query: string
    isRegex: boolean
    isCaseSensitive: boolean
    isWholeWord: boolean
    includeGlob?: string
    excludeGlob?: string
    maxResults?: number
  }) => {
    const searchId = ripgrepSearchManager!.start(mainWindow, options)
    return { searchId }
  })

  ipcMain.handle(IPC.PROJECT_SEARCH_CANCEL, async () => {
    ripgrepSearchManager?.cancel()
    return { success: true }
  })

  ipcMain.handle(IPC.PROJECT_TREE_WATCH_START, (_event, cwd: string) => {
    if (typeof cwd !== 'string' || cwd.length === 0) return { success: false }
    projectTreeWatchManager?.start(cwd)
    return { success: true }
  })

  ipcMain.handle(IPC.PROJECT_TREE_WATCH_STOP, (_event, cwd: string) => {
    if (typeof cwd !== 'string' || cwd.length === 0) return { success: false }
    projectTreeWatchManager?.stop(cwd)
    return { success: true }
  })

  // Settings storage handlers
  const settingsStorage = getSettingsStorage()
  const shortcutManager = getShortcutManager()

  // Set main window for shortcut manager
  shortcutManager.setMainWindow(mainWindow)

  // Load settings
  ipcMain.handle(IPC.SETTINGS_LOAD, () => {
    return settingsStorage.get()
  })

  // Save settings
  ipcMain.handle(IPC.SETTINGS_SAVE, (_, settings: SettingsState) => {
    const success = settingsStorage.save(settings)
    if (success) {
      // Re-register shortcuts when settings change
      shortcutManager.registerFromSettings()
      options.onSettingsChanged?.(settingsStorage.get())
    }
    return success
  })

  // Update settings (partial)
  ipcMain.handle(IPC.SETTINGS_UPDATE, (_, partial: Partial<SettingsState>) => {
    const success = settingsStorage.update(partial)
    if (success) {
      // Re-register shortcuts when settings change
      shortcutManager.registerFromSettings()
      options.onSettingsChanged?.(settingsStorage.get())
    }
    return success
  })

  // Register shortcuts from current settings
  ipcMain.handle(IPC.SETTINGS_REGISTER_SHORTCUTS, () => {
    return shortcutManager.registerFromSettings()
  })

  // Check if a shortcut is available
  ipcMain.handle(IPC.SETTINGS_CHECK_SHORTCUT_AVAILABLE, (_, accelerator: string) => {
    return shortcutManager.isShortcutAvailable(accelerator)
  })

  // Check if a shortcut conflicts with existing settings
  ipcMain.handle(IPC.SETTINGS_CHECK_SHORTCUT_CONFLICT, (_, accelerator: string, excludeKey?: string) => {
    return shortcutManager.checkConflict(accelerator, excludeKey as keyof ShortcutConfig)
  })

  // Initialize shortcuts on app start
  shortcutManager.registerFromSettings()
}

/**
 * Set window-level shortcut handling
 * Use before-input-event to intercept keyboard events before Chromium handles them
 */
export function setupWindowShortcuts(mainWindow: BrowserWindow): void {
  const settingsStorage = getSettingsStorage()

  mainWindow.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return

    const settings = settingsStorage.get()
    const shortcuts = settings.shortcuts

    // Build accelerator format
    const parts: string[] = []
    if (input.meta) parts.push('CommandOrControl')
    if (input.control && !input.meta) parts.push('Control')
    if (input.alt) parts.push('Alt')
    if (input.shift) parts.push('Shift')

    let key = input.key
    if (key.length === 1) key = key.toUpperCase()
    parts.push(key)

    const accelerator = parts.join('+')

    // focusTerminal 1-8
    for (let i = 1; i <= 8; i++) {
      const shortcutKey = `focusTerminal${i}` as keyof typeof shortcuts
      if (shortcuts[shortcutKey] === accelerator) {
        event.preventDefault()
        mainWindow.webContents.send(IPC.SHORTCUT_WINDOW_TRIGGERED, { type: 'focusTerminal', index: i })
        return
      }
    }

    // switchTab 1-6
    for (let i = 1; i <= 6; i++) {
      const shortcutKey = `switchTab${i}` as keyof typeof shortcuts
      if (shortcuts[shortcutKey] === accelerator) {
        event.preventDefault()
        mainWindow.webContents.send(IPC.SHORTCUT_WINDOW_TRIGGERED, { type: 'switchTab', index: i })
        return
      }
    }

    // focusPromptEditor
    if (shortcuts.focusPromptEditor === accelerator) {
      event.preventDefault()
      mainWindow.webContents.send(IPC.SHORTCUT_WINDOW_TRIGGERED, { type: 'focusPromptEditor' })
      return
    }

    // addToHistory
    if (shortcuts.addToHistory === accelerator) {
      event.preventDefault()
      mainWindow.webContents.send(IPC.SHORTCUT_WINDOW_TRIGGERED, { type: 'addToHistory' })
      return
    }

    // terminalGitDiff
    if (shortcuts.terminalGitDiff === accelerator) {
      event.preventDefault()
      mainWindow.webContents.send(IPC.SHORTCUT_WINDOW_TRIGGERED, { type: 'terminalGitDiff' })
      return
    }

    // terminalGitHistory
    if (shortcuts.terminalGitHistory === accelerator) {
      event.preventDefault()
      mainWindow.webContents.send(IPC.SHORTCUT_WINDOW_TRIGGERED, { type: 'terminalGitHistory' })
      return
    }

    // terminalChangeWorkDir
    if (shortcuts.terminalChangeWorkDir === accelerator) {
      event.preventDefault()
      mainWindow.webContents.send(IPC.SHORTCUT_WINDOW_TRIGGERED, { type: 'terminalChangeWorkDir' })
      return
    }

    // terminalOpenWorkDir
    if (shortcuts.terminalOpenWorkDir === accelerator) {
      event.preventDefault()
      mainWindow.webContents.send(IPC.SHORTCUT_WINDOW_TRIGGERED, { type: 'terminalOpenWorkDir' })
      return
    }

    // terminalProjectEditor
    if (shortcuts.terminalProjectEditor === accelerator) {
      event.preventDefault()
      mainWindow.webContents.send(IPC.SHORTCUT_WINDOW_TRIGGERED, { type: 'terminalProjectEditor' })
      return
    }

    // viewGitDiff
    if (shortcuts.viewGitDiff === accelerator) {
      event.preventDefault()
      mainWindow.webContents.send(IPC.SHORTCUT_WINDOW_TRIGGERED, { type: 'viewGitDiff' })
    }
  })
}

let ipcHandlersCleanupPromise: Promise<void> | null = null

/**
 * Single-flight teardown. Every quit edge — the awaited before-quit→requestQuit
 * path (index.ts), window-all-closed, AND the unawaited will-quit floor — must
 * await the SAME cleanup. Without this, the unawaited will-quit call re-enters
 * dispose while the awaited path's GitStateMirror worker drain is still in
 * flight: the exact double-teardown that races the @parcel/watcher native
 * unsubscribe and frees the worker isolate mid-quiesce (the teardown SIGABRT).
 */
export function cleanupIpcHandlers(): Promise<void> {
  if (ipcHandlersCleanupPromise) return ipcHandlersCleanupPromise
  ipcHandlersCleanupPromise = runCleanupIpcHandlers()
  return ipcHandlersCleanupPromise
}

async function runCleanupIpcHandlers(): Promise<void> {
  // Dispose all terminal data buffers
  for (const [, buf] of terminalDataBuffers) {
    buf.dispose()
  }
  terminalDataBuffers.clear()
  terminalFastPathState.clear()
  terminalOutputVisibilityState.clear()
  if (terminalIpcDiagTimer) {
    clearInterval(terminalIpcDiagTimer)
    terminalIpcDiagTimer = null
  }

  gitWatchManager?.dispose()
  gitWatchManager = null
  gitIpcWorkerClient.dispose()
  sqliteWorkerClient.dispose()
  getAppStateStorage().dispose()
  projectFsWorkerClient.dispose()
  ripgrepSearchManager?.dispose()
  ripgrepSearchManager = null
  fileWatchManager?.dispose()
  fileWatchManager = null
  imageWatchManager?.dispose()
  imageWatchManager = null
  projectTreeWatchManager?.dispose()
  projectTreeWatchManager = null
  gitDiffCacheInvalidator.dispose()
  // Tear down the GitStateMirror worker thread and parcel-watchers before
  // Electron starts tearing down Node worker isolates. Native watcher cleanup
  // can still resolve async N-API promises, so shutdown must be awaited.
  setTerminalCwdAuthorityResolver(null)
  setTerminalCwdDetectedHandler(null)
  await gitStateMirrorRouter.dispose()
  // Breadcrumb: the GitStateMirror worker has fully drained + exited on the
  // cooperative path BEFORE the runtime frees worker isolates (the will-quit
  // fire-and-forget fix). Its absence in a teardown-crash trace points at an
  // unguarded quit edge that skipped the awaited dispose.
  performanceTrace.record(PERF_TRACE_EVENT.MAIN_APP_QUIT_GSM_DRAINED, {})
  ipcMain.removeHandler(IPC.GIT_STATE_MIRROR_SUBSCRIBE)
  ipcMain.removeAllListeners(IPC.GIT_STATE_MIRROR_UNSUBSCRIBE)
  ipcMain.removeHandler(IPC.GIT_STATE_MIRROR_GET)
  ipcMain.removeHandler(IPC.GIT_STATE_MIRROR_REQUEST_FILE_BODY)
  ipcMain.removeAllListeners(IPC.GIT_STATE_PUSH_CWD)
  ipcMain.removeHandler(IPC.APP_GET_INFO)
  ipcMain.removeHandler(IPC.FEEDBACK_LOAD)
  ipcMain.removeHandler(IPC.FEEDBACK_UPDATE_PREFERENCES)
  ipcMain.removeHandler(IPC.FEEDBACK_CREATE_SUBMISSION)
  ipcMain.removeHandler(IPC.FEEDBACK_SYNC)
  ipcMain.removeHandler(IPC.FEEDBACK_REOPEN_IN_BROWSER)
  ipcMain.removeHandler(IPC.FEEDBACK_REMOVE_RECORD)
  ipcMain.removeHandler(IPC.DEBUG_FEEDBACK_RESET)
  ipcMain.removeHandler(IPC.DEBUG_FEEDBACK_SET_MOCK_ISSUES)
  ipcMain.removeHandler(IPC.DEBUG_FEEDBACK_GET_LAST_OPENED_URL)
  ipcMain.removeHandler(IPC.APP_READ_NOTICE)
  ipcMain.removeHandler(IPC.UPDATER_GET_STATUS)
  ipcMain.removeHandler(IPC.UPDATER_CHECK_NOW)
  ipcMain.removeHandler(IPC.UPDATER_DOWNLOAD_NOW)
  ipcMain.removeHandler(IPC.UPDATER_RESTART_TO_UPDATE)
  ipcMain.removeHandler(IPC.UPDATER_DISMISS_BANNER)
  ipcMain.removeHandler(IPC.TERMINAL_CREATE)
  ipcMain.removeHandler(IPC.TERMINAL_WRITE)
  ipcMain.removeHandler(IPC.TERMINAL_SEND_INPUT_SEQUENCE)
  ipcMain.removeHandler(IPC.TERMINAL_GET_INPUT_CAPABILITIES)
  ipcMain.removeAllListeners(IPC.TERMINAL_SET_BUFFER_FAST_PATH)
  ipcMain.removeAllListeners(IPC.TERMINAL_SET_OUTPUT_VISIBILITY)
  ipcMain.removeAllListeners(IPC.TERMINAL_NOTIFY_INTERACTIVE_INPUT)
  ipcMain.removeHandler(IPC.TERMINAL_RESIZE)
  ipcMain.removeHandler(IPC.TERMINAL_DISPOSE)
  ipcMain.removeHandler(IPC.PROMPT_LOAD)
  ipcMain.removeHandler(IPC.PROMPT_SAVE)
  ipcMain.removeHandler(IPC.PROMPT_DELETE)
  ipcMain.removeHandler(IPC.TERMINAL_CONFIG_LOAD)
  ipcMain.removeHandler(IPC.TERMINAL_CONFIG_SAVE)
  ipcMain.removeHandler(IPC.TERMINAL_CONFIG_UPDATE)
  ipcMain.removeHandler(IPC.DIALOG_OPEN_DIRECTORY)
  ipcMain.removeHandler(IPC.DIALOG_OPEN_TEXT_FILE)
  ipcMain.removeHandler(IPC.DIALOG_SAVE_TEXT_FILE)
  ipcMain.removeHandler(IPC.FEEDBACK_EXPORT_DIAGNOSTIC_BUNDLE)
  ipcMain.removeHandler(IPC.DEBUG_EMIT_BUNDLE_MARKER)
  ipcMain.removeHandler(IPC.SHELL_OPEN_PATH)
  ipcMain.removeHandler(IPC.SHELL_OPEN_EXTERNAL)
  ipcMain.removeHandler(IPC.CLIPBOARD_WRITE_TEXT)
  ipcMain.removeHandler(IPC.CLIPBOARD_READ_TEXT)
  browserViewManager.destroyAll()
  ipcMain.removeHandler(IPC.BROWSER_CREATE)
  ipcMain.removeHandler(IPC.BROWSER_DESTROY)
  ipcMain.removeHandler(IPC.BROWSER_EVALUATE_FOR_TEST)
  ipcMain.removeHandler(IPC.BROWSER_GET_SCROLL_STATE)
  ipcMain.removeHandler(IPC.BROWSER_RESTORE_SCROLL_STATE)
  ipcMain.removeHandler(IPC.BROWSER_FIND_IN_PAGE)
  ipcMain.removeHandler(IPC.BROWSER_STOP_FIND_IN_PAGE)
  ipcMain.removeHandler(IPC.BROWSER_NAVIGATE)
  ipcMain.removeHandler(IPC.BROWSER_GO_BACK)
  ipcMain.removeHandler(IPC.BROWSER_GO_FORWARD)
  ipcMain.removeHandler(IPC.BROWSER_RELOAD)
  ipcMain.removeHandler(IPC.BROWSER_STOP)
  ipcMain.removeHandler(IPC.BROWSER_SET_BOUNDS)
  ipcMain.removeHandler(IPC.BROWSER_SHOW)
  ipcMain.removeHandler(IPC.BROWSER_HIDE)
  ipcMain.removeHandler(IPC.BROWSER_GET_NAV_STATE)
  ipcMain.removeHandler(IPC.BROWSER_CLEAR_COOKIES)
  ipcMain.removeHandler(IPC.BROWSER_SET_REMEMBER_COOKIES)
  ipcMain.removeHandler(IPC.BROWSER_SHOW_AUTO_REFRESH_MENU)
  ipcMain.removeHandler(IPC.BROWSER_SHOW_COOKIE_MENU)
  ipcMain.removeHandler(IPC.COMMAND_PRESET_LOAD)
  ipcMain.removeHandler(IPC.COMMAND_PRESET_SAVE)
  ipcMain.removeHandler(IPC.COMMAND_PRESET_DELETE)
  ipcMain.removeHandler(IPC.CODING_AGENT_CONFIG_LOAD)
  ipcMain.removeHandler(IPC.CODING_AGENT_CONFIG_SAVE)
  ipcMain.removeHandler(IPC.CODING_AGENT_CONFIG_UPDATE)
  ipcMain.removeHandler(IPC.CODING_AGENT_CONFIG_DELETE)
  ipcMain.removeHandler(IPC.CODING_AGENT_PREPARE)
  ipcMain.removeHandler(IPC.CODING_AGENT_LAUNCH)
  ipcMain.removeHandler(IPC.APP_STATE_LOAD)
  ipcMain.removeHandler(IPC.APP_STATE_SAVE)
  ipcMain.removeHandler(IPC.APP_STATE_SAVE_PATCH)
  ipcMain.removeHandler(IPC.APP_STATE_FLUSH)
  ipcMain.removeHandler(IPC.GIT_CHECK_INSTALLED)
  ipcMain.removeHandler(IPC.GIT_RESOLVE_REPO_ROOT)
  ipcMain.removeHandler(IPC.GIT_GET_DIFF)
  ipcMain.removeHandler(IPC.GIT_GET_HISTORY)
  ipcMain.removeHandler(IPC.GIT_GET_HISTORY_DIFF)
  ipcMain.removeHandler(IPC.GIT_GET_HISTORY_FILE_CONTENT)
  ipcMain.removeHandler(IPC.GIT_GET_FILE_CONTENT)
  ipcMain.removeHandler(IPC.GIT_SAVE_FILE_CONTENT)
  ipcMain.removeHandler(IPC.GIT_STAGE_FILE)
  ipcMain.removeHandler(IPC.GIT_UNSTAGE_FILE)
  ipcMain.removeHandler(IPC.GIT_DISCARD_FILE)
  ipcMain.removeHandler(IPC.GIT_UPDATE_INDEX_CONTENT)
  ipcMain.removeHandler(IPC.GIT_GET_TERMINAL_CWD)
  ipcMain.removeHandler(IPC.GIT_GET_TERMINAL_INFO)
  ipcMain.removeHandler(IPC.GIT_SUBSCRIBE_TERMINAL_INFO)
  ipcMain.removeHandler(IPC.GIT_UNSUBSCRIBE_TERMINAL_INFO)
  ipcMain.removeHandler(IPC.GIT_NOTIFY_TERMINAL_ACTIVITY)
  ipcMain.removeHandler(IPC.GIT_NOTIFY_TERMINAL_FOCUS)
  ipcMain.removeHandler(IPC.GIT_NOTIFY_TERMINAL_GIT_UPDATE)
  ipcMain.removeHandler(IPC.PROJECT_LIST_DIRECTORY)
  ipcMain.removeHandler(IPC.PROJECT_BUILD_FILE_INDEX)
  ipcMain.removeHandler(IPC.PROJECT_SEARCH_FILENAMES)
  ipcMain.removeHandler(IPC.PROJECT_INVALIDATE_FILE_INDEX)
  ipcMain.removeHandler(IPC.PROJECT_READ_FILE)
  ipcMain.removeHandler(IPC.PROJECT_READ_FILE_CHUNK)
  ipcMain.removeHandler(IPC.PROJECT_SAVE_FILE)
  ipcMain.removeHandler(IPC.PROJECT_CREATE_FILE)
  ipcMain.removeHandler(IPC.PROJECT_CREATE_FOLDER)
  ipcMain.removeHandler(IPC.PROJECT_RENAME_PATH)
  ipcMain.removeHandler(IPC.PROJECT_DELETE_PATH)
  ipcMain.removeHandler(IPC.PROJECT_SEARCH_START)
  ipcMain.removeHandler(IPC.PROJECT_SEARCH_CANCEL)
  ipcMain.removeHandler(IPC.PROJECT_TREE_WATCH_START)
  ipcMain.removeHandler(IPC.PROJECT_TREE_WATCH_STOP)
  ipcMain.removeHandler(IPC.PROJECT_WATCH_FILE)
  ipcMain.removeHandler(IPC.PROJECT_UNWATCH_FILE)
  ipcMain.removeHandler(IPC.PROJECT_WATCH_IMAGE_FILES)
  ipcMain.removeHandler(IPC.PROJECT_UNWATCH_IMAGE_FILES)
  ipcMain.removeHandler(IPC.PROJECT_UNWATCH_ALL_IMAGE_FILES)
  ipcMain.removeHandler(IPC.SETTINGS_LOAD)
  ipcMain.removeHandler(IPC.SETTINGS_SAVE)
  ipcMain.removeHandler(IPC.SETTINGS_UPDATE)
  ipcMain.removeHandler(IPC.SETTINGS_REGISTER_SHORTCUTS)
  ipcMain.removeHandler(IPC.SETTINGS_CHECK_SHORTCUT_AVAILABLE)
  ipcMain.removeHandler(IPC.SETTINGS_CHECK_SHORTCUT_CONFLICT)
  ipcMain.removeHandler(IPC.TELEMETRY_TRACK)
  ipcMain.removeHandler(IPC.TELEMETRY_GET_CONSENT)
  ipcMain.removeHandler(IPC.TELEMETRY_SET_CONSENT)
  ipcMain.removeHandler(IPC.DEBUG_GET_APP_METRICS)
  ipcMain.removeHandler(IPC.DEBUG_FOCUS_WINDOW)
  ipcMain.removeHandler(IPC.DEBUG_GET_GIT_RUNTIME_METRICS)
  ipcMain.removeHandler(IPC.DEBUG_GET_MAIN_WORK_METRICS)
  ipcMain.removeHandler(IPC.DEBUG_GET_PERF_TRACE_INFO)
  ipcMain.removeHandler(IPC.DEBUG_RESET_PERF_TRACE_METRICS)
  ipcMain.removeHandler('debug:get-api-server-port')
  ipcMain.removeHandler('debug:post-api-terminal-write')
  ipcMain.removeHandler('debug:autotest-write-external-file')
  ipcMain.removeHandler('performance-trace:record')
  ipcMain.removeHandler('performance-trace:get-status')
  ipcMain.removeHandler('performance-trace:flush')
  ipcMain.removeHandler(IPC.DEBUG_READ_TELEMETRY_LOG)
  ipcMain.removeHandler(IPC.DEBUG_QUIT)
  ipcMain.removeAllListeners(IPC.DEBUG_LOG)
  ipcMain.removeAllListeners(IPC.DEBUG_PERF_TRACE)
  ipcMain.removeAllListeners(IPC.TERMINAL_BUFFER_RESPONSE)
  ipcMain.removeAllListeners(IPC.PROMPT_BRIDGE_RESPONSE)
  // Clear all pending buffer requests
  for (const [, pending] of bufferRequestCallbacks) {
    clearTimeout(pending.timer)
  }
  bufferRequestCallbacks.clear()
  // Clean up all pending Prompt Bridge requests
  for (const [, pending] of promptBridgeCallbacks) {
    clearTimeout(pending.timer)
  }
  promptBridgeCallbacks.clear()
  ptyManager.disposeAll()
  // Unregister all shortcuts
  getShortcutManager().unregisterAll()
}
