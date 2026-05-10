/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

export interface TerminalOptions {
  cols?: number
  rows?: number
  cwd?: string
}

export type TerminalReadMode = 'tail-lines' | 'tail-chars'
export type TerminalBufferTarget = 'active' | 'normal' | 'alternate'

export interface TerminalBufferOptions {
  mode?: TerminalReadMode
  lastLines?: number
  lastChars?: number
  /** Offset in number of lines to skip from tail (tail-lines mode only), for incremental reading of earlier content */
  offset?: number
  trimTrailingEmpty?: boolean
  /** Specify which buffer to read: active (default, currently active), normal (main buffer), alternate (alternate screen buffer) */
  buffer?: TerminalBufferTarget
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
  /** The buffer type currently activated by the terminal: normal or alternate */
  bufferType?: 'normal' | 'alternate'
  error?: string
}

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

export type TerminalShellKind = 'posix' | 'powershell' | 'cmd' | 'unknown'

export interface TerminalInputCapabilities {
  bracketedPasteEnabled: boolean
  shellKind: TerminalShellKind
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
}

export interface DebugApiTerminalWriteResult {
  ok: boolean
  status: number
  body?: string
  error?: string
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
  ackData: (id: string, charCount: number) => void
  dispose: (id: string) => Promise<boolean>
  onData: (callback: (id: string, data: string) => void) => () => void
  onExit: (callback: (id: string, exitCode: number, signal?: number) => void) => () => void
  onGetBufferRequest: (callback: (requestId: string, terminalId: string, options?: TerminalBufferOptions) => void) => () => void
  sendBufferResponse: (requestId: string, result: TerminalBufferResult) => void
  onPromptBridgeSend: (callback: (request: PromptBridgeSendRequest) => void) => () => void
  sendPromptBridgeResponse: (requestId: string, result: PromptBridgeSendResult) => void
}

export interface PromptSendRecord {
  taskId: string
  taskName: string
  sentAt: number
  action: 'send' | 'execute' | 'sendAndExecute'
  result?: 'executed' | 'sent-only'
}

export interface Prompt {
  id: string
  title: string
  content: string
  pinned: boolean
  color?: 'red' | 'yellow' | 'green' | null
  createdAt: number
  updatedAt: number
  lastUsedAt: number
  sendHistory?: PromptSendRecord[]
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

import type { AppState } from './tab.d.ts'
import type {
  FeedbackActionResult,
  FeedbackCreateSubmissionResult,
  FeedbackDebugRemoteIssue,
  FeedbackState,
  FeedbackSubmissionInput
} from './feedback'

export interface AppStateAPI {
  load: () => Promise<AppState>
  save: (state: AppState) => Promise<boolean>
  savePatch: (patch: Partial<AppState>) => Promise<boolean>
  flush: () => Promise<boolean>
  onFlushPendingState: (callback: () => void | Promise<void>) => void
}

export type GitChangeType = 'unstaged' | 'staged' | 'untracked'
export type GitStatusCode = 'M' | 'A' | 'D' | 'R' | 'C' | '?'

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
  parentRoot?: string
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
  repoRoot?: string
  repoLabel?: string
  isSubmoduleEntry?: boolean
  // Parsed from `git status --porcelain=2` sub field (S<c><m><u>). Only
  // populated when isSubmoduleEntry is true. The parent's file list keeps
  // an entry only when commitChanged is true (the parent's index actually
  // recorded a different submodule HEAD); m/u flags belong to the
  // submodule's own section, not the parent's.
  submoduleFlags?: {
    commitChanged: boolean
    workTreeModified: boolean
    untrackedContent: boolean
  }
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
  isPdf?: boolean
  isEpub?: boolean
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
}

export type TerminalGitStatus = 'clean' | 'modified' | 'added' | 'unknown'

export interface TerminalGitInfo {
  cwd: string | null
  repoRoot: string | null
  branch: string | null
  repoName: string | null
  status: TerminalGitStatus | null
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
  isPdf?: boolean
  isEpub?: boolean
  originalImageUrl?: string
  modifiedImageUrl?: string
  originalImageSize?: number
  modifiedImageSize?: number
  /** Base64-encoded bytes for PDF/EPUB sides. Missing on the "added" / "removed" side. */
  originalPreviewData?: string
  modifiedPreviewData?: string
  originalPreviewSize?: number
  modifiedPreviewSize?: number
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
  previewUrl?: string
  /** Base64-encoded file bytes for preview formats that load in-memory (EPUB). */
  previewData?: string
  /** Absolute filesystem path of the previewed file (PDF/EPUB). */
  previewPath?: string
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
  getFileContent: (cwd: string, file: Pick<GitFileStatus, 'filename' | 'status' | 'originalFilename' | 'changeType' | 'isSubmoduleEntry'>, repoRoot?: string) => Promise<GitFileContentResult>
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
  onDiffCacheInvalidated: (callback: (cwd: string, reason: 'watcher' | 'force' | 'lru' | 'manual') => void) => () => void
}

