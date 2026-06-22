/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 *
 * Unit tests for the markdown preview-open self-heal predicates used by
 * `openFile` in `ProjectEditor.tsx`:
 *   - shouldEnableMarkdownForOpen(source, isMarkdownFile)
 *   - shouldSelfHealMarkdownPreviewOpen(source, isMarkdownFile, isPreviewCurrentlyOpen)
 *
 * Background: after a project-editor reopen, an explicit markdown open could
 * latch a racing snapshot where `isMarkdownPreviewOpen` was still false, leaving
 * the reopened markdown file with the preview never enabled and the render never
 * started. The self-heal forces the preview open on an explicit markdown open
 * when it is currently flagged closed.
 *
 * Pair with the autotest suite `run-project-editor-markdown-navigation`
 * (assertions PMN-41/42/43/44), which exercises opening fixtures after a reopen
 * end-to-end. The unit test locks the math (the self-heal decision table); the
 * autotest proves the wiring (the reopened markdown file actually shows the
 * preview and renders).
 *
 * Usage:
 *   node --experimental-strip-types --test test/unittest/markdown-preview-self-heal.test.mts
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  shouldEnableMarkdownForOpen,
  shouldSelfHealMarkdownPreviewOpen,
  shouldReEnableMarkdownRenderOnReopenSameFile,
  shouldPreserveRetainedPreviewDuringReopen,
  shouldTakeZeroFlashReopenPath
} from '../../src/components/ProjectEditor/utils/markdownPreviewSelfHeal.ts'

// ─────────────── MPSH-U-01: shouldEnableMarkdownForOpen source gate ───────────────

test('MPSH-U-01 user/debug/restore + markdown → enable', () => {
  assert.equal(shouldEnableMarkdownForOpen('user', true), true)
  assert.equal(shouldEnableMarkdownForOpen('debug', true), true)
  assert.equal(shouldEnableMarkdownForOpen('restore', true), true)
})

test('MPSH-U-01b non-explicit source → do not enable even for markdown', () => {
  assert.equal(shouldEnableMarkdownForOpen('auto', true), false)
  assert.equal(shouldEnableMarkdownForOpen('background', true), false)
})

test('MPSH-U-01c explicit source but non-markdown file → do not enable', () => {
  assert.equal(shouldEnableMarkdownForOpen('user', false), false)
  assert.equal(shouldEnableMarkdownForOpen('debug', false), false)
  assert.equal(shouldEnableMarkdownForOpen('restore', false), false)
})

// ─────────────── MPSH-U-02: self-heal fires only when preview is closed ───────────────

test('MPSH-U-02 explicit markdown open with preview currently CLOSED → self-heal', () => {
  assert.equal(shouldSelfHealMarkdownPreviewOpen('user', true, false), true)
  assert.equal(shouldSelfHealMarkdownPreviewOpen('debug', true, false), true)
  assert.equal(shouldSelfHealMarkdownPreviewOpen('restore', true, false), true)
})

test('MPSH-U-02b explicit markdown open with preview already OPEN → no-op', () => {
  // Nothing to heal — the predicate must not re-force an already-open preview.
  assert.equal(shouldSelfHealMarkdownPreviewOpen('user', true, true), false)
  assert.equal(shouldSelfHealMarkdownPreviewOpen('debug', true, true), false)
  assert.equal(shouldSelfHealMarkdownPreviewOpen('restore', true, true), false)
})

// ─────────────── MPSH-U-03: never self-heal when enable gate is false ───────────────

test('MPSH-U-03 non-markdown file never self-heals regardless of preview flag', () => {
  assert.equal(shouldSelfHealMarkdownPreviewOpen('user', false, false), false)
  assert.equal(shouldSelfHealMarkdownPreviewOpen('user', false, true), false)
})

test('MPSH-U-03b non-explicit source never self-heals regardless of preview flag', () => {
  assert.equal(shouldSelfHealMarkdownPreviewOpen('auto', true, false), false)
  assert.equal(shouldSelfHealMarkdownPreviewOpen('background', true, false), false)
})

// ─────────────── MPSH-U-04: each dimension is independently sufficient to block ───────────────

test('MPSH-U-04 flipping any single dimension off blocks the self-heal', () => {
  // Sanity cross-check: starting from the only true case, flipping ANY single
  // dimension must turn it false, so a future refactor that drops one of the
  // three guards fails loudly here.
  assert.equal(shouldSelfHealMarkdownPreviewOpen('user', true, false), true)
  assert.equal(shouldSelfHealMarkdownPreviewOpen('auto', true, false), false) // source off
  assert.equal(shouldSelfHealMarkdownPreviewOpen('user', false, false), false) // markdown off
  assert.equal(shouldSelfHealMarkdownPreviewOpen('user', true, true), false) // already open
})

// ─────────────── MPSH-U-05: render-gate re-enable on reopen of the same file ───────────────
// Background: a deep-link "Jump to Editor" from Git Diff re-opens the file that
// is already the active editor file. On the way INTO Diff `resetActiveFileState`
// cleared `isMarkdownRenderEnabled` while preserving the rendered HTML, so the
// `openFile` already-active-file early-return must RE-ENABLE the render gate when
// the open is an explicit markdown open and the preview pane is open. Note the
// preview-pane flag here is the INVERSE polarity of the open-self-heal predicate:
// we re-enable when the pane is OPEN (true), not when it is closed.

