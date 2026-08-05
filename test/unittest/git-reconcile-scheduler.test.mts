/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 *
 * Usage: node --experimental-strip-types --test test/unittest/git-reconcile-scheduler.test.mts
 *
 * Pins the pure decision table of the git-status reconcile scheduler — the
 * always-on dirty -> reconcile safety net that runs parallel to the watcher.
 * Locks the product spec: focused task reconciles every 1 s, visible-unfocused
 * every 3 s, hidden never on heartbeat (only on explicit dirty), repo-keyed
 * dedup with fastest-cadence-wins aggregation, and dirty marks (watcher /
 * tab-switch / activate) fire immediately regardless of cadence.
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import {
  GitReconcileScheduler,
  RECONCILE_FOCUSED_INTERVAL_MS,
  RECONCILE_VISIBLE_INTERVAL_MS,
  RECONCILE_BACKOFF_FACTOR,
  RECONCILE_MAX_BACKOFF_INTERVAL_MS,
  computeEffectiveIntervalMs,
  MIRROR_DURATION_SANITY_CEILING_MS,
  sanitizeMeasuredDurationMs,
  type DueRepo
} from '../../electron/main/git-reconcile-scheduler.ts'

const REPO_A = '/repo/a'
const REPO_B = '/repo/b'

function dueKeys(due: DueRepo[]): string[] {
  return due.map((d) => d.repoKey).sort()
}

test('focused task reconciles on the 1 s heartbeat, not before', () => {
  const s = new GitReconcileScheduler()
  s.setTaskState('t1', REPO_A, 'focused')

  // Freshly-visible repo is due on the very first tick (lastReconcileAt = -inf).
  let due = s.tick(0)
  assert.deepEqual(dueKeys(due), [REPO_A])
  assert.equal(due[0].reason, 'heartbeat-focused')

  s.onReconcileStart(REPO_A)
  s.onReconcileDone(REPO_A, 0)

  // Not due before 1 s.
  assert.deepEqual(s.tick(999), [])
  // Due at exactly 1 s.
  due = s.tick(1000)
  assert.deepEqual(dueKeys(due), [REPO_A])
  assert.equal(due[0].reason, 'heartbeat-focused')
})

test('visible-unfocused task reconciles on the 3 s heartbeat, not the 1 s', () => {
  const s = new GitReconcileScheduler()
  s.setTaskState('t1', REPO_A, 'visible')
  s.onReconcileStart(REPO_A)
  s.onReconcileDone(REPO_A, 0)

  assert.deepEqual(s.tick(1000), [], 'not due at 1 s for a visible-unfocused repo')
  assert.deepEqual(s.tick(2999), [], 'not due just before 3 s')
  const due = s.tick(3000)
  assert.deepEqual(dueKeys(due), [REPO_A])
  assert.equal(due[0].reason, 'heartbeat-visible')
})

test('hidden task never reconciles on the heartbeat, only on explicit dirty', () => {
  const s = new GitReconcileScheduler()
  s.setTaskState('t1', REPO_A, 'hidden')
  s.onReconcileStart(REPO_A)
  s.onReconcileDone(REPO_A, 0)

  // Even far past both intervals, a hidden repo gets no heartbeat.
  assert.deepEqual(s.tick(10_000), [])

  // tab-switch / activate wakes it immediately.
  s.markDirty(REPO_A, 'tab-visible')
  const due = s.tick(10_050)
  assert.deepEqual(dueKeys(due), [REPO_A])
  assert.equal(due[0].reason, 'tab-visible')
})

test('explicit dirty (watcher / activate) fires immediately regardless of cadence', () => {
  const s = new GitReconcileScheduler()
  s.setTaskState('t1', REPO_A, 'focused')
  s.onReconcileStart(REPO_A)
  s.onReconcileDone(REPO_A, 0)

  // Well within the 1 s window — heartbeat would NOT fire yet.
  assert.deepEqual(s.tick(200), [])

  s.markDirty(REPO_A, 'watcher')
  let due = s.tick(250)
  assert.deepEqual(dueKeys(due), [REPO_A])
  assert.equal(due[0].reason, 'watcher')

  // After start, the dirty mark is consumed (the in-flight reconcile observes it).
  s.onReconcileStart(REPO_A)
  assert.deepEqual(s.tick(260), [], 'in-flight repo is skipped')
  s.onReconcileDone(REPO_A, 260)
  assert.deepEqual(s.tick(300), [], 'dirty consumed; cadence resets from 260')
})

