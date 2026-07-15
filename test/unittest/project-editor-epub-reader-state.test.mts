/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import {
  acceptEpubRelocation,
  beginEpubDisplayAttempt,
  beginEpubReaderSession,
  createSerialEpubTaskCoordinator,
  disposeEpubReaderSession,
  isCurrentEpubSessionEvent,
  isEpubFrameContentReady,
  shouldPersistEpubScroll,
  settleEpubDisplayAttempt
} from '../../src/components/ProjectEditor/epubReaderState.ts'

const FILE_PATH = 'books/manual.epub'
const TARGET_CFI = 'epubcfi(/6/4!/4/2/2)'

function beginReadySession(sessionId = 1, restoreTarget: string | null = TARGET_CFI) {
  const initial = beginEpubReaderSession({ sessionId, filePath: FILE_PATH, restoreTarget })
  const started = beginEpubDisplayAttempt(initial, restoreTarget)
  return settleEpubDisplayAttempt(started, {
    sessionId,
    attemptId: started.latestAttemptId
  })
}

test('PERS-U-01 same-path reload rejects events from the previous session', () => {
  const oldSession = beginReadySession(1)
  const currentSession = beginEpubReaderSession({
    sessionId: 2,
    filePath: oldSession.filePath,
    restoreTarget: TARGET_CFI
  })
  const started = beginEpubDisplayAttempt(currentSession, TARGET_CFI)
  const ready = settleEpubDisplayAttempt(started, {
    sessionId: 2,
    attemptId: started.latestAttemptId
  })

  assert.equal(isCurrentEpubSessionEvent(ready, 1), false)
  assert.equal(acceptEpubRelocation(ready, {
    sessionId: 1,
    cfi: TARGET_CFI,
    href: 'OEBPS/chapter2.xhtml'
  }).accepted, false)
})

test('PERS-U-02 only the latest display attempt can settle', () => {
  const session = beginEpubReaderSession({ sessionId: 3, filePath: FILE_PATH, restoreTarget: TARGET_CFI })
  const first = beginEpubDisplayAttempt(session, TARGET_CFI)
  const second = beginEpubDisplayAttempt(first, TARGET_CFI)
  const staleSettlement = settleEpubDisplayAttempt(second, {
    sessionId: 3,
    attemptId: first.latestAttemptId
  })

  assert.equal(staleSettlement, second)
  assert.equal(staleSettlement.settledAttemptId, null)

  const currentSettlement = settleEpubDisplayAttempt(staleSettlement, {
    sessionId: 3,
    attemptId: second.latestAttemptId
  })
  assert.equal(currentSettlement.settledAttemptId, second.latestAttemptId)
})

test('PERS-U-03 relocation cannot persist before the latest attempt settles', () => {
  const session = beginEpubReaderSession({ sessionId: 4, filePath: FILE_PATH, restoreTarget: TARGET_CFI })
  const started = beginEpubDisplayAttempt(session, TARGET_CFI)

  const early = acceptEpubRelocation(started, {
    sessionId: 4,
    cfi: TARGET_CFI,
    href: 'chapter2.xhtml'
  })
  assert.equal(early.accepted, false)
  assert.equal(early.state.restoreTargetConfirmed, false)
})

test('PERS-U-04 restore target must match before normal relocations are accepted', () => {
  const ready = beginReadySession(5)
  const wrong = acceptEpubRelocation(ready, {
    sessionId: 5,
    cfi: 'epubcfi(/6/2!/4/2/2)',
    href: 'chapter1.xhtml'
  })
  assert.equal(wrong.accepted, false)

  const restored = acceptEpubRelocation(wrong.state, {
    sessionId: 5,
    cfi: TARGET_CFI,
    href: 'chapter2.xhtml'
  })
  assert.equal(restored.accepted, true)
  assert.equal(restored.location, TARGET_CFI)
  assert.equal(restored.state.restoreTargetConfirmed, true)
  assert.equal(restored.state.readyAttemptId, restored.state.latestAttemptId)

  const userNavigation = acceptEpubRelocation(restored.state, {
    sessionId: 5,
    cfi: 'epubcfi(/6/6!/4/2/2)',
    href: 'chapter3.xhtml'
  })
  assert.equal(userNavigation.accepted, true)
})

test('PERS-U-05 href targets ignore fragments and tolerate an EPUB root prefix', () => {
  const target = 'chapter2.xhtml#details'
  const ready = beginReadySession(6, target)
  const relocation = acceptEpubRelocation(ready, {
    sessionId: 6,
    cfi: 'epubcfi(/6/4!/4/2/2)',
    href: 'OEBPS/chapter2.xhtml#visible'
  })

  assert.equal(relocation.accepted, true)
  assert.equal(relocation.href, 'OEBPS/chapter2.xhtml')
})

test('PERS-U-06 disposed sessions reject attempts, settlements and relocations', () => {
  const ready = beginReadySession(7)
  const disposed = disposeEpubReaderSession(ready, 7)
  const attempt = beginEpubDisplayAttempt(disposed, TARGET_CFI)

  assert.equal(disposed.disposed, true)
  assert.equal(isCurrentEpubSessionEvent(disposed, 7), false)
  assert.equal(attempt, disposed)
  assert.equal(settleEpubDisplayAttempt(disposed, { sessionId: 7, attemptId: 1 }), disposed)
  assert.equal(acceptEpubRelocation(disposed, { sessionId: 7, cfi: TARGET_CFI }).accepted, false)
})

