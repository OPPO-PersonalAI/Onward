/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

import { app } from 'electron'
import { dirname, join } from 'path'
import { readFileSync, existsSync, mkdirSync, renameSync, writeFileSync } from 'fs'
import { appStateWorkerClient } from './app-state-worker-client'
import { performanceTrace } from './performance-trace'
import { PERF_TRACE_EVENT } from '../../src/utils/perf-trace-names'
import { resolveExistingTerminalCwd } from './terminal-cwd-validation'
import { normalizePersistedTerminals, type PersistedTerminalState } from './persisted-terminal'

import { validatePreviewScrollAnchor, validateFileViewMemoryEntry } from './app-state-file-view-memory'

/**
 * Prompt data structure
 */
interface Prompt {
  id: string
  title: string
  content: string
  pinned: boolean
  color?: 'red' | 'yellow' | 'green' | null
  createdAt: number
  updatedAt: number
  lastUsedAt: number
}

/**
 * Local Prompt (independent for each Tab)
 */
interface LocalPrompt extends Prompt {
  pinned: false
}

/**
 * Global Prompt (shared by all Tabs, pinned state)
 */
interface GlobalPrompt extends Prompt {
  pinned: true
}

/**
 * Editor draft
 */
interface EditorDraft {
  title: string
  content: string
  height: number
  savedAt: number
}

/**
 * Project editor state (persistent by terminal + working directory)
 */
interface ProjectEditorState {
  rootPath: string | null
  activeFilePath: string | null
  expandedDirs: string[]
  pinnedFiles?: string[]
  recentFiles?: string[]
  editorViewState?: unknown
  cursorLine?: number
  cursorColumn?: number
  savedAt: number
  // UI layout state
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
  // Per-file state memory
  fileStates?: Record<string, import('../../src/types/tab').FileViewMemory>
}

/**
 * Prompt cleanup configuration
 */
interface PromptCleanupConfig {
  autoEnabled: boolean
  autoKeepDays: number
  autoDeleteColored: boolean
  lastAutoCleanupAt: number | null
}

/**
 * Tab state
 */
type PresetCount = 1 | 2 | 4 | 6 | 8

interface CustomLayoutCell {
  rowStart: 1 | 2
  rowSpan: 1 | 2
  colStart: 1 | 2 | 3 | 4
  colSpan: 1 | 2 | 3 | 4
}

interface CustomLayoutPreset {
  id: string
  name: string
  cells: CustomLayoutCell[]
  createdAt: number
}

type LayoutMode =
  | { kind: 'preset'; count: PresetCount }
  | { kind: 'custom'; presetId: string }

interface TabState {
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
  activeSubpage?: 'diff' | 'editor' | 'history' | null
  subpageTerminalId?: string | null
  /** Deprecated: prompt input mode now lives in uiPreferences.promptInputMode. */
  promptInputMode?: 'canvas' | 'line'
  /** Deprecated migration marker for legacy per-Tab prompt input mode. */
  promptInputModePreferenceVersion?: number
}

/**
 * Global UI preferences persisted across restarts and upgrades.
 */
interface UIPreferences {
  promptInputMode?: 'canvas' | 'line'
  projectEditorFileTreeWidth?: number
  projectEditorFileBrowserCollapsed?: boolean
  projectEditorModalSize?: { width: number; height: number }
  projectEditorMarkdownPreviewWidth?: number
  projectEditorHtmlPreviewZoomFactor?: number
  projectEditorMarkdownEditorVisible?: boolean
  projectEditorOutlineVisible?: boolean
  projectEditorOutlineWidth?: number
  projectEditorOutlineTarget?: 'editor' | 'preview'
  gitDiffFileListWidth?: number
  gitDiffModalSize?: { width: number; height: number }
  gitDiffSplitViewRatio?: number
  gitDiffImageDisplayMode?: string
  gitDiffImageCompareMode?: string
  gitHistoryFileListWidth?: number
  gitHistoryHideWhitespace?: boolean
  gitHistoryDiffStyle?: string
  gitHistorySummaryHeight?: number
  gitHistoryStates?: Record<string, unknown>
}

/**
 * Application state
 */
interface AppState {
  activeTabId: string
  tabs: TabState[]
  globalPrompts: GlobalPrompt[]
  promptCleanup: PromptCleanupConfig
  lastFocusedTerminalId: string | null
  projectEditorStates: Record<string, ProjectEditorState>
  promptSchedules: PromptSchedule[]
  uiPreferences: UIPreferences
  customLayoutPresets: CustomLayoutPreset[]
  updatedAt: number
}

