/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 *
 * Locks the read-path freshness decision for the Git Diff content cache
 * (electron/main/git-diff-content-cache-state.ts `decideContentCacheReadFreshness`).
 *
 * Background: the content-cache key is path-only, so a same-status re-edit maps to
 * the same key; the FS-watcher is the only automatic invalidation and it can miss an
 * edit (Windows EDR). The fix stat-validates the working-tree file on every HIT and
 * re-fetches only when it can PROVE the file changed. This test pins that decision
 * table so the "conservative on read" contract (never punish an unvalidatable hit;
 * only re-fetch on a proven change) cannot silently regress.
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { decideContentCacheReadFreshness } from '../../electron/main/git-diff-content-cache-state.ts'

test('unchanged working-tree file (tokens equal) => fresh (serve the cached hit)', () => {
  assert.equal(decideContentCacheReadFreshness('mtime:100:size:42', 'mtime:100:size:42'), 'fresh')
})

test('changed working-tree file (tokens differ) => stale (re-fetch)', () => {
  // The whole point: the file changed since it was cached even though no watcher
  // event fired, so the differing stat token must force a re-fetch.
  assert.equal(decideContentCacheReadFreshness('mtime:100:size:42', 'mtime:200:size:57'), 'stale')
  // Same mtime but different size (e.g. an append) must also be detected.
  assert.equal(decideContentCacheReadFreshness('mtime:100:size:42', 'mtime:100:size:99'), 'stale')
})

test('staged / index-backed content (stored token undefined) => fresh (not worktree-validated here)', () => {
  // computeStaleToken returns undefined for staged content; its freshness rides the
  // index-generation / mirror path, so a read-path stat check must NOT evict it.
  assert.equal(decideContentCacheReadFreshness(undefined, 'mtime:200:size:57'), 'fresh')
  assert.equal(decideContentCacheReadFreshness(undefined, undefined), 'fresh')
})

test('transient stat failure / deleted file (current token undefined) => fresh (do not punish the hit)', () => {
  // A transient stat error (e.g. the atomic-save temp->rename window on Windows) or a
  // deleted file yields an undefined current token. Serving the hit avoids a spurious
  // refetch storm; a real delete is a status change the mirror catches, and the next
  // successful stat catches a completed edit.
  assert.equal(decideContentCacheReadFreshness('mtime:100:size:42', undefined), 'fresh')
})
