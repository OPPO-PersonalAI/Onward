/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

// Suppress EPIPE errors on stdout/stderr when the parent process closes the pipe
for (const stream of [process.stdout, process.stderr]) {
  stream?.on?.('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EPIPE') return
    throw err
  })
}

// On Windows, node-pty 1.1.0 forks `conpty_console_list_agent.js` during
// PTY teardown to enumerate the console process list.  If the shell's
// console session was already destroyed (app is exiting), AttachConsole()
// fails inside the forked process, which crashes it.  Node.js then fires
// an ECONNRESET 'error' event on the ChildProcess object; without a
// handler this becomes an uncaughtException that exits Electron with a
// non-zero code, even though traceStore and the API server were already
// cleanly flushed inside the will-quit handler.
if (process.platform === 'win32') {
  process.on('uncaughtException', (error: Error) => {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ECONNRESET') {
      console.warn('[PTY] node-pty teardown ECONNRESET suppressed:', error.message)
      return
    }
    throw error
  })
}

import { app, BrowserWindow, nativeImage, Menu, dialog, ipcMain } from 'electron'
import { writeFileSync } from 'fs'
import { join } from 'path'
import { registerIpcHandlers, cleanupIpcHandlers, setupWindowShortcuts } from './ipc-handlers'
import { getTrayManager } from './tray-manager'
import { getAppInfo, initializeAppIdentity } from './app-info'
import { ptyManager } from './pty-manager'
import { isSameAppNavigation, openExternalUrlWithConfirm } from './external-link-guard'
import { startApiServer, stopApiServer, getApiPort } from './api-server'
import { tMain } from './localization'
import { getUpdateService, applyPendingUpdateOnStartup } from './update-service'
import { getAppStateStorage } from './app-state-storage'
import { getSettingsStorage } from './settings-storage'
import { getTerminalCwd } from './git-utils'
import { getWindowStateStorage } from './window-state-storage'
import { getTelemetryService } from './telemetry/telemetry-service'
import { TELEMETRY_RESET_CONSENT } from './telemetry/telemetry-constants'
import { startSessionHeartbeat, stopSessionHeartbeat, getSessionDurationMs } from './telemetry/telemetry-session-tracker'
import { PERF_TRACE_EVENT } from '../../src/utils/perf-trace-names'
import { IPC } from '../shared/ipc-channels'
import { broadcastGpuProcessGone } from './gpu-crash-recovery'
import { performanceTrace } from './performance-trace'
import { traceStore, runRotationStressForAutotest } from './trace-store'

// ONWARD_SMOKE_LAUNCH=1 makes the main process self-quit once the main window
// renderer finishes loading, after writing a ready marker to the path in
// ONWARD_SMOKE_READY_FILE (if set). CI uses this to assert a clean startup
// without a human observer. See docs/debug-env-variables.md.
const SMOKE_LAUNCH_MODE = process.env.ONWARD_SMOKE_LAUNCH === '1'
const SMOKE_READY_FILE = process.env.ONWARD_SMOKE_READY_FILE || null
if (SMOKE_LAUNCH_MODE) {
  console.log('[SmokeLaunch] Mode active (ONWARD_SMOKE_LAUNCH=1)')
}

let mainWindow: BrowserWindow | null = null
let isQuitting = false
let installUpdateOnQuit = false
let windowStateSaveTimer: ReturnType<typeof setTimeout> | null = null
let lastNormalBounds: { x: number; y: number; width: number; height: number } | null = null

// Single-instance lock keys on the resolved userData path; we MUST set
// userData (via initializeAppIdentity) BEFORE requesting the lock so the
// dev / prod / autotest profiles each get their own lock and don't block
// each other. After this point, only ONE Onward process per (build, userData)
// can run; the second-instance event focuses the existing main window.
//
// This also fixes the duplicate-writers race against userData/traces/ and
// userData/app-state.json that surfaced when daily + Intel-mac-release
// builds were left running side-by-side against the same userData.
const earlyAppInfo = initializeAppIdentity()
const gotTheSingleInstanceLock = app.requestSingleInstanceLock()
if (!gotTheSingleInstanceLock) {
  console.log('[SingleInstance] another Onward is already running; exiting.')
  app.quit()
}
app.on('second-instance', () => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.focus()
  }
})

