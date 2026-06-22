/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

import { spawn, execFile } from 'node:child_process'
import { createWriteStream, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { join } from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

const WebSocketImpl = globalThis.WebSocket

const APP_BIN = process.env.APP_BIN || ''
const APP_NAME = process.env.APP_NAME || ''
const REPO_ROOT = process.env.REPO_ROOT || process.cwd()
const USER_DATA_BASE = process.env.USER_DATA_BASE || ''
const FIXTURE_BASE = process.env.FIXTURE_BASE || ''
const LOG_FILE = process.env.LOG_FILE || join(REPO_ROOT, 'traces/test-logs/git-state-mirror-quit-autotest.log')
const RESULT_FILE = process.env.RESULT_FILE || join(REPO_ROOT, 'traces/analysis/git-state-mirror-quit-autotest.json')
// Kept for backwards-compat with the runner's CDP_PORT env, but IGNORED for the
// actual per-trial port: fixed ports (9343 + trial) collide when a previous
// trial's Electron debug socket is slow to release on Windows or a leftover
// zombie still holds the port (observed as trial-5 `bind() WSAEADDRINUSE 0x2740`
// -> "No DevTools WebSocket announcement" -> SIGTERM). Each trial now binds a
// dynamic free port instead — same fix `check-renderer-idle-churn.mjs` adopted.
const BASE_CDP_PORT = Number(process.env.CDP_PORT || '9343')
void BASE_CDP_PORT
const TRIALS = Number(process.env.GSM_QUIT_TRIALS || '5')

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// Pick a free ephemeral port per trial. A previous run/trial can leave a socket
// in TIME_WAIT or a zombie holding a fixed port; choosing a fresh OS-assigned
// free port each trial makes the CDP launch immune to that collision class.
function getFreePort() {
  return new Promise((resolve, reject) => {
    const srv = createServer()
    srv.on('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address()
      srv.close(() => resolve(port))
    })
  })
}

function fail(message, detail = {}) {
  const error = new Error(message)
  error.detail = detail
  throw error
}

function appendLog(stream, line) {
  stream.write(`${line.endsWith('\n') ? line : `${line}\n`}`)
}

function serializeError(error) {
  if (!error) return null
  return {
    message: error instanceof Error ? error.message : String(error),
    detail: error.detail ?? null,
    stack: error instanceof Error ? error.stack : null
  }
}

async function waitForBrowserWebSocket(appLaunch) {
  const deadline = Date.now() + 30000
  let lastError = null
  while (Date.now() < deadline) {
    const { child, browserWebSocketPromise } = appLaunch
    if (child.exitCode !== null || child.signalCode !== null) {
      fail('App exited before DevTools browser WebSocket was available', {
        exitCode: child.exitCode,
        signal: child.signalCode
      })
    }
    try {
      const browserWebSocketUrl = await Promise.race([
        browserWebSocketPromise,
        sleep(250).then(() => null)
      ])
      if (browserWebSocketUrl) return browserWebSocketUrl
    } catch (error) {
      lastError = error
    }
  }
  fail('No DevTools browser WebSocket announcement', { lastError: String(lastError) })
}

async function createCdpConnection(webSocketUrl) {
  if (!WebSocketImpl) {
    fail('Global WebSocket is unavailable. Use Node 22 or newer.')
  }
  const ws = new WebSocketImpl(webSocketUrl)
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true })
    ws.addEventListener('error', reject, { once: true })
  })

  let nextId = 0
  const pending = new Map()
  ws.addEventListener('message', (event) => {
    const text = typeof event.data === 'string' ? event.data : event.data.toString()
    const message = JSON.parse(text)
    if (message.id === undefined) return
    const entry = pending.get(message.id)
    if (!entry) return
    pending.delete(message.id)
    entry.resolve(message)
  })
  ws.addEventListener('close', () => {
    const error = new Error('CDP WebSocket closed')
    for (const [, entry] of pending) {
      entry.reject(error)
    }
    pending.clear()
  })

  async function send(method, params = {}, sessionId = null) {
    const id = ++nextId
    const message = await new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject })
      ws.send(JSON.stringify(sessionId ? { id, method, params, sessionId } : { id, method, params }))
    })
    if (message.error) fail(`${method} failed: ${message.error.message}`)
    return message.result
  }

  return {
    send,
    close: () => ws.close()
  }
}

