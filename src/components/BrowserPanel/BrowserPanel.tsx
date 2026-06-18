/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { useI18n } from '../../i18n/useI18n'
import { useSubpageEscape } from '../../hooks/useSubpageEscape'
import { perfTrace } from '../../utils/perf-trace'
import { PERF_TRACE_EVENT } from '../../utils/perf-trace-names'
import {
  formatHtmlPreviewZoomPercent,
  HTML_PREVIEW_MAX_ZOOM_FACTOR,
  HTML_PREVIEW_MIN_ZOOM_FACTOR,
  stepHtmlPreviewZoomFactor
} from '../../utils/html-file'
import {
  AUTO_REFRESH_PRESETS_MS,
  clampAutoRefreshIntervalMs,
  formatAutoRefreshInterval
} from '../../utils/browser-url'
import type { BrowserScrollState } from '../../types/electron'
import './BrowserPanel.css'

interface BrowserPanelProps {
  isOpen: boolean
  // Esc / toggle-off / overlay → hide and KEEP the view cached (path memory).
  onClose: () => void
  terminalId: string
  initialUrl?: string | null
  onUrlChange?: (url: string) => void
  forceHidden?: boolean
  isActive?: boolean
  // Auto Refresh interval in ms (null = off). Per-terminal, in-session.
  autoRefreshIntervalMs?: number | null
  onAutoRefreshChange?: (next: number | null) => void
}

let sharedRememberCookies = true
const rememberCookiesSubscribers = new Set<(rememberCookies: boolean) => void>()

function subscribeRememberCookies(callback: (rememberCookies: boolean) => void): () => void {
  rememberCookiesSubscribers.add(callback)
  return () => {
    rememberCookiesSubscribers.delete(callback)
  }
}

function updateSharedRememberCookies(next: boolean): void {
  sharedRememberCookies = next
  for (const callback of rememberCookiesSubscribers) {
    callback(next)
  }
}

interface BrowserPanelDebugApi {
  getBrowserId: () => string | null
  getZoomFactor: () => number
  getViewZoomFactor: () => Promise<number | null>
  stepZoom: (direction: 'in' | 'out' | 'reset') => Promise<number>
  openUrl: (url: string) => Promise<void>
  reload: () => void
  // The keep-alive close path (what Esc / toggle-off invoke): hides & caches, never destroys.
  closeKeepAlive: () => void
  evaluate: (script: string) => Promise<unknown>
  getScrollState: () => Promise<BrowserScrollState | null>
  setAutoRefresh: (intervalMs: number | null) => void
  triggerAutoRefreshTick: () => Promise<void>
  wasDestroyed: () => boolean
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

  const placeholderRef = useRef<HTMLDivElement>(null)
  const urlInputRef = useRef<HTMLInputElement>(null)
  const rafRef = useRef<number>(0)
  const browserIdRef = useRef<string | null>(null)
  const forceHiddenRef = useRef(forceHidden)
  const hasVisibleViewRef = useRef(false)
  const isLoadingRef = useRef(false)
  const destroyOnUnmountRef = useRef(false)
  const wasDestroyedRef = useRef(false)
  const pendingScrollRestoreRef = useRef<BrowserScrollState | null>(null)

  useSubpageEscape({
    isOpen: isOpen && !forceHidden && isActive,
    onEscape: onClose
  })

  useEffect(() => {
    setRememberCookies(sharedRememberCookies)
    return subscribeRememberCookies(setRememberCookies)
  }, [])

  const syncBounds = useCallback(() => {
    const id = browserIdRef.current
    const placeholder = placeholderRef.current
    if (!id || !placeholder) return

    if (forceHiddenRef.current || !hasVisibleViewRef.current) {
      void window.electronAPI.browser.hide(id)
      return
    }

    const rect = placeholder.getBoundingClientRect()
    if (rect.width <= 0 || rect.height <= 0) {
      void window.electronAPI.browser.hide(id)
      return
    }

    void window.electronAPI.browser.show(id)
    void window.electronAPI.browser.setBounds(id, {
      x: Math.round(rect.x),
      y: Math.round(rect.y),
      width: Math.round(rect.width),
      height: Math.round(rect.height)
    })
  }, [])

