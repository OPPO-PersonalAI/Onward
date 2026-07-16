/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { shouldForwardReaderHostKey } from '../../src/utils/readerHostKey.ts'

// Locks the shared reader host-key allowlist (readerHostKey.ts) used by
// EpubReader (and, via pdfHostKey.ts, by the pdf.js viewer redispatch path):
// only Escape and Cmd/Ctrl+P cross the iframe boundary to the host document.
// Paired autotest: `epub-escape-forwarded-from-content` in
// run-pdf-epub-preview (end-to-end DOM/iframe wiring).

test('RHK-U-01 Escape is forwarded regardless of modifiers', () => {
  assert.equal(shouldForwardReaderHostKey({ key: 'Escape' }), true)
  assert.equal(shouldForwardReaderHostKey({ key: 'Escape', shiftKey: true }), true)
  assert.equal(shouldForwardReaderHostKey({ key: 'Escape', metaKey: true }), true)
})

test('RHK-U-02 Cmd/Ctrl+P is forwarded (either modifier, case-insensitive)', () => {
  assert.equal(shouldForwardReaderHostKey({ key: 'p', metaKey: true }), true)
  assert.equal(shouldForwardReaderHostKey({ key: 'P', ctrlKey: true }), true)
})

test('RHK-U-03 plain P without Cmd/Ctrl stays local to the reader', () => {
  assert.equal(shouldForwardReaderHostKey({ key: 'p' }), false)
  assert.equal(shouldForwardReaderHostKey({ key: 'p', shiftKey: true }), false)
  assert.equal(shouldForwardReaderHostKey({ key: 'p', altKey: true }), false)
})

test('RHK-U-04 reader-local keys are never forwarded', () => {
  assert.equal(shouldForwardReaderHostKey({ key: 'a' }), false)
  assert.equal(shouldForwardReaderHostKey({ key: 'ArrowDown' }), false)
  assert.equal(shouldForwardReaderHostKey({ key: 'f', metaKey: true }), false)
  assert.equal(shouldForwardReaderHostKey({ key: 'Enter', ctrlKey: true }), false)
  assert.equal(shouldForwardReaderHostKey({ key: 's', metaKey: true }), false)
})
