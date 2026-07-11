/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

import { readdir } from 'fs/promises'
import { relative, resolve, sep } from 'path'
import { parentPort } from 'worker_threads'
import { resolveInRoot } from './path-containment'

type ProjectEntry = {
  name: string
  path: string
  type: 'file' | 'dir'
}

type WorkerMethod = 'listDirectory' | 'buildFileIndex' | 'searchFilenames' | 'invalidateFileIndex'

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

const fileIndexCache = new Map<string, string[]>()


function toRelativePath(root: string, fullPath: string): string {
  return relative(root, fullPath).split(sep).join('/')
}

function sortEntries(entries: ProjectEntry[]): ProjectEntry[] {
  return entries.sort((a, b) => {
    if (a.type !== b.type) return a.type === 'dir' ? -1 : 1
    return a.name.localeCompare(b.name, 'zh-Hans-CN', { numeric: true })
  })
}

async function listDirectory(root: string, path: string) {
  const rootPath = resolve(root)
  const fullPath = resolveInRoot(rootPath, path)
  if (!fullPath) {
    return { success: false, root: rootPath, path, entries: [], error: 'Invalid path. It is outside the working directory.' }
  }

  try {
    const dirents = await readdir(fullPath, { withFileTypes: true })
    const entries = dirents.map((dirent): ProjectEntry => {
      const entryFullPath = resolve(fullPath, dirent.name)
      return {
        name: dirent.name,
        path: toRelativePath(rootPath, entryFullPath),
        type: dirent.isDirectory() ? 'dir' : 'file'
      }
    })
    return {
      success: true,
      root: rootPath,
      path,
      entries: sortEntries(entries)
    }
  } catch (error) {
    return {
      success: false,
      root: rootPath,
      path,
      entries: [],
      error: `Failed to read directory: ${String(error)}`
    }
  }
}

async function buildFileIndex(root: string): Promise<string[]> {
  const rootPath = resolve(root)
  const files: string[] = []
  const queue: string[] = ['']

  while (queue.length > 0) {
    const current = queue.shift() ?? ''
    const result = await listDirectory(rootPath, current)
    if (!result.success) continue
    for (const entry of result.entries) {
      if (entry.type === 'dir') {
        queue.push(entry.path)
      } else {
        files.push(entry.path)
      }
    }
  }

  fileIndexCache.set(rootPath, files)
  return files
}

function getBaseName(path: string): string {
  const slash = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
  return slash === -1 ? path : path.slice(slash + 1)
}

function fuzzyScore(query: string, target: string): number | null {
  if (!query) return 0
  let score = 0
  let lastIndex = -1
  for (let i = 0; i < query.length; i += 1) {
    const ch = query[i]
    let found = false
    for (let j = lastIndex + 1; j < target.length; j += 1) {
      if (target[j] === ch) {
        score += j === lastIndex + 1 ? 3 : 1
        lastIndex = j
        found = true
        break
      }
    }
    if (!found) return null
  }
  score += Math.max(0, 20 - (target.length - query.length))
  return score
}

async function searchFilenames(root: string, query: string, limit: number): Promise<string[]> {
  const rootPath = resolve(root)
  const files = fileIndexCache.get(rootPath) ?? await buildFileIndex(rootPath)
  const normalized = query.trim().toLowerCase()
  if (!normalized) return files.slice(0, limit)

  const scored: Array<{ item: string; score: number }> = []
  for (const item of files) {
    const lower = item.toLowerCase()
    const baseScore = fuzzyScore(normalized, getBaseName(lower))
    const pathScore = fuzzyScore(normalized, lower)
    if (baseScore === null && pathScore === null) continue
    scored.push({
      item,
      score: (baseScore ?? 0) * 2 + (pathScore ?? 0)
    })
  }

  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score
    return a.item.length - b.item.length
  })
  return scored.slice(0, limit).map((entry) => entry.item)
}

async function dispatch(method: WorkerMethod, payload: Record<string, unknown>): Promise<unknown> {
  const root = typeof payload.root === 'string' ? payload.root : ''
  switch (method) {
    case 'listDirectory':
      return listDirectory(root, typeof payload.path === 'string' ? payload.path : '')
    case 'buildFileIndex':
      return buildFileIndex(root)
    case 'searchFilenames':
      return searchFilenames(root, typeof payload.query === 'string' ? payload.query : '', Number(payload.limit) || 80)
    case 'invalidateFileIndex':
      fileIndexCache.delete(resolve(root))
      return { success: true }
    default:
      throw new Error(`Unknown Project FS worker method: ${method}`)
  }
}

parentPort?.on('message', async (request: WorkerRequest) => {
  const response: WorkerResponse = { id: request.id, ok: true }
  try {
    response.result = await dispatch(request.method, request.payload)
  } catch (error) {
    response.ok = false
    response.error = String(error)
  }
  parentPort?.postMessage(response)
})
