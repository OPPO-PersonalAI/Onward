/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

import type { FileViewMemory, ProjectEditorState } from '../../types/tab.d.ts'
import { DEFAULT_LOCALE, translate, type AppLocale } from '../../i18n/core.ts'

export function normalizeProjectEditorRootPath(value: string): string {
  return value.replace(/\\/g, '/')
}

export function resolveStoredProjectEditorState(
  rootPath: string,
  terminalStored: ProjectEditorState | null,
  rootScopedStored: ProjectEditorState | null,
  platform: string = ''
): ProjectEditorState | null {
  // win32 paths are case-insensitive; a legacy-adopted entry may differ from
  // the resolved repo root only by drive-letter / path case.
  const fold = (value: string): string => (platform === 'win32' ? value.toLowerCase() : value)
  const normalizedRootPath = fold(normalizeProjectEditorRootPath(rootPath))
  if (rootScopedStored) {
    return rootScopedStored
  }
  if (!terminalStored) return null
  if (!terminalStored.rootPath) return terminalStored
  return fold(normalizeProjectEditorRootPath(terminalStored.rootPath)) === normalizedRootPath
    ? terminalStored
    : null
}

/**
 * Cross-Task contamination guard: an active file may only be persisted into a
 * scope's state when it was opened under that scope. The single shared
 * ProjectEditor instance can still be displaying scope X's file while scope Y
 * persists (same-root Task switch with no stored state for Y) — persisting
 * X's file under Y's key would corrupt Y's memory.
 */
export function resolvePersistableActiveFile(args: {
  activeFilePath: string | null
  activeFileScopeKey: string | null
  persistScopeKey: string | null
}): string | null {
  if (!args.activeFilePath) return null
  if (!args.persistScopeKey) return null
  if (!args.activeFileScopeKey) return null
  return args.activeFileScopeKey === args.persistScopeKey ? args.activeFilePath : null
}

export function buildPendingCursor(
  cursorLine: number | undefined,
  cursorColumn: number | undefined
): { lineNumber: number; column: number } | null {
  if (typeof cursorLine !== 'number') return null
  return {
    lineNumber: cursorLine,
    column: typeof cursorColumn === 'number' ? cursorColumn : 1
  }
}

export function buildLegacyFileMemoryEntry(state: ProjectEditorState | null): FileViewMemory | null {
  if (!state?.activeFilePath) return null

  const entry: FileViewMemory = {}
  if (state.editorViewState !== undefined) entry.editorViewState = state.editorViewState
  if (typeof state.cursorLine === 'number') entry.cursorLine = state.cursorLine
  if (typeof state.cursorColumn === 'number') entry.cursorColumn = state.cursorColumn
  if (state.previewScrollAnchor) entry.previewScrollAnchor = state.previewScrollAnchor
  if (typeof state.outlineScrollTop === 'number') entry.outlineScrollTop = state.outlineScrollTop
  if (typeof state.isPreviewOpen === 'boolean') entry.isPreviewOpen = state.isPreviewOpen
  if (typeof state.isEditorVisible === 'boolean') entry.isEditorVisible = state.isEditorVisible
  if (state.outlineTarget === 'editor' || state.outlineTarget === 'preview') {
    entry.outlineTarget = state.outlineTarget
  }

  return Object.keys(entry).length > 0 ? entry : null
}

export function shouldKeepPendingRestoreState(options: {
  source: 'user' | 'restore' | 'debug'
  path: string
  pendingPath: string | null
  hasPendingViewState: boolean
  hasPendingCursor: boolean
}): boolean {
  if (options.source !== 'restore') return false
  if (options.pendingPath !== options.path) return false
  return options.hasPendingViewState || options.hasPendingCursor
}

export function buildMissingFileNotice(
  path: string,
  source: 'user' | 'restore' | 'debug',
  locale: AppLocale = DEFAULT_LOCALE
): {
  notice: string
  status: string
} {
  if (source === 'restore') {
    return {
      notice: translate(locale, 'projectEditor.restore.previousFileDeletedNotice', { path }),
      status: translate(locale, 'projectEditor.restore.previousFileDeletedStatus')
    }
  }
  return {
    notice: translate(locale, 'projectEditor.restore.fileMissingNotice', { path }),
    status: translate(locale, 'projectEditor.restore.fileMissingStatus')
  }
}

export function clampCursorPosition(input: {
  lineNumber: number
  column: number
  lineCount: number
  getLineMaxColumn: (lineNumber: number) => number
}): { lineNumber: number; column: number } {
  const safeLineCount = Math.max(1, Math.floor(input.lineCount))
  const requestedLine = Number.isFinite(input.lineNumber) ? Math.floor(input.lineNumber) : 1
  const safeLine = Math.max(1, Math.min(safeLineCount, requestedLine))
  const maxColumn = Math.max(1, Math.floor(input.getLineMaxColumn(safeLine)))
  const requestedColumn = Number.isFinite(input.column) ? Math.floor(input.column) : 1
  const safeColumn = Math.max(1, Math.min(maxColumn, requestedColumn))
  return {
    lineNumber: safeLine,
    column: safeColumn
  }
}
