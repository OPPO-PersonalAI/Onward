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

export interface TerminalAPI {
  create: (id: string, options?: TerminalOptions) => Promise<{ success: boolean; id?: string; error?: string }>
  write: (id: string, data: string, traceContext?: PerformanceTraceContext) => Promise<boolean>
  /**
   * Verified manual cwd switch (RC-3 fix): resolves success ONLY after the
   * shell's own cwd report confirms the change. Callers must persist the
   * returned `cwd` (not the requested path) and persist nothing on failure.
   */
  changeWorkDirVerified: (id: string, targetPath: string) => Promise<{
    success: boolean
    cwd?: string
    reason?: 'target-not-found' | 'terminal-not-found' | 'write-failed' | 'verify-timeout'
  }>
  /** Shell integration produced no cwd OSC within the liveness window. */
  onIntegrationSilent: (callback: (id: string, shellKind: string) => void) => () => void
  /** A shell-derived cwd OSC arrived after the silent signal — clear the hint. */
  onIntegrationRecovered: (callback: (id: string) => void) => () => void
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
  showItemInFolder: (path: string) => Promise<{ success: boolean; error?: string }>
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
  resourceGroup: GitResourceGroup
  originalRef: GitResourceRef | null
  modifiedRef: GitResourceRef | null
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
  /**
   * Probe outcome behind a failed load (RC-2 fix). 'timeout' → the repo
   * probe was killed at the exec budget (slow/hanging volume): show the
   * "Git timed out here" state with retry, NOT "not a repo".
   */
  repoProbe?: 'ok' | 'not-repo' | 'timeout' | 'error'
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
  /** Probe outcome behind a failed load (RC-2 fix) — see GitDiffResult. */
  repoProbe?: 'ok' | 'not-repo' | 'timeout' | 'error'
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
  allowLargeFile?: boolean
}

export type TerminalGitStatus = 'clean' | 'modified' | 'added' | 'deleted' | 'mixed' | 'unknown'

export type GitDiffContentCacheMissReason =
  | 'first-load'
  | 'invalidated-mutation'
  | 'invalidated-watch'
  | 'invalidated-mirror'
  | 'invalidated-refresh'
  // Read-path stat revalidation proved the working-tree file changed since it was
  // cached (the watcher/mirror never fired for it) -> drop the hit and re-fetch.
  | 'invalidated-stat-revalidate'
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

export interface TerminalGitInfo {
  cwd: string | null
  repoRoot: string | null
  branch: string | null
  repoName: string | null
  status: TerminalGitStatus | null
}

/**
 * Renderer-facing snapshot of the GitStateMirror. Same shape as
 * `MirrorState` in `electron/main/git-state-mirror-types.ts` — duplicated
 * here so renderer code never reaches into electron/main.
 */
export interface GitStateMirrorSnapshot {
  cwd: string
  repoRoot: string | null
  repoName: string | null
  branch: string | null
  /**
   * Full HEAD object id (`# branch.oid`). Third freshness signal — moves on
   * commit / amend / checkout. The renderer History view keys its list cache
   * on `repoRoot::branchOid::limit::skip`, so a new commit invalidates the
   * cached page without an extra git spawn. Undefined on non-repo / unknown.
   */
  branchOid?: string
  /**
   * Commits ahead of the branch's upstream (`+N` from `# branch.ab`). Drives the
   * "local ahead" green badge dot + `↑N` count. Local-only, always accurate.
   * Undefined when the branch has no upstream.
   */
  ahead?: number
  /**
   * Commits behind the branch's upstream (`-N` from `# branch.ab`). Drives the
   * `↓M` count. Only as fresh as the last fetch; the background auto-fetch keeps
   * it current. Undefined when the branch has no upstream.
   */
  behind?: number
  status: TerminalGitStatus | null
  files: GitFileStatus[]
  repos?: GitRepoContext[]
  submodulesLoading?: boolean
  capturedAt: number
  changeFingerprint: string
  generation: number
}

/**
 * Result of `subscribeMirror`. `canonicalCwd` is the router's realpath key —
 * present even when `snapshot` is still cold (null) so the renderer can alias
 * a symlink/junction raw cwd onto the realpath-keyed snapshot map before the
 * first delta arrives (2026-07-16 symlink-status fix).
 */
export interface GitStateMirrorSubscribeResult {
  canonicalCwd: string
  snapshot: GitStateMirrorSnapshot | null
}

/**
 * Partial-update payload broadcast on `git-state-mirror:update`. Renderer
 * merges these into its local copy of `GitStateMirrorSnapshot`. Always
 * carries `capturedAt` for ordering.
 */
