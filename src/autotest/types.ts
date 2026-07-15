/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Automated test sharing type definition
 */

import type { ShortcutAction } from '../types/settings.d.ts'

// ============================================================
// Debug API interface
// ============================================================

export interface AppDebugApi {
  triggerShortcutAction: (action: ShortcutAction) => boolean
  /** Autotest-only: read the current tab id list (order matches the tab bar). */
  getTabIds: () => string[]
  /** Autotest-only: read the active tab id. */
  getActiveTabId: () => string | null
  /**
   * Autotest-only: create a new tab. Returns `'pending'` when the request
   * was accepted (the new tab id appears in `getTabIds()` on the next
   * React tick) or `null` when the tab limit has been reached.
   */
  createTab: () => 'pending' | null
  /** Autotest-only: switch to an existing tab by id. Returns false if unknown. */
  switchToTabById: (tabId: string) => boolean
}

// Mirror of clickLatencyTracker.ClickLatencyMeasurement, kept inline so this
// file does not pull in renderer-only modules.
export interface ClickLatencyMeasurementForAutotest {
  fileKey: string
  filename: string
  cacheState: 'hit' | 'miss' | 'unknown'
  cacheSource: 'renderer-memory' | 'main-content-cache' | 'worker-rebuild' | null
  cacheMissReason:
    | 'first-load'
    | 'invalidated-mutation'
    | 'invalidated-watch'
    | 'invalidated-mirror'
    | 'invalidated-refresh'
    | 'invalidated-stat-revalidate'
    | 'renderer-force-refresh'
    | 'project-queue-evicted'
    | 'single-file-too-large'
    | 'precompute-pending'
    | 'entry-not-warmed'
    | 'worker-error'
    | null
  clickAt: number
  ipcStartAt: number | null
  ipcEndAt: number | null
  stateSetAt: number | null
  modelBoundAt: number | null
  editorReadyAt: number | null
  diffComputedAt: number | null
  domCommittedAt: number | null
  paintReadyAt: number | null
  tokenizeSettleAt: number | null
  firstPaintMs: number | null
  totalMs: number | null
  settleReason: 'tokens-quiet' | 'dom-quiet' | 'timeout' | 'no-editor' | 'non-text' | 'test' | 'unknown' | null
  coldMountMs: number | null
  cancelled: boolean
}

