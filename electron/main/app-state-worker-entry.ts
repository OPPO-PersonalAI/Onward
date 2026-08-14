/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

import { mkdir, writeFile } from 'fs/promises'
import { dirname } from 'path'
import { parentPort } from 'worker_threads'
import { startWorkerMemorySampler } from './worker-memory-sampler'

startWorkerMemorySampler('app-state')

type WorkerMethod = 'saveSnapshot'

type WorkerRequest = {
  id: number
  method: WorkerMethod
  payload: {
    storagePath?: string
    state?: unknown
  }
}

type WorkerResponse = {
  id: number
  ok: boolean
  result?: unknown
  error?: string
}

async function saveSnapshot(storagePath: string, state: unknown): Promise<{ bytes: number; durationMs: number }> {
  const startedAt = Date.now()
  await mkdir(dirname(storagePath), { recursive: true })
  const data = JSON.stringify(state, null, 2)
  await writeFile(storagePath, data, 'utf-8')
  return {
    bytes: Buffer.byteLength(data, 'utf-8'),
    durationMs: Date.now() - startedAt
  }
}

async function dispatch(request: WorkerRequest): Promise<unknown> {
  if (request.method === 'saveSnapshot') {
    const storagePath = request.payload.storagePath
    if (typeof storagePath !== 'string' || !storagePath) {
      throw new Error('storagePath is required')
    }
    return saveSnapshot(storagePath, request.payload.state)
  }
  throw new Error(`Unknown AppState worker method: ${request.method}`)
}

parentPort?.on('message', async (request: WorkerRequest) => {
  const response: WorkerResponse = { id: request.id, ok: true }
  try {
    response.result = await dispatch(request)
  } catch (error) {
    response.ok = false
    response.error = String(error)
  }
  parentPort?.postMessage(response)
})