export type GitStateMirrorDelta = Partial<Omit<GitStateMirrorSnapshot, 'cwd' | 'capturedAt'>> & {
  capturedAt: number
}

export type GitStateMirrorWatcherHealth =
  | 'idle'
  | 'attaching'
  | 'healthy'
  | 'recovering'
  | 'degraded-polling'
  | 'suspended'
  | 'failed'
  | 'detached'

export type GitStateMirrorWatcherFailureKind =
  | 'subscribe-error'
  | 'callback-error'
  | 'path-missing'
  | 'polling-error'
  | 'unknown'

export interface GitStateMirrorWatcherStatus {
  cwd: string
  repoRoot: string | null
  health: GitStateMirrorWatcherHealth
  message: string | null
  failureKind: GitStateMirrorWatcherFailureKind | null
  failureCount: number
  polling: boolean
  pollingIntervalMs: number | null
  nextRetryAt: number | null
  updatedAt: number
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
  /** file:// URL with mtime cache buster. PDF: pdf.js viewer URL. Image / EPUB / HTML: direct file URL. */
  previewUrl?: string
  /** Absolute filesystem path of the previewed file (PDF/EPUB/HTML). */
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
  notifyTerminalGitCommand: (payload: { terminalId: string; subcommand: string; createsRepo: boolean }) => Promise<{ success: boolean }>
  revalidateMirror: (cwd: string) => Promise<{ success: boolean }>
  warmDiffCache: (cwd: string) => Promise<{ success: boolean }>
  onTerminalInfo: (callback: (terminalId: string, info: TerminalGitInfo) => void) => () => void
  onDiffCacheInvalidated: (callback: (cwd: string, reason: 'watcher' | 'watcher-error' | 'force' | 'lru' | 'manual' | 'mirror', detail?: { files?: string[] }) => void) => () => void

