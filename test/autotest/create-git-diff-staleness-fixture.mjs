#!/usr/bin/env node
// SPDX-FileCopyrightText: 2026 OPPO
// SPDX-License-Identifier: Apache-2.0

// Builds three parent+submodule git repos under one tempRoot:
//   1. clean/root            — submodule HEAD matches parent index, work tree clean.
//                              Used by GDS-01 / 02 / 03 / 05 / 06..10.
//   2. pointer-changed/root  — submodule HEAD diverges from the recorded parent
//                              index pointer (c flag = C). Used by GDS-04.
//   3. uninitialized/root    — submodule declared in `.gitmodules` but never
//                              `--init`-ed (Project_Forward repro). The path
//                              exists on disk but is NOT a git repository.
//                              Used by GDS-13 to verify the parent's file list
//                              does NOT inherit phantom submodule rows.
// All three roots live as siblings inside one tempRoot so a single autotest
// session can address them via ONWARD_AUTOTEST_FIXTURE_EXTRA (a JSON manifest).
//
// Cross-platform notes:
//   * `protocol.file.allow=always` is required for `git submodule add file://`
//     starting from git 2.38 on macOS / Linux; same flag works on Windows
//     git for windows.
//   * Path separators are forced to forward-slash by git's own porcelain v2 -z
//     output, so we do not normalise inside this script.

import { execFileSync } from 'child_process'
import { mkdirSync, writeFileSync, rmSync, renameSync, readdirSync } from 'fs'
import { dirname, join, resolve } from 'path'
import { fileURLToPath, pathToFileURL } from 'url'

// Windows note: under EDR/AV a freshly-written git tree (or a prior suite's
// lingering git/electron handle on the shared runtime/ dir) can briefly lock
// files, so rmSync throws EPERM/EBUSY/EACCES. The lock is transient — the
// scanner releases within ~1 s — so retry with linear backoff before giving up.
// This is the fixture-builder analogue of the runner-side robust_rm helper.
function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}
function robustRmSync(target, { retries = 10, baseDelayMs = 100 } = {}) {
  for (let attempt = 0; ; attempt++) {
    try {
      rmSync(target, { recursive: true, force: true })
      return
    } catch (err) {
      const code = err && err.code
      const transient =
        code === 'EPERM' || code === 'EBUSY' || code === 'ENOTEMPTY' || code === 'EACCES'
      if (!transient) throw err
      if (attempt >= retries) {
        // Last resort (Windows): under FULL-SUITE EDR pressure a lingering
        // git/electron/AV handle from a PRIOR group-runner (the three GDS group
        // suites share this one runtime/ path) can hold the tree open past the
        // ~5.5 s retry window, so rmSync never wins. We usually cannot DELETE a dir
        // with a locked file inside, but on NTFS we CAN rename the dir aside (it is
        // just a directory-entry rename; the stale handles keep pointing at the
        // renamed inode), freeing the canonical path for a fresh build. The husk is
        // swept best-effort here and on the next run; the runner EXIT trap + the
        // orchestrator's __autotest_/runtime sweep are the final backstop.
        const aside = `${target}.stale-${process.pid}-${attempt}`
        renameSync(target, aside) // if this also throws, let it propagate — genuinely wedged
        try {
          rmSync(aside, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 })
        } catch {
          // husk still locked — leave it; sweepStaleHusks() removes it next run
        }
        return
      }
      // Linear backoff: 100, 200, … up to ~5.5 s total — outlasts a transient scan lock.
      sleepSync(baseDelayMs * (attempt + 1))
    }
  }
}

// Best-effort removal of `runtime.stale-*` husks left by a prior rename-aside on a
// locked tree. Never throws: a husk still held open is simply skipped (it will be
// retried on a later run once its handle is released).
function sweepStaleHusks(parentDir, baseName) {
  let entries
  try {
    entries = readdirSync(parentDir, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    if (!entry.name.startsWith(`${baseName}.stale-`)) continue
    try {
      rmSync(join(parentDir, entry.name), { recursive: true, force: true, maxRetries: 2, retryDelay: 150 })
    } catch {
      // still locked — leave for a future run
    }
  }
}

// Match the convention established by `test/autotest/create-nested-git-submodule-fixture.mjs`:
// fixtures live under `test/autotest/fixtures/<suite>/runtime/` so developers can inspect
// after a failed run, the next invocation wipes-and-recreates for a known-good
// state, and `test/autotest/fixtures/<suite>/.gitignore` keeps generated content out of
// the repo. CLAUDE.md "Test fixture isolation" hard rule §4 explicitly calls
// for this layout.
const __dirname = dirname(fileURLToPath(import.meta.url))
const fixtureRoot = resolve(__dirname, 'fixtures', 'git-diff-staleness-and-submodule')
const runtimeRoot = join(fixtureRoot, 'runtime')

function git(cwd, args) {
  execFileSync('git', args, {
    cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      GIT_TERMINAL_PROMPT: '0'
    }
  })
}

