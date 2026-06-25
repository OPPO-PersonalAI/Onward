/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Git History multi-terminal scope regression test
 */
import type { AutotestContext, TestResult } from './types'
import { buildChangeDirectoryCommand, type TerminalShellKind } from '../utils/terminal-command'

function normalizePath(value: string): string {
  return value.replace(/\\/g, '/').replace(/\/+$/, '')
}

function joinPath(base: string, child: string): string {
  const trimmed = base.replace(/[\\/]+$/, '')
  return `${trimmed}/${child}`
}

function lastSegment(value: string): string {
  const normalized = value.replace(/[\\/]+$/, '')
  const slashIndex = Math.max(normalized.lastIndexOf('/'), normalized.lastIndexOf('\\'))
  return slashIndex >= 0 ? normalized.slice(slashIndex + 1) : normalized
}

function getFixtureBase(rootPath: string): string {
  const configured = window.electronAPI.debug.autotestFixtureExtra?.trim()
  if (configured) return configured
  return joinPath(rootPath, 'test/autotest/results/git-history-multi-terminal-scope')
}

function getVisibleTerminalIds(): string[] {
  const nodes = Array.from(document.querySelectorAll<HTMLElement>('[data-terminal-id]'))
  const ids = nodes
    .map((node) => node.dataset.terminalId ?? '')
    .filter(Boolean)
  return Array.from(new Set(ids))
}

function dispatchEscape(): void {
  document.dispatchEvent(new KeyboardEvent('keydown', {
    key: 'Escape',
    code: 'Escape',
    bubbles: true,
    cancelable: true
  }))
}

function normalizeText(value: string | null | undefined): string {
  return (value ?? '').replace(/\r\n/g, '\n')
}

async function resolveTerminalShellKind(terminalId: string): Promise<TerminalShellKind | undefined> {
  try {
    return (await window.electronAPI.terminal.getInputCapabilities(terminalId)).shellKind
  } catch {
    return undefined
  }
}

async function waitForTerminalCwd(
  terminalId: string,
  expectedCwd: string,
  sleep: (ms: number) => Promise<void>,
  timeoutMs = 12000
): Promise<string | null> {
  const startedAt = performance.now()
  const normalizedExpected = normalizePath(expectedCwd)
  while (performance.now() - startedAt < timeoutMs) {
    const cwd = await window.electronAPI.git.getTerminalCwd(terminalId)
    if (cwd && normalizePath(cwd) === normalizedExpected) {
      return cwd
    }
    await sleep(180)
  }
  return null
}

async function writeAndSyncTerminal(
  terminalId: string,
  command: string,
  sleep: (ms: number) => Promise<void>
): Promise<void> {
  await window.electronAPI.terminal.write(terminalId, command)
  await sleep(400)
  await window.electronAPI.git.notifyTerminalActivity(terminalId)
  await sleep(400)
}

