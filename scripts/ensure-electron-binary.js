/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

// Postinstall integrity gate + self-heal for the Electron binary.
//
// electron's own postinstall (`node_modules/electron/install.js`) downloads the
// platform zip via @electron/get and extracts it with `extract-zip`, which uses
// yauzl. On Node 24+, yauzl's streaming inflate truncates/skips zip entries
// whose uncompressed size exceeds ~5 MB (see docs/lessons.md) — so the heavy
// electron payload entry is dropped, leaving a partial dist/ (only the small
// entries) and NO path.txt. The build then fails because electron-builder
// cannot find the binary.
//
// The download itself is fine (plain HTTP, no yauzl) — only the EXTRACTION
// breaks — so the cached zip is intact. This gate verifies the extracted dist
// and, if truncated, RE-EXTRACTS the cached zip with a NON-yauzl, platform-
// native extractor (PowerShell Expand-Archive / ditto / unzip) and writes
// path.txt. It is a no-op on a healthy extraction.
//
// CROSS-PLATFORM HEALTH SIGNAL — why we check the LARGEST file, not a fixed
// path. The ">100 MB" payload lives in a DIFFERENT file on each platform:
//   - Windows: electron.exe                          (the launcher IS heavy)
//   - Linux:   electron                              (the launcher IS heavy)
//   - macOS:   Electron.app/Contents/Frameworks/Electron Framework.framework/
//              Versions/A/Electron Framework         (~170 MB dylib)
//              while the launcher Contents/MacOS/Electron is only a ~34-50 KB
//              stub.
// So checking "path.txt's launcher >= 50 MB" is WRONG on macOS — the launcher
// stub never reaches 50 MB even on a perfectly healthy extraction. yauzl
// truncation drops whichever entry is the heavy one, so the platform-agnostic
// signal is: "does the extracted dist still contain at least one very large
// file?" We verify the launcher EXISTS (so path.txt is valid) AND that the
// single largest file under dist/ clears the size floor. This stays unified
// across all three platforms without per-platform size branching and is robust
// to where each platform happens to put its heavy binary.

const { existsSync, statSync, readFileSync, writeFileSync, rmSync, readdirSync } = require('fs')
const { join, resolve } = require('path')
const { spawnSync } = require('child_process')

// Every platform ships a single Electron payload file >100 MB (electron.exe /
// electron / the macOS Electron Framework dylib). A truncated extraction drops
// it, so the largest surviving file falls far below this floor.
const MIN_BINARY_BYTES = 50 * 1024 * 1024 // 50 MB

const ELECTRON_DIR = resolve(__dirname, '..', 'node_modules', 'electron')

// Relative path (inside dist/) of the executable electron's path.txt points at.
// NOTE: on macOS this is the small LAUNCHER STUB, not the heavy payload — its
// existence makes path.txt valid, but its size must NOT be size-floored.
function binaryRelPath() {
  if (process.platform === 'win32') return 'electron.exe'
  if (process.platform === 'darwin') return 'Electron.app/Contents/MacOS/Electron'
  return 'electron'
}

function readVersion() {
  const pkg = JSON.parse(readFileSync(join(ELECTRON_DIR, 'package.json'), 'utf8'))
  return pkg.version
}

// @electron/get cache roots, per platform, plus the documented override.
function cacheRoots() {
  const roots = []
  if (process.env.electron_config_cache) roots.push(process.env.electron_config_cache)
  if (process.platform === 'win32') {
    if (process.env.LOCALAPPDATA) roots.push(join(process.env.LOCALAPPDATA, 'electron', 'Cache'))
  } else if (process.platform === 'darwin') {
    if (process.env.HOME) roots.push(join(process.env.HOME, 'Library', 'Caches', 'electron'))
  } else {
    const xdg = process.env.XDG_CACHE_HOME || (process.env.HOME && join(process.env.HOME, '.cache'))
    if (xdg) roots.push(join(xdg, 'electron'))
  }
  return roots
}

