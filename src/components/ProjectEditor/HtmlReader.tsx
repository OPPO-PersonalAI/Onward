/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { useI18n } from '../../i18n/useI18n'
import {
  isHtmlPreviewScrollRestoreVerified,
  isSameHtmlPreviewFile,
  normalizeHtmlPreviewScrollState,
  normalizeHtmlPreviewZoomFactor,
  shouldAttemptHtmlPreviewScrollRestore,
  type HtmlPreviewScrollState
} from '../../utils/html-file'

export type HtmlReaderScrollRestoreStatus = 'idle' | 'waiting' | 'restoring' | 'restored' | 'failed'

export type HtmlReaderState = {
  browserId: string
  filePath: string
  url: string
  title: string
  ready: boolean
  visible: boolean
  isLoading: boolean
  loadCount: number
  reloadKey: number
  canGoBack: boolean
  canGoForward: boolean
  error: string | null
  scrollRestoreStatus: HtmlReaderScrollRestoreStatus
  restoredScrollY: number | null
}

interface HtmlReaderProps {
  url: string
  rootPath: string
  filePath: string
  reloadKey: number
  isActive: boolean
  zoomFactor: number
  restoreScrollState?: HtmlPreviewScrollState | null
  onEscape: () => void
  onStateChange?: (state: HtmlReaderState | null) => void
}

let htmlReaderIdCounter = 0

