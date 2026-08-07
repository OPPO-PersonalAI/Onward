/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 *
 * Unit tests for `resources/pdfjs/app/highlight-core.js` — the geometry and
 * colour maths that turn a browser selection into a highlight annotation.
 *
 * Why this layer gets its own tests: this is where a transient UI gesture
 * becomes a permanent artefact. The quads produced here are written into the
 * user's PDF file and read back by every other PDF reader. A rendering bug
 * shows up as a wrong-looking box and gets fixed; a bug here writes wrong
 * geometry into documents and every later fix arrives too late for those.
 *
 * Pair with the autotest suite `run-pdf-highlight` (assertions
 * `pdf-highlight-*`), which drives real drags and checks the painted result.
 *
 * Usage: node --experimental-strip-types --test test/unittest/pdf-highlight-geometry.test.mts
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const require = createRequire(import.meta.url)
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const core = require(resolve(REPO_ROOT, 'resources/pdfjs/app/highlight-core.js'))

type Rect = { left: number; top: number; right: number; bottom: number }

// ─────────────── PHG-U-01..06 line merging ───────────────

test('PHG-U-01 rects on the same line merge into one', () => {
  // A browser hands back one client rect per text node crossed. Left as-is,
  // adjacent translucent boxes overlap at their seams and the highlight comes
  // out visibly darker there — the classic "striped highlight" artefact.
  const merged = core.mergeRectsByLine([
    { left: 10, top: 10, right: 50, bottom: 24 },
    { left: 50, top: 11, right: 90, bottom: 25 }
  ] as Rect[])
  assert.equal(merged.length, 1)
  assert.deepEqual(merged[0], { left: 10, top: 10, right: 90, bottom: 25 })
})

test('PHG-U-02 rects on different lines stay separate', () => {
  const merged = core.mergeRectsByLine([
    { left: 10, top: 10, right: 90, bottom: 24 },
    { left: 10, top: 40, right: 70, bottom: 54 }
  ] as Rect[])
  assert.equal(merged.length, 2)
})

test('PHG-U-03 a slight baseline difference still counts as one line', () => {
  // Mixed font sizes within a line (a superscript, an inline formula) shift
  // the box by a few pixels. Treating that as a new line would split one
  // visual line into two highlight rows.
  const merged = core.mergeRectsByLine([
    { left: 10, top: 10, right: 50, bottom: 24 },
    { left: 50, top: 13, right: 90, bottom: 23 }
  ] as Rect[])
  assert.equal(merged.length, 1, 'a few pixels of baseline drift is still one line')
})

test('PHG-U-04 merging is order-independent', () => {
  const forward = core.mergeRectsByLine([
    { left: 10, top: 10, right: 50, bottom: 24 },
    { left: 50, top: 10, right: 90, bottom: 24 }
  ] as Rect[])
  const reversed = core.mergeRectsByLine([
    { left: 50, top: 10, right: 90, bottom: 24 },
    { left: 10, top: 10, right: 50, bottom: 24 }
  ] as Rect[])
  assert.deepEqual(forward, reversed)
})

test('PHG-U-05 an empty input yields an empty result', () => {
  assert.deepEqual(core.mergeRectsByLine([]), [])
})

test('PHG-U-06 merging is idempotent', () => {
  // Rendering re-merges records read back from a file, which may already be
  // merged. A second pass must be a no-op, not a further collapse.
  const once = core.mergeRectsByLine([
    { left: 10, top: 10, right: 50, bottom: 24 },
    { left: 50, top: 10, right: 90, bottom: 24 },
    { left: 10, top: 40, right: 70, bottom: 54 }
  ] as Rect[])
  assert.deepEqual(core.mergeRectsByLine(once), once)
})

// ─────────────── PHG-U-07..11 rects → QuadPoints ───────────────

/** Minimal pdf.js viewport stand-in. PDF user space has its origin at the
 *  bottom-left, so the y axis is flipped relative to screen coordinates. */
const viewport = {
  scale: 1,
  height: 800,
  convertToPdfPoint(x: number, y: number) {
    return [x, 800 - y]
  },
  convertToViewportPoint(x: number, y: number) {
    return [x, 800 - y]
  }
}

