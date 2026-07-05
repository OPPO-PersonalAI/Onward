/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

// Leaf module (zero imports) so plain-Node unit tests can load it without
// pulling the trace-store / worker_threads module graph behind
// performance-trace.ts.

/**
 * Wall-clock "now" in microseconds since the Unix epoch, for Chrome-trace
 * `ts` stamps.
 *
 * Why Date.now() instead of performance.timeOrigin + performance.now():
 * timeOrigin is frozen at process/worker start while the OS wall clock is
 * NTP-disciplined, so the monotonic sum drifts away from Date.now() on
 * long-lived processes. A production diagnostic bundle measured a constant
 * 5.011 s skew after ~4.2 days of uptime — every `ph:'X'` span stamped via
 * recordComplete()/timeAsync() landed seconds away from the
 * Date.now()-stamped record() events for the same operation, breaking
 * cross-thread alignment in Perfetto. Millisecond ts granularity is an
 * acceptable trade: span alignment is what trace consumers join on, and
 * duration payloads keep their own sub-ms precision where callers measure
 * with performance.now() deltas.
 */
export function wallNowUs(): number {
  return Date.now() * 1000
}