export async function testGitHistoryMultiTerminalScope(ctx: AutotestContext): Promise<TestResult[]> {
  const { log, sleep, waitFor, assert, cancelled, rootPath } = ctx
  const results: TestResult[] = []
  const _assert = (name: string, ok: boolean, detail?: Record<string, unknown>) => {
    assert(name, ok, detail)
    results.push({ name, ok, detail })
  }

  const getHistoryApi = () => window.__onwardGitHistoryDebug
  const fixtureBase = getFixtureBase(rootPath)
  const fixtureRoot = joinPath(fixtureBase, `onward-autotest-git-history-scope-${Date.now()}`)
  const staleRepoRoot = joinPath(fixtureBase, `onward-autotest-stale-repo-${Date.now()}`)
  const layoutButton = document.querySelector<HTMLButtonElement>('button[title="Two terminals"]')
  let terminalA: string | null = null
  let terminalB: string | null = null

  log('phase3.5:start', {
    suite: 'GitHistoryMultiTerminalScope',
    rootPath,
    fixtureBase,
    fixtureRoot,
    staleRepoRoot
  })

  try {
    layoutButton?.click()
    const hasTwoTerminals = await waitFor(
      'phase3.5-layout-two-terminals',
      () => getVisibleTerminalIds().length >= 2,
      10000
    )
    _assert('GHMS-01-layout-two-terminals', hasTwoTerminals, {
      visibleTerminalIds: getVisibleTerminalIds()
    })
    if (!hasTwoTerminals || cancelled()) return results

    const terminalIds = getVisibleTerminalIds()
    terminalA = terminalIds[0] ?? null
    terminalB = terminalIds[1] ?? null
    const terminalPairValid = Boolean(terminalA && terminalB && terminalA !== terminalB)
    _assert('GHMS-02-terminal-pair-valid', terminalPairValid, { terminalA, terminalB, terminalIds })
    if (!terminalPairValid || !terminalA || !terminalB || cancelled()) return results

    const platform = window.electronAPI.platform
    const fixtureShellPath = platform === 'win32' ? fixtureRoot.replace(/\//g, '\\') : fixtureRoot
    const rootShellPath = platform === 'win32' ? rootPath.replace(/\//g, '\\') : rootPath
    const fixtureCommand = platform === 'win32'
      ? [
        `$fixtureRoot = "${fixtureShellPath}"`,
        'if (Test-Path $fixtureRoot) { Remove-Item -Recurse -Force $fixtureRoot }',
        'New-Item -ItemType Directory -Path $fixtureRoot | Out-Null',
        'Set-Location $fixtureRoot',
        'git init | Out-Null',
        'Set-Content -LiteralPath "README.md" -Value "fixture"',
        'git add README.md',
        'git -c user.name="Onward AutoTest" -c user.email="autotest@example.com" commit -m "fixture" | Out-Null',
        'Set-Content -LiteralPath "history-vscode.txt" -Value "history base"',
        'git add history-vscode.txt',
        'git -c user.name="Onward AutoTest" -c user.email="autotest@example.com" commit -m "history base" | Out-Null',
        'Set-Content -LiteralPath "history-vscode.txt" -Value "history head"',
        'git add history-vscode.txt',
        'git -c user.name="Onward AutoTest" -c user.email="autotest@example.com" commit -m "history head" | Out-Null'
      ].join('; ') + "\r"
      : [
        `rm -rf "${fixtureShellPath}"`,
        `mkdir -p "${fixtureShellPath}"`,
        `cd "${fixtureShellPath}"`,
        'git init >/dev/null 2>&1',
        'printf "fixture\\n" > README.md',
        'git add README.md',
        'git -c user.name="Onward AutoTest" -c user.email="autotest@example.com" commit -m "fixture" >/dev/null 2>&1',
        'printf "history base\\n" > history-vscode.txt',
        'git add history-vscode.txt',
        'git -c user.name="Onward AutoTest" -c user.email="autotest@example.com" commit -m "history base" >/dev/null 2>&1',
        'printf "history head\\n" > history-vscode.txt',
        'git add history-vscode.txt',
        'git -c user.name="Onward AutoTest" -c user.email="autotest@example.com" commit -m "history head" >/dev/null 2>&1'
      ].join(' && ') + "\r"
    const shellKindA = await resolveTerminalShellKind(terminalA)
    const rootCommand = buildChangeDirectoryCommand(platform, rootShellPath, shellKindA)

    await writeAndSyncTerminal(terminalA, rootCommand, sleep)
    await writeAndSyncTerminal(terminalB, fixtureCommand, sleep)

    const cwdA = await waitForTerminalCwd(terminalA, rootPath, sleep)
    _assert('GHMS-03-terminal-a-root-ready', Boolean(cwdA), {
      terminalId: terminalA,
      expected: normalizePath(rootPath),
      actual: cwdA ? normalizePath(cwdA) : null
    })
    if (!cwdA || cancelled()) return results

    // Terminal B runs a HEAVY fixture command (rm + mkdir + git init + 3 commits)
    // before it lands in fixtureRoot. Each git commit is EDR-taxed (1.3-12.9 s
    // spawn tax under anti-malware), so the default 12 s cwd budget is far too
    // tight under full-suite EDR pressure (terminal A's plain `cd` settles fast and
    // keeps the default). Give B a generous EDR-tolerant ceiling — it returns the
    // instant the cwd settles, so a healthy host pays nothing extra. Matches the
    // SN-00 multi-step-fixture cwd budget.
    const cwdB = await waitForTerminalCwd(terminalB, fixtureRoot, sleep, 90000)
    _assert('GHMS-04-terminal-b-fixture-ready', Boolean(cwdB), {
      terminalId: terminalB,
      expected: normalizePath(fixtureRoot),
      actual: cwdB ? normalizePath(cwdB) : null
    })
    if (!cwdB || cancelled()) return results

    window.dispatchEvent(new CustomEvent('git-history:open', { detail: { terminalId: terminalA } }))
    const openedOnA = await waitFor(
      'phase3.5-history-open-a',
      () => Boolean(getHistoryApi()?.isOpen()),
      8000
    )
    _assert('GHMS-05-open-history-on-terminal-a', openedOnA, { terminalId: terminalA })
    if (!openedOnA || cancelled()) return results

    const loadedOnA = await waitFor(
      'phase3.5-history-loaded-a',
      () => {
        const api = getHistoryApi()
        return Boolean(api && api.getCommitCount() > 0 && !api.isLoading())
      },
      12000
    )
    _assert('GHMS-06-load-history-on-terminal-a', loadedOnA, {
      commitCount: getHistoryApi()?.getCommitCount() ?? 0,
      activeCwd: getHistoryApi()?.getActiveCwd?.() ?? null
    })
    if (!loadedOnA || cancelled()) return results

    const injected = getHistoryApi()?.injectRepoState({
      selectedRepoRoot: staleRepoRoot,
      cachedParentCwd: rootPath,
      repoSearch: 'stale repo',
      cachedRepos: [{ root: staleRepoRoot, label: 'Stale Repo' }]
    }) ?? false
    await sleep(200)
    const staleState = getHistoryApi()?.getRepoState?.() ?? null
    _assert('GHMS-07-inject-stale-repo-state', injected && staleState?.selectedRepoRoot === staleRepoRoot, {
      injected,
      staleState,
      activeCwd: getHistoryApi()?.getActiveCwd?.() ?? null
    })
    if ((!injected || staleState?.selectedRepoRoot !== staleRepoRoot) || cancelled()) return results

    window.dispatchEvent(new CustomEvent('git-history:open', { detail: { terminalId: terminalB } }))
    // Terminal B's repo is COLD on first switch: its git-history spawn is EDR-taxed
    // (unlike terminal A's already-warm main repo), so allow a larger budget.
    const switchedToB = await waitFor(
      'phase3.5-history-switch-b',
      () => {
        const api = getHistoryApi()
        if (!api?.isOpen()) return false
        return normalizePath(api.getActiveCwd?.() ?? '') === normalizePath(fixtureRoot)
      },
      30000
    )
    _assert('GHMS-08-switch-history-to-terminal-b', switchedToB, {
      expected: normalizePath(fixtureRoot),
      actual: normalizePath(getHistoryApi()?.getActiveCwd?.() ?? '')
    })
    if (!switchedToB || cancelled()) return results

    // Terminal B's repo is COLD: its first git-history load pays the EDR spawn tax,
    // unlike GHMS-06 above which loads the already-warm main repo at 12s. Use a
    // larger budget so the cold-repo load is not force-failed by EDR latency.
    const reloadedOnB = await waitFor(
      'phase3.5-history-loaded-b',
      () => {
        const api = getHistoryApi()
        return Boolean(api && api.getCommitCount() > 0 && !api.isLoading())
      },
      30000
    )
    const finalState = getHistoryApi()?.getRepoState?.() ?? null
    _assert('GHMS-09-reload-current-repo-on-terminal-b', reloadedOnB, {
      commitCount: getHistoryApi()?.getCommitCount() ?? 0,
      activeCwd: getHistoryApi()?.getActiveCwd?.() ?? null,
      finalState
    })

    const clearedStaleState = Boolean(
      finalState &&
      finalState.selectedRepoRoot === null &&
      finalState.repoSearch === '' &&
      normalizePath(finalState.cachedParentCwd ?? '') !== normalizePath(staleRepoRoot)
    )
    _assert('GHMS-10-clear-stale-repo-state', clearedStaleState, {
      staleRepoRoot,
      finalState
    })

    const headCommitIndex = getHistoryApi()?.getCommits?.().findIndex((commit) => commit.summary === 'history head') ?? -1
    const selectedHeadCommit = headCommitIndex >= 0 && (getHistoryApi()?.selectCommitByIndex(headCommitIndex) ?? false)
    const historyFileListed = selectedHeadCommit && await waitFor(
      'phase3.5-history-head-file-listed',
      () => Boolean(getHistoryApi()?.getFiles().some((file) => file.filename === 'history-vscode.txt' && file.status === 'M')),
      10000
    )
    const selectedHistoryFile = historyFileListed && (getHistoryApi()?.selectFileByPath?.('history-vscode.txt') ?? false)
    const historyFileContentReady = selectedHistoryFile && await waitFor(
      'phase3.5-history-head-file-content',
      () => normalizeText(getHistoryApi()?.getSelectedFileContent?.()?.modifiedContent) === 'history head\n',
      10000
    )
    const selectedContent = getHistoryApi()?.getSelectedFileContent?.() ?? null
    _assert('GHMS-11-vscode-history-provider-file-change-list', Boolean(
      selectedHeadCommit &&
      historyFileListed &&
      selectedHistoryFile
    ), {
      headCommitIndex,
      selectedHeadCommit,
      files: getHistoryApi()?.getFiles() ?? []
    })
    _assert('GHMS-12-vscode-history-parent-to-commit-content', Boolean(
      historyFileContentReady &&
      normalizeText(selectedContent?.originalContent) === 'history base\n' &&
      normalizeText(selectedContent?.modifiedContent) === 'history head\n'
    ), {
      selectedContent,
      expectedOriginal: 'history base\\n',
      expectedModified: 'history head\\n'
    })

    let diffOptionButtons: Array<{ mode: string | null; label: string; active: boolean }> = []
    const diffOptionsVisible = await waitFor(
      'phase3.5-history-diff-options-visible',
      () => {
        const trigger = document.querySelector<HTMLButtonElement>('.git-history-diff-options-trigger')
        if (!trigger) return false
        if (!document.querySelector('.git-history-diff-options-popover')) trigger.click()
        const buttons = Array.from(document.querySelectorAll<HTMLButtonElement>('.git-history-diff-options-buttons .git-history-option-btn'))
        diffOptionButtons = buttons.map((button) => ({
          mode: button.dataset.mode ?? null,
          label: button.textContent?.trim() ?? '',
          active: button.classList.contains('active')
        }))
        return diffOptionButtons.length >= 2
      },
      4000
    )
    const defaultDisplayMode = getHistoryApi()?.getDiffDisplayMode?.() ?? null
    _assert('GHMS-13-diff-display-mode-default-inline', Boolean(
      diffOptionsVisible &&
      defaultDisplayMode === 'inline' &&
      diffOptionButtons.some((button) => button.mode === 'side-by-side' && button.label === 'Side-by-side') &&
      diffOptionButtons.some((button) => button.mode === 'inline' && button.label === 'Inline' && button.active)
    ), {
      diffOptionsVisible,
      defaultDisplayMode,
      diffOptionButtons
    })

    const selectedShaBeforeRestore = getHistoryApi()?.getSelectedShas?.()[0] ?? null
    if (getHistoryApi()?.setDiffDisplayMode) {
      getHistoryApi()?.setDiffDisplayMode?.('side-by-side')
    } else {
      getHistoryApi()?.setDiffStyle('split')
    }
    getHistoryApi()?.setHideWhitespace(true)
    await sleep(500)
    dispatchEscape()
    const closedForRestore = await waitFor(
      'phase3.5-history-close-for-restore',
      () => !getHistoryApi() || !getHistoryApi()!.isOpen(),
      4000
    )
    window.dispatchEvent(new CustomEvent('git-history:open', { detail: { terminalId: terminalB } }))
    // Reopening history on terminal B reloads its (cold, EDR-taxed) repo history;
    // the restore can only run once that fresh load completes. Match the cold-repo
    // budget used by GHMS-08/GHMS-09 above rather than the warm-repo 12s.
    const reopenedForRestore = await waitFor(
      'phase3.5-history-reopen-for-restore',
      () => Boolean(getHistoryApi()?.isOpen() && !getHistoryApi()?.isLoading()),
      30000
    )
    const restoredSelection = reopenedForRestore && await waitFor(
      'phase3.5-history-selection-restored',
      () => {
        const api = getHistoryApi()
        return api?.getSelectedShas?.()[0] === selectedShaBeforeRestore &&
          api?.getSelectedFile?.()?.filename === 'history-vscode.txt'
      },
      30000
    )
    _assert('GHMS-13-vscode-history-view-state-restored', Boolean(
      closedForRestore &&
      reopenedForRestore &&
      restoredSelection &&
      getHistoryApi()?.getDiffDisplayMode?.() === 'side-by-side' &&
      getHistoryApi()?.getDiffStyle() === 'split' &&
      getHistoryApi()?.getHideWhitespace() === true
    ), {
      selectedShaBeforeRestore,
      selectedShasAfterRestore: getHistoryApi()?.getSelectedShas?.() ?? [],
      selectedFileAfterRestore: getHistoryApi()?.getSelectedFile?.() ?? null,
      diffDisplayMode: getHistoryApi()?.getDiffDisplayMode?.() ?? null,
      diffStyle: getHistoryApi()?.getDiffStyle?.() ?? null,
      hideWhitespace: getHistoryApi()?.getHideWhitespace?.() ?? null
    })

    dispatchEscape()
    const closed = await waitFor(
      'phase3.5-history-close',
      () => !getHistoryApi() || !getHistoryApi()!.isOpen(),
      4000
    )
    _assert('GHMS-14-esc-close-history', closed, { closed })
    await sleep(300)

    log('phase3.5:done', {
      total: results.length,
      passed: results.filter(r => r.ok).length,
      failed: results.filter(r => !r.ok).length
    })

    return results
  } finally {
    try {
      const platform = window.electronAPI.platform
      const rootShellPath = platform === 'win32' ? rootPath.replace(/\//g, '\\') : rootPath
      const cleanupCommand = buildChangeDirectoryCommand(platform, rootShellPath)
      if (terminalA) await writeAndSyncTerminal(terminalA, cleanupCommand, sleep)
      if (terminalB && terminalB !== terminalA) await writeAndSyncTerminal(terminalB, cleanupCommand, sleep)
    } catch (error) {
      log('phase3.5:cleanup-cwd-error', { error: String(error) })
    }

    for (const targetRoot of [fixtureRoot, staleRepoRoot]) {
      try {
        const cleanup = await window.electronAPI.project.deletePath(fixtureBase, lastSegment(targetRoot))
        log('phase3.5:cleanup-fixture', { fixtureBase, targetRoot, cleanup })
      } catch (error) {
        log('phase3.5:cleanup-fixture-error', { fixtureBase, targetRoot, error: String(error) })
      }
    }
  }
}
