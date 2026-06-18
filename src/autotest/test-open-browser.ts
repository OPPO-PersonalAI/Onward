/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

import type { AutotestContext, TestResult } from './types'
import { clampAutoRefreshIntervalMs, formatAutoRefreshInterval, resolveBrowserInputToUrl } from '../utils/browser-url'
import type { BrowserScrollState } from '../types/electron'

const SENTINEL = 'OPEN_BROWSER_SENTINEL'

interface BrowserPanelDebugApi {
  getBrowserId: () => string | null
  getZoomFactor: () => number
  getViewZoomFactor: () => Promise<number | null>
  stepZoom: (direction: 'in' | 'out' | 'reset') => Promise<number>
  openUrl: (url: string) => Promise<void>
  reload: () => void
  closeKeepAlive: () => void
  evaluate: (script: string) => Promise<unknown>
  getScrollState: () => Promise<BrowserScrollState | null>
  setAutoRefresh: (intervalMs: number | null) => void
  triggerAutoRefreshTick: () => Promise<void>
  wasDestroyed: () => boolean
}

export async function testOpenBrowser(ctx: AutotestContext): Promise<TestResult[]> {
  const { assert, cancelled, sleep, waitFor, log, rootPath, terminalId } = ctx
  const results: TestResult[] = []
  const record = (name: string, ok: boolean, detail?: Record<string, unknown>) => {
    assert(name, ok, detail)
    results.push({ name, ok, detail })
  }

  const dbg = (): BrowserPanelDebugApi | undefined =>
    (window as Window & { __onwardBrowserPanelDebug?: BrowserPanelDebugApi }).__onwardBrowserPanelDebug

  const filePath = `${rootPath}/sample.html`

  const openBrowser = (url?: string) => {
    window.dispatchEvent(new CustomEvent('browser:open', { detail: { terminalId, url } }))
  }

  const evaluate = async (script: string): Promise<unknown> => {
    const api = dbg()
    if (!api) return null
    try {
      return await api.evaluate(script)
    } catch {
      return null
    }
  }

  // Local async-polling helper (ctx.waitFor only supports synchronous predicates).
  const waitForAsync = async (
    label: string,
    predicate: () => Promise<boolean>,
    timeoutMs = 5000,
    intervalMs = 100
  ): Promise<boolean> => {
    const start = performance.now()
    while (performance.now() - start < timeoutMs) {
      if (cancelled()) return false
      try {
        if (await predicate()) return true
      } catch {
        // Ignore transient errors while the view settles.
      }
      await sleep(intervalMs)
    }
    log(`${label}: timed out`)
    return false
  }

  const viewZoom = async (): Promise<number | null> => (await dbg()?.getViewZoomFactor()) ?? null
  const near = (value: number | null, target: number, tol = 0.03) =>
    typeof value === 'number' && Math.abs(value - target) <= tol

  const waitForDebugReady = (label: string, timeoutMs = 15000) =>
    waitFor(label, () => Boolean(dbg()?.getBrowserId()), timeoutMs, 100)

  const waitForDebugGone = (label: string, timeoutMs = 8000) =>
    waitFor(label, () => !dbg(), timeoutMs, 100)

  const waitForSentinel = (label: string, timeoutMs = 15000) =>
    waitForAsync(
      label,
      async () => (await evaluate(`document.getElementById('ob-sentinel')?.textContent || ''`)) === SENTINEL,
      timeoutMs,
      120
    )

  // ── OB-01: open a local HTML file from the address bar and render it ────────
  openBrowser(filePath)
  const debugReady = await waitForDebugReady('ob-debug-ready')
  const rendered = debugReady && (await waitForSentinel('ob-01-render'))
  record('OB-01-local-file-opens-and-renders', rendered, { filePath })

  if (!rendered) {
    return results // Nothing else is meaningful without a rendered view.
  }

  // ── OB-02: sibling file:// subresources (css / js / img) load (any-file) ───
  const scriptRan = await evaluate(`window.__obScriptRan === true`)
  const cssColor = await evaluate(`getComputedStyle(document.getElementById('ob-sentinel')).color`)
  const imageOk = await evaluate(
    `(() => { const i = document.getElementById('ob-image'); return !!(i && i.complete && i.naturalWidth > 0); })()`
  )
  record(
    'OB-02-sibling-subresources-load',
    scriptRan === true && cssColor === 'rgb(0, 128, 255)' && imageOk === true,
    { scriptRan, cssColor, imageOk }
  )

  // ── OB-03: plain reload keeps the page rendered ────────────────────────────
  await evaluate(`window.__obReloadMarker = 'before'; 'ok'`)
  dbg()?.reload()
  await sleep(200)
  const reRendered = await waitForSentinel('ob-03-rerender')
  const markerGoneAfterReload = (await evaluate(`window.__obReloadMarker || ''`)) === ''
  record('OB-03-reload-keeps-rendered', reRendered && markerGoneAfterReload, { reRendered, markerGoneAfterReload })

  // ── OB-04 / OB-05: address-bar resolver scheme rules (in-process) ──────────
  const posix = resolveBrowserInputToUrl('/Users/me/a.html')
  const windows = resolveBrowserInputToUrl('C:\\x\\a.html')
  record('OB-04-local-path-resolves-to-file-url', posix === 'file:///Users/me/a.html' && windows === 'file:///C:/x/a.html', {
    posix,
    windows
  })

  const localhostHttp = resolveBrowserInputToUrl('localhost:3000/x') === 'http://localhost:3000/x'
  const ipHttp = resolveBrowserInputToUrl('127.0.0.1:8080') === 'http://127.0.0.1:8080/'
  const domainHttps = resolveBrowserInputToUrl('example.com') === 'https://example.com/'
  record('OB-05-host-scheme-rules', localhostHttp && ipHttp && domainHttps, { localhostHttp, ipHttp, domainHttps })

  // ── OB-06 / OB-07 / OB-08: zoom in / reset / out via the toolbar API ───────
  await dbg()?.stepZoom('reset')
  await waitForAsync('ob-zoom-reset-baseline', async () => near(await viewZoom(), 1), 5000)

  await dbg()?.stepZoom('in')
  const zoomedIn = await waitForAsync('ob-06-zoom-in', async () => near(await viewZoom(), 1.1), 5000)
  record('OB-06-zoom-in', zoomedIn, { viewZoom: await viewZoom() })

  await dbg()?.stepZoom('reset')
  const zoomReset = await waitForAsync('ob-07-zoom-reset', async () => near(await viewZoom(), 1), 5000)
  record('OB-07-zoom-reset', zoomReset, { viewZoom: await viewZoom() })

  await dbg()?.stepZoom('out')
  const zoomedOut = await waitForAsync('ob-08-zoom-out', async () => near(await viewZoom(), 0.9), 5000)
  // Renderer toolbar state should mirror the view (onZoomFactorChanged / setZoomFactor return).
  const rendererSync = near(dbg()?.getZoomFactor() ?? null, 0.9)
  record('OB-08-zoom-out-and-renderer-sync', zoomedOut && rendererSync, {
    viewZoom: await viewZoom(),
    rendererZoom: dbg()?.getZoomFactor()
  })
  await dbg()?.stepZoom('reset')

  // ── OB-09: keep-alive close — reopen reattaches the SAME view (marker+scroll+zoom) ──
  // closeKeepAlive() is the exact onClose path that Esc (useSubpageEscape) and toggle-off
  // invoke; driving it directly avoids racing the document-level Esc listener (which is gated
  // on the terminal being active — an autotest-environment quirk, not product behavior).
  await evaluate(`window.scrollTo(0, 500); window.__obKeepAlive = 'kept'; 'ok'`)
  await dbg()?.stepZoom('in') // move zoom off default so we can detect preservation
  await waitForAsync('ob-keepalive-zoom-set', async () => near(await viewZoom(), 1.1), 5000)

  dbg()?.closeKeepAlive()
  const closedKeepAlive = await waitForDebugGone('ob-keepalive-hide')
  openBrowser() // reopen without a URL → reattach the cached view
  const reopenedAfterKeepAlive = await waitForDebugReady('ob-keepalive-reopen')
  await sleep(200)
  const keptMarker = (await evaluate(`window.__obKeepAlive || ''`)) === 'kept'
  const keptScroll = ((await dbg()?.getScrollState())?.y ?? 0) >= 400
  const keptZoom = near(await viewZoom(), 1.1)
  record(
    'OB-09-keep-alive-close-preserves-state',
    closedKeepAlive && reopenedAfterKeepAlive && keptMarker && keptScroll && keptZoom,
    { closedKeepAlive, reopenedAfterKeepAlive, keptMarker, keptScroll, keptZoom }
  )

  // ── OB-10: ✕ destroys the view — reopen is a FRESH page (marker gone) ───────
  await evaluate(`window.__obKeepAlive = 'stillHere'; 'ok'`)
  const closeBtn = document.querySelector<HTMLButtonElement>('.browser-panel-cell .browser-panel-nav-btn.close-btn')
  closeBtn?.click()
  const closedByX = await waitForDebugGone('ob-x-destroy')
  openBrowser(filePath) // reopen → no cached view → fresh create + load
  const reopenedAfterX = await waitForDebugReady('ob-x-reopen')
  const freshRendered = reopenedAfterX && (await waitForSentinel('ob-x-fresh-render'))
  const markerGoneAfterDestroy = (await evaluate(`window.__obKeepAlive || ''`)) === ''
  record(
    'OB-10-close-button-destroys-view',
    Boolean(closeBtn) && closedByX && freshRendered && markerGoneAfterDestroy,
    { hasCloseBtn: Boolean(closeBtn), closedByX, freshRendered, markerGoneAfterDestroy }
  )

  // ── OB-11: auto-refresh tick reloads and restores scroll position ──────────
  await evaluate(`window.scrollTo(0, 600); window.__obTickMarker = 'before'; 'ok'`)
  await sleep(120)
  await dbg()?.triggerAutoRefreshTick()
  const tickReloaded = await waitForAsync(
    'ob-11-tick-reload',
    async () => (await evaluate(`window.__obTickMarker || ''`)) === '',
    8000,
    150
  )
  const scrollRestored = await waitForAsync(
    'ob-11-scroll-restore',
    async () => ((await dbg()?.getScrollState())?.y ?? 0) >= 400,
    8000,
    150
  )
  record('OB-11-auto-refresh-tick-restores-scroll', tickReloaded && scrollRestored, {
    scrollAfterTick: (await dbg()?.getScrollState())?.y ?? 0
  })

  // ── OB-12: native-menu trigger button + interval state round-trip + clamp ──
  // The native Menu.popup can't be scripted from the renderer, so we drive the per-terminal
  // interval through the debug bridge (same onAutoRefreshChange the menu calls) and assert the
  // toolbar badge reflects it, plus the pure clamp/format helpers.
  const refreshBtn = document.querySelector<HTMLButtonElement>('.browser-panel-auto-refresh-btn')
  dbg()?.setAutoRefresh(5000)
  const badgeShown = await waitFor(
    'ob-12-badge-shown',
    () => document.querySelector('.browser-panel-auto-refresh-badge')?.textContent === '5s',
    3000,
    80
  )
  dbg()?.setAutoRefresh(null)
  const badgeCleared = await waitFor(
    'ob-12-badge-cleared',
    () => !document.querySelector('.browser-panel-auto-refresh-badge'),
    3000,
    80
  )
  const helpersOk =
    clampAutoRefreshIntervalMs(1000) === 5000 &&
    clampAutoRefreshIntervalMs(null) === null &&
    formatAutoRefreshInterval(30000) === '30s' &&
    formatAutoRefreshInterval(300000) === '5m'
  record('OB-12-auto-refresh-control', Boolean(refreshBtn) && badgeShown && badgeCleared && helpersOk, {
    hasButton: Boolean(refreshBtn),
    badgeShown,
    badgeCleared,
    helpersOk
  })

  return results
}
