/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

import { contextBridge, ipcRenderer } from 'electron'
import { IPC } from '../shared/ipc-channels'
import { PERF_TRACE_EVENT } from '../../src/utils/perf-trace-names'
import type {
  FeedbackActionResult,
  FeedbackCreateSubmissionResult,
  FeedbackDebugRemoteIssue,
  FeedbackState,
  FeedbackSubmissionInput
} from '../../src/types/feedback'

// Hoisted so traceIpc() below works from inside the early API objects.
// The flag is read once at preload load. The trace store is now default-on
// in the main process; renderer-side spans match that default unless
// ONWARD_PERF_TRACE=0 explicitly disables the diagnostic capture.
const preloadPerfTraceEnabled = process.env.ONWARD_PERF_TRACE !== '0'
const preloadAutotestEnabled = process.env.ONWARD_AUTOTEST === '1'
const MIRROR_WATCHER_STATUS_HISTORY_LIMIT = 100
const mirrorWatcherStatusHistory: unknown[] = []

if (preloadAutotestEnabled) {
  ipcRenderer.on(IPC.GIT_STATE_MIRROR_WATCHER_STATUS, (_event, status: unknown) => {
    mirrorWatcherStatusHistory.push(status)
    if (mirrorWatcherStatusHistory.length > MIRROR_WATCHER_STATUS_HISTORY_LIMIT) {
      mirrorWatcherStatusHistory.splice(
        0,
        mirrorWatcherStatusHistory.length - MIRROR_WATCHER_STATUS_HISTORY_LIMIT
      )
    }
  })
}

/**
 * Wrap an ipcRenderer.invoke() call with a renderer-side latency span.
 * Recorded as `ph='X'` (dur=ms) so Perfetto SQL can group it alongside
 * main-side IPC hot-path slices and the renderer input events that
 * triggered them. Emission path mirrors perfTrace(): ipcRenderer.send to
 * DEBUG_PERF_TRACE; main-side logger tags the event onto the renderer
 * thread track via the forwarding handler in ipc-handlers.ts.
 *
 * If `terminalId` is provided in `extra`, the event is routed onto the
 * per-Task virtual tid on the renderer side instead of the default
 * WebContents track.
 */
async function traceIpc<T>(eventName: string, extra: Record<string, unknown>, thunk: () => Promise<T>): Promise<T> {
  if (!preloadPerfTraceEnabled) return thunk()
  const startedAt = performance.now()
  const { terminalId, ...rest } = extra as Record<string, unknown> & { terminalId?: string }
  try {
    const value = await thunk()
    ipcRenderer.send(IPC.DEBUG_PERF_TRACE, {
      event: eventName,
      data: { ...rest, ok: true, durationMs: +(performance.now() - startedAt).toFixed(1) },
      terminalId
    })
    return value
  } catch (error) {
    ipcRenderer.send(IPC.DEBUG_PERF_TRACE, {
      event: eventName,
      data: { ...rest, ok: false, durationMs: +(performance.now() - startedAt).toFixed(1), error: String(error) },
      terminalId
    })
    throw error
  }
}

export interface TerminalOptions {
  cols?: number
  rows?: number
  cwd?: string
}

export type TerminalReadMode = 'full' | 'tail-lines' | 'tail-chars'

export interface TerminalBufferOptions {
  mode?: TerminalReadMode
  lastLines?: number
  lastChars?: number
  trimTrailingEmpty?: boolean
}

export interface TerminalBufferResult {
  success: boolean
  terminalId: string
  content?: string
  totalLines?: number
  returnedLines?: number
  returnedChars?: number
  truncated?: boolean
  capturedAt?: number
  error?: string
}

export type ReleaseChannel = 'daily' | 'dev' | 'stable' | 'unknown'
export type ReleaseOs = 'macos' | 'windows' | 'linux' | 'unknown'
export type RuntimePlatform = 'darwin' | 'win32' | 'linux' | 'unknown'
export type UpdatePhase = 'idle' | 'checking' | 'available' | 'downloading' | 'downloaded' | 'up-to-date' | 'unsupported' | 'error'
export type DownloadErrorCode =
  | 'offline'
  | 'connection-failed'
  | 'timeout'
  | 'stalled'
  | 'http-error'
  | 'checksum-mismatch'
  | 'disk-error'
  | 'aborted'

export type PromptBridgeAction = 'send' | 'execute' | 'send-and-execute'

export interface PromptBridgeSendRequest {
  requestId: string
  terminalId: string
  content: string
  action: PromptBridgeAction
  traceFlowId?: string
}

export interface PromptBridgeSendResult {
  success: boolean
  successIds: string[]
  sentOnlyIds: string[]
  failedIds: string[]
  issues?: Array<{
    terminalId: string
    status: 'sent-only' | 'failed'
    reason: 'unsafe-multiline-send' | 'unsafe-multiline-execute' | 'send-failed' | 'execute-failed'
    message: string
    error?: string
  }>
  error?: string
}

export interface TerminalInputSequencePayload {
  kind: 'raw' | 'paste'
  content: string
  traceContext?: PerformanceTraceContext
}

export interface PerformanceTraceContext {
  traceFlowId?: string
}

export interface PerformanceTraceRendererEvent {
  name: string
  cat?: string
  ph?: 'X' | 'i' | 'C' | 'M' | 's' | 't' | 'f'
  ts?: number
  dur?: number
  tid?: number
  id?: string
  scope?: 'g' | 'p' | 't'
  args?: Record<string, string | number | boolean | null | string[] | number[] | boolean[] | undefined>
}

export interface PerformanceTraceStatus {
  enabled: boolean
  captureContent: boolean
  initialized: boolean
  filePath: string | null
  eventCount: number
  droppedEvents: number
  // Of droppedEvents, the subset dropped by the per-name rate limiter (EXPECTED
  // decimation of high-frequency events). droppedEvents - rateLimitedDropped is
  // genuine store-failure loss.
  rateLimitedDropped: number
}

export interface DebugApiTerminalWriteResult {
  ok: boolean
  status: number
  body?: string
  error?: string
}

export type TerminalShellKind = 'posix' | 'powershell' | 'cmd' | 'unknown'

export interface TerminalInputCapabilities {
  bracketedPasteEnabled: boolean
  shellKind: TerminalShellKind
}

export interface TerminalAPI {
  create: (id: string, options?: TerminalOptions) => Promise<{ success: boolean; id?: string; error?: string }>
  write: (id: string, data: string, traceContext?: PerformanceTraceContext) => Promise<boolean>
  resize: (id: string, cols: number, rows: number) => Promise<boolean>
  sendInputSequence: (
    id: string,
    payload: TerminalInputSequencePayload
  ) => Promise<{ ok: boolean; phase?: 'content' | 'enter'; error?: string }>
  getInputCapabilities: (id: string) => Promise<TerminalInputCapabilities>
  setBufferFastPath: (id: string, enabled: boolean) => void
  setOutputVisibility: (id: string, visible: boolean) => void
  notifyInteractiveInput: (id: string) => void
  dispose: (id: string) => Promise<boolean>
  onData: (callback: (id: string, data: string) => void) => () => void
  onExit: (callback: (id: string, exitCode: number, signal?: number) => void) => () => void
  onGetBufferRequest: (callback: (requestId: string, terminalId: string, options?: TerminalBufferOptions) => void) => () => void
  sendBufferResponse: (requestId: string, result: TerminalBufferResult) => void
  onPromptBridgeSend: (callback: (request: PromptBridgeSendRequest) => void) => () => void
  sendPromptBridgeResponse: (requestId: string, result: PromptBridgeSendResult) => void
}

export interface Prompt {
  id: string
  title: string
  content: string
  createdAt: number
  updatedAt: number
}

export interface PromptAPI {
  load: () => Promise<Prompt[]>
  save: (prompt: Prompt) => Promise<boolean>
  delete: (id: string) => Promise<boolean>
}

export interface TerminalWindowConfig {
  version: number
  layoutMode: 1 | 2 | 4 | 6 | 8
  activeTerminalId: string | null
  activePanel: 'prompt' | null
  terminals: { id: string; title: string }[]
  promptPanelWidth: number
  updatedAt: number
}

export interface TerminalConfigAPI {
  load: () => Promise<TerminalWindowConfig>
  save: (config: TerminalWindowConfig) => Promise<boolean>
  update: (partial: Partial<TerminalWindowConfig>) => Promise<boolean>
}

export interface DialogAPI {
  openDirectory: () => Promise<{ success: boolean; path?: string; canceled?: boolean; error?: string }>
  openTextFile: (payload?: {
    title?: string
    filters?: Array<{ name: string; extensions: string[] }>
  }) => Promise<{ success: boolean; path?: string; content?: string; canceled?: boolean; error?: string }>
  saveTextFile: (payload: {
    title?: string
    defaultFileName?: string
    content: string
  }) => Promise<{ success: boolean; path?: string; canceled?: boolean; error?: string }>
}

export interface ShellAPI {
  openPath: (path: string) => Promise<{ success: boolean; error?: string }>
  openExternal: (url: string) => Promise<{
    success: boolean
    canceled?: boolean
    blocked?: boolean
    error?: string
  }>
}

export interface ClipboardAPI {
  writeText: (text: string) => Promise<boolean>
  readText: () => Promise<string>
}

export interface CommandPreset {
  id: string
  command: string
  isBuiltin: boolean
  createdAt: number
}

export interface CommandPresetAPI {
  load: () => Promise<CommandPreset[]>
  save: (preset: CommandPreset) => Promise<boolean>
  delete: (id: string) => Promise<boolean>
}

export interface LocalPrompt {
  id: string
  title: string
  content: string
  pinned: false
  color?: 'red' | 'yellow' | 'green' | null
  createdAt: number
  updatedAt: number
  lastUsedAt: number
}

export interface GlobalPrompt {
  id: string
  title: string
  content: string
  pinned: true
  color?: 'red' | 'yellow' | 'green' | null
  createdAt: number
  updatedAt: number
  lastUsedAt: number
}

export interface PromptCleanupConfig {
  autoEnabled: boolean
  autoKeepDays: number
  autoDeleteColored: boolean
  lastAutoCleanupAt: number | null
}

export interface EditorDraft {
  title: string
  content: string
  height: number
  savedAt: number
}

export interface PersistedTerminalState {
  id: string
  customName: string | null
  /**
   * Repo root in scope when the user last manually renamed this Task. Marks the
   * customName as a manual override so auto-follow does not overwrite it. MUST
   * round-trip across persistence — see persisted-terminal.ts.
   */
  manualNameRepoRoot: string | null
  lastCwd: string | null
}

export type PresetCount = 1 | 2 | 4 | 6 | 8

export interface CustomLayoutCell {
  rowStart: 1 | 2
  rowSpan: 1 | 2
  colStart: 1 | 2 | 3 | 4
  colSpan: 1 | 2 | 3 | 4
}

export interface CustomLayoutPreset {
  id: string
  name: string
  cells: CustomLayoutCell[]
  createdAt: number
}

export type LayoutMode =
  | { kind: 'preset'; count: PresetCount }
  | { kind: 'custom'; presetId: string }

export interface TabState {
  id: string
  customName: string | null
  createdAt: number
  layoutMode: LayoutMode
  activePanel: 'prompt' | null
  promptPanelWidth: number
  promptEditorHeight: number
  activeTerminalId: string | null
  terminals: PersistedTerminalState[]
  localPrompts: LocalPrompt[]
  editorDraft?: EditorDraft
  /** Deprecated: prompt input mode now lives in AppState.uiPreferences.promptInputMode. */
  promptInputMode?: 'canvas' | 'line'
  /** Deprecated migration marker for legacy per-Tab prompt input mode. */
  promptInputModePreferenceVersion?: number
}

export interface AppState {
  activeTabId: string
  tabs: TabState[]
  globalPrompts: GlobalPrompt[]
  promptCleanup: PromptCleanupConfig
  lastFocusedTerminalId: string | null
  projectEditorStates?: Record<string, unknown>
  promptSchedules?: unknown[]
  customLayoutPresets?: CustomLayoutPreset[]
  updatedAt: number
}

