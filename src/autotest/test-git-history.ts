/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Phase 3: Git History test (git_log branch)
 */
import type { AutotestContext, TestResult } from './types'

export async function testGitHistory(ctx: AutotestContext): Promise<TestResult[]> {
  const { log, sleep, waitFor, assert, cancelled, terminalId } = ctx
  const results: TestResult[] = []
  const _assert = (name: string, ok: boolean, detail?: Record<string, unknown>) => {
    assert(name, ok, detail)
    results.push({ name, ok, detail })
  }

  log('phase3:start', { suite: 'GitHistory' })

  const getApi = () => window.__onwardGitHistoryDebug

  const openGitHistory = async (label: string) => {
    window.dispatchEvent(new CustomEvent('git-history:open', { detail: { terminalId } }))
    return await waitFor(`git-history-open:${label}`, () => {
      const api = getApi()
      return Boolean(api?.isOpen())
    }, 8000)
  }

  const closeGitHistory = async (label: string) => {
    // Close GitHistory using ESC (no git-history:close global event)
    document.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'Escape', code: 'Escape', bubbles: true, cancelable: true
    }))
    await waitFor(`git-history-close:${label}`, () => {
      const api = getApi()
      return !api || !api.isOpen()
    }, 4000)
    await sleep(300)
  }

  const dispatchEscape = () => {
    document.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'Escape',
      code: 'Escape',
      bubbles: true,
      cancelable: true
    }))
  }

  // GH-01: Event opens GitHistory
  if (!cancelled()) {
    const opened = await openGitHistory('GH-01')
    _assert('GH-01-event-open', opened, { opened })
  }

  // GH-02: Load commit list
  if (!cancelled()) {
    if (getApi()?.isOpen()) {
      const loaded = await waitFor('GH-02-commits', () => {
        const a = getApi()
        return Boolean(a && a.getCommitCount() > 0)
      }, 10000)
      const count = getApi()?.getCommitCount() ?? 0
      _assert('GH-02-load-commits', loaded && count > 0, { count })
    } else {
      results.push({ name: 'GH-02-load-commits', ok: false, detail: { reason: 'not open' } })
    }
  }

  // GH-03: Select Submit Load File
  if (!cancelled()) {
    if (getApi()?.isOpen() && getApi()!.getCommitCount() > 0) {
      const selected = getApi()!.selectCommitByIndex(0)
      const filesLoaded = await waitFor('GH-03-files', () => {
        const a = getApi()
        return Boolean(a && a.getFiles().length > 0)
      }, 8000)
      const files = getApi()?.getFiles() ?? []
      _assert('GH-03-select-commit-files', selected && filesLoaded && files.length > 0, {
        selected,
        filesLoaded,
        fileCount: files.length,
        sample: files.slice(0, 3).map(f => f.filename)
      })
    } else {
      results.push({ name: 'GH-03-select-commit-files', ok: false, detail: { reason: 'no commits' } })
    }
  }

  // GH-03b: Entering a commit must NOT auto-expand a file diff.
  // Selecting a commit shows the file list, but the diff pane stays on the
  // placeholder until the user clicks a file — no heavy render on entry.
  if (!cancelled()) {
    const api = getApi()
    if (api?.isOpen() && api.getFiles().length > 0) {
      const autoSelected = api.getSelectedFile()
      _assert('GH-03b-no-auto-expand-on-entry', autoSelected === null, {
        autoSelected,
        fileCount: api.getFiles().length
      })
    } else {
      results.push({ name: 'GH-03b-no-auto-expand-on-entry', ok: false, detail: { reason: 'no files' } })
    }
  }

  // GH-04: Select file to view diff
  if (!cancelled()) {
    if (getApi()?.isOpen() && getApi()!.getFiles().length > 0) {
      const selected = getApi()!.selectFileByIndex(0)
      await sleep(500)
      const selectedFile = getApi()?.getSelectedFile() ?? null
      _assert('GH-04-select-file', selected && selectedFile !== null, {
        selected,
        selectedFile
      })
    } else {
      results.push({ name: 'GH-04-select-file', ok: false, detail: { reason: 'no files' } })
    }
  }

  // GH-05: Diff display mode default and switching
  if (!cancelled()) {
    if (getApi()?.isOpen()) {
      // Pre-existing test bug (independent of the no-auto-expand change): the
      // debug api object is rebuilt on every render (its host effect lists
      // diffDisplayMode in its deps), so a captured `const api = getApi()`
      // reference goes stale the moment setDiffDisplayMode triggers a re-render
      // — a captured api.getDiffDisplayMode() then returns the value its closure
      // captured at creation time. Always re-fetch getApi() for each read/write
      // so we observe the live state, never a stale closure.
      const readMode = (): 'inline' | 'side-by-side' => {
        const a = getApi()
        return a?.getDiffDisplayMode?.() ?? (a?.getDiffStyle() === 'unified' ? 'inline' : 'side-by-side')
      }
      const setMode = (mode: 'side-by-side' | 'inline') => {
        const a = getApi()!
        if (a.setDiffDisplayMode) {
          a.setDiffDisplayMode(mode)
        } else {
          a.setDiffStyle(mode === 'side-by-side' ? 'split' : 'unified')
        }
      }
      const defaultMode = readMode()
      _assert('GH-05a-diff-display-default-inline', defaultMode === 'inline', { defaultMode })
      setMode('side-by-side')
      await sleep(500)
      const mode = readMode()
      _assert('GH-05b-diff-display-side-by-side', mode === 'side-by-side', { mode, style: getApi()?.getDiffStyle() })
      // recover
      setMode('inline')
      await sleep(300)
    } else {
      results.push({ name: 'GH-05-diff-display-default-inline', ok: false, detail: { reason: 'not open' } })
    }
  }

  // GH-06: Hide whitespace toggle
  if (!cancelled()) {
    if (getApi()?.isOpen()) {
      const before = getApi()!.getHideWhitespace()
      getApi()!.setHideWhitespace(!before)
      await sleep(500)
      const after = getApi()!.getHideWhitespace()
      _assert('GH-06-hide-whitespace-toggle', after === !before, {
        before,
        after
      })
      // recover
      getApi()!.setHideWhitespace(before)
      await sleep(300)
    } else {
      results.push({ name: 'GH-06-hide-whitespace-toggle', ok: false, detail: { reason: 'not open' } })
    }
  }

  // GH-07: ESC closes GitHistory
  if (!cancelled()) {
    const api = getApi()
    if (api?.isOpen()) {
      dispatchEscape()
      const closed = await waitFor('GH-07-esc-close', () => {
        const a = getApi()
        return !a || !a.isOpen()
      }, 4000)
      _assert('GH-07-esc-close', closed, { closed })
      await sleep(300)
    } else {
      results.push({ name: 'GH-07-esc-close', ok: false, detail: { reason: 'not open' } })
    }
  }

  // GH-08: Open GitHistory from GitDiff (verify mutex)
  if (!cancelled()) {
    // First open GitDiff
    window.dispatchEvent(new CustomEvent('git-diff:open', { detail: { terminalId, source: 'debug' } }))
    const diffOpened = await waitFor('GH-08-diff-open', () => {
      const api = window.__onwardGitDiffDebug
      return Boolean(api?.isOpen())
    }, 8000)

    if (diffOpened) {
      // Open GitHistory
      const historyOpened = await openGitHistory('GH-08')
      await sleep(500)
      const diffApi = window.__onwardGitDiffDebug
      const histApi = getApi()
      const diffClosed = !diffApi || !diffApi.isOpen()
      _assert('GH-08-diff-to-history', historyOpened && diffClosed, {
        historyOpened,
        diffClosed,
        diffIsOpen: diffApi?.isOpen(),
        histIsOpen: histApi?.isOpen()
      })

      // Close history
      await closeGitHistory('GH-08')
    } else {
      results.push({ name: 'GH-08-diff-to-history', ok: false, detail: { reason: 'git diff did not open' } })
    }
  }

  // GH-09: Quickly open/close 5 times
  if (!cancelled()) {
    let allOk = true
    for (let i = 0; i < 5; i++) {
      if (cancelled()) break
      const opened = await openGitHistory(`GH-09-iter-${i}`)
      if (!opened) { allOk = false; break }
      await sleep(400)
      await closeGitHistory(`GH-09-iter-${i}`)
      await sleep(200)
    }
    const finalClosed = !getApi() || !getApi()!.isOpen()
    _assert('GH-09-rapid-open-close', allOk && finalClosed, {
      iterations: 5,
      allOk,
      finalClosed
    })
  }

  // GH-10: Quickly switch submissions 10 times
  if (!cancelled()) {
    const opened = await openGitHistory('GH-10')
    if (opened) {
      await waitFor('GH-10-commits-ready', () => {
        const a = getApi()
        return Boolean(a && a.getCommitCount() >= 2)
      }, 8000)

      const api = getApi()!
      const commitCount = api.getCommitCount()
      if (commitCount >= 2) {
        for (let i = 0; i < Math.min(10, commitCount); i++) {
          if (cancelled()) break
          api.selectCommitByIndex(i % commitCount)
          await sleep(100)
        }
        // The last one selected is index 9%commitCount
        const lastIndex = (Math.min(10, commitCount) - 1) % commitCount
        api.selectCommitByIndex(lastIndex)
        const filesLoaded = await waitFor('GH-10-final-files', () => {
          const a = getApi()
          return Boolean(a && !a.isLoading())
        }, 8000)
        _assert('GH-10-rapid-commit-switch', filesLoaded, {
          commitCount,
          lastIndex,
          filesLoaded
        })
      } else {
        results.push({ name: 'GH-10-rapid-commit-switch', ok: false, detail: { reason: 'need >=2 commits', commitCount } })
      }
      await closeGitHistory('GH-10')
    } else {
      results.push({ name: 'GH-10-rapid-commit-switch', ok: false, detail: { reason: 'not open' } })
    }
  }

  log('phase3:done', {
    total: results.length,
    passed: results.filter(r => r.ok).length,
    failed: results.filter(r => !r.ok).length
  })

  return results
}
