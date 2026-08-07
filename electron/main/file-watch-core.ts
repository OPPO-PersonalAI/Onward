/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 *
 * Pure decision core for the single-file watcher. No fs, no timers, no
 * Electron — every function here is a total function over plain data so the
 * suppress/emit semantics can be locked by unit tests (FWB-U-*) without an
 * Electron build.
 *
 * The self-write problem this solves: the app saves files it is also
 * watching. PDF saves go through temp-file + fsync + rename, which surfaces
 * as a `rename` event and a watcher rebuild — a path the old time-window
 * suppression never covered, so every annotation autosave would have
 * triggered a spurious self-refresh. Instead of guessing by time, the writer
 * registers the exact fingerprint (size + sha256) of the bytes it wrote; at
 * settle time the disk state either matches that fingerprint (our own write —
 * update the baseline silently) or it does not (a real external change —
 * emit). External writes that land inside the old 1s window are no longer
 * swallowed.
 */

export type WatchMode = 'text' | 'binary'

/** Baseline identity of the file content as last emitted/adopted. */
export interface DiskFingerprint {
  size: number
  mtimeMs: number
  /** sha256 hex; null when the file was over the hash budget at capture time. */
  hash: string | null
}

/** Registered by a writer right after it persists bytes to the watched path. */
export interface ExpectedWrite {
  size: number
  /** sha256 hex of the exact bytes written. */
  hash: string
  /** Absolute ms timestamp after which this registration is stale. */
  expiresAt: number
}

/**
 * Files above this size skip routine hashing on every settle; identity falls
 * back to size+mtime. Matches the annotation store's large-file threshold so
 * the two layers agree on what "large" means.
 */
export const HASH_MAX_BYTES = 20 * 1024 * 1024

/**
 * How long a registered self-write fingerprint stays valid. The debounce
 * (400 ms) plus the rename-rebuild delay (500 ms) settle well inside this;
 * the margin covers slow disks without letting a stale registration linger.
 */
export const EXPECTED_WRITE_TTL_MS = 5000

export type SettleAction = 'skip-own-write' | 'skip-unchanged' | 'emit-changed'

export type StatClassification = 'unchanged' | 'changed' | 'need-hash'

/**
 * First-stage change classification for binary mode from stat data alone.
 * Only when size is identical but mtime moved do we need the hash to tell a
 * touch from a rewrite; a baseline without a hash (large file) cannot confirm,
 * so it must err on the side of reporting a change.
 */
export function classifyStat(
  prev: Pick<DiskFingerprint, 'size' | 'mtimeMs' | 'hash'>,
  next: { size: number; mtimeMs: number }
): StatClassification {
  if (next.size !== prev.size) return 'changed'
  if (next.mtimeMs === prev.mtimeMs) return 'unchanged'
  return prev.hash === null ? 'changed' : 'need-hash'
}

/**
 * Whether the settle path should pay for hashing the file. Routine settles
 * hash only under the budget; a pending self-write registration of the same
 * size forces the hash even for large files — that one hash is what lets a
 * 100 MB annotation autosave be recognised as our own write instead of
 * triggering a self-refresh.
 */
export function shouldComputeHash(input: {
  size: number
  expected: ExpectedWrite | null
  nowMs: number
}): boolean {
  if (input.size <= HASH_MAX_BYTES) return true
  const expected = input.expected
  return Boolean(
    expected && input.nowMs <= expected.expiresAt && expected.size === input.size
  )
}

export function isExpectedWriteLive(expected: ExpectedWrite | null, nowMs: number): boolean {
  return Boolean(expected && nowMs <= expected.expiresAt)
}

/**
 * Final emit decision once disk state has been observed.
 *
 * Precedence matters: the own-write check runs before the baseline
 * comparison, because after our own save the baseline is stale by
 * construction (it still describes the pre-save content) — comparing against
 * it would always say "changed".
 */
export function resolveSettle(input: {
  nowMs: number
  expected: ExpectedWrite | null
  disk: { size: number; hash: string | null }
  baselineChanged: boolean
}): SettleAction {
  const { expected } = input
  if (
    expected &&
    input.nowMs <= expected.expiresAt &&
    input.disk.size === expected.size &&
    input.disk.hash !== null &&
    input.disk.hash === expected.hash
  ) {
    return 'skip-own-write'
  }
  if (!input.baselineChanged) return 'skip-unchanged'
  return 'emit-changed'
}

/**
 * Baseline comparison for binary mode. A null hash on either side (over
 * budget) degrades to size+mtime identity.
 */
export function binaryBaselineChanged(
  baseline: DiskFingerprint,
  disk: DiskFingerprint
): boolean {
  if (disk.size !== baseline.size) return true
  if (disk.hash !== null && baseline.hash !== null) return disk.hash !== baseline.hash
  return disk.mtimeMs !== baseline.mtimeMs
}
