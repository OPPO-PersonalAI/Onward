/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

import * as http from 'http'
import { app, BrowserWindow } from 'electron'
import { join } from 'path'
import { writeFileSync, unlinkSync, existsSync } from 'fs'
import { getAppStateStorage } from './app-state-storage'
import { getAppInfo } from './app-info'
import { getTerminalBuffer, sendPromptViaBridge } from './ipc-handlers'
import { getUpdateService } from './update-service'
import { performanceTrace } from './performance-trace'
import { getThreadpoolHealthSnapshot } from './threadpool-watchdog'
import { getVisibilityHealthSnapshot } from './visibility-watchdog'

interface ApiServerOptions {
  onRestartToApplyUpdate?: () => Promise<{ success: boolean; error?: string }>
  onGracefulQuitForDebug?: () => Promise<{ success: boolean; error?: string }>
}

let server: http.Server | null = null
let apiPort: number = 0
let lockFilePath: string = ''

/**
 * Get the current API Server port number
 */
export function getApiPort(): number {
  return apiPort
}

/**
 * Parse URL path parameters
 * For example /api/terminal/terminal-1/buffer → { id: 'terminal-1', action: 'buffer' }
 */
function parseTerminalRoute(pathname: string): { id: string; action: string } | null {
  const match = pathname.match(/^\/api\/terminal\/([^/]+)\/(\w+)$/)
  if (!match) return null
  return { id: match[1], action: match[2] }
}

/**
 * Read the request body (for POST requests)
 */
function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = ''
    req.on('data', (chunk: Buffer) => {
      body += chunk.toString()
      // Limit body size to 1MB
      if (body.length > 1024 * 1024) {
        reject(new Error('Request body is too large'))
      }
    })
    req.on('end', () => resolve(body))
    req.on('error', reject)
  })
}

/**
 * Send JSON response
 */
function sendJson(res: http.ServerResponse, statusCode: number, data: unknown): void {
  const body = JSON.stringify(data)
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body)
  })
  res.end(body)
}

/**
 * Parse URL query parameters
 */
function parseQuery(url: string): Record<string, string> {
  const qIndex = url.indexOf('?')
  if (qIndex === -1) return {}
  const qs = url.substring(qIndex + 1)
  const params: Record<string, string> = {}
  for (const pair of qs.split('&')) {
    const [key, value] = pair.split('=')
    if (key) {
      params[decodeURIComponent(key)] = value ? decodeURIComponent(value) : ''
    }
  }
  return params
}

/**
 * Start HTTP API Server
 */
