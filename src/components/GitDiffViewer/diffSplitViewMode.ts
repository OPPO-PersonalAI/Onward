/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

export type GitDiffSplitViewMode = 'auto' | 'split' | 'inline'

export const DEFAULT_GIT_DIFF_SPLIT_VIEW_MODE: GitDiffSplitViewMode = 'inline'

export function coerceGitDiffSplitViewMode(value: unknown): GitDiffSplitViewMode | null {
  if (value === 'auto' || value === 'split' || value === 'inline') return value
  if (value === 'side-by-side') return 'split'
  if (value === 'unified') return 'inline'
  return null
}

export function resolveGitDiffSplitViewMode(...candidates: unknown[]): GitDiffSplitViewMode {
  for (const candidate of candidates) {
    const mode = coerceGitDiffSplitViewMode(candidate)
    if (mode) return mode
  }
  return DEFAULT_GIT_DIFF_SPLIT_VIEW_MODE
}

/**
 * Pure decision: given the user's split-view preference and the diff editor's
 * current container width, decide whether the layout reporter can SHORT-CIRCUIT
 * to 'inline' on the width breakpoint alone (true), or must defer to the actual
 * rendered pane geometry (false).
 *
 * This must mirror the Monaco render options the diff editor is constructed with:
 *   - 'inline': renderSideBySide=false → always a single pane → force inline.
 *   - 'auto':   renderSideBySideInlineBreakpoint is set → a container narrower
 *               than the breakpoint collapses to inline → width gate applies.
 *   - 'split':  renderSideBySide=true AND the inline breakpoint is DISABLED
 *               (renderSideBySideInlineBreakpoint=undefined) → Monaco keeps two
 *               side-by-side panes even below the breakpoint → the width gate must
 *               NOT fire, otherwise the reporter lies about the real layout and
 *               the split-ratio sash becomes undraggable in a narrow window.
 *
 * Returns:
 *   'force-inline'  — definitely inline (mode === 'inline').
 *   'width-gate'    — apply the width breakpoint, else measure geometry.
 *   'measure'       — skip the width gate, defer to rendered geometry.
 */
export function resolveDiffInlineGate(
  splitViewMode: GitDiffSplitViewMode
): 'force-inline' | 'width-gate' | 'measure' {
  if (splitViewMode === 'inline') return 'force-inline'
  if (splitViewMode === 'auto') return 'width-gate'
  return 'measure'
}
