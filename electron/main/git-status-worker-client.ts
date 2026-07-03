/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

import { join, resolve } from 'path'
import { Worker } from 'worker_threads'
import { gitRuntimeManager, type GitTaskPriority } from './git-runtime-manager'
import type { GitBranchAndStatus, TerminalGitInfo } from './git-utils'
import {
  performanceTrace,
  isPerfTraceWorkerEvent,
  replayPerfTraceWorkerEvent,
  WORKER_TID
} from './performance-trace'
import { PERF_TRACE_EVENT } from '../../src/utils/perf-trace-names'

type GitRepoMeta = {
  gitExecutable: string | null
  repoRoot: string | null
  gitDir: string | null
  isRepo: boolean
}

type WorkerMethod = 'getRepoMeta' | 'getRepoFingerprint' | 'getBranchAndStatus'

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

type WorkerTaskOptions = {
  priority?: GitTaskPriority
  repoKey?: string | null
  repoConcurrencyLimit?: number
  dedupeKey?: string
  label?: string
}

type PendingRequest = {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
  method: WorkerMethod
  startedAt: number
}

const WORKER_REQUEST_TIMEOUT_MS = 15000

class GitStatusWorkerClient {
  private worker: Worker | null = null
  // Quit latch (see git-state-mirror-router): no worker spawns after quit begins.
  private disposed = false
  private nextRequestId = 1
  private pending = new Map<number, PendingRequest>()

  getRepoMeta(cwd: string, options: WorkerTaskOptions = {}): Promise<GitRepoMeta> {
    return this.enqueueWorkerTask<GitRepoMeta>('getRepoMeta', { cwd }, {
      ...options,
      repoKey: options.repoKey ?? cwd,
      dedupeKey: options.dedupeKey ?? `worker:repo-meta:${resolve(cwd)}`,
      label: options.label ?? 'worker git rev-parse repo meta'
    })
  }

  getRepoFingerprint(gitDir: string | null, repoRoot: string, options: WorkerTaskOptions = {}): Promise<string> {
    return this.enqueueWorkerTask<string>('getRepoFingerprint', { gitDir, repoRoot }, {
      ...options,
      repoKey: options.repoKey ?? repoRoot,
      dedupeKey: options.dedupeKey ?? `worker:repo-fingerprint:${resolve(repoRoot)}:${gitDir ?? '<default>'}`,
      label: options.label ?? 'worker git repo fingerprint'
    })
  }

  getBranchAndStatus(
    cwd: string,
    options: WorkerTaskOptions & { includeUntracked?: boolean } = {}
  ): Promise<GitBranchAndStatus> {
    return this.enqueueWorkerTask<GitBranchAndStatus>(
      'getBranchAndStatus',
      { cwd, includeUntracked: options.includeUntracked === true },
      {
        ...options,
        repoKey: options.repoKey ?? cwd,
        repoConcurrencyLimit: 1,
        dedupeKey: options.dedupeKey ?? `worker:branch-status:${options.includeUntracked ? 'uall' : 'uno'}:${resolve(cwd)}`,
        label: options.label ?? 'worker git status --porcelain=2 --branch'
      }
    )
  }

  dispose(): void {
    this.disposed = true
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer)
      pending.reject(new Error('Git status worker disposed'))
      this.pending.delete(id)
    }
    if (this.worker) {
      this.worker.terminate().catch(() => {})
      this.worker = null
    }
  }

  private enqueueWorkerTask<T>(
    method: WorkerMethod,
    payload: Record<string, unknown>,
    options: WorkerTaskOptions = {}
  ): Promise<T> {
    return gitRuntimeManager.enqueueTask(
      {
        key: options.dedupeKey,
        repoKey: options.repoKey ?? undefined,
        repoConcurrencyLimit: options.repoConcurrencyLimit,
        priority: options.priority || 'low',
        kind: 'git',
        label: options.label || `git-status-worker:${method}`
      },
      () => this.request<T>(method, payload)
    )
  }

  private ensureWorker(): Worker {
    if (this.disposed) throw new Error('Git status worker client disposed (quit in progress)')
    if (this.worker) return this.worker

    const workerPath = join(__dirname, 'git-status-worker-entry.js')
    this.worker = new Worker(workerPath)
    this.worker.on('message', (message: WorkerResponse | unknown) => {
      if (isPerfTraceWorkerEvent(message)) {
        replayPerfTraceWorkerEvent(message, {
          tid: WORKER_TID.GIT_STATUS,
          threadName: 'git-status-worker'
        })
        return
      }
      this.handleMessage(message as WorkerResponse)
    })
    this.worker.on('error', (error) => {
      performanceTrace.record(PERF_TRACE_EVENT.WORKER_GIT_STATUS_ERROR, { error: String(error) })
    })
    this.worker.on('exit', (code) => {
      performanceTrace.record(PERF_TRACE_EVENT.WORKER_GIT_STATUS_EXIT, {
        code,
        pending: this.pending.size
      })
      this.rejectAllPending(new Error(`Git status worker exited with code ${code}`))
      this.worker = null
    })
    return this.worker
  }

  private request<T>(method: WorkerMethod, payload: Record<string, unknown>): Promise<T> {
    const worker = this.ensureWorker()
    const id = this.nextRequestId++
    const startedAt = Date.now()

    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        performanceTrace.record(PERF_TRACE_EVENT.WORKER_GIT_STATUS_TIMEOUT, {
          id,
          method,
          elapsedMs: Date.now() - startedAt
        })
        reject(new Error(`Git status worker request timed out: ${method}`))
      }, WORKER_REQUEST_TIMEOUT_MS)

      this.pending.set(id, {
        resolve: resolve as (value: unknown) => void,
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
    if (elapsedMs > 500) {
      performanceTrace.record(PERF_TRACE_EVENT.WORKER_GIT_STATUS_LATENCY, {
        id: message.id,
        method: pending.method,
        elapsedMs
      })
    }

    if (message.ok) {
      pending.resolve(message.result)
    } else {
      pending.reject(new Error(message.error || `Git status worker failed: ${pending.method}`))
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

export const gitStatusWorkerClient = new GitStatusWorkerClient()

export type { GitRepoMeta, GitBranchAndStatus, TerminalGitInfo }
