/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 *
 * Unit tests for `resources/pdfjs/app/annotation-merge-core.js` — the
 * three-way rebase that reconciles unsaved local highlight edits with a PDF
 * rewritten on disk by an external writer (typically an agent tool).
 *
 * Strategy confirmed with the user on 2026-08-01: external bytes become the
 * new base, local changes replay on top, LOCAL wins every same-id conflict.
 * Each decision-table cell gets its own test, because every cell is a
 * different way to silently lose someone's work.
 *
 * Usage: node --experimental-strip-types --test test/unittest/pdf-annotation-merge-core.test.mts
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const require = createRequire(import.meta.url)
const core = require(resolve(REPO_ROOT, 'resources/pdfjs/app/annotation-merge-core.js'))

type Record_ = {
  id: string
  labelId: string
  color: string
  page: number
  note: string
  quads: number[]
  rectUnion: number[]
}

function rec(id: string, overrides: Partial<Record_> = {}): Record_ {
  return {
    id,
    labelId: 'hl-key',
    color: '#f2c14e',
    page: 1,
    note: '',
    quads: [0, 0, 10, 0, 0, 10, 10, 10],
    rectUnion: [0, 0, 10, 10],
    ...overrides
  }
}

function ids(records: Array<{ id: string }>) {
  return records.map(r => r.id)
}

// ─────────────── AMC-U-01..03 degenerate cases ───────────────

test('AMC-U-01 all empty in, all empty out', () => {
  const { merged, stats } = core.rebaseAnnotations({ base: [], local: [], external: [] })
  assert.deepEqual(merged, [])
  assert.deepEqual(stats, { localAdds: 0, localMods: 0, localDels: 0, conflicts: 0, externalCount: 0 })
})

test('AMC-U-02 a clean store (local == base) adopts the external set verbatim', () => {
  // This is the everyday case: no unsaved edits, agent rewrote the file.
  // The merge must degenerate to pure adoption — external modifications AND
  // external deletions both stand.
  const base = [rec('a'), rec('b')]
  const local = [rec('a'), rec('b')]
  const external = [rec('a', { note: 'agent note' })] // modified a, deleted b
  const { merged, stats } = core.rebaseAnnotations({ base, local, external })
  assert.deepEqual(ids(merged), ['a'])
  assert.equal(merged[0].note, 'agent note')
  assert.equal(stats.conflicts, 0)
  assert.equal(stats.localAdds + stats.localMods + stats.localDels, 0)
})

test('AMC-U-03 identical three ways is identity', () => {
  const set = [rec('a'), rec('b')]
  const { merged, stats } = core.rebaseAnnotations({ base: set, local: set, external: set })
  assert.deepEqual(ids(merged), ['a', 'b'])
  assert.equal(stats.conflicts, 0)
})

// ─────────────── AMC-U-04..09 the decision table, cell by cell ───────────────

test('AMC-U-04 locally added records survive (appended after external order)', () => {
  const base = [rec('a')]
  const local = [rec('a'), rec('new1')]
  const external = [rec('a'), rec('ext1')]
  const { merged, stats } = core.rebaseAnnotations({ base, local, external })
  assert.deepEqual(ids(merged), ['a', 'ext1', 'new1'])
  assert.equal(stats.localAdds, 1)
  assert.equal(stats.conflicts, 0)
})

test('AMC-U-05 locally modified + externally untouched → local version, no conflict', () => {
  const base = [rec('a')]
  const local = [rec('a', { note: 'my note' })]
  const external = [rec('a')]
  const { merged, stats } = core.rebaseAnnotations({ base, local, external })
  assert.equal(merged[0].note, 'my note')
  assert.equal(stats.localMods, 1)
  assert.equal(stats.conflicts, 0)
})

test('AMC-U-06 both sides modified the same record → local wins, conflict counted', () => {
  const base = [rec('a')]
  const local = [rec('a', { color: '#111111' })]
  const external = [rec('a', { color: '#222222' })]
  const { merged, stats } = core.rebaseAnnotations({ base, local, external })
  assert.equal(merged[0].color, '#111111')
  assert.equal(stats.conflicts, 1)
})

