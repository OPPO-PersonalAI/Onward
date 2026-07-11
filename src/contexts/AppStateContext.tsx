/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { createContext, useContext, useEffect, useState, useCallback, useRef, useMemo } from 'react'
import type { AppState, TabState, GlobalPrompt, LocalPrompt, EditorDraft, ProjectEditorState, PromptCleanupConfig, PromptSchedule, UIPreferences, PersistedTerminalState } from '../types/tab.d.ts'
import { findTerminalNameState, type TerminalNameState } from '../utils/terminal-name-state.ts'
import type { Prompt } from '../types/electron.d.ts'
import type { CustomLayoutPreset } from '../types/prompt'
import { normalizeProjectCwd as normalizeProjectCwdImpl } from '../utils/pathNormalize'
import {
  buildProjectEditorStateKey,
  collectLegacyProjectEditorStateKeys,
  findLegacyProjectEditorStateEntry
} from '../utils/projectEditorStateKey'
import { perfTrace, perfTraceDiagnostic } from '../utils/perf-trace'
import { PERF_TRACE_EVENT } from '../utils/perf-trace-names'
import { migrateLayoutMode, DEFAULT_LAYOUT_MODE } from '../utils/layout-mode'
import { isValidCustomLayoutCells } from '../utils/custom-layout-validator'
import { canonicalizeTerminalCwdForPersist } from '../utils/terminal-cwd-osc'
import { appStateContentChanged } from '../utils/app-state-diff'

export const normalizeProjectCwd = normalizeProjectCwdImpl

/**
 * Draft saving anti-shake time (milliseconds)
 */
const DRAFT_SAVE_DEBOUNCE_MS = 300

/** Maximum number of tabs */
const MAX_TABS = 6

/** Automatic cleaning interval (24 hours) */
const AUTO_CLEANUP_INTERVAL_MS = 24 * 60 * 60 * 1000

const DEFAULT_PROMPT_CLEANUP_CONFIG: PromptCleanupConfig = {
  autoEnabled: false,
  autoKeepDays: 30,
  autoDeleteColored: false,
  lastAutoCleanupAt: null
}
const DEFAULT_PROMPT_PANEL_WIDTH = 320
const DEFAULT_PROMPT_EDITOR_HEIGHT = 350
const MIN_PROMPT_EDITOR_HEIGHT = 100

/**
 * Generate unique ID
 */
function generateId(): string {
  return Date.now().toString(36) + Math.random().toString(36).substring(2, 9)
}

/**
 * Completion of Prompt's lastUsedAt
 */
function normalizePromptTimestamp<T extends Prompt>(prompt: T): T {
  const fallback = typeof prompt.updatedAt === 'number'
    ? prompt.updatedAt
    : (typeof prompt.createdAt === 'number' ? prompt.createdAt : Date.now())
  return {
    ...prompt,
    lastUsedAt: typeof prompt.lastUsedAt === 'number' ? prompt.lastUsedAt : fallback
  } as T
}

/**
 * Normalized Prompt cleanup configuration
 */
function normalizePromptCleanup(config?: Partial<PromptCleanupConfig> | null): PromptCleanupConfig {
  if (!config) return { ...DEFAULT_PROMPT_CLEANUP_CONFIG }
  const autoKeepDays = typeof config.autoKeepDays === 'number' && config.autoKeepDays > 0
    ? Math.floor(config.autoKeepDays)
    : DEFAULT_PROMPT_CLEANUP_CONFIG.autoKeepDays
  return {
    autoEnabled: !!config.autoEnabled,
    autoKeepDays,
    autoDeleteColored: !!config.autoDeleteColored,
    lastAutoCleanupAt: typeof config.lastAutoCleanupAt === 'number' ? config.lastAutoCleanupAt : null
  }
}

/**
 * Get Tab display name
 * @param tab Tab state
 * @param index Tab index in the array (0-based)
 * @returns Formatted display name, such as "Tab 1" or "Tab 1: Feature Development"
 */
function getTabDisplayName(tab: TabState, index: number): string {
  const position = index + 1
  if (tab.customName) {
    return `Tab ${position}: ${tab.customName}`
  }
  return `Tab ${position}`
}

/**
 * Get terminal display name
 * @param index The index of the terminal in the current Tab (0-based)
 * @param customName User-defined name
 * @returns Formatted display name, such as "Task 1" or "Task 1: Development Task"
 */
function getTerminalDisplayName(index: number, customName: string | null): string {
  const position = index + 1
  if (customName) {
    return `Task ${position}: ${customName}`
  }
  return `Task ${position}`
}

type ProjectEditorScope = {
  terminalId: string | null
  cwd: string | null
}

function normalizeProjectEditorQuickFiles(paths: unknown): string[] {
  if (!Array.isArray(paths)) return []
  const results: string[] = []
  const dedupe = new Set<string>()
  for (const item of paths) {
    if (typeof item !== 'string') continue
    const normalized = normalizeProjectCwd(item.trim())
    if (!normalized || dedupe.has(normalized)) continue
    dedupe.add(normalized)
    results.push(normalized)
  }
  return results
}

function normalizeProjectEditorOutlineScrollByFile(value: unknown): Record<string, number> {
  if (!value || typeof value !== 'object') return {}
  const result: Record<string, number> = {}
  for (const [filePath, rawScrollTop] of Object.entries(value as Record<string, unknown>)) {
    if (typeof filePath !== 'string') continue
    if (typeof rawScrollTop !== 'number' || !Number.isFinite(rawScrollTop)) continue
    result[normalizeProjectCwd(filePath.trim())] = Math.max(0, rawScrollTop)
  }
  return result
}

function normalizeProjectEditorState(state: ProjectEditorState): ProjectEditorState {
  return {
    ...state,
    expandedDirs: Array.isArray(state.expandedDirs) ? state.expandedDirs : [],
    pinnedFiles: normalizeProjectEditorQuickFiles(state.pinnedFiles),
    recentFiles: normalizeProjectEditorQuickFiles(state.recentFiles),
    outlineScrollByFile: normalizeProjectEditorOutlineScrollByFile(state.outlineScrollByFile),
    savedAt: typeof state.savedAt === 'number' ? state.savedAt : Date.now()
  }
}

function isStringArrayEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return false
  }
  return true
}

// buildProjectEditorStateKey now lives in src/utils/projectEditorStateKey.ts
// (pure module) so Node unit tests can exercise the key scheme directly.

function isProjectEditorStateEqual(
  prev: ProjectEditorState | null | undefined,
  next: ProjectEditorState | null | undefined
): boolean {
  if (!prev && !next) return true
  if (!prev || !next) return false
  if (prev.rootPath !== next.rootPath) return false
  if (prev.activeFilePath !== next.activeFilePath) return false
  const prevDirs = prev.expandedDirs ?? []
  const nextDirs = next.expandedDirs ?? []
  if (!isStringArrayEqual(prevDirs, nextDirs)) return false
  const prevPinned = prev.pinnedFiles ?? []
  const nextPinned = next.pinnedFiles ?? []
  if (!isStringArrayEqual(prevPinned, nextPinned)) return false
  const prevRecent = prev.recentFiles ?? []
  const nextRecent = next.recentFiles ?? []
  if (!isStringArrayEqual(prevRecent, nextRecent)) return false
  const prevView = prev.editorViewState ?? null
  const nextView = next.editorViewState ?? null
  if (prevView !== nextView) return false
  if (prev.cursorLine !== next.cursorLine) return false
  if (prev.cursorColumn !== next.cursorColumn) return false
  if (prev.savedAt !== next.savedAt) return false
  // Per-file state comparison (shallow: check key count difference)
  const prevFileKeys = Object.keys(prev.fileStates ?? {})
  const nextFileKeys = Object.keys(next.fileStates ?? {})
  if (prevFileKeys.length !== nextFileKeys.length) return false
  if (prev.fileStates !== next.fileStates) return false
  return true
}

