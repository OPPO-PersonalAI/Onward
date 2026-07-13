/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

import { useState, useCallback, useMemo, useRef, useEffect, memo, startTransition } from 'react'
import { flushSync } from 'react-dom'
import { Prompt, PromptSendRecord } from '../../types/electron'
import type { TerminalBatchResult, TerminalInfo } from '../../types/prompt'
import type { EditorDraft, PromptCleanupConfig, PromptSchedule } from '../../types/tab.d.ts'
import { usePromptActions } from '../../contexts/PromptActionsContext'
import { buildAccelerator } from '../../utils/keyboard'
import { performanceTrace } from '../../utils/performance-trace'
import { perfTrace, perfTraceDiagnostic } from '../../utils/perf-trace'
import { PERF_TRACE_EVENT } from '../../utils/perf-trace-names'
import { decideDraftPreservation } from './prompt-draft-preservation'
import type { ScheduleNotification } from '../../hooks/useScheduleEngine'
import { PromptSearch } from './PromptSearch'
import { PromptList } from './PromptList'
import { PromptSender } from './PromptSender'
import { PromptEditorContextMenu, type ContextMenuSnapshot } from './PromptEditorContextMenu'
import { ScheduleConfigModal } from './ScheduleConfigModal'
import { ScheduleNotificationBar } from './ScheduleNotification'
import { useI18n } from '../../i18n/useI18n'
import { transformVirtualPaddingForSend, type ImportPrepareResult } from '../../utils/prompt-io'

// ONWARD_DISABLE_VIRTUAL_CURSOR=1 falls back to plain line-by-line input.
// Read once at module load — env vars are not watched at runtime.
const VIRTUAL_CURSOR_DISABLED = Boolean(window.electronAPI?.debug?.virtualCursorDisabled)

// Hard caps on virtual click target. A misclick at viewport-bottom of a very
// tall editor must not allocate MB of `' '.repeat(N)` padding into the
// textarea value. 1024 rows × 4096 cols is well past any human use case
// and still cheap to materialise.
const VIRTUAL_CURSOR_MAX_ROW = 1024
const VIRTUAL_CURSOR_MAX_COL = 4096

interface CellMetrics {
  cw: number
  lh: number
  padL: number
  padT: number
}

// Measure the textarea's effective monospace cell width / line height by
// rendering a hidden <span> with the same `font` / `letter-spacing` /
// `line-height` styles. Canvas `measureText` is rejected here: it ignores
// `letter-spacing` and the ligature substitutions Menlo/Monaco apply, so
// click coordinates would drift on long lines. The 80-cell sample averages
// out sub-pixel rounding.
function measureCellMetrics(ta: HTMLTextAreaElement): CellMetrics {
  const cs = getComputedStyle(ta)
  const probe = document.createElement('span')
  probe.style.cssText = `position:absolute;visibility:hidden;white-space:pre;font:${cs.font};letter-spacing:${cs.letterSpacing};line-height:${cs.lineHeight}`
  probe.textContent = 'M'.repeat(80)
  document.body.appendChild(probe)
  const rect = probe.getBoundingClientRect()
  document.body.removeChild(probe)
  return {
    cw: rect.width / 80,
    lh: parseFloat(cs.lineHeight) || rect.height,
    padL: parseFloat(cs.paddingLeft) || 0,
    padT: parseFloat(cs.paddingTop) || 0
  }
}
import { createTerminalBatchResult, hasDeliveredTerminals } from '../../utils/terminal-batch'
import { buildPromptTaskHistorySummary } from './promptTaskHistory'
import { PROMPT_COLORS, type PromptColor } from './prompt-colors'
import './PromptNotebook.css'

type PromptColorFilter = 'red' | 'yellow' | 'green' | null

interface PromptColorFilterStats {
  red: number
  yellow: number
  green: number
}

interface PromptTaskFilterOption {
  taskNumber: number
  count: number
}

interface PromptNotebookProps {
  terminals: TerminalInfo[]
  onSend: (terminalIds: string[], content: string) => Promise<TerminalBatchResult>
  onExecute: (terminalIds: string[]) => Promise<TerminalBatchResult>
  onSendAndExecute: (terminalIds: string[], content: string) => Promise<TerminalBatchResult>
  onTerminalRename: (id: string, newTitle: string) => void
  onChangeWorkDir: (terminalIds: string[], directory: string) => void
  width: number
  onWidthChange: (width: number) => void
  // Tab prompt related
  prompts: Prompt[]
  onAddPrompt: (prompt: Omit<Prompt, 'id' | 'createdAt' | 'updatedAt' | 'lastUsedAt'>) => void
  onAddPinnedPrompt: (prompt: Omit<Prompt, 'id' | 'createdAt' | 'updatedAt' | 'lastUsedAt' | 'pinned'>) => void
  onUpdatePrompt: (prompt: Prompt, preserveTimestamp?: boolean) => void
  onDeletePrompt: (promptId: string) => void
  onPinPrompt: (promptId: string) => void
  onUnpinPrompt: (promptId: string) => void
  onReorderPinnedPrompts: (dragId: string, targetId: string, position: 'before' | 'after') => void
  globalPromptIds: string[]
  promptCleanup: PromptCleanupConfig
  onExportAllPrompts: () => Promise<void> | void
  onPrepareImport: () => Promise<ImportPrepareResult>
  onExecuteImport: (globals: Prompt[], locals: Prompt[]) => void
  onTouchPromptLastUsed: (promptId: string) => void
  onCleanupPrompts: (options: { keepDays: number; deleteColored: boolean }) => void
  onUpdatePromptCleanup: (partial: Partial<PromptCleanupConfig>) => void
  promptEditorHeight: number
  onPromptEditorHeightChange: (height: number) => void
  // Per-tab prompt input mode toggle ('canvas' = click-anywhere virtual cursor,
  // 'line' = native line-by-line). Defaults to 'line' upstream.
  promptInputMode: 'canvas' | 'line'
  onPromptInputModeChange: (mode: 'canvas' | 'line') => void
  // Draft related
  editorDraft: EditorDraft | null
  onEditorDraftChange: (draft: EditorDraft | null) => void
  // Shortcut configuration
  addToHistoryShortcut: string | null
  // Hidden support
  hidden?: boolean
  // Related to scheduled tasks
  tabId: string
  scheduleMap: Map<string, PromptSchedule>
  scheduleNotifications: ScheduleNotification[]
  onAddSchedule: (schedule: Omit<PromptSchedule, 'executedCount' | 'createdAt' | 'lastExecutedAt' | 'missedExecutions'>) => void
  onUpdateSchedule: (schedule: PromptSchedule) => void
  onDeleteSchedule: (promptId: string) => void
  onDismissScheduleNotification: (promptId: string, type: ScheduleNotification['type']) => void
  onRetrySchedule: (promptId: string) => void
  /**
   * Resolve the latest Git branch for a terminal id (cached transient info).
   * Used by the prompt editor's right-click context menu to offer
   * "insert current branch name". Optional — when missing the menu item is
   * rendered disabled.
   */
  getTerminalBranch?: (terminalId: string) => string | null
}

interface DeleteConfirmState {
  isOpen: boolean
  promptId: string
  promptTitle: string
}

interface ImportConfirmState {
  isOpen: boolean
  globals: Prompt[]
  locals: Prompt[]
  duplicateCount: number
}

interface RetentionConfirmState {
  isOpen: boolean
  mode: 'manual' | 'auto'
  keepDays: number
  isCustomDays: boolean
  customDaysInput: string
  deleteColored: boolean | null
}

