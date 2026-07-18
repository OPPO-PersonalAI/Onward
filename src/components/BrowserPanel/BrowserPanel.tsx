/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { useI18n } from '../../i18n/useI18n'
import { useSubpageEscape } from '../../hooks/useSubpageEscape'
import { perfTrace } from '../../utils/perf-trace'
import { PERF_TRACE_EVENT } from '../../utils/perf-trace-names'
import { trackFeatureUse } from '../../telemetry/track-feature-use'
import {
  formatHtmlPreviewZoomPercent,
  HTML_PREVIEW_MAX_ZOOM_FACTOR,
  HTML_PREVIEW_MIN_ZOOM_FACTOR,
  stepHtmlPreviewZoomFactor
} from '../../utils/html-file'
import {
  AUTO_REFRESH_PRESETS_MS,
  clampAutoRefreshIntervalMs,
  formatAutoRefreshInterval,
  resolveBrowserInputToUrl
} from '../../utils/browser-url'
import type { BrowserScrollState } from '../../types/electron'
import { BrowserAutoRefreshIcon, BrowserRefreshIcon } from '../BrowserToolbarIcons'
import './BrowserPanel.css'

interface BrowserPanelProps {
  isOpen: boolean
  onClose: () => void
  terminalId: string
  initialUrl?: string | null
  onUrlChange?: (url: string) => void
  forceHidden?: boolean
  isActive?: boolean
  autoRefreshIntervalMs?: number | null
  onAutoRefreshChange?: (next: number | null) => void
}

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

let sharedRememberCookies = true
const rememberCookiesSubscribers = new Set<(rememberCookies: boolean) => void>()

function subscribeRememberCookies(callback: (rememberCookies: boolean) => void): () => void {
  rememberCookiesSubscribers.add(callback)
  return () => rememberCookiesSubscribers.delete(callback)
}

function updateSharedRememberCookies(next: boolean): void {
  sharedRememberCookies = next
  for (const callback of rememberCookiesSubscribers) callback(next)
}

function readScrollScript(): string {
  return `(() => {
    const doc = document.documentElement;
    const body = document.body;
    return {
      x: window.scrollX || doc.scrollLeft || (body ? body.scrollLeft : 0) || 0,
      y: window.scrollY || doc.scrollTop || (body ? body.scrollTop : 0) || 0,
      scrollWidth: Math.max(doc.scrollWidth || 0, body ? body.scrollWidth || 0 : 0),
      scrollHeight: Math.max(doc.scrollHeight || 0, body ? body.scrollHeight || 0 : 0),
      clientWidth: doc.clientWidth || window.innerWidth || 0,
      clientHeight: doc.clientHeight || window.innerHeight || 0
    };
  })()`
}