async function waitForPageTarget(connection, child) {
  const deadline = Date.now() + 30000
  let lastTargets = []
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      fail('App exited before CDP page target was available', {
        exitCode: child.exitCode,
        signal: child.signalCode
      })
    }
    const result = await connection.send('Target.getTargets')
    lastTargets = Array.isArray(result.targetInfos) ? result.targetInfos : []
    const page = lastTargets.find((target) => target.type === 'page' && target.targetId)
    if (page) return page
    await sleep(250)
  }
  fail('No CDP page target from browser protocol', {
    targets: lastTargets.map((target) => ({
      type: target.type,
      title: target.title,
      url: target.url
    }))
  })
}

async function createCdpClient(appLaunch) {
  const browserWebSocketUrl = await waitForBrowserWebSocket(appLaunch)
  const connection = await createCdpConnection(browserWebSocketUrl)
  const page = await waitForPageTarget(connection, appLaunch.child)
  const attach = await connection.send('Target.attachToTarget', {
    targetId: page.targetId,
    flatten: true
  })
  const sessionId = attach.sessionId
  await connection.send('Runtime.enable', {}, sessionId).catch(() => {})

  async function evaluate(expression) {
    const result = await connection.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true
    }, sessionId)
    if (result.exceptionDetails) {
      const detail = result.exceptionDetails.exception?.description || result.exceptionDetails.text || 'Evaluation failed'
      fail(detail)
    }
    return result.result?.value
  }

  return {
    evaluate,
    close: () => connection.close()
  }
}

async function createGitFixture(repoDir) {
  mkdirSync(repoDir, { recursive: true })
  writeFileSync(join(repoDir, 'tracked.txt'), 'initial\n')
  await execFileAsync('git', ['init'], { cwd: repoDir })
  await execFileAsync('git', ['config', 'user.email', 'autotest@example.invalid'], { cwd: repoDir })
  await execFileAsync('git', ['config', 'user.name', 'Onward Autotest'], { cwd: repoDir })
  await execFileAsync('git', ['add', 'tracked.txt'], { cwd: repoDir })
  await execFileAsync('git', ['commit', '-m', 'Initial fixture'], { cwd: repoDir })
}

function summarizeMirror(snapshot) {
  if (!snapshot || typeof snapshot !== 'object') return null
  return {
    cwd: snapshot.cwd ?? null,
    repoRoot: snapshot.repoRoot ?? null,
    repoName: snapshot.repoName ?? null,
    branch: snapshot.branch ?? null,
    status: snapshot.status ?? null,
    fileCount: Array.isArray(snapshot.files) ? snapshot.files.length : null,
    generation: snapshot.generation ?? null
  }
}

function mirrorSetupExpression(repoDir) {
  return `
    (async () => {
      const cwd = ${JSON.stringify(repoDir)};
      const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      const api = window.electronAPI?.git;
      if (!api?.subscribeMirror || !api?.getMirror || !api?.onMirrorUpdate) {
        throw new Error('GitStateMirror preload API is unavailable');
      }
      const state = { updates: [] };
      globalThis.__gsmQuitTest = state;
      state.unsubscribeUpdates = api.onMirrorUpdate((nextCwd, delta) => {
        if (nextCwd === cwd) state.updates.push({ delta, at: Date.now() });
      });
      state.unsubscribeMirror = () => api.unsubscribeMirror?.(cwd);
      const initial = await api.subscribeMirror(cwd);
      const startedAt = performance.now();
      let latest = initial;
      while (performance.now() - startedAt < 15000) {
        latest = await api.getMirror(cwd);
        if (latest?.repoRoot && Array.isArray(latest.files)) {
          return {
            ok: true,
            initial: ${'summarizeMirror'}(initial),
            latest: ${'summarizeMirror'}(latest),
            updateCount: state.updates.length
          };
        }
        await sleep(100);
      }
      return {
        ok: false,
        initial: ${'summarizeMirror'}(initial),
        latest: ${'summarizeMirror'}(latest),
        updateCount: state.updates.length
      };

      function summarizeMirror(snapshot) {
        if (!snapshot || typeof snapshot !== 'object') return null;
        return {
          cwd: snapshot.cwd ?? null,
          repoRoot: snapshot.repoRoot ?? null,
          repoName: snapshot.repoName ?? null,
          branch: snapshot.branch ?? null,
          status: snapshot.status ?? null,
          fileCount: Array.isArray(snapshot.files) ? snapshot.files.length : null,
          generation: snapshot.generation ?? null
        };
      }
    })()
  `
}

