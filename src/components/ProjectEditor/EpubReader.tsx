/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react'
import ePub from 'epubjs'
import { trackFeatureUse } from '../../telemetry/track-feature-use'
import type { Book, NavItem, Rendition } from 'epubjs'
import { useI18n } from '../../i18n/useI18n'
import { perfTraceDiagnostic } from '../../utils/perf-trace'
import { PERF_TRACE_EVENT } from '../../utils/perf-trace-names'
import { redispatchReaderHostKey, shouldForwardReaderHostKey } from '../../utils/readerHostKey'
import type { OutlineItem } from './Outline/types'
import { OutlineSymbolKind } from './Outline/types'
import {
  acceptEpubRelocation,
  beginEpubDisplayAttempt,
  beginEpubReaderSession,
  createSerialEpubTaskCoordinator,
  disposeEpubReaderSession,
  isCurrentEpubSessionEvent,
  isEpubFrameContentReady,
  shouldPersistEpubScroll,
  settleEpubDisplayAttempt,
  type EpubReaderSessionState
} from './epubReaderState'

interface EpubReaderProps {
  /**
   * .epub bytes already fetched by ProjectEditor (host-side `fetch(file://...)`).
   * Passed in as ArrayBuffer so this component's mount path is purely
   * synchronous — async work inside the useEffect was observed to widen the
   * layout-race window around epub.js's first display(). Replaces the
   * previous main-process base64 path and removes the 64 MB cap.
   */
  previewBuffer: ArrayBuffer
  filePath: string
  /** Optional per-file memory restored by the host. */
  initialFontPct?: number
  initialLocation?: string | null
  /** Precise scroll offset captured last time the file was open. Applied after
   * rendition.display() settles so restore lands pixel-exactly, not just on
   * the correct chapter. */
  initialScrollTop?: number
  /** Invoked when the user changes a persistable setting. */
  onMemoryChange?: (patch: {
    epubFontPct?: number
    epubLocation?: string | null
    epubScrollTop?: number
  }) => void
  /** Fires once after book.loaded.navigation with the TOC as OutlineItem[]. */
  onOutlineLoaded?: (items: OutlineItem[]) => void
  /** Fires when the rendition settles on a new chapter. Href is fragment-free. */
  onLocationChange?: (href: string | null) => void
}

export interface EpubReaderHandle {
  /** Navigate to a chapter by its spine href (fragment-free form is fine). */
  goToHref(href: string): void
}

export interface EpubReaderProgress {
  sessionId: number
  filePath: string
  stateReady: boolean
  latestAttemptId: number
  settledAttemptId: number | null
  readyAttemptId: number | null
  latestTarget: string | null
  displayStarted: number
  displayResolved: number | null
  displayRejected: string | null
  containerWidth: number
  containerHeight: number
  lastBookOpened: boolean
  lastLocationHref: string | null
  lastLocationCfi: string | null
  appliedFontPct: number | null
}

type EpubNavigationRequest =
  | { kind: 'display'; target?: string; reason: 'initial' | 'outline' | 'font' | 'search'; restoreScroll?: boolean }
  | { kind: 'font'; target?: string; fontPct: number; reason: 'font' }
  | { kind: 'previous'; reason: 'toolbar' }
  | { kind: 'next'; reason: 'toolbar' }

type EpubNavigationRequester = (request: EpubNavigationRequest) => Promise<void>

type EpubSearchHit = {
  cfi: string
  excerpt: string
  href?: string
  label?: string
}

const MIN_FONT_PCT = 70
const MAX_FONT_PCT = 200
const FONT_STEP = 10
const RENDITION_RECOVERY_DELAY_MS = 4000
const MAX_RENDITION_RECOVERY_ATTEMPTS = 2

let nextEpubReaderSessionId = 0

function readEpubFrameSnapshot(container: HTMLElement | null): {
  hasFrame: boolean
  bodyChildCount: number
  bodyTextLength: number
} {
  const iframe = container?.querySelector<HTMLIFrameElement>('iframe') ?? null
  if (!iframe) {
    return { hasFrame: false, bodyChildCount: 0, bodyTextLength: 0 }
  }
  try {
    const body = iframe.contentDocument?.body ?? null
    return {
      hasFrame: true,
      bodyChildCount: body?.childElementCount ?? 0,
      bodyTextLength: body?.textContent?.trim().length ?? 0
    }
  } catch {
    return { hasFrame: true, bodyChildCount: 0, bodyTextLength: 0 }
  }
}

