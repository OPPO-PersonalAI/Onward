/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 *
 * Pure decision model for the libuv threadpool watchdog.
 *
 * The watchdog periodically submits a trivial threadpool operation (a
 * 1-byte zlib.gzip — pure CPU, guaranteed to route through the libuv
 * threadpool, never touches disk) and races it against a timer. This
 * module owns the *decision* half of that loop: how many consecutive
 * probe timeouts constitute a stall, when the pool is considered
 * recovered, and which transitions deserve a trace event. Keeping it
 * pure lets the full table live in a plain-Node unit test.
 *
 * Background: a production incident (2026-07-20) left all four libuv
 * workers parked in uv_cond_wait forever after a macOS display-sleep /
 * remote-desktop disconnect boundary. Every async fs/dns/zlib/crypto
 * callback silently queued forever while timers, IPC and uv streams
 * stayed healthy. The stall is invisible to the existing event-loop
 * monitor, is not recoverable in-process, and has no upstream fix —
 * detection plus degradation is the designed response.
 */

export type ThreadpoolProbeOutcome = 'success' | 'timeout'

export type ThreadpoolStatus = 'ok' | 'suspect' | 'stalled'

export interface ThreadpoolHealthState {
  status: ThreadpoolStatus
  consecutiveFailures: number
  /** Epoch ms of the first probe timeout in the current failure run. */
  firstFailureAt: number | null
  /** Epoch ms when the stall was declared (null while not stalled). */
  stalledSince: number | null
  /** How many times the pool stalled and later recovered this session. */
  recoveries: number
}

export type ThreadpoolHealthEvent = 'stall-detected' | 'recovered'

export interface ThreadpoolHealthTransition {
  next: ThreadpoolHealthState
  events: ThreadpoolHealthEvent[]
}

/** Consecutive probe timeouts required to declare the pool stalled. */
export const THREADPOOL_STALL_THRESHOLD = 2

export function initialThreadpoolHealthState(): ThreadpoolHealthState {
  return {
    status: 'ok',
    consecutiveFailures: 0,
    firstFailureAt: null,
    stalledSince: null,
    recoveries: 0
  }
}

/**
 * Fold one probe outcome into the state. Pure — the caller supplies the
 * clock so tests can pin time.
 */
export function reduceThreadpoolProbe(
  state: ThreadpoolHealthState,
  outcome: ThreadpoolProbeOutcome,
  nowMs: number
): ThreadpoolHealthTransition {
  if (outcome === 'success') {
    if (state.status === 'stalled') {
      // Theoretically possible (the kernel could deliver the lost wakeup
      // late); observed never in the incident, but the model must handle it.
      return {
        next: {
          status: 'ok',
          consecutiveFailures: 0,
          firstFailureAt: null,
          stalledSince: null,
          recoveries: state.recoveries + 1
        },
        events: ['recovered']
      }
    }
    if (state.status === 'ok' && state.consecutiveFailures === 0) {
      return { next: state, events: [] }
    }
    return {
      next: { ...state, status: 'ok', consecutiveFailures: 0, firstFailureAt: null },
      events: []
    }
  }

  const consecutiveFailures = state.consecutiveFailures + 1
  const firstFailureAt = state.firstFailureAt ?? nowMs

  if (state.status === 'stalled') {
    // Already declared; keep counting, no duplicate event.
    return {
      next: { ...state, consecutiveFailures, firstFailureAt },
      events: []
    }
  }

  if (consecutiveFailures >= THREADPOOL_STALL_THRESHOLD) {
    return {
      next: {
        status: 'stalled',
        consecutiveFailures,
        firstFailureAt,
        stalledSince: nowMs,
        recoveries: state.recoveries
      },
      events: ['stall-detected']
    }
  }

  return {
    next: { ...state, status: 'suspect', consecutiveFailures, firstFailureAt },
    events: []
  }
}