function applyProjectEditorStateUpdate(
  prev: AppState,
  scope: ProjectEditorScope,
  normalizedState: ProjectEditorState | null
): AppState {
  const stateKey = buildProjectEditorStateKey(scope)
  if (!stateKey) return prev
  const nextStates = { ...(prev.projectEditorStates ?? {}) }
  const previousState = nextStates[stateKey] ?? null
  if (normalizedState) {
    // Write-time migration: drop sibling legacy keys (same terminal, same
    // resolved root under an older cwd-based key) so an adopted entry
    // re-homes to the canonical repo-root key instead of forking.
    let droppedLegacyKey = false
    if (normalizedState.rootPath && scope.terminalId) {
      const legacyKeys = collectLegacyProjectEditorStateKeys(
        nextStates,
        scope.terminalId,
        normalizedState.rootPath,
        stateKey,
        window.electronAPI?.platform ?? ''
      )
      for (const legacyKey of legacyKeys) {
        delete nextStates[legacyKey]
        droppedLegacyKey = true
      }
    }
    if (!droppedLegacyKey && isProjectEditorStateEqual(previousState, normalizedState)) {
      return prev
    }
    nextStates[stateKey] = normalizedState
  } else {
    if (!previousState) {
      return prev
    }
    delete nextStates[stateKey]
  }
  return {
    ...prev,
    projectEditorStates: nextStates
  }
}

const DEBUG_APP_STATE = Boolean(window.electronAPI?.debug?.enabled || window.electronAPI?.debug?.perfTraceEnabled)

function normalizePromptEditorHeight(value: number | null | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return DEFAULT_PROMPT_EDITOR_HEIGHT
  }
  return Math.max(Math.round(value), MIN_PROMPT_EDITOR_HEIGHT)
}

function getPersistCwdPlatform(): string {
  // Renderer: electronAPI exposes the host platform. Fall back to '' (no
  // platform-specific rule) when unavailable so the canonicalizer still
  // applies its platform-independent steps.
  try {
    return (typeof window !== 'undefined' && window.electronAPI?.platform) || ''
  } catch {
    return ''
  }
}

function normalizePersistedTerminalCwd(value: string | null | undefined): string | null {
  // The terminal cwd reaches us from two sources with different conventions and
  // must converge on ONE string, or two TerminalGrid effects (the OSC-cwd persist
  // at TerminalGrid.tsx:573/587 and the git-info persist via applyTerminalInfoUpdate)
  // ping-pong `terminal.lastCwd`, defeating setTerminalLastCwd's idempotency check
  // and pinning the renderer JS thread (idle-CPU storm — re-renders the whole tree
  // thousands of times/sec). Known divergences both writers must be reconciled past:
  //   • Windows: OSC 7 emits '/', the git watcher emits native '\'  ('D:/x' vs 'D:\x').
  //   • macOS:   OSC 7 emits the user-facing path, the git watcher the realpath
  //              ('/var/folders/…' vs '/private/var/folders/…'), and a '$TMPDIR'
  //              ending in '/' yields a stray '//' from one source.
  // canonicalizeTerminalCwdForPersist handles all of these (separator + duplicate
  // slash + macOS firmlink + trailing slash). Pure + unit-tested.
  return canonicalizeTerminalCwdForPersist(value, getPersistCwdPlatform())
}

function normalizePromptInputMode(value: unknown): 'canvas' | 'line' {
  return value === 'canvas' ? 'canvas' : 'line'
}

function normalizeUIPreferences(value: UIPreferences | null | undefined): UIPreferences {
  return {
    ...(value ?? {}),
    promptInputMode: normalizePromptInputMode(value?.promptInputMode)
  }
}

/**
 * Create default tab state
 */
function createDefaultTabState(id: string): TabState {
  return {
    id,
    customName: null,
    createdAt: Date.now(),
    layoutMode: DEFAULT_LAYOUT_MODE,
    activePanel: null,
    promptPanelWidth: DEFAULT_PROMPT_PANEL_WIDTH,
    promptEditorHeight: DEFAULT_PROMPT_EDITOR_HEIGHT,
    activeTerminalId: null,
    terminals: [],
    localPrompts: []
  }
}

/**
 * Create default app state
 */
function createDefaultAppState(): AppState {
  const tabId = generateId()
  return {
    activeTabId: tabId,
    tabs: [createDefaultTabState(tabId)],
    globalPrompts: [],
    promptCleanup: { ...DEFAULT_PROMPT_CLEANUP_CONFIG },
    lastFocusedTerminalId: null,
    projectEditorStates: {},
    promptSchedules: [],
    uiPreferences: { promptInputMode: 'line' },
    customLayoutPresets: [],
    updatedAt: Date.now()
  }
}

/**
 * Sanitise the persisted custom-layout preset list. Drops entries whose
 * cells fail validation (overlap / gap / non-rectangular) so a corrupted
 * file cannot brick the renderer.
 */
function normalizeCustomLayoutPresets(value: unknown): CustomLayoutPreset[] {
  if (!Array.isArray(value)) return []
  const seen = new Set<string>()
  const out: CustomLayoutPreset[] = []
  for (const item of value) {
    if (!item || typeof item !== 'object') continue
    const candidate = item as Partial<CustomLayoutPreset>
    if (typeof candidate.id !== 'string' || candidate.id.length === 0) continue
    if (seen.has(candidate.id)) continue
    if (typeof candidate.name !== 'string') continue
    if (!Array.isArray(candidate.cells) || !isValidCustomLayoutCells(candidate.cells)) continue
    seen.add(candidate.id)
    out.push({
      id: candidate.id,
      name: candidate.name,
      cells: candidate.cells,
      createdAt: typeof candidate.createdAt === 'number' ? candidate.createdAt : Date.now()
    })
  }
  return out
}

const APP_STATE_PATCH_KEYS: Array<keyof AppState> = [
  'activeTabId',
  'tabs',
  'globalPrompts',
  'promptCleanup',
  'lastFocusedTerminalId',
  'projectEditorStates',
  'promptSchedules',
  'uiPreferences',
  'customLayoutPresets',
  'updatedAt'
]

function buildAppStatePatch(previous: AppState | null, next: AppState): Partial<AppState> {
  if (!previous) return next
  const patch: Partial<AppState> = {}
  for (const key of APP_STATE_PATCH_KEYS) {
    if (previous[key] !== next[key]) {
      ;(patch as Record<keyof AppState, unknown>)[key] = next[key]
    }
  }
  return patch
}

interface AppStateContextValue {
  // state
  state: AppState
  isLoaded: boolean
  activeTab: TabState | null

  // Tab operation
  createTab: () => boolean
  closeTab: (tabId: string) => boolean
  switchTab: (tabId: string) => void
  renameTab: (tabId: string, customName: string | null) => void
  updateActiveTab: (updates: Partial<TabState>) => void
  reorderTabs: (fromIndex: number, toIndex: number) => void
  canCreateTab: () => boolean
  getTabDisplayName: (tab: TabState, index: number) => string
  getTerminalDisplayName: (index: number, customName: string | null) => string

  // Task name auto-follow Git branch — shared transient git info + rename ops
  notifyTerminalGitInfo: (terminalId: string, info: { repoRoot: string | null; branch: string | null }) => void
  getTerminalRepoRoot: (terminalId: string) => string | null
  getTerminalBranch: (terminalId: string) => string | null
  /**
   * Authoritative, lag-free read of a Task's customName + manualNameRepoRoot
   * straight from the current AppState (not the one-render-cycle-behind
   * visibleTerminals copy). Auto-follow MUST use this so a git-info sync that
   * arrives right after a manual rename cannot read a stale null marker and
   * clobber the user's name.
   */
  getTerminalNameState: (terminalId: string) => TerminalNameState
  /**
   * Atomic write of customName + manualNameRepoRoot for a terminal.
   * Pass `manualNameRepoRoot: <repoRoot>` to mark a manual override scoped to
   * that repo (so it survives cwd changes within the same repo and gets
   * cleared when the cwd moves to a different repo). Pass null for the
   * auto-follow path.
   */
  setTerminalCustomName: (
    tabId: string,
    terminalId: string,
    customName: string | null,
    manualNameRepoRoot: string | null
  ) => void

  // Prompt operation
  addPrompt: (prompt: Omit<Prompt, 'id' | 'createdAt' | 'updatedAt' | 'lastUsedAt'>) => void
  /**
   * Create a new pinned (global) prompt in one step. Used by entry points
   * that need to mint a global prompt directly (e.g. the prompt editor's
   * right-click "save selection as pinned"), so callers do not have to
   * round-trip through addPrompt + pinPrompt with a hand-tracked id.
   */
  addPinnedPrompt: (prompt: Omit<Prompt, 'id' | 'createdAt' | 'updatedAt' | 'lastUsedAt' | 'pinned'>) => void
  updatePrompt: (prompt: Prompt, preserveTimestamp?: boolean) => void
  deletePrompt: (promptId: string) => void
  pinPrompt: (promptId: string) => void
  unpinPrompt: (promptId: string) => void
  reorderPinnedPrompts: (dragId: string, targetId: string, position: 'before' | 'after') => void
  touchPromptLastUsed: (promptId: string) => void
  cleanupPrompts: (options: { keepDays: number; deleteColored: boolean }) => void
  updatePromptCleanup: (partial: Partial<PromptCleanupConfig>) => void
  importPrompts: (globalPrompts: Prompt[], localPrompts: Prompt[]) => void

