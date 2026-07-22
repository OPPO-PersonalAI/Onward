/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 *
 * ConPTY / PTY-level wiring test for shell-integration cwd OSC emission.
 *
 * Bugs this locks:
 *   1. (historic) pwsh.ps1 assigned to the read-only `$host` automatic
 *      variable, which made the prompt function throw and PowerShell fall
 *      back to the bare `PS>` prompt — zero cwd OSC ever reached the
 *      renderer.
 *   2. (RC-1, 2026-07 bundles) the pwsh.ps1 DOT-SOURCE was blocked outright
 *      by script execution policy on locked-down machines (PSSecurityException
 *      / UnauthorizedAccess), killing cwd tracking for the whole session.
 *      The fix passes the prompt wrapper INLINE via `-Command`, which no
 *      file-execution gate applies to. The Windows matrix here therefore
 *      runs TWICE: default policy AND PSExecutionPolicyPreference=Restricted
 *      — the Restricted pass proves the policy immunity.
 *   3. (RC-3) the verified "change working directory" command must emit its
 *      own OSC 633 proof even with no integration prompt installed.
 *
 * The launch args are NOT hand-copied: the inline payload and the verified
 * cd command are extracted from the REAL production modules
 * (electron/main/powershell-inline-integration.ts, src/utils/terminal-command.ts)
 * via a `--experimental-strip-types` child, so a content regression there is
 * caught here without parity drift.
 *
 * Run under Electron's ABI so node-pty's native binary matches:
 *   ELECTRON_RUN_AS_NODE=1 <electron> test/autotest/test-shell-integration-cwd.mjs
 *
 * Timing-sensitive (CLAUDE.md): correctness is boolean ("does the cwd OSC
 * follow the cd?"), so we run N distinct cd trials and require ALL N to be
 * detected. One miss means the emission path has a real hole.
 */

import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, join, resolve } from 'node:path'
import { mkdtempSync, mkdirSync, rmSync, existsSync } from 'node:fs'
import { tmpdir, homedir } from 'node:os'
import { execFileSync } from 'node:child_process'

const require = createRequire(import.meta.url)
const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(__dirname, '..', '..')
const INTEGRATION_DIR = join(REPO_ROOT, 'resources', 'shell-integration')
const IS_WINDOWS = process.platform === 'win32'
const TRIALS = 5

let pty
try {
  pty = require('node-pty')
} catch (err) {
  console.error('[AutoTest] FAIL: cannot load node-pty (run under Electron ABI):', String(err))
  process.exit(1)
}

// node-pty 1.1.0 forks conpty_console_list_agent.js during teardown on Windows;
// when the console session is already gone AttachConsole throws ECONNRESET. The
// app suppresses this in electron/main/index.ts — mirror that here so a clean
// run does not exit non-zero on a teardown race.
process.on('uncaughtException', (error) => {
  const code = (error && error.code) || ''
  if (code === 'ECONNRESET' || /AttachConsole/.test(String(error))) return
  console.error('[AutoTest] FAIL: uncaughtException:', error)
  process.exit(1)
})

function log(msg) { console.log(msg) }

/**
 * Evaluate a snippet against the PRODUCTION TS modules via a strip-types
 * child (works under plain node and ELECTRON_RUN_AS_NODE alike; both are
 * Node ≥ 22.6). stdout carries the single ONWARD_EVAL result line.
 */
function evalFromProductionTs(script) {
  const out = execFileSync(process.execPath, ['--experimental-strip-types', '--input-type=module', '-e', script], {
    timeout: 30000,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', NODE_OPTIONS: '' },
    stdio: ['ignore', 'pipe', 'pipe']
  }).toString()
  const lines = out.split(/\r?\n/).filter((l) => l.startsWith('ONWARD_EVAL:'))
  if (lines.length !== 1) {
    throw new Error(`strip-types eval produced ${lines.length} result lines; raw: ${out.slice(0, 400)}`)
  }
  return JSON.parse(lines[0].slice('ONWARD_EVAL:'.length))
}

function getInlinePsPayload() {
  const mod = pathToFileURL(join(REPO_ROOT, 'electron', 'main', 'powershell-inline-integration.ts')).href
  return evalFromProductionTs(
    `import { buildPowerShellInlineIntegrationCommand } from '${mod.replace(/'/g, "\\'")}';` +
    `console.log('ONWARD_EVAL:' + JSON.stringify(buildPowerShellInlineIntegrationCommand()))`
  )
}

function getVerifiedCdCommand(platform, directory, shellKind) {
  const mod = pathToFileURL(join(REPO_ROOT, 'src', 'utils', 'terminal-command.ts')).href
  return evalFromProductionTs(
    `import { buildVerifiedChangeDirectoryCommand } from '${mod.replace(/'/g, "\\'")}';` +
    `console.log('ONWARD_EVAL:' + JSON.stringify(buildVerifiedChangeDirectoryCommand(` +
    `${JSON.stringify(platform)}, ${JSON.stringify(directory)}, ${JSON.stringify(shellKind)})))`
  )
}

