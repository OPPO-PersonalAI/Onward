/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Structural-freshness token helpers for GitRepositorySnapshotService.
 *
 * A repo's STRUCTURE (which submodules / gitlinks exist) can only change
 * through files this module enumerates:
 *   - `<root>/.gitmodules`            — declared submodule set
 *   - `<root>/.git/index`             — gitlink (mode 160000) entries live in
 *                                       the index; `git add` of a nested repo
 *                                       changes it (the no-`.gitmodules`
 *                                       winWatchRTOS class)
 *   - per known submodule:
 *       `<sub>/.gitmodules`           — nested declarations
 *       `<sub>/<gitdir>/index`        — nested gitlinks
 *
 * Stat-ing this closed set (`mtimeMs:size` each, zero git spawns) is a
 * complete freshness signal for the snapshot: ordinary working-tree churn —
 * the 99.9% case that fires mirror invalidations every couple of minutes
 * under an agent workload — touches none of these files, so the snapshot
 * (and its `git ls-files` spawn, ~5 s under EDR) is reused instead of
 * recaptured. Any structural edit changes at least one component token.
 *
 * Leaf module (fs/path only) so plain-Node unit tests can load it without
 * the git-utils / performance-trace module graph.
 */

import { stat, readFile } from 'fs/promises'
import { join, resolve, isAbsolute } from 'path'

/** `mtimeMs:size` for an existing file; 'none' when absent/unreadable. */
export async function statToken(filePath: string): Promise<string> {
  try {
    const info = await stat(filePath)
    return `${Math.floor(info.mtimeMs)}:${info.size}`
  } catch {
    return 'none'
  }
}

/**
 * Resolve the on-disk index file for a repo working tree. `<repo>/.git` is
 * either a directory (index at `.git/index`) or a `gitdir: <path>` gitfile
 * (submodule form; relative paths resolve against the repo). Returns null
 * when `.git` is absent (deinit-ed submodule) — the caller records the
 * sentinel so a later (re)init changes the token.
 */
export async function resolveGitIndexPath(repoAbsPath: string): Promise<string | null> {
  const dotGit = join(repoAbsPath, '.git')
  try {
    const info = await stat(dotGit)
    if (info.isDirectory()) return join(dotGit, 'index')
  } catch {
    return null
  }
  try {
    const content = await readFile(dotGit, 'utf8')
    const match = /^gitdir:\s*(.+)\s*$/m.exec(content)
    if (!match) return null
    const gitdir = match[1].trim()
    const abs = isAbsolute(gitdir) ? gitdir : resolve(repoAbsPath, gitdir)
    return join(abs, 'index')
  } catch {
    return null
  }
}

/**
 * Enumerate every file whose stat participates in the structural token.
 * Resolved ONCE at capture time and stored with the cache entry; the
 * per-get revalidation only stats the stored list. A `.git` that changes
 * shape later (dir ↔ gitfile, deinit) stats to 'none' → token mismatch →
 * recapture re-resolves.
 */
export async function collectStructuralTokenTargets(
  repoRoot: string,
  submoduleAbsPaths: string[]
): Promise<string[]> {
  const targets: string[] = [join(repoRoot, '.gitmodules')]
  const rootIndex = await resolveGitIndexPath(repoRoot)
  targets.push(rootIndex ?? join(repoRoot, '.git', 'index'))
  for (const sub of submoduleAbsPaths) {
    targets.push(join(sub, '.gitmodules'))
    const subIndex = await resolveGitIndexPath(sub)
    // Missing gitdir (deinit-ed) records the conventional path as the
    // sentinel: it stats to 'none' now and changes when the sub is
    // (re)initialised.
    targets.push(subIndex ?? join(sub, '.git', 'index'))
  }
  return targets
}

/** Combined token over the target list. Order-sensitive by construction. */
export async function readStructuralToken(targets: string[]): Promise<string> {
  const tokens = await Promise.all(targets.map((t) => statToken(t)))
  return tokens.join('|')
}
