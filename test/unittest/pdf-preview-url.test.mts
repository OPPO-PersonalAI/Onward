/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 *
 * Unit tests for `src/components/ProjectEditor/pdfPreviewUrl.ts` — the pure
 * string surgery that derives a versioned file URL from the viewer shell URL
 * for external-change reloads. Windows drive-letter URLs are the case most
 * likely to break here, so they get explicit coverage.
 *
 * Usage: node --experimental-strip-types --test test/unittest/pdf-preview-url.test.mts
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  extractVersionedPdfFileUrl,
  readPdfFileVersion
} from '../../src/components/ProjectEditor/pdfPreviewUrl.ts'

const POSIX_VIEWER =
  'file:///Users/dev/app/resources/pdfjs/app/viewer.html' +
  '?file=' + encodeURIComponent('file:///Users/dev/proj/paper%20v2.pdf?v=100') +
  '&name=paper%20v2.pdf'

const WINDOWS_VIEWER =
  'file:///C:/app/resources/pdfjs/app/viewer.html' +
  '?file=' + encodeURIComponent('file:///C:/proj/docs/paper.pdf') +
  '&name=paper.pdf'

test('PPU-U-01 stamps a fresh v token onto a POSIX file URL (replacing the old one)', () => {
  const url = extractVersionedPdfFileUrl(POSIX_VIEWER, 555.9)
  assert.equal(url, 'file:///Users/dev/proj/paper%20v2.pdf?v=555')
})

test('PPU-U-02 stamps a v token onto a Windows drive-letter file URL', () => {
  const url = extractVersionedPdfFileUrl(WINDOWS_VIEWER, 42)
  assert.equal(url, 'file:///C:/proj/docs/paper.pdf?v=42')
})

test('PPU-U-03 a viewer URL without a file param yields null', () => {
  assert.equal(extractVersionedPdfFileUrl('file:///a/viewer.html?name=x', 1), null)
  assert.equal(extractVersionedPdfFileUrl('file:///a/viewer.html', 1), null)
  assert.equal(extractVersionedPdfFileUrl('', 1), null)
})

test('PPU-U-04 a non-finite mtime degrades to v=0 rather than NaN in the URL', () => {
  const url = extractVersionedPdfFileUrl(WINDOWS_VIEWER, Number.NaN)
  assert.equal(url, 'file:///C:/proj/docs/paper.pdf?v=0')
})

test('PPU-U-05 readPdfFileVersion round-trips what buildPdfViewerUrl embeds', () => {
  assert.equal(readPdfFileVersion(POSIX_VIEWER), '100')
  assert.equal(readPdfFileVersion(WINDOWS_VIEWER), null)
})

test('PPU-U-06 encoded characters in the path survive the stamping untouched', () => {
  // The file param value is percent-encoded as a whole; the path inside must
  // come back byte-identical apart from the version suffix.
  const viewer =
    'file:///opt/app/viewer.html?file=' +
    encodeURIComponent('file:///data/%E8%AE%BA%E6%96%87/final.pdf?v=7') +
    '&name=final.pdf'
  assert.equal(
    extractVersionedPdfFileUrl(viewer, 8),
    'file:///data/%E8%AE%BA%E6%96%87/final.pdf?v=8'
  )
})
