/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

import { Terminal as XTerm } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { SearchAddon } from '@xterm/addon-search'
import { installOscCwdAddon } from '../components/Terminal/oscCwdAddon'
import { getTheme, ThemeName } from '../themes/terminal-themes'
import type { TerminalStyleConfig } from '../types/settings.d.ts'
import type { TerminalBufferOptions, TerminalBufferResult } from '../types/electron.d.ts'
import { requestOpenExternalHttpLink } from '../utils/externalLink'
import { perfMonitor } from '../utils/perf-monitor'
import { perfTraceTask, perfTraceDiagnostic } from '../utils/perf-trace'
import { PERF_TRACE_EVENT } from '../utils/perf-trace-names'
import { inputPriorityLane } from './input-priority-lane'
import { TerminalOutputScheduler } from './terminal-output-scheduler'
import {
  TerminalRendererLifecycle,
  createTerminalRendererPolicy,
  type TerminalRendererLifecycleReason,
  type TerminalRendererLifecycleResult,
  type TerminalRendererMode,
  type TerminalRendererPolicy,
  type TerminalRendererSurfaceEvent
} from './terminal-renderer-lifecycle'
import { performanceTrace } from '../utils/performance-trace'

export type { TerminalRendererSurfaceEvent } from './terminal-renderer-lifecycle'

export type TerminalSessionStatus = 'idle' | 'initializing' | 'ready' | 'error' | 'disposed'

export interface TerminalSessionOptions {
  theme: ThemeName
  fontSize: number
  fontFamily: string
  terminalStyle?: TerminalStyleConfig | null
}

export interface TerminalFocusSessionDebugSnapshot {
  exists: boolean
  open: boolean | null
  status: TerminalSessionStatus | null
  visible: boolean | null
  hasContainer: boolean
  containerConnected: boolean
  containerWidth: number | null
  containerHeight: number | null
  containerDisplay: string | null
  hasTextarea: boolean
  textareaConnected: boolean
  textareaDisabled: boolean | null
  textareaTabIndex: number | null
  textareaDisplay: string | null
  terminalElementConnected: boolean
  activeElementMatchesTextarea: boolean
}

type TerminalBufferType = 'normal' | 'alternate'
// Viewport restore is only needed when the terminal's geometry/mount changes.
// Output is handled by xterm's native isUserScrolling — we don't intercept it.
type TerminalViewportRestoreReason = 'fit' | 'attach'

interface TerminalViewportRestoreState {
  followBottom: boolean
  viewportY: number
  bufferType: TerminalBufferType
  reason: TerminalViewportRestoreReason
  capturedAt: number
}

export interface TerminalViewportDebugState {
  terminalId: string
  bufferType: TerminalBufferType
  baseY: number
  viewportY: number
  rows: number
  cols: number
  isNearBottom: boolean
  userWantsBottom: boolean
  pendingRestore: TerminalViewportRestoreState | null
}

export interface TerminalSessionDebugState {
  terminalId: string
  status: TerminalSessionStatus
  open: boolean
  visible: boolean
  outputVisible: boolean
  webglActive: boolean
  rendererMode: TerminalRendererMode
  rendererWebglAvailable: boolean
  rendererWebglFailureCount: number
  rendererWebglDisabledUntil: number | null
  rendererContextLost: boolean
  rendererHasContextListeners: boolean
  rendererLastLifecycleReason: TerminalRendererLifecycleReason | null
  rendererLastSurfaceEvent: TerminalRendererSurfaceEvent | null
  pendingDataChunks: number
  pendingDataBytes: number
}

interface TerminalSession {
  id: string
  terminal: XTerm
  fitAddon: FitAddon
  searchAddon: SearchAddon
  status: TerminalSessionStatus
  readyPromise: Promise<void> | null
  open: boolean
  container: HTMLDivElement | null
  lastCols: number
  lastRows: number
  lastFitWidth: number
  lastFitHeight: number
  renderer: TerminalRendererLifecycle
  lastOptions: TerminalSessionOptions | null
  pendingViewportRestore: TerminalViewportRestoreState | null
  pendingRestoreAnimationFrame: number | null
  pendingGeometryRefreshAnimationFrame: number | null
  // Visibility-based rendering optimization
  visible: boolean
  outputVisible: boolean
  pendingData: string[]
  pendingDataBytes: number
  interactiveBoostUntil: number
}

// Maximum bytes to buffer per hidden terminal before discarding old data.
// 512 KB is enough to hold several screens of output while preventing
// unbounded memory growth for long-running hidden sessions.
const PENDING_DATA_MAX_BYTES = 512 * 1024
const VISIBLE_PENDING_DATA_MAX_BYTES = 8 * 1024 * 1024

// Throttle interval for visible terminal writes.  Instead of calling
// terminal.write() on every IPC message (which can reach 18,000/s across
// 6 terminals and starve the main thread), we accumulate data per-session
// and flush once per interval via requestAnimationFrame.  50 ms ≈ 20 fps
// for terminal updates — visually smooth while leaving ~70% of each frame
// budget free for user input, React renders, and other UI work.
const VISIBLE_WRITE_THROTTLE_MS = 20
// Spacing between hidden-tab WebGL disposals (see queueStaggeredDeactivation).
// Back-to-back context destruction is the ANGLE-Metal GPU-crash trigger
// window; ~2 frames of separation breaks the burst without keeping hidden
// tabs on the GPU for a perceptible time.
const STAGGERED_DEACTIVATE_INTERVAL_MS = 32
const INTERACTIVE_BOOST_WINDOW_MS = 250

const DEFAULT_COLS = 80
const DEFAULT_ROWS = 24
const AUTOFOLLOW_THRESHOLD_LINES = 2

function resolveTerminalFontFamily(options: TerminalSessionOptions): string {
  const styleFontFamily = options.terminalStyle?.fontFamily
  return styleFontFamily && styleFontFamily.trim() ? styleFontFamily : options.fontFamily
}

function resolveTerminalFontSize(options: TerminalSessionOptions): number {
  const styleFontSize = options.terminalStyle?.fontSize
  return typeof styleFontSize === 'number' && Number.isFinite(styleFontSize) && styleFontSize > 0
    ? styleFontSize
    : options.fontSize
}

function handleTerminalLinkClick(_event: MouseEvent, uri: string) {
  void requestOpenExternalHttpLink(uri).then((result) => {
    if (!result.success && result.error && !result.canceled && !result.blocked) {
      console.warn('[TerminalSessionManager] Failed to open external link:', result.error)
    }
  })
}

function buildTheme(options: TerminalSessionOptions) {
  const baseTheme = getTheme(options.theme)
  const terminalStyle = options.terminalStyle

  return {
    ...baseTheme,
    ...(terminalStyle?.foregroundColor && { foreground: terminalStyle.foregroundColor }),
    ...(terminalStyle?.backgroundColor && { background: terminalStyle.backgroundColor })
  }
}

export class TerminalSessionManager {
  private sessions: Map<string, TerminalSession> = new Map()
  private readonly rendererPolicy: TerminalRendererPolicy = createTerminalRendererPolicy(window.electronAPI.platform)
  private outputVisibilityState: Map<string, boolean> = new Map()
  private bufferRequestUnsubscribe: (() => void) | null = null
  // Centralized IPC listeners: single global listener dispatches by terminal ID via Map lookup
  private globalDataUnsubscribe: (() => void) | null = null
  private globalExitUnsubscribe: (() => void) | null = null
  private readonly outputScheduler = new TerminalOutputScheduler({
    batchIntervalMs: VISIBLE_WRITE_THROTTLE_MS
  })
  private activeInteractiveTerminalId: string | null = null
  private surfaceRestoreTimeoutId: number | null = null
  private surfaceRestoreAnimationFrameId: number | null = null
  // Hidden-tab WebGL disposals pending the staggered pump (see
  // queueStaggeredDeactivation). Set preserves insertion order and gives
  // O(1) cancellation when a terminal turns visible again while queued.
  private staggeredDeactivateQueue = new Set<string>()
  private staggeredDeactivateTimerId: number | null = null
  private rendererRecoveryCount = 0
  // Autotest-only: cache the WEBGL_lose_context extension for each terminal
  // so the repro can call `restoreContext()` on the same instance that was
  // used to call `loseContext()`. Re-calling `gl.getExtension()` after the
  // context is lost can return null in Chromium, which would otherwise
  // strand the test in the lost state forever.
  private reproLoseContextExts: Map<string, { restoreContext?: () => void }> = new Map()

