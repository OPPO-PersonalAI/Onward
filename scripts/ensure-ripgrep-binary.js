/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

// Postinstall sanity gate for the bundled ripgrep binary.
//
// `@vscode/ripgrep` >= 1.18.0 ships rg[.exe] inside a per-platform package
// (`@vscode/ripgrep-<platform>-<arch>/bin/rg[.exe]`), pre-extracted and
// SHA256-verified at publish time. There is no install-time download/unzip
// step anymore — the old yauzl streaming-inflate path that truncated rg.exe on
// Node 24 (see docs/lessons.md) is gone, so this script no longer downloads
// anything. It now only VERIFIES the shipped binary, and intentionally checks
// SIZE in addition to mere existence: the previous version checked existence
// only, which let a truncated rg.exe ("it exists, so it's fine") slip through.
//
// The pure decision (`classifyRipgrepBinary`) is exported and unit-tested in
// test/unittest/ensure-ripgrep-binary.test.mjs — it pins exactly the
// existence-AND-size gap that caused the original incident.

const { existsSync, statSync } = require('fs')

// Integrity floor. Every platform's ripgrep build is several MB (win32-x64 is
// ~5.43 MB; the smallest cross-arch builds are still > 3 MB). A grossly
// truncated/empty binary falls well under this floor. With 1.18.0 truncation is
// structurally impossible (verbatim, SHA256-verified bytes), so this is a
// catastrophic-corruption / missing-platform-package guard, not the per-byte
// check the old download path needed.
const MIN_BINARY_BYTES = 2 * 1024 * 1024 // 2 MB

/**
 * Pure integrity decision for a resolved ripgrep binary.
 *
 * @param {{ existsOnDisk: boolean, sizeBytes: number, minBytes?: number }} input
 * @returns {{ ok: boolean, reason: 'ok' | 'missing' | 'truncated' }}
 */
function classifyRipgrepBinary({ existsOnDisk, sizeBytes, minBytes = MIN_BINARY_BYTES }) {
  if (!existsOnDisk) {
    return { ok: false, reason: 'missing' }
  }
  // Number.isFinite rejects NaN/Infinity so a malformed size can never pass the
  // `< minBytes` comparison (NaN comparisons are always false).
  if (!Number.isFinite(sizeBytes) || sizeBytes < minBytes) {
    return { ok: false, reason: 'truncated' }
  }
  return { ok: true, reason: 'ok' }
}

function resolveRipgrepBinaryPath() {
  const { createRequire } = require('module')
  const arch = process.arch
  const binaryName = process.platform === 'win32' ? 'rg.exe' : 'rg'
  const platformPkg = `@vscode/ripgrep-${process.platform}-${arch}`
  const specifier = `${platformPkg}/bin/${binaryName}`
  // Resolve the binary the same way the runtime consumer does
  // (electron/main/ripgrep-search.ts::resolveRipgrepBinaryPath):
  // (1) direct resolve for a hoisted/flat layout (npm), then (2) resolve via the
  // wrapper's own location for pnpm's strict layout, where the per-platform
  // package is only resolvable from WITHIN @vscode/ripgrep, not top-level.
  try {
    return { binaryPath: require.resolve(specifier), platformPkg }
  } catch {
    // require.resolve only resolves the path (does not load the ESM module).
    // 1.18.0's `exports` map blocks `/package.json`, so resolve the package
    // entry itself and scope createRequire to it.
    const wrapperEntry = require.resolve('@vscode/ripgrep')
    const binaryPath = createRequire(wrapperEntry).resolve(specifier)
    return { binaryPath, platformPkg }
  }
}

function ensureRipgrepBinary() {
  let binaryPath
  let platformPkg
  try {
    ;({ binaryPath, platformPkg } = resolveRipgrepBinaryPath())
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err)
    throw new Error(
      `Could not resolve the @vscode/ripgrep platform package for ` +
        `${process.platform}-${process.arch}. Ensure optionalDependencies are ` +
        `installed for this platform (run \`pnpm install\` WITHOUT --no-optional). ` +
        `Underlying error: ${detail}`
    )
  }

  const existsOnDisk = existsSync(binaryPath)
  const sizeBytes = existsOnDisk ? statSync(binaryPath).size : 0
  const verdict = classifyRipgrepBinary({ existsOnDisk, sizeBytes })

  if (!verdict.ok) {
    if (verdict.reason === 'missing') {
      throw new Error(
        `ripgrep binary missing after install: ${binaryPath} ` +
          `(platform package ${platformPkg}). Run \`pnpm install\`.`
      )
    }
    throw new Error(
      `ripgrep binary at ${binaryPath} is ${sizeBytes} bytes, below the ` +
        `${MIN_BINARY_BYTES}-byte integrity floor — it is truncated/corrupt. ` +
        `Remove node_modules and reinstall: \`pnpm install --force\`.`
    )
  }

  console.log(`[ripgrep] Binary OK: ${binaryPath} (${sizeBytes} bytes, ${platformPkg})`)
}

module.exports = { classifyRipgrepBinary, MIN_BINARY_BYTES }

// Only run the verification when invoked directly as the postinstall script;
// stay silent (export-only) when imported by the unit test.
if (require.main === module) {
  try {
    ensureRipgrepBinary()
  } catch (error) {
    console.error('[ripgrep] Binary verification failed.')
    console.error(error instanceof Error ? error.stack : error)
    process.exit(1)
  }
}