// GPU helper crash (Electron 39 ANGLE-Metal, deterministic on macOS Space
// switches — see gpu-crash-recovery.ts). App-level listener registered ONCE
// at module scope: broadcast so renderers force-recreate WebGL, because
// Chromium does NOT deliver webglcontextlost on this crash path.
app.on('child-process-gone', (_event, details) => {
  if (details.type !== 'GPU') return
  console.log('[App] gpu-process-gone', details.reason, details.exitCode)
  const notified = broadcastGpuProcessGone({
    reason: details.reason,
    exitCode: details.exitCode ?? 0
  })
  console.log('[App] gpu-process-gone broadcast', notified)
  getTelemetryService().track('error/gpuProcessCrash', {
    reason: details.reason,
    exitCode: details.exitCode ?? 0
  })
})

// Ask the renderer to flush all pending debounced state saves (prompt height,
// editor drafts, etc.) before the app quits. Without this, changes made within
// the last 300-500ms debounce window would be lost on quit/update-restart.
async function flushRendererState(): Promise<void> {
  if (!mainWindow || mainWindow.isDestroyed()) return
  try {
    await new Promise<void>((resolve) => {
      const timeout = setTimeout(resolve, 2000)
      ipcMain.once(IPC.APP_STATE_FLUSH_DONE, () => {
        clearTimeout(timeout)
        resolve()
      })
      mainWindow!.webContents.send(IPC.APP_STATE_FLUSH_PENDING)
    })
  } catch {
    // Renderer may already be gone; proceed with quit
  }
}

async function persistTerminalCwdSnapshot(): Promise<void> {
  const appStateStorage = getAppStateStorage()
  const state = appStateStorage.get()
  const terminalIds = state.tabs.flatMap((tab) => tab.terminals.map((terminal) => terminal.id))
  const uniqueTerminalIds = Array.from(new Set(terminalIds))

  if (uniqueTerminalIds.length === 0) {
    return
  }

  const updates = await Promise.all(uniqueTerminalIds.map(async (terminalId) => {
    if (!ptyManager.get(terminalId)) {
      return null
    }
    const cwd = await getTerminalCwd(terminalId)
    if (!cwd) {
      return null
    }
    return { terminalId, cwd }
  }))

  const validUpdates = updates.filter((item): item is { terminalId: string; cwd: string } => Boolean(item))
  if (validUpdates.length > 0) {
    appStateStorage.setTerminalLastCwds(validUpdates)
  }
}

async function flushAppStateStorage(): Promise<void> {
  try {
    await getAppStateStorage().flush()
  } catch (error) {
    console.warn('[AppState] flush failed during shutdown:', error)
  }
}

function persistWindowState(): void {
  if (!mainWindow || mainWindow.isDestroyed()) return

  const isMaximized = mainWindow.isMaximized()
  const isFullScreen = mainWindow.isFullScreen()
  // Use live bounds when in normal state; fall back to last tracked normal bounds
  // when maximized/fullscreen (those bounds reflect the expanded display, not user intent)
  const bounds = (!isMaximized && !isFullScreen)
    ? mainWindow.getBounds()
    : (lastNormalBounds ?? mainWindow.getBounds())

  getWindowStateStorage().save(bounds, isMaximized, isFullScreen)
}

if (process.env.ONWARD_DISABLE_GPU === '1') {
  app.disableHardwareAcceleration()
  app.commandLine.appendSwitch('disable-gpu')
}

// Exit confirmation dialog (exported for use by tray-manager)
export async function confirmQuit(): Promise<boolean> {
  const { displayName } = getAppInfo()
  const { response } = await dialog.showMessageBox({
    type: 'question',
    buttons: [tMain('common.cancel'), tMain('menu.quitApp', { displayName })],
    defaultId: 0,
    cancelId: 0,
    title: tMain('dialog.quit.title', { displayName }),
    message: tMain('dialog.quit.message', { displayName }),
    detail: tMain('dialog.quit.detail')
  })
  return response === 1
}

// Flush telemetry before any quit path
async function shutdownTelemetry(): Promise<void> {
  stopSessionHeartbeat()
  getTelemetryService().track('session/end', { durationMs: getSessionDurationMs() })
  await getTelemetryService().shutdown()
}

function flushPerformanceTrace(reason: string): void {
  if (!performanceTrace.enabled) return
  try {
    performanceTrace.flush(reason)
  } catch (error) {
    console.warn('[PerfTrace] Failed to flush trace:', String(error))
  }
}