  const scheduleSyncBounds = useCallback(() => {
    if (rafRef.current) {
      cancelAnimationFrame(rafRef.current)
    }
    rafRef.current = requestAnimationFrame(syncBounds)
  }, [syncBounds])

  useEffect(() => {
    forceHiddenRef.current = forceHidden
    if (isOpen && isViewReady) {
      scheduleSyncBounds()
    }
  }, [forceHidden, isOpen, isViewReady, scheduleSyncBounds])

  useEffect(() => {
    hasVisibleViewRef.current = hasVisibleView
    if (isOpen && isViewReady) {
      scheduleSyncBounds()
    }
  }, [hasVisibleView, isOpen, isViewReady, scheduleSyncBounds])

  useEffect(() => {
    isLoadingRef.current = isLoading
  }, [isLoading])

  // View lifecycle: detect-or-create on open; HIDE (cache) on Esc/toggle, DESTROY only on ✕.
  useEffect(() => {
    if (!isOpen) return

    const id = `browser-${terminalId}`
    const startUrl = (initialUrl ?? '').trim()

    browserIdRef.current = id
    destroyOnUnmountRef.current = false
    wasDestroyedRef.current = false
    setIsViewReady(false)
    setIsFullscreen(false)

    let cancelled = false

    void (async () => {
      const nav = await window.electronAPI.browser.getNavState(id)
      if (cancelled || browserIdRef.current !== id) return

      if (nav) {
        // Reattach a cached view (path memory after an Esc exit).
        perfTrace(PERF_TRACE_EVENT.RENDERER_BROWSER_REATTACH, { urlLen: nav.url.length })
        setUrl(nav.url)
        setInputUrl(nav.url)
        setTitle(nav.title)
        setIsLoading(nav.isLoading)
        setCanGoBack(nav.canGoBack)
        setCanGoForward(nav.canGoForward)
        const visible = nav.url.trim() !== '' && nav.url !== 'about:blank'
        setHasVisibleView(visible)
        hasVisibleViewRef.current = visible
        setIsViewReady(true)
        const zf = await window.electronAPI.browser.getZoomFactor(id)
        if (!cancelled && zf?.success && typeof zf.zoomFactor === 'number') {
          setZoomFactor(zf.zoomFactor)
        }
        requestAnimationFrame(() => {
          syncBounds()
          requestAnimationFrame(syncBounds)
        })
        return
      }

      // Create a fresh view. Open Browser allows any local file (no fileRoot restriction).
      const shouldShowView = startUrl.length > 0
      setUrl(startUrl)
      setInputUrl(startUrl)
      setTitle('')
      setIsLoading(shouldShowView)
      setCanGoBack(false)
      setCanGoForward(false)
      setHasVisibleView(shouldShowView)
      hasVisibleViewRef.current = shouldShowView
      setZoomFactor(1)

      const result = await window.electronAPI.browser.create(id, startUrl || undefined, {
        allowFile: true,
        allowAnyFile: true
      })
      if (cancelled || browserIdRef.current !== id || !result.success) return
      setIsViewReady(true)
      const zf = await window.electronAPI.browser.getZoomFactor(id)
      if (!cancelled && zf?.success && typeof zf.zoomFactor === 'number') {
        setZoomFactor(zf.zoomFactor)
      }
      requestAnimationFrame(() => {
        syncBounds()
        requestAnimationFrame(syncBounds)
      })
    })()

    return () => {
      cancelled = true
      const activeId = browserIdRef.current
      browserIdRef.current = null
      hasVisibleViewRef.current = false
      setIsViewReady(false)
      setHasVisibleView(false)
      if (activeId) {
        if (destroyOnUnmountRef.current) {
          wasDestroyedRef.current = true
          perfTrace(PERF_TRACE_EVENT.RENDERER_BROWSER_DESTROY, {})
          window.electronAPI.browser.destroy(activeId).catch(() => {
            // Ignore destroy races during teardown.
          })
        } else {
          perfTrace(PERF_TRACE_EVENT.RENDERER_BROWSER_CACHE_HIDE, {})
          window.electronAPI.browser.hide(activeId).catch(() => {
            // Ignore hide races during teardown.
          })
        }
      }
      if (rafRef.current) {
        cancelAnimationFrame(rafRef.current)
      }
    }
  }, [isOpen, syncBounds, terminalId])