export interface AppStateAPI {
  load: () => Promise<AppState>
  save: (state: AppState) => Promise<boolean>
  savePatch: (patch: Partial<AppState>) => Promise<boolean>
  flush: () => Promise<boolean>
  onFlushPendingState: (callback: () => void | Promise<void>) => void
}

export type GitChangeType = 'unstaged' | 'staged' | 'untracked' | 'conflict'
export type GitResourceGroup = 'workingTree' | 'index' | 'untracked' | 'merge'
export type GitResourceRef = 'HEAD' | 'index' | 'workingTree' | 'empty'
export type GitStatusCode = 'M' | 'A' | 'D' | 'R' | 'C' | '?' | '!'

export interface GitSubmoduleInfo {
  name: string
  path: string
  repoRoot: string
  depth: number
  parentRoot: string
}

export interface GitRepoContext {
  root: string
  label: string
  isSubmodule: boolean
  depth: number
  changeCount: number
  loading?: boolean
}

// Git file status
export interface GitFileStatus {
  filename: string
  originalFilename?: string
  status: GitStatusCode
  additions: number
  deletions: number
  changeType: GitChangeType
  resourceGroup: GitResourceGroup
  originalRef: GitResourceRef | null
  modifiedRef: GitResourceRef | null
  repoRoot?: string
  repoLabel?: string
  isSubmoduleEntry?: boolean
}

// Git Diff results
export interface GitDiffResult {
  success: boolean
  cwd: string
  isGitRepo: boolean
  gitInstalled: boolean
  files: GitFileStatus[]
  repos?: GitRepoContext[]
  superprojectRoot?: string
  submodulesLoading?: boolean
  error?: string
}

export interface GitDiffLoadOptions {
  scope?: 'root-only' | 'full'
  force?: boolean
  background?: boolean
}

export interface GitCommitInfo {
  sha: string
  shortSha: string
  parents: string[]
  summary: string
  body: string
  authorName: string
  authorEmail: string
  authorDate: string
  refs?: string
}

export interface GitHistoryResult {
  success: boolean
  cwd: string
  isGitRepo: boolean
  gitInstalled: boolean
  commits: GitCommitInfo[]
  totalCount?: number
  repos?: GitRepoContext[]
  superprojectRoot?: string
  error?: string
}

export interface GitHistoryFile {
  filename: string
  originalFilename?: string
  status: GitStatusCode
  additions: number
  deletions: number
  isImage?: boolean
  isSvg?: boolean
}

export interface GitHistoryDiffOptions {
  base: string
  head: string
  filePath?: string
  hideWhitespace?: boolean
  includeFiles?: boolean
}

export interface GitHistoryDiffResult {
  success: boolean
  cwd: string
  isGitRepo: boolean
  gitInstalled: boolean
  base: string
  head: string
  patch: string
  files: GitHistoryFile[]
  error?: string
}

export interface GitHistoryFileContentOptions {
  base: string
  head: string
  file: Pick<GitHistoryFile, 'filename' | 'originalFilename' | 'status'>
  allowLargeFile?: boolean
}

export type TerminalGitStatus = 'clean' | 'modified' | 'added' | 'deleted' | 'mixed' | 'unknown'

export interface TerminalGitInfo {
  cwd: string | null
  repoRoot: string | null
  branch: string | null
  repoName: string | null
  status: TerminalGitStatus | null
}

export type GitDiffContentCacheMissReason =
  | 'first-load'
  | 'invalidated-mutation'
  | 'invalidated-watch'
  | 'invalidated-mirror'
  | 'invalidated-refresh'
  | 'renderer-force-refresh'
  | 'project-queue-evicted'
  | 'single-file-too-large'
  | 'precompute-pending'
  | 'entry-not-warmed'
  | 'worker-error'

export type GitDiffContentCacheSource =
  | 'renderer-memory'
  | 'main-content-cache'
  | 'worker-rebuild'

export interface GitDiffContentCacheInfo {
  state: 'hit' | 'miss'
  source: GitDiffContentCacheSource
  missReason?: GitDiffContentCacheMissReason
  project?: string
  key?: string
  stored?: boolean
  bytes?: number
}

export interface GitFileContentRequestOptions {
  force?: boolean
  missReason?: GitDiffContentCacheMissReason
  allowLargeFile?: boolean
  priority?: 'high' | 'normal' | 'low'
}

export interface GitFileContentResult {
  success: boolean
  cwd: string
  filename: string
  originalContent: string
  modifiedContent: string
  isBinary: boolean
  isImage?: boolean
  isSvg?: boolean
  originalImageUrl?: string
  modifiedImageUrl?: string
  originalImageSize?: number
  modifiedImageSize?: number
  requiresLargeFileConfirmation?: boolean
  largeFileSizeBytes?: number
  largeFileThresholdBytes?: number
  cacheInfo?: GitDiffContentCacheInfo
  error?: string
}

export interface GitHistoryFileContentResult extends GitFileContentResult {
  base: string
  head: string
}

export interface GitFileSaveResult {
  success: boolean
  filename: string
  error?: string
}

export interface GitFileActionResult {
  success: boolean
  filename: string
  error?: string
}

export type ProjectEntryType = 'file' | 'dir'

export interface ProjectEntry {
  name: string
  path: string
  type: ProjectEntryType
}

export interface ProjectListResult {
  success: boolean
  root: string
  path: string
  entries: ProjectEntry[]
  error?: string
}

export type ProjectFileOpenMode = 'auto' | 'text' | 'binary'
export type ProjectFileResolvedOpenMode = 'text' | 'large-text' | 'binary'
export type ProjectFileChunkMode = 'text' | 'binary'

export interface ProjectReadOptions {
  openMode?: ProjectFileOpenMode
}

export interface ProjectReadResult {
  success: boolean
  root: string
  path: string
  content: string
  isBinary: boolean
  isImage: boolean
  isSqlite: boolean
  isPdf?: boolean
  isEpub?: boolean
  isHtml?: boolean
  previewUrl?: string
  previewPath?: string
  sizeBytes?: number
  openMode?: ProjectFileResolvedOpenMode
  requiresConfirmation?: boolean
  requiresOpenChoice?: boolean
  readOnly?: boolean
  extension?: string
  error?: string
}

export interface ProjectFileChunkResult {
  success: boolean
  root: string
  path: string
  offset: number
  requestedLength: number
  bytesRead: number
  sizeBytes: number
  text?: string
  base64?: string
  error?: string
}

export interface ProjectSaveResult {
  success: boolean
  root: string
  path: string
  error?: string
}

export interface ProjectActionResult {
  success: boolean
  root: string
  path: string
  error?: string
}

export interface ProjectRenameResult {
  success: boolean
  root: string
  oldPath: string
  newPath: string
  error?: string
}

export type SqliteBlobValue = {
  type: 'blob'
  base64: string
  bytes: number
}

export type SqliteValue = string | number | null | SqliteBlobValue

export interface SqliteColumnInfo {
  name: string
  type: string
  notNull: boolean
  primaryKeyOrder: number
  hasDefault: boolean
}

export interface SqliteTableInfo {
  name: string
  rowCount: number
  columns: SqliteColumnInfo[]
  hasRowid: boolean
  editable: boolean
}

export type SqliteRowKey =
  | { kind: 'rowid'; rowid: number }
  | { kind: 'primary-key'; values: Record<string, SqliteValue> }

export interface SqliteRow {
  key: SqliteRowKey
  values: Record<string, SqliteValue>
}

export interface ProjectSqliteSchemaResult {
  success: boolean
  root: string
  path: string
  tables: SqliteTableInfo[]
  error?: string
}

export interface ProjectSqliteRowsResult {
  success: boolean
  root: string
  path: string
  table: string
  columns: SqliteColumnInfo[]
  rows: SqliteRow[]
  totalRows: number
  limit: number
  offset: number
  hasRowid: boolean
  editable: boolean
  error?: string
}

export interface ProjectSqliteMutationResult {
  success: boolean
  root: string
  path: string
  table: string
  changes: number
  lastInsertRowid?: number | null
  error?: string
}

export interface ProjectSqliteExecuteResult {
  success: boolean
  root: string
  path: string
  mode: 'rows' | 'run' | 'exec'
  columns: string[]
  rows: Array<Record<string, SqliteValue>>
  changes: number
  lastInsertRowid: number | null
  truncated: boolean
  error?: string
}

export interface ProjectSearchOptions {
  searchId?: string
  rootPath: string
  query: string
  isRegex: boolean
  isCaseSensitive: boolean
  isWholeWord: boolean
  includeGlob?: string
  excludeGlob?: string
  maxResults?: number
}

export interface ProjectSearchMatch {
  file: string
  line: number
  column: number
  matchLength: number
  lineContent: string
}

export interface ProjectSearchStats {
  searchId: string
  matchCount: number
  fileCount: number
  durationMs: number
  cancelled: boolean
}

// Git API
export interface GitAPI {
  resolveRepoRoot: (cwd: string) => Promise<string>
  getDiff: (cwd: string, options?: GitDiffLoadOptions) => Promise<GitDiffResult>
  getHistory: (cwd: string, options?: { limit?: number; skip?: number }) => Promise<GitHistoryResult>
  getHistoryDiff: (cwd: string, options: GitHistoryDiffOptions) => Promise<GitHistoryDiffResult>
  getHistoryFileContent: (cwd: string, options: GitHistoryFileContentOptions) => Promise<GitHistoryFileContentResult>
  getFileContent: (cwd: string, file: Pick<GitFileStatus, 'filename' | 'status' | 'originalFilename' | 'changeType' | 'isSubmoduleEntry'>, repoRoot?: string, options?: GitFileContentRequestOptions) => Promise<GitFileContentResult>
  saveFileContent: (cwd: string, filename: string, content: string) => Promise<GitFileSaveResult>
  stageFile: (cwd: string, filename: string, repoRoot?: string) => Promise<GitFileActionResult>
  unstageFile: (cwd: string, filename: string, repoRoot?: string) => Promise<GitFileActionResult>
  discardFile: (cwd: string, file: Pick<GitFileStatus, 'filename' | 'changeType' | 'status' | 'isSubmoduleEntry'>, repoRoot?: string) => Promise<GitFileActionResult>
  getSubmodules: (cwd: string) => Promise<GitSubmoduleInfo[]>
  updateIndexContent: (cwd: string, filename: string, content: string) => Promise<GitFileActionResult>
  checkInstalled: () => Promise<boolean>
  getTerminalCwd: (terminalId: string) => Promise<string | null>
  getTerminalInfo: (terminalId: string) => Promise<TerminalGitInfo>
  subscribeTerminalInfo: (terminalId: string) => Promise<{ success: true }>
  unsubscribeTerminalInfo: (terminalId: string) => Promise<{ success: true }>
  notifyTerminalActivity: (terminalId: string) => Promise<{ success: true }>
  notifyTerminalFocus: (terminalId: string) => Promise<{ success: true }>
  notifyTerminalGitUpdate: (terminalId: string) => Promise<{ success: true }>
  warmDiffCache: (cwd: string) => Promise<{ success: boolean }>
  onTerminalInfo: (callback: (terminalId: string, info: TerminalGitInfo) => void) => () => void
  // Subscribe to backend cache invalidation events. Fires when an FS event
  // under a watched cwd debounces (180 ms window), or when a force=true
  // request lands. Use this to refetch an open Git Diff view rather than
  // polling. Returns an unsubscribe function.
  onDiffCacheInvalidated: (callback: (cwd: string, reason: 'watcher' | 'watcher-error' | 'force' | 'lru' | 'manual' | 'mirror') => void) => () => void