// Mirror PtyManager.resolveWindowsShell(): prefer pwsh.exe, then powershell.exe.
function resolveWindowsShell() {
  for (const candidate of ['pwsh.exe', 'powershell.exe']) {
    try {
      const out = execFileSync('where', [candidate], { stdio: ['ignore', 'pipe', 'ignore'], timeout: 3000 })
        .toString().trim().split(/\r?\n/)[0]
      if (out) return out
    } catch { /* keep trying */ }
  }
  return process.env.COMSPEC || 'cmd.exe'
}

// Build (shell, args, env) mirroring electron/main/pty-manager.ts. PowerShell
// uses the REAL inline -Command payload extracted from the production module
// (RC-1 fix — the old dot-source form is exactly what policy blocked).
function buildLaunch(extraEnv = {}) {
  const env = { ...process.env, ONWARD_SHELL_INTEGRATION: '1', ...extraEnv }
  if (IS_WINDOWS) {
    const shell = resolveWindowsShell()
    const lower = shell.toLowerCase()
    if (lower.includes('powershell') || lower.includes('pwsh')) {
      return { shell, args: ['-NoLogo', '-NoExit', '-Command', getInlinePsPayload()], env, kind: 'powershell' }
    }
    // cmd.exe: OSC 9;9 via the PROMPT env var (mirrors create()).
    env.PROMPT = '$e]9;9;$P$e\\$P$G'
    return { shell, args: [], env, kind: 'cmd' }
  }
  const sh = process.env.SHELL || '/bin/bash'
  const base = sh.split('/').pop()
  if (base === 'zsh') {
    return { shell: sh, args: ['-i'], env: { ...env, ZDOTDIR: join(INTEGRATION_DIR, 'zsh-zdotdir'), HISTFILE: '/dev/null' }, kind: 'zsh' }
  }
  // bash (and unknown POSIX shells fall back to bash): source the real bash.sh
  // as the rcfile so PROMPT_COMMAND emits OSC 633 + OSC 7.
  const bashRc = join(INTEGRATION_DIR, 'bash.sh')
  return { shell: '/bin/bash', args: ['--rcfile', bashRc, '-i'], env, kind: 'bash' }
}

// Normalize a filesystem path for comparison: lowercase, backslash -> slash,
// percent-decode, strip a single trailing slash. Matches how the renderer's
// normalizeTerminalGitPath collapses Windows/POSIX forms.
function norm(p) {
  let s = p.trim()
  try { s = decodeURIComponent(s) } catch { /* keep raw */ }
  s = s.replace(/\\/g, '/').replace(/\/{2,}/g, '/').toLowerCase()
  if (s.length > 3 && s.endsWith('/')) s = s.slice(0, -1)
  return s
}

