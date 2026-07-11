/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Pure decision gate for reusing a presupplied ("warm") `git status` payload
 * inside a diff (re)compute, extracted so the rule is unit-testable in plain
 * Node (see test/unittest/git-diff-warm-status-invalidation-gate.test.mts).
 *
 * Why the invalidation clause exists (GDS-07 root cause, 2026-07-11): a
 * known-mutation invalidation (file save / stage / discard) wipes every diff
 * cache and schedules a quiet-window re-warm. That re-warm used to reuse any
 * mirror status younger than the age cap — including one captured BEFORE the
 * mutation that triggered the invalidation. The re-computed diff then
 * repopulated the just-cleared caches with pre-mutation state, and with the
 * invalidation authority already spent (and no mirror subscription for the
 * repo to fire a later delta), the staleness was permanent. Requiring the
 * capture to be STRICTLY NEWER than the repo's latest mutation-grade
 * invalidation closes the loop; the fallback is one `git status` spawn that
 * the mutation made necessary anyway.
 */

/** Max age at which a warm may reuse the mirror's presupplied status. */
export const WARM_STATUS_REUSE_MAX_AGE_MS = 15_000

export interface WarmStatusReuseInput {
  /** When the presupplied status payload was captured (epoch ms). */
  capturedAt: number
  /** Current clock (epoch ms) — injected for testability. */
  now: number
  /**
   * When the repo last received a mutation-grade cache invalidation
   * ('manual' / 'force' / 'watcher-error'), or null if never. 'mirror'
   * invalidations do NOT count: the status accompanying a mirror update IS
   * the fresh truth that caused the invalidation, so rejecting it would
   * defeat the warm-reuse optimisation without any correctness gain.
   */
  lastInvalidatedAt: number | null
  /** Age ceiling override; defaults to WARM_STATUS_REUSE_MAX_AGE_MS. */
  maxAgeMs?: number
}

export type WarmStatusReuseDecision =
  | { reuse: true; ageMs: number }
  | { reuse: false; ageMs: number; reason: 'stale' | 'invalidated' }

export function shouldReuseWarmStatus(input: WarmStatusReuseInput): WarmStatusReuseDecision {
  const maxAgeMs = input.maxAgeMs ?? WARM_STATUS_REUSE_MAX_AGE_MS
  const ageMs = input.now - input.capturedAt
  if (ageMs < 0 || ageMs > maxAgeMs) {
    return { reuse: false, ageMs, reason: 'stale' }
  }
  // Equal timestamps are rejected too: a capture in the same millisecond as
  // the invalidation cannot prove it observed the post-mutation state, and
  // the safe direction is one extra spawn, never a stale rebuild.
  if (input.lastInvalidatedAt !== null && input.capturedAt <= input.lastInvalidatedAt) {
    return { reuse: false, ageMs, reason: 'invalidated' }
  }
  return { reuse: true, ageMs }
}
