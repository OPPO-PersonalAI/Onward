/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 *
 * Unit tests for the persisted FileViewMemory whitelist. This validator runs
 * on every app-state load; when its field list lags the FileViewMemory type,
 * positions are SILENTLY stripped across app restarts (the PDF / EPUB fields
 * were lost this way until 2026-07). This suite locks every persistable field
 * round-trip so the drift class cannot ship again.
 * Paired autotest: run-project-editor-html-preview-autotest.sh (PHTML-17..19).
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { validateFileViewMemoryEntry } from '../../electron/main/app-state-file-view-memory.ts'

test('AFVM-U-01 core editor fields round-trip', () => {
  const entry = validateFileViewMemoryEntry({
    editorViewState: { some: 'state' },
    cursorLine: 37,
    cursorColumn: 5,
    outlineScrollTop: 120,
    isPreviewOpen: true,
    isEditorVisible: false,
    outlineTarget: 'preview',
    previewScrollAnchor: { slug: 'intro', ratio: 0.4, headingOffsetY: 12, scrollTop: 640 }
  })
  assert.ok(entry)
  assert.equal(entry.cursorLine, 37)
  assert.equal(entry.cursorColumn, 5)
  assert.equal(entry.outlineScrollTop, 120)
  assert.equal(entry.isPreviewOpen, true)
  assert.equal(entry.isEditorVisible, false)
  assert.equal(entry.outlineTarget, 'preview')
  assert.equal(entry.previewScrollAnchor?.slug, 'intro')
  assert.equal(entry.previewScrollAnchor?.scrollTop, 640)
})

test('AFVM-U-02 PDF fields round-trip (regression: dropped across restarts pre-2026-07)', () => {
  const entry = validateFileViewMemoryEntry({
    pdfPageNumber: 12,
    pdfScrollTop: 3400,
    pdfScale: 'page-width'
  })
  assert.ok(entry)
  assert.equal(entry.pdfPageNumber, 12)
  assert.equal(entry.pdfScrollTop, 3400)
  assert.equal(entry.pdfScale, 'page-width')
})

test('AFVM-U-03 EPUB fields round-trip, including null location', () => {
  const entry = validateFileViewMemoryEntry({
    epubFontPct: 120,
    epubLocation: 'epubcfi(/6/4!/4/2)',
    epubScrollTop: 88
  })
  assert.ok(entry)
  assert.equal(entry.epubFontPct, 120)
  assert.equal(entry.epubLocation, 'epubcfi(/6/4!/4/2)')
  assert.equal(entry.epubScrollTop, 88)

  const nullLocation = validateFileViewMemoryEntry({ epubLocation: null })
  assert.ok(nullLocation)
  assert.equal(nullLocation.epubLocation, null)
})

test('AFVM-U-04 HTML scroll fields round-trip', () => {
  const entry = validateFileViewMemoryEntry({ htmlScrollX: 0, htmlScrollY: 980.5 })
  assert.ok(entry)
  assert.equal(entry.htmlScrollX, 0)
  assert.equal(entry.htmlScrollY, 980.5)
})

test('AFVM-U-05 junk values are rejected field-by-field', () => {
  const entry = validateFileViewMemoryEntry({
    cursorLine: '37',
    pdfPageNumber: Number.NaN,
    pdfScrollTop: Number.POSITIVE_INFINITY,
    pdfScale: 42,
    epubFontPct: 'big',
    htmlScrollY: 'deep',
    outlineTarget: 'sidebar',
    isPreviewOpen: 'yes'
  })
  assert.equal(entry, null)
})

test('AFVM-U-06 non-object input returns null', () => {
  assert.equal(validateFileViewMemoryEntry(null), null)
  assert.equal(validateFileViewMemoryEntry(undefined), null)
  assert.equal(validateFileViewMemoryEntry('x'), null)
  assert.equal(validateFileViewMemoryEntry(7), null)
})

test('AFVM-U-07 mixed valid + junk keeps the valid fields only', () => {
  const entry = validateFileViewMemoryEntry({
    cursorLine: 10,
    pdfPageNumber: 'x',
    htmlScrollY: 55
  })
  assert.ok(entry)
  assert.equal(entry.cursorLine, 10)
  assert.equal(entry.htmlScrollY, 55)
  assert.equal('pdfPageNumber' in entry, false)
})
