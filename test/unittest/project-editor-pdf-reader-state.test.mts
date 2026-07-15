/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import {
  mergePdfReaderState,
  normalizePdfReaderState,
  normalizePdfReaderStateIfReady,
  shouldInitializePdfReadyHandshake
} from '../../src/components/ProjectEditor/pdfReaderState.ts'

test('normalizes live PDF viewer values before persistence', () => {
  assert.deepEqual(normalizePdfReaderState({
    page: '3.9',
    scrollTop: '240.5',
    scale: '4'
  }), {
    page: 3,
    scrollTop: 240.5,
    scale: '4'
  })
})

test('falls back for invalid PDF viewer values', () => {
  assert.deepEqual(normalizePdfReaderState({
    page: 0,
    scrollTop: Number.POSITIVE_INFINITY,
    scale: ''
  }), {
    page: 1,
    scrollTop: 0,
    scale: null
  })
})

test('does not capture PDF controls before initial restoration is ready', () => {
  assert.equal(normalizePdfReaderStateIfReady(false, {
    page: 1,
    scrollTop: 0,
    scale: 'page-width'
  }), null)
  assert.deepEqual(normalizePdfReaderStateIfReady(true, {
    page: '2',
    scrollTop: '320',
    scale: '2'
  }), {
    page: 2,
    scrollTop: 320,
    scale: '2'
  })
})

test('merges PDF state without erasing unrelated file memory', () => {
  assert.deepEqual(mergePdfReaderState({
    outlineScrollTop: 18,
    pdfScale: 'page-width'
  }, {
    page: 2,
    scrollTop: 640,
    scale: null
  }), {
    outlineScrollTop: 18,
    pdfPageNumber: 2,
    pdfScrollTop: 640,
    pdfScale: 'page-width'
  })
})

test('initializes PDF state only for the first ready acknowledgement', () => {
  assert.equal(shouldInitializePdfReadyHandshake(false), true)
  assert.equal(shouldInitializePdfReadyHandshake(true), false)
})
