/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { useI18n } from '../../i18n/useI18n'
import { trackFeatureUse } from '../../telemetry/track-feature-use'
import { perfTraceDiagnostic } from '../../utils/perf-trace'
import { PERF_TRACE_EVENT } from '../../utils/perf-trace-names'
import type { BrowserFoundInPageResult } from '../../types/electron'
import { isSameHtmlPreviewFile } from '../../utils/html-file'
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
  // A clicked link resolved to a project file that is not an HTML document —
  // the host opens it in the matching Project Editor viewer instead of
  // navigating the iframe (which cannot render it).
  onOpenProjectFile?: (target: { relativePath: string; filePath: string }) => void
  // A clicked link resolved to an external http(s) URL. The iframe must NEVER
  // navigate there (most sites forbid framing via CSP frame-ancestors — the
  // white-screen bug); the host hands the URL to the Open Browser panel.
  onOpenExternalUrl?: (url: string) => void
  // mailto:/tel: — the host routes these to the OS default handler.
  onOpenExternalProtocol?: (url: string) => void
  // A clicked link was refused by the session's path policy.
  onBlockedNavigation?: (reason: 'outside-root' | 'invalid') => void
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
  onStateChange,
  onOpenProjectFile,
  onOpenExternalUrl,
  onOpenExternalProtocol,
  onBlockedNavigation
}: HtmlReaderProps) {
  const { t } = useI18n()

  // Product telemetry: count once per HTML preview open (mount), never per re-render.
  useEffect(() => { trackFeatureUse('html-preview') }, [])

  const [state, setState] = useState<HtmlReaderState | null>(null)
  const [frameUrl, setFrameUrl] = useState<string | null>(null)
  const frameRef = useRef<HTMLIFrameElement>(null)
  const browserIdRef = useRef<string | null>(null)
  const sessionIdRef = useRef<string | null>(null)
  const isActiveRef = useRef(isActive)
  const homeUrlRef = useRef<string>('')
  // The URL the iframe src attribute currently carries. React skips the
  // attribute write when the value is unchanged, so a navigation to this
  // exact URL would never produce a load event — callers must branch.
  const frameUrlRef = useRef<string | null>(null)
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
    frameUrlRef.current = nextUrl
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
        const firstY = result.state?.y ?? target.y
        const tolerance = 2
        perfTraceDiagnostic(PERF_TRACE_EVENT.RENDERER_PROJECT_EDITOR_HTML_SCROLL_APPLY, {
          ph: 'i',
          attempt: 0,
          targetY: Math.round(target.y),
          appliedY: Math.round(firstY),
          converged: Math.abs(firstY - target.y) <= tolerance
        })
        if (Math.abs(firstY - target.y) <= tolerance) {
          updateState({ scrollRestoreStatus: 'restored', restoredScrollY: firstY })
        } else {
          // Chromium 150 (Electron 43): at apply time the custom-protocol
          // document may not have finished layout, so scrollTo clamps to the
          // current (short) max scroll — and a post-load async reset can undo
          // an apply that DID land. A clamped apply is NOT a completed
          // restore: stay in 'restoring', re-pin over a bounded settle
          // window, and only report 'restored' once the offset converges
          // (or with the truthful best-effort value when retries end).
          void (async () => {
            let lastY = firstY
            let attempt = 0
            for (const delayMs of [150, 400, 800, 1500]) {
              await new Promise((resolve) => window.setTimeout(resolve, delayMs))
              if (stateRef.current?.browserId !== current.browserId) return
              if (restoredScrollTargetRef.current !== restoreTarget) return
              attempt += 1
              const repin = await controller.restoreScrollState(target)
              if (repin.success && repin.state) {
                lastY = repin.state.y
              }
              perfTraceDiagnostic(PERF_TRACE_EVENT.RENDERER_PROJECT_EDITOR_HTML_SCROLL_APPLY, {
                ph: 'i',
                attempt,
                targetY: Math.round(target.y),
                appliedY: repin.success && repin.state ? Math.round(repin.state.y) : null,
                converged: Math.abs(lastY - target.y) <= tolerance
              })
              if (repin.success && repin.state && Math.abs(lastY - target.y) <= tolerance) break
            }
            if (stateRef.current?.browserId !== current.browserId) return
            if (restoredScrollTargetRef.current !== restoreTarget) return
            updateState({ scrollRestoreStatus: 'restored', restoredScrollY: lastY })
          })()
        }
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
    const wasActive = isActiveRef.current
    isActiveRef.current = isActive
    updateState({ visible: isActive })
    if (isActive && !wasActive) {
      // Chromium 150 (Electron 43): a frame that was hidden/detached while
      // the editor was soft-closed comes back with its scroll reset to 0 —
      // a restore completed before the round-trip is no longer standing.
      // Drop the completed-restore guard and re-pin the pending offset
      // whenever the reader surface returns.
      restoredScrollTargetRef.current = null
      window.setTimeout(() => void applyPendingScrollRestore(), 0)
    }
  }, [isActive, applyPendingScrollRestore, updateState])

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
      frameUrlRef.current = previewUrl
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
      frameUrlRef.current = null
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
        // A non-complete readyState announces a FRESH document in the frame
        // (Electron 43: the custom-protocol frame can bring up its document
        // again after a restore already landed on the previous one — the new
        // document renders from the top). The completed-restore guard belongs
        // to the old document: clear it and reschedule the pending restore.
        // Home-document only — a foreign page navigated via links must never
        // inherit the home offset.
        if (
          payload.readyState !== 'complete' &&
          isSameHtmlPreviewFile(payload.url ?? null, homeUrlRef.current || null)
        ) {
          restoredScrollTargetRef.current = null
          window.setTimeout(() => void applyPendingScrollRestore(), 0)
        }
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
        void window.electronAPI.htmlPreview.classifyNavigation(sessionId, nextUrl).then((classification) => {
          if (sessionIdRef.current !== sessionId) return
          if (classification.kind === 'project-file') {
            // A non-HTML project file cannot render inside the iframe (the
            // protocol serves it as octet-stream and the sandbox blocks the
            // download) — hand it to the Project Editor's viewer dispatch.
            perfTraceDiagnostic(PERF_TRACE_EVENT.RENDERER_PROJECT_EDITOR_PREVIEW_LINK_OPEN_FILE, {
              ph: 'i',
              sourceKind: 'html',
              ext: (classification.relativePath.split('.').pop() ?? '').slice(0, 16)
            })
            onOpenProjectFile?.({
              relativePath: classification.relativePath,
              filePath: classification.filePath
            })
            return
          }
          if (classification.kind === 'outside-root' || classification.kind === 'invalid') {
            perfTraceDiagnostic(PERF_TRACE_EVENT.RENDERER_PROJECT_EDITOR_PREVIEW_LINK_BLOCKED, {
              ph: 'i',
              sourceKind: 'html',
              reason: classification.kind === 'invalid'
                ? `invalid:${classification.reason}`.slice(0, 64)
                : 'outside-root'
            })
            onBlockedNavigation?.(classification.kind)
            return
          }
          if (classification.kind === 'external') {
            onOpenExternalUrl?.(nextUrl)
            return
          }
          if (classification.kind === 'external-protocol') {
            onOpenExternalProtocol?.(nextUrl)
            return
          }
          // 'in-frame' HTML documents keep browser-style iframe navigation
          // through the preview protocol (file:// links arrive rebuilt).
          const nextFrameUrl = classification.url
          if (frameUrlRef.current === nextFrameUrl) {
            // React will not rewrite an unchanged src attribute, so pushing
            // this URL would navigate nothing and no load event would ever
            // clear the spinner. Match browser semantics: reload in place.
            perfTraceDiagnostic(PERF_TRACE_EVENT.RENDERER_PROJECT_EDITOR_HTML_SAME_URL_RELOAD, { ph: 'i' })
            updateState({ isLoading: true })
            void sendCommand('reload')
            return
          }
          navigateFrame(nextFrameUrl, 'push')
        })
        return
      }
      if (message.type === 'anchor-scroll') {
        // In-page anchor clicks are handled entirely inside the bridge
        // (programmatic scroll, no host navigation, no history entry); this
        // breadcrumb is the host-side evidence that the jump fired.
        const payload = (message.payload ?? {}) as { hash?: unknown; found?: unknown }
        perfTraceDiagnostic(PERF_TRACE_EVENT.RENDERER_PROJECT_EDITOR_HTML_ANCHOR_SCROLL, {
          ph: 'i',
          hash: typeof payload.hash === 'string' ? payload.hash.slice(0, 64) : null,
          found: Boolean(payload.found)
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
  }, [navigateFrame, onBlockedNavigation, onEscape, onFindShortcut, onFoundInPage, onOpenExternalProtocol, onOpenExternalUrl, onOpenProjectFile, onReloadShortcut, onZoomShortcut, sendCommand, updateState])

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
