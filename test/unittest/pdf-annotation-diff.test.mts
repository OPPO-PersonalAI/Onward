/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 *
 * Unit tests for `src/components/GitPdfCompare/annotationDiffModel.ts` — the
 * three-state annotation diff behind the Git Diff "annotation changes" panel.
 *
 * Every assertion is phrased from the reader's seat: "the panel must tell me
 * exactly which highlights appeared, vanished, or changed — and clicking one
 * must aim at the pane where that record actually exists."
 *
 * Usage: node --experimental-strip-types --test test/unittest/pdf-annotation-diff.test.mts
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  diffAnnotationSets,
  diffForFileStatus,
  emphasisIdsForPanes,
  type PdfDiffAnnotation
} from '../../src/components/GitPdfCompare/annotationDiffModel.ts'

function ann(id: string, overrides: Partial<PdfDiffAnnotation> = {}): PdfDiffAnnotation {
  return {
    id,
    labelId: 'hl-key',
    labelName: 'Key claim',
    color: '#f2c14e',
    page: 1,
    note: '',
    textSnapshot: 'quoted passage',
    createdAt: 1000,
    updatedAt: 1000,
    ...overrides
  }
}

// ─────────────── PAD-U-01..04 degenerate shapes ───────────────

test('PAD-U-01 empty vs empty produces nothing', () => {
  const result = diffAnnotationSets([], [])
  assert.deepEqual(result.entries, [])
  assert.deepEqual(result.counts, { added: 0, removed: 0, changed: 0, unchanged: 0, duplicateIds: 0 })
})

test('PAD-U-02 everything on the modified side of an empty original is added', () => {
  const result = diffAnnotationSets([], [ann('a'), ann('b')])
  assert.equal(result.counts.added, 2)
  assert.ok(result.entries.every(e => e.kind === 'added' && e.jumpPane === 'modified'))
})

test('PAD-U-03 everything missing from an emptied modified side is removed', () => {
  const result = diffAnnotationSets([ann('a'), ann('b')], [])
  assert.equal(result.counts.removed, 2)
  assert.ok(result.entries.every(e => e.kind === 'removed' && e.jumpPane === 'original'))
})

test('PAD-U-04 identical sets yield zero entries and count as unchanged', () => {
  const result = diffAnnotationSets([ann('a'), ann('b')], [ann('a'), ann('b')])
  assert.equal(result.entries.length, 0)
  assert.equal(result.counts.unchanged, 2)
})

// ─────────────── PAD-U-05..10 per-field change detection ───────────────

test('PAD-U-05 a note edit is a change naming exactly the note field', () => {
  const result = diffAnnotationSets([ann('a')], [ann('a', { note: 'now with a note' })])
  assert.equal(result.counts.changed, 1)
  assert.deepEqual(result.entries[0].changedFields, ['note'])
})

test('PAD-U-06 a recolor names exactly the color field', () => {
  const result = diffAnnotationSets([ann('a')], [ann('a', { color: '#5aa9e6' })])
  assert.deepEqual(result.entries[0].changedFields, ['color'])
})

test('PAD-U-07 a relabel names labelId — but a mere label RENAME is not a change', () => {
  const relabeled = diffAnnotationSets([ann('a')], [ann('a', { labelId: 'hl-method' })])
  assert.deepEqual(relabeled.entries[0].changedFields, ['labelId'])
  // Renaming the label rewords labelName on every record carrying it without
  // any annotation having been edited; the panel must stay silent.
  const renamed = diffAnnotationSets([ann('a')], [ann('a', { labelName: 'Renamed label' })])
  assert.equal(renamed.entries.length, 0)
  assert.equal(renamed.counts.unchanged, 1)
})

test('PAD-U-08 a page move and an underlying-text change are both named', () => {
  const result = diffAnnotationSets(
    [ann('a')],
    [ann('a', { page: 3, textSnapshot: 'reflowed passage' })]
  )
  assert.deepEqual(result.entries[0].changedFields?.sort(), ['page', 'textSnapshot'])
})