/**
 * Legacy terminal configuration (for migration)
 */
interface LegacyTerminalConfig {
  version: number
  layoutMode: 1 | 2 | 4 | 6 | 8
  activeTerminalId: string | null
  activePanel: 'prompt' | null
  terminals: { id: string; title: string }[]
  promptPanelWidth: number
  updatedAt: number
}

const VALID_PRESET_COUNTS: readonly PresetCount[] = [1, 2, 4, 6, 8]
const CUSTOM_GRID_ROWS = 2
const CUSTOM_GRID_COLS = 4
const CUSTOM_GRID_TOTAL = CUSTOM_GRID_ROWS * CUSTOM_GRID_COLS

function isPresetCount(value: unknown): value is PresetCount {
  return typeof value === 'number' && (VALID_PRESET_COUNTS as readonly number[]).includes(value)
}

/**
 * Migrate any persisted layoutMode shape (legacy bare number, current
 * union, malformed) into a normalised LayoutMode union. Defaults to
 * preset 1 when the input is unrecognised so a corrupt file cannot brick
 * the renderer.
 */
function migrateLayoutMode(value: unknown): LayoutMode {
  if (isPresetCount(value)) return { kind: 'preset', count: value }
  if (value && typeof value === 'object') {
    const obj = value as { kind?: unknown; count?: unknown; presetId?: unknown }
    if (obj.kind === 'preset' && isPresetCount(obj.count)) return { kind: 'preset', count: obj.count }
    if (obj.kind === 'custom' && typeof obj.presetId === 'string' && obj.presetId.length > 0) {
      return { kind: 'custom', presetId: obj.presetId }
    }
  }
  return { kind: 'preset', count: 1 }
}

function isValidCustomLayoutCellShape(cell: unknown): cell is CustomLayoutCell {
  if (!cell || typeof cell !== 'object') return false
  const c = cell as Partial<CustomLayoutCell>
  return (
    Number.isInteger(c.rowStart) && (c.rowStart as number) >= 1 && (c.rowStart as number) <= CUSTOM_GRID_ROWS &&
    Number.isInteger(c.rowSpan) && (c.rowSpan as number) >= 1 && (c.rowSpan as number) <= CUSTOM_GRID_ROWS &&
    Number.isInteger(c.colStart) && (c.colStart as number) >= 1 && (c.colStart as number) <= CUSTOM_GRID_COLS &&
    Number.isInteger(c.colSpan) && (c.colSpan as number) >= 1 && (c.colSpan as number) <= CUSTOM_GRID_COLS
  )
}

function isValidCustomLayoutCellList(cells: unknown): cells is CustomLayoutCell[] {
  if (!Array.isArray(cells) || cells.length === 0 || cells.length > CUSTOM_GRID_TOTAL) return false
  const occupancy: boolean[][] = Array.from(
    { length: CUSTOM_GRID_ROWS },
    () => Array.from({ length: CUSTOM_GRID_COLS }, () => false)
  )
  for (const cell of cells) {
    if (!isValidCustomLayoutCellShape(cell)) return false
    const rEnd = cell.rowStart + cell.rowSpan - 1
    const cEnd = cell.colStart + cell.colSpan - 1
    if (rEnd > CUSTOM_GRID_ROWS || cEnd > CUSTOM_GRID_COLS) return false
    for (let r = cell.rowStart; r <= rEnd; r++) {
      for (let c = cell.colStart; c <= cEnd; c++) {
        if (occupancy[r - 1][c - 1]) return false
        occupancy[r - 1][c - 1] = true
      }
    }
  }
  for (let r = 0; r < CUSTOM_GRID_ROWS; r++) {
    for (let c = 0; c < CUSTOM_GRID_COLS; c++) {
      if (!occupancy[r][c]) return false
    }
  }
  return true
}

function validateCustomLayoutPresets(value: unknown): CustomLayoutPreset[] {
  if (!Array.isArray(value)) return []
  const seen = new Set<string>()
  const out: CustomLayoutPreset[] = []
  for (const item of value) {
    if (!item || typeof item !== 'object') continue
    const p = item as Partial<CustomLayoutPreset>
    if (typeof p.id !== 'string' || p.id.length === 0 || seen.has(p.id)) continue
    if (typeof p.name !== 'string') continue
    if (!isValidCustomLayoutCellList(p.cells)) continue
    seen.add(p.id)
    out.push({
      id: p.id,
      name: p.name,
      cells: p.cells as CustomLayoutCell[],
      createdAt: typeof p.createdAt === 'number' ? p.createdAt : Date.now()
    })
  }
  return out
}

