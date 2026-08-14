/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Memory diagnostics closed-loop autotest (MW-*). Drives the real chain:
 * Tier-1 sampling flows (main + renderer self-report) → synthetic
 * over-threshold injection flips the pure detector → memory report written
 * + pressure notification shown → "Open Feedback" opens the modal → heap
 * snapshot opt-in reveals the privacy warning → bundle export attaches
 * real .heapsnapshot sidecars.
 *
 * The runner (test/autotest/run-memory-watch-autotest.sh) provides the
 * environment this suite requires: ONWARD_MEM_WATCH_INTERVAL_SEC=1,
 * ONWARD_MEM_WATCH_MIN_UPTIME_SEC=0, and ONWARD_AUTOTEST_FIXTURE_EXTRA as
 * a writable output dir for the forced bundle path. Explicit-only suite —
 * never part of an 'all' run.
 */

import type { AutotestContext, TestResult } from './types'

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs: number, stepMs = 300): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      if (await predicate()) return true
    } catch {
      // predicate errors count as "not yet"
    }
    await sleep(stepMs)
  }
  return false
}

export async function testMemoryWatch(ctx: AutotestContext): Promise<TestResult[]> {
  const { assert } = ctx
  const results: TestResult[] = []
  const _assert = (name: string, ok: boolean, detail?: Record<string, unknown>) => {
    assert(name, ok, detail)
    results.push({ name, ok, detail })
  }

  const memory = window.electronAPI.memory

  // MW-01: watcher is enabled and configured from env.
  const initialState = await memory.getWatchState()
  _assert('MW-01-watch-enabled', initialState.enabled === true, {
    enabled: initialState.enabled,
    intervalMs: initialState.intervalMs
  })

  // MW-02: Tier-1 flow — main tick pushed at least one ring sample AND the
  // renderer preload self-report (first shot at ~5 s) reached main.
  const samplesFlowing = await waitFor(async () => {
    const s = await memory.getWatchState()
    return (s.sampleCount as number) >= 1 && s.rendererReportAtMs !== null
  }, 25_000, 500)
  _assert('MW-02-main-and-renderer-samples-flow', samplesFlowing, {
    state: await memory.getWatchState()
  })

  // MW-03: synthetic over-threshold injection (4 samples ≥ default warn
  // threshold satisfies minSamplesInWindow=3 with sustain) flips the
  // detector, writes the lightweight memory report, and consumes the one
  // per-session prompt.
  const hugeWorkingSetKb = 4 * 1024 * 1024 // 4 GB — above any configured warn threshold
  for (let i = 0; i < 4; i++) {
    await memory.injectSampleForAutotest({
      workingSetKb: hugeWorkingSetKb,
      heapUsedKb: 3 * 1024 * 1024,
      heapLimitKb: 4 * 1024 * 1024
    })
    await sleep(50)
  }
  const pressureReached = await waitFor(async () => {
    const s = await memory.getWatchState()
    const verdict = s.lastVerdict as { level?: string } | null
    return (
      verdict !== null &&
      (verdict.level === 'warn' || verdict.level === 'critical') &&
      (s.promptedCount as number) >= 1 &&
      s.lastReportPath !== null
    )
  }, 10_000, 250)
  _assert('MW-03-pressure-detected-report-written', pressureReached, {
    state: await memory.getWatchState()
  })

  // MW-04: the non-blocking notification bar appears.
  const notificationShown = await waitFor(
    () => document.querySelector('[data-testid="memory-pressure-notification"]') !== null,
    10_000,
    250
  )
  _assert('MW-04-notification-shown', notificationShown)

  // MW-05: "Open Feedback" routes into the FeedbackModal.
  const openButton = document.querySelector<HTMLButtonElement>('[data-testid="memory-pressure-open-feedback"]')
  openButton?.click()
  const modalOpen = await waitFor(
    () => document.querySelector('[data-testid="feedback-diagnostic-bundle-button"]') !== null,
    10_000,
    250
  )
  _assert('MW-05-open-feedback-from-notification', modalOpen)

  // MW-06: notification is gone once acted on.
  _assert(
    'MW-06-notification-cleared-after-action',
    document.querySelector('[data-testid="memory-pressure-notification"]') === null
  )

  // MW-07: heap-snapshot opt-in reveals the plain-language privacy warning.
  const checkbox = document.querySelector<HTMLInputElement>('[data-testid="feedback-include-heap-checkbox"]')
  let warningVisible = false
  if (checkbox) {
    checkbox.click()
    warningVisible = await waitFor(
      () => document.querySelector('[data-testid="feedback-heap-privacy-warning"]') !== null,
      5_000,
      200
    )
  }
  _assert('MW-07-heap-optin-shows-privacy-warning', checkbox !== null && warningVisible)

  // MW-08/09: bundle export with consented snapshot capture. Forced output
  // path (honoured only under ONWARD_AUTOTEST=1) goes to the runner-owned
  // scratch dir so nothing lands in the repo root.
  const outDir = window.electronAPI.debug.autotestFixtureExtra ?? window.electronAPI.debug.autotestCwd ?? '/tmp'
  const forcedPath = `${outDir}/onward-diag-memory-watch-${Date.now()}.zip`
  type BundleResult = {
    success?: boolean
    path?: string
    error?: string
    heapSnapshots?: Array<{ target: string; path: string; bytes: number }>
    heapSnapshotSkipped?: string[]
  }
  let bundleResult: BundleResult
  try {
    bundleResult = (await window.electronAPI.feedback.exportDiagnosticBundle(forcedPath, undefined, {
      includeHeapSnapshot: true
    })) as BundleResult
  } catch (error) {
    bundleResult = { success: false, error: String(error) }
  }
  _assert('MW-08-bundle-export-success', bundleResult.success === true && typeof bundleResult.path === 'string', {
    path: bundleResult.path ?? null,
    error: bundleResult.error ?? null
  })

  const snapshots = bundleResult.heapSnapshots ?? []
  // A real V8 heap snapshot of even a near-empty isolate serializes to
  // megabytes; 1 MB floor distinguishes a genuine capture from a truncated
  // or 0-byte file (the documented near-heap-limit failure mode).
  const snapshotsValid = snapshots.length >= 1 && snapshots.every((s) => s.bytes > 1_000_000)
  _assert('MW-09-heap-snapshot-sidecars-attached', snapshotsValid, {
    snapshots: snapshots.map((s) => ({ target: s.target, bytes: s.bytes })),
    skipped: bundleResult.heapSnapshotSkipped ?? []
  })

  return results
}
