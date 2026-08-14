/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

import { forwardRef, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef } from 'react'
import { useI18n } from '../../i18n/useI18n'
import { trackFeatureUse } from '../../telemetry/track-feature-use'
import { PERF_TRACE_EVENT } from '../../utils/perf-trace-names'
import { perfTraceDiagnostic } from '../../utils/perf-trace'
import { redispatchPdfHostKey } from '../../utils/pdfHostKey'
import { extractVersionedPdfFileUrl } from './pdfPreviewUrl'
import { resolveViewerTraceEvent, sanitizeTracePayload } from './pdfViewerTrace'
import type { OutlineItem } from './Outline/types'
import { OutlineSymbolKind } from './Outline/types'
import {
  normalizePdfReaderState,
  normalizePdfReaderStateIfReady,
  shouldInitializePdfReadyHandshake,
  type PdfReaderState
} from './pdfReaderState'

/** One highlight, as the viewer reports it to the host list. Geometry (quads)
 *  is deliberately omitted: the list never renders it, and for a heavily
 *  annotated book it would dominate every message. */
export interface PdfAnnotationSummary {
  id: string
  groupId: string
  labelId: string
  labelName: string
  color: string
  page: number
  note: string
  textSnapshot: string
  createdAt: number
  updatedAt: number
}

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
  /** Project root. Required to write highlight annotations back into the PDF. */
  rootPath?: string
  /** Fires when the highlight set changes, so the host can render a list. */
  onAnnotationsChange?: (items: PdfAnnotationSummary[]) => void
  /** Fires when there are unsaved highlight edits, and when they land. */
  onDirtyChange?: (dirty: boolean) => void
  /** Fires when a save fails. `reason` is an enum, not display text. */
  onSaveProblem?: (reason: string) => void
  /** Fires as the reader scrolls, with the outline entry they are inside.
   *  `order` is the entry's pre-order index in the tree the viewer sent. */
  onOutlineActiveChange?: (order: number | null) => void
  /** Highlight labels to offer in the palette. Ids are written into the PDF. */
  highlightLabels?: Array<{ id: string; name: string; color: string }>
  /** Persisted note-popup size, restored into the viewer on load. */
  notePopupSize?: { width: number; height: number }
  /** Fires when the user resizes the note popup. */
  onNotePopupSizeChange?: (size: { width: number; height: number }) => void
  /** Per-file position memory. Sent to the viewer after pagesinit. */
  initialState?: { page?: number; scrollTop?: number; scale?: string }
  /** Fires whenever the user scrolls / paginates / zooms so the host can persist. */
  onStateChange?: (state: PdfReaderState) => void
  /** Fires once after document load with the flattened outline tree. Empty if none. */
  onOutlineLoaded?: (items: OutlineItem[]) => void
  /** Fires on every page change (including from scroll / arrow keys). */
  onPageChange?: (page: number) => void
  /** Disk identity of the PDF at open time — seed for the save-gate pre-image. */
  fileMeta?: { size: number; mtimeMs: number }
  /** Whether the host's annotation panel is open. Drives the toolbar button's
   *  pressed state; the panel itself stays owned by the host. */
  annotationPanelVisible?: boolean
  /** Fires when the reader's toolbar button asks to toggle the panel. */
  onToggleAnnotationPanel?: () => void
  /** Fires when an external-change reload round trip completes. `merge`
   *  carries rebase stats when local unsaved edits were replayed, else null. */
  onExternalReload?: (info: {
    ok: boolean
    reason: string | null
    merge: { localAdds: number; localMods: number; localDels: number; conflicts: number } | null
  }) => void
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
  /** Scroll the viewer to a highlight, using the same alignment as an outline
   *  jump so the two feel like one navigation model. */
  goToAnnotation(annotationId: string): void
  /** Remove a highlight. The viewer owns the records, so deletion is a request
   *  rather than a local mutation. */
  deleteAnnotation(annotationId: string): void
  /** The PDF changed on disk (external writer). Asks the viewer to reload the
   *  document in place, preserving view state and rebase-merging any unsaved
   *  local annotations. */
  notifyExternalChange(meta: { mtimeMs: number; size: number }): void
  /** Force an immediate annotation write (bypasses the quiet window). Used by
   *  the host before tearing the reader down. */
  flushAnnotations(): void
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
  {
    viewerUrl,
    filePath,
    rootPath,
    initialState,
    onStateChange,
    onOutlineLoaded,
    onPageChange,
    onAnnotationsChange,
    onDirtyChange,
    onSaveProblem,
    onOutlineActiveChange,
    highlightLabels: highlightLabelsProp,
    notePopupSize,
    onNotePopupSizeChange,
    fileMeta,
    onExternalReload,
    annotationPanelVisible,
    onToggleAnnotationPanel
  },
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
  const onAnnotationsChangeRef = useRef(onAnnotationsChange)
  useEffect(() => { onAnnotationsChangeRef.current = onAnnotationsChange }, [onAnnotationsChange])
  const onDirtyChangeRef = useRef(onDirtyChange)
  useEffect(() => { onDirtyChangeRef.current = onDirtyChange }, [onDirtyChange])
  const onSaveProblemRef = useRef(onSaveProblem)
  useEffect(() => { onSaveProblemRef.current = onSaveProblem }, [onSaveProblem])
  const onOutlineActiveChangeRef = useRef(onOutlineActiveChange)
  useEffect(() => { onOutlineActiveChangeRef.current = onOutlineActiveChange }, [onOutlineActiveChange])
  const onNotePopupSizeChangeRef = useRef(onNotePopupSizeChange)
  useEffect(() => { onNotePopupSizeChangeRef.current = onNotePopupSizeChange }, [onNotePopupSizeChange])
  // Read inside the message handler, which must not be re-created per render:
  // re-binding it would drop in-flight save replies from the viewer.
  const rootPathRef = useRef(rootPath)
  useEffect(() => { rootPathRef.current = rootPath }, [rootPath])
  const filePathRef = useRef(filePath)
  useEffect(() => { filePathRef.current = filePath }, [filePath])
  const onExternalReloadRef = useRef(onExternalReload)
  useEffect(() => { onExternalReloadRef.current = onExternalReload }, [onExternalReload])
  const onToggleAnnotationPanelRef = useRef(onToggleAnnotationPanel)
  useEffect(() => { onToggleAnnotationPanelRef.current = onToggleAnnotationPanel }, [onToggleAnnotationPanel])
  // Mirrors what the toolbar button should display. Kept in a ref as well so
  // the ready handshake can re-push it without re-binding the message handler.
  const annotationCountRef = useRef(0)
  const viewerUrlRef = useRef(viewerUrl)
  useEffect(() => { viewerUrlRef.current = viewerUrl }, [viewerUrl])

  // The disk identity the annotation save gate asserts as its pre-image.
  // Seeded at open, advanced by successful saves and external reloads. When
  // the gate trips ('external-modified'), the reader self-heals: reload with
  // the disk's actual identity, rebase-merge, and let the autosave retry.
  const diskMetaRef = useRef<{ size: number; mtimeMs: number } | null>(fileMeta ?? null)
  useEffect(() => {
    diskMetaRef.current = fileMeta ?? null
  }, [fileMeta, viewerUrl])
  const reloadGenerationRef = useRef(0)
  const pendingReloadRef = useRef<{ generation: number; startedAt: number } | null>(null)

  const requestExternalReload = useCallback((meta: { mtimeMs: number; size: number }) => {
    const fileUrl = extractVersionedPdfFileUrl(viewerUrlRef.current, meta.mtimeMs)
    if (!fileUrl) return
    diskMetaRef.current = { size: meta.size, mtimeMs: meta.mtimeMs }
    const generation = ++reloadGenerationRef.current
    pendingReloadRef.current = { generation, startedAt: performance.now() }
    iframeRef.current?.contentWindow?.postMessage(
      { type: 'onward:pdf:reloadDocument', fileUrl, generation },
      '*'
    )
  }, [])

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
    },
    goToAnnotation(annotationId: string) {
      iframeRef.current?.contentWindow?.postMessage(
        { type: 'onward:pdf:goToAnnotation', annotationId },
        '*'
      )
    },
    deleteAnnotation(annotationId: string) {
      iframeRef.current?.contentWindow?.postMessage(
        { type: 'onward:pdf:deleteAnnotation', annotationId },
        '*'
      )
    },
    notifyExternalChange(meta: { mtimeMs: number; size: number }) {
      requestExternalReload(meta)
    },
    flushAnnotations() {
      iframeRef.current?.contentWindow?.postMessage(
        { type: 'onward:pdf:saveAnnotationsNow' },
        '*'
      )
    }
  }), [requestExternalReload])

  const i18nStrings = useMemo(
    () => ({
      prevPage: t('projectEditor.pdfReader.prevPage'),
      nextPage: t('projectEditor.pdfReader.nextPage'),
      zoomOut: t('projectEditor.pdfReader.zoomOut'),
      zoomIn: t('projectEditor.pdfReader.zoomIn'),
      zoom: t('projectEditor.pdfReader.zoom'),
      customZoom: t('projectEditor.pdfReader.customZoom'),
      fitWidth: t('projectEditor.pdfReader.fitWidth'),
      fitPage: t('projectEditor.pdfReader.fitPage'),
      searchPlaceholder: t('projectEditor.pdfReader.searchPlaceholder'),
      prevMatch: t('projectEditor.pdfReader.prevMatch'),
      nextMatch: t('projectEditor.pdfReader.nextMatch'),
      annotationsToggle: t('projectEditor.pdfReader.annotations.toggle'),
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
      errorGeneric: t('projectEditor.pdfReader.errorGeneric'),
      notePlaceholder: t('projectEditor.pdfReader.note.placeholder'),
      noteDelete: t('projectEditor.pdfReader.note.delete'),
      noteDeleteTitle: t('projectEditor.pdfReader.note.deleteTitle'),
      noteDone: t('projectEditor.pdfReader.note.done')
    }),
    [t]
  )

  // The highlight layer's own copy. Kept separate from the toolbar dictionary
  // because it is posted on its own channel and applied by a different module.
  const highlightI18n = useMemo(
    () => ({
      highlightChipHint: t('projectEditor.pdfReader.highlight.chipHint'),
      highlightChipShortcut: t('projectEditor.pdfReader.highlight.chipShortcut'),
      hasNote: t('projectEditor.pdfReader.highlight.hasNote'),
      annotationFallbackLabel: t('projectEditor.pdfReader.highlight.annotationFallbackLabel')
    }),
    [t]
  )

  // Label ids are stable and are written into the PDF; only the display names
  // are translated. Changing an id would orphan every highlight already saved
  // in a user's documents, so these strings are load-bearing.
  const defaultHighlightLabels = useMemo(
    () => [
      { id: 'hl-key', name: t('projectEditor.pdfReader.highlight.labelKey'), color: '#f2c14e' },
      { id: 'hl-question', name: t('projectEditor.pdfReader.highlight.labelQuestion'), color: '#5aa9e6' },
      { id: 'hl-method', name: t('projectEditor.pdfReader.highlight.labelMethod'), color: '#7bd88f' },
      { id: 'hl-cite', name: t('projectEditor.pdfReader.highlight.labelCitation'), color: '#e58fb2' }
    ],
    [t]
  )
  // The host owns the label set once the user has customised it; the built-in
  // four are the fallback for a fresh profile.
  const highlightLabels = highlightLabelsProp && highlightLabelsProp.length > 0
    ? highlightLabelsProp
    : defaultHighlightLabels

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
      } else if (data.type === 'onward:pdf:saveAnnotations') {
        // The viewer cannot reach IPC, so the actual write happens here.
        void handleAnnotationSave(data)
      } else if (data.type === 'onward:pdf:annotations') {
        const items = Array.isArray(data.items) ? (data.items as PdfAnnotationSummary[]) : []
        annotationCountRef.current = items.length
        postAnnotationPanelState()
        onAnnotationsChangeRef.current?.(items)
      } else if (data.type === 'onward:pdf:toggleAnnotationPanel') {
        onToggleAnnotationPanelRef.current?.()
      } else if (data.type === 'onward:pdf:outlineActive') {
        const order = typeof data.order === 'number' ? data.order : null
        onOutlineActiveChangeRef.current?.(order)
      } else if (data.type === 'onward:pdf:notePopupSize') {
        onNotePopupSizeChangeRef.current?.({
          width: Number(data.width) || 0,
          height: Number(data.height) || 0
        })
      } else if (data.type === 'onward:pdf:annotationsDirty') {
        onDirtyChangeRef.current?.(Boolean(data.dirty))
      } else if (data.type === 'onward:pdf:saveResult') {
        if (!data.ok && data.mode === 'manual') {
          // An automatic save that fails stays silent by design: interrupting
          // someone mid-page because a file is momentarily locked is worse
          // than retrying. An explicit Cmd+S must always report.
          onSaveProblemRef.current?.(String(data.reason || 'write-failed'))
        }
      } else if (data.type === 'onward:pdf:reloadResult') {
        const pending = pendingReloadRef.current
        if (pending && pending.generation === Number(data.generation)) {
          pendingReloadRef.current = null
          perfTraceDiagnostic(PERF_TRACE_EVENT.RENDERER_PDF_READER_EXTERNAL_RELOAD, {
            durationMs: +(performance.now() - pending.startedAt).toFixed(1),
            ok: Boolean(data.ok),
            reason: typeof data.reason === 'string' ? data.reason : null,
            generation: pending.generation
          })
          const merge = data.merge && typeof data.merge === 'object'
            ? (data.merge as { localAdds: number; localMods: number; localDels: number; conflicts: number })
            : null
          onExternalReloadRef.current?.({
            ok: Boolean(data.ok),
            reason: typeof data.reason === 'string' ? data.reason : null,
            merge
          })
        }
      } else if (data.type === 'onward:pdf:trace') {
        // Unknown names are dropped, not forwarded — see pdfViewerTrace.ts.
        const event = resolveViewerTraceEvent(data.name)
        if (event) perfTraceDiagnostic(event, sanitizeTracePayload(data.payload))
      }
    }
    const handleAnnotationSave = async (data: { id?: unknown; bytes?: unknown }) => {
      const target = iframeRef.current?.contentWindow
      const id = data.id
      const reply = (ok: boolean, reason?: string) => {
        target?.postMessage({ type: 'onward:pdf:saveAnnotationsResult', id, ok, reason }, '*')
      }
      const buffer = data.bytes
      if (!(buffer instanceof ArrayBuffer)) return reply(false, 'no-bytes')
      const root = rootPathRef.current
      if (!root) return reply(false, 'no-root')
      try {
        const result = await window.electronAPI.project.savePdfBytes(
          root,
          filePathRef.current,
          buffer,
          diskMetaRef.current ?? undefined
        )
        if (result?.success && result.savedDisk) {
          diskMetaRef.current = result.savedDisk
        } else if (result?.reason === 'external-modified' && result.currentDisk) {
          // Someone rewrote the file between our load and this save. Reload
          // with the disk's actual identity; the rebase merge keeps the local
          // edit, marks the store dirty again, and the autosave retries
          // against the updated pre-image.
          requestExternalReload(result.currentDisk)
        }
        reply(Boolean(result?.success), result?.reason)
      } catch (error) {
        reply(false, String(error instanceof Error ? error.message : error).slice(0, 120))
      }
    }

    const postAnnotationPanelState = () => {
      iframeRef.current?.contentWindow?.postMessage({
        type: 'onward:pdf:annotationPanelState',
        visible: Boolean(annotationPanelVisible),
        count: annotationCountRef.current
      }, '*')
    }

    const postThemeAndI18n = () => {
      const target = iframeRef.current?.contentWindow
      if (!target) return
      target.postMessage({ type: 'onward:pdf:theme', vars: collectThemeVars() }, '*')
      target.postMessage({ type: 'onward:pdf:i18n', strings: i18nStrings }, '*')
      target.postMessage({ type: 'onward:pdf:highlightI18n', strings: highlightI18n }, '*')
      target.postMessage({ type: 'onward:pdf:highlightLabels', labels: highlightLabels }, '*')
      if (notePopupSize && notePopupSize.width > 0) {
        target.postMessage({
          type: 'onward:pdf:notePopupSize',
          width: notePopupSize.width,
          height: notePopupSize.height
        }, '*')
      }
      postAnnotationPanelState()
    }
    window.addEventListener('message', handleMessage)
    if (readyRef.current) postThemeAndI18n()
    requestReady()
    return () => window.removeEventListener('message', handleMessage)
  }, [annotationPanelVisible, filePath, highlightI18n, highlightLabels, i18nStrings, notePopupSize, requestReady])

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