  constructor() {
    this.registerBufferRequestListener()
    this.registerGlobalDataListener()
    this.registerGlobalExitListener()
  }

  /**
   * Single global listener for terminal:data IPC.
   * Dispatches to the correct session via Map.get() — O(1) per message
   * instead of O(N) when each session had its own listener filtering by ID.
   */
  // Small data threshold for the fast path — must match the main-process
  // TerminalDataBuffer.FAST_PATH_THRESHOLD so that interactive keystroke
  // echoes bypass BOTH the IPC buffer and the renderer throttle.
  private static readonly INTERACTIVE_FAST_PATH_BYTES = 128

  private registerGlobalDataListener(): void {
    this.globalDataUnsubscribe = window.electronAPI.terminal.onData((termId, data) => {
      const session = this.sessions.get(termId)
      if (!session) return

      perfMonitor.recordIpcData(data.length)
      perfTraceTask(PERF_TRACE_EVENT.RENDERER_TERMINAL_DATA_IPC_RECV, {
        bytes: data.length
      }, termId)
      const flowId = performanceTrace.getActiveTerminalFlow(termId)
      if (flowId) {
        performanceTrace.refreshTerminalFlow(termId)
        performanceTrace.recordFlowStep('terminal.render.receive', flowId, {
          terminalId: termId,
          visible: session.visible,
          bytes: data.length,
          pendingBytes: session.pendingDataBytes
        }, 'terminal')
      }
      performanceTrace.recordInstant('terminal.render.receive', {
        terminalId: termId,
        visible: session.visible,
        bytes: data.length,
        pendingBytes: session.pendingDataBytes,
        flowId: flowId ?? undefined
      }, 'terminal')

      const interactiveBoostActive = this.shouldUseInteractiveBoost(session)
      const outputActive = this.isOutputActive(session)

      // Fast path: for visible terminals with no pending data, write small
      // interactive data (keystroke echoes) directly to xterm, bypassing
      // the 50 ms throttled flush.  This eliminates the renderer-side
      // latency for interactive typing while preserving viewport intent
      // (autofollow / manual scroll restoration).
      if (
        outputActive &&
        session.terminal &&
        (
          interactiveBoostActive ||
          (
            data.length <= TerminalSessionManager.INTERACTIVE_FAST_PATH_BYTES &&
            session.pendingDataBytes === 0
          )
        )
      ) {
        if (interactiveBoostActive && session.pendingDataBytes > 512 * 1024) {
          session.pendingData.push(data)
          session.pendingDataBytes += data.length
          this.trimPendingData(session, VISIBLE_PENDING_DATA_MAX_BYTES)
          this.outputScheduler.markDirty(termId, true)
          return
        }

        if (interactiveBoostActive && session.pendingDataBytes > 0) {
          session.pendingData.push(data)
          session.pendingDataBytes += data.length
          this.trimPendingData(session, VISIBLE_PENDING_DATA_MAX_BYTES)
          this.outputScheduler.markDirty(termId, true)
          const ksTs = (session as any)._lastKeystrokeTs as number | undefined
          if (ksTs && data.length <= 16) {
            perfMonitor.recordInputLatency(performance.now() - ksTs)
            ;(session as any)._lastKeystrokeTs = undefined
          }
          return
        }
        perfTraceTask(PERF_TRACE_EVENT.RENDERER_TERMINAL_DATA_FAST_PATH, {
          bytes: data.length,
          interactiveBoost: interactiveBoostActive
        }, termId)
        this.writeTerminalData(session, data)

        // Still record input latency for the perf monitor
        const ksTs = (session as any)._lastKeystrokeTs as number | undefined
        if (ksTs && data.length <= 16) {
          perfMonitor.recordInputLatency(performance.now() - ksTs)
          ;(session as any)._lastKeystrokeTs = undefined
        }
        return
      }

      // Slow path: buffer data for throttled flush.
      // Visible terminals are flushed on a throttled schedule (every 50ms);
      // hidden terminals keep buffering until they become visible.
      session.pendingData.push(data)
      session.pendingDataBytes += data.length

      if (!outputActive) {
        this.trimPendingData(session, PENDING_DATA_MAX_BYTES)
        perfMonitor.recordHiddenTermWrite(data.length)
        performanceTrace.recordCounter('terminal.render.hidden_buffer', {
          terminalId: termId,
          pendingBytes: session.pendingDataBytes,
          pendingChunks: session.pendingData.length
        }, 'terminal')
        return
      }

      this.trimPendingData(session, VISIBLE_PENDING_DATA_MAX_BYTES)

      this.outputScheduler.markDirty(termId, interactiveBoostActive)
      perfTraceTask(PERF_TRACE_EVENT.RENDERER_TERMINAL_DATA_SCHEDULER_ENQUEUE, {
        bytes: data.length,
        pendingBytes: session.pendingDataBytes,
        interactiveBoost: interactiveBoostActive
      }, termId)

      // Input latency: time from keystroke to echo arrival
      const ksTs = (session as any)._lastKeystrokeTs as number | undefined
      if (ksTs && data.length <= 16) {
        perfMonitor.recordInputLatency(performance.now() - ksTs)
        ;(session as any)._lastKeystrokeTs = undefined
      }
    })
  }

  /**
   * Single global listener for terminal:exit IPC.
   */
  private registerGlobalExitListener(): void {
    this.globalExitUnsubscribe = window.electronAPI.terminal.onExit((termId, exitCode) => {
      const session = this.sessions.get(termId)
      if (!session) return

      session.terminal.writeln(`\r\n[Process exited with code ${exitCode}]`)
      session.terminal.writeln('\r\n[Press any key to restart...]')

      // Clean up dead PTY in main process
      window.electronAPI.terminal.dispose(termId)

      // Reset session state so ensureReady can re-create
      session.status = 'idle'
      session.readyPromise = null

      // Wait for any key press to restart
      const disposable = session.terminal.onData(() => {
        disposable.dispose()
        this.restartShell(termId)
      })
    })
  }

  private registerBufferRequestListener(): void {
    this.bufferRequestUnsubscribe = window.electronAPI.terminal.onGetBufferRequest(
      (requestId: string, terminalId: string, options?: TerminalBufferOptions) => {
        const result = this.getBufferContent(terminalId, options)
        window.electronAPI.terminal.sendBufferResponse(requestId, result)
      }
    )
  }

  private isNearBottom(baseY: number, viewportY: number): boolean {
    return baseY - viewportY <= AUTOFOLLOW_THRESHOLD_LINES
  }

  private getActiveViewportState(session: TerminalSession) {
    const buffer = session.terminal.buffer.active
    return {
      bufferType: buffer.type as TerminalBufferType,
      baseY: buffer.baseY,
      viewportY: buffer.viewportY
    }
  }

  private captureViewportIntent(
    session: TerminalSession,
    reason: TerminalViewportRestoreReason
  ): TerminalViewportRestoreState | null {
    if (!session.open) return null
    if (session.pendingViewportRestore) return session.pendingViewportRestore

    const viewport = this.getActiveViewportState(session)
    // "At bottom" before fit/attach means the user expects auto-follow; preserve
    // that intent across the geometry change. Otherwise preserve the exact line.
    const followBottom = this.isNearBottom(viewport.baseY, viewport.viewportY)
    const pending: TerminalViewportRestoreState = {
      followBottom,
      viewportY: viewport.viewportY,
      bufferType: viewport.bufferType,
      reason,
      capturedAt: Date.now()
    }

    session.pendingViewportRestore = pending
    return pending
  }

