/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 *
 * Unit tests for the annotation list's pure decisions
 * (`src/components/ProjectEditor/AnnotationPanel/annotationListModel.ts`)
 * and for the outline auto-follow comparator
 * (`resources/pdfjs/app/outline-follow-core.js`).
 *
 * Both are places where "looks right in the one case I tried" is easy and
 * being right is not: an unstable list comparator makes rows jump on every
 * re-render, and an outline follower that picks by page alone sits on the
 * wrong heading for every multi-section page in the document.
 *
 * Pair with the autotest suite `run-pdf-highlight`, which drives the panel
 * against real annotations.
 *
 * Usage: node --experimental-strip-types --test test/unittest/pdf-annotation-list-model.test.mts
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

import {
  ALL_LABELS,
  availableCopyActions,
  buildCopyText,
  buildLabelFilterOptions,
  filterAnnotations,
  isNoteExpanded,
  normalizeNewLabel,
  normalizeStoredLabels,
  pruneNoteOverrides,
  shouldOpenPanelOnLoad,
  shouldScrollToBottom,
  sortAnnotations
} from '../../src/components/ProjectEditor/AnnotationPanel/annotationListModel.ts'

const require = createRequire(import.meta.url)
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const outlineCore = require(resolve(REPO_ROOT, 'resources/pdfjs/app/outline-follow-core.js'))

type Item = Parameters<typeof sortAnnotations>[0][number]

function annot(overrides: Partial<Item> & { id: string }): Item {
  return {
    groupId: overrides.id,
    labelId: 'hl-key',
    labelName: 'Key claim',
    color: '#f2c14e',
    page: 1,
    note: '',
    textSnapshot: 'text',
    createdAt: 1000,
    updatedAt: 1000,
    ...overrides
  } as Item
}

// ─────────────── PAL-U-01..05 ordering ───────────────

test('PAL-U-01 created order follows the order they were made', () => {
  const items = [
    annot({ id: 'c', createdAt: 300, page: 1 }),
    annot({ id: 'a', createdAt: 100, page: 9 }),
    annot({ id: 'b', createdAt: 200, page: 5 })
  ]
  assert.deepEqual(sortAnnotations(items, 'created').map((i) => i.id), ['a', 'b', 'c'])
})

test('PAL-U-02 page order follows the document', () => {
  const items = [
    annot({ id: 'c', createdAt: 100, page: 9 }),
    annot({ id: 'a', createdAt: 300, page: 1 }),
    annot({ id: 'b', createdAt: 200, page: 5 })
  ]
  assert.deepEqual(sortAnnotations(items, 'page').map((i) => i.id), ['a', 'b', 'c'])
})

test('PAL-U-03 same page falls back to creation order', () => {
  const items = [
    annot({ id: 'second', createdAt: 200, page: 3 }),
    annot({ id: 'first', createdAt: 100, page: 3 })
  ]
  assert.deepEqual(sortAnnotations(items, 'page').map((i) => i.id), ['first', 'second'])
})

test('PAL-U-04 the comparator is total, so rows never jump', () => {
  // Two highlights made in the same millisecond on the same page are entirely
  // plausible (one drag producing two page segments). Without the id
  // tiebreaker their relative order would depend on sort stability, and the
  // list would reshuffle on unrelated re-renders.
  const items = [
    annot({ id: 'zzz', createdAt: 100, page: 2 }),
    annot({ id: 'aaa', createdAt: 100, page: 2 })
  ]
  const once = sortAnnotations(items, 'page').map((i) => i.id)
  const twice = sortAnnotations([...items].reverse(), 'page').map((i) => i.id)
  assert.deepEqual(once, ['aaa', 'zzz'])
  assert.deepEqual(once, twice, 'order must not depend on input order')
})

test('PAL-U-05 sorting never adds or drops entries', () => {
  const items = [annot({ id: 'a' }), annot({ id: 'b' }), annot({ id: 'c' })]
  for (const mode of ['created', 'page'] as const) {
    assert.equal(sortAnnotations(items, mode).length, items.length)
  }
})

// ─────────────── PAL-U-06..08 filtering ───────────────

test('PAL-U-06 the all-labels sentinel keeps everything', () => {
  const items = [annot({ id: 'a', labelId: 'x' }), annot({ id: 'b', labelId: 'y' })]
  assert.equal(filterAnnotations(items, ALL_LABELS).length, 2)
  assert.equal(filterAnnotations(items, '').length, 2, 'empty behaves as "all"')
})

test('PAL-U-07 filtering keeps only the requested label', () => {
  const items = [annot({ id: 'a', labelId: 'x' }), annot({ id: 'b', labelId: 'y' })]
  assert.deepEqual(filterAnnotations(items, 'x').map((i) => i.id), ['a'])
})

