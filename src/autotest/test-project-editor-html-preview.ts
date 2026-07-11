/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

import type { AutotestContext, TestResult } from './types'

const DEFAULT_HTML_FIXTURE_PATH = 'html-preview/regularization_landscape.html'
const DEFAULT_EXPECTED_TITLE = 'HTML Preview Autotest'
const DEFAULT_EXPECTED_TEXT = 'INITIAL_HTML_MARKER'
const UPDATED_MARKER = 'UPDATED_HTML_MARKER'

type HtmlDocumentState = {
  success: boolean
  error?: string
  title?: string
  readyState?: string
  bodyText?: string
  externalReady?: boolean
  localReady?: boolean
  saveMarker?: string | null
  imageCount?: number
  loadedImageCount?: number
  brokenImageCount?: number
  scrollX?: number
  scrollY?: number
  scrollHeight?: number
  scrollWidth?: number
  clientHeight?: number
  clientWidth?: number
}

export async function testProjectEditorHtmlPreview(ctx: AutotestContext): Promise<TestResult[]> {
  const { assert, cancelled, openFileInEditor, sleep, waitFor } = ctx
  const results: TestResult[] = []
  const record = (name: string, ok: boolean, detail?: Record<string, unknown>) => {
    assert(name, ok, detail)
    results.push({ name, ok, detail })
  }

  const debug = window.electronAPI.debug
  const fixturePath = debug.autotestHtmlFixturePath ?? DEFAULT_HTML_FIXTURE_PATH
  const expectedTitle = debug.autotestHtmlExpectedTitle ?? DEFAULT_EXPECTED_TITLE
  const expectedText = debug.autotestHtmlExpectedText ?? DEFAULT_EXPECTED_TEXT
  const runSaveFlow = !debug.autotestHtmlSkipSaveFlow
  const getApi = () => window.__onwardProjectEditorDebug

  const waitForDocumentState = async (
    label: string,
    predicate: (state: HtmlDocumentState) => boolean,
    timeoutMs = 15000
  ): Promise<{ ok: boolean; state: HtmlDocumentState | null }> => {
    const start = performance.now()
    let lastState: HtmlDocumentState | null = null
    while (performance.now() - start < timeoutMs) {
      const state = await getApi()?.getHtmlPreviewDocumentState?.()
      if (state) {
        lastState = state
        if (state.success && predicate(state)) {
          return { ok: true, state }
        }
      }
      await sleep(120)
    }
    ctx.log('html-preview-document-timeout', { label, lastState })
    return { ok: false, state: lastState }
  }

  const waitForZoomState = async (
    label: string,
    predicate: (state: { ui: number; browser: number | null }) => boolean,
    timeoutMs = 5000
  ): Promise<{ ok: boolean; state: { ui: number; browser: number | null } }> => {
    const start = performance.now()
    let lastState = {
      ui: getApi()?.getHtmlPreviewZoomFactor?.() ?? 1,
      browser: null as number | null
    }
    while (performance.now() - start < timeoutMs) {
      lastState = {
        ui: getApi()?.getHtmlPreviewZoomFactor?.() ?? 1,
        browser: await (getApi()?.getHtmlPreviewBrowserZoomFactor?.() ?? Promise.resolve(null))
      }
      if (predicate(lastState)) {
        return { ok: true, state: lastState }
      }
      await sleep(80)
    }
    ctx.log('html-preview-zoom-timeout', { label, lastState })
    return { ok: false, state: lastState }
  }

  const fixture = await window.electronAPI.project.readFile(ctx.rootPath, fixturePath)
  record('PHTML-00-fixture-exists', fixture.success, {
    path: fixturePath,
    error: fixture.success ? null : fixture.error
  })
  if (!fixture.success || cancelled()) return results

  record('PHTML-01-read-result-is-html', Boolean(fixture.isHtml && fixture.previewUrl && fixture.content.includes(expectedText)), {
    isHtml: fixture.isHtml ?? false,
    previewUrl: fixture.previewUrl ?? null,
    contentLength: fixture.content.length
  })
  if (cancelled()) return results

  await openFileInEditor(fixturePath)
  const opened = await waitFor(
    'phtml-open-html',
    () => getApi()?.getActiveFilePath?.() === fixturePath && Boolean(getApi()?.getEditorContent?.().includes(expectedText)),
    10000,
    100
  )
  record('PHTML-02-open-html-source-editor', opened, {
    activeFilePath: getApi()?.getActiveFilePath?.() ?? null,
    editorLength: getApi()?.getEditorContent?.().length ?? 0
  })
  if (!opened || cancelled()) return results

  const readerVisible = await waitFor(
    'phtml-reader-visible',
    () => Boolean(getApi()?.isHtmlReaderVisible?.() && getApi()?.getHtmlReaderState?.()?.browserId),
    10000,
    100
  )
  record('PHTML-03-html-reader-visible', readerVisible, {
    readerState: getApi()?.getHtmlReaderState?.() ?? null
  })
  if (!readerVisible || cancelled()) return results

  const rendered = await waitForDocumentState(
    'phtml-document-rendered',
    (state) => state.title === expectedTitle && Boolean(state.bodyText?.includes(expectedText))
  )
  record('PHTML-04-html-document-rendered', rendered.ok, {
    title: rendered.state?.title ?? null,
    readyState: rendered.state?.readyState ?? null,
    hasExpectedText: Boolean(rendered.state?.bodyText?.includes(expectedText)),
    error: rendered.state?.error ?? null
  })
  if (!rendered.ok || cancelled()) return results

  const htmlPreviewHeaderText = Array.from(document.querySelectorAll<HTMLElement>('.project-editor-preview-header-main span'))
    .map((node) => node.textContent?.trim() ?? '')
    .find((text) => text === 'HTML Preview') ?? ''
  record('PHTML-04b-html-preview-title-case', htmlPreviewHeaderText === 'HTML Preview', {
    headerTexts: Array.from(document.querySelectorAll<HTMLElement>('.project-editor-preview-header-main span'))
      .map((node) => node.textContent?.trim() ?? '')
  })
  if (htmlPreviewHeaderText !== 'HTML Preview' || cancelled()) return results

  if (!runSaveFlow) {
    return results
  }

  const assetsReady = await waitForDocumentState(
    'phtml-assets-ready',
    (state) => Boolean(state.externalReady && state.localReady && state.imageCount && state.loadedImageCount === state.imageCount)
  )
  record('PHTML-05-local-and-external-assets-render', assetsReady.ok, {
    externalReady: assetsReady.state?.externalReady ?? false,
    localReady: assetsReady.state?.localReady ?? false,
    imageCount: assetsReady.state?.imageCount ?? 0,
    loadedImageCount: assetsReady.state?.loadedImageCount ?? 0,
    brokenImageCount: assetsReady.state?.brokenImageCount ?? 0
  })
  if (!assetsReady.ok || cancelled()) return results

  getApi()?.setMarkdownEditorVisible?.(false)
  const forceRefreshVisibleWithoutEditor = await waitFor(
    'phtml-force-refresh-visible-without-editor',
    () => {
      return Boolean(
        getApi()?.isMarkdownEditorVisible?.() === false &&
        document.querySelector('.project-editor-html-force-refresh-btn') &&
        getApi()?.isHtmlReaderVisible?.()
      )
    },
    5000,
    100
  )
  record('PHTML-06-force-refresh-visible-without-editor', forceRefreshVisibleWithoutEditor, {
    editorVisible: getApi()?.isMarkdownEditorVisible?.() ?? null,
    hasButton: Boolean(document.querySelector('.project-editor-html-force-refresh-btn')),
    buttonText: document.querySelector('.project-editor-html-force-refresh-btn')?.textContent?.trim() ?? null,
    readerVisible: getApi()?.isHtmlReaderVisible?.() ?? false
  })
  const forceRefreshButtonText = document.querySelector('.project-editor-html-force-refresh-btn')?.textContent?.trim() ?? ''
  record('PHTML-06b-force-refresh-is-icon-only', forceRefreshButtonText === '', {
    buttonText: forceRefreshButtonText
  })
  const forceRefreshButtonTitle = document.querySelector('.project-editor-html-force-refresh-btn')?.getAttribute('title') ?? ''
  const expectedRefreshShortcut = window.electronAPI.platform === 'darwin' ? '⌘R' : 'Ctrl+R'
  const forceRefreshShortcutTitleOk = forceRefreshButtonTitle.includes(expectedRefreshShortcut)
  record('PHTML-06c-force-refresh-title-shows-shortcut', forceRefreshShortcutTitleOk, {
    title: forceRefreshButtonTitle,
    expectedRefreshShortcut
  })
  if (!forceRefreshVisibleWithoutEditor || forceRefreshButtonText !== '' || !forceRefreshShortcutTitleOk || cancelled()) return results

  getApi()?.setMarkdownEditorVisible?.(true)
  const editorRestored = await waitFor(
    'phtml-editor-restored-for-resize',
    () => getApi()?.isMarkdownEditorVisible?.() === true && Boolean(document.querySelector('.project-editor-preview-resizer')),
    5000,
    100
  )
  record('PHTML-07-editor-restored-for-resize', editorRestored, {
    editorVisible: getApi()?.isMarkdownEditorVisible?.() ?? null,
    hasResizer: Boolean(document.querySelector('.project-editor-preview-resizer'))
  })
  if (!editorRestored || cancelled()) return results

  const paneBeforeResize = document.querySelector<HTMLElement>('.project-editor-preview-pane')
  const resizer = document.querySelector<HTMLElement>('.project-editor-preview-resizer')
  const beforeResizeWidth = paneBeforeResize?.getBoundingClientRect().width ?? 0
  if (resizer) {
    const rect = resizer.getBoundingClientRect()
    const startX = rect.left + rect.width / 2
    resizer.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, clientX: startX }))
    document.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, cancelable: true, clientX: startX + 90 }))
    document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, clientX: startX + 90 }))
  }
  await sleep(250)
  const paneAfterResize = document.querySelector<HTMLElement>('.project-editor-preview-pane')
  const afterResizeWidth = paneAfterResize?.getBoundingClientRect().width ?? 0
  record('PHTML-08-html-preview-resizer-drags', Boolean(resizer && beforeResizeWidth > 0 && Math.abs(afterResizeWidth - beforeResizeWidth) >= 20), {
    hasResizer: Boolean(resizer),
    beforeResizeWidth,
    afterResizeWidth
  })
  if (cancelled()) return results

  const apiForSearch = getApi()
  apiForSearch?.setHtmlPreviewSearchOpen?.(true)
  const htmlSearchOpen = await waitFor(
    'phtml-html-search-open',
    () => apiForSearch?.isHtmlPreviewSearchOpen?.() === true,
    3000,
    80
  )
  const htmlSearchFocusedOnOpen = await waitFor(
    'phtml-html-search-focused-on-open',
    () => document.activeElement?.classList.contains('preview-search-input') === true,
    3000,
    80
  )
  apiForSearch?.htmlPreviewSearchSetQuery?.('HTML_SEARCH_TARGET')
  const htmlSearchMatches = await waitFor(
    'phtml-html-search-matches',
    () => {
      const state = apiForSearch?.getHtmlPreviewSearchState?.()
      return Boolean(state?.finalUpdate && state.matches >= 3)
    },
    5000,
    80
  )
  const htmlSearchState = apiForSearch?.getHtmlPreviewSearchState?.() ?? null
  record('PHTML-09-html-preview-search-finds-matches', Boolean(htmlSearchOpen && htmlSearchFocusedOnOpen && htmlSearchMatches), {
    htmlSearchOpen,
    htmlSearchFocusedOnOpen,
    htmlSearchState
  })
  if (!htmlSearchOpen || !htmlSearchFocusedOnOpen || !htmlSearchMatches || cancelled()) return results

  document.querySelector<HTMLElement>('.project-editor-html-force-refresh-btn')?.focus()
  await sleep(120)
  const focusMovedAway = document.activeElement?.classList.contains('project-editor-html-force-refresh-btn') === true
  apiForSearch?.setHtmlPreviewSearchOpen?.(true)
  const htmlSearchRefocused = await waitFor(
    'phtml-html-search-refocused-on-reopen',
    () => document.activeElement?.classList.contains('preview-search-input') === true,
    3000,
    80
  )
  record('PHTML-10-html-preview-search-refocuses-on-repeat-open', Boolean(focusMovedAway && htmlSearchRefocused), {
    focusMovedAway,
    htmlSearchRefocused,
    activeClass: document.activeElement?.className ?? null
  })
  if (!htmlSearchRefocused || cancelled()) return results

  const htmlSearchCloseButton = document.querySelector<HTMLButtonElement>('.preview-search-close-btn')
  const htmlSearchCloseTitle = htmlSearchCloseButton?.getAttribute('title') ?? null
  const htmlSearchCloseAria = htmlSearchCloseButton?.getAttribute('aria-label') ?? null
  htmlSearchCloseButton?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }))
  const htmlSearchClosed = await waitFor(
    'phtml-html-search-close-button',
    () => apiForSearch?.isHtmlPreviewSearchOpen?.() === false,
    3000,
    80
  )
  await sleep(250)
  record('PHTML-11-html-preview-search-close-button', Boolean(
    htmlSearchCloseButton &&
    htmlSearchClosed &&
    htmlSearchCloseTitle === null &&
    !/esc|escape/i.test(htmlSearchCloseAria ?? '') &&
    apiForSearch?.isHtmlPreviewSearchOpen?.() === false
  ), {
    hadCloseButton: Boolean(htmlSearchCloseButton),
    htmlSearchClosed,
    htmlSearchCloseTitle,
    htmlSearchCloseAria,
    finalOpen: apiForSearch?.isHtmlPreviewSearchOpen?.() ?? null
  })
  if (!htmlSearchClosed || cancelled()) return results

  await apiForSearch?.setHtmlPreviewZoomFactor?.(1)
  const zoomInButton = document.querySelector<HTMLButtonElement>('.project-editor-html-zoom-in-btn')
  zoomInButton?.click()
  const zoomedIn = await waitForZoomState(
    'phtml-html-zoom-in-button',
    (state) => state.ui >= 1.09 && (state.browser ?? 0) >= 1.09
  )
  record('PHTML-11b-html-preview-zoom-in-button', Boolean(zoomInButton && zoomedIn.ok), {
    hadButton: Boolean(zoomInButton),
    zoomState: zoomedIn.state
  })
  if (!zoomedIn.ok || cancelled()) return results

  const shortcutInit = await apiForSearch?.setHtmlPreviewZoomFactor?.(1.2)
  document.dispatchEvent(new KeyboardEvent('keydown', {
    bubbles: true,
    cancelable: true,
    key: '-',
    metaKey: window.electronAPI.platform === 'darwin',
    ctrlKey: window.electronAPI.platform !== 'darwin'
  }))
  const zoomedOutByShortcut = await waitForZoomState(
    'phtml-html-zoom-out-shortcut',
    (state) => state.ui <= 1.11 && state.ui >= 1.09 && (state.browser ?? 0) <= 1.11
  )
  record('PHTML-11c-html-preview-zoom-out-shortcut', Boolean(shortcutInit && zoomedOutByShortcut.ok), {
    shortcutInit,
    zoomState: zoomedOutByShortcut.state
  })
  if (!zoomedOutByShortcut.ok || cancelled()) return results

  await apiForSearch?.setHtmlPreviewZoomFactor?.(1.4)
  document.dispatchEvent(new KeyboardEvent('keydown', {
    bubbles: true,
    cancelable: true,
    key: '0',
    metaKey: window.electronAPI.platform === 'darwin',
    ctrlKey: window.electronAPI.platform !== 'darwin'
  }))
  const zoomResetByShortcut = await waitForZoomState(
    'phtml-html-zoom-reset-shortcut',
    (state) => Math.abs(state.ui - 1) <= 0.01 && Math.abs((state.browser ?? 0) - 1) <= 0.01
  )
  record('PHTML-11d-html-preview-zoom-reset-shortcut', zoomResetByShortcut.ok, {
    zoomState: zoomResetByShortcut.state
  })
  if (!zoomResetByShortcut.ok || cancelled()) return results

  const scrollSet = await getApi()?.setHtmlPreviewScrollForTest?.(760)
  const scrollReady = await waitForDocumentState(
    'phtml-scroll-ready-before-save',
    (state) => (state.scrollY ?? 0) >= 650,
    5000
  )
  record('PHTML-12-scroll-position-set-before-save', Boolean(scrollSet && scrollReady.ok), {
    scrollSet,
    scrollY: scrollReady.state?.scrollY ?? null,
    scrollHeight: scrollReady.state?.scrollHeight ?? null,
    clientHeight: scrollReady.state?.clientHeight ?? null
  })
  if (!scrollSet || !scrollReady.ok || cancelled()) return results

  const beforeReader = getApi()?.getHtmlReaderState?.() ?? null
  const beforeContent = getApi()?.getEditorContent?.() ?? ''
  const changed = beforeContent.includes(DEFAULT_EXPECTED_TEXT)
    ? getApi()?.setEditorContent?.(beforeContent.replace(DEFAULT_EXPECTED_TEXT, UPDATED_MARKER)) === true
    : false
  await sleep(500)
  const beforeSaveState = await getApi()?.getHtmlPreviewDocumentState?.()
  record('PHTML-13-edit-does-not-live-update-preview', Boolean(
    changed &&
    beforeSaveState?.success &&
    beforeSaveState.saveMarker === DEFAULT_EXPECTED_TEXT &&
    !beforeSaveState.bodyText?.includes(UPDATED_MARKER)
  ), {
    changed,
    saveMarker: beforeSaveState?.saveMarker ?? null,
    hasUpdatedMarkerBeforeSave: Boolean(beforeSaveState?.bodyText?.includes(UPDATED_MARKER))
  })
  if (!changed || cancelled()) return results

  const saved = await getApi()?.triggerToolbarSave?.()
  record('PHTML-14-toolbar-save-html-source', saved === true, {
    saved,
    activeFilePath: getApi()?.getActiveFilePath?.() ?? null
  })
  if (!saved || cancelled()) return results

  const rerendered = await waitForDocumentState(
    'phtml-save-rerendered',
    (state) => {
      const reader = getApi()?.getHtmlReaderState?.()
      return Boolean(
        state.bodyText?.includes(UPDATED_MARKER) &&
        state.saveMarker === UPDATED_MARKER &&
        reader &&
        beforeReader &&
        reader.reloadKey > beforeReader.reloadKey &&
        reader.browserId !== beforeReader.browserId
      )
    },
    15000
  )
  const afterReader = getApi()?.getHtmlReaderState?.() ?? null
  const restoredScroll = await waitForDocumentState(
    'phtml-save-restored-scroll',
    (state) => (state.scrollY ?? 0) >= 600,
    5000
  )
  const saveRerenderedAndRestored = Boolean(rerendered.ok && restoredScroll.ok)
  record('PHTML-15-save-rerenders-fresh-document-and-restores-scroll', saveRerenderedAndRestored, {
    beforeReader,
    afterReader,
    saveMarker: rerendered.state?.saveMarker ?? null,
    hasUpdatedMarkerAfterSave: Boolean(rerendered.state?.bodyText?.includes(UPDATED_MARKER)),
    externalReady: rerendered.state?.externalReady ?? false,
    localReady: rerendered.state?.localReady ?? false,
    restoredScrollY: restoredScroll.state?.scrollY ?? null
  })
  if (!saveRerenderedAndRestored || cancelled()) return results

  const beforeShortcutReader = getApi()?.getHtmlReaderState?.() ?? null
  document.dispatchEvent(new KeyboardEvent('keydown', {
    bubbles: true,
    cancelable: true,
    key: 'r',
    metaKey: window.electronAPI.platform === 'darwin',
    ctrlKey: window.electronAPI.platform !== 'darwin'
  }))
  const reloadedByShortcut = await waitFor(
    'phtml-html-refresh-shortcut',
    () => {
      const reader = getApi()?.getHtmlReaderState?.()
      return Boolean(
        beforeShortcutReader &&
        reader &&
        reader.reloadKey > beforeShortcutReader.reloadKey &&
        reader.browserId !== beforeShortcutReader.browserId
      )
    },
    15000,
    100
  )
  const shortcutRendered = await waitForDocumentState(
    'phtml-refresh-shortcut-rendered',
    (state) => state.title === expectedTitle && Boolean(state.bodyText?.includes(UPDATED_MARKER)),
    10000
  )
  record('PHTML-16-html-preview-refresh-shortcut-reloads', Boolean(reloadedByShortcut && shortcutRendered.ok), {
    beforeShortcutReader,
    afterShortcutReader: getApi()?.getHtmlReaderState?.() ?? null,
    renderedTitle: shortcutRendered.state?.title ?? null,
    hasUpdatedMarker: Boolean(shortcutRendered.state?.bodyText?.includes(UPDATED_MARKER))
  })

  // ── HTML scroll persistence (FileViewMemory.htmlScrollX/Y) ──
  // Switching to another file destroys the browser view; returning must
  // restore the offset from per-file memory, not from live DOM retention.
  const HTML_SCROLL_TARGET_Y = 600
  const htmlScrollTolerance = 80
  const detourPath = `onward-autotest-phtml-detour-${Date.now()}.md`
  const detourCreated = await window.electronAPI.project.createFile(
    ctx.rootPath,
    detourPath,
    '# detour\n\nphtml scroll persistence detour file\n'
  )
  try {
    // PHTML-16's Cmd+R reload restores its captured scroll on the FIRST
    // load-finish — and the fixture's external HTTP script can keep `loading`
    // true well past the rendered-DOM check. Seeding before that deferred
    // restore lands would get stomped back to the old offset (real product
    // race, pre-existing; see the 50ms apply in HtmlReader.onLoadingChanged).
    // Structurally bypass it: wait until the reader fully settles, THEN seed.
    await waitFor(
      'phtml-scroll-persist-reader-settled',
      () => {
        const reader = getApi()?.getHtmlReaderState?.()
        return Boolean(reader && !reader.isLoading && reader.loadCount >= 1)
      },
      15000,
      100
    )
    await sleep(300)
    const scrollSeeded = await (getApi()?.setHtmlPreviewScrollForTest?.(HTML_SCROLL_TARGET_Y) ?? Promise.resolve(false))
    const scrollSeededReady = await waitForDocumentState(
      'phtml-scroll-persist-seed',
      (state) => Math.abs((state.scrollY ?? 0) - HTML_SCROLL_TARGET_Y) <= htmlScrollTolerance,
      10000
    )
    // Give the 2s backstop poll one cycle so the offset lands in file memory
    // even if no capture-triggering navigation has happened yet.
    await sleep(2400)

    await openFileInEditor(detourPath)
    const detourOpened = await waitFor(
      'phtml-scroll-persist-detour',
      () => getApi()?.getActiveFilePath?.() === detourPath,
      10000,
      100
    )
    await openFileInEditor(fixturePath)
    const backOnFixture = await waitFor(
      'phtml-scroll-persist-return',
      () => getApi()?.getActiveFilePath?.() === fixturePath,
      10000,
      100
    )
    const restoredAfterSwitch = await waitForDocumentState(
      'phtml-scroll-persist-restored',
      (state) => Math.abs((state.scrollY ?? 0) - HTML_SCROLL_TARGET_Y) <= htmlScrollTolerance,
      15000
    )
    record('PHTML-17-html-scroll-survives-file-switch', Boolean(
      detourCreated.success && scrollSeeded && scrollSeededReady.ok && detourOpened && backOnFixture && restoredAfterSwitch.ok
    ), {
      target: HTML_SCROLL_TARGET_Y,
      seededScrollY: scrollSeededReady.state?.scrollY ?? null,
      restoredScrollY: restoredAfterSwitch.state?.scrollY ?? null,
      tolerance: htmlScrollTolerance
    })
    if (cancelled()) return results

    // Close (ESC) and reopen the editor: position must survive the round-trip.
    document.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'Escape',
      code: 'Escape',
      bubbles: true,
      cancelable: true
    }))
    const closed = await waitFor(
      'phtml-scroll-persist-close',
      () => !(getApi()?.isOpen?.() ?? false),
      10000,
      100
    )
    const reopened = await ctx.reopenProjectEditor('phtml-scroll-persist-reopen')
    const fixtureBackAfterReopen = await waitFor(
      'phtml-scroll-persist-reopen-file',
      () => getApi()?.getActiveFilePath?.() === fixturePath,
      10000,
      100
    )
    const restoredAfterReopen = await waitForDocumentState(
      'phtml-scroll-persist-reopen-scroll',
      (state) => Math.abs((state.scrollY ?? 0) - HTML_SCROLL_TARGET_Y) <= htmlScrollTolerance,
      15000
    )
    record('PHTML-18-html-scroll-survives-close-reopen', Boolean(
      closed && reopened && fixtureBackAfterReopen && restoredAfterReopen.ok
    ), {
      target: HTML_SCROLL_TARGET_Y,
      restoredScrollY: restoredAfterReopen.state?.scrollY ?? null,
      tolerance: htmlScrollTolerance
    })

    // Persisted round-trip: some projectEditorStates entry must carry the
    // htmlScrollY for the fixture (locks the storage whitelist end-to-end).
    let persistedHtmlScrollY: number | null = null
    let persistedFound = false
    const persistPollStartedAt = performance.now()
    while (performance.now() - persistPollStartedAt < 10000) {
      const appState = await window.electronAPI.appState.load()
      for (const entry of Object.values(appState.projectEditorStates ?? {})) {
        const memory = entry?.fileStates?.[fixturePath]
        if (memory && typeof memory.htmlScrollY === 'number' && memory.htmlScrollY > 0) {
          persistedHtmlScrollY = memory.htmlScrollY
          persistedFound = true
          break
        }
      }
      if (persistedFound) break
      await sleep(200)
    }
    record('PHTML-19-html-scroll-persisted-in-appstate', persistedFound, {
      fixturePath,
      persistedHtmlScrollY
    })
  } finally {
    if (detourCreated.success) {
      await window.electronAPI.project.deletePath(ctx.rootPath, detourPath)
    }
  }

  return results
}
