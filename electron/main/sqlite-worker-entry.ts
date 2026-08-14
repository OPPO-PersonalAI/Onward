/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

import { parentPort } from 'worker_threads'
import {
  deleteProjectSqliteRow,
  executeProjectSqlite,
  getProjectSqliteSchema,
  insertProjectSqliteRow,
  readProjectSqliteTableRows,
  updateProjectSqliteRow
} from './project-editor-utils'
import { startWorkerMemorySampler } from './worker-memory-sampler'

startWorkerMemorySampler('sqlite')

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

function stringPayload(payload: Record<string, unknown>, key: string): string {
  const value = payload[key]
  return typeof value === 'string' ? value : ''
}

async function dispatch(method: SqliteWorkerMethod, payload: Record<string, unknown>): Promise<unknown> {
  const root = stringPayload(payload, 'root')
  const path = stringPayload(payload, 'path')
  switch (method) {
    case 'getSchema':
      return await getProjectSqliteSchema(root, path)
    case 'readTableRows':
      return await readProjectSqliteTableRows(
        root,
        path,
        stringPayload(payload, 'table'),
        typeof payload.limit === 'number' ? payload.limit : undefined,
        typeof payload.offset === 'number' ? payload.offset : undefined
      )
    case 'insertRow':
      return await insertProjectSqliteRow(root, path, stringPayload(payload, 'table'), payload.values as Record<string, unknown>)
    case 'updateRow':
      return await updateProjectSqliteRow(
        root,
        path,
        stringPayload(payload, 'table'),
        payload.key,
        payload.values as Record<string, unknown>
      )
    case 'deleteRow':
      return await deleteProjectSqliteRow(root, path, stringPayload(payload, 'table'), payload.key)
    case 'execute':
      return await executeProjectSqlite(root, path, stringPayload(payload, 'sql'))
    default:
      throw new Error(`Unsupported SQLite worker method: ${method}`)
  }
}

parentPort?.on('message', async (request: WorkerRequest) => {
  const response: WorkerResponse = {
    id: request.id,
    ok: false
  }

  try {
    response.result = await dispatch(request.method, request.payload || {})
    response.ok = true
  } catch (error) {
    response.error = error instanceof Error ? error.message : String(error)
  }

  parentPort?.postMessage(response)
})
