/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

import type { AutotestContext, TestResult } from './types'
import { buildChangeDirectoryCommand } from '../utils/terminal-command'
import { parseNavigationSourceFilter, navigationSourcesFor } from './subpage-navigation-source'

function normalizePath(value: string): string {
  const normalized = value.replace(/\\/g, '/').replace(/\/+$/, '')
  return /^[A-Za-z]:\//.test(normalized) || normalized.startsWith('//')
    ? normalized.toLowerCase()
    : normalized
}

function joinPath(base: string, child: string): string {
  const trimmed = base.replace(/[\\/]+$/, '')
  return `${trimmed}/${child}`
}

function getFixtureBase(rootPath: string): string {
  const configured = window.electronAPI.debug.autotestFixtureExtra?.trim()
  if (configured) return configured
  return joinPath(rootPath, 'test/autotest/results/subpage-navigation')
}

type NavigationTestGroup = 'core' | 'html' | 'pdf' | 'epub'

function getNavigationTestGroup(): NavigationTestGroup {
  const suite = window.electronAPI.debug.autotestSuite ?? ''
  const group = suite.match(/(?:^|;)group=(core|html|pdf|epub)(?:;|$)/i)?.[1]?.toLowerCase()
  if (group === 'html' || group === 'pdf' || group === 'epub') return group
  return 'core'
}

// Which entry points (git-diff / git-history) this run exercises. The html group
// is split by source across two runners to fit the 180s regression budget; `all`
// (the default) keeps both for a standalone run. See subpage-navigation-source.ts.
function getNavigationSources(): ReturnType<typeof navigationSourcesFor> {
  return navigationSourcesFor(parseNavigationSourceFilter(window.electronAPI.debug.autotestSuite))
}

function dispatchEscape(): void {
  document.dispatchEvent(new KeyboardEvent('keydown', {
    key: 'Escape',
    code: 'Escape',
    bubbles: true,
    cancelable: true
  }))
}

async function writeAndSyncTerminal(
  terminalId: string,
  command: string,
  sleep: (ms: number) => Promise<void>
): Promise<void> {
  await window.electronAPI.terminal.write(terminalId, command)
  await sleep(450)
  await window.electronAPI.git.notifyTerminalActivity(terminalId)
  await sleep(450)
}

async function waitForTerminalCwd(
  terminalId: string,
  expectedCwd: string,
  sleep: (ms: number) => Promise<void>,
  timeoutMs = 12000
): Promise<string | null> {
  const normalizedExpected = normalizePath(expectedCwd)
  const startedAt = performance.now()
  while (performance.now() - startedAt < timeoutMs) {
    const cwd = await window.electronAPI.git.getTerminalCwd(terminalId)
    if (cwd && normalizePath(cwd) === normalizedExpected) {
      return cwd
    }
    await sleep(180)
  }
  return null
}

function isVisibleElement(element: Element | null): boolean {
  if (!(element instanceof HTMLElement)) return false
  if (element.closest('[aria-hidden="true"]')) return false
  if (element.getClientRects().length === 0) return false
  const style = window.getComputedStyle(element)
  return style.visibility !== 'hidden' && style.display !== 'none'
}

function getSubpageButton(target: 'diff' | 'editor' | 'history'): HTMLButtonElement | null {
  const buttons = Array.from(document.querySelectorAll<HTMLButtonElement>(`[data-subpage-button="${target}"]`))
  return buttons.find((button) => isVisibleElement(button)) ?? null
}

function getVisibleSubpageShells(): HTMLElement[] {
  return Array.from(document.querySelectorAll<HTMLElement>('[data-subpage-panel-shell="true"]'))
    .filter((shell) => isVisibleElement(shell))
}

function getVisibleShellButtons(): HTMLButtonElement[] {
  const shell = getVisibleSubpageShells()[0]
  if (!shell) return []
  return Array.from(shell.querySelectorAll<HTMLButtonElement>('button'))
    .filter((button) => isVisibleElement(button))
}

function getButtonMetrics(button: HTMLButtonElement) {
  const style = window.getComputedStyle(button)
  return {
    text: button.textContent?.trim() || '',
    height: style.height,
    fontSize: style.fontSize,
    fontFamily: style.fontFamily,
    borderRadius: style.borderRadius,
    paddingTop: style.paddingTop,
    paddingBottom: style.paddingBottom
  }
}

function areVisibleShellButtonsUniform(): { ok: boolean; metrics: ReturnType<typeof getButtonMetrics>[] } {
  const buttons = getVisibleShellButtons()
  const metrics = buttons.map(getButtonMetrics)
  const first = metrics[0]
  if (!first) {
    return { ok: false, metrics }
  }
  return {
    ok: metrics.every((metric) =>
      metric.height === first.height
      && metric.fontSize === first.fontSize
      && metric.fontFamily === first.fontFamily
      && metric.borderRadius === first.borderRadius
      && metric.paddingTop === first.paddingTop
      && metric.paddingBottom === first.paddingBottom
    ),
    metrics
  }
}

function clickSubpageButton(target: 'diff' | 'editor' | 'history'): boolean {
  const button = getSubpageButton(target)
  if (!button || button.disabled) return false
  button.click()
  return true
}

// Under EDR-instrumented Windows hosts every git process spawn is taxed
// (observed 1.3-12.9 s each), so the COLD first Git-Diff load can take well
// over the default 8 s budget (measured 8321 ms). Warm loads are ~1.7 s.
// Use a generous cold-load budget for the first diff mount / file list / first
// selection so a slow EDR spawn does not time out 300 ms early and cascade.
const COLD_DIFF_LOAD_BUDGET_MS = 20000
const SOURCE_SCROLL_RESTORE_TIMEOUT_MS = 6000
const CROSS_ROOT_WORKING_MARKER = 'CROSS_ROOT_TARGET_WORKING_TREE'

function getGitDiffApi() {
  return window.__onwardGitDiffDebug
}

function getGitHistoryApi() {
  return window.__onwardGitHistoryDebug
}

function getProjectEditorApi() {
  return window.__onwardProjectEditorDebug
}

type NavigationSource = 'diff' | 'history'
type NavigationFileKind = 'code' | 'html' | 'pdf' | 'epub'

type NavigationViewState =
  | { kind: 'code'; lineNumber: number; column: number }
  | { kind: 'html'; scrollY: number; zoomFactor: number }
  | { kind: 'pdf'; pageNumber: number; zoomValue: string; scrollTop: number }
  | {
      kind: 'epub'
      locationFragment: string
      locationCfi: string
      fontSizePrefix: string
      bodyFontSizePx: number
      scrollTop: number
      seenSessionIds: number[]
    }

type SourceReturnBarState = {
  visible: boolean
  source: NavigationSource | null
  backEnabled: boolean
  jumpEnabled: boolean
  checking: boolean
  activeFilePath: string | null
}

type DiffScrollMetrics = {
  scrollTop: number
  scrollHeight: number
  viewportHeight: number
  maxScrollTop: number
  modelMatchesSelection: boolean
  diffReady: boolean
}

type HtmlViewStateObservation = {
  documentState: Record<string, unknown> | null
  readerState: Record<string, unknown> | null
  rendererZoom: number | null
  browserZoom: number | null
}

type NavigationProjectEditorApi = NonNullable<ReturnType<typeof getProjectEditorApi>> & {
  getSourceReturnBarState?: () => SourceReturnBarState
  triggerSourceReturnBack?: () => Promise<boolean>
}

function getNavigationProjectEditorApi(): NavigationProjectEditorApi | undefined {
  return getProjectEditorApi() as NavigationProjectEditorApi | undefined
}

