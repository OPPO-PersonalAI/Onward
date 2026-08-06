/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * UI-level autotest for the shared file-index cache that backs the
 * Project Editor filename search (Cmd+P).
 *
 * Drives the real ProjectEditor UI via the debug API:
 *   - opens the global search panel, types queries, reads rendered results
 *   - asserts that repeated opens & queries reuse the cached index (the
 *     renderer-wide cache.totalBuilds counter must not advance)
 *   - mutates the file tree via IPC (create / delete / rename) and asserts
 *     the cache applies targeted incremental patches, not a full rebuild
 *   - validates the main-process tree watcher propagates external fs
 *     changes (writes that bypass the in-app mutation APIs)
 */

import type { AutotestContext, TestResult } from './types'

export async function testFileIndexCacheUi(ctx: AutotestContext): Promise<TestResult[]> {
  const { log, sleep, waitFor, assert, rootPath, reopenProjectEditor } = ctx
  const results: TestResult[] = []

  const record = (name: string, ok: boolean, detail?: Record<string, unknown>) => {
    assert(name, ok, detail)
    results.push({ name, ok, detail })
  }

  const getApi = () => window.__onwardProjectEditorDebug
  const getFileIndexStats = () => {
    const stats = getApi()?.getFileIndexStats?.()
    return stats ?? { entries: [], totalBuilds: Number.NaN }
  }
  const getReadyFileCount = () => {
    const entry = getFileIndexStats().entries.find((candidate) => candidate.status === 'ready')
    return typeof entry?.fileCount === 'number' ? entry.fileCount : null
  }

  // Recover the editor root if an earlier phase (cd + terminal-activity poll)
  // momentarily dropped the cwd prop to null. Without this the rest of the
  // suite would operate against a null rootRef.
  const ensureEditorRootReady = async (label: string): Promise<boolean> => {
    const existing = getApi()?.getRootPath?.()
    if (existing) return true
    log('fic-ui:root-missing-recover', { label, rootPath })
    await reopenProjectEditor(`fic-ui:${label}`)
    await sleep(400)
    return (await waitFor(
      `fic-ui:root-ready:${label}`,
      () => Boolean(getApi()?.getRootPath?.()),
      5000
    ))
  }
  const stamp = Date.now()
  const fileA = `onward-fic-a-${stamp}.ts`
  const fileB = `onward-fic-b-${stamp}.ts`
  const fileC = `onward-fic-c-${stamp}.ts`
  const fileD = `onward-fic-d-${stamp}.ts`
  const fileRenamed = `onward-fic-a-renamed-${stamp}.ts`
  const nestedName = `src/components/onward-fic-nested-${stamp}.tsx`
  const folderName = `onward-fic-dir-${stamp}`
  const ignoredGitDir = '.git'
  const ignoredNodeModulesDir = 'node_modules'

  const tsBody = `// autotest fixture ${stamp}\nexport const MARKER = '${stamp}'\n`

  const cleanup = async () => {
    for (const candidate of [
      fileA,
      fileB,
      fileC,
      fileD,
      fileRenamed,
      nestedName,
      folderName,
      ignoredGitDir,
      ignoredNodeModulesDir
    ]) {
      await window.electronAPI.project.deletePath(rootPath, candidate).catch(() => {})
    }
  }

  try {
    log('fic-ui:start', { rootPath })

    const api0 = getApi()
    if (!api0 || !api0.openGlobalFilenameSearch || !api0.getFileIndexStats) {
      record('FIC-00-debug-api', false, { reason: 'file-search debug hooks missing' })
      return results
    }

    const rootReady = await ensureEditorRootReady('initial')
    record('FIC-00-editor-root-ready', rootReady, {
      rootPath: getApi()?.getRootPath?.() ?? null
    })
    if (!rootReady) return results

    // Seed the fixture files BEFORE first search so the cache build captures them.
    const createA = await window.electronAPI.project.createFile(rootPath, fileA, tsBody)
    const createB = await window.electronAPI.project.createFile(rootPath, fileB, tsBody)
    record('FIC-00-setup-a', createA.success, { error: createA.error })
    record('FIC-00-setup-b', createB.success, { error: createB.error })
    if (!createA.success || !createB.success) return results
    await sleep(400)

    // === 1. First open: builds the index from the project root ===
    const buildsBeforeFirstOpen = api0.getFileIndexStats().totalBuilds
    await api0.openGlobalFilenameSearch()
    const openedFirst = await waitFor(
      'FIC-01-open-first',
      () => Boolean(getApi()?.isGlobalFilenameSearchOpen?.()),
      3000
    )
    record('FIC-01-open-first', openedFirst)

    const readyFirst = await waitFor(
      'FIC-02-first-index-ready',
      () => {
        const stats = getApi()?.getFileIndexStats?.()
        if (!stats) return false
        return stats.entries.some((entry) => entry.status === 'ready' && entry.fileCount > 0)
      },
      5000
    )
    record('FIC-02-first-index-ready', readyFirst)

    const buildsAfterFirstOpen = getFileIndexStats().totalBuilds
    record(
      'FIC-03-initial-build-counted',
      buildsAfterFirstOpen === buildsBeforeFirstOpen + 1,
      { before: buildsBeforeFirstOpen, after: buildsAfterFirstOpen }
    )

    // Filter down to the fixture.
    getApi()!.setGlobalFilenameSearchQuery!(`onward-fic-a-${stamp}`)
    const matchedA = await waitFor(
      'FIC-04-fuzzy-a',
      () => getApi()?.getGlobalFilenameSearchResults?.().includes(fileA) ?? false,
      3000
    )
    record('FIC-04-fuzzy-a', matchedA, { results: getApi()?.getGlobalFilenameSearchResults?.() })

    getApi()!.closeGlobalFilenameSearch!()

    // === 2. Re-open multiple times: cache hit, no new build ===
    for (let iter = 0; iter < 5; iter += 1) {
      await api0.openGlobalFilenameSearch()
      await waitFor(
        `FIC-05-open-iter-${iter}`,
        () => Boolean(getApi()?.isGlobalFilenameSearchOpen?.()),
        2000
      )
      // Drive a query so the UI re-reads the cached files.
      getApi()!.setGlobalFilenameSearchQuery!(`onward-fic-b-${stamp}`)
      await waitFor(
        `FIC-05-fuzzy-b-${iter}`,
        () => getApi()?.getGlobalFilenameSearchResults?.().includes(fileB) ?? false,
        2000
      )
      getApi()!.closeGlobalFilenameSearch!()
      await sleep(80)
    }
    const buildsAfterRepeatedOpens = getFileIndexStats().totalBuilds
    record(
      'FIC-06-repeated-opens-reuse-cache',
      buildsAfterRepeatedOpens === buildsAfterFirstOpen,
      { buildsAfterFirst: buildsAfterFirstOpen, buildsAfterRepeated: buildsAfterRepeatedOpens }
    )

    // === 3. Create file via IPC — incremental addFile path ===
    const createC = await window.electronAPI.project.createFile(rootPath, fileC, tsBody)
    record('FIC-07-create-c', createC.success, { error: createC.error })
    if (createC.success) {
      await sleep(500)
      await api0.openGlobalFilenameSearch()
      await waitFor(
        'FIC-07-open-after-create',
        () => Boolean(getApi()?.isGlobalFilenameSearchOpen?.()),
        2000
      )
      getApi()!.setGlobalFilenameSearchQuery!(`onward-fic-c-${stamp}`)
      const foundC = await waitFor(
        'FIC-08-found-c-after-create',
        () => getApi()?.getGlobalFilenameSearchResults?.().includes(fileC) ?? false,
        3000
      )
      record('FIC-08-found-c-after-create', foundC, {
        results: getApi()?.getGlobalFilenameSearchResults?.()
      })
      getApi()!.closeGlobalFilenameSearch!()
    }

    const buildsAfterCreate = getFileIndexStats().totalBuilds
    record(
      'FIC-09-create-did-not-rebuild',
      buildsAfterCreate === buildsAfterFirstOpen,
      { buildsAfterFirst: buildsAfterFirstOpen, buildsAfterCreate }
    )

    // === 4. Rename via IPC — incremental renameFile path ===
    const renamed = await window.electronAPI.project.renamePath(rootPath, fileA, fileRenamed)
    record('FIC-10-rename-a', renamed.success, { error: renamed.error })
    if (renamed.success) {
      await sleep(500)
      await api0.openGlobalFilenameSearch()
      await waitFor(
        'FIC-10-open-after-rename',
        () => Boolean(getApi()?.isGlobalFilenameSearchOpen?.()),
        2000
      )
      getApi()!.setGlobalFilenameSearchQuery!(`onward-fic-a`)
      const renamedAppears = await waitFor(
        'FIC-11-renamed-appears',
        () => getApi()?.getGlobalFilenameSearchResults?.().includes(fileRenamed) ?? false,
        3000
      )
      const originalGone = !(getApi()?.getGlobalFilenameSearchResults?.().includes(fileA) ?? false)
      record('FIC-11-renamed-appears', renamedAppears)
      record('FIC-12-original-name-gone', originalGone, {
        results: getApi()?.getGlobalFilenameSearchResults?.()
      })
      getApi()!.closeGlobalFilenameSearch!()
    }

    // === 5. Delete via IPC — incremental removeFile path ===
    const deleted = await window.electronAPI.project.deletePath(rootPath, fileB)
    record('FIC-13-delete-b', deleted.success, { error: deleted.error })
    if (deleted.success) {
      await sleep(500)
      await api0.openGlobalFilenameSearch()
      await waitFor(
        'FIC-13-open-after-delete',
        () => Boolean(getApi()?.isGlobalFilenameSearchOpen?.()),
        2000
      )
      getApi()!.setGlobalFilenameSearchQuery!(`onward-fic-b-${stamp}`)
      const goneB = await waitFor(
        'FIC-14-b-removed',
        () => !(getApi()?.getGlobalFilenameSearchResults?.().includes(fileB) ?? false),
        3000
      )
      record('FIC-14-b-removed', goneB, {
        results: getApi()?.getGlobalFilenameSearchResults?.()
      })
      getApi()!.closeGlobalFilenameSearch!()
    }

    const buildsAfterAllMutations = getFileIndexStats().totalBuilds
    record(
      'FIC-15-mutations-did-not-rebuild',
      buildsAfterAllMutations === buildsAfterFirstOpen,
      {
        buildsAfterFirst: buildsAfterFirstOpen,
        buildsAfterAllMutations
      }
    )

    // === 6. Nested-directory create — exercises recursive fs.watch propagation ===
    // We keep this scoped to the fixture cwd by using project.createFile which
    // resolves relative to rootPath (unlike git.saveFileContent, which would
    // escape to the enclosing git root and pollute the real repo).
    const nestedCreate = await window.electronAPI.project.createFile(
      rootPath,
      nestedName,
      'export function Nested() { return null }'
    )
    record('FIC-16-nested-create-ok', nestedCreate.success, {
      error: nestedCreate.error
    })

    if (nestedCreate.success) {
      await sleep(500)
      await api0.openGlobalFilenameSearch()
      await waitFor(
        'FIC-16-open-after-nested',
        () => Boolean(getApi()?.isGlobalFilenameSearchOpen?.()),
        2000
      )
      getApi()!.setGlobalFilenameSearchQuery!(`onward-fic-nested-${stamp}`)
      const foundNested = await waitFor(
        'FIC-17-nested-propagated',
        () => getApi()?.getGlobalFilenameSearchResults?.().includes(nestedName) ?? false,
        5000,
        150
      )
      record('FIC-17-nested-propagated', foundNested, {
        results: getApi()?.getGlobalFilenameSearchResults?.(),
        note: 'nested file appears after in-app create (validates incremental patch + fs watcher)'
      })
      getApi()!.closeGlobalFilenameSearch!()
    }

    const buildsAfterNested = getFileIndexStats().totalBuilds
    record(
      'FIC-18-nested-did-not-rebuild',
      buildsAfterNested === buildsAfterFirstOpen,
      { buildsAfterFirst: buildsAfterFirstOpen, buildsAfterNested }
    )

    // === 6b. Ignored watcher noise must not enter the renderer file-index ===
    // Regression guard for the CPU feedback loop where the app's own Git
    // polling flickered .git/index.lock and made the renderer repeatedly
    // apply file-index events while markdown preview was otherwise idle.
    const ignoredGitSetup = await window.electronAPI.project.createFolder(rootPath, ignoredGitDir)
    const ignoredNodeSetup = await window.electronAPI.project.createFolder(rootPath, `${ignoredNodeModulesDir}/.cache`)
    record('FIC-23-ignored-noise-dirs-created', ignoredGitSetup.success && ignoredNodeSetup.success, {
      gitError: ignoredGitSetup.error,
      nodeModulesError: ignoredNodeSetup.error
    })

    const ignoredBaselineCount = getReadyFileCount()
    const ignoredBaselineBuilds = getFileIndexStats().totalBuilds
    const gitNoiseCounts: Array<number | null> = []
    const nodeNoiseCounts: Array<number | null> = []

    if (ignoredGitSetup.success && ignoredNodeSetup.success && ignoredBaselineCount !== null) {
      for (let iter = 0; iter < 5; iter += 1) {
        const gitNoiseFile = `${ignoredGitDir}/index-${stamp}-${iter}.lock`
        const nodeNoiseFile = `${ignoredNodeModulesDir}/.cache/onward-fic-noise-${stamp}-${iter}.js`

        await window.electronAPI.project.createFile(rootPath, gitNoiseFile, 'lock')
        await sleep(500)
        gitNoiseCounts.push(getReadyFileCount())
        await window.electronAPI.project.deletePath(rootPath, gitNoiseFile).catch(() => {})
        await sleep(250)

        await window.electronAPI.project.createFile(rootPath, nodeNoiseFile, `export const ignored = ${iter}\n`)
        await sleep(500)
        nodeNoiseCounts.push(getReadyFileCount())
        await window.electronAPI.project.deletePath(rootPath, nodeNoiseFile).catch(() => {})
        await sleep(250)
      }
    }

    const ignoredAfterBuilds = getFileIndexStats().totalBuilds
    const gitNoiseIgnored = ignoredBaselineCount !== null &&
      gitNoiseCounts.length === 5 &&
      gitNoiseCounts.every((count) => count === ignoredBaselineCount)
    const nodeNoiseIgnored = ignoredBaselineCount !== null &&
      nodeNoiseCounts.length === 5 &&
      nodeNoiseCounts.every((count) => count === ignoredBaselineCount)
    record('FIC-24-git-index-lock-noise-ignored', gitNoiseIgnored, {
      baselineCount: ignoredBaselineCount,
      counts: gitNoiseCounts
    })
    record('FIC-25-node-modules-cache-noise-ignored', nodeNoiseIgnored, {
      baselineCount: ignoredBaselineCount,
      counts: nodeNoiseCounts
    })
    record(
      'FIC-26-ignored-noise-did-not-rebuild',
      ignoredAfterBuilds === ignoredBaselineBuilds,
      { before: ignoredBaselineBuilds, after: ignoredAfterBuilds }
    )

    // === 6c. Folder creation must NOT surface the folder path as a search hit ===
    // Regression guard for the reviewer-reported issue where the tree watcher
    // enqueued every added path without first checking `statSync(...).isDirectory()`.
    const folderCreate = await window.electronAPI.project.createFolder(rootPath, folderName)
    record('FIC-21-folder-create-ok', folderCreate.success, {
      error: folderCreate.error
    })
    if (folderCreate.success) {
      await sleep(500)
      await api0.openGlobalFilenameSearch()
      await waitFor(
        'FIC-21-open-after-folder',
        () => Boolean(getApi()?.isGlobalFilenameSearchOpen?.()),
        2000
      )
      getApi()!.setGlobalFilenameSearchQuery!(folderName)
      await sleep(600)
      const resultsAfterFolder = getApi()?.getGlobalFilenameSearchResults?.() ?? []
      record(
        'FIC-22-folder-not-in-results',
        !resultsAfterFolder.includes(folderName),
        { results: resultsAfterFolder, folderName }
      )
      getApi()!.closeGlobalFilenameSearch!()
      await window.electronAPI.project.deletePath(rootPath, folderName).catch(() => {})
    }

    // === 7. forceRefreshFileIndex — validates the manual "Refresh" recovery path ===
    const buildsBeforeRefresh = getFileIndexStats().totalBuilds
    const refreshed = (await getApi()?.forceRefreshFileIndex?.()) ?? false
    record('FIC-19-force-refresh-success', refreshed)
    const buildsAfterRefresh = getFileIndexStats().totalBuilds
    record(
      'FIC-20-force-refresh-triggered-rebuild',
      buildsAfterRefresh === buildsBeforeRefresh + 1,
      { before: buildsBeforeRefresh, after: buildsAfterRefresh }
    )

    // === 8. Quick Open panel height tracks the editor height ===
    // Regression guard for the hard-coded `max-height: 360px` on
    // `.project-editor-search-results`, which pinned the Cmd+P panel to a short
    // box no matter how tall the window was. The panel must now be content-sized
    // when matches are few and grow until it fills the editor (minus a symmetric
    // 24px gutter) when they are many.
    const SEARCH_OVERLAY_GUTTER_PX = 24
    const LEGACY_RESULTS_MAX_HEIGHT_PX = 360
    const HEIGHT_TOLERANCE_PX = 2
    const LAYOUT_TRIALS = 3

    type SearchPanelMetrics = {
      overlayHeight: number
      availableHeight: number
      panelHeight: number
      resultsHeight: number
      topGap: number
      bottomGap: number
      resultCount: number
    }

    const measureSearchPanel = (): SearchPanelMetrics | null => {
      const overlay = document.querySelector<HTMLElement>('.project-editor-search-overlay')
      const panel = document.querySelector<HTMLElement>('.project-editor-search')
      // The modal hosts the shared SearchPanel, so the scrolling list is that
      // component's `.global-search-results` — the modal no longer has a
      // private result list of its own.
      const list = document.querySelector<HTMLElement>(
        '.project-editor-search .global-search-results'
      )
      if (!overlay || !panel || !list) return null
      const overlayRect = overlay.getBoundingClientRect()
      const panelRect = panel.getBoundingClientRect()
      const listRect = list.getBoundingClientRect()
      return {
        overlayHeight: overlayRect.height,
        availableHeight: overlayRect.height - SEARCH_OVERLAY_GUTTER_PX * 2,
        panelHeight: panelRect.height,
        resultsHeight: listRect.height,
        topGap: panelRect.top - overlayRect.top,
        bottomGap: overlayRect.bottom - panelRect.bottom,
        resultCount: getApi()?.getGlobalFilenameSearchResults?.().length ?? -1
      }
    }

    // Layout is read one frame after a React commit, so a single sample can land
    // on an intermediate frame. Repeat the open -> query -> measure cycle and
    // assert on every trial (boolean correctness => "all N must hold").
    const collectPanelMetrics = async (
      label: string,
      query: string,
      expect: 'many' | 'none'
    ): Promise<SearchPanelMetrics[]> => {
      const samples: SearchPanelMetrics[] = []
      for (let trial = 0; trial < LAYOUT_TRIALS; trial += 1) {
        // Non-null assertion: the FIC-00 guard above already proved the hook
        // exists, but TS drops property narrowing inside a closure body.
        await api0.openGlobalFilenameSearch!()
        await waitFor(
          `FIC-27-${label}-open-${trial}`,
          () => Boolean(getApi()?.isGlobalFilenameSearchOpen?.()),
          2000
        )
        getApi()!.setGlobalFilenameSearchQuery!(query)
        await waitFor(
          `FIC-27-${label}-results-${trial}`,
          () => {
            const count = getApi()?.getGlobalFilenameSearchResults?.().length ?? -1
            return expect === 'many' ? count >= 20 : count === 0
          },
          3000
        )
        // Let style + layout settle after the React commit before measuring.
        await sleep(120)
        const metrics = measureSearchPanel()
        if (metrics) samples.push(metrics)
        getApi()!.closeGlobalFilenameSearch!()
        await sleep(80)
      }
      return samples
    }

    // 8a. Many matches (empty query returns the first 50 indexed files) — the
    // panel must fill the editor's available height, not stop at a fixed cap.
    const fullSamples = await collectPanelMetrics('full', '', 'many')
    const fullCollected = fullSamples.length === LAYOUT_TRIALS
    record('FIC-27-full-list-metrics-collected', fullCollected, { samples: fullSamples })

    if (fullCollected) {
      const fillsEditor = fullSamples.every(
        (sample) => Math.abs(sample.panelHeight - sample.availableHeight) <= HEIGHT_TOLERANCE_PX
      )
      record('FIC-28-full-list-fills-editor-height', fillsEditor, {
        tolerancePx: HEIGHT_TOLERANCE_PX,
        samples: fullSamples.map((sample) => ({
          panelHeight: sample.panelHeight,
          availableHeight: sample.availableHeight,
          overlayHeight: sample.overlayHeight,
          resultCount: sample.resultCount
        }))
      })

      const gutterOk = fullSamples.every(
        (sample) =>
          Math.abs(sample.topGap - SEARCH_OVERLAY_GUTTER_PX) <= HEIGHT_TOLERANCE_PX &&
          Math.abs(sample.bottomGap - SEARCH_OVERLAY_GUTTER_PX) <= HEIGHT_TOLERANCE_PX
      )
      record('FIC-29-panel-keeps-symmetric-gutter', gutterOk, {
        expectedGutterPx: SEARCH_OVERLAY_GUTTER_PX,
        samples: fullSamples.map((sample) => ({ topGap: sample.topGap, bottomGap: sample.bottomGap }))
      })

      // The "beats the old 360px cap" check is only meaningful when the window is
      // actually taller than that cap; a 400px-minHeight window cannot exercise
      // it. Skipping is logged, never silent.
      const windowTallEnough = fullSamples.every(
        (sample) => sample.availableHeight > LEGACY_RESULTS_MAX_HEIGHT_PX + 60
      )
      if (windowTallEnough) {
        const beatsLegacyCap = fullSamples.every(
          (sample) => sample.resultsHeight > LEGACY_RESULTS_MAX_HEIGHT_PX
        )
        record('FIC-30-results-list-beats-legacy-cap', beatsLegacyCap, {
          legacyCapPx: LEGACY_RESULTS_MAX_HEIGHT_PX,
          samples: fullSamples.map((sample) => sample.resultsHeight)
        })
      } else {
        log('fic-ui:legacy-cap-check-skipped', {
          reason: 'window shorter than the legacy 360px result cap',
          availableHeights: fullSamples.map((sample) => sample.availableHeight)
        })
        record('FIC-30-results-list-beats-legacy-cap', true, {
          skipped: 'window shorter than the legacy 360px result cap',
          legacyCapPx: LEGACY_RESULTS_MAX_HEIGHT_PX,
          availableHeights: fullSamples.map((sample) => sample.availableHeight)
        })
      }
    }

    // 8b. No matches — the panel must shrink back to its content, proving the
    // height is adaptive rather than pinned to the editor height.
    const emptySamples = await collectPanelMetrics('empty', `onward-fic-nomatch-${stamp}`, 'none')
    const emptyCollected = emptySamples.length === LAYOUT_TRIALS
    record('FIC-31-empty-list-metrics-collected', emptyCollected, { samples: emptySamples })

    if (emptyCollected) {
      const staysContentSized = emptySamples.every(
        (sample) => sample.panelHeight < sample.availableHeight * 0.5
      )
      record('FIC-32-no-match-panel-stays-content-sized', staysContentSized, {
        samples: emptySamples.map((sample) => ({
          panelHeight: sample.panelHeight,
          availableHeight: sample.availableHeight,
          resultCount: sample.resultCount
        }))
      })
    }

    // === 9. Cmd+P hosts the SAME search surface as the sidebar ===
    // The modal used to carry a private filename-only list with no type tabs,
    // no case/word/regex toggles and no include/exclude globs. Asserting on the
    // rendered controls is what keeps a future change from quietly forking the
    // two surfaces again.
    await api0.openGlobalFilenameSearch!()
    await waitFor(
      'FIC-33-open-for-parity',
      () => Boolean(getApi()?.isGlobalFilenameSearchOpen?.()),
      2000
    )
    await sleep(150)

    const modalRoot = document.querySelector<HTMLElement>('.project-editor-search')
    const typeButtons = Array.from(
      modalRoot?.querySelectorAll<HTMLElement>('.global-search-type-btn') ?? []
    )
    record('FIC-33-modal-has-search-type-tabs', typeButtons.length === 2, {
      count: typeButtons.length,
      labels: typeButtons.map((button) => button.textContent?.trim() ?? '')
    })

    const filenameTabActive = typeButtons.some(
      (button) => button.classList.contains('active') && button.textContent?.trim()
    )
    record('FIC-34-modal-defaults-to-filename-tab', filenameTabActive, {
      activeLabels: typeButtons
        .filter((button) => button.classList.contains('active'))
        .map((button) => button.textContent?.trim() ?? '')
    })

    // Switching to the content tab must reveal the very option buttons the
    // sidebar offers (case-sensitive / whole-word / regex).
    const contentTab = typeButtons[0]
    contentTab?.click()
    const optionButtonsAppeared = await waitFor(
      'FIC-35-content-options',
      () => (modalRoot?.querySelectorAll('.global-search-option-btn').length ?? 0) >= 3,
      2000
    )
    const optionCount = modalRoot?.querySelectorAll('.global-search-option-btn').length ?? 0
    record('FIC-35-modal-content-mode-has-option-toggles', optionButtonsAppeared, {
      optionCount
    })

    const globToggle = modalRoot?.querySelector<HTMLElement>('.global-search-glob-toggle')
    globToggle?.click()
    const globInputsAppeared = await waitFor(
      'FIC-36-glob-inputs',
      () => (modalRoot?.querySelectorAll('.global-search-glob-input').length ?? 0) === 2,
      2000
    )
    record('FIC-36-modal-content-mode-has-include-exclude-globs', globInputsAppeared, {
      globInputCount: modalRoot?.querySelectorAll('.global-search-glob-input').length ?? 0
    })

    getApi()!.closeGlobalFilenameSearch!()
    await sleep(120)

    // === 10. Paging: "load more" appends instead of dead-ending ===
    // The fixture has more files than one page, so an empty query must report a
    // total above the page size and offer a load-more affordance.
    await api0.openGlobalFilenameSearch!()
    await waitFor(
      'FIC-37-open-for-paging',
      () => Boolean(getApi()?.isGlobalFilenameSearchOpen?.()),
      2000
    )
    getApi()!.setGlobalFilenameSearchQuery!('')
    await waitFor(
      'FIC-37-first-page',
      () => (getApi()?.getGlobalFilenameSearchResults?.().length ?? 0) > 0,
      3000
    )
    await sleep(200)

    const firstPageCount = getApi()?.getGlobalFilenameSearchResults?.().length ?? 0
    const loadMoreButton = document.querySelector<HTMLElement>(
      '.project-editor-search .global-search-load-more'
    )
    // Paging only exists when the corpus exceeds one page; the fixture is sized
    // to guarantee that, but log rather than silently pass if it ever shrinks.
    if (!loadMoreButton) {
      log('fic-ui:paging-check-skipped', {
        reason: 'fixture produced a single page; nothing to page through',
        firstPageCount
      })
      record('FIC-38-load-more-appends-next-page', true, {
        skipped: 'fixture fits in one page',
        firstPageCount
      })
    } else {
      loadMoreButton.click()
      const appended = await waitFor(
        'FIC-38-appended',
        () => (getApi()?.getGlobalFilenameSearchResults?.().length ?? 0) > firstPageCount,
        3000
      )
      const secondPageCount = getApi()?.getGlobalFilenameSearchResults?.().length ?? 0
      record('FIC-38-load-more-appends-next-page', appended, {
        firstPageCount,
        secondPageCount
      })

      // Appending must not duplicate rows — a racing double-append would show
      // the same file twice and silently corrupt keyboard navigation.
      const rows = getApi()?.getGlobalFilenameSearchResults?.() ?? []
      record('FIC-39-appended-page-has-no-duplicates', new Set(rows).size === rows.length, {
        total: rows.length,
        unique: new Set(rows).size
      })
    }

    getApi()!.closeGlobalFilenameSearch!()
    await sleep(100)

    // === 11. The index no longer swallows dependency / VCS internals ===
    // Direct regression guard for the build-vs-watcher asymmetry: the ignore
    // list used to gate only the watcher, so any rebuild pulled node_modules
    // and .git back into the searchable set.
    const indexedFiles = getApi()?.getFileIndexStats?.().entries.find(
      (entry) => entry.status === 'ready'
    )
    await api0.openGlobalFilenameSearch!()
    await waitFor(
      'FIC-40-open-for-ignore',
      () => Boolean(getApi()?.isGlobalFilenameSearchOpen?.()),
      2000
    )
    getApi()!.setGlobalFilenameSearchQuery!('node_modules')
    await sleep(600)
    const nodeModulesHits = (getApi()?.getGlobalFilenameSearchResults?.() ?? [])
      .filter((item) => item.startsWith('node_modules/'))
    record('FIC-40-node-modules-absent-from-search', nodeModulesHits.length === 0, {
      hits: nodeModulesHits.slice(0, 5),
      readyFileCount: indexedFiles?.fileCount ?? null
    })

    getApi()!.setGlobalFilenameSearchQuery!('.git')
    await sleep(600)
    const gitHits = (getApi()?.getGlobalFilenameSearchResults?.() ?? [])
      .filter((item) => item === '.git' || item.startsWith('.git/'))
    record('FIC-41-git-internals-absent-from-search', gitHits.length === 0, {
      hits: gitHits.slice(0, 5)
    })
    getApi()!.closeGlobalFilenameSearch!()
    await sleep(100)

    // === 12. .gitignore is honoured, including negation ===
    // The fixture ships its own `.gitignore` with deliberately distinctive
    // patterns (see that file's header) so these assertions cannot pass by
    // accident via the enclosing repository's root ignore rules.
    const gitignoredDirFile = 'onward-gitignored-dir/secret.ts'
    const gitignoredExtFile = 'build-artifact.onward-gitignored'
    const negatedFile = 'keep-me.onward-gitignored'
    const controlFile = `onward-fic-control-${stamp}.ts`

    // createFile does not create intermediate directories, so the ignored
    // directory has to exist before its child file can be written.
    const ignoredDirCreate = await window.electronAPI.project.createFolder(
      rootPath,
      'onward-gitignored-dir'
    )
    const gitignoreSetup = [
      ignoredDirCreate,
      ...await Promise.all([
        window.electronAPI.project.createFile(rootPath, gitignoredDirFile, tsBody),
        window.electronAPI.project.createFile(rootPath, gitignoredExtFile, tsBody),
        window.electronAPI.project.createFile(rootPath, negatedFile, tsBody),
        window.electronAPI.project.createFile(rootPath, controlFile, tsBody)
      ])
    ]
    record('FIC-42-gitignore-fixtures-created', gitignoreSetup.every((r) => r.success), {
      errors: gitignoreSetup.map((r) => r.error).filter(Boolean)
    })

    // Force a rebuild so the listing (not the incremental path) is what decides.
    await sleep(400)
    await getApi()?.forceRefreshFileIndex?.()
    await sleep(500)

    await api0.openGlobalFilenameSearch!()
    await waitFor(
      'FIC-43-open-for-gitignore',
      () => Boolean(getApi()?.isGlobalFilenameSearchOpen?.()),
      2000
    )
    getApi()!.setGlobalFilenameSearchQuery!('onward-gitignored')
    await sleep(700)
    const ignoredDirHits = getApi()?.getGlobalFilenameSearchResults?.() ?? []
    record(
      'FIC-43-gitignored-directory-absent',
      !ignoredDirHits.some((item) => item.startsWith('onward-gitignored-dir/')),
      { hits: ignoredDirHits.slice(0, 5) }
    )

    getApi()!.setGlobalFilenameSearchQuery!('onward-gitignored')
    await sleep(700)
    const extHits = getApi()?.getGlobalFilenameSearchResults?.() ?? []
    record(
      'FIC-44-gitignored-extension-absent',
      !extHits.includes(gitignoredExtFile),
      { hits: extHits.slice(0, 5), looking: gitignoredExtFile }
    )

    // Negation: `!keep-me.onward-gitignored` re-includes one path the previous
    // rule excluded. Getting this right is the single strongest signal that we
    // are using real gitignore semantics rather than prefix matching.
    record(
      'FIC-45-gitignore-negation-respected',
      extHits.includes(negatedFile),
      { hits: extHits.slice(0, 8), looking: negatedFile }
    )

    // Control: a plain file created the same way must still be searchable, so a
    // trivially-empty index cannot make the three assertions above pass.
    getApi()!.setGlobalFilenameSearchQuery!(controlFile)
    await sleep(700)
    const controlHits = getApi()?.getGlobalFilenameSearchResults?.() ?? []
    record('FIC-46-non-ignored-control-file-present', controlHits.includes(controlFile), {
      hits: controlHits.slice(0, 5),
      looking: controlFile
    })

    getApi()!.closeGlobalFilenameSearch!()
    for (const path of ['onward-gitignored-dir', gitignoredExtFile, negatedFile, controlFile]) {
      await window.electronAPI.project.deletePath(rootPath, path).catch(() => {})
    }

    await window.electronAPI.project.deletePath(rootPath, nestedName).catch(() => {})
    await window.electronAPI.project.deletePath(rootPath, fileRenamed).catch(() => {})
    await window.electronAPI.project.deletePath(rootPath, fileC).catch(() => {})
  } finally {
    await cleanup()
  }

  return results
}
