/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * GitStateMirror subscription-leak suite (SL-*).
 *
 * Locks the dead-repo-churn bug class from the 2026-07-04 diagnostic bundle:
 * 3 of 5 mirrored repos had NO live terminal yet recomputed `git status`
 * ~950 times each (~2 spawns × 3 s per round on the EDR host). Root cause:
 * a renderer RELOAD never fires Electron's webContents 'destroyed' event, so
 * the router's per-renderer subscription refCounts survived the reload while
 * the renderer-side owners (TerminalGrid desired-set, GitDiffViewer aux
 * roots) were wiped — React unmount cleanup does not run on reload. After
 * reload the renderer re-subscribes live cwds (count 1→2), and a later
 * close/unsubscribe decrements only once → count parks at 1 forever → the
 * worker keeps the parcel-watcher + reconcile heartbeat alive until app
 * quit.
 *
 * The suite therefore RELOADS the real window mid-run. Phase state lives in
 * sessionStorage (survives reload, dies with the app session):
 *   phase 1 — subscribe fixture repos, record the pre-reload table, reload.
 *   phase 2 — (suite re-runs from the top) assert the pre-reload
 *             subscriptions were purged (SL-02) and that one
 *             subscribe+unsubscribe round now fully releases (SL-03).
 *
 * Assertions gate on the router's subscription tables via the autotest-only
 * `git-state-mirror:debug-inspect` IPC — platform-neutral outcome signals
 * with generous convergence polling, no wall-clock budgets (EDR-robust per
 * test/README.md § timing rules).
 */
import type { AutotestContext, TestResult } from './types'

interface LeakManifest {
  tempRoot: string
  repoA: string
  repoB: string
  neutralCwd: string
}

interface InspectResult {
  success: boolean
  error?: string
  refCounts?: Record<string, number>
  internalRefCounts?: Record<string, number>
  perRenderer?: Array<{ wcId: number; entries: Record<string, number> }>
  cwds?: string[]
}

const PHASE_KEY = 'onward-autotest-sl-phase'
const PRE_TABLE_KEY = 'onward-autotest-sl-pre-reload-refcounts'
/** Outcome-convergence ceiling; generous for EDR hosts, exits early on success. */
const CONVERGE_TIMEOUT_MS = 20_000
const CONVERGE_INTERVAL_MS = 500

const dirOf = (p: string): string => p.replace(/[\\/]+$/, '').replace(/[\\/][^\\/]*$/, '')
const baseOf = (p: string): string => p.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? p
/** Case-insensitive forward-slash normalize: Windows canonicalise() may flip drive-letter case. */
const norm = (p: string): string => p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()

async function loadManifest(extraPath: string | null): Promise<LeakManifest | null> {
  if (!extraPath) return null
  const result = await window.electronAPI.project.readFile(dirOf(extraPath), baseOf(extraPath))
  if (!result.success || typeof result.content !== 'string') return null
  try {
    return JSON.parse(result.content) as LeakManifest
  } catch {
    return null
  }
}

async function inspect(): Promise<InspectResult> {
  try {
    return (await window.electronAPI.debug.gitStateMirrorDebugInspect()) as unknown as InspectResult
  } catch (error) {
    return { success: false, error: String(error) }
  }
}

/** refCount for a repo path, tolerant of canonical-form differences. */
function countFor(table: Record<string, number> | undefined, repo: string): number {
  if (!table) return 0
  const target = norm(repo)
  for (const [cwd, count] of Object.entries(table)) {
    if (norm(cwd) === target) return count
  }
  return 0
}

/** Poll the router table until `repo` reaches `expected` refCount (or timeout). */
async function waitForCount(
  sleep: (ms: number) => Promise<void>,
  repo: string,
  expected: number
): Promise<{ ok: boolean; last: InspectResult }> {
  const deadline = Date.now() + CONVERGE_TIMEOUT_MS
  let last: InspectResult = { success: false }
  while (Date.now() < deadline) {
    last = await inspect()
    if (last.success && countFor(last.refCounts, repo) === expected) {
      return { ok: true, last }
    }
    await sleep(CONVERGE_INTERVAL_MS)
  }
  return { ok: false, last }
}