test('a change during an in-flight reconcile re-marks dirty and re-runs next tick', () => {
  const s = new GitReconcileScheduler()
  s.setTaskState('t1', REPO_A, 'visible')

  s.markDirty(REPO_A, 'watcher')
  assert.deepEqual(dueKeys(s.tick(0)), [REPO_A])

  s.onReconcileStart(REPO_A)        // consumes dirty
  s.markDirty(REPO_A, 'watcher')    // a new file event lands mid-reconcile
  s.onReconcileDone(REPO_A, 10)

  // The mid-flight change survives -> due again immediately.
  assert.deepEqual(dueKeys(s.tick(11)), [REPO_A])
})

test('repo-keyed dedup: many tasks at one repo collapse to a single due entry', () => {
  const s = new GitReconcileScheduler()
  s.setTaskState('t1', REPO_A, 'visible')
  s.setTaskState('t2', REPO_A, 'visible')
  s.setTaskState('t3', REPO_A, 'hidden')

  const due = s.tick(0)
  assert.equal(due.length, 1, 'one reconcile per repoRoot, not per task')
  assert.equal(due[0].repoKey, REPO_A)
})

test('repo cadence is the fastest among its tasks (focused beats visible)', () => {
  const s = new GitReconcileScheduler()
  // Same repo: one focused task + one visible task -> repo polls at 1 s.
  s.setTaskState('t1', REPO_A, 'visible')
  s.setTaskState('t2', REPO_A, 'focused')
  s.onReconcileStart(REPO_A)
  s.onReconcileDone(REPO_A, 0)

  const due = s.tick(1000)
  assert.deepEqual(dueKeys(due), [REPO_A])
  assert.equal(due[0].reason, 'heartbeat-focused', 'focused task pulls the repo to the 1 s cadence')
})

test('non-git task (repoKey null) never reconciles', () => {
  const s = new GitReconcileScheduler()
  s.setTaskState('t1', null, 'focused')
  assert.deepEqual(s.tick(0), [])
  assert.deepEqual(s.tick(100_000), [])
  assert.deepEqual(s.inspect().repos, [])
})

test('removing the last task for a repo prunes it; markDirty becomes a no-op', () => {
  const s = new GitReconcileScheduler()
  s.setTaskState('t1', REPO_A, 'focused')
  assert.deepEqual(s.inspect().repos, [REPO_A])

  s.removeTask('t1')
  assert.deepEqual(s.inspect().repos, [])
  s.markDirty(REPO_A, 'watcher') // repo gone -> ignored
  assert.deepEqual(s.tick(5000), [])
})

test('independent repos keep independent cadences and dirty state', () => {
  const s = new GitReconcileScheduler()
  s.setTaskState('t1', REPO_A, 'focused')  // 1 s
  s.setTaskState('t2', REPO_B, 'visible')  // 3 s
  s.onReconcileStart(REPO_A); s.onReconcileDone(REPO_A, 0)
  s.onReconcileStart(REPO_B); s.onReconcileDone(REPO_B, 0)

  // At 1 s: only the focused repo A is due.
  assert.deepEqual(dueKeys(s.tick(1000)), [REPO_A])
  s.onReconcileStart(REPO_A); s.onReconcileDone(REPO_A, 1000)

  // At 3 s: A (focused, >=1 s since 1000) and B (visible, >=3 s since 0) both due.
  assert.deepEqual(dueKeys(s.tick(3000)), [REPO_A, REPO_B])
})

test('a task switching hidden -> focused starts getting the 1 s heartbeat', () => {
  const s = new GitReconcileScheduler()
  s.setTaskState('t1', REPO_A, 'hidden')
  s.onReconcileStart(REPO_A); s.onReconcileDone(REPO_A, 0)
  assert.deepEqual(s.tick(5000), [], 'hidden: no heartbeat')

  // User switches to the tab and focuses the task.
  s.setTaskState('t1', REPO_A, 'focused')
  const due = s.tick(5001)
  assert.deepEqual(dueKeys(due), [REPO_A])
  assert.equal(due[0].reason, 'heartbeat-focused')
})

