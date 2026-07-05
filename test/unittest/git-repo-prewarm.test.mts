/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 *
 * Usage: node --experimental-strip-types --test test/unittest/git-repo-prewarm.test.mts
 *
 * Locks the RepoPrewarmCoordinator orchestration + dual dedup (prewarm-on-cwd-
 * switch, decisions ⑥/⑦):
 *   - Diff: warmed once per cwd (attach only).
 *   - History: warmed once per cwd::branchOid (attach + branchOid change), so a
 *     new commit re-warms while a working-tree edit (same branchOid) is a no-op.
 * A failing warm must never throw back into the bridge's emit path.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { RepoPrewarmCoordinator } from '../../electron/main/git-repo-prewarm.ts'
import { PERF_TRACE_EVENT } from '../../src/utils/perf-trace-names.ts'

interface RecordedTrace { event: string; payload: Record<string, unknown> }

interface FakeTimer { fn: () => void; ms: number; cleared: boolean }

function makeCoordinator(overrides: Record<string, unknown> = {}) {
  const calls = {
    warm: [] as string[],
    kick: [] as string[],
    cancel: [] as string[],
    history: [] as Array<{ cwd: string; repoRoot: string | null; branchOid: string }>,
    trace: [] as RecordedTrace[]
  }
  // Manual grace-timer harness: scheduled callbacks are captured so a test can
  // fire them deterministically (simulating the grace window elapsing) or assert
  // they were cleared (a return within grace aborts the cancel).
  const timers: FakeTimer[] = []
  const fireTimers = () => {
    for (const tmr of timers) {
      if (!tmr.cleared) { tmr.cleared = true; tmr.fn() }
    }
  }
  const deps = {
    warmDiffList: async (cwd: string) => { calls.warm.push(cwd); return { success: true } },
    kickContentPrecompute: (project: string) => { calls.kick.push(project) },
    cancelContentPrecompute: (project: string) => { calls.cancel.push(project) },
    prewarmHistory: async (cwd: string, repoRoot: string | null, branchOid: string) => {
      calls.history.push({ cwd, repoRoot, branchOid })
    },
    trace: (event: string, payload: Record<string, unknown>) => { calls.trace.push({ event, payload }) },
    setGraceTimer: (fn: () => void, ms: number) => { const h: FakeTimer = { fn, ms, cleared: false }; timers.push(h); return h },
    clearGraceTimer: (h: unknown) => { (h as FakeTimer).cleared = true },
    ...overrides
  }
  const coordinator = new RepoPrewarmCoordinator(deps as never)
  return { coordinator, calls, timers, fireTimers }
}

// ---------------------------------------------------------------------------
// Diff prewarm (dedup by cwd)
// ---------------------------------------------------------------------------

test('first prewarm of a cwd warms the diff list, kicks the content burst, traces triggered', async () => {
  const { coordinator, calls } = makeCoordinator()
  await coordinator.prewarm({ cwd: '/repo', repoRoot: '/repo', branchOid: 'oid1', reason: 'attach' })
  assert.deepEqual(calls.warm, ['/repo'])
  assert.deepEqual(calls.kick, ['/repo'])
  const triggered = calls.trace.filter((t) => t.event === PERF_TRACE_EVENT.MAIN_GIT_PREWARM_REPO_TRIGGERED)
  assert.equal(triggered.length, 1)
  assert.equal(triggered[0].payload.reason, 'attach')
  assert.equal(coordinator.hasPrewarmed('/repo'), true)
})

test('re-prewarming the same cwd is deduped: no diff warm, no kick, traces skipped-dedup', async () => {
  const { coordinator, calls } = makeCoordinator()
  await coordinator.prewarm({ cwd: '/repo', repoRoot: '/repo', branchOid: 'oid1', reason: 'attach' })
  await coordinator.prewarm({ cwd: '/repo', repoRoot: '/repo', branchOid: 'oid1', reason: 'cwd-change' })
  assert.deepEqual(calls.warm, ['/repo'], 'second attach must NOT re-warm the diff')
  assert.deepEqual(calls.kick, ['/repo'], 'second attach must NOT re-kick content')
  const skipped = calls.trace.filter((t) => t.event === PERF_TRACE_EVENT.MAIN_GIT_PREWARM_REPO_SKIPPED_DEDUP)
  assert.equal(skipped.length, 1)
  assert.equal(skipped[0].payload.reason, 'cwd-change')
})