  // ─── GitStateMirror (worker-thread mirror, pub/sub) ──────────────────
  // Renderer code typically goes through `useGitStateMirror(cwd)` (commit 6)
  // rather than calling these directly, but the raw surface is here so any
  // consumer that doesn't fit the React hook pattern (debug API, autotest)
  // can subscribe + listen explicitly.
  /**
   * Subscribe to mirror updates for `cwd`. The first await resolves to
   * the current snapshot (or null if the mirror hasn't computed it yet).
   * Subsequent state changes arrive via `onMirrorUpdate(cwd)`.
   */
  subscribeMirror: (cwd: string) => Promise<unknown | null>
  unsubscribeMirror: (cwd: string) => void
  /** Imperative one-shot read of the current snapshot (no subscription). */
  getMirror: (cwd: string) => Promise<unknown | null>
  /**
   * Listen to mirror deltas. Returns an unsubscribe function. The callback
   * receives `(cwd, delta)` where `delta` is a partial `MirrorState`.
   */
  onMirrorUpdate: (callback: (cwd: string, delta: unknown) => void) => () => void
  /**
   * Listen to GitStateMirror watcher supervisor health transitions.
   * Recovering/degraded/suspended states are fallback health, not stale
   * terminal state by themselves; watcher-error remains the hard failure
   * channel.
   */
  onMirrorWatcherStatus: (callback: (status: unknown) => void) => () => void
  /**
   * Listen for hard parcel-watcher failures after fallback refresh has
   * failed. Recovering/degraded/suspended states arrive through
   * `onMirrorWatcherStatus`.
   */
  onMirrorWatcherError: (callback: (cwd: string, message: string) => void) => () => void
  /**
   * Push a cwd-changed notification (e.g. parsed from an OSC 633 / 7
   * sequence in the renderer's xterm.js). Fire-and-forget — the mirror
   * router routes to the worker.
   */
  pushCwd: (terminalId: string, newCwd: string | null) => void
  /**
   * Notification that `pushCwd`'s raw value was rejected by the main-side
   * filesystem check. The renderer-side OSC handler commits the raw cwd
   * synchronously to `oscDetectedCwds` for the <50 ms latency win; this
   * back-channel lets us roll back phantom commits (free-text OSC 7
   * payloads, mistyped CurrentDir, deleted directories the OSC handler
   * raced with). The renderer matches by `(terminalId, rawCwd)` and only
   * clears the entry when the speculative value is still pinned to the
   * rejected raw cwd.
   */
  onMirrorCwdRejected: (callback: (terminalId: string, rawCwd: string) => void) => () => void
  /** Request the diff body for a single file via the mirror's stat-token cache. */
  requestFileBody: (cwd: string, fileKey: string, force: boolean) => Promise<unknown | null>
  /**
   * Phase 5 PART 2 — Refresh Changes path. Bumps the mirror's generation
   * counter for `cwd` and forces a recompute. The renderer should react
   * to the next mirror-update by re-mounting its DiffEditor (the new
   * generation cascades into the React key).
   */
  forceRefresh: (cwd: string) => Promise<boolean>
}

// Project Editor API
export interface ProjectAPI {
  listDirectory: (root: string, path: string) => Promise<ProjectListResult>
  buildFileIndex: (root: string) => Promise<string[]>
  searchFilenames: (root: string, query: string, limit?: number) => Promise<string[]>
  invalidateFileIndex: (root: string) => Promise<{ success: boolean }>
  readFile: (root: string, path: string, options?: ProjectReadOptions) => Promise<ProjectReadResult>
  /**
   * Batch existence check for project files. Returns a parallel boolean
   * array indicating whether each path exists. Use this for quick-file
   * list validation — never `readFile` (which transfers the whole content).
   */
  filesExist: (root: string, paths: string[]) => Promise<boolean[]>
  readFileChunk: (root: string, path: string, offset: number, length: number, mode: ProjectFileChunkMode) => Promise<ProjectFileChunkResult>
  saveFile: (root: string, path: string, content: string) => Promise<ProjectSaveResult>
  createFile: (root: string, path: string, content?: string) => Promise<ProjectActionResult>
  createFolder: (root: string, path: string) => Promise<ProjectActionResult>
  renamePath: (root: string, oldPath: string, newPath: string) => Promise<ProjectRenameResult>
  deletePath: (root: string, path: string) => Promise<ProjectActionResult>
  sqliteGetSchema: (root: string, path: string) => Promise<ProjectSqliteSchemaResult>
  sqliteReadTableRows: (root: string, path: string, table: string, limit?: number, offset?: number) => Promise<ProjectSqliteRowsResult>
  sqliteInsertRow: (root: string, path: string, table: string, values: Record<string, unknown>) => Promise<ProjectSqliteMutationResult>
  sqliteUpdateRow: (root: string, path: string, table: string, key: SqliteRowKey, values: Record<string, unknown>) => Promise<ProjectSqliteMutationResult>
  sqliteDeleteRow: (root: string, path: string, table: string, key: SqliteRowKey) => Promise<ProjectSqliteMutationResult>
  sqliteExecute: (root: string, path: string, sql: string) => Promise<ProjectSqliteExecuteResult>
  searchStart: (options: ProjectSearchOptions) => Promise<{ searchId: string }>
  searchCancel: () => Promise<{ success: boolean }>
  onSearchResult: (callback: (searchId: string, matches: ProjectSearchMatch[]) => void) => () => void
  onSearchDone: (callback: (stats: ProjectSearchStats) => void) => () => void
  watchFile: (root: string, path: string) => Promise<{ success: boolean; error?: string }>
  unwatchFile: (root: string, path: string) => Promise<{ success: boolean }>
  onFileChanged: (callback: (fullPath: string, changeType: 'changed' | 'deleted', content?: string) => void) => () => void
  watchImageFiles: (root: string, paths: string[]) => Promise<{ success: boolean }>
  unwatchImageFiles: (root: string, paths: string[]) => Promise<{ success: boolean }>
  unwatchAllImageFiles: () => Promise<{ success: boolean }>
  onImageFileChanged: (callback: (relativePath: string) => void) => () => void
  treeWatchStart: (cwd: string) => Promise<{ success: boolean }>
  treeWatchStop: (cwd: string) => Promise<{ success: boolean }>
  onTreeWatchEvent: (
    callback: (event: { cwd: string; added: string[]; removed: string[]; resync?: boolean }) => void
  ) => () => void
}

// Shortcut configuration
export interface ShortcutConfig {
  focusTerminal1: string | null
  focusTerminal2: string | null
  focusTerminal3: string | null
  focusTerminal4: string | null
  focusTerminal5: string | null
  focusTerminal6: string | null
  switchTab1: string | null
  switchTab2: string | null
  switchTab3: string | null
  switchTab4: string | null
  switchTab5: string | null
  switchTab6: string | null
  activateAndFocusPrompt: string | null
  addToHistory: string | null
  focusPromptEditor: string | null
  terminalGitDiff: string | null
  terminalGitHistory: string | null
  terminalChangeWorkDir: string | null
  terminalOpenWorkDir: string | null
  terminalProjectEditor: string | null
  viewGitDiff: string | null
}

// Terminal style configuration
export interface TerminalStyleConfig {
  terminalId: string
  foregroundColor: string | null
  backgroundColor: string | null
  fontFamily: string | null
  fontSize: number | null
  gitDiffFontSize: number | null
}

export interface GlobalTerminalStyle {
  foregroundColor: string | null
  backgroundColor: string | null
  fontFamily: string | null
  fontSize: number | null
  gitDiffFontSize: number | null
}

// Complete settings state
export interface SettingsState {
  version: number
  shortcuts: ShortcutConfig
  terminalStyles: Record<string, TerminalStyleConfig>
  globalTerminalStyle: GlobalTerminalStyle
  gitDiffFontSize: number | null
  settingsPanelWidth: number
  language: 'en' | 'zh-CN'
  performanceDiagnosticsEnabled: boolean
  updatedAt: number
}

// Shortcut action type
export type ShortcutAction =
  | { type: 'focusTerminal'; index: number }
  | { type: 'switchTab'; index: number }
  | { type: 'activateAndFocusPrompt' }
  | { type: 'addToHistory' }
  | { type: 'focusPromptEditor' }
  | { type: 'terminalGitDiff' }
  | { type: 'terminalGitHistory' }
  | { type: 'terminalChangeWorkDir' }
  | { type: 'terminalOpenWorkDir' }
  | { type: 'terminalProjectEditor' }
  | { type: 'viewGitDiff' }

// Settings API
export interface SettingsAPI {
  load: () => Promise<SettingsState>
  save: (settings: SettingsState) => Promise<boolean>
  update: (partial: Partial<SettingsState>) => Promise<boolean>
  registerShortcuts: () => Promise<boolean>
  checkShortcutAvailable: (accelerator: string) => Promise<boolean>
  checkShortcutConflict: (accelerator: string, excludeKey?: string) => Promise<string | null>
  onShortcutTriggered: (callback: (action: ShortcutAction) => void) => () => void
  onWindowShortcutTriggered: (callback: (action: ShortcutAction) => void) => () => void
  onActivated: (callback: () => void) => () => void
}

export interface AppInfo {
  buildChannel: 'dev' | 'prod'
  branch: string | null
  tag: string | null
  releaseChannel: ReleaseChannel
  releaseOs: ReleaseOs
  platform: RuntimePlatform
  platformVersion: string
  version: string
  productName: string
  displayName: string
  isPackaged: boolean
}

export interface AppInfoAPI {
  get: () => Promise<AppInfo>
  readNotice: () => Promise<string | null>
  getPdfViewerUrl: () => Promise<string>
}

export type ChangelogLocale = 'en' | 'zh-CN'
export type ChangelogChannel = 'daily' | 'stable'
export type ChangelogReadReason = 'no-tag' | 'index-missing' | 'entry-missing' | 'file-missing' | 'invalid-index' | 'read-failed'

export interface ChangelogEntry {
  tag: string
  version: string
  channel: ChangelogChannel
  previousTag: string | null
  publishedAt: string | null
  markdown: {
    en: string
    'zh-CN'?: string
  }
  html?: {
    en: string
    'zh-CN'?: string
  }
}

export interface CurrentChangelogResult {
  success: boolean
  locale: ChangelogLocale
  tag: string | null
  entry?: ChangelogEntry
  html?: string
  content?: string
  reason?: ChangelogReadReason
  error?: string
}

export interface ChangelogAPI {
  getCurrent: (locale?: string) => Promise<CurrentChangelogResult>
}

export interface UpdaterStatus {
  phase: UpdatePhase
  supported: boolean
  currentVersion: string
  currentTag: string | null
  currentChannel: ReleaseChannel
  currentReleaseOs: ReleaseOs
  targetVersion: string | null
  targetTag: string | null
  downloadedFileName: string | null
  lastCheckedAt: number | null
  error: string | null
  errorCode: DownloadErrorCode | null
  bannerDismissed: boolean
  downloadProgress: DownloadProgress | null
}

export interface DownloadProgress {
  downloadedBytes: number
  totalBytes: number
  percent: number
  bytesPerSecond: number
}

export interface UpdaterAPI {
  getStatus: () => Promise<UpdaterStatus>
  checkNow: () => Promise<UpdaterStatus>
  downloadNow: () => Promise<UpdaterStatus>
  restartToUpdate: () => Promise<{ success: boolean; error?: string }>
  dismissBanner: () => Promise<UpdaterStatus>
  onStatusChanged: (callback: (status: UpdaterStatus) => void) => () => void
}

export interface GitRuntimeLatencySummary {
  count: number
  avgMs: number
  p50Ms: number
  p95Ms: number
  maxMs: number
}

export interface GitRuntimeMetrics {
  scheduler: {
    inflightCurrent: number
    inflightPeak: number
    queueDepthCurrent: number
    queueDepthPeak: number
    dedupHits: number
    totalScheduled: number
    totalCompleted: number
    totalFailed: number
    maxInflight: number
    maxPerRepoInflight: number
  }
  kinds: {
    git: { scheduled: number; completed: number; failed: number; latency: GitRuntimeLatencySummary }
    cwd: { scheduled: number; completed: number; failed: number; latency: GitRuntimeLatencySummary }
    misc: { scheduled: number; completed: number; failed: number; latency: GitRuntimeLatencySummary }
  }
  latencies: {
    titleRefresh: GitRuntimeLatencySummary
    cwdProbe: GitRuntimeLatencySummary
  }
  updatedAt: number
}

export interface EventLoopStallMetrics {
  resetAt: number
  totalSamples: number
  stallCount: number
  maxDriftMs: number
  over100Ms: number
  over250Ms: number
  over500Ms: number
  over1000Ms: number
  over3000Ms: number
  over6000Ms: number
  lastStallAt: number | null
  recentStalls: Array<{ ts: number; driftMs: number }>
}

