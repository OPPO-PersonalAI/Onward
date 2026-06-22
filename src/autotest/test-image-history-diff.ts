/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

import type { AutotestContext, TestResult } from './types'

// Split out of test-image-diff.ts: the Git History image-diff portion owns an
// expensive per-run fixture (a throwaway git repo with two image commits). Under
// EDR every git child spawn is taxed 1.3-12.9s, so the repo build + Git History
// open + image preview tail pushed the combined image-diff suite past the 180s
// per-runner budget (observed TIMEOUT at 181s). Per the split-on-timeout hard
// rule (oversized case, not a product hang), this Git-History subsystem now runs
// as its own sub-5-minute runner (run-image-history-diff-autotest.sh), while the
// GitDiff working-tree-actions + editor-preview portion stays in test-image-diff.ts.
//
// Round-4 fix: the fixture repo is no longer built by writing a `git init &&
// commit && commit` mega-command into the live PTY. On an EDR-throttled Windows
// host the terminal could be parked at a shell "Press any key to continue" pause
// (round-4 log: a `watchman` startup command failed -> "请按任意键继续..."), so
// the autotest's keypress was swallowed by that prompt and the repo was NEVER
// created — getHistory then correctly reported "not a Git repository" (ID-13
// FAIL) and every downstream ID-15..ID-17 cascaded to timeout. The repo is now
// pre-built deterministically by create-image-history-diff-fixture.mjs and its
// path is handed in via ONWARD_AUTOTEST_FIXTURE_EXTRA (the manifest path),
// exactly like the nested-gitlink suite. No PTY, no shell init, no EDR-blocked
// "press any key" race.

interface ImageHistoryFixtureManifest {
  repoPath: string
  pngFile: string
  svgFile: string
}

function normalizePath(value: string): string {
  return value.replace(/\\/g, '/').replace(/\/+$/, '')
}

const dirOf = (p: string): string => p.replace(/[\\/]+$/, '').replace(/[\\/][^\\/]*$/, '')
const baseOf = (p: string): string => p.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? p

async function loadManifest(extraPath: string | null): Promise<ImageHistoryFixtureManifest | null> {
  if (!extraPath) return null
  const result = await window.electronAPI.project.readFile(dirOf(extraPath), baseOf(extraPath))
  if (!result.success || typeof result.content !== 'string') return null
  try {
    return JSON.parse(result.content) as ImageHistoryFixtureManifest
  } catch {
    return null
  }
}

