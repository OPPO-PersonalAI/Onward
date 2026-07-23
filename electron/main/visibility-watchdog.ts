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
 *  - scheduling: a slow 30 s interval as the safety net, immediate checks
 *    after powerMonitor resume / unlock-screen and screen display events,
 *    and — since BUG-0002 — an immediate cooldown-bypassing check on
 *    window focus/show and on preload input-while-hidden reports, so a
 *    stuck renderer is re-judged the moment the user can see the window
 *    instead of after the 30 s interval + 300 s cooldown;
 *  - nudges: level 1 toggles backgroundThrottling off/on, level 2 hides and
 *    re-shows the window. Since BUG-0002 both rungs run ONLY when the
 *    verdict model says the user can see the window: nudging occluded
 *    windows false-positively is what the pre-fix model did, and it was
 *    actively harmful — the throttle toggle is a known Electron
 *    visibility-desync trigger on occluded windows (electron#50250), one
 *    L1 nudge preceded an ANGLE-Metal GPU-process crash by 14 ms
 *    (2026-07-23 compound episode), and hide-show evicted the compositor
 *    frame while twice jamming the document into the stuck-hidden state;
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
/**
 * Debounce after window focus/show before probing: Chromium's visibility
 * evaluation lags the native focus by up to a few hundred ms; probing too
 * early would read a legitimate transient 'hidden'.
 */
const FOCUS_CHECK_DELAY_MS = 300
/**
 * When a focus/input-triggered check sees its FIRST mismatch (below the
 * 2-consecutive threshold), confirm after this short delay instead of the
 * 30 s interval — target is nudging a genuinely stuck window within ~2 s
 * of the user looking at it (the second ladder in the 2026-07-23 episode
 * recovered in 2 s once it finally ran).
 */
const USER_PRESENT_RECHECK_MS = 1_000

type VisibilityCheckReason =
  | 'interval'
  | 'power-event'
  | 'display-event'
  | 'post-nudge'
  | 'focus-event'
  | 'input-report'

type GetMainWindow = () => BrowserWindow | null

let state: VisibilityWatchState = initialVisibilityWatchState()
let getMainWindow: GetMainWindow = () => null
let checkTimer: ReturnType<typeof setInterval> | null = null
let pendingRecheck: ReturnType<typeof setTimeout> | null = null
let checkInFlight = false
let probeSeq = 0
const pendingProbes = new Map<string, (reply: VisibilityProbeReply | 'timeout') => void>()
const listenerAttachedWindows = new WeakSet<BrowserWindow>()

/**
 * Window-activity timestamps for GPU-crash correlation (BUG-0003 P0):
 * every `main:gpu.process-gone` carries msSince* of the last
 * render-pipeline state flip so crash antecedents no longer need manual
 * timeline reconstruction.
 */
let lastWindowShowAt: number | null = null
let lastWindowFocusAt: number | null = null
let lastThrottleToggleAt: number | null = null
let lastNudgeAt: number | null = null
/** True while the L2 hide-show nudge itself is mutating window state. */
let nudgeMutationInProgress = false

export function getVisibilityHealthSnapshot(): {
  status: 'ok' | 'nudging' | 'gave-up'
  recoveries: number
} {
  return { status: state.status, recoveries: state.recoveries }
}

export interface WindowActivitySnapshot {
  msSinceLastWindowShow: number | null
  msSinceLastWindowFocus: number | null
  msSinceLastThrottleToggle: number | null
  msSinceLastNudge: number | null
}

export function getWindowActivitySnapshot(nowMs: number = Date.now()): WindowActivitySnapshot {
  const since = (t: number | null): number | null => (t === null ? null : Math.max(0, nowMs - t))
  return {
    msSinceLastWindowShow: since(lastWindowShowAt),
    msSinceLastWindowFocus: since(lastWindowFocusAt),
    msSinceLastThrottleToggle: since(lastThrottleToggleAt),
    msSinceLastNudge: since(lastNudgeAt)
  }
}

function recordWindowLifecycle(win: BrowserWindow, event: string): void {
  try {
    performanceTrace.record(PERF_TRACE_EVENT.MAIN_WINDOW_LIFECYCLE, {
      event,
      isVisible: win.isVisible(),
      isFocused: win.isFocused(),
      isMinimized: win.isMinimized(),
      trigger: nudgeMutationInProgress ? 'watchdog-nudge' : 'user'
    })
  } catch {
    // Window torn down mid-query; a missing breadcrumb is acceptable.
  }
}

function ensureWindowListeners(win: BrowserWindow): void {
  if (listenerAttachedWindows.has(win)) return
  listenerAttachedWindows.add(win)

  const onUserPresence = (event: 'focus' | 'show') => {
    if (event === 'show') lastWindowShowAt = Date.now()
    else lastWindowFocusAt = Date.now()
    recordWindowLifecycle(win, event)
    // The nudge's own hide/show must not re-trigger a check loop.
    if (nudgeMutationInProgress) return
    scheduleRecheck(FOCUS_CHECK_DELAY_MS, 'focus-event')
  }
  win.on('focus', () => onUserPresence('focus'))
  win.on('show', () => onUserPresence('show'))
  win.on('blur', () => recordWindowLifecycle(win, 'blur'))
  win.on('hide', () => recordWindowLifecycle(win, 'hide'))
  win.on('minimize', () => recordWindowLifecycle(win, 'minimize'))
  win.on('restore', () => recordWindowLifecycle(win, 'restore'))
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

function scheduleRecheck(delayMs: number, reason: VisibilityCheckReason): void {
  if (pendingRecheck) clearTimeout(pendingRecheck)
  pendingRecheck = setTimeout(() => {
    pendingRecheck = null
    void runCheck(reason)
  }, delayMs)
  pendingRecheck.unref()
}

function applyThrottleToggleNudge(win: BrowserWindow): void {
  lastThrottleToggleAt = Date.now()
  try {
    win.webContents.setBackgroundThrottling(false)
    const restore = setTimeout(() => {
      try {
        if (!win.isDestroyed()) {
          lastThrottleToggleAt = Date.now()
          win.webContents.setBackgroundThrottling(true)
        }
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
  nudgeMutationInProgress = true
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
  } finally {
    nudgeMutationInProgress = false
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

async function runCheck(reason: VisibilityCheckReason): Promise<void> {
  if (checkInFlight) {
    // A probe can be in flight for up to 3 s; dropping a user-presence
    // check here would push the retry to the 30 s interval. Requeue instead.
    scheduleRecheck(250, reason)
    return
  }
  const win = getMainWindow()
  if (!win || win.isDestroyed() || win.webContents.isDestroyed()) return
  ensureWindowListeners(win)
  checkInFlight = true

  try {
    const windowVisible = win.isVisible() && !win.isMinimized()
    const windowFocused = win.isFocused()
    const probe = windowVisible ? await sendProbe(win) : 'timeout'
    const verdict = judgeVisibilityProbe({ windowVisible, windowFocused, probe })
    const userPresenceCheck = reason === 'focus-event' || reason === 'input-report'
    const prevState = state
    const { next, actions } = reduceVisibilityCheck(state, verdict, Date.now(), {
      bypassCooldown: userPresenceCheck
    })
    state = next

    if (verdict === 'mismatch' || prevState.status !== 'ok') {
      performanceTrace.record(PERF_TRACE_EVENT.MAIN_VISIBILITY_WATCHDOG_CHECK_VERDICT, {
        reason,
        verdict,
        windowVisible,
        windowFocused,
        probe: probe === 'timeout' ? 'timeout' : {
          visibilityState: probe.visibilityState,
          rafAlive: probe.rafAlive,
          hasFocus: probe.hasFocus
        },
        consecutiveMismatches: state.consecutiveMismatches,
        status: state.status
      })
    }
    if (reason === 'post-nudge') {
      performanceTrace.record(PERF_TRACE_EVENT.MAIN_VISIBILITY_WATCHDOG_NUDGE_OUTCOME, {
        level: prevState.nudgeLevel,
        verdictAfter: verdict,
        status: state.status
      })
    }

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
          lastNudgeAt = Date.now()
          performanceTrace.record(PERF_TRACE_EVENT.MAIN_VISIBILITY_WATCHDOG_NUDGE, { level: 1, kind: 'throttle-toggle' })
          applyThrottleToggleNudge(win)
          scheduleRecheck(POST_NUDGE_RECHECK_MS, 'post-nudge')
          break
        case 'nudge-hide-show':
          lastNudgeAt = Date.now()
          performanceTrace.record(PERF_TRACE_EVENT.MAIN_VISIBILITY_WATCHDOG_NUDGE, { level: 2, kind: 'hide-show' })
          applyHideShowNudge(win)
          scheduleRecheck(POST_NUDGE_RECHECK_MS, 'post-nudge')
          break
        case 'record-recovered':
          performanceTrace.record(PERF_TRACE_EVENT.MAIN_VISIBILITY_WATCHDOG_RECOVERED, {
            reason,
            recoveries: state.recoveries,
            recoveredFrom: prevState.status
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

    // A user-presence check that sees its first mismatch must not wait for
    // the 30 s interval to confirm: schedule the threshold-completing
    // recheck in 1 s so a genuinely stuck window is nudged within ~2 s.
    if (userPresenceCheck && verdict === 'mismatch' && actions.length === 0 && state.status === 'ok') {
      scheduleRecheck(USER_PRESENT_RECHECK_MS, reason)
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

  // Preload-side self-report: user input landed on a hidden document. The
  // strongest possible "user is looking at a dead window" signal — check
  // immediately with the cooldown bypassed (throttled to 1/5 s in preload).
  ipcMain.on(IPC.SYSTEM_VISIBILITY_INPUT_WHILE_HIDDEN, (_event, info: { hasFocus?: boolean }) => {
    performanceTrace.record(PERF_TRACE_EVENT.MAIN_VISIBILITY_WATCHDOG_INPUT_REPORT, {
      hasFocus: Boolean(info?.hasFocus)
    })
    void runCheck('input-report')
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
  ipcMain.removeAllListeners(IPC.SYSTEM_VISIBILITY_INPUT_WHILE_HIDDEN)
}
