/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

import { strict as assert } from 'node:assert'
import { test } from 'node:test'

import {
  DIFF_LOAD_WATCHDOG_ERROR_MARKER,
  isWatchdogTimeoutError,
  makeWatchdogTimeoutError
} from '../../src/components/GitDiffViewer/watchdogTimeoutError.ts'

// This locks the decision table that GitDiffViewer.loadDiff's catch relies on:
// only an error built by makeWatchdogTimeoutError must be treated as a watchdog
// abort (preserve the painted file list). Everything else is a genuine load
// failure (surface the empty error result). A wrong answer here either silently
// blanks the diff list on a slow-but-live reload (the round-4 image-diff
// regression) or hides a real load failure behind a stale list.

test('makeWatchdogTimeoutError produces a tagged Error with the elapsed ms in the message', () => {
  const err = makeWatchdogTimeoutError(30000)
  assert.ok(err instanceof Error)
  assert.match(err.message, /watchdog fired after 30000ms/)
  assert.equal(
    (err as unknown as Record<string, unknown>)[DIFF_LOAD_WATCHDOG_ERROR_MARKER],
    true
  )
})

test('isWatchdogTimeoutError returns true ONLY for a makeWatchdogTimeoutError error', () => {
  assert.equal(isWatchdogTimeoutError(makeWatchdogTimeoutError(1)), true)
  assert.equal(isWatchdogTimeoutError(makeWatchdogTimeoutError(95000)), true)
})

test('isWatchdogTimeoutError returns false for a plain Error (genuine load failure path)', () => {
  // A worker-returned rejection / non-repo error arrives as a plain Error and
  // MUST fall through to the empty-error-result branch, not preserve a stale list.
  assert.equal(isWatchdogTimeoutError(new Error('getDiff failed: not a git repository')), false)
  assert.equal(isWatchdogTimeoutError(new TypeError('boom')), false)
})

test('isWatchdogTimeoutError returns false for non-error rejection values', () => {
  assert.equal(isWatchdogTimeoutError(undefined), false)
  assert.equal(isWatchdogTimeoutError(null), false)
  assert.equal(isWatchdogTimeoutError('getDiff IPC watchdog fired after 30000ms'), false)
  assert.equal(isWatchdogTimeoutError(0), false)
  assert.equal(isWatchdogTimeoutError({ message: 'looks like one but is not tagged' }), false)
})

test('a manually-constructed object carrying the marker is recognised (defensive equality)', () => {
  // The detection is structural (marker === true), so an equivalently-tagged
  // object is accepted. This documents the contract: the marker, not identity,
  // is the signal.
  const faux = { [DIFF_LOAD_WATCHDOG_ERROR_MARKER]: true }
  assert.equal(isWatchdogTimeoutError(faux), true)
  // A falsy / wrong-typed marker value is rejected.
  assert.equal(isWatchdogTimeoutError({ [DIFF_LOAD_WATCHDOG_ERROR_MARKER]: false }), false)
  assert.equal(isWatchdogTimeoutError({ [DIFF_LOAD_WATCHDOG_ERROR_MARKER]: 'true' }), false)
})
