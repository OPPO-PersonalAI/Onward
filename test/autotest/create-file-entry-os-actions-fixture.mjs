#!/usr/bin/env node
// SPDX-FileCopyrightText: 2026 OPPO
// SPDX-License-Identifier: Apache-2.0
//
// FEOS (File-Entry OS actions) fixture builder.
//
// Constructs a temp git repo exercised by src/autotest/test-file-entry-os-actions.ts:
//   - readme.md      committed, clean; contains the FEOSMARK content-search
//                    marker and markdown headings (drives the Outline pane).
//   - notes.txt      committed then modified in the worktree → 'M' row in Git Diff,
//                    opens in the Monaco editor (plain text).
//   - docs/guide.md  committed, clean; gives the tree a nested directory.
//   - todelete.txt   committed then removed from the worktree → 'D' row in Git
//                    Diff (the disabled-state assertion target).
//
// Output (stdout): JSON `{ "root": "/path/to/fixture" }`. The runner points
// the dev app at that cwd and removes the directory on EXIT.

import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, appendFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const root = mkdtempSync(join(tmpdir(), 'onward-feos-fixture-'))

function git(args) {
  execFileSync('git', args, { cwd: root, stdio: 'ignore' })
}

git(['init', '-q', '-b', 'main'])
// Pin line endings BEFORE adding files so a Windows host with a global
// core.autocrlf=true cannot re-normalize the fixture and surface spurious
// modifications (cross-platform fixture hard rule).
git(['config', 'core.autocrlf', 'false'])
git(['config', 'core.safecrlf', 'false'])
git(['config', 'user.email', 'autotest@example.invalid'])
git(['config', 'user.name', 'Onward Autotest'])

writeFileSync(join(root, 'readme.md'), [
  '# FEOS Fixture',
  '',
  'FEOSMARK content-search marker lives in this file only.',
  '',
  '## Section A',
  '',
  'Alpha body line.',
  '',
  '## Section B',
  '',
  'Beta body line.',
  ''
].join('\n'), 'utf8')
writeFileSync(join(root, 'notes.txt'), 'note line 1\nnote line 2\n', 'utf8')
mkdirSync(join(root, 'docs'))
writeFileSync(join(root, 'docs', 'guide.md'), '# Guide\n\nGuide body.\n', 'utf8')
writeFileSync(join(root, 'todelete.txt'), 'doomed line\n', 'utf8')
// Sacrificial file for the FEOS-12 TOCTOU toast case: committed clean, then
// deleted mid-test AFTER the existence check enabled the menu item.
writeFileSync(join(root, 'ephemeral.txt'), 'short-lived line\n', 'utf8')

git(['add', '.'])
git(['commit', '-q', '-m', 'FEOS fixture: initial seed'])

// Worktree state for Git Diff: one modified row + one deleted row.
appendFileSync(join(root, 'notes.txt'), 'note line 3 (worktree edit)\n', 'utf8')
rmSync(join(root, 'todelete.txt'))

// Sanity: porcelain must show exactly M notes.txt + D todelete.txt.
const status = execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' })
const lines = status.split('\n').filter(Boolean).sort()
const expected = [' D todelete.txt', ' M notes.txt'].sort()
if (JSON.stringify(lines) !== JSON.stringify(expected)) {
  process.stderr.write(`FEOS fixture invariant failed: unexpected porcelain output:\n${status}\n`)
  process.exit(2)
}

process.stdout.write(JSON.stringify({ root }) + '\n')