  // Merge all prompts (for display)
  getAllPrompts: () => Prompt[]

  // Get whether Tab has a running terminal
  hasRunningTerminals: (tabId: string) => boolean

  // Tab-level operations (not limited to activeTab)
  updateTabById: (tabId: string, updates: Partial<TabState>) => void
  updateEditorDraftForTab: (tabId: string, draft: EditorDraft | null) => void
  updatePromptEditorHeightForTab: (tabId: string, height: number) => void
  setTerminalLastCwd: (terminalId: string, cwd: string | null) => void

  // Draft operations
  updateEditorDraft: (draft: EditorDraft | null) => void
  getEditorDraft: () => EditorDraft | null

  // Terminal focus management
  setLastFocusedTerminalId: (terminalId: string | null) => void
  getLastFocusedTerminalId: () => string | null

  // Focus ownership (non-persistent)
  setLastFocusOwner: (owner: 'terminal' | 'input') => void
  getLastFocusOwner: () => 'terminal' | 'input'

  // Project editor state
  getProjectEditorState: (scope: ProjectEditorScope) => ProjectEditorState | null
  setProjectEditorState: (scope: ProjectEditorScope, state: ProjectEditorState | null) => void
  flushProjectEditorState: (scope: ProjectEditorScope, state: ProjectEditorState | null) => void

  // UI preferences (persisted across restarts/upgrades)
  getUIPreferences: () => UIPreferences
  updateUIPreferences: (updates: Partial<UIPreferences>) => void

  // Scheduled task operations
  addSchedule: (schedule: Omit<PromptSchedule, 'executedCount' | 'createdAt' | 'lastExecutedAt' | 'missedExecutions'>) => void
  updateSchedule: (schedule: PromptSchedule) => void
  deleteSchedule: (promptId: string) => void

  // Custom layout preset CRUD (globally shared across tabs)
  addCustomLayoutPreset: (payload: { name: string; cells: CustomLayoutPreset['cells'] }) => string
  updateCustomLayoutPreset: (id: string, patch: Partial<Pick<CustomLayoutPreset, 'name' | 'cells'>>) => void
  duplicateCustomLayoutPreset: (id: string) => string
  deleteCustomLayoutPreset: (id: string) => void
  /**
   * Atomic preset edit + tab reconcile.
   *
   * Updating a preset's `cells` to a smaller count while a tab is
   * already using that preset would leave the tab's `terminals[]`
   * longer than the new layout exposes — i.e. live PTYs hidden behind
   * the rendered grid. Splitting the change into "update preset" and
   * "truncate tabs" across two reducers means a cancelled downsize
   * dialog leaves the system in that hidden-PTY state. This API does
   * both edits in one updateState call: cells flip and every
   * referencing tab truncates within the same React commit.
   *
   * Callers must dispose the trailing terminal sessions BEFORE invoking
   * this — the reducer is pure state and cannot reach into
   * terminalSessionManager. `activeTabKeepIds` lets the caller route
   * the active tab's terminal selection through DownsizeConfirmDialog;
   * other affected tabs default to "keep first newCount terminals".
   */
  commitCustomLayoutPresetEdit: (
    presetId: string,
    payload: { name: string; cells: CustomLayoutPreset['cells'] },
    activeTabKeepIds: string[] | null
  ) => void
}

const AppStateContext = createContext<AppStateContextValue | null>(null)

