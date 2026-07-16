/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Terminal as XTerm } from '@xterm/xterm'
import { WebglAddon } from '@xterm/addon-webgl'
import { perfMonitor } from '../utils/perf-monitor'
import { perfTraceDiagnostic } from '../utils/perf-trace'
import { PERF_TRACE_EVENT } from '../utils/perf-trace-names'
import { decideSurfaceRestoreAction, type SurfaceRestoreAction } from './terminal-renderer-surface-policy'

export type RuntimePlatform = 'darwin' | 'win32' | 'linux'

export type TerminalRendererMode = 'webgl' | 'fallback'

export type TerminalRendererSurfaceEvent =
  | 'window-focus'
  | 'document-visible'
  | 'page-show'
  | 'manual-debug'
  | 'webgl-context-loss'

export type TerminalRendererLifecycleReason =
  | 'attach'
  | 'visible'
  | 'hidden'
  | 'document-hidden'
  | 'dispose'
  | 'gpu-process-gone'
  | TerminalRendererSurfaceEvent

export interface TerminalRendererPolicy {
  platform: RuntimePlatform
  surfaceResumeDebounceMs: number
  postResumeFrameCount: number
  webglFailureFallbackThreshold: number
  webglFallbackCooldownMs: number
}

export interface TerminalRendererLifecycleSnapshot {
  mode: TerminalRendererMode
  webglActive: boolean
  webglAvailable: boolean
  webglFailureCount: number
  webglDisabledUntil: number | null
  contextLost: boolean
  hasContextListeners: boolean
  lastLifecycleReason: TerminalRendererLifecycleReason | null
  lastLifecycleAt: number | null
  lastSurfaceEvent: TerminalRendererSurfaceEvent | null
  lastSurfaceEventAt: number | null
}

export interface TerminalRendererLifecycleResult {
  mode: TerminalRendererMode
  webglActive: boolean
  attemptedWebgl: boolean
  changedRenderer: boolean
  /** Set by restoreSurface(): which decision-table branch this restore took. */
  action?: SurfaceRestoreAction
}

export interface TerminalRendererLifecycleOptions {
  terminalId: string
  terminal: XTerm
  platform: RuntimePlatform
}

// Match VS Code's terminal renderer stance: once xterm's WebGL addon reports
// that a lost context did not recover, dispose the WebGL addon and let xterm's
// DOM renderer keep the live buffer visible. The short cooldown prevents our
// focus/visibility surface-restore pipeline from immediately recreating WebGL
// while the host GPU surface is still unstable.
export function createTerminalRendererPolicy(platform: RuntimePlatform): TerminalRendererPolicy {
  if (platform === 'darwin') {
    return {
      platform,
      surfaceResumeDebounceMs: 80,
      postResumeFrameCount: 1,
      webglFailureFallbackThreshold: 3,
      webglFallbackCooldownMs: 5000
    }
  }

  return {
    platform,
    surfaceResumeDebounceMs: 120,
    postResumeFrameCount: 1,
    webglFailureFallbackThreshold: 3,
    webglFallbackCooldownMs: 5000
  }
}

export class TerminalRendererLifecycle {
  private readonly terminalId: string
  private readonly terminal: XTerm
  private readonly policy: TerminalRendererPolicy
  private webglAddon: WebglAddon | null = null
  private webglFailureCount = 0
  private webglDisabledUntil: number | null = null
  private lastLifecycleReason: TerminalRendererLifecycleReason | null = null
  private lastLifecycleAt: number | null = null
  private lastSurfaceEvent: TerminalRendererSurfaceEvent | null = null
  private lastSurfaceEventAt: number | null = null

  // Canvas-level state. This follows the VS Code/xterm.js guidance: let
  // xterm's WebGL addon decide that the lost context did not recover, then
  // dispose the addon and render through xterm's DOM fallback after macOS
  // Spaces, sleep/resume, or GPU resource pressure.
  private observedCanvas: HTMLCanvasElement | null = null
  private contextLost = false
  private webglContextLossDisposable: { dispose(): void } | null = null

  constructor(options: TerminalRendererLifecycleOptions) {
    this.terminalId = options.terminalId
    this.terminal = options.terminal
    this.policy = createTerminalRendererPolicy(options.platform)
  }

  getPolicy(): TerminalRendererPolicy {
    return this.policy
  }

