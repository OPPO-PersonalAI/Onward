/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 *
 * Subpage outline CPU gate (SOC-*): locks the fix for the 2026-07 subpage
 * enter/exit CPU storm. A ~47k-element HTML file must (a) get its outline
 * capped at OUTLINE_SYMBOL_CAP with a visible truncation hint, (b) render a
 * bounded number of outline DOM rows (windowed), and (c) leave the renderer
 * CPU quiet within 5s of exiting the editor / git diff subpages
 * (avg <= 15% over the window, N=3 cycles, pass if >=1 cycle meets budget —
 * transient host spikes are tolerated, systematic storms are not).
 *
 * CPU is measured as cumulative-cpu-time deltas over the window (not ps %cpu,
 * which is a decaying average), scoped to this launch's process tree.
 */

import { execFile } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const CDP_PORT = Number(process.env.CDP_PORT || '9343')
const APP_NAME = process.env.APP_NAME || ''
const APP_MAIN_PID = Number(process.env.APP_MAIN_PID || '0')
const RESULT_PATH = process.env.RESULT_PATH || 'traces/analysis/subpage-outline-cpu-autotest.json'

// Product decisions (user-confirmed 2026-07-19): outline cap 5000; renderer
// CPU must average <= 15% of one core within the 5s window after subpage exit.
const OUTLINE_CAP = 5000
const EXIT_CPU_WINDOW_MS = 5000
const EXIT_CPU_AVG_LIMIT_PCT = 15
const EXIT_CPU_TRIALS = 3
// Windowed rendering bound: viewport rows + 2x overscan + slack. A full
// 40k-row DOM materialisation fails this by orders of magnitude.
const OUTLINE_DOM_ROW_LIMIT = 120

