/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Fixture builder for the git-diff mutation-timing suite (BUG-0004).
 *
 * The suite asks "what happens when the working tree changes at an arbitrary
 * moment relative to the Git Diff lifecycle" — the Agent Coding First workload,
 * where a file can be rewritten before the panel opens, during its load, in the
 * few frames between a click and the reveal decision, while the user reads it,
 * or during close. Every assertion needs to distinguish "the viewport landed on
 * the CURRENT first change" from "it landed on the PREVIOUS one", so the files
 * are deliberately tall (1200 lines) and the suite moves the edit between a
 * LOW line and a HIGH line: with a short file, or with both versions editing
 * the same line, a stale read and a fresh read produce the same answer and the
 * assertion cannot tell them apart. That indistinguishability is exactly the
 * blind spot that let GDS-52 stay green through the 2026-07-26 bundle.
 *
 * Per the fixture-isolation rule the repo lives in the OS temp dir, never in
 * the user's tree; the runner owns cleanup via its EXIT trap.
 *
 * Cross-platform: fs/path APIs only, no POSIX shell. Local git config pins
 * core.autocrlf=false (+ safecrlf) so a Windows checkout's global autocrlf
 * cannot re-normalize the committed LF blobs and fake dirty state (per the
 * git-fixture line-ending hard rule).
 */

import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

function git(repo, ...cmdArgs) {
  execFileSync('git', ['-C', repo, ...cmdArgs], { stdio: 'ignore' })
}

// Tall enough that hideUnchangedRegions has something substantial to collapse,
// and that LOW_EDIT_LINE / HIGH_EDIT_LINE are far apart in both line space and
// pixel space.
const TALL_FILE_LINES = 1200
const LOW_EDIT_LINE = 200
const HIGH_EDIT_LINE = 950

function tallBody(label) {
  return Array.from({ length: TALL_FILE_LINES }, (_, i) => `${label} line ${i + 1}`).join('\n') + '\n'
}

const tempRoot = mkdtempSync(join(tmpdir(), 'onward-git-diff-mt-'))
const repoRoot = join(tempRoot, 'repo')
mkdirSync(repoRoot, { recursive: true })

execFileSync('git', ['init', repoRoot], { stdio: 'ignore' })
git(repoRoot, 'config', 'core.autocrlf', 'false')
git(repoRoot, 'config', 'core.safecrlf', 'false')
git(repoRoot, 'config', 'user.email', 'autotest@example.com')
git(repoRoot, 'config', 'user.name', 'Onward Autotest')
git(repoRoot, 'config', 'commit.gpgsign', 'false')

// One committed target per phase so cases never contend for the same file:
// a leftover edit from a previous case would silently change the base the next
// case measures against.
const targets = {
  neverOpened: 'mt-never-opened.txt',
  closedRoundTrip: 'mt-closed-round-trip.txt',
  duringLoad: 'mt-during-load.txt',
  duringSelect: 'mt-during-select.txt',
  whileViewing: 'mt-while-viewing.txt',
  afterScroll: 'mt-after-scroll.txt',
  duringClose: 'mt-during-close.txt',
  burst: 'mt-burst.txt'
}

for (const rel of Object.values(targets)) {
  writeFileSync(join(repoRoot, rel), tallBody('baseline'), 'utf-8')
}
git(repoRoot, 'add', '-A')
git(repoRoot, 'commit', '-m', 'mutation-timing fixture baseline', '--no-verify')

const manifestPath = join(tempRoot, 'manifest.json')
const manifest = {
  tempRoot,
  repoRoot,
  manifestPath,
  targets,
  tallFileLines: TALL_FILE_LINES,
  lowEditLine: LOW_EDIT_LINE,
  highEditLine: HIGH_EDIT_LINE
}
writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf-8')
process.stdout.write(JSON.stringify(manifest))
