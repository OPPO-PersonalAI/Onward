/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 *
 * Unit tests for scripts/normalize-notices.js: the pure-logic that turns the
 * license-checker output (ThirdPartyNotices.txt) into a platform-INDEPENDENT
 * form. The decisive property is NN-U-02 cross-platform invariance: feeding the
 * macOS-installed variant (`*-darwin-arm64`) and the Windows-installed variant
 * (`*-win32-x64`) of the same family must yield byte-identical output, which is
 * what kills the per-platform git churn this change exists to fix.
 *
 * There is no paired autotest for this change: normalize-notices.js is a
 * build-time pure-text transform with no runtime UI / IPC / DOM surface to
 * exercise, so this unit layer is the complete coverage (see the project's
 * "unit test + autotest as a paired deliverable" rule, which allows an explicit
 * single-layer exemption when one layer genuinely has nothing to test).
 *
 * Usage: node --experimental-strip-types --test test/unittest/third-party-notices-normalize.test.mjs
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { normalizeNotices, dropPlatformVariantBlocks, parseBlocks, normalizeWhitespace } = require('../../scripts/normalize-notices.js')

// Build one license-checker plainVertical block: header line, license id, then
// a short body. License text is irrelevant to the logic, only the header +
// license-id lines drive behaviour.
function block(name, version, licenseId = 'MIT', holder = 'Devon Govett') {
  return [
    `${name} ${version}`,
    licenseId,
    `${licenseId} License`,
    '',
    `Copyright (c) ${holder}`,
    '',
    'Permission is hereby granted, free of charge, to any person ...',
    'SOFTWARE.',
  ].join('\n')
}

// Assemble blocks into a notices document: two blank lines between blocks, one
// trailing newline -- matching license-checker-rseidelsohn --plainVertical.
function doc(...blocks) {
  return blocks.join('\n\n\n') + '\n'
}

// ─────────────── NN-U-01..10 platform-variant collapse + invariance ───────────────

test('NN-U-01 platform variant collapses onto same-version, same-license base', () => {
  const input = doc(
    block('@parcel/watcher-win32-x64', '2.5.6'),
    block('@parcel/watcher', '2.5.6'),
    block('dompurify', '3.3.3'),
  )
  const out = normalizeNotices(input)
  assert.ok(!out.includes('@parcel/watcher-win32-x64'), 'variant block must be removed')
  assert.ok(out.includes('@parcel/watcher 2.5.6'), 'base block must survive')
  assert.ok(out.includes('dompurify 3.3.3'), 'unrelated block untouched')
})

test('NN-U-02 cross-platform invariance: darwin and win32 inputs yield identical output', () => {
  const darwin = doc(
    block('@parcel/watcher-darwin-arm64', '2.5.6'),
    block('@parcel/watcher', '2.5.6'),
    block('@vscode/ripgrep-darwin-arm64', '1.18.0'),
    block('@vscode/ripgrep', '1.18.0'),
    block('dompurify', '3.3.3'),
  )
  const win32 = doc(
    block('@parcel/watcher-win32-x64', '2.5.6'),
    block('@parcel/watcher', '2.5.6'),
    block('@vscode/ripgrep-win32-x64', '1.18.0'),
    block('@vscode/ripgrep', '1.18.0'),
    block('dompurify', '3.3.3'),
  )
  const linux = doc(
    block('@parcel/watcher-linux-x64-glibc', '2.5.6'),
    block('@parcel/watcher', '2.5.6'),
    block('@vscode/ripgrep-linux-x64', '1.18.0'),
    block('@vscode/ripgrep', '1.18.0'),
    block('dompurify', '3.3.3'),
  )
  const outDarwin = normalizeNotices(darwin)
  const outWin32 = normalizeNotices(win32)
  const outLinux = normalizeNotices(linux)
  assert.equal(outDarwin, outWin32, 'macOS and Windows builds must produce the same notices')
  assert.equal(outDarwin, outLinux, 'Linux build must produce the same notices too')
  // And the canonical result is the base-only document.
  const neutral = normalizeNotices(doc(
    block('@parcel/watcher', '2.5.6'),
    block('@vscode/ripgrep', '1.18.0'),
    block('dompurify', '3.3.3'),
  ))
  assert.equal(outDarwin, neutral)
})

