/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 *
 * Unit tests for the annotation-classification and rect-geometry decisions in
 * `resources/pdfjs/app/text-selection-core.js`.
 *
 * What this pins down: which PDF annotations block text selection and which
 * let it through. Both directions are correctness-critical, and they fail in
 * opposite ways:
 *
 *   - Classify a blocker as passthrough → the user drags across a form field
 *     or a stamp and selects the PDF text hidden *underneath* it. They cannot
 *     see that text, but it lands in their clipboard. That is an information
 *     leak, and the 2026 reference-project adversarial notes record it as a
 *     real reproduced defect (FreeText, Text note, Stamp, FileAttachment).
 *   - Classify a passthrough as a blocker → highlighted or underlined text
 *     becomes unselectable, which is exactly the text a reader most wants.
 *
 * Pair with the autotest suite `run-pdf-text-selection` (assertions
 * `pdf-textsel-*`), which drives real drags over real annotations.
 *
 * Usage: node --experimental-strip-types --test test/unittest/pdf-text-selection-annotation-role.test.mts
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const require = createRequire(import.meta.url)
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const core = require(resolve(REPO_ROOT, 'resources/pdfjs/app/text-selection-core.js'))

/**
 * Minimal stand-in for a pdf.js annotation `<section>`. The core module only
 * ever duck-types these (`matches` / `querySelector` / `querySelectorAll`), so
 * a plain object is enough — no jsdom, no Electron.
 */
function fakeSection(options: {
  classes?: string[]
  canvas?: boolean
  svgPaints?: Array<{ stroke?: string; strokeOpacity?: string; fill?: string; fillOpacity?: string }>
}) {
  const classes = options.classes ?? []
  const paints = options.svgPaints ?? []
  return {
    matches(selector: string) {
      // pdf.js selectors here are always comma-separated class lists.
      return selector
        .split(',')
        .map((part) => part.trim().replace(/^\./, ''))
        .some((cls) => classes.includes(cls))
    },
    querySelector(selector: string) {
      return selector === 'canvas' && options.canvas ? {} : null
    },
    querySelectorAll() {
      return paints.map((paint) => ({
        getAttribute(name: string) {
          if (name === 'stroke') return paint.stroke ?? null
          if (name === 'stroke-opacity') return paint.strokeOpacity ?? null
          if (name === 'fill') return paint.fill ?? null
          if (name === 'fill-opacity') return paint.fillOpacity ?? null
          return null
        }
      }))
    }
  }
}

// ─────────────── PTA-U-01..03 redactions ───────────────

test('PTA-U-01 a redaction blocks selection whichever way it is spelled', () => {
  // Redactions exist to hide text. If the text layer still carries what was
  // redacted, letting it be selected defeats the entire annotation.
  assert.equal(core.isRedactAnnotationData({ subtype: 'Redact' }), true)
  assert.equal(core.isRedactAnnotationData({ subtype: 'redact' }), true, 'case-insensitive')
  assert.equal(core.isRedactAnnotationData({ annotationType: 26 }), true, 'numeric AnnotationType')
  assert.equal(core.isRedactAnnotationData({ subtype: 'Highlight' }), false)
  assert.equal(core.isRedactAnnotationData(null), false)
  assert.equal(core.isRedactAnnotationData(undefined), false)
})

test('PTA-U-02 redaction wins over any section class', () => {
  // Checked first on purpose: a redaction rendered with a highlight-ish
  // section must not fall through to the passthrough branch.
  const section = fakeSection({ classes: ['highlightAnnotation'] })
  assert.equal(core.getTextSelectionAnnotationRole({ subtype: 'Redact' }, section), 'blocking')
})

test('PTA-U-03 redaction blocks even with no DOM section at all', () => {
  assert.equal(core.getTextSelectionAnnotationRole({ subtype: 'Redact' }, null), 'blocking')
})

// ─────────────── PTA-U-04..06 text-markup passthrough ───────────────

test('PTA-U-04 text-markup annotations let selection through', () => {
  // These are drawn *over* text that is meant to stay readable and selectable
  // — including the highlights this very feature creates.
  for (const cls of [
    'highlightAnnotation',
    'underlineAnnotation',
    'squigglyAnnotation',
    'strikeoutAnnotation'
  ]) {
    const section = fakeSection({ classes: [cls] })
    assert.equal(
      core.getTextSelectionAnnotationRole({ hasAppearance: true }, section),
      'passthrough',
      `${cls} must be passthrough`
    )
  }
})