test('a failed diff-list warm does NOT kick the content burst', async () => {
  const { coordinator, calls } = makeCoordinator({
    warmDiffList: async (cwd: string) => { void cwd; return { success: false } }
  })
  await coordinator.prewarm({ cwd: '/repo', repoRoot: null, branchOid: 'oid1', reason: 'attach' })
  assert.deepEqual(calls.kick, [], 'no content burst when the list warm reported failure')
})

test('a THROWN diff-list warm is swallowed (never rejects into the emit path) and skips the kick', async () => {
  const { coordinator, calls } = makeCoordinator({
    warmDiffList: async () => { throw new Error('worker exploded') }
  })
  await assert.doesNotReject(coordinator.prewarm({ cwd: '/repo', repoRoot: null, branchOid: 'oid1', reason: 'attach' }))
  assert.deepEqual(calls.kick, [])
})

test('distinct cwds each warm the diff exactly once', async () => {
  const { coordinator, calls } = makeCoordinator()
  await coordinator.prewarm({ cwd: '/a', repoRoot: '/a', branchOid: 'x', reason: 'attach' })
  await coordinator.prewarm({ cwd: '/b', repoRoot: '/b', branchOid: 'y', reason: 'attach' })
  await coordinator.prewarm({ cwd: '/a', repoRoot: '/a', branchOid: 'x', reason: 'attach' }) // dedup
  assert.deepEqual(calls.warm, ['/a', '/b'])
})

test('an empty cwd is a no-op (no warm, no trace)', async () => {
  const { coordinator, calls } = makeCoordinator()
  await coordinator.prewarm({ cwd: '', repoRoot: null, branchOid: 'oid1', reason: 'attach' })
  assert.deepEqual(calls.warm, [])
  assert.deepEqual(calls.trace, [])
})

// ---------------------------------------------------------------------------
// History prewarm (dedup by cwd::branchOid)
// ---------------------------------------------------------------------------

test('attach prewarm also warms History with (cwd, repoRoot, branchOid)', async () => {
  const { coordinator, calls } = makeCoordinator()
  await coordinator.prewarm({ cwd: '/repo', repoRoot: '/repo/root', branchOid: 'oid1', reason: 'attach' })
  assert.deepEqual(calls.history, [{ cwd: '/repo', repoRoot: '/repo/root', branchOid: 'oid1' }])
})

test('History is skipped when branchOid is absent (cold attach, mirror not computed yet)', async () => {
  const { coordinator, calls } = makeCoordinator()
  await coordinator.prewarm({ cwd: '/repo', repoRoot: '/repo', reason: 'attach' })
  assert.deepEqual(calls.history, [], 'no History warm without a branchOid key')
})

test('History is deduped by cwd::branchOid: same branchOid warms once, a new branchOid re-warms', async () => {
  const { coordinator, calls } = makeCoordinator()
  // attach + two mirror-updates at the same HEAD → one History warm.
  await coordinator.prewarm({ cwd: '/repo', repoRoot: '/repo', branchOid: 'oid1', reason: 'attach' })
  await coordinator.prewarmHistory({ cwd: '/repo', repoRoot: '/repo', branchOid: 'oid1', reason: 'branch-change' })
  assert.equal(calls.history.length, 1, 'same branchOid must not re-warm History')
  // a new commit moves branchOid → History re-warms (but diff does NOT).
  await coordinator.prewarmHistory({ cwd: '/repo', repoRoot: '/repo', branchOid: 'oid2', reason: 'branch-change' })
  assert.equal(calls.history.length, 2, 'a new branchOid re-warms History')
  assert.deepEqual(calls.warm, ['/repo'], 'a branchOid change must NOT re-warm the diff list')
  assert.equal(coordinator.hasPrewarmedHistory('/repo', 'oid2'), true)
})

