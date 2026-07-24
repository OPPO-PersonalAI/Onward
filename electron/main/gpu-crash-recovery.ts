/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 *
 * GPU-process crash recovery broadcast.
 *
 * Electron 39.x on Apple Silicon hits a deterministic ANGLE-Metal GPU
 * process crash on desktop (Space) switch compositing (same SIGTRAP stack
 * on 2026-07-13 and 2026-07-14 user crash reports; electron#49904 class).
 * When the GPU process dies, every compositor layer is lost and the window
 * shows a white placeholder until Chromium respawns the process — and, on
 * this crash path, Chromium does NOT deliver `webglcontextlost` to the
 * page, so the renderer's own context-loss fallback never wakes up and the
 * terminals' WebGL canvases recover only by luck.
 *
 * This module closes that gap: the main process observes
 * `app.on('child-process-gone')` (type 'GPU') and broadcasts to every
 * window; the renderer force-recreates all visible terminals' WebGL
 * contexts against the respawned GPU process. Shared as a module so the
 * production listener (index.ts) and the autotest simulate hook
 * (ipc-handlers.ts) drive the exact same broadcast path.
 */

import { BrowserWindow } from 'electron'
import { IPC } from '../shared/ipc-channels'
import { performanceTrace } from './performance-trace'
import { PERF_TRACE_EVENT } from '../../src/utils/perf-trace-names'
import { getWindowActivitySnapshot } from './visibility-watchdog'

export interface GpuProcessGoneInfo {
  reason: string
  exitCode: number
  simulated?: boolean
}

/**
 * Record the crash and notify every live renderer. Returns the number of
 * windows notified (0 when all windows are gone, e.g. during quit).
 */
export interface GpuProcessGoneBroadcastResult {
  notified: number
  activity: ReturnType<typeof getWindowActivitySnapshot>
}

export function broadcastGpuProcessGone(info: GpuProcessGoneInfo): GpuProcessGoneBroadcastResult {
  // Crash-antecedent correlation (BUG-0003 P0): the 2026-07-23 episodes
  // needed manual timeline reconstruction to discover that one crash
  // followed a wake by 30 ms and another followed a watchdog throttle
  // toggle by 14 ms. Carry the adjacency in the crash event itself — and
  // return it so trace and telemetry share IDENTICAL values.
  const activity = getWindowActivitySnapshot()
  performanceTrace.record(PERF_TRACE_EVENT.MAIN_GPU_PROCESS_GONE, {
    reason: info.reason,
    exitCode: info.exitCode,
    simulated: Boolean(info.simulated),
    msSinceLastWindowShow: activity.msSinceLastWindowShow,
    msSinceLastWindowFocus: activity.msSinceLastWindowFocus,
    msSinceLastThrottleToggle: activity.msSinceLastThrottleToggle,
    msSinceLastNudge: activity.msSinceLastNudge
  })

  let notified = 0
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed() || win.webContents.isDestroyed()) continue
    try {
      win.webContents.send(IPC.SYSTEM_GPU_PROCESS_GONE, {
        reason: info.reason,
        exitCode: info.exitCode,
        simulated: Boolean(info.simulated)
      })
      notified += 1
    } catch {
      // The frame can be torn down between the isDestroyed() check and the
      // send (observed during app quit: "Render frame was disposed before
      // WebFrameMain could be accessed"). A dying window does not need the
      // recovery broadcast.
    }
  }
  return { notified, activity }
}
