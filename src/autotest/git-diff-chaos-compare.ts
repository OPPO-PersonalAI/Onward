/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Pure comparator for the git-diff chaos-convergence oracle.
 *
 * Answers "does the Git Diff UI state match the on-disk truth the chaos
 * writer captured at quiesce time?" — the contract assertion of the suite
 * (any displayed state must converge to disk truth within the SLO, without a
 * manual refresh). Pure (no DOM, no fs) so the decision table is locked by
 * test/unittest/git-diff-chaos-compare.test.mts and the in-app suite stays a
 * thin driver.
 *
 * Comparison model (deliberately conservative to stay assertion-stable):
 *   - FILENAME-SET equality between the UI file list and the porcelain truth.
 *     A file staged AND modified may legitimately appear twice in the UI; the
 *     unique-path set collapses that. Missing = the user's "new file never
 *     shows up" symptom; extra = a deleted file's ghost entry.
 *   - BODY equality only for unambiguous worktree-backed truth entries
 *     (xy '??', ' M', ' A' — captured by the writer with a non-null body):
 *     the pane's modified side must equal the on-disk bytes. This is the
 *     user's "content is not live until refresh" symptom.
 */

export interface ChaosTruthEntry {
  path: string
  xy: string
  body: string | null
  /** Writer's last-write timestamp for this path (null = not writer-touched). */
  lastOpAt?: number | null
}

export interface ChaosUiFile {
  filename: string
  changeType?: string
}

export interface ChaosListVerdict {
  match: boolean
  missing: string[]
  extra: string[]
}

function normalizePath(value: string): string {
  return value.replace(/\\/g, '/').replace(/^\.\//, '')
}

export function compareListToTruth(
  uiFiles: ChaosUiFile[],
  truthEntries: ChaosTruthEntry[]
): ChaosListVerdict {
  const uiSet = new Set(uiFiles.map((f) => normalizePath(f.filename)))
  const truthSet = new Set(truthEntries.map((e) => normalizePath(e.path)))
  const missing: string[] = []
  const extra: string[] = []
  for (const path of truthSet) {
    if (!uiSet.has(path)) missing.push(path)
  }
  for (const path of uiSet) {
    if (!truthSet.has(path)) extra.push(path)
  }
  missing.sort()
  extra.sort()
  return { match: missing.length === 0 && extra.length === 0, missing, extra }
}

/**
 * Truth entries whose displayed body can be asserted unambiguously: the
 * writer captured a worktree body AND the state has no index-side pane
 * ambiguity. Ordered MOST-RECENTLY-WRITTEN-FIRST (path as the deterministic
 * tie-break): the last-written files are exactly the ones whose reads most
 * likely overlapped a write — the TOCTOU poison class the 2026-07-12 bundle
 * shipped — so a bounded body sample points at the highest-risk entries
 * instead of alphabetical luck.
 */
export function bodyCheckCandidates(truthEntries: ChaosTruthEntry[]): ChaosTruthEntry[] {
  return truthEntries
    .filter((e) => e.body !== null && (e.xy === '??' || e.xy === ' M' || e.xy === ' A'))
    .sort((a, b) => {
      const recency = (b.lastOpAt ?? 0) - (a.lastOpAt ?? 0)
      if (recency !== 0) return recency
      return a.path < b.path ? -1 : a.path > b.path ? 1 : 0
    })
}

/**
 * Displayed-body verdict. `displayed === null` means the pane never produced
 * content (load error / still loading) — counted as a mismatch, the caller
 * keeps polling until the convergence SLO expires.
 */
export function compareBody(
  displayed: string | null,
  truth: ChaosTruthEntry
): { match: boolean; reason?: string } {
  if (truth.body === null) return { match: true }
  if (displayed === null) return { match: false, reason: 'no-displayed-content' }
  if (displayed === truth.body) return { match: true }
  return { match: false, reason: 'body-mismatch' }
}