function waitForModifiedExpression(repoDir) {
  return `
    (async () => {
      const cwd = ${JSON.stringify(repoDir)};
      const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      const api = window.electronAPI?.git;
      if (!api?.getMirror) throw new Error('GitStateMirror getMirror API is unavailable');
      const startedAt = performance.now();
      let latest = null;
      while (performance.now() - startedAt < 15000) {
        latest = await api.getMirror(cwd);
        const files = Array.isArray(latest?.files) ? latest.files : [];
        const sawTrackedChange = files.some((file) => file?.filename === 'tracked.txt');
        if (latest?.status === 'modified' && sawTrackedChange) {
          return {
            ok: true,
            elapsedMs: Math.round(performance.now() - startedAt),
            latest: summarizeMirror(latest),
            updateCount: globalThis.__gsmQuitTest?.updates?.length ?? 0
          };
        }
        await sleep(100);
      }
      return {
        ok: false,
        elapsedMs: Math.round(performance.now() - startedAt),
        latest: summarizeMirror(latest),
        updateCount: globalThis.__gsmQuitTest?.updates?.length ?? 0
      };

      function summarizeMirror(snapshot) {
        if (!snapshot || typeof snapshot !== 'object') return null;
        return {
          cwd: snapshot.cwd ?? null,
          repoRoot: snapshot.repoRoot ?? null,
          repoName: snapshot.repoName ?? null,
          branch: snapshot.branch ?? null,
          status: snapshot.status ?? null,
          fileCount: Array.isArray(snapshot.files) ? snapshot.files.length : null,
          generation: snapshot.generation ?? null
        };
      }
    })()
  `
}

async function waitForApiLock(userDataDir) {
  const lockPath = join(userDataDir, 'onward-api.lock')
  const deadline = Date.now() + 30000
  let lastError = null
  while (Date.now() < deadline) {
    try {
      if (existsSync(lockPath)) {
        const parsed = JSON.parse(readFileSync(lockPath, 'utf8'))
        if (Number.isInteger(parsed.port) && parsed.port > 0) return parsed
      }
    } catch (error) {
      lastError = error
    }
    await sleep(250)
  }
  fail('API lock file was not written', { lockPath, lastError: String(lastError) })
}

async function requestGracefulQuit(userDataDir) {
  const lock = await waitForApiLock(userDataDir)
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 5000)
  try {
    const response = await fetch(`http://127.0.0.1:${lock.port}/api/debug/app/quit`, {
      method: 'POST',
      signal: controller.signal
    })
    const body = await response.text().catch(() => '')
    return { ok: response.ok, status: response.status, body }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  } finally {
    clearTimeout(timer)
  }
}

function waitForExit(child, timeoutMs) {
  return new Promise((resolve, reject) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve({ code: child.exitCode, signal: child.signalCode })
      return
    }
    const timer = setTimeout(() => {
      reject(new Error(`App did not exit within ${timeoutMs}ms`))
    }, timeoutMs)
    child.once('exit', (code, signal) => {
      clearTimeout(timer)
      resolve({ code, signal })
    })
    child.once('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
  })
}

function launchApp({ port, userDataDir, stream, trial }) {
  let resolveBrowserWebSocket
  let rejectBrowserWebSocket
  let browserWebSocketSettled = false
  let devToolsBuffer = ''
  let captured = ''
  const browserWebSocketPromise = new Promise((resolve, reject) => {
    resolveBrowserWebSocket = resolve
    rejectBrowserWebSocket = reject
  })
  const noteChunk = (label, chunk) => {
    const text = chunk.toString()
    captured += text
    appendLog(stream, `[trial ${trial} ${label}] ${text.replace(/\n$/, '')}`)
    if (browserWebSocketSettled) return
    devToolsBuffer += text
    const match = /DevTools listening on (ws:\/\/[^\s]+)/.exec(devToolsBuffer)
    if (!match) return
    browserWebSocketSettled = true
    resolveBrowserWebSocket(match[1])
  }
  const env = {
    ...process.env,
    ONWARD_DEBUG: '1',
    ONWARD_REPO_ROOT: REPO_ROOT,
    ONWARD_USER_DATA_DIR: userDataDir,
    ONWARD_AUTOTEST_SKIP_CONSENT: '1'
  }
  const child = spawn(APP_BIN, [`--remote-debugging-port=${port}`], {
    env,
    stdio: ['ignore', 'pipe', 'pipe']
  })
  child.stdout?.on('data', (chunk) => noteChunk('stdout', chunk))
  child.stderr?.on('data', (chunk) => noteChunk('stderr', chunk))
  child.once('exit', (code, signal) => {
    if (browserWebSocketSettled) return
    browserWebSocketSettled = true
    rejectBrowserWebSocket(new Error(`App exited before DevTools WebSocket announcement (code=${code}, signal=${signal})`))
  })
  return { child, browserWebSocketPromise, getCapturedLog: () => captured }
}

