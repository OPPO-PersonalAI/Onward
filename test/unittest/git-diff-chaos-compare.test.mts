/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 *
 * Locks the chaos-convergence ORACLE's decision table
 * (src/autotest/git-diff-chaos-compare.ts). The oracle decides whether the
 * Git Diff UI equals on-disk truth; a wrong oracle either fails healthy
 * builds (flake) or blesses stale ones (the worse failure — it would silence
 * exactly the user-reported symptom class the suite exists to catch).
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import {
  bodyCheckCandidates,
  compareBody,
  compareListToTruth
} from '../../src/autotest/git-diff-chaos-compare.ts'

const truth = (path: string, xy: string, body: string | null = null) => ({ path, xy, body })

test('identical sets match (staged+unstaged duplicate collapses to one path)', () => {
  const verdict = compareListToTruth(
    [
      { filename: 'docs/a.md', changeType: 'staged' },
      { filename: 'docs/a.md', changeType: 'unstaged' },
      { filename: 'new.md', changeType: 'untracked' }
    ],
    [truth('docs/a.md', 'MM'), truth('new.md', '??', 'x')]
  )
  assert.equal(verdict.match, true)
  assert.deepEqual(verdict.missing, [])
  assert.deepEqual(verdict.extra, [])
})

test('a truth file absent from the UI is MISSING (the "new file never shows" symptom)', () => {
  const verdict = compareListToTruth(
    [{ filename: 'docs/a.md', changeType: 'unstaged' }],
    [truth('docs/a.md', ' M'), truth('chaos_c1_3.md', '??', 'x')]
  )
  assert.equal(verdict.match, false)
  assert.deepEqual(verdict.missing, ['chaos_c1_3.md'])
  assert.deepEqual(verdict.extra, [])
})

test('a UI file absent from truth is EXTRA (deleted-file ghost entry)', () => {
  const verdict = compareListToTruth(
    [
      { filename: 'docs/a.md', changeType: 'unstaged' },
      { filename: 'chaos_c1_9.md', changeType: 'untracked' }
    ],
    [truth('docs/a.md', ' M')]
  )
  assert.equal(verdict.match, false)
  assert.deepEqual(verdict.extra, ['chaos_c1_9.md'])
})

test('windows path separators normalize before comparison', () => {
  const verdict = compareListToTruth(
    [{ filename: 'docs\\a.md', changeType: 'unstaged' }],
    [truth('docs/a.md', ' M')]
  )
  assert.equal(verdict.match, true)
})

test('body candidates: only unambiguous worktree-backed states with captured bodies', () => {
  const candidates = bodyCheckCandidates([
    truth('untracked.md', '??', 'u'),
    truth('modified.md', ' M', 'm'),
    truth('staged-only.md', 'M ', 's'),        // index-side pane → excluded
    truth('staged-and-modified.md', 'MM', 'x'), // ambiguous pane → excluded
    truth('no-body.md', ' M', null)             // writer could not capture → excluded
  ])
  assert.deepEqual(candidates.map((c) => c.path), ['modified.md', 'untracked.md'])
})

test('body candidates: most-recently-written first (TOCTOU poison class), path tie-break', () => {
  const candidates = bodyCheckCandidates([
    { path: 'old.md', xy: ' M', body: 'a', lastOpAt: 100 },
    { path: 'newest.md', xy: '??', body: 'b', lastOpAt: 900 },
    { path: 'untouched-z.md', xy: ' M', body: 'c', lastOpAt: null },
    { path: 'untouched-a.md', xy: ' M', body: 'd' },
    { path: 'mid.md', xy: '??', body: 'e', lastOpAt: 500 }
  ])
  assert.deepEqual(
    candidates.map((c) => c.path),
    ['newest.md', 'mid.md', 'old.md', 'untouched-a.md', 'untouched-z.md']
  )
})

test('body verdicts: match / mismatch / not-yet-loaded', () => {
  const entry = truth('modified.md', ' M', 'expected body\n')
  assert.equal(compareBody('expected body\n', entry).match, true)
  assert.equal(compareBody('stale body\n', entry).match, false)
  assert.equal(compareBody(null, entry).match, false)
  // Truth without a body is vacuously satisfied (nothing to compare).
  assert.equal(compareBody(null, truth('x.md', ' M', null)).match, true)
})
