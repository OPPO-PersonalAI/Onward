/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash } from 'crypto'
import { promises as fs } from 'fs'
import { isAbsolute, join, resolve } from 'path'

export interface MirrorRefsDigestResult {
  digest: string
  refCount: number
  durationMs: number
}

/**
 * Resolve the git common directory for a (possibly linked-worktree) gitDir.
 *
 * A linked worktree's gitDir is `<main>/.git/worktrees/<name>` and contains a
 * `commondir` file pointing at the shared `.git`; `refs/heads`, `refs/remotes`
 * and `packed-refs` all live in that common dir, NOT in the per-worktree gitDir.
 * Without this resolution a worktree's branch/remote ref moves would be
 * invisible to the digest (this repo is itself a multi-worktree checkout).
 * Returns `gitDir` unchanged when there is no `commondir` (the normal case).
 * Result is forward-slash normalised so refname derivation is platform-stable.
 */
async function resolveCommonDir(gitDir: string): Promise<string> {
  const normGitDir = gitDir.replace(/\\/g, '/')
  try {
    const raw = (await fs.readFile(join(normGitDir, 'commondir'), 'utf8')).trim()
    if (!raw) return normGitDir
    const resolved = isAbsolute(raw) ? raw : resolve(normGitDir, raw)
    return resolved.replace(/\\/g, '/')
  } catch {
    return normGitDir
  }
}

// Every ref that can appear as a DECORATION in the History graph: local
// branches (refs/heads) + remote-tracking refs (refs/remotes) + tags
// (refs/tags). All three render as `%D` labels, so all three must feed the
// freshness digest — otherwise that ref class's label goes stale (the same
// "phantom fork after push" class the digest exists to prevent).
function isTrackedRefName(refName: string): boolean {
  return refName.startsWith('refs/heads/')
    || refName.startsWith('refs/remotes/')
    || refName.startsWith('refs/tags/')
}

// Parse `.git/packed-refs`: skip `#` comment lines and `^<oid>` peeled-tag
// lines; keep `<oid> <refname>` for tracked refs into the map.
async function readPackedRefs(commonDir: string, into: Map<string, string>): Promise<void> {
  let content: string
  try {
    content = await fs.readFile(join(commonDir, 'packed-refs'), 'utf8')
  } catch {
    return // no packed-refs (all loose) — normal
  }
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('^')) continue
    const sp = trimmed.indexOf(' ')
    if (sp <= 0) continue
    const oid = trimmed.slice(0, sp)
    const refName = trimmed.slice(sp + 1).trim()
    if (isTrackedRefName(refName)) into.set(refName, oid)
  }
}

// Walk loose ref files under `<commonDir>/<sub>`; value = trimmed file content
// (an oid, or the raw `ref: <target>` for a symref like refs/remotes/origin/HEAD).
// A loose ref OVERRIDES any same-named packed entry (git resolution semantics).
async function walkLooseRefs(commonDir: string, sub: string, into: Map<string, string>): Promise<void> {
  const prefixLen = commonDir.length + 1 // strip "<commonDir>/" → refname
  const stack: string[] = [join(commonDir, sub)]
  while (stack.length > 0) {
    const dir = stack.pop() as string
    let entries
    try {
      entries = await fs.readdir(dir, { withFileTypes: true })
    } catch {
      continue // sub-tree absent (e.g. no refs/remotes yet) — normal
    }
    for (const ent of entries) {
      const full = join(dir, ent.name).replace(/\\/g, '/')
      if (ent.isDirectory()) {
        stack.push(full)
        continue
      }
      if (!ent.isFile()) continue
      let value: string
      try {
        value = (await fs.readFile(full, 'utf8')).trim()
      } catch {
        continue
      }
      into.set(full.slice(prefixLen), value)
    }
  }
}

/**
 * Spawn-free, order-independent SHA-1 of EVERY decoration-bearing ref: local
 * branches (refs/heads) + remote-tracking refs (refs/remotes) + tags
 * (refs/tags). This is the second freshness signal for the L8 History list
 * cache, a sibling to `branchOid`:
 * a `git push` advances `origin/<branch>` WITHOUT moving HEAD, so `branchOid`
 * is unchanged but this digest moves, re-keying the cache so the `%D` ref
 * decorations recompute instead of going stale for the 30-min TTL.
 *
 * NO git spawn (mirrors `buildMirrorChangeFingerprint`): the digest is recomputed
 * on EVERY mirror recompute — including the always-on 1s/3s reconcile heartbeat
 * that catches watcher-missed ref events — so a per-tick git spawn would be
 * EDR-taxed; a few small `.git/refs` reads stay off that path. git keeps refs
 * packed in steady state, so the common cost is one `packed-refs` read + a
 * handful of loose-ref reads.
 */
export async function buildMirrorRefsDigest(gitDir: string): Promise<MirrorRefsDigestResult> {
  const startedAt = Date.now()
  const commonDir = await resolveCommonDir(gitDir)
  const refs = new Map<string, string>()
  await readPackedRefs(commonDir, refs)
  // loose AFTER packed so a loose ref overrides its packed counterpart.
  await walkLooseRefs(commonDir, 'refs/heads', refs)
  await walkLooseRefs(commonDir, 'refs/remotes', refs)
  await walkLooseRefs(commonDir, 'refs/tags', refs)

  const hash = createHash('sha1')
  const sortedNames = Array.from(refs.keys()).sort()
  for (const refName of sortedNames) {
    hash.update(refName)
    hash.update('\0')
    hash.update(refs.get(refName) as string)
    hash.update('\n')
  }
  return {
    digest: hash.digest('hex'),
    refCount: sortedNames.length,
    durationMs: Date.now() - startedAt
  }
}