test('exported interval constants match the product spec (1 s / 3 s)', () => {
  assert.equal(RECONCILE_FOCUSED_INTERVAL_MS, 1000)
  assert.equal(RECONCILE_VISIBLE_INTERVAL_MS, 3000)
})

test('custom intervals are honored', () => {
  const s = new GitReconcileScheduler({ focusedIntervalMs: 500, visibleIntervalMs: 1500 })
  s.setTaskState('t1', REPO_A, 'focused')
  s.onReconcileStart(REPO_A); s.onReconcileDone(REPO_A, 0)
  assert.deepEqual(s.tick(499), [])
  assert.deepEqual(dueKeys(s.tick(500)), [REPO_A])
})

// ---------------------------------------------------------------------------
// Adaptive backoff (EDR-slow-status fix): the effective gap stretches to
// lastDurationMs × factor when status is slow, so the heartbeat can't run
// back-to-back. On a fast host it stays at the base 1 s/3 s (zero regression).
// ---------------------------------------------------------------------------

test('computeEffectiveIntervalMs: base when status is fast, stretched when slow, capped, floored', () => {
  const F = RECONCILE_BACKOFF_FACTOR
  const MAX = RECONCILE_MAX_BACKOFF_INTERVAL_MS
  // No prior status (0 / negative) => base, so the first reconcile is never delayed.
  assert.equal(computeEffectiveIntervalMs(1000, 0, F, MAX), 1000)
  assert.equal(computeEffectiveIntervalMs(1000, -5, F, MAX), 1000)
  // Fast status (50 ms): 50×4=200 < 1000 base => stays at base (NORMAL host, no regression).
  assert.equal(computeEffectiveIntervalMs(1000, 50, F, MAX), 1000)
  // Status at the floor boundary: 250×4=1000 == base.
  assert.equal(computeEffectiveIntervalMs(1000, 250, F, MAX), 1000)
  // Slow status (1300 ms, EDR median): 1300×4=5200 => stretches.
  assert.equal(computeEffectiveIntervalMs(1000, 1300, F, MAX), 5200)
  assert.equal(computeEffectiveIntervalMs(3000, 1300, F, MAX), 5200)
  // Peak spike (12900 ms): 12900×4=51600 < 60000 cap => 51600.
  assert.equal(computeEffectiveIntervalMs(1000, 12900, F, MAX), 51600)
  // Pathological (20000 ms): 20000×4=80000 capped at 60000.
  assert.equal(computeEffectiveIntervalMs(1000, 20000, F, MAX), MAX)
})

test('backoff: a slow focused status pushes the next gap to duration × factor, not 1 s', () => {
  const s = new GitReconcileScheduler()
  s.setTaskState('t1', REPO_A, 'focused')
  s.onReconcileStart(REPO_A)
  // Status took 1300 ms (EDR) -> next effective gap = max(1000, 1300×4) = 5200.
  s.onReconcileDone(REPO_A, 1300, 1300)
  assert.deepEqual(s.tick(1300 + 1000), [], 'NOT due at the base 1 s gap — backoff engaged')
  assert.deepEqual(s.tick(1300 + 5199), [], 'not due just before the stretched gap')
  const due = s.tick(1300 + 5200)
  assert.deepEqual(dueKeys(due), [REPO_A], 'due exactly at lastReconcileAt + 5200')
  assert.equal(due[0].reason, 'heartbeat-focused')
})

test('backoff: a fast status keeps the base cadence (zero regression on a normal host)', () => {
  const s = new GitReconcileScheduler()
  s.setTaskState('t1', REPO_A, 'focused')
  s.onReconcileStart(REPO_A)
  s.onReconcileDone(REPO_A, 50, 50) // 50 ms status: 50×4=200 < 1000 -> still 1 s
  assert.deepEqual(s.tick(50 + 999), [])
  assert.deepEqual(dueKeys(s.tick(50 + 1000)), [REPO_A], 'base 1 s cadence preserved')
})

