/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 *
 * Pure decision model for the renderer-visibility watchdog.
 *
 * Failure class (2026-07-20 incident): after a macOS display-sleep /
 * remote-desktop disconnect boundary, Chromium left the renderer's
 * `document.visibilityState` at 'hidden' for ~10 hours while the window
 * was frontmost and receiving input — no rAF, no paint, DOM mutating
 * invisibly. Recovery via the native `visibilitychange -> visible` event
 * proved non-deterministic (one frontmost interaction recovered it,
 * another did not), so the app cannot bet on the event arriving.
 *
 * This module owns the decisions: what counts as a mismatch, how many
 * consecutive mismatches trigger a nudge, the nudge escalation ladder,
 * and the cooldown that prevents a hide/show loop. The side-effect
 * plumbing lives in visibility-watchdog.ts.
 */

export interface VisibilityProbeReply {
  visibilityState: 'visible' | 'hidden' | 'prerender'
  hasFocus: boolean
  rafAlive: boolean
}

export interface VisibilityCheckInput {
  /** Main-side truth: window exists, isVisible() and not minimized. */
  windowVisible: boolean
  /** Renderer reply, or 'timeout' when no reply arrived in time. */
  probe: VisibilityProbeReply | 'timeout'
}

export type VisibilityVerdict = 'healthy' | 'not-applicable' | 'mismatch'

export function judgeVisibilityProbe(input: VisibilityCheckInput): VisibilityVerdict {
  if (!input.windowVisible) {
    // Window legitimately hidden/minimized — a hidden renderer is correct.
    return 'not-applicable'
  }
  if (input.probe === 'timeout') {
    // No reply at all: the preload responder is wedged too. Treat as
    // mismatch — the nudge ladder is the only lever we have.
    return 'mismatch'
  }
  if (input.probe.visibilityState !== 'visible') {
    return 'mismatch'
  }
  if (!input.probe.rafAlive) {
    // Correct visibility but no frames: paint-dead (GPU-side freeze
    // overlaps this symptom); the same nudges apply.
    return 'mismatch'
  }
  return 'healthy'
}

export type VisibilityNudgeLevel = 0 | 1 | 2

export type VisibilityWatchStatus = 'ok' | 'nudging' | 'gave-up'

export interface VisibilityWatchState {
  status: VisibilityWatchStatus
  consecutiveMismatches: number
  nudgeLevel: VisibilityNudgeLevel
  /** Epoch ms when the last nudge cycle ended in gave-up (cooldown anchor). */
  gaveUpAt: number | null
  recoveries: number
}

export type VisibilityAction =
  | 'record-mismatch'
  | 'nudge-throttle-toggle'
  | 'nudge-hide-show'
  | 'record-recovered'
  | 'record-gave-up'

export interface VisibilityTransition {
  next: VisibilityWatchState
  actions: VisibilityAction[]
}

/** Consecutive mismatched checks required before the first nudge. */
export const VISIBILITY_MISMATCH_THRESHOLD = 2
/** After a full failed nudge ladder, wait this long before trying again. */
export const VISIBILITY_NUDGE_COOLDOWN_MS = 5 * 60_000

export function initialVisibilityWatchState(): VisibilityWatchState {
  return { status: 'ok', consecutiveMismatches: 0, nudgeLevel: 0, gaveUpAt: null, recoveries: 0 }
}

export function reduceVisibilityCheck(
  state: VisibilityWatchState,
  verdict: VisibilityVerdict,
  nowMs: number
): VisibilityTransition {
  if (verdict === 'not-applicable') {
    // Legitimate hidden window resets the mismatch run but does not count
    // as a recovery — nothing was wrong.
    if (state.consecutiveMismatches === 0 && state.status === 'ok') {
      return { next: state, actions: [] }
    }
    return {
      next: { ...state, status: state.status === 'gave-up' ? 'gave-up' : 'ok', consecutiveMismatches: 0, nudgeLevel: 0 },
      actions: []
    }
  }

  if (verdict === 'healthy') {
    if (state.status === 'nudging' || state.status === 'gave-up' || state.consecutiveMismatches >= VISIBILITY_MISMATCH_THRESHOLD) {
      return {
        next: {
          status: 'ok',
          consecutiveMismatches: 0,
          nudgeLevel: 0,
          gaveUpAt: null,
          recoveries: state.recoveries + 1
        },
        actions: ['record-recovered']
      }
    }
    if (state.consecutiveMismatches === 0) {
      return { next: state, actions: [] }
    }
    return { next: { ...state, consecutiveMismatches: 0 }, actions: [] }
  }

  // verdict === 'mismatch'
  const consecutiveMismatches = state.consecutiveMismatches + 1

  if (state.status === 'gave-up') {
    if (state.gaveUpAt !== null && nowMs - state.gaveUpAt < VISIBILITY_NUDGE_COOLDOWN_MS) {
      // Still cooling down: keep observing, do not re-nudge.
      return { next: { ...state, consecutiveMismatches }, actions: [] }
    }
    // Cooldown over — restart the ladder from level 1.
    return {
      next: { status: 'nudging', consecutiveMismatches, nudgeLevel: 1, gaveUpAt: null, recoveries: state.recoveries },
      actions: ['record-mismatch', 'nudge-throttle-toggle']
    }
  }

  if (state.status === 'ok') {
    if (consecutiveMismatches < VISIBILITY_MISMATCH_THRESHOLD) {
      return { next: { ...state, consecutiveMismatches }, actions: [] }
    }
    return {
      next: { status: 'nudging', consecutiveMismatches, nudgeLevel: 1, gaveUpAt: null, recoveries: state.recoveries },
      actions: ['record-mismatch', 'nudge-throttle-toggle']
    }
  }

  // status === 'nudging': the previous nudge did not recover visibility.
  if (state.nudgeLevel === 1) {
    return {
      next: { ...state, consecutiveMismatches, nudgeLevel: 2 },
      actions: ['nudge-hide-show']
    }
  }
  return {
    next: { status: 'gave-up', consecutiveMismatches, nudgeLevel: 2, gaveUpAt: nowMs, recoveries: state.recoveries },
    actions: ['record-gave-up']
  }
}
