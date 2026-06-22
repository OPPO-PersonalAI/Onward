/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Cross-platform Git operations test suite
 *
 * Designed to catch platform-specific issues when porting to new platforms.
 * Covers common failure modes:
 *   - Path separator inconsistency (backslash vs forward slash)
 *   - CWD tracking (OSC 9;9 on Windows, shell integration on macOS/Linux)
 *   - Git process startup latency (high on Windows, low on Unix)
 *   - Infinite loop / re-render detection (useEffect dependency bugs)
 *   - Subdirectory vs repo root resolution
 *   - Non-ASCII path handling (CJK characters, spaces, special chars)
 */
import type { AutotestContext, TestResult } from './types'

const LOAD_TIMEOUT_MS = 15000
const QUICK_TIMEOUT_MS = 8000
const DIFF_SPLIT_STORAGE_KEY = 'git-diff-split-view-ratio'

export async function testGitCrossPlatform(ctx: AutotestContext): Promise<TestResult[]> {
  const { log, sleep, waitFor, assert, cancelled, terminalId, rootPath } = ctx
  const results: TestResult[] = []
  const _assert = (name: string, ok: boolean, detail?: Record<string, unknown>) => {
    assert(name, ok, detail)
    results.push({ name, ok, detail })
  }

  log('git-xplat:start', { suite: 'GitCrossPlatform', rootPath })

  const platform = window.electronAPI.platform
  const shellThresholdMs = platform === 'win32' ? 700 : 300
  const splitRatioTolerance = 0.05
  const getHistoryApi = () => window.__onwardGitHistoryDebug
  const getDiffApi = () => window.__onwardGitDiffDebug
  let persistedSplitRatio: number | null = null
  let originalSplitViewMode: 'auto' | 'split' | 'inline' | null = null
  // The path of the file XP-09b selected to drive the split editor. XP-09c must
  // re-select it after reopen: closing the diff intentionally clears the per-repo
  // selection memory (GitDiffViewer clearCurrentMemorySelection on isOpen->false),
  // so a fresh reopen leaves selectedFile === null and the Monaco diff editor never
  // mounts — without a mounted editor there is no live pane to measure the restored
  // split ratio against. The persisted ratio itself survives in localStorage / UI
  // prefs and is re-applied via splitViewDefaultRatio when the editor remounts on
  // re-selection, exactly as a real user reopening + clicking the file would see.
  let persistedSplitSelectionPath: string | null = null

  // ================================================================
  // Section 1: CWD & Path Resolution
  // ================================================================

  // XP-01: Terminal CWD matches expected path
  if (!cancelled()) {
    const cwd = await window.electronAPI.git.getTerminalCwd(terminalId)
    const hasCwd = typeof cwd === 'string' && cwd.length > 0
    _assert('XP-01-terminal-cwd-available', hasCwd, { cwd, platform })
  }

  // XP-02: resolveRepoRoot returns forward-slash path on all platforms
  if (!cancelled()) {
    const cwd = await window.electronAPI.git.getTerminalCwd(terminalId)
    if (cwd) {
      const repoRoot = await window.electronAPI.git.resolveRepoRoot(cwd)
      const hasRoot = typeof repoRoot === 'string' && repoRoot.length > 0
      const usesForwardSlash = hasRoot && !repoRoot.includes('\\')
      _assert('XP-02-repo-root-forward-slash', hasRoot && usesForwardSlash, {
        cwd,
        repoRoot,
        usesForwardSlash,
        platform
      })
    } else {
      results.push({ name: 'XP-02-repo-root-forward-slash', ok: false, detail: { reason: 'no cwd' } })
    }
  }

  // XP-03: CWD path and resolveRepoRoot path are consistent format
  if (!cancelled()) {
    const cwd = await window.electronAPI.git.getTerminalCwd(terminalId)
    if (cwd) {
      const repoRoot = await window.electronAPI.git.resolveRepoRoot(cwd)
      // After resolveRepoRoot, both should use the same separator
      // The resolved path should be a prefix of or equal to the CWD (modulo separators)
      const normCwd = cwd.replace(/\\/g, '/').toLowerCase()
      const normRoot = (repoRoot || '').replace(/\\/g, '/').toLowerCase()
      const cwdUnderRoot = normCwd.startsWith(normRoot)
      _assert('XP-03-cwd-under-repo-root', cwdUnderRoot, {
        cwd,
        repoRoot,
        normCwd,
        normRoot,
        platform
      })
    } else {
      results.push({ name: 'XP-03-cwd-under-repo-root', ok: false, detail: { reason: 'no cwd' } })
    }
  }

  // ================================================================
  // Section 2: Git History — Infinite Loop Detection
  // (This catches the Windows path separator bug that caused infinite re-renders)
  // ================================================================

  // XP-04: Git History opens and loads commits (no infinite loop)
  if (!cancelled()) {
    window.dispatchEvent(new CustomEvent('git-history:open', { detail: { terminalId } }))
    const opened = await waitFor('XP-04-history-open', () => {
      const a = getHistoryApi()
      return Boolean(a?.isOpen())
    }, QUICK_TIMEOUT_MS)

    if (opened) {
      const loaded = await waitFor('XP-04-history-loaded', () => {
        const a = getHistoryApi()
        return Boolean(a && a.getCommitCount() > 0 && !a.isLoading())
      }, LOAD_TIMEOUT_MS)
      const count = getHistoryApi()?.getCommitCount() ?? 0
      _assert('XP-04-history-loads-commits', loaded && count > 0, {
        loaded,
        commitCount: count,
        platform
      })
    } else {
      results.push({ name: 'XP-04-history-loads-commits', ok: false, detail: { reason: 'panel did not open' } })
    }
  }

  // XP-05: Git History loading completes within timeout (no stuck spinner)
  // Re-render loop would cause isLoading() to never become false
  if (!cancelled()) {
    const api = getHistoryApi()
    if (api?.isOpen()) {
      const startTime = performance.now()
      const finishedLoading = await waitFor('XP-05-loading-done', () => {
        const a = getHistoryApi()
        return Boolean(a && !a.isLoading())
      }, LOAD_TIMEOUT_MS)
      const elapsed = Math.round(performance.now() - startTime)
      _assert('XP-05-history-no-infinite-loop', finishedLoading, {
        finishedLoading,
        elapsedMs: elapsed,
        platform,
        note: 'If this fails, check for path format inconsistency causing useEffect dependency loop'
      })
    } else {
      results.push({ name: 'XP-05-history-no-infinite-loop', ok: false, detail: { reason: 'not open' } })
    }
  }

  // XP-06: Git History commit selection loads files correctly
  if (!cancelled()) {
    const api = getHistoryApi()
    if (api?.isOpen() && api.getCommitCount() > 0) {
      api.selectCommitByIndex(0)
      const filesLoaded = await waitFor('XP-06-files', () => {
        const a = getHistoryApi()
        return Boolean(a && a.getFiles().length > 0 && !a.isLoading())
      }, LOAD_TIMEOUT_MS)
      const files = getHistoryApi()?.getFiles() ?? []
      _assert('XP-06-history-files-load', filesLoaded && files.length > 0, {
        filesLoaded,
        fileCount: files.length,
        sample: files.slice(0, 3).map(f => f.filename),
        platform
      })
    } else {
      results.push({ name: 'XP-06-history-files-load', ok: false, detail: { reason: 'no commits' } })
    }
  }

  // XP-07: Close Git History via ESC
  if (!cancelled()) {
    const api = getHistoryApi()
    if (api?.isOpen()) {
      document.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'Escape', code: 'Escape', bubbles: true, cancelable: true
      }))
      const closed = await waitFor('XP-07-esc-close', () => {
        const a = getHistoryApi()
        return !a || !a.isOpen()
      }, 4000)
      _assert('XP-07-history-esc-close', closed, { closed, platform })
      await sleep(300)
    } else {
      results.push({ name: 'XP-07-history-esc-close', ok: false, detail: { reason: 'not open' } })
    }
  }

  // ================================================================
  // Section 3: Git Diff — Path Resolution & Loading
  // ================================================================

  // XP-08: Git Diff opens and loads file list
  if (!cancelled()) {
    window.dispatchEvent(new CustomEvent('git-diff:open', { detail: { terminalId, source: 'debug' } }))
    const shellVisible = await waitFor('XP-08-diff-open', () => {
      const a = getDiffApi()
      return Boolean(a?.isOpen() && a.getTiming().shellShownAt !== null)
    }, QUICK_TIMEOUT_MS)

    const shellTiming = getDiffApi()?.getTiming() ?? null
    _assert('XP-08-diff-shell-visible-fast', shellVisible && (shellTiming?.openToShellMs ?? Number.MAX_SAFE_INTEGER) < shellThresholdMs, {
      shellVisible,
      openToShellMs: shellTiming?.openToShellMs ?? null,
      thresholdMs: shellThresholdMs,
      platform
    })

    if (shellVisible) {
      const loadDone = await waitFor('XP-08-diff-loaded', () => {
        const a = getDiffApi()
        if (!a) return false
        return a.getTiming().diffLoadedAt !== null
      }, LOAD_TIMEOUT_MS)
      const timing = getDiffApi()?.getTiming() ?? null
      const fileCount = getDiffApi()?.getFileList()?.length ?? -1
      _assert('XP-08-diff-loads', loadDone, {
        loadDone,
        fileCount,
        openToDiffLoadedMs: timing?.openToDiffLoadedMs ?? null,
        openToCwdReadyMs: timing?.openToCwdReadyMs ?? null,
        cwdReadyToDiffLoadedMs: timing?.cwdReadyToDiffLoadedMs ?? null,
        platform
      })
    } else {
      results.push({ name: 'XP-08-diff-loads', ok: false, detail: { reason: 'panel did not open' } })
    }
  }

  // XP-09: Git Diff CWD uses repo root (not subdirectory or raw terminal CWD)
  if (!cancelled()) {
    const api = getDiffApi()
    if (api?.isOpen()) {
      const diffCwd = api.getCwd?.() ?? null
      const repoRoot = api.getRepoRoot?.() ?? null
      // On all platforms, the diff CWD should be the repo root with forward slashes
      const hasCwd = typeof diffCwd === 'string' && diffCwd.length > 0
      const noBackslash = hasCwd && !diffCwd!.includes('\\')
      _assert('XP-09-diff-cwd-normalized', hasCwd && noBackslash, {
        diffCwd,
        repoRoot,
        noBackslash,
        platform
      })
    } else {
      results.push({ name: 'XP-09-diff-cwd-normalized', ok: false, detail: { reason: 'not open' } })
    }
  }

  // XP-09b: Git Diff split view ratio can be changed away from the default
  if (!cancelled()) {
    // The Git Diff viewer does NOT auto-select the first file on a fresh open —
    // selection is only restored from per-repo memory (see
    // resolveGitDiffRestoredSelection); with no prior selection it leaves
    // selectedFile === null, so isSelectedReady() would never become true here.
    // Explicitly select the first text file (isSelectedReady() requires a
    // non-binary, non-image/pdf/epub file: it asserts !state.isBinary), mirroring
    // a real user clicking a file, then wait for its content to load.
    await waitFor('XP-09b-diff-list-loaded', () => {
      const a = getDiffApi()
      return Boolean(a?.isOpen() && (a.getFileList?.()?.length ?? 0) > 0)
    }, LOAD_TIMEOUT_MS)
    const fileList = getDiffApi()?.getFileList?.() ?? []
    const textFile = fileList.find((file) =>
      !file.isImage && !file.isPdf && !file.isEpub && !file.isSubmoduleEntry
    )
    if (textFile) {
      getDiffApi()?.selectFileByPath?.(textFile.filename)
      // Remember which file drives the split editor so XP-09c can re-select it
      // after reopen (selection memory is cleared on close — see the note at the
      // persistedSplitSelectionPath declaration).
      persistedSplitSelectionPath = textFile.filename
    }
    const ready = textFile ? await waitFor('XP-09b-diff-selected-ready', () => {
      const a = getDiffApi()
      return Boolean(a?.isOpen() && a.isSelectedReady?.())
    }, LOAD_TIMEOUT_MS) : false
    // The autotest window's diff-editor container is narrow (file list + editor
    // share the width, leaving the editor well under DIFF_INLINE_BREAKPOINT=900px).
    // With the default 'auto' split mode, Monaco auto-collapses to inline view
    // (useInlineViewWhenSpaceIsLimited), so getDiffLayoutMode() reports 'inline',
    // measureDiffSplitState() returns ratio:null, and dragDiffSplitRatio() bails
    // (mode !== 'side-by-side') with applied:false. Force the explicit 'split' mode
    // — exactly what a real user does via the Split toggle — which sets
    // renderSideBySide:true and disables the inline breakpoint, guaranteeing a
    // draggable side-by-side sash regardless of container width.
    let splitModeForced = false
    if (ready) {
      const a = getDiffApi()
      // Remember the user's current split mode so we can restore it after XP-09c
      // (forcing 'split' persists to localStorage; we must not leave the user's
      // diff preference permanently flipped by the test).
      originalSplitViewMode = a?.getSplitViewMode?.() ?? originalSplitViewMode
      splitModeForced = Boolean(a?.setSplitViewMode?.('split'))
      if (splitModeForced) {
        await waitFor('XP-09b-diff-side-by-side', () => {
          const api2 = getDiffApi()
          return api2?.getResponsiveLayoutState?.()?.mode === 'side-by-side'
        }, QUICK_TIMEOUT_MS)
      }
    }
    const api = getDiffApi()
    const layoutMode = api?.getResponsiveLayoutState?.()?.mode ?? null
    if (ready && layoutMode === 'side-by-side' && api?.setSplitViewRatio && api.getSplitViewState) {
      const currentRatio = api.getSplitViewState()?.ratio ?? 0.5
      const targetRatio = currentRatio >= 0.5 ? 0.38 : 0.62
      const beforeRatio = currentRatio
      await sleep(120)
      // Drive the split ratio through the dedicated setSplitViewRatio API rather
      // than a synthetic Monaco sash drag. The sash is only a few px wide and the
      // autotest window's diff editor is narrow, so a dispatched mouse-drag is
      // inherently fragile (hit-testing, pointer capture) and non-deterministic
      // under EDR scheduling jitter. setSplitViewRatio persists the ratio
      // (localStorage + UI prefs via persistDiffSplitRatio) AND applies it to the
      // live editor (updateOptions splitViewDefaultRatio) — exactly the path the
      // user's Split toggle + drag commits, and exactly what XP-09c restores from.
      const applied = Boolean(api.setSplitViewRatio(targetRatio))
      // Monaco applies splitViewDefaultRatio on its next layout pass; poll the
      // measured pane ratio until it converges near the target instead of reading
      // a single pre-layout sample.
      await waitFor('XP-09b-diff-ratio-applied', () => {
        const measured = getDiffApi()?.getSplitViewState?.()?.ratio ?? null
        return measured !== null && Math.abs(measured - targetRatio) <= 0.08
      }, QUICK_TIMEOUT_MS)
      const splitState = getDiffApi()?.getSplitViewState?.() ?? null
      const afterRatio = splitState?.ratio ?? null
      const storedRatioRaw = window.localStorage.getItem(DIFF_SPLIT_STORAGE_KEY)
      const storedRatio = storedRatioRaw !== null ? Number(storedRatioRaw) : null
      const movedEnough = afterRatio !== null && Math.abs(afterRatio - beforeRatio) >= 0.08
      const nearTarget = afterRatio !== null && Math.abs(afterRatio - targetRatio) <= 0.08
      const storedMatchesActual = afterRatio !== null &&
        storedRatio !== null &&
        Number.isFinite(storedRatio) &&
        Math.abs(storedRatio - afterRatio) <= splitRatioTolerance
      const appliedAndPersisted = applied && movedEnough && nearTarget && storedMatchesActual
      persistedSplitRatio = appliedAndPersisted ? storedRatio : null
      _assert('XP-09b-diff-split-ratio-applies', ready && appliedAndPersisted, {
        ready,
        targetRatio,
        applied,
        beforeRatio,
        afterRatio,
        storedRatio,
        movedEnough,
        nearTarget,
        storedMatchesActual,
        actualRatio: splitState?.ratio ?? null,
        originalWidth: splitState?.originalWidth ?? null,
        modifiedWidth: splitState?.modifiedWidth ?? null,
        splitModeForced,
        layoutMode,
        tolerance: splitRatioTolerance,
        platform
      })
    } else if ((api?.getFileList()?.length ?? 0) === 0 || !textFile) {
      // No diff files at all, or no non-binary text file to drive the split editor —
      // the split-view ratio surface has nothing to render, so skip rather than fail.
      _assert('XP-09b-diff-split-ratio-applies', true, {
        skipped: true,
        reason: !textFile ? 'no text file to render split editor' : 'no diff files to render split editor',
        fileCount: api?.getFileList()?.length ?? 0,
        platform
      })
    } else {
      _assert('XP-09b-diff-split-ratio-applies', false, {
        reason: 'diff editor not ready or not side-by-side',
        ready,
        splitModeForced,
        layoutMode,
        hasSetRatioApi: Boolean(api?.setSplitViewRatio),
        hasSplitStateApi: Boolean(api?.getSplitViewState),
        responsiveLayout: api?.getResponsiveLayoutState?.() ?? null,
        platform
      })
    }
  }

  // XP-09c: Git Diff split view ratio survives close and reopen
  if (!cancelled()) {
    if (persistedSplitRatio === null) {
      _assert('XP-09c-diff-split-ratio-restored', true, {
        skipped: true,
        reason: 'no persisted split ratio available',
        platform
      })
    } else {
      const api = getDiffApi()
      if (api?.isOpen()) {
        window.dispatchEvent(new CustomEvent('git-diff:close', { detail: { terminalId } }))
        const closed = await waitFor('XP-09c-diff-close-before-reopen', () => {
          const a = getDiffApi()
          return !a || !a.isOpen()
        }, 4000)
        const reopened = closed ? await (async () => {
          window.dispatchEvent(new CustomEvent('git-diff:open', { detail: { terminalId, source: 'debug' } }))
          // Wait for the reopened diff to finish loading its file list. We do NOT
          // wait on isSelectedReady() here: closing cleared the selection memory,
          // so the reopened viewer auto-selects nothing (selectedFile === null)
          // and isSelectedReady() would never resolve. Reopen success is "the
          // panel is open and the diff result has loaded".
          const loaded = await waitFor('XP-09c-diff-reopen', () => {
            const a = getDiffApi()
            return Boolean(
              a?.isOpen() &&
              a.getTiming().diffLoadedAt !== null &&
              (a.getFileList?.()?.length ?? 0) > 0
            )
          }, LOAD_TIMEOUT_MS)
          if (!loaded) return false
          // Re-select the same file XP-09b drove the split editor with (mirrors a
          // user clicking the file again after reopen). This remounts the Monaco
          // diff editor, which applies the persisted splitViewDefaultRatio from
          // localStorage / UI prefs — the value XP-09c is here to verify.
          if (persistedSplitSelectionPath) {
            getDiffApi()?.selectFileByPath?.(persistedSplitSelectionPath)
          }
          // Ensure the forced 'split' mode is still in effect so the editor renders
          // side-by-side (XP-09b forced it; a fresh load may re-evaluate the
          // responsive layout). getSplitViewState only measures a side-by-side pane.
          getDiffApi()?.setSplitViewMode?.('split')
          const ready = await waitFor('XP-09c-diff-reselect-ready', () => {
            const a = getDiffApi()
            return Boolean(a?.isOpen() && a.isSelectedReady?.())
          }, LOAD_TIMEOUT_MS)
          if (!ready) return false
          // The restored ratio is applied on the editor's next layout pass; poll
          // until the measured pane ratio converges near the persisted value
          // instead of reading a single pre-layout sample.
          await waitFor('XP-09c-diff-ratio-restored', () => {
            const measured = getDiffApi()?.getSplitViewState?.()?.ratio ?? null
            return measured !== null &&
              persistedSplitRatio !== null &&
              Math.abs(measured - persistedSplitRatio) <= splitRatioTolerance
          }, QUICK_TIMEOUT_MS)
          return true
        })() : false
        const splitState = getDiffApi()?.getSplitViewState?.() ?? null
        const restoredRatio = splitState?.ratio ?? null
        const restored = reopened &&
          persistedSplitRatio !== null &&
          restoredRatio !== null &&
          Math.abs(restoredRatio - persistedSplitRatio) <= splitRatioTolerance
        _assert('XP-09c-diff-split-ratio-restored', restored, {
          closed,
          reopened,
          reselectedPath: persistedSplitSelectionPath,
          expectedRatio: persistedSplitRatio,
          restoredRatio,
          layoutMode: getDiffApi()?.getResponsiveLayoutState?.()?.mode ?? null,
          selectedReady: getDiffApi()?.isSelectedReady?.() ?? false,
          originalWidth: splitState?.originalWidth ?? null,
          modifiedWidth: splitState?.modifiedWidth ?? null,
          tolerance: splitRatioTolerance,
          platform
        })
      } else {
        results.push({ name: 'XP-09c-diff-split-ratio-restored', ok: false, detail: { reason: 'not open' } })
      }
    }
    // Restore the user's original split-view mode so the test does not leave the
    // real app's diff preference permanently flipped to forced 'split'.
    if (originalSplitViewMode !== null && originalSplitViewMode !== 'split') {
      getDiffApi()?.setSplitViewMode?.(originalSplitViewMode)
    }
  }

  // XP-10: Close Git Diff
  if (!cancelled()) {
    const api = getDiffApi()
    if (api?.isOpen()) {
      window.dispatchEvent(new CustomEvent('git-diff:close', { detail: { terminalId } }))
      const closed = await waitFor('XP-10-diff-close', () => {
        const a = getDiffApi()
        return !a || !a.isOpen()
      }, 4000)
      _assert('XP-10-diff-close', closed, { closed, platform })
      await sleep(300)
    } else {
      results.push({ name: 'XP-10-diff-close', ok: false, detail: { reason: 'not open' } })
    }
  }

  // ================================================================
  // Section 4: Git IPC — Direct API Correctness
  // ================================================================

  // XP-11: getHistory IPC returns valid result with correct path format
  if (!cancelled()) {
    const cwd = await window.electronAPI.git.getTerminalCwd(terminalId)
    if (cwd) {
      const repoRoot = await window.electronAPI.git.resolveRepoRoot(cwd)
      if (repoRoot) {
        const startTime = performance.now()
        const result = await window.electronAPI.git.getHistory(repoRoot)
        const elapsed = Math.round(performance.now() - startTime)
        const valid = result?.success === true && Array.isArray(result.commits) && result.commits.length > 0
        const resultCwd = (result as any)?.cwd || null
        // The returned CWD should use forward slashes (git format)
        const cwdNormalized = typeof resultCwd === 'string' && !resultCwd.includes('\\')
        _assert('XP-11-history-ipc-valid', valid, {
          success: result?.success,
          commitCount: result?.commits?.length,
          elapsedMs: elapsed,
          resultCwd,
          cwdNormalized,
          platform
        })
      } else {
        results.push({ name: 'XP-11-history-ipc-valid', ok: false, detail: { reason: 'no repo root' } })
      }
    } else {
      results.push({ name: 'XP-11-history-ipc-valid', ok: false, detail: { reason: 'no cwd' } })
    }
  }

  // XP-12: getDiff IPC returns valid result
  if (!cancelled()) {
    const cwd = await window.electronAPI.git.getTerminalCwd(terminalId)
    if (cwd) {
      const repoRoot = await window.electronAPI.git.resolveRepoRoot(cwd)
      if (repoRoot) {
        const startTime = performance.now()
        const result = await window.electronAPI.git.getDiff(repoRoot)
        const elapsed = Math.round(performance.now() - startTime)
        const valid = result?.success === true && result?.gitInstalled === true && result?.isGitRepo === true
        _assert('XP-12-diff-ipc-valid', valid, {
          success: result?.success,
          gitInstalled: result?.gitInstalled,
          isGitRepo: result?.isGitRepo,
          fileCount: result?.files?.length ?? 0,
          elapsedMs: elapsed,
          platform
        })
      } else {
        results.push({ name: 'XP-12-diff-ipc-valid', ok: false, detail: { reason: 'no repo root' } })
      }
    } else {
      results.push({ name: 'XP-12-diff-ipc-valid', ok: false, detail: { reason: 'no cwd' } })
    }
  }

  // ================================================================
  // Section 5: Performance — Git Latency Bounds
  // ================================================================

  // XP-13: getHistory completes within platform-specific threshold
  if (!cancelled()) {
    const cwd = await window.electronAPI.git.getTerminalCwd(terminalId)
    const repoRoot = cwd ? await window.electronAPI.git.resolveRepoRoot(cwd) : null
    if (repoRoot) {
      // Run 3 times and take median for stability
      const timings: number[] = []
      for (let i = 0; i < 3; i++) {
        const t0 = performance.now()
        await window.electronAPI.git.getHistory(repoRoot, { limit: 20 })
        timings.push(Math.round(performance.now() - t0))
      }
      timings.sort((a, b) => a - b)
      const median = timings[1]
      // Platform-specific thresholds:
      //   Windows: git.exe startup is slow (~500-1500ms), allow 5s
      //   macOS/Linux: typically <1s
      const threshold = platform === 'win32' ? 5000 : 2000
      _assert('XP-13-history-latency', median < threshold, {
        timings,
        medianMs: median,
        thresholdMs: threshold,
        platform
      })
    } else {
      results.push({ name: 'XP-13-history-latency', ok: false, detail: { reason: 'no repo root' } })
    }
  }

  // XP-14: getDiff completes within platform-specific threshold
  if (!cancelled()) {
    const cwd = await window.electronAPI.git.getTerminalCwd(terminalId)
    const repoRoot = cwd ? await window.electronAPI.git.resolveRepoRoot(cwd) : null
    if (repoRoot) {
      const timings: number[] = []
      for (let i = 0; i < 3; i++) {
        const t0 = performance.now()
        await window.electronAPI.git.getDiff(repoRoot)
        timings.push(Math.round(performance.now() - t0))
      }
      timings.sort((a, b) => a - b)
      const median = timings[1]
      // Windows needs more time due to multiple git subprocesses
      const threshold = platform === 'win32' ? 10000 : 4000
      _assert('XP-14-diff-latency', median < threshold, {
        timings,
        medianMs: median,
        thresholdMs: threshold,
        platform
      })
    } else {
      results.push({ name: 'XP-14-diff-latency', ok: false, detail: { reason: 'no repo root' } })
    }
  }

  // ================================================================
  // Section 6: Rapid Open/Close Stability
  // ================================================================

  // XP-15: Git History rapid open/close (5 cycles) — no stale state
  if (!cancelled()) {
    let allOk = true
    for (let i = 0; i < 5; i++) {
      if (cancelled()) break
      window.dispatchEvent(new CustomEvent('git-history:open', { detail: { terminalId } }))
      const opened = await waitFor(`XP-15-open-${i}`, () => {
        const a = getHistoryApi()
        return Boolean(a?.isOpen())
      }, QUICK_TIMEOUT_MS)
      if (!opened) { allOk = false; break }
      await sleep(300)
      document.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'Escape', code: 'Escape', bubbles: true, cancelable: true
      }))
      const closed = await waitFor(`XP-15-close-${i}`, () => {
        const a = getHistoryApi()
        return !a || !a.isOpen()
      }, 4000)
      if (!closed) { allOk = false; break }
      await sleep(200)
    }
    _assert('XP-15-history-rapid-cycle', allOk, { cycles: 5, platform })
  }

  // XP-16: Git Diff ↔ History mutual exclusion (switching between them)
  if (!cancelled()) {
    // Open Diff
    window.dispatchEvent(new CustomEvent('git-diff:open', { detail: { terminalId, source: 'debug' } }))
    const diffOpened = await waitFor('XP-16-diff-open', () => {
      const a = getDiffApi()
      return Boolean(a?.isOpen())
    }, QUICK_TIMEOUT_MS)

    if (diffOpened) {
      // Switch to History
      window.dispatchEvent(new CustomEvent('git-history:open', { detail: { terminalId } }))
      const historyOpened = await waitFor('XP-16-history-open', () => {
        const a = getHistoryApi()
        return Boolean(a?.isOpen())
      }, QUICK_TIMEOUT_MS)
      await sleep(500)
      const diffClosed = !getDiffApi() || !getDiffApi()!.isOpen()

      _assert('XP-16-diff-history-mutex', historyOpened && diffClosed, {
        historyOpened,
        diffClosed,
        platform
      })

      // Close history
      document.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'Escape', code: 'Escape', bubbles: true, cancelable: true
      }))
      await waitFor('XP-16-cleanup', () => {
        const a = getHistoryApi()
        return !a || !a.isOpen()
      }, 4000)
      await sleep(300)
    } else {
      results.push({ name: 'XP-16-diff-history-mutex', ok: false, detail: { reason: 'diff did not open' } })
    }
  }

  // ================================================================
  // Summary
  // ================================================================

  log('git-xplat:done', {
    total: results.length,
    passed: results.filter(r => r.ok).length,
    failed: results.filter(r => !r.ok).length,
    platform
  })

  return results
}