  private clearPendingRestoreAnimationFrame(session: TerminalSession): void {
    if (session.pendingRestoreAnimationFrame !== null) {
      cancelAnimationFrame(session.pendingRestoreAnimationFrame)
      session.pendingRestoreAnimationFrame = null
    }
  }

  private clearPendingGeometryRefreshAnimationFrame(session: TerminalSession): void {
    if (session.pendingGeometryRefreshAnimationFrame !== null) {
      cancelAnimationFrame(session.pendingGeometryRefreshAnimationFrame)
      session.pendingGeometryRefreshAnimationFrame = null
    }
  }

  private scheduleGeometryRefresh(session: TerminalSession): void {
    if (!session.open || !session.container || session.status === 'disposed') return

    this.clearPendingGeometryRefreshAnimationFrame(session)
    const sessionId = session.id

    session.pendingGeometryRefreshAnimationFrame = requestAnimationFrame(() => {
      const currentSession = this.sessions.get(sessionId)
      if (!currentSession || currentSession.status === 'disposed') return

      currentSession.pendingGeometryRefreshAnimationFrame = null
      this.forceFit(sessionId)
    })
  }

  private applyPendingViewportRestore(
    session: TerminalSession,
    _reason: TerminalViewportRestoreReason
  ): void {
    const pending = session.pendingViewportRestore
    if (!pending || session.status === 'disposed') return

    const before = this.getActiveViewportState(session)
    // Don't try to restore across an alternate-buffer boundary: the target
    // viewportY doesn't map to the other buffer's coordinate space.
    if (before.bufferType !== pending.bufferType) {
      session.pendingViewportRestore = null
      return
    }

    if (pending.followBottom) {
      session.terminal.scrollToBottom()
    } else {
      const targetLine = Math.max(0, Math.min(pending.viewportY, before.baseY))
      session.terminal.scrollToLine(targetLine)
    }

    session.pendingViewportRestore = null
  }

  private schedulePendingViewportRestore(
    session: TerminalSession,
    reason: TerminalViewportRestoreReason
  ): void {
    if (!session.pendingViewportRestore || !session.open) return
    this.clearPendingRestoreAnimationFrame(session)
    session.pendingRestoreAnimationFrame = requestAnimationFrame(() => {
      session.pendingRestoreAnimationFrame = null
      this.applyPendingViewportRestore(session, reason)
    })
  }

  getBufferContent(id: string, options?: TerminalBufferOptions): TerminalBufferResult {
    const session = this.sessions.get(id)
    if (!session) {
      return { success: false, terminalId: id, error: `Terminal ${id} does not exist` }
    }

    const mode = options?.mode ?? 'tail-lines'
    const trimTrailingEmpty = options?.trimTrailingEmpty !== false
    const bufferTarget = options?.buffer ?? 'active'

    try {
      // Detect the currently activated buffer type
      const activeBufferType = session.terminal.buffer.active.type as 'normal' | 'alternate'

      // Select the buffer to read based on bufferTarget
      let buffer
      if (bufferTarget === 'normal') {
        buffer = session.terminal.buffer.normal
      } else if (bufferTarget === 'alternate') {
        buffer = session.terminal.buffer.alternate
      } else {
        buffer = session.terminal.buffer.active
      }

      const totalLines = buffer.length

      // Read buffer contents line by line
      const lines: string[] = []
      for (let i = 0; i < totalLines; i++) {
        const line = buffer.getLine(i)
        if (line) {
          lines.push(line.translateToString(true))
        }
      }

      // Remove trailing blank lines
      if (trimTrailingEmpty) {
        while (lines.length > 0 && lines[lines.length - 1].trim() === '') {
          lines.pop()
        }
      }

      let content: string
      let returnedLines: number
      let returnedChars: number
      let truncated = false

      if (mode === 'tail-chars') {
        const lastChars = options?.lastChars ?? 500
        const fullContent = lines.join('\n')
        if (fullContent.length > lastChars) {
          content = fullContent.slice(-lastChars)
          truncated = true
        } else {
          content = fullContent
        }
        returnedChars = content.length
        returnedLines = content.split('\n').length
      } else {
        // tail-lines (default)
        const lastLines = options?.lastLines ?? 100
        const offset = options?.offset ?? 0

        // offset represents the number of lines skipped from the end, used to incrementally read earlier content
        // For example offset=0, lines=100 → last 100 lines
        //      offset=100, lines=100 → lines 101-200 from the last
        const endIndex = offset > 0 ? lines.length - offset : lines.length
        const startIndex = Math.max(0, endIndex - lastLines)

        if (endIndex <= 0) {
          // offset is out of range, no more content
          content = ''
          returnedLines = 0
        } else {
          const sliced = lines.slice(startIndex, endIndex)
          content = sliced.join('\n')
          returnedLines = sliced.length
          truncated = startIndex > 0
        }
        returnedChars = content.length
      }

      return {
        success: true,
        terminalId: id,
        content,
        totalLines: lines.length,
        returnedLines,
        returnedChars,
        truncated,
        capturedAt: Date.now(),
        bufferType: activeBufferType
      }
    } catch (error) {
      return { success: false, terminalId: id, error: String(error) }
    }
  }

  private applyOptions(session: TerminalSession, options: TerminalSessionOptions) {
    const previousOptions = session.lastOptions
    const previousFontFamily = previousOptions
      ? resolveTerminalFontFamily(previousOptions)
      : String(session.terminal.options.fontFamily ?? '')
    const previousFontSize = previousOptions
      ? resolveTerminalFontSize(previousOptions)
      : Number(session.terminal.options.fontSize ?? options.fontSize)
    const nextFontFamily = resolveTerminalFontFamily(options)
    const nextFontSize = resolveTerminalFontSize(options)
    const fontMetricsChanged = previousFontFamily !== nextFontFamily || previousFontSize !== nextFontSize

    session.terminal.options.theme = buildTheme(options)
    session.terminal.options.fontFamily = nextFontFamily
    session.terminal.options.fontSize = nextFontSize
    session.lastOptions = options

    if (fontMetricsChanged) {
      this.scheduleGeometryRefresh(session)
    }
  }

  getViewportDebugState(id: string): TerminalViewportDebugState | null {
    const session = this.sessions.get(id)
    if (!session) return null

    const viewport = this.getActiveViewportState(session)
    const nearBottom = this.isNearBottom(viewport.baseY, viewport.viewportY)
    return {
      terminalId: id,
      bufferType: viewport.bufferType,
      baseY: viewport.baseY,
      viewportY: viewport.viewportY,
      rows: session.terminal.rows,
      cols: session.terminal.cols,
      isNearBottom: nearBottom,
      // In the simplified model there is no separate "user wants bottom" flag:
      // auto-follow intent is synonymous with currently being near the bottom,
      // which is exactly what xterm's isUserScrolling toggles on.
      userWantsBottom: nearBottom,
      pendingRestore: session.pendingViewportRestore
    }
  }

  private isOutputActive(session: TerminalSession): boolean {
    return session.visible && session.outputVisible
  }

  private syncMainOutputVisibility(session: TerminalSession): void {
    const outputActive = this.isOutputActive(session)
    window.electronAPI.terminal.setBufferFastPath(session.id, outputActive)
    window.electronAPI.terminal.setOutputVisibility(session.id, outputActive)
  }

  getSessionDebugState(id: string): TerminalSessionDebugState | null {
    const session = this.sessions.get(id)
    if (!session) return null
    const renderer = session.renderer.getSnapshot()
    return {
      terminalId: id,
      status: session.status,
      open: session.open,
      visible: session.visible,
      outputVisible: session.outputVisible,
      webglActive: renderer.webglActive,
      rendererMode: renderer.mode,
      rendererWebglAvailable: renderer.webglAvailable,
      rendererWebglFailureCount: renderer.webglFailureCount,
      rendererWebglDisabledUntil: renderer.webglDisabledUntil,
      rendererContextLost: renderer.contextLost,
      rendererHasContextListeners: renderer.hasContextListeners,
      rendererLastLifecycleReason: renderer.lastLifecycleReason,
      rendererLastSurfaceEvent: renderer.lastSurfaceEvent,
      pendingDataChunks: session.pendingData.length,
      pendingDataBytes: session.pendingDataBytes
    }
  }