// Project Editor API
export interface ProjectAPI {
  listDirectory: (root: string, path: string) => Promise<ProjectListResult>
  buildFileIndex: (root: string) => Promise<string[]>
  searchFilenames: (root: string, query: string, limit?: number) => Promise<string[]>
  invalidateFileIndex: (root: string) => Promise<{ success: boolean }>
  readFile: (root: string, path: string) => Promise<ProjectReadResult>
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

// Introducing the Settings type
import type { SettingsState, ShortcutAction, SettingsAPI } from './settings.d.ts'

export type { SettingsState, ShortcutAction }
export type ReleaseChannel = 'daily' | 'dev' | 'stable' | 'unknown'
export type ReleaseOs = 'macos' | 'windows' | 'linux' | 'unknown'
export type RuntimePlatform = 'darwin' | 'win32' | 'linux' | 'unknown'
export type UpdatePhase = 'idle' | 'checking' | 'available' | 'downloading' | 'downloaded' | 'up-to-date' | 'unsupported' | 'error'

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
  readNotice: (locale?: string) => Promise<string | null>
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

export interface DownloadProgress {
  downloadedBytes: number
  totalBytes: number
  percent: number
  bytesPerSecond: number
}

export type DownloadErrorCode =
  | 'offline'
  | 'connection-failed'
  | 'timeout'
  | 'stalled'
  | 'http-error'
  | 'checksum-mismatch'
  | 'disk-error'
  | 'aborted'

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

export interface DebugAPI {
  enabled: boolean
  perfTraceEnabled: boolean
  profile: boolean
  profileCwd: string | null
  autotest: boolean
  autotestCwd: string | null
  autotestSuite: string | null
  autotestExit: boolean
  autotestFixtureExtra: string | null
  perfTraceCaptureContent: boolean
  virtualCursorDisabled: boolean
  log: (message: string, data?: unknown) => void
  focusWindow: () => Promise<boolean>
  getAppMetrics: () => Promise<Record<string, unknown>[]>
  getGitRuntimeMetrics: () => Promise<GitRuntimeMetrics>
  getMainWorkMetrics: () => Promise<Record<string, unknown>>
  getPerfTraceInfo: () => Promise<PerfTraceInfo>
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
  /**
   * Autotest-only: synchronously record an `autotest:bundle-marker`
   * event with the given uuid + label so the diagnostic-bundle V10
   * verifier can find it after the bundle IPC. Resolves once the
   * underlying `traceStore.writeSync` has flushed the line into the
   * kernel buffer of the active chunk fd. Returns `success:false` in
   * production builds (the main side gates on ONWARD_AUTOTEST=1).
   */
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

export interface BrowserAPI {
  create: (id: string, url?: string) => Promise<{ success: boolean; id: string; error?: string }>
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
  onUrlChanged: (callback: (id: string, url: string) => void) => () => void
  onTitleChanged: (callback: (id: string, title: string) => void) => () => void
  onLoadingChanged: (callback: (id: string, isLoading: boolean) => void) => () => void
  onNavStateChanged: (callback: (id: string, state: { canGoBack: boolean; canGoForward: boolean }) => void) => () => void
  onFullscreenChanged: (callback: (id: string, isFullscreen: boolean) => void) => () => void
  onEscapePressed: (callback: (id: string) => void) => () => void
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

// Telemetry API
export interface TelemetryAPI {
  track: (name: string, properties?: Record<string, string | number | boolean | null>) => void
  getConsent: () => Promise<boolean | null>
  setConsent: (consent: boolean) => Promise<{ instanceId: string | null }>
}

export interface ElectronAPI {
  terminal: TerminalAPI
  prompt: PromptAPI
  terminalConfig: TerminalConfigAPI
  dialog: DialogAPI
  shell: ShellAPI
  clipboard: ClipboardAPI
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
  telemetry: TelemetryAPI
  debug: DebugAPI
  platform: 'darwin' | 'win32' | 'linux'
}

declare global {
  interface Window {
    electronAPI: ElectronAPI
  }
}