export async function testSubpageNavigation(ctx: AutotestContext): Promise<TestResult[]> {
  const { log, sleep, waitFor, assert, cancelled, terminalId } = ctx
  const results: TestResult[] = []
  const htmlViewStateObservations = new Map<string, HtmlViewStateObservation>()
  const _assert = (name: string, ok: boolean, detail?: Record<string, unknown>) => {
    assert(name, ok, detail)
    results.push({ name, ok, detail })
  }

  const platform = window.electronAPI.platform
  const navigationGroup = getNavigationTestGroup()
  const fixtureBase = getFixtureBase(ctx.rootPath)
  const fixtureRoot = joinPath(fixtureBase, 'repo')
  const fixtureRootB = joinPath(fixtureBase, 'repo-b')
  const fixtureShellPath = platform === 'win32' ? fixtureRoot.replace(/\//g, '\\') : fixtureRoot

  log('phase0.58:start', {
    suite: 'SubpageNavigation',
    navigationGroup,
    fixtureBase,
    fixtureRoot
  })

  try {
    await writeAndSyncTerminal(
      terminalId,
      buildChangeDirectoryCommand(platform, fixtureShellPath),
      sleep
    )
    const fixtureCwd = await waitForTerminalCwd(terminalId, fixtureRoot, sleep, 20000)
    _assert('SN-00-fixture-root-ready', Boolean(fixtureCwd), {
      expected: normalizePath(fixtureRoot),
      actual: fixtureCwd ? normalizePath(fixtureCwd) : null
    })
    if (!fixtureCwd || cancelled()) return results
    await window.electronAPI.git.notifyTerminalGitUpdate(terminalId)
    await sleep(600)
    _assert('SN-00-working-tree-prepared', true, { fixtureRoot, navigationGroup })

    const openProjectEditor = async (label: string) => {
      window.dispatchEvent(new CustomEvent('project-editor:open', { detail: { terminalId } }))
      return await waitFor(`subpage-navigation-project-editor-open:${label}`, () => {
        const api = getProjectEditorApi()
        return Boolean(api?.isOpen() && normalizePath(api.getRootPath?.() ?? '') === normalizePath(fixtureRoot))
      }, 8000)
    }

    const waitForProjectEditorFile = async (label: string, expectedPath: string | null) => {
      return await waitFor(`subpage-navigation-editor-file:${label}`, () => {
        const api = getProjectEditorApi()
        if (!api?.isOpen()) return false
        return (api.getActiveFilePath?.() ?? null) === expectedPath
      }, 8000)
    }

    const waitForActiveSubpage = async (label: string, target: 'diff' | 'editor' | 'history') => {
      return await waitFor(`subpage-navigation-active-subpage:${label}`, () => {
        return document.querySelector(`.terminal-grid-subpage-host[data-active-subpage="${target}"]`) !== null
      }, 8000)
    }

    // Wait for a subpage switcher button to be present AND enabled before
    // clicking it. Under EDR the target panel (history/diff) can finish its
    // cold mount slightly after the click would fire, leaving the switcher
    // button transiently disabled; a one-shot clickSubpageButton() then returns
    // false and the dependent assertion cascades. Poll the button instead.
    const waitForSubpageButtonAndClick = async (
      label: string,
      target: 'diff' | 'editor' | 'history',
      timeoutMs = COLD_DIFF_LOAD_BUDGET_MS
    ) => {
      return await waitFor(`subpage-navigation-button-click:${label}`, () => {
        const button = getSubpageButton(target)
        if (!button || button.disabled) return false
        button.click()
        return true
      }, timeoutMs)
    }

    const waitForGitDiffOpen = async (label: string) => {
      // Cold first mount under EDR can exceed the default 8 s; use the cold budget.
      return await waitFor(`subpage-navigation-diff-open:${label}`, () => Boolean(getGitDiffApi()?.isOpen()), COLD_DIFF_LOAD_BUDGET_MS)
    }

    const waitForDiffFile = async (label: string, filePath: string) => {
      // The file list is populated by a git spawn; on a cold EDR-taxed load this
      // can take >8 s, so poll up to the cold-load budget before giving up.
      return await waitFor(`subpage-navigation-diff-file:${label}`, () => {
        const files = getGitDiffApi()?.getFileList?.() ?? []
        return files.some((file) => file.filename === filePath || file.originalFilename === filePath)
      }, COLD_DIFF_LOAD_BUDGET_MS)
    }

    const waitForGitHistoryOpen = async (label: string) => {
      return await waitFor(`subpage-navigation-history-open:${label}`, () => Boolean(getGitHistoryApi()?.isOpen()), 8000)
    }

    const waitForHistoryFiles = async (label: string) => {
      return await waitFor(`subpage-navigation-history-files:${label}`, () => {
        const api = getGitHistoryApi()
        return Boolean(api && !api.isLoading() && api.getFiles().length > 0)
      }, 8000)
    }

    const selectHistoryCommitByIndex = async (label: string, index: number) => {
      return await waitFor(`subpage-navigation-history-commit:${label}`, () => {
        const api = getGitHistoryApi()
        if (!api || api.isLoading()) return false
        return api.selectCommitByIndex(index) === true
      }, 8000)
    }

    const selectHistoryFileByPath = async (label: string, filePath: string) => {
      return await waitFor(`subpage-navigation-history-select:${label}`, () => {
        const api = getGitHistoryApi()
        if (!api || api.isLoading()) return false
        const files = api.getFiles()
        const targetIndex = files.findIndex((file) => file.filename === filePath)
        if (targetIndex < 0) return false
        if (api.getSelectedFile?.()?.filename === filePath) return true
        const selected = api.selectFileByIndex(targetIndex) === true
        return selected && api.getSelectedFile?.()?.filename === filePath
      }, 8000)
    }

    const waitForEditorSurface = async (
      label: string,
      fileKind: NavigationFileKind,
      filePath: string
    ): Promise<boolean> => {
      if (fileKind === 'html') {
        const startedAt = performance.now()
        while (performance.now() - startedAt < 15000) {
          const api = getNavigationProjectEditorApi()
          const reader = api?.getHtmlReaderState?.()
          const documentState = await api?.getHtmlPreviewDocumentState?.()
          if (
            api?.getActiveFilePath?.() === filePath
            && api.isHtmlReaderVisible?.()
            && reader?.ready
            && reader.visible
            && !reader.error
            && reader.url?.includes('#working-route')
            && documentState?.success
            && documentState.bodyDatasetMarker === 'navigation-working'
            && documentState.relativeScriptMarker === 'working-tree'
            && documentState.navigationAccent === '#1570ef'
          ) {
            return true
          }
          await sleep(150)
        }
        return false
      }

      return await waitFor(`subpage-navigation-editor-surface:${label}`, () => {
        const api = getNavigationProjectEditorApi()
        if (!api || api.getActiveFilePath?.() !== filePath) return false
        if (fileKind === 'code') {
          return api.getEditorContent().includes('NAVIGATION_WORKTREE_CODE')
        }
        if (fileKind === 'pdf') {
          const state = api.getPdfReaderState?.()
          const iframe = document.querySelector<HTMLIFrameElement>('.project-editor-pdf-reader-iframe')
          const viewerText = iframe?.contentDocument?.querySelector('.textLayer')?.textContent ?? ''
          return Boolean(
            api.isPdfReaderVisible?.()
            && state?.visible
            && state.stateReady
            && state.src?.includes('viewer.html')
            && iframe
            && iframe.offsetWidth > 100
            && iframe.offsetHeight > 100
            && iframe.contentDocument?.getElementById('zoomSelect')
            && viewerText.includes('Onward Autotest PDF v2')
          )
        }
        const state = api.getEpubReaderState?.()
        return Boolean(
          api.isEpubReaderVisible?.()
          && state?.visible
          && state.hasContent
          && state.stateReady
          && state.tocCount >= 2
          && !state.errorMessage
        )
      }, 15000)
    }

    const readEpubContentText = (): string => {
      const frames = Array.from(
        document.querySelectorAll<HTMLIFrameElement>('.project-editor-epub-content iframe')
      )
      return frames.map((frame) => {
        try {
          return frame.contentDocument?.body?.innerText ?? ''
        } catch {
          return ''
        }
      }).join('\n')
    }

    const probePdfReady = async (): Promise<boolean> => {
      const iframe = document.querySelector<HTMLIFrameElement>('.project-editor-pdf-reader-iframe')
      const target = iframe?.contentWindow
      if (!target) return false
      return await new Promise<boolean>((resolve) => {
        let settled = false
        const finish = (value: boolean) => {
          if (settled) return
          settled = true
          window.clearTimeout(timer)
          window.removeEventListener('message', handleMessage)
          resolve(value)
        }
        const handleMessage = (event: MessageEvent) => {
          if (event.source === target && event.data?.type === 'onward:pdf:ready') {
            finish(true)
          }
        }
        const timer = window.setTimeout(() => finish(false), 3000)
        window.addEventListener('message', handleMessage)
        target.postMessage({ type: 'onward:pdf:requestReady' }, '*')
      })
    }

    const isDocumentHtmlElement = (
      value: unknown,
      ownerDocument: Document | null | undefined
    ): value is HTMLElement => {
      const elementConstructor = ownerDocument?.defaultView?.HTMLElement
      return Boolean(elementConstructor && value instanceof elementConstructor)
    }

    const prepareNavigationViewState = async (
      label: string,
      fileKind: NavigationFileKind
    ): Promise<NavigationViewState | null> => {
      const api = getNavigationProjectEditorApi()
      if (!api) return null

      if (fileKind === 'code') {
        const lineNumber = 6
        const column = 5
        const positioned = await waitFor(`${label}:code-position`, () => {
          const current = getNavigationProjectEditorApi()
          if (!current?.setCursorPosition?.(lineNumber, column)) return false
          const position = current.getCursorPosition?.()
          return position?.lineNumber === lineNumber && position.column === column
        }, 3000)
        return positioned ? { kind: 'code', lineNumber, column } : null
      }

      if (fileKind === 'html') {
        const scrollY = 720
        const zoomFactor = 1.25
        const zoomSet = await api.setHtmlPreviewZoomFactor?.(zoomFactor)
        const scrollSet = await api.setHtmlPreviewScrollForTest?.(scrollY)
        const positioned = Boolean(zoomSet && scrollSet) && await waitFor(`${label}:html-position`, () => {
          const current = getNavigationProjectEditorApi()
          const currentZoom = current?.getHtmlPreviewZoomFactor?.() ?? 0
          return Math.abs(currentZoom - zoomFactor) < 0.01
        }, 3000)
        if (!positioned) return null
        const documentState = await api.getHtmlPreviewDocumentState?.()
        return documentState?.success && Math.abs((documentState.scrollY ?? 0) - scrollY) <= 80
          ? { kind: 'html', scrollY, zoomFactor }
          : null
      }

      if (fileKind === 'pdf') {
        const pageNumber = 2
        const zoomValue = '4'
        const frameDocument = document.querySelector<HTMLIFrameElement>('.project-editor-pdf-reader-iframe')
          ?.contentDocument
        const select = frameDocument?.getElementById('zoomSelect') as HTMLSelectElement | null
        const pageInput = frameDocument?.getElementById('pageNumberInput') as HTMLInputElement | null
        if (!select || !pageInput) return null
        select.value = zoomValue
        select.dispatchEvent(new Event('change', { bubbles: true }))
        const pageAndScrollReady = await waitFor(`${label}:pdf-page-scrollable`, () => {
          const viewerContainer = select.ownerDocument.getElementById('viewerContainer')
          if (!isDocumentHtmlElement(viewerContainer, select.ownerDocument)) return false
          const secondPage = select.ownerDocument.querySelector<HTMLElement>(
            `.page[data-page-number="${pageNumber}"]`
          )
          if (!secondPage) return false
          const maxScrollTop = viewerContainer.scrollHeight - viewerContainer.clientHeight
          if (maxScrollTop <= 0) return false
          const targetScrollTop = Math.min(maxScrollTop, Math.max(1, secondPage.offsetTop + 80))
          viewerContainer.scrollTop = targetScrollTop
          viewerContainer.dispatchEvent(new Event('scroll', { bubbles: true }))
          return viewerContainer.scrollTop > 0 && pageInput.value === String(pageNumber)
        }, 5000, 100)
        if (!pageAndScrollReady) return null
        const viewerContainer = select.ownerDocument.getElementById('viewerContainer')
        if (!isDocumentHtmlElement(viewerContainer, select.ownerDocument)) return null
        const scrollTop = viewerContainer.scrollTop
        return select.value === zoomValue && pageInput.value === String(pageNumber) && scrollTop > 0
          ? { kind: 'pdf', pageNumber, zoomValue, scrollTop }
          : null
      }

      const outlineItems = Array.from(
        document.querySelectorAll<HTMLElement>('.outline-panel .outline-panel-item')
      )
      if (outlineItems.length < 2) return null
      outlineItems[0].click()
      const workingTreeContent = await waitFor(`${label}:epub-working-tree-content`, () => {
        const state = getNavigationProjectEditorApi()?.getEpubReaderState?.()
        return Boolean(
          state?.stateReady
          && state.currentLocationHref?.toLowerCase().includes('chapter1')
          && readEpubContentText().includes('chapter 1 has been edited')
        )
      }, 8000, 150)
      if (!workingTreeContent) return null
      outlineItems[1].click()
      const locationFragment = 'chapter2'
      const chapterReady = await waitFor(`${label}:epub-chapter`, () => {
        const state = getNavigationProjectEditorApi()?.getEpubReaderState?.()
        return Boolean(
          state?.stateReady
          && state.currentLocationHref?.toLowerCase().includes(locationFragment)
        )
      }, 5000, 150)
      if (!chapterReady) return null

      const getFontPct = () => Number.parseInt(
        getNavigationProjectEditorApi()?.getEpubReaderState?.()?.fontSizeLabel ?? '',
        10
      )
      for (let attempt = 0; attempt < 12 && getFontPct() !== 110; attempt += 1) {
        const selector = getFontPct() < 110
          ? '.project-editor-epub-fontsize .project-editor-epub-btn:last-child'
          : '.project-editor-epub-fontsize .project-editor-epub-btn:first-child'
        document.querySelector<HTMLButtonElement>(selector)?.click()
        await sleep(100)
      }
      const fontSizePrefix = '110'
      if (getFontPct() !== 110) return null
      const fontReady = await waitFor(`${label}:epub-font-ready`, () => {
        const state = getNavigationProjectEditorApi()?.getEpubReaderState?.()
        return Boolean(
          state?.stateReady
          && state.appliedFontPct === 110
          && typeof state.bodyFontSizePx === 'number'
          && state.bodyFontSizePx > 0
          && state.currentLocationHref?.toLowerCase().includes(locationFragment)
          && state.currentLocationCfi
        )
      }, 8000, 150)
      if (!fontReady) return null
      const content = document.querySelector<HTMLElement>('.project-editor-epub-content .epub-container')
      if (!content) return null
      let scrollTop = 0
      const scrollReady = await waitFor(`${label}:epub-scroll-position`, () => {
        const maxScrollTop = content.scrollHeight - content.clientHeight
        if (maxScrollTop < 300) return false
        const targetScrollTop = Math.min(maxScrollTop, Math.max(180, maxScrollTop * 0.55))
        content.scrollTop = targetScrollTop
        content.dispatchEvent(new Event('scroll', { bubbles: true }))
        scrollTop = content.scrollTop
        return scrollTop > 100 && Math.abs(scrollTop - targetScrollTop) <= 2
      }, 5000, 100)
      if (!scrollReady) return null
      await sleep(400)
      const state = getNavigationProjectEditorApi()?.getEpubReaderState?.()
      return state?.currentLocationCfi
        && typeof state.sessionId === 'number'
        && typeof state.bodyFontSizePx === 'number'
        ? {
            kind: 'epub',
            locationFragment,
            locationCfi: state.currentLocationCfi,
            fontSizePrefix,
            bodyFontSizePx: state.bodyFontSizePx,
            scrollTop,
            seenSessionIds: [state.sessionId]
          }
        : null
    }

    const verifyNavigationViewState = async (
      label: string,
      expected: NavigationViewState
    ): Promise<boolean> => {
      if (expected.kind === 'code') {
        return await waitFor(`${label}:code-state-restored`, () => {
          const position = getNavigationProjectEditorApi()?.getCursorPosition?.()
          return position?.lineNumber === expected.lineNumber && position.column === expected.column
        }, 5000)
      }
      if (expected.kind === 'html') {
        const startedAt = performance.now()
        while (performance.now() - startedAt < 8000) {
          const api = getNavigationProjectEditorApi()
          const documentState = await api?.getHtmlPreviewDocumentState?.()
          const readerState = api?.getHtmlReaderState?.()
          const rendererZoom = api?.getHtmlPreviewZoomFactor?.() ?? null
          const browserZoom = await api?.getHtmlPreviewBrowserZoomFactor?.() ?? null
          htmlViewStateObservations.set(label, {
            documentState: documentState ? { ...documentState } : null,
            readerState: readerState ? { ...readerState } : null,
            rendererZoom,
            browserZoom
          })
          if (
            documentState?.success
            && documentState.bodyDatasetMarker === 'navigation-working'
            && documentState.relativeScriptMarker === 'working-tree'
            && documentState.navigationAccent === '#1570ef'
            && readerState?.url?.includes('#working-route')
            && Math.abs((documentState.scrollY ?? 0) - expected.scrollY) <= 80
            && readerState?.scrollRestoreStatus === 'restored'
            && readerState.restoredScrollY !== null
            && Math.abs(readerState.restoredScrollY - expected.scrollY) <= 80
            && rendererZoom !== null
            && Math.abs(rendererZoom - expected.zoomFactor) < 0.01
            && browserZoom !== null
            && Math.abs(browserZoom - expected.zoomFactor) < 0.01
          ) return true
          await sleep(150)
        }
        return false
      }
      if (expected.kind === 'pdf') {
        return await waitFor(`${label}:pdf-state-restored`, () => {
          const readerState = getNavigationProjectEditorApi()?.getPdfReaderState?.()
          const iframe = document.querySelector<HTMLIFrameElement>('.project-editor-pdf-reader-iframe')
          const select = iframe?.contentDocument?.getElementById('zoomSelect') as HTMLSelectElement | null
          const pageInput = iframe?.contentDocument?.getElementById('pageNumberInput') as HTMLInputElement | null
          const viewerContainer = iframe?.contentDocument?.getElementById('viewerContainer')
          const viewerText = iframe?.contentDocument?.querySelector('.textLayer')?.textContent ?? ''
          return Boolean(
            select?.value === expected.zoomValue
            && pageInput?.value === String(expected.pageNumber)
            && readerState?.currentState?.page === expected.pageNumber
            && isDocumentHtmlElement(viewerContainer, iframe?.contentDocument)
            && Math.abs(viewerContainer.scrollTop - expected.scrollTop) <= 80
            && viewerText.includes('Onward Autotest PDF v2')
            && iframe
            && iframe.offsetWidth > 100
            && iframe.offsetHeight > 100
          )
        }, 15000, 150)
      }
      const stateRestored = await waitFor(`${label}:epub-state-restored`, () => {
        const state = getNavigationProjectEditorApi()?.getEpubReaderState?.()
        return Boolean(
          state?.tocCount && state.tocCount >= 2
          && state.stateReady
          && typeof state.sessionId === 'number'
          && !expected.seenSessionIds.includes(state.sessionId)
          && state.currentLocationHref?.toLowerCase().includes(expected.locationFragment)
          && state.currentLocationCfi === expected.locationCfi
          && state.fontSizeLabel?.startsWith(expected.fontSizePrefix)
          && state.appliedFontPct === 110
            && typeof state.bodyFontSizePx === 'number'
            && Math.abs(state.bodyFontSizePx - expected.bodyFontSizePx) <= 0.5
            && typeof state.scrollTop === 'number'
            && typeof state.maxScrollTop === 'number'
            && Math.abs(state.scrollTop - Math.min(expected.scrollTop, state.maxScrollTop)) <= 80
            && state.hasContent
          && !state.errorMessage
        )
      }, 15000, 150)
      if (!stateRestored) {
        log(`${label}:epub-state-restore-failed`, {
          expected,
          actual: getNavigationProjectEditorApi()?.getEpubReaderState?.() ?? null,
          content: readEpubContentText().slice(0, 240)
        })
        return false
      }
      const restoredSessionId = getNavigationProjectEditorApi()?.getEpubReaderState?.()?.sessionId
      if (typeof restoredSessionId !== 'number' || expected.seenSessionIds.includes(restoredSessionId)) {
        return false
      }
      expected.seenSessionIds.push(restoredSessionId)

      // Give any stale epub.js callback time to arrive, then prove it did not
      // overwrite the latest chapter, CFI, font, scroll, or session state.
      await sleep(300)
      const stable = getNavigationProjectEditorApi()?.getEpubReaderState?.()
      return stable?.stateReady === true
        && stable.sessionId === restoredSessionId
        && stable.currentLocationHref?.toLowerCase().includes(expected.locationFragment) === true
        && stable.currentLocationCfi === expected.locationCfi
        && stable.appliedFontPct === 110
        && typeof stable.bodyFontSizePx === 'number'
        && Math.abs(stable.bodyFontSizePx - expected.bodyFontSizePx) <= 0.5
        && typeof stable.scrollTop === 'number'
        && typeof stable.maxScrollTop === 'number'
        && Math.abs(stable.scrollTop - Math.min(expected.scrollTop, stable.maxScrollTop)) <= 80
    }

    const ensureEditorActive = async (label: string): Promise<boolean> => {
      if (
        document.querySelector('.terminal-grid-subpage-host[data-active-subpage="editor"]')
        && getNavigationProjectEditorApi()?.isOpen()
      ) {
        return true
      }
      const clicked = await waitForSubpageButtonAndClick(`${label}:editor`, 'editor')
      return Boolean(clicked && await waitForActiveSubpage(`${label}:editor-active`, 'editor'))
    }

    const selectNavigationSourceFile = async (
      label: string,
      source: NavigationSource,
      filePath: string
    ): Promise<boolean> => {
      const alreadyActive = Boolean(
        document.querySelector(`.terminal-grid-subpage-host[data-active-subpage="${source}"]`)
      ) && (source === 'diff' ? Boolean(getGitDiffApi()?.isOpen()) : Boolean(getGitHistoryApi()?.isOpen()))
      const activated = alreadyActive || await waitForSubpageButtonAndClick(`${label}:${source}`, source)
      if (!activated) return false

      if (source === 'diff') {
        const opened = await waitForGitDiffOpen(`${label}:diff`)
        const ready = opened && await waitForDiffFile(`${label}:diff-file`, filePath)
        if (!ready) return false
        return await waitFor(`${label}:diff-select`, () => {
          const api = getGitDiffApi()
          if (!api) return false
          if (api.getSelectedFile?.()?.filename === filePath) return true
          return api.selectFileByPath(filePath) === true
            && api.getSelectedFile?.()?.filename === filePath
        }, COLD_DIFF_LOAD_BUDGET_MS)
      }

      const opened = await waitForGitHistoryOpen(`${label}:history`)
      if (!opened) return false
      const historyApi = getGitHistoryApi()
      if (!historyApi) return false
      if (normalizePath(historyApi.getActiveCwd?.() ?? '') !== normalizePath(fixtureRoot)) {
        historyApi.switchRepo?.(fixtureRoot)
      }
      const historyRootReady = await waitFor(`${label}:history-root`, () => (
        normalizePath(getGitHistoryApi()?.getActiveCwd?.() ?? '') === normalizePath(fixtureRoot)
      ), COLD_DIFF_LOAD_BUDGET_MS)
      if (!historyRootReady) return false
      const baseCommitSelected = await waitFor(`${label}:history-base-commit`, () => {
        const api = getGitHistoryApi()
        if (!api || api.isLoading()) return false
        const commits = api.getCommits?.() ?? []
        const index = commits.findIndex((commit) => commit.summary === 'base navigation fixture')
        if (index < 0) return false
        if (api.getSelectedShas().includes(commits[index].sha)) return true
        return api.selectCommitByIndex(index) === true
      }, COLD_DIFF_LOAD_BUDGET_MS)
      if (!baseCommitSelected) return false
      const filesReady = await waitFor(`${label}:history-file`, () => {
        const api = getGitHistoryApi()
        return Boolean(api && !api.isLoading() && api.getFiles().some((file) => file.filename === filePath))
      }, COLD_DIFF_LOAD_BUDGET_MS)
      return Boolean(filesReady && await selectHistoryFileByPath(`${label}:history-select`, filePath))
    }

    const clickJumpToEditor = async (
      label: string,
      source: NavigationSource,
      expectedFilePath: string
    ): Promise<boolean> => {
      const selector = source === 'diff'
        ? '[data-testid="git-diff-jump-editor"], .git-diff-jump-editor'
        : '[data-testid="git-history-jump-editor"], .git-history-jump-editor'
      return await waitFor(`${label}:jump-button`, () => {
        const button = Array.from(document.querySelectorAll<HTMLButtonElement>(selector))
          .find((candidate) => isVisibleElement(candidate))
        if (!button || button.disabled) return false
        if (button.dataset.jumpFile !== expectedFilePath) return false
        if (button.dataset.jumpStatus !== 'available') return false
        button.click()
        return true
      }, 5000)
    }

    const readSourceReturnState = (source: NavigationSource): SourceReturnBarState | null => {
      const api = getNavigationProjectEditorApi()
      const state = api?.getSourceReturnBarState?.()
      if (state) return state
      if (source !== 'diff') return null
      const legacy = api?.getDiffReturnBarState?.()
      return legacy
        ? { ...legacy, source: 'diff' }
        : null
    }

    const triggerSourceReturnBack = async (): Promise<boolean> => {
      const button = document.querySelector<HTMLButtonElement>(
        '[data-testid="project-editor-source-return-back"]'
      )
      if (!button || button.disabled || button.offsetParent === null) return false
      button.click()
      return true
    }

    const triggerSourceReturnJump = async (): Promise<boolean> => {
      const button = document.querySelector<HTMLButtonElement>(
        '[data-testid="project-editor-source-return-jump"]'
      )
      if (!button || button.disabled || button.offsetParent === null) return false
      button.click()
      return true
    }

    const getVisibleHistoryJumpButton = (): HTMLButtonElement | null => {
      return Array.from(document.querySelectorAll<HTMLButtonElement>(
        '[data-testid="git-history-jump-editor"]'
      )).find((candidate) => isVisibleElement(candidate)) ?? null
    }

    const getVisibleDiffJumpButton = (): HTMLButtonElement | null => {
      return Array.from(document.querySelectorAll<HTMLButtonElement>(
        '[data-testid="git-diff-jump-editor"]'
      )).find((candidate) => isVisibleElement(candidate)) ?? null
    }

    const getVisibleHistoryDiffScroll = (): HTMLElement | null => {
      return Array.from(document.querySelectorAll<HTMLElement>('.git-history-diff-scroll'))
        .find((candidate) => isVisibleElement(candidate)) ?? null
    }

    const runSourceScrollRoundTrip = async (source: NavigationSource, trial: number) => {
      const label = `snj:source-scroll:${source}:${trial}`
      const filePath = 'scroll-state.ts'
      const editorActive = await ensureEditorActive(label)
      if (!editorActive) return { ok: false, stage: 'open-editor' }
      await getNavigationProjectEditorApi()?.openFileByPathAsUser?.('editor-only.md', { trackRecent: false })
      const editorReset = await waitForProjectEditorFile(`${label}:reset`, 'editor-only.md')
      const sourceSelected = editorReset && await selectNavigationSourceFile(label, source, filePath)

      let sourceScrollTop = 0
      let sourceMaxScrollTop: number | null = null
      let sourceDiffScrollMetrics: DiffScrollMetrics | null = null
      let stableDiffGeometryKey: string | null = null
      let stableDiffGeometrySamples = 0
      let sourceDiffScrollPositioned = false
      let stableSourceScrollSamples = 0
      const sourceScrolled = Boolean(sourceSelected) && await waitFor(`${label}:scroll-source`, () => {
        if (source === 'diff') {
          const api = getGitDiffApi()
          if (!api?.isSelectedReady?.()) return false
          const metrics = api.getScrollMetrics?.()
          if (
            !metrics
            || !metrics.modelMatchesSelection
            || !metrics.diffReady
            || metrics.maxScrollTop <= 100
          ) {
            stableDiffGeometryKey = null
            stableDiffGeometrySamples = 0
            return false
          }
          const geometryKey = `${metrics.scrollHeight}:${metrics.viewportHeight}`
          if (geometryKey === stableDiffGeometryKey) {
            stableDiffGeometrySamples += 1
          } else {
            stableDiffGeometryKey = geometryKey
            stableDiffGeometrySamples = 1
            sourceDiffScrollPositioned = false
            stableSourceScrollSamples = 0
          }
          if (stableDiffGeometrySamples < 3) return false
          if (!sourceDiffScrollPositioned) {
            if (!api.scrollToFraction?.(0.65)) return false
            sourceDiffScrollPositioned = true
            return false
          }
          const positionedMetrics = api.getScrollMetrics?.()
          if (!positionedMetrics) return false
          sourceDiffScrollMetrics = { ...positionedMetrics }
          sourceScrollTop = positionedMetrics.scrollTop
          sourceMaxScrollTop = positionedMetrics.maxScrollTop
          const expectedSourceScrollTop = positionedMetrics.maxScrollTop * 0.65
          const sourcePositionMatches = sourceScrollTop >= 0
            && sourceScrollTop <= positionedMetrics.maxScrollTop
            && Math.abs(sourceScrollTop - expectedSourceScrollTop) <= 4
          stableSourceScrollSamples = sourcePositionMatches ? stableSourceScrollSamples + 1 : 0
          return stableSourceScrollSamples >= 2
        }
        const container = getVisibleHistoryDiffScroll()
        if (!container) return false
        const maxScrollTop = container.scrollHeight - container.clientHeight
        if (maxScrollTop <= 100) return false
        container.scrollTop = Math.min(maxScrollTop, Math.max(120, maxScrollTop * 0.65))
        container.dispatchEvent(new Event('scroll', { bubbles: true }))
        sourceScrollTop = container.scrollTop
        sourceMaxScrollTop = maxScrollTop
        const captured = getGitHistoryApi()?.getScrollState?.().diff ?? 0
        return sourceScrollTop > 100 && Math.abs(captured - sourceScrollTop) <= 2
      }, COLD_DIFF_LOAD_BUDGET_MS)

      const jumpClicked = sourceScrolled && await clickJumpToEditor(label, source, filePath)
      const editorTargetOpened = Boolean(jumpClicked)
        && await waitForActiveSubpage(`${label}:editor-after-jump`, 'editor')
        && await waitForProjectEditorFile(`${label}:target`, filePath)
        && await waitForEditorSurface(`${label}:surface`, 'code', filePath)
      const returnStateReady = Boolean(editorTargetOpened) && await waitFor(`${label}:return-state`, () => {
        const state = readSourceReturnState(source)
        return Boolean(
          state?.visible
          && state.source === source
          && state.backEnabled
          && state.activeFilePath === filePath
        )
      }, 5000)
      const backTriggered = returnStateReady && await triggerSourceReturnBack()
      const sourceRestored = Boolean(backTriggered)
        && await waitForActiveSubpage(`${label}:source-restored`, source)
      const selectionRestored = Boolean(sourceRestored) && await waitFor(`${label}:selection-restored`, () => (
        source === 'diff'
          ? getGitDiffApi()?.getSelectedFile?.()?.filename === filePath
          : getGitHistoryApi()?.getSelectedFile?.()?.filename === filePath
      ), COLD_DIFF_LOAD_BUDGET_MS)
      let restoredScrollTop = 0
      let restoredMaxScrollTop: number | null = null
      let expectedRestoredScrollTop = sourceScrollTop
      let restoredDiffScrollMetrics: DiffScrollMetrics | null = null
      let stableRestoredGeometryKey: string | null = null
      let stableRestoredGeometrySamples = 0
      let stableRestoredScrollSamples = 0
      const scrollRestored = Boolean(selectionRestored) && await waitFor(`${label}:scroll-restored`, () => {
        if (source === 'diff') {
          const metrics = getGitDiffApi()?.getScrollMetrics?.()
          if (
            !metrics
            || !metrics.modelMatchesSelection
            || !metrics.diffReady
            || metrics.maxScrollTop <= 100
          ) return false
          const geometryKey = `${metrics.scrollHeight}:${metrics.viewportHeight}`
          if (geometryKey === stableRestoredGeometryKey) {
            stableRestoredGeometrySamples += 1
          } else {
            stableRestoredGeometryKey = geometryKey
            stableRestoredGeometrySamples = 1
            stableRestoredScrollSamples = 0
          }
          if (stableRestoredGeometrySamples < 3) return false
          restoredDiffScrollMetrics = { ...metrics }
          restoredScrollTop = metrics.scrollTop
          restoredMaxScrollTop = metrics.maxScrollTop
          expectedRestoredScrollTop = Math.min(sourceScrollTop, metrics.maxScrollTop)
          const restoredPositionMatches = restoredScrollTop >= 0
            && restoredScrollTop <= metrics.maxScrollTop
            && Math.abs(restoredScrollTop - expectedRestoredScrollTop) <= 4
          stableRestoredScrollSamples = restoredPositionMatches ? stableRestoredScrollSamples + 1 : 0
          return stableRestoredScrollSamples >= 2
        }
        const container = getVisibleHistoryDiffScroll()
        if (!container) return false
        restoredScrollTop = container.scrollTop
        restoredMaxScrollTop = Math.max(0, container.scrollHeight - container.clientHeight)
        return sourceScrollTop > 100 && Math.abs(restoredScrollTop - sourceScrollTop) <= 4
      }, SOURCE_SCROLL_RESTORE_TIMEOUT_MS)

      return {
        ok: Boolean(
          editorReset
          && sourceSelected
          && sourceScrolled
          && jumpClicked
          && editorTargetOpened
          && returnStateReady
          && backTriggered
          && sourceRestored
          && selectionRestored
          && scrollRestored
        ),
        stage: 'complete',
        editorReset,
        sourceSelected,
        sourceScrolled,
        sourceScrollTop,
        sourceMaxScrollTop,
        sourceDiffScrollMetrics,
        stableDiffGeometrySamples,
        stableSourceScrollSamples,
        jumpClicked,
        editorTargetOpened,
        returnStateReady,
        backTriggered,
        sourceRestored,
        selectionRestored,
        restoredScrollTop,
        restoredMaxScrollTop,
        expectedRestoredScrollTop,
        restoredDiffScrollMetrics,
        stableRestoredGeometrySamples,
        stableRestoredScrollSamples,
        scrollRestored
      }
    }

    const runColdRichJumpRoundTrip = async (
      source: NavigationSource,
      fileKind: Exclude<NavigationFileKind, 'code'>,
      filePath: string,
      trial: number
    ) => {
      const label = `snj:cold:${fileKind}:${source}:${trial}`
      const editorActive = await ensureEditorActive(label)
      if (!editorActive) return { ok: false, stage: 'open-editor' }

      await getNavigationProjectEditorApi()?.openFileByPathAsUser?.('editor-only.md', { trackRecent: false })
      const editorReset = await waitForProjectEditorFile(`${label}:reset`, 'editor-only.md')
      let htmlPreviewClosed = true
      if (editorReset && fileKind === 'html') {
        getNavigationProjectEditorApi()?.setMarkdownPreviewOpen?.(false)
        htmlPreviewClosed = await waitFor(`${label}:html-preview-closed`, () => (
          getNavigationProjectEditorApi()?.isMarkdownPreviewVisible?.() === false
        ), 3000)
      }
      const sourceSelected = editorReset && htmlPreviewClosed
        && await selectNavigationSourceFile(label, source, filePath)
      const sourceFilenameBefore = source === 'diff'
        ? getGitDiffApi()?.getSelectedFile?.()?.filename ?? null
        : getGitHistoryApi()?.getSelectedFile?.()?.filename ?? null
      const sourceChangeTypeBefore = source === 'diff'
        ? getGitDiffApi()?.getSelectedFile?.()?.changeType ?? null
        : null
      const historyShasBefore = source === 'history' ? getGitHistoryApi()?.getSelectedShas?.() ?? [] : []

      const jumpClicked = sourceSelected && await clickJumpToEditor(label, source, filePath)
      const editorTargetOpened = Boolean(jumpClicked)
        && await waitForActiveSubpage(`${label}:editor-after-jump`, 'editor')
        && await waitForProjectEditorFile(`${label}:target`, filePath)
        && await waitForEditorSurface(`${label}:surface`, fileKind, filePath)
      const workingTreeContent = Boolean(editorTargetOpened) && (
        fileKind !== 'epub'
        || await waitFor(`${label}:epub-working-tree-content`, () => (
          readEpubContentText().includes('chapter 1 has been edited')
        ), 8000, 150)
      )
      const returnStateReady = Boolean(workingTreeContent) && await waitFor(`${label}:return-state`, () => {
        const state = readSourceReturnState(source)
        return Boolean(
          state?.visible
          && state.source === source
          && state.backEnabled
          && state.activeFilePath === filePath
          && state.jumpEnabled === (source === 'diff')
        )
      }, 5000)
      const backTriggered = returnStateReady && await triggerSourceReturnBack()
      const sourceRestored = Boolean(backTriggered)
        && await waitForActiveSubpage(`${label}:source-restored`, source)
      const selectionRestored = Boolean(sourceRestored) && await waitFor(`${label}:selection-restored`, () => {
        if (source === 'diff') {
          const selected = getGitDiffApi()?.getSelectedFile?.()
          return selected?.filename === sourceFilenameBefore
            && selected?.changeType === sourceChangeTypeBefore
        }
        const selectedFile = getGitHistoryApi()?.getSelectedFile?.()?.filename ?? null
        const selectedShas = getGitHistoryApi()?.getSelectedShas?.() ?? []
        return selectedFile === sourceFilenameBefore
          && selectedShas.length === historyShasBefore.length
          && selectedShas.every((sha, index) => sha === historyShasBefore[index])
      }, COLD_DIFF_LOAD_BUDGET_MS)

      return {
        ok: Boolean(
          editorReset
          && htmlPreviewClosed
          && sourceSelected
          && jumpClicked
          && editorTargetOpened
          && workingTreeContent
          && returnStateReady
          && backTriggered
          && sourceRestored
          && selectionRestored
        ),
        stage: 'complete',
        editorReset,
        htmlPreviewClosed,
        sourceSelected,
        jumpClicked,
        editorTargetOpened,
        workingTreeContent,
        returnStateReady,
        backTriggered,
        sourceRestored,
        selectionRestored
      }
    }

    const runWarmJumpRoundTrip = async (
      source: NavigationSource,
      fileKind: NavigationFileKind,
      filePath: string,
      trial: number
    ) => {
      const label = `snj:${fileKind}:${source}:${trial}`
      const editorActive = await ensureEditorActive(label)
      if (!editorActive) return { ok: false, stage: 'open-editor' }

      await getNavigationProjectEditorApi()?.openFileByPathAsUser?.('editor-only.md', { trackRecent: false })
      const editorReset = await waitForProjectEditorFile(`${label}:reset`, 'editor-only.md')
      await getNavigationProjectEditorApi()?.openFileByPathAsUser?.(filePath, { trackRecent: false })
      const warmed = editorReset && await waitForEditorSurface(`${label}:warm`, fileKind, filePath)
      if (!warmed) return { ok: false, stage: 'warm-reader', editorReset }
      const pdfReadyReprobe = fileKind !== 'pdf' || await probePdfReady()
      if (!pdfReadyReprobe) return { ok: false, stage: 'pdf-ready-reprobe', warmed }
      const viewState = await prepareNavigationViewState(label, fileKind)
      if (!viewState) return { ok: false, stage: 'prepare-view-state', warmed }

      const sourceSelected = await selectNavigationSourceFile(label, source, filePath)
      if (!sourceSelected) return { ok: false, stage: 'select-source', warmed }
      const sourceFilenameBefore = source === 'diff'
        ? getGitDiffApi()?.getSelectedFile?.()?.filename ?? null
        : getGitHistoryApi()?.getSelectedFile?.()?.filename ?? null
      const sourceChangeTypeBefore = source === 'diff'
        ? getGitDiffApi()?.getSelectedFile?.()?.changeType ?? null
        : null
      const historyShasBefore = source === 'history' ? getGitHistoryApi()?.getSelectedShas?.() ?? [] : []

      const jumpClicked = await clickJumpToEditor(label, source, filePath)
      const editorTargetOpened = jumpClicked
        && await waitForActiveSubpage(`${label}:editor-after-jump`, 'editor')
        && await waitForProjectEditorFile(`${label}:target`, filePath)
      const surfaceRestored = Boolean(editorTargetOpened)
        && await waitForEditorSurface(`${label}:restored`, fileKind, filePath)
      const viewStateRestored = Boolean(surfaceRestored)
        && await verifyNavigationViewState(label, viewState)
      const viewStateObservation = viewState.kind === 'html'
        ? htmlViewStateObservations.get(label) ?? null
        : null

      const returnStateReady = Boolean(editorTargetOpened) && await waitFor(`${label}:return-state`, () => {
        const state = readSourceReturnState(source)
        return Boolean(
          state?.visible
          && state.source === source
          && state.backEnabled
          && state.activeFilePath === filePath
          && state.jumpEnabled === (source === 'diff')
        )
      }, 5000)
      let locateTriggered = source !== 'diff'
      let locateSourceRestored = source !== 'diff'
      let locateSelectionRestored = source !== 'diff'
      let locateJumpBackClicked = source !== 'diff'
      let locateEditorRestored = source !== 'diff'
      let locateViewStateRestored = source !== 'diff'
      let backReturnStateReady = returnStateReady
      if (source === 'diff') {
        locateTriggered = returnStateReady && await triggerSourceReturnJump()
        locateSourceRestored = Boolean(locateTriggered)
          && await waitForActiveSubpage(`${label}:locate-source`, 'diff')
        locateSelectionRestored = Boolean(locateSourceRestored) && await waitFor(
          `${label}:locate-selection`,
          () => {
            const selected = getGitDiffApi()?.getSelectedFile?.()
            return selected?.filename === sourceFilenameBefore
              && selected?.changeType === sourceChangeTypeBefore
          },
          COLD_DIFF_LOAD_BUDGET_MS
        )
        const locateSelectedFile = getGitDiffApi()?.getSelectedFile?.() ?? null
        if (!locateSelectionRestored) {
          log(`${label}:locate-selection-failed`, {
            expected: {
              filename: sourceFilenameBefore,
              changeType: sourceChangeTypeBefore
            },
            actual: locateSelectedFile,
            fileCount: getGitDiffApi()?.getFileList?.().length ?? null
          })
        }
        locateJumpBackClicked = Boolean(locateSelectionRestored)
          && await clickJumpToEditor(`${label}:locate-return`, 'diff', filePath)
        locateEditorRestored = Boolean(locateJumpBackClicked)
          && await waitForActiveSubpage(`${label}:locate-editor`, 'editor')
          && await waitForProjectEditorFile(`${label}:locate-target`, filePath)
          && await waitForEditorSurface(`${label}:locate-surface`, fileKind, filePath)
        locateViewStateRestored = Boolean(locateEditorRestored)
          && await verifyNavigationViewState(`${label}:locate-view-state`, viewState)
        backReturnStateReady = Boolean(locateViewStateRestored) && await waitFor(
          `${label}:return-state-after-locate`,
          () => {
            const state = readSourceReturnState('diff')
            return Boolean(
              state?.visible
              && state.source === 'diff'
              && state.backEnabled
              && state.jumpEnabled
              && state.activeFilePath === filePath
            )
          },
          5000
        )
      }
      const backTriggered = backReturnStateReady && await triggerSourceReturnBack()
      const sourceRestored = backTriggered
        && await waitForActiveSubpage(`${label}:source-restored`, source)
      const selectionRestored = Boolean(sourceRestored) && await waitFor(`${label}:selection-restored`, () => {
        if (source === 'diff') {
          const selected = getGitDiffApi()?.getSelectedFile?.()
          return selected?.filename === sourceFilenameBefore
            && selected?.changeType === sourceChangeTypeBefore
        }
        const selectedFile = getGitHistoryApi()?.getSelectedFile?.()?.filename ?? null
        const selectedShas = getGitHistoryApi()?.getSelectedShas?.() ?? []
        return selectedFile === sourceFilenameBefore
          && selectedShas.length === historyShasBefore.length
          && selectedShas.every((sha, index) => sha === historyShasBefore[index])
      }, COLD_DIFF_LOAD_BUDGET_MS)

      return {
        ok: Boolean(
          warmed
          && pdfReadyReprobe
          && sourceSelected
          && jumpClicked
          && editorTargetOpened
          && surfaceRestored
          && viewStateRestored
          && returnStateReady
          && locateTriggered
          && locateSourceRestored
          && locateSelectionRestored
          && locateJumpBackClicked
          && locateEditorRestored
          && locateViewStateRestored
          && backReturnStateReady
          && backTriggered
          && sourceRestored
          && selectionRestored
        ),
        stage: 'complete',
        warmed,
        pdfReadyReprobe,
        sourceSelected,
        jumpClicked,
        editorTargetOpened,
        surfaceRestored,
        viewState,
        viewStateRestored,
        viewStateObservation,
        returnStateReady,
        locateTriggered,
        locateSourceRestored,
        locateSelectionRestored,
        locateSelectedFile: source === 'diff' ? getGitDiffApi()?.getSelectedFile?.() ?? null : null,
        locateJumpBackClicked,
        locateEditorRestored,
        locateViewStateRestored,
        locateViewStateObservation: viewState.kind === 'html'
          ? htmlViewStateObservations.get(`${label}:locate-view-state`) ?? null
          : null,
        backReturnStateReady,
        backTriggered,
        sourceRestored,
        selectionRestored
      }
    }

    const runColdCodeJumpRoundTrip = async (source: NavigationSource) => {
      const label = `snj:cold-code:${source}`
      const editorActive = await ensureEditorActive(label)
      if (!editorActive) return { ok: false, stage: 'open-editor' }
      await getNavigationProjectEditorApi()?.openFileByPathAsUser?.('editor-only.md', { trackRecent: false })
      const oldFileReady = await waitForProjectEditorFile(`${label}:old-file`, 'editor-only.md')
      const sourceSelected = oldFileReady && await selectNavigationSourceFile(label, source, 'navigate.ts')
      const sourceChangeType = source === 'diff'
        ? getGitDiffApi()?.getSelectedFile?.()?.changeType ?? null
        : null
      const jumpClicked = sourceSelected && await clickJumpToEditor(label, source, 'navigate.ts')
      const targetOpened = Boolean(jumpClicked)
        && await waitForActiveSubpage(`${label}:editor`, 'editor')
        && await waitForProjectEditorFile(`${label}:target`, 'navigate.ts')
        && await waitForEditorSurface(`${label}:surface`, 'code', 'navigate.ts')
      const returnReady = Boolean(targetOpened) && await waitFor(`${label}:return-ready`, () => {
        const state = readSourceReturnState(source)
        return Boolean(state?.visible && state.source === source && state.backEnabled)
      }, 5000)
      const backClicked = returnReady && await triggerSourceReturnBack()
      const sourceRestored = Boolean(backClicked)
        && await waitForActiveSubpage(`${label}:source`, source)
      const selectionRestored = Boolean(sourceRestored) && await waitFor(`${label}:selection`, () => {
        if (source === 'history') return getGitHistoryApi()?.getSelectedFile?.()?.filename === 'navigate.ts'
        const selected = getGitDiffApi()?.getSelectedFile?.()
        return selected?.filename === 'navigate.ts' && selected.changeType === sourceChangeType
      }, COLD_DIFF_LOAD_BUDGET_MS)
      return {
        ok: Boolean(
          editorActive && oldFileReady && sourceSelected && jumpClicked && targetOpened
          && returnReady && backClicked && sourceRestored && selectionRestored
        ),
        stage: 'complete',
        editorActive,
        oldFileReady,
        sourceSelected,
        sourceChangeType,
        jumpClicked,
        targetOpened,
        returnReady,
        backClicked,
        sourceRestored,
        selectionRestored
      }
    }

    const editorOpened = await openProjectEditor('setup')
    _assert('SN-01-open-project-editor', editorOpened, {
      rootPath: getProjectEditorApi()?.getRootPath?.() ?? null
    })
    if (!editorOpened || cancelled()) return results

    if (navigationGroup === 'core') {
    let initialShellNode: HTMLElement | null = null
    const initialShell = await waitFor('subpage-navigation-shell-editor-visible', () => {
      const shells = getVisibleSubpageShells()
      initialShellNode = shells.length === 1 ? shells[0] : null
      return Boolean(initialShellNode)
    }, 8000)
    _assert('SN-01A-shared-shell-visible-on-editor', Boolean(initialShell), {
      visibleShells: getVisibleSubpageShells().length
    })
    if (!initialShell || cancelled()) return results

    // Poll the button's current-page (disabled) state and the uniform-layout
    // outcome instead of reading once: the subpage switch's React render can lag
    // under EDR, so a single-shot read raced the commit. waitFor short-circuits.
    const editorCurrent = await waitFor('SN-02-editor-current', () => Boolean(getSubpageButton('editor')?.disabled), 8000)
    _assert('SN-02-editor-switcher-current', editorCurrent, {
      disabled: getSubpageButton('editor')?.disabled ?? null
    })
    const editorUniform = await waitFor('SN-02A-editor-uniform', () => areVisibleShellButtonsUniform().ok, 8000)
    _assert('SN-02A-editor-header-buttons-uniform', editorUniform, {
      metrics: areVisibleShellButtonsUniform().metrics
    })

    await getProjectEditorApi()?.openFileByPathAsUser?.('editor-only.md', { trackRecent: true })
    const editorOnlyOpened = await waitForProjectEditorFile('editor-only', 'editor-only.md')
    _assert('SN-03-editor-open-editor-only', editorOnlyOpened, {
      activeFilePath: getProjectEditorApi()?.getActiveFilePath?.() ?? null
    })
    if (cancelled()) return results

    const clickedDiffFromEditor = clickSubpageButton('diff')
    const diffOpened = clickedDiffFromEditor && await waitForGitDiffOpen('from-editor')
    let diffShellNode: HTMLElement | null = null
    const diffShell = await waitFor('subpage-navigation-shell-diff-visible', () => {
      const shells = getVisibleSubpageShells()
      diffShellNode = shells.length === 1 ? shells[0] : null
      return Boolean(diffShellNode)
    }, 8000)
    _assert('SN-04-editor-switch-to-diff', diffOpened, {
      clickedDiffFromEditor,
      diffOpen: getGitDiffApi()?.isOpen?.() ?? false
    })
    _assert('SN-04A-shared-shell-reused-on-diff', Boolean(diffShell && diffShellNode === initialShellNode), {
      visibleShells: getVisibleSubpageShells().length,
      reusedShellNode: Boolean(diffShell && diffShellNode === initialShellNode)
    })
    if (!diffOpened || cancelled()) return results

    const diffCurrent = await waitFor('SN-05-diff-current', () => Boolean(getSubpageButton('diff')?.disabled), 8000)
    _assert('SN-05-diff-switcher-current', diffCurrent, {
      disabled: getSubpageButton('diff')?.disabled ?? null
    })
    const diffButtonsUniform = await waitFor('SN-05A-diff-uniform', () => areVisibleShellButtonsUniform().ok, 8000)
    _assert('SN-05A-diff-header-buttons-uniform', diffButtonsUniform, {
      metrics: areVisibleShellButtonsUniform().metrics
    })

    const diffExistingReady = await waitForDiffFile('existing', 'existing.md')
    // Re-fetch a FRESH api on every attempt: a captured const can race a
    // remount of GitDiffViewer (the cold-load effect re-mounts the panel), and
    // calling selectFileByPath() on a stale api silently no-ops. Retry the
    // selection itself until a live api reports the file as selected.
    const selectedExistingInDiff = diffExistingReady && await waitFor(
      'subpage-navigation-diff-existing-selected',
      () => {
        const api = getGitDiffApi()
        if (!api) return false
        if (api.getSelectedFile?.()?.filename === 'existing.md') return true
        return api.selectFileByPath('existing.md') === true
          && api.getSelectedFile?.()?.filename === 'existing.md'
      },
      COLD_DIFF_LOAD_BUDGET_MS
    )
    // Switching back to Editor via SubpageSwitcher should restore the
    // Editor's own previous state (editor-only.md), NOT open the Diff's
    // selected file.
    const clickedEditorFromDiff = clickSubpageButton('editor')
    const diffToEditorOpened = clickedEditorFromDiff && await waitForProjectEditorFile('diff-restores-editor-state', 'editor-only.md')
    _assert('SN-06-diff-to-editor-restores-editor-state', selectedExistingInDiff && diffToEditorOpened, {
      selectedExistingInDiff,
      clickedEditorFromDiff,
      expected: 'editor-only.md',
      activeFilePath: getProjectEditorApi()?.getActiveFilePath?.() ?? null
    })
    if (cancelled()) return results

    await getProjectEditorApi()?.openFileByPathAsUser?.('editor-only.md', { trackRecent: true })
    const editorOnlyRestored = await waitForProjectEditorFile('editor-only-restored', 'editor-only.md')
    const clickedDiffAgain = clickSubpageButton('diff')
    const diffRestored = clickedDiffAgain && await waitForGitDiffOpen('restore-from-editor')
    // waitForGitDiffOpen only confirms the panel is mounted (api.isOpen()).
    // GitDiffViewer's own [isOpen=true] restore effect re-applies the
    // previously selected file via memory-store lookup on a follow-up render
    // tick, so reading `getSelectedFile()` synchronously here would race the
    // restore. The afterEnter restore poll itself waits up to
    // COLD_DIFF_RESTORE_BUDGET_MS (~20 s) for the cold diff file-list to land
    // under EDR, so the test must give the restore the same cold budget rather
    // than the old 3 s — otherwise it reads the selection before the production
    // poll has a chance to find the file in the still-loading list.
    if (diffRestored) {
      await waitFor('subpage-navigation-diff-selection-restored',
        () => Boolean(getGitDiffApi()?.getSelectedFile?.()?.filename),
        COLD_DIFF_LOAD_BUDGET_MS)
    }
    const restoredDiffSelection = getGitDiffApi()?.getSelectedFile?.()?.filename ?? null
    _assert('SN-07-editor-to-diff-restores-diff-selection', editorOnlyRestored && diffRestored && restoredDiffSelection === 'existing.md', {
      editorOnlyRestored,
      clickedDiffAgain,
      restoredDiffSelection
    })
    if (!diffRestored || cancelled()) return results

    const clickedHistoryFromDiff = clickSubpageButton('history')
    const historyOpened = clickedHistoryFromDiff && await waitForGitHistoryOpen('from-diff')
    let historyShellNode: HTMLElement | null = null
    const historyShell = await waitFor('subpage-navigation-shell-history-visible', () => {
      const shells = getVisibleSubpageShells()
      historyShellNode = shells.length === 1 ? shells[0] : null
      return Boolean(historyShellNode)
    }, 8000)
    _assert('SN-08-diff-switch-to-history', historyOpened, {
      clickedHistoryFromDiff,
      historyOpen: getGitHistoryApi()?.isOpen?.() ?? false
    })
    _assert('SN-08A-shared-shell-reused-on-history', Boolean(historyShell && historyShellNode === initialShellNode), {
      visibleShells: getVisibleSubpageShells().length,
      reusedShellNode: Boolean(historyShell && historyShellNode === initialShellNode)
    })
    if (!historyOpened || cancelled()) return results

    const historyCurrent = await waitFor('SN-09-history-current', () => Boolean(getSubpageButton('history')?.disabled), 8000)
    _assert('SN-09-history-switcher-current', historyCurrent, {
      disabled: getSubpageButton('history')?.disabled ?? null
    })
    const historyButtonsUniform = await waitFor('SN-09A-history-uniform', () => areVisibleShellButtonsUniform().ok, 8000)
    _assert('SN-09A-history-header-buttons-uniform', historyButtonsUniform, {
      metrics: areVisibleShellButtonsUniform().metrics
    })

    const selectedUpdateCommit = await selectHistoryCommitByIndex('update-existing', 1)
    const historyFilesLoaded = await waitFor('subpage-navigation-history-existing-file', () => {
      const api = getGitHistoryApi()
      return Boolean(api && !api.isLoading() && api.getFiles().some((file) => file.filename === 'existing.md'))
    }, 8000)
    const selectedExistingHistoryFile = await selectHistoryFileByPath('existing', 'existing.md')
    await sleep(500)
    const clickedDiffFromHistory = await waitForSubpageButtonAndClick('sn10-diff-from-history', 'diff')
    const diffOpenedFromHistory = clickedDiffFromHistory && await waitForGitDiffOpen('from-history')
    const clickedHistoryAgain = diffOpenedFromHistory && await waitForSubpageButtonAndClick('sn10-history-again', 'history')
    const historyRestored = Boolean(clickedHistoryAgain) && await waitForGitHistoryOpen('restore-from-diff')
    const restoredHistoryFile = getGitHistoryApi()?.getSelectedFile?.()?.filename ?? null
    _assert('SN-10-diff-to-history-restores-history-selection', Boolean(selectedUpdateCommit && historyFilesLoaded && selectedExistingHistoryFile && historyRestored && restoredHistoryFile === 'existing.md'), {
      selectedUpdateCommit,
      historyFilesLoaded,
      selectedExistingHistoryFile,
      restoredHistoryFile
    })
    if (cancelled()) return results

    // Switching back to Editor via SubpageSwitcher should restore the
    // Editor's own previous state, NOT open History's selected file.
    const clickedEditorFromHistory = clickSubpageButton('editor')
    const historyToEditorOpened = clickedEditorFromHistory && await waitForProjectEditorFile('history-restores-editor-state', 'editor-only.md')
    _assert('SN-11-history-to-editor-restores-editor-state', historyToEditorOpened, {
      clickedEditorFromHistory,
      expected: 'editor-only.md',
      activeFilePath: getProjectEditorApi()?.getActiveFilePath?.() ?? null
    })
    if (cancelled()) return results

    await getProjectEditorApi()?.openFileByPathAsUser?.('editor-only.md', { trackRecent: true })
    const editorOnlyBeforeHistory = await waitForProjectEditorFile('editor-only-before-history', 'editor-only.md')
    const clickedHistoryFromEditor = await waitForSubpageButtonAndClick('sn12-history-from-editor', 'history')
    const historyOpenedFromEditor = clickedHistoryFromEditor && await waitForGitHistoryOpen('from-editor-restore')
    const restoredHistoryAfterEditor = getGitHistoryApi()?.getSelectedFile?.()?.filename ?? null
    _assert('SN-12-editor-to-history-restores-history-selection', Boolean(editorOnlyBeforeHistory && historyOpenedFromEditor && restoredHistoryAfterEditor === 'existing.md'), {
      editorOnlyBeforeHistory,
      clickedHistoryFromEditor,
      restoredHistoryAfterEditor
    })
    if (!historyOpenedFromEditor || cancelled()) return results

    // SN-13 / SN-14: SubpageSwitcher no longer passes the Diff/History
    // selected file to Editor.  Switching back should restore Editor's own
    // state regardless of what is selected in Diff/History.
    const selectedDeleteCommit = getGitHistoryApi()?.selectCommitByIndex(0) === true
    const deleteFilesLoaded = await waitFor('subpage-navigation-history-deleted-file', () => {
      const api = getGitHistoryApi()
      return Boolean(api && !api.isLoading() && api.getFiles().some((file) => file.filename === 'history-deleted.md'))
    }, 8000)
    const selectedDeletedHistoryFile = await selectHistoryFileByPath('deleted', 'history-deleted.md')
    await sleep(500)
    const clickedEditorMissingFromHistory = clickSubpageButton('editor')
    const historyDeletedRestored = clickedEditorMissingFromHistory && await waitForProjectEditorFile('history-deleted-restore', 'editor-only.md')
    _assert('SN-13-history-deleted-file-does-not-override-editor', Boolean(
      selectedDeleteCommit &&
      deleteFilesLoaded &&
      selectedDeletedHistoryFile &&
      historyDeletedRestored
    ), {
      selectedDeleteCommit,
      deleteFilesLoaded,
      selectedDeletedHistoryFile,
      expected: 'editor-only.md',
      activeFilePath: getProjectEditorApi()?.getActiveFilePath?.() ?? null
    })
    if (cancelled()) return results

    const clickedDiffForMissing = clickSubpageButton('diff')
    const diffOpenedForMissing = clickedDiffForMissing && await waitForGitDiffOpen('missing')
    const diffActiveForMissing = diffOpenedForMissing && await waitForActiveSubpage('missing-diff-active', 'diff')
    const diffDeletedReady = await waitForDiffFile('deleted', 'diff-deleted.md')
    const selectedDeletedDiffFile = diffDeletedReady && getGitDiffApi()?.selectFileByPath('diff-deleted.md') === true
    await sleep(500)
    const clickedEditorMissingFromDiff = Boolean(diffActiveForMissing) && clickSubpageButton('editor')
    const editorActiveFromDiff = clickedEditorMissingFromDiff && await waitForActiveSubpage('diff-deleted-editor-active', 'editor')
    const diffDeletedRestored = editorActiveFromDiff && await waitForProjectEditorFile('diff-deleted-restore', 'editor-only.md')
    _assert('SN-14-diff-deleted-file-does-not-override-editor', Boolean(
      diffOpenedForMissing &&
      diffActiveForMissing &&
      selectedDeletedDiffFile &&
      clickedEditorMissingFromDiff &&
      editorActiveFromDiff &&
      diffDeletedRestored
    ), {
      diffOpenedForMissing,
      diffActiveForMissing,
      selectedDeletedDiffFile,
      clickedEditorMissingFromDiff,
      editorActiveFromDiff,
      diffDeletedRestored,
      expected: 'editor-only.md',
      activeFilePath: getProjectEditorApi()?.getActiveFilePath?.() ?? null
    })

    if (navigationGroup === 'core') {
      for (const source of getNavigationSources()) {
        const coldResult = await runColdCodeJumpRoundTrip(source)
        _assert(`SNJ-CODE-${source.toUpperCase()}-COLD-DIFFERENT-FILE`, coldResult.ok, coldResult)
      }

      const selectExactDiffEntry = async (
        label: string,
        filePath: string,
        changeType: 'staged' | 'unstaged',
        expectedJumpStatus: 'available' | 'missing' = 'available'
      ) => {
        const diffSelected = await selectNavigationSourceFile(label, 'diff', filePath)
        if (!diffSelected) return false
        return await waitFor(`${label}:exact-change-type`, () => {
          const api = getGitDiffApi()
          const files = api?.getFileList?.() ?? []
          const index = files.findIndex((file) => (
            file.filename === filePath && file.changeType === changeType
          ))
          if (!api || index < 0) return false
          if (api.getSelectedFile?.()?.changeType !== changeType) {
            if (api.selectFileByIndex(index) !== true) return false
          }
          const button = getVisibleDiffJumpButton()
          return api.getSelectedFile?.()?.changeType === changeType
            && button?.dataset.jumpFile === filePath
            && button.dataset.jumpChangeType === changeType
            && button.dataset.jumpStatus === expectedJumpStatus
        }, COLD_DIFF_LOAD_BUDGET_MS)
      }

      const runExactDiffReturn = async (
        changeType: 'staged' | 'unstaged',
        action: 'back' | 'jump',
        coldLoadDelayMs = 0
      ) => {
        const label = `snj:dual-state:${changeType}:${action}`
        const editorReady = await ensureEditorActive(label)
        await getNavigationProjectEditorApi()?.openFileByPathAsUser?.('editor-only.md', { trackRecent: false })
        const oldFileReady = editorReady && await waitForProjectEditorFile(`${label}:old`, 'editor-only.md')
        const exactSelected = oldFileReady && await selectExactDiffEntry(label, 'dual-state.ts', changeType)
        const jumpClicked = exactSelected && await clickJumpToEditor(label, 'diff', 'dual-state.ts')
        const editorTargetReady = Boolean(jumpClicked)
          && await waitForActiveSubpage(`${label}:editor`, 'editor')
          && await waitForProjectEditorFile(`${label}:target`, 'dual-state.ts')
          && await waitFor(`${label}:working-content`, () => (
            getNavigationProjectEditorApi()?.getEditorContent?.().includes('DUAL_STATE_WORKING_TREE') === true
          ), 8000)
        const returnReady = Boolean(editorTargetReady) && await waitFor(`${label}:return`, () => {
          const state = readSourceReturnState('diff')
          return Boolean(state?.visible && state.source === 'diff' && state.jumpEnabled)
        }, COLD_DIFF_LOAD_BUDGET_MS)
        if (returnReady && coldLoadDelayMs > 0) {
          await sleep(coldLoadDelayMs)
        }
        const returnClicked = returnReady && (action === 'back'
          ? await triggerSourceReturnBack()
          : await triggerSourceReturnJump())
        const diffReady = returnClicked && await waitForActiveSubpage(`${label}:diff`, 'diff')
        const exactRestored = Boolean(diffReady) && await waitFor(`${label}:restored`, () => {
          const selected = getGitDiffApi()?.getSelectedFile?.()
          return selected?.filename === 'dual-state.ts' && selected.changeType === changeType
        }, COLD_DIFF_LOAD_BUDGET_MS)
        return {
          ok: Boolean(
            editorReady && oldFileReady && exactSelected && jumpClicked && editorTargetReady
            && returnReady && returnClicked && diffReady && exactRestored
          ),
          changeType,
          action,
          coldLoadDelayMs,
          editorReady,
          oldFileReady,
          exactSelected,
          jumpClicked,
          editorTargetReady,
          returnReady,
          returnClicked,
          diffReady,
          exactRestored
        }
      }

      for (const changeType of ['staged', 'unstaged'] as const) {
        for (const action of ['back', 'jump'] as const) {
          const exactResult = await runExactDiffReturn(changeType, action)
          _assert(
            `SNJ-DIFF-${changeType.toUpperCase()}-${action.toUpperCase()}-EXACT`,
            exactResult.ok,
            exactResult
          )
        }
      }

      const coldJumpTrials: Array<Awaited<ReturnType<typeof runExactDiffReturn>>> = []
      for (let trial = 1; trial <= 5; trial += 1) {
        const result = await runExactDiffReturn('staged', 'jump', 1000)
        coldJumpTrials.push(result)
        if (!result.ok) break
      }
      _assert(
        'SNJ-DIFF-STAGED-JUMP-COLD-LOAD-5X',
        coldJumpTrials.length === 5 && coldJumpTrials.every((trial) => trial.ok),
        { trials: coldJumpTrials }
      )

      const stagedMissingSelected = await selectExactDiffEntry(
        'snj-diff-staged-missing',
        'staged-missing.ts',
        'staged',
        'missing'
      )
      const stagedMissingDisabled = stagedMissingSelected && await waitFor(
        'snj-diff-staged-missing-disabled',
        () => {
          const button = getVisibleDiffJumpButton()
          return Boolean(
            button?.disabled
            && button.dataset.jumpStatus === 'missing'
            && button.dataset.jumpFile === 'staged-missing.ts'
          )
        },
        COLD_DIFF_LOAD_BUDGET_MS
      )
      getVisibleDiffJumpButton()?.click()
      await sleep(200)
      const stagedMissingStayedInDiff = Boolean(
        document.querySelector('.terminal-grid-subpage-host[data-active-subpage="diff"]')
      )
      _assert('SNJ-DIFF-STAGED-WORKTREE-MISSING-DISABLED', Boolean(
        stagedMissingSelected && stagedMissingDisabled && stagedMissingStayedInDiff
      ), {
        stagedMissingSelected,
        stagedMissingDisabled,
        stagedMissingStayedInDiff,
        selectedFile: getGitDiffApi()?.getSelectedFile?.() ?? null
      })

      const moveTerminalToFixtureRoot = async (targetRoot: string) => {
        const shellPath = platform === 'win32' ? targetRoot.replace(/\//g, '\\') : targetRoot
        await writeAndSyncTerminal(
          terminalId,
          buildChangeDirectoryCommand(platform, shellPath),
          sleep
        )
        const cwd = await waitForTerminalCwd(terminalId, targetRoot, sleep, COLD_DIFF_LOAD_BUDGET_MS)
        await window.electronAPI.git.notifyTerminalGitUpdate(terminalId)
        const gridObserved = await waitFor(`terminal-grid-cwd:${targetRoot}`, () => {
          const info = window.__onwardTerminalDebug?.getTerminalGitInfo?.(terminalId)
          return normalizePath(info?.repoRoot ?? info?.cwd ?? '') === normalizePath(targetRoot)
        }, COLD_DIFF_LOAD_BUDGET_MS, 150)
        return Boolean(cwd && gridObserved)
      }

      const runSourceRootDriftTrial = async (source: NavigationSource, trial: number) => {
        const label = `snj-${source}-terminal-cwd-drift-${trial}`
        const editorReady = await ensureEditorActive(label)
        const sourceSelected = editorReady && await selectNavigationSourceFile(
          label,
          source,
          'navigate.ts'
        )
        const sourceChangeType = source === 'diff'
          ? getGitDiffApi()?.getSelectedFile?.()?.changeType ?? null
          : null
        const jumped = sourceSelected && await clickJumpToEditor(label, source, 'navigate.ts')
        const editorOpened = Boolean(jumped)
          && await waitForActiveSubpage(`${label}:editor`, 'editor')
          && await waitForProjectEditorFile(`${label}:file`, 'navigate.ts')
          && await waitFor(`${label}:editor-root`, () => (
            normalizePath(getNavigationProjectEditorApi()?.getRootPath?.() ?? '') === normalizePath(fixtureRoot)
          ), COLD_DIFF_LOAD_BUDGET_MS)
        const terminalMoved = Boolean(editorOpened) && await moveTerminalToFixtureRoot(fixtureRootB)
        const back = Boolean(terminalMoved) && await triggerSourceReturnBack()
        const sourceRootRestored = Boolean(back)
          && await waitForActiveSubpage(`${label}:back`, source)
          && await waitFor(`${label}:source-root`, () => {
            if (source === 'diff') {
              const selected = getGitDiffApi()?.getSelectedFile?.()
              return normalizePath(getGitDiffApi()?.getCwd?.() ?? '') === normalizePath(fixtureRoot)
                && selected?.filename === 'navigate.ts'
                && selected.changeType === sourceChangeType
            }
            return normalizePath(getGitHistoryApi()?.getActiveCwd?.() ?? '') === normalizePath(fixtureRoot)
              && getGitHistoryApi()?.getSelectedFile?.()?.filename === 'navigate.ts'
          }, COLD_DIFF_LOAD_BUDGET_MS)
        const terminalStayedAtB = normalizePath(
          await window.electronAPI.git.getTerminalCwd(terminalId) ?? ''
        ) === normalizePath(fixtureRootB)
        const terminalReset = await moveTerminalToFixtureRoot(fixtureRoot)
        return {
          ok: Boolean(
            editorReady && sourceSelected && jumped && editorOpened && terminalMoved
            && back && sourceRootRestored && terminalStayedAtB && terminalReset
          ),
          trial,
          source,
          editorReady,
          sourceSelected,
          sourceChangeType,
          jumped,
          editorOpened,
          terminalMoved,
          back,
          sourceRootRestored,
          terminalStayedAtB,
          terminalReset
        }
      }

      for (const source of getNavigationSources()) {
        const trials = []
        for (let trial = 1; trial <= 5; trial += 1) {
          trials.push(await runSourceRootDriftTrial(source, trial))
        }
        _assert(`SNJ-${source.toUpperCase()}-BACK-PRESERVES-SOURCE-ROOT-AFTER-TERMINAL-CD-5X`, (
          trials.length === 5 && trials.every((trial) => trial.ok)
        ), { trials })
      }

      const historyAlreadyOpenForAvailability = Boolean(
        document.querySelector('.terminal-grid-subpage-host[data-active-subpage="history"]')
        && getGitHistoryApi()?.isOpen()
      )
      const historyOpenedForAvailability = historyAlreadyOpenForAvailability || (
        await waitForSubpageButtonAndClick('snj-history-availability', 'history')
        && await waitForGitHistoryOpen('snj-history-availability')
      )
      const deleteCommitSelected = Boolean(historyOpenedForAvailability) && await waitFor(
        'snj-history-delete-commit',
        () => {
          const api = getGitHistoryApi()
          const commits = api?.getCommits?.() ?? []
          const index = commits.findIndex((commit) => commit.summary === 'delete history file')
          if (!api || index < 0) return false
          if (api.getSelectedShas?.().includes(commits[index].sha)) return true
          return api.selectCommitByIndex(index) === true
        },
        COLD_DIFF_LOAD_BUDGET_MS
      )
      const deletedFileSelected = deleteCommitSelected
        && await waitFor('snj-history-deleted-list', () => (
          getGitHistoryApi()?.getFiles?.().some((file) => file.filename === 'history-deleted.md') === true
        ), COLD_DIFF_LOAD_BUDGET_MS)
        && await selectHistoryFileByPath('snj-history-deleted', 'history-deleted.md')
      const missingJumpDisabled = Boolean(deletedFileSelected) && await waitFor(
        'snj-history-missing-disabled',
        () => {
          const button = getVisibleHistoryJumpButton()
          return Boolean(button?.disabled && button.dataset.jumpStatus === 'missing')
        },
        8000
      )
      const recreated = await window.electronAPI.project.saveFile(
        fixtureRoot,
        'history-deleted.md',
        'HISTORY_RECREATED_WORKTREE\n'
      )
      await window.electronAPI.git.notifyTerminalGitUpdate(terminalId)
      const recreatedJumpAvailable = recreated.success && await waitFor(
        'snj-history-recreated-available',
        () => {
          const button = getVisibleHistoryJumpButton()
          return Boolean(button && !button.disabled && button.dataset.jumpStatus === 'available')
        },
        COLD_DIFF_LOAD_BUDGET_MS
      )
      const recreatedJumpClicked = recreatedJumpAvailable
        && await clickJumpToEditor('snj-history-recreated', 'history', 'history-deleted.md')
      const recreatedOpened = Boolean(recreatedJumpClicked)
        && await waitForActiveSubpage('snj-history-recreated-editor', 'editor')
        && await waitForProjectEditorFile('snj-history-recreated-file', 'history-deleted.md')
        && getNavigationProjectEditorApi()?.getEditorContent?.().includes('HISTORY_RECREATED_WORKTREE') === true
      const recreatedBack = recreatedOpened && await triggerSourceReturnBack()
      const recreatedHistoryRestored = Boolean(recreatedBack)
        && await waitForActiveSubpage('snj-history-recreated-back', 'history')
      _assert('SNJ-HISTORY-MISSING-RECREATED-AVAILABILITY', Boolean(
        historyOpenedForAvailability && deleteCommitSelected && deletedFileSelected
        && missingJumpDisabled && recreated.success && recreatedJumpAvailable
        && recreatedJumpClicked && recreatedOpened && recreatedBack && recreatedHistoryRestored
      ), {
        historyOpenedForAvailability,
        deleteCommitSelected,
        deletedFileSelected,
        missingJumpDisabled,
        recreated: recreated.success,
        recreatedJumpAvailable,
        recreatedJumpClicked,
        recreatedOpened,
        recreatedBack,
        recreatedHistoryRestored
      })

      const baseCommitSelectedForRename = await waitFor('snj-history-base-for-rename', () => {
        const api = getGitHistoryApi()
        const commits = api?.getCommits?.() ?? []
        const index = commits.findIndex((commit) => commit.summary === 'base navigation fixture')
        if (!api || index < 0) return false
        if (api.getSelectedShas?.().includes(commits[index].sha)) return true
        return api.selectCommitByIndex(index) === true
      }, COLD_DIFF_LOAD_BUDGET_MS)
      const renamedOldPathSelected = baseCommitSelectedForRename
        && await waitFor('snj-history-rename-list', () => (
          getGitHistoryApi()?.getFiles?.().some((file) => file.filename === 'rename-original.txt') === true
        ), COLD_DIFF_LOAD_BUDGET_MS)
        && await selectHistoryFileByPath('snj-history-rename-old', 'rename-original.txt')
      const renamedOldPathDisabled = Boolean(renamedOldPathSelected) && await waitFor(
        'snj-history-rename-old-disabled',
        () => {
          const button = getVisibleHistoryJumpButton()
          return Boolean(button?.disabled && button.dataset.jumpStatus === 'missing')
        },
        8000
      )
      _assert('SNJ-HISTORY-RENAMED-OLD-PATH-DISABLED', Boolean(
        baseCommitSelectedForRename && renamedOldPathSelected && renamedOldPathDisabled
      ), { baseCommitSelectedForRename, renamedOldPathSelected, renamedOldPathDisabled })

      const editorBeforeCrossRoot = await ensureEditorActive('snj-cross-root')
      await getNavigationProjectEditorApi()?.openFileByPathAsUser?.('editor-only.md', { trackRecent: false })
      const editorRootAReady = editorBeforeCrossRoot
        && await waitForProjectEditorFile('snj-cross-root-old-a', 'editor-only.md')
      window.dispatchEvent(new CustomEvent('git-diff:open', {
        detail: { terminalId, cwd: fixtureRootB, source: 'debug' }
      }))
      const diffRootBReady = editorRootAReady
        && await waitForActiveSubpage('snj-cross-root-diff', 'diff')
        && await waitForGitDiffOpen('snj-cross-root-diff')
        && await waitFor('snj-cross-root-diff-cwd', () => (
          normalizePath(getGitDiffApi()?.getCwd?.() ?? '') === normalizePath(fixtureRootB)
        ), COLD_DIFF_LOAD_BUDGET_MS)
        && await waitForDiffFile('snj-cross-root-target', 'cross-root-target.ts')
      const crossRootDiffSelected = diffRootBReady
        && await waitFor('snj-cross-root-diff-select', () => (
          getGitDiffApi()?.selectFileByPath?.('cross-root-target.ts') === true
          && getGitDiffApi()?.getSelectedFile?.()?.filename === 'cross-root-target.ts'
        ), COLD_DIFF_LOAD_BUDGET_MS)
      const crossRootDiffChangeType = getGitDiffApi()?.getSelectedFile?.()?.changeType ?? null
      const crossRootDiffJump = crossRootDiffSelected
        && await clickJumpToEditor('snj-cross-root-diff', 'diff', 'cross-root-target.ts')
      const crossRootDiffOpened = Boolean(crossRootDiffJump)
        && await waitForActiveSubpage('snj-cross-root-editor', 'editor')
        && await waitFor('snj-cross-root-editor-root', () => (
          normalizePath(getNavigationProjectEditorApi()?.getRootPath?.() ?? '') === normalizePath(fixtureRootB)
        ), COLD_DIFF_LOAD_BUDGET_MS)
        && await waitForProjectEditorFile('snj-cross-root-target-file', 'cross-root-target.ts')
        && getNavigationProjectEditorApi()?.getEditorContent?.().includes(CROSS_ROOT_WORKING_MARKER) === true
      _assert('SNJ-DIFF-CROSS-ROOT-JUMP', Boolean(
        editorRootAReady && diffRootBReady && crossRootDiffSelected
        && crossRootDiffJump && crossRootDiffOpened
      ), {
        editorRootAReady,
        diffRootBReady,
        crossRootDiffSelected,
        crossRootDiffJump,
        crossRootDiffOpened,
        editorRoot: getNavigationProjectEditorApi()?.getRootPath?.() ?? null
      })

      const crossRootDiffBack = Boolean(crossRootDiffOpened) && await triggerSourceReturnBack()
      const crossRootDiffReturned = Boolean(crossRootDiffBack)
        && await waitForActiveSubpage('snj-cross-root-diff-back', 'diff')
        && await waitFor('snj-cross-root-diff-back-state', () => {
          const api = getGitDiffApi()
          const selected = api?.getSelectedFile?.()
          return normalizePath(api?.getCwd?.() ?? '') === normalizePath(fixtureRootB)
            && selected?.filename === 'cross-root-target.ts'
            && selected.changeType === crossRootDiffChangeType
        }, COLD_DIFF_LOAD_BUDGET_MS)
      _assert('SNJ-DIFF-CROSS-ROOT-BACK', Boolean(crossRootDiffBack && crossRootDiffReturned), {
        crossRootDiffBack,
        crossRootDiffReturned,
        cwd: getGitDiffApi()?.getCwd?.() ?? null,
        selectedFile: getGitDiffApi()?.getSelectedFile?.() ?? null
      })

      window.dispatchEvent(new CustomEvent('project-editor:open', {
        detail: {
          terminalId,
          repoRoot: fixtureRoot,
          filePath: 'editor-only.md'
        }
      }))
      const historyEditorRootAReady = Boolean(crossRootDiffReturned)
        && await waitForActiveSubpage('snj-cross-root-history-editor-a', 'editor')
        && await waitFor('snj-cross-root-history-editor-root-a', () => (
          normalizePath(getNavigationProjectEditorApi()?.getRootPath?.() ?? '') === normalizePath(fixtureRoot)
        ), COLD_DIFF_LOAD_BUDGET_MS)
        && await waitForProjectEditorFile('snj-cross-root-history-old-a', 'editor-only.md')
      const historyRootBOpened = historyEditorRootAReady
        && await waitForSubpageButtonAndClick('snj-cross-root-history', 'history')
        && await waitForGitHistoryOpen('snj-cross-root-history')
      getGitHistoryApi()?.switchRepo?.(fixtureRootB)
      const historyRootBReady = Boolean(historyRootBOpened) && await waitFor(
        'snj-cross-root-history-cwd',
        () => normalizePath(getGitHistoryApi()?.getActiveCwd?.() ?? '') === normalizePath(fixtureRootB),
        COLD_DIFF_LOAD_BUDGET_MS
      )
      const historyRootBCommit = historyRootBReady && await waitFor(
        'snj-cross-root-history-commit',
        () => {
          const api = getGitHistoryApi()
          const commits = api?.getCommits?.() ?? []
          const index = commits.findIndex((commit) => commit.summary === 'base cross-root navigation fixture')
          if (!api || index < 0) return false
          if (api.getSelectedShas?.().includes(commits[index].sha)) return true
          return api.selectCommitByIndex(index) === true
        },
        COLD_DIFF_LOAD_BUDGET_MS
      )
      const historyRootBFile = historyRootBCommit
        && await waitFor('snj-cross-root-history-file-list', () => (
          getGitHistoryApi()?.getFiles?.().some((file) => file.filename === 'cross-root-target.ts') === true
        ), COLD_DIFF_LOAD_BUDGET_MS)
        && await selectHistoryFileByPath('snj-cross-root-history-target', 'cross-root-target.ts')
      const crossRootHistoryJump = historyRootBFile
        && await clickJumpToEditor('snj-cross-root-history', 'history', 'cross-root-target.ts')
      const crossRootHistoryOpened = Boolean(crossRootHistoryJump)
        && await waitForActiveSubpage('snj-cross-root-history-editor', 'editor')
        && await waitFor('snj-cross-root-history-editor-root-b', () => (
          normalizePath(getNavigationProjectEditorApi()?.getRootPath?.() ?? '') === normalizePath(fixtureRootB)
        ), COLD_DIFF_LOAD_BUDGET_MS)
        && await waitForProjectEditorFile('snj-cross-root-history-target-file', 'cross-root-target.ts')
        && getNavigationProjectEditorApi()?.getEditorContent?.().includes(CROSS_ROOT_WORKING_MARKER) === true
      _assert('SNJ-HISTORY-CROSS-ROOT-COLD-DIFFERENT-FILE', Boolean(
        historyEditorRootAReady && historyRootBOpened && historyRootBReady && historyRootBCommit
        && historyRootBFile && crossRootHistoryJump && crossRootHistoryOpened
      ), {
        historyEditorRootAReady,
        historyRootBOpened,
        historyRootBReady,
        historyRootBCommit,
        historyRootBFile,
        crossRootHistoryJump,
        crossRootHistoryOpened,
        activeFile: getNavigationProjectEditorApi()?.getActiveFilePath?.() ?? null
      })

      const crossRootHistoryBack = Boolean(crossRootHistoryOpened) && await triggerSourceReturnBack()
      const crossRootHistoryReturned = Boolean(crossRootHistoryBack)
        && await waitForActiveSubpage('snj-cross-root-history-back', 'history')
        && await waitFor('snj-cross-root-history-back-state', () => (
          normalizePath(getGitHistoryApi()?.getActiveCwd?.() ?? '') === normalizePath(fixtureRootB)
          && getGitHistoryApi()?.getSelectedFile?.()?.filename === 'cross-root-target.ts'
        ), COLD_DIFF_LOAD_BUDGET_MS)
      _assert('SNJ-HISTORY-CROSS-ROOT-BACK', Boolean(
        crossRootHistoryBack && crossRootHistoryReturned
      ), {
        crossRootHistoryBack,
        crossRootHistoryReturned,
        cwd: getGitHistoryApi()?.getActiveCwd?.() ?? null,
        selectedFile: getGitHistoryApi()?.getSelectedFile?.() ?? null
      })

      window.dispatchEvent(new CustomEvent('git-diff:open', { detail: { terminalId } }))
      const terminalRootDiffRestored = await waitForActiveSubpage('snj-cross-root-terminal-diff', 'diff')
        && await waitFor('snj-cross-root-terminal-diff-root', () => (
          normalizePath(getGitDiffApi()?.getCwd?.() ?? '') === normalizePath(fixtureRoot)
        ), COLD_DIFF_LOAD_BUDGET_MS)
      const terminalRootEditorRestored = terminalRootDiffRestored
        && await waitForSubpageButtonAndClick('snj-cross-root-terminal-editor', 'editor')
        && await waitFor('snj-cross-root-terminal-editor-root', () => (
          normalizePath(getNavigationProjectEditorApi()?.getRootPath?.() ?? '') === normalizePath(fixtureRoot)
        ), COLD_DIFF_LOAD_BUDGET_MS)
      _assert('SNJ-CROSS-ROOT-RETURN-TO-TERMINAL-ROOT', Boolean(
        terminalRootDiffRestored && terminalRootEditorRestored
      ), {
        terminalRootDiffRestored,
        terminalRootEditorRestored,
        editorRoot: getNavigationProjectEditorApi()?.getRootPath?.() ?? null
      })

      const nestedRepoRoot = joinPath(fixtureRoot, 'nested-repo')
      const nestedFilePath = 'nested-target.ts'
      const nestedDiffOpened = terminalRootEditorRestored
        && await waitForSubpageButtonAndClick('snj-nested-panel-root-diff', 'diff')
        && await waitForGitDiffOpen('snj-nested-panel-root-diff')
        && await waitFor('snj-nested-panel-root-parent-cwd', () => (
          normalizePath(getGitDiffApi()?.getCwd?.() ?? '') === normalizePath(fixtureRoot)
        ), COLD_DIFF_LOAD_BUDGET_MS)
      const nestedFileReady = Boolean(nestedDiffOpened) && await waitFor(
        'snj-nested-panel-root-file',
        () => getGitDiffApi()?.getFileList?.().some((file) => (
          file.filename === nestedFilePath
          && normalizePath(file.repoRoot ?? '') === normalizePath(nestedRepoRoot)
        )) === true,
        COLD_DIFF_LOAD_BUDGET_MS
      )
      const nestedFileSelected = Boolean(nestedFileReady) && await waitFor(
        'snj-nested-panel-root-select',
        () => {
          const api = getGitDiffApi()
          if (!api) return false
          if (api.getSelectedFile?.()?.filename === nestedFilePath) return true
          return api.selectFileByPath(nestedFilePath) === true
            && api.getSelectedFile?.()?.filename === nestedFilePath
        },
        COLD_DIFF_LOAD_BUDGET_MS
      )
      const nestedJumped = Boolean(nestedFileSelected)
        && await clickJumpToEditor('snj-nested-panel-root', 'diff', nestedFilePath)
      const nestedEditorOpened = Boolean(nestedJumped)
        && await waitForActiveSubpage('snj-nested-panel-root-editor', 'editor')
        && await waitFor('snj-nested-panel-root-editor-root', () => (
          normalizePath(getNavigationProjectEditorApi()?.getRootPath?.() ?? '') === normalizePath(nestedRepoRoot)
        ), COLD_DIFF_LOAD_BUDGET_MS)
        && await waitForProjectEditorFile('snj-nested-panel-root-editor-file', nestedFilePath)
        && getNavigationProjectEditorApi()?.getEditorContent?.().includes('NESTED_TARGET_WORKING_TREE') === true
      const nestedLocateReady = Boolean(nestedEditorOpened) && await waitFor(
        'snj-nested-panel-root-locate-ready',
        () => readSourceReturnState('diff')?.jumpEnabled === true,
        COLD_DIFF_LOAD_BUDGET_MS
      )
      const nestedLocateTriggered = nestedLocateReady && await triggerSourceReturnJump()
      const nestedParentDiffRestored = Boolean(nestedLocateTriggered)
        && await waitForActiveSubpage('snj-nested-panel-root-return-diff', 'diff')
        && await waitFor('snj-nested-panel-root-return-state', () => {
          const api = getGitDiffApi()
          const nestedFile = api?.getFileList?.().find((file) => file.filename === nestedFilePath)
          return normalizePath(api?.getCwd?.() ?? '') === normalizePath(fixtureRoot)
            && api?.getSelectedFile?.()?.filename === nestedFilePath
            && normalizePath(nestedFile?.repoRoot ?? '') === normalizePath(nestedRepoRoot)
        }, COLD_DIFF_LOAD_BUDGET_MS)
      _assert('SNJ-DIFF-NESTED-REPO-LOCATE-PRESERVES-PARENT-PANEL', Boolean(
        nestedDiffOpened && nestedFileReady && nestedFileSelected && nestedJumped
        && nestedEditorOpened && nestedLocateReady && nestedLocateTriggered && nestedParentDiffRestored
      ), {
        nestedDiffOpened,
        nestedFileReady,
        nestedFileSelected,
        nestedJumped,
        nestedEditorOpened,
        nestedLocateReady,
        nestedLocateTriggered,
        nestedParentDiffRestored,
        cwd: getGitDiffApi()?.getCwd?.() ?? null,
        selected: getGitDiffApi()?.getSelectedFile?.() ?? null
      })

      window.dispatchEvent(new CustomEvent('project-editor:open', {
        detail: { terminalId, repoRoot: fixtureRoot, filePath: 'editor-only.md' }
      }))
      const nestedCaseEditorReset = await waitForActiveSubpage('snj-nested-panel-root-reset-editor', 'editor')
        && await waitFor('snj-nested-panel-root-reset-root', () => (
          normalizePath(getNavigationProjectEditorApi()?.getRootPath?.() ?? '') === normalizePath(fixtureRoot)
        ), COLD_DIFF_LOAD_BUDGET_MS)
        && await waitForProjectEditorFile('snj-nested-panel-root-reset-file', 'editor-only.md')
      _assert('SNJ-DIFF-NESTED-REPO-RESET-EDITOR-SCOPE', Boolean(nestedCaseEditorReset), {
        root: getNavigationProjectEditorApi()?.getRootPath?.() ?? null,
        activeFile: getNavigationProjectEditorApi()?.getActiveFilePath?.() ?? null
      })
    }
    }

    const navigationFile = navigationGroup === 'core'
      ? { kind: 'code' as const, path: 'navigate.ts' }
      : { kind: navigationGroup, path: `navigate.${navigationGroup}` }
    const navigationTrials = navigationGroup === 'core' ? 1 : 5
    const resultPrefix = `SNJ-${navigationFile.kind.toUpperCase()}`

    if (navigationGroup === 'core') {
      for (const source of getNavigationSources()) {
        const scrollResults: Array<Awaited<ReturnType<typeof runSourceScrollRoundTrip>>> = []
        for (let trial = 1; trial <= 5; trial += 1) {
          if (cancelled()) break
          const scrollResult = await runSourceScrollRoundTrip(source, trial)
          scrollResults.push(scrollResult)
          log('subpage-navigation:source-scroll-round-trip-trial', {
            source,
            trial,
            result: scrollResult
          })
        }
        _assert(`SNJ-${source.toUpperCase()}-BACK-SCROLL-5X`, (
          scrollResults.length === 5
          && scrollResults.every((result) => result.ok)
        ), {
          source,
          expectedTrials: 5,
          completedTrials: scrollResults.length,
          scrollResults
        })
      }
    }

    if (navigationGroup !== 'core') {
      for (const source of getNavigationSources()) {
        const coldResults: Array<Awaited<ReturnType<typeof runColdRichJumpRoundTrip>>> = []
        for (let trial = 1; trial <= 5; trial += 1) {
          if (cancelled()) break
          const coldResult = await runColdRichJumpRoundTrip(
            source,
            navigationGroup,
            `cold-${source}-${trial}.${navigationGroup}`,
            trial
          )
          coldResults.push(coldResult)
          log('subpage-navigation:cold-rich-jump-trial', {
            group: navigationGroup,
            source,
            trial,
            result: coldResult
          })
        }
        _assert(`${resultPrefix}-${source.toUpperCase()}-COLD-5X`, (
          coldResults.length === 5
          && coldResults.every((result) => result.ok)
        ), {
          group: navigationGroup,
          source,
          expectedTrials: 5,
          completedTrials: coldResults.length,
          coldResults
        })
      }
    }

    for (const source of getNavigationSources()) {
      const trialResults: Array<Awaited<ReturnType<typeof runWarmJumpRoundTrip>>> = []
      for (let trial = 1; trial <= navigationTrials; trial += 1) {
        if (cancelled()) break
        const trialResult = await runWarmJumpRoundTrip(
          source,
          navigationFile.kind,
          navigationFile.path,
          trial
        )
        trialResults.push(trialResult)
        log('subpage-navigation:jump-round-trip-trial', {
          group: navigationGroup,
          source,
          trial,
          result: trialResult
        })
      }

      const suffix = navigationTrials === 5 ? 'WARM-5X' : 'WARM'
      _assert(`${resultPrefix}-${source.toUpperCase()}-${suffix}`, (
        trialResults.length === navigationTrials
        && trialResults.every((result) => result.ok)
      ), {
        group: navigationGroup,
        source,
        expectedTrials: navigationTrials,
        completedTrials: trialResults.length,
        trialResults
      })
    }

    if (getGitHistoryApi()?.isOpen()) {
      dispatchEscape()
      await sleep(400)
    }
    if (getGitDiffApi()?.isOpen()) {
      dispatchEscape()
      await sleep(400)
    }

    return results
  } finally {
    try {
      const rootShellPath = platform === 'win32' ? ctx.rootPath.replace(/\//g, '\\') : ctx.rootPath
      await writeAndSyncTerminal(
        terminalId,
        buildChangeDirectoryCommand(platform, rootShellPath),
        sleep
      )
    } catch (error) {
      log('subpage-navigation:cleanup-cwd-error', { error: String(error) })
    }

    log('subpage-navigation:cleanup-owned-by-runner', { fixtureBase, fixtureRoot })
  }
}
