/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 *
 * Usage: node --experimental-strip-types --test test/unittest/git-history-cache.test.mts
 *
 * Locks the pure History-cache key builders + prewarm-commit selection
 * (prewarm-cache decision ⑦): L8 list keyed on branchOid (freshness), L9
 * commit-diff keyed immutably, and the top-N ∪ last-week prewarm set.
 *
 * ALSO reproduces the "phantom fork after push" bug (see the REPRODUCES BUG
 * block near the end): the L8 list cache keys on branchOid ONLY, so a ref-only
 * move — classically `git push` advancing origin/<branch> while HEAD stays put —
 * does not invalidate the entry, and the cached `%D` branch/remote decorations
 * (rendered as the graph's branch labels) go stale for up to the 30-min TTL.
 * Field symptom: kae-0.36 == origin/kae-0.36 == 58feede on disk, yet Git History
 * kept drawing origin/kae-0.36 three commits back on d2b0c86 (its pre-push spot).
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { resolve } from 'node:path'

import {
  EMPTY_TREE_HASH,
  buildHistoryCommitDiffCacheKey,
  buildHistoryFileContentCacheKey,
  buildHistoryListCacheKey,
  buildPrewarmCommitDiffTargets,
  cachedHistoryRequest,
  selectPrewarmCommits
} from '../../electron/main/git-history-cache.ts'
import { GitDiffRequestCacheController } from '../../electron/main/git-diff-request-cache.ts'

const DAY_MS = 24 * 60 * 60 * 1000

// GitCommitInfo is wider than selection needs; build minimal records and cast.
function commit(sha: string, authorDate: string, parents: string[] = []) {
  return { sha, shortSha: sha.slice(0, 7), parents, authorDate } as never
}

// ---------------------------------------------------------------------------
// Key builders
// ---------------------------------------------------------------------------

test('buildHistoryListCacheKey embeds branchOid, refsDigest, limit, skip after resolve(cwd)', () => {
  const key = buildHistoryListCacheKey('/work/repo', 'abc123', 'refs-a', 50, 0)
  assert.equal(key, `${resolve('/work/repo')}::abc123::refs-a::50::0`)
})

test('buildHistoryListCacheKey falls back to nohead / norefs when signals are undefined', () => {
  const key = buildHistoryListCacheKey('/work/repo', undefined, undefined, 50, 10)
  assert.equal(key, `${resolve('/work/repo')}::nohead::norefs::50::10`)
})

test('buildHistoryListCacheKey: a new branchOid produces a DIFFERENT key (structural invalidation)', () => {
  const a = buildHistoryListCacheKey('/work/repo', 'oid-old', 'refs-a', 50, 0)
  const b = buildHistoryListCacheKey('/work/repo', 'oid-new', 'refs-a', 50, 0)
  assert.notEqual(a, b)
})

test('buildHistoryListCacheKey: same branchOid but a NEW refsDigest produces a DIFFERENT key (fixes the phantom-fork-after-push bug)', () => {
  // A `git push` advances origin/<branch> WITHOUT moving HEAD, so branchOid is
  // identical pre/post; refsDigest is the signal that captures the ref move. The
  // two states must produce DIFFERENT keys so the post-push request structurally
  // misses and recomputes fresh `%D` decorations (was the root cause of the bug:
  // before the fix the key ignored ref state and these collapsed to one key).
  const keyBeforePush = buildHistoryListCacheKey('/work/repo', '58feede', 'digest-pre', 50, 0)
  const keyAfterPush = buildHistoryListCacheKey('/work/repo', '58feede', 'digest-post', 50, 0)
  assert.notEqual(keyBeforePush, keyAfterPush)
  // Same branchOid AND same refsDigest ⇒ identical key (cache hit preserved when
  // nothing relevant moved — keeps the prewarm efficient).
  assert.equal(
    buildHistoryListCacheKey('/work/repo', '58feede', 'digest-pre', 50, 0),
    buildHistoryListCacheKey('/work/repo', '58feede', 'digest-pre', 50, 0)
  )
})

test('buildHistoryCommitDiffCacheKey is stable + immutable per (cwd, options)', () => {
  const opts = { base: 'P', head: 'H', includeFiles: true, hideWhitespace: false }
  const k1 = buildHistoryCommitDiffCacheKey('/work/repo', opts)
  // Same options, different key insertion order → same stable key.
  const k2 = buildHistoryCommitDiffCacheKey('/work/repo', { head: 'H', hideWhitespace: false, base: 'P', includeFiles: true })
  assert.equal(k1, k2)
  assert.ok(k1.startsWith(`${resolve('/work/repo')}::`))
})

test('buildHistoryCommitDiffCacheKey distinguishes different commit ranges', () => {
  const a = buildHistoryCommitDiffCacheKey('/r', { base: 'P1', head: 'H1' })
  const b = buildHistoryCommitDiffCacheKey('/r', { base: 'P2', head: 'H2' })
  assert.notEqual(a, b)
})

test('buildHistoryFileContentCacheKey is stable per (cwd, options)', () => {
  const opts = { base: 'P', head: 'H', file: { filename: 'a.ts', status: 'M' as const } }
  const k = buildHistoryFileContentCacheKey('/r', opts)
  assert.ok(k.startsWith(`${resolve('/r')}::`))
  assert.equal(k, buildHistoryFileContentCacheKey('/r', opts))
})

// ---------------------------------------------------------------------------
// selectPrewarmCommits — top-N ∪ last-week
// ---------------------------------------------------------------------------

const NOW = Date.parse('2026-06-09T00:00:00Z')

test('selectPrewarmCommits returns the first topN in log order when withinDays is 0', () => {
  const commits = [commit('c0', '2020-01-01T00:00:00Z'), commit('c1', '2020-01-02T00:00:00Z'), commit('c2', '2020-01-03T00:00:00Z')]
  const out = selectPrewarmCommits(commits, { topN: 2, withinDays: 0, nowMs: NOW })
  assert.deepEqual(out.map((c) => c.sha), ['c0', 'c1'])
})

test('selectPrewarmCommits adds commits within the recent window beyond topN', () => {
  const commits = [
    commit('old0', '2020-01-01T00:00:00Z'),
    commit('recentA', new Date(NOW - 2 * DAY_MS).toISOString()),
    commit('recentB', new Date(NOW - 6 * DAY_MS).toISOString()),
    commit('tooOld', new Date(NOW - 30 * DAY_MS).toISOString())
  ]
  const out = selectPrewarmCommits(commits, { topN: 1, withinDays: 7, nowMs: NOW }).map((c) => c.sha)
  assert.deepEqual(out, ['old0', 'recentA', 'recentB']) // top-1 first, then recents in log order; tooOld excluded
})

test('selectPrewarmCommits de-duplicates a commit that is both top-N and recent', () => {
  const commits = [commit('a', new Date(NOW - 1 * DAY_MS).toISOString()), commit('b', new Date(NOW - 2 * DAY_MS).toISOString())]
  const out = selectPrewarmCommits(commits, { topN: 1, withinDays: 7, nowMs: NOW }).map((c) => c.sha)
  assert.deepEqual(out, ['a', 'b']) // 'a' appears once even though it is both top-1 AND recent
})

test('selectPrewarmCommits excludes commits with an unparseable author date from the window', () => {
  const commits = [commit('a', 'not-a-date'), commit('b', new Date(NOW - 1 * DAY_MS).toISOString())]
  const out = selectPrewarmCommits(commits, { topN: 0, withinDays: 7, nowMs: NOW }).map((c) => c.sha)
  assert.deepEqual(out, ['b'])
})

test('selectPrewarmCommits handles topN larger than the list without error', () => {
  const commits = [commit('a', '2020-01-01T00:00:00Z')]
  const out = selectPrewarmCommits(commits, { topN: 10, withinDays: 0, nowMs: NOW }).map((c) => c.sha)
  assert.deepEqual(out, ['a'])
})

// ---------------------------------------------------------------------------
// buildPrewarmCommitDiffTargets — base/head matches the renderer's click
// ---------------------------------------------------------------------------

test('buildPrewarmCommitDiffTargets uses parents[0] as base, sha as head', () => {
  const targets = buildPrewarmCommitDiffTargets([commit('H', '2020-01-01T00:00:00Z', ['P'])])
  assert.deepEqual(targets, [{ base: 'P', head: 'H' }])
})

test('buildPrewarmCommitDiffTargets uses the empty-tree hash for a root commit (no parent)', () => {
  const targets = buildPrewarmCommitDiffTargets([commit('ROOT', '2020-01-01T00:00:00Z', [])])
  assert.deepEqual(targets, [{ base: EMPTY_TREE_HASH, head: 'ROOT' }])
})

// ---------------------------------------------------------------------------
// REGRESSION LOCK — "phantom fork after push": a ref-only move (push/fetch
// advancing origin/<branch> while HEAD stays put) must NOT serve stale `%D`
// decorations. The fix adds `refsDigest` as the second freshness signal in the
// L8 key, so a ref move re-keys → structural miss → fresh decorations.
//
// These run the REAL cache path: cachedHistoryRequest + a GitDiffRequestCacheController
// configured exactly like getHistoryListCacheController() (30-min TTL, structuredClone),
// with an INJECTED clock so the TTL is deterministic — no git, no Electron, no wall clock.
// The handler/prewarm supply branchOid + refsDigest from the GitStateMirror
// snapshot; here REFS_PRE/REFS_POST stand in for the digest before/after a push.
//
// (History: these assertions previously pinned the BUG by asserting the stale
// behaviour; they were inverted when the refsDigest fix landed.)
// ---------------------------------------------------------------------------

// Mirrors git-history-cache.ts:55 (HISTORY_LIST_TTL_MS). Re-declared here rather
// than exported solely for the test, so this file documents the value it asserts.
const HISTORY_LIST_TTL_MS = 30 * 60 * 1000

// Build a minimal getGitHistory-shaped success payload, mapping sha → `%D` refs
// string (e.g. 'HEAD -> kae-0.36, origin/kae-0.36'); `undefined` = no decoration.
function historyResult(decorations: Record<string, string | undefined>) {
  const commits = Object.entries(decorations).map(([sha, refs]) => ({
    sha,
    shortSha: sha.slice(0, 7),
    parents: [],
    summary: `commit ${sha}`,
    body: '',
    authorName: 'a',
    authorEmail: 'a@example.com',
    authorDate: '2026-06-29T00:00:00Z',
    refs
  }))
  return { success: true as const, cwd: '/work/repo', isGitRepo: true as const, gitInstalled: true as const, commits }
}

type HistoryResult = ReturnType<typeof historyResult>

function refsOf(result: HistoryResult, sha: string): string | undefined {
  return result.commits.find((c) => c.sha === sha)?.refs
}

// A fresh, isolated controller with the production config + a controllable clock.
function freshHistoryListController() {
  let clock = 0
  const controller = new GitDiffRequestCacheController<HistoryResult>({
    ttlMs: HISTORY_LIST_TTL_MS,
    maxEntries: 64,
    clone: (value) => structuredClone(value),
    now: () => clock
  })
  return { controller, advance: (ms: number) => { clock += ms } }
}

// The captured state: HEAD on 58feede; origin/kae-0.36 still on the older d2b0c86.
const BEFORE_PUSH = () => historyResult({
  '58feede': 'HEAD -> kae-0.36',
  'd2b0c86': 'origin/kae-0.36'
})
// What a FRESH `git log %D` would report after the push: origin advanced onto HEAD.
const AFTER_PUSH = () => historyResult({
  '58feede': 'HEAD -> kae-0.36, origin/kae-0.36',
  'd2b0c86': undefined
})

// Stand-in mirror refsDigests before / after the push (HEAD/branchOid unchanged).
const REFS_PRE = 'refsdigest-pre'
const REFS_POST = 'refsdigest-post'

test('FIXED: push advances origin/* (HEAD unchanged) → refsDigest re-keys → reload yields fresh decorations', async () => {
  const { controller } = freshHistoryListController()
  const branchOid = '58feede' // HEAD does NOT move across the push
  const keyBeforePush = buildHistoryListCacheKey('/work/repo', branchOid, REFS_PRE, 50, 0)
  const keyAfterPush = buildHistoryListCacheKey('/work/repo', branchOid, REFS_POST, 50, 0)

  let loads = 0
  const load = async () => { loads += 1; return loads === 1 ? BEFORE_PUSH() : AFTER_PUSH() }

  const first = await cachedHistoryRequest(controller, keyBeforePush, load)
  assert.equal(refsOf(first, 'd2b0c86'), 'origin/kae-0.36') // pre-push: correct

  // --- git push: origin/kae-0.36 → 58feede; HEAD unchanged, but refsDigest moves ---

  const second = await cachedHistoryRequest(controller, keyAfterPush, load)

  assert.equal(loads, 2, 'a ref-only move re-keys (refsDigest changed) → structural miss → reload')
  // origin/kae-0.36 now decorates the current HEAD ...
  assert.equal(refsOf(second, '58feede'), 'HEAD -> kae-0.36, origin/kae-0.36')
  // ... and is gone from the old commit (no phantom fork).
  assert.equal(refsOf(second, 'd2b0c86'), undefined)
})

test('FIXED: an UNCHANGED refsDigest still HITs within the 30-min TTL (prewarm stays efficient); a ref move misses regardless of age', async () => {
  const { controller, advance } = freshHistoryListController()
  const keyPre = buildHistoryListCacheKey('/work/repo', '58feede', REFS_PRE, 50, 0)
  let loads = 0
  const load = async () => { loads += 1; return loads === 1 ? BEFORE_PUSH() : AFTER_PUSH() }

  await cachedHistoryRequest(controller, keyPre, load)

  // 7 min later, nothing moved (same branchOid + refsDigest): still a HIT — the
  // fix must NOT churn the cache when the repo is quiescent.
  advance(7 * 60 * 1000)
  const at7min = await cachedHistoryRequest(controller, keyPre, load)
  assert.equal(loads, 1, 'unchanged state stays cached within TTL (prewarm efficiency preserved)')
  assert.equal(refsOf(at7min, 'd2b0c86'), 'origin/kae-0.36')

  // Now a push moves refsDigest → new key → immediate miss, NO waiting for TTL.
  const keyPost = buildHistoryListCacheKey('/work/repo', '58feede', REFS_POST, 50, 0)
  const afterPush = await cachedHistoryRequest(controller, keyPost, load)
  assert.equal(loads, 2, 'ref move re-keys immediately — no 30-min staleness window')
  assert.equal(refsOf(afterPush, '58feede'), 'HEAD -> kae-0.36, origin/kae-0.36')
  assert.equal(refsOf(afterPush, 'd2b0c86'), undefined)
})

test('CONTRAST: a new commit (branchOid moves) is also a structural miss → fresh decorations', async () => {
  // The original branchOid freshness signal still works; refsDigest is additive.
  const { controller } = freshHistoryListController()
  let loads = 0
  const load = async () => {
    loads += 1
    return loads === 1
      ? historyResult({ 'd2b0c86': 'HEAD -> kae-0.36, origin/kae-0.36' })
      : historyResult({ newhead: 'HEAD -> kae-0.36', 'd2b0c86': 'origin/kae-0.36' })
  }

  await cachedHistoryRequest(controller, buildHistoryListCacheKey('/work/repo', 'd2b0c86', REFS_PRE, 50, 0), load)
  const second = await cachedHistoryRequest(controller, buildHistoryListCacheKey('/work/repo', 'newhead', REFS_PRE, 50, 0), load)

  assert.equal(loads, 2, 'a new branchOid is a structural miss and reloads')
  assert.equal(refsOf(second, 'newhead'), 'HEAD -> kae-0.36')
})

test('regression: a ref-only move refreshes decorations even though HEAD (branchOid) is unchanged', async () => {
  // The originally-pending target (now passing): HEAD pinned at 58feede; once
  // origin/* moves, the next History read reflects it (origin/kae-0.36 on 58feede,
  // gone from d2b0c86), driven by the refsDigest difference in the cache key.
  const { controller } = freshHistoryListController()
  let loads = 0
  const load = async () => { loads += 1; return loads === 1 ? BEFORE_PUSH() : AFTER_PUSH() }

  await cachedHistoryRequest(controller, buildHistoryListCacheKey('/work/repo', '58feede', REFS_PRE, 50, 0), load)
  const second = await cachedHistoryRequest(controller, buildHistoryListCacheKey('/work/repo', '58feede', REFS_POST, 50, 0), load)

  assert.equal(refsOf(second, '58feede'), 'HEAD -> kae-0.36, origin/kae-0.36')
  assert.equal(refsOf(second, 'd2b0c86'), undefined)
})
