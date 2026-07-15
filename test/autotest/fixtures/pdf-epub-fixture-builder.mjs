#!/usr/bin/env node
/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 *
 * Build deterministic PDF and EPUB fixtures for the PDF/EPUB preview autotest.
 *
 * Outputs base64 strings on stdout:
 *   PDF_BASE64=<base64>
 *   EPUB_BASE64=<base64>
 *
 * The base PDF contains one 300x200 page; the alternate PDF contains two pages
 * so navigation tests can verify page-number restoration as well as scrolling.
 * The EPUB is a minimal EPUB 3 with two chapters referencing the text
 * "Onward Autotest EPUB chapter N."
 */

import { deflateRawSync } from 'node:zlib'
import { createHash } from 'node:crypto'
import { writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

// ---------- PDF ----------

function encodePdf(variant = 'base') {
  if (variant === 'outline') {
    return encodePdfWithOutline('BT /F1 18 Tf 30 100 Td (Onward Autotest Outlined PDF) Tj ET')
  }
  if (variant === 'navigation') {
    return encodePdfWithTwoPages(
      'BT /F1 18 Tf 30 100 Td (Onward Autotest PDF v2) Tj ET',
      'BT /F1 18 Tf 30 100 Td (Onward Autotest PDF v2 page 2) Tj ET'
    )
  }
  const streamText = variant === 'alt'
    ? 'BT /F1 18 Tf 30 100 Td (Onward Autotest PDF v2) Tj ET'
    : 'BT /F1 18 Tf 30 100 Td (Onward Autotest PDF) Tj ET'
  return encodePdfWith(streamText)
}

function encodePdfWithTwoPages(firstStream, secondStream) {
  const chunks = []
  const offsets = []
  let cursor = 0
  const write = (chunk) => { chunks.push(chunk); cursor += chunk.length }
  const writeString = (value) => write(Buffer.from(value, 'binary'))
  const recordObject = () => offsets.push(cursor)

  writeString('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n')

  recordObject()
  writeString('1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n')

  recordObject()
  writeString('2 0 obj\n<< /Type /Pages /Kids [3 0 R 6 0 R] /Count 2 >>\nendobj\n')

  recordObject()
  writeString(
    '3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>\nendobj\n'
  )

  recordObject()
  writeString(`4 0 obj\n<< /Length ${firstStream.length} >>\nstream\n${firstStream}\nendstream\nendobj\n`)

  recordObject()
  writeString('5 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n')

  recordObject()
  writeString(
    '6 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Contents 7 0 R /Resources << /Font << /F1 5 0 R >> >> >>\nendobj\n'
  )

  recordObject()
  writeString(`7 0 obj\n<< /Length ${secondStream.length} >>\nstream\n${secondStream}\nendstream\nendobj\n`)

  const xrefStart = cursor
  const pad = (value) => String(value).padStart(10, '0')
  let xref = 'xref\n0 8\n0000000000 65535 f \n'
  for (const offset of offsets) xref += `${pad(offset)} 00000 n \n`
  writeString(xref)
  writeString(`trailer\n<< /Size 8 /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`)
  return Buffer.concat(chunks)
}

// Emits a PDF with a single-entry outline ("Autotest Chapter" pointing to the
// only page). Used by the "auto-open outline" autotest. The extra objects add
// about 200 bytes and only touch the catalog / outlines tree.
function encodePdfWithOutline(streamText) {
  const chunks = []
  const offsets = []
  let cursor = 0
  const write = (chunk) => { chunks.push(chunk); cursor += chunk.length }
  const writeString = (s) => write(Buffer.from(s, 'binary'))
  const recordObject = () => offsets.push(cursor)

  writeString('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n')

  recordObject()
  writeString('1 0 obj\n<< /Type /Catalog /Pages 2 0 R /Outlines 6 0 R >>\nendobj\n')

  recordObject()
  writeString('2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n')

  recordObject()
  writeString(
    '3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>\nendobj\n'
  )

  recordObject()
  writeString(`4 0 obj\n<< /Length ${streamText.length} >>\nstream\n${streamText}\nendstream\nendobj\n`)

  recordObject()
  writeString('5 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n')

  recordObject()
  writeString('6 0 obj\n<< /Type /Outlines /First 7 0 R /Last 7 0 R /Count 1 >>\nendobj\n')

  recordObject()
  writeString('7 0 obj\n<< /Title (Autotest Chapter) /Parent 6 0 R /Dest [3 0 R /Fit] >>\nendobj\n')

  const xrefStart = cursor
  const pad = (n) => String(n).padStart(10, '0')
  let xref = 'xref\n0 8\n0000000000 65535 f \n'
  for (const offset of offsets) xref += `${pad(offset)} 00000 n \n`
  writeString(xref)
  writeString(`trailer\n<< /Size 8 /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`)
  return Buffer.concat(chunks)
}

function encodePdfWith(streamText) {
  const chunks = []
  const offsets = []
  let cursor = 0
  const write = (chunk) => {
    chunks.push(chunk)
    cursor += chunk.length
  }
  const writeString = (s) => write(Buffer.from(s, 'binary'))
  const recordObject = () => offsets.push(cursor)

  writeString('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n')

  recordObject()
  writeString('1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n')

  recordObject()
  writeString('2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n')

  recordObject()
  writeString(
    '3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>\nendobj\n'
  )

  const stream = streamText
  recordObject()
  writeString(`4 0 obj\n<< /Length ${stream.length} >>\nstream\n${stream}\nendstream\nendobj\n`)

  recordObject()
  writeString('5 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n')

  const xrefStart = cursor
  const pad = (n) => String(n).padStart(10, '0')
  let xref = 'xref\n0 6\n0000000000 65535 f \n'
  for (const offset of offsets) {
    xref += `${pad(offset)} 00000 n \n`
  }
  writeString(xref)

  writeString(`trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`)

  return Buffer.concat(chunks)
}

// ---------- EPUB (valid EPUB 3 inside a ZIP) ----------

function crc32(buf) {
  const table = crc32.table || (crc32.table = (() => {
    const t = new Uint32Array(256)
    for (let i = 0; i < 256; i++) {
      let c = i
      for (let j = 0; j < 8; j++) {
        c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
      }
      t[i] = c >>> 0
    }
    return t
  })())
  let crc = 0xffffffff
  for (const byte of buf) {
    crc = (crc >>> 8) ^ table[(crc ^ byte) & 0xff]
  }
  return (crc ^ 0xffffffff) >>> 0
}

function makeZip(entries) {
  const fileRecords = []
  const centralRecords = []
  let offset = 0
  for (const entry of entries) {
    const nameBuf = Buffer.from(entry.name, 'utf8')
    const dataRaw = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data, 'utf8')
    const crc = crc32(dataRaw)
    const useDeflate = entry.method === 'deflate'
    const compressed = useDeflate ? deflateRawSync(dataRaw) : dataRaw
    const method = useDeflate ? 8 : 0
    const localHeader = Buffer.alloc(30)
    localHeader.writeUInt32LE(0x04034b50, 0)
    localHeader.writeUInt16LE(20, 4)
    localHeader.writeUInt16LE(0, 6)
    localHeader.writeUInt16LE(method, 8)
    localHeader.writeUInt16LE(0, 10) // time
    localHeader.writeUInt16LE(0x0021, 12) // date (2016-01-01)
    localHeader.writeUInt32LE(crc, 14)
    localHeader.writeUInt32LE(compressed.length, 18)
    localHeader.writeUInt32LE(dataRaw.length, 22)
    localHeader.writeUInt16LE(nameBuf.length, 26)
    localHeader.writeUInt16LE(0, 28)
    fileRecords.push(Buffer.concat([localHeader, nameBuf, compressed]))

    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(0, 8)
    central.writeUInt16LE(method, 10)
    central.writeUInt16LE(0, 12)
    central.writeUInt16LE(0x0021, 14)
    central.writeUInt32LE(crc, 16)
    central.writeUInt32LE(compressed.length, 20)
    central.writeUInt32LE(dataRaw.length, 24)
    central.writeUInt16LE(nameBuf.length, 28)
    central.writeUInt16LE(0, 30)
    central.writeUInt16LE(0, 32)
    central.writeUInt16LE(0, 34)
    central.writeUInt16LE(0, 36)
    central.writeUInt32LE(0, 38)
    central.writeUInt32LE(offset, 42)
    centralRecords.push(Buffer.concat([central, nameBuf]))

    offset += localHeader.length + nameBuf.length + compressed.length
  }
  const centralDir = Buffer.concat(centralRecords)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(0, 4)
  eocd.writeUInt16LE(0, 6)
  eocd.writeUInt16LE(entries.length, 8)
  eocd.writeUInt16LE(entries.length, 10)
  eocd.writeUInt32LE(centralDir.length, 12)
  eocd.writeUInt32LE(offset, 16)
  eocd.writeUInt16LE(0, 20)
  return Buffer.concat([...fileRecords, centralDir, eocd])
}