test('PTA-U-05 passthrough holds even when the annotation has its own appearance', () => {
  // Deliberate ordering: `hasAppearance` normally means "blocking", but a
  // highlight with a baked appearance stream is still just a highlight.
  const section = fakeSection({ classes: ['highlightAnnotation'] })
  assert.equal(
    core.getTextSelectionAnnotationRole({ hasAppearance: true, hasOwnCanvas: true }, section),
    'passthrough'
  )
})

// ─────────────── PTA-U-06..09 shape annotations ───────────────

test('PTA-U-06 a transparent shape lets selection through', () => {
  // A square/circle drawn with no fill and no stroke is an invisible box. It
  // frequently sits over body text as a layout artefact; blocking there would
  // make random paragraphs unselectable for no visible reason.
  const section = fakeSection({
    classes: ['squareAnnotation'],
    svgPaints: [{ stroke: 'none', fill: 'none' }]
  })
  assert.equal(core.getTextSelectionAnnotationRole({}, section), 'passthrough')
})

test('PTA-U-07 an opaque shape blocks selection', () => {
  const section = fakeSection({
    classes: ['squareAnnotation'],
    svgPaints: [{ stroke: '#000000', fill: '#ffffff' }]
  })
  assert.equal(core.getTextSelectionAnnotationRole({}, section), 'default')
  // …and one with a real appearance stream blocks outright.
  assert.equal(core.getTextSelectionAnnotationRole({ hasAppearance: true }, section), 'blocking')
})

test('PTA-U-08 a shape backed by a canvas is never treated as transparent', () => {
  // A canvas means pdf.js rasterised something we cannot inspect, so the
  // conservative answer is "assume it covers the text".
  const section = fakeSection({
    classes: ['squareAnnotation'],
    canvas: true,
    svgPaints: [{ stroke: 'none', fill: 'none' }]
  })
  assert.equal(core.annotationSectionHasOnlyTransparentSvgPaint(section), false)
})

test('PTA-U-09 transparency detection covers every "invisible" spelling', () => {
  assert.equal(core.isTransparentSvgPaint('none', null), true)
  assert.equal(core.isTransparentSvgPaint('transparent', null), true)
  assert.equal(core.isTransparentSvgPaint('rgba(0, 0, 0, 0)', null), true)
  assert.equal(core.isTransparentSvgPaint('', null), true, 'absent paint')
  assert.equal(core.isTransparentSvgPaint('#ff0000', '0'), true, 'opaque colour, zero opacity')
  assert.equal(core.isTransparentSvgPaint('#ff0000', '0.0'), true)
  assert.equal(core.isTransparentSvgPaint('#ff0000', '1'), false)
  assert.equal(core.isTransparentSvgPaint('#ff0000', null), false)
})

test('PTA-U-10 a shape with no painted elements at all is not "transparent"', () => {
  // Nothing to inspect means no evidence of transparency; falling through to
  // passthrough here would be a guess, and the guess that leaks text.
  const section = fakeSection({ classes: ['circleAnnotation'], svgPaints: [] })
  assert.equal(core.annotationSectionHasOnlyTransparentSvgPaint(section), false)
})

// ─────────────── PTA-U-11..13 widgets and defaults ───────────────

test('PTA-U-11 anything with an appearance stream blocks by default', () => {
  // Form widgets, stamps, file attachments and text notes all land here. Each
  // one was a reproduced text-leak in the reference project before this rule.
  const section = fakeSection({ classes: ['textWidgetAnnotation'] })
  assert.equal(core.getTextSelectionAnnotationRole({ hasAppearance: true }, section), 'blocking')
  assert.equal(core.getTextSelectionAnnotationRole({ hasOwnCanvas: true }, section), 'blocking')
})

test('PTA-U-12 an unremarkable annotation with a section is "default"', () => {
  const section = fakeSection({ classes: ['linkAnnotation'] })
  assert.equal(core.getTextSelectionAnnotationRole({}, section), 'default')
})

test('PTA-U-13 no section and nothing special is "none"', () => {
  assert.equal(core.getTextSelectionAnnotationRole({}, null), 'none')
})

// ─────────────── PTA-U-14..17 rect geometry ───────────────

test('PTA-U-14 axis overlap is clamped at zero for disjoint spans', () => {
  assert.equal(core.getRectAxisOverlap(0, 10, 5, 20), 5)
  assert.equal(core.getRectAxisOverlap(0, 10, 10, 20), 0, 'touching but not overlapping')
  assert.equal(core.getRectAxisOverlap(0, 10, 20, 30), 0, 'disjoint never goes negative')
  assert.equal(core.getRectAxisOverlap(0, 10, 2, 4), 2, 'fully contained')
})