test('prewarmHistory() alone never warms the diff list (history-only path)', async () => {
  const { coordinator, calls } = makeCoordinator()
  await coordinator.prewarmHistory({ cwd: '/repo', repoRoot: '/repo', branchOid: 'oid1', reason: 'branch-change' })
  assert.deepEqual(calls.warm, [], 'prewarmHistory must not touch the diff lane')
  assert.deepEqual(calls.history, [{ cwd: '/repo', repoRoot: '/repo', branchOid: 'oid1' }])
})

test('a THROWN prewarmHistory is swallowed and does not abort the prewarm', async () => {
  const { coordinator, calls } = makeCoordinator({
    prewarmHistory: async () => { throw new Error('history blew up') }
  })
  await assert.doesNotReject(coordinator.prewarm({ cwd: '/repo', repoRoot: null, branchOid: 'oid1', reason: 'attach' }))
  // The diff half still ran before the history half threw.
  assert.deepEqual(calls.warm, ['/repo'])
  assert.deepEqual(calls.kick, ['/repo'])
})

test('attachDelayMs sets the dedup mark synchronously, so a concurrent attach during the delay window is deduped (no double-warm)', async () => {
  // Yield-to-foreground: the warm waits `attachDelayMs` before running, but the
  // dedup mark must be set BEFORE the delay so a second attach that lands during
  // the delay window collapses into one warm (not two racing warms).
  const { coordinator, calls } = makeCoordinator({ attachDelayMs: 40 })
  const p1 = coordinator.prewarm({ cwd: '/repo', repoRoot: '/repo', branchOid: 'o', reason: 'attach' })
  assert.equal(coordinator.hasPrewarmed('/repo'), true, 'dedup mark set synchronously, before the delay resolves')
  const p2 = coordinator.prewarm({ cwd: '/repo', repoRoot: '/repo', branchOid: 'o', reason: 'cwd-change' })
  await Promise.all([p1, p2])
  assert.deepEqual(calls.warm, ['/repo'], 'a second attach during the delay window must not double-warm')
})

test('reset() clears BOTH diff and history dedup state so a cwd re-warms', async () => {
  const { coordinator, calls } = makeCoordinator()
  await coordinator.prewarm({ cwd: '/repo', repoRoot: '/repo', branchOid: 'oid1', reason: 'attach' })
  coordinator.reset()
  assert.equal(coordinator.hasPrewarmed('/repo'), false)
  assert.equal(coordinator.hasPrewarmedHistory('/repo', 'oid1'), false)
  await coordinator.prewarm({ cwd: '/repo', repoRoot: '/repo', branchOid: 'oid1', reason: 'attach' })
  assert.deepEqual(calls.warm, ['/repo', '/repo'], 'reset allows a fresh diff warm')
  assert.equal(calls.history.length, 2, 'reset allows a fresh History warm')
})

// ---------------------------------------------------------------------------
// Abandoned-cwd grace cancel (Strategy B): a cwd left with no live terminal has
// its background precompute cancelled after a grace window; a quick return
// within the window aborts the cancel (no A→B→A thrash).
// ---------------------------------------------------------------------------

test('onCwdDetached schedules a grace-windowed cancel (not immediate) when detachGraceMs > 0', async () => {
  const { coordinator, calls } = makeCoordinator({ detachGraceMs: 2500 })
  await coordinator.prewarm({ cwd: '/repo', repoRoot: '/repo', branchOid: 'o', reason: 'attach' })
  coordinator.onCwdDetached('/repo')
  assert.equal(coordinator.hasPendingDetach('/repo'), true, 'a grace cancel is pending')
  assert.deepEqual(calls.cancel, [], 'cancel has NOT fired yet (still inside the grace window)')
})