export function HtmlReader({
  url,
  rootPath,
  filePath,
  reloadKey,
  isActive,
  zoomFactor,
  restoreScrollState,
  onEscape,
  onStateChange
}: HtmlReaderProps) {
  const { t } = useI18n()
  const [state, setState] = useState<HtmlReaderState | null>(null)
  const placeholderRef = useRef<HTMLDivElement>(null)
  const rafRef = useRef<number>(0)
  const browserIdRef = useRef<string | null>(null)
  const isActiveRef = useRef(isActive)
  const stateRef = useRef<HtmlReaderState | null>(null)
  const restoreScrollStateRef = useRef<HtmlPreviewScrollState | null>(restoreScrollState ?? null)
  const zoomFactorRef = useRef(normalizeHtmlPreviewZoomFactor(zoomFactor))
  const restoredReloadKeyRef = useRef<number | null>(null)
  const targetNavigationConfirmedRef = useRef(false)
  const targetLoadSettledRef = useRef(false)
  const zoomAppliedRef = useRef(false)
  const restoreInFlightRef = useRef(false)
  const restoreGenerationRef = useRef(0)

  const updateState = useCallback((patch: Partial<HtmlReaderState>) => {
    const current = stateRef.current
    if (!current) return
    const next = { ...current, ...patch }
    stateRef.current = next
    setState(next)
    onStateChange?.(next)
  }, [onStateChange])

  const syncBounds = useCallback(() => {
    const id = browserIdRef.current
    const placeholder = placeholderRef.current
    if (!id || !placeholder) return

    if (!isActiveRef.current) {
      void window.electronAPI.browser.hide(id)
      updateState({ visible: false })
      return
    }

    const rect = placeholder.getBoundingClientRect()
    if (rect.width <= 0 || rect.height <= 0) {
      void window.electronAPI.browser.hide(id)
      updateState({ visible: false })
      return
    }

    void window.electronAPI.browser.show(id)
    void window.electronAPI.browser.setBounds(id, {
      x: Math.round(rect.x),
      y: Math.round(rect.y),
      width: Math.round(rect.width),
      height: Math.round(rect.height)
    })
    updateState({ visible: true })
  }, [updateState])

  const scheduleSyncBounds = useCallback(() => {
    if (rafRef.current) {
      cancelAnimationFrame(rafRef.current)
    }
    rafRef.current = requestAnimationFrame(syncBounds)
  }, [syncBounds])

  const attemptScrollRestore = useCallback(async () => {
    const id = browserIdRef.current
    const current = stateRef.current
    const targetState = restoreScrollStateRef.current
    if (!id || !current || !targetState) return
    if (!shouldAttemptHtmlPreviewScrollRestore({
      activeBrowserId: id,
      expectedBrowserId: current.browserId,
      activeReloadKey: current.reloadKey,
      expectedReloadKey: reloadKey,
      targetNavigationConfirmed: targetNavigationConfirmedRef.current,
      loadSettled: targetLoadSettledRef.current,
      zoomApplied: zoomAppliedRef.current,
      hasTargetState: true,
      restoreInFlight: restoreInFlightRef.current,
      restored: restoredReloadKeyRef.current === current.reloadKey
    })) return

    const generation = restoreGenerationRef.current
    restoreInFlightRef.current = true
    updateState({ scrollRestoreStatus: 'restoring', restoredScrollY: null })
    try {
      const result = await window.electronAPI.browser.restoreScrollState(id, targetState)
      const latest = stateRef.current
      if (
        restoreGenerationRef.current !== generation
        || browserIdRef.current !== id
        || latest?.browserId !== id
        || latest.reloadKey !== reloadKey
      ) return

      const restoredState = normalizeHtmlPreviewScrollState(result.state)
      if (result.success && isHtmlPreviewScrollRestoreVerified(targetState.y, restoredState)) {
        restoredReloadKeyRef.current = reloadKey
        updateState({
          scrollRestoreStatus: 'restored',
          restoredScrollY: restoredState?.y ?? null
        })
        return
      }
      updateState({
        scrollRestoreStatus: 'failed',
        restoredScrollY: restoredState?.y ?? null
      })
    } catch {
      if (restoreGenerationRef.current === generation && browserIdRef.current === id) {
        updateState({ scrollRestoreStatus: 'failed', restoredScrollY: null })
      }
    } finally {
      if (restoreGenerationRef.current === generation && browserIdRef.current === id) {
        restoreInFlightRef.current = false
      }
    }
  }, [reloadKey, updateState])

  useEffect(() => {
    isActiveRef.current = isActive
    scheduleSyncBounds()
  }, [isActive, scheduleSyncBounds])

  useEffect(() => {
    zoomFactorRef.current = normalizeHtmlPreviewZoomFactor(zoomFactor)
  }, [zoomFactor])

  useEffect(() => {
    restoreScrollStateRef.current = normalizeHtmlPreviewScrollState(restoreScrollState)
    if (!restoreScrollStateRef.current) {
      updateState({ scrollRestoreStatus: 'idle', restoredScrollY: null })
      return
    }
    if (restoredReloadKeyRef.current !== reloadKey) {
      updateState({ scrollRestoreStatus: 'waiting', restoredScrollY: null })
    }
    void attemptScrollRestore()
  }, [attemptScrollRestore, reloadKey, restoreScrollState, updateState])

  useEffect(() => {
    const id = `project-editor-html-${++htmlReaderIdCounter}`
    const generation = restoreGenerationRef.current + 1
    restoreGenerationRef.current = generation
    browserIdRef.current = id
    restoredReloadKeyRef.current = null
    targetNavigationConfirmedRef.current = false
    targetLoadSettledRef.current = false
    zoomAppliedRef.current = false
    restoreInFlightRef.current = false
    const initialState: HtmlReaderState = {
      browserId: id,
      filePath,
      url,
      title: '',
      ready: false,
      visible: false,
      isLoading: true,
      loadCount: 0,
      reloadKey,
      canGoBack: false,
      canGoForward: false,
      error: null,
      scrollRestoreStatus: restoreScrollStateRef.current ? 'waiting' : 'idle',
      restoredScrollY: null
    }
    stateRef.current = initialState
    setState(initialState)
    onStateChange?.(initialState)

    void (async () => {
      try {
        const result = await window.electronAPI.browser.create(id, url, { allowFile: true, fileRoot: rootPath })
        if (restoreGenerationRef.current !== generation || browserIdRef.current !== id) return
        if (!result.success) {
          updateState({ ready: false, isLoading: false, error: result.error ?? 'Failed to create HTML Preview' })
          return
        }

        const zoomResult = await window.electronAPI.browser.setZoomFactor(id, zoomFactorRef.current)
        if (restoreGenerationRef.current !== generation || browserIdRef.current !== id) return
        zoomAppliedRef.current = Boolean(zoomResult.success)

        const nav = await window.electronAPI.browser.getNavState(id)
        if (restoreGenerationRef.current !== generation || browserIdRef.current !== id) return
        if (nav) {
          const isTargetDocument = isSameHtmlPreviewFile(nav.url, url)
          targetNavigationConfirmedRef.current = isTargetDocument
          targetLoadSettledRef.current = isTargetDocument && !nav.isLoading
          updateState({
            url: nav.url,
            title: nav.title,
            ready: true,
            isLoading: nav.isLoading,
            loadCount: isTargetDocument && !nav.isLoading ? 1 : 0,
            canGoBack: nav.canGoBack,
            canGoForward: nav.canGoForward
          })
        } else {
          updateState({ ready: true })
        }
        void attemptScrollRestore()
        requestAnimationFrame(() => {
          syncBounds()
          requestAnimationFrame(syncBounds)
        })
      } catch (error) {
        if (restoreGenerationRef.current !== generation || browserIdRef.current !== id) return
        updateState({ ready: false, isLoading: false, error: String(error) })
      }
    })()

    return () => {
      restoreGenerationRef.current += 1
      browserIdRef.current = null
      targetNavigationConfirmedRef.current = false
      targetLoadSettledRef.current = false
      zoomAppliedRef.current = false
      restoreInFlightRef.current = false
      stateRef.current = null
      setState(null)
      onStateChange?.(null)
      window.electronAPI.browser.destroy(id).catch(() => {
        // Ignore destroy races during teardown.
      })
      if (rafRef.current) {
        cancelAnimationFrame(rafRef.current)
        rafRef.current = 0
      }
    }
  }, [attemptScrollRestore, filePath, onStateChange, reloadKey, rootPath, syncBounds, updateState, url])

  useEffect(() => {
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
        rafRef.current = 0
      }
    }
  }, [scheduleSyncBounds])

  useEffect(() => {
    const unsubUrl = window.electronAPI.browser.onUrlChanged((id, nextUrl) => {
      if (id !== browserIdRef.current) return
      const isTargetDocument = isSameHtmlPreviewFile(nextUrl, url)
      targetNavigationConfirmedRef.current = isTargetDocument
      targetLoadSettledRef.current = false
      updateState({ url: nextUrl })
    })
    const unsubTitle = window.electronAPI.browser.onTitleChanged((id, nextTitle) => {
      if (id !== browserIdRef.current) return
      updateState({ title: nextTitle })
    })
    const unsubLoading = window.electronAPI.browser.onLoadingChanged((id, loading) => {
      if (id !== browserIdRef.current) return
      const current = stateRef.current
      targetLoadSettledRef.current = !loading && targetNavigationConfirmedRef.current
      updateState({
        isLoading: loading,
        loadCount: !loading && current ? current.loadCount + 1 : current?.loadCount ?? 0
      })
      if (!loading) void attemptScrollRestore()
    })
    const unsubNav = window.electronAPI.browser.onNavStateChanged((id, navState) => {
      if (id !== browserIdRef.current) return
      updateState({ canGoBack: navState.canGoBack, canGoForward: navState.canGoForward })
    })
    const unsubEscape = window.electronAPI.browser.onEscapePressed((id) => {
      if (id !== browserIdRef.current) return
      onEscape()
    })

    return () => {
      unsubUrl()
      unsubTitle()
      unsubLoading()
      unsubNav()
      unsubEscape()
    }
  }, [attemptScrollRestore, onEscape, updateState, url])

  return (
    <div className="project-editor-html-reader" data-file-path={filePath}>
      <div ref={placeholderRef} className="project-editor-html-placeholder">
        {(!state?.ready || state?.isLoading || state?.error) && (
          <div className={state?.error ? 'project-editor-html-error' : 'project-editor-html-loading'}>
            {state?.error ? t('projectEditor.htmlPreviewError') : t('projectEditor.loading')}
            {!state?.error && <span className="preview-loading-dots mini"><span /><span /><span /></span>}
          </div>
        )}
      </div>
    </div>
  )
}