test('PTA-U-15 hidden text sitting under visible text is detected as covered', () => {
  // The canonical case: a scanned page with an OCR layer positioned right on
  // top of the rendered words. Those spans must be dropped, or a selection
  // picks up the OCR text instead of what the user sees.
  const visible = { left: 100, right: 200, top: 50, bottom: 62, width: 100, height: 12 }
  const invisible = { left: 101, right: 199, top: 51, bottom: 61, width: 98, height: 10 }
  assert.equal(core.isInvisibleTextRectCoveredByVisibleText(invisible, visible), true)
})

test('PTA-U-16 OCR-only text is NOT treated as covered', () => {
  // Inverse of PTA-U-15 and equally important: on a page with no rendered text
  // layer, the invisible OCR text *is* the text. Dropping it would make a
  // scanned document completely unselectable.
  const visible = { left: 100, right: 200, top: 50, bottom: 62, width: 100, height: 12 }
  const farAway = { left: 100, right: 200, top: 400, bottom: 412, width: 100, height: 12 }
  assert.equal(core.isInvisibleTextRectCoveredByVisibleText(farAway, visible), false)
})

test('PTA-U-17 grazing overlap does not count as coverage', () => {
  // A hidden span that merely clips the corner of a visible one is not hidden
  // *by* it. The thresholds (60% vertical, 50% horizontal, 35% area) exist to
  // separate "underneath" from "adjacent".
  const visible = { left: 100, right: 200, top: 50, bottom: 62, width: 100, height: 12 }
  const grazing = { left: 195, right: 295, top: 60, bottom: 72, width: 100, height: 12 }
  assert.equal(core.isInvisibleTextRectCoveredByVisibleText(grazing, visible), false)
})

test('PTA-U-18 zero-area rects can never cover anything', () => {
  const visible = { left: 100, right: 200, top: 50, bottom: 62, width: 100, height: 12 }
  const empty = { left: 100, right: 100, top: 50, bottom: 50, width: 0, height: 0 }
  assert.equal(core.isInvisibleTextRectCoveredByVisibleText(empty, visible), false)
  assert.equal(core.isInvisibleTextRectCoveredByVisibleText(visible, empty), false)
})

// ─────────────── PTA-U-19..21 PDF rect → viewport rect ───────────────

/** Stand-in for a pdf.js viewport: PDF space has its origin bottom-left, so
 *  the y axis comes back flipped and the corners arrive unordered. */
const fakeViewport = {
  convertToViewportRectangle([x0, y0, x1, y1]: number[]) {
    return [x0, 100 - y0, x1, 100 - y1]
  }
}

test('PTA-U-19 corners are normalised regardless of input ordering', () => {
  // The flip above hands back top/bottom swapped; the function must sort them,
  // or every blocking annotation would have a negative height and hit-test
  // as empty.
  const rect = core.annotationRectToPageRect([10, 20, 30, 40], fakeViewport)
  assert.deepEqual(rect, { left: 10, right: 30, top: 60, bottom: 80 })
})

test('PTA-U-20 degenerate rects are rejected rather than returned empty', () => {
  assert.equal(core.annotationRectToPageRect([10, 20, 10, 20], fakeViewport), null, 'zero area')
  assert.equal(core.annotationRectToPageRect([10, 20], fakeViewport), null, 'too few numbers')
  assert.equal(core.annotationRectToPageRect(null, fakeViewport), null)
  assert.equal(core.annotationRectToPageRect([10, 20, 30, 40], null), null, 'no viewport')
  assert.equal(core.annotationRectToPageRect([10, 20, 30, 40], {}), null, 'viewport without converter')
})

// ─────────────── PTA-U-21 clipboard normalisation ───────────────

test('PTA-U-21 copied text keeps its leading newlines unless a prefix mark follows', () => {
  // pdf.js can emit a combining mark as its own leading text node, which shows
  // up as a spurious blank first line. Stripping it is right there, and wrong
  // everywhere else — a genuine leading blank line must survive.
  assert.equal(core.normalizeTextLayerCopiedText('\nword'), '\nword', 'ordinary text keeps the break')
  assert.equal(core.normalizeTextLayerCopiedText('\ńword'), '́word', 'prefix mark: break dropped')
  assert.equal(core.normalizeTextLayerCopiedText('plain'), 'plain')
  assert.equal(core.normalizeTextLayerCopiedText(''), '')
})
