/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 *
 * Usage: node --experimental-strip-types --test test/unittest/git-state-mirror-refs-digest.test.mts
 *
 * Locks the spawn-free `.git/refs` digest that feeds the L8 History list cache's
 * second freshness signal (refsDigest). Builds REAL temp .git-shaped ref trees on
 * disk (no git binary needed) and asserts: a ref-only move flips the digest (the
 * push scenario), tags ARE included (they render as `%D` decorations too), loose
 * overrides packed, and a linked worktree's gitDir resolves refs through its
 * `commondir`.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { buildMirrorRefsDigest } from '../../electron/main/git-state-mirror-refs-digest.ts'

const OID_A = '1111111111111111111111111111111111111111'
const OID_B = '2222222222222222222222222222222222222222'
const OID_C = '3333333333333333333333333333333333333333'

async function mkGitDir(): Promise<string> {
  return await fs.mkdtemp(join(tmpdir(), 'onward-refsdigest-'))
}

async function writeRef(gitDir: string, refName: string, oid: string): Promise<void> {
  const full = join(gitDir, refName)
  await fs.mkdir(dirname(full), { recursive: true })
  await fs.writeFile(full, `${oid}\n`)
}

async function writePackedRefs(gitDir: string, lines: string[]): Promise<void> {
  await fs.writeFile(join(gitDir, 'packed-refs'), `# pack-refs with: peeled fully-peeled sorted\n${lines.join('\n')}\n`)
}

async function rmrf(dir: string): Promise<void> {
  await fs.rm(dir, { recursive: true, force: true })
}

test('refsDigest is stable + order-independent for the same ref set', async () => {
  const a = await mkGitDir()
  const b = await mkGitDir()
  try {
    // Same refs, created in DIFFERENT order across two dirs → identical digest.
    await writeRef(a, 'refs/heads/main', OID_A)
    await writeRef(a, 'refs/remotes/origin/main', OID_B)
    await writeRef(b, 'refs/remotes/origin/main', OID_B)
    await writeRef(b, 'refs/heads/main', OID_A)
    const da = (await buildMirrorRefsDigest(a)).digest
    const db = (await buildMirrorRefsDigest(b)).digest
    assert.equal(da, db)
  } finally {
    await rmrf(a); await rmrf(b)
  }
})

test('a remote-tracking ref move (push) flips the digest while HEAD/branch are untouched', async () => {
  const g = await mkGitDir()
  try {
    await writeRef(g, 'refs/heads/main', OID_A)
    await writeRef(g, 'refs/remotes/origin/main', OID_A) // pre-push: origin behind
    const before = (await buildMirrorRefsDigest(g)).digest
    // `git push` advances ONLY origin/main; refs/heads/main (HEAD) is unchanged.
    await writeRef(g, 'refs/remotes/origin/main', OID_B)
    const after = (await buildMirrorRefsDigest(g)).digest
    assert.notEqual(before, after)
  } finally {
    await rmrf(g)
  }
})

test('tags ARE included — adding a tag changes the digest (decoration freshness for refs/tags)', async () => {
  const g = await mkGitDir()
  try {
    await writeRef(g, 'refs/heads/main', OID_A)
    const before = (await buildMirrorRefsDigest(g)).digest
    await writeRef(g, 'refs/tags/v1.0', OID_C) // a tag — now in scope (renders as %D)
    const after = (await buildMirrorRefsDigest(g)).digest
    assert.notEqual(before, after)
    assert.equal((await buildMirrorRefsDigest(g)).refCount, 2) // head + tag
  } finally {
    await rmrf(g)
  }
})

test('a loose ref OVERRIDES its packed-refs entry (git resolution semantics)', async () => {
  const looseWins = await mkGitDir()
  const packedOnly = await mkGitDir()
  try {
    // looseWins: packed says origin/main=A, but a loose file says origin/main=B.
    await writePackedRefs(looseWins, [`${OID_A} refs/remotes/origin/main`])
    await writeRef(looseWins, 'refs/remotes/origin/main', OID_B)
    // packedOnly: packed says origin/main=B, no loose file.
    await writePackedRefs(packedOnly, [`${OID_B} refs/remotes/origin/main`])
    const d1 = (await buildMirrorRefsDigest(looseWins)).digest
    const d2 = (await buildMirrorRefsDigest(packedOnly)).digest
    assert.equal(d1, d2) // both resolve origin/main → B
  } finally {
    await rmrf(looseWins); await rmrf(packedOnly)
  }
})

test('packed-refs comment (#) and peeled (^) lines are skipped (tag ref kept, its peeled line dropped)', async () => {
  const g = await mkGitDir()
  try {
    await writePackedRefs(g, [
      `${OID_A} refs/heads/main`,
      `${OID_C} refs/tags/v1.0`, // annotated tag object oid (a real, in-scope ref)
      `^${OID_B}`               // the tag's peeled commit → must be skipped
    ])
    const fromPacked = (await buildMirrorRefsDigest(g)).digest
    // SAME logical {head=A, tag=C} expressed as loose files → identical digest:
    // proves the `#`/`^` lines were skipped and the tag oid (C, not the peeled B)
    // was recorded, AND that packed ≡ loose for the same set.
    const g2 = await mkGitDir()
    try {
      await writeRef(g2, 'refs/heads/main', OID_A)
      await writeRef(g2, 'refs/tags/v1.0', OID_C)
      assert.equal(fromPacked, (await buildMirrorRefsDigest(g2)).digest)
    } finally {
      await rmrf(g2)
    }
  } finally {
    await rmrf(g)
  }
})

test('linked-worktree gitDir resolves refs through its commondir', async () => {
  const commonDir = await mkGitDir()
  const worktreeGitDir = await mkGitDir()
  try {
    // The shared common .git holds the refs.
    await writeRef(commonDir, 'refs/heads/main', OID_A)
    await writeRef(commonDir, 'refs/remotes/origin/main', OID_B)
    // The linked worktree's gitDir only has a `commondir` pointer (absolute here).
    await fs.writeFile(join(worktreeGitDir, 'commondir'), `${commonDir}\n`)
    const viaWorktree = (await buildMirrorRefsDigest(worktreeGitDir)).digest
    const viaCommon = (await buildMirrorRefsDigest(commonDir)).digest
    assert.equal(viaWorktree, viaCommon) // worktree must see the shared refs
  } finally {
    await rmrf(commonDir); await rmrf(worktreeGitDir)
  }
})

test('empty ref set yields a stable digest (brand-new repo, no branches/remotes)', async () => {
  const a = await mkGitDir()
  const b = await mkGitDir()
  try {
    const da = (await buildMirrorRefsDigest(a)).digest
    const db = (await buildMirrorRefsDigest(b)).digest
    assert.equal(da, db)
    assert.equal((await buildMirrorRefsDigest(a)).refCount, 0)
  } finally {
    await rmrf(a); await rmrf(b)
  }
})