function collectHostTheme(): { background: string; foreground: string; accent: string; muted: string; panel: string } {
  const style = window.getComputedStyle(document.documentElement)
  const read = (name: string, fallback: string) => {
    const v = style.getPropertyValue(name).trim()
    return v || fallback
  }
  return {
    background: read('--background', '#0a0a0a'),
    foreground: read('--text', '#f0f0f0'),
    accent: read('--accent', '#7d8796'),
    muted: read('--muted', '#a9a9a9'),
    panel: read('--panel', '#121212')
  }
}

function clampFontPct(v: number | undefined | null): number {
  const n = typeof v === 'number' && Number.isFinite(v) ? v : 100
  return Math.max(MIN_FONT_PCT, Math.min(MAX_FONT_PCT, n))
}

// Strip trailing fragment (#...) so activeHref comparisons match the href
// shape we store in OutlineItem.target.
function stripFragment(href: string | undefined | null): string | null {
  if (!href) return null
  const hashIdx = href.indexOf('#')
  return hashIdx === -1 ? href : href.slice(0, hashIdx)
}

function flattenNavItems(items: NavItem[], depth = 0): OutlineItem[] {
  return items.map((item) => {
    const children = (item.subitems && item.subitems.length > 0)
      ? flattenNavItems(item.subitems, depth + 1)
      : []
    // Preserve the ORIGINAL href (including any `#anchor` fragment) so
    // navigation lands on the exact section. Active-item matching (done on
    // the host) strips the fragment at compare time instead.
    const href = item.href ?? ''
    return {
      name: item.label?.trim() || item.href || ' ',
      kind: OutlineSymbolKind.Heading1,
      startLine: 0,
      startColumn: 0,
      endLine: 0,
      endColumn: 0,
      children,
      depth,
      target: { kind: 'epub-href' as const, href }
    }
  })
}