test('MPSH-U-05 explicit markdown open + preview pane OPEN → re-enable render gate', () => {
  assert.equal(shouldReEnableMarkdownRenderOnReopenSameFile('user', true, true), true)
  assert.equal(shouldReEnableMarkdownRenderOnReopenSameFile('debug', true, true), true)
  assert.equal(shouldReEnableMarkdownRenderOnReopenSameFile('restore', true, true), true)
})

test('MPSH-U-05b preview pane CLOSED → do not re-enable (user did not want the preview)', () => {
  assert.equal(shouldReEnableMarkdownRenderOnReopenSameFile('user', true, false), false)
  assert.equal(shouldReEnableMarkdownRenderOnReopenSameFile('debug', true, false), false)
  assert.equal(shouldReEnableMarkdownRenderOnReopenSameFile('restore', true, false), false)
})

test('MPSH-U-05c non-explicit source or non-markdown file → never re-enable', () => {
  assert.equal(shouldReEnableMarkdownRenderOnReopenSameFile('auto', true, true), false) // source off
  assert.equal(shouldReEnableMarkdownRenderOnReopenSameFile('background', true, true), false) // source off
  assert.equal(shouldReEnableMarkdownRenderOnReopenSameFile('user', false, true), false) // markdown off
})

test('MPSH-U-05d flipping any single dimension off blocks the re-enable', () => {
  assert.equal(shouldReEnableMarkdownRenderOnReopenSameFile('user', true, true), true)
  assert.equal(shouldReEnableMarkdownRenderOnReopenSameFile('auto', true, true), false) // source off
  assert.equal(shouldReEnableMarkdownRenderOnReopenSameFile('user', false, true), false) // markdown off
  assert.equal(shouldReEnableMarkdownRenderOnReopenSameFile('user', true, false), false) // pane closed
})

// ─────────────── MPSH-U-06: preserve retained preview during reopen ───────────────
// Background: a retained-close shortcut reopen briefly re-enters the
// worker-deactivate branch on the reopen's FIRST render (`isOpen` true but the
// render gate not yet propagated). The original guard preserved only on
// subpage-return OR `!isOpen`, so it blanked the retained HTML in the
// reopen-in-flight window — destroying the rendered mermaid DOM and forcing a
// reflash / EDR stall (PMSR-09/10/11/13/13a). The predicate must ALSO preserve
// in that window, but only when the snapshot path still matches the active file.

test('MPSH-U-06 subpage-return snapshot always preserves', () => {
  assert.equal(shouldPreserveRetainedPreviewDuringReopen({
    snapshotKind: 'subpage-return', snapshotPath: 'a.md', isOpen: true, activeFilePath: 'a.md'
  }), true)
  // subpage-return preserves even when path mismatches or editor is open/closed.
  assert.equal(shouldPreserveRetainedPreviewDuringReopen({
    snapshotKind: 'subpage-return', snapshotPath: 'a.md', isOpen: false, activeFilePath: 'b.md'
  }), true)
})

test('MPSH-U-06b genuine close (!isOpen) preserves regardless of path', () => {
  assert.equal(shouldPreserveRetainedPreviewDuringReopen({
    snapshotKind: 'retained-close', snapshotPath: 'a.md', isOpen: false, activeFilePath: null
  }), true)
})

test('MPSH-U-06c reopen-in-flight: retained-close + isOpen + matching path → preserve', () => {
  assert.equal(shouldPreserveRetainedPreviewDuringReopen({
    snapshotKind: 'retained-close', snapshotPath: 'a.md', isOpen: true, activeFilePath: 'a.md'
  }), true)
})

test('MPSH-U-06d reopen-in-flight with MISMATCHED path → do NOT preserve (avoid stale render leak)', () => {
  assert.equal(shouldPreserveRetainedPreviewDuringReopen({
    snapshotKind: 'retained-close', snapshotPath: 'a.md', isOpen: true, activeFilePath: 'b.md'
  }), false)
  // No active file is also a non-match.
  assert.equal(shouldPreserveRetainedPreviewDuringReopen({
    snapshotKind: 'retained-close', snapshotPath: 'a.md', isOpen: true, activeFilePath: null
  }), false)
})

test('MPSH-U-06e no snapshot → never preserve', () => {
  assert.equal(shouldPreserveRetainedPreviewDuringReopen({
    snapshotKind: null, snapshotPath: null, isOpen: false, activeFilePath: 'a.md'
  }), false)
})

// ─────────────── MPSH-U-07: zero-flash reopen path ───────────────
// The zero-flash path (re-arm scroll + bump nonce, NO applyMarkdownSessionCacheHit)
// is correct ONLY when a content-identical cache entry exists AND the rendered
// HTML is still on screen. Either missing → fall back to the re-apply path.

test('MPSH-U-07 cache hit + HTML on screen → zero-flash', () => {
  assert.equal(shouldTakeZeroFlashReopenPath({
    hasContentIdenticalCacheEntry: true, hasRenderedHtmlOnScreen: true
  }), true)
})

test('MPSH-U-07b HTML lost → do NOT zero-flash (must re-apply to repopulate)', () => {
  assert.equal(shouldTakeZeroFlashReopenPath({
    hasContentIdenticalCacheEntry: true, hasRenderedHtmlOnScreen: false
  }), false)
})

test('MPSH-U-07c no content-identical entry → do NOT zero-flash', () => {
  assert.equal(shouldTakeZeroFlashReopenPath({
    hasContentIdenticalCacheEntry: false, hasRenderedHtmlOnScreen: true
  }), false)
  assert.equal(shouldTakeZeroFlashReopenPath({
    hasContentIdenticalCacheEntry: false, hasRenderedHtmlOnScreen: false
  }), false)
})
