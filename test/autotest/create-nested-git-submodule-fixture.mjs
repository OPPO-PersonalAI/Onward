#!/usr/bin/env node
// SPDX-FileCopyrightText: 2026 OPPO
// SPDX-License-Identifier: Apache-2.0

import { execFileSync } from 'child_process'
import { rmSync, mkdirSync, writeFileSync, appendFileSync, existsSync } from 'fs'
import { dirname, join, resolve } from 'path'
import { tmpdir } from 'os'
import { fileURLToPath, pathToFileURL } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const fixtureRoot = resolve(__dirname, 'fixtures', 'git-nested-submodules')
// Belt-and-braces for Windows MAX_PATH (260): the 5-deep recursive-submodule
// layout produces a ~277-char .git/modules/.../objects/pack/*.keep path when
// rooted under the deep repo tree, which makes git fail with "Filename too
// long" before any product code runs. Relocate the runtime root to a SHORT
// OS-temp base to cut ~95 chars off the prefix; cleanup-on-exit still applies.
const runtimeRoot = join(tmpdir(), 'onward-gns')
const sourcesRoot = join(runtimeRoot, 'sources')
const workspaceRoot = join(runtimeRoot, 'workspace')
const rootRepo = join(workspaceRoot, 'root')

// Shared git args injected into EVERY spawn so the deep submodule chain never
// trips MAX_PATH and file:// submodule URLs are always permitted.
// - core.longpaths=true: opt into Windows long-path support for git's own
//   internal paths (.git/modules/.../objects/pack/*.keep at depth 5).
// - protocol.file.allow=always: allow local file:// submodule sources, which
//   modern git blocks by default during submodule add/update.
const GIT_SHARED_CONFIG = [
  '-c', 'core.longpaths=true',
  '-c', 'protocol.file.allow=always'
]

function git(cwd, args) {
  execFileSync('git', [...GIT_SHARED_CONFIG, ...args], {
    cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      GIT_TERMINAL_PROMPT: '0'
    }
  })
}

function write(repoRoot, relativePath, content) {
  const filePath = join(repoRoot, relativePath)
  mkdirSync(dirname(filePath), { recursive: true })
  writeFileSync(filePath, content, 'utf8')
}

function append(repoRoot, relativePath, content) {
  appendFileSync(join(repoRoot, relativePath), content, 'utf8')
}

function commitAll(repoRoot, message) {
  git(repoRoot, ['add', '.'])
  git(repoRoot, [
    '-c', 'user.name=Onward AutoTest',
    '-c', 'user.email=autotest@example.com',
    'commit',
    '-m',
    message
  ])
}

function initRepo(repoRoot, level) {
  mkdirSync(repoRoot, { recursive: true })
  git(repoRoot, ['init'])
  write(repoRoot, `level-${level}.txt`, `level ${level} base\n`)
  commitAll(repoRoot, `level-${level}: initial commit`)
  append(repoRoot, `level-${level}.txt`, `level ${level} committed update\n`)
  commitAll(repoRoot, `level-${level}: committed update`)
}

function addSubmodule(repoRoot, sourceRepoRoot, targetPath) {
  // protocol.file.allow / core.longpaths are injected by the shared git() helper.
  git(repoRoot, [
    'submodule',
    'add',
    pathToFileURL(sourceRepoRoot).href,
    targetPath
  ])
}

function ensureFixture() {
  // Runtime now lives under a short OS-temp base (see runtimeRoot). Wipe any
  // leftover from a prior run, then rebuild from scratch.
  rmSync(runtimeRoot, { recursive: true, force: true })
  mkdirSync(sourcesRoot, { recursive: true })
  mkdirSync(workspaceRoot, { recursive: true })

  const levelRoots = new Map()
  for (let level = 5; level >= 1; level -= 1) {
    const repoRoot = join(sourcesRoot, `level-${level}`)
    initRepo(repoRoot, level)
    const childRoot = levelRoots.get(level + 1)
    if (childRoot) {
      addSubmodule(repoRoot, childRoot, `deps/level-${level + 1}`)
      commitAll(repoRoot, `level-${level}: add level-${level + 1} submodule`)
      // Non-recursive on purpose. `submodule add` + the commit above already
      // recorded this level's gitlink to its DIRECT child; the child's own
      // nested gitlinks live in the child's committed objects and travel up the
      // chain when the NEXT level clones this one. Recursing here re-clones the
      // entire growing subtree at every level (O(depth^2) git spawns), which on
      // an EDR/anti-malware host — where each git spawn is taxed 1.3-12.9s —
      // ballooned the cold fixture build past the 180s per-runner budget. Only
      // the final root working tree (line ~115 below) is actually tested, and it
      // does its own `--recursive` update to materialise the full 5-deep tree.
      git(repoRoot, ['submodule', 'update', '--init'])
    }
    levelRoots.set(level, repoRoot)
  }

  mkdirSync(rootRepo, { recursive: true })
  git(rootRepo, ['init'])
  write(rootRepo, 'root-owned.txt', 'root base\n')
  commitAll(rootRepo, 'root: initial commit')
  append(rootRepo, 'root-owned.txt', 'root committed update\n')
  commitAll(rootRepo, 'root: committed update')
  addSubmodule(rootRepo, levelRoots.get(1), 'modules/level-1')
  commitAll(rootRepo, 'root: add level-1 submodule')
  git(rootRepo, ['submodule', 'update', '--init', '--recursive'])

  append(rootRepo, 'root-owned.txt', 'root dirty worktree change\n')
  append(rootRepo, join('modules', 'level-1', 'level-1.txt'), 'level 1 dirty worktree change\n')
  append(rootRepo, join('modules', 'level-1', 'deps', 'level-2', 'level-2.txt'), 'level 2 dirty worktree change\n')
  append(rootRepo, join('modules', 'level-1', 'deps', 'level-2', 'deps', 'level-3', 'level-3.txt'), 'level 3 dirty worktree change\n')
  append(rootRepo, join('modules', 'level-1', 'deps', 'level-2', 'deps', 'level-3', 'deps', 'level-4', 'level-4.txt'), 'level 4 dirty worktree change\n')
  append(rootRepo, join('modules', 'level-1', 'deps', 'level-2', 'deps', 'level-3', 'deps', 'level-4', 'deps', 'level-5', 'level-5.txt'), 'level 5 dirty worktree change\n')

  write(rootRepo, join('modules', 'level-1', 'deps', 'level-2', 'level-2-untracked.txt'), 'level 2 untracked file\n')
  write(rootRepo, 'root-untracked.txt', 'root untracked file\n')
}

ensureFixture()

const levelPaths = {}
let nestedPath = join(rootRepo, 'modules', 'level-1')
for (let level = 1; level <= 5; level += 1) {
  levelPaths[`level${level}`] = nestedPath
  nestedPath = join(nestedPath, 'deps', `level-${level + 1}`)
}

if (!existsSync(rootRepo)) {
  throw new Error(`Fixture root was not created: ${rootRepo}`)
}

process.stdout.write(JSON.stringify({
  fixtureRoot,
  runtimeRoot,
  repoRoot: rootRepo,
  levelPaths
}))
