/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

import { spawn, type ChildProcess } from 'child_process'
import { parentPort } from 'worker_threads'
import { basename } from 'path'

import { PERF_TRACE_EVENT } from '../../src/utils/perf-trace-names'
import { startWorkerMemorySampler } from './worker-memory-sampler'

startWorkerMemorySampler('ripgrep-search')

type TracePayload = Record<string, unknown>

function postTrace(name: string, data?: TracePayload): void {
  parentPort?.postMessage({ event: 'trace', name, data: data ?? {} })
}

interface RipgrepSearchOptions {
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

interface RipgrepMatch {
  file: string
  line: number
  column: number
  matchLength: number
  lineContent: string
}

type WorkerRequest =
  | {
      id: number
      method: 'start'
      payload: {
        searchId: string
        rgPath: string
        options: RipgrepSearchOptions
      }
    }
  | {
      id: number
      method: 'cancel'
      payload: {
        searchId?: string | null
      }
    }

type WorkerResponse = {
  id: number
  ok: boolean
  result?: unknown
  error?: string
}

type WorkerEvent =
  | { event: 'result'; searchId: string; matches: RipgrepMatch[] }
  | { event: 'done'; stats: { searchId: string; matchCount: number; fileCount: number; durationMs: number; cancelled: boolean } }

const activeProcesses = new Map<string, ChildProcess>()

function buildRipgrepArgs(options: RipgrepSearchOptions): string[] {
  const args = [
    '--json',
    '--no-heading',
    '--color', 'never',
    '--max-columns', '500',
    '--max-columns-preview'
  ]

  if (!options.isCaseSensitive) args.push('-i')
  if (options.isWholeWord) args.push('-w')

  if (options.isRegex) {
    args.push('-e', options.query)
  } else {
    args.push('-F', '-e', options.query)
  }

  if (options.includeGlob) {
    for (const glob of options.includeGlob.split(',')) {
      const trimmed = glob.trim()
      if (trimmed) args.push('--glob', trimmed)
    }
  }

  if (options.excludeGlob) {
    for (const glob of options.excludeGlob.split(',')) {
      const trimmed = glob.trim()
      if (trimmed) args.push('--glob', `!${trimmed}`)
    }
  }

  args.push('--max-count', '200')
  args.push('.')
  return args
}

function parseRipgrepLine(line: string): RipgrepMatch | null {
  try {
    const payload = JSON.parse(line) as {
      type?: string
      data?: {
        path?: { text?: string }
        line_number?: number
        lines?: { text?: string }
        submatches?: Array<{ start: number; end: number }>
      }
    }
    if (payload.type !== 'match' || !payload.data?.path?.text) return null

    let file = payload.data.path.text.replace(/\\/g, '/')
    if (file.startsWith('./')) file = file.slice(2)

    const submatch = payload.data.submatches?.[0]
    return {
      file,
      line: payload.data.line_number ?? 1,
      column: submatch ? submatch.start + 1 : 1,
      matchLength: submatch ? submatch.end - submatch.start : 0,
      lineContent: (payload.data.lines?.text ?? '').replace(/\n$/, '')
    }
  } catch {
    return null
  }
}

function postEvent(event: WorkerEvent): void {
  parentPort?.postMessage(event)
}

function startSearch(searchId: string, rgPath: string, options: RipgrepSearchOptions): void {
  const startTime = Date.now()
  const maxResults = options.maxResults ?? 5000
  let process: ChildProcess
  const spawnStartMs = Date.now()

  try {
    process = spawn(rgPath, buildRipgrepArgs(options), {
      cwd: options.rootPath,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true
    })
    postTrace(PERF_TRACE_EVENT.WORKER_RIPGREP_PROCESS_SPAWN, {
      searchId,
      rgBinary: basename(rgPath),
      pid: process.pid ?? null,
      argsLen: buildRipgrepArgs(options).length,
      maxResults,
      durationMs: Date.now() - spawnStartMs
    })
  } catch (error) {
    postTrace(PERF_TRACE_EVENT.WORKER_RIPGREP_PROCESS_SPAWN, {
      searchId,
      rgBinary: basename(rgPath),
      ok: false,
      error: String(error),
      durationMs: Date.now() - spawnStartMs
    })
    postEvent({
      event: 'done',
      stats: { searchId, matchCount: 0, fileCount: 0, durationMs: 0, cancelled: false }
    })
    return
  }

  activeProcesses.set(searchId, process)

  let matchCount = 0
  let lineBuffer = ''
  let limitReached = false
  let finished = false
  const files = new Set<string>()
  let batch: RipgrepMatch[] = []
  let batchTimer: ReturnType<typeof setTimeout> | null = null

  const flushBatch = () => {
    if (batchTimer) {
      clearTimeout(batchTimer)
      batchTimer = null
    }
    if (batch.length > 0) {
      postEvent({ event: 'result', searchId, matches: batch })
      batch = []
    }
  }

  const scheduleBatch = () => {
    if (!batchTimer) {
      batchTimer = setTimeout(flushBatch, 50)
    }
  }

  process.stdout?.on('data', (chunk: Buffer) => {
    if (limitReached) return
    lineBuffer += chunk.toString('utf-8')
    const lines = lineBuffer.split('\n')
    lineBuffer = lines.pop() ?? ''

    for (const line of lines) {
      if (!line.trim()) continue
      const match = parseRipgrepLine(line)
      if (!match) continue

      matchCount += 1
      files.add(match.file)
      batch.push(match)

      if (matchCount >= maxResults) {
        limitReached = true
        process.kill('SIGTERM')
        break
      }

      if (batch.length >= 30) {
        flushBatch()
      } else {
        scheduleBatch()
      }
    }
  })

  process.stderr?.on('data', () => {
    // Ripgrep warnings are not user-actionable for the search panel.
  })

  const finish = () => {
    if (finished) return
    finished = true
    if (lineBuffer.trim() && !limitReached) {
      const match = parseRipgrepLine(lineBuffer)
      if (match) {
        matchCount += 1
        files.add(match.file)
        batch.push(match)
      }
    }
    flushBatch()
    activeProcesses.delete(searchId)
    postTrace(PERF_TRACE_EVENT.WORKER_RIPGREP_PROCESS_EXIT, {
      searchId,
      pid: process.pid ?? null,
      matchCount,
      fileCount: files.size,
      limitReached,
      durationMs: Date.now() - startTime
    })
    postEvent({
      event: 'done',
      stats: {
        searchId,
        matchCount,
        fileCount: files.size,
        durationMs: Date.now() - startTime,
        cancelled: limitReached
      }
    })
  }

  process.on('close', finish)
  process.on('error', finish)
}

function cancelSearch(searchId?: string | null): void {
  const ids = searchId ? [searchId] : [...activeProcesses.keys()]
  for (const id of ids) {
    const process = activeProcesses.get(id)
    if (!process) continue
    try {
      process.kill('SIGTERM')
    } catch {
      // Ignore cancellation failures.
    }
    activeProcesses.delete(id)
  }
}

parentPort?.on('message', (request: WorkerRequest) => {
  const response: WorkerResponse = { id: request.id, ok: true }
  try {
    if (request.method === 'start') {
      startSearch(request.payload.searchId, request.payload.rgPath, request.payload.options)
      response.result = { success: true }
    } else {
      cancelSearch(request.payload.searchId)
      response.result = { success: true }
    }
  } catch (error) {
    response.ok = false
    response.error = String(error)
  }
  parentPort?.postMessage(response)
})
