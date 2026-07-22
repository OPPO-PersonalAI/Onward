/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

import * as pty from 'node-pty'
import { platform, homedir, tmpdir } from 'os'
import { join, delimiter, basename, resolve as pathResolve } from 'path'
import { execFileSync } from 'child_process'
import { mkdirSync, writeFileSync, existsSync } from 'fs'
import { app } from 'electron'
import { getApiPort } from './api-server'
import { PERF_TRACE_EVENT } from '../../src/utils/perf-trace-names'
import { performanceTrace } from './performance-trace'
import { buildColorCapableTerminalEnv, resolveUserZdotdirForShellIntegration } from './terminal-env'
import { resolveExistingTerminalCwd } from './terminal-cwd-validation'
import { buildPowerShellInlineIntegrationCommand } from './powershell-inline-integration'
import { parseOsc633Cwd, parseOsc7Cwd, parseOsc9Cwd } from '../../src/utils/terminal-cwd-osc'

export interface PtyOptions {
  cols?: number
  rows?: number
  cwd?: string
  env?: NodeJS.ProcessEnv
  command?: string
  args?: string[]
}

type PtyExitEvent = { exitCode: number; signal?: number }
type PtySequencePhase = 'content' | 'enter'
export type PtyShellKind = 'posix' | 'powershell' | 'cmd' | 'unknown'
/** How shell integration was injected into a spawned shell (trace field). */
export type ShellIntegrationMode =
  | 'ps-inline-command'
  | 'bash-rcfile'
  | 'zsh-zdotdir'
  | 'fish-vendor-conf'
  | 'cmd-prompt-env'
  | 'none'

interface PtyRecord {
  pty: pty.IPty
  shellKind: PtyShellKind
  integrationMode: ShellIntegrationMode
  externalDisposables: pty.IDisposable[]
  exitDisposable: pty.IDisposable
  exitPromise: Promise<PtyExitEvent>
  exited: boolean
  writeQueue: Promise<void>
  disposed: boolean
}

// Chunked write constants for Windows ConPTY pipe buffer safety.
// macOS/Linux can write large payloads directly without the extra pacing.
const WINDOWS_CHUNK_SIZE = 8 * 1024
const WINDOWS_CHUNK_DELAY_MS = 1
const SMALL_WRITE_THRESHOLD = 1024

export class PtyManager {
  private instances: Map<string, PtyRecord> = new Map()
  private cachedShell: string | null = null
  private cwdMap: Map<string, string> = new Map()

