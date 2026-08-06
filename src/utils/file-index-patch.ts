/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Pure incremental-diff application for the project file index.
 *
 * This is the ONLY implementation of "apply an add/remove/rename diff to a
 * path list". It used to exist twice — once in the renderer mirror and once in
 * the main-process worker — with subtly different rules (only one of them
 * consulted the ignore list, only one cascaded directory prefixes on rename).
 * Two implementations of the same rule is how the two caches drifted apart in
 * the first place, so the rule now lives here and both sides import it.
 *
 * Deliberately dependency-free: no Electron, no DOM, no fs. That keeps it
 * importable from a worker thread AND unit-testable in plain Node.
 */

export interface FileIndexRename {
  from: string
  to: string
}

export interface FileIndexPatchInput {
  added?: string[]
  removed?: string[]
  renamed?: FileIndexRename[]
}

export interface FileIndexPatchOutcome {
  files: string[]
  fileSet: Set<string>
  /** Whether the file SET actually moved, as opposed to merely being touched. */
  changed: boolean
}

/**
 * Normalise a relative path into the index's canonical form: forward slashes,
 * no leading `./` or `/`. Returns null for anything that normalises to empty.
 *
 * Windows watchers and Windows in-app mutations deliver `\`-separated paths, so
 * skipping this step would file `src\foo.ts` alongside `src/foo.ts` and make
 * membership checks miss.
 */
export function normalizeIndexRel(relPath: unknown): string | null {
  if (typeof relPath !== 'string') return null
  const normalized = relPath
    .replace(/\\/g, '/')
    .replace(/^\.\//, '')
    .replace(/^\/+/, '')
    .replace(/\/+$/, '')
  return normalized.length > 0 ? normalized : null
}

/**
 * Apply a diff to an index snapshot, returning a new snapshot.
 *
 * Ordering is significant and deliberate:
 *   1. removals (cascading to directory contents),
 *   2. renames (also cascading, so renaming a directory rewrites its subtree),
 *   3. additions (deduped against the post-removal membership set).
 *
 * Doing additions last means a delete-then-recreate arriving in one batch
 * settles as "present", which matches what the filesystem actually ends up
 * looking like.
 *
 * `isIgnored` gates additions with the SAME predicate that shaped the original
 * walk. Without it an incremental add could smuggle in a path the build
 * deliberately skipped, so the index contents would depend on whether a
 * rebuild happened to have run recently.
 */
export function applyFileIndexPatch(
  files: readonly string[],
  patch: FileIndexPatchInput,
  isIgnored: (rel: string) => boolean = () => false
): FileIndexPatchOutcome {
  let nextFiles = files.slice()
  let changed = false

  for (const raw of patch.removed ?? []) {
    const rel = normalizeIndexRel(raw)
    if (!rel) continue
    const prefix = `${rel}/`
    const before = nextFiles.length
    nextFiles = nextFiles.filter((file) => file !== rel && !file.startsWith(prefix))
    if (nextFiles.length !== before) changed = true
  }

  for (const pair of patch.renamed ?? []) {
    const from = normalizeIndexRel(pair?.from)
    const to = normalizeIndexRel(pair?.to)
    if (!from || !to || from === to) continue
    const prefix = `${from}/`
    nextFiles = nextFiles.map((file) => {
      if (file === from) {
        changed = true
        return to
      }
      if (file.startsWith(prefix)) {
        changed = true
        return to + file.slice(from.length)
      }
      return file
    })
  }

  const fileSet = new Set(nextFiles)

  for (const raw of patch.added ?? []) {
    const rel = normalizeIndexRel(raw)
    if (!rel || isIgnored(rel) || fileSet.has(rel)) continue
    nextFiles.push(rel)
    fileSet.add(rel)
    changed = true
  }

  return { files: nextFiles, fileSet, changed }
}
