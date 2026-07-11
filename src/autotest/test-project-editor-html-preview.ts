/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

import type { AutotestContext, TestResult } from './types'

const DEFAULT_HTML_FIXTURE_PATH = 'html-preview/regularization_landscape.html'
const DEFAULT_EXPECTED_TITLE = 'HTML Preview Autotest'
const DEFAULT_EXPECTED_TEXT = 'INITIAL_HTML_MARKER'
const UPDATED_MARKER = 'UPDATED_HTML_MARKER'
const SECOND_PAGE_TITLE = 'HTML Preview Nav Second Page'
const SECOND_PAGE_MARKER = 'SECOND_PAGE_MARKER'
const NAV_TEMP_MUTATION = 'NAV_TEMP_MUTATION'
const SAVE_REMOUNT_MARKER = 'NAV_SAVE_REMOUNT_MARKER'
const SCROLL_GUARD_MARKER = 'NAV_SCROLL_GUARD_MARKER'
const IFRAME_HOST_FIXTURE_PATH = 'html-preview/nav-iframe-host.html'
const IFRAME_HOST_TITLE = 'HTML Preview Iframe Host'
const IFRAME_HOST_MARKER = 'IFRAME_HOST_MARKER'
const NAV_BUTTON_KINDS = ['back', 'forward', 'reload', 'home'] as const

type NavButtonKind = (typeof NAV_BUTTON_KINDS)[number]