export const PromptNotebook = memo(function PromptNotebook({
  terminals,
  onSend,
  onExecute,
  onSendAndExecute,
  onTerminalRename,
  onChangeWorkDir,
  width,
  onWidthChange,
  prompts,
  onAddPrompt,
  onAddPinnedPrompt,
  onUpdatePrompt,
  onDeletePrompt,
  onPinPrompt,
  onUnpinPrompt,
  onReorderPinnedPrompts,
  globalPromptIds,
  promptCleanup,
  onExportAllPrompts,
  onPrepareImport,
  onExecuteImport,
  onTouchPromptLastUsed,
  onCleanupPrompts,
  onUpdatePromptCleanup,
  promptEditorHeight,
  onPromptEditorHeightChange,
  promptInputMode,
  onPromptInputModeChange,
  editorDraft,
  onEditorDraftChange,
  addToHistoryShortcut,
  hidden = false,
  tabId,
  scheduleMap,
  scheduleNotifications,
  onAddSchedule,
  onUpdateSchedule,
  onDeleteSchedule,
  onDismissScheduleNotification,
  onRetrySchedule,
  getTerminalBranch
}: PromptNotebookProps) {
  const { t, locale } = useI18n()
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [searchKeyword, setSearchKeyword] = useState('')
  const [filterEnabled, setFilterEnabled] = useState(false)
  const [targetsEnabled, setTargetsEnabled] = useState(false)
  const [activeColorFilter, setActiveColorFilter] = useState<PromptColorFilter>(null)
  const [activeTaskFilter, setActiveTaskFilter] = useState<number | null>(null)
  const [saveMessage, setSaveMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null)
  const saveMessageTimerRef = useRef<number>(0)

  const showSaveMessage = useCallback((msg: { type: 'success' | 'error'; text: string }) => {
    setSaveMessage(msg)
    if (saveMessageTimerRef.current) {
      window.clearTimeout(saveMessageTimerRef.current)
    }
    saveMessageTimerRef.current = window.setTimeout(() => {
      setSaveMessage(null)
    }, 2000)
  }, [])

  // Draft auto-preserve feedback floats over the prompt editor itself: the
  // search-box status slot truncates when the notebook panel is narrow
  // (user-resizable width), while the editor is exactly where the user is
  // looking when the double-click fires.
  const [draftToast, setDraftToast] = useState<string | null>(null)
  const draftToastTimerRef = useRef<number>(0)
  const showDraftToast = useCallback((text: string) => {
    setDraftToast(text)
    if (draftToastTimerRef.current) {
      window.clearTimeout(draftToastTimerRef.current)
    }
    draftToastTimerRef.current = window.setTimeout(() => {
      setDraftToast(null)
    }, 2000)
  }, [])
  useEffect(() => {
    return () => {
      if (draftToastTimerRef.current) {
        window.clearTimeout(draftToastTimerRef.current)
      }
    }
  }, [])

  useEffect(() => {
    return () => {
      if (saveMessageTimerRef.current) {
        window.clearTimeout(saveMessageTimerRef.current)
      }
    }
  }, [])

  const writeClipboardText = useCallback(async (text: string) => {
    if (window.electronAPI?.clipboard?.writeText) {
      await window.electronAPI.clipboard.writeText(text)
      return
    }
    await navigator.clipboard.writeText(text)
  }, [])
  const [editingPrompt, setEditingPrompt] = useState<Prompt | null>(null)
  const [appendContent, setAppendContent] = useState('')
  const [editorContent, setEditorContent] = useState('')
  const [editorTitle, setEditorTitle] = useState('')
  // Refs that track the latest editor values so the debug API effect
  // does not need editorContent / editorTitle in its dependency array.
  const editorContentRef = useRef(editorContent)
  const editorTitleRef = useRef(editorTitle)
  const lastEditorSendToTaskRef = useRef<{ content: string; terminalId: string } | null>(null)
  editorContentRef.current = editorContent
  editorTitleRef.current = editorTitle
  const [clearEditorTrigger, setClearEditorTrigger] = useState(0)
  const [deleteConfirm, setDeleteConfirm] = useState<DeleteConfirmState>({
    isOpen: false,
    promptId: '',
    promptTitle: ''
  })
  const [importConfirm, setImportConfirm] = useState<ImportConfirmState>({
    isOpen: false,
    globals: [],
    locals: [],
    duplicateCount: 0
  })
  const [retentionConfirm, setRetentionConfirm] = useState<RetentionConfirmState>({
    isOpen: false,
    mode: 'manual',
    keepDays: 7,
    isCustomDays: false,
    customDaysInput: '',
    deleteColored: null
  })

  // Schedule config modal state
  const [scheduleModalPrompt, setScheduleModalPrompt] = useState<Prompt | null>(null)

  // Send history viewer state
  const [sendHistoryPrompt, setSendHistoryPrompt] = useState<Prompt | null>(null)

  const recordPromptEdit = useCallback((field: 'title' | 'content', value: string) => {
    if (!performanceTrace.enabled) return
    performanceTrace.recordInstant('ui.prompt.edit', {
      field,
      mode: editingPrompt ? 'edit' : 'new',
      ...performanceTrace.summarizeText('payload', value)
    }, 'prompt')
  }, [editingPrompt])

  const handleEditorContentChange = useCallback((nextContent: string) => {
    setEditorContent(nextContent)
    recordPromptEdit('content', nextContent)
  }, [recordPromptEdit])

  const handleEditorTitleChange = useCallback((nextTitle: string) => {
    setEditorTitle(nextTitle)
    recordPromptEdit('title', nextTitle)
  }, [recordPromptEdit])

  // Get the currently selected Prompt
  const selectedPrompt = useMemo(() => {
    return prompts.find(p => p.id === selectedId) || null
  }, [prompts, selectedId])

  const promptTaskHistory = useMemo(
    () => buildPromptTaskHistorySummary(prompts, terminals.length),
    [prompts, terminals.length]
  )

  const promptMatchesTaskFilter = useCallback((promptId: string, taskNumber: number) => {
    return promptTaskHistory.promptTaskNumbers.get(promptId)?.includes(taskNumber) ?? false
  }, [promptTaskHistory])

  const searchMatchedPrompts = useMemo(() => {
    if (!searchKeyword.trim()) return prompts
    const keyword = searchKeyword.toLowerCase()
    return prompts.filter(p =>
      p.title.toLowerCase().includes(keyword) ||
      p.content.toLowerCase().includes(keyword)
    )
  }, [prompts, searchKeyword])

  const filteredPrompts = useMemo(() => {
    return searchMatchedPrompts.filter((prompt) => {
      if (filterEnabled && activeColorFilter && prompt.color !== activeColorFilter) {
        return false
      }
      if (filterEnabled && activeTaskFilter !== null && !promptMatchesTaskFilter(prompt.id, activeTaskFilter)) {
        return false
      }
      return true
    })
  }, [searchMatchedPrompts, filterEnabled, activeColorFilter, activeTaskFilter, promptMatchesTaskFilter])

  const colorFilterStats = useMemo<PromptColorFilterStats>(() => {
    const stats: PromptColorFilterStats = { red: 0, yellow: 0, green: 0 }
    searchMatchedPrompts.forEach((prompt) => {
      if (filterEnabled && activeTaskFilter !== null && !promptMatchesTaskFilter(prompt.id, activeTaskFilter)) {
        return
      }
      if (prompt.color === 'red') stats.red += 1
      if (prompt.color === 'yellow') stats.yellow += 1
      if (prompt.color === 'green') stats.green += 1
    })
    return stats
  }, [searchMatchedPrompts, filterEnabled, activeTaskFilter, promptMatchesTaskFilter])

  const taskFilterOptions = useMemo<PromptTaskFilterOption[]>(() => {
    return promptTaskHistory.allTaskNumbers.map((taskNumber) => {
      let count = 0
      searchMatchedPrompts.forEach((prompt) => {
        if (filterEnabled && activeColorFilter && prompt.color !== activeColorFilter) {
          return
        }
        if (promptMatchesTaskFilter(prompt.id, taskNumber)) {
          count += 1
        }
      })
      return { taskNumber, count }
    })
  }, [promptTaskHistory.allTaskNumbers, searchMatchedPrompts, filterEnabled, activeColorFilter, promptMatchesTaskFilter])

  const setFilterEnabledWithReset = useCallback((nextEnabled: boolean) => {
    setFilterEnabled(nextEnabled)
    if (!nextEnabled) {
      setActiveColorFilter(null)
      setActiveTaskFilter(null)
    }
  }, [])

  // Sync selection and edit state after cleanup
  useEffect(() => {
    if (selectedId && !prompts.some(p => p.id === selectedId)) {
      setSelectedId(null)
    }
    if (editingPrompt && !prompts.some(p => p.id === editingPrompt.id)) {
      setEditingPrompt(null)
    }
  }, [prompts, selectedId, editingPrompt])

  // Debug API (only exposed in automated testing mode)
  useEffect(() => {
    if (!window.electronAPI?.debug?.autotest) return

    const mapScheduleToDebug = (s: PromptSchedule) => ({
      promptId: s.promptId,
      tabId: s.tabId,
      targetTerminalIds: s.targetTerminalIds,
      scheduleType: s.scheduleType,
      status: s.status,
      nextExecutionAt: s.nextExecutionAt,
      executedCount: s.executedCount,
      executionLogCount: (s.executionLog ?? []).length,
      lastError: s.lastError ?? null,
      missedExecutions: s.missedExecutions,
      absoluteTime: s.absoluteTime ?? null,
      relativeOffsetMs: s.relativeOffsetMs ?? null,
      maxExecutions: s.maxExecutions,
      recurrence: s.recurrence ?? null,
      executionLog: s.executionLog ?? []
    })

    const api = {
      getPromptCount: () => prompts.length,
      getPrompts: () => prompts.map(p => ({
        id: p.id,
        title: p.title,
        content: p.content,
        pinned: p.pinned,
        color: p.color ?? undefined,
        lastUsedAt: p.lastUsedAt,
        taskNumbers: promptTaskHistory.promptTaskNumbers.get(p.id) ?? [],
        sendHistoryCount: p.sendHistory?.length ?? 0
      })),
      getVisiblePromptItems: () => filteredPrompts.map(p => ({
        id: p.id,
        title: p.title,
        color: p.color ?? undefined,
        taskNumbers: promptTaskHistory.promptTaskNumbers.get(p.id) ?? []
      })),
      getSelectedPromptId: () => selectedId,
      getLastEditorSendToTask: () => lastEditorSendToTaskRef.current,
      selectPrompt: (promptId: string) => {
        if (!prompts.some(prompt => prompt.id === promptId)) return false
        setSelectedId(promptId)
        return true
      },
      setPromptColor: (promptId: string, color: PromptColorFilter) => {
        if (color !== null && color !== 'red' && color !== 'yellow' && color !== 'green') {
          return false
        }
        const prompt = prompts.find(item => item.id === promptId)
        if (!prompt) return false
        onUpdatePrompt({ ...prompt, color }, true)
        return true
      },
      copyPrompt: async (promptId: string) => {
        const prompt = prompts.find(item => item.id === promptId)
        if (!prompt) return false
        try {
          await writeClipboardText(prompt.content)
          showSaveMessage({ type: 'success', text: t('promptNotebook.copySuccess') })
          return true
        } catch (error) {
          console.error('Failed to copy Prompt content:', error)
          showSaveMessage({ type: 'error', text: t('promptNotebook.copyFailed') })
          return false
        }
      },
      getColorFilterState: () => ({
        enabled: filterEnabled,
        activeColor: activeColorFilter,
        counts: colorFilterStats
      }),
      setColorFilter: (color: PromptColorFilter) => {
        if (color !== null && color !== 'red' && color !== 'yellow' && color !== 'green') {
          return false
        }
        if (color !== null) {
          setFilterEnabled(true)
        }
        setActiveColorFilter(color)
        return true
      },
      getTaskFilterState: () => ({
        enabled: filterEnabled,
        activeTaskNumber: activeTaskFilter,
        options: taskFilterOptions
      }),
      setTaskFilter: (taskNumber: number | null) => {
        if (taskNumber !== null && !Number.isFinite(taskNumber)) return false
        if (taskNumber !== null) {
          setFilterEnabled(true)
        }
        setActiveTaskFilter(taskNumber)
        return true
      },
      isFilterEnabled: () => filterEnabled,
      setFilterEnabled: (nextEnabled: boolean) => {
        setFilterEnabledWithReset(nextEnabled)
        return true
      },
      isTargetsEnabled: () => targetsEnabled,
      setTargetsEnabled: (nextEnabled: boolean) => {
        setTargetsEnabled(nextEnabled)
        return true
      },
      reorderPinnedPrompts: (dragId: string, targetId: string, position: 'before' | 'after') => {
        if (!prompts.some(prompt => prompt.id === dragId && prompt.pinned)) return false
        if (!prompts.some(prompt => prompt.id === targetId && prompt.pinned)) return false
        onReorderPinnedPrompts(dragId, targetId, position)
        return true
      },
      getCleanupConfig: () => ({
        autoEnabled: promptCleanup.autoEnabled,
        autoKeepDays: promptCleanup.autoKeepDays,
        autoDeleteColored: promptCleanup.autoDeleteColored,
        lastAutoCleanupAt: promptCleanup.lastAutoCleanupAt
      }),
      getEditorContent: () => editorContentRef.current,
      getEditorHeight: () => {
        const editor = document.querySelector('.prompt-notebook:not(.prompt-notebook-hidden) .prompt-editor') as HTMLElement | null
        if (!editor) return null
        return editor.getBoundingClientRect().height
      },
      getPersistedEditorHeight: () => promptEditorHeight,
      setEditorContent: (content: string) => {
        // Two things must happen for a send to durably see this content:
        //  1. Drive the editor's REAL local-content state (PromptEditorWithAppend),
        //     which syncs up to editorContent. Without this the editor's debounced
        //     sync fires with its still-empty local content and re-clears
        //     editorContent. The old synthetic-DOM-input approach did not reliably
        //     fire the canvas/line editor's onChange, so the local content stayed ''.
        //  2. Set the editorContent STATE — but deliberately NOT editorContentRef.
        //     getEditorContent reads the ref (synced from editorContent on EVERY
        //     render), so leaving the ref alone makes `editorReady` gate on the
        //     COMMITTED state. Previously the ref was set synchronously here, so
        //     editorReady passed BEFORE React committed the re-render, and the test
        //     clicked send while the send-path callback (applySuccessSideEffects)
        //     still closed over editorContent='' → it skipped the history add
        //     (PL-05 createdPrompt: null). Gating on the commit hands the send a
        //     fresh callback that sees the real content.
        const control = (window as unknown as {
          __onwardPromptEditorContentControl?: { setContent: (v: string) => void }
        }).__onwardPromptEditorContentControl
        control?.setContent(content)
        setEditorContent(content)
      },
      submitEditor: () => {
        if (!editorContentRef.current.trim()) return
        onAddPrompt({
          title: editorTitleRef.current.trim(),
          content: editorContentRef.current.trim(),
          pinned: false,
          color: undefined
        })
      },
      // Scheduled task Debug API
      getSchedules: () => [...scheduleMap.values()].map(mapScheduleToDebug),
      getScheduleForPrompt: (promptId: string) => {
        const s = scheduleMap.get(promptId)
        return s ? mapScheduleToDebug(s) : null
      },
      createSchedule: (promptId: string, type: 'relative' | 'absolute' | 'recurring', options?: {
        offsetMs?: number
        time?: number
        recurrence?: { startTime: number; intervalMs: number }
      }) => {
        if (terminals.length === 0) return false
        const now = Date.now()
        const offsetMs = options?.offsetMs ?? 5 * 60 * 1000
        const absTime = options?.time ?? now + 60 * 60 * 1000
        const rec = options?.recurrence ?? { startTime: now + 60 * 60 * 1000, intervalMs: 60 * 60 * 1000 }

        let nextExec = now
        if (type === 'relative') nextExec = now + offsetMs
        else if (type === 'absolute') nextExec = absTime
        else {
          // Calculate next execution time based on interval pattern
          if (rec.startTime > now) {
            nextExec = rec.startTime
          } else {
            const elapsed = now - rec.startTime
            const periods = Math.ceil(elapsed / rec.intervalMs)
            nextExec = rec.startTime + periods * rec.intervalMs
          }
        }

        onAddSchedule({
          promptId,
          tabId,
          targetTerminalIds: [terminals[0].id],
          scheduleType: type,
          relativeOffsetMs: type === 'relative' ? offsetMs : undefined,
          absoluteTime: type === 'absolute' ? absTime : undefined,
          recurrence: type === 'recurring' ? rec : undefined,
          maxExecutions: type === 'recurring' ? null : 1,
          nextExecutionAt: nextExec,
          status: 'active',
          lastError: null
        })
        return true
      },
      pauseSchedule: (promptId: string) => {
        const s = scheduleMap.get(promptId)
        if (!s || s.status !== 'active') return false
        onUpdateSchedule({ ...s, status: 'paused' })
        return true
      },
      resumeSchedule: (promptId: string) => {
        const s = scheduleMap.get(promptId)
        if (!s || s.status !== 'paused') return false
        onUpdateSchedule({ ...s, status: 'active' })
        return true
      },
      deleteSchedule: (promptId: string) => {
        const s = scheduleMap.get(promptId)
        if (!s) return false
        onDeleteSchedule(promptId)
        return true
      }
    }
    ;(window as any).__onwardPromptNotebookDebug = api
    return () => {
      if ((window as any).__onwardPromptNotebookDebug === api) {
        delete (window as any).__onwardPromptNotebookDebug
      }
    }
  }, [
    prompts,
    promptCleanup,
    promptEditorHeight,
    onAddPrompt,
    scheduleMap,
    tabId,
    terminals,
    onAddSchedule,
    onUpdateSchedule,
    onDeleteSchedule,
    onReorderPinnedPrompts,
    promptTaskHistory,
    filteredPrompts,
    selectedId,
    onUpdatePrompt,
    showSaveMessage,
    writeClipboardText,
    t,
    filterEnabled,
    targetsEnabled,
    activeColorFilter,
    colorFilterStats,
    activeTaskFilter,
    taskFilterOptions,
    setFilterEnabledWithReset
  ])

  // Get the content to be sent: use the editor content first, otherwise use the selected Prompt content
  const editorContentForSend = useMemo(() => {
    return transformVirtualPaddingForSend(editorContent)
  }, [editorContent])

  const contentToSend = useMemo(() => {
    return editorContentForSend || selectedPrompt?.content || ''
  }, [editorContentForSend, selectedPrompt])

  const hasEditorContent = useMemo(() => {
    return !!editorContentForSend
  }, [editorContentForSend])

  const saveEditorContentAsNewPrompt = useCallback((color?: Prompt['color'], sendRecords?: PromptSendRecord[]) => {
    const sendContent = transformVirtualPaddingForSend(editorContent)
    if (!sendContent) return
    onAddPrompt({
      title: editorTitle.trim(),
      content: sendContent,
      pinned: false,
      color: color ?? undefined,
      sendHistory: sendRecords
    })
  }, [editorContent, editorTitle, onAddPrompt])

  // Create new Prompt (commit)
  const handleSubmit = useCallback((title: string, content: string, color?: 'red' | 'yellow' | 'green' | null) => {
    onAddPrompt({
      title,
      content,
      pinned: false,
      color: color || undefined
    })
    setEditingPrompt(null)
  }, [onAddPrompt])

  // Delete Prompt (show confirmation box)
  const handleDelete = useCallback((id: string) => {
    const prompt = prompts.find(p => p.id === id)
    setDeleteConfirm({
      isOpen: true,
      promptId: id,
      promptTitle: prompt?.title || t('promptNotebook.untitledPrompt')
    })
  }, [prompts, t])

  const handleConfirmDelete = useCallback(() => {
    onDeletePrompt(deleteConfirm.promptId)

    if (selectedId === deleteConfirm.promptId) {
      setSelectedId(null)
    }
    if (editingPrompt?.id === deleteConfirm.promptId) {
      setEditingPrompt(null)
    }

    setDeleteConfirm({ isOpen: false, promptId: '', promptTitle: '' })
  }, [deleteConfirm, onDeletePrompt, selectedId, editingPrompt])

  const handleCancelDelete = useCallback(() => {
    setDeleteConfirm({ isOpen: false, promptId: '', promptTitle: '' })
  }, [])

  const resetRetentionConfirm = useCallback(() => {
    setRetentionConfirm({
      isOpen: false,
      mode: 'manual',
      keepDays: 7,
      isCustomDays: false,
      customDaysInput: '',
      deleteColored: null
    })
  }, [])

  const openRetentionConfirm = useCallback((options: { mode: 'manual' | 'auto'; keepDays: number; isCustomDays?: boolean }) => {
    setRetentionConfirm({
      isOpen: true,
      mode: options.mode,
      keepDays: options.keepDays,
      isCustomDays: !!options.isCustomDays,
      customDaysInput: '',
      deleteColored: null
    })
  }, [])

  const handleRetentionKeepDays = useCallback((days: number) => {
    openRetentionConfirm({ mode: 'manual', keepDays: days, isCustomDays: false })
  }, [openRetentionConfirm])

  const handleRetentionKeepCustom = useCallback(() => {
    openRetentionConfirm({ mode: 'manual', keepDays: 0, isCustomDays: true })
  }, [openRetentionConfirm])

  const handleToggleAutoCleanup = useCallback((nextEnabled: boolean) => {
    if (!nextEnabled) {
      onUpdatePromptCleanup({ autoEnabled: false })
      return
    }
    openRetentionConfirm({ mode: 'auto', keepDays: 30, isCustomDays: false })
  }, [onUpdatePromptCleanup, openRetentionConfirm])

  const handleExportAllPrompts = useCallback(() => {
    void onExportAllPrompts()
  }, [onExportAllPrompts])

  const handleImportPrompts = useCallback(async () => {
    const result = await onPrepareImport()
    // User canceled file selection — show nothing
    if (!result.success && !result.error) return
    if (!result.success) {
      showSaveMessage({ type: 'error', text: result.error || t('promptNotebook.import.failed') })
      return
    }
    const total = result.globals.length + result.locals.length
    if (total === 0 && result.duplicateCount === 0) {
      showSaveMessage({ type: 'success', text: t('promptNotebook.import.emptyFile') })
      return
    }
    if (total === 0 && result.duplicateCount > 0) {
      showSaveMessage({ type: 'success', text: t('promptNotebook.import.allDuplicates', { count: result.duplicateCount }) })
      return
    }
    // Has importable content — open confirmation dialog
    setImportConfirm({
      isOpen: true,
      globals: result.globals,
      locals: result.locals,
      duplicateCount: result.duplicateCount
    })
  }, [onPrepareImport, showSaveMessage, t])

  const handleConfirmImport = useCallback(() => {
    const { globals, locals, duplicateCount } = importConfirm
    onExecuteImport(globals, locals)
    setImportConfirm({ isOpen: false, globals: [], locals: [], duplicateCount: 0 })
    const translationKey = duplicateCount > 0
      ? 'promptNotebook.import.successWithSkipped'
      : 'promptNotebook.import.success'
    showSaveMessage({
      type: 'success',
      text: t(translationKey, {
        global: globals.length,
        local: locals.length,
        skipped: duplicateCount
      })
    })
  }, [importConfirm, onExecuteImport, showSaveMessage, t])

  const handleCancelImport = useCallback(() => {
    setImportConfirm({ isOpen: false, globals: [], locals: [], duplicateCount: 0 })
  }, [])

  const handleConfirmRetention = useCallback(() => {
    const resolvedKeepDays = retentionConfirm.isCustomDays
      ? Number.parseInt(retentionConfirm.customDaysInput, 10)
      : retentionConfirm.keepDays

    if (!Number.isFinite(resolvedKeepDays) || resolvedKeepDays <= 0) {
      return
    }
    if (retentionConfirm.deleteColored === null) {
      return
    }

    if (retentionConfirm.mode === 'manual') {
      onCleanupPrompts({
        keepDays: resolvedKeepDays,
        deleteColored: retentionConfirm.deleteColored
      })
    } else {
      const now = Date.now()
      onCleanupPrompts({
        keepDays: 30,
        deleteColored: retentionConfirm.deleteColored
      })
      onUpdatePromptCleanup({
        autoEnabled: true,
        autoKeepDays: 30,
        autoDeleteColored: retentionConfirm.deleteColored,
        lastAutoCleanupAt: now
      })
    }

    resetRetentionConfirm()
  }, [retentionConfirm, onCleanupPrompts, onUpdatePromptCleanup, resetRetentionConfirm])

  const handleCancelRetention = useCallback(() => {
    resetRetentionConfirm()
  }, [resetRetentionConfirm])

  // Select Prompt
  const handleSelect = useCallback((id: string) => {
    setSelectedId(id)
  }, [])

  // Double click to edit — but never at the cost of the user's current
  // input: auto-preserve non-empty, modified editor content into history
  // FIRST, then load the double-clicked prompt. Skips the save when the
  // editor still holds the untouched original of the entry being edited
  // (browsing history by double-click must not duplicate entries).
  const handleDoubleClick = useCallback((prompt: Prompt) => {
    const normalizedContent = transformVirtualPaddingForSend(editorContentRef.current)
    const decision = decideDraftPreservation({
      normalizedContent,
      title: editorTitleRef.current,
      editingOriginal: editingPrompt
        ? {
            normalizedContent: transformVirtualPaddingForSend(editingPrompt.content),
            title: editingPrompt.title
          }
        : null
    })
    if (decision.preserve) {
      onAddPrompt({
        title: editorTitleRef.current.trim(),
        content: normalizedContent,
        pinned: false,
        color: editingPrompt?.color ?? undefined
      })
      showDraftToast(t('promptNotebook.draftPreserved'))
    }
    perfTraceDiagnostic(PERF_TRACE_EVENT.RENDERER_PROMPT_DRAFT_AUTO_PRESERVED, {
      preserved: decision.preserve,
      reason: decision.reason,
      contentLen: normalizedContent.length,
      hadEditingSource: Boolean(editingPrompt)
    })
    setEditingPrompt(prompt)
  }, [editingPrompt, onAddPrompt, showDraftToast, t])

  // Cancel edit
  const handleCancelEdit = useCallback(() => {
    setEditingPrompt(null)
  }, [])

  // Toggle pin state
  const handleTogglePin = useCallback((id: string) => {
    const isGlobal = globalPromptIds.includes(id)
    if (isGlobal) {
      onUnpinPrompt(id)
    } else {
      onPinPrompt(id)
    }
  }, [globalPromptIds, onPinPrompt, onUnpinPrompt])

  // Append content to the input box
  const handleAppend = useCallback((prompt: Prompt) => {
    setAppendContent(prev => prev ? `${prev}\n\n${prompt.content}` : prompt.content)
    onTouchPromptLastUsed(prompt.id)
  }, [onTouchPromptLastUsed])

  // Toggle colors (preserves timestamp, does not affect sorting)
  const handleColorChange = useCallback((id: string, color: 'red' | 'yellow' | 'green' | null) => {
    const prompt = prompts.find(p => p.id === id)
    if (!prompt) return
    onUpdatePrompt({ ...prompt, color }, true)
  }, [prompts, onUpdatePrompt])

  const handleToggleColorFilter = useCallback((color: Exclude<PromptColorFilter, null>) => {
    setFilterEnabled(true)
    setActiveColorFilter((prev) => prev === color ? null : color)
  }, [])

  const handleToggleTaskFilter = useCallback((taskNumber: number) => {
    setFilterEnabled(true)
    setActiveTaskFilter((prev) => prev === taskNumber ? null : taskNumber)
  }, [])

  const handleToggleFilterEnabled = useCallback((nextEnabled: boolean) => {
    setFilterEnabledWithReset(nextEnabled)
  }, [setFilterEnabledWithReset])

  const handleToggleTargetsEnabled = useCallback((nextEnabled: boolean) => {
    setTargetsEnabled(nextEnabled)
  }, [])

  const handleCopyPrompt = useCallback(async (prompt: Prompt) => {
    try {
      await writeClipboardText(prompt.content)
      showSaveMessage({ type: 'success', text: t('promptNotebook.copySuccess') })
    } catch (error) {
      console.error('Failed to copy Prompt content:', error)
      showSaveMessage({ type: 'error', text: t('promptNotebook.copyFailed') })
    }
  }, [showSaveMessage, t, writeClipboardText])

  // Scheduled task operations
  const handleSetSchedule = useCallback((prompt: Prompt) => {
    setScheduleModalPrompt(prompt)
  }, [])

  const handleEditSchedule = useCallback((prompt: Prompt) => {
    setScheduleModalPrompt(prompt)
  }, [])

  const handleCancelSchedule = useCallback((promptId: string) => {
    onDeleteSchedule(promptId)
  }, [onDeleteSchedule])

  const handleScheduleConfirm = useCallback((schedule: Omit<PromptSchedule, 'executedCount' | 'createdAt' | 'lastExecutedAt' | 'missedExecutions'>) => {
    const existing = scheduleMap.get(schedule.promptId)
    if (existing) {
      onUpdateSchedule({
        ...existing,
        ...schedule,
        // Keep runtime statistics while editing to avoid clearing history
        executedCount: existing.executedCount,
        createdAt: existing.createdAt,
        lastExecutedAt: existing.lastExecutedAt,
        missedExecutions: existing.missedExecutions,
        executionLog: existing.executionLog
      })
    } else {
      onAddSchedule(schedule)
    }
    setScheduleModalPrompt(null)
  }, [onAddSchedule, onUpdateSchedule, scheduleMap])

  const handleViewSendHistory = useCallback((prompt: Prompt) => {
    setSendHistoryPrompt(prompt)
  }, [])

  const handleAppendContentUsed = useCallback(() => {
    setAppendContent('')
  }, [])

  const handleSaveSuccess = useCallback(() => {
    showSaveMessage({ type: 'success', text: t('promptNotebook.saved') })
  }, [showSaveMessage, t])

  const handleScheduleCancel = useCallback(() => {
    setScheduleModalPrompt(null)
  }, [])

  const handlePauseSchedule = useCallback((promptId: string) => {
    const schedule = scheduleMap.get(promptId)
    if (schedule && schedule.status === 'active') {
      onUpdateSchedule({ ...schedule, status: 'paused' })
    }
  }, [scheduleMap, onUpdateSchedule])

  const handleResumeSchedule = useCallback((promptId: string) => {
    const schedule = scheduleMap.get(promptId)
    if (schedule && schedule.status === 'paused') {
      onUpdateSchedule({ ...schedule, status: 'active' })
    }
  }, [scheduleMap, onUpdateSchedule])

  const buildSendRecords = useCallback((
    terminalIds: string[],
    action: PromptSendRecord['action'],
    result?: PromptSendRecord['result']
  ): PromptSendRecord[] => {
    const now = Date.now()
    return terminalIds.map(tid => {
      const terminal = terminals.find(t => t.id === tid)
      return {
        taskId: tid,
        taskName: terminal?.title || tid,
        sentAt: now,
        action,
        result
      }
    })
  }, [terminals])

  const applySuccessSideEffects = useCallback((result: TerminalBatchResult, sendRecords?: PromptSendRecord[]): TerminalBatchResult => {
    if (!hasDeliveredTerminals(result)) {
      return result
    }

    // Save to history when the content is not empty (the editing state is saved as a new entry by default)
    if (hasEditorContent) {
      saveEditorContentAsNewPrompt(editingPrompt?.color, sendRecords)
    } else if (selectedPrompt) {
      onTouchPromptLastUsed(selectedPrompt.id)
      // Record sending history to existing prompt
      if (sendRecords && sendRecords.length > 0) {
        const existing = selectedPrompt.sendHistory ?? []
        const merged = [...sendRecords, ...existing].slice(0, 100)
        onUpdatePrompt({ ...selectedPrompt, sendHistory: merged }, true)
      }
    }

    // Clear editor and drafts
    setClearEditorTrigger(prev => prev + 1)
    onEditorDraftChange(null)

    // Exit editing state
    if (editingPrompt) {
      setEditingPrompt(null)
    }

    setSelectedId(null)

    return result
  }, [editingPrompt, hasEditorContent, onEditorDraftChange, onTouchPromptLastUsed, onUpdatePrompt, saveEditorContentAsNewPrompt, selectedPrompt])

  // Send to terminal (wrapper, add save and clear logic)
  const handleSendToTerminal = useCallback(async (terminalIds: string[], content: string): Promise<TerminalBatchResult> => {
    const fallback = createTerminalBatchResult({ failedIds: [...terminalIds] })
    try {
      const rawResult = await onSend(terminalIds, content)
      const sendRecords = rawResult.successIds.length > 0
        ? buildSendRecords(rawResult.successIds, 'send')
        : undefined
      return applySuccessSideEffects(rawResult, sendRecords)
    } catch (error) {
      console.error('Prompt send failed:', error)
      return fallback
    }
  }, [onSend, applySuccessSideEffects, buildSendRecords])

  // Execution (wrapping, adding save and clear logic)
  const handleExecuteTerminal = useCallback(async (terminalIds: string[]): Promise<TerminalBatchResult> => {
    const fallback = createTerminalBatchResult({ failedIds: [...terminalIds] })
    try {
      return applySuccessSideEffects(await onExecute(terminalIds))
    } catch (error) {
      console.error('Prompt execute failed:', error)
      return fallback
    }
  }, [onExecute, applySuccessSideEffects])

  // Send-and-execute triggered from the prompt context menu. Unlike the main
  // sender, this must NOT clear the editor, drop the current selection, or
  // exit editing state — the user may have unrelated content in the editor.
  // It still records send history and touches lastUsedAt on the target prompt.
  const runContextMenuSendAndExecute = useCallback(async (prompt: Prompt, terminalIds: string[]) => {
    if (terminalIds.length === 0) return
    try {
      const rawResult = await onSendAndExecute(terminalIds, prompt.content)
      if (!hasDeliveredTerminals(rawResult)) return
      const sendRecords = [
        ...buildSendRecords(rawResult.successIds, 'sendAndExecute', 'executed'),
        ...buildSendRecords(rawResult.sentOnlyIds, 'sendAndExecute', 'sent-only')
      ]
      // Merge lastUsedAt refresh and sendHistory into a single updatePrompt to
      // avoid a stale-object overwrite: touchPromptLastUsed + updatePrompt in
      // two hops would race on the same prev snapshot, and the second hop —
      // carrying the closure's old lastUsedAt under preserveTimestamp — wins.
      const existingHistory = prompt.sendHistory ?? []
      const mergedHistory = sendRecords.length > 0
        ? [...sendRecords, ...existingHistory].slice(0, 100)
        : existingHistory
      onUpdatePrompt(
        { ...prompt, lastUsedAt: Date.now(), sendHistory: mergedHistory },
        true
      )
    } catch (error) {
      console.error('Prompt context-menu send-and-execute failed:', error)
    }
  }, [onSendAndExecute, onUpdatePrompt, buildSendRecords])

  const handleContextMenuSendAndExecute = useCallback((prompt: Prompt, terminalId: string) => {
    void runContextMenuSendAndExecute(prompt, [terminalId])
  }, [runContextMenuSendAndExecute])

  const handleContextMenuSendAndExecuteAll = useCallback((prompt: Prompt) => {
    void runContextMenuSendAndExecute(prompt, terminals.map(t => t.id))
  }, [runContextMenuSendAndExecute, terminals])

  // Send and execute (wrapper, add save and clear logic)
  const handleSendAndExecute = useCallback(async (terminalIds: string[], content: string): Promise<TerminalBatchResult> => {
    const fallback = createTerminalBatchResult({ failedIds: [...terminalIds] })
    try {
      const rawResult = await onSendAndExecute(terminalIds, content)
      const sendRecords = [
        ...buildSendRecords(rawResult.successIds, 'sendAndExecute', 'executed'),
        ...buildSendRecords(rawResult.sentOnlyIds, 'sendAndExecute', 'sent-only')
      ]
      return applySuccessSideEffects(rawResult, sendRecords)
    } catch (error) {
      console.error('Prompt send and execute failed:', error)
      return fallback
    }
  }, [onSendAndExecute, applySuccessSideEffects, buildSendRecords])

  // Save the editor's right-click selection as a brand-new pinned prompt.
  // Derive a sensible title from the first non-empty line, capped to 40
  // chars; the full text becomes the prompt body. This is the reverse of
  // "Append to editor" — closing the loop between the editor and the pinned
  // list without forcing the user to leave the editor surface.
  const handleSavePinnedFromEditor = useCallback((selection: string) => {
    const trimmed = selection.trim()
    if (!trimmed) return
    const firstLine = trimmed.split('\n').find(line => line.trim().length > 0) ?? trimmed
    const compact = firstLine.replace(/\s+/g, ' ').trim()
    const title = compact.length > 40 ? `${compact.slice(0, 39)}…` : compact
    onAddPinnedPrompt({ title, content: trimmed, color: undefined })
    showSaveMessage({ type: 'success', text: t('promptNotebook.editor.contextMenu.savedAsPin') })
  }, [onAddPinnedPrompt, showSaveMessage, t])

  // Right-click "Send to Task" from inside the editor (not a saved Prompt).
  // The plain text path; does not annotate any Prompt's sendHistory.
  const handleSendEditorToTask = useCallback((content: string, terminalId: string) => {
    const sendContent = transformVirtualPaddingForSend(content)
    if (!sendContent) return
    lastEditorSendToTaskRef.current = { content: sendContent, terminalId }
    void handleSendAndExecute([terminalId], sendContent)
  }, [handleSendAndExecute])

  // Keep the global pinned Prompt order from Prompt History. Users can
  // reorder that list manually, and the editor import menu mirrors it.
  const pinnedPrompts = useMemo(() => {
    return prompts.filter(p => p.pinned)
  }, [prompts])

  const activeTerminal = useMemo(() => {
    return terminals.find(t => t.isActive) ?? terminals[0] ?? null
  }, [terminals])

  const editorCwd = activeTerminal?.lastCwd ?? null
  const editorTaskTitle = activeTerminal?.title ?? null
  const editorBranch = activeTerminal && getTerminalBranch
    ? getTerminalBranch(activeTerminal.id)
    : null

  // Drag to adjust width
  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    const startX = e.clientX
    const startWidth = width

    const handleMouseMove = (e: MouseEvent) => {
      const delta = e.clientX - startX
      const newWidth = Math.max(200, startWidth + delta)
      onWidthChange(newWidth)
    }

    const handleMouseUp = () => {
      document.removeEventListener('mousemove', handleMouseMove)
      document.removeEventListener('mouseup', handleMouseUp)
      document.body.classList.remove('resizing-prompt-panel')
    }

    document.body.classList.add('resizing-prompt-panel')
    document.addEventListener('mousemove', handleMouseMove)
    document.addEventListener('mouseup', handleMouseUp)
  }, [width, onWidthChange])

  // Delete confirmation box shortcut
  useEffect(() => {
    if (hidden || !deleteConfirm.isOpen) return

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'y' || e.key === 'Y') {
        e.preventDefault()
        handleConfirmDelete()
      } else if (e.key === 'n' || e.key === 'N' || e.key === 'Escape') {
        e.preventDefault()
        handleCancelDelete()
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [hidden, deleteConfirm.isOpen, handleConfirmDelete, handleCancelDelete])

  // Import confirmation dialog shortcut
  useEffect(() => {
    if (hidden || !importConfirm.isOpen) return
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        handleCancelImport()
      } else if (e.key === 'Enter') {
        e.preventDefault()
        handleConfirmImport()
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [hidden, importConfirm.isOpen, handleConfirmImport, handleCancelImport])

  const retentionKeepDays = useMemo(() => {
    if (!retentionConfirm.isCustomDays) {
      return retentionConfirm.keepDays
    }
    return Number.parseInt(retentionConfirm.customDaysInput, 10)
  }, [retentionConfirm.customDaysInput, retentionConfirm.isCustomDays, retentionConfirm.keepDays])

  const canConfirmRetention = useMemo(() => {
    return Number.isFinite(retentionKeepDays) && retentionKeepDays > 0 && retentionConfirm.deleteColored !== null
  }, [retentionKeepDays, retentionConfirm.deleteColored])

  const showRetentionDaysError = useMemo(() => {
    if (!retentionConfirm.isCustomDays) return false
    if (!retentionConfirm.customDaysInput.trim()) return false
    return !Number.isFinite(retentionKeepDays) || retentionKeepDays <= 0
  }, [retentionConfirm.customDaysInput, retentionConfirm.isCustomDays, retentionKeepDays])

  // Clear confirmation box shortcut
  useEffect(() => {
    if (!retentionConfirm.isOpen) return

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        handleCancelRetention()
        return
      }
      if (e.key === 'Enter' && canConfirmRetention) {
        e.preventDefault()
        handleConfirmRetention()
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [retentionConfirm.isOpen, handleCancelRetention, handleConfirmRetention, canConfirmRetention])

  return (
    <>
      <div className={`prompt-notebook${hidden ? ' prompt-notebook-hidden' : ''}`} style={{ width }}>
        <div
          className="prompt-notebook-resizer"
          onMouseDown={handleMouseDown}
        />

        {/* search box */}
        <PromptSearch
          value={searchKeyword}
          onChange={setSearchKeyword}
          saveMessage={saveMessage}
        />

        {/* Scheduled task notification */}
        <ScheduleNotificationBar
          notifications={scheduleNotifications}
          onDismiss={onDismissScheduleNotification}
          onRetry={onRetrySchedule}
        />

        {/* History list */}
        <PromptList
          prompts={filteredPrompts}
          selectedId={selectedId}
          searchKeyword={searchKeyword}
          filterEnabled={filterEnabled}
          targetsEnabled={targetsEnabled}
          activeColorFilter={activeColorFilter}
          colorFilterStats={colorFilterStats}
          activeTaskFilter={activeTaskFilter}
          taskFilterOptions={taskFilterOptions}
          promptTaskNumbers={promptTaskHistory.promptTaskNumbers}
          onSelect={handleSelect}
          onDoubleClick={handleDoubleClick}
          onDelete={handleDelete}
          onTogglePin={handleTogglePin}
          onAppend={handleAppend}
          onColorChange={handleColorChange}
          onToggleFilterEnabled={handleToggleFilterEnabled}
          onToggleTargetsEnabled={handleToggleTargetsEnabled}
          onToggleColorFilter={handleToggleColorFilter}
          onToggleTaskFilter={handleToggleTaskFilter}
          globalPromptIds={globalPromptIds}
          onReorderPinned={onReorderPinnedPrompts}
          autoCleanupEnabled={promptCleanup.autoEnabled}
          onExportAllPrompts={handleExportAllPrompts}
          onImportPrompts={handleImportPrompts}
          onRetentionKeepDays={handleRetentionKeepDays}
          onRetentionKeepCustom={handleRetentionKeepCustom}
          onToggleAutoCleanup={handleToggleAutoCleanup}
          scheduleMap={scheduleMap}
          onSetSchedule={handleSetSchedule}
          onEditSchedule={handleEditSchedule}
          onCancelSchedule={handleCancelSchedule}
          onPauseSchedule={handlePauseSchedule}
          onResumeSchedule={handleResumeSchedule}
          onViewSendHistory={handleViewSendHistory}
          onCopyPrompt={handleCopyPrompt}
          terminals={terminals}
          onSendAndExecuteToTask={handleContextMenuSendAndExecute}
          onSendAndExecuteToAllTasks={handleContextMenuSendAndExecuteAll}
        />

        {/* input area */}
        <PromptEditorWithAppend
          draftToast={draftToast}
          onSubmit={handleSubmit}
          onUpdatePrompt={onUpdatePrompt}
          editingPrompt={editingPrompt}
          onCancelEdit={handleCancelEdit}
          appendContent={appendContent}
          onAppendContentUsed={handleAppendContentUsed}
          onContentChange={handleEditorContentChange}
          onTitleChange={handleEditorTitleChange}
          clearTrigger={clearEditorTrigger}
          promptEditorHeight={promptEditorHeight}
          onPromptEditorHeightChange={onPromptEditorHeightChange}
          promptInputMode={promptInputMode}
          onPromptInputModeChange={onPromptInputModeChange}
          editorDraft={editorDraft}
          onEditorDraftChange={onEditorDraftChange}
          addToHistoryShortcut={addToHistoryShortcut}
          hidden={hidden}
          onSaveSuccess={handleSaveSuccess}
          ctxPinnedPrompts={pinnedPrompts}
          ctxTerminals={terminals}
          ctxAppendPromptToContent={handleAppend}
          ctxSaveSelectionAsPinned={handleSavePinnedFromEditor}
          ctxSendToTask={handleSendEditorToTask}
          ctxCurrentCwd={editorCwd}
          ctxCurrentBranch={editorBranch}
          ctxCurrentTaskTitle={editorTaskTitle}
        />

        {/* Send control area */}
        <PromptSender
          terminals={terminals}
          promptContent={contentToSend}
          onSend={handleSendToTerminal}
          onExecute={handleExecuteTerminal}
          onSendAndExecute={handleSendAndExecute}
          onTerminalRename={onTerminalRename}
          onChangeWorkDir={onChangeWorkDir}
        />
      </div>

      {/* Delete confirmation dialog */}
      {!hidden && deleteConfirm.isOpen && (
        <div className="confirm-dialog-overlay" onClick={handleCancelDelete}>
          <div className="confirm-dialog" onClick={(e) => e.stopPropagation()}>
            <div className="confirm-dialog-title">{t('promptNotebook.deleteTitle')}</div>
            <div className="confirm-dialog-message">
              {t('promptNotebook.deleteMessage', { title: deleteConfirm.promptTitle })}
            </div>
            <div className="confirm-dialog-actions">
              <button className="confirm-dialog-btn cancel" onClick={handleCancelDelete}>
                {t('promptNotebook.cancelN')}
              </button>
              <button className="confirm-dialog-btn confirm" onClick={handleConfirmDelete} autoFocus>
                {t('promptNotebook.confirmY')}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Import confirmation dialog */}
      {!hidden && importConfirm.isOpen && (
        <div className="confirm-dialog-overlay" onClick={handleCancelImport}>
          <div className="confirm-dialog" onClick={(e) => e.stopPropagation()}>
            <div className="confirm-dialog-title">{t('promptNotebook.importConfirm.title')}</div>
            <div className="confirm-dialog-message">
              <div style={{ marginBottom: 8 }}>{t('promptNotebook.importConfirm.aboutToImport')}</div>
              <div style={{ lineHeight: 1.8 }}>
                {importConfirm.globals.length > 0 && (
                  <div>• {t('promptNotebook.importConfirm.globalCount', { count: importConfirm.globals.length })}</div>
                )}
                {importConfirm.locals.length > 0 && (
                  <div>• {t('promptNotebook.importConfirm.localCount', { count: importConfirm.locals.length })}</div>
                )}
                {importConfirm.duplicateCount > 0 && (
                  <div style={{ opacity: 0.7 }}>• {t('promptNotebook.importConfirm.skippedDuplicates', { count: importConfirm.duplicateCount })}</div>
                )}
              </div>
            </div>
            <div className="confirm-dialog-actions">
              <button className="confirm-dialog-btn cancel" onClick={handleCancelImport}>
                {t('promptNotebook.importConfirm.cancel')}
              </button>
              <button className="confirm-dialog-btn confirm" onClick={handleConfirmImport} autoFocus>
                {t('promptNotebook.importConfirm.confirm')}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Scheduled configuration Modal */}
      {!hidden && scheduleModalPrompt && (
        <ScheduleConfigModal
          prompt={scheduleModalPrompt}
          terminals={terminals}
          tabId={tabId}
          existingSchedule={scheduleMap.get(scheduleModalPrompt.id) ?? null}
          onConfirm={handleScheduleConfirm}
          onCancel={handleScheduleCancel}
        />
      )}

      {retentionConfirm.isOpen && (
        <div className="confirm-dialog-overlay" onClick={handleCancelRetention}>
          <div className="confirm-dialog prompt-retention-dialog" onClick={(e) => e.stopPropagation()}>
            <div className="confirm-dialog-title">
              {retentionConfirm.mode === 'auto' ? t('promptNotebook.retention.autoTitle') : t('promptNotebook.retention.manualTitle')}
            </div>
            <div className="confirm-dialog-message">
              {retentionConfirm.mode === 'auto'
                ? t('promptNotebook.retention.autoMessage')
                : t('promptNotebook.retention.manualMessage')}
            </div>

            <div className="prompt-retention-days-row">
              {retentionConfirm.isCustomDays ? (
                <>
                  <span className="prompt-retention-days-label">{t('promptNotebook.retention.keepRecent')}</span>
                  <input
                    type="number"
                    min={1}
                    step={1}
                    className="prompt-retention-days-input"
                    value={retentionConfirm.customDaysInput}
                    onChange={(e) => {
                      const value = e.target.value
                      setRetentionConfirm(prev => ({ ...prev, customDaysInput: value }))
                    }}
                    placeholder={t('promptNotebook.retention.daysPlaceholder')}
                  />
                  <span className="prompt-retention-days-suffix">{t('promptNotebook.retention.daysSuffix')}</span>
                </>
              ) : (
                <span className="prompt-retention-days-text">
                  {t('promptNotebook.retention.keepRecentText', { days: retentionConfirm.mode === 'auto' ? 30 : retentionConfirm.keepDays })}
                </span>
              )}
            </div>
            {showRetentionDaysError && (
              <div className="prompt-retention-days-error">{t('promptNotebook.retention.invalidDays')}</div>
            )}

            <div className="prompt-retention-color-group">
              <div className="prompt-retention-color-title">{t('promptNotebook.retention.colorHandling')}</div>
              <div className="prompt-retention-color-options">
                <button
                  className={`prompt-retention-color-option ${retentionConfirm.deleteColored === true ? 'selected' : ''}`}
                  onClick={() => setRetentionConfirm(prev => ({ ...prev, deleteColored: true }))}
                >
                  {t('promptNotebook.retention.deleteColored')}
                </button>
                <button
                  className={`prompt-retention-color-option ${retentionConfirm.deleteColored === false ? 'selected' : ''}`}
                  onClick={() => setRetentionConfirm(prev => ({ ...prev, deleteColored: false }))}
                >
                  {t('promptNotebook.retention.keepColored')}
                </button>
              </div>
            </div>

            <div className="confirm-dialog-actions">
              <button className="confirm-dialog-btn cancel" onClick={handleCancelRetention}>
                {t('promptNotebook.retention.cancel')}
              </button>
              <button
                className="confirm-dialog-btn confirm"
                onClick={handleConfirmRetention}
                disabled={!canConfirmRetention}
              >
                {t('promptNotebook.retention.confirm')}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Send record panel */}
      {!hidden && sendHistoryPrompt && (
        <div className="prompt-send-history-overlay" onClick={() => setSendHistoryPrompt(null)}>
          <div className="prompt-send-history-panel" onClick={(e) => e.stopPropagation()}>
            <div className="prompt-send-history-header">
              <span className="prompt-send-history-title">
                {t('promptNotebook.sendHistory.title', { title: sendHistoryPrompt.title || t('promptNotebook.untitledPrompt') })}
              </span>
              <button className="prompt-send-history-close" onClick={() => setSendHistoryPrompt(null)}>
                {t('promptNotebook.sendHistory.close')}
              </button>
            </div>
            <div className="prompt-send-history-body">
              {(!sendHistoryPrompt.sendHistory || sendHistoryPrompt.sendHistory.length === 0) ? (
                <div className="prompt-send-history-empty">{t('promptNotebook.sendHistory.empty')}</div>
              ) : (
                sendHistoryPrompt.sendHistory.map((record, index) => (
                  <div key={index} className="prompt-send-history-item">
                    <span className="prompt-send-history-task">{record.taskName}</span>
                    <span className={`prompt-send-history-action ${record.action}`}>
                      {record.action === 'send'
                        ? t('promptNotebook.sendHistory.action.send')
                        : record.action === 'execute'
                          ? t('promptNotebook.sendHistory.action.execute')
                          : record.result === 'sent-only'
                            ? t('promptNotebook.sendHistory.action.sendAndExecuteSentOnly')
                            : t('promptNotebook.sendHistory.action.sendAndExecute')}
                    </span>
                    <span className="prompt-send-history-time">
                      {new Date(record.sentAt).toLocaleString(locale === 'zh-CN' ? 'zh-CN' : 'en-US', {
                        month: '2-digit', day: '2-digit',
                        hour: '2-digit', minute: '2-digit', second: '2-digit'
                      })}
                    </span>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
      )}
    </>
  )
})

// Editor wrapper component with additional functionality
const PromptEditorWithAppend = memo(function PromptEditorWithAppend({
  draftToast,
  onSubmit,
  onUpdatePrompt,
  editingPrompt,
  onCancelEdit,
  appendContent,
  onAppendContentUsed,
  onContentChange,
  onTitleChange,
  clearTrigger,
  promptEditorHeight,
  onPromptEditorHeightChange,
  promptInputMode,
  onPromptInputModeChange,
  editorDraft,
  onEditorDraftChange,
  addToHistoryShortcut,
  hidden = false,
  onSaveSuccess,
  ctxPinnedPrompts,
  ctxTerminals,
  ctxAppendPromptToContent,
  ctxSaveSelectionAsPinned,
  ctxSendToTask,
  ctxCurrentCwd,
  ctxCurrentBranch,
  ctxCurrentTaskTitle
}: {
  draftToast: string | null
  onSubmit: (title: string, content: string, color?: 'red' | 'yellow' | 'green' | null) => void
  onUpdatePrompt: (prompt: Prompt, preserveTimestamp?: boolean) => void
  editingPrompt: Prompt | null
  onCancelEdit: () => void
  appendContent: string
  onAppendContentUsed: () => void
  onContentChange: (content: string) => void
  onTitleChange: (title: string) => void
  clearTrigger: number
  promptEditorHeight: number
  onPromptEditorHeightChange: (height: number) => void
  promptInputMode: 'canvas' | 'line'
  onPromptInputModeChange: (mode: 'canvas' | 'line') => void
  editorDraft: EditorDraft | null
  onEditorDraftChange: (draft: EditorDraft | null) => void
  addToHistoryShortcut: string | null
  hidden?: boolean
  onSaveSuccess?: () => void
  ctxPinnedPrompts: Prompt[]
  ctxTerminals: TerminalInfo[]
  ctxAppendPromptToContent: (prompt: Prompt) => void
  ctxSaveSelectionAsPinned: (selection: string) => void
  ctxSendToTask: (content: string, terminalId: string) => void
  ctxCurrentCwd: string | null
  ctxCurrentBranch: string | null
  ctxCurrentTaskTitle: string | null
}) {
  const { t } = useI18n()
  const [title, setTitle] = useState('')
  const [content, setContent] = useState('')
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; snapshot: ContextMenuSnapshot; canUndo: boolean } | null>(null)
  // Undo stack scoped to right-click context-menu mutations only. Native
  // textarea Cmd+Z continues to handle keystroke-level history; this stack
  // captures atomic menu operations (paste / cut / format / clear / etc.)
  // so a single Undo click reverts the whole menu action. Bounded at 50 to
  // keep memory predictable in long sessions.
  const HISTORY_LIMIT = 50
  const historyRef = useRef<Array<{ value: string; selectionStart: number; selectionEnd: number }>>([])
  const MIN_EDITOR_HEIGHT = 180
  const [height, setHeight] = useState(() => Math.max(promptEditorHeight, MIN_EDITOR_HEIGHT))
  const heightRef = useRef(height)
  const isDraggingRef = useRef(false)
  const hasMountedRef = useRef(false)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  // Tracks IME composition (Chinese / Japanese / Korean input) so the virtual
  // cursor mousedown handler can short-circuit and avoid mutating value /
  // selection mid-composition, which would otherwise abort the IME session.
  const isComposingRef = useRef(false)
  // Cached cell metrics for the virtual-cursor click → (row, col) calculation.
  // Invalidated on resize / font change. null = recompute on next click.
  const metricsRef = useRef<CellMetrics | null>(null)
  // Mode-selector dropdown state — controls the popup that lets the user
  // toggle between Canvas (virtual cursor) and Line (native textarea) input.
  const [isModeMenuOpen, setIsModeMenuOpen] = useState(false)
  const modeSelectorRef = useRef<HTMLDivElement>(null)
  const { registerFocusEditor, registerSubmitEditor } = usePromptActions()
  const platform = window.electronAPI?.platform ?? 'darwin'
  const isMac = platform === 'darwin'
  const saveShortcutLabel = isMac ? '⌘S' : 'Ctrl+S'
  const saveAsShortcutLabel = isMac ? '⌘⇧S' : 'Ctrl+Shift+S'
  const cancelShortcutLabel = 'Esc'
  const saveShortcut = 'CommandOrControl+S'
  const saveAsShortcut = 'CommandOrControl+Shift+S'
  const cancelShortcut = 'Escape'

  const matchesAccelerator = useCallback((accelerator: string, expected: string) => {
    if (!accelerator) return false
    const normalize = (value: string) => value
      .split('+')
      .map(part => (part === 'Ctrl' ? 'Control' : part))
      .join('+')
    return normalize(accelerator) === normalize(expected)
  }, [])

  useEffect(() => {
    heightRef.current = height
  }, [height])

  // Silently restore drafts on first mount
  useEffect(() => {
    if (!hasMountedRef.current && editorDraft) {
      setTitle(editorDraft.title)
      setContent(editorDraft.content)
      setHeight(Math.max(promptEditorHeight, editorDraft.height, MIN_EDITOR_HEIGHT))
      hasMountedRef.current = true
    } else if (!hasMountedRef.current) {
      hasMountedRef.current = true
    }
  }, [editorDraft, promptEditorHeight])

  useEffect(() => {
    if (isDraggingRef.current) return
    const normalizedHeight = Math.max(promptEditorHeight, MIN_EDITOR_HEIGHT)
    heightRef.current = normalizedHeight
    setHeight((prev) => (prev === normalizedHeight ? prev : normalizedHeight))
  }, [promptEditorHeight])

  // Populate content when edit mode is activated
  useEffect(() => {
    if (editingPrompt) {
      setTitle(editingPrompt.title)
      setContent(editingPrompt.content)
    }
  }, [editingPrompt])

  // Autotest-only: expose this editor's REAL local-content setter. The send path
  // reads PromptNotebook.editorContent, which this component owns and syncs up
  // (debounced below). The notebook debug API's setEditorContent used a synthetic
  // DOM `input` event + a mirror ref; the input event does NOT reliably fire this
  // editor's onChange (it renders differently in 'canvas' vs 'line' mode), so the
  // local content stayed '' and the debounced sync OVERWROTE editorContent back to
  // '' before the send read it (PL-05 createdPrompt: null). Driving setContent here
  // injects into the true source so the value survives the sync. Autotest-gated, so
  // it never registers in user builds.
  useEffect(() => {
    if (!window.electronAPI?.debug?.autotest) return
    const control = {
      setContent: (value: string) => {
        hasMountedRef.current = true
        setContent(value)
      }
    }
    ;(window as unknown as { __onwardPromptEditorContentControl?: typeof control }).__onwardPromptEditorContentControl = control
    return () => {
      const w = window as unknown as { __onwardPromptEditorContentControl?: typeof control }
      if (w.__onwardPromptEditorContentControl === control) {
        delete w.__onwardPromptEditorContentControl
      }
    }
  }, [])

  // Debounce parent notifications (content, title, draft) to avoid
  // re-rendering the entire PromptNotebook tree on every keystroke.
  // Local state (content / title) stays instant for responsive typing.
  const parentNotifyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    if (!hasMountedRef.current) return

    if (parentNotifyTimerRef.current) {
      clearTimeout(parentNotifyTimerRef.current)
    }

    parentNotifyTimerRef.current = setTimeout(() => {
      startTransition(() => {
        onContentChange(content)
        onTitleChange(title)

        if (!title.trim() && !content.trim()) {
          onEditorDraftChange(null)
        } else {
          onEditorDraftChange({
            title,
            content,
            height,
            savedAt: Date.now()
          })
        }
      })
    }, 300)

    return () => {
      if (parentNotifyTimerRef.current) {
        clearTimeout(parentNotifyTimerRef.current)
      }
    }
  }, [title, content, height, onContentChange, onTitleChange, onEditorDraftChange])

  // Handle additional content
  useEffect(() => {
    if (appendContent) {
      setContent(prev => prev ? `${prev}\n\n${appendContent}` : appendContent)
      onAppendContentUsed()
    }
  }, [appendContent, onAppendContentUsed])

  // Handle drag to adjust height
  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    isDraggingRef.current = true
    const startY = e.clientY
    const startHeight = height

    const handleMouseMove = (e: MouseEvent) => {
      if (!isDraggingRef.current) return
      const delta = startY - e.clientY
      const newHeight = Math.max(MIN_EDITOR_HEIGHT, startHeight + delta)
      heightRef.current = newHeight
      setHeight(newHeight)
    }

    const handleMouseUp = () => {
      isDraggingRef.current = false
      onPromptEditorHeightChange(heightRef.current)
      // Resizing changes the textarea's content area but in current CSS the
      // monospace font / line-height / paddings remain identical. Cell width
      // is unaffected, so metricsRef stays valid. Invalidate defensively in
      // case future CSS makes the dimensions font-relative.
      metricsRef.current = null
      document.removeEventListener('mousemove', handleMouseMove)
      document.removeEventListener('mouseup', handleMouseUp)
      document.body.classList.remove('resizing-editor-height')
    }

    document.body.classList.add('resizing-editor-height')
    document.addEventListener('mousemove', handleMouseMove)
    document.addEventListener('mouseup', handleMouseUp)
  }, [height, onPromptEditorHeightChange])

  // Save processing (two strategies). The persisted content goes through
  // transformVirtualPaddingForSend so virtual-cursor placements with no input
  // ("ghost" padding) don't bleed into saved prompts. Leading-column padding
  // is preserved as intentional indentation.
  const handleSave = useCallback((saveAsNew: boolean) => {
    const sendContent = transformVirtualPaddingForSend(content)
    if (!sendContent || !editingPrompt) return

    if (saveAsNew) {
      // Create new entry (inherit colors)
      onSubmit(title.trim(), sendContent, editingPrompt.color)
    } else {
      // Update the original entry directly (preserveTimestamp: true, keep the original position)
      const updatedPrompt = {
        ...editingPrompt,
        title: title.trim(),
        content: sendContent,
        lastUsedAt: Date.now()
        // Do not modify updatedAt, createdAt, pinned, color
      }
      onUpdatePrompt(updatedPrompt, true)
    }

    // Clear editing state and drafts
    setTitle('')
    setContent('')
    onCancelEdit()
    onEditorDraftChange(null)
    onSaveSuccess?.()
  }, [title, content, editingPrompt, onSubmit, onUpdatePrompt, onCancelEdit, onEditorDraftChange, onSaveSuccess])

  // Submit processing (add new Prompt, optionally with a color tag).
  const handleSubmit = useCallback((color?: PromptColor | null) => {
    const sendContent = transformVirtualPaddingForSend(content)
    if (!sendContent) return

    onSubmit(title.trim(), sendContent, color ?? null)
    setTitle('')
    setContent('')
    // Clear draft after submission
    onEditorDraftChange(null)
  }, [title, content, onSubmit, onEditorDraftChange])

  // Edit mode: apply a color and save the current edit in one action
  const handleSaveWithColor = useCallback((color: PromptColor) => {
    const sendContent = transformVirtualPaddingForSend(content)
    if (!sendContent || !editingPrompt) return

    onUpdatePrompt({
      ...editingPrompt,
      title: title.trim(),
      content: sendContent,
      color,
      lastUsedAt: Date.now()
    }, true)

    setTitle('')
    setContent('')
    onCancelEdit()
    onEditorDraftChange(null)
    onSaveSuccess?.()
  }, [title, content, editingPrompt, onUpdatePrompt, onCancelEdit, onEditorDraftChange, onSaveSuccess])

  // Cancel edit
  const handleCancel = useCallback(() => {
    setTitle('')
    setContent('')
    onCancelEdit()
    // Clear draft after canceling
    onEditorDraftChange(null)
    // Cancel the blur input box after editing to ensure that ESC can close the Editor normally next time
    textareaRef.current?.blur()
  }, [onCancelEdit, onEditorDraftChange])

  // Parent content/title notifications are handled by the debounced
  // effect above — no separate immediate effects needed here.

  const handleTitleChange = useCallback((value: string) => {
    setTitle(value)
    if (performanceTrace.enabled) {
      performanceTrace.recordInstant('ui.prompt.edit', {
        field: 'title',
        mode: editingPrompt ? 'edit' : 'new',
        ...performanceTrace.summarizeText('payload', value)
      }, 'prompt')
    }
  }, [editingPrompt])

  const handleContentChange = useCallback((value: string) => {
    setContent(value)
    if (performanceTrace.enabled) {
      performanceTrace.recordInstant('ui.prompt.edit', {
        field: 'content',
        mode: editingPrompt ? 'edit' : 'new',
        ...performanceTrace.summarizeText('payload', value)
      }, 'prompt')
    }
  }, [editingPrompt])

  // Respond to clear triggers
  useEffect(() => {
    if (clearTrigger > 0) {
      setTitle('')
      setContent('')
    }
  }, [clearTrigger])

  // Programmatic content mutation used by the right-click context menu.
  // Sets the content (running through React state so debounced parent
  // notification still fires) and restores the caret position on the next
  // paint, since the controlled textarea otherwise resets caret to end.
  // The pre-mutation content/selection is pushed to historyRef so the menu's
  // "Undo" entry can revert exactly one menu operation. The title is NOT
  // captured: no current menu action mutates the title, so reverting it
  // would silently overwrite any keystroke the user typed into the title
  // input between the menu action and the undo click.
  const applyMutation = useCallback((next: string, cursorAt?: number) => {
    const ta = textareaRef.current
    historyRef.current.push({
      value: ta?.value ?? '',
      selectionStart: ta?.selectionStart ?? 0,
      selectionEnd: ta?.selectionEnd ?? 0
    })
    if (historyRef.current.length > HISTORY_LIMIT) {
      historyRef.current.shift()
    }
    setContent(next)
    if (performanceTrace.enabled) {
      performanceTrace.recordInstant('ui.prompt.edit', {
        field: 'content',
        mode: editingPrompt ? 'edit' : 'new',
        ...performanceTrace.summarizeText('payload', next)
      }, 'prompt')
    }
    if (cursorAt !== undefined) {
      requestAnimationFrame(() => {
        const ta = textareaRef.current
        if (!ta) return
        try {
          ta.setSelectionRange(cursorAt, cursorAt)
        } catch (err) {
          // setSelectionRange may throw on Firefox / detached nodes; safe to
          // ignore — the caret will land at the default position.
        }
      })
    }
  }, [editingPrompt])

  // Undo the most recent applyMutation by popping the history stack. Returns
  // false when the stack is empty (UI surface this as a disabled menu item).
  // Only content + caret are restored — title is owned by the user's keyboard
  // and is not part of menu mutations.
  const undoLastMutation = useCallback((): boolean => {
    const last = historyRef.current.pop()
    if (!last) return false
    setContent(last.value)
    requestAnimationFrame(() => {
      const ta = textareaRef.current
      if (!ta) return
      try {
        ta.setSelectionRange(last.selectionStart, last.selectionEnd)
        ta.focus()
      } catch {
        // Ignore — caret position is best-effort.
      }
    })
    return true
  }, [])

  const handleTextareaContextMenu = useCallback((e: React.MouseEvent<HTMLTextAreaElement>) => {
    e.preventDefault()
    e.stopPropagation()
    // Capture value/selection atomically at the contextmenu event so menu
    // actions operate on what the user is currently looking at — independent
    // of any subsequent React reconciliation that might revert the textarea
    // DOM value before the menu mounts.
    const ta = e.currentTarget
    setCtxMenu({
      x: e.clientX,
      y: e.clientY,
      snapshot: {
        value: ta.value,
        start: ta.selectionStart ?? 0,
        end: ta.selectionEnd ?? 0
      },
      canUndo: historyRef.current.length > 0
    })
  }, [])

  const closeCtxMenu = useCallback(() => {
    setCtxMenu(null)
  }, [])

  // Virtual-cursor mousedown: lets the user click anywhere inside the textarea
  // — including blank space past EOL or past EOF — and start typing there.
  // The handler physically pads the textarea value with spaces (to fill the
  // target line up to the click column) and `\n`s (to extend to the target
  // row), then sets the caret to that position so the native textarea caret
  // blinks at the virtual click point. Padding is undone via the same
  // historyRef stack the right-click context menu uses.
  //
  // Hooked on `mousedown`, NOT `click`: shift+click selection ranges are
  // resolved by the browser between mousedown and click, so padding has to
  // happen first.
  const handleCanvasMouseDown = useCallback((e: React.MouseEvent<HTMLTextAreaElement>) => {
    if (VIRTUAL_CURSOR_DISABLED) return
    if (e.button !== 0) return
    if (e.shiftKey || e.altKey || e.ctrlKey || e.metaKey) return
    // Per-tab user preference: when the dropdown selects 'line', treat the
    // textarea as a plain native input — no virtual-cursor padding.
    if (promptInputMode === 'line') return
    // IME composition mid-flight: mutating value / selection here would
    // cancel the partial character. Short-circuit; the user's next click
    // after compositionend will work.
    if (isComposingRef.current) return
    const ta = textareaRef.current
    if (!ta) return
    const startedAt = performance.now()
    const measureStartedAt = startedAt
    const wasMetricsCached = metricsRef.current !== null
    const m = metricsRef.current ?? (metricsRef.current = measureCellMetrics(ta))
    if (m.cw <= 0 || m.lh <= 0) return
    const measureMs = performance.now() - measureStartedAt
    const rect = ta.getBoundingClientRect()
    const x = e.clientX - rect.left - m.padL + ta.scrollLeft
    const y = e.clientY - rect.top - m.padT + ta.scrollTop
    const targetRow = Math.max(0, Math.floor(y / m.lh))
    // Math.round (not Math.floor) feels closer to native textarea click —
    // half a cell past column N counts as N+1, not N.
    const targetCol = Math.max(0, Math.round(x / m.cw))
    if (targetRow > VIRTUAL_CURSOR_MAX_ROW || targetCol > VIRTUAL_CURSOR_MAX_COL) return

    const lines = ta.value.split('\n')
    // STEP 1: extend rows BEFORE column padding. Otherwise lines[targetRow]
    // is undefined and `' '.repeat(NaN)` throws.
    while (lines.length <= targetRow) lines.push('')
    // STEP 2: pad columns of the target line.
    const line = lines[targetRow]
    if (line.length < targetCol) {
      lines[targetRow] = line + ' '.repeat(targetCol - line.length)
    }
    const next = lines.join('\n')
    if (next === ta.value) return  // Click landed inside existing text — let native click handle it.

    e.preventDefault()
    const flatPos = lines.slice(0, targetRow).reduce((n, l) => n + l.length + 1, 0) + lines[targetRow].length

    // Push pre-mutation state to the same history stack the context menu
    // uses, so right-click Undo can revert virtual-cursor padding too.
    historyRef.current.push({
      value: ta.value,
      selectionStart: ta.selectionStart ?? 0,
      selectionEnd: ta.selectionEnd ?? 0
    })
    if (historyRef.current.length > HISTORY_LIMIT) {
      historyRef.current.shift()
    }
    const padded = next.length - ta.value.length
    // e.preventDefault() above blocks the native mousedown focus path. Take
    // it back ourselves — without this, the very first virtual click on an
    // unfocused textarea sets the value but leaves the caret invisible and
    // the user has to click again. Focusing here is cheap and idempotent.
    ta.focus()
    // flushSync forces React to commit the new value SYNCHRONOUSLY before we
    // call setSelectionRange. The naïve approach — setContent(next) then
    // requestAnimationFrame(setSelectionRange) — costs an extra ~8ms (one
    // frame at 120 Hz / ~16ms at 60 Hz) waiting for the rAF to fire, and
    // because the controlled-textarea value would race the caret position
    // setSelectionRange has to wait for the value to land. Pulling the
    // commit into the user-event handler removes both waits: the caret
    // lands the same tick as the click, and the browser paints it on the
    // very next frame.
    const beforeFlushAt = performance.now()
    flushSync(() => setContent(next))
    const flushSyncMs = performance.now() - beforeFlushAt
    try {
      ta.setSelectionRange(flatPos, flatPos)
    } catch {
      // Best-effort.
    }
    const caretCommittedAt = performance.now()
    // Single-frame paint measurement: from caret-set to next rAF (≈ paint
    // commit on a healthy frame). No second rAF — the measurement cost
    // itself shouldn't drive the production code's user-visible delay.
    requestAnimationFrame(() => {
      const paintedAt = performance.now()
      // durationMs auto-elevates this to ph='X' span via resolvePhase.
      perfTrace(PERF_TRACE_EVENT.RENDERER_PROMPT_EDITOR_VIRTUAL_CARET, {
        row: targetRow,
        col: targetCol,
        padded,
        metricsCached: wasMetricsCached,
        measureMs: +measureMs.toFixed(2),
        flushSyncMs: +flushSyncMs.toFixed(2),
        handlerMs: +(caretCommittedAt - startedAt).toFixed(2),
        paintMs: +(paintedAt - caretCommittedAt).toFixed(2),
        durationMs: +(paintedAt - startedAt).toFixed(2)
      })
    })
  }, [promptInputMode])

  const handleCompositionStart = useCallback(() => {
    isComposingRef.current = true
  }, [])

  const handleCompositionEnd = useCallback(() => {
    isComposingRef.current = false
  }, [])

  // Mode-selector dropdown: close on outside click + Escape, mirroring the
  // pattern used by TerminalDropdown / PromptEditorContextMenu.
  useEffect(() => {
    if (!isModeMenuOpen) return
    const handleClickOutside = (event: MouseEvent) => {
      if (!modeSelectorRef.current?.contains(event.target as Node)) {
        setIsModeMenuOpen(false)
      }
    }
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setIsModeMenuOpen(false)
    }
    document.addEventListener('mousedown', handleClickOutside)
    document.addEventListener('keydown', handleKey)
    return () => {
      document.removeEventListener('mousedown', handleClickOutside)
      document.removeEventListener('keydown', handleKey)
    }
  }, [isModeMenuOpen])

  const handleSelectMode = useCallback((mode: 'canvas' | 'line') => {
    setIsModeMenuOpen(false)
    if (mode !== promptInputMode) {
      onPromptInputModeChange(mode)
    }
  }, [promptInputMode, onPromptInputModeChange])

  // Shortcut support
  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    // Construct an accelerator format of the current keystroke
    const accelerator = buildAccelerator(e.nativeEvent)

    if (editingPrompt) {
      const isSaveShortcut = matchesAccelerator(accelerator, saveShortcut)
      const isSaveAsShortcut = matchesAccelerator(accelerator, saveAsShortcut)
      const isCancelShortcut = matchesAccelerator(accelerator, cancelShortcut) || e.key === 'Escape'

      if (isSaveShortcut) {
        e.preventDefault()
        handleSave(false)
        return
      }

      if (isSaveAsShortcut) {
        e.preventDefault()
        handleSave(true)
        return
      }

      if (isCancelShortcut) {
        e.preventDefault()
        handleCancel()
        return
      }

      return
    }

    // Check if the configured shortcuts match
    const isConfiguredShortcut = addToHistoryShortcut && accelerator === addToHistoryShortcut
    // If there is no shortcut configured, use the default Cmd/Ctrl+Enter
    const isDefaultShortcut = !addToHistoryShortcut && e.key === 'Enter' && (e.metaKey || e.ctrlKey)

    if (isConfiguredShortcut || isDefaultShortcut) {
      e.preventDefault()
      handleSubmit()
      return
    }

  }, [handleSubmit, handleSave, handleCancel, editingPrompt, addToHistoryShortcut, matchesAccelerator, saveShortcut, saveAsShortcut, cancelShortcut])

  // Register callback to Context (only visible instance registration).
  // Keyboard-shortcut focus lands the caret at (row 0, col 0) — the
  // textarea would otherwise restore its last selection, which under the
  // virtual-cursor model could be a stale virtual position from a prior
  // click. (0, 0) is the predictable "start fresh" anchor.
  useEffect(() => {
    if (hidden) return
    registerFocusEditor(() => {
      const ta = textareaRef.current
      if (!ta) return
      ta.focus()
      try {
        ta.setSelectionRange(0, 0)
      } catch {
        // Best-effort — non-fatal on detached nodes.
      }
    })
    registerSubmitEditor(() => handleSubmit())
    return () => {
      registerFocusEditor(null)
      registerSubmitEditor(null)
    }
  }, [registerFocusEditor, registerSubmitEditor, handleSubmit, hidden])

  return (
    <div
      className="prompt-editor"
      style={{ height }}
      onKeyDown={handleKeyDown}
      data-prompt-editing={editingPrompt ? 'true' : undefined}
    >
      <div className="prompt-editor-resizer" onMouseDown={handleMouseDown} />

      {draftToast && (
        <div className="prompt-editor-draft-toast" role="status">{draftToast}</div>
      )}

      <div className="prompt-editor-inputs">
        <div className="prompt-editor-title-row">
          <input
            type="text"
            className="prompt-editor-title"
            placeholder={t('promptEditor.titlePlaceholder')}
            value={title}
            onChange={(e) => handleTitleChange(e.target.value)}
          />
          {!VIRTUAL_CURSOR_DISABLED && (
            <div className="prompt-mode-selector" ref={modeSelectorRef}>
              <button
                type="button"
                className="prompt-mode-trigger"
                onClick={() => setIsModeMenuOpen(open => !open)}
                title={t('promptEditor.modeSelector.trigger')}
                aria-label={t('promptEditor.modeSelector.aria')}
                aria-haspopup="menu"
                aria-expanded={isModeMenuOpen}
                data-mode={promptInputMode}
                data-testid="prompt-mode-trigger"
              >
                <span>{promptInputMode === 'canvas'
                  ? t('promptEditor.modeSelector.canvas')
                  : t('promptEditor.modeSelector.line')}</span>
                <svg width="10" height="6" viewBox="0 0 10 6" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
                  <path d="M1 1l4 4 4-4" />
                </svg>
              </button>
              {isModeMenuOpen && (
                <div className="prompt-mode-menu" role="menu">
                  <button
                    type="button"
                    className="prompt-mode-item"
                    role="menuitem"
                    data-testid="prompt-mode-canvas"
                    aria-checked={promptInputMode === 'canvas'}
                    onClick={() => handleSelectMode('canvas')}
                  >
                    <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
                      {promptInputMode === 'canvas' && <path d="M13.3 4.3a1 1 0 0 1 0 1.4l-6 6a1 1 0 0 1-1.4 0l-3-3a1 1 0 1 1 1.4-1.4L6.6 9.6l5.3-5.3a1 1 0 0 1 1.4 0z" />}
                    </svg>
                    <span>{t('promptEditor.modeSelector.canvas')}</span>
                  </button>
                  <button
                    type="button"
                    className="prompt-mode-item"
                    role="menuitem"
                    data-testid="prompt-mode-line"
                    aria-checked={promptInputMode === 'line'}
                    onClick={() => handleSelectMode('line')}
                  >
                    <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
                      {promptInputMode === 'line' && <path d="M13.3 4.3a1 1 0 0 1 0 1.4l-6 6a1 1 0 0 1-1.4 0l-3-3a1 1 0 1 1 1.4-1.4L6.6 9.6l5.3-5.3a1 1 0 0 1 1.4 0z" />}
                    </svg>
                    <span>{t('promptEditor.modeSelector.line')}</span>
                  </button>
                </div>
              )}
            </div>
          )}
        </div>
        <textarea
          ref={textareaRef}
          className="prompt-editor-content"
          placeholder={t('promptNotebook.editorPlaceholder')}
          value={content}
          onChange={(e) => handleContentChange(e.target.value)}
          onContextMenu={handleTextareaContextMenu}
          onMouseDown={handleCanvasMouseDown}
          onCompositionStart={handleCompositionStart}
          onCompositionEnd={handleCompositionEnd}
        />
      </div>
      {ctxMenu && (
        <PromptEditorContextMenu
          position={{ x: ctxMenu.x, y: ctxMenu.y }}
          snapshot={ctxMenu.snapshot}
          canUndo={ctxMenu.canUndo}
          isMac={isMac}
          onClose={closeCtxMenu}
          textareaRef={textareaRef}
          applyMutation={applyMutation}
          onUndo={undoLastMutation}
          pinnedPrompts={ctxPinnedPrompts}
          appendPromptToContent={ctxAppendPromptToContent}
          saveSelectionAsPinned={ctxSaveSelectionAsPinned}
          currentCwd={ctxCurrentCwd}
          currentBranch={ctxCurrentBranch}
          currentTaskTitle={ctxCurrentTaskTitle}
          terminals={ctxTerminals}
          onSendToTask={ctxSendToTask}
        />
      )}

      <div className="prompt-editor-actions">
        <div
          className="prompt-editor-color-picker"
          role="group"
          aria-label={t('promptEditor.colorPickerLabel')}
        >
          {PROMPT_COLORS.map(({ key, hex }) => {
            const label = editingPrompt
              ? t(`promptEditor.saveWith.${key}`)
              : t(`promptEditor.addWith.${key}`)
            return (
              <button
                key={key}
                type="button"
                className={`prompt-editor-color-btn prompt-editor-color-btn-${key}`}
                style={{ ['--color' as string]: hex } as React.CSSProperties}
                disabled={!content.trim()}
                onClick={() => editingPrompt ? handleSaveWithColor(key) : handleSubmit(key)}
                title={label}
                aria-label={label}
              >
                <span className="prompt-editor-color-dot" />
              </button>
            )
          })}
        </div>
        {editingPrompt ? (
          <>
            <button
              className="prompt-editor-btn prompt-editor-btn-cancel"
              onClick={handleCancel}
              title={t('promptNotebook.shortcutTitle', { shortcut: cancelShortcutLabel })}
            >
              {t('common.cancel')}
            </button>
            <button
              className="prompt-editor-btn prompt-editor-btn-submit"
              onClick={() => handleSave(false)}
              disabled={!content.trim()}
              title={t('promptNotebook.shortcutTitle', { shortcut: saveShortcutLabel })}
            >
              {t('common.save')}
            </button>
            <button
              className="prompt-editor-btn prompt-editor-btn-submit"
              onClick={() => handleSave(true)}
              disabled={!content.trim()}
              title={t('promptNotebook.shortcutTitle', { shortcut: saveAsShortcutLabel })}
            >
              {t('promptNotebook.saveAsNew')}
            </button>
          </>
        ) : (
          <button
            className="prompt-editor-btn prompt-editor-btn-submit"
            onClick={() => handleSubmit()}
            disabled={!content.trim()}
          >
            {t('promptEditor.addToHistory')}
          </button>
        )}
      </div>
    </div>
  )
})