export interface PerfTraceInfo {
  enabled: boolean
  logPath: string | null
  latestPointerPath: string
  eventLoop: EventLoopStallMetrics
}

export interface GitDiffDebugStats {
  cache: {
    projects: Array<{
      project: string
      bytes: number
      entries: number
      entryDetails: Array<{
        key: string
        bytes: number
      }>
    }>
    totalBytes: number
    totalEntries: number
    projectByteLimit: number
    maxProjects: number
    singleFileByteLimit: number
  }
  scheduler: {
    totalBursts: number
    totalCancelled: number
    totalCompleted: number
    totalSkipped: number
    pendingProjects: string[]
    inFlightProjects: string[]
    perProject: Record<string, {
      pendingSince: number | null
      inFlightSince: number | null
      lastBurst: {
        finishedAt: number
        durationMs: number
        workingSetSize: number
        eligibleCount: number
        candidateCount: number
        completed: number
        skipped: number
      } | null
    }>
  }
  listCache: {
    entries: number
    inFlight: number
    hits: number
    misses: number
    forces: number
    ttlMs: number
    maxEntries: number
    lastEvent: {
      kind: 'hit' | 'miss' | 'force' | null
      key: string | null
      at: number | null
      ageMs: number | null
      entriesCleared: number | null
    }
  }
  watcher: {
    backend: 'mirror'
    active: number
    maxProjects: number
    projects: Array<{
      cwd: string
      status: 'registered' | 'disposed'
      eventCount: number
      resyncCount: number
      lastEventAt: number | null
      lastError: string | null
      pending: boolean
    }>
  }
}

export interface DebugAPI {
  enabled: boolean
  perfTraceEnabled: boolean
  featureFlags: {
    gitDiffPerformanceDiagnostics: boolean
  }
  profile: boolean
  profileCwd: string | null
  autotest: boolean
  autotestRealFileChoice: boolean
  autotestCwd: string | null
  autotestSuite: string | null
  autotestExit: boolean
  // Optional path to a JSON manifest written by a fixture builder. Used when
  // a single autotest needs to operate on multiple pre-built repos (e.g. the
  // submodule c/m/u filter suite needs both a "clean" and a "pointer-changed"
  // parent+submodule pair). Empty/null in normal runs.
  autotestFixtureExtra: string | null
  autotestHtmlFixturePath: string | null
  autotestHtmlExpectedTitle: string | null
  autotestHtmlExpectedText: string | null
  autotestHtmlSkipSaveFlow: boolean
  autotestGsmWatcherFailSubscribeOnce: boolean
  autotestGsmWatcherFailCallbackOnce: boolean
  autotestGsmWatcherSilent: boolean
  getMirrorWatcherStatusHistory: () => unknown[]
  perfTraceCaptureContent: boolean
  // ONWARD_DISABLE_VIRTUAL_CURSOR=1 disables the Prompt textarea's
  // click-anywhere virtual-cursor feature and falls back to plain
  // line-by-line input. Emergency revert switch only.
  virtualCursorDisabled: boolean
  log: (message: string, data?: unknown) => void
  focusWindow: () => Promise<boolean>
  getAppMetrics: () => Promise<Record<string, unknown>[]>
  getGitRuntimeMetrics: () => Promise<GitRuntimeMetrics>
  getMainWorkMetrics: () => Promise<Record<string, unknown>>
  getPerfTraceInfo: () => Promise<PerfTraceInfo>
  getGitDiffDebugStats: () => Promise<GitDiffDebugStats>
  resetPerfTraceMetrics: () => Promise<EventLoopStallMetrics>
  perfTrace: (event: string, data?: Record<string, unknown>, terminalId?: string) => void
  getApiServerPort: () => Promise<number>
  postApiTerminalWrite: (payload: { terminalId: string; text: string; execute: boolean }) => Promise<DebugApiTerminalWriteResult>
  recordPerfTrace: (event: PerformanceTraceRendererEvent) => void
  getPerfTraceStatus: () => Promise<PerformanceTraceStatus>
  flushPerfTrace: () => Promise<PerformanceTraceStatus>
  feedbackReset: () => Promise<void>
  feedbackSetMockIssues: (issues: FeedbackDebugRemoteIssue[]) => Promise<void>
  feedbackGetLastOpenedUrl: () => Promise<string | null>
  readTelemetryLog: () => Promise<string>
  emitBundleMarker: (
    uuid: string,
    label?: string
  ) => Promise<{ success: boolean; chunkPath?: string | null; error?: string }>
  quit: () => Promise<void>
}

export interface BrowserNavState {
  canGoBack: boolean
  canGoForward: boolean
  url: string
  title: string
  isLoading: boolean
}

export interface BrowserScrollState {
  x: number
  y: number
  scrollWidth: number
  scrollHeight: number
  clientWidth: number
  clientHeight: number
}

export interface BrowserFindInPageOptions {
  forward?: boolean
  findNext?: boolean
  matchCase?: boolean
}

export type BrowserStopFindInPageAction = 'clearSelection' | 'keepSelection' | 'activateSelection'

export interface BrowserFoundInPageResult {
  requestId: number
  activeMatchOrdinal: number
  matches: number
  selectionArea?: { x: number; y: number; width: number; height: number }
  finalUpdate: boolean
}

// Coding Agent integration types
export interface EnvVarEntry {
  key: string
  value: string
  masked?: boolean
}

export interface CodingAgentConfigInput {
  command: string
  executablePath?: string
  extraArgs?: string
  envVars?: EnvVarEntry[]
  alias?: string
}

export interface CodingAgentHistoryEntry {
  id: string
  command: string
  executablePath: string
  extraArgs: string
  envVars: EnvVarEntry[]
  alias: string
  createdAt: number
  lastUsedAt: number
}

export interface CodingAgentConfigState {
  version: number
  lastUsedId: string | null
  history: CodingAgentHistoryEntry[]
}

export interface CodingAgentConfigAPI {
  load: (command?: string) => Promise<CodingAgentConfigState>
  save: (config: CodingAgentConfigInput) => Promise<CodingAgentConfigState>
  update: (id: string, config: CodingAgentConfigInput) => Promise<CodingAgentConfigState>
  delete: (id: string) => Promise<CodingAgentConfigState>
}

export interface CodingAgentPrepareResult {
  success: boolean
  error?: string
}

export interface CodingAgentLaunchInput {
  terminalId: string
  config: CodingAgentConfigInput
  cols?: number
  rows?: number
}

export interface CodingAgentLaunchResult {
  success: boolean
  error?: string
}

export interface CodingAgentAPI {
  prepare: (command: string, executablePath?: string) => Promise<CodingAgentPrepareResult>
  launch: (payload: CodingAgentLaunchInput) => Promise<CodingAgentLaunchResult>
}

export interface BrowserAPI {
  create: (id: string, url?: string, options?: { allowFile?: boolean; fileRoot?: string; allowAnyFile?: boolean }) => Promise<{ success: boolean; id: string; error?: string }>
  destroy: (id: string) => Promise<boolean>
  navigate: (id: string, url: string) => Promise<boolean>
  goBack: (id: string) => Promise<boolean>
  goForward: (id: string) => Promise<boolean>
  reload: (id: string) => Promise<boolean>
  stop: (id: string) => Promise<boolean>
  setBounds: (id: string, rect: { x: number; y: number; width: number; height: number }) => Promise<boolean>
  show: (id: string) => Promise<boolean>
  hide: (id: string) => Promise<boolean>
  getNavState: (id: string) => Promise<BrowserNavState | null>
  clearCookies: (maxAge?: number) => Promise<{ removed: number }>
  setRememberCookies: (rememberCookies: boolean) => Promise<{ rememberCookies: boolean }>
  showCookieMenu: (options: { rememberCookies: boolean; labels: { remember: string; clearDay: string; clearWeek: string; clearAll: string } }) => Promise<{ action: string; rememberCookies?: boolean } | null>
  showAutoRefreshMenu: (options: { currentIntervalMs: number | null; labels: { off: string; items: Array<{ ms: number; label: string }> } }) => Promise<{ intervalMs: number | null } | null>
  evaluateForTest: (id: string, script: string) => Promise<{ success: boolean; value?: unknown; error?: string }>
  getZoomFactor: (id: string) => Promise<{ success: boolean; zoomFactor?: number; error?: string }>
  setZoomFactor: (id: string, zoomFactor: number) => Promise<{ success: boolean; zoomFactor?: number; error?: string }>
  getScrollState: (id: string) => Promise<{ success: boolean; state?: BrowserScrollState; error?: string }>
  restoreScrollState: (id: string, state: BrowserScrollState) => Promise<{ success: boolean; state?: BrowserScrollState; error?: string }>
  findInPage: (id: string, text: string, options?: BrowserFindInPageOptions) => Promise<{ success: boolean; requestId?: number; error?: string }>
  stopFindInPage: (id: string, action?: BrowserStopFindInPageAction) => Promise<boolean>
  onUrlChanged: (callback: (id: string, url: string) => void) => () => void
  onTitleChanged: (callback: (id: string, title: string) => void) => () => void
  onLoadingChanged: (callback: (id: string, isLoading: boolean) => void) => () => void
  onNavStateChanged: (callback: (id: string, state: { canGoBack: boolean; canGoForward: boolean }) => void) => () => void
  onFullscreenChanged: (callback: (id: string, isFullscreen: boolean) => void) => () => void
  onEscapePressed: (callback: (id: string) => void) => () => void
  onFoundInPage: (callback: (id: string, result: BrowserFoundInPageResult) => void) => () => void
  onFindShortcutPressed: (callback: (id: string) => void) => () => void
  onReloadShortcutPressed: (callback: (id: string) => void) => () => void
  onZoomFactorChanged: (callback: (id: string, zoomFactor: number, source: 'renderer' | 'shortcut') => void) => () => void
}

export interface FeedbackDiagnosticBundleVerificationCheck {
  name: string
  passed: boolean
  detail?: string
}

export interface FeedbackDiagnosticBundleVerification {
  ok: boolean
  checks: FeedbackDiagnosticBundleVerificationCheck[]
}

export interface FeedbackDiagnosticBundleResult {
  success: boolean
  path?: string
  bytes?: number
  canceled?: boolean
  error?: string
  manifest?: {
    chunkCount: number
    chunkBytes: number
    stateFiles: string[]
    missingFiles: string[]
  }
  verification?: FeedbackDiagnosticBundleVerification
}

/**
 * Optional autotest payload for the diagnostic-bundle IPC. The
 * `expectedMarker` field drives the verifier's V10 closed-loop check
 * but is only honoured by the main side when `ONWARD_AUTOTEST=1`.
 * Production callers must pass nothing or just the path.
 */
export interface FeedbackDiagnosticBundleInvokeOptions {
  forceOutputPath?: string
  expectedMarker?: { uuid: string; label?: string }
}

export interface FeedbackAPI {
  load: () => Promise<FeedbackState>
  createSubmission: (payload: FeedbackSubmissionInput) => Promise<FeedbackCreateSubmissionResult>
  sync: (recordId?: string, force?: boolean) => Promise<FeedbackState>
  reopenInBrowser: (recordId: string) => Promise<FeedbackActionResult>
  updatePreferences: (payload: Partial<FeedbackState['preferences']>) => Promise<FeedbackState>
  removeRecord: (recordId: string) => Promise<FeedbackState>
  exportDiagnosticBundle: (
    forceOutputPath?: string,
    expectedMarker?: { uuid: string; label?: string }
  ) => Promise<FeedbackDiagnosticBundleResult>
}

export interface ElectronAPI {
  terminal: TerminalAPI
  prompt: PromptAPI
  terminalConfig: TerminalConfigAPI
  dialog: DialogAPI
  shell: ShellAPI
  commandPreset: CommandPresetAPI
  appState: AppStateAPI
  git: GitAPI
  project: ProjectAPI
  settings: SettingsAPI
  appInfo: AppInfoAPI
  changelog: ChangelogAPI
  updater: UpdaterAPI
  browser: BrowserAPI
  feedback: FeedbackAPI
  codingAgentConfig: CodingAgentConfigAPI
  codingAgent: CodingAgentAPI
  debug: DebugAPI
  platform: 'darwin' | 'win32' | 'linux'
}

