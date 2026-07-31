/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 *
 * Pure-logic coverage for the Markdown preview link router. The hrefs fed in
 * mirror what markdownPreviewWorker.ts actually emits after rewriting: local
 * project links arrive as file:// URLs, anchors stay '#...', external URLs
 * stay untouched, and root-escaping relative links survive as raw text. The
 * paired autotest verifies the click actually opens the target viewer.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { classifyMarkdownPreviewHref } from '../../src/utils/preview-link-dispatch.ts'

const POSIX = { rootPath: '/tmp/project', platform: 'darwin' as const }
const WIN = { rootPath: 'C:\\work tree\\site', platform: 'win32' as const }

test('PLD-U-01 in-page anchors decode to element ids', () => {
  assert.deepEqual(
    classifyMarkdownPreviewHref({ href: '#section-1', ...POSIX }),
    { kind: 'anchor', anchorId: 'section-1' }
  )
  assert.deepEqual(
    classifyMarkdownPreviewHref({ href: '#%E4%B8%AD%E6%96%87', ...POSIX }),
    { kind: 'anchor', anchorId: '中文' }
  )
})

test('PLD-U-02 http(s) and protocol-relative links go external', () => {
  assert.deepEqual(
    classifyMarkdownPreviewHref({ href: 'https://example.com/a.md', ...POSIX }),
    { kind: 'external', url: 'https://example.com/a.md' }
  )
  assert.deepEqual(
    classifyMarkdownPreviewHref({ href: 'http://localhost:3000/', ...POSIX }),
    { kind: 'external', url: 'http://localhost:3000/' }
  )
  assert.deepEqual(
    classifyMarkdownPreviewHref({ href: '//example.com/a', ...POSIX }),
    { kind: 'external', url: 'https://example.com/a' }
  )
})

test('PLD-U-03 in-root file URLs become slash-relative project paths', () => {
  assert.deepEqual(
    classifyMarkdownPreviewHref({ href: 'file:///tmp/project/docs/notes.md', ...POSIX }),
    { kind: 'project-file', relativePath: 'docs/notes.md' }
  )
  // encodeURI output from the worker's toFileUrl (spaces + CJK).
  assert.deepEqual(
    classifyMarkdownPreviewHref({ href: encodeURI('file:///tmp/project/图 片/说明.pdf'), ...POSIX }),
    { kind: 'project-file', relativePath: '图 片/说明.pdf' }
  )
})

test('PLD-U-04 out-of-root file URLs and surviving relative hrefs are refused', () => {
  assert.deepEqual(
    classifyMarkdownPreviewHref({ href: 'file:///tmp/other/readme.md', ...POSIX }),
    { kind: 'outside-root' }
  )
  // Prefix sibling must not pass the containment check.
  assert.deepEqual(
    classifyMarkdownPreviewHref({ href: 'file:///tmp/project-copy/readme.md', ...POSIX }),
    { kind: 'outside-root' }
  )
  // The worker leaves a relative href untouched when it escapes the root.
  assert.deepEqual(
    classifyMarkdownPreviewHref({ href: '../secret.md', ...POSIX }),
    { kind: 'outside-root' }
  )
})

test('PLD-U-05 protocol links: mailto/tel go to the OS handler, the rest are refused', () => {
  assert.deepEqual(
    classifyMarkdownPreviewHref({ href: 'mailto:a@b.c', ...POSIX }),
    { kind: 'external-protocol', url: 'mailto:a@b.c' }
  )
  assert.deepEqual(
    classifyMarkdownPreviewHref({ href: 'tel:+8610000000', ...POSIX }),
    { kind: 'external-protocol', url: 'tel:+8610000000' }
  )
  assert.equal(classifyMarkdownPreviewHref({ href: 'data:text/plain,hi', ...POSIX }).kind, 'unresolvable')
  assert.equal(classifyMarkdownPreviewHref({ href: 'javascript:alert(1)', ...POSIX }).kind, 'unresolvable')
  assert.equal(classifyMarkdownPreviewHref({ href: '', ...POSIX }).kind, 'unresolvable')
  assert.equal(classifyMarkdownPreviewHref({ href: 'file:///tmp/project', ...POSIX }).kind, 'unresolvable')
})

test('PLD-U-06 Windows drive-letter file URLs respect case-insensitive containment', () => {
  // The worker emits file:///C:/... with forward slashes.
  assert.deepEqual(
    classifyMarkdownPreviewHref({ href: encodeURI('file:///C:/work tree/site/docs/说明.md'), ...WIN }),
    { kind: 'project-file', relativePath: 'docs/说明.md' }
  )
  // Case-insensitive drive/root comparison, case-preserving relative slice.
  assert.deepEqual(
    classifyMarkdownPreviewHref({ href: encodeURI('file:///c:/Work Tree/Site/Docs/Readme.MD'), ...WIN }),
    { kind: 'project-file', relativePath: 'Docs/Readme.MD' }
  )
  assert.deepEqual(
    classifyMarkdownPreviewHref({ href: encodeURI('file:///C:/work tree/other/readme.md'), ...WIN }),
    { kind: 'outside-root' }
  )
})

test('PLD-U-07 duplicate separators in the root do not break containment', () => {
  // Regression: a TMPDIR ending in '/' yields editor roots like '/a/T//proj'
  // while the worker's collapsed file URL carries single slashes — the
  // containment test must compare collapsed forms (PHTML-44 failure).
  assert.deepEqual(
    classifyMarkdownPreviewHref({
      href: 'file:///var/T/proj/docs/notes.md',
      rootPath: '/var/T//proj',
      platform: 'darwin'
    }),
    { kind: 'project-file', relativePath: 'docs/notes.md' }
  )
  // A UNC-style Windows root keeps its leading double slash: file://server/...
  // parses 'server' as the URL host, so the pathname lacks the UNC prefix —
  // containment must refuse (not crash, not false-match).
  assert.equal(
    classifyMarkdownPreviewHref({
      href: 'file://server/share/proj/docs/notes.md',
      rootPath: '\\\\server\\share\\proj',
      platform: 'win32'
    }).kind,
    'outside-root'
  )
})
