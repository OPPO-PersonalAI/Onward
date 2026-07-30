/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

import { useState, useEffect, useMemo, useRef, memo } from 'react'
import type { CSSProperties, KeyboardEvent, MouseEvent } from 'react'
import type { TerminalBatchResult, TerminalInfo } from '../../types/prompt'
import { useI18n } from '../../i18n/useI18n'
import { perfTrace } from '../../utils/perf-trace'
import { PERF_TRACE_EVENT } from '../../utils/perf-trace-names'
import { performanceTrace } from '../../utils/performance-trace'
import type { ResolvedLayout } from '../../utils/layout-mode'
import {
  getTaskSelectorGeometry,
  taskSelectorGeometrySignature,
  type TaskSelectorSlot
} from '../../utils/task-selector-geometry'

/** How many rainbow accent slots App.css defines (`--rainbow-1`..`--rainbow-6`). */
const RAINBOW_SLOT_COUNT = 6

interface PromptSenderProps {
  terminals: TerminalInfo[]
  /**
   * The Task layout currently rendered by TerminalGrid. The selector mirrors
   * its shape so "the second card, top-right" means the same Task on both
   * sides of the window.
   */
  taskLayout: ResolvedLayout
  promptContent: string
  onSend: (terminalIds: string[], content: string) => Promise<TerminalBatchResult>
  onExecute: (terminalIds: string[]) => Promise<TerminalBatchResult>
  onSendAndExecute: (terminalIds: string[], content: string) => Promise<TerminalBatchResult>
  onTerminalRename: (id: string, newTitle: string) => void
  onChangeWorkDir?: (terminalIds: string[], directory: string) => void
}

/** Inline grid placement for one mirrored slot. */
function slotStyle(slot: TaskSelectorSlot | undefined): CSSProperties {
  if (!slot) return {}
  return {
    gridColumn: `${slot.colStart} / span ${slot.colSpan}`,
    gridRow: `${slot.rowStart} / span ${slot.rowSpan}`
  }
}

