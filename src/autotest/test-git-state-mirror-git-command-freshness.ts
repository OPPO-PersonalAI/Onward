/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * GitStateMirror git-command / revalidate freshness suite (GCF-*).
 *
 * Locks the watcher-independent-freshness fix for the 2026-07-05 diagnostic
 * bundles: the FS watcher is the SOLE freshness authority for the diff list +
 * tab status, and on Windows under EDR it silently drops `.git/**` events, so a
 * `git commit` / `git init` / edit leaves the mirror stale until manual refresh.
 * The fix reconciles on Git Diff open AND on completed terminal git commands
 * (VS Code's terminal-shell-integration model), and re-attaches the watcher when
 * a cwd becomes a git repo.
 *
 * Assertions drive the router via the real IPC surface (`revalidateMirror`,
 * `getMirror`) and the autotest-only `git init` IPC, with generous convergence
 * polling (no wall-clock budgets — EDR-robust per test/README.md § timing).
 *
 *   GCF-01  non-git → git detection via revalidate. A non-git cwd has NO
 *           watcher, so a fresh repoRoot detection after `git init` +
 *           revalidate is UNIQUELY attributable to the reconcile/re-attach fix
 *           (the BattleProject "not recognized" symptom).
 *   GCF-02  the re-attached watcher is LIVE: an external untracked file written
 *           AFTER the transition surfaces WITHOUT any further revalidate — only
 *           a live watcher could catch it.
 *   GCF-03  revalidate surfaces a working-tree change on an ESTABLISHED repo
 *           (the diff-open contract; not watcher-isolated — GCF-01/02 own the
 *           uniquely-attributable proof).
 *
 * The renderer OSC-633;E → classifier → IPC leg of the terminal-command path is
 * locked by unit tests (`git-command-classifier`, `terminal-cwd-osc`); its
 * router leg is `revalidateCwd`, the SAME method these assertions exercise.
 */
import type { AutotestContext, TestResult } from './types'

interface Manifest {
  tempRoot: string
  repo: string
  laterGit: string
  neutralCwd: string
}

interface MirrorSnapshot {
  repoRoot?: string | null
  files?: unknown[]
}

const CONVERGE_TIMEOUT_MS = 20_000
const CONVERGE_INTERVAL_MS = 400

const dirOf = (p: string): string => p.replace(/[\\/]+$/, '').replace(/[\\/][^\\/]*$/, '')
const baseOf = (p: string): string => p.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? p

async function loadManifest(extraPath: string | null): Promise<Manifest | null> {
  if (!extraPath) return null
  const result = await window.electronAPI.project.readFile(dirOf(extraPath), baseOf(extraPath))
  if (!result.success || typeof result.content !== 'string') return null
  try {
    return JSON.parse(result.content) as Manifest
  } catch {
    return null
  }
}

async function getSnapshot(cwd: string): Promise<MirrorSnapshot | null> {
  try {
    return (await window.electronAPI.git.getMirror(cwd)) as MirrorSnapshot | null
  } catch {
    return null
  }
}

/** Poll the mirror snapshot for `cwd` until `predicate` holds (or timeout). */
async function pollSnapshot(
  sleep: (ms: number) => Promise<void>,
  cwd: string,
  predicate: (s: MirrorSnapshot | null) => boolean
): Promise<{ ok: boolean; last: MirrorSnapshot | null }> {
  const deadline = Date.now() + CONVERGE_TIMEOUT_MS
  let last: MirrorSnapshot | null = null
  while (Date.now() < deadline) {
    last = await getSnapshot(cwd)
    if (predicate(last)) return { ok: true, last }
    await sleep(CONVERGE_INTERVAL_MS)
  }
  return { ok: false, last }
}

const fileCount = (s: MirrorSnapshot | null): number => (Array.isArray(s?.files) ? s!.files!.length : 0)

export async function testGitStateMirrorGitCommandFreshness(ctx: AutotestContext): Promise<TestResult[]> {
  const { assert, sleep, cancelled, log } = ctx
  const results: TestResult[] = []
  const _assert = (name: string, ok: boolean, detail?: Record<string, unknown>) => {
    assert(name, ok, detail)
    results.push({ name, ok, detail })
  }

  log('gcf:start', {})
  const manifest = await loadManifest(window.electronAPI.debug.autotestFixtureExtra)
  if (!manifest) {
    _assert('GCF-00-fixture-loaded', false, { extraPath: window.electronAPI.debug.autotestFixtureExtra })
    return results
  }
  _assert('GCF-00-fixture-loaded', true, { repo: manifest.repo, laterGit: manifest.laterGit })

  // ── GCF-01: non-git → git detection via revalidate (uniquely attributable). ──
  await window.electronAPI.git.subscribeMirror(manifest.laterGit)
  // Wait for the attach recompute to land a snapshot, then confirm it is non-git.
  const preAttach = await pollSnapshot(sleep, manifest.laterGit, (s) => s != null)
  const preNonGit = !preAttach.last?.repoRoot
  const initRes = await window.electronAPI.debug.gitInitForAutotest({ dir: manifest.laterGit })
  // The fix: revalidate discovers the transition even though no watcher exists.
  window.electronAPI.git.revalidateMirror(manifest.laterGit)
  const detected = await pollSnapshot(sleep, manifest.laterGit, (s) => Boolean(s?.repoRoot))
  _assert('GCF-01-non-git-to-git-detected-via-revalidate', preNonGit && initRes.ok && detected.ok, {
    preNonGit,
    gitInitOk: initRes.ok,
    gitInitError: initRes.error ?? null,
    detected: detected.ok,
    repoRoot: detected.last?.repoRoot ?? null
  })
  if (cancelled()) return results

  // ── GCF-02: the re-attached watcher is LIVE (no revalidate this time). ──
  const baseFiles = fileCount(detected.last)
  await window.electronAPI.debug.writeExternalFile({
    root: manifest.laterGit,
    relPath: 'gcf-untracked-after-init.txt',
    content: 'surfaced by the re-attached watcher\n'
  })
  const watched = await pollSnapshot(sleep, manifest.laterGit, (s) => fileCount(s) > baseFiles)
  _assert('GCF-02-reattached-watcher-is-live', watched.ok, {
    baseFiles,
    afterFiles: fileCount(watched.last),
    note: 'no revalidate issued — only a live re-attached watcher can surface this untracked file'
  })
  if (cancelled()) return results

  // ── GCF-03: revalidate surfaces a working-tree change on an established repo. ──
  await window.electronAPI.git.subscribeMirror(manifest.repo)
  const repoBase = await pollSnapshot(sleep, manifest.repo, (s) => s != null)
  const repoBaseFiles = fileCount(repoBase.last)
  await window.electronAPI.debug.writeExternalFile({
    root: manifest.repo,
    relPath: 'gcf-untracked.txt',
    content: 'x\n'
  })
  window.electronAPI.git.revalidateMirror(manifest.repo)
  const repoFresh = await pollSnapshot(sleep, manifest.repo, (s) => fileCount(s) > repoBaseFiles)
  _assert('GCF-03-revalidate-surfaces-worktree-change', repoFresh.ok, {
    repoBaseFiles,
    afterFiles: fileCount(repoFresh.last)
  })

  window.electronAPI.git.unsubscribeMirror(manifest.laterGit)
  window.electronAPI.git.unsubscribeMirror(manifest.repo)
  return results
}