test('grace window elapsing cancels the burst, drops the diff dedup, and traces detach-cancelled', async () => {
  const { coordinator, calls, fireTimers } = makeCoordinator({ detachGraceMs: 2500 })
  await coordinator.prewarm({ cwd: '/repo', repoRoot: '/repo', branchOid: 'o', reason: 'attach' })
  coordinator.onCwdDetached('/repo')
  fireTimers() // grace window elapses, user did NOT return
  assert.deepEqual(calls.cancel, ['/repo'], 'burst precompute cancelled')
  assert.equal(coordinator.hasPrewarmed('/repo'), false, 'diff dedup dropped so a later return re-warms')
  assert.equal(coordinator.hasPendingDetach('/repo'), false)
  const cancelled = calls.trace.filter((t) => t.event === PERF_TRACE_EVENT.MAIN_GIT_PREWARM_DETACH_CANCELLED)
  assert.equal(cancelled.length, 1)
  assert.equal(cancelled[0].payload.cwd, '/repo')
})

test('returning to the cwd within the grace window ABORTS the cancel (no thrash, warm preserved)', async () => {
  const { coordinator, calls, fireTimers } = makeCoordinator({ detachGraceMs: 2500 })
  await coordinator.prewarm({ cwd: '/repo', repoRoot: '/repo', branchOid: 'o', reason: 'attach' })
  coordinator.onCwdDetached('/repo')
  // User cd's back to /repo before the grace timer fires.
  await coordinator.prewarm({ cwd: '/repo', repoRoot: '/repo', branchOid: 'o', reason: 'cwd-change' })
  assert.equal(coordinator.hasPendingDetach('/repo'), false, 'the pending cancel was aborted on return')
  fireTimers() // even if a stale timer existed, it was cleared
  assert.deepEqual(calls.cancel, [], 'NEVER cancelled — the warm is preserved')
  assert.equal(coordinator.hasPrewarmed('/repo'), true, 'diff dedup still held (no re-warm, no discard)')
})

test('A→B→A: leaving A schedules a cancel; landing on B does not touch A; returning to A aborts A’s cancel', async () => {
  const { coordinator, calls, fireTimers } = makeCoordinator({ detachGraceMs: 2500 })
  await coordinator.prewarm({ cwd: '/A', repoRoot: '/A', branchOid: 'a', reason: 'attach' })
  coordinator.onCwdDetached('/A')              // left A
  await coordinator.prewarm({ cwd: '/B', repoRoot: '/B', branchOid: 'b', reason: 'cwd-change' }) // landed on B
  assert.equal(coordinator.hasPendingDetach('/A'), true, 'A still pending cancel')
  assert.equal(coordinator.hasPendingDetach('/B'), false, 'B has no pending cancel')
  coordinator.onCwdDetached('/B')              // left B
  await coordinator.prewarm({ cwd: '/A', repoRoot: '/A', branchOid: 'a', reason: 'cwd-change' }) // back to A
  fireTimers()
  assert.deepEqual(calls.cancel, ['/B'], 'only B (truly abandoned) is cancelled; A was rescued by the return')
})

test('detachGraceMs default 0 cancels immediately (no grace) — preserves the simple path', () => {
  const { coordinator, calls } = makeCoordinator() // no detachGraceMs => 0
  // Mark a cwd warmed first (otherwise hasPrewarmed delete is a no-op).
  void coordinator.prewarm({ cwd: '/repo', repoRoot: '/repo', branchOid: 'o', reason: 'attach' })
  coordinator.onCwdDetached('/repo')
  assert.deepEqual(calls.cancel, ['/repo'], 'grace=0 cancels synchronously')
  assert.equal(coordinator.hasPendingDetach('/repo'), false)
})

test('a duplicate onCwdDetached for an already-pending cwd is a no-op (one timer)', () => {
  const { coordinator, timers } = makeCoordinator({ detachGraceMs: 2500 })
  void coordinator.prewarm({ cwd: '/repo', repoRoot: '/repo', branchOid: 'o', reason: 'attach' })
  coordinator.onCwdDetached('/repo')
  coordinator.onCwdDetached('/repo')
  assert.equal(timers.length, 1, 'second detach must not schedule a second timer')
})

