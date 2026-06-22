/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

import type { AutotestContext, TestResult } from './types'
import { buildChangeDirectoryCommand, type TerminalShellKind } from '../utils/terminal-command'

function normalizePath(value: string): string {
  return value.replace(/\\/g, '/').replace(/\/+$/, '')
}

const FIXTURE_FILE = 'test/autotest/fixtures/preview-search-complex.md'
const SEARCH_KEYWORD = 'system'
const SCROLL_SETTLE_MS = 600
const CENTERING_TOLERANCE = 0.22
const MIN_EXPECTED_MATCHES = 20
const NAV_STRIDE = 5
const MAX_NEXT_CHECKPOINTS = 8
const INTER_NAV_MS = 60

async function resolveTerminalShellKind(terminalId: string): Promise<TerminalShellKind | undefined> {
  try {
    return (await window.electronAPI.terminal.getInputCapabilities(terminalId)).shellKind
  } catch {
    return undefined
  }
}

function isCenteringAcceptable(
  activeCenter: { offset: number; containerHeight: number } | null,
  scrollTop: number,
  scrollHeight: number,
  clientHeight: number,
): { acceptable: boolean; reason: string; ratio: number } {
  if (!activeCenter) return { acceptable: false, reason: 'no-active-mark', ratio: 1 }
  const ratio = Math.abs(activeCenter.offset) / activeCenter.containerHeight
  if (ratio <= CENTERING_TOLERANCE) return { acceptable: true, reason: 'within-tolerance', ratio }
  // Boundary exemption: near top/bottom of document, perfect centering is impossible
  const boundaryMargin = Math.max(50, scrollHeight * 0.05)
  const nearTop = scrollTop < boundaryMargin
  const nearBottom = scrollTop >= scrollHeight - clientHeight - boundaryMargin
  if (nearTop || nearBottom) {
    return { acceptable: true, reason: nearTop ? 'near-top-boundary' : 'near-bottom-boundary', ratio }
  }
  return { acceptable: false, reason: 'exceeds-tolerance', ratio }
}

