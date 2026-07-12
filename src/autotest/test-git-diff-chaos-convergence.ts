/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Git Diff chaos-convergence suite — the USER-PERSPECTIVE contract test for
 * the Agent Coding First workload.
 *
 * Every other Git Diff suite tests a MECHANISM (watcher fires, cache
 * invalidates, read revalidates) in a serialized world: mutate → wait → read.
 * This suite tests the CONTRACT in the concurrent world the product actually
 * lives in: an external writer (test/autotest/git-diff-chaos-writer.mjs, a
 * separate OS process — exactly like a coding agent in a terminal) mutates the
 * repo WHILE the "user" (this suite) opens Git Diff, clicks files, backs out
 * to the terminal and returns. After each write burst the writer quiesces and
 * captures the on-disk truth completely outside the app's caches; the
 * assertion is:
 *
 *   Within CHAOS_CONVERGENCE_SLO after the last write, the Git Diff UI must
 *   equal the on-disk truth — file-list set AND displayed bodies — WITHOUT a
 *   manual refresh.
 *
 * It does not matter WHICH mechanism failed (missed watcher event, poisoned
 * cache entry, renderer memory, invalidation race): any staleness the user
 * would see fails a cycle. The 2026-07-12 diagnostic bundle's TOCTOU class is
 * exactly the kind of defect the serialized suites could not construct and
 * this harness makes probable (writes overlap every read phase, including
 * content fetch and precompute).
 *
 * Determinism: writer ops are seed-fixed (replayable — the failure detail
 * always carries the seed); user actions use an independent fixed seed. The
 * verdict aggregates ALL cycles (boolean-recovery aggregation per the
 * timing-sensitive authoring rule).
 */

import type { AutotestContext, TestResult } from './types'
import {
  bodyCheckCandidates,
  compareBody,
  compareListToTruth,
  type ChaosTruthEntry
} from './git-diff-chaos-compare'
import { createChaosPrng, pickIndex } from './git-diff-chaos-prng'

interface ChaosManifest {
  tempRoot: string
  repoRoot: string
  stateDir: string
  seedFiles: string[]
  manifestPath: string
}

interface ChaosState {
  phase: 'waiting' | 'burst' | 'quiesced' | 'done' | 'error'
  cycle: number
  cycles?: number
  entryCount?: number
  error?: string
}

interface ChaosTruth {
  cycle: number
  seed: number
  capturedAt: number
  entries: ChaosTruthEntry[]
}

/**
 * Convergence SLO: how long after the writer quiesces the UI may take to
 * settle onto disk truth with no user intervention. Base covers the full
 * detect→invalidate→push→reload→repaint chain on a fast host with wide slack
 * (measured chain ≈ watcher debounce 80ms + status ~0.5s + fanout + forced
 * list/body reload ~1s). The EDR term scales by the measured first-open cost
 * (same convention as the GDS suite's adaptive budgets); the cap keeps a
 * genuinely-broken build from stretching the runner toward its watchdog.
 */
const CHAOS_CONVERGENCE_SLO_BASE_MS = 5_000
const CHAOS_CONVERGENCE_SLO_CAP_MS = 25_000
/** Max quiesced-body spot checks per convergence poll round. */
const CHAOS_BODY_SAMPLE_MAX = 3
/** User-action seed is independent of the writer's op seed. */
const CHAOS_USER_SEED = 913_20260712 % 2147483647

const dirOf = (p: string): string => p.replace(/[\\/]+$/, '').replace(/[\\/][^\\/]*$/, '')
const baseOf = (p: string): string => p.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? p