test('reset() clears pending grace timers so none fire after teardown', () => {
  const { coordinator, calls, fireTimers } = makeCoordinator({ detachGraceMs: 2500 })
  void coordinator.prewarm({ cwd: '/repo', repoRoot: '/repo', branchOid: 'o', reason: 'attach' })
  coordinator.onCwdDetached('/repo')
  coordinator.reset()
  assert.equal(coordinator.hasPendingDetach('/repo'), false)
  fireTimers()
  assert.deepEqual(calls.cancel, [], 'a cleared grace timer must not fire a cancel after reset')
})

// ---------------------------------------------------------------------------
// G1 (2026-07-04 spinner analysis): re-warm after invalidation + dedup fixes
// ---------------------------------------------------------------------------

test('REPRO→FIX: a failed warm no longer poisons the dedup for the session', async () => {
  let succeed = false
  const { coordinator, calls } = makeCoordinator({
    warmDiffList: async (cwd: string) => { calls.warm.push(cwd); return { success: succeed } }
  })
  await coordinator.prewarm({ cwd: '/repo', repoRoot: '/repo', reason: 'attach' })
  assert.equal(coordinator.hasPrewarmed('/repo'), false, 'failed warm must drop the dedup member')
  succeed = true
  await coordinator.prewarm({ cwd: '/repo', repoRoot: '/repo', reason: 'attach' })
  assert.deepEqual(calls.warm, ['/repo', '/repo'], 'second attach must retry after a failed warm')
  assert.equal(coordinator.hasPrewarmed('/repo'), true)
})

test('warm forwards the opaque mirror-status payload (G2 C-i pass-through)', async () => {
  const payloads: unknown[] = []
  const { coordinator } = makeCoordinator({
    warmDiffList: async (_cwd: string, statusPayload?: unknown) => { payloads.push(statusPayload); return { success: true } },
    getWarmStatusPayload: (cwd: string) => ({ files: [], capturedAt: 123, cwd })
  })
  await coordinator.prewarm({ cwd: '/repo', repoRoot: '/repo', reason: 'attach' })
  assert.equal(payloads.length, 1)
  assert.deepEqual(payloads[0], { files: [], capturedAt: 123, cwd: '/repo' })
})

test('onCwdInvalidated schedules a quiet-window re-warm that re-runs the warm with reason=rewarm', async () => {
  const { coordinator, calls, fireTimers } = makeCoordinator({
    hasLiveSubscriber: () => true
  })
  await coordinator.prewarm({ cwd: '/repo', repoRoot: '/repo', reason: 'attach' })
  assert.deepEqual(calls.warm, ['/repo'])

  coordinator.onCwdInvalidated('/repo', 'mirror')
  const scheduled = calls.trace.filter((t) => t.event === PERF_TRACE_EVENT.MAIN_GIT_PREWARM_REWARM_SCHEDULED)
  assert.equal(scheduled.length, 1)
  assert.equal(coordinator.hasPrewarmed('/repo'), true, 'dedup member survives until the re-warm fires')

  fireTimers()
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.deepEqual(calls.warm, ['/repo', '/repo'], 'quiet-window fire must re-run the warm')
  const run = calls.trace.filter((t) => t.event === PERF_TRACE_EVENT.MAIN_GIT_PREWARM_REWARM_RUN)
  assert.equal(run.length, 1)
  assert.equal(run[0].payload.trigger, 'quiet-window')
  const rewarmTriggered = calls.trace.filter((t) =>
    t.event === PERF_TRACE_EVENT.MAIN_GIT_PREWARM_REPO_TRIGGERED && t.payload.reason === 'rewarm')
  assert.equal(rewarmTriggered.length, 1)
  assert.equal(coordinator.hasPrewarmed('/repo'), true, 'the re-warm restores the dedup member')
})