  getRendererRecoveryCount(): number {
    return this.rendererRecoveryCount
  }

  simulateRendererSurfaceLossForAutotest(id: string): boolean {
    const session = this.sessions.get(id)
    if (!session?.open || session.status !== 'ready') return false

    session.renderer.deactivate('manual-debug')
    return true
  }

  triggerRealWebglContextLossForRepro(id?: string): {
    triggered: boolean
    reason: string
    terminalId: string | null
  } {
    const terminalId = id ?? this.getFocusedTerminalId() ?? this.sessions.keys().next().value ?? null
    if (!terminalId) {
      return { triggered: false, reason: 'no-terminal-id', terminalId: null }
    }
    const session = this.sessions.get(terminalId)
    if (!session?.open || session.status !== 'ready') {
      return { triggered: false, reason: 'session-not-ready', terminalId }
    }
    if (!session.renderer.isWebglActive()) {
      return { triggered: false, reason: 'webgl-not-active', terminalId }
    }
    const canvas = session.renderer.getObservedCanvas()
    if (!canvas) {
      return { triggered: false, reason: 'no-webgl-canvas', terminalId }
    }
    const gl =
      (canvas.getContext('webgl2') as WebGL2RenderingContext | null) ??
      (canvas.getContext('webgl') as WebGLRenderingContext | null)
    if (!gl) {
      return { triggered: false, reason: 'no-gl-context', terminalId }
    }
    const ext = gl.getExtension('WEBGL_lose_context') as {
      loseContext?: () => void
      restoreContext?: () => void
    } | null
    if (!ext?.loseContext) {
      return { triggered: false, reason: 'no-lose-context-extension', terminalId }
    }
    // Cache the extension before triggering loss — Chromium may return null
    // from `getExtension` after the context is lost, so we'd otherwise be
    // unable to call `restoreContext` to drive the round-trip in autotest.
    this.reproLoseContextExts.set(terminalId, ext)
    ext.loseContext()
    return { triggered: true, reason: 'lose-context-called', terminalId }
  }

  forceWebglContextRestoreForRepro(id?: string): {
    triggered: boolean
    reason: string
    terminalId: string | null
  } {
    const terminalId = id ?? this.getFocusedTerminalId() ?? this.sessions.keys().next().value ?? null
    if (!terminalId) {
      return { triggered: false, reason: 'no-terminal-id', terminalId: null }
    }
    const cached = this.reproLoseContextExts.get(terminalId)
    if (cached?.restoreContext) {
      cached.restoreContext()
      this.reproLoseContextExts.delete(terminalId)
      return { triggered: true, reason: 'restore-context-called', terminalId }
    }
    return { triggered: false, reason: 'no-cached-extension', terminalId }
  }

  simulatePhantomBlankForRepro(id?: string): {
    triggered: boolean
    reason: string
    terminalId: string | null
  } {
    const terminalId = id ?? this.getFocusedTerminalId() ?? this.sessions.keys().next().value ?? null
    if (!terminalId) {
      return { triggered: false, reason: 'no-terminal-id', terminalId: null }
    }
    const session = this.sessions.get(terminalId)
    if (!session?.open || session.status !== 'ready') {
      return { triggered: false, reason: 'session-not-ready', terminalId }
    }
    const element = session.terminal.element
    if (!element) {
      return { triggered: false, reason: 'no-element', terminalId }
    }
    const canvases = element.querySelectorAll('canvas')
    let cleared = 0
    for (const canvas of Array.from(canvases)) {
      const gl =
        (canvas.getContext('webgl2') as WebGL2RenderingContext | null) ??
        (canvas.getContext('webgl') as WebGLRenderingContext | null)
      if (!gl) continue
      gl.clearColor(1, 1, 1, 1)
      gl.clear(gl.COLOR_BUFFER_BIT)
      cleared += 1
    }
    if (cleared === 0) {
      return { triggered: false, reason: 'no-webgl-canvas', terminalId }
    }
    return { triggered: true, reason: 'phantom-blank-applied', terminalId }
  }

  scrollToTop(id: string): boolean {
    const session = this.sessions.get(id)
    if (!session?.open) return false
    this.clearPendingRestoreAnimationFrame(session)
    session.pendingViewportRestore = null
    session.terminal.scrollToTop()
    return true
  }

  /**
   * Autotest-only: synthesize PTY output as if the underlying process had
   * written `data` to its stdout. Used to reproduce OSC injection scenarios
   * (TTM-29..31 / OSC 0/1/2 title sequences from Claude CLI and similar
   * inner programs) without spawning a real shell that echoes the bytes.
   */
  injectPtyDataForAutotest(id: string, data: string): boolean {
    const session = this.sessions.get(id)
    if (!session?.open || typeof data !== 'string' || data.length === 0) return false
    this.writeTerminalData(session, data)
    return true
  }

  scrollToBottom(id: string): boolean {
    const session = this.sessions.get(id)
    if (!session?.open) return false
    this.clearPendingRestoreAnimationFrame(session)
    this.clearPendingGeometryRefreshAnimationFrame(session)
    session.pendingViewportRestore = null
    session.terminal.scrollToBottom()
    return true
  }

  /**
   * Scroll the terminal by a relative number of lines as if the user did it.
   * `lines < 0` scrolls up (xterm sets isUserScrolling=true), `lines > 0`
   * scrolls down (xterm clears the flag when it reaches the bottom).
   * This is the correct way for tests to simulate a real wheel / PageUp.
   */
  scrollLinesAsUser(id: string, lines: number): boolean {
    const session = this.sessions.get(id)
    if (!session?.open || !Number.isFinite(lines) || lines === 0) return false
    session.terminal.scrollLines(lines)
    return true
  }

