/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 *
 * Builds the subpage-outline-cpu fixture: a git repo whose main file is a
 * generated HTML document with ~40k elements (mirroring the real-world
 * report that Monaco's HTML symbol provider turns into ~40k outline
 * symbols), plus a second committed file and a working-tree modification so
 * Git Diff / Git History have content.
 *
 * Usage: node create-subpage-outline-cpu-fixture.mjs <target-dir>
 */

import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const targetDir = process.argv[2]
if (!targetDir) {
  console.error('Usage: node create-subpage-outline-cpu-fixture.mjs <target-dir>')
  process.exit(2)
}

const repo = resolve(targetDir)
mkdirSync(repo, { recursive: true })

// ~40k elements: 400 sections x (1 section + 1 h2 + 1 table + 4 rows x
// (1 tr + 3 td) + 20 li + 1 ul + ...) ≈ 100 elements per section.
function buildHugeHtml() {
  const parts = []
  parts.push('<!DOCTYPE html>\n<html>\n<head>\n<meta charset="utf-8">\n<title>Outline CPU fixture</title>\n</head>\n<body>')
  for (let s = 0; s < 400; s += 1) {
    parts.push(`<section id="sec-${s}" class="card"><h2>Model card ${s}</h2>`)
    parts.push('<table><thead><tr><th>metric</th><th>value</th><th>unit</th></tr></thead><tbody>')
    for (let r = 0; r < 12; r += 1) {
      parts.push(`<tr><td>metric-${s}-${r}</td><td>${(s * r) % 97}</td><td>pt</td></tr>`)
    }
    parts.push('</tbody></table><ul>')
    for (let l = 0; l < 20; l += 1) {
      parts.push(`<li><span class="k">key-${s}-${l}</span><em>v${l}</em></li>`)
    }
    parts.push('</ul></section>')
  }
  parts.push('</body>\n</html>')
  return parts.join('\n')
}

const git = (args) => execFileSync('git', args, { cwd: repo, stdio: 'pipe' })

git(['init'])
// Pin line endings inside the fixture so a Windows checkout with global
// core.autocrlf=true cannot re-normalise blobs and dirty a clean tree.
git(['config', 'core.autocrlf', 'false'])
git(['config', 'core.safecrlf', 'false'])
git(['config', 'user.email', 'autotest@example.com'])
git(['config', 'user.name', 'autotest'])

writeFileSync(join(repo, 'big.html'), buildHugeHtml())
writeFileSync(join(repo, 'notes.md'), '# notes\ninitial line\n')
git(['add', '.'])
git(['commit', '-m', 'add huge html + notes'])

writeFileSync(join(repo, 'notes.md'), '# notes\ninitial line\nsecond line\n')
git(['add', '.'])
git(['commit', '-m', 'extend notes'])

// Working-tree modification so Git Diff has a file to show.
writeFileSync(join(repo, 'notes.md'), '# notes\ninitial line\nsecond line\nworking tree edit\n')

const elementCount = (buildHugeHtml().match(/<[a-zA-Z]/g) || []).length
console.log(`[fixture] subpage-outline-cpu ready at ${repo} (~${elementCount} HTML elements)`)
