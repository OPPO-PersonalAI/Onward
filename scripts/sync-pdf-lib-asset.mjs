#!/usr/bin/env node
/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 *
 * Copies the pdf-lib UMD bundle from node_modules into `resources/pdfjs/vendor/`.
 *
 *   node scripts/sync-pdf-lib-asset.mjs           copy
 *   node scripts/sync-pdf-lib-asset.mjs --check    verify only, never write
 *
 * Why a committed copy rather than bundling: the PDF viewer is a plain HTML
 * document loaded over `file://` inside a sandboxed iframe. It has no module
 * loader and no access to node_modules, so its dependencies have to sit next
 * to it as real files — the same arrangement the vendored pdf.js already uses.
 *
 * `--check` runs in the build. It fails when the committed copy has drifted
 * from the installed package, which is exactly what a `pnpm update` produces:
 * a viewer silently running a different pdf-lib than the lockfile claims.
 *
 * pdf-lib is MIT, compatible with this project's Apache-2.0.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const require = createRequire(import.meta.url)
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const DEST_DIR = join(ROOT, 'resources', 'pdfjs', 'vendor')
const DEST = join(DEST_DIR, 'pdf-lib.min.js')

function resolveSource() {
  const pkgPath = require.resolve('pdf-lib/package.json')
  return {
    file: join(dirname(pkgPath), 'dist', 'pdf-lib.min.js'),
    version: JSON.parse(readFileSync(pkgPath, 'utf8')).version
  }
}

const checkOnly = process.argv.includes('--check')

let source
try {
  source = resolveSource()
} catch {
  if (checkOnly && existsSync(DEST)) {
    // A packaging-only environment may not have devDependencies installed.
    // The committed asset is what ships, so its presence is enough.
    console.log('pdf-lib not installed; committed asset present — skipping check.')
    process.exit(0)
  }
  console.error('pdf-lib is not installed. Run: pnpm install')
  process.exit(1)
}

const bytes = readFileSync(source.file)

if (checkOnly) {
  if (!existsSync(DEST)) {
    console.error(`missing vendored asset: ${DEST}`)
    console.error('Run: node scripts/sync-pdf-lib-asset.mjs')
    process.exit(1)
  }
  if (!readFileSync(DEST).equals(bytes)) {
    console.error(`vendored pdf-lib differs from the installed package (${source.version}).`)
    console.error('Run: node scripts/sync-pdf-lib-asset.mjs')
    process.exit(1)
  }
  console.log(`pdf-lib ${source.version} vendored asset verified (${bytes.length} bytes)`)
} else {
  mkdirSync(DEST_DIR, { recursive: true })
  writeFileSync(DEST, bytes)
  console.log(`wrote ${DEST} from pdf-lib ${source.version} (${bytes.length} bytes)`)
}