  private createSession(id: string, options: TerminalSessionOptions): TerminalSession {
    const terminal = new XTerm({
      theme: buildTheme(options),
      fontSize: resolveTerminalFontSize(options),
      fontFamily: resolveTerminalFontFamily(options),
      cursorBlink: true,
      cursorStyle: 'block',
      allowProposedApi: true,
      scrollback: 10000,
      tabStopWidth: 4,
      rightClickSelectsWord: true,
      // Auto-follow semantics live entirely in xterm: when the user hasn't
      // scrolled away, output stays pinned to the bottom; when they have,
      // their position is preserved. Typing snaps back to the bottom.
      scrollOnUserInput: true
    })

    const fitAddon = new FitAddon()
    const webLinksAddon = new WebLinksAddon(handleTerminalLinkClick)
    const searchAddon = new SearchAddon()

    terminal.loadAddon(fitAddon)
    terminal.loadAddon(webLinksAddon)
    terminal.loadAddon(searchAddon)

    // GitStateMirror cwd push: parse OSC 7 / 633 / 1337 / 9 from PTY data
    // and notify both the worker (so it can switch its watcher root) AND
    // the renderer-side TerminalGrid (so the chip immediately reflects the
    // new cwd without waiting for a fanout round-trip). The IDisposable
    // returned by `installOscCwdAddon` is tied to the parser; xterm.js
    // tears down all parser handlers in `terminal.dispose()` so explicit
    // cleanup here would only matter if we wanted to swap the addon mid-
    // session, which we don't.
    installOscCwdAddon(terminal, {
      terminalId: id,
      // Watcher-independent freshness (2026-07-05): a completed state-mutating
      // git command in this terminal reconciles its cwd's mirror even when the
      // FS watcher dropped the `.git` write. Only the classified subcommand
      // crosses IPC — never the raw command line.
      notifyGitCommand: (terminalId, subcommand, createsRepo) => {
        try {
          (window as unknown as { electronAPI?: { git?: { notifyTerminalGitCommand?: (p: { terminalId: string; subcommand: string; createsRepo: boolean }) => void } } })
            .electronAPI?.git?.notifyTerminalGitCommand?.({ terminalId, subcommand, createsRepo })
        } catch { /* ignore */ }
      },
      pushCwd: (terminalId, cwd) => {
        try {
          (window as unknown as { electronAPI?: { git?: { pushCwd?: (id: string, cwd: string | null) => void } } })
            .electronAPI?.git?.pushCwd?.(terminalId, cwd)
        } catch { /* ignore */ }
        // Local synchronous notification — TerminalGrid listens on
        // 'onward:terminal-cwd-detected' so the chip's branch + colour can
        // clear-then-fill in the gap before the mirror fanout lands. This
        // is the renderer-side analogue of `pushCwd` but stays in the
        // single renderer process via a CustomEvent rather than IPC.
        try {
          window.dispatchEvent(new CustomEvent('onward:terminal-cwd-detected', {
            detail: { terminalId, cwd }
          }))
        } catch { /* ignore */ }
      }
    })

    // Windows / Linux: Ctrl+C copies selected text, otherwise sends interrupt;
    // Ctrl+V pastes from clipboard. On macOS these shortcuts are handled by
    // Cmd+C / Cmd+V natively, so we leave Ctrl+C as pure SIGINT.
    const isMac = /Mac OS X|Macintosh/.test(navigator.userAgent)
    if (!isMac) {
      terminal.attachCustomKeyEventHandler((event) => {
        if (event.ctrlKey && !event.shiftKey && !event.altKey && event.code === 'KeyC') {
          if (terminal.hasSelection()) {
            if (event.type === 'keydown') {
              void navigator.clipboard.writeText(terminal.getSelection())
              terminal.clearSelection()
            }
            return false
          }
        }

        if (event.ctrlKey && !event.shiftKey && !event.altKey && event.code === 'KeyV') {
          if (event.type === 'keydown') {
            event.preventDefault()
            void navigator.clipboard.readText().then((text) => {
              if (text) {
                // Use xterm.js paste() so bracketed paste mode is applied
                terminal.paste(text)
              }
            })
          }
          return false
        }

        return true
      })
    }

    terminal.onData((data) => {
      // Record keystroke timestamp for input latency measurement.
      // The matching echo arrives in registerGlobalDataListener.
      if (data.length <= 4) {
        // Only track short inputs (keystrokes) — not pasted blocks
        ;(session as any)._lastKeystrokeTs = performance.now()
      }
      performanceTrace.recordInstant('terminal.input', {
        terminalId: id,
        includesEnter: data.includes('\r') || data.includes('\n'),
        ...performanceTrace.summarizeText('payload', data)
      }, 'terminal')
      this.activateInteractiveBoost(id)
      window.electronAPI.terminal.write(id, data)
    })

    // Note: onData and onExit IPC listeners are handled by a single global
    // listener in the manager (registerGlobalDataListener / registerGlobalExitListener)
    // to avoid O(N) per-message overhead.

    const session: TerminalSession = {
      id,
      terminal,
      fitAddon,
      searchAddon,
      status: 'idle',
      readyPromise: null,
      open: false,
      container: null,
      lastCols: DEFAULT_COLS,
      lastRows: DEFAULT_ROWS,
      lastFitWidth: 0,
      lastFitHeight: 0,
      renderer: new TerminalRendererLifecycle({
        terminalId: id,
        terminal,
        platform: window.electronAPI.platform
      }),
      lastOptions: options,
      pendingViewportRestore: null,
      pendingRestoreAnimationFrame: null,
      pendingGeometryRefreshAnimationFrame: null,
      visible: true,
      outputVisible: this.outputVisibilityState.get(id) ?? true,
      pendingData: [],
      pendingDataBytes: 0,
      interactiveBoostUntil: 0
    }

    this.sessions.set(id, session)
    this.outputScheduler.registerTarget({
      id,
      hasPendingData: () => session.pendingData.length > 0,
      isOutputActive: () => this.isOutputActive(session),
      isInteractive: () => this.shouldUseInteractiveBoost(session),
      consumeChunk: (maxBytes) => this.consumePendingDataChunk(session, maxBytes),
      writeData: (data) => this.writeTerminalData(session, data)
    })
    this.syncMainOutputVisibility(session)
    return session
  }

  private getCreateSize(session: TerminalSession) {
    if (session.open) {
      try {
        session.fitAddon.fit()
        const { cols, rows } = session.terminal
        if (cols > 0 && rows > 0) {
          session.lastCols = cols
          session.lastRows = rows
        }
      } catch (e) {
        // Ignore fit errors during transitions
      }
    }

    return { cols: session.lastCols || DEFAULT_COLS, rows: session.lastRows || DEFAULT_ROWS }
  }

  getSession(id: string): TerminalSession | undefined {
    return this.sessions.get(id)
  }

  /**
   * Paste text into a terminal through xterm.js's paste() mechanism.
   *
   * This is the correct way to send multi-line content because xterm.js
   * applies bracketed paste mode when the child program has enabled it
   * (e.g. Claude Code sends \x1b[?2004h). Within bracketed paste markers,
   * \r\n is safe — the child treats the block as pasted text rather than
   * interpreting each \r as Enter.
   */
  paste(id: string, data: string): boolean {
    const session = this.sessions.get(id)
    if (!session) return false
    session.terminal.paste(data)
    return true
  }

  isBracketedPasteEnabled(id: string): boolean | null {
    const session = this.sessions.get(id)
    if (!session) return null
    return session.terminal.modes.bracketedPasteMode
  }

  ensureSession(id: string, options: TerminalSessionOptions): TerminalSession {
    const existing = this.sessions.get(id)
    if (existing) {
      this.applyOptions(existing, options)
      return existing
    }

    return this.createSession(id, options)
  }

  updateOptions(id: string, options: TerminalSessionOptions): void {
    const session = this.sessions.get(id)
    if (!session) return
    this.applyOptions(session, options)
  }

  /**
   * Toggle visibility for a terminal session.
   *
   * When a terminal becomes hidden (e.g., user switches to another tab),
   * incoming PTY data is buffered instead of written to xterm.js, and GPU
   * renderer ownership is released through the renderer lifecycle.
   *
   * When it becomes visible again, buffered data is flushed to xterm.js
   * and renderer ownership is restored according to the platform policy.
   */
  setVisibility(id: string, visible: boolean): void {
    const session = this.sessions.get(id)
    if (!session || session.visible === visible) return

    session.visible = visible
    this.syncMainOutputVisibility(session)

    if (visible) {
      // A pending staggered disposal is obsolete the moment the terminal is
      // visible again — the addon was never torn down, so just drop the entry.
      this.staggeredDeactivateQueue.delete(id)
      // Flush buffered data that accumulated while hidden
      this.flushPendingData(session)
      this.outputScheduler.markDirty(id, this.shouldUseInteractiveBoost(session))
      if (session.open) {
        this.applyRendererLifecycle(session, 'visible')
        this.fit(id)
      }
    } else {
      if (session.open) {
        // Hidden-tab WebGL teardown is deferred to a one-per-frame pump:
        // back-to-back dispose of N contexts is the trigger window for the
        // Electron 39 ANGLE-Metal GPU-process crash (IOSurface release path)
        // observed on every tab switch with 6 panes. The terminal is hidden,
        // so nobody can see the one-frame-per-pane delay.
        this.queueStaggeredDeactivation(id)
      }
      this.outputScheduler.removeDirty(id)
    }
  }

