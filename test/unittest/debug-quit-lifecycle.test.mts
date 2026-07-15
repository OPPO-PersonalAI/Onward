/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { runBoundedDebugQuit } from '../../electron/main/debug-quit-lifecycle.ts'

interface Harness {
  scheduledCallback: (() => void) | null
  scheduledDelay: number | null
  quitCalls: number
  forcedExitCodes: number[]
  hardExitCalls: number
  teardownErrors: unknown[]
}

function createHarness(): Harness {
  return {
    scheduledCallback: null,
    scheduledDelay: null,
    quitCalls: 0,
    forcedExitCodes: [],
    hardExitCalls: 0,
    teardownErrors: []
  }
}

function optionsFor(harness: Harness, gracefulTeardown: () => Promise<void>) {
  return {
    hardExitMs: 20_000,
    gracefulTeardown,
    scheduleHardExit: (callback: () => void, delayMs: number) => {
      harness.scheduledCallback = callback
      harness.scheduledDelay = delayMs
    },
    requestQuit: () => {
      harness.quitCalls += 1
    },
    forceExit: (code: number) => {
      harness.forcedExitCodes.push(code)
    },
    onHardExit: () => {
      harness.hardExitCalls += 1
    },
    onTeardownError: (error: unknown) => {
      harness.teardownErrors.push(error)
    }
  }
}

describe('bounded debug quit lifecycle', () => {
  it('keeps the hard-exit guard armed after graceful teardown and app.quit()', async () => {
    const harness = createHarness()

    await runBoundedDebugQuit(optionsFor(harness, async () => {}))

    assert.equal(harness.scheduledDelay, 20_000)
    assert.equal(harness.quitCalls, 1)
    assert.deepEqual(harness.forcedExitCodes, [])

    harness.scheduledCallback?.()
    assert.equal(harness.hardExitCalls, 1)
    assert.deepEqual(harness.forcedExitCodes, [0])
  })

  it('forces exit when graceful teardown itself exceeds the deadline', async () => {
    const harness = createHarness()
    let finishTeardown: (() => void) | null = null
    const teardown = new Promise<void>((resolve) => {
      finishTeardown = resolve
    })
    const quitPromise = runBoundedDebugQuit(optionsFor(harness, () => teardown))

    assert.equal(harness.quitCalls, 0)
    harness.scheduledCallback?.()
    assert.equal(harness.hardExitCalls, 1)
    assert.deepEqual(harness.forcedExitCodes, [0])

    finishTeardown?.()
    await quitPromise
    assert.equal(harness.quitCalls, 0)
  })

  it('reports teardown errors and still requests graceful quit', async () => {
    const harness = createHarness()
    const failure = new Error('cleanup failed')

    await runBoundedDebugQuit(optionsFor(harness, async () => {
      throw failure
    }))

    assert.deepEqual(harness.teardownErrors, [failure])
    assert.equal(harness.quitCalls, 1)
    assert.deepEqual(harness.forcedExitCodes, [])
  })
})
