/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Per-worker memory self-report (Tier 1 of the memory diagnostics closed
 * loop). The 7 Node worker threads share the main pid, so they are
 * structurally invisible to app.getAppMetrics() — each worker samples its
 * own isolate and forwards the numbers over the standard perf-trace worker
 * envelope (performanceTrace.record() auto-forwards via parentPort in
 * worker context; the worker-client dispatchers replay onto the worker's
 * dedicated WORKER_TID lane).
 *
 * Cost: one v8.getHeapStatistics() + process.memoryUsage() call every
 * ONWARD_MEM_WATCH_INTERVAL_SEC (default 30 s) — microseconds of work far
 * off any hot path. The interval is unref'd so it never keeps a worker
 * alive during teardown.
 */

import { isMainThread } from 'worker_threads'
import { getHeapStatistics } from 'v8'

import { performanceTrace } from './performance-trace'
import { PERF_TRACE_EVENT } from '../../src/utils/perf-trace-names'
import { bytesToKb } from './memory-pressure-detector'

const MEM_WATCH_ENABLED = process.env.ONWARD_MEM_WATCH !== '0'

function resolveIntervalMs(): number {
  const raw = Number(process.env.ONWARD_MEM_WATCH_INTERVAL_SEC)
  const sec = Number.isFinite(raw) && raw >= 1 ? raw : 30
  return Math.round(sec * 1000)
}

/** First sample fires early so short-lived autotest runs still observe one. */
const FIRST_SAMPLE_DELAY_MS = 3000

export function startWorkerMemorySampler(workerName: string): () => void {
  if (isMainThread || !MEM_WATCH_ENABLED) return () => {}

  const emit = (): void => {
    try {
      const heap = getHeapStatistics()
      const mem = process.memoryUsage()
      performanceTrace.record(PERF_TRACE_EVENT.WORKER_MEM_WATCH_SAMPLE, {
        worker: workerName,
        heapUsedKb: bytesToKb(heap.used_heap_size),
        heapTotalKb: bytesToKb(heap.total_heap_size),
        heapLimitKb: bytesToKb(heap.heap_size_limit),
        mallocedKb: bytesToKb(heap.malloced_memory),
        externalKb: bytesToKb(mem.external),
        detachedContexts: heap.number_of_detached_contexts
      })
    } catch {
      // Sampling must never destabilize a worker; drop the tick silently.
    }
  }

  const first = setTimeout(emit, FIRST_SAMPLE_DELAY_MS)
  first.unref?.()
  const timer = setInterval(emit, resolveIntervalMs())
  timer.unref?.()
  return () => {
    clearTimeout(first)
    clearInterval(timer)
  }
}