  private queueStaggeredDeactivation(id: string): void {
    this.staggeredDeactivateQueue.add(id)
    perfTraceDiagnostic(PERF_TRACE_EVENT.RENDERER_XTERM_RENDERER_DEACTIVATE_STAGGERED, {
      queuedCount: this.staggeredDeactivateQueue.size
    })
    if (this.staggeredDeactivateTimerId !== null) return
    // setTimeout, NOT requestAnimationFrame: the pump must keep draining
    // when the window is occluded (rAF is fully paused there, which would
    // freeze the queue and leave hidden tabs holding WebGL indefinitely).
    // The interval only needs to break up back-to-back destruction — the
    // ANGLE-Metal crash trigger — not align with paint.
    const pump = () => {
      this.staggeredDeactivateTimerId = null
      const next = this.staggeredDeactivateQueue.values().next()
      if (next.done) return
      const nextId = next.value
      this.staggeredDeactivateQueue.delete(nextId)
      const session = this.sessions.get(nextId)
      // Re-validate at execution time: the session may have become visible
      // again, been disposed, or closed while queued.
      if (session && !session.visible && session.open && session.status !== 'disposed') {
        this.applyRendererLifecycle(session, 'hidden')
      }
      if (this.staggeredDeactivateQueue.size > 0) {
        this.staggeredDeactivateTimerId = window.setTimeout(pump, STAGGERED_DEACTIVATE_INTERVAL_MS)
      }
    }
    this.staggeredDeactivateTimerId = window.setTimeout(pump, STAGGERED_DEACTIVATE_INTERVAL_MS)
  }

  setOutputVisibility(id: string, visible: boolean): void {
    this.outputVisibilityState.set(id, visible)
    const session = this.sessions.get(id)
    if (!session) {
      window.electronAPI.terminal.setOutputVisibility(id, visible)
      if (!visible) {
        window.electronAPI.terminal.setBufferFastPath(id, false)
      }
      return
    }

    if (session.outputVisible === visible) {
      this.syncMainOutputVisibility(session)
      return
    }

    session.outputVisible = visible
    this.syncMainOutputVisibility(session)

    if (this.isOutputActive(session)) {
      this.outputScheduler.markDirty(id, this.shouldUseInteractiveBoost(session))
    } else {
      this.outputScheduler.removeDirty(id)
    }
  }

  private flushPendingData(session: TerminalSession): void {
    if (session.pendingData.length === 0) return

    const merged = this.consumePendingDataChunk(session, PENDING_DATA_MAX_BYTES)
    if (!merged) return

    this.writeTerminalData(session, merged)

    if (session.pendingData.length > 0) {
      this.flushPendingData(session)
    }
  }

  private trimPendingData(session: TerminalSession, maxBytes: number): void {
    while (session.pendingDataBytes > maxBytes && session.pendingData.length > 1) {
      const dropped = session.pendingData.shift()!
      session.pendingDataBytes -= dropped.length
    }

    if (session.pendingDataBytes <= maxBytes || session.pendingData.length === 0) return

    const retained = session.pendingData[0].slice(-maxBytes)
    session.pendingData[0] = retained
    session.pendingDataBytes = retained.length
  }

  private consumePendingDataChunk(session: TerminalSession, maxBytes: number): string | null {
    if (session.pendingData.length === 0) return null

    const chunks: string[] = []
    let chunkBytes = 0

    while (session.pendingData.length > 0 && chunkBytes < maxBytes) {
      const next = session.pendingData[0]
      const remaining = maxBytes - chunkBytes

      if (next.length <= remaining) {
        chunks.push(next)
        chunkBytes += next.length
        session.pendingData.shift()
        continue
      }

      if (remaining <= 0) break

      chunks.push(next.slice(0, remaining))
      session.pendingData[0] = next.slice(remaining)
      chunkBytes += remaining
      break
    }

    if (chunkBytes === 0) return null

    session.pendingDataBytes = Math.max(0, session.pendingDataBytes - chunkBytes)
    return chunks.length === 1 ? chunks[0] : chunks.join('')
  }

  private applyRendererLifecycle(
    session: TerminalSession,
    reason: TerminalRendererLifecycleReason
  ): void {
    if (!session.open || session.status === 'disposed') return

    if (session.visible) {
      session.renderer.activate(reason)
      return
    }

    session.renderer.deactivate(reason)
  }

  attach(id: string, container: HTMLDivElement, options: TerminalSessionOptions): void {
    const session = this.ensureSession(id, options)
    session.container = container

    if (!session.open) {
      session.terminal.open(container)
      session.open = true
      this.applyRendererLifecycle(session, 'attach')
    } else if (session.terminal.element && session.terminal.element.parentElement !== container) {
      this.captureViewportIntent(session, 'attach')
      while (container.firstChild) {
        container.removeChild(container.firstChild)
      }
      container.appendChild(session.terminal.element)
      this.applyRendererLifecycle(session, 'attach')
    }

    this.fit(id)
    this.schedulePendingViewportRestore(session, 'attach')
  }

  detach(id: string): void {
    const session = this.sessions.get(id)
    if (!session?.container || !session.terminal.element) return

    if (session.terminal.element.parentElement === session.container) {
      session.container.removeChild(session.terminal.element)
    }
    session.container = null
  }

  private syncPtySize(session: TerminalSession, force = false): void {
    const { cols, rows } = session.terminal
    if (cols <= 0 || rows <= 0) return

    const prevCols = session.lastCols
    const prevRows = session.lastRows
    session.lastCols = cols
    session.lastRows = rows

    if (session.status === 'ready' && (force || cols !== prevCols || rows !== prevRows)) {
      void window.electronAPI.terminal.resize(session.id, cols, rows).catch((error) => {
        console.warn('[TerminalSession] resize failed:', { id: session.id, error: String(error) })
      })
    }
  }

  fit(id: string): void {
    const session = this.sessions.get(id)
    if (!session || !session.open) return
    const container = session.container
    if (!container) return

    const width = container.clientWidth
    const height = container.clientHeight
    if (width <= 0 || height <= 0) return
    if (width === session.lastFitWidth && height === session.lastFitHeight) {
      this.schedulePendingViewportRestore(session, 'fit')
      return
    }
    this.captureViewportIntent(session, 'fit')
    session.lastFitWidth = width
    session.lastFitHeight = height

    try {
      session.fitAddon.fit()
      this.syncPtySize(session)
    } catch (e) {
      // Ignore fit errors during transitions
    }

    this.schedulePendingViewportRestore(session, 'fit')
  }

  forceFit(id: string): boolean {
    const session = this.sessions.get(id)
    if (!session?.open) return false
    session.lastFitWidth = 0
    session.lastFitHeight = 0
    this.fit(id)
    return true
  }

  remount(id: string): boolean {
    const session = this.sessions.get(id)
    if (!session?.open || !session.container || !session.lastOptions) return false

    const container = session.container
    const options = session.lastOptions
    this.detach(id)
    this.attach(id, container, options)
    return true
  }

  notifyHostSurfaceEvent(reason: TerminalRendererSurfaceEvent): void {
    this.scheduleVisibleRendererSurfaceRestore(reason)
  }

  /**
   * Document went hidden (window occluded / Space switched away). Peer-aligned
   * contract (VS Code, native GPU terminals): KEEP every visible pane's WebGL
   * context alive — rendering pauses via Chromium's background rAF throttling,
   * and genuine GPU reclamation surfaces as webglcontextlost, handled by the
   * context-loss fallback. Tearing contexts down here was the root of the
   * "all terminals white for 1-3s after Space switch-back" regression: the
   * switch-back had to recreate N contexts and re-rasterize the shared glyph
   * atlas before the compositor had any frame to show.
   */
  /**
   * GPU-process crash recovery. Chromium does not deliver webglcontextlost
   * on the Electron 39 ANGLE-Metal crash path, so the per-terminal loss
   * fallback never fires — force-recreate every visible pane's WebGL
   * against the respawned GPU process instead of recovering by luck.
   */
  recoverRendererSurfacesAfterGpuCrash(info: { reason: string; simulated?: boolean }): number {
    let sessionCount = 0
    let recreatedCount = 0
    let failedCount = 0
    for (const session of this.sessions.values()) {
      if (!session.visible || !session.open || session.status === 'disposed') continue
      sessionCount += 1
      try {
        const result = session.renderer.forceRecreateWebgl('gpu-process-gone')
        if (result.webglActive) recreatedCount += 1
        else failedCount += 1
        this.forceFit(session.id)
      } catch (error) {
        failedCount += 1
        console.warn('[GpuCrashRecovery] recreate threw', session.id, error)
      }
    }
    perfTraceDiagnostic(PERF_TRACE_EVENT.RENDERER_XTERM_RENDERER_GPU_CRASH_RECOVERY, {
      sessionCount,
      recreatedCount,
      failedCount,
      reason: info.reason,
      simulated: Boolean(info.simulated)
    })
    return recreatedCount
  }