export function AppStateProvider({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<AppState>(createDefaultAppState())
  const stateRef = useRef(state)
  stateRef.current = state
  const lastPersistedStateRef = useRef<AppState | null>(null)
  const [isLoaded, setIsLoaded] = useState(false)
  const saveTimeoutRef = useRef<NodeJS.Timeout | null>(null)
  const draftSaveTimeoutRef = useRef<NodeJS.Timeout | null>(null)
  const draftSaveTimersRef = useRef<Map<string, NodeJS.Timeout>>(new Map())
  const promptEditorHeightTimersRef = useRef<Map<string, NodeJS.Timeout>>(new Map())
  // Track pending debounced values so they can be flushed before quit
  const pendingHeightsRef = useRef<Map<string, number>>(new Map())
  const pendingDraftsRef = useRef<Map<string, EditorDraft | undefined>>(new Map())
  const lastFocusOwnerRef = useRef<'terminal' | 'input'>('terminal')
  // Transient (non-persisted) per-terminal Git info bookkeeping. Populated by
  // TerminalGrid via notifyTerminalGitInfo on every IPC GIT_TERMINAL_INFO
  // update. Read by manual-rename callers (PromptSender double-click,
  // TerminalGrid title-menu Rename / Use Branch / Use Repo) so they can stamp
  // manualNameRepoRoot with the cwd's current repo.
  const terminalGitInfoRef = useRef<Map<string, { repoRoot: string | null; branch: string | null }>>(new Map())
  const perfCountersRef = useRef({
    updateCalls: 0,
    // Number of updateState calls whose updater produced no real change and
    // were bailed out (returned prev, React skips re-render). A non-trivial
    // steady-state value here is the fingerprint of a render-storm regression.
    bailedCalls: 0,
    createTab: 0,
    closeTab: 0,
    switchTab: 0,
    renameTab: 0,
    reorderTabs: 0,
    updateActiveTab: 0,
    addPrompt: 0,
    updatePrompt: 0,
    deletePrompt: 0,
    pinPrompt: 0,
    unpinPrompt: 0,
    reorderPinnedPrompts: 0,
    updateEditorDraft: 0,
    updatePromptEditorHeight: 0,
    setTerminalLastCwd: 0,
    setLastFocusedTerminalId: 0,
    setProjectEditorState: 0
  })
  const perfIntervalRef = useRef<number | null>(null)

  // Loading state
  useEffect(() => {
    const load = async () => {
      try {
        const loadedState = await window.electronAPI.appState.load()
        const normalizedState: AppState = {
          ...loadedState,
          globalPrompts: (loadedState.globalPrompts || []).map(prompt => normalizePromptTimestamp(prompt)),
          promptCleanup: normalizePromptCleanup(loadedState.promptCleanup),
          tabs: loadedState.tabs.map(tab => {
            const {
              promptInputMode: _legacyPromptInputMode,
              promptInputModePreferenceVersion: _legacyPromptInputModePreferenceVersion,
              ...restTab
            } = tab
            return {
              ...restTab,
              layoutMode: migrateLayoutMode((tab as { layoutMode?: unknown }).layoutMode),
              promptPanelWidth: Math.max(tab.promptPanelWidth || 0, DEFAULT_PROMPT_PANEL_WIDTH),
              promptEditorHeight: normalizePromptEditorHeight(
                tab.promptEditorHeight ?? tab.editorDraft?.height ?? DEFAULT_PROMPT_EDITOR_HEIGHT
              ),
              terminals: (tab.terminals ?? []).map((terminal) => ({
                ...terminal,
                customName: terminal.customName ?? null,
                manualNameRepoRoot: typeof (terminal as PersistedTerminalState).manualNameRepoRoot === 'string'
                  ? (terminal as PersistedTerminalState).manualNameRepoRoot
                  : null,
                lastCwd: normalizePersistedTerminalCwd(terminal.lastCwd)
              })),
              localPrompts: (tab.localPrompts || []).map(prompt => normalizePromptTimestamp(prompt))
            }
          }),
          projectEditorStates: Object.fromEntries(
            Object.entries(loadedState.projectEditorStates ?? {}).map(([key, value]) => [key, normalizeProjectEditorState(value)])
          ),
          promptSchedules: Array.isArray(loadedState.promptSchedules) ? loadedState.promptSchedules : [],
          uiPreferences: normalizeUIPreferences(loadedState.uiPreferences),
          customLayoutPresets: normalizeCustomLayoutPresets(
            (loadedState as { customLayoutPresets?: unknown }).customLayoutPresets
          )
        }
        stateRef.current = normalizedState
        lastPersistedStateRef.current = normalizedState
        setState(normalizedState)
        const shouldSave = normalizedState.tabs.some((tab, index) => {
          const original = loadedState.tabs[index]
          return !original
            || tab.promptPanelWidth !== original.promptPanelWidth
            || tab.promptEditorHeight !== original.promptEditorHeight
            || original.promptInputMode !== undefined
            || original.promptInputModePreferenceVersion !== undefined
            || tab.terminals.some((terminal, terminalIndex) => terminal.lastCwd !== original.terminals?.[terminalIndex]?.lastCwd)
        }) || normalizedState.uiPreferences.promptInputMode !== loadedState.uiPreferences?.promptInputMode
        if (shouldSave) {
          await window.electronAPI.appState.save(normalizedState)
          lastPersistedStateRef.current = normalizedState
        }
      } catch (error) {
        console.error('Failed to load app state:', error)
      } finally {
        setIsLoaded(true)
      }
    }
    load()
  }, [])

  useEffect(() => {
    return () => {
      if (saveTimeoutRef.current) {
        clearTimeout(saveTimeoutRef.current)
      }
      if (draftSaveTimeoutRef.current) {
        clearTimeout(draftSaveTimeoutRef.current)
      }
      draftSaveTimersRef.current.forEach((timer) => clearTimeout(timer))
      draftSaveTimersRef.current.clear()
      promptEditorHeightTimersRef.current.forEach((timer) => clearTimeout(timer))
      promptEditorHeightTimersRef.current.clear()
    }
  }, [])

  // Flush all pending debounced saves immediately (called before app quit/update)
  useEffect(() => {
    window.electronAPI.appState.onFlushPendingState(async () => {
      // Cancel all pending timers
      if (saveTimeoutRef.current) {
        clearTimeout(saveTimeoutRef.current)
        saveTimeoutRef.current = null
      }
      if (draftSaveTimeoutRef.current) {
        clearTimeout(draftSaveTimeoutRef.current)
        draftSaveTimeoutRef.current = null
      }
      draftSaveTimersRef.current.forEach((timer) => clearTimeout(timer))
      draftSaveTimersRef.current.clear()
      promptEditorHeightTimersRef.current.forEach((timer) => clearTimeout(timer))
      promptEditorHeightTimersRef.current.clear()

      // Build final state with all pending changes applied
      let finalState = { ...stateRef.current }
      let dirty = false

      // Apply pending prompt editor height updates
      for (const [tabId, height] of pendingHeightsRef.current) {
        finalState = {
          ...finalState,
          tabs: finalState.tabs.map(tab =>
            tab.id === tabId ? { ...tab, promptEditorHeight: height } : tab
          )
        }
        dirty = true
      }
      pendingHeightsRef.current.clear()

      // Apply pending tab-level draft updates
      for (const [tabId, draft] of pendingDraftsRef.current) {
        finalState = {
          ...finalState,
          tabs: finalState.tabs.map(tab =>
            tab.id === tabId ? { ...tab, editorDraft: draft } : tab
          )
        }
        dirty = true
      }
      pendingDraftsRef.current.clear()

      // Apply pending active-tab draft update
      if (pendingActiveDraftRef.current) {
        const { draft } = pendingActiveDraftRef.current
        finalState = {
          ...finalState,
          tabs: finalState.tabs.map(tab =>
            tab.id === finalState.activeTabId ? { ...tab, editorDraft: draft } : tab
          )
        }
        pendingActiveDraftRef.current = null
        dirty = true
      }

      if (dirty) {
        finalState.updatedAt = Date.now()
      }

      // Await save to ensure data is written to disk before quit proceeds
      await window.electronAPI.appState.save(finalState)
      await window.electronAPI.appState.flush()
      lastPersistedStateRef.current = finalState
    })
  }, [])

  const persistState = useCallback((newState: AppState, previousState?: AppState | null) => {
    const previous = previousState ?? lastPersistedStateRef.current
    const patch = buildAppStatePatch(previous, newState)
    lastPersistedStateRef.current = newState
    if (Object.keys(patch).length === 0) return
    // Best-effort BACKGROUND persistence: swallow a transient IPC rejection
    // (main handler not yet registered at startup, or already removed during
    // teardown) so it never becomes an UNCAUGHT promise rejection — which under
    // load aborts autotests and, in production, surfaces as a renderer console
    // error for a save that will retry on the next state change anyway. Quit
    // uses the awaited flushAppState path above, so no data is lost here.
    if (Object.keys(patch).length >= APP_STATE_PATCH_KEYS.length) {
      void window.electronAPI.appState.save(newState).catch(() => { /* best effort */ })
      return
    }
    void window.electronAPI.appState.savePatch(patch).catch(() => { /* best effort */ })
  }, [])

  // Debounced state save
  const saveState = useCallback((newState: AppState) => {
    if (saveTimeoutRef.current) {
      clearTimeout(saveTimeoutRef.current)
    }
    saveTimeoutRef.current = setTimeout(() => {
      saveTimeoutRef.current = null
      persistState(newState)
    }, 500)
  }, [persistState])

  // Update state and save
  const updateState = useCallback((updater: (prev: AppState) => AppState) => {
    setState(prev => {
      const next = updater(prev)
      // Bail out on no-op updates so React applies its Object.is bail-out and
      // skips re-rendering the whole tree. Without this, the `updatedAt:
      // Date.now()` stamp below makes every result a brand-new object that
      // defeats the bail-out, turning any effect that (directly or
      // transitively) calls updateState into an unbounded whole-tree render
      // loop — the idle ~8% CPU bug. See utils/app-state-diff.ts.
      if (!appStateContentChanged(prev, next)) {
        if (DEBUG_APP_STATE) {
          perfCountersRef.current.updateCalls += 1
          perfCountersRef.current.bailedCalls += 1
        }
        return prev
      }
      if (DEBUG_APP_STATE) {
        perfCountersRef.current.updateCalls += 1
      }
      const newState = {
        ...next,
        updatedAt: Date.now()
      }
      stateRef.current = newState
      saveState(newState)
      return newState
    })
  }, [saveState])

  useEffect(() => {
    if (!DEBUG_APP_STATE) return
    if (perfIntervalRef.current) return
    perfIntervalRef.current = window.setInterval(() => {
      const snapshot = { ...perfCountersRef.current }
      Object.keys(perfCountersRef.current).forEach((key) => {
        // @ts-expect-error - reset numeric counters
        perfCountersRef.current[key] = 0
      })
      const hasActivity = Object.values(snapshot).some((count) => typeof count === 'number' && count > 0)
      if (hasActivity) {
        if (window.electronAPI.debug.enabled) {
          console.log('[AppState] perf:1s', snapshot)
        }
        perfTrace('renderer:appstate-summary', snapshot)
        try {
          window.electronAPI.debug.log('appstate:perf:1s', snapshot)
        } catch {
          // ignore
        }
      }
    }, 1000)
    return () => {
      if (perfIntervalRef.current) {
        window.clearInterval(perfIntervalRef.current)
        perfIntervalRef.current = null
      }
    }
  }, [])

  // Get the currently active Tab
  const activeTab = state.tabs.find(t => t.id === state.activeTabId) || null

  // Check if new Tab can be created
  const canCreateTab = useCallback((): boolean => {
    return state.tabs.length < MAX_TABS
  }, [state.tabs.length])

  // Tab operation
  const createTab = useCallback((): boolean => {
    if (!canCreateTab()) {
      return false
    }
    if (DEBUG_APP_STATE) {
      perfCountersRef.current.createTab += 1
    }
    updateState(prev => {
      if (prev.tabs.length >= MAX_TABS) {
        return prev
      }
      const newTabId = generateId()
      const newTab = createDefaultTabState(newTabId)
      return {
        ...prev,
        activeTabId: newTabId,
        tabs: [...prev.tabs, newTab]
      }
    })
    return true
  }, [updateState, canCreateTab])

  const closeTab = useCallback((tabId: string): boolean => {
    if (DEBUG_APP_STATE) {
      perfCountersRef.current.closeTab += 1
    }
    let canClose = true
    setState(prev => {
      // Can't close last Tab
      if (prev.tabs.length <= 1) {
        canClose = false
        return prev
      }

      const tabIndex = prev.tabs.findIndex(t => t.id === tabId)
      if (tabIndex === -1) {
        canClose = false
        return prev
      }

      const newTabs = prev.tabs.filter(t => t.id !== tabId)
      let newActiveTabId = prev.activeTabId

      // If the current Tab is closed, switch to the adjacent Tab
      if (prev.activeTabId === tabId) {
        const newIndex = Math.min(tabIndex, newTabs.length - 1)
        newActiveTabId = newTabs[newIndex].id
      }

      // Mark the active scheduled task belonging to this Tab as failed
      const newSchedules = prev.promptSchedules.map(s =>
        s.tabId === tabId && s.status === 'active'
          ? { ...s, status: 'failed' as const, lastError: 'The owning Tab was closed.' }
          : s
      )

      const newState = {
        ...prev,
        activeTabId: newActiveTabId,
        tabs: newTabs,
        promptSchedules: newSchedules,
        updatedAt: Date.now()
      }
      stateRef.current = newState
      saveState(newState)
      return newState
    })
    return canClose
  }, [saveState])

  const switchTab = useCallback((tabId: string) => {
    if (DEBUG_APP_STATE) {
      perfCountersRef.current.switchTab += 1
    }
    updateState(prev => {
      if (!prev.tabs.find(t => t.id === tabId)) return prev
      return {
        ...prev,
        activeTabId: tabId
      }
    })
  }, [updateState])

  const notifyTerminalGitInfo = useCallback((terminalId: string, info: { repoRoot: string | null; branch: string | null }) => {
    terminalGitInfoRef.current.set(terminalId, {
      repoRoot: info.repoRoot,
      branch: info.branch
    })
  }, [])

  const getTerminalRepoRoot = useCallback((terminalId: string): string | null => {
    return terminalGitInfoRef.current.get(terminalId)?.repoRoot ?? null
  }, [])

  const getTerminalBranch = useCallback((terminalId: string): string | null => {
    return terminalGitInfoRef.current.get(terminalId)?.branch ?? null
  }, [])

  // Reads from stateRef.current (updated synchronously inside the state updater),
  // so it reflects a just-applied rename immediately — unlike the visibleTerminals
  // ref, which only catches up on the next render's effect. This closes the
  // window where auto-follow could clobber a freshly-stamped manual override.
  const getTerminalNameState = useCallback((terminalId: string): TerminalNameState => {
    return findTerminalNameState(stateRef.current.tabs, terminalId)
  }, [])

  const setTerminalCustomName = useCallback(
    (tabId: string, terminalId: string, customName: string | null, manualNameRepoRoot: string | null) => {
      const trimmed = typeof customName === 'string' ? (customName.trim() || null) : null
      updateState(prev => {
        let changed = false
        const tabs = prev.tabs.map(tab => {
          if (tab.id !== tabId) return tab
          let tabChanged = false
          const terminals = tab.terminals.map(terminal => {
            if (terminal.id !== terminalId) return terminal
            if (
              terminal.customName === trimmed &&
              (terminal.manualNameRepoRoot ?? null) === manualNameRepoRoot
            ) {
              return terminal
            }
            tabChanged = true
            changed = true
            return {
              ...terminal,
              customName: trimmed,
              manualNameRepoRoot
            }
          })
          return tabChanged ? { ...tab, terminals } : tab
        })
        return changed ? { ...prev, tabs } : prev
      })
    },
    [updateState]
  )

  const renameTab = useCallback((tabId: string, customName: string | null) => {
    if (DEBUG_APP_STATE) {
      perfCountersRef.current.renameTab += 1
    }
    updateState(prev => ({
      ...prev,
      tabs: prev.tabs.map(tab =>
        tab.id === tabId
          ? { ...tab, customName: customName?.trim() || null }
          : tab
      )
    }))
  }, [updateState])

  // Reorder Tabs
  const reorderTabs = useCallback((fromIndex: number, toIndex: number) => {
    if (fromIndex === toIndex) return
    if (DEBUG_APP_STATE) {
      perfCountersRef.current.reorderTabs += 1
    }
    updateState(prev => {
      const newTabs = [...prev.tabs]
      const [movedTab] = newTabs.splice(fromIndex, 1)
      newTabs.splice(toIndex, 0, movedTab)
      return {
        ...prev,
        tabs: newTabs
      }
    })
  }, [updateState])

  const updateActiveTab = useCallback((updates: Partial<TabState>) => {
    if (DEBUG_APP_STATE) {
      perfCountersRef.current.updateActiveTab += 1
    }
    updateState(prev => ({
      ...prev,
      tabs: prev.tabs.map(tab =>
        tab.id === prev.activeTabId ? { ...tab, ...updates } : tab
      )
    }))
  }, [updateState])

  // Update any Tab by ID (not limited to activeTab)
  const updateTabById = useCallback((tabId: string, updates: Partial<TabState>) => {
    updateState(prev => ({
      ...prev,
      tabs: prev.tabs.map(tab =>
        tab.id === tabId ? { ...tab, ...updates } : tab
      )
    }))
  }, [updateState])

  // Prompt operation
  const addPrompt = useCallback((promptData: Omit<Prompt, 'id' | 'createdAt' | 'updatedAt' | 'lastUsedAt'>) => {
    if (DEBUG_APP_STATE) {
      perfCountersRef.current.addPrompt += 1
    }
    const now = Date.now()
    const newPrompt: LocalPrompt = {
      ...promptData,
      id: generateId(),
      pinned: false,
      createdAt: now,
      updatedAt: now,
      lastUsedAt: now
    }

    updateState(prev => ({
      ...prev,
      tabs: prev.tabs.map(tab =>
        tab.id === prev.activeTabId
          ? { ...tab, localPrompts: [newPrompt, ...tab.localPrompts] }
          : tab
      )
    }))
  }, [updateState])

  const addPinnedPrompt = useCallback((promptData: Omit<Prompt, 'id' | 'createdAt' | 'updatedAt' | 'lastUsedAt' | 'pinned'>) => {
    if (DEBUG_APP_STATE) {
      perfCountersRef.current.addPrompt += 1
    }
    const now = Date.now()
    const newPrompt: GlobalPrompt = {
      ...promptData,
      id: generateId(),
      pinned: true,
      createdAt: now,
      updatedAt: now,
      lastUsedAt: now
    }
    updateState(prev => ({
      ...prev,
      globalPrompts: [newPrompt, ...prev.globalPrompts]
    }))
  }, [updateState])

  const updatePrompt = useCallback((prompt: Prompt, preserveTimestamp?: boolean) => {
    if (DEBUG_APP_STATE) {
      perfCountersRef.current.updatePrompt += 1
    }
    updateState(prev => {
      const now = Date.now()
      // Keep updatedAt when preserveTimestamp is used, and do not force update of lastUsedAt
      const updatedPromptData = preserveTimestamp
        ? {
          ...prompt,
          lastUsedAt: typeof prompt.lastUsedAt === 'number' ? prompt.lastUsedAt : now
        }
        : { ...prompt, updatedAt: now, lastUsedAt: now }

      // Check if it is a global prompt
      const globalIndex = prev.globalPrompts.findIndex(p => p.id === prompt.id)
      if (globalIndex >= 0) {
        return {
          ...prev,
          globalPrompts: prev.globalPrompts.map(p =>
            p.id === prompt.id ? { ...updatedPromptData, pinned: true } as GlobalPrompt : p
          )
        }
      }

      // Check if it is the local prompt of the current Tab
      return {
        ...prev,
        tabs: prev.tabs.map(tab => {
          if (tab.id !== prev.activeTabId) return tab
          return {
            ...tab,
            localPrompts: tab.localPrompts.map(p =>
              p.id === prompt.id ? { ...updatedPromptData, pinned: false } as LocalPrompt : p
            )
          }
        })
      }
    })
  }, [updateState])

  const deletePrompt = useCallback((promptId: string) => {
    if (DEBUG_APP_STATE) {
      perfCountersRef.current.deletePrompt += 1
    }
    updateState(prev => {
      // Linked deletion of associated scheduled tasks
      const newSchedules = prev.promptSchedules.filter(s => s.promptId !== promptId)

      // Check if it is a global prompt
      const globalIndex = prev.globalPrompts.findIndex(p => p.id === promptId)
      if (globalIndex >= 0) {
        return {
          ...prev,
          globalPrompts: prev.globalPrompts.filter(p => p.id !== promptId),
          promptSchedules: newSchedules
        }
      }

      // Remove from current Tab
      return {
        ...prev,
        tabs: prev.tabs.map(tab => {
          if (tab.id !== prev.activeTabId) return tab
          return {
            ...tab,
            localPrompts: tab.localPrompts.filter(p => p.id !== promptId)
          }
        }),
        promptSchedules: newSchedules
      }
    })
  }, [updateState])

  const pinPrompt = useCallback((promptId: string) => {
    if (DEBUG_APP_STATE) {
      perfCountersRef.current.pinPrompt += 1
    }
    updateState(prev => {
      // Find the prompt you want to pin in the current Tab
      const currentTab = prev.tabs.find(t => t.id === prev.activeTabId)
      if (!currentTab) return prev

      const promptToPin = currentTab.localPrompts.find(p => p.id === promptId)
      if (!promptToPin) return prev

      // Move to global
      const globalPrompt: GlobalPrompt = {
        ...promptToPin,
        pinned: true,
        updatedAt: Date.now(),
        lastUsedAt: typeof promptToPin.lastUsedAt === 'number' ? promptToPin.lastUsedAt : Date.now()
      }

      return {
        ...prev,
        globalPrompts: [globalPrompt, ...prev.globalPrompts],
        tabs: prev.tabs.map(tab =>
          tab.id === prev.activeTabId
            ? { ...tab, localPrompts: tab.localPrompts.filter(p => p.id !== promptId) }
            : tab
        )
      }
    })
  }, [updateState])

  const unpinPrompt = useCallback((promptId: string) => {
    if (DEBUG_APP_STATE) {
      perfCountersRef.current.unpinPrompt += 1
    }
    updateState(prev => {
      const promptToUnpin = prev.globalPrompts.find(p => p.id === promptId)
      if (!promptToUnpin) return prev

      // Move local to current Tab
      const localPrompt: LocalPrompt = {
        ...promptToUnpin,
        pinned: false,
        updatedAt: Date.now(),
        lastUsedAt: typeof promptToUnpin.lastUsedAt === 'number' ? promptToUnpin.lastUsedAt : Date.now()
      }

      return {
        ...prev,
        globalPrompts: prev.globalPrompts.filter(p => p.id !== promptId),
        tabs: prev.tabs.map(tab =>
          tab.id === prev.activeTabId
            ? { ...tab, localPrompts: [localPrompt, ...tab.localPrompts] }
            : tab
        )
      }
    })
  }, [updateState])

  // Reorder pinned (global) Prompt
  const reorderPinnedPrompts = useCallback((dragId: string, targetId: string, position: 'before' | 'after') => {
    if (dragId === targetId) return
    if (DEBUG_APP_STATE) {
      perfCountersRef.current.reorderPinnedPrompts += 1
    }
    updateState(prev => {
      const ids = prev.globalPrompts.map(p => p.id)
      const fromIndex = ids.indexOf(dragId)
      const targetIndex = ids.indexOf(targetId)
      if (fromIndex === -1 || targetIndex === -1) return prev

      ids.splice(fromIndex, 1)

      let insertIndex = targetIndex
      if (fromIndex < targetIndex) {
        insertIndex -= 1
      }
      if (position === 'after') {
        insertIndex += 1
      }

      insertIndex = Math.max(0, Math.min(insertIndex, ids.length))
      ids.splice(insertIndex, 0, dragId)

      const promptMap = new Map(prev.globalPrompts.map(p => [p.id, p]))
      const reordered = ids.map(id => promptMap.get(id)).filter(Boolean) as GlobalPrompt[]

      return {
        ...prev,
        globalPrompts: reordered
      }
    })
  }, [updateState])

  // Update Prompt's lastUsedAt
  const touchPromptLastUsed = useCallback((promptId: string) => {
    const now = Date.now()
    updateState(prev => ({
      ...prev,
      globalPrompts: prev.globalPrompts.map(p =>
        p.id === promptId ? { ...p, lastUsedAt: now } as GlobalPrompt : p
      ),
      tabs: prev.tabs.map(tab => ({
        ...tab,
        localPrompts: tab.localPrompts.map(p =>
          p.id === promptId ? { ...p, lastUsedAt: now } as LocalPrompt : p
        )
      }))
    }))
  }, [updateState])

  // Clean history Prompt (by lastUsedAt)
  const cleanupPrompts = useCallback((options: { keepDays: number; deleteColored: boolean }) => {
    const now = Date.now()
    const cutoff = now - options.keepDays * 24 * 60 * 60 * 1000
    updateState(prev => ({
      ...prev,
      tabs: prev.tabs.map(tab => ({
        ...tab,
        localPrompts: tab.localPrompts.filter(prompt => {
          if (prompt.pinned) return true
          const isColored = prompt.color === 'red' || prompt.color === 'yellow' || prompt.color === 'green'
          const shouldDelete = prompt.lastUsedAt < cutoff && (options.deleteColored || !isColored)
          return !shouldDelete
        })
      }))
    }))
  }, [updateState])

  // Update Prompt cleanup configuration
  const updatePromptCleanup = useCallback((partial: Partial<PromptCleanupConfig>) => {
    updateState(prev => ({
      ...prev,
      promptCleanup: normalizePromptCleanup({ ...prev.promptCleanup, ...partial })
    }))
  }, [updateState])

  const importPrompts = useCallback((globalPrompts: Prompt[], localPrompts: Prompt[]) => {
    if (globalPrompts.length === 0 && localPrompts.length === 0) return
    updateState(prev => ({
      ...prev,
      globalPrompts: [
        ...globalPrompts.map(prompt => normalizePromptTimestamp({ ...prompt, pinned: true } as Prompt) as GlobalPrompt),
        ...prev.globalPrompts
      ],
      tabs: prev.tabs.map((tab) => {
        if (tab.id !== prev.activeTabId) return tab
        return {
          ...tab,
          localPrompts: [
            ...localPrompts.map(prompt => normalizePromptTimestamp({ ...prompt, pinned: false } as Prompt) as LocalPrompt),
            ...tab.localPrompts
          ]
        }
      })
    }))
  }, [updateState])

  // Get all Prompts (global + local to current Tab)
  const getAllPrompts = useCallback((): Prompt[] => {
    const currentTab = state.tabs.find(t => t.id === state.activeTabId)
    if (!currentTab) return [...state.globalPrompts]

    // Global Prompt comes first, local Prompt comes last
    return [...state.globalPrompts, ...currentTab.localPrompts]
  }, [state])

  // Automatic cleanup schedule
  const runAutoCleanup = useCallback(() => {
    cleanupPrompts({
      keepDays: state.promptCleanup.autoKeepDays,
      deleteColored: state.promptCleanup.autoDeleteColored
    })
    updatePromptCleanup({ lastAutoCleanupAt: Date.now() })
  }, [cleanupPrompts, state.promptCleanup.autoDeleteColored, state.promptCleanup.autoKeepDays, updatePromptCleanup])

  useEffect(() => {
    if (!state.promptCleanup.autoEnabled) return

    const now = Date.now()
    const lastRun = state.promptCleanup.lastAutoCleanupAt ?? 0
    if (now - lastRun >= AUTO_CLEANUP_INTERVAL_MS) {
      runAutoCleanup()
      return
    }

    const delay = AUTO_CLEANUP_INTERVAL_MS - (now - lastRun)
    const timerId = window.setTimeout(() => {
      runAutoCleanup()
    }, delay)

    return () => window.clearTimeout(timerId)
  }, [state.promptCleanup.autoEnabled, state.promptCleanup.lastAutoCleanupAt, runAutoCleanup])

  // Check if Tab has a running terminal
  const hasRunningTerminals = useCallback((tabId: string): boolean => {
    const tab = state.tabs.find(t => t.id === tabId)
    return tab ? tab.terminals.length > 0 : false
  }, [state])

  // Update editor draft (independent 300ms anti-shake)
  const pendingActiveDraftRef = useRef<{ draft: EditorDraft | undefined } | null>(null)
  const updateEditorDraft = useCallback((draft: EditorDraft | null) => {
    if (DEBUG_APP_STATE) {
      perfCountersRef.current.updateEditorDraft += 1
    }
    pendingActiveDraftRef.current = { draft: draft ?? undefined }
    if (draftSaveTimeoutRef.current) {
      clearTimeout(draftSaveTimeoutRef.current)
    }
    draftSaveTimeoutRef.current = setTimeout(() => {
      pendingActiveDraftRef.current = null
      setState(prev => {
        const newState = {
          ...prev,
          tabs: prev.tabs.map(tab =>
            tab.id === prev.activeTabId
              ? { ...tab, editorDraft: draft ?? undefined }
              : tab
          ),
          updatedAt: Date.now()
        }
        stateRef.current = newState
        // Save directly without ordinary anti-shake
        persistState(newState, prev)
        return newState
      })
    }, DRAFT_SAVE_DEBOUNCE_MS)
  }, [persistState])

  // Tab-level draft anti-shake saving (independent timer for each Tab)
  const updateEditorDraftForTab = useCallback((tabId: string, draft: EditorDraft | null) => {
    pendingDraftsRef.current.set(tabId, draft ?? undefined)
    const existingTimer = draftSaveTimersRef.current.get(tabId)
    if (existingTimer) {
      clearTimeout(existingTimer)
    }
    const timer = setTimeout(() => {
      draftSaveTimersRef.current.delete(tabId)
      pendingDraftsRef.current.delete(tabId)
      setState(prev => {
        const newState = {
          ...prev,
          tabs: prev.tabs.map(tab =>
            tab.id === tabId
              ? { ...tab, editorDraft: draft ?? undefined }
              : tab
          ),
          updatedAt: Date.now()
        }
        stateRef.current = newState
        persistState(newState, prev)
        return newState
      })
    }, DRAFT_SAVE_DEBOUNCE_MS)
    draftSaveTimersRef.current.set(tabId, timer)
  }, [persistState])

  const updatePromptEditorHeightForTab = useCallback((tabId: string, height: number) => {
    if (DEBUG_APP_STATE) {
      perfCountersRef.current.updatePromptEditorHeight += 1
    }
    const normalizedHeight = normalizePromptEditorHeight(height)
    pendingHeightsRef.current.set(tabId, normalizedHeight)
    const existingTimer = promptEditorHeightTimersRef.current.get(tabId)
    if (existingTimer) {
      clearTimeout(existingTimer)
    }
    const timer = setTimeout(() => {
      promptEditorHeightTimersRef.current.delete(tabId)
      pendingHeightsRef.current.delete(tabId)
      setState(prev => {
        const currentTab = prev.tabs.find(tab => tab.id === tabId)
        if (!currentTab || currentTab.promptEditorHeight === normalizedHeight) {
          return prev
        }
        const newState = {
          ...prev,
          tabs: prev.tabs.map(tab =>
            tab.id === tabId
              ? { ...tab, promptEditorHeight: normalizedHeight }
              : tab
          ),
          updatedAt: Date.now()
        }
        stateRef.current = newState
        persistState(newState, prev)
        return newState
      })
    }, DRAFT_SAVE_DEBOUNCE_MS)
    promptEditorHeightTimersRef.current.set(tabId, timer)
  }, [persistState])

  const setTerminalLastCwd = useCallback((terminalId: string, cwd: string | null) => {
    if (DEBUG_APP_STATE) {
      perfCountersRef.current.setTerminalLastCwd += 1
    }
    const normalizedCwd = normalizePersistedTerminalCwd(cwd)
    updateState(prev => {
      let changed = false
      const tabs = prev.tabs.map((tab) => {
        let tabChanged = false
        const terminals = tab.terminals.map((terminal) => {
          if (terminal.id !== terminalId) {
            return terminal
          }
          if (terminal.lastCwd === normalizedCwd) {
            return terminal
          }
          changed = true
          tabChanged = true
          return {
            ...terminal,
            lastCwd: normalizedCwd
          }
        })
        return tabChanged ? { ...tab, terminals } : tab
      })
      return changed ? { ...prev, tabs } : prev
    })
  }, [updateState])

  // Get the editor draft of the current Tab
  const getEditorDraft = useCallback((): EditorDraft | null => {
    const currentTab = state.tabs.find(t => t.id === state.activeTabId)
    return currentTab?.editorDraft ?? null
  }, [state])

  // Set the last focused terminal ID
  const setLastFocusedTerminalId = useCallback((terminalId: string | null) => {
    if (DEBUG_APP_STATE) {
      perfCountersRef.current.setLastFocusedTerminalId += 1
    }
    updateState(prev => ({
      ...prev,
      lastFocusedTerminalId: terminalId
    }))
  }, [updateState])

  // Get the last focused terminal ID
  const getLastFocusedTerminalId = useCallback((): string | null => {
    return state.lastFocusedTerminalId
  }, [state.lastFocusedTerminalId])

  // Set focus ownership (not persistent)
  const setLastFocusOwner = useCallback((owner: 'terminal' | 'input') => {
    lastFocusOwnerRef.current = owner
  }, [])

  // Get focus ownership (not persisted)
  const getLastFocusOwner = useCallback((): 'terminal' | 'input' => {
    return lastFocusOwnerRef.current
  }, [])

  const getProjectEditorState = useCallback((scope: ProjectEditorScope): ProjectEditorState | null => {
    const stateKey = buildProjectEditorStateKey(scope)
    if (!stateKey) return null
    const exact = stateRef.current.projectEditorStates?.[stateKey] ?? null
    if (exact) return exact
    // Legacy adoption: entries persisted before the repo-root scope
    // normalization live under [terminalId, old-cwd] keys. Match them by the
    // entry's own rootPath; the next persist re-homes them (write-time
    // migration in applyProjectEditorStateUpdate).
    if (!scope.terminalId || !scope.cwd) return null
    const legacy = findLegacyProjectEditorStateEntry(
      stateRef.current.projectEditorStates,
      scope.terminalId,
      scope.cwd,
      window.electronAPI?.platform ?? ''
    )
    if (legacy) {
      perfTraceDiagnostic(PERF_TRACE_EVENT.RENDERER_PROJECT_EDITOR_SCOPE_STATE_LEGACY_ADOPTED, {
        ph: 'i'
      })
    }
    return legacy?.state ?? null
  }, [])

  const setProjectEditorState = useCallback((scope: ProjectEditorScope, projectState: ProjectEditorState | null) => {
    const stateKey = buildProjectEditorStateKey(scope)
    if (!stateKey) return
    if (DEBUG_APP_STATE) {
      perfCountersRef.current.setProjectEditorState += 1
    }
    const normalizedState = projectState ? normalizeProjectEditorState(projectState) : null
    updateState(prev => {
      return applyProjectEditorStateUpdate(prev, scope, normalizedState)
    })
  }, [updateState])

  const flushProjectEditorState = useCallback((scope: ProjectEditorScope, projectState: ProjectEditorState | null) => {
    if (DEBUG_APP_STATE) {
      perfCountersRef.current.setProjectEditorState += 1
    }
    const normalizedState = projectState ? normalizeProjectEditorState(projectState) : null
    const currentState = stateRef.current
    const nextBaseState = applyProjectEditorStateUpdate(currentState, scope, normalizedState)
    const nextState = nextBaseState === currentState
      ? currentState
      : {
          ...nextBaseState,
          updatedAt: Date.now()
        }
    stateRef.current = nextState
    setState(nextState)
    if (saveTimeoutRef.current) {
      clearTimeout(saveTimeoutRef.current)
      saveTimeoutRef.current = null
    }
    persistState(nextState, currentState)
  }, [persistState])

  // Add a scheduled task
  const addSchedule = useCallback((schedule: Omit<PromptSchedule, 'executedCount' | 'createdAt' | 'lastExecutedAt' | 'missedExecutions'>) => {
    updateState(prev => {
      // Each Prompt has at most one scheduled task
      const existing = prev.promptSchedules.find(s => s.promptId === schedule.promptId)
      const newSchedule: PromptSchedule = {
        ...schedule,
        executedCount: 0,
        createdAt: Date.now(),
        lastExecutedAt: null,
        missedExecutions: 0
      }
      if (existing) {
        return {
          ...prev,
          promptSchedules: prev.promptSchedules.map(s =>
            s.promptId === schedule.promptId ? newSchedule : s
          )
        }
      }
      return {
        ...prev,
        promptSchedules: [...prev.promptSchedules, newSchedule]
      }
    })
  }, [updateState])

  // Update scheduled tasks
  const updateSchedule = useCallback((schedule: PromptSchedule) => {
    updateState(prev => ({
      ...prev,
      promptSchedules: prev.promptSchedules.map(s =>
        s.promptId === schedule.promptId ? schedule : s
      )
    }))
  }, [updateState])

  // Delete scheduled tasks
  const deleteScheduleByPromptId = useCallback((promptId: string) => {
    updateState(prev => ({
      ...prev,
      promptSchedules: prev.promptSchedules.filter(s => s.promptId !== promptId)
    }))
  }, [updateState])

  // UI preferences
  const getUIPreferences = useCallback((): UIPreferences => {
    return state.uiPreferences ?? {}
  }, [state.uiPreferences])

  const updateUIPreferences = useCallback((updates: Partial<UIPreferences>) => {
    // UIPreferences writes are infrequent (drag-end events) but high-value.
    // Save immediately without going through the 500ms debounce to ensure
    // layout preferences survive sudden quits or update-restarts.
    setState(prev => {
      const newState = {
        ...prev,
        uiPreferences: { ...(prev.uiPreferences ?? {}), ...updates },
        updatedAt: Date.now()
      }
      stateRef.current = newState
      if (saveTimeoutRef.current) {
        clearTimeout(saveTimeoutRef.current)
        saveTimeoutRef.current = null
      }
      persistState(newState, prev)
      return newState
    })
  }, [persistState])

  // -- Custom layout preset CRUD --
  // Presets are global (AppState.customLayoutPresets) so they show up in
  // every tab's popover. Tabs that referenced a preset by id automatically
  // fall back to preset 1 in resolveLayout when the preset is deleted.
  const addCustomLayoutPreset = useCallback((payload: { name: string; cells: CustomLayoutPreset['cells'] }) => {
    const id = generateId()
    updateState(prev => ({
      ...prev,
      customLayoutPresets: [
        ...prev.customLayoutPresets,
        {
          id,
          name: payload.name,
          cells: payload.cells,
          createdAt: Date.now()
        }
      ]
    }))
    return id
  }, [updateState])

  const updateCustomLayoutPreset = useCallback((id: string, patch: Partial<Pick<CustomLayoutPreset, 'name' | 'cells'>>) => {
    updateState(prev => ({
      ...prev,
      customLayoutPresets: prev.customLayoutPresets.map(preset =>
        preset.id === id
          ? {
            ...preset,
            ...(patch.name !== undefined ? { name: patch.name } : {}),
            ...(patch.cells !== undefined ? { cells: patch.cells } : {})
          }
          : preset
      )
    }))
  }, [updateState])

  const duplicateCustomLayoutPreset = useCallback((id: string) => {
    const newId = generateId()
    updateState(prev => {
      const source = prev.customLayoutPresets.find(p => p.id === id)
      if (!source) return prev
      return {
        ...prev,
        customLayoutPresets: [
          ...prev.customLayoutPresets,
          {
            id: newId,
            name: `${source.name} (copy)`,
            cells: source.cells,
            createdAt: Date.now()
          }
        ]
      }
    })
    return newId
  }, [updateState])

  const commitCustomLayoutPresetEdit = useCallback((
    presetId: string,
    payload: { name: string; cells: CustomLayoutPreset['cells'] },
    activeTabKeepIds: string[] | null
  ) => {
    updateState(prev => {
      const newCount = payload.cells.length
      const newPresets = prev.customLayoutPresets.map(p =>
        p.id === presetId
          ? { ...p, name: payload.name, cells: payload.cells }
          : p
      )
      const activeKeep = activeTabKeepIds ? new Set(activeTabKeepIds) : null
      const newTabs = prev.tabs.map(tab => {
        if (tab.layoutMode.kind !== 'custom' || tab.layoutMode.presetId !== presetId) {
          return tab
        }
        if (tab.terminals.length <= newCount) {
          return tab
        }
        let survivors: typeof tab.terminals
        if (activeKeep && tab.id === prev.activeTabId) {
          // Active tab honours the user's pick from the dialog — preserves
          // selection order so "Task 1..N" labels match what they kept.
          survivors = tab.terminals.filter(t => activeKeep.has(t.id))
        } else {
          // Background tabs auto-keep the first newCount terminals. The
          // dialog can only ask once, on the active tab; surfacing it
          // again per-tab on switch would be invasive. The first-N rule
          // is the same one used elsewhere when a layout shrinks.
          survivors = tab.terminals.slice(0, newCount)
        }
        const nextActiveTerminalId = survivors.some(t => t.id === tab.activeTerminalId)
          ? tab.activeTerminalId
          : (survivors[0]?.id ?? null)
        return { ...tab, terminals: survivors, activeTerminalId: nextActiveTerminalId }
      })
      return { ...prev, customLayoutPresets: newPresets, tabs: newTabs }
    })
  }, [updateState])

  const deleteCustomLayoutPreset = useCallback((id: string) => {
    updateState(prev => {
      const remaining = prev.customLayoutPresets.filter(p => p.id !== id)
      // Tabs that referenced the deleted preset fall back to preset 1
      // AND truncate their terminal list to a single Task so we don't
      // strand hidden PTYs (preset 1 only exposes the first slot — the
      // tail would otherwise survive as orphan processes the user can no
      // longer reach). Callers should dispose the trailing terminal
      // sessions before invoking this reducer; the reducer only edits
      // state and cannot reach into terminalSessionManager directly.
      const tabs = prev.tabs.map(tab => {
        if (tab.layoutMode.kind === 'custom' && tab.layoutMode.presetId === id) {
          const survivors = tab.terminals.slice(0, 1)
          return {
            ...tab,
            layoutMode: DEFAULT_LAYOUT_MODE,
            terminals: survivors,
            activeTerminalId: survivors[0]?.id ?? null
          }
        }
        return tab
      })
      return { ...prev, customLayoutPresets: remaining, tabs }
    })
  }, [updateState])

  const value: AppStateContextValue = useMemo(() => ({
    state,
    isLoaded,
    activeTab,
    createTab,
    closeTab,
    switchTab,
    renameTab,
    updateActiveTab,
    updateTabById,
    updateEditorDraftForTab,
    updatePromptEditorHeightForTab,
    setTerminalLastCwd,
    reorderTabs,
    canCreateTab,
    getTabDisplayName,
    getTerminalDisplayName,
    notifyTerminalGitInfo,
    getTerminalRepoRoot,
    getTerminalBranch,
    getTerminalNameState,
    setTerminalCustomName,
    addPrompt,
    addPinnedPrompt,
    updatePrompt,
    deletePrompt,
    pinPrompt,
    unpinPrompt,
    reorderPinnedPrompts,
    touchPromptLastUsed,
    cleanupPrompts,
    updatePromptCleanup,
    importPrompts,
    getAllPrompts,
    hasRunningTerminals,
    updateEditorDraft,
    getEditorDraft,
    setLastFocusedTerminalId,
    getLastFocusedTerminalId,
    setLastFocusOwner,
    getLastFocusOwner,
    getProjectEditorState,
    setProjectEditorState,
    flushProjectEditorState,
    getUIPreferences,
    updateUIPreferences,
    addSchedule,
    updateSchedule,
    deleteSchedule: deleteScheduleByPromptId,
    addCustomLayoutPreset,
    updateCustomLayoutPreset,
    duplicateCustomLayoutPreset,
    deleteCustomLayoutPreset,
    commitCustomLayoutPresetEdit
  }), [
    state, isLoaded, activeTab,
    createTab, closeTab, switchTab, renameTab,
    updateActiveTab, updateTabById, updateEditorDraftForTab, updatePromptEditorHeightForTab, setTerminalLastCwd,
    reorderTabs, canCreateTab,
    notifyTerminalGitInfo, getTerminalRepoRoot, getTerminalBranch, getTerminalNameState, setTerminalCustomName,
    addPrompt, addPinnedPrompt, updatePrompt, deletePrompt,
    pinPrompt, unpinPrompt, reorderPinnedPrompts,
    touchPromptLastUsed, cleanupPrompts, updatePromptCleanup, importPrompts,
    getAllPrompts, hasRunningTerminals,
    updateEditorDraft, getEditorDraft,
    setLastFocusedTerminalId, getLastFocusedTerminalId,
    setLastFocusOwner, getLastFocusOwner,
    getProjectEditorState, setProjectEditorState, flushProjectEditorState,
    getUIPreferences, updateUIPreferences,
    addSchedule, updateSchedule, deleteScheduleByPromptId,
    addCustomLayoutPreset, updateCustomLayoutPreset, duplicateCustomLayoutPreset, deleteCustomLayoutPreset,
    commitCustomLayoutPresetEdit
  ])

  return (
    <AppStateContext.Provider value={value}>
      {children}
    </AppStateContext.Provider>
  )
}

export function useAppState(): AppStateContextValue {
  const context = useContext(AppStateContext)
  if (!context) {
    throw new Error('useAppState must be used within an AppStateProvider')
  }
  return context
}