export async function testPreviewSearch(ctx: AutotestContext): Promise<TestResult[]> {
  const { log, sleep, assert, cancelled, waitFor, reopenProjectEditor, rootPath, terminalId } = ctx
  const results: TestResult[] = []
  const record = (name: string, ok: boolean, detail?: Record<string, unknown>) => {
    assert(name, ok, detail)
    results.push({ name, ok, detail })
  }

  // Tracking stats for PS-12
  let totalNavigations = 0
  let maxCenteringOffset = 0
  let orderingViolations = 0

  // ----------------------------------------------------------------
  // PS-01: API availability
  // ----------------------------------------------------------------
  const api = window.__onwardProjectEditorDebug
  if (!api) {
    record('PS-01-api-available', false, { error: 'debug api not found' })
    return results
  }

  const requiredMethods = [
    'setPreviewSearchOpen',
    'isPreviewSearchOpen',
    'previewSearchSetQuery',
    'previewSearchGoToNext',
    'previewSearchGoToPrevious',
    'getPreviewSearchMatchCount',
    'getPreviewSearchCurrentIndex',
    'getPreviewSearchMatchPositions',
    'getPreviewSearchActiveCenter',
  ] as const

  const missingMethods = requiredMethods.filter(m => typeof (api as unknown as Record<string, unknown>)[m] !== 'function')
  record('PS-01-api-available', missingMethods.length === 0, {
    missing: missingMethods,
    available: requiredMethods.length - missingMethods.length,
  })
  if (missingMethods.length > 0) return results
  if (cancelled()) return results

  const fixtureRootPath = window.electronAPI.debug.autotestCwd || rootPath
  if (normalizePath(api.getRootPath?.() ?? '') !== normalizePath(fixtureRootPath)) {
    const shellKind = await resolveTerminalShellKind(terminalId)
    const cdCommand = buildChangeDirectoryCommand(window.electronAPI.platform, fixtureRootPath, shellKind)
    await window.electronAPI.terminal.write(terminalId, cdCommand)
    await sleep(500)
    await window.electronAPI.git.notifyTerminalActivity(terminalId)
    await sleep(500)
    await reopenProjectEditor('preview-search-root')
    const rootReady = await waitFor('PS-01-root-ready', () => {
      return normalizePath(window.__onwardProjectEditorDebug?.getRootPath?.() ?? '') === normalizePath(fixtureRootPath)
    }, 8000, 120)
    record('PS-01-root-ready', rootReady, {
      expectedRoot: fixtureRootPath,
      actualRoot: window.__onwardProjectEditorDebug?.getRootPath?.() ?? null
    })
    if (!rootReady || cancelled()) return results
  }

  // ----------------------------------------------------------------
  // PS-02: Open fixture and search bar
  // ----------------------------------------------------------------
  log('PS-02:opening-fixture', { file: FIXTURE_FILE })
  await api.openFileByPath(FIXTURE_FILE)

  // Wait for markdown rendering
  const renderReady = await waitFor('PS-02-render', () => {
    return !api.isMarkdownRenderPending() && api.getMarkdownRenderedHtml().length > 500
  }, 15000, 120)
  record('PS-02-render-complete', renderReady)
  if (!renderReady || cancelled()) return results

  // Wait for mermaid diagrams to finish rendering
  await sleep(3000)

  // Ensure preview is visible and search is open
  api.setMarkdownPreviewVisible?.(true)
  await sleep(300)
  const markdownPreviewHeaderTexts = Array.from(document.querySelectorAll<HTMLElement>('.project-editor-preview-header-main span'))
    .map((node) => node.textContent?.trim() ?? '')
  record('PS-02a-markdown-preview-title-case', markdownPreviewHeaderTexts.includes('Markdown Preview'), {
    headerTexts: markdownPreviewHeaderTexts,
  })
  if (cancelled()) return results

  const markdownPaneBeforeResize = document.querySelector<HTMLElement>('.project-editor-preview-pane')
  const markdownResizer = document.querySelector<HTMLElement>('.project-editor-preview-resizer')
  const markdownBeforeResizeWidth = markdownPaneBeforeResize?.getBoundingClientRect().width ?? 0
  if (markdownResizer) {
    const rect = markdownResizer.getBoundingClientRect()
    const startX = rect.left + rect.width / 2
    markdownResizer.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, clientX: startX }))
    document.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, cancelable: true, clientX: startX + 90 }))
    document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, clientX: startX + 90 }))
  }
  await sleep(250)
  const markdownPaneAfterResize = document.querySelector<HTMLElement>('.project-editor-preview-pane')
  const markdownAfterResizeWidth = markdownPaneAfterResize?.getBoundingClientRect().width ?? 0
  record('PS-02b-markdown-preview-resizer-drags', Boolean(
    markdownResizer &&
    markdownBeforeResizeWidth > 0 &&
    Math.abs(markdownAfterResizeWidth - markdownBeforeResizeWidth) >= 20
  ), {
    hasResizer: Boolean(markdownResizer),
    beforeResizeWidth: markdownBeforeResizeWidth,
    afterResizeWidth: markdownAfterResizeWidth,
  })
  if (cancelled()) return results

  api.setPreviewSearchOpen!(true)

  const searchOpen = await waitFor('PS-02-search-open', () => {
    return api.isPreviewSearchOpen!()
  }, 3000, 80)
  record('PS-02-search-open', searchOpen)
  if (!searchOpen || cancelled()) return results

  // ----------------------------------------------------------------
  // PS-03: Execute search and verify matches
  // ----------------------------------------------------------------
  api.previewSearchSetQuery!(SEARCH_KEYWORD)
  await sleep(300) // debounce (150ms) + margin

  const hasMatches = await waitFor('PS-03-matches', () => {
    return api.getPreviewSearchMatchCount!() >= MIN_EXPECTED_MATCHES
  }, 5000, 80)

  const matchCount = api.getPreviewSearchMatchCount!()
  record('PS-03-match-count', hasMatches, {
    matchCount,
    expected: `>= ${MIN_EXPECTED_MATCHES}`,
    keyword: SEARCH_KEYWORD,
  })
  if (!hasMatches || cancelled()) return results
  log('PS-03:matches-found', { matchCount })

  // ----------------------------------------------------------------
  // PS-04: Verify visual ordering
  // ----------------------------------------------------------------
  await sleep(SCROLL_SETTLE_MS) // wait for initial scroll to settle

  const positions = api.getPreviewSearchMatchPositions!()
  let posOrderViolations = 0
  for (let i = 1; i < positions.length; i++) {
    if (positions[i].top < positions[i - 1].top - 2) {
      posOrderViolations++
      if (posOrderViolations <= 3) {
        log('PS-04:order-violation', {
          index: i,
          prevTop: Math.round(positions[i - 1].top),
          currTop: Math.round(positions[i].top),
        })
      }
    }
  }
  orderingViolations += posOrderViolations
  record('PS-04-visual-ordering', posOrderViolations === 0, {
    totalMarks: positions.length,
    violations: posOrderViolations,
  })
  if (cancelled()) return results

  // ----------------------------------------------------------------
  // PS-05: Initial match centered
  // ----------------------------------------------------------------
  const initialCenter = api.getPreviewSearchActiveCenter!()
  const initialIndex = api.getPreviewSearchCurrentIndex!()
  const preview = document.querySelector('.project-editor-preview-body') as HTMLElement | null
  const scrollTop0 = preview?.scrollTop ?? 0
  const scrollHeight0 = preview?.scrollHeight ?? 0
  const clientHeight0 = preview?.clientHeight ?? 0

  const initialCentering = isCenteringAcceptable(
    initialCenter, scrollTop0, scrollHeight0, clientHeight0,
  )
  if (initialCentering.ratio > maxCenteringOffset) maxCenteringOffset = initialCentering.ratio

  record('PS-05-initial-centered', initialCentering.acceptable, {
    index: initialIndex,
    offset: initialCenter ? Math.round(initialCenter.offset) : null,
    ratio: Number(initialCentering.ratio.toFixed(3)),
    reason: initialCentering.reason,
    containerHeight: initialCenter?.containerHeight,
  })
  if (cancelled()) return results

  // ----------------------------------------------------------------
  // PS-06 + PS-07: Navigate next with stride sampling, verify ordering and centering
  // ----------------------------------------------------------------
  let prevActiveTop = positions.length > 0 ? positions[0].top : 0
  let nextOrderViolations = 0
  let nextCenterViolations = 0
  const totalSteps = Math.min(matchCount - 1, NAV_STRIDE * MAX_NEXT_CHECKPOINTS)
  const checkpoints = Math.ceil(totalSteps / NAV_STRIDE)

  log('PS-06:begin-next-traversal', { totalSteps, stride: NAV_STRIDE, checkpoints })

  for (let cp = 0; cp < checkpoints; cp++) {
    if (cancelled()) break
    const stepsThisRound = Math.min(NAV_STRIDE, totalSteps - cp * NAV_STRIDE)

    // Navigate `stepsThisRound` times quickly, then settle on the last one
    for (let s = 0; s < stepsThisRound; s++) {
      api.previewSearchGoToNext!()
      totalNavigations++
      if (s < stepsThisRound - 1) await sleep(INTER_NAV_MS)
    }
    await sleep(SCROLL_SETTLE_MS)

    const currentIdx = api.getPreviewSearchCurrentIndex!()

    // Find active mark position
    const activePos = api.getPreviewSearchMatchPositions!().find(p => p.isActive)
    if (activePos) {
      if (activePos.top < prevActiveTop - 2) {
        nextOrderViolations++
        if (nextOrderViolations <= 3) {
          log('PS-06:next-order-violation', {
            checkpoint: cp,
            index: currentIdx,
            prevTop: Math.round(prevActiveTop),
            activeTop: Math.round(activePos.top),
          })
        }
      }
      prevActiveTop = activePos.top
    }

    // Centering check
    const center = api.getPreviewSearchActiveCenter!()
    const st = preview?.scrollTop ?? 0
    const sh = preview?.scrollHeight ?? 0
    const ch = preview?.clientHeight ?? 0
    const centering = isCenteringAcceptable(center, st, sh, ch)
    if (centering.ratio > maxCenteringOffset) maxCenteringOffset = centering.ratio
    if (!centering.acceptable) {
      nextCenterViolations++
      if (nextCenterViolations <= 3) {
        log('PS-07:center-violation', {
          checkpoint: cp,
          index: currentIdx,
          offset: center ? Math.round(center.offset) : null,
          ratio: Number(centering.ratio.toFixed(3)),
          reason: centering.reason,
        })
      }
    }

    // Progress logging
    if ((cp + 1) % 5 === 0 || cp === checkpoints - 1) {
      log('PS-06:progress', {
        checkpoint: cp + 1,
        total: checkpoints,
        navigated: (cp + 1) * NAV_STRIDE,
        orderViolations: nextOrderViolations,
        centerViolations: nextCenterViolations,
      })
    }
  }

  orderingViolations += nextOrderViolations
  record('PS-06-next-ordering', nextOrderViolations === 0, {
    steps: totalSteps,
    checkpoints,
    violations: nextOrderViolations,
  })
  record('PS-07-next-centering', nextCenterViolations === 0, {
    steps: totalSteps,
    checkpoints,
    violations: nextCenterViolations,
    maxOffset: Number(maxCenteringOffset.toFixed(3)),
  })
  if (cancelled()) return results

  // ----------------------------------------------------------------
  // PS-08 + PS-09: Navigate previous, verify ordering and centering
  // ----------------------------------------------------------------
  const prevSteps = Math.min(10, matchCount - 1)
  let prevOrderViolations = 0
  let prevCenterViolations = 0

  // Current position after PS-06 loop (should be at last match)
  let prevNavTop = prevActiveTop

  log('PS-08:begin-prev-traversal', { steps: prevSteps })

  for (let step = 0; step < prevSteps; step++) {
    if (cancelled()) break

    api.previewSearchGoToPrevious!()
    totalNavigations++
    await sleep(SCROLL_SETTLE_MS)

    const activePos = api.getPreviewSearchMatchPositions!().find(p => p.isActive)
    if (activePos) {
      if (activePos.top > prevNavTop + 2) {
        prevOrderViolations++
        if (prevOrderViolations <= 3) {
          log('PS-08:prev-order-violation', {
            step,
            prevTop: Math.round(prevNavTop),
            activeTop: Math.round(activePos.top),
          })
        }
      }
      prevNavTop = activePos.top
    }

    // Centering check
    const center = api.getPreviewSearchActiveCenter!()
    const st = preview?.scrollTop ?? 0
    const sh = preview?.scrollHeight ?? 0
    const ch = preview?.clientHeight ?? 0
    const centering = isCenteringAcceptable(center, st, sh, ch)
    if (centering.ratio > maxCenteringOffset) maxCenteringOffset = centering.ratio
    if (!centering.acceptable) {
      prevCenterViolations++
    }
  }

  orderingViolations += prevOrderViolations
  record('PS-08-prev-ordering', prevOrderViolations === 0, {
    steps: prevSteps,
    violations: prevOrderViolations,
  })
  record('PS-09-prev-centering', prevCenterViolations === 0, {
    steps: prevSteps,
    violations: prevCenterViolations,
  })
  if (cancelled()) return results

  // ----------------------------------------------------------------
  // PS-10: Wrap-around test
  // ----------------------------------------------------------------
  // Navigate to last match (should already be there or very close after PS-06 + PS-08)
  let wrapGuard = 0
  while (api.getPreviewSearchCurrentIndex!() !== matchCount - 1 && wrapGuard < matchCount) {
    api.previewSearchGoToNext!()
    totalNavigations++
    wrapGuard++
  }
  await sleep(SCROLL_SETTLE_MS)

  // One more next should wrap to index 0
  api.previewSearchGoToNext!()
  totalNavigations++
  await sleep(SCROLL_SETTLE_MS)

  const wrappedIndex = api.getPreviewSearchCurrentIndex!()
  record('PS-10-wrap-around', wrappedIndex === 0, {
    expectedIndex: 0,
    actualIndex: wrappedIndex,
    matchCount,
  })
  if (cancelled()) return results

  // ----------------------------------------------------------------
  // PS-11: Close via the visible X button, verify cleanup and no native title tooltip
  // ----------------------------------------------------------------
  api.setPreviewSearchOpen!(true)
  await sleep(200)
  api.previewSearchSetQuery!(SEARCH_KEYWORD)
  await sleep(300)
  const closeButton = document.querySelector<HTMLButtonElement>('.preview-search-close-btn')
  const closeButtonTitle = closeButton?.getAttribute('title') ?? null
  const closeButtonAria = closeButton?.getAttribute('aria-label') ?? null
  closeButton?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }))
  await sleep(350)
  const closeButtonClosed = !api.isPreviewSearchOpen!()
  record('PS-11-close-button-closes-cleanly', Boolean(
    closeButton &&
    closeButtonClosed &&
    closeButtonTitle === null &&
    !/esc|escape/i.test(closeButtonAria ?? '')
  ), {
    hadCloseButton: Boolean(closeButton),
    closeButtonClosed,
    closeButtonTitle,
    closeButtonAria,
  })
  if (cancelled()) return results

  // ----------------------------------------------------------------
  // PS-11b: Close through debug API, verify cleanup
  // ----------------------------------------------------------------
  api.setPreviewSearchOpen!(true)
  await sleep(200)
  api.previewSearchSetQuery!(SEARCH_KEYWORD)
  await sleep(300)
  api.setPreviewSearchOpen!(false)
  await sleep(300)

  const searchClosed = !api.isPreviewSearchOpen!()
  const matchCountAfterClose = api.getPreviewSearchMatchCount!()
  const indexAfterClose = api.getPreviewSearchCurrentIndex!()
  const remainingMarks = preview?.querySelectorAll('mark.preview-search-highlight').length ?? -1

  record('PS-11b-close-cleanup', searchClosed && matchCountAfterClose === 0 && indexAfterClose === -1 && remainingMarks === 0, {
    searchClosed,
    matchCountAfterClose,
    indexAfterClose,
    remainingMarks,
  })

  // ----------------------------------------------------------------
  // PS-12: Summary stats (informational, always passes)
  // ----------------------------------------------------------------
  record('PS-12-summary', true, {
    totalNavigations,
    matchCount,
    maxCenteringOffset: Number(maxCenteringOffset.toFixed(3)),
    orderingViolations,
    searchKeyword: SEARCH_KEYWORD,
  })

  log('PS-12:summary', {
    totalNavigations,
    matchCount,
    maxCenteringOffset: Number(maxCenteringOffset.toFixed(3)),
    orderingViolations,
  })

  return results
}