const terminalAPI: TerminalAPI = {
  create: (id: string, options?: TerminalOptions) => {
    return ipcRenderer.invoke(IPC.TERMINAL_CREATE, id, options)
  },

  write: (id: string, data: string, traceContext?: PerformanceTraceContext) => {
    return traceIpc(
      PERF_TRACE_EVENT.RENDERER_IPC_TERMINAL_WRITE,
      { terminalId: id, bytes: data.length },
      () => ipcRenderer.invoke(IPC.TERMINAL_WRITE, id, data, traceContext)
    )
  },

  resize: (id: string, cols: number, rows: number) => {
    return ipcRenderer.invoke(IPC.TERMINAL_RESIZE, id, cols, rows)
  },

  sendInputSequence: (id: string, payload: TerminalInputSequencePayload) => {
    return ipcRenderer.invoke(IPC.TERMINAL_SEND_INPUT_SEQUENCE, id, payload)
  },

  getInputCapabilities: (id: string) => {
    return ipcRenderer.invoke(IPC.TERMINAL_GET_INPUT_CAPABILITIES, id)
  },

  setBufferFastPath: (id: string, enabled: boolean) => {
    ipcRenderer.send(IPC.TERMINAL_SET_BUFFER_FAST_PATH, id, enabled)
  },

  setOutputVisibility: (id: string, visible: boolean) => {
    ipcRenderer.send(IPC.TERMINAL_SET_OUTPUT_VISIBILITY, id, visible)
  },

  notifyInteractiveInput: (id: string) => {
    ipcRenderer.send(IPC.TERMINAL_NOTIFY_INTERACTIVE_INPUT, id)
  },

  dispose: (id: string) => {
    return ipcRenderer.invoke(IPC.TERMINAL_DISPOSE, id)
  },

  onData: (callback: (id: string, data: string) => void) => {
    const listener = (_: Electron.IpcRendererEvent, id: string, data: string) => {
      callback(id, data)
    }
    ipcRenderer.on(IPC.TERMINAL_DATA, listener)
    return () => {
      ipcRenderer.removeListener(IPC.TERMINAL_DATA, listener)
    }
  },

  onExit: (callback: (id: string, exitCode: number, signal?: number) => void) => {
    const listener = (_: Electron.IpcRendererEvent, id: string, exitCode: number, signal?: number) => {
      callback(id, exitCode, signal)
    }
    ipcRenderer.on(IPC.TERMINAL_EXIT, listener)
    return () => {
      ipcRenderer.removeListener(IPC.TERMINAL_EXIT, listener)
    }
  },

  onGetBufferRequest: (callback: (requestId: string, terminalId: string, options?: TerminalBufferOptions) => void) => {
    const listener = (_: Electron.IpcRendererEvent, requestId: string, terminalId: string, options?: TerminalBufferOptions) => {
      callback(requestId, terminalId, options)
    }
    ipcRenderer.on(IPC.TERMINAL_REQUEST_BUFFER, listener)
    return () => {
      ipcRenderer.removeListener(IPC.TERMINAL_REQUEST_BUFFER, listener)
    }
  },

  sendBufferResponse: (requestId: string, result: TerminalBufferResult) => {
    ipcRenderer.send(IPC.TERMINAL_BUFFER_RESPONSE, requestId, result)
  },

  onPromptBridgeSend: (callback: (request: PromptBridgeSendRequest) => void) => {
    const listener = (_: Electron.IpcRendererEvent, request: PromptBridgeSendRequest) => {
      callback(request)
    }
    ipcRenderer.on(IPC.PROMPT_BRIDGE_SEND, listener)
    return () => {
      ipcRenderer.removeListener(IPC.PROMPT_BRIDGE_SEND, listener)
    }
  },

  sendPromptBridgeResponse: (requestId: string, result: PromptBridgeSendResult) => {
    ipcRenderer.send(IPC.PROMPT_BRIDGE_RESPONSE, requestId, result)
  }
}

const promptAPI: PromptAPI = {
  load: () => {
    return ipcRenderer.invoke(IPC.PROMPT_LOAD)
  },

  save: (prompt: Prompt) => {
    return ipcRenderer.invoke(IPC.PROMPT_SAVE, prompt)
  },

  delete: (id: string) => {
    return ipcRenderer.invoke(IPC.PROMPT_DELETE, id)
  }
}

const terminalConfigAPI: TerminalConfigAPI = {
  load: () => {
    return ipcRenderer.invoke(IPC.TERMINAL_CONFIG_LOAD)
  },

  save: (config: TerminalWindowConfig) => {
    return ipcRenderer.invoke(IPC.TERMINAL_CONFIG_SAVE, config)
  },

  update: (partial: Partial<TerminalWindowConfig>) => {
    return ipcRenderer.invoke(IPC.TERMINAL_CONFIG_UPDATE, partial)
  }
}

const dialogAPI: DialogAPI = {
  openDirectory: () => {
    return ipcRenderer.invoke(IPC.DIALOG_OPEN_DIRECTORY)
  },
  openTextFile: (payload?: { title?: string; filters?: Array<{ name: string; extensions: string[] }> }) => {
    return ipcRenderer.invoke(IPC.DIALOG_OPEN_TEXT_FILE, payload)
  },
  saveTextFile: (payload: { title?: string; defaultFileName?: string; content: string }) => {
    return ipcRenderer.invoke(IPC.DIALOG_SAVE_TEXT_FILE, payload)
  }
}

const shellAPI: ShellAPI = {
  openPath: (path: string) => {
    return ipcRenderer.invoke(IPC.SHELL_OPEN_PATH, path)
  },
  openExternal: (url: string) => {
    return ipcRenderer.invoke(IPC.SHELL_OPEN_EXTERNAL, url)
  }
}

const clipboardAPI: ClipboardAPI = {
  writeText: (text: string) => {
    return ipcRenderer.invoke(IPC.CLIPBOARD_WRITE_TEXT, text)
  },
  readText: () => {
    return ipcRenderer.invoke(IPC.CLIPBOARD_READ_TEXT)
  }
}

const commandPresetAPI: CommandPresetAPI = {
  load: () => {
    return ipcRenderer.invoke(IPC.COMMAND_PRESET_LOAD)
  },

  save: (preset: CommandPreset) => {
    return ipcRenderer.invoke(IPC.COMMAND_PRESET_SAVE, preset)
  },

  delete: (id: string) => {
    return ipcRenderer.invoke(IPC.COMMAND_PRESET_DELETE, id)
  }
}

const appStateAPI: AppStateAPI = {
  load: () => {
    return ipcRenderer.invoke(IPC.APP_STATE_LOAD)
  },

  save: (state: AppState) => {
    return ipcRenderer.invoke(IPC.APP_STATE_SAVE, state)
  },

  savePatch: (patch: Partial<AppState>) => {
    return ipcRenderer.invoke(IPC.APP_STATE_SAVE_PATCH, patch)
  },

  flush: () => {
    return ipcRenderer.invoke(IPC.APP_STATE_FLUSH)
  },

  onFlushPendingState: (callback: () => void | Promise<void>) => {
    ipcRenderer.on(IPC.APP_STATE_FLUSH_PENDING, async () => {
      try {
        await callback()
      } catch (error) {
        console.error('[AppState] flush callback failed:', error)
      }
      ipcRenderer.send(IPC.APP_STATE_FLUSH_DONE)
    })
  }
}

const gitAPI: GitAPI = {
  resolveRepoRoot: (cwd: string) => {
    return ipcRenderer.invoke(IPC.GIT_RESOLVE_REPO_ROOT, cwd)
  },

  getDiff: (cwd: string, options?: GitDiffLoadOptions) => {
    return traceIpc(
      PERF_TRACE_EVENT.RENDERER_IPC_GIT_GET_DIFF,
      { scope: options?.scope ?? 'default' },
      () => ipcRenderer.invoke(IPC.GIT_GET_DIFF, cwd, options)
    )
  },

  getHistory: (cwd: string, options?: { limit?: number; skip?: number }) => {
    return ipcRenderer.invoke(IPC.GIT_GET_HISTORY, cwd, options)
  },

  getHistoryDiff: (cwd: string, options: GitHistoryDiffOptions) => {
    return ipcRenderer.invoke(IPC.GIT_GET_HISTORY_DIFF, cwd, options)
  },

  getHistoryFileContent: (cwd: string, options: GitHistoryFileContentOptions) => {
    return ipcRenderer.invoke(IPC.GIT_GET_HISTORY_FILE_CONTENT, cwd, options)
  },

  getFileContent: (cwd: string, file: Pick<GitFileStatus, 'filename' | 'status' | 'originalFilename' | 'changeType' | 'isSubmoduleEntry'>, repoRoot?: string, options?: GitFileContentRequestOptions) => {
    return ipcRenderer.invoke(IPC.GIT_GET_FILE_CONTENT, cwd, file, repoRoot, options)
  },

  saveFileContent: (cwd: string, filename: string, content: string) => {
    return ipcRenderer.invoke(IPC.GIT_SAVE_FILE_CONTENT, cwd, filename, content)
  },

  stageFile: (cwd: string, filename: string, repoRoot?: string) => {
    return ipcRenderer.invoke(IPC.GIT_STAGE_FILE, cwd, filename, repoRoot)
  },

  unstageFile: (cwd: string, filename: string, repoRoot?: string) => {
    return ipcRenderer.invoke(IPC.GIT_UNSTAGE_FILE, cwd, filename, repoRoot)
  },

  discardFile: (cwd: string, file: Pick<GitFileStatus, 'filename' | 'changeType' | 'status' | 'isSubmoduleEntry'>, repoRoot?: string) => {
    return ipcRenderer.invoke(IPC.GIT_DISCARD_FILE, cwd, file, repoRoot)
  },

  getSubmodules: (cwd: string) => {
    return ipcRenderer.invoke(IPC.GIT_GET_SUBMODULES, cwd)
  },

  updateIndexContent: (cwd: string, filename: string, content: string) => {
    return ipcRenderer.invoke(IPC.GIT_UPDATE_INDEX_CONTENT, cwd, filename, content)
  },

  checkInstalled: () => {
    return ipcRenderer.invoke(IPC.GIT_CHECK_INSTALLED)
  },

  getTerminalCwd: (terminalId: string) => {
    return ipcRenderer.invoke(IPC.GIT_GET_TERMINAL_CWD, terminalId)
  },

  getTerminalInfo: (terminalId: string) => {
    return ipcRenderer.invoke(IPC.GIT_GET_TERMINAL_INFO, terminalId)
  },

  subscribeTerminalInfo: (terminalId: string) => {
    return ipcRenderer.invoke(IPC.GIT_SUBSCRIBE_TERMINAL_INFO, terminalId)
  },

  unsubscribeTerminalInfo: (terminalId: string) => {
    return ipcRenderer.invoke(IPC.GIT_UNSUBSCRIBE_TERMINAL_INFO, terminalId)
  },

  notifyTerminalActivity: (terminalId: string) => {
    return ipcRenderer.invoke(IPC.GIT_NOTIFY_TERMINAL_ACTIVITY, terminalId)
  },

  notifyTerminalFocus: (terminalId: string) => {
    return ipcRenderer.invoke(IPC.GIT_NOTIFY_TERMINAL_FOCUS, terminalId)
  },

  notifyTerminalGitUpdate: (terminalId: string) => {
    return ipcRenderer.invoke(IPC.GIT_NOTIFY_TERMINAL_GIT_UPDATE, terminalId)
  },

  warmDiffCache: (cwd: string) => {
    return ipcRenderer.invoke(IPC.GIT_WARM_DIFF_CACHE, cwd)
  },

  onTerminalInfo: (callback: (terminalId: string, info: TerminalGitInfo) => void) => {
    const listener = (_: Electron.IpcRendererEvent, terminalId: string, info: TerminalGitInfo) => {
      callback(terminalId, info)
    }
    ipcRenderer.on(IPC.GIT_TERMINAL_INFO, listener)
    return () => {
      ipcRenderer.removeListener(IPC.GIT_TERMINAL_INFO, listener)
    }
  },

  onDiffCacheInvalidated: (callback: (cwd: string, reason: 'watcher' | 'watcher-error' | 'force' | 'lru' | 'manual' | 'mirror') => void) => {
    const listener = (_: Electron.IpcRendererEvent, cwd: string, reason: 'watcher' | 'watcher-error' | 'force' | 'lru' | 'manual' | 'mirror') => {
      callback(cwd, reason)
    }
    ipcRenderer.on(IPC.GIT_DIFF_CACHE_INVALIDATED, listener)
    return () => {
      ipcRenderer.removeListener(IPC.GIT_DIFF_CACHE_INVALIDATED, listener)
    }
  },

  // ─── GitStateMirror bridges ──────────────────────────────────────────
  subscribeMirror: (cwd: string) => {
    return ipcRenderer.invoke(IPC.GIT_STATE_MIRROR_SUBSCRIBE, cwd)
  },

  unsubscribeMirror: (cwd: string) => {
    ipcRenderer.send(IPC.GIT_STATE_MIRROR_UNSUBSCRIBE, cwd)
  },

  getMirror: (cwd: string) => {
    return ipcRenderer.invoke(IPC.GIT_STATE_MIRROR_GET, cwd)
  },

  onMirrorUpdate: (callback: (cwd: string, delta: unknown) => void) => {
    const listener = (_: Electron.IpcRendererEvent, cwd: string, delta: unknown) => {
      callback(cwd, delta)
    }
    ipcRenderer.on(IPC.GIT_STATE_MIRROR_UPDATE, listener)
    return () => {
      ipcRenderer.removeListener(IPC.GIT_STATE_MIRROR_UPDATE, listener)
    }
  },

  onMirrorWatcherStatus: (callback: (status: unknown) => void) => {
    const listener = (_: Electron.IpcRendererEvent, status: unknown) => {
      callback(status)
    }
    ipcRenderer.on(IPC.GIT_STATE_MIRROR_WATCHER_STATUS, listener)
    return () => {
      ipcRenderer.removeListener(IPC.GIT_STATE_MIRROR_WATCHER_STATUS, listener)
    }
  },

  // Hard watcher failure events. Degraded watcher health is delivered by
  // onMirrorWatcherStatus while fallback refresh is still working.
  onMirrorWatcherError: (callback: (cwd: string, message: string) => void) => {
    const listener = (_: Electron.IpcRendererEvent, cwd: string, message: string) => {
      callback(cwd, message)
    }
    ipcRenderer.on(IPC.GIT_STATE_MIRROR_WATCHER_ERROR, listener)
    return () => {
      ipcRenderer.removeListener(IPC.GIT_STATE_MIRROR_WATCHER_ERROR, listener)
    }
  },

  pushCwd: (terminalId: string, newCwd: string | null) => {
    ipcRenderer.send(IPC.GIT_STATE_PUSH_CWD, terminalId, newCwd)
  },

  // Rolls back the renderer's speculative `oscDetectedCwds` entry when
  // main's `pushTerminalCwd` rejected the raw cwd (path does not exist
  // or fails normalisation). The renderer-side OSC handler commits the
  // OSC-parsed cwd synchronously for the <50 ms latency win, so we need
  // this back-channel to undo phantom entries (e.g. OSC 7 with free text).
  onMirrorCwdRejected: (callback: (terminalId: string, rawCwd: string) => void) => {
    const listener = (_: Electron.IpcRendererEvent, terminalId: string, rawCwd: string) => {
      callback(terminalId, rawCwd)
    }
    ipcRenderer.on(IPC.GIT_STATE_MIRROR_CWD_REJECTED, listener)
    return () => {
      ipcRenderer.removeListener(IPC.GIT_STATE_MIRROR_CWD_REJECTED, listener)
    }
  },

  requestFileBody: (cwd: string, fileKey: string, force: boolean) => {
    return ipcRenderer.invoke(IPC.GIT_STATE_MIRROR_REQUEST_FILE_BODY, cwd, fileKey, force)
  },

  // Phase 5 PART 2: Refresh Changes → Worker generation bump.
  // Fire-and-forget; the renderer will see the new generation in the
  // next mirror-update broadcast.
  forceRefresh: (cwd: string) => {
    return ipcRenderer.invoke(IPC.GIT_STATE_MIRROR_FORCE_REFRESH, cwd)
  }
}

