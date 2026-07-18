/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

import { forwardRef, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef } from 'react'
import { useI18n } from '../../i18n/useI18n'
import { trackFeatureUse } from '../../telemetry/track-feature-use'
import { redispatchPdfHostKey } from '../../utils/pdfHostKey'
import type { OutlineItem } from './Outline/types'
import { OutlineSymbolKind } from './Outline/types'
import {
  normalizePdfReaderState,
  normalizePdfReaderStateIfReady,
  shouldInitializePdfReadyHandshake,
  type PdfReaderState
} from './pdfReaderState'

/** Raw outline tree shape posted by the embedded PDF viewer. */
interface RawPdfOutlineNode {
  title: string
  page: number | null
  /** Full pdf.js destination (string for named, array for explicit). The host
   * forwards this back via `onward:pdf:goToDest` for precise navigation. */
  dest?: unknown
  children: RawPdfOutlineNode[]
}

interface PdfReaderProps {
  /** Full viewer URL including `?file=<file-url>&name=<display-name>`. */
  viewerUrl: string
  filePath: string
  /** Per-file position memory. Sent to the viewer after pagesinit. */
  initialState?: { page?: number; scrollTop?: number; scale?: string }
  /** Fires whenever the user scrolls / paginates / zooms so the host can persist. */
  onStateChange?: (state: PdfReaderState) => void
  /** Fires once after document load with the flattened outline tree. Empty if none. */
  onOutlineLoaded?: (items: OutlineItem[]) => void
  /** Fires on every page change (including from scroll / arrow keys). */
  onPageChange?: (page: number) => void
}

export interface PdfReaderHandle {
  /** Jump the viewer to an absolute 1-based page number. No-op if not ready. */
  goToPage(page: number): void
  /** Navigate to a full pdf.js destination (preserves /XYZ, /FitH, etc.).
   * Prefer this over goToPage when the outline entry has a dest attached. */
  goToDest(dest: unknown): void
  /** Read the live viewer state synchronously before the iframe is unmounted. */
  getCurrentState(): PdfReaderState | null
  /** Whether document loading and initial state restoration have completed. */
  isStateReady(): boolean
}

// CSS custom properties on the host document we forward to the viewer so it can
// pick up Onward's accent / surface colors. The viewer maps these into its own
// `--onward-pdf-*` tokens.
const FORWARDED_CSS_VARS = [
  'background',
  'panel',
  'panel-elevated',
  'line',
  'text',
  'muted',
  'accent',
  'shadow-1'
] as const

function collectThemeVars(): Record<string, string> {
  const root = document.documentElement
  const style = window.getComputedStyle(root)
  const out: Record<string, string> = {}
  for (const name of FORWARDED_CSS_VARS) {
    const value = style.getPropertyValue(`--${name}`).trim()
    if (!value) continue
    out[`--onward-pdf-${name === 'background' ? 'bg' : name === 'shadow-1' ? 'shadow' : name}`] = value
  }
  if (out['--onward-pdf-panel']) {
    out['--onward-pdf-page-tint'] = out['--onward-pdf-panel']
  }
  return out
}

// Convert the raw viewer-side tree into the shared OutlineItem shape. PDF
// entries use `target: { kind: 'pdf-page', page }`; items without a resolvable
// page still appear in the tree for visual context but are non-clickable at
// the panel level (host will filter or ignore them on click).
function flattenRawOutline(raw: RawPdfOutlineNode[], depth = 0): OutlineItem[] {
  return raw.map((node) => {
    const children = flattenRawOutline(node.children, depth + 1)
    const item: OutlineItem = {
      name: node.title || ' ',
      kind: OutlineSymbolKind.Heading1,
      startLine: 0,
      startColumn: 0,
      endLine: 0,
      endColumn: 0,
      children,
      depth
    }
    if (typeof node.page === 'number' && node.page > 0) {
      item.target = { kind: 'pdf-page', page: node.page, dest: node.dest ?? undefined }
    } else if (node.dest != null) {
      // Unresolvable page but we still have a destination — use page 1 as a
      // placeholder so the entry is clickable; the actual navigation goes
      // through goToDest which honours the real destination regardless of
      // the coarse page hint.
      item.target = { kind: 'pdf-page', page: 1, dest: node.dest }
    }
    return item
  })
}

