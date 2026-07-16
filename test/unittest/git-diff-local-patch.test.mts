/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 *
 * Usage: node --experimental-strip-types --test test/unittest/git-diff-local-patch.test.mts
 *
 * Pins the optimistic local-patch table applied to the Git Diff file list
 * after a known single-file mutation (2026-07-16 revert-scope fix). The table
 * must be CONSERVATIVE: any case it cannot fully derive returns null (caller
 * reconciles with a real reload). A wrong optimistic row renders a wrong diff
 * until reconcile; a null merely costs one list recompute.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { GitDiffResult, GitFileStatus, GitChangeType, GitStatusCode } from '../../src/types/electron.d.ts'
import { applyFileActionToDiffResult } from '../../src/components/GitDiffViewer/gitDiffLocalPatch.ts'
import { makeGitFileStatus } from '../../electron/main/git-porcelain-parse.ts'

function row(
  filename: string,
  changeType: GitChangeType,
  status: GitStatusCode,
  extra: Partial<GitFileStatus> = {}
): GitFileStatus {
  const base = makeGitFileStatus({ filename, changeType, status, repoRoot: '/repo' })
  return { ...base, ...extra }
}

function parserRow(filename: string, changeType: GitChangeType, status: GitStatusCode): GitFileStatus {
  return makeGitFileStatus({ filename, changeType, status, repoRoot: '/repo' })
}

function result(files: GitFileStatus[], overrides: Partial<GitDiffResult> = {}): GitDiffResult {
  return {
    success: true,
    cwd: '/repo',
    isGitRepo: true,
    gitInstalled: true,
    files,
    ...overrides
  }
}

const names = (r: GitDiffResult | null) => (r ? r.files.map((f) => `${f.changeType}:${f.status}:${f.filename}`) : null)

test('GLP-01 discard on an unstaged modification removes the row', () => {
  const beta = row('beta.txt', 'unstaged', 'M')
  const r = result([row('alpha.txt', 'unstaged', 'M'), beta, row('gamma.txt', 'unstaged', 'M')])
  const patched = applyFileActionToDiffResult(r, beta, 'discard')
  assert.deepEqual(names(patched), ['unstaged:M:alpha.txt', 'unstaged:M:gamma.txt'])
  // The input result must not be mutated (optimistic copy).
  assert.equal(r.files.length, 3)
})

test('GLP-02 discard on an untracked file removes the row', () => {
  const nu = row('new.txt', 'untracked', '?')
  const r = result([nu, row('alpha.txt', 'unstaged', 'M')])
  const patched = applyFileActionToDiffResult(r, nu, 'discard')
  assert.deepEqual(names(patched), ['unstaged:M:alpha.txt'])
})

test('GLP-03 discard (unstage) on a staged modification moves it back to the worktree with parser-identical refs', () => {
  const staged = row('alpha.txt', 'staged', 'M')
  const r = result([staged])
  const patched = applyFileActionToDiffResult(r, staged, 'discard')
  assert.ok(patched)
  const moved = patched!.files[0]
  assert.equal(moved.changeType, 'unstaged')
  assert.equal(moved.status, 'M')
  // Lockstep check: the migrated row's group/refs must equal what the main
  // parser would produce for the same (changeType, status).
  const expected = parserRow('alpha.txt', 'unstaged', 'M')
  assert.equal(moved.resourceGroup, expected.resourceGroup)
  assert.equal(moved.originalRef, expected.originalRef)
  assert.equal(moved.modifiedRef, expected.modifiedRef)
})

test('GLP-04 discard (unstage) on a staged addition becomes untracked', () => {
  const stagedNew = row('brand-new.txt', 'staged', 'A')
  const r = result([stagedNew])
  const patched = applyFileActionToDiffResult(r, stagedNew, 'discard')
  assert.ok(patched)
  const moved = patched!.files[0]
  assert.equal(moved.changeType, 'untracked')
  assert.equal(moved.status, '?')
  const expected = parserRow('brand-new.txt', 'untracked', '?')
  assert.equal(moved.resourceGroup, expected.resourceGroup)
  assert.equal(moved.originalRef, expected.originalRef)
  assert.equal(moved.modifiedRef, expected.modifiedRef)
})

