/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 *
 * Unit tests for `electron/main/file-watch-core.ts` — the pure decision core
 * behind the single-file watcher's emit/skip choices.
 *
 * The defect class these lock down: the app saves files it also watches. The
 * PDF annotation autosave uses temp-file + rename (atomic replace), which the
 * old time-window suppression never gated — every autosave would have
 * reloaded the viewer (FWB-U-10), and a genuine external write landing inside
 * the window was silently swallowed (FWB-U-12). The fingerprint model decides
 * by content identity instead of by clock, so both failure modes are
 * structurally closed.
 *
 * Usage: node --experimental-strip-types --test test/unittest/file-watch-binary-core.test.mts
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  EXPECTED_WRITE_TTL_MS,
  HASH_MAX_BYTES,
  binaryBaselineChanged,
  classifyStat,
  isExpectedWriteLive,
  resolveSettle,
  shouldComputeHash
} from '../../electron/main/file-watch-core.ts'

const NOW = 1_000_000

function fp(size: number, mtimeMs: number, hash: string | null) {
  return { size, mtimeMs, hash }
}

function expectedWrite(size: number, hash: string, expiresAt = NOW + 1000) {
  return { size, hash, expiresAt }
}

// ─────────────── FWB-U-01..02 agreed constants ───────────────

test('FWB-U-01 hash budget matches the annotation store large-file threshold', () => {
  // The two layers must agree on what "large" means, or a 25 MB PDF would be
  // "large" for autosave cadence but "small" for watcher hashing.
  assert.equal(HASH_MAX_BYTES, 20 * 1024 * 1024)
})

test('FWB-U-02 self-write registration TTL covers debounce + rebuild with margin', () => {
  // 400 ms debounce + 500 ms rename-rebuild delay settle well inside it.
  assert.equal(EXPECTED_WRITE_TTL_MS, 5000)
})

// ─────────────── FWB-U-03..06 stat classification ───────────────

test('FWB-U-03 size change alone is a certain change (no hash needed)', () => {
  assert.equal(classifyStat(fp(100, 5, 'aa'), { size: 101, mtimeMs: 5 }), 'changed')
})

test('FWB-U-04 identical size and mtime is certainly unchanged', () => {
  assert.equal(classifyStat(fp(100, 5, 'aa'), { size: 100, mtimeMs: 5 }), 'unchanged')
})

test('FWB-U-05 same size but moved mtime needs the hash to tell touch from rewrite', () => {
  assert.equal(classifyStat(fp(100, 5, 'aa'), { size: 100, mtimeMs: 9 }), 'need-hash')
})

test('FWB-U-06 a hashless (over-budget) baseline cannot confirm, so it must report change', () => {
  // Erring toward "changed" costs one redundant reload; erring toward
  // "unchanged" ships a stale document.
  assert.equal(classifyStat(fp(100, 5, null), { size: 100, mtimeMs: 9 }), 'changed')
})

// ─────────────── FWB-U-07..09 hash budget ───────────────

test('FWB-U-07 files under the budget always hash', () => {
  assert.equal(shouldComputeHash({ size: HASH_MAX_BYTES, expected: null, nowMs: NOW }), true)
})

test('FWB-U-08 files over the budget skip routine hashing', () => {
  assert.equal(shouldComputeHash({ size: HASH_MAX_BYTES + 1, expected: null, nowMs: NOW }), false)
})

test('FWB-U-09 a pending same-size self-write forces the hash even over budget', () => {
  // This one hash is what lets a 100 MB annotation autosave be recognised as
  // our own write instead of triggering a self-refresh.
  const size = HASH_MAX_BYTES + 1
  assert.equal(
    shouldComputeHash({ size, expected: expectedWrite(size, 'aa'), nowMs: NOW }),
    true
  )
  // …but an expired registration does not.
  assert.equal(
    shouldComputeHash({ size, expected: expectedWrite(size, 'aa', NOW - 1), nowMs: NOW }),
    false
  )
})

// ─────────────── FWB-U-10..14 settle decision ───────────────

test('FWB-U-10 disk matching the registered self-write is skipped (rename-path regression lock)', () => {
  // THE bug this design exists for: the atomic-replace save surfaces via the
  // rename→rebuild path, and the settle there must still recognise our own
  // bytes. baselineChanged is true by construction after our own save — the
  // own-write check must win.
  const action = resolveSettle({
    nowMs: NOW,
    expected: expectedWrite(4, 'deadbeef'),
    disk: { size: 4, hash: 'deadbeef' },
    baselineChanged: true
  })
  assert.equal(action, 'skip-own-write')
})

test('FWB-U-11 an expired self-write registration no longer suppresses', () => {
  const action = resolveSettle({
    nowMs: NOW,
    expected: expectedWrite(4, 'deadbeef', NOW - 1),
    disk: { size: 4, hash: 'deadbeef' },
    baselineChanged: true
  })
  assert.equal(action, 'emit-changed')
})

test('FWB-U-12 an external write during the pending window is NOT swallowed', () => {
  // The old time-window design dropped every event for 1 s after a save.
  // Fingerprints only skip bytes that ARE our write; different bytes emit.
  const action = resolveSettle({
    nowMs: NOW,
    expected: expectedWrite(4, 'deadbeef'),
    disk: { size: 4, hash: 'cafebabe' },
    baselineChanged: true
  })
  assert.equal(action, 'emit-changed')
})

test('FWB-U-13 unchanged baseline with no pending write is a quiet skip', () => {
  const action = resolveSettle({
    nowMs: NOW,
    expected: null,
    disk: { size: 4, hash: 'deadbeef' },
    baselineChanged: false
  })
  assert.equal(action, 'skip-unchanged')
})

test('FWB-U-14 a hashless disk observation cannot match a registered write', () => {
  // Without the hash there is no identity proof; treating it as our own write
  // would let ANY same-size external rewrite be swallowed.
  const action = resolveSettle({
    nowMs: NOW,
    expected: expectedWrite(4, 'deadbeef'),
    disk: { size: 4, hash: null },
    baselineChanged: true
  })
  assert.equal(action, 'emit-changed')
})

// ─────────────── FWB-U-15..17 baseline comparison + liveness ───────────────

test('FWB-U-15 a bare touch (same hash, moved mtime) is not a change', () => {
  assert.equal(
    binaryBaselineChanged(fp(100, 5, 'aa'), fp(100, 9, 'aa')),
    false
  )
})

test('FWB-U-16 over-budget files degrade to size+mtime identity', () => {
  assert.equal(binaryBaselineChanged(fp(100, 5, null), fp(100, 5, null)), false)
  assert.equal(binaryBaselineChanged(fp(100, 5, null), fp(100, 9, null)), true)
  assert.equal(binaryBaselineChanged(fp(100, 5, null), fp(101, 5, null)), true)
})

test('FWB-U-17 expected-write liveness is a closed interval on expiry', () => {
  assert.equal(isExpectedWriteLive(expectedWrite(4, 'aa', NOW), NOW), true)
  assert.equal(isExpectedWriteLive(expectedWrite(4, 'aa', NOW - 1), NOW), false)
  assert.equal(isExpectedWriteLive(null, NOW), false)
})
