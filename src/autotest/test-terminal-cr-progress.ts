/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Terminal CR-progress smoke test.
 *
 * Drives a high-volume `<text>\x1b[K\r` redraw burst (the same
 * pattern `git clone --progress` emits) into a Task PTY via the
 * fixture replay script, then asserts the resulting xterm buffer
 * collapses every progress phase to its final state — i.e. the
 * parser and pipeline never split a redraw across writes badly
 * enough to leave intermediate states stranded in the buffer.
 *
 * Honest scope note: this is a SMOKE TEST for the new VS Code-aligned
 * pipeline, not a regression lock for the original user-reported
 * visual bug. We could not reproduce the user's "scrolling progress
 * lines" symptom in autotest mode (buffer state was identical with
 * the new pipeline and the old one in side-by-side runs), so the
 * actual visual regression is verified manually rather than by this
 * test. What this test DOES guarantee: any future change that
 * breaks the parser's handling of a sustained CR-progress burst
 * will fail here loudly.
 */
import type { AutotestContext, TerminalDebugApi, TestResult } from './types'

const TRIAL_COUNT = 5
const REPLAY_DONE_MARKER = '__TCR_REPLAY_DONE__'
// Allow time for the fixture replay (~360 KB synthetic burst →
// ~90 main-process onData chunks at the kernel's 4 KB pty pipe
// granularity). Empirically <5 s on macOS arm64 dev builds; 12 s
// gives generous headroom for scheduler hiccups.
const REPLAY_TIMEOUT_MS = 12000
// Each progress phase should collapse to exactly 1 line in the
// xterm buffer (the final `100% (n/n), done.` state). THRESHOLD=2
// is robust against incidental noise (e.g. xterm wrapping a 1-char
// remainder) without masking a regression that left N intermediate
// progress lines stranded.
const MAX_LINES_PER_PHASE = 2
// Phase markers to count. Each is the leading substring of a
// progress line emitted by the fixture (and by real git clone).
const PHASE_MARKERS = [
  'remote: Counting objects:',
  'remote: Compressing objects:',
  'Receiving objects:'
]

function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0
  let count = 0
  let from = 0
  while (true) {
    const idx = haystack.indexOf(needle, from)
    if (idx < 0) return count
    count += 1
    from = idx + needle.length
  }
}

export async function testTerminalCrProgress(ctx: AutotestContext): Promise<TestResult[]> {
  const { assert, cancelled, log, rootPath, sleep, terminalId, waitFor } = ctx
  const results: TestResult[] = []
  const record = (name: string, ok: boolean, detail?: Record<string, unknown>) => {
    assert(name, ok, detail)
    results.push({ name, ok, detail })
  }

  const debugApi = (): TerminalDebugApi | null => window.__onwardTerminalDebug ?? null
  const platform = window.electronAPI.platform
  const sep = platform === 'win32' ? '\\' : '/'
  // Match test-terminal-autofollow.ts: prefer ONWARD_AUTOTEST_CWD over
  // ctx.rootPath because some autotest invocations resolve rootPath to
  // the user's HOME, which would route the fixture lookup off-repo.
  const fixtureRootPath = window.electronAPI.debug.autotestCwd || rootPath
  const replayScriptPath = [
    fixtureRootPath, 'test', 'autotest', 'fixtures',
    'terminal-cr-progress', 'replay-fixture.mjs'
  ].join(sep)

  const apiReady = await waitFor('terminal-debug-api', () => Boolean(debugApi()), 8000)
  record('TCR-00-terminal-debug-api', apiReady, { available: apiReady })
  if (!apiReady || cancelled()) return results

  const api = debugApi()!
  const sessionReady = await waitFor('terminal-session-ready', () => {
    const state = api.getSessionState(terminalId)
    return Boolean(state?.status === 'ready' && state.open)
  }, 12000, 120)
  record('TCR-00a-terminal-session-ready', sessionReady, {
    sessionState: api.getSessionState(terminalId)
  })
  if (!sessionReady || cancelled()) return results

  // Probe the shell so subsequent commands run in a known-good state.
  await window.electronAPI.terminal.write(terminalId, 'echo __TCR_SHELL_READY__\r')
  const shellReady = await waitFor('terminal-shell-ready', () => {
    return (api.getTailText(terminalId, 40) ?? '').includes('__TCR_SHELL_READY__')
  }, 8000, 120)
  record('TCR-00b-terminal-shell-ready', shellReady, {
    tail: api.getTailText(terminalId, 40)
  })
  if (!shellReady || cancelled()) return results

  // 10 000-line tail spans the whole xterm scrollback so a failing
  // trial's scrolled progress lines remain inspectable.
  const TAIL_LINES_TO_READ = 10000

  const trials: Array<{
    perPhaseMatches: number[]
    replayCompleted: boolean
    ok: boolean
  }> = []

  for (let trial = 1; trial <= TRIAL_COUNT && !cancelled(); trial += 1) {
    log(`TCR-trial-${trial}:begin`, { trial })

    // Reset xterm buffer between trials so counts cannot accumulate.
    await window.electronAPI.terminal.write(terminalId, 'clear\r')
    await sleep(200)

    // The DONE marker is printed by the fixture script itself rather
    // than appended to the shell command, so the shell echo of the
    // typed command line cannot contain the matched string.
    const replayCommand = `node "${replayScriptPath}"\r`
    await window.electronAPI.terminal.write(terminalId, replayCommand)

    const replayDone = await waitFor(
      `tcr-trial-${trial}-replay-complete`,
      () => (api.getTailText(terminalId, TAIL_LINES_TO_READ) ?? '').includes(REPLAY_DONE_MARKER),
      REPLAY_TIMEOUT_MS,
      200
    )

    const bufferTail = api.getTailText(terminalId, TAIL_LINES_TO_READ) ?? ''
    const perPhaseMatches = PHASE_MARKERS.map((marker) =>
      countOccurrences(bufferTail, marker)
    )
    const allPhasesUnderThreshold = perPhaseMatches.every((n) => n <= MAX_LINES_PER_PHASE)
    const trialOk = replayDone && allPhasesUnderThreshold

    trials.push({ perPhaseMatches, replayCompleted: replayDone, ok: trialOk })
  }

  const okTrials = trials.filter((t) => t.ok).length
  const allPassed = okTrials === TRIAL_COUNT

  record('TCR-02-progress-redraws-collapsed-in-place', allPassed, {
    trialCount: TRIAL_COUNT,
    okTrials,
    threshold: MAX_LINES_PER_PHASE,
    phases: PHASE_MARKERS,
    perTrialMatches: trials.map((t) => t.perPhaseMatches),
    perTrialReplayCompleted: trials.map((t) => t.replayCompleted)
  })

  return results
}
