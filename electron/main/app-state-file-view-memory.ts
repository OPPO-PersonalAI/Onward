/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Validate a preview scroll anchor from persisted state.
 */
export function validatePreviewScrollAnchor(
  anchor: unknown
): { slug: string | null; ratio: number; headingOffsetY?: number; scrollTop?: number } | undefined {
  if (!anchor || typeof anchor !== 'object') return undefined
  const a = anchor as Record<string, unknown>
  const slug = typeof a.slug === 'string' ? a.slug : null
  const ratio = typeof a.ratio === 'number' ? a.ratio : 0
  const headingOffsetY = typeof a.headingOffsetY === 'number' ? a.headingOffsetY : undefined
  const scrollTop = typeof a.scrollTop === 'number' ? a.scrollTop : undefined
  return { slug, ratio, headingOffsetY, scrollTop }
}

/**
 * Validate one persisted FileViewMemory entry (exported pure function so the
 * unit suite can lock the whitelist against FileViewMemory type drift — the
 * PDF / EPUB fields were silently dropped across app restarts for months
 * because this list lagged the type).
 */
export function validateFileViewMemoryEntry(
  val: unknown
): import('../../src/types/tab').FileViewMemory | null {
  if (!val || typeof val !== 'object') return null
  const v = val as Record<string, unknown>
  const entry: import('../../src/types/tab').FileViewMemory = {}
  if (v.editorViewState !== undefined) entry.editorViewState = v.editorViewState
  if (typeof v.cursorLine === 'number') entry.cursorLine = v.cursorLine
  if (typeof v.cursorColumn === 'number') entry.cursorColumn = v.cursorColumn
  if (v.previewScrollAnchor && typeof v.previewScrollAnchor === 'object') {
    entry.previewScrollAnchor = validatePreviewScrollAnchor(v.previewScrollAnchor)
  }
  if (typeof v.outlineScrollTop === 'number') entry.outlineScrollTop = v.outlineScrollTop
  if (typeof v.isPreviewOpen === 'boolean') entry.isPreviewOpen = v.isPreviewOpen
  if (typeof v.isEditorVisible === 'boolean') entry.isEditorVisible = v.isEditorVisible
  if (v.outlineTarget === 'editor' || v.outlineTarget === 'preview') {
    entry.outlineTarget = v.outlineTarget
  }
  // EPUB reader position / preferences
  if (typeof v.epubFontPct === 'number' && Number.isFinite(v.epubFontPct)) entry.epubFontPct = v.epubFontPct
  if (typeof v.epubLocation === 'string' || v.epubLocation === null) entry.epubLocation = v.epubLocation as string | null
  if (typeof v.epubScrollTop === 'number' && Number.isFinite(v.epubScrollTop)) entry.epubScrollTop = v.epubScrollTop
  // PDF reader position
  if (typeof v.pdfPageNumber === 'number' && Number.isFinite(v.pdfPageNumber)) entry.pdfPageNumber = v.pdfPageNumber
  if (typeof v.pdfScrollTop === 'number' && Number.isFinite(v.pdfScrollTop)) entry.pdfScrollTop = v.pdfScrollTop
  if (typeof v.pdfScale === 'string') entry.pdfScale = v.pdfScale
  // HTML preview scroll position
  if (typeof v.htmlScrollX === 'number' && Number.isFinite(v.htmlScrollX)) entry.htmlScrollX = v.htmlScrollX
  if (typeof v.htmlScrollY === 'number' && Number.isFinite(v.htmlScrollY)) entry.htmlScrollY = v.htmlScrollY
  return Object.keys(entry).length > 0 ? entry : null
}
