/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

import { useState, useEffect, useLayoutEffect, useRef, useCallback, useMemo, memo } from 'react'
import { createPortal } from 'react-dom'
import { LayoutMode, TerminalInfo, TerminalShortcutAction, TerminalFocusRequest } from '../../types/prompt'
import type { Prompt } from '../../types/electron'
import { resolveLayout, isSameLayoutMode, layoutDataAttr } from '../../utils/layout-mode'
import { TerminalDropdown } from '../TerminalDropdown'
import { TerminalTitleMenu } from '../TerminalTitleMenu'
import { GitDiffViewer } from '../GitDiffViewer'
import { GitHistoryViewer } from '../GitHistoryViewer'
import { ProjectEditor } from '../ProjectEditor'
import { SubpagePanelShell, type SubpagePanelShellState } from '../SubpageSwitcher'
import { CodingAgentModal } from '../CodingAgentModal'
import type { CodingAgentConfigInput, GitStateMirrorSnapshot, GitStateMirrorDelta, TerminalGitStatus } from '../../types/electron'
import { BrowserPanel } from '../BrowserPanel/BrowserPanel'
import { decideTaskNameAutoFollow } from './auto-follow-name'
import { useSettings } from '../../contexts/SettingsContext'
import { useAppState } from '../../contexts/AppStateContext'
import { DEFAULT_TERMINAL_FONT_SIZE, DEFAULT_TERMINAL_FONT_FAMILY } from '../../constants/terminal'
import {
  terminalSessionManager,
  TerminalSessionOptions,
  TerminalSessionStatus,
  type TerminalRendererSurfaceEvent
} from '../../terminal/terminal-session-manager'
import { focusCoordinator } from '../../terminal/focus-coordinator'
import type { TerminalDebugApi } from '../../autotest/types'
import { perfMonitor } from '../../utils/perf-monitor'
import { perfTrace, perfTraceTask } from '../../utils/perf-trace'
import { computeMenuPosition, computeSubmenuLayout } from '../../utils/popup-position'
import { PERF_TRACE_EVENT } from '../../utils/perf-trace-names'
import { resolveGitDiffInitialCwd } from '../../utils/git-diff-cwd-resolution'
import { useI18n } from '../../i18n/useI18n'
import { buildChangeDirectoryCommand, type TerminalShellKind } from '../../utils/terminal-command'
import type { ProjectEditorOpenRequest, SubpageId, SubpageNavigateEventDetail } from '../../types/subpage'
import {
  buildSubpageRouteCommand,
  legacyNavigateDetailToRouteCommand,
  shouldApplySubpageTargetFile,
  subpageRouteCommandToDebugLabel,
  type SubpageRouteCommand
} from './subpageRouter'
import {
  createSubpageStateMemory,
  type SubpageMemoryScope
} from './subpageStateMemory'
import { shouldRestoreSubpageOnEnter } from './subpageRestoreDecision'
import {
  mergeMirrorAlias,
  mergeMirrorDeltaSnapshot,
  mergeMirrorSnapshot,
  normalizeTerminalGitPath,
  removeMirrorAlias,
  resolveTerminalGitDisplayState
} from './gitStatusIdentity'
import { resolveGitSyncDisplay } from './gitSyncDisplay'
import '@xterm/xterm/css/xterm.css'
import './TerminalGrid.css'
import '../../styles/path-copy-toast.css'

const DEBUG_TERMINAL_GRID = Boolean(window.electronAPI?.debug?.enabled)

function debugLog(...args: unknown[]) {
  if (!DEBUG_TERMINAL_GRID) return
  console.log('[TerminalGrid]', ...args)
  try {
    const [message, ...data] = args
    window.electronAPI.debug.log(String(message ?? ''), data.length > 0 ? data : undefined)
  } catch {
    // ignore
  }
}

interface TerminalGridProps {
  layoutMode: LayoutMode
  terminals: TerminalInfo[]
  activeTerminalId: string | null
  theme?: TerminalSessionOptions['theme']
  fontSize?: number
  fontFamily?: string
  onTerminalFocus: (id: string) => void
  onTerminalRename: (id: string, newTitle: string) => void
  /**
   * Auto-follow side-effect callback. Called by TerminalGrid whenever the
   * auto-follow rule writes (or clears) the customName because of a Git
   * branch / repo change. Receives the new customName (null = clear) and
   * always implies manualNameRepoRoot=null at the App layer.
   */
  onTerminalAutoRename: (id: string, newCustomName: string | null) => void
  onPersistTerminalCwd: (terminalId: string, cwd: string | null) => void
  onOpenProjectEditor: (terminalId: string, options?: {
    filePath?: string | null
    repoRoot?: string | null
    source?: SubpageId | null
    returnTarget?: SubpageId | null
    diffFilePath?: string | null
    diffRepoRoot?: string | null
  }) => void
  tabId?: string
  hidden?: boolean
  shortcutAction?: TerminalShortcutAction | null
  focusRequest?: TerminalFocusRequest | null
  projectEditorOpen?: boolean
  projectEditorTerminalId?: string | null
  projectEditorCwd?: string | null
  projectEditorOpenRequest?: ProjectEditorOpenRequest | null
  onCloseProjectEditor?: () => void
  onProjectEditorDirtyChange?: (dirty: boolean) => void
  initialActiveSubpage?: SubpageId | null
  initialSubpageTerminalId?: string | null
  onActiveSubpageChange?: (subpage: SubpageId | null, terminalId: string | null) => void
  pinnedPrompts?: Prompt[]
  onSendAndExecutePinnedPrompt?: (terminalId: string, prompt: Prompt) => void
}

interface TerminalGitInfo {
  cwd: string | null
  repoRoot: string | null
  branch: string | null
  repoName: string | null
  status: TerminalGitStatus | null
}

const TERMINAL_PATH_SEGMENTS = 3
const FOCUS_REQUEST_MAX_ATTEMPTS = 12
const FOCUS_REQUEST_RETRY_MS = 50
const TERMINAL_CONTEXT_MENU_MARGIN = 8
const TERMINAL_CONTEXT_SUBMENU_GAP = 2
const PINNED_PROMPT_LABEL_LIMIT = 56

function ellipsis(value: string, maxLength: number): string {
  const oneLine = value.replace(/\s+/g, ' ').trim()
  return oneLine.length > maxLength ? `${oneLine.slice(0, Math.max(0, maxLength - 3))}...` : oneLine
}

function getPinnedPromptLabel(prompt: Prompt, fallback: string): string {
  const title = (prompt.title || '').trim()
  return title || ellipsis(prompt.content || '', 40) || fallback
}

async function resolveTerminalShellKind(terminalId: string): Promise<TerminalShellKind | undefined> {
  try {
    return (await window.electronAPI.terminal.getInputCapabilities(terminalId)).shellKind
  } catch {
    return undefined
  }
}

