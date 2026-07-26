/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

import type { AutotestContext, TerminalDebugApi, TestResult } from './types'

export async function testTerminalAutofollow(ctx: AutotestContext): Promise<TestResult[]> {
  const { assert, cancelled, log, rootPath, sleep, terminalId, waitFor } = ctx
  const results: TestResult[] = []
  const record = (name: string, ok: boolean, detail?: Record<string, unknown>) => {
    assert(name, ok, detail)
    results.push({ name, ok, detail })
  }

  const debugApi = () => window.__onwardTerminalDebug
  const platform = window.electronAPI.platform
  const separator = platform === 'win32' ? '\\' : '/'
  // Prefer the explicit ONWARD_AUTOTEST_CWD env — in some environments the
  // Project Editor's rootPath resolves to the user's HOME instead of the
  // repo root (seen in the worktree's autotest invocations), which would
  // route the fixture lookup to ~/test/autotest/fixtures/... and fail immediately.
  const fixtureRootPath = window.electronAPI.debug.autotestCwd || rootPath
  const fixturePath = `${fixtureRootPath}${separator}test${separator}autotest${separator}fixtures${separator}terminal-autofollow-repro.mjs`
  const colorFixturePath = `${fixtureRootPath}${separator}test${separator}autotest${separator}fixtures${separator}terminal-color-env-probe.mjs`

  const execCommand = async (command: string, label: string, waitMs = 300) => {
    await window.electronAPI.terminal.write(terminalId, `${command}\r`)
    await sleep(waitMs)
    log(`terminal-autofollow:exec:${label}`, { command })
  }

  const readViewport = (api: TerminalDebugApi) => api.getViewportState(terminalId)
  const readTail = (api: TerminalDebugApi, lastLines = 24) => api.getTailText(terminalId, lastLines) ?? ''
  const captureSamples = async (api: TerminalDebugApi, count: number, intervalMs: number) => {
    const samples: Array<ReturnType<TerminalDebugApi['getViewportState']>> = []
    for (let index = 0; index < count; index += 1) {
      await sleep(intervalMs)
      samples.push(api.getViewportState(terminalId))
    }
    return samples
  }
  const stripAnsi = (text: string) => text
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, '')

  const apiReady = await waitFor('terminal-debug-api', () => Boolean(debugApi()), 8000)
  record('TA-00-terminal-debug-api', apiReady, { available: apiReady })
  if (!apiReady || cancelled()) return results

  const api = debugApi()!
  const sessionReady = await waitFor('terminal-session-ready', () => {
    const state = api.getSessionState(terminalId)
    return Boolean(state?.status === 'ready' && state.open)
  }, 12000, 120)
  record('TA-00a-terminal-session-ready', sessionReady, {
    sessionState: api.getSessionState(terminalId)
  })
  if (!sessionReady || cancelled()) return results

  await execCommand('echo __AUTOTEST_TERMINAL_READY__', 'shell-ready-probe', 250)
  const shellReady = await waitFor('terminal-shell-ready', () => {
    return readTail(api, 40).includes('__AUTOTEST_TERMINAL_READY__')
  }, 8000, 120)
  record('TA-00b-terminal-shell-ready', shellReady, {
    tail: readTail(api, 40)
  })
  if (!shellReady || cancelled()) return results

  await execCommand(`node "${fixturePath}"`, 'start-fixture', 200)

  const started = await waitFor('terminal-autofollow-started', () => {
    const viewport = readViewport(api)
    const tail = readTail(api)
    return Boolean(viewport && viewport.baseY > viewport.rows && tail.includes('[AUTOFOLLOW] tick'))
  }, 12000, 120)

  record('TA-01-fixture-started', started, {
    fixturePath,
    fixtureRootPath,
    contextRootPath: rootPath,
    viewport: readViewport(api),
    tail: readTail(api)
  })
  if (!started || cancelled()) return results

  const initialBottomScroll = api.scrollToBottom(terminalId)
  await sleep(200)
  const bottomSamples = await captureSamples(api, 8, 120)
  record(
    'TA-02-follow-bottom-during-refresh',
    initialBottomScroll && bottomSamples.every(sample => Boolean(sample?.isNearBottom && sample?.userWantsBottom)),
    { initialBottomScroll, samples: bottomSamples }
  )
  if (cancelled()) return results

  // TA-03: simulate a real user wheel/PageUp scroll through xterm's own
  // scrollLines() API. This differs from TA-05's api.scrollToTop() in that
  // it matches the exact path a browser wheel event would take: xterm sets
  // isUserScrolling=true internally when scrollLines(n<0) is called while
  // ydisp>0. The viewport must detach from the bottom *and stay* there
  // while the TUI fixture keeps redrawing.
  const scrollLineCount = Math.max(6, Math.floor((readViewport(api)?.rows ?? 24) / 2))
  const userScrollUp = api.scrollLinesAsUser(terminalId, -scrollLineCount)
  await sleep(180)
  const userScrollState = readViewport(api)
  const userScrollSamples = await captureSamples(api, 8, 120)
  record(
    'TA-03-real-user-scroll-detaches-during-refresh',
    userScrollUp &&
      Boolean(userScrollState && !userScrollState.isNearBottom && !userScrollState.userWantsBottom) &&
      userScrollSamples.every(sample => Boolean(
        sample &&
          sample.viewportY <= (userScrollState?.viewportY ?? 0) + 1 &&
          !sample.isNearBottom &&
          !sample.userWantsBottom
      )),
    { scrollLineCount, userScrollUp, userScrollState, samples: userScrollSamples }
  )
  if (cancelled()) return results

  const userScrollBottomReset = api.scrollToBottom(terminalId)
  await sleep(200)
  const userScrollBottomSamples = await captureSamples(api, 6, 120)
  record(
    'TA-04-bottom-follow-recovers-after-user-scroll',
    userScrollBottomReset && userScrollBottomSamples.every(sample => Boolean(sample?.isNearBottom && sample?.userWantsBottom)),
    { userScrollBottomReset, samples: userScrollBottomSamples }
  )
  if (cancelled()) return results

  const manualScrollTop = api.scrollToTop(terminalId)
  await sleep(200)
  const topState = readViewport(api)
  const topSamples = await captureSamples(api, 6, 120)
  record(
    'TA-05-manual-scroll-not-forced-bottom',
    manualScrollTop &&
      Boolean(topState) &&
      topSamples.every(sample => Boolean(sample && sample.viewportY <= (topState?.viewportY ?? 0) + 1 && !sample.isNearBottom && !sample.userWantsBottom)),
    { manualScrollTop, topState, samples: topSamples }
  )
  if (cancelled()) return results

  const resumedBottomScroll = api.scrollToBottom(terminalId)
  await sleep(200)
  const resumedBottomSamples = await captureSamples(api, 6, 120)
  record(
    'TA-06-bottom-follow-recovers-after-manual-scroll',
    resumedBottomScroll && resumedBottomSamples.every(sample => Boolean(sample?.isNearBottom && sample?.userWantsBottom)),
    { resumedBottomScroll, samples: resumedBottomSamples }
  )
  if (cancelled()) return results

  const fitAtBottom = api.forceFit(terminalId)
  await sleep(220)
  const fitBottomSamples = await captureSamples(api, 4, 120)
  record(
    'TA-07-fit-keeps-bottom-follow',
    fitAtBottom && fitBottomSamples.every(sample => Boolean(sample?.isNearBottom && sample?.userWantsBottom)),
    { fitAtBottom, samples: fitBottomSamples }
  )
  if (cancelled()) return results

  const manualScrollTopAgain = api.scrollToTop(terminalId)
  await sleep(180)
  const beforeFitTopState = readViewport(api)
  const fitAtTop = api.forceFit(terminalId)
  await sleep(220)
  const fitTopSamples = await captureSamples(api, 4, 120)
  record(
    'TA-08-fit-preserves-manual-scroll',
    manualScrollTopAgain &&
      fitAtTop &&
      Boolean(beforeFitTopState) &&
      fitTopSamples.every(sample => Boolean(sample && sample.viewportY <= (beforeFitTopState?.viewportY ?? 0) + 1 && !sample.isNearBottom && !sample.userWantsBottom)),
    { manualScrollTopAgain, fitAtTop, beforeFitTopState, samples: fitTopSamples }
  )
  if (cancelled()) return results

  const remountBottomReset = api.scrollToBottom(terminalId)
  await sleep(180)
  const remountAtBottom = api.remountTerminal(terminalId)
  await sleep(260)
  const remountBottomSamples = await captureSamples(api, 4, 120)
  record(
    'TA-09-remount-keeps-bottom-follow',
    remountBottomReset && remountAtBottom && remountBottomSamples.every(sample => Boolean(sample?.isNearBottom && sample?.userWantsBottom)),
    { remountBottomReset, remountAtBottom, samples: remountBottomSamples }
  )
  if (cancelled()) return results

  const manualScrollTopBeforeRemount = api.scrollToTop(terminalId)
  await sleep(180)
  const beforeRemountTopState = readViewport(api)
  const remountAtTop = api.remountTerminal(terminalId)
  await sleep(260)
  const remountTopSamples = await captureSamples(api, 4, 120)
  record(
    'TA-10-remount-preserves-manual-scroll',
    manualScrollTopBeforeRemount &&
      remountAtTop &&
      Boolean(beforeRemountTopState) &&
      remountTopSamples.every(sample => Boolean(sample && sample.viewportY <= (beforeRemountTopState?.viewportY ?? 0) + 1 && !sample.isNearBottom && !sample.userWantsBottom)),
    { manualScrollTopBeforeRemount, remountAtTop, beforeRemountTopState, samples: remountTopSamples }
  )
  if (cancelled()) return results

  const stressBottomReset = api.scrollToBottom(terminalId)
  await sleep(180)
  const operations: Array<Record<string, unknown>> = []
  let stressOk = stressBottomReset
  for (let iteration = 0; iteration < 4; iteration += 1) {
    const fitOk = api.forceFit(terminalId)
    await sleep(120)
    const remountOk = api.remountTerminal(terminalId)
    await sleep(220)
    const viewport = readViewport(api)
    operations.push({ iteration, fitOk, remountOk, viewport })
    if (!fitOk || !remountOk || !viewport?.isNearBottom || !viewport.userWantsBottom) {
      stressOk = false
    }
  }
  const stressSamples = await captureSamples(api, 4, 120)
  stressOk = stressOk && stressSamples.every(sample => Boolean(sample?.isNearBottom && sample?.userWantsBottom))
  record('TA-11-fit-remount-stress-keeps-bottom', stressOk, {
    stressBottomReset,
    operations,
    samples: stressSamples
  })
  if (cancelled()) return results

  // TA-12: focus does not jump the viewport. With the old code path that
  // called the bare textarea.focus() (without { preventScroll: true }), the
  // browser would run scrollIntoView on the helper-textarea positioned at
  // left:-9999em; top:0, and walk up the xterm-viewport chain to snap
  // scrollTop to 0 — producing the "jump to where the Task started"
  // symptom. With the preventScroll option set, focusing the terminal
  // while the user is scrolled up must not change the viewport position.
  const preFocusScrollTop = api.scrollToTop(terminalId)
  await sleep(200)
  const beforeFocusState = readViewport(api)
  const manager = (window as any).__terminalSessionManager
  const focusOk = typeof manager?.focus === 'function' ? manager.focus(terminalId) : false
  // Sample for ~1.2s while the fixture (still in its last few ticks or
  // already exited) produces any trailing output; viewport must hold.
  const focusSamples = await captureSamples(api, 10, 120)
  record(
    'TA-12-focus-does-not-jump-viewport',
    preFocusScrollTop &&
      focusOk &&
      Boolean(beforeFocusState) &&
      focusSamples.every(sample =>
        Boolean(
          sample &&
            sample.viewportY <= (beforeFocusState?.viewportY ?? 0) + 1 &&
            !sample.isNearBottom
        )
      ),
    { preFocusScrollTop, focusOk, beforeFocusState, samples: focusSamples }
  )
  if (cancelled()) return results

  const fixtureCompleted = await waitFor('terminal-autofollow-finished', () => {
    return readTail(api, 30).includes('[AUTOFOLLOW] end')
  }, 10000, 150)
  record('TA-13-fixture-completed', fixtureCompleted, {
    tail: readTail(api, 30),
    viewport: readViewport(api),
    sessionState: api.getSessionState(terminalId)
  })
  if (!fixtureCompleted || cancelled()) return results

  if (platform !== 'win32' && window.electronAPI.debug.autotestFixtureExtra === 'terminal-zsh-chain') {
    await execCommand(
      'printf "ONWARD_ZSH_CHAIN_RESULT shell=%s zprofile=%s zshrc=%s\\n" "$SHELL" "${ONWARD_AUTOTEST_ZPROFILE_MARKER:-}" "${ONWARD_AUTOTEST_ZSHRC_MARKER:-}"',
      'zsh-user-zdotdir-chain',
      250
    )
    const zshChainReady = await waitFor('terminal-zsh-chain-result', () => {
      return readTail(api, 60).includes('ONWARD_ZSH_CHAIN_RESULT')
    }, 8000, 120)
    const zshChainTail = readTail(api, 60)
    record(
      'TA-00c-zsh-user-zdotdir-chain',
      zshChainReady &&
        /ONWARD_ZSH_CHAIN_RESULT .*shell=\/.*zsh/.test(zshChainTail) &&
        zshChainTail.includes('zprofile=loaded-zprofile') &&
        zshChainTail.includes('zshrc=loaded-zshrc'),
      { tail: zshChainTail }
    )
    if (!zshChainReady || cancelled()) return results
  }

  let colorOutput = ''
  const unsubscribeColorCapture = window.electronAPI.terminal.onData((termId, data) => {
    if (termId === terminalId) colorOutput += data
  })
  try {
    await execCommand(`node "${colorFixturePath}"`, 'color-env-probe', 200)
    const colorProbeCompleted = await waitFor('terminal-color-env-probe-finished', () => {
      return colorOutput.includes('__AUTOTEST_COLOR_ENV_END__')
    }, 8000, 120)
    const normalizedColorOutput = stripAnsi(colorOutput)
    record(
      'TA-14-color-env-sanitized',
      colorProbeCompleted &&
        !/^NO_COLOR=/m.test(normalizedColorOutput) &&
        !/^FORCE_COLOR=0$/m.test(normalizedColorOutput) &&
        !/^CLICOLOR=0$/m.test(normalizedColorOutput) &&
        /^COLORTERM=truecolor$/m.test(normalizedColorOutput) &&
        /^CLICOLOR=1$/m.test(normalizedColorOutput),
      {
        colorFixturePath,
        output: normalizedColorOutput
      }
    )
    // On POSIX the PTY forwards bytes verbatim, so the contiguous SGR sequence
    // survives intact. On Windows, ConPTY redraws its screen buffer and may
    // split/relocate the SGR codes, so the contiguous substring never appears
    // even though the colour is applied (TA-14 proves the env vars reached the
    // child). Assert on the structural signals instead: a red-FG SGR code, a
    // reset code, and the stripped marker text.
    const colorPreserved =
      platform === 'win32'
        ? colorProbeCompleted &&
          /\x1b\[[0-9;]*31[;0-9]*m/.test(colorOutput) &&
          /\x1b\[0?m/.test(colorOutput) &&
          normalizedColorOutput.includes('__AUTOTEST_COLOR_RED__')
        : colorProbeCompleted && colorOutput.includes('\x1b[31m__AUTOTEST_COLOR_RED__\x1b[0m')
    record(
      'TA-15-ansi-color-output-preserved',
      colorPreserved,
      {
        colorFixturePath,
        output: normalizedColorOutput
      }
    )
  } finally {
    unsubscribeColorCapture()
  }

  // ───── TA-16/17: verified change-workdir hardening (G1 TUI gate + G2 busy
  // lock, 2026-07-24 review). Driven through the REAL PTY (terminal.write →
  // shell echoes DECSET 1049), so the assertion covers the full main-side
  // chain: pty onData → scanScreenMode → screen-mode state → gate. This is
  // deliberately NOT injectPtyData, which writes renderer-side and would
  // bypass the main-process scanner entirely. ─────
  const emitRawSequence = async (sequence: string, label: string) => {
    // POSIX printf accepts \033; PowerShell needs [char]27 concatenation.
    const command = platform === 'win32'
      ? `Write-Host -NoNewline ([char]27 + '${sequence}')`
      : `printf '\\033${sequence}'`
    await execCommand(command, label, 250)
  }

  await emitRawSequence('[?1049h', 'alt-screen-enter')
  const altReached = await waitFor('terminal-alt-buffer-active', () => {
    return api.getViewportState(terminalId)?.bufferType === 'alternate'
  }, 8000, 120)

  if (altReached) {
    // Same bytes reached the renderer's parser AFTER the main-process scan,
    // so the gate MUST be armed — a miss here is a main/renderer parity bug.
    const gated = await window.electronAPI.terminal.changeWorkDirVerified(
      terminalId,
      `${fixtureRootPath}${separator}test`
    )
    record('TA-16-tui-gate-blocks-change-workdir', gated.success === false && gated.reason === 'tui-active', {
      outcome: gated,
      viewport: readViewport(api)
    })
    await emitRawSequence('[?1049l', 'alt-screen-exit')
    const backToNormal = await waitFor('terminal-normal-buffer-active', () => {
      return api.getViewportState(terminalId)?.bufferType === 'normal'
    }, 8000, 120)
    record('TA-16a-alt-screen-exit-reopens-gate', backToNormal, {
      viewport: readViewport(api)
    })
  } else {
    // Documented platform branch: some ConPTY builds virtualize DECSET 1049
    // instead of passing it through (BUG-0001 sub-mechanism B). The gate
    // then must NOT block — the terminal really is on the normal buffer.
    record('TA-16-tui-gate-blocks-change-workdir', platform === 'win32', {
      skipped: 'conpty-no-alt-passthrough',
      viewport: readViewport(api)
    })
    // Defensive: clear any virtualized inner alt state ConPTY may hold.
    await emitRawSequence('[?1049l', 'alt-screen-exit-cleanup')
  }

  // TA-16b: with the normal buffer active, the verified transaction must
  // succeed end-to-end (cd written, shell proof OSC observed, cwd returned).
  const cdTarget = `${fixtureRootPath}${separator}test`
  const cdOk = await window.electronAPI.terminal.changeWorkDirVerified(terminalId, cdTarget)
  record('TA-16b-verified-change-workdir-succeeds', cdOk.success === true && typeof cdOk.cwd === 'string', {
    outcome: cdOk,
    target: cdTarget
  })

  // TA-17: two concurrent transactions on one terminal — exactly one wins,
  // the other is rejected 'busy' (G2 lock). Target = fixtureRootPath so the
  // winner also restores the suite's working directory.
  const [race1, race2] = await Promise.all([
    window.electronAPI.terminal.changeWorkDirVerified(terminalId, fixtureRootPath),
    window.electronAPI.terminal.changeWorkDirVerified(terminalId, fixtureRootPath)
  ])
  const oneBusy = (race1.success && race2.reason === 'busy') || (race2.success && race1.reason === 'busy')
  record('TA-17-concurrent-change-workdir-one-busy', oneBusy, {
    race1,
    race2
  })

  log('terminal-autofollow:done', {
    total: results.length,
    passed: results.filter(result => result.ok).length,
    failed: results.filter(result => !result.ok).length
  })

  return results
}
