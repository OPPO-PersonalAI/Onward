#!/usr/bin/env node
/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 *
 * Builds the deterministic annotated-PDF pair for the Git Diff annotation
 * panel autotest (run-pdf-epub-diff, annotation-diff assertions).
 *
 * Hand-rolled bytes like the sibling builders: a library would make the
 * fixture drift with its version, and byte-stable fixtures are what let the
 * runner's --check verify freshness in milliseconds.
 *
 * Both PDFs carry the SAME three pages of text — the two versions differ in
 * ANNOTATIONS ONLY, which is exactly the agent-annotated-my-paper scenario
 * the panel exists for.
 *
 * Layout is load-bearing for falsifiability: page 1 holds the one UNCHANGED
 * annotation and every DIFFERENCE lives on page 3. A viewer that does not
 * auto-jump sits on page 1, so "the comparison opened on the first
 * difference" is only provable when the differences are somewhere page 1 is
 * not. An earlier revision put the changed record on page 1 and the
 * assertion could not fail.
 *
 *   annotated-base.pdf       A-keep p1 · A-edit p3 (note/color v1) · A-drop p3
 *   annotated-modified.pdf   A-keep p1 · A-edit p3 (note/color v2) · A-fresh p3
 *
 *   → diff: added 1 (fresh, p3) · removed 1 (drop, p3) · changed 1 (edit,
 *     fields color+note) · unchanged 1 (keep, p1)
 *
 * Annotation encoding mirrors resources/pdfjs/app/annotation-file.js:
 * /Highlight dicts carrying the private /CYY_MARK marker and a
 * /CYY_MARK_Data payload (UTF-16BE hex string) holding the record JSON. The
 * viewer's readAnnotationStateFromPdf needs nothing else — the document-level
 * manifest is a recovery channel, not a requirement.
 *
 * Usage:
 *   node test/autotest/fixtures/pdf-annotation-diff-fixture-builder.mjs --write
 *   node test/autotest/fixtures/pdf-annotation-diff-fixture-builder.mjs --check
 */

import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const OUT_DIR = join(dirname(fileURLToPath(import.meta.url)), 'pdf-annotation-diff')

const ANNOT_APP_ID = 'DarkPDFReader'
const HIGHLIGHT_FILL_OPACITY = 0.4

const PAGE_WIDTH = 612
const PAGE_HEIGHT = 500
const PAGE_COUNT = 3

/** Fixed timestamps keep the bytes stable AND give the panel a deterministic
 *  reading order (sorted by page, then createdAt). */
const T0 = 1753900000000

/** Same text on every version; the versions differ in annotations only. */
const PAGE_LINES = [
  [
    { y: 440, text: 'KEEPME this line stays highlighted unchanged' }
  ],
  [
    { y: 440, text: 'Filler page so the differences sit well off-screen' }
  ],
  [
    { y: 440, text: 'EDITME this line has its note and color edited' },
    { y: 400, text: 'DROPME this highlight vanishes in the new version' },
    { y: 360, text: 'FRESHME this highlight only exists in the new version' }
  ]
]

function record(id, page, line, overrides = {}) {
  const x0 = 40
  const x1 = 40 + line.text.length * 7.8
  const y0 = line.y - 4
  const y1 = line.y + 16
  return {
    id,
    labelId: 'hl-key',
    labelName: 'Key claim',
    color: '#f2c14e',
    page,
    note: '',
    textSnapshot: line.text,
    quads: [x0, y1, x1, y1, x0, y0, x1, y0],
    rectUnion: [x0, y0, x1, y1],
    paletteAnchor: null,
    createdAt: T0 + page * 1000,
    updatedAt: T0 + page * 1000,
    ...overrides
  }
}

/** The records, versioned. Exported so the autotest asserts against the same
 *  literals the builder wrote. */
export const FIXTURE_ANNOTATIONS = {
  base: [
    record('anndiff-keep', 1, PAGE_LINES[0][0]),
    record('anndiff-edit', 3, PAGE_LINES[2][0], { note: 'first thoughts', color: '#f2c14e' }),
    record('anndiff-drop', 3, PAGE_LINES[2][1], { createdAt: T0 + 4000, updatedAt: T0 + 4000 })
  ],
  modified: [
    record('anndiff-keep', 1, PAGE_LINES[0][0]),
    record('anndiff-edit', 3, PAGE_LINES[2][0], {
      note: 'revised thoughts',
      color: '#5aa9e6',
      updatedAt: T0 + 9000
    }),
    record('anndiff-fresh', 3, PAGE_LINES[2][2], { createdAt: T0 + 8000, updatedAt: T0 + 8000 })
  ]
}

/** UTF-16BE with BOM, hex-encoded — the exact shape PDFHexString.fromText
 *  writes, which is what the reader's decodeText expects. */
function utf16beHex(text) {
  let hex = 'FEFF'
  for (const char of String(text)) {
    const code = char.codePointAt(0)
    if (code > 0xffff) {
      const high = Math.floor((code - 0x10000) / 0x400) + 0xd800
      const low = ((code - 0x10000) % 0x400) + 0xdc00
      hex += high.toString(16).padStart(4, '0') + low.toString(16).padStart(4, '0')
    } else {
      hex += code.toString(16).padStart(4, '0')
    }
  }
  return hex.toUpperCase()
}