  useEffect(() => {
    if (!isOpen || !isViewReady) return

    const placeholder = placeholderRef.current
    if (!placeholder) return

    const observer = new ResizeObserver(scheduleSyncBounds)
    observer.observe(placeholder)
    window.addEventListener('resize', scheduleSyncBounds)
    scheduleSyncBounds()

    return () => {
      observer.disconnect()
      window.removeEventListener('resize', scheduleSyncBounds)
      if (rafRef.current) {
        cancelAnimationFrame(rafRef.current)
      }
    }
  }, [isOpen, isViewReady, scheduleSyncBounds])

  useEffect(() => {
    if (!isOpen) return

    const unsubUrl = window.electronAPI.browser.onUrlChanged((id, nextUrl) => {
      if (id !== browserIdRef.current) return
      setUrl(nextUrl)
      setInputUrl(nextUrl)
      onUrlChange?.(nextUrl)
      const shouldShowView = nextUrl.trim() !== '' && nextUrl !== 'about:blank'
      setHasVisibleView(shouldShowView)
    })

    const unsubTitle = window.electronAPI.browser.onTitleChanged((id, nextTitle) => {
      if (id !== browserIdRef.current) return
      setTitle(nextTitle)
    })

    const unsubLoading = window.electronAPI.browser.onLoadingChanged((id, loading) => {
      if (id !== browserIdRef.current) return
      setIsLoading(loading)
      // Auto-refresh scroll-position memory: restore after the reload settles.
      if (!loading && pendingScrollRestoreRef.current) {
        const target = pendingScrollRestoreRef.current
        pendingScrollRestoreRef.current = null
        window.setTimeout(() => {
          const browserId = browserIdRef.current
          if (!browserId || browserId !== id) return
          void window.electronAPI.browser.restoreScrollState(browserId, target)
        }, 50)
      }
    })

    const unsubNav = window.electronAPI.browser.onNavStateChanged((id, state) => {
      if (id !== browserIdRef.current) return
      setCanGoBack(state.canGoBack)
      setCanGoForward(state.canGoForward)
    })

    const unsubFullscreen = window.electronAPI.browser.onFullscreenChanged((id, fullscreen) => {
      if (id !== browserIdRef.current) return
      setIsFullscreen(fullscreen)
      if (!fullscreen) {
        requestAnimationFrame(syncBounds)
      }
    })

    const unsubEscape = window.electronAPI.browser.onEscapePressed((id) => {
      if (id !== browserIdRef.current) return
      onClose()
    })

    const unsubZoom = window.electronAPI.browser.onZoomFactorChanged((id, nextZoomFactor) => {
      if (id !== browserIdRef.current) return
      setZoomFactor(nextZoomFactor)
    })

    return () => {
      unsubUrl()
      unsubTitle()
      unsubLoading()
      unsubNav()
      unsubFullscreen()
      unsubEscape()
      unsubZoom()
    }
  }, [isOpen, onClose, onUrlChange, syncBounds])

  const handleNavigate = useCallback(async (targetUrl: string) => {
    const id = browserIdRef.current
    if (!id || !targetUrl.trim()) return

    const success = await window.electronAPI.browser.navigate(id, targetUrl.trim())
    if (success) {
      setHasVisibleView(true)
      scheduleSyncBounds()
    }
  }, [scheduleSyncBounds])

  const handleGoBack = useCallback(() => {
    const id = browserIdRef.current
    if (id) {
      void window.electronAPI.browser.goBack(id)
    }
  }, [])

  const handleGoForward = useCallback(() => {
    const id = browserIdRef.current
    if (id) {
      void window.electronAPI.browser.goForward(id)
    }
  }, [])

  const handleReload = useCallback(() => {
    const id = browserIdRef.current
    if (!id) return

    if (isLoadingRef.current) {
      void window.electronAPI.browser.stop(id)
      return
    }

    void window.electronAPI.browser.reload(id)
  }, [])

  useEffect(() => {
    if (!isOpen) return
    const unsubscribe = window.electronAPI.browser.onReloadShortcutPressed((id) => {
      if (id !== browserIdRef.current) return
      handleReload()
    })
    return unsubscribe
  }, [handleReload, isOpen])