export interface GitDiffDebugApi {
  isOpen: () => boolean
  getFileList: () => Array<{ filename: string; originalFilename?: string; status?: string; changeType?: string; resourceGroup?: string; originalRef?: string | null; modifiedRef?: string | null; repoRoot?: string; repoLabel?: string; isImage?: boolean; isPdf?: boolean; isEpub?: boolean; isSubmoduleEntry?: boolean }>
  getVisibleFileList?: () => Array<{ filename: string; originalFilename?: string; status?: string; changeType?: string; resourceGroup?: string; originalRef?: string | null; modifiedRef?: string | null; repoRoot?: string; repoLabel?: string }>
  getFileListViewMode?: () => 'tree' | 'flat'
  setFileListViewMode?: (mode: 'tree' | 'flat') => boolean
  getVisibleTreeRows?: () => Array<{ type: 'dir' | 'file'; path: string; depth: number; name: string }>
  getRepoList: () => Array<{ root: string; label: string; isSubmodule: boolean; depth: number; changeCount: number; parentRoot?: string; loading?: boolean }>
  getVisibleRepoItems?: () => Array<{ root: string; label: string; isSubmodule: boolean; depth: number; treeDepth: number; changeCount: number; parentRoot?: string; loading?: boolean; hasChildren: boolean; expanded: boolean; isCurrent: boolean }>
  setRepoExpanded?: (repoRoot: string, expanded: boolean) => boolean
  setRepoFilter?: (repoRoot: string | null) => boolean
  getSelectedFile: () => { filename: string; originalFilename?: string; status?: string; changeType?: string } | null
  selectFileByPath: (path: string) => boolean
  selectFileByIndex: (index: number) => boolean
  isSelectedReady: () => boolean
  getSelectedFileContent?: () => {
    originalContent: string | null
    modifiedContent: string | null
    draftContent: string | null
    isBinary: boolean
    loading: boolean
    error: string | null
  } | null
  getSelectedEditorModelContent?: () => {
    originalContent: string | null
    modifiedContent: string | null
    expectedOriginalContent: string | null
    expectedModifiedContent: string | null
    originalUri: string | null
    modifiedUri: string | null
    originalMatchesState: boolean | null
    modifiedMatchesState: boolean | null
  } | null
  getCachedFileContentByPath?: (path: string, changeType?: string) => {
    filename: string
    changeType: string
    originalContent: string | null
    modifiedContent: string | null
    draftContent: string | null
    isBinary: boolean
    loading: boolean
    error: string | null
  } | null
  getPrefetchState?: () => {
    scheduled: number
    completed: number
    inFlight: boolean
    candidates: string[]
    lastReason: string
    lastDurationMs: number | null
  }
  getLargeFileConfirmState?: () => {
    visible: boolean
    filename: string | null
    sizeBytes: number | null
    sizeLabel: string | null
  }
  confirmLargeFile?: () => void
  cancelLargeFile?: () => void
  getLastFileContentLoad?: () => {
    fileKey: string
    filename: string
    reason: 'select' | 'prefetch' | 'refresh' | 'auto-refresh' | 'debug'
    force: boolean
    result: 'success' | 'error' | 'exception'
    cacheInfo: {
      state: 'hit' | 'miss' | 'unknown'
      source: 'renderer-memory' | 'main-content-cache' | 'worker-rebuild'
      missReason?: ClickLatencyMeasurementForAutotest['cacheMissReason']
      project?: string
      key?: string
      stored?: boolean
      bytes?: number
    } | null
    durationMs: number
  } | null
  getLastClickLatency?: () => ClickLatencyMeasurementForAutotest | null
  getLastClickLatencyForFile?: (fileKey: string) => ClickLatencyMeasurementForAutotest | null
  getClickLatencyHistory?: () => ClickLatencyMeasurementForAutotest[]
  resetClickLatencyHistory?: () => void
  setSelectedDraftContent?: (content: string) => boolean
  getIsDraftDirty?: () => boolean
  getRestoreNotice: () => { type: 'missing' | 'changed'; message: string; fileName?: string } | null
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
  getSubmoduleLoadObservation: () => {
    sawSubmodulesLoading: boolean
    maxLoadingRepoCount: number
    maxNestedLoadingRepoCount: number
  }
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
  getLoadState?: () => {
    inFlight: boolean
    queued: { reset: boolean; silent: boolean; force: boolean } | null
    hasDiffResult: boolean
    fileCount: number | null
    submodulesLoading: boolean
    hasLastDiff: boolean
    lastDiffAgeMs: number | null
  }
  getSplitViewState?: () => {
    mode?: 'side-by-side' | 'inline'
    ratio: number | null
    originalWidth: number
    modifiedWidth: number
  } | null
  getSplitViewMode?: () => 'auto' | 'split' | 'inline'
  setSplitViewMode?: (mode: 'auto' | 'split' | 'inline') => boolean
  getDiffNavigationState?: () => { changeCount: number; currentIndex: number }
  getResponsiveLayoutState?: () => {
    mode: 'side-by-side' | 'inline' | null
    containerWidth: number | null
    inlineBreakpoint: number
    useInlineViewWhenSpaceIsLimited: boolean
  }
  setSplitViewRatio?: (ratio: number) => boolean
  setFileListWidth?: (width: number) => boolean
  dragSplitViewRatio?: (ratio: number) => Promise<boolean>
  navigateDiffChange?: (direction: 'previous' | 'next') => boolean
  refreshChanges?: () => Promise<boolean>
  getTermsPopoverOpen?: () => boolean
  toggleTermsPopover?: () => boolean
  getHunkActionWidgetCount?: () => number
  getHunkActionDebugState?: () => {
    hasEditor: boolean
    hasMonaco: boolean
    selectedFile: { filename: string; changeType: string; status: string } | null
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
    installRetryPending?: boolean
  }
  revealFirstHunkActionForTest?: () => boolean
  hideHunkActionsForTest?: () => void
  triggerFirstHunkAction?: (action: 'stage' | 'revert' | 'unstage') => Promise<boolean>
  waitForLastHunkActionForTest?: () => Promise<boolean | null>
  setSelectedLineRangeForTest?: (start: number, end: number, side?: 'additions' | 'deletions') => boolean
  triggerLineAction?: (action: 'keep' | 'deny') => Promise<boolean>
  getImagePreviewState?: () => {
    isImage: boolean
    isSvg: boolean
    isBinary: boolean
    hasOriginalUrl: boolean
    hasModifiedUrl: boolean
    compareMode: '2up' | 'swipe' | 'onion'
    displayMode: 'original' | 'fit'
    loading: boolean
  } | null
  getFileActionState?: () => {
    fileActionsVisible: boolean
    lineActionsVisible: boolean
    keepDisabled: boolean
    denyDisabled: boolean
    pending: boolean
    toolbarVisible?: boolean
    actionPanelVisible?: boolean
    visibleLabels?: string[]
  } | null
  triggerFileAction?: (action: 'keep' | 'deny') => Promise<boolean>
  getPdfCompareState?: () => {
    visible: boolean
    status: 'added' | 'deleted' | 'modified' | null
    originalSrc: string | null
    modifiedSrc: string | null
    originalHasEmpty: boolean
    modifiedHasEmpty: boolean
    paneCount: number
    isSinglePane: boolean
  } | null
  getEpubCompareState?: () => {
    visible: boolean
    status: 'added' | 'deleted' | 'modified' | null
    chapterCount: number
    selectedHref: string | null
    chapterBadges: Array<{ href: string; label: string; kind: 'added' | 'deleted' | 'modified' | 'unchanged' }>
    diffCounts: { add: number; del: number; same: number } | null
  } | null
}