test('backoff: omitting durationMs (legacy callers) keeps the base cadence', () => {
  const s = new GitReconcileScheduler()
  s.setTaskState('t1', REPO_A, 'visible')
  s.onReconcileStart(REPO_A)
  s.onReconcileDone(REPO_A, 100) // no duration arg -> no backoff
  assert.deepEqual(s.tick(100 + 3000 - 1), [])
  assert.deepEqual(dueKeys(s.tick(100 + 3000)), [REPO_A])
})

test('backoff: cadence recovers to base after status speeds back up', () => {
  const s = new GitReconcileScheduler()
  s.setTaskState('t1', REPO_A, 'focused')
  // Slow once -> stretched gap.
  s.onReconcileStart(REPO_A)
  s.onReconcileDone(REPO_A, 1000, 2000) // 2000×4=8000
  assert.deepEqual(s.tick(1000 + 1000), [], 'still backed off')
  const due1 = s.tick(1000 + 8000)
  assert.deepEqual(dueKeys(due1), [REPO_A])
  // Next status is fast -> gap returns to base 1 s.
  s.onReconcileStart(REPO_A)
  s.onReconcileDone(REPO_A, 9000, 40)
  assert.deepEqual(dueKeys(s.tick(9000 + 1000)), [REPO_A], 'recovered to the 1 s base')
})

test('backoff is per-repo independent: a slow repo does not stall a fast repo', () => {
  const s = new GitReconcileScheduler()
  s.setTaskState('t1', REPO_A, 'focused') // slow
  s.setTaskState('t2', REPO_B, 'focused') // fast
  s.onReconcileStart(REPO_A); s.onReconcileDone(REPO_A, 0, 1300) // A stretched to 5200
  s.onReconcileStart(REPO_B); s.onReconcileDone(REPO_B, 0, 30)   // B stays at 1000
  // At 1 s: only the fast repo B is due; the slow repo A is still backed off.
  assert.deepEqual(dueKeys(s.tick(1000)), [REPO_B])
  s.onReconcileStart(REPO_B); s.onReconcileDone(REPO_B, 1000, 30)
  // At 5200: A finally due (B not — it last ran at 1000, fast cadence 1 s, so also due).
  assert.deepEqual(dueKeys(s.tick(5200)), [REPO_A, REPO_B])
})

test('backoff: explicit dirty (watcher) still fires immediately even while backed off', () => {
  const s = new GitReconcileScheduler()
  s.setTaskState('t1', REPO_A, 'focused')
  s.onReconcileStart(REPO_A); s.onReconcileDone(REPO_A, 0, 5000) // stretched to 20000
  assert.deepEqual(s.tick(1000), [], 'heartbeat backed off')
  // A real file change must NOT wait for the stretched heartbeat.
  s.markDirty(REPO_A, 'watcher')
  const due = s.tick(1100)
  assert.deepEqual(dueKeys(due), [REPO_A])
  assert.equal(due[0].reason, 'watcher', 'dirty bypasses backoff — freshness preserved on real events')
})

test('exported backoff constants match the agreed design (factor 4, 60 s ceiling)', () => {
  assert.equal(RECONCILE_BACKOFF_FACTOR, 4)
  assert.equal(RECONCILE_MAX_BACKOFF_INTERVAL_MS, 60_000)
})

// ---------------------------------------------------------------------------
// BUG-0005 R5 — a duration measurement spanning a system sleep must not drive
// the adaptive backoff.
//
// Field evidence: `lastStatusMs` medians of ~925 s for repos whose true median
// is 44–79 ms, matching the `main:event-loop-stall` drift of ~920 s. The backoff
// read those as "status is catastrophically slow" and pinned the heartbeat at
// its 60 s ceiling right after every wake — precisely when the user came back
// and started looking at the badge.
// ---------------------------------------------------------------------------

test('duration sanity: a normal sample passes through, rounded', () => {
  assert.equal(sanitizeMeasuredDurationMs(79, 79), 79)
  assert.equal(sanitizeMeasuredDurationMs(308.6, 308.4), 308)
})