test('repeated invalidations restart the quiet window (previous timer cleared)', async () => {
  const { coordinator, calls, timers } = makeCoordinator({ hasLiveSubscriber: () => true })
  await coordinator.prewarm({ cwd: '/repo', repoRoot: '/repo', reason: 'attach' })
  coordinator.onCwdInvalidated('/repo', 'mirror')
  coordinator.onCwdInvalidated('/repo', 'mirror')
  assert.equal(timers.length, 2, 'each invalidation schedules a fresh timer')
  assert.equal(timers[0].cleared, true, 'the earlier quiet-window timer must be cleared')
  assert.equal(timers[1].cleared, false)
  assert.equal(calls.warm.length, 1, 'no warm until the quiet window elapses')
})

test('continuous churn past rewarmMaxWaitMs fires the re-warm immediately (max-wait trigger)', async () => {
  const { coordinator, calls } = makeCoordinator({
    hasLiveSubscriber: () => true,
    rewarmMaxWaitMs: 1
  })
  await coordinator.prewarm({ cwd: '/repo', repoRoot: '/repo', reason: 'attach' })
  coordinator.onCwdInvalidated('/repo', 'mirror')
  await new Promise((resolve) => setTimeout(resolve, 5))
  coordinator.onCwdInvalidated('/repo', 'mirror')
  await new Promise((resolve) => setTimeout(resolve, 0))
  const run = calls.trace.filter((t) => t.event === PERF_TRACE_EVENT.MAIN_GIT_PREWARM_REWARM_RUN)
  assert.equal(run.length, 1)
  assert.equal(run[0].payload.trigger, 'max-wait')
  assert.deepEqual(calls.warm, ['/repo', '/repo'])
})

test('invalidations for a cwd with no live subscriber are skipped (no timer, traced)', async () => {
  const { coordinator, calls, timers } = makeCoordinator({ hasLiveSubscriber: () => false })
  await coordinator.prewarm({ cwd: '/repo', repoRoot: '/repo', reason: 'attach' })
  coordinator.onCwdInvalidated('/repo', 'mirror')
  assert.equal(timers.length, 0)
  const skipped = calls.trace.filter((t) => t.event === PERF_TRACE_EVENT.MAIN_GIT_PREWARM_REWARM_SKIPPED)
  assert.equal(skipped.length, 1)
  assert.equal(skipped[0].payload.reason, 'no-live-subscriber')
})

test('non-churn invalidation reasons (force/manual/lru) never schedule a re-warm', async () => {
  const { coordinator, timers } = makeCoordinator({ hasLiveSubscriber: () => true })
  await coordinator.prewarm({ cwd: '/repo', repoRoot: '/repo', reason: 'attach' })
  coordinator.onCwdInvalidated('/repo', 'force')
  coordinator.onCwdInvalidated('/repo', 'manual')
  coordinator.onCwdInvalidated('/repo', 'lru')
  assert.equal(timers.length, 0)
})

test('detach cancels a pending re-warm (abandoned repos never re-warm)', async () => {
  const { coordinator, calls, fireTimers } = makeCoordinator({ hasLiveSubscriber: () => true })
  await coordinator.prewarm({ cwd: '/repo', repoRoot: '/repo', reason: 'attach' })
  coordinator.onCwdInvalidated('/repo', 'mirror')
  // detachGraceMs defaults to 0 → the cancel runs synchronously and must
  // clear the pending re-warm timer alongside the content burst.
  coordinator.onCwdDetached('/repo')
  fireTimers()
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.equal(calls.warm.length, 1, 'no re-warm may fire after detach')
})

test('resetDiffDedup (worker respawn) clears the dedup so live cwds re-warm', async () => {
  const { coordinator, calls } = makeCoordinator()
  await coordinator.prewarm({ cwd: '/repo', repoRoot: '/repo', reason: 'attach' })
  coordinator.resetDiffDedup('worker-respawn')
  assert.equal(coordinator.hasPrewarmed('/repo'), false)
  const reset = calls.trace.filter((t) => t.event === PERF_TRACE_EVENT.MAIN_GIT_PREWARM_DEDUP_RESET_WORKER_RESPAWN)
  assert.equal(reset.length, 1)
  await coordinator.prewarm({ cwd: '/repo', repoRoot: '/repo', reason: 'worker-respawn' })
  assert.deepEqual(calls.warm, ['/repo', '/repo'])
})
