/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Pure decision for the markdown preview-open self-heal in `openFile`.
 *
 * Background: after a project-editor reopen, an explicit markdown open
 * (`source` of `user` / `debug` / `restore`) could latch a racing snapshot in
 * which `isMarkdownPreviewOpen` was still `false`, even though such an open of a
 * markdown file should always show the preview. Because every downstream branch
 * (cache apply, render-enable, beginPreviewRestore) is gated on the preview-open
 * flag, a stale `false` leaves the reopened file with the preview never enabled
 * and the render never started.
 *
 * This predicate isolates the single boolean — "should this explicit markdown
 * open force the preview open?" — so it can be unit-tested in plain Node without
 * the heavyweight `ProjectEditor.tsx`. It is `true` iff the open is an explicit
 * markdown open AND the preview is currently flagged closed (nothing to heal
 * when it is already open).
 *
 * Locked down by test/unittest/markdown-preview-self-heal.test.mts.
 */

export type MarkdownOpenSource = 'user' | 'debug' | 'restore' | 'auto' | string

export function shouldEnableMarkdownForOpen(
  source: MarkdownOpenSource,
  isMarkdownFile: boolean
): boolean {
  return (source === 'user' || source === 'debug' || source === 'restore') && isMarkdownFile
}

export function shouldSelfHealMarkdownPreviewOpen(
  source: MarkdownOpenSource,
  isMarkdownFile: boolean,
  isPreviewCurrentlyOpen: boolean
): boolean {
  return shouldEnableMarkdownForOpen(source, isMarkdownFile) && !isPreviewCurrentlyOpen
}

/**
 * Pure decision for the markdown render-gate self-heal on the `openFile`
 * already-active-file early-return path.
 *
 * Background: a deep-link "Jump to Editor" from Git Diff dispatches an open of
 * the file that is ALREADY the active editor file. On the way INTO Diff the
 * editor ran `resetActiveFileState({ preserveSoftCloseContent: true })`, which
 * unconditionally calls `setIsMarkdownRenderEnabled(false)` while PRESERVING the
 * already-rendered markdown HTML. The jump then re-opens the same path, so
 * `openFile` hits its `currentActiveFilePath === path` early-return and never
 * runs the render-enable branch — leaving `isMarkdownRenderEnabled` stuck
 * `false`. Because `isMarkdownRenderAllowed = isMarkdownPreviewVisible &&
 * isMarkdownRenderEnabled` and `previewVisibleRef.current = isMarkdownRenderAllowed`,
 * the preview pane reports `isMarkdownPreviewVisible() === false` even though the
 * rendered HTML is preserved on screen. The fix re-enables the render gate on
 * that early-return when the open is an explicit markdown open and the preview
 * pane is flagged open.
 *
 * This predicate isolates the single boolean so it can be unit-tested in plain
 * Node. It is `true` iff the open is an explicit markdown open AND the preview
 * pane is currently open (so re-enabling the gate is the right thing to do).
 *
 * Locked down by test/unittest/markdown-preview-self-heal.test.mts.
 */
export function shouldReEnableMarkdownRenderOnReopenSameFile(
  source: MarkdownOpenSource,
  isMarkdownFile: boolean,
  isPreviewPaneOpen: boolean
): boolean {
  return shouldEnableMarkdownForOpen(source, isMarkdownFile) && isPreviewPaneOpen
}

export type ProjectEditorSoftCloseKind = 'retained-close' | 'subpage-return'

/**
 * Pure decision for the worker-deactivate branch's "preserve the rendered HTML"
 * choice during a shortcut reopen.
 *
 * Background: a retained-close shortcut reopen briefly re-enters the
 * worker-deactivate branch on the reopen's FIRST render — `isOpen` has already
 * flipped `true`, but the retained-view restore effect (which calls
 * `setIsMarkdownRenderEnabled(true)`) has not yet propagated, so
 * `isMarkdownWorkerActive` is still `false` for one render. The original guard
 * preserved the HTML only for a subpage-return snapshot OR when `!isOpen`, so it
 * did NOT cover this reopen-in-flight window and the branch blanked the retained
 * HTML — destroying the already-rendered mermaid DOM, forcing a re-apply +
 * mermaid re-render (the user-visible reflash) and, under EDR throttling,
 * stalling the first reopen at htmlLength 0.
 *
 * This predicate decides whether to preserve. It is `true` when there is a
 * soft-close snapshot AND any of:
 *   - the snapshot is a subpage-return (Diff / History round trip), OR
 *   - the editor is not open (a genuine close), OR
 *   - the reopen-in-flight window: a retained-close snapshot whose path still
 *     matches the active markdown file (so we never leak a stale render for a
 *     DIFFERENT file).
 *
 * Locked down by test/unittest/markdown-preview-self-heal.test.mts.
 */
export function shouldPreserveRetainedPreviewDuringReopen(args: {
  snapshotKind: ProjectEditorSoftCloseKind | null
  snapshotPath: string | null
  isOpen: boolean
  activeFilePath: string | null
}): boolean {
  const { snapshotKind, snapshotPath, isOpen, activeFilePath } = args
  if (!snapshotKind) return false
  if (snapshotKind === 'subpage-return') return true
  if (!isOpen) return true
  // retained-close + isOpen === reopen-in-flight window: preserve only when the
  // snapshot's path still matches the active file.
  return (
    snapshotKind === 'retained-close' &&
    Boolean(activeFilePath) &&
    snapshotPath === activeFilePath
  )
}

/**
 * Pure decision for the retained-view restore branch: take the ZERO-FLASH path
 * (re-arm scroll + bump render nonce, NO `applyMarkdownSessionCacheHit` /
 * `beginPreviewRestore`) versus the heavier re-apply path.
 *
 * The zero-flash path is correct ONLY when BOTH hold:
 *   - a content-identical session-cache entry exists for the reopened file
 *     (`hasContentIdenticalCacheEntry`), proving the saved render matches, AND
 *   - the rendered HTML is STILL on screen (`hasRenderedHtmlOnScreen`), so React
 *     reuses the identical `dangerouslySetInnerHTML` node and the
 *     already-rendered mermaid DOM survives (pending === 0). Calling
 *     `applyMarkdownSessionCacheHit` in that state would flip the phase to
 *     'waiting-html' and fade the content to opacity 0 — the exact reflash
 *     PMSR-13a/13b guard against.
 *
 * When the HTML was lost (EDR race beat preserve, or a non-retained close) the
 * caller must fall back to the re-apply path to repopulate the preview.
 *
 * Locked down by test/unittest/markdown-preview-self-heal.test.mts.
 */
export function shouldTakeZeroFlashReopenPath(args: {
  hasContentIdenticalCacheEntry: boolean
  hasRenderedHtmlOnScreen: boolean
}): boolean {
  return args.hasContentIdenticalCacheEntry && args.hasRenderedHtmlOnScreen
}
