/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 *
 * Usage: node --experimental-strip-types --test test/unittest/git-snapshot-structural-token.test.mts
 *
 * Locks the G2 structural-token contract (2026-07-04 spinner analysis): the
 * snapshot cache's freshness signal must be a CLOSED set of stat targets
 * (root .gitmodules + root index + per-submodule pair), so ordinary
 * working-tree churn keeps the snapshot (and skips the `git ls-files`
 * respawn) while any structural edit — declared-set change, staged gitlink,
 * deinit — flips the token. Real fs in the OS temp dir, no git spawns.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  statToken,
  resolveGitIndexPath,
  collectStructuralTokenTargets,
  readStructuralToken
} from '../../electron/main/git-snapshot-structural-token.ts'

function makeTempRepo(): { root: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), 'onward-structural-token-'))
  return {
    root,
    cleanup: () => {
      try { rmSync(root, { recursive: true, force: true }) } catch { /* transient AV lock — temp dir GC covers it */ }
    }
  }
}

test('statToken: none for a missing file, mtime:size for an existing one, changes on rewrite', async () => {
  const { root, cleanup } = makeTempRepo()
  try {
    const target = join(root, '.gitmodules')
    assert.equal(await statToken(target), 'none')
    writeFileSync(target, '[submodule "a"]\n', 'utf8')
    const first = await statToken(target)
    assert.notEqual(first, 'none')
    writeFileSync(target, '[submodule "a"]\n[submodule "b"]\n', 'utf8')
    const second = await statToken(target)
    assert.notEqual(second, first, 'size change must flip the token')
  } finally {
    cleanup()
  }
})

test('resolveGitIndexPath: .git directory form → .git/index', async () => {
  const { root, cleanup } = makeTempRepo()
  try {
    mkdirSync(join(root, '.git'))
    assert.equal(await resolveGitIndexPath(root), join(root, '.git', 'index'))
  } finally {
    cleanup()
  }
})

test('resolveGitIndexPath: gitfile form resolves relative gitdir against the repo', async () => {
  const { root, cleanup } = makeTempRepo()
  try {
    const sub = join(root, 'modules', 'sub')
    mkdirSync(sub, { recursive: true })
    mkdirSync(join(root, '.git', 'modules', 'sub'), { recursive: true })
    writeFileSync(join(sub, '.git'), 'gitdir: ../../.git/modules/sub\n', 'utf8')
    assert.equal(await resolveGitIndexPath(sub), join(root, '.git', 'modules', 'sub', 'index'))
  } finally {
    cleanup()
  }
})

test('resolveGitIndexPath: missing .git (deinit-ed submodule) → null', async () => {
  const { root, cleanup } = makeTempRepo()
  try {
    assert.equal(await resolveGitIndexPath(root), null)
  } finally {
    cleanup()
  }
})

test('working-tree churn does NOT flip the combined token; index / .gitmodules edits DO', async () => {
  const { root, cleanup } = makeTempRepo()
  try {
    mkdirSync(join(root, '.git'))
    writeFileSync(join(root, '.git', 'index'), 'index-v1', 'utf8')
    writeFileSync(join(root, 'src.txt'), 'ordinary content v1', 'utf8')

    const targets = await collectStructuralTokenTargets(root, [])
    const baseline = await readStructuralToken(targets)

    // Ordinary working-tree churn (the agent-workload case) — token stable.
    writeFileSync(join(root, 'src.txt'), 'ordinary content v2 with more bytes', 'utf8')
    assert.equal(await readStructuralToken(targets), baseline)

    // A staged gitlink / any index write — token flips.
    writeFileSync(join(root, '.git', 'index'), 'index-v2 longer', 'utf8')
    const afterIndex = await readStructuralToken(targets)
    assert.notEqual(afterIndex, baseline)

    // A .gitmodules edit — token flips again.
    writeFileSync(join(root, '.gitmodules'), '[submodule "new"]\n', 'utf8')
    assert.notEqual(await readStructuralToken(targets), afterIndex)
  } finally {
    cleanup()
  }
})

test('per-submodule targets: a nested .gitmodules or nested index edit flips the token', async () => {
  const { root, cleanup } = makeTempRepo()
  try {
    mkdirSync(join(root, '.git'))
    writeFileSync(join(root, '.git', 'index'), 'root-index', 'utf8')
    const sub = join(root, 'modules', 'sub')
    mkdirSync(join(sub, '.git'), { recursive: true })
    writeFileSync(join(sub, '.git', 'index'), 'sub-index-v1', 'utf8')

    const targets = await collectStructuralTokenTargets(root, [sub])
    assert.equal(targets.length, 4, 'root pair + one submodule pair')
    const baseline = await readStructuralToken(targets)

    writeFileSync(join(sub, '.git', 'index'), 'sub-index-v2 longer', 'utf8')
    const afterSubIndex = await readStructuralToken(targets)
    assert.notEqual(afterSubIndex, baseline, 'nested gitlink staging must be visible')

    writeFileSync(join(sub, '.gitmodules'), '[submodule "inner"]\n', 'utf8')
    assert.notEqual(await readStructuralToken(targets), afterSubIndex, 'nested declaration must be visible')
  } finally {
    cleanup()
  }
})

test('deinit sentinel: a submodule without .git records the conventional index path, and re-init flips the token', async () => {
  const { root, cleanup } = makeTempRepo()
  try {
    mkdirSync(join(root, '.git'))
    writeFileSync(join(root, '.git', 'index'), 'root-index', 'utf8')
    const sub = join(root, 'modules', 'sub')
    mkdirSync(sub, { recursive: true }) // deinit-ed: no .git at all

    const targets = await collectStructuralTokenTargets(root, [sub])
    const baseline = await readStructuralToken(targets)

    mkdirSync(join(sub, '.git'), { recursive: true })
    writeFileSync(join(sub, '.git', 'index'), 'freshly initialised', 'utf8')
    assert.notEqual(await readStructuralToken(targets), baseline, '(re)init must flip the token')
  } finally {
    cleanup()
  }
})