  noteDocumentHiddenKeepAlive(): { webglSessions: number; visibleSessions: number } {
    let webglSessions = 0
    let visibleSessions = 0
    for (const session of this.sessions.values()) {
      if (!session.visible || !session.open || session.status === 'disposed') continue
      visibleSessions += 1
      if (session.renderer.isWebglActive()) webglSessions += 1
    }
    perfTraceDiagnostic(PERF_TRACE_EVENT.RENDERER_XTERM_RENDERER_DOCUMENT_HIDDEN_KEEPALIVE, {
      webglSessions,
      visibleSessions
    })
    return { webglSessions, visibleSessions }
  }

  scheduleVisibleRendererSurfaceRestore(reason: TerminalRendererSurfaceEvent): void {
    if (this.surfaceRestoreTimeoutId !== null) {
      window.clearTimeout(this.surfaceRestoreTimeoutId)
    }
    this.surfaceRestoreTimeoutId = window.setTimeout(() => {
      this.surfaceRestoreTimeoutId = null
      this.restoreVisibleRendererSurfaces(reason)
    }, this.rendererPolicy.surfaceResumeDebounceMs)
  }

  restoreVisibleRendererSurfaces(reason: TerminalRendererSurfaceEvent): number {
    const startedAt = performance.now()
    const restoredSessionIds: string[] = []
    let refreshedCount = 0
    let recreatedCount = 0
    let deferredCount = 0

    for (const session of this.sessions.values()) {
      if (!this.canRestoreRendererSurface(session)) continue
      const result = this.restoreRendererSurface(session, reason, true)
      if (result.action === 'refresh-only') refreshedCount += 1
      else if (result.action === 'recreate-webgl') recreatedCount += 1
      else deferredCount += 1
      restoredSessionIds.push(session.id)
    }

    this.schedulePostFrameSurfaceRestore(restoredSessionIds, reason)

    this.rendererRecoveryCount += restoredSessionIds.length
    perfTraceDiagnostic(PERF_TRACE_EVENT.RENDERER_XTERM_RENDERER_SURFACE_RESTORE_BATCH, {
      reason,
      sessionCount: restoredSessionIds.length,
      refreshedCount,
      recreatedCount,
      deferredCount,
      durationMs: +(performance.now() - startedAt).toFixed(1)
    })
    return restoredSessionIds.length
  }

  private canRestoreRendererSurface(session: TerminalSession): boolean {
    if (!session.visible || !session.open || session.status === 'disposed') return false
    const container = session.container
    if (!container || !container.isConnected) return false
    const style = window.getComputedStyle(container)
    if (style.display === 'none' || style.visibility === 'hidden') return false
    return container.clientWidth > 0 && container.clientHeight > 0
  }

  private schedulePostFrameSurfaceRestore(
    sessionIds: string[],
    reason: TerminalRendererSurfaceEvent
  ): void {
    if (sessionIds.length === 0 || this.rendererPolicy.postResumeFrameCount <= 0) return

    if (this.surfaceRestoreAnimationFrameId !== null) {
      cancelAnimationFrame(this.surfaceRestoreAnimationFrameId)
    }

    let remainingFrames = this.rendererPolicy.postResumeFrameCount
    const run = () => {
      this.surfaceRestoreAnimationFrameId = null
      for (const sessionId of sessionIds) {
        const session = this.sessions.get(sessionId)
        if (!session || !this.canRestoreRendererSurface(session)) continue
        this.restoreRendererSurface(session, reason, false)
      }

      remainingFrames -= 1
      if (remainingFrames > 0) {
        this.surfaceRestoreAnimationFrameId = requestAnimationFrame(run)
      }
    }

    this.surfaceRestoreAnimationFrameId = requestAnimationFrame(run)
  }

  private restoreRendererSurface(
    session: TerminalSession,
    reason: TerminalRendererSurfaceEvent,
    forceGeometry: boolean
  ): TerminalRendererLifecycleResult {
    const result = session.renderer.restoreSurface(reason)
    if (forceGeometry) {
      this.forceFit(session.id)
      return result
    }
    this.fit(session.id)
    return result
  }

  private getTextareaElementForSession(session: TerminalSession): HTMLTextAreaElement | null {
    if (!session.container) return null
    return session.container.querySelector('.xterm-helper-textarea') as HTMLTextAreaElement | null
  }

  getTextareaElement(id: string): HTMLTextAreaElement | null {
    const session = this.sessions.get(id)
    if (!session) return null
    return this.getTextareaElementForSession(session)
  }

  isFocused(id: string): boolean {
    const textarea = this.getTextareaElement(id)
    return textarea !== null && document.activeElement === textarea
  }

  getFocusedTerminalId(): string | null {
    for (const [id] of this.sessions) {
      if (this.isFocused(id)) {
        return id
      }
    }
    return null
  }

  getFocusDebugSnapshot(id: string): TerminalFocusSessionDebugSnapshot {
    const session = this.sessions.get(id)
    if (!session) {
      return {
        exists: false,
        open: null,
        status: null,
        visible: null,
        hasContainer: false,
        containerConnected: false,
        containerWidth: null,
        containerHeight: null,
        containerDisplay: null,
        hasTextarea: false,
        textareaConnected: false,
        textareaDisabled: null,
        textareaTabIndex: null,
        textareaDisplay: null,
        terminalElementConnected: false,
        activeElementMatchesTextarea: false
      }
    }

    const container = session.container
    const textarea = this.getTextareaElementForSession(session)
    const terminalElement = session.terminal.element

    return {
      exists: true,
      open: session.open,
      status: session.status,
      visible: session.visible,
      hasContainer: container !== null,
      containerConnected: container?.isConnected ?? false,
      containerWidth: container?.clientWidth ?? null,
      containerHeight: container?.clientHeight ?? null,
      containerDisplay: container ? window.getComputedStyle(container).display : null,
      hasTextarea: textarea !== null,
      textareaConnected: textarea?.isConnected ?? false,
      textareaDisabled: textarea?.disabled ?? null,
      textareaTabIndex: textarea?.tabIndex ?? null,
      textareaDisplay: textarea ? window.getComputedStyle(textarea).display : null,
      terminalElementConnected: terminalElement?.isConnected ?? false,
      activeElementMatchesTextarea: textarea !== null && document.activeElement === textarea
    }
  }

  focus(id: string): boolean {
    const session = this.sessions.get(id)
    if (!session?.open) return false
    this.activeInteractiveTerminalId = id

    const textarea = this.getTextareaElementForSession(session)
    if (textarea) {
      // preventScroll is critical: the xterm helper-textarea lives at
      // `left:-9999em; top:0`, so a plain focus() triggers the browser's
      // automatic scrollIntoView, which walks up through every
      // overflow:auto|scroll ancestor (.xterm-viewport is one of them) and
      // snaps its scrollTop to 0 — causing the terminal to "jump to the top
      // of where this Task started". See xterm.js issue #1981.
      textarea.focus({ preventScroll: true })
      if (document.activeElement === textarea) {
        return true
      }
    }

    // xterm's own Terminal.focus() already uses { preventScroll: true }
    // internally (CoreBrowserTerminal.ts), so this fallback is safe.
    session.terminal.focus()

    const focusedTextarea = this.getTextareaElementForSession(session)
    return focusedTextarea !== null && document.activeElement === focusedTextarea
  }

  focusIfNeeded(id: string): boolean {
    if (this.isFocused(id)) {
      return true
    }
    return this.focus(id)
  }

