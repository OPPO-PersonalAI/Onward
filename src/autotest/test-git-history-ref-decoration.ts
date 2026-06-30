/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Git History ref-decoration freshness regression suite.
 *
 * Locks the whole class behind the "phantom fork after push" bug: the History
 * graph's `%D` decorations (branch / remote-tracking / tag labels) must refresh
 * whenever a ref moves, EVEN when HEAD (branchOid) does not move — the case the
 * old branchOid-only L8 cache key missed. Coverage matrix (one fixture repo):
 *
 *   RD-02  remote-tracking ref advance (push)            refs/remotes, HEAD fixed
 *   RD-03  local branch create                            refs/heads create
 *   RD-04  local branch move (branch -f)                  refs/heads move
 *   RD-05  local branch delete                            refs/heads delete
 *   RD-06  tag create                                     refs/tags create
 *   RD-07  tag delete                                     refs/tags delete
 *   RD-08  linked worktree: shared ref move refreshes     commondir topology (field context)
 *
 * Each step changes a ref via the terminal (real git), then reopens History and
 * asserts the decoration followed. The decoration source flows through the real
 * GitStateMirror refsDigest → L8 cache key path; a stale cache (the bug) cannot
 * pass these. Single terminal; uses the autotest debug API for decorations.
 */
import type { AutotestContext, TestResult } from './types'
import { buildChangeDirectoryCommand, type TerminalShellKind } from '../utils/terminal-command'

function normalizePath(value: string): string {
  return value.replace(/\\/g, '/').replace(/\/+$/, '')
}

function joinPath(base: string, child: string): string {
  return `${base.replace(/[\\/]+$/, '')}/${child}`
}

function lastSegment(value: string): string {
  const normalized = value.replace(/[\\/]+$/, '')
  const i = Math.max(normalized.lastIndexOf('/'), normalized.lastIndexOf('\\'))
  return i >= 0 ? normalized.slice(i + 1) : normalized
}

function getFixtureBase(rootPath: string): string {
  const configured = window.electronAPI.debug.autotestFixtureExtra?.trim()
  if (configured) return configured
  return joinPath(rootPath, 'test/autotest/results/git-history-ref-decoration')
}

function getVisibleTerminalIds(): string[] {
  const nodes = Array.from(document.querySelectorAll<HTMLElement>('[data-terminal-id]'))
  return Array.from(new Set(nodes.map((n) => n.dataset.terminalId ?? '').filter(Boolean)))
}

function dispatchEscape(): void {
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true, cancelable: true }))
}

async function resolveTerminalShellKind(terminalId: string): Promise<TerminalShellKind | undefined> {
  try {
    return (await window.electronAPI.terminal.getInputCapabilities(terminalId)).shellKind
  } catch {
    return undefined
  }
}

async function waitForTerminalCwd(
  terminalId: string,
  expectedCwd: string,
  sleep: (ms: number) => Promise<void>,
  timeoutMs = 12000
): Promise<string | null> {
  const startedAt = performance.now()
  const expected = normalizePath(expectedCwd)
  while (performance.now() - startedAt < timeoutMs) {
    const cwd = await window.electronAPI.git.getTerminalCwd(terminalId)
    if (cwd && normalizePath(cwd) === expected) return cwd
    await sleep(180)
  }
  return null
}

async function writeAndSyncTerminal(terminalId: string, command: string, sleep: (ms: number) => Promise<void>): Promise<void> {
  await window.electronAPI.terminal.write(terminalId, command)
  await sleep(400)
  await window.electronAPI.git.notifyTerminalActivity(terminalId)
  await sleep(400)
}

