#!/usr/bin/env node
// SPDX-FileCopyrightText: 2026 OPPO
// SPDX-License-Identifier: Apache-2.0

// Fixture for the GitStateMirror git-command-freshness suite (GCF-*).
//
// Reproduces the 2026-07-05 diagnostic bundles' watcher-independent-freshness
// class:
//   repo/        — a clean git repo (one committed file, empty working tree).
//                  The test writes an EXTERNAL untracked file then revalidates,
//                  proving revalidate-on-open surfaces a change on demand.
//   later-git/   — a PLAIN directory (NOT a git repo) holding one file. The
//                  test attaches the mirror (→ non-git, no watcher), then runs
//                  `git init` in it (via the autotest-only debug IPC, faithfully
//                  reproducing "a folder becomes a repo mid-session" =
//                  BattleProject) and revalidates. Because a non-git cwd has NO
//                  watcher, a fresh detection is uniquely attributable to the
//                  reconcile/re-attach fix.
//   neutral/     — plain dir used as the app's terminal cwd so TerminalGrid
//                  never auto-subscribes the fixtures; every subscribe is
//                  explicit from the test.
//
// Wipe-and-recreate; runtime/ is gitignored.

import { execFileSync } from 'child_process'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
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

// CRITICAL: materialise the runtime OUTSIDE the Onward repo tree. `later-git`
// must be a genuinely NON-git directory, but a subdir nested inside the Onward
// working tree resolves via `git rev-parse --show-toplevel` UP to Onward's own
// `.git` — so it is never "non-git" and the non-git → git assertion is defeated.
// The runner passes its own temp dir via ONWARD_GCF_FIXTURE_DIR (cleaned on
// EXIT); we fall back to an OS-temp dir when invoked standalone.
const runtimeRoot = process.env.ONWARD_GCF_FIXTURE_DIR
  ? join(process.env.ONWARD_GCF_FIXTURE_DIR, 'runtime')
  : mkdtempSync(join(tmpdir(), 'onward-gcf-'))

function git(cwd, args) {
  execFileSync('git', args, {
    cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }
  })
}

robustRmSync(runtimeRoot)
mkdirSync(runtimeRoot, { recursive: true })

// repo/ — a clean committed git repo.
const repo = join(runtimeRoot, 'repo')
mkdirSync(repo, { recursive: true })
git(repo, ['init', '-b', 'main'])
// Pin line endings in LOCAL config right after init (cross-platform hard rule)
// so a Windows global core.autocrlf=true cannot re-normalise blobs and make a
// clean fixture report spurious modifications.
git(repo, ['config', 'core.autocrlf', 'false'])
git(repo, ['config', 'core.safecrlf', 'false'])
writeFileSync(join(repo, 'README.md'), '# repo\n\nbaseline\n', 'utf8')
git(repo, ['add', '.'])
git(repo, [
  '-c', 'user.name=Onward AutoTest',
  '-c', 'user.email=autotest@example.com',
  'commit', '-m', 'repo baseline'
])

// later-git/ — a PLAIN directory (no .git). The test runs `git init` here.
const laterGit = join(runtimeRoot, 'later-git')
mkdirSync(laterGit, { recursive: true })
writeFileSync(join(laterGit, 'file.txt'), 'not a git repo yet\n', 'utf8')

// neutral/ — the app's terminal cwd; NOT a git repo, never auto-subscribed.
const neutralCwd = join(runtimeRoot, 'neutral')
mkdirSync(neutralCwd, { recursive: true })
writeFileSync(join(neutralCwd, 'placeholder.txt'), 'not a git repo\n', 'utf8')

const manifest = { tempRoot: runtimeRoot, repo, laterGit, neutralCwd }
const manifestPath = join(runtimeRoot, 'manifest.json')
writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf8')

process.stdout.write(JSON.stringify({ ...manifest, manifestPath }))