const results = []
function record(name, ok, detail = {}) {
  results.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name} ${JSON.stringify(detail)}`)
}

// ---------------- CPU snapshots (cputime deltas, cross-platform) ----------------

function executableNames() {
  if (!APP_NAME) return []
  return [
    APP_NAME,
    `${APP_NAME} Helper`,
    `${APP_NAME} Helper (Renderer)`,
    `${APP_NAME} Helper (GPU)`,
    `${APP_NAME} Helper (Plugin)`
  ].sort((a, b) => b.length - a.length)
}

function executableNameForCommand(command) {
  for (const name of executableNames()) {
    const marker = `/Contents/MacOS/${name}`
    const index = command.indexOf(marker)
    if (index >= 0) {
      const next = command[index + marker.length]
      if (next === undefined || /\s/.test(next)) return name
    }
    if (process.platform === 'linux' && command.includes(name)) return name
  }
  return null
}

function parseCpuTime(text) {
  const match = text.trim().match(/^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+(?:\.\d+)?)$/)
  if (!match) return 0
  const days = Number(match[1] || 0)
  const hours = Number(match[2] || 0)
  return ((days * 24 + hours) * 60 + Number(match[3])) * 60 + Number(match[4])
}

async function collectPosixSnapshot() {
  const { stdout } = await execFileAsync('ps', ['-axo', 'pid=,ppid=,cputime=,command='], { maxBuffer: 8 * 1024 * 1024 })
  const rows = []
  for (const line of stdout.split('\n')) {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.+)$/)
    if (!match) continue
    const command = match[4]
    const executableName = executableNameForCommand(command)
    if (!executableName) continue
    const isRenderer = /--type=renderer/.test(command)
    rows.push({ pid: Number(match[1]), ppid: Number(match[2]), cpuSec: parseCpuTime(match[3]), isRenderer })
  }
  return rows
}

async function collectWindowsSnapshot() {
  const command = [
    '$ErrorActionPreference = "Stop";',
    '$appName = $env:APP_NAME;',
    'if (-not $appName) { "[]" ; exit 0 }',
    '$exactNames = @($appName, "$appName Helper", "$appName Helper (Renderer)", "$appName Helper (GPU)", "$appName Helper (Plugin)")',
    '| ForEach-Object { "$_.exe" };',
    '$rows = Get-CimInstance Win32_Process | Where-Object { $exactNames -contains $_.Name } | ForEach-Object {',
    '  [pscustomobject]@{',
    '    pid = [int]$_.ProcessId;',
    '    ppid = [int]$_.ParentProcessId;',
    '    cpuSec = ([double]$_.KernelModeTime + [double]$_.UserModeTime) / 10000000;',
    '    isRenderer = ([string]$_.CommandLine) -match "--type=renderer"',
    '  }',
    '} | ConvertTo-Json -Compress;',
    'if ($rows) { $rows } else { "[]" }'
  ].join(' ')
  const { stdout } = await execFileAsync('powershell.exe', ['-NoProfile', '-Command', command], { maxBuffer: 8 * 1024 * 1024 })
  const raw = stdout.trim() ? JSON.parse(stdout) : []
  return Array.isArray(raw) ? raw : [raw]
}

function scopeToAppTree(rows) {
  if (!APP_MAIN_PID) return rows
  const byPid = new Map(rows.map((row) => [row.pid, row]))
  return rows.filter((row) => {
    let current = row
    const seen = new Set()
    while (current) {
      if (current.pid === APP_MAIN_PID) return true
      if (!current.ppid || seen.has(current.ppid)) return false
      seen.add(current.ppid)
      current = byPid.get(current.ppid)
    }
    return false
  })
}

async function cpuSnapshot() {
  const rows = process.platform === 'win32' ? await collectWindowsSnapshot() : await collectPosixSnapshot()
  return scopeToAppTree(rows)
}

/** Average CPU (percent of one core) over a wall-clock window, per kind. */
async function measureCpuWindow(windowMs) {
  const startAt = Date.now()
  const before = await cpuSnapshot()
  await sleep(windowMs)
  const after = await cpuSnapshot()
  const wallSec = (Date.now() - startAt) / 1000
  const beforeByPid = new Map(before.map((row) => [row.pid, row]))
  let rendererPct = 0
  let totalPct = 0
  for (const row of after) {
    const prev = beforeByPid.get(row.pid)
    if (!prev) continue
    const pct = Math.max(0, (row.cpuSec - prev.cpuSec) / wallSec * 100)
    totalPct += pct
    if (row.isRenderer) rendererPct += pct
  }
  return { rendererPct: Number(rendererPct.toFixed(1)), totalPct: Number(totalPct.toFixed(1)), wallSec }
}

// ---------------- CDP ----------------

async function fetchJson(url, timeoutMs = 3000) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(url, { signal: controller.signal })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    return await response.json()
  } finally {
    clearTimeout(timer)
  }
}

async function createCdp() {
  const deadline = Date.now() + 90000
  let page = null
  while (Date.now() < deadline && !page) {
    try {
      const targets = await fetchJson(`http://127.0.0.1:${CDP_PORT}/json`)
      page = targets.find((target) => target.type === 'page' && target.webSocketDebuggerUrl) || null
    } catch { /* app still booting */ }
    if (!page) await sleep(500)
  }
  if (!page) throw new Error(`no CDP page target on port ${CDP_PORT}`)
  const ws = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((resolveOpen, rejectOpen) => {
    ws.addEventListener('open', resolveOpen, { once: true })
    ws.addEventListener('error', rejectOpen, { once: true })
  })
  let nextId = 0
  const pending = new Map()
  ws.addEventListener('message', (event) => {
    const message = JSON.parse(typeof event.data === 'string' ? event.data : event.data.toString())
    if (message.id === undefined) return
    const entry = pending.get(message.id)
    if (entry) { pending.delete(message.id); entry(message) }
  })
  const send = (method, params = {}) => new Promise((resolveSend, rejectSend) => {
    const id = ++nextId
    pending.set(id, (message) => message.error
      ? rejectSend(new Error(`${method}: ${message.error.message}`))
      : resolveSend(message.result))
    ws.send(JSON.stringify({ id, method, params }))
  })
  const evaluate = async (expression) => {
    const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.exception?.description || 'evaluation failed')
    }
    return result.result?.value
  }
  return { send, evaluate, close: () => ws.close() }
}