test('PAL-U-08 filter options cover labels the palette no longer has', () => {
  // A document annotated by an older version — or by the reference project,
  // whose label set differs — must still offer a working filter rather than
  // an empty dropdown.
  const items = [
    annot({ id: 'a', labelId: 'hl-key', labelName: 'Key claim' }),
    annot({ id: 'b', labelId: 'legacy', labelName: 'Imported' }),
    annot({ id: 'c', labelId: 'legacy', labelName: 'Imported' })
  ]
  const options = buildLabelFilterOptions(items, [
    { id: 'hl-key', name: 'Key claim', color: '#f2c14e' },
    { id: 'hl-unused', name: 'Never used', color: '#5aa9e6' }
  ])
  assert.deepEqual(options.map((o) => o.id), ['hl-key', 'legacy'])
  assert.equal(options[1].count, 2)
  assert.equal(options[1].color, null, 'unknown labels carry no palette colour')
  assert.ok(!options.some((o) => o.id === 'hl-unused'), 'labels with no annotations are omitted')
})

// ─────────────── PAL-U-09..11 auto-scroll ───────────────

test('PAL-U-09 auto-scroll only fires under created ordering', () => {
  const base = { enabled: true, previousCount: 1, nextCount: 2 }
  assert.equal(shouldScrollToBottom({ ...base, mode: 'created' }), true)
  // Under page ordering a new highlight can land anywhere, so yanking the
  // viewport to the end would lose the reader's place for no reason.
  assert.equal(shouldScrollToBottom({ ...base, mode: 'page' }), false)
})

test('PAL-U-10 auto-scroll respects the preference and only fires on growth', () => {
  assert.equal(
    shouldScrollToBottom({ enabled: false, mode: 'created', previousCount: 1, nextCount: 2 }),
    false
  )
  assert.equal(
    shouldScrollToBottom({ enabled: true, mode: 'created', previousCount: 2, nextCount: 1 }),
    false,
    'a deletion must not scroll'
  )
  assert.equal(
    shouldScrollToBottom({ enabled: true, mode: 'created', previousCount: 2, nextCount: 2 }),
    false,
    'a note edit must not scroll'
  )
})

// ─────────────── PAL-U-11..13 note expansion ───────────────

test('PAL-U-11 a per-entry choice overrides the global default', () => {
  const overrides = new Map([['a', false]])
  assert.equal(isNoteExpanded('a', true, overrides), false, 'collapsed by hand stays collapsed')
  assert.equal(isNoteExpanded('b', true, overrides), true, 'others follow the default')
  assert.equal(isNoteExpanded('a', false, new Map([['a', true]])), true)
})

test('PAL-U-12 overrides are keyed by id, so sorting cannot disturb them', () => {
  // The defect this prevents: keying by list position meant re-sorting or
  // filtering silently moved a user's collapse choice onto a different entry.
  const overrides = new Map([['b', false]])
  const items = [annot({ id: 'a' }), annot({ id: 'b' })]
  for (const mode of ['created', 'page'] as const) {
    for (const item of sortAnnotations(items, mode)) {
      assert.equal(isNoteExpanded(item.id, true, overrides), item.id !== 'b')
    }
  }
})

test('PAL-U-13 overrides for deleted annotations are pruned', () => {
  const overrides = new Map([['a', false], ['gone', true]])
  const pruned = pruneNoteOverrides(overrides, [annot({ id: 'a' })])
  assert.deepEqual([...pruned.keys()], ['a'])
})

// ─────────────── PAL-U-14..16 copy ───────────────

test('PAL-U-14 copy actions reflect what the entry actually has', () => {
  assert.deepEqual(availableCopyActions(annot({ id: 'a', textSnapshot: 'x', note: 'n' })), {
    highlight: true, note: true, both: true
  })
  assert.deepEqual(availableCopyActions(annot({ id: 'b', textSnapshot: 'x', note: '   ' })), {
    highlight: true, note: false, both: false
  })
  assert.deepEqual(availableCopyActions(annot({ id: 'c', textSnapshot: '', note: 'n' })), {
    highlight: false, note: true, both: false
  })
})

test('PAL-U-15 copy text is trimmed and separated for reading', () => {
  const item = annot({ id: 'a', textSnapshot: '  quoted text  ', note: '  my comment  ' })
  assert.equal(buildCopyText(item, 'highlight'), 'quoted text')
  assert.equal(buildCopyText(item, 'note'), 'my comment')
  assert.equal(buildCopyText(item, 'both'), 'quoted text\n\nmy comment')
})

test('PAL-U-16 "both" degrades gracefully when one side is empty', () => {
  assert.equal(buildCopyText(annot({ id: 'a', note: '' }), 'both'), 'text')
  assert.equal(buildCopyText(annot({ id: 'b', textSnapshot: '', note: 'n' }), 'both'), 'n')
})