// Synchronous, crash-survivable quit-phase breadcrumb. Unlike perfTrace (buffered
// and FLUSHED only at the end of teardown — so it is lost when an earlier teardown
// step crashes), a console.log is captured line-by-line in the autotest runner log
// and survives a subsequent segfault, so the last "[QuitPhase] …" line in a
// crash log pinpoints exactly which teardown step was reached. Gated to autotest /
// debug so production quit stays quiet.
function logQuitPhase(phase: string): void {
  if (process.env.ONWARD_AUTOTEST === '1' || process.env.ONWARD_DEBUG === '1') {
    console.log(`[QuitPhase] ${phase}`)
  }
}

// Destroy all renderer windows during quit. Ordering vs cleanupIpcHandlers() is
// CRITICAL — it was the source of two OPPOSITE teardown bugs:
//   1. Calling app.quit() WITHOUT first destroying the window leaves the renderer's
//      1 s perf/persist setInterval loops invoking IPC after the handlers are gone;
//      on an EDR-taxed Windows host the live renderer message loop + never-closed
//      window WEDGE app.quit() (~193 s post-test hang when the Project Editor was
//      left active at exit). So the window MUST be destroyed before app.quit().
//   2. But HARD-destroying the window (w.destroy() frees the webContents native
//      object) BEFORE disposing the native subsystems that hold a webContents
//      reference (the GitStateMirror worker, parcel-watchers, worker clients — all
//      torn down in cleanupIpcHandlers) lets a callback fire in that gap and touch
//      freed native memory → a teardown SEGFAULT (observed ~1-in-3 on
//      prompt-input-latency: the crash landed after "[AutoTest] done", DURING
//      cleanup, before the perf-trace flush — i.e. exactly this window).
// Correct invariant: dispose native subsystems FIRST (await cleanupIpcHandlers),
// THEN destroy the windows, THEN app.quit(). Each quit path therefore calls
// cleanupIpcHandlers() BEFORE destroyAllWindowsForQuit(). Must still run AFTER any
// renderer-dependent flush (flushRendererState / flushAppStateStorage).
function destroyAllWindowsForQuit(reason: string): void {
  const windows = BrowserWindow.getAllWindows()
  if (performanceTrace.enabled) {
    try {
      performanceTrace.record(PERF_TRACE_EVENT.MAIN_APP_QUIT_WINDOWS_DESTROYED, {
        reason,
        windowCount: windows.length
      })
    } catch {
      /* best-effort diagnostic breadcrumb */
    }
  }
  for (const w of windows) {
    if (!w.isDestroyed()) {
      try {
        w.destroy()
      } catch (error) {
        console.warn('[Quit] window.destroy() failed:', String(error))
      }
    }
  }
  // Clearing the module-global reference prevents a post-quit stale-reference reuse
  // (e.g. a macOS `activate` recreating the window mid-teardown). Safe: this now
  // runs AFTER cleanupIpcHandlers() has disposed every native subsystem that held a
  // webContents reference, and every quit-reachable access in this module is
  // null-guarded (`if (mainWindow && !mainWindow.isDestroyed())` / `mainWindow?.`).
  mainWindow = null
}

// Exit the request entry in a unified manner to ensure that the confirmation box only pops up once
export async function requestQuit(): Promise<void> {
  if (isQuitting) return
  if (await confirmQuit()) {
    isQuitting = true
    installUpdateOnQuit = false
    await flushRendererState()
    persistWindowState()
    await shutdownTelemetry()
    await persistTerminalCwdSnapshot()
    await flushAppStateStorage()
    const shutdownResult = await ptyManager.shutdownAll()
    if (shutdownResult.timedOut > 0) {
      console.warn(
        `[PTY] shutdown timed out: ${shutdownResult.timedOut}/${shutdownResult.total}`
      )
    }
    // Dispose native subsystems FIRST (window still alive), THEN destroy windows,
    // THEN quit — see destroyAllWindowsForQuit's header for why this order matters.
    logQuitPhase('quit:cleanup-start')
    await cleanupIpcHandlers()
    logQuitPhase('quit:cleanup-done')
    destroyAllWindowsForQuit('quit')
    logQuitPhase('quit:windows-destroyed')
    flushPerformanceTrace('quit')
    logQuitPhase('quit:before-app-quit')
    app.quit()
  }
}

