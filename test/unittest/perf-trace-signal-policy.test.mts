/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 *
 * Locks the SIGTERM/SIGINT ownership split for the perf-trace flush handler:
 * the Electron MAIN process leaves exit sequencing to the lifecycle signal
 * handlers (electron/main/index.ts bounded no-confirm quit), while WORKER /
 * utility processes must re-raise so the default termination still happens.
 * The pre-fix flush-only `once` handler swallowed the signal in both
 * contexts (2026-07-31 SIGTERM investigation). The paired autotest
 * (run-signal-quit) proves the end-to-end process actually exits.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { shouldReRaiseSignalAfterTraceFlush } from '../../electron/main/perf-trace-signal-policy.ts'

test('PTS-U-01 the Electron main process must NOT re-raise (lifecycle owns the quit)', () => {
  assert.equal(shouldReRaiseSignalAfterTraceFlush(true), false)
})

test('PTS-U-02 worker processes MUST re-raise to restore default termination', () => {
  assert.equal(shouldReRaiseSignalAfterTraceFlush(false), true)
})
