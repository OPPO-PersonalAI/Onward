/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Git ahead/behind + background auto-fetch suite (AB-*).
 *
 * Locks the new "local ahead / remote behind" Task-badge feature end-to-end
 * against REAL git repos (a local bare remote + clones, no network):
 *
 *   AB-01 up-to-date   → snapshot ahead 0, behind 0
 *   AB-02 ahead-only   → ahead 2, behind 0   (unpushed local commits)
 *   AB-03 behind-only  → ahead 0, behind 1
 *   AB-04 diverged     → ahead 1, behind 1
 *   AB-05 no-upstream  → ahead/behind undefined (local-only branch)
 *   AB-06 fetch flip   → a clone whose origin ref is stale reads behind 0; after
 *                        a background fetch (the autotest-only force hook) the
 *                        mirror re-reads # branch.ab and behind flips to 1.
 *
 * BUG-0005 additions — a fetch that never succeeds must be both DIAGNOSABLE and
 * VISIBLE, because the field bundle had a repo go 98.8 h with zero successful
 * fetches while the badge kept presenting its behind count as current:
 *
 *   AB-07 fail payload  → a fast failure (origin points nowhere) carries
 *                         classified / exitCode / stderrTail, not just `reason`
 *   AB-08 timeout payload → a fetch killed by the 20 s ceiling ALSO carries
 *                         classified + stderrTail. This is the exact branch that
 *                         used to short-circuit past classifyFetchFailure and
 *                         discard stderr, and it is why 6 of 9 field failures
 *                         were undiagnosable
 *   AB-09 fresh success → a successful fetch stamps lastFetchOkAt onto the
 *                         renderer-visible snapshot (the badge's staleness input)
 *   AB-10 fresh failure → a failed fetch stamps lastFetchAttemptAt but leaves
 *                         lastFetchOkAt unset — the precise state the pure
 *                         resolveGitSyncFreshness table renders as stale
 *
 * The stale RENDERING itself (muted `↓`, `↓?` placeholder, tooltip) is a pure
 * function of those two timestamps and is locked by git-sync-display's unit
 * test; these cases lock the plumbing that supplies them.
 *
 * AB-01..05 prove the parse → worker → IPC → renderer-snapshot pipeline (the
 * `# branch.ab` values reach the snapshot the badge renders from). The
 * snapshot → DOM mapping (green dot + ↑N/↓M arrows) is locked by the pure
 * `git-sync-display` unit test. AB-06 is the Phase-2 proof: the hardened
 * `git fetch` spawn + revalidate wiring actually refreshes behind.
 *
 * Reads the mirror via the real IPC surface (`subscribeMirror` / `getMirror`),
 * with generous convergence polling (no wall-clock budgets — EDR-robust per
 * test/README.md § timing).
 */
import type { AutotestContext, TestResult } from './types'

interface Manifest {
  tempRoot: string
  remote: string
  upToDate: string
  ahead: string
  behind: string
  diverged: string
  fetchBehind: string
  failFetch: string
  timeoutFetch: string
  noUpstream: string
  neutralCwd: string
}

interface MirrorSnapshot {
  repoRoot?: string | null
  status?: string | null
  ahead?: number
  behind?: number
  lastFetchOkAt?: number
  lastFetchAttemptAt?: number
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

/** Subscribe and wait for a classified snapshot (repoRoot resolved). */
async function subscribeClassified(
  sleep: (ms: number) => Promise<void>,
  cwd: string
): Promise<MirrorSnapshot | null> {
  await window.electronAPI.git.subscribeMirror(cwd)
  const res = await pollSnapshot(sleep, cwd, (s) => Boolean(s?.repoRoot) && s?.status != null)
  return res.last
}

export async function testGitAutofetchAheadBehind(ctx: AutotestContext): Promise<TestResult[]> {
  const { assert, sleep, cancelled, log } = ctx
  const results: TestResult[] = []
  const _assert = (name: string, ok: boolean, detail?: Record<string, unknown>) => {
    assert(name, ok, detail)
    results.push({ name, ok, detail })
  }

  log('ab:start', {})
  const manifest = await loadManifest(window.electronAPI.debug.autotestFixtureExtra)
  if (!manifest) {
    _assert('AB-00-fixture-loaded', false, { extraPath: window.electronAPI.debug.autotestFixtureExtra })
    return results
  }
  _assert('AB-00-fixture-loaded', true, { tempRoot: manifest.tempRoot })

  const subscribed: string[] = []
  const track = (cwd: string) => { subscribed.push(cwd) }

  // ── AB-01..04: static ahead/behind states reach the snapshot. ──
  const cases: Array<{ id: string; cwd: string; ahead: number; behind: number; desc: string }> = [
    { id: 'AB-01-up-to-date', cwd: manifest.upToDate, ahead: 0, behind: 0, desc: 'HEAD == origin/main → 0/0' },
    { id: 'AB-02-ahead-only', cwd: manifest.ahead, ahead: 2, behind: 0, desc: 'two unpushed commits → ahead 2' },
    { id: 'AB-03-behind-only', cwd: manifest.behind, ahead: 0, behind: 1, desc: 'HEAD one behind origin → behind 1' },
    { id: 'AB-04-diverged', cwd: manifest.diverged, ahead: 1, behind: 1, desc: 'one local + one origin-only → 1/1' }
  ]
  for (const c of cases) {
    if (cancelled()) return results
    track(c.cwd)
    await window.electronAPI.git.subscribeMirror(c.cwd)
    const res = await pollSnapshot(
      sleep,
      c.cwd,
      (s) => Boolean(s?.repoRoot) && s?.ahead === c.ahead && s?.behind === c.behind
    )
    _assert(c.id, res.ok, {
      description: c.desc,
      expectedAhead: c.ahead,
      expectedBehind: c.behind,
      observedAhead: res.last?.ahead ?? null,
      observedBehind: res.last?.behind ?? null
    })
  }

  // ── AB-05: a local-only branch has NO upstream → ahead/behind undefined. ──
  if (!cancelled()) {
    track(manifest.noUpstream)
    const snap = await subscribeClassified(sleep, manifest.noUpstream)
    const ok = Boolean(snap?.repoRoot) && snap?.ahead === undefined && snap?.behind === undefined
    _assert('AB-05-no-upstream-undefined', ok, {
      description: 'A branch with no upstream emits no # branch.ab → no arrows',
      observedAhead: snap?.ahead ?? null,
      observedBehind: snap?.behind ?? null
    })
  }

  // ── AB-06: background fetch flips a stale behind 0 → behind 1. ──
  if (!cancelled()) {
    track(manifest.fetchBehind)
    const before = await subscribeClassified(sleep, manifest.fetchBehind)
    // Stale origin ref → behind reads 0 before any fetch.
    const staleOk = before?.ahead === 0 && before?.behind === 0
    const repoRoot = before?.repoRoot ?? manifest.fetchBehind
    const fetchRes = await window.electronAPI.debug.gitAutofetchForAutotest({ repoRoot })
    // After the fetch advances origin/main + the triggered revalidate, behind → 1.
    const after = await pollSnapshot(sleep, manifest.fetchBehind, (s) => s?.behind === 1)
    _assert('AB-06-background-fetch-flips-behind', staleOk && fetchRes.ok && after.ok, {
      description: 'Auto-fetch advances the remote-tracking ref → mirror re-reads # branch.ab → behind 1',
      staleBehindWas: before?.behind ?? null,
      fetchOk: fetchRes.ok,
      fetchReason: fetchRes.reason ?? null,
      observedBehindAfter: after.last?.behind ?? null
    })
  }

  // ── AB-09: a SUCCESSFUL fetch stamps lastFetchOkAt onto the snapshot. ──
  // Runs right after AB-06 so it observes that same fetch. This is the R3
  // plumbing: freshness is published by main and rides the existing mirror-delta
  // channel, so a regression here (a worker recompute dropping the field, the
  // delta not fanning out) silently disarms the whole stale treatment.
  if (!cancelled()) {
    const res = await pollSnapshot(
      sleep,
      manifest.fetchBehind,
      (s) => typeof s?.lastFetchOkAt === 'number' && (s.lastFetchOkAt ?? 0) > 0
    )
    _assert('AB-09-success-stamps-last-fetch-ok', res.ok, {
      description: 'A successful background fetch publishes lastFetchOkAt to the renderer snapshot',
      observedLastFetchOkAt: res.last?.lastFetchOkAt ?? null,
      observedLastFetchAttemptAt: res.last?.lastFetchAttemptAt ?? null
    })
  }

  // ── AB-07 + AB-10: a FAST failure carries full evidence and marks freshness. ──
  if (!cancelled()) {
    track(manifest.failFetch)
    const before = await subscribeClassified(sleep, manifest.failFetch)
    const repoRoot = before?.repoRoot ?? manifest.failFetch
    const fetchRes = await window.electronAPI.debug.gitAutofetchForAutotest({ repoRoot })

    // AB-07: the enriched failure payload. `reason` alone was all the field
    // bundle ever had; these are the fields that make it actionable.
    const payloadOk =
      fetchRes.ok === false &&
      fetchRes.killedByTimeout === false &&
      typeof fetchRes.classified === 'string' &&
      fetchRes.classified.length > 0 &&
      typeof fetchRes.exitCode === 'number' &&
      typeof fetchRes.stderrTail === 'string' &&
      fetchRes.stderrTail.length > 0
    _assert('AB-07-fast-failure-carries-evidence', payloadOk, {
      description: 'A non-timeout fetch failure reports classified + exitCode + stderrTail',
      ok: fetchRes.ok,
      reason: fetchRes.reason ?? null,
      classified: fetchRes.classified ?? null,
      exitCode: fetchRes.exitCode ?? null,
      killedByTimeout: fetchRes.killedByTimeout ?? null,
      stderrTailLength: (fetchRes.stderrTail ?? '').length
    })

    // AB-10: attempted-but-never-succeeded is exactly the state the badge must
    // render as stale. Assert the SHAPE, not the rendering (that is unit-tested).
    const freshness = await pollSnapshot(
      sleep,
      manifest.failFetch,
      (s) => typeof s?.lastFetchAttemptAt === 'number' && (s.lastFetchAttemptAt ?? 0) > 0
    )
    const neverSynced = freshness.last?.lastFetchOkAt === undefined
    _assert('AB-10-failure-marks-attempt-without-success', freshness.ok && neverSynced, {
      description:
        'A failed fetch stamps lastFetchAttemptAt and leaves lastFetchOkAt unset → the stale input state',
      observedLastFetchAttemptAt: freshness.last?.lastFetchAttemptAt ?? null,
      observedLastFetchOkAt: freshness.last?.lastFetchOkAt ?? null
    })
  }

  // ── AB-08: the 20 s TIMEOUT branch also carries evidence. ──
  // Deliberately last: it costs the full ceiling (~20 s) by construction, and a
  // hang is what we are asserting, so it must not delay the cheaper cases.
  if (!cancelled()) {
    track(manifest.timeoutFetch)
    const before = await subscribeClassified(sleep, manifest.timeoutFetch)
    const repoRoot = before?.repoRoot ?? manifest.timeoutFetch
    const fetchRes = await window.electronAPI.debug.gitAutofetchForAutotest({ repoRoot })
    const timeoutOk =
      fetchRes.ok === false &&
      fetchRes.reason === 'timeout' &&
      fetchRes.killedByTimeout === true &&
      // The regression guard: BOTH of these used to be absent on this branch.
      typeof fetchRes.classified === 'string' &&
      typeof fetchRes.stderrTail === 'string' &&
      fetchRes.stderrTail.length > 0
    _assert('AB-08-timeout-failure-carries-evidence', timeoutOk, {
      description:
        'A fetch killed by the 20 s ceiling still classifies stderr instead of discarding it',
      ok: fetchRes.ok,
      reason: fetchRes.reason ?? null,
      killedByTimeout: fetchRes.killedByTimeout ?? null,
      classified: fetchRes.classified ?? null,
      durationMs: fetchRes.durationMs ?? null,
      stderrTailLength: (fetchRes.stderrTail ?? '').length
    })
  }

  for (const cwd of subscribed) window.electronAPI.git.unsubscribeMirror(cwd)
  return results
}
