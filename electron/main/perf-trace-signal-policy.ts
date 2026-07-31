/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * After the trace store flushed on SIGTERM/SIGINT, who terminates the
 * process? In the Electron main process the lifecycle signal handlers
 * (electron/main/index.ts) own the bounded graceful quit — re-raising here
 * would race them. A worker / utility process has no such owner, so the
 * signal must be re-raised after the `once` handler is consumed to restore
 * the default termination; the pre-fix flush-only handler swallowed the
 * signal and left the process immortal under SIGTERM (2026-07-31
 * investigation). Leaf module with zero imports so the unit test can load
 * it without the bundler.
 */
export function shouldReRaiseSignalAfterTraceFlush(hasElectronApp: boolean): boolean {
  return !hasElectronApp
}