async function waitEval(cdp, expression, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs
  let last = null
  while (Date.now() < deadline) {
    try {
      last = await cdp.evaluate(expression)
      if (last) return last
    } catch (error) { last = String(error) }
    await sleep(200)
  }
  throw new Error(`timeout: ${label} (last=${JSON.stringify(last)})`)
}

async function pressEscape(cdp) {
  await cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 })
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 })
}

async function closeSubpage(cdp, isClosedExpr, label) {
  await pressEscape(cdp)
  try {
    await waitEval(cdp, isClosedExpr, 10000, `${label} closed via ESC`)
  } catch {
    // ESC can be swallowed by an inner focus target; the debug close is the
    // fallback so the CPU gate still measures the same post-exit state.
    await cdp.evaluate(`window.__onwardTerminalDebug.closeAllSubpages()`)
    await waitEval(cdp, isClosedExpr, 10000, `${label} closed via fallback`)
  }
}

// ---------------- main ----------------

async function main() {
  const cdp = await createCdp()
  const summary = { startedAt: new Date().toISOString(), appName: APP_NAME }

  try {
    await waitEval(cdp, `Boolean(window.__onwardProjectEditorDebug?.isOpen?.())`, 90000, 'editor auto-open')
    const terminalId = await waitEval(
      cdp,
      `window.__onwardTerminalDebug?.getActiveTerminalId?.() ?? window.__onwardTerminalDebug?.getTerminalIds?.()[0] ?? null`,
      20000,
      'terminal id'
    )

    // SOC-01: cold-open the huge HTML and wait for the (capped) outline.
    await cdp.evaluate(`window.__onwardProjectEditorDebug.openFileByPathAsUser('big.html', { trackRecent: true })`)
    await waitEval(cdp, `(window.__onwardProjectEditorDebug?.getActiveFilePath?.() ?? '').endsWith('big.html')`, 30000, 'big.html active')
    await waitEval(cdp, `(window.__onwardProjectEditorDebug?.getOutlineSymbolCount?.() ?? 0) > 0`, 60000, 'outline parsed')
    await sleep(2000)
    const symbolCount = await cdp.evaluate(`window.__onwardProjectEditorDebug.getOutlineSymbolCount()`)
    record('SOC-01-huge-html-outline-parsed', symbolCount > 0, { symbolCount })

    // SOC-02: parse-time cap holds.
    record('SOC-02-outline-symbols-capped', symbolCount > 0 && symbolCount <= OUTLINE_CAP, { symbolCount, cap: OUTLINE_CAP })

    // SOC-03: truncation hint is visible in the header.
    const truncationHint = await cdp.evaluate(`(() => {
      const hint = document.querySelector('.outline-panel-truncated')
      return hint ? hint.textContent : null
    })()`)
    record('SOC-03-truncation-hint-visible', typeof truncationHint === 'string' && truncationHint.length > 0, { truncationHint })

    // SOC-04: outline DOM is windowed, not fully materialised.
    const outlineDomRows = await cdp.evaluate(`document.querySelectorAll('.outline-panel-item').length`)
    record('SOC-04-outline-dom-windowed', outlineDomRows > 0 && outlineDomRows <= OUTLINE_DOM_ROW_LIMIT, { outlineDomRows, limit: OUTLINE_DOM_ROW_LIMIT })

    // Leave the editor so every gated cycle starts from the terminal.
    await closeSubpage(cdp, `!window.__onwardProjectEditorDebug?.isOpen?.()`, 'editor initial')
    await sleep(2000)

    // SOC-05: editor enter/exit CPU decay, N=3, pass if >=1 window meets budget.
    const editorWindows = []
    for (let trial = 1; trial <= EXIT_CPU_TRIALS; trial += 1) {
      await cdp.evaluate(`window.dispatchEvent(new CustomEvent('project-editor:open', { detail: { terminalId: ${JSON.stringify(terminalId)} } }))`)
      await waitEval(cdp, `Boolean(window.__onwardProjectEditorDebug?.isOpen?.())`, 20000, `editor reopen #${trial}`)
      await sleep(3000)
      await closeSubpage(cdp, `!window.__onwardProjectEditorDebug?.isOpen?.()`, `editor #${trial}`)
      const cpuWindow = await measureCpuWindow(EXIT_CPU_WINDOW_MS)
      editorWindows.push(cpuWindow)
      console.log(`[cpu] editor exit #${trial}: renderer ${cpuWindow.rendererPct}% total ${cpuWindow.totalPct}%`)
    }
    const editorBest = Math.min(...editorWindows.map((cpuWindow) => cpuWindow.rendererPct))
    record('SOC-05-editor-exit-cpu-decay', editorBest <= EXIT_CPU_AVG_LIMIT_PCT, {
      limitPct: EXIT_CPU_AVG_LIMIT_PCT,
      bestPct: editorBest,
      windows: editorWindows
    })

    // SOC-06: git-diff enter/exit CPU decay, same aggregation.
    const diffWindows = []
    for (let trial = 1; trial <= EXIT_CPU_TRIALS; trial += 1) {
      await cdp.evaluate(`window.dispatchEvent(new CustomEvent('git-diff:open', { detail: { terminalId: ${JSON.stringify(terminalId)} } }))`)
      await waitEval(cdp, `Boolean(window.__onwardGitDiffDebug?.isOpen?.())`, 30000, `git-diff open #${trial}`)
      await sleep(3000)
      await closeSubpage(cdp, `!window.__onwardGitDiffDebug?.isOpen?.()`, `git-diff #${trial}`)
      const cpuWindow = await measureCpuWindow(EXIT_CPU_WINDOW_MS)
      diffWindows.push(cpuWindow)
      console.log(`[cpu] git-diff exit #${trial}: renderer ${cpuWindow.rendererPct}% total ${cpuWindow.totalPct}%`)
    }
    const diffBest = Math.min(...diffWindows.map((cpuWindow) => cpuWindow.rendererPct))
    record('SOC-06-git-diff-exit-cpu-decay', diffBest <= EXIT_CPU_AVG_LIMIT_PCT, {
      limitPct: EXIT_CPU_AVG_LIMIT_PCT,
      bestPct: diffBest,
      windows: diffWindows
    })

    // SOC-07: warm reopen still restores the huge file with a capped outline
    // (locks the retained-view + cap interaction).
    await cdp.evaluate(`window.dispatchEvent(new CustomEvent('project-editor:open', { detail: { terminalId: ${JSON.stringify(terminalId)} } }))`)
    await waitEval(cdp, `Boolean(window.__onwardProjectEditorDebug?.isOpen?.())`, 20000, 'editor warm reopen')
    await waitEval(cdp, `(window.__onwardProjectEditorDebug?.getOutlineSymbolCount?.() ?? 0) > 0`, 30000, 'warm outline present')
    const warmCount = await cdp.evaluate(`window.__onwardProjectEditorDebug.getOutlineSymbolCount()`)
    record('SOC-07-warm-reopen-outline-capped', warmCount > 0 && warmCount <= OUTLINE_CAP, { warmCount, cap: OUTLINE_CAP })
  } catch (error) {
    record('SOC-XX-driver-flow', false, { error: String(error?.message || error) })
  } finally {
    summary.finishedAt = new Date().toISOString()
    summary.results = results
    summary.ok = results.length > 0 && results.every((entry) => entry.ok)
    mkdirSync(dirname(RESULT_PATH), { recursive: true })
    writeFileSync(RESULT_PATH, `${JSON.stringify(summary, null, 2)}\n`)
    cdp.close()
  }

  console.log(`[SubpageOutlineCpu:RESULT] ${JSON.stringify({ ok: summary.ok, pass: results.filter((entry) => entry.ok).length, fail: results.filter((entry) => !entry.ok).length })}`)
  if (!summary.ok) process.exit(1)
}

main().catch((error) => {
  console.error(error?.stack || String(error))
  process.exit(1)
})
