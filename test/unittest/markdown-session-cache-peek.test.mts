/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 *
 * Unit tests for isMarkdownSessionCacheContentHit(): the pure-logic content-hit
 * predicate shared by `readMarkdownSessionCache` (side-effecting, authoritative
 * accounting) and `peekMarkdownSessionCacheHit` (read-only, worker-owner-switch
 * fast path) in `ProjectEditor.tsx`. Both call sites must agree on "is this
 * cached render reusable as-is?", so the decision lives in one pure function and
 * is pinned here.
 *
 * Pair with the autotest suite `run-project-editor-markdown-session-restore`
 * (assertions PMSR-09/10/11), which exercises the synchronous reopen restore
 * end-to-end against the live React component. The unit test locks the math
 * (the hit predicate); the autotest proves the wiring (the synchronous restore
 * actually fires on a shortcut-reopen and leaves the preview non-empty with
 * scroll re-applied).
 *
 * Usage:
 *   node --experimental-strip-types --test test/unittest/markdown-session-cache-peek.test.mts
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  isMarkdownSessionCacheContentHit,
  type MarkdownSessionCacheContentHitInput
} from '../../src/components/ProjectEditor/utils/markdownSessionCachePeek.ts'

const CONTENT = '# Heading\n\nbody text\n'
const RENDERED = '<h1>Heading</h1><p>body text</p>'

function makeEntry(
  overrides: Partial<MarkdownSessionCacheContentHitInput> = {}
): MarkdownSessionCacheContentHitInput {
  return {
    content: CONTENT,
    renderedHtml: RENDERED,
    stale: false,
    ...overrides
  }
}

// ─────────────── MSCP-U-01: the only true case ───────────────

test('MSCP-U-01 content-identical, fresh, non-empty HTML → hit', () => {
  assert.equal(isMarkdownSessionCacheContentHit(makeEntry(), CONTENT), true)
})

// ─────────────── MSCP-U-02: content mismatch ───────────────

test('MSCP-U-02 content mismatch → miss (stale-HTML guard)', () => {
  const entry = makeEntry({ content: CONTENT })
  assert.equal(isMarkdownSessionCacheContentHit(entry, CONTENT + ' edited'), false)
})

test('MSCP-U-02b empty current content vs non-empty cached content → miss', () => {
  assert.equal(isMarkdownSessionCacheContentHit(makeEntry(), ''), false)
})

// ─────────────── MSCP-U-03: stale flag ───────────────

test('MSCP-U-03 stale entry → miss even when content matches', () => {
  assert.equal(isMarkdownSessionCacheContentHit(makeEntry({ stale: true }), CONTENT), false)
})

// ─────────────── MSCP-U-04: empty rendered HTML ───────────────

test('MSCP-U-04 empty renderedHtml → miss even when content matches', () => {
  assert.equal(isMarkdownSessionCacheContentHit(makeEntry({ renderedHtml: '' }), CONTENT), false)
})

// ─────────────── MSCP-U-05: null / undefined entry ───────────────

test('MSCP-U-05 null entry → miss', () => {
  assert.equal(isMarkdownSessionCacheContentHit(null, CONTENT), false)
})

test('MSCP-U-05b undefined entry → miss', () => {
  assert.equal(isMarkdownSessionCacheContentHit(undefined, CONTENT), false)
})

// ─────────────── MSCP-U-06: each failing dimension is independently sufficient ───────────────

test('MSCP-U-06 stale + mismatch + empty all individually block the hit', () => {
  // Sanity cross-check: starting from a true hit, flipping ANY single
  // dimension must turn it false, so a future refactor that drops one of the
  // three guards fails loudly here.
  assert.equal(isMarkdownSessionCacheContentHit(makeEntry(), CONTENT), true)
  assert.equal(isMarkdownSessionCacheContentHit(makeEntry({ stale: true }), CONTENT), false)
  assert.equal(isMarkdownSessionCacheContentHit(makeEntry({ renderedHtml: '' }), CONTENT), false)
  assert.equal(isMarkdownSessionCacheContentHit(makeEntry(), 'different'), false)
})

// ─────────────── MSCP-U-07: byte-exact content match (no normalization) ───────────────

test('MSCP-U-07 trailing-whitespace difference is treated as a mismatch', () => {
  // The predicate must be byte-exact: a whitespace-only difference still means
  // the rendered HTML could be stale, so reuse is not allowed.
  const entry = makeEntry({ content: 'a\n' })
  assert.equal(isMarkdownSessionCacheContentHit(entry, 'a'), false)
  assert.equal(isMarkdownSessionCacheContentHit(entry, 'a\n'), true)
})

// ─────────────── MSCP-U-08: non-poisoning — a transient mismatch read must not
// permanently disable a later content-identical hit ───────────────

test('MSCP-U-08 a content-mismatch read does NOT mutate the entry (no self-poison)', () => {
  // Regression for the EDR/first-reopen hang (PMSR-09/10/11/13/13a/13b, PMN-41,
  // CDP-10): `readMarkdownSessionCache` used to flip `entry.stale = true` on ANY
  // content mismatch, turning a transient read-time mismatch (fileContentRef
  // briefly stale during a throttled reopen / Diff round-trip) into a PERMANENT
  // miss — the fast cache-restore path stayed dead for that whole reopen and the
  // slow fresh render overran the budget on the FIRST reopen only.
  //
  // The hit predicate is pure (never mutates), so reading it with mismatched
  // content must leave the entry untouched, and a subsequent read with the
  // matching content must still hit. This pins the "do not self-poison on a
  // transient mismatch" contract the production read path now relies on.
  const entry = makeEntry()
  const before = { ...entry }
  // Transient mismatch read (e.g. fileContentRef momentarily empty/stale).
  assert.equal(isMarkdownSessionCacheContentHit(entry, ''), false)
  assert.equal(isMarkdownSessionCacheContentHit(entry, CONTENT + ' edited'), false)
  // The entry must be byte-for-byte unchanged — no stale flag, no content/html
  // mutation — so the later matching read still hits.
  assert.deepEqual(entry, before)
  assert.equal(entry.stale, false)
  // Content settles back to the cached value → the entry is reusable again.
  assert.equal(isMarkdownSessionCacheContentHit(entry, CONTENT), true)
})
