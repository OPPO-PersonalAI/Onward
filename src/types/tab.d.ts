/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Prompt } from './electron.d.ts'
import type { LayoutMode, CustomLayoutPreset } from './prompt'

/**
 * Timing type
 */
export type ScheduleType = 'absolute' | 'relative' | 'recurring'

/**
 * Period configuration
 */
export interface RecurrenceConfig {
  /** Starting timestamp (milliseconds) */
  startTime: number
  /** Interval in milliseconds (minimum 60000 = 1 minute) */
  intervalMs: number
}

/**
 * Scheduled task execution log entries
 */
export interface ExecutionLogEntry {
  /** Execution timestamp */
  timestamp: number
  /** Is it successful? */
  success: boolean
  /** Target terminal ID */
  targetTerminalIds: string[]
  /** Error message (on failure) */
  error?: string | null
}

/**
 * Prompt scheduled task
 */
export interface PromptSchedule {
  /** Associated Prompt ID */
  promptId: string
  /** Owning Tab ID */
  tabId: string
  /** Target endpoint ID list */
  targetTerminalIds: string[]
  /** Timing type */
  scheduleType: ScheduleType
  /** Absolute timestamp (absolute mode) */
  absoluteTime?: number
  /** Relative delay in milliseconds (relative mode) */
  relativeOffsetMs?: number
  /** Period configuration (recurring mode) */
  recurrence?: RecurrenceConfig
  /** Maximum number of executions, null=unlimited (only recurring is meaningful) */
  maxExecutions: number | null
  /** Executed times */
  executedCount: number
  /** Next execution timestamp */
  nextExecutionAt: number
  /** Create timestamp */
  createdAt: number
  /** Last execution timestamp */
  lastExecutedAt: number | null
  /** Schedule status */
  status: 'active' | 'paused' | 'completed' | 'failed'
  /** Latest error message */
  lastError?: string | null
  /** Missed executions */
  missedExecutions: number
  /** Execution history (last 50 entries) */
  executionLog?: ExecutionLogEntry[]
}

/**
 * Editor draft
 */
export interface EditorDraft {
  title: string
  content: string
  height: number
  savedAt: number
}

/**
 * Persisted terminal state
 */
export interface PersistedTerminalState {
  id: string
  customName: string | null
  /**
   * Repo root recorded at the moment customName was last set by a user-driven
   * action. Used by auto-follow to decide whether the manual name is still
   * "in scope" for the current cwd. Null means no active manual override.
   */
  manualNameRepoRoot: string | null
  lastCwd: string | null
}

/**
 * Per-file view state memory (persisted inside ProjectEditorState.fileStates)
 */
export interface FileViewMemory {
  editorViewState?: unknown
  cursorLine?: number
  cursorColumn?: number
  previewScrollAnchor?: { slug: string | null; ratio: number; headingOffsetY?: number; scrollTop?: number }
  outlineScrollTop?: number
  // Markdown-specific per-file view mode
  isPreviewOpen?: boolean
  isEditorVisible?: boolean
  outlineTarget?: 'editor' | 'preview'
  // EPUB-specific reader preferences, scoped per file
  epubFontPct?: number
  epubLocation?: string | null
  // Precise pixel offset inside the EPUB scroll container. The CFI in
  // epubLocation only identifies the chapter / section; this captures the
  // scroll offset inside the rendered flow so restore is pixel-accurate.
  epubScrollTop?: number
  // PDF-specific: where the user last scrolled to, so reopening the same PDF
  // lands on the same page / scroll offset.
  pdfPageNumber?: number
  pdfScrollTop?: number
  pdfScale?: string
  // HTML-preview scroll offset inside the embedded browser view (aligned with
  // the PDF / EPUB fields above) so reopening the same HTML file restores the
  // reading position instead of jumping back to the top.
  htmlScrollX?: number
  htmlScrollY?: number
}

/**
 * Project editor state (persistent by terminal + working directory)
 */
export interface ProjectEditorState {
  rootPath: string | null
  activeFilePath: string | null
  expandedDirs: string[]
  pinnedFiles?: string[]
  recentFiles?: string[]
  editorViewState?: unknown
  cursorLine?: number
  cursorColumn?: number
  savedAt: number
  // UI layout state (per-scope persistence)
  isPreviewOpen?: boolean
  isEditorVisible?: boolean
  isOutlineVisible?: boolean
  outlineTarget?: 'editor' | 'preview'
  fileTreeWidth?: number
  previewWidth?: number
  outlineWidth?: number
  modalWidth?: number
  modalHeight?: number
  // Scroll position memory
  previewScrollAnchor?: { slug: string | null; ratio: number; headingOffsetY?: number; scrollTop?: number }
  fileTreeScrollTop?: number
  outlineScrollTop?: number
  // Per-file state memory (keyed by normalized file path)
  fileStates?: Record<string, FileViewMemory>
  outlineScrollByFile?: Record<string, number>
}

/**
 * Prompt cleanup configuration
 */
