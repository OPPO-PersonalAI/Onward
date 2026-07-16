#!/usr/bin/env node
// SPDX-FileCopyrightText: 2026 OPPO
// SPDX-License-Identifier: Apache-2.0

// Fixture for the GitStateMirror symlink suite (GSY-*).
//
// Reproduces the "repo entered through a symlink shows no git status" class:
//   real-repo/     — a clean git repo (one committed file). The mirror worker
//                    keys every snapshot by this REAL path (realpathSync).
//   link-to-repo   — a directory link whose target is real-repo. On macOS /
//                    Linux this is a POSIX symlink (`ln -s`); on Windows it is
//                    an NTFS JUNCTION (no admin required), which realpathSync
//                    resolves exactly like a symlink — same alias-gap class.
//   neutral/       — plain dir used as the app's terminal cwd so the fixture
//                    repo is COLD when the test pushes the symlink cwd (the
//                    bug only reproduces on a cold subscribe).
//
// Wipe-and-recreate; the runner owns the temp dir and cleans it on EXIT.

import { execFileSync } from 'child_process'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'fs'
import { tmpdir, platform } from 'os'
import { join } from 'path'

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

// Transient-lock tolerance (EDR/AV can hold a freshly-written tree ~1 s on Windows).
function robustRmSync(target, { retries = 10, baseDelayMs = 100 } = {}) {
  for (let attempt = 0; ; attempt++) {
    try {
      rmSync(target, { recursive: true, force: true })
      return
    } catch (err) {
      const code = err && err.code
      const transient =
        code === 'EPERM' || code === 'EBUSY' || code === 'ENOTEMPTY' || code === 'EACCES'
      if (!transient || attempt >= retries) throw err
      sleepSync(baseDelayMs * (attempt + 1))
    }
  }
}

// Materialise OUTSIDE the Onward repo tree so the fixture repo is a standalone
// repository (a nested dir would resolve up to Onward's own .git) and so the
// symlink never appears in the Onward working tree. The runner passes its own
// temp dir via ONWARD_GSY_FIXTURE_DIR (cleaned on EXIT); fall back to an
// OS-temp dir when invoked standalone.
const runtimeRoot = process.env.ONWARD_GSY_FIXTURE_DIR
  ? join(process.env.ONWARD_GSY_FIXTURE_DIR, 'runtime')
  : mkdtempSync(join(tmpdir(), 'onward-gsy-'))

function git(cwd, args) {
  execFileSync('git', args, {
    cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }
  })
}

robustRmSync(runtimeRoot)
mkdirSync(runtimeRoot, { recursive: true })

// real-repo/ — a clean committed git repo.
const realRepo = join(runtimeRoot, 'real-repo')
mkdirSync(realRepo, { recursive: true })
git(realRepo, ['init', '-b', 'main'])
// Pin line endings in LOCAL config right after init (cross-platform hard rule)
// so a Windows global core.autocrlf=true cannot re-normalise blobs and make a
// clean fixture report spurious modifications.
git(realRepo, ['config', 'core.autocrlf', 'false'])
git(realRepo, ['config', 'core.safecrlf', 'false'])
writeFileSync(join(realRepo, 'README.md'), '# real repo\n\nbaseline\n', 'utf8')
git(realRepo, ['add', '.'])
git(realRepo, [
  '-c', 'user.name=Onward AutoTest',
  '-c', 'user.email=autotest@example.com',
  'commit', '-m', 'baseline'
])

// link-to-repo — POSIX symlink on macOS/Linux, NTFS junction on Windows.
// Junctions need no admin rights and realpathSync resolves them the same way,
// so the alias-gap class under test is identical on all three platforms.
const linkToRepo = join(runtimeRoot, 'link-to-repo')
symlinkSync(realRepo, linkToRepo, platform() === 'win32' ? 'junction' : 'dir')

// neutral/ — the app's terminal cwd; NOT a git repo, keeps the fixture cold.
const neutralCwd = join(runtimeRoot, 'neutral')
mkdirSync(neutralCwd, { recursive: true })
writeFileSync(join(neutralCwd, 'placeholder.txt'), 'not a git repo\n', 'utf8')

const manifest = { tempRoot: runtimeRoot, realRepo, linkToRepo, neutralCwd, branch: 'main' }
const manifestPath = join(runtimeRoot, 'manifest.json')
writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf8')

process.stdout.write(JSON.stringify({ ...manifest, manifestPath }))