export async function testGitStateMirrorSubscriptionLeak(ctx: AutotestContext): Promise<TestResult[]> {
  const { log, assert, sleep, cancelled } = ctx
  const results: TestResult[] = []
  const _assert = (name: string, ok: boolean, detail?: Record<string, unknown>) => {
    assert(name, ok, detail)
    results.push({ name, ok, detail })
  }

  const phase = window.sessionStorage.getItem(PHASE_KEY) ?? '1'
  log('gsm-subscription-leak:start', { phase })

  const manifest = await loadManifest(window.electronAPI.debug.autotestFixtureExtra)
  if (!manifest) {
    _assert('SL-00-fixture-loaded', false, { extraPath: window.electronAPI.debug.autotestFixtureExtra })
    return results
  }

  if (phase === '1') {
    _assert('SL-00-fixture-loaded', true, { repoA: manifest.repoA, repoB: manifest.repoB })

    // ── SL-01: baseline — one subscribe + one unsubscribe fully releases. ──
    await window.electronAPI.git.subscribeMirror(manifest.repoB)
    const afterSub = await inspect()
    const subscribed = countFor(afterSub.refCounts, manifest.repoB) === 1
    window.electronAPI.git.unsubscribeMirror(manifest.repoB)
    const release = await waitForCount(sleep, manifest.repoB, 0)
    _assert('SL-01-subscribe-unsubscribe-releases', subscribed && release.ok, {
      subscribed,
      released: release.ok,
      afterSub: afterSub.refCounts ?? null,
      final: release.last.refCounts ?? null
    })
    if (cancelled()) return results

    // ── SL-02/03 phase 1: subscribe repoA, snapshot, then REAL reload. ──
    await window.electronAPI.git.subscribeMirror(manifest.repoA)
    const preReload = await inspect()
    const preCount = countFor(preReload.refCounts, manifest.repoA)
    _assert('SL-02a-pre-reload-subscribed', preCount === 1, {
      preCount,
      refCounts: preReload.refCounts ?? null
    })
    window.sessionStorage.setItem(PHASE_KEY, '2')
    window.sessionStorage.setItem(PRE_TABLE_KEY, JSON.stringify(preReload.refCounts ?? {}))
    log('gsm-subscription-leak:reloading', {})
    await sleep(250) // let the log line flush over IPC before the world ends
    await window.electronAPI.debug.reloadWindow()
    // Execution must never proceed past a successful reload; if it does,
    // the reload IPC is broken and the suite must fail loudly rather than
    // silently skipping phase 2.
    await sleep(10_000)
    _assert('SL-02x-reload-did-not-happen', false, {})
    return results
  }

  // ─────────────────────── phase 2 (post-reload re-entry) ───────────────────────
  window.sessionStorage.removeItem(PHASE_KEY)
  const preTableRaw = window.sessionStorage.getItem(PRE_TABLE_KEY)
  window.sessionStorage.removeItem(PRE_TABLE_KEY)
  const preTable = preTableRaw ? (JSON.parse(preTableRaw) as Record<string, number>) : {}
  _assert('SL-00-fixture-loaded', true, { phase: 2, hadPreReloadCount: countFor(preTable, manifest.repoA) })

  // Let the post-reload renderer finish its own re-subscribes (terminal
  // cwds) so the table we assert on is settled.
  await sleep(3000)
  if (cancelled()) return results

  // ── SL-02b: the pre-reload subscription for repoA must be GONE. ──
  // Nothing re-subscribes repoA after reload (no terminal has that cwd), so
  // any surviving refCount is exactly the leaked pre-reload entry.
  const purge = await waitForCount(sleep, manifest.repoA, 0)
  _assert('SL-02b-post-reload-purged', purge.ok, {
    leakedCount: countFor(purge.last.refCounts, manifest.repoA),
    hadPreReloadCount: countFor(preTable, manifest.repoA),
    refCounts: purge.last.refCounts ?? null,
    perRenderer: purge.last.perRenderer ?? null
  })

  // ── SL-03: post-reload subscribe + unsubscribe round releases fully. ──
  // Pre-fix this failed via the production mechanism: the leaked count (1)
  // plus the new subscribe (→2) minus one unsubscribe left the watcher
  // pinned at 1 — the exact TerminalGrid / Diff-close route of the
  // dead-repo churn.
  await window.electronAPI.git.subscribeMirror(manifest.repoA)
  const midTable = await inspect()
  const midCount = countFor(midTable.refCounts, manifest.repoA)
  window.electronAPI.git.unsubscribeMirror(manifest.repoA)
  const finalRelease = await waitForCount(sleep, manifest.repoA, 0)
  _assert('SL-03-post-reload-round-releases', midCount === 1 && finalRelease.ok, {
    midCount,
    endCount: countFor(finalRelease.last.refCounts, manifest.repoA),
    refCounts: finalRelease.last.refCounts ?? null
  })

  log('gsm-subscription-leak:done', {
    passed: results.filter((r) => r.ok).length,
    failed: results.filter((r) => !r.ok).length
  })
  return results
}
