/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { useI18n } from '../../i18n/useI18n'
import type { BrowserFoundInPageResult } from '../../types/electron'
import type { HtmlPreviewScrollState } from '../../utils/html-file'
import {
  getHtmlPreviewController,
  isHtmlPreviewBridgeMessage,
  registerHtmlPreviewController,
  type HtmlPreviewController
} from '../../utils/html-preview-bridge'

export type HtmlReaderScrollRestoreStatus = 'idle' | 'waiting' | 'restoring' | 'restored' | 'failed'

export type HtmlReaderState = {
  browserId: string
  filePath: string
  url: string
  homeUrl: string
  title: string
  ready: boolean
  visible: boolean
  isLoading: boolean
  loadCount: number
  reloadKey: number
  canGoBack: boolean
  canGoForward: boolean
  error: string | null
  // Round-trip scroll-restore reporting (re-ported from the diff-jump-to-editor
  // feature onto the iframe architecture): lets ProjectEditor's autotest
  // inspection API observe whether the scroll offset was restored after a
  // subpage jump returns to this HTML file. Functionally driven by
  // applyPendingScrollRestore below.
  scrollRestoreStatus: HtmlReaderScrollRestoreStatus
  restoredScrollY: number | null
}

interface HtmlReaderProps {
  rootPath: string
  filePath: string
  reloadKey: number
  isActive: boolean
  restoreScrollState?: HtmlPreviewScrollState | null
  onEscape: () => void
  onFoundInPage: (result: BrowserFoundInPageResult) => void
  onFindShortcut: () => void
  onReloadShortcut: () => void
  onZoomShortcut: (direction: 'in' | 'out' | 'reset') => void
  onStateChange?: (state: HtmlReaderState | null) => void
}

type PendingRequest = {
  resolve: (value: CommandResult) => void
  timeout: number
}

type CommandResult = { success: boolean; value?: unknown; error?: string }

let htmlReaderIdCounter = 0

