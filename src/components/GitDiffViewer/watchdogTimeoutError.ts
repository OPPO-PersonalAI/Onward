/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Watchdog-timeout error tagging for GitDiffViewer's `getDiff` IPC race.
 *
 * The renderer races each `getDiff` invoke against a watchdog (see
 * DIFF_LOAD_IPC_TIMEOUT_MS in GitDiffViewer.tsx). When the watchdog wins, the
 * underlying invoke never settled — the main-process git worker may still be
 * churning behind an EDR-throttled, concurrency-1 lane, or its reply was lost and
 * the lane only frees at the worker's own request timeout. That is NOT a
 * confirmed load failure.
 *
 * `loadDiff`'s catch MUST treat the two differently:
 *   - a genuine load failure (worker actively returned an error / non-repo
 *     result) → surface the empty error result;
 *   - a watchdog abort on a slow-but-live reload → PRESERVE the already-painted
 *     file list, because blanking it to `[]` silently destroyed the user's diff
 *     list and broke Keep/Deny + sibling file lookups (round-4 image-diff
 *     regression: the deny reload tripped the watchdog, the catch wiped the
 *     101-file list, and every later lookup saw an empty list).
 *
 * This module is the single source of truth for the sentinel + its detection, so
 * the decision is unit-testable in plain Node without importing the heavy
 * GitDiffViewer renderer component (and its Monaco dependency).
 */

/** Marker property attached to the watchdog-timeout Error. */
export const DIFF_LOAD_WATCHDOG_ERROR_MARKER = '__onwardGitDiffWatchdogTimeout'

/** Build a tagged watchdog-timeout error for `raceWithTimeout`'s makeError. */
export function makeWatchdogTimeoutError(ms: number): Error {
  const err = new Error(`getDiff IPC watchdog fired after ${ms}ms`)
  ;(err as unknown as Record<string, unknown>)[DIFF_LOAD_WATCHDOG_ERROR_MARKER] = true
  return err
}

/**
 * True only for an error produced by `makeWatchdogTimeoutError`. A plain Error,
 * a string, null/undefined, or any other rejection value returns false so the
 * catch falls through to the genuine-failure path.
 */
export function isWatchdogTimeoutError(error: unknown): boolean {
  return (
    Boolean(error) &&
    typeof error === 'object' &&
    (error as Record<string, unknown>)[DIFF_LOAD_WATCHDOG_ERROR_MARKER] === true
  )
}
