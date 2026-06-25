/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 *
 * Unit tests for the ripgrep-binary integrity decision used by the postinstall
 * sanity gate `scripts/ensure-ripgrep-binary.js`:
 *   - classifyRipgrepBinary({ existsOnDisk, sizeBytes, minBytes })
 *
 * Background: `@vscode/ripgrep` 1.17.x downloaded + unzipped rg.exe at install
 * time via yauzl streaming inflate, which truncated the binary on Node 24 for
 * entries > ~5 MB (see docs/lessons.md). The OLD safety net checked only that
 * the file EXISTED — a truncated 5.38 MB rg.exe "exists", so the corruption
 * slipped straight through and broke global search at runtime. The fix bumped
 * the dependency to >= 1.18.0 (binary ships pre-extracted + SHA256-verified, no
 * unzip) AND hardened this gate to check existence AND a size floor. This test
 * pins exactly that existence-AND-size decision so the gap cannot reopen.
 *
 * Pair with the autotest suite `run-global-search` (GS-01..11), which proves the
 * wiring end-to-end (the packaged app actually spawns rg and returns matches).
 * The unit test locks the math (the integrity decision table); the autotest
 * proves the wiring.
 *
 * Usage:
 *   node --experimental-strip-types --test test/unittest/ensure-ripgrep-binary.test.mts
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { classifyRipgrepBinary, MIN_BINARY_BYTES } = require('../../scripts/ensure-ripgrep-binary.js') as {
  classifyRipgrepBinary: (input: {
    existsOnDisk: boolean
    sizeBytes: number
    minBytes?: number
  }) => { ok: boolean; reason: 'ok' | 'missing' | 'truncated' }
  MIN_BINARY_BYTES: number
}

test('ERG-U-01: the integrity floor is a sane multi-MB value', () => {
  // A real ripgrep build is several MB; the floor must be high enough to reject
  // a grossly-truncated/empty file but below the smallest platform build.
  assert.equal(MIN_BINARY_BYTES, 2 * 1024 * 1024)
})

test('ERG-U-02: a missing binary is rejected as "missing"', () => {
  const v = classifyRipgrepBinary({ existsOnDisk: false, sizeBytes: 0 })
  assert.equal(v.ok, false)
  assert.equal(v.reason, 'missing')
})

test('ERG-U-03: an existing but truncated binary is rejected as "truncated" (the original bug)', () => {
  // The exact failure mode from the incident: rg.exe existed at 5,384,573 bytes
  // (~45 KB short of the full 5,429,760) but was a broken PE. Simulate a file
  // that exists yet is below the floor — existence-only checks WRONGLY pass this.
  const v = classifyRipgrepBinary({ existsOnDisk: true, sizeBytes: 1024 })
  assert.equal(v.ok, false)
  assert.equal(v.reason, 'truncated')
})

test('ERG-U-04: a complete binary at/above the floor passes as "ok"', () => {
  const v = classifyRipgrepBinary({ existsOnDisk: true, sizeBytes: 5_429_760 })
  assert.equal(v.ok, true)
  assert.equal(v.reason, 'ok')
})

test('ERG-U-05: the floor boundary is inclusive (size === floor passes)', () => {
  const v = classifyRipgrepBinary({ existsOnDisk: true, sizeBytes: MIN_BINARY_BYTES })
  assert.equal(v.ok, true)
  assert.equal(v.reason, 'ok')
})

test('ERG-U-06: one byte below the floor fails as "truncated"', () => {
  const v = classifyRipgrepBinary({ existsOnDisk: true, sizeBytes: MIN_BINARY_BYTES - 1 })
  assert.equal(v.ok, false)
  assert.equal(v.reason, 'truncated')
})

test('ERG-U-07: a custom minBytes overrides the default floor', () => {
  // The caller may pass a stricter floor; the decision must honour it.
  const strict = classifyRipgrepBinary({ existsOnDisk: true, sizeBytes: 3_000_000, minBytes: 5_000_000 })
  assert.equal(strict.ok, false)
  assert.equal(strict.reason, 'truncated')
  const loose = classifyRipgrepBinary({ existsOnDisk: true, sizeBytes: 3_000_000, minBytes: 1_000_000 })
  assert.equal(loose.ok, true)
})

test('ERG-U-08: a non-numeric size is treated as truncated, not a pass', () => {
  // Defensive: statSync(...).size should always be a number, but a malformed
  // input must never be classified as ok.
  const v = classifyRipgrepBinary({ existsOnDisk: true, sizeBytes: Number.NaN })
  assert.equal(v.ok, false)
  assert.equal(v.reason, 'truncated')
})
