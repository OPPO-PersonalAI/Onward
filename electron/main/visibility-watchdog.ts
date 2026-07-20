/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 *
 * Renderer-visibility watchdog — side-effect wiring.
 *
 * Decision logic lives in `visibility-health-model.ts` (pure, unit-tested).
 * This module owns:
 *
 *  - probe transport: send SYSTEM_VISIBILITY_PROBE to the main window's
 *    preload (which answers independently of app code) and await
 *    SYSTEM_VISIBILITY_PROBE_RESULT with a deadline. The reply deadline is
 *    generous (3 s) because a hidden renderer's timers are aligned to ~1 s
 *    by Chromium background throttling;
 *  - scheduling: a slow 30 s interval as the safety net (the 2026-07-20
 *    incident involved *display* sleep only — no system suspend event
 *    fires for that), plus immediate checks after powerMonitor
 *    resume / unlock-screen and screen display-added / display-removed /
 *    display-metrics-changed (remote-desktop virtual displays detach and
 *    reattach through exactly these);
 *  - nudges: level 1 toggles backgroundThrottling off/on (cheap, invisible),
 *    level 2 hides and re-shows the window (one visible flicker — the only
 *    intervention with field evidence of flipping Chromium's stuck
 *    occlusion state; showInactive is used when the window is not focused
 *    so focus is never stolen);
 *  - after a verdict flips back to healthy, broadcast
 *    SYSTEM_VISIBILITY_RECOVERY_PUSH so renderer surfaces resume even if
 *    the DOM `visibilitychange` event was swallowed.
 */

import { BrowserWindow, ipcMain, powerMonitor, screen } from 'electron'
import { IPC } from '../shared/ipc-channels'
import { performanceTrace } from './performance-trace'
import { PERF_TRACE_EVENT } from '../../src/utils/perf-trace-names'
import {
  initialVisibilityWatchState,
  judgeVisibilityProbe,
  reduceVisibilityCheck,
  type VisibilityProbeReply,
  type VisibilityWatchState
} from './visibility-health-model'

const CHECK_INTERVAL_MS = 30_000
const PROBE_REPLY_DEADLINE_MS = 3_000
/** Re-check quickly after applying a nudge to walk the escalation ladder. */
const POST_NUDGE_RECHECK_MS = 2_000
/** Debounce after power/display events (occlusion recompute lags them). */
const EVENT_CHECK_DELAY_MS = 2_000

type GetMainWindow = () => BrowserWindow | null

let state: VisibilityWatchState = initialVisibilityWatchState()
let getMainWindow: GetMainWindow = () => null
let checkTimer: ReturnType<typeof setInterval> | null = null
let pendingRecheck: ReturnType<typeof setTimeout> | null = null
let checkInFlight = false
let probeSeq = 0
const pendingProbes = new Map<string, (reply: VisibilityProbeReply | 'timeout') => void>()

export function getVisibilityHealthSnapshot(): {
  status: 'ok' | 'nudging' | 'gave-up'
  recoveries: number
} {
  return { status: state.status, recoveries: state.recoveries }
}

function sendProbe(win: BrowserWindow): Promise<VisibilityProbeReply | 'timeout'> {
  return new Promise((resolve) => {
    const probeId = `vis-${++probeSeq}`
    const timer = setTimeout(() => {
      pendingProbes.delete(probeId)
      resolve('timeout')
    }, PROBE_REPLY_DEADLINE_MS)
    timer.unref()
    pendingProbes.set(probeId, (reply) => {
      clearTimeout(timer)
      pendingProbes.delete(probeId)
      resolve(reply)
    })
    try {
      win.webContents.send(IPC.SYSTEM_VISIBILITY_PROBE, probeId)
    } catch {
      clearTimeout(timer)
      pendingProbes.delete(probeId)
      resolve('timeout')
    }
  })
}

function scheduleRecheck(delayMs: number): void {
  if (pendingRecheck) clearTimeout(pendingRecheck)
  pendingRecheck = setTimeout(() => {
    pendingRecheck = null
    void runCheck('post-nudge')
  }, delayMs)
  pendingRecheck.unref()
}

function applyThrottleToggleNudge(win: BrowserWindow): void {
  try {
    win.webContents.setBackgroundThrottling(false)
    const restore = setTimeout(() => {
      try {
        if (!win.isDestroyed()) win.webContents.setBackgroundThrottling(true)
      } catch {
        // Window torn down mid-nudge; nothing to restore.
      }
    }, 500)
    restore.unref()
  } catch {
    // setBackgroundThrottling can throw on a destroyed webContents.
  }
}

