/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 *
 * Usage: node --experimental-strip-types --test test/unittest/git-log-diff-parse.test.mts
 *
 * Locks the git-op aggregation A2 batch parser: one `git log --raw --numstat
 * --format='%x1e%H%x1f%P'` invocation → per-commit file changes (status from
 * --raw, counts from --numstat, merged by index). Inputs mirror the REAL git
 * output observed on the repo.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { parseGitLogRawNumstat } from '../../electron/main/git-log-diff-parse.ts'

const RS = '\x1e'
const US = '\x1f'

// Build one commit chunk in the observed format: header, blank line, --raw
// block, --numstat block.
function commit(sha: string, parents: string, rawLines: string[], numLines: string[]): string {
  return `${RS}${sha}${US}${parents}\n\n${rawLines.join('\n')}\n${numLines.join('\n')}\n`
}

test('parses a single commit: status from --raw, counts from --numstat, merged by index', () => {
  const out = commit(
    'abc123', 'parent1',
    [':100644 100644 f83 3ec M\tsrc/app.ts', ':000000 100644 000 acf A\tsrc/new.ts'],
    ['8\t38\tsrc/app.ts', '78\t0\tsrc/new.ts']
  )
  const [c] = parseGitLogRawNumstat(out)
  assert.equal(c.sha, 'abc123')
  assert.deepEqual(c.parents, ['parent1'])
  assert.equal(c.files.length, 2)
  assert.deepEqual(c.files[0], { filename: 'src/app.ts', status: 'M', additions: 8, deletions: 38, binary: false })
  assert.deepEqual(c.files[1], { filename: 'src/new.ts', status: 'A', additions: 78, deletions: 0, binary: false })
})

test('parses a deletion', () => {
  const out = commit('d1', 'p1', [':100644 000000 a 0 D\told/gone.ts'], ['0\t12\told/gone.ts'])
  const [c] = parseGitLogRawNumstat(out)
  assert.deepEqual(c.files[0], { filename: 'old/gone.ts', status: 'D', additions: 0, deletions: 12, binary: false })
})

test('parses a binary file (--numstat reports `-`)', () => {
  const out = commit('b1', 'p1', [':100644 100644 a b M\timg/logo.png'], ['-\t-\timg/logo.png'])
  const [c] = parseGitLogRawNumstat(out)
  assert.equal(c.files[0].binary, true)
  assert.equal(c.files[0].additions, 0)
  assert.equal(c.files[0].status, 'M')
})

test('parses a rename: status R, original + new filename', () => {
  // --raw rename line carries old\tnew after the header.
  const out = commit(
    'r1', 'p1',
    [':100644 100644 a b R100\told/name.ts\tnew/name.ts'],
    ['3\t1\told/name.ts => new/name.ts']
  )
  const [c] = parseGitLogRawNumstat(out)
  assert.equal(c.files[0].status, 'R')
  assert.equal(c.files[0].originalFilename, 'old/name.ts')
  assert.equal(c.files[0].filename, 'new/name.ts')
  assert.equal(c.files[0].additions, 3)
})

test('parses multiple commits in one stream', () => {
  const out =
    commit('c1', 'c0', [':100644 100644 a b M\ta.ts'], ['1\t1\ta.ts']) +
    commit('c0', '', [':000000 100644 0 a A\ta.ts'], ['10\t0\ta.ts'])
  const commits = parseGitLogRawNumstat(out)
  assert.equal(commits.length, 2)
  assert.equal(commits[0].sha, 'c1')
  assert.equal(commits[1].sha, 'c0')
  assert.deepEqual(commits[1].parents, [], 'root commit has no parents')
  assert.equal(commits[1].files[0].status, 'A')
})

test('merge commit (2+ parents) with --diff-merges=first-parent body → non-empty files', () => {
  // Regression lock for the Git History merge-empty bug: the prewarm batch must
  // run `git log --diff-merges=first-parent`, which gives a MERGE commit a real
  // --raw/--numstat body (its diff against the FIRST parent). Without that flag git
  // omits the merge body entirely, the parser yields files:[], and the on-click L9
  // cache HIT shows zero files for every merge. Here the multi-parent header still
  // carries a populated body — the parser must attribute it to the merge commit.
  const out = commit(
    'merge1', 'firstParent secondParent',
    [':100644 100644 a b M\tsrc/changed.ts', ':000000 100644 0 c A\tsrc/added.ts'],
    ['5\t2\tsrc/changed.ts', '40\t0\tsrc/added.ts']
  )
  const [c] = parseGitLogRawNumstat(out)
  assert.equal(c.sha, 'merge1')
  assert.deepEqual(c.parents, ['firstParent', 'secondParent'], 'merge keeps both parents')
  assert.equal(c.files.length, 2, 'first-parent merge diff is NOT empty')
  assert.equal(c.files[0].filename, 'src/changed.ts')
  assert.equal(c.files[1].status, 'A')
})

test('merge commit WITHOUT a diff body (the bug shape) → empty files', () => {
  // Documents the pre-fix shape for contrast: a multi-parent commit emitted by a
  // plain `git log` (no --diff-merges) has no body, so files is empty. This is the
  // exact output that primed an empty L9 entry — the fix is the CLI flag, which
  // gives the merge the body asserted in the test above.
  const out = `${RS}merge0${US}p1 p2\n\n`
  const [c] = parseGitLogRawNumstat(out)
  assert.deepEqual(c.parents, ['p1', 'p2'])
  assert.deepEqual(c.files, [], 'no body → empty files (pre-fix merge behaviour)')
})

test('empty output → empty array', () => {
  assert.deepEqual(parseGitLogRawNumstat(''), [])
})

test('a commit with no file changes yields an empty files array', () => {
  const out = `${RS}empty1${US}p1\n\n`
  const [c] = parseGitLogRawNumstat(out)
  assert.equal(c.sha, 'empty1')
  assert.deepEqual(c.files, [])
})
