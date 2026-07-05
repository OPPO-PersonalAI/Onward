/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Pure mapping from the GitStateMirror snapshot's file list to the Git
 * Diff open-skeleton rows (G4 of the 2026-07-04 spinner analysis).
 *
 * While `getDiff` computes the real list (multi-second on an EDR host),
 * the mirror snapshot the renderer ALREADY holds carries every changed
 * file's path + status — enough to paint a real file list immediately
 * (only the +/- counts are unknown). This module owns the defensive
 * normalization so the render path stays declarative and the logic is
 * unit-testable in plain Node (leaf: zero imports).
 */

export interface OpenSkeletonEntry {
  /** Stable render key. */
  key: string
  filename: string
  /** Porcelain status letter (M/A/D/R/?/…) — drives the status chip. */
  status: string
  changeType: string
}

/** Cap so a pathological status (thousands of rows) cannot jank the shell. */
export const OPEN_SKELETON_MAX_ENTRIES = 200

/**
 * Normalize mirror files into display rows: drop malformed entries, dedup
 * by (filename, changeType) — the mirror list is already deduped but the
 * skeleton must never render duplicate React keys — and cap the count.
 * Input order is preserved (it matches the eventual list order closely
 * enough for a transient shell).
 */
export function buildOpenSkeletonEntries(
  files: ReadonlyArray<unknown> | null | undefined,
  max: number = OPEN_SKELETON_MAX_ENTRIES
): OpenSkeletonEntry[] {
  if (!files || files.length === 0) return []
  const out: OpenSkeletonEntry[] = []
  const seen = new Set<string>()
  for (const raw of files) {
    if (out.length >= max) break
    if (!raw || typeof raw !== 'object') continue
    const file = raw as { filename?: unknown; status?: unknown; changeType?: unknown }
    const filename = typeof file.filename === 'string' ? file.filename : ''
    if (!filename) continue
    const status = typeof file.status === 'string' && file.status ? file.status : '?'
    const changeType = typeof file.changeType === 'string' ? file.changeType : ''
    const key = `${changeType}::${filename}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push({ key, filename, status, changeType })
  }
  return out
}