function buildEpubBuffer(variant = 'base') {
  const mimetype = 'application/epub+zip'

  const containerXml = `<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>
`

  const chapter1 = variant === 'alt'
    ? `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
<head><title>Chapter 1</title></head>
<body>
  <h1>Chapter 1 (revised)</h1>
  <p>Onward Autotest EPUB chapter 1 has been edited.</p>
  <p>This is a searchable sentence about autotest.</p>
  <p>A freshly added paragraph only in v2.</p>
</body>
</html>
`
    : `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
<head><title>Chapter 1</title></head>
<body>
  <h1>Chapter 1</h1>
  <p>Onward Autotest EPUB chapter 1.</p>
  <p>This is a searchable sentence about autotest.</p>
</body>
</html>
`
  const chapter2 = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
<head><title>Chapter 2</title></head>
<body>
  <h1>Chapter 2</h1>
  <p>Onward Autotest EPUB chapter 2.</p>
  <div aria-hidden="true" style="height: 2400px"></div>
</body>
</html>
`

  const navXhtml = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
<head><title>Contents</title></head>
<body>
  <nav epub:type="toc" id="toc">
    <ol>
      <li><a href="chapter1.xhtml">Chapter 1</a></li>
      <li><a href="chapter2.xhtml">Chapter 2</a></li>
    </ol>
  </nav>
</body>
</html>
`

  const opf = `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="BookId" xml:lang="en">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="BookId">urn:uuid:onward-autotest-epub</dc:identifier>
    <dc:title>Onward Autotest EPUB</dc:title>
    <dc:language>en</dc:language>
    <meta property="dcterms:modified">2026-01-01T00:00:00Z</meta>
  </metadata>
  <manifest>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
    <item id="chapter1" href="chapter1.xhtml" media-type="application/xhtml+xml"/>
    <item id="chapter2" href="chapter2.xhtml" media-type="application/xhtml+xml"/>
  </manifest>
  <spine>
    <itemref idref="chapter1"/>
    <itemref idref="chapter2"/>
  </spine>
</package>
`

  const entries = [
    { name: 'mimetype', data: mimetype, method: 'store' },
    { name: 'META-INF/container.xml', data: containerXml, method: 'deflate' },
    { name: 'OEBPS/content.opf', data: opf, method: 'deflate' },
    { name: 'OEBPS/nav.xhtml', data: navXhtml, method: 'deflate' },
    { name: 'OEBPS/chapter1.xhtml', data: chapter1, method: 'deflate' },
    { name: 'OEBPS/chapter2.xhtml', data: chapter2, method: 'deflate' }
  ]

  return makeZip(entries)
}

