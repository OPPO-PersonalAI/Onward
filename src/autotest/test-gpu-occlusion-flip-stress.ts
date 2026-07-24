/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 *
 * GPU occlusion-flip stress (BUG-0003 Electron-upgrade baseline harness).
 *
 * The ANGLE-Metal GPU-process crash (imported by the 2026-04-08 Electron
 * 35→39 bump, commit 532fe49) is a low-probability event triggered by
 * render-pipeline state flips at occlusion boundaries — the two observed
 * antecedents are wake-from-background (+30 ms) and a backgroundThrottling
 * toggle on an occluded window (+14 ms). This suite drives N real
 * hide/showInactive cycles plus periodic throttling toggles from the main
 * process and counts genuine GPU child-process-gone events.
 *
 * MEASUREMENT harness, not a pass/fail gate on the crash count:
 *   GFS-01 asserts the harness completed;
 *   GFS-02 asserts the measurement fields are well-formed;
 *   the crash count itself is logged as `[AutoTest] MEASURE ...` — compare
 *   it across Electron versions (39.8.5 baseline vs the 43.x candidate)
 *   with identical cycle counts before shipping any Electron bump.
 *
 * Caveats: the window visibly flickers for the duration (~35 s at the
 * default 150 cycles); if real crashes occur, the session GPU-crash fuse
 * (N=2) will stick terminals to the DOM renderer — expected, and part of
 * why a crash during the stress does not fail the suite. macOS is the
 * platform where the crash class exists; the harness itself is
 * platform-neutral so Windows/Linux runs simply measure zero.
 */

import type { AutotestContext, TestResult } from './types'

export async function testGpuOcclusionFlipStress(ctx: AutotestContext): Promise<TestResult[]> {
  const { assert, log } = ctx
  const results: TestResult[] = []
  const record = (name: string, ok: boolean, detail?: Record<string, unknown>) => {
    assert(name, ok, detail)
    results.push({ name, ok, detail })
  }

  log('gpu-occlusion-flip-stress-test:start')

  // 0 → the main-side handler resolves ONWARD_GPU_FLIP_STRESS_CYCLES or
  // its built-in default (150).
  const result = await window.electronAPI.debug.runOcclusionFlipStress(0)

  record('GFS-01-harness-completed', result.success === true && (result.cycles ?? 0) > 0, {
    success: result.success,
    error: result.error ?? null,
    cycles: result.cycles,
    requestedCycles: result.requestedCycles
  })

  const wellFormed =
    typeof result.gpuCrashes === 'number' &&
    typeof result.durationMs === 'number' &&
    (result.firstCrashAtCycle === null || typeof result.firstCrashAtCycle === 'number')
  record('GFS-02-measurement-well-formed', wellFormed, {
    gpuCrashes: result.gpuCrashes,
    firstCrashAtCycle: result.firstCrashAtCycle,
    durationMs: result.durationMs
  })

  // The measurement line the baseline/upgrade comparison greps for.
  log(
    `MEASURE gpu-flip-stress cycles=${result.cycles} crashes=${result.gpuCrashes} ` +
      `firstCrashAtCycle=${result.firstCrashAtCycle ?? 'none'} durationMs=${result.durationMs}`
  )

  log('gpu-occlusion-flip-stress-test:done')
  return results
}