export async function startApiServer(mainWindow: BrowserWindow, options: ApiServerOptions = {}): Promise<number> {
  return new Promise((resolve, reject) => {
    const startTime = Date.now()

    server = http.createServer(async (req, res) => {
      const url = req.url || '/'
      const pathname = url.split('?')[0]
      const method = req.method || 'GET'

      try {
        // GET /api/health
        if (method === 'GET' && pathname === '/api/health') {
          const appInfo = getAppInfo()
          const threadpool = getThreadpoolHealthSnapshot()
          const visibility = getVisibilityHealthSnapshot()
          sendJson(res, 200, {
            status: 'ok',
            pid: process.pid,
            uptime: Math.floor((Date.now() - startTime) / 1000),
            app: appInfo.displayName,
            version: appInfo.version,
            buildChannel: appInfo.buildChannel,
            releaseChannel: appInfo.releaseChannel,
            releaseOs: appInfo.releaseOs,
            // Infrastructure watchdogs (2026-07-20 incident class). External
            // tools and autotests read these to detect a degraded instance:
            // threadpool 'stalled' = async fs/dns/zlib/crypto dead until
            // restart; ptyWriteMode 'sync' = patched threadpool-free posix
            // keystroke delivery is active.
            threadpool: threadpool.status,
            threadpoolStalledSince: threadpool.stalledSince,
            visibility: visibility.status,
            ptyWriteMode: process.platform === 'win32' ? 'conpty' : 'sync'
          })
          return
        }

        if (process.env.ONWARD_DEBUG === '1') {
          if (method === 'GET' && pathname === '/api/debug/updater/status') {
            sendJson(res, 200, getUpdateService().getStatus())
            return
          }

          if (method === 'POST' && pathname === '/api/debug/updater/check') {
            const status = await getUpdateService().checkNow()
            sendJson(res, 200, status)
            return
          }

          if (method === 'POST' && pathname === '/api/debug/updater/restart') {
            if (!options.onRestartToApplyUpdate) {
              sendJson(res, 501, { success: false, error: 'Updater restart callback is not configured.' })
              return
            }
            const result = await options.onRestartToApplyUpdate()
            sendJson(res, result.success ? 200 : 409, result)
            return
          }

          if (method === 'POST' && pathname === '/api/debug/app/quit') {
            if (!options.onGracefulQuitForDebug) {
              sendJson(res, 501, { success: false, error: 'Graceful quit callback is not configured.' })
              return
            }
            const result = await options.onGracefulQuitForDebug()
            sendJson(res, result.success ? 200 : 409, result)
            return
          }
        }

        // GET /api/tasks
        if (method === 'GET' && pathname === '/api/tasks') {
          const appState = getAppStateStorage().get()
          const activeTab = appState.tabs.find(t => t.id === appState.activeTabId)
          if (!activeTab) {
            sendJson(res, 200, { tasks: [] })
            return
          }

          const tasks = activeTab.terminals.map((term, index) => ({
            id: term.id,
            index: index + 1,
            name: term.customName || `Task ${index + 1}`,
            isActive: term.id === activeTab.activeTerminalId
          }))

          sendJson(res, 200, {
            tabId: activeTab.id,
            tabName: activeTab.customName || 'Tab',
            tasks
          })
          return
        }

        // Terminal routing
        const termRoute = parseTerminalRoute(pathname)
        if (termRoute) {
          // GET /api/terminal/:id/buffer
          if (method === 'GET' && termRoute.action === 'buffer') {
            const query = parseQuery(url)
            const mode = query.mode || 'tail-lines'

            // Disable mode=full to prevent reading the complete buffer from consuming a large amount of tokens
            if (mode === 'full') {
              sendJson(res, 400, {
                success: false,
                error: 'mode=full is disabled because it reads the entire buffer and can consume too many tokens. Use mode=tail-lines or mode=tail-chars instead.'
              })
              return
            }

            const options: Record<string, unknown> = { mode }

            if (mode === 'tail-lines') {
              options.lastLines = parseInt(query.lines || '100', 10)
              if (query.offset) {
                options.offset = parseInt(query.offset, 10)
              }
            } else if (mode === 'tail-chars') {
              options.lastChars = parseInt(query.chars || '500', 10)
            }

            // Supports specifying buffer types for reading: active (default), normal, alternate
            if (query.buffer && ['active', 'normal', 'alternate'].includes(query.buffer)) {
              options.buffer = query.buffer
            }

            const result = await getTerminalBuffer(mainWindow, termRoute.id, options as {
              mode?: string
              lastLines?: number
              lastChars?: number
              offset?: number
              buffer?: string
            })

            sendJson(res, result.success ? 200 : 404, result)
            return
          }

          // POST /api/terminal/:id/write
          if (method === 'POST' && termRoute.action === 'write') {
            const requestStartUs = performanceTrace.nowUs()
            const body = await readBody(req)
            let payload: { text?: string; execute?: boolean }

            try {
              payload = JSON.parse(body)
            } catch {
              sendJson(res, 400, { success: false, error: 'Invalid JSON body' })
              return
            }

            if (!payload.text && payload.text !== '') {
              sendJson(res, 400, { success: false, error: 'Missing text field' })
              return
            }

            // Take Prompt Bridge IPC, executed by the rendering process (including split-write and history)
            const action = payload.execute ? 'send-and-execute' : 'send'
            const flowId = performanceTrace.createFlowId('api-terminal-write')
            performanceTrace.recordFlowStart('api.terminal.write', flowId, {
              terminalId: termRoute.id,
              action,
              ...performanceTrace.summarizeText('payload', payload.text)
            }, 'api')
            const result = await sendPromptViaBridge(mainWindow, termRoute.id, payload.text, action, { traceFlowId: flowId })
            const deliveredCount = result.successIds.length + result.sentOnlyIds.length
            const status = result.success ? 200 : deliveredCount > 0 ? 409 : 500
            performanceTrace.recordComplete('api.request', requestStartUs, {
              route: 'POST /api/terminal/:id/write',
              terminalId: termRoute.id,
              action,
              status,
              deliveredCount,
              failedCount: result.failedIds.length
            }, 'api')
            performanceTrace.recordFlowStep('api.terminal.write.result', flowId, {
              terminalId: termRoute.id,
              action,
              status,
              deliveredCount,
              failedCount: result.failedIds.length
            }, 'api')
            sendJson(res, status, result)
            return
          }
        }

        // 404 - Unknown route
        sendJson(res, 404, { error: 'Unknown API path', path: pathname })
      } catch (error) {
        console.error('[API Server] Request handling error:', error)
        sendJson(res, 500, { error: 'Internal server error' })
      }
    })

    server.listen(0, '127.0.0.1', () => {
      const address = server!.address()
      if (typeof address === 'object' && address) {
        apiPort = address.port
      }

      // Write lock file
      lockFilePath = join(app.getPath('userData'), 'onward-api.lock')
      const lockData = {
        pid: process.pid,
        port: apiPort,
        startedAt: Date.now()
      }

      try {
        writeFileSync(lockFilePath, JSON.stringify(lockData, null, 2), 'utf-8')
      } catch (error) {
        console.error('[API Server] Failed to write lock file:', error)
      }

      console.log(`[API Server] Started: http://127.0.0.1:${apiPort}`)
      resolve(apiPort)
    })

    server.on('error', (error) => {
      console.error('[API Server] Failed to start:', error)
      reject(error)
    })
  })
}

/**
 * Stop the HTTP API Server and clean the lock file
 */
export function stopApiServer(): void {
  if (server) {
    server.close(() => {
      console.log('[API Server] Stopped')
    })
    server = null
  }

  apiPort = 0

  // Clean lock file
  if (lockFilePath && existsSync(lockFilePath)) {
    try {
      unlinkSync(lockFilePath)
    } catch (error) {
      console.error('[API Server] Failed to clean lock file:', error)
    }
  }
}
