/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Pure precedence logic for deciding which cwd Git Diff opens against.
 *
 * Extracted from `TerminalGrid.handleViewGitDiff` so the decision table can be
 * locked by a unit test independent of the React/Electron wiring. The wiring
 * (event listener, ref stash, GitDiffViewer prop) is proven by the autotest
 * `run-pdf-epub-diff-autotest.sh`; this function pins the *math* of "which
 * source wins".
 *
 * Precedence (highest first):
 *   1. `cwdOverride`  — an explicit cwd carried in the `git-diff:open` event
 *                       detail. Used to open against a specific repo regardless
 *                       of the terminal's reported cwd (e.g. a nested fixture
 *                       repo whose `cd` cwd report is racy/absent under EDR).
 *   2. `repoRoot`     — the terminal's resolved git repo root.
 *   3. `terminalCwd`  — the terminal's current working directory.
 *   4. `persistedCwd` — the last cwd persisted for this terminal in AppState.
 *
 * An empty string is treated as absent at every level so a blank value falls
 * through to the next source rather than pinning the diff to "".
 */
export interface GitDiffCwdSources {
  cwdOverride?: string | null
  repoRoot?: string | null
  terminalCwd?: string | null
  persistedCwd?: string | null
}

export function resolveGitDiffInitialCwd(sources: GitDiffCwdSources): string | null {
  const order: Array<string | null | undefined> = [
    sources.cwdOverride,
    sources.repoRoot,
    sources.terminalCwd,
    sources.persistedCwd
  ]
  for (const candidate of order) {
    if (typeof candidate === 'string' && candidate.length > 0) {
      return candidate
    }
  }
  return null
}