const DEFAULT_PROMPT_PANEL_WIDTH = 320
const DEFAULT_PROMPT_EDITOR_HEIGHT = 350
const MIN_PROMPT_PANEL_WIDTH = 150
const MIN_PROMPT_EDITOR_HEIGHT = 100

/**
 * Scheduled task execution log entries (main process side type)
 */
interface ExecutionLogEntry {
  timestamp: number
  success: boolean
  targetTerminalIds: string[]
  error?: string | null
}

/**
 * Prompt scheduled task (main process side type)
 */
interface PromptSchedule {
  promptId: string
  tabId: string
  targetTerminalIds: string[]
  scheduleType: 'absolute' | 'relative' | 'recurring'
  absoluteTime?: number
  relativeOffsetMs?: number
  recurrence?: {
    startTime: number
    intervalMs: number
  }
  maxExecutions: number | null
  executedCount: number
  nextExecutionAt: number
  createdAt: number
  lastExecutedAt: number | null
  status: 'active' | 'paused' | 'completed' | 'failed'
  lastError?: string | null
  missedExecutions: number
  executionLog?: ExecutionLogEntry[]
}


/**
 * Generate unique ID
 */
function generateId(): string {
  return Date.now().toString(36) + Math.random().toString(36).substring(2, 9)
}

/**
 * Normalize Prompt timestamps by filling in lastUsedAt
 */
function normalizePromptTimestamp<T extends Prompt>(prompt: T): T {
  const fallback = typeof prompt.updatedAt === 'number'
    ? prompt.updatedAt
    : (typeof prompt.createdAt === 'number' ? prompt.createdAt : Date.now())
  return {
    ...prompt,
    lastUsedAt: typeof prompt.lastUsedAt === 'number' ? prompt.lastUsedAt : fallback
  }
}

function normalizePromptInputMode(value: unknown): 'canvas' | 'line' {
  return value === 'canvas' ? 'canvas' : 'line'
}

function validateUIPreferences(value: unknown): UIPreferences {
  const prefs = value && typeof value === 'object'
    ? (value as UIPreferences)
    : {}
  return {
    ...prefs,
    promptInputMode: normalizePromptInputMode(prefs.promptInputMode)
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
    layoutMode: { kind: 'preset', count: 1 },
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
    promptCleanup: {
      autoEnabled: false,
      autoKeepDays: 30,
      autoDeleteColored: false,
      lastAutoCleanupAt: null
    },
    lastFocusedTerminalId: null,
    projectEditorStates: {},
    promptSchedules: [],
    uiPreferences: { promptInputMode: 'line' },
    customLayoutPresets: [],
    updatedAt: Date.now()
  }
}

/**
 * Application state storage manager
 * Use JSON files stored in the userData directory
 */
class AppStateStorage {
  private storagePath: string
  private legacyConfigPath: string
  private legacyPromptsPath: string
  private state: AppState
  private persistVersion = 0
  private pendingPersist: Promise<boolean> | null = null
  private persistQueued = false

  constructor() {
    const userDataPath = app.getPath('userData')
    this.storagePath = join(userDataPath, 'app-state.json')
    this.legacyConfigPath = join(userDataPath, 'terminal-config.json')
    this.legacyPromptsPath = join(userDataPath, 'prompts.json')
    this.state = this.load()
  }

  /**
   * Load state data from file
   */
  private load(): AppState {
    try {
      // Load the new format first
      if (existsSync(this.storagePath)) {
        const data = readFileSync(this.storagePath, 'utf-8')
        const parsed = JSON.parse(data) as AppState
        const validated = this.validateState(parsed)
        this.logUIPreferences('load', validated.uiPreferences)
        return validated
      }

      // Try migrating from the old format
      return this.migrateFromLegacy()
    } catch (error) {
      console.error('Failed to load app state:', error)
      return createDefaultAppState()
    }
  }