export interface PromptSenderDebugApi {
  getTerminalCards: () => Array<{ id: string; title: string; isSelected: boolean }>
  getPromptContent: () => string
  getSelectedCount: () => number
  getSelectionIndicatorStates: () => Array<{ id: string; isActive: boolean }>
  getSelectedTerminalIds: () => string[]
  getActionButtons: () => Array<{ label: string; disabled: boolean }>
  getGridLayout: () => { columns: number; rows: number; totalCards: number }
  getNotice: () => string | null
  isSubmitting: () => boolean
  clickAction: (action: 'sendAndExecute' | 'execute' | 'send' | 'sendAllAndExecute') => Promise<boolean>
  selectTerminal: (id: string) => boolean
  deselectTerminal: (id: string) => boolean
  deselectAllTerminals: () => void
}

export interface GitHistoryDebugApi {
  isOpen: () => boolean
  getCommitCount: () => number
  getCommits?: () => Array<{ sha: string; summary: string; refs?: string }>
  getSelectedShas: () => string[]
  getFiles: () => Array<{ filename: string; status: string }>
  getSelectedFile: () => { filename: string } | null
  getSelectedFileContent?: () => {
    originalContent: string | null
    modifiedContent: string | null
    isBinary: boolean
    loading: boolean
    error: string | null
  } | null
  getDiffError?: () => string | null
  getScrollState?: () => {
    commit: number
    file: number
    diff: number
  }
  getImagePreviewState?: () => {
    isImage: boolean
    isSvg: boolean
    hasOriginalUrl: boolean
    hasModifiedUrl: boolean
    compareMode: '2up' | 'swipe' | 'onion'
    displayMode: 'original' | 'fit'
    svgViewMode: 'visual' | 'text'
    loading: boolean
  } | null
  setImageCompareMode?: (mode: '2up' | 'swipe' | 'onion') => void
  setImageDisplayMode?: (mode: 'original' | 'fit') => void
  setSvgViewMode?: (mode: 'visual' | 'text') => void
  getPdfCompareState?: () => {
    visible: boolean
    status: 'added' | 'deleted' | 'modified' | null
    originalSrc: string | null
    modifiedSrc: string | null
    originalHasEmpty: boolean
    modifiedHasEmpty: boolean
    paneCount: number
    isSinglePane: boolean
  } | null
  getEpubCompareState?: () => {
    visible: boolean
    status: 'added' | 'deleted' | 'modified' | null
    chapterCount: number
    selectedHref: string | null
    chapterBadges: Array<{ href: string; label: string; kind: 'added' | 'deleted' | 'modified' | 'unchanged' }>
    diffCounts: { add: number; del: number; same: number } | null
  } | null
  isLoading: () => boolean
  getActiveCwd: () => string | null
  getRepoState: () => {
    selectedRepoRoot: string | null
    cachedParentCwd: string | null
    repoSearch: string
    cachedRepoCount: number
  }
  getVisibleRepoItems?: () => Array<{ root: string; label: string; isSubmodule: boolean; depth: number; treeDepth: number; changeCount: number; parentRoot?: string; loading?: boolean; hasChildren: boolean; expanded: boolean; isCurrent: boolean }>
  setRepoExpanded?: (repoRoot: string, expanded: boolean) => boolean
  switchRepo?: (repoRoot: string | null) => void
  injectRepoState: (state: {
    selectedRepoRoot: string | null
    cachedParentCwd: string | null
    repoSearch?: string
    cachedRepos?: Array<{
      root: string
      label: string
      isSubmodule?: boolean
      depth?: number
      changeCount?: number
      parentRoot?: string
    }>
  }) => boolean
  selectCommitByIndex: (index: number) => boolean
  selectFileByIndex: (index: number) => boolean
  selectFileByPath?: (path: string) => boolean
  getDiffStyle: () => 'split' | 'unified'
  setDiffStyle: (style: 'split' | 'unified' | 'side-by-side' | 'inline') => void
  getDiffDisplayMode?: () => 'side-by-side' | 'inline'
  setDiffDisplayMode?: (mode: 'side-by-side' | 'inline') => void
  getHideWhitespace: () => boolean
  setHideWhitespace: (value: boolean) => void
  reloadSelectedFileContent?: () => boolean
  getLargeFileConfirmState?: () => {
    visible: boolean
    filename: string | null
    sizeBytes: number | null
    sizeLabel: string | null
  }
  confirmLargeFile?: () => void
  cancelLargeFile?: () => void
}

export interface ScheduleDebugInfo {
  promptId: string
  tabId: string
  targetTerminalIds: string[]
  scheduleType: string
  status: string
  nextExecutionAt: number
  executedCount: number
  executionLogCount: number
  lastError: string | null
  missedExecutions: number
  absoluteTime: number | null
  relativeOffsetMs: number | null
  maxExecutions: number | null
  recurrence: { startTime: number; intervalMs: number } | null
  executionLog: Array<{ timestamp: number; success: boolean; targetTerminalIds: string[]; error?: string | null }>
}