export const PdfReader = forwardRef<PdfReaderHandle, PdfReaderProps>(function PdfReader(
  { viewerUrl, filePath, initialState, onStateChange, onOutlineLoaded, onPageChange },
  ref
) {
  const iframeRef = useRef<HTMLIFrameElement | null>(null)
  const readyRef = useRef(false)
  const stateReadyRef = useRef(false)
  const lastPageRef = useRef<number>(0)
  const { t } = useI18n()

  // Product telemetry: count once per PDF reader open (mount), never per re-render.
  useEffect(() => { trackFeatureUse('pdf-reader') }, [])

  const setIframeRef = useCallback((node: HTMLIFrameElement | null) => {
    if (iframeRef.current === node) return
    iframeRef.current = node
    readyRef.current = false
    stateReadyRef.current = false
    lastPageRef.current = 0
  }, [])

  const onStateChangeRef = useRef(onStateChange)
  useEffect(() => { onStateChangeRef.current = onStateChange }, [onStateChange])
  const onOutlineLoadedRef = useRef(onOutlineLoaded)
  useEffect(() => { onOutlineLoadedRef.current = onOutlineLoaded }, [onOutlineLoaded])
  const onPageChangeRef = useRef(onPageChange)
  useEffect(() => { onPageChangeRef.current = onPageChange }, [onPageChange])

  const initialStateRef = useRef(initialState ?? null)
  useLayoutEffect(() => {
    initialStateRef.current = initialState ?? null
  }, [filePath, initialState, viewerUrl])

  const requestReady = useCallback(() => {
    iframeRef.current?.contentWindow?.postMessage({ type: 'onward:pdf:requestReady' }, '*')
  }, [])

  useImperativeHandle(ref, () => ({
    goToPage(page: number) {
      if (!stateReadyRef.current) return
      if (!Number.isFinite(page) || page < 1) return
      iframeRef.current?.contentWindow?.postMessage(
        { type: 'onward:pdf:goToPage', page },
        '*'
      )
    },
    goToDest(dest: unknown) {
      if (!stateReadyRef.current) return
      if (dest == null) return
      iframeRef.current?.contentWindow?.postMessage(
        { type: 'onward:pdf:goToDest', dest },
        '*'
      )
    },
    getCurrentState() {
      if (!stateReadyRef.current) return null
      try {
        const frameDocument = iframeRef.current?.contentDocument
        const pageInput = frameDocument?.getElementById('pageNumberInput') as HTMLInputElement | null
        const viewerContainer = frameDocument?.getElementById('viewerContainer') as HTMLElement | null
        const zoomSelect = frameDocument?.getElementById('zoomSelect') as HTMLSelectElement | null
        if (!pageInput || !viewerContainer || !zoomSelect) return null
        return normalizePdfReaderStateIfReady(stateReadyRef.current, {
          page: pageInput.value,
          scrollTop: viewerContainer.scrollTop,
          scale: zoomSelect.value
        })
      } catch {
        return null
      }
    },
    isStateReady() {
      return stateReadyRef.current
    }
  }), [])

  const i18nStrings = useMemo(
    () => ({
      prevPage: t('projectEditor.pdfReader.prevPage'),
      nextPage: t('projectEditor.pdfReader.nextPage'),
      zoomOut: t('projectEditor.pdfReader.zoomOut'),
      zoomIn: t('projectEditor.pdfReader.zoomIn'),
      zoom: t('projectEditor.pdfReader.zoom'),
      fitWidth: t('projectEditor.pdfReader.fitWidth'),
      fitPage: t('projectEditor.pdfReader.fitPage'),
      searchPlaceholder: t('projectEditor.pdfReader.searchPlaceholder'),
      prevMatch: t('projectEditor.pdfReader.prevMatch'),
      nextMatch: t('projectEditor.pdfReader.nextMatch'),
      colorToggleOn: t('projectEditor.pdfReader.colorToggleOn'),
      colorToggleOff: t('projectEditor.pdfReader.colorToggleOff'),
      colorToggleTitleOn: t('projectEditor.pdfReader.colorToggleTitleOn'),
      colorToggleTitleOff: t('projectEditor.pdfReader.colorToggleTitleOff'),
      close: t('projectEditor.pdfReader.close'),
      cancel: t('projectEditor.pdfReader.cancel'),
      confirm: t('projectEditor.pdfReader.confirm'),
      passwordTitle: t('projectEditor.pdfReader.passwordTitle'),
      passwordPrompt: t('projectEditor.pdfReader.passwordPrompt'),
      passwordIncorrect: t('projectEditor.pdfReader.passwordIncorrect'),
      emptyState: t('projectEditor.pdfReader.emptyState'),
      errorInvalid: t('projectEditor.pdfReader.errorInvalid'),
      errorMissing: t('projectEditor.pdfReader.errorMissing'),
      errorPassword: t('projectEditor.pdfReader.errorPassword'),
      errorUnexpected: t('projectEditor.pdfReader.errorUnexpected'),
      errorGeneric: t('projectEditor.pdfReader.errorGeneric')
    }),
    [t]
  )

  useLayoutEffect(() => {
    const publishState = (data: { page: unknown; scrollTop: unknown; scale: unknown }) => {
      const state = normalizePdfReaderState(data)
      onStateChangeRef.current?.(state)
      if (state.page !== lastPageRef.current) {
        lastPageRef.current = state.page
        onPageChangeRef.current?.(state.page)
      }
    }
    const handleMessage = (event: MessageEvent) => {
      if (event.source !== iframeRef.current?.contentWindow) return
      const data = event.data
      if (!data || typeof data !== 'object') return
      if (data.type === 'onward:pdf:ready') {
        const shouldInitialize = shouldInitializePdfReadyHandshake(readyRef.current)
        readyRef.current = true
        postThemeAndI18n()
        if (!shouldInitialize) return
        stateReadyRef.current = false
        const restore = initialStateRef.current
        iframeRef.current?.contentWindow?.postMessage({
          type: 'onward:pdf:restoreState',
          page: restore?.page ?? 1,
          scrollTop: restore?.scrollTop ?? 0,
          scale: restore?.scale ?? null
        }, '*')
      } else if (data.type === 'onward:pdf:outline') {
        const raw = Array.isArray(data.items) ? (data.items as RawPdfOutlineNode[]) : []
        onOutlineLoadedRef.current?.(flattenRawOutline(raw))
      } else if (data.type === 'onward:pdf:state') {
        if (!stateReadyRef.current) return
        publishState(data)
      } else if (data.type === 'onward:pdf:stateReady') {
        stateReadyRef.current = true
        publishState(data)
      } else if (data.type === 'onward:pdf:hostKey') {
        redispatchPdfHostKey(data)
      }
    }
    const postThemeAndI18n = () => {
      const target = iframeRef.current?.contentWindow
      if (!target) return
      target.postMessage({ type: 'onward:pdf:theme', vars: collectThemeVars() }, '*')
      target.postMessage({ type: 'onward:pdf:i18n', strings: i18nStrings }, '*')
    }
    window.addEventListener('message', handleMessage)
    if (readyRef.current) postThemeAndI18n()
    requestReady()
    return () => window.removeEventListener('message', handleMessage)
  }, [i18nStrings, requestReady])

  useEffect(() => {
    if (typeof MutationObserver === 'undefined') return
    const observer = new MutationObserver(() => {
      if (!readyRef.current) return
      const target = iframeRef.current?.contentWindow
      if (!target) return
      target.postMessage({ type: 'onward:pdf:theme', vars: collectThemeVars() }, '*')
    })
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'data-theme'] })
    return () => observer.disconnect()
  }, [])

  return (
    <div className="project-editor-pdf-reader" data-file-path={filePath}>
      <iframe
        ref={setIframeRef}
        key={viewerUrl}
        src={viewerUrl}
        title={filePath}
        className="project-editor-pdf-reader-iframe"
        sandbox="allow-same-origin allow-scripts"
        onLoad={requestReady}
      />
    </div>
  )
})
