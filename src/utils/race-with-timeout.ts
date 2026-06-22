/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Race a promise against a timeout watchdog.
 *
 * Motivation: a main-process IPC worker has its own request timeout, but a
 * wedged / deduped reply can leave the renderer-side `invoke` promise pending
 * forever. Awaiting such a promise inside a load routine means the routine's
 * `finally` never runs, so any in-flight lock it holds leaks and freezes every
 * later operation (observed in GitDiffViewer: Keep/Deny + every later diff load
 * froze until the 180s autotest kill when a `getDiff` invoke never settled).
 *
 * This helper guarantees the caller's await settles within `timeoutMs`: if the
 * underlying promise has not resolved/rejected by then, the returned promise
 * rejects with a timeout error (after invoking the optional `onTimeout` hook for
 * a diagnostic breadcrumb). The watchdog timer is ALWAYS cleared so it cannot
 * leak or fire after the underlying promise wins the race.
 *
 * Pure timing-control logic — no DOM, no IPC — so it is unit-testable in plain
 * Node with fake timers / short real timers.
 *
 * @param work       the underlying promise (e.g. an IPC invoke)
 * @param timeoutMs  watchdog ceiling in milliseconds (must be finite, >= 0)
 * @param onTimeout  optional side-effect fired exactly once if the watchdog wins
 * @param makeError  optional custom error factory for the timeout rejection
 * @param scheduler  injectable setTimeout/clearTimeout (defaults to globalThis)
 */
export function raceWithTimeout<T>(
  work: Promise<T>,
  timeoutMs: number,
  onTimeout?: () => void,
  makeError: (ms: number) => Error = (ms) => new Error(`operation timed out after ${ms}ms`),
  scheduler: {
    setTimeout: (cb: () => void, ms: number) => unknown
    clearTimeout: (handle: unknown) => void
  } = {
    setTimeout: (cb, ms) => globalThis.setTimeout(cb, ms),
    clearTimeout: (handle) => globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>)
  }
): Promise<T> {
  if (!Number.isFinite(timeoutMs) || timeoutMs < 0) {
    throw new RangeError(`raceWithTimeout: timeoutMs must be a finite, non-negative number, got ${timeoutMs}`)
  }
  let handle: unknown
  let firedTimeout = false
  const watchdog = new Promise<never>((_, reject) => {
    handle = scheduler.setTimeout(() => {
      firedTimeout = true
      try {
        onTimeout?.()
      } finally {
        reject(makeError(timeoutMs))
      }
    }, timeoutMs)
  })
  return Promise.race([work, watchdog]).finally(() => {
    // Always clear the timer so the watchdog never fires after `work` won (which
    // would otherwise call onTimeout for an operation that already succeeded).
    if (!firedTimeout) {
      scheduler.clearTimeout(handle)
    }
  })
}
