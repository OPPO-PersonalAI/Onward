#!/usr/bin/env node
// SPDX-FileCopyrightText: 2026 OPPO
// SPDX-License-Identifier: Apache-2.0

// Fixture for the GitStateMirror subscription-leak suite (SL-*).
//
// Layout under fixtures/gsm-subscription-leak/runtime/:
//   repo-a/      — tiny git repo with one dirty file (mirror has real work)
//   repo-b/      — second tiny git repo (baseline release scenario)
//   neutral/     — plain directory, NOT a git repo. Used as the autotest
//                  terminal cwd so TerminalGrid never subscribes the two
//                  fixture repos itself — every subscribe in the suite is
//                  issued explicitly by the test, keeping refCount
//                  assertions exact.
//
// Wipe-and-recreate semantics; runtime/ is gitignored (developers can
// inspect after a failed run, the next invocation rebuilds).

import { execFileSync } from 'child_process'
import { mkdirSync, writeFileSync, rmSync } from 'fs'
import { dirname, join, resolve } from 'path'
import { fileURLToPath } from 'url'

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

// Same transient-lock tolerance as the other fixture builders (EDR/AV can
// hold a freshly-written tree open for ~1 s on Windows).
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

const __dirname = dirname(fileURLToPath(import.meta.url))
const fixtureRoot = resolve(__dirname, 'fixtures', 'gsm-subscription-leak')
const runtimeRoot = join(fixtureRoot, 'runtime')

function git(cwd, args) {
  execFileSync('git', args, {
    cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }
  })
}

function initRepo(repo, files, message) {
  mkdirSync(repo, { recursive: true })
  git(repo, ['init', '-b', 'main'])
  // Pin line endings in LOCAL config right after init (cross-platform hard
  // rule) so a Windows global core.autocrlf=true cannot re-normalise blobs
  // and make a clean fixture report spurious modifications.
  git(repo, ['config', 'core.autocrlf', 'false'])
  git(repo, ['config', 'core.safecrlf', 'false'])
  for (const [rel, content] of Object.entries(files)) {
    const full = join(repo, rel)
    mkdirSync(join(full, '..'), { recursive: true })
    writeFileSync(full, content, 'utf8')
  }
  git(repo, ['add', '.'])
  git(repo, [
    '-c', 'user.name=Onward AutoTest',
    '-c', 'user.email=autotest@example.com',
    'commit', '-m', message
  ])
}

mkdirSync(fixtureRoot, { recursive: true })
robustRmSync(runtimeRoot)
mkdirSync(runtimeRoot, { recursive: true })

const repoA = join(runtimeRoot, 'repo-a')
initRepo(repoA, { 'README.md': '# repo-a\n\nbaseline\n' }, 'repo-a baseline')
// One dirty file so the mirror recompute has a non-empty status.
writeFileSync(join(repoA, 'README.md'), '# repo-a\n\nmodified working tree\n', 'utf8')

const repoB = join(runtimeRoot, 'repo-b')
initRepo(repoB, { 'README.md': '# repo-b\n\nbaseline\n' }, 'repo-b baseline')

const neutralCwd = join(runtimeRoot, 'neutral')
mkdirSync(neutralCwd, { recursive: true })
writeFileSync(join(neutralCwd, 'placeholder.txt'), 'not a git repo\n', 'utf8')

const manifest = { tempRoot: runtimeRoot, repoA, repoB, neutralCwd }
const manifestPath = join(runtimeRoot, 'manifest.json')
writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf8')

process.stdout.write(JSON.stringify({ ...manifest, manifestPath }))