const projectAPI: ProjectAPI = {
  listDirectory: (root: string, path: string) => {
    return ipcRenderer.invoke(IPC.PROJECT_LIST_DIRECTORY, root, path)
  },

  buildFileIndex: (root: string) => {
    return ipcRenderer.invoke(IPC.PROJECT_BUILD_FILE_INDEX, root)
  },

  searchFilenames: (root: string, query: string, limit?: number) => {
    return ipcRenderer.invoke(IPC.PROJECT_SEARCH_FILENAMES, root, query, limit)
  },

  invalidateFileIndex: (root: string) => {
    return ipcRenderer.invoke(IPC.PROJECT_INVALIDATE_FILE_INDEX, root)
  },

  readFile: (root: string, path: string, options?: ProjectReadOptions) => {
    return traceIpc(
      PERF_TRACE_EVENT.RENDERER_IPC_PROJECT_READ_FILE,
      { pathLen: path.length, openMode: options?.openMode ?? 'auto' },
      () => ipcRenderer.invoke(IPC.PROJECT_READ_FILE, root, path, options)
    )
  },

  // Batch existence check. Hot path on PE mount (quick-file list validate)
  // — was previously the largest single contributor to mount-time CPU.
  filesExist: (root: string, paths: string[]): Promise<boolean[]> => {
    return ipcRenderer.invoke(IPC.PROJECT_FILES_EXIST, root, paths)
  },

  readFileChunk: (root: string, path: string, offset: number, length: number, mode: ProjectFileChunkMode) => {
    return traceIpc(
      PERF_TRACE_EVENT.RENDERER_IPC_PROJECT_READ_FILE_CHUNK,
      { pathLen: path.length, offset, length, mode },
      () => ipcRenderer.invoke(IPC.PROJECT_READ_FILE_CHUNK, root, path, offset, length, mode)
    )
  },

  saveFile: (root: string, path: string, content: string) => {
    return ipcRenderer.invoke(IPC.PROJECT_SAVE_FILE, root, path, content)
  },

  createFile: (root: string, path: string, content?: string) => {
    return ipcRenderer.invoke(IPC.PROJECT_CREATE_FILE, root, path, content ?? '')
  },

  createFolder: (root: string, path: string) => {
    return ipcRenderer.invoke(IPC.PROJECT_CREATE_FOLDER, root, path)
  },

  renamePath: (root: string, oldPath: string, newPath: string) => {
    return ipcRenderer.invoke(IPC.PROJECT_RENAME_PATH, root, oldPath, newPath)
  },

  deletePath: (root: string, path: string) => {
    return ipcRenderer.invoke(IPC.PROJECT_DELETE_PATH, root, path)
  },

  sqliteGetSchema: (root: string, path: string) => {
    return ipcRenderer.invoke(IPC.PROJECT_SQLITE_GET_SCHEMA, root, path)
  },

  sqliteReadTableRows: (root: string, path: string, table: string, limit?: number, offset?: number) => {
    return ipcRenderer.invoke(IPC.PROJECT_SQLITE_READ_TABLE_ROWS, root, path, table, limit, offset)
  },

  sqliteInsertRow: (root: string, path: string, table: string, values: Record<string, unknown>) => {
    return ipcRenderer.invoke(IPC.PROJECT_SQLITE_INSERT_ROW, root, path, table, values)
  },

  sqliteUpdateRow: (root: string, path: string, table: string, key: SqliteRowKey, values: Record<string, unknown>) => {
    return ipcRenderer.invoke(IPC.PROJECT_SQLITE_UPDATE_ROW, root, path, table, key, values)
  },

  sqliteDeleteRow: (root: string, path: string, table: string, key: SqliteRowKey) => {
    return ipcRenderer.invoke(IPC.PROJECT_SQLITE_DELETE_ROW, root, path, table, key)
  },

  sqliteExecute: (root: string, path: string, sql: string) => {
    return ipcRenderer.invoke(IPC.PROJECT_SQLITE_EXECUTE, root, path, sql)
  },

  searchStart: (options: ProjectSearchOptions) => {
    return ipcRenderer.invoke(IPC.PROJECT_SEARCH_START, options)
  },

  searchCancel: () => {
    return ipcRenderer.invoke(IPC.PROJECT_SEARCH_CANCEL)
  },

  onSearchResult: (callback: (searchId: string, matches: ProjectSearchMatch[]) => void) => {
    const listener = (_: Electron.IpcRendererEvent, searchId: string, matches: ProjectSearchMatch[]) => {
      callback(searchId, matches)
    }
    ipcRenderer.on(IPC.PROJECT_SEARCH_RESULT, listener)
    return () => {
      ipcRenderer.removeListener(IPC.PROJECT_SEARCH_RESULT, listener)
    }
  },

  onSearchDone: (callback: (stats: ProjectSearchStats) => void) => {
    const listener = (_: Electron.IpcRendererEvent, stats: ProjectSearchStats) => {
      callback(stats)
    }
    ipcRenderer.on(IPC.PROJECT_SEARCH_DONE, listener)
    return () => {
      ipcRenderer.removeListener(IPC.PROJECT_SEARCH_DONE, listener)
    }
  },

  watchFile: (root: string, path: string) => {
    return ipcRenderer.invoke(IPC.PROJECT_WATCH_FILE, root, path)
  },

  unwatchFile: (root: string, path: string) => {
    return ipcRenderer.invoke(IPC.PROJECT_UNWATCH_FILE, root, path)
  },

  onFileChanged: (callback: (fullPath: string, changeType: 'changed' | 'deleted', content?: string) => void) => {
    const listener = (
      _: Electron.IpcRendererEvent,
      fullPath: string,
      changeType: 'changed' | 'deleted',
      content?: string
    ) => {
      callback(fullPath, changeType, content)
    }
    ipcRenderer.on(IPC.PROJECT_FILE_CHANGED, listener)
    return () => {
      ipcRenderer.removeListener(IPC.PROJECT_FILE_CHANGED, listener)
    }
  },

  watchImageFiles: (root: string, paths: string[]) => {
    return ipcRenderer.invoke(IPC.PROJECT_WATCH_IMAGE_FILES, root, paths)
  },

  unwatchImageFiles: (root: string, paths: string[]) => {
    return ipcRenderer.invoke(IPC.PROJECT_UNWATCH_IMAGE_FILES, root, paths)
  },

  unwatchAllImageFiles: () => {
    return ipcRenderer.invoke(IPC.PROJECT_UNWATCH_ALL_IMAGE_FILES)
  },

  onImageFileChanged: (callback: (relativePath: string) => void) => {
    const listener = (_: Electron.IpcRendererEvent, relativePath: string) => {
      callback(relativePath)
    }
    ipcRenderer.on(IPC.PROJECT_IMAGE_FILE_CHANGED, listener)
    return () => {
      ipcRenderer.removeListener(IPC.PROJECT_IMAGE_FILE_CHANGED, listener)
    }
  },

  treeWatchStart: (cwd: string) => {
    return ipcRenderer.invoke(IPC.PROJECT_TREE_WATCH_START, cwd)
  },

  treeWatchStop: (cwd: string) => {
    return ipcRenderer.invoke(IPC.PROJECT_TREE_WATCH_STOP, cwd)
  },

  onTreeWatchEvent: (
    callback: (event: { cwd: string; added: string[]; removed: string[]; resync?: boolean }) => void
  ) => {
    const listener = (
      _: Electron.IpcRendererEvent,
      event: { cwd: string; added: string[]; removed: string[]; resync?: boolean }
    ) => {
      callback(event)
    }
    ipcRenderer.on(IPC.PROJECT_TREE_WATCH_EVENT, listener)
    return () => {
      ipcRenderer.removeListener(IPC.PROJECT_TREE_WATCH_EVENT, listener)
    }
  }
}