// Find the cached `electron-v<version>-<platform>-<arch>.zip` anywhere under a
// cache root (it is stored both at the root and inside a sha-hash subdir).
function findCachedZip(version) {
  const zipName = `electron-v${version}-${process.platform}-${process.arch}.zip`
  for (const root of cacheRoots()) {
    if (!existsSync(root)) continue
    const direct = join(root, zipName)
    if (existsSync(direct)) return direct
    // Scan one level of hash subdirectories.
    let entries = []
    try {
      entries = readdirSync(root, { withFileTypes: true })
    } catch {
      continue
    }
    for (const ent of entries) {
      if (!ent.isDirectory()) continue
      const nested = join(root, ent.name, zipName)
      if (existsSync(nested)) return nested
    }
  }
  return null
}

function extractZip(zipPath, destDir) {
  // Platform-native, non-yauzl extractors. ditto/unzip preserve the symlinks and
  // executable bits inside the macOS .app and Linux trees; Expand-Archive is
  // fine on Windows (flat files, no symlinks).
  let cmd
  let args
  if (process.platform === 'win32') {
    cmd = 'powershell'
    args = [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      `Expand-Archive -LiteralPath '${zipPath}' -DestinationPath '${destDir}' -Force`
    ]
  } else if (process.platform === 'darwin') {
    cmd = 'ditto'
    args = ['-x', '-k', zipPath, destDir]
  } else {
    cmd = 'unzip'
    args = ['-o', '-q', zipPath, '-d', destDir]
  }
  const res = spawnSync(cmd, args, { stdio: 'inherit' })
  if (res.status !== 0) {
    throw new Error(`extraction via ${cmd} failed with status ${res.status}`)
  }
}

// Largest regular-file size (bytes) anywhere under dir. This is the platform-
// agnostic truncation probe: yauzl drops the single heavy entry, so a healthy
// extraction always contains at least one very large file (the electron.exe /
// electron / Electron Framework dylib) while a truncated one does not.
// Symlinks are skipped so the macOS .app's `Versions/Current -> A` and
// `Electron Framework -> Versions/Current/Electron Framework` aliases are not
// followed — the real file under `Versions/A/` is still counted directly.
function scanLargestFileBytes(dir) {
  let max = 0
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return max
  }
  for (const ent of entries) {
    if (ent.isSymbolicLink()) continue
    const full = join(dir, ent.name)
    if (ent.isDirectory()) {
      const childMax = scanLargestFileBytes(full)
      if (childMax > max) max = childMax
    } else if (ent.isFile()) {
      try {
        const size = statSync(full).size
        if (size > max) max = size
      } catch {
        // Unreadable entry — ignore; another file carries the heavy signal.
      }
    }
  }
  return max
}

// Pure integrity decision for an extracted electron dist/, factored out so it
// can be unit-tested without a filesystem. Inputs:
//   - launcherExists:   does path.txt's target (the platform launcher) exist?
//                       On macOS this is the small Contents/MacOS/Electron stub
//                       (~34-50 KB); on Windows/Linux it is the heavy
//                       electron.exe / electron. Its EXISTENCE (not its size)
//                       is what makes path.txt valid.
//   - largestFileBytes: size of the single biggest file under dist/. The
//                       platform-agnostic truncation signal — a healthy dist
//                       always has one file >= minBytes regardless of WHICH
//                       file that is.
// Returns { ok, reason } with reason in 'ok' | 'missing' | 'truncated'.
function classifyElectronDist({ launcherExists, largestFileBytes, minBytes = MIN_BINARY_BYTES }) {
  if (!launcherExists) return { ok: false, reason: 'missing' }
  // `!(x >= min)` (not `x < min`) so a NaN/garbage size is treated as truncated,
  // never silently passed.
  if (!(largestFileBytes >= minBytes)) return { ok: false, reason: 'truncated' }
  return { ok: true, reason: 'ok' }
}