test('NN-U-03 variant with NO base present is kept (fail-safe)', () => {
  const input = doc(
    block('@parcel/watcher-win32-x64', '2.5.6'),
    block('dompurify', '3.3.3'),
  )
  const out = normalizeNotices(input)
  assert.ok(out.includes('@parcel/watcher-win32-x64 2.5.6'), 'no base -> never drop a license')
})

test('NN-U-04 variant with base at a DIFFERENT version is kept', () => {
  const input = doc(
    block('@parcel/watcher-win32-x64', '2.5.6'),
    block('@parcel/watcher', '2.4.0'),
  )
  const out = normalizeNotices(input)
  assert.ok(out.includes('@parcel/watcher-win32-x64 2.5.6'), 'version mismatch -> keep variant')
  assert.ok(out.includes('@parcel/watcher 2.4.0'))
})

test('NN-U-05 variant whose license DIFFERS from base is kept (VS Code sharp guard)', () => {
  // Parent MIT, arch child carries an extra copyleft term -> must NOT be collapsed.
  const input = doc(
    block('@img/sharp-win32-x64', '0.34.0', 'Apache-2.0 AND LGPL-3.0-or-later'),
    block('@img/sharp', '0.34.0', 'Apache-2.0'),
  )
  const out = normalizeNotices(input)
  assert.ok(out.includes('@img/sharp-win32-x64 0.34.0'), 'divergent license -> keep variant')
  assert.ok(out.includes('Apache-2.0 AND LGPL-3.0-or-later'))
})

test('NN-U-06 idempotent: normalizing twice equals normalizing once', () => {
  const input = doc(
    block('@parcel/watcher-darwin-arm64', '2.5.6'),
    block('@parcel/watcher', '2.5.6'),
    block('dompurify', '3.3.3'),
  )
  const once = normalizeNotices(input)
  const twice = normalizeNotices(once)
  assert.equal(once, twice)
})

test('NN-U-07 whitespace: CRLF -> LF and trailing whitespace stripped', () => {
  const crlf = 'dompurify 3.3.3\r\nMIT\r\nMIT License   \r\nSOFTWARE.\r\n'
  const out = normalizeNotices(crlf)
  assert.ok(!out.includes('\r'), 'no carriage returns survive')
  assert.ok(!/[ \t]+\n/.test(out), 'no trailing whitespace survives')
})

test('NN-U-08 a clean (variant-free) document is preserved except trailing newline', () => {
  const input = doc(
    block('@parcel/watcher', '2.5.6'),
    block('dompurify', '3.3.3'),
  )
  const out = normalizeNotices(input)
  assert.equal(out, input, 'no variants -> output equals input verbatim')
})

test('NN-U-09 multiple families collapse; order and unrelated entries preserved', () => {
  const input = doc(
    block('@monaco-editor/react', '4.7.0'),
    block('@parcel/watcher-win32-x64', '2.5.6'),
    block('@parcel/watcher', '2.5.6'),
    block('@vscode/ripgrep-win32-x64', '1.18.0'),
    block('@vscode/ripgrep', '1.18.0'),
    block('better-sqlite3', '12.8.0'),
  )
  const out = normalizeNotices(input)
  const blocks = parseBlocks(out).filter((b) => b.name)
  const names = blocks.map((b) => b.name)
  assert.deepEqual(names, [
    '@monaco-editor/react',
    '@parcel/watcher',
    '@vscode/ripgrep',
    'better-sqlite3',
  ], 'variants removed, remaining order intact')
})

test('NN-U-10 linux ABI-tagged variants (glibc/musl) collapse too', () => {
  for (const variant of ['@parcel/watcher-linux-x64-glibc', '@parcel/watcher-linux-arm64-musl']) {
    const input = doc(block(variant, '2.5.6'), block('@parcel/watcher', '2.5.6'))
    const out = normalizeNotices(input)
    assert.ok(!out.includes(variant), `${variant} must collapse onto base`)
    assert.ok(out.includes('@parcel/watcher 2.5.6'))
  }
})

test('NN-U-11 normalizeWhitespace and dropPlatformVariantBlocks are exported pure fns', () => {
  // Guards the module contract the script and this test both depend on.
  assert.equal(typeof normalizeNotices, 'function')
  assert.equal(typeof dropPlatformVariantBlocks, 'function')
  assert.equal(typeof parseBlocks, 'function')
  assert.equal(typeof normalizeWhitespace, 'function')
})