function applyHideShowNudge(win: BrowserWindow): void {
  try {
    const hadFocus = win.isFocused()
    win.hide()
    if (hadFocus) {
      win.show()
    } else {
      win.showInactive()
    }
  } catch {
    // Window torn down mid-nudge.
  }
}

function broadcastRecoveryPush(nudge: string): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed() || win.webContents.isDestroyed()) continue
    try {
      win.webContents.send(IPC.SYSTEM_VISIBILITY_RECOVERY_PUSH, { nudge })
    } catch {
      // Frame torn down mid-send.
    }
  }
}

async function runCheck(reason: 'interval' | 'power-event' | 'display-event' | 'post-nudge'): Promise<void> {
  if (checkInFlight) return
  const win = getMainWindow()
  if (!win || win.isDestroyed() || win.webContents.isDestroyed()) return
  checkInFlight = true

  try {
    const windowVisible = win.isVisible() && !win.isMinimized()
    const probe = windowVisible ? await sendProbe(win) : 'timeout'
    const verdict = judgeVisibilityProbe({ windowVisible, probe })
    const { next, actions } = reduceVisibilityCheck(state, verdict, Date.now())
    const prevStatus = state.status
    state = next

    for (const action of actions) {
      switch (action) {
        case 'record-mismatch':
          performanceTrace.record(PERF_TRACE_EVENT.MAIN_VISIBILITY_WATCHDOG_MISMATCH, {
            reason,
            probe: probe === 'timeout' ? 'timeout' : {
              visibilityState: probe.visibilityState,
              rafAlive: probe.rafAlive,
              hasFocus: probe.hasFocus
            },
            consecutiveMismatches: state.consecutiveMismatches
          })
          break
        case 'nudge-throttle-toggle':
          performanceTrace.record(PERF_TRACE_EVENT.MAIN_VISIBILITY_WATCHDOG_NUDGE, { level: 1, kind: 'throttle-toggle' })
          applyThrottleToggleNudge(win)
          scheduleRecheck(POST_NUDGE_RECHECK_MS)
          break
        case 'nudge-hide-show':
          performanceTrace.record(PERF_TRACE_EVENT.MAIN_VISIBILITY_WATCHDOG_NUDGE, { level: 2, kind: 'hide-show' })
          applyHideShowNudge(win)
          scheduleRecheck(POST_NUDGE_RECHECK_MS)
          break
        case 'record-recovered':
          performanceTrace.record(PERF_TRACE_EVENT.MAIN_VISIBILITY_WATCHDOG_RECOVERED, {
            reason,
            recoveries: state.recoveries,
            recoveredFrom: prevStatus
          })
          broadcastRecoveryPush(reason)
          break
        case 'record-gave-up':
          // Registry-wise this rides the NUDGE event with a terminal phase —
          // a distinct name would only ever fire back-to-back with it.
          performanceTrace.record(PERF_TRACE_EVENT.MAIN_VISIBILITY_WATCHDOG_NUDGE, {
            level: 2,
            kind: 'gave-up',
            cooldownMs: 5 * 60_000
          })
          break
      }
    }
  } finally {
    checkInFlight = false
  }
}

export function startVisibilityWatchdog(getWindow: GetMainWindow): void {
  if (checkTimer) return
  getMainWindow = getWindow

  ipcMain.on(IPC.SYSTEM_VISIBILITY_PROBE_RESULT, (_event, probeId: string, reply: VisibilityProbeReply) => {
    const resolve = pendingProbes.get(probeId)
    if (resolve) resolve(reply)
  })

  checkTimer = setInterval(() => void runCheck('interval'), CHECK_INTERVAL_MS)
  checkTimer.unref()

  const onPowerEvent = () => {
    setTimeout(() => void runCheck('power-event'), EVENT_CHECK_DELAY_MS).unref()
  }
  powerMonitor.on('resume', onPowerEvent)
  powerMonitor.on('unlock-screen', onPowerEvent)

  const onDisplayEvent = () => {
    setTimeout(() => void runCheck('display-event'), EVENT_CHECK_DELAY_MS).unref()
  }
  screen.on('display-added', onDisplayEvent)
  screen.on('display-removed', onDisplayEvent)
  screen.on('display-metrics-changed', onDisplayEvent)
}

export function stopVisibilityWatchdog(): void {
  if (checkTimer) {
    clearInterval(checkTimer)
    checkTimer = null
  }
  if (pendingRecheck) {
    clearTimeout(pendingRecheck)
    pendingRecheck = null
  }
  ipcMain.removeAllListeners(IPC.SYSTEM_VISIBILITY_PROBE_RESULT)
}
