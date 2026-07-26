/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Shell-integration liveness → renderer hint E2E (G3) + 6-terminal
 * false-silent storm (G4), 2026-07-24 review of the windows-powershell-bug
 * merge.
 *
 * Runner contract (run-terminal-liveness-hint-autotest.{sh,ps1}):
 *   - ONWARD_SHELL_INTEGRATION=0    → no integration injection, no cwd OSC
 *   - ONWARD_LIVENESS_WINDOW_MS=1500 → deterministic sub-2s silent verdict
 *
 * Chain under test: liveness timer (main) → silent trace + IPC → TerminalGrid
 * hint badge → verified change-workdir writes its own proof OSC → main marks
 * shell proof → recovered IPC → hint clears. The unit layer
 * (shell-integration-liveness.test.mts) locks the state machine with injected
 * clocks; THIS suite locks the wiring the unit layer cannot see.
 *
 * Environment guard: a user shell profile that emits its own cwd OSC (e.g.
 * oh-my-posh) would legitimately prove liveness and no hint would ever
 * appear. The suite taps terminal data and downgrades to a documented skip
 * in that case instead of reporting a false failure.
 */

import type { AutotestContext, TestResult } from './types'

const HINT_SELECTOR = '.terminal-grid-integration-hint'
const SIX_LAYOUT_SELECTOR = 'button[title="Six terminals"], button[title="Six-grid"]'

export async function testTerminalLivenessHint(ctx: AutotestContext): Promise<TestResult[]> {
  const { assert, cancelled, log, rootPath, sleep, terminalId, waitFor } = ctx
  const results: TestResult[] = []
  const record = (name: string, ok: boolean, detail?: Record<string, unknown>) => {
    assert(name, ok, detail)
    results.push({ name, ok, detail })
  }

  const hintCount = () => document.querySelectorAll(HINT_SELECTOR).length

  // Environment probe: watch the raw PTY stream for shell-emitted cwd OSC
  // dialects (633 / 7 / 9;9). Any hit means this machine's shell profile
  // proves liveness on its own and the silent path cannot fire.
  let environmentEmitsCwdOsc = false
  const unsubscribeOscProbe = window.electronAPI.terminal.onData((_termId, data) => {
    if (/\x1b\](?:633;|7;|9;9;)/.test(data)) environmentEmitsCwdOsc = true
  })

  try {
    log('terminal-liveness-hint:start', { rootPath })

    const debugApi = () => window.__onwardTerminalDebug
    const apiReady = await waitFor('liveness-debug-api', () => Boolean(debugApi()), 8000)
    record('LVH-00-debug-api', apiReady, { available: apiReady })
    if (!apiReady || cancelled()) return results

    const sessionReady = await waitFor('liveness-first-session-ready', () => {
      const state = debugApi()!.getSessionState(terminalId)
      return Boolean(state?.status === 'ready' && state.open)
    }, 12000, 120)
    record('LVH-01-first-session-ready', sessionReady, {})
    if (!sessionReady || cancelled()) return results

    // G4 storm setup: expand to the six-terminal preset so SIX default-shell
    // spawns arm six independent liveness windows near-simultaneously.
    const sixButton = document.querySelector<HTMLButtonElement>(SIX_LAYOUT_SELECTOR)
    sixButton?.click()
    record('LVH-02-six-layout-clicked', Boolean(sixButton), { found: Boolean(sixButton) })
    if (!sixButton || cancelled()) return results

    // All six hints must appear (window 1.5 s + spawn cost; generous ceiling).
    const allHints = await waitFor('liveness-six-hints', () => hintCount() === 6, 30_000, 200)
    if (!allHints && environmentEmitsCwdOsc) {
      // Documented environmental skip — NOT a product failure: the machine's
      // own shell config emits cwd OSC, so integration is genuinely proven.
      record('LVH-03-six-silent-hints', true, {
        skipped: 'environment-emits-cwd-osc',
        hintCount: hintCount()
      })
      log('terminal-liveness-hint:skip', { reason: 'environment-emits-cwd-osc' })
      return results
    }
    record('LVH-03-six-silent-hints', allHints, {
      hintCount: hintCount(),
      environmentEmitsCwdOsc
    })
    if (!allHints || cancelled()) return results

    // Storm containment: exactly six hints (no duplicates), and the renderer
    // stays interactive — a real shell round-trip completes under pressure.
    await sleep(400)
    record('LVH-04-no-duplicate-hints', hintCount() === 6, { hintCount: hintCount() })

    const marker = `__LIVENESS_ALIVE_${Date.now()}__`
    await window.electronAPI.terminal.write(terminalId, `echo ${marker}\r`)
    const responsive = await waitFor('liveness-responsive-echo', () => {
      return (debugApi()!.getTailText(terminalId, 20) ?? '').includes(marker)
    }, 8000, 120)
    record('LVH-05-renderer-responsive-under-storm', responsive, { marker })

    // G3 recovery: the verified change-workdir command carries its own proof
    // OSC (policy-immune command mode) — the arriving proof must flip THIS
    // terminal to recovered and clear exactly one hint.
    const outcome = await window.electronAPI.terminal.changeWorkDirVerified(terminalId, rootPath)
    record('LVH-06-verified-cd-succeeds-without-integration', outcome.success === true, { outcome })

    const oneCleared = await waitFor('liveness-hint-cleared', () => hintCount() === 5, 8000, 120)
    record('LVH-07-recovered-clears-exactly-one-hint', oneCleared, { hintCount: hintCount() })

    // The other five terminals got no proof — their hints must persist well
    // past another full liveness window (no cross-terminal clearing).
    await sleep(2500)
    record('LVH-08-unproven-hints-persist', hintCount() === 5, { hintCount: hintCount() })
  } finally {
    unsubscribeOscProbe()
  }

  log('terminal-liveness-hint:done', {
    total: results.length,
    passed: results.filter(result => result.ok).length,
    failed: results.filter(result => !result.ok).length
  })

  return results
}
