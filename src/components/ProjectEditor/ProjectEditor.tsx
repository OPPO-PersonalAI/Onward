/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal, flushSync } from 'react-dom'
import { Editor } from '@monaco-editor/react'
import DOMPurify from 'dompurify'
import { hexy } from 'hexy'
import type { GitDiffResult, ProjectEntry, ProjectFileOpenMode } from '../../types/electron'
import type { FileViewMemory, ProjectEditorState } from '../../types/tab.d.ts'
import { useSettings } from '../../contexts/SettingsContext'
import { useAppState } from '../../hooks/useAppState'
import { DEFAULT_GIT_DIFF_FONT_SIZE } from '../../constants/gitDiff'
import { useSubpageEscape } from '../../hooks/useSubpageEscape'
import { useI18n } from '../../i18n/useI18n'
import { perfTrace, perfTraceDiagnostic } from '../../utils/perf-trace'
import { PERF_TRACE_EVENT } from '../../utils/perf-trace-names'
import { shouldRetainProjectEditorViewOnClose } from './utils/projectEditorCloseRetention'
import { isPreviewWorkPending, shouldRevealSettledPreview } from './utils/previewRestoreSettle'
import { isMarkdownSessionCacheContentHit } from './utils/markdownSessionCachePeek'
import { shouldEnableMarkdownForOpen, shouldSelfHealMarkdownPreviewOpen, shouldPreserveRetainedPreviewDuringReopen, shouldTakeZeroFlashReopenPath, shouldRecoverPreviewOnReopenSameFile } from './utils/markdownPreviewSelfHeal'
import { runAllTests } from '../../autotest/autotest-runner'
import type { AutotestContext, CpuSummary, ProjectEditorDebugApi, TestResult } from '../../autotest/types'
import 'katex/dist/katex.min.css'
import {
  buildLegacyFileMemoryEntry,
  buildMissingFileNotice,
  buildPendingCursor,
  clampCursorPosition,
  resolvePersistableActiveFile,
  resolveStoredProjectEditorState,
  shouldKeepPendingRestoreState
} from './projectEditorRestoreUtils'
import { LruSnapshotStore, SOFT_CLOSE_SNAPSHOT_CAP } from './utils/softCloseSnapshotStore'
import { selectMarkdownSessionCacheEvictions } from './utils/markdownSessionCacheEviction'
import { SubpagePanelButton, SubpagePanelShell, SubpageSwitcher, type SubpagePanelShellState } from '../SubpageSwitcher'
import { OutlinePanel, type OutlineTarget } from './Outline/OutlinePanel'
import { countSymbols } from './Outline/outlineParser'
import { shouldCaptureOutlineScrollTop } from './Outline/outlineScrollRestore'
import { OutlineSymbolKind, type OutlineItem } from './Outline/types'
import { useOutlineSymbols } from './Outline/useOutlineSymbols'
import { SearchPanel } from './GlobalSearch/SearchPanel'
import {
  addFile as fileIndexAddFile,
  ensureIndex as fileIndexEnsure,
  getCacheStats as fileIndexGetCacheStats,
  getIndexSnapshot as fileIndexSnapshot,
  invalidate as fileIndexInvalidate,
  removeFile as fileIndexRemoveFile,
  renameFile as fileIndexRenameFile,
  subscribe as fileIndexSubscribe
} from './GlobalSearch/fileIndexCache'
import { initializeFileIndexCacheBridge } from './GlobalSearch/fileIndexCacheBootstrap'
import { PreviewSearchBar } from './PreviewSearch/PreviewSearchBar'
import type { PreviewSearchHandle } from './PreviewSearch/PreviewSearchBar'
import { SqliteViewer } from './SqliteViewer'
import { PdfReader, type PdfReaderHandle } from './PdfReader'
import { EpubReader, type EpubReaderHandle } from './EpubReader'
import { HtmlReader, type HtmlReaderState } from './HtmlReader'
import { HtmlPreviewSearchBar, type HtmlPreviewSearchResult } from './HtmlPreviewSearchBar'
import type { ProjectEditorOpenRequest, SubpageId, SubpageNavigateEventDetail } from '../../types/subpage'
import { usePathCopy } from '../../hooks/usePathCopy'
import { useCwdCopyHandler } from '../../hooks/useCwdCopyHandler'
import {
  deriveHtmlPreviewNavButtonState,
  formatHtmlPreviewZoomPercent,
  HTML_PREVIEW_DEFAULT_ZOOM_FACTOR,
  HTML_PREVIEW_MAX_ZOOM_FACTOR,
  HTML_PREVIEW_MIN_ZOOM_FACTOR,
  isHtmlPreviewRefreshShortcut,
  isHtmlPath,
  isSameHtmlPreviewDocument,
  normalizeHtmlPreviewScrollState,
  normalizeHtmlPreviewZoomFactor,
  stepHtmlPreviewZoomFactor,
  withHtmlPreviewReloadKey,
  type HtmlPreviewScrollState
} from '../../utils/html-file'
import '../../styles/path-copy-toast.css'
import { renderMermaidDiagrams } from '../../utils/mermaidRenderer'
import {
  enhanceMermaidDiagrams,
  disposeMermaidPanZoom,
  getMermaidPanZoomState,
  triggerMermaidPanZoomAction,
  simulateMermaidPan,
  isFullscreenActive as isMermaidFullscreenActive
} from '../../utils/mermaidPanZoom'
import {
  normalizeQuickFilePaths,
  prependRecentFile,
  replaceQuickFilePath,
  areQuickFileListsEqual,
  removeQuickFilePath,
  moveQuickFile,
  buildQuickFileLabels,
  decodeQuickFileDragPayload,
  getBaseName,
  getParentPath
} from './quickFileUtils'
import { createThemedSetiFileIconResolver, sanitizeSetiSvgOnce } from './setiFileIconTheme'
import {
  buildDiffReturnBarState,
  findDiffFileForEditorPath,
  resolveNavigationFilePath,
  type DiffJumpTarget
} from './diffJumpState'
import { performanceTrace } from '../../utils/performance-trace'
import './ProjectEditor.css'

initializeFileIndexCacheBridge()

interface ProjectEditorProps {
  isOpen: boolean
  terminalId: string | null
  cwd: string | null
  openRequest?: ProjectEditorOpenRequest | null
  onClose: () => void
  onDirtyChange?: (dirty: boolean) => void
  displayMode?: 'modal' | 'panel'
  panelShellMode?: 'internal' | 'external'
  onPanelShellStateChange?: (state: SubpagePanelShellState | null) => void
  taskTitle?: string
}

interface TreeNode {
  name: string
  path: string
  type: 'file' | 'dir'
  isExpanded?: boolean
  isLoading?: boolean
  children?: TreeNode[]
}

type DialogState =
  | {
    type: 'confirm'
    title: string
    message: string
    confirmText?: string
    cancelText?: string
  }
  | {
    type: 'prompt'
    title: string
    message: string
    placeholder?: string
    defaultValue?: string
    confirmText?: string
    cancelText?: string
  }

type ConfirmOptions = {
  title: string
  message: string
  confirmText?: string
  cancelText?: string
}

type FileOpenChoiceMode = 'text' | 'binary'

type FileOpenChoiceDialogState = {
  path: string
  extension: string
  extensionLabel: string
  sizeLabel: string
  remember: boolean
}

type FileOpenChoiceResult = {
  mode: FileOpenChoiceMode
  remember: boolean
} | null

type BinaryRadix = 2 | 8 | 10 | 16

type LargeFileState = {
  mode: 'large-text' | 'binary'
  path: string
  sizeBytes: number
  offset: number
  bytesRead: number
  text: string
  binaryBytes: Uint8Array
  loading: boolean
  error: string | null
}

type PromptOptions = {
  title: string
  message: string
  placeholder?: string
  defaultValue?: string
  confirmText?: string
  cancelText?: string
}

type ContextMenuState = {
  x: number
  y: number
  targetPath: string | null
  targetType: 'file' | 'dir' | null
  source: 'tree' | 'quick-recent' | 'quick-pin'
}

type SaveSource = 'toolbar' | 'global-shortcut' | 'editor-shortcut' | 'debug-toolbar'
type PreviewRestorePhase = 'idle' | 'waiting-html' | 'restoring-layout' | 'revealing'
type OpenMissingBehavior = 'retain-selection' | 'empty-state'
type OpenFileSource = 'user' | 'restore' | 'debug'
type MermaidPreviewState = {
  total: number
  rendered: number
  error: number
  pending: number
  inFlight: boolean
}
type OpenFileOptions = {
  trackRecent?: boolean
  cursorPosition?: { lineNumber: number; column?: number } | null
  missingBehavior?: OpenMissingBehavior
  forceReload?: boolean
  // Set by callers that originated inside the File Browser tree itself, to
  // skip the automatic "expand ancestors + center row" reveal that other
  // sources (Search, Pin, Recent, ...) trigger.
  suppressFileBrowserReveal?: boolean
}

const FILE_BROWSER_USER_SCROLL_PAUSE_MS = 3000
const FILE_BROWSER_PROGRAMMATIC_SCROLL_SETTLE_MS = 1000
// Grace period before the preview-reveal watchdog force-reveals a stuck
// 'waiting-html' phase. Must be safely longer than a normal reveal (a few ms,
// up to a few hundred under EDR) so it never fires on the happy path, yet well
// under the autotest's 12s observation window so a stranded reveal is recovered
// promptly (CDP-10 deep-link jump). See the watchdog effect for the failure mode.
const PREVIEW_REVEAL_WATCHDOG_MS = 1500
// Bounded post-reopen preview-scroll reconcile. After a markdown reopen restores
// the preview to the saved section, the editor re-mount / root reload can drive
// the preview back to the top via the preview<-editor sync. For this window the
// reconcile re-asserts the saved scroll (+ editor alignment) whenever it drifts,
// then stops once it holds (PMSR-10/11). The window is short so it never fights a
// genuine user scroll (which also updates the saved memory the reconcile reads).
const PREVIEW_SCROLL_RECONCILE_MS = 8000
const PREVIEW_SCROLL_RECONCILE_INTERVAL_MS = 200
const PREVIEW_SCROLL_RECONCILE_TOLERANCE = 80
// Interval for the render-recovery watchdog (re-issues a lost markdown render
// when the preview is stuck blank). First tick is one interval AFTER the HTML
// goes blank, so a normal render (which lands in a few ms) flips the gate before
// it fires. See the render-recovery effect for the cold-reopen failure mode.
const MARKDOWN_RENDER_RECOVERY_MS = 600

const STORAGE_KEY_FILE_TREE_WIDTH = 'project-editor-file-tree-width'
const STORAGE_KEY_FILE_BROWSER_COLLAPSED = 'project-editor-file-browser-collapsed'
const STORAGE_KEY_HTML_PREVIEW_ZOOM_FACTOR = 'project-editor-html-preview-zoom-factor'
const STORAGE_KEY_MODAL_SIZE = 'project-editor-modal-size'
const STORAGE_KEY_MARKDOWN_PREVIEW_RATIO = 'project-editor-markdown-preview-ratio'
const STORAGE_KEY_MARKDOWN_PREVIEW_WIDTH = 'project-editor-markdown-preview-width'
const STORAGE_KEY_MARKDOWN_EDITOR_VISIBLE = 'project-editor-markdown-editor-visible'
const STORAGE_KEY_MARKDOWN_CODE_WRAP = 'project-editor-markdown-code-wrap'
const STORAGE_KEY_MARKDOWN_SESSION_CACHE_LIMIT = 'project-editor-markdown-session-cache-limit'
const STORAGE_KEY_OUTLINE_VISIBLE = 'project-editor-outline-visible'
const STORAGE_KEY_OUTLINE_WIDTH = 'project-editor-outline-width'
const STORAGE_KEY_OUTLINE_TARGET = 'project-editor-outline-target'
const STORAGE_KEY_BINARY_OPEN_DEFAULTS = 'project-editor-binary-open-defaults'

const DEFAULT_FILE_TREE_WIDTH = 260
const MIN_FILE_TREE_WIDTH = 180
const MAX_FILE_TREE_WIDTH = 520

const DEFAULT_MODAL_WIDTH = 1200
const DEFAULT_MODAL_HEIGHT = 720
const MIN_MODAL_WIDTH = 720
const MIN_MODAL_HEIGHT = 420
const MAX_MODAL_WIDTH_PERCENT = 95
const MAX_MODAL_HEIGHT_PERCENT = 95

const MIN_MARKDOWN_PREVIEW_RATIO = 0.2
const MAX_MARKDOWN_PREVIEW_RATIO = 0.8
const SCROLL_RESTORE_MAX_ATTEMPTS = 120

const DEFAULT_MARKDOWN_PREVIEW_WIDTH = 480
const MIN_MARKDOWN_PREVIEW_WIDTH = 240
const MAX_MARKDOWN_PREVIEW_WIDTH = 800

const DEFAULT_OUTLINE_WIDTH = 220
const MIN_OUTLINE_WIDTH = 160
const MAX_OUTLINE_WIDTH = 400
const MARKDOWN_RENDER_DEBOUNCE_MS = 300
const MARKDOWN_RENDER_MAX_DEBOUNCE_MS = 1200
const PROJECT_STATE_SAVE_DEBOUNCE_MS = 1200
const PROGRAMMATIC_EDITOR_PREVIEW_SYNC_SUPPRESS_MS = 1200
const MAX_PINNED_FILES = Infinity
const MAX_RECENT_FILES = 10
const MAX_PERSISTED_FILE_STATES = 20
// 12 (was 7): with several Tasks sharing the global [root,file]-keyed budget,
// 7 entries let one Task's browsing evict another Task's instant-reopen cache.
const MARKDOWN_SESSION_CACHE_DEFAULT_LIMIT = 12
const MARKDOWN_SESSION_CACHE_MIN_LIMIT = 1
const MARKDOWN_SESSION_CACHE_MAX_LIMIT = 20
const MARKDOWN_SESSION_CACHE_RECENCY_HALF_LIFE_MS = 30 * 60 * 1000
const QUICK_FILE_DRAG_MIME = 'application/x-onward-quick-file'
const HTML_SCROLL_TRACK_INTERVAL_MS = 2000
const LARGE_FILE_CHUNK_BYTES = 512 * 1024
const BINARY_VIEWER_BYTES_PER_LINE = 16
const BINARY_DEFAULT_RADIX: BinaryRadix = 16

const MARKDOWN_EXTENSIONS = new Set(['md', 'markdown', 'mdx'])

const DOMPURIFY_URI_POLICY = /^(?:(?:https?|mailto|tel|sms|cid|xmpp|file|data):|[^a-z]|[a-z+.\-]+(?:[^a-z+.\-:]|$))/i
const DEBUG_PROJECT_EDITOR = Boolean(window.electronAPI?.debug?.enabled)

function normalizePath(value: string): string {
  return value.replace(/\\/g, '/')
}

function formatFileSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let value = bytes
  let unitIndex = 0
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024
    unitIndex += 1
  }
  const digits = value >= 100 || unitIndex === 0 ? 0 : value >= 10 ? 1 : 2
  return `${value.toFixed(digits)} ${units[unitIndex]}`
}

function getExtensionKey(path: string, extension?: string): string {
  const ext = (extension || path.split('/').pop()?.match(/(\.[^.]+)$/)?.[1] || '').toLowerCase()
  return ext || '__no_extension__'
}

function readBinaryOpenDefaults(): Record<string, FileOpenChoiceMode> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY_BINARY_OPEN_DEFAULTS)
    if (!raw) return {}
    const parsed = JSON.parse(raw) as Record<string, unknown>
    const out: Record<string, FileOpenChoiceMode> = {}
    for (const [key, value] of Object.entries(parsed)) {
      if (value === 'text' || value === 'binary') out[key] = value
    }
    return out
  } catch {
    return {}
  }
}

function writeBinaryOpenDefault(extensionKey: string, mode: FileOpenChoiceMode): void {
  const defaults = readBinaryOpenDefaults()
  defaults[extensionKey] = mode
  localStorage.setItem(STORAGE_KEY_BINARY_OPEN_DEFAULTS, JSON.stringify(defaults))
}

function base64ToBytes(value: string): Uint8Array {
  const binary = window.atob(value)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i)
  }
  return bytes
}

function trimTrailingPathSeparators(value: string): string {
  if (/^[A-Za-z]:\/$/.test(value)) return value
  return value.replace(/\/+$/, '')
}

function normalizeComparablePath(value: string): string {
  const normalized = trimTrailingPathSeparators(normalizePath(value))
  return window.electronAPI.platform === 'win32'
    ? normalized.toLowerCase()
    : normalized
}

// Quick-file pure functions imported from ./quickFileUtils

type ProjectEditorScope = {
  terminalId: string
  cwd: string | null
}

type ProjectEditorSoftCloseKind = 'retained-close' | 'subpage-return'

type ProjectEditorSoftCloseSnapshot = {
  kind: ProjectEditorSoftCloseKind
  scope: ProjectEditorScope
  path: string | null
  content: string
  isBinary: boolean
  isImage: boolean
  isSqlite: boolean
  isPdf: boolean
  isEpub: boolean
  isHtml: boolean
  isMarkdownPreviewOpen: boolean
  isMarkdownEditorVisible: boolean
  outlineTarget: OutlineTarget
}

type DiffReturnContext = {
  terminalId: string
  filePath: string | null
  repoRoot: string | null
  createdAt: number
}

type PreviewScrollMemory = {
  scrollRatio: number
  nearestHeadingSlug: string | null
  headingOffsetY: number
  scrollTop: number
}

type MarkdownSessionCacheEntry = {
  key: string
  rootPath: string
  filePath: string
  content: string
  renderedHtml: string
  imagePaths: string[]
  imageMap: Record<string, string>
  previewScrollMemory?: PreviewScrollMemory
  fileMemory?: FileViewMemory
  outlineScrollTop?: number
  isPreviewOpen: boolean
  isEditorVisible: boolean
  outlineTarget: OutlineTarget
  openCount: number
  dwellMs: number
  lastAccessedAt: number
  activatedAt: number | null
  savedAt: number
  hitCount: number
  stale: boolean
}

type MarkdownSessionCacheRestoreResult = {
  mode: 'hit' | 'miss' | 'stale' | 'disabled'
  key: string | null
  filePath: string | null
  size: number
  limit: number
  openCount?: number
  dwellMs?: number
  renderedHtmlLength?: number
}

type MarkdownSessionCacheDebugEntry = {
  filePath: string
  renderedHtmlLength: number
  openCount: number
  dwellMs: number
  lastAccessedAt: number
  hitCount: number
  stale: boolean
}

type MarkdownCodeWrapDebugState = {
  enabled: boolean
  previewClassName: string | null
  blockWhiteSpace: string | null
  blockOverflowWrap: string | null
  inlineWhiteSpace: string | null
  inlineOverflowWrap: string | null
}

type ProjectEditorReopenRestoreDebug = {
  durationMs: number
  cause: 'retained-view' | 'persisted-state'
  filePath: string | null
  markdownCacheMode: MarkdownSessionCacheRestoreResult['mode'] | null
  finalizedAt: number
}

function normalizeScopeCwd(value: string | null): string | null {
  if (!value) return null
  const trimmed = value.trim()
  if (!trimmed) return null
  return normalizePath(trimmed)
}

function buildProjectEditorScope(terminalId: string | null, cwd: string | null): ProjectEditorScope | null {
  if (!terminalId) return null
  return {
    terminalId,
    cwd: normalizeScopeCwd(cwd)
  }
}

const markdownSessionCacheStore = new Map<string, MarkdownSessionCacheEntry>()

function getMarkdownSessionCacheLimit(): number {
  const raw = window.localStorage.getItem(STORAGE_KEY_MARKDOWN_SESSION_CACHE_LIMIT)
  const parsed = raw ? Number.parseInt(raw, 10) : MARKDOWN_SESSION_CACHE_DEFAULT_LIMIT
  if (!Number.isFinite(parsed)) return MARKDOWN_SESSION_CACHE_DEFAULT_LIMIT
  return Math.max(MARKDOWN_SESSION_CACHE_MIN_LIMIT, Math.min(MARKDOWN_SESSION_CACHE_MAX_LIMIT, parsed))
}

function getMarkdownSessionCacheKey(rootPath: string | null, filePath: string | null): string | null {
  if (!rootPath || !filePath) return null
  return JSON.stringify([normalizePath(rootPath), normalizePath(filePath)])
}

// Per-scope protected markdown-cache keys: each active Task's last markdown
// file is exempt from eviction so other Tasks' browsing cannot destroy its
// instant-reopen cache. LRU-capped alongside the snapshot store — a Task that
// falls out of the last 4 scopes loses protection (not the cache entry
// itself). There is no renderer-visible terminal-close event to hook, so the
// cap is what bounds staleness.
const MAX_PROTECTED_MARKDOWN_SCOPES = 4
const protectedMarkdownCacheKeysByScope = new Map<string, string>()

function setScopeProtectedMarkdownCacheKey(scopeKey: string | null, cacheKey: string | null): void {
  if (!scopeKey) return
  const previous = protectedMarkdownCacheKeysByScope.get(scopeKey) ?? null
  if (previous === cacheKey) {
    if (cacheKey !== null) {
      // Refresh recency.
      protectedMarkdownCacheKeysByScope.delete(scopeKey)
      protectedMarkdownCacheKeysByScope.set(scopeKey, cacheKey)
    }
    return
  }
  protectedMarkdownCacheKeysByScope.delete(scopeKey)
  if (cacheKey !== null) {
    protectedMarkdownCacheKeysByScope.set(scopeKey, cacheKey)
    while (protectedMarkdownCacheKeysByScope.size > MAX_PROTECTED_MARKDOWN_SCOPES) {
      const oldestKey = protectedMarkdownCacheKeysByScope.keys().next().value
      if (oldestKey === undefined) break
      protectedMarkdownCacheKeysByScope.delete(oldestKey)
    }
  }
  perfTraceDiagnostic(PERF_TRACE_EVENT.RENDERER_PROJECT_EDITOR_MD_CACHE_PROTECTED_SET_UPDATED, {
    ph: 'i',
    cleared: cacheKey === null,
    protectedCount: protectedMarkdownCacheKeysByScope.size
  })
}

function pruneMarkdownSessionCache(protectedKey?: string | null): void {
  const limit = getMarkdownSessionCacheLimit()
  const protectedKeys = new Set(protectedMarkdownCacheKeysByScope.values())
  if (protectedKey) protectedKeys.add(protectedKey)
  const evictions = selectMarkdownSessionCacheEvictions(
    Array.from(markdownSessionCacheStore.values(), (entry) => ({
      key: entry.key,
      dwellMs: entry.dwellMs,
      openCount: entry.openCount,
      lastAccessedAt: entry.lastAccessedAt
    })),
    {
      limit,
      protectedKeys,
      now: Date.now(),
      recencyHalfLifeMs: MARKDOWN_SESSION_CACHE_RECENCY_HALF_LIFE_MS
    }
  )
  for (const evictKey of evictions) {
    markdownSessionCacheStore.delete(evictKey)
    perfTraceDiagnostic(PERF_TRACE_EVENT.RENDERER_PROJECT_EDITOR_MD_CACHE_EVICTED, {
      ph: 'i',
      size: markdownSessionCacheStore.size,
      limit,
      protectedCount: protectedKeys.size
    })
  }
}

function recordMarkdownSessionCacheDwell(rootPath: string | null, filePath: string | null): void {
  const key = getMarkdownSessionCacheKey(rootPath, filePath)
  if (!key) return
  const entry = markdownSessionCacheStore.get(key)
  if (!entry?.activatedAt) return
  const now = Date.now()
  entry.dwellMs += Math.max(0, now - entry.activatedAt)
  entry.activatedAt = now
  entry.lastAccessedAt = now
}

function markMarkdownSessionCacheStale(rootPath: string | null, filePath: string | null): void {
  const key = getMarkdownSessionCacheKey(rootPath, filePath)
  if (!key) return
  const entry = markdownSessionCacheStore.get(key)
  if (!entry) return
  recordMarkdownSessionCacheDwell(rootPath, filePath)
  entry.stale = true
  entry.lastAccessedAt = Date.now()
}

function readMarkdownSessionCache(rootPath: string, filePath: string, content: string): {
  result: MarkdownSessionCacheRestoreResult
  entry: MarkdownSessionCacheEntry | null
} {
  const key = getMarkdownSessionCacheKey(rootPath, filePath)
  const limit = getMarkdownSessionCacheLimit()
  if (!key) {
    return { result: { mode: 'disabled', key: null, filePath, size: markdownSessionCacheStore.size, limit }, entry: null }
  }

  const entry = markdownSessionCacheStore.get(key)
  if (!entry) {
    return { result: { mode: 'miss', key, filePath, size: markdownSessionCacheStore.size, limit }, entry: null }
  }

  recordMarkdownSessionCacheDwell(rootPath, filePath)
  const now = Date.now()
  entry.openCount += 1
  entry.lastAccessedAt = now
  entry.activatedAt = now
  markdownSessionCacheStore.delete(key)
  markdownSessionCacheStore.set(key, entry)

  const base = {
    key,
    filePath,
    size: markdownSessionCacheStore.size,
    limit,
    openCount: entry.openCount,
    dwellMs: entry.dwellMs,
    renderedHtmlLength: entry.renderedHtml.length
  }

  if (!isMarkdownSessionCacheContentHit(entry, content)) {
    // Report a 'stale' (effectively miss) result for THIS read WITHOUT
    // permanently poisoning the entry. The previous `entry.stale = true` here
    // turned a transient read-time content mismatch — e.g. `fileContentRef`
    // briefly stale/empty during an EDR-throttled retained reopen, or a Diff
    // round-trip reading before the content settled — into a permanent miss:
    // once `stale`, `isMarkdownSessionCacheContentHit` returns false forever, so
    // the fast cache-restore path stayed dead for the rest of that reopen and
    // forced a slow fresh worker render that overran the reopen budget on the
    // FIRST reopen (PMSR-09/10/11/13/13a/13b) and the Diff "Jump to Editor" /
    // reopen budgets (CDP-10, PMN-41), while later reopens — whose re-captured
    // entry matched — passed. Genuine content changes are invalidated through
    // the dedicated `markMarkdownSessionCacheStale` call sites (editor change,
    // external-file-change watcher, cachedRender mismatch, image-map change), so
    // this redundant self-poison is not needed for correctness; dropping it lets
    // a later read with matching content still hit the cached render.
    return { result: { mode: 'stale', ...base }, entry: null }
  }

  entry.hitCount += 1
  return { result: { mode: 'hit', ...base }, entry }
}

/**
 * Read-only peek for the worker-owner-switch fast path.
 *
 * Returns the cached entry ONLY when it is a content-identical hit per
 * `isMarkdownSessionCacheContentHit`, WITHOUT mutating the entry or the store —
 * no openCount/hitCount increment, no lastAccessedAt/activatedAt touch, no LRU
 * reorder, no dwell record. This is mandatory: the retained-view reopen branch
 * ALSO calls the side-effecting `readMarkdownSessionCache` for the same reopen,
 * so peeking here with the mutating reader would double-count the hit and
 * corrupt eviction scoring. The peek is purely "is there a render I can reuse
 * synchronously right now?" and leaves all accounting to the authoritative read.
 */
function peekMarkdownSessionCacheHit(
  rootPath: string | null,
  filePath: string | null,
  content: string
): MarkdownSessionCacheEntry | null {
  const key = getMarkdownSessionCacheKey(rootPath, filePath)
  if (!key) return null
  const entry = markdownSessionCacheStore.get(key)
  return isMarkdownSessionCacheContentHit(entry, content) ? entry ?? null : null
}

function upsertMarkdownSessionCache(entry: Omit<MarkdownSessionCacheEntry, 'openCount' | 'dwellMs' | 'lastAccessedAt' | 'activatedAt' | 'savedAt' | 'hitCount' | 'stale'>): MarkdownSessionCacheEntry {
  const existing = markdownSessionCacheStore.get(entry.key)
  const now = Date.now()
  const next: MarkdownSessionCacheEntry = {
    ...entry,
    openCount: existing?.openCount ?? 1,
    dwellMs: existing?.dwellMs ?? 0,
    lastAccessedAt: now,
    activatedAt: existing?.activatedAt ?? now,
    savedAt: now,
    hitCount: existing?.hitCount ?? 0,
    stale: false
  }
  markdownSessionCacheStore.delete(entry.key)
  markdownSessionCacheStore.set(entry.key, next)
  pruneMarkdownSessionCache(entry.key)
  return next
}

function replaceMarkdownSessionCacheEntries(rootPath: string | null, sourcePath: string, nextPath: string): void {
  const sourceKey = getMarkdownSessionCacheKey(rootPath, sourcePath)
  const nextKey = getMarkdownSessionCacheKey(rootPath, nextPath)
  if (!sourceKey || !nextKey || sourceKey === nextKey) return
  const entry = markdownSessionCacheStore.get(sourceKey)
  if (!entry) return
  markdownSessionCacheStore.delete(sourceKey)
  markdownSessionCacheStore.set(nextKey, {
    ...entry,
    key: nextKey,
    filePath: normalizePath(nextPath),
    lastAccessedAt: Date.now()
  })
}

function removeMarkdownSessionCacheEntries(rootPath: string | null, targetPath: string): void {
  if (!rootPath) return
  const normalizedTarget = normalizePath(targetPath.trim())
  if (!normalizedTarget) return
  const normalizedRoot = normalizePath(rootPath)
  for (const [key, entry] of markdownSessionCacheStore.entries()) {
    if (entry.rootPath !== normalizedRoot) continue
    if (entry.filePath === normalizedTarget || entry.filePath.startsWith(`${normalizedTarget}/`)) {
      markdownSessionCacheStore.delete(key)
    }
  }
}

function getMarkdownSessionCacheDebugEntries(): MarkdownSessionCacheDebugEntry[] {
  return Array.from(markdownSessionCacheStore.values()).map((entry) => ({
    filePath: entry.filePath,
    renderedHtmlLength: entry.renderedHtml.length,
    openCount: entry.openCount,
    dwellMs: Math.round(entry.dwellMs),
    lastAccessedAt: entry.lastAccessedAt,
    hitCount: entry.hitCount,
    stale: entry.stale
  }))
}

function isSameProjectEditorScope(a: ProjectEditorScope | null, b: ProjectEditorScope | null): boolean {
  if (!a && !b) return true
  if (!a || !b) return false
  return a.terminalId === b.terminalId && normalizeScopeCwd(a.cwd) === normalizeScopeCwd(b.cwd)
}

function isProjectEditorSoftCloseSnapshotForScope(
  snapshot: ProjectEditorSoftCloseSnapshot | null,
  scope: ProjectEditorScope | null,
  kind?: ProjectEditorSoftCloseKind
): snapshot is ProjectEditorSoftCloseSnapshot {
  if (!snapshot || !scope) return false
  if (kind && snapshot.kind !== kind) return false
  return isSameProjectEditorScope(snapshot.scope, scope)
}

function getFileScrollKey(scope: ProjectEditorScope | null, filePath: string | null): string | null {
  if (!scope || !filePath) return null
  return JSON.stringify([scope.terminalId, scope.cwd, filePath])
}

/** Scroll position memory — scope key (for file tree) */
function getScrollScopeKey(scope: ProjectEditorScope | null): string | null {
  if (!scope) return null
  return JSON.stringify([scope.terminalId, scope.cwd])
}

function normalizeOutlineScrollByFile(value: unknown): Record<string, number> {
  if (!value || typeof value !== 'object') return {}
  const result: Record<string, number> = {}
  for (const [filePath, rawScrollTop] of Object.entries(value as Record<string, unknown>)) {
    if (typeof filePath !== 'string' || !filePath) continue
    if (typeof rawScrollTop !== 'number' || !Number.isFinite(rawScrollTop)) continue
    result[normalizePath(filePath)] = Math.max(0, rawScrollTop)
  }
  return result
}

function buildOutlineScrollByFileState(outlineScrollByFile: Map<string, number>): Record<string, number> {
  const result: Record<string, number> = {}
  for (const [filePath, scrollTop] of outlineScrollByFile.entries()) {
    if (!filePath || typeof scrollTop !== 'number' || !Number.isFinite(scrollTop)) continue
    result[filePath] = Math.max(0, scrollTop)
  }
  return result
}

function debugLog(...args: unknown[]) {
  if (!DEBUG_PROJECT_EDITOR) return
  console.log('[ProjectEditor]', ...args)
  try {
    const [message, ...data] = args
    window.electronAPI.debug.log(String(message ?? ''), data.length > 0 ? data : undefined)
  } catch {
    // ignore debug logging failures
  }
}

// Investigative timing log, gated behind the same DEBUG flag used by
// debugLog. ONWARD_DEBUG=1 (set by autotest runners) enables it; production
// builds stay quiet. Encodes the payload in the message string so the
// renderer-console-to-stdout bridge in dev/autotest preserves field values.
let mdpTraceT0 = 0
function mdpTrace(label: string, payload?: Record<string, unknown>): void {
  if (!DEBUG_PROJECT_EDITOR) return
  const now = performance.now()
  const dt = mdpTraceT0 > 0 ? +(now - mdpTraceT0).toFixed(1) : 0
  const data = { dt, ...(payload ?? {}) }
  console.log(`[mdp-trace] ${label} ${JSON.stringify(data)}`)
}
function mdpTraceReset(): void {
  mdpTraceT0 = performance.now()
}

function hasFileViewMemoryData(entry: FileViewMemory | null | undefined): entry is FileViewMemory {
  return Boolean(entry && Object.keys(entry).length > 0)
}

function isMarkdownPath(path: string | null): boolean {
  if (!path) return false
  const parts = path.split('.')
  if (parts.length < 2) return false
  const ext = parts[parts.length - 1].toLowerCase()
  return MARKDOWN_EXTENSIONS.has(ext)
}

function markdownHeadingSlug(text: string): string {
  return text
    .toLowerCase()
    .replace(/<[^>]*>/g, '')
    .replace(/&[^;]+;/g, '')
    .trim()
    .replace(/[^\p{L}\p{N}\s-]/gu, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
}

function findMarkdownOutlineItemBySlug(items: OutlineItem[], targetSlug: string): OutlineItem | null {
  const slugCounts = new Map<string, number>()
  let match: OutlineItem | null = null

  const walk = (list: OutlineItem[]) => {
    for (const item of list) {
      if (match) return
      if (item.kind >= OutlineSymbolKind.Heading1 && item.kind <= OutlineSymbolKind.Heading6) {
        let slug = markdownHeadingSlug(item.name)
        const count = slugCounts.get(slug) ?? 0
        slugCounts.set(slug, count + 1)
        if (count > 0) {
          slug = `${slug}-${count}`
        }
        if (slug === targetSlug) {
          match = item
          return
        }
      }
      if (item.children.length > 0) {
        walk(item.children)
      }
    }
  }

  walk(items)
  return match
}

function normalizeEpubHrefForCompare(href: string | null | undefined): string {
  if (!href) return ''
  const fragmentless = href.split('#', 1)[0].split('?', 1)[0]
  let decoded = fragmentless
  try {
    decoded = decodeURIComponent(fragmentless)
  } catch {
    decoded = fragmentless
  }
  return decoded
    .replace(/\\/g, '/')
    .replace(/^\.?\//, '')
    .replace(/^\/+/, '')
    .toLowerCase()
}

function epubHrefMatchesOutlineItem(itemHref: string, activeHref: string): boolean {
  const item = normalizeEpubHrefForCompare(itemHref)
  const active = normalizeEpubHrefForCompare(activeHref)
  if (!item || !active) return false
  return item === active || item.endsWith(`/${active}`) || active.endsWith(`/${item}`)
}

function getMarkdownRenderDelay(contentLength: number, lastDuration: number): number {
  let delay = MARKDOWN_RENDER_DEBOUNCE_MS
  if (contentLength > 200_000) {
    delay = 900
  } else if (contentLength > 100_000) {
    delay = 700
  } else if (contentLength > 50_000) {
    delay = 500
  } else if (contentLength > 20_000) {
    delay = 380
  }

  if (lastDuration > 80) {
    delay = Math.max(delay, Math.min(MARKDOWN_RENDER_MAX_DEBOUNCE_MS, Math.round(lastDuration * 3)))
  }

  return delay
}

function collectAncestorDirPaths(filePath: string): string[] {
  // node.path is relative to the project root and uses forward slashes (see
  // buildNodes / listDirectory). Returns ancestors shallowest → deepest.
  const parts = filePath.split('/').filter(Boolean)
  const ancestors: string[] = []
  for (let i = 1; i < parts.length; i++) {
    ancestors.push(parts.slice(0, i).join('/'))
  }
  return ancestors
}

function collectExpandedPaths(nodes: TreeNode[]): string[] {
  const results: string[] = []
  const walk = (items: TreeNode[]) => {
    items.forEach((node) => {
      if (node.type === 'dir' && node.isExpanded) {
        if (node.path) {
          results.push(node.path)
        }
        if (node.children) {
          walk(node.children)
        }
      } else if (node.type === 'dir' && node.children) {
        walk(node.children)
      }
    })
  }
  walk(nodes)
  return results
}

function collectFirstFilePaths(nodes: TreeNode[], limit = 2): string[] {
  const results: string[] = []
  const walk = (items: TreeNode[]) => {
    for (const node of items) {
      if (results.length >= limit) return
      if (node.type === 'file') {
        results.push(node.path)
        if (results.length >= limit) return
      }
      if (node.type === 'dir' && node.children) {
        walk(node.children)
        if (results.length >= limit) return
      }
    }
  }
  walk(nodes)
  return results
}

function buildNodes(entries: ProjectEntry[]): TreeNode[] {
  return entries.map((entry) => ({
    name: entry.name,
    path: entry.path,
    type: entry.type
  }))
}

function mergeChildren(prevChildren: TreeNode[] | undefined, nextChildren: TreeNode[]): TreeNode[] {
  if (!prevChildren) return nextChildren

  return nextChildren.map((child) => {
    if (child.type !== 'dir') return child
    const previous = prevChildren.find(prev => prev.path === child.path)
    if (!previous) return child
    return {
      ...child,
      isExpanded: previous.isExpanded,
      isLoading: false,
      children: previous.children
    }
  })
}

function updateTree(nodes: TreeNode[], targetPath: string, updater: (node: TreeNode) => TreeNode): TreeNode[] {
  return nodes.map((node) => {
    if (node.path === targetPath) {
      return updater(node)
    }
    if (node.type === 'dir' && node.children) {
      return {
        ...node,
        children: updateTree(node.children, targetPath, updater)
      }
    }
    return node
  })
}

function findNode(nodes: TreeNode[], targetPath: string): TreeNode | null {
  for (const node of nodes) {
    if (node.path === targetPath) return node
    if (node.type === 'dir' && node.children) {
      const found = findNode(node.children, targetPath)
      if (found) return found
    }
  }
  return null
}

function joinPath(parent: string, name: string): string {
  if (!parent) return name
  return `${parent}/${name}`
}

function fuzzyScore(query: string, target: string): number | null {
  if (!query) return 0
  let score = 0
  let lastIndex = -1
  for (let i = 0; i < query.length; i += 1) {
    const ch = query[i]
    let found = false
    for (let j = lastIndex + 1; j < target.length; j += 1) {
      if (target[j] === ch) {
        score += j === lastIndex + 1 ? 3 : 1
        lastIndex = j
        found = true
        break
      }
    }
    if (!found) return null
  }
  score += Math.max(0, 20 - (target.length - query.length))
  return score
}

function buildFuzzyResults(query: string, items: string[], limit = 50): string[] {
  const normalized = query.trim().toLowerCase()
  if (!normalized) return items.slice(0, limit)

  const scored = items.map((item) => {
    const lower = item.toLowerCase()
    const base = getBaseName(lower)
    const baseScore = fuzzyScore(normalized, base)
    const pathScore = fuzzyScore(normalized, lower)
    if (baseScore === null && pathScore === null) return null
    const score = (baseScore ?? 0) * 2 + (pathScore ?? 0)
    return { item, score }
  }).filter(Boolean) as Array<{ item: string; score: number }>

  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score
    return a.item.length - b.item.length
  })

  return scored.slice(0, limit).map(entry => entry.item)
}

function resolveMonacoLanguage(filePath: string | null): string {
  if (!filePath) return 'plaintext'
  const normalized = normalizePath(filePath).toLowerCase()
  const baseName = getBaseName(normalized)
  if (baseName === 'dockerfile') return 'dockerfile'
  if (baseName === 'makefile') return 'makefile'

  const parts = baseName.split('.')
  const ext = parts.length > 1 ? parts[parts.length - 1] : ''
  const languageByExtension: Record<string, string> = {
    ts: 'typescript',
    tsx: 'typescript',
    js: 'javascript',
    jsx: 'javascript',
    mjs: 'javascript',
    cjs: 'javascript',
    json: 'json',
    css: 'css',
    scss: 'scss',
    less: 'less',
    html: 'html',
    htm: 'html',
    xhtml: 'html',
    md: 'markdown',
    markdown: 'markdown',
    mdx: 'markdown',
    yml: 'yaml',
    yaml: 'yaml',
    xml: 'xml',
    sh: 'shell',
    bash: 'shell',
    zsh: 'shell',
    py: 'python',
    java: 'java',
    go: 'go',
    rs: 'rust',
    cpp: 'cpp',
    cxx: 'cpp',
    cc: 'cpp',
    c: 'c',
    h: 'cpp',
    hpp: 'cpp',
    cs: 'csharp',
    php: 'php',
    rb: 'ruby',
    swift: 'swift',
    kt: 'kotlin',
    sql: 'sql',
    vue: 'html',
    svelte: 'html'
  }
  return languageByExtension[ext] ?? 'plaintext'
}

export function ProjectEditor({
  isOpen,
  terminalId: _terminalId,
  cwd,
  openRequest = null,
  onClose,
  onDirtyChange,
  displayMode = 'modal',
  panelShellMode = 'internal',
  onPanelShellStateChange,
  taskTitle
}: ProjectEditorProps) {
  const isPanel = displayMode === 'panel'
  const useSharedPanelHeader = isPanel && panelShellMode === 'internal'
  const { getTerminalStyle, settings } = useSettings()
  const { locale, t } = useI18n()
  const {
    getProjectEditorState,
    setProjectEditorState,
    flushProjectEditorState,
    getUIPreferences,
    updateUIPreferences
  } = useAppState()
  const perfCountersRef = useRef({
    renders: 0,
    editorChange: 0,
    editorScroll: 0,
    editorCursor: 0,
    previewScroll: 0,
    previewSync: 0,
    scheduleRender: 0,
    workerSend: 0,
    workerApply: 0,
    projectStateSave: 0
  })
  const perfIntervalRef = useRef<number | null>(null)

  if (DEBUG_PROJECT_EDITOR) {
    perfCountersRef.current.renders += 1
  }
  const [rootPath, setRootPath] = useState<string | null>(null)
  const [rootError, setRootError] = useState<string | null>(null)
  const rootRef = useRef<string | null>(null)
  const gitDiffOpenRef = useRef(false)

  const [tree, setTree] = useState<TreeNode[]>([])
  const [selectedPath, setSelectedPath] = useState<string | null>(null)
  const [activeFilePath, setActiveFilePath] = useState<string | null>(null)
  const [pinnedFiles, setPinnedFiles] = useState<string[]>([])
  const [recentFiles, setRecentFiles] = useState<string[]>([])
  const pinnedFilesRef = useRef<string[]>(pinnedFiles)
  const recentFilesRef = useRef<string[]>(recentFiles)
  pinnedFilesRef.current = pinnedFiles
  recentFilesRef.current = recentFiles
  const [draggingPinnedPath, setDraggingPinnedPath] = useState<string | null>(null)
  const [draggingQuickPath, setDraggingQuickPath] = useState<string | null>(null)
  const [draggingQuickSource, setDraggingQuickSource] = useState<'pinned' | 'recent' | null>(null)
  const [dragOverPinnedPath, setDragOverPinnedPath] = useState<string | null>(null)
  const [quickTooltip, setQuickTooltip] = useState<{ text: string; fullPath: string; x: number; y: number } | null>(null)
  const [visiblePinCount, setVisiblePinCount] = useState<number>(Infinity)
  const [visibleRecentCount, setVisibleRecentCount] = useState<number>(Infinity)
  const [pinOverflowOpen, setPinOverflowOpen] = useState(false)
  const [recentOverflowOpen, setRecentOverflowOpen] = useState(false)
  const pinnedMeasureRef = useRef<HTMLDivElement>(null)
  const recentMeasureRef = useRef<HTMLDivElement>(null)
  const pinOverflowBtnRef = useRef<HTMLButtonElement>(null)
  const recentOverflowBtnRef = useRef<HTMLButtonElement>(null)
  const pinDropdownRef = useRef<HTMLDivElement>(null)
  const recentDropdownRef = useRef<HTMLDivElement>(null)
  const [fileContent, setFileContent] = useState('')
  const [outlineContentSnapshot, setOutlineContentSnapshot] = useState<{
    filePath: string | null
    content: string
  }>({ filePath: null, content: '' })
  const fileContentRef = useRef('')
  const [isBinary, setIsBinary] = useState(false)
  const [isImage, setIsImage] = useState(false)
  const [isSqlite, setIsSqlite] = useState(false)
  const [isPdf, setIsPdf] = useState(false)
  const [isEpub, setIsEpub] = useState(false)
  const [isHtml, setIsHtml] = useState(false)
  // PDF / EPUB outline state feeds directly into the shared OutlinePanel so
  // Markdown / code / PDF / EPUB all share the same surface (and the same
  // auto-center behavior from the 0418-wk3 merge).
  const [pdfOutlineSymbols, setPdfOutlineSymbols] = useState<OutlineItem[]>([])
  const [pdfActivePage, setPdfActivePage] = useState<number>(1)
  const [epubOutlineSymbols, setEpubOutlineSymbols] = useState<OutlineItem[]>([])
  const [epubActiveHref, setEpubActiveHref] = useState<string | null>(null)
  const [imagePreviewUrl, setImagePreviewUrl] = useState<string | null>(null)
  const [pdfPreviewUrl, setPdfPreviewUrl] = useState<string | null>(null)
  const [epubPreviewUrl, setEpubPreviewUrl] = useState<string | null>(null)
  const [htmlPreviewUrl, setHtmlPreviewUrl] = useState<string | null>(null)
  const htmlPreviewUrlRef = useRef<string | null>(null)
  const [htmlPreviewReloadKey, setHtmlPreviewReloadKey] = useState(0)
  const htmlPreviewReloadKeyRef = useRef(0)
  const [htmlReaderState, setHtmlReaderState] = useState<HtmlReaderState | null>(null)
  const htmlReaderStateRef = useRef<HtmlReaderState | null>(null)
  const [htmlPreviewScrollState, setHtmlPreviewScrollState] = useState<HtmlPreviewScrollState | null>(null)
  const htmlPreviewScrollStateRef = useRef<HtmlPreviewScrollState | null>(null)
  const [htmlPreviewSearchOpen, setHtmlPreviewSearchOpen] = useState(false)
  const htmlPreviewSearchOpenRef = useRef(false)
  const [htmlPreviewSearchFocusRequestId, setHtmlPreviewSearchFocusRequestId] = useState(0)
  const htmlPreviewSearchFocusRequestIdRef = useRef(0)
  const [htmlPreviewSearchQuery, setHtmlPreviewSearchQuery] = useState('')
  const htmlPreviewSearchQueryRef = useRef('')
  const [htmlPreviewSearchResult, setHtmlPreviewSearchResult] = useState<HtmlPreviewSearchResult>({
    matches: 0,
    activeMatchOrdinal: 0,
    finalUpdate: false
  })
  const htmlPreviewSearchResultRef = useRef<HtmlPreviewSearchResult>({
    matches: 0,
    activeMatchOrdinal: 0,
    finalUpdate: false
  })
  const [htmlPreviewZoomFactor, setHtmlPreviewZoomFactor] = useState(() => {
    const prefs = getUIPreferences()
    if (prefs.projectEditorHtmlPreviewZoomFactor !== undefined) {
      return normalizeHtmlPreviewZoomFactor(prefs.projectEditorHtmlPreviewZoomFactor)
    }
    const saved = localStorage.getItem(STORAGE_KEY_HTML_PREVIEW_ZOOM_FACTOR)
    return normalizeHtmlPreviewZoomFactor(saved ? Number(saved) : HTML_PREVIEW_DEFAULT_ZOOM_FACTOR)
  })
  const htmlPreviewZoomFactorRef = useRef(htmlPreviewZoomFactor)
  const updateHtmlReaderState = useCallback((state: HtmlReaderState | null) => {
    htmlReaderStateRef.current = state
    setHtmlReaderState(state)
  }, [])
  const updateHtmlPreviewScrollState = useCallback((state: HtmlPreviewScrollState | null) => {
    htmlPreviewScrollStateRef.current = state
    setHtmlPreviewScrollState(state)
  }, [])
  const requestHtmlPreviewReload = useCallback(async (reason: 'save' | 'external-change') => {
    const targetPath = activeFilePathRef.current
    if (!targetPath || !isHtmlPath(targetPath) || !htmlPreviewUrlRef.current) return
    const reader = htmlReaderStateRef.current
    const browserId = reader?.browserId
    // Only preserve scroll when the live view is still on the originally opened
    // document. If the user navigated away via a link, capturing here would
    // transplant the foreign page's offset onto the freshly remounted home
    // document; instead let the home document render from the top.
    const homeUrl = withHtmlPreviewReloadKey(htmlPreviewUrlRef.current, htmlPreviewReloadKeyRef.current)
    const onHomeDocument = isSameHtmlPreviewDocument(reader?.url ?? null, homeUrl)
    if (browserId && onHomeDocument) {
      const scrollResult = await window.electronAPI.browser.getScrollState(browserId)
      if (activeFilePathRef.current !== targetPath) return
      updateHtmlPreviewScrollState(scrollResult.success
        ? normalizeHtmlPreviewScrollState(scrollResult.state)
        : null)
    } else {
      updateHtmlPreviewScrollState(null)
    }
    const nextKey = Date.now()
    perfTrace(PERF_TRACE_EVENT.RENDERER_PROJECT_HTML_PREVIEW_RELOAD, {
      reason,
      pathLen: targetPath.length,
      reloadKey: nextKey,
      preservedScrollY: htmlPreviewScrollStateRef.current?.y ?? 0
    })
    htmlPreviewReloadKeyRef.current = nextKey
    setHtmlPreviewReloadKey(nextKey)
    updateHtmlReaderState(null)
  }, [updateHtmlPreviewScrollState, updateHtmlReaderState])
  const handleHtmlPreviewNav = useCallback(async (
    action: 'back' | 'forward' | 'reload' | 'home',
    source: 'toolbar' | 'shortcut' = 'toolbar'
  ): Promise<boolean> => {
    const reader = htmlReaderStateRef.current
    perfTrace(PERF_TRACE_EVENT.RENDERER_PROJECT_HTML_PREVIEW_NAV, {
      action,
      source,
      hasBrowser: Boolean(reader?.browserId),
      canGoBack: reader?.canGoBack ?? false,
      canGoForward: reader?.canGoForward ?? false
    })
    const browserId = reader?.browserId
    if (!browserId) {
      perfTrace(PERF_TRACE_EVENT.RENDERER_PROJECT_HTML_PREVIEW_NAV, { action, source, rejected: 'no-browser' })
      return false
    }
    let ok = false
    if (action === 'back') {
      ok = await window.electronAPI.browser.goBack(browserId)
    } else if (action === 'forward') {
      ok = await window.electronAPI.browser.goForward(browserId)
    } else if (action === 'reload') {
      // Hard reload: inherits the removed force-refresh button's guarantee of
      // fresh disk content (CSS/JS subresources included).
      ok = await window.electronAPI.browser.reload(browserId, { ignoreCache: true })
    } else {
      const homeUrl = withHtmlPreviewReloadKey(htmlPreviewUrlRef.current, htmlPreviewReloadKeyRef.current)
      ok = homeUrl ? await window.electronAPI.browser.navigate(browserId, homeUrl) : false
    }
    if (!ok) {
      perfTrace(PERF_TRACE_EVENT.RENDERER_PROJECT_HTML_PREVIEW_NAV, { action, source, rejected: 'ipc-false' })
    }
    return ok
  }, [])
  const updateHtmlPreviewSearchResult = useCallback((result: HtmlPreviewSearchResult) => {
    htmlPreviewSearchResultRef.current = result
    setHtmlPreviewSearchResult(result)
  }, [])
  const updateHtmlPreviewSearchQuery = useCallback((query: string) => {
    htmlPreviewSearchQueryRef.current = query
    setHtmlPreviewSearchQuery(query)
  }, [])
  const requestHtmlPreviewSearchFocus = useCallback(() => {
    htmlPreviewSearchFocusRequestIdRef.current += 1
    setHtmlPreviewSearchFocusRequestId(htmlPreviewSearchFocusRequestIdRef.current)
  }, [])
  const resetHtmlPreviewSearchResult = useCallback(() => {
    updateHtmlPreviewSearchResult({
      matches: 0,
      activeMatchOrdinal: 0,
      finalUpdate: false
    })
  }, [updateHtmlPreviewSearchResult])
  const stopHtmlPreviewSearch = useCallback(() => {
    const browserId = htmlReaderStateRef.current?.browserId
    if (browserId) {
      void window.electronAPI.browser.stopFindInPage(browserId, 'clearSelection')
    }
    resetHtmlPreviewSearchResult()
  }, [resetHtmlPreviewSearchResult])
  const closeHtmlPreviewSearch = useCallback(() => {
    htmlPreviewSearchOpenRef.current = false
    setHtmlPreviewSearchOpen(false)
    updateHtmlPreviewSearchQuery('')
    stopHtmlPreviewSearch()
  }, [stopHtmlPreviewSearch, updateHtmlPreviewSearchQuery])
  const openHtmlPreviewSearch = useCallback(() => {
    if (!htmlReaderStateRef.current?.browserId) return
    htmlPreviewSearchOpenRef.current = true
    setHtmlPreviewSearchOpen(true)
    requestHtmlPreviewSearchFocus()
  }, [requestHtmlPreviewSearchFocus])
  const setHtmlPreviewZoomFactorState = useCallback((
    zoomFactor: number,
    source: 'toolbar' | 'shortcut' | 'restore' | 'debug' | 'webcontents-shortcut'
  ) => {
    const nextZoomFactor = normalizeHtmlPreviewZoomFactor(zoomFactor)
    htmlPreviewZoomFactorRef.current = nextZoomFactor
    setHtmlPreviewZoomFactor(nextZoomFactor)
    localStorage.setItem(STORAGE_KEY_HTML_PREVIEW_ZOOM_FACTOR, String(nextZoomFactor))
    updateUIPreferences({ projectEditorHtmlPreviewZoomFactor: nextZoomFactor })
    perfTrace(PERF_TRACE_EVENT.RENDERER_PROJECT_HTML_PREVIEW_ZOOM, {
      source,
      zoomPercent: Math.round(nextZoomFactor * 100),
      pathLen: activeFilePathRef.current?.length ?? 0
    })
    return nextZoomFactor
  }, [updateUIPreferences])
  const applyHtmlPreviewZoomFactor = useCallback(async (
    zoomFactor: number,
    source: 'toolbar' | 'shortcut' | 'restore' | 'debug'
  ) => {
    const nextZoomFactor = setHtmlPreviewZoomFactorState(zoomFactor, source)
    const browserId = htmlReaderStateRef.current?.browserId
    if (!browserId) return false
    const result = await window.electronAPI.browser.setZoomFactor(browserId, nextZoomFactor)
    return Boolean(result.success)
  }, [setHtmlPreviewZoomFactorState])
  const stepHtmlPreviewZoom = useCallback((
    direction: 'in' | 'out' | 'reset',
    source: 'toolbar' | 'shortcut' | 'debug' = 'toolbar'
  ) => {
    return applyHtmlPreviewZoomFactor(stepHtmlPreviewZoomFactor(htmlPreviewZoomFactorRef.current, direction), source)
  }, [applyHtmlPreviewZoomFactor])
  const runHtmlPreviewSearch = useCallback((
    query: string,
    options: { forward?: boolean; findNext?: boolean } = {}
  ) => {
    const browserId = htmlReaderStateRef.current?.browserId
    if (!browserId) return
    if (!query.trim()) {
      void window.electronAPI.browser.stopFindInPage(browserId, 'clearSelection')
      resetHtmlPreviewSearchResult()
      return
    }
    perfTrace(PERF_TRACE_EVENT.RENDERER_PROJECT_HTML_PREVIEW_SEARCH, {
      queryLength: query.length,
      forward: options.forward ?? true,
      findNext: Boolean(options.findNext)
    })
    void window.electronAPI.browser.findInPage(browserId, query, {
      forward: options.forward ?? true,
      findNext: options.findNext ?? false,
      matchCase: false
    })
  }, [resetHtmlPreviewSearchResult])
  const goToNextHtmlPreviewSearchMatch = useCallback(() => {
    runHtmlPreviewSearch(htmlPreviewSearchQueryRef.current, { forward: true, findNext: true })
  }, [runHtmlPreviewSearch])
  const goToPreviousHtmlPreviewSearchMatch = useCallback(() => {
    runHtmlPreviewSearch(htmlPreviewSearchQueryRef.current, { forward: false, findNext: true })
  }, [runHtmlPreviewSearch])
  // EPUB bytes are fetched from `epubPreviewUrl` in a follow-on effect so that
  // EpubReader's mount stays purely synchronous — async work inside its own
  // useEffect was observed to widen the layout-race window around epub.js's
  // first display(). See the rAF queue.tick / reportLocation patches in
  // EpubReader.tsx for the matching workaround on the rendering side.
  const [epubPreviewBuffer, setEpubPreviewBuffer] = useState<ArrayBuffer | null>(null)
  const [isMarkdownPreviewOpen, setIsMarkdownPreviewOpen] = useState(true)
  const isMarkdownPreviewOpenRef = useRef(true)
  const [isMarkdownEditorVisible, setIsMarkdownEditorVisible] = useState(() => {
    const prefs = getUIPreferences()
    if (prefs.projectEditorMarkdownEditorVisible !== undefined) return prefs.projectEditorMarkdownEditorVisible
    const saved = localStorage.getItem(STORAGE_KEY_MARKDOWN_EDITOR_VISIBLE)
    return saved === null ? true : saved === 'true'
  })
  const isMarkdownEditorVisibleRef = useRef(isMarkdownEditorVisible)
  const [isMarkdownCodeWrapEnabled, setIsMarkdownCodeWrapEnabled] = useState(() => {
    const saved = localStorage.getItem(STORAGE_KEY_MARKDOWN_CODE_WRAP)
    return saved === 'true'
  })
  const isMarkdownCodeWrapEnabledRef = useRef(isMarkdownCodeWrapEnabled)
  const [isMarkdownRenderEnabled, setIsMarkdownRenderEnabled] = useState(false)
  const [isDirty, setIsDirty] = useState(false)
  const [isLoadingFile, setIsLoadingFile] = useState(false)
  const [largeFileState, setLargeFileState] = useState<LargeFileState | null>(null)
  const [binaryRadix, setBinaryRadix] = useState<BinaryRadix>(BINARY_DEFAULT_RADIX)
  const [statusMessage, setStatusMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null)
  const [searchOpen, setSearchOpen] = useState(false)
  const searchOpenRef = useRef(false)
  const [sidebarMode, setSidebarMode] = useState<'files' | 'search'>('files')
  const sidebarModeRef = useRef(sidebarMode)
  const [initialSearchType, setInitialSearchType] = useState<'content' | 'filename'>('content')
  const [searchQuery, setSearchQuery] = useState('')
  const searchQueryRef = useRef('')
  const [searchResults, setSearchResults] = useState<string[]>([])
  const searchResultsRef = useRef<string[]>([])
  const [searchActiveIndex, setSearchActiveIndex] = useState(0)
  const [isIndexing, setIsIndexing] = useState(false)
  const isIndexingRef = useRef(false)
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null)
  const [previewSearchOpen, setPreviewSearchOpen] = useState(false)
  const previewSearchOpenRef = useRef(false)
  const [previewSearchFocusRequestId, setPreviewSearchFocusRequestId] = useState(0)
  const previewSearchFocusRequestIdRef = useRef(0)
  const previewSearchRef = useRef<PreviewSearchHandle>(null)
  const openPreviewSearch = useCallback(() => {
    previewSearchOpenRef.current = true
    setPreviewSearchOpen(true)
    previewSearchFocusRequestIdRef.current += 1
    setPreviewSearchFocusRequestId(previewSearchFocusRequestIdRef.current)
  }, [])
  const closePreviewSearch = useCallback(() => {
    previewSearchOpenRef.current = false
    setPreviewSearchOpen(false)
  }, [])
  const [markdownImageMap, setMarkdownImageMap] = useState<Record<string, string>>({})
  const [markdownRenderSource, setMarkdownRenderSource] = useState('')
  const [markdownRenderPending, setMarkdownRenderPending] = useState(false)
  const markdownRenderPendingRef = useRef(false)
  const [markdownRenderedHtml, setMarkdownRenderedHtml] = useState('')
  const markdownRenderedHtmlRef = useRef('')
  // Monotonic nonce bumped whenever a markdown render result is (re)applied,
  // including a content-identical session-cache reapply. The mermaid-render and
  // restore-layout effects key off this in addition to `markdownRenderedHtml` so
  // they re-run even when the HTML string is byte-identical to the previous
  // value. This is mandatory for the retained-close -> first-reopen path: the
  // close preserves `markdownRenderedHtml` (preserveClosedPreview), so the
  // reopen's `applyMarkdownSessionCacheHit(setMarkdownRenderedHtml(sameString))`
  // is a React no-op and would NOT re-fire those effects — leaving the mermaid
  // diagram DOM (rebuilt from the cached pre-render HTML, so `.mermaid-rendered`
  // is stripped) stuck at pending>0 forever, which hangs waitForPreviewReady
  // (PMSR-09/10/11/13/13a/13b). Bumping the nonce guarantees re-enhancement.
  const [markdownPreviewRenderNonce, setMarkdownPreviewRenderNonce] = useState(0)
  const [markdownImagePaths, setMarkdownImagePaths] = useState<string[]>([])
  const markdownRenderDurationRef = useRef(0)
  const markdownApplyRequestIdRef = useRef(0)
  const markdownPendingPayloadRef = useRef<{ html: string; imagePaths: string[] } | null>(null)
  const markdownIdleHandleRef = useRef<number | null>(null)
  const markdownWorkerInFlightRef = useRef(false)
  const markdownWorkerQueuedRef = useRef(false)
  const markdownRenderStartRef = useRef(0)
  const markdownRenderSourceRef = useRef('')
  const markdownRootPathRef = useRef('')
  const markdownBaseDirRef = useRef('')
  const markdownImageMapRef = useRef<Record<string, string>>({})
  const watchedImagePathsRef = useRef<Set<string>>(new Set())
  const markdownRenderAllowedRef = useRef(false)
  const markdownWorkerLogCountRef = useRef(0)
  const markdownPurifyLogCountRef = useRef(0)
  const profileRunRef = useRef(false)
  const autotestRunRef = useRef(false)
  const autotestBootstrapLogRef = useRef<string | null>(null)
  const openGitDiffRef = useRef<(source?: 'user' | 'debug', target?: { filePath?: string | null; repoRoot?: string | null }) => Promise<void>>(async () => {})
  const lastHandledOpenRequestRef = useRef<number | null>(null)
  const [diffReturnContext, setDiffReturnContext] = useState<DiffReturnContext | null>(null)
  const diffReturnContextRef = useRef<DiffReturnContext | null>(null)
  const [diffJumpTarget, setDiffJumpTarget] = useState<DiffJumpTarget | null>(null)
  const diffJumpTargetRef = useRef<DiffJumpTarget | null>(null)
  const setDiffJumpTargetValue = useCallback((nextTarget: DiffJumpTarget | null) => {
    diffJumpTargetRef.current = nextTarget
    setDiffJumpTarget(nextTarget)
  }, [])
  const [diffJumpChecking, setDiffJumpChecking] = useState(false)
  const diffJumpCheckTokenRef = useRef(0)

  useEffect(() => {
    diffReturnContextRef.current = diffReturnContext
  }, [diffReturnContext])

  const originalContentRef = useRef('')
  const originalModelVersionRef = useRef<number | null>(null)
  const dirtyRef = useRef(false)
  const saveTimerRef = useRef<number | null>(null)
  const [fileIndexVersion, setFileIndexVersion] = useState(0)

  const modalRef = useRef<HTMLDivElement>(null)
  const contextMenuRef = useRef<HTMLDivElement>(null)
  const previewRef = useRef<HTMLDivElement>(null)
  const previewLayoutRef = useRef<HTMLDivElement>(null)
  const imagePreviewRef = useRef<HTMLImageElement | null>(null)

  const [dialog, setDialog] = useState<DialogState | null>(null)
  const [dialogInput, setDialogInput] = useState('')
  const [fileOpenChoiceDialog, setFileOpenChoiceDialog] = useState<FileOpenChoiceDialogState | null>(null)
  const dialogResolveRef = useRef<((value: boolean | string | null) => void) | null>(null)
  const fileOpenChoiceResolveRef = useRef<((value: FileOpenChoiceResult) => void) | null>(null)
  const dialogInputRef = useRef<HTMLInputElement>(null)
  const searchInputRef = useRef<HTMLInputElement>(null)
  const globalSearchInputRef = useRef<HTMLInputElement>(null)

  const editorRef = useRef<import('monaco-editor').editor.IStandaloneCodeEditor | null>(null)
  const pdfReaderRef = useRef<PdfReaderHandle | null>(null)
  const epubReaderRef = useRef<EpubReaderHandle | null>(null)
  const editorScrollDisposableRef = useRef<import('monaco-editor').IDisposable | null>(null)
  const editorCursorDisposableRef = useRef<import('monaco-editor').IDisposable | null>(null)
  const editorModelDisposableRef = useRef<import('monaco-editor').IDisposable | null>(null)
  const editorPreviewSyncSuppressTimerRef = useRef<number | null>(null)
  const previewVisibleRef = useRef(false)
  const scrollRafRef = useRef<number | null>(null)
  const suppressNextEditorScrollRef = useRef(false)
  const suppressProgrammaticEditorPreviewSyncRef = useRef(false)
  const suppressNextPreviewScrollRef = useRef(false)
  const markdownRenderTimerRef = useRef<number | null>(null)
  const markdownWorkerRef = useRef<Worker | null>(null)
  const markdownWorkerRequestIdRef = useRef(0)
  const markdownWorkerLatestIdRef = useRef(0)
  const markdownWorkerOwnerRef = useRef<string | null>(null)
  const mermaidRenderTokenRef = useRef(0)
  const mermaidRenderInFlightRef = useRef(false)
  const openFileTokenRef = useRef(0)
  const largeFileChunkTokenRef = useRef(0)
  const largeFileStateRef = useRef<LargeFileState | null>(null)
  const activeFilePathRef = useRef<string | null>(null)
  const setActiveFilePathValue = useCallback((nextPath: string | null) => {
    activeFilePathRef.current = nextPath
    setActiveFilePath(nextPath)
  }, [])
  const isBinaryRef = useRef(false)
  const isImageRef = useRef(false)
  const isSqliteRef = useRef(false)
  const isPdfRef = useRef(false)
  const isEpubRef = useRef(false)
  const isHtmlRef = useRef(false)
  const editorSaveCommandIdRef = useRef<string | null>(null)
  const debugAutoOpenRef = useRef(false)
  const pendingViewStateRef = useRef<import('monaco-editor').editor.ICodeEditorViewState | null>(null)
  const pendingViewStatePathRef = useRef<string | null>(null)
  const pendingViewStateFallbackRef = useRef<{ path: string; line: number } | null>(null)
  const pendingCursorRef = useRef<{ lineNumber: number; column: number } | null>(null)
  // Scope that seeded the pending view state / cursor. Applying is refused
  // when the editor has since switched to another Task's scope — same-root,
  // same-file Task interleaving must not replay a foreign cursor.
  const pendingViewStateScopeKeyRef = useRef<string | null>(null)
  const fileFirstVisibleLineRef = useRef<Map<string, number>>(new Map())
  const projectStateSaveTimerRef = useRef<number | null>(null)
  const hasRestoredStateRef = useRef(false)
  const restoringStateRef = useRef(false)
  // True when the in-flight restore was cancelled by THIS Task's user
  // navigation (which must win); false for interleaved cross-Task transitions,
  // whose cancellation re-arms the restore instead of silently dropping it.
  const restoreCancelledByUserRef = useRef(false)
  const restoredStateRef = useRef<ProjectEditorState | null>(null)
  const lastEditorScopeRef = useRef<ProjectEditorScope | null>(null)
  const wasOpenRef = useRef(false)
  const retainedFreshnessRequestIdRef = useRef(0)
  const projectEditorReopenStartedAtRef = useRef<number | null>(null)
  const lastProjectEditorReopenRestoreRef = useRef<ProjectEditorReopenRestoreDebug | null>(null)
  const skipClosePersistRef = useRef(false)
  // Unified soft-close snapshots, one slot per editor scope (LRU, cap 4).
  // ESC retain-view and Editor -> Diff/History switching both preserve the
  // same state shape; `kind` only records why the snapshot exists. The
  // content field keeps Monaco populated while the async reopen pipeline
  // catches up. Per-scope keying means one Task's open can no longer clobber
  // another Task's retained "instant reopen" view.
  const editorSoftCloseSnapshotsRef = useRef(new LruSnapshotStore<ProjectEditorSoftCloseSnapshot>(SOFT_CLOSE_SNAPSHOT_CAP))
  // Scope key that OPENED the current active file. The single shared editor
  // instance can display scope X's file while scope Y is current (same-root
  // Task switch); persist must never write X's file under Y's key.
  const activeFileScopeKeyRef = useRef<string | null>(null)
  const previewActiveSlugRef = useRef<string | null>(null)
  const [previewActiveSlug, setPreviewActiveSlug] = useState<string | null>(null)
  const previewScrollMemoryRef = useRef<Map<string, PreviewScrollMemory>>(new Map())
  const capturePreviewScrollMemoryRef = useRef<() => void>(() => {})
  const captureMarkdownSessionCacheRef = useRef<(reason: string) => void>(() => {})
  const applyMarkdownSessionCacheHitRef = useRef<(
    filePath: string,
    content: string,
    entry: MarkdownSessionCacheEntry
  ) => void>(() => {})
  const restorePreviewFromMemoryRef = useRef<() => boolean>(() => false)
  const syncEditorToPreviewScrollRef = useRef<() => boolean>(() => false)
  const getMermaidPreviewStateRef = useRef<() => MermaidPreviewState>(() => ({
    total: 0,
    rendered: 0,
    error: 0,
    pending: 0,
    inFlight: false
  }))
  // Most recent reveal-finalize span: cache for the autotest debug API so
  // tests measure the actual phase-machine duration without polling jitter.
  const lastPreviewRevealRef = useRef<{
    durationMs: number
    cause: 'fast-path'
    hadWork: boolean
    finalizedAt: number
  } | null>(null)
  const previewRevealHadWorkRef = useRef(false)
  const editorPreviewSyncFrameRef = useRef<number | null>(null)
  const suppressPreviewSyncOnRestoreRef = useRef(false)
  const markdownSessionCacheRenderRef = useRef<{ key: string; filePath: string; content: string } | null>(null)
  const pendingMarkdownSessionCacheRestoreRef = useRef<{ key: string; filePath: string } | null>(null)
  const markdownSessionLastRestoreRef = useRef<MarkdownSessionCacheRestoreResult>({
    mode: 'disabled',
    key: null,
    filePath: null,
    size: 0,
    limit: getMarkdownSessionCacheLimit()
  })
  const [previewRestorePhase, setPreviewRestorePhase] = useState<PreviewRestorePhase>('idle')
  const previewRestorePhaseRef = useRef<PreviewRestorePhase>('idle')
  const previewRevealFrameRef = useRef<number | null>(null)
  const previewRevealSettleFrameRef = useRef<number | null>(null)
  const fileTreeRestoreFrameRef = useRef<number | null>(null)


  const [fileTreeWidth, setFileTreeWidth] = useState(() => {
    const prefs = getUIPreferences()
    if (prefs.projectEditorFileTreeWidth !== undefined) return prefs.projectEditorFileTreeWidth
    const saved = localStorage.getItem(STORAGE_KEY_FILE_TREE_WIDTH)
    return saved ? parseInt(saved, 10) : DEFAULT_FILE_TREE_WIDTH
  })
  const fileTreeWidthRef = useRef(fileTreeWidth)
  const [isFileBrowserCollapsed, setIsFileBrowserCollapsed] = useState(() => {
    const prefs = getUIPreferences()
    if (prefs.projectEditorFileBrowserCollapsed !== undefined) return prefs.projectEditorFileBrowserCollapsed
    const saved = localStorage.getItem(STORAGE_KEY_FILE_BROWSER_COLLAPSED)
    return saved === 'true'
  })
  const isFileBrowserCollapsedRef = useRef(isFileBrowserCollapsed)
  const fileTreeContainerRef = useRef<HTMLDivElement | null>(null)
  // Auto-reveal coordination: pause for 3s after the user manually scrolls the
  // tree, and mask programmatic scrolls so they don't count as "user activity".
  const fileTreeUserScrollAtRef = useRef<number>(0)
  const fileTreeProgrammaticScrollUntilRef = useRef<number>(0)
  // Set by openFile when the call came from inside the tree itself; the
  // activeFilePath effect consumes and clears it so the reveal only fires for
  // cross-panel sources (Search / Pin / Recent / Command).
  const suppressNextRevealRef = useRef<boolean>(false)
  // When reveal runs while sidebarMode === 'search' (tree is unmounted) we
  // remember the target here and replay as soon as the tree comes back.
  const pendingRevealPathRef = useRef<string | null>(null)
  const fileTreeScrollTopRef = useRef<Map<string, number>>(new Map())
  const outlineScrollTopRef = useRef<Map<string, number>>(new Map())
  const outlineScrollByFileRef = useRef<Map<string, number>>(new Map())
  const lastOutlineDomRestoreSignatureRef = useRef<string | null>(null)
  const pendingOutlineDomRestoreRef = useRef<{ key: string; targetScrollTop: number; signature?: string } | null>(null)
  const isDraggingRef = useRef(false)

  const [modalSize, setModalSize] = useState(() => {
    const prefs = getUIPreferences()
    if (prefs.projectEditorModalSize) {
      return { width: prefs.projectEditorModalSize.width || DEFAULT_MODAL_WIDTH, height: prefs.projectEditorModalSize.height || DEFAULT_MODAL_HEIGHT }
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

  const [markdownPreviewWidth, setMarkdownPreviewWidth] = useState(() => {
    const prefs = getUIPreferences()
    if (prefs.projectEditorMarkdownPreviewWidth !== undefined) {
      const w = prefs.projectEditorMarkdownPreviewWidth
      if (Number.isFinite(w)) return Math.min(MAX_MARKDOWN_PREVIEW_WIDTH, Math.max(MIN_MARKDOWN_PREVIEW_WIDTH, w))
    }
    const savedWidth = localStorage.getItem(STORAGE_KEY_MARKDOWN_PREVIEW_WIDTH)
    if (savedWidth) {
      const w = parseInt(savedWidth, 10)
      if (Number.isFinite(w)) {
        return Math.min(MAX_MARKDOWN_PREVIEW_WIDTH, Math.max(MIN_MARKDOWN_PREVIEW_WIDTH, w))
      }
    }
    // One-time migration from old ratio system
    const savedRatio = localStorage.getItem(STORAGE_KEY_MARKDOWN_PREVIEW_RATIO)
    if (savedRatio) {
      const ratio = parseFloat(savedRatio)
      if (Number.isFinite(ratio) && ratio >= MIN_MARKDOWN_PREVIEW_RATIO && ratio <= MAX_MARKDOWN_PREVIEW_RATIO) {
        const migrated = Math.round(ratio * DEFAULT_MODAL_WIDTH)
        return Math.min(MAX_MARKDOWN_PREVIEW_WIDTH, Math.max(MIN_MARKDOWN_PREVIEW_WIDTH, migrated))
      }
    }
    return DEFAULT_MARKDOWN_PREVIEW_WIDTH
  })
  const markdownPreviewWidthRef = useRef(markdownPreviewWidth)
  const isPreviewDraggingRef = useRef(false)

  const [isOutlineVisible, setIsOutlineVisible] = useState(() => {
    const prefs = getUIPreferences()
    if (prefs.projectEditorOutlineVisible !== undefined) return prefs.projectEditorOutlineVisible
    const saved = localStorage.getItem(STORAGE_KEY_OUTLINE_VISIBLE)
    return saved === null ? true : saved === 'true'
  })
  const isOutlineVisibleRef = useRef(isOutlineVisible)
  const [outlineWidth, setOutlineWidth] = useState(() => {
    const prefs = getUIPreferences()
    if (prefs.projectEditorOutlineWidth !== undefined) {
      const w = prefs.projectEditorOutlineWidth
      if (Number.isFinite(w)) return Math.min(MAX_OUTLINE_WIDTH, Math.max(MIN_OUTLINE_WIDTH, w))
    }
    const saved = localStorage.getItem(STORAGE_KEY_OUTLINE_WIDTH)
    const w = saved ? parseInt(saved, 10) : DEFAULT_OUTLINE_WIDTH
    if (!Number.isFinite(w)) return DEFAULT_OUTLINE_WIDTH
    return Math.max(MIN_OUTLINE_WIDTH, w)
  })
  const outlineWidthRef = useRef(outlineWidth)
  const isOutlineDraggingRef = useRef(false)
  const [outlineTarget, setOutlineTarget] = useState<OutlineTarget>(() => {
    const prefs = getUIPreferences()
    if (prefs.projectEditorOutlineTarget) return prefs.projectEditorOutlineTarget
    const saved = localStorage.getItem(STORAGE_KEY_OUTLINE_TARGET)
    return saved === 'preview' ? 'preview' : 'editor'
  })
  const outlineTargetRef = useRef<OutlineTarget>(outlineTarget)
  const monacoRef = useRef<typeof import('monaco-editor') | null>(null)

  const restoreTokenRef = useRef(0)
  /** Unified per-file position & view state memory. Key = normalized file path (no scope). */
  const fileMemoryRef = useRef<Map<string, import('../../types/tab').FileViewMemory>>(new Map())
  const [missingFileNotice, setMissingFileNotice] = useState<{
    path: string
    message: string
  } | null>(null)
  const missingFileNoticeRef = useRef<typeof missingFileNotice>(null)
  const isOpenRef = useRef(isOpen)

  useEffect(() => {
    missingFileNoticeRef.current = missingFileNotice
  }, [missingFileNotice])

  useEffect(() => {
    isOpenRef.current = isOpen
  }, [isOpen])

  useEffect(() => {
    previewRestorePhaseRef.current = previewRestorePhase
  }, [previewRestorePhase])

  const cancelPreviewRevealFrames = useCallback(() => {
    if (previewRevealFrameRef.current !== null) {
      window.clearTimeout(previewRevealFrameRef.current)
      previewRevealFrameRef.current = null
    }
    if (previewRevealSettleFrameRef.current !== null) {
      window.clearTimeout(previewRevealSettleFrameRef.current)
      previewRevealSettleFrameRef.current = null
    }
  }, [])

	  const cancelEditorPreviewSyncFrame = useCallback(() => {
	    if (editorPreviewSyncFrameRef.current !== null) {
	      window.cancelAnimationFrame(editorPreviewSyncFrameRef.current)
	      window.clearTimeout(editorPreviewSyncFrameRef.current)
	      editorPreviewSyncFrameRef.current = null
	    }
	  }, [])

  const cancelPreviewSyncFrame = useCallback(() => {
    if (scrollRafRef.current !== null) {
      window.cancelAnimationFrame(scrollRafRef.current)
      scrollRafRef.current = null
    }
  }, [])

  const finalizeProjectEditorReopenRestore = useCallback((
    cause: ProjectEditorReopenRestoreDebug['cause'],
    filePath: string | null,
    markdownCacheMode: MarkdownSessionCacheRestoreResult['mode'] | null
  ) => {
    const startedAt = projectEditorReopenStartedAtRef.current ?? performance.now()
    const finalizedAt = performance.now()
    const durationMs = +(finalizedAt - startedAt).toFixed(1)
    const event: ProjectEditorReopenRestoreDebug = {
      durationMs,
      cause,
      filePath,
      markdownCacheMode,
      finalizedAt
    }
    lastProjectEditorReopenRestoreRef.current = event
    projectEditorReopenStartedAtRef.current = null
    perfTrace(PERF_TRACE_EVENT.RENDERER_PROJECT_EDITOR_REOPEN_RESTORE, {
      cause,
      durationMs,
      filePathLen: filePath?.length ?? 0,
      markdownCacheMode
    })
  }, [])

  const scheduleEditorSyncFromPreview = useCallback((onSettled?: (synced: boolean) => void) => {
	    cancelEditorPreviewSyncFrame()
	    let attempts = 0
	    const maxAttempts = 120

    const apply = () => {
      editorPreviewSyncFrameRef.current = null
      if (syncEditorToPreviewScrollRef.current()) {
        onSettled?.(true)
        return
      }
      attempts += 1
      if (attempts >= maxAttempts) {
        onSettled?.(false)
        return
      }
	      editorPreviewSyncFrameRef.current = window.setTimeout(apply, 50)
	    }

	    editorPreviewSyncFrameRef.current = window.setTimeout(apply, 0)
	  }, [cancelEditorPreviewSyncFrame])

  const resetPreviewRestoreState = useCallback(() => {
    cancelPreviewRevealFrames()
    cancelEditorPreviewSyncFrame()
    cancelPreviewSyncFrame()
    suppressPreviewSyncOnRestoreRef.current = false
    previewRestorePhaseRef.current = 'idle'
    setPreviewRestorePhase('idle')
  }, [cancelEditorPreviewSyncFrame, cancelPreviewRevealFrames, cancelPreviewSyncFrame])

  const beginPreviewRestore = useCallback(() => {
    cancelPreviewRevealFrames()
    cancelPreviewSyncFrame()
    suppressPreviewSyncOnRestoreRef.current = true
    previewRevealHadWorkRef.current = false
    previewRestorePhaseRef.current = 'waiting-html'
    setPreviewRestorePhase('waiting-html')
    mdpTrace('phase:waiting-html', { from: 'beginPreviewRestore' })
  }, [cancelPreviewRevealFrames, cancelPreviewSyncFrame])

  // Set by applyPendingViewState when a markdown reopen restores the editor's
  // viewState while the preview restore is still in flight (phase !== 'idle').
  // The editor->preview alignment can't run yet (the preview hasn't settled), so
  // it is DEFERRED until the reveal finalizes — see finalize() below. Without the
  // defer, the editor stays at its viewState scroll while the preview restores to
  // the saved anchor, and the editor's settle-scroll then drags the preview back
  // off the saved section (the PMSR-10/11 cold-reopen desync).
  const pendingEditorSyncFromPreviewRef = useRef(false)
  const previewScrollReconcileTimerRef = useRef<number | null>(null)

  // Re-assert the saved preview scroll for a bounded window after a markdown
  // reopen, defeating the editor-re-mount / root-reload preview<-editor sync that
  // would otherwise leave the preview at the top (PMSR-10/11). Reads the live
  // saved memory each tick, so a genuine user scroll (which updates that memory)
  // is followed, not fought; stops once the preview holds the saved section or the
  // window elapses.
  const startPreviewScrollReconcile = useCallback(() => {
    if (previewScrollReconcileTimerRef.current !== null) {
      window.clearInterval(previewScrollReconcileTimerRef.current)
      previewScrollReconcileTimerRef.current = null
    }
    const startedAt = performance.now()
    previewScrollReconcileTimerRef.current = window.setInterval(() => {
      const preview = previewRef.current
      const key = getFileScrollKey(lastEditorScopeRef.current, activeFilePathRef.current)
      const memory = key ? previewScrollMemoryRef.current.get(key) : undefined
      const target = memory?.scrollTop ?? 0
      const elapsed = performance.now() - startedAt
      const stop = () => {
        if (previewScrollReconcileTimerRef.current !== null) {
          window.clearInterval(previewScrollReconcileTimerRef.current)
          previewScrollReconcileTimerRef.current = null
        }
      }
      // End the window when it elapses, the preview/editor is gone, or there is no
      // meaningful saved scroll left to protect.
      if (
        !preview ||
        !isMarkdownEditorVisibleRef.current ||
        !previewVisibleRef.current ||
        elapsed > PREVIEW_SCROLL_RECONCILE_MS ||
        target <= PREVIEW_SCROLL_RECONCILE_TOLERANCE
      ) {
        stop()
        return
      }
      // A reveal/render is mid-flight — let it settle before judging the position.
      if (previewRestorePhaseRef.current !== 'idle') return
      if (preview.scrollTop > PREVIEW_SCROLL_RECONCILE_TOLERANCE) {
        // Not stranded at the top. If it moved FAR from the saved target it is a
        // genuine user scroll — yield and stop. Otherwise (holding the saved
        // section) keep monitoring, because a LATE root-reload / preview re-mount
        // can still reset it to the top within this window (PMSR-10/11).
        if (Math.abs(preview.scrollTop - target) > PREVIEW_SCROLL_RECONCILE_TOLERANCE) {
          stop()
        }
        return
      }
      // preview.scrollTop ~ 0 while a meaningful saved scroll exists: the cold-reopen
      // re-mount / preview<-editor sync stranded the preview at the top. Re-assert
      // the saved scroll + editor alignment with the preview<-editor sync suppressed
      // so it cannot immediately undo this. ONLY this drift-to-top case is corrected,
      // so a user scrolling to any other position is never fought.
      suppressProgrammaticEditorPreviewSyncRef.current = true
      restorePreviewFromMemoryRef.current()
      scheduleEditorSyncFromPreview()
      mdpTrace('preview-scroll-reconcile', { target, live: preview.scrollTop })
    }, PREVIEW_SCROLL_RECONCILE_INTERVAL_MS)
  }, [scheduleEditorSyncFromPreview])

  const queuePreviewReveal = useCallback(() => {
    cancelPreviewRevealFrames()
    cancelPreviewSyncFrame()
    suppressPreviewSyncOnRestoreRef.current = true
    const revealStart = performance.now()
    mdpTrace('reveal:queued')

    const finalize = () => {
      if (previewRevealSettleFrameRef.current !== null) {
        window.clearTimeout(previewRevealSettleFrameRef.current)
        previewRevealSettleFrameRef.current = null
      }
      if (previewRestorePhaseRef.current === 'idle') return
      suppressPreviewSyncOnRestoreRef.current = false
      flushSync(() => {
        previewRestorePhaseRef.current = 'idle'
        setPreviewRestorePhase('idle')
      })
      const finalizedAt = performance.now()
      const durationMs = +(finalizedAt - revealStart).toFixed(1)
      const cause = 'fast-path' as const
      const hadWork = previewRevealHadWorkRef.current
      lastPreviewRevealRef.current = { durationMs, cause, hadWork, finalizedAt }
      perfTrace(PERF_TRACE_EVENT.RENDERER_MARKDOWN_PREVIEW_REVEAL, {
        cause,
        hadWork,
        durationMs
      })
      mdpTrace('phase:idle', { from: `queuePreviewReveal:${cause}`, durationMs })
      // Deferred editor->preview alignment: a markdown reopen restored the
      // editor's viewState while this reveal was still in flight, so the editor
      // now needs to follow the just-restored preview scroll (the preview anchor
      // is the source of truth). Running it here — after the preview settled and
      // phase is 'idle' — keeps the editor and preview consistent and stops the
      // editor's settle-scroll from dragging the preview off the saved section
      // (PMSR-10/11). syncEditorToPreviewScroll re-suppresses the editor->preview
      // direction, so this does not loop.
      if (pendingEditorSyncFromPreviewRef.current) {
        pendingEditorSyncFromPreviewRef.current = false
        scheduleEditorSyncFromPreview()
      }
    }

    const settleReveal = () => {
      const mermaidState = getMermaidPreviewStateRef.current()
      const workPending = isPreviewWorkPending({
        markdownRenderPending: markdownRenderPendingRef.current,
        workerInFlight: markdownWorkerInFlightRef.current,
        workerQueued: markdownWorkerQueuedRef.current,
        mermaidPending: mermaidState.pending,
        mermaidInFlight: mermaidRenderInFlightRef.current
      })
      if (workPending) {
        previewRevealHadWorkRef.current = true
        mdpTrace('reveal:pending', {
          markdownRenderPending: markdownRenderPendingRef.current,
          workerInFlight: markdownWorkerInFlightRef.current,
          workerQueued: markdownWorkerQueuedRef.current,
          mermaidPending: mermaidState.pending,
          mermaidInFlight: mermaidRenderInFlightRef.current
        })
        return
      }
      previewRevealSettleFrameRef.current = window.setTimeout(() => {
        previewRevealSettleFrameRef.current = null
        finalize()
      }, 0)
    }
    previewRevealFrameRef.current = window.setTimeout(() => {
      previewRevealFrameRef.current = null
      mdpTrace('reveal:innerCallback', { editorVisible: isMarkdownEditorVisibleRef.current })
      restorePreviewFromMemoryRef.current()
      const pendingCacheRestore = pendingMarkdownSessionCacheRestoreRef.current
      if (pendingCacheRestore?.filePath === activeFilePathRef.current) {
        pendingMarkdownSessionCacheRestoreRef.current = null
      }
      if (isMarkdownEditorVisibleRef.current) {
        if (!syncEditorToPreviewScrollRef.current()) {
          scheduleEditorSyncFromPreview()
        }
        settleReveal()
        return
      }
      settleReveal()
    }, 0)
  }, [cancelPreviewRevealFrames, cancelPreviewSyncFrame, scheduleEditorSyncFromPreview])

  const cancelFileTreeRestoreFrame = useCallback(() => {
    if (fileTreeRestoreFrameRef.current !== null) {
      window.cancelAnimationFrame(fileTreeRestoreFrameRef.current)
      fileTreeRestoreFrameRef.current = null
    }
  }, [])

  const restoreFileTreeScroll = useCallback(() => {
    const treeEl = fileTreeContainerRef.current
    if (!treeEl) return false
    const key = getScrollScopeKey(lastEditorScopeRef.current)
    if (!key) return false
    const target = fileTreeScrollTopRef.current.get(key)
    if (typeof target !== 'number') return false
    const maxScroll = Math.max(0, treeEl.scrollHeight - treeEl.clientHeight)
    treeEl.scrollTop = Math.max(0, Math.min(target, maxScroll))
    return true
  }, [])

  const queueFileTreeScrollRestore = useCallback(() => {
    cancelFileTreeRestoreFrame()
    let attempts = 0
    let previousMaxScroll = -1
    let stableFrames = 0
    const run = () => {
      fileTreeRestoreFrameRef.current = null
      restoreFileTreeScroll()
      attempts += 1

      const treeEl = fileTreeContainerRef.current
      const key = getScrollScopeKey(lastEditorScopeRef.current)
      const target = key ? fileTreeScrollTopRef.current.get(key) : undefined
      const maxScroll = treeEl ? Math.max(0, treeEl.scrollHeight - treeEl.clientHeight) : 0
      const clampedTarget = typeof target === 'number' ? Math.max(0, Math.min(target, maxScroll)) : null
      const applied = treeEl && clampedTarget !== null && Math.abs(treeEl.scrollTop - clampedTarget) <= 2
      const targetBeyondCurrentRange = typeof target === 'number' && target > maxScroll + 2
      if (maxScroll === previousMaxScroll) {
        stableFrames += 1
      } else {
        stableFrames = 0
        previousMaxScroll = maxScroll
      }

      const finished =
        applied &&
        (!targetBeyondCurrentRange || stableFrames >= 2)

      if (finished || attempts >= SCROLL_RESTORE_MAX_ATTEMPTS) return

      fileTreeRestoreFrameRef.current = window.requestAnimationFrame(run)
    }
    fileTreeRestoreFrameRef.current = window.requestAnimationFrame(run)
  }, [cancelFileTreeRestoreFrame, restoreFileTreeScroll])

  useEffect(() => {
    isMarkdownPreviewOpenRef.current = isMarkdownPreviewOpen
  }, [isMarkdownPreviewOpen])

  useEffect(() => {
    isMarkdownEditorVisibleRef.current = isMarkdownEditorVisible
  }, [isMarkdownEditorVisible])

  useEffect(() => {
    isMarkdownCodeWrapEnabledRef.current = isMarkdownCodeWrapEnabled
  }, [isMarkdownCodeWrapEnabled])

  useEffect(() => {
    previewSearchOpenRef.current = previewSearchOpen
  }, [previewSearchOpen])

  useEffect(() => {
    htmlPreviewSearchOpenRef.current = htmlPreviewSearchOpen
  }, [htmlPreviewSearchOpen])

  useEffect(() => {
    htmlPreviewSearchQueryRef.current = htmlPreviewSearchQuery
  }, [htmlPreviewSearchQuery])

  useEffect(() => {
    htmlPreviewSearchResultRef.current = htmlPreviewSearchResult
  }, [htmlPreviewSearchResult])

  useEffect(() => {
    htmlPreviewZoomFactorRef.current = htmlPreviewZoomFactor
  }, [htmlPreviewZoomFactor])

  useEffect(() => {
    sidebarModeRef.current = sidebarMode
  }, [sidebarMode])

  useEffect(() => {
    searchOpenRef.current = searchOpen
  }, [searchOpen])

  useEffect(() => {
    searchQueryRef.current = searchQuery
  }, [searchQuery])

  useEffect(() => {
    searchResultsRef.current = searchResults
  }, [searchResults])

  useEffect(() => {
    isOutlineVisibleRef.current = isOutlineVisible
  }, [isOutlineVisible])

  useEffect(() => {
    outlineTargetRef.current = outlineTarget
  }, [outlineTarget])

  const setMarkdownCodeWrapEnabledState = useCallback((enabled: boolean) => {
    setIsMarkdownCodeWrapEnabled(enabled)
    isMarkdownCodeWrapEnabledRef.current = enabled
    localStorage.setItem(STORAGE_KEY_MARKDOWN_CODE_WRAP, String(enabled))
  }, [])

  const setOutlineTargetPreference = useCallback((target: OutlineTarget) => {
    setOutlineTarget(target)
    outlineTargetRef.current = target
    localStorage.setItem(STORAGE_KEY_OUTLINE_TARGET, target)
  }, [])

  const setOutlineVisibleState = useCallback((visible: boolean) => {
    lastOutlineDomRestoreSignatureRef.current = null
    if (!visible) {
      const activePath = activeFilePathRef.current
      const key = getFileScrollKey(lastEditorScopeRef.current, activePath)
      const tree = modalRef.current?.querySelector('.outline-panel-tree') as HTMLDivElement | null
      if (key && tree) {
        const scrollTop = Math.max(0, tree.scrollTop)
        outlineScrollTopRef.current.set(key, scrollTop)
        if (activePath) outlineScrollByFileRef.current.set(activePath, scrollTop)
        if (scrollTop > 0) {
          pendingOutlineDomRestoreRef.current = { key, targetScrollTop: scrollTop }
        }
      }
    } else {
      const activePath = activeFilePathRef.current
      const key = getFileScrollKey(lastEditorScopeRef.current, activePath)
      const savedScrollTop = key ? outlineScrollTopRef.current.get(key) : undefined
      if (key && typeof savedScrollTop === 'number' && savedScrollTop > 0) {
        pendingOutlineDomRestoreRef.current = { key, targetScrollTop: savedScrollTop }
      }
    }
    setIsOutlineVisible(visible)
    isOutlineVisibleRef.current = visible
    localStorage.setItem(STORAGE_KEY_OUTLINE_VISIBLE, String(visible))
  }, [])

  const setMarkdownPreviewOpenState = useCallback((visible: boolean) => {
    if (!visible) {
      capturePreviewScrollMemoryRef.current()
    }
    setIsMarkdownPreviewOpen(visible)
    isMarkdownPreviewOpenRef.current = visible
	    if (visible) {
	      const activePath = activeFilePathRef.current
	      if (
	        activePath &&
	        isMarkdownPath(activePath) &&
	        !isBinaryRef.current &&
	        !isImageRef.current &&
	        !isSqliteRef.current
	      ) {
	        const root = rootRef.current
	        const cacheRead = root
	          ? readMarkdownSessionCache(root, activePath, fileContentRef.current)
	          : null
	        if (cacheRead) {
	          markdownSessionLastRestoreRef.current = cacheRead.result
	        }
	        mdpTrace('cache:read[setOpen]', {
	          mode: cacheRead?.result.mode ?? 'no-root',
	          filePath: activePath,
	          renderedHtmlLength: cacheRead?.result.renderedHtmlLength ?? 0,
	          ts: +performance.now().toFixed(1)
	        })
	        if (cacheRead?.entry) {
	          applyMarkdownSessionCacheHitRef.current(activePath, fileContentRef.current, cacheRead.entry)
	        } else {
	          beginPreviewRestore()
	        }
	        setIsMarkdownRenderEnabled(true)
	      }
	      return
	    }

    setIsMarkdownRenderEnabled(false)
    if (!isMarkdownEditorVisibleRef.current) {
      setIsMarkdownEditorVisible(true)
      isMarkdownEditorVisibleRef.current = true
      localStorage.setItem(STORAGE_KEY_MARKDOWN_EDITOR_VISIBLE, 'true')
    }
	  }, [beginPreviewRestore])

  const setMarkdownEditorVisibleState = useCallback((visible: boolean) => {
    setIsMarkdownEditorVisible(visible)
    isMarkdownEditorVisibleRef.current = visible
    localStorage.setItem(STORAGE_KEY_MARKDOWN_EDITOR_VISIBLE, String(visible))
    if (visible) {
      const activePath = activeFilePathRef.current
      if (
        activePath &&
        isMarkdownPath(activePath) &&
        isMarkdownPreviewOpenRef.current &&
        !isBinaryRef.current &&
        !isImageRef.current &&
        !isSqliteRef.current
      ) {
        scheduleEditorSyncFromPreview()
      }
    }
    if (!visible && !isMarkdownPreviewOpenRef.current) {
      setIsMarkdownPreviewOpen(true)
      isMarkdownPreviewOpenRef.current = true
      if (activeFilePathRef.current && isMarkdownPath(activeFilePathRef.current)) {
        beginPreviewRestore()
        setIsMarkdownRenderEnabled(true)
      } else {
        setIsMarkdownRenderEnabled(false)
      }
    }
  }, [beginPreviewRestore, scheduleEditorSyncFromPreview])

  useEffect(() => {
    fileTreeWidthRef.current = fileTreeWidth
  }, [fileTreeWidth])

  useEffect(() => {
    isFileBrowserCollapsedRef.current = isFileBrowserCollapsed
  }, [isFileBrowserCollapsed])

  const setFileBrowserCollapsedState = useCallback((collapsed: boolean, source: 'user' | 'debug' | 'restore' = 'user') => {
    isFileBrowserCollapsedRef.current = collapsed
    setIsFileBrowserCollapsed(collapsed)
    localStorage.setItem(STORAGE_KEY_FILE_BROWSER_COLLAPSED, String(collapsed))
    updateUIPreferences({ projectEditorFileBrowserCollapsed: collapsed })
    perfTrace(PERF_TRACE_EVENT.RENDERER_PROJECT_FILE_BROWSER_COLLAPSE, {
      collapsed,
      source,
      sidebarMode: sidebarModeRef.current,
      fileTreeWidth: fileTreeWidthRef.current
    })
  }, [updateUIPreferences])

  const editorFontSize = useMemo(() => {
    if (!_terminalId) return DEFAULT_GIT_DIFF_FONT_SIZE
    return getTerminalStyle(_terminalId)?.gitDiffFontSize ?? DEFAULT_GIT_DIFF_FONT_SIZE
  }, [getTerminalStyle, _terminalId])

  const isMarkdownFile = useMemo(() => isMarkdownPath(activeFilePath), [activeFilePath])
  const isHtmlFile = useMemo(() => isHtml || isHtmlPath(activeFilePath), [activeFilePath, isHtml])
  const isSourcePreviewFile = isMarkdownFile || isHtmlFile
  const editorLanguage = useMemo(() => resolveMonacoLanguage(activeFilePath), [activeFilePath])
  const isMarkdownPreviewVisible = isMarkdownFile && isMarkdownPreviewOpen && !isBinary && !isImage && !isSqlite
  const isHtmlPreviewVisible = isHtmlFile && isMarkdownPreviewOpen && !isBinary && !isImage && !isSqlite
  const htmlPreviewUrlWithReload = useMemo(() => {
    if (!isHtmlPreviewVisible) return null
    return withHtmlPreviewReloadKey(htmlPreviewUrl, htmlPreviewReloadKey)
  }, [htmlPreviewReloadKey, htmlPreviewUrl, isHtmlPreviewVisible])
  const htmlPreviewZoomPercent = useMemo(() => formatHtmlPreviewZoomPercent(htmlPreviewZoomFactor), [htmlPreviewZoomFactor])
  const htmlPreviewRefreshShortcutLabel = window.electronAPI.platform === 'darwin' ? '⌘R' : 'Ctrl+R'
  const htmlPreviewNav = useMemo(() => deriveHtmlPreviewNavButtonState({
    ready: Boolean(htmlReaderState?.ready && !htmlReaderState.error),
    canGoBack: htmlReaderState?.canGoBack ?? false,
    canGoForward: htmlReaderState?.canGoForward ?? false,
    currentUrl: htmlReaderState?.url ?? null,
    homeUrl: htmlPreviewUrlWithReload
  }), [htmlPreviewUrlWithReload, htmlReaderState])
  const isMarkdownRenderAllowed = isMarkdownPreviewVisible && isMarkdownRenderEnabled
  const isMarkdownWorkerActive = isOpen && isMarkdownRenderAllowed
  const isPreviewContentVisible =
    isMarkdownRenderAllowed &&
    (previewRestorePhase === 'idle' || previewRestorePhase === 'revealing')
  const markdownRootPath = useMemo(() => (rootPath ? normalizePath(rootPath) : ''), [rootPath])
  const markdownBaseRelativeDir = useMemo(() => {
    if (!activeFilePath) return ''
    const normalized = normalizePath(activeFilePath)
    const lastSlash = normalized.lastIndexOf('/')
    return lastSlash >= 0 ? normalized.slice(0, lastSlash) : ''
  }, [activeFilePath])

  const handlePreviewCopy = useCallback((event: React.ClipboardEvent<HTMLDivElement>) => {
    const selectedText = window.getSelection()?.toString()
    if (!selectedText) return
    event.clipboardData.setData('text/plain', selectedText)
    event.preventDefault()
  }, [])

  const getMarkdownCodeWrapDebugState = useCallback((): MarkdownCodeWrapDebugState => {
    const preview = previewRef.current
    const blockCode = preview?.querySelector('pre code') as HTMLElement | null
    const inlineCode = Array.from(preview?.querySelectorAll('code') ?? []).find(
      (element) => element.parentElement?.tagName !== 'PRE'
    ) as HTMLElement | undefined

    const blockStyle = blockCode ? window.getComputedStyle(blockCode) : null
    const inlineStyle = inlineCode ? window.getComputedStyle(inlineCode) : null

    return {
      enabled: isMarkdownCodeWrapEnabledRef.current,
      previewClassName: preview?.className ?? null,
      blockWhiteSpace: blockStyle?.whiteSpace ?? null,
      blockOverflowWrap: blockStyle?.overflowWrap ?? null,
      inlineWhiteSpace: inlineStyle?.whiteSpace ?? null,
      inlineOverflowWrap: inlineStyle?.overflowWrap ?? null
    }
  }, [])

  const getMermaidPreviewState = useCallback((): MermaidPreviewState => {
    const preview = previewRef.current
    if (!preview) {
      return {
        total: 0,
        rendered: 0,
        error: 0,
        pending: 0,
        inFlight: mermaidRenderInFlightRef.current
      }
    }

    const diagrams = Array.from(preview.querySelectorAll<HTMLElement>('.mermaid-diagram[data-mermaid-id]'))
    const rendered = diagrams.filter((diagram) => diagram.classList.contains('mermaid-rendered')).length
    const error = diagrams.filter((diagram) => diagram.classList.contains('mermaid-error')).length
    return {
      total: diagrams.length,
      rendered,
      error,
      pending: Math.max(0, diagrams.length - rendered - error),
      inFlight: mermaidRenderInFlightRef.current
    }
  }, [])

  useEffect(() => {
    getMermaidPreviewStateRef.current = getMermaidPreviewState
  }, [getMermaidPreviewState])

  const scanPreviewNearestSlug = useCallback((): string | null => {
    const preview = previewRef.current
    if (!preview) return null
    let nearestSlug: string | null = null
    const headings = preview.querySelectorAll('h1[id],h2[id],h3[id],h4[id],h5[id],h6[id]')
    const containerRect = preview.getBoundingClientRect()
    for (const heading of headings) {
      const rect = (heading as HTMLElement).getBoundingClientRect()
      if (rect.top - containerRect.top <= 10) {
        nearestSlug = (heading as HTMLElement).id
      }
    }
    return nearestSlug
  }, [])

  const updatePreviewActiveSlug = useCallback((slug: string | null) => {
    if (slug === previewActiveSlugRef.current) return
    previewActiveSlugRef.current = slug
    setPreviewActiveSlug(slug)
  }, [])

  const isPreviewContentVisibleNow = useCallback(() => {
    const phase = previewRestorePhaseRef.current
    if (phase !== 'idle' && phase !== 'revealing') return false
    return Boolean(
      activeFilePathRef.current &&
      isMarkdownPath(activeFilePathRef.current) &&
      isMarkdownPreviewOpenRef.current &&
      !isBinaryRef.current &&
      !isImageRef.current &&
      !isSqliteRef.current &&
      previewRef.current
    )
  }, [])

  const editorPaneStyle = useMemo(() => ({ flex: '1 1 0%' }), [])

  const previewPaneStyle = useMemo(() => {
    if (!isMarkdownEditorVisible) {
      return { flex: '1 1 0%' }
    }
    return {
      flex: `0 1 ${markdownPreviewWidth}px`,
      minWidth: MIN_MARKDOWN_PREVIEW_WIDTH
    }
  }, [isMarkdownEditorVisible, markdownPreviewWidth])

  const outlinePaneStyle = useMemo(() => {
    return {
      flex: `0 1 ${outlineWidth}px`,
      minWidth: MIN_OUTLINE_WIDTH
    }
  }, [outlineWidth])

  // PDFs and EPUBs are flagged as binary by the backend (their raw bytes are
  // binary even though the reader renders them richly). Allow the outline for
  // those two file types explicitly so the unified OutlinePanel can drive
  // PDF / EPUB navigation.
  const outlineShowInSplit =
    isOutlineVisible &&
    (isPdf || isEpub || (!isBinary && !isImage && !isSqlite)) &&
    !!activeFilePath
  const outlineShowInSplitRef = useRef(outlineShowInSplit)
  useEffect(() => {
    outlineShowInSplitRef.current = outlineShowInSplit
  }, [outlineShowInSplit])

  const { symbols: outlineSymbols, activeItem: outlineActiveItem, isLoading: outlineLoading } =
    useOutlineSymbols({
      editor: editorRef.current,
      filePath: activeFilePath,
      contentPath: outlineContentSnapshot.filePath,
      content: outlineContentSnapshot.filePath === activeFilePath ? outlineContentSnapshot.content : '',
      isVisible: outlineShowInSplit,
    })
  const outlineSymbolsRef = useRef(outlineSymbols)
  useEffect(() => {
    outlineSymbolsRef.current = outlineSymbols
  }, [outlineSymbols])
  useEffect(() => {
    const activePath = activeFilePathRef.current
    if (!isOpen || outlineSymbols.length === 0 || !activePath || !isMarkdownPath(activePath)) return
    if (!isMarkdownPreviewOpenRef.current || !isMarkdownEditorVisibleRef.current || !previewVisibleRef.current) return
    const previewKey = getFileScrollKey(lastEditorScopeRef.current, activePath)
    if (!previewActiveSlugRef.current && (!previewKey || !previewScrollMemoryRef.current.has(previewKey))) return
    scheduleEditorSyncFromPreview()
  }, [activeFilePath, isOpen, outlineSymbols.length, scheduleEditorSyncFromPreview])
  const outlineActiveItemRef = useRef(outlineActiveItem)
  useEffect(() => {
    outlineActiveItemRef.current = outlineActiveItem
  }, [outlineActiveItem])
  const epubOutlineSymbolsRef = useRef(epubOutlineSymbols)
  useEffect(() => {
    epubOutlineSymbolsRef.current = epubOutlineSymbols
  }, [epubOutlineSymbols])

  // For PDF: deepest outline item whose `target.page` is <= current page.
  // Mirrors how a reader would expect the outline to track their position:
  // the current chapter / section stays highlighted as they scroll within it.
  const pdfActiveItem = useMemo<OutlineItem | null>(() => {
    if (!isPdf || pdfOutlineSymbols.length === 0) return null
    let best: OutlineItem | null = null
    let bestPage = 0
    const walk = (list: OutlineItem[]) => {
      for (const item of list) {
        if (item.target?.kind === 'pdf-page' && item.target.page <= pdfActivePage) {
          if (item.target.page >= bestPage) {
            best = item
            bestPage = item.target.page
          }
        }
        if (item.children.length > 0) walk(item.children)
      }
    }
    walk(pdfOutlineSymbols)
    return best ?? pdfOutlineSymbols[0] ?? null
  }, [isPdf, pdfActivePage, pdfOutlineSymbols])

  // For EPUB: match at the chapter level. Navigation hrefs and relocated hrefs
  // can disagree on root prefixes such as `OEBPS/`, so compare normalized
  // suffixes while preserving the original href for precise navigation.
  const epubActiveItem = useMemo<OutlineItem | null>(() => {
    if (!isEpub || !epubActiveHref || epubOutlineSymbols.length === 0) return null
    const target = epubActiveHref
    let found: OutlineItem | null = null
    const walk = (list: OutlineItem[]) => {
      for (const item of list) {
        if (found) return
        if (item.target?.kind === 'epub-href' && epubHrefMatchesOutlineItem(item.target.href, target)) {
          found = item
          return
        }
        if (item.children.length > 0) walk(item.children)
      }
    }
    walk(epubOutlineSymbols)
    return found
  }, [isEpub, epubActiveHref, epubOutlineSymbols])

  const expandedDirs = useMemo(() => collectExpandedPaths(tree), [tree])
  const quickFileLabels = useMemo(() => {
    return buildQuickFileLabels([...pinnedFiles, ...recentFiles])
  }, [pinnedFiles, recentFiles])

  const visiblePinnedFiles = useMemo(
    () => pinnedFiles.slice(0, visiblePinCount),
    [pinnedFiles, visiblePinCount]
  )
  const overflowPinnedFiles = useMemo(
    () => visiblePinCount < pinnedFiles.length ? pinnedFiles.slice(visiblePinCount) : [],
    [pinnedFiles, visiblePinCount]
  )
  const visibleRecentFiles = useMemo(
    () => recentFiles.slice(0, visibleRecentCount),
    [recentFiles, visibleRecentCount]
  )
  const overflowRecentFiles = useMemo(
    () => visibleRecentCount < recentFiles.length ? recentFiles.slice(visibleRecentCount) : [],
    [recentFiles, visibleRecentCount]
  )

  const isMissingFileError = useCallback((error?: string) => {
    if (!error) return false
    const lower = error.toLowerCase()
    return (
      error.includes('ENOENT') ||
      lower.includes('no such file') ||
      lower.includes('cannot find the file') ||
      lower.includes('the system cannot find the file')
    )
  }, [])

  const getViewStateKey = useCallback((path: string) => {
    const scope = lastEditorScopeRef.current
    if (!scope) {
      const root = rootRef.current ?? rootPath ?? ''
      return `${root}::${path}`
    }
    return JSON.stringify([scope.terminalId, scope.cwd, path])
  }, [rootPath])

  const resolveEditorScope = useCallback((scopeOverride?: ProjectEditorScope | null): ProjectEditorScope | null => {
    if (scopeOverride) {
      return {
        terminalId: scopeOverride.terminalId,
        cwd: normalizeScopeCwd(scopeOverride.cwd)
      }
    }
    return buildProjectEditorScope(_terminalId, rootRef.current ?? rootPath ?? cwd ?? null)
  }, [_terminalId, cwd, rootPath])

  // ─── Unified per-file memory: save & restore ───

  const upsertFileMemory = useCallback((filePath: string, entry: FileViewMemory) => {
    if (!hasFileViewMemoryData(entry)) return
    fileMemoryRef.current.delete(filePath)
    fileMemoryRef.current.set(filePath, entry)
  }, [])

  const removeFileMemoryEntries = useCallback((targetPath: string) => {
    const normalizedTarget = normalizePath(targetPath.trim())
    if (!normalizedTarget) return
    for (const key of [...fileMemoryRef.current.keys()]) {
      if (key === normalizedTarget || key.startsWith(`${normalizedTarget}/`)) {
        fileMemoryRef.current.delete(key)
      }
    }
  }, [])

  const replaceFileMemoryEntries = useCallback((sourcePath: string, nextPath: string) => {
    const normalizedSource = normalizePath(sourcePath.trim())
    const normalizedNext = normalizePath(nextPath.trim())
    if (!normalizedSource || !normalizedNext || normalizedSource === normalizedNext) return

    const nextEntries: Array<[string, FileViewMemory]> = []
    let changed = false
    for (const [filePath, memory] of fileMemoryRef.current.entries()) {
      if (filePath === normalizedSource) {
        nextEntries.push([normalizedNext, memory])
        changed = true
        continue
      }
      if (filePath.startsWith(`${normalizedSource}/`)) {
        nextEntries.push([`${normalizedNext}${filePath.slice(normalizedSource.length)}`, memory])
        changed = true
        continue
      }
      nextEntries.push([filePath, memory])
    }

    if (!changed) return
    fileMemoryRef.current = new Map(nextEntries)
  }, [])

  /** Save ALL position/view state for the currently active file into fileMemoryRef. */
  const saveCurrentFileMemory = useCallback(() => {
    const filePath = activeFilePathRef.current
    if (!filePath) return
    const isBin = isBinaryRef.current
    const isImg = isImageRef.current
    const isSql = isSqliteRef.current

    const entry: FileViewMemory = {
      ...(fileMemoryRef.current.get(filePath) ?? {})
    }

    // 1. Editor view state + cursor (always attempt, even if editor is display:none)
    if (!isBin && !isImg && !isSql) {
      const editor = editorRef.current
      if (editor) {
        const vs = editor.saveViewState()
        if (vs) entry.editorViewState = vs
        const pos = editor.getPosition()
        if (pos) {
          entry.cursorLine = pos.lineNumber
          entry.cursorColumn = pos.column
        }
      }
    }

    // 2. Preview scroll (copy from real-time tracker)
    if (isMarkdownPath(filePath)) {
      const shouldCaptureLivePreview =
        isMarkdownPreviewOpenRef.current &&
        previewVisibleRef.current &&
        previewRestorePhaseRef.current === 'idle' &&
        Boolean(markdownRenderedHtmlRef.current)
      const shouldUseTrackedPreviewMemory =
        shouldCaptureLivePreview ||
        (!isMarkdownPreviewOpenRef.current && previewRestorePhaseRef.current === 'idle')
      if (shouldCaptureLivePreview) {
        capturePreviewScrollMemoryRef.current()
      }
      const scope = lastEditorScopeRef.current
      const pKey = getFileScrollKey(scope, filePath)
      const pmem = pKey ? previewScrollMemoryRef.current.get(pKey) : null
      if (pmem && (shouldUseTrackedPreviewMemory || !entry.previewScrollAnchor)) {
        entry.previewScrollAnchor = {
          slug: pmem.nearestHeadingSlug,
          ratio: pmem.scrollRatio,
          headingOffsetY: pmem.headingOffsetY,
          scrollTop: pmem.scrollTop
        }
      }
    }

    // 3. Outline scroll (copy from real-time tracker)
    const scope = lastEditorScopeRef.current
    const oKey = getFileScrollKey(scope, filePath)
    const oTop = oKey ? outlineScrollTopRef.current.get(oKey) : undefined
    if (typeof oTop === 'number') entry.outlineScrollTop = oTop

	    // 4. Markdown view mode
	    if (isMarkdownPath(filePath)) {
	      entry.isPreviewOpen = isMarkdownPreviewOpenRef.current
	      entry.isEditorVisible = isMarkdownEditorVisibleRef.current
	      entry.outlineTarget = outlineTargetRef.current
	    }

	    upsertFileMemory(filePath, entry)
	    if (isMarkdownPath(filePath)) {
	      captureMarkdownSessionCacheRef.current('file-memory')
	    }
	  }, [upsertFileMemory])

  /**
   * Capture the HTML preview's scroll offset into fileMemoryRef. Async
   * because the offset lives in the embedded browser view (IPC read) —
   * saveCurrentFileMemory is sync and cannot pick it up. `site` 'poll' rides
   * the opt-in trace channel (0.5 Hz background tracker); every other site is
   * a user-action-scale diagnostic breadcrumb.
   */
  const captureHtmlPreviewScrollMemory = useCallback(async (
    site: 'open-file' | 'close' | 'subpage-leave' | 'before-leave' | 'poll'
  ): Promise<void> => {
    const filePath = activeFilePathRef.current
    const browserId = htmlReaderStateRef.current?.browserId
    if (!filePath || !isHtmlRef.current || !browserId) return
    let scrollState: HtmlPreviewScrollState | null = null
    try {
      const scrollResult = await window.electronAPI.browser.getScrollState(browserId)
      if (!scrollResult.success) return
      scrollState = normalizeHtmlPreviewScrollState(scrollResult.state)
    } catch {
      return
    }
    if (!scrollState) return
    // The active file may have changed while the IPC round-trip was in
    // flight — never write one file's offset into another file's memory.
    if (activeFilePathRef.current !== filePath) return
    htmlPreviewScrollStateRef.current = scrollState
    const entry: FileViewMemory = {
      ...(fileMemoryRef.current.get(filePath) ?? {}),
      htmlScrollX: scrollState.x,
      htmlScrollY: scrollState.y
    }
    upsertFileMemory(filePath, entry)
    const payload = { ph: 'i', site, scrollY: Math.round(scrollState.y) }
    if (site === 'poll') {
      perfTrace(PERF_TRACE_EVENT.RENDERER_PROJECT_EDITOR_HTML_SCROLL_CAPTURED, payload)
    } else {
      perfTraceDiagnostic(PERF_TRACE_EVENT.RENDERER_PROJECT_EDITOR_HTML_SCROLL_CAPTURED, payload)
    }
  }, [upsertFileMemory])

  /** Restore ALL position/view state for a file from fileMemoryRef. */
  const restoreFileMemory = useCallback((filePath: string) => {
    pendingViewStateRef.current = null
    pendingViewStatePathRef.current = null
    pendingCursorRef.current = null
    pendingViewStateFallbackRef.current = null
    pendingViewStateScopeKeyRef.current = null

    const mem = fileMemoryRef.current.get(filePath)
    if (!mem) return

    // 1. Markdown view mode (apply immediately — affects layout before render)
    if (isMarkdownPath(filePath)) {
      if (mem.isPreviewOpen !== undefined) {
        setIsMarkdownPreviewOpen(mem.isPreviewOpen)
        isMarkdownPreviewOpenRef.current = mem.isPreviewOpen
      }
      if (mem.isEditorVisible !== undefined) {
        setIsMarkdownEditorVisible(mem.isEditorVisible)
        isMarkdownEditorVisibleRef.current = mem.isEditorVisible
      }
      if (mem.outlineTarget !== undefined) {
        setOutlineTarget(mem.outlineTarget)
        outlineTargetRef.current = mem.outlineTarget
      }
    }

    // 2. Editor view state → pending (applied when Monaco model ready)
    if (mem.editorViewState) {
      pendingViewStateRef.current = mem.editorViewState as import('monaco-editor').editor.ICodeEditorViewState
      pendingViewStatePathRef.current = filePath
      pendingViewStateScopeKeyRef.current = getScrollScopeKey(lastEditorScopeRef.current)
      if (typeof mem.cursorLine === 'number' && mem.cursorLine > 1) {
        pendingCursorRef.current = { lineNumber: mem.cursorLine, column: mem.cursorColumn ?? 1 }
        pendingViewStateFallbackRef.current = { path: filePath, line: mem.cursorLine }
      }
    } else if (typeof mem.cursorLine === 'number') {
      pendingCursorRef.current = { lineNumber: mem.cursorLine, column: mem.cursorColumn ?? 1 }
      pendingViewStatePathRef.current = filePath
      pendingViewStateScopeKeyRef.current = getScrollScopeKey(lastEditorScopeRef.current)
    }

    // 3. Preview scroll → real-time tracker (applied during preview restore cycle)
    if (mem.previewScrollAnchor) {
      const scope = lastEditorScopeRef.current
      const pKey = getFileScrollKey(scope, filePath)
      if (pKey) {
        previewScrollMemoryRef.current.set(pKey, {
          scrollRatio: mem.previewScrollAnchor.ratio,
          nearestHeadingSlug: mem.previewScrollAnchor.slug,
          headingOffsetY: mem.previewScrollAnchor.headingOffsetY ?? 0,
          scrollTop: mem.previewScrollAnchor.scrollTop ?? 0
        })
      }
    }

    // 4. Outline scroll → real-time tracker
    if (typeof mem.outlineScrollTop === 'number') {
      const scope = lastEditorScopeRef.current
      const oKey = getFileScrollKey(scope, filePath)
      if (oKey) {
        outlineScrollTopRef.current.set(oKey, mem.outlineScrollTop)
        if (mem.outlineScrollTop > 0) {
          pendingOutlineDomRestoreRef.current = { key: oKey, targetScrollTop: mem.outlineScrollTop }
        }
      }
    }

    // 5. HTML preview scroll → restoreScrollState pipeline (applied by
    // HtmlReader once the browser view finishes loading)
    if (isHtmlPath(filePath) && typeof mem.htmlScrollY === 'number') {
      updateHtmlPreviewScrollState({
        x: mem.htmlScrollX ?? 0,
        y: mem.htmlScrollY,
        scrollWidth: 0,
        scrollHeight: 0,
        clientWidth: 0,
        clientHeight: 0
      })
      perfTraceDiagnostic(PERF_TRACE_EVENT.RENDERER_PROJECT_EDITOR_HTML_SCROLL_RESTORED, {
        ph: 'i',
        scrollY: Math.round(mem.htmlScrollY)
      })
    }
  }, [updateHtmlPreviewScrollState])

  // ─── End unified per-file memory ───

  const buildProjectEditorStateSnapshot = useCallback((scope: ProjectEditorScope) => {
    const currentRootPath = rootRef.current ?? rootPath ?? null
    const rawActiveFilePath = activeFilePathRef.current
    // Cross-Task contamination guard: only persist the active file if it was
    // opened under the scope being persisted (same-root Task switches leave
    // the shared instance displaying the previous Task's file).
    const currentActiveFilePath = resolvePersistableActiveFile({
      activeFilePath: rawActiveFilePath,
      activeFileScopeKey: activeFileScopeKeyRef.current,
      persistScopeKey: getScrollScopeKey(scope)
    })
    const normalizedRootPath = currentRootPath ? normalizePath(currentRootPath) : null

    if (rawActiveFilePath && !currentActiveFilePath) {
      perfTraceDiagnostic(PERF_TRACE_EVENT.RENDERER_PROJECT_EDITOR_PERSIST_ACTIVE_FILE_GUARDED, {
        ph: 'i',
        site: 'snapshot'
      })
    } else {
      // Snapshot the current active file's state into fileMemoryRef
      saveCurrentFileMemory()
    }

    // Capture tree scroll
    const treeKey = getScrollScopeKey(scope)
    const treeEl = fileTreeContainerRef.current
    if (treeEl && treeKey) {
      fileTreeScrollTopRef.current.set(treeKey, treeEl.scrollTop)
    }
    const currentFileTreeScrollTop = treeKey ? fileTreeScrollTopRef.current.get(treeKey) : undefined

    // Capture outline scroll from the live container before persisting.
    const outlineKey = getFileScrollKey(scope, currentActiveFilePath)
    const outlineEl = (modalRef.current?.querySelector('.outline-panel-tree') ?? null) as HTMLDivElement | null
    if (outlineEl && outlineKey) {
      const pendingRestore = pendingOutlineDomRestoreRef.current
      const previousScrollTop = outlineScrollTopRef.current.get(outlineKey)
      if (shouldCaptureOutlineScrollTop({
        captureKey: outlineKey,
        pendingRestoreKey: pendingRestore?.key ?? null,
        previousScrollTop,
        nextScrollTop: outlineEl.scrollTop
      })) {
        outlineScrollTopRef.current.set(outlineKey, outlineEl.scrollTop)
      }
    }

    const activeMem = currentActiveFilePath ? fileMemoryRef.current.get(currentActiveFilePath) : null

    // Persist all opened-file memories, capped by recency.
    const fileStates: Record<string, import('../../types/tab').FileViewMemory> = {}
    const orderedFileStates = Array.from(fileMemoryRef.current.entries()).slice(-MAX_PERSISTED_FILE_STATES)
    for (const [filePath, mem] of orderedFileStates) {
      if (hasFileViewMemoryData(mem)) {
        fileStates[filePath] = mem
      }
    }

    // Use active file's data for top-level backward-compat fields
    const previewKey = getFileScrollKey(scope, currentActiveFilePath)
    const previewMem = previewKey ? previewScrollMemoryRef.current.get(previewKey) : undefined
    mdpTrace('persist:preview-scroll', {
      memScrollTop: previewMem?.scrollTop ?? -1,
      memSlug: previewMem?.nearestHeadingSlug ?? null,
      liveScrollTop: previewRef.current?.scrollTop ?? -1,
      previewVisible: previewVisibleRef.current,
      phase: previewRestorePhaseRef.current
    })
    const currentOutlineScrollTop = outlineKey ? outlineScrollTopRef.current.get(outlineKey) : undefined
    const outlineScrollByFile = buildOutlineScrollByFileState(outlineScrollByFileRef.current)

    return {
      rootPath: normalizedRootPath,
      activeFilePath: currentActiveFilePath ?? null,
      expandedDirs,
      pinnedFiles,
      recentFiles,
      editorViewState: activeMem?.editorViewState,
      cursorLine: activeMem?.cursorLine,
      cursorColumn: activeMem?.cursorColumn,
      savedAt: Date.now(),
      // UI layout state
      isPreviewOpen: isMarkdownPreviewOpenRef.current,
      isEditorVisible: isMarkdownEditorVisibleRef.current,
      isOutlineVisible: isOutlineVisibleRef.current,
      outlineTarget: outlineTargetRef.current,
      fileTreeWidth: fileTreeWidthRef.current,
      previewWidth: markdownPreviewWidthRef.current,
      outlineWidth: outlineWidthRef.current,
      modalWidth: modalSizeRef.current.width,
      modalHeight: modalSizeRef.current.height,
      // Scroll positions
      previewScrollAnchor: previewMem
        ? {
            slug: previewMem.nearestHeadingSlug,
            ratio: previewMem.scrollRatio,
            headingOffsetY: previewMem.headingOffsetY,
            scrollTop: previewMem.scrollTop
          }
        : undefined,
      fileTreeScrollTop: currentFileTreeScrollTop,
      outlineScrollTop: currentOutlineScrollTop,
      outlineScrollByFile,
      // Per-file state memory
      fileStates: Object.keys(fileStates).length > 0 ? fileStates : undefined
    }
  }, [expandedDirs, pinnedFiles, recentFiles, rootPath, saveCurrentFileMemory])

  const persistProjectEditorState = useCallback((
    scopeOverride?: ProjectEditorScope | null,
    options?: { flush?: boolean }
  ) => {
    const scope = resolveEditorScope(scopeOverride)
    if (!scope) return
    const snapshot = buildProjectEditorStateSnapshot(scope)
    const activeMem = snapshot.activeFilePath ? fileMemoryRef.current.get(snapshot.activeFilePath) : null

    if (DEBUG_PROJECT_EDITOR) {
      debugLog('project-state:persist', {
        terminalId: scope.terminalId,
        cwd: scope.cwd,
        rootPath: snapshot.rootPath,
        activeFilePath: snapshot.activeFilePath ?? null,
        hasViewState: Boolean(activeMem?.editorViewState),
        cursorLine: activeMem?.cursorLine ?? null,
        expandedCount: expandedDirs.length,
        pinnedCount: pinnedFiles.length,
        recentCount: recentFiles.length,
        fileMemoryCount: fileMemoryRef.current.size
      })
    }

    if (options?.flush) {
      flushProjectEditorState(scope, snapshot)
      return
    }
    setProjectEditorState(scope, snapshot)
  }, [buildProjectEditorStateSnapshot, expandedDirs, flushProjectEditorState, pinnedFiles, recentFiles, resolveEditorScope, setProjectEditorState])

  const scheduleProjectStateSave = useCallback((scopeOverride?: ProjectEditorScope | null) => {
    const scope = resolveEditorScope(scopeOverride)
    if (!scope || !isOpen) return
    if (DEBUG_PROJECT_EDITOR) {
      perfCountersRef.current.projectStateSave += 1
    }
    if (projectStateSaveTimerRef.current) {
      window.clearTimeout(projectStateSaveTimerRef.current)
    }
    projectStateSaveTimerRef.current = window.setTimeout(() => {
      projectStateSaveTimerRef.current = null
      persistProjectEditorState(scope)
    }, PROJECT_STATE_SAVE_DEBOUNCE_MS)
  }, [isOpen, persistProjectEditorState, resolveEditorScope])

  const cancelMarkdownIdle = useCallback(() => {
    if (markdownIdleHandleRef.current === null) return
    const cancelIdle = (window as Window & { cancelIdleCallback?: (id: number) => void }).cancelIdleCallback
    if (cancelIdle) {
      cancelIdle(markdownIdleHandleRef.current)
    } else {
      window.clearTimeout(markdownIdleHandleRef.current)
    }
    markdownIdleHandleRef.current = null
  }, [])

  const applyMarkdownSessionCacheHit = useCallback((
    filePath: string,
    content: string,
    entry: MarkdownSessionCacheEntry
  ) => {
    mdpTraceReset()
    mdpTrace('cacheHit:start', {
      filePath,
      htmlLength: entry.renderedHtml.length,
      imageCount: entry.imagePaths.length
    })
    if (markdownRenderTimerRef.current) {
      window.clearTimeout(markdownRenderTimerRef.current)
      markdownRenderTimerRef.current = null
    }
    cancelMarkdownIdle()
    markdownApplyRequestIdRef.current += 1
    markdownPendingPayloadRef.current = null
    markdownWorkerInFlightRef.current = false
    markdownWorkerQueuedRef.current = false
    markdownSessionCacheRenderRef.current = {
      key: entry.key,
      filePath,
      content
    }
    pendingMarkdownSessionCacheRestoreRef.current = {
      key: entry.key,
      filePath
    }
    markdownRenderSourceRef.current = content
    setMarkdownRenderSource(content)
    markdownImageMapRef.current = entry.imageMap
    setMarkdownImageMap(entry.imageMap)
    setMarkdownImagePaths(entry.imagePaths)
    markdownRenderedHtmlRef.current = entry.renderedHtml
    setMarkdownRenderedHtml(entry.renderedHtml)
    // Force the mermaid-render + restore-layout effects to re-run even when the
    // HTML string is byte-identical to the prior value (retained-close ->
    // first-reopen no-op set). Without this bump those effects never fire and
    // the mermaid diagram stays at pending>0, hanging the reopen restore.
    setMarkdownPreviewRenderNonce((nonce) => nonce + 1)
    setMarkdownRenderPending(false)
    mdpTrace('cacheHit:setHtml')
    const pKey = getFileScrollKey(lastEditorScopeRef.current, filePath)
    const currentFileMemory = fileMemoryRef.current.get(filePath)
    const currentPreviewMemory = pKey ? previewScrollMemoryRef.current.get(pKey) : undefined
    const currentPreviewAnchor = currentFileMemory?.previewScrollAnchor
    // Prefer an already-seeded LIVE scroll memory that carries a real position
    // (scrollTop > 0 or a heading slug) over the file-memory anchor: on a
    // project-editor reopen, applyStoredProjectEditorState seeds the live memory
    // from the persisted top-level previewScrollAnchor (the freshest saved
    // position), and this cache-hit re-apply must NOT clobber it with a possibly
    // stale per-file anchor (which left the preview scrolled to top — PMSR-10/11).
    const liveMemoryHasPosition = Boolean(
      currentPreviewMemory &&
      (currentPreviewMemory.scrollTop > 0 || currentPreviewMemory.nearestHeadingSlug)
    )
    mdpTrace('cacheHit:seed-scroll', {
      liveScrollTop: currentPreviewMemory?.scrollTop ?? -1,
      liveSlug: currentPreviewMemory?.nearestHeadingSlug ?? null,
      anchorScrollTop: currentPreviewAnchor?.scrollTop ?? -1,
      anchorSlug: currentPreviewAnchor?.slug ?? null,
      entryScrollTop: entry.previewScrollMemory?.scrollTop ?? -1,
      keptLive: liveMemoryHasPosition
    })
    if (liveMemoryHasPosition) {
      // Keep the live memory — do not overwrite a good restored position.
    } else if (pKey && currentPreviewAnchor) {
      previewScrollMemoryRef.current.set(pKey, {
        scrollRatio: currentPreviewAnchor.ratio,
        nearestHeadingSlug: currentPreviewAnchor.slug,
        headingOffsetY: currentPreviewAnchor.headingOffsetY ?? 0,
        scrollTop: currentPreviewAnchor.scrollTop ?? 0
      })
    } else if (pKey && entry.previewScrollMemory && !currentPreviewMemory) {
      previewScrollMemoryRef.current.set(pKey, entry.previewScrollMemory)
    }
    const oKey = getFileScrollKey(lastEditorScopeRef.current, filePath)
    const currentOutlineScrollTop =
      typeof currentFileMemory?.outlineScrollTop === 'number'
        ? currentFileMemory.outlineScrollTop
        : oKey
          ? outlineScrollTopRef.current.get(oKey)
          : undefined
    if (typeof currentOutlineScrollTop === 'number') {
      if (oKey) {
        outlineScrollTopRef.current.set(oKey, currentOutlineScrollTop)
        if (currentOutlineScrollTop > 0) {
          pendingOutlineDomRestoreRef.current = { key: oKey, targetScrollTop: currentOutlineScrollTop }
        }
      }
      outlineScrollByFileRef.current.set(filePath, currentOutlineScrollTop)
    } else if (typeof entry.outlineScrollTop === 'number') {
      if (oKey) {
        outlineScrollTopRef.current.set(oKey, entry.outlineScrollTop)
        if (entry.outlineScrollTop > 0) {
          pendingOutlineDomRestoreRef.current = { key: oKey, targetScrollTop: entry.outlineScrollTop }
        }
      }
      outlineScrollByFileRef.current.set(filePath, entry.outlineScrollTop)
    }
    if (entry.fileMemory) {
      upsertFileMemory(filePath, {
        ...entry.fileMemory,
        ...currentFileMemory,
        previewScrollAnchor: currentFileMemory?.previewScrollAnchor ?? entry.fileMemory.previewScrollAnchor,
        isPreviewOpen: isMarkdownPreviewOpenRef.current,
        isEditorVisible: isMarkdownEditorVisibleRef.current,
        outlineTarget: outlineTargetRef.current
      })
    }
    beginPreviewRestore()
    updatePreviewActiveSlug(entry.previewScrollMemory?.nearestHeadingSlug ?? null)
    queuePreviewReveal()
  }, [
    beginPreviewRestore,
    cancelMarkdownIdle,
    queuePreviewReveal,
    updatePreviewActiveSlug,
    upsertFileMemory
  ])

  useEffect(() => {
    applyMarkdownSessionCacheHitRef.current = applyMarkdownSessionCacheHit
  }, [applyMarkdownSessionCacheHit])

  const applyPendingCursorPosition = useCallback((options?: { reveal?: boolean }) => {
    if (!pendingCursorRef.current) return true
    const editor = editorRef.current
    if (!editor) return false
    const model = editor.getModel()
    if (!model) return false
    const { lineNumber, column } = clampCursorPosition({
      lineNumber: pendingCursorRef.current.lineNumber,
      column: pendingCursorRef.current.column,
      lineCount: model.getLineCount(),
      getLineMaxColumn: (line) => model.getLineMaxColumn(line)
    })
    if (DEBUG_PROJECT_EDITOR) {
      debugLog('restore:cursor', { line: lineNumber, column })
    }
    const currentPosition = editor.getPosition()
    const cursorChanged = !currentPosition
      || currentPosition.lineNumber !== lineNumber
      || currentPosition.column !== column
    if (cursorChanged) {
      editor.setPosition({ lineNumber, column })
    }
    if (options?.reveal !== false && cursorChanged) {
      editor.revealLineInCenter(lineNumber)
    }
    pendingCursorRef.current = null
    return true
  }, [])

  const isEditorModelMatchingPath = useCallback((path: string | null) => {
    if (!path) return false
    const modelPath = editorRef.current?.getModel()?.uri.path
    if (!modelPath) return false
    const normalizedModelPath = normalizePath(decodeURIComponent(modelPath))
    const normalizedTargetPath = normalizePath(path)
    const root = rootRef.current ? normalizePath(rootRef.current) : null
    const absoluteTargetPath = root
      ? normalizePath(`${root}/${normalizedTargetPath}`)
      : normalizedTargetPath
    if (normalizedModelPath === absoluteTargetPath) return true
    return normalizedModelPath.endsWith(`/${normalizedTargetPath}`)
  }, [])

  const applyPendingViewState = useCallback(() => {
    const editor = editorRef.current
    if (!editor) return false
    const model = editor.getModel()
    if (!model) return false
    const pendingScopeKey = pendingViewStateScopeKeyRef.current
    if (pendingScopeKey && pendingScopeKey !== getScrollScopeKey(lastEditorScopeRef.current)) {
      // The pendings were seeded for another Task's scope — discard rather
      // than replaying a foreign cursor into this Task's view of the file.
      perfTraceDiagnostic(PERF_TRACE_EVENT.RENDERER_PROJECT_EDITOR_PERSIST_ACTIVE_FILE_GUARDED, {
        ph: 'i',
        site: 'pending-discard'
      })
      pendingViewStateRef.current = null
      pendingCursorRef.current = null
      pendingViewStatePathRef.current = null
      pendingViewStateFallbackRef.current = null
      pendingViewStateScopeKeyRef.current = null
      return false
    }
    const pendingPath = pendingViewStatePathRef.current
    if (pendingPath && !isEditorModelMatchingPath(pendingPath)) {
      return false
    }
    const hadViewState = Boolean(pendingViewStateRef.current)
    suppressProgrammaticEditorPreviewSyncRef.current = true
    if (editorPreviewSyncSuppressTimerRef.current !== null) {
      window.clearTimeout(editorPreviewSyncSuppressTimerRef.current)
    }
    editorPreviewSyncSuppressTimerRef.current = window.setTimeout(() => {
      editorPreviewSyncSuppressTimerRef.current = null
      suppressProgrammaticEditorPreviewSyncRef.current = false
    }, PROGRAMMATIC_EDITOR_PREVIEW_SYNC_SUPPRESS_MS)
    if (pendingViewStateRef.current) {
      const restoreStart = performance.now()
      editor.restoreViewState(pendingViewStateRef.current)
      perfTrace(PERF_TRACE_EVENT.RENDERER_MONACO_VIEWSTATE_RESTORE, {
        filePath: activeFilePathRef.current,
        durationMs: +(performance.now() - restoreStart).toFixed(1)
      })
      pendingViewStateRef.current = null
    }
    const cursorApplied = applyPendingCursorPosition({ reveal: !hadViewState })
    if (!cursorApplied) return false
    const fallback = pendingViewStateFallbackRef.current
    if (
      hadViewState &&
      pendingPath &&
      fallback &&
      fallback.path === pendingPath &&
      fallback.line > 1
    ) {
      const currentFirstVisibleLine = editor.getVisibleRanges()?.[0]?.startLineNumber ?? 1
      if (currentFirstVisibleLine <= 1) {
        const maxLine = model.getLineCount()
        const safeLine = Math.max(1, Math.min(maxLine, Math.floor(fallback.line)))
        editor.setScrollTop(editor.getTopForLineNumber(safeLine))
      }
    }
    editor.focus()
    if (!pendingViewStateRef.current && !pendingCursorRef.current) {
      pendingViewStatePathRef.current = null
      pendingViewStateFallbackRef.current = null
    }
    if (
      hadViewState &&
      pendingPath &&
      isMarkdownPath(pendingPath) &&
      isMarkdownPreviewOpenRef.current &&
      isMarkdownEditorVisibleRef.current
    ) {
      const previewKey = getFileScrollKey(lastEditorScopeRef.current, pendingPath)
      if (previewKey && previewScrollMemoryRef.current.has(previewKey)) {
        if (previewRestorePhaseRef.current === 'idle') {
          scheduleEditorSyncFromPreview()
        } else {
          // The preview restore is still in flight (cold reopen): align the editor
          // to the preview AFTER the reveal finalizes, so the editor follows the
          // restored preview anchor instead of its own viewState scroll dragging
          // the preview off the saved section (PMSR-10/11). The reveal's finalize()
          // consumes this flag.
          pendingEditorSyncFromPreviewRef.current = true
        }
        // This is a markdown REOPEN (hadViewState) with a saved preview scroll.
        // Start the bounded reconcile so a LATE root-reload / preview re-mount that
        // strands the preview at the top (after this restore) is corrected back to
        // the saved section (PMSR-10/11). Scoped to reopens via hadViewState; the
        // reconcile no-ops unless the preview actually drifts to the top.
        const reconcileTarget = previewScrollMemoryRef.current.get(previewKey)?.scrollTop ?? 0
        if (reconcileTarget > PREVIEW_SCROLL_RECONCILE_TOLERANCE) {
          // Off-hot-path DECISION breadcrumb (once per reconcile-start, NOT per
          // tick). Lets a "reopened preview sticks at the top" trace show whether
          // the reconcile guard actually fired; per-tick detail stays on mdpTrace.
          perfTrace(PERF_TRACE_EVENT.RENDERER_PROJECT_EDITOR_MD_PREVIEW_SCROLL_RECONCILE, { reconcileTarget })
          startPreviewScrollReconcile()
        }
      }
    }
    return true
  }, [applyPendingCursorPosition, isEditorModelMatchingPath, scheduleEditorSyncFromPreview, startPreviewScrollReconcile])

  const resetActiveFileState = useCallback((options?: { preserveSoftCloseContent?: boolean }) => {
    const preserveContent = options?.preserveSoftCloseContent === true
    if (DEBUG_PROJECT_EDITOR) {
      debugLog('reset:begin', {
        activeFilePath: activeFilePathRef.current,
        isMarkdownRenderAllowed: markdownRenderAllowedRef.current,
        markdownRenderPending: markdownRenderPendingRef.current,
        isIndexing: isIndexingRef.current,
        hasWorker: Boolean(markdownWorkerRef.current),
        workerInFlight: markdownWorkerInFlightRef.current,
        hasRenderTimer: Boolean(markdownRenderTimerRef.current),
        hasIdleTask: markdownIdleHandleRef.current !== null,
        preserveContent
      })
    }
    if (projectStateSaveTimerRef.current) {
      window.clearTimeout(projectStateSaveTimerRef.current)
      projectStateSaveTimerRef.current = null
    }
    if (editorPreviewSyncSuppressTimerRef.current !== null) {
      window.clearTimeout(editorPreviewSyncSuppressTimerRef.current)
      editorPreviewSyncSuppressTimerRef.current = null
    }
    cancelFileTreeRestoreFrame()
    suppressProgrammaticEditorPreviewSyncRef.current = false
    if (markdownRenderTimerRef.current) {
      window.clearTimeout(markdownRenderTimerRef.current)
      markdownRenderTimerRef.current = null
    }
    cancelMarkdownIdle()
    if (markdownWorkerRef.current) {
      markdownWorkerRef.current.terminate()
      markdownWorkerRef.current = null
    }
    markdownWorkerOwnerRef.current = null
    markdownWorkerLatestIdRef.current = 0
    markdownWorkerRequestIdRef.current = 0
    markdownWorkerInFlightRef.current = false
    markdownWorkerQueuedRef.current = false
    resetPreviewRestoreState()
    updatePreviewActiveSlug(null)
    markdownApplyRequestIdRef.current += 1
    markdownPendingPayloadRef.current = null
    setIsIndexing(false)
    editorScrollDisposableRef.current?.dispose()
    editorScrollDisposableRef.current = null
    editorCursorDisposableRef.current?.dispose()
    editorCursorDisposableRef.current = null
    editorModelDisposableRef.current?.dispose()
    editorModelDisposableRef.current = null
    pendingViewStateRef.current = null
    pendingViewStatePathRef.current = null
    pendingViewStateFallbackRef.current = null
    pendingCursorRef.current = null
    fileFirstVisibleLineRef.current.clear()
    originalContentRef.current = ''
    originalModelVersionRef.current = null
    // Soft-close navigation (ESC retain-view or Editor -> Diff/History ->
    // Editor) keeps the same file open. Wiping `fileContentRef` and
    // `setFileContent('')` here would empty Monaco's model, so the
    // slow-restore branch's `applyPendingViewState` has no document lines to
    // target and clamps deep cursors to line 1.
    if (!preserveContent) {
      fileContentRef.current = ''
      setOutlineContentSnapshot({ filePath: null, content: '' })
    }
    openFileTokenRef.current += 1
    isBinaryRef.current = false
    isImageRef.current = false
    isSqliteRef.current = false
    isPdfRef.current = false
    isEpubRef.current = false
    isHtmlRef.current = false
    editorSaveCommandIdRef.current = null
    markdownWorkerInFlightRef.current = false
    markdownWorkerQueuedRef.current = false
    setSelectedPath(null)
    if (!preserveContent) {
      setActiveFilePathValue(null)
      activeFileScopeKeyRef.current = null
    }
    // NOTE: pinnedFiles and recentFiles are persistent metadata scoped to the
    // editor session — they must NOT be cleared here.  Callers that genuinely
    // need to reset them (e.g. the root effect when cwd changes or when the
    // editor closes) do so explicitly after this function returns.
    setDraggingPinnedPath(null)
    setDraggingQuickPath(null)
    setDraggingQuickSource(null)
    setDragOverPinnedPath(null)
    if (!preserveContent) {
      setFileContent('')
    }
    setIsBinary(false)
    setIsImage(false)
    setIsSqlite(false)
    setIsPdf(false)
    setIsEpub(false)
    setIsHtml(false)
    setLargeFileState(null)
    largeFileStateRef.current = null
    setPdfOutlineSymbols([])
    setPdfActivePage(1)
    setEpubOutlineSymbols([])
    setEpubActiveHref(null)
    setImagePreviewUrl(null)
    setPdfPreviewUrl(null)
    setEpubPreviewUrl(null)
    setHtmlPreviewUrl(null)
    htmlPreviewUrlRef.current = null
    setHtmlPreviewReloadKey(0)
    htmlPreviewReloadKeyRef.current = 0
    updateHtmlPreviewScrollState(null)
    closeHtmlPreviewSearch()
    updateHtmlReaderState(null)
    setIsDirty(false)
    setIsLoadingFile(false)
    setIsMarkdownRenderEnabled(false)
    if (!preserveContent) {
      // `preserveContent` is only set when the caller plans to consume the
      // unified soft-close snapshot. In that case we keep the rendered
      // markdown HTML, image map and render source so the next mount can reuse them via the
      // cache-hit fast path in the [isOpen] useEffect. Without this, the
      // React state was cleared here even though the surrounding plumbing
      // was held, and the preview was shown empty until openFile
      // re-rendered from scratch, which is what produced the
      // user-reported "preview disappears after Git Diff / History
      // round-trip" symptom (PMSR-30..35).
      setMarkdownImageMap({})
      markdownImageMapRef.current = {}
      setMarkdownImagePaths([])
      setMarkdownRenderedHtml('')
      setMarkdownRenderSource('')
    }
    setMarkdownRenderPending(false)
    setMissingFileNotice(null)
    void window.electronAPI.project.unwatchAllImageFiles()
    watchedImagePathsRef.current = new Set()
    if (DEBUG_PROJECT_EDITOR) {
      debugLog('reset:done', { activeFilePath: null })
	    }
  }, [
    cancelFileTreeRestoreFrame,
    cancelMarkdownIdle,
    closeHtmlPreviewSearch,
    resetPreviewRestoreState,
    setActiveFilePathValue,
    updateHtmlPreviewScrollState,
    updateHtmlReaderState,
    updatePreviewActiveSlug
  ])

  const captureEditorSoftCloseSnapshot = useCallback((
    kind: ProjectEditorSoftCloseKind,
    scope: ProjectEditorScope | null
  ): ProjectEditorSoftCloseSnapshot | null => {
    if (!scope) {
      // No scope to key by — leave other scopes' snapshots untouched.
      return null
    }
    const snapshot: ProjectEditorSoftCloseSnapshot = {
      kind,
      scope,
      path: activeFilePathRef.current,
      content: fileContentRef.current,
      isBinary: isBinaryRef.current,
      isImage: isImageRef.current,
      isSqlite: isSqliteRef.current,
      isPdf: isPdfRef.current,
      isEpub: isEpubRef.current,
      isHtml: isHtmlRef.current,
      isMarkdownPreviewOpen: isMarkdownPreviewOpenRef.current,
      isMarkdownEditorVisible: isMarkdownEditorVisibleRef.current,
      outlineTarget: outlineTargetRef.current
    }
    const scopeKey = getScrollScopeKey(scope)
    const evicted = editorSoftCloseSnapshotsRef.current.set(scopeKey, snapshot)
    if (snapshot.path && isMarkdownPath(snapshot.path)) {
      // Refresh the protected-key recency so an actively-cycled Task keeps
      // its markdown cache protection.
      setScopeProtectedMarkdownCacheKey(scopeKey, getMarkdownSessionCacheKey(scope.cwd, snapshot.path))
    }
    perfTraceDiagnostic(PERF_TRACE_EVENT.RENDERER_PROJECT_EDITOR_SNAPSHOT_STORED, {
      ph: 'i',
      kind,
      size: editorSoftCloseSnapshotsRef.current.size
    })
    for (const evictedKey of evicted) {
      perfTraceDiagnostic(PERF_TRACE_EVENT.RENDERER_PROJECT_EDITOR_SNAPSHOT_EVICTED, {
        ph: 'i',
        cap: SOFT_CLOSE_SNAPSHOT_CAP,
        evictedKeyLength: evictedKey.length
      })
    }
    return snapshot
  }, [])

  const applyEditorSoftCloseSnapshot = useCallback((snapshot: ProjectEditorSoftCloseSnapshot): boolean => {
    if (!snapshot.path) return false
    setActiveFilePathValue(snapshot.path)
    activeFileScopeKeyRef.current = getScrollScopeKey(snapshot.scope)
    setScopeProtectedMarkdownCacheKey(
      activeFileScopeKeyRef.current,
      isMarkdownPath(snapshot.path) ? getMarkdownSessionCacheKey(snapshot.scope.cwd, snapshot.path) : null
    )
    fileContentRef.current = snapshot.content
    setFileContent(snapshot.content)
    markdownRenderSourceRef.current = snapshot.content
    setMarkdownRenderSource(snapshot.content)
    setOutlineContentSnapshot({ filePath: snapshot.path, content: snapshot.content })
    isBinaryRef.current = snapshot.isBinary
    setIsBinary(snapshot.isBinary)
    isImageRef.current = snapshot.isImage
    setIsImage(snapshot.isImage)
    isSqliteRef.current = snapshot.isSqlite
    setIsSqlite(snapshot.isSqlite)
    isPdfRef.current = snapshot.isPdf
    setIsPdf(snapshot.isPdf)
    isEpubRef.current = snapshot.isEpub
    setIsEpub(snapshot.isEpub)
    isHtmlRef.current = snapshot.isHtml
    setIsHtml(snapshot.isHtml)
    if (isMarkdownPath(snapshot.path)) {
      setIsMarkdownPreviewOpen(snapshot.isMarkdownPreviewOpen)
      isMarkdownPreviewOpenRef.current = snapshot.isMarkdownPreviewOpen
      setIsMarkdownEditorVisible(snapshot.isMarkdownEditorVisible)
      isMarkdownEditorVisibleRef.current = snapshot.isMarkdownEditorVisible
      setOutlineTarget(snapshot.outlineTarget)
      outlineTargetRef.current = snapshot.outlineTarget
    }
    return true
  }, [setActiveFilePathValue])

  // The retained live DOM/HTML always belongs to the currently-active file;
  // its snapshot (if any) is keyed by the scope that opened that file.
  const peekActiveFileSoftCloseSnapshot = useCallback((): ProjectEditorSoftCloseSnapshot | null => {
    return editorSoftCloseSnapshotsRef.current.peek(activeFileScopeKeyRef.current)
  }, [])

  const clearActiveFileState = useCallback((options?: { preserveMissingNotice?: boolean }) => {
    cancelFileTreeRestoreFrame()
    cancelMarkdownIdle()
    resetPreviewRestoreState()
    updatePreviewActiveSlug(null)
    markdownWorkerLatestIdRef.current = 0
    markdownWorkerRequestIdRef.current = 0
    markdownApplyRequestIdRef.current += 1
    markdownPendingPayloadRef.current = null
    markdownWorkerOwnerRef.current = null
    editorScrollDisposableRef.current?.dispose()
    editorScrollDisposableRef.current = null
    editorCursorDisposableRef.current?.dispose()
    editorCursorDisposableRef.current = null
    editorModelDisposableRef.current?.dispose()
    editorModelDisposableRef.current = null
    pendingViewStateRef.current = null
    pendingViewStatePathRef.current = null
    pendingViewStateFallbackRef.current = null
    pendingCursorRef.current = null
    originalContentRef.current = ''
    originalModelVersionRef.current = null
    fileContentRef.current = ''
    setOutlineContentSnapshot({ filePath: null, content: '' })
    openFileTokenRef.current += 1
    isBinaryRef.current = false
    isImageRef.current = false
    isSqliteRef.current = false
    isPdfRef.current = false
    isEpubRef.current = false
    isHtmlRef.current = false
    editorSaveCommandIdRef.current = null
    markdownWorkerInFlightRef.current = false
    markdownWorkerQueuedRef.current = false
    setSelectedPath(null)
    setActiveFilePathValue(null)
    activeFileScopeKeyRef.current = null
    setFileContent('')
    setIsBinary(false)
    setIsImage(false)
    setIsSqlite(false)
    setIsPdf(false)
    setIsEpub(false)
    setIsHtml(false)
    setLargeFileState(null)
    largeFileStateRef.current = null
    setPdfOutlineSymbols([])
    setPdfActivePage(1)
    setEpubOutlineSymbols([])
    setEpubActiveHref(null)
    setImagePreviewUrl(null)
    setPdfPreviewUrl(null)
    setEpubPreviewUrl(null)
    setHtmlPreviewUrl(null)
    htmlPreviewUrlRef.current = null
    setHtmlPreviewReloadKey(0)
    htmlPreviewReloadKeyRef.current = 0
    updateHtmlPreviewScrollState(null)
    closeHtmlPreviewSearch()
    updateHtmlReaderState(null)
    setIsDirty(false)
    setIsLoadingFile(false)
    setIsMarkdownRenderEnabled(false)
    setMarkdownImageMap({})
    markdownImageMapRef.current = {}
    setMarkdownImagePaths([])
    setMarkdownRenderedHtml('')
    setMarkdownRenderPending(false)
    setMarkdownRenderSource('')
    if (!options?.preserveMissingNotice) {
      setMissingFileNotice(null)
    }
    void window.electronAPI.project.unwatchAllImageFiles()
    watchedImagePathsRef.current = new Set()
  }, [cancelFileTreeRestoreFrame, cancelMarkdownIdle, closeHtmlPreviewSearch, resetPreviewRestoreState, updateHtmlPreviewScrollState, updateHtmlReaderState, updatePreviewActiveSlug])

  const scheduleMarkdownApply = useCallback((payload: { html: string; imagePaths: string[] }) => {
    if (DEBUG_PROJECT_EDITOR) {
      perfCountersRef.current.workerApply += 1
    }
    markdownPendingPayloadRef.current = payload
    const applyId = markdownApplyRequestIdRef.current + 1
    markdownApplyRequestIdRef.current = applyId
    cancelMarkdownIdle()

    const run = () => {
      if (applyId !== markdownApplyRequestIdRef.current) return
      if (!previewVisibleRef.current) return
      if (markdownWorkerOwnerRef.current !== activeFilePath) return
      const pending = markdownPendingPayloadRef.current
      if (!pending) return
      const traceStartUs = performanceTrace.enabled ? performanceTrace.nowUs() : 0
      const start = performance.now()
      const safeHtml = DOMPurify.sanitize(pending.html || '', { ALLOWED_URI_REGEXP: DOMPURIFY_URI_POLICY })
      const sanitizeEnd = performance.now()
      perfTrace(PERF_TRACE_EVENT.RENDERER_MARKDOWN_SANITIZE, {
        htmlLength: pending.html?.length ?? 0,
        safeHtmlLength: safeHtml.length,
        durationMs: +(sanitizeEnd - start).toFixed(1)
      })
      if (applyId !== markdownApplyRequestIdRef.current) return
      setMarkdownRenderedHtml(safeHtml)
      setMarkdownImagePaths(Array.isArray(pending.imagePaths) ? pending.imagePaths : [])
      setMarkdownRenderPending(false)
      const duration = performance.now() - start
      markdownRenderDurationRef.current = duration
      const endToEndStart = markdownRenderStartRef.current
      if (endToEndStart > 0) {
        perfTrace(PERF_TRACE_EVENT.RENDERER_MARKDOWN_RENDER, {
          htmlLength: safeHtml.length,
          imageCount: Array.isArray(pending.imagePaths) ? pending.imagePaths.length : 0,
          durationMs: +(sanitizeEnd - endToEndStart).toFixed(1)
        })
        markdownRenderStartRef.current = 0
      }
      if (DEBUG_PROJECT_EDITOR && (duration > 5 || markdownPurifyLogCountRef.current < 5)) {
        if (markdownPurifyLogCountRef.current < 5) {
          markdownPurifyLogCountRef.current += 1
        }
        debugLog('markdown:dompurify', {
          duration: Math.round(duration),
          htmlLength: safeHtml.length
        })
      }
      if (performanceTrace.enabled) {
        performanceTrace.recordComplete(
          'project_editor.render.apply',
          traceStartUs,
          {
            outputLength: safeHtml.length,
            imageCount: Array.isArray(pending.imagePaths) ? pending.imagePaths.length : 0,
            dompurifyDurationMs: +duration.toFixed(3)
          },
          'markdown'
        )
      }
    }

    const requestIdle = (window as Window & {
      requestIdleCallback?: (cb: () => void, options?: { timeout: number }) => number
    }).requestIdleCallback
    if (requestIdle) {
      markdownIdleHandleRef.current = requestIdle(() => {
        markdownIdleHandleRef.current = null
        run()
      }, { timeout: 500 })
    } else {
      markdownIdleHandleRef.current = window.setTimeout(() => {
        markdownIdleHandleRef.current = null
        run()
      }, 0)
    }
  }, [activeFilePath, cancelMarkdownIdle])

  const sendMarkdownRenderRequest = useCallback(() => {
    if (!markdownRenderAllowedRef.current) return
    const worker = markdownWorkerRef.current
    if (!worker) return
    if (markdownWorkerOwnerRef.current !== activeFilePathRef.current) return
    const rootPath = markdownRootPathRef.current
    if (!rootPath) return
    const content = markdownRenderSourceRef.current
    const baseDir = markdownBaseDirRef.current
    const imageMap = markdownImageMapRef.current

    const nextId = markdownWorkerRequestIdRef.current + 1
    markdownWorkerRequestIdRef.current = nextId
    markdownWorkerLatestIdRef.current = nextId
    markdownWorkerInFlightRef.current = true
    if (DEBUG_PROJECT_EDITOR) {
      perfCountersRef.current.workerSend += 1
    }
    setMarkdownRenderPending(true)
    markdownRenderStartRef.current = performance.now()
    worker.postMessage({
      id: nextId,
      content,
      rootPath,
      baseDir,
      imageMap,
      // Enable worker-side profiling whenever DEBUG or either perf-trace
      // system is on; `renderDuration` is what `worker.markdown:render-complete`
      // reports.
      profile: DEBUG_PROJECT_EDITOR
        || Boolean(window.electronAPI?.debug?.perfTraceEnabled)
        || performanceTrace.enabled
    })
  }, [])

  const scheduleMarkdownRender = useCallback(() => {
    if (!markdownRenderAllowedRef.current) return
    const content = fileContentRef.current
    const activePath = activeFilePathRef.current
    const cachedRender = markdownSessionCacheRenderRef.current
    if (
      cachedRender &&
      (cachedRender.filePath !== activePath || cachedRender.content !== content)
    ) {
      markdownSessionCacheRenderRef.current = null
      pendingMarkdownSessionCacheRestoreRef.current = null
      markMarkdownSessionCacheStale(rootRef.current, activePath)
    }
    if (DEBUG_PROJECT_EDITOR) {
      perfCountersRef.current.scheduleRender += 1
    }
    if (content === markdownRenderSourceRef.current && !markdownWorkerInFlightRef.current) {
      if (markdownRenderTimerRef.current) {
        window.clearTimeout(markdownRenderTimerRef.current)
        markdownRenderTimerRef.current = null
      }
      if (markdownRenderPendingRef.current) {
        setMarkdownRenderPending(false)
      }
      return
    }
    if (!markdownRenderPendingRef.current) {
      setMarkdownRenderPending(true)
    }
    if (markdownRenderTimerRef.current) {
      window.clearTimeout(markdownRenderTimerRef.current)
    }
    const delay = getMarkdownRenderDelay(content.length, markdownRenderDurationRef.current)
    markdownRenderTimerRef.current = window.setTimeout(() => {
      markdownRenderTimerRef.current = null
      setMarkdownRenderSource(content)
    }, delay)
  }, [])



  useEffect(() => {
    modalSizeRef.current = modalSize
  }, [modalSize])

  useEffect(() => {
    dirtyRef.current = isDirty
    onDirtyChange?.(isDirty)
  }, [isDirty, onDirtyChange])

  useEffect(() => {
    if (!dialog || dialog.type !== 'prompt') return
    setTimeout(() => dialogInputRef.current?.focus(), 0)
  }, [dialog])

  useEffect(() => {
    if (dialog || searchOpen) {
      setContextMenu(null)
    }
  }, [dialog, searchOpen])

  useEffect(() => {
    if (!isDraggingRef.current) {
      localStorage.setItem(STORAGE_KEY_FILE_TREE_WIDTH, String(fileTreeWidth))
      updateUIPreferences({ projectEditorFileTreeWidth: fileTreeWidth })
    }
  }, [fileTreeWidth])

  useEffect(() => {
    if (!isResizingModalRef.current) {
      localStorage.setItem(STORAGE_KEY_MODAL_SIZE, JSON.stringify(modalSize))
      updateUIPreferences({ projectEditorModalSize: modalSize })
    }
  }, [modalSize])

  useEffect(() => {
    markdownPreviewWidthRef.current = markdownPreviewWidth
  }, [markdownPreviewWidth])

  useEffect(() => {
    outlineWidthRef.current = outlineWidth
  }, [outlineWidth])

  useEffect(() => {
    previewVisibleRef.current = isMarkdownRenderAllowed
  }, [isMarkdownRenderAllowed])

  useEffect(() => {
    isIndexingRef.current = isIndexing
  }, [isIndexing])

  useEffect(() => {
    markdownRenderPendingRef.current = markdownRenderPending
  }, [markdownRenderPending])

  useEffect(() => {
    markdownRenderedHtmlRef.current = markdownRenderedHtml
  }, [markdownRenderedHtml])

  useEffect(() => {
    if (!isMarkdownPreviewVisible) {
      closePreviewSearch()
      updatePreviewActiveSlug(null)
    }
  }, [closePreviewSearch, isMarkdownPreviewVisible, updatePreviewActiveSlug])

  useEffect(() => {
    if (!isHtmlPreviewVisible) {
      closeHtmlPreviewSearch()
      updateHtmlPreviewScrollState(null)
    }
  }, [closeHtmlPreviewSearch, isHtmlPreviewVisible, updateHtmlPreviewScrollState])

  // Backstop tracker for the HTML preview scroll offset: the browser view has
  // no scroll callback, so hard-quit / crash paths would otherwise lose the
  // position (beforeunload flushes whatever this poll last captured).
  useEffect(() => {
    if (!isHtmlPreviewVisible) return
    const timer = window.setInterval(() => {
      void captureHtmlPreviewScrollMemory('poll')
    }, HTML_SCROLL_TRACK_INTERVAL_MS)
    return () => {
      window.clearInterval(timer)
    }
  }, [captureHtmlPreviewScrollMemory, isHtmlPreviewVisible])

  useEffect(() => {
    const unsubscribe = window.electronAPI.browser.onFoundInPage((id, result) => {
      if (id !== htmlReaderStateRef.current?.browserId) return
      updateHtmlPreviewSearchResult({
        matches: Math.max(0, result.matches),
        activeMatchOrdinal: Math.max(0, result.activeMatchOrdinal),
        finalUpdate: Boolean(result.finalUpdate)
      })
    })
    return unsubscribe
  }, [updateHtmlPreviewSearchResult])

  useEffect(() => {
    const unsubscribe = window.electronAPI.browser.onFindShortcutPressed((id) => {
      if (id !== htmlReaderStateRef.current?.browserId) return
      openHtmlPreviewSearch()
    })
    return unsubscribe
  }, [openHtmlPreviewSearch])

  useEffect(() => {
    const unsubscribe = window.electronAPI.browser.onReloadShortcutPressed((id) => {
      if (id !== htmlReaderStateRef.current?.browserId) return
      void handleHtmlPreviewNav('reload', 'shortcut')
    })
    return unsubscribe
  }, [handleHtmlPreviewNav])

  useEffect(() => {
    const unsubscribe = window.electronAPI.browser.onZoomFactorChanged((id, zoomFactor, source) => {
      if (id !== htmlReaderStateRef.current?.browserId) return
      setHtmlPreviewZoomFactorState(
        zoomFactor,
        source === 'shortcut' ? 'webcontents-shortcut' : 'toolbar'
      )
    })
    return unsubscribe
  }, [setHtmlPreviewZoomFactorState])

  useEffect(() => {
    const browserId = htmlReaderState?.browserId
    if (!browserId) return
    void window.electronAPI.browser.setZoomFactor(browserId, htmlPreviewZoomFactorRef.current)
  }, [htmlReaderState?.browserId])

  useEffect(() => {
    if (!htmlPreviewSearchOpen) return
    const handle = window.setTimeout(() => {
      runHtmlPreviewSearch(htmlPreviewSearchQueryRef.current, { forward: true, findNext: false })
    }, 120)
    return () => window.clearTimeout(handle)
  }, [htmlPreviewSearchOpen, htmlPreviewSearchQuery, htmlReaderState?.browserId, runHtmlPreviewSearch])

  useEffect(() => {
    fileContentRef.current = fileContent
  }, [fileContent])

  useEffect(() => {
    markdownRenderSourceRef.current = markdownRenderSource
  }, [markdownRenderSource])

  useEffect(() => {
    markdownRootPathRef.current = markdownRootPath
  }, [markdownRootPath])

  useEffect(() => {
    markdownBaseDirRef.current = markdownBaseRelativeDir
  }, [markdownBaseRelativeDir])

  useEffect(() => {
    markdownImageMapRef.current = markdownImageMap
  }, [markdownImageMap])

  useEffect(() => {
    markdownRenderAllowedRef.current = isMarkdownRenderAllowed
  }, [isMarkdownRenderAllowed])

  useEffect(() => {
    isBinaryRef.current = isBinary
  }, [isBinary])

  useEffect(() => {
    isImageRef.current = isImage
  }, [isImage])

  useEffect(() => {
    isSqliteRef.current = isSqlite
  }, [isSqlite])

  useEffect(() => {
    isPdfRef.current = isPdf
  }, [isPdf])

  useEffect(() => {
    isEpubRef.current = isEpub
  }, [isEpub])

  useEffect(() => {
    isHtmlRef.current = isHtml
  }, [isHtml])

  useEffect(() => {
    htmlPreviewUrlRef.current = htmlPreviewUrl
  }, [htmlPreviewUrl])

  useEffect(() => {
    htmlPreviewReloadKeyRef.current = htmlPreviewReloadKey
  }, [htmlPreviewReloadKey])

  const getImageFilePreviewState = useCallback(() => {
    if (!activeFilePathRef.current || !isImageRef.current) return null
    const image = imagePreviewRef.current
    return {
      visible: Boolean(imagePreviewUrl),
      loaded: Boolean(image && image.complete && image.naturalWidth > 0),
      broken: Boolean(image && image.complete && image.naturalWidth === 0),
      src: image?.currentSrc || image?.src || imagePreviewUrl || ''
    }
  }, [imagePreviewUrl])

  useEffect(() => {
    if (!isMarkdownWorkerActive) {
      // Preserve the previously rendered HTML across a "soft"
      // worker-deactivate event so the cache-hit fast path on the next reopen
      // can short-circuit `applyMarkdownSessionCacheHit` -> `beginPreviewRestore`
      // and avoid the waiting-html opacity flicker.
      const softCloseSnapshot = peekActiveFileSoftCloseSnapshot()
      // A retained-close shortcut reopen briefly re-enters this deactivate
      // branch on the reopen's FIRST render: `isOpen` has already flipped true,
      // but the retained-view restore effect (which calls
      // setIsMarkdownRenderEnabled(true)) has not yet propagated, so
      // `isMarkdownWorkerActive` is still false for one render. The original
      // `!isOpen` guard did not cover this window, so the branch blanked the
      // retained HTML (markdownRenderedHtmlRef -> ''), destroying the
      // already-rendered mermaid DOM. The follow-on restore then had to
      // re-apply the cache + re-render mermaid, which drove the phase through
      // 'waiting-html'/'restoring-layout' (the user-visible reflash) and, under
      // EDR throttling, could stall the first reopen at htmlLength 0 entirely
      // (PMSR-09/10/11/13/13a). Preserve the HTML in this reopen-in-flight
      // window too — gated to a retained-close snapshot whose path still
      // matches the active markdown file, so we never leak a stale render for a
      // different file.
      const preserveClosedPreview = shouldPreserveRetainedPreviewDuringReopen({
        snapshotKind: softCloseSnapshot?.kind ?? null,
        snapshotPath: softCloseSnapshot?.path ?? null,
        isOpen,
        activeFilePath: activeFilePathRef.current
      })
      // Also preserve when a content-identical cached render is still pinned for
      // the active file. The snapshot-based guard above expires the moment
      // finalizeProjectEditorReopenRestore clears the soft-close snapshot, so a
      // worker-deactivate that fires in the POST-FINALIZE window under EDR
      // throttling would otherwise blank the HTML the zero-flash retained-reopen
      // branch just preserved (it set markdownSessionCacheRenderRef + kept
      // markdownRenderedHtmlRef populated), stranding the cold FIRST reopen at
      // htmlLength 0 (PMSR-09/10/11). This mirrors the owner-switch branch's
      // shouldPreserveCachedRender guard so both deactivate paths agree on when
      // a preserved render is still valid.
      const deactivateCachedRender = markdownSessionCacheRenderRef.current
      const preserveCachedRenderOnDeactivate = Boolean(
        deactivateCachedRender &&
        deactivateCachedRender.filePath === activeFilePathRef.current &&
        deactivateCachedRender.content === fileContentRef.current &&
        markdownRenderedHtmlRef.current
      )
      resetPreviewRestoreState()
      if (markdownWorkerRef.current) {
        markdownWorkerRef.current.terminate()
        markdownWorkerRef.current = null
      }
      markdownWorkerOwnerRef.current = null
      markdownWorkerLatestIdRef.current = 0
      markdownWorkerRequestIdRef.current = 0
      markdownWorkerInFlightRef.current = false
      markdownWorkerQueuedRef.current = false
      markdownApplyRequestIdRef.current += 1
      markdownPendingPayloadRef.current = null
      cancelMarkdownIdle()
      if (markdownRenderTimerRef.current) {
        window.clearTimeout(markdownRenderTimerRef.current)
        markdownRenderTimerRef.current = null
      }
      mdpTrace('blank:worker-deactivate', {
        willBlank: !preserveClosedPreview && !preserveCachedRenderOnDeactivate,
        preserveClosedPreview,
        preserveCachedRenderOnDeactivate,
        htmlRefLen: markdownRenderedHtmlRef.current.length
      })
      if (!preserveClosedPreview && !preserveCachedRenderOnDeactivate) {
        setMarkdownRenderedHtml('')
        markdownRenderedHtmlRef.current = ''
        setMarkdownImagePaths([])
      }
      setMarkdownRenderPending(false)
      const currentContent = fileContentRef.current
      markdownRenderSourceRef.current = currentContent
      setMarkdownRenderSource(currentContent)
      return
    }

    const nextOwner = activeFilePath ?? null
    if (markdownWorkerOwnerRef.current !== nextOwner) {
      const cachedRender = markdownSessionCacheRenderRef.current
      const shouldPreserveCachedRender =
        Boolean(
          cachedRender &&
          cachedRender.filePath === nextOwner &&
          cachedRender.content === fileContentRef.current &&
          markdownRenderedHtmlRef.current
        )
      if (markdownWorkerRef.current) {
        markdownWorkerRef.current.terminate()
        markdownWorkerRef.current = null
      }
      markdownWorkerOwnerRef.current = nextOwner
      markdownWorkerLatestIdRef.current = 0
      markdownWorkerRequestIdRef.current = 0
      markdownWorkerInFlightRef.current = false
      markdownWorkerQueuedRef.current = false
      markdownPendingPayloadRef.current = null
      cancelMarkdownIdle()
      if (!shouldPreserveCachedRender) {
        // A shortcut reopen of a retained-close markdown file briefly re-enters
        // this owner-switch branch (owner null -> file) on the reopen's first
        // render, BEFORE the retained-view restore effect re-applies the cache.
        // The original `else` arm unconditionally blanked markdownRenderedHtmlRef
        // here, destroying the already-rendered (mermaid-enhanced) DOM that the
        // worker-deactivate branch's preserveClosedPreview had kept. On an
        // EDR-throttled host the follow-on re-render could then land after the
        // 20s reopen budget, stranding the first reopen at htmlLength 0 and
        // forcing a 'waiting-html' flash on the reopens where it did recover
        // (PMSR-09/10/11/13/13a/13b, PMN-41, CDP-10). The robust fix is to NOT
        // blank the HTML in the reopen-in-flight window: if a retained-close
        // snapshot for THIS file says the preserved render is still valid, keep
        // it on screen so the restore effect takes the zero-flash path.
        const softCloseSnapshot = peekActiveFileSoftCloseSnapshot()
        const preserveDuringReopen =
          Boolean(markdownRenderedHtmlRef.current) &&
          shouldPreserveRetainedPreviewDuringReopen({
            snapshotKind: softCloseSnapshot?.kind ?? null,
            snapshotPath: softCloseSnapshot?.path ?? null,
            isOpen,
            activeFilePath: activeFilePathRef.current
          })
        if (preserveDuringReopen) {
          // Keep the preserved HTML; the retained-view restore effect re-arms the
          // scroll + render nonce without ever leaving 'idle'.
          perfTrace(PERF_TRACE_EVENT.RENDERER_PROJECT_EDITOR_MD_REOPEN_PRESERVED_NO_FLASH, {
            // Basename only — keep the payload tiny and free of full paths.
            filePath: (nextOwner ?? '').split(/[\\/]/).pop() ?? (nextOwner ?? ''),
            htmlLength: markdownRenderedHtmlRef.current.length
          })
        } else {
          // Option A: before blanking the HTML and forcing a fresh worker render,
          // check whether the persistent session cache holds a CONTENT-IDENTICAL
          // render for the file being reopened. Restoring synchronously from a
          // content-identical cache keeps getMarkdownRenderedHtml() non-empty
          // immediately and re-applies scroll, so we never blank-then-re-render.
          const reopenRoot = rootRef.current
          const syncRestoreEntry =
            nextOwner &&
            reopenRoot &&
            isMarkdownPreviewOpenRef.current &&
            !isBinaryRef.current &&
            !isImageRef.current &&
            !isSqliteRef.current
              ? peekMarkdownSessionCacheHit(reopenRoot, nextOwner, fileContentRef.current)
              : null
          if (syncRestoreEntry && nextOwner) {
            applyMarkdownSessionCacheHitRef.current(nextOwner, fileContentRef.current, syncRestoreEntry)
            perfTrace(PERF_TRACE_EVENT.RENDERER_PROJECT_EDITOR_MD_REOPEN_CACHE_RESTORED, {
              // Basename only — keep the payload tiny and free of full paths.
              filePath: nextOwner.split(/[\\/]/).pop() ?? nextOwner,
              htmlLength: syncRestoreEntry.renderedHtml.length
            })
          } else {
            mdpTrace('blank:owner-switch', {
              nextOwner: (nextOwner ?? '').split(/[\\/]/).pop() ?? '',
              htmlRefLen: markdownRenderedHtmlRef.current.length
            })
            setMarkdownRenderedHtml('')
            markdownRenderedHtmlRef.current = ''
            setMarkdownImagePaths([])
            setMarkdownRenderPending(false)
          }
        }
      }
    }

    if (!markdownWorkerRef.current) {
      const worker = new Worker(new URL('../../workers/markdownPreviewWorker.ts', import.meta.url), {
        type: 'module'
      })
      worker.onmessage = (event) => {
        const payload = event.data as {
          id: number
          html: string
          imagePaths: string[]
          renderDuration?: number
          contentLength?: number
        }
        if (!payload || typeof payload.id !== 'number') return
        if (payload.id !== markdownWorkerLatestIdRef.current) return
        markdownWorkerInFlightRef.current = false
        if (typeof payload.renderDuration === 'number') {
          perfTrace(PERF_TRACE_EVENT.WORKER_MARKDOWN_RENDER_COMPLETE, {
            contentLength: payload.contentLength ?? 0,
            htmlLength: payload.html?.length ?? 0,
            imageCount: Array.isArray(payload.imagePaths) ? payload.imagePaths.length : 0,
            durationMs: +payload.renderDuration.toFixed(1)
          })
        }
        if (
          DEBUG_PROJECT_EDITOR &&
          typeof payload.renderDuration === 'number' &&
          (payload.renderDuration > 5 || markdownWorkerLogCountRef.current < 5)
        ) {
          if (markdownWorkerLogCountRef.current < 5) {
            markdownWorkerLogCountRef.current += 1
          }
          debugLog('markdown:worker', {
            duration: Math.round(payload.renderDuration),
            contentLength: payload.contentLength ?? 0
          })
        }
        if (performanceTrace.enabled && typeof payload.renderDuration === 'number') {
          // Worker reports duration in ms; convert to a complete-event span ending now.
          const durUs = Math.max(0, Math.round(payload.renderDuration * 1000))
          performanceTrace.recordComplete(
            'markdown.render.worker',
            performanceTrace.nowUs() - durUs,
            {
              contentLength: payload.contentLength ?? 0,
              outputLength: payload.html?.length ?? 0,
              imageCount: Array.isArray(payload.imagePaths) ? payload.imagePaths.length : 0,
              profileFlag: DEBUG_PROJECT_EDITOR || performanceTrace.enabled
            },
            'markdown'
          )
        }
        scheduleMarkdownApply({
          html: payload.html || '',
          imagePaths: Array.isArray(payload.imagePaths) ? payload.imagePaths : []
        })
        if (markdownWorkerQueuedRef.current) {
          markdownWorkerQueuedRef.current = false
          sendMarkdownRenderRequest()
        }
      }
      worker.onerror = () => {
        markdownWorkerInFlightRef.current = false
        if (markdownWorkerQueuedRef.current) {
          markdownWorkerQueuedRef.current = false
          sendMarkdownRenderRequest()
        }
        setMarkdownRenderPending(false)
      }
      markdownWorkerRef.current = worker
    }
  }, [
    activeFilePath,
    cancelMarkdownIdle,
    isMarkdownWorkerActive,
    isOpen,
    peekActiveFileSoftCloseSnapshot,
    resetPreviewRestoreState,
    scheduleMarkdownApply,
    sendMarkdownRenderRequest
  ])

  useEffect(() => {
    return () => {
      if (scrollRafRef.current) {
        window.cancelAnimationFrame(scrollRafRef.current)
      }
      cancelPreviewRevealFrames()
      cancelEditorPreviewSyncFrame()
      cancelFileTreeRestoreFrame()
      if (previewScrollReconcileTimerRef.current !== null) {
        window.clearInterval(previewScrollReconcileTimerRef.current)
        previewScrollReconcileTimerRef.current = null
      }
      editorScrollDisposableRef.current?.dispose()
      editorCursorDisposableRef.current?.dispose()
      editorModelDisposableRef.current?.dispose()
      if (projectStateSaveTimerRef.current) {
        window.clearTimeout(projectStateSaveTimerRef.current)
      }
      if (editorPreviewSyncSuppressTimerRef.current !== null) {
        window.clearTimeout(editorPreviewSyncSuppressTimerRef.current)
        editorPreviewSyncSuppressTimerRef.current = null
      }
      if (markdownRenderTimerRef.current) {
        window.clearTimeout(markdownRenderTimerRef.current)
      }
      cancelMarkdownIdle()
      if (markdownWorkerRef.current) {
        markdownWorkerRef.current.terminate()
        markdownWorkerRef.current = null
      }
      editorSaveCommandIdRef.current = null
    }
  }, [cancelEditorPreviewSyncFrame, cancelFileTreeRestoreFrame, cancelMarkdownIdle, cancelPreviewRevealFrames])

  useEffect(() => {
    resetPreviewRestoreState()
    setMarkdownImageMap({})
    markdownImageMapRef.current = {}
    setMarkdownImagePaths([])
    setMarkdownRenderedHtml('')
    void window.electronAPI.project.unwatchAllImageFiles()
    watchedImagePathsRef.current = new Set()
  }, [resetPreviewRestoreState, rootPath])

  useEffect(() => {
    if (!isMarkdownWorkerActive) {
      if (markdownRenderTimerRef.current) {
        window.clearTimeout(markdownRenderTimerRef.current)
      }
      const softCloseSnapshot = peekActiveFileSoftCloseSnapshot()
      const preserveClosedPreview = Boolean(
        softCloseSnapshot &&
        (softCloseSnapshot.kind === 'subpage-return' || !isOpen)
      )
      if (!preserveClosedPreview) {
        setMarkdownRenderSource('')
      }
      setMarkdownRenderPending(false)
      return
    }

    scheduleMarkdownRender()
  }, [activeFilePath, isMarkdownWorkerActive, isOpen, peekActiveFileSoftCloseSnapshot, scheduleMarkdownRender])

  useEffect(() => {
    if (!isMarkdownWorkerActive || !markdownRootPath) return
    const cachedRender = markdownSessionCacheRenderRef.current
    if (
      cachedRender &&
      cachedRender.filePath === activeFilePath &&
      cachedRender.content === markdownRenderSource &&
      markdownRenderedHtmlRef.current
    ) {
      return
    }
    const worker = markdownWorkerRef.current
    if (!worker) return
    if (markdownWorkerOwnerRef.current !== activeFilePath) return
    if (markdownWorkerInFlightRef.current) {
      markdownWorkerQueuedRef.current = true
      return
    }
    sendMarkdownRenderRequest()
  }, [
    isMarkdownWorkerActive,
    activeFilePath,
    markdownRenderSource,
    markdownRootPath,
    sendMarkdownRenderRequest
  ])

  // Render-recovery watchdog: when the markdown preview should show content (render
  // gate on + rendered-HTML buffer EMPTY) but no render is in flight, re-issue the
  // worker render. The happy-path render lands in a few ms, so the boolean flips to
  // false (HTML present) before the interval's first tick and this never fires. It
  // recovers the cold-reopen case where the issued render's result was discarded by
  // the reopen churn (markdownApplyRequestIdRef bumped between request and response)
  // and no dep changed to re-send — leaving the preview permanently blank
  // (PMSR-09/10/11). Gated on "no render in flight" so it never duplicates an
  // in-progress render; the interval retries until a render lands or the gate closes.
  const markdownPreviewStuckBlank = isMarkdownRenderAllowed && markdownRenderedHtml.length === 0
  useEffect(() => {
    if (!markdownPreviewStuckBlank) return
    const recovery = window.setInterval(() => {
      if (!markdownRenderAllowedRef.current || markdownRenderedHtmlRef.current) {
        window.clearInterval(recovery)
        return
      }
      // A render is in progress — let it complete rather than duplicating it.
      if (markdownWorkerInFlightRef.current) return
      if (!isMarkdownPreviewOpenRef.current) return
      const activePath = activeFilePathRef.current
      if (!activePath || !isMarkdownPath(activePath)) return
      if (!fileContentRef.current) return
      const worker = markdownWorkerRef.current
      if (!worker || markdownWorkerOwnerRef.current !== activePath) return
      // Stuck blank with everything ready: the prior render was lost. Force one.
      perfTrace(PERF_TRACE_EVENT.RENDERER_PROJECT_EDITOR_MD_RENDER_RECOVERY_FORCED, {
        filePath: activePath.split(/[\\/]/).pop() ?? activePath,
        contentLen: fileContentRef.current.length
      })
      mdpTrace('render-recovery:force', { activeFilePath: activePath.split(/[\\/]/).pop() ?? activePath })
      sendMarkdownRenderRequest()
    }, MARKDOWN_RENDER_RECOVERY_MS)
    return () => window.clearInterval(recovery)
  }, [markdownPreviewStuckBlank, sendMarkdownRenderRequest])

  useEffect(() => {
    if (!isMarkdownWorkerActive || !rootPath) return
    const pending = markdownImagePaths.filter((path) => !markdownImageMap[path])
    if (pending.length === 0) return
    let cancelled = false

    const loadImages = async () => {
      const updates: Record<string, string> = {}
      await Promise.all(pending.map(async (relativePath) => {
        const result = await window.electronAPI.project.readFile(rootPath, relativePath)
        if (result.success && result.isImage && result.previewUrl) {
          updates[relativePath] = result.previewUrl
        }
      }))
      if (cancelled) return
      if (Object.keys(updates).length > 0) {
        const nextMap = { ...markdownImageMapRef.current, ...updates }
        markdownImageMapRef.current = nextMap
        setMarkdownImageMap(nextMap)
        sendMarkdownRenderRequest()
      }
    }

    void loadImages()
    return () => {
      cancelled = true
    }
  }, [isMarkdownWorkerActive, markdownImageMap, markdownImagePaths, rootPath, sendMarkdownRenderRequest])

  // Watch referenced image files for changes and invalidate cache on modification
  useEffect(() => {
    if (!isMarkdownWorkerActive || !rootPath) return

    const currentPaths = new Set(markdownImagePaths)
    const watched = watchedImagePathsRef.current

    // Determine paths to watch/unwatch
    const toWatch = markdownImagePaths.filter((p) => !watched.has(p))
    const toUnwatch = Array.from(watched).filter((p) => !currentPaths.has(p))

    if (toWatch.length > 0) {
      void window.electronAPI.project.watchImageFiles(rootPath, toWatch)
      for (const p of toWatch) watched.add(p)
    }
    if (toUnwatch.length > 0) {
      void window.electronAPI.project.unwatchImageFiles(rootPath, toUnwatch)
      for (const p of toUnwatch) watched.delete(p)
    }

    // Listen for image file changes and invalidate the specific cache entry
	    const unsubscribe = window.electronAPI.project.onImageFileChanged((relativePath) => {
	      const currentMap = markdownImageMapRef.current
	      if (!currentMap[relativePath]) return
	      const { [relativePath]: _, ...rest } = currentMap
	      markdownImageMapRef.current = rest
	      setMarkdownImageMap(rest)
	      markMarkdownSessionCacheStale(rootRef.current, activeFilePathRef.current)
	    })

    return () => {
      unsubscribe()
    }
  }, [isMarkdownWorkerActive, markdownImagePaths, rootPath])

  const showStatus = useCallback((type: 'success' | 'error', text: string) => {
    setStatusMessage({ type, text })
    if (saveTimerRef.current) {
      window.clearTimeout(saveTimerRef.current)
    }
    saveTimerRef.current = window.setTimeout(() => {
      setStatusMessage(null)
    }, 2000)
  }, [])

  const applyLargeFileState = useCallback((
    next: LargeFileState | null | ((prev: LargeFileState | null) => LargeFileState | null)
  ) => {
    setLargeFileState((prev) => {
      const value = typeof next === 'function'
        ? (next as (prev: LargeFileState | null) => LargeFileState | null)(prev)
        : next
      largeFileStateRef.current = value
      return value
    })
  }, [])

  const requestFileOpenChoice = useCallback((params: {
    path: string
    extensionKey: string
    sizeBytes: number
  }) => {
    return new Promise<FileOpenChoiceResult>((resolve) => {
      // In autotest mode the dialog must never block test execution.
      // Auto-select 'text' so navigation-marker .txt files (which may appear
      // binary on Windows due to UTF-16 LE output from the terminal) open
      // without user interaction.  The remember flag is false so the choice
      // does not persist across test suites. A suite that explicitly TESTS the
      // dialog (project-editor-large-file PLF-11..15) opts OUT via
      // ONWARD_AUTOTEST_REAL_FILE_CHOICE=1 so it gets the real dialog.
      if (window.electronAPI?.debug?.autotest && !window.electronAPI?.debug?.autotestRealFileChoice) {
        resolve({ mode: 'text', remember: false })
        return
      }
      fileOpenChoiceResolveRef.current = resolve
      setFileOpenChoiceDialog({
        path: params.path,
        extension: params.extensionKey,
        extensionLabel: params.extensionKey === '__no_extension__'
          ? t('projectEditor.binaryChoice.noExtension')
          : params.extensionKey,
        sizeLabel: formatFileSize(params.sizeBytes),
        remember: false
      })
    })
  }, [t])

  const handleFileOpenChoiceCancel = useCallback(() => {
    fileOpenChoiceResolveRef.current?.(null)
    fileOpenChoiceResolveRef.current = null
    setFileOpenChoiceDialog(null)
  }, [])

  const resolveFileOpenChoice = useCallback((mode: FileOpenChoiceMode, rememberOverride?: boolean) => {
    const remember = rememberOverride ?? Boolean(fileOpenChoiceDialog?.remember)
    fileOpenChoiceResolveRef.current?.({ mode, remember })
    fileOpenChoiceResolveRef.current = null
    setFileOpenChoiceDialog(null)
  }, [fileOpenChoiceDialog])

  const handleFileOpenChoiceSelect = useCallback((mode: FileOpenChoiceMode) => {
    resolveFileOpenChoice(mode)
  }, [resolveFileOpenChoice])

  const loadLargeFileChunk = useCallback(async (params: {
    path: string
    mode: 'large-text' | 'binary'
    sizeBytes: number
    offset: number
  }) => {
    const root = rootRef.current
    if (!root) return false
    const token = largeFileChunkTokenRef.current + 1
    largeFileChunkTokenRef.current = token
    const safeOffset = Math.max(0, Math.min(Math.floor(params.offset), params.sizeBytes))
    applyLargeFileState((prev) => {
      if (!prev || prev.path !== params.path || prev.mode !== params.mode) {
        return {
          mode: params.mode,
          path: params.path,
          sizeBytes: params.sizeBytes,
          offset: safeOffset,
          bytesRead: 0,
          text: '',
          binaryBytes: new Uint8Array(),
          loading: true,
          error: null
        }
      }
      return { ...prev, offset: safeOffset, loading: true, error: null }
    })

    const chunkMode = params.mode === 'binary' ? 'binary' : 'text'
    const result = await window.electronAPI.project.readFileChunk(root, params.path, safeOffset, LARGE_FILE_CHUNK_BYTES, chunkMode)
    if (token !== largeFileChunkTokenRef.current) return false

    if (!result.success) {
      const error = result.error || t('projectEditor.largeFile.chunkError')
      applyLargeFileState((prev) => prev && prev.path === params.path
        ? { ...prev, loading: false, error }
        : prev)
      showStatus('error', error)
      return false
    }

    const text = chunkMode === 'text' ? (result.text ?? '') : ''
    const binaryBytes = chunkMode === 'binary' ? base64ToBytes(result.base64 ?? '') : new Uint8Array()
    applyLargeFileState({
      mode: params.mode,
      path: params.path,
      sizeBytes: result.sizeBytes,
      offset: result.offset,
      bytesRead: result.bytesRead,
      text,
      binaryBytes,
      loading: false,
      error: null
    })
    return true
  }, [applyLargeFileState, showStatus, t])

  // --- Path copy (shared hook) ---
  const { copyMessage: pathCopyMessage, copyToClipboard, showCopyError, flashCopyFeedback } = usePathCopy(t, 'projectEditor.copyFailed')
  const {
    title: cwdTitle,
    onDoubleClick: handleCwdDblClick,
    feedback: cwdFeedback
  } = useCwdCopyHandler(rootPath, t, 'projectEditor.copyFailed')

  const handleFilenameDblClick = useCallback(async (e: React.MouseEvent) => {
    if (!activeFilePath || !rootPath) return
    const target = e.currentTarget as HTMLElement
    const isAbsolute = e.altKey
    const pathToCopy = isAbsolute ? `${rootPath}/${activeFilePath}` : activeFilePath
    const label = isAbsolute ? t('common.absolutePath') : t('common.relativePath')
    const ok = await copyToClipboard(pathToCopy, label)
    if (ok) flashCopyFeedback(target)
  }, [activeFilePath, copyToClipboard, flashCopyFeedback, rootPath, t])

  const resolveAbsolutePath = useCallback((relativePath: string): string | null => {
    const root = rootRef.current ?? rootPath
    if (!root) return null
    const normalizedRoot = normalizePath(root).replace(/\/+$/, '')
    if (!relativePath) return normalizedRoot
    return `${normalizedRoot}/${relativePath}`
  }, [rootPath])

  const copyContextMenuPath = useCallback(async (
    targetPath: string,
    kind: 'name' | 'relative' | 'absolute'
  ) => {
    if (kind === 'name') {
      const root = rootRef.current ?? rootPath
      const text = targetPath
        ? getBaseName(targetPath)
        : (root ? getBaseName(normalizePath(root)) : '')
      if (!text) {
        showCopyError(t('projectEditor.copyFailed'))
        return
      }
      await copyToClipboard(text, t('common.name'))
      return
    }

    if (kind === 'relative') {
      const text = targetPath || '.'
      await copyToClipboard(text, t('common.relativePath'))
      return
    }

    const absolutePath = resolveAbsolutePath(targetPath)
    if (!absolutePath) {
      showCopyError(t('projectEditor.absolutePathUnavailable'))
      return
    }
    await copyToClipboard(absolutePath, t('common.absolutePath'))
  }, [copyToClipboard, resolveAbsolutePath, rootPath, showCopyError, t])

  const touchRecentFile = useCallback((path: string) => {
    setRecentFiles((prev) => prependRecentFile(prev, path, MAX_RECENT_FILES))
  }, [])

	  const removeQuickFileEntries = useCallback((targetPath: string) => {
	    removeFileMemoryEntries(targetPath)
	    removeMarkdownSessionCacheEntries(rootRef.current ?? rootPath, targetPath)
	    setPinnedFiles((prev) => removeQuickFilePath(prev, targetPath, MAX_PINNED_FILES))
	    setRecentFiles((prev) => removeQuickFilePath(prev, targetPath, MAX_RECENT_FILES))
	  }, [removeFileMemoryEntries, rootPath])

	  const replaceQuickFileEntries = useCallback((sourcePath: string, nextPath: string) => {
	    replaceFileMemoryEntries(sourcePath, nextPath)
	    replaceMarkdownSessionCacheEntries(rootRef.current ?? rootPath, sourcePath, nextPath)
	    setPinnedFiles((prev) => replaceQuickFilePath(prev, sourcePath, nextPath, MAX_PINNED_FILES))
	    setRecentFiles((prev) => replaceQuickFilePath(prev, sourcePath, nextPath, MAX_RECENT_FILES))
	  }, [replaceFileMemoryEntries, rootPath])

  const validateQuickFileEntries = useCallback(async (
    root: string,
    source?: { pinned: string[]; recent: string[] }
  ) => {
    const pinnedSource = normalizeQuickFilePaths(source?.pinned ?? pinnedFiles, MAX_PINNED_FILES)
    const recentSource = normalizeQuickFilePaths(source?.recent ?? recentFiles, MAX_RECENT_FILES)
    const candidates = Array.from(new Set([...pinnedSource, ...recentSource]))
    if (candidates.length === 0) {
      setPinnedFiles(pinnedSource)
      setRecentFiles(recentSource)
      return
    }

    // CPU root-cause fix: previously this fanned out one full `readFile`
    // call per candidate path, which transferred 100-300 KB of content
    // back to the renderer for every pinned / recent file just to check
    // `result.success`. With 14 candidates that put ~3 MB of IPC payload
    // + N renderer-side parse passes on PE mount — the single largest
    // contributor to the ~80% renderer CPU spike captured by the
    // CDP-driven trace harness. `project.filesExist` is one IPC
    // roundtrip returning `boolean[]`, so the payload is bounded and the
    // renderer no longer parses content it then discards.
    const existsFlags = await window.electronAPI.project.filesExist(root, candidates)
    const existing = candidates.map((path, idx) => existsFlags[idx] ? path : null)

    if (normalizePath(rootRef.current ?? '') !== normalizePath(root)) {
      return
    }

    // Restore-time validation runs asynchronously. If the user changed the
    // quick-file lists while existence checks were in flight, skip this stale
    // write-back instead of clobbering the newer recent/pinned order.
    if (source) {
      const currentPinned = normalizeQuickFilePaths(pinnedFilesRef.current, MAX_PINNED_FILES)
      const currentRecent = normalizeQuickFilePaths(recentFilesRef.current, MAX_RECENT_FILES)
      if (
        !areQuickFileListsEqual(currentPinned, pinnedSource) ||
        !areQuickFileListsEqual(currentRecent, recentSource)
      ) {
        return
      }
    }

    const existingSet = new Set(existing.filter((path): path is string => Boolean(path)))
    setPinnedFiles(
      normalizeQuickFilePaths(
        pinnedSource.filter(path => existingSet.has(path)),
        MAX_PINNED_FILES
      )
    )
    setRecentFiles(
      normalizeQuickFilePaths(
        recentSource.filter(path => existingSet.has(path)),
        MAX_RECENT_FILES
      )
    )
  }, [isMissingFileError, pinnedFiles, recentFiles])

  const togglePinnedFile = useCallback((path: string) => {
    const normalizedPath = normalizePath(path)
    if (!normalizedPath) return
    if (pinnedFiles.includes(normalizedPath)) {
      setPinnedFiles((prev) => prev.filter(item => item !== normalizedPath))
      return
    }
    setPinnedFiles((prev) => [normalizedPath, ...prev])
  }, [pinnedFiles])

  const clearRecentFiles = useCallback(() => {
    setRecentFiles([])
    setDraggingPinnedPath(null)
    setDraggingQuickPath(null)
    setDraggingQuickSource(null)
    setDragOverPinnedPath(null)
    showStatus('success', t('projectEditor.recentCleared'))
  }, [showStatus, t])

  // Width-responsive overflow measurement
  const measureOverflow = useCallback((
    measureContainer: HTMLDivElement | null,
    itemCount: number,
    setCount: (n: number) => void
  ) => {
    if (!measureContainer || itemCount === 0) {
      setCount(Infinity)
      return
    }
    const containerWidth = measureContainer.clientWidth
    if (containerWidth <= 0) {
      setCount(Infinity)
      return
    }
    const OVERFLOW_BTN_RESERVED = 48
    const children = measureContainer.children
    let fitCount = 0
    for (let i = 0; i < children.length; i++) {
      const child = children[i] as HTMLElement
      if (!child.dataset.idx) continue
      const rightEdge = child.offsetLeft + child.offsetWidth
      const needsBtn = Number(child.dataset.idx) < itemCount - 1
      if (rightEdge > containerWidth - (needsBtn ? OVERFLOW_BTN_RESERVED : 0)) {
        break
      }
      fitCount++
    }
    // When nothing fits but items exist, show 0 visible items so the +N button
    // covers all of them — avoids the first item clipping the overflow button (P2-2).
    setCount(fitCount > 0 && fitCount < itemCount ? fitCount : (fitCount === 0 && itemCount > 0 ? 0 : Infinity))
  }, [])

  useLayoutEffect(() => {
    measureOverflow(pinnedMeasureRef.current, pinnedFiles.length, setVisiblePinCount)
    measureOverflow(recentMeasureRef.current, recentFiles.length, setVisibleRecentCount)

    const observer = new ResizeObserver(() => {
      measureOverflow(pinnedMeasureRef.current, pinnedFiles.length, setVisiblePinCount)
      measureOverflow(recentMeasureRef.current, recentFiles.length, setVisibleRecentCount)
    })
    if (pinnedMeasureRef.current) observer.observe(pinnedMeasureRef.current)
    if (recentMeasureRef.current) observer.observe(recentMeasureRef.current)
    return () => observer.disconnect()
  }, [pinnedFiles, recentFiles, quickFileLabels, measureOverflow])

  // Overflow dropdown positioning
  const computeDropdownPos = useCallback((btnRef: React.RefObject<HTMLButtonElement | null>) => {
    if (!btnRef.current) return { left: 0, top: 0 }
    const rect = btnRef.current.getBoundingClientRect()
    const left = Math.min(rect.left, window.innerWidth - 320)
    const top = rect.bottom + 4
    return { left: Math.max(0, left), top: Math.min(top, window.innerHeight - 300) }
  }, [])

  // Pull EPUB bytes via fetch as soon as the URL changes, then publish a
  // fresh ArrayBuffer downstream. Keeping the async hop here (rather than
  // inside EpubReader's own useEffect) means EpubReader sees a buffer prop
  // and runs its book / rendition setup synchronously — async work inside
  // the reader was observed to widen the layout-race window around epub.js's
  // first display() and trip the rAF stall paths even with the in-component
  // patches (see queue.tick / reportLocation overrides in EpubReader.tsx).
  useEffect(() => {
    if (!epubPreviewUrl) {
      setEpubPreviewBuffer(null)
      return
    }
    const controller = new AbortController()
    let cancelled = false
    void (async () => {
      try {
        const response = await fetch(epubPreviewUrl, { signal: controller.signal })
        if (cancelled) return
        if (!response.ok) {
          showStatus('error', t('projectEditor.error.readFile'))
          return
        }
        const buffer = await response.arrayBuffer()
        if (cancelled) return
        setEpubPreviewBuffer(buffer)
      } catch (err) {
        if (cancelled) return
        if ((err as { name?: string })?.name === 'AbortError') return
        showStatus('error', String((err as { message?: string })?.message ?? err))
      }
    })()
    return () => {
      cancelled = true
      controller.abort()
    }
  }, [epubPreviewUrl, showStatus, t])

  // Close overflow dropdown on click outside (Escape is handled by handleEscape → useSubpageEscape)
  useEffect(() => {
    if (!pinOverflowOpen && !recentOverflowOpen) return
    const handleMouseDown = (e: MouseEvent) => {
      const target = e.target as Node
      if (pinOverflowOpen) {
        if (!pinDropdownRef.current?.contains(target) && !pinOverflowBtnRef.current?.contains(target)) {
          setPinOverflowOpen(false)
          setQuickTooltip(null)
        }
      }
      if (recentOverflowOpen) {
        if (!recentDropdownRef.current?.contains(target) && !recentOverflowBtnRef.current?.contains(target)) {
          setRecentOverflowOpen(false)
          setQuickTooltip(null)
        }
      }
    }
    window.addEventListener('mousedown', handleMouseDown)
    return () => {
      window.removeEventListener('mousedown', handleMouseDown)
    }
  }, [pinOverflowOpen, recentOverflowOpen])

  // Drag start from overflow dropdown (pin only)
  // Defer dropdown close so the browser captures the drag image before the portal unmounts.
  const handleOverflowPinDragStart = useCallback((event: React.DragEvent<HTMLButtonElement>, path: string) => {
    setDraggingPinnedPath(path)
    setDraggingQuickPath(path)
    setDraggingQuickSource('pinned')
    setDragOverPinnedPath(null)
    setQuickTooltip(null)
    requestAnimationFrame(() => setPinOverflowOpen(false))
    const payload = JSON.stringify({ path, source: 'pinned' })
    event.dataTransfer.effectAllowed = 'move'
    event.dataTransfer.setData(QUICK_FILE_DRAG_MIME, payload)
    event.dataTransfer.setData('text/plain', path)
  }, [])

  const setQuickDragPayload = useCallback((
    event: React.DragEvent<HTMLElement>,
    path: string,
    source: 'pinned' | 'recent'
  ) => {
    const payload = JSON.stringify({ path, source })
    event.dataTransfer.effectAllowed = 'move'
    event.dataTransfer.setData(QUICK_FILE_DRAG_MIME, payload)
    event.dataTransfer.setData('text/plain', path)
  }, [])

  const resolveQuickDragPayload = useCallback((event: React.DragEvent<HTMLElement>) => {
    if (draggingQuickPath && draggingQuickSource) {
      return {
        path: draggingQuickPath,
        source: draggingQuickSource
      } as const
    }
    const mimeData = event.dataTransfer.getData(QUICK_FILE_DRAG_MIME)
    const decodedByMime = decodeQuickFileDragPayload(mimeData)
    if (decodedByMime) return decodedByMime
    const plain = normalizePath(event.dataTransfer.getData('text/plain') || '')
    if (!plain) return null
    return {
      path: plain,
      source: pinnedFiles.includes(plain) ? 'pinned' : 'recent'
    } as const
  }, [draggingQuickPath, draggingQuickSource, pinnedFiles])

  const handleQuickTooltipEnter = useCallback((e: React.MouseEvent, path: string) => {
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
    const relativePath = rootPath && path.startsWith(rootPath + '/') ? path.slice(rootPath.length + 1) : path
    setQuickTooltip({ text: relativePath, fullPath: path, x: rect.left, y: rect.bottom + 4 })
  }, [rootPath])

  const handleQuickTooltipLeave = useCallback(() => {
    setQuickTooltip(null)
  }, [])

  const handlePinnedDragStart = useCallback((event: React.DragEvent<HTMLButtonElement>, path: string) => {
    setDraggingPinnedPath(path)
    setDraggingQuickPath(path)
    setDraggingQuickSource('pinned')
    setDragOverPinnedPath(null)
    setQuickTooltip(null)
    setQuickDragPayload(event, path, 'pinned')
  }, [setQuickDragPayload])

  const handleRecentDragStart = useCallback((event: React.DragEvent<HTMLButtonElement>, path: string) => {
    setDraggingPinnedPath(null)
    setDraggingQuickPath(path)
    setDraggingQuickSource('recent')
    setDragOverPinnedPath(null)
    setQuickTooltip(null)
    setQuickDragPayload(event, path, 'recent')
  }, [setQuickDragPayload])

  const resetQuickDragState = useCallback(() => {
    setDraggingPinnedPath(null)
    setDraggingQuickPath(null)
    setDraggingQuickSource(null)
    setDragOverPinnedPath(null)
  }, [])

  const handlePinnedDragOver = useCallback((event: React.DragEvent<HTMLButtonElement>, path: string) => {
    event.preventDefault()
    if (!draggingQuickPath || draggingQuickPath === path) return
    setDragOverPinnedPath(path)
    event.dataTransfer.dropEffect = 'move'
  }, [draggingQuickPath])

  const handlePinnedDrop = useCallback((event: React.DragEvent<HTMLButtonElement>, targetPath: string) => {
    event.preventDefault()
    event.stopPropagation()

    const dragData = resolveQuickDragPayload(event)
    if (!dragData || !targetPath) {
      resetQuickDragState()
      return
    }

    if (dragData.source === 'pinned') {
      if (dragData.path !== targetPath) {
        setPinnedFiles((prev) => moveQuickFile(prev, dragData.path, targetPath, MAX_PINNED_FILES))
      }
      resetQuickDragState()
      return
    }

    // recent → pinned: insert at target position
    setPinnedFiles((prev) => {
      if (prev.includes(dragData.path)) {
        return moveQuickFile(prev, dragData.path, targetPath, MAX_PINNED_FILES)
      }
      const targetIndex = prev.indexOf(targetPath)
      if (targetIndex < 0) return [dragData.path, ...prev]
      const next = [...prev]
      next.splice(targetIndex, 0, dragData.path)
      return next
    })
    resetQuickDragState()
  }, [resolveQuickDragPayload, resetQuickDragState])

  const handlePinnedDragEnd = useCallback(() => {
    resetQuickDragState()
  }, [resetQuickDragState])

  const handlePinnedListDragOver = useCallback((event: React.DragEvent<HTMLDivElement>) => {
    event.preventDefault()
    event.dataTransfer.dropEffect = 'move'
  }, [])

  const handlePinnedListDrop = useCallback((event: React.DragEvent<HTMLDivElement>) => {
    event.preventDefault()
    const dragData = resolveQuickDragPayload(event)
    if (!dragData) {
      resetQuickDragState()
      return
    }

    setPinnedFiles((prev) => {
      const currentIndex = prev.indexOf(dragData.path)
      if (currentIndex >= 0) {
        const next = [...prev]
        const [moved] = next.splice(currentIndex, 1)
        next.push(moved)
        return next
      }
      return [...prev, dragData.path]
    })
    resetQuickDragState()
  }, [resolveQuickDragPayload, resetQuickDragState])

  useEffect(() => {
    return () => {
      if (saveTimerRef.current) {
        window.clearTimeout(saveTimerRef.current)
      }
    }
  }, [])

  useEffect(() => {
    if (!contextMenu) return
    const handleMouseDown = (event: MouseEvent) => {
      if (contextMenuRef.current?.contains(event.target as Node)) return
      setContextMenu(null)
    }
    const handleScroll = () => {
      setContextMenu(null)
    }
    window.addEventListener('mousedown', handleMouseDown)
    window.addEventListener('scroll', handleScroll, true)
    return () => {
      window.removeEventListener('mousedown', handleMouseDown)
      window.removeEventListener('scroll', handleScroll, true)
    }
  }, [contextMenu])

  const requestConfirm = useCallback((options: ConfirmOptions) => {
    return new Promise<boolean>((resolve) => {
      dialogResolveRef.current = resolve as (value: boolean | string | null) => void
      setDialog({
        type: 'confirm',
        title: options.title,
        message: options.message,
        confirmText: options.confirmText,
        cancelText: options.cancelText
      })
    })
  }, [])

  const requestPrompt = useCallback((options: PromptOptions) => {
    return new Promise<string | null>((resolve) => {
      dialogResolveRef.current = resolve as (value: boolean | string | null) => void
      setDialog({
        type: 'prompt',
        title: options.title,
        message: options.message,
        placeholder: options.placeholder,
        defaultValue: options.defaultValue,
        confirmText: options.confirmText,
        cancelText: options.cancelText
      })
      setDialogInput(options.defaultValue || '')
    })
  }, [])

  const handleDialogCancel = useCallback(() => {
    if (dialogResolveRef.current) {
      dialogResolveRef.current(dialog?.type === 'confirm' ? false : null)
      dialogResolveRef.current = null
    }
    setDialog(null)
  }, [dialog])

  const handleDialogConfirm = useCallback(() => {
    if (dialogResolveRef.current) {
      const value = dialog?.type === 'confirm' ? true : dialogInput.trim()
      dialogResolveRef.current(value)
      dialogResolveRef.current = null
    }
    setDialog(null)
  }, [dialog, dialogInput])

  const confirmDiscardChanges = useCallback(async () => {
    if (!dirtyRef.current) return true
    return await requestConfirm({
      title: t('projectEditor.confirm.unsaved.title'),
      message: t('projectEditor.confirm.unsaved.message'),
      confirmText: t('projectEditor.confirm.unsaved.confirm'),
      cancelText: t('projectEditor.confirm.unsaved.cancel')
    })
  }, [requestConfirm, t])

  const syncOriginalVersion = useCallback(() => {
    const sync = (attempt: number) => {
      const editor = editorRef.current
      const model = editor?.getModel()
      if (!model) {
        if (attempt < 2) {
          window.setTimeout(() => sync(attempt + 1), 0)
        }
        return
      }
      if (model.getValue() !== fileContentRef.current) {
        if (attempt < 2) {
          window.setTimeout(() => sync(attempt + 1), 0)
        }
        return
      }
      originalModelVersionRef.current = model.getAlternativeVersionId()
    }
    sync(0)
  }, [])

  const waitForEditorModelReady = useCallback(async (
    targetPath: string,
    timeoutMs = 2000,
    expectedContent?: string
  ) => {
    const start = performance.now()
    while (performance.now() - start < timeoutMs) {
      if (activeFilePathRef.current !== targetPath) return false
      const editor = editorRef.current
      const model = editor?.getModel()
      if (
        model &&
        isEditorModelMatchingPath(targetPath) &&
        (expectedContent === undefined || model.getValue() === expectedContent)
      ) {
        return true
      }
      await new Promise<void>((resolve) => {
        window.setTimeout(resolve, 16)
      })
    }
    return false
  }, [isEditorModelMatchingPath])

  const openFile = useCallback(async (
    path: string,
    source: OpenFileSource = 'user',
    options?: OpenFileOptions
  ) => {
    perfTrace(PERF_TRACE_EVENT.RENDERER_PROJECT_FILE_OPEN, {
      source,
      pathLen: path.length,
      ext: path.split('.').pop() || ''
    })
    const currentActiveFilePath = activeFilePathRef.current
    if (source === 'user') {
      // User manual navigation has the highest priority, canceling any ongoing recovery process to avoid being "pulled back to old files".
      restoreTokenRef.current += 1
      restoreCancelledByUserRef.current = true
      hasRestoredStateRef.current = true
      restoringStateRef.current = false
      pendingViewStateRef.current = null
      pendingViewStatePathRef.current = null
      pendingViewStateFallbackRef.current = null
      pendingCursorRef.current = null
      pendingViewStateScopeKeyRef.current = null
      if (options?.cursorPosition) {
        pendingViewStatePathRef.current = path
        pendingCursorRef.current = {
          lineNumber: options.cursorPosition.lineNumber,
          column: options.cursorPosition.column ?? 1
        }
        pendingViewStateScopeKeyRef.current = getScrollScopeKey(lastEditorScopeRef.current)
      }
    }

    if (currentActiveFilePath === path && !options?.forceReload) {
      setSelectedPath(path)
      if (source === 'user' && options?.trackRecent) {
        touchRecentFile(path)
      }
      // Self-heal the markdown render gate on a re-open of the already-active
      // file. Two distinct paths land here with the preview render OFF for the
      // file that is already active:
      //   (a) Git Diff "Jump to Editor" deep-link — on the way INTO Diff
      //       `resetActiveFileState` cleared `isMarkdownRenderEnabled` while
      //       preserving the rendered HTML; the preview pane stayed OPEN
      //       (`isMarkdownPreviewOpenRef.current === true`).
      //   (b) Project-editor reopen via the RETAINED-VIEW path
      //       (`legacy-event:open:editor->editor`, PMN-41) — under an
      //       EDR-throttled host the retained restore can leave the preview pane
      //       flagged CLOSED (`isMarkdownPreviewOpenRef.current === false`) AND
      //       the rendered HTML blank, then an explicit re-open of the same file
      //       hits this early-return and never re-enables anything.
      //   (c) Same RETAINED-VIEW reopen as (b) but the render gate is already
      //       ON (`markdownRenderAllowedRef.current === true`) while the rendered
      //       HTML buffer is EMPTY — a late worker-deactivate render blanked
      //       `markdownRenderedHtmlRef` AFTER the gate re-enabled, so the preview
      //       reports visible yet shows nothing (PMN-41 on EDR-throttled Windows).
      // For (a)/(b) `isMarkdownRenderAllowed` is false; for (c) it is true but the
      // HTML is blank. The decision is the pure `shouldRecoverPreviewOnReopenSameFile`
      // predicate (locked by a unit test): recover on an explicit markdown open
      // when the gate is OFF *or* the HTML buffer is empty, so a normal re-click
      // on an already-rendered file (gate ON + HTML present) stays a no-op. For
      // path (b) we additionally force the preview pane open first, mirroring the
      // enable arm of `setMarkdownPreviewVisibility` (~L1960), because re-enabling
      // the render gate is meaningless while the pane is flagged closed.
      if (
        !isBinaryRef.current &&
        !isImageRef.current &&
        !isSqliteRef.current &&
        shouldRecoverPreviewOnReopenSameFile({
          source,
          isMarkdownFile: isMarkdownPath(path),
          isRenderAllowed: markdownRenderAllowedRef.current,
          hasRenderedHtml: Boolean(markdownRenderedHtmlRef.current)
        })
      ) {
        if (!isMarkdownPreviewOpenRef.current) {
          // Path (b): the retained-view restore left the pane closed. Force it
          // open so the downstream render-allowed chain can light up.
          isMarkdownPreviewOpenRef.current = true
          setIsMarkdownPreviewOpen(true)
        }
        const root = rootRef.current
        const cacheRead = root
          ? readMarkdownSessionCache(root, path, fileContentRef.current)
          : null
        if (cacheRead) {
          markdownSessionLastRestoreRef.current = cacheRead.result
        }
        if (cacheRead?.entry) {
          applyMarkdownSessionCacheHitRef.current(path, fileContentRef.current, cacheRead.entry)
        } else if (markdownRenderedHtmlRef.current) {
          // HTML preserved across the Diff round-trip but no content-identical
          // cache entry — just reset the restore phase to idle (does not blank
          // the preserved HTML) so the re-enabled gate shows it immediately.
          resetPreviewRestoreState()
        } else {
          // Path (b) with a cold cache AND no preserved HTML: nothing is on
          // screen and there is no cache to restore from, so we must kick a
          // fresh worker render ourselves. The non-early-return open path drives
          // the render by (re)assigning `markdownRenderSource`; mirror that here
          // — seeding the source from the already-loaded `fileContentRef` is what
          // makes the worker effect schedule a render. `beginPreviewRestore()`
          // then parks the phase at `waiting-html` until that render lands.
          markdownSessionCacheRenderRef.current = null
          pendingMarkdownSessionCacheRestoreRef.current = null
          markdownRenderSourceRef.current = fileContentRef.current
          setMarkdownRenderSource(fileContentRef.current)
          beginPreviewRestore()
        }
        setIsMarkdownRenderEnabled(true)
        perfTrace(PERF_TRACE_EVENT.RENDERER_PROJECT_EDITOR_MD_RENDER_GATE_REENABLED, {
          // Basename only — keep the payload tiny and free of full paths.
          filePath: path.split(/[\\/]/).pop() ?? path,
          source
        })
      }
      if (options?.cursorPosition) {
        pendingViewStateRef.current = null
        pendingViewStatePathRef.current = path
        pendingCursorRef.current = {
          lineNumber: options.cursorPosition.lineNumber,
          column: options.cursorPosition.column ?? 1
        }
        pendingViewStateScopeKeyRef.current = getScrollScopeKey(lastEditorScopeRef.current)
        applyPendingCursorPosition()
        scheduleProjectStateSave()
      }
      return
    }

    if (diffReturnContextRef.current) {
      setDiffJumpTargetValue(null)
    }

    // Save ALL state for the old file in one call. The HTML scroll offset
    // lives in the embedded browser view (async IPC) and must be captured
    // while the old file's view still exists.
    if (currentActiveFilePath) {
      await captureHtmlPreviewScrollMemory('open-file')
      saveCurrentFileMemory()
    }

    debugLog('openFile:start', {
      path,
      activeFilePath: currentActiveFilePath,
      isDirty: dirtyRef.current
    })
    const shouldConfirm = source !== 'debug'
    const canProceed = shouldConfirm ? await confirmDiscardChanges() : true
    debugLog('openFile:confirm', { path, canProceed })
    if (!canProceed) {
      debugLog('openFile:cancelled', { path })
      return
    }

    const root = rootRef.current
    if (!root) {
      debugLog('openFile:missing-root', { path })
      return
    }

    const openToken = openFileTokenRef.current + 1
    openFileTokenRef.current = openToken
    setIsLoadingFile(true)
    const readOptions: { openMode?: ProjectFileOpenMode } = {}
    let result = await window.electronAPI.project.readFile(root, path, readOptions)
    while (true) {
      if (openToken !== openFileTokenRef.current) {
        debugLog('openFile:stale', { path, token: openToken, current: openFileTokenRef.current })
        return
      }
      if (result.success) break

      if (result.requiresOpenChoice) {
        const extensionKey = getExtensionKey(path, result.extension)
        const rememberedMode = readBinaryOpenDefaults()[extensionKey]
        if (rememberedMode) {
          readOptions.openMode = rememberedMode
          debugLog('openFile:binary-choice-remembered', { path, mode: rememberedMode })
        } else {
          setIsLoadingFile(false)
          const choice = await requestFileOpenChoice({
            path,
            extensionKey,
            sizeBytes: result.sizeBytes ?? 0
          })
          if (openToken !== openFileTokenRef.current) return
          if (!choice) {
            debugLog('openFile:binary-choice-cancelled', { path })
            return
          }
          if (choice.remember) {
            writeBinaryOpenDefault(extensionKey, choice.mode)
          }
          readOptions.openMode = choice.mode
          setIsLoadingFile(true)
          debugLog('openFile:binary-choice', { path, mode: choice.mode, remember: choice.remember })
        }
        result = await window.electronAPI.project.readFile(root, path, readOptions)
        continue
      }

      break
    }
    setIsLoadingFile(false)

    if (!result.success) {
      const errorMessage = result.error || t('projectEditor.error.readFile')
      if (isMissingFileError(errorMessage)) {
        const missingNotice = buildMissingFileNotice(path, source, locale)
        if (options?.missingBehavior === 'empty-state') {
          clearActiveFileState({ preserveMissingNotice: true })
        } else {
          setActiveFilePathValue(path)
          activeFileScopeKeyRef.current = getScrollScopeKey(
            lastEditorScopeRef.current ?? buildProjectEditorScope(_terminalId, rootRef.current ?? cwd ?? null)
          )
          setSelectedPath(path)
          setIsBinary(false)
          isBinaryRef.current = false
          setIsImage(false)
          isImageRef.current = false
          setIsSqlite(false)
          isSqliteRef.current = false
          setIsPdf(false)
          isPdfRef.current = false
          setIsEpub(false)
          isEpubRef.current = false
          setIsHtml(false)
          isHtmlRef.current = false
          applyLargeFileState(null)
          setPdfOutlineSymbols([])
          setPdfActivePage(1)
          setEpubOutlineSymbols([])
          setEpubActiveHref(null)
          setImagePreviewUrl(null)
          setPdfPreviewUrl(null)
          setEpubPreviewUrl(null)
          setHtmlPreviewUrl(null)
          htmlPreviewUrlRef.current = null
          setHtmlPreviewReloadKey(0)
          htmlPreviewReloadKeyRef.current = 0
          updateHtmlPreviewScrollState(null)
          closeHtmlPreviewSearch()
          updateHtmlReaderState(null)
          setFileContent('')
          fileContentRef.current = ''
          setOutlineContentSnapshot({ filePath: null, content: '' })
          originalContentRef.current = ''
          originalModelVersionRef.current = null
          setIsDirty(false)
          setIsMarkdownRenderEnabled(false)
          pendingViewStateRef.current = null
          pendingViewStatePathRef.current = null
          pendingViewStateFallbackRef.current = null
        }
        setMissingFileNotice({
          path,
          message: missingNotice.notice
        })
        removeQuickFileEntries(path)
        showStatus('error', missingNotice.status)
        debugLog('openFile:missing', { path, error: errorMessage })
        return
      }
      showStatus('error', errorMessage)
      debugLog('openFile:failed', { path, error: errorMessage })
      return
    }

    debugLog('openFile:success', {
      path,
      isBinary: result.isBinary,
      isImage: result.isImage,
      isSqlite: result.isSqlite,
      isHtml: result.isHtml,
      size: result.sizeBytes ?? result.content?.length ?? 0,
      openMode: result.openMode ?? 'text'
    })
    setMissingFileNotice(null)
    applyLargeFileState(null)
    largeFileChunkTokenRef.current += 1

    // Update the active path
    const sqliteFile = Boolean(result.isSqlite)
    // Suppress auto-reveal for:
    //   1. explicit tree clicks (options.suppressFileBrowserReveal)
    //   2. session restore — it queues its own queueFileTreeScrollRestore to
    //      replay the persisted tree scrollTop; auto-centering on the
    //      restored file would clobber that saved position.
    if (options?.suppressFileBrowserReveal || source === 'restore') {
      suppressNextRevealRef.current = true
    }
    setActiveFilePathValue(path)
    activeFileScopeKeyRef.current = getScrollScopeKey(
      lastEditorScopeRef.current ?? buildProjectEditorScope(_terminalId, rootRef.current ?? cwd ?? null)
    )
    // Protect this Task's last markdown file from cross-Task cache eviction.
    setScopeProtectedMarkdownCacheKey(
      activeFileScopeKeyRef.current,
      isMarkdownPath(path) ? getMarkdownSessionCacheKey(root, path) : null
    )
    setSelectedPath(path)
    if (source === 'user' && options?.trackRecent) {
      touchRecentFile(path)
    }

    const binaryFile = Boolean(result.isBinary) && !sqliteFile
    const pdfFile = Boolean(result.isPdf)
    const epubFile = Boolean(result.isEpub)
    const htmlFile = Boolean(result.isHtml) || isHtmlPath(path)
    setIsBinary(binaryFile)
    isBinaryRef.current = binaryFile
    setIsImage(result.isImage)
    isImageRef.current = result.isImage
    setIsSqlite(sqliteFile)
    isSqliteRef.current = sqliteFile
    setIsPdf(pdfFile)
    isPdfRef.current = pdfFile
    setIsEpub(epubFile)
    isEpubRef.current = epubFile
    setIsHtml(htmlFile)
    isHtmlRef.current = htmlFile
    // Clear the last file's PDF/EPUB outline state. The new reader will push
    // its outline + location through the new callbacks once it mounts.
    setPdfOutlineSymbols([])
    setPdfActivePage(1)
    setEpubOutlineSymbols([])
    setEpubActiveHref(null)
    setImagePreviewUrl(result.isImage ? (result.previewUrl ?? null) : null)
    setPdfPreviewUrl(pdfFile ? (result.previewUrl ?? null) : null)
    setEpubPreviewUrl(epubFile ? (result.previewUrl ?? null) : null)
    const nextHtmlPreviewUrl = htmlFile ? (result.previewUrl ?? null) : null
    setHtmlPreviewUrl(nextHtmlPreviewUrl)
    htmlPreviewUrlRef.current = nextHtmlPreviewUrl
    setHtmlPreviewReloadKey(0)
    htmlPreviewReloadKeyRef.current = 0
    // Seed the HTML preview scroll from this file's persisted memory so
    // HtmlReader's restoreScrollState pipeline lands on the last-read
    // position once the view loads (parallel to PDF initialState below).
    const htmlMemory = htmlFile ? fileMemoryRef.current.get(path) : undefined
    if (htmlFile && typeof htmlMemory?.htmlScrollY === 'number') {
      updateHtmlPreviewScrollState({
        x: htmlMemory.htmlScrollX ?? 0,
        y: htmlMemory.htmlScrollY,
        scrollWidth: 0,
        scrollHeight: 0,
        clientWidth: 0,
        clientHeight: 0
      })
      perfTraceDiagnostic(PERF_TRACE_EVENT.RENDERER_PROJECT_EDITOR_HTML_SCROLL_RESTORED, {
        ph: 'i',
        scrollY: Math.round(htmlMemory.htmlScrollY)
      })
    } else {
      updateHtmlPreviewScrollState(null)
    }
    closeHtmlPreviewSearch()
    updateHtmlReaderState(null)
    let markdownCacheEntry: MarkdownSessionCacheEntry | null = null
    if (!binaryFile && !result.isImage && !sqliteFile && isMarkdownPath(path)) {
      const cacheRead = readMarkdownSessionCache(root, path, result.content ?? '')
      markdownCacheEntry = cacheRead.entry
      markdownSessionLastRestoreRef.current = cacheRead.result
      mdpTrace('cache:read[openFile]', {
        mode: cacheRead.result.mode,
        filePath: path,
        renderedHtmlLength: cacheRead.result.renderedHtmlLength ?? 0,
        ts: +performance.now().toFixed(1)
      })
    } else {
      markdownSessionLastRestoreRef.current = {
        mode: 'disabled',
        key: null,
        filePath: path,
        size: markdownSessionCacheStore.size,
        limit: getMarkdownSessionCacheLimit()
      }
    }

    // Restore ALL state for the new file from unified memory
    const keepPendingRestoreState = shouldKeepPendingRestoreState({
      source,
      path,
      pendingPath: pendingViewStatePathRef.current,
      hasPendingViewState: pendingViewStateRef.current !== null,
      hasPendingCursor: pendingCursorRef.current !== null
    })
    const pendingRestoreOverride = keepPendingRestoreState
      ? {
          pendingViewState: pendingViewStateRef.current,
          pendingViewStatePath: pendingViewStatePathRef.current,
          pendingCursor: pendingCursorRef.current,
          pendingViewStateFallback: pendingViewStateFallbackRef.current
        }
      : null
    restoreFileMemory(path)
    if (pendingRestoreOverride?.pendingViewStatePath === path) {
      pendingViewStateRef.current = pendingRestoreOverride.pendingViewState
      pendingViewStatePathRef.current = pendingRestoreOverride.pendingViewStatePath
      pendingCursorRef.current = pendingRestoreOverride.pendingCursor
      pendingViewStateFallbackRef.current = pendingRestoreOverride.pendingViewStateFallback
    }

    if (sqliteFile) {
      pendingViewStateRef.current = null
      pendingViewStatePathRef.current = null
      pendingViewStateFallbackRef.current = null
      setFileContent('')
      fileContentRef.current = ''
      setOutlineContentSnapshot({ filePath: null, content: '' })
      originalContentRef.current = ''
      originalModelVersionRef.current = null
      setIsDirty(false)
      setIsMarkdownRenderEnabled(false)
      return
    }

    if (result.isImage) {
      pendingViewStateRef.current = null
      pendingViewStatePathRef.current = null
      pendingViewStateFallbackRef.current = null
      setFileContent('')
      fileContentRef.current = ''
      setOutlineContentSnapshot({ filePath: null, content: '' })
      originalContentRef.current = ''
      originalModelVersionRef.current = null
      setIsDirty(false)
      setIsMarkdownRenderEnabled(false)
      return
    }

    if (result.openMode === 'large-text' || result.openMode === 'binary') {
      pendingViewStateRef.current = null
      pendingViewStatePathRef.current = null
      pendingViewStateFallbackRef.current = null
      setFileContent('')
      fileContentRef.current = ''
      originalContentRef.current = ''
      originalModelVersionRef.current = null
      setIsDirty(false)
      setIsMarkdownRenderEnabled(false)
      markdownSessionCacheRenderRef.current = null
      pendingMarkdownSessionCacheRestoreRef.current = null
      const mode = result.openMode
      const sizeBytes = result.sizeBytes ?? 0
      applyLargeFileState({
        mode,
        path,
        sizeBytes,
        offset: 0,
        bytesRead: 0,
        text: '',
        binaryBytes: new Uint8Array(),
        loading: true,
        error: null
      })
      await loadLargeFileChunk({ path, mode, sizeBytes, offset: 0 })
      return
    }

    if (result.isBinary) {
      pendingViewStateRef.current = null
      pendingViewStatePathRef.current = null
      pendingViewStateFallbackRef.current = null
      setFileContent('')
      fileContentRef.current = ''
      setOutlineContentSnapshot({ filePath: null, content: '' })
      originalContentRef.current = ''
      originalModelVersionRef.current = null
      setIsDirty(false)
      setIsMarkdownRenderEnabled(false)
      return
    }

    const textContent = result.content ?? ''
    setFileContent(textContent)
    fileContentRef.current = textContent
    setOutlineContentSnapshot({ filePath: path, content: textContent })
    originalContentRef.current = textContent
    originalModelVersionRef.current = null
    setIsDirty(false)
    syncOriginalVersion()

    const isMarkdownFile = isMarkdownPath(path)
    const shouldEnableMarkdown = shouldEnableMarkdownForOpen(source, isMarkdownFile)
    // Self-heal the preview-open state for an explicit markdown open. After a
    // project-editor reopen (e.g. PMN-40 -> PMN-41) the openFile call can latch a
    // racing snapshot in which `isMarkdownPreviewOpenRef.current` is still false,
    // even though the user/debug/restore open of a markdown file should show the
    // preview. Every branch below — cache apply, render-enable, beginPreviewRestore
    // — is gated on `isMarkdownPreviewOpenRef.current`, so a stale `false` here
    // leaves the reopened markdown file with the preview never enabled and the
    // render never started, timing out the next assertion. Force the preview open
    // here (mirroring the enable path in setMarkdownPreviewVisibility ~L2017) so
    // the file always self-heals rather than inheriting the stale snapshot. The
    // boolean is the pure `shouldSelfHealMarkdownPreviewOpen` predicate so the
    // decision is locked by a unit test.
    if (shouldSelfHealMarkdownPreviewOpen(source, isMarkdownFile, isMarkdownPreviewOpenRef.current)) {
      isMarkdownPreviewOpenRef.current = true
      setIsMarkdownPreviewOpen(true)
      perfTrace(PERF_TRACE_EVENT.RENDERER_PROJECT_EDITOR_MD_PREVIEW_OPEN_SELF_HEALED, {
        // Basename only — keep the payload tiny and free of full paths.
        filePath: path.split(/[\\/]/).pop() ?? path,
        source
      })
    }
    if (shouldEnableMarkdown && isMarkdownPreviewOpenRef.current && markdownCacheEntry) {
      applyMarkdownSessionCacheHit(path, textContent, markdownCacheEntry)
    } else {
      markdownSessionCacheRenderRef.current = null
      pendingMarkdownSessionCacheRestoreRef.current = null
      markdownRenderSourceRef.current = textContent
      setMarkdownRenderSource(textContent)
      if (shouldEnableMarkdown && isMarkdownPreviewOpenRef.current) {
        setMarkdownRenderedHtml('')
        markdownRenderedHtmlRef.current = ''
        setMarkdownImagePaths([])
      }
    }
    const usedMarkdownSessionCache = shouldEnableMarkdown && isMarkdownPreviewOpenRef.current && Boolean(markdownCacheEntry)
    if (shouldEnableMarkdown && isMarkdownPreviewOpenRef.current && !markdownCacheEntry) {
      beginPreviewRestore()
    } else if (!usedMarkdownSessionCache) {
      resetPreviewRestoreState()
    }
    setIsMarkdownRenderEnabled(shouldEnableMarkdown && isMarkdownPreviewOpenRef.current)

    const applyPendingAfterModelReady = async () => {
      const ready = await waitForEditorModelReady(path, 2000, textContent)
      if (!ready) return false
      if (
        (pendingViewStateRef.current || pendingCursorRef.current) &&
        pendingViewStatePathRef.current === path
      ) {
        applyPendingViewState()
      }
      return true
    }
    if (source === 'debug') {
      const ready = await applyPendingAfterModelReady()
      if (!ready) {
        debugLog('openFile:debug-model-timeout', { path })
      }
    } else {
      void applyPendingAfterModelReady()
    }
  }, [
    applyPendingCursorPosition,
    applyPendingViewState,
    applyLargeFileState,
    beginPreviewRestore,
    clearActiveFileState,
    confirmDiscardChanges,
    isMarkdownPreviewOpen,
    loadLargeFileChunk,
    removeQuickFileEntries,
    requestConfirm,
    requestFileOpenChoice,
    resetPreviewRestoreState,
    scheduleProjectStateSave,
    setActiveFilePathValue,
    setDiffJumpTargetValue,
    showStatus,
    syncOriginalVersion,
    applyMarkdownSessionCacheHit,
    closeHtmlPreviewSearch,
    restoreFileMemory,
    saveCurrentFileMemory,
    touchRecentFile,
    updateHtmlPreviewScrollState,
    updateHtmlReaderState,
    waitForEditorModelReady,
    t
  ])

  const openFileRef = useRef(openFile)
  useEffect(() => {
    openFileRef.current = openFile
  }, [openFile])

  const validateRetainedActiveFileFreshness = useCallback(async (path: string, retainedContent: string) => {
    const root = rootRef.current
    if (!root) return
    const requestId = retainedFreshnessRequestIdRef.current + 1
    retainedFreshnessRequestIdRef.current = requestId
    const result = await window.electronAPI.project.readFile(root, path)
    if (requestId !== retainedFreshnessRequestIdRef.current) return
    if (!isOpenRef.current || activeFilePathRef.current !== path) return
    if (
      result.success &&
      !result.isBinary &&
      !result.isImage &&
      !result.isSqlite &&
      (result.content ?? '') === retainedContent
    ) {
      return
    }
    await openFileRef.current(path, 'restore', { forceReload: true })
  }, [])

  const invalidateFileIndex = useCallback(() => {
    const root = rootRef.current
    if (!root) return
    fileIndexInvalidate(root)
    void window.electronAPI.project.invalidateFileIndex(root)
  }, [])

  const getFileIndex = useCallback(() => {
    const root = rootRef.current
    if (!root) return []
    return fileIndexSnapshot(root).files
  }, [])

  const buildFileIndex = useCallback(async () => {
    const root = rootRef.current
    if (!root) return []
    const snapshot = fileIndexSnapshot(root)
    if (snapshot.status === 'ready') {
      return snapshot.files
    }
    const start = performance.now()
    if (DEBUG_PROJECT_EDITOR) {
      debugLog('index:build:start', { root })
    }
    setIsIndexing(true)
    try {
      const result = await fileIndexEnsure(root, async (cwd) => {
        return await window.electronAPI.project.buildFileIndex(cwd)
      })
      if (DEBUG_PROJECT_EDITOR) {
        debugLog('index:build:done', {
          root,
          total: result.length,
          duration: Math.round(performance.now() - start)
        })
      }
      return result
    } finally {
      setIsIndexing(false)
    }
  }, [])

  const handleOpenSearch = useCallback(async () => {
    setSearchOpen(true)
    setSearchQuery('')
    setSearchActiveIndex(0)
    const root = rootRef.current
    let index = root ? fileIndexSnapshot(root).files : []
    if (index.length === 0) {
      index = await buildFileIndex()
    }
    setSearchResults(root ? await window.electronAPI.project.searchFilenames(root, '', 50) : buildFuzzyResults('', index))
    setTimeout(() => searchInputRef.current?.focus(), 0)
  }, [buildFileIndex])

  const handleCloseSearch = useCallback(() => {
    setSearchOpen(false)
    setSearchQuery('')
    setSearchResults([])
    setSearchActiveIndex(0)
  }, [])

  const handleOpenSearchRef = useRef(handleOpenSearch)
  const handleCloseSearchRef = useRef(handleCloseSearch)
  useEffect(() => {
    handleOpenSearchRef.current = handleOpenSearch
  }, [handleOpenSearch])
  useEffect(() => {
    handleCloseSearchRef.current = handleCloseSearch
  }, [handleCloseSearch])

  // (sidebar search is now controlled by sidebarMode state, no overlay needed)


  const loadRoot = useCallback(async (root: string) => {
    const start = performance.now()
    if (DEBUG_PROJECT_EDITOR) {
      debugLog('root:load:start', { root })
    }
    const result = await window.electronAPI.project.listDirectory(root, '')
    if (!result.success) {
      setRootError(result.error || t('projectEditor.error.readDirectory'))
      setTree([])
      if (DEBUG_PROJECT_EDITOR) {
        debugLog('root:load:error', { root, error: result.error })
      }
      return
    }
    setTree(buildNodes(result.entries))
    if (DEBUG_PROJECT_EDITOR) {
      debugLog('root:load:done', {
        root,
        entries: result.entries?.length ?? 0,
        duration: Math.round(performance.now() - start)
      })
    }
  }, [t])

  useEffect(() => {
	    if (DEBUG_PROJECT_EDITOR) {
	      debugLog('root:effect', { isOpen, cwd })
	    }
	    if (!isOpen) {
	      // Retain the live view only when the scope that just closed (or the
	      // scope owning the on-screen file) has a retained snapshot — another
	      // scope's snapshot must not keep a foreign file mounted.
	      const retainClosedView = Boolean(
	        editorSoftCloseSnapshotsRef.current.peek(getScrollScopeKey(lastEditorScopeRef.current)) ??
	        editorSoftCloseSnapshotsRef.current.peek(activeFileScopeKeyRef.current)
	      )
      gitDiffOpenRef.current = false
      debugAutoOpenRef.current = false
      restoringStateRef.current = false
      restoreTokenRef.current += 1
      openFileTokenRef.current += 1
      setContextMenu(null)
      setSearchOpen(false)
      setSidebarMode('files')
      setInitialSearchType('content')
      setSearchQuery('')
      setSearchResults([])
      setSearchActiveIndex(0)
      closePreviewSearch()
      setDialog(null)
      setDialogInput('')
      if (retainClosedView) {
        return
      }
      setTree([])
      setSelectedPath(null)
      setActiveFilePathValue(null)
      setPinnedFiles([])
      setRecentFiles([])
      setDraggingPinnedPath(null)
      setDraggingQuickPath(null)
      setDraggingQuickSource(null)
      setDragOverPinnedPath(null)
      setFileContent('')
      fileContentRef.current = ''
      setOutlineContentSnapshot({ filePath: null, content: '' })
      setIsBinary(false)
      isBinaryRef.current = false
      setIsImage(false)
      isImageRef.current = false
	      setIsSqlite(false)
	      isSqliteRef.current = false
	      setIsPdf(false)
	      isPdfRef.current = false
	      setIsEpub(false)
	      isEpubRef.current = false
	      setIsHtml(false)
	      isHtmlRef.current = false
	      setImagePreviewUrl(null)
	      setPdfPreviewUrl(null)
	      setEpubPreviewUrl(null)
	      setHtmlPreviewUrl(null)
	      htmlPreviewUrlRef.current = null
	      setHtmlPreviewReloadKey(0)
	      htmlPreviewReloadKeyRef.current = 0
	      updateHtmlPreviewScrollState(null)
	      closeHtmlPreviewSearch()
	      updateHtmlReaderState(null)
      setIsMarkdownPreviewOpen(true)
      setIsDirty(false)
      originalContentRef.current = ''
      originalModelVersionRef.current = null
      setIsLoadingFile(false)
      setRootPath(null)
      setRootError(null)
      setMarkdownImageMap({})
      markdownImageMapRef.current = {}
      void window.electronAPI.project.unwatchAllImageFiles()
      watchedImagePathsRef.current = new Set()
      rootRef.current = null
      editorSaveCommandIdRef.current = null
      return
    }

	    const effectiveCwd = cwd || (window.electronAPI?.debug?.autotest
	      ? window.electronAPI.debug.autotestCwd
	      : null)

	    if (!effectiveCwd) {
	      // Drop only this terminal's snapshots — other Tasks keep theirs.
	      editorSoftCloseSnapshotsRef.current.deleteWhere((_key, snapshot) => snapshot.scope.terminalId === _terminalId)
	      setRootError(t('projectEditor.error.noWorkingDirectory'))
      setRootPath(null)
      setPinnedFiles([])
      setRecentFiles([])
      rootRef.current = null
      if (DEBUG_PROJECT_EDITOR) {
        debugLog('root:missing-cwd', { isOpen })
      }
      return
    }

    const normalizedCwd = normalizePath(effectiveCwd)
    const previousRoot = rootRef.current ? normalizePath(rootRef.current) : null
    if (previousRoot && previousRoot !== normalizedCwd) {
      if (DEBUG_PROJECT_EDITOR) {
        debugLog('root:changed', { previousRoot, nextRoot: normalizedCwd })
	      }
	      restoreTokenRef.current += 1
	      // Root change resets the LIVE state below; per-scope snapshots stay in
	      // the store so the previous root's Task can still instant-reopen.
	      hasRestoredStateRef.current = false
      restoringStateRef.current = false
      resetActiveFileState()
      setPinnedFiles([])
      setRecentFiles([])
      setTree([])
      setContextMenu(null)
      setSearchOpen(false)
      setSidebarMode('files')
      setSearchQuery('')
      setSearchResults([])
      setSearchActiveIndex(0)
    }

    setRootError(null)
    gitDiffOpenRef.current = false
    setRootPath(effectiveCwd)
    rootRef.current = effectiveCwd
    setSearchResults([])
    void loadRoot(effectiveCwd)
  }, [_terminalId, closeHtmlPreviewSearch, closePreviewSearch, cwd, isOpen, loadRoot, resetActiveFileState, setActiveFilePathValue, t, updateHtmlPreviewScrollState, updateHtmlReaderState])

  useEffect(() => {
    if (!isOpen || !rootPath) return
    const unsubscribe = fileIndexSubscribe(rootPath, () => {
      setFileIndexVersion((version) => version + 1)
    })
    return () => {
      unsubscribe()
    }
  }, [isOpen, rootPath])

  useEffect(() => {
    if (!isOpen || !openRequest) return
    if (lastHandledOpenRequestRef.current === openRequest.id) return
    if (!_terminalId || openRequest.terminalId !== _terminalId) return
    if (!rootPath) return

    lastHandledOpenRequestRef.current = openRequest.id
    if (openRequest.source === 'diff' || openRequest.returnTarget === 'diff') {
      setDiffReturnContext({
        terminalId: openRequest.terminalId,
        filePath: openRequest.diffFilePath ?? openRequest.filePath ?? null,
        repoRoot: openRequest.diffRepoRoot ?? openRequest.repoRoot ?? null,
        createdAt: Date.now()
      })
    } else {
      setDiffReturnContext(null)
    }

    if (!openRequest.filePath) {
      const currentScope = buildProjectEditorScope(_terminalId, rootRef.current ?? cwd ?? null)
      const currentScopeKey = getScrollScopeKey(currentScope)
      const softCloseSnapshot = editorSoftCloseSnapshotsRef.current.peek(currentScopeKey)
      const hasSubpageReturnSnapshot = isProjectEditorSoftCloseSnapshotForScope(
        softCloseSnapshot,
        currentScope,
        'subpage-return'
      )
      if (hasSubpageReturnSnapshot) {
        // Subpage-return snapshots are one-shot: consume on apply.
        editorSoftCloseSnapshotsRef.current.delete(currentScopeKey)
        applyEditorSoftCloseSnapshot(softCloseSnapshot)
        if (
          softCloseSnapshot.path &&
          isMarkdownPath(softCloseSnapshot.path) &&
          softCloseSnapshot.isMarkdownPreviewOpen &&
          !softCloseSnapshot.isBinary &&
          !softCloseSnapshot.isImage &&
          !softCloseSnapshot.isSqlite
        ) {
          const cacheKey = rootRef.current
            ? getMarkdownSessionCacheKey(rootRef.current, softCloseSnapshot.path)
            : null
          if (cacheKey) {
            pendingMarkdownSessionCacheRestoreRef.current = {
              key: cacheKey,
              filePath: softCloseSnapshot.path
            }
          }
          setIsMarkdownRenderEnabled(true)
          if (markdownRenderedHtmlRef.current) {
            resetPreviewRestoreState()
          } else {
            beginPreviewRestore()
          }
        }
      } else if (
        activeFilePathRef.current &&
        isMarkdownPath(activeFilePathRef.current) &&
        isMarkdownPreviewOpenRef.current &&
        Boolean(markdownRenderedHtmlRef.current) &&
        !isBinaryRef.current &&
        !isImageRef.current &&
        !isSqliteRef.current
      ) {
        setIsMarkdownRenderEnabled(true)
        resetPreviewRestoreState()
      }
      return
    }

    if (cwd && normalizeComparablePath(rootPath) !== normalizeComparablePath(cwd)) return

    const navigationPath = resolveNavigationFilePath({
      editorRoot: rootPath,
      filePath: openRequest.filePath,
      repoRoot: openRequest.repoRoot,
      platform: window.electronAPI.platform
    })

    if (!navigationPath) {
      const missingNotice = buildMissingFileNotice(openRequest.filePath, 'user', locale)
      clearActiveFileState({ preserveMissingNotice: true })
      setMissingFileNotice({
        path: openRequest.filePath,
        message: missingNotice.notice
      })
      showStatus('error', missingNotice.status)
      return
    }

    void openFile(navigationPath, 'user', {
      trackRecent: true,
      missingBehavior: 'empty-state'
    })
  }, [
    applyEditorSoftCloseSnapshot,
    beginPreviewRestore,
    clearActiveFileState,
    cwd,
    isOpen,
    locale,
    openFile,
    openRequest,
    resetPreviewRestoreState,
    rootPath,
    showStatus,
    _terminalId
  ])

  useEffect(() => {
    if (isOpen) return
    setDiffReturnContext(null)
    setDiffJumpTargetValue(null)
    setDiffJumpChecking(false)
  }, [isOpen, setDiffJumpTargetValue])

  useEffect(() => {
    if (!isOpen || !diffReturnContext || !rootPath || !activeFilePath) {
      setDiffJumpTargetValue(null)
      setDiffJumpChecking(false)
      return
    }

    const token = diffJumpCheckTokenRef.current + 1
    diffJumpCheckTokenRef.current = token
    setDiffJumpChecking(true)
    void window.electronAPI.git.getDiff(rootPath, { scope: 'full' })
      .then((result) => {
        if (diffJumpCheckTokenRef.current !== token) return
        const match = findDiffFileForEditorPath({
          diff: result as GitDiffResult,
          editorRoot: rootPath,
          editorFilePath: activeFilePath,
          platform: window.electronAPI.platform
        })
        setDiffJumpTargetValue(match
          ? {
              filename: match.filename,
              repoRoot: match.repoRoot || (result as GitDiffResult).cwd || rootPath,
              changeType: match.changeType
            }
          : null)
      })
      .catch(() => {
        if (diffJumpCheckTokenRef.current === token) {
          setDiffJumpTargetValue(null)
        }
      })
      .finally(() => {
        if (diffJumpCheckTokenRef.current === token) {
          setDiffJumpChecking(false)
        }
      })
  }, [activeFilePath, diffReturnContext, isOpen, rootPath, setDiffJumpTargetValue])

  useEffect(() => {
    const currentScope = buildProjectEditorScope(_terminalId, rootRef.current ?? cwd ?? null)
    if (!isOpen) {
      if (wasOpenRef.current && lastEditorScopeRef.current) {
        if (skipClosePersistRef.current) {
          skipClosePersistRef.current = false
        } else {
          persistProjectEditorState(lastEditorScopeRef.current)
        }
      }
      lastEditorScopeRef.current = null
      wasOpenRef.current = false
      return
    }

    if (currentScope) {
      if (!wasOpenRef.current) {
        projectEditorReopenStartedAtRef.current = performance.now()
      }
      const previousScope = lastEditorScopeRef.current
      if (previousScope && !isSameProjectEditorScope(previousScope, currentScope)) {
        persistProjectEditorState(previousScope)
      }
      const scopeChanged = !isSameProjectEditorScope(previousScope, currentScope)
      lastEditorScopeRef.current = currentScope
      // Soft-close fast path: surface the previous active file immediately
      // so state restoration does not wait for the full tree + AppState
      // pipeline. The snapshot also keeps Monaco populated before
      // applyPendingViewState runs. Per-scope store: another scope's open no
      // longer clears this scope's snapshot.
      const currentScopeKey = getScrollScopeKey(currentScope)
      const scopedSoftCloseSnapshot = editorSoftCloseSnapshotsRef.current.get(currentScopeKey)
      const hadSubpageReturnSnapshot = scopedSoftCloseSnapshot?.kind === 'subpage-return'
      if (hadSubpageReturnSnapshot) {
        // Subpage-return snapshots are one-shot: consume on apply.
        editorSoftCloseSnapshotsRef.current.delete(currentScopeKey)
        applyEditorSoftCloseSnapshot(scopedSoftCloseSnapshot)
      }
      if (scopeChanged || !wasOpenRef.current) {
        // Ownership reconciliation for the same-root Task switch: the live
        // DOM may still show the PREVIOUS scope's file. A retained snapshot
        // for THIS scope revives instantly when the file's content travels in
        // the snapshot (markdown / plain text). URL-backed viewers (PDF /
        // EPUB / HTML / image / sqlite) cannot be revived from the snapshot —
        // their preview URLs belong to the foreign file — so reset and let
        // the persisted-state restore remount them with this scope's memory.
        const liveViewIsForeign = Boolean(
          activeFilePathRef.current &&
          activeFileScopeKeyRef.current !== null &&
          currentScopeKey !== null &&
          activeFileScopeKeyRef.current !== currentScopeKey
        )
        if (scopedSoftCloseSnapshot?.kind === 'retained-close' && liveViewIsForeign) {
          const snapshotIsContentBacked = Boolean(
            scopedSoftCloseSnapshot.path &&
            !scopedSoftCloseSnapshot.isBinary &&
            !scopedSoftCloseSnapshot.isImage &&
            !scopedSoftCloseSnapshot.isSqlite &&
            !scopedSoftCloseSnapshot.isPdf &&
            !scopedSoftCloseSnapshot.isEpub &&
            !scopedSoftCloseSnapshot.isHtml
          )
          if (snapshotIsContentBacked) {
            // The on-screen rendered HTML belongs to the other file — blank it
            // so the markdown branch below takes the idempotent session-cache
            // re-apply arm instead of trusting the foreign zero-flash DOM.
            markdownRenderedHtmlRef.current = ''
            setMarkdownRenderedHtml('')
            applyEditorSoftCloseSnapshot(scopedSoftCloseSnapshot)
          } else {
            resetActiveFileState()
          }
        } else if (liveViewIsForeign && !hadSubpageReturnSnapshot) {
          // No snapshot for this scope: never keep a foreign file on screen.
          resetActiveFileState()
        }
        const hasRetainedViewForScope = Boolean(
          scopedSoftCloseSnapshot?.kind === 'retained-close' &&
          activeFilePathRef.current &&
          rootRef.current &&
          (activeFileScopeKeyRef.current === null || activeFileScopeKeyRef.current === currentScopeKey)
        )
        if (!wasOpenRef.current) {
          perfTraceDiagnostic(
            scopedSoftCloseSnapshot
              ? PERF_TRACE_EVENT.RENDERER_PROJECT_EDITOR_SNAPSHOT_APPLIED
              : PERF_TRACE_EVENT.RENDERER_PROJECT_EDITOR_SNAPSHOT_MISSED,
            {
              ph: 'i',
              kind: scopedSoftCloseSnapshot?.kind ?? null,
              retained: hasRetainedViewForScope
            }
          )
        }
        restoredStateRef.current = getProjectEditorState(currentScope)
        hasRestoredStateRef.current = false
        restoringStateRef.current = false

        // Load unified per-file memory from persisted fileStates
        fileMemoryRef.current.clear()
        fileFirstVisibleLineRef.current.clear()
        const storedState = restoredStateRef.current
        if (storedState?.fileStates) {
          for (const [filePath, mem] of Object.entries(storedState.fileStates)) {
            if (filePath && mem) fileMemoryRef.current.set(filePath, mem)
          }
        }
        const backCompatEntry = buildLegacyFileMemoryEntry(storedState)
        if (!storedState?.fileStates && storedState?.activeFilePath && backCompatEntry) {
          fileMemoryRef.current.set(storedState.activeFilePath, backCompatEntry)
        }

        const markdownRestorePath =
          storedState?.activeFilePath && isMarkdownPath(storedState.activeFilePath)
            ? storedState.activeFilePath
            : hadSubpageReturnSnapshot &&
                scopedSoftCloseSnapshot?.path &&
                isMarkdownPath(scopedSoftCloseSnapshot.path)
              ? scopedSoftCloseSnapshot.path
              : null

        if (markdownRestorePath) {
          const activePath = activeFilePathRef.current
          const root = rootRef.current
          const cacheRead = root && activePath
            ? readMarkdownSessionCache(root, activePath, fileContentRef.current)
            : null
          // Diagnostic breadcrumb for the reopen-restore branch decision: which
          // inputs drove which restore arm (zero-flash / re-apply / fresh render /
          // bare reset). Lets a "blank preview on the cold first reopen" report
          // show whether a cache entry existed and whether the HTML ref was empty.
          mdpTrace('reopen-restore:decision', {
            hasRetainedView: hasRetainedViewForScope,
            hasSubpageReturn: hadSubpageReturnSnapshot,
            pathMatch: activePath === markdownRestorePath,
            previewOpen: isMarkdownPreviewOpenRef.current,
            cacheEntry: Boolean(cacheRead?.entry),
            htmlRefLen: markdownRenderedHtmlRef.current.length,
            renderSourceLen: markdownRenderSourceRef.current.length,
            renderAllowed: markdownRenderAllowedRef.current
          })
          // Re-enable the render gate that `resetActiveFileState` cleared
          // on Diff / History entry, gated to soft-close paths
          // (retain-view via ESC shortcut, subpage-return via Diff /
          // History button). Without this, `isMarkdownRenderAllowed`
          // would stay false and the preview pane would report
          // `isMarkdownPreviewVisible=false` even when the rendered HTML
          // is back on screen.
          if (
            (hasRetainedViewForScope || hadSubpageReturnSnapshot) &&
            isMarkdownPreviewOpenRef.current &&
            !isBinaryRef.current &&
            !isImageRef.current &&
            !isSqliteRef.current
          ) {
            setIsMarkdownRenderEnabled(true)
          }
          if (
            hasRetainedViewForScope &&
            activePath === markdownRestorePath &&
            isMarkdownPreviewOpenRef.current &&
            (Boolean(markdownRenderedHtmlRef.current) || Boolean(cacheRead?.entry))
          ) {
            if (cacheRead) {
              markdownSessionLastRestoreRef.current = cacheRead.result
            }
            // The decision below is made purely from the ACTUAL current state (is
            // the rendered HTML still on screen?) plus the cache, so it
            // self-corrects no matter what the owner-switch / deactivate branch
            // did. The previous "Option A already restored, so do nothing" no-op
            // arm trusted a one-shot flag that a follow-on worker-deactivate
            // render could invalidate by blanking markdownRenderedHtmlRef AFTER
            // the flag was set — leaving the first retained reopen on an
            // EDR-throttled host with the flag still true but the HTML at length
            // 0, so this effect did nothing and getMarkdownRenderedHtml() never
            // recovered (PMSR-09/10/11/13/13a/13b, PMN-41, CDP-10).
            // applyMarkdownSessionCacheHit is idempotent for an identical entry,
            // so re-applying when the HTML was lost is safe.
            //
            // hasRenderedHtmlOnScreen MUST reflect the ACTUAL on-screen DOM, not
            // just `markdownRenderedHtmlRef.current`. On the VERY FIRST retained
            // reopen the ref can read stale-truthy: the state->ref sync effect
            // (L3375) had not yet propagated the deactivate-branch blank, while
            // the `.project-editor-preview-content` node was already emptied. The
            // old ref-only signal then took the zero-flash path (which never
            // repopulates the ref) and stranded the first reopen at htmlLength 0
            // even though subsequent reopens — where the ref had already settled
            // to '' so the re-apply path ran — restored fine (the 8x=23322 /
            // 3x=0 first-reopen-only residual in the round-5 PMSR log). Require
            // the live DOM content node to actually carry HTML before trusting
            // the zero-flash path; when the DOM is empty, fall through to the
            // idempotent applyMarkdownSessionCacheHit re-apply path that makes
            // every later reopen green.
            const previewContentNode = previewRef.current?.querySelector(
              '.project-editor-preview-content'
            ) as HTMLElement | null
            const domHasRenderedHtml = Boolean(previewContentNode?.innerHTML)
            if (cacheRead?.entry && shouldTakeZeroFlashReopenPath({
              hasContentIdenticalCacheEntry: true,
              hasRenderedHtmlOnScreen: Boolean(markdownRenderedHtmlRef.current) && domHasRenderedHtml
            })) {
              // ZERO-FLASH retained reopen: the rendered HTML is STILL on screen
              // (the worker-deactivate branch's preserveClosedPreview now also
              // covers the reopen-in-flight window, so markdownRenderedHtmlRef
              // was never blanked and the already-rendered mermaid DOM survives,
              // pending === 0). React reuses the identical dangerouslySetInnerHTML
              // node, so we MUST NOT call applyMarkdownSessionCacheHit here:
              // beginPreviewRestore() would flip the phase to 'waiting-html' and
              // fade the content to opacity 0 — the exact user-visible reflash
              // PMSR-13a/13b guard against. Instead mirror the subpage-return
              // variant below: re-seed markdownSessionCacheRenderRef so the
              // worker effect's shouldPreserveCachedRender holds, arm the pending
              // scroll restore (consumed by the layout effect via the render
              // nonce), and leave the phase at 'idle'.
              markdownSessionCacheRenderRef.current = {
                key: cacheRead.entry.key,
                filePath: activePath,
                content: fileContentRef.current
              }
              pendingMarkdownSessionCacheRestoreRef.current = {
                key: cacheRead.entry.key,
                filePath: activePath
              }
              // Re-affirm the rendered HTML onto state + ref. The string is
              // byte-identical to what is already on screen, so React reuses the
              // same dangerouslySetInnerHTML node — NO reflash (PMSR-13a/13b
              // hold, this does NOT call beginPreviewRestore). Re-asserting the
              // REF keeps shouldPreserveCachedRender (the worker-effect
              // owner-switch guard, which requires markdownRenderedHtmlRef
              // non-empty) true, so a follow-on owner-switch render that fires in
              // the reopen-in-flight window after this branch ran cannot blank the
              // preview and strand the first reopen at htmlLength 0 (PMSR-09/10/11
              // on EDR-throttled Windows, where the late render lands past the
              // snapshot-cleared preserve window).
              markdownRenderedHtmlRef.current = cacheRead.entry.renderedHtml
              setMarkdownRenderedHtml(cacheRead.entry.renderedHtml)
              // Bump the render nonce so the scroll-restore + mermaid-rebuild
              // layout effects re-run even though markdownRenderedHtml is the
              // same string (React would otherwise skip them). This re-applies
              // the saved preview scroll and rebuilds mermaid panzoom without
              // ever leaving the 'idle' phase. See nonce declaration.
              setMarkdownPreviewRenderNonce((nonce) => nonce + 1)
              resetPreviewRestoreState()
              perfTrace(PERF_TRACE_EVENT.RENDERER_PROJECT_EDITOR_MD_REOPEN_PRESERVED_NO_FLASH, {
                // Basename only — keep the payload tiny and free of full paths.
                filePath: activePath.split(/[\\/]/).pop() ?? activePath,
                htmlLength: markdownRenderedHtmlRef.current.length
              })
            } else if (cacheRead?.entry) {
              // Content-identical cache hit but nothing currently on screen (the
              // retained HTML was lost, e.g. a non-retained close or an EDR race
              // beat preserveClosedPreview). Apply the cache hit to repopulate
              // the preview: this re-seeds markdownSessionCacheRenderRef +
              // markdownRenderedHtmlRef so the worker effect's
              // shouldPreserveCachedRender holds and never blanks, and it runs
              // beginPreviewRestore() + queuePreviewReveal() so the saved scroll
              // is re-applied. applyMarkdownSessionCacheHit is idempotent for an
              // identical entry (it overwrites the same HTML/refs).
              if (Boolean(markdownRenderedHtmlRef.current) && !domHasRenderedHtml) {
                // Stale-ref first-reopen case: the ref read truthy but the live
                // DOM was empty, so we fell through from the zero-flash branch
                // to this idempotent re-apply. Breadcrumb so a future "blank
                // preview on the first reopen is back" report shows the
                // fall-through fired.
                perfTrace(PERF_TRACE_EVENT.RENDERER_PROJECT_EDITOR_MD_REOPEN_DOM_EMPTY_REAPPLY, {
                  // Basename only — keep the payload tiny and free of full paths.
                  filePath: activePath.split(/[\\/]/).pop() ?? activePath
                })
              }
              applyMarkdownSessionCacheHitRef.current(activePath, fileContentRef.current, cacheRead.entry)
            } else {
              // No content-identical cache entry. Either nothing is on screen (a
              // fresh worker render will drive the restore) or the retained close
              // preserved the rendered HTML; in both cases reset the phase to
              // 'idle' (this does not blank HTML, it only clears any stale
              // in-flight reveal phase).
              mdpTrace('reopen-restore:retained-reset-no-cache', {
                htmlRefLen: markdownRenderedHtmlRef.current.length
              })
              resetPreviewRestoreState()
            }
            finalizeProjectEditorReopenRestore(
              'retained-view',
              activePath,
              cacheRead?.result.mode ?? null
            )
            void validateRetainedActiveFileFreshness(activePath, fileContentRef.current)
          } else if (
            hadSubpageReturnSnapshot &&
            activePath === markdownRestorePath &&
            isMarkdownPreviewOpenRef.current &&
            Boolean(markdownRenderedHtmlRef.current)
          ) {
            // Subpage round-trip variant of the retained-view fast path:
            // the preserveClosedPreview branch in the worker-deactivate
            // effect kept `markdownRenderedHtmlRef` populated through the
            // Diff / History detour, so the rendered HTML is still on
            // screen. Skip `beginPreviewRestore` (which would otherwise
            // flip the preview phase to 'waiting-html' and drive the
            // content opacity to 0). Render gate is re-enabled above for
            // the whole markdown branch.
            const cacheKey = root
              ? getMarkdownSessionCacheKey(root, activePath)
              : null
            if (cacheKey) {
              pendingMarkdownSessionCacheRestoreRef.current = {
                key: cacheKey,
                filePath: activePath
              }
            }
            resetPreviewRestoreState()
          } else {
            mdpTrace('reopen-restore:fresh-render', {
              htmlRefLen: markdownRenderedHtmlRef.current.length,
              renderSourceLen: markdownRenderSourceRef.current.length
            })
            beginPreviewRestore()
          }
        } else {
          resetPreviewRestoreState()
          if (hasRetainedViewForScope) {
            finalizeProjectEditorReopenRestore('retained-view', activeFilePathRef.current, null)
          }
        }
      }
    }
    wasOpenRef.current = true
  }, [
    applyEditorSoftCloseSnapshot,
    beginPreviewRestore,
    cwd,
    finalizeProjectEditorReopenRestore,
    getProjectEditorState,
    isOpen,
    persistProjectEditorState,
    resetActiveFileState,
    resetPreviewRestoreState,
    validateRetainedActiveFileFreshness,
    _terminalId
  ])

  useEffect(() => {
    const flushProjectEditorBeforeUnload = () => {
      if (!isOpenRef.current) return
      const scope = lastEditorScopeRef.current
      if (!scope) return
      const snapshot = buildProjectEditorStateSnapshot(scope)
      flushProjectEditorState(scope, snapshot)
    }
    window.addEventListener('beforeunload', flushProjectEditorBeforeUnload)
    window.addEventListener('pagehide', flushProjectEditorBeforeUnload)
    return () => {
      window.removeEventListener('beforeunload', flushProjectEditorBeforeUnload)
      window.removeEventListener('pagehide', flushProjectEditorBeforeUnload)
    }
  }, [buildProjectEditorStateSnapshot, flushProjectEditorState])

  useEffect(() => {
    if (!isOpen) return
    // During subpage navigation (Editor→Diff/History) or explicit close,
    // the caller already persisted the correct state before calling
    // resetActiveFileState().  Suppress the auto-save to prevent the now-empty
    // transient state from overwriting the already-persisted snapshot.
    if (skipClosePersistRef.current) return
    if (restoringStateRef.current) return
    if (!hasRestoredStateRef.current && !activeFilePath && pinnedFiles.length === 0 && recentFiles.length === 0) return
    scheduleProjectStateSave()
  }, [activeFilePath, isOpen, pinnedFiles, recentFiles, rootPath, scheduleProjectStateSave, tree])

  useEffect(() => {
    if (!searchOpen || isIndexing) return
    const root = rootRef.current
    if (!root) {
      setSearchResults([])
      setSearchActiveIndex(0)
      return
    }
    let cancelled = false
    window.electronAPI.project.searchFilenames(root, searchQuery, 50)
      .then((results) => {
        if (cancelled) return
        setSearchResults(results)
        setSearchActiveIndex(0)
      })
      .catch((error) => {
        if (cancelled) return
        if (DEBUG_PROJECT_EDITOR) {
          debugLog('index:search:error', { root, query: searchQuery, error: String(error) })
        }
        setSearchResults([])
        setSearchActiveIndex(0)
      })
    return () => {
      cancelled = true
    }
  }, [searchOpen, searchQuery, isIndexing, fileIndexVersion])

  useEffect(() => {
    if (!contextMenu || !contextMenuRef.current || !modalRef.current) return
    const menuRect = contextMenuRef.current.getBoundingClientRect()
    const modalRect = modalRef.current.getBoundingClientRect()
    const padding = 8
    let nextX = contextMenu.x
    let nextY = contextMenu.y
    const maxX = modalRect.width - menuRect.width - padding
    const maxY = modalRect.height - menuRect.height - padding

    if (nextX > maxX) nextX = Math.max(padding, maxX)
    if (nextY > maxY) nextY = Math.max(padding, maxY)
    if (nextX < padding) nextX = padding
    if (nextY < padding) nextY = padding

    if (nextX !== contextMenu.x || nextY !== contextMenu.y) {
      setContextMenu((prev) => (prev ? { ...prev, x: nextX, y: nextY } : prev))
    }
  }, [contextMenu])

  const refreshDirectory = useCallback(async (path: string) => {
    const root = rootRef.current
    if (!root) return

    const result = await window.electronAPI.project.listDirectory(root, path)
    if (!result.success) {
      showStatus('error', result.error || t('projectEditor.error.readDirectory'))
      return
    }

    const nextChildren = buildNodes(result.entries)

    if (!path) {
      setTree((prev) => mergeChildren(prev, nextChildren))
      return
    }

    setTree((prev) => updateTree(prev, path, (node) => ({
      ...node,
      isExpanded: true,
      isLoading: false,
      children: mergeChildren(node.children, nextChildren)
    })))
  }, [showStatus, t])

  const applyExpandedDirectories = useCallback(async (paths: string[], token: number) => {
    if (paths.length === 0) return
    const unique = Array.from(new Set(paths.filter(Boolean)))
    unique.sort((a, b) => a.split('/').length - b.split('/').length)
    for (const path of unique) {
      if (token !== restoreTokenRef.current) return
      await refreshDirectory(path)
      if (token !== restoreTokenRef.current) return
    }
  }, [refreshDirectory])

  // Expand ancestor directories of `filePath` and smooth-center the tree row
  // inside the File Browser viewport. Used by non-tree open sources (Search,
  // Pin, Recent, ...) and by the "Locate current file" header button.
  const revealFileInBrowser = useCallback(
    async (filePath: string | null, opts: { force?: boolean } = {}) => {
      const diag = ((window as unknown) as { __onwardFileBrowserRevealDiag?: {
        calls: number; skippedNoPath: number; skippedPaused: number;
        skippedNoContainer: number; skippedNoRow: number; scrolled: number;
        lastPath: string | null; lastReason: string | null;
        lastForce: boolean; lastAncestorCount: number
      } }).__onwardFileBrowserRevealDiag ??= {
        calls: 0, skippedNoPath: 0, skippedPaused: 0,
        skippedNoContainer: 0, skippedNoRow: 0, scrolled: 0,
        lastPath: null, lastReason: null,
        lastForce: false, lastAncestorCount: 0
      }
      diag.calls += 1
      diag.lastPath = filePath
      diag.lastForce = Boolean(opts.force)
      if (!filePath) {
        diag.skippedNoPath += 1
        diag.lastReason = 'no-path'
        return
      }
      const now = performance.now()
      if (!opts.force && now - fileTreeUserScrollAtRef.current < FILE_BROWSER_USER_SCROLL_PAUSE_MS) {
        diag.skippedPaused += 1
        diag.lastReason = 'user-scroll-pause'
        return
      }
      // If the tree is unmounted (sidebarMode === 'search'), defer the reveal
      // so we can replay once the user returns to Files mode.
      if (!fileTreeContainerRef.current) {
        diag.skippedNoContainer += 1
        diag.lastReason = 'no-container-deferred'
        pendingRevealPathRef.current = filePath
        return
      }
      // Open the settle window first so ancestor-expansion setTree events
      // don't trigger queueFileTreeScrollRestore, which would otherwise fight
      // our eventual scrollTo and leave the tree at a stale position.
      fileTreeProgrammaticScrollUntilRef.current = performance.now() + 3000
      const ancestors = collectAncestorDirPaths(filePath)
      diag.lastAncestorCount = ancestors.length
      if (ancestors.length > 0) {
        await applyExpandedDirectories(ancestors, restoreTokenRef.current)
      }
      // Abort if the editor has since moved to a different file. Without
      // this guard the stale reveal would highlight and scroll to a row the
      // user has already navigated away from.
      if (activeFilePathRef.current !== filePath) {
        diag.lastReason = 'stale-active'
        return
      }
      // Select the file so the revealed row also gets the visual highlight.
      setSelectedPath(filePath)
      // Give React enough frames to commit the expanded-tree updates.
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
      if (activeFilePathRef.current !== filePath) {
        diag.lastReason = 'stale-active'
        return
      }
      const scopeKey = getScrollScopeKey(lastEditorScopeRef.current)
      // Compute the centered scroll target ourselves — so we can also update
      // fileTreeScrollTopRef before any late setTree restore has a chance to
      // read a stale value.
      const applyReveal = (label: string): boolean => {
        // Bail if the active file changed between scheduling and running.
        if (activeFilePathRef.current !== filePath) return false
        const liveContainer = fileTreeContainerRef.current
        if (!liveContainer) return false
        const liveRow = liveContainer.querySelector<HTMLElement>(
          `.project-editor-tree-item[data-path="${CSS.escape(filePath)}"]`
        )
        if (!liveRow) return false
        const containerRect = liveContainer.getBoundingClientRect()
        const rowRect = liveRow.getBoundingClientRect()
        const targetCenterInContainer = rowRect.top - containerRect.top + rowRect.height / 2
        const delta = targetCenterInContainer - containerRect.height / 2
        const maxScroll = Math.max(0, liveContainer.scrollHeight - liveContainer.clientHeight)
        const targetScrollTop = Math.max(0, Math.min(maxScroll, liveContainer.scrollTop + delta))
        if (scopeKey) fileTreeScrollTopRef.current.set(scopeKey, targetScrollTop)
        // Instant scroll — decisive "jump" semantics like VS Code's Reveal
        // in Explorer. Smooth animation is fragile when setTree shifts the
        // target mid-flight.
        liveContainer.scrollTop = targetScrollTop
        debugLog(`revealFileInBrowser:${label}`, {
          filePath,
          targetScrollTop,
          finalScrollTop: liveContainer.scrollTop,
          rowTop: rowRect.top,
          containerTop: containerRect.top,
          containerHeight: containerRect.height
        })
        return true
      }
      const firstOk = applyReveal('first')
      if (!firstOk) {
        diag.skippedNoRow += 1
        diag.lastReason = 'no-row'
        return
      }
      diag.scrolled += 1
      diag.lastReason = null
      // Re-apply a few frames later so late setTree commits (lazy child
      // loading) that shift the row's offset can't leave the reveal stale.
      // The settle window was set up front, so these retries and their
      // resulting scroll events won't wake the persistent scroll restorer.
      for (const delayMs of [120, 260, 520, 900]) {
        window.setTimeout(() => applyReveal(`retry-${delayMs}`), delayMs)
      }
    },
    [applyExpandedDirectories]
  )

  const handleLocateCurrentFile = useCallback(() => {
    const path = activeFilePathRef.current
    if (!path) return
    void revealFileInBrowser(path, { force: true })
  }, [revealFileInBrowser])

  // When the user returns to Files mode (tree remounts), replay a pending
  // reveal that was deferred while the tree was unmounted under Search mode.
  useEffect(() => {
    if (sidebarMode !== 'files') return
    const pending = pendingRevealPathRef.current
    if (!pending) return
    if (pending !== activeFilePathRef.current) {
      pendingRevealPathRef.current = null
      return
    }
    pendingRevealPathRef.current = null
    requestAnimationFrame(() => {
      void revealFileInBrowser(pending, { force: true })
    })
  }, [sidebarMode, revealFileInBrowser])

  const handleFileTreeScroll = useCallback(() => {
    if (performance.now() >= fileTreeProgrammaticScrollUntilRef.current) {
      fileTreeUserScrollAtRef.current = performance.now()
    }
  }, [])

  useEffect(() => {
    if (!activeFilePath) return
    if (suppressNextRevealRef.current) {
      suppressNextRevealRef.current = false
      return
    }
    void revealFileInBrowser(activeFilePath)
  }, [activeFilePath, revealFileInBrowser])

  const toggleDirectory = useCallback(async (node: TreeNode) => {
    setSelectedPath(node.path)
    if (node.isExpanded) {
      setTree((prev) => updateTree(prev, node.path, (target) => ({
        ...target,
        isExpanded: false
      })))
      return
    }

    setTree((prev) => updateTree(prev, node.path, (target) => ({
      ...target,
      isExpanded: true,
      isLoading: !target.children
    })))

    if (node.children) return

    const root = rootRef.current
    if (!root) return

    const result = await window.electronAPI.project.listDirectory(root, node.path)
    if (!result.success) {
      showStatus('error', result.error || t('projectEditor.error.readDirectory'))
      setTree((prev) => updateTree(prev, node.path, (target) => ({
        ...target,
        isLoading: false
      })))
      return
    }

    setTree((prev) => updateTree(prev, node.path, (target) => ({
      ...target,
      isExpanded: true,
      isLoading: false,
      children: mergeChildren(target.children, buildNodes(result.entries))
    })))
  }, [showStatus, t])

  useEffect(() => {
    if (!isOpen || !rootPath || rootError) return
    if (hasRestoredStateRef.current) return
    if (restoringStateRef.current) return
    if (tree.length === 0) return
    if (window.electronAPI.debug.profile) return
    debugLog('restore:trigger', { rootPath, treeLength: tree.length })

    const terminalStored = restoredStateRef.current
    const stored = resolveStoredProjectEditorState(rootPath, terminalStored, null, window.electronAPI.platform)
    const restoredPinnedFiles = normalizeQuickFilePaths(stored?.pinnedFiles, MAX_PINNED_FILES)
    const restoredRecentFiles = normalizeQuickFilePaths(stored?.recentFiles, MAX_RECENT_FILES)
    setPinnedFiles(restoredPinnedFiles)
    setRecentFiles(restoredRecentFiles)
    if (rootRef.current && (restoredPinnedFiles.length > 0 || restoredRecentFiles.length > 0)) {
      void validateQuickFileEntries(rootRef.current, {
        pinned: restoredPinnedFiles,
        recent: restoredRecentFiles
      })
    }
    if (!stored) {
      // Per-Task independence: a scope with no persisted state must show a
      // clean empty editor — without this, a same-root Task switch leaves the
      // previous Task's file on screen (and a later persist would write it
      // into THIS scope's key).
      const currentScopeKey = getScrollScopeKey(lastEditorScopeRef.current)
      if (
        activeFilePathRef.current &&
        activeFileScopeKeyRef.current !== null &&
        currentScopeKey !== null &&
        activeFileScopeKeyRef.current !== currentScopeKey
      ) {
        perfTraceDiagnostic(PERF_TRACE_EVENT.RENDERER_PROJECT_EDITOR_PERSIST_ACTIVE_FILE_GUARDED, {
          ph: 'i',
          site: 'restore-null'
        })
        resetActiveFileState()
        setSelectedPath(null)
      }
      hasRestoredStateRef.current = true
      restoringStateRef.current = false
      return
    }

    // Restore UI layout state (apply immediately after tree loads)
    if (stored.isPreviewOpen !== undefined) {
      setIsMarkdownPreviewOpen(stored.isPreviewOpen)
      isMarkdownPreviewOpenRef.current = stored.isPreviewOpen
    }
    if (stored.isEditorVisible !== undefined) {
      setIsMarkdownEditorVisible(stored.isEditorVisible)
      isMarkdownEditorVisibleRef.current = stored.isEditorVisible
    }
    if (stored.isOutlineVisible !== undefined) {
      setIsOutlineVisible(stored.isOutlineVisible)
      isOutlineVisibleRef.current = stored.isOutlineVisible
    }
    if (stored.outlineTarget !== undefined) {
      setOutlineTarget(stored.outlineTarget)
      outlineTargetRef.current = stored.outlineTarget
    }
    if (typeof stored.fileTreeWidth === 'number') {
      setFileTreeWidth(stored.fileTreeWidth)
      fileTreeWidthRef.current = stored.fileTreeWidth
    }
    if (typeof stored.previewWidth === 'number') {
      setMarkdownPreviewWidth(stored.previewWidth)
      markdownPreviewWidthRef.current = stored.previewWidth
    }
    if (typeof stored.outlineWidth === 'number') {
      setOutlineWidth(stored.outlineWidth)
      outlineWidthRef.current = stored.outlineWidth
    }
    if (typeof stored.modalWidth === 'number' && typeof stored.modalHeight === 'number') {
      const size = { width: stored.modalWidth, height: stored.modalHeight }
      setModalSize(size)
      modalSizeRef.current = size
    }
    // Write persisted scroll positions into memory refs for later application
    const restoreScope = lastEditorScopeRef.current
    if (stored.previewScrollAnchor && stored.activeFilePath) {
      const pKey = getFileScrollKey(restoreScope, stored.activeFilePath)
      if (pKey) {
        mdpTrace('stored-seed-scroll', {
          storedScrollTop: stored.previewScrollAnchor.scrollTop ?? -1,
          storedSlug: stored.previewScrollAnchor.slug ?? null
        })
        previewScrollMemoryRef.current.set(pKey, {
          scrollRatio: stored.previewScrollAnchor.ratio,
          nearestHeadingSlug: stored.previewScrollAnchor.slug,
          // Carry the persisted absolute scroll values (matching the per-file
          // applyFileMemory path), NOT a hardcoded 0. Zeroing them discarded the
          // saved scrollTop / headingOffsetY, so restorePreviewFromMemory fell to
          // slug-anchor alignment with a 0 offset and dropped the intra-section
          // scroll on the project-editor REOPEN path (PFM-25). The type carries
          // both fields optionally; default to 0 only when actually absent.
          headingOffsetY: stored.previewScrollAnchor.headingOffsetY ?? 0,
          scrollTop: stored.previewScrollAnchor.scrollTop ?? 0
        })
      }
    }
    const restoredOutlineScrollByFile = normalizeOutlineScrollByFile(stored.outlineScrollByFile)
    if (Object.keys(restoredOutlineScrollByFile).length > 0) {
      for (const [filePath, scrollTop] of Object.entries(restoredOutlineScrollByFile)) {
        outlineScrollByFileRef.current.set(filePath, scrollTop)
        const outlineKey = getFileScrollKey(restoreScope, filePath)
        if (outlineKey) {
          outlineScrollTopRef.current.set(outlineKey, scrollTop)
        }
      }
    }
    if (typeof stored.outlineScrollTop === 'number' && stored.activeFilePath) {
      const oKey = getFileScrollKey(restoreScope, stored.activeFilePath)
      if (oKey) outlineScrollTopRef.current.set(oKey, stored.outlineScrollTop)
      outlineScrollByFileRef.current.set(stored.activeFilePath, Math.max(0, stored.outlineScrollTop))
    }
    // Restore file tree scroll position
    if (typeof stored.fileTreeScrollTop === 'number') {
      const tKey = getScrollScopeKey(restoreScope)
      if (tKey) fileTreeScrollTopRef.current.set(tKey, stored.fileTreeScrollTop)
    }

    // Per-file states are already loaded into fileMemoryRef by the scope-change effect.
    // restoreFileMemory() will be called by openFile() when the active file is opened.

    // The recovery process is only triggered once; subsequent operations are directed by the user to prevent asynchronous recovery from preempting clicks.
    hasRestoredStateRef.current = true
    restoringStateRef.current = true

    const apply = async (token: number) => {
      try {
        await applyExpandedDirectories(stored.expandedDirs ?? [], token)
        if (token !== restoreTokenRef.current) return
        queueFileTreeScrollRestore()
        const currentActive = activeFilePathRef.current
        debugLog('restore:apply', {
          storedActive: stored.activeFilePath,
          currentActive,
          expanded: stored.expandedDirs?.length ?? 0,
          storedCursorLine: stored.cursorLine ?? null,
          storedCursorColumn: stored.cursorColumn ?? null
        })
        if (stored.activeFilePath) {
          const hasStoredFileMemory = fileMemoryRef.current.has(stored.activeFilePath)
          if (!hasStoredFileMemory) {
            pendingViewStateRef.current = stored.editorViewState as import('monaco-editor').editor.ICodeEditorViewState | null
            pendingViewStatePathRef.current = stored.activeFilePath
            pendingCursorRef.current = buildPendingCursor(stored.cursorLine, stored.cursorColumn)
            pendingViewStateScopeKeyRef.current = getScrollScopeKey(lastEditorScopeRef.current)
            if (typeof stored.cursorLine === 'number' && stored.cursorLine > 1) {
              pendingViewStateFallbackRef.current = {
                path: stored.activeFilePath,
                line: stored.cursorLine
              }
            } else {
              pendingViewStateFallbackRef.current = null
            }
          }
          if (currentActive !== stored.activeFilePath) {
            await openFile(stored.activeFilePath, 'restore')
            if (token !== restoreTokenRef.current) return
          } else {
            if (hasStoredFileMemory) {
              restoreFileMemory(stored.activeFilePath)
            }
            applyPendingViewState()
          }
          if (projectEditorReopenStartedAtRef.current !== null) {
            finalizeProjectEditorReopenRestore(
              'persisted-state',
              stored.activeFilePath,
              isMarkdownPath(stored.activeFilePath) ? markdownSessionLastRestoreRef.current.mode : null
            )
          }
        }
      } finally {
        if (token === restoreTokenRef.current) {
          restoringStateRef.current = false
        } else if (
          !restoreCancelledByUserRef.current &&
          isOpenRef.current &&
          getScrollScopeKey(lastEditorScopeRef.current) === applyScopeKey
        ) {
          // The restore was cancelled by an interleaved transition (another
          // Task's open/close bumping the token), NOT by this Task's user —
          // and this scope is still the open one. Re-arm the restore effect;
          // the re-run is idempotent (openFile early-returns on same path).
          restoringStateRef.current = false
          hasRestoredStateRef.current = false
          perfTraceDiagnostic(PERF_TRACE_EVENT.RENDERER_PROJECT_EDITOR_RESTORE_RERUN_AFTER_CANCEL, {
            ph: 'i'
          })
        }
      }
    }
    const applyScopeKey = getScrollScopeKey(lastEditorScopeRef.current)
    restoreCancelledByUserRef.current = false
    const token = restoreTokenRef.current + 1
    restoreTokenRef.current = token
    void apply(token)
  }, [
    activeFilePath,
    applyExpandedDirectories,
    applyPendingViewState,
    isOpen,
    openFile,
    queueFileTreeScrollRestore,
    resetActiveFileState,
    restoreFileMemory,
    finalizeProjectEditorReopenRestore,
    rootError,
    rootPath,
    tree.length,
    validateQuickFileEntries
  ])

  useEffect(() => {
    if (!pendingViewStateRef.current && !pendingCursorRef.current) return
    if (!activeFilePath || activeFilePath !== pendingViewStatePathRef.current) return
    if (isBinary || isImage || isSqlite) {
      pendingViewStateRef.current = null
      pendingViewStatePathRef.current = null
      pendingCursorRef.current = null
      return
    }
    applyPendingViewState()
  }, [activeFilePath, applyPendingViewState, fileContent, isBinary, isImage, isSqlite])

  useEffect(() => {
    if (!DEBUG_PROJECT_EDITOR) return
    if (window.electronAPI.debug.profile) return
    if (window.electronAPI.debug.autotest) return
    if (!isOpen || !rootPath || rootError) return
    if (debugAutoOpenRef.current) return
    if (tree.length === 0) return
    debugAutoOpenRef.current = true
    const run = async () => {
      const targetCount = 5
      let files = collectFirstFilePaths(tree, 20)
      let markdownFiles = files.filter((path) => isMarkdownPath(path))
      if (markdownFiles.length < targetCount) {
        const indexed = await buildFileIndex()
        markdownFiles = indexed.filter((path) => isMarkdownPath(path))
        files = indexed
      }
      const targetFiles = (markdownFiles.length >= targetCount ? markdownFiles : files).slice(0, targetCount)
      debugLog('debug:autoOpen', { targetFiles, markdownCount: markdownFiles.length })
      targetFiles.forEach((file, index) => {
        const delay = index * 150
        window.setTimeout(() => {
          debugLog('debug:autoOpen:open', { file, delay })
          void openFile(file, 'debug')
        }, delay)
      })
    }
    void run()
  }, [buildFileIndex, isOpen, openFile, rootError, rootPath, tree])

  const handleSearchSelect = useCallback(async (path: string) => {
    handleCloseSearch()
    await openFile(path, 'user', { trackRecent: true })
  }, [handleCloseSearch, openFile])

  const handleSearchNavigate = useCallback(async (
    file: string,
    line: number,
    column: number,
    matchLength: number
  ) => {
    // Pass cursorPosition through openFile to avoid race with saved editor state
    await openFile(file, 'user', {
      trackRecent: true,
      cursorPosition: { lineNumber: line, column }
    })
    // Wait for the editor model to be ready before applying highlight decoration
    if (activeFilePathRef.current === file) {
      await waitForEditorModelReady(file)
    }
    requestAnimationFrame(() => {
      const editor = editorRef.current
      if (!editor) return
      editor.revealLineInCenter(line)
      editor.focus()
      if (matchLength > 0 && monacoRef.current) {
        try {
          const deco = editor.createDecorationsCollection([{
            range: new monacoRef.current.Range(line, column, line, column + matchLength),
            options: {
              className: 'global-search-editor-highlight',
              isWholeLine: false
            }
          }])
          setTimeout(() => deco.clear(), 2000)
        } catch {
          // Decoration is nice-to-have, not critical
        }
      }
    })
  }, [openFile, waitForEditorModelReady])

  const handleSearchKeyDown = useCallback((event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      setSearchActiveIndex((prev) => Math.min(prev + 1, Math.max(searchResults.length - 1, 0)))
      return
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault()
      setSearchActiveIndex((prev) => Math.max(prev - 1, 0))
      return
    }
    if (event.key === 'Enter') {
      event.preventDefault()
      const target = searchResults[searchActiveIndex]
      if (target) {
        void handleSearchSelect(target)
      }
      return
    }
    if (event.key === 'Escape') {
      event.preventDefault()
      handleCloseSearch()
    }
  }, [handleCloseSearch, handleSearchSelect, searchActiveIndex, searchResults])

  const syncEditorToPreviewScroll = useCallback(() => {
    if (!previewVisibleRef.current) return false
    const editor = editorRef.current
    const preview = previewRef.current
    if (!editor || !preview) return false
    if (preview.clientHeight <= 0 || preview.scrollHeight <= 0) return false

    try {
      editor.layout()
    } catch {
      return false
    }

    const layoutInfo = editor.getLayoutInfo()
    if (layoutInfo.height <= 0 || layoutInfo.width <= 0) return false

    const key = getFileScrollKey(lastEditorScopeRef.current, activeFilePathRef.current)
    const memorySlug = key ? previewScrollMemoryRef.current.get(key)?.nearestHeadingSlug ?? null : null
    const syncSlug = previewActiveSlugRef.current ?? memorySlug ?? scanPreviewNearestSlug()
    const outlineTarget = syncSlug
      ? findMarkdownOutlineItemBySlug(outlineSymbolsRef.current, syncSlug)
      : null
    if (syncSlug && !outlineTarget && outlineSymbolsRef.current.length === 0) {
      return false
    }

    suppressProgrammaticEditorPreviewSyncRef.current = true
    if (editorPreviewSyncSuppressTimerRef.current !== null) {
      window.clearTimeout(editorPreviewSyncSuppressTimerRef.current)
    }
    editorPreviewSyncSuppressTimerRef.current = window.setTimeout(() => {
      editorPreviewSyncSuppressTimerRef.current = null
      suppressProgrammaticEditorPreviewSyncRef.current = false
    }, PROGRAMMATIC_EDITOR_PREVIEW_SYNC_SUPPRESS_MS)
    suppressNextEditorScrollRef.current = true
    if (outlineTarget) {
      editor.setScrollTop(editor.getTopForLineNumber(outlineTarget.startLine))
      updatePreviewActiveSlug(syncSlug)
      scheduleProjectStateSave()
      return true
    }

    const previewMaxScroll = Math.max(1, preview.scrollHeight - preview.clientHeight)
    const ratio = preview.scrollTop / previewMaxScroll
    const editorScrollHeight = editor.getScrollHeight()
    const maxEditorScroll = Math.max(1, editorScrollHeight - layoutInfo.height)
    editor.setScrollTop(ratio * maxEditorScroll)
    updatePreviewActiveSlug(syncSlug)
    scheduleProjectStateSave()
    return true
  }, [scanPreviewNearestSlug, scheduleProjectStateSave, updatePreviewActiveSlug])

  useEffect(() => {
    syncEditorToPreviewScrollRef.current = syncEditorToPreviewScroll
  }, [syncEditorToPreviewScroll])

  const syncPreviewScroll = useCallback(() => {
    if (!previewVisibleRef.current) return
    const editor = editorRef.current
    const preview = previewRef.current
    if (!editor || !preview) return
    const editorScrollTop = editor.getScrollTop()
    const editorScrollHeight = editor.getScrollHeight()
    const editorHeight = editor.getLayoutInfo().height
    const maxEditorScroll = Math.max(1, editorScrollHeight - editorHeight)
    const ratio = editorScrollTop / maxEditorScroll
    const previewMaxScroll = Math.max(1, preview.scrollHeight - preview.clientHeight)
    suppressNextPreviewScrollRef.current = true
    preview.scrollTop = ratio * previewMaxScroll
    updatePreviewActiveSlug(scanPreviewNearestSlug())
  }, [scanPreviewNearestSlug, updatePreviewActiveSlug])

  const schedulePreviewSync = useCallback(() => {
    if (DEBUG_PROJECT_EDITOR) {
      perfCountersRef.current.previewSync += 1
    }
    if (scrollRafRef.current) {
      window.cancelAnimationFrame(scrollRafRef.current)
    }
    scrollRafRef.current = window.requestAnimationFrame(() => {
      scrollRafRef.current = null
      if (
        suppressProgrammaticEditorPreviewSyncRef.current ||
        suppressPreviewSyncOnRestoreRef.current ||
        previewRestorePhaseRef.current !== 'idle'
      ) {
        return
      }
      syncPreviewScroll()
    })
  }, [syncPreviewScroll])

  const capturePreviewScrollMemory = useCallback(() => {
    const preview = previewRef.current
    if (!preview) return
    if (!previewVisibleRef.current) return
    if (previewRestorePhaseRef.current !== 'idle') return
    if (!markdownRenderedHtmlRef.current) return
    mdpTrace('capture-preview-scroll', {
      writeScrollTop: preview.scrollTop,
      editorVisible: isMarkdownEditorVisibleRef.current,
      editorScrollTop: editorRef.current ? editorRef.current.getScrollTop() : -1
    })

    const key = getFileScrollKey(lastEditorScopeRef.current, activeFilePathRef.current)
    if (!key) return

    // Guard against the editor->preview sync clobbering a good captured scroll
    // position with a TRANSIENT 0. When the editor pane is visible it drives the
    // preview scroll (syncEditorToPreviewScroll); during an editor re-layout /
    // close the editor can momentarily report scrollTop 0 and sync the preview to
    // the top even though the user's reading position is deeper. Capturing that
    // transient 0 persists it as the saved scroll, so the next reopen restores to
    // the top (the PMSR-10/11 cascade: 0 saved -> 0 seeded -> restore to 0). Skip
    // the capture when the preview reads 0 but the editor is NOT at the top and a
    // good non-zero position was already captured — that 0 is an inconsistent sync
    // artifact, not a real user scroll-to-top.
    if (isMarkdownEditorVisibleRef.current && preview.scrollTop === 0) {
      const editor = editorRef.current
      const editorScrollTop = editor ? editor.getScrollTop() : 0
      const prior = previewScrollMemoryRef.current.get(key)
      if (editorScrollTop > 1 && prior && prior.scrollTop > 0) {
        mdpTrace('capture-preview-scroll:skip-transient-zero', {
          priorScrollTop: prior.scrollTop,
          editorScrollTop
        })
        return
      }
    }

    const nearestSlug = scanPreviewNearestSlug()
    updatePreviewActiveSlug(nearestSlug)

    const maxScroll = Math.max(1, preview.scrollHeight - preview.clientHeight)
    let headingOffsetY = 0
    if (nearestSlug) {
      try {
        const heading = preview.querySelector(`#${CSS.escape(nearestSlug)}`) as HTMLElement | null
        if (heading) {
          headingOffsetY = heading.getBoundingClientRect().top - preview.getBoundingClientRect().top
        }
      } catch {
        // Ignore invalid CSS escapes from malformed heading ids.
      }
    }

    previewScrollMemoryRef.current.set(key, {
      scrollRatio: preview.scrollTop / maxScroll,
      nearestHeadingSlug: nearestSlug,
      headingOffsetY,
      scrollTop: preview.scrollTop
    })
  }, [scanPreviewNearestSlug, updatePreviewActiveSlug])

  useEffect(() => {
    capturePreviewScrollMemoryRef.current = capturePreviewScrollMemory
  }, [capturePreviewScrollMemory])

  const captureMarkdownSessionCache = useCallback((reason: string) => {
    const root = rootRef.current
    const filePath = activeFilePathRef.current
    if (!root || !filePath || !isMarkdownPath(filePath)) return
    if (!isMarkdownPreviewOpenRef.current || !previewVisibleRef.current) {
      recordMarkdownSessionCacheDwell(root, filePath)
      return
    }
    if (previewRestorePhaseRef.current !== 'idle') return
    const preview = previewRef.current
    if (!preview) return
    const startedAt = performance.now()
    const contentElement = preview.querySelector('.project-editor-preview-content') as HTMLElement | null
    const renderedHtml = markdownRenderedHtmlRef.current || contentElement?.innerHTML || ''
    const renderedHtmlSource = markdownRenderedHtmlRef.current ? 'state' : 'dom'
    if (!renderedHtml) return

    capturePreviewScrollMemoryRef.current()
    const key = getMarkdownSessionCacheKey(root, filePath)
    if (!key) return

    const pKey = getFileScrollKey(lastEditorScopeRef.current, filePath)
    const previewMemory = pKey ? previewScrollMemoryRef.current.get(pKey) : undefined
    const oKey = getFileScrollKey(lastEditorScopeRef.current, filePath)
    const outlineScrollTop = oKey ? outlineScrollTopRef.current.get(oKey) : undefined
    const fileMemory = fileMemoryRef.current.get(filePath)
    const entry = upsertMarkdownSessionCache({
      key,
      rootPath: normalizePath(root),
      filePath: normalizePath(filePath),
      content: fileContentRef.current,
      renderedHtml,
      imagePaths: [...markdownImagePaths],
      imageMap: { ...markdownImageMapRef.current },
      previewScrollMemory: previewMemory ? { ...previewMemory } : undefined,
      fileMemory: fileMemory ? { ...fileMemory } : undefined,
      outlineScrollTop,
      isPreviewOpen: isMarkdownPreviewOpenRef.current,
      isEditorVisible: isMarkdownEditorVisibleRef.current,
      outlineTarget: outlineTargetRef.current
    })
    // Mirror the just-captured cache into the in-memory render ref so a later
    // ESC-then-shortcut reopen recognises the retained markdownRenderedHtml as
    // a fresh cache hit and skips the owner-switch DOM-clear / applyCacheHit
    // path that would otherwise drive `previewRestorePhase` through
    // 'waiting-html' / 'restoring-layout' and momentarily fade
    // `.project-editor-preview-content` to opacity 0 (the user-visible
    // "screen refreshes again" effect).
    markdownSessionCacheRenderRef.current = {
      key,
      filePath: normalizePath(filePath),
      content: fileContentRef.current
    }
    if (DEBUG_PROJECT_EDITOR) {
      debugLog('markdown-cache:capture', {
        reason,
        filePath,
        htmlLength: renderedHtml.length,
        size: markdownSessionCacheStore.size,
        openCount: entry.openCount,
        dwellMs: Math.round(entry.dwellMs)
      })
    }
    const durationMs = +(performance.now() - startedAt).toFixed(1)
    perfTrace(PERF_TRACE_EVENT.RENDERER_MARKDOWN_SESSION_CACHE_CAPTURE, {
      reason,
      durationMs,
      htmlLength: renderedHtml.length,
      source: renderedHtmlSource
    })
  }, [capturePreviewScrollMemory, markdownImagePaths])

  useEffect(() => {
    captureMarkdownSessionCacheRef.current = captureMarkdownSessionCache
  }, [captureMarkdownSessionCache])

  const restorePreviewFromMemory = useCallback((): boolean => {
    const preview = previewRef.current
    if (!preview) return false
    const key = getFileScrollKey(lastEditorScopeRef.current, activeFilePathRef.current)
    if (!key) return false
    const memory = previewScrollMemoryRef.current.get(key)
    mdpTrace('restore-preview-from-memory', {
      hasMemory: Boolean(memory),
      memScrollTop: memory?.scrollTop ?? -1,
      memSlug: memory?.nearestHeadingSlug ?? null,
      scrollHeight: preview.scrollHeight,
      clientHeight: preview.clientHeight
    })
    if (!memory) return false

    const getRestoredSlug = () => {
      if (memory.nearestHeadingSlug) {
        try {
          if (preview.querySelector(`#${CSS.escape(memory.nearestHeadingSlug)}`)) {
            return memory.nearestHeadingSlug
          }
        } catch {
          return scanPreviewNearestSlug()
        }
      }
      return scanPreviewNearestSlug()
    }

    const maxScroll = Math.max(1, preview.scrollHeight - preview.clientHeight)
    if (memory.scrollTop > 0) {
      suppressNextPreviewScrollRef.current = true
      preview.scrollTop = Math.max(0, Math.min(maxScroll, memory.scrollTop))
      updatePreviewActiveSlug(getRestoredSlug())
      return true
    }

    if (memory.nearestHeadingSlug) {
      try {
        const anchor = preview.querySelector(`#${CSS.escape(memory.nearestHeadingSlug)}`) as HTMLElement | null
        if (anchor) {
          const containerRect = preview.getBoundingClientRect()
          const anchorRect = anchor.getBoundingClientRect()
          suppressNextPreviewScrollRef.current = true
          preview.scrollTop = anchorRect.top - containerRect.top + preview.scrollTop - memory.headingOffsetY
          updatePreviewActiveSlug(memory.nearestHeadingSlug)
          return true
        }
      } catch {
        // Fall back to ratio-based restore.
      }
    }

    suppressNextPreviewScrollRef.current = true
    preview.scrollTop = memory.scrollRatio * maxScroll
    updatePreviewActiveSlug(getRestoredSlug())
    return true
  }, [scanPreviewNearestSlug, updatePreviewActiveSlug])

  useEffect(() => {
    restorePreviewFromMemoryRef.current = restorePreviewFromMemory
  }, [restorePreviewFromMemory])

  useLayoutEffect(() => {
    const pending = pendingMarkdownSessionCacheRestoreRef.current
    if (!pending) return
    if (!isMarkdownRenderAllowed || !markdownRenderedHtml) return
    if (activeFilePathRef.current !== pending.filePath) {
      pendingMarkdownSessionCacheRestoreRef.current = null
      return
    }

    const restored = restorePreviewFromMemory()
    if (isMarkdownEditorVisibleRef.current) {
      if (!syncEditorToPreviewScrollRef.current()) {
        scheduleEditorSyncFromPreview()
      }
    }
    pendingMarkdownSessionCacheRestoreRef.current = null
    if (!restored) {
      updatePreviewActiveSlug(scanPreviewNearestSlug())
    }
  }, [
    activeFilePath,
    isMarkdownRenderAllowed,
    markdownRenderedHtml,
    // Re-apply the pending session-cache scroll restore on a content-identical
    // cache reapply (retained-close -> reopen). applyMarkdownSessionCacheHit
    // re-arms pendingMarkdownSessionCacheRestoreRef on every call, but without
    // this nonce the layout effect would not re-fire when the HTML string is
    // unchanged, leaving the preview scrolled to top (PMSR-10). See nonce decl.
    markdownPreviewRenderNonce,
    restorePreviewFromMemory,
    scanPreviewNearestSlug,
    scheduleEditorSyncFromPreview,
    updatePreviewActiveSlug
  ])

  useEffect(() => {
    if (!isMarkdownRenderAllowed || !markdownRenderedHtml) return
    if (previewRestorePhase !== 'idle') return
    const mermaidState = getMermaidPreviewState()
    if (mermaidState.pending > 0 || mermaidState.inFlight) return
    captureMarkdownSessionCacheRef.current('render-settled')
  }, [getMermaidPreviewState, isMarkdownRenderAllowed, markdownRenderedHtml, previewRestorePhase])

  const handlePreviewScroll = useCallback(() => {
    if (!previewVisibleRef.current) return
    if (suppressNextPreviewScrollRef.current) {
      suppressNextPreviewScrollRef.current = false
      updatePreviewActiveSlug(scanPreviewNearestSlug())
      return
    }
    if (DEBUG_PROJECT_EDITOR) {
      perfCountersRef.current.previewScroll += 1
    }
    const editor = editorRef.current
    const preview = previewRef.current
    if (!editor || !preview) return
    const previewMaxScroll = Math.max(1, preview.scrollHeight - preview.clientHeight)
    const ratio = preview.scrollTop / previewMaxScroll
    const editorScrollHeight = editor.getScrollHeight()
    const editorHeight = editor.getLayoutInfo().height
    const maxEditorScroll = Math.max(1, editorScrollHeight - editorHeight)
    suppressNextEditorScrollRef.current = true
    editor.setScrollTop(ratio * maxEditorScroll)
    updatePreviewActiveSlug(scanPreviewNearestSlug())
  }, [scanPreviewNearestSlug, updatePreviewActiveSlug])

  const handleEditorChange = useCallback((value?: string) => {
    if (value === undefined) return
	    if (DEBUG_PROJECT_EDITOR) {
	      perfCountersRef.current.editorChange += 1
	    }
	    fileContentRef.current = value
	    if (activeFilePathRef.current && isMarkdownPath(activeFilePathRef.current)) {
	      markMarkdownSessionCacheStale(rootRef.current, activeFilePathRef.current)
	    }
	    scheduleMarkdownRender()
    const model = editorRef.current?.getModel()
    if (model && originalModelVersionRef.current !== null) {
      const nextDirty = model.getAlternativeVersionId() !== originalModelVersionRef.current
      if (nextDirty !== dirtyRef.current) {
        setIsDirty(nextDirty)
      }
      return
    }
    if (!dirtyRef.current && value !== originalContentRef.current) {
      setIsDirty(true)
    }
  }, [scheduleMarkdownRender])

  useLayoutEffect(() => {
    if (!isMarkdownRenderAllowed) return
    if (!markdownRenderedHtml) return

    const phase = previewRestorePhaseRef.current
    const isRestoreCycle =
      suppressPreviewSyncOnRestoreRef.current ||
      (phase !== 'idle' && phase !== 'revealing')
    if (isRestoreCycle) {
      mdpTrace('layoutEffect:restoreCycle', { fromPhase: phase })
      if (previewRestorePhaseRef.current !== 'restoring-layout') {
        previewRestorePhaseRef.current = 'restoring-layout'
        setPreviewRestorePhase('restoring-layout')
        mdpTrace('phase:restoring-layout', { from: 'layoutEffect' })
      }
      const restored = restorePreviewFromMemory()
      if (!restored) {
        syncPreviewScroll()
      }
      const mermaidState = getMermaidPreviewState()
      const hasMoreRenderWork =
        markdownRenderPending ||
        markdownWorkerInFlightRef.current ||
        markdownWorkerQueuedRef.current ||
        mermaidState.pending > 0 ||
        mermaidState.inFlight
      suppressPreviewSyncOnRestoreRef.current = hasMoreRenderWork
      mdpTrace('layoutEffect:hasMoreWork', {
        hasMoreRenderWork,
        markdownRenderPending,
        workerInFlight: markdownWorkerInFlightRef.current,
        workerQueued: markdownWorkerQueuedRef.current,
        mermaidPending: mermaidState.pending,
        mermaidInFlight: mermaidState.inFlight
      })
      if (!hasMoreRenderWork) {
        queuePreviewReveal()
      }
      return
    }

    schedulePreviewSync()
  }, [
    isMarkdownRenderAllowed,
    markdownRenderedHtml,
    // Re-run on a content-identical cache reapply (retained-close -> reopen) so
    // the restore phase advances out of 'waiting-html' even when the HTML string
    // did not change. See markdownPreviewRenderNonce declaration.
    markdownPreviewRenderNonce,
    markdownRenderPending,
    getMermaidPreviewState,
    queuePreviewReveal,
    restorePreviewFromMemory,
    schedulePreviewSync,
    syncPreviewScroll
  ])

  useEffect(() => {
    const mermaidState = getMermaidPreviewState()
    if (!shouldRevealSettledPreview({
      isMarkdownRenderAllowed,
      renderedHtmlLength: markdownRenderedHtml.length,
      phase: previewRestorePhase,
      markdownRenderPending,
      workerInFlight: markdownWorkerInFlightRef.current,
      workerQueued: markdownWorkerQueuedRef.current,
      mermaidPending: mermaidState.pending,
      mermaidInFlight: mermaidRenderInFlightRef.current
    })) {
      return
    }
    queuePreviewReveal()
  }, [
    getMermaidPreviewState,
    isMarkdownRenderAllowed,
    markdownRenderedHtml,
    // Re-evaluate reveal on an identical-HTML cache reapply (see nonce decl).
    markdownPreviewRenderNonce,
    markdownRenderPending,
    previewRestorePhase,
    queuePreviewReveal
  ])

  // Watchdog: the preview-restore phase must never stay stuck NON-idle (content
  // faded to opacity 0) once the render is fully settled. The happy-path reveal
  // finalizes the phase to 'idle' in a few ms, so this watchdog does nothing then.
  // It fires only when the queued reveal was lost — a deep-link "Jump to Editor"
  // (and similar reopen-with-root-reload) cancels the reveal frame via the unmount
  // cleanup AFTER it was queued, and no React dep changes to re-run the
  // settled-reveal effect above — leaving the preview rendered in HTML but
  // invisible (CDP-10 deep-link jump; PMSR-09/10/11 cold first reopen, where
  // waitForPreviewReady requires phase === 'idle'). The dep is the BOOLEAN
  // "is non-idle", NOT the phase string, so a `waiting-html` -> `restoring-layout`
  // transition does NOT re-run the effect and reset the timer; the interval keeps
  // measuring continuous non-idle time across those sub-phase changes. Gated on
  // shouldRevealSettledPreview so it can never reveal mid-render (it waits while
  // ANY work — markdown render, worker, or mermaid — is pending), preserving the
  // no-flash guarantees.
  const previewPhaseNonIdle = previewRestorePhase !== 'idle'
  useEffect(() => {
    if (!previewPhaseNonIdle) return
    const nonIdleSince = performance.now()
    const watchdog = window.setInterval(() => {
      if (previewRestorePhaseRef.current === 'idle') {
        window.clearInterval(watchdog)
        return
      }
      if (performance.now() - nonIdleSince < PREVIEW_REVEAL_WATCHDOG_MS) return
      const mermaidState = getMermaidPreviewStateRef.current()
      const settled = shouldRevealSettledPreview({
        isMarkdownRenderAllowed: markdownRenderAllowedRef.current,
        renderedHtmlLength: markdownRenderedHtmlRef.current.length,
        phase: previewRestorePhaseRef.current,
        markdownRenderPending: markdownRenderPendingRef.current,
        workerInFlight: markdownWorkerInFlightRef.current,
        workerQueued: markdownWorkerQueuedRef.current,
        mermaidPending: mermaidState.pending,
        mermaidInFlight: mermaidRenderInFlightRef.current
      })
      // Diagnostic breadcrumb: the watchdog tripped (phase stuck non-idle past the
      // grace). `settled` tells whether it could force the reveal or is still
      // (legitimately or stuck) waiting on render/mermaid work.
      mdpTrace('reveal-watchdog:tick', {
        phase: previewRestorePhaseRef.current,
        settled,
        renderAllowed: markdownRenderAllowedRef.current,
        htmlRefLen: markdownRenderedHtmlRef.current.length,
        markdownRenderPending: markdownRenderPendingRef.current,
        workerInFlight: markdownWorkerInFlightRef.current,
        workerQueued: markdownWorkerQueuedRef.current,
        mermaidPending: mermaidState.pending,
        mermaidInFlight: mermaidRenderInFlightRef.current
      })
      if (!settled) return
      // Settled but stranded: the queued reveal was lost. Finalize directly
      // (restore scroll + flip phase to 'idle') instead of re-queuing through the
      // cancellable setTimeout chain, so this cannot be lost a second time.
      window.clearInterval(watchdog)
      perfTrace(PERF_TRACE_EVENT.RENDERER_PROJECT_EDITOR_MD_REVEAL_WATCHDOG_FORCED, {
        filePath: (activeFilePathRef.current ?? '').split(/[\\/]/).pop() ?? '',
        htmlLength: markdownRenderedHtmlRef.current.length,
        waitedMs: +(performance.now() - nonIdleSince).toFixed(1)
      })
      restorePreviewFromMemoryRef.current()
      suppressPreviewSyncOnRestoreRef.current = false
      flushSync(() => {
        previewRestorePhaseRef.current = 'idle'
        setPreviewRestorePhase('idle')
      })
      // Mirror finalize(): if a reopen deferred the editor->preview alignment,
      // run it now that the preview settled and phase is 'idle'.
      if (pendingEditorSyncFromPreviewRef.current) {
        pendingEditorSyncFromPreviewRef.current = false
        scheduleEditorSyncFromPreview()
      }
    }, 300)
    return () => window.clearInterval(watchdog)
  }, [previewPhaseNonIdle, scheduleEditorSyncFromPreview])

  useEffect(() => {
    if (!isMarkdownRenderAllowed) return
    const frame = window.requestAnimationFrame(() => {
      updatePreviewActiveSlug(scanPreviewNearestSlug())
    })
    return () => window.cancelAnimationFrame(frame)
  }, [isMarkdownRenderAllowed, markdownRenderedHtml, scanPreviewNearestSlug, updatePreviewActiveSlug])

  useEffect(() => {
    if (!isMarkdownRenderAllowed || !markdownRenderedHtml) return
    const preview = previewRef.current
    if (!preview) return
    const initialMermaidState = getMermaidPreviewState()
    // Skip only when there is nothing at all to act on. A pending count of 0
    // does not necessarily mean idle — when the markdown session cache
    // restores a previously-enhanced HTML snapshot, every diagram already
    // carries `.mermaid-rendered` (so pending===0) but the runtime panzoom
    // instances were destroyed with the old DOM and need to be rebuilt.
    if (initialMermaidState.total === 0) return
    mdpTrace('mermaid:start', {
      total: initialMermaidState.total,
      pending: initialMermaidState.pending,
      inFlight: initialMermaidState.inFlight
    })
    const signal = { cancelled: false }
    const token = mermaidRenderTokenRef.current + 1
    mermaidRenderTokenRef.current = token
    mermaidRenderInFlightRef.current = true
    const wasRestoring =
      suppressPreviewSyncOnRestoreRef.current ||
      previewRestorePhaseRef.current !== 'idle'

    void renderMermaidDiagrams(preview, signal, t('mermaid.syntaxError')).finally(() => {
      if (token !== mermaidRenderTokenRef.current) return
      mermaidRenderInFlightRef.current = false
      if (signal.cancelled) return
      mdpTrace('mermaid:complete', { wasRestoring })

      enhanceMermaidDiagrams(preview, signal, {
        zoomIn: t('mermaid.zoomIn'),
        zoomOut: t('mermaid.zoomOut'),
        resetZoom: t('mermaid.resetZoom'),
        fitToScreen: t('mermaid.fitToScreen'),
        fullscreen: t('mermaid.fullscreen'),
        exitFullscreen: t('mermaid.exitFullscreen'),
        dragHint: t('mermaid.dragHint')
      })

      updatePreviewActiveSlug(scanPreviewNearestSlug())

	      if (
	        wasRestoring ||
	        suppressPreviewSyncOnRestoreRef.current ||
        previewRestorePhaseRef.current !== 'idle'
      ) {
        if (previewRestorePhaseRef.current !== 'restoring-layout') {
          previewRestorePhaseRef.current = 'restoring-layout'
          setPreviewRestorePhase('restoring-layout')
        }
	        queuePreviewReveal()
	      } else {
	        window.requestAnimationFrame(() => {
	          captureMarkdownSessionCacheRef.current('mermaid-settled')
	        })
	      }
	    })
    return () => {
      signal.cancelled = true
      if (token === mermaidRenderTokenRef.current) {
        mermaidRenderInFlightRef.current = false
      }
    }
  }, [
    getMermaidPreviewState,
    isMarkdownRenderAllowed,
    markdownRenderedHtml,
    // Re-render mermaid on a content-identical cache reapply. The cached HTML is
    // the pre-mermaid render (diagrams carry only `.mermaid-diagram`), so on a
    // retained-close -> reopen the DOM is rebuilt without `.mermaid-rendered`
    // and pending stays > 0; this nonce forces the runtime mermaid render to
    // re-run even though `markdownRenderedHtml` did not change. See nonce decl.
    markdownPreviewRenderNonce,
    queuePreviewReveal,
    scanPreviewNearestSlug,
    t,
    updatePreviewActiveSlug
  ])

  useEffect(() => {
    const preview = previewRef.current
    return () => {
      if (preview) disposeMermaidPanZoom(preview)
    }
  }, [])

  useEffect(() => {
    if (!isMarkdownRenderAllowed) return
    const preview = previewRef.current
    if (!preview) return
    const handleScroll = () => {
      handlePreviewScroll()
      if (!suppressPreviewSyncOnRestoreRef.current) {
        capturePreviewScrollMemory()
      }
    }
    preview.addEventListener('scroll', handleScroll)
    return () => {
      preview.removeEventListener('scroll', handleScroll)
    }
  }, [capturePreviewScrollMemory, handlePreviewScroll, isMarkdownRenderAllowed])

  // File tree scroll position capture
  useEffect(() => {
    const treeEl = fileTreeContainerRef.current
    if (!treeEl || !isOpen) return
    const handler = () => {
      // Skip during programmatic reveals so intermediate smooth-scroll
      // frames don't overwrite the reveal's committed target, which would
      // then cause queueFileTreeScrollRestore to pull the tree back to a
      // stale mid-animation position.
      if (performance.now() < fileTreeProgrammaticScrollUntilRef.current) return
      const key = getScrollScopeKey(lastEditorScopeRef.current)
      if (key) fileTreeScrollTopRef.current.set(key, treeEl.scrollTop)
      scheduleProjectStateSave()
    }
    treeEl.addEventListener('scroll', handler, { passive: true })
    return () => treeEl.removeEventListener('scroll', handler)
  }, [isOpen, scheduleProjectStateSave, tree])

  useEffect(() => {
    if (!isOpen || sidebarMode !== 'files') return
    // While a revealFileInBrowser pass is still in its settle window,
    // queueFileTreeScrollRestore must not run — it would fight the reveal
    // and snap the tree back to the pre-reveal saved scrollTop.
    if (performance.now() < fileTreeProgrammaticScrollUntilRef.current) return
    queueFileTreeScrollRestore()
  }, [isOpen, queueFileTreeScrollRestore, sidebarMode, tree])

  // Outline scroll position capture callback
  const handleOutlineScrollCapture = useCallback((scrollTop: number) => {
    const key = getFileScrollKey(lastEditorScopeRef.current, activeFilePathRef.current)
    const previousScrollTop = key ? outlineScrollTopRef.current.get(key) : undefined
    const pendingRestore = pendingOutlineDomRestoreRef.current
    if (!shouldCaptureOutlineScrollTop({
      captureKey: key,
      pendingRestoreKey: pendingRestore?.key ?? null,
      previousScrollTop,
      nextScrollTop: scrollTop
    })) {
      return
    }
    if (key) outlineScrollTopRef.current.set(key, scrollTop)
    const activePath = activeFilePathRef.current
    if (activePath) outlineScrollByFileRef.current.set(activePath, Math.max(0, scrollTop))
    if (key && pendingRestore?.key === key && scrollTop > 0) {
      pendingOutlineDomRestoreRef.current = null
    }
    scheduleProjectStateSave()
  }, [scheduleProjectStateSave])

  const getOutlineScrollContainer = useCallback(() => {
    const root = modalRef.current
    return (root?.querySelector('.outline-panel-tree') ?? null) as HTMLDivElement | null
  }, [])

  const scrollFileBrowserToFraction = useCallback((fraction: number) => {
    const treeEl = fileTreeContainerRef.current
    if (!treeEl) return false
    const clampedFraction = Math.max(0, Math.min(1, fraction))
    const maxScroll = Math.max(0, treeEl.scrollHeight - treeEl.clientHeight)
    treeEl.scrollTop = clampedFraction * maxScroll
    const key = getScrollScopeKey(lastEditorScopeRef.current)
    if (key) fileTreeScrollTopRef.current.set(key, treeEl.scrollTop)
    scheduleProjectStateSave()
    return true
  }, [scheduleProjectStateSave])

  const scrollOutlineToFraction = useCallback((fraction: number) => {
    const treeEl = getOutlineScrollContainer()
    if (!treeEl) return false
    const clampedFraction = Math.max(0, Math.min(1, fraction))
    const maxScroll = Math.max(0, treeEl.scrollHeight - treeEl.clientHeight)
    treeEl.scrollTop = clampedFraction * maxScroll
    handleOutlineScrollCapture(treeEl.scrollTop)
    return true
  }, [getOutlineScrollContainer, handleOutlineScrollCapture])

  useEffect(() => {
    if (!isOpen || !outlineShowInSplit || !activeFilePath) {
      lastOutlineDomRestoreSignatureRef.current = null
      return
    }

    const key = getFileScrollKey(lastEditorScopeRef.current, activeFilePath)
    if (!key) return
    const savedScrollTop = key ? outlineScrollTopRef.current.get(key) : undefined
    if (typeof savedScrollTop !== 'number' || savedScrollTop <= 0) return
    if (outlineSymbols.length === 0) return

    const signature = `${activeFilePath}:${Math.round(savedScrollTop)}:${outlineSymbols.length}:${outlineShowInSplit}`
    if (lastOutlineDomRestoreSignatureRef.current === signature) return

    const targetScrollTop = Math.max(0, savedScrollTop)
    pendingOutlineDomRestoreRef.current = { key, targetScrollTop, signature }
    let resizeObserver: ResizeObserver | null = null
    let mountMutationObserver: MutationObserver | null = null
    let treeMutationObserver: MutationObserver | null = null
    let mountFrameId = 0
    let retryFrameId = 0

    const disconnectTreeObservers = () => {
      resizeObserver?.disconnect()
      resizeObserver = null
      treeMutationObserver?.disconnect()
      treeMutationObserver = null
      if (retryFrameId) {
        window.cancelAnimationFrame(retryFrameId)
        retryFrameId = 0
      }
    }

    const tryApply = (tree: HTMLElement): boolean => {
      const maxScrollTop = Math.max(0, tree.scrollHeight - tree.clientHeight)
      if (targetScrollTop > 0 && maxScrollTop <= 0) {
        // Tree exists but its children have not laid out yet; signal
        // "not applied" so the caller keeps observing.
        return false
      }
      const clampedTarget = Math.min(targetScrollTop, maxScrollTop)
      tree.scrollTop = clampedTarget
      handleOutlineScrollCapture(tree.scrollTop)
      const isApplied = Math.abs(tree.scrollTop - clampedTarget) <= 2
      if (isApplied) {
        lastOutlineDomRestoreSignatureRef.current = signature
        if (pendingOutlineDomRestoreRef.current?.key === key) {
          pendingOutlineDomRestoreRef.current = null
        }
      }
      return isApplied
    }

    const scheduleRetry = (tree: HTMLElement) => {
      if (retryFrameId) return
      retryFrameId = window.requestAnimationFrame(() => {
        retryFrameId = 0
        if (tryApply(tree)) {
          disconnectTreeObservers()
        }
      })
    }

    const observeTree = (tree: HTMLElement) => {
      // Synchronous attempt first — covers the warm path where the
      // outline is already laid out (file switch with cached symbols).
      if (tryApply(tree)) return
      // Tree exists but its scroll range is not ready yet. ResizeObserver
      // catches container/layout size changes, while MutationObserver catches
      // the common path where the fixed-size scroll container receives its
      // outline items after the parent effect has already run.
      resizeObserver = new ResizeObserver(() => {
        if (tryApply(tree)) {
          disconnectTreeObservers()
        }
      })
      resizeObserver.observe(tree)
      treeMutationObserver = new MutationObserver(() => {
        scheduleRetry(tree)
      })
      treeMutationObserver.observe(tree, { childList: true, subtree: true })
      scheduleRetry(tree)
    }

    const handOffMountedTree = (tree: HTMLElement) => {
      mountMutationObserver?.disconnect()
      mountMutationObserver = null
      observeTree(tree)
    }

    const tree = modalRef.current?.querySelector('.outline-panel-tree') as HTMLElement | null
    if (tree) {
      observeTree(tree)
    } else {
      // OutlinePanel has not mounted yet (rare race when the effect runs
      // between the parent commit and the panel render). Watch the modal
      // root for the tree to appear, then observe the tree's own layout and
      // content readiness.
      const modalRoot = modalRef.current
      if (modalRoot) {
        mountMutationObserver = new MutationObserver(() => {
          const found = modalRoot.querySelector('.outline-panel-tree') as HTMLElement | null
          if (found) {
            handOffMountedTree(found)
          }
        })
        mountMutationObserver.observe(modalRoot, { childList: true, subtree: true })
      } else {
        // Fall back to a single rAF to give React one frame to mount.
        mountFrameId = window.requestAnimationFrame(() => {
          mountFrameId = 0
          const found = modalRef.current?.querySelector('.outline-panel-tree') as HTMLElement | null
          if (found) observeTree(found)
        })
      }
    }

    return () => {
      disconnectTreeObservers()
      mountMutationObserver?.disconnect()
      if (mountFrameId) window.cancelAnimationFrame(mountFrameId)
      if (pendingOutlineDomRestoreRef.current?.signature === signature) {
        pendingOutlineDomRestoreRef.current = null
      }
    }
  }, [activeFilePath, handleOutlineScrollCapture, isOpen, modalRef, outlineShowInSplit, outlineSymbols.length])

  useEffect(() => {
    if (!DEBUG_PROJECT_EDITOR) return
    if (perfIntervalRef.current) return
    perfIntervalRef.current = window.setInterval(() => {
      const snapshot = { ...perfCountersRef.current }
      perfCountersRef.current.renders = 0
      perfCountersRef.current.editorChange = 0
      perfCountersRef.current.editorScroll = 0
      perfCountersRef.current.editorCursor = 0
      perfCountersRef.current.previewScroll = 0
      perfCountersRef.current.previewSync = 0
      perfCountersRef.current.scheduleRender = 0
      perfCountersRef.current.workerSend = 0
      perfCountersRef.current.workerApply = 0
      perfCountersRef.current.projectStateSave = 0
      const hasActivity = Object.values(snapshot).some(count => count > 0)
      if (hasActivity) {
        debugLog('perf:1s', {
          ...snapshot,
          activeFilePath: activeFilePathRef.current,
          renderAllowed: markdownRenderAllowedRef.current,
          renderPending: markdownRenderPendingRef.current,
          workerInFlight: markdownWorkerInFlightRef.current
        })
      }
    }, 1000)
    return () => {
      if (perfIntervalRef.current) {
        window.clearInterval(perfIntervalRef.current)
        perfIntervalRef.current = null
      }
    }
  }, [])

  useEffect(() => {
    const root = rootRef.current
    const filePath = activeFilePath
    if (!root || !filePath || isBinary || isImage || isSqlite || largeFileState) return

    void window.electronAPI.project.watchFile(root, filePath)

    const unsubscribe = window.electronAPI.project.onFileChanged((fullPath, changeType, content) => {
      const currentPath = activeFilePathRef.current
      const currentRoot = rootRef.current
      if (!currentPath || !currentRoot) return

      const separator = currentRoot.includes('\\') ? '\\' : '/'
      const expectedPath = currentRoot.endsWith(separator)
        ? `${currentRoot}${currentPath}`
        : `${currentRoot}${separator}${currentPath}`
      const normalizeFullPath = (value: string) => value.replace(/[\\/]/g, '/')
      if (normalizeFullPath(fullPath) !== normalizeFullPath(expectedPath)) return

	      if (changeType === 'changed' && content !== undefined) {
	        if (content === fileContentRef.current) return
	        markMarkdownSessionCacheStale(currentRoot, currentPath)
	        markdownSessionCacheRenderRef.current = null
	        pendingMarkdownSessionCacheRestoreRef.current = null

	        const editor = editorRef.current
        const model = editor?.getModel()
        const cursorPosition = editor?.getPosition() ?? null
        const scrollTop = editor?.getScrollTop() ?? 0
        const scrollLeft = editor?.getScrollLeft() ?? 0

        if (model && editor) {
          model.pushEditOperations(
            [],
            [{ range: model.getFullModelRange(), text: content }],
            () => (cursorPosition ? [
              {
                range: {
                  startLineNumber: cursorPosition.lineNumber,
                  startColumn: cursorPosition.column,
                  endLineNumber: cursorPosition.lineNumber,
                  endColumn: cursorPosition.column
                }
              }
            ] as unknown as import('monaco-editor').Selection[] : [])
          )
        }

        setFileContent(content)
        fileContentRef.current = content
        setOutlineContentSnapshot({ filePath: activeFilePathRef.current, content })
        originalContentRef.current = content
        originalModelVersionRef.current = null
        setIsDirty(false)
        syncOriginalVersion()

        if (cursorPosition && editor && model) {
          const lineCount = model.getLineCount()
          const safeLine = Math.min(cursorPosition.lineNumber, lineCount)
          const maxColumn = model.getLineMaxColumn(safeLine)
          const safeColumn = Math.min(cursorPosition.column, maxColumn)
          editor.setPosition({ lineNumber: safeLine, column: safeColumn })
        }
        if (editor) {
          editor.setScrollTop(scrollTop)
          editor.setScrollLeft(scrollLeft)
        }

        if (isHtmlPath(currentPath)) {
          void requestHtmlPreviewReload('external-change')
        }
        scheduleMarkdownRender()
        return
      }

      if (changeType === 'deleted') {
        showStatus('error', t('projectEditor.fileDeletedExternally'))
      }
    })

    return () => {
      unsubscribe()
      void window.electronAPI.project.unwatchFile(root, filePath)
    }
  }, [activeFilePath, isBinary, isImage, isSqlite, largeFileState, requestHtmlPreviewReload, scheduleMarkdownRender, showStatus, syncOriginalVersion, t])

  const handleSave = useCallback(async (source: SaveSource = 'toolbar') => {
    const targetPath = activeFilePathRef.current
    const root = rootRef.current
    const binary = isBinaryRef.current
    const image = isImageRef.current
    const sqlite = isSqliteRef.current
    const largeReadonly = Boolean(largeFileStateRef.current)
    if (!targetPath || !root || binary || image || sqlite || largeReadonly) {
      if (DEBUG_PROJECT_EDITOR) {
        debugLog('save:skip', { source, targetPath, hasRoot: Boolean(root), binary, image, sqlite, largeReadonly })
      }
      return null
    }
    const content = fileContentRef.current
    const result = await window.electronAPI.project.saveFile(root, targetPath, content)
    if (!result.success) {
      showStatus('error', result.error || t('projectEditor.error.save'))
      if (DEBUG_PROJECT_EDITOR) {
        debugLog('save:failed', { source, path: targetPath, error: result.error })
      }
      return result
    }
    originalContentRef.current = content
    syncOriginalVersion()
    setIsDirty(false)
    showStatus('success', t('projectEditor.saved'))
	    if (DEBUG_PROJECT_EDITOR) {
	      debugLog('save:success', { source, path: targetPath, bytes: content.length })
	    }
	    if (isMarkdownPath(targetPath)) {
	      captureMarkdownSessionCacheRef.current('save')
	    }
	    if (isHtmlPath(targetPath)) {
	      await requestHtmlPreviewReload('save')
	    }
	    if (_terminalId) {
	      void window.electronAPI.git.notifyTerminalGitUpdate(_terminalId)
	    }
    return result
  }, [_terminalId, requestHtmlPreviewReload, showStatus, syncOriginalVersion, t])

  const handleSaveRef = useRef(handleSave)
  useEffect(() => {
    handleSaveRef.current = handleSave
  }, [handleSave])

  const handleRequestClose = useCallback(async () => {
    const canClose = await confirmDiscardChanges()
    if (!canClose) return
    // Capture all scroll positions before final persist
    const scope = lastEditorScopeRef.current
    const retainViewOnClose = shouldRetainProjectEditorViewOnClose({
      hasActiveFile: Boolean(activeFilePathRef.current),
      hasRootPath: Boolean(rootRef.current),
      hasUnsavedChanges: dirtyRef.current,
      hasMissingFileNotice: Boolean(missingFileNoticeRef.current)
    })
	    if (scope) {
	      const treeEl = fileTreeContainerRef.current
	      const treeKey = getScrollScopeKey(scope)
	      if (treeEl && treeKey) {
	        fileTreeScrollTopRef.current.set(treeKey, treeEl.scrollTop)
	      }
	      capturePreviewScrollMemory()
	      await captureHtmlPreviewScrollMemory('close')
	      captureMarkdownSessionCacheRef.current(retainViewOnClose ? 'close-retain' : 'close')
	      persistProjectEditorState(scope, { flush: true })
	    }
	    if (retainViewOnClose) {
	      captureEditorSoftCloseSnapshot('retained-close', scope)
	    } else {
	      // Non-retained close invalidates only THIS scope's snapshot and its
	      // markdown cache protection.
	      editorSoftCloseSnapshotsRef.current.delete(getScrollScopeKey(scope))
	      setScopeProtectedMarkdownCacheKey(getScrollScopeKey(scope), null)
	    }
	    skipClosePersistRef.current = true
	    if (!retainViewOnClose) {
	      resetActiveFileState()
	    }
	    onClose()
	  }, [
	    captureEditorSoftCloseSnapshot,
	    capturePreviewScrollMemory,
	    confirmDiscardChanges,
	    onClose,
	    persistProjectEditorState,
	    resetActiveFileState
	  ])

  const handleEscape = useCallback(() => {
    // Close overflow dropdown before anything else (P2-1: must beat useSubpageEscape)
    if (pinOverflowOpen || recentOverflowOpen) {
      setPinOverflowOpen(false)
      setRecentOverflowOpen(false)
      setQuickTooltip(null)
      return
    }
    if (dialog) {
      handleDialogCancel()
      return
    }
    if (searchOpen) {
      handleCloseSearch()
      return
    }
    if (previewSearchOpen) {
      closePreviewSearch()
      return
    }
    if (htmlPreviewSearchOpen) {
      closeHtmlPreviewSearch()
      return
    }
    if (sidebarMode === 'search') {
      setSidebarMode('files')
      return
    }
    void handleRequestClose()
  }, [closeHtmlPreviewSearch, closePreviewSearch, dialog, handleDialogCancel, htmlPreviewSearchOpen, searchOpen, handleCloseSearch, previewSearchOpen, handleRequestClose, sidebarMode, pinOverflowOpen, recentOverflowOpen])

  const handleOpenGitDiff = useCallback(async (
    source: 'user' | 'debug' = 'user',
    targetFile?: { filePath?: string | null; repoRoot?: string | null }
  ) => {
    if (!_terminalId) return
    if (DEBUG_PROJECT_EDITOR) {
      debugLog('gitdiff:open:start', {
        source,
        terminalId: _terminalId,
        activeFilePath,
        diffAlreadyOpen: gitDiffOpenRef.current,
        isDirty: dirtyRef.current,
        isMarkdownRenderAllowed,
        markdownRenderPending,
        isIndexing
      })
    }
    const canClose = source === 'debug' || window.electronAPI.debug.profile ? true : await confirmDiscardChanges()
    if (!canClose) return
    if (lastEditorScopeRef.current) {
      capturePreviewScrollMemory()
      await captureHtmlPreviewScrollMemory('subpage-leave')
      captureMarkdownSessionCacheRef.current('subpage-before-leave')
      persistProjectEditorState(lastEditorScopeRef.current, { flush: true })
      captureEditorSoftCloseSnapshot('subpage-return', lastEditorScopeRef.current)
    } else {
      // No scope to key by — drop only this terminal's snapshots.
      editorSoftCloseSnapshotsRef.current.deleteWhere((_key, snapshot) => snapshot.scope.terminalId === _terminalId)
    }
    skipClosePersistRef.current = true
    gitDiffOpenRef.current = true
    if (DEBUG_PROJECT_EDITOR) {
      debugLog('gitdiff:open:before-reset', {
        activeFilePath,
        hasWorker: Boolean(markdownWorkerRef.current),
        workerInFlight: markdownWorkerInFlightRef.current,
        hasRenderTimer: Boolean(markdownRenderTimerRef.current),
        hasIdleTask: markdownIdleHandleRef.current !== null
      })
    }
    resetActiveFileState({ preserveSoftCloseContent: true })
    const terminalId = _terminalId
    if (DEBUG_PROJECT_EDITOR) {
      debugLog('gitdiff:open:dispatch', { terminalId })
    }
    const detail: SubpageNavigateEventDetail = {
      terminalId,
      target: 'diff',
      source: 'editor',
      from: 'editor',
      intent: targetFile?.filePath ? 'jump' : 'switch',
      entryPoint: targetFile?.filePath ? 'deep-link' : 'subpage-switcher',
      filePath: targetFile?.filePath ?? null,
      repoRoot: targetFile?.repoRoot ?? null
    }
    perfTrace(PERF_TRACE_EVENT.RENDERER_PROJECT_SUBPAGE_NAVIGATE, {
      target: 'diff',
      hasTerminalId: Boolean(terminalId),
      hasFileTarget: Boolean(targetFile?.filePath)
    })
    window.dispatchEvent(new CustomEvent('subpage:navigate', { detail }))
  }, [
    _terminalId,
    activeFilePath,
    captureEditorSoftCloseSnapshot,
    capturePreviewScrollMemory,
    confirmDiscardChanges,
    isIndexing,
    isMarkdownRenderAllowed,
    markdownRenderPending,
    persistProjectEditorState,
    resetActiveFileState
  ])

  const handleBackToDiff = useCallback(async () => {
    if (!diffReturnContextRef.current) return false
    await handleOpenGitDiff('user')
    return true
  }, [handleOpenGitDiff])

  const handleJumpToDiff = useCallback(async () => {
    const target = diffJumpTargetRef.current
    if (!target) return false
    perfTrace(PERF_TRACE_EVENT.RENDERER_PROJECT_EDITOR_JUMP_TO_DIFF, {
      terminalId: _terminalId,
      filename: target.filename,
      repoRoot: target.repoRoot,
      changeType: target.changeType
    })
    await handleOpenGitDiff('user', {
      filePath: target.filename,
      repoRoot: target.repoRoot
    })
    return true
  }, [_terminalId, handleOpenGitDiff])

  const handleOpenGitHistory = useCallback(async (source: 'user' | 'debug' = 'user') => {
    if (!_terminalId) return
    if (DEBUG_PROJECT_EDITOR) {
      debugLog('githistory:open:start', {
        source,
        terminalId: _terminalId,
        activeFilePath,
        isDirty: dirtyRef.current,
        isIndexing
      })
    }
    const canClose = source === 'debug' || window.electronAPI.debug.profile ? true : await confirmDiscardChanges()
    if (!canClose) return
    if (lastEditorScopeRef.current) {
      capturePreviewScrollMemory()
      await captureHtmlPreviewScrollMemory('subpage-leave')
      captureMarkdownSessionCacheRef.current('subpage-before-leave')
      persistProjectEditorState(lastEditorScopeRef.current, { flush: true })
      captureEditorSoftCloseSnapshot('subpage-return', lastEditorScopeRef.current)
    } else {
      // No scope to key by — drop only this terminal's snapshots.
      editorSoftCloseSnapshotsRef.current.deleteWhere((_key, snapshot) => snapshot.scope.terminalId === _terminalId)
    }
    skipClosePersistRef.current = true
    resetActiveFileState({ preserveSoftCloseContent: true })
    const terminalId = _terminalId
    const detail: SubpageNavigateEventDetail = {
      terminalId,
      target: 'history',
      from: 'editor',
      intent: 'switch',
      entryPoint: 'subpage-switcher'
    }
    perfTrace(PERF_TRACE_EVENT.RENDERER_PROJECT_SUBPAGE_NAVIGATE, {
      target: 'history',
      hasTerminalId: Boolean(terminalId)
    })
    window.dispatchEvent(new CustomEvent('subpage:navigate', { detail }))
  }, [
    _terminalId,
    activeFilePath,
    captureEditorSoftCloseSnapshot,
    capturePreviewScrollMemory,
    confirmDiscardChanges,
    isIndexing,
    persistProjectEditorState,
    resetActiveFileState
  ])

  const handleSelectSubpage = useCallback((target: SubpageId) => {
    if (target === 'diff') {
      void handleOpenGitDiff('user')
      return
    }
    if (target === 'history') {
      void handleOpenGitHistory('user')
    }
  }, [handleOpenGitDiff, handleOpenGitHistory])

  useEffect(() => {
    openGitDiffRef.current = handleOpenGitDiff
  }, [handleOpenGitDiff])

  // Factory for the full debug API — parameterized only by editSource to avoid
  // duplicating ~55 identical methods across the debug and autotest useEffect blocks.
  function createProjectEditorDebugApi(editSource: string): ProjectEditorDebugApi {
    return {
      isOpen: () => isOpenRef.current,
      getRootPath: () => rootRef.current,
      getActiveFilePath: () => activeFilePathRef.current,
      isSelectFileEmptyStateVisible: () => {
        if (!isOpenRef.current || activeFilePathRef.current) return false
        const root: ParentNode = modalRef.current ?? document
        return Boolean(
          root.querySelector('.project-editor-editor-placeholder') ||
          root.querySelector('.project-editor-editor-body > .project-editor-empty')
        )
      },
      getLastProjectEditorReopenRestore: () => lastProjectEditorReopenRestoreRef.current,
      getDiffReturnBarState: () => buildDiffReturnBarState({
        hasDiffReturnContext: Boolean(diffReturnContextRef.current),
        diffJumpTarget: diffJumpTargetRef.current,
        diffJumpChecking,
        activeFilePath: activeFilePathRef.current
      }),
      triggerDiffReturnBack: async () => handleBackToDiff(),
      triggerJumpToDiff: async () => handleJumpToDiff(),
      getSidebarMode: () => sidebarModeRef.current,
      setSidebarMode: (mode: 'files' | 'search') => {
        if (isFileBrowserCollapsedRef.current) {
          setFileBrowserCollapsedState(false, 'debug')
        }
        setSidebarMode(mode)
      },
      isFileBrowserCollapsed: () => isFileBrowserCollapsedRef.current,
      setFileBrowserCollapsed: (collapsed: boolean) => {
        setFileBrowserCollapsedState(collapsed, 'debug')
      },
      getFileBrowserPanelState: () => {
        const sidebar = modalRef.current?.querySelector<HTMLElement>('.project-editor-sidebar')
        const editor = modalRef.current?.querySelector<HTMLElement>('.project-editor-editor')
        return {
          collapsed: isFileBrowserCollapsedRef.current,
          sidebarWidth: sidebar?.getBoundingClientRect().width ?? 0,
          editorWidth: editor?.getBoundingClientRect().width ?? 0,
          hasRestoreButton: Boolean(sidebar?.querySelector('.project-editor-sidebar-restore-btn')),
          hasTree: Boolean(sidebar?.querySelector('.project-editor-tree')),
          hasResizer: Boolean(sidebar?.querySelector('.project-editor-file-tree-resizer'))
        }
      },
      getEditorContent: () => fileContentRef.current,
      setEditorContent: (content: string) => {
        const editor = editorRef.current
        const model = editor?.getModel()
        if (!editor || !model) return false
        editor.pushUndoStop()
        editor.executeEdits(`${editSource}-set-editor-content`, [{ range: model.getFullModelRange(), text: content }])
        editor.pushUndoStop()
        return true
      },
      getEditorLineCount: () => {
        const model = editorRef.current?.getModel()
        return model ? model.getLineCount() : 0
      },
      getDialogState: () => dialog
        ? {
            type: dialog.type,
            title: dialog.title,
            message: dialog.message
          }
        : null,
      confirmDialog: () => {
        handleDialogConfirm()
      },
      cancelDialog: () => {
        handleDialogCancel()
      },
      getOpenChoiceDialogState: () => ({
        visible: Boolean(fileOpenChoiceDialog),
        extension: fileOpenChoiceDialog?.extension ?? '',
        remember: Boolean(fileOpenChoiceDialog?.remember)
      }),
      chooseOpenChoice: (mode: 'text' | 'binary' | 'cancel', remember?: boolean) => {
        if (mode === 'cancel') {
          handleFileOpenChoiceCancel()
          return
        }
        resolveFileOpenChoice(mode, remember)
      },
      getLargeFileState: () => {
        const state = largeFileStateRef.current
        if (!state) return null
        return {
          mode: state.mode,
          path: state.path,
          sizeBytes: state.sizeBytes,
          offset: state.offset,
          bytesRead: state.bytesRead,
          textLength: state.text.length,
          binaryLength: state.binaryBytes.length,
          binaryRadix,
          loading: state.loading,
          error: state.error,
          readOnly: true
        }
      },
      setLargeFileOffset: async (offset: number) => {
        const state = largeFileStateRef.current
        if (!state) return false
        return await loadLargeFileChunk({
          path: state.path,
          mode: state.mode,
          sizeBytes: state.sizeBytes,
          offset
        })
      },
      setBinaryRadix: (radix: BinaryRadix) => {
        if (![2, 8, 10, 16].includes(radix)) return false
        setBinaryRadix(radix)
        return true
      },
      getCursorPosition: () => {
        const position = editorRef.current?.getPosition()
        if (!position) return null
        return {
          lineNumber: position.lineNumber,
          column: position.column
        }
      },
      setCursorPosition: (lineNumber: number, column = 1) => {
        const editor = editorRef.current
        if (!editor) return false
        const model = editor.getModel()
        if (!model) return false
        if (!activeFilePathRef.current) return false
        const maxLine = model.getLineCount()
        const safeLine = Math.max(1, Math.min(maxLine, Math.floor(lineNumber)))
        const maxColumn = model.getLineMaxColumn(safeLine)
        const safeColumn = Math.max(1, Math.min(maxColumn, Math.floor(column)))
        editor.setPosition({ lineNumber: safeLine, column: safeColumn })
        editor.revealLineInCenter(safeLine)
        scheduleProjectStateSave()
        return true
      },
      getScrollTop: () => {
        const editor = editorRef.current
        if (!editor) return 0
        return editor.getScrollTop()
      },
      getFirstVisibleLine: () => {
        const editor = editorRef.current
        if (!editor) return 1
        const ranges = editor.getVisibleRanges()
        if (!ranges || ranges.length === 0) return 1
        return ranges[0]?.startLineNumber ?? 1
      },
      scrollToLine: (lineNumber: number) => {
        const editor = editorRef.current
        if (!editor) return false
        const model = editor.getModel()
        if (!model) return false
        const maxLine = model.getLineCount()
        const safeLine = Math.max(1, Math.min(maxLine, Math.floor(lineNumber)))
        editor.revealLineNearTop(safeLine)
        editor.setScrollTop(editor.getTopForLineNumber(safeLine))
        scheduleProjectStateSave()
        return true
      },
      getMissingFileNotice: () => {
        const current = missingFileNoticeRef.current
        if (!current) return null
        return {
          path: current.path,
          message: current.message
        }
      },
      openFileByPath: async (filePath: string) => {
        await openFileRef.current(filePath, 'debug')
      },
      openFileByPathAsUser: async (filePath: string, options?: { trackRecent?: boolean }) => {
        await openFileRef.current(filePath, 'user', {
          trackRecent: options?.trackRecent ?? true
        })
      },
      triggerEditorSaveCommand: () => {
        const editor = editorRef.current
        const commandId = editorSaveCommandIdRef.current
        if (!editor || !commandId) return false
        editor.trigger('autotest', commandId, undefined)
        return true
      },
      triggerToolbarSave: async () => {
        const result = await handleSaveRef.current('debug-toolbar')
        return Boolean(result?.success)
      },
      isSqliteViewerVisible: () => {
        return Boolean(activeFilePathRef.current && isSqliteRef.current)
      },
      isPdfReaderVisible: () => {
        return Boolean(activeFilePathRef.current && isPdfRef.current)
      },
      getPdfReaderState: () => {
        if (!activeFilePathRef.current || !isPdfRef.current) return null
        const root: ParentNode = modalRef.current ?? document
        const iframe = root.querySelector('.project-editor-pdf-reader-iframe') as HTMLIFrameElement | null
        return {
          visible: Boolean(iframe),
          src: iframe?.src ?? null,
          filePath: activeFilePathRef.current
        }
      },
      isEpubReaderVisible: () => {
        return Boolean(activeFilePathRef.current && isEpubRef.current)
      },
      getEpubReaderState: () => {
        if (!activeFilePathRef.current || !isEpubRef.current) return null
        const root: ParentNode = modalRef.current ?? document
        const container = root.querySelector('.project-editor-epub-reader') as HTMLElement | null
        const contentNode = container?.querySelector('.project-editor-epub-content') as HTMLElement | null
        // TOC now lives in the shared OutlinePanel; fall back to the state
        // snapshot so this stays accurate regardless of whether the panel
        // is currently visible (e.g. outline collapsed by the user).
        const outlineNodes = root.querySelectorAll('.outline-panel .outline-panel-item')
        const tocNodes = outlineNodes.length > 0 ? outlineNodes : (epubOutlineSymbolsRef.current ?? [])
        const fontSizeLabel = container?.querySelector('.project-editor-epub-fontsize-value')?.textContent?.trim() ?? null
        const errorNode = container?.querySelector('.project-editor-epub-error') as HTMLElement | null
        const errorMessage = errorNode?.textContent?.trim() ?? null
        // Content is rendered when epub.js has added any descendant node (it injects
        // a wrapper <div> and an <iframe>) or when text content exists in the DOM.
        const hasContent = Boolean(
          contentNode && (
            contentNode.querySelector('iframe') ||
            contentNode.childElementCount > 0 ||
            (contentNode.textContent && contentNode.textContent.trim().length > 0)
          )
        )
        const progress = (window as unknown as { __onwardEpubReaderProgress?: { lastLocationHref?: string | null } }).__onwardEpubReaderProgress
        return {
          visible: Boolean(container),
          hasContent,
          tocCount: tocNodes.length,
          fontSizeLabel,
          filePath: activeFilePathRef.current,
          errorMessage,
          contentHtmlLen: contentNode?.innerHTML?.length ?? 0,
          currentLocationHref: progress?.lastLocationHref ?? null
        }
      },
      isHtmlReaderVisible: () => {
        return Boolean(activeFilePathRef.current && isHtmlRef.current && htmlReaderStateRef.current?.visible)
      },
      getHtmlReaderState: () => {
        if (!activeFilePathRef.current || !isHtmlRef.current) return null
        const state = htmlReaderStateRef.current
        if (!state) return null
        return {
          browserId: state.browserId,
          filePath: state.filePath,
          url: state.url,
          title: state.title,
          ready: state.ready,
          visible: state.visible,
          isLoading: state.isLoading,
          loadCount: state.loadCount,
          reloadKey: state.reloadKey,
          canGoBack: state.canGoBack,
          canGoForward: state.canGoForward,
          error: state.error,
          preservedScrollState: htmlPreviewScrollStateRef.current
        }
      },
      getHtmlPreviewNavState: () => {
        if (!activeFilePathRef.current || !isHtmlRef.current) return null
        const state = htmlReaderStateRef.current
        const homeUrl = withHtmlPreviewReloadKey(htmlPreviewUrlRef.current, htmlPreviewReloadKeyRef.current)
        return {
          browserId: state?.browserId ?? null,
          url: state?.url ?? null,
          homeUrl,
          canGoBack: state?.canGoBack ?? false,
          canGoForward: state?.canGoForward ?? false,
          ...deriveHtmlPreviewNavButtonState({
            ready: Boolean(state?.ready && !state.error),
            canGoBack: state?.canGoBack ?? false,
            canGoForward: state?.canGoForward ?? false,
            currentUrl: state?.url ?? null,
            homeUrl
          })
        }
      },
      getHtmlPreviewDocumentState: async () => {
        if (!activeFilePathRef.current || !isHtmlRef.current) return null
        const state = htmlReaderStateRef.current
        if (!state?.browserId) return null
        const result = await window.electronAPI.browser.evaluateForTest(state.browserId, `(() => {
          const images = Array.from(document.images || []);
          return {
            title: document.title,
            readyState: document.readyState,
            bodyText: (document.body && document.body.innerText ? document.body.innerText : '').slice(0, 20000),
            bodyDatasetMarker: document.body ? document.body.dataset.onwardHtmlPreviewFixture || null : null,
            externalReady: Boolean(window.__ONWARD_HTML_EXTERNAL_READY),
            localReady: Boolean(window.__ONWARD_HTML_LOCAL_READY),
            saveMarker: document.querySelector('[data-save-marker]') ? document.querySelector('[data-save-marker]').textContent : null,
            imageCount: images.length,
            loadedImageCount: images.filter((image) => image.complete && image.naturalWidth > 0).length,
            brokenImageCount: images.filter((image) => image.complete && image.naturalWidth === 0).length,
            scrollX: window.scrollX || document.documentElement.scrollLeft || 0,
            scrollY: window.scrollY || document.documentElement.scrollTop || 0,
            scrollHeight: Math.max(document.documentElement.scrollHeight || 0, document.body ? document.body.scrollHeight || 0 : 0),
            scrollWidth: Math.max(document.documentElement.scrollWidth || 0, document.body ? document.body.scrollWidth || 0 : 0),
            clientHeight: document.documentElement.clientHeight || window.innerHeight || 0,
            clientWidth: document.documentElement.clientWidth || window.innerWidth || 0
          };
        })()`)
        if (!result.success) {
          return {
            success: false,
            error: result.error ?? 'Failed to inspect HTML Preview'
          }
        }
        return {
          success: true,
          ...(result.value as Record<string, unknown>)
        }
      },
      setHtmlPreviewScrollForTest: async (y: number) => {
        const state = htmlReaderStateRef.current
        if (!activeFilePathRef.current || !isHtmlRef.current || !state?.browserId) return false
        const result = await window.electronAPI.browser.restoreScrollState(state.browserId, {
          x: 0,
          y,
          scrollWidth: 0,
          scrollHeight: 0,
          clientWidth: 0,
          clientHeight: 0
        })
        return result.success
      },
      getHtmlPreviewZoomFactor: () => htmlPreviewZoomFactorRef.current,
      setHtmlPreviewZoomFactor: async (zoomFactor: number) => {
        return applyHtmlPreviewZoomFactor(zoomFactor, 'debug')
      },
      stepHtmlPreviewZoom: async (direction: 'in' | 'out' | 'reset') => {
        return stepHtmlPreviewZoom(direction, 'debug')
      },
      getHtmlPreviewBrowserZoomFactor: async () => {
        const browserId = htmlReaderStateRef.current?.browserId
        if (!browserId) return null
        const result = await window.electronAPI.browser.getZoomFactor(browserId)
        return result.success ? result.zoomFactor ?? null : null
      },
      getImageFilePreviewState,
      getFileBrowserScrollTop: () => fileTreeContainerRef.current?.scrollTop ?? 0,
      getFileBrowserScrollHeight: () => fileTreeContainerRef.current?.scrollHeight ?? 0,
      scrollFileBrowserToFraction,
      getFileBrowserActiveRowBounds: () => {
        const container = fileTreeContainerRef.current
        const path = activeFilePathRef.current
        if (!container || !path) return null
        const row = container.querySelector<HTMLElement>(
          `.project-editor-tree-item[data-path="${CSS.escape(path)}"]`
        )
        const containerRect = container.getBoundingClientRect()
        if (!row) {
          return {
            found: false,
            containerTop: containerRect.top,
            containerHeight: containerRect.height,
            rowTop: 0,
            rowHeight: 0,
            centerOffsetRatio: 1
          }
        }
        const rowRect = row.getBoundingClientRect()
        const rowCenter = rowRect.top + rowRect.height / 2
        const containerCenter = containerRect.top + containerRect.height / 2
        const ratio = containerRect.height === 0
          ? 1
          : Math.abs(rowCenter - containerCenter) / containerRect.height
        return {
          found: true,
          containerTop: containerRect.top,
          containerHeight: containerRect.height,
          rowTop: rowRect.top,
          rowHeight: rowRect.height,
          centerOffsetRatio: ratio
        }
      },
      getFileBrowserExpandedDirs: () => {
        const container = fileTreeContainerRef.current
        if (!container) return []
        const toggles = container.querySelectorAll('.project-editor-tree-toggle.open')
        const out: string[] = []
        toggles.forEach((toggle) => {
          const item = toggle.closest('.project-editor-tree-item') as HTMLElement | null
          const path = item?.dataset.path
          if (path) out.push(path)
        })
        return out
      },
      clickLocateFileButton: () => {
        const btn = modalRef.current?.querySelector<HTMLButtonElement>(
          '.project-editor-sidebar-action-btn'
        )
        if (!btn || btn.disabled) return false
        btn.click()
        return true
      },
      isMarkdownEditorVisible: () => isMarkdownEditorVisibleRef.current,
      setMarkdownEditorVisible: (visible: boolean) => {
        setMarkdownEditorVisibleState(visible)
      },
      setMarkdownPreviewVisible: (visible: boolean) => {
        setMarkdownPreviewOpenState(visible)
      },
      isMarkdownPreviewVisible: () => previewVisibleRef.current,
      setMarkdownPreviewOpen: (open: boolean) => {
        setMarkdownPreviewOpenState(open)
      },
      isMarkdownCodeWrapEnabled: () => isMarkdownCodeWrapEnabledRef.current,
      setMarkdownCodeWrapEnabled: (enabled: boolean) => {
        setMarkdownCodeWrapEnabledState(enabled)
      },
      getMarkdownCodeWrapState: () => getMarkdownCodeWrapDebugState(),
      setPreviewSearchOpen: (open: boolean) => {
        if (open) {
          openPreviewSearch()
        } else {
          closePreviewSearch()
        }
      },
      isPreviewSearchOpen: () => previewSearchOpenRef.current,
      previewSearchSetQuery: (query: string) => {
        previewSearchRef.current?.setQuery(query)
      },
      previewSearchGoToNext: () => {
        previewSearchRef.current?.goToNext()
      },
      previewSearchGoToPrevious: () => {
        previewSearchRef.current?.goToPrevious()
      },
      getPreviewSearchMatchCount: () => {
        return previewSearchRef.current?.getMatchCount() ?? 0
      },
      getPreviewSearchCurrentIndex: () => {
        return previewSearchRef.current?.getCurrentIndex() ?? -1
      },
      getPreviewSearchMatchPositions: () => {
        // Use the cached match snapshot produced when the query was last
        // applied. This keeps the hook O(1) even with hundreds of matches —
        // the old implementation forced 1 + N layout reads via
        // getBoundingClientRect on every call, which dominated the
        // preview-search autotest runtime at large match counts.
        const handle = previewSearchRef.current
        const cached = handle?.getCachedMatchPositions?.() ?? []
        if (cached.length > 0) {
          const activeIndex = handle?.getCurrentIndex?.() ?? -1
          return cached.map((pos, idx) => ({
            top: pos.top,
            left: pos.left,
            isActive: idx === activeIndex,
          }))
        }
        // Fallback: search UI hasn't run yet (or cache was cleared). Return
        // an empty list rather than paying the O(N) DOM-walk cost — callers
        // that actually need positions can reopen search to refresh the
        // cache.
        return []
      },
      getPreviewSearchActiveCenter: () => {
        const preview = previewRef.current
        if (!preview) return null
        const activeMark = preview.querySelector('mark.preview-search-highlight-active')
        if (!activeMark) return null
        const containerRect = preview.getBoundingClientRect()
        const markRect = activeMark.getBoundingClientRect()
        const markCenter = markRect.top + markRect.height / 2 - containerRect.top
        const containerCenter = containerRect.height / 2
        const containerHeight = containerRect.height
        const offset = markCenter - containerCenter
        return { markCenter, containerCenter, containerHeight, offset }
      },
      setHtmlPreviewSearchOpen: (open: boolean) => {
        if (open) {
          openHtmlPreviewSearch()
        } else {
          closeHtmlPreviewSearch()
        }
      },
      isHtmlPreviewSearchOpen: () => htmlPreviewSearchOpenRef.current,
      htmlPreviewSearchSetQuery: (query: string) => {
        updateHtmlPreviewSearchQuery(query)
      },
      htmlPreviewSearchGoToNext: () => {
        goToNextHtmlPreviewSearchMatch()
      },
      htmlPreviewSearchGoToPrevious: () => {
        goToPreviousHtmlPreviewSearchMatch()
      },
      getHtmlPreviewSearchState: () => ({
        open: htmlPreviewSearchOpenRef.current,
        query: htmlPreviewSearchQueryRef.current,
        matches: htmlPreviewSearchResultRef.current.matches,
        activeMatchOrdinal: htmlPreviewSearchResultRef.current.activeMatchOrdinal,
        finalUpdate: htmlPreviewSearchResultRef.current.finalUpdate
      }),
      isMarkdownRenderPending: () => markdownRenderPendingRef.current,
      getMarkdownRenderedHtml: () => markdownRenderedHtmlRef.current,
      getMarkdownPreviewImageState: () => {
        const preview = previewRef.current
        if (!preview) {
          return {
            count: 0,
            loadedCount: 0,
            brokenCount: 0,
            sources: []
          }
        }
        const images = Array.from(preview.querySelectorAll('img')) as HTMLImageElement[]
        return {
          count: images.length,
          loadedCount: images.filter((image) => image.complete && image.naturalWidth > 0).length,
          brokenCount: images.filter((image) => image.complete && image.naturalWidth === 0).length,
          sources: images.map((image) => image.currentSrc || image.src || '')
        }
      },
	      getMermaidPreviewState,
	      getMermaidPanZoomState: () => {
	        const preview = previewRef.current
	        if (!preview) return []
	        return getMermaidPanZoomState(preview)
	      },
	      triggerMermaidPanZoomAction: (diagramId: string, action: 'zoomIn' | 'zoomOut' | 'fit' | 'reset' | 'fullscreen') => {
	        const preview = previewRef.current
	        if (!preview) return false
	        return triggerMermaidPanZoomAction(preview, diagramId, action)
	      },
	      simulateMermaidPan: (diagramId: string, dx: number, dy: number) => {
	        const preview = previewRef.current
	        if (!preview) return false
	        return simulateMermaidPan(preview, diagramId, dx, dy)
	      },
	      isMermaidFullscreenActive: () => isMermaidFullscreenActive(),
	      getMarkdownSessionCacheState: () => ({
	        size: markdownSessionCacheStore.size,
	        limit: getMarkdownSessionCacheLimit(),
	        lastRestore: markdownSessionLastRestoreRef.current,
	        entries: getMarkdownSessionCacheDebugEntries()
	      }),
	      isPreviewTransitioning: () => previewRestorePhaseRef.current !== 'idle',
      isPreviewContentVisible: () => isPreviewContentVisibleNow(),
      getPreviewRestorePhase: () => previewRestorePhaseRef.current,
      getLastPreviewReveal: () => lastPreviewRevealRef.current,
      getOutlineTarget: () => outlineTargetRef.current,
      setOutlineTarget: (target: 'editor' | 'preview') => {
        setOutlineTargetPreference(target)
      },
      getOutlineEffectiveTarget: () => {
        if (previewVisibleRef.current && !isMarkdownEditorVisibleRef.current) return 'preview'
        if (isMarkdownEditorVisibleRef.current && !previewVisibleRef.current) return 'editor'
        return outlineTargetRef.current
      },
      isOutlineVisible: () => outlineShowInSplitRef.current,
      setOutlineVisible: (visible: boolean) => {
        setOutlineVisibleState(visible)
      },
      getOutlineSymbolCount: () => countSymbols(outlineSymbolsRef.current),
      getOutlineActiveItemName: () => outlineActiveItemRef.current?.name ?? null,
      getOutlineActiveItemBounds: () => {
        const container = getOutlineScrollContainer()
        if (!container) return null
        const active = container.querySelector<HTMLElement>('.outline-panel-item.active')
        const containerRect = container.getBoundingClientRect()
        if (!active) {
          return {
            found: false,
            containerTop: containerRect.top,
            containerHeight: containerRect.height,
            itemTop: 0,
            itemHeight: 0,
            centerOffsetRatio: 1
          }
        }
        const itemRect = active.getBoundingClientRect()
        const itemCenter = itemRect.top + itemRect.height / 2
        const containerCenter = containerRect.top + containerRect.height / 2
        const ratio = containerRect.height === 0
          ? 1
          : Math.abs(itemCenter - containerCenter) / containerRect.height
        return {
          found: true,
          containerTop: containerRect.top,
          containerHeight: containerRect.height,
          itemTop: itemRect.top,
          itemHeight: itemRect.height,
          centerOffsetRatio: ratio
        }
      },
      getOutlineScrollTop: () => getOutlineScrollContainer()?.scrollTop ?? 0,
      getOutlineScrollHeight: () => getOutlineScrollContainer()?.scrollHeight ?? 0,
      getOutlineScrollMax: () => {
        const outline = getOutlineScrollContainer()
        return outline ? Math.max(0, outline.scrollHeight - outline.clientHeight) : 0
      },
      scrollOutlineToFraction,
      clickOutlineItemByName: (name: string) => {
        const labels = modalRef.current?.querySelectorAll('.outline-panel-item-name') ?? []
        for (const label of labels) {
          if (label.textContent?.trim() !== name.trim()) continue
          const item = label.closest('.outline-panel-item') as HTMLElement | null
          item?.click()
          return Boolean(item)
        }
        return false
      },
      getPreviewActiveSlug: () => previewActiveSlugRef.current,
      scrollPreviewToFraction: (fraction: number) => {
        const preview = previewRef.current
        if (!preview) return false
        const maxScroll = Math.max(1, preview.scrollHeight - preview.clientHeight)
        preview.scrollTop = fraction * maxScroll
        preview.dispatchEvent(new Event('scroll'))
        capturePreviewScrollMemory()
        updatePreviewActiveSlug(scanPreviewNearestSlug())
        return true
      },
      getPreviewScrollTop: () => previewRef.current?.scrollTop ?? 0,
      getPreviewScrollHeight: () => previewRef.current?.scrollHeight ?? 0,
      debugScanPreviewHeadings: () => ({ nearest: scanPreviewNearestSlug() }),
      runPreviewPositionTest: async (mdFilePath: string, otherFilePath: string) => {
        const sleep = (ms: number) => new Promise<void>((resolve) => {
          window.setTimeout(resolve, ms)
        })
        const waitRender = async (timeoutMs = 8000) => {
          const startedAt = Date.now()
          while (Date.now() - startedAt < timeoutMs) {
            if (!markdownRenderPendingRef.current && markdownRenderedHtmlRef.current) {
              break
            }
            await sleep(100)
          }
          await sleep(500)
        }

        await openFileRef.current(mdFilePath, 'debug')
        await waitRender()

        const preview = previewRef.current
        if (!preview) return false

        const maxScroll = Math.max(1, preview.scrollHeight - preview.clientHeight)
        preview.scrollTop = Math.round(maxScroll * 0.5)
        await sleep(300)
        const savedPosition = preview.scrollTop

        await openFileRef.current(otherFilePath, 'debug')
        await sleep(1500)
        await openFileRef.current(mdFilePath, 'debug')
        await waitRender()

        const restoredPosition = preview.scrollTop
        return Math.abs(restoredPosition - savedPosition) <= 30
      },
      isGlobalFilenameSearchOpen: () => searchOpenRef.current,
      openGlobalFilenameSearch: async () => {
        await handleOpenSearchRef.current()
      },
      closeGlobalFilenameSearch: () => {
        handleCloseSearchRef.current()
      },
      setGlobalFilenameSearchQuery: (query: string) => {
        setSearchQuery(query)
      },
      getGlobalFilenameSearchQuery: () => searchQueryRef.current,
      getGlobalFilenameSearchResults: () => [...searchResultsRef.current],
      getFileIndexStats: () => fileIndexGetCacheStats(),
      forceRefreshFileIndex: async () => {
        const root = rootRef.current
        if (!root) return false
        fileIndexInvalidate(root)
        await buildFileIndex()
        return true
      },
    }
  }

  useEffect(() => {
    if (!window.electronAPI?.debug?.enabled) return
    const debugWindow = window as Window & { __onwardProjectEditorDebug?: ProjectEditorDebugApi }
    const api = createProjectEditorDebugApi('debug')
    debugWindow.__onwardProjectEditorDebug = api
    return () => {
      if (debugWindow.__onwardProjectEditorDebug === api) {
        delete debugWindow.__onwardProjectEditorDebug
      }
    }
  }, [
    beginPreviewRestore,
    binaryRadix,
    capturePreviewScrollMemory,
    closeHtmlPreviewSearch,
    dialog,
    fileOpenChoiceDialog,
    getOutlineScrollContainer,
    getImageFilePreviewState,
    getMermaidPreviewState,
    getMarkdownCodeWrapDebugState,
    goToNextHtmlPreviewSearchMatch,
    goToPreviousHtmlPreviewSearchMatch,
    handleBackToDiff,
    handleDialogCancel,
    handleDialogConfirm,
    handleFileOpenChoiceCancel,
    handleJumpToDiff,
    handleOutlineScrollCapture,
    isPreviewContentVisibleNow,
    diffJumpChecking,
    loadLargeFileChunk,
    openHtmlPreviewSearch,
    resolveFileOpenChoice,
    scanPreviewNearestSlug,
    scheduleProjectStateSave,
    scrollFileBrowserToFraction,
    scrollOutlineToFraction,
    setMarkdownCodeWrapEnabledState,
    setMarkdownEditorVisibleState,
    setMarkdownPreviewOpenState,
    setOutlineTargetPreference,
    setOutlineVisibleState,
    updateHtmlPreviewSearchQuery,
    updatePreviewActiveSlug
  ])

  useEffect(() => {
    if (!window.electronAPI?.debug?.autotest) return
    const debugWindow = window as Window & { __onwardProjectEditorDebug?: ProjectEditorDebugApi }
    const api = createProjectEditorDebugApi('autotest')
    debugWindow.__onwardProjectEditorDebug = api
    return () => {
      if (debugWindow.__onwardProjectEditorDebug === api) {
        delete debugWindow.__onwardProjectEditorDebug
      }
    }
  }, [
    beginPreviewRestore,
    binaryRadix,
    capturePreviewScrollMemory,
    closeHtmlPreviewSearch,
    dialog,
    fileOpenChoiceDialog,
    getOutlineScrollContainer,
    getImageFilePreviewState,
    getMarkdownCodeWrapDebugState,
    goToNextHtmlPreviewSearchMatch,
    goToPreviousHtmlPreviewSearchMatch,
    handleBackToDiff,
    handleDialogCancel,
    handleDialogConfirm,
    handleFileOpenChoiceCancel,
    handleJumpToDiff,
    handleOutlineScrollCapture,
    isPreviewContentVisibleNow,
    diffJumpChecking,
    loadLargeFileChunk,
    openHtmlPreviewSearch,
    resolveFileOpenChoice,
    scanPreviewNearestSlug,
    scheduleProjectStateSave,
    scrollFileBrowserToFraction,
    scrollOutlineToFraction,
    setMarkdownCodeWrapEnabledState,
    setMarkdownEditorVisibleState,
    setMarkdownPreviewOpenState,
    setOutlineTargetPreference,
    setOutlineVisibleState,
    updateHtmlPreviewSearchQuery,
    updatePreviewActiveSlug
  ])

  useEffect(() => {
    if (!window.electronAPI?.debug?.autotest) return
    const logBootstrap = (reason: string) => {
      const payload = {
        reason,
        isOpen,
        hasRootPath: Boolean(rootPath),
        rootError: rootError ?? null,
        treeLength: tree.length,
        alreadyRan: autotestRunRef.current,
        suite: window.electronAPI.debug.autotestSuite ?? null,
        cwd: window.electronAPI.debug.autotestCwd ?? null
      }
      const signature = JSON.stringify(payload)
      if (autotestBootstrapLogRef.current === signature) return
      autotestBootstrapLogRef.current = signature
      console.log('[AutoTest] bootstrap', payload)
      window.electronAPI.debug.log('[AutoTest] bootstrap', payload)
    }
    if (!isOpen || !rootPath || rootError) {
      logBootstrap('waiting-for-open-root')
      return
    }
    if (tree.length === 0) {
      logBootstrap('waiting-for-tree')
      return
    }
    // Guard the WHOLE suite against re-running. `autotestRunRef` is per-component
    // and RESETS when the suite's own navigation (reopen editor / switch tab)
    // unmounts + remounts ProjectEditor — which re-ran the entire suite, double-
    // created fixtures, and left residue (e.g. an undeleted untracked file) that
    // polluted later autotest passes' clean preconditions. A window-level flag
    // survives remounts so the suite runs exactly once per app launch.
    const autotestWin = window as unknown as { __onwardAutotestSuiteStarted?: boolean }
    if (autotestRunRef.current || autotestWin.__onwardAutotestSuiteStarted) return
    logBootstrap('starting')
    autotestRunRef.current = true
    autotestWin.__onwardAutotestSuiteStarted = true

    const log = (message: string, data?: unknown) => {
      const prefix = '[AutoTest]'
      console.log(prefix, message, data ?? '')
      window.electronAPI.debug.log(`${prefix} ${message}`, data)
    }

    const sleep = (ms: number) => new Promise<void>((resolve) => {
      window.setTimeout(resolve, ms)
    })

    // HOLISTIC EDR hardening: this host taxes every process spawn 1.3-12.9s, so a
    // readiness wait whose predicate depends on a git/conpty/rg spawn legitimately
    // needs longer than its base ceiling under full-suite load. Scale every
    // readiness-class waitFor ceiling here (one place → every ctx.waitFor caller).
    // This is nearly free: waitFor SHORT-CIRCUITS the instant the predicate is true,
    // so a passing wait is NOT slowed — the scale only extends the give-up point for
    // a wait that would otherwise time out mid-spawn-tax (the dominant EDR flake
    // class). On a fast/CI host the scale is inert. Only ceilings >= 3000ms are
    // scaled, so short "confirm X does NOT happen within N ms" / quick-close waits
    // (which expect a timeout) keep their tight window and do not gain false-detect
    // time. Autotest-only code (this whole bootstrap runs only under ONWARD_AUTOTEST).
    const EDR_WAIT_SCALE = 2.5
    const EDR_WAIT_SCALE_MIN_MS = 3000
    const waitFor = async (
      label: string,
      predicate: () => boolean,
      timeoutMs = 6000,
      intervalMs = 80
    ) => {
      const effectiveTimeout = timeoutMs >= EDR_WAIT_SCALE_MIN_MS
        ? Math.round(timeoutMs * EDR_WAIT_SCALE)
        : timeoutMs
      const start = performance.now()
      while (true) {
        if (predicate()) return true
        const elapsed = performance.now() - start
        if (elapsed >= effectiveTimeout) break
        await sleep(Math.min(intervalMs, Math.max(0, effectiveTimeout - elapsed)))
      }
      if (predicate()) return true
      log('timeout', { label, timeoutMs: effectiveTimeout, baseTimeoutMs: timeoutMs, edrScale: EDR_WAIT_SCALE })
      return false
    }

    const reopenProjectEditorFn = async (label: string) => {
      if (!_terminalId) return false
      window.dispatchEvent(new CustomEvent('project-editor:open', { detail: { terminalId: _terminalId } }))
      const opened = await waitFor(
        `project-editor-open:${label}`,
        () => isOpenRef.current && Boolean(rootRef.current),
        8000
      )
      if (!opened) {
        log('project-editor-open-timeout', { label })
      }
      await sleep(400)
      return opened
    }

    const ensureProjectEditorRoot = async (label: string) => {
      if (rootRef.current) return true
      const reopened = await reopenProjectEditorFn(`ensure-root:${label}`)
      if (!reopened) return false
      return Boolean(rootRef.current)
    }

    let _cancelled = false
    let cpuTimer: number | null = null
    const cpuSummary: CpuSummary = {
      samples: 0, totalAvg: 0, totalMax: 0,
      rendererAvg: 0, rendererMax: 0, browserAvg: 0, browserMax: 0
    }

    const startCpuSampler = () => {
      cpuTimer = window.setInterval(async () => {
        try {
          const metrics = await window.electronAPI.debug.getAppMetrics()
          if (!Array.isArray(metrics)) return
          let total = 0, renderer = 0, browser = 0
          metrics.forEach((metric) => {
            const anyMetric = metric as Record<string, unknown>
            const cpu = (anyMetric.cpu as { percentCPUUsage?: number } | undefined)?.percentCPUUsage ?? 0
            total += cpu
            const type = String(anyMetric.type ?? '')
            if (type.toLowerCase() === 'renderer') renderer += cpu
            if (type.toLowerCase() === 'browser') browser += cpu
          })
          cpuSummary.samples += 1
          cpuSummary.totalAvg += total
          cpuSummary.rendererAvg += renderer
          cpuSummary.browserAvg += browser
          cpuSummary.totalMax = Math.max(cpuSummary.totalMax, total)
          cpuSummary.rendererMax = Math.max(cpuSummary.rendererMax, renderer)
          cpuSummary.browserMax = Math.max(cpuSummary.browserMax, browser)
        } catch {
          // ignore sampling errors
        }
      }, 1000)
    }

    const stopCpuSampler = (): CpuSummary => {
      if (cpuTimer) {
        window.clearInterval(cpuTimer)
        cpuTimer = null
      }
      if (cpuSummary.samples > 0) {
        cpuSummary.totalAvg = Math.round(cpuSummary.totalAvg / cpuSummary.samples)
        cpuSummary.rendererAvg = Math.round(cpuSummary.rendererAvg / cpuSummary.samples)
        cpuSummary.browserAvg = Math.round(cpuSummary.browserAvg / cpuSummary.samples)
      }
      const result = { ...cpuSummary }
      // Reset for next sampling
      cpuSummary.samples = 0
      cpuSummary.totalAvg = 0
      cpuSummary.totalMax = 0
      cpuSummary.rendererAvg = 0
      cpuSummary.rendererMax = 0
      cpuSummary.browserAvg = 0
      cpuSummary.browserMax = 0
      return result
    }

    const allTestResults: TestResult[] = []
    const assertFn = (name: string, ok: boolean, detail?: Record<string, unknown>) => {
      allTestResults.push({ name, ok, detail })
      log(ok ? 'PASS' : 'FAIL', { test: name, ...detail })
    }

    const ctx: AutotestContext = {
      terminalId: _terminalId!,
      rootPath,
      log,
      sleep,
      waitFor,
      assert: assertFn,
      startCpuSampler,
      stopCpuSampler,
      cancelled: () => _cancelled,
      openFileInEditor: async (filePath: string) => {
        const ready = await ensureProjectEditorRoot(`open-file:${filePath}`)
        if (!ready) {
          log('open-file-skip-missing-root', { filePath })
          return
        }
        await openFileRef.current(filePath, 'debug')
      },
      reopenProjectEditor: reopenProjectEditorFn,
      buildFileIndex,
      isOpenRef,
      rootRef
    }

    const run = async () => {
      try {
        await runAllTests(ctx)

        log('cpu-summary', stopCpuSampler())
        log('done')

        if (window.electronAPI.debug.autotestExit) {
          await sleep(600)
          await window.electronAPI.debug.quit()
        }
      } catch (error) {
        stopCpuSampler()
        log('error', { error: String(error) })
        if (window.electronAPI.debug.autotestExit) {
          await sleep(600)
          await window.electronAPI.debug.quit()
        }
      }
    }

    void run()

    return () => {
      // Note: autotest needs to survive the ProjectEditor on/off cycle
      // Do not set _cancelled = true because autotestRunRef already prevents repeated runs
      // Stop CPU sampling only when component is completely unloaded
    }
  }, [buildFileIndex, isOpen, rootError, rootPath, tree.length, _terminalId])

  useEffect(() => {
    if (!window.electronAPI.debug.profile) return
    if (window.electronAPI.debug.autotest) return
    if (!isOpen || !rootPath || rootError) return
    if (tree.length === 0) return
    if (profileRunRef.current) return
    profileRunRef.current = true
    debugLog('profile:begin', { rootPath, treeLength: tree.length })

    let cancelled = false
    const sleep = (ms: number) => new Promise<void>((resolve) => {
      window.setTimeout(resolve, ms)
    })

    const run = async () => {
      try {
        const indexed = await buildFileIndex()
        const markdownFiles = indexed.filter((path) => isMarkdownPath(path))
        const targets = (markdownFiles.length > 0 ? markdownFiles : indexed).slice(0, 8)
        debugLog('profile:targets', {
          total: indexed.length,
          markdown: markdownFiles.length,
          targets
        })
        const block = `\n\n## Profiling Update\n\n` +
          `- Time: ${new Date().toISOString()}\n` +
          `- Note: render stress test\n` +
          `- List: ${'- test item\n'.repeat(12)}`
        const heavyBlock = `\n\n## Profiling Heavy Update\n\n` +
          `- Time: ${new Date().toISOString()}\n` +
          `- Note: heavy render load\n` +
          `${'- reload item\n'.repeat(120)}`

        for (const [index, file] of targets.entries()) {
          if (cancelled) return
          debugLog('profile:open', { index, file })
          await openFileRef.current(file, 'debug')
          await sleep(160)

          const editor = editorRef.current
          const model = editor?.getModel()
          if (editor && model) {
            const isLast = index === targets.length - 1
            const iterations = isLast ? 6 : 2
            const payload = isLast ? heavyBlock : block
            for (let i = 0; i < iterations; i += 1) {
              if (cancelled) return
              const line = model.getLineCount()
              const column = model.getLineMaxColumn(line)
              editor.executeEdits('profile', [{
                range: {
                  startLineNumber: line,
                  startColumn: column,
                  endLineNumber: line,
                  endColumn: column
                },
                text: payload
              }])
              editor.setScrollTop(editor.getScrollHeight())
              await sleep(isLast ? 40 : 120)
            }
          }

          await sleep(180)
        }

        if (openGitDiffRef.current) {
          debugLog('profile:gitdiff', {
            terminalId: _terminalId,
            renderPending: markdownRenderPendingRef.current,
            workerInFlight: markdownWorkerInFlightRef.current
          })
          await openGitDiffRef.current('debug')
          window.setTimeout(() => {
            debugLog('profile:gitdiff:close', { terminalId: _terminalId })
            window.dispatchEvent(new CustomEvent('git-diff:close', { detail: { terminalId: _terminalId } }))
          }, 2200)
          window.setTimeout(() => {
            debugLog('profile:project-editor:reopen', { terminalId: _terminalId })
            window.dispatchEvent(new CustomEvent('project-editor:open', { detail: { terminalId: _terminalId } }))
          }, 2800)
        }
      } catch (error) {
        debugLog('profile:error', { error: String(error) })
      }
    }

    void run()
    return () => {
      cancelled = true
    }
  }, [buildFileIndex, isOpen, rootError, rootPath, _terminalId, tree.length])

  const openContextMenu = useCallback((
    event: React.MouseEvent,
    options?: {
      path: string | null
      type: 'file' | 'dir' | null
      source?: 'tree' | 'quick-recent' | 'quick-pin'
      select?: boolean
    }
  ) => {
    event.preventDefault()
    event.stopPropagation()
    const rect = modalRef.current?.getBoundingClientRect()
    if (!rect) return
    setContextMenu({
      x: event.clientX - rect.left,
      y: event.clientY - rect.top,
      targetPath: options?.path ?? null,
      targetType: options?.type ?? null,
      source: options?.source ?? 'tree'
    })
    if (options?.select && options.path) {
      setSelectedPath(options.path)
    }
  }, [])

  const closeContextMenu = useCallback(() => {
    setContextMenu(null)
  }, [])

  useEffect(() => {
    if (!isOpen) return

    const handleKeyDown = (event: KeyboardEvent) => {
      if (dialog) return
      if (searchOpen) return

      // Cmd/Ctrl+Shift+F — global content search (sidebar)
      const isGlobalSearch = (event.metaKey || event.ctrlKey) && event.shiftKey && event.key.toLowerCase() === 'f'
      if (isGlobalSearch) {
        event.preventDefault()
        event.stopPropagation()
        setContextMenu(null)
        setInitialSearchType('content')
        if (isFileBrowserCollapsedRef.current) {
          setFileBrowserCollapsedState(false)
        }
        setSidebarMode('search')
        setTimeout(() => globalSearchInputRef.current?.focus(), 0)
        return
      }

      const isSearch = (event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'p'
      if (isSearch) {
        event.preventDefault()
        void handleOpenSearch()
        return
      }

      if (isHtmlPreviewVisible && isHtmlPreviewRefreshShortcut(event)) {
        event.preventDefault()
        event.stopPropagation()
        void handleHtmlPreviewNav('reload', 'shortcut')
        return
      }

      const isHtmlZoomShortcut = (event.metaKey || event.ctrlKey) &&
        !event.altKey &&
        isHtmlPreviewVisible &&
        ['+', '=', '-', '_', '0'].includes(event.key)
      if (isHtmlZoomShortcut) {
        const target = event.target instanceof Element ? event.target : null
        const inEditor = Boolean(target?.closest('.monaco-editor'))
        if (!inEditor) {
          event.preventDefault()
          event.stopPropagation()
          const direction = event.key === '0' ? 'reset' : (event.key === '-' || event.key === '_' ? 'out' : 'in')
          void stepHtmlPreviewZoom(direction, 'shortcut')
          return
        }
      }

      const isPreviewSearch = (event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'f'
      if (isPreviewSearch) {
        const target = event.target instanceof Element ? event.target : null
        const inEditor = Boolean(target?.closest('.monaco-editor'))
        if (!inEditor && isMarkdownPreviewVisible) {
          event.preventDefault()
          openPreviewSearch()
        } else if (!inEditor && isHtmlPreviewVisible) {
          event.preventDefault()
          openHtmlPreviewSearch()
        }
        return
      }

      const isSave = (event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's'
      if (isSave) {
        const target = event.target instanceof Element ? event.target : null
        const inEditor = !!target?.closest('.monaco-editor')
        if (inEditor) return
        event.preventDefault()
        void handleSaveRef.current('global-shortcut')
        return
      }

    }

    document.addEventListener('keydown', handleKeyDown, true)
    return () => document.removeEventListener('keydown', handleKeyDown, true)
  }, [dialog, handleHtmlPreviewNav, handleOpenSearch, isHtmlPreviewVisible, isMarkdownPreviewVisible, isOpen, openHtmlPreviewSearch, openPreviewSearch, searchOpen, setFileBrowserCollapsedState, stepHtmlPreviewZoom])

  useSubpageEscape({ isOpen, onEscape: handleEscape })

  const notifySqliteMutation = useCallback(() => {
    if (!_terminalId) return
    void window.electronAPI.git.notifyTerminalGitUpdate(_terminalId)
  }, [_terminalId])

  const handleNewFile = useCallback(async (baseDirOverride?: string) => {
    const root = rootRef.current
    if (!root) return

    const baseDir = baseDirOverride ?? (selectedPath
      ? (findNode(tree, selectedPath)?.type === 'dir'
        ? selectedPath
        : getParentPath(selectedPath))
      : '')

    const name = await requestPrompt({
      title: t('projectEditor.dialog.newFile.title'),
      message: t('projectEditor.dialog.newFile.message'),
      placeholder: t('projectEditor.dialog.newFile.placeholder')
    })

    if (!name) return
    if (name.includes('/') || name.includes('\\')) {
      showStatus('error', t('projectEditor.error.fileNameHasSeparator'))
      return
    }

    const targetPath = joinPath(baseDir, name)
    const result = await window.electronAPI.project.createFile(root, targetPath, '')
    if (!result.success) {
      showStatus('error', result.error || t('projectEditor.error.createFile'))
      return
    }

    await refreshDirectory(baseDir)
    fileIndexAddFile(root, targetPath)
    void window.electronAPI.project.invalidateFileIndex(root)
    await openFile(targetPath, 'user', { trackRecent: true })
    showStatus('success', t('projectEditor.fileCreated'))
  }, [openFile, refreshDirectory, requestPrompt, selectedPath, showStatus, t, tree])

  const handleNewFolder = useCallback(async (baseDirOverride?: string) => {
    const root = rootRef.current
    if (!root) return

    const baseDir = baseDirOverride ?? (selectedPath
      ? (findNode(tree, selectedPath)?.type === 'dir'
        ? selectedPath
        : getParentPath(selectedPath))
      : '')

    const name = await requestPrompt({
      title: t('projectEditor.dialog.newFolder.title'),
      message: t('projectEditor.dialog.newFolder.message'),
      placeholder: t('projectEditor.dialog.newFolder.placeholder')
    })

    if (!name) return
    if (name.includes('/') || name.includes('\\')) {
      showStatus('error', t('projectEditor.error.folderNameHasSeparator'))
      return
    }

    const targetPath = joinPath(baseDir, name)
    const result = await window.electronAPI.project.createFolder(root, targetPath)
    if (!result.success) {
      showStatus('error', result.error || t('projectEditor.error.createFolder'))
      return
    }

    await refreshDirectory(baseDir)
    void window.electronAPI.project.invalidateFileIndex(root)
    showStatus('success', t('projectEditor.folderCreated'))
  }, [refreshDirectory, requestPrompt, selectedPath, showStatus, t, tree])

  const handleRename = useCallback(async (targetPathOverride?: string) => {
    const root = rootRef.current
    const sourcePath = targetPathOverride ?? selectedPath
    if (!root || !sourcePath) return

    const node = findNode(tree, sourcePath)
    if (!node) return

    const name = await requestPrompt({
      title: t('projectEditor.dialog.rename.title'),
      message: t('projectEditor.dialog.rename.message'),
      defaultValue: getBaseName(sourcePath)
    })

    if (!name) return
    if (name.includes('/') || name.includes('\\')) {
      showStatus('error', t('projectEditor.error.nameHasSeparator'))
      return
    }

    const parentPath = getParentPath(sourcePath)
    const nextPath = joinPath(parentPath, name)

    if (nextPath === sourcePath) return

    const result = await window.electronAPI.project.renamePath(root, sourcePath, nextPath)
    if (!result.success) {
      showStatus('error', result.error || t('projectEditor.error.rename'))
      return
    }

    setSelectedPath(nextPath)

    if (activeFilePath) {
      if (activeFilePath === sourcePath) {
        setActiveFilePathValue(nextPath)
      } else if (activeFilePath.startsWith(`${sourcePath}/`)) {
        const replacedPath = activeFilePath.replace(sourcePath, nextPath)
        setActiveFilePathValue(replacedPath)
      }
    }
    replaceQuickFileEntries(sourcePath, nextPath)

    await refreshDirectory(parentPath)
    fileIndexRenameFile(root, sourcePath, nextPath)
    void window.electronAPI.project.invalidateFileIndex(root)
    showStatus('success', t('projectEditor.renameSuccess'))
  }, [activeFilePath, refreshDirectory, replaceQuickFileEntries, requestPrompt, selectedPath, setActiveFilePathValue, showStatus, t, tree])

  const handleDelete = useCallback(async (targetPathOverride?: string) => {
    const root = rootRef.current
    const targetPath = targetPathOverride ?? selectedPath
    if (!root || !targetPath) return

    const node = findNode(tree, targetPath)
    if (!node) return

    const confirmed = await requestConfirm({
      title: t('projectEditor.dialog.delete.title'),
      message: t('projectEditor.dialog.delete.message', {
        itemType: node.type === 'dir' ? t('projectEditor.itemType.folder') : t('projectEditor.itemType.file'),
        name: node.name,
      }),
      confirmText: t('common.delete'),
      cancelText: t('common.cancel')
    })

    if (!confirmed) return

    const result = await window.electronAPI.project.deletePath(root, targetPath)
    if (!result.success) {
      showStatus('error', result.error || t('projectEditor.error.delete'))
      return
    }

    if (activeFilePath) {
      if (activeFilePath === targetPath || activeFilePath.startsWith(`${targetPath}/`)) {
        setActiveFilePathValue(null)
        setFileContent('')
        fileContentRef.current = ''
        setOutlineContentSnapshot({ filePath: null, content: '' })
        setIsBinary(false)
        isBinaryRef.current = false
        setIsImage(false)
        isImageRef.current = false
	        setIsSqlite(false)
	        isSqliteRef.current = false
	        setIsPdf(false)
	        isPdfRef.current = false
	        setIsEpub(false)
	        isEpubRef.current = false
	        setIsHtml(false)
	        isHtmlRef.current = false
	        setImagePreviewUrl(null)
	        setPdfPreviewUrl(null)
	        setEpubPreviewUrl(null)
	        setHtmlPreviewUrl(null)
	        htmlPreviewUrlRef.current = null
	        setHtmlPreviewReloadKey(0)
	        htmlPreviewReloadKeyRef.current = 0
	        updateHtmlPreviewScrollState(null)
	        closeHtmlPreviewSearch()
	        updateHtmlReaderState(null)
        setIsDirty(false)
        originalContentRef.current = ''
        originalModelVersionRef.current = null
      }
    }
    removeQuickFileEntries(targetPath)

    const parentPath = getParentPath(targetPath)
    setSelectedPath(null)
    await refreshDirectory(parentPath)
    fileIndexRemoveFile(root, targetPath)
    void window.electronAPI.project.invalidateFileIndex(root)
    showStatus('success', t('projectEditor.deleteSuccess'))
  }, [activeFilePath, closeHtmlPreviewSearch, refreshDirectory, removeQuickFileEntries, requestConfirm, selectedPath, setActiveFilePathValue, showStatus, t, tree, updateHtmlPreviewScrollState, updateHtmlReaderState])

  const handleResizeMouseDown = useCallback((event: React.MouseEvent) => {
    if (isFileBrowserCollapsedRef.current) return
    event.preventDefault()
    isDraggingRef.current = true
    const startX = event.clientX
    const startWidth = fileTreeWidth

    const handleMouseMove = (e: MouseEvent) => {
      if (!isDraggingRef.current) return
      const delta = e.clientX - startX
      const newWidth = Math.max(MIN_FILE_TREE_WIDTH, Math.min(MAX_FILE_TREE_WIDTH, startWidth + delta))
      setFileTreeWidth(newWidth)
    }

    const handleMouseUp = () => {
      if (isDraggingRef.current) {
        isDraggingRef.current = false
        localStorage.setItem(STORAGE_KEY_FILE_TREE_WIDTH, String(fileTreeWidth))
      updateUIPreferences({ projectEditorFileTreeWidth: fileTreeWidth })
      }
      document.removeEventListener('mousemove', handleMouseMove)
      document.removeEventListener('mouseup', handleMouseUp)
      document.body.classList.remove('project-editor-resizing')
    }

    document.body.classList.add('project-editor-resizing')
    document.addEventListener('mousemove', handleMouseMove)
    document.addEventListener('mouseup', handleMouseUp)
  }, [fileTreeWidth])

  const handlePreviewResizeMouseDown = useCallback((event: React.MouseEvent) => {
    if (!isMarkdownPreviewVisible && !isHtmlPreviewVisible) return
    event.preventDefault()
    isPreviewDraggingRef.current = true

    const startX = event.clientX
    const startWidth = markdownPreviewWidthRef.current

    // Dynamically calculate the maximum width of the preview: container width - editor minimum reservation (120px) - outline occupation - resizer width
    const containerWidth = previewLayoutRef.current?.clientWidth ?? 0
    const outlineOccupied = outlineShowInSplit ? (outlineWidthRef.current + 6) : 0
    const maxPreviewWidth = Math.max(MIN_MARKDOWN_PREVIEW_WIDTH, containerWidth - 120 - outlineOccupied - 6)

    const handleMouseMove = (e: MouseEvent) => {
      if (!isPreviewDraggingRef.current) return
      const delta = startX - e.clientX  // Drag left → Preview becomes wider
      const nextWidth = Math.min(maxPreviewWidth, Math.max(MIN_MARKDOWN_PREVIEW_WIDTH, startWidth + delta))
      setMarkdownPreviewWidth(nextWidth)
    }

    const handleMouseUp = () => {
      if (isPreviewDraggingRef.current) {
        isPreviewDraggingRef.current = false
        localStorage.setItem(
          STORAGE_KEY_MARKDOWN_PREVIEW_WIDTH,
          String(markdownPreviewWidthRef.current)
        )
        updateUIPreferences({ projectEditorMarkdownPreviewWidth: markdownPreviewWidthRef.current })
      }
      document.removeEventListener('mousemove', handleMouseMove)
      document.removeEventListener('mouseup', handleMouseUp)
      document.body.classList.remove('project-editor-preview-resizing')
    }

    document.body.classList.add('project-editor-preview-resizing')
    document.addEventListener('mousemove', handleMouseMove)
    document.addEventListener('mouseup', handleMouseUp)
  }, [isHtmlPreviewVisible, isMarkdownPreviewVisible, outlineShowInSplit])

  const handleOutlineResizeMouseDown = useCallback((event: React.MouseEvent) => {
    if (!outlineShowInSplit) return
    event.preventDefault()
    isOutlineDraggingRef.current = true

    const startX = event.clientX
    const startWidth = outlineWidthRef.current
    // Fallback to the parent's width if previewLayoutRef isn't wired yet on
    // this render path. Without a fallback, containerWidth = 0 caps
    // maxOutlineWidth at MIN_OUTLINE_WIDTH and the user can only shrink the
    // pane, never widen it back.
    const resizerEl = event.currentTarget as HTMLElement
    const parentWidth = (resizerEl.parentElement as HTMLElement | null)?.clientWidth ?? 0
    const containerWidth = previewLayoutRef.current?.clientWidth || parentWidth
    // Outline now lives on the right for every file type, so the resizer is
    // always to the LEFT of the outline pane — drag left widens, drag right
    // narrows.
    const direction = -1
    const previewOccupied = isMarkdownPreviewVisible && isMarkdownEditorVisibleRef.current
      ? (markdownPreviewWidthRef.current + 6)
      : 0
    const editorReservation = isMarkdownFile && !isMarkdownEditorVisibleRef.current ? 0 : 120
    const maxOutlineWidth = Math.max(MIN_OUTLINE_WIDTH, containerWidth - editorReservation - previewOccupied - 6)

    const handleMouseMove = (e: MouseEvent) => {
      if (!isOutlineDraggingRef.current) return
      const delta = (e.clientX - startX) * direction
      const nextWidth = Math.min(maxOutlineWidth, Math.max(MIN_OUTLINE_WIDTH, startWidth + delta))
      setOutlineWidth(nextWidth)
    }

    const handleMouseUp = () => {
      if (isOutlineDraggingRef.current) {
        isOutlineDraggingRef.current = false
        localStorage.setItem(STORAGE_KEY_OUTLINE_WIDTH, String(outlineWidthRef.current))
        updateUIPreferences({ projectEditorOutlineWidth: outlineWidthRef.current })
      }
      document.removeEventListener('mousemove', handleMouseMove)
      document.removeEventListener('mouseup', handleMouseUp)
      document.body.classList.remove('project-editor-outline-resizing')
    }

    document.body.classList.add('project-editor-outline-resizing')
    document.addEventListener('mousemove', handleMouseMove)
    document.addEventListener('mouseup', handleMouseUp)
  }, [isMarkdownFile, isMarkdownPreviewVisible, outlineShowInSplit])

  const handleModalResizeMouseDown = useCallback((event: React.MouseEvent, direction: string) => {
    if (isPanel) return
    event.preventDefault()
    event.stopPropagation()
    isResizingModalRef.current = true
    resizeDirectionRef.current = direction

    const startX = event.clientX
    const startY = event.clientY
    const startWidth = modalSize.width
    const startHeight = modalSize.height

    const maxWidth = window.innerWidth * MAX_MODAL_WIDTH_PERCENT / 100
    const maxHeight = window.innerHeight * MAX_MODAL_HEIGHT_PERCENT / 100

    const handleMouseMove = (e: MouseEvent) => {
      if (!isResizingModalRef.current) return

      let newWidth = startWidth
      let newHeight = startHeight
      const dir = resizeDirectionRef.current

      if (dir.includes('e')) {
        newWidth = Math.max(MIN_MODAL_WIDTH, Math.min(maxWidth, startWidth + (e.clientX - startX) * 2))
      } else if (dir.includes('w')) {
        newWidth = Math.max(MIN_MODAL_WIDTH, Math.min(maxWidth, startWidth - (e.clientX - startX) * 2))
      }

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
        localStorage.setItem(STORAGE_KEY_MODAL_SIZE, JSON.stringify(modalSizeRef.current))
        updateUIPreferences({ projectEditorModalSize: modalSizeRef.current })
      }
      document.removeEventListener('mousemove', handleMouseMove)
      document.removeEventListener('mouseup', handleMouseUp)
      document.body.classList.remove('project-editor-modal-resizing')
    }

    document.body.classList.add('project-editor-modal-resizing')
    document.addEventListener('mousemove', handleMouseMove)
    document.addEventListener('mouseup', handleMouseUp)
  }, [isPanel, modalSize, updateUIPreferences])

  const editorPath = useMemo(() => {
    if (!activeFilePath) return undefined
    if (!rootRef.current) return activeFilePath
    return `${rootRef.current.replace(/\\/g, '/')}/${activeFilePath}`
  }, [activeFilePath])

  const rootLabel = useMemo(() => {
    if (!rootPath) return t('projectEditor.rootDirectory')
    const parts = rootPath.split(/[\\/]/).filter(Boolean)
    return parts[parts.length - 1] || rootPath
  }, [rootPath, t])

  const modalStyle = useMemo(() => ({
    width: isPanel ? '100%' : modalSize.width,
    height: isPanel ? '100%' : modalSize.height,
    ['--project-editor-font-size' as string]: `${editorFontSize}px`
  }), [editorFontSize, isPanel, modalSize.height, modalSize.width])

  const resolveSetiFileIcon = useMemo(
    () => createThemedSetiFileIconResolver(settings?.theme),
    [settings?.theme]
  )

  const renderTree = useCallback((nodes: TreeNode[], depth = 0) => {
    return nodes.map((node) => {
      const isSelected = selectedPath === node.path
      const itemClass = `project-editor-tree-item ${isSelected ? 'selected' : ''}`
      const setiFile = node.type === 'file' ? resolveSetiFileIcon(node.name) : null

      return (
        <div key={node.path}>
          <div
            className={itemClass}
            data-path={node.path}
            style={{ paddingLeft: `${12 + depth * 14}px` }}
            onContextMenu={(event) => openContextMenu(event, {
              path: node.path,
              type: node.type,
              select: true
            })}
            onClick={() => {
              if (node.type === 'dir') {
                void toggleDirectory(node)
              } else {
                setSelectedPath(node.path)
                void openFile(node.path, 'user', {
                  trackRecent: true,
                  suppressFileBrowserReveal: true
                })
              }
            }}
          >
            <div className="project-editor-tree-main">
              {node.type === 'dir' ? (
                <span className={`project-editor-tree-toggle ${node.isExpanded ? 'open' : ''}`}>
                  <svg viewBox="0 0 10 10" fill="currentColor" aria-hidden={true}>
                    <path d="M2 3.5L5 6.5L8 3.5" stroke="currentColor" strokeWidth="1.5" fill="none" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                </span>
              ) : (
                <span className="project-editor-tree-spacer" />
              )}
              {node.type === 'dir' ? (
                <span className="project-editor-tree-icon dir">
                  <svg viewBox="0 0 16 16" fill="currentColor" aria-hidden={true}>
                    <path d="M1.75 3a.75.75 0 0 0-.75.75v8.5c0 .414.336.75.75.75h12.5a.75.75 0 0 0 .75-.75V5.5a.75.75 0 0 0-.75-.75H7.5a.75.75 0 0 1-.53-.22l-.97-.97A.75.75 0 0 0 5.47 3H1.75Z" />
                  </svg>
                </span>
              ) : (
                <span
                  className="project-editor-tree-icon file project-editor-tree-seti-icon"
                  style={{ color: setiFile!.color }}
                  // eslint-disable-next-line react/no-danger -- SVG from MIT seti-icons (VS Code Seti family); sanitized with DOMPurify
                  dangerouslySetInnerHTML={{ __html: sanitizeSetiSvgOnce(setiFile!.svg) }}
                />
              )}
              <span className="project-editor-tree-name" title={node.name}>{node.name}</span>
              {node.isLoading && <span className="project-editor-tree-loading">{t('projectEditor.loading')}</span>}
            </div>
          </div>
          {node.type === 'dir' && node.isExpanded && node.children && renderTree(node.children, depth + 1)}
        </div>
      )
    })
  }, [openContextMenu, openFile, resolveSetiFileIcon, selectedPath, setSelectedPath, t, toggleDirectory])

  const treeNodes = useMemo(() => {
    if (tree.length === 0) {
      return <div className="project-editor-empty">{t('projectEditor.empty.noFiles')}</div>
    }
    return renderTree(tree)
  }, [renderTree, t, tree])

  const keepMountedInPanel = isPanel
  const editorStatusMeta = useMemo(() => (
    statusMessage || (markdownRenderPending && isMarkdownPreviewVisible)
      ? (
        <div className="project-editor-status-group">
          {markdownRenderPending && isMarkdownPreviewVisible && (
            <span className="project-editor-status pending">{t('projectEditor.rendering')}</span>
          )}
          {statusMessage && (
            <span className={`project-editor-status ${statusMessage.type}`}>
              {statusMessage.text}
            </span>
          )}
        </div>
      )
      : null
  ), [isMarkdownPreviewVisible, markdownRenderPending, statusMessage, t])
  const externalPanelActions = useMemo(() => (
    <>
      <SubpagePanelButton
        className="project-editor-save"
        onClick={() => void handleSaveRef.current('toolbar')}
        disabled={!activeFilePath || !isDirty || isBinary || isImage || isSqlite || Boolean(largeFileState)}
      >
        {t('common.save')}
      </SubpagePanelButton>
      <SubpagePanelButton
        className="project-editor-secondary"
        onClick={() => void handleRequestClose()}
        title={t('projectEditor.returnToTerminal')}
      >
        {t('projectEditor.returnToTerminal')}
      </SubpagePanelButton>
    </>
  ), [activeFilePath, handleRequestClose, isBinary, isDirty, isImage, isSqlite, largeFileState, t])
  const externalPanelShellState = useMemo<SubpagePanelShellState>(() => ({
    current: 'editor',
    onSelect: handleSelectSubpage,
    lifecycle: {
      beforeLeave: ({ command }) => {
        const scope = lastEditorScopeRef.current
        const snapshotKind: ProjectEditorSoftCloseKind = command.target ? 'subpage-return' : 'retained-close'
        const shouldCaptureSoftClose = command.target !== null || shouldRetainProjectEditorViewOnClose({
          hasActiveFile: Boolean(activeFilePathRef.current),
          hasRootPath: Boolean(rootRef.current),
          hasUnsavedChanges: dirtyRef.current,
          hasMissingFileNotice: Boolean(missingFileNoticeRef.current)
        })
        const scopeSnapshot = editorSoftCloseSnapshotsRef.current.peek(getScrollScopeKey(scope))
        let softCloseSnapshot = isProjectEditorSoftCloseSnapshotForScope(
          scopeSnapshot,
          scope,
          snapshotKind
        )
          ? scopeSnapshot
          : null
        if (!softCloseSnapshot && scope && shouldCaptureSoftClose) {
          capturePreviewScrollMemory()
          // Fire-and-forget: beforeLeave is sync; the offset lands in
          // fileMemoryRef for the next persist (2s poll is the backstop).
          void captureHtmlPreviewScrollMemory('before-leave')
          captureMarkdownSessionCacheRef.current('subpage-before-leave')
          persistProjectEditorState(scope, { flush: true })
          softCloseSnapshot = captureEditorSoftCloseSnapshot(snapshotKind, scope)
        } else if (!shouldCaptureSoftClose) {
          editorSoftCloseSnapshotsRef.current.delete(getScrollScopeKey(scope))
        }
        return {
          subpage: 'editor',
          activeFilePath: softCloseSnapshot?.path ?? activeFilePathRef.current,
          markdownPreviewOpen: softCloseSnapshot?.isMarkdownPreviewOpen ?? isMarkdownPreviewOpenRef.current,
          markdownEditorVisible: softCloseSnapshot?.isMarkdownEditorVisible ?? isMarkdownEditorVisibleRef.current,
          markdownRenderedHtmlLength: markdownRenderedHtmlRef.current.length,
          previewRestorePhase: previewRestorePhaseRef.current,
          scrollTop: previewRef.current?.scrollTop ?? editorRef.current?.getScrollTop() ?? null
        }
      },
      afterEnter: () => {
        if (
          activeFilePathRef.current &&
          isMarkdownPath(activeFilePathRef.current) &&
          isMarkdownPreviewOpenRef.current &&
          !isBinaryRef.current &&
          !isImageRef.current &&
          !isSqliteRef.current &&
          markdownRenderedHtmlRef.current
        ) {
          setIsMarkdownRenderEnabled(true)
          resetPreviewRestoreState()
        }
      }
    },
    workingDirectoryLabel: t('projectEditor.workingDirectory'),
    workingDirectoryPath: rootPath || null,
    workingDirectoryTitle: cwdTitle,
    onWorkingDirectoryDoubleClick: handleCwdDblClick,
    workingDirectoryFeedback: cwdFeedback,
    metaExtra: editorStatusMeta,
    actions: externalPanelActions,
    taskTitle
  }), [
    captureEditorSoftCloseSnapshot,
    capturePreviewScrollMemory,
    cwdFeedback,
    cwdTitle,
    editorStatusMeta,
    externalPanelActions,
    handleCwdDblClick,
    handleSelectSubpage,
    persistProjectEditorState,
    resetPreviewRestoreState,
    rootPath,
    t,
    taskTitle
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

  const largeFileRangeLabel = useMemo(() => {
    if (!largeFileState || largeFileState.bytesRead <= 0) return null
    return t('projectEditor.largeFile.range', {
      start: largeFileState.offset + 1,
      end: largeFileState.offset + largeFileState.bytesRead,
      total: formatFileSize(largeFileState.sizeBytes)
    })
  }, [largeFileState, t])

  const binaryDump = useMemo(() => {
    if (!largeFileState || largeFileState.mode !== 'binary') return ''
    if (largeFileState.binaryBytes.length === 0) return ''
    return hexy(Array.from(largeFileState.binaryBytes), {
      bytesPerLine: BINARY_VIEWER_BYTES_PER_LINE,
      bytesPerGroup: 1,
      showAddress: true,
      displayOffset: largeFileState.offset,
      annotate: 'ascii',
      radix: binaryRadix,
      caps: 'upper'
    })
  }, [binaryRadix, largeFileState])

  if (!isOpen && !keepMountedInPanel) return null

  return (
    <div
      className={`project-editor-overlay ${isPanel ? 'panel' : ''} ${isOpen ? 'is-open' : 'is-hidden'}`}
      aria-hidden={!isOpen}
      onClick={() => {
        if (!isPanel) {
          void handleRequestClose()
        }
      }}
    >
      <div
        className="project-editor-modal"
        ref={modalRef}
        style={modalStyle}
        onClick={(event) => event.stopPropagation()}
      >
        {!isPanel && (
          <>
            <div className="project-editor-modal-resize-n" onMouseDown={(e) => handleModalResizeMouseDown(e, 'n')} />
            <div className="project-editor-modal-resize-s" onMouseDown={(e) => handleModalResizeMouseDown(e, 's')} />
            <div className="project-editor-modal-resize-e" onMouseDown={(e) => handleModalResizeMouseDown(e, 'e')} />
            <div className="project-editor-modal-resize-w" onMouseDown={(e) => handleModalResizeMouseDown(e, 'w')} />
            <div className="project-editor-modal-resize-ne" onMouseDown={(e) => handleModalResizeMouseDown(e, 'ne')} />
            <div className="project-editor-modal-resize-nw" onMouseDown={(e) => handleModalResizeMouseDown(e, 'nw')} />
            <div className="project-editor-modal-resize-se" onMouseDown={(e) => handleModalResizeMouseDown(e, 'se')} />
            <div className="project-editor-modal-resize-sw" onMouseDown={(e) => handleModalResizeMouseDown(e, 'sw')} />
          </>
        )}

        {useSharedPanelHeader ? (
          <SubpagePanelShell
            current="editor"
            onSelect={handleSelectSubpage}
            workingDirectoryLabel={t('projectEditor.workingDirectory')}
            workingDirectoryPath={rootPath || null}
            workingDirectoryTitle={cwdTitle}
            onWorkingDirectoryDoubleClick={handleCwdDblClick}
            workingDirectoryFeedback={cwdFeedback}
            metaExtra={editorStatusMeta}
            taskTitle={taskTitle}
            actions={(
              <>
                <SubpagePanelButton
                  className="project-editor-save"
                  onClick={() => void handleSaveRef.current('toolbar')}
                  disabled={!activeFilePath || !isDirty || isBinary || isImage || isSqlite || Boolean(largeFileState)}
                >
                  {t('common.save')}
                </SubpagePanelButton>
                <SubpagePanelButton
                  className="project-editor-secondary"
                  onClick={() => void handleRequestClose()}
                  title={t('projectEditor.returnToTerminal')}
                >
                  {t('projectEditor.returnToTerminal')}
                </SubpagePanelButton>
              </>
            )}
          />
        ) : panelShellMode === 'external' && isPanel ? null : (
          <>
            <div className="project-editor-header">
              <div className="project-editor-header-main">
                <div className="project-editor-title">
                  <span className="project-editor-title-main">{t('projectEditor.title')}</span>
                  {taskTitle ? (
                    <span className="project-editor-task-label subpage-task-source" title={taskTitle}>
                      <span className="subpage-task-source-name">{taskTitle}</span>
                    </span>
                  ) : null}
                </div>
                <SubpageSwitcher current="editor" onSelect={handleSelectSubpage} />
              </div>
              <div className="project-editor-header-actions">
                <SubpagePanelButton
                  className="project-editor-save"
                  onClick={() => void handleSaveRef.current('toolbar')}
                  disabled={!activeFilePath || !isDirty || isBinary || isImage || isSqlite || Boolean(largeFileState)}
                >
                  {t('common.save')}
                </SubpagePanelButton>
                <SubpagePanelButton
                  className="project-editor-secondary"
                  onClick={() => void handleRequestClose()}
                  title={t('projectEditor.returnToTerminal')}
                >
                  {t('projectEditor.returnToTerminal')}
                </SubpagePanelButton>
              </div>
            </div>

            <div className="project-editor-root">
              <span
                className="project-editor-root-label"
                onDoubleClick={handleCwdDblClick}
                title={t('common.cwdCopyHint')}
              >
                {t('projectEditor.workingDirectory')}
              </span>
              <span
                className="project-editor-root-path"
                onDoubleClick={handleCwdDblClick}
                title={cwdTitle ?? ''}
              >
                {rootPath || '-'}
              </span>
              {cwdFeedback}
              {editorStatusMeta}
            </div>
          </>
        )}

        <div className="project-editor-body">
          <div
            className={`project-editor-sidebar${isFileBrowserCollapsed ? ' collapsed' : ''}`}
            style={isFileBrowserCollapsed ? undefined : { width: fileTreeWidth }}
          >
            {isFileBrowserCollapsed ? (
              <button
                type="button"
                className="project-editor-sidebar-restore-btn"
                title={t('projectEditor.expandFileBrowser')}
                aria-label={t('projectEditor.expandFileBrowser')}
                onClick={() => setFileBrowserCollapsedState(false)}
              >
                <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
                  <path d="M1.5 2A1.5 1.5 0 0 0 0 3.5v9A1.5 1.5 0 0 0 1.5 14h13a1.5 1.5 0 0 0 1.5-1.5V5.5A1.5 1.5 0 0 0 14.5 4H7.71L6.85 2.57A1.5 1.5 0 0 0 5.57 2H1.5zM1 3.5a.5.5 0 0 1 .5-.5h4.07a.5.5 0 0 1 .43.24l.86 1.43a.5.5 0 0 0 .43.24H14.5a.5.5 0 0 1 .5.5v7a.5.5 0 0 1-.5.5h-13a.5.5 0 0 1-.5-.5v-9z" />
                  <path d="M6.65 5.15 9.5 8l-2.85 2.85.7.7L10.91 8 7.35 4.45l-.7.7Z" />
                </svg>
              </button>
            ) : (
              <>
            <div className="project-editor-sidebar-mode-bar">
              <button
                className={`pe-mode-btn ${sidebarMode === 'files' ? 'active' : ''}`}
                onClick={() => setSidebarMode('files')}
                title={t('projectEditor.sidebarFilesTooltip')}
              >
                <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
                  <path d="M1.5 2A1.5 1.5 0 0 0 0 3.5v9A1.5 1.5 0 0 0 1.5 14h13a1.5 1.5 0 0 0 1.5-1.5V5.5A1.5 1.5 0 0 0 14.5 4H7.71L6.85 2.57A1.5 1.5 0 0 0 5.57 2H1.5zM1 3.5a.5.5 0 0 1 .5-.5h4.07a.5.5 0 0 1 .43.24l.86 1.43a.5.5 0 0 0 .43.24H14.5a.5.5 0 0 1 .5.5v7a.5.5 0 0 1-.5.5h-13a.5.5 0 0 1-.5-.5v-9z" />
                </svg>
                <span>{t('projectEditor.sidebarFiles')}</span>
              </button>
              <button
                className={`pe-mode-btn ${sidebarMode === 'search' ? 'active' : ''}`}
                onClick={() => {
                  setInitialSearchType('content')
                  setSidebarMode('search')
                  setTimeout(() => globalSearchInputRef.current?.focus(), 0)
                }}
                title={t('projectEditor.sidebarSearchTooltip', {
                  key: `${window.electronAPI.platform === 'darwin' ? '⌘' : 'Ctrl'}+Shift+F`
                })}
              >
                <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
                  <path d="M11.742 10.344a6.5 6.5 0 1 0-1.397 1.398h-.001l3.85 3.85a1 1 0 0 0 1.415-1.414l-3.85-3.85zm-5.44 1.16a5.5 5.5 0 1 1 0-11 5.5 5.5 0 0 1 0 11z" />
                </svg>
                <span>{t('projectEditor.sidebarSearch')}</span>
              </button>
              <button
                type="button"
                className="project-editor-sidebar-collapse-btn"
                title={t('projectEditor.collapseFileBrowser')}
                aria-label={t('projectEditor.collapseFileBrowser')}
                onClick={() => setFileBrowserCollapsedState(true)}
              >
                <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
                  <path d="M9.35 4.45 5.79 8l3.56 3.55.7-.7L7.2 8l2.85-2.85-.7-.7Z" />
                </svg>
              </button>
            </div>
            {sidebarMode === 'files' ? (
              <>
                <div className="project-editor-sidebar-header">
                  <span className="project-editor-sidebar-title">{t('projectEditor.fileBrowser')}</span>
                  <button
                    type="button"
                    className="project-editor-sidebar-action-btn"
                    onClick={handleLocateCurrentFile}
                    disabled={!activeFilePath}
                    title={t('projectEditor.locateCurrentFile')}
                    aria-label={t('projectEditor.locateCurrentFile')}
                  >
                    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden={true}>
                      <circle cx="8" cy="8" r="3.25" stroke="currentColor" strokeWidth="1.4" />
                      <circle cx="8" cy="8" r="1" fill="currentColor" />
                      <path
                        d="M8 1.5v2.25M8 12.25v2.25M1.5 8h2.25M12.25 8h2.25"
                        stroke="currentColor"
                        strokeWidth="1.4"
                        strokeLinecap="round"
                      />
                    </svg>
                  </button>
                </div>
                <div
                  className="project-editor-tree"
                  ref={fileTreeContainerRef}
                  onScroll={handleFileTreeScroll}
                  onContextMenu={(event) => openContextMenu(event, { path: null, type: null })}
                >
                  {rootError ? (
                    <div className="project-editor-empty">
                      <p>{rootError}</p>
                      <button className="project-editor-action-btn" onClick={() => rootPath && void loadRoot(rootPath)}>
                        {t('projectEditor.reload')}
                      </button>
                    </div>
                  ) : (
                    <>
                      <div
                        className="project-editor-tree-root"
                        onContextMenu={(event) => openContextMenu(event, { path: '', type: 'dir' })}
                      >
                        <div className="project-editor-tree-root-label" title={rootPath || ''}>{rootLabel}</div>
                      </div>
                      {treeNodes}
                    </>
                  )}
                </div>
              </>
            ) : (
              <SearchPanel
                rootPath={rootPath}
                isActive={sidebarMode === 'search' && isOpen}
                initialSearchType={initialSearchType}
                onNavigate={handleSearchNavigate}
                onOpenFile={(filePath) => void openFile(filePath, 'user', { trackRecent: true })}
                onClose={() => setSidebarMode('files')}
                buildFileIndex={buildFileIndex}
                getFileIndex={getFileIndex}
                searchInputRef={globalSearchInputRef}
              />
            )}
            <div className="project-editor-file-tree-resizer" onMouseDown={handleResizeMouseDown} />
              </>
            )}
          </div>

          <div className="project-editor-editor">
            <div className="project-editor-quick-access">
              <div className="project-editor-quick-row pin">
                <div className="project-editor-quick-row-header">
                  <div className="project-editor-quick-row-title">
                    <span className="project-editor-quick-row-icon pin-icon" aria-hidden="true">
                      <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
                        <path d="M9.828 1.282a1 1 0 0 1 1.415 0l3.475 3.475a1 1 0 0 1 0 1.414l-3.18 3.18a.5.5 0 0 1-.353.147H8.83L6.354 11.97a.5.5 0 0 1-.708 0L4.03 10.354a.5.5 0 0 1 0-.708L6.5 7.17V4.815a.5.5 0 0 1 .146-.353l3.182-3.18ZM7.5 5v2.5a.5.5 0 0 1-.146.354L5.09 10.118l.793.793 2.263-2.264A.5.5 0 0 1 8.5 8.5H11l2.768-2.768L10.293 2.26 7.5 5Z" />
                        <path d="M1.5 14.5a.5.5 0 0 1 0-.707l3-3a.5.5 0 0 1 .707.707l-3 3a.5.5 0 0 1-.707 0Z" />
                      </svg>
                    </span>
                    <span>{t('projectEditor.pinnedFiles')}</span>
                  </div>
                </div>
                <div
                  className="project-editor-quick-list"
                  onDragOver={handlePinnedListDragOver}
                  onDrop={handlePinnedListDrop}
                >
                  <div ref={pinnedMeasureRef} className="quick-file-measure" aria-hidden="true">
                    {pinnedFiles.map((path, index) => (
                      <Fragment key={path}>
                        {index > 0 && <span className="quick-file-measure-sep">·</span>}
                        <span className="quick-file-measure-item" data-idx={index}>
                          {quickFileLabels[path] ?? getBaseName(path)}
                        </span>
                      </Fragment>
                    ))}
                  </div>
                  {pinnedFiles.length === 0 ? (
                    <span className="project-editor-quick-empty">{t('projectEditor.empty.noPinnedFiles')}</span>
                  ) : (
                    <>
                      {visiblePinnedFiles.map((path, index) => {
                        const label = quickFileLabels[path] ?? getBaseName(path)
                        const cls = [
                          'project-editor-quick-item',
                          activeFilePath === path ? 'active' : '',
                          draggingPinnedPath === path ? 'dragging' : '',
                          dragOverPinnedPath === path ? 'drag-over' : ''
                        ].filter(Boolean).join(' ')
                        return (
                          <Fragment key={`pin:${path}`}>
                            {index > 0 && <span className="quick-file-separator" aria-hidden="true">·</span>}
                            <button
                              className={cls}
                              draggable
                              onClick={() => void openFile(path, 'user', { trackRecent: true })}
                              onContextMenu={(event) => openContextMenu(event, {
                                path,
                                type: 'file',
                                source: 'quick-pin'
                              })}
                              onMouseEnter={(e) => handleQuickTooltipEnter(e, path)}
                              onMouseLeave={handleQuickTooltipLeave}
                              onDragStart={(event) => handlePinnedDragStart(event, path)}
                              onDragOver={(event) => handlePinnedDragOver(event, path)}
                              onDrop={(event) => handlePinnedDrop(event, path)}
                              onDragEnd={handlePinnedDragEnd}
                            >
                              {label}
                            </button>
                          </Fragment>
                        )
                      })}
                      {overflowPinnedFiles.length > 0 && (
                        <>
                          {visiblePinnedFiles.length > 0 && <span className="quick-file-separator" aria-hidden="true">·</span>}
                          <button
                            ref={pinOverflowBtnRef}
                            className={`quick-file-overflow-btn${overflowPinnedFiles.some(p => p === activeFilePath) ? ' has-active' : ''}`}
                            onClick={() => setPinOverflowOpen(prev => !prev)}
                            title={t('projectEditor.moreFiles', { count: overflowPinnedFiles.length })}
                            aria-expanded={pinOverflowOpen}
                            aria-haspopup="true"
                          >
                            +{overflowPinnedFiles.length}
                          </button>
                        </>
                      )}
                    </>
                  )}
                </div>
                {pinOverflowOpen && createPortal(
                  <div
                    ref={pinDropdownRef}
                    className="quick-file-overflow-dropdown"
                    style={computeDropdownPos(pinOverflowBtnRef)}
                  >
                    {overflowPinnedFiles.map((path) => {
                      const label = quickFileLabels[path] ?? getBaseName(path)
                      return (
                        <button
                          key={path}
                          className={`quick-file-overflow-item${activeFilePath === path ? ' active' : ''}`}
                          draggable
                          onClick={() => { setPinOverflowOpen(false); void openFile(path, 'user', { trackRecent: true }) }}
                          onContextMenu={(event) => { setPinOverflowOpen(false); openContextMenu(event, { path, type: 'file', source: 'quick-pin' }) }}
                          onDragStart={(event) => handleOverflowPinDragStart(event, path)}
                          onMouseEnter={(e) => handleQuickTooltipEnter(e, path)}
                          onMouseLeave={handleQuickTooltipLeave}
                        >
                          {label}
                        </button>
                      )
                    })}
                  </div>,
                  document.body
                )}
              </div>

              <div className="project-editor-quick-row recent">
                <div className="project-editor-quick-row-header">
                  <div className="project-editor-quick-row-title">
                    <span className="project-editor-quick-row-icon recent-icon" aria-hidden="true">
                      <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
                        <path d="M8 3.5a4.5 4.5 0 1 0 0 9 4.5 4.5 0 0 0 0-9ZM2.5 8a5.5 5.5 0 1 1 11 0 5.5 5.5 0 0 1-11 0Z" />
                        <path d="M8 5a.5.5 0 0 1 .5.5V8l2.15 1.07a.5.5 0 0 1-.45.9l-2.4-1.2A.5.5 0 0 1 7.5 8.3V5.5A.5.5 0 0 1 8 5Z" />
                        <path d="M2.854 3.646a.5.5 0 0 1 0 .708L1.707 5.5H3.5a.5.5 0 0 1 0 1H.5a.5.5 0 0 1-.5-.5v-3a.5.5 0 0 1 1 0v1.793l1.146-1.147a.5.5 0 0 1 .708 0Z" />
                      </svg>
                    </span>
                    <span>{t('projectEditor.recentFiles')}</span>
                  </div>
                  <button
                    className="project-editor-quick-row-action"
                    disabled={recentFiles.length === 0}
                    onClick={clearRecentFiles}
                  >
                    {t('projectEditor.clearAll')}
                  </button>
                </div>
                <div className="project-editor-quick-list">
                  <div ref={recentMeasureRef} className="quick-file-measure" aria-hidden="true">
                    {recentFiles.map((path, index) => (
                      <Fragment key={path}>
                        {index > 0 && <span className="quick-file-measure-sep">·</span>}
                        <span className="quick-file-measure-item" data-idx={index}>
                          {quickFileLabels[path] ?? getBaseName(path)}
                        </span>
                      </Fragment>
                    ))}
                  </div>
                  {recentFiles.length === 0 ? (
                    <span className="project-editor-quick-empty">{t('projectEditor.empty.noRecentFiles')}</span>
                  ) : (
                    <>
                      {visibleRecentFiles.map((path, index) => {
                        const label = quickFileLabels[path] ?? getBaseName(path)
                        const cls = [
                          'project-editor-quick-item',
                          activeFilePath === path ? 'active' : ''
                        ].filter(Boolean).join(' ')
                        return (
                          <Fragment key={`recent:${path}`}>
                            {index > 0 && <span className="quick-file-separator" aria-hidden="true">·</span>}
                            <button
                              className={cls}
                              draggable
                              onClick={() => void openFile(path, 'user', { trackRecent: true })}
                              onContextMenu={(event) => openContextMenu(event, {
                                path,
                                type: 'file',
                                source: 'quick-recent'
                              })}
                              onMouseEnter={(e) => handleQuickTooltipEnter(e, path)}
                              onMouseLeave={handleQuickTooltipLeave}
                              onDragStart={(event) => handleRecentDragStart(event, path)}
                              onDragEnd={handlePinnedDragEnd}
                            >
                              {label}
                            </button>
                          </Fragment>
                        )
                      })}
                      {overflowRecentFiles.length > 0 && (
                        <>
                          {visibleRecentFiles.length > 0 && <span className="quick-file-separator" aria-hidden="true">·</span>}
                          <button
                            ref={recentOverflowBtnRef}
                            className={`quick-file-overflow-btn${overflowRecentFiles.some(p => p === activeFilePath) ? ' has-active' : ''}`}
                            onClick={() => setRecentOverflowOpen(prev => !prev)}
                            title={t('projectEditor.moreFiles', { count: overflowRecentFiles.length })}
                            aria-expanded={recentOverflowOpen}
                            aria-haspopup="true"
                          >
                            +{overflowRecentFiles.length}
                          </button>
                        </>
                      )}
                    </>
                  )}
                </div>
                {recentOverflowOpen && createPortal(
                  <div
                    ref={recentDropdownRef}
                    className="quick-file-overflow-dropdown"
                    style={computeDropdownPos(recentOverflowBtnRef)}
                  >
                    {overflowRecentFiles.map((path) => {
                      const label = quickFileLabels[path] ?? getBaseName(path)
                      return (
                        <button
                          key={path}
                          className={`quick-file-overflow-item${activeFilePath === path ? ' active' : ''}`}
                          draggable
                          onClick={() => { setRecentOverflowOpen(false); void openFile(path, 'user', { trackRecent: true }) }}
                          onContextMenu={(event) => { setRecentOverflowOpen(false); openContextMenu(event, { path, type: 'file', source: 'quick-recent' }) }}
                          onDragStart={(event) => { handleRecentDragStart(event, path); requestAnimationFrame(() => setRecentOverflowOpen(false)) }}
                          onMouseEnter={(e) => handleQuickTooltipEnter(e, path)}
                          onMouseLeave={handleQuickTooltipLeave}
                        >
                          {label}
                        </button>
                      )
                    })}
                  </div>,
                  document.body
                )}
              </div>
            </div>

            <div className="project-editor-editor-header">
              <div className="project-editor-editor-title">
                {activeFilePath ? (
                  <>
                    <span
                      className={`project-editor-editor-filename ${isDirty ? 'dirty' : ''}`}
                      onDoubleClick={handleFilenameDblClick}
                      title={t('projectEditor.filenameCopyHint')}
                    >
                      {activeFilePath}
                    </span>
                    {isDirty && <span className="project-editor-editor-dirty">{t('projectEditor.unsaved')}</span>}
                  </>
                ) : (
                  <span className="project-editor-editor-placeholder">{t('projectEditor.selectFile')}</span>
                )}
                {pathCopyMessage && (
                  <span className={`path-copy-toast ${pathCopyMessage.type}`}>
                    {pathCopyMessage.text}
                  </span>
                )}
              </div>
              <div className="project-editor-editor-controls">
                <div className="project-editor-editor-meta">
                  {isLoadingFile && (
                    <span className="project-editor-editor-loading">
                      {t('projectEditor.loading')}
                      <span className="preview-loading-dots mini"><span /><span /><span /></span>
                    </span>
                  )}
                  {largeFileState?.loading && (
                    <span className="project-editor-editor-loading">
                      {t('projectEditor.largeFile.loadingChunk')}
                      <span className="preview-loading-dots mini"><span /><span /><span /></span>
                    </span>
                  )}
                  {largeFileState && (
                    <span className="project-editor-editor-binary">
                      {largeFileState.mode === 'binary'
                        ? t('projectEditor.binaryViewer.readOnlyBadge')
                        : t('projectEditor.largeFile.readOnlyBadge')}
                    </span>
                  )}
                  {isImage && <span className="project-editor-editor-binary">{t('projectEditor.imagePreview')}</span>}
                  {isSqlite && <span className="project-editor-editor-binary">{t('projectEditor.sqliteView')}</span>}
                  {isHtmlFile && !isImage && !isSqlite && !isBinary && <span className="project-editor-editor-binary">{t('projectEditor.htmlPreview')}</span>}
                  {!largeFileState && !isImage && !isSqlite && isBinary && <span className="project-editor-editor-binary">{t('projectEditor.binaryReadonly')}</span>}
                </div>
                {activeFilePath && isSourcePreviewFile && !isBinary && !isImage && !isSqlite && (
                  <button
                    className="project-editor-action-btn project-editor-preview-toggle"
                    onClick={() => {
                      setMarkdownPreviewOpenState(!isMarkdownPreviewOpenRef.current)
                    }}
                  >
                    {isMarkdownPreviewOpen ? t('projectEditor.closePreview') : t('projectEditor.openPreview')}
                  </button>
                )}
                {activeFilePath && isSourcePreviewFile && !isBinary && !isImage && !isSqlite && (
                  <button
                    className="project-editor-action-btn project-editor-preview-toggle"
                    onClick={() => {
                      setMarkdownEditorVisibleState(!isMarkdownEditorVisibleRef.current)
                    }}
                  >
                    {isMarkdownEditorVisible ? t('projectEditor.closeEdit') : t('projectEditor.openEdit')}
                  </button>
                )}
                {activeFilePath && (isPdf || isEpub || (!isBinary && !isImage && !isSqlite)) && (
                  <button
                    className="project-editor-action-btn project-editor-preview-toggle"
                    onClick={() => {
                      setOutlineVisibleState(!isOutlineVisibleRef.current)
                    }}
                  >
                    {isOutlineVisible ? t('projectEditor.closeOutline') : t('projectEditor.openOutline')}
                  </button>
                )}
              </div>
            </div>

            <div className="project-editor-editor-body">
              {missingFileNotice && (
                <div className="project-editor-missing-banner">
                  <div className="project-editor-missing-text">
                    {missingFileNotice.message}
                  </div>
                  <div className="project-editor-missing-actions">
                    <button
                      className="project-editor-missing-btn primary"
                      onClick={() => {
                        setMissingFileNotice(null)
                        if (activeFilePath) {
                          clearActiveFileState()
                        }
                      }}
                    >
                      {activeFilePath ? t('projectEditor.closeFile') : t('common.close')}
                    </button>
                    <button
                      className="project-editor-missing-btn"
                      onClick={() => {
                        setMissingFileNotice(null)
                        void refreshDirectory('')
                        invalidateFileIndex()
                      }}
                    >
                      {t('projectEditor.refreshDirectory')}
                    </button>
                    <button
                      className="project-editor-missing-btn ghost"
                      onClick={() => setMissingFileNotice(null)}
                    >
                      {t('projectEditor.closeNotice')}
                    </button>
                  </div>
                </div>
              )}
              {activeFilePath && largeFileState ? (
                <div className="project-editor-large-viewer">
                  <div className="project-editor-large-toolbar">
                    <div className="project-editor-large-info">
                      <span className="project-editor-large-title">
                        {largeFileState.mode === 'binary'
                          ? t('projectEditor.binaryViewer.title')
                          : t('projectEditor.largeFile.title')}
                      </span>
                      <span className="project-editor-large-size">{formatFileSize(largeFileState.sizeBytes)}</span>
                      {largeFileRangeLabel && (
                        <span className="project-editor-large-range">{largeFileRangeLabel}</span>
                      )}
                    </div>
                    {largeFileState.mode === 'binary' && (
                      <div className="project-editor-binary-radix" role="group" aria-label={t('projectEditor.binaryViewer.radixLabel')}>
                        {([
                          [16, t('projectEditor.binaryViewer.hex')],
                          [8, t('projectEditor.binaryViewer.octal')],
                          [2, t('projectEditor.binaryViewer.binary')],
                          [10, t('projectEditor.binaryViewer.decimal')]
                        ] as Array<[BinaryRadix, string]>).map(([radix, label]) => (
                          <button
                            key={radix}
                            type="button"
                            className={`project-editor-binary-radix-btn ${binaryRadix === radix ? 'active' : ''}`}
                            onClick={() => setBinaryRadix(radix)}
                          >
                            {label}
                          </button>
                        ))}
                      </div>
                    )}
                    <div className="project-editor-large-actions">
                      <button
                        type="button"
                        className="project-editor-action-btn"
                        disabled={largeFileState.loading || largeFileState.offset <= 0}
                        onClick={() => void loadLargeFileChunk({
                          path: largeFileState.path,
                          mode: largeFileState.mode,
                          sizeBytes: largeFileState.sizeBytes,
                          offset: Math.max(0, largeFileState.offset - LARGE_FILE_CHUNK_BYTES)
                        })}
                      >
                        {t('projectEditor.largeFile.previous')}
                      </button>
                      <button
                        type="button"
                        className="project-editor-action-btn"
                        disabled={
                          largeFileState.loading ||
                          largeFileState.offset + largeFileState.bytesRead >= largeFileState.sizeBytes
                        }
                        onClick={() => void loadLargeFileChunk({
                          path: largeFileState.path,
                          mode: largeFileState.mode,
                          sizeBytes: largeFileState.sizeBytes,
                          offset: largeFileState.offset + Math.max(largeFileState.bytesRead, LARGE_FILE_CHUNK_BYTES)
                        })}
                      >
                        {t('projectEditor.largeFile.next')}
                      </button>
                    </div>
                  </div>
                  <div className="project-editor-large-notice">
                    {largeFileState.mode === 'binary'
                      ? t('projectEditor.binaryViewer.readOnlyNotice')
                      : t('projectEditor.largeFile.readOnlyNotice')}
                  </div>
                  <div className="project-editor-large-content">
                    {largeFileState.loading && (
                      <div className="project-editor-large-loading">
                        <div className="preview-loading-dots"><span /><span /><span /></div>
                      </div>
                    )}
                    {largeFileState.error ? (
                      <div className="project-editor-large-error">{largeFileState.error}</div>
                    ) : (
                      <pre className={largeFileState.mode === 'binary' ? 'project-editor-binary-dump' : 'project-editor-large-text'}>
                        {largeFileState.mode === 'binary' ? binaryDump : largeFileState.text}
                      </pre>
                    )}
                  </div>
                </div>
              ) : activeFilePath && isImage && imagePreviewUrl ? (
                <div className="project-editor-image-preview">
                  <img ref={imagePreviewRef} src={imagePreviewUrl} alt={activeFilePath} />
                </div>
              ) : activeFilePath && isPdf && pdfPreviewUrl ? (
                (() => {
                  const normalized = normalizePath(activeFilePath)
                  const memory = fileMemoryRef.current.get(normalized)
                  return (
                    <div className="project-editor-split" ref={previewLayoutRef}>
                      <div className="project-editor-editor-pane" style={{ flex: '1 1 0%' }}>
                        <PdfReader
                          ref={pdfReaderRef}
                          viewerUrl={pdfPreviewUrl}
                          filePath={activeFilePath}
                          initialState={{
                            page: memory?.pdfPageNumber,
                            scrollTop: memory?.pdfScrollTop,
                            scale: memory?.pdfScale
                          }}
                          onOutlineLoaded={setPdfOutlineSymbols}
                          onPageChange={setPdfActivePage}
                          onStateChange={(state) => {
                            const current = fileMemoryRef.current.get(normalized) ?? {}
                            const merged: FileViewMemory = {
                              ...current,
                              pdfPageNumber: state.page,
                              pdfScrollTop: state.scrollTop,
                              ...(state.scale ? { pdfScale: state.scale } : {})
                            }
                            upsertFileMemory(normalized, merged)
                            scheduleProjectStateSave()
                          }}
                        />
                      </div>
                      {outlineShowInSplit && (
                        <>
                          <div className="project-editor-outline-resizer" onMouseDown={handleOutlineResizeMouseDown} />
                          <div className="project-editor-outline-pane" style={outlinePaneStyle}>
                            <OutlinePanel
                              symbols={pdfOutlineSymbols}
                              activeItem={pdfActiveItem}
                              isLoading={false}
                              filePath={activeFilePath}
                              editor={null}
                              initialScrollTop={(() => {
                                const key = getFileScrollKey(lastEditorScopeRef.current, activeFilePath)
                                return key ? outlineScrollTopRef.current.get(key) : undefined
                              })()}
                              onScrollCapture={handleOutlineScrollCapture}
                              onItemNavigate={(item) => {
                                if (item.target?.kind === 'pdf-page') {
                                  // Prefer the full destination when available
                                  // so /XYZ / /FitH and multi-anchor outlines
                                  // navigate with pixel precision. Fall back
                                  // to page-level jump only when no dest was
                                  // preserved.
                                  if (item.target.dest != null) {
                                    pdfReaderRef.current?.goToDest(item.target.dest)
                                  } else {
                                    pdfReaderRef.current?.goToPage(item.target.page)
                                  }
                                }
                              }}
                            />
                          </div>
                        </>
                      )}
                    </div>
                  )
                })()
              ) : activeFilePath && isEpub && epubPreviewBuffer ? (
                (() => {
                  const normalized = normalizePath(activeFilePath)
                  const memory = fileMemoryRef.current.get(normalized)
                  return (
                    <div className="project-editor-split" ref={previewLayoutRef}>
                      <div className="project-editor-editor-pane" style={{ flex: '1 1 0%' }}>
                        <EpubReader
                          ref={epubReaderRef}
                          previewBuffer={epubPreviewBuffer}
                          filePath={activeFilePath}
                          initialFontPct={memory?.epubFontPct}
                          initialLocation={memory?.epubLocation ?? null}
                          initialScrollTop={memory?.epubScrollTop}
                          onOutlineLoaded={setEpubOutlineSymbols}
                          onLocationChange={setEpubActiveHref}
                          onMemoryChange={(patch) => {
                            // Merge into the per-file memory keyed by the normalized
                            // path so the next open of the same file restores the
                            // same reader state. NOT persisted as a global setting.
                            const current = fileMemoryRef.current.get(normalized) ?? {}
                            const merged: FileViewMemory = { ...current, ...patch }
                            upsertFileMemory(normalized, merged)
                            scheduleProjectStateSave()
                          }}
                        />
                      </div>
                      {outlineShowInSplit && (
                        <>
                          <div className="project-editor-outline-resizer" onMouseDown={handleOutlineResizeMouseDown} />
                          <div className="project-editor-outline-pane" style={outlinePaneStyle}>
                            <OutlinePanel
                              symbols={epubOutlineSymbols}
                              activeItem={epubActiveItem}
                              isLoading={false}
                              filePath={activeFilePath}
                              editor={null}
                              initialScrollTop={(() => {
                                const key = getFileScrollKey(lastEditorScopeRef.current, activeFilePath)
                                return key ? outlineScrollTopRef.current.get(key) : undefined
                              })()}
                              onScrollCapture={handleOutlineScrollCapture}
                              onItemNavigate={(item) => {
                                if (item.target?.kind === 'epub-href') {
                                  epubReaderRef.current?.goToHref(item.target.href)
                                }
                              }}
                            />
                          </div>
                        </>
                      )}
                    </div>
                  )
                })()
              ) : activeFilePath && isSqlite && (rootRef.current ?? rootPath) ? (
                <SqliteViewer
                  rootPath={(rootRef.current ?? rootPath) as string}
                  filePath={activeFilePath}
                  onNotifyGitChange={notifySqliteMutation}
                />
              ) : activeFilePath && !isBinary ? (
                <div className="project-editor-split" ref={previewLayoutRef}>
                  <div
                    className="project-editor-editor-pane"
                    style={{
                      ...editorPaneStyle,
                      ...(isSourcePreviewFile && !isMarkdownEditorVisible ? { display: 'none' } : {})
                    }}
                  >
                    <Editor
                      height="100%"
                      width="100%"
                      path={editorPath}
                      saveViewState={false}
                      language={editorLanguage}
                      theme="vs-dark"
                      value={fileContent}
                      onChange={handleEditorChange}
                      onMount={(editor, monaco) => {
                        editorRef.current = editor
                        monacoRef.current = monaco
                        editorScrollDisposableRef.current?.dispose()
                        editorScrollDisposableRef.current = editor.onDidScrollChange(() => {
                          if (DEBUG_PROJECT_EDITOR) {
                            perfCountersRef.current.editorScroll += 1
                          }
                          if (suppressNextEditorScrollRef.current) {
                            suppressNextEditorScrollRef.current = false
                            return
                          }
                          if (
                            previewVisibleRef.current &&
                            !suppressProgrammaticEditorPreviewSyncRef.current &&
                            !suppressPreviewSyncOnRestoreRef.current &&
                            previewRestorePhaseRef.current === 'idle'
                          ) {
                            schedulePreviewSync()
                          }
                          const currentPath = activeFilePathRef.current
                          const firstVisibleLine = editor.getVisibleRanges()?.[0]?.startLineNumber ?? null
                          if (currentPath && typeof firstVisibleLine === 'number' && firstVisibleLine > 0) {
                            fileFirstVisibleLineRef.current.set(getViewStateKey(currentPath), firstVisibleLine)
                          }
                          scheduleProjectStateSave()
                        })
                        editorCursorDisposableRef.current?.dispose()
                        editorCursorDisposableRef.current = editor.onDidChangeCursorPosition(() => {
                          if (DEBUG_PROJECT_EDITOR) {
                            perfCountersRef.current.editorCursor += 1
                          }
                          scheduleProjectStateSave()
                        })
                        editorModelDisposableRef.current?.dispose()
                        editorModelDisposableRef.current = editor.onDidChangeModel(() => {
                          if (
                            (pendingViewStateRef.current || pendingCursorRef.current) &&
                            pendingViewStatePathRef.current === activeFilePathRef.current
                          ) {
                            applyPendingViewState()
                          }
                          syncOriginalVersion()
                        })
                        editorSaveCommandIdRef.current = editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
                          void handleSaveRef.current('editor-shortcut')
                        })
                        if ((pendingViewStateRef.current || pendingCursorRef.current) && pendingViewStatePathRef.current === activeFilePath) {
                          applyPendingViewState()
                        }
                        syncOriginalVersion()
                      }}
                      options={{
                        fontSize: editorFontSize,
                        minimap: { enabled: false },
                        wordWrap: 'on',
                        automaticLayout: true,
                        scrollBeyondLastLine: false,
                        padding: { top: 10, bottom: 10 }
                      }}
                    />
                  </div>

                  {isMarkdownPreviewVisible && (
                    <>
                      {isMarkdownEditorVisible && (
                        <div className="project-editor-preview-resizer" onMouseDown={handlePreviewResizeMouseDown} />
                      )}
                      <div className="project-editor-preview-pane" style={previewPaneStyle}>
                        <div className="project-editor-preview-header">
                          <div className="project-editor-preview-header-main">
                            <span>{t('projectEditor.livePreview')}</span>
                            {markdownRenderPending && (
                              <span className="project-editor-preview-pending">{t('projectEditor.rendering')}</span>
                            )}
                          </div>
                          <button
                            type="button"
                            className="project-editor-action-btn project-editor-preview-toggle"
                            aria-pressed={isMarkdownCodeWrapEnabled}
                            onClick={() => setMarkdownCodeWrapEnabledState(!isMarkdownCodeWrapEnabledRef.current)}
                          >
                            {isMarkdownCodeWrapEnabled
                              ? t('projectEditor.disableCodeWrap')
                              : t('projectEditor.enableCodeWrap')}
                          </button>
                          {isMarkdownEditorVisible && (
                            <button
                              className="project-editor-preview-refresh-btn"
                              title={t('projectEditor.refreshPreview')}
                              onClick={() => {
                                markdownImageMapRef.current = {}
                                setMarkdownImageMap({})
                                scheduleMarkdownRender()
                              }}
                            >
                              <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
                                <path d="M13.65 2.35a8 8 0 1 0 1.77 5.15.75.75 0 0 0-1.5-.1 6.5 6.5 0 1 1-1.45-4.15H10.5a.75.75 0 0 0 0 1.5h4a.75.75 0 0 0 .75-.75v-4a.75.75 0 0 0-1.5 0v2.15l-.1.1Z" />
                              </svg>
                            </button>
                          )}
                        </div>
                        <PreviewSearchBar
                          ref={previewSearchRef}
                          previewRef={previewRef}
                          isOpen={previewSearchOpen}
                          focusRequestId={previewSearchFocusRequestId}
                          onClose={closePreviewSearch}
                          renderedHtml={markdownRenderedHtml}
                        />
                        <div
                          className={`project-editor-preview-body preview-phase-${previewRestorePhase}${isMarkdownCodeWrapEnabled ? ' code-wrap-enabled' : ''}`}
                          ref={previewRef}
                          onCopy={handlePreviewCopy}
                        >
                          <div className="project-editor-preview-transition-indicator" aria-hidden={isPreviewContentVisible}>
                            <div className="preview-loading-dots"><span /><span /><span /></div>
                          </div>
                          {isMarkdownRenderAllowed ? (
                            <div
                              className="project-editor-preview-content"
                              dangerouslySetInnerHTML={{ __html: markdownRenderedHtml }}
                            />
                          ) : (
                            <div className="project-editor-preview-placeholder">
                              {t('projectEditor.previewHint')}
                            </div>
                          )}
                        </div>
                      </div>
                    </>
                  )}

                  {isHtmlPreviewVisible && htmlPreviewUrlWithReload && (
                    <>
                      {isMarkdownEditorVisible && (
                        <div className="project-editor-preview-resizer" onMouseDown={handlePreviewResizeMouseDown} />
                      )}
                      <div className="project-editor-preview-pane" style={previewPaneStyle}>
                        <div className="project-editor-preview-header">
                          <div className="project-editor-preview-header-main">
                            <span>{t('projectEditor.htmlPreview')}</span>
                            {htmlReaderState?.isLoading && (
                              <span className="project-editor-preview-pending">{t('projectEditor.loading')}</span>
                            )}
                          </div>
                          <div className="project-editor-html-preview-actions">
                            <div
                              className="project-editor-html-nav-controls"
                              role="group"
                              aria-label={t('projectEditor.htmlPreviewNavControls')}
                            >
                              <button
                                type="button"
                                className="project-editor-preview-refresh-btn project-editor-html-nav-btn project-editor-html-nav-back-btn"
                                title={t('projectEditor.htmlPreviewBack')}
                                aria-label={t('projectEditor.htmlPreviewBack')}
                                disabled={!htmlPreviewNav.backEnabled}
                                onClick={() => void handleHtmlPreviewNav('back')}
                              >
                                <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
                                  <path fillRule="evenodd" d="M11.354 1.646a.5.5 0 0 1 0 .708L5.707 8l5.647 5.646a.5.5 0 0 1-.708.708l-6-6a.5.5 0 0 1 0-.708l6-6a.5.5 0 0 1 .708 0z" />
                                </svg>
                              </button>
                              <button
                                type="button"
                                className="project-editor-preview-refresh-btn project-editor-html-nav-btn project-editor-html-nav-forward-btn"
                                title={t('projectEditor.htmlPreviewForward')}
                                aria-label={t('projectEditor.htmlPreviewForward')}
                                disabled={!htmlPreviewNav.forwardEnabled}
                                onClick={() => void handleHtmlPreviewNav('forward')}
                              >
                                <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
                                  <path fillRule="evenodd" d="M4.646 1.646a.5.5 0 0 1 .708 0l6 6a.5.5 0 0 1 0 .708l-6 6a.5.5 0 0 1-.708-.708L10.293 8 4.646 2.354a.5.5 0 0 1 0-.708z" />
                                </svg>
                              </button>
                              <button
                                type="button"
                                className="project-editor-preview-refresh-btn project-editor-html-nav-btn project-editor-html-nav-reload-btn"
                                title={t('projectEditor.htmlPreviewReloadShortcut', {
                                  key: htmlPreviewRefreshShortcutLabel
                                })}
                                aria-label={t('projectEditor.htmlPreviewReload')}
                                disabled={!htmlPreviewNav.reloadEnabled}
                                onClick={() => void handleHtmlPreviewNav('reload')}
                              >
                                <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
                                  <path d="M11.534 7h3.932a.25.25 0 0 1 .192.41l-1.966 2.36a.25.25 0 0 1-.384 0l-1.966-2.36a.25.25 0 0 1 .192-.41zm-7.068 2H.534a.25.25 0 0 0-.192.41l1.966 2.36a.25.25 0 0 0 .384 0l1.966-2.36A.25.25 0 0 0 4.466 9z" />
                                  <path d="M8 3a5 5 0 0 1 4.546 2.914.5.5 0 1 0 .908-.428A6 6 0 0 0 2.11 5.84L1.58 4.39A.5.5 0 0 0 .64 4.61l1.2 3.6a.5.5 0 0 0 .638.316l3.6-1.2a.5.5 0 1 0-.316-.948L3.9 7.077A5 5 0 0 1 8 3zm6.42 5.39a.5.5 0 0 0-.638-.316l-3.6 1.2a.5.5 0 1 0 .316.948l1.862-.62A5 5 0 0 1 8 13a5 5 0 0 1-4.546-2.914.5.5 0 0 0-.908.428A6 6 0 0 0 13.89 10.16l.53 1.45a.5.5 0 1 0 .94-.22l-1.2-3.6a.5.5 0 0 0-.26-.28z" />
                                </svg>
                              </button>
                            </div>
                            <button
                              type="button"
                              className="project-editor-preview-refresh-btn project-editor-html-nav-btn project-editor-html-nav-home-btn"
                              title={t('projectEditor.htmlPreviewHome')}
                              aria-label={t('projectEditor.htmlPreviewHome')}
                              disabled={!htmlPreviewNav.homeEnabled}
                              onClick={() => void handleHtmlPreviewNav('home')}
                            >
                              <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
                                <path d="M8 1.5 14.5 7.42l-1.02 1.16-.98-.86V13.5a1 1 0 0 1-1 1H9.25V10.5h-2.5v4H4.5a1 1 0 0 1-1-1V7.72l-.98.86L1.5 7.42 8 1.5Z" />
                              </svg>
                            </button>
                            <div
                              className="project-editor-html-zoom-controls"
                              role="group"
                              aria-label={t('projectEditor.htmlPreviewZoomControls')}
                            >
                              <button
                                type="button"
                                className="project-editor-preview-refresh-btn project-editor-html-zoom-btn project-editor-html-zoom-out-btn"
                                title={t('projectEditor.htmlPreviewZoomOut', {
                                  key: `${window.electronAPI.platform === 'darwin' ? '⌘' : 'Ctrl'}+-`
                                })}
                                aria-label={t('projectEditor.htmlPreviewZoomOut', {
                                  key: `${window.electronAPI.platform === 'darwin' ? '⌘' : 'Ctrl'}+-`
                                })}
                                disabled={htmlPreviewZoomFactor <= HTML_PREVIEW_MIN_ZOOM_FACTOR}
                                onClick={() => void stepHtmlPreviewZoom('out', 'toolbar')}
                              >
                                <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
                                  <path d="M3 7.25h10v1.5H3v-1.5Z" />
                                </svg>
                              </button>
                              <button
                                type="button"
                                className="project-editor-html-zoom-level-btn"
                                title={t('projectEditor.htmlPreviewZoomReset', {
                                  key: `${window.electronAPI.platform === 'darwin' ? '⌘' : 'Ctrl'}+0`
                                })}
                                aria-label={t('projectEditor.htmlPreviewZoomLevel', {
                                  percent: htmlPreviewZoomPercent
                                })}
                                onClick={() => void stepHtmlPreviewZoom('reset', 'toolbar')}
                              >
                                {htmlPreviewZoomPercent}
                              </button>
                              <button
                                type="button"
                                className="project-editor-preview-refresh-btn project-editor-html-zoom-btn project-editor-html-zoom-in-btn"
                                title={t('projectEditor.htmlPreviewZoomIn', {
                                  key: `${window.electronAPI.platform === 'darwin' ? '⌘' : 'Ctrl'}++`
                                })}
                                aria-label={t('projectEditor.htmlPreviewZoomIn', {
                                  key: `${window.electronAPI.platform === 'darwin' ? '⌘' : 'Ctrl'}++`
                                })}
                                disabled={htmlPreviewZoomFactor >= HTML_PREVIEW_MAX_ZOOM_FACTOR}
                                onClick={() => void stepHtmlPreviewZoom('in', 'toolbar')}
                              >
                                <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
                                  <path d="M7.25 3h1.5v4.25H13v1.5H8.75V13h-1.5V8.75H3v-1.5h4.25V3Z" />
                                </svg>
                              </button>
                            </div>
                            <button
                              type="button"
                              className="project-editor-preview-refresh-btn"
                              title={t('projectEditor.previewSearch.open')}
                              aria-label={t('projectEditor.previewSearch.open')}
                              onClick={openHtmlPreviewSearch}
                            >
                              <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
                                <path d="M11.742 10.344a6.5 6.5 0 1 0-1.397 1.398l2.956 2.956a1 1 0 0 0 1.415-1.414l-2.974-2.94ZM12 6.5a5.5 5.5 0 1 1-11 0 5.5 5.5 0 0 1 11 0Z" />
                              </svg>
                            </button>
                          </div>
                        </div>
                        <HtmlPreviewSearchBar
                          isOpen={htmlPreviewSearchOpen}
                          focusRequestId={htmlPreviewSearchFocusRequestId}
                          query={htmlPreviewSearchQuery}
                          result={htmlPreviewSearchResult}
                          onQueryChange={updateHtmlPreviewSearchQuery}
                          onNext={goToNextHtmlPreviewSearchMatch}
                          onPrevious={goToPreviousHtmlPreviewSearchMatch}
                          onClose={closeHtmlPreviewSearch}
                        />
                        <div className="project-editor-html-preview-body">
                          <HtmlReader
                            url={htmlPreviewUrlWithReload}
                            rootPath={(rootRef.current ?? rootPath ?? '') as string}
                            filePath={activeFilePath}
                            reloadKey={htmlPreviewReloadKey}
                            isActive={isOpen && isHtmlPreviewVisible}
                            restoreScrollState={htmlPreviewScrollState}
                            onEscape={() => {
                              if (htmlPreviewSearchOpenRef.current) {
                                closeHtmlPreviewSearch()
                                return
                              }
                              void handleRequestClose()
                            }}
                            onStateChange={updateHtmlReaderState}
                          />
                        </div>
                      </div>
                    </>
                  )}

                  {/* Outline lives on the right for every file type so the
                      placement stays consistent across Markdown / code /
                      PDF / EPUB. The Markdown variant gets a few extra props
                      (preview sync, active-slug tracking); everything else
                      uses the plain editor-driven outline. */}
                  {outlineShowInSplit && (
                    <>
                      <div className="project-editor-outline-resizer" onMouseDown={handleOutlineResizeMouseDown} />
                      <div className="project-editor-outline-pane" style={outlinePaneStyle}>
                        {isMarkdownFile ? (
                          <OutlinePanel
                            symbols={outlineSymbols}
                            activeItem={outlineActiveItem}
                            isLoading={outlineLoading}
                            filePath={activeFilePath}
                            editor={editorRef.current}
                            isMarkdown
                            previewRef={previewRef}
                            outlineTarget={outlineTarget}
                            isEditorVisible={isMarkdownEditorVisible}
                            isPreviewVisible={isMarkdownPreviewVisible}
                            previewActiveSlug={previewActiveSlug}
                            initialScrollTop={(() => {
                              const key = getFileScrollKey(lastEditorScopeRef.current, activeFilePath)
                              return key ? outlineScrollTopRef.current.get(key) : undefined
                            })()}
                            onScrollCapture={handleOutlineScrollCapture}
                            onOutlineTargetChange={setOutlineTargetPreference}
                          />
                        ) : (
                          <OutlinePanel
                            symbols={outlineSymbols}
                            activeItem={outlineActiveItem}
                            isLoading={outlineLoading}
                            filePath={activeFilePath}
                            editor={editorRef.current}
                            initialScrollTop={(() => {
                              const key = getFileScrollKey(lastEditorScopeRef.current, activeFilePath)
                              return key ? outlineScrollTopRef.current.get(key) : undefined
                            })()}
                            onScrollCapture={handleOutlineScrollCapture}
                          />
                        )}
                      </div>
                    </>
                  )}
                </div>
              ) : (
                <div className="project-editor-empty">
                  {activeFilePath
                    ? (isBinary ? t('projectEditor.binaryCurrent') : t('projectEditor.empty.noContent'))
                    : t('projectEditor.selectFile')}
                </div>
              )}
            </div>
          </div>
        </div>

        {diffReturnContext && (
          <div className="project-editor-diff-return-bar">
            <button
              type="button"
              className="project-editor-diff-return-button"
              onClick={() => void handleBackToDiff()}
            >
              {t('projectEditor.diffReturn.back')}
            </button>
            <button
              type="button"
              className="project-editor-diff-return-button primary"
              onClick={() => void handleJumpToDiff()}
              disabled={!diffJumpTarget || diffJumpChecking}
              title={diffJumpTarget
                ? t('projectEditor.diffReturn.jumpTitle')
                : t('projectEditor.diffReturn.jumpDisabled')}
            >
              {diffJumpChecking ? t('projectEditor.diffReturn.checking') : t('projectEditor.diffReturn.jump')}
            </button>
          </div>
        )}

        {searchOpen && (
          <div className="project-editor-search-overlay" onClick={handleCloseSearch}>
            <div className="project-editor-search" onClick={(event) => event.stopPropagation()}>
              <input
                ref={searchInputRef}
                className="project-editor-search-input"
                value={searchQuery}
                placeholder={t('projectEditor.searchPlaceholder')}
                onChange={(event) => setSearchQuery(event.target.value)}
                onKeyDown={handleSearchKeyDown}
              />
              <div className="project-editor-search-results">
                {isIndexing && (
                  <div className="project-editor-search-empty">{t('projectEditor.searchIndexing')}</div>
                )}
                {!isIndexing && searchResults.length === 0 && (
                  <div className="project-editor-search-empty">{t('projectEditor.searchNoMatches')}</div>
                )}
                {!isIndexing && searchResults.map((item, index) => (
                  <div
                    key={item}
                    className={`project-editor-search-item ${index === searchActiveIndex ? 'active' : ''}`}
                    onClick={() => void handleSearchSelect(item)}
                  >
                    <span className="project-editor-search-item-name">{getBaseName(item)}</span>
                    <span className="project-editor-search-item-path">{item}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}

        {dialog && (
          <div className="project-editor-dialog-overlay" onClick={handleDialogCancel}>
            <div className="project-editor-dialog" onClick={(event) => event.stopPropagation()}>
              <div className="project-editor-dialog-title">{dialog.title}</div>
              <div className="project-editor-dialog-message">{dialog.message}</div>
              {dialog.type === 'prompt' && (
                <input
                  ref={dialogInputRef}
                  className="project-editor-dialog-input"
                  value={dialogInput}
                  placeholder={dialog.placeholder}
                  onChange={(event) => setDialogInput(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') {
                      handleDialogConfirm()
                    }
                  }}
                />
              )}
              <div className="project-editor-dialog-actions">
                <button className="project-editor-dialog-btn" onClick={handleDialogCancel}>
                  {dialog.cancelText || t('common.cancel')}
                </button>
                <button className="project-editor-dialog-btn primary" onClick={handleDialogConfirm}>
                  {dialog.confirmText || t('common.confirm')}
                </button>
              </div>
            </div>
          </div>
        )}

        {fileOpenChoiceDialog && (
          <div className="project-editor-dialog-overlay" onClick={handleFileOpenChoiceCancel}>
            <div className="project-editor-dialog project-editor-open-choice-dialog" onClick={(event) => event.stopPropagation()}>
              <div className="project-editor-dialog-title">{t('projectEditor.binaryChoice.title')}</div>
              <div className="project-editor-dialog-message">
                {t('projectEditor.binaryChoice.message', {
                  extension: fileOpenChoiceDialog.extensionLabel,
                  size: fileOpenChoiceDialog.sizeLabel
                })}
              </div>
              <label className="project-editor-open-choice-remember">
                <input
                  type="checkbox"
                  checked={fileOpenChoiceDialog.remember}
                  onChange={(event) => {
                    setFileOpenChoiceDialog((prev) => prev
                      ? { ...prev, remember: event.currentTarget.checked }
                      : prev)
                  }}
                />
                <span>
                  {t('projectEditor.binaryChoice.remember', {
                    extension: fileOpenChoiceDialog.extensionLabel
                  })}
                </span>
              </label>
              <div className="project-editor-dialog-actions project-editor-open-choice-actions">
                <button className="project-editor-dialog-btn" onClick={handleFileOpenChoiceCancel}>
                  {t('common.cancel')}
                </button>
                <button className="project-editor-dialog-btn" onClick={() => handleFileOpenChoiceSelect('text')}>
                  {t('projectEditor.binaryChoice.openAsText')}
                </button>
                <button className="project-editor-dialog-btn primary" onClick={() => handleFileOpenChoiceSelect('binary')}>
                  {t('projectEditor.binaryChoice.openAsBinary')}
                </button>
              </div>
            </div>
          </div>
        )}

        {contextMenu && (() => {
          const showDirGroup = contextMenu.targetType === 'dir' || contextMenu.targetType === null
          const showCopyGroup = contextMenu.targetType && contextMenu.targetPath !== null
          const showManageGroup = showCopyGroup && contextMenu.source === 'tree'
          return (
          <div
            className="project-editor-context-menu"
            ref={contextMenuRef}
            style={{ left: contextMenu.x, top: contextMenu.y }}
            onClick={(event) => event.stopPropagation()}
            onContextMenu={(event) => event.preventDefault()}
          >
            {showDirGroup && (
              <>
                <button
                  className="project-editor-context-item"
                  onClick={() => {
                    closeContextMenu()
                    const refreshTarget = contextMenu.targetType === 'dir'
                      ? (contextMenu.targetPath ?? '')
                      : ''
                    void refreshDirectory(refreshTarget)
                    invalidateFileIndex()
                  }}
                >
                  <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M11.534 7h3.932a.25.25 0 0 1 .192.41l-1.966 2.36a.25.25 0 0 1-.384 0l-1.966-2.36a.25.25 0 0 1 .192-.41zm-7.068 2H.534a.25.25 0 0 0-.192.41l1.966 2.36a.25.25 0 0 0 .384 0l1.966-2.36A.25.25 0 0 0 4.466 9z" /><path d="M8 3a5 5 0 0 1 4.546 2.914.5.5 0 1 0 .908-.428A6 6 0 0 0 2.11 5.84L1.58 4.39A.5.5 0 0 0 .64 4.61l1.2 3.6a.5.5 0 0 0 .638.316l3.6-1.2a.5.5 0 1 0-.316-.948L3.9 7.077A5 5 0 0 1 8 3zm6.42 5.39a.5.5 0 0 0-.638-.316l-3.6 1.2a.5.5 0 1 0 .316.948l1.862-.62A5 5 0 0 1 8 13a5 5 0 0 1-4.546-2.914.5.5 0 0 0-.908.428A6 6 0 0 0 13.89 10.16l.53 1.45a.5.5 0 1 0 .94-.22l-1.2-3.6a.5.5 0 0 0-.26-.28z" /></svg>
                  <span>{t('projectEditor.context.refresh')}</span>
                </button>
                <button
                  className="project-editor-context-item"
                  onClick={() => {
                    closeContextMenu()
                    void handleNewFile(contextMenu.targetType === 'dir' ? (contextMenu.targetPath ?? '') : '')
                  }}
                >
                  <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M9 1H3.5A1.5 1.5 0 0 0 2 2.5v11A1.5 1.5 0 0 0 3.5 15h9a1.5 1.5 0 0 0 1.5-1.5V6h-4a1 1 0 0 1-1-1V1zm1 0v4h4L10 1zM8 8.75a.75.75 0 0 0-1.5 0V10H5.25a.75.75 0 0 0 0 1.5H6.5v1.25a.75.75 0 0 0 1.5 0V11.5h1.25a.75.75 0 0 0 0-1.5H8V8.75z" /></svg>
                  <span>{t('projectEditor.context.newFile')}</span>
                </button>
                <button
                  className="project-editor-context-item"
                  onClick={() => {
                    closeContextMenu()
                    void handleNewFolder(contextMenu.targetType === 'dir' ? (contextMenu.targetPath ?? '') : '')
                  }}
                >
                  <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M1.5 2A1.5 1.5 0 0 0 0 3.5v9A1.5 1.5 0 0 0 1.5 14h13a1.5 1.5 0 0 0 1.5-1.5V5.5A1.5 1.5 0 0 0 14.5 4H7.71L6.85 2.57A1.5 1.5 0 0 0 5.57 2H1.5zM8 7.75a.75.75 0 0 0-1.5 0V9H5.25a.75.75 0 0 0 0 1.5H6.5v1.25a.75.75 0 0 0 1.5 0V10.5h1.25a.75.75 0 0 0 0-1.5H8V7.75z" /></svg>
                  <span>{t('projectEditor.context.newFolder')}</span>
                </button>
              </>
            )}
            {showDirGroup && showCopyGroup && (
              <div className="project-editor-context-separator" />
            )}
            {showCopyGroup && (
              <>
                <button
                  className="project-editor-context-item"
                  onClick={() => {
                    closeContextMenu()
                    void copyContextMenuPath(contextMenu.targetPath ?? '', 'name')
                  }}
                >
                  <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M2.5 2a.5.5 0 0 0 0 1h11a.5.5 0 0 0 0-1h-11zM5 5.5a.5.5 0 0 1 .5-.5h5a.5.5 0 0 1 0 1H8.5v7a.5.5 0 0 1-1 0V6H5.5a.5.5 0 0 1-.5-.5z" /></svg>
                  <span>{t('common.copyName')}</span>
                </button>
                <button
                  className="project-editor-context-item"
                  onClick={() => {
                    closeContextMenu()
                    void copyContextMenuPath(contextMenu.targetPath ?? '', 'relative')
                  }}
                >
                  <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M9 1H3.5A1.5 1.5 0 0 0 2 2.5v11A1.5 1.5 0 0 0 3.5 15h9a1.5 1.5 0 0 0 1.5-1.5V6h-4a1 1 0 0 1-1-1V1zm1 0v4h4L10 1z" /><circle cx="5" cy="11.5" r="1" /><path d="M7 10a.5.5 0 0 1 .354.146l2 2a.5.5 0 0 1-.708.708L7 11.207l-1.646 1.647a.5.5 0 0 1-.708-.708l2-2A.5.5 0 0 1 7 10z" /></svg>
                  <span>{t('common.copyRelativePath')}</span>
                </button>
                <button
                  className="project-editor-context-item"
                  onClick={() => {
                    closeContextMenu()
                    void copyContextMenuPath(contextMenu.targetPath ?? '', 'absolute')
                  }}
                >
                  <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M9 1H3.5A1.5 1.5 0 0 0 2 2.5v11A1.5 1.5 0 0 0 3.5 15h9a1.5 1.5 0 0 0 1.5-1.5V6h-4a1 1 0 0 1-1-1V1zm1 0v4h4L10 1z" /><path d="M8.5 9a.5.5 0 0 0-.894-.447l-2 4a.5.5 0 1 0 .894.447l2-4z" /></svg>
                  <span>{t('common.copyAbsolutePath')}</span>
                </button>
                {contextMenu.targetType === 'file' && (
                  <button
                    className="project-editor-context-item"
                    onClick={() => {
                      closeContextMenu()
                      if (contextMenu.targetPath) {
                        togglePinnedFile(contextMenu.targetPath)
                      }
                    }}
                  >
                    {contextMenu.targetPath && pinnedFiles.includes(contextMenu.targetPath) ? (
                      <>
                        <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M9.828 1.282a2 2 0 0 1 2.828 0l2.062 2.062a2 2 0 0 1 0 2.828L12.78 8.11a1 1 0 0 1-.293.207l-1.957.783.97.97a.75.75 0 0 1-1.06 1.06l-.97-.97-.783 1.957a1 1 0 0 1-.207.293L6.54 14.35a2 2 0 0 1-2.828 0L1.65 12.288a2 2 0 0 1 0-2.828l1.94-1.94a1 1 0 0 1 .293-.207l1.957-.783-.97-.97a.75.75 0 0 1 1.06-1.06l.97.97.783-1.957a1 1 0 0 1 .207-.293l1.938-1.938zM1.47 14.53l13.06-13.06a.75.75 0 1 0-1.06-1.06L.41 13.47a.75.75 0 1 0 1.06 1.06z" /></svg>
                        <span>{t('projectEditor.context.unpin')}</span>
                      </>
                    ) : (
                      <>
                        <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M9.828 1.282a2 2 0 0 1 2.828 0l2.062 2.062a2 2 0 0 1 0 2.828L12.78 8.11a1 1 0 0 1-.293.207l-1.957.783.97.97a.75.75 0 0 1-1.06 1.06l-.97-.97-.783 1.957a1 1 0 0 1-.207.293L6.54 14.35a2 2 0 0 1-2.828 0L1.65 12.288a2 2 0 0 1 0-2.828l1.94-1.94a1 1 0 0 1 .293-.207l1.957-.783-.97-.97a.75.75 0 0 1 1.06-1.06l.97.97.783-1.957a1 1 0 0 1 .207-.293l1.938-1.938z" /></svg>
                        <span>{t('projectEditor.context.pin')}</span>
                      </>
                    )}
                  </button>
                )}
                {showManageGroup && (
                  <div className="project-editor-context-separator" />
                )}
                {contextMenu.source === 'tree' && (
                  <>
                    <button
                      className="project-editor-context-item"
                      onClick={() => {
                        closeContextMenu()
                        void handleRename(contextMenu.targetPath ?? undefined)
                      }}
                    >
                      <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M12.146.146a.5.5 0 0 1 .708 0l3 3a.5.5 0 0 1 0 .708l-10 10a.5.5 0 0 1-.168.11l-5 2a.5.5 0 0 1-.65-.65l2-5a.5.5 0 0 1 .11-.168l10-10zM11.207 2.5 13.5 4.793 14.793 3.5 12.5 1.207 11.207 2.5zm1.586 3L10.5 3.207 4 9.707V10h.5a.5.5 0 0 1 .5.5v.5h.5a.5.5 0 0 1 .5.5v.5h.293l6.5-6.5zm-9.761 5.175-.106.106-1.528 3.821 3.821-1.528.106-.106A.5.5 0 0 1 5 12.5V12h-.5a.5.5 0 0 1-.5-.5V11h-.5a.5.5 0 0 1-.468-.325z" /></svg>
                      <span>{t('projectEditor.context.rename')}</span>
                    </button>
                    <div className="project-editor-context-separator" />
                    <button
                      className="project-editor-context-item danger"
                      onClick={() => {
                        closeContextMenu()
                        void handleDelete(contextMenu.targetPath ?? undefined)
                      }}
                    >
                      <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M5.5 5.5A.5.5 0 0 1 6 6v6a.5.5 0 0 1-1 0V6a.5.5 0 0 1 .5-.5zm2.5 0a.5.5 0 0 1 .5.5v6a.5.5 0 0 1-1 0V6a.5.5 0 0 1 .5-.5zm3 .5a.5.5 0 0 0-1 0v6a.5.5 0 0 0 1 0V6z" /><path fillRule="evenodd" d="M14.5 3a1 1 0 0 1-1 1H13v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V4h-.5a1 1 0 0 1-1-1V2a1 1 0 0 1 1-1H6a1 1 0 0 1 1-1h2a1 1 0 0 1 1 1h3.5a1 1 0 0 1 1 1v1zM4.118 4 4 4.059V13a1 1 0 0 0 1 1h6a1 1 0 0 0 1-1V4.059L11.882 4H4.118zM2.5 3V2h11v1h-11z" /></svg>
                      <span>{t('common.delete')}</span>
                    </button>
                  </>
                )}
              </>
            )}
          </div>
          )
        })()}

        {/* Instant Tooltip */}
        {quickTooltip && (
          <div
            className="project-editor-quick-tooltip"
            style={{ position: 'fixed', left: quickTooltip.x, top: quickTooltip.y }}
          >
            <div className="project-editor-quick-tooltip-relative">{quickTooltip.text}</div>
            {quickTooltip.fullPath !== quickTooltip.text && (
              <div className="project-editor-quick-tooltip-full">{quickTooltip.fullPath}</div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
