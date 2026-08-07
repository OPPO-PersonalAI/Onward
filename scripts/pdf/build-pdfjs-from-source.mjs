#!/usr/bin/env node
/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 *
 * Source-build pipeline for the vendored pdf.js: clone the upstream tag,
 * apply Onward's private patches at SOURCE level (infra/pdfjs-patches/
 * source-patches.mjs), build with pdf.js's own gulp toolchain, and compare
 * or sync the resulting artefacts into resources/pdfjs/build/.
 *
 * This is the UPGRADE path, not part of the normal dist build: the committed
 * artefacts stay the source of truth, so users and CI never need this
 * toolchain. Bumping pdf.js becomes:
 *
 *   1. Edit PDFJS_VERSION in infra/pdfjs-patches/source-patches.mjs.
 *   2. node scripts/pdf/build-pdfjs-from-source.mjs --patch-check
 *      → re-anchor any stale hunks against the (readable) new source.
 *   3. node scripts/pdf/build-pdfjs-from-source.mjs --build
 *      → clones + patches + npm ci + gulp generic (needs network; minutes).
 *   4. node scripts/pdf/build-pdfjs-from-source.mjs --diff
 *      → shows how the fresh build differs from the committed artefacts.
 *   5. node scripts/pdf/build-pdfjs-from-source.mjs --sync
 *      → copies pdf.js / pdf.worker.js into resources/pdfjs/build/, then
 *        re-anchor infra/pdfjs-patches/patches.mjs (the artefact-level guard)
 *        and run the full PDF suite battery.
 *
 * Modes:
 *   --clone         fetch/refresh the upstream checkout only
 *   --patch-check   verify the source hunks against the checkout (no write)
 *   --patch         apply the source hunks into the checkout
 *   --build         clone + patch + npm ci + gulp generic
 *   --diff          compare built artefacts vs committed (metadata-tolerant)
 *   --sync          copy built artefacts over resources/pdfjs/build/
 *
 * The checkout lives in the OS temp dir by default (no repo pollution);
 * override with ONWARD_PDFJS_WORK_DIR to keep a persistent checkout across
 * runs (recommended while iterating on an upgrade).
 */

import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import {
  PDFJS_REPO,
  PDFJS_TAG,
  PDFJS_VERSION,
  SOURCE_PATCHES
} from '../../infra/pdfjs-patches/source-patches.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const COMMITTED_BUILD_DIR = join(ROOT, 'resources', 'pdfjs', 'build')
const WORK_DIR = process.env.ONWARD_PDFJS_WORK_DIR
  || join(tmpdir(), `onward-pdfjs-src-${PDFJS_VERSION}`)
const BUILT_DIR = join(WORK_DIR, 'build', 'generic', 'build')

const args = new Set(process.argv.slice(2))
const wants = (flag) => args.has(flag)

function run(command, commandArgs, options = {}) {
  execFileSync(command, commandArgs, {
    stdio: 'inherit',
    cwd: options.cwd ?? WORK_DIR,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }
  })
}

function ensureCheckout() {
  if (existsSync(join(WORK_DIR, '.git'))) {
    console.log(`checkout present: ${WORK_DIR}`)
    return
  }
  mkdirSync(WORK_DIR, { recursive: true })
  console.log(`cloning ${PDFJS_REPO} @ ${PDFJS_TAG} → ${WORK_DIR}`)
  run('git', ['clone', '--depth', '1', '--branch', PDFJS_TAG, PDFJS_REPO, WORK_DIR], { cwd: ROOT })
}

function classifyPatch(patch, source) {
  if (source.includes(patch.replace)) return 'already-applied'
  const first = source.indexOf(patch.find)
  if (first < 0) return 'stale'
  if (first !== source.lastIndexOf(patch.find)) return 'ambiguous'
  return 'applicable'
}

function applySourcePatches({ checkOnly }) {
  const loaded = new Map()
  const read = (relative) => {
    if (!loaded.has(relative)) loaded.set(relative, readFileSync(join(WORK_DIR, relative), 'utf8'))
    return loaded.get(relative)
  }

  const results = []
  let mutated = false
  for (const patch of SOURCE_PATCHES) {
    const state = classifyPatch(patch, read(patch.file))
    results.push({ patch, state })
    if (state !== 'applicable' || checkOnly) continue
    loaded.set(patch.file, read(patch.file).replace(patch.find, patch.replace))
    results[results.length - 1].state = 'applied'
    mutated = true
  }
  if (mutated) {
    for (const [relative, contents] of loaded) writeFileSync(join(WORK_DIR, relative), contents)
  }

  const counts = {}
  for (const { state } of results) counts[state] = (counts[state] || 0) + 1
  console.log(`source patches vs pdf.js ${PDFJS_VERSION}:`, counts)

  const broken = results.filter(r => r.state === 'stale' || r.state === 'ambiguous')
  if (broken.length > 0) {
    console.error('\nHunks that no longer anchor into the source tree:')
    for (const { patch, state } of broken) {
      console.error(`  ${state.toUpperCase()}  ${patch.file} :: ${patch.id}`)
      console.error(`         why: ${patch.why}`)
    }
    console.error('\nRe-anchor them in infra/pdfjs-patches/source-patches.mjs (the source is')
    console.error('readable — this is exactly why the source-level path exists).')
    process.exit(1)
  }
  return counts
}

