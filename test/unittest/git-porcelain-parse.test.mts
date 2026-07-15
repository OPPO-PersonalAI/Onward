/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 *
 * Usage: node --experimental-strip-types --test test/unittest/git-porcelain-parse.test.mts
 *
 * Covers the porcelain v2 parser used by the GitStateMirror worker.
 * Behaviour is intentionally identical to the legacy main-process
 * `git-utils.ts:parseStatusPorcelainV2Z` so the renderer sees the same
 * shape from either source.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  buildGitResourceFields,
  makeGitFileStatus,
  normalizeGitStatusCode,
  parseBranchAb,
  parseStatusPorcelainV2Z
} from '../../electron/main/git-porcelain-parse.ts'

// ---------------------------------------------------------------------------
// normalizeGitStatusCode
// ---------------------------------------------------------------------------

test('normalizeGitStatusCode passes through valid single-letter codes', () => {
  for (const code of ['M', 'A', 'D', 'R', 'C', '?', '!'] as const) {
    assert.equal(normalizeGitStatusCode(code), code)
  }
})

test('normalizeGitStatusCode folds U (unmerged) into ! (conflict)', () => {
  assert.equal(normalizeGitStatusCode('U'), '!')
})

test('normalizeGitStatusCode defaults unknown codes to M', () => {
  assert.equal(normalizeGitStatusCode(''), 'M')
  assert.equal(normalizeGitStatusCode('Z'), 'M')
  assert.equal(normalizeGitStatusCode('XY'), 'M')
})

// ---------------------------------------------------------------------------
// buildGitResourceFields
// ---------------------------------------------------------------------------

test('buildGitResourceFields maps staged + modified to index ref pair', () => {
  assert.deepEqual(buildGitResourceFields('staged', 'M'), {
    resourceGroup: 'index',
    originalRef: 'HEAD',
    modifiedRef: 'index'
  })
})

test('buildGitResourceFields maps staged + added to empty → index', () => {
  // Newly-added file: HEAD side has no content; index has the new entry.
  assert.deepEqual(buildGitResourceFields('staged', 'A'), {
    resourceGroup: 'index',
    originalRef: 'empty',
    modifiedRef: 'index'
  })
})

test('buildGitResourceFields maps staged + deleted to HEAD → empty', () => {
  assert.deepEqual(buildGitResourceFields('staged', 'D'), {
    resourceGroup: 'index',
    originalRef: 'HEAD',
    modifiedRef: 'empty'
  })
})

test('buildGitResourceFields maps unstaged + modified to index → workingTree', () => {
  assert.deepEqual(buildGitResourceFields('unstaged', 'M'), {
    resourceGroup: 'workingTree',
    originalRef: 'index',
    modifiedRef: 'workingTree'
  })
})

test('buildGitResourceFields maps untracked to empty → workingTree', () => {
  assert.deepEqual(buildGitResourceFields('untracked', '?'), {
    resourceGroup: 'untracked',
    originalRef: 'empty',
    modifiedRef: 'workingTree'
  })
})

test('buildGitResourceFields maps conflict to merge group', () => {
  assert.deepEqual(buildGitResourceFields('conflict', '!'), {
    resourceGroup: 'merge',
    originalRef: null,
    modifiedRef: 'workingTree'
  })
})

// ---------------------------------------------------------------------------
// makeGitFileStatus
// ---------------------------------------------------------------------------

test('makeGitFileStatus produces a complete GitFileStatus with zero numstat', () => {
  const file = makeGitFileStatus({
    filename: 'src/app.ts',
    status: 'M',
    changeType: 'unstaged',
    repoRoot: '/repo'
  })
  assert.equal(file.filename, 'src/app.ts')
  assert.equal(file.status, 'M')
  assert.equal(file.changeType, 'unstaged')
  assert.equal(file.additions, 0)
  assert.equal(file.deletions, 0)
  assert.equal(file.resourceGroup, 'workingTree')
  assert.equal(file.originalRef, 'index')
  assert.equal(file.modifiedRef, 'workingTree')
  assert.equal(file.repoRoot, '/repo')
})

test('makeGitFileStatus tags submodule entries with submoduleFlags', () => {
  const file = makeGitFileStatus({
    filename: 'modules/x',
    status: 'M',
    changeType: 'unstaged',
    repoRoot: '/repo',
    isSubmoduleEntry: true,
    submoduleFlags: { commitChanged: true, workTreeModified: false, untrackedContent: false }
  })
  assert.equal(file.isSubmoduleEntry, true)
  assert.deepEqual(file.submoduleFlags, { commitChanged: true, workTreeModified: false, untrackedContent: false })
})