export async function testGitDiffChaosConvergence(ctx: AutotestContext): Promise<TestResult[]> {
  const { log, assert, cancelled, sleep, waitFor, terminalId } = ctx
  const results: TestResult[] = []
  const record = (name: string, ok: boolean, detail?: Record<string, unknown>) => {
    assert(name, ok, detail)
    results.push({ name, ok, detail })
  }

  log('git-diff-chaos:start', { terminalId })

  // ── Manifest + handshake plumbing ─────────────────────────────────────────
  const extraPath = window.electronAPI.debug.autotestFixtureExtra
  let manifest: ChaosManifest | null = null
  if (extraPath) {
    const raw = await window.electronAPI.project.readFile(dirOf(extraPath), baseOf(extraPath))
    if (raw.success && typeof raw.content === 'string') {
      try {
        manifest = JSON.parse(raw.content) as ChaosManifest
      } catch {
        manifest = null
      }
    }
  }
  if (!manifest) {
    record('CHAOS-00-fixture-and-handshake', false, { extraPath })
    return results
  }
  const repo = manifest.repoRoot
  const stateDir = manifest.stateDir

  const readJson = async <T>(rel: string): Promise<T | null> => {
    const raw = await window.electronAPI.project.readFile(stateDir, rel)
    if (!raw.success || typeof raw.content !== 'string') return null
    try {
      return JSON.parse(raw.content) as T
    } catch {
      return null // torn read between the writer's write+rename; caller re-polls
    }
  }
  const readState = () => readJson<ChaosState>('state.json')
  const readTruth = (cycle: number) => readJson<ChaosTruth>(`truth-${cycle}.json`)
  const writeAck = async (cycle: number, payload: Record<string, unknown> = {}) => {
    await window.electronAPI.debug.writeExternalFile({
      root: stateDir,
      relPath: `ack-${cycle}.json`,
      content: JSON.stringify({ cycle, at: Date.now(), ...payload })
    })
  }

  // ── UI drivers (the "user") ───────────────────────────────────────────────
  const diffApi = () => window.__onwardGitDiffDebug
  const openDiff = async (label: string): Promise<boolean> => {
    if (diffApi()?.isOpen()) return true
    window.dispatchEvent(new CustomEvent('git-diff:open', { detail: { terminalId } }))
    return waitFor(label, () => Boolean(diffApi()?.isOpen()), 10_000)
  }
  const closeDiff = async (label: string): Promise<boolean> => {
    if (!diffApi()?.isOpen()) return true
    window.dispatchEvent(new CustomEvent('git-diff:close', { detail: { terminalId } }))
    return waitFor(label, () => !diffApi()?.isOpen(), 5_000)
  }

  // ── Warmup: first open, measured for the EDR-adaptive SLO ────────────────
  const warmupStartedAt = performance.now()
  const opened = await openDiff('CHAOS-warmup-open')
  await sleep(400) // let the (empty) baseline list apply
  const measuredOpenMs = performance.now() - warmupStartedAt
  const convergenceSloMs = Math.min(
    CHAOS_CONVERGENCE_SLO_CAP_MS,
    Math.max(CHAOS_CONVERGENCE_SLO_BASE_MS, Math.round(measuredOpenMs * 4))
  )

  // Release the writer (handshake 0) and confirm it enters cycle 1.
  await writeAck(0, { measuredOpenMs: Math.round(measuredOpenMs), convergenceSloMs })
  let state: ChaosState | null = null
  const sawFirstBurst = await waitFor('CHAOS-00-writer-entered-burst', () => {
    void readState().then((s) => { state = s })
    return state !== null && (state as ChaosState).phase !== 'waiting'
  }, 30_000, 250)
  const totalCycles = state ? ((state as ChaosState).cycles ?? 3) : 3
  record('CHAOS-00-fixture-and-handshake', Boolean(opened && sawFirstBurst && state), {
    repo,
    stateDir,
    measuredOpenMs: Math.round(measuredOpenMs),
    convergenceSloMs,
    totalCycles,
    state
  })
  if (!opened || !sawFirstBurst) return results

  const userRng = createChaosPrng(CHAOS_USER_SEED)

  // One random user action; mirrors the real rhythm: look at the list, click a
  // file, sometimes back out to the terminal and return.
  const doUserAction = async (): Promise<void> => {
    const api = diffApi()
    const roll = userRng()
    if (!api?.isOpen()) {
      await openDiff('chaos-user-reopen')
      return
    }
    if (roll < 0.15) {
      await closeDiff('chaos-user-close')
      await sleep(300 + Math.floor(userRng() * 900))
      await openDiff('chaos-user-return')
      return
    }
    const files = api.getFileList()
    if (files.length > 0) {
      const target = files[pickIndex(userRng, files.length)]
      api.selectFileByPath(target.filename)
    }
    await sleep(250 + Math.floor(userRng() * 1000))
  }

  // ── Convergence oracle ────────────────────────────────────────────────────
  interface ConvergenceOutcome {
    converged: boolean
    elapsedMs: number
    listVerdict: ReturnType<typeof compareListToTruth>
    bodyFailures: Array<{ path: string; reason: string }>
    polls: number
  }
  const awaitConvergence = async (truth: ChaosTruth, sloMs: number): Promise<ConvergenceOutcome> => {
    const startedAt = performance.now()
    let polls = 0
    let lastList = compareListToTruth([], truth.entries)
    let lastBodyFailures: Array<{ path: string; reason: string }> = []
    await openDiff('chaos-converge-ensure-open')
    while (performance.now() - startedAt < sloMs) {
      polls += 1
      const api = diffApi()
      const files = api?.getFileList() ?? []
      lastList = compareListToTruth(files, truth.entries)
      if (lastList.match) {
        // List settled — spot-check displayed bodies via real user clicks.
        const candidates = bodyCheckCandidates(truth.entries).slice(0, CHAOS_BODY_SAMPLE_MAX)
        const failures: Array<{ path: string; reason: string }> = []
        for (const candidate of candidates) {
          const selected = api?.selectFileByPath(candidate.path)
          if (!selected) {
            failures.push({ path: candidate.path, reason: 'select-failed' })
            continue
          }
          await waitFor(`chaos-body-load-${candidate.path}`, () => {
            const snap = diffApi()?.getSelectedFileContent?.()
            return Boolean(snap && !snap.loading)
          }, 4_000, 100)
          const snap = diffApi()?.getSelectedFileContent?.()
          const verdict = compareBody(snap && !snap.loading ? (snap.modifiedContent ?? null) : null, candidate)
          if (!verdict.match) failures.push({ path: candidate.path, reason: verdict.reason ?? 'mismatch' })
        }
        lastBodyFailures = failures
        if (failures.length === 0) {
          return {
            converged: true,
            elapsedMs: Math.round(performance.now() - startedAt),
            listVerdict: lastList,
            bodyFailures: [],
            polls
          }
        }
      }
      await sleep(300)
    }
    return {
      converged: false,
      elapsedMs: Math.round(performance.now() - startedAt),
      listVerdict: lastList,
      bodyFailures: lastBodyFailures,
      polls
    }
  }

  // ── Cycle loop ────────────────────────────────────────────────────────────
  for (let cycle = 1; cycle <= totalCycles && !cancelled(); cycle += 1) {
    // Burst phase: keep acting like a user until the writer QUIESCES THIS
    // cycle. At loop entry the state file may still show the PREVIOUS cycle's
    // 'quiesced' (the writer flips to 'burst' only after consuming our ack) —
    // treating that residue as "burst over" skipped cycles 2+ entirely in the
    // first harness run, so the exit condition is "reached quiesced-for-this-
    // cycle (or later) / done / error", never merely "not bursting".
    const burstStartedAt = performance.now()
    let current: ChaosState | null = null
    while (!cancelled()) {
      current = await readState()
      if (current) {
        if (current.phase === 'error' || current.phase === 'done') break
        if (current.phase === 'quiesced' && current.cycle >= cycle) break
      }
      if (performance.now() - burstStartedAt > 120_000) break // stuck-writer fence
      await doUserAction()
    }
    if (!current || current.phase === 'error') {
      record(`CHAOS-0${cycle}-converges-after-quiesce`, false, { reason: 'writer-error-or-lost', state: current })
      break
    }
    if (current.phase === 'done') break

    const truth = await readTruth(cycle)
    if (!truth) {
      record(`CHAOS-0${cycle}-converges-after-quiesce`, false, { reason: 'truth-missing', cycle })
      await writeAck(cycle, { converged: false, reason: 'truth-missing' })
      continue
    }
    const outcome = await awaitConvergence(truth, convergenceSloMs)
    record(`CHAOS-0${cycle}-converges-after-quiesce`, outcome.converged, {
      cycle,
      seed: truth.seed,
      convergenceSloMs,
      elapsedMs: outcome.elapsedMs,
      polls: outcome.polls,
      truthEntryCount: truth.entries.length,
      missing: outcome.listVerdict.missing.slice(0, 10),
      extra: outcome.listVerdict.extra.slice(0, 10),
      bodyFailures: outcome.bodyFailures.slice(0, 5),
      note: 'UI must equal on-disk truth (file set + bodies) without manual refresh'
    })
    await writeAck(cycle, { converged: outcome.converged, elapsedMs: outcome.elapsedMs })
  }

  // ── Oracle sanity: after a GROUND-TRUTH refresh the UI must equal truth ──
  // If this fails, the ORACLE or harness is broken (refresh is the app's
  // authoritative recompute), so cycle failures above would be untrustworthy.
  if (!cancelled()) {
    const finalState = await readState()
    const finalCycle = finalState?.cycle ?? totalCycles
    const truth = await readTruth(finalCycle)
    if (truth) {
      try {
        await window.electronAPI.git.forceRefresh?.(repo)
      } catch {
        // forceRefresh absence falls through to the convergence poll below.
      }
      const outcome = await awaitConvergence(truth, convergenceSloMs)
      record('CHAOS-99-oracle-sanity-after-refresh', outcome.converged, {
        finalCycle,
        elapsedMs: outcome.elapsedMs,
        missing: outcome.listVerdict.missing.slice(0, 10),
        extra: outcome.listVerdict.extra.slice(0, 10),
        bodyFailures: outcome.bodyFailures.slice(0, 5)
      })
    } else {
      record('CHAOS-99-oracle-sanity-after-refresh', false, { reason: 'final-truth-missing', finalCycle })
    }
  }

  await closeDiff('chaos-final-close')
  log('git-diff-chaos:done', {
    total: results.length,
    passed: results.filter((r) => r.ok).length,
    failed: results.filter((r) => !r.ok).length
  })
  return results
}