// Extract every cwd path carried by a cwd-bearing OSC in the buffer. We parse
// the OSC payloads specifically so the typed `cd <path>` echo (which also
// contains the path) cannot create a false positive.
function extractOscCwds(buf) {
  const out = []
  const re633 = /\x1b\]633;P;Cwd=([^\x07\x1b]*)/g
  const re7 = /\x1b\]7;file:\/\/[^/]*\/([^\x1b\x07]*)/g
  const re99 = /\x1b\]9;9;([^\x07\x1b]*)/g
  let m
  while ((m = re633.exec(buf))) out.push(norm(m[1]))
  while ((m = re7.exec(buf))) out.push(norm('/' + m[1].replace(/^\//, '')))
  while ((m = re99.exec(buf))) out.push(norm(m[1]))
  return out
}

const delay = (ms) => new Promise((r) => setTimeout(r, ms))

// Any cwd-bearing OSC introducer — used to detect that the integration's
// first prompt has rendered before we start driving cd commands.
const FIRST_OSC_RE = /\x1b\](?:633;P;Cwd=|9;9;|7;file:\/\/)/

/**
 * Drive one PTY session: cd through `targets` with plain cd commands, then
 * (when provided) run the verified-cd command. Returns the raw output buffer.
 */
async function driveSession(launch, targets, verifiedCommand) {
  let term
  let buf = ''
  try {
    term = pty.spawn(launch.shell, launch.args, {
      name: 'xterm-256color',
      cols: 120,
      rows: 30,
      cwd: existsSync(REPO_ROOT) ? REPO_ROOT : homedir(),
      env: launch.env
    })
    term.onData((d) => { buf += d })

    // Adaptive startup wait (flake hardening): instead of a blind sleep,
    // wait until the integration's FIRST prompt has actually emitted a cwd
    // OSC (bounded at 15 s — mirrors the app's liveness window), then give
    // the prompt a short settle. A cold ConPTY + EDR-taxed PowerShell start
    // can exceed any fixed guess under parallel machine load; driving cd
    // before the first prompt races the shell and loses trials.
    const startupDeadline = Date.now() + 15_000
    while (!FIRST_OSC_RE.test(buf) && Date.now() < startupDeadline) {
      await delay(200)
    }
    if (!FIRST_OSC_RE.test(buf)) {
      log('[AutoTest] WARN first prompt OSC not seen within 15s — proceeding (assertions will tell)')
    }
    await delay(IS_WINDOWS ? 800 : 400)

    for (const target of targets) {
      term.write(`cd "${target}"\r`)
      await delay(IS_WINDOWS ? 1600 : 900)
    }
    if (verifiedCommand) {
      term.write(verifiedCommand)
      await delay(IS_WINDOWS ? 1600 : 900)
    }
    // Final settle so the last prompt's OSC lands in the buffer.
    await delay(1200)
  } finally {
    try { term && term.kill() } catch { /* ignore */ }
  }
  return buf
}

function assertTargetsDetected(buf, targets, idPrefix) {
  const detected = new Set(extractOscCwds(buf))
  let hits = 0
  targets.forEach((target, i) => {
    const want = norm(target)
    const ok = detected.has(want)
    if (ok) hits++
    log(`[AutoTest] ${ok ? 'PASS' : 'FAIL'} ${idPrefix}-0${i + 1} cd dir${i} -> cwd OSC ${ok ? 'emitted' : 'MISSING'} (${want})`)
  })
  return hits
}

async function main() {
  // Per-suite scratch under the OS temp dir (CLAUDE.md fixture isolation).
  const scratch = mkdtempSync(join(tmpdir(), 'onward-si-cwd-'))
  const targets = []
  for (let i = 0; i < TRIALS; i++) {
    const d = join(scratch, `dir${i}`)
    mkdirSync(d, { recursive: true })
    targets.push(d)
  }
  const verifiedTargetDir = join(scratch, 'verified-target')
  mkdirSync(verifiedTargetDir, { recursive: true })

  let failed = false
  try {
    // ── Scenario A: default policy, integration prompt installed ──
    const launchA = buildLaunch()
    log(`shell-integration-cwd: platform=${process.platform} kind=${launchA.kind} shell=${launchA.shell}`)
    const shellKind = launchA.kind === 'powershell' ? 'powershell' : (launchA.kind === 'cmd' ? 'cmd' : 'posix')
    const verifiedCmd = getVerifiedCdCommand(process.platform, verifiedTargetDir, shellKind)
    const bufA = await driveSession(launchA, targets, verifiedCmd)
    const hitsA = assertTargetsDetected(bufA, targets, 'SIC')
    if (hitsA < TRIALS) {
      log(`[AutoTest] FAIL SIC-00 only ${hitsA}/${TRIALS} cd operations produced a cwd OSC`)
      failed = true
    } else {
      log(`[AutoTest] PASS SIC-00 all ${TRIALS}/${TRIALS} cd operations produced a matching cwd OSC`)
    }
    // Verified-cd proof (RC-3): the command itself must emit the target cwd.
    const verifiedOk = new Set(extractOscCwds(bufA)).has(norm(verifiedTargetDir))
    log(`[AutoTest] ${verifiedOk ? 'PASS' : 'FAIL'} SIC-VC-01 verified change-workdir command emitted its own OSC proof`)
    if (!verifiedOk) failed = true

    // ── Scenario B (Windows PowerShell only): Restricted execution policy.
    // The inline -Command payload must be immune — this is THE RC-1 fix
    // assertion. The old dot-source form dies here with PSSecurityException.
    if (IS_WINDOWS && launchA.kind === 'powershell') {
      const launchB = buildLaunch({ PSExecutionPolicyPreference: 'Restricted' })
      const bufB = await driveSession(launchB, targets, verifiedCmd)
      const hitsB = assertTargetsDetected(bufB, targets, 'SIC-R')
      if (hitsB < TRIALS) {
        log(`[AutoTest] FAIL SIC-R-00 Restricted policy: only ${hitsB}/${TRIALS} cd operations produced a cwd OSC — inline payload lost its policy immunity`)
        failed = true
      } else {
        log(`[AutoTest] PASS SIC-R-00 Restricted policy: all ${TRIALS}/${TRIALS} cd operations produced a cwd OSC (inline -Command is policy-immune)`)
      }
      const verifiedOkB = new Set(extractOscCwds(bufB)).has(norm(verifiedTargetDir))
      log(`[AutoTest] ${verifiedOkB ? 'PASS' : 'FAIL'} SIC-R-VC-01 verified change-workdir proof under Restricted policy`)
      if (!verifiedOkB) failed = true
    }
  } finally {
    // Cleanup scratch (success or failure).
    try { rmSync(scratch, { recursive: true, force: true }) } catch { /* ignore */ }
  }

  log('shell-integration-cwd:complete')
  process.exit(failed ? 1 : 0)
}

main().catch((err) => {
  console.error('[AutoTest] FAIL: unexpected error:', err)
  console.log('shell-integration-cwd:complete')
  process.exit(1)
})
