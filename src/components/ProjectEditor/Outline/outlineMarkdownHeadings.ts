/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

// Pure Markdown-heading outline parser, extracted from outlineParser.ts so it can
// be unit-tested in plain Node WITHOUT pulling in the monaco-editor runtime (which
// references `window` and cannot load outside a browser/Electron renderer).
// Mirrors the existing outlineParseSource.ts extraction pattern.

// Type-only import (erased at compile time) so this module needs NO runtime
// import of './types'. That matters because types.ts exports a runtime `enum`,
// which `node --experimental-strip-types` (strip-only mode, used by the unit-test
// suite) cannot load — a value import would make this module un-unit-testable.
import type { OutlineItem, OutlineSymbolKind } from './types'

const HEADING_RE = /^(#{1,6})\s+(.+)$/
const CODE_FENCE_RE = /^```/

// OutlineSymbolKind.Heading1..Heading6 are 100..105 (see types.ts). Referenced as
// numeric literals (typed via the erased import) rather than the enum object, so
// no runtime './types' resolution is needed. Numeric literals are assignable to a
// numeric enum type; the end-to-end PMN-03 autotest covers the mapping.
const HEADING_KIND_BY_LEVEL: Record<number, OutlineSymbolKind> = {
  1: 100,
  2: 101,
  3: 102,
  4: 103,
  5: 104,
  6: 105,
}
const HEADING1_KIND = 100 as OutlineSymbolKind

function updateEndLines(items: OutlineItem[], totalLines: number): void {
  for (let i = 0; i < items.length; i++) {
    const nextSibling = items[i + 1]
    items[i].endLine = nextSibling ? nextSibling.startLine - 1 : totalLines
    if (items[i].children.length > 0) {
      updateEndLines(items[i].children, items[i].endLine)
    }
  }
}

/**
 * Parse Markdown `#`..`######` headings into a nested OutlineItem tree.
 *
 * Splits on all line-ending styles (`\r\n`, `\r`, `\n`) so a CRLF-checked-out
 * file (the Windows default with core.autocrlf=true) does not leave a trailing
 * `\r` on every line. HEADING_RE anchors on `$`, and JS `$` / `.` do not consume
 * `\r`, so a naive `split('\n')` would make every heading parse as zero symbols
 * on a CRLF file (empty outline for real Windows users opening any CRLF markdown).
 */
export function parseMarkdownOutline(content: string): OutlineItem[] {
  const lines = content.split(/\r\n|\r|\n/)
  const root: OutlineItem[] = []
  const stack: { level: number; item: OutlineItem }[] = []
  let inCodeBlock = false

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]

    if (CODE_FENCE_RE.test(line)) {
      inCodeBlock = !inCodeBlock
      continue
    }
    if (inCodeBlock) continue

    const match = HEADING_RE.exec(line)
    if (!match) continue

    const level = match[1].length
    const name = match[2].trim()

    const item: OutlineItem = {
      name,
      kind: HEADING_KIND_BY_LEVEL[level] ?? HEADING1_KIND,
      startLine: i + 1,
      startColumn: 1,
      endLine: i + 1,
      endColumn: line.length + 1,
      children: [],
      depth: level - 1,
    }

    // Pop stack until we find a parent with a lower level
    while (stack.length > 0 && stack[stack.length - 1].level >= level) {
      stack.pop()
    }

    if (stack.length > 0) {
      stack[stack.length - 1].item.children.push(item)
    } else {
      root.push(item)
    }
    stack.push({ level, item })
  }

  // Each heading extends until the next sibling or parent-level heading.
  updateEndLines(root, lines.length)
  return root
}
