/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

import type { AutotestContext, TestResult } from './types'

interface FixtureManifest {
  fixtureRoot: string
  largeFile: string
  historyMarker: string
  diffMarker: string
}

function dirname(path: string): string {
  const cleaned = path.replace(/[\\/]+$/, '')
  const idx = Math.max(cleaned.lastIndexOf('/'), cleaned.lastIndexOf('\\'))
  return idx >= 0 ? cleaned.slice(0, idx) : cleaned
}

function lastSegment(path: string): string {
  const cleaned = path.replace(/[\\/]+$/, '')
  const idx = Math.max(cleaned.lastIndexOf('/'), cleaned.lastIndexOf('\\'))
  return idx >= 0 ? cleaned.slice(idx + 1) : cleaned
}

async function loadManifest(extraPath: string | null | undefined): Promise<FixtureManifest | null> {
  if (!extraPath) return null
  const root = dirname(extraPath)
  const file = lastSegment(extraPath)
  const result = await window.electronAPI.project.readFile(root, file)
  if (!result.success || typeof result.content !== 'string') return null
  try {
    return JSON.parse(result.content) as FixtureManifest
  } catch {
    return null
  }
}

export async function testGitLargeFileConfirmation(ctx: AutotestContext): Promise<TestResult[]> {
  const { assert, cancelled, log, terminalId, waitFor } = ctx
  const results: TestResult[] = []
  const record = (name: string, ok: boolean, detail?: Record<string, unknown>) => {
    assert(name, ok, detail)
    results.push({ name, ok, detail })
  }
  const openGitDiff = async (label: string) => {
    window.dispatchEvent(new CustomEvent('git-diff:open', { detail: { terminalId } }))
    return await waitFor(label, () => Boolean(window.__onwardGitDiffDebug?.isOpen()), 8000)
  }
  const waitForDiffLargeFile = async (label: string) => {
    return await waitFor(label, () => {
      const api = window.__onwardGitDiffDebug
      return Boolean(api?.getFileList?.().some((file) => file.filename === manifest?.largeFile))
    }, 8000)
  }
  const openGitHistory = async (label: string) => {
    window.dispatchEvent(new CustomEvent('git-history:open', { detail: { terminalId } }))
    return await waitFor(label, () => Boolean(window.__onwardGitHistoryDebug?.isOpen()), 8000)
  }
  const waitForHistoryLargeFile = async (label: string) => {
    return await waitFor(label, () => {
      const api = window.__onwardGitHistoryDebug
      return Boolean(api && api.getFiles().some((file) => file.filename === manifest?.largeFile))
    }, 12000)
  }

  // Unified modal dismiss (2026-07-16) helpers: backdrop clicks on the
  // confirm dialog are inert; ESC settles the dialog without closing the
  // hosting viewer. Exercised while the prompt is armed and BEFORE any
  // confirm (a confirmed file does not re-prompt within the session).
  const clickLargeFileBackdrop = () => {
    const overlay = document.querySelector('.large-file-confirm-overlay')
    if (!overlay) return false
    overlay.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
    overlay.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    return true
  }
  const pressEscape = () => {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
  }
  const settleDelay = () => new Promise((resolve) => setTimeout(resolve, 300))

  const manifest = await loadManifest(window.electronAPI.debug.autotestFixtureExtra)
  record('GLF-00-fixture-loaded', Boolean(manifest), {
    extra: window.electronAPI.debug.autotestFixtureExtra ?? null
  })
  if (!manifest || cancelled()) return results

  log('git-large-file-confirmation:start', manifest)

  const diffOpen = await openGitDiff('glf-diff-open')
  record('GLF-01-diff-opens', diffOpen)
  if (!diffOpen || cancelled()) return results

  const diffListed = await waitForDiffLargeFile('glf-diff-file-listed')
  record('GLF-02-diff-file-listed', diffListed, {
    files: window.__onwardGitDiffDebug?.getFileList?.().map((file) => file.filename) ?? []
  })
  if (!diffListed || cancelled()) return results

  window.__onwardGitDiffDebug?.selectFileByPath(manifest.largeFile)
  const diffPrompt = await waitFor('glf-diff-prompt-visible', () => {
    return window.__onwardGitDiffDebug?.getLargeFileConfirmState?.().visible === true
  }, 8000)
  record('GLF-03-diff-prompts-over-3mb', diffPrompt, {
    prompt: window.__onwardGitDiffDebug?.getLargeFileConfirmState?.() ?? null
  })
  if (!diffPrompt || cancelled()) return results

  window.dispatchEvent(new CustomEvent('git-diff:close', { detail: { terminalId } }))
  const diffCloseCancelled = await waitFor('glf-diff-close-cancels-prompt', () => {
    const api = window.__onwardGitDiffDebug
    return !api || !api.isOpen() || api.getLargeFileConfirmState?.().visible !== true
  }, 5000)
  record('GLF-03a-diff-close-cancels-pending-confirmation', diffCloseCancelled, {
    prompt: window.__onwardGitDiffDebug?.getLargeFileConfirmState?.() ?? null
  })
  if (cancelled()) return results

  const diffReopened = await openGitDiff('glf-diff-reopen-after-close-cancel')
  const diffRelisted = diffReopened && await waitForDiffLargeFile('glf-diff-file-listed-after-close-cancel')
  record('GLF-03b-diff-reopens-after-close-cancel', diffReopened && diffRelisted, {
    reopened: diffReopened,
    files: window.__onwardGitDiffDebug?.getFileList?.().map((file) => file.filename) ?? []
  })
  if (!diffReopened || !diffRelisted || cancelled()) return results

  window.__onwardGitDiffDebug?.selectFileByPath(manifest.largeFile)
  const diffPromptAfterClose = await waitFor('glf-diff-prompt-visible-after-close-cancel', () => {
    return window.__onwardGitDiffDebug?.getLargeFileConfirmState?.().visible === true
  }, 8000)
  record('GLF-03c-diff-prompts-after-close-cancel', diffPromptAfterClose, {
    prompt: window.__onwardGitDiffDebug?.getLargeFileConfirmState?.() ?? null
  })
  if (!diffPromptAfterClose || cancelled()) return results

  window.__onwardGitDiffDebug?.cancelLargeFile?.()
  const diffCancelled = await waitFor('glf-diff-cancelled-message', () => {
    const state = window.__onwardGitDiffDebug?.getSelectedFileContent?.()
    return Boolean(state?.error?.includes('3 MB'))
  }, 5000)
  record('GLF-04-diff-cancel-shows-clear-message', diffCancelled, {
    state: window.__onwardGitDiffDebug?.getSelectedFileContent?.() ?? null
  })
  if (cancelled()) return results

  void window.__onwardGitDiffDebug?.refreshChanges?.()
  const diffPromptAgain = await waitFor('glf-diff-prompt-visible-again', () => {
    return window.__onwardGitDiffDebug?.getLargeFileConfirmState?.().visible === true
  }, 8000)
  record('GLF-05-diff-can-prompt-again-after-refresh', diffPromptAgain, {
    prompt: window.__onwardGitDiffDebug?.getLargeFileConfirmState?.() ?? null
  })
  if (!diffPromptAgain || cancelled()) return results

  // GLF-16/17 — unified modal dismiss on the armed (pre-confirm) prompt.
  const diffBackdropClicked = clickLargeFileBackdrop()
  await settleDelay()
  const diffPromptStillVisible = window.__onwardGitDiffDebug?.getLargeFileConfirmState?.().visible === true
  record('GLF-16-diff-backdrop-click-keeps-prompt', diffBackdropClicked && diffPromptStillVisible, {
    backdropClicked: diffBackdropClicked,
    prompt: window.__onwardGitDiffDebug?.getLargeFileConfirmState?.() ?? null
  })
  if (cancelled()) return results

  pressEscape()
  const diffEscSettled = await waitFor('glf-diff-esc-cancels-prompt', () => {
    return window.__onwardGitDiffDebug?.getLargeFileConfirmState?.().visible !== true
  }, 5000)
  const diffStillOpen = window.__onwardGitDiffDebug?.isOpen?.() === true
  record('GLF-17-diff-escape-cancels-prompt-keeps-viewer', diffEscSettled && diffStillOpen, {
    escSettled: diffEscSettled,
    viewerOpen: diffStillOpen
  })
  if (cancelled()) return results

  // Re-arm the prompt for the confirm path below (same refresh path GLF-05
  // just proved).
  void window.__onwardGitDiffDebug?.refreshChanges?.()
  const diffPromptForConfirm = await waitFor('glf-diff-prompt-visible-for-confirm', () => {
    return window.__onwardGitDiffDebug?.getLargeFileConfirmState?.().visible === true
  }, 8000)
  record('GLF-05b-diff-prompt-rearms-after-esc-cancel', diffPromptForConfirm, {
    prompt: window.__onwardGitDiffDebug?.getLargeFileConfirmState?.() ?? null
  })
  if (!diffPromptForConfirm || cancelled()) return results

  window.__onwardGitDiffDebug?.confirmLargeFile?.()
  const diffDisplayed = await waitFor('glf-diff-displayed-after-confirm', () => {
    const state = window.__onwardGitDiffDebug?.getSelectedFileContent?.()
    return Boolean(state && !state.loading && !state.error && state.modifiedContent?.includes(manifest.diffMarker))
  }, 12000)
  record('GLF-06-diff-displays-after-confirm', diffDisplayed, {
    state: window.__onwardGitDiffDebug?.getSelectedFileContent?.()
      ? {
          loading: window.__onwardGitDiffDebug.getSelectedFileContent?.()?.loading,
          error: window.__onwardGitDiffDebug.getSelectedFileContent?.()?.error,
          modifiedLength: window.__onwardGitDiffDebug.getSelectedFileContent?.()?.modifiedContent?.length ?? null
        }
      : null
  })
  if (cancelled()) return results

  const historyOpen = await openGitHistory('glf-history-open')
  record('GLF-07-history-opens', historyOpen)
  if (!historyOpen || cancelled()) return results

  const historyReady = await waitForHistoryLargeFile('glf-history-files-ready')
  record('GLF-08-history-file-listed', historyReady, {
    commitCount: window.__onwardGitHistoryDebug?.getCommitCount?.() ?? null,
    isLoading: window.__onwardGitHistoryDebug?.isLoading?.() ?? null,
    files: window.__onwardGitHistoryDebug?.getFiles?.().map((file) => file.filename) ?? []
  })
  if (!historyReady || cancelled()) return results

  window.__onwardGitHistoryDebug?.selectFileByPath?.(manifest.largeFile)
  const historyPrompt = await waitFor('glf-history-prompt-visible', () => {
    return window.__onwardGitHistoryDebug?.getLargeFileConfirmState?.().visible === true
  }, 8000)
  record('GLF-09-history-prompts-over-3mb', historyPrompt, {
    prompt: window.__onwardGitHistoryDebug?.getLargeFileConfirmState?.() ?? null
  })
  if (!historyPrompt || cancelled()) return results

  window.__onwardGitHistoryDebug?.switchRepo?.(manifest.fixtureRoot)
  const historySwitchCancelled = await waitFor('glf-history-switch-repo-cancels-prompt', () => {
    return window.__onwardGitHistoryDebug?.getLargeFileConfirmState?.().visible !== true
  }, 5000)
  record('GLF-09a-history-switch-repo-cancels-pending-confirmation', historySwitchCancelled, {
    prompt: window.__onwardGitHistoryDebug?.getLargeFileConfirmState?.() ?? null,
    repoState: window.__onwardGitHistoryDebug?.getRepoState?.() ?? null
  })
  if (cancelled()) return results

  const historyReadyAfterSwitch = await waitForHistoryLargeFile('glf-history-files-ready-after-switch-cancel')
  record('GLF-09b-history-file-listed-after-switch-cancel', historyReadyAfterSwitch, {
    files: window.__onwardGitHistoryDebug?.getFiles?.().map((file) => file.filename) ?? []
  })
  if (!historyReadyAfterSwitch || cancelled()) return results

  window.__onwardGitHistoryDebug?.selectFileByPath?.(manifest.largeFile)
  const historyPromptAfterSwitch = await waitFor('glf-history-prompt-visible-after-switch-cancel', () => {
    return window.__onwardGitHistoryDebug?.getLargeFileConfirmState?.().visible === true
  }, 8000)
  record('GLF-09c-history-prompts-after-switch-cancel', historyPromptAfterSwitch, {
    prompt: window.__onwardGitHistoryDebug?.getLargeFileConfirmState?.() ?? null
  })
  if (!historyPromptAfterSwitch || cancelled()) return results

  window.__onwardGitHistoryDebug?.cancelLargeFile?.()
  const historyCancelled = await waitFor('glf-history-cancelled-message', () => {
    const error = window.__onwardGitHistoryDebug?.getDiffError?.()
    return Boolean(error?.includes('3 MB'))
  }, 5000)
  record('GLF-10-history-cancel-shows-clear-message', historyCancelled, {
    error: window.__onwardGitHistoryDebug?.getDiffError?.() ?? null
  })
  if (cancelled()) return results

  const historyReloadTriggered = window.__onwardGitHistoryDebug?.reloadSelectedFileContent?.() ?? false
  const historyPromptAgain = await waitFor('glf-history-prompt-visible-again', () => {
    return window.__onwardGitHistoryDebug?.getLargeFileConfirmState?.().visible === true
  }, 8000)
  record('GLF-11-history-can-prompt-again-after-reload', historyPromptAgain, {
    reloadTriggered: historyReloadTriggered,
    prompt: window.__onwardGitHistoryDebug?.getLargeFileConfirmState?.() ?? null
  })
  if (!historyPromptAgain || cancelled()) return results

  // GLF-14/15 — unified modal dismiss on the armed (pre-confirm) prompt.
  const historyBackdropClicked = clickLargeFileBackdrop()
  await settleDelay()
  const historyPromptStillVisible = window.__onwardGitHistoryDebug?.getLargeFileConfirmState?.().visible === true
  record('GLF-14-history-backdrop-click-keeps-prompt', historyBackdropClicked && historyPromptStillVisible, {
    backdropClicked: historyBackdropClicked,
    prompt: window.__onwardGitHistoryDebug?.getLargeFileConfirmState?.() ?? null
  })
  if (cancelled()) return results

  pressEscape()
  const historyEscSettled = await waitFor('glf-history-esc-cancels-prompt', () => {
    return window.__onwardGitHistoryDebug?.getLargeFileConfirmState?.().visible !== true
  }, 5000)
  const historyStillOpen = window.__onwardGitHistoryDebug?.isOpen?.() === true
  record('GLF-15-history-escape-cancels-prompt-keeps-viewer', historyEscSettled && historyStillOpen, {
    escSettled: historyEscSettled,
    viewerOpen: historyStillOpen
  })
  if (cancelled()) return results

  // Re-arm the prompt for the confirm path below (same reload path GLF-11
  // just proved).
  window.__onwardGitHistoryDebug?.reloadSelectedFileContent?.()
  const historyPromptForConfirm = await waitFor('glf-history-prompt-visible-for-confirm', () => {
    return window.__onwardGitHistoryDebug?.getLargeFileConfirmState?.().visible === true
  }, 8000)
  record('GLF-11b-history-prompt-rearms-after-esc-cancel', historyPromptForConfirm, {
    prompt: window.__onwardGitHistoryDebug?.getLargeFileConfirmState?.() ?? null
  })
  if (!historyPromptForConfirm || cancelled()) return results

  window.__onwardGitHistoryDebug?.confirmLargeFile?.()
  const historyConfirmed = await waitFor('glf-history-confirmed-content', () => {
    const state = window.__onwardGitHistoryDebug?.getSelectedFileContent?.()
    return Boolean(state && !state.loading && !state.error && state.modifiedContent?.includes(manifest.historyMarker))
  }, 12000)
  record('GLF-12-history-continues-after-confirm', historyConfirmed, {
    state: window.__onwardGitHistoryDebug?.getSelectedFileContent?.()
      ? {
          loading: window.__onwardGitHistoryDebug.getSelectedFileContent?.()?.loading,
          error: window.__onwardGitHistoryDebug.getSelectedFileContent?.()?.error,
          modifiedLength: window.__onwardGitHistoryDebug.getSelectedFileContent?.()?.modifiedContent?.length ?? null
        }
      : null
  })
  if (cancelled()) return results

  const historyDisplayed = await waitFor('glf-history-displayed-after-confirm', () => {
    const state = window.__onwardGitHistoryDebug?.getSelectedFileContent?.()
    return Boolean(state && !state.loading && !state.error && state.modifiedContent?.includes(manifest.historyMarker))
  }, 12000)
  record('GLF-13-history-displays-after-confirm', historyDisplayed, {
    state: window.__onwardGitHistoryDebug?.getSelectedFileContent?.()
      ? {
          loading: window.__onwardGitHistoryDebug.getSelectedFileContent?.()?.loading,
          error: window.__onwardGitHistoryDebug.getSelectedFileContent?.()?.error,
          modifiedLength: window.__onwardGitHistoryDebug.getSelectedFileContent?.()?.modifiedContent?.length ?? null
        }
      : null
  })

  return results
}