// ---------------------------------------------------------------------------
// parseStatusPorcelainV2Z
// ---------------------------------------------------------------------------

test('parseStatusPorcelainV2Z handles empty output', () => {
  const result = parseStatusPorcelainV2Z('', '/repo')
  assert.equal(result.branch, null)
  assert.equal(result.status, 'clean')
  assert.deepEqual(result.files, [])
})

test('parseStatusPorcelainV2Z returns null branchOid when no header is present', () => {
  // P0 freshness signal: absent header (e.g. empty output) → null oid so the
  // History cache key falls back rather than keying on a stale value.
  assert.equal(parseStatusPorcelainV2Z('', '/repo').branchOid, null)
})

test('parseStatusPorcelainV2Z parses branch header from concatenated chunk', () => {
  // Porcelain v2 header chunks are LF-separated and packed before the
  // first NUL; we accept either pattern.
  const out = '# branch.oid abc123def\n# branch.head main\n\0'
  const result = parseStatusPorcelainV2Z(out, '/repo')
  assert.equal(result.branch, 'main')
  assert.equal(result.status, 'clean')
  // P0: full HEAD oid surfaced as the History cache's third freshness signal.
  assert.equal(result.branchOid, 'abc123def')
})

test('parseStatusPorcelainV2Z surfaces the FULL oid even when branch is a short-sha fallback', () => {
  // Detached HEAD: `branch` collapses to a 7-char display sha, but branchOid
  // must still carry the complete object id so the History key stays exact.
  const out = '# branch.oid abcdef0123456789\n# branch.head (detached)\n\0'
  const result = parseStatusPorcelainV2Z(out, '/repo')
  assert.equal(result.branch, 'abcdef0')
  assert.equal(result.branchOid, 'abcdef0123456789')
})

test('parseStatusPorcelainV2Z carries the literal (initial) oid for a commit-less repo', () => {
  // A brand-new repo: `# branch.oid (initial)`. The literal is a stable
  // discriminator until the first commit lands (then branchOid moves).
  const out = '# branch.oid (initial)\n# branch.head (initial)\n\0'
  const result = parseStatusPorcelainV2Z(out, '/repo')
  assert.equal(result.branchOid, '(initial)')
})

// ---------------------------------------------------------------------------
// parseBranchAb (# branch.ab +A -B) — ahead/behind counts
// ---------------------------------------------------------------------------

test('parseBranchAb parses +ahead -behind', () => {
  assert.deepEqual(parseBranchAb('+2 -1'), { ahead: 2, behind: 1 })
  assert.deepEqual(parseBranchAb('+0 -0'), { ahead: 0, behind: 0 })
  assert.deepEqual(parseBranchAb('+17 -0'), { ahead: 17, behind: 0 })
})

test('parseBranchAb tolerates extra whitespace', () => {
  assert.deepEqual(parseBranchAb('  +3   -4  '), { ahead: 3, behind: 4 })
})

test('parseBranchAb returns null on malformed payloads (degrade to no-upstream)', () => {
  assert.equal(parseBranchAb(''), null)
  assert.equal(parseBranchAb('+2'), null) // missing behind token
  assert.equal(parseBranchAb('-1'), null) // missing ahead token
  assert.equal(parseBranchAb('garbage'), null)
})

test('parseStatusPorcelainV2Z surfaces ahead/behind from # branch.ab', () => {
  // Upstream configured: git emits branch.upstream + branch.ab.
  const out = '# branch.oid abc123\n# branch.head main\n# branch.upstream origin/main\n# branch.ab +2 -1\n\0'
  const result = parseStatusPorcelainV2Z(out, '/repo')
  assert.equal(result.ahead, 2)
  assert.equal(result.behind, 1)
  assert.equal(result.status, 'clean')
})

test('parseStatusPorcelainV2Z ahead-only (unpushed commits, up to date on remote)', () => {
  const out = '# branch.oid abc123\n# branch.head main\n# branch.upstream origin/main\n# branch.ab +3 -0\n\0'
  const result = parseStatusPorcelainV2Z(out, '/repo')
  assert.equal(result.ahead, 3)
  assert.equal(result.behind, 0)
})