export async function testGitHistoryRefDecoration(ctx: AutotestContext): Promise<TestResult[]> {
  const { log, sleep, waitFor, assert, cancelled, rootPath } = ctx
  const results: TestResult[] = []
  const _assert = (name: string, ok: boolean, detail?: Record<string, unknown>) => {
    assert(name, ok, detail)
    results.push({ name, ok, detail })
  }

  const getApi = () => window.__onwardGitHistoryDebug
  const fixtureBase = getFixtureBase(rootPath)
  const fixtureRoot = joinPath(fixtureBase, `onward-autotest-refdec-${Date.now()}`)
  const worktreeRoot = `${fixtureRoot}-wt`
  let terminalId: string | null = null

  // %D renders branches as "<name>", remote-tracking as "origin/<name>", tags as
  // "tag: <name>". `refsForSummary` returns the raw `%D` string for a commit.
  const refsForSummary = (summary: string): string =>
    getApi()?.getCommits?.().find((c) => c.summary === summary)?.refs ?? ''

  // Close → reopen History (a fresh getHistory read picks up the CURRENT
  // refsDigest), wait for it to finish loading. The decoration is whatever the
  // freshly-built `%D` says, so a stale cache (the bug) shows the OLD label here.
  const reopenHistory = async (tid: string): Promise<boolean> => {
    dispatchEscape()
    await waitFor('refdec-close', () => !getApi() || !getApi()!.isOpen(), 4000)
    window.dispatchEvent(new CustomEvent('git-history:open', { detail: { terminalId: tid } }))
    return await waitFor(
      'refdec-reopen-loaded',
      () => Boolean(getApi()?.isOpen() && getApi()!.getCommitCount() > 0 && !getApi()!.isLoading()),
      30000
    )
  }

  // Re-fetch History until the decoration for `summary` reaches the expected
  // contains/absent state for `token`. The mirror recompute that produces the new
  // refsDigest can lag the shell git op under EDR (and for a worktree's shared
  // ref it may arrive via the reconcile heartbeat rather than the watcher), so we
  // re-trigger the open until it converges or the budget elapses.
  const waitForDecoration = async (tid: string, summary: string, token: string, shouldContain: boolean): Promise<boolean> => {
    const startedAt = performance.now()
    while (performance.now() - startedAt < 40000 && !cancelled()) {
      if (await reopenHistory(tid) && refsForSummary(summary).includes(token) === shouldContain) return true
      await sleep(800)
    }
    return false
  }

  log('refdec:start', { rootPath, fixtureBase, fixtureRoot, worktreeRoot })

  try {
    const ids = getVisibleTerminalIds()
    terminalId = ids[0] ?? null
    _assert('RD-01-terminal-available', Boolean(terminalId), { terminalId, ids })
    if (!terminalId || cancelled()) return results

    const platform = window.electronAPI.platform
    const fixtureShellPath = platform === 'win32' ? fixtureRoot.replace(/\//g, '\\') : fixtureRoot
    // Build a 3-commit fixture repo (fixture → base → head) so refs can point at
    // distinct commits (HEAD, HEAD~1). core.autocrlf=false pins LF blobs so a
    // Windows host's global autocrlf cannot perturb the fixture.
    const commit = (msg: string, file: string, content: string): string[] => platform === 'win32'
      ? [`Set-Content -LiteralPath "${file}" -Value "${content}"`, `git add ${file}`,
         `git -c user.name="Onward AutoTest" -c user.email="autotest@example.com" commit -m "${msg}" | Out-Null`]
      : [`printf "${content}\\n" > ${file}`, `git add ${file}`,
         `git -c user.name="Onward AutoTest" -c user.email="autotest@example.com" commit -m "${msg}" >/dev/null 2>&1`]
    const fixtureCommand = (platform === 'win32'
      ? [
        `$fixtureRoot = "${fixtureShellPath}"`,
        'if (Test-Path $fixtureRoot) { Remove-Item -Recurse -Force $fixtureRoot }',
        'New-Item -ItemType Directory -Path $fixtureRoot | Out-Null',
        'Set-Location $fixtureRoot',
        'git init | Out-Null',
        'git config core.autocrlf false',
        ...commit('fixture', 'README.md', 'fixture'),
        ...commit('history base', 'ledger.txt', 'history base'),
        ...commit('history head', 'ledger.txt', 'history head')
      ].join('; ')
      : [
        `rm -rf "${fixtureShellPath}"`,
        `mkdir -p "${fixtureShellPath}"`,
        `cd "${fixtureShellPath}"`,
        'git init >/dev/null 2>&1',
        'git config core.autocrlf false',
        ...commit('fixture', 'README.md', 'fixture'),
        ...commit('history base', 'ledger.txt', 'history base'),
        ...commit('history head', 'ledger.txt', 'history head')
      ].join(' && ')) + '\r'

    await writeAndSyncTerminal(terminalId, fixtureCommand, sleep)
    // Heavy multi-commit fixture under EDR spawn tax → generous cwd budget.
    const cwd = await waitForTerminalCwd(terminalId, fixtureRoot, sleep, 90000)
    _assert('RD-01b-fixture-ready', Boolean(cwd), { expected: normalizePath(fixtureRoot), actual: cwd ? normalizePath(cwd) : null })
    if (!cwd || cancelled()) return results

    const opened = await reopenHistory(terminalId)
    _assert('RD-01c-history-open', opened, { commitCount: getApi()?.getCommitCount() ?? 0 })
    if (!opened || cancelled()) return results

    // RD-02 — remote-tracking ref advance (push). HEAD/branchOid never move.
    await writeAndSyncTerminal(terminalId, 'git update-ref refs/remotes/origin/rd-test HEAD~1\r', sleep)
    const remoteOnBase = await waitForDecoration(terminalId, 'history base', 'origin/rd-test', true)
    _assert('RD-02a-remote-ref-decorates-base', remoteOnBase, { baseRefs: refsForSummary('history base') })
    await writeAndSyncTerminal(terminalId, 'git update-ref refs/remotes/origin/rd-test HEAD\r', sleep)
    const remoteFollowed = await waitForDecoration(terminalId, 'history head', 'origin/rd-test', true)
    const remoteClearedBase = !refsForSummary('history base').includes('origin/rd-test')
    _assert('RD-02b-push-advances-decoration', Boolean(remoteFollowed && remoteClearedBase), {
      headRefs: refsForSummary('history head'), baseRefs: refsForSummary('history base')
    })

    // RD-03 — local branch create (refs/heads).
    await writeAndSyncTerminal(terminalId, 'git branch rd-feature HEAD~1\r', sleep)
    const branchCreated = await waitForDecoration(terminalId, 'history base', 'rd-feature', true)
    _assert('RD-03-local-branch-create-decorates', branchCreated, { baseRefs: refsForSummary('history base') })

    // RD-04 — local branch move (branch -f). HEAD unchanged.
    await writeAndSyncTerminal(terminalId, 'git branch -f rd-feature HEAD\r', sleep)
    const branchMoved = await waitForDecoration(terminalId, 'history head', 'rd-feature', true)
    const branchClearedBase = !refsForSummary('history base').includes('rd-feature')
    _assert('RD-04-local-branch-move-follows', Boolean(branchMoved && branchClearedBase), {
      headRefs: refsForSummary('history head'), baseRefs: refsForSummary('history base')
    })

    // RD-05 — local branch delete.
    await writeAndSyncTerminal(terminalId, 'git branch -D rd-feature\r', sleep)
    const branchDeleted = await waitForDecoration(terminalId, 'history head', 'rd-feature', false)
    _assert('RD-05-local-branch-delete-clears', branchDeleted, { headRefs: refsForSummary('history head') })

    // RD-06 — tag create (refs/tags; now in refsDigest scope so it must refresh).
    await writeAndSyncTerminal(terminalId, 'git tag rd-v1 HEAD~1\r', sleep)
    const tagCreated = await waitForDecoration(terminalId, 'history base', 'rd-v1', true)
    _assert('RD-06-tag-create-decorates', tagCreated, { baseRefs: refsForSummary('history base') })

    // RD-07 — tag delete.
    await writeAndSyncTerminal(terminalId, 'git tag -d rd-v1\r', sleep)
    const tagDeleted = await waitForDecoration(terminalId, 'history base', 'rd-v1', false)
    _assert('RD-07-tag-delete-clears', tagDeleted, { baseRefs: refsForSummary('history base') })

    // RD-08 — linked worktree (the field-bug topology): a ref moved in the SHARED
    // common dir must refresh the worktree's History. The worktree's refs/remotes
    // live in commondir, so this exercises the digest's commondir resolution end
    // to end (and the reconcile heartbeat fallback if the watcher misses common).
    const worktreeShellPath = platform === 'win32' ? worktreeRoot.replace(/\//g, '\\') : worktreeRoot
    await writeAndSyncTerminal(terminalId, `git worktree add "${worktreeShellPath}" -b rd-wt HEAD\r`, sleep)
    const shellKind = await resolveTerminalShellKind(terminalId)
    await writeAndSyncTerminal(terminalId, buildChangeDirectoryCommand(platform, worktreeShellPath, shellKind), sleep)
    const wtCwd = await waitForTerminalCwd(terminalId, worktreeRoot, sleep, 60000)
    _assert('RD-08a-worktree-cwd-ready', Boolean(wtCwd), { expected: normalizePath(worktreeRoot), actual: wtCwd ? normalizePath(wtCwd) : null })
    if (wtCwd && !cancelled()) {
      const wtOpened = await reopenHistory(terminalId)
      // Move the SHARED remote-tracking ref from the worktree; HEAD of the worktree
      // (rd-wt) does not move. Decoration must follow to "history base".
      await writeAndSyncTerminal(terminalId, 'git update-ref refs/remotes/origin/rd-test HEAD~1\r', sleep)
      const wtDecorated = await waitForDecoration(terminalId, 'history base', 'origin/rd-test', true)
      _assert('RD-08b-worktree-shared-ref-refreshes', Boolean(wtOpened && wtDecorated), {
        baseRefs: refsForSummary('history base'), headRefs: refsForSummary('history head')
      })
    }

    dispatchEscape()
    await waitFor('refdec-final-close', () => !getApi() || !getApi()!.isOpen(), 4000)
    log('refdec:done', { total: results.length, passed: results.filter((r) => r.ok).length, failed: results.filter((r) => !r.ok).length })
    return results
  } finally {
    try {
      const platform = window.electronAPI.platform
      const rootShellPath = platform === 'win32' ? rootPath.replace(/\//g, '\\') : rootPath
      if (terminalId) await writeAndSyncTerminal(terminalId, buildChangeDirectoryCommand(platform, rootShellPath), sleep)
    } catch (error) {
      log('refdec:cleanup-cwd-error', { error: String(error) })
    }
    for (const targetRoot of [worktreeRoot, fixtureRoot]) {
      try {
        const cleanup = await window.electronAPI.project.deletePath(fixtureBase, lastSegment(targetRoot))
        log('refdec:cleanup-fixture', { fixtureBase, targetRoot, cleanup })
      } catch (error) {
        log('refdec:cleanup-fixture-error', { fixtureBase, targetRoot, error: String(error) })
      }
    }
  }
}
