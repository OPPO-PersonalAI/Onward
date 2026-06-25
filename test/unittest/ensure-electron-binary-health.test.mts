/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 *
 * Unit tests for the electron-dist integrity decision used by the postinstall
 * self-heal gate `scripts/ensure-electron-binary.js`:
 *   - classifyElectronDist({ launcherExists, largestFileBytes, minBytes })
 *
 * Background: electron's postinstall extracts the platform zip with yauzl,
 * which on Node 24+ truncates/drops the single heavy payload entry (see
 * docs/lessons.md). The gate self-heals by re-extracting with a native, non-
 * yauzl extractor, then must VERIFY the result.
 *
 * The original health check size-floored a FIXED path — path.txt's launcher —
 * against 50 MB. That is correct on Windows/Linux (the launcher electron.exe /
 * electron IS the >100 MB payload) but WRONG on macOS, where
 * Contents/MacOS/Electron is only a ~34-50 KB launcher stub and the ~170 MB
 * payload lives in the Electron Framework dylib. The fixed-path floor therefore
 * NEVER passed on a healthy macOS extraction, aborting the postinstall chain
 * before better-sqlite3 / node-pty / ripgrep were prepared.
 *
 * The fix keeps a single, unified (non-per-platform) signal: the launcher must
 * EXIST (so path.txt is valid) AND the LARGEST file anywhere under dist/ must
 * clear the floor — true on every platform regardless of which file is heavy.
 * This test pins exactly that decision table so the macOS regression cannot
 * reopen and the Windows/Linux behaviour is preserved.
 *
 * This is the unit (math) layer. There is no separate autotest (wiring) layer:
 * the script is a build-time postinstall gate, not user-facing runtime, so it
 * has no DOM/IPC/Electron surface to exercise end-to-end. Its real-extraction
 * wiring is already covered implicitly — a broken gate fails `pnpm dist:dev`.
 *
 * Usage:
 *   node --experimental-strip-types --test test/unittest/ensure-electron-binary-health.test.mts
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { classifyElectronDist, MIN_BINARY_BYTES } = require('../../scripts/ensure-electron-binary.js') as {
  classifyElectronDist: (input: {
    launcherExists: boolean
    largestFileBytes: number
    minBytes?: number
  }) => { ok: boolean; reason: 'ok' | 'missing' | 'truncated' }
  MIN_BINARY_BYTES: number
}

// Real macOS payload sizes observed across cached zips (the Electron Framework
// dylib), used to assert the healthy-macOS path concretely.
const MAC_FRAMEWORK_DYLIB_BYTES = 173_616_832 // electron v39.8.5 darwin-arm64
// The macOS launcher stub that the OLD fixed-path check size-floored by mistake.
const MAC_LAUNCHER_STUB_BYTES = 33_968

test('EEB-U-01: the integrity floor is the documented 50 MB', () => {
  assert.equal(MIN_BINARY_BYTES, 50 * 1024 * 1024)
})

test('EEB-U-02: a missing launcher is rejected as "missing"', () => {
  // No launcher → path.txt would be invalid; size is irrelevant.
  const v = classifyElectronDist({ launcherExists: false, largestFileBytes: MAC_FRAMEWORK_DYLIB_BYTES })
  assert.equal(v.ok, false)
  assert.equal(v.reason, 'missing')
})

test('EEB-U-03: a truncated extraction (no heavy file survived) is rejected as "truncated"', () => {
  // yauzl dropped the heavy entry — the largest surviving file is small.
  const v = classifyElectronDist({ launcherExists: true, largestFileBytes: 5 * 1024 * 1024 })
  assert.equal(v.ok, false)
  assert.equal(v.reason, 'truncated')
})

test('EEB-U-04 (the macOS regression): launcher is a tiny stub but the framework dylib is full → "ok"', () => {
  // This is the exact case the OLD fixed-path check got wrong: it size-floored
  // the 34 KB launcher stub against 50 MB and failed a perfectly healthy dist.
  // The largest-file signal sees the 173 MB framework dylib and passes.
  const v = classifyElectronDist({
    launcherExists: true,
    largestFileBytes: MAC_FRAMEWORK_DYLIB_BYTES,
  })
  assert.equal(v.ok, true)
  assert.equal(v.reason, 'ok')
})

test('EEB-U-05: the macOS launcher stub size alone would NOT clear the floor', () => {
  // Guards the root cause directly: had the heavy file NOT survived, the stub's
  // own size must never be mistaken for a healthy payload.
  const v = classifyElectronDist({ launcherExists: true, largestFileBytes: MAC_LAUNCHER_STUB_BYTES })
  assert.equal(v.ok, false)
  assert.equal(v.reason, 'truncated')
})

test('EEB-U-06: Windows/Linux healthy case (heavy launcher IS the largest file) → "ok"', () => {
  // On Win/Linux the launcher electron.exe / electron is itself >100 MB, so it
  // is also the largest file — the unified signal covers this unchanged.
  const v = classifyElectronDist({ launcherExists: true, largestFileBytes: 180 * 1024 * 1024 })
  assert.equal(v.ok, true)
  assert.equal(v.reason, 'ok')
})

test('EEB-U-07: the floor boundary is inclusive (largest === floor passes)', () => {
  const v = classifyElectronDist({ launcherExists: true, largestFileBytes: MIN_BINARY_BYTES })
  assert.equal(v.ok, true)
  assert.equal(v.reason, 'ok')
})

test('EEB-U-08: one byte below the floor fails as "truncated"', () => {
  const v = classifyElectronDist({ launcherExists: true, largestFileBytes: MIN_BINARY_BYTES - 1 })
  assert.equal(v.ok, false)
  assert.equal(v.reason, 'truncated')
})

test('EEB-U-09: a custom minBytes overrides the default floor', () => {
  const strict = classifyElectronDist({
    launcherExists: true,
    largestFileBytes: 60 * 1024 * 1024,
    minBytes: 100 * 1024 * 1024,
  })
  assert.equal(strict.ok, false)
  assert.equal(strict.reason, 'truncated')

  const loose = classifyElectronDist({
    launcherExists: true,
    largestFileBytes: 60 * 1024 * 1024,
    minBytes: 10 * 1024 * 1024,
  })
  assert.equal(loose.ok, true)
})

test('EEB-U-10: a non-numeric largest size is treated as truncated, not a pass', () => {
  // Defensive: scanLargestFileBytes always returns a number, but a malformed
  // input must never be classified ok (NaN >= floor is false, handled by !(>=)).
  const v = classifyElectronDist({ launcherExists: true, largestFileBytes: Number.NaN })
  assert.equal(v.ok, false)
  assert.equal(v.reason, 'truncated')
})