function commit(repo, message) {
  git(repo, [
    '-c', 'user.name=Onward AutoTest',
    '-c', 'user.email=autotest@example.com',
    'commit',
    '-m', message
  ])
}

function init(repo, files, message) {
  mkdirSync(repo, { recursive: true })
  git(repo, ['init', '-b', 'main'])
  for (const [rel, content] of Object.entries(files)) {
    const full = join(repo, rel)
    mkdirSync(join(full, '..'), { recursive: true })
    writeFileSync(full, content, 'utf8')
  }
  git(repo, ['add', '.'])
  commit(repo, message)
}

function addSubmodule(parent, source, target) {
  git(parent, [
    '-c', 'protocol.file.allow=always',
    'submodule', 'add', pathToFileURL(source).href, target
  ])
}

// Wipe-and-recreate so test runs don't inherit a half-baked previous state.
mkdirSync(fixtureRoot, { recursive: true })
sweepStaleHusks(fixtureRoot, 'runtime') // clear any rename-aside husks from prior locked runs
robustRmSync(runtimeRoot)
mkdirSync(runtimeRoot, { recursive: true })

const tempRoot = runtimeRoot
const sourcesRoot = join(tempRoot, 'sources')
const reposRoot = join(tempRoot, 'repos')

// One source submodule repo seeded with a stable file list that the test can
// modify / leave alone in different scenarios.
const subSource = join(sourcesRoot, 'sub')
init(subSource, {
  'README.md': '# Submodule\n\nbaseline content\n',
  'lib/keep.txt': 'keep this file untouched in clean scenarios\n'
}, 'submodule baseline')

// ------------ clean/root ------------
// deep-change-target: a LONG committed file (1200 lines) whose edits land in
// the MIDDLE of the file. GDS-52 needs three mutually distinguishable
// viewport positions — top (fresh model bind, ~1), the first-change line
// (~600), and the parked bottom (~1050) — which a short-baseline file cannot
// provide: with a 1-line HEAD every worktree line is one added hunk starting
// at line 2, so "revealed the first change" and "sat at the top" are the
// same pixel; and at 300 lines a tall autotest window (~150 visible lines)
// collapses "bottom" (first visible ≈ 147) onto the change line (150).
const deepChangeTargetLines = Array.from(
  { length: 1200 },
  (_, i) => `deep baseline line ${i + 1}`
).join('\n')
const cleanRoot = join(reposRoot, 'clean', 'root')
init(cleanRoot, {
  'README.md': '# Clean parent\n\nbaseline parent content\n',
  'src/main.txt': 'parent source line\n',
  'nested/repeated-edit-target.md': '# Repeated edit target\n\nbaseline body\n',
  'src/deep-change-target.txt': `${deepChangeTargetLines}\n`
}, 'parent baseline')
addSubmodule(cleanRoot, subSource, 'modules/sub')
commit(cleanRoot, 'add submodule')
git(cleanRoot, ['-c', 'protocol.file.allow=always', 'submodule', 'update', '--init', '--recursive'])

// ------------ pointer-changed/root ------------
// Same structure, but with a SECOND commit advanced inside the submodule and
// no `git add modules/sub` in the parent — so parent index records commit A
// while the submodule work tree HEAD is at commit B (c flag = C).
const pointerChangedRoot = join(reposRoot, 'pointer-changed', 'root')
init(pointerChangedRoot, {
  'README.md': '# Pointer-changed parent\n\nbaseline parent content\n',
  'src/main.txt': 'parent source line\n'
}, 'parent baseline')
addSubmodule(pointerChangedRoot, subSource, 'modules/sub')
commit(pointerChangedRoot, 'add submodule')
git(pointerChangedRoot, ['-c', 'protocol.file.allow=always', 'submodule', 'update', '--init', '--recursive'])

