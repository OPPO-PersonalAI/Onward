/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 *
 * GPU REAL-kill recovery suite (GRK-01..07). Unlike the simulated
 * gpu-process-gone broadcast (TFA-21..23), this SIGKILLs the actual GPU
 * helper by pid (DEBUG_KILL_GPU_PROCESS), exercising Chromium's genuine
 * child-process-gone -> GPU respawn -> recovery chain: real context death,
 * real texture loss, real respawn timing.
 *
 * Contract under test (mirrors the simulated suite, now against reality):
 *   kill #1 -> child-process-gone observed -> GPU pid CHANGES (respawn) ->
 *   two-phase recovery converges -> WebGL renderable again;
 *   kill #2 -> the session fuse (N=2) sticks terminals to the DOM renderer,
 *   the TabBar banner appears, the app stays alive and readable.
 *
 * Exactly TWO kills per app session: the fuse is one-way AND Chromium's own
 * ~3-crash ladder would drop the whole app to software raster — in-session
 * repetition is impossible by design, so the RUNNER aggregates across K=3
 * full app launches instead (boolean correctness, all launches must pass).
 */

import type { AutotestContext, TestResult } from './types'
import { findWebglSurface, readWebglPixels, hasRenderablePixels } from './webgl-probe-utils'

const RECOVERY_TIMEOUT_MS = 10_000
const RECOVERY_POLL_MS = 120
const FUSE_TIMEOUT_MS = 8_000