  const stepZoom = useCallback(async (direction: 'in' | 'out' | 'reset', source: 'toolbar' | 'debug') => {
    const id = browserIdRef.current
    if (!id) return zoomFactor
    const next = stepHtmlPreviewZoomFactor(zoomFactor, direction)
    perfTrace(PERF_TRACE_EVENT.RENDERER_BROWSER_ZOOM, {
      source,
      direction,
      zoomPercent: Math.round(next * 100)
    })
    const result = await window.electronAPI.browser.setZoomFactor(id, next)
    if (result?.success && typeof result.zoomFactor === 'number') {
      setZoomFactor(result.zoomFactor)
      return result.zoomFactor
    }
    return next
  }, [zoomFactor])

  // ── Auto Refresh ──────────────────────────────────────────────────────────
  const runAutoRefreshTick = useCallback(async () => {
    const id = browserIdRef.current
    if (!id) return
    if (isLoadingRef.current) return
    try {
      const res = await window.electronAPI.browser.getScrollState(id)
      if (res?.success && res.state) {
        pendingScrollRestoreRef.current = res.state
      }
    } catch {
      // Ignore scroll-capture failures; still refresh.
    }
    perfTrace(PERF_TRACE_EVENT.RENDERER_BROWSER_AUTO_REFRESH_TICK, {})
    void window.electronAPI.browser.reload(id)
  }, [])

  useEffect(() => {
    if (!isOpen || !isViewReady) return
    if (forceHidden || !isActive) return
    const intervalMs = clampAutoRefreshIntervalMs(autoRefreshIntervalMs)
    if (intervalMs == null) return
    const timer = window.setInterval(() => {
      void runAutoRefreshTick()
    }, intervalMs)
    return () => window.clearInterval(timer)
  }, [isOpen, isViewReady, forceHidden, isActive, autoRefreshIntervalMs, runAutoRefreshTick])