  /**
   * Migrate data from old configuration files
   */
  private migrateFromLegacy(): AppState {
    console.log('Migrating from legacy config files...')

    let legacyConfig: LegacyTerminalConfig | null = null
    let legacyPrompts: Prompt[] = []

    // Read legacy terminal configuration
    try {
      if (existsSync(this.legacyConfigPath)) {
        const data = readFileSync(this.legacyConfigPath, 'utf-8')
        legacyConfig = JSON.parse(data) as LegacyTerminalConfig
      }
    } catch (error) {
      console.error('Failed to read legacy terminal config:', error)
    }

    // Read legacy Prompt data
    try {
      if (existsSync(this.legacyPromptsPath)) {
        const data = readFileSync(this.legacyPromptsPath, 'utf-8')
        legacyPrompts = JSON.parse(data) as Prompt[]
      }
    } catch (error) {
      console.error('Failed to read legacy prompts:', error)
    }

    // If there is no old data, return to the default state
    if (!legacyConfig && legacyPrompts.length === 0) {
      return createDefaultAppState()
    }

    // Separate pinned and non-pinned prompts
    const globalPrompts: GlobalPrompt[] = []
    const localPrompts: LocalPrompt[] = []

    legacyPrompts.forEach(prompt => {
      const normalized = normalizePromptTimestamp(prompt)
      if (prompt.pinned) {
        globalPrompts.push({ ...normalized, pinned: true } as GlobalPrompt)
      } else {
        localPrompts.push({ ...normalized, pinned: false } as LocalPrompt)
      }
    })

    // Create the first Tab
    const tabId = generateId()
    // Convert legacy terminals format (title → customName)
    const migratedTerminals: PersistedTerminalState[] =
      (legacyConfig?.terminals ?? []).map(t => ({
        id: t.id,
        // Extract custom name from title (or null if "Agent N" format)
        customName: /^Agent \d+$/.test(t.title) ? null : t.title,
        // Legacy terminal-config predates the manual-rename marker.
        manualNameRepoRoot: null,
        lastCwd: null
      }))

    const firstTab: TabState = {
      id: tabId,
      customName: null,
      createdAt: Date.now(),
      layoutMode: migrateLayoutMode(legacyConfig?.layoutMode),
      activePanel: legacyConfig?.activePanel ?? null,
      promptPanelWidth: legacyConfig?.promptPanelWidth ?? DEFAULT_PROMPT_PANEL_WIDTH,
      promptEditorHeight: DEFAULT_PROMPT_EDITOR_HEIGHT,
      activeTerminalId: legacyConfig?.activeTerminalId ?? null,
      terminals: migratedTerminals,
      localPrompts
    }

    const newState: AppState = {
      activeTabId: tabId,
      tabs: [firstTab],
      globalPrompts,
      promptCleanup: {
        autoEnabled: false,
        autoKeepDays: 30,
        autoDeleteColored: false,
        lastAutoCleanupAt: null
      },
      lastFocusedTerminalId: null,
      projectEditorStates: {},
      promptSchedules: [],
      uiPreferences: { promptInputMode: 'line' },
      customLayoutPresets: [],
      updatedAt: Date.now()
    }

    // Save the new state
    this.state = newState
    this.persist()

    // Back up old files
    this.backupLegacyFiles()

    console.log('Migration completed successfully')
    return newState
  }

  /**
   * Back up old configuration files
   */
  private backupLegacyFiles(): void {
    try {
      if (existsSync(this.legacyConfigPath)) {
        renameSync(this.legacyConfigPath, this.legacyConfigPath + '.backup')
      }
      if (existsSync(this.legacyPromptsPath)) {
        renameSync(this.legacyPromptsPath, this.legacyPromptsPath + '.backup')
      }
    } catch (error) {
      console.error('Failed to backup legacy files:', error)
    }
  }

  /**
   * Validate per-file state memory map from persisted state.
   */
  private validateFileStates(
    raw: unknown
  ): Record<string, import('../../src/types/tab').FileViewMemory> | undefined {
    if (!raw || typeof raw !== 'object') return undefined
    const result: Record<string, import('../../src/types/tab').FileViewMemory> = {}
    let count = 0
    for (const [key, val] of Object.entries(raw as Record<string, unknown>)) {
      if (!key || typeof key !== 'string') continue
      if (count >= 20) break // Cap persisted file states to prevent unbounded growth
      const entry = validateFileViewMemoryEntry(val)
      if (entry) {
        result[key] = entry
        count += 1
      }
    }
    return count > 0 ? result : undefined
  }