test('parseStatusPorcelainV2Z leaves ahead/behind undefined with NO upstream (no # branch.ab)', () => {
  // A local-only branch: git omits branch.upstream and branch.ab entirely.
  const out = '# branch.oid abc123\n# branch.head local-only\n\0'
  const result = parseStatusPorcelainV2Z(out, '/repo')
  assert.equal(result.ahead, undefined)
  assert.equal(result.behind, undefined)
})

test('parseStatusPorcelainV2Z carries ahead/behind alongside a dirty working tree', () => {
  // ahead/behind are orthogonal to the file changes: both must survive.
  const out = '# branch.oid abc123\n# branch.head main\n# branch.upstream origin/main\n# branch.ab +1 -2\n\0'
    + '1 .M N... 100644 100644 100644 h1 h2 src/app.ts\0'
  const result = parseStatusPorcelainV2Z(out, '/repo')
  assert.equal(result.ahead, 1)
  assert.equal(result.behind, 2)
  assert.equal(result.status, 'modified')
})

test('parseStatusPorcelainV2Z reports short SHA for detached HEAD', () => {
  const out = '# branch.oid abcdef0123456789\n# branch.head (detached)\n\0'
  const result = parseStatusPorcelainV2Z(out, '/repo')
  assert.equal(result.branch, 'abcdef0')
})

test('parseStatusPorcelainV2Z emits an untracked file row with status=?', () => {
  // "? path\0" — a single NUL-terminated untracked record.
  const out = '? newfile.md\0'
  const result = parseStatusPorcelainV2Z(out, '/repo')
  assert.equal(result.files.length, 1)
  assert.equal(result.files[0].filename, 'newfile.md')
  assert.equal(result.files[0].status, '?')
  assert.equal(result.files[0].changeType, 'untracked')
  assert.equal(result.status, 'added')
})

test('parseStatusPorcelainV2Z emits TWO rows when both index and worktree are non-clean', () => {
  // "1 MM N... 100644 100644 100644 hash1 hash2 src/app.ts\0"
  // — index 'M' AND worktree 'M' → one staged + one unstaged row.
  const out = '1 MM N... 100644 100644 100644 hash1 hash2 src/app.ts\0'
  const result = parseStatusPorcelainV2Z(out, '/repo')
  assert.equal(result.files.length, 2)
  const staged = result.files.find((f) => f.changeType === 'staged')
  const unstaged = result.files.find((f) => f.changeType === 'unstaged')
  assert.ok(staged, 'expected a staged row')
  assert.ok(unstaged, 'expected an unstaged row')
  assert.equal(staged?.filename, 'src/app.ts')
  assert.equal(unstaged?.filename, 'src/app.ts')
  assert.equal(staged?.status, 'M')
  assert.equal(unstaged?.status, 'M')
})

test('parseStatusPorcelainV2Z emits only one row when only worktree side is dirty', () => {
  // "1 .M N... ..." — index clean, worktree modified.
  const out = '1 .M N... 100644 100644 100644 hash1 hash2 docs/readme.md\0'
  const result = parseStatusPorcelainV2Z(out, '/repo')
  assert.equal(result.files.length, 1)
  assert.equal(result.files[0].changeType, 'unstaged')
  assert.equal(result.files[0].status, 'M')
  assert.equal(result.files[0].filename, 'docs/readme.md')
})

test('parseStatusPorcelainV2Z handles rename: type-2 record uses two NUL slots', () => {
  // "2 R. N... 100644 100644 100644 hash1 hash2 R100 newName.md\0oldName.md\0"
  const out = '2 R. N... 100644 100644 100644 hash1 hash2 R100 newName.md\0oldName.md\0'
  const result = parseStatusPorcelainV2Z(out, '/repo')
  assert.equal(result.files.length, 1)
  const renamed = result.files[0]
  assert.equal(renamed.filename, 'newName.md')
  assert.equal(renamed.originalFilename, 'oldName.md')
  assert.equal(renamed.status, 'R')
})

test('parseStatusPorcelainV2Z carries submoduleFlags through to the row', () => {
  // sub field starts at offset 5: S<c><m><u>. Here: SC.. → commitChanged=true
  const out = '1 .M SC.. 160000 160000 160000 hash1 hash2 modules/x\0'
  const result = parseStatusPorcelainV2Z(out, '/repo')
  assert.equal(result.files.length, 1)
  assert.equal(result.files[0].isSubmoduleEntry, true)
  assert.deepEqual(result.files[0].submoduleFlags, {
    commitChanged: true,
    workTreeModified: false,
    untrackedContent: false
  })
})