export async function testImageHistoryDiff(ctx: AutotestContext): Promise<TestResult[]> {
  const { log, sleep, waitFor, assert, cancelled, terminalId } = ctx
  const results: TestResult[] = []
  const record = (name: string, ok: boolean, detail?: Record<string, unknown>) => {
    assert(name, ok, detail)
    results.push({ name, ok, detail })
  }

  const getGitHistoryApi = () => window.__onwardGitHistoryDebug

  log('image-history-diff:start', { suite: 'ImageHistoryDiff' })

  const manifest = await loadManifest(window.electronAPI.debug.autotestFixtureExtra)
  if (!manifest) {
    record('ID-13-history-repo-ready', false, {
      reason: 'fixture-manifest-missing',
      extraPath: window.electronAPI.debug.autotestFixtureExtra ?? null
    })
    log('image-history-diff:done', { totalTests: results.length, passed: 0 })
    return results
  }

  const historyRepoPath = manifest.repoPath
  const TEST_IMAGE_FILENAME = manifest.pngFile
  const TEST_SVG_FILENAME = manifest.svgFile

  const matchesFileName = (actual: string | undefined, expected: string) => {
    if (!actual) return false
    return actual === expected || actual.endsWith(`/${expected}`) || actual.endsWith(`\\${expected}`)
  }

  const findHistoryFileIndex = (filename: string) => {
    const fileList = getGitHistoryApi()?.getFiles?.() || []
    return fileList.findIndex((file) => matchesFileName(file.filename, filename))
  }

  const waitForGitHistoryOpen = async (label: string, timeout = 10000) => {
    return waitFor(`git-history-open:${label}`, () => {
      const api = getGitHistoryApi()
      return Boolean(api?.isOpen?.())
    }, timeout)
  }

  const closeGitHistory = async (label: string) => {
    document.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'Escape',
      code: 'Escape',
      bubbles: true,
      cancelable: true
    }))
    return waitFor(`git-history-close:${label}`, () => {
      const api = getGitHistoryApi()
      return !api || !api.isOpen()
    }, 4000)
  }

  // ID-13: the pre-built fixture repo is visible to the product's own history
  // IPC. The repo already exists on disk (the Node builder ran before the app
  // launched), but getGitRepoMeta caches a NEGATIVE "not a repo" result with a
  // short TTL, so a first probe issued before that TTL window can still miss.
  // Poll the product's readiness signal (getHistory success + >=2 commits) with
  // a generous EDR ceiling; it converges in one or two iterations because the
  // repo is genuinely present.
  if (!cancelled()) {
    const HISTORY_REPO_READY_CEILING_MS = 20000
    const HISTORY_REPO_POLL_INTERVAL_MS = 500
    let historyRepoResult = await window.electronAPI.git.getHistory(historyRepoPath, {
      limit: 5,
      skip: 0
    })
    const historyRepoPollStart = Date.now()
    while (
      !(historyRepoResult.success && historyRepoResult.commits.length >= 2) &&
      Date.now() - historyRepoPollStart < HISTORY_REPO_READY_CEILING_MS &&
      !cancelled()
    ) {
      await sleep(HISTORY_REPO_POLL_INTERVAL_MS)
      historyRepoResult = await window.electronAPI.git.getHistory(historyRepoPath, {
        limit: 5,
        skip: 0
      })
    }
    const historyRepoReady = Boolean(historyRepoResult.success && historyRepoResult.commits.length >= 2)
    record('ID-13-history-repo-ready', historyRepoReady, {
      repoPath: historyRepoPath,
      success: historyRepoResult.success,
      commitCount: historyRepoResult.commits.length,
      error: historyRepoResult.error ?? null
    })
  }

  if (!cancelled()) {
    window.dispatchEvent(new CustomEvent('git-history:open', { detail: { terminalId } }))
    const historyOpened = await waitForGitHistoryOpen('image-history-open')
    if (historyOpened) {
      getGitHistoryApi()?.switchRepo?.(historyRepoPath)
    }
    const repoSwitched = historyOpened && await waitFor('git-history-switch-repo', () => {
      const api = getGitHistoryApi()
      return normalizePath(api?.getActiveCwd?.() ?? '') === normalizePath(historyRepoPath)
    }, 10000, 120)
    record('ID-14-git-history-opened', Boolean(historyOpened && repoSwitched), {
      historyOpened,
      repoSwitched,
      activeCwd: getGitHistoryApi()?.getActiveCwd?.() ?? null
    })
  }

  if (!cancelled() && getGitHistoryApi()?.isOpen?.()) {
    const loaded = await waitFor('git-history-files-loaded', () => {
      const api = getGitHistoryApi()
      return Boolean(api && api.getCommitCount() >= 2)
    }, 10000, 120)
    const selected = getGitHistoryApi()?.selectCommitByIndex(0) === true
    const filesLoaded = await waitFor('git-history-image-files', () => {
      const api = getGitHistoryApi()
      const files = api?.getFiles?.() || []
      return files.some((file) => matchesFileName(file.filename, TEST_IMAGE_FILENAME)) &&
        files.some((file) => matchesFileName(file.filename, TEST_SVG_FILENAME))
    }, 10000, 120)
    record('ID-15-git-history-files-loaded', loaded && selected && filesLoaded, {
      loaded,
      selected,
      files: getGitHistoryApi()?.getFiles?.() || []
    })
  }

  if (!cancelled() && getGitHistoryApi()?.isOpen?.()) {
    const pngIndex = findHistoryFileIndex(TEST_IMAGE_FILENAME)
    const pngSelected = pngIndex >= 0 && getGitHistoryApi()?.selectFileByIndex?.(pngIndex) === true
    const pngPreviewLoaded = pngSelected && await waitFor('git-history-png-state', () => {
      const api = getGitHistoryApi()
      const selected = api?.getSelectedFile?.()
      const state = api?.getImagePreviewState?.()
      return matchesFileName(selected?.filename, TEST_IMAGE_FILENAME) &&
        Boolean(state && !state.loading && !state.isSvg && state.hasOriginalUrl && state.hasModifiedUrl)
    }, 12000, 120)
    const pngState = getGitHistoryApi()?.getImagePreviewState?.()
    record('ID-16-git-history-png-preview', Boolean(pngPreviewLoaded && pngState?.hasOriginalUrl && pngState?.hasModifiedUrl), {
      pngIndex,
      state: pngState || null
    })
    getGitHistoryApi()?.setImageCompareMode?.('swipe')
    await sleep(200)
    const swipeState = getGitHistoryApi()?.getImagePreviewState?.()
    record('ID-16-git-history-png-swipe', swipeState?.compareMode === 'swipe', { state: swipeState || null })
    getGitHistoryApi()?.setImageCompareMode?.('onion')
    await sleep(200)
    const onionState = getGitHistoryApi()?.getImagePreviewState?.()
    record('ID-16-git-history-png-onion', onionState?.compareMode === 'onion', { state: onionState || null })
  }

  if (!cancelled() && getGitHistoryApi()?.isOpen?.()) {
    const svgIndex = findHistoryFileIndex(TEST_SVG_FILENAME)
    const svgSelected = svgIndex >= 0 && getGitHistoryApi()?.selectFileByIndex?.(svgIndex) === true
    const svgPreviewLoaded = svgSelected && await waitFor('git-history-svg-state', () => {
      const api = getGitHistoryApi()
      const selected = api?.getSelectedFile?.()
      const state = api?.getImagePreviewState?.()
      return matchesFileName(selected?.filename, TEST_SVG_FILENAME) &&
        Boolean(state && !state.loading && state.isSvg && state.hasOriginalUrl && state.hasModifiedUrl)
    }, 12000, 120)
    const svgState = getGitHistoryApi()?.getImagePreviewState?.()
    record('ID-17-git-history-svg-preview', Boolean(svgPreviewLoaded && svgState?.isSvg && svgState?.hasOriginalUrl && svgState?.hasModifiedUrl), {
      svgIndex,
      state: svgState || null
    })
    getGitHistoryApi()?.setSvgViewMode?.('text')
    await sleep(200)
    const svgTextState = getGitHistoryApi()?.getImagePreviewState?.()
    record('ID-17-git-history-svg-text-mode', svgTextState?.svgViewMode === 'text', { state: svgTextState || null })
    getGitHistoryApi()?.setSvgViewMode?.('visual')
    await sleep(200)
  }

  if (!cancelled() && getGitHistoryApi()?.isOpen?.()) {
    const historyClosed = await closeGitHistory('image-history-close')
    record('ID-18-git-history-closed', historyClosed)
  }

  // ID-18b completion marker. The fixture repo now lives in a runner-owned temp
  // dir (NOT the repo root), so the runner's cleanup trap removes it; the
  // autotest no longer fires a PTY `rm -rf` command. This record stays as the
  // suite's completion sentinel the runner greps for.
  record('ID-18b-cleanup', true)

  log('image-history-diff:done', { totalTests: results.length, passed: results.filter((result) => result.ok).length })
  return results
}
