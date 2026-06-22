#!/usr/bin/env node
// SPDX-FileCopyrightText: 2026 OPPO
// SPDX-License-Identifier: Apache-2.0

// Builds the Git History image-diff fixture: a throwaway git repo with TWO
// commits, each touching a PNG and an SVG so Git History has a real
// before/after image pair to render.
//
//   commit 1 "base images"   -> red 1x1 PNG  + red  10x10 SVG
//   commit 2 "update images" -> blue 1x1 PNG + blue 10x10 SVG
//
// WHY a Node builder instead of writing the repo from the autotest's PTY:
// the previous version fired one mega `git init && commit && commit` command
// into the live terminal via terminal.write(). On an EDR-throttled Windows host
// the terminal could be sitting at a shell "Press any key to continue" pause
// (observed in the round-4 log: a `watchman` startup command failed with
// "'watchman' is not recognized" then "请按任意键继续..."), so the autotest's
// keypress was swallowed by that prompt and the mega-command NEVER executed.
// getHistory then correctly reported "The current directory is not a Git
// repository." (ID-13 FAIL), and every downstream ID-15..ID-17 cascaded to
// timeout. Building the repo here — deterministically, with execFileSync, no
// PTY, no shell init — removes that entire failure class.
//
// Cross-platform: `core.autocrlf=false` + `core.safecrlf=false` are pinned in
// the repo's LOCAL config right after `git init` (CLAUDE.md autotest
// cross-platform hard rule). The fixture is built fresh per run (wipe + init),
// so byte-stability matters only within the run, but pinning keeps the build
// identical on every platform regardless of the contributor's global autocrlf.

import { execFileSync } from 'child_process'
import { mkdirSync, writeFileSync, rmSync } from 'fs'
import { dirname, join, resolve } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const fixtureRoot = resolve(__dirname, 'fixtures', 'image-history-diff')
const runtimeRoot = join(fixtureRoot, 'runtime')

// Allow the runner to override the runtime root (e.g. a per-run mktemp dir) so
// concurrent runs / fresh user-data isolation never collide on disk.
const repoRoot = process.argv[2] ? resolve(process.argv[2]) : join(runtimeRoot, 'image-history-repo')

const PNG_FILE = '__autotest_image_diff_test.png'
const SVG_FILE = '__autotest_image_diff_test.svg'

const TINY_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg=='
const TINY_PNG_ALT_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4////fwAJ+wP9KobjigAAAABJRU5ErkJggg=='
const TINY_SVG_BASE64 =
  'PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAxMCAxMCI+PHJlY3Qgd2lkdGg9IjEwIiBoZWlnaHQ9IjEwIiBmaWxsPSJyZWQiLz48L3N2Zz4K'
const TINY_SVG_ALT_BASE64 =
  'PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAxMCAxMCI+PHJlY3Qgd2lkdGg9IjEwIiBoZWlnaHQ9IjEwIiBmaWxsPSJibHVlIi8+PC9zdmc+Cg=='

function git(cwd, args) {
  execFileSync('git', args, {
    cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }
  })
}

function commit(repo, message) {
  git(repo, [
    '-c', 'user.name=Onward AutoTest',
    '-c', 'user.email=autotest@example.com',
    'commit', '-m', message
  ])
}

function writeBinary(repo, name, base64) {
  writeFileSync(join(repo, name), Buffer.from(base64, 'base64'))
}

// Wipe-and-recreate so a half-baked previous run can't leak state.
mkdirSync(dirname(repoRoot), { recursive: true })
rmSync(repoRoot, { recursive: true, force: true })
mkdirSync(repoRoot, { recursive: true })

git(repoRoot, ['init', '-b', 'main'])
git(repoRoot, ['config', 'core.autocrlf', 'false'])
git(repoRoot, ['config', 'core.safecrlf', 'false'])

// Commit 1: base (red) images.
writeBinary(repoRoot, PNG_FILE, TINY_PNG_BASE64)
writeBinary(repoRoot, SVG_FILE, TINY_SVG_BASE64)
git(repoRoot, ['add', PNG_FILE, SVG_FILE])
commit(repoRoot, 'base images')

// Commit 2: updated (blue) images.
writeBinary(repoRoot, PNG_FILE, TINY_PNG_ALT_BASE64)
writeBinary(repoRoot, SVG_FILE, TINY_SVG_ALT_BASE64)
git(repoRoot, ['add', PNG_FILE, SVG_FILE])
commit(repoRoot, 'update images')

const manifest = {
  repoPath: repoRoot,
  pngFile: PNG_FILE,
  svgFile: SVG_FILE
}

const manifestPath = join(repoRoot, 'manifest.json')
writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf8')

process.stdout.write(JSON.stringify({ ...manifest, manifestPath }))
