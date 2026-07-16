/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

import type { AutotestContext, ChangeLogDebugApi, TestResult } from './types'

const EXPECTED_MARKDOWN_SNIPPET = 'Autotest fixture feature appears in the change log.'

function queryChangeLogButton(): HTMLButtonElement | null {
  return document.querySelector('[data-testid="sidebar-change-log-button"]') as HTMLButtonElement | null
}

export async function testChangeLog(ctx: AutotestContext): Promise<TestResult[]> {
  const { assert, cancelled, log, waitFor } = ctx
  const results: TestResult[] = []
  const record = (name: string, ok: boolean, detail?: Record<string, unknown>) => {
    assert(name, ok, detail)
    results.push({ name, ok, detail })
  }

  const getApi = () => window.__onwardChangeLogDebug as ChangeLogDebugApi | undefined

  const openChangeLog = async () => {
    if (getApi()?.isOpen()) return true
    const button = queryChangeLogButton()
    if (!button) return false
    button.click()
    return await waitFor('change-log-open', () => Boolean(getApi()?.isOpen()), 4000, 50)
  }

  const waitUntilLoaded = async () => {
    return await waitFor('change-log-loaded', () => {
      const api = getApi()
      return Boolean(api?.isOpen() && !api.isLoading())
    }, 4000, 50)
  }

  const closeChangeLog = async (label: string, closeAction: () => boolean) => {
    if (!getApi()?.isOpen()) return true
    const triggered = closeAction()
    if (!triggered) return false
    return await waitFor(label, () => !getApi()?.isOpen(), 4000, 50)
  }

  log('change-log:start')

  try {
    const debugApiReady = await waitFor('change-log-debug-api', () => Boolean(getApi()), 4000, 50)
    record('CL-00-debug-api-available', debugApiReady, {
      available: Boolean(getApi())
    })

    const button = queryChangeLogButton()
    record('CL-01-sidebar-button-visible', Boolean(button), {
      found: Boolean(button)
    })
    if (!button || cancelled()) {
      return results
    }

    const englishPayload = await window.electronAPI.changelog.getCurrent('en')
    record('CL-02-prefetched-entry-exposes-precompiled-html', englishPayload.success === true &&
      (englishPayload.html?.includes(EXPECTED_MARKDOWN_SNIPPET) ?? false), {
      success: englishPayload.success,
      tag: englishPayload.tag,
      hasHtml: Boolean(englishPayload.html),
      hasMarkdownFallback: Boolean(englishPayload.content)
    })
    if (cancelled()) {
      return results
    }

    const zhFallback = await window.electronAPI.changelog.getCurrent('zh-CN')
    record('CL-03-zh-cn-request-falls-back-to-english-html', zhFallback.success === true &&
      ((zhFallback.html ?? zhFallback.content)?.includes(EXPECTED_MARKDOWN_SNIPPET) ?? false), {
      success: zhFallback.success,
      locale: zhFallback.locale,
      tag: zhFallback.tag,
      hasHtml: Boolean(zhFallback.html),
      contentPreview: (zhFallback.html ?? zhFallback.content)?.slice(0, 120) ?? null
    })
    if (cancelled()) {
      return results
    }

    const opened = await openChangeLog()
    record('CL-04-open-from-sidebar', opened, {
      open: getApi()?.isOpen() ?? false
    })
    if (!opened || cancelled()) {
      return results
    }

    const loaded = await waitUntilLoaded()
    const api = getApi()
    const renderedText = api?.getRenderedText() ?? ''
    const unavailableState = api?.getUnavailableState()
    record('CL-05-loads-current-version-content', loaded && unavailableState?.visible !== true, {
      isLoading: api?.isLoading() ?? true,
      unavailable: unavailableState?.visible ?? false,
      currentTag: api?.getCurrentTag() ?? null
    })
    record('CL-06-renders-english-markdown-even-under-zh-cn-ui', renderedText.includes('New Features') &&
      renderedText.includes('Bug Fixes') &&
      renderedText.includes(EXPECTED_MARKDOWN_SNIPPET), {
      currentTag: api?.getCurrentTag() ?? null,
      renderedText
    })
    if (cancelled()) {
      return results
    }

    const closedByButton = await closeChangeLog('change-log-close-button', () => getApi()?.clickCloseButton() ?? false)
    record('CL-07-close-button-closes-modal', closedByButton, {
      openAfterClose: getApi()?.isOpen() ?? false
    })
    if (cancelled()) {
      return results
    }

    const reopenedForOverlay = await openChangeLog()
    record('CL-08-reopen-after-close', reopenedForOverlay, {
      open: getApi()?.isOpen() ?? false
    })
    // Unified modal dismiss policy: backdrop clicks are inert — the modal
    // must STAY open after an overlay click (was CL-09-overlay-closes-modal
    // before the 2026-07-16 policy change).
    let overlayKeptOpen = false
    if (reopenedForOverlay) {
      const overlayClicked = getApi()?.clickOverlay() ?? false
      if (overlayClicked) {
        // Give a would-be close handler a beat to run, then require open.
        await new Promise((resolve) => setTimeout(resolve, 300))
        overlayKeptOpen = getApi()?.isOpen() ?? false
      }
    }
    record('CL-09-overlay-click-keeps-modal-open', overlayKeptOpen, {
      openAfterOverlayClick: getApi()?.isOpen() ?? false
    })
    if (cancelled()) {
      return results
    }
    // Close via the explicit button before the ESC scenario re-opens it.
    const closedAfterOverlay = await closeChangeLog('change-log-close-after-overlay', () => getApi()?.clickCloseButton() ?? false)
    record('CL-09b-close-button-still-works-after-overlay-click', closedAfterOverlay, {
      openAfterClose: getApi()?.isOpen() ?? false
    })
    if (cancelled()) {
      return results
    }

    const reopenedForEscape = await openChangeLog()
    record('CL-10-reopen-for-escape', reopenedForEscape, {
      open: getApi()?.isOpen() ?? false
    })
    const closedByEscape = reopenedForEscape
      ? await closeChangeLog('change-log-close-escape', () => getApi()?.pressEscape() ?? false)
      : false
    record('CL-11-escape-closes-modal', closedByEscape, {
      openAfterClose: getApi()?.isOpen() ?? false
    })
  } finally {
    if (getApi()?.isOpen()) {
      await closeChangeLog('change-log-cleanup-close', () => getApi()?.clickCloseButton() ?? false).catch(() => {})
    }
  }

  return results
}
