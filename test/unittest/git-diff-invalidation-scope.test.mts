/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 *
 * Usage: node --experimental-strip-types --test test/unittest/git-diff-invalidation-scope.test.mts
 *
 * Pins the file-scoped invalidation surface of the 2026-07-16 revert-scope
 * fix at two layers:
 *
 *   1. `cacheKeyMatchesFiles` — the pure predicate that decides which content
 *      cache entries belong to a known single-file mutation (matches the
 *      filename or a rename's original, across every changeType variant).
 *
 *   2. `GitDiffInvalidationDetail` fan-out — the invalidator must pass the
 *      detail through to every listener verbatim, and keep emitting the
 *      legacy (cwd, reason) shape when no detail is supplied.
 */

import assert from 'node:assert/strict'
import { resolve } from 'node:path'
import { test } from 'node:test'
import { buildCacheKey, cacheKeyMatchesFiles } from '../../electron/main/git-diff-content-cache-state.ts'
import {
  gitDiffCacheInvalidator,
  normaliseGitDiffInvalidationTargets,
  type GitDiffInvalidationDetail,
  type GitDiffInvalidationReason
} from '../../electron/main/git-diff-cache-invalidator.ts'

const key = (changeType: string, status: string, filename: string, originalFilename?: string) =>
  buildCacheKey({ changeType, status, filename, originalFilename } as Parameters<typeof buildCacheKey>[0])

test('IVS-01 predicate matches every changeType/status variant of the target path', () => {
  const files: ReadonlySet<string> = new Set(['beta.txt'])
  assert.equal(cacheKeyMatchesFiles(key('unstaged', 'M', 'beta.txt'), files), true)
  assert.equal(cacheKeyMatchesFiles(key('staged', 'M', 'beta.txt'), files), true)
  assert.equal(cacheKeyMatchesFiles(key('untracked', '?', 'beta.txt'), files), true)
  assert.equal(cacheKeyMatchesFiles(key('unstaged', 'M', 'alpha.txt'), files), false)
  assert.equal(cacheKeyMatchesFiles(key('unstaged', 'M', 'nested/beta.txt'), files), false)
})

test('IVS-02 predicate matches a rename entry through its ORIGINAL filename', () => {
  const files: ReadonlySet<string> = new Set(['old-name.txt'])
  assert.equal(cacheKeyMatchesFiles(key('staged', 'R', 'new-name.txt', 'old-name.txt'), files), true)
  assert.equal(cacheKeyMatchesFiles(key('staged', 'R', 'new-name.txt', 'other.txt'), files), false)
})

test('IVS-03 predicate survives filenames that contain the :: separator', () => {
  const weird = 'weird::name.txt'
  assert.equal(cacheKeyMatchesFiles(key('unstaged', 'M', weird), new Set([weird])), true)
  assert.equal(cacheKeyMatchesFiles(key('unstaged', 'M', weird), new Set(['name.txt'])), false)
})

test('IVS-04 invalidator passes the files detail through to listeners verbatim', () => {
  const seen: Array<{ cwd: string; reason: GitDiffInvalidationReason; detail?: GitDiffInvalidationDetail }> = []
  const off = gitDiffCacheInvalidator.addListener((cwd, reason, detail) => {
    seen.push({ cwd, reason, detail })
  })
  try {
    gitDiffCacheInvalidator.invalidate('/tmp/ivs-repo', 'manual', { files: ['a.txt', 'b.txt'] })
    gitDiffCacheInvalidator.invalidate('/tmp/ivs-repo', 'manual')
    gitDiffCacheInvalidator.invalidate('/tmp/ivs-repo', 'mirror')
  } finally {
    off()
  }
  assert.equal(seen.length, 3)
  assert.deepEqual(seen[0].detail, { files: ['a.txt', 'b.txt'] })
  assert.equal(seen[0].reason, 'manual')
  assert.equal(seen[1].detail, undefined)
  assert.equal(seen[2].detail, undefined)
  assert.equal(seen[2].reason, 'mirror')
})

test('IVS-05 equivalent native path spellings produce one invalidation target', () => {
  const nativePath = resolve('test', 'autotest', 'fixtures', 'ivs-repo')
  const equivalentPath = process.platform === 'win32'
    ? nativePath.replace(/\\/g, '/')
    : `${nativePath}/.`

  assert.notEqual(equivalentPath, nativePath)
  assert.deepEqual(normaliseGitDiffInvalidationTargets([nativePath, equivalentPath]), [nativePath])
})

test('IVS-06 a repository subdirectory and root remain distinct targets', () => {
  const repoRoot = resolve('test', 'autotest', 'fixtures', 'ivs-repo')
  const nestedCwd = resolve(repoRoot, 'nested')

  assert.deepEqual(normaliseGitDiffInvalidationTargets([nestedCwd, repoRoot]), [nestedCwd, repoRoot])
})

test('IVS-07 empty and duplicate targets are removed without losing cwd', () => {
  const cwd = resolve('test', 'autotest', 'fixtures', 'ivs-repo')

  assert.deepEqual(normaliseGitDiffInvalidationTargets([null, undefined, '', cwd, cwd]), [cwd])
})