  async ensureReady(id: string, options: TerminalSessionOptions): Promise<void> {
    const session = this.ensureSession(id, options)

    if (session.status === 'ready') return
    if (session.status === 'disposed') return
    if (session.readyPromise) return session.readyPromise

    session.status = 'initializing'

    session.readyPromise = (async () => {
      const { cols, rows } = this.getCreateSize(session)
      const createOptions: { cols: number; rows: number; cwd?: string } = { cols, rows }
      const autotestCwd = window.electronAPI.debug?.autotest
        ? window.electronAPI.debug.autotestCwd?.trim()
        : null
      if (autotestCwd) createOptions.cwd = autotestCwd
      const result = await window.electronAPI.terminal.create(id, createOptions)

      if (session.status === 'disposed') {
        window.electronAPI.terminal.dispose(id)
        return
      }

      if (!result?.success) {
        session.status = 'error'
        throw new Error(result?.error || 'Failed to create terminal')
      }

      session.status = 'ready'
      this.syncPtySize(session, true)
    })()

    session.readyPromise.catch(() => {
      if (session.status !== 'disposed') {
        session.readyPromise = null
      }
    })

    return session.readyPromise
  }

  private restartShell(id: string): void {
    const session = this.sessions.get(id)
    if (!session || !session.lastOptions) return

    this.clearPendingRestoreAnimationFrame(session)
    session.pendingViewportRestore = null
    session.terminal.clear()
    session.terminal.reset()

    void this.ensureReady(id, session.lastOptions)
  }

  dispose(id: string): void {
    const session = this.sessions.get(id)
    if (!session) return

    session.status = 'disposed'
    session.readyPromise = null
    session.pendingData = []
    session.pendingDataBytes = 0
    this.outputScheduler.unregisterTarget(id)
    this.outputVisibilityState.delete(id)
    this.staggeredDeactivateQueue.delete(id)
    this.clearPendingRestoreAnimationFrame(session)
    this.clearPendingGeometryRefreshAnimationFrame(session)
    if (this.sessions.size === 1) {
      if (this.surfaceRestoreTimeoutId !== null) {
        window.clearTimeout(this.surfaceRestoreTimeoutId)
        this.surfaceRestoreTimeoutId = null
      }
      if (this.surfaceRestoreAnimationFrameId !== null) {
        cancelAnimationFrame(this.surfaceRestoreAnimationFrameId)
        this.surfaceRestoreAnimationFrameId = null
      }
    }

    // Data/exit IPC listeners are global; no per-session cleanup needed
    window.electronAPI.terminal.dispose(id)
    session.renderer.dispose()
    session.terminal.dispose()

    if (this.activeInteractiveTerminalId === id) {
      this.activeInteractiveTerminalId = null
    }
    this.sessions.delete(id)
  }

  private writeTerminalData(session: TerminalSession, data: string): void {
    // Just hand the bytes to xterm. xterm's native isUserScrolling handles
    // auto-follow: if the user is at the bottom we stay at the bottom; if they
    // scrolled up we keep their position. No programmatic scroll on output.
    const t0 = performance.now()
    const traceStartUs = performanceTrace.nowUs()
    const flowId = performanceTrace.getActiveTerminalFlow(session.id)
    session.terminal.write(data)
    const durationMs = performance.now() - t0
    perfMonitor.recordXtermWrite(durationMs)
    perfTraceTask(PERF_TRACE_EVENT.RENDERER_TERMINAL_DATA_XTERM_WRITE, {
      bytes: data.length,
      durationMs: +durationMs.toFixed(2)
    }, session.id)
    performanceTrace.recordComplete('terminal.render.flush', traceStartUs, {
      terminalId: session.id,
      visible: session.visible,
      bytes: data.length,
      pendingBytes: session.pendingDataBytes,
      xtermDurationMs: +durationMs.toFixed(3),
      flowId: flowId ?? undefined
    }, 'terminal')
    if (flowId) {
      performanceTrace.recordFlowEnd('terminal.render.flush', flowId, {
        terminalId: session.id,
        bytes: data.length,
        xtermDurationMs: +durationMs.toFixed(3)
      }, 'terminal')
    }
  }

  private activateInteractiveBoost(id: string): void {
    const session = this.sessions.get(id)
    if (!session) return
    session.interactiveBoostUntil = performance.now() + INTERACTIVE_BOOST_WINDOW_MS
    this.activeInteractiveTerminalId = id
    inputPriorityLane.noteFocusedTaskInput(80)
    this.outputScheduler.markDirty(id, true)
    window.electronAPI.terminal.notifyInteractiveInput(id)
  }

  private shouldUseInteractiveBoost(session: TerminalSession): boolean {
    return (
      this.isOutputActive(session) &&
      this.activeInteractiveTerminalId === session.id &&
      performance.now() < session.interactiveBoostUntil
    )
  }
}

export const terminalSessionManager = new TerminalSessionManager()

// GPU-process crash recovery subscription. Deliberately NOT a module-scope
// side effect (a top-level electronAPI access here changed bundle
// initialization order and destabilized the whole TFA suite) — the first
// mounted TerminalGrid calls this from an effect; the guard makes it
// idempotent across tabs and remounts. Chromium never delivers
// webglcontextlost on the Electron 39 ANGLE-Metal Space-switch crash, so
// the main process watches child-process-gone and this listener
// force-recreates every visible pane's WebGL against the respawned GPU
// process.
let gpuCrashRecoverySubscribed = false
export function ensureGpuCrashRecoverySubscription(): void {
  if (gpuCrashRecoverySubscribed) return
  gpuCrashRecoverySubscribed = true
  window.electronAPI?.system?.onGpuProcessGone?.((info) => {
    terminalSessionManager.recoverRendererSurfacesAfterGpuCrash(info)
  })
}

// Visibility-watchdog recovery subscription (same idempotent pattern as the
// GPU one above). The main process pushes this after detecting "window
// visible but renderer stuck hidden" and applying an occlusion nudge —
// Chromium's own visibilitychange never fired on that path (2026-07-20
// incident: visibilityState stayed 'hidden' for 10 h with the window
// frontmost), so surfaces are resumed as if `visibilitychange -> visible`
// had been delivered.
let visibilityRecoverySubscribed = false
export function ensureVisibilityRecoverySubscription(): void {
  if (visibilityRecoverySubscribed) return
  visibilityRecoverySubscribed = true
  window.electronAPI?.system?.onVisibilityRecoveryPush?.((info) => {
    perfTraceDiagnostic(PERF_TRACE_EVENT.RENDERER_VISIBILITY_RECOVERY_PUSH_RECEIVED, {
      nudge: info?.nudge ?? 'unknown',
      visibilityState: document.visibilityState
    })
    terminalSessionManager.notifyHostSurfaceEvent('document-visible')
  })
}

// Expose for E2E testing via CDP (Chrome DevTools Protocol)
;(window as any).__terminalSessionManager = terminalSessionManager

// Repro hooks for the "blank Task after desktop swipe" autotest. These mutate
// live terminal state (clear the WebGL canvas, force GPU context loss /
// restore), so they're gated behind autotest mode — exposing them in normal
// app runs would let any renderer script blank a user's terminal.
if (window.electronAPI?.debug?.autotest) {
  ;(window as any).__blankTaskRepro = {
    triggerWebglLoss: (id?: string) => terminalSessionManager.triggerRealWebglContextLossForRepro(id),
    forceWebglRestore: (id?: string) => terminalSessionManager.forceWebglContextRestoreForRepro(id),
    phantomBlank: (id?: string) => terminalSessionManager.simulatePhantomBlankForRepro(id),
    runVisibilityRoundtrip: async () => {
      document.dispatchEvent(new Event('visibilitychange'))
      window.dispatchEvent(new Event('blur'))
      await new Promise((resolve) => setTimeout(resolve, 200))
      window.dispatchEvent(new Event('focus'))
      document.dispatchEvent(new Event('visibilitychange'))
      return { dispatched: true }
    },
    getFocusedTerminalId: () => terminalSessionManager.getFocusedTerminalId(),
    getSessionDebugState: (id?: string) => {
      const tid = id ?? terminalSessionManager.getFocusedTerminalId()
      return tid ? terminalSessionManager.getSessionDebugState(tid) : null
    }
  }
}
