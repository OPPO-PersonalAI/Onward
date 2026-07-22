/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 *
 * Usage: node --experimental-strip-types --test test/unittest/pdf-epub-preview-group.test.mts
 *
 * Locks the `group=` token parser behind the pdf-epub-preview budget split
 * (900 s runner → two sub-300 s group runners). A parsing regression here
 * silently runs the FULL suite in both group runners — doubling gate time
 * and defeating the split.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { parsePdfEpubPreviewGroup } from '../../src/autotest/pdf-epub-preview-group.ts'

test('group tokens parse from the suite string', () => {
  assert.equal(parsePdfEpubPreviewGroup('pdf-epub-preview;group=pdf'), 'pdf')
  assert.equal(parsePdfEpubPreviewGroup('pdf-epub-preview;group=pdf-outline'), 'pdf-outline')
  assert.equal(parsePdfEpubPreviewGroup('pdf-epub-preview;group=epub'), 'epub')
  assert.equal(parsePdfEpubPreviewGroup('pdf-epub-preview;group=all'), 'all')
  assert.equal(parsePdfEpubPreviewGroup('PDF-EPUB-PREVIEW;GROUP=EPUB'), 'epub', 'case-insensitive')
})

test("'pdf' does not prefix-match 'pdf-outline' (alternation order)", () => {
  assert.equal(parsePdfEpubPreviewGroup('pdf-epub-preview;group=pdf-outline,extra'), 'pdf-outline')
})

test('absent / unknown tokens default to all (umbrella behaviour preserved)', () => {
  assert.equal(parsePdfEpubPreviewGroup('pdf-epub-preview'), 'all')
  assert.equal(parsePdfEpubPreviewGroup('pdf-epub-preview,pdf-epub-diff'), 'all', 'full-runner suite list')
  assert.equal(parsePdfEpubPreviewGroup('pdf-epub-preview;group=bogus'), 'all')
  assert.equal(parsePdfEpubPreviewGroup(''), 'all')
  assert.equal(parsePdfEpubPreviewGroup(null), 'all')
  assert.equal(parsePdfEpubPreviewGroup(undefined), 'all')
})

test('token is recognised in comma-separated multi-suite strings', () => {
  assert.equal(parsePdfEpubPreviewGroup('pdf-epub-preview;group=pdf,pdf-epub-diff'), 'pdf')
})

test('a group= substring inside another word does not match', () => {
  assert.equal(parsePdfEpubPreviewGroup('pdf-epub-preview;subgroup=pdf'), 'all')
})
