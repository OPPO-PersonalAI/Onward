/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 *
 * Usage: node --experimental-strip-types --test test/unittest/git-command-classifier.test.mts
 *
 * Locks the terminal-command → reconcile decision table (2026-07-05 diagnostic
 * bundles: watcher-missed `git commit` left the diff list + tab colour stale).
 * The classifier is the pure heart of the watcher-independent freshness path
 * (VS Code's model): a completed `git <subcommand>` that MUTATES state triggers
 * a mirror reconcile; a read-only one (status/log/diff) must NOT, so an agent
 * spamming `git status` cannot storm the reconcile lane. Also pins the
 * repo-creating (`init`/`clone`) flag that additionally drives watcher re-attach.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { classifyGitCommandLine } from '../../src/utils/git-command-classifier.ts'

test('non-git and empty lines are not classified as git', () => {
  for (const line of ['', '   ', 'ls -la', 'npm run build', 'echo git commit', 'cd repo', 'grep git file']) {
    const c = classifyGitCommandLine(line)
    assert.equal(c.isGit, false, `"${line}" should not be git`)
    assert.equal(c.mutatesState, false)
    assert.equal(c.createsRepo, false)
    assert.equal(c.subcommand, null)
  }
})

test('mutating subcommands trigger reconcile', () => {
  const mutating = [
    'git commit -m "msg"',
    'git commit',
    'git merge feature',
    'git rebase -i HEAD~3',
    'git reset --hard HEAD',
    'git revert abc123',
    'git cherry-pick abc',
    'git checkout main',
    'git switch -c topic',
    'git restore src/a.ts',
    'git pull',
    'git push origin main',
    'git fetch --all',
    'git add -A',
    'git rm file.txt',
    'git mv a b',
    'git stash',
    'git apply patch.diff',
    'git am < patch',
    'git clean -fd',
    'git worktree add ../wt'
  ]
  for (const line of mutating) {
    const c = classifyGitCommandLine(line)
    assert.equal(c.isGit, true, `"${line}" should be git`)
    assert.equal(c.mutatesState, true, `"${line}" should mutate state`)
  }
})

test('read-only subcommands do NOT trigger reconcile', () => {
  const readOnly = [
    'git status',
    'git status --porcelain',
    'git log --oneline',
    'git diff',
    'git diff HEAD',
    'git show HEAD',
    'git blame file',
    'git rev-parse HEAD',
    'git branch',        // list form — conservative: no reconcile
    'git tag',           // list form
    'git remote -v',
    'git config user.name',
    'git' // bare git → help/usage
  ]
  for (const line of readOnly) {
    const c = classifyGitCommandLine(line)
    assert.equal(c.mutatesState, false, `"${line}" should NOT mutate state`)
  }
})

test('init and clone set createsRepo (drives watcher re-attach)', () => {
  for (const line of ['git init', 'git init .', 'git clone https://example.com/r.git']) {
    const c = classifyGitCommandLine(line)
    assert.equal(c.isGit, true)
    assert.equal(c.mutatesState, true)
    assert.equal(c.createsRepo, true, `"${line}" should create a repo`)
  }
  // A mutation that is NOT repo-creating.
  assert.equal(classifyGitCommandLine('git commit').createsRepo, false)
})

test('leading env-assignments and sudo/env wrappers are peeled', () => {
  assert.equal(classifyGitCommandLine('GIT_DIR=.git git commit').mutatesState, true)
  assert.equal(classifyGitCommandLine('GIT_DIR=.git GIT_WORK_TREE=. git add .').mutatesState, true)
  assert.equal(classifyGitCommandLine('sudo git reset --hard').mutatesState, true)
  assert.equal(classifyGitCommandLine('env GIT_PAGER=cat git commit').mutatesState, true)
  assert.equal(classifyGitCommandLine('command git switch main').mutatesState, true)
})

test('git global options before the subcommand are skipped', () => {
  assert.equal(classifyGitCommandLine('git -C /repo commit').subcommand, 'commit')
  assert.equal(classifyGitCommandLine('git --git-dir=/r/.git status').subcommand, 'status')
  assert.equal(classifyGitCommandLine('git -c user.name=x commit -m y').subcommand, 'commit')
  assert.equal(classifyGitCommandLine('git --no-pager log').subcommand, 'log')
  assert.equal(classifyGitCommandLine('git -C /repo add .').mutatesState, true)
})

test('absolute/relative git paths and git.exe resolve to the leaf', () => {
  // Real shells quote a path containing spaces, so the classifier only ever
  // sees whitespace-free command words (the shell-integration gate also only
  // re-emits lines whose command word is `git`).
  assert.equal(classifyGitCommandLine('/usr/bin/git commit').mutatesState, true)
  assert.equal(classifyGitCommandLine('C:/Git/cmd/git.exe commit').mutatesState, true)
  assert.equal(classifyGitCommandLine('git.exe commit').mutatesState, true)
  assert.equal(classifyGitCommandLine('./git status').isGit, true)
})

test('subcommand casing is normalized', () => {
  assert.equal(classifyGitCommandLine('git COMMIT').subcommand, 'commit')
  assert.equal(classifyGitCommandLine('git Commit').mutatesState, true)
})
