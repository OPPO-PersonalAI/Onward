/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import { trackFeatureUse } from '../../telemetry/track-feature-use'
import { perfTraceDiagnostic } from '../../utils/perf-trace'
import { redispatchPdfHostKey } from '../../utils/pdfHostKey'
import {
  resolveViewerTraceEvent,
  sanitizeTracePayload
} from '../ProjectEditor/pdfViewerTrace'
import {
  diffForFileStatus,
  emphasisIdsForPanes,
  type AnnotationDiffEntry,
  type PdfDiffAnnotation
} from './annotationDiffModel'
import {
  GitPdfAnnotationDiffPanel,
  type GitPdfAnnotationDiffLabels
} from './GitPdfAnnotationDiffPanel'
import { computePaneVisibility, type GitPdfStatus } from './computePaneVisibility'
import './GitPdfCompare.css'

export type { GitPdfStatus }
export type { GitPdfAnnotationDiffLabels }

export interface GitPdfCompareLabels {
  statusAdded: string
  statusDeleted: string
  statusModified: string
  labelOriginal: string
  labelAdded: string
  labelModified: string
  noOriginal: string
  noModified: string
}

interface GitPdfCompareProps {
  status: GitPdfStatus
  /** Base64 bytes of the original side. Undefined means the file did not exist before. */
  originalPreviewData?: string
  /** Base64 bytes of the modified side. Undefined means the file was deleted. */
  modifiedPreviewData?: string
  originalSize?: number
  modifiedSize?: number
  /** File name displayed in the header (used in iframe title + size label). */
  filename: string
  /**
   * Fully qualified URL of the vendored PDF viewer. When null the iframe
   * cannot render yet; the outer compare chrome (status badge, pane headers,
   * empty states) still shows so callers don't flash the generic "binary
   * unsupported" fallback while the URL is being resolved.
   */
  viewerUrl: string | null
  labels: GitPdfCompareLabels
  /** Copy for the annotation-diff sidebar. Absent = sidebar disabled. */
  annotationDiffLabels?: GitPdfAnnotationDiffLabels
}