// Gather the filesystem facts for distDir and run the pure decision.
function inspectDist(distDir) {
  const launcherExists = existsSync(join(distDir, binaryRelPath()))
  const largestFileBytes = launcherExists ? scanLargestFileBytes(distDir) : 0
  return { ...classifyElectronDist({ launcherExists, largestFileBytes }), largestFileBytes }
}

function ensureElectronBinary() {
  if (!existsSync(ELECTRON_DIR)) {
    // electron not installed yet — nothing this gate can do; let the caller fail.
    console.log('[electron] node_modules/electron absent — skipping integrity gate')
    return
  }
  const distDir = join(ELECTRON_DIR, 'dist')
  const pathTxt = join(ELECTRON_DIR, 'path.txt')

  if (existsSync(pathTxt)) {
    const verdict = inspectDist(distDir)
    if (verdict.ok) {
      console.log(
        `[electron] Binary OK: ${join(distDir, binaryRelPath())} ` +
          `(largest dist file ${verdict.largestFileBytes} bytes)`
      )
      return
    }
  }

  const version = readVersion()
  console.log(
    `[electron] dist/ is incomplete (yauzl/Node24 truncation symptom) — re-extracting electron v${version}`
  )
  let zip = findCachedZip(version)
  if (!zip) {
    // Electron 42+ no longer downloads the binary from its own postinstall
    // (deferred to the first bin run), so a fresh install legitimately has
    // neither dist/ nor a cached zip. Trigger the official downloader
    // ourselves to keep the install chain zero-intervention.
    console.log(
      `[electron] No cached zip for v${version} (Electron 42+ defers the download) — running node_modules/electron/install.js`
    )
    const { execFileSync } = require('node:child_process')
    execFileSync(process.execPath, [join(ELECTRON_DIR, 'install.js')], { stdio: 'inherit' })
    // install.js extracts dist/ itself; accept a now-healthy dist directly.
    const healedVerdict = inspectDist(distDir)
    if (healedVerdict.ok) {
      writeFileSync(pathTxt, binaryRelPath(), { encoding: 'utf8' })
      console.log(
        `[electron] Downloaded and extracted OK via install.js: ${join(distDir, binaryRelPath())} ` +
          `(largest dist file ${healedVerdict.largestFileBytes} bytes)`
      )
      return
    }
    zip = findCachedZip(version)
  }
  if (!zip) {
    throw new Error(
      `Could not find the cached electron-v${version}-${process.platform}-${process.arch}.zip ` +
        `under the @electron/get cache even after running node_modules/electron/install.js. ` +
        `Check network access to the Electron release mirror, then re-run pnpm install.`
    )
  }

  // Clear the partial extraction so the re-extract is clean.
  rmSync(distDir, { recursive: true, force: true })
  extractZip(zip, distDir)

  const verdict = inspectDist(distDir)
  if (!verdict.ok) {
    throw new Error(
      `electron dist still ${verdict.reason} after re-extracting ${zip} into ${distDir} ` +
        `(largest dist file ${verdict.largestFileBytes} bytes, floor ${MIN_BINARY_BYTES})`
    )
  }
  writeFileSync(pathTxt, binaryRelPath(), { encoding: 'utf8' })
  const bin = join(distDir, binaryRelPath())
  console.log(
    `[electron] Re-extracted OK: ${bin} (largest dist file ${verdict.largestFileBytes} bytes) from ${zip}`
  )
}

module.exports = { classifyElectronDist, MIN_BINARY_BYTES }

// Only run the verification when invoked directly as the postinstall script;
// stay silent (export-only) when imported by the unit test.
if (require.main === module) {
  try {
    ensureElectronBinary()
  } catch (error) {
    console.error('[electron] Binary verification/heal failed.')
    console.error(error instanceof Error ? error.stack : error)
    process.exit(1)
  }
}