export interface PromptNotebookDebugApi {
  getPromptCount: () => number
  getPrompts: () => Array<{ id: string; title: string; content: string; pinned: boolean; color?: string; lastUsedAt: number; taskNumbers: number[]; sendHistoryCount: number }>
  getVisiblePromptItems?: () => Array<{ id: string; title: string; color?: string; taskNumbers: number[] }>
  getSelectedPromptId?: () => string | null
  getLastEditorSendToTask?: () => { content: string; terminalId: string } | null
  selectPrompt?: (promptId: string) => boolean
  setPromptColor?: (promptId: string, color: 'red' | 'yellow' | 'green' | null) => boolean
  copyPrompt?: (promptId: string) => Promise<boolean>
  getColorFilterState?: () => {
    enabled: boolean
    activeColor: 'red' | 'yellow' | 'green' | null
    counts: { red: number; yellow: number; green: number }
  }
  setColorFilter?: (color: 'red' | 'yellow' | 'green' | null) => boolean
  getTaskFilterState?: () => {
    enabled: boolean
    activeTaskNumber: number | null
    options: Array<{ taskNumber: number; count: number }>
  }
  setTaskFilter?: (taskNumber: number | null) => boolean
  isFilterEnabled?: () => boolean
  setFilterEnabled?: (enabled: boolean) => boolean
  isTargetsEnabled?: () => boolean
  setTargetsEnabled?: (enabled: boolean) => boolean
  reorderPinnedPrompts?: (dragId: string, targetId: string, position: 'before' | 'after') => boolean
  getCleanupConfig: () => { autoEnabled: boolean; autoKeepDays: number; autoDeleteColored: boolean; lastAutoCleanupAt: number | null }
  getEditorContent: () => string
  getEditorHeight: () => number | null
  getPersistedEditorHeight: () => number
  setEditorContent: (content: string) => void
  submitEditor: () => void
  // Scheduled task Debug API
  getSchedules: () => ScheduleDebugInfo[]
  getScheduleForPrompt: (promptId: string) => ScheduleDebugInfo | null
  createSchedule: (promptId: string, type: 'relative' | 'absolute' | 'recurring', options?: {
    offsetMs?: number
    time?: number
    recurrence?: { startTime: number; intervalMs: number }
  }) => boolean
  pauseSchedule: (promptId: string) => boolean
  resumeSchedule: (promptId: string) => boolean
  deleteSchedule: (promptId: string) => boolean
}

