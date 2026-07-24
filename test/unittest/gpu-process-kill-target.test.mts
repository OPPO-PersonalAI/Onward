/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 *
 * Usage: node --experimental-strip-types --test test/unittest/gpu-process-kill-target.test.mts
 *
 * Pins the pure kill-target selection behind the autotest real-GPU-kill hook
 * (DEBUG_KILL_GPU_PROCESS). Pairs with the autotest layer:
 * run-gpu-real-kill-recovery-autotest.sh (GRK-01..) exercises the real
 * SIGKILL -> child-process-gone -> recovery chain; this layer pins the math
 * of "which pid gets the signal" so a metrics-shape change can never make
 * the hook target the wrong process (or a process GROUP via pid<=0).
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { findGpuProcessMetric } from '../../electron/main/gpu-process-metrics.ts'

test('GKT-U-01 no GPU entry → null (never guess a victim)', () => {
  assert.equal(findGpuProcessMetric([]), null)
  assert.equal(findGpuProcessMetric([{ pid: 100, type: 'Browser' }, { pid: 200, type: 'Tab' }]), null)
})

test('GKT-U-02 single GPU entry → that pid', () => {
  const target = findGpuProcessMetric([
    { pid: 100, type: 'Browser' },
    { pid: 321, type: 'GPU' },
    { pid: 200, type: 'Tab' }
  ])
  assert.deepEqual(target, { pid: 321, gpuEntryCount: 1 })
})

test('GKT-U-03 multiple GPU entries (respawn overlap) → first pid, count surfaced', () => {
  const target = findGpuProcessMetric([
    { pid: 321, type: 'GPU' },
    { pid: 654, type: 'GPU' }
  ])
  assert.deepEqual(target, { pid: 321, gpuEntryCount: 2 })
})

test('GKT-U-04 non-positive / non-integer pids rejected (kill(0/-n) targets process groups)', () => {
  assert.equal(findGpuProcessMetric([{ pid: 0, type: 'GPU' }]), null)
  assert.equal(findGpuProcessMetric([{ pid: -1, type: 'GPU' }]), null)
  assert.equal(findGpuProcessMetric([{ pid: 1.5, type: 'GPU' }]), null)
  // A bad entry must not mask a good one.
  const target = findGpuProcessMetric([{ pid: 0, type: 'GPU' }, { pid: 77, type: 'GPU' }])
  assert.deepEqual(target, { pid: 77, gpuEntryCount: 1 })
})
