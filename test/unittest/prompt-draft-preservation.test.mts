/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 *
 * Unit tests for the pure auto-preserve decision behind "double-click a
 * history prompt while the editor holds content" (PromptNotebook
 * handleDoubleClick). Pairs with the autotest layer: run-prompt-list
 * PL-13/14/15 (end-to-end double-click flow against the real editor +
 * history list).
 *
 * Usage: node --experimental-strip-types --test test/unittest/prompt-draft-preservation.test.mts
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { decideDraftPreservation } from '../../src/components/PromptNotebook/prompt-draft-preservation.ts'

// ─────────── PDP-U-01..08 decision table ───────────

test('PDP-U-01 empty editor → skip (nothing to preserve)', () => {
  const d = decideDraftPreservation({ normalizedContent: '', title: '', editingOriginal: null })
  assert.deepEqual(d, { preserve: false, reason: 'empty' })
})

test('PDP-U-02 whitespace-only editor → skip', () => {
  const d = decideDraftPreservation({ normalizedContent: '  \n\t ', title: 'has title', editingOriginal: null })
  assert.deepEqual(d, { preserve: false, reason: 'empty' })
})

test('PDP-U-03 fresh draft with content → preserve', () => {
  const d = decideDraftPreservation({ normalizedContent: 'half-typed idea', title: '', editingOriginal: null })
  assert.deepEqual(d, { preserve: true, reason: 'draft-preserved' })
})

test('PDP-U-04 loaded entry, untouched (content+title identical) → skip', () => {
  const d = decideDraftPreservation({
    normalizedContent: 'original body',
    title: 'Original',
    editingOriginal: { normalizedContent: 'original body', title: 'Original' }
  })
  assert.deepEqual(d, { preserve: false, reason: 'unchanged-from-source' })
})

test('PDP-U-05 loaded entry, content edited → preserve', () => {
  const d = decideDraftPreservation({
    normalizedContent: 'original body plus my edits',
    title: 'Original',
    editingOriginal: { normalizedContent: 'original body', title: 'Original' }
  })
  assert.deepEqual(d, { preserve: true, reason: 'draft-preserved' })
})

test('PDP-U-06 loaded entry, only the title edited → preserve (title is user input too)', () => {
  const d = decideDraftPreservation({
    normalizedContent: 'original body',
    title: 'Renamed by user',
    editingOriginal: { normalizedContent: 'original body', title: 'Original' }
  })
  assert.deepEqual(d, { preserve: true, reason: 'draft-preserved' })
})

test('PDP-U-07 title comparison is trimmed (whitespace-only title change is not an edit)', () => {
  const d = decideDraftPreservation({
    normalizedContent: 'original body',
    title: '  Original  ',
    editingOriginal: { normalizedContent: 'original body', title: 'Original' }
  })
  assert.deepEqual(d, { preserve: false, reason: 'unchanged-from-source' })
})

test('PDP-U-08 content matching a DIFFERENT entry than the source still preserves (only the source dedupes)', () => {
  const d = decideDraftPreservation({
    normalizedContent: 'body of entry B',
    title: '',
    editingOriginal: { normalizedContent: 'body of entry A', title: 'A' }
  })
  assert.deepEqual(d, { preserve: true, reason: 'draft-preserved' })
})