test('PAD-U-09 changed entries carry both versions for a before/after rendering', () => {
  const result = diffAnnotationSets([ann('a', { note: 'old' })], [ann('a', { note: 'new' })])
  assert.equal(result.entries[0].before?.note, 'old')
  assert.equal(result.entries[0].annotation.note, 'new')
})

test('PAD-U-10 updatedAt alone never produces a change entry', () => {
  // Timestamps move on every save; diffing them would flag every annotation
  // in every comparison.
  const result = diffAnnotationSets([ann('a', { updatedAt: 1 })], [ann('a', { updatedAt: 999 })])
  assert.equal(result.entries.length, 0)
})

// ─────────────── PAD-U-11..13 mixed sets, ordering, robustness ───────────────

test('PAD-U-11 mixed add + remove + change in one comparison', () => {
  const result = diffAnnotationSets(
    [ann('keep'), ann('gone'), ann('edit', { note: 'v1' })],
    [ann('keep'), ann('edit', { note: 'v2' }), ann('new')]
  )
  assert.deepEqual(result.counts, { added: 1, removed: 1, changed: 1, unchanged: 1, duplicateIds: 0 })
})

test('PAD-U-12 entries come back in reading order: page, then creation time, then id', () => {
  const result = diffAnnotationSets(
    [ann('r2', { page: 5, createdAt: 50 }), ann('r1', { page: 2, createdAt: 90 })],
    [ann('a2', { page: 2, createdAt: 10 }), ann('a1', { page: 2, createdAt: 5 })]
  )
  assert.deepEqual(result.entries.map(e => e.annotation.id), ['a1', 'a2', 'r1', 'r2'])
})

test('PAD-U-13 duplicate ids within one side resolve to last-wins and are counted', () => {
  const result = diffAnnotationSets(
    [ann('a', { note: 'first' }), ann('a', { note: 'second' })],
    [ann('a', { note: 'second' })]
  )
  assert.equal(result.entries.length, 0, 'last-wins made the sides equal')
  assert.equal(result.counts.duplicateIds, 1)
})

// ─────────────── PAD-U-14..15 file-status degradation ───────────────

test('PAD-U-14 a file-level added PDF lists every annotation as added, whatever the stale original claims', () => {
  const result = diffForFileStatus('added', [ann('stale')], [ann('x'), ann('y')])
  assert.equal(result.counts.added, 2)
  assert.equal(result.counts.removed, 0)
})

test('PAD-U-15 a file-level deleted PDF lists every annotation as removed', () => {
  const result = diffForFileStatus('deleted', [ann('x')], [ann('stale')])
  assert.equal(result.counts.removed, 1)
  assert.equal(result.counts.added, 0)
  assert.equal(result.entries[0].jumpPane, 'original')
})

// ─────────────── PAD-U-16..17 pane targeting + emphasis sets ───────────────

test('PAD-U-16 jump targets: added/changed aim at modified, removed aims at original', () => {
  const result = diffAnnotationSets(
    [ann('gone'), ann('edit', { note: 'v1' })],
    [ann('edit', { note: 'v2' }), ann('new')]
  )
  const byId = new Map(result.entries.map(e => [e.annotation.id, e]))
  assert.equal(byId.get('new')?.jumpPane, 'modified')
  assert.equal(byId.get('edit')?.jumpPane, 'modified')
  assert.equal(byId.get('gone')?.jumpPane, 'original')
})

test('PAD-U-17 emphasis sets outline each record on the pane where it exists', () => {
  const result = diffAnnotationSets(
    [ann('gone'), ann('edit', { note: 'v1' })],
    [ann('edit', { note: 'v2' }), ann('new')]
  )
  const emphasis = emphasisIdsForPanes(result)
  assert.deepEqual(emphasis.modified.sort(), ['edit', 'new'])
  assert.deepEqual(emphasis.original.sort(), ['edit', 'gone'])
})
