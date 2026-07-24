/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 *
 * Wake-park GPU-crash SOAK (GWS-01..03) — the evidence-derived reproducer.
 *
 * All three real ANGLE-Metal crashes observed on 2026-07-23 shared one
 * recipe: document hidden for >=17 s WITH live PTY output flowing during
 * the park, 6 keep-alive WebGL sessions, then a render-pipeline flip at the
 * occlusion boundary (wake+focus, or a throttle toggle while hidden) —
 * crash 4-30 ms after the flip. Zero-output parks never crashed. This suite
 * arranges the renderer side of that recipe (live PTY emitters into the
 * visible terminals — REAL main->renderer pty.output flow; hidden-page
 * timer throttling makes renderer-side injection loops unreliable, which is
 * why the emitters are real shell commands), then hands control to the
 * main-process soak loop (DEBUG_RUN_GPU_WAKE_PARK_SOAK).
 *
 * MEASUREMENT harness: the gate is harness completion, never the crash
 * count. `MEASURE gpu-wake-park-soak …` is the A/B comparison line; the
 * runner adds .ips ANGLE-signature verification per session. NOT part of
 * the full-regression SCRIPTS (a session runs many minutes by design).
 */

import type { AutotestContext, TestResult } from './types'

// Bounded (not `while true`) so the emitter self-terminates even if the
// stop-Ctrl-C is missed — an unbounded emitter left running would stall the
// app's quit-time PTY teardown. 100000 iters @ 20 ms ≈ 33 min covers any
// soak session length; the suite Ctrl-C's it as soon as the soak returns.
const OUTPUT_CMD_POSIX =
  'for i in $(seq 1 100000); do head -c 200 /dev/urandom | base64; sleep 0.02; done'
const OUTPUT_CMD_POWERSHELL =
  'for ($i=0; $i -lt 100000; $i++) { -join ((48..57)+(65..90)+(97..122) | Get-Random -Count 200 | ForEach-Object {[char]$_}); Start-Sleep -Milliseconds 20 }'

export async function testGpuWakeParkSoak(ctx: AutotestContext): Promise<TestResult[]> {
  const { log, sleep, assert, terminalId } = ctx
  const results: TestResult[] = []
  const record = (name: string, ok: boolean, detail?: Record<string, unknown>) => {
    assert(name, ok, detail)
    results.push({ name, ok, detail })
  }

  log('gpu-wake-park-soak-test:start')

  // GWS-01: start a live output emitter in the focused terminal so genuine
  // pty.output flows during every hidden park (the load-bearing recipe
  // ingredient — zero-output parks never crashed in any incident trace).
  const isWindows = window.electronAPI.platform === 'win32'
  const cmd = isWindows ? OUTPUT_CMD_POWERSHELL : OUTPUT_CMD_POSIX
  const wrote = await window.electronAPI.terminal.write(terminalId, cmd + '\r')
  await sleep(1_500)
  record('GWS-01-output-emitter-started', wrote === true, { terminalId, isWindows })

  // GWS-02: run the main-process soak loop (parks + wakes + optional
  // mid-park throttle flips; stop-on-first-crash by default).
  const result = await window.electronAPI.debug.runGpuWakeParkSoak()
  record('GWS-02-soak-completed', result.success === true && (result.cycles ?? 0) > 0, {
    success: result.success,
    error: result.error ?? null,
    cycles: result.cycles,
    requestedCycles: result.requestedCycles,
    params: result.params
  })

  // GWS-03: measurement well-formed.
  const wellFormed =
    typeof result.gpuCrashes === 'number' &&
    typeof result.durationMs === 'number' &&
    (result.firstCrashAtCycle === null || typeof result.firstCrashAtCycle === 'number')
  record('GWS-03-measurement-well-formed', wellFormed, {
    gpuCrashes: result.gpuCrashes,
    firstCrashAtCycle: result.firstCrashAtCycle,
    parkMsAtCrash: result.parkMsAtCrash
  })

  log(
    `MEASURE gpu-wake-park-soak cycles=${result.cycles} crashes=${result.gpuCrashes} ` +
      `firstCrashAtCycle=${result.firstCrashAtCycle ?? 'none'} ` +
      `parkMsAtCrash=${result.parkMsAtCrash ?? 'none'} ` +
      `params=${JSON.stringify(result.params)} durationMs=${result.durationMs}`
  )

  // Stop the emitter (Ctrl-C) so quit teardown is clean.
  await window.electronAPI.terminal.write(terminalId, '\u0003')
  await sleep(300)

  log('gpu-wake-park-soak-test:done')
  return results
}