export const EpubReader = forwardRef<EpubReaderHandle, EpubReaderProps>(function EpubReader(
  { previewBuffer, filePath, initialFontPct, initialLocation, initialScrollTop, onMemoryChange, onOutlineLoaded, onLocationChange },
  ref
) {
  const { t } = useI18n()

  // Product telemetry: count once per EPUB reader open (mount), never per re-render.
  useEffect(() => { trackFeatureUse('epub-reader') }, [])

  const containerRef = useRef<HTMLDivElement | null>(null)
  const bookRef = useRef<Book | null>(null)
  const renditionRef = useRef<Rendition | null>(null)
  const sessionStateRef = useRef<EpubReaderSessionState | null>(null)
  const requestNavigationRef = useRef<EpubNavigationRequester | null>(null)
  const recoveryAttemptsRef = useRef(new WeakMap<ArrayBuffer, number>())
  const [renditionRecoveryNonce, setRenditionRecoveryNonce] = useState(0)
  // Keep initialLocation / initialScrollTop fresh across file switches. These
  // refs are snapshotted at the start of the main mount effect (which re-runs
  // whenever previewBuffer changes — i.e. per file open). Updating them on
  // prop change keeps them ready for the next effect run without triggering
  // a re-mount of the book.
  const initialLocationRef = useRef<string | null>(initialLocation ?? null)
  const initialScrollTopRef = useRef<number | undefined>(initialScrollTop)
  useEffect(() => {
    initialLocationRef.current = initialLocation ?? null
    initialScrollTopRef.current = initialScrollTop
  }, [filePath, initialLocation, initialScrollTop])
  const onMemoryChangeRef = useRef(onMemoryChange)
  useEffect(() => { onMemoryChangeRef.current = onMemoryChange }, [onMemoryChange])
  const onOutlineLoadedRef = useRef(onOutlineLoaded)
  useEffect(() => { onOutlineLoadedRef.current = onOutlineLoaded }, [onOutlineLoaded])
  const onLocationChangeRef = useRef(onLocationChange)
  useEffect(() => { onLocationChangeRef.current = onLocationChange }, [onLocationChange])
  // Debounce scroll-persist so we don't hammer the host on every scroll tick.
  // Uses the same idea as PdfReader's queueReadingStatePost.
  const scrollPersistTimerRef = useRef<number | null>(null)
  // While we're applying a restored scrollTop, ignore incoming scroll events
  // so the programmatic scroll doesn't get immediately re-persisted at a
  // slightly different value due to epub.js's internal layout shifts.
  const programmaticScrollUntilRef = useRef<number>(0)

  const [fontPct, setFontPct] = useState(clampFontPct(initialFontPct))
  const fontPctRef = useRef(fontPct)
  fontPctRef.current = fontPct
  const [searchQuery, setSearchQuery] = useState('')
  const [searchHits, setSearchHits] = useState<EpubSearchHit[]>([])
  const [searching, setSearching] = useState(false)
  const [searchHitsOpen, setSearchHitsOpen] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const themeName = useMemo(() => 'onward-theme', [])

  useImperativeHandle(ref, () => ({
    goToHref(href: string) {
      void requestNavigationRef.current?.({ kind: 'display', target: href, reason: 'outline' })
    }
  }), [])

  const applyTheme = useCallback(() => {
    const rendition = renditionRef.current
    if (!rendition) return
    const colors = collectHostTheme()
    rendition.themes.register(themeName, {
      'html, body': {
        background: colors.background,
        color: colors.foreground,
        'font-family': '"IBM Plex Sans", "Noto Sans SC", "Segoe UI", -apple-system, sans-serif'
      },
      a: { color: colors.accent },
      'a:hover': { color: colors.accent, 'text-decoration': 'underline' },
      img: { 'max-width': '100%', height: 'auto' },
      code: {
        background: colors.panel,
        color: colors.foreground,
        'border-radius': '4px',
        padding: '0 4px'
      },
      blockquote: {
        'border-left': `3px solid ${colors.accent}`,
        color: colors.muted,
        'padding-left': '10px',
        margin: '8px 0'
      }
    })
    rendition.themes.select(themeName)
    // Initial font size is applied before the first display; later changes are
    // serialized with navigation by the fontPct effect below. Keeping fontPct
    // out of this callback prevents a font change from recreating the book.
  }, [themeName])

  useEffect(() => {
    if (!containerRef.current) return
    const container = containerRef.current
    const sessionId = ++nextEpubReaderSessionId
    const initialTarget = initialLocationRef.current
    const savedScrollTop = initialScrollTopRef.current
    programmaticScrollUntilRef.current = typeof savedScrollTop === 'number' && savedScrollTop > 0
      ? Number.POSITIVE_INFINITY
      : 0
    let sessionState = beginEpubReaderSession({
      sessionId,
      filePath,
      restoreTarget: initialTarget
    })
    sessionStateRef.current = sessionState
    setError(null)

    let disposed = false
    let book: Book | null = null
    let rendition: Rendition | null = null
    let scrollContainer: HTMLElement = container
    let scrollListenerContainer: HTMLElement | null = null
    let handleScroll: (() => void) | null = null
    let handleRelocated: ((loc: { start?: { cfi?: string; href?: string } }) => void) | null = null
    let handleContentKeydown: ((event: KeyboardEvent) => void) | null = null
    let activeNavigationRequester: EpubNavigationRequester | null = null
    let pendingRelocation: { start?: { cfi?: string; href?: string } } | null = null
    let recoveryTimer: number | null = null
    const coordinator = createSerialEpubTaskCoordinator()
    const progressHost = window as unknown as { __onwardEpubReaderProgress?: EpubReaderProgress }
    const progressState: EpubReaderProgress = {
      sessionId,
      filePath,
      stateReady: false,
      latestAttemptId: 0,
      settledAttemptId: null,
      readyAttemptId: null,
      latestTarget: initialTarget,
      displayStarted: Date.now(),
      displayResolved: null,
      displayRejected: null,
      containerWidth: container.offsetWidth,
      containerHeight: container.offsetHeight,
      lastBookOpened: false,
      lastLocationHref: null,
      lastLocationCfi: null,
      appliedFontPct: null
    }
    progressHost.__onwardEpubReaderProgress = progressState

    const isCurrentSession = () => Boolean(
      !disposed
      && rendition
      && renditionRef.current === rendition
      && sessionStateRef.current
      && isCurrentEpubSessionEvent(sessionStateRef.current, sessionId)
      && progressHost.__onwardEpubReaderProgress === progressState
    )
    const publishSessionState = (nextState: EpubReaderSessionState) => {
      sessionState = nextState
      if (!sessionStateRef.current || !isCurrentEpubSessionEvent(sessionStateRef.current, sessionId)) return
      sessionStateRef.current = nextState
      progressState.latestAttemptId = nextState.latestAttemptId
      progressState.settledAttemptId = nextState.settledAttemptId
      progressState.readyAttemptId = nextState.readyAttemptId
      progressState.latestTarget = nextState.latestTarget
      progressState.stateReady = nextState.latestAttemptId > 0
        && nextState.settledAttemptId === nextState.latestAttemptId
        && nextState.readyAttemptId === nextState.latestAttemptId
        && nextState.restoreTargetConfirmed
    }

    try {
      book = ePub(previewBuffer) as Book
      bookRef.current = book

      rendition = book.renderTo(container, {
        width: '100%',
        height: '100%',
        flow: 'scrolled-doc',
        allowScriptedContent: false
      })
      renditionRef.current = rendition

      const renditionAny = rendition as unknown as {
        q: { tick: (cb: () => void) => void; run: () => void; enqueue: (task: unknown) => unknown }
        manager?: { currentLocation: () => unknown; container?: HTMLElement }
        located: (result: unknown) => { start?: { index?: number; href?: string; cfi?: string; percentage?: number }; end?: { cfi?: string } } | null
        location: unknown
        emit: (event: string, payload?: unknown) => void
        reportLocation: () => unknown
      }
      const resolveScrollContainer = () => (
        renditionAny.manager?.container
        ?? container.querySelector<HTMLElement>('.epub-container')
        ?? container
      )

      const bindScrollContainer = () => {
        const nextContainer = resolveScrollContainer()
        scrollContainer = nextContainer
        if (!handleScroll || scrollListenerContainer === nextContainer) return nextContainer
        if (scrollListenerContainer) {
          scrollListenerContainer.removeEventListener('scroll', handleScroll)
        }
        nextContainer.addEventListener('scroll', handleScroll, { passive: true })
        scrollListenerContainer = nextContainer
        return nextContainer
      }

      // epub.js captures requestAnimationFrame at module load. Replace both
      // captured hot paths on this rendition and reject callbacks from an old
      // reader session before they can mutate the new reader.
      renditionAny.q.tick = (cb: () => void) => window.setTimeout(cb, 0)
      renditionAny.reportLocation = function patchedReportLocation() {
        return renditionAny.q.enqueue(function reportedLocation(this: typeof renditionAny) {
          if (!isCurrentSession()) return
          const manager = this.manager
          if (!manager) return
          const location = manager.currentLocation()
          const settle = (result: unknown) => {
            if (!isCurrentSession()) return
            const located = this.located(result)
            if (!located || !located.start || !located.end) return
            this.location = located
            this.emit('locationChanged', {
              index: located.start.index,
              href: located.start.href,
              start: located.start.cfi,
              end: located.end.cfi,
              percentage: located.start.percentage
            })
            this.emit('relocated', this.location)
          }
          if (location && typeof (location as { then?: unknown }).then === 'function') {
            void (location as Promise<unknown>).then(settle)
          } else if (location) {
            settle(location)
          }
        }.bind(renditionAny))
      }

      const applySavedScroll = () => {
        const savedTop = savedScrollTop
        if (typeof savedTop !== 'number' || savedTop <= 0) return
        let attempts = 0
        const maxAttempts = 60
        const tick = () => {
          if (!isCurrentSession()) return
          const el = bindScrollContainer()
          if (!el) return
          const maxTop = Math.max(0, el.scrollHeight - el.clientHeight)
          if (maxTop < savedTop - 2 && attempts < maxAttempts) {
            attempts += 1
            window.requestAnimationFrame(tick)
            return
          }
          programmaticScrollUntilRef.current = performance.now() + 600
          el.scrollTop = Math.min(savedTop, maxTop)
        }
        window.requestAnimationFrame(tick)
      }

      const requestNavigation: EpubNavigationRequester = async (request) => {
        if (!isCurrentSession() || !rendition) return
        const target = request.kind === 'display' || request.kind === 'font'
          ? (request.target ?? null)
          : null
        const startsDisplayAttempt = request.kind !== 'font' || target !== null
        let attemptId: number | null = null
        if (startsDisplayAttempt) {
          const nextState = beginEpubDisplayAttempt(sessionState, target)
          publishSessionState(nextState)
          attemptId = nextState.latestAttemptId
        }
        progressState.displayStarted = Date.now()
        progressState.displayResolved = null
        progressState.displayRejected = null

        await coordinator.enqueue(async () => {
          if (!isCurrentSession() || !rendition) return
          // A newer queued request supersedes this one before it starts.
          if (attemptId !== null && sessionState.latestAttemptId !== attemptId) return
          try {
            if (request.kind === 'display') {
              await rendition.display(request.target)
            } else if (request.kind === 'font') {
              rendition.themes.fontSize(`${request.fontPct}%`)
              progressState.appliedFontPct = request.fontPct
              if (request.target) await rendition.display(request.target)
            } else if (request.kind === 'previous') {
              await rendition.prev()
            } else {
              await rendition.next()
            }
            if (!isCurrentSession()) return
            if (attemptId !== null) {
              publishSessionState(settleEpubDisplayAttempt(sessionState, { sessionId, attemptId }))
              const relocation = pendingRelocation
              pendingRelocation = null
              if (relocation) handleRelocated?.(relocation)
            }
            progressState.displayResolved = Date.now()
            bindScrollContainer()
            if (request.kind === 'display' && request.restoreScroll) {
              applySavedScroll()
            }
          } catch (err) {
            if (!isCurrentSession()) return
            const message = String((err as { message?: string })?.message ?? err)
            progressState.displayRejected = message
            setError(message)
          }
        })
      }
      activeNavigationRequester = requestNavigation
      requestNavigationRef.current = requestNavigation

      handleRelocated = (loc) => {
        if (!isCurrentSession()) return
        const cfi = loc?.start?.cfi ?? loc?.start?.href ?? null
        const href = stripFragment(loc?.start?.href ?? null)
        const relocation = acceptEpubRelocation(sessionState, { sessionId, cfi, href })
        if (!relocation.accepted) {
          if (sessionState.settledAttemptId !== sessionState.latestAttemptId) {
            pendingRelocation = loc
          }
          return
        }
        publishSessionState(relocation.state)
        progressState.lastLocationHref = href
        progressState.lastLocationCfi = cfi
        recoveryAttemptsRef.current.delete(previewBuffer)
        if (recoveryTimer !== null) {
          window.clearTimeout(recoveryTimer)
          recoveryTimer = null
        }
        onMemoryChangeRef.current?.({ epubLocation: cfi })
        onLocationChangeRef.current?.(href)
      }
      rendition.on('relocated', handleRelocated)

      // epub.js renders chapters into nested same-origin iframes; keydown
      // there never bubbles to the host document, so the host's ESC handling
      // (useSubpageEscape → back to terminal) and Cmd/Ctrl+P (Quick Open)
      // would be dead while the reader content has focus. epub.js relays
      // content-document DOM events through the rendition, so forward the
      // shared host-key allowlist to the host document — the EPUB analogue of
      // the pdf.js viewer's `onward:pdf:hostKey` forwarding.
      handleContentKeydown = (event: KeyboardEvent) => {
        if (!isCurrentSession()) return
        if (!event || typeof event.key !== 'string') return
        if (!shouldForwardReaderHostKey(event)) return
        perfTraceDiagnostic(PERF_TRACE_EVENT.RENDERER_EPUB_HOST_KEY_FORWARDED, {
          ph: 'i',
          surface: 'project-editor',
          key: event.key,
          metaKey: Boolean(event.metaKey),
          ctrlKey: Boolean(event.ctrlKey)
        })
        redispatchReaderHostKey({
          key: event.key,
          code: event.code,
          metaKey: event.metaKey,
          ctrlKey: event.ctrlKey,
          shiftKey: event.shiftKey,
          altKey: event.altKey
        })
      }
      rendition.on('keydown', handleContentKeydown)

      handleScroll = () => {
        if (!isCurrentSession()) return
        if (!shouldPersistEpubScroll(performance.now(), programmaticScrollUntilRef.current)) return
        if (scrollPersistTimerRef.current) {
          window.clearTimeout(scrollPersistTimerRef.current)
        }
        scrollPersistTimerRef.current = window.setTimeout(() => {
          scrollPersistTimerRef.current = null
          if (!isCurrentSession()) return
          onMemoryChangeRef.current?.({ epubScrollTop: scrollContainer.scrollTop })
        }, 250)
      }
      bindScrollContainer()

      void book.opened.then(() => {
        if (isCurrentSession()) progressState.lastBookOpened = true
      }).catch(() => { /* ignore */ })

      const bookReady = (book.ready ?? book.opened ?? Promise.resolve(null)) as Promise<unknown>
      void bookReady.then(() => {
        if (!isCurrentSession() || !rendition) return
        applyTheme()
        try {
          rendition.themes.fontSize(`${fontPctRef.current}%`)
          progressState.appliedFontPct = fontPctRef.current
        } catch { /* ignore */ }
        try {
          const width = container.offsetWidth
          const height = container.offsetHeight
          if (width > 0 && height > 0) rendition.resize(width, height)
        } catch { /* ignore */ }
        renditionAny.q.run()
        void requestNavigation({
          kind: 'display',
          target: initialTarget ?? undefined,
          reason: 'initial',
          restoreScroll: true
        })

        // A genuinely stuck initial display is recovered by replacing the
        // entire book/rendition session. Calling display() again on the same
        // rendition is unsafe because epub.js resolves, but does not cancel,
        // the old manager.display operation.
        recoveryTimer = window.setTimeout(() => {
          if (!isCurrentSession()) return
          const frameReady = isEpubFrameContentReady(readEpubFrameSnapshot(container))
          const locationReady = sessionState.readyAttemptId === sessionState.latestAttemptId
          if (frameReady && locationReady) return
          const previousAttempts = recoveryAttemptsRef.current.get(previewBuffer) ?? 0
          if (previousAttempts >= MAX_RENDITION_RECOVERY_ATTEMPTS) return
          recoveryAttemptsRef.current.set(previewBuffer, previousAttempts + 1)
          setRenditionRecoveryNonce((nonce) => nonce + 1)
        }, RENDITION_RECOVERY_DELAY_MS)
      }).catch(() => { /* ignore */ })

      void book.loaded.navigation.then((nav: { toc: NavItem[] }) => {
        if (!isCurrentSession()) return
        onOutlineLoadedRef.current?.(flattenNavItems(nav?.toc ?? []))
      })
    } catch (err) {
      setError(String((err as { message?: string })?.message ?? err))
    }

    return () => {
      disposed = true
      programmaticScrollUntilRef.current = 0
      sessionState = disposeEpubReaderSession(sessionState, sessionId)
      if (sessionStateRef.current && isCurrentEpubSessionEvent(sessionStateRef.current, sessionId)) {
        sessionStateRef.current = sessionState
      }
      coordinator.dispose()
      if (requestNavigationRef.current === activeNavigationRequester) requestNavigationRef.current = null
      if (recoveryTimer !== null) window.clearTimeout(recoveryTimer)
      if (scrollPersistTimerRef.current) {
        window.clearTimeout(scrollPersistTimerRef.current)
        scrollPersistTimerRef.current = null
      }
      if (handleScroll && scrollListenerContainer) {
        try { scrollListenerContainer.removeEventListener('scroll', handleScroll) } catch { /* ignore */ }
      }
      if (rendition && handleRelocated) {
        try { rendition.off('relocated', handleRelocated) } catch { /* ignore */ }
      }
      if (rendition && handleContentKeydown) {
        try { rendition.off('keydown', handleContentKeydown) } catch { /* ignore */ }
      }
      try { rendition?.destroy() } catch { /* ignore */ }
      if (renditionRef.current === rendition) renditionRef.current = null
      try { book?.destroy() } catch { /* ignore */ }
      if (bookRef.current === book) bookRef.current = null
      if (progressHost.__onwardEpubReaderProgress === progressState) {
        delete progressHost.__onwardEpubReaderProgress
      }
    }
  }, [previewBuffer, filePath, applyTheme, renditionRecoveryNonce])

  // Re-apply theme when host theme changes (class / data-theme mutations).
  useEffect(() => {
    if (typeof MutationObserver === 'undefined') return
    const observer = new MutationObserver(() => applyTheme())
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'data-theme'] })
    return () => observer.disconnect()
  }, [applyTheme])

  // Persist the font-size preference per-file. Same rationale as above.
  const fontPctInitializedRef = useRef(false)
  useEffect(() => {
    if (!fontPctInitializedRef.current) {
      fontPctInitializedRef.current = true
      return
    }
    onMemoryChangeRef.current?.({ epubFontPct: fontPct })
  }, [fontPct])

  // Apply font size and re-seek as one serialized navigation task. epub.js does
  // not cancel an in-flight manager.display call when a newer display starts.
  const fontRenderInitializedRef = useRef(false)
  useEffect(() => {
    if (!fontRenderInitializedRef.current) {
      fontRenderInitializedRef.current = true
      return
    }
    const progress = (window as unknown as {
      __onwardEpubReaderProgress?: EpubReaderProgress
    }).__onwardEpubReaderProgress
    const anchor = progress?.lastLocationCfi || progress?.lastLocationHref || undefined
    void requestNavigationRef.current?.({ kind: 'font', target: anchor, fontPct, reason: 'font' })
  }, [fontPct])

  const goPrev = useCallback(() => {
    void requestNavigationRef.current?.({ kind: 'previous', reason: 'toolbar' })
  }, [])
  const goNext = useCallback(() => {
    void requestNavigationRef.current?.({ kind: 'next', reason: 'toolbar' })
  }, [])

  const runSearch = useCallback(
    async (rawQuery: string): Promise<{ hits: EpubSearchHit[]; trace: Record<string, unknown> }> => {
      const book = bookRef.current
      const query = rawQuery.trim()
      const trace: Record<string, unknown> = { query }
      if (!book) {
        trace.skip = 'no-book'
        return { hits: [], trace }
      }
      if (!query) return { hits: [], trace }
      try {
        await book.ready
      } catch (err) {
        trace.readyError = String((err as { message?: string })?.message ?? err)
      }

      const spine = book.spine as unknown as {
        spineItems?: unknown[]
        each?: (cb: (item: unknown) => void) => void
      }
      const items: unknown[] = []
      if (Array.isArray(spine.spineItems) && spine.spineItems.length > 0) {
        items.push(...spine.spineItems)
      } else if (typeof spine.each === 'function') {
        spine.each(item => items.push(item))
      }
      trace.spineItemCount = items.length
      trace.spineKeys = Object.keys(spine)
      trace.itemKeys = items[0] ? Object.keys(items[0] as object).slice(0, 20) : null

      const lowerQuery = query.toLowerCase()
      const collectFromDocument = (
        doc: Document | null | undefined,
        href: string | undefined,
        sink: EpubSearchHit[]
      ) => {
        if (!doc) return
        const walker = doc.createTreeWalker(doc.body || doc.documentElement, NodeFilter.SHOW_TEXT)
        let node = walker.nextNode()
        const limit = 150
        while (node) {
          const text = node.textContent ?? ''
          const lower = text.toLowerCase()
          let from = 0
          while (from < lower.length) {
            const idx = lower.indexOf(lowerQuery, from)
            if (idx === -1) break
            const excerpt = text.length <= limit
              ? text.trim()
              : `...${text.slice(Math.max(0, idx - limit / 2), idx + limit / 2).trim()}...`
            sink.push({
              cfi: `${href ?? ''}:${sink.length}`,
              excerpt,
              href
            })
            from = idx + lowerQuery.length
            if (sink.length > 200) return
          }
          node = walker.nextNode()
        }
      }

      const hits: EpubSearchHit[] = []
      const itemTrace: Array<Record<string, unknown>> = []
      for (const rawItem of items) {
        const item = rawItem as {
          load?: (loader: (path: string) => Promise<object>) => Promise<unknown>
          unload?: () => void
          document?: Document
          href?: string
        }
        const perItem: Record<string, unknown> = {
          href: item?.href ?? null,
          hadDocumentBefore: Boolean(item?.document),
          loadIsFn: typeof item?.load
        }
        if (typeof item?.load !== 'function') {
          perItem.skip = 'no-load'
          itemTrace.push(perItem)
          continue
        }
        let loadedFresh = false
        try {
          if (!item.document) {
            await item.load(book.load.bind(book))
            loadedFresh = true
          }
        } catch (err) {
          perItem.loadError = String((err as { message?: string })?.message ?? err)
          itemTrace.push(perItem)
          continue
        }
        perItem.hasDocumentAfter = Boolean(item.document)
        perItem.docText = item.document ? (item.document.body?.textContent ?? '').slice(0, 80) : null
        const before = hits.length
        try {
          collectFromDocument(item.document, item.href, hits)
        } catch (err) {
          perItem.collectError = String((err as { message?: string })?.message ?? err)
        } finally {
          if (loadedFresh) {
            try {
              item.unload?.()
            } catch {
              /* ignore */
            }
          }
        }
        perItem.hitsAdded = hits.length - before
        itemTrace.push(perItem)
        if (hits.length > 200) break
      }
      trace.items = itemTrace
      trace.totalHits = hits.length
      return { hits, trace }
    },
    []
  )

  const handleSearch = useCallback(async () => {
    setSearching(true)
    try {
      const { hits, trace } = await runSearch(searchQuery)
      ;(window as unknown as { __onwardEpubSearchTrace?: Record<string, unknown> }).__onwardEpubSearchTrace = trace
      setSearchHits(hits)
      setSearchHitsOpen(hits.length > 0)
    } finally {
      setSearching(false)
    }
  }, [runSearch, searchQuery])

  // Expose debug hook for autotests — so a test can invoke search directly
  // and read the trace without relying on UI click events.
  useEffect(() => {
    const hook = {
      runSearch: async (query: string) => {
        const result = await runSearch(query)
        ;(window as unknown as { __onwardEpubSearchTrace?: Record<string, unknown> }).__onwardEpubSearchTrace = result.trace
        setSearchHits(result.hits)
        setSearchHitsOpen(result.hits.length > 0)
        return result
      }
    }
    ;(window as unknown as { __onwardEpubReaderDebug?: typeof hook }).__onwardEpubReaderDebug = hook
    return () => {
      const w = window as unknown as { __onwardEpubReaderDebug?: typeof hook }
      if (w.__onwardEpubReaderDebug === hook) delete w.__onwardEpubReaderDebug
    }
  }, [runSearch])

  const onSearchKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLInputElement>) => {
      if (event.key === 'Enter') {
        event.preventDefault()
        void handleSearch()
      }
    },
    [handleSearch]
  )

  const clampedFontPct = Math.min(MAX_FONT_PCT, Math.max(MIN_FONT_PCT, fontPct))

  return (
    <div className="project-editor-epub-reader" data-file-path={filePath}>
      <div className="project-editor-epub-toolbar">
        <button type="button" className="project-editor-epub-btn" onClick={goPrev} title={t('projectEditor.epubReader.prevChapter')}>
          ◀
        </button>
        <button type="button" className="project-editor-epub-btn" onClick={goNext} title={t('projectEditor.epubReader.nextChapter')}>
          ▶
        </button>
        <div className="project-editor-epub-fontsize">
          <button
            type="button"
            className="project-editor-epub-btn"
            onClick={() => setFontPct(v => Math.max(MIN_FONT_PCT, v - FONT_STEP))}
            title={t('projectEditor.epubReader.fontSmaller')}
          >
            A-
          </button>
          <span className="project-editor-epub-fontsize-value">{clampedFontPct}%</span>
          <button
            type="button"
            className="project-editor-epub-btn"
            onClick={() => setFontPct(v => Math.min(MAX_FONT_PCT, v + FONT_STEP))}
            title={t('projectEditor.epubReader.fontLarger')}
          >
            A+
          </button>
        </div>
        <div className="project-editor-epub-search">
          <input
            type="search"
            value={searchQuery}
            onChange={event => setSearchQuery(event.target.value)}
            onKeyDown={onSearchKeyDown}
            onFocus={() => searchHits.length > 0 && setSearchHitsOpen(true)}
            placeholder={t('projectEditor.epubReader.searchPlaceholder')}
          />
          <button type="button" className="project-editor-epub-btn" onClick={() => void handleSearch()} disabled={searching}>
            {searching ? t('projectEditor.epubReader.searching') : t('projectEditor.epubReader.search')}
          </button>
          {searchHitsOpen && searchHits.length > 0 && (
            <div className="project-editor-epub-search-popover">
              <div className="project-editor-epub-search-popover-heading">
                {t('projectEditor.epubReader.searchResults', { count: String(searchHits.length) })}
                <button
                  type="button"
                  className="project-editor-epub-search-popover-close"
                  onClick={() => setSearchHitsOpen(false)}
                  title={t('projectEditor.epubReader.closeSearchResults')}
                >
                  ×
                </button>
              </div>
              <ul className="project-editor-epub-search-hits">
                {searchHits.slice(0, 100).map(hit => (
                  <li key={hit.cfi}>
                    <button
                      type="button"
                      className="project-editor-epub-search-hit"
                      onClick={() => {
                        // Search produces a pseudo-CFI, so navigate by the
                        // matching spine href through the serialized queue.
                        if (hit.href) {
                          void requestNavigationRef.current?.({
                            kind: 'display',
                            target: hit.href,
                            reason: 'search'
                          })
                        }
                        setSearchHitsOpen(false)
                      }}
                    >
                      {hit.excerpt}
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      </div>
      <div className="project-editor-epub-body">
        <div className="project-editor-epub-content" ref={containerRef} />
      </div>
      {error && <div className="project-editor-epub-error">{error}</div>}
    </div>
  )
})
