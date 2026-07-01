/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 *
 * Locks the idempotent-write behaviour of the Change Log compiler
 * (scripts/changelog-compiler.js `writeFile`). The compiler runs on every build;
 * without a skip-if-unchanged guard it rewrote every changelog HTML file
 * unconditionally, bumping the file mtime and marking the files spuriously
 * "modified" in git status even though the content was byte-identical (most
 * visible on Windows). This pins both directions of the guard:
 *   1. an unchanged rebuild does NOT rewrite the file (mtime stays put), and
 *   2. a changed source DOES rewrite it (the guard never over-skips).
 *
 * The fixture is built at runtime in the OS temp dir (never beside the checkout)
 * and removed in `finally`, per the autotest fixture-isolation rules.
 */

import assert from 'node:assert/strict'
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'

const require = createRequire(import.meta.url)
const { compileChangelogAssets } = require('../../scripts/changelog-compiler.js') as {
  compileChangelogAssets: (root: string) => { compiledCount: number; entries: number; indexPath: string }
}

const MARKDOWN_REL = 'en/daily/test-entry.md'
const HTML_REL = 'html/en/daily/test-entry.html'
// A fixed timestamp far in the past. If the compiler rewrites the file its mtime
// jumps to "now"; if it correctly skips, the mtime stays pinned here. The gap is
// years wide, so filesystem mtime granularity cannot make the check flaky.
const PINNED_PAST = new Date('2020-01-01T00:00:00Z')

function makeFixture(markdown: string): string {
  const root = mkdtempSync(join(tmpdir(), 'onward-changelog-idempotent-'))
  const mdPath = join(root, MARKDOWN_REL)
  mkdirSync(dirname(mdPath), { recursive: true })
  writeFileSync(mdPath, markdown, 'utf-8')
  writeFileSync(
    join(root, 'index.json'),
    `${JSON.stringify({ entries: [{ tag: 'v0.0.0-test', markdown: { en: MARKDOWN_REL } }] }, null, 2)}\n`,
    'utf-8',
  )
  return root
}

function pinPastMtime(path: string): number {
  utimesSync(path, PINNED_PAST, PINNED_PAST)
  return statSync(path).mtimeMs
}

test('changelog compiler renders HTML on first compile', () => {
  const root = makeFixture('# Hello World\n\nfirst body\n')
  try {
    compileChangelogAssets(root)
    const html = readFileSync(join(root, HTML_REL), 'utf-8')
    assert.ok(html.includes('Hello World'), 'rendered HTML must contain the heading text')
    assert.ok(html.includes('first body'), 'rendered HTML must contain the body text')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('unchanged rebuild does NOT rewrite the HTML file (idempotent skip)', () => {
  const root = makeFixture('# Hello World\n\nsame body\n')
  try {
    compileChangelogAssets(root)
    const htmlPath = join(root, HTML_REL)
    const before = pinPastMtime(htmlPath)
    // Second compile with identical source -> the skip-if-unchanged guard must fire.
    compileChangelogAssets(root)
    const after = statSync(htmlPath).mtimeMs
    assert.equal(after, before, 'an idempotent rebuild must leave the file (and its mtime) untouched')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('changed source DOES rewrite the HTML file (guard never over-skips)', () => {
  const root = makeFixture('# Hello World\n\noriginal body\n')
  try {
    compileChangelogAssets(root)
    const htmlPath = join(root, HTML_REL)
    const before = pinPastMtime(htmlPath)
    // Change the markdown source -> rendered HTML differs -> the compiler must write.
    writeFileSync(join(root, MARKDOWN_REL), '# Hello World\n\nedited body\n', 'utf-8')
    compileChangelogAssets(root)
    const after = statSync(htmlPath).mtimeMs
    const html = readFileSync(htmlPath, 'utf-8')
    assert.ok(after > before, 'a changed source must rewrite the file (mtime advances past the pinned date)')
    assert.ok(html.includes('edited body'), 'the rewritten HTML must reflect the edited source')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
