/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

import { join } from 'path'
import { Worker } from 'worker_threads'
import { mainWorkScheduler } from './main-work-scheduler'
import {
  performanceTrace,
  isPerfTraceWorkerEvent,
  replayPerfTraceWorkerEvent,
  WORKER_TID
} from './performance-trace'
import { PERF_TRACE_EVENT } from '../../src/utils/perf-trace-names'

type WorkerMethod = 'saveSnapshot'

type WorkerRequest = {
  id: number
  method: WorkerMethod
  payload: Record<string, unknown>
}

type WorkerResponse = {
  id: number
  ok: boolean
  result?: unknown
  error?: string
}

type PendingRequest = {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
  method: WorkerMethod
  startedAt: number
}

const WORKER_REQUEST_TIMEOUT_MS = 30000

class AppStateWorkerClient {
  private worker: Worker | null = null
  // Quit latch: mirror git-state-mirror-router's `disposed` guard so a task
  // still draining when quit begins cannot spawn a fresh worker_thread into a
  // tearing-down runtime (v8::ToLocalChecked Empty MaybeLocal on module load).
  private disposed = false
  private nextRequestId = 1
  private pending = new Map<number, PendingRequest>()

  saveSnapshot(storagePath: string, state: unknown): Promise<{ bytes: number; durationMs: number }> {
    return mainWorkScheduler.enqueue(
      {
        lane: 'maintenance',
        ownerId: 'app-state',
        label: 'app-state save snapshot',
        timeoutMs: WORKER_REQUEST_TIMEOUT_MS,
        concurrencyKey: 'app-state',
        concurrencyLimit: 1
      },
      () => this.request<{ bytes: number; durationMs: number }>('saveSnapshot', { storagePath, state })
    )
  }

  dispose(): void {
    this.disposed = true
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer)
      pending.reject(new Error('AppState worker disposed'))
      this.pending.delete(id)
    }
    if (this.worker) {
      this.worker.terminate().catch(() => {})
      this.worker = null
    }
  }

  private ensureWorker(): Worker {
    if (this.disposed) throw new Error('AppState worker client disposed (quit in progress)')
    if (this.worker) return this.worker

    const workerPath = join(__dirname, 'app-state-worker-entry.js')
    this.worker = new Worker(workerPath)
    this.worker.on('message', (message: WorkerResponse | unknown) => {
      if (isPerfTraceWorkerEvent(message)) {
        replayPerfTraceWorkerEvent(message, {
          tid: WORKER_TID.APP_STATE,
          threadName: 'app-state-worker'
        })
        return
      }
      this.handleMessage(message as WorkerResponse)
    })
    this.worker.on('error', (error) => {
      performanceTrace.record(PERF_TRACE_EVENT.WORKER_APP_STATE_ERROR, { error: String(error) })
    })
    this.worker.on('exit', (code) => {
      performanceTrace.record(PERF_TRACE_EVENT.WORKER_APP_STATE_EXIT, {
        code,
        pending: this.pending.size
      })
      this.rejectAllPending(new Error(`AppState worker exited with code ${code}`))
      this.worker = null
    })
    return this.worker
  }

  private request<T>(method: WorkerMethod, payload: Record<string, unknown>): Promise<T> {
    const worker = this.ensureWorker()
    const id = this.nextRequestId++
    const startedAt = Date.now()

    return new Promise<T>((resolveTask, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        performanceTrace.record(PERF_TRACE_EVENT.WORKER_APP_STATE_TIMEOUT, {
          id,
          method,
          elapsedMs: Date.now() - startedAt
        })
        reject(new Error(`AppState worker request timed out: ${method}`))
      }, WORKER_REQUEST_TIMEOUT_MS)

      this.pending.set(id, {
        resolve: resolveTask as (value: unknown) => void,
        reject,
        timer,
        method,
        startedAt
      })

      worker.postMessage({ id, method, payload } satisfies WorkerRequest)
    })
  }

  private handleMessage(message: WorkerResponse): void {
    const pending = this.pending.get(message.id)
    if (!pending) return
    clearTimeout(pending.timer)
    this.pending.delete(message.id)

    const elapsedMs = Date.now() - pending.startedAt
    performanceTrace.record(PERF_TRACE_EVENT.WORKER_APP_STATE_LATENCY, {
      id: message.id,
      method: pending.method,
      elapsedMs
    })

    if (message.ok) {
      pending.resolve(message.result)
    } else {
      pending.reject(new Error(message.error || `AppState worker failed: ${pending.method}`))
    }
  }

  private rejectAllPending(error: Error): void {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer)
      pending.reject(error)
      this.pending.delete(id)
    }
  }
}

export const appStateWorkerClient = new AppStateWorkerClient()