export interface ProjectEditorDebugApi {
  isOpen: () => boolean
  getRootPath: () => string | null
  getActiveFilePath: () => string | null
  isSelectFileEmptyStateVisible?: () => boolean
  getLastProjectEditorReopenRestore?: () => {
    durationMs: number
    cause: 'retained-view' | 'persisted-state'
    filePath: string | null
    markdownCacheMode: 'hit' | 'miss' | 'stale' | 'disabled' | null
    finalizedAt: number
  } | null
  getSourceReturnBarState?: () => {
    visible: boolean
    source: 'diff' | 'history' | null
    backEnabled: boolean
    jumpEnabled: boolean
    checking: boolean
    activeFilePath: string | null
  }
  triggerSourceReturnBack?: () => Promise<boolean>
  getDiffReturnBarState?: () => {
    visible: boolean
    backEnabled: boolean
    jumpEnabled: boolean
    checking: boolean
    activeFilePath: string | null
  }
  triggerDiffReturnBack?: () => Promise<boolean>
  triggerJumpToDiff?: () => Promise<boolean>
  getSidebarMode?: () => 'files' | 'search'
  setSidebarMode?: (mode: 'files' | 'search') => void
  getEditorContent: () => string
  setEditorContent?: (content: string) => boolean
  getEditorLineCount: () => number
  getDialogState?: () => { type: 'confirm' | 'prompt'; title: string; message: string } | null
  confirmDialog?: () => void
  cancelDialog?: () => void
  getOpenChoiceDialogState?: () => {
    visible: boolean
    extension: string
    remember: boolean
  }
  chooseOpenChoice?: (mode: 'text' | 'binary' | 'cancel', remember?: boolean) => void
  getLargeFileState?: () => {
    mode: 'large-text' | 'binary'
    path: string
    sizeBytes: number
    offset: number
    bytesRead: number
    textLength: number
    binaryLength: number
    binaryRadix: 2 | 8 | 10 | 16
    loading: boolean
    error: string | null
    readOnly: true
  } | null
  setLargeFileOffset?: (offset: number) => Promise<boolean>
  setBinaryRadix?: (radix: 2 | 8 | 10 | 16) => boolean
  openFileByPath: (filePath: string) => Promise<void>
  openFileByPathAsUser: (filePath: string, options?: { trackRecent?: boolean }) => Promise<void>
  triggerEditorSaveCommand: () => boolean
  /** Runs a registered Monaco editor action (e.g. 'onward.openWithDefaultApp') by id. */
  triggerMonacoContextAction?: (actionId: string) => Promise<boolean>
  /** Lists the Onward file actions registered on the Monaco context menu. */
  getMonacoContextActions?: () => Array<{ id: string; label: string }>
  triggerToolbarSave: () => Promise<boolean>
  isSqliteViewerVisible: () => boolean
  isPdfReaderVisible?: () => boolean
  getPdfReaderState?: () => {
    visible: boolean
    src: string | null
    filePath: string
    stateReady: boolean
    currentState: {
      page: number
      scrollTop: number
      scale: string | null
    } | null
  } | null
  isEpubReaderVisible?: () => boolean
  getEpubReaderState?: () => {
    visible: boolean
    hasContent: boolean
    stateReady: boolean
    tocCount: number
    fontSizeLabel: string | null
    filePath: string
    errorMessage: string | null
    contentHtmlLen: number
    currentLocationHref: string | null
    currentLocationCfi: string | null
    sessionId: number | null
    latestAttemptId: number | null
    settledAttemptId: number | null
    readyAttemptId: number | null
    latestTarget: string | null
    appliedFontPct: number | null
    bodyFontSizePx: number | null
    scrollTop: number
    maxScrollTop: number
  } | null
  isHtmlReaderVisible?: () => boolean
  getHtmlReaderState?: () => {
    browserId: string
    filePath: string
    url: string
    title: string
    ready: boolean
    visible: boolean
    isLoading: boolean
    loadCount: number
    reloadKey: number
    canGoBack: boolean
    canGoForward: boolean
    error: string | null
    scrollRestoreStatus: 'idle' | 'waiting' | 'restoring' | 'restored' | 'failed'
    restoredScrollY: number | null
    preservedScrollState?: {
      x: number
      y: number
      scrollWidth: number
      scrollHeight: number
      clientWidth: number
      clientHeight: number
    } | null
  } | null
  getHtmlPreviewNavState?: () => {
    browserId: string | null
    url: string | null
    homeUrl: string | null
    canGoBack: boolean
    canGoForward: boolean
    backEnabled: boolean
    forwardEnabled: boolean
    reloadEnabled: boolean
    homeEnabled: boolean
  } | null
  getHtmlPreviewDocumentState?: () => Promise<{
    success: boolean
    error?: string
    title?: string
    readyState?: string
    bodyText?: string
    bodyDatasetMarker?: string | null
    relativeScriptMarker?: string | null
    navigationAccent?: string | null
    externalReady?: boolean
    localReady?: boolean
    saveMarker?: string | null
    imageCount?: number
    loadedImageCount?: number
    brokenImageCount?: number
    scrollX?: number
    scrollY?: number
    scrollHeight?: number
    scrollWidth?: number
    clientHeight?: number
    clientWidth?: number
  } | null>
  setHtmlPreviewScrollForTest?: (y: number) => Promise<boolean>
  getHtmlPreviewZoomFactor?: () => number
  setHtmlPreviewZoomFactor?: (zoomFactor: number) => Promise<boolean>
  stepHtmlPreviewZoom?: (direction: 'in' | 'out' | 'reset') => Promise<boolean>
  getHtmlPreviewBrowserZoomFactor?: () => Promise<number | null>
  getImageFilePreviewState?: () => {
    visible: boolean
    loaded: boolean
    broken: boolean
    src: string
  } | null
  getFileBrowserScrollTop?: () => number
  getFileBrowserScrollHeight?: () => number
  scrollFileBrowserToFraction?: (fraction: number) => boolean
  getFileBrowserActiveRowBounds?: () => {
    found: boolean
    containerTop: number
    containerHeight: number
    rowTop: number
    rowHeight: number
    centerOffsetRatio: number
  } | null
  getFileBrowserExpandedDirs?: () => string[]
  clickLocateFileButton?: () => boolean
  isFileBrowserCollapsed?: () => boolean
  setFileBrowserCollapsed?: (collapsed: boolean) => void
  getFileBrowserPanelState?: () => {
    collapsed: boolean
    sidebarWidth: number
    editorWidth: number
    hasRestoreButton: boolean
    hasTree: boolean
    hasResizer: boolean
  }
  getOutlineActiveItemBounds?: () => {
    found: boolean
    containerTop: number
    containerHeight: number
    itemTop: number
    itemHeight: number
    centerOffsetRatio: number
  } | null
  isMarkdownEditorVisible?: () => boolean
  setMarkdownEditorVisible?: (visible: boolean) => void
  setMarkdownPreviewVisible?: (visible: boolean) => void
  isMarkdownPreviewVisible: () => boolean
  setMarkdownPreviewOpen?: (open: boolean) => void
  isMarkdownCodeWrapEnabled?: () => boolean
  setMarkdownCodeWrapEnabled?: (enabled: boolean) => void
  getMarkdownCodeWrapState?: () => {
    enabled: boolean
    previewClassName: string | null
    blockWhiteSpace: string | null
    blockOverflowWrap: string | null
    inlineWhiteSpace: string | null
    inlineOverflowWrap: string | null
  }
  setPreviewSearchOpen?: (open: boolean) => void
  isPreviewSearchOpen?: () => boolean
  previewSearchSetQuery?: (query: string) => void
  previewSearchGoToNext?: () => void
  previewSearchGoToPrevious?: () => void
  getPreviewSearchMatchCount?: () => number
  getPreviewSearchCurrentIndex?: () => number
  getPreviewSearchMatchPositions?: () => Array<{ top: number; left: number; isActive: boolean }>
  getPreviewSearchActiveCenter?: () => {
    markCenter: number
    containerCenter: number
    containerHeight: number
    offset: number
  } | null
  setHtmlPreviewSearchOpen?: (open: boolean) => void
  isHtmlPreviewSearchOpen?: () => boolean
  htmlPreviewSearchSetQuery?: (query: string) => void
  htmlPreviewSearchGoToNext?: () => void
  htmlPreviewSearchGoToPrevious?: () => void
  getHtmlPreviewSearchState?: () => {
    open: boolean
    query: string
    matches: number
    activeMatchOrdinal: number
    finalUpdate: boolean
  }
  isMarkdownRenderPending: () => boolean
  getMarkdownRenderedHtml: () => string
  getMarkdownPreviewImageState?: () => {
    count: number
    loadedCount: number
    brokenCount: number
    sources: string[]
  }
  getMermaidPreviewState?: () => {
    total: number
    rendered: number
    error: number
    pending: number
    inFlight: boolean
  }
  getMermaidPanZoomState?: () => Array<{
    id: string | null
    scale: number
    x: number
    y: number
    fullscreen: boolean
    enhanced: boolean
  }>
  triggerMermaidPanZoomAction?: (
    diagramId: string,
    action: 'zoomIn' | 'zoomOut' | 'fit' | 'reset' | 'fullscreen'
  ) => boolean
  simulateMermaidPan?: (diagramId: string, dx: number, dy: number) => boolean
  isMermaidFullscreenActive?: () => boolean
  getMarkdownSessionCacheState?: () => {
    size: number
    limit: number
    lastRestore: {
      mode: 'hit' | 'miss' | 'stale' | 'disabled'
      key: string | null
      filePath: string | null
      size: number
      limit: number
      openCount?: number
      dwellMs?: number
      renderedHtmlLength?: number
    }
    entries: Array<{
      filePath: string
      renderedHtmlLength: number
      openCount: number
      dwellMs: number
      lastAccessedAt: number
      hitCount: number
      stale: boolean
    }>
  }
  getOutlineTarget?: () => 'editor' | 'preview'
  setOutlineTarget?: (target: 'editor' | 'preview') => void
  getOutlineEffectiveTarget?: () => 'editor' | 'preview'
  isOutlineVisible?: () => boolean
  setOutlineVisible?: (visible: boolean) => void
  getOutlineSymbolCount?: () => number
  getOutlineActiveItemName?: () => string | null
  getOutlineScrollTop?: () => number
  getOutlineScrollHeight?: () => number
  getOutlineScrollMax?: () => number
  scrollOutlineToFraction?: (fraction: number) => boolean
  clickOutlineItemByName?: (name: string) => boolean
  getPreviewActiveSlug?: () => string | null
  scrollPreviewToFraction?: (fraction: number) => boolean
  getPreviewScrollTop?: () => number
  getPreviewScrollHeight?: () => number
  isPreviewTransitioning?: () => boolean
  isPreviewContentVisible?: () => boolean
  getPreviewRestorePhase?: () => 'idle' | 'waiting-html' | 'restoring-layout' | 'revealing'
  getLastPreviewReveal?: () => {
    durationMs: number
    cause: 'fast-path'
    hadWork: boolean
    finalizedAt: number
  } | null
  debugScanPreviewHeadings?: () => { nearest: string | null }
  runPreviewPositionTest?: (mdFilePath: string, otherFilePath: string) => Promise<boolean>
  getCursorPosition: () => { lineNumber: number; column: number } | null
  setCursorPosition: (lineNumber: number, column?: number) => boolean
  getScrollTop: () => number
  getFirstVisibleLine: () => number
  scrollToLine: (lineNumber: number) => boolean
  getMissingFileNotice: () => { path: string; message: string } | null
  isGlobalFilenameSearchOpen?: () => boolean
  openGlobalFilenameSearch?: () => Promise<void>
  closeGlobalFilenameSearch?: () => void
  setGlobalFilenameSearchQuery?: (query: string) => void
  getGlobalFilenameSearchQuery?: () => string
  getGlobalFilenameSearchResults?: () => string[]
  getFileIndexStats?: () => {
    totalBuilds: number
    entryCount: number
    entries: Array<{ cwd: string; status: 'idle' | 'building' | 'ready'; fileCount: number }>
  }
  forceRefreshFileIndex?: () => Promise<boolean>
}