const pdfBuf = encodePdf('base')
const pdfAltBuf = encodePdf('alt')
const pdfNavigationBuf = encodePdf('navigation')
const pdfOutlineBuf = encodePdf('outline')
const epubBuf = buildEpubBuffer('base')
const epubAltBuf = buildEpubBuffer('alt')

const sha = buf => createHash('sha256').update(buf).digest('hex').slice(0, 12)

// --write: emit the fixture files to test/autotest/fixtures/pdf-epub/ for autotests to
// copy from (see CLAUDE.md rule "fixtures must live on disk").
if (process.argv.includes('--write')) {
  const here = dirname(fileURLToPath(import.meta.url))
  const outDir = join(here, 'pdf-epub')
  mkdirSync(outDir, { recursive: true })
  const files = [
    ['onward-autotest.pdf', pdfBuf],
    ['onward-autotest.alt.pdf', pdfAltBuf],
    ['onward-autotest.navigation.pdf', pdfNavigationBuf],
    ['onward-autotest.outlined.pdf', pdfOutlineBuf],
    ['onward-autotest.epub', epubBuf],
    ['onward-autotest.alt.epub', epubAltBuf]
  ]
  for (const [name, buf] of files) {
    writeFileSync(join(outDir, name), buf)
    process.stdout.write(`wrote ${name} (${buf.length} bytes, sha=${sha(buf)})\n`)
  }
} else {
  process.stdout.write(`PDF_BYTES=${pdfBuf.length}\n`)
  process.stdout.write(`PDF_SHA=${sha(pdfBuf)}\n`)
  process.stdout.write(`PDF_BASE64=${pdfBuf.toString('base64')}\n`)
  process.stdout.write(`PDF_ALT_BYTES=${pdfAltBuf.length}\n`)
  process.stdout.write(`PDF_ALT_SHA=${sha(pdfAltBuf)}\n`)
  process.stdout.write(`PDF_ALT_BASE64=${pdfAltBuf.toString('base64')}\n`)
  process.stdout.write(`PDF_OUTLINE_BYTES=${pdfOutlineBuf.length}\n`)
  process.stdout.write(`PDF_OUTLINE_SHA=${sha(pdfOutlineBuf)}\n`)
  process.stdout.write(`PDF_OUTLINE_BASE64=${pdfOutlineBuf.toString('base64')}\n`)
  process.stdout.write(`EPUB_BYTES=${epubBuf.length}\n`)
  process.stdout.write(`EPUB_SHA=${sha(epubBuf)}\n`)
  process.stdout.write(`EPUB_BASE64=${epubBuf.toString('base64')}\n`)
  process.stdout.write(`EPUB_ALT_BYTES=${epubAltBuf.length}\n`)
  process.stdout.write(`EPUB_ALT_SHA=${sha(epubAltBuf)}\n`)
  process.stdout.write(`EPUB_ALT_BASE64=${epubAltBuf.toString('base64')}\n`)
}
