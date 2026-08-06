/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

import { join } from 'path'
import { Worker } from 'worker_threads'
import { BrowserWindow } from 'electron'
import { mainWorkScheduler } from './main-work-scheduler'
import { resolveRipgrepPath } from './ripgrep-binary-path'
import { performanceTrace } from './performance-trace'
import { IPC } from '../shared/ipc-channels'
import { PERF_TRACE_EVENT } from '../../src/utils/perf-trace-names'

export interface RipgrepSearchOptions {
  searchId?: string
  rootPath: string
  query: string
  isRegex: boolean
  isCaseSensitive: boolean
  isWholeWord: boolean
  includeGlob?: string
  excludeGlob?: string
  maxResults?: number
}

export interface RipgrepMatch {
  file: string
  line: number
  column: number
  matchLength: number
  lineContent: string
}

export interface RipgrepSearchStats {
  searchId: string
  matchCount: number
  fileCount: number
  durationMs: number
  cancelled: boolean
}

type WorkerMethod = 'start' | 'cancel'

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

type WorkerEvent =
  | { event: 'result'; searchId: string; matches: RipgrepMatch[] }
  | { event: 'done'; stats: RipgrepSearchStats }
  | { event: 'trace'; name: string; data?: Record<string, unknown> }

type PendingRequest = {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
  method: WorkerMethod
  startedAt: number
}

const WORKER_REQUEST_TIMEOUT_MS = 10000

let searchCounter = 0

export class RipgrepSearchManager {
  private worker: Worker | null = null
  // Quit latch (see git-state-mirror-router): no worker spawns after quit begins.
  private disposed = false
  private nextRequestId = 1
  private pending = new Map<number, PendingRequest>()
  private activeSearchId: string | null = null
  private rgPath: string | null = null
  private mainWindow: BrowserWindow | null = null

  start(mainWindow: BrowserWindow, options: RipgrepSearchOptions): string {
    this.cancel()
    this.mainWindow = mainWindow
    const searchId = typeof options.searchId === 'string' && options.searchId.trim()
      ? options.searchId.trim()
      : `search-${++searchCounter}-${Date.now()}`
    this.activeSearchId = searchId
    const rgPath = this.getRipgrepPath()

    setImmediate(() => {
      if (this.activeSearchId !== searchId || mainWindow.isDestroyed() || this.disposed) return
      void mainWorkScheduler.enqueue(
        {
          lane: 'background-index',
          key: `project-search:start:${searchId}`,
          ownerId: 'project-search',
          label: 'project content search start',
          timeoutMs: WORKER_REQUEST_TIMEOUT_MS,
          concurrencyKey: 'project-search',
          concurrencyLimit: 1
        },
        () => this.request('start', { searchId, rgPath, options })
      ).catch((error) => {
        if (this.activeSearchId !== searchId || mainWindow.isDestroyed() || this.disposed) return
        performanceTrace.record(PERF_TRACE_EVENT.WORKER_RIPGREP_START_ERROR, {
          searchId,
          error: String(error)
        })
        mainWindow.webContents.send(IPC.PROJECT_SEARCH_DONE, {
          searchId,
          matchCount: 0,
          fileCount: 0,
          durationMs: 0,
          cancelled: false
        } satisfies RipgrepSearchStats)
      })
    })

    return searchId
  }

  cancel(): void {
    const searchId = this.activeSearchId
    this.activeSearchId = null
    if (!this.worker) return
    void this.request('cancel', { searchId }).catch(() => {})
  }

  dispose(): void {
    // Idempotent and never throws: dispose runs inside the quit-time
    // runCleanupIpcHandlers chain, where an escaped exception would skip
    // every later subsystem's dispose (including the GitStateMirror worker
    // drain) and hang the quit until the debug-quit hard-exit floor.
    // Deliberately no cancel() round-trip here — worker.terminate() below
    // already tears down any in-flight search, and cancel()'s request()
    // path would throw synchronously once `disposed` is set.
    if (this.disposed) return
    this.disposed = true
    this.activeSearchId = null
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer)
      pending.reject(new Error('Ripgrep search worker disposed'))
      this.pending.delete(id)
    }
    if (this.worker) {
      this.worker.terminate().catch(() => {})
      this.worker = null
    }
  }

  private getRipgrepPath(): string {
    if (!this.rgPath) {
      this.rgPath = resolveRipgrepPath()
    }
    return this.rgPath
  }

  private ensureWorker(): Worker {
    if (this.disposed) throw new Error('Ripgrep search worker client disposed (quit in progress)')
    if (this.worker) return this.worker

    const workerPath = join(__dirname, 'ripgrep-search-worker-entry.js')
    this.worker = new Worker(workerPath)
    this.worker.on('message', (message: WorkerResponse | WorkerEvent) => {
      if ('event' in message) {
        this.handleWorkerEvent(message)
      } else {
        this.handleResponse(message)
      }
    })
    this.worker.on('error', (error) => {
      performanceTrace.record(PERF_TRACE_EVENT.WORKER_RIPGREP_ERROR, { error: String(error) })
    })
    this.worker.on('exit', (code) => {
      performanceTrace.record(PERF_TRACE_EVENT.WORKER_RIPGREP_EXIT, {
        code,
        pending: this.pending.size
      })
      this.rejectAllPending(new Error(`Ripgrep worker exited with code ${code}`))
      this.worker = null
      this.activeSearchId = null
    })
    return this.worker
  }

  private request<T = unknown>(method: WorkerMethod, payload: Record<string, unknown>): Promise<T> {
    // ensureWorker throws synchronously after dispose; surface that as a
    // rejected promise so `.catch()` callers actually catch it instead of
    // the exception escaping the synchronous prefix.
    let worker: Worker
    try {
      worker = this.ensureWorker()
    } catch (error) {
      return Promise.reject(error)
    }
    const id = this.nextRequestId++
    const startedAt = Date.now()

    return new Promise<T>((resolveTask, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        performanceTrace.record(PERF_TRACE_EVENT.WORKER_RIPGREP_TIMEOUT, {
          id,
          method,
          elapsedMs: Date.now() - startedAt
        })
        reject(new Error(`Ripgrep worker request timed out: ${method}`))
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

  private handleWorkerEvent(message: WorkerEvent): void {
    if (message.event === 'trace') {
      performanceTrace.record(message.name, message.data)
      return
    }

    const mainWindow = this.mainWindow
    if (!mainWindow || mainWindow.isDestroyed()) return

    if (message.event === 'result') {
      if (this.activeSearchId !== message.searchId) return
      mainWindow.webContents.send(IPC.PROJECT_SEARCH_RESULT, message.searchId, message.matches)
      return
    }

    if (this.activeSearchId !== message.stats.searchId) return
    mainWindow.webContents.send(IPC.PROJECT_SEARCH_DONE, message.stats)
    this.activeSearchId = null
  }

  private handleResponse(message: WorkerResponse): void {
    const pending = this.pending.get(message.id)
    if (!pending) return
    clearTimeout(pending.timer)
    this.pending.delete(message.id)

    const elapsedMs = Date.now() - pending.startedAt
    if (elapsedMs > 250) {
      performanceTrace.record(PERF_TRACE_EVENT.WORKER_RIPGREP_LATENCY, {
        id: message.id,
        method: pending.method,
        elapsedMs
      })
    }

    if (message.ok) {
      pending.resolve(message.result)
    } else {
      pending.reject(new Error(message.error || `Ripgrep worker failed: ${pending.method}`))
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