test('GLP-05 discard (unstage) with a worktree twin returns null (git must merge the rows)', () => {
  const staged = row('alpha.txt', 'staged', 'M')
  const twin = row('alpha.txt', 'unstaged', 'M')
  const r = result([staged, twin])
  assert.equal(applyFileActionToDiffResult(r, staged, 'discard'), null)
})

test('GLP-06 stage on an unstaged modification migrates to staged with parser-identical refs', () => {
  const beta = row('beta.txt', 'unstaged', 'M')
  const r = result([beta])
  const patched = applyFileActionToDiffResult(r, beta, 'stage')
  assert.ok(patched)
  const moved = patched!.files[0]
  assert.equal(moved.changeType, 'staged')
  assert.equal(moved.status, 'M')
  const expected = parserRow('beta.txt', 'staged', 'M')
  assert.equal(moved.resourceGroup, expected.resourceGroup)
  assert.equal(moved.originalRef, expected.originalRef)
  assert.equal(moved.modifiedRef, expected.modifiedRef)
})

test('GLP-07 stage on an untracked file becomes a staged addition', () => {
  const nu = row('new.txt', 'untracked', '?')
  const r = result([nu])
  const patched = applyFileActionToDiffResult(r, nu, 'stage')
  assert.ok(patched)
  const moved = patched!.files[0]
  assert.equal(moved.changeType, 'staged')
  assert.equal(moved.status, 'A')
  const expected = parserRow('new.txt', 'staged', 'A')
  assert.equal(moved.resourceGroup, expected.resourceGroup)
  assert.equal(moved.originalRef, expected.originalRef)
  assert.equal(moved.modifiedRef, expected.modifiedRef)
})

test('GLP-08 stage with an existing staged twin returns null (combined status is git\'s call)', () => {
  const work = row('alpha.txt', 'unstaged', 'M')
  const staged = row('alpha.txt', 'staged', 'M')
  const r = result([work, staged])
  assert.equal(applyFileActionToDiffResult(r, work, 'stage'), null)
})

test('GLP-09 stage on an already-staged row is a list no-op (Keep-staged)', () => {
  const staged = row('alpha.txt', 'staged', 'M')
  const r = result([staged])
  const patched = applyFileActionToDiffResult(r, staged, 'stage')
  assert.equal(patched, r)
})

test('GLP-10 conservative refusals: renames, conflicts, submodules, missing rows, failed results', () => {
  const renamed = row('renamed.txt', 'staged', 'R', { originalFilename: 'old.txt' })
  const conflict = row('conflicted.txt', 'conflict', 'M')
  const submodule = row('sub', 'unstaged', 'M', { isSubmoduleEntry: true })
  const present = row('present.txt', 'unstaged', 'M')
  const missing = row('missing.txt', 'unstaged', 'M')
  const r = result([renamed, conflict, submodule, present])
  assert.equal(applyFileActionToDiffResult(r, renamed, 'discard'), null)
  assert.equal(applyFileActionToDiffResult(r, conflict, 'discard'), null)
  assert.equal(applyFileActionToDiffResult(r, submodule, 'discard'), null)
  assert.equal(applyFileActionToDiffResult(r, missing, 'discard'), null)
  assert.equal(applyFileActionToDiffResult(null, present, 'discard'), null)
  assert.equal(
    applyFileActionToDiffResult(result([present], { success: false }), present, 'discard'),
    null
  )
})

test('GLP-11 same filename in two repos: only the matching repoRoot row is touched', () => {
  const inner = row('shared.txt', 'unstaged', 'M', { repoRoot: '/repo/sub' })
  const outer = row('shared.txt', 'unstaged', 'M', { repoRoot: '/repo' })
  const r = result([inner, outer])
  const patched = applyFileActionToDiffResult(r, outer, 'discard')
  assert.ok(patched)
  assert.equal(patched!.files.length, 1)
  assert.equal(patched!.files[0].repoRoot, '/repo/sub')
})
