/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Fixture builder for the git-diff chaos-convergence suite.
 *
 * Builds a small, submodule-free git repo in the OS temp dir (per the fixture
 * isolation rule: never the user's data, never the project tree) with a few
 * committed text files the chaos writer mutates as "tracked churn" targets,
 * plus a state dir OUTSIDE the repo for the writer↔suite handshake (invisible
 * to git and to the FS watcher). Prints a manifest JSON to stdout; the runner
 * passes its path via ONWARD_AUTOTEST_FIXTURE_EXTRA and owns cleanup.
 *
 * Cross-platform: fs/path APIs only; local git config pins core.autocrlf=false
 * (+ safecrlf) so a Windows checkout's global autocrlf cannot re-normalize
 * blobs and fake dirty state (per the git-fixture line-ending hard rule).
 */

import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

function git(repo, ...cmdArgs) {
  execFileSync('git', ['-C', repo, ...cmdArgs], { stdio: 'ignore' })
}

const tempRoot = mkdtempSync(join(tmpdir(), 'onward-git-diff-chaos-'))
const repoRoot = join(tempRoot, 'repo')
const stateDir = join(tempRoot, 'state')
mkdirSync(repoRoot, { recursive: true })
mkdirSync(stateDir, { recursive: true })
mkdirSync(join(repoRoot, 'docs'), { recursive: true })
mkdirSync(join(repoRoot, 'src'), { recursive: true })

execFileSync('git', ['init', repoRoot], { stdio: 'ignore' })
git(repoRoot, 'config', 'core.autocrlf', 'false')
git(repoRoot, 'config', 'core.safecrlf', 'false')
git(repoRoot, 'config', 'user.email', 'autotest@example.com')
git(repoRoot, 'config', 'user.name', 'Onward Autotest')
git(repoRoot, 'config', 'commit.gpgsign', 'false')

const seedFiles = ['docs/alpha.md', 'docs/beta.md', 'src/one.md', 'src/two.md', 'notes.md']
for (const rel of seedFiles) {
  writeFileSync(join(repoRoot, rel), `# ${rel}\n\ncommitted baseline body\n`, 'utf-8')
}
git(repoRoot, 'add', '-A')
git(repoRoot, 'commit', '-m', 'chaos fixture baseline', '--no-verify')

const manifestPath = join(tempRoot, 'manifest.json')
const manifest = { tempRoot, repoRoot, stateDir, seedFiles, manifestPath }
writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf-8')
process.stdout.write(JSON.stringify(manifest))
