/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

import type { AutotestContext, TestResult } from './types'
import {
  escapeCssIdent,
  findWebglSurface,
  readWebglPixels,
  hasRenderablePixels,
  type WebglPixelStats
} from './webgl-probe-utils'

const POINTER_SUPPRESS_SETTLE_MS = 180
const POINTER_STALE_WAIT_MS = 520
const SURFACE_IDLE_TIMEOUT_MS = 2200
const SURFACE_IDLE_SAMPLE_MS = 160
const SURFACE_IDLE_STABLE_SAMPLE_COUNT = 4
const SURFACE_LOSS_TIMEOUT_MS = 1000
const SURFACE_RESTORE_TIMEOUT_MS = 1500
const CONTEXT_LOSS_FALLBACK_TIMEOUT_MS = 12000

const nextFrame = () => new Promise<void>((resolve) => {
  window.requestAnimationFrame(() => resolve())
})

const waitForFrames = async (count: number) => {
  for (let index = 0; index < count; index += 1) {
    await nextFrame()
  }
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
  //   TFA-19 document-hidden keeps WebGL alive (occlusion keep-alive contract, 5-trial aggregate)
  //   TFA-20 surface-restore latency budget: >=1 of 3 trials within SURFACE_RESTORE_BUDGET_MS
  //   TFA-21 GPU crash while hidden defers rebuild, recovers on document-visible (two-phase, fresh atlas)
  //   TFA-22 second GPU crash blows the session fuse: sticky DOM renderer + TabBar banner
  //   TFA-23 third crash stays DOM (fuse is one-way for the session)
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
              'restoreSurface refresh-only path must force terminal.refresh() — a live addon repaint cannot wait for the next PTY write (atlas is intentionally NOT cleared: shared across panes)'
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

      // ---- TFA-19/20: occlusion keep-alive contract + restore latency budget ----
      // 2026-07-13 "all terminals white for 1-3s after Space switch-back" fix.
      // Peer-aligned contract: document-hidden NEVER tears down WebGL; the
      // switch-back restore is a refresh (no context recreate, no shared-atlas
      // clear), so the compositor always has a committed frame within budget.
      {
        // TFA-13..18 left this terminal in DOM fallback with the WebGL
        // cooldown ticking (5s from the loss). Wait it out, then let a host
        // surface event recreate WebGL — this transition is itself part of
        // the contract (cooldown expiry → recreate works).
        const cooldownState = repro.getSessionDebugState(terminalId) as {
          rendererWebglDisabledUntil?: number | null
        } | null
        const disabledUntil = cooldownState?.rendererWebglDisabledUntil ?? null
        if (disabledUntil !== null) {
          const remaining = Math.max(0, disabledUntil - performance.now())
          await sleep(remaining + 100)
        }
        terminalApi?.notifyHostSurfaceEvent('document-visible')
        const webglBack = await waitFor(
          'tfa-19-webgl-recreated-after-cooldown-expiry',
          () => {
            const state = repro.getSessionDebugState(terminalId) as { webglActive?: boolean } | null
            return state?.webglActive === true && findWebglSurface(terminalId) !== null
          },
          8000,
          100
        )

        // Shadow document.hidden with an own accessor so the real hidden
        // branch of the visibilitychange handler runs (the property lives on
        // Document.prototype; delete restores platform behaviour).
        const setDocumentHiddenForTest = (hidden: boolean) => {
          if (hidden) {
            Object.defineProperty(document, 'hidden', { configurable: true, get: () => true })
            Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' })
          } else {
            delete (document as { hidden?: unknown }).hidden
            delete (document as { visibilityState?: unknown }).visibilityState
          }
          document.dispatchEvent(new Event('visibilitychange'))
        }

        // TFA-19 — keep-alive roundtrip. Timing-sensitive (visibility events,
        // debounced restore) → repeat 5x inside the test, assert ALL trials
        // kept the addon alive through the hidden phase and recovered pixels
        // after the visible phase (boolean-correctness aggregator).
        const KEEPALIVE_TRIALS = 5
        const keepAliveTrials: Array<{
          aliveWhileHidden: boolean
          surfacePresentWhileHidden: boolean
          recoveredAfterVisible: boolean
        }> = []
        if (webglBack) {
          for (let trial = 0; trial < KEEPALIVE_TRIALS; trial++) {
            setDocumentHiddenForTest(true)
            try {
              // The old suspend design disposed WebGL synchronously in this
              // handler; give the (removed) path headroom to misbehave before
              // sampling so a regression cannot hide in dispatch timing.
              await sleep(150)
              const hiddenState = repro.getSessionDebugState(terminalId) as {
                webglActive?: boolean
              } | null
              keepAliveTrials.push({
                aliveWhileHidden: hiddenState?.webglActive === true,
                surfacePresentWhileHidden: findWebglSurface(terminalId) !== null,
                recoveredAfterVisible: false
              })
            } finally {
              setDocumentHiddenForTest(false)
            }
            const recovered = await waitFor(
              `tfa-19-recovered-trial-${trial}`,
              () => {
                const surface = findWebglSurface(terminalId)
                if (!surface) return false
                const state = repro.getSessionDebugState(terminalId) as { webglActive?: boolean } | null
                return state?.webglActive === true && hasRenderablePixels(readWebglPixels(surface.gl))
              },
              RESTORE_TIMEOUT_MS,
              RESTORE_POLL_MS
            )
            keepAliveTrials[trial].recoveredAfterVisible = recovered
          }
        }
        const keepAliveAllTrialsGreen =
          keepAliveTrials.length === KEEPALIVE_TRIALS &&
          keepAliveTrials.every(
            (t) => t.aliveWhileHidden && t.surfacePresentWhileHidden && t.recoveredAfterVisible
          )
        _assert('TFA-19-document-hidden-keeps-webgl-alive', webglBack && keepAliveAllTrialsGreen, {
          webglBack,
          trials: keepAliveTrials,
          bugHypothesisFix:
            'document-hidden must not dispose WebGL: occlusion keep-alive (VS Code-aligned) is what removes the N-context rebuild storm on Space switch-back'
        })

        // TFA-20 — restore latency. Latency aggregator per test/README.md § 3:
        // N=3 trials, pass if >=1 meets the budget, fail only if all 3 exceed.
        // Budget signed off by the user on 2026-07-13 (matches the existing
        // surface-restore precedent).
        const SURFACE_RESTORE_BUDGET_MS = 200
        const LATENCY_TRIALS = 3
        const LATENCY_POLL_MS = 25
        const latencyTrials: Array<{ whiteObserved: boolean; elapsedMs: number | null }> = []
        if (webglBack) {
          for (let trial = 0; trial < LATENCY_TRIALS; trial++) {
            const phantomResult = repro.phantomBlank(terminalId)
            const whiteObserved = await waitFor(
              `tfa-20-phantom-white-trial-${trial}`,
              () => {
                const surface = findWebglSurface(terminalId)
                return surface !== null && looksAllWhite(readWebglPixels(surface.gl))
              },
              PHANTOM_BLANK_OBSERVE_TIMEOUT_MS,
              LATENCY_POLL_MS
            )
            const startedAt = performance.now()
            terminalApi?.notifyHostSurfaceEvent('document-visible')
            let elapsedMs: number | null = null
            const recovered = await waitFor(
              `tfa-20-recovered-trial-${trial}`,
              () => {
                const surface = findWebglSurface(terminalId)
                if (!surface) return false
                if (!hasRenderablePixels(readWebglPixels(surface.gl))) return false
                elapsedMs = Math.round(performance.now() - startedAt)
                return true
              },
              RESTORE_TIMEOUT_MS,
              LATENCY_POLL_MS
            )
            latencyTrials.push({
              whiteObserved: phantomResult.triggered && whiteObserved,
              elapsedMs: recovered ? elapsedMs : null
            })
            await sleep(120)
          }
        }
        const withinBudgetCount = latencyTrials.filter(
          (t) => t.elapsedMs !== null && t.elapsedMs <= SURFACE_RESTORE_BUDGET_MS
        ).length
        _assert(
          'TFA-20-surface-restore-latency-within-budget',
          webglBack && latencyTrials.length === LATENCY_TRIALS && withinBudgetCount >= 1,
          {
            budgetMs: SURFACE_RESTORE_BUDGET_MS,
            withinBudgetCount,
            trials: latencyTrials,
            bugHypothesisFix:
              'switch-back restore is refresh-only on a live addon (no context recreate, no shared-atlas clear), so at least one of three trials must repaint within the budget'
          }
        )

        // ---- TFA-21/22/23: GPU-crash recovery contract (batch-1 + batch-2 fixes) ----
        // Crash #1 while HIDDEN: recovery must DEFER (a hidden-document
        // rebuild cannot be paint-verified) and execute on the next
        // document-visible with a fresh shared atlas (two-phase rebuild).
        // Crash #2: the session fuse blows (N=2 product decision) — every
        // terminal sticks to the DOM renderer, the TabBar banner appears.
        // Crash #3: stays DOM; no WebGL is ever recreated this session.
        // Deterministic staged sequence (the fuse is one-way, identical
        // trials are impossible); waitFor timeouts absorb scheduling jitter.
        {
          const getAddonRef = () => {
            const mgr = (window as unknown as {
              __terminalSessionManager?: { getSession?: (id: string) => { renderer?: { } } | undefined }
            }).__terminalSessionManager
            const session = mgr?.getSession?.(terminalId) as { webglAddon?: object; renderer?: unknown } | undefined
            return (session as { renderer?: { webglAddon?: object } } | undefined)?.renderer?.webglAddon ?? null
          }

          // -- Crash #1, document hidden → deferred, then executed on visible --
          const addonBeforeCrash1 = getAddonRef()
          setDocumentHiddenForTest(true)
          const simulate1 = await window.electronAPI.debug.simulateGpuProcessGone()
          await sleep(250)
          const addonWhileHidden = getAddonRef()
          const deferredWhileHidden = addonWhileHidden === addonBeforeCrash1
          setDocumentHiddenForTest(false)
          const recovered1 = await waitFor(
            'tfa-21-deferred-recovery-on-visible',
            () => {
              const addonAfter = getAddonRef()
              if (!addonAfter || addonAfter === addonBeforeCrash1) return false
              const state = repro.getSessionDebugState(terminalId) as { webglActive?: boolean } | null
              if (state?.webglActive !== true) return false
              const surface = findWebglSurface(terminalId)
              return Boolean(surface && hasRenderablePixels(readWebglPixels(surface.gl)))
            },
            RESTORE_TIMEOUT_MS,
            RESTORE_POLL_MS
          )
          _assert(
            'TFA-21-gpu-crash-hidden-defers-then-recovers-on-visible',
            Boolean(simulate1?.success) && (simulate1?.notified ?? 0) >= 1 && deferredWhileHidden && recovered1,
            {
              simulate1,
              deferredWhileHidden,
              recovered1,
              bugHypothesisFix:
                'a GPU crash arriving on a hidden document must defer its rebuild to the next document-visible (frozen rAF cannot paint-verify), then two-phase recreate with a fresh shared atlas'
            }
          )

          // -- Crash #2 → session fuse: sticky DOM fallback + banner --
          const simulate2 = await window.electronAPI.debug.simulateGpuProcessGone()
          const stuckToDom = await waitFor(
            'tfa-22-sticky-dom-after-second-crash',
            () => {
              const state = repro.getSessionDebugState(terminalId) as { webglActive?: boolean } | null
              return state?.webglActive === false
            },
            RESTORE_TIMEOUT_MS,
            RESTORE_POLL_MS
          )
          const fuseCell = document.querySelector<HTMLElement>(
            `.terminal-grid-cell[data-terminal-id="${escapeCssIdent(terminalId)}"]`
          )
          const domRowsAfterFuse =
            fuseCell?.querySelector<HTMLElement>('.xterm-rows')?.textContent ?? ''
          // A surface event must NOT resurrect WebGL while the fuse is blown.
          terminalApi?.notifyHostSurfaceEvent('document-visible')
          await sleep(250)
          const stateAfterSurfaceEvent = repro.getSessionDebugState(terminalId) as { webglActive?: boolean } | null
          const banner = document.querySelector<HTMLElement>('[data-testid="gpu-fallback-banner"]')
          const bannerText = banner?.textContent ?? ''
          _assert(
            'TFA-22-second-crash-blows-fuse-sticky-dom-plus-banner',
            Boolean(simulate2?.success) &&
              stuckToDom &&
              domRowsAfterFuse.trim().length > 0 &&
              stateAfterSurfaceEvent?.webglActive === false &&
              bannerText.includes('compatibility rendering'),
            {
              simulate2,
              stuckToDom,
              domRowsLength: domRowsAfterFuse.trim().length,
              webglAfterSurfaceEvent: stateAfterSurfaceEvent?.webglActive,
              bannerText: bannerText.slice(0, 140),
              bugHypothesisFix:
                'the second GPU crash of a session must switch terminals to the DOM renderer for the rest of the session (VS Code-aligned fuse) and raise the TabBar banner'
            }
          )

          // -- Crash #3 → fuse stays blown, still DOM --
          const simulate3 = await window.electronAPI.debug.simulateGpuProcessGone()
          await sleep(400)
          const stateAfterThird = repro.getSessionDebugState(terminalId) as { webglActive?: boolean } | null
          _assert(
            'TFA-23-third-crash-stays-dom',
            Boolean(simulate3?.success) && stateAfterThird?.webglActive === false,
            {
              simulate3,
              webglAfterThird: stateAfterThird?.webglActive,
              bugHypothesisFix:
                'the sticky fallback is one-way for the session: later crashes must not flap the renderer back to WebGL'
            }
          )
        }
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