// Abort-class tokens that prove a native @parcel/watcher worker-teardown crash.
// CROSS-PLATFORM contract: the PRIMARY gate is the clean exit below
// (exit.code===0 && exit.signal===null) — that is the platform-neutral "did not
// crash" proof (Windows reports no POSIX signal; a crash is a non-zero code).
// This token scan is the ENRICHMENT that also catches an abort that still exits
// 0: most tokens are V8 / N-API / Node fatal messages emitted on ALL platforms;
// SIGABRT / abort() are the POSIX (macOS/Linux) signature; the access-violation
// tokens are the Windows native-crash signature.
const ABORT_TOKENS = [
  // V8 / N-API / Node fatal — all platforms.
  'napi_fatal_error', 'FATAL ERROR', 'Assertion failed', 'node::OnFatalError',
  // POSIX (macOS / Linux).
  'SIGABRT', 'abort()',
  // Windows native crash.
  'Access violation', '0xC0000005', 'STATUS_ACCESS_VIOLATION'
]

async function runTrial(trial, stream) {
  const port = await getFreePort()
  const userDataDir = join(USER_DATA_BASE, `trial-${trial}-userdata`)
  const repoDir = join(FIXTURE_BASE, `trial-${trial}-repo`)
  mkdirSync(userDataDir, { recursive: true })
  await createGitFixture(repoDir)

  appendLog(stream, `=== GSM quit trial ${trial}/${TRIALS} ===`)
  appendLog(stream, `repo=${repoDir}`)
  appendLog(stream, `userData=${userDataDir}`)
  appendLog(stream, `cdpPort=${port}`)

  const appLaunch = launchApp({ port, userDataDir, stream, trial })
  const { child } = appLaunch
  let cdp = null
  // Hoisted so the finally can always stop the churn loop, even when
  // requestGracefulQuit / waitForExit throw before the success-path stop runs.
  let churning = false
  let churnLoop = null
  const startedAt = Date.now()
  const detail = {
    trial,
    port,
    repoDir,
    userDataDir,
    pid: child.pid,
    mirrorSetup: null,
    watcherMutation: null,
    quitRequest: null,
    exit: null
  }

  try {
    cdp = await createCdpClient(appLaunch)
    detail.mirrorSetup = await cdp.evaluate(mirrorSetupExpression(repoDir))
    if (!detail.mirrorSetup?.ok) {
      fail('Mirror did not publish an initial repo snapshot', detail.mirrorSetup)
    }
    appendLog(stream, `GSMQ-01-active-subscription trial=${trial} ok`)

    writeFileSync(join(repoDir, 'tracked.txt'), `trial ${trial} modified ${Date.now()}\n`)
    detail.watcherMutation = await cdp.evaluate(waitForModifiedExpression(repoDir))
    if (!detail.watcherMutation?.ok) {
      fail('Mirror did not observe the tracked-file mutation before quit', detail.watcherMutation)
    }
    appendLog(stream, `GSMQ-02-watcher-mutation-observed trial=${trial} ok`)

    // GSMQ-04: sustained FS churn THROUGH teardown. Unlike the old single
    // queued-file + sleep(50), this keeps native @parcel/watcher callbacks
    // continuously in-flight at the exact instant of quit (no pre-quit settle),
    // reproducing the teardown race that produced the SIGABRT. The churn loop
    // runs until the app process has fully exited, so the worker's quiesce
    // barrier is exercised against live event delivery + pending unsubscribes.
    churning = true
    churnLoop = (async () => {
      let writes = 0
      while (churning) {
        const file = join(repoDir, `churn-${writes % 8}.txt`)
        try {
          writeFileSync(file, `churn ${writes} ${Date.now()}\n`)
          if (writes % 3 === 0 && existsSync(file)) rmSync(file, { force: true })
          writes += 1
        } catch { /* repo dir may be removed during cleanup — ignore */ }
        await sleep(4)
      }
      return writes
    })()

    detail.quitRequest = await requestGracefulQuit(userDataDir)
    detail.exit = await waitForExit(child, 20000)
    churning = false
    detail.churnWrites = await churnLoop.catch(() => 0)
    detail.elapsedMs = Date.now() - startedAt

    // Fix-verification: clean process exit AND no abort-class token in THIS
    // trial's app stdout/stderr AND the cooperative drain was taken (the worker
    // reached clean-exit / emitted its quiesce breadcrumb, not a forced kill).
    const appLog = appLaunch.getCapturedLog()
    const abortToken = ABORT_TOKENS.find((token) => appLog.includes(token)) ?? null
    const cleanExit = detail.exit.code === 0 && detail.exit.signal === null
    const drainedCooperatively =
      appLog.includes('shutdown-quiesced') ||
      appLog.includes('worker EXITED') && appLog.includes('code: 0')
    detail.abortToken = abortToken
    detail.cleanExit = cleanExit
    detail.drainedCooperatively = drainedCooperatively
    // GSMQ-04 exists to prove the COOPERATIVE quiesce path was taken, so a clean
    // exit alone is not enough: a forced terminate that still exits 0 must NOT
    // silently pass. Gate on the cooperative-drain breadcrumb too.
    detail.ok = cleanExit && abortToken === null && drainedCooperatively
    appendLog(
      stream,
      `GSMQ-04-sustained-churn-clean-exit trial=${trial} ok=${detail.ok} ` +
      `exit=${JSON.stringify(detail.exit)} churnWrites=${detail.churnWrites} ` +
      `abortToken=${abortToken ?? 'none'} cooperativeDrain=${drainedCooperatively}`
    )
    return detail
  } catch (error) {
    detail.error = serializeError(error)
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM')
      try {
        await waitForExit(child, 3000)
      } catch {
        child.kill('SIGKILL')
      }
    }
    detail.exit = { code: child.exitCode, signal: child.signalCode }
    detail.elapsedMs = Date.now() - startedAt
    detail.ok = false
    return detail
  } finally {
    // Always stop + drain the churn loop, even when the success-path stop was
    // skipped by a throw — otherwise it spins (writing every 4 ms) forever and
    // keeps the Node autotest process alive past the failing trial.
    churning = false
    if (churnLoop) {
      try { await churnLoop } catch { /* ignore */ }
    }
    try { cdp?.close() } catch { /* ignore */ }
    // Defence-in-depth: release the child's stdio handles so they cannot keep
    // Node's event loop referenced after the app has exited (Windows hang class
    // — a lingering pipe handle blocks process teardown on the success path).
    try { child.stdout?.destroy(); child.stderr?.destroy(); child.unref() } catch { /* ignore */ }
  }
}

