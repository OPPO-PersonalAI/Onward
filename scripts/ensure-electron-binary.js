/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

// Postinstall integrity gate + self-heal for the Electron binary.
//
// electron's own postinstall (`node_modules/electron/install.js`) downloads the
// platform zip via @electron/get and extracts it with `extract-zip`, which uses
// yauzl. On Node 24, yauzl's streaming inflate truncates/skips zip entries whose
// uncompressed size exceeds ~5 MB (see docs/lessons.md) — so the ~200 MB
// electron binary entry is dropped, leaving a partial dist/ (only the small
// `locales/` entries) and NO path.txt. The build then fails because
// electron-builder cannot find the binary.
//
// The download itself is fine (plain HTTP, no yauzl) — only the EXTRACTION
// breaks — so the cached zip is intact. This gate verifies the extracted binary
// and, if missing/truncated, RE-EXTRACTS the cached zip with a NON-yauzl,
// platform-native extractor (PowerShell Expand-Archive / ditto / unzip) and
// writes path.txt. It is a no-op on a healthy extraction.

const { existsSync, statSync, readFileSync, writeFileSync, rmSync, readdirSync } = require('fs')
const { join, resolve } = require('path')
const { spawnSync } = require('child_process')

// Every platform's Electron executable is >100 MB; a truncated/absent one is far
// below this floor.
const MIN_BINARY_BYTES = 50 * 1024 * 1024 // 50 MB

const ELECTRON_DIR = resolve(__dirname, '..', 'node_modules', 'electron')

// Relative path (inside dist/) of the executable electron's path.txt points at.
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

function isHealthy(distDir) {
  const bin = join(distDir, binaryRelPath())
  if (!existsSync(bin)) return false
  try {
    return statSync(bin).size >= MIN_BINARY_BYTES
  } catch {
    return false
  }
}

function ensureElectronBinary() {
  if (!existsSync(ELECTRON_DIR)) {
    // electron not installed yet — nothing this gate can do; let the caller fail.
    console.log('[electron] node_modules/electron absent — skipping integrity gate')
    return
  }
  const distDir = join(ELECTRON_DIR, 'dist')
  const pathTxt = join(ELECTRON_DIR, 'path.txt')

  if (existsSync(pathTxt) && isHealthy(distDir)) {
    console.log('[electron] Binary OK:', join(distDir, binaryRelPath()))
    return
  }

  const version = readVersion()
  console.log(
    `[electron] dist/ is incomplete (yauzl/Node24 truncation symptom) — re-extracting electron v${version}`
  )
  const zip = findCachedZip(version)
  if (!zip) {
    throw new Error(
      `Could not find the cached electron-v${version}-${process.platform}-${process.arch}.zip ` +
        `under the @electron/get cache. Re-run \`node node_modules/electron/install.js\` to ` +
        `download it, then re-run this script.`
    )
  }

  // Clear the partial extraction so the re-extract is clean.
  rmSync(distDir, { recursive: true, force: true })
  extractZip(zip, distDir)

  if (!isHealthy(distDir)) {
    throw new Error(
      `electron binary still missing/truncated after re-extracting ${zip} into ${distDir}`
    )
  }
  writeFileSync(pathTxt, binaryRelPath(), { encoding: 'utf8' })
  const bin = join(distDir, binaryRelPath())
  console.log(`[electron] Re-extracted OK: ${bin} (${statSync(bin).size} bytes) from ${zip}`)
}

try {
  ensureElectronBinary()
} catch (error) {
  console.error('[electron] Binary verification/heal failed.')
  console.error(error instanceof Error ? error.stack : error)
  process.exit(1)
}