export function HtmlReader({
  rootPath,
  filePath,
  reloadKey,
  isActive,
  restoreScrollState,
  onEscape,
  onFoundInPage,
  onFindShortcut,
  onReloadShortcut,
  onZoomShortcut,
  onStateChange
}: HtmlReaderProps) {
  const { t } = useI18n()
  const [state, setState] = useState<HtmlReaderState | null>(null)
  const [frameUrl, setFrameUrl] = useState<string | null>(null)
  const frameRef = useRef<HTMLIFrameElement>(null)
  const browserIdRef = useRef<string | null>(null)
  const sessionIdRef = useRef<string | null>(null)
  const isActiveRef = useRef(isActive)
  const homeUrlRef = useRef<string>('')
  const stateRef = useRef<HtmlReaderState | null>(null)
  const restoreScrollStateRef = useRef<HtmlPreviewScrollState | null>(restoreScrollState ?? null)
  const restoredScrollTargetRef = useRef<string | null>(null)
  const restoringScrollTargetRef = useRef<string | null>(null)
  const historyRef = useRef<string[]>([])
  const historyIndexRef = useRef(0)
  const pendingRequestsRef = useRef(new Map<string, PendingRequest>())
  const requestCounterRef = useRef(0)

  const updateState = useCallback((patch: Partial<HtmlReaderState>) => {
    const current = stateRef.current
    if (!current) return
    const next = { ...current, ...patch }
    stateRef.current = next
    setState(next)
    onStateChange?.(next)
  }, [onStateChange])

  const navigateFrame = useCallback((nextUrl: string, mode: 'push' | 'replace' | 'history') => {
    if (mode === 'push') {
      const nextHistory = historyRef.current.slice(0, historyIndexRef.current + 1)
      nextHistory.push(nextUrl)
      historyRef.current = nextHistory
      historyIndexRef.current = nextHistory.length - 1
    } else if (mode === 'replace') {
      historyRef.current[historyIndexRef.current] = nextUrl
    }
    setFrameUrl(nextUrl)
    updateState({
      url: nextUrl,
      isLoading: true,
      canGoBack: historyIndexRef.current > 0,
      canGoForward: historyIndexRef.current < historyRef.current.length - 1
    })
  }, [updateState])

  const sendCommand = useCallback((command: string, payload?: unknown): Promise<CommandResult> => {
    const frameWindow = frameRef.current?.contentWindow
    const sessionId = sessionIdRef.current
    if (!frameWindow || !sessionId) {
      return Promise.resolve({ success: false, error: 'HTML Preview frame is not ready' })
    }
    const requestId = `${sessionId}-${++requestCounterRef.current}`
    return new Promise<CommandResult>((resolve) => {
      const timeout = window.setTimeout(() => {
        pendingRequestsRef.current.delete(requestId)
        resolve({ success: false, error: `HTML Preview command timed out: ${command}` })
      }, 5000)
      pendingRequestsRef.current.set(requestId, { resolve, timeout })
      frameWindow.postMessage({
        marker: 'onward-html-preview',
        version: 1,
        sessionId,
        type: 'command',
        requestId,
        command,
        payload
      }, '*')
    })
  }, [])

  const applyPendingScrollRestore = useCallback(async () => {
    const current = stateRef.current
    const target = restoreScrollStateRef.current
    if (!current?.ready || !target) return
    const restoreTarget = `${current.browserId}:${current.reloadKey}:${target.x}:${target.y}`
    if (restoredScrollTargetRef.current === restoreTarget || restoringScrollTargetRef.current === restoreTarget) return
    const controller = getHtmlPreviewController(browserIdRef.current)
    if (!controller) return
    restoringScrollTargetRef.current = restoreTarget
    updateState({ scrollRestoreStatus: 'restoring', restoredScrollY: null })
    try {
      const result = await controller.restoreScrollState(target)
      if (stateRef.current?.browserId !== current.browserId) return
      if (result.success) {
        restoredScrollTargetRef.current = restoreTarget
        updateState({
          scrollRestoreStatus: 'restored',
          restoredScrollY: result.state?.y ?? target.y
        })
      } else {
        updateState({ scrollRestoreStatus: 'failed', restoredScrollY: null })
      }
    } catch {
      if (stateRef.current?.browserId === current.browserId) {
        updateState({ scrollRestoreStatus: 'failed', restoredScrollY: null })
      }
    } finally {
      if (restoringScrollTargetRef.current === restoreTarget) restoringScrollTargetRef.current = null
    }
  }, [updateState])

  useEffect(() => {
    restoreScrollStateRef.current = restoreScrollState ?? null
    if (restoreScrollState) {
      if (restoredScrollTargetRef.current === null) {
        updateState({ scrollRestoreStatus: 'waiting', restoredScrollY: null })
      }
      window.setTimeout(() => void applyPendingScrollRestore(), 0)
    } else {
      updateState({ scrollRestoreStatus: 'idle', restoredScrollY: null })
    }
  }, [applyPendingScrollRestore, restoreScrollState, updateState])

  useEffect(() => {
    isActiveRef.current = isActive
    updateState({ visible: isActive })
  }, [isActive, updateState])

  useEffect(() => {
    const id = `project-editor-html-${++htmlReaderIdCounter}`
    browserIdRef.current = id
    let disposed = false
    let unregisterController: (() => void) | null = null

    const initialState: HtmlReaderState = {
      browserId: id,
      filePath,
      url: '',
      homeUrl: '',
      title: '',
      ready: false,
      visible: isActiveRef.current,
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

    void window.electronAPI.htmlPreview.createSession(rootPath, filePath, reloadKey).then((result) => {
      if (disposed || browserIdRef.current !== id) {
        if (result.sessionId) void window.electronAPI.htmlPreview.releaseSession(result.sessionId)
        return
      }
      if (!result.success || !result.sessionId || !result.url) {
        updateState({ ready: false, isLoading: false, error: result.error ?? 'Failed to create HTML Preview' })
        return
      }
      const { sessionId, url: previewUrl } = result
      sessionIdRef.current = sessionId
      homeUrlRef.current = previewUrl
      historyRef.current = [previewUrl]
      historyIndexRef.current = 0
      setFrameUrl(previewUrl)
      updateState({ url: previewUrl, homeUrl: previewUrl, visible: isActiveRef.current })

      const controller: HtmlPreviewController = {
        goBack: async () => {
          if (historyIndexRef.current <= 0) return false
          historyIndexRef.current -= 1
          navigateFrame(historyRef.current[historyIndexRef.current], 'history')
          return true
        },
        goForward: async () => {
          if (historyIndexRef.current >= historyRef.current.length - 1) return false
          historyIndexRef.current += 1
          navigateFrame(historyRef.current[historyIndexRef.current], 'history')
          return true
        },
        reload: async () => {
          const result = await sendCommand('reload')
          if (result.success) updateState({ isLoading: true })
          return result.success
        },
        home: async () => {
          if (!homeUrlRef.current) return false
          navigateFrame(homeUrlRef.current, 'push')
          return true
        },
        getScrollState: async () => {
          const result = await sendCommand('get-scroll')
          return result.success
            ? { success: true, state: result.value as HtmlPreviewScrollState }
            : { success: false, error: result.error }
        },
        restoreScrollState: async (scrollState) => {
          const result = await sendCommand('restore-scroll', scrollState)
          return result.success
            ? { success: true, state: result.value as HtmlPreviewScrollState }
            : { success: false, error: result.error }
        },
        findInPage: async (text, options) => {
          const result = await sendCommand('find', { text, ...options })
          const value = result.value as BrowserFoundInPageResult | undefined
          return result.success
            ? { success: true, requestId: value?.requestId }
            : { success: false, error: result.error }
        },
        stopFindInPage: async () => (await sendCommand('stop-find')).success,
        getZoomFactor: async () => {
          const zoomFactor = Number(frameRef.current?.dataset.zoomFactor ?? '1')
          return { success: true, zoomFactor }
        },
        setZoomFactor: async (zoomFactor) => {
          const result = await sendCommand('zoom', { zoomFactor })
          if (result.success && frameRef.current) frameRef.current.dataset.zoomFactor = String(zoomFactor)
          return result.success
            ? { success: true, zoomFactor: Number(result.value) }
            : { success: false, error: result.error }
        },
        evaluateForTest: async (script) => sendCommand('evaluate', { script })
      }
      unregisterController = registerHtmlPreviewController(id, controller)
      void applyPendingScrollRestore()
    }).catch((error) => {
      if (!disposed) updateState({ ready: false, isLoading: false, error: String(error) })
    })

    return () => {
      disposed = true
      unregisterController?.()
      const sessionId = sessionIdRef.current
      if (sessionId) void window.electronAPI.htmlPreview.releaseSession(sessionId)
      for (const pending of pendingRequestsRef.current.values()) {
        window.clearTimeout(pending.timeout)
        pending.resolve({ success: false, error: 'HTML Preview was closed' })
      }
      pendingRequestsRef.current.clear()
      browserIdRef.current = null
      sessionIdRef.current = null
      stateRef.current = null
      onStateChange?.(null)
    }
  }, [applyPendingScrollRestore, filePath, navigateFrame, onStateChange, reloadKey, rootPath, sendCommand, updateState])

  useEffect(() => {
    const handleMessage = (event: MessageEvent) => {
      const sessionId = sessionIdRef.current
      if (!sessionId || event.source !== frameRef.current?.contentWindow || !isHtmlPreviewBridgeMessage(event.data, sessionId)) return
      const message = event.data
      if (message.type === 'response' && message.requestId) {
        const pending = pendingRequestsRef.current.get(message.requestId)
        if (!pending) return
        pendingRequestsRef.current.delete(message.requestId)
        window.clearTimeout(pending.timeout)
        pending.resolve({ success: Boolean(message.success), value: message.value, error: message.error })
        return
      }
      if (message.type === 'state') {
        const payload = (message.payload ?? {}) as { url?: string; title?: string; readyState?: string }
        const current = stateRef.current
        updateState({
          url: payload.url ?? current?.url ?? '',
          title: payload.title ?? '',
          ready: true,
          isLoading: payload.readyState === 'loading',
          error: null,
          canGoBack: historyIndexRef.current > 0,
          canGoForward: historyIndexRef.current < historyRef.current.length - 1
        })
        return
      }
      if (message.type === 'navigate-request') {
        const nextUrl = (message.payload as { url?: unknown } | undefined)?.url
        if (typeof nextUrl !== 'string') return
        void window.electronAPI.htmlPreview.validateNavigation(sessionId, nextUrl).then((allowed) => {
          if (allowed && sessionIdRef.current === sessionId) navigateFrame(nextUrl, 'push')
        })
        return
      }
      if (message.type === 'found-in-page') {
        onFoundInPage(message.payload as BrowserFoundInPageResult)
      } else if (message.type === 'find-shortcut') {
        onFindShortcut()
      } else if (message.type === 'reload-shortcut') {
        onReloadShortcut()
      } else if (message.type === 'zoom-shortcut') {
        const direction = (message.payload as { direction?: unknown } | undefined)?.direction
        if (direction === 'in' || direction === 'out' || direction === 'reset') onZoomShortcut(direction)
      } else if (message.type === 'escape') {
        onEscape()
      }
    }
    window.addEventListener('message', handleMessage)
    return () => window.removeEventListener('message', handleMessage)
  }, [navigateFrame, onEscape, onFindShortcut, onFoundInPage, onReloadShortcut, onZoomShortcut, updateState])

  const handleFrameLoad = useCallback(() => {
    const current = stateRef.current
    updateState({
      ready: true,
      isLoading: false,
      loadCount: (current?.loadCount ?? 0) + 1,
      error: null
    })
    window.setTimeout(() => void applyPendingScrollRestore(), 50)
  }, [applyPendingScrollRestore, updateState])

  return (
    <div className="project-editor-html-reader" data-file-path={filePath}>
      {frameUrl && (
        <iframe
          ref={frameRef}
          className="project-editor-html-preview-frame"
          src={frameUrl}
          sandbox="allow-scripts allow-same-origin allow-forms allow-modals allow-popups-to-escape-sandbox"
          onLoad={handleFrameLoad}
          onError={() => updateState({ ready: false, isLoading: false, error: 'Failed to load HTML Preview frame' })}
          title={state?.title || filePath}
          hidden={!isActive}
        />
      )}
      {(!state?.ready || state?.isLoading || state?.error) && (
        <div className={state?.error ? 'project-editor-html-error' : 'project-editor-html-loading'}>
          {state?.error ? t('projectEditor.htmlPreviewError') : t('projectEditor.loading')}
          {!state?.error && <span className="preview-loading-dots mini"><span /><span /><span /></span>}
        </div>
      )}
    </div>
  )
}