async function main() {
  if (!APP_BIN) fail('APP_BIN is required')
  if (!APP_NAME) fail('APP_NAME is required')
  if (!USER_DATA_BASE) fail('USER_DATA_BASE is required')
  if (!FIXTURE_BASE) fail('FIXTURE_BASE is required')

  mkdirSync(join(REPO_ROOT, 'traces/test-logs'), { recursive: true })
  mkdirSync(join(REPO_ROOT, 'traces/analysis'), { recursive: true })
  const stream = createWriteStream(LOG_FILE, { flags: 'a' })
  const trials = []
  try {
    appendLog(stream, `GitStateMirror quit autotest started at ${new Date().toISOString()}`)
    appendLog(stream, `app=${APP_NAME}`)
    appendLog(stream, `bin=${APP_BIN}`)
    for (let trial = 1; trial <= TRIALS; trial += 1) {
      const result = await runTrial(trial, stream)
      trials.push(result)
      appendLog(stream, `trial ${trial} result: ${JSON.stringify({
        ok: result.ok,
        exit: result.exit,
        elapsedMs: result.elapsedMs,
        error: result.error?.message ?? null
      })}`)
    }
  } finally {
    await new Promise((resolve) => stream.end(resolve))
  }

  const failures = trials.filter((trial) => !trial.ok)
  const result = {
    ok: failures.length === 0,
    appName: APP_NAME,
    trials,
    failures
  }
  writeFileSync(RESULT_FILE, JSON.stringify(result, null, 2))
  if (!result.ok) {
    process.exit(1)
  }
  // Exit deterministically on the success path too. On Windows a lingering
  // Electron stdio handle can keep Node's event loop referenced, hanging the
  // driver until the orchestrator's tree-kill. An explicit exit guarantees the
  // process tears down the instant the verdict is written.
  process.exit(result.ok ? 0 : 1)
}

main().catch((error) => {
  mkdirSync(join(REPO_ROOT, 'traces/analysis'), { recursive: true })
  writeFileSync(RESULT_FILE, JSON.stringify({ ok: false, error: serializeError(error) }, null, 2))
  console.error(error)
  process.exit(1)
})
