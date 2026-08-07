/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 *
 * Unit tests for `src/components/ProjectEditor/watchPathMatch.ts` — the
 * renderer-side decision "does this watcher event belong to the active file".
 *
 * Both defect classes locked here shipped as REAL bugs that each cost a
 * debugging round: every watcher event was silently dropped, and the refresh
 * chain looked healthy end to end because the drop point had no breadcrumb.
 *
 * Usage: node --experimental-strip-types --test test/unittest/watch-path-match.test.mts
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  expectedWatchPath,
  isAbsolutePathLike,
  watchPathsEqual
} from '../../src/components/ProjectEditor/watchPathMatch.ts'

// ─────────────── WPM-U-01..03 absolute-vs-relative classification ───────────────

test('WPM-U-01 POSIX absolute, Windows drive and UNC paths classify as absolute', () => {
  assert.equal(isAbsolutePathLike('/var/tmp/x.pdf'), true)
  assert.equal(isAbsolutePathLike('C:\\proj\\x.pdf'), true)
  assert.equal(isAbsolutePathLike('c:/proj/x.pdf'), true)
  assert.equal(isAbsolutePathLike('\\\\server\\share\\x.pdf'), true)
})

test('WPM-U-02 root-relative paths classify as relative', () => {
  assert.equal(isAbsolutePathLike('sample.pdf'), false)
  assert.equal(isAbsolutePathLike('docs/sample.pdf'), false)
  assert.equal(isAbsolutePathLike('docs\\sample.pdf'), false)
})

// ─────────────── WPM-U-04..07 expected-path construction ───────────────

test('WPM-U-03 a relative active file joins onto the root', () => {
  assert.equal(expectedWatchPath('/proj', 'docs/a.md'), '/proj/docs/a.md')
  assert.equal(expectedWatchPath('C:\\proj', 'docs\\a.md'), 'C:\\proj\\docs\\a.md')
})

test('WPM-U-04 an ABSOLUTE active file is used verbatim — never root-prefixed', () => {
  // The regression: absolute-path open flows store the absolute path, and
  // root-prefixing it built '/root//abs/path' — a compare target no watcher
  // event ever matches, so refresh silently died for those files.
  assert.equal(
    expectedWatchPath('/var/tmp/root.X', '/var/tmp/root.X/sample.pdf'),
    '/var/tmp/root.X/sample.pdf'
  )
})

test('WPM-U-05 a root with a trailing separator does not double it', () => {
  assert.equal(expectedWatchPath('/proj/', 'a.md'), '/proj/a.md')
})

// ─────────────── WPM-U-06..08 equality semantics ───────────────

test('WPM-U-06 separator runs collapse on both sides', () => {
  // A TMPDIR ending in '/' produced '/T//onward-…' roots; the main process
  // sends normalized single-separator paths.
  assert.equal(watchPathsEqual('/T//onward/root/a.pdf', '/T/onward/root/a.pdf'), true)
})

test('WPM-U-07 slash direction is irrelevant', () => {
  assert.equal(watchPathsEqual('C:\\proj\\a.md', 'C:/proj/a.md'), true)
})

test('WPM-U-08 genuinely different paths still differ', () => {
  assert.equal(watchPathsEqual('/proj/a.md', '/proj/b.md'), false)
  assert.equal(watchPathsEqual('/proj/a.md', '/proj/sub/a.md'), false)
})

// ─────────────── WPM-U-09 the composed end-to-end regression shapes ───────────────

test('WPM-U-09 both real-bug shapes match end to end', () => {
  // Bug 1: doubled separator in the root.
  const root1 = '/var/folders/T//onward-root.X'
  assert.equal(
    watchPathsEqual('/var/folders/T/onward-root.X/sample.pdf', expectedWatchPath(root1, 'sample.pdf')),
    true
  )
  // Bug 2: absolute activeFilePath.
  const root2 = '/var/folders/T/onward-root.X'
  assert.equal(
    watchPathsEqual(
      '/var/folders/T/onward-root.X/sample.pdf',
      expectedWatchPath(root2, '/var/folders/T/onward-root.X/sample.pdf')
    ),
    true
  )
})
