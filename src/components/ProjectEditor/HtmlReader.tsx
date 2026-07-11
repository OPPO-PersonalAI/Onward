/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { useI18n } from '../../i18n/useI18n'
import type { HtmlPreviewScrollState } from '../../utils/html-file'

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
}

interface HtmlReaderProps {
  url: string
  rootPath: string
  filePath: string
  reloadKey: number
  isActive: boolean
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
  const restoredReloadKeyRef = useRef<number | null>(null)

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

  useEffect(() => {
    isActiveRef.current = isActive
    scheduleSyncBounds()
  }, [isActive, scheduleSyncBounds])

  useEffect(() => {
    restoreScrollStateRef.current = restoreScrollState ?? null
  }, [restoreScrollState])

  useEffect(() => {
    const id = `project-editor-html-${++htmlReaderIdCounter}`
    browserIdRef.current = id
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
      error: null
    }
    stateRef.current = initialState
    setState(initialState)
    onStateChange?.(initialState)

    window.electronAPI.browser.create(id, url, { allowFile: true, fileRoot: rootPath }).then((result) => {
      if (browserIdRef.current !== id) return
      if (!result.success) {
        updateState({ ready: false, isLoading: false, error: result.error ?? 'Failed to create HTML Preview' })
        return
      }
      updateState({ ready: true })
      // Seed nav state once; onNavStateChanged keeps it fresh afterwards.
      void window.electronAPI.browser.getNavState(id).then((nav) => {
        if (browserIdRef.current !== id || !nav) return
        updateState({ canGoBack: nav.canGoBack, canGoForward: nav.canGoForward })
      }).catch(() => {
        // Nav state stays at its safe default (both disabled) on failure.
      })
      requestAnimationFrame(() => {
        syncBounds()
        requestAnimationFrame(syncBounds)
      })
    }).catch((error) => {
      if (browserIdRef.current !== id) return
      updateState({ ready: false, isLoading: false, error: String(error) })
    })

    return () => {
      browserIdRef.current = null
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
  }, [filePath, onStateChange, reloadKey, rootPath, syncBounds, updateState, url])

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
      updateState({ url: nextUrl })
    })
    const unsubTitle = window.electronAPI.browser.onTitleChanged((id, nextTitle) => {
      if (id !== browserIdRef.current) return
      updateState({ title: nextTitle })
    })
    const unsubLoading = window.electronAPI.browser.onLoadingChanged((id, loading) => {
      if (id !== browserIdRef.current) return
      const current = stateRef.current
      updateState({
        isLoading: loading,
        loadCount: !loading && current ? current.loadCount + 1 : current?.loadCount ?? 0
      })
      if (!loading && current && restoredReloadKeyRef.current !== current.reloadKey) {
        const targetState = restoreScrollStateRef.current
        if (targetState) {
          restoredReloadKeyRef.current = current.reloadKey
          window.setTimeout(() => {
            const browserId = browserIdRef.current
            if (!browserId || browserId !== id) return
            void window.electronAPI.browser.restoreScrollState(browserId, targetState)
          }, 50)
        }
      }
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
  }, [onEscape, updateState])

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
