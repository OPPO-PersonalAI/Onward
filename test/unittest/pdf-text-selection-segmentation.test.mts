/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 *
 * Unit tests for the grapheme / ligature segmentation in
 * `resources/pdfjs/app/text-selection-core.js`.
 *
 * What this pins down: what counts as ONE selectable unit inside a PDF text
 * layer. Get it wrong and a drag stops halfway through a character — the user
 * sees `ff` out of `ffi`, or half of an emoji, or a base letter without its
 * combining mark. That is not cosmetic: a highlight is persisted as the
 * PDF-user-space quads of the selection, so a bad boundary is written into the
 * annotation geometry and stays wrong forever.
 *
 * Pair with the autotest suite `run-pdf-text-selection` (assertions
 * `pdf-textsel-*`), which drives real drags against a real PDF in the packaged
 * app. This file locks the maths; that one locks the wiring.
 *
 * Usage: node --experimental-strip-types --test test/unittest/pdf-text-selection-segmentation.test.mts
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const require = createRequire(import.meta.url)
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const core = require(resolve(REPO_ROOT, 'resources/pdfjs/app/text-selection-core.js'))

type Segment = { startOffset: number; endOffset: number }

/** Render segmentation as the substrings it produces — far easier to read in
 *  a failure message than a list of offset pairs. */
function segmentsOf(text: string): string[] {
  return (core.getTextNodeGraphemeSegments(text) as Segment[]).map((s) =>
    text.slice(s.startOffset, s.endOffset)
  )
}

// ─────────────── PTS-U-01..04 plain text ───────────────

test('PTS-U-01 ASCII splits one segment per character', () => {
  assert.deepEqual(segmentsOf('abc'), ['a', 'b', 'c'])
})

test('PTS-U-02 empty string yields no segments', () => {
  assert.deepEqual(segmentsOf(''), [])
})

test('PTS-U-03 segments tile the string exactly, with no gaps or overlaps', () => {
  // The engine converts offsets into DOM Range boundaries. A gap would make a
  // character unreachable by drag; an overlap would let one drag position map
  // to two different carets.
  for (const text of ['abc', 'office', 'ábc', '👩‍💻x', 'مرحبا', '  spaced  ']) {
    const segments = core.getTextNodeGraphemeSegments(text) as Segment[]
    let cursor = 0
    for (const segment of segments) {
      assert.equal(segment.startOffset, cursor, `gap/overlap in ${JSON.stringify(text)}`)
      assert.ok(segment.endOffset > segment.startOffset, `empty segment in ${JSON.stringify(text)}`)
      cursor = segment.endOffset
    }
    assert.equal(cursor, text.length, `did not reach end of ${JSON.stringify(text)}`)
  }
})

test('PTS-U-04 surrogate pairs are never split', () => {
  // '𝐀' is a single astral code point stored as two UTF-16 units. Splitting it
  // produces a lone surrogate, which is not valid text.
  assert.deepEqual(segmentsOf('x𝐀y'), ['x', '𝐀', 'y'])
})

// ─────────────── PTS-U-05..09 ligatures ───────────────

test('PTS-U-05 standalone ffi is one unit', () => {
  assert.deepEqual(segmentsOf('ffi'), ['ffi'])
})

test('PTS-U-06 ffi inside a word is one unit', () => {
  // Real-world driver: academic PDFs typeset `office` / `efficient` with an
  // ffi ligature glyph. Dragging must never yield `ff` or `fi`.
  assert.deepEqual(segmentsOf('office'), ['o', 'ffi', 'c', 'e'])
  assert.deepEqual(segmentsOf('efficient'), ['e', 'ffi', 'c', 'i', 'e', 'n', 't'])
})

test('PTS-U-07 short ligatures merge only at token boundaries', () => {
  // `ff` / `fi` / `fl` are merged conservatively: merging them everywhere
  // would mangle ordinary English words, so they only merge when the run sits
  // on a token boundary.
  assert.deepEqual(segmentsOf('ff'), ['ff'])
  assert.deepEqual(segmentsOf('fi'), ['fi'])
  assert.deepEqual(segmentsOf('fl'), ['fl'])
})

test('PTS-U-08 ligature merging never loses or reorders characters', () => {
  for (const text of ['ffi', 'office', 'ff', 'fluffier', 'affix']) {
    assert.equal(segmentsOf(text).join(''), text, `round-trip failed for ${text}`)
  }
})

test('PTS-U-09 two-letter ligatures do NOT merge mid-word', () => {
  // This is the whole point of the two-tier rule. `ffi` / `ffl` are distinctive
  // enough to merge anywhere, but `ff` / `fi` / `fl` are common letter pairs:
  // merging them mid-word would make `offer` unselectable at the `f|f` caret
  // even though the font rendered two separate glyphs there.
  assert.deepEqual(segmentsOf('offer'), ['o', 'f', 'f', 'e', 'r'])
  assert.deepEqual(segmentsOf('film'), ['f', 'i', 'l', 'm'])
  // …while the three-letter ligature still merges inside a word.
  assert.deepEqual(segmentsOf('office'), ['o', 'ffi', 'c', 'e'])
})