export function BrowserPanel({
  isOpen,
  onClose,
  terminalId,
  initialUrl,
  onUrlChange,
  forceHidden = false,
  isActive = true,
  autoRefreshIntervalMs = null,
  onAutoRefreshChange
}: BrowserPanelProps) {
  const { t } = useI18n()
  const [url, setUrl] = useState('')
  const [inputUrl, setInputUrl] = useState('')
  const [title, setTitle] = useState('')
  const [isLoading, setIsLoading] = useState(false)
  const [canGoBack, setCanGoBack] = useState(false)
  const [canGoForward, setCanGoForward] = useState(false)
  const [isFullscreen, setIsFullscreen] = useState(false)
  const [isViewReady, setIsViewReady] = useState(false)
  const [hasVisibleView, setHasVisibleView] = useState(false)
  const [rememberCookies, setRememberCookies] = useState(sharedRememberCookies)
  const [zoomFactor, setZoomFactor] = useState(1)

  const hostRef = useRef<HTMLDivElement>(null)
  const urlInputRef = useRef<HTMLInputElement>(null)
  const webviewRef = useRef<Electron.WebviewTag | null>(null)
  const browserIdRef = useRef<string | null>(null)
  const isLoadingRef = useRef(false)
  const zoomFactorRef = useRef(1)
  const onUrlChangeRef = useRef(onUrlChange)
  const pendingScrollRestoreRef = useRef<BrowserScrollState | null>(null)
  const wasDestroyedRef = useRef(false)

  useSubpageEscape({ isOpen: isOpen && !forceHidden && isActive, onEscape: onClose })

  useEffect(() => {
    setRememberCookies(sharedRememberCookies)
    return subscribeRememberCookies(setRememberCookies)
  }, [])

  useEffect(() => {
    isLoadingRef.current = isLoading
  }, [isLoading])

  useEffect(() => {
    onUrlChangeRef.current = onUrlChange
  }, [onUrlChange])

  const syncNavState = useCallback((webview: Electron.WebviewTag) => {
    try {
      setCanGoBack(webview.canGoBack())
      setCanGoForward(webview.canGoForward())
    } catch {
      setCanGoBack(false)
      setCanGoForward(false)
    }
  }, [])

  const syncUrlState = useCallback((webview: Electron.WebviewTag, nextUrl?: string) => {
    let resolvedUrl = nextUrl ?? ''
    try {
      resolvedUrl ||= webview.getURL()
    } catch {
      // The guest may still be attaching.
    }
    setUrl(resolvedUrl)
    setInputUrl(resolvedUrl === 'about:blank' ? '' : resolvedUrl)
    onUrlChangeRef.current?.(resolvedUrl === 'about:blank' ? '' : resolvedUrl)
    setHasVisibleView(Boolean(resolvedUrl && resolvedUrl !== 'about:blank'))
    syncNavState(webview)
  }, [syncNavState])

  const attachWebview = useCallback((startUrl: string) => {
    const host = hostRef.current
    if (!host || webviewRef.current) return webviewRef.current
    if (window.electronAPI.debug.autotest) console.log('[BrowserPanel] attach-start', { startUrl, hasHost: Boolean(host) })

    const webview = document.createElement('webview')
    webview.className = 'browser-panel-webview'
    webview.setAttribute('partition', 'persist:browser')
    webview.setAttribute('webpreferences', 'contextIsolation=yes,sandbox=yes,nodeIntegration=no,webSecurity=yes')
    webview.setAttribute('src', 'about:blank')

    const handleReady = () => {
      if (webviewRef.current !== webview) return
      const currentUrl = webview.getURL()
      if (startUrl && currentUrl === 'about:blank') {
        webview.src = startUrl
        return
      }
      if (window.electronAPI.debug.autotest) console.log('[BrowserPanel] guest-ready', { url: currentUrl })
      setIsViewReady(true)
      syncUrlState(webview)
      try {
        const nextZoom = webview.getZoomFactor()
        zoomFactorRef.current = nextZoom
        setZoomFactor(nextZoom)
      } catch {
        zoomFactorRef.current = 1
        setZoomFactor(1)
      }
    }
    const handleStartLoading = () => setIsLoading(true)
    const handleStopLoading = () => {
      setIsLoading(false)
      syncUrlState(webview)
      const target = pendingScrollRestoreRef.current
      if (target) {
        pendingScrollRestoreRef.current = null
        window.setTimeout(() => {
          if (webviewRef.current !== webview) return
          void webview.executeJavaScript(`(() => { window.scrollTo(${JSON.stringify(target.x)}, ${JSON.stringify(target.y)}); return true; })()`, true)
        }, 50)
      }
    }
    const handleNavigate = (event: Electron.DidNavigateEvent | Electron.DidNavigateInPageEvent) => {
      if ('isMainFrame' in event && !event.isMainFrame) return
      syncUrlState(webview, event.url)
    }
    const handleTitle = (event: Electron.PageTitleUpdatedEvent) => setTitle(event.title)
    const handleEnterFullscreen = () => setIsFullscreen(true)
    const handleLeaveFullscreen = () => setIsFullscreen(false)
    const handleFailLoad = (event: Electron.DidFailLoadEvent) => {
      if (window.electronAPI.debug.autotest) {
        console.warn('[BrowserPanel] guest-load-failed', {
          errorCode: event.errorCode,
          errorDescription: event.errorDescription,
          validatedURL: event.validatedURL,
          isMainFrame: event.isMainFrame
        })
      }
    }

    webview.addEventListener('dom-ready', handleReady)
    webview.addEventListener('did-start-loading', handleStartLoading)
    webview.addEventListener('did-stop-loading', handleStopLoading)
    webview.addEventListener('did-navigate', handleNavigate)
    webview.addEventListener('did-navigate-in-page', handleNavigate)
    webview.addEventListener('page-title-updated', handleTitle)
    webview.addEventListener('enter-html-full-screen', handleEnterFullscreen)
    webview.addEventListener('leave-html-full-screen', handleLeaveFullscreen)
    webview.addEventListener('did-fail-load', handleFailLoad)

    webviewRef.current = webview
    browserIdRef.current = `browser-${terminalId}`
    wasDestroyedRef.current = false
    host.appendChild(webview)
    if (window.electronAPI.debug.autotest) console.log('[BrowserPanel] attach-appended', { startUrl })
    setUrl(startUrl)
    setInputUrl(startUrl)
    setHasVisibleView(Boolean(startUrl && startUrl !== 'about:blank'))
    setIsLoading(Boolean(startUrl))
    perfTrace(PERF_TRACE_EVENT.RENDERER_BROWSER_REATTACH, { urlLen: startUrl.length })
    return webview
  }, [syncUrlState, terminalId])

  useEffect(() => {
    if (!isOpen) return
    const existing = webviewRef.current
    if (existing) {
      browserIdRef.current = `browser-${terminalId}`
      syncUrlState(existing)
      return
    }
    const startUrl = resolveBrowserInputToUrl((initialUrl ?? '').trim()) ?? ''
    const frame = requestAnimationFrame(() => attachWebview(startUrl))
    return () => cancelAnimationFrame(frame)
  }, [attachWebview, initialUrl, isOpen, syncUrlState, terminalId])

  useEffect(() => () => {
    webviewRef.current?.remove()
    webviewRef.current = null
    browserIdRef.current = null
  }, [])

  const handleNavigate = useCallback(async (targetUrl: string) => {
    const webview = webviewRef.current
    const resolved = resolveBrowserInputToUrl(targetUrl.trim())
    if (!webview || !resolved) return
    setHasVisibleView(true)
    setIsLoading(true)
    await webview.loadURL(resolved)
  }, [])

  const handleGoBack = useCallback(() => {
    const webview = webviewRef.current
    if (webview?.canGoBack()) webview.goBack()
  }, [])

  const handleGoForward = useCallback(() => {
    const webview = webviewRef.current
    if (webview?.canGoForward()) webview.goForward()
  }, [])

  const handleReload = useCallback(() => {
    const webview = webviewRef.current
    if (!webview) return
    if (isLoadingRef.current) webview.stop()
    else webview.reload()
  }, [])

  const stepZoom = useCallback(async (direction: 'in' | 'out' | 'reset', source: 'toolbar' | 'debug') => {
    const webview = webviewRef.current
    if (!webview) return zoomFactorRef.current
    const next = stepHtmlPreviewZoomFactor(zoomFactorRef.current, direction)
    perfTrace(PERF_TRACE_EVENT.RENDERER_BROWSER_ZOOM, { source, direction, zoomPercent: Math.round(next * 100) })
    webview.setZoomFactor(next)
    zoomFactorRef.current = next
    setZoomFactor(next)
    return next
  }, [])

  useEffect(() => {
    if (!isOpen) return
    return window.electronAPI.browser.onWebviewInput((webContentsId, action) => {
      const webview = webviewRef.current
      if (!webview || webview.getWebContentsId() !== webContentsId) return
      if (action === 'escape') onClose()
      else if (action === 'reload') handleReload()
      else if (action === 'zoom-in') void stepZoom('in', 'toolbar')
      else if (action === 'zoom-out') void stepZoom('out', 'toolbar')
      else if (action === 'zoom-reset') void stepZoom('reset', 'toolbar')
    })
  }, [handleReload, isOpen, onClose, stepZoom])

  const getScrollState = useCallback(async (): Promise<BrowserScrollState | null> => {
    const webview = webviewRef.current
    if (!webview) return null
    try {
      return await webview.executeJavaScript(readScrollScript(), true) as BrowserScrollState
    } catch {
      return null
    }
  }, [])

  const runAutoRefreshTick = useCallback(async () => {
    const webview = webviewRef.current
    if (!webview || isLoadingRef.current) return
    pendingScrollRestoreRef.current = await getScrollState()
    perfTrace(PERF_TRACE_EVENT.RENDERER_BROWSER_AUTO_REFRESH_TICK, {})
    webview.reload()
  }, [getScrollState])

  useEffect(() => {
    if (!isOpen || !isViewReady || forceHidden || !isActive) return
    const intervalMs = clampAutoRefreshIntervalMs(autoRefreshIntervalMs)
    if (intervalMs == null) return
    const timer = window.setInterval(() => void runAutoRefreshTick(), intervalMs)
    return () => window.clearInterval(timer)
  }, [autoRefreshIntervalMs, forceHidden, isActive, isOpen, isViewReady, runAutoRefreshTick])

  const autoRefreshPresetLabel = useCallback((ms: number): string => {
    if (ms % 60_000 === 0) {
      const minutes = ms / 60_000
      return minutes === 1 ? t('browserPanel.autoRefreshMinute') : t('browserPanel.autoRefreshMinutes', { n: minutes })
    }
    return t('browserPanel.autoRefreshSeconds', { n: Math.round(ms / 1000) })
  }, [t])

  const handleShowAutoRefreshMenu = useCallback(async () => {
    const result = await window.electronAPI.browser.showAutoRefreshMenu({
      currentIntervalMs: autoRefreshIntervalMs ?? null,
      labels: {
        off: t('browserPanel.autoRefreshOff'),
        items: AUTO_REFRESH_PRESETS_MS.map((ms) => ({ ms, label: autoRefreshPresetLabel(ms) }))
      }
    })
    if (!result) return
    const next = clampAutoRefreshIntervalMs(result.intervalMs)
    perfTrace(PERF_TRACE_EVENT.RENDERER_BROWSER_AUTO_REFRESH_TOGGLE, { intervalMs: next })
    if (next != null) {
      // Product telemetry: auto-refresh turned ON (an interval was selected).
      trackFeatureUse('browser-auto-refresh')
    }
    onAutoRefreshChange?.(next)
  }, [autoRefreshIntervalMs, autoRefreshPresetLabel, onAutoRefreshChange, t])

  const handleShowCookieMenu = useCallback(async () => {
    const result = await window.electronAPI.browser.showCookieMenu({
      rememberCookies,
      labels: {
        remember: t('browserPanel.rememberCookies'),
        clearDay: t('browserPanel.clearCookiesDay'),
        clearWeek: t('browserPanel.clearCookiesWeek'),
        clearAll: t('browserPanel.clearCookiesAll')
      }
    })
    if (!result) return
    if (result.action === 'toggleRemember') {
      const next = result.rememberCookies ?? false
      updateSharedRememberCookies(next)
      void window.electronAPI.browser.setRememberCookies(next)
    } else if (result.action === 'clear') {
      void window.electronAPI.browser.clearCookies(86400)
    } else if (result.action === 'clearWeek') {
      void window.electronAPI.browser.clearCookies(604800)
    } else if (result.action === 'clearAll') {
      void window.electronAPI.browser.clearCookies()
    }
  }, [rememberCookies, t])

  const handleCloseButton = useCallback(() => {
    const webview = webviewRef.current
    if (webview) {
      webview.remove()
      webviewRef.current = null
    }
    browserIdRef.current = null
    wasDestroyedRef.current = true
    setIsViewReady(false)
    setHasVisibleView(false)
    setUrl('')
    setInputUrl('')
    zoomFactorRef.current = 1
    setZoomFactor(1)
    perfTrace(PERF_TRACE_EVENT.RENDERER_BROWSER_DESTROY, {})
    onClose()
  }, [onClose])

  useEffect(() => {
    if (!window.electronAPI.debug.autotest || !isOpen || !isViewReady) return
    const debugWindow = window as Window & { __onwardBrowserPanelDebug?: BrowserPanelDebugApi }
    debugWindow.__onwardBrowserPanelDebug = {
      getBrowserId: () => browserIdRef.current,
      getZoomFactor: () => zoomFactorRef.current,
      getViewZoomFactor: async () => webviewRef.current?.getZoomFactor() ?? null,
      stepZoom: (direction) => stepZoom(direction, 'debug'),
      openUrl: handleNavigate,
      reload: handleReload,
      closeKeepAlive: onClose,
      evaluate: async (script) => webviewRef.current?.executeJavaScript(script, true) ?? null,
      getScrollState,
      setAutoRefresh: (intervalMs) => onAutoRefreshChange?.(clampAutoRefreshIntervalMs(intervalMs)),
      triggerAutoRefreshTick: runAutoRefreshTick,
      wasDestroyed: () => wasDestroyedRef.current
    }
    return () => {
      if (debugWindow.__onwardBrowserPanelDebug) delete debugWindow.__onwardBrowserPanelDebug
    }
  }, [getScrollState, handleNavigate, handleReload, isOpen, isViewReady, onAutoRefreshChange, onClose, runAutoRefreshTick, stepZoom, zoomFactor])

  const modifierLabel = window.electronAPI.platform === 'darwin' ? '⌘' : 'Ctrl'
  const zoomPercent = formatHtmlPreviewZoomPercent(zoomFactor)
  const autoRefreshActive = clampAutoRefreshIntervalMs(autoRefreshIntervalMs) != null
  const autoRefreshBadge = autoRefreshActive ? formatAutoRefreshInterval(autoRefreshIntervalMs as number) : ''
  const hidden = !isOpen || forceHidden

  return (
    <div
      className={`browser-panel-cell${isFullscreen ? ' fullscreen' : ''}${hidden ? ' browser-panel-hidden' : ''}`}
      aria-hidden={hidden}
    >
      <div className="browser-panel-nav">
        <input
          ref={urlInputRef}
          className="browser-panel-url-input"
          type="text"
          value={inputUrl}
          onChange={(event) => setInputUrl(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault()
              void handleNavigate(inputUrl)
              urlInputRef.current?.blur()
            } else if (event.key === 'Escape') {
              event.stopPropagation()
              urlInputRef.current?.blur()
            }
          }}
          onFocus={(event) => event.target.select()}
          placeholder={t('browserPanel.urlPlaceholder')}
          spellCheck={false}
          title={title || url || ''}
        />
        <div className="browser-panel-actions">
          <div className="browser-panel-navigation-controls">
            <button className="browser-panel-nav-btn" onClick={handleGoBack} disabled={!canGoBack} title={t('browserPanel.back')}>
              <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path fillRule="evenodd" d="M11.354 1.646a.5.5 0 0 1 0 .708L5.707 8l5.647 5.646a.5.5 0 0 1-.708.708l-6-6a.5.5 0 0 1 0-.708l6-6a.5.5 0 0 1 .708 0z" /></svg>
            </button>
            <button className="browser-panel-nav-btn" onClick={handleGoForward} disabled={!canGoForward} title={t('browserPanel.forward')}>
              <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path fillRule="evenodd" d="M4.646 1.646a.5.5 0 0 1 .708 0l6 6a.5.5 0 0 1 0 .708l-6 6a.5.5 0 0 1-.708-.708L10.293 8 4.646 2.354a.5.5 0 0 1 0-.708z" /></svg>
            </button>
            <button className="browser-panel-nav-btn browser-panel-manual-refresh-btn" onClick={handleReload} title={isLoading ? t('browserPanel.stop') : t('browserPanel.reload')}>
              {isLoading
                ? <svg data-toolbar-icon="stop" width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M4 4h8v8H4z" /></svg>
                : <BrowserRefreshIcon />}
            </button>
          </div>
          <div className="browser-panel-zoom-controls" aria-label={t('browserPanel.zoomControls')}>
            <button className="browser-panel-nav-btn browser-panel-zoom-btn browser-panel-zoom-out-btn" onClick={() => void stepZoom('out', 'toolbar')} disabled={zoomFactor <= HTML_PREVIEW_MIN_ZOOM_FACTOR} title={t('browserPanel.zoomOut', { key: `${modifierLabel}+-` })}>
              <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M3 7.25h10v1.5H3v-1.5Z" /></svg>
            </button>
            <button className="browser-panel-zoom-level-btn" onClick={() => void stepZoom('reset', 'toolbar')} title={t('browserPanel.zoomReset', { key: `${modifierLabel}+0` })}>{zoomPercent}</button>
            <button className="browser-panel-nav-btn browser-panel-zoom-btn browser-panel-zoom-in-btn" onClick={() => void stepZoom('in', 'toolbar')} disabled={zoomFactor >= HTML_PREVIEW_MAX_ZOOM_FACTOR} title={t('browserPanel.zoomIn', { key: `${modifierLabel}++` })}>
              <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M7.25 3h1.5v4.25H13v1.5H8.75V13h-1.5V8.75H3v-1.5h4.25V3Z" /></svg>
            </button>
          </div>
          <button className={`browser-panel-nav-btn browser-panel-auto-refresh-btn${autoRefreshActive ? ' active' : ''}`} onClick={handleShowAutoRefreshMenu} title={t('browserPanel.autoRefresh')}>
            <BrowserAutoRefreshIcon />
            {autoRefreshActive && <span className="browser-panel-auto-refresh-badge">{autoRefreshBadge}</span>}
          </button>
          <button className="browser-panel-nav-btn" onClick={handleShowCookieMenu} title={t('browserPanel.cookieMenu')}>
            <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M8 1a7 7 0 1 0 7 7 3 3 0 0 1-3-3 3 3 0 0 1-3-3A3 3 0 0 1 8 1zM5 7a1 1 0 1 1 0 2 1 1 0 0 1 0-2zm4 3a1 1 0 1 1 0 2 1 1 0 0 1 0-2z" /></svg>
          </button>
          <button className="browser-panel-nav-btn close-btn" onClick={handleCloseButton} title={t('browserPanel.close')}>
            <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M4.6 3.6 8 7l3.4-3.4 1 1L9 8l3.4 3.4-1 1L8 9l-3.4 3.4-1-1L7 8 3.6 4.6z" /></svg>
          </button>
        </div>
      </div>
      {isLoading && <div className="browser-panel-loading-bar" />}
      <div className="browser-panel-placeholder">
        <div ref={hostRef} className="browser-panel-webview-host" />
        {!isViewReady && <div className="browser-panel-placeholder-hint">{t('browserPanel.initializing')}</div>}
        {isViewReady && !hasVisibleView && !isLoading && <div className="browser-panel-placeholder-hint">{t('browserPanel.startBrowsing')}</div>}
      </div>
    </div>
  )
}
