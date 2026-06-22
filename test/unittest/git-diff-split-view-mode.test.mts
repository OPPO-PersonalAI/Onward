/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  DEFAULT_GIT_DIFF_SPLIT_VIEW_MODE,
  coerceGitDiffSplitViewMode,
  resolveDiffInlineGate,
  resolveGitDiffSplitViewMode
} from '../../src/components/GitDiffViewer/diffSplitViewMode.ts'

describe('git diff split view mode', () => {
  it('defaults to inline when no stored preference is valid', () => {
    assert.equal(resolveGitDiffSplitViewMode(undefined, null, 'bad'), DEFAULT_GIT_DIFF_SPLIT_VIEW_MODE)
    assert.equal(DEFAULT_GIT_DIFF_SPLIT_VIEW_MODE, 'inline')
  })

  it('accepts current auto, split, and inline mode names', () => {
    assert.equal(coerceGitDiffSplitViewMode('auto'), 'auto')
    assert.equal(coerceGitDiffSplitViewMode('split'), 'split')
    assert.equal(coerceGitDiffSplitViewMode('inline'), 'inline')
  })

  it('migrates legacy display mode values', () => {
    assert.equal(coerceGitDiffSplitViewMode('side-by-side'), 'split')
    assert.equal(coerceGitDiffSplitViewMode('unified'), 'inline')
  })

  it('respects the first valid stored preference', () => {
    assert.equal(resolveGitDiffSplitViewMode('bad', 'auto', 'inline'), 'auto')
    assert.equal(resolveGitDiffSplitViewMode('bad', 'split'), 'split')
  })
})

describe('git diff inline-gate decision (getDiffLayoutMode width short-circuit)', () => {
  // Locks the pure decision behind the XP-09b fix: a user who forces Split mode
  // must keep a side-by-side layout (and a draggable sash) even when the diff
  // editor container is narrower than DIFF_INLINE_BREAKPOINT, because Monaco is
  // built with renderSideBySideInlineBreakpoint=undefined in 'split' mode.
  it('forces inline for inline mode regardless of width', () => {
    assert.equal(resolveDiffInlineGate('inline'), 'force-inline')
  })

  it('applies the width breakpoint only in auto mode', () => {
    assert.equal(resolveDiffInlineGate('auto'), 'width-gate')
  })

  it('skips the width breakpoint in forced split mode (measure real geometry)', () => {
    // The regression: previously the width short-circuit fired for ALL modes, so
    // a narrow window collapsed forced-split to inline, measureDiffSplitState
    // returned ratio:null, and the sash could not be dragged. 'measure' means the
    // reporter must defer to the rendered pane geometry, not the width gate.
    assert.equal(resolveDiffInlineGate('split'), 'measure')
  })
})