  getSnapshot(): TerminalRendererLifecycleSnapshot {
    return {
      mode: this.getMode(),
      webglActive: this.isWebglActive(),
      webglAvailable: !this.isWebglCooldownActive(performance.now()),
      webglFailureCount: this.webglFailureCount,
      webglDisabledUntil: this.webglDisabledUntil,
      contextLost: this.contextLost,
      hasContextListeners: this.webglContextLossDisposable !== null,
      lastLifecycleReason: this.lastLifecycleReason,
      lastLifecycleAt: this.lastLifecycleAt,
      lastSurfaceEvent: this.lastSurfaceEvent,
      lastSurfaceEventAt: this.lastSurfaceEventAt
    }
  }

  getMode(): TerminalRendererMode {
    return this.webglAddon ? 'webgl' : 'fallback'
  }

  isWebglActive(): boolean {
    return this.webglAddon !== null
  }

  /**
   * Returns the canvas this lifecycle is currently observing for context
   * loss events, or null if no listeners are attached. Exposed so the
   * autotest repro layer can reach the same canvas reference we hold before
   * WebGL fallback disposes it.
   */
  getObservedCanvas(): HTMLCanvasElement | null {
    return this.observedCanvas ?? this.findWebglCanvas()
  }

  activate(reason: TerminalRendererLifecycleReason): TerminalRendererLifecycleResult {
    this.markLifecycle(reason)
    return this.ensureWebgl(reason)
  }

  deactivate(reason: TerminalRendererLifecycleReason): TerminalRendererLifecycleResult {
    this.markLifecycle(reason)
    const changedRenderer = this.disposeWebgl(reason)
    return this.buildResult(false, changedRenderer)
  }

  restoreSurface(reason: TerminalRendererSurfaceEvent): TerminalRendererLifecycleResult {
    this.markLifecycle(reason)
    this.lastSurfaceEvent = reason
    this.lastSurfaceEventAt = Date.now()

    this.clearExpiredWebglCooldown()
    const action = decideSurfaceRestoreAction({
      webglActive: this.webglAddon !== null,
      contextLost: this.contextLost,
      cooldownActive: this.isWebglCooldownActive(performance.now())
    })

    switch (action) {
      case 'refresh-only': {
        // The addon survived the host surface event with its GL context and
        // the shared glyph atlas intact. Re-issuing draw calls recommits the
        // compositor tile; the repaint can't wait for the next PTY write or
        // resize, so force a viewport refresh. Deliberately NO
        // clearTextureAtlas here: the atlas is shared across all
        // config-identical terminals, and clearing it per-terminal per
        // restore batch is the O(N^2) rebuild storm behind the
        // "all terminals white after Space switch-back" regression.
        this.refreshTerminalIfActive()
        perfTraceDiagnostic(PERF_TRACE_EVENT.RENDERER_XTERM_RENDERER_REFRESH_AFTER_RESTORE, {
          terminalId: this.terminalId,
          reason,
          action
        })
        return { ...this.buildResult(false, false), action }
      }
      case 'defer-context-lost':
      case 'defer-cooldown': {
        perfTraceDiagnostic(PERF_TRACE_EVENT.RENDERER_XTERM_RENDERER_RESTORE_DEFERRED, {
          terminalId: this.terminalId,
          reason,
          action,
          webglFailureCount: this.webglFailureCount,
          webglDisabledUntil: this.webglDisabledUntil
        })
        return { ...this.buildResult(false, false), action }
      }
      case 'recreate-webgl': {
        // Addon was previously disposed (context-loss fallback whose cooldown
        // expired, or never attached). After creating a new one, xterm's
        // render service won't repaint until the next PTY write or resize
        // fires — force a viewport refresh so the recovered surface shows the
        // live buffer instead of the empty canvas from initial allocation.
        const result = this.ensureWebgl(reason)
        this.refreshTerminalIfActive()
        perfTraceDiagnostic(PERF_TRACE_EVENT.RENDERER_XTERM_RENDERER_REFRESH_AFTER_RESTORE, {
          terminalId: this.terminalId,
          reason,
          action,
          webglActive: result.webglActive
        })
        return { ...result, action }
      }
    }
  }

  /**
   * GPU-process crash recovery: the old context is dead even though
   * Chromium never delivered `webglcontextlost` on this crash path, so the
   * normal loss fallback never ran. Drop the dead addon unconditionally,
   * clear loss/cooldown bookkeeping (the crash was not a WebGL failure of
   * ours), and attach a fresh addon against the respawned GPU process.
   */
  forceRecreateWebgl(reason: TerminalRendererLifecycleReason): TerminalRendererLifecycleResult {
    this.markLifecycle(reason)
    this.detachContextListeners()
    this.disposeWebgl(reason)
    this.contextLost = false
    this.webglFailureCount = 0
    this.webglDisabledUntil = null
    const result = this.ensureWebgl(reason)
    this.refreshTerminalIfActive()
    return result
  }