export const PromptSender = memo(function PromptSender({
  terminals,
  taskLayout,
  promptContent,
  onSend,
  onExecute,
  onSendAndExecute,
  onTerminalRename
}: PromptSenderProps) {
  const { t } = useI18n()
  const [selectedTerminals, setSelectedTerminals] = useState<Set<string>>(new Set())
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editingTitle, setEditingTitle] = useState('')
  const editInputRef = useRef<HTMLInputElement>(null)
  const [selectionNotice, setSelectionNotice] = useState('')
  const noticeTimerRef = useRef<number | null>(null)
  const selectClickTimerRef = useRef<number | null>(null)
  const [isSubmitting, setIsSubmitting] = useState(false)
  const submittingRef = useRef(false)
  // Keep debug automation on the latest state without recreating the API object.
  const terminalsRef = useRef(terminals)
  const promptContentRef = useRef(promptContent)
  const selectedTerminalsRef = useRef(selectedTerminals)
  const selectionNoticeRef = useRef(selectionNotice)
  const isSubmittingRef = useRef(isSubmitting)
  const handleSendToSelectedRef = useRef<() => Promise<void>>(async () => {})
  const handleExecuteRef = useRef<() => Promise<void>>(async () => {})
  const handleSendAndExecuteRef = useRef<() => Promise<void>>(async () => {})
  const handleSendAllAndExecuteRef = useRef<() => Promise<void>>(async () => {})
  // Mirror of the right-hand Task grid: same column / row track counts, and
  // for a custom layout the same per-Task rectangles. This component
  // re-renders on every keystroke in the prompt editor (promptContent is a
  // prop), so the mapping, its signature and the style object are all pinned
  // to the layout rather than recomputed per character.
  const geometry = useMemo(
    () => getTaskSelectorGeometry(taskLayout, terminals.length),
    [taskLayout, terminals.length]
  )
  const geometrySignature = useMemo(() => taskSelectorGeometrySignature(geometry), [geometry])
  const gridTrackStyle = useMemo(() => ({
    '--task-slot-cols': geometry.columns,
    '--task-slot-rows': geometry.rows
  }) as CSSProperties, [geometry])
  const geometryRef = useRef(geometry)
  const taskLayoutKindRef = useRef(taskLayout.kind)
  const selectedCount = selectedTerminals.size

  terminalsRef.current = terminals
  promptContentRef.current = promptContent
  selectedTerminalsRef.current = selectedTerminals
  selectionNoticeRef.current = selectionNotice
  isSubmittingRef.current = isSubmitting
  geometryRef.current = geometry
  taskLayoutKindRef.current = taskLayout.kind

  // Diagnostic breadcrumb for "the selector no longer matches the grid".
  // Keyed on the geometry signature, so this fires on a layout switch, a
  // custom-preset edit or a Task count change — not on every render.
  useEffect(() => {
    perfTrace(PERF_TRACE_EVENT.RENDERER_PROMPT_SENDER_LAYOUT_SYNC, {
      kind: taskLayoutKindRef.current,
      columns: geometryRef.current.columns,
      rows: geometryRef.current.rows,
      slots: geometryRef.current.slots.length,
      signature: geometrySignature
    })
  }, [geometrySignature])

  const recordTaskSelectionTrace = (id: string, selected: boolean, selectedCount: number) => {
    if (!performanceTrace.enabled) return
    performanceTrace.recordInstant('ui.prompt.task_select', {
      terminalId: id,
      selected,
      selectedCount,
      totalCount: terminalsRef.current.length
    }, 'prompt')
  }

  // When the terminal list changes, update the selected status (remove non-existing terminals)
  useEffect(() => {
    const terminalIds = new Set(terminals.map(t => t.id))
    setSelectedTerminals(prev => {
      const newSet = new Set<string>()
      prev.forEach(id => {
        if (terminalIds.has(id)) {
          newSet.add(id)
        }
      })
      return newSet
    })
  }, [terminals])

  // Automatically focus on the edit input box
  useEffect(() => {
    if (editingId && editInputRef.current) {
      editInputRef.current.focus()
      editInputRef.current.select()
    }
  }, [editingId])

  const handleToggle = (id: string) => {
    setSelectedTerminals(prev => {
      const newSet = new Set(prev)
      let selected = false
      if (newSet.has(id)) {
        newSet.delete(id)
      } else {
        newSet.add(id)
        selected = true
      }
      recordTaskSelectionTrace(id, selected, newSet.size)
      return newSet
    })
  }

  const handleCardClick = (event: MouseEvent<HTMLDivElement>, id: string) => {
    event.stopPropagation()
    if (selectClickTimerRef.current) {
      window.clearTimeout(selectClickTimerRef.current)
      selectClickTimerRef.current = null
    }
    selectClickTimerRef.current = window.setTimeout(() => {
      handleToggle(id)
      selectClickTimerRef.current = null
    }, 200)
  }

  const handleCardKeyDown = (event: KeyboardEvent<HTMLDivElement>, id: string) => {
    if (event.key === ' ' || event.key === 'Enter') {
      event.preventDefault()
      handleToggle(id)
    }
  }

  // Double click to start editing
  const handleStartEdit = (id: string, currentCustomName: string | null) => {
    setEditingId(id)
    setEditingTitle(currentCustomName || '')
  }

  // Complete editing
  const handleFinishEdit = () => {
    if (editingId) {
      onTerminalRename(editingId, editingTitle.trim())
    }
    setEditingId(null)
    setEditingTitle('')
  }

  // Cancel edit
  const handleCancelEdit = () => {
    setEditingId(null)
    setEditingTitle('')
  }

  // Keyboard events
  const handleEditKeyDown = (e: React.KeyboardEvent) => {
    e.stopPropagation()
    if (e.key === 'Enter') {
      handleFinishEdit()
    } else if (e.key === 'Escape') {
      handleCancelEdit()
    }
  }

  const showNotice = (message: string) => {
    setSelectionNotice(message)
    if (noticeTimerRef.current) {
      window.clearTimeout(noticeTimerRef.current)
    }
    noticeTimerRef.current = window.setTimeout(() => {
      setSelectionNotice('')
    }, 2000)
  }

  const showSelectTerminalNotice = () => {
    showNotice(t('promptSender.selectTerminalFirst'))
  }

  const runTerminalAction = async (
    actionName: 'promptSender.action.send' | 'promptSender.action.execute' | 'promptSender.action.sendAndExecute',
    runner: () => Promise<TerminalBatchResult>
  ) => {
    if (submittingRef.current) {
      return false
    }
    submittingRef.current = true
    setIsSubmitting(true)

    try {
      const result = await runner()
      setSelectedTerminals(new Set())
      const sentOnlyCount = result.sentOnlyIds.length
      const failedCount = result.failedIds.length
      const unsafeMultilineCount = result.issues.filter(
        (issue) => issue.reason === 'unsafe-multiline-send'
      ).length

      if (sentOnlyCount > 0 && failedCount === 0) {
        showNotice(t('promptSender.sentOnly', { count: sentOnlyCount }))
      } else if (failedCount > 0 && sentOnlyCount === 0 && unsafeMultilineCount === failedCount) {
        showNotice(t('promptSender.multilineBlocked', { count: failedCount }))
      } else if (sentOnlyCount > 0 && failedCount > 0) {
        showNotice(t('promptSender.mixedResult', {
          sentOnlyCount,
          failedCount
        }))
      } else if (failedCount > 0) {
        showNotice(t('promptSender.partialFailure', {
          count: failedCount,
          action: t(actionName)
        }))
      } else {
        setSelectionNotice('')
      }
      return true
    } catch (error) {
      console.error(`[PromptSender] ${actionName} failed:`, error)
      showNotice(t('promptSender.failure', { action: t(actionName) }))
      return false
    } finally {
      submittingRef.current = false
      setIsSubmitting(false)
    }
  }

  const handleSendToSelected = async () => {
    if (selectedTerminals.size === 0) return
    const terminalIds = Array.from(selectedTerminals)
    perfTrace(PERF_TRACE_EVENT.RENDERER_PROMPT_SENDER_DISPATCH, {
      action: 'send', targets: terminalIds.length, contentLen: promptContent.length
    })
    await runTerminalAction('promptSender.action.send', () => onSend(terminalIds, promptContent))
  }

  const handleSendAllAndExecute = async () => {
    if (terminals.length === 0 || !promptContent) return
    const terminalIds = terminals.map(t => t.id)
    perfTrace(PERF_TRACE_EVENT.RENDERER_PROMPT_SENDER_DISPATCH, {
      action: 'sendAllAndExecute', targets: terminalIds.length, contentLen: promptContent.length
    })
    await runTerminalAction('promptSender.action.sendAndExecute', () => onSendAndExecute(terminalIds, promptContent))
  }

  const handleExecute = async () => {
    if (selectedTerminals.size === 0) return
    const terminalIds = Array.from(selectedTerminals)
    perfTrace(PERF_TRACE_EVENT.RENDERER_PROMPT_SENDER_DISPATCH, {
      action: 'execute', targets: terminalIds.length, contentLen: 0
    })
    await runTerminalAction('promptSender.action.execute', () => onExecute(terminalIds))
  }

  const handleSendAndExecute = async () => {
    if (selectedTerminals.size === 0) {
      showSelectTerminalNotice()
      return
    }
    const terminalIds = Array.from(selectedTerminals)
    perfTrace(PERF_TRACE_EVENT.RENDERER_PROMPT_SENDER_DISPATCH, {
      action: 'sendAndExecute', targets: terminalIds.length, contentLen: promptContent.length
    })
    await runTerminalAction('promptSender.action.sendAndExecute', () => onSendAndExecute(terminalIds, promptContent))
  }

  handleSendToSelectedRef.current = handleSendToSelected
  handleExecuteRef.current = handleExecute
  handleSendAndExecuteRef.current = handleSendAndExecute
  handleSendAllAndExecuteRef.current = handleSendAllAndExecute

  useEffect(() => {
    return () => {
      if (noticeTimerRef.current) {
        window.clearTimeout(noticeTimerRef.current)
      }
      if (selectClickTimerRef.current) {
        window.clearTimeout(selectClickTimerRef.current)
      }
    }
  }, [])

  // Debug API (only exposed in automated testing mode)
  useEffect(() => {
    if (!window.electronAPI?.debug?.autotest) return
    const api = {
      getTerminalCards: () => terminalsRef.current.map(t => ({
        id: t.id,
        title: t.title || `Task`,
        isSelected: selectedTerminalsRef.current.has(t.id)
      })),
      getPromptContent: () => promptContentRef.current,
      getSelectedCount: () => selectedTerminalsRef.current.size,
      getSelectionIndicatorStates: () => terminalsRef.current.map((terminal) => ({
        id: terminal.id,
        isActive: selectedTerminalsRef.current.has(terminal.id)
      })),
      getSelectedTerminalIds: () => Array.from(selectedTerminalsRef.current),
      getActionButtons: () => {
        const btns = document.querySelectorAll('.prompt-sender-btn')
        return Array.from(btns).map(btn => ({
          label: btn.textContent?.trim() ?? '',
          disabled: (btn as HTMLButtonElement).disabled
        }))
      },
      getGridLayout: () => ({
        columns: geometryRef.current.columns,
        rows: geometryRef.current.rows,
        totalCards: terminalsRef.current.length,
        layoutKind: taskLayoutKindRef.current,
        slots: geometryRef.current.slots.map((slot, index) => ({
          terminalId: terminalsRef.current[index]?.id ?? '',
          colStart: slot.colStart,
          colSpan: slot.colSpan,
          rowStart: slot.rowStart,
          rowSpan: slot.rowSpan
        }))
      }),
      getNotice: () => selectionNoticeRef.current || null,
      isSubmitting: () => submittingRef.current || isSubmittingRef.current,
      clickAction: async (action: 'sendAndExecute' | 'execute' | 'send' | 'sendAllAndExecute') => {
        if (action === 'sendAndExecute') {
          await handleSendAndExecuteRef.current()
          return true
        }
        if (action === 'execute') {
          await handleExecuteRef.current()
          return true
        }
        if (action === 'send') {
          await handleSendToSelectedRef.current()
          return true
        }
        if (action === 'sendAllAndExecute') {
          await handleSendAllAndExecuteRef.current()
          return true
        }
        return false
      },
      selectTerminal: (id: string) => {
        if (!terminalsRef.current.some(t => t.id === id)) return false
        setSelectedTerminals(prev => {
          const next = new Set(prev)
          if (!next.has(id)) {
            next.add(id)
            recordTaskSelectionTrace(id, true, next.size)
          }
          return next
        })
        return true
      },
      deselectTerminal: (id: string) => {
        setSelectedTerminals(prev => {
          const next = new Set(prev)
          next.delete(id)
          return next
        })
        return true
      },
      deselectAllTerminals: () => {
        setSelectedTerminals(new Set())
      }
    }
    ;(window as any).__onwardPromptSenderDebug = api
    return () => {
      if ((window as any).__onwardPromptSenderDebug === api) {
        delete (window as any).__onwardPromptSenderDebug
      }
    }
  }, [])

  return (
    <div className="prompt-sender">
      <div
        className="prompt-sender-terminals"
        style={gridTrackStyle}
        data-task-columns={geometry.columns}
        data-task-rows={geometry.rows}
        data-task-layout-kind={taskLayout.kind}
      >
        {terminals.length === 0 ? (
          <div className="prompt-sender-empty">{t('promptSender.noTerminals')}</div>
        ) : (
          terminals.map((terminal, index) => (
            <div
              key={terminal.id}
              className={`prompt-sender-terminal ${selectedTerminals.has(terminal.id) ? 'is-selected' : ''}`}
              // Only six rainbow accents exist; an 8-Task layout would
              // otherwise resolve `var(--rainbow-7)` to nothing and drop the
              // card's border colour entirely.
              style={{
                ...slotStyle(geometry.slots[index]),
                '--t-color': `var(--rainbow-${(index % RAINBOW_SLOT_COUNT) + 1})`
              } as React.CSSProperties}
              data-terminal-id={terminal.id}
              data-slot-index={index}
              role="button"
              tabIndex={0}
              aria-pressed={selectedTerminals.has(terminal.id)}
              onClick={(event) => handleCardClick(event, terminal.id)}
              onDoubleClick={(event) => {
                event.stopPropagation()
                if (selectClickTimerRef.current) {
                  window.clearTimeout(selectClickTimerRef.current)
                  selectClickTimerRef.current = null
                }
                handleStartEdit(terminal.id, terminal.customName)
              }}
              onKeyDown={(event) => handleCardKeyDown(event, terminal.id)}
            >
              {editingId === terminal.id ? (
                <input
                  ref={editInputRef}
                  type="text"
                  className="prompt-sender-terminal-input"
                  value={editingTitle}
                  onChange={(e) => setEditingTitle(e.target.value)}
                  onBlur={handleFinishEdit}
                  onKeyDown={handleEditKeyDown}
                  onClick={(e) => e.stopPropagation()}
                  placeholder={`Task ${index + 1}`}
                />
              ) : (
                <>
                  {/*
                    A slot too narrow for a name shows the Task's position
                    number instead: a truncated "Tas…" identifies nothing,
                    while the number is the same handle Cmd+N uses. The swap
                    is a container query on the card itself, so it tracks the
                    real slot width rather than the panel width — measured
                    crossover for an 8-Task 4x2 layout is a panel around
                    250-280px; the 320px default keeps names.
                  */}
                  <span
                    className="prompt-sender-terminal-name"
                    title={t('promptSender.taskCardTitle', {
                      name: terminal.title || `Task ${index + 1}`
                    })}
                  >
                    {terminal.title || `Task ${index + 1}`}
                  </span>
                  <span
                    className="prompt-sender-terminal-index"
                    title={t('promptSender.taskCardTitle', {
                      name: terminal.title || `Task ${index + 1}`
                    })}
                  >
                    {index + 1}
                  </span>
                </>
              )}
            </div>
          ))
        )}
      </div>

      <div className="prompt-sender-actions">
        {terminals.length > 0 && (
          <div
            className="prompt-sender-selection-indicator"
            style={gridTrackStyle}
            role="status"
            aria-live="polite"
            aria-label={t('promptSender.selection.aria', { count: selectedCount })}
          >
            {terminals.map((terminal, index) => (
              <span
                key={terminal.id}
                className={`prompt-sender-selection-cell${selectedTerminals.has(terminal.id) ? ' is-active' : ''}`}
                style={slotStyle(geometry.slots[index])}
                data-terminal-id={terminal.id}
                aria-hidden="true"
              />
            ))}
          </div>
        )}

        <div className="prompt-sender-action-buttons">
          <button
            className="prompt-sender-btn prompt-sender-btn-send-execute"
            onClick={() => { void handleSendAndExecute() }}
            disabled={selectedCount === 0 || isSubmitting}
            title={t('promptSender.title.sendAndExecute')}
          >
            {t('promptSender.button.sendAndExecute')}
          </button>
          <button
            className="prompt-sender-btn prompt-sender-btn-execute"
            onClick={() => { void handleExecute() }}
            disabled={selectedCount === 0 || isSubmitting}
            title={t('promptSender.title.execute')}
          >
            {t('promptSender.button.execute')}
          </button>
          <button
            className="prompt-sender-btn prompt-sender-btn-send"
            onClick={() => { void handleSendToSelected() }}
            disabled={selectedCount === 0 || isSubmitting}
            title={t('promptSender.title.send')}
          >
            {t('promptSender.button.send')}
          </button>
          <button
            className="prompt-sender-btn prompt-sender-btn-send-all-execute"
            onClick={() => { void handleSendAllAndExecute() }}
            disabled={terminals.length === 0 || !promptContent || isSubmitting}
            title={t('promptSender.title.sendAllAndExecute')}
          >
            {t('promptSender.button.sendAllAndExecute')}
          </button>
        </div>
      </div>

      {selectionNotice && (
        <div className="prompt-sender-notice" role="status" aria-live="polite">
          {selectionNotice}
        </div>
      )}

    </div>
  )
})