type NavStateSnapshot = {
  browserId: string | null
  url: string | null
  homeUrl: string | null
  canGoBack: boolean
  canGoForward: boolean
  backEnabled: boolean
  forwardEnabled: boolean
  reloadEnabled: boolean
  homeEnabled: boolean
}

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

  const waitForNavState = async (
    label: string,
    predicate: (state: NavStateSnapshot) => boolean,
    timeoutMs = 10000
  ): Promise<{ ok: boolean; state: NavStateSnapshot | null }> => {
    const start = performance.now()
    let lastState: NavStateSnapshot | null = null
    while (performance.now() - start < timeoutMs) {
      const state = getApi()?.getHtmlPreviewNavState?.() ?? null
      if (state) {
        lastState = state
        if (predicate(state)) {
          return { ok: true, state }
        }
      }
      await sleep(100)
    }
    ctx.log('html-preview-nav-timeout', { label, lastState })
    return { ok: false, state: lastState }
  }

  const navButton = (kind: NavButtonKind) =>
    document.querySelector<HTMLButtonElement>(`.project-editor-html-nav-${kind}-btn`)

  const domNavDisabledMatches = (state: NavStateSnapshot): boolean => {
    const back = navButton('back')
    const forward = navButton('forward')
    const reload = navButton('reload')
    const home = navButton('home')
    if (!back || !forward || !reload || !home) return false
    return back.disabled === !state.backEnabled &&
      forward.disabled === !state.forwardEnabled &&
      reload.disabled === !state.reloadEnabled &&
      home.disabled === !state.homeEnabled
  }

  const injectDomMutation = async (marker: string): Promise<boolean> => {
    const browserId = getApi()?.getHtmlReaderState?.()?.browserId
    if (!browserId) return false
    const result = await window.electronAPI.browser.evaluateForTest(browserId, `(() => {
      const el = document.createElement('p');
      el.textContent = ${JSON.stringify(marker)};
      document.body.appendChild(el);
      return true;
    })()`)
    return Boolean(result.success)
  }

  const clickPreviewLink = async (linkId: string): Promise<boolean> => {
    const browserId = getApi()?.getHtmlReaderState?.()?.browserId
    if (!browserId) return false
    const result = await window.electronAPI.browser.evaluateForTest(browserId, `(() => {
      const link = document.getElementById(${JSON.stringify(linkId)});
      if (!link) return false;
      link.click();
      return true;
    })()`)
    return Boolean(result.success) && result.value === true
  }

  const dispatchRefreshShortcut = () => {
    document.dispatchEvent(new KeyboardEvent('keydown', {
      bubbles: true,
      cancelable: true,
      key: 'r',
      metaKey: window.electronAPI.platform === 'darwin',
      ctrlKey: window.electronAPI.platform !== 'darwin'
    }))
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
  const navReloadVisibleWithoutEditor = await waitFor(
    'phtml-nav-reload-visible-without-editor',
    () => {
      return Boolean(
        getApi()?.isMarkdownEditorVisible?.() === false &&
        document.querySelector('.project-editor-html-nav-reload-btn') &&
        getApi()?.isHtmlReaderVisible?.()
      )
    },
    5000,
    100
  )
  record('PHTML-06-nav-reload-visible-without-editor', navReloadVisibleWithoutEditor, {
    editorVisible: getApi()?.isMarkdownEditorVisible?.() ?? null,
    hasButton: Boolean(document.querySelector('.project-editor-html-nav-reload-btn')),
    buttonText: document.querySelector('.project-editor-html-nav-reload-btn')?.textContent?.trim() ?? null,
    readerVisible: getApi()?.isHtmlReaderVisible?.() ?? false
  })
  const navReloadButtonText = document.querySelector('.project-editor-html-nav-reload-btn')?.textContent?.trim() ?? ''
  record('PHTML-06b-nav-reload-is-icon-only', navReloadButtonText === '', {
    buttonText: navReloadButtonText
  })
  const navReloadButtonTitle = document.querySelector('.project-editor-html-nav-reload-btn')?.getAttribute('title') ?? ''
  const expectedRefreshShortcut = window.electronAPI.platform === 'darwin' ? '⌘R' : 'Ctrl+R'
  const navReloadShortcutTitleOk = navReloadButtonTitle.includes(expectedRefreshShortcut)
  record('PHTML-06c-nav-reload-title-shows-shortcut', navReloadShortcutTitleOk, {
    title: navReloadButtonTitle,
    expectedRefreshShortcut
  })
  if (!navReloadVisibleWithoutEditor || navReloadButtonText !== '' || !navReloadShortcutTitleOk || cancelled()) return results

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

  document.querySelector<HTMLElement>('.project-editor-html-nav-reload-btn')?.focus()
  await sleep(120)
  const focusMovedAway = document.activeElement?.classList.contains('project-editor-html-nav-reload-btn') === true
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
  const shortcutMutationInjected = await injectDomMutation(NAV_TEMP_MUTATION)
  const shortcutMutationVisible = await waitForDocumentState(
    'phtml-refresh-shortcut-mutation-visible',
    (state) => Boolean(state.bodyText?.includes(NAV_TEMP_MUTATION)),
    5000
  )
  dispatchRefreshShortcut()
  const shortcutRendered = await waitForDocumentState(
    'phtml-refresh-shortcut-rendered',
    (state) => state.title === expectedTitle &&
      Boolean(state.bodyText?.includes(UPDATED_MARKER)) &&
      !state.bodyText?.includes(NAV_TEMP_MUTATION),
    10000
  )
  const afterShortcutReader = getApi()?.getHtmlReaderState?.() ?? null
  // Cmd/Ctrl+R is a hard reload of the current page IN PLACE: no remount, so
  // browserId and reloadKey must both stay unchanged.
  const shortcutReloadedInPlace = Boolean(
    beforeShortcutReader &&
    afterShortcutReader &&
    afterShortcutReader.browserId === beforeShortcutReader.browserId &&
    afterShortcutReader.reloadKey === beforeShortcutReader.reloadKey
  )
  record('PHTML-16-refresh-shortcut-hard-reloads-in-place', Boolean(
    shortcutMutationInjected && shortcutMutationVisible.ok && shortcutRendered.ok && shortcutReloadedInPlace
  ), {
    shortcutMutationInjected,
    mutationVisibleBeforeReload: shortcutMutationVisible.ok,
    beforeShortcutReader,
    afterShortcutReader,
    renderedTitle: shortcutRendered.state?.title ?? null,
    hasUpdatedMarker: Boolean(shortcutRendered.state?.bodyText?.includes(UPDATED_MARKER))
  })
  if (!shortcutMutationInjected || !shortcutRendered.ok || !shortcutReloadedInPlace || cancelled()) return results

  const initialNav = await waitForNavState(
    'phtml-nav-initial-state',
    (state) => Boolean(state.browserId) &&
      !state.backEnabled && !state.forwardEnabled && state.reloadEnabled && !state.homeEnabled
  )
  const navButtonsPresent = NAV_BUTTON_KINDS.every((kind) => Boolean(navButton(kind)))
  const navButtonsIconOnly = NAV_BUTTON_KINDS.every((kind) => (navButton(kind)?.textContent?.trim() ?? 'missing') === '')
  const navButtonsTitled = NAV_BUTTON_KINDS.every((kind) => Boolean(navButton(kind)?.getAttribute('title')))
  const domMatchesInitial = initialNav.ok && initialNav.state ? domNavDisabledMatches(initialNav.state) : false
  record('PHTML-17-nav-buttons-initial-state', Boolean(
    initialNav.ok && navButtonsPresent && navButtonsIconOnly && navButtonsTitled && domMatchesInitial
  ), {
    navState: initialNav.state,
    navButtonsPresent,
    navButtonsIconOnly,
    navButtonsTitled,
    domMatchesInitial
  })
  if (!initialNav.ok || !navButtonsPresent || !domMatchesInitial || cancelled()) return results

  const linkClicked = await clickPreviewLink('nav-second-link')
  const secondRendered = await waitForDocumentState(
    'phtml-nav-second-page-rendered',
    (state) => state.title === SECOND_PAGE_TITLE && Boolean(state.bodyText?.includes(SECOND_PAGE_MARKER))
  )
  const navAfterLink = await waitForNavState(
    'phtml-nav-after-link',
    (state) => state.backEnabled && !state.forwardEnabled && state.homeEnabled
  )
  const domMatchesAfterLink = navAfterLink.ok && navAfterLink.state ? domNavDisabledMatches(navAfterLink.state) : false
  record('PHTML-18-link-click-enables-back', Boolean(
    linkClicked && secondRendered.ok && navAfterLink.ok && domMatchesAfterLink
  ), {
    linkClicked,
    renderedTitle: secondRendered.state?.title ?? null,
    navState: navAfterLink.state,
    domMatchesAfterLink
  })
  if (!linkClicked || !secondRendered.ok || !navAfterLink.ok || cancelled()) return results

  navButton('back')?.click()
  const backRendered = await waitForDocumentState(
    'phtml-nav-back-rendered',
    (state) => state.title === expectedTitle && Boolean(state.bodyText?.includes(UPDATED_MARKER))
  )
  const navAfterBack = await waitForNavState(
    'phtml-nav-after-back',
    (state) => !state.backEnabled && state.forwardEnabled && !state.homeEnabled
  )
  record('PHTML-19-back-returns-to-opened-file', Boolean(backRendered.ok && navAfterBack.ok), {
    renderedTitle: backRendered.state?.title ?? null,
    navState: navAfterBack.state
  })
  if (!backRendered.ok || !navAfterBack.ok || cancelled()) return results

  navButton('forward')?.click()
  const forwardRendered = await waitForDocumentState(
    'phtml-nav-forward-rendered',
    (state) => state.title === SECOND_PAGE_TITLE && Boolean(state.bodyText?.includes(SECOND_PAGE_MARKER))
  )
  const navAfterForward = await waitForNavState(
    'phtml-nav-after-forward',
    (state) => state.backEnabled && !state.forwardEnabled && state.homeEnabled
  )
  record('PHTML-20-forward-re-enters-second-page', Boolean(forwardRendered.ok && navAfterForward.ok), {
    renderedTitle: forwardRendered.state?.title ?? null,
    navState: navAfterForward.state
  })
  if (!forwardRendered.ok || !navAfterForward.ok || cancelled()) return results

  const beforeReloadReader = getApi()?.getHtmlReaderState?.() ?? null
  const reloadMutationInjected = await injectDomMutation(NAV_TEMP_MUTATION)
  const reloadMutationVisible = await waitForDocumentState(
    'phtml-nav-reload-mutation-visible',
    (state) => Boolean(state.bodyText?.includes(NAV_TEMP_MUTATION)),
    5000
  )
  navButton('reload')?.click()
  const reloadRendered = await waitForDocumentState(
    'phtml-nav-reload-rendered',
    (state) => state.title === SECOND_PAGE_TITLE &&
      Boolean(state.bodyText?.includes(SECOND_PAGE_MARKER)) &&
      !state.bodyText?.includes(NAV_TEMP_MUTATION)
  )
  const afterReloadReader = getApi()?.getHtmlReaderState?.() ?? null
  const reloadInPlace = Boolean(
    beforeReloadReader &&
    afterReloadReader &&
    afterReloadReader.browserId === beforeReloadReader.browserId &&
    afterReloadReader.reloadKey === beforeReloadReader.reloadKey
  )
  record('PHTML-21-reload-discards-in-page-mutation', Boolean(
    reloadMutationInjected && reloadMutationVisible.ok && reloadRendered.ok && reloadInPlace
  ), {
    reloadMutationInjected,
    mutationVisibleBeforeReload: reloadMutationVisible.ok,
    renderedTitle: reloadRendered.state?.title ?? null,
    beforeReloadReader,
    afterReloadReader
  })
  if (!reloadMutationInjected || !reloadRendered.ok || !reloadInPlace || cancelled()) return results

  const beforeShortcutOnSecondReader = getApi()?.getHtmlReaderState?.() ?? null
  const secondMutationInjected = await injectDomMutation(NAV_TEMP_MUTATION)
  const secondMutationVisible = await waitForDocumentState(
    'phtml-nav-shortcut-second-mutation-visible',
    (state) => Boolean(state.bodyText?.includes(NAV_TEMP_MUTATION)),
    5000
  )
  dispatchRefreshShortcut()
  const shortcutOnSecondRendered = await waitForDocumentState(
    'phtml-nav-shortcut-second-rendered',
    (state) => state.title === SECOND_PAGE_TITLE &&
      Boolean(state.bodyText?.includes(SECOND_PAGE_MARKER)) &&
      !state.bodyText?.includes(NAV_TEMP_MUTATION)
  )
  const afterShortcutOnSecondReader = getApi()?.getHtmlReaderState?.() ?? null
  // Locks the requirement: Cmd/Ctrl+R on a navigated-away page reloads THAT
  // page and must NOT jump back to the opened file.
  const shortcutOnSecondInPlace = Boolean(
    beforeShortcutOnSecondReader &&
    afterShortcutOnSecondReader &&
    afterShortcutOnSecondReader.browserId === beforeShortcutOnSecondReader.browserId &&
    afterShortcutOnSecondReader.reloadKey === beforeShortcutOnSecondReader.reloadKey
  )
  record('PHTML-21b-reload-shortcut-stays-on-navigated-page', Boolean(
    secondMutationInjected && secondMutationVisible.ok && shortcutOnSecondRendered.ok && shortcutOnSecondInPlace
  ), {
    secondMutationInjected,
    mutationVisibleBeforeReload: secondMutationVisible.ok,
    renderedTitle: shortcutOnSecondRendered.state?.title ?? null,
    beforeShortcutOnSecondReader,
    afterShortcutOnSecondReader
  })
  if (!secondMutationInjected || !shortcutOnSecondRendered.ok || !shortcutOnSecondInPlace || cancelled()) return results

  navButton('home')?.click()
  const homeRendered = await waitForDocumentState(
    'phtml-nav-home-rendered',
    (state) => state.title === expectedTitle && Boolean(state.bodyText?.includes(UPDATED_MARKER))
  )
  const navAfterHome = await waitForNavState(
    'phtml-nav-after-home',
    (state) => state.backEnabled && !state.homeEnabled
  )
  record('PHTML-22-home-returns-and-pushes-history', Boolean(homeRendered.ok && navAfterHome.ok), {
    renderedTitle: homeRendered.state?.title ?? null,
    navState: navAfterHome.state
  })
  if (!homeRendered.ok || !navAfterHome.ok || cancelled()) return results

  navButton('back')?.click()
  const backToSecondRendered = await waitForDocumentState(
    'phtml-nav-back-after-home-rendered',
    (state) => state.title === SECOND_PAGE_TITLE && Boolean(state.bodyText?.includes(SECOND_PAGE_MARKER))
  )
  const navAfterBackFromHome = await waitForNavState(
    'phtml-nav-after-back-from-home',
    (state) => state.forwardEnabled && state.homeEnabled
  )
  record('PHTML-23-back-after-home-returns-to-second-page', Boolean(
    backToSecondRendered.ok && navAfterBackFromHome.ok
  ), {
    renderedTitle: backToSecondRendered.state?.title ?? null,
    navState: navAfterBackFromHome.state
  })
  if (!backToSecondRendered.ok || !navAfterBackFromHome.ok || cancelled()) return results

  const beforeSaveNavReader = getApi()?.getHtmlReaderState?.() ?? null
  const contentForRemount = getApi()?.getEditorContent?.() ?? ''
  const remountChanged = contentForRemount.includes(UPDATED_MARKER)
    ? getApi()?.setEditorContent?.(contentForRemount.replace(UPDATED_MARKER, SAVE_REMOUNT_MARKER)) === true
    : false
  const remountSaved = remountChanged ? (await getApi()?.triggerToolbarSave?.()) === true : false
  const remounted = await waitForDocumentState(
    'phtml-nav-save-remount',
    (state) => {
      const reader = getApi()?.getHtmlReaderState?.()
      return Boolean(
        state.bodyText?.includes(SAVE_REMOUNT_MARKER) &&
        reader &&
        beforeSaveNavReader &&
        reader.browserId !== beforeSaveNavReader.browserId &&
        reader.reloadKey > beforeSaveNavReader.reloadKey
      )
    },
    15000
  )
  const navAfterRemount = await waitForNavState(
    'phtml-nav-after-save-remount',
    (state) => !state.backEnabled && !state.forwardEnabled && !state.homeEnabled && state.reloadEnabled
  )
  // Locks the v1 decision: saving the source while navigated away remounts the
  // preview at the opened file and wipes the browsing history.
  record('PHTML-24-save-remount-resets-nav-history', Boolean(
    remountChanged && remountSaved && remounted.ok && navAfterRemount.ok
  ), {
    remountChanged,
    remountSaved,
    beforeSaveNavReader,
    afterReader: getApi()?.getHtmlReaderState?.() ?? null,
    navState: navAfterRemount.state
  })
  if (!remountChanged || !remountSaved || !remounted.ok || !navAfterRemount.ok || cancelled()) return results

  const blockedClicked = await clickPreviewLink('nav-blocked-link')
  await sleep(800)
  const afterBlockedState = await getApi()?.getHtmlPreviewDocumentState?.()
  const navAfterBlocked = getApi()?.getHtmlPreviewNavState?.() ?? null
  record('PHTML-25-blocked-nav-keeps-state', Boolean(
    blockedClicked &&
    afterBlockedState?.success &&
    afterBlockedState.bodyText?.includes(SAVE_REMOUNT_MARKER) &&
    navAfterBlocked &&
    !navAfterBlocked.backEnabled &&
    !navAfterBlocked.forwardEnabled &&
    !navAfterBlocked.homeEnabled
  ), {
    blockedClicked,
    hasHomeMarker: Boolean(afterBlockedState?.bodyText?.includes(SAVE_REMOUNT_MARKER)),
    navState: navAfterBlocked
  })
  if (!blockedClicked || cancelled()) return results

  // ADV-12: save while navigated away must NOT transplant the foreign page's
  // scroll offset onto the remounted home document — home renders from the top.
  const scrollGuardLinkClicked = await clickPreviewLink('nav-second-link')
  const scrollGuardSecondRendered = await waitForDocumentState(
    'phtml-scroll-guard-second-rendered',
    (state) => state.title === SECOND_PAGE_TITLE && Boolean(state.bodyText?.includes(SECOND_PAGE_MARKER))
  )
  await getApi()?.setHtmlPreviewScrollForTest?.(900)
  const secondScrolled = await waitForDocumentState(
    'phtml-scroll-guard-second-scrolled',
    (state) => (state.scrollY ?? 0) >= 600,
    5000
  )
  const beforeScrollGuardReader = getApi()?.getHtmlReaderState?.() ?? null
  const scrollGuardContent = getApi()?.getEditorContent?.() ?? ''
  const scrollGuardChanged = scrollGuardContent.includes(SAVE_REMOUNT_MARKER)
    ? getApi()?.setEditorContent?.(scrollGuardContent.replace(SAVE_REMOUNT_MARKER, SCROLL_GUARD_MARKER)) === true
    : false
  const scrollGuardSaved = scrollGuardChanged ? (await getApi()?.triggerToolbarSave?.()) === true : false
  const scrollGuardRemounted = await waitForDocumentState(
    'phtml-scroll-guard-remounted-home',
    (state) => {
      const reader = getApi()?.getHtmlReaderState?.()
      return Boolean(
        state.title === expectedTitle &&
        state.bodyText?.includes(SCROLL_GUARD_MARKER) &&
        reader && beforeScrollGuardReader && reader.browserId !== beforeScrollGuardReader.browserId
      )
    },
    15000
  )
  // Give any (buggy) scroll-restore path its ~50ms + settle window to act.
  await sleep(600)
  const homeScrollState = await getApi()?.getHtmlPreviewDocumentState?.()
  const homeAtTop = (homeScrollState?.scrollY ?? 0) < 150
  record('PHTML-26-save-while-navigated-does-not-transplant-scroll', Boolean(
    scrollGuardLinkClicked && scrollGuardSecondRendered.ok && secondScrolled.ok &&
    scrollGuardChanged && scrollGuardSaved && scrollGuardRemounted.ok && homeAtTop
  ), {
    secondScrolledY: secondScrolled.state?.scrollY ?? null,
    homeScrollY: homeScrollState?.scrollY ?? null,
    homeAtTop
  })
  if (!scrollGuardRemounted.ok || cancelled()) return results

  // ADV-21: rapid successive Reload clicks are idempotent — a hard reload in
  // place, no remount, no accumulated state.
  const beforeRapidReader = getApi()?.getHtmlReaderState?.() ?? null
  navButton('reload')?.click()
  navButton('reload')?.click()
  navButton('reload')?.click()
  const rapidReloadRendered = await waitForDocumentState(
    'phtml-rapid-reload-rendered',
    (state) => state.title === expectedTitle && Boolean(state.bodyText?.includes(SCROLL_GUARD_MARKER))
  )
  const afterRapidReader = getApi()?.getHtmlReaderState?.() ?? null
  const rapidReloadInPlace = Boolean(
    beforeRapidReader && afterRapidReader &&
    afterRapidReader.browserId === beforeRapidReader.browserId &&
    afterRapidReader.reloadKey === beforeRapidReader.reloadKey
  )
  record('PHTML-27-rapid-reload-clicks-are-idempotent', Boolean(rapidReloadRendered.ok && rapidReloadInPlace), {
    beforeRapidReader,
    afterRapidReader,
    renderedTitle: rapidReloadRendered.state?.title ?? null
  })
  if (cancelled()) return results

  // ADV-04: a subframe (iframe) in-page navigation must NOT hijack the top-level
  // URL / nav state — Home stays disabled because the TOP document is still home.
  await openFileInEditor(IFRAME_HOST_FIXTURE_PATH)
  const iframeOpened = await waitFor(
    'phtml-iframe-host-open',
    () => getApi()?.getActiveFilePath?.() === IFRAME_HOST_FIXTURE_PATH &&
      Boolean(getApi()?.isHtmlReaderVisible?.() && getApi()?.getHtmlReaderState?.()?.browserId),
    10000,
    100
  )
  const iframeHostRendered = await waitForDocumentState(
    'phtml-iframe-host-rendered',
    (state) => state.title === IFRAME_HOST_TITLE && Boolean(state.bodyText?.includes(IFRAME_HOST_MARKER))
  )
  // Let the child frame load and run its in-page pushState/hash navigation.
  await sleep(1200)
  const navAfterIframe = getApi()?.getHtmlPreviewNavState?.() ?? null
  const topDocState = await getApi()?.getHtmlPreviewDocumentState?.()
  const topStillHost = topDocState?.title === IFRAME_HOST_TITLE && Boolean(topDocState?.bodyText?.includes(IFRAME_HOST_MARKER))
  // The precise ADV-04 signal: the top-level url still points at the host doc, so
  // Home stays disabled (top doc IS home). If the subframe's pushState/hash had
  // leaked into state.url, isSameHtmlPreviewDocument(child, host) would be false
  // and Home would wrongly light up.
  const urlStillHost = Boolean(navAfterIframe?.url?.includes('nav-iframe-host')) &&
    !navAfterIframe?.url?.includes('child')
  record('PHTML-28-subframe-nav-does-not-hijack-top-state', Boolean(
    iframeOpened && iframeHostRendered.ok && topStillHost &&
    navAfterIframe && !navAfterIframe.homeEnabled && urlStillHost
  ), {
    iframeOpened,
    topStillHost,
    urlStillHost,
    navState: navAfterIframe
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
    // The nav suite (PHTML-17..28) leaves the iframe-host fixture active;
    // the scroll-persistence assertions target the main fixture, so
    // re-establish it as the active file before seeding.
    await openFileInEditor(fixturePath)
    await waitFor(
      'phtml-scroll-persist-fixture-back',
      () => getApi()?.getActiveFilePath?.() === fixturePath,
      10000,
      100
    )
    // A reload/reopen restores the previously captured scroll on the FIRST
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
    record('PHTML-29-html-scroll-survives-file-switch', Boolean(
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
    record('PHTML-30-html-scroll-survives-close-reopen', Boolean(
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
    record('PHTML-31-html-scroll-persisted-in-appstate', persistedFound, {
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