  dispose(): void {
    this.markLifecycle('dispose')
    this.detachContextListeners()
    this.disposeWebgl('dispose')
  }

  private ensureWebgl(reason: TerminalRendererLifecycleReason): TerminalRendererLifecycleResult {
    if (this.webglAddon) {
      return this.buildResult(false, false)
    }

    // If we know the GL context is currently lost, do not hand a brand-new
    // WebglAddon a dead context. The xterm onContextLoss path normally flips
    // to the DOM renderer; this guard covers re-entrant restore attempts that
    // race while that transition is in progress.
    if (this.canvasContextIsLost()) {
      perfTraceDiagnostic(PERF_TRACE_EVENT.RENDERER_XTERM_RENDERER_RESTORE_DEFERRED, {
        terminalId: this.terminalId,
        reason,
        contextLost: true
      })
      return this.buildResult(false, false)
    }

    this.clearExpiredWebglCooldown()
    if (this.isWebglSuppressed()) {
      perfTraceDiagnostic(PERF_TRACE_EVENT.RENDERER_XTERM_RENDERER_RESTORE_DEFERRED, {
        terminalId: this.terminalId,
        reason,
        suppressedByCooldown: true,
        webglFailureCount: this.webglFailureCount,
        webglDisabledUntil: this.webglDisabledUntil
      })
      return this.buildResult(false, false)
    }

    try {
      const preserveDrawingBuffer = this.shouldPreserveDrawingBuffer()
      const webglAddon = new WebglAddon(preserveDrawingBuffer)
      this.terminal.loadAddon(webglAddon)
      this.webglAddon = webglAddon
      perfMonitor.incrementWebglContextCount()
      this.webglFailureCount = 0
      this.webglDisabledUntil = null
      this.contextLost = false
      this.attachContextListeners()
      perfTraceDiagnostic(PERF_TRACE_EVENT.RENDERER_XTERM_RENDERER_ENSURE_WEBGL, {
        terminalId: this.terminalId,
        reason,
        ok: true,
        listenersAttached: this.webglContextLossDisposable !== null
      })
      return this.buildResult(true, true)
    } catch (error) {
      perfTraceDiagnostic(PERF_TRACE_EVENT.RENDERER_XTERM_RENDERER_ENSURE_WEBGL, {
        terminalId: this.terminalId,
        reason,
        ok: false,
        error: String(error)
      })
      this.registerWebglFailure(reason, error)
      return this.buildResult(true, false)
    }
  }

  private disposeWebgl(reason: TerminalRendererLifecycleReason): boolean {
    const webglAddon = this.webglAddon
    if (!webglAddon) return false

    this.detachContextListeners()
    this.webglAddon = null
    let disposeError: unknown = null
    try {
      webglAddon.dispose()
    } catch (error) {
      disposeError = error
      // xterm.js may already have moved to its internal fallback after context
      // loss; double-disposing is benign.
    }
    perfMonitor.decrementWebglContextCount()
    perfTraceDiagnostic(PERF_TRACE_EVENT.RENDERER_XTERM_RENDERER_DISPOSE_WEBGL, {
      terminalId: this.terminalId,
      reason,
      disposeError: disposeError ? String(disposeError) : null
    })
    return true
  }

  private registerWebglFailure(reason: TerminalRendererLifecycleReason, error?: unknown): void {
    this.webglFailureCount += 1
    const reachedThreshold = this.webglFailureCount >= this.policy.webglFailureFallbackThreshold

    perfTraceDiagnostic(PERF_TRACE_EVENT.RENDERER_XTERM_RENDERER_FAILURE, {
      terminalId: this.terminalId,
      reason,
      webglFailureCount: this.webglFailureCount,
      threshold: this.policy.webglFailureFallbackThreshold,
      cooldownActivated: reachedThreshold,
      cooldownMs: this.policy.webglFallbackCooldownMs,
      error: error ? String(error) : null
    })

    if (!reachedThreshold) {
      return
    }

    this.webglDisabledUntil = performance.now() + this.policy.webglFallbackCooldownMs
  }

  // ─────────── Canvas-level WebGL context lifecycle ───────────

