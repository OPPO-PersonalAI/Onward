/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

export interface BoundedDebugQuitOptions {
  hardExitMs: number
  gracefulTeardown: () => Promise<void>
  scheduleHardExit: (callback: () => void, delayMs: number) => unknown
  requestQuit: () => void
  forceExit: (code: number) => void
  onHardExit: () => void
  onTeardownError: (error: unknown) => void
}

/**
 * Keeps the hard-exit guard armed across both teardown and app.quit().
 * A successful app.quit() terminates the process before the guard fires;
 * if Electron stalls after app.quit() returns, the same guard still exits it.
 */
export async function runBoundedDebugQuit(options: BoundedDebugQuitOptions): Promise<void> {
  let hardExitRequested = false

  options.scheduleHardExit(() => {
    hardExitRequested = true
    options.onHardExit()
    options.forceExit(0)
  }, options.hardExitMs)

  try {
    await options.gracefulTeardown()
  } catch (error) {
    options.onTeardownError(error)
  }

  if (!hardExitRequested) {
    options.requestQuit()
  }
}