export async function testGpuRealKillRecovery(ctx: AutotestContext): Promise<TestResult[]> {
  const { log, sleep, waitFor, assert, cancelled, terminalId } = ctx
  const results: TestResult[] = []
  const record = (name: string, ok: boolean, detail?: Record<string, unknown>) => {
    assert(name, ok, detail)
    results.push({ name, ok, detail })
  }

  log('gpu-real-kill-recovery-test:start')

  const repro = (window as unknown as {
    __blankTaskRepro?: { getSessionDebugState: (id: string) => unknown }
  }).__blankTaskRepro
  const sessionState = () =>
    (repro?.getSessionDebugState(terminalId) ?? null) as { webglActive?: boolean } | null

  const gpuPid = async (): Promise<number | null> => {
    const metrics = await window.electronAPI.debug.getAppMetrics()
    const gpu = metrics.find((m) => (m as { type?: string }).type === 'GPU') as
      | { pid?: number }
      | undefined
    return typeof gpu?.pid === 'number' ? gpu.pid : null
  }

  // Without preserveDrawingBuffer an IDLE terminal's backbuffer reads all
  // zeros between frames — renderable pixels are only observable while
  // xterm is actively redrawing. Keep output flowing through every probe
  // window (~10 s of slow lines per stream).
  const isWindows = window.electronAPI.platform === 'win32'
  const streamCmd = (tag: string) => (isWindows
    ? `for ($i=0; $i -lt 200; $i++) { Write-Output ${tag}-$i; Start-Sleep -Milliseconds 50 }\r`
    : `for i in $(seq 1 200); do echo ${tag}-$i; sleep 0.05; done\r`)

  // GRK-01: baseline — a live WebGL surface with renderable pixels and a
  // known GPU pid, probed while content flows.
  const pidBefore = await gpuPid()
  await window.electronAPI.terminal.write(terminalId, streamCmd('grk-baseline'))
  const baselineRenderable = await waitFor(
    'grk-01-baseline-renderable',
    () => {
      const surface = findWebglSurface(terminalId)
      return Boolean(surface && hasRenderablePixels(readWebglPixels(surface.gl)))
    },
    RECOVERY_TIMEOUT_MS,
    RECOVERY_POLL_MS
  )
  const debugSurface = findWebglSurface(terminalId)
  const debugStats = debugSurface ? readWebglPixels(debugSurface.gl) : null
  record('GRK-01-baseline-webgl-renderable', baselineRenderable && pidBefore !== null, {
    pidBefore,
    baselineRenderable,
    surfaceFound: debugSurface !== null,
    canvasW: debugSurface?.canvas.width ?? null,
    canvasH: debugSurface?.canvas.height ?? null,
    maxChannel: debugStats?.maxChannel ?? null,
    intensityVariance: debugStats?.intensityVariance ?? null,
    nonZeroRatio: debugStats?.nonZeroRatio ?? null,
    webglActive: sessionState()?.webglActive ?? null
  })
  if (!baselineRenderable || pidBefore === null || cancelled()) {
    log('gpu-real-kill-recovery-test:done')
    return results
  }

  // GRK-02: REALLY kill the GPU process.
  const kill1 = await window.electronAPI.debug.killGpuProcess()
  record('GRK-02-first-kill-delivered', kill1.success === true && kill1.pid === pidBefore, {
    kill1
  })

  // GRK-03: Chromium respawns the GPU process — the pid must CHANGE.
  let pidAfter: number | null = null
  const respawned = await waitFor(
    'grk-03-gpu-respawn',
    () => {
      void gpuPid().then((pid) => { pidAfter = pid })
      return pidAfter !== null && pidAfter !== pidBefore
    },
    RECOVERY_TIMEOUT_MS,
    RECOVERY_POLL_MS
  )
  record('GRK-03-gpu-process-respawned', respawned, { pidBefore, pidAfter })

  // GRK-04: recovery converges — WebGL active again with renderable pixels
  // against the RESPAWNED process (fresh stream so the probe can see paint).
  await window.electronAPI.terminal.write(terminalId, streamCmd('grk-recovered'))
  const recovered = await waitFor(
    'grk-04-recovery-renderable',
    () => {
      if (sessionState()?.webglActive !== true) return false
      const surface = findWebglSurface(terminalId)
      return Boolean(surface && hasRenderablePixels(readWebglPixels(surface.gl)))
    },
    RECOVERY_TIMEOUT_MS,
    RECOVERY_POLL_MS
  )
  record('GRK-04-recovery-webgl-renderable', recovered, {
    webglActive: sessionState()?.webglActive
  })
  if (cancelled()) return results

  // GRK-05: second real kill blows the session fuse — sticky DOM renderer.
  await sleep(300)
  const kill2 = await window.electronAPI.debug.killGpuProcess()
  const stuckToDom = await waitFor(
    'grk-05-sticky-dom',
    () => sessionState()?.webglActive === false,
    FUSE_TIMEOUT_MS,
    RECOVERY_POLL_MS
  )
  record('GRK-05-second-kill-blows-fuse', Boolean(kill2.success) && stuckToDom, {
    kill2,
    stuckToDom
  })

  // GRK-06: degraded but ALIVE — the DOM renderer shows the live buffer and
  // the TabBar banner is up.
  const cell = document.querySelector<HTMLElement>('.terminal-grid-cell')
  const domRows = cell?.querySelector<HTMLElement>('.xterm-rows')?.textContent ?? ''
  const banner = document.querySelector<HTMLElement>('[data-testid="gpu-fallback-banner"]')
  record('GRK-06-degraded-but-alive', domRows.trim().length > 0 && banner !== null, {
    domRowsLength: domRows.trim().length,
    bannerVisible: banner !== null,
    bannerText: (banner?.textContent ?? '').slice(0, 120)
  })

  // GRK-07: the fuse holds — a host surface event must not resurrect WebGL.
  const terminalApi = (window as unknown as {
    __onwardTerminalDebug?: { notifyHostSurfaceEvent?: (reason: string) => void }
  }).__onwardTerminalDebug
  terminalApi?.notifyHostSurfaceEvent?.('document-visible')
  await sleep(400)
  record('GRK-07-fuse-holds-after-surface-event', sessionState()?.webglActive === false, {
    webglActive: sessionState()?.webglActive
  })

  log('gpu-real-kill-recovery-test:done')
  return results
}