  /**
   * Validate state data to ensure all fields are present and valid
   */
  private validateState(state: Partial<AppState>): AppState {
    // Validate tabs
    let tabs: TabState[] = []
    if (Array.isArray(state.tabs) && state.tabs.length > 0) {
      tabs = state.tabs.map(tab => this.validateTab(tab))
    } else {
      const tabId = generateId()
      tabs = [createDefaultTabState(tabId)]
    }

    // Verify activeTabId
    let activeTabId = state.activeTabId
    if (!activeTabId || !tabs.find(t => t.id === activeTabId)) {
      activeTabId = tabs[0].id
    }

    // Verify globalPrompts
    const globalPrompts: GlobalPrompt[] = Array.isArray(state.globalPrompts)
      ? state.globalPrompts.map(p => ({ ...normalizePromptTimestamp(p), pinned: true } as GlobalPrompt))
      : []

    // Verify lastFocusedTerminalId
    const lastFocusedTerminalId = typeof state.lastFocusedTerminalId === 'string'
      ? state.lastFocusedTerminalId
      : null

    const projectEditorStates: Record<string, ProjectEditorState> = {}
    if (state.projectEditorStates && typeof state.projectEditorStates === 'object') {
      Object.entries(state.projectEditorStates as Record<string, ProjectEditorState>).forEach(([stateKey, value]) => {
        if (!stateKey) return
        const rootPath = typeof value?.rootPath === 'string' ? value.rootPath : null
        const activeFilePath = typeof value?.activeFilePath === 'string' ? value.activeFilePath : null
        const expandedDirs = Array.isArray(value?.expandedDirs)
          ? value.expandedDirs.filter((item): item is string => typeof item === 'string')
          : []
        const cursorLine = typeof value?.cursorLine === 'number' ? value.cursorLine : undefined
        const cursorColumn = typeof value?.cursorColumn === 'number' ? value.cursorColumn : undefined
        const savedAt = typeof value?.savedAt === 'number' ? value.savedAt : 0
        projectEditorStates[stateKey] = {
          rootPath,
          activeFilePath,
          expandedDirs,
          editorViewState: value?.editorViewState,
          cursorLine,
          cursorColumn,
          savedAt,
          // Quick file lists
          pinnedFiles: Array.isArray(value?.pinnedFiles)
            ? (value.pinnedFiles as unknown[]).filter((s): s is string => typeof s === 'string')
            : undefined,
          recentFiles: Array.isArray(value?.recentFiles)
            ? (value.recentFiles as unknown[]).filter((s): s is string => typeof s === 'string')
            : undefined,
          // UI layout state
          isPreviewOpen: typeof value?.isPreviewOpen === 'boolean' ? value.isPreviewOpen : undefined,
          isEditorVisible: typeof value?.isEditorVisible === 'boolean' ? value.isEditorVisible : undefined,
          isOutlineVisible: typeof value?.isOutlineVisible === 'boolean' ? value.isOutlineVisible : undefined,
          outlineTarget: value?.outlineTarget === 'editor' || value?.outlineTarget === 'preview'
            ? value.outlineTarget : undefined,
          fileTreeWidth: typeof value?.fileTreeWidth === 'number' ? value.fileTreeWidth : undefined,
          previewWidth: typeof value?.previewWidth === 'number' ? value.previewWidth : undefined,
          outlineWidth: typeof value?.outlineWidth === 'number' ? value.outlineWidth : undefined,
          modalWidth: typeof value?.modalWidth === 'number' ? value.modalWidth : undefined,
          modalHeight: typeof value?.modalHeight === 'number' ? value.modalHeight : undefined,
          // Scroll position memory
          previewScrollAnchor: validatePreviewScrollAnchor(value?.previewScrollAnchor),
          fileTreeScrollTop: typeof value?.fileTreeScrollTop === 'number' ? value.fileTreeScrollTop : undefined,
          outlineScrollTop: typeof value?.outlineScrollTop === 'number' ? value.outlineScrollTop : undefined,
          // Per-file state memory
          fileStates: this.validateFileStates(value?.fileStates)
        }
      })
    }

    const promptCleanup = this.validatePromptCleanup(state.promptCleanup)

    // Verify promptSchedules
    const promptSchedules = this.validatePromptSchedules(
      (state as AppState & { promptSchedules?: unknown }).promptSchedules
    )

    const uiPreferences = validateUIPreferences(state.uiPreferences)

    const customLayoutPresets = validateCustomLayoutPresets(
      (state as AppState & { customLayoutPresets?: unknown }).customLayoutPresets
    )

    return {
      activeTabId,
      tabs,
      globalPrompts,
      promptCleanup,
      lastFocusedTerminalId,
      projectEditorStates,
      promptSchedules,
      uiPreferences,
      customLayoutPresets,
      updatedAt: state.updatedAt ?? Date.now()
    }
  }