export async function requestRestartToApplyUpdate(): Promise<{ success: boolean; error?: string }> {
  if (isQuitting) {
    return { success: false, error: 'Application is already quitting.' }
  }

  const result = getUpdateService().requestRestartToUpdate()
  if (!result.success) {
    return result
  }

  isQuitting = true
  installUpdateOnQuit = true

  await flushRendererState()
  persistWindowState()
  await shutdownTelemetry()
  await persistTerminalCwdSnapshot()
  await flushAppStateStorage()
  const shutdownResult = await ptyManager.shutdownAll()
  if (shutdownResult.timedOut > 0) {
    console.warn(
      `[PTY] shutdown timed out: ${shutdownResult.timedOut}/${shutdownResult.total}`
    )
  }

  logQuitPhase('restart-to-update:cleanup-start')
  await cleanupIpcHandlers()
  logQuitPhase('restart-to-update:cleanup-done')
  destroyAllWindowsForQuit('restart-to-update')
  logQuitPhase('restart-to-update:windows-destroyed')
  flushPerformanceTrace('restart-to-update')
  logQuitPhase('restart-to-update:before-app-quit')
  app.quit()
  return { success: true }
}

export async function requestQuitForDebug(): Promise<{ success: boolean; error?: string }> {
  if (isQuitting) {
    return { success: false, error: 'Application is already quitting.' }
  }

  isQuitting = true
  installUpdateOnQuit = false

  // Bounded teardown. Under autotest / heavy load a single awaited step
  // (telemetry flush, per-terminal cwd snapshot via PTY round-trips, app-state
  // worker flush, PTY shutdown) can be slow enough that this serial chain never
  // reaches app.quit() before the test watchdog (or an impatient user) gives up
  // — the observed "20/20 passed then never quits -> 280s watchdog kill". Race
  // the graceful teardown against a hard-exit floor so quit is ALWAYS bounded,
  // mirroring the DEBUG_QUIT fallback (ipc-handlers.ts: race(shutdown, timeout)
  // -> app.exit(0)). Step order is preserved: persistTerminalCwdSnapshot writes
  // cwds into app-state via setTerminalLastCwds(), so flushAppStateStorage MUST
  // stay AFTER it; persistWindowState is synchronous and runs first, so window
  // bounds are never lost even if the floor fires mid-teardown.
  const HARD_EXIT_MS = process.env.ONWARD_AUTOTEST === '1' ? 20000 : 12000

  const gracefulTeardown = async (): Promise<void> => {
    persistWindowState()
    await shutdownTelemetry()
    await persistTerminalCwdSnapshot()
    await flushAppStateStorage()
    const shutdownResult = await ptyManager.shutdownAll()
    if (shutdownResult.timedOut > 0) {
      console.warn(
        `[PTY] shutdown timed out: ${shutdownResult.timedOut}/${shutdownResult.total}`
      )
    }

    logQuitPhase('debug-quit:cleanup-start')
    await cleanupIpcHandlers()
    logQuitPhase('debug-quit:cleanup-done')
    destroyAllWindowsForQuit('debug-quit')
    logQuitPhase('debug-quit:windows-destroyed')
    flushPerformanceTrace('debug-quit')
    logQuitPhase('debug-quit:before-app-quit')
  }

  let hardExitTimer: ReturnType<typeof setTimeout> | null = null
  const hardExitFloor = new Promise<'floor'>((resolve) => {
    hardExitTimer = setTimeout(() => resolve('floor'), HARD_EXIT_MS)
  })

  const outcome = await Promise.race<'graceful' | 'floor'>([
    gracefulTeardown().then((): 'graceful' => 'graceful').catch((error): 'graceful' => {
      console.warn('[debug-quit] graceful teardown error:', error)
      return 'graceful'
    }),
    hardExitFloor
  ])
  if (hardExitTimer) {
    clearTimeout(hardExitTimer)
  }

  if (outcome === 'floor') {
    // Graceful teardown overran the floor — force exit so quit is never unbounded.
    logQuitPhase('debug-quit:hard-exit-floor')
    app.exit(0)
  } else {
    app.quit()
  }
  return { success: true }
}