  // OSC 9;9 (ConEmu-style CWD report): \x1b]9;9;PATH\x07 or \x1b]9;9;PATH\x1b\\
  private static readonly OSC_CWD_RE = /\x1b\]9;9;(.+?)(?:\x07|\x1b\\)/
  // OSC 633;P;Cwd= (VS Code dialect, emitted by the Onward PS inline prompt)
  private static readonly OSC_633_CWD_RE = /\x1b\]633;P;Cwd=(.+?)(?:\x07|\x1b\\)/
  // OSC 7 (file:// URI dialect) — capture the full URI for parseOsc7Cwd
  private static readonly OSC_7_RE = /\x1b\]7;(file:\/\/[^\x07\x1b]*)(?:\x07|\x1b\\)/
  private oscCwdDetectedHandler: ((id: string, cwd: string) => void) | null = null

  private getDefaultShell(): string {
    if (this.cachedShell) return this.cachedShell
    if (platform() === 'win32') {
      this.cachedShell = this.resolveWindowsShell()
    } else {
      this.cachedShell = process.env.SHELL || '/bin/bash'
    }
    return this.cachedShell
  }

  // Prefer PowerShell on Windows, fall back to cmd.exe
  private resolveWindowsShell(): string {
    // Try pwsh.exe (PowerShell 7+) first, then powershell.exe (Windows PowerShell 5.x)
    for (const candidate of ['pwsh.exe', 'powershell.exe']) {
      try {
        const resolved = execFileSync('where', [candidate], {
          stdio: ['ignore', 'pipe', 'ignore'],
          timeout: 3000
        })
          .toString()
          .trim()
          .split(/\r?\n/)[0]
        if (resolved) return resolved
      } catch {
        continue
      }
    }
    return process.env.COMSPEC || 'cmd.exe'
  }

  create(id: string, options: PtyOptions = {}): pty.IPty {
    const shell = this.getDefaultShell()
    const { cols = 80, rows = 24, cwd, env, command, args } = options
    const execCommand = command || shell
    let execArgs = command ? (args || []) : []
    const shellKind = this.detectShellKind(execCommand)
    const inheritedEnv = env ? { ...env } : buildColorCapableTerminalEnv(process.env)

    // On macOS/Linux, launch the default shell as a login shell so that
    // profile files (.zprofile, .bash_profile, .profile) are sourced.
    // This matches Terminal.app / iTerm2 behavior and ensures PATH includes
    // Homebrew, nvm, pyenv, rbenv, etc. — critical when Electron is launched
    // from Finder/Dock where process.env.PATH is minimal (/usr/bin:/bin).
    if (!command && platform() !== 'win32') {
      execArgs = ['-l']
    }

    // Windows PowerShell CWD tracking is handled by the INLINE -Command
    // prompt wrapper injected below (OSC 633 + OSC 7), the same richer path
    // macOS/Linux use. RC-1 (2026-07 bundles): the previous pwsh.ps1
    // dot-source was blocked by ExecutionPolicy / AppLocker / MOTW on
    // locked-down machines — an inline -Command string is exempt from every
    // script-FILE execution gate (see powershell-inline-integration.ts).
    // The even older OSC 9;9 `-EncodedCommand` prompt was removed before
    // that: PowerShell swallows everything after a `-Command` string as that
    // command's arguments, so when both were emitted the `-EncodedCommand`
    // was dead AND the two mechanisms produced a conflicting arg list.
    // cmd.exe still uses the PROMPT env var below (no .ps1 involvement).

    // Inject Onward Bridge API environment variables
    const apiPort = getApiPort()
    const bridgeEnv: Record<string, string> = {}
    if (apiPort > 0) {
      bridgeEnv.ONWARD_API_PORT = String(apiPort)
    }
    try {
      bridgeEnv.ONWARD_USER_DATA = app.getPath('userData')
    } catch {
      // app may not be ready yet, ignore
    }

    // For cmd.exe on Windows, set PROMPT to emit OSC 9;9 CWD report
    const shellIntegrationEnv: Record<string, string> = {}
    let integrationMode: ShellIntegrationMode = 'none'
    if (platform() === 'win32' && !command && this.isCmdShell(shell)) {
      // $e = ESC, $P = current path, $e\ = ST (string terminator), $G = >
      shellIntegrationEnv.PROMPT = '$e]9;9;$P$e\\$P$G'
      integrationMode = 'cmd-prompt-env'
    }

    // Onward shell integration: emit OSC 633 + OSC 7 on every prompt so the
    // xterm.js OSC parser (commit 9) can push cwd to the GitStateMirror with
    // sub-50ms latency. Falls back to the legacy lsof / cmd-PROMPT path when
    // the user opts out via ONWARD_SHELL_INTEGRATION=0.
    if (!command && process.env.ONWARD_SHELL_INTEGRATION !== '0') {
      const injection = this.prepareShellIntegrationInjection(shell, inheritedEnv)
      if (injection) {
        // argsReplace wins over the caller's defaults: bash specifically
        // needs to drop the `-l` login flag so `--rcfile` is honoured.
        // Without this branch, bash silently skips the wrapper because
        // login mode takes precedence over --rcfile.
        if (injection.argsReplace) {
          execArgs = injection.argsReplace.slice()
        }
        if (injection.argsPrepend) execArgs = [...injection.argsPrepend, ...execArgs]
        if (injection.argsAppend) execArgs = [...execArgs, ...injection.argsAppend]
        Object.assign(shellIntegrationEnv, injection.env)
        integrationMode = injection.mode
        // injection.cleanupPath is the temp wrapper dir for bash / fish; it
        // lives under tmpdir() and is cleaned up by the OS on reboot. We
        // don't tear it down on PTY exit because re-spawn after a crash
        // would need to recreate it anyway, and the leak is bounded (one
        // dir per spawn, each <1 KB).
        void injection.cleanupPath
      }
    }

    const initialCwd = cwd || process.env.HOME || process.env.USERPROFILE || process.cwd()

    const spawnStartMs = Date.now()
    const spawnStartUs = performanceTrace.nowUs()
    let ptyProcess: pty.IPty
    try {
      ptyProcess = pty.spawn(execCommand, execArgs, {
        name: 'xterm-256color',
        cols,
        rows,
        cwd: initialCwd,
        env: {
          ...this.getAugmentedEnv(inheritedEnv),
          // Ensure correct UTF-8 locale (if not set on the system)
          LANG: process.env.LANG || 'en_US.UTF-8',
          LC_ALL: process.env.LC_ALL || '',
          LC_CTYPE: process.env.LC_CTYPE || 'en_US.UTF-8',
          // Git 2.32+ supports overriding configuration through environment variables
          // Disable quotepath to correctly display non-ASCII characters such as Chinese
          GIT_CONFIG_COUNT: '1',
          GIT_CONFIG_KEY_0: 'core.quotepath',
          GIT_CONFIG_VALUE_0: 'false',
          // Shell integration for CWD tracking (cmd.exe)
          ...shellIntegrationEnv,
          // Onward Bridge API environment variables
          ...bridgeEnv
        } as { [key: string]: string }
      })
      performanceTrace.record(PERF_TRACE_EVENT.MAIN_PTY_SPAWN, {
        terminalId: id,
        shellKind,
        shellBasename: basename(execCommand),
        argsLen: execArgs.length,
        cols,
        rows,
        platform: platform(),
        durationMs: Date.now() - spawnStartMs,
        // Field-semantics fix (2026-07 bundles): the old flag counted env
        // KEYS only, so args-based injection (PowerShell) always reported
        // false. `hasShellIntegration` now means "any injection happened";
        // `integrationMode` names the mechanism.
        hasShellIntegration: integrationMode !== 'none',
        integrationMode
      })
      performanceTrace.recordComplete('pty.spawn', spawnStartUs, {
        terminalId: id,
        cols,
        rows,
        commandKind: command ? 'custom' : 'default-shell',
        shellKind,
        argsCount: execArgs.length,
        cwdProvided: Boolean(cwd),
        result: 'success'
      }, 'pty')
    } catch (error) {
      performanceTrace.recordComplete('pty.spawn', spawnStartUs, {
        terminalId: id,
        cols,
        rows,
        commandKind: command ? 'custom' : 'default-shell',
        shellKind,
        argsCount: execArgs.length,
        cwdProvided: Boolean(cwd),
        result: 'error',
        errorType: error instanceof Error ? error.name : typeof error
      }, 'pty')
      throw error
    }

    // Store initial CWD for Windows shell-integration tracking
    this.cwdMap.set(id, initialCwd)

    let resolveExit: (event: PtyExitEvent) => void
    const exitPromise = new Promise<PtyExitEvent>((resolve) => {
      resolveExit = resolve
    })

    const record: PtyRecord = {
      pty: ptyProcess,
      shellKind,
      integrationMode,
      externalDisposables: [],
      exitDisposable: { dispose: () => {} },
      exitPromise,
      exited: false,
      writeQueue: Promise.resolve(),
      disposed: false
    }

    record.exitDisposable = ptyProcess.onExit((event) => {
      record.exited = true
      performanceTrace.record(PERF_TRACE_EVENT.MAIN_PTY_EXIT, {
        terminalId: id,
        shellKind,
        exitCode: event.exitCode,
        signal: event.signal ?? null
      })
      performanceTrace.markTaskExited(id, event.exitCode, event.signal)
      resolveExit(event)
    })

    this.instances.set(id, record)
    return ptyProcess
  }

  write(id: string, data: string): boolean | Promise<boolean> {
    const record = this.instances.get(id)
    if (!record || record.disposed || record.exited) return false
    const traceArgs = {
      terminalId: id,
      writeMode: data.length <= SMALL_WRITE_THRESHOLD ? 'direct' : 'queued',
      includesEnter: data.includes('\r') || data.includes('\n'),
      ...performanceTrace.summarizeText('payload', data)
    }

    if (data.length <= SMALL_WRITE_THRESHOLD) {
      const startMs = Date.now()
      const startUs = performanceTrace.nowUs()
      try {
        // Short input (keystrokes, short commands): pass through directly
        record.pty.write(data)
        performanceTrace.record(PERF_TRACE_EVENT.MAIN_PTY_WRITE, {
          path: 'small',
          bytes: data.length,
          durationMs: Date.now() - startMs,
          ok: true
        }, { terminalId: id })
        performanceTrace.recordComplete('pty.write', startUs, { ...traceArgs, result: 'success' }, 'pty')
        return true
      } catch (error) {
        performanceTrace.record(PERF_TRACE_EVENT.MAIN_PTY_WRITE, {
          path: 'small',
          bytes: data.length,
          durationMs: Date.now() - startMs,
          ok: false,
          error: String(error)
        }, { terminalId: id })
        performanceTrace.recordComplete('pty.write', startUs, {
          ...traceArgs,
          result: 'error',
          errorType: error instanceof Error ? error.name : typeof error
        }, 'pty')
        console.warn('[PTY] write failed:', { id, error: String(error) })
        return false
      }
    }

    // Large data: enqueue chunked write and return Promise.
    // ipcMain.handle() awaits the Promise, so the renderer's
    // `await terminal.write()` won't resolve until all chunks are written.
    // This prevents the follow-up '\r' from arriving mid-content.
    const largeStartMs = Date.now()
    const startUs = performanceTrace.nowUs()
    record.writeQueue = record.writeQueue.then(async () => {
      await this.writeLargeData(record, data)
      performanceTrace.record(PERF_TRACE_EVENT.MAIN_PTY_WRITE, {
        path: 'large',
        bytes: data.length,
        durationMs: Date.now() - largeStartMs,
        ok: true
      }, { terminalId: id })
    })
    return record.writeQueue.then(() => {
      performanceTrace.recordComplete('pty.write', startUs, { ...traceArgs, result: 'success' }, 'pty')
      return true
    }).catch((error) => {
      performanceTrace.recordComplete('pty.write', startUs, {
        ...traceArgs,
        result: 'error',
        errorType: error instanceof Error ? error.name : typeof error
      }, 'pty')
      throw error
    })
  }

  async sendInputSequence(
    id: string,
    content: string,
    enterDelayMs?: number
  ): Promise<{ ok: boolean; phase?: PtySequencePhase; error?: string }> {
    const record = this.instances.get(id)
    if (!record || record.disposed || record.exited) {
      return { ok: false, phase: 'content', error: record?.exited ? 'pty exited' : 'pty not found' }
    }

    let failedPhase: PtySequencePhase = 'content'
    let failedError: unknown = null

    const startUs = performanceTrace.nowUs()
    const task = record.writeQueue.then(async () => {
      if (record.disposed || record.exited) {
        failedPhase = 'content'
        throw new Error(record.exited ? 'pty exited' : 'pty disposed')
      }

      try {
        await this.writeLargeData(record, content)
      } catch (error) {
        failedPhase = 'content'
        failedError = error
        throw error
      }

      if (enterDelayMs === undefined) {
        return
      }

      await new Promise<void>((resolve) => setTimeout(resolve, enterDelayMs))

      if (record.disposed || record.exited) {
        failedPhase = 'enter'
        throw new Error(record.exited ? 'pty exited during enter delay' : 'pty disposed during enter delay')
      }

      try {
        record.pty.write('\r')
      } catch (error) {
        failedPhase = 'enter'
        failedError = error
        throw error
      }
    })

    record.writeQueue = task.catch(() => {})

    try {
      await task
      performanceTrace.recordComplete('pty.send_input_sequence', startUs, {
        terminalId: id,
        phase: 'complete',
        enterDelayMs: enterDelayMs ?? null,
        ...performanceTrace.summarizeText('payload', content),
        result: 'success'
      }, 'pty')
      return { ok: true }
    } catch (error) {
      const message = String(failedError ?? error)
      performanceTrace.recordComplete('pty.send_input_sequence', startUs, {
        terminalId: id,
        phase: failedPhase,
        enterDelayMs: enterDelayMs ?? null,
        ...performanceTrace.summarizeText('payload', content),
        result: 'error',
        errorType: failedError instanceof Error ? failedError.name : error instanceof Error ? error.name : typeof error
      }, 'pty')
      console.warn('[PTY] sendInputSequence failed:', { id, phase: failedPhase, error: message })
      return { ok: false, phase: failedPhase, error: message }
    }
  }

  private async writeLargeData(record: PtyRecord, data: string): Promise<void> {
    if (data.length === 0) return
    if (data.length <= SMALL_WRITE_THRESHOLD || platform() !== 'win32') {
      record.pty.write(data)
      return
    }
    await this.writeChunked(record, data)
  }

  private async writeChunked(record: PtyRecord, data: string): Promise<void> {
    for (let offset = 0; offset < data.length; offset += WINDOWS_CHUNK_SIZE) {
      if (record.disposed) return
      const chunk = data.slice(offset, offset + WINDOWS_CHUNK_SIZE)
      record.pty.write(chunk)
      if (offset + WINDOWS_CHUNK_SIZE < data.length) {
        await new Promise<void>((resolve) => setTimeout(resolve, WINDOWS_CHUNK_DELAY_MS))
      }
    }
  }

  resize(id: string, cols: number, rows: number): boolean {
    const record = this.instances.get(id)
    if (record && !record.disposed && !record.exited) {
      const startUs = performanceTrace.nowUs()
      try {
        record.pty.resize(cols, rows)
        performanceTrace.recordComplete('pty.resize', startUs, { terminalId: id, cols, rows, result: 'success' }, 'pty')
        return true
      } catch (error) {
        performanceTrace.recordComplete('pty.resize', startUs, {
          terminalId: id,
          cols,
          rows,
          result: 'error',
          errorType: error instanceof Error ? error.name : typeof error
        }, 'pty')
        console.warn('[PTY] resize failed:', { id, cols, rows, error: String(error) })
        return false
      }
    }
    return false
  }
  // Parse cwd-bearing OSC reports from the PTY data stream (main-side).
  //
  // Historically this only understood OSC 9;9 (cmd.exe PROMPT), which left
  // `cwdMap` permanently stale for PowerShell — the inline integration emits
  // OSC 633;P;Cwd= and OSC 7, both of which were parsed only in the renderer.
  // Parsing all three dialects here keeps the main-side fallback cache honest
  // across renderer reloads. Best-effort by design: a sequence split across
  // PTY chunks is missed here but still caught by xterm.js's stateful parser
  // in the renderer, whose pushCwd IPC remains the authoritative path.
  //
  // Cost note: three regex execs per PTY chunk, all anchored on rare escape
  // introducers — no allocation on the (dominant) no-match path.
  detectCwd(id: string, data: string): void {
    if (!data.includes('\x1b]')) return
    let rawCwd: string | null = null
    let dialect: string | null = null
    const m9 = PtyManager.OSC_CWD_RE.exec(data)
    if (m9) {
      rawCwd = parseOsc9Cwd(`9;${m9[1]}`)
      dialect = 'osc9'
    }
    const m633 = PtyManager.OSC_633_CWD_RE.exec(data)
    if (m633) {
      rawCwd = parseOsc633Cwd(`P;Cwd=${m633[1]}`)
      dialect = 'osc633'
    }
    const m7 = PtyManager.OSC_7_RE.exec(data)
    if (!m633 && m7) {
      rawCwd = parseOsc7Cwd(m7[1])
      dialect = 'osc7'
    }
    if (!dialect) return
    const cwd = rawCwd ? resolveExistingTerminalCwd(rawCwd) : null
    if (cwd) {
      this.cwdMap.set(id, cwd)
      try {
        this.oscCwdDetectedHandler?.(id, cwd)
      } catch {
        // The hook is observability plumbing — never let it break PTY data flow.
      }
    } else {
      performanceTrace.record(PERF_TRACE_EVENT.MAIN_GIT_STATE_MIRROR_CWD_IGNORED, {
        terminalId: id,
        reason: `invalid-pty-${dialect}-cwd`,
        rawCwd: (rawCwd ?? '').slice(0, 512)
      })
    }
  }

  /**
   * Register the main-side OSC cwd hook (shell-derived proof). Wired by
   * ipc-handlers to push into the GitStateMirror router and to feed the
   * shell-integration liveness tracker.
   */
  setOscCwdDetectedHandler(handler: ((id: string, cwd: string) => void) | null): void {
    this.oscCwdDetectedHandler = handler
  }

  // Get tracked CWD for a terminal (set by shell integration or initial spawn)
  getCwd(id: string): string | null {
    return this.cwdMap.get(id) ?? null
  }

  /** Injection mechanism recorded at spawn (for liveness gating / traces). */
  getIntegrationMode(id: string): ShellIntegrationMode {
    return this.instances.get(id)?.integrationMode ?? 'none'
  }

  getShellKind(id: string): PtyShellKind {
    const record = this.instances.get(id)
    if (record) return record.shellKind
    return platform() === 'win32' ? 'unknown' : 'posix'
  }

  dispose(id: string): boolean {
    const record = this.instances.get(id)
    if (record) {
      const startUs = performanceTrace.nowUs()
      record.disposed = true
      this.disposeExternalListeners(record)
      this.killRecord(record)
      record.exitDisposable.dispose()
      this.instances.delete(id)
      this.cwdMap.delete(id)
      performanceTrace.markTaskIdle(id, 'dispose')
      performanceTrace.recordComplete('pty.dispose', startUs, { terminalId: id, result: 'success' }, 'pty')
      return true
    }
    return false
  }

  get(id: string): pty.IPty | undefined {
    return this.instances.get(id)?.pty
  }

  registerListeners(id: string, disposables: pty.IDisposable[]): boolean {
    const record = this.instances.get(id)
    if (!record) {
      return false
    }
    record.externalDisposables.push(...disposables)
    return true
  }

  // Augment PATH with common tool directories that may be missing when
  // Electron is launched from Finder/Dock on macOS (where process.env.PATH
  // typically only contains /usr/bin:/bin). Deduplicates via Set.
  private getAugmentedEnv(baseEnv: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
    const env = { ...baseEnv }
    const pathKey = Object.keys(env).find(k => k.toLowerCase() === 'path') || 'PATH'
    const current = env[pathKey] || ''
    const extras: string[] = []

    if (platform() === 'win32') {
      const appData = process.env.APPDATA || ''
      if (appData) extras.push(join(appData, 'npm'))
      extras.push('C:\\Program Files\\nodejs')
    } else {
      extras.push(
        join(homedir(), '.local', 'bin'),
        '/usr/local/bin',
        '/opt/homebrew/bin',
        '/opt/homebrew/sbin',
        '/opt/local/bin',
        '/usr/local/sbin'
      )
    }

    const merged = [...current.split(delimiter).filter(Boolean), ...extras]
    env[pathKey] = Array.from(new Set(merged)).join(delimiter)
    return env
  }

  private isCmdShell(shell: string): boolean {
    const lower = shell.toLowerCase()
    return lower.includes('cmd') && !lower.includes('powershell') && !lower.includes('pwsh')
  }

  private detectShellKind(command: string): PtyShellKind {
    if (platform() !== 'win32') return 'posix'
    const name = basename(command).toLowerCase()
    if (name === 'pwsh' || name === 'pwsh.exe' || name === 'powershell' || name === 'powershell.exe') {
      return 'powershell'
    }
    if (name === 'cmd' || name === 'cmd.exe') {
      return 'cmd'
    }
    return 'unknown'
  }

  /**
   * Resolve the Onward shell-integration resource directory. Works in dev
   * (sources live under `<repoRoot>/resources/shell-integration/`) and in
   * the packaged app (electron-builder copies them to `process.resourcesPath`
   * which lives at `<app>.app/Contents/Resources/` on macOS).
   */
  private resolveShellIntegrationDir(): string | null {
    const candidates = [
      // Packaged app — electron-builder's `extraResources.from: resources, to: resources`
      // puts our scripts at `<app>/Contents/Resources/resources/shell-integration/`.
      process.resourcesPath ? join(process.resourcesPath, 'resources', 'shell-integration') : null,
      // Defensive fallback if a future config drops the inner `resources/` segment.
      process.resourcesPath ? join(process.resourcesPath, 'shell-integration') : null,
      // Dev: walk up from __dirname until we find `resources/shell-integration`.
      pathResolve(__dirname, '..', '..', 'resources', 'shell-integration'),
      pathResolve(__dirname, '..', '..', '..', 'resources', 'shell-integration')
    ].filter((p): p is string => Boolean(p))
    for (const dir of candidates) {
      if (existsSync(join(dir, 'bash.sh'))) return dir
    }
    return null
  }

  /**
   * Compose the args / env mutations needed to inject the Onward
   * shell-integration script into the spawned shell. Returns null when
   * the shell is unsupported (cmd.exe still uses the legacy PROMPT
   * approach above; non-pwsh on Windows is unsupported per the platform
   * hard requirement).
   *
   * `cleanupPath` is the temp directory the caller should `rm -rf` when
   * the PTY exits — currently only zsh's ZDOTDIR injection produces one.
   */
  private prepareShellIntegrationInjection(shellPath: string, baseEnv: NodeJS.ProcessEnv): {
    argsPrepend?: string[]
    argsAppend?: string[]
    /**
     * When set, REPLACES the caller's existing execArgs entirely instead
     * of being prepended/appended. Necessary for bash, where the caller's
     * default `['-l']` (login flag) takes precedence over `--rcfile` and
     * causes bash to silently skip the wrapper. The bash branch returns
     * `['--rcfile', <wrapper>]` here and has its wrapper source the login
     * file chain manually so PATH/toolchain init still happens.
     */
    argsReplace?: string[]
    env: Record<string, string>
    /**
     * Injection mechanism label for the `main:pty.spawn` trace. The old
     * `hasShellIntegration` flag counted env KEYS only, so args-based
     * injection (PowerShell) always reported `false` — a misleading field
     * that cost real diagnosis time on the 2026-07 bundles.
     */
    mode: ShellIntegrationMode
    cleanupPath: string | null
  } | null {
    const integrationDir = this.resolveShellIntegrationDir()
    if (!integrationDir) return null

    const baseName = basename(shellPath).toLowerCase().replace(/\.exe$/, '')

    if (baseName === 'bash') {
      // bash doesn't read `--rcfile` when invoked as a login shell (`-l`):
      // login mode dominates and bash sources `~/.bash_profile` →
      // `~/.bash_login` → `~/.profile` instead, completely skipping any
      // file pointed to by `--rcfile`. macOS Terminal.app, iTerm2, and
      // most Linux desktops launch bash as a login shell by default, so
      // simply prepending `--rcfile` (which the previous version did) had
      // ZERO effect for the vast majority of users — the wrapper, our
      // OSC-emitting `bash.sh`, and the entire shell-integration chain
      // were silently ignored.
      //
      // Fix: drop the login flag for bash and have the wrapper source the
      // login startup files manually, in the same precedence order bash
      // itself would use, then chain to our `bash.sh`. This preserves
      // PATH / toolchain initialisation (Homebrew, nvm, pyenv, asdf — all
      // typically installed into `~/.bash_profile` on macOS, `~/.bashrc`
      // on Linux) while guaranteeing our integration script actually runs.
      const wrapperDir = this.makeTempIntegrationDir('bash')
      const wrapperPath = join(wrapperDir, 'rcfile.sh')
      writeFileSync(
        wrapperPath,
        [
          '# Onward bash integration wrapper.',
          '#',
          '# Manually drives bash\'s login startup chain because we launch',
          '# bash without `-l` (so `--rcfile` is honoured). Order matches',
          '# bash\'s documented login behaviour: only the FIRST existing',
          '# file in the .bash_profile / .bash_login / .profile sequence',
          '# is sourced. We fall through to .bashrc as a final fallback so',
          '# Linux distros that put everything in .bashrc still get their',
          '# config loaded.',
          'if [ -f "$HOME/.bash_profile" ]; then',
          '  . "$HOME/.bash_profile"',
          'elif [ -f "$HOME/.bash_login" ]; then',
          '  . "$HOME/.bash_login"',
          'elif [ -f "$HOME/.profile" ]; then',
          '  . "$HOME/.profile"',
          'elif [ -f "$HOME/.bashrc" ]; then',
          '  . "$HOME/.bashrc"',
          'fi',
          '# Onward integration last so its precmd hook wraps cleanly over',
          '# anything the user set up above.',
          `if [ -f "${integrationDir}/bash.sh" ]; then`,
          `  . "${integrationDir}/bash.sh"`,
          'fi',
          ''
        ].join('\n'),
        'utf8'
      )
      return {
        argsReplace: ['--rcfile', wrapperPath],
        env: {},
        mode: 'bash-rcfile',
        cleanupPath: wrapperDir
      }
    }

    if (baseName === 'zsh') {
      // ZDOTDIR injection: zsh sources <ZDOTDIR>/.zshrc which chains to user's.
      // The committed .zshrc preserves USER_ZDOTDIR so it can chain back to
      // the user's real config.
      const zdotdir = join(integrationDir, 'zsh-zdotdir')
      const env: Record<string, string> = { ZDOTDIR: zdotdir }
      const userZdot = resolveUserZdotdirForShellIntegration(baseEnv, homedir(), zdotdir)
      if (userZdot) env.USER_ZDOTDIR = userZdot
      return { env, mode: 'zsh-zdotdir', cleanupPath: null }
    }

    if (baseName === 'fish') {
      // Prepend a generated dir to XDG_DATA_DIRS so fish auto-loads our
      // vendor_conf.d entry. The committed `fish.fish` lives in
      // `integrationDir`, but we MUST NOT write next to it: in packaged
      // builds `integrationDir` resolves under `process.resourcesPath`
      // which is read-only on Linux AppImage and conventionally read-only
      // on macOS / Program Files installs — `mkdirSync` would throw
      // EROFS / EACCES and crash terminal creation outright. Materialise
      // the vendor tree in OS temp instead, mirroring the bash wrapper
      // strategy. Wrap every fs op in try/catch so a failure degrades to
      // "no fish integration" rather than aborting PTY spawn.
      let fishVendorRoot: string
      let vendorTarget: string
      try {
        fishVendorRoot = this.makeTempIntegrationDir('fish')
        const vendorDir = join(fishVendorRoot, 'fish', 'vendor_conf.d')
        mkdirSync(vendorDir, { recursive: true })
        vendorTarget = join(vendorDir, 'onward.fish')
        const src = require('fs').readFileSync(join(integrationDir, 'fish.fish'), 'utf8')
        writeFileSync(vendorTarget, src, 'utf8')
      } catch {
        return null
      }
      const xdg = process.env.XDG_DATA_DIRS || '/usr/local/share:/usr/share'
      return {
        env: { XDG_DATA_DIRS: `${fishVendorRoot}:${xdg}` },
        mode: 'fish-vendor-conf',
        cleanupPath: fishVendorRoot
      }
    }

    if (baseName === 'pwsh' || baseName === 'powershell') {
      // -NoLogo suppresses the startup banner. The prompt wrapper is passed
      // INLINE as the -Command string instead of dot-sourcing pwsh.ps1:
      // ExecutionPolicy (Restricted / AllSigned via GPO), AppLocker script
      // rules, and Mark-of-the-Web all gate SCRIPT FILES, and the 2026-07
      // diagnostic bundles proved locked-down machines block the dot-source
      // with PSSecurityException — killing cwd tracking for the whole
      // session with no fallback. A -Command string is exempt from every
      // file-execution gate (verified against powershell.exe with
      // PSExecutionPolicyPreference=Restricted). pwsh.ps1 stays on disk for
      // manual installation parity.
      return {
        argsPrepend: ['-NoLogo', '-NoExit', '-Command', buildPowerShellInlineIntegrationCommand()],
        env: {},
        mode: 'ps-inline-command',
        cleanupPath: null
      }
    }

    return null
  }

  private makeTempIntegrationDir(label: string): string {
    const dir = join(tmpdir(), `onward-shell-${label}-${process.pid}-${Date.now().toString(36)}`)
    mkdirSync(dir, { recursive: true })
    return dir
  }

  disposeAll(): void {
    for (const id of Array.from(this.instances.keys())) {
      this.dispose(id)
    }
    this.cwdMap.clear()
  }

  async shutdownAll(timeoutMs: number = 1500): Promise<{ total: number; closed: number; timedOut: number }> {
    const startUs = performanceTrace.nowUs()
    const records = Array.from(this.instances.entries())
    if (records.length === 0) {
      performanceTrace.recordComplete('pty.shutdown_all', startUs, {
        total: 0,
        closed: 0,
        timedOut: 0
      }, 'pty')
      return { total: 0, closed: 0, timedOut: 0 }
    }

    for (const [, record] of records) {
      this.disposeExternalListeners(record)
    }

    for (const [, record] of records) {
      this.killRecord(record)
    }

    const results = await Promise.all(
      records.map(([, record]) => this.waitForExit(record, timeoutMs))
    )

    for (const [id, record] of records) {
      record.exitDisposable.dispose()
      this.instances.delete(id)
    }

    const closed = results.filter(Boolean).length
    const summary = { total: records.length, closed, timedOut: records.length - closed }
    performanceTrace.recordComplete('pty.shutdown_all', startUs, summary, 'pty')
    return summary
  }

  private disposeExternalListeners(record: PtyRecord): void {
    for (const disposable of record.externalDisposables) {
      disposable.dispose()
    }
    record.externalDisposables = []
  }

  private killRecord(record: PtyRecord): void {
    const terminalId = this.findIdForRecord(record)
    try {
      record.pty.kill()
      performanceTrace.record(PERF_TRACE_EVENT.MAIN_PTY_KILL, {
        terminalId,
        shellKind: record.shellKind,
        alreadyExited: record.exited
      })
    } catch (error) {
      performanceTrace.record(PERF_TRACE_EVENT.MAIN_PTY_KILL, {
        terminalId,
        shellKind: record.shellKind,
        alreadyExited: record.exited,
        error: String(error)
      })
      console.warn('[PTY] kill failed:', error)
    }
  }

  private findIdForRecord(record: PtyRecord): string | null {
    for (const [id, candidate] of this.instances) {
      if (candidate === record) return id
    }
    return null
  }

  private async waitForExit(record: PtyRecord, timeoutMs: number): Promise<boolean> {
    if (record.exited) {
      return true
    }
    if (timeoutMs <= 0) {
      return false
    }
    const result = await Promise.race([
      record.exitPromise.then(() => true),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), timeoutMs))
    ])
    return result
  }
}

export const ptyManager = new PtyManager()