test('PHG-U-07 one line produces exactly 8 numbers', () => {
  // The PDF spec defines QuadPoints as 8 numbers per quad: four corners in
  // z-order. A quad count that is not a multiple of 8 makes the annotation
  // unreadable by other viewers.
  const quads = core.rectsToQuadPoints(
    [{ left: 10, top: 10, right: 90, bottom: 24 }],
    { left: 0, top: 0 },
    viewport
  )
  assert.equal(quads.length, 8)
  assert.ok(quads.every((n: number) => Number.isFinite(n)), 'no NaN in the quads')
})

test('PHG-U-08 quad count scales with line count', () => {
  const quads = core.rectsToQuadPoints(
    [
      { left: 10, top: 10, right: 90, bottom: 24 },
      { left: 10, top: 40, right: 70, bottom: 54 }
    ],
    { left: 0, top: 0 },
    viewport
  )
  assert.equal(quads.length, 16)
  assert.equal(quads.length % 8, 0)
})

test('PHG-U-09 quads round-trip back to the rects they came from', () => {
  // The real invariant: what gets written to the file must project back onto
  // the same place on screen. This is the property that keeps a highlight
  // where the user put it after a save-and-reopen.
  const rects = [{ left: 10, top: 10, right: 90, bottom: 24 }]
  const quads = core.rectsToQuadPoints(rects, { left: 0, top: 0 }, viewport)
  const back = core.quadsToViewportRects(quads, viewport)
  assert.equal(back.length, 1)
  assert.ok(Math.abs(back[0].left - 10) < 0.01, `left drifted: ${back[0].left}`)
  assert.ok(Math.abs(back[0].top - 10) < 0.01, `top drifted: ${back[0].top}`)
  assert.ok(Math.abs(back[0].width - 80) < 0.01, `width drifted: ${back[0].width}`)
  assert.ok(Math.abs(back[0].height - 14) < 0.01, `height drifted: ${back[0].height}`)
})

test('PHG-U-10 the page origin offset is applied', () => {
  // Client rects are viewport-relative; quads must be page-relative, or every
  // highlight lands offset by wherever the page happened to be scrolled to.
  const atOrigin = core.rectsToQuadPoints(
    [{ left: 10, top: 10, right: 90, bottom: 24 }],
    { left: 0, top: 0 },
    viewport
  )
  const offset = core.rectsToQuadPoints(
    [{ left: 110, top: 60, right: 190, bottom: 74 }],
    { left: 100, top: 50 },
    viewport
  )
  assert.deepEqual(offset, atOrigin, 'the same page position must yield the same quads')
})

test('PHG-U-11 the union rect encloses every quad', () => {
  const quads = core.rectsToQuadPoints(
    [
      { left: 10, top: 10, right: 90, bottom: 24 },
      { left: 10, top: 40, right: 70, bottom: 54 }
    ],
    { left: 0, top: 0 },
    viewport
  )
  const union = core.quadsToUnionPdfRect(quads)
  assert.equal(union.length, 4, '/Rect is [x0 y0 x1 y1]')
  const [x0, y0, x1, y1] = union
  assert.ok(x1 > x0 && y1 > y0, 'the union must be normalised, not inverted')
  for (let i = 0; i + 1 < quads.length; i += 2) {
    assert.ok(quads[i] >= x0 - 0.01 && quads[i] <= x1 + 0.01, `x ${quads[i]} outside union`)
    assert.ok(quads[i + 1] >= y0 - 0.01 && quads[i + 1] <= y1 + 0.01, `y ${quads[i + 1]} outside union`)
  }
})

test('PHG-U-12 zero quads produce a degenerate but well-formed rect', () => {
  const union = core.quadsToUnionPdfRect([])
  assert.equal(union.length, 4)
  assert.ok(union.every((n: number) => Number.isFinite(n)), 'never NaN, which would corrupt the file')
})

// ─────────────── PHG-U-13..17 colour ───────────────

