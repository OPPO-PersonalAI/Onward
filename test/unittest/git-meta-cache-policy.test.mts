/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 *
 * Usage: node --experimental-strip-types --test test/unittest/git-meta-cache-policy.test.mts
 *
 * Locks the git-op aggregation A1 cache policy: a POSITIVE repo-meta entry
 * (repoRoot/gitDir, immutable per cwd) is fresh FOREVER so we stop re-spawning
 * `rev-parse`; a NEGATIVE entry (not-a-repo) expires after the TTL so a freshly
 * `git init`'d directory is rediscovered. A regression that re-applies the TTL
 * to positive entries re-introduces the EDR rev-parse storm (85 spawns × 3.5s).
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  classifyRepoProbeError,
  isMetaCacheEntryFresh,
  repoProbeBackoffTtlMs,
  REPO_PROBE_TIMEOUT_BACKOFF_MS
} from '../../electron/main/git-meta-cache-policy.ts'

const TTL = 1000

test('a positive (isRepo) entry is fresh forever — even far past the TTL', () => {
  const entry = { value: { isRepo: true }, at: 0 }
  assert.equal(isMetaCacheEntryFresh(entry, 500, TTL), true)
  assert.equal(isMetaCacheEntryFresh(entry, 10_000_000, TTL), true, 'immutable root must never expire')
})

test('a negative (not-a-repo) entry is fresh only within the TTL', () => {
  const entry = { value: { isRepo: false }, at: 0 }
  assert.equal(isMetaCacheEntryFresh(entry, 500, TTL), true, 'within TTL → fresh')
  assert.equal(isMetaCacheEntryFresh(entry, 1500, TTL), false, 'past TTL → re-check (catches a later git init)')
})

test('the TTL boundary is exclusive on the upper edge for negatives', () => {
  const entry = { value: { isRepo: false }, at: 0 }
  assert.equal(isMetaCacheEntryFresh(entry, 999, TTL), true)
  assert.equal(isMetaCacheEntryFresh(entry, 1000, TTL), false)
})

// ───── RC-2 (2026-07 bundles): timeout probes get exponential backoff, ─────
// ───── not the short negative TTL — a hanging network volume must not  ─────
// ───── stall the git lane 10 s on every focus/watcher trigger.         ─────

test('backoff ladder: strikes map to 30s → 2min → 5min, capped', () => {
  assert.equal(repoProbeBackoffTtlMs(1), REPO_PROBE_TIMEOUT_BACKOFF_MS[0])
  assert.equal(repoProbeBackoffTtlMs(2), REPO_PROBE_TIMEOUT_BACKOFF_MS[1])
  assert.equal(repoProbeBackoffTtlMs(3), REPO_PROBE_TIMEOUT_BACKOFF_MS[2])
  assert.equal(repoProbeBackoffTtlMs(99), REPO_PROBE_TIMEOUT_BACKOFF_MS[2], 'ladder caps at the last rung')
  assert.equal(repoProbeBackoffTtlMs(0), REPO_PROBE_TIMEOUT_BACKOFF_MS[0], 'zero strikes clamps to the first rung')
})

test('a timeout entry stays fresh through the backoff window, then expires', () => {
  const entry = { value: { isRepo: false, probeState: 'timeout' as const }, at: 0, timeoutStrikes: 1 }
  assert.equal(isMetaCacheEntryFresh(entry, 29_999, TTL), true, 'inside 30 s → no re-probe')
  assert.equal(isMetaCacheEntryFresh(entry, 30_000, TTL), false, 'past 30 s → re-probe allowed')
})

test('consecutive strikes lengthen the freshness window', () => {
  const strike3 = { value: { isRepo: false, probeState: 'timeout' as const }, at: 0, timeoutStrikes: 3 }
  assert.equal(isMetaCacheEntryFresh(strike3, 200_000, TTL), true, 'strike 3 holds 5 min')
  assert.equal(isMetaCacheEntryFresh(strike3, 300_000, TTL), false)
})

test('a plain not-repo entry is unaffected by the backoff ladder', () => {
  const entry = { value: { isRepo: false, probeState: 'not-repo' as const }, at: 0 }
  assert.equal(isMetaCacheEntryFresh(entry, 1500, TTL), false, 'short TTL still applies')
})

// ───── G6 (2026-07-24 review): alias-keying is documented behaviour ─────
// The gitMetaCache key is `path.resolve(cwd)` — LEXICAL normalization only,
// deliberately NOT `fs.realpath`: dereferencing a symlink/junction on the
// very hanging network volume RC-2 protects against would itself block in
// the threadpool. Consequence (accepted cost, locked here so a future
// "optimisation" to canonical keys re-litigates it consciously): each
// lexical alias of the same directory carries an INDEPENDENT entry and an
// INDEPENDENT strike ladder — N aliases pay up to N initial 10 s probes
// before all their ladders engage.

test('G6: alias entries carry independent backoff ladders (documented behaviour)', () => {
  // Simulates two lexical aliases (e.g. `Z:\link\repo` and `D:\real\repo`)
  // of one hanging volume: entries are independent, so one alias being deep
  // into backoff must not extend the other's window.
  const viaJunction = { value: { isRepo: false, probeState: 'timeout' as const }, at: 0, timeoutStrikes: 3 }
  const viaRealPath = { value: { isRepo: false, probeState: 'timeout' as const }, at: 0, timeoutStrikes: 1 }
  assert.equal(isMetaCacheEntryFresh(viaJunction, 200_000, TTL), true, 'strike-3 alias holds 5 min')
  assert.equal(isMetaCacheEntryFresh(viaRealPath, 200_000, TTL), false, 'strike-1 alias re-probes after 30 s')
})

// ───── Probe-error classifier decision table ─────

test('classifier: a timeout kill (killed/SIGTERM, no numeric code) → timeout', () => {
  assert.equal(classifyRepoProbeError({ killed: true, signal: 'SIGTERM', code: null }), 'timeout')
  assert.equal(classifyRepoProbeError({ killed: false, signal: 'SIGKILL', code: null }), 'timeout')
})

test('classifier: a numeric exit code (git answered) → not-repo', () => {
  assert.equal(classifyRepoProbeError({ killed: false, signal: null, code: 128 }), 'not-repo')
  assert.equal(classifyRepoProbeError({ code: 1 }), 'not-repo')
})

test('classifier: spawn failures (string code / nothing) → error', () => {
  assert.equal(classifyRepoProbeError({ code: 'ENOENT' }), 'error')
  assert.equal(classifyRepoProbeError({}), 'error')
})