function formatFileSize(bytes: number | undefined): string {
  if (!bytes || bytes <= 0) return ''
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function base64ToBlobUrl(base64: string): string {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  const blob = new Blob([bytes], { type: 'application/pdf' })
  return URL.createObjectURL(blob)
}

function buildViewerSrc(viewerUrl: string, blobUrl: string, displayName: string): string {
  const sep = viewerUrl.includes('?') ? '&' : '?'
  return `${viewerUrl}${sep}file=${encodeURIComponent(blobUrl)}&name=${encodeURIComponent(displayName)}`
}

export function GitPdfCompare({
  status,
  originalPreviewData,
  modifiedPreviewData,
  originalSize,
  modifiedSize,
  filename,
  viewerUrl,
  labels,
  annotationDiffLabels
}: GitPdfCompareProps) {
  const originalBlobRef = useRef<string | null>(null)
  const modifiedBlobRef = useRef<string | null>(null)

  // Annotation sets as each side's viewer reports them. `null` = that side
  // has not broadcast yet; the diff waits for every VISIBLE pane so a
  // half-loaded comparison never flashes "everything added".
  const [originalAnnotations, setOriginalAnnotations] = useState<PdfDiffAnnotation[] | null>(null)
  const [modifiedAnnotations, setModifiedAnnotations] = useState<PdfDiffAnnotation[] | null>(null)

  // Product telemetry: count once per PDF-diff view open (mount), never per re-render.
  useEffect(() => { trackFeatureUse('pdf-diff') }, [])

  const originalSrc = useMemo(() => {
    if (originalBlobRef.current) {
      URL.revokeObjectURL(originalBlobRef.current)
      originalBlobRef.current = null
    }
    if (!originalPreviewData || !viewerUrl) return null
    const blobUrl = base64ToBlobUrl(originalPreviewData)
    originalBlobRef.current = blobUrl
    return buildViewerSrc(viewerUrl, blobUrl, `${filename} (original)`)
  }, [filename, originalPreviewData, viewerUrl])

  const modifiedSrc = useMemo(() => {
    if (modifiedBlobRef.current) {
      URL.revokeObjectURL(modifiedBlobRef.current)
      modifiedBlobRef.current = null
    }
    if (!modifiedPreviewData || !viewerUrl) return null
    const blobUrl = base64ToBlobUrl(modifiedPreviewData)
    modifiedBlobRef.current = blobUrl
    return buildViewerSrc(viewerUrl, blobUrl, `${filename} (modified)`)
  }, [filename, modifiedPreviewData, viewerUrl])

  useEffect(() => {
    return () => {
      if (originalBlobRef.current) URL.revokeObjectURL(originalBlobRef.current)
      if (modifiedBlobRef.current) URL.revokeObjectURL(modifiedBlobRef.current)
      originalBlobRef.current = null
      modifiedBlobRef.current = null
    }
  }, [])

  const originalFrameRef = useRef<HTMLIFrameElement | null>(null)
  const modifiedFrameRef = useRef<HTMLIFrameElement | null>(null)

  // Forward theme CSS vars to both viewer iframes once they're ready, and
  // re-dispatch host-level shortcuts (Cmd/Ctrl+P, Escape) that the iframe
  // forwarded via postMessage so the host's existing keyboard handlers see
  // them as if the user pressed the key outside the iframe.
  useEffect(() => {
    const vars = (() => {
      const style = window.getComputedStyle(document.documentElement)
      const read = (name: string) => style.getPropertyValue(name).trim()
      const out: Record<string, string> = {}
      const map: Record<string, string> = {
        '--background': '--onward-pdf-bg',
        '--panel': '--onward-pdf-panel',
        '--panel-elevated': '--onward-pdf-panel-elevated',
        '--line': '--onward-pdf-line',
        '--text': '--onward-pdf-text',
        '--muted': '--onward-pdf-muted',
        '--accent': '--onward-pdf-accent'
      }
      for (const [src, dst] of Object.entries(map)) {
        const v = read(src)
        if (v) out[dst] = v
      }
      if (out['--onward-pdf-panel']) out['--onward-pdf-page-tint'] = out['--onward-pdf-panel']
      return out
    })()
    const handler = (event: MessageEvent) => {
      if (!event.data || typeof event.data !== 'object') return
      const fromOriginal = event.source === originalFrameRef.current?.contentWindow
      const fromModified = event.source === modifiedFrameRef.current?.contentWindow
      if (!fromOriginal && !fromModified) return
      if (event.data.type === 'onward:pdf:ready') {
        const target = fromOriginal ? originalFrameRef.current : modifiedFrameRef.current
        target?.contentWindow?.postMessage({ type: 'onward:pdf:theme', vars }, '*')
      } else if (event.data.type === 'onward:pdf:hostKey') {
        redispatchPdfHostKey(event.data as Record<string, unknown>)
      } else if (event.data.type === 'onward:pdf:annotations') {
        // Both viewers parse and broadcast the annotations their PDF carries
        // anyway; catching the message is what powers the diff sidebar — no
        // extra parsing, no extra transfer.
        const items = Array.isArray(event.data.items)
          ? (event.data.items as PdfDiffAnnotation[])
          : []
        if (fromOriginal) setOriginalAnnotations(items)
        else setModifiedAnnotations(items)
      } else if (event.data.type === 'onward:pdf:trace') {
        // Same whitelist relay as PdfReader — the compare panes previously
        // dropped viewer diagnostics on the floor.
        const traceEvent = resolveViewerTraceEvent(event.data.name)
        if (traceEvent) perfTraceDiagnostic(traceEvent, sanitizeTracePayload(event.data.payload))
      }
    }
    window.addEventListener('message', handler)
    return () => window.removeEventListener('message', handler)
  }, [originalSrc, modifiedSrc])

  // A pane whose document was swapped out (new blob URL) must re-earn its
  // annotation set; stale records would diff against the wrong version.
  useEffect(() => { setOriginalAnnotations(null) }, [originalSrc])
  useEffect(() => { setModifiedAnnotations(null) }, [modifiedSrc])

  const statusLabel =
    status === 'added' ? labels.statusAdded
      : status === 'deleted' ? labels.statusDeleted
        : labels.statusModified
  const statusClass = `git-pdf-compare-status git-pdf-compare-status-${status}`

  const { showOriginalPane, showModifiedPane, isSinglePane } = computePaneVisibility(status)

  // The diff waits for every visible pane's annotation broadcast; the hidden
  // side of a single-pane comparison is an empty set by construction.
  const panesReported =
    (!showOriginalPane || originalAnnotations !== null) &&
    (!showModifiedPane || modifiedAnnotations !== null)

  const annotationDiff = useMemo(() => {
    if (!annotationDiffLabels || !panesReported) return null
    return diffForFileStatus(status, originalAnnotations ?? [], modifiedAnnotations ?? [])
  }, [annotationDiffLabels, panesReported, status, originalAnnotations, modifiedAnnotations])

  // Outline the diffed records inside each pane so a jump from the sidebar
  // lands on something visually distinct.
  useEffect(() => {
    if (!annotationDiff) return
    const emphasis = emphasisIdsForPanes(annotationDiff)
    originalFrameRef.current?.contentWindow?.postMessage(
      { type: 'onward:pdf:emphasizeAnnotations', ids: emphasis.original },
      '*'
    )
    modifiedFrameRef.current?.contentWindow?.postMessage(
      { type: 'onward:pdf:emphasizeAnnotations', ids: emphasis.modified },
      '*'
    )
  }, [annotationDiff])

  const handleDiffJump = (entry: AnnotationDiffEntry) => {
    const frame = entry.jumpPane === 'original' ? originalFrameRef.current : modifiedFrameRef.current
    frame?.contentWindow?.postMessage(
      { type: 'onward:pdf:goToAnnotation', annotationId: entry.annotation.id },
      '*'
    )
  }

  return (
    <div className="git-pdf-compare">
      <div className="git-pdf-compare-header">
        <span className={statusClass}>{statusLabel}</span>
        <span className="git-pdf-compare-filename" title={filename}>{filename}</span>
      </div>
      <div className="git-pdf-compare-body">
      <div className={`git-pdf-compare-panes${isSinglePane ? ' is-single' : ''}`}>
        {showOriginalPane && (
          <div className="git-pdf-compare-pane" data-side="original">
            <div className="git-pdf-compare-pane-header">
              <span className="git-pdf-compare-pane-label">{labels.labelOriginal}</span>
              <span className="git-pdf-compare-pane-size">{formatFileSize(originalSize)}</span>
            </div>
            {originalSrc ? (
              <iframe
                ref={originalFrameRef}
                className="git-pdf-compare-frame"
                src={originalSrc}
                title={`${filename} (original)`}
                sandbox="allow-same-origin allow-scripts"
              />
            ) : (
              <div className="git-pdf-compare-empty">{labels.noOriginal}</div>
            )}
          </div>
        )}
        {showModifiedPane && (
          <div className="git-pdf-compare-pane" data-side="modified">
            <div className="git-pdf-compare-pane-header">
              <span className="git-pdf-compare-pane-label">
                {status === 'added' ? labels.labelAdded : labels.labelModified}
              </span>
              <span className="git-pdf-compare-pane-size">{formatFileSize(modifiedSize)}</span>
            </div>
            {modifiedSrc ? (
              <iframe
                ref={modifiedFrameRef}
                className="git-pdf-compare-frame"
                src={modifiedSrc}
                title={`${filename} (modified)`}
                sandbox="allow-same-origin allow-scripts"
              />
            ) : (
              <div className="git-pdf-compare-empty">{labels.noModified}</div>
            )}
          </div>
        )}
      </div>
      {annotationDiffLabels && annotationDiff && annotationDiff.entries.length > 0 && (
        <GitPdfAnnotationDiffPanel
          result={annotationDiff}
          labels={annotationDiffLabels}
          onJump={handleDiffJump}
        />
      )}
      </div>
    </div>
  )
}
