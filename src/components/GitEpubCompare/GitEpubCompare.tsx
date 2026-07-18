/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

import { useEffect, useMemo, useState } from 'react'
import ePub from 'epubjs'
import { trackFeatureUse } from '../../telemetry/track-feature-use'
import type { Book } from 'epubjs'
import './GitEpubCompare.css'

export type GitEpubStatus = 'added' | 'deleted' | 'modified'

export interface GitEpubCompareLabels {
  statusAdded: string
  statusDeleted: string
  statusModified: string
  chapterAdded: string
  chapterDeleted: string
  chapterModified: string
  chapterUnchanged: string
  labelOriginal: string
  labelModified: string
  noOriginal: string
  noModified: string
  loading: string
  error: string
  chapters: string
  resources: string
  noResourceChanges: string
  resourceAdded: string
  resourceDeleted: string
  resourceModified: string
}

interface GitEpubCompareProps {
  status: GitEpubStatus
  originalPreviewData?: string
  modifiedPreviewData?: string
  originalSize?: number
  modifiedSize?: number
  filename: string
  labels: GitEpubCompareLabels
}

type ChapterMeta = {
  href: string
  label: string
  originalText: string | null
  modifiedText: string | null
  status: 'added' | 'deleted' | 'modified' | 'unchanged'
}

type ResourceChange = {
  href: string
  status: 'added' | 'deleted' | 'modified'
  originalSize?: number
  modifiedSize?: number
}