// Build menu template
function buildMenuTemplate(displayName: string): Electron.MenuItemConstructorOptions[] {
  const template: Electron.MenuItemConstructorOptions[] = []

  if (process.platform === 'darwin') {
    // macOS: Custom appMenu (for custom exit behavior)
    template.push({
      label: app.name,
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        {
          label: tMain('menu.quitApp', { displayName }),
          accelerator: 'CommandOrControl+Q',
          click: async () => {
            await requestQuit()
          }
        }
      ]
    })
  }

  // All platforms: Added Edit menu (uses system role, enables standard editing shortcuts)
  template.push({ role: 'editMenu' })

  return template
}

// Get application icon path
function getIconPath(): string {
  // In development mode, __dirname is out/main, so you need to go up two levels to the project root directory
  const resourcesPath = app.isPackaged
    ? join(process.resourcesPath, 'resources')
    : join(__dirname, '../../resources')

  if (process.platform === 'win32') {
    return join(resourcesPath, 'icon.ico')
  }
  // macOS and Linux both use PNG
  return join(resourcesPath, 'icon.png')
}

function createWindow(displayName: string): void {
  const iconPath = getIconPath()
  const shouldLog = process.env.ONWARD_DEBUG === '1' || process.env.ELECTRON_ENABLE_LOGGING === '1'
  const log = (...args: unknown[]) => {
    if (shouldLog) {
      console.log(...args)
    }
  }

  // Restore saved window state
  const savedWindowState = getWindowStateStorage().get()
  const windowOptions: Electron.BrowserWindowConstructorOptions = {
    width: savedWindowState.width,
    height: savedWindowState.height,
    minWidth: 600,
    minHeight: 400,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: '#1e1e1e',
    icon: iconPath,
    title: displayName,
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 15, y: 10 },
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: false // Required for node-pty
    }
  }
  if (savedWindowState.x !== undefined && savedWindowState.y !== undefined) {
    windowOptions.x = savedWindowState.x
    windowOptions.y = savedWindowState.y
  }

  mainWindow = new BrowserWindow(windowOptions)

  // Track normal (non-maximized, non-fullscreen) bounds for accurate restoration
  lastNormalBounds = mainWindow.getBounds()

  const debouncedSaveBounds = () => {
    if (windowStateSaveTimer) clearTimeout(windowStateSaveTimer)
    windowStateSaveTimer = setTimeout(() => {
      if (!mainWindow || mainWindow.isDestroyed()) return
      if (!mainWindow.isMaximized() && !mainWindow.isFullScreen()) {
        lastNormalBounds = mainWindow.getBounds()
      }
    }, 500)
  }

  mainWindow.on('resize', debouncedSaveBounds)
  mainWindow.on('move', debouncedSaveBounds)

  mainWindow.on('ready-to-show', () => {
    log('[Window] ready-to-show')
    if (savedWindowState.isMaximized) {
      mainWindow?.maximize()
    }
    if (savedWindowState.isFullScreen) {
      mainWindow?.setFullScreen(true)
    }
    mainWindow?.show()
  })

  if (mainWindow.webContents) {
    const windowForEvents = mainWindow
    windowForEvents.webContents.on('did-finish-load', async () => {
      log('[Window] did-finish-load', windowForEvents.webContents.getURL())
      if (shouldLog && !windowForEvents.isDestroyed()) {
        const logDomInfo = async (label: string) => {
          try {
            const info = await windowForEvents.webContents.executeJavaScript(`(() => {
              const root = document.getElementById('root')
              const rootRect = root ? root.getBoundingClientRect() : null
              const bodyStyle = window.getComputedStyle(document.body)
              const rootStyle = root ? window.getComputedStyle(root) : null
              return {
                title: document.title,
                hasElectronAPI: typeof window.electronAPI !== 'undefined',
                rootChildCount: root ? root.childElementCount : -1,
                rootText: root?.innerText?.slice(0, 200) ?? '',
                rootRect: rootRect ? {
                  width: Math.round(rootRect.width),
                  height: Math.round(rootRect.height)
                } : null,
                styleSheetsCount: document.styleSheets.length,
                bodyBg: bodyStyle.backgroundColor,
                bodyColor: bodyStyle.color,
                rootColor: rootStyle?.color ?? null,
                bodyOpacity: bodyStyle.opacity,
                rootOpacity: rootStyle?.opacity ?? null,
                rootVisibility: rootStyle?.visibility ?? null
              }
            })()`, true)
            log(`[Window] dom-info ${label}`, info)
          } catch (error) {
            log(`[Window] dom-info ${label} error`, error)
          }
        }

        await logDomInfo('t=0')
        setTimeout(() => void logDomInfo('t=1000'), 1000)
        setTimeout(() => void logDomInfo('t=3000'), 3000)
      }

      if (process.env.ONWARD_DEBUG_CAPTURE === '1' && !windowForEvents.isDestroyed()) {
        const capture = (label: string, delay: number) => {
          setTimeout(async () => {
            try {
              const image = await windowForEvents.webContents.capturePage()
              const outputPath = join(app.getPath('temp'), `onward-debug-${label}.png`)
              writeFileSync(outputPath, image.toPNG())
              log('[Window] capturePage saved', outputPath)
            } catch (error) {
              log('[Window] capturePage error', error)
            }
          }, delay)
        }

        capture('t1', 1500)
        capture('t2', 5000)
      }
    })
    mainWindow.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL) => {
      log('[Window] did-fail-load', { errorCode, errorDescription, validatedURL })
    })
    if (SMOKE_LAUNCH_MODE) {
      mainWindow.webContents.once('did-finish-load', () => {
        // Give React a moment to mount before declaring ready.
        setTimeout(() => {
          if (SMOKE_READY_FILE) {
            try {
              writeFileSync(SMOKE_READY_FILE, JSON.stringify({
                ready: true,
                ts: Date.now(),
                pid: process.pid,
                url: mainWindow?.webContents.getURL() ?? null
              }))
            } catch (error) {
              console.error('[SmokeLaunch] failed to write ready file', error)
            }
          }
          console.log('[SmokeLaunch] READY')
          setTimeout(() => {
            void requestQuitForDebug().catch((error) => {
              console.error('[SmokeLaunch] graceful quit failed', error)
              app.exit(1)
            })
          }, 500)
        }, 1500)
      })
    }
    mainWindow.webContents.on('render-process-gone', (_event, details) => {
      log('[Window] render-process-gone', details)
      performanceTrace.record(PERF_TRACE_EVENT.MAIN_RENDERER_PROCESS_GONE, {
        reason: details.reason,
        exitCode: details.exitCode
      })
      getTelemetryService().track('error/rendererCrash', {
        reason: details.reason,
        exitCode: details.exitCode
      })
    })
    mainWindow.webContents.on('unresponsive', () => {
      log('[Window] renderer unresponsive')
      performanceTrace.record(PERF_TRACE_EVENT.MAIN_RENDERER_UNRESPONSIVE)
    })
    mainWindow.webContents.on('console-message', (_event, level, message, line, sourceId) => {
      log('[Renderer]', { level, message, line, sourceId })
    })
  }

  // macOS: Intercept close event, hide window instead of closing
  mainWindow.on('close', (e) => {
    if (isQuitting) return

    if (process.platform === 'darwin') {
      e.preventDefault()
      mainWindow?.hide()
      app.dock?.hide()
      return
    }

    // Windows / Linux: Confirm to exit before closing the window
    e.preventDefault()
    void requestQuit()
  })

  mainWindow.webContents.on('will-navigate', (event, nextUrl) => {
    const currentUrl = mainWindow?.webContents.getURL() ?? ''
    if (isSameAppNavigation(currentUrl, nextUrl)) {
      return
    }
    event.preventDefault()
    void openExternalUrlWithConfirm(mainWindow, nextUrl)
  })

  mainWindow.webContents.setWindowOpenHandler((details) => {
    void openExternalUrlWithConfirm(mainWindow, details.url)
    return { action: 'deny' }
  })

  // Register IPC handlers
  registerIpcHandlers(mainWindow, {
    onSettingsChanged: () => {
      Menu.setApplicationMenu(Menu.buildFromTemplate(buildMenuTemplate(displayName)))
    },
    onRestartToApplyUpdate: requestRestartToApplyUpdate,
    onGracefulQuitForDebug: requestQuitForDebug,
    getApiPort
  })

  // Set up window shortcuts (before-input-event)
  setupWindowShortcuts(mainWindow)

  // Load the app
  if (process.env.ELECTRON_RENDERER_URL) {
    mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

app.whenReady().then(async () => {
  // Reuse the userData / displayName work we already did at top level so
  // the single-instance lock and appInfo agree on identity. Module-scope
  // call already invoked initializeAppIdentity(); no need to repeat.
  const appInfo = earlyAppInfo
  performanceTrace.start()
  performanceTrace.startEventLoopMonitor()
  performanceTrace.initialize()

  // Trace-rotation autotest hook: when ONWARD_TRACE_ROTATION_STRESS_MB is
  // set, write that many MB of synthetic events through the store and quit
  // cleanly. Used by run-perf-trace-rotation-autotest.sh; absent in
  // production runs. Must happen AFTER the loggers initialize so the store
  // has its directory + first chunk open. See trace-store.ts.
  const stressMb = parseInt(process.env.ONWARD_TRACE_ROTATION_STRESS_MB || '', 10)
  if (Number.isFinite(stressMb) && stressMb > 0) {
    const written = runRotationStressForAutotest(stressMb)
    console.log(`[TraceStore] autotest stress: ${written} events written for ${stressMb} MB target`)
    // Force a final-chunk close so Perfetto-side validators see a clean
    // file with no in-flight bytes; will-quit also calls traceStore.close()
    // but we want the test to be deterministic regardless of platform
    // shutdown ordering.
    setTimeout(() => app.quit(), 50)
    return
  }

  // Windows: PowerShell is a hard runtime requirement. The terminal /
  // shell-integration / cwd-detection pipeline assumes either pwsh.exe
  // (PowerShell 7+) or powershell.exe (5.1) is on PATH. Without it the
  // OSC 633 / 7 emitter cannot install and cwd updates would silently fall
  // back to a much slower lsof-style polling path that we removed in this
  // refactor. Fail loud at startup with an install link rather than ship a
  // half-functional UI.
  if (process.platform === 'win32') {
    const { spawnSync } = await import('node:child_process')
    const probeShell = (cmd: string): boolean => {
      try {
        const result = spawnSync('where.exe', [cmd], { stdio: ['ignore', 'pipe', 'pipe'] })
        return result.status === 0 && result.stdout && result.stdout.toString().trim().length > 0
      } catch {
        return false
      }
    }
    const hasPwsh = probeShell('pwsh.exe')
    const hasPs5 = probeShell('powershell.exe')
    if (!hasPwsh && !hasPs5) {
      const { dialog, shell } = await import('electron')
      const choice = await dialog.showMessageBox({
        type: 'error',
        title: 'PowerShell required',
        message: 'Onward requires PowerShell on Windows.',
        detail: 'Install PowerShell 7+ from https://aka.ms/powershell, then relaunch Onward. Windows PowerShell 5.1 (preinstalled on Windows 10/11) also works.',
        buttons: ['Open install guide', 'Quit'],
        defaultId: 0,
        cancelId: 1
      })
      if (choice.response === 0) {
        try { await shell.openExternal('https://aka.ms/powershell') } catch { /* ignore */ }
      }
      app.exit(1)
      return
    }
  }

  // Windows: check for a pending update that wasn't applied during the
  // previous quit (e.g. the helper script was killed by Job Object cleanup).
  // If found, launch the update script and exit immediately so the script
  // can replace the app files and relaunch.
  if (applyPendingUpdateOnStartup()) {
    console.log('[UpdateService] Startup recovery: update script launched, exiting.')
    app.exit(0)
    return
  }

  // Autotest: skip the first-run consent dialog. Logs on startup per the
  // debug-env-variable convention; no persisted state is touched.
  if (process.env.ONWARD_AUTOTEST_SKIP_CONSENT === '1') {
    console.log('[Telemetry] Consent dialog suppressed (ONWARD_AUTOTEST_SKIP_CONSENT=1); effective consent = declined')
  } else if (process.env.ONWARD_AUTOTEST === '1') {
    console.log('[Telemetry] Consent dialog suppressed in autotest mode (ONWARD_AUTOTEST=1); effective consent = declined. Set ONWARD_TELEMETRY_RESET_CONSENT=1 to override with a real consent = true.')
  }

  // Debug: reset telemetry consent
  if (TELEMETRY_RESET_CONSENT) {
    const isAutotest = process.env.ONWARD_AUTOTEST === '1'
    if (isAutotest) {
      // Autotest mode: enable telemetry with a fresh instanceId so events flow immediately
      const { randomUUID } = require('crypto')
      getSettingsStorage().setTelemetryConsent(true, randomUUID())
      // Clear the local log file for a clean test run
      const logPath = join(app.getPath('userData'), 'telemetry-events.jsonl')
      try { require('fs').writeFileSync(logPath, '', 'utf-8') } catch {}
      console.log('[Telemetry] Consent set to true for autotest (ONWARD_TELEMETRY_RESET_CONSENT=1)')
    } else {
      // Manual debug mode: reset to null so the consent dialog appears
      getSettingsStorage().setTelemetryConsent(null, null)
      console.log('[Telemetry] Consent reset to null for debugging (ONWARD_TELEMETRY_RESET_CONSENT=1)')
    }
  }

  // Debug: surface the Prompt virtual-cursor kill switch so it's obvious
  // when a user/CI is running without click-anywhere-to-type.
  if (process.env.ONWARD_DISABLE_VIRTUAL_CURSOR === '1') {
    console.log('[PromptEditor] Virtual cursor disabled (ONWARD_DISABLE_VIRTUAL_CURSOR=1); falling back to plain line-by-line input.')
  }

  // Initialize telemetry (reads consent from settings; no-op if not consented)
  getTelemetryService().initialize()
  getTelemetryService().track('session/start')

  // Set up the application menu (contains the Edit menu to enable standard editing shortcuts)
  Menu.setApplicationMenu(Menu.buildFromTemplate(buildMenuTemplate(appInfo.displayName)))

  // Set macOS Dock icon
  if (process.platform === 'darwin' && app.dock) {
    const iconPath = getIconPath()
    console.log('[Dock] Icon path:', iconPath)

    const fs = require('fs')
    console.log('[Dock] File exists:', fs.existsSync(iconPath))

    const icon = nativeImage.createFromPath(iconPath)
    console.log('[Dock] Icon size:', icon.getSize())

    if (!icon.isEmpty()) {
      app.dock.setIcon(icon)
      console.log('[Dock] Icon set!')
    } else {
      console.log('[Dock] Icon is empty, not setting')
    }
  }

  createWindow(appInfo.displayName)

  // Start telemetry heartbeat with focus tracking (requires mainWindow)
  if (mainWindow) {
    startSessionHeartbeat(mainWindow)
  }

  // Initialize system tray
  if (mainWindow) {
    getTrayManager().init(mainWindow, appInfo.displayName)
  }

  // Start HTTP API Server (for use by onward-bridge CLI)
  if (mainWindow) {
    startApiServer(mainWindow, {
      onRestartToApplyUpdate: requestRestartToApplyUpdate,
      onGracefulQuitForDebug: requestQuitForDebug
    }).catch((error) => {
      console.error('[API Server] Failed to start:', error)
    })
    getUpdateService().start(mainWindow)
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow(appInfo.displayName)
    } else if (mainWindow) {
      // macOS: Show window when clicking Dock icon
      getTrayManager().showWindow()
    }
  })
})