  // GitStateMirror surface — single-source-of-truth subscriptions wired
  // through the worker-thread mirror. See `src/hooks/useGitStateMirror.ts`
  // for the React hook every consumer should prefer over these raw bridges.
  // The subscribe result carries the canonical (realpath) key even when the
  // snapshot is cold — the renderer needs it to alias a symlink/junction cwd
  // onto the realpath-keyed snapshot map (2026-07-16 symlink-status fix).
  subscribeMirror: (cwd: string) => Promise<GitStateMirrorSubscribeResult | null>
  unsubscribeMirror: (cwd: string) => void
  getMirror: (cwd: string) => Promise<GitStateMirrorSnapshot | null>
  onMirrorUpdate: (callback: (cwd: string, delta: GitStateMirrorDelta) => void) => () => void
  onMirrorWatcherStatus: (callback: (status: GitStateMirrorWatcherStatus) => void) => () => void
  /**
   * Listen for parcel-watcher failure events from the mirror worker.
   * Renderer should surface a hard failure banner. Recovering/degraded
   * states arrive through `onMirrorWatcherStatus`.
   */
  onMirrorWatcherError: (callback: (cwd: string, message: string) => void) => () => void
  pushCwd: (terminalId: string, newCwd: string | null) => void
  /**
   * Notification that `pushCwd`'s raw value was rejected by the main-side
   * filesystem check (path does not exist or fails normalisation). The
   * renderer subscribes to roll back any speculative `oscDetectedCwds`
   * entry it dispatched before the IPC round-trip resolved — closes the
   * bug class where `OSC 7 ; file:///<free-text>` poisons the task
   * header with a phantom path.
   */
  onMirrorCwdRejected: (callback: (terminalId: string, rawCwd: string) => void) => () => void
  requestFileBody: (cwd: string, fileKey: string, force: boolean) => Promise<GitFileContentResult | null>
  /**
   * Phase 5 PART 2 — Refresh Changes. Forces the Worker to bump the
   * mirror's `generation` for `cwd` and recompute. The next
   * `mirror-update` event carries the new generation, which the
   * renderer uses to remount the DiffEditor (identity-keyed cascade).
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
   * Batch existence check. Returns a parallel boolean[] aligned with the
   * input paths. Designed for quick-file list validation — replaces the
   * antipattern of `readFile` (full content) just to check presence.
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

export interface SystemAPI {
  onGpuProcessGone: (
    callback: (info: { reason: string; exitCode: number; simulated: boolean }) => void
  ) => () => void
  onThreadpoolHealthChanged: (
    callback: (info: { status: 'ok' | 'suspect' | 'stalled'; stalledSince: number | null; recoveries: number }) => void
  ) => () => void
  onVisibilityRecoveryPush: (callback: (info: { nudge: string }) => void) => () => void
  relaunchApp: () => Promise<{ success: boolean; error?: string }>
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
  autotestFixtureExtra: string | null
  autotestHtmlFixturePath: string | null
  autotestHtmlExpectedTitle: string | null
  autotestHtmlExpectedText: string | null
  autotestHtmlSkipSaveFlow: boolean
  autotestGsmWatcherFailSubscribeOnce: boolean
  autotestGsmWatcherFailCallbackOnce: boolean
  autotestGsmWatcherSilent: boolean
  autotestGsmLatencyGroup: string
  autotestGdsGroup: string
  getMirrorWatcherStatusHistory: () => GitStateMirrorWatcherStatus[]
  perfTraceCaptureContent: boolean
  virtualCursorDisabled: boolean
  log: (message: string, data?: unknown) => void
  focusWindow: () => Promise<boolean>
  simulateGpuProcessGone: () => Promise<{ success: boolean; notified?: number; error?: string }>
  getAppMetrics: () => Promise<Record<string, unknown>[]>
  getGitRuntimeMetrics: () => Promise<GitRuntimeMetrics>
  getMainWorkMetrics: () => Promise<Record<string, unknown>>
  getPerfTraceInfo: () => Promise<PerfTraceInfo>
  getGitDiffDebugStats: () => Promise<GitDiffDebugStats>
  resetPerfTraceMetrics: () => Promise<EventLoopStallMetrics>
  perfTrace: (event: string, data?: Record<string, unknown>, terminalId?: string) => void
  perfTraceDiagnostic: (event: string, data?: Record<string, unknown>, terminalId?: string) => void
  reloadWindow: () => Promise<{ success: boolean; error?: string }>
  gitStateMirrorDebugInspect: () => Promise<Record<string, unknown>>
  getApiServerPort: () => Promise<number>
  postApiTerminalWrite: (payload: { terminalId: string; text: string; execute: boolean }) => Promise<DebugApiTerminalWriteResult>
  writeExternalFile: (payload: { root: string; relPath: string; content: string }) => Promise<{ ok: boolean; error?: string }>
  gitInitForAutotest: (payload: { dir: string }) => Promise<{ ok: boolean; error?: string }>
  gitAutofetchForAutotest: (payload: { repoRoot: string }) => Promise<{ ok: boolean; reason?: string; durationMs?: number; error?: string }>
  recordPerfTrace: (event: PerformanceTraceRendererEvent) => void
  getPerfTraceStatus: () => Promise<PerformanceTraceStatus>
  flushPerfTrace: () => Promise<PerformanceTraceStatus>
  feedbackReset: () => Promise<void>
  feedbackSetMockIssues: (issues: FeedbackDebugRemoteIssue[]) => Promise<void>
  feedbackGetLastOpenedUrl: () => Promise<string | null>
  simulateThreadpoolStall: (stalled: boolean) => Promise<{ success: boolean; stalled?: boolean; error?: string }>
  getInfraHealth: () => Promise<{
    threadpool: { status: 'ok' | 'suspect' | 'stalled'; stalledSince: number | null; recoveries: number }
    visibility: { status: 'ok' | 'nudging' | 'gave-up'; recoveries: number }
    ptyWriteMode: 'sync' | 'conpty'
  }>
  shellReset: () => Promise<void>
  shellGetLastOpenedPath: () => Promise<string | null>
  shellGetLastRevealedPath: () => Promise<string | null>
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

export interface BrowserAPI {
  create: (id: string, url?: string, options?: { allowFile?: boolean; fileRoot?: string; allowAnyFile?: boolean }) => Promise<{ success: boolean; id: string; error?: string }>
  destroy: (id: string) => Promise<boolean>
  navigate: (id: string, url: string) => Promise<boolean>
  goBack: (id: string) => Promise<boolean>
  goForward: (id: string) => Promise<boolean>
  reload: (id: string, options?: { ignoreCache?: boolean }) => Promise<boolean>
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
  onWebviewInput: (callback: (webContentsId: number, action: 'escape' | 'reload' | 'zoom-in' | 'zoom-out' | 'zoom-reset') => void) => () => void
}

export interface HtmlPreviewAPI {
  createSession: (rootPath: string, filePath: string, reloadKey: number) => Promise<{
    success: boolean
    sessionId?: string
    url?: string
    error?: string
  }>
  releaseSession: (sessionId: string) => Promise<boolean>
  validateNavigation: (sessionId: string, url: string) => Promise<boolean>
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
  htmlPreview: HtmlPreviewAPI
  feedback: FeedbackAPI
  codingAgentConfig: CodingAgentConfigAPI
  codingAgent: CodingAgentAPI
  telemetry: TelemetryAPI
  debug: DebugAPI
  system: SystemAPI
  platform: 'darwin' | 'win32' | 'linux'
}

declare global {
  interface Window {
    electronAPI: ElectronAPI
  }
}