test('PERS-U-07 restore target is snapshotted per session and per attempt', () => {
  const input = { sessionId: 8, filePath: FILE_PATH, restoreTarget: TARGET_CFI }
  const session = beginEpubReaderSession(input)
  input.restoreTarget = 'chapter1.xhtml'
  assert.equal(session.restoreTarget, TARGET_CFI)

  const first = beginEpubDisplayAttempt(session, session.restoreTarget)
  const second = beginEpubDisplayAttempt(first, 'chapter3.xhtml#section')
  assert.equal(first.restoreTarget, TARGET_CFI)
  assert.equal(second.restoreTarget, 'chapter3.xhtml#section')
  assert.equal(second.latestTarget, 'chapter3.xhtml#section')
  assert.equal(second.restoreTargetKind, 'href')
})

test('PERS-U-08 frame readiness requires an iframe and materialized body content', () => {
  assert.equal(isEpubFrameContentReady({ hasFrame: false, bodyChildCount: 1, bodyTextLength: 10 }), false)
  assert.equal(isEpubFrameContentReady({ hasFrame: true, bodyChildCount: 0, bodyTextLength: 0 }), false)
  assert.equal(isEpubFrameContentReady({ hasFrame: true, bodyChildCount: 0, bodyTextLength: 10 }), true)
  assert.equal(isEpubFrameContentReady({ hasFrame: true, bodyChildCount: 1, bodyTextLength: 0 }), true)
})

test('PERS-U-09 serial task coordinator never runs tasks concurrently', async () => {
  const coordinator = createSerialEpubTaskCoordinator()
  let active = 0
  let maxActive = 0
  const order: string[] = []

  const run = (name: string, delayMs: number) => coordinator.enqueue(async () => {
    active += 1
    maxActive = Math.max(maxActive, active)
    order.push(`${name}:start`)
    await new Promise(resolve => setTimeout(resolve, delayMs))
    order.push(`${name}:end`)
    active -= 1
    return name
  })

  const results = await Promise.all([run('one', 15), run('two', 1), run('three', 1)])
  assert.equal(maxActive, 1)
  assert.deepEqual(order, [
    'one:start', 'one:end',
    'two:start', 'two:end',
    'three:start', 'three:end'
  ])
  assert.deepEqual(results.map(result => result.status), ['completed', 'completed', 'completed'])
})

test('PERS-U-10 serial task coordinator skips queued work after disposal', async () => {
  const coordinator = createSerialEpubTaskCoordinator()
  let releaseFirst!: () => void
  const firstGate = new Promise<void>(resolve => { releaseFirst = resolve })
  const ran: string[] = []

  const first = coordinator.enqueue(async () => {
    ran.push('first')
    await firstGate
    return 1
  })
  const queued = coordinator.enqueue(() => {
    ran.push('queued')
    return 2
  })
  await Promise.resolve()
  coordinator.dispose()
  releaseFirst()

  const [firstResult, queuedResult, lateResult] = await Promise.all([
    first,
    queued,
    coordinator.enqueue(() => {
      ran.push('late')
      return 3
    })
  ])
  assert.equal(coordinator.isDisposed(), true)
  assert.deepEqual(ran, ['first'])
  assert.equal(firstResult.status, 'skipped')
  assert.equal(queuedResult.status, 'skipped')
  assert.equal(lateResult.status, 'skipped')
})

test('PERS-U-11 a failed task does not block the next queued task', async () => {
  const coordinator = createSerialEpubTaskCoordinator()
  const failed = coordinator.enqueue(() => {
    throw new Error('expected')
  })
  const next = coordinator.enqueue(() => 42)

  await assert.rejects(failed, /expected/)
  assert.deepEqual(await next, { status: 'completed', value: 42 })
})

test('PERS-U-12 default opening becomes ready after its first settled relocation', () => {
  const session = beginEpubReaderSession({ sessionId: 9, filePath: FILE_PATH })
  const started = beginEpubDisplayAttempt(session)
  const settled = settleEpubDisplayAttempt(started, {
    sessionId: 9,
    attemptId: started.latestAttemptId
  })
  const relocated = acceptEpubRelocation(settled, {
    sessionId: 9,
    cfi: 'epubcfi(/6/2!/4/2/2)',
    href: 'chapter1.xhtml'
  })

  assert.equal(relocated.accepted, true)
  assert.equal(relocated.state.readyAttemptId, started.latestAttemptId)
})

test('PERS-U-13 scroll persistence stays suppressed throughout restoration', () => {
  assert.equal(shouldPersistEpubScroll(1000, Number.POSITIVE_INFINITY), false)
  assert.equal(shouldPersistEpubScroll(1000, 1200), false)
  assert.equal(shouldPersistEpubScroll(1200, 1200), true)
  assert.equal(shouldPersistEpubScroll(1201, 1200), true)
})