  /**
   * Normalise persisted terminal data (and migrate the legacy `title` format).
   * Delegates to the pure, electron-free `normalizePersistedTerminals` so the
   * `manualNameRepoRoot` round-trip is locked by a Node unit test and cannot be
   * silently re-stripped here.
   */
  private migrateTerminalData(rawTerminals: unknown): PersistedTerminalState[] {
    return normalizePersistedTerminals(rawTerminals)
  }

  /**
   * Validate single tab data
   */
  private validateTab(tab: Partial<TabState> & { name?: string; layoutMode?: unknown }): TabState {
    const promptPanelWidth = typeof tab.promptPanelWidth === 'number' && tab.promptPanelWidth >= MIN_PROMPT_PANEL_WIDTH
      ? tab.promptPanelWidth
      : DEFAULT_PROMPT_PANEL_WIDTH

    // Handle migration from older versions: if there is a name field but no customName, try to extract the custom name
    let customName: string | null = null
    if (tab.customName !== undefined) {
      customName = tab.customName
    } else if (tab.name) {
      // Extract the custom part from the old format name (if any)
      const match = tab.name.match(/^Tab \d+: (.+)$/)
      if (match) {
        customName = match[1]
      } else if (!/^Tab \d+$/.test(tab.name)) {
        // If not in "Tab N" format, the entire name is a custom name
        customName = tab.name
      }
    }

    const editorDraft = this.validateEditorDraft(tab.editorDraft)

    const promptEditorHeight = typeof tab.promptEditorHeight === 'number' && tab.promptEditorHeight >= MIN_PROMPT_EDITOR_HEIGHT
      ? tab.promptEditorHeight
      : Math.max(editorDraft?.height ?? 0, DEFAULT_PROMPT_EDITOR_HEIGHT)

    // Migrate terminal data: convert title to customName
    const terminals = this.migrateTerminalData(tab.terminals)

    return {
      id: tab.id ?? generateId(),
      customName,
      createdAt: tab.createdAt ?? Date.now(),
      layoutMode: migrateLayoutMode(tab.layoutMode),
      activePanel: tab.activePanel === 'prompt' ? 'prompt' : null,
      promptPanelWidth,
      promptEditorHeight,
      activeTerminalId: tab.activeTerminalId ?? null,
      terminals,
      localPrompts: Array.isArray(tab.localPrompts)
        ? tab.localPrompts.map(p => ({ ...normalizePromptTimestamp(p), pinned: false } as LocalPrompt))
        : [],
      editorDraft,
      activeSubpage: tab.activeSubpage === 'diff' || tab.activeSubpage === 'editor' || tab.activeSubpage === 'history'
        ? tab.activeSubpage
        : null,
      subpageTerminalId: typeof tab.subpageTerminalId === 'string' && tab.subpageTerminalId
        ? tab.subpageTerminalId
        : null
    }
  }

  /**
   * Validate editor draft data
   */
  private validateEditorDraft(draft: unknown): EditorDraft | undefined {
    if (!draft || typeof draft !== 'object') {
      return undefined
    }

    const d = draft as Partial<EditorDraft>

    // Validate required field types
    if (typeof d.title !== 'string' ||
        typeof d.content !== 'string' ||
        typeof d.height !== 'number' ||
        typeof d.savedAt !== 'number') {
      return undefined
    }

    // Don't save draft when empty content
    if (!d.title.trim() && !d.content.trim()) {
      return undefined
    }

    return {
      title: d.title,
      content: d.content,
      height: d.height,
      savedAt: d.savedAt
    }
  }