const settingsAPI: SettingsAPI = {
  load: () => {
    return ipcRenderer.invoke(IPC.SETTINGS_LOAD)
  },

  save: (settings: SettingsState) => {
    return ipcRenderer.invoke(IPC.SETTINGS_SAVE, settings)
  },

  update: (partial: Partial<SettingsState>) => {
    return ipcRenderer.invoke(IPC.SETTINGS_UPDATE, partial)
  },

  registerShortcuts: () => {
    return ipcRenderer.invoke(IPC.SETTINGS_REGISTER_SHORTCUTS)
  },

  checkShortcutAvailable: (accelerator: string) => {
    return ipcRenderer.invoke(IPC.SETTINGS_CHECK_SHORTCUT_AVAILABLE, accelerator)
  },

  checkShortcutConflict: (accelerator: string, excludeKey?: string) => {
    return ipcRenderer.invoke(IPC.SETTINGS_CHECK_SHORTCUT_CONFLICT, accelerator, excludeKey)
  },

  onShortcutTriggered: (callback: (action: ShortcutAction) => void) => {
    const listener = (_: Electron.IpcRendererEvent, action: ShortcutAction) => {
      callback(action)
    }
    ipcRenderer.on(IPC.SHORTCUT_TRIGGERED, listener)
    return () => {
      ipcRenderer.removeListener(IPC.SHORTCUT_TRIGGERED, listener)
    }
  },

  onWindowShortcutTriggered: (callback: (action: ShortcutAction) => void) => {
    const listener = (_: Electron.IpcRendererEvent, action: ShortcutAction) => {
      callback(action)
    }
    ipcRenderer.on(IPC.SHORTCUT_WINDOW_TRIGGERED, listener)
    return () => {
      ipcRenderer.removeListener(IPC.SHORTCUT_WINDOW_TRIGGERED, listener)
    }
  },

  onActivated: (callback: () => void) => {
    const listener = () => {
      callback()
    }
    ipcRenderer.on(IPC.SHORTCUT_ACTIVATED, listener)
    return () => {
      ipcRenderer.removeListener(IPC.SHORTCUT_ACTIVATED, listener)
    }
  }
}

const appInfoAPI: AppInfoAPI = {
  get: () => {
    return ipcRenderer.invoke(IPC.APP_GET_INFO)
  },
  readNotice: () => {
    return ipcRenderer.invoke(IPC.APP_READ_NOTICE)
  },
  getPdfViewerUrl: () => {
    return ipcRenderer.invoke(IPC.APP_GET_PDF_VIEWER_URL)
  }
}

const changelogAPI: ChangelogAPI = {
  getCurrent: (locale?: string) => {
    return ipcRenderer.invoke(IPC.CHANGELOG_GET_CURRENT, locale)
  }
}

const updaterAPI: UpdaterAPI = {
  getStatus: () => {
    return ipcRenderer.invoke(IPC.UPDATER_GET_STATUS)
  },
  checkNow: () => {
    return ipcRenderer.invoke(IPC.UPDATER_CHECK_NOW)
  },
  downloadNow: () => {
    return ipcRenderer.invoke(IPC.UPDATER_DOWNLOAD_NOW)
  },
  restartToUpdate: () => {
    return ipcRenderer.invoke(IPC.UPDATER_RESTART_TO_UPDATE)
  },
  dismissBanner: () => {
    return ipcRenderer.invoke(IPC.UPDATER_DISMISS_BANNER)
  },
  onStatusChanged: (callback: (status: UpdaterStatus) => void) => {
    const listener = (_: Electron.IpcRendererEvent, status: UpdaterStatus) => {
      callback(status)
    }
    ipcRenderer.on(IPC.UPDATER_STATUS_CHANGED, listener)
    return () => {
      ipcRenderer.removeListener(IPC.UPDATER_STATUS_CHANGED, listener)
    }
  }
}

const debugEnabled = process.env.ONWARD_DEBUG === '1' || process.env.ELECTRON_ENABLE_LOGGING === '1'
// Opt-in. The renderer-side `perfMonitor` (src/utils/perf-monitor.ts) used
// to auto-start in every dev launch because this flag defaulted to true,
// and its `tick()` runs `requestAnimationFrame` recursively to count fps —
// which itself drives the renderer at vsync (120 Hz on supporting displays)
// and pegs renderer CPU at 60-80% even with zero user activity. The flag
// is now strict opt-in (set ONWARD_PERF_TRACE=1 to enable); main-process
// trace-store retains its own gate via `ONWARD_PERF_TRACE` so callers
// keep one knob.
const perfTraceEnabled = process.env.ONWARD_PERF_TRACE === '1'
const debugProfileEnabled = process.env.ONWARD_PROFILE === '1'
const debugProfileCwd = process.env.ONWARD_PROFILE_CWD || null
const debugAutotestEnabled = process.env.ONWARD_AUTOTEST === '1'
const debugAutotestCwd = process.env.ONWARD_AUTOTEST_CWD || null
const debugAutotestSuite = process.env.ONWARD_AUTOTEST_SUITE || null
const debugAutotestExit = process.env.ONWARD_AUTOTEST_EXIT === '1'
// Opt-OUT of the autotest "auto-resolve file-open-choice to text" shortcut so a
// suite that explicitly tests the binary choice dialog (project-editor-large-file
// PLF-11..15) gets the REAL dialog. Default (unset) keeps the safe auto-text
// behaviour for every other suite (navigation-marker .txt files appear binary on
// Windows and must never block).
const debugAutotestRealFileChoice = debugAutotestEnabled && process.env.ONWARD_AUTOTEST_REAL_FILE_CHOICE === '1'
const debugAutotestFixtureExtra = process.env.ONWARD_AUTOTEST_FIXTURE_EXTRA || null
const debugAutotestHtmlFixturePath = process.env.ONWARD_AUTOTEST_HTML_FIXTURE_PATH || null
const debugAutotestHtmlExpectedTitle = process.env.ONWARD_AUTOTEST_HTML_EXPECTED_TITLE || null
const debugAutotestHtmlExpectedText = process.env.ONWARD_AUTOTEST_HTML_EXPECTED_TEXT || null
const debugAutotestHtmlSkipSaveFlow = process.env.ONWARD_AUTOTEST_HTML_SKIP_SAVE_FLOW === '1'
const debugAutotestGsmWatcherFailSubscribeOnce =
  debugAutotestEnabled && process.env.ONWARD_AUTOTEST_GSM_WATCHER_FAIL_SUBSCRIBE_ONCE === '1'
const debugAutotestGsmWatcherFailCallbackOnce =
  debugAutotestEnabled && process.env.ONWARD_AUTOTEST_GSM_WATCHER_FAIL_CALLBACK_ONCE === '1'
const debugAutotestGsmWatcherSilent =
  debugAutotestEnabled && process.env.ONWARD_AUTOTEST_GSM_WATCHER_SILENT === '1'
const perfTraceCaptureContent = process.env.ONWARD_PERF_TRACE_CAPTURE_CONTENT === '1'
const virtualCursorDisabled = process.env.ONWARD_DISABLE_VIRTUAL_CURSOR === '1'
const gitDiffPerformanceDiagnosticsEnabled =
  process.env.ONWARD_FEATURE_GIT_DIFF_PERFORMANCE_DIAGNOSTICS !== '0'

if (!gitDiffPerformanceDiagnosticsEnabled) {
  console.log('[FeatureFlags] Git Diff performance diagnostics disabled (ONWARD_FEATURE_GIT_DIFF_PERFORMANCE_DIAGNOSTICS=0)')
}

const debugAPI: DebugAPI = {
  enabled: debugEnabled,
  perfTraceEnabled,
  featureFlags: {
    gitDiffPerformanceDiagnostics: gitDiffPerformanceDiagnosticsEnabled
  },
  profile: debugProfileEnabled,
  profileCwd: debugProfileCwd,
  autotest: debugAutotestEnabled,
  autotestRealFileChoice: debugAutotestRealFileChoice,
  autotestCwd: debugAutotestCwd,
  autotestSuite: debugAutotestSuite,
  autotestExit: debugAutotestExit,
  autotestFixtureExtra: debugAutotestFixtureExtra,
  autotestHtmlFixturePath: debugAutotestHtmlFixturePath,
  autotestHtmlExpectedTitle: debugAutotestHtmlExpectedTitle,
  autotestHtmlExpectedText: debugAutotestHtmlExpectedText,
  autotestHtmlSkipSaveFlow: debugAutotestHtmlSkipSaveFlow,
  autotestGsmWatcherFailSubscribeOnce: debugAutotestGsmWatcherFailSubscribeOnce,
  autotestGsmWatcherFailCallbackOnce: debugAutotestGsmWatcherFailCallbackOnce,
  autotestGsmWatcherSilent: debugAutotestGsmWatcherSilent,
  getMirrorWatcherStatusHistory: () => {
    return mirrorWatcherStatusHistory.slice()
  },
  perfTraceCaptureContent,
  virtualCursorDisabled,
  log: (message: string, data?: unknown) => {
    if (!debugEnabled) return
    ipcRenderer.send(IPC.DEBUG_LOG, { message, data })
  },
  focusWindow: () => {
    return ipcRenderer.invoke(IPC.DEBUG_FOCUS_WINDOW)
  },
  getAppMetrics: () => {
    return ipcRenderer.invoke(IPC.DEBUG_GET_APP_METRICS)
  },
  getGitRuntimeMetrics: () => {
    return ipcRenderer.invoke(IPC.DEBUG_GET_GIT_RUNTIME_METRICS)
  },
  getMainWorkMetrics: () => {
    return ipcRenderer.invoke(IPC.DEBUG_GET_MAIN_WORK_METRICS)
  },
  getPerfTraceInfo: () => {
    return ipcRenderer.invoke(IPC.DEBUG_GET_PERF_TRACE_INFO)
  },
  getGitDiffDebugStats: () => {
    return ipcRenderer.invoke(IPC.DEBUG_GIT_DIFF_GET_DEBUG_STATS)
  },
  resetPerfTraceMetrics: () => {
    return ipcRenderer.invoke(IPC.DEBUG_RESET_PERF_TRACE_METRICS)
  },
  perfTrace: (event: string, data?: Record<string, unknown>, terminalId?: string) => {
    if (!perfTraceEnabled) return
    ipcRenderer.send(IPC.DEBUG_PERF_TRACE, { event, data, terminalId })
  },
  getApiServerPort: () => {
    return ipcRenderer.invoke('debug:get-api-server-port') as Promise<number>
  },
  postApiTerminalWrite: (payload: { terminalId: string; text: string; execute: boolean }) => {
    return ipcRenderer.invoke('debug:post-api-terminal-write', payload) as Promise<DebugApiTerminalWriteResult>
  },
  recordPerfTrace: (event: PerformanceTraceRendererEvent) => {
    if (!perfTraceEnabled) return
    void ipcRenderer.invoke('performance-trace:record', event).catch(() => {})
  },
  getPerfTraceStatus: () => {
    return ipcRenderer.invoke('performance-trace:get-status') as Promise<PerformanceTraceStatus>
  },
  flushPerfTrace: () => {
    return ipcRenderer.invoke('performance-trace:flush') as Promise<PerformanceTraceStatus>
  },
  feedbackReset: () => {
    return ipcRenderer.invoke(IPC.DEBUG_FEEDBACK_RESET)
  },
  feedbackSetMockIssues: (issues: FeedbackDebugRemoteIssue[]) => {
    return ipcRenderer.invoke(IPC.DEBUG_FEEDBACK_SET_MOCK_ISSUES, issues)
  },
  feedbackGetLastOpenedUrl: () => {
    return ipcRenderer.invoke(IPC.DEBUG_FEEDBACK_GET_LAST_OPENED_URL)
  },
  readTelemetryLog: () => {
    return ipcRenderer.invoke(IPC.DEBUG_READ_TELEMETRY_LOG) as Promise<string>
  },
  emitBundleMarker: (uuid: string, label?: string) => {
    return ipcRenderer.invoke(IPC.DEBUG_EMIT_BUNDLE_MARKER, { uuid, label }) as Promise<{
      success: boolean
      chunkPath?: string | null
      error?: string
    }>
  },
  quit: () => {
    return ipcRenderer.invoke(IPC.DEBUG_QUIT)
  }
}

