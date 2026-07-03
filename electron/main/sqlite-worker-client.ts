/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

import { join, resolve } from 'path'
import { Worker } from 'worker_threads'
import {
  performanceTrace,
  isPerfTraceWorkerEvent,
  replayPerfTraceWorkerEvent,
  WORKER_TID
} from './performance-trace'
import { mainWorkScheduler } from './main-work-scheduler'
import { PERF_TRACE_EVENT } from '../../src/utils/perf-trace-names'

type SqliteWorkerMethod =
  | 'getSchema'
  | 'readTableRows'
  | 'insertRow'
  | 'updateRow'
  | 'deleteRow'
  | 'execute'

type WorkerRequest = {
  id: number
  method: SqliteWorkerMethod
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
  method: SqliteWorkerMethod
  startedAt: number
}

const WORKER_REQUEST_TIMEOUT_MS = 90000

class SqliteWorkerClient {
  private worker: Worker | null = null
  // Quit latch (see git-state-mirror-router): no worker spawns after quit begins.
  private disposed = false
  private nextRequestId = 1
  private pending = new Map<number, PendingRequest>()

  getSchema(root: string, path: string): Promise<unknown> {
    return this.enqueue('getSchema', { root, path })
  }

  readTableRows(root: string, path: string, table: string, limit?: number, offset?: number): Promise<unknown> {
    return this.enqueue('readTableRows', { root, path, table, limit, offset })
  }

  insertRow(root: string, path: string, table: string, values: Record<string, unknown>): Promise<unknown> {
    return this.enqueue('insertRow', { root, path, table, values }, 'focused-interactive')
  }

  updateRow(root: string, path: string, table: string, key: unknown, values: Record<string, unknown>): Promise<unknown> {
    return this.enqueue('updateRow', { root, path, table, key, values }, 'focused-interactive')
  }

  deleteRow(root: string, path: string, table: string, key: unknown): Promise<unknown> {
    return this.enqueue('deleteRow', { root, path, table, key }, 'focused-interactive')
  }

  execute(root: string, path: string, sql: string): Promise<unknown> {
    return this.enqueue('execute', { root, path, sql }, 'focused-interactive')
  }

  dispose(): void {
    this.disposed = true
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer)
      pending.reject(new Error('SQLite worker disposed'))
      this.pending.delete(id)
    }
    if (this.worker) {
      this.worker.terminate().catch(() => {})
      this.worker = null
    }
  }

  private ensureWorker(): Worker {
    if (this.disposed) throw new Error('SQLite worker client disposed (quit in progress)')
    if (this.worker) return this.worker

    const workerPath = join(__dirname, 'sqlite-worker-entry.js')
    this.worker = new Worker(workerPath)
    this.worker.on('message', (message: WorkerResponse | unknown) => {
      if (isPerfTraceWorkerEvent(message)) {
        replayPerfTraceWorkerEvent(message, {
          tid: WORKER_TID.SQLITE,
          threadName: 'sqlite-worker'
        })
        return
      }
      this.handleMessage(message as WorkerResponse)
    })
    this.worker.on('error', (error) => {
      performanceTrace.record(PERF_TRACE_EVENT.WORKER_SQLITE_ERROR, { error: String(error) })
    })
    this.worker.on('exit', (code) => {
      performanceTrace.record(PERF_TRACE_EVENT.WORKER_SQLITE_EXIT, {
        code,
        pending: this.pending.size
      })
      this.rejectAllPending(new Error(`SQLite worker exited with code ${code}`))
      this.worker = null
    })
    return this.worker
  }

  private enqueue(
    method: SqliteWorkerMethod,
    payload: Record<string, unknown>,
    lane: 'focused-interactive' | 'visible-ui' = 'visible-ui'
  ): Promise<unknown> {
    const dbPath = this.describeDbPath(payload) ?? 'unknown'
    return mainWorkScheduler.enqueue(
      {
        lane,
        key: method === 'readTableRows'
          ? `sqlite:${method}:${dbPath}:${payload.table}:${payload.limit}:${payload.offset}`
          : undefined,
        ownerId: 'sqlite',
        label: `sqlite ${method}`,
        timeoutMs: WORKER_REQUEST_TIMEOUT_MS,
        concurrencyKey: dbPath,
        concurrencyLimit: 1
      },
      () => this.request(method, payload)
    )
  }

  private request(method: SqliteWorkerMethod, payload: Record<string, unknown>): Promise<unknown> {
    const worker = this.ensureWorker()
    const id = this.nextRequestId++
    const startedAt = Date.now()

    return new Promise((resolveTask, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        performanceTrace.record(PERF_TRACE_EVENT.WORKER_SQLITE_TIMEOUT, {
          id,
          method,
          dbPath: this.describeDbPath(payload),
          elapsedMs: Date.now() - startedAt
        })
        reject(new Error(`SQLite worker request timed out: ${method}`))
      }, WORKER_REQUEST_TIMEOUT_MS)

      this.pending.set(id, {
        resolve: resolveTask,
        reject,
        timer,
        method,
        startedAt
      })

      const request: WorkerRequest = { id, method, payload }
      worker.postMessage(request)
    })
  }

  private handleMessage(message: WorkerResponse): void {
    const pending = this.pending.get(message.id)
    if (!pending) return
    clearTimeout(pending.timer)
    this.pending.delete(message.id)

    const elapsedMs = Date.now() - pending.startedAt
    if (elapsedMs > 250) {
      performanceTrace.record(PERF_TRACE_EVENT.WORKER_SQLITE_LATENCY, {
        id: message.id,
        method: pending.method,
        elapsedMs
      })
    }

    if (message.ok) {
      pending.resolve(message.result)
    } else {
      pending.reject(new Error(message.error || `SQLite worker failed: ${pending.method}`))
    }
  }

  private rejectAllPending(error: Error): void {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer)
      pending.reject(error)
      this.pending.delete(id)
    }
  }

  private describeDbPath(payload: Record<string, unknown>): string | null {
    if (typeof payload.root !== 'string' || typeof payload.path !== 'string') return null
    try {
      return resolve(payload.root, payload.path)
    } catch {
      return null
    }
  }
}

export const sqliteWorkerClient = new SqliteWorkerClient()
