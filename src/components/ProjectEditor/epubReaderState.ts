/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

export type EpubReaderSessionId = number

export type EpubRestoreTargetKind = 'cfi' | 'href' | 'none'

export interface EpubReaderSessionState {
  readonly sessionId: EpubReaderSessionId
  readonly filePath: string
  readonly restoreTarget: string | null
  readonly restoreTargetKind: EpubRestoreTargetKind
  readonly latestTarget: string | null
  readonly latestAttemptId: number
  readonly settledAttemptId: number | null
  readonly readyAttemptId: number | null
  readonly restoreTargetConfirmed: boolean
  readonly disposed: boolean
}

export interface BeginEpubReaderSessionInput {
  sessionId: EpubReaderSessionId
  filePath: string
  restoreTarget?: string | null
}

export interface EpubDisplayAttemptEvent {
  sessionId: EpubReaderSessionId
  attemptId: number
}

export interface EpubStateTransitionResult {
  state: EpubReaderSessionState
  accepted: boolean
}

export interface EpubRelocationEvent {
  sessionId: EpubReaderSessionId
  cfi?: string | null
  href?: string | null
}

export interface EpubRelocationAcceptance extends EpubStateTransitionResult {
  location: string | null
  cfi: string | null
  href: string | null
}

export interface EpubFrameContentSnapshot {
  hasFrame: boolean
  bodyChildCount: number
  bodyTextLength: number
}

export type SerialEpubTaskResult<T> =
  | { status: 'completed'; value: T }
  | { status: 'skipped' }

export interface SerialEpubTaskCoordinator {
  enqueue<T>(task: () => T | Promise<T>): Promise<SerialEpubTaskResult<T>>
  dispose(): void
  isDisposed(): boolean
}

export function shouldPersistEpubScroll(now: number, suppressedUntil: number): boolean {
  return now >= suppressedUntil
}

function normalizeTarget(target: string | null | undefined): string | null {
  if (typeof target !== 'string') return null
  const trimmed = target.trim()
  return trimmed.length > 0 ? trimmed : null
}