export interface PromptCleanupConfig {
  /** Whether to enable automatic cleaning */
  autoEnabled: boolean
  /** Automatic cleaning retention days */
  autoKeepDays: number
  /** Whether to delete color annotations during automatic cleaning */
  autoDeleteColored: boolean
  /** Last automatic cleaning timestamp */
  lastAutoCleanupAt: number | null
}

/**
 * Local Prompt (independent for each Tab)
 */
export interface LocalPrompt extends Prompt {
  pinned: false
}

/**
 * Global Prompt (shared by all Tabs, pinned state)
 */
export interface GlobalPrompt extends Prompt {
  pinned: true
}

/**
 * Tab state
 */
export interface TabState {
  /** Tab unique identifier */
  id: string
  /** User-defined name part (without "Tab N:" prefix) */
  customName: string | null
  /** Create timestamp */
  createdAt: number
  /** layout mode (preset 1/2/4/6/8 or a custom preset reference) */
  layoutMode: LayoutMode
  /** Currently active panel */
  activePanel: 'prompt' | null
  /** Prompt panel width */
  promptPanelWidth: number
  /** Prompt editor height */
  promptEditorHeight: number
  /** Current active terminal ID */
  activeTerminalId: string | null
  /** List of terminals for this Tab */
  terminals: PersistedTerminalState[]
  /** The local Prompt of this Tab (not pinned) */
  localPrompts: LocalPrompt[]
  /** Editor draft (auto-save) */
  editorDraft?: EditorDraft
  /** Last active subpage so it can be restored after restart */
  activeSubpage?: 'diff' | 'editor' | 'history' | null
  /** Terminal that owns the active subpage (used for correct CWD on restore) */
  subpageTerminalId?: string | null
  /** Deprecated: prompt input mode now lives in uiPreferences.promptInputMode. */
  promptInputMode?: 'canvas' | 'line'
  /** Deprecated migration marker for legacy per-Tab prompt input mode. */
  promptInputModePreferenceVersion?: number
}

/**
 * Global UI preferences persisted across restarts and upgrades.
 * Migrated from localStorage to ensure reliable state recovery.
 */
export interface UIPreferences {
  /** Global Prompt input mode shared by every Tab. Defaults to 'line'. */
  promptInputMode?: 'canvas' | 'line'
  // Project Editor
  projectEditorFileTreeWidth?: number
  projectEditorFileBrowserCollapsed?: boolean
  projectEditorModalSize?: { width: number; height: number }
  projectEditorMarkdownPreviewWidth?: number
  projectEditorHtmlPreviewZoomFactor?: number
  projectEditorMarkdownEditorVisible?: boolean
  projectEditorOutlineVisible?: boolean
  projectEditorOutlineWidth?: number
  projectEditorOutlineTarget?: 'editor' | 'preview'
  // Git Diff Viewer
  gitDiffFileListWidth?: number
  gitDiffFileListViewMode?: 'tree' | 'flat'
  gitDiffModalSize?: { width: number; height: number }
  gitDiffSplitViewRatio?: number
  gitDiffImageDisplayMode?: string
  gitDiffImageCompareMode?: string
  // Git History Viewer
  gitHistoryFileListWidth?: number
  gitHistoryHideWhitespace?: boolean
  gitHistoryDiffStyle?: 'side-by-side' | 'inline' | 'split' | 'unified'
  gitHistorySummaryHeight?: number
  gitHistoryStates?: Record<string, unknown>
}

/**
 * Application state
 */
export interface AppState {
  /** Currently active Tab ID */
  activeTabId: string
  /** All tab lists */
  tabs: TabState[]
  /** Global Prompt (pinned, shared by all Tabs) */
  globalPrompts: GlobalPrompt[]
  /** Prompt cleanup configuration */
  promptCleanup: PromptCleanupConfig
  /** Last focused terminal ID (used to restore focus on wakeup) */
  lastFocusedTerminalId: string | null
  /** Project editor state (stored by terminal + working directory) */
  projectEditorStates: Record<string, ProjectEditorState>
  /** Prompt scheduled task list */
  promptSchedules: PromptSchedule[]
  /** Global UI preferences (panel widths, viewer settings, etc.) */
  uiPreferences: UIPreferences
  /** Globally shared custom layout presets (referenced by TabState.layoutMode when kind === 'custom'). */
  customLayoutPresets: CustomLayoutPreset[]
  /** Last updated timestamp */
  updatedAt: number
}

/**
 * Get Tab display name
 * @param tab Tab state
 * @param index Tab index in the array (0-based)
 * @returns Formatted display name, such as "Tab 1" or "Tab 1: Feature Development"
 */
export function getTabDisplayName(tab: TabState, index: number): string

/**
 * Get terminal display name
 * @param index The index of the terminal in the current Tab (0-based)
 * @param customName User-defined name
 * @returns Formatted display name, such as "Task 1" or "Task 1: Development Task"
 */
export function getTerminalDisplayName(index: number, customName: string | null): string

/**
 * Create default tab state
 */
export function createDefaultTabState(id: string): TabState

/**
 * Create default app state
 */
export function createDefaultAppState(): AppState