  /**
   * Validate Prompt cleanup configuration
   */
  private validatePromptCleanup(value: unknown): PromptCleanupConfig {
    const defaultConfig: PromptCleanupConfig = {
      autoEnabled: false,
      autoKeepDays: 30,
      autoDeleteColored: false,
      lastAutoCleanupAt: null
    }

    if (!value || typeof value !== 'object') {
      return defaultConfig
    }

    const v = value as Partial<PromptCleanupConfig>
    const autoKeepDays = typeof v.autoKeepDays === 'number' && v.autoKeepDays > 0
      ? Math.floor(v.autoKeepDays)
      : defaultConfig.autoKeepDays

    return {
      autoEnabled: !!v.autoEnabled,
      autoKeepDays,
      autoDeleteColored: !!v.autoDeleteColored,
      lastAutoCleanupAt: typeof v.lastAutoCleanupAt === 'number' ? v.lastAutoCleanupAt : null
    }
  }

  /**
   * Validate the Prompt schedule array
   */
  private validatePromptSchedules(value: unknown): PromptSchedule[] {
    if (!Array.isArray(value)) return []

    return value.filter((item: unknown): item is PromptSchedule => {
      if (!item || typeof item !== 'object') return false
      const s = item as Partial<PromptSchedule> & { recurrence?: Record<string, unknown> }
      if (typeof s.promptId !== 'string' || !s.promptId) return false
      if (typeof s.tabId !== 'string' || !s.tabId) return false
      if (!Array.isArray(s.targetTerminalIds) || s.targetTerminalIds.length === 0) return false
      if (!['absolute', 'relative', 'recurring'].includes(s.scheduleType as string)) return false
      if (!['active', 'paused', 'completed', 'failed'].includes(s.status as string)) return false
      if (typeof s.nextExecutionAt !== 'number') return false
      if (typeof s.createdAt !== 'number') return false
      if (typeof s.executedCount !== 'number') return false
      if (typeof s.missedExecutions !== 'number') return false
      // Verify and truncate executionLog
      if (s.executionLog !== undefined) {
        if (!Array.isArray(s.executionLog)) {
          (s as PromptSchedule).executionLog = []
        } else {
          // Keep the last 50 items
          (s as PromptSchedule).executionLog = s.executionLog
            .filter((entry: unknown) => {
              if (!entry || typeof entry !== 'object') return false
              const e = entry as Partial<ExecutionLogEntry>
              return typeof e.timestamp === 'number' && typeof e.success === 'boolean'
            })
            .slice(-50)
        }
      }
      return true
    })
  }

  /**
   * Save state data to file
   */
  private persist(): Promise<boolean> {
    if (this.pendingPersist) {
      this.persistQueued = true
      return this.pendingPersist
    }
    return this.startPersist()
  }

  private startPersist(): Promise<boolean> {
    const version = ++this.persistVersion
    const startedAt = Date.now()
    const snapshot = this.state
    const promise = appStateWorkerClient.saveSnapshot(this.storagePath, snapshot)
      .then((result) => {
        performanceTrace.record(PERF_TRACE_EVENT.MAIN_APP_STATE_SAVE, {
          version,
          bytes: result.bytes,
          workerDurationMs: result.durationMs,
          elapsedMs: Date.now() - startedAt
        })
        return true
      })
      .catch((error) => {
        console.error('Failed to save app state:', error)
        performanceTrace.record(PERF_TRACE_EVENT.MAIN_APP_STATE_SAVE_ERROR, {
          version,
          elapsedMs: Date.now() - startedAt,
          error: String(error)
        })
        // Worker save failed — most importantly on the 30 s request timeout
        // that a stalled libuv threadpool causes (worker threads share the
        // process-global pool, so the worker's async writeFile is just as
        // dead as the main thread's). Before this fallback, that path
        // silently LOST the state delta. Synchronous write on the main
        // thread bypasses the pool entirely; tmp + rename keeps the file
        // atomic against a crash mid-write.
        return this.persistSyncFallback(snapshot, version, String(error))
      })
      .finally(() => {
        if (this.pendingPersist === promise) {
          this.pendingPersist = null
        }
        if (this.persistQueued) {
          this.persistQueued = false
          void this.startPersist()
        }
      })
    this.pendingPersist = promise
    return promise
  }