function targetKind(target: string | null): EpubRestoreTargetKind {
  if (!target) return 'none'
  return /^epubcfi\s*\(/i.test(target) ? 'cfi' : 'href'
}

function normalizeCfi(value: string | null | undefined): string | null {
  const normalized = normalizeTarget(value)
  return normalized && /^epubcfi\s*\(/i.test(normalized) ? normalized : null
}

function normalizeHref(value: string | null | undefined): string | null {
  const normalized = normalizeTarget(value)
  if (!normalized) return null
  const withoutFragment = normalized.split('#', 1)[0]?.split('?', 1)[0] ?? ''
  const slashNormalized = withoutFragment.replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '')
  if (!slashNormalized) return null
  try {
    return decodeURIComponent(slashNormalized)
  } catch {
    return slashNormalized
  }
}

function hrefsMatch(target: string, actual: string): boolean {
  const normalizedTarget = normalizeHref(target)
  const normalizedActual = normalizeHref(actual)
  if (!normalizedTarget || !normalizedActual) return false
  return normalizedTarget === normalizedActual
    || normalizedTarget.endsWith(`/${normalizedActual}`)
    || normalizedActual.endsWith(`/${normalizedTarget}`)
}

function relocationMatchesTarget(
  state: EpubReaderSessionState,
  cfi: string | null,
  href: string | null
): boolean {
  if (state.restoreTargetConfirmed || state.restoreTargetKind === 'none') return true
  if (!state.restoreTarget) return false
  if (state.restoreTargetKind === 'cfi') return cfi === state.restoreTarget
  return Boolean(href && hrefsMatch(state.restoreTarget, href))
}

export function beginEpubReaderSession({
  sessionId,
  filePath,
  restoreTarget
}: BeginEpubReaderSessionInput): EpubReaderSessionState {
  const target = normalizeTarget(restoreTarget)
  return {
    sessionId,
    filePath,
    restoreTarget: target,
    restoreTargetKind: targetKind(target),
    latestTarget: target,
    latestAttemptId: 0,
    settledAttemptId: null,
    readyAttemptId: null,
    restoreTargetConfirmed: target === null,
    disposed: false
  }
}

export function beginEpubDisplayAttempt(
  state: EpubReaderSessionState,
  target: string | null | undefined = state.restoreTarget
): EpubReaderSessionState {
  if (state.disposed) return state
  const restoreTarget = normalizeTarget(target)
  const attemptId = state.latestAttemptId + 1
  return {
    ...state,
    restoreTarget,
    restoreTargetKind: targetKind(restoreTarget),
    latestTarget: restoreTarget,
    latestAttemptId: attemptId,
    settledAttemptId: null,
    readyAttemptId: null,
    restoreTargetConfirmed: restoreTarget === null
  }
}

export function isCurrentEpubSessionEvent(
  state: EpubReaderSessionState,
  sessionId: EpubReaderSessionId
): boolean {
  return !state.disposed && state.sessionId === sessionId
}

export function settleEpubDisplayAttempt(
  state: EpubReaderSessionState,
  event: EpubDisplayAttemptEvent
): EpubReaderSessionState {
  if (
    !isCurrentEpubSessionEvent(state, event.sessionId)
    || event.attemptId !== state.latestAttemptId
  ) {
    return state
  }
  return {
    ...state,
    settledAttemptId: event.attemptId
  }
}

export function acceptEpubRelocation(
  state: EpubReaderSessionState,
  event: EpubRelocationEvent
): EpubRelocationAcceptance {
  const cfi = normalizeCfi(event.cfi)
  const href = normalizeHref(event.href)
  const location = cfi ?? href
  const isLatestAttemptSettled = state.latestAttemptId > 0
    && state.settledAttemptId === state.latestAttemptId
  const accepted = isCurrentEpubSessionEvent(state, event.sessionId)
    && isLatestAttemptSettled
    && location !== null
    && relocationMatchesTarget(state, cfi, href)

  if (!accepted) {
    return { state, accepted: false, location: null, cfi, href }
  }
  return {
    accepted: true,
    location,
    cfi,
    href,
    state: {
      ...state,
      restoreTargetConfirmed: true,
      readyAttemptId: state.latestAttemptId
    }
  }
}

export function disposeEpubReaderSession(
  state: EpubReaderSessionState,
  sessionId: EpubReaderSessionId
): EpubReaderSessionState {
  if (state.sessionId !== sessionId || state.disposed) return state
  return {
    ...state,
    settledAttemptId: null,
    readyAttemptId: null,
    disposed: true
  }
}

export function isEpubFrameContentReady({
  hasFrame,
  bodyChildCount,
  bodyTextLength
}: EpubFrameContentSnapshot): boolean {
  return hasFrame
    && Number.isFinite(bodyChildCount)
    && Number.isFinite(bodyTextLength)
    && bodyChildCount >= 0
    && bodyTextLength >= 0
    && (bodyChildCount > 0 || bodyTextLength > 0)
}

export function createSerialEpubTaskCoordinator(): SerialEpubTaskCoordinator {
  let disposed = false
  let tail: Promise<void> = Promise.resolve()

  const enqueue = <T>(task: () => T | Promise<T>): Promise<SerialEpubTaskResult<T>> => {
    const result = tail.then(async () => {
      if (disposed) return { status: 'skipped' as const }
      try {
        const value = await task()
        return disposed
          ? { status: 'skipped' as const }
          : { status: 'completed' as const, value }
      } catch (error) {
        if (disposed) return { status: 'skipped' as const }
        throw error
      }
    })
    tail = result.then(() => undefined, () => undefined)
    return result
  }

  return {
    enqueue,
    dispose() {
      disposed = true
    },
    isDisposed() {
      return disposed
    }
  }
}
