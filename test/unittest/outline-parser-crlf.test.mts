/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

// Locks the CRLF-safety of the markdown outline parser. On Windows with the
// default core.autocrlf=true, a markdown file stored LF in git is checked out
// CRLF, so the parser receives '\r\n' line endings. Before the fix the parser
// split on '\n' alone, leaving a trailing '\r' that HEADING_RE (anchored on
// '$') could not consume, yielding ZERO outline symbols for every CRLF file.
// This is the pure-logic companion to run-project-editor-markdown-navigation
// (PMN-03), which proves the same against a real CRLF fixture end-to-end. The
// heading parser was extracted to outlineMarkdownHeadings.ts precisely so it can
// be exercised here without loading the monaco-editor runtime.

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { parseMarkdownOutline } from '../../src/components/ProjectEditor/Outline/outlineMarkdownHeadings.ts'

const HEADINGS = ['# Title', '## Section A', '### Sub A1', '## Section B']

function flatten(items: ReturnType<typeof parseMarkdownOutline>): string[] {
  const names: string[] = []
  const walk = (list: typeof items): void => {
    for (const it of list) {
      names.push(it.name)
      if (it.children?.length) walk(it.children)
    }
  }
  walk(items)
  return names
}

test('OPC-U-01 CRLF markdown yields the same headings as LF markdown', () => {
  const lf = HEADINGS.join('\n') + '\n'
  const crlf = HEADINGS.join('\r\n') + '\r\n'
  const lfNames = flatten(parseMarkdownOutline(lf))
  const crlfNames = flatten(parseMarkdownOutline(crlf))
  assert.equal(lfNames.length, 4, 'LF baseline must find all 4 headings')
  assert.deepEqual(
    crlfNames,
    lfNames,
    'CRLF file must yield identical headings to LF (no trailing-\\r regression)'
  )
})

test('OPC-U-02 CRLF heading names carry no trailing carriage return', () => {
  const crlf = HEADINGS.join('\r\n') + '\r\n'
  const names = flatten(parseMarkdownOutline(crlf))
  assert.ok(names.length >= 4, 'expected at least 4 parsed headings')
  for (const n of names) {
    assert.ok(!n.includes('\r'), `heading name must not contain a carriage return: ${JSON.stringify(n)}`)
  }
  assert.ok(names.includes('Title'), 'top heading name must be clean "Title"')
})

test('OPC-U-03 bare-CR (old-mac) line endings also parse', () => {
  const cr = HEADINGS.join('\r') + '\r'
  const names = flatten(parseMarkdownOutline(cr))
  assert.equal(names.length, 4, 'bare-\\r line endings must also yield all 4 headings')
})

test('OPC-U-04 nesting + code-fence skipping survive CRLF', () => {
  const md = ['# Top', '```', '## NotAHeading (inside fence)', '```', '## Real Child'].join('\r\n')
  const tree = parseMarkdownOutline(md)
  assert.equal(tree.length, 1, 'one top-level heading')
  assert.equal(tree[0].name, 'Top')
  assert.equal(tree[0].children.length, 1, 'fenced "##" must be skipped; only one real child')
  assert.equal(tree[0].children[0].name, 'Real Child')
})
