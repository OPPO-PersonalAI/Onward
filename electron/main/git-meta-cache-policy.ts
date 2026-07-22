/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Freshness policy for the `getGitRepoMeta` cache (git-op aggregation A1)
 * plus the repo-probe outcome classifier (RC-2 fix, 2026-07 bundles).
 *
 * Pure + leaf (no I/O, no Electron) so the decisions are unit-testable
 * without loading the heavy `git-utils` module. Shared by BOTH the main
 * process (`git-utils.getGitRepoMeta`) and the GitStateMirror worker
 * (`git-state-mirror-worker-entry.getRepoMeta`) so the two probes can never
 * drift in how they classify a failure.
 *
 * Rationale (A1, unchanged): a repo's `repoRoot` / `gitDir` are IMMUTABLE
 * for a given cwd path, so once resolved (a POSITIVE result,
 * `isRepo === true`) the entry never needs re-spawning `rev-parse` — it is
 * fresh forever. A NEGATIVE result (a directory that is not a git repo)
 * keeps the short TTL so a directory that is later `git init`'d is
 * rediscovered. The rare repo-deleted / worktree-moved case is handled by an
 * explicit `clearGitMetaCache()` escape hatch in git-utils.
 *
 * Rationale (RC-2, new): the 2026-07-17 bundle showed every `rev-parse`
 * against a network drive (Y:) killed at the 10 s budget and silently
 * classified as "not a repo" — wrong answer AND a 10 s git-lane stall
 * re-paid on every focus/watcher/reconcile trigger. A TIMEOUT is now a
 * distinct probe state with an exponential-backoff TTL: strike 1 → 30 s,
 * strike 2 → 2 min, strike 3+ → 5 min, so a hanging volume stops
 * monopolising the git lane while a transient stall still recovers.
 */

export type RepoProbeState = 'ok' | 'not-repo' | 'timeout' | 'error'

export interface MetaCacheEntryLike {
  value: { isRepo: boolean; probeState?: RepoProbeState }
  at: number
  /** Consecutive timeout probes for this cwd (drives the backoff ladder). */
  timeoutStrikes?: number
}

/** Backoff ladder for timeout-classified probes (user-approved 2026-07-22). */
export const REPO_PROBE_TIMEOUT_BACKOFF_MS = [30_000, 120_000, 300_000] as const

export function repoProbeBackoffTtlMs(timeoutStrikes: number): number {
  const idx = Math.min(
    Math.max(1, Math.floor(timeoutStrikes)),
    REPO_PROBE_TIMEOUT_BACKOFF_MS.length
  ) - 1
  return REPO_PROBE_TIMEOUT_BACKOFF_MS[idx]
}

export function isMetaCacheEntryFresh(
  entry: MetaCacheEntryLike,
  nowMs: number,
  ttlMs: number
): boolean {
  // Positive results are immutable → always fresh.
  if (entry.value.isRepo) return true
  // Timeout-classified negatives use the exponential-backoff TTL so a
  // hanging network volume is not re-probed (10 s stall each) on every
  // focus/watcher trigger.
  if (entry.value.probeState === 'timeout') {
    return nowMs - entry.at < repoProbeBackoffTtlMs(entry.timeoutStrikes ?? 1)
  }
  // Plain not-a-repo negatives expire on the short TTL (catches git init).
  return nowMs - entry.at < ttlMs
}

/**
 * Classify a failed `rev-parse` probe from the error shape Node's execFile
 * produces. A timeout kill has `killed: true` (SIGTERM at the deadline) and
 * NO numeric exit code; a genuine "not a repo" answer exits 128 on its own.
 * Everything else (spawn failures, EPERM, ENOENT on the cwd, maxBuffer) is
 * 'error' — also NOT the same statement as "not a repo", but without the
 * backoff semantics of a hang.
 */
export function classifyRepoProbeError(err: {
  killed?: boolean
  signal?: string | null
  code?: string | number | null
}): Extract<RepoProbeState, 'timeout' | 'not-repo' | 'error'> {
  if (err.killed === true || err.signal === 'SIGTERM' || err.signal === 'SIGKILL') {
    return 'timeout'
  }
  if (typeof err.code === 'number') {
    // git itself answered with a non-zero exit → the directory is genuinely
    // not inside a work tree (rev-parse exits 128 for that case).
    return 'not-repo'
  }
  return 'error'
}
