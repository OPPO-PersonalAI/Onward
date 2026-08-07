#!/usr/bin/env node
/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 *
 * Applies Onward's private patches to the vendored pdf.js build.
 *
 *   node scripts/apply-pdfjs-patches.mjs           apply (idempotent)
 *   node scripts/apply-pdfjs-patches.mjs --check    verify only, never write
 *
 * `--check` is what CI and the trace/self-check suites run: it exits non-zero
 * if any hunk is neither applied nor applicable, which is exactly the state a
 * pdf.js version bump leaves behind.
 *
 * Cross-platform by construction: pure Node string operations, no `patch(1)`,
 * no shell, no platform-specific path handling.
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

// Lives under infra/ rather than patches/ — the latter is pnpm's
// `patchedDependencies` directory, and resources/ ships inside the packaged
// app, where patch definitions have no business being.
import { PATCHES, PATCH_GROUPS, PDFJS_VERSION } from '../infra/pdfjs-patches/patches.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const PDFJS_DIR = join(ROOT, 'resources', 'pdfjs')

const checkOnly = process.argv.includes('--check')
const verbose = process.argv.includes('--verbose')

/** @type {Map<string, string>} */
const loaded = new Map()

function read(relative) {
  if (!loaded.has(relative)) {
    loaded.set(relative, readFileSync(join(PDFJS_DIR, relative), 'utf8'))
  }
  return loaded.get(relative)
}

function classify(patch) {
  const source = read(patch.file)
  // `replace` first: once applied, `find` is usually gone, but a hunk whose
  // replacement merely *adds* lines can still contain the original text as a
  // substring. Checking the replacement first keeps those idempotent too.
  if (source.includes(patch.replace)) return 'already-applied'
  if (source.includes(patch.find)) return 'applicable'
  return 'stale'
}

const results = []
let mutated = false

for (const patch of PATCHES) {
  const state = classify(patch)
  results.push({ patch, state })
  if (state !== 'applicable' || checkOnly) continue

  const source = read(patch.file)
  const first = source.indexOf(patch.find)
  const last = source.lastIndexOf(patch.find)
  if (first !== last) {
    results[results.length - 1].state = 'ambiguous'
    continue
  }
  loaded.set(patch.file, source.replace(patch.find, patch.replace))
  results[results.length - 1].state = 'applied'
  mutated = true
}

if (mutated) {
  for (const [relative, contents] of loaded) {
    writeFileSync(join(PDFJS_DIR, relative), contents)
  }
}

const counts = results.reduce((acc, r) => {
  acc[r.state] = (acc[r.state] || 0) + 1
  return acc
}, {})

console.log(`pdf.js ${PDFJS_VERSION} — ${PATCHES.length} hunk(s) in ${new Set(PATCHES.map(p => p.file)).size} file(s)`)
for (const [state, count] of Object.entries(counts)) {
  console.log(`  ${state}: ${count}`)
}

if (verbose) {
  for (const { patch, state } of results) {
    console.log(`  [${state}] ${patch.file} :: ${patch.id} (${patch.group})`)
  }
}

const broken = results.filter(r => r.state === 'stale' || r.state === 'ambiguous')
if (broken.length > 0) {
  console.error('')
  console.error('The following hunks no longer match the vendored bundle:')
  for (const { patch, state } of broken) {
    console.error(`  ${state.toUpperCase()}  ${patch.file} :: ${patch.id}`)
    console.error(`         group: ${patch.group} — ${PATCH_GROUPS[patch.group]}`)
    console.error(`         why:   ${patch.why}`)
  }
  console.error('')
  console.error('This normally means pdf.js was upgraded. Re-derive each hunk against')
  console.error('the new bundle and update patches/pdfjs/patches.mjs before shipping —')
  console.error('silently dropping them regresses text-selection correctness.')
  process.exit(1)
}

if (checkOnly && counts['applicable']) {
  console.error('')
  console.error(`${counts['applicable']} hunk(s) are not applied. Run: node scripts/apply-pdfjs-patches.mjs`)
  process.exit(1)
}

console.log(mutated ? 'pdf.js patches applied.' : 'pdf.js patches verified.')
