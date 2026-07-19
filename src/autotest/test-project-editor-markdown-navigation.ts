/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

import type { AutotestContext, TestResult } from './types'

const SAMPLE_MARKDOWN_PATH = 'test/autotest/fixtures/dl_math_foundations.md'
const HIGHLIGHT_FIXTURE_PATH = 'docs/api-reference.md'
const OUTLINE_SCROLL_FIXTURE_PATH = 'docs/porting-diff-analysis.md'
const OUTLINE_SCROLL_FIXTURE_TEXT = 'Porting Diff Analysis'
const OUTLINE_SCROLL_MIN_SYMBOLS = 40
const IMAGE_FIXTURE_PATH = 'test/autotest/fixtures/markdown-image-preview.md'
const CODE_WRAP_FIXTURE_PATH = 'test/autotest/fixtures/markdown-code-wrap.md'
const CODE_OUTLINE_FIXTURE_PATH = 'test/autotest/fixtures/outline-fixture.py'
const SVG_DATA_URL_PREFIX = 'data:image/svg+xml;base64,'
const PNG_DATA_URL_PREFIX = 'data:image/png;base64,'
const SVG_IMAGE_MARKER = 'markdown-preview-dot.svg'
const PNG_IMAGE_MARKER = 'test-preview.png'

export async function testProjectEditorMarkdownNavigation(ctx: AutotestContext): Promise<TestResult[]> {
  const { assert, cancelled, openFileInEditor, reopenProjectEditor, sleep, waitFor } = ctx
  const results: TestResult[] = []
  const record = (name: string, ok: boolean, detail?: Record<string, unknown>) => {
    assert(name, ok, detail)
    results.push({ name, ok, detail })
  }

  const getApi = () => window.__onwardProjectEditorDebug
  const hasExpectedImageSource = (html: string, sources: string[], dataPrefix: string, fileMarker: string) => {
    return (
      html.includes(`src="${dataPrefix}`) ||
      html.includes(fileMarker) ||
      sources.some((source) => source.startsWith(dataPrefix) || source.includes(fileMarker))
    )
  }
  const waitForMarkdownFile = async (label: string, filePath: string, text: string) => {
    return waitFor(
      label,
      () => {
        const current = getApi()
        if (!current?.isOpen?.()) return false
        if (current?.getActiveFilePath?.() !== filePath) return false
        if (!current?.isMarkdownPreviewVisible?.()) return false
        if (current?.isMarkdownRenderPending?.()) return false
        const html = current?.getMarkdownRenderedHtml?.() ?? ''
        return html.includes(text)
      },
      15000,
      120
    )
  }

  const fixture = await window.electronAPI.project.readFile(ctx.rootPath, SAMPLE_MARKDOWN_PATH)
  record('PMN-00-fixture-exists', fixture.success, {
    path: SAMPLE_MARKDOWN_PATH,
    error: fixture.success ? null : fixture.error
  })
  if (!fixture.success || cancelled()) return results

  await openFileInEditor(SAMPLE_MARKDOWN_PATH)
  const opened = await waitFor(
    'pmn-open-markdown',
    () => getApi()?.getActiveFilePath?.() === SAMPLE_MARKDOWN_PATH,
    10000
  )
  record('PMN-01-open-markdown-file', opened, {
    actual: getApi()?.getActiveFilePath?.() ?? null
  })
  if (!opened || cancelled()) return results

  const rendered = await waitFor(
    'pmn-markdown-rendered',
    () => {
      const api = getApi()
      if (!api?.isOpen?.()) return false
      if (!api?.isMarkdownPreviewVisible?.()) return false
      if (api?.isMarkdownRenderPending?.()) return false
      const html = api?.getMarkdownRenderedHtml?.() ?? ''
      return html.includes('Deep Learning Math Foundations') && html.length > 1000
    },
    15000,
    120
  )
  record('PMN-02-markdown-preview-rendered', rendered, {
    renderPending: getApi()?.isMarkdownRenderPending?.(),
    htmlLength: getApi()?.getMarkdownRenderedHtml?.().length ?? 0
  })
  if (!rendered || cancelled()) return results

  getApi()?.setSidebarMode?.('files')
  getApi()?.setFileBrowserCollapsed?.(false)
  getApi()?.setOutlineVisible?.(true)

  const outlineReady = await waitFor(
    'pmn-outline-ready',
    () => {
      const api = getApi()
      return Boolean(api?.isOutlineVisible?.() && (api?.getOutlineSymbolCount?.() ?? 0) >= 3)
    },
    8000,
    100
  )
  record('PMN-03-outline-symbols-loaded', outlineReady, {
    outlineVisible: getApi()?.isOutlineVisible?.() ?? false,
    symbolCount: getApi()?.getOutlineSymbolCount?.() ?? 0
  })
  if (!outlineReady || cancelled()) return results

  const canCollapseFileBrowser = Boolean(
    getApi()?.setFileBrowserCollapsed &&
    getApi()?.isFileBrowserCollapsed &&
    getApi()?.getFileBrowserPanelState
  )
  record('PMN-03b-file-browser-collapse-api-available', canCollapseFileBrowser)
  if (canCollapseFileBrowser) {
    getApi()?.setFileBrowserCollapsed?.(false)
    const expandedBeforeCollapse = await waitFor(
      'pmn-file-browser-expanded-before-collapse',
      () => getApi()?.isFileBrowserCollapsed?.() === false && getApi()?.getFileBrowserPanelState?.().hasTree === true,
      3000,
      80
    )
    getApi()?.setFileBrowserCollapsed?.(true)
    const collapsed = await waitFor(
      'pmn-file-browser-collapsed',
      () => {
        const state = getApi()?.getFileBrowserPanelState?.()
        return Boolean(
          getApi()?.isFileBrowserCollapsed?.() === true &&
          state?.collapsed &&
          state.hasRestoreButton &&
          !state.hasTree &&
          !state.hasResizer &&
          state.sidebarWidth <= 42
        )
      },
      3000,
      80
    )
    const collapsedState = getApi()?.getFileBrowserPanelState?.() ?? null
    record('PMN-03c-file-browser-collapses', Boolean(expandedBeforeCollapse && collapsed), {
      expandedBeforeCollapse,
      collapsedState
    })
    getApi()?.setFileBrowserCollapsed?.(false)
    const expanded = await waitFor(
      'pmn-file-browser-expanded-after-collapse',
      () => {
        const state = getApi()?.getFileBrowserPanelState?.()
        return Boolean(
          getApi()?.isFileBrowserCollapsed?.() === false &&
          state?.hasTree &&
          state.hasResizer &&
          state.sidebarWidth >= 180
        )
      },
      3000,
      80
    )
    record('PMN-03d-file-browser-expands', expanded, {
      expandedState: getApi()?.getFileBrowserPanelState?.() ?? null
    })
    if (!expanded || cancelled()) return results
  }

  // Outline rows and the file tree must render at the same font size: both inherit
  // --project-editor-font-size from the ProjectEditor modal root, so the two sidebars
  // stay visually consistent and move together when the editor font-size setting changes.
  const sidebarFontMatched = await waitFor(
    'pmn-sidebar-font-size-parity',
    () => {
      const tree = document.querySelector<HTMLElement>('.project-editor-tree')
      const outlineItem = document.querySelector<HTMLElement>('.outline-panel-item')
      if (!tree || !outlineItem) return false
      return getComputedStyle(tree).fontSize === getComputedStyle(outlineItem).fontSize
    },
    3000,
    80
  )
  const treeEl = document.querySelector<HTMLElement>('.project-editor-tree')
  const outlineItemEl = document.querySelector<HTMLElement>('.outline-panel-item')
  record('PMN-03e-sidebar-font-size-parity', sidebarFontMatched, {
    treeFontSize: treeEl ? getComputedStyle(treeEl).fontSize : null,
    outlineItemFontSize: outlineItemEl ? getComputedStyle(outlineItemEl).fontSize : null,
    modalVariable: (() => {
      const modal = document.querySelector<HTMLElement>('.project-editor-modal')
      return modal ? getComputedStyle(modal).getPropertyValue('--project-editor-font-size').trim() : null
    })()
  })
  if (!sidebarFontMatched || cancelled()) return results

  const highlightFixture = await window.electronAPI.project.readFile(ctx.rootPath, HIGHLIGHT_FIXTURE_PATH)
  record('PMN-04-highlight-fixture-exists', highlightFixture.success, {
    path: HIGHLIGHT_FIXTURE_PATH,
    error: highlightFixture.success ? null : highlightFixture.error
  })
  if (!highlightFixture.success || cancelled()) return results

  await getApi()?.openFileByPath?.(HIGHLIGHT_FIXTURE_PATH)
  const highlightRendered = await waitFor(
    'pmn-highlight-rendered',
    () => {
      const current = getApi()
      if (!current?.isOpen?.()) return false
      if (current?.getActiveFilePath?.() !== HIGHLIGHT_FIXTURE_PATH) return false
      if (!current?.isMarkdownPreviewVisible?.()) return false
      if (current?.isMarkdownRenderPending?.()) return false
      const html = current?.getMarkdownRenderedHtml?.() ?? ''
      return html.includes('API Reference') && html.includes('class="hljs') && /hljs-[^"']+/.test(html)
    },
    15000,
    120
  )
  record('PMN-05-markdown-code-highlight-rendered', highlightRendered, {
    activeFilePath: getApi()?.getActiveFilePath?.() ?? null,
    htmlLength: getApi()?.getMarkdownRenderedHtml?.().length ?? 0,
    hasHljsRoot: (getApi()?.getMarkdownRenderedHtml?.() ?? '').includes('class="hljs'),
    hasHljsToken: /hljs-[^"']+/.test(getApi()?.getMarkdownRenderedHtml?.() ?? '')
  })
  if (!highlightRendered || cancelled()) return results

  const imageFixture = await window.electronAPI.project.readFile(ctx.rootPath, IMAGE_FIXTURE_PATH)
  record('PMN-06-image-fixture-exists', imageFixture.success, {
    path: IMAGE_FIXTURE_PATH,
    error: imageFixture.success ? null : imageFixture.error
  })
  if (!imageFixture.success || cancelled()) return results

  await getApi()?.openFileByPath?.(IMAGE_FIXTURE_PATH)
  const imageRendered = await waitFor(
    'pmn-image-rendered',
    () => {
      const current = getApi()
      if (!current?.isOpen?.()) return false
      if (current?.getActiveFilePath?.() !== IMAGE_FIXTURE_PATH) return false
      if (!current?.isMarkdownPreviewVisible?.()) return false
      if (current?.isMarkdownRenderPending?.()) return false
      const html = current?.getMarkdownRenderedHtml?.() ?? ''
      const imageState = current?.getMarkdownPreviewImageState?.()
      const sources = imageState?.sources ?? []
      return (
        html.includes('AUTOTEST_IMAGE_ORIGINAL') &&
        html.includes('<img') &&
        hasExpectedImageSource(html, sources, SVG_DATA_URL_PREFIX, SVG_IMAGE_MARKER) &&
        hasExpectedImageSource(html, sources, PNG_DATA_URL_PREFIX, PNG_IMAGE_MARKER) &&
        (imageState?.count ?? 0) >= 2 &&
        (imageState?.loadedCount ?? 0) >= 2 &&
        (imageState?.brokenCount ?? 0) === 0
      )
    },
    15000,
    120
  )
  const imageRenderedHtml = getApi()?.getMarkdownRenderedHtml?.() ?? ''
  const imageRenderedState = getApi()?.getMarkdownPreviewImageState?.()
  const imageRenderedSources = imageRenderedState?.sources ?? []
  record('PMN-07-markdown-image-rendered', imageRendered, {
    activeFilePath: getApi()?.getActiveFilePath?.() ?? null,
    htmlLength: imageRenderedHtml.length,
    hasImageTag: imageRenderedHtml.includes('<img'),
    hasSvgPreviewImage: hasExpectedImageSource(imageRenderedHtml, imageRenderedSources, SVG_DATA_URL_PREFIX, SVG_IMAGE_MARKER),
    hasPngPreviewImage: hasExpectedImageSource(imageRenderedHtml, imageRenderedSources, PNG_DATA_URL_PREFIX, PNG_IMAGE_MARKER),
    imageState: imageRenderedState ?? null
  })
  if (!imageRendered || cancelled()) return results

  const canEditMarkdown = Boolean(getApi()?.setEditorContent)
  record('PMN-08-markdown-editor-content-api-available', canEditMarkdown)
  if (!canEditMarkdown || cancelled()) return results

  const editedImageContent = `${getApi()?.getEditorContent?.() ?? ''}\n\nAUTOTEST_IMAGE_EDITED\n`
  getApi()?.setEditorContent?.(editedImageContent)
  const imageStillRenderedAfterEdit = await waitFor(
    'pmn-image-rendered-after-edit',
    () => {
      const current = getApi()
      if (!current?.isOpen?.()) return false
      if (current?.getActiveFilePath?.() !== IMAGE_FIXTURE_PATH) return false
      if (current?.isMarkdownRenderPending?.()) return false
      const html = current?.getMarkdownRenderedHtml?.() ?? ''
      const imageState = current?.getMarkdownPreviewImageState?.()
      const sources = imageState?.sources ?? []
      return (
        html.includes('AUTOTEST_IMAGE_EDITED') &&
        html.includes('<img') &&
        hasExpectedImageSource(html, sources, SVG_DATA_URL_PREFIX, SVG_IMAGE_MARKER) &&
        hasExpectedImageSource(html, sources, PNG_DATA_URL_PREFIX, PNG_IMAGE_MARKER) &&
        (imageState?.count ?? 0) >= 2 &&
        (imageState?.loadedCount ?? 0) >= 2 &&
        (imageState?.brokenCount ?? 0) === 0
      )
    },
    15000,
    120
  )
  const editedImageHtml = getApi()?.getMarkdownRenderedHtml?.() ?? ''
  const editedImageState = getApi()?.getMarkdownPreviewImageState?.()
  const editedImageSources = editedImageState?.sources ?? []
  record('PMN-09-markdown-image-persists-after-edit', imageStillRenderedAfterEdit, {
    activeFilePath: getApi()?.getActiveFilePath?.() ?? null,
    htmlLength: editedImageHtml.length,
    hasEditedMarker: editedImageHtml.includes('AUTOTEST_IMAGE_EDITED'),
    hasImageTag: editedImageHtml.includes('<img'),
    hasSvgPreviewImage: hasExpectedImageSource(editedImageHtml, editedImageSources, SVG_DATA_URL_PREFIX, SVG_IMAGE_MARKER),
    hasPngPreviewImage: hasExpectedImageSource(editedImageHtml, editedImageSources, PNG_DATA_URL_PREFIX, PNG_IMAGE_MARKER),
    imageState: editedImageState ?? null
  })
  if (!imageStillRenderedAfterEdit || cancelled()) return results

  await getApi()?.openFileByPath?.(SAMPLE_MARKDOWN_PATH)
  const sampleRestored = await waitFor(
    'pmn-sample-restored',
    () => {
      const current = getApi()
      if (!current?.isOpen?.()) return false
      if (current?.getActiveFilePath?.() !== SAMPLE_MARKDOWN_PATH) return false
      if (!current?.isMarkdownPreviewVisible?.()) return false
      if (current?.isMarkdownRenderPending?.()) return false
      const html = current?.getMarkdownRenderedHtml?.() ?? ''
      return html.includes('Deep Learning Math Foundations')
    },
    15000,
    120
  )
  record('PMN-10-sample-markdown-restored', sampleRestored, {
    activeFilePath: getApi()?.getActiveFilePath?.() ?? null,
    htmlLength: getApi()?.getMarkdownRenderedHtml?.().length ?? 0
  })
  if (!sampleRestored || cancelled()) return results

  const api = getApi()
  const canToggleEditor = Boolean(
    api?.setMarkdownEditorVisible &&
    api?.setMarkdownPreviewVisible &&
    api?.isMarkdownEditorVisible
  )
  record('PMN-11-editor-visibility-api-available', canToggleEditor)
  if (!canToggleEditor || cancelled()) return results

  const canManageOutline = Boolean(
    api?.setOutlineVisible &&
    api?.getOutlineScrollTop &&
    api?.scrollOutlineToFraction &&
    api?.clickOutlineItemByName
  )
  record('PMN-12-outline-memory-api-available', canManageOutline)

  let savedMarkdownOutlineScroll = 0
  if (canManageOutline) {
    await getApi()?.openFileByPath?.(OUTLINE_SCROLL_FIXTURE_PATH)
    const highlightOutlineReady = await waitFor(
      'pmn-highlight-outline-ready',
      () => {
        const current = getApi()
        if (!current?.isOpen?.()) return false
        if (current?.getActiveFilePath?.() !== OUTLINE_SCROLL_FIXTURE_PATH) return false
        if (!current?.isMarkdownPreviewVisible?.()) return false
        if (current?.isMarkdownRenderPending?.()) return false
        const html = current?.getMarkdownRenderedHtml?.() ?? ''
        return (
          html.includes(OUTLINE_SCROLL_FIXTURE_TEXT) &&
          (current?.getOutlineSymbolCount?.() ?? 0) >= OUTLINE_SCROLL_MIN_SYMBOLS
        )
      },
      15000,
      120
    )
    record('PMN-13-highlight-outline-ready', highlightOutlineReady, {
      activeFilePath: getApi()?.getActiveFilePath?.() ?? null,
      symbolCount: getApi()?.getOutlineSymbolCount?.() ?? 0,
      minSymbols: OUTLINE_SCROLL_MIN_SYMBOLS
    })
    if (!highlightOutlineReady || cancelled()) return results

    api?.setOutlineVisible?.(true)
    let markdownOutlineScrolled = false
    const markdownOutlineScrollCaptured = await waitFor(
      'pmn-markdown-outline-scroll-captured-ready',
      () => {
        const current = getApi()
        if (current?.isOutlineVisible?.() !== true) return false
        if ((current?.getOutlineSymbolCount?.() ?? 0) <= 0) return false
        const maxScroll = current?.getOutlineScrollMax?.() ?? 0
        if (maxScroll <= 40) return true
        markdownOutlineScrolled = Boolean(current?.scrollOutlineToFraction?.(0.88))
        savedMarkdownOutlineScroll = current?.getOutlineScrollTop?.() ?? 0
        return markdownOutlineScrolled && savedMarkdownOutlineScroll > 40
      },
      5000,
      80
    )
    savedMarkdownOutlineScroll = getApi()?.getOutlineScrollTop?.() ?? savedMarkdownOutlineScroll
    record('PMN-14-markdown-outline-scroll-captured', markdownOutlineScrollCaptured, {
      outlineScrolled: markdownOutlineScrolled,
      scrollTop: Math.round(savedMarkdownOutlineScroll),
      outlineScrollHeight: getApi()?.getOutlineScrollHeight?.() ?? null,
      outlineScrollMax: getApi()?.getOutlineScrollMax?.() ?? null,
      symbolCount: getApi()?.getOutlineSymbolCount?.() ?? null
    })

    api?.setOutlineVisible?.(false)
    const outlineHidden = await waitFor(
      'pmn-outline-hidden',
      () => getApi()?.isOutlineVisible?.() === false,
      3000,
      60
    )
    record('PMN-15-markdown-outline-can-close', outlineHidden, {
      outlineVisible: getApi()?.isOutlineVisible?.()
    })

    api?.setOutlineVisible?.(true)
    const markdownOutlineRestored = await waitFor(
      'pmn-markdown-outline-restored',
      () => {
        const current = getApi()
        const scrollTop = current?.getOutlineScrollTop?.() ?? 0
        return current?.isOutlineVisible?.() === true && Math.abs(scrollTop - savedMarkdownOutlineScroll) <= 40
      },
      5000,
      80
    )
    record('PMN-16-markdown-outline-restores-after-toggle', markdownOutlineRestored, {
      savedScrollTop: Math.round(savedMarkdownOutlineScroll),
      restoredScrollTop: Math.round(getApi()?.getOutlineScrollTop?.() ?? 0)
    })

    await getApi()?.openFileByPath?.(SAMPLE_MARKDOWN_PATH)
    const sampleAfterOutlineTest = await waitForMarkdownFile('pmn-sample-after-outline-test', SAMPLE_MARKDOWN_PATH, 'Deep Learning Math Foundations')
    record('PMN-17-sample-after-outline-test', sampleAfterOutlineTest, {
      activeFilePath: getApi()?.getActiveFilePath?.() ?? null
    })
    if (!sampleAfterOutlineTest || cancelled()) return results
  }
  if (cancelled()) return results

  const codeOutlineFixture = await window.electronAPI.project.readFile(ctx.rootPath, CODE_OUTLINE_FIXTURE_PATH)
  record('PMN-18-code-outline-fixture-exists', codeOutlineFixture.success, {
    path: CODE_OUTLINE_FIXTURE_PATH,
    error: codeOutlineFixture.success ? null : codeOutlineFixture.error
  })
  if (!codeOutlineFixture.success || cancelled()) return results

  await getApi()?.openFileByPath?.(CODE_OUTLINE_FIXTURE_PATH)
  const codeOutlineReady = await waitFor(
    'pmn-code-outline-ready',
    () => {
      const current = getApi()
      return Boolean(
        current?.getActiveFilePath?.() === CODE_OUTLINE_FIXTURE_PATH &&
        current?.isOutlineVisible?.() &&
        (current?.getOutlineSymbolCount?.() ?? 0) >= 5
      )
    },
    12000,
    120
  )
  record('PMN-19-code-outline-symbols-loaded', codeOutlineReady, {
    activeFilePath: getApi()?.getActiveFilePath?.() ?? null,
    symbolCount: getApi()?.getOutlineSymbolCount?.() ?? 0
  })
  if (!codeOutlineReady || cancelled()) return results

  if (canManageOutline) {
    const codeOutlineScrolled = Boolean(getApi()?.scrollOutlineToFraction?.(0.7))
    await sleep(220)
    const savedCodeOutlineScroll = getApi()?.getOutlineScrollTop?.() ?? 0
    record('PMN-20-code-outline-scroll-captured', codeOutlineScrolled && savedCodeOutlineScroll >= 0, {
      scrollTop: Math.round(savedCodeOutlineScroll)
    })

    await getApi()?.openFileByPath?.(SAMPLE_MARKDOWN_PATH)
    const sampleVisibleAgain = await waitForMarkdownFile('pmn-sample-visible-again', SAMPLE_MARKDOWN_PATH, 'Deep Learning Math Foundations')
    record('PMN-21-sample-visible-again', sampleVisibleAgain, {
      activeFilePath: getApi()?.getActiveFilePath?.() ?? null
    })
    if (!sampleVisibleAgain || cancelled()) return results

    await getApi()?.openFileByPath?.(CODE_OUTLINE_FIXTURE_PATH)
    const codeOutlineRestored = await waitFor(
      'pmn-code-outline-restored',
      () => {
        const current = getApi()
        const scrollTop = current?.getOutlineScrollTop?.() ?? 0
        return current?.getActiveFilePath?.() === CODE_OUTLINE_FIXTURE_PATH && Math.abs(scrollTop - savedCodeOutlineScroll) <= 40
      },
      8000,
      100
    )
    record('PMN-22-code-outline-restores-after-file-switch', codeOutlineRestored, {
      savedScrollTop: Math.round(savedCodeOutlineScroll),
      restoredScrollTop: Math.round(getApi()?.getOutlineScrollTop?.() ?? 0)
    })
    if (!codeOutlineRestored || cancelled()) return results
  }

  await getApi()?.openFileByPath?.(SAMPLE_MARKDOWN_PATH)
  const sampleReadyAgain = await waitForMarkdownFile('pmn-sample-ready-again', SAMPLE_MARKDOWN_PATH, 'Deep Learning Math Foundations')
  record('PMN-23-sample-ready-again', sampleReadyAgain, {
    activeFilePath: getApi()?.getActiveFilePath?.() ?? null,
    htmlLength: getApi()?.getMarkdownRenderedHtml?.().length ?? 0
  })
  if (!sampleReadyAgain || cancelled()) return results

  api?.setMarkdownEditorVisible?.(false)
  const editorHidden = await waitFor(
    'pmn-editor-hidden',
    () => {
      const current = getApi()
      return current?.isMarkdownEditorVisible?.() === false && current?.isMarkdownPreviewVisible?.() === true
    },
    4000,
    80
  )
  record('PMN-24-markdown-read-mode-keeps-preview-open', editorHidden, {
    editorVisible: getApi()?.isMarkdownEditorVisible?.(),
    previewVisible: getApi()?.isMarkdownPreviewVisible?.()
  })
  if (!editorHidden || cancelled()) return results

  const canOpenPreviewSearch = Boolean(api?.setPreviewSearchOpen && api?.isPreviewSearchOpen)
  record('PMN-25-preview-search-api-available', canOpenPreviewSearch)
  if (canOpenPreviewSearch) {
    api?.setPreviewSearchOpen?.(true)
    const searchOpened = await waitFor(
      'pmn-preview-search-opened',
      () => getApi()?.isPreviewSearchOpen?.() === true,
      3000,
      60
    )
    record('PMN-26-preview-search-opened', searchOpened, {
      previewSearchOpen: getApi()?.isPreviewSearchOpen?.()
    })
  }

  const canUsePreviewOutline = Boolean(
    api?.setOutlineTarget &&
    api?.getOutlineTarget &&
    api?.getOutlineEffectiveTarget &&
    api?.scrollPreviewToFraction &&
    api?.getPreviewActiveSlug &&
    api?.clickOutlineItemByName
  )
  record('PMN-27-preview-outline-api-available', canUsePreviewOutline)
  if (canUsePreviewOutline) {
    const sampleOutlineReadyForPreviewTarget = await waitFor(
      'pmn-sample-outline-ready-for-preview-target',
      () => {
        const current = getApi()
        return Boolean(
          current?.getActiveFilePath?.() === SAMPLE_MARKDOWN_PATH &&
          current?.isOutlineVisible?.() &&
          (current?.getOutlineSymbolCount?.() ?? 0) >= 3
        )
      },
      5000,
      80
    )
    record('PMN-28-sample-outline-ready-for-preview-target', sampleOutlineReadyForPreviewTarget, {
      activeFilePath: getApi()?.getActiveFilePath?.() ?? null,
      symbolCount: getApi()?.getOutlineSymbolCount?.() ?? 0
    })
    if (!sampleOutlineReadyForPreviewTarget || cancelled()) return results

    const beforeSlug = getApi()?.getPreviewActiveSlug?.() ?? null
    const previewScrollBeforeTrack = getApi()?.getPreviewScrollTop?.() ?? 0
    const previewScrollHeightBeforeTrack = getApi()?.getPreviewScrollHeight?.() ?? 0
    const previewTargetFraction = previewScrollBeforeTrack > previewScrollHeightBeforeTrack * 0.5 ? 0.2 : 0.8
    api?.setOutlineTarget?.('preview')
    api?.scrollPreviewToFraction?.(previewTargetFraction)
    const previewTracked = await waitFor(
      'pmn-preview-outline-tracked',
      () => {
        const current = getApi()
        const scrollTop = current?.getPreviewScrollTop?.() ?? 0
        return current?.getOutlineTarget?.() === 'preview' && Math.abs(scrollTop - previewScrollBeforeTrack) > 40
      },
      4000,
      80
    )
    const afterSlug = getApi()?.getPreviewActiveSlug?.() ?? null
    record('PMN-29-preview-scroll-updates-active-heading', previewTracked, {
      beforeSlug,
      afterSlug,
      previewTargetFraction,
      previewScrollBeforeTrack: Math.round(previewScrollBeforeTrack),
      previewScrollAfterTrack: Math.round(getApi()?.getPreviewScrollTop?.() ?? 0),
      outlineTarget: getApi()?.getOutlineTarget?.()
    })

    const previewTargetBeforeClick = getApi()?.getOutlineEffectiveTarget?.() ?? null
    const previewScrollBeforeClick = getApi()?.getPreviewScrollTop?.() ?? 0
    const clickedPreviewHeading = Boolean(getApi()?.clickOutlineItemByName?.('Mixed Narrative'))
    const previewFallbackWorked = await waitFor(
      'pmn-preview-heading-fallback',
      () => {
        const current = getApi()
        const scrollTop = current?.getPreviewScrollTop?.() ?? 0
        return current?.getOutlineEffectiveTarget?.() === 'preview' && Math.abs(scrollTop - previewScrollBeforeClick) > 40
      },
      5000,
      80
    )
    record('PMN-30-outline-falls-back-to-preview-when-editor-hidden', clickedPreviewHeading && previewFallbackWorked, {
      clickedPreviewHeading,
      effectiveTarget: getApi()?.getOutlineEffectiveTarget?.() ?? null,
      effectiveTargetBeforeClick: previewTargetBeforeClick,
      previewScrollBeforeClick: Math.round(previewScrollBeforeClick),
      previewScrollAfterClick: Math.round(getApi()?.getPreviewScrollTop?.() ?? 0)
    })
  }
  if (cancelled()) return results

  api?.setMarkdownEditorVisible?.(true)
  const editorRestoredBeforePreviewClose = await waitFor(
    'pmn-editor-restored-before-preview-close',
    () => getApi()?.isMarkdownEditorVisible?.() === true && getApi()?.isMarkdownPreviewVisible?.() === true,
    3000,
    60
  )
  record('PMN-31-markdown-editor-restored-before-preview-close', editorRestoredBeforePreviewClose, {
    editorVisible: getApi()?.isMarkdownEditorVisible?.(),
    previewVisible: getApi()?.isMarkdownPreviewVisible?.()
  })
  if (!editorRestoredBeforePreviewClose || cancelled()) return results

  api?.setMarkdownPreviewVisible?.(false)
  const previewHidden = await waitFor(
    'pmn-preview-hidden',
    () => {
      const current = getApi()
      return current?.isMarkdownPreviewVisible?.() === false && current?.isMarkdownEditorVisible?.() === true
    },
    4000,
    80
  )
  record('PMN-32-markdown-edit-mode-can-hide-preview', previewHidden, {
    editorVisible: getApi()?.isMarkdownEditorVisible?.(),
    previewVisible: getApi()?.isMarkdownPreviewVisible?.()
  })
  if (!previewHidden || cancelled()) return results

  if (canUsePreviewOutline) {
    api?.setOutlineTarget?.('preview')
    api?.setCursorPosition?.(1, 1)
    const editorTargetBeforeClick = getApi()?.getOutlineEffectiveTarget?.() ?? null
    const clickedEditorHeading = Boolean(getApi()?.clickOutlineItemByName?.('Display Equations'))
    const editorFallbackWorked = await waitFor(
      'pmn-editor-heading-fallback',
      () => {
        const current = getApi()
        const line = current?.getCursorPosition?.()?.lineNumber ?? 0
        return current?.getOutlineEffectiveTarget?.() === 'editor' && line >= 40
      },
      5000,
      80
    )
    record('PMN-33-outline-falls-back-to-editor-when-preview-hidden', clickedEditorHeading && editorFallbackWorked, {
      effectiveTarget: getApi()?.getOutlineEffectiveTarget?.() ?? null,
      effectiveTargetBeforeClick: editorTargetBeforeClick,
      cursor: getApi()?.getCursorPosition?.() ?? null
    })
  }
  if (cancelled()) return results

  api?.setMarkdownPreviewVisible?.(true)
  const previewRestored = await waitForMarkdownFile('pmn-preview-restored', SAMPLE_MARKDOWN_PATH, 'Deep Learning Math Foundations')
  record('PMN-34-markdown-preview-restored', previewRestored, {
    previewVisible: getApi()?.isMarkdownPreviewVisible?.(),
    htmlLength: getApi()?.getMarkdownRenderedHtml?.().length ?? 0
  })
  if (!previewRestored || cancelled()) return results

  const codeWrapFixture = await window.electronAPI.project.readFile(ctx.rootPath, CODE_WRAP_FIXTURE_PATH)
  record('PMN-35-code-wrap-fixture-exists', codeWrapFixture.success, {
    path: CODE_WRAP_FIXTURE_PATH,
    error: codeWrapFixture.success ? null : codeWrapFixture.error
  })
  if (!codeWrapFixture.success || cancelled()) return results

  await getApi()?.openFileByPath?.(CODE_WRAP_FIXTURE_PATH)
  const codeWrapRendered = await waitForMarkdownFile('pmn-code-wrap-rendered', CODE_WRAP_FIXTURE_PATH, 'Markdown Code Wrap Fixture')
  record('PMN-36-code-wrap-markdown-rendered', codeWrapRendered, {
    activeFilePath: getApi()?.getActiveFilePath?.() ?? null,
    htmlLength: getApi()?.getMarkdownRenderedHtml?.().length ?? 0
  })
  if (!codeWrapRendered || cancelled()) return results

  const canToggleCodeWrap = Boolean(
    api?.isMarkdownCodeWrapEnabled &&
    api?.setMarkdownCodeWrapEnabled &&
    api?.getMarkdownCodeWrapState
  )
  record('PMN-37-code-wrap-api-available', canToggleCodeWrap)
  if (canToggleCodeWrap) {
    api?.setMarkdownCodeWrapEnabled?.(false)
    const wrapDisabled = await waitFor(
      'pmn-code-wrap-disabled',
      () => {
        const state = getApi()?.getMarkdownCodeWrapState?.()
        return Boolean(
          state &&
          state.enabled === false &&
          state.blockWhiteSpace !== 'pre-wrap' &&
          state.inlineOverflowWrap !== 'anywhere'
        )
      },
      4000,
      80
    )
    record('PMN-38-code-wrap-disabled-state', wrapDisabled, {
      state: getApi()?.getMarkdownCodeWrapState?.() ?? null
    })
    if (cancelled()) return results

    api?.setMarkdownCodeWrapEnabled?.(true)
    const wrapEnabled = await waitFor(
      'pmn-code-wrap-enabled',
      () => {
        const state = getApi()?.getMarkdownCodeWrapState?.()
        return Boolean(
          state &&
          state.enabled === true &&
          state.blockWhiteSpace === 'pre-wrap' &&
          state.blockOverflowWrap === 'anywhere' &&
          state.inlineOverflowWrap === 'anywhere'
        )
      },
      4000,
      80
    )
    record('PMN-39-code-wrap-updates-inline-and-block-code', wrapEnabled, {
      state: getApi()?.getMarkdownCodeWrapState?.() ?? null
    })
    if (!wrapEnabled || cancelled()) return results
  }

  const reopened = await reopenProjectEditor('pmn-reopen-project-editor')
  record('PMN-40-project-editor-reopened', reopened)
  if (!reopened || cancelled()) return results

  await getApi()?.openFileByPath?.(CODE_WRAP_FIXTURE_PATH)
  const wrapFixtureAfterReopen = await waitForMarkdownFile('pmn-code-wrap-after-reopen', CODE_WRAP_FIXTURE_PATH, 'Markdown Code Wrap Fixture')
  record('PMN-41-code-wrap-fixture-opened-after-reopen', wrapFixtureAfterReopen, {
    activeFilePath: getApi()?.getActiveFilePath?.() ?? null
  })
  if (!wrapFixtureAfterReopen || cancelled()) return results

  if (canToggleCodeWrap) {
    const wrapPersistedAfterReopen = await waitFor(
      'pmn-code-wrap-persisted-after-reopen',
      () => {
        const state = getApi()?.getMarkdownCodeWrapState?.()
        return Boolean(
          getApi()?.isMarkdownCodeWrapEnabled?.() === true &&
          state?.enabled === true &&
          (state?.previewClassName ?? '').includes('code-wrap-enabled')
        )
      },
      4000,
      80
    )
    record('PMN-42-code-wrap-persists-after-project-editor-reopen', wrapPersistedAfterReopen, {
      state: getApi()?.getMarkdownCodeWrapState?.() ?? null
    })
  }

  if (canManageOutline && savedMarkdownOutlineScroll > 0) {
    await getApi()?.openFileByPath?.(OUTLINE_SCROLL_FIXTURE_PATH)
    const highlightAfterReopen = await waitForMarkdownFile(
      'pmn-highlight-after-reopen',
      OUTLINE_SCROLL_FIXTURE_PATH,
      OUTLINE_SCROLL_FIXTURE_TEXT
    )
    record('PMN-43-highlight-opened-after-reopen', highlightAfterReopen, {
      activeFilePath: getApi()?.getActiveFilePath?.() ?? null
    })
    if (!highlightAfterReopen || cancelled()) return results

    const outlineAfterReopen = await waitFor(
      'pmn-outline-after-reopen',
      () => {
        const current = getApi()
        const scrollTop = current?.getOutlineScrollTop?.() ?? 0
        return current?.isOutlineVisible?.() === true && Math.abs(scrollTop - savedMarkdownOutlineScroll) <= 40
      },
      5000,
      80
    )
    record('PMN-44-outline-restores-after-project-editor-reopen', outlineAfterReopen, {
      savedScrollTop: Math.round(savedMarkdownOutlineScroll),
      restoredScrollTop: Math.round(getApi()?.getOutlineScrollTop?.() ?? 0)
    })
  }

  api?.setPreviewSearchOpen?.(false)
  api?.setOutlineTarget?.('editor')
  api?.setMarkdownCodeWrapEnabled?.(false)
  api?.setMarkdownPreviewVisible?.(true)
  api?.setMarkdownEditorVisible?.(true)
  api?.setOutlineVisible?.(true)
  await sleep(120)

  const editorRestored = await waitFor(
    'pmn-editor-restored',
    () => getApi()?.isMarkdownEditorVisible?.() === true,
    3000,
    60
  )
  record('PMN-45-markdown-editor-restored', editorRestored, {
    editorVisible: getApi()?.isMarkdownEditorVisible?.()
  })

  return results
}