function formatFileSize(bytes: number | undefined): string {
  if (!bytes || bytes <= 0) return ''
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function base64ToArrayBuffer(base64: string): ArrayBuffer {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes.buffer
}

async function extractBookContents(base64: string): Promise<{
  chapters: Map<string, { label: string; text: string }>
  resources: Map<string, number>
}> {
  const buffer = base64ToArrayBuffer(base64)
  const book = ePub(buffer) as Book
  await book.opened
  await book.ready

  const chapters = new Map<string, { label: string; text: string }>()
  const resources = new Map<string, number>()

  try {
    const nav = await book.loaded.navigation
    const navByHref = new Map<string, string>()
    const walk = (items: Array<{ href: string; label: string; subitems?: unknown[] }> = []) => {
      for (const item of items) {
        if (item?.href) navByHref.set(item.href.split('#')[0], item.label?.trim() || item.href)
        if (Array.isArray(item?.subitems)) {
          walk(item.subitems as Array<{ href: string; label: string; subitems?: unknown[] }>)
        }
      }
    }
    walk((nav?.toc as unknown as Array<{ href: string; label: string; subitems?: unknown[] }>) || [])

    const spine = book.spine as unknown as { spineItems?: Array<{ href: string; load?: (l: unknown) => Promise<unknown>; document?: Document; unload?: () => void }> }
    const items = spine.spineItems || []
    for (const item of items) {
      if (!item?.load) continue
      let loaded = false
      try {
        if (!item.document) {
          await item.load(book.load.bind(book))
          loaded = true
        }
      } catch {
        continue
      }
      try {
        const body = item.document?.body || item.document?.documentElement
        const rawText = body?.textContent ?? ''
        // Normalize whitespace per-line while preserving line structure.
        const normalized = rawText
          .split(/\r?\n/)
          .map(line => line.replace(/[ \t]+/g, ' ').trim())
          .join('\n')
          .replace(/\n{3,}/g, '\n\n')
          .trim()
        const href = item.href.split('#')[0]
        const label = navByHref.get(href) || href
        chapters.set(href, { label, text: normalized })
      } finally {
        if (loaded) {
          try { item.unload?.() } catch { /* ignore */ }
        }
      }
    }

    // Enumerate resources (images, css, fonts). `book.resources` exposes
    // packaging assets via an internal map; if unavailable, skip silently.
    const rawResources = (book.resources as unknown as { resources?: Array<{ href: string; type?: string }> }).resources
    if (Array.isArray(rawResources)) {
      for (const entry of rawResources) {
        if (entry?.href) resources.set(entry.href, 0)
      }
    }
  } finally {
    try { book.destroy() } catch { /* ignore */ }
  }

  return { chapters, resources }
}

function pairChapters(
  original: Map<string, { label: string; text: string }>,
  modified: Map<string, { label: string; text: string }>
): ChapterMeta[] {
  const out: ChapterMeta[] = []
  const seen = new Set<string>()
  const allHrefs: string[] = []
  for (const href of original.keys()) allHrefs.push(href)
  for (const href of modified.keys()) if (!original.has(href)) allHrefs.push(href)

  for (const href of allHrefs) {
    if (seen.has(href)) continue
    seen.add(href)
    const o = original.get(href) ?? null
    const m = modified.get(href) ?? null
    let status: ChapterMeta['status']
    if (o && m) {
      status = o.text === m.text ? 'unchanged' : 'modified'
    } else if (m) {
      status = 'added'
    } else {
      status = 'deleted'
    }
    out.push({
      href,
      label: (m?.label ?? o?.label ?? href),
      originalText: o?.text ?? null,
      modifiedText: m?.text ?? null,
      status
    })
  }
  return out
}

function pairResources(
  original: Map<string, number>,
  modified: Map<string, number>
): ResourceChange[] {
  const out: ResourceChange[] = []
  const all = new Set<string>([...original.keys(), ...modified.keys()])
  for (const href of all) {
    const hasO = original.has(href)
    const hasM = modified.has(href)
    if (hasO && hasM) {
      // We don't have resource byte size from epubjs metadata alone; skip
      // unchanged/modified determination here. Surface as "modified" when both
      // sides exist so it is at least visible.
      // Filtered later if equal size hashes are available.
      continue
    }
    out.push({
      href,
      status: hasM ? 'added' : 'deleted'
    })
  }
  return out
}

// Line-level set diff: returns one annotated array per side where each entry is
// { text, kind } with kind ∈ { 'same' | 'add' | 'del' }. This is not an optimal
// LCS diff but is good enough for casual EPUB review and avoids pulling a diff
// library just for this view.
function annotateLines(
  original: string | null,
  modified: string | null
): { left: Array<{ text: string; kind: 'same' | 'add' | 'del' }>; right: Array<{ text: string; kind: 'same' | 'add' | 'del' }> } {
  const leftLines = (original ?? '').split('\n')
  const rightLines = (modified ?? '').split('\n')
  const leftSet = new Set(leftLines.map(l => l.trim()).filter(Boolean))
  const rightSet = new Set(rightLines.map(l => l.trim()).filter(Boolean))
  const left = leftLines.map(text => {
    const trimmed = text.trim()
    const kind = trimmed === '' || rightSet.has(trimmed) ? 'same' : 'del'
    return { text, kind: kind as 'same' | 'add' | 'del' }
  })
  const right = rightLines.map(text => {
    const trimmed = text.trim()
    const kind = trimmed === '' || leftSet.has(trimmed) ? 'same' : 'add'
    return { text, kind: kind as 'same' | 'add' | 'del' }
  })
  return { left, right }
}

export function GitEpubCompare({
  status,
  originalPreviewData,
  modifiedPreviewData,
  originalSize,
  modifiedSize,
  filename,
  labels
}: GitEpubCompareProps) {
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [chapters, setChapters] = useState<ChapterMeta[]>([])
  const [resources, setResources] = useState<ResourceChange[]>([])
  const [selectedHref, setSelectedHref] = useState<string | null>(null)

  // Product telemetry: count once per EPUB-diff view open (mount), never per re-render.
  useEffect(() => { trackFeatureUse('epub-diff') }, [])

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    setChapters([])
    setResources([])
    setSelectedHref(null)
    ;(async () => {
      try {
        const originalContents = originalPreviewData
          ? await extractBookContents(originalPreviewData)
          : { chapters: new Map(), resources: new Map() }
        const modifiedContents = modifiedPreviewData
          ? await extractBookContents(modifiedPreviewData)
          : { chapters: new Map(), resources: new Map() }
        if (cancelled) return
        const paired = pairChapters(originalContents.chapters, modifiedContents.chapters)
        const resDiffs = pairResources(originalContents.resources, modifiedContents.resources)
        setChapters(paired)
        setResources(resDiffs)
        const firstChanged = paired.find(ch => ch.status !== 'unchanged') ?? paired[0]
        setSelectedHref(firstChanged?.href ?? null)
      } catch (err) {
        if (!cancelled) setError(String((err as { message?: string })?.message ?? err))
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [originalPreviewData, modifiedPreviewData])

  const selected = useMemo(
    () => chapters.find(ch => ch.href === selectedHref) ?? null,
    [chapters, selectedHref]
  )
  const annotated = useMemo(
    () => (selected ? annotateLines(selected.originalText, selected.modifiedText) : { left: [], right: [] }),
    [selected]
  )

  const statusLabel =
    status === 'added' ? labels.statusAdded
      : status === 'deleted' ? labels.statusDeleted
        : labels.statusModified

  return (
    <div className="git-epub-compare">
      <div className="git-epub-compare-header">
        <span className={`git-epub-compare-status git-epub-compare-status-${status}`}>{statusLabel}</span>
        <span className="git-epub-compare-filename" title={filename}>{filename}</span>
        <span className="git-epub-compare-sizes">
          {formatFileSize(originalSize)} → {formatFileSize(modifiedSize)}
        </span>
      </div>
      {loading ? (
        <div className="git-epub-compare-loading">{labels.loading}</div>
      ) : error ? (
        <div className="git-epub-compare-error">{labels.error}: {error}</div>
      ) : (
        <div className="git-epub-compare-body">
          <aside className="git-epub-compare-sidebar">
            <div className="git-epub-compare-sidebar-heading">{labels.chapters}</div>
            <ul className="git-epub-compare-chapter-list">
              {chapters.map(ch => (
                <li key={ch.href}>
                  <button
                    type="button"
                    data-href={ch.href}
                    data-chapter-status={ch.status}
                    className={`git-epub-compare-chapter-item git-epub-compare-chapter-${ch.status}${selectedHref === ch.href ? ' active' : ''}`}
                    onClick={() => setSelectedHref(ch.href)}
                  >
                    <span className="git-epub-compare-chapter-badge" aria-label={
                      ch.status === 'added' ? labels.chapterAdded
                        : ch.status === 'deleted' ? labels.chapterDeleted
                          : ch.status === 'modified' ? labels.chapterModified
                            : labels.chapterUnchanged
                    }>
                      {ch.status === 'added' ? '+' : ch.status === 'deleted' ? '−' : ch.status === 'modified' ? '~' : '='}
                    </span>
                    <span className="git-epub-compare-chapter-label">{ch.label}</span>
                  </button>
                </li>
              ))}
            </ul>
            {resources.length > 0 && (
              <>
                <div className="git-epub-compare-sidebar-heading">{labels.resources}</div>
                <ul className="git-epub-compare-resource-list">
                  {resources.map(r => (
                    <li key={`${r.status}:${r.href}`} className={`git-epub-compare-resource-${r.status}`}>
                      <span className="git-epub-compare-chapter-badge">
                        {r.status === 'added' ? '+' : '−'}
                      </span>
                      <span className="git-epub-compare-resource-href" title={r.href}>{r.href}</span>
                    </li>
                  ))}
                </ul>
              </>
            )}
          </aside>
          <div className="git-epub-compare-panes">
            {selected ? (
              <>
                <div className="git-epub-compare-pane">
                  <div className="git-epub-compare-pane-header">
                    <span>{labels.labelOriginal}</span>
                  </div>
                  <div className="git-epub-compare-pane-body">
                    {annotated.left.length === 0 ? (
                      <div className="git-epub-compare-empty">{labels.noOriginal}</div>
                    ) : (
                      annotated.left.map((line, i) => (
                        <div key={i} className={`git-epub-compare-line git-epub-compare-line-${line.kind}`}>
                          {line.text || '\u00A0'}
                        </div>
                      ))
                    )}
                  </div>
                </div>
                <div className="git-epub-compare-pane">
                  <div className="git-epub-compare-pane-header">
                    <span>{labels.labelModified}</span>
                  </div>
                  <div className="git-epub-compare-pane-body">
                    {annotated.right.length === 0 ? (
                      <div className="git-epub-compare-empty">{labels.noModified}</div>
                    ) : (
                      annotated.right.map((line, i) => (
                        <div key={i} className={`git-epub-compare-line git-epub-compare-line-${line.kind}`}>
                          {line.text || '\u00A0'}
                        </div>
                      ))
                    )}
                  </div>
                </div>
              </>
            ) : (
              <div className="git-epub-compare-empty-chapter">{labels.noResourceChanges}</div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
