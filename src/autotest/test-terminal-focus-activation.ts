/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

import type { AutotestContext, TestResult } from './types'

const POINTER_SUPPRESS_SETTLE_MS = 180
const POINTER_STALE_WAIT_MS = 520
const SURFACE_IDLE_TIMEOUT_MS = 2200
const SURFACE_IDLE_SAMPLE_MS = 160
const SURFACE_IDLE_STABLE_SAMPLE_COUNT = 4
const SURFACE_LOSS_TIMEOUT_MS = 1000
const SURFACE_RESTORE_TIMEOUT_MS = 1500
const CONTEXT_LOSS_FALLBACK_TIMEOUT_MS = 12000

type WebglContext = WebGLRenderingContext | WebGL2RenderingContext

interface WebglSurfaceProbe {
  canvas: HTMLCanvasElement
  gl: WebglContext
}

interface WebglPixelStats {
  width: number
  height: number
  sampledPixels: number
  nonZeroPixels: number
  alphaPixels: number
  maxChannel: number
  checksum: number
  nonZeroRatio: number
  intensityMean: number
  intensityVariance: number
}

const escapeCssIdent = (value: string) => {
  const css = window.CSS as (typeof window.CSS & { escape?: (value: string) => string }) | undefined
  return css?.escape ? css.escape(value) : value.replace(/["\\]/g, '\\$&')
}

const nextFrame = () => new Promise<void>((resolve) => {
  window.requestAnimationFrame(() => resolve())
})

const waitForFrames = async (count: number) => {
  for (let index = 0; index < count; index += 1) {
    await nextFrame()
  }
}

const findWebglSurface = (terminalId: string): WebglSurfaceProbe | null => {
  const cell = document.querySelector<HTMLElement>(`.terminal-grid-cell[data-terminal-id="${escapeCssIdent(terminalId)}"]`)
  if (!cell) return null

  const canvases = Array.from(cell.querySelectorAll<HTMLCanvasElement>('.xterm-screen canvas'))
  for (const canvas of canvases) {
    const rect = canvas.getBoundingClientRect()
    if (rect.width <= 1 || rect.height <= 1 || canvas.width <= 1 || canvas.height <= 1) {
      continue
    }

    const gl = canvas.getContext('webgl2') ?? canvas.getContext('webgl')
    if (gl && !gl.isContextLost()) {
      return { canvas, gl }
    }
  }

  return null
}

const readWebglPixels = (gl: WebglContext): WebglPixelStats => {
  const width = gl.drawingBufferWidth
  const height = gl.drawingBufferHeight
  const pixels = new Uint8Array(width * height * 4)

  gl.bindFramebuffer(gl.FRAMEBUFFER, null)
  gl.finish()
  gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, pixels)

  let nonZeroPixels = 0
  let alphaPixels = 0
  let maxChannel = 0
  let checksum = 0
  let intensitySum = 0
  let intensitySquaredSum = 0

  for (let index = 0; index < pixels.length; index += 4) {
    const r = pixels[index]
    const g = pixels[index + 1]
    const b = pixels[index + 2]
    const a = pixels[index + 3]
    const pixelMax = Math.max(r, g, b, a)
    const intensity = r + g + b
    intensitySum += intensity
    intensitySquaredSum += intensity * intensity
    if (pixelMax > 8) {
      nonZeroPixels += 1
      checksum = ((checksum * 31) + r + (g * 3) + (b * 7) + (a * 11)) >>> 0
    }
    if (a > 8) {
      alphaPixels += 1
    }
    if (pixelMax > maxChannel) {
      maxChannel = pixelMax
    }
  }

  const sampledPixels = width * height
  const intensityMean = sampledPixels > 0 ? intensitySum / sampledPixels : 0
  const intensityVariance = sampledPixels > 0
    ? Math.max(0, (intensitySquaredSum / sampledPixels) - (intensityMean * intensityMean))
    : 0

  return {
    width,
    height,
    sampledPixels,
    nonZeroPixels,
    alphaPixels,
    maxChannel,
    checksum,
    nonZeroRatio: sampledPixels > 0 ? nonZeroPixels / sampledPixels : 0,
    intensityMean,
    intensityVariance
  }
}

const hasRenderablePixels = (stats: WebglPixelStats) => {
  return stats.maxChannel > 8 && stats.intensityVariance > 0.05
}

// Used by the TFA-10..17 phantom-blank cases. After `phantomBlank()` paints
// the WebGL canvas a flat white, every pixel reads (255,255,255,255) — high
// maxChannel and intensityMean but zero variance.
const looksAllWhite = (stats: WebglPixelStats) =>
  stats.maxChannel >= 250 && stats.intensityMean >= 720 && stats.intensityVariance < 0.05

const arePixelStatsStable = (current: WebglPixelStats, next: WebglPixelStats) => {
  return current.checksum === next.checksum &&
    Math.abs(current.intensityMean - next.intensityMean) < 0.01 &&
    Math.abs(current.intensityVariance - next.intensityVariance) < 0.01
}

export async function testTerminalFocusActivation(ctx: AutotestContext): Promise<TestResult[]> {
  const { log, sleep, waitFor, assert, cancelled, terminalId } = ctx
  const results: TestResult[] = []
  const _assert = (name: string, ok: boolean, detail?: Record<string, unknown>) => {
    assert(name, ok, detail)
    results.push({ name, ok, detail })
  }

  const getApi = () => window.__onwardTerminalFocusDebug
  const getTerminalApi = () => window.__onwardTerminalDebug
  const closeProjectEditorIfNeeded = async () => {
    const projectEditorApi = window.__onwardProjectEditorDebug
    if (!projectEditorApi?.isOpen()) {
      return true
    }

    document.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'Escape',
      bubbles: true,
      cancelable: true
    }))

    const closed = await waitFor(
      'tfa-close-project-editor',
      () => !window.__onwardProjectEditorDebug?.isOpen?.(),
      4000,
      50
    )
    log('terminal-focus-activation:close-project-editor', { closed })
    return closed
  }
  const focusAppWindow = async (label: string) => {
    const requested = await window.electronAPI.debug.focusWindow()
    const focused = await waitFor(
      `tfa-window-focus-${label}`,
      () => document.hasFocus(),
      2000,
      50
    )
    log('terminal-focus-activation:focus-window', { label, requested, focused })
    return requested && focused
  }

  log('terminal-focus-activation:start', { terminalId })

  const api = getApi()
  _assert('TFA-01-debug-api-available', Boolean(api), {
    available: Boolean(api)
  })
  if (!api || cancelled()) {
    return results
  }

  await closeProjectEditorIfNeeded()
  await sleep(400)

  const prepared = api.prepareTerminalRestore(terminalId)
  _assert('TFA-02-prepare-terminal-restore', prepared, {
    terminalId,
    state: api.getState()
  })
  if (!prepared || cancelled()) {
    return results
  }

  await focusAppWindow('shortcut-restore')
  api.simulateRestore('shortcut-activated')
  const shortcutRestoreFocused = await waitFor(
    'tfa-shortcut-restore-focus',
    () => getApi()?.getFocusedTerminalId() === terminalId,
    3000,
    50
  )
  _assert('TFA-03-shortcut-restore-focuses-terminal', shortcutRestoreFocused, api.getState())

  api.blurActiveElement()
  const blurClearedFocus = await waitFor(
    'tfa-blur-clears-focus',
    () => getApi()?.getFocusedTerminalId() === null,
    1500,
    50
  )
  _assert('TFA-04-blur-clears-terminal-focus', blurClearedFocus, api.getState())

  api.prepareTerminalRestore(terminalId)
  api.simulatePointerTarget('terminal', terminalId)
  api.simulateRestore('window-focus')
  await sleep(POINTER_SUPPRESS_SETTLE_MS)
  _assert('TFA-05-window-focus-after-terminal-pointer-does-not-refocus', api.getFocusedTerminalId() === null, api.getState())

  await focusAppWindow('shortcut-activated')
  api.simulateRestore('shortcut-activated')
  const shortcutActivatedFocused = await waitFor(
    'tfa-shortcut-activated-focus',
    () => getApi()?.getFocusedTerminalId() === terminalId,
    3000,
    50
  )
  _assert('TFA-06-shortcut-activation-still-restores-terminal', shortcutActivatedFocused, api.getState())

  api.blurActiveElement()
  await waitFor('tfa-clear-focus-again', () => getApi()?.getFocusedTerminalId() === null, 1500, 50)
  api.prepareTerminalRestore(terminalId)
  api.simulatePointerTarget('other')
  api.simulateRestore('window-focus')
  await sleep(POINTER_SUPPRESS_SETTLE_MS)
  _assert('TFA-07-window-focus-after-mouse-other-does-not-refocus', api.getFocusedTerminalId() === null, api.getState())

  api.prepareTerminalRestore(terminalId)
  await sleep(POINTER_STALE_WAIT_MS)
  await focusAppWindow('stale-pointer')
  api.simulateRestore('window-focus')
  const stalePointerRestoreFocused = await waitFor(
    'tfa-stale-pointer-window-focus',
    () => getApi()?.getFocusedTerminalId() === terminalId,
    3000,
    50
  )
  _assert('TFA-08-window-focus-restores-terminal-when-pointer-is-stale', stalePointerRestoreFocused, api.getState())

  const terminalApi = getTerminalApi()
  const terminalDebugAvailable = Boolean(terminalApi)
  const dataSettledBeforeSurfaceProbe = Boolean(terminalApi) && await waitFor(
    'tfa-surface-repro-data-settled',
    () => {
      const state = terminalApi?.getSessionState(terminalId)
      return Boolean(state?.status === 'ready' && state.pendingDataBytes === 0 && state.pendingDataChunks === 0)
    },
    2000,
    50
  )
  const fitBeforeSurfaceProbe = terminalApi?.forceFit(terminalId) ?? false
  await waitForFrames(2)

  let initialSurface = findWebglSurface(terminalId)
  let beforeClearStats = initialSurface ? readWebglPixels(initialSurface.gl) : null
  let stableBeforeClearStats: WebglPixelStats | null = null
  let stableSurfaceElapsedMs: number | null = null
  let stableSurfaceSampleCount = 0
  const stableSurfaceStartedAt = performance.now()
  while (initialSurface && beforeClearStats && performance.now() - stableSurfaceStartedAt < SURFACE_IDLE_TIMEOUT_MS) {
    await sleep(SURFACE_IDLE_SAMPLE_MS)
    const nextSurface = findWebglSurface(terminalId)
    if (!nextSurface) break

    const nextStats = readWebglPixels(nextSurface.gl)
    if (hasRenderablePixels(nextStats) && arePixelStatsStable(beforeClearStats, nextStats)) {
      initialSurface = nextSurface
      stableBeforeClearStats = nextStats
      stableSurfaceSampleCount += 1
      stableSurfaceElapsedMs = Math.round(performance.now() - stableSurfaceStartedAt)
      if (stableSurfaceSampleCount >= SURFACE_IDLE_STABLE_SAMPLE_COUNT) {
        break
      }
    } else {
      stableSurfaceSampleCount = 0
    }

    initialSurface = nextSurface
    beforeClearStats = nextStats
  }

  const sessionBeforeSurfaceProbe = terminalApi?.getSessionState(terminalId) ?? null
  const sessionBeforeSurfaceRecord = (sessionBeforeSurfaceProbe ?? {}) as Record<string, unknown>
  if (!initialSurface) {
    _assert(
      'TFA-09-document-visible-recovers-visible-terminal-renderer',
      terminalDebugAvailable &&
        (
          sessionBeforeSurfaceRecord.rendererMode === 'fallback' ||
          sessionBeforeSurfaceRecord.webglActive === false
        ),
      {
        skipped: true,
        reason: 'webgl-surface-unavailable',
        terminalDebugAvailable,
        dataSettledBeforeSurfaceProbe,
        fitBeforeSurfaceProbe,
        sessionBeforeSurfaceProbe
      }
    )
  } else {
    const beforeLossStats = stableBeforeClearStats ?? beforeClearStats ?? readWebglPixels(initialSurface.gl)
    const initialCanvasSize = {
      cssWidth: Math.round(initialSurface.canvas.getBoundingClientRect().width),
      cssHeight: Math.round(initialSurface.canvas.getBoundingClientRect().height),
      deviceWidth: initialSurface.canvas.width,
      deviceHeight: initialSurface.canvas.height
    }
    const simulatedSurfaceLoss = terminalApi?.simulateRendererSurfaceLoss(terminalId) ?? false
    const surfaceLost = await waitFor(
      'tfa-webgl-renderer-surface-lost',
      () => {
        const state = terminalApi?.getSessionState(terminalId)
        return Boolean(state?.status === 'ready' && state.open && state.visible && state.webglActive === false && !findWebglSurface(terminalId))
      },
      SURFACE_LOSS_TIMEOUT_MS,
      50
    )
    const sessionAfterSurfaceLoss = terminalApi?.getSessionState(terminalId) ?? null

    let restoredStats: WebglPixelStats | null = null
    let restoreElapsedMs: number | null = null
    const restoreStartedAt = performance.now()
    // Drive the restore via the manager rather than dispatching a synthetic
    // `visibilitychange` event. The DOM dispatch path is racey: TFA-08 just
    // performed window-focus juggling, and the manager's 80ms surface
    // resume debounce may have already accepted that focus event when our
    // synthetic dispatch lands. Calling notifyHostSurfaceEvent enters the
    // pipeline with our chosen reason and starts a fresh debounce slot.
    terminalApi?.notifyHostSurfaceEvent('document-visible')
    // Recovery semantics: a successful host-surface-driven restore re-creates
    // the WebGL addon (path A) and refreshes xterm so the live terminal
    // buffer paints into the new canvas. The post-restore canvas should
    // therefore show the same terminal content that was visible before the
    // loss — meaning the pixel checksum will *match* beforeLossStats, not
    // diverge from it. Earlier revisions of this test required
    // `checksum !== beforeLossStats.checksum`, which only ever passed when
    // the restore happened to land mid-frame (cursor blink, partial render).
    // Switch to the user-visible signal: a fresh canvas with renderable
    // pixels plus the lifecycle reporting webglActive=true.
    const restored = await waitFor(
      'tfa-webgl-surface-restored-after-document-visible',
      () => {
        const surface = findWebglSurface(terminalId)
        if (!surface) return false
        const stats = readWebglPixels(surface.gl)
        if (!hasRenderablePixels(stats)) return false
        const sessionState = terminalApi?.getSessionState(terminalId)
        if (!sessionState?.webglActive) return false
        restoredStats = stats
        restoreElapsedMs = Math.round(performance.now() - restoreStartedAt)
        return true
      },
      SURFACE_RESTORE_TIMEOUT_MS,
      80
    )
    const sessionAfterSurfaceRestore = terminalApi?.getSessionState(terminalId) ?? null

    _assert(
      'TFA-09-document-visible-recovers-visible-terminal-renderer',
      terminalDebugAvailable &&
        dataSettledBeforeSurfaceProbe &&
        fitBeforeSurfaceProbe &&
        Boolean(stableBeforeClearStats) &&
        hasRenderablePixels(beforeLossStats) &&
        simulatedSurfaceLoss &&
        surfaceLost &&
        restored &&
        Boolean(sessionAfterSurfaceRestore?.status === 'ready' &&
          sessionAfterSurfaceRestore.open &&
          sessionAfterSurfaceRestore.visible &&
          sessionAfterSurfaceRestore.webglActive),
      {
        terminalDebugAvailable,
        dataSettledBeforeSurfaceProbe,
        fitBeforeSurfaceProbe,
        simulatedSurfaceLoss,
        surfaceLost,
        stableSurfaceElapsedMs,
        stableSurfaceSampleCount,
        restoreElapsedMs,
        canvasSize: initialCanvasSize,
        beforeClearStats: beforeLossStats,
        restoredStats,
        sessionBeforeSurfaceProbe,
        sessionAfterSurfaceLoss,
        sessionAfterSurfaceRestore
      }
    )
  }

  // ───────────────────────────────────────────────────────────────────
  // TFA-10..18 — "blank Task after desktop swipe" lifecycle regression
  //
  // TFA-09 above exercises the legacy `simulateRendererSurfaceLoss` path
  // which goes through `lifecycle.deactivate('manual-debug')` → synchronous
  // `disposeWebgl()`. That path skips the real `webglcontextlost` event
  // chain and therefore never reproduced the user-visible bug ("white
  // Task + broken-image after macOS Spaces / Win virtual desktop swipe").
  //
  // The cases below drive WEBGL_lose_context.loseContext() directly so
  // every assertion exercises the real Chromium event path. Coverage:
  //   TFA-10 phantom-blank repro infrastructure self-test
  //   TFA-11 path B (visibilitychange) re-renders blanked canvas
  //   TFA-12 path B (window-focus) re-renders blanked canvas
  //   TFA-13 xterm's webglcontextlost path still calls preventDefault
  //   TFA-14 xterm onContextLoss disposes WebGL like VS Code
  //   TFA-15 DOM renderer shows the live terminal buffer after loss
  //   TFA-16 document-visible during cooldown keeps DOM rendering
  //   TFA-17 repeated host events during cooldown do not recreate WebGL
  //   TFA-18 restoring the old canvas context does not disturb DOM fallback
  // ───────────────────────────────────────────────────────────────────
  const repro = window.__blankTaskRepro
  if (!repro) {
    _assert('TFA-10-blank-task-repro-api-available', false, {
      skipped: true,
      reason: 'window.__blankTaskRepro not exposed; ensure terminal-session-manager gated it on autotest mode'
    })
  } else {
    const PHANTOM_SETTLE_MS = 80
    // TFA-11 polls for the transient all-white phantom frame rather than taking
    // one fixed-time sample: phantomBlank() clears the WebGL backbuffer white but
    // xterm's live render service repaints the real buffer on its next tick, so a
    // single sample races the repaint (under EDR the window stretches / xterm
    // repaints first → the white frame is missed and looksAllWhite spuriously
    // fails even though the repro fired). Generous hang-detector ceiling: a
    // slow-but-correct paint passes; only a never-white repro-infra failure trips it.
    const PHANTOM_BLANK_OBSERVE_TIMEOUT_MS = 2000
    const RESTORE_TIMEOUT_MS = SURFACE_RESTORE_TIMEOUT_MS
    const RESTORE_POLL_MS = 60
    const reproSurface = findWebglSurface(terminalId)
    _assert('TFA-10-blank-task-repro-api-available', Boolean(reproSurface), {
      reproApiAvailable: true,
      hasWebglSurface: Boolean(reproSurface)
    })

    if (reproSurface) {
      // ---- TFA-11: phantom-blank + visibilitychange recovers ----
      {
        const phantomResult = repro.phantomBlank(terminalId)
        // Poll until the all-white phantom frame is observed (capturing the
        // matching stats), instead of one fixed-time sample that races xterm's
        // concurrent repaint. STRICTER than the old sample — it positively
        // confirms the white frame existed rather than hoping to catch it.
        let statsAfterPaint: WebglPixelStats | null = null
        const phantomWhiteObserved = await waitFor(
          'tfa-11-phantom-white-observed',
          () => {
            const surface = findWebglSurface(terminalId)
            if (!surface) return false
            const stats = readWebglPixels(surface.gl)
            if (looksAllWhite(stats)) {
              statsAfterPaint = stats
              return true
            }
            return false
          },
          PHANTOM_BLANK_OBSERVE_TIMEOUT_MS,
          RESTORE_POLL_MS
        )
        const phantomBlankApplied = phantomResult.triggered && phantomWhiteObserved

        // Same rationale as TFA-09: enter the manager directly so the 80ms
        // debounce isn't coalesced with focus events from earlier cases.
        terminalApi?.notifyHostSurfaceEvent('document-visible')
        const recovered = await waitFor(
          'tfa-11-restored-after-visibilitychange',
          () => {
            const surface = findWebglSurface(terminalId)
            if (!surface) return false
            return hasRenderablePixels(readWebglPixels(surface.gl))
          },
          RESTORE_TIMEOUT_MS,
          RESTORE_POLL_MS
        )
        _assert(
          'TFA-11-phantom-blank-recovered-by-visibilitychange',
          phantomBlankApplied && recovered,
          {
            phantomResult,
            statsAfterPaint,
            recovered,
            bugHypothesisFix:
              'restoreSurface path B (clearTextureAtlas) must follow with terminal.refresh() — clearTextureAtlas alone marks rows dirty but never paints'
          }
        )
      }

      // ---- TFA-12: phantom-blank + window-focus recovers ----
      {
        const phantomResult = repro.phantomBlank(terminalId)
        await sleep(PHANTOM_SETTLE_MS)
        // Same rationale as TFA-09/11. The synthetic window-focus dispatch
        // hits the same debounce as the previous TFA-11 visibility event,
        // so direct manager entry avoids the coalesce race.
        terminalApi?.notifyHostSurfaceEvent('window-focus')
        const recovered = await waitFor(
          'tfa-12-restored-after-window-focus',
          () => {
            const surface = findWebglSurface(terminalId)
            if (!surface) return false
            return hasRenderablePixels(readWebglPixels(surface.gl))
          },
          RESTORE_TIMEOUT_MS,
          RESTORE_POLL_MS
        )
        _assert('TFA-12-phantom-blank-recovered-by-window-focus', phantomResult.triggered && recovered, {
          phantomResult,
          recovered
        })
      }

      // ---- TFA-13..18: real WebGL context loss follows VS Code fallback semantics ----
      {
        await sleep(200)
        const spySurface = findWebglSurface(terminalId)
        let listenerFired = false
        let defaultPreventedSeen = false
        const spyListener = (event: Event) => {
          listenerFired = true
          defaultPreventedSeen = event.defaultPrevented
        }
        if (spySurface) {
          spySurface.canvas.addEventListener('webglcontextlost', spyListener, false)
        }
        const lossResult = repro.triggerWebglLoss(terminalId)
        const fallbackObserved = await waitFor(
          'tfa-context-loss-xterm-addon-dom-fallback',
          () => {
            const state = repro.getSessionDebugState(terminalId) as {
              webglActive?: boolean
              rendererMode?: string
              rendererContextLost?: boolean
              rendererWebglDisabledUntil?: number | null
            } | null
            return state !== null &&
              state.webglActive === false &&
              state.rendererMode === 'fallback' &&
              state.rendererContextLost === false &&
              (state.rendererWebglDisabledUntil ?? null) !== null
          },
          CONTEXT_LOSS_FALLBACK_TIMEOUT_MS,
          RESTORE_POLL_MS
        )
        const stateAfterLoss = repro.getSessionDebugState(terminalId) as {
          webglActive?: boolean
          rendererMode?: string
          rendererContextLost?: boolean
          rendererWebglDisabledUntil?: number | null
        } | null
        if (spySurface) {
          spySurface.canvas.removeEventListener('webglcontextlost', spyListener)
        }
        await waitForFrames(2)
        const terminalCell = document.querySelector<HTMLElement>(
          `.terminal-grid-cell[data-terminal-id="${escapeCssIdent(terminalId)}"]`
        )
        const domRowsText = terminalCell?.querySelector<HTMLElement>('.xterm-rows')?.textContent ?? ''
        const tailText = terminalApi?.getTailText(terminalId, 5) ?? ''

        _assert(
          'TFA-13-webglcontextlost-handler-calls-preventDefault',
          Boolean(spySurface) && lossResult.triggered && listenerFired && defaultPreventedSeen,
          {
            spySurface: Boolean(spySurface),
            lossTriggered: lossResult.triggered,
            listenerFired,
            defaultPreventedSeen,
            bugHypothesisFix:
              'xterm keeps Chromium free to restore the old canvas context, while the lifecycle follows VS Code and relies on WebglAddon.onContextLoss for user-visible fallback'
          }
        )

        _assert(
          'TFA-14-context-loss-disposes-webgl-renderer',
          lossResult.triggered &&
            fallbackObserved &&
            stateAfterLoss !== null &&
            stateAfterLoss.webglActive === false &&
            stateAfterLoss.rendererMode === 'fallback' &&
            stateAfterLoss.rendererContextLost === false &&
            (stateAfterLoss.rendererWebglDisabledUntil ?? null) !== null,
          {
            lossResult,
            fallbackObserved,
            stateAfterLoss,
            bugHypothesisFix:
              'match VS Code: dispose the WebGL renderer from xterm WebglAddon.onContextLoss and keep the terminal readable through xterm DOM rendering'
          }
        )

        _assert(
          'TFA-15-context-loss-dom-fallback-shows-live-buffer',
          lossResult.triggered &&
            fallbackObserved &&
            (domRowsText.trim().length > 0 || tailText.trim().length > 0),
          {
            domRowsTextLength: domRowsText.trim().length,
            tailTextLength: tailText.trim().length,
            bugHypothesisFix:
              'after WebGL is disposed, the DOM renderer must paint existing buffer text without waiting for new PTY output'
          }
        )

        terminalApi?.notifyHostSurfaceEvent('document-visible')
        await sleep(220)
        const stateAfterDocumentVisible = repro.getSessionDebugState(terminalId) as {
          webglActive?: boolean
          rendererMode?: string
          rendererWebglDisabledUntil?: number | null
        } | null
        _assert(
          'TFA-16-document-visible-keeps-dom-during-webgl-cooldown',
          stateAfterDocumentVisible !== null &&
            stateAfterDocumentVisible.webglActive === false &&
            stateAfterDocumentVisible.rendererMode === 'fallback' &&
            (stateAfterDocumentVisible.rendererWebglDisabledUntil ?? null) !== null,
          {
            stateAfterDocumentVisible,
            bugHypothesisFix:
              'focus/visibility restoration must not recreate WebGL while the cooldown is active after a GPU context loss'
          }
        )

        terminalApi?.notifyHostSurfaceEvent('window-focus')
        terminalApi?.notifyHostSurfaceEvent('page-show')
        await sleep(260)
        const stateAfterRepeatedHostEvents = repro.getSessionDebugState(terminalId) as {
          webglActive?: boolean
          rendererMode?: string
          rendererWebglDisabledUntil?: number | null
        } | null
        const surfaceAfterRepeatedHostEvents = findWebglSurface(terminalId)
        _assert(
          'TFA-17-repeated-host-events-do-not-recreate-webgl-during-cooldown',
          stateAfterRepeatedHostEvents !== null &&
            stateAfterRepeatedHostEvents.webglActive === false &&
            stateAfterRepeatedHostEvents.rendererMode === 'fallback' &&
            (stateAfterRepeatedHostEvents.rendererWebglDisabledUntil ?? null) !== null &&
            surfaceAfterRepeatedHostEvents === null,
          {
            stateAfterRepeatedHostEvents,
            hasWebglSurface: surfaceAfterRepeatedHostEvents !== null,
            bugHypothesisFix:
              'multiple host surface events after Spaces/sleep recovery must not churn WebGL contexts while DOM fallback is already showing the buffer'
          }
        )

        const cleanupRestoreResult = repro.forceWebglRestore(terminalId)
        await sleep(120)
        const stateAfterOldContextRestore = repro.getSessionDebugState(terminalId) as {
          webglActive?: boolean
          rendererMode?: string
          rendererContextLost?: boolean
          rendererWebglDisabledUntil?: number | null
        } | null
        const domRowsTextAfterOldRestore =
          terminalCell?.querySelector<HTMLElement>('.xterm-rows')?.textContent ?? ''
        _assert(
          'TFA-18-old-context-restore-does-not-disturb-dom-fallback',
          cleanupRestoreResult.triggered &&
            stateAfterOldContextRestore !== null &&
            stateAfterOldContextRestore.webglActive === false &&
            stateAfterOldContextRestore.rendererMode === 'fallback' &&
            stateAfterOldContextRestore.rendererContextLost === false &&
            (stateAfterOldContextRestore.rendererWebglDisabledUntil ?? null) !== null &&
            domRowsTextAfterOldRestore.trim().length > 0,
          {
            cleanupRestoreResult,
            stateAfterOldContextRestore,
            domRowsTextAfterOldRestoreLength: domRowsTextAfterOldRestore.trim().length,
            bugHypothesisFix:
              'once the lifecycle has switched to DOM rendering, a later restore of the old detached WebGL context must not flip the terminal back into a blank GPU surface'
          }
        )
      }
    }
  }

  log('terminal-focus-activation:done', {
    total: results.length,
    passed: results.filter(r => r.ok).length,
    failed: results.filter(r => !r.ok).length
  })

  return results
}