test('PHG-U-13 hex converts to rgba at the requested alpha', () => {
  assert.equal(core.hexToRgbaString('#f2c14e', 0.4), 'rgba(242, 193, 78, 0.4)')
  assert.equal(core.hexToRgbaString('f2c14e', 0.4), 'rgba(242, 193, 78, 0.4)', 'leading # optional')
})

test('PHG-U-14 an invalid colour falls back rather than producing NaN', () => {
  // A NaN component yields `rgba(NaN, ...)`, which CSS drops entirely — the
  // highlight would silently render as nothing.
  const result = core.hexToRgbaString('not-a-colour', 0.4)
  assert.ok(!result.includes('NaN'), `got ${result}`)
  assert.match(result, /^rgba\(\d+, \d+, \d+, 0\.4\)$/)
})

test('PHG-U-15 hex normalisation accepts only 6-digit values', () => {
  assert.equal(core.normalizeHexColor('#F2C14E'), '#f2c14e', 'case-insensitive')
  assert.equal(core.normalizeHexColor('f2c14e'), '#f2c14e')
  assert.equal(core.normalizeHexColor('#fff'), null, '3-digit shorthand is not accepted')
  assert.equal(core.normalizeHexColor('#f2c14e80'), null, '8-digit alpha form is not accepted')
  assert.equal(core.normalizeHexColor(''), null)
  assert.equal(core.normalizeHexColor(null), null)
})

test('PHG-U-16 label text colour flips for contrast', () => {
  // The note badge is filled with the label colour, so its text has to switch
  // between dark and light or it becomes unreadable on half the palette.
  assert.equal(core.getReadableTextColorForHex('#f2c14e'), '#101010', 'dark text on a light chip')
  assert.equal(core.getReadableTextColorForHex('#1a237e'), '#f7f7f7', 'light text on a dark chip')
  assert.equal(core.getReadableTextColorForHex('#ffffff'), '#101010')
  assert.equal(core.getReadableTextColorForHex('#000000'), '#f7f7f7')
})

test('PHG-U-17 unit RGB components stay in 0..1', () => {
  // pdf-lib writes /C as three unit components; anything outside 0..1 makes a
  // malformed annotation.
  for (const hex of ['#000000', '#ffffff', '#f2c14e', '#5aa9e6']) {
    for (const component of core.hexToUnitRgb(hex)) {
      assert.ok(component >= 0 && component <= 1, `${hex} produced ${component}`)
    }
  }
})

// ─────────────── PHG-U-18..20 note popup sizing ───────────────

test('PHG-U-18 popup width is clamped to the CSS bounds', () => {
  assert.equal(core.normalizeNotePopupWidth(400), 400)
  assert.equal(core.normalizeNotePopupWidth(10), 260, 'below the minimum')
  assert.equal(core.normalizeNotePopupWidth(9999), 520, 'above the maximum')
  assert.equal(core.normalizeNotePopupWidth('abc'), core.NOTE_POPUP_WIDTH_DEFAULT)
  assert.equal(core.normalizeNotePopupWidth(undefined), core.NOTE_POPUP_WIDTH_DEFAULT)
})

test('PHG-U-19 popup height treats 0 as "auto"', () => {
  // 0 means the user has never resized it, so the content decides. Clamping it
  // up to the minimum would force a tall empty box on first open.
  assert.equal(core.normalizeNotePopupHeight(0), core.NOTE_POPUP_HEIGHT_DEFAULT)
  assert.equal(core.normalizeNotePopupHeight(-5), core.NOTE_POPUP_HEIGHT_DEFAULT)
  assert.equal(core.normalizeNotePopupHeight(300), 300)
  assert.equal(core.normalizeNotePopupHeight(9999), 620)
  assert.equal(core.normalizeNotePopupHeight(50), 220, 'below the minimum')
})

test('PHG-U-20 clamp is inclusive at both ends', () => {
  assert.equal(core.clamp(5, 1, 10), 5)
  assert.equal(core.clamp(0, 1, 10), 1)
  assert.equal(core.clamp(99, 1, 10), 10)
  assert.equal(core.clamp(1, 1, 10), 1)
  assert.equal(core.clamp(10, 1, 10), 10)
})