  private attachContextListeners(): void {
    const webglAddon = this.webglAddon
    if (!webglAddon) return
    const canvas = this.findWebglCanvas()
    if (this.observedCanvas === canvas && this.webglContextLossDisposable) return

    this.detachContextListeners()
    this.observedCanvas = canvas

    this.webglContextLossDisposable = webglAddon.onContextLoss(() => {
      this.contextLost = true
      perfTraceDiagnostic(PERF_TRACE_EVENT.RENDERER_XTERM_RENDERER_CONTEXT_LOST, {
        terminalId: this.terminalId,
        webglFailureCountBefore: this.webglFailureCount
      })
      this.fallbackAfterContextLoss('xterm-on-context-loss')
    })
  }

  private fallbackAfterContextLoss(trigger: string): boolean {
    if (!this.contextLost) return false

    this.contextLost = false
    this.webglFailureCount = Math.max(this.webglFailureCount, this.policy.webglFailureFallbackThreshold)
    this.webglDisabledUntil = performance.now() + this.policy.webglFallbackCooldownMs
    this.detachContextListeners()
    const changedRenderer = this.disposeWebgl('webgl-context-loss')
    this.refreshTerminalIfActive()
    perfTraceDiagnostic(PERF_TRACE_EVENT.RENDERER_XTERM_RENDERER_CONTEXT_LOSS_FALLBACK, {
      terminalId: this.terminalId,
      trigger,
      changedRenderer,
      cooldownMs: this.policy.webglFallbackCooldownMs
    })
    return changedRenderer
  }

  private detachContextListeners(): void {
    this.webglContextLossDisposable?.dispose()
    this.webglContextLossDisposable = null
    this.observedCanvas = null
  }

  private findWebglCanvas(): HTMLCanvasElement | null {
    const root = this.terminal.element
    if (!root) return null
    const canvases = root.querySelectorAll<HTMLCanvasElement>('.xterm-screen canvas')
    for (const canvas of Array.from(canvases)) {
      const gl = canvas.getContext('webgl2') ?? canvas.getContext('webgl')
      if (gl) return canvas
    }
    return null
  }

  private canvasContextIsLost(): boolean {
    // Trust the lifecycle's own `contextLost` flag, which is set in our
    // `webglcontextlost` listener and cleared once we have switched to DOM
    // rendering. Querying `observedCanvas.getContext(...).isContextLost()` is
    // unreliable across xterm WebglAddon's `dispose()` path because the addon
    // may release GPU resources via WEBGL_lose_context internally, leaving a
    // detached canvas's GL context permanently lost even though the live
    // terminal renderer is healthy.
    return this.contextLost
  }

  private refreshTerminalIfActive(): void {
    const rows = this.terminal.rows
    if (!Number.isFinite(rows) || rows <= 0) return
    try {
      this.terminal.refresh(0, rows - 1)
    } catch {
      // Refreshing right after a surface event can race with xterm's own
      // re-attach; the next data write or fit will redraw, so swallowing is
      // safe here.
    }
  }

  private shouldPreserveDrawingBuffer(): boolean {
    const debug = window.electronAPI?.debug
    if (!debug?.autotest) return false
    // preserveDrawingBuffer is only enabled for autotest suites that probe
    // the WebGL framebuffer via `gl.readPixels`. Perf, latency, and stress
    // suites measure frame timing and should use production-default
    // context options to avoid measurement skew.
    const suite = (debug.autotestSuite ?? '').toLowerCase()
    const pixelProbingSuites = new Set([
      'terminal-blank-task-repro',
      'terminal-focus-activation',
      'render-corruption-stress'
    ])
    return suite.split(',').some((part) => pixelProbingSuites.has(part.trim()))
  }

  private isWebglSuppressed(): boolean {
    return this.isWebglCooldownActive(performance.now())
  }

  private isWebglCooldownActive(now: number): boolean {
    return this.webglDisabledUntil !== null && now < this.webglDisabledUntil
  }

  private clearExpiredWebglCooldown(): void {
    if (this.webglDisabledUntil === null || performance.now() < this.webglDisabledUntil) {
      return
    }

    this.webglDisabledUntil = null
    this.webglFailureCount = 0
  }

  private markLifecycle(reason: TerminalRendererLifecycleReason): void {
    this.lastLifecycleReason = reason
    this.lastLifecycleAt = Date.now()
  }

  private buildResult(
    attemptedWebgl: boolean,
    changedRenderer: boolean
  ): TerminalRendererLifecycleResult {
    return {
      mode: this.getMode(),
      webglActive: this.isWebglActive(),
      attemptedWebgl,
      changedRenderer
    }
  }
}
