/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Pure cat-file ref classification. Kept dependency-free so it is unit-testable
 * under `node --experimental-strip-types` without pulling in the heavy
 * git-utils / child_process graph.
 *
 * Whether a cat-file ref points at MUTABLE state — i.e. an index ref (`:<path>`,
 * `:0:<path>`, `:1:<path>`, …). The long-running `git cat-file --batch` process
 * snapshots the index in memory at PROCESS START, so an index ref read by a
 * batch that was spawned BEFORE a `git add` / stage / partial-stage would return
 * the STALE startup index blob (surfaced historically as staged diffs showing
 * HEAD/base content on both sides — GDS-22 / GDS-33).
 *
 * Index refs are NO LONGER barred from the batch outright. Instead the caller
 * tags every batch request with an INDEX-GENERATION token (a cheap stat of
 * `.git/index`); when that token changes the batch is disposed and respawned so
 * the next index read snapshots the CURRENT index (see
 * {@link shouldRespawnForIndexGeneration}). Immutable refs — `HEAD:<path>`,
 * `<commit>:<path>`, blob oids — are unaffected by index mutations and never
 * force a respawn.
 */
export function isMutableIndexRef(ref: string): boolean {
  return ref.startsWith(':')
}

/**
 * Pure decision: should the long-running `cat-file --batch` process be disposed
 * and respawned because the on-disk index changed since the running process
 * snapshotted it?
 *
 * The batch caches the index at PROCESS START, so the *only* way a long-lived
 * batch can serve a stale index blob is if the index file mutated after spawn.
 * We capture an index-generation token (mtime:size of `.git/index`) at spawn and
 * compare it against the token observed at read time:
 *   - A request that carries NO index token (`requestToken === null`) reads an
 *     IMMUTABLE ref (HEAD:path, commit:path, blob oid). Index mutations cannot
 *     affect it, so it never forces a respawn — returns false.
 *   - A request that carries a token reads an INDEX ref. If the spawned process
 *     captured a DIFFERENT token (or none — `spawnedToken === null`, meaning the
 *     batch predates index-aware spawning), the in-memory snapshot is stale and
 *     the process must be respawned — returns true.
 *   - Equal tokens mean the snapshot is still current — returns false (the hot,
 *     no-spawn fast path).
 *
 * Kept pure (string-token in, boolean out) so the freshness invariant that
 * guards GDS-22 / GDS-33 is locked by a Node unit test with no git/process I/O.
 */
export function shouldRespawnForIndexGeneration(
  spawnedToken: string | null,
  requestToken: string | null
): boolean {
  // Immutable ref read (no index token) — index churn is irrelevant.
  if (requestToken === null) return false
  // Index ref read against a batch that never recorded a token (legacy spawn) —
  // be conservative and respawn so we snapshot the current index.
  if (spawnedToken === null) return true
  // Index ref read against an index that mutated since the batch spawned.
  return spawnedToken !== requestToken
}