function buildGeneric() {
  console.log('npm ci (pdf.js toolchain — this takes a few minutes)…')
  // --ignore-scripts: pdf.js's devDependency `canvas` (Node-side rasteriser,
  // used only by its own test targets) ships no prebuilt binary for current
  // Node ABIs and its source build needs system cairo. `gulp generic` never
  // loads it, so skipping install scripts keeps the pipeline working on any
  // modern Node instead of being hostage to that module's ABI matrix.
  run('npm', ['ci', '--no-audit', '--no-fund', '--ignore-scripts'])
  console.log('gulp generic…')
  // Explicit --gulpfile: the bundled gulp-cli's auto-detection predates .mjs
  // gulpfiles on current Node and reports "No gulpfile found" without it.
  run('node', ['node_modules/gulp/bin/gulp.js', '--gulpfile', 'gulpfile.mjs', 'generic'])
}

/**
 * Lines that legitimately differ between a local build and the upstream dist
 * artefact:
 *   - version stamps: the release pipeline stamps the tag version (3.11.174)
 *     while an in-tree build reads pdfjs.config (3.11.0);
 *   - commit hashes, whose abbreviation length depends on the local git.
 * Everything else must match — with one documented exception: formatting
 * INSIDE our own patch regions may differ, because the committed artefacts
 * carry the hand-formatted artefact-level hunks (patches.mjs) while a source
 * build runs the source-level hunks through Babel's code generator.
 * Verified against v3.11.174 on 2026-08-01: pdf.js matched byte-for-byte
 * after this normalisation; pdf.worker.js differed only in the
 * track-extgstate-alpha hunk's line wrapping.
 */
function normalizeArtifact(text) {
  return text
    .replace(/\b3\.11\.\d+\b/g, '3.11.X')
    .replace(/pdfjsBuild = ['"][0-9a-f]*['"]/g, "pdfjsBuild = 'X'")
    .replace(/const build = ['"][0-9a-f]*['"]/g, "const build = 'X'")
    .replace(/build:\s*['"][0-9a-f]*['"]/g, "build: 'X'")
}

function diffArtifacts() {
  let equivalent = true
  for (const name of ['pdf.js', 'pdf.worker.js']) {
    const builtPath = join(BUILT_DIR, name)
    const committedPath = join(COMMITTED_BUILD_DIR, name)
    if (!existsSync(builtPath)) {
      console.error(`missing built artefact: ${builtPath} — run --build first`)
      process.exit(1)
    }
    const built = normalizeArtifact(readFileSync(builtPath, 'utf8'))
    const committed = normalizeArtifact(readFileSync(committedPath, 'utf8'))
    if (built === committed) {
      console.log(`${name}: EQUIVALENT to committed artefact (modulo version metadata)`)
      continue
    }
    equivalent = false
    const builtLines = built.split('\n')
    const committedLines = committed.split('\n')
    let firstDiff = -1
    for (let i = 0; i < Math.max(builtLines.length, committedLines.length); i += 1) {
      if (builtLines[i] !== committedLines[i]) { firstDiff = i; break }
    }
    console.log(`${name}: DIFFERS (built ${builtLines.length} lines, committed ${committedLines.length}); first divergence at line ${firstDiff + 1}`)
    console.log(`  built:     ${(builtLines[firstDiff] ?? '<EOF>').slice(0, 160)}`)
    console.log(`  committed: ${(committedLines[firstDiff] ?? '<EOF>').slice(0, 160)}`)
  }
  return equivalent
}

function syncArtifacts() {
  for (const name of ['pdf.js', 'pdf.worker.js']) {
    copyFileSync(join(BUILT_DIR, name), join(COMMITTED_BUILD_DIR, name))
    console.log(`synced ${name} → resources/pdfjs/build/`)
  }
  console.log('\nNext: re-anchor infra/pdfjs-patches/patches.mjs against the new artefacts')
  console.log('(node scripts/apply-pdfjs-patches.mjs --check) and run the PDF suite battery.')
}

if (!wants('--clone') && !wants('--patch-check') && !wants('--patch') && !wants('--build') && !wants('--diff') && !wants('--sync')) {
  console.log('Usage: node scripts/pdf/build-pdfjs-from-source.mjs --clone|--patch-check|--patch|--build|--diff|--sync')
  console.log(`work dir: ${WORK_DIR} (override with ONWARD_PDFJS_WORK_DIR)`)
  process.exit(0)
}

if (wants('--clone') || wants('--patch-check') || wants('--patch') || wants('--build')) {
  ensureCheckout()
}
if (wants('--patch-check')) {
  applySourcePatches({ checkOnly: true })
}
if (wants('--patch') || wants('--build')) {
  applySourcePatches({ checkOnly: false })
}
if (wants('--build')) {
  buildGeneric()
}
if (wants('--diff')) {
  diffArtifacts()
}
if (wants('--sync')) {
  syncArtifacts()
}
