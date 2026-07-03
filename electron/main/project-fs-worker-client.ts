/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

import { join, resolve } from 'path'
import { Worker } from 'worker_threads'
import { mainWorkScheduler, type MainWorkLane } from './main-work-scheduler'
import {
  performanceTrace,
  isPerfTraceWorkerEvent,
  replayPerfTraceWorkerEvent,
  WORKER_TID
} from './performance-trace'
import { PERF_TRACE_EVENT } from '../../src/utils/perf-trace-names'

type ProjectFsWorkerMethod = 'listDirectory' | 'buildFileIndex' | 'searchFilenames' | 'invalidateFileIndex'

type WorkerRequest = {
  id: number
  method: ProjectFsWorkerMethod
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
  method: ProjectFsWorkerMethod
  startedAt: number
}

const WORKER_REQUEST_TIMEOUT_MS = 90000

class ProjectFsWorkerClient {
  private worker: Worker | null = null
  // Quit latch (see git-state-mirror-router): no worker spawns after quit begins.
  private disposed = false
  private nextRequestId = 1
  private pending = new Map<number, PendingRequest>()

  listDirectory(root: string, path: string): Promise<unknown> {
    const normalizedRoot = resolve(root)
    return this.enqueue('listDirectory', { root: normalizedRoot, path }, {
      lane: 'visible-ui',
      key: `project-fs:list:${normalizedRoot}:${path}`,
      label: 'project list directory',
      concurrencyKey: normalizedRoot,
      concurrencyLimit: 2
    })
  }

  buildFileIndex(root: string): Promise<string[]> {
    const normalizedRoot = resolve(root)
    return this.enqueue<string[]>('buildFileIndex', { root: normalizedRoot }, {
      lane: 'background-index',
      key: `project-fs:index:${normalizedRoot}`,
      label: 'project build file index',
      concurrencyKey: normalizedRoot,
      concurrencyLimit: 1
    })
  }

  searchFilenames(root: string, query: string, limit: number): Promise<string[]> {
    const normalizedRoot = resolve(root)
    const ownerId = `project-fs:filename-search:${normalizedRoot}`
    mainWorkScheduler.cancelOwner(ownerId, 'superseded filename search')
    return this.enqueue<string[]>('searchFilenames', { root: normalizedRoot, query, limit }, {
      lane: 'focused-interactive',
      key: `project-fs:filename-search:${normalizedRoot}:${query}:${limit}`,
      ownerId,
      label: 'project filename search',
      concurrencyKey: `${normalizedRoot}:filename-search`,
      concurrencyLimit: 1
    }).catch((error) => {
      if (String(error).includes('superseded filename search')) {
        return []
      }
      throw error
    })
  }

  invalidateFileIndex(root: string): Promise<{ success: boolean }> {
    const normalizedRoot = resolve(root)
    return this.enqueue<{ success: boolean }>('invalidateFileIndex', { root: normalizedRoot }, {
      lane: 'maintenance',
      key: `project-fs:index-invalidate:${normalizedRoot}:${Date.now()}`,
      label: 'project invalidate file index',
      concurrencyKey: normalizedRoot,
      concurrencyLimit: 1
    })
  }

  dispose(): void {
    this.disposed = true
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer)
      pending.reject(new Error('Project FS worker disposed'))
      this.pending.delete(id)
    }
    if (this.worker) {
      this.worker.terminate().catch(() => {})
      this.worker = null
    }
  }

  private enqueue<T>(
    method: ProjectFsWorkerMethod,
    payload: Record<string, unknown>,
    options: {
      lane: MainWorkLane
      key?: string
      ownerId?: string
      label: string
      concurrencyKey?: string
      concurrencyLimit?: number
    }
  ): Promise<T> {
    return mainWorkScheduler.enqueue(
      {
        lane: options.lane,
        key: options.key,
        ownerId: options.ownerId ?? 'project-fs',
        label: options.label,
        timeoutMs: WORKER_REQUEST_TIMEOUT_MS,
        concurrencyKey: options.concurrencyKey,
        concurrencyLimit: options.concurrencyLimit
      },
      () => this.request<T>(method, payload)
    )
  }

  private ensureWorker(): Worker {
    if (this.disposed) throw new Error('Project FS worker client disposed (quit in progress)')
    if (this.worker) return this.worker
    const workerPath = join(__dirname, 'project-fs-worker-entry.js')
    this.worker = new Worker(workerPath)
    this.worker.on('message', (message: WorkerResponse | unknown) => {
      if (isPerfTraceWorkerEvent(message)) {
        replayPerfTraceWorkerEvent(message, {
          tid: WORKER_TID.PROJECT_FS,
          threadName: 'project-fs-worker'
        })
        return
      }
      this.handleMessage(message as WorkerResponse)
    })
    this.worker.on('error', (error) => {
      performanceTrace.record(PERF_TRACE_EVENT.WORKER_PROJECT_FS_ERROR, { error: String(error) })
    })
    this.worker.on('exit', (code) => {
      performanceTrace.record(PERF_TRACE_EVENT.WORKER_PROJECT_FS_EXIT, {
        code,
        pending: this.pending.size
      })
      this.rejectAllPending(new Error(`Project FS worker exited with code ${code}`))
      this.worker = null
    })
    return this.worker
  }

  private request<T>(method: ProjectFsWorkerMethod, payload: Record<string, unknown>): Promise<T> {
    const worker = this.ensureWorker()
    const id = this.nextRequestId++
    const startedAt = Date.now()

    return new Promise<T>((resolveTask, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        performanceTrace.record(PERF_TRACE_EVENT.WORKER_PROJECT_FS_TIMEOUT, {
          id,
          method,
          elapsedMs: Date.now() - startedAt
        })
        reject(new Error(`Project FS worker request timed out: ${method}`))
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
    if (elapsedMs > 250) {
      performanceTrace.record(PERF_TRACE_EVENT.WORKER_PROJECT_FS_LATENCY, {
        id: message.id,
        method: pending.method,
        elapsedMs
      })
    }

    if (message.ok) {
      pending.resolve(message.result)
    } else {
      pending.reject(new Error(message.error || `Project FS worker failed: ${pending.method}`))
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

export const projectFsWorkerClient = new ProjectFsWorkerClient()