export interface TerminalFocusDebugApi {
  blurActiveElement: () => boolean
  prepareTerminalRestore: (terminalId: string) => boolean
  simulatePointerTarget: (target: 'terminal' | 'input' | 'other', terminalId?: string | null) => boolean
  simulateRestore: (reason: 'window-focus' | 'shortcut-activated' | 'shortcut-terminal') => void
  getFocusedTerminalId: () => string | null
  getState: () => {
    windowHasFocus: boolean
    activeTagName: string | null
    activeClassName: string | null
    focusedTerminalId: string | null
    activeTerminalId: string | null
    lastFocusedTerminalId: string | null
    lastFocusOwner: 'terminal' | 'input'
    recentPointer: boolean
    pointerTarget: 'terminal' | 'input' | 'other'
    targetTerminal: {
      exists: boolean
      open: boolean | null
      status: 'idle' | 'initializing' | 'ready' | 'error' | 'disposed' | null
      visible: boolean | null
      hasContainer: boolean
      containerConnected: boolean
      containerWidth: number | null
      containerHeight: number | null
      containerDisplay: string | null
      hasTextarea: boolean
      textareaConnected: boolean
      textareaDisabled: boolean | null
      textareaTabIndex: number | null
      textareaDisplay: string | null
      terminalElementConnected: boolean
      activeElementMatchesTextarea: boolean
    }
  }
}