test('duration sanity: believes the SMALLER clock', () => {
  // macOS: mach_absolute_time stops across sleep, so the monotonic reading is
  // the honest one even though the wall clock jumped 15 minutes.
  assert.equal(sanitizeMeasuredDurationMs(925_000, 44), 44)
  // The reverse ordering must behave the same way — no clock is privileged.
  assert.equal(sanitizeMeasuredDurationMs(44, 925_000), 44)
})

test('duration sanity: rejects the field sample outright when BOTH clocks jumped', () => {
  // Linux CLOCK_BOOTTIME / macOS mach_continuous_time include suspend, so both
  // readings are inflated and there is no honest sample to keep.
  assert.equal(sanitizeMeasuredDurationMs(925_089, 925_089), 0)
  assert.equal(sanitizeMeasuredDurationMs(904_795, 904_795), 0)
})

test('duration sanity: boundary — at the ceiling kept, one ms past rejected', () => {
  const c = MIRROR_DURATION_SANITY_CEILING_MS
  assert.equal(sanitizeMeasuredDurationMs(c, c), c)
  assert.equal(sanitizeMeasuredDurationMs(c + 1, c + 1), 0)
})

test('duration sanity: the EDR-slow host that motivated the backoff still engages', () => {
  // 12.9 s peak from the original EDR trace is BELOW the ceiling, so the
  // adaptive backoff this rule guards must keep working — the fix must not
  // regress the behaviour it sits next to.
  const edrPeak = 12_900
  assert.equal(sanitizeMeasuredDurationMs(edrPeak, edrPeak), edrPeak)
  assert.equal(
    computeEffectiveIntervalMs(
      RECONCILE_FOCUSED_INTERVAL_MS,
      sanitizeMeasuredDurationMs(edrPeak, edrPeak),
      RECONCILE_BACKOFF_FACTOR,
      RECONCILE_MAX_BACKOFF_INTERVAL_MS
    ),
    edrPeak * RECONCILE_BACKOFF_FACTOR,
    'a genuinely slow host still stretches by the factor (51.6 s, just under the 60 s cap)'
  )
  // And a host slow enough to exceed the cap still clamps there rather than
  // being rejected outright — the ceiling and the cap are separate mechanisms.
  const belowCeilingButOverCap = 20_000
  assert.equal(sanitizeMeasuredDurationMs(belowCeilingButOverCap, belowCeilingButOverCap), 20_000)
  assert.equal(
    computeEffectiveIntervalMs(
      RECONCILE_FOCUSED_INTERVAL_MS,
      belowCeilingButOverCap,
      RECONCILE_BACKOFF_FACTOR,
      RECONCILE_MAX_BACKOFF_INTERVAL_MS
    ),
    RECONCILE_MAX_BACKOFF_INTERVAL_MS
  )
})

test('duration sanity: a rejected sample yields the BASE cadence, not the cap', () => {
  // This is the whole point: 0 already means "no measurement" downstream.
  const rejected = sanitizeMeasuredDurationMs(925_089, 925_089)
  assert.equal(
    computeEffectiveIntervalMs(
      RECONCILE_FOCUSED_INTERVAL_MS,
      rejected,
      RECONCILE_BACKOFF_FACTOR,
      RECONCILE_MAX_BACKOFF_INTERVAL_MS
    ),
    RECONCILE_FOCUSED_INTERVAL_MS,
    'post-wake the focused repo returns to its 1 s heartbeat'
  )
  assert.equal(
    computeEffectiveIntervalMs(
      RECONCILE_VISIBLE_INTERVAL_MS,
      rejected,
      RECONCILE_BACKOFF_FACTOR,
      RECONCILE_MAX_BACKOFF_INTERVAL_MS
    ),
    RECONCILE_VISIBLE_INTERVAL_MS
  )
})

test('duration sanity: garbage inputs degrade to 0 rather than NaN', () => {
  assert.equal(sanitizeMeasuredDurationMs(Number.NaN, Number.NaN), 0)
  assert.equal(sanitizeMeasuredDurationMs(Number.POSITIVE_INFINITY, Number.NaN), 0)
  // A negative reading (clock stepped backwards) is not a usable sample.
  assert.equal(sanitizeMeasuredDurationMs(-5, -5), 0)
  // …but a valid partner reading is still honoured.
  assert.equal(sanitizeMeasuredDurationMs(-5, 60), 60)
})