  const autoRefreshPresetLabel = useCallback((ms: number): string => {
    if (ms % 60_000 === 0) {
      const minutes = ms / 60_000
      return minutes === 1
        ? t('browserPanel.autoRefreshMinute')
        : t('browserPanel.autoRefreshMinutes', { n: minutes })
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
    // The ✕ button fully destroys the cached view (Esc only hides it).
    destroyOnUnmountRef.current = true
    onClose()
  }, [onClose])

  // Autotest debug bridge (no-op in user builds). Gated on isOpen && isViewReady so ONLY the
  // active open panel registers the singleton, and closing the panel removes it — that makes
  // "the global is gone" a correct closed/destroyed signal for the autotest.
  useEffect(() => {
    if (!window.electronAPI?.debug?.autotest) return
    if (!isOpen || !isViewReady) return
    const debugWindow = window as Window & { __onwardBrowserPanelDebug?: BrowserPanelDebugApi }
    debugWindow.__onwardBrowserPanelDebug = {
      getBrowserId: () => browserIdRef.current,
      getZoomFactor: () => zoomFactor,
      getViewZoomFactor: async () => {
        const id = browserIdRef.current
        if (!id) return null
        const res = await window.electronAPI.browser.getZoomFactor(id)
        return res?.success && typeof res.zoomFactor === 'number' ? res.zoomFactor : null
      },
      stepZoom: (direction) => stepZoom(direction, 'debug'),
      openUrl: async (nextUrl) => { await handleNavigate(nextUrl) },
      reload: () => handleReload(),
      closeKeepAlive: () => onClose(),
      evaluate: async (script) => {
        const id = browserIdRef.current
        if (!id) return null
        const res = await window.electronAPI.browser.evaluateForTest(id, script)
        return res?.success ? res.value : null
      },
      getScrollState: async () => {
        const id = browserIdRef.current
        if (!id) return null
        const res = await window.electronAPI.browser.getScrollState(id)
        return res?.success && res.state ? res.state : null
      },
      setAutoRefresh: (intervalMs) => onAutoRefreshChange?.(clampAutoRefreshIntervalMs(intervalMs)),
      triggerAutoRefreshTick: () => runAutoRefreshTick(),
      wasDestroyed: () => wasDestroyedRef.current
    }
    return () => {
      if (debugWindow.__onwardBrowserPanelDebug) {
        delete debugWindow.__onwardBrowserPanelDebug
      }
    }
  }, [isOpen, isViewReady, zoomFactor, stepZoom, handleNavigate, handleReload, onClose, onAutoRefreshChange, runAutoRefreshTick])

  if (!isOpen) return null

  const modifierLabel = window.electronAPI.platform === 'darwin' ? '⌘' : 'Ctrl'
  const zoomPercent = formatHtmlPreviewZoomPercent(zoomFactor)
  const autoRefreshActive = clampAutoRefreshIntervalMs(autoRefreshIntervalMs) != null
  const autoRefreshBadge = autoRefreshActive ? formatAutoRefreshInterval(autoRefreshIntervalMs as number) : ''

  return (
    <div className={`browser-panel-cell${isFullscreen ? ' fullscreen' : ''}`}>
      <div className="browser-panel-nav">
        <button
          className="browser-panel-nav-btn"
          onClick={handleGoBack}
          disabled={!canGoBack}
          title={t('browserPanel.back')}
        >
          <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
            <path fillRule="evenodd" d="M11.354 1.646a.5.5 0 0 1 0 .708L5.707 8l5.647 5.646a.5.5 0 0 1-.708.708l-6-6a.5.5 0 0 1 0-.708l6-6a.5.5 0 0 1 .708 0z" />
          </svg>
        </button>

        <button
          className="browser-panel-nav-btn"
          onClick={handleGoForward}
          disabled={!canGoForward}
          title={t('browserPanel.forward')}
        >
          <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
            <path fillRule="evenodd" d="M4.646 1.646a.5.5 0 0 1 .708 0l6 6a.5.5 0 0 1 0 .708l-6 6a.5.5 0 0 1-.708-.708L10.293 8 4.646 2.354a.5.5 0 0 1 0-.708z" />
          </svg>
        </button>

        <button
          className="browser-panel-nav-btn"
          onClick={handleReload}
          title={isLoading ? t('browserPanel.stop') : t('browserPanel.reload')}
        >
          {isLoading ? (
            <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
              <path d="M4.646 4.646a.5.5 0 0 1 .708 0L8 7.293l2.646-2.647a.5.5 0 0 1 .708.708L8.707 8l2.647 2.646a.5.5 0 0 1-.708.708L8 8.707l-2.646 2.647a.5.5 0 0 1-.708-.708L7.293 8 4.646 5.354a.5.5 0 0 1 0-.708z" />
            </svg>
          ) : (
            <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
              <path d="M11.534 7h3.932a.25.25 0 0 1 .192.41l-1.966 2.36a.25.25 0 0 1-.384 0l-1.966-2.36a.25.25 0 0 1 .192-.41zm-7.068 2H.534a.25.25 0 0 0-.192.41l1.966 2.36a.25.25 0 0 0 .384 0l1.966-2.36A.25.25 0 0 0 4.466 9z" />
              <path d="M8 3a5 5 0 0 1 4.546 2.914.5.5 0 1 0 .908-.428A6 6 0 0 0 2.11 5.84L1.58 4.39A.5.5 0 0 0 .64 4.61l1.2 3.6a.5.5 0 0 0 .638.316l3.6-1.2a.5.5 0 1 0-.316-.948L3.9 7.077A5 5 0 0 1 8 3zm6.42 5.39a.5.5 0 0 0-.638-.316l-3.6 1.2a.5.5 0 1 0 .316.948l1.862-.62A5 5 0 0 1 8 13a5 5 0 0 1-4.546-2.914.5.5 0 0 0-.908.428A6 6 0 0 0 13.89 10.16l.53 1.45a.5.5 0 1 0 .94-.22l-1.2-3.6a.5.5 0 0 0-.26-.28z" />
            </svg>
          )}
        </button>

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

        <div className="browser-panel-zoom-controls" aria-label={t('browserPanel.zoomControls')}>
          <button
            className="browser-panel-nav-btn browser-panel-zoom-btn browser-panel-zoom-out-btn"
            onClick={() => void stepZoom('out', 'toolbar')}
            disabled={zoomFactor <= HTML_PREVIEW_MIN_ZOOM_FACTOR}
            title={t('browserPanel.zoomOut', { key: `${modifierLabel}+-` })}
            aria-label={t('browserPanel.zoomOut', { key: `${modifierLabel}+-` })}
          >
            <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
              <path d="M3 7.25h10v1.5H3v-1.5Z" />
            </svg>
          </button>
          <button
            className="browser-panel-zoom-level-btn"
            onClick={() => void stepZoom('reset', 'toolbar')}
            title={t('browserPanel.zoomReset', { key: `${modifierLabel}+0` })}
            aria-label={t('browserPanel.zoomLevel', { percent: zoomPercent })}
          >
            {zoomPercent}
          </button>
          <button
            className="browser-panel-nav-btn browser-panel-zoom-btn browser-panel-zoom-in-btn"
            onClick={() => void stepZoom('in', 'toolbar')}
            disabled={zoomFactor >= HTML_PREVIEW_MAX_ZOOM_FACTOR}
            title={t('browserPanel.zoomIn', { key: `${modifierLabel}++` })}
            aria-label={t('browserPanel.zoomIn', { key: `${modifierLabel}++` })}
          >
            <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
              <path d="M7.25 3h1.5v4.25H13v1.5H8.75V13h-1.5V8.75H3v-1.5h4.25V3Z" />
            </svg>
          </button>
        </div>

        <button
          className={`browser-panel-nav-btn browser-panel-auto-refresh-btn${autoRefreshActive ? ' active' : ''}`}
          onClick={handleShowAutoRefreshMenu}
          title={t('browserPanel.autoRefresh')}
          aria-label={t('browserPanel.autoRefresh')}
        >
          <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
            <path d="M8 3a5 5 0 1 0 4.546 2.914.5.5 0 1 1 .908-.428A6 6 0 1 1 8 2v1z" />
            <path d="M8 4.466V.534a.25.25 0 0 1 .41-.192l2.36 1.966a.25.25 0 0 1 0 .384L8.41 4.658A.25.25 0 0 1 8 4.466z" />
            <path d="M8.5 5.5a.5.5 0 0 0-1 0v3a.5.5 0 0 0 .252.434l2 1.2a.5.5 0 1 0 .496-.868L8.5 8.234V5.5z" />
          </svg>
          {autoRefreshActive && <span className="browser-panel-auto-refresh-badge">{autoRefreshBadge}</span>}
        </button>

        <button
          className="browser-panel-nav-btn"
          onClick={handleShowCookieMenu}
          title={t('browserPanel.cookieMenu')}
        >
          <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
            <path d="M6 7.5a1.5 1.5 0 1 1-3 0 1.5 1.5 0 0 1 3 0zm4.5.5a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3zm-.5 3a1.5 1.5 0 1 1-3 0 1.5 1.5 0 0 1 3 0z" />
            <path d="M8 0a7.963 7.963 0 0 0-4.075 1.114c-.162.067-.31.175-.437.32A8 8 0 1 0 8 0zm3.25 14.201A6.97 6.97 0 0 1 8 15a6.97 6.97 0 0 1-3.25-.799 7.024 7.024 0 0 1-2.578-2.17A6.96 6.96 0 0 1 1 8c0-1.235.32-2.395.883-3.403A7.018 7.018 0 0 1 8 1a7.018 7.018 0 0 1 6.117 3.597A6.96 6.96 0 0 1 15 8a6.96 6.96 0 0 1-1.172 3.88 7.026 7.026 0 0 1-2.578 2.321z" />
          </svg>
        </button>

        <button className="browser-panel-nav-btn close-btn" onClick={handleCloseButton} title={t('browserPanel.close')}>
          <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
            <path d="M4.646 4.646a.5.5 0 0 1 .708 0L8 7.293l2.646-2.647a.5.5 0 0 1 .708.708L8.707 8l2.647 2.646a.5.5 0 0 1-.708.708L8 8.707l-2.646 2.647a.5.5 0 0 1-.708-.708L7.293 8 4.646 5.354a.5.5 0 0 1 0-.708z" />
          </svg>
        </button>
      </div>

      {isLoading && <div className="browser-panel-loading-bar" />}

      <div ref={placeholderRef} className="browser-panel-placeholder">
        {!isViewReady && (
          <div className="browser-panel-placeholder-hint">
            {t('browserPanel.initializing')}
          </div>
        )}
        {isViewReady && !hasVisibleView && !isLoading && (
          <div className="browser-panel-placeholder-hint">
            {t('browserPanel.startBrowsing')}
          </div>
        )}
      </div>
    </div>
  )
}