export interface TerminalDebugApi {
  getTerminalIds: () => string[]
  getVisibleTerminalIds: () => string[]
  getActiveTerminalId: () => string | null
  getSessionState: (terminalId?: string) => {
    terminalId: string
    status: 'idle' | 'initializing' | 'ready' | 'error' | 'disposed'
    open: boolean
    visible: boolean
    outputVisible?: boolean
    webglActive: boolean
    rendererMode: 'webgl' | 'fallback'
    rendererWebglAvailable: boolean
    rendererWebglFailureCount: number
    rendererWebglDisabledUntil: number | null
    rendererLastLifecycleReason: string | null
    rendererLastSurfaceEvent: string | null
    pendingDataChunks: number
    pendingDataBytes: number
  } | null
  getRendererRecoveryCount: () => number
  getViewportState: (terminalId?: string) => {
    terminalId: string
    bufferType: 'normal' | 'alternate'
    baseY: number
    viewportY: number
    rows: number
    cols: number
    isNearBottom: boolean
    userWantsBottom: boolean
    pendingRestore: {
      followBottom: boolean
      viewportY: number
      bufferType: 'normal' | 'alternate'
      reason: 'output' | 'fit' | 'attach'
      capturedAt: number
    } | null
  } | null
  getTailText: (terminalId?: string, lastLines?: number) => string | null
  scrollToTop: (terminalId?: string) => boolean
  scrollToBottom: (terminalId?: string) => boolean
  scrollLinesAsUser: (terminalId?: string, lines?: number) => boolean
  forceFit: (terminalId?: string) => boolean
  remountTerminal: (terminalId?: string) => boolean
  simulateRendererSurfaceLoss: (terminalId?: string) => boolean
  recoverVisibleRenderers: () => number
  // Direct hook into the host-surface restore pipeline. Bypasses the
  // synthetic `document.dispatchEvent('visibilitychange')` /
  // `window.dispatchEvent('focus')` path that the React listener in
  // TerminalGrid would otherwise translate. Synthetic dispatches share an
  // 80ms debounce window with focus juggling earlier in the suite, which
  // races with the restore the test expects to observe; calling this
  // method enters the manager directly with the chosen reason and a
  // fresh debounce slot, so each TFA assertion gets a deterministic
  // restore. Reasons are restricted to the three "host" events (the
  // others are internal lifecycle reasons not produced by host events).
  notifyHostSurfaceEvent: (reason: 'document-visible' | 'window-focus' | 'page-show') => void
  getTerminalTitle: (terminalId?: string) => string | null
  getTerminalCustomName: (terminalId?: string) => string | null
  getTerminalGitInfo: (terminalId?: string) => {
    branch: string | null
    repoName: string | null
    cwd: string | null
    repoRoot: string | null
    status: 'clean' | 'modified' | 'added' | 'deleted' | 'mixed' | 'unknown' | null
  } | null
  openTitleMenu: (terminalId?: string) => boolean
  closeTitleMenu: () => boolean
  clickTitleMenuItem: (
    item: 'rename' | 'auto-follow-toggle' | 'use-branch' | 'use-repo',
    terminalId?: string
  ) => boolean
  getTitleMenuState: (terminalId?: string) => {
    open: boolean
    branch: string | null
    repoName: string | null
    canUseBranch: boolean
    canUseRepo: boolean
  } | null
  /** Read the current "Auto-follow Git branch name" preference. */
  getAutoFollowGitBranchForTaskName: () => boolean
  /** Programmatically set the preference (mirrors the dropdown checkbox toggle). */
  setAutoFollowGitBranchForTaskName: (enabled: boolean) => void
  /** Read the persisted manualNameRepoRoot for a terminal. */
  getTerminalManualNameRepoRoot: (terminalId?: string) => string | null
  /**
   * Autotest-only: clear the "first post-mount git-info pass done" flag for a
   * Task so the next git-info override re-enters the boot hydration barrier.
   */
  resetAutoFollowInitialPass: (terminalId?: string) => boolean
  simulateTitleSingleClick: (terminalId?: string) => boolean
  simulateTitleDoubleClick: (terminalId?: string) => boolean
  /**
   * Inject raw PTY-output bytes into the terminal's xterm instance so tests
   * can reproduce OSC injection from inner programs (Claude CLI, shells with
   * exotic shell integration, etc.) without spawning a real subprocess that
   * echoes the bytes. The data is written via the same `xterm.write(data)`
   * path that real PTY output takes, so xterm's OSC parser sees identical
   * bytes to a live session.
   */
  injectPtyData: (data: string, terminalId?: string) => boolean
  finishInlineRename: (value?: string) => boolean
  cancelInlineRename: () => boolean
  getInlineRenameState: () => { editingId: string | null; editingTitle: string }
  setTerminalGitInfoOverride: (
    terminalId: string,
    override: {
      branch?: string | null
      repoName?: string | null
      cwd?: string | null
      repoRoot?: string | null
      status?: 'clean' | 'modified' | 'added' | 'deleted' | 'mixed' | 'unknown' | null
    } | null
  ) => boolean
  closeAllSubpages: () => boolean
}