const browserAPI: BrowserAPI = {
  create: (id: string, url?: string, options?: { allowFile?: boolean; fileRoot?: string; allowAnyFile?: boolean }) => {
    return ipcRenderer.invoke(IPC.BROWSER_CREATE, id, url, options)
  },
  destroy: (id: string) => {
    return ipcRenderer.invoke(IPC.BROWSER_DESTROY, id)
  },
  navigate: (id: string, url: string) => {
    return ipcRenderer.invoke(IPC.BROWSER_NAVIGATE, id, url)
  },
  goBack: (id: string) => {
    return ipcRenderer.invoke(IPC.BROWSER_GO_BACK, id)
  },
  goForward: (id: string) => {
    return ipcRenderer.invoke(IPC.BROWSER_GO_FORWARD, id)
  },
  reload: (id: string) => {
    return ipcRenderer.invoke(IPC.BROWSER_RELOAD, id)
  },
  stop: (id: string) => {
    return ipcRenderer.invoke(IPC.BROWSER_STOP, id)
  },
  setBounds: (id: string, rect: { x: number; y: number; width: number; height: number }) => {
    return ipcRenderer.invoke(IPC.BROWSER_SET_BOUNDS, id, rect)
  },
  show: (id: string) => {
    return ipcRenderer.invoke(IPC.BROWSER_SHOW, id)
  },
  hide: (id: string) => {
    return ipcRenderer.invoke(IPC.BROWSER_HIDE, id)
  },
  getNavState: (id: string) => {
    return ipcRenderer.invoke(IPC.BROWSER_GET_NAV_STATE, id)
  },
  clearCookies: (maxAge?: number) => {
    return ipcRenderer.invoke(IPC.BROWSER_CLEAR_COOKIES, maxAge)
  },
  setRememberCookies: (rememberCookies: boolean) => {
    return ipcRenderer.invoke(IPC.BROWSER_SET_REMEMBER_COOKIES, rememberCookies) as Promise<{ rememberCookies: boolean }>
  },
  showCookieMenu: (options: { rememberCookies: boolean; labels: { remember: string; clearDay: string; clearWeek: string; clearAll: string } }) => {
    return ipcRenderer.invoke(IPC.BROWSER_SHOW_COOKIE_MENU, options) as Promise<{ action: string; rememberCookies?: boolean } | null>
  },
  showAutoRefreshMenu: (options: { currentIntervalMs: number | null; labels: { off: string; items: Array<{ ms: number; label: string }> } }) => {
    return ipcRenderer.invoke(IPC.BROWSER_SHOW_AUTO_REFRESH_MENU, options) as Promise<{ intervalMs: number | null } | null>
  },
  evaluateForTest: (id: string, script: string) => {
    return ipcRenderer.invoke(IPC.BROWSER_EVALUATE_FOR_TEST, id, script) as Promise<{ success: boolean; value?: unknown; error?: string }>
  },
  getZoomFactor: (id: string) => {
    return ipcRenderer.invoke(IPC.BROWSER_GET_ZOOM_FACTOR, id) as Promise<{ success: boolean; zoomFactor?: number; error?: string }>
  },
  setZoomFactor: (id: string, zoomFactor: number) => {
    return ipcRenderer.invoke(IPC.BROWSER_SET_ZOOM_FACTOR, id, zoomFactor) as Promise<{ success: boolean; zoomFactor?: number; error?: string }>
  },
  getScrollState: (id: string) => {
    return ipcRenderer.invoke(IPC.BROWSER_GET_SCROLL_STATE, id) as Promise<{ success: boolean; state?: BrowserScrollState; error?: string }>
  },
  restoreScrollState: (id: string, state: BrowserScrollState) => {
    return ipcRenderer.invoke(IPC.BROWSER_RESTORE_SCROLL_STATE, id, state) as Promise<{ success: boolean; state?: BrowserScrollState; error?: string }>
  },
  findInPage: (id: string, text: string, options?: BrowserFindInPageOptions) => {
    return ipcRenderer.invoke(IPC.BROWSER_FIND_IN_PAGE, id, text, options) as Promise<{ success: boolean; requestId?: number; error?: string }>
  },
  stopFindInPage: (id: string, action?: BrowserStopFindInPageAction) => {
    return ipcRenderer.invoke(IPC.BROWSER_STOP_FIND_IN_PAGE, id, action) as Promise<boolean>
  },
  onUrlChanged: (callback: (id: string, url: string) => void) => {
    const listener = (_: Electron.IpcRendererEvent, id: string, url: string) => {
      callback(id, url)
    }
    ipcRenderer.on(IPC.BROWSER_URL_CHANGED, listener)
    return () => {
      ipcRenderer.removeListener(IPC.BROWSER_URL_CHANGED, listener)
    }
  },
  onTitleChanged: (callback: (id: string, title: string) => void) => {
    const listener = (_: Electron.IpcRendererEvent, id: string, title: string) => {
      callback(id, title)
    }
    ipcRenderer.on(IPC.BROWSER_TITLE_CHANGED, listener)
    return () => {
      ipcRenderer.removeListener(IPC.BROWSER_TITLE_CHANGED, listener)
    }
  },
  onLoadingChanged: (callback: (id: string, isLoading: boolean) => void) => {
    const listener = (_: Electron.IpcRendererEvent, id: string, isLoading: boolean) => {
      callback(id, isLoading)
    }
    ipcRenderer.on(IPC.BROWSER_LOADING_CHANGED, listener)
    return () => {
      ipcRenderer.removeListener(IPC.BROWSER_LOADING_CHANGED, listener)
    }
  },
  onNavStateChanged: (callback: (id: string, state: { canGoBack: boolean; canGoForward: boolean }) => void) => {
    const listener = (_: Electron.IpcRendererEvent, id: string, state: { canGoBack: boolean; canGoForward: boolean }) => {
      callback(id, state)
    }
    ipcRenderer.on(IPC.BROWSER_NAV_STATE_CHANGED, listener)
    return () => {
      ipcRenderer.removeListener(IPC.BROWSER_NAV_STATE_CHANGED, listener)
    }
  },
  onFullscreenChanged: (callback: (id: string, isFullscreen: boolean) => void) => {
    const listener = (_: Electron.IpcRendererEvent, id: string, isFullscreen: boolean) => {
      callback(id, isFullscreen)
    }
    ipcRenderer.on(IPC.BROWSER_FULLSCREEN_CHANGED, listener)
    return () => {
      ipcRenderer.removeListener(IPC.BROWSER_FULLSCREEN_CHANGED, listener)
    }
  },
  onEscapePressed: (callback: (id: string) => void) => {
    const listener = (_: Electron.IpcRendererEvent, id: string) => {
      callback(id)
    }
    ipcRenderer.on(IPC.BROWSER_ESCAPE_PRESSED, listener)
    return () => {
      ipcRenderer.removeListener(IPC.BROWSER_ESCAPE_PRESSED, listener)
    }
  },
  onFoundInPage: (callback: (id: string, result: BrowserFoundInPageResult) => void) => {
    const listener = (_: Electron.IpcRendererEvent, id: string, result: BrowserFoundInPageResult) => {
      callback(id, result)
    }
    ipcRenderer.on(IPC.BROWSER_FOUND_IN_PAGE, listener)
    return () => {
      ipcRenderer.removeListener(IPC.BROWSER_FOUND_IN_PAGE, listener)
    }
  },
  onFindShortcutPressed: (callback: (id: string) => void) => {
    const listener = (_: Electron.IpcRendererEvent, id: string) => {
      callback(id)
    }
    ipcRenderer.on(IPC.BROWSER_FIND_SHORTCUT_PRESSED, listener)
    return () => {
      ipcRenderer.removeListener(IPC.BROWSER_FIND_SHORTCUT_PRESSED, listener)
    }
  },
  onReloadShortcutPressed: (callback: (id: string) => void) => {
    const listener = (_: Electron.IpcRendererEvent, id: string) => {
      callback(id)
    }
    ipcRenderer.on(IPC.BROWSER_RELOAD_SHORTCUT_PRESSED, listener)
    return () => {
      ipcRenderer.removeListener(IPC.BROWSER_RELOAD_SHORTCUT_PRESSED, listener)
    }
  },
  onZoomFactorChanged: (callback: (id: string, zoomFactor: number, source: 'renderer' | 'shortcut') => void) => {
    const listener = (_: Electron.IpcRendererEvent, id: string, zoomFactor: number, source: 'renderer' | 'shortcut') => {
      callback(id, zoomFactor, source)
    }
    ipcRenderer.on(IPC.BROWSER_ZOOM_FACTOR_CHANGED, listener)
    return () => {
      ipcRenderer.removeListener(IPC.BROWSER_ZOOM_FACTOR_CHANGED, listener)
    }
  }
}

const feedbackAPI: FeedbackAPI = {
  load: () => {
    return ipcRenderer.invoke(IPC.FEEDBACK_LOAD)
  },
  createSubmission: (payload: FeedbackSubmissionInput) => {
    return ipcRenderer.invoke(IPC.FEEDBACK_CREATE_SUBMISSION, payload)
  },
  sync: (recordId?: string, force?: boolean) => {
    return ipcRenderer.invoke(IPC.FEEDBACK_SYNC, recordId, force)
  },
  reopenInBrowser: (recordId: string) => {
    return ipcRenderer.invoke(IPC.FEEDBACK_REOPEN_IN_BROWSER, recordId)
  },
  updatePreferences: (payload: Partial<FeedbackState['preferences']>) => {
    return ipcRenderer.invoke(IPC.FEEDBACK_UPDATE_PREFERENCES, payload)
  },
  removeRecord: (recordId: string) => {
    return ipcRenderer.invoke(IPC.FEEDBACK_REMOVE_RECORD, recordId)
  },
  exportDiagnosticBundle: (
    forceOutputPath?: string,
    expectedMarker?: { uuid: string; label?: string }
  ) => {
    return ipcRenderer.invoke(IPC.FEEDBACK_EXPORT_DIAGNOSTIC_BUNDLE, {
      forceOutputPath,
      expectedMarker
    })
  }
}

const codingAgentConfigAPI: CodingAgentConfigAPI = {
  load: (command?: string) => ipcRenderer.invoke(IPC.CODING_AGENT_CONFIG_LOAD, command),
  save: (config: CodingAgentConfigInput) => ipcRenderer.invoke(IPC.CODING_AGENT_CONFIG_SAVE, config),
  update: (id: string, config: CodingAgentConfigInput) => ipcRenderer.invoke(IPC.CODING_AGENT_CONFIG_UPDATE, id, config),
  delete: (id: string) => ipcRenderer.invoke(IPC.CODING_AGENT_CONFIG_DELETE, id)
}

const codingAgentAPI: CodingAgentAPI = {
  prepare: (command: string, executablePath?: string) => ipcRenderer.invoke(IPC.CODING_AGENT_PREPARE, command, executablePath),
  launch: (payload: CodingAgentLaunchInput) => ipcRenderer.invoke(IPC.CODING_AGENT_LAUNCH, payload)
}

const telemetryAPI = {
  track: (name: string, properties?: Record<string, string | number | boolean | null>) => {
    ipcRenderer.invoke(IPC.TELEMETRY_TRACK, name, properties)
  },
  getConsent: () => ipcRenderer.invoke(IPC.TELEMETRY_GET_CONSENT) as Promise<boolean | null>,
  setConsent: (consent: boolean) => ipcRenderer.invoke(IPC.TELEMETRY_SET_CONSENT, consent) as Promise<{ instanceId: string | null }>
}

contextBridge.exposeInMainWorld('electronAPI', {
  terminal: terminalAPI,
  prompt: promptAPI,
  terminalConfig: terminalConfigAPI,
  dialog: dialogAPI,
  shell: shellAPI,
  clipboard: clipboardAPI,
  commandPreset: commandPresetAPI,
  appState: appStateAPI,
  git: gitAPI,
  project: projectAPI,
  settings: settingsAPI,
  appInfo: appInfoAPI,
  changelog: changelogAPI,
  updater: updaterAPI,
  browser: browserAPI,
  feedback: feedbackAPI,
  codingAgentConfig: codingAgentConfigAPI,
  codingAgent: codingAgentAPI,
  telemetry: telemetryAPI,
  debug: debugAPI,
  platform: process.platform as 'darwin' | 'win32' | 'linux'
})
