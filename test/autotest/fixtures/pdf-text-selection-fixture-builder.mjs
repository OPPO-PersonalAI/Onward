#!/usr/bin/env node
/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 *
 * Builds the deterministic PDF fixture for the text-selection autotest.
 *
 * Why hand-rolled PDF bytes rather than a library: the test asserts on exact
 * text-layer geometry, so the fixture has to place known strings at known
 * coordinates with a known font. A generator that reflows or subsets would
 * make the assertions drift with its version. These bytes are stable forever.
 *
 * The fixture is a single 612x400 page carrying four things the engine has to
 * get right, each isolated on its own line so a failure names itself:
 *
 *   y=340  "The office of efficient design"   ligature handling (ffi twice)
 *   y=300  "SELECTME uniqueword ENDMARK"      plain word / multi-word drag
 *   y=260  "Second line continues here"       multi-line drag target
 *   y=200  "HIDDENTEXT" (Tr 3) under          hidden-text suppression: the
 *          "VISIBLETEXT" at the same spot     invisible span must be dropped
 *   y=140  "BLOCKEDTEXT" under a FreeText     blocking-annotation suppression
 *          annotation with an appearance
 *
 * Usage:
 *   node test/autotest/fixtures/pdf-text-selection-fixture-builder.mjs --write
 *   node test/autotest/fixtures/pdf-text-selection-fixture-builder.mjs --check
 */

import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const OUT_DIR = join(dirname(fileURLToPath(import.meta.url)), 'pdf-text-selection')
const OUT_FILE = join(OUT_DIR, 'onward-textsel.pdf')

/** Text drawn by the fixture, exported so the autotest asserts against the
 *  same literals the builder wrote rather than a hand-copied duplicate. */
export const FIXTURE_TEXT = {
  ligatureLine: 'The office of efficient design',
  selectLine: 'SELECTME uniqueword ENDMARK',
  secondLine: 'Second line continues here',
  visibleOverHidden: 'VISIBLETEXT',
  hiddenUnderVisible: 'HIDDENTEXT',
  blockedByAnnotation: 'BLOCKEDTEXT'
}

const PAGE_WIDTH = 612
const PAGE_HEIGHT = 400

function contentStream() {
  const t = FIXTURE_TEXT
  return [
    'BT /F1 18 Tf 40 340 Td (' + t.ligatureLine + ') Tj ET',
    'BT /F1 18 Tf 40 300 Td (' + t.selectLine + ') Tj ET',
    'BT /F1 18 Tf 40 260 Td (' + t.secondLine + ') Tj ET',
    // Tr 3 = "neither fill nor stroke", i.e. the glyphs contribute to the text
    // layer but paint nothing. This is exactly how a scanned page's OCR layer
    // is encoded, and how a watermark trick hides text under visible text.
    // It is drawn FIRST so the visible line lands on top of it.
    'BT 3 Tr /F1 18 Tf 40 200 Td (' + t.hiddenUnderVisible + ') Tj ET',
    'BT 0 Tr /F1 18 Tf 40 200 Td (' + t.visibleOverHidden + ') Tj ET',
    // Plain visible text that a blocking annotation will cover.
    'BT /F1 18 Tf 40 140 Td (' + t.blockedByAnnotation + ') Tj ET'
  ].join('\n')
}

// A FreeText annotation with its own appearance stream, sized to cover the
// BLOCKEDTEXT line. `hasAppearance` is what makes the engine classify it as
// blocking, so the appearance stream is load-bearing, not decoration.
const ANNOT_RECT = [36, 132, 200, 162]

function buildPdf() {
  const chunks = []
  const offsets = []
  let cursor = 0
  const write = (value) => {
    const chunk = Buffer.from(value, 'binary')
    chunks.push(chunk)
    cursor += chunk.length
  }
  const obj = (body) => {
    offsets.push(cursor)
    write(body)
  }

  write('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n')

  obj('1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n')
  obj('2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n')

  const content = contentStream()
  obj(
    '3 0 obj\n<< /Type /Page /Parent 2 0 R ' +
      `/MediaBox [0 0 ${PAGE_WIDTH} ${PAGE_HEIGHT}] ` +
      '/Contents 4 0 R /Annots [6 0 R] ' +
      '/Resources << /Font << /F1 5 0 R >> >> >>\nendobj\n'
  )
  obj(`4 0 obj\n<< /Length ${content.length} >>\nstream\n${content}\nendstream\nendobj\n`)
  obj('5 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n')

  const apStream = '0.9 0.9 0.2 rg 0 0 164 30 re f'
  obj(
    '6 0 obj\n<< /Type /Annot /Subtype /FreeText ' +
      `/Rect [${ANNOT_RECT.join(' ')}] /F 4 /Contents (blocker) ` +
      '/DA (/F1 12 Tf 0 g) /AP << /N 7 0 R >> >>\nendobj\n'
  )
  obj(
    `7 0 obj\n<< /Type /XObject /Subtype /Form /BBox [0 0 164 30] /Length ${apStream.length} >>\n` +
      `stream\n${apStream}\nendstream\nendobj\n`
  )

  const xrefStart = cursor
  const pad = (value) => String(value).padStart(10, '0')
  let xref = `xref\n0 ${offsets.length + 1}\n0000000000 65535 f \n`
  for (const offset of offsets) xref += `${pad(offset)} 00000 n \n`
  write(xref)
  write(`trailer\n<< /Size ${offsets.length + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`)

  return Buffer.concat(chunks)
}

function main() {
  const bytes = buildPdf()
  const mode = process.argv.includes('--check') ? 'check' : 'write'

  if (mode === 'check') {
    if (!existsSync(OUT_FILE)) {
      console.error(`missing fixture: ${OUT_FILE}`)
      process.exit(1)
    }
    const onDisk = readFileSync(OUT_FILE)
    if (!onDisk.equals(bytes)) {
      console.error('fixture on disk differs from the builder output.')
      console.error('Regenerate with: node test/autotest/fixtures/pdf-text-selection-fixture-builder.mjs --write')
      process.exit(1)
    }
    console.log(`fixture matches builder output (${bytes.length} bytes)`)
    return
  }

  mkdirSync(OUT_DIR, { recursive: true })
  writeFileSync(OUT_FILE, bytes)
  console.log(`wrote ${OUT_FILE} (${bytes.length} bytes)`)
}

if (process.argv[1] && process.argv[1].endsWith('pdf-text-selection-fixture-builder.mjs')) {
  main()
}