export interface SettingsDebugApi {
  isOpen: () => boolean
  getUpdaterState: () => {
    phase: string
    supported: boolean
    statusLabel: string
    actionLabel: string
    actionDisabled: boolean
    detailText: string | null
    actionCounts: {
      checkNow: number
      restartToUpdate: number
    }
    targetVersion: string | null
    lastCheckedAt: number | null
    actionError: string | null
  }
  setMockUpdaterStatus: (
    patch: Partial<import('../types/electron.d.ts').UpdaterStatus> & {
      phase: import('../types/electron.d.ts').UpdatePhase
    }
  ) => boolean
  setMockNextCheckResult: (
    patch: Partial<import('../types/electron.d.ts').UpdaterStatus> & {
      phase: import('../types/electron.d.ts').UpdatePhase
    },
    delayMs?: number
  ) => boolean
  setMockRestartResult: (result: {
    success: boolean
    error?: string
    delayMs?: number
  }) => boolean
  clickUpdateAction: () => Promise<boolean>
  resetMockUpdater: () => boolean
}

export interface ChangeLogDebugApi {
  isOpen: () => boolean
  isLoading: () => boolean
  getCurrentTag: () => string | null
  getRenderedText: () => string
  getUnavailableState: () => {
    visible: boolean
    message: string | null
    detail: string | null
  }
  clickCloseButton: () => boolean
  clickOverlay: () => boolean
  pressEscape: () => boolean
}

// ============================================================
// Test run environment
// ============================================================

export interface AutotestContext {
  terminalId: string
  rootPath: string
  log: (message: string, data?: unknown) => void
  sleep: (ms: number) => Promise<void>
  waitFor: (label: string, predicate: () => boolean, timeoutMs?: number, intervalMs?: number) => Promise<boolean>
  assert: (name: string, ok: boolean, detail?: Record<string, unknown>) => void
  startCpuSampler: () => void
  stopCpuSampler: () => CpuSummary
  cancelled: () => boolean
  openFileInEditor: (filePath: string) => Promise<void>
  reopenProjectEditor: (label: string) => Promise<boolean>
  buildFileIndex: () => Promise<string[]>
  isOpenRef: { current: boolean }
  rootRef: { current: string | null }
}

export interface CpuSummary {
  samples: number
  totalAvg: number
  totalMax: number
  rendererAvg: number
  rendererMax: number
  browserAvg: number
  browserMax: number
}

export interface TestResult {
  name: string
  ok: boolean
  detail?: Record<string, unknown>
}

export interface TestSuiteResult {
  suite: string
  results: TestResult[]
  passed: number
  failed: number
  skipped: number
}

// ============================================================
// Window global declaration
// ============================================================

export interface BlankTaskReproApi {
  triggerWebglLoss: (id?: string) => { triggered: boolean; reason: string; terminalId: string | null }
  forceWebglRestore: (id?: string) => { triggered: boolean; reason: string; terminalId: string | null }
  phantomBlank: (id?: string) => { triggered: boolean; reason: string; terminalId: string | null }
  runVisibilityRoundtrip: () => Promise<{ dispatched: boolean }>
  getFocusedTerminalId: () => string | null
  getSessionDebugState: (id?: string) => unknown
}

declare global {
  interface Window {
    __onwardGitDiffDebug?: GitDiffDebugApi
    __onwardPromptSenderDebug?: PromptSenderDebugApi
    __onwardGitHistoryDebug?: GitHistoryDebugApi
    __onwardPromptNotebookDebug?: PromptNotebookDebugApi
    __onwardProjectEditorDebug?: ProjectEditorDebugApi
    __onwardAppDebug?: AppDebugApi
    __onwardSettingsDebug?: SettingsDebugApi
    __onwardChangeLogDebug?: ChangeLogDebugApi
    __onwardTerminalFocusDebug?: TerminalFocusDebugApi
    __onwardTerminalDebug?: TerminalDebugApi
    __blankTaskRepro?: BlankTaskReproApi
  }
}