app.on('window-all-closed', async () => {
  await cleanupIpcHandlers().catch((error) => {
    console.warn('[Lifecycle] window-all-closed cleanup failed:', error)
  })
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

app.on('before-quit', async (e) => {
  performanceTrace.record(PERF_TRACE_EVENT.MAIN_APP_BEFORE_QUIT, {
    isQuitting,
    installUpdateOnQuit
  })
  // If you have confirmed to exit, continue directly.
  if (isQuitting) return
  if (!app.isReady()) {
    isQuitting = true
    return
  }

  // Prevent default exit and show confirmation dialog
  e.preventDefault()

  try {
    await requestQuit()
  } catch (error) {
    console.warn('[Lifecycle] before-quit confirmation failed:', error)
  }
})

// Move the cleanup logic to will-quit (it will be triggered after confirming the exit)
app.on('will-quit', () => {
  performanceTrace.record(PERF_TRACE_EVENT.MAIN_APP_WILL_QUIT, {
    installUpdateOnQuit
  })
  if (installUpdateOnQuit) {
    getUpdateService().installDownloadedUpdateOnQuit()
  }
  getUpdateService().stop()
  stopApiServer()
  void cleanupIpcHandlers().catch((error) => {
    console.warn('[Lifecycle] will-quit cleanup failed:', error)
  })
  performanceTrace.stop()
  // Close the shared trace store last so any final performanceTrace.stop()
  // events are written before we fsync + unlink the active chunk's stream.
  traceStore.close()
  getTrayManager().destroy()
})