test('AMC-U-07 locally modified + externally deleted → local record resurrected, conflict counted', () => {
  // The user is actively editing this highlight; the external deletion must
  // not silently take their work with it.
  const base = [rec('a'), rec('b')]
  const local = [rec('a', { note: 'editing this' }), rec('b')]
  const external = [rec('b')]
  const { merged, stats } = core.rebaseAnnotations({ base, local, external })
  assert.deepEqual(ids(merged), ['b', 'a'])
  assert.equal(merged[1].note, 'editing this')
  assert.equal(stats.conflicts, 1)
})

test('AMC-U-08 locally deleted + externally untouched → stays deleted, no conflict', () => {
  const base = [rec('a'), rec('b')]
  const local = [rec('b')]
  const external = [rec('a'), rec('b')]
  const { merged, stats } = core.rebaseAnnotations({ base, local, external })
  assert.deepEqual(ids(merged), ['b'])
  assert.equal(stats.localDels, 1)
  assert.equal(stats.conflicts, 0)
})

test('AMC-U-09 locally deleted + externally modified → deletion wins, conflict counted', () => {
  const base = [rec('a')]
  const local: Record_[] = []
  const external = [rec('a', { note: 'agent updated it' })]
  const { merged, stats } = core.rebaseAnnotations({ base, local, external })
  assert.deepEqual(merged, [])
  assert.equal(stats.localDels, 1)
  assert.equal(stats.conflicts, 1)
})

// ─────────────── AMC-U-10..12 identity + robustness ───────────────

test('AMC-U-10 transient UI fields do not make records "different"', () => {
  // recordContentKey mirrors the store fingerprint field set on purpose:
  // paletteAnchor / labelName are display state, not persisted content.
  const a = { ...rec('a'), paletteAnchor: { page: 1 }, labelName: 'Key claim' }
  const b = { ...rec('a'), paletteAnchor: null, labelName: 'Anders' }
  assert.equal(core.recordContentKey(a), core.recordContentKey(b))
})

test('AMC-U-11 id collision (added both sides) resolves to local with a conflict', () => {
  const base: Record_[] = []
  const local = [rec('x', { note: 'mine' })]
  const external = [rec('x', { note: 'theirs' })]
  const { merged, stats } = core.rebaseAnnotations({ base, local, external })
  assert.equal(merged.length, 1)
  assert.equal(merged[0].note, 'mine')
  assert.equal(stats.conflicts, 1)
})

test('AMC-U-12 snapshotRecords is immune to in-place edits of the live records', () => {
  const live = [rec('a')]
  const snapshot = core.snapshotRecords(live)
  live[0].note = 'mutated after snapshot'
  assert.equal(snapshot[0].note, '')
  // And the snapshot round-trips through the same content key.
  assert.equal(
    core.recordContentKey(snapshot[0]),
    core.recordContentKey(rec('a'))
  )
})

test('AMC-U-13 diffAgainstBase classifies added/modified/deleted and omits unchanged', () => {
  const base = [rec('a'), rec('b'), rec('c')]
  const local = [rec('a'), rec('b', { note: 'x' }), rec('d')]
  const changes = core.diffAgainstBase(base, local)
  assert.equal(changes.get('a'), undefined)
  assert.equal(changes.get('b'), 'modified')
  assert.equal(changes.get('c'), 'deleted')
  assert.equal(changes.get('d'), 'added')
})

test('AMC-U-14 determinism: same inputs, same output order, twice', () => {
  // Local state relative to base: 'a' modified, 'b' deleted, 'z' added.
  const base = [rec('a'), rec('b')]
  const local = [rec('a', { note: 'n' }), rec('z')]
  const external = [rec('b'), rec('a'), rec('e')]
  const first = core.rebaseAnnotations({ base, local, external })
  const second = core.rebaseAnnotations({ base, local, external })
  assert.deepEqual(ids(first.merged), ids(second.merged))
  assert.deepEqual(first.stats, second.stats)
  // External order preserved minus the local deletion of 'b', with the local
  // addition appended.
  assert.deepEqual(ids(first.merged), ['a', 'e', 'z'])
  assert.equal(first.stats.localDels, 1)
  assert.equal(first.stats.localMods, 1)
  assert.equal(first.stats.localAdds, 1)
})
