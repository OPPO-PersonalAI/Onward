/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 *
 * Pure GPU-process target selection for the autotest real-kill hook
 * (DEBUG_KILL_GPU_PROCESS). Extracted so the pick-the-victim logic is
 * unit-testable without Electron (test/unittest/gpu-process-kill-target.test.mts).
 */

export interface ProcessMetricLike {
  pid: number
  type: string
}

export interface GpuProcessTarget {
  pid: number
  gpuEntryCount: number
}

/**
 * Pick the GPU process from app.getAppMetrics() output. Exactly one GPU
 * entry is expected; if Chromium ever reports several (respawn overlap),
 * take the first and surface the count so the caller can log it. Non-positive
 * pids are rejected — process.kill(0/-n, …) targets process GROUPS, which a
 * test hook must never do.
 */
export function findGpuProcessMetric(metrics: ProcessMetricLike[]): GpuProcessTarget | null {
  const gpuEntries = metrics.filter((m) => m.type === 'GPU' && Number.isInteger(m.pid) && m.pid > 0)
  if (gpuEntries.length === 0) return null
  return { pid: gpuEntries[0].pid, gpuEntryCount: gpuEntries.length }
}