// ─────────────── PAL-U-17..19 panel opening + labels ───────────────

test('PAL-U-17 the panel opens for a document that has highlights', () => {
  assert.equal(shouldOpenPanelOnLoad({ annotationCount: 3, userChoice: null }), true)
  assert.equal(shouldOpenPanelOnLoad({ annotationCount: 0, userChoice: null }), false)
  // An explicit choice always wins, so closing the panel stays closed even on
  // a heavily annotated document.
  assert.equal(shouldOpenPanelOnLoad({ annotationCount: 3, userChoice: false }), false)
  assert.equal(shouldOpenPanelOnLoad({ annotationCount: 0, userChoice: true }), true)
})

test('PAL-U-18 new labels are validated before they can reach a PDF', () => {
  const existing = [{ id: 'hl-key', name: 'Key claim', color: '#f2c14e' }]
  assert.equal(normalizeNewLabel('', '#ffffff', existing, 'abc'), null, 'empty name')
  assert.equal(normalizeNewLabel('   ', '#ffffff', existing, 'abc'), null, 'blank name')
  assert.equal(normalizeNewLabel('x'.repeat(41), '#ffffff', existing, 'abc'), null, 'over-long name')
  assert.equal(normalizeNewLabel('New', 'red', existing, 'abc'), null, 'colour must be hex')
  assert.equal(normalizeNewLabel('New', '#fff', existing, 'abc'), null, '3-digit hex rejected')
  assert.equal(normalizeNewLabel('key claim', '#ffffff', existing, 'abc'), null, 'duplicate name')

  const created = normalizeNewLabel('  Counter-example  ', '#FFFFFF', existing, 'k9')
  assert.deepEqual(created, { id: 'hl-custom-k9', name: 'Counter-example', color: '#ffffff' })
})

test('PAL-U-19 a corrupted stored label list falls back instead of breaking', () => {
  // Labels are what makes highlighting possible at all, so an empty or invalid
  // list must not leave the user unable to highlight anything.
  const fallback = [{ id: 'hl-key', name: 'Key claim', color: '#f2c14e' }]
  assert.deepEqual(normalizeStoredLabels(null, fallback), fallback)
  assert.deepEqual(normalizeStoredLabels('nonsense', fallback), fallback)
  assert.deepEqual(normalizeStoredLabels([{ id: '', name: '', color: '' }], fallback), fallback)
  assert.deepEqual(
    normalizeStoredLabels([{ id: 'a', name: 'A', color: '#123456' }, { id: 'a', name: 'dup', color: '#654321' }], fallback),
    [{ id: 'a', name: 'A', color: '#123456' }],
    'duplicate ids collapse to the first'
  )
})

// ─────────────── PAL-U-20..26 outline auto-follow ───────────────

const pick = outlineCore.pickActiveOutlineOrder as (
  entries: Array<{ order: number; page: number; top: number | null }>,
  location: { page: number; top: number } | null
) => number | null

test('PAL-U-20 an earlier page selects the section running into it', () => {
  const entries = [
    { order: 0, page: 1, top: 0 },
    { order: 1, page: 5, top: 0 }
  ]
  assert.equal(pick(entries, { page: 3, top: 100 }), 0)
})

test('PAL-U-21 several sections on one page resolve by scroll position', () => {
  // The whole point of scroll-following. Page-number matching would sit on
  // section A for the entire page.
  const entries = [
    { order: 0, page: 2, top: 0 },
    { order: 1, page: 2, top: 300 },
    { order: 2, page: 2, top: 600 }
  ]
  assert.equal(pick(entries, { page: 2, top: 0 }), 0)
  assert.equal(pick(entries, { page: 2, top: 350 }), 1)
  assert.equal(pick(entries, { page: 2, top: 900 }), 2)
})

test('PAL-U-22 a heading still below the viewport does not steal the highlight', () => {
  // Scrolled onto page 2, but its first heading is 400px down: the reader is
  // still inside the section that started on page 1.
  const entries = [
    { order: 0, page: 1, top: 100 },
    { order: 1, page: 2, top: 400 }
  ]
  assert.equal(pick(entries, { page: 2, top: 50 }), 0)
})

test('PAL-U-23 landing exactly on a heading selects that heading', () => {
  // What clicking an outline entry does. Without the epsilon this resolves to
  // the previous section, and the outline appears not to follow the click.
  const entries = [
    { order: 0, page: 1, top: 0 },
    { order: 1, page: 2, top: 200 }
  ]
  assert.equal(pick(entries, { page: 2, top: 200 }), 1)
})

test('PAL-U-24 destinations with no position still yield a sensible answer', () => {
  // /Fit destinations carry no y coordinate. Falling back to the page's first
  // entry beats reporting nothing.
  const entries = [
    { order: 0, page: 1, top: null },
    { order: 1, page: 2, top: null }
  ]
  assert.equal(pick(entries, { page: 2, top: 100 }), 1)
})