  private persistSyncFallback(snapshot: unknown, version: number, workerError: string): boolean {
    try {
      const data = JSON.stringify(snapshot, null, 2)
      const tmpPath = `${this.storagePath}.tmp-${process.pid}`
      mkdirSync(dirname(this.storagePath), { recursive: true })
      writeFileSync(tmpPath, data, 'utf-8')
      renameSync(tmpPath, this.storagePath)
      performanceTrace.record(PERF_TRACE_EVENT.MAIN_APP_STATE_SYNC_FALLBACK, {
        version,
        bytes: Buffer.byteLength(data, 'utf-8'),
        workerError: workerError.slice(0, 256)
      })
      return true
    } catch (error) {
      console.error('App state sync fallback failed:', error)
      performanceTrace.record(PERF_TRACE_EVENT.MAIN_APP_STATE_SAVE_ERROR, {
        version,
        phase: 'sync-fallback',
        error: String(error)
      })
      return false
    }
  }

  /**
   * Log UIPreferences summary for diagnostics.
   * Helps verify that layout preferences survive save/load round-trips.
   */
  private logUIPreferences(phase: 'load' | 'save', prefs: UIPreferences | undefined): void {
    if (!prefs || Object.keys(prefs).length === 0) {
      console.log(`[AppState] ${phase}: uiPreferences is empty`)
      return
    }
    const summary: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(prefs)) {
      // Omit large nested objects, keep scalar values and simple shapes
      if (value !== undefined && value !== null) {
        summary[key] = typeof value === 'object' ? '{...}' : value
      }
    }
    console.log(`[AppState] ${phase}: uiPreferences =`, JSON.stringify(summary))
  }

  getTerminalLastCwd(terminalId: string): string | null {
    for (const tab of this.state.tabs) {
      const terminal = tab.terminals.find((item) => item.id === terminalId)
      if (terminal) {
        return terminal.lastCwd
      }
    }
    return null
  }

  setTerminalLastCwd(terminalId: string, cwd: string | null): boolean {
    return this.setTerminalLastCwds([{ terminalId, cwd }])
  }

  setTerminalLastCwds(updates: Array<{ terminalId: string; cwd: string | null }>): boolean {
    if (updates.length === 0) return false

    const normalizedUpdates = new Map<string, string | null>()
    updates.forEach(({ terminalId, cwd }) => {
      if (!terminalId) return
      const normalizedCwd = resolveExistingTerminalCwd(cwd)
      normalizedUpdates.set(terminalId, normalizedCwd)
    })

    if (normalizedUpdates.size === 0) return false

    let changed = false
    const nextTabs = this.state.tabs.map((tab) => {
      let tabChanged = false
      const terminals = tab.terminals.map((terminal) => {
        if (!normalizedUpdates.has(terminal.id)) {
          return terminal
        }
        const nextCwd = normalizedUpdates.get(terminal.id) ?? null
        if (terminal.lastCwd === nextCwd) {
          return terminal
        }
        changed = true
        tabChanged = true
        return {
          ...terminal,
          lastCwd: nextCwd
        }
      })
      return tabChanged ? { ...tab, terminals } : tab
    })

    if (!changed) return false

    this.state = {
      ...this.state,
      tabs: nextTabs,
      updatedAt: Date.now()
    }
    this.persist()
    return true
  }

  /**
   * Get current state
   */
  get(): AppState {
    if (typeof structuredClone === 'function') {
      return structuredClone(this.state)
    }
    return JSON.parse(JSON.stringify(this.state)) as AppState
  }

  /**
   * Save complete state
   */
  async save(state: AppState): Promise<boolean> {
    try {
      this.state = {
        ...this.validateState(state),
        updatedAt: Date.now()
      }
      this.logUIPreferences('save', this.state.uiPreferences)
      return await this.persist()
    } catch (error) {
      console.error('Failed to save app state:', error)
      return false
    }
  }

  async savePatch(patch: Partial<AppState>): Promise<boolean> {
    try {
      this.state = {
        ...this.validateState({
          ...this.state,
          ...patch
        }),
        updatedAt: Date.now()
      }
      return await this.persist()
    } catch (error) {
      console.error('Failed to patch app state:', error)
      return false
    }
  }

  async flush(): Promise<boolean> {
    while (this.pendingPersist || this.persistQueued) {
      if (this.pendingPersist) {
        await this.pendingPersist
      }
    }
    return await this.persist()
  }

  dispose(): void {
    appStateWorkerClient.dispose()
  }
}

// Singleton pattern
let instance: AppStateStorage | null = null

export function getAppStateStorage(): AppStateStorage {
  if (!instance) {
    instance = new AppStateStorage()
  }
  return instance
}

export type {
  AppState,
  TabState,
  LocalPrompt,
  GlobalPrompt
}

export {
  generateId,
  createDefaultTabState,
  createDefaultAppState
}
