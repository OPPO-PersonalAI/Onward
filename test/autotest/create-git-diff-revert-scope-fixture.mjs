#!/usr/bin/env node
// SPDX-FileCopyrightText: 2026 OPPO
// SPDX-License-Identifier: Apache-2.0

// Fixture for the Git Diff revert-scope suite (GRS-*).
//
// A standalone repo with THREE committed text files, each carrying an
// unstaged worktree modification, so the Git Diff list opens with three
// `unstaged` rows. The suite discards ONE of them and asserts the refresh
// stays scoped: no whole-editor remount, warm content cache for the others,
// and at most one list reconcile.
//
// The manifest carries the committed baselines so the suite can assert the
// discard's ground truth via project.readFile (poll the worktree, never a
// frozen diff cache — GDS-29 lesson).

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

// Materialise OUTSIDE the Onward repo tree so the fixture is a standalone
// repository. The runner passes its own temp dir via ONWARD_GRS_FIXTURE_DIR
// (cleaned on EXIT); fall back to an OS-temp dir when invoked standalone.
const runtimeRoot = process.env.ONWARD_GRS_FIXTURE_DIR
  ? join(process.env.ONWARD_GRS_FIXTURE_DIR, 'runtime')
  : mkdtempSync(join(tmpdir(), 'onward-grs-'))

function git(cwd, args) {
  execFileSync('git', args, {
    cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }
  })
}

robustRmSync(runtimeRoot)
mkdirSync(runtimeRoot, { recursive: true })

const repo = join(runtimeRoot, 'repo')
mkdirSync(repo, { recursive: true })
git(repo, ['init', '-b', 'main'])
// Pin line endings in LOCAL config right after init (cross-platform hard rule)
// so a Windows global core.autocrlf=true cannot re-normalise blobs and make a
// clean fixture report spurious modifications.
git(repo, ['config', 'core.autocrlf', 'false'])
git(repo, ['config', 'core.safecrlf', 'false'])

const baselines = {
  'alpha.txt': 'alpha baseline line 1\nalpha baseline line 2\n',
  'beta.txt': 'beta baseline line 1\nbeta baseline line 2\n',
  'gamma.txt': 'gamma baseline line 1\ngamma baseline line 2\n'
}
for (const [name, content] of Object.entries(baselines)) {
  writeFileSync(join(repo, name), content, 'utf8')
}
git(repo, ['add', '.'])
git(repo, [
  '-c', 'user.name=Onward AutoTest',
  '-c', 'user.email=autotest@example.com',
  'commit', '-m', 'baseline'
])

// Worktree modifications: every file gets an unstaged edit so the diff list
// opens with three `unstaged` rows.
const modifications = {
  'alpha.txt': 'alpha MODIFIED line 1\nalpha baseline line 2\n',
  'beta.txt': 'beta MODIFIED line 1\nbeta baseline line 2\n',
  'gamma.txt': 'gamma MODIFIED line 1\ngamma baseline line 2\n'
}
for (const [name, content] of Object.entries(modifications)) {
  writeFileSync(join(repo, name), content, 'utf8')
}

const manifest = { tempRoot: runtimeRoot, repo, baselines, modifications }
const manifestPath = join(runtimeRoot, 'manifest.json')
writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf8')

process.stdout.write(JSON.stringify({ ...manifest, manifestPath }))