test('PAL-U-25 an out-of-order outline is still resolved by document position', () => {
  // Outline entries are not guaranteed to be in document order.
  const entries = [
    { order: 0, page: 9, top: 0 },
    { order: 1, page: 2, top: 0 },
    { order: 2, page: 5, top: 0 }
  ]
  assert.equal(pick(entries, { page: 6, top: 0 }), 2, 'nearest preceding entry, not the last seen')
})

test('PAL-U-26 degenerate inputs return null rather than guessing', () => {
  assert.equal(pick([], { page: 1, top: 0 }), null)
  assert.equal(pick([{ order: 0, page: 1, top: 0 }], null), null)
  assert.equal(pick([{ order: 0, page: 5, top: 0 }], { page: 1, top: 0 }), null, 'nothing before us')
})

// ─────────────── PAL-U-27..32 label management (rename / recolor / delete) ───────────────
// Added 2026-08-01 with the manage-labels dialog. Palette-only semantics on
// purpose: records store their own labelName + color, so managing the palette
// never rewrites a user's PDFs.

import {
  deleteLabel,
  isCustomLabelId,
  recolorLabel,
  renameLabel
} from '../../src/components/ProjectEditor/AnnotationPanel/annotationListModel.ts'

const MANAGED_LABELS = [
  { id: 'hl-key', name: 'Key claim', color: '#f2c14e' },
  { id: 'hl-custom-abc', name: 'Mine', color: '#c792ea' },
  { id: 'hl-custom-def', name: 'Also mine', color: '#f78c6c' }
]

test('PAL-U-27 only hl-custom-* labels are manageable', () => {
  assert.equal(isCustomLabelId('hl-custom-abc'), true)
  assert.equal(isCustomLabelId('hl-key'), false)
  // Built-ins are refused by every mutation, not just hidden in the UI.
  assert.equal(renameLabel(MANAGED_LABELS, 'hl-key', 'Renamed'), null)
  assert.equal(recolorLabel(MANAGED_LABELS, 'hl-key', '#123456'), null)
  assert.equal(deleteLabel(MANAGED_LABELS, 'hl-key'), null)
})

test('PAL-U-28 rename replaces the name and nothing else', () => {
  const next = renameLabel(MANAGED_LABELS, 'hl-custom-abc', '  Better name  ')
  assert.ok(next)
  const renamed = next!.find(l => l.id === 'hl-custom-abc')!
  assert.equal(renamed.name, 'Better name', 'trimmed')
  assert.equal(renamed.color, '#c792ea', 'color untouched')
  assert.equal(next!.length, MANAGED_LABELS.length)
  assert.equal(MANAGED_LABELS[1].name, 'Mine', 'input array untouched')
})

test('PAL-U-29 rename refuses empty, oversized and duplicate names', () => {
  assert.equal(renameLabel(MANAGED_LABELS, 'hl-custom-abc', '   '), null)
  assert.equal(renameLabel(MANAGED_LABELS, 'hl-custom-abc', 'x'.repeat(41)), null)
  // Case-insensitive duplicate against ANY other label, built-ins included.
  assert.equal(renameLabel(MANAGED_LABELS, 'hl-custom-abc', 'also MINE'), null)
  assert.equal(renameLabel(MANAGED_LABELS, 'hl-custom-abc', 'key CLAIM'), null)
  // Renaming to its own current name is a no-op, not a duplicate.
  assert.ok(renameLabel(MANAGED_LABELS, 'hl-custom-abc', 'Mine'))
})

test('PAL-U-30 recolor validates the hex form and keeps the name', () => {
  const next = recolorLabel(MANAGED_LABELS, 'hl-custom-abc', '#ABCDEF')
  assert.ok(next)
  assert.equal(next!.find(l => l.id === 'hl-custom-abc')!.color, '#abcdef', 'lowercased')
  assert.equal(recolorLabel(MANAGED_LABELS, 'hl-custom-abc', 'red'), null)
  assert.equal(recolorLabel(MANAGED_LABELS, 'hl-custom-abc', '#12345'), null)
})

test('PAL-U-31 delete removes exactly the target label', () => {
  const next = deleteLabel(MANAGED_LABELS, 'hl-custom-abc')
  assert.ok(next)
  assert.deepEqual(next!.map(l => l.id), ['hl-key', 'hl-custom-def'])
})

test('PAL-U-32 mutations against an unknown id are refused, not ignored', () => {
  assert.equal(renameLabel(MANAGED_LABELS, 'hl-custom-missing', 'x'), null)
  assert.equal(recolorLabel(MANAGED_LABELS, 'hl-custom-missing', '#123456'), null)
  assert.equal(deleteLabel(MANAGED_LABELS, 'hl-custom-missing'), null)
})
