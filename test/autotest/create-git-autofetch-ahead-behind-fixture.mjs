#!/usr/bin/env node
// SPDX-FileCopyrightText: 2026 OPPO
// SPDX-License-Identifier: Apache-2.0

// Fixture for the git ahead/behind + auto-fetch suite (AB-*).
//
// Builds a local bare "remote" and several clones, each engineered to a known
// ahead/behind state, so the test can assert the mirror snapshot's ahead/behind
// (parse → worker → IPC end-to-end) and the fetch→behind flip WITHOUT any real
// network / credentials (the bare repo is a plain on-disk path):
//   up-to-date/   HEAD == origin/main            → ahead 0, behind 0
//   ahead/        2 local commits not pushed      → ahead 2, behind 0
//   behind/       HEAD reset 1 behind origin/main → ahead 0, behind 1
//   diverged/     1 local + 1 origin-only commit  → ahead 1, behind 1
//   no-upstream/  git init, one commit, no remote → ahead/behind undefined
//   fetch-behind/ origin advanced by 1 AFTER clone, ref NOT fetched yet
//                 → ahead 0, behind 0 now; after a background fetch → behind 1
//   fail-fetch/   origin repointed at a non-existent path → fetch fails FAST
//                 with a real exit code + stderr (BUG-0005 R4 payload proof)
//   timeout-fetch/ origin uses git's ext:: transport running `sleep` → the fetch
//                 hangs and is killed by the 20 s ceiling, reproducing the field
//                 failure mode whose stderr used to be discarded
//   neutral/      the app's terminal cwd (not a git repo, never auto-subscribed)
//
// Materialised OUTSIDE the Onward repo tree (runner passes ONWARD_AB_FIXTURE_DIR,
// cleaned on EXIT) so `no-upstream` is genuinely upstream-less and the clones do
// not resolve up to Onward's own .git.

import { execFileSync } from 'child_process'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

// EDR/AV can hold a freshly-written tree ~1 s on Windows.
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

const runtimeRoot = process.env.ONWARD_AB_FIXTURE_DIR
  ? join(process.env.ONWARD_AB_FIXTURE_DIR, 'runtime')
  : mkdtempSync(join(tmpdir(), 'onward-ab-'))

const IDENT = ['-c', 'user.name=Onward AutoTest', '-c', 'user.email=autotest@example.com']

function git(cwd, args) {
  execFileSync('git', args, {
    cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }
  })
}

// Pin line endings in LOCAL config right after init/clone (cross-platform hard
// rule) so a Windows global core.autocrlf=true cannot dirty a clean tree.
function pinEol(cwd) {
  git(cwd, ['config', 'core.autocrlf', 'false'])
  git(cwd, ['config', 'core.safecrlf', 'false'])
}

function commit(cwd, file, content, message) {
  writeFileSync(join(cwd, file), content, 'utf8')
  git(cwd, ['add', '-A'])
  git(cwd, [...IDENT, 'commit', '-m', message])
}

robustRmSync(runtimeRoot)
mkdirSync(runtimeRoot, { recursive: true })

// bare remote.
const remote = join(runtimeRoot, 'remote.git')
mkdirSync(remote, { recursive: true })
git(remote, ['init', '--bare', '-b', 'main'])

// helper clone seeds the remote with two commits (C0, C1), then later C2.
const helper = join(runtimeRoot, 'helper')
git(runtimeRoot, ['clone', remote, helper])
pinEol(helper)
commit(helper, 'README.md', '# fixture\n\nC0\n', 'C0 baseline')
commit(helper, 'README.md', '# fixture\n\nC0\nC1\n', 'C1 second')
git(helper, ['push', 'origin', 'main'])

function cloneFrom(name) {
  const dir = join(runtimeRoot, name)
  git(runtimeRoot, ['clone', remote, dir])
  pinEol(dir)
  return dir
}

// up-to-date: HEAD == origin/main.
const upToDate = cloneFrom('up-to-date')

// ahead: two unpushed local commits.
const ahead = cloneFrom('ahead')
commit(ahead, 'a.txt', 'local 1\n', 'local ahead 1')
commit(ahead, 'a.txt', 'local 1\nlocal 2\n', 'local ahead 2')

// behind: HEAD reset one commit back; origin/main still at C1.
const behind = cloneFrom('behind')
git(behind, ['reset', '--hard', 'HEAD~1'])

// diverged: reset back one, then a new local commit → 1 ahead, 1 behind.
const diverged = cloneFrom('diverged')
git(diverged, ['reset', '--hard', 'HEAD~1'])
commit(diverged, 'd.txt', 'diverged local\n', 'diverged local commit')

// fetch-behind: clone at C1, then advance origin to C2 WITHOUT fetching here.
const fetchBehind = cloneFrom('fetch-behind')
commit(helper, 'README.md', '# fixture\n\nC0\nC1\nC2\n', 'C2 third')
git(helper, ['push', 'origin', 'main'])

// fail-fetch (BUG-0005 R4): a normal clone whose origin URL is repointed at a
// path that does not exist. `git fetch` fails FAST (no timeout involved) with a
// real exit code and a real stderr, so the test can assert that the enriched
// failure payload — classified / exitCode / stderrTail — actually reaches a
// consumer. Before the fix these fields did not exist and every failure looked
// identical in a user-attached trace.
const failFetch = cloneFrom('fail-fetch')
git(failFetch, ['config', 'remote.origin.url', join(runtimeRoot, 'no-such-remote.git')])

// timeout-fetch (BUG-0005 R4, the FIELD scenario): origin speaks git's `ext::`
// transport, whose command just sleeps. git connects and waits forever for the
// protocol banner, so the fetch is killed by the manager's 20 s ceiling exactly
// as it was for the two repos in the field bundle (durations 20,007–20,013 ms).
// This is the branch that used to short-circuit past classifyFetchFailure and
// discard stderr, so it is the one worth exercising end-to-end.
// `sleep` and the shell come from git's own runtime (Git for Windows bundles
// both), which keeps the fixture platform-neutral; `protocol.ext.allow` is set
// explicitly because git restricts ext:: by default.
const timeoutFetch = cloneFrom('timeout-fetch')
git(timeoutFetch, ['config', 'protocol.ext.allow', 'always'])
git(timeoutFetch, ['config', 'remote.origin.url', 'ext::sleep 60'])

// no-upstream: a standalone repo with a commit but no remote.
const noUpstream = join(runtimeRoot, 'no-upstream')
mkdirSync(noUpstream, { recursive: true })
git(noUpstream, ['init', '-b', 'main'])
pinEol(noUpstream)
commit(noUpstream, 'README.md', '# local only\n', 'local only')

// neutral: the app's terminal cwd — NOT a git repo, never auto-subscribed.
const neutralCwd = join(runtimeRoot, 'neutral')
mkdirSync(neutralCwd, { recursive: true })
writeFileSync(join(neutralCwd, 'placeholder.txt'), 'not a git repo\n', 'utf8')

const manifest = {
  tempRoot: runtimeRoot,
  remote,
  upToDate,
  ahead,
  behind,
  diverged,
  fetchBehind,
  failFetch,
  timeoutFetch,
  noUpstream,
  neutralCwd
}
const manifestPath = join(runtimeRoot, 'manifest.json')
writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf8')

process.stdout.write(JSON.stringify({ ...manifest, manifestPath }))