export const TerminalGrid = memo(function TerminalGrid({
  layoutMode,
  terminals,
  activeTerminalId,
  theme = 'vscode-dark',
  fontSize = DEFAULT_TERMINAL_FONT_SIZE,
  fontFamily = DEFAULT_TERMINAL_FONT_FAMILY,
  onTerminalFocus,
  onTerminalRename,
  onTerminalAutoRename,
  onPersistTerminalCwd,
  onOpenProjectEditor,
  tabId: _tabId,
  hidden = false,
  shortcutAction = null,
  focusRequest = null,
  projectEditorOpen = false,
  projectEditorTerminalId = null,
  projectEditorCwd = null,
  projectEditorOpenRequest = null,
  onCloseProjectEditor,
  onProjectEditorDirtyChange,
  initialActiveSubpage = null,
  initialSubpageTerminalId = null,
  onActiveSubpageChange,
  pinnedPrompts = [],
  onSendAndExecutePinnedPrompt
}: TerminalGridProps) {
  // Performance instrumentation: track render count
  perfMonitor.recordReactRender()

  const { t } = useI18n()
  const gridWrapperRef = useRef<HTMLDivElement | null>(null)
  const containerRefs = useRef<Map<string, HTMLDivElement>>(new Map())
  const hiddenRef = useRef(hidden)
  const prevHiddenForOverflowRef = useRef(hidden)
  const activeTerminalIdRef = useRef(activeTerminalId)
  const containerRefCallbacks = useRef<Map<string, (el: HTMLDivElement | null) => void>>(new Map())
  const terminalIdsRef = useRef<string[]>([])
  const visibleTerminalIdsRef = useRef<string[]>([])
  const transitionRef = useRef(0)
  const getTerminalOptionsRef = useRef<(terminalId: string) => TerminalSessionOptions>(() => ({
    theme,
    fontSize,
    fontFamily,
    terminalStyle: null
  }))

  const { getTerminalStyle, getAutoFollowGitBranchForTaskName, setAutoFollowGitBranchForTaskName } = useSettings()
  const { notifyTerminalGitInfo, getTerminalNameState, state: appStateForLayout } = useAppState()
  const currentAutoFollowEnabled = getAutoFollowGitBranchForTaskName()
  // Stable refs so auto-follow logic running inside callbacks always reads the
  // freshest values instead of capturing stale closures.
  const autoFollowEnabledRef = useRef<boolean>(currentAutoFollowEnabled)
  useEffect(() => {
    autoFollowEnabledRef.current = currentAutoFollowEnabled
  }, [currentAutoFollowEnabled])
  const onTerminalAutoRenameRef = useRef(onTerminalAutoRename)
  useEffect(() => {
    onTerminalAutoRenameRef.current = onTerminalAutoRename
  }, [onTerminalAutoRename])
  const onTerminalRenameRef = useRef(onTerminalRename)
  useEffect(() => {
    onTerminalRenameRef.current = onTerminalRename
  }, [onTerminalRename])
  // Detect OFF→ON transition of the auto-follow toggle. Per the design spec,
  // turning it back on must clear any active manual override and immediately
  // adopt the current branch (so the user sees the effect right away rather
  // than waiting for the next git-watch poll).
  const prevAutoFollowEnabledRef = useRef<boolean>(currentAutoFollowEnabled)
  useEffect(() => {
    const wasEnabled = prevAutoFollowEnabledRef.current
    prevAutoFollowEnabledRef.current = currentAutoFollowEnabled
    if (wasEnabled || !currentAutoFollowEnabled) return
    // OFF → ON: walk the currently visible terminals and reconcile.
    visibleTerminalsRef.current.forEach(term => {
      const info = terminalInfosRef.current[term.id]
      const newBranch = info?.branch ?? null
      const newRepoRoot = info?.repoRoot ?? null
      const manualRepoRoot = term.manualNameRepoRoot ?? null
      if (manualRepoRoot != null) {
        // Clear the manual override and adopt the new branch (or null when
        // the cwd is outside any repository).
        perfTrace(PERF_TRACE_EVENT.RENDERER_TASK_NAME_MANUAL_CLEAR, {
          taskId: term.id,
          prevRepoRoot: manualRepoRoot,
          newRepoRoot,
          newBranch,
          reason: 'auto-follow-toggled-on'
        })
        perfTrace(PERF_TRACE_EVENT.RENDERER_TASK_NAME_RESOLVE, {
          taskId: term.id,
          source: 'cleared-by-repo-switch',
          autoFollow: true,
          repoRoot: newRepoRoot,
          branch: newBranch,
          reason: 'auto-follow-toggled-on'
        })
        onTerminalAutoRenameRef.current(term.id, newBranch)
      } else if (newBranch != null && newBranch !== (term.customName ?? null)) {
        // No manual override, but the branch we know about diverges from the
        // currently displayed customName — sync.
        perfTrace(PERF_TRACE_EVENT.RENDERER_TASK_NAME_RESOLVE, {
          taskId: term.id,
          source: 'auto-branch',
          autoFollow: true,
          repoRoot: newRepoRoot,
          branch: newBranch,
          reason: 'auto-follow-toggled-on'
        })
        onTerminalAutoRenameRef.current(term.id, newBranch)
      }
    })
  }, [currentAutoFollowEnabled])

  const [displayLayoutMode, setDisplayLayoutMode] = useState<LayoutMode>(layoutMode)
  const [isTransitioning, setIsTransitioning] = useState(false)
  const customLayoutPresets = appStateForLayout.customLayoutPresets
  const resolvedLayout = useMemo(
    () => resolveLayout(layoutMode, customLayoutPresets),
    [layoutMode, customLayoutPresets]
  )
  const resolvedDisplayLayout = useMemo(
    () => resolveLayout(displayLayoutMode, customLayoutPresets),
    [displayLayoutMode, customLayoutPresets]
  )
  const effectiveCount = resolvedLayout.effectiveCount
  const displayEffectiveCount = resolvedDisplayLayout.effectiveCount

  // Edit status
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editingTitle, setEditingTitle] = useState('')
  const editInputRef = useRef<HTMLInputElement>(null)
  const editingIdRef = useRef<string | null>(null)
  // Title dropdown menu (single-click opens immediately — there is no longer a
  // double-click rename gesture, so no need to defer the open).
  const [titleMenuTerminalId, setTitleMenuTerminalId] = useState<string | null>(null)
  const titleMenuTerminalIdRef = useRef<string | null>(null)
  const titleAnchorsRef = useRef<Map<string, HTMLSpanElement | null>>(new Map())
  const focusRafRef = useRef<number | null>(null)
  const focusRetryTimerRef = useRef<number | null>(null)
  const latestFocusRequestRef = useRef<TerminalFocusRequest | null>(focusRequest)
  const lastHandledFocusTokenRef = useRef<number | null>(null)
  const warmDiffTimerRef = useRef<number | null>(null)
  // repoRoots already warmed at least once this session — used to fire the FIRST
  // warm on the leading edge (immediately) and apply the debounce only to re-warms.
  const warmedReposRef = useRef<Set<string>>(new Set())

  // Git Diff Viewer Status
  const [gitDiffOpen, setGitDiffOpen] = useState(false)
  const [gitDiffTerminalId, setGitDiffTerminalId] = useState<string | null>(null)
  const [gitDiffCwd, setGitDiffCwd] = useState<string | null>(null)
  const [gitDiffCwdPending, setGitDiffCwdPending] = useState(false)
  const [gitDiffOpenRequestedAt, setGitDiffOpenRequestedAt] = useState<number | null>(null)
  const [gitDiffCwdReadyAt, setGitDiffCwdReadyAt] = useState<number | null>(null)
  const [gitDiffNavigationTarget, setGitDiffNavigationTarget] = useState<{
    filePath: string
    repoRoot?: string | null
    nonce: number
  } | null>(null)
  const [gitHistoryOpen, setGitHistoryOpen] = useState(false)
  const [gitHistoryTerminalId, setGitHistoryTerminalId] = useState<string | null>(null)
  const [gitHistoryCwd, setGitHistoryCwd] = useState<string | null>(null)
  const [activeSubpage, setActiveSubpage] = useState<SubpageId | null>(initialActiveSubpage)
  const [panelShellStates, setPanelShellStates] = useState<Partial<Record<SubpageId, SubpagePanelShellState>>>({})
  const panelShellStatesRef = useRef<Partial<Record<SubpageId, SubpagePanelShellState>>>({})
  const subpageStateMemoryRef = useRef(createSubpageStateMemory())
  const executeSubpageRouteRef = useRef<((command: SubpageRouteCommand) => Promise<void>) | null>(null)
  // Explicit Git Diff cwd override, keyed by terminalId. Populated ONLY when a
  // `git-diff:open` CustomEvent carries an explicit `cwd` in its detail (an
  // autotest-only escape hatch — production call sites never set it). When
  // present, `handleViewGitDiff` opens against this path verbatim and bypasses
  // the racy terminalInfo / persisted / OSC cwd resolution. This makes Git Diff
  // deterministic against a nested fixture repo whose `cd` cwd report is absent
  // or lagged (e.g. under EDR-instrumented Windows shells).
  const gitDiffCwdOverrideRef = useRef<Record<string, string>>({})

  // Coding Agent launch modal state
  const [codingAgentModalOpen, setCodingAgentModalOpen] = useState(false)
  const [codingAgentTerminalId, setCodingAgentTerminalId] = useState<string | null>(null)
  // codingAgentType state removed — modal handles command selection internally
  const [terminalInfos, setTerminalInfos] = useState<Record<string, TerminalGitInfo>>({})
  // GitStateMirror parallel-subscription map (cwd → snapshot). Mirror takes
  // precedence over `terminalInfos` (which still comes from the legacy
  // GitWatchManager polling) whenever it has a fresh entry. The legacy path
  // remains as a fallback so no behaviour regresses while commits 5-9 are
  // still bringing the worker / OSC pipeline online — and so consumers
  // that haven't migrated yet (Project Editor, Quick Open) keep working.
  const [mirrorSnapshots, setMirrorSnapshots] = useState<Record<string, GitStateMirrorSnapshot>>({})
  const [mirrorSnapshotAliases, setMirrorSnapshotAliases] = useState<Record<string, string>>({})
  const oscDetectedCwdsRef = useRef<Record<string, string>>({})
  const lastRenderedGitSignalRef = useRef<Record<string, {
    cwd: string | null
    branch: string | null
    status: TerminalGitStatus | null
  }>>({})
  // macOS canonicalises `/var/...` to `/private/var/...` (the actual mount
  // point of the symlink). The mirror worker uses `path.resolve` so its
  // emitted `cwd` carries the `/private/` prefix; the renderer subscribes
  // with whatever raw form the OSC parser produced. Normalising both sides
  // with the same key keeps the `mirrorSnapshots` map consistent without
  // having to ship a node `path` polyfill into the renderer bundle.
  // OSC-detected cwd map (terminalId → cwd). Updated synchronously when
  // xterm.js parses an OSC 7/633/1337/9 sequence inside a session — the
  // session manager dispatches an 'onward:terminal-cwd-detected' CustomEvent
  // for that. We prefer this over `terminalInfos[id].cwd` because the legacy
  // poll path lags 0.4–1.5s while the OSC path is sub-frame.
  const [oscDetectedCwds, setOscDetectedCwds] = useState<Record<string, string>>({})
  useEffect(() => {
    oscDetectedCwdsRef.current = oscDetectedCwds
  }, [oscDetectedCwds])
  const [copyNotice, setCopyNotice] = useState<{ terminalId: string; type: 'success' | 'error'; text: string } | null>(null)
  const copyNoticeTimerRef = useRef<number | null>(null)
  const lastShortcutTokenRef = useRef<number | null>(null)
  const gitDiffOpenTokenRef = useRef(0)
  const gitDiffNavigationTargetNonceRef = useRef(0)
  const gitHistoryOpenTokenRef = useRef(0)
  const subpageNavigateTokenRef = useRef(0)
  const pendingSubpageRouteTargetRef = useRef<SubpageId | null>(null)
  const [terminalStatuses, setTerminalStatuses] = useState<Record<string, TerminalSessionStatus>>({})
  const projectEditorOpenInGrid = projectEditorOpen
    && Boolean(projectEditorTerminalId && terminals.some(term => term.id === projectEditorTerminalId))
  const globalOverlayActive = gitDiffOpen || gitHistoryOpen || projectEditorOpenInGrid
  const anySubpageOpen = globalOverlayActive
  const subpageOpenStateRef = useRef<Record<SubpageId, boolean>>({
    diff: false,
    editor: false,
    history: false
  })
  const [browserOpenTerminals, setBrowserOpenTerminals] = useState<Set<string>>(new Set())
  const [lastBrowserUrls, setLastBrowserUrls] = useState<Record<string, string>>({})
  // Per-terminal Auto Refresh interval in ms (null = off; in-session, survives Esc keep-alive).
  const [browserAutoRefresh, setBrowserAutoRefresh] = useState<Record<string, number | null>>({})
  // Terminals that have ever opened a browser, so the removal cleanup can destroy the
  // cached WebContentsView even after an Esc exit (which keeps the view alive in the main process).
  const browserEverOpenedRef = useRef<Set<string>>(new Set())
  const [isSubpageSwitching, setIsSubpageSwitching] = useState(false)

  // Terminal context menu state
  const [termCtxMenu, setTermCtxMenu] = useState<{ x: number; y: number; terminalId: string; hasSelection: boolean } | null>(null)
  const [termCtxMenuPosition, setTermCtxMenuPosition] = useState<{ x: number; y: number } | null>(null)
  const [termCtxPinnedOpen, setTermCtxPinnedOpen] = useState(false)
  const [termCtxPinnedFlipped, setTermCtxPinnedFlipped] = useState(false)
  const contextMenuListeners = useRef<Map<string, (e: MouseEvent) => void>>(new Map())
  const termCtxMenuRef = useRef<HTMLDivElement | null>(null)
  const termCtxPinnedSubmenuRef = useRef<HTMLDivElement | null>(null)
  const previousActiveSubpageRef = useRef<SubpageId | null>(null)
  const subpageSwitchTimerRef = useRef<number | null>(null)
  const orderedPinnedPrompts = useMemo(() => pinnedPrompts.filter(prompt => prompt.pinned), [pinnedPrompts])
  const orderedPinnedPromptCountRef = useRef(0)
  useEffect(() => {
    orderedPinnedPromptCountRef.current = orderedPinnedPrompts.length
  }, [orderedPinnedPrompts.length])

  const updatePanelShellState = useCallback((subpage: SubpageId, state: SubpagePanelShellState | null) => {
    setPanelShellStates((prev) => {
      if (state == null) {
        if (!(subpage in prev)) return prev
        const next = { ...prev }
        delete next[subpage]
        panelShellStatesRef.current = next
        return next
      }
      if (prev[subpage] === state) {
        return prev
      }
      const next = { ...prev, [subpage]: state }
      panelShellStatesRef.current = next
      return next
    })
  }, [])

  const handleDiffPanelShellStateChange = useCallback((state: SubpagePanelShellState | null) => {
    updatePanelShellState('diff', state)
  }, [updatePanelShellState])

  const handleEditorPanelShellStateChange = useCallback((state: SubpagePanelShellState | null) => {
    updatePanelShellState('editor', state)
  }, [updatePanelShellState])

  const handleHistoryPanelShellStateChange = useCallback((state: SubpagePanelShellState | null) => {
    updatePanelShellState('history', state)
  }, [updatePanelShellState])

  useLayoutEffect(() => {
    subpageOpenStateRef.current = {
      diff: gitDiffOpen,
      editor: projectEditorOpenInGrid,
      history: gitHistoryOpen
    }
  }, [gitDiffOpen, gitHistoryOpen, projectEditorOpenInGrid])

  // Sync activeSubpage to the open-panel set, but never override a still-valid
  // explicit user choice. The previous "transition-edge detector" had a race:
  // when Diff opened first via user click and the autotest auto-open of Editor
  // resolved its async cwd lookup AFTER, the editor branch fired with
  // `!previous.editor === true` and clobbered activeSubpage='diff' with
  // 'editor' (SN-05 reproduction). The new logic only picks a panel when the
  // current activeSubpage points to a closed panel.
  useLayoutEffect(() => {
    if (activeSubpage !== null && pendingSubpageRouteTargetRef.current === activeSubpage) {
      return
    }
    const currentStillOpen = (
      activeSubpage === 'diff' ? gitDiffOpen :
      activeSubpage === 'history' ? gitHistoryOpen :
      activeSubpage === 'editor' ? projectEditorOpenInGrid :
      false
    )
    if (activeSubpage !== null && currentStillOpen) return
    if (gitDiffOpen) setActiveSubpage('diff')
    else if (gitHistoryOpen) setActiveSubpage('history')
    else if (projectEditorOpenInGrid) setActiveSubpage('editor')
    else if (activeSubpage !== null) setActiveSubpage(null)
  }, [activeSubpage, gitDiffOpen, gitHistoryOpen, projectEditorOpenInGrid])

  const activePanelShellState = activeSubpage ? panelShellStates[activeSubpage] ?? null : null
  const lastPanelShellStateRef = useRef<SubpagePanelShellState | null>(null)
  const lastPanelShellStateBySubpageRef = useRef<Partial<Record<SubpageId, SubpagePanelShellState>>>({})
  if (activeSubpage && activePanelShellState) {
    lastPanelShellStateRef.current = activePanelShellState
    lastPanelShellStateBySubpageRef.current[activeSubpage] = activePanelShellState
  } else if (!anySubpageOpen) {
    lastPanelShellStateRef.current = null
  }
  const retainedPanelShellState = activeSubpage
    ? lastPanelShellStateBySubpageRef.current[activeSubpage] ?? null
    : null
  const renderedPanelShellState = activePanelShellState ?? (
    anySubpageOpen
      ? retainedPanelShellState ?? lastPanelShellStateRef.current
      : null
  )

  useEffect(() => {
    const previous = previousActiveSubpageRef.current
    previousActiveSubpageRef.current = activeSubpage
    if (!activeSubpage || !previous || previous === activeSubpage) {
      return
    }
    setIsSubpageSwitching(true)
    if (subpageSwitchTimerRef.current !== null) {
      window.clearTimeout(subpageSwitchTimerRef.current)
    }
    subpageSwitchTimerRef.current = window.setTimeout(() => {
      setIsSubpageSwitching(false)
      subpageSwitchTimerRef.current = null
    }, 180)
  }, [activeSubpage])

  useEffect(() => {
    return () => {
      if (subpageSwitchTimerRef.current !== null) {
        window.clearTimeout(subpageSwitchTimerRef.current)
      }
    }
  }, [])

  // Persist activeSubpage and its owning terminal back to TabState
  useEffect(() => {
    let terminalId: string | null = null
    if (activeSubpage === 'diff') {
      terminalId = gitDiffTerminalId
    } else if (activeSubpage === 'history') {
      terminalId = gitHistoryTerminalId
    } else if (activeSubpage === 'editor') {
      terminalId = projectEditorTerminalId
    }
    onActiveSubpageChange?.(activeSubpage, terminalId)
  }, [activeSubpage, gitDiffTerminalId, gitHistoryTerminalId, projectEditorTerminalId, onActiveSubpageChange])

  // Restore the last active subpage (diff/history) after app restart.
  // The editor subpage is restored by the parent via the projectEditorOpen prop.
  // Use the persisted subpageTerminalId so the correct CWD is loaded,
  // falling back to activeTerminalId only if the persisted ID is missing.
  const subpageRestoredRef = useRef(false)
  useEffect(() => {
    if (subpageRestoredRef.current) return
    if (!initialActiveSubpage || initialActiveSubpage === 'editor') return
    const restoreTerminalId = initialSubpageTerminalId || activeTerminalId
    if (!restoreTerminalId) return
    subpageRestoredRef.current = true
    // Defer so terminal info and refs are settled after mount
    const timer = window.setTimeout(() => {
      void executeSubpageRouteRef.current?.(buildSubpageRouteCommand({
        intent: 'restore',
        entryPoint: 'session-restore',
        terminalId: restoreTerminalId,
        from: null,
        target: initialActiveSubpage
      }))
    }, 0)
    return () => window.clearTimeout(timer)
    // Only run once on mount with initial values
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTerminalId])

  useEffect(() => {
    hiddenRef.current = hidden
  }, [hidden])

  useEffect(() => {
    activeTerminalIdRef.current = activeTerminalId
  }, [activeTerminalId])

  useEffect(() => {
    editingIdRef.current = editingId
  }, [editingId])

  const editingTitleRef = useRef<string>('')
  useEffect(() => {
    editingTitleRef.current = editingTitle
  }, [editingTitle])

  useEffect(() => {
    titleMenuTerminalIdRef.current = titleMenuTerminalId
  }, [titleMenuTerminalId])

  // OSC-detected cwd listener — fires synchronously when the session
  // manager's xterm OSC handler parses a cwd-bearing escape. Updates the
  // local terminalId→cwd map; render then prefers it over the legacy
  // poll-driven `terminalInfos[id].cwd`. It also persists cwd immediately
  // so a terminal can restore its project even before the slower git-info
  // bridge has emitted branch/status metadata.
  useEffect(() => {
    const onOscCwd = (e: Event) => {
      const detail = (e as CustomEvent<{ terminalId?: string; cwd?: string }>).detail
      if (!detail || !detail.terminalId || !detail.cwd) return
      const terminalId = detail.terminalId
      const cwd = detail.cwd
      const previousCwd = oscDetectedCwdsRef.current[detail.terminalId]
      setOscDetectedCwds((prev) => {
        if (prev[terminalId] === cwd) return prev
        return { ...prev, [terminalId]: cwd }
      })
      if (terminalIdsRef.current.includes(terminalId)) {
        onPersistTerminalCwd(terminalId, cwd)
      }
      if (previousCwd !== cwd) {
        setMirrorSnapshotAliases((prev) => removeMirrorAlias(prev, cwd))
      }
    }
    window.addEventListener('onward:terminal-cwd-detected', onOscCwd)
    return () => window.removeEventListener('onward:terminal-cwd-detected', onOscCwd)
  }, [onPersistTerminalCwd])

  useEffect(() => {
    const validIds = new Set(terminals.map(term => term.id))
    for (const [terminalId, cwd] of Object.entries(oscDetectedCwds)) {
      if (validIds.has(terminalId) && cwd) {
        onPersistTerminalCwd(terminalId, cwd)
      }
    }
  }, [oscDetectedCwds, terminals, onPersistTerminalCwd])

  // OSC-detected cwd rollback — fires when main's pushTerminalCwd
  // rejected a raw cwd (path does not exist / fails normalisation).
  // The renderer-side OSC handler commits the cwd synchronously for
  // the <50 ms latency win; this listener is the back-channel that
  // undoes phantom commits. Without it, an inner program emitting
  // `OSC 7 ; file:///<free-text>` would otherwise leave free text
  // pinned in the task header indefinitely (TTM-32 reproducer).
  useEffect(() => {
    const dispose = window.electronAPI?.git?.onMirrorCwdRejected?.((terminalId, rawCwd) => {
      const speculative = oscDetectedCwdsRef.current[terminalId]
      // Three distinct outcomes the trace must distinguish so post-mortem
      // can tell "rejection landed but a newer valid push had already
      // replaced the phantom" from "rejection landed and we cleaned it
      // up" from "rejection landed but our state never held this id".
      if (!speculative) {
        perfTrace(PERF_TRACE_EVENT.RENDERER_TERMINAL_OSC_CWD_ROLLED_BACK, {
          terminalId,
          rawCwd: rawCwd.slice(0, 512),
          action: 'skipped-no-speculative'
        })
        return
      }
      if (speculative !== rawCwd) {
        perfTrace(PERF_TRACE_EVENT.RENDERER_TERMINAL_OSC_CWD_ROLLED_BACK, {
          terminalId,
          rawCwd: rawCwd.slice(0, 512),
          action: 'skipped-value-mismatch',
          speculative: speculative.slice(0, 512)
        })
        return
      }
      setOscDetectedCwds((prev) => {
        if (!(terminalId in prev)) return prev
        const next = { ...prev }
        delete next[terminalId]
        return next
      })
      // Roll back the persisted cwd too: the OSC handler called
      // `onPersistTerminalCwd(terminalId, cwd)` synchronously when
      // it dispatched the local event. Persist null so the bad cwd
      // doesn't survive across sessions.
      const persisted = terminalIdsRef.current.includes(terminalId)
      if (persisted) {
        onPersistTerminalCwd(terminalId, null)
      }
      perfTrace(PERF_TRACE_EVENT.RENDERER_TERMINAL_OSC_CWD_ROLLED_BACK, {
        terminalId,
        rawCwd: rawCwd.slice(0, 512),
        action: 'rolled-back',
        persisted
      })
    })
    return () => { try { dispose?.() } catch { /* ignore */ } }
  }, [onPersistTerminalCwd])

  // GitStateMirror update listener — global, single subscription. Merges
  // every incoming delta into mirrorSnapshots keyed by cwd. Subsequent
  // useEffect manages per-cwd subscribe / unsubscribe lifecycle.
  useEffect(() => {
    const dispose = window.electronAPI?.git?.onMirrorUpdate?.((cwd, delta) => {
      const typedDelta = delta as GitStateMirrorDelta
      setMirrorSnapshots((prev) => mergeMirrorDeltaSnapshot(prev, cwd, typedDelta))
    })
    return () => { dispose?.() }
  }, [])

  // Per-cwd subscribe / unsubscribe driven by the union of cwds the legacy
  // poll path knows about AND cwds the OSC parser has just detected. The
  // worker attaches a watcher on first subscribe and detaches on last.
  // We deliberately depend on the cwd identity set (not full terminalInfos)
  // so churn in branch/status doesn't churn subscriptions.
  //
  // Subscriptions are keyed by NORMALIZED path (the same key
  // `mirrorSnapshots` uses), not the raw cwd string. Reason: a single
  // terminal often produces both raw forms simultaneously — the OSC
  // parser emits `/var/...` while the legacy git-info poll emits
  // `/private/var/...`. On macOS those are symlink-equivalent, so main's
  // `canonicalise` step collapses them to one entry in `subs.get(wcId)`.
  // Subscribing twice with two different raw forms used to produce ONE
  // main-side entry; a single unsubscribe (triggered when one of the raw
  // forms left `desired`) then deleted that entry — silently killing the
  // other raw form's subscription. Worker fanout would then skip this
  // renderer and the chip would stay stale even though the renderer
  // still believed it was subscribed. Deduplicating at the normalized
  // key keeps the renderer's subscription bookkeeping aligned with
  // main's per-canonical accounting.
  //
  // Unsubscribe uses a 30-second grace period rather than firing on the
  // same tick the cwd leaves `desired`. The motivation is concrete: the
  // worker's first watcher-attach + initial git-status pair for a cold
  // cwd costs hundreds of ms (parcel-watcher ENOENT/realpath, then a
  // synchronous `git rev-parse` + `git status`). A user `cd`-ing back to
  // a recently-visited repo within that window — or the GSM autotest's
  // sample loop, which oscillates between two repos every ~50 ms — would
  // otherwise pay that cold cost on every flip. With the grace window,
  // the second visit hits the warm router cache and the chip flips within
  // a frame. After the window expires, the cwd is genuinely unsubscribed
  // (worker detaches its parcel-watcher) so per-session memory stays
  // bounded by the number of distinct repos visited per ~30 s.
  const subscribedKeysRef = useRef<Map<string, string>>(new Map())
  const pendingUnsubTimersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map())
  const SUBSCRIPTION_GRACE_MS = 30_000
  useEffect(() => {
    // Build desired { normalizedKey -> rawCwd } from terminalInfos + OSC.
    // The first raw form to claim a key wins; subsequent raw forms with
    // the same normalization are ignored at the IPC layer.
    const desired = new Map<string, string>()
    for (const info of Object.values(terminalInfos)) {
      const raw = info?.cwd
      if (!raw) continue
      const key = normalizeTerminalGitPath(raw)
      if (key && !desired.has(key)) desired.set(key, raw)
    }
    for (const raw of Object.values(oscDetectedCwds)) {
      if (!raw) continue
      const key = normalizeTerminalGitPath(raw)
      if (key && !desired.has(key)) desired.set(key, raw)
    }
    const subscribed = subscribedKeysRef.current
    const pendingTimers = pendingUnsubTimersRef.current
    // Newly-desired keys: cancel any pending unsubscribe and (if not yet
    // subscribed) issue a fresh subscribe. The IPC handler is idempotent
    // per webContents.id, so a redundant subscribe is a no-op.
    for (const [key, rawCwd] of desired) {
      const pending = pendingTimers.get(key)
      if (pending) {
        clearTimeout(pending)
        pendingTimers.delete(key)
      }
      if (subscribed.has(key)) continue
      subscribed.set(key, rawCwd)
      void window.electronAPI?.git?.subscribeMirror?.(rawCwd).then((initial) => {
        if (!initial) return
        const snapshot = initial as GitStateMirrorSnapshot
        setMirrorSnapshots((prev) => mergeMirrorSnapshot(prev, snapshot))
        setMirrorSnapshotAliases((prev) => mergeMirrorAlias(prev, rawCwd, snapshot.cwd))
      }).catch(() => { /* tolerate */ })
    }
    // No-longer-desired keys: schedule a delayed unsubscribe rather than
    // tear down immediately (see grace-period rationale above). We reuse
    // the same raw form we subscribed with so main's `dropSubscription`
    // canonicalizes back to the same key it stored under.
    for (const [key, rawForUnsub] of subscribed) {
      if (desired.has(key)) continue
      if (pendingTimers.has(key)) continue
      const t = setTimeout(() => {
        pendingTimers.delete(key)
        subscribed.delete(key)
        setMirrorSnapshotAliases((prev) => removeMirrorAlias(prev, rawForUnsub))
        try { window.electronAPI?.git?.unsubscribeMirror?.(rawForUnsub) } catch { /* ignore */ }
      }, SUBSCRIPTION_GRACE_MS)
      pendingTimers.set(key, t)
    }
  }, [terminalInfos, oscDetectedCwds])

  // On unmount, cancel pending unsubs and immediately release every cwd we
  // had open. Without this the worker keeps watchers alive for 30 s after
  // the renderer goes away, leaking parcel-watcher fds.
  useEffect(() => {
    const subscribed = subscribedKeysRef.current
    const pendingTimers = pendingUnsubTimersRef.current
    return () => {
      for (const t of pendingTimers.values()) clearTimeout(t)
      pendingTimers.clear()
      for (const rawForUnsub of subscribed.values()) {
        try { window.electronAPI?.git?.unsubscribeMirror?.(rawForUnsub) } catch { /* ignore */ }
      }
      subscribed.clear()
    }
  }, [])

  const terminalInfosRef = useRef<Record<string, TerminalGitInfo>>({})
  useEffect(() => {
    terminalInfosRef.current = terminalInfos
  }, [terminalInfos])

  const visibleTerminalsRef = useRef<TerminalInfo[]>([])

  useEffect(() => {
    terminalIdsRef.current = terminals.map(t => t.id)
  }, [terminals])

  useEffect(() => {
    setTerminalStatuses(prev => {
      const next: Record<string, TerminalSessionStatus> = {}
      terminals.forEach(term => {
        next[term.id] = prev[term.id] ?? 'idle'
      })
      return next
    })
  }, [terminals])

  useEffect(() => {
    setTerminalInfos(prev => {
      const next: Record<string, TerminalGitInfo> = {}
      terminals.forEach(term => {
        if (prev[term.id]) {
          next[term.id] = prev[term.id]
        }
      })
      return next
    })
  }, [terminals])

  // Pair the terminalInfos pruning above with an analogous prune for
  // oscDetectedCwds. Without this, a closed terminal's last-seen cwd
  // remains in the map indefinitely, so the subscribe useEffect keeps
  // treating it as "desired" and the 30-second mirror-grace timer below
  // never fires for that cwd — the worker holds the parcel-watcher open
  // until the whole TerminalGrid unmounts (effectively until app quit).
  useEffect(() => {
    setOscDetectedCwds(prev => {
      const validIds = new Set(terminals.map(t => t.id))
      let changed = false
      const next: Record<string, string> = {}
      for (const [id, cwd] of Object.entries(prev)) {
        if (validIds.has(id)) next[id] = cwd
        else changed = true
      }
      return changed ? next : prev
    })
  }, [terminals])

  useEffect(() => {
    const validTerminalIds = new Set(terminals.map(term => term.id))

    // Leak guard: destroy the cached WebContentsView for any terminal that was removed.
    // Esc keep-alive leaves the view alive in the main process, so closing/removing the
    // terminal is the only place that must explicitly tear it down.
    for (const id of [...browserEverOpenedRef.current]) {
      if (!validTerminalIds.has(id)) {
        browserEverOpenedRef.current.delete(id)
        window.electronAPI.browser.destroy(`browser-${id}`).catch(() => {
          // Ignore destroy races for an already-gone view.
        })
      }
    }

    setBrowserOpenTerminals(prev => {
      const next = new Set<string>()
      prev.forEach(id => {
        if (validTerminalIds.has(id)) {
          next.add(id)
        }
      })
      return next
    })

    setLastBrowserUrls(prev => {
      const next = Object.fromEntries(
        Object.entries(prev).filter(([terminalId]) => validTerminalIds.has(terminalId))
      )
      return next
    })

    setBrowserAutoRefresh(prev => {
      const next = Object.fromEntries(
        Object.entries(prev).filter(([terminalId]) => validTerminalIds.has(terminalId))
      )
      return Object.keys(next).length === Object.keys(prev).length ? prev : next
    })
  }, [terminals])

  const visibleTerminals = useMemo(() => {
    return terminals.slice(0, displayEffectiveCount)
  }, [terminals, displayEffectiveCount])

  useEffect(() => {
    visibleTerminalIdsRef.current = visibleTerminals.map(term => term.id)
    visibleTerminalsRef.current = visibleTerminals
  }, [visibleTerminals])

  useLayoutEffect(() => {
    const visibleIds = new Set(visibleTerminals.map(term => term.id))
    terminals.forEach((term) => {
      terminalSessionManager.setOutputVisibility(term.id, !hidden && visibleIds.has(term.id))
    })
  }, [hidden, terminals, visibleTerminals])

  useEffect(() => {
    latestFocusRequestRef.current = focusRequest
  }, [focusRequest])

  const getTerminalOptions = useCallback((terminalId: string): TerminalSessionOptions => {
    return {
      theme,
      fontSize,
      fontFamily,
      terminalStyle: getTerminalStyle(terminalId)
    }
  }, [theme, fontSize, fontFamily, getTerminalStyle])

  useEffect(() => {
    if (hidden) return
    const nextSignals: typeof lastRenderedGitSignalRef.current = {}
    for (const termInfo of visibleTerminals) {
      const terminalInfo = terminalInfos[termInfo.id]
      const oscCwd = oscDetectedCwds[termInfo.id]
      const cwd = oscCwd || terminalInfo?.cwd || null
      const gitState = resolveTerminalGitDisplayState({
        cwd,
        terminalInfo,
        mirrorSnapshots,
        mirrorAliases: mirrorSnapshotAliases
      })
      const rawBranchSig = gitState.branch
      const rawStatusSig = gitState.status
      // Apply autotest override on top of the mirror/legacy union — see
      // the parallel block in the render pass (~line 2380) for rationale.
      const sigOverride = terminalInfoOverridesRef.current.get(termInfo.id)
      const branch = sigOverride?.branch !== undefined ? sigOverride.branch : rawBranchSig
      const status = sigOverride?.status !== undefined ? sigOverride.status : rawStatusSig
      const signal = { cwd: gitState.normalizedCwd ?? cwd, branch, status }
      const previous = lastRenderedGitSignalRef.current[termInfo.id]
      if (!previous || previous.branch !== signal.branch) {
        perfTraceTask(PERF_TRACE_EVENT.RENDERER_TERMINAL_TITLE_BRANCH_RENDERED, {
          terminalId: termInfo.id,
          cwd: signal.cwd,
          branch: signal.branch
        }, termInfo.id)
      }
      if (!previous || previous.status !== signal.status) {
        perfTraceTask(PERF_TRACE_EVENT.RENDERER_TERMINAL_TITLE_COLOR_RENDERED, {
          terminalId: termInfo.id,
          cwd: signal.cwd,
          status: signal.status ?? 'unknown'
        }, termInfo.id)
      }
      nextSignals[termInfo.id] = signal
    }
    lastRenderedGitSignalRef.current = nextSignals
  }, [hidden, visibleTerminals, terminalInfos, oscDetectedCwds, mirrorSnapshots, mirrorSnapshotAliases])

  const formatCompactPath = useCallback((cwd: string): string => {
    const trimmed = cwd.trim()
    if (!trimmed) return ''
    const separator = trimmed.includes('\\') ? '\\' : '/'
    const segments = trimmed.split(/[\\/]+/).filter(Boolean)
    if (segments.length === 0) return trimmed

    if (segments.length <= TERMINAL_PATH_SEGMENTS) {
      const hasRoot = trimmed.startsWith(separator)
      return `${hasRoot ? separator : ''}${segments.join(separator)}`
    }

    return `...${separator}${segments.slice(-TERMINAL_PATH_SEGMENTS).join(separator)}`
  }, [])

  const showCopyNotice = useCallback((terminalId: string, type: 'success' | 'error', text: string) => {
    setCopyNotice({ terminalId, type, text })
    if (copyNoticeTimerRef.current) {
      window.clearTimeout(copyNoticeTimerRef.current)
    }
    copyNoticeTimerRef.current = window.setTimeout(() => {
      setCopyNotice(null)
    }, 2000)
  }, [])

  useEffect(() => {
    return () => {
      if (copyNoticeTimerRef.current) {
        window.clearTimeout(copyNoticeTimerRef.current)
      }
    }
  }, [])

  const copyTextToClipboard = useCallback(async (text: string): Promise<boolean> => {
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text)
        return true
      }
    } catch {
      // ignore
    }

    try {
      const textarea = document.createElement('textarea')
      textarea.value = text
      textarea.style.position = 'fixed'
      textarea.style.left = '-9999px'
      textarea.style.opacity = '0'
      document.body.appendChild(textarea)
      // preventScroll avoids scrollIntoView side-effects from focusing an
      // off-screen element while a terminal is visible behind us.
      textarea.focus({ preventScroll: true })
      textarea.select()
      const ok = document.execCommand('copy')
      document.body.removeChild(textarea)
      return ok
    } catch {
      return false
    }
  }, [])

  const getPersistedTerminalCwd = useCallback((terminalId: string): string | null => {
    const terminal = terminals.find((item) => item.id === terminalId)
    const lastCwd = terminal?.lastCwd
    return typeof lastCwd === 'string' && lastCwd.trim() ? lastCwd : null
  }, [terminals])

  const handleCopyText = useCallback(async (
    e: React.MouseEvent,
    terminalId: string,
    label: string,
    text: string | null
  ) => {
    if (!text) return
    // Capture target synchronously — React clears SyntheticEvent.currentTarget after the handler returns.
    const target = e.currentTarget as HTMLElement
    const success = await copyTextToClipboard(text)
    if (success) {
      showCopyNotice(terminalId, 'success', t('terminalGrid.copyNotice', { label, text }))
      window.getSelection()?.removeAllRanges()
      target.classList.add('copy-flash')
      window.setTimeout(() => target.classList.remove('copy-flash'), 300)
    } else {
      showCopyNotice(terminalId, 'error', t('terminalGrid.copyFailed'))
    }
  }, [copyTextToClipboard, showCopyNotice, t])

  // Terminal context menu handlers
  const closeTermCtxMenu = useCallback(() => {
    setTermCtxMenu(null)
    setTermCtxPinnedOpen(false)
  }, [])

  const handleTermCtxCopy = useCallback(() => {
    if (!termCtxMenu) return
    const session = terminalSessionManager.getSession(termCtxMenu.terminalId)
    if (session) {
      const selection = session.terminal.getSelection()
      if (selection) {
        void navigator.clipboard.writeText(selection)
        session.terminal.clearSelection()
      }
    }
    closeTermCtxMenu()
  }, [termCtxMenu, closeTermCtxMenu])

  const handleTermCtxPaste = useCallback(() => {
    if (!termCtxMenu) return
    const termId = termCtxMenu.terminalId
    void navigator.clipboard.readText().then((text) => {
      if (text) {
        // Use xterm.js paste() so bracketed paste mode is applied
        terminalSessionManager.paste(termId, text)
      }
    })
    closeTermCtxMenu()
    terminalSessionManager.focus(termId)
  }, [termCtxMenu, closeTermCtxMenu])

  const handleTermCtxSelectAll = useCallback(() => {
    if (!termCtxMenu) return
    const session = terminalSessionManager.getSession(termCtxMenu.terminalId)
    session?.terminal.selectAll()
    closeTermCtxMenu()
  }, [termCtxMenu, closeTermCtxMenu])

  const handleTermCtxClear = useCallback(() => {
    if (!termCtxMenu) return
    const termId = termCtxMenu.terminalId
    const session = terminalSessionManager.getSession(termId)
    session?.terminal.clear()
    closeTermCtxMenu()
    terminalSessionManager.focus(termId)
  }, [termCtxMenu, closeTermCtxMenu])

  const handleTermCtxSendPinnedPrompt = useCallback((prompt: Prompt) => {
    if (!termCtxMenu || !onSendAndExecutePinnedPrompt) return
    const terminalId = termCtxMenu.terminalId
    perfTraceTask(PERF_TRACE_EVENT.RENDERER_TERMINAL_CTX_PINNED_PROMPT_SEND, {
      bytes: prompt.content.length,
      pinnedCount: orderedPinnedPrompts.length
    }, terminalId)
    onSendAndExecutePinnedPrompt(terminalId, prompt)
    closeTermCtxMenu()
    terminalSessionManager.focus(terminalId)
  }, [termCtxMenu, onSendAndExecutePinnedPrompt, orderedPinnedPrompts.length, closeTermCtxMenu])

  useLayoutEffect(() => {
    if (!termCtxMenu) {
      setTermCtxMenuPosition(null)
      return
    }
    const el = termCtxMenuRef.current
    if (!el) {
      setTermCtxMenuPosition({ x: termCtxMenu.x, y: termCtxMenu.y })
      return
    }
    const rect = el.getBoundingClientRect()
    // Shared flip-then-clamp placement: near the bottom edge the menu now
    // flips above the cursor (VS Code-style) instead of hugging the edge.
    const result = computeMenuPosition({
      anchor: { x: termCtxMenu.x, y: termCtxMenu.y },
      menu: { width: rect.width, height: rect.height },
      viewport: { width: window.innerWidth, height: window.innerHeight },
      margin: TERMINAL_CONTEXT_MENU_MARGIN
    })
    const next = { x: result.x, y: result.y }
    setTermCtxMenuPosition(prev => (prev?.x === next.x && prev.y === next.y ? prev : next))
  }, [termCtxMenu, termCtxPinnedOpen, orderedPinnedPrompts.length])

  useLayoutEffect(() => {
    if (!termCtxPinnedOpen) {
      setTermCtxPinnedFlipped(false)
      return
    }
    const menu = termCtxMenuRef.current
    const submenu = termCtxPinnedSubmenuRef.current
    if (!menu || !submenu) return
    const menuRect = menu.getBoundingClientRect()
    const submenuRect = submenu.getBoundingClientRect()
    // Shared side-picking math; this host only needs the flip boolean (CSS
    // places the submenu), so consume `openRight` and ignore coordinates.
    const layout = computeSubmenuLayout({
      anchorRect: menuRect,
      natural: { width: submenuRect.width, height: submenuRect.height },
      viewport: { width: window.innerWidth, height: window.innerHeight },
      margin: TERMINAL_CONTEXT_MENU_MARGIN,
      gap: TERMINAL_CONTEXT_SUBMENU_GAP
    })
    setTermCtxPinnedFlipped(!layout.openRight)
  }, [termCtxPinnedOpen, orderedPinnedPrompts.length])

  // Close terminal context menu on mousedown outside
  useEffect(() => {
    if (!termCtxMenu) return
    const handleMouseDown = (event: MouseEvent) => {
      if (termCtxMenuRef.current?.contains(event.target as Node)) return
      closeTermCtxMenu()
    }
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      closeTermCtxMenu()
    }
    document.addEventListener('mousedown', handleMouseDown)
    document.addEventListener('keydown', handleKeyDown)
    return () => {
      document.removeEventListener('mousedown', handleMouseDown)
      document.removeEventListener('keydown', handleKeyDown)
    }
  }, [termCtxMenu, closeTermCtxMenu])

  // Autotest-only sticky overrides so tests can pin branch / repoName without
  // being clobbered by the main-process git watcher poll cycle.
  const terminalInfoOverridesRef = useRef<Map<string, Partial<TerminalGitInfo>>>(new Map())

  // Tasks whose auto-follow has already seen its first post-mount git-info
  // evaluation. The hydration barrier (see auto-follow-name.ts) uses this so the
  // boot-time sync cannot overwrite a customName that was just loaded from disk.
  const initialAutoFollowDoneRef = useRef<Set<string>>(new Set())

  const mergeOverride = useCallback((terminalId: string, info: TerminalGitInfo): TerminalGitInfo => {
    const override = terminalInfoOverridesRef.current.get(terminalId)
    if (!override) return info
    return {
      cwd: override.cwd !== undefined ? override.cwd : info.cwd,
      repoRoot: override.repoRoot !== undefined ? override.repoRoot : info.repoRoot,
      branch: override.branch !== undefined ? override.branch : info.branch,
      repoName: override.repoName !== undefined ? override.repoName : info.repoName,
      status: override.status !== undefined ? override.status : info.status
    }
  }, [])

  const applyTerminalInfoUpdate = useCallback((terminalId: string, info: TerminalGitInfo | null) => {
    if (!info) return
    if (typeof info.cwd === 'string' && info.cwd.trim()) {
      onPersistTerminalCwd(terminalId, info.cwd)
    }
    const effective = mergeOverride(terminalId, info)
    setTerminalInfos(prev => {
      const current = prev[terminalId]
      if (
        current?.cwd === effective.cwd &&
        current?.repoRoot === effective.repoRoot &&
        current?.branch === effective.branch &&
        current?.repoName === effective.repoName &&
        current?.status === effective.status
      ) {
        return prev
      }
      return { ...prev, [terminalId]: effective }
    })
    // Share the latest Git info with AppState so PromptSender's manual-rename
    // path can stamp manualNameRepoRoot atomically.
    notifyTerminalGitInfo(terminalId, {
      repoRoot: effective.repoRoot ?? null,
      branch: effective.branch ?? null
    })
    // Auto-follow side-effect: drive the customName based on the new Git info.
    // The keep / clear / adopt rules (plus the boot-time hydration barrier) live
    // in the pure `decideTaskNameAutoFollow` so they are unit-testable; here we
    // only map the decision onto trace breadcrumbs and the actual rename call.
    const visibleTerminal = visibleTerminalsRef.current.find(term => term.id === terminalId)
    const newRepoRoot = effective.repoRoot ?? null
    const newBranch = effective.branch ?? null
    // Read name + marker from the AUTHORITATIVE AppState (updated synchronously
    // in the state updater), NOT from the one-render-cycle-behind visibleTerminals
    // ref. A stale read here lets a git-info sync that lands right after a manual
    // rename see marker=null, miss guard (a), and clobber the user's name. The
    // visibleTerminal lookup above is kept only for the visibility check.
    const { customName: currentCustomName, manualNameRepoRoot: currentManualRepoRoot } =
      getTerminalNameState(terminalId)
    // First git-info evaluation for this Task since it mounted? Drives the
    // hydration barrier so the boot-time sync cannot clobber a customName that
    // was just loaded from disk before its manual-override marker is honoured.
    const isInitialPass = !initialAutoFollowDoneRef.current.has(terminalId)
    if (visibleTerminal) initialAutoFollowDoneRef.current.add(terminalId)

    const decision = decideTaskNameAutoFollow({
      autoFollowEnabled: autoFollowEnabledRef.current,
      terminalVisible: Boolean(visibleTerminal),
      currentCustomName,
      currentManualRepoRoot,
      newRepoRoot,
      newBranch,
      isInitialPass
    })

    switch (decision.source) {
      case 'skipped-disabled':
        perfTrace(PERF_TRACE_EVENT.RENDERER_TASK_NAME_RESOLVE, {
          taskId: terminalId, source: 'skipped-disabled', autoFollow: false, repoRoot: newRepoRoot, branch: newBranch
        })
        break
      case 'not-visible':
        perfTrace(PERF_TRACE_EVENT.RENDERER_TASK_NAME_RESOLVE, {
          taskId: terminalId, source: 'fallback', reason: 'not-visible', autoFollow: true, repoRoot: newRepoRoot, branch: newBranch
        })
        break
      case 'manual':
        perfTrace(PERF_TRACE_EVENT.RENDERER_TASK_NAME_RESOLVE, {
          taskId: terminalId, source: 'manual', autoFollow: true, repoRoot: newRepoRoot, branch: newBranch, customName: currentCustomName
        })
        break
      case 'cleared-by-repo-switch':
        perfTrace(PERF_TRACE_EVENT.RENDERER_TASK_NAME_MANUAL_CLEAR, {
          taskId: terminalId, prevRepoRoot: currentManualRepoRoot, newRepoRoot, newBranch
        })
        perfTrace(PERF_TRACE_EVENT.RENDERER_TASK_NAME_RESOLVE, {
          taskId: terminalId, source: 'cleared-by-repo-switch', autoFollow: true, repoRoot: newRepoRoot, branch: newBranch
        })
        break
      case 'skipped-initial-hydration':
        // Hydration barrier engaged: a just-loaded customName was protected from
        // the boot-time branch sync. Breadcrumb for the "renames reverted after
        // restart" bug class.
        perfTrace(PERF_TRACE_EVENT.RENDERER_TASK_NAME_RESOLVE, {
          taskId: terminalId, source: 'skipped-initial-hydration', autoFollow: true, repoRoot: newRepoRoot, branch: newBranch, customName: currentCustomName
        })
        break
      case 'auto-branch':
        perfTrace(PERF_TRACE_EVENT.RENDERER_TASK_NAME_RESOLVE, {
          taskId: terminalId, source: 'auto-branch', autoFollow: true, repoRoot: newRepoRoot, branch: newBranch, customName: currentCustomName
        })
        break
      case 'no-change':
        perfTrace(PERF_TRACE_EVENT.RENDERER_TASK_NAME_RESOLVE, {
          taskId: terminalId, source: 'fallback', reason: 'no-change', autoFollow: true, repoRoot: newRepoRoot, branch: newBranch, customName: currentCustomName
        })
        break
    }

    if (decision.rename) {
      onTerminalAutoRenameRef.current(terminalId, decision.branch)
    }
  }, [mergeOverride, notifyTerminalGitInfo, onPersistTerminalCwd, getTerminalNameState])

  const setTerminalStatus = useCallback((terminalId: string, status: TerminalSessionStatus) => {
    setTerminalStatuses(prev => {
      if (prev[terminalId] === status) return prev
      return { ...prev, [terminalId]: status }
    })
  }, [])

  // Notify TerminalSessionManager of visibility changes so hidden terminals
  // can skip xterm.write() and release WebGL contexts.
  // Only reacts to the `hidden` prop (tab switch), NOT to visibleTerminals
  // changes (layout transition), to avoid disposing WebGL during init.
  // Uses useLayoutEffect so WebGL rebuild + data flush + fit complete
  // BEFORE the browser paints, preventing the visible width "shrink" glitch.
  useLayoutEffect(() => {
    const ids = terminals.map(term => term.id)
    ids.forEach(id => terminalSessionManager.setVisibility(id, !hidden))
  }, [hidden, terminals])

  useEffect(() => {
    if (hidden || visibleTerminals.length === 0) return
    const ids = visibleTerminals.map(term => term.id)
    ids.forEach((terminalId) => {
      void window.electronAPI.git.subscribeTerminalInfo(terminalId)
    })
    return () => {
      ids.forEach((terminalId) => {
        void window.electronAPI.git.unsubscribeTerminalInfo(terminalId)
      })
    }
  }, [visibleTerminals, hidden])

  useEffect(() => {
    if (hidden || !activeTerminalId) return
    const isVisible = visibleTerminals.some(term => term.id === activeTerminalId)
    if (!isVisible) return
    void window.electronAPI.git.notifyTerminalFocus(activeTerminalId)
  }, [activeTerminalId, hidden, visibleTerminals])

  useEffect(() => {
    const unsubscribe = window.electronAPI.git.onTerminalInfo((terminalId, info) => {
      applyTerminalInfoUpdate(terminalId, info)

      // Background diff cache warming: when git state changes and diff panel is not open,
      // proactively compute diff so opening the panel is near-instant.
      const repoRoot = info?.repoRoot
      if (repoRoot && !gitDiffOpen) {
        if (!warmedReposRef.current.has(repoRoot)) {
          // Leading edge: the FIRST time we see a repo (e.g. a terminal just
          // spawned in-project), warm immediately so a user who opens Git Diff
          // right away already finds a warm cache — don't make them wait out a
          // 2s debounce on top of the cold compute.
          warmedReposRef.current.add(repoRoot)
          void window.electronAPI.git.warmDiffCache(repoRoot)
        } else {
          // Subsequent state changes: debounce re-warms so rapid churn does not
          // queue a warm per event (the warm is also in-flight-deduped + runs in
          // the low-priority ::diff-precompute lane, so this is just politeness).
          if (warmDiffTimerRef.current) clearTimeout(warmDiffTimerRef.current)
          warmDiffTimerRef.current = window.setTimeout(() => {
            void window.electronAPI.git.warmDiffCache(repoRoot)
          }, 2000)
        }
      }
    })
    return () => {
      unsubscribe()
      if (warmDiffTimerRef.current) {
        clearTimeout(warmDiffTimerRef.current)
        warmDiffTimerRef.current = null
      }
    }
  }, [applyTerminalInfoUpdate, gitDiffOpen])

  useEffect(() => {
    if (hidden) return

    const notifySurfaceEvent = (reason: TerminalRendererSurfaceEvent) => {
      terminalSessionManager.notifyHostSurfaceEvent(reason)
    }

    const handleWindowFocus = () => {
      notifySurfaceEvent('window-focus')
    }

    const handleVisibilityChange = () => {
      if (document.hidden) {
        // Keep-alive contract (peer-aligned with VS Code / native GPU
        // terminals): occlusion never tears down WebGL. Chromium's own
        // background throttling pauses rendering; a genuine GPU reclaim
        // surfaces as webglcontextlost and takes the fallback path. The
        // old suspend-here design forced an N-context + shared-atlas
        // rebuild storm on every Space switch-back (white flash, 1-3s).
        terminalSessionManager.noteDocumentHiddenKeepAlive()
      } else {
        notifySurfaceEvent('document-visible')
      }
    }

    const handlePageShow = () => {
      notifySurfaceEvent('page-show')
    }

    window.addEventListener('focus', handleWindowFocus)
    document.addEventListener('visibilitychange', handleVisibilityChange)
    window.addEventListener('pageshow', handlePageShow)

    return () => {
      window.removeEventListener('focus', handleWindowFocus)
      document.removeEventListener('visibilitychange', handleVisibilityChange)
      window.removeEventListener('pageshow', handlePageShow)
    }
  }, [hidden])

  useEffect(() => {
    getTerminalOptionsRef.current = (terminalId: string) => ({
      theme,
      fontSize,
      fontFamily,
      terminalStyle: getTerminalStyle(terminalId)
    })
  }, [theme, fontSize, fontFamily, getTerminalStyle])

  const fitTerminal = useCallback((id: string) => {
    terminalSessionManager.fit(id)
  }, [])

  const fitAll = useCallback(() => {
    visibleTerminals.forEach(t => {
      fitTerminal(t.id)
    })
  }, [visibleTerminals, fitTerminal])

  const cancelPendingFocus = useCallback(() => {
    if (focusRafRef.current !== null) {
      cancelAnimationFrame(focusRafRef.current)
      focusRafRef.current = null
    }
    if (focusRetryTimerRef.current !== null) {
      window.clearTimeout(focusRetryTimerRef.current)
      focusRetryTimerRef.current = null
    }
  }, [])

  const attemptFocusRequest = useCallback((request: TerminalFocusRequest, attempt: number) => {
    if (latestFocusRequestRef.current?.token !== request.token) {
      debugLog('focus-request:drop-stale-token', {
        request,
        latest: latestFocusRequestRef.current
      })
      return
    }

    if (hiddenRef.current || editingIdRef.current) {
      debugLog('focus-request:skip-hidden-or-editing', {
        request,
        hidden: hiddenRef.current,
        editingId: editingIdRef.current
      })
      return
    }

    const isVisible = visibleTerminalIdsRef.current.includes(request.terminalId)
    if (!isVisible) {
      debugLog('focus-request:skip-invisible', {
        request,
        visibleTerminalIds: visibleTerminalIdsRef.current
      })
      return
    }

    const focused = terminalSessionManager.focusIfNeeded(request.terminalId)
    debugLog('focus-request:attempt', {
      request,
      attempt,
      focused,
      snapshot: terminalSessionManager.getFocusDebugSnapshot(request.terminalId)
    })
    if (focused) {
      lastHandledFocusTokenRef.current = request.token
      return
    }

    if (attempt + 1 >= FOCUS_REQUEST_MAX_ATTEMPTS) {
      debugLog('focus-request:exhausted', {
        request,
        attempt,
        snapshot: terminalSessionManager.getFocusDebugSnapshot(request.terminalId)
      })
      return
    }

    focusRetryTimerRef.current = window.setTimeout(() => {
      focusRetryTimerRef.current = null
      focusRafRef.current = requestAnimationFrame(() => {
        focusRafRef.current = null
        attemptFocusRequest(request, attempt + 1)
      })
    }, FOCUS_REQUEST_RETRY_MS)
  }, [])

  const scheduleFocusRequest = useCallback((request: TerminalFocusRequest | null) => {
    cancelPendingFocus()
    if (!request) return

    if (lastHandledFocusTokenRef.current === request.token) {
      return
    }

    if (hiddenRef.current || editingIdRef.current) {
      debugLog('focus-request:not-scheduled-hidden-or-editing', {
        request,
        hidden: hiddenRef.current,
        editingId: editingIdRef.current
      })
      return
    }

    const isVisible = visibleTerminalIdsRef.current.includes(request.terminalId)
    if (!isVisible) {
      debugLog('focus-request:not-scheduled-invisible', {
        request,
        visibleTerminalIds: visibleTerminalIdsRef.current
      })
      return
    }

    if (!focusCoordinator.shouldApplyFocusRequest(request.reason)) {
      debugLog('focus-request:suppressed', {
        request,
        pointer: focusCoordinator.getDebugState()
      })
      lastHandledFocusTokenRef.current = request.token
      return
    }

    if (lastHandledFocusTokenRef.current === request.token && terminalSessionManager.isFocused(request.terminalId)) {
      debugLog('focus-request:already-focused', {
        request,
        snapshot: terminalSessionManager.getFocusDebugSnapshot(request.terminalId)
      })
      return
    }

    debugLog('focus-request:scheduled', {
      request,
      snapshot: terminalSessionManager.getFocusDebugSnapshot(request.terminalId)
    })
    focusRafRef.current = requestAnimationFrame(() => {
      focusRafRef.current = requestAnimationFrame(() => {
        focusRafRef.current = null
        attemptFocusRequest(request, 0)
      })
    })
  }, [attemptFocusRequest, cancelPendingFocus])

  const adaptiveCollapseRef = useRef<ResizeObserver | null>(null)
  // Breaks the ResizeObserver⇄layout feedback loop in the adaptive-header
  // overflow check: `adaptiveAdjustingRef` is held across the frame while our own
  // class mutations land so the resulting ResizeObserver callbacks are dropped
  // (a self-induced resize must not re-run the check); `adaptiveCheckRafRef`
  // coalesces genuine external resizes to one check per frame. Without this the
  // check re-fired every frame and pinned a renderer Helper at ~165% idle CPU.
  const adaptiveAdjustingRef = useRef(false)
  const adaptiveCheckRafRef = useRef<number | null>(null)

  useLayoutEffect(() => {
    const wasHidden = prevHiddenForOverflowRef.current
    prevHiddenForOverflowRef.current = hidden

    if (hidden) return
    const wrapper = gridWrapperRef.current
    if (!wrapper) return

    const checkOverflow = () => {
      // Hold the guard across this frame so the ResizeObserver callbacks our own
      // class mutations queue are dropped by scheduleOverflowCheck — otherwise the
      // remove→re-add of `adaptive-force-collapsed` each pass re-triggers the
      // observer and the check spins every frame (markdown-preview-cpu).
      adaptiveAdjustingRef.current = true
      try {
        const cells = wrapper.querySelectorAll('.terminal-grid-cell')
        cells.forEach((cell) => {
          const headerLeft = cell.querySelector('.terminal-grid-header-left') as HTMLElement | null
          if (!headerLeft) return

          const cwdEl = headerLeft.querySelector('.terminal-grid-adaptive-cwd')
          const repoEl = headerLeft.querySelector('.terminal-grid-adaptive-repo')
          const branchEl = headerLeft.querySelector('.terminal-grid-branch')

          cwdEl?.classList.remove('adaptive-force-collapsed')
          repoEl?.classList.remove('adaptive-force-collapsed')
          branchEl?.classList.remove('branch-allow-shrink')

          void headerLeft.offsetWidth

          if (headerLeft.scrollWidth > headerLeft.clientWidth + 1) {
            cwdEl?.classList.add('adaptive-force-collapsed')
            void headerLeft.offsetWidth

            if (headerLeft.scrollWidth > headerLeft.clientWidth + 1) {
              repoEl?.classList.add('adaptive-force-collapsed')
              void headerLeft.offsetWidth

              if (headerLeft.scrollWidth > headerLeft.clientWidth + 1) {
                branchEl?.classList.add('branch-allow-shrink')
              }
            }
          }
        })
      } finally {
        // Release on the NEXT frame: the observer callbacks for this frame's
        // mutations are delivered after layout (this frame) while the guard is
        // still set, so they are dropped; a genuine later resize re-runs it.
        requestAnimationFrame(() => { adaptiveAdjustingRef.current = false })
      }
    }

    const scheduleOverflowCheck = () => {
      // Drop self-induced resizes (guard) and coalesce real ones to one rAF.
      if (adaptiveAdjustingRef.current || adaptiveCheckRafRef.current !== null) return
      adaptiveCheckRafRef.current = requestAnimationFrame(() => {
        adaptiveCheckRafRef.current = null
        checkOverflow()
      })
    }

    // Skip immediate checkOverflow on hidden→visible transition to avoid
    // forced synchronous reflows during tab switch; the ResizeObserver
    // will handle measurement once dimensions stabilize.
    if (!wasHidden) {
      checkOverflow()
    }

    const observer = new ResizeObserver(scheduleOverflowCheck)
    adaptiveCollapseRef.current = observer
    const cells = wrapper.querySelectorAll('.terminal-grid-cell')
    cells.forEach((cell) => observer.observe(cell))

    return () => {
      observer.disconnect()
      adaptiveCollapseRef.current = null
      if (adaptiveCheckRafRef.current !== null) {
        cancelAnimationFrame(adaptiveCheckRafRef.current)
        adaptiveCheckRafRef.current = null
      }
    }
  }, [editingId, hidden, terminalInfos, visibleTerminals])

  // Clean up terminal resources (when Tab is destroyed)
  useEffect(() => {
    return () => {
      terminalIdsRef.current.forEach(id => {
        terminalSessionManager.dispose(id)
      })
    }
  }, [])

  // Handling window size changes
  useEffect(() => {
    const handleResize = () => {
      requestAnimationFrame(fitAll)
    }

    window.addEventListener('resize', handleResize)
    return () => window.removeEventListener('resize', handleResize)
  }, [fitAll])

  // Refit when layout changes — depend on a fingerprint that captures
  // *every* visible geometry change, not just the cell count. Two
  // distinct custom presets with the same number of cells have different
  // grid-column / grid-row spans, so the cells themselves change size
  // without effectiveCount moving; xterm has to re-fit or it'll keep
  // reporting old rows / cols to the PTY until a window resize fires.
  const layoutFingerprint = useMemo(() => {
    if (resolvedDisplayLayout.kind === 'preset') {
      return `preset:${resolvedDisplayLayout.count}`
    }
    return `custom:${resolvedDisplayLayout.cells
      .map(c => `${c.rowStart}-${c.rowSpan}-${c.colStart}-${c.colSpan}`)
      .join('|')}`
  }, [resolvedDisplayLayout])

  useEffect(() => {
    requestAnimationFrame(fitAll)
  }, [layoutFingerprint, fitAll])

  // Theme changes and terminal style changes
  useEffect(() => {
    terminals.forEach(term => {
      terminalSessionManager.updateOptions(term.id, getTerminalOptions(term.id))
    })
  }, [terminals, getTerminalOptions])

  // Layout switching: When adding, wait for the initialization to be completed before switching the display.
  useEffect(() => {
    if (isSameLayoutMode(layoutMode, displayLayoutMode)) return

    const transitionStartedAt = performance.now()
    const emitApply = () => {
      perfTrace(PERF_TRACE_EVENT.RENDERER_CUSTOM_LAYOUT_APPLY, {
        kind: resolvedLayout.kind,
        effectiveCount,
        previousCount: displayEffectiveCount,
        durationMs: +(performance.now() - transitionStartedAt).toFixed(1)
      })
    }

    if (effectiveCount < displayEffectiveCount) {
      setDisplayLayoutMode(layoutMode)
      setIsTransitioning(false)
      emitApply()
      return
    }

    if (terminals.length < effectiveCount) {
      setIsTransitioning(true)
      return
    }

    const epoch = ++transitionRef.current
    setIsTransitioning(true)

    const targetTerminals = terminals.slice(0, effectiveCount)

    targetTerminals.forEach(term => {
      const sessionStatus = terminalSessionManager.getSession(term.id)?.status
      if (sessionStatus !== 'ready') {
        setTerminalStatus(term.id, 'initializing')
      }
    })

    Promise.all(
      targetTerminals.map(term => terminalSessionManager.ensureReady(term.id, getTerminalOptions(term.id)))
    )
      .then(() => {
        if (transitionRef.current !== epoch) return
        targetTerminals.forEach(term => setTerminalStatus(term.id, 'ready'))
        setDisplayLayoutMode(layoutMode)
        setIsTransitioning(false)
        emitApply()
      })
      .catch((error) => {
        console.error('Failed to initialize terminals:', error)
        targetTerminals.forEach(term => setTerminalStatus(term.id, 'error'))
        if (transitionRef.current !== epoch) return
        setIsTransitioning(false)
      })
  }, [layoutMode, displayLayoutMode, effectiveCount, displayEffectiveCount, resolvedLayout.kind, terminals, getTerminalOptions])

  useEffect(() => {
    scheduleFocusRequest(focusRequest)
    return () => {
      cancelPendingFocus()
    }
  }, [focusRequest, hidden, visibleTerminals, editingId, scheduleFocusRequest, cancelPendingFocus])

  // Save the container ref and mount the terminal
  const setContainerRef = useCallback((id: string, el: HTMLDivElement | null) => {
    if (el) {
      containerRefs.current.set(id, el)
      const options = getTerminalOptionsRef.current(id)

      terminalSessionManager.attach(id, el, options)
      const existingStatus = terminalSessionManager.getSession(id)?.status
      if (existingStatus !== 'ready') {
        setTerminalStatus(id, 'initializing')
      }
      terminalSessionManager.ensureReady(id, options)
        .then(() => {
          setTerminalStatus(id, 'ready')
        })
        .catch((error) => {
          console.error('Failed to create terminal:', error)
          setTerminalStatus(id, 'error')
        })

      // Attach right-click context menu listener
      const onContextMenu = (e: MouseEvent) => {
        e.preventDefault()
        e.stopPropagation()
        const session = terminalSessionManager.getSession(id)
        const hasSelection = session ? session.terminal.hasSelection() : false
        perfTraceTask(PERF_TRACE_EVENT.RENDERER_TERMINAL_CTX_MENU_OPEN, {
          hasSelection,
          pinnedCount: orderedPinnedPromptCountRef.current
        }, id)
        setTermCtxPinnedOpen(false)
        setTermCtxMenu({ x: e.clientX, y: e.clientY, terminalId: id, hasSelection })
      }
      el.addEventListener('contextmenu', onContextMenu)
      contextMenuListeners.current.set(id, onContextMenu)

      const pendingRequest = latestFocusRequestRef.current
      if (pendingRequest?.terminalId === id) {
        scheduleFocusRequest(pendingRequest)
      }
    } else {
      // Remove context menu listener on detach
      const prevEl = containerRefs.current.get(id)
      const listener = contextMenuListeners.current.get(id)
      if (prevEl && listener) {
        prevEl.removeEventListener('contextmenu', listener)
        contextMenuListeners.current.delete(id)
      }
      containerRefs.current.delete(id)
      terminalSessionManager.detach(id)
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const getContainerRef = useCallback((id: string) => {
    const cached = containerRefCallbacks.current.get(id)
    if (cached) return cached
    const handler = (el: HTMLDivElement | null) => {
      setContainerRef(id, el)
    }
    containerRefCallbacks.current.set(id, handler)
    return handler
  }, [setContainerRef])

  const retryTerminal = useCallback((terminalId: string) => {
    const options = getTerminalOptionsRef.current(terminalId)
    setTerminalStatus(terminalId, 'initializing')
    terminalSessionManager.ensureReady(terminalId, options)
      .then(() => setTerminalStatus(terminalId, 'ready'))
      .catch(() => setTerminalStatus(terminalId, 'error'))
  }, [setTerminalStatus])

  const handleOpenBrowser = useCallback((terminalId: string, initialUrl?: string | null) => {
    browserEverOpenedRef.current.add(terminalId)
    if (typeof initialUrl === 'string' && initialUrl.trim()) {
      setLastBrowserUrls(prev => ({ ...prev, [terminalId]: initialUrl.trim() }))
    }
    setBrowserOpenTerminals(prev => {
      if (prev.has(terminalId)) return prev
      const next = new Set(prev)
      next.add(terminalId)
      return next
    })
  }, [])

  const handleCloseBrowser = useCallback((terminalId: string) => {
    setBrowserOpenTerminals(prev => {
      if (!prev.has(terminalId)) return prev
      const next = new Set(prev)
      next.delete(terminalId)
      return next
    })
    terminalSessionManager.focus(terminalId)
  }, [])

  const handleToggleBrowser = useCallback((terminalId: string) => {
    setBrowserOpenTerminals(prev => {
      const next = new Set(prev)
      if (next.has(terminalId)) {
        next.delete(terminalId)
      } else {
        browserEverOpenedRef.current.add(terminalId)
        next.add(terminalId)
      }
      return next
    })
  }, [])

  const handleBrowserAutoRefreshChange = useCallback((terminalId: string, intervalMs: number | null) => {
    setBrowserAutoRefresh(prev => ({ ...prev, [terminalId]: intervalMs }))
  }, [])

  useEffect(() => {
    if (!window.electronAPI?.debug?.autotest) return

    const debugWindow = window as Window & { __onwardTerminalDebug?: TerminalDebugApi }
    const resolveTerminalId = (terminalId?: string) =>
      terminalId ?? activeTerminalIdRef.current ?? terminalIdsRef.current[0] ?? null

    const api: TerminalDebugApi = {
      getTerminalIds: () => [...terminalIdsRef.current],
      getVisibleTerminalIds: () => visibleTerminals.map((terminal) => terminal.id),
      getActiveTerminalId: () => activeTerminalIdRef.current,
      getSessionState: (terminalId) => {
        const resolved = resolveTerminalId(terminalId)
        return resolved ? terminalSessionManager.getSessionDebugState(resolved) : null
      },
      getRendererRecoveryCount: () => terminalSessionManager.getRendererRecoveryCount(),
      getViewportState: (terminalId) => {
        const resolved = resolveTerminalId(terminalId)
        if (!resolved) return null
        return terminalSessionManager.getViewportDebugState(resolved)
      },
      getTailText: (terminalId, lastLines = 20) => {
        const resolved = resolveTerminalId(terminalId)
        if (!resolved) return null
        const result = terminalSessionManager.getBufferContent(resolved, {
          mode: 'tail-lines',
          lastLines,
          trimTrailingEmpty: false
        })
        return result.success ? (result.content ?? '') : null
      },
      scrollToTop: (terminalId) => {
        const resolved = resolveTerminalId(terminalId)
        return resolved ? terminalSessionManager.scrollToTop(resolved) : false
      },
      scrollToBottom: (terminalId) => {
        const resolved = resolveTerminalId(terminalId)
        return resolved ? terminalSessionManager.scrollToBottom(resolved) : false
      },
      scrollLinesAsUser: (terminalId, lines = -10) => {
        const resolved = resolveTerminalId(terminalId)
        return resolved ? terminalSessionManager.scrollLinesAsUser(resolved, lines) : false
      },
      forceFit: (terminalId) => {
        const resolved = resolveTerminalId(terminalId)
        return resolved ? terminalSessionManager.forceFit(resolved) : false
      },
      remountTerminal: (terminalId) => {
        const resolved = resolveTerminalId(terminalId)
        return resolved ? terminalSessionManager.remount(resolved) : false
      },
      simulateRendererSurfaceLoss: (terminalId) => {
        const resolved = resolveTerminalId(terminalId)
        return resolved ? terminalSessionManager.simulateRendererSurfaceLossForAutotest(resolved) : false
      },
      recoverVisibleRenderers: () => terminalSessionManager.restoreVisibleRendererSurfaces('manual-debug'),
      notifyHostSurfaceEvent: (reason) => {
        terminalSessionManager.notifyHostSurfaceEvent(reason)
      },
      getTerminalTitle: (terminalId) => {
        const resolved = resolveTerminalId(terminalId)
        if (!resolved) return null
        const match = visibleTerminalsRef.current.find((term) => term.id === resolved)
        return match ? match.title : null
      },
      getTerminalCustomName: (terminalId) => {
        const resolved = resolveTerminalId(terminalId)
        if (!resolved) return null
        const match = visibleTerminalsRef.current.find((term) => term.id === resolved)
        return match ? match.customName : null
      },
      getTerminalGitInfo: (terminalId) => {
        const resolved = resolveTerminalId(terminalId)
        if (!resolved) return null
        const info = terminalInfosRef.current[resolved]
        if (!info) {
          return { branch: null, repoName: null, cwd: null, repoRoot: null, status: null }
        }
        return {
          branch: info.branch ?? null,
          repoName: info.repoName ?? null,
          cwd: info.cwd ?? null,
          repoRoot: info.repoRoot ?? null,
          status: info.status ?? null
        }
      },
      openTitleMenu: (terminalId) => {
        const resolved = resolveTerminalId(terminalId)
        if (!resolved) return false
        setTitleMenuTerminalId(resolved)
        return true
      },
      closeTitleMenu: () => {
        setTitleMenuTerminalId(null)
        return true
      },
      clickTitleMenuItem: (item, terminalId) => {
        const resolved = resolveTerminalId(terminalId)
        if (!resolved) return false
        const info = terminalInfosRef.current[resolved]
        const termEntry = visibleTerminalsRef.current.find((term) => term.id === resolved)
        if (!termEntry) return false
        if (item === 'rename') {
          setTitleMenuTerminalId(null)
          // Eagerly stamp the refs that getInlineRenameState() / finishInlineRename()
          // read, BEFORE React commits the setEditingId state. The effect at
          // [editingId] only syncs editingIdRef after the commit + effect cycle,
          // which under EDR-instrumented Windows boot can be starved for seconds
          // by competing git-resolve / watcher-attach work. Without this, an
          // autotest gating on getInlineRenameState().editingId would time out
          // even though the rename intent already fired. (Autotest-only hook.)
          editingIdRef.current = resolved
          editingTitleRef.current = termEntry.customName ?? ''
          setEditingId(resolved)
          setEditingTitle(termEntry.customName ?? '')
          return true
        }
        if (item === 'auto-follow-toggle') {
          // Mirrors the production click handler: toggle the preference and
          // keep the menu open so subsequent assertions can read the new
          // checkbox state.
          setAutoFollowGitBranchForTaskName(!autoFollowEnabledRef.current)
          return true
        }
        if (item === 'use-branch') {
          const branchValue = typeof info?.branch === 'string' ? info.branch.trim() : ''
          if (!branchValue) return false
          setTitleMenuTerminalId(null)
          onTerminalRename(resolved, branchValue)
          return true
        }
        if (item === 'use-repo') {
          const repoValue = typeof info?.repoName === 'string' ? info.repoName.trim() : ''
          if (!repoValue) return false
          setTitleMenuTerminalId(null)
          onTerminalRename(resolved, repoValue)
          return true
        }
        return false
      },
      getTitleMenuState: (terminalId) => {
        const resolved = resolveTerminalId(terminalId)
        if (!resolved) return null
        const info = terminalInfosRef.current[resolved]
        const branch = info?.branch ?? null
        const repoName = info?.repoName ?? null
        return {
          open: titleMenuTerminalIdRef.current === resolved,
          branch,
          repoName,
          canUseBranch: typeof branch === 'string' && branch.trim().length > 0,
          canUseRepo: typeof repoName === 'string' && repoName.trim().length > 0
        }
      },
      simulateTitleSingleClick: (terminalId) => {
        const resolved = resolveTerminalId(terminalId)
        if (!resolved) return false
        // Single click now opens the menu immediately — no debounce timer.
        setTitleMenuTerminalId(resolved)
        return true
      },
      injectPtyData: (data, terminalId) => {
        const resolved = resolveTerminalId(terminalId)
        if (!resolved) return false
        return terminalSessionManager.injectPtyDataForAutotest(resolved, data)
      },
      simulateTitleDoubleClick: (terminalId) => {
        // Double-click rename has been removed from the production UX, but
        // existing tests use this hook as a shortcut into inline edit mode.
        // Keep it as a no-decoration alias that takes the same path the
        // dropdown's "Rename" item now takes.
        const resolved = resolveTerminalId(terminalId)
        if (!resolved) return false
        const termEntry = visibleTerminalsRef.current.find((term) => term.id === resolved)
        setTitleMenuTerminalId(null)
        // Same eager-ref stamp as clickTitleMenuItem('rename') above: make the
        // inline-edit state observable synchronously so an autotest gate does not
        // depend on the (possibly EDR-starved) React commit + effect cycle.
        editingIdRef.current = resolved
        editingTitleRef.current = termEntry?.customName ?? ''
        setEditingId(resolved)
        setEditingTitle(termEntry?.customName ?? '')
        return true
      },
      finishInlineRename: (value) => {
        const id = editingIdRef.current
        if (!id) return false
        const finalValue = ((value ?? editingTitleRef.current) || '').trim()
        onTerminalRename(id, finalValue)
        // Clear the refs eagerly (symmetric with the eager set in
        // clickTitleMenuItem('rename')) so getInlineRenameState() reports
        // "not editing" synchronously, without waiting for the React effect.
        editingIdRef.current = null
        editingTitleRef.current = ''
        setEditingId(null)
        setEditingTitle('')
        return true
      },
      cancelInlineRename: () => {
        if (!editingIdRef.current) return false
        editingIdRef.current = null
        editingTitleRef.current = ''
        setEditingId(null)
        setEditingTitle('')
        return true
      },
      getInlineRenameState: () => ({
        editingId: editingIdRef.current,
        editingTitle: editingTitleRef.current
      }),
      closeAllSubpages: () => {
        closeGitDiffPanelRef.current?.(false)
        closeGitHistoryPanelRef.current?.(false)
        onCloseProjectEditorRef.current?.()
        return true
      },
      setTerminalGitInfoOverride: (terminalId, override) => {
        if (!terminalId) return false
        if (override === null) {
          terminalInfoOverridesRef.current.delete(terminalId)
          setTerminalInfos((prev) => {
            const current = prev[terminalId]
            if (!current) return prev
            const next = { ...prev }
            delete next[terminalId]
            return next
          })
          notifyTerminalGitInfo(terminalId, { repoRoot: null, branch: null })
          return true
        }
        const existing = terminalInfoOverridesRef.current.get(terminalId) ?? {}
        const merged: Partial<TerminalGitInfo> = { ...existing }
        if (override.cwd !== undefined) merged.cwd = override.cwd
        if (override.repoRoot !== undefined) merged.repoRoot = override.repoRoot
        if (override.branch !== undefined) merged.branch = override.branch
        if (override.repoName !== undefined) merged.repoName = override.repoName
        if (override.status !== undefined) merged.status = override.status
        terminalInfoOverridesRef.current.set(terminalId, merged)
        // Drive the same code path a real IPC update would: applyTerminal-
        // InfoUpdate handles setTerminalInfos, the AppState ref via
        // notifyTerminalGitInfo, and — most importantly for TTM-21+ — the
        // auto-follow rename rule.
        const previousEffective = terminalInfosRef.current[terminalId]
        const nextEffective: TerminalGitInfo = {
          cwd: merged.cwd !== undefined ? merged.cwd : previousEffective?.cwd ?? null,
          repoRoot: merged.repoRoot !== undefined ? merged.repoRoot : previousEffective?.repoRoot ?? null,
          branch: merged.branch !== undefined ? merged.branch : previousEffective?.branch ?? null,
          repoName: merged.repoName !== undefined ? merged.repoName : previousEffective?.repoName ?? null,
          status: merged.status !== undefined ? merged.status : previousEffective?.status ?? null
        }
        applyTerminalInfoUpdate(terminalId, nextEffective)
        return true
      },
      getAutoFollowGitBranchForTaskName: () => autoFollowEnabledRef.current,
      setAutoFollowGitBranchForTaskName: (enabled: boolean) => {
        setAutoFollowGitBranchForTaskName(Boolean(enabled))
      },
      getTerminalManualNameRepoRoot: (terminalId) => {
        const resolved = resolveTerminalId(terminalId)
        if (!resolved) return null
        const term = visibleTerminalsRef.current.find((t) => t.id === resolved)
        return term?.manualNameRepoRoot ?? null
      },
      resetAutoFollowInitialPass: (terminalId) => {
        // Autotest hook: forget that this Task has already had its first
        // post-mount git-info evaluation, so the NEXT setTerminalGitInfoOverride
        // re-enters the hydration barrier path exactly as a fresh boot would.
        const resolved = resolveTerminalId(terminalId)
        if (!resolved) return false
        initialAutoFollowDoneRef.current.delete(resolved)
        return true
      }
    }

    debugWindow.__onwardTerminalDebug = api
    return () => {
      if (debugWindow.__onwardTerminalDebug === api) {
        delete debugWindow.__onwardTerminalDebug
      }
    }
  }, [activeTerminalId, displayEffectiveCount, terminals, visibleTerminals, onTerminalRename, notifyTerminalGitInfo, setAutoFollowGitBranchForTaskName])

  const closeGitDiffPanelRef = useRef<((restoreFocus: boolean) => void) | null>(null)
  const closeGitHistoryPanelRef = useRef<((restoreFocus: boolean) => void) | null>(null)
  const onCloseProjectEditorRef = useRef<(() => void) | null>(null)

  // Start editing the title (editing the custom name part)
  const handleStartEdit = useCallback((id: string, currentCustomName: string | null) => {
    setEditingId(id)
    setEditingTitle(currentCustomName || '')
  }, [])

  // Finish editing (null value clears custom name)
  const handleFinishEdit = useCallback(() => {
    if (editingId) {
      const trimmed = editingTitle.trim()
      const previousCustomName = visibleTerminalsRef.current.find((t) => t.id === editingId)?.customName ?? null
      debugLog('titleMenu:rename', {
        stage: 'commit',
        terminalId: editingId,
        newValue: trimmed,
        previousCustomName
      })
      onTerminalRename(editingId, trimmed)
    }
    setEditingId(null)
    setEditingTitle('')
  }, [editingId, editingTitle, onTerminalRename])

  // Cancel edit
  const handleCancelEdit = useCallback(() => {
    if (editingIdRef.current) {
      debugLog('titleMenu:rename', { stage: 'cancel', terminalId: editingIdRef.current })
    }
    setEditingId(null)
    setEditingTitle('')
  }, [])

  // Handle keyboard events
  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      handleFinishEdit()
    } else if (e.key === 'Escape') {
      handleCancelEdit()
    }
  }, [handleFinishEdit, handleCancelEdit])

  // Focus input box
  useEffect(() => {
    if (editingId && editInputRef.current) {
      editInputRef.current.focus()
      editInputRef.current.select()
    }
  }, [editingId])

  const closeGitDiffPanel = useCallback((restoreFocus: boolean) => {
    debugLog('gitdiff:close', { restoreFocus })
    gitDiffOpenTokenRef.current += 1
    const openedFrom = gitDiffTerminalId
    setGitDiffOpen(false)
    setGitDiffTerminalId(null)
    setGitDiffCwd(null)
    setGitDiffCwdPending(false)
    setGitDiffOpenRequestedAt(null)
    setGitDiffCwdReadyAt(null)
    setGitDiffNavigationTarget(null)
    if (!restoreFocus) return
    requestAnimationFrame(() => {
      const tid = openedFrom ?? activeTerminalIdRef.current
      if (tid) terminalSessionManager.focusIfNeeded(tid)
    })
  }, [gitDiffTerminalId])

  const closeGitHistoryPanel = useCallback((restoreFocus: boolean) => {
    gitHistoryOpenTokenRef.current += 1
    const openedFrom = gitHistoryTerminalId
    setGitHistoryOpen(false)
    setGitHistoryTerminalId(null)
    setGitHistoryCwd(null)
    if (!restoreFocus) return
    requestAnimationFrame(() => {
      const tid = openedFrom ?? activeTerminalIdRef.current
      if (tid) terminalSessionManager.focusIfNeeded(tid)
    })
  }, [gitHistoryTerminalId])

  useEffect(() => {
    closeGitDiffPanelRef.current = closeGitDiffPanel
    closeGitHistoryPanelRef.current = closeGitHistoryPanel
    onCloseProjectEditorRef.current = onCloseProjectEditor ?? null
  }, [closeGitDiffPanel, closeGitHistoryPanel, onCloseProjectEditor])

  // View Git Diff — open the shell immediately, then resolve the best cwd for diff loading
  const handleViewGitDiff = useCallback(async (
    terminalId: string,
    options?: { closeOtherSubpages?: boolean }
  ) => {
    const currentToken = ++gitDiffOpenTokenRef.current
    const requestedAt = performance.now()
    const terminalInfo = terminalInfos[terminalId]
    const persistedCwd = getPersistedTerminalCwd(terminalId)
    // An explicit cwd override (set when `git-diff:open` carried a `cwd` in its
    // detail) takes precedence over every resolved source. It lets callers open
    // Git Diff against a specific repo deterministically — used by autotests to
    // target a nested fixture repo whose terminal cwd report is racy/absent.
    const cwdOverride = gitDiffCwdOverrideRef.current[terminalId] ?? null
    const initialCwd = resolveGitDiffInitialCwd({
      cwdOverride,
      repoRoot: terminalInfo?.repoRoot ?? null,
      terminalCwd: terminalInfo?.cwd ?? null,
      persistedCwd
    })
    const closeOtherSubpages = options?.closeOtherSubpages ?? true
    if (cwdOverride) {
      perfTrace(PERF_TRACE_EVENT.RENDERER_GIT_DIFF_CWD_OVERRIDE, {
        terminalId,
        cwd: cwdOverride.slice(0, 256)
      })
    }
    debugLog('gitdiff:view:start', {
      terminalId,
      initialCwd,
      cwdOverride,
      repoRoot: terminalInfo?.repoRoot || null,
      terminalCwd: terminalInfo?.cwd || null,
      persistedCwd
    })
    setGitDiffTerminalId(terminalId)
    setGitDiffOpenRequestedAt(requestedAt)
    setGitDiffCwdReadyAt(initialCwd ? requestedAt : null)
    setGitDiffCwd(initialCwd)
    setGitDiffCwdPending(!initialCwd)
    setActiveSubpage('diff')
    setGitDiffOpen(true)
    perfTrace(PERF_TRACE_EVENT.RENDERER_SUBPAGE_FRESHNESS_CHECK, {
      subpage: 'diff',
      cwd: initialCwd ?? null,
      reason: closeOtherSubpages ? 'open' : 'switch'
    })
    if (closeOtherSubpages) {
      setGitHistoryOpen(false)
    }
    if (initialCwd) return

    try {
      const terminalCwd = await window.electronAPI.git.getTerminalCwd(terminalId)
      if (gitDiffOpenTokenRef.current !== currentToken) return
      const readyAt = performance.now()
      debugLog('gitdiff:view:cwd-ready', { terminalId, terminalCwd, readyAt })
      setGitDiffCwd(terminalCwd || persistedCwd)
      setGitDiffCwdReadyAt(readyAt)
    } catch (error) {
      if (gitDiffOpenTokenRef.current !== currentToken) return
      debugLog('gitdiff:view:cwd-error', { terminalId, error: String(error) })
      setGitDiffCwd(persistedCwd)
      setGitDiffCwdReadyAt(performance.now())
    } finally {
      if (gitDiffOpenTokenRef.current === currentToken) {
        setGitDiffCwdPending(false)
      }
    }
  }, [getPersistedTerminalCwd, terminalInfos])

  const handleViewGitHistory = useCallback(async (
    terminalId: string,
    options?: { closeOtherSubpages?: boolean }
  ) => {
    const currentToken = ++gitHistoryOpenTokenRef.current
    const persistedCwd = getPersistedTerminalCwd(terminalId)
    const terminalInfo = terminalInfos[terminalId]
    const initialCwd = terminalInfo?.repoRoot || terminalInfo?.cwd || persistedCwd
    const closeOtherSubpages = options?.closeOtherSubpages ?? true
    setGitHistoryTerminalId(terminalId)
    setGitHistoryCwd(initialCwd)
    setActiveSubpage('history')
    setGitHistoryOpen(true)
    perfTrace(PERF_TRACE_EVENT.RENDERER_SUBPAGE_FRESHNESS_CHECK, {
      subpage: 'history',
      cwd: initialCwd ?? null,
      reason: closeOtherSubpages ? 'open' : 'switch'
    })
    if (closeOtherSubpages) {
      setGitDiffOpen(false)
    }
    if (terminalInfo?.repoRoot) {
      return
    }

    try {
      let terminalCwd = terminalInfo?.cwd || initialCwd
      if (!terminalCwd) {
        terminalCwd = await window.electronAPI.git.getTerminalCwd(terminalId)
      }
      if (gitHistoryOpenTokenRef.current !== currentToken) return
      const resolvedRepoRoot = terminalCwd
        ? await window.electronAPI.git.resolveRepoRoot(terminalCwd)
        : terminalCwd
      if (gitHistoryOpenTokenRef.current !== currentToken) return
      setGitHistoryCwd(resolvedRepoRoot || terminalCwd || persistedCwd)
    } catch {
      if (gitHistoryOpenTokenRef.current !== currentToken) return
      setGitHistoryCwd(initialCwd || persistedCwd)
    }
  }, [getPersistedTerminalCwd, terminalInfos])

  const resolveSubpageMemoryScope = useCallback((
    terminalId: string,
    subpage: SubpageId | null
  ): SubpageMemoryScope => {
    const terminalInfo = terminalInfos[terminalId]
    const fallbackCwd = terminalInfo?.repoRoot || terminalInfo?.cwd || getPersistedTerminalCwd(terminalId)
    let root: string | null = fallbackCwd ?? null
    if (subpage === 'editor' && projectEditorTerminalId === terminalId) {
      root = projectEditorCwd || fallbackCwd || null
    } else if (subpage === 'diff' && gitDiffTerminalId === terminalId) {
      root = gitDiffCwd || fallbackCwd || null
    } else if (subpage === 'history' && gitHistoryTerminalId === terminalId) {
      root = gitHistoryCwd || fallbackCwd || null
    }
    return {
      terminalId,
      root,
      tabId: _tabId ?? null
    }
  }, [
    getPersistedTerminalCwd,
    gitDiffCwd,
    gitDiffTerminalId,
    gitHistoryCwd,
    gitHistoryTerminalId,
    projectEditorCwd,
    projectEditorTerminalId,
    _tabId,
    terminalInfos
  ])

  const captureSubpageBeforeLeave = useCallback(async (command: SubpageRouteCommand) => {
    const from = command.from
    if (!from) return
    const lifecycle = panelShellStatesRef.current[from]?.lifecycle
    const snapshot = await lifecycle?.beforeLeave?.({ command })
    if (!snapshot) return
    const scope = resolveSubpageMemoryScope(command.terminalId, from)
    subpageStateMemoryRef.current.save(scope, snapshot)
    debugLog('subpage:memory:capture', {
      route: subpageRouteCommandToDebugLabel(command),
      subpage: snapshot.subpage,
      scope
    })
  }, [resolveSubpageMemoryScope])

  const notifySubpageAfterEnter = useCallback(async (command: SubpageRouteCommand) => {
    const target = command.target
    if (!target) return
    const lifecycle = panelShellStatesRef.current[target]?.lifecycle
    const scope = resolveSubpageMemoryScope(command.terminalId, target)
    // Restore the saved snapshot ONLY on a genuine cross-subpage switch (came
    // FROM a different subpage). A fresh open or a same-subpage reopen must open
    // blank (GDS-31), so clear any stale snapshot for this scope first. A switch
    // preserves the snapshot saved on the way out, so switching back restores
    // the prior selection (SN-07 / CDP-06).
    const isGenuineSwitch = shouldRestoreSubpageOnEnter(command.from, target)
    if (!isGenuineSwitch) {
      subpageStateMemoryRef.current.clear(scope, target)
    }
    const stored = subpageStateMemoryRef.current.read(scope, target)
    await lifecycle?.afterEnter?.({ command, restoredSnapshot: stored?.snapshot ?? null })
  }, [resolveSubpageMemoryScope])

  const closeNonTargetSubpagesForRoute = useCallback((target: SubpageId | null) => {
    if (target !== 'diff') {
      closeGitDiffPanel(false)
    }
    if (target !== 'history') {
      closeGitHistoryPanel(false)
    }
    if (target !== 'editor') {
      onCloseProjectEditor?.()
    }
  }, [closeGitDiffPanel, closeGitHistoryPanel, onCloseProjectEditor])

  const waitForSubpageRouteTargetOpen = useCallback((
    target: SubpageId | null,
    navigateToken: number
  ): Promise<void> => {
    if (!target) return Promise.resolve()
    return new Promise((resolve) => {
      let remainingFrames = 120
      const tick = () => {
        if (subpageNavigateTokenRef.current !== navigateToken) {
          resolve()
          return
        }
        if (subpageOpenStateRef.current[target]) {
          resolve()
          return
        }
        if (remainingFrames <= 0) {
          resolve()
          return
        }
        remainingFrames -= 1
        requestAnimationFrame(tick)
      }
      requestAnimationFrame(tick)
    })
  }, [])

  const executeSubpageRoute = useCallback(async (command: SubpageRouteCommand) => {
    const navigateToken = ++subpageNavigateTokenRef.current
    if (command.intent !== 'open' || command.from) {
      await captureSubpageBeforeLeave(command)
    }

    const target = command.target
    pendingSubpageRouteTargetRef.current = target
    setActiveSubpage(target)
    debugLog('subpage:route', subpageRouteCommandToDebugLabel(command))

    if (!target) {
      pendingSubpageRouteTargetRef.current = null
      if (command.from === 'diff') {
        closeGitDiffPanel(true)
      } else if (command.from === 'history') {
        closeGitHistoryPanel(true)
      } else if (command.from === 'editor') {
        onCloseProjectEditor?.()
      } else {
        closeNonTargetSubpagesForRoute(null)
      }
      return
    }

    if (target === 'diff') {
      setGitDiffNavigationTarget(shouldApplySubpageTargetFile(command) && command.targetFile
        ? {
            filePath: command.targetFile.filePath,
            repoRoot: command.targetFile.repoRoot,
            nonce: ++gitDiffNavigationTargetNonceRef.current
          }
        : null)
      void handleViewGitDiff(command.terminalId, { closeOtherSubpages: false })
    } else if (target === 'history') {
      void handleViewGitHistory(command.terminalId, { closeOtherSubpages: false })
    } else if (target === 'editor') {
      void onOpenProjectEditor(command.terminalId, {
        filePath: shouldApplySubpageTargetFile(command) ? command.targetFile?.filePath ?? null : null,
        repoRoot: shouldApplySubpageTargetFile(command) ? command.targetFile?.repoRoot ?? null : null,
        source: command.source,
        returnTarget: command.returnTarget,
        diffFilePath: shouldApplySubpageTargetFile(command) ? command.targetFile?.diffFilePath ?? null : null,
        diffRepoRoot: shouldApplySubpageTargetFile(command) ? command.targetFile?.diffRepoRoot ?? null : null
      })
    }

    await waitForSubpageRouteTargetOpen(target, navigateToken)
    if (subpageNavigateTokenRef.current !== navigateToken) return
    closeNonTargetSubpagesForRoute(target)
    requestAnimationFrame(() => {
      if (subpageNavigateTokenRef.current !== navigateToken) return
      pendingSubpageRouteTargetRef.current = null
      void notifySubpageAfterEnter(command)
    })
  }, [
    captureSubpageBeforeLeave,
    closeGitDiffPanel,
    closeGitHistoryPanel,
    closeNonTargetSubpagesForRoute,
    handleViewGitDiff,
    handleViewGitHistory,
    notifySubpageAfterEnter,
    onOpenProjectEditor,
    waitForSubpageRouteTargetOpen
  ])

  useEffect(() => {
    executeSubpageRouteRef.current = executeSubpageRoute
    return () => {
      if (executeSubpageRouteRef.current === executeSubpageRoute) {
        executeSubpageRouteRef.current = null
      }
    }
  }, [executeSubpageRoute])

  const handleCloseGitDiff = useCallback(() => {
    if (gitDiffTerminalId) {
      void executeSubpageRoute(buildSubpageRouteCommand({
        intent: 'close',
        entryPoint: 'escape',
        terminalId: gitDiffTerminalId,
        from: 'diff',
        target: null
      }))
      return
    }
    closeGitDiffPanel(true)
  }, [closeGitDiffPanel, executeSubpageRoute, gitDiffTerminalId])

  useEffect(() => {
    const handleOpenGitDiff = (event: Event) => {
      if (hidden) return
      const customEvent = event as CustomEvent<{ terminalId?: string; cwd?: string }>
      const terminalId = customEvent.detail?.terminalId
      if (!terminalId) return
      // Optional explicit cwd: when supplied, pin it so `handleViewGitDiff`
      // opens against this repo verbatim regardless of the terminal's reported
      // cwd. Clear any stale override when none is supplied so a later normal
      // open does not inherit a previous explicit target.
      const explicitCwd = customEvent.detail?.cwd
      if (explicitCwd) {
        gitDiffCwdOverrideRef.current[terminalId] = explicitCwd
      } else {
        delete gitDiffCwdOverrideRef.current[terminalId]
      }
      debugLog('gitdiff:event:open', { terminalId, explicitCwd: explicitCwd ?? null })
      if (!terminals.some(term => term.id === terminalId)) return
      void executeSubpageRoute(buildSubpageRouteCommand({
        intent: activeSubpage && activeSubpage !== 'diff' ? 'switch' : 'open',
        entryPoint: 'legacy-event',
        terminalId,
        from: activeSubpage,
        target: 'diff'
      }))
    }

    window.addEventListener('git-diff:open', handleOpenGitDiff as EventListener)
    return () => {
      window.removeEventListener('git-diff:open', handleOpenGitDiff as EventListener)
    }
  }, [activeSubpage, executeSubpageRoute, hidden, terminals, visibleTerminals])

  useEffect(() => {
    const handleOpenGitHistory = (event: Event) => {
      if (hidden) return
      const customEvent = event as CustomEvent<{ terminalId?: string }>
      const terminalId = customEvent.detail?.terminalId
      if (!terminalId) return
      if (!terminals.some(term => term.id === terminalId)) return
      void executeSubpageRoute(buildSubpageRouteCommand({
        intent: activeSubpage && activeSubpage !== 'history' ? 'switch' : 'open',
        entryPoint: 'legacy-event',
        terminalId,
        from: activeSubpage,
        target: 'history'
      }))
    }

    window.addEventListener('git-history:open', handleOpenGitHistory as EventListener)
    return () => {
      window.removeEventListener('git-history:open', handleOpenGitHistory as EventListener)
    }
  }, [activeSubpage, executeSubpageRoute, hidden, terminals])

  useEffect(() => {
    const handleSubpageNavigate = (event: Event) => {
      if (hidden) return
      const customEvent = event as CustomEvent<SubpageNavigateEventDetail>
      const command = legacyNavigateDetailToRouteCommand(customEvent.detail, activeSubpage)
      if (!command) return
      if (!terminals.some(term => term.id === command.terminalId)) return
      void executeSubpageRoute(command)
    }

    window.addEventListener('subpage:navigate', handleSubpageNavigate as EventListener)
    return () => {
      window.removeEventListener('subpage:navigate', handleSubpageNavigate as EventListener)
    }
  }, [
    activeSubpage,
    executeSubpageRoute,
    hidden,
    terminals
  ])

  useEffect(() => {
    const handleOpenBrowserEvent = (event: Event) => {
      if (hidden) return
      const customEvent = event as CustomEvent<{ terminalId?: string; url?: string }>
      const terminalId = customEvent.detail?.terminalId
      if (!terminalId) return
      if (!terminals.some(term => term.id === terminalId)) return
      handleOpenBrowser(terminalId, customEvent.detail?.url ?? null)
    }

    window.addEventListener('browser:open', handleOpenBrowserEvent as EventListener)
    return () => {
      window.removeEventListener('browser:open', handleOpenBrowserEvent as EventListener)
    }
  }, [handleOpenBrowser, hidden, terminals])

  const handleCloseGitHistory = useCallback(() => {
    if (gitHistoryTerminalId) {
      void executeSubpageRoute(buildSubpageRouteCommand({
        intent: 'close',
        entryPoint: 'escape',
        terminalId: gitHistoryTerminalId,
        from: 'history',
        target: null
      }))
      return
    }
    closeGitHistoryPanel(true)
  }, [closeGitHistoryPanel, executeSubpageRoute, gitHistoryTerminalId])

  // Coding Agent handlers
  const handleOpenCodingAgent = useCallback((terminalId: string) => {
    setCodingAgentTerminalId(terminalId)
    setCodingAgentModalOpen(true)
  }, [])

  const handleCloseCodingAgent = useCallback(() => {
    setCodingAgentModalOpen(false)
    setCodingAgentTerminalId(null)
  }, [])

  const handleLaunchCodingAgent = useCallback(async (config: CodingAgentConfigInput) => {
    if (!codingAgentTerminalId) return
    const session = terminalSessionManager.getSession(codingAgentTerminalId)
    const cols = session?.terminal.cols || 80
    const rows = session?.terminal.rows || 24
    const result = await window.electronAPI.codingAgent.launch({
      terminalId: codingAgentTerminalId,
      config,
      cols,
      rows
    })
    if (!result.success) {
      console.error('Failed to launch coding agent:', result.error || 'unknown error')
      return
    }
    terminalSessionManager.focus(codingAgentTerminalId)
    setCodingAgentModalOpen(false)
    setCodingAgentTerminalId(null)
  }, [codingAgentTerminalId])

  // Change working directory
  const handleChangeWorkDir = useCallback(async (terminalId: string) => {
    const result = await window.electronAPI.dialog.openDirectory()
    if (result.success && result.path) {
      const shellKind = await resolveTerminalShellKind(terminalId)
      const cdCommand = buildChangeDirectoryCommand(window.electronAPI.platform, result.path, shellKind)
      await window.electronAPI.terminal.write(terminalId, cdCommand)
      onPersistTerminalCwd(terminalId, result.path)
      onTerminalFocus(terminalId)
      window.setTimeout(() => {
        void window.electronAPI.git.notifyTerminalActivity(terminalId)
      }, 300)
    }
  }, [onPersistTerminalCwd, onTerminalFocus])

  const handleOpenWorkDir = useCallback(async (terminalId: string) => {
    let cwd = terminalInfos[terminalId]?.cwd || getPersistedTerminalCwd(terminalId)
    if (!cwd) {
      try {
        cwd = await window.electronAPI.git.getTerminalCwd(terminalId)
      } catch {
        cwd = null
      }
    }
    if (!cwd) return

    const result = await window.electronAPI.shell.openPath(cwd)
    if (!result.success && result.error) {
      console.error('Failed to open work directory:', result.error)
    }
  }, [getPersistedTerminalCwd, terminalInfos])

  useEffect(() => {
    if (hidden || !shortcutAction) return
    if (lastShortcutTokenRef.current === shortcutAction.token) return
    const isTargetVisible = visibleTerminals.some(term => term.id === shortcutAction.terminalId)
    if (!isTargetVisible) return

    lastShortcutTokenRef.current = shortcutAction.token
    const isSubpageOpen = (target: SubpageId) => {
      if (target === 'diff') return gitDiffOpen
      if (target === 'history') return gitHistoryOpen
      return projectEditorOpenInGrid
    }

    const openOrSwitchSubpage = (target: SubpageId) => {
      if (isSubpageOpen(target)) return true
      void executeSubpageRoute(buildSubpageRouteCommand({
        intent: anySubpageOpen ? 'switch' : 'open',
        entryPoint: 'shortcut',
        terminalId: shortcutAction.terminalId,
        from: activeSubpage,
        target
      }))
      return true
    }

    switch (shortcutAction.action) {
      case 'gitDiff':
        openOrSwitchSubpage('diff')
        break
      case 'gitHistory':
        openOrSwitchSubpage('history')
        break
      case 'changeWorkDir':
        void handleChangeWorkDir(shortcutAction.terminalId)
        break
      case 'openWorkDir':
        void handleOpenWorkDir(shortcutAction.terminalId)
        break
      case 'projectEditor':
        openOrSwitchSubpage('editor')
        break
    }
  }, [
    activeSubpage,
    anySubpageOpen,
    executeSubpageRoute,
    gitDiffOpen,
    gitHistoryOpen,
    handleChangeWorkDir,
    handleOpenWorkDir,
    hidden,
    projectEditorOpenInGrid,
    shortcutAction,
    visibleTerminals
  ])

  const handleTerminalFocus = useCallback((terminalId: string, event?: React.MouseEvent) => {
    // Skip focus steal when click originates inside a browser panel
    if (event?.target instanceof Element && event.target.closest('.browser-panel-cell')) {
      return
    }
    void window.electronAPI.git.notifyTerminalFocus(terminalId)
    onTerminalFocus(terminalId)
    // Ensure terminal gets keyboard focus even when clicking header area
    // or activating the window — bypasses pointer suppression intentionally
    terminalSessionManager.focusIfNeeded(terminalId)
  }, [onTerminalFocus])

  // Single click on the title opens the dropdown menu immediately. Double-click
  // is no longer a rename gesture; the only entry to inline edit is the
  // "Rename" item inside this menu (or PromptSender's task-card double-click,
  // which lives in a different component).
  const handleTitleClick = useCallback((e: React.MouseEvent, id: string) => {
    e.stopPropagation()
    handleTerminalFocus(id)
    const info = terminalInfosRef.current[id]
    const branch = info?.branch ?? null
    const repoName = info?.repoName ?? null
    debugLog('titleMenu:open', {
      terminalId: id,
      source: 'click',
      branch,
      repoName,
      canUseBranch: typeof branch === 'string' && branch.trim().length > 0,
      canUseRepo: typeof repoName === 'string' && repoName.trim().length > 0
    })
    setTitleMenuTerminalId(id)
  }, [handleTerminalFocus])

  // Snapshot helper: write a value into customName through the existing rename callback.
  const handleTitleSnapshotRename = useCallback((id: string, value: string, source: 'branch' | 'repo') => {
    const trimmed = value.trim()
    const previousCustomName = visibleTerminalsRef.current.find((t) => t.id === id)?.customName ?? null
    debugLog('titleMenu:snapshot', {
      terminalId: id,
      source,
      value: trimmed,
      previousCustomName
    })
    onTerminalRename(id, trimmed)
  }, [onTerminalRename])

  return (
    <>
      <div ref={gridWrapperRef} className={`terminal-grid-wrapper ${hidden ? 'terminal-grid-hidden' : ''}`}>
        <div className="terminal-grid" data-layout={layoutDataAttr(displayLayoutMode)}>
          {visibleTerminals.map((termInfo, index) => {
            const terminalInfo = terminalInfos[termInfo.id]
            const terminalStatus = terminalStatuses[termInfo.id] ?? 'idle'
            const showTerminalOverlay = terminalStatus === 'initializing' || terminalStatus === 'error'
            // Effective cwd, in priority order:
            //   1. OSC-detected cwd (sub-frame, set the moment the user's
            //      `cd` is processed by the shell's precmd hook).
            //   2. Legacy poll-driven terminalInfo.cwd (0.4–1.5 s lag).
            const oscCwd = oscDetectedCwds[termInfo.id]
            const cwd = oscCwd || terminalInfo?.cwd || null
            // Render rule: prefer mirror snapshot. Fall back to legacy
            // `terminalInfo` ONLY when its cwd matches the effective cwd
            // (otherwise we'd be showing the previous repo's branch on a
            // brand-new cwd until the legacy poll catches up). Raw OSC cwd
            // can be a path-equivalent alias (`repo/.`, `/var` vs
            // `/private/var`, symlink, Windows separator variant), so mirror
            // lookup goes through the same canonical identity resolver used
            // by the render trace effect above.
            //
            // Autotest override always takes precedence: `mirror` is the
            // raw Worker output and bypasses the legacy `applyTerminal-
            // InfoUpdate → mergeOverride` path. Re-applying the override
            // here keeps the autotest pin-state contract intact (TTM-06,
            // TTM-07) regardless of which source supplies the branch.
            const gitState = resolveTerminalGitDisplayState({
              cwd,
              terminalInfo,
              mirrorSnapshots,
              mirrorAliases: mirrorSnapshotAliases
            })
            const rawBranch = gitState.branch
            const rawRepoName = gitState.repoName
            const rawStatus = gitState.status
            const renderOverride = terminalInfoOverridesRef.current.get(termInfo.id)
            const branch = renderOverride?.branch !== undefined ? renderOverride.branch : rawBranch
            const repoName = renderOverride?.repoName !== undefined ? renderOverride.repoName : rawRepoName
            const status = renderOverride?.status !== undefined ? renderOverride.status : rawStatus
            const compactCwd = cwd ? formatCompactPath(cwd) : ''
            // Sync (ahead/behind) is orthogonal to tree cleanliness: a clean
            // tree that is ahead gets the distinct green dot; dirty trees keep
            // their working-tree colour and just append the arrows. Counts come
            // from the mirror snapshot only (legacy RPC path has none).
            const sync = resolveGitSyncDisplay({ status, ahead: gitState.ahead, behind: gitState.behind })
            const branchStatusClass = sync.dotState !== 'clean'
              ? `terminal-grid-branch--${sync.dotState}`
              : ''
            const branchClassName = branchStatusClass
              ? `terminal-grid-branch ${branchStatusClass}`
              : 'terminal-grid-branch'
            const branchSyncTitle = sync.showAhead || sync.showBehind
              ? t('terminalGrid.branchSyncTitle', {
                  branch: branch ?? '',
                  ahead: sync.ahead,
                  behind: sync.behind
                })
              : t('terminalGrid.branchTitle', { branch: branch ?? '' })

            // Custom mode lays each Task on a stored rectangle inside the
            // 4col x 2row atomic mesh. Preset modes leave grid-area unset
            // and rely on the data-layout="N" CSS that uniformly distributes
            // 1fr cells in DOM order.
            const customCell = resolvedDisplayLayout.kind === 'custom'
              ? resolvedDisplayLayout.cells[index]
              : null
            const cellStyle = customCell ? {
              gridColumn: `${customCell.colStart} / span ${customCell.colSpan}`,
              gridRow: `${customCell.rowStart} / span ${customCell.rowSpan}`
            } : undefined

            return (
              <div
                key={termInfo.id}
                className={`terminal-grid-cell ${activeTerminalId === termInfo.id ? 'active' : ''}`}
                data-terminal-id={termInfo.id}
                style={cellStyle}
                onClick={(e) => handleTerminalFocus(termInfo.id, e)}
              >
                <div className="terminal-grid-header">
	                  <TerminalDropdown
	                    terminalId={termInfo.id}
	                    onViewGitDiff={() => {
	                      void executeSubpageRoute(buildSubpageRouteCommand({
	                        intent: anySubpageOpen ? 'switch' : 'open',
	                        entryPoint: 'dropdown',
	                        terminalId: termInfo.id,
	                        from: activeSubpage,
	                        target: 'diff'
	                      }))
	                    }}
	                    onViewGitHistory={() => {
	                      void executeSubpageRoute(buildSubpageRouteCommand({
	                        intent: anySubpageOpen ? 'switch' : 'open',
	                        entryPoint: 'dropdown',
	                        terminalId: termInfo.id,
	                        from: activeSubpage,
	                        target: 'history'
	                      }))
	                    }}
	                    onChangeWorkDir={() => handleChangeWorkDir(termInfo.id)}
	                    onOpenWorkDir={() => handleOpenWorkDir(termInfo.id)}
	                    onOpenProjectEditor={() => {
	                      void executeSubpageRoute(buildSubpageRouteCommand({
	                        intent: anySubpageOpen ? 'switch' : 'open',
	                        entryPoint: 'dropdown',
	                        terminalId: termInfo.id,
	                        from: activeSubpage,
	                        target: 'editor'
	                      }))
	                    }}
                    onToggleBrowser={() => handleToggleBrowser(termInfo.id)}
                    isBrowserOpen={browserOpenTerminals.has(termInfo.id)}
                    onOpenCodingAgent={() => handleOpenCodingAgent(termInfo.id)}
                    forceClose={hidden || globalOverlayActive}
                  />
                  <div className="terminal-grid-header-left">
                    {editingId === termInfo.id ? (
                      <input
                        ref={editInputRef}
                        type="text"
                        className="terminal-grid-title-input"
                        value={editingTitle}
                        onChange={(e) => setEditingTitle(e.target.value)}
                        onBlur={handleFinishEdit}
                        onKeyDown={handleKeyDown}
                        onClick={(e) => e.stopPropagation()}
                        placeholder={t('terminalGrid.placeholderTask', { index: index + 1 })}
                      />
                    ) : (
                      <span
                        ref={(el) => {
                          if (el) titleAnchorsRef.current.set(termInfo.id, el)
                          else titleAnchorsRef.current.delete(termInfo.id)
                        }}
                        className="terminal-grid-title"
                        onClick={(e) => handleTitleClick(e, termInfo.id)}
                        title={t('terminalGrid.editTitle')}
                      >
                        {termInfo.title}
                      </span>
                    )}
                    <TerminalTitleMenu
                      open={titleMenuTerminalId === termInfo.id}
                      onRequestClose={() => setTitleMenuTerminalId(null)}
                      anchorEl={titleAnchorsRef.current.get(termInfo.id) ?? null}
                      onRename={() => {
                        debugLog('titleMenu:rename', {
                          stage: 'start',
                          terminalId: termInfo.id,
                          source: 'menu',
                          currentCustomName: termInfo.customName
                        })
                        handleStartEdit(termInfo.id, termInfo.customName)
                      }}
                      onUseBranch={() => handleTitleSnapshotRename(termInfo.id, branch ?? '', 'branch')}
                      onUseRepoName={() => handleTitleSnapshotRename(termInfo.id, repoName ?? '', 'repo')}
                      autoFollowEnabled={currentAutoFollowEnabled}
                      onToggleAutoFollow={() => {
                        debugLog('titleMenu:autoFollowToggle', {
                          terminalId: termInfo.id,
                          previous: currentAutoFollowEnabled
                        })
                        setAutoFollowGitBranchForTaskName(!currentAutoFollowEnabled)
                      }}
                      branch={branch}
                      repoName={repoName}
                      forceClose={hidden || globalOverlayActive}
                    />

                    {branch && (
                      <span
                        className={`${branchClassName} terminal-grid-copyable`}
                        title={branchSyncTitle}
                        onDoubleClick={(e) => {
                          void handleCopyText(e, termInfo.id, t('terminalGrid.copyLabel.branch'), branch)
                        }}
                      >
                        <span className="terminal-grid-branch-name">{branch}</span>
                        {sync.showAhead && (
                          <span className="terminal-grid-branch-ahead" aria-label={t('terminalGrid.aheadAria', { ahead: sync.ahead })}>
                            {`↑${sync.ahead}`}
                          </span>
                        )}
                        {sync.showBehind && (
                          <span className="terminal-grid-branch-behind" aria-label={t('terminalGrid.behindAria', { behind: sync.behind })}>
                            {`↓${sync.behind}`}
                          </span>
                        )}
                      </span>
                    )}
                    {repoName && (
                      <span
                        className="terminal-grid-adaptive-repo terminal-grid-copyable"
                        title={t('terminalGrid.repoTitle', { repoName })}
                        onDoubleClick={(e) => {
                          void handleCopyText(e, termInfo.id, t('terminalGrid.copyLabel.repo'), repoName)
                        }}
                      >
                        <span className="terminal-grid-adaptive-expanded">{repoName}</span>
                        <span className="terminal-grid-adaptive-collapsed">
                          <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
                            <path d="M8.186 1.113a.5.5 0 0 0-.372 0L1.846 3.5 8 5.961 14.154 3.5 8.186 1.113zM15 4.239l-6.5 2.6v7.922l6.5-2.6V4.24zM7.5 14.762V6.838L1 4.239v7.923l6.5 2.6zM7.443.184a1.5 1.5 0 0 1 1.114 0l7.129 2.852A.5.5 0 0 1 16 3.5v8.662a1 1 0 0 1-.629.928l-7.185 2.874a.5.5 0 0 1-.372 0L.63 13.09a1 1 0 0 1-.63-.928V3.5a.5.5 0 0 1 .314-.464L7.443.184z" />
                          </svg>
                          <span className="terminal-grid-adaptive-hover-text">{repoName}</span>
                        </span>
                      </span>
                    )}
                    {compactCwd && (
                      <span
                        className="terminal-grid-adaptive-cwd terminal-grid-copyable"
                        title={cwd || ''}
                        onDoubleClick={(e) => {
                          void handleCopyText(e, termInfo.id, t('terminalGrid.copyLabel.path'), cwd)
                        }}
                      >
                        <span className="terminal-grid-adaptive-expanded">{compactCwd}</span>
                        <span className="terminal-grid-adaptive-collapsed">
                          <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
                            <path d="M1 3.5A1.5 1.5 0 0 1 2.5 2h2.764c.958 0 1.76.56 2.311 1.184C7.985 3.648 8.48 4 9 4h4.5A1.5 1.5 0 0 1 15 5.5v7a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 1 12.5v-9z" />
                          </svg>
                          <span className="terminal-grid-adaptive-hover-text">{compactCwd}</span>
                        </span>
                      </span>
                    )}
                  </div>
                </div>
                {copyNotice?.terminalId === termInfo.id && (
                  <span
                    className={`path-copy-toast ${copyNotice.type} terminal-grid-copy-notice`}
                    role="status"
                    aria-live="polite"
                    title={copyNotice.text}
                  >
                    {copyNotice.text}
                  </span>
                )}
                <div
                  ref={getContainerRef(termInfo.id)}
                  className="terminal-grid-container"
                />
                <BrowserPanel
                  isOpen={browserOpenTerminals.has(termInfo.id)}
                  onClose={() => handleCloseBrowser(termInfo.id)}
                  terminalId={termInfo.id}
                  initialUrl={lastBrowserUrls[termInfo.id] || null}
                  onUrlChange={(nextUrl) => {
                    setLastBrowserUrls(prev => ({ ...prev, [termInfo.id]: nextUrl }))
                  }}
                  forceHidden={hidden || globalOverlayActive}
                  isActive={activeTerminalId === termInfo.id}
                  autoRefreshIntervalMs={browserAutoRefresh[termInfo.id] ?? null}
                  onAutoRefreshChange={(intervalMs) => handleBrowserAutoRefreshChange(termInfo.id, intervalMs)}
                />
                {showTerminalOverlay && (
                  <div
                    className={`terminal-grid-cell-overlay ${terminalStatus === 'error' ? 'is-error' : ''}`}
                    onClick={(e) => e.stopPropagation()}
                  >
                    <div className="terminal-grid-cell-overlay-title">
                      {terminalStatus === 'error'
                        ? t('terminalGrid.overlay.errorTitle')
                        : t('terminalGrid.overlay.initializingTitle')}
                    </div>
                    <div className="terminal-grid-cell-overlay-desc">
                      {terminalStatus === 'error'
                        ? t('terminalGrid.overlay.errorDescription')
                        : t('terminalGrid.overlay.initializingDescription')}
                    </div>
                    {terminalStatus === 'error' && (
                      <button
                        className="terminal-grid-cell-overlay-btn"
                        onClick={(e) => {
                          e.stopPropagation()
                          retryTerminal(termInfo.id)
                        }}
                      >
                        {t('terminalGrid.overlay.retry')}
                      </button>
                    )}
                  </div>
                )}
              </div>
            )
          })}
        </div>
        {isTransitioning && (
          <div className="terminal-grid-overlay">
            {t('terminalGrid.overlay.gridInitializing')}
          </div>
        )}
      </div>

      {!hidden && (
        <div
          className={`terminal-grid-subpage-host ${anySubpageOpen ? 'is-open' : 'is-hidden'}`}
          data-active-subpage={activeSubpage ?? ''}
          aria-hidden={!anySubpageOpen}
        >
          {anySubpageOpen && renderedPanelShellState && (
            <SubpagePanelShell
              // SN-05: drive `current` from `activeSubpage` directly. Going
              // through `renderedPanelShellState.current` lags by one render
              // when the destination panel hasn't published its panel-shell
              // state yet (each panel publishes via a useLayoutEffect after
              // mount, so the switcher renders once with the source panel's
              // 'current' value before the destination panel overwrites it).
              current={activeSubpage ?? renderedPanelShellState.current}
              onSelect={renderedPanelShellState.onSelect}
              actions={renderedPanelShellState.actions}
              workingDirectoryLabel={renderedPanelShellState.workingDirectoryLabel}
              workingDirectoryPath={renderedPanelShellState.workingDirectoryPath}
              workingDirectoryTitle={renderedPanelShellState.workingDirectoryTitle}
              onWorkingDirectoryDoubleClick={renderedPanelShellState.onWorkingDirectoryDoubleClick}
              workingDirectoryFeedback={renderedPanelShellState.workingDirectoryFeedback}
              metaExtra={renderedPanelShellState.metaExtra}
              taskTitle={renderedPanelShellState.taskTitle}
            />
          )}
          <div className={`terminal-grid-subpage-body ${isSubpageSwitching ? 'is-switching' : ''}`}>
            <GitDiffViewer
              isOpen={gitDiffOpen}
              onClose={handleCloseGitDiff}
              terminalId={gitDiffTerminalId || ''}
              cwd={gitDiffCwd}
              cwdPending={gitDiffCwdPending}
              openRequestedAt={gitDiffOpenRequestedAt}
              cwdReadyAt={gitDiffCwdReadyAt}
              displayMode="panel"
              panelShellMode="external"
              onPanelShellStateChange={handleDiffPanelShellStateChange}
              taskTitle={terminals.find(t => t.id === gitDiffTerminalId)?.title}
              navigationTarget={gitDiffNavigationTarget}
            />
            <GitHistoryViewer
              isOpen={gitHistoryOpen}
              onClose={handleCloseGitHistory}
              terminalId={gitHistoryTerminalId || ''}
              cwd={gitHistoryCwd}
              displayMode="panel"
              panelShellMode="external"
              onPanelShellStateChange={handleHistoryPanelShellStateChange}
              taskTitle={terminals.find(t => t.id === gitHistoryTerminalId)?.title}
            />
            <ProjectEditor
              isOpen={projectEditorOpenInGrid}
              terminalId={projectEditorOpenInGrid ? projectEditorTerminalId : null}
              cwd={projectEditorOpenInGrid ? projectEditorCwd : null}
              openRequest={projectEditorOpenRequest}
              onClose={onCloseProjectEditor ?? (() => {})}
              onDirtyChange={onProjectEditorDirtyChange}
              displayMode="panel"
              panelShellMode="external"
              onPanelShellStateChange={handleEditorPanelShellStateChange}
              taskTitle={terminals.find(t => t.id === projectEditorTerminalId)?.title}
            />
          </div>
        </div>
      )}
      {codingAgentModalOpen && (
        <CodingAgentModal
          onCancel={handleCloseCodingAgent}
          onLaunch={handleLaunchCodingAgent}
        />
      )}
      {termCtxMenu && createPortal(
        <div
          ref={termCtxMenuRef}
          className="terminal-context-menu"
          style={{
            position: 'fixed',
            left: termCtxMenuPosition?.x ?? termCtxMenu.x,
            top: termCtxMenuPosition?.y ?? termCtxMenu.y
          }}
          onMouseDown={(e) => e.stopPropagation()}
          onContextMenu={(e) => e.preventDefault()}
          role="menu"
        >
          <button
            className="terminal-context-item"
            onClick={handleTermCtxCopy}
            disabled={!termCtxMenu.hasSelection}
          >
            <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M4 2a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V2zm2-1a1 1 0 0 0-1 1v8a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1V2a1 1 0 0 0-1-1H6z" /><path d="M2 6a2 2 0 0 1 2-2v1a1 1 0 0 0-1 1v8a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1h1a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V6z" /></svg>
            <span>{t('terminal.contextMenu.copy')}</span>
          </button>
          <button
            className="terminal-context-item"
            onClick={handleTermCtxPaste}
          >
            <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M10 1.5a.5.5 0 0 0-.5-.5h-3a.5.5 0 0 0-.5.5v1a.5.5 0 0 0 .5.5h3a.5.5 0 0 0 .5-.5v-1zM5 1a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v1a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V1z" /><path d="M3 2.5A1.5 1.5 0 0 1 4.5 1h.585A1.98 1.98 0 0 0 5 2v1a2 2 0 0 0 2 2h2a2 2 0 0 0 2-2V2c0-.068-.004-.135-.011-.2H11.5A1.5 1.5 0 0 1 13 3.5v10a1.5 1.5 0 0 1-1.5 1.5h-7A1.5 1.5 0 0 1 3 13.5v-11z" /></svg>
            <span>{t('terminal.contextMenu.paste')}</span>
          </button>
          {onSendAndExecutePinnedPrompt && (
            <div
              className="terminal-context-submenu-wrapper"
              onMouseEnter={() => {
                if (orderedPinnedPrompts.length > 0) setTermCtxPinnedOpen(true)
              }}
              onMouseLeave={() => setTermCtxPinnedOpen(false)}
            >
              <button
                className={`terminal-context-item has-submenu ${termCtxPinnedOpen ? 'submenu-open' : ''}`}
                role="menuitem"
                aria-haspopup="menu"
                aria-expanded={termCtxPinnedOpen}
                disabled={orderedPinnedPrompts.length === 0}
                data-testid="terminal-context-send-pinned"
                onClick={() => {
                  if (orderedPinnedPrompts.length === 0) return
                  setTermCtxPinnedOpen(prev => !prev)
                }}
              >
                <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M15.854.146a.5.5 0 0 1 .11.54l-5.819 14.547a.75.75 0 0 1-1.329.124l-3.178-4.995L.643 7.184a.75.75 0 0 1 .124-1.33L15.314.037a.5.5 0 0 1 .54.11zM6.636 10.07l2.761 4.338L14.13 2.576 6.636 10.07zm6.787-8.201L1.591 6.602l4.339 2.76 7.494-7.493z" /></svg>
                <span>{t('terminal.contextMenu.sendAndExecuteToTask')}</span>
                <svg className="terminal-context-submenu-chevron" width="10" height="10" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M4.646 1.646a.5.5 0 0 1 .708 0l6 6a.5.5 0 0 1 0 .708l-6 6a.5.5 0 0 1-.708-.708L10.293 8 4.646 2.354a.5.5 0 0 1 0-.708z" /></svg>
              </button>
              {termCtxPinnedOpen && (
                <div
                  ref={termCtxPinnedSubmenuRef}
                  className={`terminal-context-submenu ${termCtxPinnedFlipped ? 'flip' : ''}`}
                  role="menu"
                  data-testid="terminal-context-pinned-submenu"
                  onMouseDown={(event) => event.stopPropagation()}
                >
                  {orderedPinnedPrompts.map((prompt) => (
                    <button
                      key={prompt.id}
                      className="terminal-context-item"
                      role="menuitem"
                      title={prompt.content}
                      onClick={() => handleTermCtxSendPinnedPrompt(prompt)}
                    >
                      <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M9.828.722a.5.5 0 0 1 .354.146l4.95 4.95a.5.5 0 0 1-.707.708l-.812-.813-3.05 3.05a.746.746 0 0 1-.11.143L8.95 10.41a.5.5 0 0 1-.354.147h-.002a.5.5 0 0 1-.353-.146L5.657 7.826a.5.5 0 0 1 0-.708L7.16 5.615a.746.746 0 0 1 .143-.11l3.05-3.05-.813-.812a.5.5 0 0 1 .288-.92zM7.864 6.354L6.414 7.804l2.782 2.782 1.45-1.45-2.782-2.782z" /><path d="M1.5 15a.5.5 0 0 1-.354-.854l4.5-4.5a.5.5 0 0 1 .708.708l-4.5 4.5A.5.5 0 0 1 1.5 15z" /></svg>
                      <span>{ellipsis(getPinnedPromptLabel(prompt, t('terminal.contextMenu.untitledPrompt')), PINNED_PROMPT_LABEL_LIMIT)}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
          <div className="terminal-context-separator" />
          <button
            className="terminal-context-item"
            onClick={handleTermCtxSelectAll}
          >
            <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M2 1a1 1 0 1 0 0 2 1 1 0 0 0 0-2zM0 2a2 2 0 0 1 3.937-.5H5.25a.75.75 0 0 1 0 1.5H3.937A2 2 0 0 1 0 2zm2 11a1 1 0 1 1 0-2 1 1 0 0 1 0 2zm-2-1a2 2 0 0 0 3.937.5h6.126A2 2 0 1 0 12.5 10.063V5.937A2 2 0 1 0 12.063 3.5H5.937A2 2 0 0 0 2 .063v6.126A2 2 0 0 0 0 12zm12 2a1 1 0 1 0 0-2 1 1 0 0 0 0 2zm1-13a1 1 0 1 1-2 0 1 1 0 0 1 2 0z" /></svg>
            <span>{t('terminal.contextMenu.selectAll')}</span>
          </button>
          <button
            className="terminal-context-item"
            onClick={handleTermCtxClear}
          >
            <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M5.5 5.5A.5.5 0 0 1 6 6v6a.5.5 0 0 1-1 0V6a.5.5 0 0 1 .5-.5zm2.5 0a.5.5 0 0 1 .5.5v6a.5.5 0 0 1-1 0V6a.5.5 0 0 1 .5-.5zm3 .5a.5.5 0 0 0-1 0v6a.5.5 0 0 0 1 0V6z" /><path d="M14.5 3a1 1 0 0 1-1 1H13v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V4h-.5a1 1 0 0 1-1-1V2a1 1 0 0 1 1-1H6a1 1 0 0 1 1-1h2a1 1 0 0 1 1 1h3.5a1 1 0 0 1 1 1v1zM4.118 4L4 4.059V13a1 1 0 0 0 1 1h6a1 1 0 0 0 1-1V4.059L11.882 4H4.118zM2.5 3V2h11v1h-11z" /></svg>
            <span>{t('terminal.contextMenu.clear')}</span>
          </button>
        </div>,
        document.body
      )}
    </>
  )
})
