/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

import { useState, useEffect, useLayoutEffect, useCallback, useRef, useMemo } from 'react'
import { DiffEditor } from '@monaco-editor/react'
import { parseDiffFromFile, SPLIT_WITH_NEWLINES } from '@pierre/diffs'
import type { FileDiffMetadata, SelectedLineRange, SelectionSide } from '@pierre/diffs'
import type * as monacoTypes from 'monaco-editor'
import type {
  GitDiffContentCacheMissReason,
  GitDiffResult,
  GitFileStatus,
  GitFileContentResult,
  GitFileActionResult,
  GitRepoContext
} from '../../types/electron'
import { useSettings } from '../../contexts/SettingsContext'
import { DEFAULT_GIT_DIFF_FONT_SIZE } from '../../constants/gitDiff'
import { useSubpageEscape } from '../../hooks/useSubpageEscape'
import { useViewportMenuPosition } from '../../hooks/useViewportMenuPosition'
import { useGitStateMirror } from '../../hooks/useGitStateMirror'
import { useI18n } from '../../i18n/useI18n'
import { useAppState } from '../../hooks/useAppState'
import { trackFeatureUse } from '../../telemetry/track-feature-use'
import { DiffEmptyState } from '../common/DiffEmptyState'
import type { ProjectEditorOpenEventDetail, SubpageId, SubpageNavigateEventDetail } from '../../types/subpage'
import { SubpagePanelButton, SubpagePanelShell, SubpageSwitcher, type SubpagePanelShellState } from '../SubpageSwitcher'
import {
  GitImagePreview,
  IMAGE_COMPARE_MODE_STORAGE_KEY,
  IMAGE_DISPLAY_MODE_STORAGE_KEY,
  type GitImagePreviewFileState,
  type ImageCompareMode,
  type ImageDisplayMode,
  type SvgViewMode
} from '../GitImagePreview/GitImagePreview'
import { GitPdfCompare, type GitPdfStatus } from '../GitPdfCompare/GitPdfCompare'
import { GitEpubCompare, type GitEpubStatus } from '../GitEpubCompare/GitEpubCompare'
import { usePathCopy } from '../../hooks/usePathCopy'
import { useFileEntryOsActions } from '../../hooks/useFileEntryOsActions'
import { fileEntryOsItemState, resolveEntryAbsolutePath } from '../../utils/file-entry-path'
import { useCwdCopyHandler } from '../../hooks/useCwdCopyHandler'
import { useGitDiffFileWatch } from './useGitDiffFileWatch'
import {
  buildContentWithChangeRange,
  buildHunkActionWidgetPlan,
  findHunkContainingLine,
  type DiffHunkAction,
  type DiffHunkActionRange,
  type HunkActionWidgetInstallResult
} from './gitDiffHunkActions'
import { resolveMonacoLanguageId } from './monacoLanguageMap'
import { buildGitDiffModelSyncPlan } from './monacoModelSync'
import {
  GitDiffClickLatencyTracker,
  type ClickLatencyMeasurement,
  type ClickLatencySettleReason
} from './clickLatencyTracker'
import { buildClickPhaseTraceRecords } from './clickLatencyTraceEmitter'
import {
  buildGitDiffFileKey,
  buildGitDiffSelectionSnapshot,
  clearGitDiffMemorySelection,
  clearGitDiffMemorySelectionWhenEmpty,
  mergeGitDiffSnapshotScroll,
  resolveDiffRestoreDecision,
  resolveGitDiffSnapshotScrollTop,
  resolveGitDiffRestoredSelection,
  resolveGitDiffSnapshotSelection,
  shouldRestoreGitDiffSnapshotScroll,
  type DiffRestoreDecision,
  type DiffViewAnchor,
  type DiffViewMemory,
  type DiffViewMemoryEntry
} from './diffViewMemory'
import {
  emptySubmoduleLoadObservation,
  foldSubmoduleLoadObservation,
  type SubmoduleLoadObservation
} from './submoduleLoadObservation'
import { resolveDiffInlineGate, resolveGitDiffSplitViewMode, type GitDiffSplitViewMode } from './diffSplitViewMode'
import { applyFileActionToDiffResult, type GitFileLocalAction } from './gitDiffLocalPatch'
import { GitDiffDebugPanel } from './GitDiffDebugPanel'
import { LargeFileConfirmDialog } from '../LargeFileConfirmDialog/LargeFileConfirmDialog'
import { createThemedSetiFileIconResolver, sanitizeSetiSvgOnce } from '../ProjectEditor/setiFileIconTheme'
import { perfTrace, perfTraceDiagnostic } from '../../utils/perf-trace'
import { buildOpenSkeletonEntries } from './openSkeletonEntries'
import { PERF_TRACE_EVENT } from '../../utils/perf-trace-names'
import { raceWithTimeout } from '../../utils/race-with-timeout'
import { isWatchdogTimeoutError, makeWatchdogTimeoutError } from './watchdogTimeoutError'
import {
  nextGitDiffNavigationLoadSettledEpoch,
  resolvePendingGitDiffNavigationSelectionDecision
} from './gitDiffNavigationSelection'
import '../../styles/path-copy-toast.css'
import './GitDiffViewer.css'

const DEBUG_GIT_DIFF = Boolean(window.electronAPI?.debug?.enabled)

function debugLog(...args: unknown[]) {
  if (!DEBUG_GIT_DIFF) return
  console.log('[GitDiffViewer]', ...args)
  try {
    const [message, ...data] = args
    window.electronAPI.debug.log(String(message ?? ''), data.length > 0 ? data : undefined)
  } catch {
    // ignore
  }
}

function clampEditorLine(
  editor: monacoTypes.editor.IStandaloneCodeEditor,
  rawLine: number | null | undefined
): number | null {
  if (typeof rawLine !== 'number' || !Number.isFinite(rawLine)) return null
  const lineCount = editor.getModel()?.getLineCount() ?? 0
  if (lineCount <= 0) return null
  return Math.max(1, Math.min(Math.trunc(rawLine), lineCount))
}

function revealLineNearTopSafe(
  editor: monacoTypes.editor.IStandaloneCodeEditor,
  rawLine: number | null | undefined
): boolean {
  const line = clampEditorLine(editor, rawLine)
  if (line === null) return false
  editor.revealLineNearTop(line)
  return true
}

// local storage key name
const STORAGE_KEY_FILE_LIST_WIDTH = 'git-diff-file-list-width'
const STORAGE_KEY_FILE_LIST_VIEW_MODE = 'git-diff-file-list-view-mode'
const STORAGE_KEY_MODAL_SIZE = 'git-diff-modal-size'
const STORAGE_KEY_DIFF_SPLIT_RATIO = 'git-diff-split-view-ratio'
const STORAGE_KEY_DIFF_SPLIT_VIEW_MODE = 'git-diff-split-view-mode'
const STORAGE_KEY_DIFF_DEBUG_PANEL_COLLAPSED = 'git-diff-debug-panel-collapsed'

// File list width limit
const DEFAULT_FILE_LIST_WIDTH = 280
const MIN_FILE_LIST_WIDTH = 150
const MAX_FILE_LIST_WIDTH = 600

const DEFAULT_DIFF_SPLIT_RATIO = 0.5
const MIN_DIFF_SPLIT_RATIO = 0.1
const MAX_DIFF_SPLIT_RATIO = 0.9
const DIFF_SPLIT_RATIO_EPSILON = 0.002
const DIFF_INLINE_BREAKPOINT = 900
const DIFF_REVEAL_TIMEOUT_MS = 2000
// Subpage-switch-back restore (afterEnter) polls for the previously selected
// file to reappear in the freshly loaded diff list. On a fast host the list is
// ready within a few hundred ms, but a cold diff file-list spawn behind an EDR
// (endpoint-detection) agent can take ~8-10s before the first `files[]` lands.
// The deadline only governs how long we wait before giving up — it never
// changes behaviour on a fast host (the loop breaks the instant `target` is
// found) — so widening it from the old 2.5s purely closes the EDR cold-start
// gap where the restore used to abort early and leave the selection null.
const COLD_DIFF_RESTORE_BUDGET_MS = 20000
// Renderer-side watchdog for a single `getDiff` IPC round-trip. The main-process
// git worker has its own request timeout, and when it rejects, the handler's
// rejection normally propagates back to the renderer `invoke`. But on an
// EDR-throttled host a wedged/deduped worker reply can leave the renderer
// `invoke` promise pending indefinitely (observed: the worker logged
// "Git IPC worker request timed out: getDiff" yet the renderer await never
// settled, so `loadDiff`'s finally never ran, the in-flight lock leaked, and
// every later load + Keep/Deny froze until the 180s autotest kill). This
// watchdog races the invoke so `loadDiff` always reaches its finally and
// releases the lock. The ceiling is wide enough that a healthy slow load on EDR
// (cold full diff ~8-10s) never trips it; only a truly wedged worker does.
const DIFF_LOAD_IPC_TIMEOUT_MS = 30000
// After a known single-file mutation the list is patched locally and the
// authoritative reconcile normally arrives via the mirror-echo invalidation.
// If no reload started within this window (watcher missed/late), fire ONE
// silent non-force reload as the deterministic backstop.
const MUTATION_RECONCILE_FALLBACK_MS = 3000
// Upper bound for an in-flight-skip caller waiting on `waitForLoadIdle`. Even
// with the IPC watchdog above, this is a belt-and-suspenders ceiling so a
// queued caller (e.g. Keep/Deny's post-action reload) can never block forever
// if the idle-waiter resolution is ever missed. It must exceed
// DIFF_LOAD_IPC_TIMEOUT_MS so a normal in-flight load (released by the
// watchdog) resolves the waiter the proper way first.
const DIFF_LOAD_IDLE_WAIT_CEILING_MS = 35000
// Watchdog-timeout error tagging lives in watchdogTimeoutError.ts so loadDiff's
// catch can tell a renderer-side watchdog abort (the underlying getDiff invoke
// never settled — the worker may still be churning behind an EDR-throttled,
// concurrency-1 lane) apart from a genuine load failure. The two must NOT be
// treated the same: a genuine failure surfaces the empty error result, but a
// watchdog abort on a slow-but-live reload must NOT blank an already-painted file
// list — doing so silently destroyed the user's diff list and broke Keep/Deny +
// sibling file lookups in the round-4 image-diff regression. Extracted as a pure
// module so the decision is unit-testable without importing this heavy component.
const TOKENIZE_SETTLE_QUIET_MS = 100
const TOKENIZE_SETTLE_CAP_MS = 5000
// Hunk widget installation is bounded to the selected-file/model settle
// window. Monaco can reuse the same diff models when the Git Diff view is
// closed and reopened, and in that case `onDidUpdateDiff` may not fire again
// even though `getLineChanges()` becomes available shortly after selection.
// A frame-bounded settle keeps the install deterministic without reviving the
// old open-ended timer retry loop.
const HUNK_ACTION_INSTALL_SETTLE_FRAME_LIMIT = 90
const HUNK_ACTION_INSTALL_SETTLE_MAX_MS = 1500
const HUNK_ACTION_HOVER_HIDE_DELAY_MS = 140
// Warm-reopen reveal settle: same model-reuse reality as the hunk-widget
// settle above — a close/reopen with unchanged models never re-fires
// `onDidUpdateDiff`, and the `model-bound` signal is gated on an active
// click-latency measurement that a reopen does not have. Without this
// bounded settle the render-then-reveal cycle idles in `waiting-diff`
// until the 2 s safety timeout on EVERY warm reopen. Frame-bounded like
// the hunk installer; the safety timeout stays armed as the backstop.
const WARM_REVEAL_SETTLE_MAX_MS = 1500
// What advanced the render-then-reveal cycle out of `waiting-diff`; carried
// into the restore-decision diagnostic so a user trace shows whether a
// reopen revealed promptly ('warm-ready') or idled out ('timeout').
type DiffRevealTrigger = 'diff-computed' | 'model-bound' | 'warm-ready' | 'timeout'
type DiffRestoreDecisionRecord = {
  action: DiffRestoreDecision['action']
  reason: string | null
  trigger: DiffRevealTrigger | 'deferred-diff-computed'
  fileKey: string | null
  at: number
  // Line the reveal actually targeted when a reveal-first-change APPLIED
  // (from getLineChanges()[0] at apply time); null when no reveal ran.
  // Deterministic from content — the autotest gates on this instead of
  // pixel scroll offsets, which are unstable while Monaco measures the
  // diff layout asynchronously.
  revealTargetLine: number | null
}

// Monaco theme aligned with @pierre/diffs' pierre-dark palette so Git Diff
// reads as the same visual family as the Git History viewer.
const PIERRE_LIKE_MONACO_THEME = 'onward-pierre-dark'
const PIERRE_LIKE_MONACO_FONT = "'SF Mono', Monaco, Consolas, 'Ubuntu Mono', 'Liberation Mono', 'Courier New', monospace"
let pierreLikeMonacoThemeRegistered = false

// SVG path constants reused by both the React icon components below and the
// imperative DOM construction inside installDiffHunkActionWidgets (where we
// build per-hunk toolbar buttons via document.createElement and need raw
// SVG markup, not React components).
const STAGE_ICON_PATHS = '<path d="M8 1.5a.75.75 0 0 1 .75.75v7.69l2.22-2.22a.75.75 0 1 1 1.06 1.06l-3.5 3.5a.75.75 0 0 1-1.06 0l-3.5-3.5a.75.75 0 0 1 1.06-1.06l2.22 2.22V2.25A.75.75 0 0 1 8 1.5z" /><path d="M2.75 12.5a.75.75 0 0 1 .75.75v.25h9v-.25a.75.75 0 0 1 1.5 0V14a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1v-.75a.75.75 0 0 1 .75-.75z" />'
const UNSTAGE_ICON_PATHS = '<path d="M8 14.5a.75.75 0 0 1-.75-.75V6.06l-2.22 2.22a.75.75 0 1 1-1.06-1.06l3.5-3.5a.75.75 0 0 1 1.06 0l3.5 3.5a.75.75 0 0 1-1.06 1.06l-2.22-2.22v7.69a.75.75 0 0 1-.75.75z" /><path d="M2.75 12.5a.75.75 0 0 1 .75.75v.25h9v-.25a.75.75 0 0 1 1.5 0V14a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1v-.75a.75.75 0 0 1 .75-.75z" />'
const REVERT_ICON_PATHS = '<path d="M5.5 5.5A.5.5 0 0 1 6 6v6a.5.5 0 0 1-1 0V6a.5.5 0 0 1 .5-.5zm2.5 0a.5.5 0 0 1 .5.5v6a.5.5 0 0 1-1 0V6a.5.5 0 0 1 .5-.5zm3 .5a.5.5 0 0 0-1 0v6a.5.5 0 0 0 1 0V6z" /><path d="M14.5 3a1 1 0 0 1-1 1H13v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V4h-.5a1 1 0 0 1-1-1V2h4.086A1.5 1.5 0 0 1 7 1h2a1.5 1.5 0 0 1 1.414 1H14.5v1zM4 4v9a1 1 0 0 0 1 1h6a1 1 0 0 0 1-1V4H4z" />'
const HUNK_ACTION_ICON_SVG: Record<'stage' | 'unstage' | 'revert', string> = {
  stage: `<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">${STAGE_ICON_PATHS}</svg>`,
  unstage: `<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">${UNSTAGE_ICON_PATHS}</svg>`,
  revert: `<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">${REVERT_ICON_PATHS}</svg>`
}

function formatLargeFileSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB']
  let value = bytes
  let index = 0
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024
    index += 1
  }
  return `${value >= 10 || index === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[index]}`
}

function escapeHtmlText(value: string): string {
  return value.replace(/[&<>"']/g, (ch) => {
    switch (ch) {
      case '&': return '&amp;'
      case '<': return '&lt;'
      case '>': return '&gt;'
      case '"': return '&quot;'
      default: return '&#39;'
    }
  })
}

function StageActionIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 16 16"
      fill="currentColor"
      aria-hidden="true"
      dangerouslySetInnerHTML={{ __html: STAGE_ICON_PATHS }}
    />
  )
}

function DiscardActionIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      <path d="M5.5 5.5A.5.5 0 0 1 6 6v6a.5.5 0 0 1-1 0V6a.5.5 0 0 1 .5-.5zm2.5 0a.5.5 0 0 1 .5.5v6a.5.5 0 0 1-1 0V6a.5.5 0 0 1 .5-.5zm3 .5a.5.5 0 0 0-1 0v6a.5.5 0 0 0 1 0V6z" />
      <path d="M14.5 3a1 1 0 0 1-1 1H13v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V4h-.5a1 1 0 0 1-1-1V2h4.086A1.5 1.5 0 0 1 7 1h2a1.5 1.5 0 0 1 1.414 1H14.5v1zM4 4v9a1 1 0 0 0 1 1h6a1 1 0 0 0 1-1V4H4z" />
    </svg>
  )
}

function ClearActionIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      <path d="M3.72 3.72a.75.75 0 0 1 1.06 0L8 6.94l3.22-3.22a.75.75 0 1 1 1.06 1.06L9.06 8l3.22 3.22a.75.75 0 1 1-1.06 1.06L8 9.06l-3.22 3.22a.75.75 0 0 1-1.06-1.06L6.94 8 3.72 4.78a.75.75 0 0 1 0-1.06z" />
    </svg>
  )
}

function SaveActionIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      <path d="M2 2.5A1.5 1.5 0 0 1 3.5 1h7.19a1.5 1.5 0 0 1 1.06.44l2.81 2.81A1.5 1.5 0 0 1 15 5.31v7.19a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 1 12.5v-10zM3.5 2a.5.5 0 0 0-.5.5v10a.5.5 0 0 0 .5.5H4v-3.5A1.5 1.5 0 0 1 5.5 8h5A1.5 1.5 0 0 1 12 9.5V13h1.5a.5.5 0 0 0 .5-.5V5.31a.5.5 0 0 0-.15-.35l-2.81-2.81A.5.5 0 0 0 10.69 2H10v2.5A1.5 1.5 0 0 1 8.5 6h-3A1.5 1.5 0 0 1 4 4.5V2h-.5zM5 2v2.5a.5.5 0 0 0 .5.5h3a.5.5 0 0 0 .5-.5V2H5zm6 11V9.5a.5.5 0 0 0-.5-.5h-5a.5.5 0 0 0-.5.5V13h6z" />
    </svg>
  )
}

function RefreshActionIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      <path d="M13.65 5.35A5.5 5.5 0 0 0 3.4 3.15a.75.75 0 0 0 1.17.94A4 4 0 0 1 12 6.2V7h-1.75a.75.75 0 0 0 0 1.5h3.5a.75.75 0 0 0 .75-.75v-3.5a.75.75 0 0 0-1.5 0v1.1h-.35z" />
      <path d="M2.35 10.65A5.5 5.5 0 0 0 12.6 12.85a.75.75 0 0 0-1.17-.94A4 4 0 0 1 4 9.8V9h1.75a.75.75 0 0 0 0-1.5h-3.5a.75.75 0 0 0-.75.75v3.5a.75.75 0 0 0 1.5 0v-1.1h.35z" />
    </svg>
  )
}

function InfoActionIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      <path d="M8 1.5a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13zM2.5 8a5.5 5.5 0 1 1 11 0 5.5 5.5 0 0 1-11 0z" />
      <path d="M7.25 7.25A.75.75 0 0 1 8 6.5h.25a.75.75 0 0 1 .75.75v3.25h.25a.75.75 0 0 1 0 1.5H8a.75.75 0 0 1-.75-.75V8h-.25a.75.75 0 0 1-.75-.75zM8 4.25a.875.875 0 1 0 0 1.75.875.875 0 0 0 0-1.75z" />
    </svg>
  )
}

function JumpToEditorIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      <path d="M9.75 1.5a.75.75 0 0 0 0 1.5h2.19L7.72 7.22a.75.75 0 0 0 1.06 1.06L13 4.06v2.19a.75.75 0 0 0 1.5 0v-4A.75.75 0 0 0 13.75 1.5h-4z" />
      <path d="M3.5 3A1.5 1.5 0 0 0 2 4.5v8A1.5 1.5 0 0 0 3.5 14h8a1.5 1.5 0 0 0 1.5-1.5V9.75a.75.75 0 0 0-1.5 0v2.75h-8v-8h2.75a.75.75 0 0 0 0-1.5H3.5z" />
    </svg>
  )
}

function TreeViewIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      <path d="M3 2.5A1.5 1.5 0 0 1 4.5 1h2A1.5 1.5 0 0 1 8 2.5v1A1.5 1.5 0 0 1 6.5 5h-.25v2H9V6.5A1.5 1.5 0 0 1 10.5 5h2A1.5 1.5 0 0 1 14 6.5v1A1.5 1.5 0 0 1 12.5 9h-2A1.5 1.5 0 0 1 9 7.5V8H6.25v3H9v-.5A1.5 1.5 0 0 1 10.5 9h2a1.5 1.5 0 0 1 1.5 1.5v1a1.5 1.5 0 0 1-1.5 1.5h-2A1.5 1.5 0 0 1 9 11.5V12H5.5A.5.5 0 0 1 5 11.5V5h-.5A1.5 1.5 0 0 1 3 3.5v-1z" />
    </svg>
  )
}

function FlatViewIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      <path d="M3 3.25A.75.75 0 0 1 3.75 2.5h8.5a.75.75 0 0 1 0 1.5h-8.5A.75.75 0 0 1 3 3.25zm0 4.75a.75.75 0 0 1 .75-.75h8.5a.75.75 0 0 1 0 1.5h-8.5A.75.75 0 0 1 3 8zm.75 4a.75.75 0 0 0 0 1.5h8.5a.75.75 0 0 0 0-1.5h-8.5z" />
    </svg>
  )
}

function ensurePierreLikeMonacoTheme(monaco: typeof monacoTypes) {
  if (pierreLikeMonacoThemeRegistered) return
  monaco.editor.defineTheme(PIERRE_LIKE_MONACO_THEME, {
    base: 'vs-dark',
    inherit: true,
    rules: [],
    colors: {
      'editor.background': '#070707',
      'editor.foreground': '#fbfbfb',
      'editorLineNumber.foreground': '#84848a',
      'editorLineNumber.activeForeground': '#adadb1',
      'editorGutter.background': '#070707',
      'editor.lineHighlightBackground': '#101010',
      'editor.lineHighlightBorder': '#00000000',
      'editorIndentGuide.background': '#1a1a1a',
      'editorIndentGuide.activeBackground': '#2a2a2a',
      'editorIndentGuide.background1': '#1a1a1a',
      'editorIndentGuide.activeBackground1': '#2a2a2a',
      'editor.selectionBackground': '#2a2a2a',
      'editor.inactiveSelectionBackground': '#1a1a1a',
      'editorWhitespace.foreground': '#2a2a2a',
      'diffEditor.insertedLineBackground': '#00cab11a',
      'diffEditor.insertedTextBackground': '#00cab140',
      'diffEditor.removedLineBackground': '#ff2e3f1a',
      'diffEditor.removedTextBackground': '#ff2e3f40',
      'diffEditor.diagonalFill': '#14141400',
      'diffEditor.border': '#1a1a1a',
      'diffEditor.unchangedRegionBackground': '#0a0a0a',
      'diffEditor.unchangedRegionForeground': '#79797f',
      'diffEditor.unchangedCodeBackground': '#0a0a0a',
      'diffEditorGutter.insertedLineBackground': '#00cab11a',
      'diffEditorGutter.removedLineBackground': '#ff2e3f1a',
      'diffEditorOverview.insertedForeground': '#00cab1',
      'diffEditorOverview.removedForeground': '#ff2e3f',
      'scrollbarSlider.background': '#1f1f1f80',
      'scrollbarSlider.hoverBackground': '#2f2f2fa0',
      'scrollbarSlider.activeBackground': '#3f3f3fc0'
    }
  })
  pierreLikeMonacoThemeRegistered = true
}

// Pop-up window size limit
const DEFAULT_MODAL_WIDTH = 1200
const DEFAULT_MODAL_HEIGHT = 600
const MIN_MODAL_WIDTH = 600
const MIN_MODAL_HEIGHT = 400
const MAX_MODAL_WIDTH_PERCENT = 95  // Percentage relative to viewport
const MAX_MODAL_HEIGHT_PERCENT = 95

interface GitDiffViewerProps {
  isOpen: boolean
  onClose: () => void
  terminalId: string
  cwd: string | null
  cwdPending?: boolean
  openRequestedAt?: number | null
  cwdReadyAt?: number | null
  displayMode?: 'modal' | 'panel'
  panelShellMode?: 'internal' | 'external'
  onPanelShellStateChange?: (state: SubpagePanelShellState | null) => void
  taskTitle?: string
  navigationTarget?: GitDiffNavigationTarget | null
}

type GitDiffTimingSnapshot = {
  openRequestedAt: number | null
  shellShownAt: number | null
  cwdReadyAt: number | null
  diffLoadedAt: number | null
}

type DiffSplitLayout = {
  ratio: number
  originalWidth: number
  modifiedWidth: number
  originalLeft: number
  modifiedLeft: number
  gap: number
}

type DiffLayoutMode = 'side-by-side' | 'inline'

type DiffHunkActionWidgetHandle = {
  id: string
  anchorLine: number
  range: DiffHunkActionRange
  node: HTMLDivElement
  buttons: HTMLButtonElement[]
}
type GitDiffFileListViewMode = 'tree' | 'flat'
type GitDiffNavigationTarget = {
  filePath: string
  repoRoot?: string | null
  changeType?: GitFileStatus['changeType'] | null
  nonce: number
}

type DiffSplitState = {
  mode: DiffLayoutMode
  ratio: number | null
  originalWidth: number
  modifiedWidth: number
}

type FileContentLoadReason = 'select' | 'prefetch' | 'refresh' | 'auto-refresh' | 'debug'
type GitDiffModelSyncReason = FileContentLoadReason | 'editor-mount' | 'state-change'

type LastFileContentLoadInfo = {
  fileKey: string
  filename: string
  reason: FileContentLoadReason
  force: boolean
  result: 'success' | 'error' | 'exception'
  cacheInfo: GitFileContentResult['cacheInfo'] | null
  durationMs: number
}

function cacheMissReasonForLoad(
  force: boolean,
  reason: FileContentLoadReason
): GitDiffContentCacheMissReason | undefined {
  if (!force) return undefined
  if (reason === 'refresh') return 'invalidated-refresh'
  if (reason === 'auto-refresh') return 'invalidated-watch'
  return 'renderer-force-refresh'
}

type DiffNavigationSelectionTarget = {
  filePath: string
  repoRoot: string | null
  changeType: GitFileStatus['changeType'] | null
}

type DiffFileTreeNode = {
  key: string
  name: string
  path: string
  type: 'dir' | 'file'
  count: number
  file?: GitFileStatus
  children?: DiffFileTreeNode[]
}

// Retained as a typed shape only so the `getPrefetchState` debug helper can
// keep returning something for the legacy autotest selector. The renderer no
// longer prefetches; the snapshot is always the "idle" sentinel.
type BodyPrefetchSnapshot = {
  scheduled: number
  completed: number
  inFlight: boolean
  candidates: string[]
  lastReason: 'idle' | 'scheduled' | 'completed' | 'cancelled' | 'skipped'
  lastDurationMs: number | null
}

const PREFETCH_RETIRED_SNAPSHOT: BodyPrefetchSnapshot = {
  scheduled: 0,
  completed: 0,
  inFlight: false,
  candidates: [],
  lastReason: 'idle',
  lastDurationMs: null
}

// Status color map
const statusColors: Record<GitFileStatus['status'], string> = {
  'M': '#e2c08d', // Modified - Orange
  'A': '#89d185', // Added - green
  'D': '#f14c4c', // Deleted - red
  'R': '#569cd6', // Renamed - blue
  'C': '#c586c0', // Copied - Purple
  '?': '#858585', // Untracked - Gray
  '!': '#f14c4c'  // Conflict - red
}

interface FileContentState {
  loading: boolean
  refreshing?: boolean
  originalContent: string
  modifiedContent: string
  draftContent?: string
  isBinary: boolean
  isImage?: boolean
  isSvg?: boolean
  isPdf?: boolean
  isEpub?: boolean
  originalImageUrl?: string
  modifiedImageUrl?: string
  originalImageSize?: number
  modifiedImageSize?: number
  originalPreviewData?: string
  modifiedPreviewData?: string
  originalPreviewSize?: number
  modifiedPreviewSize?: number
  error?: string
}

type LargeFileConfirmState = {
  filename: string
  sizeBytes: number
  sizeLabel: string
  resolve: (confirmed: boolean) => void
}

function retainDirtyDrafts(contents: Record<string, FileContentState>): Record<string, FileContentState> {
  const retained: Record<string, FileContentState> = {}
  for (const [key, state] of Object.entries(contents)) {
    if (state.draftContent !== undefined && state.draftContent !== state.modifiedContent) {
      retained[key] = state
    }
  }
  return retained
}

function normalizeInvalidationPath(value: string): string {
  let normalized = value.replace(/\\/g, '/').replace(/\/{2,}/g, '/')
  if (normalized.startsWith('/private/')) normalized = normalized.slice('/private'.length)
  if (normalized.length > 1 && normalized.endsWith('/')) normalized = normalized.slice(0, -1)
  return normalized
}

function normalizeDiffDisplayPath(value: string): string {
  return value.replace(/\\/g, '/').replace(/\/{2,}/g, '/').replace(/^\/+/, '')
}

function normalizeComparableGitPath(value: string): string {
  const normalized = value.replace(/\\/g, '/').replace(/\/{2,}/g, '/').replace(/\/+$/, '')
  return window.electronAPI.platform === 'win32' ? normalized.toLowerCase() : normalized
}

function joinGitPath(root: string | null | undefined, relativePath: string): string {
  const normalizedRoot = (root ?? '').replace(/\\/g, '/').replace(/\/+$/, '')
  const normalizedRelative = normalizeDiffDisplayPath(relativePath)
  return normalizedRoot ? `${normalizedRoot}/${normalizedRelative}` : normalizedRelative
}

function findDiffFileByNavigationTarget(
  result: GitDiffResult | null,
  target: DiffNavigationSelectionTarget | null
): GitFileStatus | null {
  if (!result?.success || !target?.filePath) return null
  const targetAbsolute = normalizeComparableGitPath(joinGitPath(target.repoRoot || result.cwd, target.filePath))
  const targetRelative = normalizeComparableGitPath(normalizeDiffDisplayPath(target.filePath))
  for (const file of result.files) {
    const fileRelative = normalizeComparableGitPath(normalizeDiffDisplayPath(file.filename))
    const fileAbsolute = normalizeComparableGitPath(joinGitPath(file.repoRoot || result.cwd, file.filename))
    const pathMatches = fileAbsolute === targetAbsolute || (!target.repoRoot && fileRelative === targetRelative)
    const changeTypeMatches = !target.changeType || file.changeType === target.changeType
    if (pathMatches && changeTypeMatches) {
      return file
    }
  }
  return null
}

function buildDiffFileTree(files: GitFileStatus[], treeScopeKey: string): DiffFileTreeNode[] {
  const root: DiffFileTreeNode = {
    key: `${treeScopeKey}::root`,
    name: '',
    path: '',
    type: 'dir',
    count: 0,
    children: []
  }

  const sortedFiles = [...files].sort((a, b) => normalizeDiffDisplayPath(a.filename).localeCompare(normalizeDiffDisplayPath(b.filename)))
  for (const file of sortedFiles) {
    const parts = normalizeDiffDisplayPath(file.filename).split('/').filter(Boolean)
    if (parts.length === 0) continue
    let cursor = root
    let currentPath = ''
    for (let index = 0; index < parts.length; index += 1) {
      const name = parts[index]
      currentPath = currentPath ? `${currentPath}/${name}` : name
      const isLeaf = index === parts.length - 1
      if (isLeaf) {
        cursor.children!.push({
          key: `${treeScopeKey}::file::${file.changeType}::${file.status}::${file.originalFilename ?? ''}::${file.filename}`,
          name,
          path: currentPath,
          type: 'file',
          count: 1,
          file
        })
        continue
      }
      let dir = cursor.children!.find((child) => child.type === 'dir' && child.name === name)
      if (!dir) {
        dir = {
          key: `${treeScopeKey}::dir::${currentPath}`,
          name,
          path: currentPath,
          type: 'dir',
          count: 0,
          children: []
        }
        cursor.children!.push(dir)
      }
      cursor = dir
    }
  }

  const assignCounts = (node: DiffFileTreeNode): number => {
    if (node.type === 'file') {
      node.count = 1
      return 1
    }
    node.count = (node.children ?? []).reduce((sum, child) => sum + assignCounts(child), 0)
    return node.count
  }
  const sortNodes = (nodes: DiffFileTreeNode[]) => {
    nodes.sort((a, b) => {
      if (a.type !== b.type) return a.type === 'dir' ? -1 : 1
      return a.name.localeCompare(b.name)
    })
    for (const node of nodes) {
      if (node.children) sortNodes(node.children)
    }
  }
  assignCounts(root)
  sortNodes(root.children!)
  return root.children!
}

// Render-then-reveal state machine for eliminating diff scroll flash.
// Mirrors the PreviewRestorePhase pattern used by Markdown preview.
type DiffRevealPhase = 'idle' | 'waiting-diff' | 'restoring-scroll'

type RestoredAnchor = {
  line: number | null
  scrollTop: number
}

type CompareStatus = 'added' | 'deleted' | 'modified' | null
type ChapterKind = 'added' | 'deleted' | 'modified' | 'unchanged'

function resolveCompareStatus(container: Element | null): CompareStatus {
  if (!container) return null
  if (container.querySelector('.git-pdf-compare-status-added, .git-epub-compare-status-added')) return 'added'
  if (container.querySelector('.git-pdf-compare-status-deleted, .git-epub-compare-status-deleted')) return 'deleted'
  return 'modified'
}

// Shared DOM inspection helpers used by both GitDiffViewer and GitHistoryViewer
// debug APIs. Querying the DOM keeps these decoupled from React state and lets
// autotests verify what the user actually sees.
export function inspectPdfCompareDom() {
  const root = document.querySelector('.git-pdf-compare')
  if (!root) return { visible: false, status: null, originalSrc: null, modifiedSrc: null, originalHasEmpty: false, modifiedHasEmpty: false, paneCount: 0, isSinglePane: false }
  const panes = Array.from(root.querySelectorAll('.git-pdf-compare-pane')) as HTMLElement[]
  // Look up by data-side so single-pane layouts (status='added' / 'deleted')
  // still resolve original vs modified correctly even though only one is in the DOM.
  const findBySide = (side: 'original' | 'modified') =>
    panes.find(p => p.dataset?.side === side) ?? null
  const originalPane = findBySide('original')
  const modifiedPane = findBySide('modified')
  const readSrc = (pane: HTMLElement | null) =>
    (pane?.querySelector('iframe.git-pdf-compare-frame') as HTMLIFrameElement | null)?.src ?? null
  return {
    visible: true,
    status: resolveCompareStatus(root),
    originalSrc: readSrc(originalPane),
    modifiedSrc: readSrc(modifiedPane),
    originalHasEmpty: Boolean(originalPane?.querySelector('.git-pdf-compare-empty')),
    modifiedHasEmpty: Boolean(modifiedPane?.querySelector('.git-pdf-compare-empty')),
    paneCount: panes.length,
    isSinglePane: Boolean(root.querySelector('.git-pdf-compare-panes.is-single'))
  }
}

export function inspectEpubCompareDom() {
  const root = document.querySelector('.git-epub-compare')
  if (!root) {
    return { visible: false, status: null, chapterCount: 0, selectedHref: null, chapterBadges: [], diffCounts: null }
  }
  const chapterButtons = Array.from(root.querySelectorAll('.git-epub-compare-chapter-list > li .git-epub-compare-chapter-item')) as HTMLElement[]
  const chapterBadges = chapterButtons.map(btn => {
    const label = btn.querySelector('.git-epub-compare-chapter-label')?.textContent?.trim() ?? ''
    const cls = btn.className
    let kind: ChapterKind = 'unchanged'
    if (cls.includes('git-epub-compare-chapter-added')) kind = 'added'
    else if (cls.includes('git-epub-compare-chapter-deleted')) kind = 'deleted'
    else if (cls.includes('git-epub-compare-chapter-modified')) kind = 'modified'
    const href = btn.dataset?.href ?? ''
    return { href, label, kind }
  })
  const active = chapterButtons.find(btn => btn.classList.contains('active')) ?? null
  const selectedHref = active?.dataset?.href ?? null
  // Count diff lines in the currently visible panes. These come from the
  // annotateLines helper: .git-epub-compare-line-add / -del / -same.
  const countClass = (cls: string) => root.querySelectorAll(`.${cls}`).length
  const diffCounts = chapterButtons.length > 0
    ? { add: countClass('git-epub-compare-line-add'), del: countClass('git-epub-compare-line-del'), same: countClass('git-epub-compare-line-same') }
    : null
  return {
    visible: true,
    status: resolveCompareStatus(root),
    chapterCount: chapterButtons.length,
    selectedHref,
    chapterBadges,
    diffCounts
  }
}

type GitDiffDebugApi = {
  isOpen: () => boolean
  getFileList: () => GitFileStatus[]
  getVisibleFileList: () => GitFileStatus[]
  getFileListViewMode: () => GitDiffFileListViewMode
  setFileListViewMode: (mode: GitDiffFileListViewMode) => boolean
  getVisibleTreeRows: () => Array<{ type: 'dir' | 'file'; path: string; depth: number; name: string }>
  getRepoList: () => GitRepoContext[]
  getVisibleRepoItems: () => RepoFilterTreeItem[]
  setRepoExpanded: (repoRoot: string, expanded: boolean) => boolean
  setRepoFilter: (repoRoot: string | null) => boolean
  getSelectedFile: () => {
    filename: string
    originalFilename?: string
    status: GitFileStatus['status']
    changeType: GitFileStatus['changeType']
  } | null
  selectFileByPath: (path: string) => boolean
  selectFileByIndex: (index: number) => boolean
  isSelectedReady: () => boolean
  getSelectedFileContent: () => {
    originalContent: string | null
    modifiedContent: string | null
    draftContent: string | null
    isBinary: boolean
    loading: boolean
    error: string | null
  } | null
  getSelectedEditorModelContent: () => {
    originalContent: string | null
    modifiedContent: string | null
    expectedOriginalContent: string | null
    expectedModifiedContent: string | null
    originalUri: string | null
    modifiedUri: string | null
    originalMatchesState: boolean | null
    modifiedMatchesState: boolean | null
  } | null
  getCachedFileContentByPath: (path: string, changeType?: GitFileStatus['changeType']) => {
    filename: string
    changeType: GitFileStatus['changeType']
    originalContent: string | null
    modifiedContent: string | null
    draftContent: string | null
    isBinary: boolean
    loading: boolean
    error: string | null
  } | null
  getPrefetchState: () => BodyPrefetchSnapshot
  getLargeFileConfirmState: () => {
    visible: boolean
    filename: string | null
    sizeBytes: number | null
    sizeLabel: string | null
  }
  confirmLargeFile: () => void
  cancelLargeFile: () => void
  getLastFileContentLoad: () => LastFileContentLoadInfo | null
  getLastClickLatency: () => ClickLatencyMeasurement | null
  getLastClickLatencyForFile: (fileKey: string) => ClickLatencyMeasurement | null
  getClickLatencyHistory: () => ClickLatencyMeasurement[]
  resetClickLatencyHistory: () => void
  /** Autotest: count of loadDiff passes that survived the coalescing gate. */
  getLoadDiffStats: () => { started: number }
  setSelectedDraftContent: (content: string) => boolean
  getIsDraftDirty: () => boolean
  getRestoreNotice: () => { type: 'changed'; message: string; fileName?: string } | null
  /** Autotest: last restore-vs-reveal decision of the render-then-reveal cycle. */
  getLastRestoreDecision: () => {
    action: 'restore-scroll' | 'restore-anchor' | 'reveal-first-change'
    reason: string | null
    trigger: 'diff-computed' | 'model-bound' | 'warm-ready' | 'timeout' | 'deferred-diff-computed'
    fileKey: string | null
    at: number
    revealTargetLine: number | null
  } | null
  getScrollTop: () => number
  getScrollMetrics: () => {
    scrollTop: number
    scrollHeight: number
    viewportHeight: number
    maxScrollTop: number
    modelMatchesSelection: boolean
    diffReady: boolean
  } | null
  getFirstVisibleLine: () => number
  scrollToFraction: (fraction: number) => boolean
  scrollToLine: (line: number) => boolean
  getDiffFontSize: () => number
  getCwd: () => string | null
  getRepoRoot: () => string | null
  isSubmodulesLoading: () => boolean
  getSubmoduleLoadObservation: () => SubmoduleLoadObservation
  getTiming: () => {
    openRequestedAt: number | null
    shellShownAt: number | null
    cwdReadyAt: number | null
    diffLoadedAt: number | null
    openToShellMs: number | null
    openToCwdReadyMs: number | null
    openToDiffLoadedMs: number | null
    cwdReadyToDiffLoadedMs: number | null
  }
  getLoadState: () => {
    inFlight: boolean
    queued: { reset: boolean; silent: boolean; force: boolean } | null
    hasDiffResult: boolean
    fileCount: number | null
    submodulesLoading: boolean
    hasLastDiff: boolean
    lastDiffAgeMs: number | null
  }
  getSplitViewState: () => DiffSplitState | null
  getSplitViewMode: () => GitDiffSplitViewMode
  setSplitViewMode: (mode: GitDiffSplitViewMode) => boolean
  getDiffNavigationState: () => { changeCount: number; currentIndex: number }
  getResponsiveLayoutState: () => {
    mode: DiffLayoutMode | null
    containerWidth: number | null
    inlineBreakpoint: number
    useInlineViewWhenSpaceIsLimited: boolean
  }
  setSplitViewRatio: (ratio: number) => boolean
  setFileListWidth: (width: number) => boolean
  dragSplitViewRatio: (ratio: number) => Promise<boolean>
  navigateDiffChange: (direction: 'previous' | 'next') => boolean
  refreshChanges: () => Promise<boolean>
  getTermsPopoverOpen: () => boolean
  toggleTermsPopover: () => boolean
  getHunkActionWidgetCount: () => number
  getHunkActionDebugState: () => {
    hasEditor: boolean
    hasMonaco: boolean
    selectedFile: { filename: string; changeType: GitFileStatus['changeType']; status: GitFileStatus['status'] } | null
    selectedFileKey: string | null
    hasState: boolean
    loading: boolean | null
    error: string | null
    isBinary: boolean | null
    isDraftDirty: boolean
    lineChanges: number
    widgetDomCount: number
    visibleWidgetDomCount: number
    widgetDisposableCount: number
    installRetryPending: boolean
  }
  revealFirstHunkActionForTest: () => boolean
  hideHunkActionsForTest: () => void
  triggerFirstHunkAction: (action: DiffHunkAction) => Promise<boolean>
  waitForLastHunkActionForTest: () => Promise<boolean | null>
  setSelectedLineRangeForTest: (start: number, end: number, side?: SelectionSide) => boolean
  triggerLineAction: (action: 'keep' | 'deny') => Promise<boolean>
  getImagePreviewState: () => {
    isImage: boolean
    isSvg: boolean
    isBinary: boolean
    hasOriginalUrl: boolean
    hasModifiedUrl: boolean
    compareMode: ImageCompareMode
    displayMode: ImageDisplayMode
    loading: boolean
  } | null
  getFileActionState: () => {
    fileActionsVisible: boolean
    lineActionsVisible: boolean
    keepDisabled: boolean
    denyDisabled: boolean
    pending: boolean
    toolbarVisible: boolean
    actionPanelVisible: boolean
    visibleLabels: string[]
  } | null
  triggerFileAction: (action: 'keep' | 'deny', expectedFilename?: string) => Promise<boolean>
  getPdfCompareState: () => ReturnType<typeof inspectPdfCompareDom>
  getEpubCompareState: () => ReturnType<typeof inspectEpubCompareDom>
}

function clampDiffSplitRatio(value: number): number {
  return Math.max(MIN_DIFF_SPLIT_RATIO, Math.min(MAX_DIFF_SPLIT_RATIO, value))
}

function readStoredDiffSplitRatio(): number {
  const saved = localStorage.getItem(STORAGE_KEY_DIFF_SPLIT_RATIO)
  if (!saved) return DEFAULT_DIFF_SPLIT_RATIO
  const parsed = Number(saved)
  if (!Number.isFinite(parsed)) return DEFAULT_DIFF_SPLIT_RATIO
  return clampDiffSplitRatio(parsed)
}

function isGitDiffFileListViewMode(value: unknown): value is GitDiffFileListViewMode {
  return value === 'tree' || value === 'flat'
}

function isGitDiffSplitViewMode(value: unknown): value is GitDiffSplitViewMode {
  return value === 'auto' || value === 'split' || value === 'inline'
}

function readStoredSplitViewMode(): GitDiffSplitViewMode {
  try {
    const saved = localStorage.getItem(STORAGE_KEY_DIFF_SPLIT_VIEW_MODE)
    return resolveGitDiffSplitViewMode(saved)
  } catch {
    return resolveGitDiffSplitViewMode()
  }
}

type LineSelectionInfo =
  | {
    valid: false
    side: SelectionSide
    count: number
    message: string
  }
  | {
    valid: true
    side: SelectionSide
    start: number
    end: number
    count: number
  }

function resolveLineSelectionInfo(
  range: SelectedLineRange | null,
  crossSideMessage: string
): LineSelectionInfo | null {
  if (!range) return null
  const side = (range.side ?? 'additions') as SelectionSide
  const endSide = (range.endSide ?? side) as SelectionSide
  const count = Math.abs(range.end - range.start) + 1
  if (side !== endSide) {
    return {
      valid: false,
      side,
      count,
      message: crossSideMessage
    }
  }
  const start = Math.min(range.start, range.end)
  const end = Math.max(range.start, range.end)
  return {
    valid: true,
    side,
    start,
    end,
    count
  }
}

// Rough line-level diff stats via multiset symmetric difference. Used to keep
// the sidebar +/- counters in sync after a local save without re-fetching the
// whole repo diff. Not intended to match git's diff algorithm exactly —
// accuracy is secondary to avoiding a full refresh.
function quickLineDiffStats(original: string, modified: string): { additions: number; deletions: number } {
  if (original === modified) return { additions: 0, deletions: 0 }
  // An empty file has zero lines, not one empty line — otherwise the multiset
  // treats the single empty-string entry as a phantom add/delete pair.
  const splitLines = (text: string): string[] => (text === '' ? [] : text.split('\n'))
  const originalLines = splitLines(original)
  const modifiedLines = splitLines(modified)
  const counts = new Map<string, number>()
  for (const line of originalLines) counts.set(line, (counts.get(line) ?? 0) + 1)
  let additions = 0
  for (const line of modifiedLines) {
    const c = counts.get(line) ?? 0
    if (c > 0) counts.set(line, c - 1)
    else additions += 1
  }
  let deletions = 0
  for (const c of counts.values()) deletions += c
  return { additions, deletions }
}

function sortRepoContexts(a: GitRepoContext, b: GitRepoContext): number {
  if (a.isSubmodule !== b.isSubmodule) {
    return a.isSubmodule ? 1 : -1
  }
  if (a.depth !== b.depth) {
    return a.depth - b.depth
  }
  return a.label.localeCompare(b.label)
}

interface RepoFilterTreeItem extends GitRepoContext {
  treeDepth: number
  hasChildren: boolean
  expanded: boolean
  isCurrent: boolean
  displayLabel: string
}

function normalizeRepoRoot(root: string | null | undefined): string {
  return (root ?? '').replace(/\\/g, '/').replace(/\/+$/, '')
}

function getRepoTreeDepth(repo: GitRepoContext): number {
  return repo.isSubmodule ? repo.depth + 1 : 0
}

function getRepoLeafLabel(label: string): string {
  const normalized = label.replace(/\\/g, '/')
  return normalized.split('/').filter(Boolean).pop() || label
}

function buildRepoFilterTreeItems(
  repos: GitRepoContext[] | undefined,
  expandedRoots: Set<string>,
  currentRoot: string | null,
  currentLabel: string,
  includeRepo: (repo: GitRepoContext) => boolean
): RepoFilterTreeItem[] {
  if (!repos || repos.length === 0) return []
  const normalizedCurrent = normalizeRepoRoot(currentRoot)
  const childrenByParent = new Map<string, GitRepoContext[]>()
  const rootRepos: GitRepoContext[] = []
  const includedRoots = new Set<string>()

  for (const repo of repos) {
    const parentRoot = normalizeRepoRoot(repo.parentRoot)
    if (repo.isSubmodule && parentRoot) {
      const existing = childrenByParent.get(parentRoot) ?? []
      existing.push(repo)
      childrenByParent.set(parentRoot, existing)
    } else {
      rootRepos.push(repo)
    }
  }

  const markIncludedWithAncestors = (repo: GitRepoContext) => {
    if (!includeRepo(repo)) return
    includedRoots.add(normalizeRepoRoot(repo.root))
    let parentRoot = normalizeRepoRoot(repo.parentRoot)
    while (parentRoot) {
      includedRoots.add(parentRoot)
      const parent = repos.find((candidate) => normalizeRepoRoot(candidate.root) === parentRoot)
      parentRoot = normalizeRepoRoot(parent?.parentRoot)
    }
  }
  repos.forEach(markIncludedWithAncestors)

  const output: RepoFilterTreeItem[] = []
  const visit = (repo: GitRepoContext) => {
    const root = normalizeRepoRoot(repo.root)
    if (!includedRoots.has(root)) return
    const children = [...(childrenByParent.get(root) ?? [])].sort(sortRepoContexts)
    const visibleChildren = children.filter((child) => includedRoots.has(normalizeRepoRoot(child.root)))
    const hasChildren = visibleChildren.length > 0
    const expanded = expandedRoots.has(root)
    const displayLabel = repo.isSubmodule ? getRepoLeafLabel(repo.label) : currentLabel
    output.push({
      ...repo,
      treeDepth: getRepoTreeDepth(repo),
      hasChildren,
      expanded,
      isCurrent: root === normalizedCurrent,
      displayLabel
    })
    if (expanded) {
      visibleChildren.forEach(visit)
    }
  }

  rootRepos.sort(sortRepoContexts).forEach(visit)
  return output
}

function getDiffPaneElement(
  editor: monacoTypes.editor.IStandaloneDiffEditor,
  side: 'original' | 'modified'
): HTMLElement | null {
  const privateElements = (editor as monacoTypes.editor.IStandaloneDiffEditor & {
    elements?: Partial<Record<'root' | 'original' | 'modified', HTMLElement>>
  }).elements
  const privatePane = privateElements?.[side]
  if (privatePane instanceof HTMLElement) {
    return privatePane
  }
  const container = editor.getContainerDomNode()
  const diffRoot = container.classList.contains('monaco-diff-editor')
    ? container
    : container.querySelector<HTMLElement>('.monaco-diff-editor')
  if (!diffRoot) return null
  for (const child of Array.from(diffRoot.children)) {
    if (!(child instanceof HTMLElement)) continue
    if (!child.classList.contains('editor')) continue
    if (!child.classList.contains(side)) continue
    return child
  }
  return null
}

function getDiffLayoutMode(
  editor: monacoTypes.editor.IStandaloneDiffEditor,
  splitViewMode: GitDiffSplitViewMode
): DiffLayoutMode {
  // Honour the user's explicit split-view preference, mirroring the actual
  // Monaco render options (see renderSideBySide / renderSideBySideInlineBreakpoint
  // / useInlineViewWhenSpaceIsLimited where the diff editor is constructed):
  //   - 'inline': renderSideBySide=false → the editor never shows two panes.
  //   - 'split':  renderSideBySide=true AND the inline breakpoint is disabled
  //               (renderSideBySideInlineBreakpoint=undefined), so Monaco keeps
  //               two side-by-side panes EVEN when the container is narrower than
  //               DIFF_INLINE_BREAKPOINT. The width short-circuit below must NOT
  //               fire here, or this reporter would lie about the real layout and
  //               measureDiffSplitState()/dragDiffSplitRatio() would wrongly bail,
  //               making the sash undraggable for a user who forced Split mode in
  //               a narrow window.
  //   - 'auto':  the breakpoint is active (renderSideBySideInlineBreakpoint set),
  //               so a narrow container collapses to inline — keep the width gate.
  const gate = resolveDiffInlineGate(splitViewMode)
  if (gate === 'force-inline') {
    return 'inline'
  }
  if (gate === 'width-gate') {
    const containerWidth = editor.getContainerDomNode().getBoundingClientRect().width
    if (Number.isFinite(containerWidth) && containerWidth > 0 && containerWidth <= DIFF_INLINE_BREAKPOINT) {
      return 'inline'
    }
  }

  const originalPane = getDiffPaneElement(editor, 'original')
  const modifiedPane = getDiffPaneElement(editor, 'modified')
  if (!originalPane || !modifiedPane) return 'side-by-side'
  const originalRect = originalPane.getBoundingClientRect()
  const modifiedRect = modifiedPane.getBoundingClientRect()
  if (originalRect.width <= 0 || modifiedRect.width <= 0) return 'inline'
  const sameRow = Math.abs(originalRect.top - modifiedRect.top) < 8
  const separatedColumns = modifiedRect.left > originalRect.left + Math.min(originalRect.width, modifiedRect.width) * 0.5
  return sameRow && separatedColumns ? 'side-by-side' : 'inline'
}

const SIGNATURE_SAMPLE_SIZE = 256
const SCROLL_RESTORE_TOLERANCE = 64

function hashString(input: string): string {
  let hash = 5381
  for (let i = 0; i < input.length; i += 1) {
    hash = ((hash << 5) + hash) ^ input.charCodeAt(i)
  }
  return (hash >>> 0).toString(16)
}

function buildTextSignature(text: string): string {
  if (!text) return '0:0:0'
  const head = text.slice(0, SIGNATURE_SAMPLE_SIZE)
  const tail = text.slice(-SIGNATURE_SAMPLE_SIZE)
  return `${text.length}:${hashString(head)}:${hashString(tail)}`
}

function buildDiffSignature(original: string, modified: string): string {
  return `${buildTextSignature(original)}|${buildTextSignature(modified)}`
}

function buildGitDiffModelPath(
  file: GitFileStatus,
  repoRoot: string | null | undefined,
  side: 'original' | 'modified'
): string {
  const repoSegment = hashString(file.repoRoot || repoRoot || 'repo')
  const path = (side === 'original' ? (file.originalFilename || file.filename) : file.filename)
    .split('/')
    .map(encodeURIComponent)
    .join('/')
  return `inmemory://model/onward-git-diff/${repoSegment}/${side}/${path}`
}

function buildContentWithSelection(
  diff: FileDiffMetadata,
  side: SelectionSide,
  selectedLines: Set<number>,
  applySelected: boolean,
  oldContent: string,
  newContent: string
): string {
  const oldLines = diff.oldLines ?? oldContent.split(SPLIT_WITH_NEWLINES)
  const newLines = diff.newLines ?? newContent.split(SPLIT_WITH_NEWLINES)
  const output: string[] = []
  let oldIndex = 1
  let newIndex = 1

  for (const hunk of diff.hunks) {
    while (oldIndex < hunk.deletionStart && newIndex < hunk.additionStart) {
      output.push(oldLines[oldIndex - 1] ?? '')
      oldIndex += 1
      newIndex += 1
    }

    for (const content of hunk.hunkContent) {
      if (content.type === 'context') {
        for (let i = 0; i < content.lines.length; i += 1) {
          output.push(oldLines[oldIndex - 1] ?? '')
          oldIndex += 1
          newIndex += 1
        }
      } else {
        for (let i = 0; i < content.deletions.length; i += 1) {
          const lineNumber = oldIndex
          const isSelected = side === 'deletions' && selectedLines.has(lineNumber)
          const shouldApply = applySelected ? isSelected : !isSelected
          if (!shouldApply) {
            output.push(oldLines[oldIndex - 1] ?? '')
          }
          oldIndex += 1
        }
        for (let i = 0; i < content.additions.length; i += 1) {
          const lineNumber = newIndex
          const isSelected = side === 'additions' && selectedLines.has(lineNumber)
          const shouldApply = applySelected ? isSelected : !isSelected
          if (shouldApply) {
            output.push(newLines[newIndex - 1] ?? '')
          }
          newIndex += 1
        }
      }
    }
  }

  while (oldIndex <= oldLines.length && newIndex <= newLines.length) {
    output.push(oldLines[oldIndex - 1] ?? '')
    oldIndex += 1
    newIndex += 1
  }

  return output.join('')
}

export function GitDiffViewer({
  isOpen,
  onClose,
  terminalId,
  cwd,
  cwdPending = false,
  openRequestedAt = null,
  cwdReadyAt = null,
  displayMode = 'modal',
  panelShellMode = 'internal',
  onPanelShellStateChange,
  taskTitle,
  navigationTarget = null
}: GitDiffViewerProps) {
  const isPanel = displayMode === 'panel'
  const { getTerminalStyle, settings } = useSettings()
  const { t } = useI18n()
  const { getUIPreferences, updateUIPreferences } = useAppState()
  const perfCountersRef = useRef({
    renders: 0,
    loadDiff: 0,
    diffViewBuild: 0
  })
  const perfIntervalRef = useRef<number | null>(null)
  const timingRef = useRef<GitDiffTimingSnapshot>({
    openRequestedAt: null,
    shellShownAt: null,
    cwdReadyAt: null,
    diffLoadedAt: null
  })
  const diffMemoryRef = useRef<Record<string, DiffViewMemory>>({})
  const diffRestoreCycleRef = useRef(0)
  const diffRestoreAppliedRef = useRef<{ cycle: number; fileKey: string | null }>({ cycle: 0, fileKey: null })
  const subpageSnapshotRestoreEpochRef = useRef(0)
  const restoredAnchorRef = useRef<Record<string, RestoredAnchor>>({})
  const diffScrollCaptureTimerRef = useRef<number | null>(null)
  const suppressScrollCaptureRef = useRef(false)
  const [diffRestoreNotice, setDiffRestoreNotice] = useState<{
    type: 'changed'
    message: string
    fileName?: string
  } | null>(null)
  if (DEBUG_GIT_DIFF) {
    perfCountersRef.current.renders += 1
  }
  const [diffResult, setDiffResult] = useState<GitDiffResult | null>(null)
  const [selectedFile, setSelectedFile] = useState<GitFileStatus | null>(null)
  const [fileContents, setFileContents] = useState<Record<string, FileContentState>>({})
  const [largeFileConfirmState, setLargeFileConfirmState] = useState<LargeFileConfirmState | null>(null)
  const diffResultRef = useRef<GitDiffResult | null>(null)
  // Latches whether the root-only outline was shown while submodules were still
  // loading (DSM-03 / RSM-03). Captured at apply-time in applyLoadedDiffResult so
  // the autotest reads a deterministic latch instead of racing the transient.
  const submoduleLoadObservationRef = useRef<SubmoduleLoadObservation>(emptySubmoduleLoadObservation())
  const fileContentsRef = useRef<Record<string, FileContentState>>({})
  const largeFileConfirmRef = useRef<LargeFileConfirmState | null>(null)
  const allowedLargeFileKeysRef = useRef<Set<string>>(new Set())
  const staleFileContentKeysRef = useRef<Set<string>>(new Set())
  const pendingNavigationSelectRef = useRef<DiffNavigationSelectionTarget | null>(null)
  const [pendingNavigationSelectNonce, setPendingNavigationSelectNonce] = useState(0)
  // Ref-bridge so the watcher-driven invalidation listener (registered above
  // ensureFileContent in the file) can call into it without forming a hooks
  // dependency cycle. Updated on every render where ensureFileContent's
  // identity changes.
  const ensureFileContentRef = useRef<((file: GitFileStatus, force?: boolean, reason?: FileContentLoadReason) => Promise<void>) | null>(null)
  // Captures the most recent NON-NULL cwd so the always-on invalidation
  // listener can still match repo paths during the closed window — the
  // parent (TerminalGrid) sets cwd to null on close, which would otherwise
  // make the listener silently drop events fired between close and reopen.
  const lastKnownCwdRef = useRef<string | null>(null)
  const loadDiffRef = useRef<((options?: { reset?: boolean; silent?: boolean; force?: boolean }) => Promise<void>) | null>(null)
  const inFlightRef = useRef<Partial<Record<string, Promise<void>>>>({})
  const inFlightForceRef = useRef<Partial<Record<string, boolean>>>({})
  // Click → render latency tracker. One per component instance so two
  // GitDiffViewer panels (different terminals) keep independent histories.
  const clickLatencyTrackerRef = useRef<GitDiffClickLatencyTracker>(new GitDiffClickLatencyTracker())
  // Collapse state for the in-app debug panel. Persisted globally because
  // operators want the same setting across projects / terminals.
  const [debugPanelCollapsed, setDebugPanelCollapsed] = useState<boolean>(() => {
    if (typeof window === 'undefined') return true
    try {
      const saved = window.localStorage.getItem(STORAGE_KEY_DIFF_DEBUG_PANEL_COLLAPSED)
      if (saved === '0') return false
      if (saved === '1') return true
      return true
    } catch {
      return true
    }
  })
  const gitDiffPerformanceDiagnosticsEnabled =
    (window.electronAPI?.debug?.featureFlags?.gitDiffPerformanceDiagnostics ?? true) &&
    settings?.performanceDiagnosticsEnabled === true
  const handleDebugPanelToggle = useCallback((next: boolean) => {
    setDebugPanelCollapsed(next)
    try {
      window.localStorage.setItem(STORAGE_KEY_DIFF_DEBUG_PANEL_COLLAPSED, next ? '1' : '0')
    } catch {
      /* localStorage may be unavailable in restricted contexts */
    }
  }, [])
  // Lightweight prefetch state for the autotest debug surface.
  const rendererPrefetchSnapshotRef = useRef<BodyPrefetchSnapshot>({
    scheduled: 0,
    completed: 0,
    inFlight: false,
    candidates: [],
    lastReason: 'idle',
    lastDurationMs: null
  })
  const loadTokenRef = useRef(0)
  // Autotest observability: how many loadDiff passes actually started (i.e.
  // survived the in-flight coalescing gate). GRS-* asserts a single-file
  // discard triggers at most ONE list reconcile instead of the historical 2-3.
  const loadDiffStatsRef = useRef({ started: 0 })
  const loadInFlightRef = useRef(false)
  const loadQueuedRef = useRef<{ reset?: boolean; silent?: boolean; force?: boolean } | null>(null)
  const [navigationLoadSettledEpoch, setNavigationLoadSettledEpoch] = useState(0)
  const loadIdleWaitersRef = useRef<Array<() => void>>([])
  const lastDiffRef = useRef<{ cwd: string; originalCwd: string; at: number; result: GitDiffResult } | null>(null)
  const [actionMessage, setActionMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null)
  const [lineMessage, setLineMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null)
  const [actionState, setActionState] = useState<{ type: 'keep' | 'deny'; fileKey: string } | null>(null)
  const [selectedLineRange, setSelectedLineRangeState] = useState<SelectedLineRange | null>(null)
  const selectedLineRangeRef = useRef<SelectedLineRange | null>(null)
  const lineSelectionInfoRef = useRef<LineSelectionInfo | null>(null)
  const [lineActionState, setLineActionState] = useState<{ type: 'keep' | 'deny'; fileKey: string } | null>(null)
  const [editMessage, setEditMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null)
  const editMessageTimerRef = useRef<number>(0)
  const [isSavingEdit, setIsSavingEdit] = useState(false)
  const [isRefreshingChanges, setIsRefreshingChanges] = useState(false)
  const [termsPopoverOpen, setTermsPopoverOpen] = useState(false)
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; targetFile: GitFileStatus } | null>(null)
  const contextMenuElRef = useRef<HTMLDivElement | null>(null)
  const contextMenuPosition = useViewportMenuPosition(
    contextMenuElRef,
    contextMenu ? { x: contextMenu.x, y: contextMenu.y } : null,
    { surface: 'git-diff-file' }
  )
  const [fileListViewMode, setFileListViewModeState] = useState<GitDiffFileListViewMode>(() => {
    const prefs = getUIPreferences()
    if (isGitDiffFileListViewMode(prefs.gitDiffFileListViewMode)) return prefs.gitDiffFileListViewMode
    const saved = localStorage.getItem(STORAGE_KEY_FILE_LIST_VIEW_MODE)
    return isGitDiffFileListViewMode(saved) ? saved : 'tree'
  })
  const [splitViewMode, setSplitViewModeState] = useState<GitDiffSplitViewMode>(() => readStoredSplitViewMode())
  // Mirror of splitViewMode for stale-closure-free reads inside layout-measuring
  // useCallbacks (measureDiffSplitState / dragDiffSplitRatio) whose dependency
  // arrays must stay empty. getDiffLayoutMode needs the current mode so it can
  // skip the inline width-breakpoint when the user has forced 'split'.
  const splitViewModeRef = useRef<GitDiffSplitViewMode>(splitViewMode)
  splitViewModeRef.current = splitViewMode
  const [collapsedDiffTreeDirs, setCollapsedDiffTreeDirs] = useState<Set<string>>(() => new Set())
  const [imageDisplayMode, setImageDisplayMode] = useState<ImageDisplayMode>(() => {
    const prefs = getUIPreferences()
    const p = prefs.gitDiffImageDisplayMode
    if (p === 'original' || p === 'fit') return p
    const saved = localStorage.getItem(IMAGE_DISPLAY_MODE_STORAGE_KEY)
    return saved === 'original' || saved === 'fit' ? saved : 'fit'
  })
  const [imageCompareMode, setImageCompareMode] = useState<ImageCompareMode>(() => {
    const prefs = getUIPreferences()
    const p = prefs.gitDiffImageCompareMode
    if (p === '2up' || p === 'swipe' || p === 'onion') return p
    const saved = localStorage.getItem(IMAGE_COMPARE_MODE_STORAGE_KEY)
    return saved === '2up' || saved === 'swipe' || saved === 'onion' ? saved : '2up'
  })
  const diffSplitRatioRef = useRef<number>((() => {
    const prefs = getUIPreferences()
    if (prefs.gitDiffSplitViewRatio !== undefined) return prefs.gitDiffSplitViewRatio
    return readStoredDiffSplitRatio()
  })())
  const [diffEditorResetNonce, setDiffEditorResetNonce] = useState(0)
  const [svgViewMode, setSvgViewMode] = useState<SvgViewMode>('visual')
  const [pdfViewerUrl, setPdfViewerUrl] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const url = await window.electronAPI.appInfo?.getPdfViewerUrl?.()
        if (!cancelled && typeof url === 'string') setPdfViewerUrl(url)
      } catch {
        /* ignore — PDF diff will show a fallback message if URL unavailable */
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])
  const diffEditorRef = useRef<monacoTypes.editor.IStandaloneDiffEditor | null>(null)
  const monacoRef = useRef<typeof monacoTypes | null>(null)
  const diffEditorBindingDisposablesRef = useRef<Array<{ dispose: () => void }>>([])
  const diffHunkActionDisposablesRef = useRef<Array<{ dispose: () => void }>>([])
  const diffHunkActionWidgetHandlesRef = useRef<DiffHunkActionWidgetHandle[]>([])
  const hunkActionInstallIdentityRef = useRef<{ modelId: string | null; identityKey: string } | null>(null)
  const hunkActionInstallSettleFrameRef = useRef<number | null>(null)
  const hunkActionInstallSettleRunIdRef = useRef(0)
  const visibleHunkActionWidgetIdRef = useRef<string | null>(null)
  const diffSplitMeasureFrameRef = useRef<number | null>(null)
  const diffNavigationIndexRef = useRef(-1)
  const hunkActionInFlightRef = useRef(false)
  const hunkActionHoverHideTimerRef = useRef<number | null>(null)
  const lastHunkActionPromiseRef = useRef<Promise<boolean> | null>(null)
  const runDiffHunkActionRef = useRef<((action: DiffHunkAction, range: DiffHunkActionRange) => Promise<boolean>) | null>(null)
  const installDiffHunkActionWidgetsRef = useRef<null | ((
    editor: monacoTypes.editor.IStandaloneDiffEditor,
    monaco: typeof monacoTypes
  ) => HunkActionWidgetInstallResult)>(null)
  const isDraftDirtyRef = useRef(false)
  const autoRefreshInFlightRef = useRef(false)
  const autoRefreshQueuedRef = useRef(false)
  const selfSaveSuppressUntilRef = useRef(0)
  const originalDecorationsRef = useRef<monacoTypes.editor.IEditorDecorationsCollection | null>(null)
  const modifiedDecorationsRef = useRef<monacoTypes.editor.IEditorDecorationsCollection | null>(null)
  const selectedFileRef = useRef<GitFileStatus | null>(null)
  const lastFileContentLoadRef = useRef<LastFileContentLoadInfo | null>(null)
  const suppressDraftChangeRef = useRef(false)
  const applyLiveDraftChangeRef = useRef<(value?: string) => void>(() => {})
  const lastSelectedFileRef = useRef<GitFileStatus | null>(null)
  const visibleFileListRef = useRef<GitFileStatus[]>([])
  const visibleRepoItemsRef = useRef<RepoFilterTreeItem[]>([])
  const lastOpenScopeRef = useRef<string | null | undefined>(undefined)
  const resetDiffOnNextLoadRef = useRef(true)
  const suppressSelectionRestoreOnNextLoadRef = useRef(false)
  const suppressMemorySelectionRestoreUntilSelectionRef = useRef(false)
  const [diffRevealPhase, setDiffRevealPhase] = useState<DiffRevealPhase>('idle')
  const diffRevealPhaseRef = useRef<DiffRevealPhase>('idle')
  // What advanced waiting-diff → restoring-scroll (see DiffRevealTrigger).
  const lastRevealTriggerRef = useRef<DiffRevealTrigger>('timeout')
  // One-shot: the restore decision chose reveal-first-change but Monaco had
  // not computed line changes yet (fresh model swap); the next
  // onDidUpdateDiff for the SAME fileKey consumes it and reveals.
  const pendingFirstChangeRevealRef = useRef<{ fileKey: string; reason: string } | null>(null)
  // Autotest probe: last restore-vs-reveal decision taken by the cycle.
  const lastRestoreDecisionRef = useRef<DiffRestoreDecisionRecord | null>(null)
  // Cancellation token for the warm-reopen reveal settle loop.
  const warmRevealSettleRunIdRef = useRef(0)
  // Event-driven viewport-goal self-heal. A freshly (re)mounted DiffEditor
  // reports scrollHeight ≈ viewport for several frames until Monaco measures
  // the diff layout, so a pixel `setScrollTop` (restore) or a line reveal
  // executed at decision time gets CLAMPED (observed: saved 34262 → restored
  // 0; reveal line 600 → landed ~189). The decision records the intended
  // viewport goal here and `onDidContentSizeChange` re-applies it until the
  // editor can actually honor it — bounded by a 3 s window, dropped on file
  // switch / close / a user scroll away from the last applied offset.
  const pendingViewportGoalRef = useRef<{
    fileKey: string
    kind: 'scroll' | 'reveal-line'
    scrollTop?: number
    line?: number
    appliedScrollTop: number
    at: number
  } | null>(null)
  const diffRevealTimeoutRef = useRef<number | null>(null)
  const gitDiffOpenAtRef = useRef<number | null>(null)
  const coldMountRecordedRef = useRef(false)
  const tokenizeSettleQuietTimerRef = useRef<number | null>(null)
  const tokenizeSettleCapTimerRef = useRef<number | null>(null)
  const tokenizeSettleDisposablesRef = useRef<Array<{ dispose: () => void }>>([])
  const tokenizeSettleRunIdRef = useRef(0)
  const [repoFilter, setRepoFilter] = useState<string | null>(null)
  const repoFilterRef = useRef<string | null>(null)
  const auxiliaryMirrorRootsRef = useRef<Map<string, string>>(new Map())
  const [expandedRepoRoots, setExpandedRepoRoots] = useState<Set<string>>(() => new Set())
  const activeCwd = useMemo(() => diffResult?.cwd || cwd, [diffResult?.cwd, cwd])
  // Keep the Mirror subscription alive for the last diff cwd even while the
  // panel is closed. Closed-window mutations must still invalidate renderer
  // body caches before a same-cwd re-entry.
  const { snapshot: mirrorSnapshot } = useGitStateMirror(activeCwd || null)
  // G4 diagnostic: record (once per open) that the loading shell painted
  // REAL file rows from the mirror snapshot while getDiff was still
  // running — the "user is not staring at an anonymous spinner" proof a
  // slow-open bug report needs. Reset when the real list lands.
  const openSkeletonTracedRef = useRef(false)
  useEffect(() => {
    if (diffResult) {
      openSkeletonTracedRef.current = false
      return
    }
    if (openSkeletonTracedRef.current) return
    const count = mirrorSnapshot?.files?.length ?? 0
    if (count === 0) return
    openSkeletonTracedRef.current = true
    perfTraceDiagnostic(PERF_TRACE_EVENT.RENDERER_GIT_DIFF_OPEN_SKELETON_RENDERED, {
      cwd: activeCwd || '',
      fileCount: count
    })
  }, [diffResult, mirrorSnapshot, activeCwd])
  const getFileKey = useCallback((file: GitFileStatus, repoRoot = activeCwd || '') => {
    return buildGitDiffFileKey(file.repoRoot || repoRoot, file)
  }, [activeCwd])
  const jumpToEditorCheckTokenRef = useRef(0)
  const buildJumpToEditorTarget = useCallback((file: GitFileStatus | null) => {
    if (!file?.filename) return null
    const repoRoot = file.repoRoot || diffResult?.cwd || activeCwd || null
    if (!repoRoot) return null
    return {
      repoRoot,
      filePath: file.filename,
      key: getFileKey(file, repoRoot)
    }
  }, [activeCwd, diffResult?.cwd, getFileKey])
  const jumpToEditorTarget = useMemo(
    () => buildJumpToEditorTarget(selectedFile),
    [buildJumpToEditorTarget, selectedFile]
  )
  const [jumpToEditorCheck, setJumpToEditorCheck] = useState<{
    key: string | null
    status: 'checking' | 'available' | 'missing'
  }>({ key: null, status: 'missing' })
  const jumpToEditorStatus = !selectedFile
    ? 'no-selection'
    : !jumpToEditorTarget
      ? 'missing'
      : jumpToEditorCheck.key === jumpToEditorTarget.key
        ? jumpToEditorCheck.status
        : 'checking'

  useEffect(() => {
    const token = jumpToEditorCheckTokenRef.current + 1
    jumpToEditorCheckTokenRef.current = token
    if (!isOpen || !jumpToEditorTarget) {
      setJumpToEditorCheck({ key: null, status: 'missing' })
      return
    }

    const { key, repoRoot, filePath } = jumpToEditorTarget
    setJumpToEditorCheck({ key, status: 'checking' })
    void window.electronAPI.project.filesExist(repoRoot, [filePath])
      .then((exists) => {
        if (jumpToEditorCheckTokenRef.current !== token) return
        setJumpToEditorCheck({ key, status: exists[0] ? 'available' : 'missing' })
      })
      .catch(() => {
        if (jumpToEditorCheckTokenRef.current !== token) return
        setJumpToEditorCheck({ key, status: 'missing' })
      })
    return () => {
      if (jumpToEditorCheckTokenRef.current === token) {
        jumpToEditorCheckTokenRef.current += 1
      }
    }
  }, [
    isOpen,
    jumpToEditorTarget,
    mirrorSnapshot?.changeFingerprint,
    mirrorSnapshot?.generation
  ])

  useEffect(() => {
    const current = auxiliaryMirrorRootsRef.current
    const next = new Map<string, string>()
    const activeKey = activeCwd ? normalizeInvalidationPath(activeCwd) : ''
    const addRoot = (root: string | null | undefined) => {
      if (!root) return
      const key = normalizeInvalidationPath(root)
      if (!key || key === activeKey) return
      next.set(key, root)
    }

    if (activeCwd && diffResult?.success) {
      for (const repo of diffResult.repos ?? []) addRoot(repo.root)
      for (const file of diffResult.files) addRoot(file.repoRoot)
    }

    for (const [key, root] of current) {
      if (next.has(key)) continue
      window.electronAPI.git.unsubscribeMirror(root)
      perfTrace(PERF_TRACE_EVENT.RENDERER_GIT_DIFF_AUX_MIRROR_SUBSCRIPTION, {
        cwd: activeCwd,
        terminalId,
        repoRoot: root,
        action: 'unsubscribe'
      })
    }

    for (const [key, root] of next) {
      if (current.has(key)) continue
      void window.electronAPI.git.subscribeMirror(root)
      perfTrace(PERF_TRACE_EVENT.RENDERER_GIT_DIFF_AUX_MIRROR_SUBSCRIPTION, {
        cwd: activeCwd,
        terminalId,
        repoRoot: root,
        action: 'subscribe'
      })
    }

    auxiliaryMirrorRootsRef.current = next
  }, [activeCwd, diffResult, terminalId])

  useEffect(() => {
    return () => {
      for (const root of auxiliaryMirrorRootsRef.current.values()) {
        window.electronAPI.git.unsubscribeMirror(root)
      }
      auxiliaryMirrorRootsRef.current.clear()
    }
  }, [])

  // Whenever a click measurement seals, emit one perf-trace span per phase
  // (plus a total span) so a Perfetto capture carries the same JadeTree
  // chain that the in-app debug panel surfaces. `addListener` returns the
  // unsubscribe handle; we re-subscribe whenever cwd / terminalId change so
  // the trace context tag matches the current selection.
  useEffect(() => {
    const tracker = clickLatencyTrackerRef.current
    return tracker.addListener((measurement) => {
      const records = buildClickPhaseTraceRecords(measurement, {
        cwd: activeCwd ?? '',
        terminalId
      })
      for (const record of records) {
        perfTrace(record.event, record.payload)
      }
    })
  }, [activeCwd, terminalId])

  const selectedFileKey = selectedFile ? getFileKey(selectedFile) : null
  // The editor identity deliberately EXCLUDES the mirror generation: remounts
  // happen only on explicit user actions (Refresh Changes / file switch bump
  // `diffEditorResetNonce`; cwd / selection changes re-key naturally). Folding
  // `mirrorSnapshot.generation` in here made EVERY background repo state
  // change tear down the whole Monaco editor — the visible "global refresh"
  // of the 2026-07-16 revert-scope bug. Mirror data changes now flow through
  // normal React props/state updates without a remount.
  const diffEditorIdentityKey = `${activeCwd || 'no-cwd'}::${selectedFileKey || 'empty'}::n${diffEditorResetNonce}`
  const currentDiffIdentityRef = useRef(diffEditorIdentityKey)
  useEffect(() => {
    currentDiffIdentityRef.current = diffEditorIdentityKey
  }, [diffEditorIdentityKey])
  const selectedFileState = selectedFileKey ? fileContents[selectedFileKey] : null
  const statusText = useMemo(() => ({
    M: t('gitDiff.status.modified'),
    A: t('gitDiff.status.added'),
    D: t('gitDiff.status.deleted'),
    R: t('gitDiff.status.renamed'),
    C: t('gitDiff.status.copied'),
    '?': t('gitDiff.status.untracked'),
    '!': t('gitDiff.status.conflict')
  }), [t])
  const changeTypeText = useMemo(() => ({
    unstaged: t('gitDiff.changeType.unstaged'),
    staged: t('gitDiff.changeType.staged'),
    untracked: t('gitDiff.changeType.untracked'),
    conflict: t('gitDiff.changeType.conflict')
  }), [t])
  const resolveSetiFileIcon = useMemo(
    () => createThemedSetiFileIconResolver(settings?.theme),
    [settings?.theme]
  )
  // Keep diffRevealPhase ref in sync with state
  useEffect(() => { diffRevealPhaseRef.current = diffRevealPhase }, [diffRevealPhase])
  const cancelDiffRevealTimeout = useCallback(() => {
    if (diffRevealTimeoutRef.current !== null) {
      window.clearTimeout(diffRevealTimeoutRef.current)
      diffRevealTimeoutRef.current = null
    }
  }, [])
  const requestDiffRevealRestore = useCallback((reason: DiffRevealTrigger) => {
    if (diffRevealPhaseRef.current !== 'waiting-diff') return
    if (reason === 'timeout') {
      const file = selectedFileRef.current
      const fileKey = file ? getFileKey(file) : null
      perfTrace(PERF_TRACE_EVENT.RENDERER_GIT_DIFF_CLICK_PHASE_REVEAL_TIMEOUT, {
        cwd: activeCwd ?? '',
        terminalId,
        fileKey,
        filename: file?.filename,
        durationMs: DIFF_REVEAL_TIMEOUT_MS
      })
    }
    lastRevealTriggerRef.current = reason
    setDiffRevealPhase('restoring-scroll')
    diffRevealPhaseRef.current = 'restoring-scroll'
  }, [activeCwd, getFileKey, terminalId])
  const enterDiffWaiting = useCallback(() => {
    cancelDiffRevealTimeout()
    setDiffRevealPhase('waiting-diff')
    diffRevealPhaseRef.current = 'waiting-diff'
    // Safety timeout is telemetry, not the happy path: model binding or
    // onDidUpdateDiff should reveal first. If neither signal arrives, reveal
    // anyway and record the abnormal fixed-wait path.
    diffRevealTimeoutRef.current = window.setTimeout(() => {
      requestDiffRevealRestore('timeout')
    }, DIFF_REVEAL_TIMEOUT_MS)
  }, [cancelDiffRevealTimeout, requestDiffRevealRestore])

  // Warm-reopen fast path: complete the render-then-reveal cycle when Monaco
  // already holds this file's computed diff. Model reuse across close/reopen
  // fires no `onDidUpdateDiff` (same reality the hunk-widget settle documents
  // at HUNK_ACTION_INSTALL_SETTLE_*), and the 'model-bound' signal is gated
  // on an active click-latency measurement that a reopen does not have —
  // without this, every warm reopen idled in `waiting-diff` until the 2 s
  // safety timeout (the 2026-07-18 "stale until manual refresh" bundle).
  // Frame-bounded; the safety timeout stays armed as the backstop.
  const maybeCompleteWarmReveal = useCallback(() => {
    const runId = ++warmRevealSettleRunIdRef.current
    const startedAt = performance.now()
    const tick = () => {
      if (runId !== warmRevealSettleRunIdRef.current) return
      if (diffRevealPhaseRef.current !== 'waiting-diff') return
      const editor = diffEditorRef.current
      const file = selectedFileRef.current
      if (editor && file && activeCwd) {
        const fileKey = getFileKey(file)
        const state = fileContentsRef.current[fileKey]
        const originalUri = editor.getOriginalEditor().getModel()?.uri.toString()
        const modifiedUri = editor.getModifiedEditor().getModel()?.uri.toString()
        const modelsMatch =
          originalUri === buildGitDiffModelPath(file, activeCwd, 'original') &&
          modifiedUri === buildGitDiffModelPath(file, activeCwd, 'modified')
        // A stale-marked key means a forced refetch is on its way (the
        // selection effect fires it) — deciding against the OLD body would
        // restore a position the fresh content invalidates, and the later
        // onDidUpdateDiff cannot re-open an idle cycle. Wait it out.
        const isStale = staleFileContentKeysRef.current.has(fileKey)
        if (
          state && !state.loading && !state.error && !state.isBinary &&
          !isStale && modelsMatch && editor.getLineChanges() !== null
        ) {
          requestDiffRevealRestore('warm-ready')
          return
        }
      }
      if (performance.now() - startedAt > WARM_REVEAL_SETTLE_MAX_MS) return
      requestAnimationFrame(tick)
    }
    tick()
  }, [activeCwd, getFileKey, requestDiffRevealRestore])

  // Re-apply the parked viewport goal (see pendingViewportGoalRef) once the
  // editor's measured content can honor it. Driven by onDidContentSizeChange;
  // self-cancels on window expiry, file switch, or a user scroll away from
  // the last applied offset.
  const emitViewportGoalTransition = useCallback((
    phase: 'parked' | 'satisfied' | 'cancelled-scroll' | 'expired' | 'cancelled-context',
    goal: { kind: 'scroll' | 'reveal-line'; scrollTop?: number; line?: number }
  ) => {
    perfTraceDiagnostic(PERF_TRACE_EVENT.RENDERER_GIT_DIFF_VIEWPORT_GOAL, {
      cwd: activeCwd ?? '',
      terminalId,
      phase,
      kind: goal.kind,
      scrollTop: goal.scrollTop ?? null,
      line: goal.line ?? null
    })
  }, [activeCwd, terminalId])

  const reapplyPendingViewportGoal = useCallback(() => {
    const goal = pendingViewportGoalRef.current
    if (!goal) return
    const editor = diffEditorRef.current
    const file = selectedFileRef.current
    const fileKey = file ? getFileKey(file) : null
    // 10 s window: Monaco's post-remount diff layout can lag for seconds on
    // an EDR-throttled host; the fileKey match + user-scroll cancel below
    // keep a long window safe.
    if (!editor || !fileKey || fileKey !== goal.fileKey) {
      pendingViewportGoalRef.current = null
      emitViewportGoalTransition('cancelled-context', goal)
      return
    }
    if (Date.now() - goal.at > 10000) {
      pendingViewportGoalRef.current = null
      emitViewportGoalTransition('expired', goal)
      return
    }
    const modifiedEditor = editor.getModifiedEditor()
    if (Math.abs(modifiedEditor.getScrollTop() - goal.appliedScrollTop) > 100) {
      pendingViewportGoalRef.current = null
      emitViewportGoalTransition('cancelled-scroll', goal)
      return
    }
    suppressScrollCaptureRef.current = true
    try {
      if (goal.kind === 'scroll' && goal.scrollTop !== undefined) {
        modifiedEditor.setScrollTop(goal.scrollTop)
        const after = modifiedEditor.getScrollTop()
        goal.appliedScrollTop = after
        if (Math.abs(after - goal.scrollTop) <= 2) {
          restoredAnchorRef.current[fileKey] = { line: null, scrollTop: after }
          pendingViewportGoalRef.current = null
          emitViewportGoalTransition('satisfied', goal)
        }
      } else if (goal.kind === 'reveal-line' && goal.line !== undefined) {
        revealLineNearTopSafe(modifiedEditor, goal.line)
        goal.appliedScrollTop = modifiedEditor.getScrollTop()
        const lineTop = modifiedEditor.getTopForLineNumber(goal.line)
        const delta = lineTop - goal.appliedScrollTop
        if (delta >= 0 && delta <= modifiedEditor.getLayoutInfo().height * 0.6) {
          pendingViewportGoalRef.current = null
          emitViewportGoalTransition('satisfied', goal)
        }
      }
    } finally {
      window.setTimeout(() => { suppressScrollCaptureRef.current = false }, 50)
    }
  }, [emitViewportGoalTransition, getFileKey])

  const isDraftDirty = selectedFileState?.draftContent !== undefined &&
    selectedFileState.draftContent !== selectedFileState.modifiedContent
  const hasAnyUnsavedDraft = useMemo(() => {
    return Object.values(fileContents).some((state) =>
      state?.draftContent !== undefined && state.draftContent !== state.modifiedContent
    )
  }, [fileContents])
  const effectiveModifiedContent = selectedFileState?.draftContent ?? selectedFileState?.modifiedContent ?? ''
  const editDisabledReason = useMemo(() => {
    if (!selectedFile) return t('gitDiff.editDisabled.noFile')
    if (!selectedFileState) return t('gitDiff.editDisabled.fileNotLoaded')
    if (selectedFileState.loading) return t('gitDiff.editDisabled.fileLoading')
    if (selectedFileState.error) return t('gitDiff.editDisabled.readFailed')
    if (selectedFileState.isBinary) return t('gitDiff.editDisabled.binary')
    if (selectedFile.isSubmoduleEntry) return t('gitDiff.editDisabled.submodule')
    if (selectedFile.status === 'D') return t('gitDiff.editDisabled.deleted')
    if (selectedFile.changeType === 'staged') return t('gitDiff.editDisabled.staged')
    return ''
  }, [selectedFile, selectedFileState, t])
  const canEditFile = editDisabledReason.length === 0
  const canSaveDraft = canEditFile && isDraftDirty && !isSavingEdit
  const hasMultipleRepos = Boolean(diffResult?.repos && diffResult.repos.length > 1)
  useEffect(() => {
    const repos = diffResult?.repos ?? []
    if (repos.length === 0) return
    setExpandedRepoRoots((prev) => {
      const next = new Set(prev)
      for (const repo of repos) {
        next.add(normalizeRepoRoot(repo.root))
        if (repo.parentRoot) {
          next.add(normalizeRepoRoot(repo.parentRoot))
        }
      }
      return next
    })
  }, [diffResult?.repos])
  const visibleFileList = useMemo(() => {
    const files = diffResult?.files ?? []
    return repoFilter ? files.filter((file) => file.repoRoot === repoFilter) : files
  }, [diffResult?.files, repoFilter])
  const visibleRepoItems = useMemo(() => buildRepoFilterTreeItems(
    diffResult?.repos,
    expandedRepoRoots,
    diffResult?.cwd || cwd || null,
    t('gitDiff.repo.current'),
    (repo) => repo.changeCount > 0 || Boolean(repo.loading) || !repo.isSubmodule
  ), [cwd, diffResult?.cwd, diffResult?.repos, expandedRepoRoots, t])
  useEffect(() => {
    diffResultRef.current = diffResult
  }, [diffResult])
  useEffect(() => {
    visibleFileListRef.current = visibleFileList
  }, [visibleFileList])
  useEffect(() => {
    visibleRepoItemsRef.current = visibleRepoItems
  }, [visibleRepoItems])
  const setRepoExpanded = useCallback((repoRoot: string, expanded: boolean) => {
    const key = normalizeRepoRoot(repoRoot)
    if (!key) return false
    setExpandedRepoRoots((prev) => {
      const next = new Set(prev)
      if (expanded) {
        next.add(key)
      } else {
        next.delete(key)
      }
      return next
    })
    return true
  }, [])
  const toggleRepoExpanded = useCallback((repoRoot: string) => {
    const key = normalizeRepoRoot(repoRoot)
    if (!key) return
    setExpandedRepoRoots((prev) => {
      const next = new Set(prev)
      if (next.has(key)) {
        next.delete(key)
      } else {
        next.add(key)
      }
      return next
    })
  }, [])
  const updateRepoFilter = useCallback((repoRoot: string | null) => {
    repoFilterRef.current = repoRoot
    setRepoFilter(repoRoot)
    return true
  }, [])
  const confirmCloseWithDraft = useCallback(() => {
    if (!hasAnyUnsavedDraft) return true
    return window.confirm(t('gitDiff.confirm.closeWithDraft'))
  }, [hasAnyUnsavedDraft, t])
  const toggleImageDisplayMode = useCallback((mode: ImageDisplayMode) => {
    setImageDisplayMode(mode)
    localStorage.setItem(IMAGE_DISPLAY_MODE_STORAGE_KEY, mode)
    updateUIPreferences({ gitDiffImageDisplayMode: mode })
  }, [updateUIPreferences])
  const toggleImageCompareMode = useCallback((mode: ImageCompareMode) => {
    setImageCompareMode(mode)
    localStorage.setItem(IMAGE_COMPARE_MODE_STORAGE_KEY, mode)
    updateUIPreferences({ gitDiffImageCompareMode: mode })
  }, [updateUIPreferences])
  const setFileListViewMode = useCallback((mode: GitDiffFileListViewMode) => {
    setFileListViewModeState(mode)
    localStorage.setItem(STORAGE_KEY_FILE_LIST_VIEW_MODE, mode)
    updateUIPreferences({ gitDiffFileListViewMode: mode })
    perfTrace(PERF_TRACE_EVENT.RENDERER_GIT_DIFF_FILE_LIST_MODE_CHANGE, {
      terminalId,
      cwd: activeCwd,
      mode
    })
  }, [activeCwd, terminalId, updateUIPreferences])

  const setSplitViewMode = useCallback((mode: GitDiffSplitViewMode) => {
    // Product telemetry: count each split/inline display-mode toggle.
    trackFeatureUse('git-diff-mode-toggle')
    setSplitViewModeState(mode)
    try {
      localStorage.setItem(STORAGE_KEY_DIFF_SPLIT_VIEW_MODE, mode)
    } catch {
      /* localStorage may be unavailable in private contexts; persist best-effort */
    }
    perfTrace(PERF_TRACE_EVENT.RENDERER_GIT_DIFF_SPLIT_MODE_TOGGLE, {
      terminalId,
      cwd: activeCwd,
      mode
    })
  }, [activeCwd, terminalId])

  const persistDiffSplitRatio = useCallback((nextRatio: number) => {
    const normalized = clampDiffSplitRatio(nextRatio)
    const prev = diffSplitRatioRef.current
    if (Math.abs(prev - normalized) <= DIFF_SPLIT_RATIO_EPSILON) return prev
    diffSplitRatioRef.current = normalized
    localStorage.setItem(STORAGE_KEY_DIFF_SPLIT_RATIO, String(normalized))
    updateUIPreferences({ gitDiffSplitViewRatio: normalized })
    return normalized
  }, [updateUIPreferences])

  // --- Path copy (shared hook) ---
  const { copyMessage, copyToClipboard, showCopyError, flashCopyFeedback } = usePathCopy(t, 'gitDiff.copyFailed')
  const {
    entryOnDisk,
    checkEntryOnDisk,
    openWithDefaultApp,
    revealInFileManager,
    revealLabel
  } = useFileEntryOsActions(t, showCopyError)

  const handleFilenameDblClick = useCallback(async (e: React.MouseEvent) => {
    if (!selectedFile) return
    const target = e.currentTarget as HTMLElement
    const rootCwd = selectedFile.repoRoot || activeCwd || ''
    const isAbsolute = e.altKey
    const relativePath = selectedFile.filename
    const pathToCopy = isAbsolute ? `${rootCwd}/${relativePath}` : relativePath
    const label = isAbsolute ? t('common.absolutePath') : t('common.relativePath')
    const ok = await copyToClipboard(pathToCopy, label)
    if (ok) flashCopyFeedback(target)
  }, [selectedFile, activeCwd, copyToClipboard, flashCopyFeedback, t])

  const handleFileContextMenu = useCallback((e: React.MouseEvent, file: GitFileStatus) => {
    e.preventDefault()
    e.stopPropagation()
    setContextMenu({ x: e.clientX, y: e.clientY, targetFile: file })
    // Deleted rows skip the on-disk existence check — the OS actions stay disabled.
    checkEntryOnDisk('git-diff', file.repoRoot || activeCwd, file.filename, {
      skip: file.status === 'D'
    })
  }, [activeCwd, checkEntryOnDisk])

  const closeContextMenu = useCallback(() => {
    setContextMenu(null)
  }, [])

  const copyContextMenuPath = useCallback(async (file: GitFileStatus, kind: 'name' | 'relative' | 'absolute') => {
    const rootCwd = file.repoRoot || activeCwd || ''
    if (kind === 'name') {
      const name = file.filename.split('/').pop() || file.filename
      await copyToClipboard(name, t('common.name'))
    } else if (kind === 'relative') {
      await copyToClipboard(file.filename, t('common.relativePath'))
    } else {
      await copyToClipboard(`${rootCwd}/${file.filename}`, t('common.absolutePath'))
    }
    closeContextMenu()
  }, [activeCwd, copyToClipboard, closeContextMenu, t])

  useEffect(() => {
    if (!contextMenu) return
    const handleMouseDown = () => setContextMenu(null)
    document.addEventListener('mousedown', handleMouseDown)
    return () => document.removeEventListener('mousedown', handleMouseDown)
  }, [contextMenu])

  useEffect(() => {
    if (!termsPopoverOpen) return
    const handleMouseDown = (event: MouseEvent) => {
      const target = event.target as HTMLElement | null
      if (target?.closest('.git-diff-terms-help')) return
      setTermsPopoverOpen(false)
    }
    document.addEventListener('mousedown', handleMouseDown)
    return () => document.removeEventListener('mousedown', handleMouseDown)
  }, [termsPopoverOpen])

  // File list width (read from uiPreferences, fallback to localStorage)
  const [fileListWidth, setFileListWidth] = useState(() => {
    const prefs = getUIPreferences()
    if (prefs.gitDiffFileListWidth !== undefined) return prefs.gitDiffFileListWidth
    const saved = localStorage.getItem(STORAGE_KEY_FILE_LIST_WIDTH)
    return saved ? parseInt(saved, 10) : DEFAULT_FILE_LIST_WIDTH
  })
  const fileListWidthRef = useRef(fileListWidth)
  const isDraggingRef = useRef(false)

  // Pop-up window size (read from uiPreferences, fallback to localStorage)
  const [modalSize, setModalSize] = useState(() => {
    if (isPanel) {
      return { width: DEFAULT_MODAL_WIDTH, height: DEFAULT_MODAL_HEIGHT }
    }
    const prefs = getUIPreferences()
    if (prefs.gitDiffModalSize) {
      return { width: prefs.gitDiffModalSize.width || DEFAULT_MODAL_WIDTH, height: prefs.gitDiffModalSize.height || DEFAULT_MODAL_HEIGHT }
    }
    const saved = localStorage.getItem(STORAGE_KEY_MODAL_SIZE)
    if (saved) {
      try {
        const parsed = JSON.parse(saved)
        return {
          width: parsed.width || DEFAULT_MODAL_WIDTH,
          height: parsed.height || DEFAULT_MODAL_HEIGHT
        }
      } catch {
        return { width: DEFAULT_MODAL_WIDTH, height: DEFAULT_MODAL_HEIGHT }
      }
    }
    return { width: DEFAULT_MODAL_WIDTH, height: DEFAULT_MODAL_HEIGHT }
  })
  const modalSizeRef = useRef(modalSize)
  const isResizingModalRef = useRef(false)
  const resizeDirectionRef = useRef<string>('')

  const getMemoryKey = useCallback((repoRootOverride?: string | null) => {
    const repo = repoRootOverride || activeCwd || cwd || ''
    const terminal = terminalId || ''
    if (!repo || !terminal) return ''
    return `${terminal}::${repo}`
  }, [activeCwd, cwd, terminalId])

  const getMemoryStore = useCallback(() => {
    const key = getMemoryKey()
    if (!key) return null
    if (!diffMemoryRef.current[key]) {
      diffMemoryRef.current[key] = {
        selectedFileKey: null,
        entries: {}
      }
    }
    return diffMemoryRef.current[key]
  }, [getMemoryKey])

  const findMemoryEntry = useCallback((
    memory: DiffViewMemory,
    file: GitFileStatus,
    fileKey: string
  ): DiffViewMemoryEntry | null => {
    const direct = memory.entries[fileKey]
    if (direct) return direct
    const match = Object.values(memory.entries).find((entry) =>
      entry.filePath === file.filename &&
      (entry.originalFilename ?? '') === (file.originalFilename ?? '')
    )
    return match ?? null
  }, [])

  const captureDiffView = useCallback((fileKeyOverride?: string | null) => {
    const memory = getMemoryStore()
    if (!memory) return
    const editor = diffEditorRef.current
    if (!editor) return
    const file = selectedFileRef.current
    const fileKey = fileKeyOverride ?? (file ? getFileKey(file) : null)
    if (!fileKey || !file) return
    const fileState = fileContentsRef.current[fileKey]
    const modifiedEditor = editor.getModifiedEditor()
    const expectedModelUri = buildGitDiffModelPath(file, activeCwd, 'modified')
    if (
      !fileState
      || fileState.loading
      || fileState.isBinary
      || modifiedEditor.getModel()?.uri.toString() !== expectedModelUri
    ) {
      return
    }
    const visibleRanges = modifiedEditor.getVisibleRanges()
    const firstVisibleLine = visibleRanges.length > 0 ? visibleRanges[0].startLineNumber : null
    const scrollTop = modifiedEditor.getScrollTop()
    const anchor: DiffViewAnchor = {
      line: firstVisibleLine,
      scrollTop
    }
    const signature = fileState && !fileState.isBinary
      ? buildDiffSignature(
        fileState.originalContent ?? '',
        fileState.draftContent ?? fileState.modifiedContent ?? ''
      )
      : null
    memory.entries[fileKey] = {
      fileKey,
      filePath: file.filename,
      originalFilename: file.originalFilename,
      anchor,
      scrollTop,
      signature,
      updatedAt: Date.now()
    }
    memory.selectedFileKey = fileKey
  }, [
    activeCwd,
    getFileKey,
    getMemoryStore
  ])

  const clearCurrentMemorySelection = useCallback(() => {
    const memory = getMemoryStore()
    if (memory) clearGitDiffMemorySelection(memory)
  }, [getMemoryStore])

  const scrollToFirstChange = useCallback(() => {
    const editor = diffEditorRef.current
    if (!editor) return
    const changes = editor.getLineChanges()
    if (!changes || changes.length === 0) return
    const firstChange = changes[0]
    const targetLine = firstChange.modifiedStartLineNumber || firstChange.originalStartLineNumber || 1
    revealLineNearTopSafe(editor.getModifiedEditor(), targetLine)
  }, [])

  const scrollToTop = useCallback(() => {
    const editor = diffEditorRef.current
    if (!editor) return
    editor.getModifiedEditor().setScrollTop(0)
  }, [])

  const setSelectedLineRangeValue = useCallback((range: SelectedLineRange | null) => {
    selectedLineRangeRef.current = range
    lineSelectionInfoRef.current = resolveLineSelectionInfo(range, t('gitDiff.line.invalid.crossSide'))
    setSelectedLineRangeState(range)
  }, [t])

  const navigateDiffChange = useCallback((direction: 'previous' | 'next') => {
    const editor = diffEditorRef.current
    if (!editor) return false
    const changes = editor.getLineChanges() ?? []
    if (changes.length === 0) return false
    const modifiedEditor = editor.getModifiedEditor()
    const visibleRanges = modifiedEditor.getVisibleRanges()
    const referenceLine = visibleRanges[0]?.startLineNumber ?? modifiedEditor.getPosition()?.lineNumber ?? 1
    let currentIndex = diffNavigationIndexRef.current
    if (currentIndex < 0 || currentIndex >= changes.length) {
      currentIndex = changes.findIndex((change) => {
        const line = change.modifiedStartLineNumber || change.modifiedEndLineNumber || change.originalStartLineNumber || 1
        return line >= referenceLine
      })
      if (currentIndex < 0) currentIndex = direction === 'next' ? -1 : 0
    }
    const delta = direction === 'next' ? 1 : -1
    const nextIndex = (currentIndex + delta + changes.length) % changes.length
    const target = changes[nextIndex]
    const lineCount = modifiedEditor.getModel()?.getLineCount() ?? 1
    if (lineCount <= 0) return false
    const rawLine = target.modifiedStartLineNumber || target.modifiedEndLineNumber || target.originalStartLineNumber || 1
    const line = Math.max(1, Math.min(rawLine, lineCount))
    diffNavigationIndexRef.current = nextIndex
    modifiedEditor.setPosition({ lineNumber: line, column: 1 })
    modifiedEditor.revealLineInCenterIfOutsideViewport(line)
    perfTrace(PERF_TRACE_EVENT.RENDERER_GIT_DIFF_HUNK_NAVIGATE, {
      cwd: activeCwd,
      terminalId,
      direction,
      index: nextIndex,
      changeCount: changes.length,
      line
    })
    const monaco = monacoRef.current
    if (monaco) {
      installDiffHunkActionWidgetsRef.current?.(editor, monaco)
    }
    return true
  }, [activeCwd, terminalId])

  const clearHunkActionHoverHideTimer = useCallback(() => {
    if (hunkActionHoverHideTimerRef.current !== null) {
      window.clearTimeout(hunkActionHoverHideTimerRef.current)
      hunkActionHoverHideTimerRef.current = null
    }
  }, [])

  const setVisibleDiffHunkActionWidget = useCallback((widgetId: string | null) => {
    clearHunkActionHoverHideTimer()
    visibleHunkActionWidgetIdRef.current = widgetId
    for (const handle of diffHunkActionWidgetHandlesRef.current) {
      const visible = widgetId !== null && handle.id === widgetId
      handle.node.classList.toggle('is-visible', visible)
      handle.node.setAttribute('aria-hidden', visible ? 'false' : 'true')
      for (const button of handle.buttons) {
        button.tabIndex = visible ? 0 : -1
      }
    }
  }, [clearHunkActionHoverHideTimer])

  const scheduleHideDiffHunkActionWidgets = useCallback((delayMs = HUNK_ACTION_HOVER_HIDE_DELAY_MS) => {
    clearHunkActionHoverHideTimer()
    hunkActionHoverHideTimerRef.current = window.setTimeout(() => {
      hunkActionHoverHideTimerRef.current = null
      setVisibleDiffHunkActionWidget(null)
    }, delayMs)
  }, [clearHunkActionHoverHideTimer, setVisibleDiffHunkActionWidget])

  const cancelHunkActionInstallSettling = useCallback(() => {
    hunkActionInstallSettleRunIdRef.current += 1
    if (hunkActionInstallSettleFrameRef.current !== null) {
      window.cancelAnimationFrame(hunkActionInstallSettleFrameRef.current)
      hunkActionInstallSettleFrameRef.current = null
    }
  }, [])

  const revealDiffHunkActionForLine = useCallback((line: number | null | undefined): boolean => {
    if (typeof line !== 'number' || !Number.isFinite(line)) return false
    if (diffHunkActionWidgetHandlesRef.current.length === 0) {
      const editor = diffEditorRef.current
      const monaco = monacoRef.current
      if (editor && monaco) {
        installDiffHunkActionWidgetsRef.current?.(editor, monaco)
      }
    }
    const ranges = diffHunkActionWidgetHandlesRef.current.map((handle) => handle.range)
    const range = findHunkContainingLine(line, ranges)
    if (!range) {
      scheduleHideDiffHunkActionWidgets()
      return false
    }
    const handle = diffHunkActionWidgetHandlesRef.current.find((candidate) => candidate.range.id === range.id)
    if (!handle) {
      scheduleHideDiffHunkActionWidgets()
      return false
    }
    setVisibleDiffHunkActionWidget(handle.id)
    return true
  }, [scheduleHideDiffHunkActionWidgets, setVisibleDiffHunkActionWidget])

  const disposeDiffHunkActionWidgets = useCallback(() => {
    const count = diffHunkActionDisposablesRef.current.length
    clearHunkActionHoverHideTimer()
    visibleHunkActionWidgetIdRef.current = null
    for (const disposable of diffHunkActionDisposablesRef.current) {
      try {
        disposable.dispose()
      } catch (error) {
        debugLog('editor:dispose-hunk-action:error', { error: String(error) })
      }
    }
    diffHunkActionDisposablesRef.current = []
    diffHunkActionWidgetHandlesRef.current = []
    hunkActionInstallIdentityRef.current = null
    if (count > 0) {
      debugLog('editor:hunk-actions:disposed', { count })
    }
  }, [clearHunkActionHoverHideTimer])

  const installDiffHunkActionWidgets = useCallback((
    editor: monacoTypes.editor.IStandaloneDiffEditor,
    monaco: typeof monacoTypes
  ): HunkActionWidgetInstallResult => {
    const startedAt = performance.now()
    disposeDiffHunkActionWidgets()

    const file = selectedFileRef.current ?? selectedFile
    const finish = (
      result: HunkActionWidgetInstallResult,
      extra: Record<string, unknown> = {}
    ): HunkActionWidgetInstallResult => {
      perfTrace(PERF_TRACE_EVENT.RENDERER_GIT_DIFF_HUNK_WIDGET_INSTALL, {
        cwd: activeCwd,
        terminalId,
        filename: file?.filename,
        changeType: file?.changeType,
        result,
        widgetCount: diffHunkActionDisposablesRef.current.length,
        durationMs: +(performance.now() - startedAt).toFixed(2),
        ...extra
      })
      return result
    }

    if (!file || file.isSubmoduleEntry || file.changeType === 'untracked' || file.status === 'D') {
      return finish('skipped', { reason: !file ? 'no-file' : file.isSubmoduleEntry ? 'submodule' : file.changeType === 'untracked' ? 'untracked' : 'deleted' })
    }
    const key = getFileKey(file)
    const state = fileContentsRef.current[key] ?? (
      selectedFile && getFileKey(selectedFile) === key ? selectedFileState : null
    )

    const changes = editor.getLineChanges() ?? []
    const originalEditor = editor.getOriginalEditor()
    const modifiedEditor = editor.getModifiedEditor()
    const lineCount = modifiedEditor.getModel()?.getLineCount() ?? 1
    const isStagedFile = file.changeType === 'staged'
    const liveOriginalContent = originalEditor.getValue()
    const liveModifiedContent = modifiedEditor.getValue()
    const expectedModifiedContent = state?.draftContent ?? state?.modifiedContent
    if (
      state &&
      !state.loading &&
      !state.error &&
      !state.isBinary &&
      liveOriginalContent.length === 0 &&
      liveModifiedContent.length === 0 &&
      ((state.originalContent ?? '').length > 0 || (expectedModifiedContent ?? '').length > 0)
    ) {
      return finish('retry', {
        reason: 'model-placeholder',
        lineChangeCount: changes.length
      })
    }
    const plan = buildHunkActionWidgetPlan({
      file,
      state,
      isDraftDirty: isDraftDirtyRef.current,
      changes,
      lineCount
    })
    if (plan.eligibility.result !== 'installed') {
      return finish(plan.eligibility.result, {
        reason: plan.eligibility.reason,
        lineChangeCount: changes.length
      })
    }

    plan.widgets.forEach(({ anchorLine, range, showRevert }) => {
      const widgetId = `onward.gitDiff.hunkAction.${range.id}`
      const node = document.createElement('div')
      node.className = 'git-diff-hunk-actions'
      node.dataset.hunkIndex = String(range.index)
      node.setAttribute('aria-hidden', 'true')

      const buildIconButton = (
        variant: 'stage' | 'unstage' | 'revert',
        label: string,
        title: string,
        onClick: () => Promise<boolean>
      ) => {
        const button = document.createElement('button')
        button.type = 'button'
        button.className = `git-diff-hunk-action-button ${variant === 'revert' ? 'danger' : 'success'}`
        button.title = title
        button.tabIndex = -1
        button.innerHTML = `${HUNK_ACTION_ICON_SVG[variant]}<span class="git-diff-hunk-action-label">${escapeHtmlText(label)}</span>`
        button.addEventListener('click', (event) => {
          event.preventDefault()
          event.stopPropagation()
          const result = onClick()
          if (result instanceof Promise) {
            lastHunkActionPromiseRef.current = result
          }
        })
        return button
      }

      const buttons: HTMLButtonElement[] = []
      if (isStagedFile) {
        buttons.push(buildIconButton(
          'unstage',
          t('gitDiff.hunk.unstage'),
          t('gitDiff.hunk.unstageTitle'),
          () => runDiffHunkActionRef.current?.('unstage', range) ?? Promise.resolve(false)
        ))
      } else {
        buttons.push(buildIconButton(
          'stage',
          t('gitDiff.hunk.stage'),
          t('gitDiff.hunk.stageTitle'),
          () => runDiffHunkActionRef.current?.('stage', range) ?? Promise.resolve(false)
        ))
        if (showRevert) {
          buttons.push(buildIconButton(
            'revert',
            t('gitDiff.hunk.revert'),
            t('gitDiff.hunk.revertTitle'),
            () => runDiffHunkActionRef.current?.('revert', range) ?? Promise.resolve(false)
          ))
        }
      }
      buttons.forEach((b) => node.appendChild(b))

      const preventEditorFocus = (event: Event) => {
        event.preventDefault()
        event.stopPropagation()
      }
      node.addEventListener('mousedown', preventEditorFocus)
      node.addEventListener('mouseenter', () => setVisibleDiffHunkActionWidget(widgetId))
      node.addEventListener('mouseleave', () => scheduleHideDiffHunkActionWidgets())
      node.addEventListener('focusin', () => setVisibleDiffHunkActionWidget(widgetId))
      node.addEventListener('focusout', () => scheduleHideDiffHunkActionWidgets())

      const widget: monacoTypes.editor.IContentWidget = {
        allowEditorOverflow: false,
        suppressMouseDown: true,
        getId: () => widgetId,
        getDomNode: () => node,
        getPosition: () => {
          const safeAnchorLine = clampEditorLine(modifiedEditor, anchorLine)
          if (safeAnchorLine === null) return null
          return {
            // Float ABOVE the hunk's first line so the toolbar never covers
            // code. Falls back to BELOW when the hunk sits at the very first
            // visible line and there is no room above.
            position: { lineNumber: safeAnchorLine, column: 1 },
            preference: [
              monaco.editor.ContentWidgetPositionPreference.ABOVE,
              monaco.editor.ContentWidgetPositionPreference.BELOW
            ]
          }
        }
      }

      try {
        modifiedEditor.addContentWidget(widget)
      } catch (error) {
        debugLog('editor:hunk-actions:add-widget:error', {
          error: String(error),
          anchorLine,
          range
        })
        node.remove()
        return
      }
      diffHunkActionWidgetHandlesRef.current.push({
        id: widgetId,
        anchorLine,
        range,
        node,
        buttons
      })
      diffHunkActionDisposablesRef.current.push({
        dispose: () => {
          try {
            modifiedEditor.removeContentWidget(widget)
          } catch (error) {
            debugLog('editor:hunk-actions:remove-widget:error', {
              error: String(error),
              anchorLine,
              range
            })
          }
          node.remove()
        }
      })
    })
    return finish(diffHunkActionDisposablesRef.current.length > 0 ? 'installed' : 'skipped', {
      lineChangeCount: changes.length
    })
  }, [
    activeCwd,
    disposeDiffHunkActionWidgets,
    getFileKey,
    scheduleHideDiffHunkActionWidgets,
    selectedFile,
    selectedFileState,
    setVisibleDiffHunkActionWidget,
    t,
    terminalId
  ])

  useEffect(() => {
    installDiffHunkActionWidgetsRef.current = installDiffHunkActionWidgets
  }, [installDiffHunkActionWidgets])

  const shouldContinueHunkActionInstallSettling = useCallback((
    editor: monacoTypes.editor.IStandaloneDiffEditor
  ): boolean => {
    const file = selectedFileRef.current
    if (!file || file.isSubmoduleEntry || file.changeType === 'untracked' || file.status === 'D') return false
    if (isDraftDirtyRef.current) return false
    const key = getFileKey(file)
    const state = fileContentsRef.current[key]
    if (!state || state.loading || state.error || state.isBinary) return false
    const expectedModifiedContent = state.draftContent ?? state.modifiedContent ?? ''
    const expectedOriginalContent = state.originalContent ?? ''
    if (expectedOriginalContent !== expectedModifiedContent) return true
    return editor.getOriginalEditor().getValue() !== editor.getModifiedEditor().getValue()
  }, [getFileKey])

  // Event-driven install with a bounded frame settle. The synchronous path
  // still handles normal Monaco `onDidUpdateDiff` events immediately; the
  // frame path only runs while the selected file has real text deltas and
  // Monaco has not exposed line changes yet.
  const scheduleDiffHunkActionWidgetInstall = useCallback((reason: string) => {
    if (hunkActionInstallSettleFrameRef.current !== null) {
      window.cancelAnimationFrame(hunkActionInstallSettleFrameRef.current)
      hunkActionInstallSettleFrameRef.current = null
    }
    const runId = hunkActionInstallSettleRunIdRef.current + 1
    hunkActionInstallSettleRunIdRef.current = runId
    const startedAt = performance.now()

    const run = (frameCount: number) => {
      if (hunkActionInstallSettleRunIdRef.current !== runId) return
      hunkActionInstallSettleFrameRef.current = null
      const editor = diffEditorRef.current
      const monaco = monacoRef.current
      if (!editor || !monaco) return

      const modelId = editor.getModifiedEditor().getModel()?.id ?? null
      const identityKey = currentDiffIdentityRef.current
      const installedFor = hunkActionInstallIdentityRef.current
      if (
        installedFor?.modelId === modelId &&
        installedFor.identityKey === identityKey &&
        diffHunkActionWidgetHandlesRef.current.length > 0
      ) {
        return
      }

      const hasFrameBudget =
        frameCount < HUNK_ACTION_INSTALL_SETTLE_FRAME_LIMIT &&
        performance.now() - startedAt < HUNK_ACTION_INSTALL_SETTLE_MAX_MS
      const lineChanges = editor.getLineChanges() ?? []
      if (
        lineChanges.length === 0 &&
        hasFrameBudget &&
        shouldContinueHunkActionInstallSettling(editor)
      ) {
        hunkActionInstallSettleFrameRef.current = window.requestAnimationFrame(() => run(frameCount + 1))
        return
      }

      void reason // kept for future perfTrace breadcrumb; install path is uniform
      const result = installDiffHunkActionWidgets(editor, monaco)
      if (result === 'installed') {
        hunkActionInstallIdentityRef.current = { modelId, identityKey }
        return
      }
      if (result === 'retry' && hasFrameBudget) {
        hunkActionInstallSettleFrameRef.current = window.requestAnimationFrame(() => run(frameCount + 1))
      }
    }

    run(0)
  }, [installDiffHunkActionWidgets, shouldContinueHunkActionInstallSettling])

  const cancelTokenizeSettleTracking = useCallback(() => {
    tokenizeSettleRunIdRef.current += 1
    if (tokenizeSettleQuietTimerRef.current !== null) {
      window.clearTimeout(tokenizeSettleQuietTimerRef.current)
      tokenizeSettleQuietTimerRef.current = null
    }
    if (tokenizeSettleCapTimerRef.current !== null) {
      window.clearTimeout(tokenizeSettleCapTimerRef.current)
      tokenizeSettleCapTimerRef.current = null
    }
    for (const disposable of tokenizeSettleDisposablesRef.current) {
      try {
        disposable.dispose()
      } catch (error) {
        debugLog('tokenize-settle:dispose:error', { error: String(error) })
      }
    }
    tokenizeSettleDisposablesRef.current = []
  }, [])

  const startTokenizeSettleTracking = useCallback((
    fileKey: string,
    editor: monacoTypes.editor.IStandaloneDiffEditor
  ) => {
    cancelTokenizeSettleTracking()
    const active = clickLatencyTrackerRef.current.getActive()
    if (!active || active.fileKey !== fileKey) return

    const runId = tokenizeSettleRunIdRef.current
    const isCurrentRun = () => tokenizeSettleRunIdRef.current === runId
    let settled = false
    const settle = (reason: ClickLatencySettleReason) => {
      if (settled || !isCurrentRun()) return
      settled = true
      cancelTokenizeSettleTracking()
      clickLatencyTrackerRef.current.markTokenizeSettled(fileKey, reason)
    }
    const scheduleQuietSettle = (reason: ClickLatencySettleReason) => {
      if (!isCurrentRun()) return
      if (tokenizeSettleQuietTimerRef.current !== null) {
        window.clearTimeout(tokenizeSettleQuietTimerRef.current)
      }
      tokenizeSettleQuietTimerRef.current = window.setTimeout(() => {
        tokenizeSettleQuietTimerRef.current = null
        settle(reason)
      }, TOKENIZE_SETTLE_QUIET_MS)
    }
    const markDomAndSchedule = (reason: ClickLatencySettleReason) => {
      if (settled || !isCurrentRun()) return
      clickLatencyTrackerRef.current.markDomCommitted(fileKey)
      scheduleQuietSettle(reason)
    }

    const container = editor.getContainerDomNode()
    if (container) {
      const observer = new MutationObserver(() => {
        markDomAndSchedule('dom-quiet')
      })
      observer.observe(container, {
        childList: true,
        subtree: true,
        characterData: true,
        attributes: true
      })
      tokenizeSettleDisposablesRef.current.push({ dispose: () => observer.disconnect() })
    }

    const bindTokenEvents = (innerEditor: monacoTypes.editor.IStandaloneCodeEditor) => {
      const model = innerEditor.getModel() as (monacoTypes.editor.ITextModel & {
        onDidChangeTokens?: (listener: () => void) => { dispose: () => void }
      }) | null
      if (typeof model?.onDidChangeTokens === 'function') {
        tokenizeSettleDisposablesRef.current.push(model.onDidChangeTokens(() => {
          markDomAndSchedule('tokens-quiet')
        }))
      }
      tokenizeSettleDisposablesRef.current.push(innerEditor.onDidChangeModelDecorations(() => {
        markDomAndSchedule('dom-quiet')
      }))
    }

    bindTokenEvents(editor.getOriginalEditor())
    bindTokenEvents(editor.getModifiedEditor())

    const markInitialDom = () => markDomAndSchedule('dom-quiet')
    requestAnimationFrame(markInitialDom)
    window.setTimeout(markInitialDom, 80)
    tokenizeSettleCapTimerRef.current = window.setTimeout(() => {
      settle('timeout')
    }, TOKENIZE_SETTLE_CAP_MS)
  }, [cancelTokenizeSettleTracking])

  const disposeDiffEditorBindings = useCallback(() => {
    cancelTokenizeSettleTracking()
    if (diffSplitMeasureFrameRef.current !== null) {
      window.cancelAnimationFrame(diffSplitMeasureFrameRef.current)
      diffSplitMeasureFrameRef.current = null
    }
    if (diffScrollCaptureTimerRef.current !== null) {
      window.clearTimeout(diffScrollCaptureTimerRef.current)
      diffScrollCaptureTimerRef.current = null
    }
    cancelHunkActionInstallSettling()
    disposeDiffHunkActionWidgets()
    for (const disposable of diffEditorBindingDisposablesRef.current) {
      try {
        disposable.dispose()
      } catch (error) {
        debugLog('editor:dispose-binding:error', { error: String(error) })
      }
    }
    diffEditorBindingDisposablesRef.current = []
  }, [cancelHunkActionInstallSettling, cancelTokenizeSettleTracking, disposeDiffHunkActionWidgets])

  const measureDiffSplitState = useCallback((
    editorOverride?: monacoTypes.editor.IStandaloneDiffEditor | null
  ): DiffSplitState | null => {
    const editor = editorOverride ?? diffEditorRef.current
    if (!editor) return null
    const mode = getDiffLayoutMode(editor, splitViewModeRef.current)
    const originalLayoutWidth = editor.getOriginalEditor().getLayoutInfo().width
    const modifiedLayoutWidth = editor.getModifiedEditor().getLayoutInfo().width
    const layoutWidth = originalLayoutWidth + modifiedLayoutWidth
    if (mode !== 'side-by-side') {
      return {
        mode,
        ratio: null,
        originalWidth: Math.max(0, Math.round(originalLayoutWidth)),
        modifiedWidth: Math.max(0, Math.round(modifiedLayoutWidth))
      }
    }
    if (layoutWidth > 0) {
      return {
        mode,
        ratio: clampDiffSplitRatio(originalLayoutWidth / layoutWidth),
        originalWidth: Math.max(0, Math.round(originalLayoutWidth)),
        modifiedWidth: Math.max(0, Math.round(modifiedLayoutWidth))
      }
    }
    const layout = (() => {
      const privateElements = (editor as monacoTypes.editor.IStandaloneDiffEditor & {
        elements?: Partial<Record<'root' | 'original' | 'modified', HTMLElement>>
      }).elements
      const container = editor.getContainerDomNode()
      const diffRoot = privateElements?.root ?? (
        container.classList.contains('monaco-diff-editor')
          ? container
          : container.querySelector<HTMLElement>('.monaco-diff-editor')
      )
      const originalPane = getDiffPaneElement(editor, 'original')
      const modifiedPane = getDiffPaneElement(editor, 'modified')
      if (!diffRoot || !originalPane || !modifiedPane) return null
      const rootRect = diffRoot.getBoundingClientRect()
      const originalRect = originalPane.getBoundingClientRect()
      const modifiedRect = modifiedPane.getBoundingClientRect()
      const originalWidth = originalRect.width
      const modifiedWidth = modifiedRect.width
      const gap = Math.max(0, modifiedRect.left - originalRect.right)
      const splitLeft = originalWidth + gap
      const contentWidth = splitLeft + modifiedWidth
      if (contentWidth <= 0) return null
      return {
        ratio: clampDiffSplitRatio(splitLeft / contentWidth),
        originalWidth,
        modifiedWidth,
        originalLeft: Math.max(0, originalRect.left - rootRect.left),
        modifiedLeft: Math.max(0, modifiedRect.left - rootRect.left),
        gap
      } satisfies DiffSplitLayout
    })()
    if (!layout) return null
    return {
      mode,
      ratio: layout.ratio,
      originalWidth: Math.max(0, Math.round(layout.originalWidth)),
      modifiedWidth: Math.max(0, Math.round(layout.modifiedWidth))
    }
  }, [])

  const scheduleDiffSplitMeasurement = useCallback((
    editorOverride?: monacoTypes.editor.IStandaloneDiffEditor | null
  ) => {
    if (diffSplitMeasureFrameRef.current !== null) {
      window.cancelAnimationFrame(diffSplitMeasureFrameRef.current)
    }
    diffSplitMeasureFrameRef.current = window.requestAnimationFrame(() => {
      diffSplitMeasureFrameRef.current = null
      const measurement = measureDiffSplitState(editorOverride)
      if (!measurement || measurement.ratio === null) return
      persistDiffSplitRatio(measurement.ratio)
    })
  }, [measureDiffSplitState, persistDiffSplitRatio])

  const persistCurrentDiffSplitRatio = useCallback((
    editorOverride?: monacoTypes.editor.IStandaloneDiffEditor | null
  ) => {
    const measurement = measureDiffSplitState(editorOverride)
    if (!measurement || measurement.ratio === null) return null
    return persistDiffSplitRatio(measurement.ratio)
  }, [measureDiffSplitState, persistDiffSplitRatio])

  const dragDiffSplitRatio = useCallback(async (nextRatio: number) => {
    const editor = diffEditorRef.current
    if (!editor) return false
    if (getDiffLayoutMode(editor, splitViewModeRef.current) !== 'side-by-side') return false
    const container = editor.getContainerDomNode()
    const diffRoot = container.classList.contains('monaco-diff-editor')
      ? container
      : container.querySelector<HTMLElement>('.monaco-diff-editor')
    const sash = diffRoot?.querySelector<HTMLElement>('.monaco-sash.vertical') ??
      diffRoot?.querySelector<HTMLElement>('.monaco-sash') ??
      null
    const originalPane = getDiffPaneElement(editor, 'original')
    const modifiedPane = getDiffPaneElement(editor, 'modified')
    if (!diffRoot || !sash || !originalPane || !modifiedPane) return false

    const originalRect = originalPane.getBoundingClientRect()
    const modifiedRect = modifiedPane.getBoundingClientRect()
    const sashRect = sash.getBoundingClientRect()
    const contentLeft = originalRect.left
    const contentWidth = modifiedRect.right - originalRect.left
    if (contentWidth <= 0) return false

    const targetRatio = clampDiffSplitRatio(nextRatio)
    const startX = sashRect.left + (sashRect.width / 2)
    const targetX = contentLeft + (contentWidth * targetRatio)
    const clientY = sashRect.top + (sashRect.height / 2)
    const waitForFrame = () => new Promise<void>((resolve) => {
      window.setTimeout(resolve, 16)
    })
    const dispatchMouseEvent = (
      target: EventTarget,
      type: 'mousedown' | 'mousemove' | 'mouseup',
      clientX: number
    ) => {
      target.dispatchEvent(new MouseEvent(type, {
        bubbles: true,
        cancelable: true,
        clientX,
        clientY,
        screenX: clientX,
        screenY: clientY,
        button: 0,
        buttons: type === 'mouseup' ? 0 : 1
      }))
    }
    const dispatchPointerEvent = (
      target: EventTarget,
      type: 'pointerdown' | 'pointermove' | 'pointerup',
      clientX: number
    ) => {
      if (typeof window.PointerEvent !== 'function') return
      target.dispatchEvent(new PointerEvent(type, {
        bubbles: true,
        cancelable: true,
        clientX,
        clientY,
        screenX: clientX,
        screenY: clientY,
        button: 0,
        buttons: type === 'pointerup' ? 0 : 1,
        pointerId: 1,
        pointerType: 'mouse',
        isPrimary: true
      }))
    }

    const steps = 8
    dispatchPointerEvent(sash, 'pointerdown', startX)
    dispatchMouseEvent(sash, 'mousedown', startX)
    await waitForFrame()

    for (let step = 1; step <= steps; step += 1) {
      const nextX = startX + (((targetX - startX) * step) / steps)
      dispatchPointerEvent(document, 'pointermove', nextX)
      dispatchMouseEvent(document, 'mousemove', nextX)
      await waitForFrame()
    }

    dispatchPointerEvent(document, 'pointerup', targetX)
    dispatchMouseEvent(document, 'mouseup', targetX)
    dispatchPointerEvent(window, 'pointerup', targetX)
    dispatchMouseEvent(window, 'mouseup', targetX)
    await new Promise<void>((resolve) => {
      window.setTimeout(resolve, 150)
    })

    const measurement = measureDiffSplitState(editor)
    return Boolean(measurement && measurement.ratio !== null && Math.abs(measurement.ratio - targetRatio) <= 0.08)
  }, [measureDiffSplitState])

  const detachDiffEditor = useCallback(() => {
    if (isPanel) {
      disposeDiffEditorBindings()
      return
    }
    disposeDiffEditorBindings()
    const editor = diffEditorRef.current
    const modelUrisToDispose = new Set<string>()
    if (editor) {
      const model = editor.getModel()
      if (model?.original) modelUrisToDispose.add(model.original.uri.toString())
      if (model?.modified) modelUrisToDispose.add(model.modified.uri.toString())
    }
    const monaco = monacoRef.current
    if (monaco && modelUrisToDispose.size > 0) {
      // @monaco-editor/react owns the DiffEditor disposal. Disposing it here as
      // well can race Monaco's delayed menu/context-key emitters during close.
      window.setTimeout(() => {
        for (const model of monaco.editor.getModels()) {
          if (!model.uri.toString().startsWith('inmemory://model/onward-git-diff/')) continue
          if (!modelUrisToDispose.has(model.uri.toString())) continue
          try {
            model.dispose()
          } catch (error) {
            debugLog('editor:model-dispose:error', { error: String(error), uri: model.uri.toString() })
          }
        }
      }, 100)
    }
    originalDecorationsRef.current?.clear()
    modifiedDecorationsRef.current?.clear()
    originalDecorationsRef.current = null
    modifiedDecorationsRef.current = null
    diffEditorRef.current = null
    monacoRef.current = null
  }, [disposeDiffEditorBindings, isPanel])

  const clearActiveDiffSelection = useCallback((options?: { detachEditor?: boolean }) => {
    setSelectedFile(null)
    selectedFileRef.current = null
    lastSelectedFileRef.current = null
    setActionMessage(null)
    setLineMessage(null)
    setSelectedLineRangeValue(null)
    setLineActionState(null)
    setEditMessage(null)
    setIsSavingEdit(false)
    setDiffRestoreNotice(null)
    originalDecorationsRef.current?.clear()
    modifiedDecorationsRef.current?.clear()
    if (options?.detachEditor) {
      detachDiffEditor()
    }
  }, [detachDiffEditor, setSelectedLineRangeValue])

  // Load Git Diff data
  const resetViewerState = useCallback(() => {
    setDiffResult(null)
    diffResultRef.current = null
    clearActiveDiffSelection()
    setFileContents({})
    fileContentsRef.current = {}
    staleFileContentKeysRef.current.clear()
    repoFilterRef.current = null
    setRepoFilter(null)
    setExpandedRepoRoots(new Set())
    setCollapsedDiffTreeDirs(new Set())
    setActionMessage(null)
    setLineMessage(null)
    detachDiffEditor()
  }, [clearActiveDiffSelection, detachDiffEditor])

  const applyLoadedDiffResult = useCallback((
    result: GitDiffResult,
    sourceCwd: string,
    previousSelection: GitFileStatus | null
  ) => {
    setDiffResult(result)
    // Latch the "outline visible while submodules loading" observation
    // (DSM-03 / RSM-03): the root-only pass arrives with submodulesLoading:true
    // + repos still loading; the settled full pass leaves the peak unchanged.
    submoduleLoadObservationRef.current = foldSubmoduleLoadObservation(
      submoduleLoadObservationRef.current,
      result
    )
    if (result.submodulesLoading === true) {
      perfTrace(PERF_TRACE_EVENT.RENDERER_GIT_DIFF_SUBMODULE_OUTLINE_OBSERVED, {
        terminalId,
        maxLoadingRepoCount: submoduleLoadObservationRef.current.maxLoadingRepoCount,
        maxNestedLoadingRepoCount: submoduleLoadObservationRef.current.maxNestedLoadingRepoCount,
        fileCount: result.files?.length ?? 0
      })
    }
    lastDiffRef.current = {
      cwd: result.cwd || sourceCwd,
      originalCwd: sourceCwd,
      at: Date.now(),
      result
    }

    const repoRoot = result.cwd || sourceCwd
    const nextKeys = new Set(result.files.map((file) => buildGitDiffFileKey(file.repoRoot || repoRoot, file)))
    const memoryKey = getMemoryKey(repoRoot)
    const memoryStore = memoryKey
      ? (diffMemoryRef.current[memoryKey] || {
        selectedFileKey: null,
        entries: {}
      })
      : {
        selectedFileKey: null,
        entries: {}
      }
    if (memoryKey) {
      diffMemoryRef.current[memoryKey] = memoryStore
    }
    if (result.success) {
      clearGitDiffMemorySelectionWhenEmpty(memoryStore, result.files)
    }

    setFileContents((prev) => {
      const next: Record<string, FileContentState> = {}
      for (const key of nextKeys) {
        if (prev[key]) {
          next[key] = prev[key]
        }
      }
      return next
    })
    staleFileContentKeysRef.current = new Set(
      [...staleFileContentKeysRef.current].filter((key) => nextKeys.has(key))
    )

    const suppressSelectionRestore = suppressSelectionRestoreOnNextLoadRef.current
    suppressSelectionRestoreOnNextLoadRef.current = false
    const suppressMemorySelectionRestore =
      suppressMemorySelectionRestoreUntilSelectionRef.current &&
      !selectedFileRef.current &&
      !previousSelection
    const nextFile = result.success
      && !suppressSelectionRestore
      && !suppressMemorySelectionRestore
      ? resolveGitDiffRestoredSelection(
          result.files,
          repoRoot,
          memoryStore,
          selectedFileRef.current || previousSelection
        )
      : null
    if (result.success && result.files.length > 0 && nextFile) {
      // Guard: skip setSelectedFile when the same file is already selected
      // (e.g., submodule stage-2 load arriving with unchanged file selection).
      // This prevents unnecessary Monaco editor remount and visual flash.
      const currentKey = selectedFileRef.current ? getFileKey(selectedFileRef.current) : null
      const nextKey = buildGitDiffFileKey(nextFile.repoRoot || repoRoot, nextFile)
      if (nextKey !== currentKey) {
        setSelectedFile(nextFile)
      } else {
        selectedFileRef.current = nextFile
        // The selected-file effect only fires on a reference change; when
        // the per-file content cache was wiped externally (watcher-driven
        // invalidation while the panel was closed), the effect will not
        // re-fetch on its own and Monaco renders blank or the prior body.
        // Trigger a fetch directly when the cache slot is empty.
        const selectedBodyIsStale = staleFileContentKeysRef.current.has(nextKey)
        if (!fileContentsRef.current[nextKey] || selectedBodyIsStale) {
          void ensureFileContentRef.current?.(
            nextFile,
            selectedBodyIsStale,
            selectedBodyIsStale ? 'auto-refresh' : 'select'
          )
        }
      }
    } else {
      selectedFileRef.current = null
      lastSelectedFileRef.current = null
      setSelectedFile(null)
    }
    const currentRepoFilter = repoFilterRef.current
    if (result.files.length > 0 && currentRepoFilter && !result.files.some((file) => file.repoRoot === currentRepoFilter)) {
      repoFilterRef.current = null
      setRepoFilter(null)
    }
  }, [getFileKey, getMemoryKey])

  const resolveLoadIdleWaiters = useCallback(() => {
    const waiters = loadIdleWaitersRef.current.splice(0)
    for (const resolve of waiters) {
      resolve()
    }
  }, [])

  const waitForLoadIdle = useCallback(() => {
    if (!loadInFlightRef.current && !loadQueuedRef.current) {
      return Promise.resolve()
    }
    return new Promise<void>((resolve) => {
      let settled = false
      const settle = () => {
        if (settled) return
        settled = true
        window.clearTimeout(timer)
        resolve()
      }
      // Belt-and-suspenders ceiling: even if the in-flight load never resolves
      // its idle waiters (lock leak), the queued caller (e.g. Keep/Deny's
      // post-action reload) self-heals instead of hanging until the autotest /
      // app is killed. The normal path resolves via resolveLoadIdleWaiters()
      // long before this fires.
      const timer = window.setTimeout(() => {
        if (settled) return
        const index = loadIdleWaitersRef.current.indexOf(settle)
        if (index >= 0) loadIdleWaitersRef.current.splice(index, 1)
        debugLog('diff:load:idle-wait-ceiling', {
          inFlight: loadInFlightRef.current,
          queued: loadQueuedRef.current
        })
        settle()
      }, DIFF_LOAD_IDLE_WAIT_CEILING_MS)
      loadIdleWaitersRef.current.push(settle)
    })
  }, [])

  const markDiffLoadedForTiming = useCallback((reason: string, detail?: Record<string, unknown>) => {
    if (timingRef.current.diffLoadedAt !== null) return false
    const loadedAt = performance.now()
    const nextTiming = {
      ...timingRef.current,
      diffLoadedAt: loadedAt
    }
    timingRef.current = nextTiming
    debugLog('diff:timing:loaded', {
      reason,
      openRequestedAt: nextTiming.openRequestedAt,
      cwdReadyAt: nextTiming.cwdReadyAt,
      openToDiffLoadedMs: nextTiming.openRequestedAt !== null
        ? Math.round(loadedAt - nextTiming.openRequestedAt)
        : null,
      cwdReadyToDiffLoadedMs: nextTiming.cwdReadyAt !== null
        ? Math.round(loadedAt - nextTiming.cwdReadyAt)
        : null,
      ...detail
    })
    return true
  }, [])

  // Race a getDiff invoke against a renderer-side watchdog. The main worker has
  // its own timeout, but a wedged/deduped reply can leave the renderer invoke
  // pending forever (see DIFF_LOAD_IPC_TIMEOUT_MS). Rejecting here guarantees
  // loadDiff's try/catch/finally runs, releasing the in-flight lock + idle
  // waiters instead of deadlocking Keep/Deny and every later load.
  const getDiffWithWatchdog = useCallback(
    (
      targetCwd: string,
      diffOptions: { scope: 'root-only' | 'full'; force: boolean }
    ): Promise<GitDiffResult> => {
      return raceWithTimeout(
        window.electronAPI.git.getDiff(targetCwd, diffOptions),
        DIFF_LOAD_IPC_TIMEOUT_MS,
        () => {
          // Diagnostic breadcrumb: the renderer invoke never settled and the
          // watchdog released loadDiff so the in-flight lock + idle waiters are
          // freed instead of deadlocking Keep/Deny and every later load.
          perfTrace(PERF_TRACE_EVENT.RENDERER_GIT_DIFF_LOAD_IPC_TIMEOUT, {
            scope: diffOptions.scope,
            force: diffOptions.force,
            timeoutMs: DIFF_LOAD_IPC_TIMEOUT_MS
          })
          debugLog('diff:load:ipc-timeout', {
            cwd: targetCwd,
            scope: diffOptions.scope,
            force: diffOptions.force,
            timeoutMs: DIFF_LOAD_IPC_TIMEOUT_MS
          })
        },
        // Tag the error so loadDiff's catch can distinguish a watchdog abort
        // (preserve the visible list) from a genuine load failure (surface the
        // empty error result). See watchdogTimeoutError.ts.
        (ms) => makeWatchdogTimeoutError(ms)
      )
    },
    []
  )

  const loadDiff = useCallback(async (options?: { reset?: boolean; silent?: boolean; force?: boolean }) => {
    if (DEBUG_GIT_DIFF) {
      perfCountersRef.current.loadDiff += 1
    }
    const previousSelection = selectedFileRef.current
    if (!cwd) {
      if (cwdPending) {
        setDiffResult(null)
        return
      }
      setDiffResult({
        success: false,
        cwd: '',
        isGitRepo: false,
        gitInstalled: true,
        files: [],
        error: t('gitDiff.error.noWorkingDirectory')
      })
      return
    }

    if (!options?.reset && !options?.force) {
      const cached = lastDiffRef.current
      if (cached && (cached.originalCwd === cwd || cached.cwd === cwd)) {
        const age = Date.now() - cached.at
        if (age < 800 && !cached.result.submodulesLoading) {
          debugLog('diff:load:cache', { cwd, age })
          applyLoadedDiffResult(cached.result, cwd, previousSelection)
          // Treat a cache hit as "diff loaded" for timing purposes so the
          // subpage entry's openToDiffLoadedMs reflects the real (near-zero)
          // latency users perceive when reopening Diff onto a warm cache.
          // Without this the cwdReadyToDiffLoadedMs sample stays null on
          // every cache-hit re-entry.
          markDiffLoadedForTiming('renderer-cache-hit', {
            cwd,
            age,
            fileCount: cached.result.files?.length ?? 0
          })
          return
        }
      }
    }

    if (loadInFlightRef.current) {
      const previous = loadQueuedRef.current
      const nextSilent = options?.silent ?? false
      loadQueuedRef.current = {
        reset: Boolean(previous?.reset || options?.reset),
        force: Boolean(previous?.force || options?.force),
        silent: previous ? Boolean(previous.silent ?? true) && nextSilent : nextSilent
      }
      const waitStartedAt = performance.now()
      debugLog('diff:load:skip', {
        cwd,
        reason: 'in-flight',
        queued: loadQueuedRef.current,
        hasDiffResult: Boolean(diffResultRef.current),
        fileCount: diffResultRef.current?.files?.length ?? null
      })
      await waitForLoadIdle()
      const latestResult = diffResultRef.current
      const cwdMatchesLatest = Boolean(
        latestResult &&
        (latestResult.cwd === cwd || latestResult.cwd === '' || cwd === null)
      )
      const timingMarked = cwdMatchesLatest
        ? markDiffLoadedForTiming('in-flight-idle', {
            cwd,
            waitMs: Math.round(performance.now() - waitStartedAt),
            fileCount: latestResult?.files?.length ?? null,
            submodulesLoading: Boolean(latestResult?.submodulesLoading)
          })
        : false
      debugLog('diff:load:skip:idle', {
        cwd,
        waitMs: Math.round(performance.now() - waitStartedAt),
        cwdMatchesLatest,
        timingMarked,
        hasDiffResult: Boolean(latestResult),
        fileCount: latestResult?.files?.length ?? null
      })
      return
    }
    loadInFlightRef.current = true

    if (options?.reset) {
      resetViewerState()
    }

    const currentToken = ++loadTokenRef.current
    loadDiffStatsRef.current.started += 1
    const start = performance.now()
    debugLog('diff:load:start', {
      cwd,
      token: currentToken,
      reset: Boolean(options?.reset),
      silent: Boolean(options?.silent),
      force: Boolean(options?.force)
    })
    // Page-OPEN phase chain (diagnostic channel, default-on in prod). Only a
    // reset load is a page open; silent refreshes / queued reloads stay off
    // this chain so the spans always mean "the user watched a spinner".
    const isPageOpen = Boolean(options?.reset)
    if (isPageOpen) {
      perfTraceDiagnostic(PERF_TRACE_EVENT.RENDERER_GIT_DIFF_OPEN_PHASE_REQUEST, {
        cwd,
        force: Boolean(options?.force)
      })
      // Watcher-independent freshness (2026-07-05): ask the mirror to revalidate
      // this cwd on open. If the FS watcher dropped a commit/edit, the recompute
      // finds the real state and fans out an invalidation → this view reloads
      // fresh; if nothing changed there is NO generation bump, so the cached
      // list still paints instantly with no re-mount flicker. Fire-and-forget.
      try {
        window.electronAPI?.git?.revalidateMirror?.(cwd)
        perfTraceDiagnostic(PERF_TRACE_EVENT.RENDERER_GIT_DIFF_OPEN_REVALIDATE, { cwd })
      } catch { /* ignore */ }
    }
    try {
      const stagedLoad = Boolean(options?.reset)
      const initialScope = stagedLoad ? 'root-only' : 'full'
      const initialResult = await getDiffWithWatchdog(cwd, { scope: initialScope, force: Boolean(options?.force) })
      if (loadTokenRef.current !== currentToken) return

      // Submodule two-stage DECOUPLE (prewarm-cache audit fix #3): paint the
      // fast root-only superproject file list IMMEDIATELY instead of suppressing
      // it behind the slowest submodule. Previously, when submodules were still
      // resolving, the root-only files were hidden (empty list) until the full
      // recursive diff landed — so a nested-submodule repo (kar-qemu: an 8-10 s
      // submodule walk) blocked the superproject's own changed files from
      // painting for seconds. Now root-only renders in ~ms and the full pass
      // merges in-place when ready; the root-only files stay visible/clickable
      // throughout.
      applyLoadedDiffResult(initialResult, cwd, previousSelection)
      debugLog('diff:load:done', {
        cwd: initialResult.cwd || cwd,
        token: currentToken,
        stage: initialScope,
        success: initialResult.success,
        fileCount: initialResult.files?.length ?? 0,
        duration: Math.round(performance.now() - start),
        submodulesLoading: Boolean(initialResult.submodulesLoading)
      })
      markDiffLoadedForTiming('initial-load', {
        cwd: initialResult.cwd || cwd,
        stage: initialScope,
        fileCount: initialResult.files?.length ?? 0,
        durationMs: Math.round(performance.now() - start)
      })
      if (isPageOpen) {
        // durationMs auto-routes this to a ph='X' span (resolvePhase); the
        // span is exactly the time the open spinner covered the list load.
        perfTraceDiagnostic(PERF_TRACE_EVENT.RENDERER_GIT_DIFF_OPEN_PHASE_LIST_APPLIED, {
          cwd: initialResult.cwd || cwd,
          stage: initialScope,
          ok: initialResult.success,
          fileCount: initialResult.files?.length ?? 0,
          durationMs: +(performance.now() - start).toFixed(1)
        })
        // First-paint = two rAFs after the list state landed: React has
        // committed and the browser has presented a frame — the moment the
        // user actually stops seeing the spinner.
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            // Always emit — a silently swallowed event on token supersede
            // left rapid-invalidation sessions with NO first-paint anywhere
            // in the trace (a diagnostic hole; Electron 43's frame timing
            // made it the common case under test churn). `superseded` marks
            // that a newer load replaced this one before its paint frame.
            perfTraceDiagnostic(PERF_TRACE_EVENT.RENDERER_GIT_DIFF_OPEN_PHASE_FIRST_PAINT, {
              cwd: initialResult.cwd || cwd,
              fileCount: initialResult.files?.length ?? 0,
              durationMs: +(performance.now() - start).toFixed(1),
              superseded: loadTokenRef.current !== currentToken
            })
          })
        })
      }

      // Second stage: the root-only pass reported submodules still resolving →
      // fetch the full recursive diff and merge it in-place (root-only files
      // remain on screen the whole time).
      const needsFullPass = stagedLoad && initialResult.success && Boolean(initialResult.submodulesLoading)
      if (needsFullPass) {
        const fullResult = await getDiffWithWatchdog(cwd, { scope: 'full', force: Boolean(options?.force) })
        if (loadTokenRef.current !== currentToken) return
        applyLoadedDiffResult(fullResult, cwd, previousSelection)
        markDiffLoadedForTiming('full-submodule-load', {
          cwd: fullResult.cwd || cwd,
          stage: 'full',
          fileCount: fullResult.files?.length ?? 0,
          durationMs: Math.round(performance.now() - start)
        })
        debugLog('diff:load:done', {
          cwd: fullResult.cwd || cwd,
          token: currentToken,
          stage: 'full',
          success: fullResult.success,
          fileCount: fullResult.files?.length ?? 0,
          duration: Math.round(performance.now() - start),
          submodulesLoading: Boolean(fullResult.submodulesLoading)
        })
      }
    } catch (error) {
      if (loadTokenRef.current !== currentToken) return
      if (isPageOpen) {
        // The open never produced a list — the diagnostically critical
        // branch: a user bundle must show whether the spinner ended in a
        // watchdog abort or a hard load failure, and after how long.
        perfTraceDiagnostic(PERF_TRACE_EVENT.RENDERER_GIT_DIFF_OPEN_PHASE_LIST_APPLIED, {
          cwd: cwd || '',
          ok: false,
          watchdogTimeout: isWatchdogTimeoutError(error),
          fileCount: 0,
          durationMs: +(performance.now() - start).toFixed(1)
        })
      }
      // A renderer-side watchdog abort means the getDiff invoke never settled
      // (the worker is still churning behind an EDR-throttled concurrency-1 lane,
      // or its reply was lost and the lane only frees at the worker's own 90s
      // timeout). It is NOT a confirmed load failure. If we already hold a
      // non-empty file list, PRESERVE it: blanking to an empty error result here
      // silently destroyed the user's diff list and broke Keep/Deny + sibling
      // file lookups (round-4 image-diff regression). The in-flight lock is still
      // released in `finally`, so the deadlock fix this watchdog provides stays
      // intact — we only stop it from also wiping good data.
      const existing = diffResultRef.current
      if (isWatchdogTimeoutError(error) && existing && (existing.files?.length ?? 0) > 0) {
        perfTrace(PERF_TRACE_EVENT.RENDERER_GIT_DIFF_LOAD_WATCHDOG_PRESERVED, {
          cwd: cwd || '',
          fileCount: existing.files?.length ?? 0
        })
        debugLog('diff:load:watchdog-preserved', {
          cwd,
          token: currentToken,
          fileCount: existing.files?.length ?? 0
        })
      } else {
        setDiffResult({
          success: false,
          cwd: cwd || '',
          isGitRepo: false,
          gitInstalled: true,
          files: [],
          error: t('gitDiff.error.loadFailed', { error: String(error) })
        })
        debugLog('diff:load:error', { cwd, token: currentToken, error: String(error) })
      }
    } finally {
      loadInFlightRef.current = false
      if (loadQueuedRef.current) {
        const queued = loadQueuedRef.current
        loadQueuedRef.current = null
        await loadDiff(queued)
      } else {
        resolveLoadIdleWaiters()
      }
      setNavigationLoadSettledEpoch(nextGitDiffNavigationLoadSettledEpoch)
    }
  }, [applyLoadedDiffResult, cwd, cwdPending, getDiffWithWatchdog, markDiffLoadedForTiming, resetViewerState, resolveLoadIdleWaiters, t, waitForLoadIdle])

  const refreshChanges = useCallback(async () => {
    if (!cwd || isRefreshingChanges) return false
    const startedAt = performance.now()
    setIsRefreshingChanges(true)
    setActionMessage(null)
    setLineMessage(null)
    try {
      lastDiffRef.current = null
      const retainedDrafts = retainDirtyDrafts(fileContentsRef.current)
      setFileContents(retainedDrafts)
      fileContentsRef.current = retainedDrafts
      // Phase 5 PART 2: Refresh Changes cascade — bump the local
      // DiffEditor reset nonce so React re-mounts the editor, AND
      // signal the Worker to bump its mirror generation so any other
      // listener on the same cwd also sees a fresh identity.
      setDiffEditorResetNonce((n) => n + 1)
      try {
        await window.electronAPI?.git?.forceRefresh?.(cwd)
      } catch (error) {
        debugLog('refresh:force-refresh-mirror:error', { error: String(error) })
      }
      await loadDiff({ silent: true, force: true })
      const file = selectedFileRef.current
      if (file && !isDraftDirtyRef.current) {
        await ensureFileContentRef.current?.(file, true, 'refresh')
      }
      // Diagnostic tier (prod default-on): the manual-refresh click count is
      // THE user-pain signal in a staleness bundle (the 2026-07-12 report's
      // 3-clicks-in-17s pattern was only recoverable from main-side force
      // invalidations). User-click frequency — trivially within budget.
      perfTraceDiagnostic(PERF_TRACE_EVENT.RENDERER_GIT_DIFF_MANUAL_REFRESH, {
        cwd,
        terminalId,
        result: 'success',
        durationMs: +(performance.now() - startedAt).toFixed(1)
      })
      return true
    } catch (error) {
      perfTraceDiagnostic(PERF_TRACE_EVENT.RENDERER_GIT_DIFF_MANUAL_REFRESH, {
        cwd,
        terminalId,
        result: 'exception',
        error: String(error),
        durationMs: +(performance.now() - startedAt).toFixed(1)
      })
      return false
    } finally {
      setIsRefreshingChanges(false)
    }
  }, [cwd, isRefreshingChanges, loadDiff, terminalId])

  const loadDiffFromRoot = useCallback(async (rootPath: string) => {
    if (!rootPath) return
    repoFilterRef.current = null
    setRepoFilter(null)
    resetViewerState()
    const result = await window.electronAPI.git.getDiff(rootPath)
    setDiffResult(result)
    lastDiffRef.current = {
      cwd: result.cwd || rootPath,
      originalCwd: rootPath,
      at: Date.now(),
      result
    }
    clearActiveDiffSelection()
  }, [clearActiveDiffSelection, resetViewerState])

  // Clear stale state before paint only when the backing cwd changes.
  useLayoutEffect(() => {
    if (isOpen) {
      const nextScope = cwd ?? null
      const shouldReset = lastOpenScopeRef.current !== nextScope
      const openingFromClosed = !wasOpenRef.current
      lastOpenScopeRef.current = nextScope
      resetDiffOnNextLoadRef.current = shouldReset
      if (openingFromClosed) {
        suppressSelectionRestoreOnNextLoadRef.current = true
        suppressMemorySelectionRestoreUntilSelectionRef.current = true
        // Fresh observation per OPEN (not per loadDiff) — re-loads within the
        // same open (watcher refresh, force-refresh that skips the root-only
        // stage) must not clear the latched "outline-while-loading" peak the
        // initial staged load captured (DSM-03 / RSM-03).
        submoduleLoadObservationRef.current = emptySubmoduleLoadObservation()
      }
      timingRef.current = {
        openRequestedAt,
        shellShownAt: performance.now(),
        cwdReadyAt,
        diffLoadedAt: null
      }
      if (shouldReset) {
        resetViewerState()
      } else if (openingFromClosed) {
        const retainedDrafts = retainDirtyDrafts(fileContentsRef.current)
        fileContentsRef.current = retainedDrafts
        setFileContents(retainedDrafts)
        staleFileContentKeysRef.current.clear()
        clearActiveDiffSelection({ detachEditor: true })
      }
    }
  }, [clearActiveDiffSelection, cwdReadyAt, isOpen, openRequestedAt, resetViewerState])

  useEffect(() => {
    if (!isOpen) return
    timingRef.current = {
      ...timingRef.current,
      openRequestedAt,
      cwdReadyAt
    }
  }, [cwdReadyAt, isOpen, openRequestedAt])

  // Load data when opening (async, after paint). Force-bypass the worker
  // request cache only on a cwd change (`reset=true`), which signals a
  // fresh open whose underlying repo may have mutated outside our
  // watcher's lifetime. For same-cwd re-entries we trust the watcher →
  // invalidation chain (registered below), which clears the worker AND
  // renderer caches whenever a real file mutation lands. A non-forced
  // re-entry hits the worker request cache (~ms) and the renderer's
  // per-file content cache (also ~ms), so the panel paints instantly.
  useEffect(() => {
    if (isOpen) {
      const reset = resetDiffOnNextLoadRef.current
      resetDiffOnNextLoadRef.current = false
      // Serve the BACKGROUND-warmed list cache WITHOUT force so the panel paints
      // instantly (~ms) instead of paying a multi-second cold recompute on the
      // visible path — the whole point of warmDiffCache + the event-invalidated
      // (long-TTL) request cache.
      //
      // Do NOT fire an unconditional force-revalidate on open. A forced getDiff
      // routes through the GIT_GET_DIFF handler's `invalidateContentCacheForProject`
      // (ipc-handlers.ts), which WIPES every prewarmed per-file body for the
      // project. On EDR-throttled Windows that made the user's first click
      // cold-miss right after the warm had filled the content cache (RC-2).
      // Freshness is watcher-driven instead: the `onDiffCacheInvalidated`
      // subscription below fires a silent force reload whenever a REAL mutation
      // lands (mtime change), which covers "subpage entry shows fresh data"
      // (GDS-08) — including the open-panel refresh path — without the
      // self-inflicted prewarm wipe on every open.
      loadDiff({ reset, force: false })
    }
  }, [isOpen, loadDiff])

  // Track the latest non-null cwd so the always-on listener below can
  // continue matching repo paths after the panel closes (parent zeroes
  // cwd on close, which is why earlier versions of this listener missed
  // mid-close invalidations).
  useEffect(() => {
    if (cwd) lastKnownCwdRef.current = cwd
  }, [cwd])

  useEffect(() => {
    loadDiffRef.current = loadDiff
  }, [loadDiff])

  // Backend FS-watcher invalidations: drop the renderer's per-file
  // content cache (`fileContents`) so a future re-entry — or an
  // already-open panel — refetches the selected file's body. Subscribe
  // ONCE on mount and gate via refs (lastKnownCwdRef, isOpenRef,
  // loadDiffRef, ensureFileContentRef): the prior `isOpen`-gated and
  // `cwd`-gated variants both unsubscribed during the close window and
  // therefore left fileContents stale after `close → external edit →
  // reopen`. The invalidator already debounces to 180 ms so this
  // listener cannot fire faster than that. Also drops `lastDiffRef` so
  // the in-component 800 ms diff-list cache cannot serve a pre-mutation
  // file list either.
  useEffect(() => {
    const dispose = window.electronAPI.git.onDiffCacheInvalidated((invalidatedCwd, reason, detail) => {
      const targetCwd = lastKnownCwdRef.current
      if (!targetCwd) return
      // Match by prefix so a submodule mutation under the current cwd
      // also counts. The invalidator normalises cwds via path.resolve,
      // so a strict prefix check (with separator boundary) is correct
      // on all platforms.
      const normalizedSelf = normalizeInvalidationPath(targetCwd)
      const normalizedHit = normalizeInvalidationPath(invalidatedCwd)
      const matches =
        normalizedHit === normalizedSelf ||
        normalizedHit.startsWith(`${normalizedSelf}/`) ||
        normalizedHit.startsWith(`${normalizedSelf}\\`) ||
        normalizedSelf.startsWith(`${normalizedHit}/`) ||
        normalizedSelf.startsWith(`${normalizedHit}\\`)
      if (!matches) return
      const scopedFiles = detail?.files
      if (scopedFiles?.length) {
        // File-scoped known mutation (single-file stage/unstage/discard/save):
        // mark ONLY the affected files stale and keep everything else warm.
        // The mutation initiator already patched the visible list locally;
        // the authoritative reconcile arrives via the mirror echo (or the
        // initiator's timer fallback) — firing another full reload from here
        // was one of the historical 2-3 redundant reloads per discard
        // (2026-07-16 revert-scope fix).
        const fileSet = new Set(scopedFiles)
        const keyMatchesScopedFile = (key: string) => {
          const parts = key.split('::')
          const keyFilename = parts.slice(4).join('::')
          const keyOriginal = parts[3] ?? ''
          return fileSet.has(keyFilename) || (keyOriginal !== '' && fileSet.has(keyOriginal))
        }
        let staleCount = 0
        const stale = new Set(staleFileContentKeysRef.current)
        for (const [key, state] of Object.entries(fileContentsRef.current)) {
          if (!keyMatchesScopedFile(key)) continue
          if (state.draftContent !== undefined && state.draftContent !== state.modifiedContent) {
            stale.delete(key)
            continue
          }
          stale.add(key)
          staleCount += 1
        }
        staleFileContentKeysRef.current = stale
        lastDiffRef.current = null
        perfTraceDiagnostic(PERF_TRACE_EVENT.RENDERER_GIT_DIFF_CACHE_INVALIDATION, {
          cwd: targetCwd,
          terminalId,
          invalidatedCwd,
          reason,
          isOpen: isOpenRef.current,
          scopedFiles: scopedFiles.length,
          staleEntries: staleCount
        })
        if (!isOpenRef.current) return
        const sel = selectedFileRef.current
        if (sel && keyMatchesScopedFile(buildGitDiffFileKey(sel.repoRoot || targetCwd, sel))) {
          void ensureFileContentRef.current?.(sel, true, 'auto-refresh')
        }
        return
      }
      const currentContents = fileContentsRef.current
      let staleCount = 0
      if (isOpenRef.current) {
        const stale = new Set(staleFileContentKeysRef.current)
        for (const [key, state] of Object.entries(currentContents)) {
          if (state.draftContent !== undefined && state.draftContent !== state.modifiedContent) {
            stale.delete(key)
            continue
          }
          stale.add(key)
        }
        staleFileContentKeysRef.current = stale
        staleCount = stale.size
      } else {
        const retainedDrafts = retainDirtyDrafts(currentContents)
        setFileContents(retainedDrafts)
        fileContentsRef.current = retainedDrafts
        setDiffResult(null)
        diffResultRef.current = null
        selectedFileRef.current = null
        lastSelectedFileRef.current = null
        setSelectedFile(null)
        staleFileContentKeysRef.current.clear()
      }
      lastDiffRef.current = null
      // Diagnostic tier (prod default-on): whether the renderer RECEIVED and
      // matched an invalidation push is the load-bearing breadcrumb for any
      // "diff stays stale until manual refresh" bundle — the 2026-07-12
      // analysis had to infer it indirectly because this rode the opt-in
      // channel. Frequency is mirror-invalidation-scale (debounced), not
      // per-frame, so it fits the diagnostic channel's budget.
      perfTraceDiagnostic(PERF_TRACE_EVENT.RENDERER_GIT_DIFF_CACHE_INVALIDATION, {
        cwd: targetCwd,
        terminalId,
        invalidatedCwd,
        reason,
        isOpen: isOpenRef.current,
        retainedEntries: Object.keys(fileContentsRef.current).length,
        staleEntries: staleCount
      })
      if (!isOpenRef.current) return
      void loadDiffRef.current?.({ silent: true, force: true })
      const sel = selectedFileRef.current
      if (sel) void ensureFileContentRef.current?.(sel, true, 'auto-refresh')
    })
    return () => {
      dispose()
    }
  }, [])

  useEffect(() => {
    selectedFileRef.current = selectedFile
    if (selectedFile) {
      lastSelectedFileRef.current = selectedFile
    }
  }, [selectedFile])

  useEffect(() => {
    fileContentsRef.current = fileContents
  }, [fileContents])

  const wasOpenRef = useRef(false)
  const isOpenRef = useRef(isOpen)
  useEffect(() => {
    isOpenRef.current = isOpen
  }, [isOpen])

  useEffect(() => {
    if (isOpen) {
      gitDiffOpenAtRef.current = performance.now()
      coldMountRecordedRef.current = false
      diffRestoreCycleRef.current += 1
      diffRestoreAppliedRef.current = { cycle: diffRestoreCycleRef.current, fileKey: null }
      wasOpenRef.current = true
      return
    }
    gitDiffOpenAtRef.current = null
    coldMountRecordedRef.current = false
    if (wasOpenRef.current) {
      subpageSnapshotRestoreEpochRef.current += 1
      captureDiffView()
      clearCurrentMemorySelection()
      wasOpenRef.current = false
    }
    // Close cancels any in-flight warm-reveal settle and drops a parked
    // first-change reveal — a reveal must never fire against a view the
    // user has already left.
    warmRevealSettleRunIdRef.current += 1
    pendingFirstChangeRevealRef.current = null
    pendingViewportGoalRef.current = null
  }, [captureDiffView, clearCurrentMemorySelection, getMemoryKey, getMemoryStore, isOpen])

  // Scroll capture is now registered via onDidScrollChange in handleEditorDidMount
  // Position restoration is done directly in handleEditorDidMount by checking memory storage (to avoid effect timing competition)

  useEffect(() => {
    if (!diffRestoreNotice || !selectedFile) return
    if (diffRestoreNotice.type !== 'changed') return
    const headerTitle = selectedFile.originalFilename && (selectedFile.status === 'R' || selectedFile.status === 'C')
      ? `${selectedFile.originalFilename} → ${selectedFile.filename}`
      : selectedFile.filename
    if (diffRestoreNotice.fileName && diffRestoreNotice.fileName !== headerTitle) {
      setDiffRestoreNotice(null)
    }
  }, [diffRestoreNotice, selectedFile])

  // Drag and drop to adjust file list width
  const handleResizeMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    isDraggingRef.current = true
    const startX = e.clientX
    const startWidth = fileListWidth

    const handleMouseMove = (e: MouseEvent) => {
      if (!isDraggingRef.current) return
      const delta = e.clientX - startX
      const newWidth = Math.max(MIN_FILE_LIST_WIDTH, Math.min(MAX_FILE_LIST_WIDTH, startWidth + delta))
      fileListWidthRef.current = newWidth
      setFileListWidth(newWidth)
    }

    const handleMouseUp = () => {
      if (isDraggingRef.current) {
        isDraggingRef.current = false
        const latestWidth = fileListWidthRef.current
        localStorage.setItem(STORAGE_KEY_FILE_LIST_WIDTH, String(latestWidth))
        updateUIPreferences({ gitDiffFileListWidth: latestWidth })
      }
      document.removeEventListener('mousemove', handleMouseMove)
      document.removeEventListener('mouseup', handleMouseUp)
      document.body.classList.remove('git-diff-resizing')
    }

    document.body.classList.add('git-diff-resizing')
    document.addEventListener('mousemove', handleMouseMove)
    document.addEventListener('mouseup', handleMouseUp)
  }, [fileListWidth, updateUIPreferences])

  // Save width to localStorage (when width changes)
  useEffect(() => {
    fileListWidthRef.current = fileListWidth
    if (!isDraggingRef.current) {
      localStorage.setItem(STORAGE_KEY_FILE_LIST_WIDTH, String(fileListWidth))
    }
  }, [fileListWidth])

  // Drag and drop to adjust pop-up window size
  const handleModalResizeMouseDown = useCallback((e: React.MouseEvent, direction: string) => {
    if (isPanel) return
    e.preventDefault()
    e.stopPropagation()
    isResizingModalRef.current = true
    resizeDirectionRef.current = direction

    const startX = e.clientX
    const startY = e.clientY
    const startWidth = modalSize.width
    const startHeight = modalSize.height

    const maxWidth = window.innerWidth * MAX_MODAL_WIDTH_PERCENT / 100
    const maxHeight = window.innerHeight * MAX_MODAL_HEIGHT_PERCENT / 100

    const handleMouseMove = (e: MouseEvent) => {
      if (!isResizingModalRef.current) return

      let newWidth = startWidth
      let newHeight = startHeight

      const dir = resizeDirectionRef.current

      // Handle horizontal orientation
      if (dir.includes('e')) {
        newWidth = Math.max(MIN_MODAL_WIDTH, Math.min(maxWidth, startWidth + (e.clientX - startX) * 2))
      } else if (dir.includes('w')) {
        newWidth = Math.max(MIN_MODAL_WIDTH, Math.min(maxWidth, startWidth - (e.clientX - startX) * 2))
      }

      // Handle vertical orientation
      if (dir.includes('s')) {
        newHeight = Math.max(MIN_MODAL_HEIGHT, Math.min(maxHeight, startHeight + (e.clientY - startY) * 2))
      } else if (dir.includes('n')) {
        newHeight = Math.max(MIN_MODAL_HEIGHT, Math.min(maxHeight, startHeight - (e.clientY - startY) * 2))
      }

      setModalSize({ width: newWidth, height: newHeight })
    }

    const handleMouseUp = () => {
      if (isResizingModalRef.current) {
        isResizingModalRef.current = false
        resizeDirectionRef.current = ''
        // Save to localStorage
        localStorage.setItem(STORAGE_KEY_MODAL_SIZE, JSON.stringify(modalSizeRef.current))
        updateUIPreferences({ gitDiffModalSize: modalSizeRef.current })
      }
      document.removeEventListener('mousemove', handleMouseMove)
      document.removeEventListener('mouseup', handleMouseUp)
      document.body.classList.remove('git-diff-modal-resizing')
    }

    document.body.classList.add('git-diff-modal-resizing')
    document.addEventListener('mousemove', handleMouseMove)
    document.addEventListener('mouseup', handleMouseUp)
  }, [isPanel, modalSize])

  // Save popup window size to localStorage
  useEffect(() => {
    if (isPanel) return
    if (!isResizingModalRef.current) {
      localStorage.setItem(STORAGE_KEY_MODAL_SIZE, JSON.stringify(modalSize))
      updateUIPreferences({ gitDiffModalSize: modalSize })
    }
  }, [isPanel, modalSize, updateUIPreferences])

  useEffect(() => {
    modalSizeRef.current = modalSize
  }, [modalSize])

  const syncCurrentDiffEditorModels = useCallback((
    file: GitFileStatus,
    state: FileContentState,
    reason: GitDiffModelSyncReason
  ) => {
    const editor = diffEditorRef.current
    if (!editor || !activeCwd || state.loading || state.error || state.isBinary || state.isImage || state.isPdf || state.isEpub) {
      return null
    }

    const selected = selectedFileRef.current
    const selectedKey = selected ? getFileKey(selected) : null
    const fileKey = getFileKey(file)
    if (!selected || selectedKey !== fileKey) return null

    const originalEditor = editor.getOriginalEditor()
    const modifiedEditor = editor.getModifiedEditor()
    const originalModel = originalEditor.getModel()
    const modifiedModel = modifiedEditor.getModel()
    if (!originalModel || !modifiedModel) return null

    const expectedOriginalUri = buildGitDiffModelPath(file, activeCwd, 'original')
    const expectedModifiedUri = buildGitDiffModelPath(file, activeCwd, 'modified')
    const originalUri = originalModel.uri.toString()
    const modifiedUri = modifiedModel.uri.toString()
    if (originalUri !== expectedOriginalUri || modifiedUri !== expectedModifiedUri) {
      perfTrace(PERF_TRACE_EVENT.RENDERER_GIT_DIFF_MODEL_SYNC, {
        cwd: activeCwd,
        terminalId,
        fileKey,
        filename: file.filename,
        changeType: file.changeType,
        reason,
        result: 'uri-mismatch',
        originalUri,
        modifiedUri,
        expectedOriginalUri,
        expectedModifiedUri
      })
      return null
    }

    const startedAt = performance.now()
    const nextOriginalContent = state.originalContent ?? ''
    const nextModifiedContent = state.draftContent ?? state.modifiedContent ?? ''
    const plan = buildGitDiffModelSyncPlan({
      currentOriginalContent: originalModel.getValue(),
      currentModifiedContent: modifiedModel.getValue(),
      nextOriginalContent,
      nextModifiedContent
    })

    if (plan.needsSync) {
      const originalViewState = originalEditor.saveViewState()
      const modifiedViewState = modifiedEditor.saveViewState()
      suppressDraftChangeRef.current = true
      try {
        if (plan.originalChanged) originalModel.setValue(nextOriginalContent)
        if (plan.modifiedChanged) modifiedModel.setValue(nextModifiedContent)
      } finally {
        suppressDraftChangeRef.current = false
      }
      if (originalViewState) originalEditor.restoreViewState(originalViewState)
      if (modifiedViewState) modifiedEditor.restoreViewState(modifiedViewState)
      scheduleDiffHunkActionWidgetInstall('model-sync')
    }

    const durationMs = +(performance.now() - startedAt).toFixed(1)
    perfTrace(PERF_TRACE_EVENT.RENDERER_GIT_DIFF_MODEL_SYNC, {
      cwd: activeCwd,
      terminalId,
      fileKey,
      filename: file.filename,
      changeType: file.changeType,
      reason,
      result: plan.needsSync ? 'synced' : 'noop',
      originalChanged: plan.originalChanged,
      modifiedChanged: plan.modifiedChanged,
      originalLen: plan.originalLen,
      modifiedLen: plan.modifiedLen,
      durationMs
    })
    return {
      ...plan,
      durationMs
    }
  }, [activeCwd, getFileKey, scheduleDiffHunkActionWidgetInstall, terminalId])

  const requestLargeFileConfirmation = useCallback((filename: string, sizeBytes: number) => {
    return new Promise<boolean>((resolve) => {
      const nextState: LargeFileConfirmState = {
        filename,
        sizeBytes,
        sizeLabel: formatLargeFileSize(sizeBytes),
        resolve
      }
      largeFileConfirmRef.current = nextState
      setLargeFileConfirmState(nextState)
    })
  }, [])

  const settleLargeFileConfirmation = useCallback((confirmed: boolean) => {
    const current = largeFileConfirmRef.current
    if (!current) return
    largeFileConfirmRef.current = null
    setLargeFileConfirmState(null)
    current.resolve(confirmed)
  }, [])

  useEffect(() => {
    return () => {
      settleLargeFileConfirmation(false)
    }
  }, [settleLargeFileConfirmation])

  useEffect(() => {
    if (!isOpen) {
      settleLargeFileConfirmation(false)
    }
  }, [isOpen, settleLargeFileConfirmation])

  useEffect(() => {
    settleLargeFileConfirmation(false)
  }, [activeCwd, settleLargeFileConfirmation])

  const ensureFileContent = useCallback(async (
    file: GitFileStatus,
    force = false,
    reason: FileContentLoadReason = 'select'
  ) => {
    if (!activeCwd) return
    const fileKey = getFileKey(file)
    const cached = fileContentsRef.current[fileKey]
    const isStale = staleFileContentKeysRef.current.has(fileKey)
    if (cached && !cached.loading && !force && !isStale) {
      // Cached early-return: the file's content is already in state, so
      // there is no placeholder→real transition. Mark stateSet anyway so
      // the click-latency tracker's `markDiffComputedIfReal` gate accepts
      // the next onDidUpdateDiff (Monaco swaps the DiffEditor's modified
      // model when selectedFile changes, even when content was cached).
      clickLatencyTrackerRef.current.markIpcStart(fileKey)
      clickLatencyTrackerRef.current.markIpcEnd(fileKey, 'hit', {
        source: 'renderer-memory'
      })
      clickLatencyTrackerRef.current.markStateSet(fileKey)
      clickLatencyTrackerRef.current.markModelBound(fileKey)
      lastFileContentLoadRef.current = {
        fileKey,
        filename: file.filename,
        reason,
        force,
        result: 'success',
        cacheInfo: {
          state: 'hit',
          source: 'renderer-memory'
        },
        durationMs: 0
      }
      // Diagnostic: a selected file was served from the renderer's in-memory
      // fileContents cache WITHOUT a fetch. Records the changeType + content
      // lengths so a "Git Diff shows stale/base content for a staged entry"
      // report (GDS-22/33) is root-causable — a staged hit whose modifiedLen
      // equals its originalLen (both == HEAD/base length) is a stale-slot hit.
      // Diagnostic tier (prod default-on): a click served from renderer memory
      // WITHOUT any fetch is exactly the branch a "stale body" bundle needs to
      // see — per-click frequency, small payload (lengths only, no content).
      perfTraceDiagnostic(PERF_TRACE_EVENT.RENDERER_GIT_DIFF_FILE_LOAD_MEMORY_HIT, {
        terminalId,
        fileKey,
        filename: file.filename,
        changeType: file.changeType,
        reason,
        originalLen: cached.originalContent?.length ?? -1,
        modifiedLen: cached.modifiedContent?.length ?? -1
      })
      syncCurrentDiffEditorModels(file, cached, reason)
      const editor = diffEditorRef.current
      if (editor) {
        window.setTimeout(() => {
          const active = clickLatencyTrackerRef.current.getActive()
          if (!active || active.fileKey !== fileKey || active.tokenizeSettleAt !== null) return
          if (cached.error || cached.isBinary || cached.isSvg || cached.isPdf || cached.isEpub) {
            clickLatencyTrackerRef.current.markDomCommitted(fileKey)
            clickLatencyTrackerRef.current.markDiffComputed(fileKey)
            clickLatencyTrackerRef.current.markTokenizeSettled(fileKey, 'non-text')
            return
          }
          if (active.diffComputedAt === null) {
            clickLatencyTrackerRef.current.markDiffComputed(fileKey)
          }
          startTokenizeSettleTracking(fileKey, editor)
        }, 0)
      }
      return
    }
    const existingInFlight = inFlightRef.current[fileKey]
    if (existingInFlight) {
      if (!force || inFlightForceRef.current[fileKey]) {
        return
      }
      try {
        await existingInFlight
      } catch {
        // The forced refresh below will report its own error state.
      }
    }

    const loadStartedAt = performance.now()
    setFileContents((prev) => {
      const previous = prev[fileKey]
      return {
        ...prev,
        [fileKey]: {
          ...(previous || {
            originalContent: '',
            modifiedContent: '',
            isBinary: false
          }),
          loading: true,
          refreshing: Boolean(previous && !previous.loading),
          error: undefined
        }
      }
    })

    const task = (async () => {
      try {
        clickLatencyTrackerRef.current.markIpcStart(fileKey)
        const requestFile = {
          filename: file.filename,
          status: file.status,
          originalFilename: file.originalFilename,
          changeType: file.changeType,
          isSubmoduleEntry: file.isSubmoduleEntry
        }
        const requestOptions = {
          force,
          missReason: cacheMissReasonForLoad(force, reason),
          allowLargeFile: allowedLargeFileKeysRef.current.has(fileKey),
          // Audit fix #2 (decision ⑧a): the background whole-list prefetch runs
          // in the LOW git-runtime lane so a foreground select / refresh /
          // auto-refresh (priority omitted → 'high' in the worker client) always
          // preempts it. Previously the prefetch defaulted to 'high' and tied
          // with the user's click, so the selected file queued behind the whole
          // prefetch burst (measured 18-29 s first-click latency on EDR hosts).
          ...(reason === 'prefetch' ? { priority: 'low' as const } : {})
        }
        let result: GitFileContentResult = await window.electronAPI.git.getFileContent(activeCwd, requestFile, file.repoRoot, requestOptions)
        if (result.requiresLargeFileConfirmation) {
          const sizeBytes = result.largeFileSizeBytes ?? result.largeFileThresholdBytes ?? 0
          if (reason === 'prefetch') {
            const nextContents = { ...fileContentsRef.current }
            delete nextContents[fileKey]
            fileContentsRef.current = nextContents
            setFileContents(nextContents)
            return
          }
          const confirmed = await requestLargeFileConfirmation(file.filename, sizeBytes)
          if (!confirmed) {
            allowedLargeFileKeysRef.current.delete(fileKey)
            const cacheInfo = result.cacheInfo
            clickLatencyTrackerRef.current.markIpcEnd(fileKey, cacheInfo?.state ?? 'miss', {
              source: cacheInfo?.source ?? null,
              missReason: cacheInfo?.missReason ?? null
            })
            lastFileContentLoadRef.current = {
              fileKey,
              filename: file.filename,
              reason,
              force,
              result: 'error',
              cacheInfo: cacheInfo ?? null,
              durationMs: +(performance.now() - loadStartedAt).toFixed(1)
            }
            const errorText = t('gitDiff.largeFile.cancelled', { size: formatLargeFileSize(sizeBytes) })
            setFileContents((prev) => ({
              ...prev,
              [fileKey]: {
                ...(prev[fileKey] || {
                  originalContent: '',
                  modifiedContent: '',
                  isBinary: false
                }),
                loading: false,
                refreshing: false,
                error: errorText,
                originalContent: '',
                modifiedContent: '',
                draftContent: prev[fileKey]?.draftContent,
                isBinary: false,
                isImage: false,
                isSvg: false,
                isPdf: false,
                isEpub: false,
                originalImageUrl: undefined,
                modifiedImageUrl: undefined,
                originalImageSize: undefined,
                modifiedImageSize: undefined,
                originalPreviewData: undefined,
                modifiedPreviewData: undefined,
                originalPreviewSize: undefined,
                modifiedPreviewSize: undefined
              }
            }))
            return
          }
          allowedLargeFileKeysRef.current.add(fileKey)
          result = await window.electronAPI.git.getFileContent(activeCwd, requestFile, file.repoRoot, {
            ...requestOptions,
            allowLargeFile: true
          })
        }
        const cacheInfo = result.cacheInfo
        clickLatencyTrackerRef.current.markIpcEnd(fileKey, cacheInfo?.state ?? 'miss', {
          source: cacheInfo?.source ?? null,
          missReason: cacheInfo?.missReason ?? null
        })

        if (!result.success) {
          lastFileContentLoadRef.current = {
            fileKey,
            filename: file.filename,
            reason,
            force,
            result: 'error',
            cacheInfo: cacheInfo ?? null,
            durationMs: +(performance.now() - loadStartedAt).toFixed(1)
          }
          perfTrace(PERF_TRACE_EVENT.RENDERER_GIT_DIFF_FILE_LOAD, {
            cwd: activeCwd,
            terminalId,
            fileKey,
            filename: file.filename,
            changeType: file.changeType,
            reason,
            cacheState: cacheInfo?.state ?? 'miss',
            cacheSource: cacheInfo?.source ?? null,
            cacheMissReason: cacheInfo?.missReason ?? null,
            result: 'error',
            durationMs: +(performance.now() - loadStartedAt).toFixed(1)
          })
          setFileContents((prev) => ({
            ...prev,
            [fileKey]: {
              ...(prev[fileKey] || {
                originalContent: '',
                modifiedContent: '',
                isBinary: false
              }),
              loading: false,
              refreshing: false,
              error: result.error || t('gitDiff.error.readFile'),
              originalContent: '',
              modifiedContent: '',
              draftContent: prev[fileKey]?.draftContent,
              isBinary: false,
              isImage: false,
              isSvg: false,
              originalImageUrl: undefined,
              modifiedImageUrl: undefined,
              originalImageSize: undefined,
              modifiedImageSize: undefined
            }
          }))
          return
        }

        const previous = fileContentsRef.current[fileKey]
        const draft = previous?.draftContent
        const nextDraft = draft !== undefined && draft !== result.modifiedContent ? draft : undefined
        const nextState: FileContentState = {
          loading: false,
          refreshing: false,
          error: undefined,
          originalContent: result.originalContent,
          modifiedContent: result.modifiedContent,
          draftContent: nextDraft,
          isBinary: result.isBinary,
          isImage: result.isImage,
          isSvg: result.isSvg,
          isPdf: result.isPdf,
          isEpub: result.isEpub,
          originalImageUrl: result.originalImageUrl,
          modifiedImageUrl: result.modifiedImageUrl,
          originalImageSize: result.originalImageSize,
          modifiedImageSize: result.modifiedImageSize,
          originalPreviewData: result.originalPreviewData,
          modifiedPreviewData: result.modifiedPreviewData,
          originalPreviewSize: result.originalPreviewSize,
          modifiedPreviewSize: result.modifiedPreviewSize
        }
        staleFileContentKeysRef.current.delete(fileKey)
        const nextContents = {
          ...fileContentsRef.current,
          [fileKey]: nextState
        }
        fileContentsRef.current = nextContents
        setFileContents(nextContents)
        clickLatencyTrackerRef.current.markStateSet(fileKey)
        syncCurrentDiffEditorModels(file, nextState, reason)
        // Note: panel pill display does NOT depend on tokenize-settle seal —
        // tracker fires listeners at markIpcEnd, and the panel reads the
        // active measurement once cacheState/cacheSource are known. The
        // tokenize-settle path below still runs for accurate Total time
        // and history aggregation, but is no longer load-bearing for UI.
        lastFileContentLoadRef.current = {
          fileKey,
          filename: file.filename,
          reason,
          force,
          result: 'success',
          cacheInfo: cacheInfo ?? null,
          durationMs: +(performance.now() - loadStartedAt).toFixed(1)
        }
        perfTrace(PERF_TRACE_EVENT.RENDERER_GIT_DIFF_FILE_LOAD, {
          cwd: activeCwd,
          terminalId,
          fileKey,
          filename: file.filename,
          changeType: file.changeType,
          reason,
          cacheState: cacheInfo?.state ?? 'miss',
          cacheSource: cacheInfo?.source ?? null,
          cacheMissReason: cacheInfo?.missReason ?? null,
          result: 'success',
          originalLen: result.originalContent.length,
          modifiedLen: result.modifiedContent.length,
          force,
          durationMs: +(performance.now() - loadStartedAt).toFixed(1)
        })
        perfTrace(PERF_TRACE_EVENT.RENDERER_GIT_DIFF_BODY_RENDERED, {
          cwd: activeCwd,
          terminalId,
          fileKey,
          filename: file.filename,
          originalLen: result.originalContent.length,
          modifiedLen: result.modifiedContent.length,
          reason,
          cacheState: cacheInfo?.state ?? 'miss',
          cacheSource: cacheInfo?.source ?? null,
          cacheMissReason: cacheInfo?.missReason ?? null,
          force
        })
      } catch (error) {
        lastFileContentLoadRef.current = {
          fileKey,
          filename: file.filename,
          reason,
          force,
          result: 'exception',
          cacheInfo: {
            state: 'miss',
            source: 'worker-rebuild',
            missReason: 'worker-error'
          },
          durationMs: +(performance.now() - loadStartedAt).toFixed(1)
        }
        perfTrace(PERF_TRACE_EVENT.RENDERER_GIT_DIFF_FILE_LOAD, {
          cwd: activeCwd,
          terminalId,
          fileKey,
          filename: file.filename,
          changeType: file.changeType,
          reason,
          cacheState: 'miss',
          cacheSource: 'worker-rebuild',
          cacheMissReason: 'worker-error',
          result: 'exception',
          durationMs: +(performance.now() - loadStartedAt).toFixed(1)
        })
        setFileContents((prev) => ({
          ...prev,
          [fileKey]: {
            ...(prev[fileKey] || {
              originalContent: '',
              modifiedContent: '',
              isBinary: false
            }),
            loading: false,
            refreshing: false,
            error: t('gitDiff.error.readFailed', { error: String(error) }),
            originalContent: '',
            modifiedContent: '',
            draftContent: prev[fileKey]?.draftContent,
            isBinary: false,
            isImage: false,
            isSvg: false,
            originalImageUrl: undefined,
            modifiedImageUrl: undefined,
            originalImageSize: undefined,
            modifiedImageSize: undefined
          }
        }))
      }
    })()

    inFlightRef.current[fileKey] = task
    inFlightForceRef.current[fileKey] = force
    try {
      await task
    } finally {
      delete inFlightRef.current[fileKey]
      delete inFlightForceRef.current[fileKey]
    }
  }, [activeCwd, getFileKey, requestLargeFileConfirmation, startTokenizeSettleTracking, syncCurrentDiffEditorModels, t, terminalId])

  // Bridge ensureFileContent into the watcher-invalidation listener
  // (registered above, before this callback is defined). The listener
  // keeps a stable identity by referencing the callback through this
  // ref, so the always-on subscription does not re-attach on every
  // ensureFileContent re-creation.
  useEffect(() => {
    ensureFileContentRef.current = ensureFileContent
  }, [ensureFileContent])

  // Clear the previous file's line selection + decorations only when the
  // SELECTED FILE actually changes — not when `ensureFileContent`'s identity
  // churns during diff-load / content-refresh. Depending on `ensureFileContent`
  // here re-ran the effect on every content refresh and wiped an active line
  // selection mid-flight via setSelectedLineRangeValue(null) — which also clears
  // lineSelectionInfoRef, the ref the keep/discard line actions read — so a
  // range stage acted on a cleared selection and never split the file. Reach the
  // loader through its ref (kept fresh in the effect above) and drop it from deps.
  useEffect(() => {
    if (selectedFile) {
      const key = getFileKey(selectedFile)
      const isStale = staleFileContentKeysRef.current.has(key)
      ensureFileContentRef.current?.(selectedFile, isStale, isStale ? 'auto-refresh' : 'select')
      setActionMessage(null)
    }
    setSelectedLineRangeValue(null)
    originalDecorationsRef.current?.clear()
    modifiedDecorationsRef.current?.clear()
  }, [selectedFile, getFileKey, setSelectedLineRangeValue])

  // Renderer-side prefetch loop. The heavy prefetch lives in the main-
  // process precompute scheduler; this loop primes the renderer's
  // `fileContentsRef` so any first user click is a renderer-memory hit
  // (panel pill shows "render state: loaded" instantly, identical pill
  // behaviour for every file in the visible list).
  //
  // No top-N cap: prefetching the entire visible list is what makes the
  // pill display uniform. With a cap, position 5+ files (often the
  // untracked group, which sorts to the bottom) would appear slow / blank
  // on first click while the top files appeared instant. Each fetch
  // almost always lands on the main cache and returns in <10ms, so the
  // cost of a few dozen extra fetches is negligible.
  useEffect(() => {
    if (!isOpen || !activeCwd || !diffResult?.success || diffResult.submodulesLoading) {
      return
    }
    let cancelled = false
    const candidates = visibleFileList
      .filter((file) => !file.isSubmoduleEntry)
      .filter((file) => file.status !== 'D' && file.status !== '!')
      .filter((file) => {
        const key = getFileKey(file)
        return (!fileContentsRef.current[key] || staleFileContentKeysRef.current.has(key)) &&
          !inFlightRef.current[key]
      })
    if (candidates.length === 0) return
    rendererPrefetchSnapshotRef.current = {
      scheduled: candidates.length,
      completed: 0,
      inFlight: true,
      candidates: candidates.map((file) => file.filename),
      lastReason: 'scheduled',
      lastDurationMs: null
    }
    const handle = window.setTimeout(() => {
      void (async () => {
        const startedAt = performance.now()
        perfTrace(PERF_TRACE_EVENT.RENDERER_GIT_DIFF_BODY_PREFETCH, {
          cwd: activeCwd,
          terminalId,
          phase: 'start',
          candidateCount: candidates.length,
          candidates: candidates.map((file) => file.filename)
        })
        let completed = 0
        for (const file of candidates) {
          if (cancelled) return
          const key = getFileKey(file)
          const stale = staleFileContentKeysRef.current.has(key)
          if (!fileContentsRef.current[key] || stale) {
            await ensureFileContent(file, stale, 'prefetch')
          }
          completed += 1
          rendererPrefetchSnapshotRef.current = {
            ...rendererPrefetchSnapshotRef.current,
            completed
          }
        }
        const durationMs = +(performance.now() - startedAt).toFixed(1)
        rendererPrefetchSnapshotRef.current = {
          scheduled: candidates.length,
          completed,
          inFlight: false,
          candidates: candidates.map((file) => file.filename),
          lastReason: 'completed',
          lastDurationMs: durationMs
        }
        perfTrace(PERF_TRACE_EVENT.RENDERER_GIT_DIFF_BODY_PREFETCH, {
          cwd: activeCwd,
          terminalId,
          phase: 'done',
          candidateCount: candidates.length,
          completed,
          durationMs
        })
      })()
    }, 250)
    return () => {
      cancelled = true
      window.clearTimeout(handle)
    }
  }, [activeCwd, diffResult?.success, diffResult?.submodulesLoading, ensureFileContent, getFileKey, isOpen, visibleFileList])

  useEffect(() => { isDraftDirtyRef.current = isDraftDirty }, [isDraftDirty])

  // --- Auto-refresh when the working-tree file changes externally ---
  const handleAutoRefresh = useCallback(async (changeType: 'changed' | 'deleted') => {
    if (!activeCwd) return

    // File deleted externally — refresh the diff list so the sidebar
    // reflects the removal. No content reload needed.
    if (changeType === 'deleted') {
      debugLog('auto-refresh:file-deleted')
      void loadDiff({ silent: true, force: true })
      return
    }

    // changeType === 'changed'
    if (!selectedFile) return

    // Keep reloading the underlying modified side even when the user has a
    // dirty draft. ensureFileContent preserves draftContent, so the editor
    // keeps showing the draft while metadata/debug APIs see the fresh file.
    const preserveDirtyDraft = isDraftDirtyRef.current
    if (preserveDirtyDraft) {
      debugLog('auto-refresh:preserve-draft')
    }

    // Skip watcher-driven refresh for a short window after a local save —
    // the save path already updates state in place, and letting the watcher
    // through would cause the exact full-refresh flicker we're avoiding.
    if (Date.now() < selfSaveSuppressUntilRef.current) {
      debugLog('auto-refresh:skip:self-save')
      return
    }

    if (autoRefreshInFlightRef.current) {
      autoRefreshQueuedRef.current = true
      return
    }

    autoRefreshInFlightRef.current = true
    suppressScrollCaptureRef.current = true
    debugLog('auto-refresh:start', selectedFile.filename)

    try {
      // Capture current scroll position before reload.
      const editor = diffEditorRef.current
      const scrollTop = editor?.getModifiedEditor().getScrollTop() ?? 0

      // Force-reload original + modified content from git.
      await ensureFileContent(selectedFile, true, 'auto-refresh')

      // Update the signature in the memory store so the reveal phase
      // does not show "content changed completely".
      const memory = getMemoryStore()
      const fileKey = selectedFileKey
      if (memory && fileKey) {
        const entry = memory.entries[fileKey]
        const fileState = fileContentsRef.current[fileKey]
        if (entry && fileState && !fileState.isBinary) {
          entry.signature = buildDiffSignature(
            fileState.originalContent ?? '',
            fileState.draftContent ?? fileState.modifiedContent ?? ''
          )
          entry.scrollTop = scrollTop
        }
      }

      // Restore scroll position after Monaco processes the new content.
      requestAnimationFrame(() => {
        const currentEditor = diffEditorRef.current?.getModifiedEditor()
        if (currentEditor && scrollTop > 0) {
          currentEditor.setScrollTop(scrollTop)
        }
        suppressScrollCaptureRef.current = false
      })

      // Also refresh the diff file list so sidebar stats (+/- counts)
      // stay up-to-date with the actual content.
      void loadDiff({ silent: true, force: true })

      debugLog('auto-refresh:done', selectedFile.filename)
    } finally {
      autoRefreshInFlightRef.current = false
      if (autoRefreshQueuedRef.current) {
        autoRefreshQueuedRef.current = false
        setTimeout(() => void handleAutoRefresh('changed'), 0)
      }
    }
  }, [selectedFile, selectedFileKey, activeCwd, ensureFileContent, getMemoryStore, loadDiff])

  useGitDiffFileWatch({
    isOpen,
    selectedFile,
    repoRoot: selectedFile?.repoRoot || activeCwd || null,
    onFileChanged: handleAutoRefresh
  })

  const handleFileSelect = useCallback((file: GitFileStatus) => {
    suppressMemorySelectionRestoreUntilSelectionRef.current = false
    const nextKey = getFileKey(file)
    // Begin a click→render measurement. Even if the user re-clicks the
    // already-selected file (a no-op below) the tracker resets the chain so
    // autotest harnesses can ask "did this click feel fast?" deterministically.
    clickLatencyTrackerRef.current.start(nextKey, file.filename)
    const memory = getMemoryStore()
    if (selectedFileKey && nextKey !== selectedFileKey) {
      captureDiffView(selectedFileKey)
      setDiffRestoreNotice(null)
    }
    if (selectedFileKey && nextKey !== selectedFileKey && isDraftDirty) {
      const confirmed = window.confirm(t('gitDiff.confirm.switchFileWithDraft'))
      if (!confirmed) return
    }
    if (selectedFileKey && nextKey !== selectedFileKey) {
      const editor = diffEditorRef.current
      if (editor) {
        suppressScrollCaptureRef.current = true
        suppressDraftChangeRef.current = true
        originalDecorationsRef.current?.clear()
        modifiedDecorationsRef.current?.clear()
        try {
          editor.getOriginalEditor().setScrollTop(0)
          editor.getModifiedEditor().setScrollTop(0)
        } catch (error) {
          debugLog('switch-file:reset-scroll:error', { error: String(error) })
        }
        setDiffEditorResetNonce((nonce) => nonce + 1)
        window.setTimeout(() => {
          suppressScrollCaptureRef.current = false
          suppressDraftChangeRef.current = false
        }, 0)
      }
      // Begin render-then-reveal cycle for the new file. A parked reveal or
      // warm settle belongs to the PREVIOUS file — drop them.
      warmRevealSettleRunIdRef.current += 1
      pendingFirstChangeRevealRef.current = null
      pendingViewportGoalRef.current = null
      enterDiffWaiting()
    }
    if (memory) {
      const previousEntry = memory.entries[nextKey]
      memory.entries[nextKey] = {
        fileKey: nextKey,
        filePath: file.filename,
        originalFilename: file.originalFilename,
        anchor: previousEntry?.anchor ?? null,
        scrollTop: previousEntry?.scrollTop ?? 0,
        signature: previousEntry?.signature ?? null,
        updatedAt: Date.now()
      }
      memory.selectedFileKey = nextKey
    }
    if (!fileContentsRef.current[nextKey]) {
      const placeholder: FileContentState = {
        loading: true,
        originalContent: '',
        modifiedContent: '',
        isBinary: false
      }
      fileContentsRef.current = {
        ...fileContentsRef.current,
        [nextKey]: placeholder
      }
      setFileContents((prev) => prev[nextKey] ? prev : {
        ...prev,
        [nextKey]: placeholder
      })
    }
    selectedFileRef.current = file
    lastSelectedFileRef.current = file
    setSelectedFile(file)
  }, [captureDiffView, enterDiffWaiting, getFileKey, getMemoryStore, isDraftDirty, selectedFileKey, t])

  useEffect(() => {
    const handleNavigate = (event: Event) => {
      const customEvent = event as CustomEvent<SubpageNavigateEventDetail>
      const detail = customEvent.detail
      if (detail?.target !== 'diff') return
      if (!detail.terminalId || detail.terminalId !== terminalId) return
      if (!detail.filePath) return
      pendingNavigationSelectRef.current = {
        filePath: detail.filePath,
        repoRoot: detail.repoRoot ?? null,
        changeType: detail.changeType ?? null
      }
      setPendingNavigationSelectNonce((nonce) => nonce + 1)
    }

    window.addEventListener('subpage:navigate', handleNavigate as EventListener)
    return () => {
      window.removeEventListener('subpage:navigate', handleNavigate as EventListener)
    }
  }, [terminalId])

  useEffect(() => {
    const target = pendingNavigationSelectRef.current
    const match = findDiffFileByNavigationTarget(diffResult, target)
    const decision = resolvePendingGitDiffNavigationSelectionDecision({
      isOpen,
      loadInFlight: loadInFlightRef.current,
      hasDiffResult: Boolean(diffResult?.success),
      hasTarget: Boolean(target),
      hasMatch: Boolean(match)
    })
    if (decision === 'wait') return
    pendingNavigationSelectRef.current = null
    if (decision === 'discard' || !match) return
    handleFileSelect(match)
  }, [diffResult, handleFileSelect, isOpen, navigationLoadSettledEpoch, pendingNavigationSelectNonce])

  useEffect(() => {
    if (!isOpen || !navigationTarget?.filePath) return
    pendingNavigationSelectRef.current = {
      filePath: navigationTarget.filePath,
      repoRoot: navigationTarget.repoRoot ?? null,
      changeType: navigationTarget.changeType ?? null
    }
    setPendingNavigationSelectNonce((nonce) => nonce + 1)
  }, [isOpen, navigationTarget?.changeType, navigationTarget?.filePath, navigationTarget?.nonce, navigationTarget?.repoRoot])

  const clearLineSelection = useCallback(() => {
    setSelectedLineRangeValue(null)
    originalDecorationsRef.current?.clear()
    modifiedDecorationsRef.current?.clear()
  }, [setSelectedLineRangeValue])

  const discardDraft = useCallback(() => {
    if (!selectedFileKey) return
    setFileContents((prev) => {
      const current = prev[selectedFileKey]
      if (!current) return prev
      return {
        ...prev,
        [selectedFileKey]: {
          ...current,
          draftContent: undefined
        }
      }
    })
    setEditMessage(null)
  }, [selectedFileKey])

  const applyLiveDraftChange = useCallback((value?: string) => {
    if (suppressDraftChangeRef.current) return
    const file = selectedFileRef.current
    const fileKey = file ? getFileKey(file) : null
    if (!file || !fileKey) return
    const model = diffEditorRef.current?.getModifiedEditor().getModel()
    const modelUri = model?.uri.toString()
    const expectedUri = buildGitDiffModelPath(file, activeCwd, 'modified')
    if (!modelUri || modelUri !== expectedUri) return
    setFileContents((prev) => {
      const current = prev[fileKey]
      if (!current || current.loading) return prev
      const nextValue = value ?? ''
      const nextDraft = nextValue === current.modifiedContent ? undefined : nextValue
      if (current.draftContent === nextDraft) return prev
      const next = {
        ...prev,
        [fileKey]: {
          ...current,
          draftContent: nextDraft
        }
      }
      fileContentsRef.current = next
      return next
    })
    setEditMessage(null)
  }, [activeCwd, getFileKey])

  useEffect(() => {
    applyLiveDraftChangeRef.current = applyLiveDraftChange
  }, [applyLiveDraftChange])

  const restoreSubpageSnapshotScroll = useCallback(async (
    file: GitFileStatus,
    fileKey: string,
    scrollTop: number | null | undefined,
    restoreEpoch: number
  ): Promise<boolean> => {
    if (typeof scrollTop !== 'number' || !Number.isFinite(scrollTop) || scrollTop < 0) {
      return false
    }

    const expectedModelUri = buildGitDiffModelPath(file, activeCwd, 'modified')
    const deadline = Date.now() + 5000
    while (Date.now() < deadline) {
      if (
        subpageSnapshotRestoreEpochRef.current !== restoreEpoch
        || !isOpenRef.current
      ) {
        return false
      }
      const liveFile = selectedFileRef.current
      const liveFileKey = liveFile ? getFileKey(liveFile) : null
      if (liveFileKey !== fileKey) return false

      const editor = diffEditorRef.current?.getModifiedEditor()
      const fileState = fileContentsRef.current[fileKey]
      const modelUri = editor?.getModel()?.uri.toString() ?? null
      const layoutHeight = editor?.getLayoutInfo().height ?? 0
      if (
        editor
        && fileState
        && !fileState.loading
        && !fileState.isBinary
        && modelUri === expectedModelUri
        && layoutHeight > 0
      ) {
        const currentSignature = buildDiffSignature(
          fileState.originalContent ?? '',
          fileState.draftContent ?? fileState.modifiedContent ?? ''
        )
        const previousSignature = getMemoryStore()?.entries[fileKey]?.signature
        if (!shouldRestoreGitDiffSnapshotScroll(previousSignature, currentSignature)) {
          diffRestoreAppliedRef.current = {
            cycle: diffRestoreCycleRef.current,
            fileKey
          }
          debugLog('restore:subpage-snapshot:content-changed', { fileKey })
          return false
        }
        const targetScrollTop = resolveGitDiffSnapshotScrollTop(
          scrollTop,
          editor.getScrollHeight(),
          layoutHeight
        )
        if (targetScrollTop === null) return false
        editor.setScrollTop(targetScrollTop)
        await new Promise<void>((resolve) => window.setTimeout(resolve, 16))

        const currentFile = selectedFileRef.current
        const currentFileKey = currentFile ? getFileKey(currentFile) : null
        const currentEditor = diffEditorRef.current?.getModifiedEditor()
        if (
          subpageSnapshotRestoreEpochRef.current !== restoreEpoch
          || !isOpenRef.current
          || currentFileKey !== fileKey
          || currentEditor?.getModel()?.uri.toString() !== expectedModelUri
        ) {
          return false
        }

        currentEditor.setScrollTop(targetScrollTop)
        const actualScrollTop = currentEditor.getScrollTop()
        if (Math.abs(actualScrollTop - targetScrollTop) <= 1) {
          const visibleRanges = currentEditor.getVisibleRanges()
          restoredAnchorRef.current[fileKey] = {
            line: visibleRanges.length > 0 ? visibleRanges[0].startLineNumber : null,
            scrollTop: targetScrollTop
          }
          diffRestoreAppliedRef.current = {
            cycle: diffRestoreCycleRef.current,
            fileKey
          }
          debugLog('restore:subpage-snapshot', {
            fileKey,
            requestedScrollTop: scrollTop,
            targetScrollTop,
            actualScrollTop
          })
          return true
        }
      }

      await new Promise<void>((resolve) => window.setTimeout(resolve, 40))
    }

    if (subpageSnapshotRestoreEpochRef.current === restoreEpoch) {
      debugLog('restore:subpage-snapshot:timeout', { fileKey, scrollTop })
    }
    return false
  }, [activeCwd, getFileKey, getMemoryStore])

  const handleEditorDidMount = useCallback(
    (editor: monacoTypes.editor.IStandaloneDiffEditor, monaco: typeof monacoTypes) => {
      disposeDiffEditorBindings()
      diffEditorRef.current = editor
      monacoRef.current = monaco

      // Apply persisted split ratio at mount as a guard for Monaco versions
      // that initialize layout before consuming the initial options object.
      editor.updateOptions({ splitViewDefaultRatio: diffSplitRatioRef.current })

      // Begin render-then-reveal cycle: editor just mounted, hide until diff is computed
      enterDiffWaiting()

      // The editor instance is now reachable for the currently selected
      // file, if any. Tracker stays a no-op when no measurement is active.
      const currentFileKey = selectedFileRef.current ? getFileKey(selectedFileRef.current) : null
      if (currentFileKey) {
        const currentState = fileContentsRef.current[currentFileKey]
        const currentFile = selectedFileRef.current
        if (currentFile && currentState) {
          syncCurrentDiffEditorModels(currentFile, currentState, 'editor-mount')
        }
        clickLatencyTrackerRef.current.markEditorReady(currentFileKey)
        if (!coldMountRecordedRef.current && gitDiffOpenAtRef.current !== null) {
          const coldMountMs = performance.now() - gitDiffOpenAtRef.current
          coldMountRecordedRef.current = true
          clickLatencyTrackerRef.current.markColdMount(currentFileKey, coldMountMs)
          perfTrace(PERF_TRACE_EVENT.RENDERER_GIT_DIFF_CLICK_PHASE_COLD_MOUNT, {
            cwd: activeCwd ?? '',
            terminalId,
            fileKey: currentFileKey,
            filename: selectedFileRef.current?.filename,
            durationMs: +coldMountMs.toFixed(2)
          })
        }
      }

      // Backup "rendered" signal for the click-latency tracker: Monaco's
      // onDidUpdateDiff is the primary marker for "diff computed and
      // committed to DOM", but it can be silent when both panes' content
      // is unchanged from the previous file (e.g. untracked files that
      // all share original=''). Listening to the modified editor's
      // onDidChangeModelContent fills the gap — once new modified
      // content lands, the user sees it on the next paint, regardless
      // of Monaco's higher-level diff scheduler.
      const modifiedEditorForTracker = editor.getModifiedEditor()
      // Helper: skip the placeholder pass. Uncached clicks transition the
      // selected file's state through `loading: true` (empty original /
      // modified) before the worker returns the real bodies. Monaco fires
      // `onDidUpdateDiff` for that empty pass and would otherwise be the
      // first — and thus winning — call to `markDiffComputed`. We can NOT
      // gate on `fileContentsRef.current[fileKey].loading` because that
      // ref is synced through a useEffect that runs *after* the commit
      // phase that triggered onDidUpdateDiff in the first place — at the
      // moment the diff-update fires, the ref still reflects the
      // placeholder. Instead, gate on the tracker's own `stateSetAt`:
      // markStateSet fires synchronously in `ensureFileContent` (success
      // path) and in the cached early-return below, so by the time the
      // real onDidUpdateDiff lands, stateSetAt is set, the gate passes,
      // and the placeholder pass (which preceded both) has been ignored.
      const markDiffComputedIfReal = (liveFileKey: string | null) => {
        if (!liveFileKey) return
        const active = clickLatencyTrackerRef.current.getActive()
        if (!active || active.fileKey !== liveFileKey) return
        if (active.stateSetAt === null) return
        const alreadyComputed = active.diffComputedAt !== null
        clickLatencyTrackerRef.current.markDiffComputed(liveFileKey)
        if (!alreadyComputed) {
          startTokenizeSettleTracking(liveFileKey, editor)
        }
      }
      diffEditorBindingDisposablesRef.current.push(modifiedEditorForTracker.onDidChangeModelContent(() => {
        const liveFileKey = selectedFileRef.current ? getFileKey(selectedFileRef.current) : null
        markDiffComputedIfReal(liveFileKey)
      }))

      // Viewport-goal self-heal: a restore/reveal applied against a
      // not-yet-measured diff layout gets clamped; re-apply once Monaco
      // reports the real content size (see pendingViewportGoalRef).
      diffEditorBindingDisposablesRef.current.push(modifiedEditorForTracker.onDidContentSizeChange(() => {
        reapplyPendingViewportGoal()
      }))

      // Transition from waiting-diff to restoring-scroll when Monaco finishes computing changes
      diffEditorBindingDisposablesRef.current.push(editor.onDidUpdateDiff(() => {
        requestDiffRevealRestore('diff-computed')
        diffNavigationIndexRef.current = -1
        scheduleDiffHunkActionWidgetInstall('diff-updated')
        const liveFileKey = selectedFileRef.current ? getFileKey(selectedFileRef.current) : null
        // Consume a parked reveal-first-change: the restore decision ran
        // before Monaco had computed this model pair's diff (fresh swap on
        // the timeout path). One-shot, and only for the same fileKey — a
        // file switch in between drops it.
        const pendingReveal = pendingFirstChangeRevealRef.current
        if (pendingReveal) {
          pendingFirstChangeRevealRef.current = null
          if (pendingReveal.fileKey === liveFileKey) {
            const changes = editor.getLineChanges()
            if (changes && changes.length > 0) {
              const firstChange = changes[0]
              const targetLine = firstChange.modifiedStartLineNumber || firstChange.originalStartLineNumber || 1
              const deferredModifiedEditor = editor.getModifiedEditor()
              revealLineNearTopSafe(deferredModifiedEditor, targetLine)
              {
                // Same height-lag self-heal as the decision-time reveal.
                const appliedScrollTop = deferredModifiedEditor.getScrollTop()
                const lineTop = deferredModifiedEditor.getTopForLineNumber(targetLine)
                const delta = lineTop - appliedScrollTop
                if (!(delta >= 0 && delta <= deferredModifiedEditor.getLayoutInfo().height * 0.6)) {
                  pendingViewportGoalRef.current = {
                    fileKey: liveFileKey,
                    kind: 'reveal-line',
                    line: targetLine,
                    appliedScrollTop,
                    at: Date.now()
                  }
                  emitViewportGoalTransition('parked', pendingViewportGoalRef.current)
                }
              }
              lastRestoreDecisionRef.current = {
                action: 'reveal-first-change',
                reason: pendingReveal.reason,
                trigger: 'deferred-diff-computed',
                fileKey: liveFileKey,
                at: Date.now(),
                revealTargetLine: targetLine
              }
              perfTraceDiagnostic(PERF_TRACE_EVENT.RENDERER_GIT_DIFF_RESTORE_DECISION, {
                cwd: activeCwd ?? '',
                terminalId,
                action: 'reveal-first-change',
                reason: pendingReveal.reason,
                trigger: 'deferred-diff-computed',
                filename: selectedFileRef.current?.filename
              })
            }
          }
        }
        markDiffComputedIfReal(liveFileKey)
      }))

      // Reset decoration refs (the old editor was destroyed, the old collection is no longer valid)
      originalDecorationsRef.current = null
      modifiedDecorationsRef.current = null

      const originalEditor = editor.getOriginalEditor()
      const modifiedEditor = editor.getModifiedEditor()

      const disposeWidgetsForModelSwap = () => {
        disposeDiffHunkActionWidgets()
      }
      diffEditorBindingDisposablesRef.current.push(originalEditor.onDidChangeModel(disposeWidgetsForModelSwap))
      diffEditorBindingDisposablesRef.current.push(modifiedEditor.onDidChangeModel(disposeWidgetsForModelSwap))

      diffEditorBindingDisposablesRef.current.push(modifiedEditor.onMouseMove((event) => {
        const line = event.target.position?.lineNumber
        if (typeof line === 'number') {
          revealDiffHunkActionForLine(line)
        }
      }))
      const modifiedEditorDom = modifiedEditor.getDomNode()
      if (modifiedEditorDom) {
        const handleMouseLeave = () => scheduleHideDiffHunkActionWidgets()
        modifiedEditorDom.addEventListener('mouseleave', handleMouseLeave)
        diffEditorBindingDisposablesRef.current.push({
          dispose: () => modifiedEditorDom.removeEventListener('mouseleave', handleMouseLeave)
        })
      }

      // Monitor content changes in the editor on the right (direct editing, automatic draft maintenance)
      diffEditorBindingDisposablesRef.current.push(modifiedEditor.onDidChangeModelContent(() => {
        const value = modifiedEditor.getValue()
        applyLiveDraftChangeRef.current(value)
      }))

      // Auxiliary: Convert editor selection to row selection range
      const handleCursorSelection = (
        side: SelectionSide,
        selection: monacoTypes.Selection
      ) => {
        // Skip row selection when there are unsaved drafts to avoid confusion between editing text and row-level operation status
        if (isDraftDirtyRef.current) return

        const targetEditor = side === 'deletions' ? originalEditor : modifiedEditor
        const lineCount = targetEditor.getModel()?.getLineCount() ?? 0
        if (lineCount <= 0) {
          setSelectedLineRangeValue(null)
          originalDecorationsRef.current?.clear()
          modifiedDecorationsRef.current?.clear()
          return
        }

        const startLine = selection.startLineNumber
        const endLine = selection.endLineNumber === selection.startLineNumber
          ? selection.endLineNumber
          : (selection.endColumn === 1 ? selection.endLineNumber - 1 : selection.endLineNumber)

        if (startLine === endLine && selection.startColumn === selection.endColumn) {
          // No selection (cursor click), clear row selection
          setSelectedLineRangeValue(null)
          originalDecorationsRef.current?.clear()
          modifiedDecorationsRef.current?.clear()
          return
        }

        const start = Math.max(1, Math.min(Math.min(startLine, endLine), lineCount))
        const end = Math.max(start, Math.min(Math.max(startLine, endLine), lineCount))

        setSelectedLineRangeValue({
          start,
          end,
          side,
          endSide: side
        })

        // Apply decorative highlighting
        const decorations: monacoTypes.editor.IModelDeltaDecoration[] = []
        for (let i = start; i <= end; i++) {
          decorations.push({
            range: new monaco.Range(i, 1, i, 1),
            options: {
              isWholeLine: true,
              className: 'git-diff-selected-line'
            }
          })
        }

        if (side === 'deletions') {
          modifiedDecorationsRef.current?.clear()
          if (!originalDecorationsRef.current) {
            originalDecorationsRef.current = originalEditor.createDecorationsCollection(decorations)
          } else {
            originalDecorationsRef.current.set(decorations)
          }
        } else {
          originalDecorationsRef.current?.clear()
          if (!modifiedDecorationsRef.current) {
            modifiedDecorationsRef.current = modifiedEditor.createDecorationsCollection(decorations)
          } else {
            modifiedDecorationsRef.current.set(decorations)
          }
        }
      }

      // Register selection changes for the original editor (left = deletions)
      diffEditorBindingDisposablesRef.current.push(originalEditor.onDidChangeCursorSelection((e) => {
        if (e.reason === monaco.editor.CursorChangeReason.RecoverFromMarkers) return
        handleCursorSelection('deletions', e.selection)
      }))

      // Register selection changes in the modification editor (right = additions)
      diffEditorBindingDisposablesRef.current.push(modifiedEditor.onDidChangeCursorSelection((e) => {
        if (e.reason === monaco.editor.CursorChangeReason.RecoverFromMarkers) return
        handleCursorSelection('additions', e.selection)
      }))

      // Scroll capture (replacing DOM scroll monitoring)
      diffEditorBindingDisposablesRef.current.push(modifiedEditor.onDidScrollChange(() => {
        if (suppressScrollCaptureRef.current) return
        if (diffScrollCaptureTimerRef.current) {
          window.clearTimeout(diffScrollCaptureTimerRef.current)
        }
        diffScrollCaptureTimerRef.current = window.setTimeout(() => {
          diffScrollCaptureTimerRef.current = null
          if (!isDraftDirtyRef.current) {
            // Read the latest editor status directly through ref to avoid closure expiration
            const currentEditor = diffEditorRef.current
            if (!currentEditor) return
            const currentMemory = getMemoryStore()
            if (!currentMemory) return
            const currentFile = selectedFileRef.current
            const currentFileKey = currentFile ? getFileKey(currentFile) : null
            if (!currentFileKey || !currentFile) return
            const currentFileState = fileContentsRef.current[currentFileKey]
            const me = currentEditor.getModifiedEditor()
            const ranges = me.getVisibleRanges()
            const firstLine = ranges.length > 0 ? ranges[0].startLineNumber : null
            const st = me.getScrollTop()
            const sig = currentFileState && !currentFileState.isBinary
              ? buildDiffSignature(
                currentFileState.originalContent ?? '',
                currentFileState.draftContent ?? currentFileState.modifiedContent ?? ''
              )
              : null
            currentMemory.entries[currentFileKey] = {
              fileKey: currentFileKey,
              filePath: currentFile.filename,
              originalFilename: currentFile.originalFilename,
              anchor: { line: firstLine, scrollTop: st },
              scrollTop: st,
              signature: sig,
              updatedAt: Date.now()
            }
            currentMemory.selectedFileKey = currentFileKey
            debugLog('capture:scroll', { fileKey: currentFileKey, line: firstLine, scrollTop: st })
          }
        }, 120)
      }))

      const handlePointerRelease = () => {
        scheduleDiffSplitMeasurement(editor)
      }
      window.addEventListener('mouseup', handlePointerRelease)
      window.addEventListener('pointerup', handlePointerRelease)
      diffEditorBindingDisposablesRef.current.push({
        dispose: () => {
          window.removeEventListener('mouseup', handlePointerRelease)
          window.removeEventListener('pointerup', handlePointerRelease)
        }
      })

      // Monaco's vertical sash sometimes captures pointer events without
      // letting them bubble to window — depending on platform / Monaco
      // version. Layout-change events are emitted directly from each
      // inner editor whenever the sash moves, so subscribing here is the
      // most reliable trigger for split-view-ratio persistence. Original
      // and modified pane widths change together; one listener is enough.
      diffEditorBindingDisposablesRef.current.push(
        modifiedEditor.onDidLayoutChange(() => {
          scheduleDiffSplitMeasurement(editor)
        })
      )

      // Scroll restoration is now handled by the DiffRevealPhase useLayoutEffect
      // when onDidUpdateDiff fires → restoring-scroll → synchronous scroll + reveal.
      const mountInstallFrame = window.requestAnimationFrame(() => {
        if (diffEditorRef.current !== editor) return
        scheduleDiffHunkActionWidgetInstall('editor-mounted')
      })
      diffEditorBindingDisposablesRef.current.push({
        dispose: () => window.cancelAnimationFrame(mountInstallFrame)
      })
    },
    [
      activeCwd,
      disposeDiffEditorBindings,
      disposeDiffHunkActionWidgets,
      enterDiffWaiting,
      getFileKey,
      revealDiffHunkActionForLine,
      reapplyPendingViewportGoal,
      emitViewportGoalTransition,
      scheduleDiffHunkActionWidgetInstall,
      scheduleHideDiffHunkActionWidgets,
      requestDiffRevealRestore,
      scheduleDiffSplitMeasurement,
      setSelectedLineRangeValue,
      startTokenizeSettleTracking,
      syncCurrentDiffEditorModels,
      terminalId
    ]
  )

  // When the selected file changes (not draft edits), enter waiting-diff so the
  // onDidUpdateDiff → restoring-scroll → reveal cycle can proceed.
  // Intentionally depends only on selectedFileKey (not selectedFileState) to avoid
  // re-entering the reveal cycle on every draft keystroke.
  useEffect(() => {
    if (!isOpen || !selectedFileKey) return
    const editor = diffEditorRef.current
    if (!editor) return
    if (diffRevealPhaseRef.current === 'idle') {
      enterDiffWaiting()
      // Warm reopen: the layout-effect 'model-bound' pass has ALREADY run
      // (layout effects fire before this effect) and was a no-op, and
      // unchanged models will never re-fire onDidUpdateDiff — drive the
      // cycle forward when the computed diff is already present.
      maybeCompleteWarmReveal()
    }
  }, [isOpen, enterDiffWaiting, maybeCompleteWarmReveal, selectedFileKey])

  useLayoutEffect(() => {
    if (!isOpen || !selectedFileKey || !selectedFileState || selectedFileState.loading) return
    if (selectedFile) {
      syncCurrentDiffEditorModels(selectedFile, selectedFileState, 'state-change')
    }
    const active = clickLatencyTrackerRef.current.getActive()
    if (!active || active.fileKey !== selectedFileKey || active.stateSetAt === null) return

    clickLatencyTrackerRef.current.markModelBound(selectedFileKey)
    if (selectedFileState.error || selectedFileState.isBinary || selectedFileState.isSvg || selectedFileState.isPdf || selectedFileState.isEpub) {
      clickLatencyTrackerRef.current.markDomCommitted(selectedFileKey)
      clickLatencyTrackerRef.current.markDiffComputed(selectedFileKey)
      clickLatencyTrackerRef.current.markTokenizeSettled(selectedFileKey, 'non-text')
      cancelDiffRevealTimeout()
      setDiffRevealPhase('idle')
      diffRevealPhaseRef.current = 'idle'
      return
    }

    const editor = diffEditorRef.current
    if (editor) {
      requestDiffRevealRestore('model-bound')
      window.setTimeout(() => {
        const current = clickLatencyTrackerRef.current.getActive()
        if (!current || current.fileKey !== selectedFileKey || current.diffComputedAt !== null) return
        clickLatencyTrackerRef.current.markDiffComputed(selectedFileKey)
        startTokenizeSettleTracking(selectedFileKey, editor)
      }, 0)
    }
  }, [
    cancelDiffRevealTimeout,
    isOpen,
    requestDiffRevealRestore,
    selectedFileKey,
    selectedFile,
    selectedFileState,
    selectedFileState?.draftContent,
    selectedFileState?.modifiedContent,
    selectedFileState?.originalContent,
    startTokenizeSettleTracking,
    syncCurrentDiffEditorModels
  ])

  useEffect(() => {
    const editor = diffEditorRef.current
    const monaco = monacoRef.current
    if (!isOpen || !editor || !monaco) {
      cancelHunkActionInstallSettling()
      disposeDiffHunkActionWidgets()
      return
    }
    scheduleDiffHunkActionWidgetInstall('selection-state')
  }, [
    disposeDiffHunkActionWidgets,
    cancelHunkActionInstallSettling,
    isOpen,
    isDraftDirty,
    scheduleDiffHunkActionWidgetInstall,
    selectedFileKey,
    selectedFileState
  ])

  // Render-then-reveal: restore scroll position synchronously before paint,
  // then transition to idle so CSS fade-in reveals the content.
  useLayoutEffect(() => {
    if (diffRevealPhase !== 'restoring-scroll') return

    const editor = diffEditorRef.current
    if (!editor) {
      setDiffRevealPhase('idle')
      diffRevealPhaseRef.current = 'idle'
      return
    }

    suppressScrollCaptureRef.current = true

    const file = selectedFileRef.current
    const fileKey = file ? getFileKey(file) : null
    const memory = getMemoryStore()
    let scrollApplied = false

    let decision: DiffRestoreDecision | null = null
    if (file && fileKey && memory) {
      const entry = findMemoryEntry(memory, file, fileKey) ?? null
      const currentFileState = fileContentsRef.current[fileKey]
      if (entry && (currentFileState?.loading || staleFileContentKeysRef.current.has(fileKey))) {
        // The selected body is still fetching (loading) or a forced refetch
        // is pending (stale-marked) — deciding now would compare the saved
        // signature against a placeholder or an outdated body. Fall back to
        // waiting-diff; the load's model sync / onDidUpdateDiff (or the
        // re-armed safety timeout) re-enters this effect once settled. The
        // loop terminates: the selection effect force-fetches stale keys,
        // and fetch completion clears both gates.
        enterDiffWaiting()
        window.setTimeout(() => { suppressScrollCaptureRef.current = false }, 200)
        return
      }
      const currentSignature =
        entry?.signature && currentFileState && !currentFileState.isBinary
          ? buildDiffSignature(
            currentFileState.originalContent ?? '',
            currentFileState.draftContent ?? currentFileState.modifiedContent ?? ''
          )
          : null
      decision = resolveDiffRestoreDecision({
        entry,
        isDeletedFile: file.status === 'D',
        currentSignature
      })
      if (decision.action === 'restore-scroll') {
        const modifiedEditor = editor.getModifiedEditor()
        modifiedEditor.setScrollTop(decision.scrollTop)
        const appliedScrollTop = modifiedEditor.getScrollTop()
        if (Math.abs(appliedScrollTop - decision.scrollTop) > 2) {
          // Fresh remount: Monaco has not measured the diff layout yet, so
          // the target offset was CLAMPED (observed: saved 34262 → 0). Park
          // the goal; onDidContentSizeChange re-applies it once honorable.
          pendingViewportGoalRef.current = {
            fileKey,
            kind: 'scroll',
            scrollTop: decision.scrollTop,
            appliedScrollTop,
            at: Date.now()
          }
          emitViewportGoalTransition('parked', pendingViewportGoalRef.current)
        }
        restoredAnchorRef.current[fileKey] = {
          line: entry?.anchor?.line ?? null,
          scrollTop: decision.scrollTop
        }
        scrollApplied = true
      } else if (decision.action === 'restore-anchor') {
        const modifiedEditor = editor.getModifiedEditor()
        const targetLine = clampEditorLine(modifiedEditor, decision.line)
        if (targetLine !== null) {
          modifiedEditor.revealLineNearTop(targetLine)
          restoredAnchorRef.current[fileKey] = {
            line: targetLine,
            scrollTop: 0
          }
          scrollApplied = true
        }
      }
      if (entry) {
        diffRestoreAppliedRef.current = { cycle: diffRestoreCycleRef.current, fileKey }
        setDiffRestoreNotice(null)
      }
    }

    let revealTargetLine: number | null = null
    if (!scrollApplied) {
      // Reveal the first change — the VS Code textDiffEditor fallback, and
      // (via resolveDiffRestoreDecision) the content-changed override: a
      // saved position for content the user has NOT seen is meaningless, so
      // the cycle lands on the first hunk instead of silently keeping an
      // old scroll offset (2026-07-18 warm-reopen staleness bundle).
      const changes = editor.getLineChanges()
      if (changes && changes.length > 0) {
        const firstChange = changes[0]
        const targetLine = firstChange.modifiedStartLineNumber || firstChange.originalStartLineNumber || 1
        const modifiedEditor = editor.getModifiedEditor()
        revealLineNearTopSafe(modifiedEditor, targetLine)
        revealTargetLine = targetLine
        if (fileKey) {
          const appliedScrollTop = modifiedEditor.getScrollTop()
          const lineTop = modifiedEditor.getTopForLineNumber(targetLine)
          const delta = lineTop - appliedScrollTop
          if (!(delta >= 0 && delta <= modifiedEditor.getLayoutInfo().height * 0.6)) {
            // Height-lagged reveal (unmeasured remount clamps the scroll,
            // observed: reveal 600 → landed ~189). Park the goal for the
            // onDidContentSizeChange self-heal.
            pendingViewportGoalRef.current = {
              fileKey,
              kind: 'reveal-line',
              line: targetLine,
              appliedScrollTop,
              at: Date.now()
            }
            emitViewportGoalTransition('parked', pendingViewportGoalRef.current)
          }
        }
      } else if (fileKey && decision?.action === 'reveal-first-change') {
        // Monaco has not computed the diff yet (fresh model swap): park a
        // one-shot reveal for the next onDidUpdateDiff of this fileKey.
        pendingFirstChangeRevealRef.current = { fileKey, reason: decision.reason }
      }
    }

    const decisionRecord: DiffRestoreDecisionRecord = {
      action: decision?.action ?? 'reveal-first-change',
      reason: decision
        ? (decision.action === 'reveal-first-change' ? decision.reason : null)
        : 'no-entry',
      trigger: lastRevealTriggerRef.current,
      fileKey,
      at: Date.now(),
      revealTargetLine
    }
    lastRestoreDecisionRef.current = decisionRecord
    perfTraceDiagnostic(PERF_TRACE_EVENT.RENDERER_GIT_DIFF_RESTORE_DECISION, {
      cwd: activeCwd ?? '',
      terminalId,
      action: decisionRecord.action,
      reason: decisionRecord.reason,
      trigger: decisionRecord.trigger,
      revealTargetLine: decisionRecord.revealTargetLine,
      filename: file?.filename
    })

    // Transition to idle — CSS fade-in reveals content
    cancelDiffRevealTimeout()
    setDiffRevealPhase('idle')
    diffRevealPhaseRef.current = 'idle'

    // Release scroll capture suppression after a brief delay
    window.setTimeout(() => {
      suppressScrollCaptureRef.current = false
    }, 200)
  }, [diffRevealPhase, activeCwd, cancelDiffRevealTimeout, emitViewportGoalTransition, enterDiffWaiting, findMemoryEntry, getFileKey, getMemoryStore, terminalId])

  useEffect(() => {
    return () => {
      disposeDiffEditorBindings()
      cancelDiffRevealTimeout()
    }
  }, [disposeDiffEditorBindings, cancelDiffRevealTimeout])

  const showEditMessage = useCallback((msg: { type: 'success' | 'error'; text: string }) => {
    setEditMessage(msg)
    if (editMessageTimerRef.current) {
      window.clearTimeout(editMessageTimerRef.current)
    }
    editMessageTimerRef.current = window.setTimeout(() => {
      setEditMessage(null)
    }, 2000)
  }, [])

  const handleSaveDraft = useCallback(async () => {
    if (!selectedFile || !selectedFileKey || !selectedFileState || !activeCwd) return
    if (!canEditFile) return
    const draft = selectedFileState.draftContent
    if (draft === undefined || draft === selectedFileState.modifiedContent) return
    setIsSavingEdit(true)
    setEditMessage(null)
    try {
      const result = await window.electronAPI.git.saveFileContent(activeCwd, selectedFile.filename, draft)
      if (!result.success) {
        showEditMessage({ type: 'error', text: result.error || t('gitDiff.error.saveFailed') })
        return
      }
      // Suppress the upcoming file-watch 'changed' event triggered by our own
      // save. The main-process watcher already calls suppressNext on this path,
      // but timing is platform-dependent — this client-side window is a belt
      // and braces against races.
      selfSaveSuppressUntilRef.current = Date.now() + 800
      const originalContent = selectedFileState.originalContent ?? ''
      setFileContents((prev) => {
        const current = prev[selectedFileKey]
        if (!current) return prev
        return {
          ...prev,
          [selectedFileKey]: {
            ...current,
            modifiedContent: draft,
            draftContent: undefined
          }
        }
      })
      // Patch sidebar +/- stats locally — avoid the full loadDiff({force:true})
      // round-trip which otherwise re-builds diffResult, re-keys fileContents,
      // and causes the whole UI to flicker on save. VS Code-style minimal update.
      const { additions, deletions } = quickLineDiffStats(originalContent, draft)
      if (additions === 0 && deletions === 0) {
        // Save brought the file back to its original content — git no longer
        // considers it a change, so the entry should leave the sidebar. Let
        // the authoritative diff refresh remove it; our suppress window
        // continues to short-circuit the concurrent file-watcher path.
        await loadDiff({ silent: true, force: true })
      } else {
        setDiffResult((prev) => {
          if (!prev) return prev
          let mutated = false
          const files = prev.files.map((f) => {
            const key = buildGitDiffFileKey(f.repoRoot || prev.cwd || '', f)
            if (key !== selectedFileKey) return f
            if (f.additions === additions && f.deletions === deletions) return f
            mutated = true
            return { ...f, additions, deletions }
          })
          return mutated ? { ...prev, files } : prev
        })
      }
      showEditMessage({ type: 'success', text: t('gitDiff.saved') })
    } catch (error) {
      showEditMessage({ type: 'error', text: t('gitDiff.error.saveFailedWithReason', { error: String(error) }) })
    } finally {
      setIsSavingEdit(false)
    }
  }, [
    selectedFile,
    selectedFileKey,
    selectedFileState,
    activeCwd,
    canEditFile,
    loadDiff,
    showEditMessage,
    t
  ])


  // Optimistic-then-reconcile for known single-file mutations (VS Code's
  // model, 2026-07-16 revert-scope fix): patch the list locally for an
  // instant update, then rely on the mirror-echo invalidation for the
  // authoritative reconcile, with a timer fallback when no reload arrived.
  // Cases the conservative patch table refuses fall back to ONE silent
  // non-force reload (the worker request cache was already dropped by the
  // mutation's own invalidation, so a non-force read recomputes fresh).
  const mutationReconcileTimerRef = useRef<number | null>(null)
  const scheduleMutationReconcileFallback = useCallback(() => {
    if (mutationReconcileTimerRef.current !== null) {
      window.clearTimeout(mutationReconcileTimerRef.current)
    }
    const baseline = loadDiffStatsRef.current.started
    mutationReconcileTimerRef.current = window.setTimeout(() => {
      mutationReconcileTimerRef.current = null
      if (!isOpenRef.current) return
      if (loadDiffStatsRef.current.started > baseline) return
      perfTrace(PERF_TRACE_EVENT.RENDERER_GIT_DIFF_MUTATION_RECONCILE_FALLBACK, {
        cwd: lastKnownCwdRef.current
      })
      void loadDiffRef.current?.({ silent: true })
    }, MUTATION_RECONCILE_FALLBACK_MS)
  }, [])
  useEffect(() => () => {
    if (mutationReconcileTimerRef.current !== null) {
      window.clearTimeout(mutationReconcileTimerRef.current)
      mutationReconcileTimerRef.current = null
    }
  }, [])

  const applyLocalPatchOrReload = useCallback(async (file: GitFileStatus, action: GitFileLocalAction) => {
    const cwd = activeCwd
    const patched = cwd ? applyFileActionToDiffResult(diffResultRef.current, file, action) : null
    perfTrace(PERF_TRACE_EVENT.RENDERER_GIT_DIFF_LOCAL_PATCH_APPLIED, {
      action,
      filename: file.filename,
      changeType: file.changeType,
      patched: Boolean(patched)
    })
    if (patched && cwd) {
      applyLoadedDiffResult(patched, cwd, file)
      scheduleMutationReconcileFallback()
      return
    }
    await loadDiff({ silent: true })
  }, [activeCwd, applyLoadedDiffResult, loadDiff, scheduleMutationReconcileFallback])

  const handleKeep = useCallback(async () => {
    if (!selectedFile || !activeCwd) return
    // Product telemetry: count each whole-file stage (Keep) action.
    trackFeatureUse('git-diff-stage')
    const fileKey = getFileKey(selectedFile)
    setActionState({ type: 'keep', fileKey })
    setActionMessage(null)
    try {
      const result: GitFileActionResult = await window.electronAPI.git.stageFile(activeCwd, selectedFile.filename, selectedFile.repoRoot)
      if (!result.success) {
        setActionMessage({ type: 'error', text: result.error || t('gitDiff.error.stageFailed') })
      } else {
        const message = selectedFile.changeType === 'staged' ? t('gitDiff.action.keepStaged') : t('gitDiff.action.staged')
        setActionMessage({ type: 'success', text: message })
        await applyLocalPatchOrReload(selectedFile, 'stage')
      }
    } catch (error) {
      setActionMessage({ type: 'error', text: t('gitDiff.error.stageFailedWithReason', { error: String(error) }) })
    } finally {
      setActionState((prev) => (prev?.fileKey === fileKey ? null : prev))
    }
  }, [selectedFile, activeCwd, getFileKey, applyLocalPatchOrReload, t])

  const handleDeny = useCallback(async () => {
    if (!selectedFile || !activeCwd) return
    if (selectedFile.changeType === 'untracked') {
      const confirmed = window.confirm(t('gitDiff.confirm.deleteUntracked', { fileName: selectedFile.filename }))
      if (!confirmed) return
    }
    // Product telemetry: count each whole-file discard (Deny) action that proceeds.
    trackFeatureUse('git-diff-discard')
    const fileKey = getFileKey(selectedFile)
    setActionState({ type: 'deny', fileKey })
    setActionMessage(null)
    try {
      const result: GitFileActionResult = await window.electronAPI.git.discardFile(activeCwd, {
        filename: selectedFile.filename,
        changeType: selectedFile.changeType,
        status: selectedFile.status,
        isSubmoduleEntry: selectedFile.isSubmoduleEntry
      }, selectedFile.repoRoot)
      if (!result.success) {
        setActionMessage({ type: 'error', text: result.error || t('gitDiff.error.discardFailed') })
      } else {
        const message = selectedFile.changeType === 'staged' ? t('gitDiff.action.unstaged') : t('gitDiff.action.discarded')
        setActionMessage({ type: 'success', text: message })
        await applyLocalPatchOrReload(selectedFile, 'discard')
      }
    } catch (error) {
      setActionMessage({ type: 'error', text: t('gitDiff.error.discardFailedWithReason', { error: String(error) }) })
    } finally {
      setActionState((prev) => (prev?.fileKey === fileKey ? null : prev))
    }
  }, [selectedFile, activeCwd, getFileKey, applyLocalPatchOrReload, t])

  useEffect(() => {
    if (editMessageTimerRef.current) {
      window.clearTimeout(editMessageTimerRef.current)
      editMessageTimerRef.current = 0
    }
    setEditMessage(null)
    setLineMessage(null)
  }, [selectedFileKey])

  useEffect(() => {
    if (isDraftDirty) {
      setSelectedLineRangeValue(null)
      originalDecorationsRef.current?.clear()
      modifiedDecorationsRef.current?.clear()
    }
  }, [isDraftDirty, setSelectedLineRangeValue])

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (!isOpen) return
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        if (canSaveDraft) {
          e.preventDefault()
          handleSaveDraft()
        }
      }
    }
    document.addEventListener('keydown', handleKeyDown, true)
    return () => document.removeEventListener('keydown', handleKeyDown, true)
  }, [isOpen, canSaveDraft, handleSaveDraft])

  const requestClose = useCallback(() => {
    if (!isOpen) return
    if (!confirmCloseWithDraft()) return
    persistCurrentDiffSplitRatio()
    captureDiffView()
    clearCurrentMemorySelection()
    detachDiffEditor()
    clearActiveDiffSelection()
    onClose()
  }, [captureDiffView, clearActiveDiffSelection, clearCurrentMemorySelection, confirmCloseWithDraft, detachDiffEditor, isOpen, onClose, persistCurrentDiffSplitRatio])

  useEffect(() => {
    const handleCloseEvent = (event: Event) => {
      const customEvent = event as CustomEvent<{ terminalId?: string }>
      if (!customEvent.detail?.terminalId) return
      if (customEvent.detail.terminalId !== terminalId) return
      requestClose()
    }

    window.addEventListener('git-diff:close', handleCloseEvent as EventListener)
    return () => {
      window.removeEventListener('git-diff:close', handleCloseEvent as EventListener)
    }
  }, [requestClose, terminalId])

  const handleOpenHistory = useCallback(() => {
    if (!terminalId) return
    if (!confirmCloseWithDraft()) return
    persistCurrentDiffSplitRatio()
    captureDiffView()
    detachDiffEditor()
    setDiffRestoreNotice(null)
    const detail: SubpageNavigateEventDetail = {
      terminalId,
      target: 'history',
      from: 'diff',
      intent: 'switch',
      entryPoint: 'subpage-switcher'
    }
    window.dispatchEvent(new CustomEvent('subpage:navigate', { detail }))
  }, [captureDiffView, confirmCloseWithDraft, detachDiffEditor, persistCurrentDiffSplitRatio, terminalId])

  const jumpToEditorDisabledReason = useMemo(() => {
    if (!selectedFile) return t('gitDiff.jumpToEditorDisabled.noFile')
    if (selectedFile.isSubmoduleEntry) return t('gitDiff.jumpToEditorDisabled.submodule')
    if (selectedFile.status === 'D') return t('gitDiff.jumpToEditorDisabled.deleted')
    if (jumpToEditorStatus === 'checking') return t('gitDiff.jumpToEditorDisabled.checking')
    if (jumpToEditorStatus === 'missing') return t('gitDiff.jumpToEditorDisabled.missing')
    return null
  }, [jumpToEditorStatus, selectedFile, t])

  const handleOpenEditor = useCallback(() => {
    if (!terminalId) return
    if (jumpToEditorDisabledReason) return
    const activeFile = selectedFileRef.current ?? selectedFile
    const activeTarget = buildJumpToEditorTarget(activeFile)
    if (
      !activeFile
      || activeFile.isSubmoduleEntry
      || activeFile.status === 'D'
      || !activeTarget
      || jumpToEditorCheck.key !== activeTarget.key
      || jumpToEditorCheck.status !== 'available'
    ) return
    if (!confirmCloseWithDraft()) return
    const detail: ProjectEditorOpenEventDetail = {
      terminalId,
      filePath: activeFile?.filename ?? null,
      repoRoot: activeFile?.repoRoot || diffResult?.cwd || activeCwd || null,
      changeType: activeFile?.changeType ?? null,
      source: 'diff',
      returnTarget: 'diff',
      diffFilePath: activeFile?.filename ?? null,
      diffRepoRoot: activeFile?.repoRoot || diffResult?.cwd || activeCwd || null,
      panelRoot: diffResult?.cwd || activeCwd || null
    }
    persistCurrentDiffSplitRatio()
    captureDiffView()
    detachDiffEditor()
    setDiffRestoreNotice(null)
    perfTrace(PERF_TRACE_EVENT.RENDERER_GIT_DIFF_JUMP_TO_EDITOR, {
      terminalId,
      cwd: activeCwd,
      filename: detail.filePath,
      repoRoot: detail.repoRoot,
      changeType: detail.changeType
    })
    window.dispatchEvent(new CustomEvent<SubpageNavigateEventDetail>('subpage:navigate', {
      detail: {
        terminalId: detail.terminalId,
        target: 'editor',
        from: 'diff',
        intent: 'jump',
        entryPoint: 'deep-link',
        filePath: detail.filePath,
        repoRoot: detail.repoRoot,
        changeType: detail.changeType,
        source: detail.source,
        returnTarget: detail.returnTarget,
        diffFilePath: detail.diffFilePath,
        diffRepoRoot: detail.diffRepoRoot,
        panelRoot: detail.panelRoot
      }
    }))
  }, [
    activeCwd,
    buildJumpToEditorTarget,
    captureDiffView,
    confirmCloseWithDraft,
    detachDiffEditor,
    diffResult?.cwd,
    jumpToEditorCheck,
    jumpToEditorDisabledReason,
    persistCurrentDiffSplitRatio,
    selectedFile,
    terminalId
  ])

  const handleSelectSubpage = useCallback((target: SubpageId) => {
    if (target === 'editor') {
      // SubpageSwitcher is a view switch — let Editor restore its own state
      // rather than overriding it with the Diff's selected file.
      if (!terminalId) return
      if (!confirmCloseWithDraft()) return
      persistCurrentDiffSplitRatio()
      captureDiffView()
      detachDiffEditor()
      setDiffRestoreNotice(null)
      window.dispatchEvent(new CustomEvent<SubpageNavigateEventDetail>('subpage:navigate', {
        detail: {
          terminalId,
          target: 'editor',
          from: 'diff',
          intent: 'switch',
          entryPoint: 'subpage-switcher'
        }
      }))
      return
    }
    if (target === 'history') {
      handleOpenHistory()
    }
  }, [captureDiffView, confirmCloseWithDraft, detachDiffEditor, handleOpenHistory, persistCurrentDiffSplitRatio, terminalId])

  // ESC settles an open large-file confirmation before it can close the
  // whole viewer (unified modal dismiss; useSubpageEscape is capture-phase
  // so the dialog cannot preempt it with its own listener).
  const handleSubpageEscape = useCallback(() => {
    if (largeFileConfirmRef.current) {
      perfTrace(PERF_TRACE_EVENT.RENDERER_MODAL_ESC_CANCELLED, { dialog: 'git-diff-large-file' })
      settleLargeFileConfirmation(false)
      return
    }
    requestClose()
  }, [requestClose, settleLargeFileConfirmation])

  useSubpageEscape({ isOpen, onEscape: handleSubpageEscape })
  const lineSelectionInfo = useMemo<LineSelectionInfo | null>(
    () => resolveLineSelectionInfo(selectedLineRange, t('gitDiff.line.invalid.crossSide')),
    [selectedLineRange, t]
  )
  useEffect(() => {
    selectedLineRangeRef.current = selectedLineRange
    lineSelectionInfoRef.current = lineSelectionInfo
  }, [lineSelectionInfo, selectedLineRange])
  const lineActionStatus = useMemo(() => {
    if (!selectedLineRange) {
      return {
        hasSelection: false,
        valid: false,
        label: t('gitDiff.line.noneSelected')
      }
    }
    if (!lineSelectionInfo) {
      return {
        hasSelection: false,
        valid: false,
        label: t('gitDiff.line.noneSelected')
      }
    }
    if (!lineSelectionInfo.valid) {
      return {
        hasSelection: true,
        valid: false,
        label: lineSelectionInfo.message
      }
    }
    return {
      hasSelection: true,
      valid: true,
      label: t('gitDiff.line.selectedCount', { count: lineSelectionInfo.count })
    }
  }, [selectedLineRange, lineSelectionInfo, t])
  const runLineAction = useCallback(async (action: 'keep' | 'deny'): Promise<boolean> => {
    const currentLineSelectionInfo = lineSelectionInfoRef.current ?? lineSelectionInfo
    if (!selectedFile || !activeCwd || !selectedFileState) return false
    if (!currentLineSelectionInfo) return false
    if (!currentLineSelectionInfo.valid) {
      setLineMessage({ type: 'error', text: currentLineSelectionInfo.message })
      return false
    }
    if (selectedFile.changeType === 'untracked') {
      setLineMessage({ type: 'error', text: t('gitDiff.line.error.untracked') })
      return false
    }
    if (selectedFile.status === 'D') {
      setLineMessage({ type: 'error', text: t('gitDiff.line.error.deleted') })
      return false
    }
    if (selectedFileState.isBinary) {
      setLineMessage({ type: 'error', text: t('gitDiff.line.error.binary') })
      return false
    }

    if (selectedFile.changeType === 'staged' && action === 'keep') {
      setLineMessage({ type: 'success', text: t('gitDiff.line.action.keepStagedSelection') })
      clearLineSelection()
      return true
    }

    // Product telemetry: count each partial (line-range) stage/discard commit.
    trackFeatureUse('git-diff-partial-stage')
    const fileKey = getFileKey(selectedFile)
    setLineActionState({ type: action, fileKey })
    setLineMessage(null)
    try {
      const baseContent = selectedFileState.originalContent
      const newContent = selectedFileState.modifiedContent
      let diff: FileDiffMetadata
      try {
        diff = parseDiffFromFile(
          { name: selectedFile.originalFilename || selectedFile.filename, contents: baseContent },
          { name: selectedFile.filename, contents: newContent }
        )
      } catch (error) {
        setLineMessage({ type: 'error', text: t('gitDiff.line.error.parseFailed', { error: String(error) }) })
        return false
      }

      const selectedLines = new Set<number>()
      for (let i = currentLineSelectionInfo.start; i <= currentLineSelectionInfo.end; i += 1) {
        selectedLines.add(i)
      }

      const applySelected = action === 'keep'
      const nextContent = buildContentWithSelection(
        diff,
        currentLineSelectionInfo.side,
        selectedLines,
        applySelected,
        baseContent,
        newContent
      )

      if (selectedFile.changeType === 'unstaged' && action === 'deny') {
        const saveResult = await window.electronAPI.git.saveFileContent(activeCwd, selectedFile.filename, nextContent)
        if (!saveResult.success) {
          setLineMessage({ type: 'error', text: saveResult.error || t('gitDiff.line.error.discardSelectionFailed') })
          return false
        }
        setLineMessage({ type: 'success', text: t('gitDiff.line.action.discardedSelection') })
        clearLineSelection()
        await loadDiff({ reset: true, force: true })
        return true
      }

      const updateResult = await window.electronAPI.git.updateIndexContent(activeCwd, selectedFile.filename, nextContent)
      if (!updateResult.success) {
        setLineMessage({ type: 'error', text: updateResult.error || t('gitDiff.line.error.updateIndexFailed') })
        return false
      }

      const message = selectedFile.changeType === 'staged'
        ? t('gitDiff.line.action.unstagedSelection')
        : t('gitDiff.line.action.stagedSelection')
      setLineMessage({ type: 'success', text: message })
      clearLineSelection()
      await loadDiff({ reset: true, force: true })
      return true
    } catch (error) {
      setLineMessage({ type: 'error', text: t('gitDiff.line.error.actionFailed', { error: String(error) }) })
      return false
    } finally {
      setLineActionState((prev) => (prev?.fileKey === fileKey ? null : prev))
    }
  }, [
    selectedFile,
    activeCwd,
    selectedFileState,
    lineSelectionInfo,
    getFileKey,
    loadDiff,
    clearLineSelection,
    t
  ])

  const runDiffHunkAction = useCallback(async (action: DiffHunkAction, range: DiffHunkActionRange): Promise<boolean> => {
    if (hunkActionInFlightRef.current) return false
    const file = selectedFileRef.current
    if (!file || !activeCwd) return false
    const fileKey = getFileKey(file)
    const state = fileContentsRef.current[fileKey]
    if (!state) return false
    if (file.changeType === 'untracked' || file.status === 'D' || state.isBinary) return false
    if (isDraftDirtyRef.current) return false
    // Product telemetry: count each per-hunk keep/deny widget action that proceeds.
    trackFeatureUse('git-diff-hunk')
    const startedAt = performance.now()
    hunkActionInFlightRef.current = true
    setLineMessage(null)
    try {
      const editor = diffEditorRef.current
      const liveOriginalContent = editor?.getOriginalEditor().getValue()
      const liveModifiedContent = editor?.getModifiedEditor().getValue()
      let baseContent = liveOriginalContent ?? state.originalContent
      let newContent = liveModifiedContent ?? state.draftContent ?? state.modifiedContent
      const freshContent = await window.electronAPI.git.getFileContent(activeCwd, {
        filename: file.filename,
        status: file.status,
        originalFilename: file.originalFilename,
        changeType: file.changeType,
        isSubmoduleEntry: file.isSubmoduleEntry
      }, file.repoRoot, {
        force: true,
        missReason: 'renderer-force-refresh'
      })
      if (freshContent.success && !freshContent.isBinary) {
        baseContent = freshContent.originalContent
        newContent = freshContent.modifiedContent
      }
      let diff: FileDiffMetadata
      try {
        diff = parseDiffFromFile(
          { name: file.originalFilename || file.filename, contents: baseContent },
          { name: file.filename, contents: newContent }
        )
      } catch (error) {
        setLineMessage({ type: 'error', text: t('gitDiff.line.error.parseFailed', { error: String(error) }) })
        return false
      }

      if (file.changeType === 'unstaged' && action === 'revert') {
        const nextContent = buildContentWithChangeRange(diff, range, false, baseContent, newContent)
        const saveResult = await window.electronAPI.git.saveFileContent(activeCwd, file.filename, nextContent)
        if (!saveResult.success) {
          setLineMessage({ type: 'error', text: saveResult.error || t('gitDiff.line.error.discardSelectionFailed') })
          return false
        }
        setLineMessage({ type: 'success', text: t('gitDiff.hunk.action.reverted') })
      } else {
        const applySelected = file.changeType === 'staged' || action === 'unstage' ? false : true
        const nextContent = buildContentWithChangeRange(diff, range, applySelected, baseContent, newContent)
        const updateResult = await window.electronAPI.git.updateIndexContent(activeCwd, file.filename, nextContent)
        if (!updateResult.success) {
          setLineMessage({ type: 'error', text: updateResult.error || t('gitDiff.line.error.updateIndexFailed') })
          return false
        }
        setLineMessage({
          type: 'success',
          text: applySelected ? t('gitDiff.hunk.action.staged') : t('gitDiff.hunk.action.unstaged')
        })
      }

      perfTrace(PERF_TRACE_EVENT.RENDERER_GIT_DIFF_HUNK_ACTION, {
        cwd: activeCwd,
        terminalId,
        fileKey,
        filename: file.filename,
        changeType: file.changeType,
        action,
        hunkIndex: range.index,
        result: 'success',
        durationMs: +(performance.now() - startedAt).toFixed(1)
      })
      await loadDiff({ reset: true, force: true })
      return true
    } catch (error) {
      setLineMessage({ type: 'error', text: t('gitDiff.line.error.actionFailed', { error: String(error) }) })
      perfTrace(PERF_TRACE_EVENT.RENDERER_GIT_DIFF_HUNK_ACTION, {
        cwd: activeCwd,
        terminalId,
        fileKey,
        filename: file.filename,
        changeType: file.changeType,
        action,
        hunkIndex: range.index,
        result: 'exception',
        error: String(error),
        durationMs: +(performance.now() - startedAt).toFixed(1)
      })
      return false
    } finally {
      hunkActionInFlightRef.current = false
    }
  }, [activeCwd, getFileKey, loadDiff, t, terminalId])

  useEffect(() => {
    runDiffHunkActionRef.current = runDiffHunkAction
  }, [runDiffHunkAction])

  const handleLineKeep = useCallback(() => {
    runLineAction('keep')
  }, [runLineAction])

  const handleLineDeny = useCallback(() => {
    runLineAction('deny')
  }, [runLineAction])
  const isActionPending = !!selectedFileKey && actionState?.fileKey === selectedFileKey
  const isKeepPending = isActionPending && actionState?.type === 'keep'
  const isDenyPending = isActionPending && actionState?.type === 'deny'
  const isLineActionPending = !!selectedFileKey && lineActionState?.fileKey === selectedFileKey
  const isLineKeepPending = isLineActionPending && lineActionState?.type === 'keep'
  const isLineDenyPending = isLineActionPending && lineActionState?.type === 'deny'
  const isImageVisualPreview = Boolean(selectedFileState?.isImage && (selectedFileState.isBinary || (selectedFileState.isSvg && svgViewMode === 'visual')))
  const canUseLineActions = !!selectedFile &&
    !!selectedFileState &&
    !selectedFileState.loading &&
    !selectedFileState.error &&
    !selectedFileState.isBinary &&
    (!selectedFile.repoRoot || selectedFile.repoRoot === diffResult?.cwd) &&
    !isDraftDirty &&
    selectedFile.changeType !== 'untracked' &&
    selectedFile.status !== 'D'
  const canShowLineActionPanel = Boolean(selectedFile && !isImageVisualPreview && !selectedFile.isSubmoduleEntry)
  const canShowFileActionPanel = Boolean(selectedFile)
  const canShowEditActionPanel = Boolean(!isImageVisualPreview && (isDraftDirty || editMessage))
  // Toggle visible only when the Monaco diff editor itself renders. Hides
  // for image / pdf / epub / submodule / binary / errored entries where
  // there is no Monaco viewport to switch.
  const canShowSplitModeToggle = Boolean(
    selectedFile
    && !selectedFile.isSubmoduleEntry
    && selectedFileState
    && !selectedFileState.error
    && !selectedFileState.isBinary
    && !selectedFileState.isSvg
    && !selectedFileState.isImage
    && !selectedFileState.isPdf
    && !selectedFileState.isEpub
  )
  const lineKeepLabel = selectedFile?.changeType === 'staged'
    ? t('gitDiff.line.keepStagedShort')
    : t('gitDiff.line.stageSelection')
  const lineDenyLabel = selectedFile?.changeType === 'staged'
    ? t('gitDiff.line.unstageSelection')
    : t('gitDiff.line.revertSelection')
  const fileKeepLabel = selectedFile?.changeType === 'staged'
    ? t('gitDiff.fileActions.keepStagedShort')
    : t('gitDiff.fileActions.stage')
  const fileDenyLabel = selectedFile?.changeType === 'staged'
    ? t('gitDiff.fileActions.unstage')
    : selectedFile?.changeType === 'untracked'
      ? t('gitDiff.fileActions.delete')
      : t('gitDiff.fileActions.discard')
  const diffFontSize = getTerminalStyle(terminalId)?.gitDiffFontSize ?? DEFAULT_GIT_DIFF_FONT_SIZE
  const diffEditorOptions = useMemo(() => ({
    splitViewDefaultRatio: diffSplitRatioRef.current,
    // Three-state view: 'split' forces side-by-side regardless of width;
    // 'inline' forces unified; 'auto' lets Monaco fall back to inline when
    // the container is below DIFF_INLINE_BREAKPOINT. The breakpoint and
    // useInlineViewWhenSpaceIsLimited are only honoured in 'auto' mode.
    renderSideBySide: splitViewMode !== 'inline',
    renderSideBySideInlineBreakpoint: splitViewMode === 'auto' ? DIFF_INLINE_BREAKPOINT : undefined,
    useInlineViewWhenSpaceIsLimited: splitViewMode === 'auto',
    enableSplitViewResizing: true,
    // Kill Monaco's built-in DiffEditorHunkToolbar arrow (the mysterious "->"
    // icon between panes). We render our own per-hunk Stage / Revert toolbar
    // instead, see installDiffHunkActionWidgets.
    renderGutterMenu: false,
    readOnly: !canEditFile,
    originalEditable: false,
    minimap: { enabled: false },
    wordWrap: 'on' as const,
    diffWordWrap: 'on' as const,
    fontFamily: PIERRE_LIKE_MONACO_FONT,
    fontSize: diffFontSize,
    lineHeight: Math.round(diffFontSize * 1.5),
    renderIndicators: true,
    renderMarginRevertIcon: false,
    diffAlgorithm: 'advanced' as const,
    automaticLayout: true,
    scrollBeyondLastLine: false,
    hideUnchangedRegions: {
      enabled: true,
      minimumLineCount: 3,
      contextLineCount: 3,
      revealLineCount: 20
    }
  }), [diffFontSize, canEditFile, splitViewMode])

  useEffect(() => {
    if (!window.electronAPI?.debug?.autotest) return
    if (!isOpen) {
      if ((window as any).__onwardGitDiffDebugTerminalId === terminalId) {
        delete (window as any).__onwardGitDiffDebug
        delete (window as any).__onwardGitDiffDebugTerminalId
      }
      return
    }
    const api: GitDiffDebugApi = {
      isOpen: () => isOpenRef.current,
      getFileList: () => diffResultRef.current?.files ?? [],
      getVisibleFileList: () => visibleFileListRef.current,
      getFileListViewMode: () => fileListViewMode,
      setFileListViewMode: (mode: GitDiffFileListViewMode) => {
        if (!isGitDiffFileListViewMode(mode)) return false
        setFileListViewMode(mode)
        return true
      },
      getVisibleTreeRows: () => {
        const rows: Array<{ type: 'dir' | 'file'; path: string; depth: number; name: string }> = []
        const walk = (nodes: DiffFileTreeNode[], depth: number) => {
          for (const node of nodes) {
            rows.push({ type: node.type, path: node.path, depth, name: node.name })
            if (node.type === 'dir' && !collapsedDiffTreeDirs.has(node.key)) {
              walk(node.children ?? [], depth + 1)
            }
          }
        }
        walk(buildDiffFileTree(visibleFileListRef.current, 'debug'), 0)
        return rows
      },
      getRepoList: () => diffResultRef.current?.repos ?? [],
      getVisibleRepoItems: () => visibleRepoItemsRef.current,
      setRepoExpanded,
      setRepoFilter: updateRepoFilter,
      getSelectedFile: () => {
        const file = selectedFileRef.current
        return file ? {
          filename: file.filename,
          originalFilename: file.originalFilename,
          status: file.status,
          changeType: file.changeType
        } : null
      },
      selectFileByPath: (path: string) => {
        const files = diffResultRef.current?.files ?? []
        const target = files.find((file) =>
          file.filename === path || file.originalFilename === path
        )
        if (target) {
          handleFileSelect(target)
          return true
        }
        return false
      },
      selectFileByIndex: (index: number) => {
        const files = diffResultRef.current?.files ?? []
        const target = files[index]
        if (target) {
          handleFileSelect(target)
          return true
        }
        return false
      },
      isSelectedReady: () => {
        const file = selectedFileRef.current
        const key = file ? getFileKey(file) : null
        if (!key) return false
        const state = fileContentsRef.current[key]
        return Boolean(state && !state.loading && !state.error && !state.isBinary)
      },
      getSelectedFileContent: () => {
        const file = selectedFileRef.current
        const key = file ? getFileKey(file) : null
        if (!key) return null
        const state = fileContentsRef.current[key]
        if (!state) return null
        return {
          originalContent: state.originalContent ?? null,
          modifiedContent: state.modifiedContent ?? null,
          draftContent: state.draftContent ?? null,
          isBinary: Boolean(state.isBinary),
          loading: Boolean(state.loading),
          error: state.error ?? null
        }
      },
      getSelectedEditorModelContent: () => {
        const editor = diffEditorRef.current
        const file = selectedFileRef.current
        const key = file ? getFileKey(file) : null
        const state = key ? fileContentsRef.current[key] : null
        if (!editor || !file || !key) return null
        const originalModel = editor.getOriginalEditor().getModel()
        const modifiedModel = editor.getModifiedEditor().getModel()
        const originalContent = originalModel?.getValue() ?? null
        const modifiedContent = modifiedModel?.getValue() ?? null
        const expectedOriginalContent = state?.originalContent ?? null
        const expectedModifiedContent = state
          ? state.draftContent ?? state.modifiedContent ?? ''
          : null
        return {
          originalContent,
          modifiedContent,
          expectedOriginalContent,
          expectedModifiedContent,
          originalUri: originalModel?.uri.toString() ?? null,
          modifiedUri: modifiedModel?.uri.toString() ?? null,
          originalMatchesState: expectedOriginalContent === null || originalContent === null
            ? null
            : originalContent === expectedOriginalContent,
          modifiedMatchesState: expectedModifiedContent === null || modifiedContent === null
            ? null
            : modifiedContent === expectedModifiedContent
        }
      },
      getCachedFileContentByPath: (path: string, changeType?: GitFileStatus['changeType']) => {
        const files = diffResultRef.current?.files ?? []
        const file = files.find((candidate) =>
          (candidate.filename === path || candidate.originalFilename === path) &&
          (!changeType || candidate.changeType === changeType)
        )
        const key = file ? getFileKey(file) : null
        if (!file || !key) return null
        const state = fileContentsRef.current[key]
        if (!state) return null
        return {
          filename: file.filename,
          changeType: file.changeType,
          originalContent: state.originalContent ?? null,
          modifiedContent: state.modifiedContent ?? null,
          draftContent: state.draftContent ?? null,
          isBinary: Boolean(state.isBinary),
          loading: Boolean(state.loading),
          error: state.error ?? null
        }
      },
      // Renderer prefetch is a lightweight thin layer over the main-side
      // content cache (see comment near the prefetch useEffect). This
      // selector returns its progress so the staleness autotest's
      // GDS-32 (first-selection-uses-prefetched-body-cache) check passes.
      getPrefetchState: () => ({ ...rendererPrefetchSnapshotRef.current }),
      getLastFileContentLoad: () => lastFileContentLoadRef.current
        ? { ...lastFileContentLoadRef.current }
        : null,
      getLastClickLatency: () => clickLatencyTrackerRef.current.getLast(),
      getLastClickLatencyForFile: (fileKey: string) =>
        clickLatencyTrackerRef.current.getLastForFile(fileKey),
      getClickLatencyHistory: () => clickLatencyTrackerRef.current.getHistory(),
      resetClickLatencyHistory: () => clickLatencyTrackerRef.current.reset(),
      getLoadDiffStats: () => ({ ...loadDiffStatsRef.current }),
      setSelectedDraftContent: (content: string) => {
        const file = selectedFileRef.current
        const key = file ? getFileKey(file) : null
        if (!key) return false
        const current = fileContentsRef.current[key]
        if (!current) return false
        const nextDraft = content === current.modifiedContent ? undefined : content
        const next = {
          ...fileContentsRef.current,
          [key]: {
            ...current,
            draftContent: nextDraft
          }
        }
        fileContentsRef.current = next
        setFileContents(next)
        setEditMessage(null)
        return true
      },
      getIsDraftDirty: () => isDraftDirtyRef.current,
      getRestoreNotice: () => diffRestoreNotice,
      getLastRestoreDecision: () => lastRestoreDecisionRef.current,
      getScrollTop: () => diffEditorRef.current?.getModifiedEditor().getScrollTop() ?? 0,
      getScrollMetrics: () => {
        const editor = diffEditorRef.current
        const modifiedEditor = editor?.getModifiedEditor()
        if (!editor || !modifiedEditor) return null
        const scrollHeight = modifiedEditor.getScrollHeight()
        const viewportHeight = modifiedEditor.getLayoutInfo().height
        const file = selectedFileRef.current
        const expectedModelUri = file ? buildGitDiffModelPath(file, activeCwd, 'modified') : null
        return {
          scrollTop: modifiedEditor.getScrollTop(),
          scrollHeight,
          viewportHeight,
          maxScrollTop: Math.max(0, scrollHeight - viewportHeight),
          modelMatchesSelection: Boolean(
            expectedModelUri && modifiedEditor.getModel()?.uri.toString() === expectedModelUri
          ),
          diffReady: editor.getLineChanges() !== null
        }
      },
      getFirstVisibleLine: () => {
        const editor = diffEditorRef.current
        if (!editor) return 0
        const file = selectedFileRef.current
        const fileKey = file ? getFileKey(file) : null
        const restoredAnchor = fileKey ? restoredAnchorRef.current[fileKey] : null
        const currentScrollTop = editor.getModifiedEditor().getScrollTop()
        if (restoredAnchor?.line && Math.abs(currentScrollTop - restoredAnchor.scrollTop) <= SCROLL_RESTORE_TOLERANCE) {
          return restoredAnchor.line
        }
        const ranges = editor.getModifiedEditor().getVisibleRanges()
        return ranges.length > 0 ? ranges[0].startLineNumber : 0
      },
      scrollToFraction: (fraction: number) => {
        const editor = diffEditorRef.current
        if (!editor) return false
        const modifiedEditor = editor.getModifiedEditor()
        const scrollHeight = modifiedEditor.getScrollHeight()
        const clientHeight = modifiedEditor.getLayoutInfo().height
        const max = Math.max(0, scrollHeight - clientHeight)
        const next = Math.max(0, Math.min(max, max * Math.max(0, Math.min(1, fraction))))
        modifiedEditor.setScrollTop(next)
        window.requestAnimationFrame(() => {
          if (!isDraftDirtyRef.current) {
            captureDiffView()
          }
        })
        return true
      },
      scrollToLine: (line: number) => {
        const editor = diffEditorRef.current
        if (!editor) return false
        if (!revealLineNearTopSafe(editor.getModifiedEditor(), line)) return false
        window.requestAnimationFrame(() => {
          if (!isDraftDirtyRef.current) {
            captureDiffView()
          }
        })
        return true
      },
      getDiffFontSize: () => getTerminalStyle(terminalId)?.gitDiffFontSize ?? DEFAULT_GIT_DIFF_FONT_SIZE,
      getCwd: () => activeCwd || null,
      getRepoRoot: () => diffResult?.cwd || null,
      isSubmodulesLoading: () => Boolean(diffResult?.submodulesLoading),
      getSubmoduleLoadObservation: () => ({ ...submoduleLoadObservationRef.current }),
      getTiming: () => {
        const timing = timingRef.current
        return {
          openRequestedAt: timing.openRequestedAt,
          shellShownAt: timing.shellShownAt,
          cwdReadyAt: timing.cwdReadyAt,
          diffLoadedAt: timing.diffLoadedAt,
          openToShellMs: timing.openRequestedAt !== null && timing.shellShownAt !== null
            ? Math.round(timing.shellShownAt - timing.openRequestedAt)
            : null,
          openToCwdReadyMs: timing.openRequestedAt !== null && timing.cwdReadyAt !== null
            ? Math.round(timing.cwdReadyAt - timing.openRequestedAt)
            : null,
          openToDiffLoadedMs: timing.openRequestedAt !== null && timing.diffLoadedAt !== null
            ? Math.round(timing.diffLoadedAt - timing.openRequestedAt)
            : null,
          cwdReadyToDiffLoadedMs: timing.cwdReadyAt !== null && timing.diffLoadedAt !== null
            ? Math.round(timing.diffLoadedAt - timing.cwdReadyAt)
            : null
        }
      },
      getLoadState: () => ({
        inFlight: loadInFlightRef.current,
        queued: loadQueuedRef.current
          ? {
              reset: Boolean(loadQueuedRef.current.reset),
              silent: Boolean(loadQueuedRef.current.silent),
              force: Boolean(loadQueuedRef.current.force)
            }
          : null,
        hasDiffResult: Boolean(diffResultRef.current),
        fileCount: diffResultRef.current?.files?.length ?? null,
        submodulesLoading: Boolean(diffResultRef.current?.submodulesLoading),
        hasLastDiff: Boolean(lastDiffRef.current),
        lastDiffAgeMs: lastDiffRef.current ? Date.now() - lastDiffRef.current.at : null
      }),
      getSplitViewState: () => measureDiffSplitState(),
      getSplitViewMode: () => splitViewMode,
      setSplitViewMode: (mode: GitDiffSplitViewMode) => {
        if (!isGitDiffSplitViewMode(mode)) return false
        setSplitViewMode(mode)
        window.requestAnimationFrame(() => {
          diffEditorRef.current?.layout()
        })
        return true
      },
      getDiffNavigationState: () => ({
        changeCount: diffEditorRef.current?.getLineChanges()?.length ?? 0,
        currentIndex: diffNavigationIndexRef.current
      }),
      getResponsiveLayoutState: () => {
        const editor = diffEditorRef.current
        const container = editor?.getContainerDomNode() ?? null
        return {
          mode: editor ? getDiffLayoutMode(editor, splitViewMode) : null,
          containerWidth: container ? Math.round(container.getBoundingClientRect().width) : null,
          inlineBreakpoint: DIFF_INLINE_BREAKPOINT,
          useInlineViewWhenSpaceIsLimited: splitViewMode === 'auto'
        }
      },
      setSplitViewRatio: (ratio: number) => {
        if (!Number.isFinite(ratio)) return false
        const editor = diffEditorRef.current
        if (!editor) return false
        const normalized = persistDiffSplitRatio(ratio)
        editor.updateOptions({ splitViewDefaultRatio: normalized })
        return true
      },
      setFileListWidth: (width: number) => {
        if (!Number.isFinite(width)) return false
        const normalized = Math.max(MIN_FILE_LIST_WIDTH, Math.min(MAX_FILE_LIST_WIDTH, Math.round(width)))
        setFileListWidth(normalized)
        localStorage.setItem(STORAGE_KEY_FILE_LIST_WIDTH, String(normalized))
        updateUIPreferences({ gitDiffFileListWidth: normalized })
        window.requestAnimationFrame(() => {
          diffEditorRef.current?.layout()
        })
        return true
      },
      dragSplitViewRatio: async (ratio: number) => dragDiffSplitRatio(ratio),
      navigateDiffChange: (direction: 'previous' | 'next') => navigateDiffChange(direction),
      refreshChanges: async () => refreshChanges(),
      getLargeFileConfirmState: () => {
        const state = largeFileConfirmRef.current
        return state ? {
          visible: true,
          filename: state.filename,
          sizeBytes: state.sizeBytes,
          sizeLabel: state.sizeLabel
        } : { visible: false, filename: null, sizeBytes: null, sizeLabel: null }
      },
      confirmLargeFile: () => {
        settleLargeFileConfirmation(true)
      },
      cancelLargeFile: () => {
        settleLargeFileConfirmation(false)
      },
      getTermsPopoverOpen: () => termsPopoverOpen,
      toggleTermsPopover: () => {
        setTermsPopoverOpen((prev) => !prev)
        return true
      },
      getHunkActionWidgetCount: () => {
        return Math.max(
          document.querySelectorAll('.git-diff-hunk-actions').length,
          diffHunkActionDisposablesRef.current.length
        )
      },
      getHunkActionDebugState: () => {
        const editor = diffEditorRef.current
        const file = selectedFileRef.current
        const key = file ? getFileKey(file) : null
        const state = key ? fileContentsRef.current[key] : null
        return {
          hasEditor: Boolean(editor),
          hasMonaco: Boolean(monacoRef.current),
          selectedFile: file
            ? { filename: file.filename, changeType: file.changeType, status: file.status }
            : null,
          selectedFileKey: key,
          hasState: Boolean(state),
          loading: state ? Boolean(state.loading) : null,
          error: state?.error ?? null,
          isBinary: state ? Boolean(state.isBinary) : null,
          isDraftDirty: isDraftDirtyRef.current,
	          lineChanges: editor?.getLineChanges()?.length ?? 0,
	          widgetDomCount: document.querySelectorAll('.git-diff-hunk-actions').length,
	          visibleWidgetDomCount: document.querySelectorAll('.git-diff-hunk-actions.is-visible').length,
	          widgetDisposableCount: diffHunkActionDisposablesRef.current.length,
	          installRetryPending: false
	        }
      },
      revealFirstHunkActionForTest: () => {
        let first = diffHunkActionWidgetHandlesRef.current[0]
        if (!first) {
          const editor = diffEditorRef.current
          const monaco = monacoRef.current
          if (editor && monaco) {
            installDiffHunkActionWidgets(editor, monaco)
            first = diffHunkActionWidgetHandlesRef.current[0]
          }
        }
        if (first) {
          setVisibleDiffHunkActionWidget(first.id)
        }
        return Boolean(first)
      },
      hideHunkActionsForTest: () => {
        setVisibleDiffHunkActionWidget(null)
      },
      triggerFirstHunkAction: async (action: DiffHunkAction) => {
        const editor = diffEditorRef.current
        const changes = editor?.getLineChanges() ?? []
        const first = changes[0]
        if (!first) return false
        const promise = runDiffHunkAction(action, {
          id: `debug:0:${first.originalStartLineNumber}-${first.originalEndLineNumber}:${first.modifiedStartLineNumber}-${first.modifiedEndLineNumber}`,
          index: 0,
          originalStartLineNumber: first.originalStartLineNumber,
          originalEndLineNumber: first.originalEndLineNumber,
          modifiedStartLineNumber: first.modifiedStartLineNumber,
          modifiedEndLineNumber: first.modifiedEndLineNumber
        })
        lastHunkActionPromiseRef.current = promise
        return await promise
      },
      waitForLastHunkActionForTest: async () => {
        const promise = lastHunkActionPromiseRef.current
        if (!promise) return null
        return await promise
      },
      setSelectedLineRangeForTest: (start: number, end: number, side: SelectionSide = 'additions') => {
        if (!Number.isFinite(start) || !Number.isFinite(end)) return false
        if (side !== 'additions' && side !== 'deletions') return false
        const editor = diffEditorRef.current
        const targetEditor = side === 'deletions' ? editor?.getOriginalEditor() : editor?.getModifiedEditor()
        const lineCount = targetEditor?.getModel()?.getLineCount() ?? 0
        if (!targetEditor || lineCount <= 0) return false
        const normalizedStart = Math.max(1, Math.min(Math.floor(Math.min(start, end)), lineCount))
        const normalizedEnd = Math.max(normalizedStart, Math.min(Math.floor(Math.max(start, end)), lineCount))
        const decorations: monacoTypes.editor.IModelDeltaDecoration[] = []
        for (let line = normalizedStart; line <= normalizedEnd; line += 1) {
          decorations.push({
            range: {
              startLineNumber: line,
              startColumn: 1,
              endLineNumber: line,
              endColumn: 1
            },
            options: {
              isWholeLine: true,
              className: 'git-diff-selected-line'
            }
          })
        }
        if (side === 'deletions') {
          modifiedDecorationsRef.current?.clear()
          originalDecorationsRef.current = targetEditor.createDecorationsCollection(decorations)
        } else {
          originalDecorationsRef.current?.clear()
          modifiedDecorationsRef.current = targetEditor.createDecorationsCollection(decorations)
        }
        setSelectedLineRangeValue({
          start: normalizedStart,
          end: normalizedEnd,
          side,
          endSide: side
        })
        return true
      },
      triggerLineAction: async (action: 'keep' | 'deny') => {
        return await runLineAction(action)
      },
      getImagePreviewState: () => {
        const file = selectedFileRef.current
        const key = file ? getFileKey(file) : null
        if (!key) return null
        const state = fileContentsRef.current[key]
        if (!state) return null
        return {
          isImage: Boolean(state.isImage),
          isSvg: Boolean(state.isSvg),
          isBinary: state.isBinary,
          hasOriginalUrl: Boolean(state.originalImageUrl),
          hasModifiedUrl: Boolean(state.modifiedImageUrl),
          compareMode: imageCompareMode,
          displayMode: imageDisplayMode,
          loading: state.loading
        }
      },
      getFileActionState: () => {
        if (!selectedFile) return null
        return {
          fileActionsVisible: canShowFileActionPanel,
          lineActionsVisible: canShowLineActionPanel,
          keepDisabled: !selectedFileState || selectedFileState.loading || isActionPending || isDraftDirty,
          denyDisabled: !selectedFileState || selectedFileState.loading || isActionPending || isDraftDirty,
          pending: isActionPending,
          toolbarVisible: Boolean(document.querySelector('.git-diff-action-bar')),
          actionPanelVisible: Boolean(document.querySelector('.git-diff-action-panel')),
          visibleLabels: Array.from(document.querySelectorAll('.git-diff-action-button-label'))
            .map((node) => (node.textContent ?? '').trim())
            .filter(Boolean)
        }
      },
      triggerFileAction: async (action: 'keep' | 'deny', expectedFilename?: string) => {
        if (!selectedFile) return false
        // Autotest guard against selection races: a background reload's
        // selection restore can land between the test's select and its
        // action call; acting on the wrong file would mutate the repo.
        // The closure's `selectedFile` is exactly what handleKeep/handleDeny
        // will act on, so this check is authoritative.
        if (expectedFilename !== undefined && selectedFile.filename !== expectedFilename) return false
        if (action === 'keep') {
          await handleKeep()
          return true
        }
        await handleDeny()
        return true
      },
      getPdfCompareState: () => inspectPdfCompareDom(),
      getEpubCompareState: () => inspectEpubCompareDom()
    }
    ;(window as any).__onwardGitDiffDebug = api
    ;(window as any).__onwardGitDiffDebugTerminalId = terminalId
    return () => {
      if ((window as any).__onwardGitDiffDebug === api) {
        delete (window as any).__onwardGitDiffDebug
        delete (window as any).__onwardGitDiffDebugTerminalId
      }
    }
  }, [
    activeCwd,
    diffRestoreNotice,
    diffResult,
    visibleFileList,
    visibleRepoItems,
    dragDiffSplitRatio,
    getFileKey,
    measureDiffSplitState,
    collapsedDiffTreeDirs,
    fileListViewMode,
    handleDeny,
    handleFileSelect,
    handleKeep,
    imageCompareMode,
    imageDisplayMode,
    installDiffHunkActionWidgets,
    isActionPending,
    isDraftDirty,
    isOpen,
    canShowFileActionPanel,
    canShowLineActionPanel,
    navigateDiffChange,
    persistDiffSplitRatio,
    refreshChanges,
    runDiffHunkAction,
    runLineAction,
    setVisibleDiffHunkActionWidget,
    setFileListViewMode,
    setSplitViewMode,
    setRepoExpanded,
    settleLargeFileConfirmation,
    selectedFile,
    selectedFileKey,
    selectedFileState,
    splitViewMode,
    terminalId,
    termsPopoverOpen,
    updateUIPreferences,
    updateRepoFilter
  ])

  // Make sure the readOnly switch takes effect immediately
  useEffect(() => {
    diffEditorRef.current?.getModifiedEditor().updateOptions({ readOnly: !canEditFile })
  }, [canEditFile])

  // Ensure diffWordWrap and split-view mode are always synced to the live
  // DiffEditor instance. Monaco's @monaco-editor/react wrapper calls
  // updateOptions when the options prop changes, but a few fields need to be
  // pushed explicitly to defeat staleness on rapid toggles.
  useEffect(() => {
    const editor = diffEditorRef.current
    if (!editor) return
    editor.updateOptions({
      diffWordWrap: 'on',
      renderSideBySide: splitViewMode !== 'inline',
      renderSideBySideInlineBreakpoint: splitViewMode === 'auto' ? DIFF_INLINE_BREAKPOINT : undefined,
      useInlineViewWhenSpaceIsLimited: splitViewMode === 'auto'
    } as any)
  }, [diffEditorOptions, splitViewMode])

  const language = useMemo(() => {
    return resolveMonacoLanguageId(selectedFile?.filename)
  }, [selectedFile])

  const originalModelPath = useMemo(() => {
    if (!selectedFile) return undefined
    return buildGitDiffModelPath(selectedFile, activeCwd, 'original')
  }, [activeCwd, selectedFile])

  const modifiedModelPath = useMemo(() => {
    if (!selectedFile) return undefined
    return buildGitDiffModelPath(selectedFile, activeCwd, 'modified')
  }, [activeCwd, selectedFile])

  const diffView = useMemo(() => {
    if (DEBUG_GIT_DIFF) {
      perfCountersRef.current.diffViewBuild += 1
    }
    if (!selectedFile || !selectedFileState) return null
    if (selectedFileState.error || selectedFileState.isBinary || selectedFileState.isSvg) return null
    return (
      <DiffEditor
        key={`text-${diffEditorIdentityKey}`}
        original={selectedFileState.originalContent}
        modified={effectiveModifiedContent}
        language={language}
        originalModelPath={originalModelPath}
        modifiedModelPath={modifiedModelPath}
        keepCurrentOriginalModel={true}
        keepCurrentModifiedModel={true}
        theme={PIERRE_LIKE_MONACO_THEME}
        beforeMount={ensurePierreLikeMonacoTheme}
        options={diffEditorOptions}
        onMount={handleEditorDidMount}
        className="git-diff-monaco"
        height="100%"
      />
    )
  }, [selectedFile, selectedFileState, language, diffEditorOptions, diffEditorIdentityKey, effectiveModifiedContent, handleEditorDidMount, modifiedModelPath, originalModelPath])

  const fileGroups = useMemo(() => {
    const groups: Record<GitFileStatus['changeType'], GitFileStatus[]> = {
      unstaged: [],
      staged: [],
      untracked: [],
      conflict: []
    }
    visibleFileList.forEach((file) => {
      groups[file.changeType].push(file)
    })
    return groups
  }, [visibleFileList])

  const groupedFileList = useMemo(() => {
    const groups = [
      { key: 'conflict', label: t('gitDiff.changeType.conflict'), files: fileGroups.conflict },
      { key: 'unstaged', label: t('gitDiff.changeType.unstaged'), files: fileGroups.unstaged },
      { key: 'staged', label: t('gitDiff.changeType.staged'), files: fileGroups.staged },
      { key: 'untracked', label: t('gitDiff.changeType.untracked'), files: fileGroups.untracked }
    ]
    return groups.filter(group => group.files.length > 0)
  }, [fileGroups, t])

  // Multi-repo layout: group by project first, then by change type. Keeps the
  // sidebar readable when several repos (e.g. submodules) share the workspace
  // instead of squeezing a truncated repo badge onto every file row.
  const repoSections = useMemo(() => {
    if (!hasMultipleRepos || !diffResult) return null
    type Section = {
      repoRoot: string
      repoLabel: string
      isSubmodule: boolean
      depth: number
      conflict: GitFileStatus[]
      unstaged: GitFileStatus[]
      staged: GitFileStatus[]
      untracked: GitFileStatus[]
    }
    const map = new Map<string, Section>()
    const ensureSection = (root: string, label: string, isSubmodule: boolean, depth: number) => {
      const existing = map.get(root)
      if (existing) return existing
      const section: Section = {
        repoRoot: root,
        repoLabel: label,
        isSubmodule,
        depth,
        conflict: [],
        unstaged: [],
        staged: [],
        untracked: []
      }
      map.set(root, section)
      return section
    }
    for (const repo of diffResult.repos ?? []) {
      ensureSection(repo.root, repo.label, repo.isSubmodule, repo.depth)
    }
    const fallbackCwd = diffResult.cwd || ''
    for (const file of diffResult.files) {
      if (repoFilter && file.repoRoot !== repoFilter) continue
      const root = file.repoRoot || fallbackCwd
      const label = file.repoLabel || root.split('/').pop() || root
      const section = ensureSection(root, label, Boolean(file.isSubmoduleEntry), 0)
      section[file.changeType].push(file)
    }
    return Array.from(map.values())
      .map((section) => ({
        repoRoot: section.repoRoot,
        repoLabel: section.repoLabel,
        isSubmodule: section.isSubmodule,
        depth: section.depth,
        totalCount: section.conflict.length + section.unstaged.length + section.staged.length + section.untracked.length,
        groups: [
          { key: 'conflict', label: t('gitDiff.changeType.conflict'), files: section.conflict },
          { key: 'unstaged', label: t('gitDiff.changeType.unstaged'), files: section.unstaged },
          { key: 'staged', label: t('gitDiff.changeType.staged'), files: section.staged },
          { key: 'untracked', label: t('gitDiff.changeType.untracked'), files: section.untracked }
        ].filter((group) => group.files.length > 0)
      }))
      .filter((section) => section.totalCount > 0)
      .sort((a, b) => {
        if (a.isSubmodule !== b.isSubmodule) return a.isSubmodule ? 1 : -1
        if (a.depth !== b.depth) return a.depth - b.depth
        return a.repoLabel.localeCompare(b.repoLabel)
      })
  }, [diffResult, hasMultipleRepos, repoFilter, t])

  useEffect(() => {
    if (!repoFilter || !selectedFile) return
    if (selectedFile.repoRoot === repoFilter) return
    clearActiveDiffSelection({ detachEditor: true })
  }, [clearActiveDiffSelection, repoFilter, selectedFile])

  useEffect(() => {
    if (!DEBUG_GIT_DIFF) return
    if (perfIntervalRef.current) return
    perfIntervalRef.current = window.setInterval(() => {
      const snapshot = { ...perfCountersRef.current }
      perfCountersRef.current.renders = 0
      perfCountersRef.current.loadDiff = 0
      perfCountersRef.current.diffViewBuild = 0
      const hasActivity = Object.values(snapshot).some(count => count > 0)
      if (hasActivity) {
        debugLog('perf:1s', {
          ...snapshot,
          selectedFile: selectedFileRef.current?.filename ?? null,
          cwd: activeCwd ?? null
        })
      }
    }, 1000)
    return () => {
      if (perfIntervalRef.current) {
        window.clearInterval(perfIntervalRef.current)
        perfIntervalRef.current = null
      }
    }
  }, [activeCwd])

  // Render Git not installed prompt
  const renderGitNotInstalled = () => (
    <div className="git-diff-not-installed">
      <div className="git-diff-warning-icon">
        <svg width="48" height="48" viewBox="0 0 24 24" fill="none">
          <path
            d="M12 9v4M12 17h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
            stroke="#e2c08d"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </div>
      <h3 className="git-diff-warning-title">{t('gitDiff.warning.gitMissing.title')}</h3>
      <p className="git-diff-warning-text">{t('gitDiff.warning.gitMissing.message')}</p>
      <div className="git-diff-install-guide">
        <p className="git-diff-guide-title">{t('gitDiff.installGuide')}</p>
        <ul className="git-diff-guide-list">
          <li><code>macOS:</code> brew install git</li>
          <li><code>Linux:</code> sudo apt install git</li>
          <li><code>Windows:</code> <a href="https://git-scm.com/download/win" target="_blank" rel="noopener noreferrer">https://git-scm.com/download/win</a></li>
        </ul>
      </div>
      <button className="git-diff-close-btn" onClick={requestClose}>
        {t('gitDiff.returnToTerminal')}
      </button>
    </div>
  )

  const renderSvgDiffEditor = useCallback((fileState: FileContentState) => {
    return (
      <div className="git-diff-editor-container">
        <DiffEditor
          key={`svg-text-${diffEditorIdentityKey}`}
          original={fileState.originalContent}
          modified={effectiveModifiedContent}
          language="xml"
          theme="vs-dark"
          options={diffEditorOptions}
          onMount={handleEditorDidMount}
          className="git-diff-monaco"
          height="100%"
        />
      </div>
    )
  }, [diffEditorOptions, diffEditorIdentityKey, effectiveModifiedContent, handleEditorDidMount])

  const renderImagePreview = useCallback((fileState: FileContentState, file: GitFileStatus) => {
    const status = file.status === 'A' || file.status === '?'
      ? 'added'
      : file.status === 'D'
        ? 'deleted'
        : 'modified'
    return (
      <GitImagePreview
        fileState={fileState as GitImagePreviewFileState}
        status={status}
        labels={{
          statusAdded: t('gitDiff.image.status.added'),
          statusDeleted: t('gitDiff.image.status.deleted'),
          statusModified: t('gitDiff.image.status.modified'),
          svg: t('gitDiff.image.svg'),
          viewVisual: t('gitDiff.image.view.visual'),
          viewText: t('gitDiff.image.view.text'),
          compareTwoUp: t('gitDiff.image.compare.twoUp'),
          compareSwipe: t('gitDiff.image.compare.swipe'),
          compareOnion: t('gitDiff.image.compare.onion'),
          displayOriginal: t('gitDiff.image.display.original'),
          displayFit: t('gitDiff.image.display.fit'),
          labelOriginal: t('gitDiff.image.label.original'),
          labelAdded: t('gitDiff.image.label.added'),
          labelModified: t('gitDiff.image.label.modified'),
          opacity: t('gitDiff.image.opacity')
        }}
        imageDisplayMode={imageDisplayMode}
        imageCompareMode={imageCompareMode}
        svgViewMode={svgViewMode}
        onImageDisplayModeChange={toggleImageDisplayMode}
        onImageCompareModeChange={toggleImageCompareMode}
        onSvgViewModeChange={setSvgViewMode}
        renderSvgDiffEditor={(state) => renderSvgDiffEditor(state as FileContentState)}
      />
    )
  }, [
    imageCompareMode,
    imageDisplayMode,
    renderSvgDiffEditor,
    t,
    toggleImageCompareMode,
    toggleImageDisplayMode,
    svgViewMode
  ])

  // Render non-Git repository prompts
  const renderNotGitRepo = () => (
    <div className="git-diff-not-installed">
      <div className="git-diff-warning-icon">
        <svg width="48" height="48" viewBox="0 0 24 24" fill="none">
          <path
            d="M12 9v4M12 17h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
            stroke="#858585"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </div>
      <h3 className="git-diff-warning-title">{t('gitDiff.warning.notRepo.title')}</h3>
      <p className="git-diff-warning-text">{diffResult?.error || t('gitDiff.warning.notRepo.message')}</p>
      <p className="git-diff-cwd">{diffResult?.cwd}</p>
      <button className="git-diff-close-btn" onClick={requestClose}>
        {t('gitDiff.returnToTerminal')}
      </button>
    </div>
  )

  // Rendering without change prompt
  const renderNoChanges = () => (
    <div className="git-diff-not-installed">
      <div className="git-diff-warning-icon">
        <svg width="48" height="48" viewBox="0 0 24 24" fill="none">
          <path
            d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"
            stroke="#89d185"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </div>
      <h3 className="git-diff-warning-title">{t('gitDiff.warning.noChanges.title')}</h3>
      <p className="git-diff-warning-text">{t('gitDiff.warning.noChanges.message')}</p>
      <p className="git-diff-cwd">{diffResult?.cwd}</p>
      <button className="git-diff-close-btn" onClick={requestClose}>
        {t('gitDiff.returnToTerminal')}
      </button>
    </div>
  )

  const renderDiffDetail = () => {
    if (!selectedFile) {
      return (
        <DiffEmptyState
          className="git-diff-no-selection"
          title={t('gitDiff.clickToView.title')}
          description={t('gitDiff.clickToView.desc')}
        >
          {/* Context-menu OS actions can fail without a selection — their
              error toast must stay visible in the empty state too. */}
          {copyMessage && (
            <span className={`path-copy-toast ${copyMessage.type}`}>
              {copyMessage.text}
            </span>
          )}
        </DiffEmptyState>
      )
    }

    const fileState = selectedFileState
    const canShowRefreshingState = Boolean(fileState?.loading && fileState.refreshing)
    const fileReadyForPreview = Boolean(fileState && !fileState.error && (!fileState.loading || canShowRefreshingState))
    const headerTitle = selectedFile.originalFilename && (selectedFile.status === 'R' || selectedFile.status === 'C')
      ? `${selectedFile.originalFilename} → ${selectedFile.filename}`
      : selectedFile.filename
    return (
      <>
        {diffRestoreNotice && (
          <div className="git-diff-restore-banner">
            <div className="git-diff-restore-text">
              {diffRestoreNotice.message}
            </div>
            <div className="git-diff-restore-actions">
              <button
                className="git-diff-restore-btn primary"
                onClick={() => {
                  scrollToFirstChange()
                }}
              >
                {t('gitDiff.restore.jumpToChange')}
              </button>
              <button
                className="git-diff-restore-btn"
                onClick={() => {
                  scrollToTop()
                }}
              >
                {t('gitDiff.restore.backToTop')}
              </button>
              <button
                className="git-diff-restore-btn ghost"
                onClick={() => setDiffRestoreNotice(null)}
              >
                {t('gitDiff.restore.close')}
              </button>
            </div>
          </div>
        )}
        <div className="git-diff-detail-header">
          <div className="git-diff-detail-info">
            <span
              className="git-diff-file-status"
              style={{ color: statusColors[selectedFile.status] }}
            >
              [{statusText[selectedFile.status]}]
            </span>
            {selectedFile.isSubmoduleEntry && (
              <span className="git-diff-submodule-badge" title={t('gitDiff.status.submodule')}>S</span>
            )}
            <span className="git-diff-change-type">
              {changeTypeText[selectedFile.changeType]}
            </span>
            <span
              className="git-diff-detail-filename"
              title={t('gitDiff.filenameCopyHint')}
              onDoubleClick={handleFilenameDblClick}
            >
              {headerTitle}
            </span>
            {isDraftDirty && (
              <span className="git-diff-file-dirty">{t('gitDiff.unsaved')}</span>
            )}
            {copyMessage && (
              <span className={`path-copy-toast ${copyMessage.type}`}>
                {copyMessage.text}
              </span>
            )}
          </div>
          {(canShowLineActionPanel || canShowFileActionPanel || canShowEditActionPanel) && (
            <div className="git-diff-detail-actions-row">
              {canShowLineActionPanel && (
                <div className="git-diff-action-bar" aria-label={t('gitDiff.line.title')}>
                  <span className={`git-diff-line-count ${lineActionStatus.valid ? '' : 'invalid'}`}>
                    {lineActionStatus.label}
                  </span>
                  {lineMessage && (
                    <span className={`git-diff-toast-message ${lineMessage.type}`}>
                      {lineMessage.text}
                    </span>
                  )}
                  <div className="git-diff-action-button-group">
                    <button
                      className="git-diff-action-button success git-diff-line-keep-btn"
                      onClick={handleLineKeep}
                      disabled={!canUseLineActions || !lineActionStatus.valid || isLineActionPending}
                      title={t('gitDiff.line.keepTitle')}
                    >
                      <StageActionIcon />
                      <span className="git-diff-action-button-label">
                        {isLineKeepPending ? t('gitDiff.processing') : lineKeepLabel}
                      </span>
                    </button>
                    <button
                      className="git-diff-action-button danger git-diff-line-deny-btn"
                      onClick={handleLineDeny}
                      disabled={!canUseLineActions || !lineActionStatus.valid || isLineActionPending}
                      title={t('gitDiff.line.denyTitle')}
                    >
                      <DiscardActionIcon />
                      <span className="git-diff-action-button-label">
                        {isLineDenyPending ? t('gitDiff.processing') : lineDenyLabel}
                      </span>
                    </button>
                    <button
                      className="git-diff-action-button neutral git-diff-line-clear-btn"
                      onClick={clearLineSelection}
                      disabled={!lineActionStatus.hasSelection || isLineActionPending}
                      title={t('gitDiff.line.clear')}
                    >
                      <ClearActionIcon />
                      <span className="git-diff-action-button-label">{t('gitDiff.line.clear')}</span>
                    </button>
                  </div>
                </div>
              )}
              {canShowFileActionPanel && (
                <div className="git-diff-action-bar" aria-label={t('gitDiff.fileActions.title')}>
                  {actionMessage && (
                    <span className={`git-diff-toast-message ${actionMessage.type}`}>
                      {actionMessage.text}
                    </span>
                  )}
                  <div className="git-diff-action-button-group">
                    <button
                      className="git-diff-action-button success git-diff-keep-btn"
                      onClick={handleKeep}
                      disabled={!selectedFileState || selectedFileState.loading || isActionPending || isDraftDirty}
                      title={selectedFile.changeType === 'staged' ? t('gitDiff.fileActions.keepStagedTitle') : t('gitDiff.fileActions.keepTitle')}
                    >
                      <StageActionIcon />
                      <span className="git-diff-action-button-label">
                        {isKeepPending ? t('gitDiff.processing') : fileKeepLabel}
                      </span>
                    </button>
                    <button
                      className="git-diff-action-button danger git-diff-deny-btn"
                      onClick={handleDeny}
                      disabled={!selectedFileState || selectedFileState.loading || isActionPending || isDraftDirty}
                      title={selectedFile.changeType === 'staged' ? t('gitDiff.fileActions.unstageTitle') : t('gitDiff.fileActions.denyTitle')}
                    >
                      <DiscardActionIcon />
                      <span className="git-diff-action-button-label">
                        {isDenyPending ? t('gitDiff.processing') : fileDenyLabel}
                      </span>
                    </button>
                  </div>
                </div>
              )}
              {canShowEditActionPanel && (
                <div className="git-diff-action-bar" aria-label={t('gitDiff.fileActions.editTitle')}>
                  {editMessage && (
                    <span className={`git-diff-toast-message ${editMessage.type}`}>
                      {editMessage.text}
                    </span>
                  )}
                  {isDraftDirty && (
                    <span className="git-diff-unsaved">{t('gitDiff.unsaved')}</span>
                  )}
                  {isDraftDirty && (
                    <div className="git-diff-action-button-group">
                      <button
                        className="git-diff-action-button primary git-diff-save-btn"
                        onClick={handleSaveDraft}
                        disabled={!canSaveDraft}
                      >
                        <SaveActionIcon />
                        <span className="git-diff-action-button-label">
                          {isSavingEdit ? t('gitDiff.saving') : t('gitDiff.saveFile')}
                        </span>
                      </button>
                      <button
                        className="git-diff-action-button neutral git-diff-discard-btn"
                        onClick={discardDraft}
                        disabled={!isDraftDirty || isSavingEdit}
                      >
                        <ClearActionIcon />
                        <span className="git-diff-action-button-label">{t('gitDiff.discardDraft')}</span>
                      </button>
                    </div>
                  )}
                </div>
              )}
            </div>
          )}
        </div>
        <div className={`git-diff-detail-content${diffRevealPhase !== 'idle' ? ` diff-phase-${diffRevealPhase}` : ''}`}>
          {(!fileState || (fileState.loading && !canShowRefreshingState)) && (
            <div className="git-diff-loading">
              <div className="git-diff-loading-dots" aria-hidden="true"><span /><span /><span /></div>
              <span>{t('gitDiff.loadingFile')}</span>
            </div>
          )}
          {fileState && !fileState.loading && fileState.error && (
            <div className="git-diff-no-content">
              {fileState.error}
            </div>
          )}
          {fileReadyForPreview && fileState?.isImage && (fileState.isBinary || fileState.isSvg) && (
            renderImagePreview(fileState, selectedFile)
          )}
          {fileReadyForPreview && fileState?.isPdf && (
            <GitPdfCompare
              status={
                (selectedFile?.status === 'A' || selectedFile?.status === '?') ? 'added'
                  : selectedFile?.status === 'D' ? 'deleted'
                    : 'modified' as GitPdfStatus
              }
              originalPreviewData={fileState.originalPreviewData}
              modifiedPreviewData={fileState.modifiedPreviewData}
              originalSize={fileState.originalPreviewSize}
              modifiedSize={fileState.modifiedPreviewSize}
              filename={selectedFile?.filename ?? ''}
              viewerUrl={pdfViewerUrl}
              labels={{
                statusAdded: t('gitDiff.pdfCompare.statusAdded'),
                statusDeleted: t('gitDiff.pdfCompare.statusDeleted'),
                statusModified: t('gitDiff.pdfCompare.statusModified'),
                labelOriginal: t('gitDiff.pdfCompare.labelOriginal'),
                labelAdded: t('gitDiff.pdfCompare.labelAdded'),
                labelModified: t('gitDiff.pdfCompare.labelModified'),
                noOriginal: t('gitDiff.pdfCompare.noOriginal'),
                noModified: t('gitDiff.pdfCompare.noModified')
              }}
            />
          )}
          {fileReadyForPreview && fileState?.isEpub && (
            <GitEpubCompare
              status={
                (selectedFile?.status === 'A' || selectedFile?.status === '?') ? 'added'
                  : selectedFile?.status === 'D' ? 'deleted'
                    : 'modified' as GitEpubStatus
              }
              originalPreviewData={fileState.originalPreviewData}
              modifiedPreviewData={fileState.modifiedPreviewData}
              originalSize={fileState.originalPreviewSize}
              modifiedSize={fileState.modifiedPreviewSize}
              filename={selectedFile?.filename ?? ''}
              labels={{
                statusAdded: t('gitDiff.epubCompare.statusAdded'),
                statusDeleted: t('gitDiff.epubCompare.statusDeleted'),
                statusModified: t('gitDiff.epubCompare.statusModified'),
                chapterAdded: t('gitDiff.epubCompare.chapterAdded'),
                chapterDeleted: t('gitDiff.epubCompare.chapterDeleted'),
                chapterModified: t('gitDiff.epubCompare.chapterModified'),
                chapterUnchanged: t('gitDiff.epubCompare.chapterUnchanged'),
                labelOriginal: t('gitDiff.epubCompare.labelOriginal'),
                labelModified: t('gitDiff.epubCompare.labelModified'),
                noOriginal: t('gitDiff.epubCompare.noOriginal'),
                noModified: t('gitDiff.epubCompare.noModified'),
                loading: t('gitDiff.epubCompare.loading'),
                error: t('gitDiff.epubCompare.error'),
                chapters: t('gitDiff.epubCompare.chapters'),
                resources: t('gitDiff.epubCompare.resources'),
                noResourceChanges: t('gitDiff.epubCompare.noResourceChanges'),
                resourceAdded: t('gitDiff.epubCompare.resourceAdded'),
                resourceDeleted: t('gitDiff.epubCompare.resourceDeleted'),
                resourceModified: t('gitDiff.epubCompare.resourceModified')
              }}
            />
          )}
          {fileReadyForPreview && fileState?.isBinary && !fileState.isImage && !fileState.isPdf && !fileState.isEpub && (
            <div className="git-diff-no-content">
              {t('gitDiff.binaryUnsupported')}
            </div>
          )}
          {fileReadyForPreview && fileState && !fileState.isBinary && !fileState.isSvg && (
            <div className="git-diff-editor-container">
              {diffView}
            </div>
          )}
        </div>
      </>
    )
  }

  const renderLoadingShell = (message: string, repoContexts?: GitRepoContext[]) => {
    const loadingRepos = [...(repoContexts ?? [])]
      .filter((repo) => repo.isSubmodule || repo.loading)
      .sort(sortRepoContexts)

    // G4: paint REAL file rows from the mirror snapshot while getDiff runs.
    // The snapshot already carries every changed path + status; only the
    // +/- counts are unknown (they keep the shimmer bar). Empty when the
    // mirror has no data yet (cold subscribe) — the anonymous shimmer rows
    // below cover that case exactly as before.
    const skeletonEntries = buildOpenSkeletonEntries(mirrorSnapshot?.files)
    const headerCount = skeletonEntries.length

    return (
      <div className="git-diff-main git-diff-main-loading">
        <div className="git-diff-file-list" style={{ width: fileListWidth }}>
          {loadingRepos.length > 0 && (
            <div className="git-diff-repo-filter">
              <div className="git-diff-repo-filter-item active loading">
                <span className="git-diff-repo-filter-label">{t('gitDiff.repo.all')}</span>
                <span className="git-diff-repo-filter-count loading">...</span>
              </div>
              {loadingRepos.map((repo) => (
                <div
                  key={repo.root}
                  className="git-diff-repo-filter-item loading"
                  title={repo.root}
                >
                  <span className="git-diff-repo-filter-label">{repo.label}</span>
                  <span className="git-diff-repo-filter-count loading">...</span>
                </div>
              ))}
            </div>
          )}
          <div className="git-diff-file-list-header">
            {t('gitDiff.fileList', { count: headerCount })}
          </div>
          <div className="git-diff-file-list-content git-diff-file-list-content-loading">
            {skeletonEntries.length > 0
              ? skeletonEntries.map((entry) => (
                <div
                  key={entry.key}
                  className="git-diff-file-skeleton git-diff-file-skeleton-known"
                  title={entry.filename}
                >
                  <span className={`git-diff-file-skeleton-status known status-${entry.status.toLowerCase()}`}>
                    {entry.status}
                  </span>
                  <span className="git-diff-file-skeleton-name">{entry.filename}</span>
                  <span className="git-diff-file-skeleton-stats" />
                </div>
              ))
              : Array.from({ length: 6 }).map((_, index) => (
                <div
                  key={`git-diff-skeleton-${index}`}
                  className={`git-diff-file-skeleton${index % 3 === 0 ? ' short' : index % 3 === 1 ? ' medium' : ''}`}
                >
                  <span className="git-diff-file-skeleton-status" />
                  <span className="git-diff-file-skeleton-line" />
                  <span className="git-diff-file-skeleton-stats" />
                </div>
              ))}
          </div>
          <div className="git-diff-resizer" />
        </div>

        <div className="git-diff-detail git-diff-detail-loading">
          <div className="git-diff-loading">
            <div className="git-diff-loading-dots" aria-hidden="true"><span /><span /><span /></div>
            <span>
              {skeletonEntries.length > 0
                ? t('gitDiff.loadingKnownChanges', { count: headerCount })
                : message}
            </span>
          </div>
        </div>
      </div>
    )
  }

  // Main content rendering
  const renderContent = () => {
    if (!diffResult) {
      return renderLoadingShell(t('gitDiff.loading'))
    }

    if (!diffResult.gitInstalled) {
      return renderGitNotInstalled()
    }

    if (!diffResult.isGitRepo) {
      return renderNotGitRepo()
    }

    if (diffResult.success && diffResult.files.length === 0 && diffResult.submodulesLoading) {
      return renderLoadingShell(t('gitDiff.loadingSubmodules'), diffResult.repos)
    }

    if (!diffResult.success || diffResult.files.length === 0) {
      return renderNoChanges()
    }

    const filteredFileCount = visibleFileList.length

    return (
      <div className="git-diff-main">
        <div className="git-diff-file-list" style={{ width: fileListWidth }}>
          {diffResult.superprojectRoot && (
            <div
              className="git-diff-superproject-hint"
              onClick={() => {
                void loadDiffFromRoot(diffResult.superprojectRoot!)
              }}
            >
              <span>{t('gitDiff.repo.inSubmodule')}</span>
              <span style={{ color: 'var(--accent)', cursor: 'pointer' }}>{t('gitDiff.repo.viewParent')}</span>
            </div>
          )}
          {diffResult.submodulesLoading && (
            <div className="git-diff-loading" style={{ minHeight: 'auto', justifyContent: 'flex-start', padding: '8px 12px', gap: '8px' }}>
              <div className="git-diff-loading-dots" aria-hidden="true"><span /><span /><span /></div>
              <span>{t('gitDiff.loadingSubmodules')}</span>
            </div>
          )}
          {hasMultipleRepos && diffResult.repos && (
            <div className="git-diff-repo-filter">
              <div
                className={`git-diff-repo-filter-item${repoFilter === null ? ' active' : ''}`}
                onClick={() => updateRepoFilter(null)}
              >
                <span className="git-diff-repo-filter-label">{t('gitDiff.repo.all')}</span>
                <span className="git-diff-repo-filter-count">{diffResult.files.length}</span>
              </div>
              {visibleRepoItems.map((repo) => {
                const canSelectRepo = !repo.loading && repo.changeCount > 0
                return (
                  <div
                    key={repo.root}
                    className={`git-diff-repo-filter-item${repoFilter === repo.root ? ' active' : ''}${repo.loading ? ' loading' : ''}`}
                    style={{ paddingLeft: `${12 + (repo.treeDepth * 14)}px` }}
                    onClick={() => {
                      if (canSelectRepo) {
                        updateRepoFilter(repo.root)
                      }
                    }}
                    title={repo.root}
                  >
                    <button
                      type="button"
                      className={`git-diff-repo-toggle${repo.hasChildren ? '' : ' hidden'}`}
                      onClick={(event) => {
                        event.stopPropagation()
                        toggleRepoExpanded(repo.root)
                      }}
                      aria-label={repo.expanded ? t('gitDiff.repo.collapse') : t('gitDiff.repo.expand')}
                    >
                      <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor">
                        <path d={repo.expanded ? 'M4 6l4 4 4-4H4z' : 'M6 4l4 4-4 4V4z'} />
                      </svg>
                    </button>
                    <span className="git-diff-repo-filter-label">{repo.displayLabel}</span>
                    <span className={`git-diff-repo-filter-count${repo.loading ? ' loading' : ''}`}>
                      {repo.loading ? '...' : repo.changeCount}
                    </span>
                  </div>
                )
              })}
            </div>
          )}
          <div className="git-diff-file-list-header">
            <span className="git-diff-file-list-title">{t('gitDiff.fileList', { count: filteredFileCount })}</span>
            <div className="git-diff-file-list-view-toggle" role="group" aria-label={t('gitDiff.fileListViewMode')}>
              <button
                type="button"
                className={`git-diff-view-mode-button${fileListViewMode === 'tree' ? ' active' : ''}`}
                onClick={() => setFileListViewMode('tree')}
                aria-pressed={fileListViewMode === 'tree'}
                title={t('gitDiff.fileListView.treeTitle')}
              >
                <TreeViewIcon />
                <span>{t('gitDiff.fileListView.tree')}</span>
              </button>
              <button
                type="button"
                className={`git-diff-view-mode-button${fileListViewMode === 'flat' ? ' active' : ''}`}
                onClick={() => setFileListViewMode('flat')}
                aria-pressed={fileListViewMode === 'flat'}
                title={t('gitDiff.fileListView.flatTitle')}
              >
                <FlatViewIcon />
                <span>{t('gitDiff.fileListView.flat')}</span>
              </button>
            </div>
          </div>
          <div className="git-diff-file-list-content">
            {(() => {
              const renderFileItem = (file: GitFileStatus, options?: { depth?: number; treeLeafName?: string }) => {
                const fileKey = diffResult?.cwd ? buildGitDiffFileKey(file.repoRoot || diffResult.cwd, file) : file.filename
                const isSelected = selectedFileKey === fileKey
                const fileState = fileContents[fileKey]
                const isDirty = fileState?.draftContent !== undefined &&
                  fileState.draftContent !== fileState.modifiedContent
                const depth = options?.depth ?? 0
                const setiFile = resolveSetiFileIcon(options?.treeLeafName ?? file.filename)
                return (
                  <div
                    key={fileKey}
                    className={`git-diff-file-item ${options ? 'tree-leaf ' : ''}${isSelected ? 'selected' : ''}`}
                    style={options ? { paddingLeft: `${12 + depth * 14}px` } : undefined}
                    onClick={() => handleFileSelect(file)}
                    onContextMenu={(e) => handleFileContextMenu(e, file)}
                  >
                    {options && <span className="git-diff-tree-spacer" />}
                    {options && (
                      <span
                        className="git-diff-tree-icon file git-diff-tree-seti-icon"
                        style={{ color: setiFile.color }}
                        // eslint-disable-next-line react/no-danger -- SVG from MIT seti-icons (VS Code Seti family); sanitized with DOMPurify
                        dangerouslySetInnerHTML={{ __html: sanitizeSetiSvgOnce(setiFile.svg) }}
                      />
                    )}
                    <span
                      className="git-diff-file-status"
                      style={{ color: statusColors[file.status] }}
                      title={statusText[file.status]}
                    >
                      {file.status}
                    </span>
                    {file.isSubmoduleEntry && (
                      <span
                        className="git-diff-submodule-badge"
                        title={t('gitDiff.status.submodule')}
                      >
                        S
                      </span>
                    )}
                    <span
                      className="git-diff-file-name"
                      title={file.originalFilename && (file.status === 'R' || file.status === 'C')
                        ? `${file.originalFilename} → ${file.filename}`
                        : file.filename}
                    >
                    {options?.treeLeafName ?? file.filename}
                    </span>
                    {isDirty && (
                      <span className="git-diff-file-dirty">{t('gitDiff.unsaved')}</span>
                    )}
                    <span className="git-diff-file-stats">
                      {file.additions > 0 && (
                        <span className="git-diff-stat-add">+{file.additions}</span>
                      )}
                      {file.deletions > 0 && (
                        <span className="git-diff-stat-del">-{file.deletions}</span>
                      )}
                    </span>
                  </div>
                )
              }
              const renderTreeNode = (node: DiffFileTreeNode, depth: number): JSX.Element => {
                if (node.type === 'file' && node.file) {
                  return renderFileItem(node.file, { depth, treeLeafName: node.name }) as JSX.Element
                }
                const isCollapsed = collapsedDiffTreeDirs.has(node.key)
                const isExpanded = !isCollapsed
                return (
                  <div key={node.key} className="git-diff-tree-node">
                    <div
                      className="git-diff-tree-item dir"
                      style={{ paddingLeft: `${12 + depth * 14}px` }}
                      onClick={() => {
                        setCollapsedDiffTreeDirs((prev) => {
                          const next = new Set(prev)
                          if (next.has(node.key)) next.delete(node.key)
                          else next.add(node.key)
                          return next
                        })
                      }}
                    >
                      <span className={`git-diff-tree-toggle ${isExpanded ? 'open' : ''}`}>
                        <svg viewBox="0 0 10 10" fill="currentColor" aria-hidden={true}>
                          <path d="M2 3.5L5 6.5L8 3.5" stroke="currentColor" strokeWidth="1.5" fill="none" strokeLinecap="round" strokeLinejoin="round" />
                        </svg>
                      </span>
                      <span className="git-diff-tree-icon dir">
                        <svg viewBox="0 0 16 16" fill="currentColor" aria-hidden={true}>
                          <path d="M1.75 3a.75.75 0 0 0-.75.75v8.5c0 .414.336.75.75.75h12.5a.75.75 0 0 0 .75-.75V5.5a.75.75 0 0 0-.75-.75H7.5a.75.75 0 0 1-.53-.22l-.97-.97A.75.75 0 0 0 5.47 3H1.75Z" />
                        </svg>
                      </span>
                      <span className="git-diff-tree-name" title={node.path}>{node.name}</span>
                      <span className="git-diff-tree-count">{node.count}</span>
                    </div>
                    {isExpanded && node.children?.map((child) => renderTreeNode(child, depth + 1))}
                  </div>
                )
              }
              const renderGroup = (group: { key: string; label: string; files: GitFileStatus[] }) => (
                <div key={group.key} className="git-diff-file-group">
                  <div className="git-diff-file-group-title">
                    {group.label} ({group.files.length})
                  </div>
                  {fileListViewMode === 'tree'
                    ? buildDiffFileTree(group.files, `${diffResult.cwd || activeCwd || ''}::${group.key}`).map((node) => renderTreeNode(node, 0))
                    : group.files.map((file) => renderFileItem(file))}
                </div>
              )
              if (repoSections) {
                return repoSections.map((section) => (
                  <div key={section.repoRoot} className="git-diff-repo-section">
                    <div className="git-diff-repo-header" title={section.repoRoot}>
                      <span className="git-diff-repo-name">{section.repoLabel}</span>
                      <span className="git-diff-repo-count">{section.totalCount}</span>
                    </div>
                    {section.groups.map((group) => (
                      <div key={group.key} className="git-diff-file-group">
                        <div className="git-diff-file-group-title">
                          {group.label} ({group.files.length})
                        </div>
                        {fileListViewMode === 'tree'
                          ? buildDiffFileTree(group.files, `${section.repoRoot}::${group.key}`).map((node) => renderTreeNode(node, 0))
                          : group.files.map((file) => renderFileItem(file))}
                      </div>
                    ))}
                  </div>
                ))
              }
              return groupedFileList.map(renderGroup)
            })()}
          </div>

          {/* Width adjustment drag bar */}
          <div
            className="git-diff-resizer"
            onMouseDown={handleResizeMouseDown}
          />
        </div>

        {/* Diff content */}
        <div className="git-diff-detail">
          {renderDiffDetail()}
        </div>
      </div>
    )
  }

  // Top-row header actions (next to the diff title): just the Terms info
  // popover and an optional Return-to-Terminal close button. Diff-session
  // actions (split mode, hunk navigation, jump-to-editor, refresh) live in
  // the working-directory bar instead — see renderCwdBarActions.
  const renderTopHeaderActions = useCallback((includeClose: boolean) => (
    <>
      <div className="git-diff-terms-help">
        <SubpagePanelButton
          className="git-diff-terms-button"
          onClick={() => setTermsPopoverOpen((prev) => !prev)}
          title={t('gitDiff.terms.buttonTitle')}
          aria-expanded={termsPopoverOpen}
        >
          <InfoActionIcon />
          <span>{t('gitDiff.terms.button')}</span>
        </SubpagePanelButton>
        {termsPopoverOpen && (
          <div className="git-diff-terms-popover" role="dialog" aria-label={t('gitDiff.terms.title')}>
            <div className="git-diff-terms-title">{t('gitDiff.terms.title')}</div>
            <dl>
              <dt>{t('gitDiff.terms.changes.title')}</dt>
              <dd>{t('gitDiff.terms.changes.description')}</dd>
              <dt>{t('gitDiff.terms.staged.title')}</dt>
              <dd>{t('gitDiff.terms.staged.description')}</dd>
              <dt>{t('gitDiff.terms.untracked.title')}</dt>
              <dd>{t('gitDiff.terms.untracked.description')}</dd>
              <dt>{t('gitDiff.terms.uncommitted.title')}</dt>
              <dd>{t('gitDiff.terms.uncommitted.description')}</dd>
            </dl>
          </div>
        )}
      </div>
      {includeClose && (
        <SubpagePanelButton className="git-diff-close" onClick={requestClose} title={t('gitDiff.returnToTerminal')}>
          {t('gitDiff.returnToTerminal')}
        </SubpagePanelButton>
      )}
    </>
  ), [requestClose, t, termsPopoverOpen])

  // Working-directory bar action cluster: view-mode toggle, hunk navigation,
  // jump-to-editor, refresh-changes. These are diff-session actions (apply
  // to the whole diff, not a specific file) so they live alongside the cwd
  // path rather than in either the top title bar or the per-file detail row.
  const renderCwdBarActions = useCallback(() => (
    <>
      {canShowSplitModeToggle && (
        <div
          className="git-diff-split-mode-toggle"
          role="group"
          aria-label={t('gitDiff.viewMode.label')}
          data-testid="git-diff-split-mode-toggle"
        >
          <button
            type="button"
            className={`git-diff-split-mode-button${splitViewMode === 'auto' ? ' active' : ''}`}
            onClick={() => setSplitViewMode('auto')}
            aria-pressed={splitViewMode === 'auto'}
            title={t('gitDiff.viewMode.autoTitle')}
            data-mode="auto"
          >
            {t('gitDiff.viewMode.auto')}
          </button>
          <button
            type="button"
            className={`git-diff-split-mode-button${splitViewMode === 'split' ? ' active' : ''}`}
            onClick={() => setSplitViewMode('split')}
            aria-pressed={splitViewMode === 'split'}
            title={t('gitDiff.viewMode.splitTitle')}
            data-mode="split"
          >
            {t('gitDiff.viewMode.split')}
          </button>
          <button
            type="button"
            className={`git-diff-split-mode-button${splitViewMode === 'inline' ? ' active' : ''}`}
            onClick={() => setSplitViewMode('inline')}
            aria-pressed={splitViewMode === 'inline'}
            title={t('gitDiff.viewMode.inlineTitle')}
            data-mode="inline"
          >
            {t('gitDiff.viewMode.inline')}
          </button>
        </div>
      )}
      <div className="git-diff-change-nav" aria-label={t('gitDiff.nav.changeNavigation')}>
        <SubpagePanelButton
          className="git-diff-nav-button"
          onClick={() => navigateDiffChange('previous')}
          title={t('gitDiff.nav.previousChange')}
          aria-label={t('gitDiff.nav.previousChange')}
        >
          <span aria-hidden="true">↑</span>
        </SubpagePanelButton>
        <SubpagePanelButton
          className="git-diff-nav-button"
          onClick={() => navigateDiffChange('next')}
          title={t('gitDiff.nav.nextChange')}
          aria-label={t('gitDiff.nav.nextChange')}
        >
          <span aria-hidden="true">↓</span>
        </SubpagePanelButton>
      </div>
	      <SubpagePanelButton
	        className="git-diff-jump-editor"
	        data-testid="git-diff-jump-editor"
	        data-jump-status={jumpToEditorStatus}
	        data-jump-file={jumpToEditorTarget?.filePath ?? ''}
	        data-jump-root={jumpToEditorTarget?.repoRoot ?? ''}
	        data-jump-change-type={selectedFile?.changeType ?? ''}
	        onClick={handleOpenEditor}
	        disabled={Boolean(jumpToEditorDisabledReason)}
        title={jumpToEditorDisabledReason ?? t('gitDiff.jumpToEditorTitle')}
      >
        <JumpToEditorIcon />
        <span>{t('gitDiff.jumpToEditor')}</span>
      </SubpagePanelButton>
      <SubpagePanelButton
        className="git-diff-refresh-changes"
        onClick={() => {
          void refreshChanges()
        }}
        disabled={isRefreshingChanges || cwdPending}
        title={t('gitDiff.refreshChangesTitle')}
      >
        <RefreshActionIcon />
        <span>{isRefreshingChanges ? t('gitDiff.refreshingChanges') : t('gitDiff.refreshChanges')}</span>
      </SubpagePanelButton>
    </>
  ), [
    canShowSplitModeToggle,
    cwdPending,
    handleOpenEditor,
    isRefreshingChanges,
    jumpToEditorStatus,
    jumpToEditorTarget,
    jumpToEditorDisabledReason,
    navigateDiffChange,
    refreshChanges,
    setSplitViewMode,
    splitViewMode,
    t
  ])

  const overlayClassName = `git-diff-overlay ${isPanel ? 'panel' : ''}`
  const modalClassName = `git-diff-modal ${isPanel ? 'panel' : ''}`
  const modalStyle = isPanel ? { width: '100%', height: '100%' } : { width: modalSize.width, height: modalSize.height }
  const displayedCwd = diffResult?.cwd || (!cwdPending ? cwd : null)
  const displayedWorkingDirectory = displayedCwd && (!diffResult || diffResult.isGitRepo) ? displayedCwd : null
  const useSharedPanelHeader = isPanel && panelShellMode === 'internal'
  const keepMountedInPanel = isPanel
  const {
    title: cwdTitle,
    onDoubleClick: handleCwdDblClick,
    feedback: cwdFeedback
  } = useCwdCopyHandler(displayedWorkingDirectory, t, 'gitDiff.copyFailed')
  const externalPanelActions = useMemo(() => renderTopHeaderActions(true), [renderTopHeaderActions])
  const externalPanelMetaExtra = useMemo(() => renderCwdBarActions(), [renderCwdBarActions])
  const externalPanelShellState = useMemo<SubpagePanelShellState>(() => ({
    current: 'diff',
    onSelect: handleSelectSubpage,
    lifecycle: {
      beforeLeave: () => {
        subpageSnapshotRestoreEpochRef.current += 1
        persistCurrentDiffSplitRatio()
        const liveFile = selectedFileRef.current
        const liveSelection = buildGitDiffSelectionSnapshot(activeCwd || '', liveFile)
        captureDiffView(liveSelection.selectedFileKey)
        const modifiedEditor = diffEditorRef.current?.getModifiedEditor() ?? null
        const liveFileKey = liveFile ? getFileKey(liveFile) : null
        const liveFileState = liveFileKey ? fileContentsRef.current[liveFileKey] : null
        const hasCurrentTextModel = Boolean(
          liveFile
          && liveFileState
          && !liveFileState.loading
          && !liveFileState.isBinary
          && modifiedEditor?.getModel()?.uri.toString()
            === buildGitDiffModelPath(liveFile, activeCwd, 'modified')
        )
        return {
          subpage: 'diff',
          ...liveSelection,
          scrollTop: hasCurrentTextModel ? modifiedEditor?.getScrollTop() ?? null : null,
          splitRatio: diffSplitRatioRef.current
        }
      },
      afterEnter: async (context) => {
        // Restore the previously selected file ONLY when re-entering via a
        // subpage switch (TerminalGrid passes the saved DiffSubpageSnapshot as
        // restoredSnapshot; a fresh open passes null → stays blank, GDS-31). The
        // open path suppresses auto-restore (openingFromClosed), so this explicit
        // select overrides the blank for the switch-back case (SN-07 / CDP-06).
        const restoreEpoch = ++subpageSnapshotRestoreEpochRef.current
        const snap = context.restoredSnapshot
        const wantedPath = snap?.subpage === 'diff' ? snap.selectedFilePath : null
        const wantedKey = snap?.subpage === 'diff' ? snap.selectedFileKey : null
        const wantedScrollTop = snap?.subpage === 'diff' ? snap.scrollTop : null
        if (!wantedPath) {
          perfTrace(PERF_TRACE_EVENT.RENDERER_GIT_DIFF_SUBPAGE_RESTORE, {
            terminalId, hadSnapshot: Boolean(snap), restoredFile: null,
            fileFoundInList: false, fileCount: diffResultRef.current?.files?.length ?? 0
          })
          return
        }
        // The diff list may still be loading when the switch completes; poll
        // briefly for the file to appear, then select it.
        const deadline = Date.now() + COLD_DIFF_RESTORE_BUDGET_MS
        let target: GitFileStatus | null = null
        for (;;) {
          if (
            subpageSnapshotRestoreEpochRef.current !== restoreEpoch
            || !isOpenRef.current
          ) {
            return
          }
          const files = diffResultRef.current?.files ?? []
          const repoRoot = diffResultRef.current?.cwd || activeCwd || ''
          target = resolveGitDiffSnapshotSelection(files, repoRoot, {
            selectedFilePath: wantedPath,
            selectedFileKey: wantedKey
          })
          if (target || Date.now() >= deadline) break
          await new Promise((resolve) => window.setTimeout(resolve, 80))
        }
        let snapshotScrollRestored = false
        if (target) {
          const targetKey = getFileKey(target)
          const memory = getMemoryStore()
          const snapshotScrollMerged = memory
            ? mergeGitDiffSnapshotScroll(memory, target, targetKey, wantedScrollTop)
            : false
          if (snapshotScrollMerged) {
            diffRestoreAppliedRef.current = {
              cycle: diffRestoreCycleRef.current,
              fileKey: null
            }
          }
          handleFileSelect(target)
          if (snapshotScrollMerged) {
            snapshotScrollRestored = await restoreSubpageSnapshotScroll(
              target,
              targetKey,
              wantedScrollTop,
              restoreEpoch
            )
          }
        }
        perfTrace(PERF_TRACE_EVENT.RENDERER_GIT_DIFF_SUBPAGE_RESTORE, {
          terminalId, hadSnapshot: true, restoredFile: wantedPath,
          fileFoundInList: Boolean(target),
          snapshotScrollRestored,
          fileCount: diffResultRef.current?.files?.length ?? 0
        })
      }
    },
    workingDirectoryLabel: t('gitDiff.workingDirectory'),
    workingDirectoryPath: displayedWorkingDirectory,
    workingDirectoryTitle: cwdTitle,
    onWorkingDirectoryDoubleClick: handleCwdDblClick,
    workingDirectoryFeedback: cwdFeedback,
    actions: externalPanelActions,
    metaExtra: externalPanelMetaExtra,
    taskTitle
  }), [
    activeCwd,
    captureDiffView,
    cwdFeedback,
    cwdTitle,
    displayedWorkingDirectory,
    externalPanelActions,
    externalPanelMetaExtra,
    handleCwdDblClick,
    handleFileSelect,
    handleSelectSubpage,
    getFileKey,
    getMemoryStore,
    persistCurrentDiffSplitRatio,
    restoreSubpageSnapshotScroll,
    selectedFileKey,
    t,
    taskTitle,
    terminalId
  ])

  useLayoutEffect(() => {
    if (!isPanel || panelShellMode !== 'external' || !onPanelShellStateChange) return
    if (!isOpen) {
      onPanelShellStateChange(null)
      return
    }
    onPanelShellStateChange(externalPanelShellState)
    return () => {
      onPanelShellStateChange(null)
    }
  }, [
    externalPanelShellState,
    isOpen,
    isPanel,
    onPanelShellStateChange,
    panelShellMode
  ])

  if (!isOpen && !keepMountedInPanel) return null

  return (
    <div
      className={`${overlayClassName} ${isOpen ? 'is-open' : 'is-hidden'}`}
      aria-hidden={!isOpen}
    >
      <div
        className={modalClassName}
        style={modalStyle}
        onClick={(e) => e.stopPropagation()}
      >
        {!isPanel && (
          <>
            {/* Pop-up window size adjustment handle */}
            <div className="git-diff-modal-resize-n" onMouseDown={(e) => handleModalResizeMouseDown(e, 'n')} />
            <div className="git-diff-modal-resize-s" onMouseDown={(e) => handleModalResizeMouseDown(e, 's')} />
            <div className="git-diff-modal-resize-e" onMouseDown={(e) => handleModalResizeMouseDown(e, 'e')} />
            <div className="git-diff-modal-resize-w" onMouseDown={(e) => handleModalResizeMouseDown(e, 'w')} />
            <div className="git-diff-modal-resize-ne" onMouseDown={(e) => handleModalResizeMouseDown(e, 'ne')} />
            <div className="git-diff-modal-resize-nw" onMouseDown={(e) => handleModalResizeMouseDown(e, 'nw')} />
            <div className="git-diff-modal-resize-se" onMouseDown={(e) => handleModalResizeMouseDown(e, 'se')} />
            <div className="git-diff-modal-resize-sw" onMouseDown={(e) => handleModalResizeMouseDown(e, 'sw')} />
          </>
        )}

        {(() => {
          const debugPanel = gitDiffPerformanceDiagnosticsEnabled ? (
            <GitDiffDebugPanel
              tracker={clickLatencyTrackerRef.current}
              cwd={activeCwd ?? ''}
              diffResult={diffResult}
              collapsed={debugPanelCollapsed}
              onToggleCollapsed={handleDebugPanelToggle}
            />
          ) : null
          return useSharedPanelHeader ? (
            <SubpagePanelShell
              current="diff"
              onSelect={handleSelectSubpage}
              workingDirectoryLabel={t('gitDiff.workingDirectory')}
              workingDirectoryPath={displayedWorkingDirectory}
              workingDirectoryTitle={cwdTitle}
              onWorkingDirectoryDoubleClick={handleCwdDblClick}
              workingDirectoryFeedback={cwdFeedback}
              taskTitle={taskTitle}
              actions={renderTopHeaderActions(true)}
              metaExtra={renderCwdBarActions()}
            >
              {debugPanel}
              <div className="git-diff-body">
                {renderContent()}
              </div>
            </SubpagePanelShell>
          ) : panelShellMode === 'external' && isPanel ? (
            <>
              {debugPanel}
              <div className="git-diff-body">
                {renderContent()}
              </div>
            </>
          ) : (
          <>
            {/* Header */}
            <div className="git-diff-header">
              <div className="git-diff-header-main">
                <h2 className="git-diff-title">
                  <span className="git-diff-title-main">{t('gitDiff.title')}</span>
                  {taskTitle ? (
                    <span className="git-diff-task-label subpage-task-source" title={taskTitle}>
                      <span className="subpage-task-source-name">{taskTitle}</span>
                    </span>
                  ) : null}
                </h2>
                <SubpageSwitcher current="diff" onSelect={handleSelectSubpage} />
              </div>
              <div className="git-diff-header-actions">
                {renderTopHeaderActions(true)}
              </div>
            </div>

            {/* working directory + diff-session actions */}
            <div
              className="git-diff-cwd-bar"
              onDoubleClick={displayedWorkingDirectory ? handleCwdDblClick : undefined}
              title={displayedWorkingDirectory ? cwdTitle : undefined}
            >
              {displayedWorkingDirectory ? (
                <>
                  <span className="git-diff-cwd-label">{t('gitDiff.workingDirectory')}</span>
                  <span className="git-diff-cwd-path">{displayedWorkingDirectory}</span>
                  {cwdFeedback}
                </>
              ) : <span className="git-diff-cwd-path" />}
              <div className="git-diff-cwd-bar-actions">
                {renderCwdBarActions()}
              </div>
            </div>

            {/* Performance diagnostics panel (global opt-in setting) */}
            {debugPanel}

            {/* Body */}
            <div className="git-diff-body">
              {renderContent()}
            </div>
          </>
          )
        })()}

        {largeFileConfirmState && (
          <LargeFileConfirmDialog
            title={t('gitDiff.largeFile.confirmTitle')}
            message={t('gitDiff.largeFile.confirmMessage', { size: largeFileConfirmState.sizeLabel })}
            confirmText={t('gitDiff.largeFile.continue')}
            cancelText={t('common.cancel')}
            onConfirm={() => settleLargeFileConfirmation(true)}
            onCancel={() => settleLargeFileConfirmation(false)}
          />
        )}

        {/* right click menu */}
        {contextMenu && (
          <div
            ref={contextMenuElRef}
            className="git-diff-context-menu"
            style={{
              position: 'fixed',
              left: contextMenuPosition?.x ?? contextMenu.x,
              top: contextMenuPosition?.y ?? contextMenu.y
            }}
            onMouseDown={(e) => e.stopPropagation()}
          >
            <button
              className="git-diff-context-item"
              onClick={() => void copyContextMenuPath(contextMenu.targetFile, 'name')}
            >
              <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M2.5 2a.5.5 0 0 0 0 1h11a.5.5 0 0 0 0-1h-11zM5 5.5a.5.5 0 0 1 .5-.5h5a.5.5 0 0 1 0 1H8.5v7a.5.5 0 0 1-1 0V6H5.5a.5.5 0 0 1-.5-.5z" /></svg>
              <span>{t('common.copyName')}</span>
            </button>
            <button
              className="git-diff-context-item"
              onClick={() => void copyContextMenuPath(contextMenu.targetFile, 'relative')}
            >
              <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M9 1H3.5A1.5 1.5 0 0 0 2 2.5v11A1.5 1.5 0 0 0 3.5 15h9a1.5 1.5 0 0 0 1.5-1.5V6h-4a1 1 0 0 1-1-1V1zm1 0v4h4L10 1z" /><circle cx="5" cy="11.5" r="1" /><path d="M7 10a.5.5 0 0 1 .354.146l2 2a.5.5 0 0 1-.708.708L7 11.207l-1.646 1.647a.5.5 0 0 1-.708-.708l2-2A.5.5 0 0 1 7 10z" /></svg>
              <span>{t('common.copyRelativePath')}</span>
            </button>
            <button
              className="git-diff-context-item"
              onClick={() => void copyContextMenuPath(contextMenu.targetFile, 'absolute')}
            >
              <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M9 1H3.5A1.5 1.5 0 0 0 2 2.5v11A1.5 1.5 0 0 0 3.5 15h9a1.5 1.5 0 0 0 1.5-1.5V6h-4a1 1 0 0 1-1-1V1zm1 0v4h4L10 1z" /><path d="M8.5 9a.5.5 0 0 0-.894-.447l-2 4a.5.5 0 1 0 .894.447l2-4z" /></svg>
              <span>{t('common.copyAbsolutePath')}</span>
            </button>
            <div className="git-diff-context-separator" />
            <button
              className="git-diff-context-item"
              data-testid="file-entry-open-default"
              disabled={fileEntryOsItemState(contextMenu.targetFile.status, entryOnDisk).disabled}
              onClick={() => {
                const file = contextMenu.targetFile
                closeContextMenu()
                void openWithDefaultApp(
                  'git-diff',
                  resolveEntryAbsolutePath(file.repoRoot || activeCwd, file.filename)
                )
              }}
            >
              <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path fillRule="evenodd" d="M8.636 3.5a.5.5 0 0 0-.5-.5H1.5A1.5 1.5 0 0 0 0 4.5v10A1.5 1.5 0 0 0 1.5 16h10a1.5 1.5 0 0 0 1.5-1.5V7.864a.5.5 0 0 0-1 0V14.5a.5.5 0 0 1-.5.5h-10a.5.5 0 0 1-.5-.5v-10a.5.5 0 0 1 .5-.5h6.636a.5.5 0 0 0 .5-.5z" /><path fillRule="evenodd" d="M16 .5a.5.5 0 0 0-.5-.5h-5a.5.5 0 0 0 0 1h3.793L6.146 9.146a.5.5 0 1 0 .708.708L15 1.707V5.5a.5.5 0 0 0 1 0v-5z" /></svg>
              <span>{t('common.openWithDefaultApp')}</span>
            </button>
            <button
              className="git-diff-context-item"
              data-testid="file-entry-reveal"
              disabled={fileEntryOsItemState(contextMenu.targetFile.status, entryOnDisk).disabled}
              onClick={() => {
                const file = contextMenu.targetFile
                closeContextMenu()
                void revealInFileManager(
                  'git-diff',
                  resolveEntryAbsolutePath(file.repoRoot || activeCwd, file.filename)
                )
              }}
            >
              <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M1 3.5A1.5 1.5 0 0 1 2.5 2h2.764c.958 0 1.76.56 2.311 1.184C7.985 3.648 8.48 4 9 4h4.5A1.5 1.5 0 0 1 15 5.5v.64c.57.265.94.876.856 1.546l-.64 5.124A2.5 2.5 0 0 1 12.733 15H3.266a2.5 2.5 0 0 1-2.481-2.19l-.64-5.124A1.5 1.5 0 0 1 1 6.14V3.5zM2 6h12v-.5a.5.5 0 0 0-.5-.5H9c-.964 0-1.71-.629-2.174-1.154C6.374 3.334 5.82 3 5.264 3H2.5a.5.5 0 0 0-.5.5V6zm-.367 1a.5.5 0 0 0-.496.562l.64 5.124A1.5 1.5 0 0 0 3.266 14h9.468a1.5 1.5 0 0 0 1.489-1.314l.64-5.124A.5.5 0 0 0 14.367 7H1.633z" /></svg>
              <span>{revealLabel}</span>
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