function hexToUnitRgb(hex) {
  const value = hex.replace('#', '')
  const r = parseInt(value.slice(0, 2), 16) / 255
  const g = parseInt(value.slice(2, 4), 16) / 255
  const b = parseInt(value.slice(4, 6), 16) / 255
  const f = (n) => Number(n.toFixed(4))
  return [f(r), f(g), f(b)]
}

function annotDict(objNumber, annot) {
  const [r, g, b] = hexToUnitRgb(annot.color)
  return (
    `${objNumber} 0 obj\n<< /Type /Annot /Subtype /Highlight ` +
    `/Rect [${annot.rectUnion.join(' ')}] ` +
    `/QuadPoints [${annot.quads.join(' ')}] ` +
    `/C [${r} ${g} ${b}] /CA ${HIGHLIGHT_FILL_OPACITY} /F 4 ` +
    `/T (${ANNOT_APP_ID}) /NM (${annot.id}) ` +
    `/Contents <${utf16beHex(annot.note)}> ` +
    `/CYY_MARK <${utf16beHex(ANNOT_APP_ID)}> ` +
    `/CYY_MARK_Label <${utf16beHex(annot.labelName)}> ` +
    `/CYY_MARK_Id <${utf16beHex(annot.id)}> ` +
    `/CYY_MARK_Data <${utf16beHex(JSON.stringify(annot))}> ` +
    `>>\nendobj\n`
  )
}

function buildPdf(annotations) {
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

  // Object layout: 1 catalog · 2 pages · 3..5 page objects · 6..8 content
  // streams · 9 font · 10.. annotation dicts (grouped by page order).
  const pageObj = (index) => 3 + index
  const contentObj = (index) => 3 + PAGE_COUNT + index
  const fontObj = 3 + PAGE_COUNT * 2
  let nextAnnotObj = fontObj + 1
  const annotObjByPage = new Map()
  for (let page = 1; page <= PAGE_COUNT; page += 1) {
    const pageAnnots = annotations.filter((a) => a.page === page)
    const refs = pageAnnots.map(() => `${nextAnnotObj++} 0 R`)
    annotObjByPage.set(page, { annots: pageAnnots, refs })
  }

  obj('1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n')
  const kids = Array.from({ length: PAGE_COUNT }, (_, i) => `${pageObj(i)} 0 R`).join(' ')
  obj(`2 0 obj\n<< /Type /Pages /Kids [${kids}] /Count ${PAGE_COUNT} >>\nendobj\n`)

  for (let i = 0; i < PAGE_COUNT; i += 1) {
    const { refs } = annotObjByPage.get(i + 1)
    const annotsEntry = refs.length ? `/Annots [${refs.join(' ')}] ` : ''
    obj(
      `${pageObj(i)} 0 obj\n<< /Type /Page /Parent 2 0 R ` +
        `/MediaBox [0 0 ${PAGE_WIDTH} ${PAGE_HEIGHT}] ` +
        `/Contents ${contentObj(i)} 0 R ${annotsEntry}` +
        `/Resources << /Font << /F1 ${fontObj} 0 R >> >> >>\nendobj\n`
    )
  }

  for (let i = 0; i < PAGE_COUNT; i += 1) {
    const content = PAGE_LINES[i]
      .map((line) => `BT /F1 16 Tf 40 ${line.y} Td (${line.text}) Tj ET`)
      .join('\n')
    obj(`${contentObj(i)} 0 obj\n<< /Length ${content.length} >>\nstream\n${content}\nendstream\nendobj\n`)
  }

  obj(`${fontObj} 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n`)

  let annotObjNumber = fontObj + 1
  for (let page = 1; page <= PAGE_COUNT; page += 1) {
    for (const annot of annotObjByPage.get(page).annots) {
      obj(annotDict(annotObjNumber++, annot))
    }
  }

  const xrefStart = cursor
  const pad = (value) => String(value).padStart(10, '0')
  let xref = `xref\n0 ${offsets.length + 1}\n0000000000 65535 f \n`
  for (const offset of offsets) xref += `${pad(offset)} 00000 n \n`
  write(xref)
  write(`trailer\n<< /Size ${offsets.length + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`)

  return Buffer.concat(chunks)
}

const OUTPUTS = [
  { file: 'annotated-base.pdf', annotations: FIXTURE_ANNOTATIONS.base },
  { file: 'annotated-modified.pdf', annotations: FIXTURE_ANNOTATIONS.modified }
]

function main() {
  const mode = process.argv.includes('--check') ? 'check' : 'write'

  for (const output of OUTPUTS) {
    const bytes = buildPdf(output.annotations)
    const target = join(OUT_DIR, output.file)
    if (mode === 'check') {
      if (!existsSync(target)) {
        console.error(`missing fixture: ${target}`)
        process.exit(1)
      }
      if (!readFileSync(target).equals(bytes)) {
        console.error(`fixture on disk differs from the builder output: ${output.file}`)
        console.error('Regenerate with: node test/autotest/fixtures/pdf-annotation-diff-fixture-builder.mjs --write')
        process.exit(1)
      }
      console.log(`fixture matches builder output: ${output.file} (${bytes.length} bytes)`)
      continue
    }
    mkdirSync(OUT_DIR, { recursive: true })
    writeFileSync(target, bytes)
    console.log(`wrote ${target} (${bytes.length} bytes)`)
  }
}

if (process.argv[1] && process.argv[1].endsWith('pdf-annotation-diff-fixture-builder.mjs')) {
  main()
}