test('parseStatusPorcelainV2Z marks unmerged (u) rows with status=! changeType=conflict', () => {
  // u XY N... mH mI mW hH hI hO path
  // type 'u' has 10 leading whitespace-separated fields before the path.
  const out = 'u UU N... 100644 100644 100644 100644 hashH hashI hashO conflict.txt\0'
  const result = parseStatusPorcelainV2Z(out, '/repo')
  assert.equal(result.files.length, 1)
  assert.equal(result.files[0].status, '!')
  assert.equal(result.files[0].changeType, 'conflict')
  assert.equal(result.files[0].filename, 'conflict.txt')
  assert.equal(result.status, 'modified')
})

test('parseStatusPorcelainV2Z status aggregation: untracked + modified across files → mixed', () => {
  // {add (untracked), mod} = two distinct categories → the blue mixed bucket.
  // (Pre-5-state this collapsed to "added"; the new split is the whole point.)
  const out = '? untracked.md\0' + '1 .M N... 100644 100644 100644 a b modified.md\0'
  const result = parseStatusPorcelainV2Z(out, '/repo')
  assert.equal(result.status, 'mixed')
})

test('parseStatusPorcelainV2Z status aggregation: untracked-only → added', () => {
  const out = '? a.md\0' + '? b.md\0'
  const result = parseStatusPorcelainV2Z(out, '/repo')
  assert.equal(result.status, 'added')
})

test('parseStatusPorcelainV2Z status aggregation: modified-only → modified', () => {
  const out = '1 .M N... 100644 100644 100644 a b modified.md\0'
  const result = parseStatusPorcelainV2Z(out, '/repo')
  assert.equal(result.status, 'modified')
})

test('parseStatusPorcelainV2Z status aggregation: worktree-delete only → deleted', () => {
  // "1 .D ..." — tracked file removed from the worktree → red deleted bucket.
  const out = '1 .D N... 100644 100644 000000 a 0000000 gone.md\0'
  const result = parseStatusPorcelainV2Z(out, '/repo')
  assert.equal(result.status, 'deleted')
  // The file row is still emitted for the worktree (unstaged) side.
  assert.equal(result.files.length, 1)
  assert.equal(result.files[0].status, 'D')
  assert.equal(result.files[0].changeType, 'unstaged')
})

test('parseStatusPorcelainV2Z status aggregation: staged-delete only → deleted', () => {
  const out = '1 D. N... 100644 000000 000000 a 0000000 staged-gone.md\0'
  const result = parseStatusPorcelainV2Z(out, '/repo')
  assert.equal(result.status, 'deleted')
})

test('parseStatusPorcelainV2Z status aggregation: add + delete across files → mixed', () => {
  const out = '1 A. N... 000000 100644 100644 0 b added.md\0' + '1 .D N... 100644 100644 000000 a 0 gone.md\0'
  const result = parseStatusPorcelainV2Z(out, '/repo')
  assert.equal(result.status, 'mixed')
})

test('parseStatusPorcelainV2Z status aggregation: rename counts as add, not modify', () => {
  // A lone rename is the new path appearing → added (purple), not mixed.
  const out = '2 R. N... 100644 100644 100644 hash1 hash2 R100 newName.md\0oldName.md\0'
  const result = parseStatusPorcelainV2Z(out, '/repo')
  assert.equal(result.status, 'added')
})

test('parseStatusPorcelainV2Z status aggregation: unmerged conflict → modified (not add/delete)', () => {
  const out = 'u UU N... 100644 100644 100644 100644 hH hI hO conflict.txt\0'
  const result = parseStatusPorcelainV2Z(out, '/repo')
  assert.equal(result.status, 'modified')
})

test('parseStatusPorcelainV2Z status aggregation: a lone two-sided file (MD) → mixed', () => {
  // One file, staged modify + worktree delete → contributes BOTH mod and del,
  // so the repo resolves to mixed even though it is a single record.
  const out = '1 MD N... 100644 100644 000000 a b two-sided.md\0'
  const result = parseStatusPorcelainV2Z(out, '/repo')
  assert.equal(result.status, 'mixed')
  // Still emits a staged row + an unstaged row for the same path.
  assert.equal(result.files.length, 2)
})

test('parseStatusPorcelainV2Z status aggregation: a lone new-then-edited file (AM) → added (not mixed)', () => {
  // staged add + worktree modify of a NEW file stays added — the path is new.
  const out = '1 AM N... 000000 100644 100644 0 b new-edited.md\0'
  const result = parseStatusPorcelainV2Z(out, '/repo')
  assert.equal(result.status, 'added')
})