test('PTS-U-09b isLigatureTokenBoundary is what draws that line', () => {
  // Cross-check the predicate against the behaviour above so the two cannot
  // drift apart in a later refactor.
  assert.equal(core.isLigatureTokenBoundary('ff', 0, 2), true, 'standalone: both sides absent')
  assert.equal(core.isLigatureTokenBoundary('offer', 1, 3), false, 'preceded by a letter')
  assert.equal(core.isLigatureTokenBoundary('off ', 1, 3), false, 'still preceded by a letter')
  assert.equal(core.isLigatureTokenBoundary('(ff)', 1, 3), true, 'punctuation counts as a boundary')
  assert.equal(core.isLigatureBoundaryCharacter(undefined), true, 'end of string is a boundary')
  assert.equal(core.isLigatureBoundaryCharacter('a'), false)
})

// ─────────────── PTS-U-10..12 combining marks and Arabic ───────────────

test('PTS-U-10 a base letter keeps its combining mark', () => {
  // 'e' + U+0301 COMBINING ACUTE renders as a single é.
  assert.deepEqual(segmentsOf('éx'), ['é', 'x'])
})

test('PTS-U-11 isCombiningCodePoint covers Latin and Arabic mark ranges', () => {
  assert.equal(core.isCombiningCodePoint(0x0301), true, 'Latin combining acute')
  assert.equal(core.isCombiningCodePoint(0x064b), true, 'Arabic fathatan')
  assert.equal(core.isCombiningCodePoint(0x0041), false, 'Latin capital A is not combining')
})

test('PTS-U-12 Arabic lam-alef is a single unit', () => {
  // U+0644 LAM followed by U+0627 ALEF renders as one lam-alef glyph; a caret
  // between them has no visual position to land on.
  const segments = segmentsOf('لا')
  assert.deepEqual(segments, ['لا'])
})

// ─────────────── PTS-U-13..15 prefix marks ───────────────

test('PTS-U-13 a "prefix mark" is a combining/modifier code point, not a bullet', () => {
  // Naming trap worth pinning: this predicate is about marks that attach to
  // the following glyph (combining diacritics, U+02C6 modifier circumflex),
  // which pdf.js sometimes emits as a separate leading text node. Ordinary
  // list bullets are base characters and must NOT match, or the engine would
  // fold a bullet into the first word of the item.
  assert.equal(core.isTextSelectionPrefixMarkText('́'), true, 'combining acute')
  assert.equal(core.isTextSelectionPrefixMarkText('ˆ'), true, 'modifier circumflex')
  assert.equal(core.isTextSelectionPrefixMarkText('•'), false, 'bullet is a base character')
  assert.equal(core.isTextSelectionPrefixMarkText('a'), false, 'letter is not a mark')
  assert.equal(core.isTextSelectionPrefixMarkText(''), false, 'empty never matches')

  assert.equal(core.isValidPrefixMarkBaseText('word'), true, 'a word can carry a prefix mark')
  assert.equal(core.isValidPrefixMarkBaseText(' word'), false, 'whitespace cannot')
  assert.equal(core.isValidPrefixMarkBaseText('́x'), false, 'another mark cannot')
})

test('PTS-U-14 whitespace segments are recognised as whitespace', () => {
  assert.equal(core.isWhitespaceTextSelectionSegment(' '), true)
  assert.equal(core.isWhitespaceTextSelectionSegment(' '), true, 'non-breaking space')
  assert.equal(core.isWhitespaceTextSelectionSegment('\t\n'), true)
  assert.equal(core.isWhitespaceTextSelectionSegment('a'), false)
  // Empty counts as whitespace by design: callers use this to ask whether a
  // boundary carries visible content, and "nothing" carries none.
  assert.equal(core.isWhitespaceTextSelectionSegment(''), true)
  assert.equal(core.isWhitespaceTextSelectionSegment(undefined), true)
})

test('PTS-U-15 code-point probes read whole code points, not UTF-16 units', () => {
  const text = 'x𝐀'
  // '𝐀' occupies offsets 1..3. Both probes return the span they matched, so
  // callers can move a caret by a whole code point rather than by one unit.
  assert.deepEqual(core.getTextCodePointAtOffset(text, 0), { start: 0, end: 1, text: 'x' })
  assert.deepEqual(core.getTextCodePointAtOffset(text, 1), { start: 1, end: 3, text: '𝐀' })
  // Reading backwards from the end must step over the trailing surrogate and
  // land on the start of the pair, not between its two units.
  assert.deepEqual(core.getTextCodePointBeforeOffset(text, 3), { start: 1, end: 3, text: '𝐀' })
  assert.deepEqual(core.getTextCodePointBeforeOffset(text, 1), { start: 0, end: 1, text: 'x' })
  // Out-of-range probes return null rather than a partial span.
  assert.equal(core.getTextCodePointBeforeOffset(text, 0), null)
  assert.equal(core.getTextCodePointAtOffset(text, text.length), null)
})