// Advance the inner submodule HEAD beyond what the parent index records.
const innerSubmodule = join(pointerChangedRoot, 'modules', 'sub')
writeFileSync(join(innerSubmodule, 'README.md'),
  '# Submodule\n\nadvanced commit body\n', 'utf8')
git(innerSubmodule, ['add', 'README.md'])
commit(innerSubmodule, 'submodule advance')
// Reset the submodule work tree to a clean state so the m flag stays empty;
// only the c flag should be set in the parent's view.
git(innerSubmodule, ['checkout', '-q', 'HEAD', '--', '.'])

// ------------ staged-pointer/root ------------
// Same starting shape as pointer-changed/root, but the user then ran
// `git add modules/sub` so the parent's index now records the new submodule
// HEAD. Porcelain v2 reports `<c>=.` (work tree matches index again) but the
// parent-side X-status is `M` — the row carries `changeType: 'staged'`. The
// filter must KEEP this row so users can review or unstage it from Git Diff.
const stagedPointerRoot = join(reposRoot, 'staged-pointer', 'root')
init(stagedPointerRoot, {
  'README.md': '# Staged-pointer parent\n\nbaseline parent content\n',
  'src/main.txt': 'parent source line\n'
}, 'parent baseline')
addSubmodule(stagedPointerRoot, subSource, 'modules/sub')
commit(stagedPointerRoot, 'add submodule')
git(stagedPointerRoot, ['-c', 'protocol.file.allow=always', 'submodule', 'update', '--init', '--recursive'])

const stagedInnerSubmodule = join(stagedPointerRoot, 'modules', 'sub')
writeFileSync(join(stagedInnerSubmodule, 'README.md'),
  '# Submodule\n\nstaged-advanced commit body\n', 'utf8')
git(stagedInnerSubmodule, ['add', 'README.md'])
commit(stagedInnerSubmodule, 'submodule advance for staged-pointer')
// Reset submodule work tree to clean — m flag must stay empty.
git(stagedInnerSubmodule, ['checkout', '-q', 'HEAD', '--', '.'])
// Stage the submodule pointer change in the parent. After this, parent
// porcelain v2 should report `1 M. S... ... modules/sub` with `<c>=.`.
git(stagedPointerRoot, ['add', 'modules/sub'])

// ------------ uninitialized/root ------------
// Project_Forward shape: `.gitmodules` declares the submodule, the parent
// commit references it, but the submodule has been deinit-ed and the working
// tree is empty. The directory exists on disk (so the simple `access(path)`
// check passes) but it is NOT a git repository.
const uninitializedRoot = join(reposRoot, 'uninitialized', 'root')
init(uninitializedRoot, {
  'README.md': '# Uninitialized parent\n\nbaseline parent content\n',
  'src/main.txt': 'parent source line\n'
}, 'parent baseline')
addSubmodule(uninitializedRoot, subSource, 'modules/sub')
commit(uninitializedRoot, 'add submodule')
git(uninitializedRoot, ['-c', 'protocol.file.allow=always', 'submodule', 'update', '--init', '--recursive'])
// Now deinit so the submodule directory becomes empty / not-a-repo.
git(uninitializedRoot, ['submodule', 'deinit', '-f', 'modules/sub'])
// Belt + suspenders: physically remove the .git pointer file inside the path
// so the directory truly is "exists but not a repo" (deinit may leave a
// pointer file depending on git version). `git submodule status` will still
// report it from `.gitmodules`, but `getGitRepoMeta` must reject it.
robustRmSync(join(uninitializedRoot, 'modules', 'sub'))
mkdirSync(join(uninitializedRoot, 'modules', 'sub'), { recursive: true })

const manifest = {
  tempRoot,
  cleanRoot,
  pointerChangedRoot,
  stagedPointerRoot,
  uninitializedRoot,
  submoduleRelPath: 'modules/sub',
  parentEditableFile: 'src/main.txt',
  stableStatusEditableFile: 'nested/repeated-edit-target.md',
  deepChangeTargetFile: 'src/deep-change-target.txt',
  submoduleEditableFile: 'README.md',
  submoduleUntrackedRelPath: 'modules/sub/lib/new-untracked.txt'
}

const manifestPath = join(tempRoot, 'manifest.json')
writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf8')

process.stdout.write(JSON.stringify({ ...manifest, manifestPath }))
