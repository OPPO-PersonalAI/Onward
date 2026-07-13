/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

import { useEffect, useLayoutEffect, useRef, useState, useMemo, useCallback } from 'react'
import { createPortal } from 'react-dom'
import type { Prompt } from '../../types/electron'
import type { TerminalInfo } from '../../types/prompt'
import { useI18n } from '../../i18n/useI18n'
import { perfTrace } from '../../utils/perf-trace'
import { PERF_TRACE_EVENT } from '../../utils/perf-trace-names'
import { computeMenuPosition, computeSubmenuLayout } from '../../utils/popup-position'
import './PromptEditorContextMenu.css'

const PINNED_PRIMARY_LIMIT = 10
const MENU_VIEWPORT_MARGIN = 8
const SUBMENU_GAP = 2
const SUBMENU_VERTICAL_OFFSET = 6
const SUBMENU_LAYOUT_SAFETY_INSET = 4

type SubmenuKey = 'pinPrimary' | 'task' | null

type SubmenuLayout = {
  left: number
  top: number
  width: number
  minWidth: number
  maxWidth: number
  maxHeight: number
}

export interface ContextMenuSnapshot {
  value: string
  start: number
  end: number
}

export interface PromptEditorContextMenuProps {
  position: { x: number; y: number }
  isMac: boolean
  onClose: () => void
  textareaRef: React.RefObject<HTMLTextAreaElement>
  /**
   * Editor value/selection captured atomically at the contextmenu event time.
   * Required because React reconciliation can revert the textarea DOM value
   * between the right-click and the menu's first render — the snapshot is
   * the user's actual perceived state at the moment of right-click.
   */
  snapshot: ContextMenuSnapshot
  /**
   * Whether the menu's Undo entry is actionable. Captured at right-click
   * time from the underlying mutation history depth — stale by the time
   * Undo is clicked is fine, the click is a no-op when the stack is empty.
   */
  canUndo: boolean
  applyMutation: (next: string, cursorAt?: number) => void
  /**
   * Pop one entry off the menu's mutation history stack and restore it.
   * Returns false when the stack is empty.
   */
  onUndo: () => boolean
  pinnedPrompts: Prompt[]
  appendPromptToContent: (prompt: Prompt) => void
  saveSelectionAsPinned: (selection: string) => void
  currentCwd: string | null
  currentBranch: string | null
  currentTaskTitle: string | null
  terminals: TerminalInfo[]
  onSendToTask: (content: string, terminalId: string) => void
}

export function PromptEditorContextMenu({
  position,
  isMac,
  onClose,
  textareaRef,
  snapshot,
  canUndo,
  applyMutation,
  onUndo,
  pinnedPrompts,
  appendPromptToContent,
  saveSelectionAsPinned,
  currentCwd,
  currentBranch,
  currentTaskTitle,
  terminals,
  onSendToTask
}: PromptEditorContextMenuProps) {
  const { t } = useI18n()
  const [submenu, setSubmenu] = useState<SubmenuKey>(null)
  const [showAllPinned, setShowAllPinned] = useState(false)
  const submenuTimerRef = useRef<number | null>(null)
  const menuRef = useRef<HTMLDivElement | null>(null)
  const submenuRef = useRef<HTMLDivElement | null>(null)
  // Effective screen position: starts at the right-click point, then nudged
  // by the layout effect below so the menu stays inside the viewport. The
  // useLayoutEffect runs synchronously between commit and paint, so the
  // browser only sees the final, on-screen position — no flicker.
  const [effectivePosition, setEffectivePosition] = useState<{ x: number; y: number }>(position)
  const [submenuLayout, setSubmenuLayout] = useState<SubmenuLayout | null>(null)
  const [viewportVersion, setViewportVersion] = useState(0)

  // Snapshot is captured atomically by the parent's onContextMenu handler
  // and passed in as a prop, so React reconciliation cannot revert the
  // textarea value between right-click and the menu's first render.
  const hasSelection = snapshot.start !== snapshot.end
  const selectedText = hasSelection
    ? snapshot.value.slice(snapshot.start, snapshot.end)
    : ''
  const hasContent = snapshot.value.trim().length > 0

  // Emit a single perf marker on open so usage frequency is observable.
  useEffect(() => {
    perfTrace(PERF_TRACE_EVENT.RENDERER_PROMPT_EDITOR_CTX_MENU_OPEN, {
      hasSelection,
      pinnedCount: pinnedPrompts.length,
      taskCount: terminals.length
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Keep the main menu inside the viewport. Right-clicking near the bottom
  // edge would otherwise hide the lower half of a tall menu off-screen; we
  // measure the menu's commit-time bounding box and either flip it above
  // the cursor or clamp it against the viewport edge. Horizontal overflow
  // (right edge) is also clamped so submenus opening to the right have
  // somewhere to live.
  useLayoutEffect(() => {
    const el = menuRef.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    // Shared flip-then-clamp math (extracted from this component into
    // popup-position.ts so every context menu places identically).
    const result = computeMenuPosition({
      anchor: { x: position.x, y: position.y },
      menu: { width: rect.width, height: rect.height },
      viewport: { width: window.innerWidth, height: window.innerHeight },
      margin: MENU_VIEWPORT_MARGIN
    })
    setEffectivePosition(prev => (
      prev.x === result.x && prev.y === result.y ? prev : { x: result.x, y: result.y }
    ))
  }, [position.x, position.y, viewportVersion])

  // Submenus stay nested in the menu DOM for outside-click containment, but
  // their coordinates are derived from the Onward viewport. Measure their
  // full natural size first, choose the side with more room, clamp to the
  // viewport, then convert that viewport coordinate back to wrapper-local
  // absolute offsets. This avoids `position: fixed` being captured by the
  // parent menu's transform animation.
  useLayoutEffect(() => {
    if (!submenu) {
      setSubmenuLayout(prev => (prev === null ? prev : null))
      return
    }
    const el = submenuRef.current
    const anchorEl = el?.parentElement
    if (!el || !anchorEl) return
    const startedAt = performance.now()
    const anchorRect = anchorEl.getBoundingClientRect()
    const submenuRect = el.getBoundingClientRect()
    const vw = window.innerWidth
    const vh = window.innerHeight
    const computedStyle = window.getComputedStyle(el)
    const computedWidth = Number.parseFloat(computedStyle.width) || 0
    const computedHeight = Number.parseFloat(computedStyle.height) || 0
    const naturalWidth = Math.ceil(Math.max(submenuRect.width, el.scrollWidth, computedWidth))
    const naturalHeight = Math.ceil(Math.max(submenuRect.height, el.scrollHeight, computedHeight))
    // Shared side-picking + clamping math (popup-position.ts).
    const layout = computeSubmenuLayout({
      anchorRect,
      natural: { width: naturalWidth, height: naturalHeight },
      viewport: { width: vw, height: vh },
      margin: MENU_VIEWPORT_MARGIN + SUBMENU_LAYOUT_SAFETY_INSET,
      gap: SUBMENU_GAP,
      verticalOffset: SUBMENU_VERTICAL_OFFSET,
      minWidthCap: 220
    })
    const { openRight, clampedX, clampedY } = layout
    const width = layout.width
    const height = Math.min(naturalHeight, layout.maxHeight)
    const nextLayout: SubmenuLayout = {
      left: layout.left,
      top: layout.top,
      width: layout.width,
      minWidth: layout.minWidth,
      maxWidth: layout.maxWidth,
      maxHeight: layout.maxHeight
    }
    perfTrace(PERF_TRACE_EVENT.RENDERER_PROMPT_EDITOR_CTX_SUBMENU_LAYOUT, {
      submenu,
      openRight,
      clampedX,
      clampedY,
      naturalWidth,
      naturalHeight,
      width,
      height,
      viewportWidth: vw,
      viewportHeight: vh,
      durationMs: +(performance.now() - startedAt).toFixed(2)
    })
    setSubmenuLayout(prev => (
      prev &&
      prev.left === nextLayout.left &&
      prev.top === nextLayout.top &&
      prev.width === nextLayout.width &&
      prev.minWidth === nextLayout.minWidth &&
      prev.maxWidth === nextLayout.maxWidth &&
      prev.maxHeight === nextLayout.maxHeight
        ? prev
        : nextLayout
    ))
  }, [submenu, showAllPinned, viewportVersion, submenuLayout])

  useLayoutEffect(() => {
    if (!submenu) return
    const el = submenuRef.current
    if (!el) return
    const observer = new ResizeObserver(() => {
      setViewportVersion(v => v + 1)
    })
    observer.observe(el)
    return () => observer.disconnect()
  }, [submenu])

  useEffect(() => {
    const handleMouseDown = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        onClose()
      }
    }
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        onClose()
      }
    }
    const handleScroll = (e: Event) => {
      if (menuRef.current && menuRef.current.contains(e.target as Node)) {
        return
      }
      onClose()
    }
    const handleResize = () => {
      setViewportVersion(v => v + 1)
    }
    document.addEventListener('mousedown', handleMouseDown)
    document.addEventListener('keydown', handleKey)
    window.addEventListener('scroll', handleScroll, true)
    window.addEventListener('resize', handleResize)
    return () => {
      document.removeEventListener('mousedown', handleMouseDown)
      document.removeEventListener('keydown', handleKey)
      window.removeEventListener('scroll', handleScroll, true)
      window.removeEventListener('resize', handleResize)
      if (submenuTimerRef.current !== null) {
        window.clearTimeout(submenuTimerRef.current)
        submenuTimerRef.current = null
      }
    }
  }, [onClose])

  const cutLabel = isMac ? '⌘X' : 'Ctrl+X'
  const copyLabel = isMac ? '⌘C' : 'Ctrl+C'
  const pasteLabel = isMac ? '⌘V' : 'Ctrl+V'

  const focusBack = useCallback(() => {
    requestAnimationFrame(() => {
      textareaRef.current?.focus()
    })
  }, [textareaRef])

  const insertAtCursor = useCallback((insertText: string) => {
    const { value, start, end } = snapshot
    const next = value.slice(0, start) + insertText + value.slice(end)
    applyMutation(next, start + insertText.length)
  }, [snapshot, applyMutation])

  // Prefer the Electron-bridged clipboard (synchronous + permission-free in
  // the renderer) over navigator.clipboard.* — the latter is gated by user
  // activation in Electron and silently rejects in autotest contexts.
  const writeClipboard = useCallback(async (text: string) => {
    const electronWrite = window.electronAPI?.clipboard?.writeText
    if (electronWrite) {
      await electronWrite(text)
      return
    }
    await navigator.clipboard.writeText(text)
  }, [])

  const readClipboard = useCallback(async (): Promise<string> => {
    const electronRead = window.electronAPI?.clipboard?.readText
    if (electronRead) {
      return await electronRead()
    }
    return await navigator.clipboard.readText()
  }, [])

  const handleCut = useCallback(async () => {
    if (!hasSelection) return
    try {
      await writeClipboard(selectedText)
    } catch (err) {
      console.error('Prompt editor cut failed:', err)
    }
    const { value, start, end } = snapshot
    applyMutation(value.slice(0, start) + value.slice(end), start)
    onClose()
    focusBack()
  }, [hasSelection, selectedText, snapshot, applyMutation, onClose, focusBack, writeClipboard])

  const handleCopy = useCallback(async () => {
    if (!hasSelection) return
    try {
      await writeClipboard(selectedText)
    } catch (err) {
      console.error('Prompt editor copy failed:', err)
    }
    onClose()
    focusBack()
  }, [hasSelection, selectedText, onClose, focusBack, writeClipboard])

  const handlePaste = useCallback(async () => {
    try {
      const text = await readClipboard()
      insertAtCursor(text)
    } catch (err) {
      console.error('Prompt editor paste failed:', err)
    }
    onClose()
    focusBack()
  }, [insertAtCursor, onClose, focusBack, readClipboard])


  const handleClearContent = useCallback(() => {
    applyMutation('', 0)
    onClose()
    focusBack()
  }, [applyMutation, onClose, focusBack])

  const handleUndo = useCallback(() => {
    onUndo()
    onClose()
    focusBack()
  }, [onUndo, onClose, focusBack])

  const openSubmenu = useCallback((key: Exclude<SubmenuKey, null>) => {
    if (submenuTimerRef.current !== null) {
      window.clearTimeout(submenuTimerRef.current)
      submenuTimerRef.current = null
    }
    setSubmenu(prev => {
      if (prev !== key) {
        setSubmenuLayout(null)
      }
      return key
    })
  }, [])

  const scheduleCloseSubmenu = useCallback(() => {
    if (submenuTimerRef.current !== null) {
      window.clearTimeout(submenuTimerRef.current)
    }
    submenuTimerRef.current = window.setTimeout(() => {
      setSubmenu(null)
      setSubmenuLayout(null)
      submenuTimerRef.current = null
    }, 150)
  }, [])

  const handleSaveAsPinned = useCallback(() => {
    if (!hasSelection) return
    saveSelectionAsPinned(selectedText)
    onClose()
    focusBack()
  }, [hasSelection, selectedText, saveSelectionAsPinned, onClose, focusBack])

  const handleImportPin = useCallback((prompt: Prompt) => {
    appendPromptToContent(prompt)
    onClose()
    focusBack()
  }, [appendPromptToContent, onClose, focusBack])

  const handleInsertCwd = useCallback(() => {
    if (!currentCwd) return
    insertAtCursor(currentCwd)
    onClose()
    focusBack()
  }, [currentCwd, insertAtCursor, onClose, focusBack])

  const handleInsertBranch = useCallback(() => {
    if (!currentBranch) return
    insertAtCursor(currentBranch)
    onClose()
    focusBack()
  }, [currentBranch, insertAtCursor, onClose, focusBack])

  const handleInsertTaskTitle = useCallback(() => {
    if (!currentTaskTitle) return
    insertAtCursor(currentTaskTitle)
    onClose()
    focusBack()
  }, [currentTaskTitle, insertAtCursor, onClose, focusBack])

  const handleSendToTaskClick = useCallback((terminalId: string) => {
    if (!hasContent) return
    onSendToTask(snapshot.value, terminalId)
    onClose()
    focusBack()
  }, [hasContent, snapshot.value, onSendToTask, onClose, focusBack])

  const sortedPinned = useMemo(() => {
    return pinnedPrompts.filter(prompt => prompt.pinned)
  }, [pinnedPrompts])
  const visiblePinned = showAllPinned
    ? sortedPinned
    : sortedPinned.slice(0, PINNED_PRIMARY_LIMIT)


  const ellipsis = (s: string, n: number): string => {
    const oneLine = s.replace(/\s+/g, ' ').trim()
    return oneLine.length > n ? oneLine.slice(0, n - 1) + '…' : oneLine
  }

  const promptLabel = (p: Prompt): string => {
    const title = (p.title || '').trim()
    return title || ellipsis(p.content || '', 40) || t('promptNotebook.editor.contextMenu.untitledPrompt')
  }

  const renderShortcut = (label: string) => (
    <span className="prompt-editor-context-shortcut">{label}</span>
  )

  // Pinned items list rendering helper
  const renderPinnedItems = (items: Prompt[]) => items.map((p) => (
    <button
      key={p.id}
      className="prompt-editor-context-item"
      role="menuitem"
      onClick={() => handleImportPin(p)}
      title={p.content}
    >
      <span className="prompt-editor-context-label">{ellipsis(promptLabel(p), 56)}</span>
    </button>
  ))

  const submenuStyle = submenuLayout
    ? {
        position: 'absolute' as const,
        left: submenuLayout.left,
        top: submenuLayout.top,
        width: submenuLayout.width,
        minWidth: submenuLayout.minWidth,
        maxWidth: submenuLayout.maxWidth,
        maxHeight: submenuLayout.maxHeight,
        marginLeft: 0,
        marginRight: 0
      }
    : {
        position: 'absolute' as const,
        left: 0,
        top: 0,
        visibility: 'hidden' as const
      }

  return createPortal(
    <div
      ref={menuRef}
      className="prompt-editor-context-menu"
      style={{ position: 'fixed', left: effectivePosition.x, top: effectivePosition.y, zIndex: 1100 }}
      role="menu"
      data-testid="prompt-editor-context-menu"
      onMouseDown={(e) => e.stopPropagation()}
      onContextMenu={(e) => e.preventDefault()}
    >
      {/* Group 0: send to Task */}
      <div
        className="prompt-editor-context-submenu-wrapper"
        onMouseEnter={() => openSubmenu('task')}
        onMouseLeave={scheduleCloseSubmenu}
      >
        <button
          className={`prompt-editor-context-item has-submenu ${submenu === 'task' ? 'submenu-open' : ''}`}
          role="menuitem"
          aria-haspopup="menu"
          aria-expanded={submenu === 'task'}
          onClick={() => openSubmenu('task')}
          disabled={!hasContent || terminals.length === 0}
          data-testid="pecm-send-to-task"
        >
          <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M15.854.146a.5.5 0 0 1 .11.54l-5.819 14.547a.75.75 0 0 1-1.329.124l-3.178-4.995L.643 7.184a.75.75 0 0 1 .124-1.33L15.314.037a.5.5 0 0 1 .54.11zM6.636 10.07l2.761 4.338L14.13 2.576 6.636 10.07zm6.787-8.201L1.591 6.602l4.339 2.76 7.494-7.493z" /></svg>
          <span className="prompt-editor-context-label">{t('promptNotebook.editor.contextMenu.sendToTask')}</span>
          <svg className="prompt-editor-context-chevron" width="10" height="10" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M4.646 1.646a.5.5 0 0 1 .708 0l6 6a.5.5 0 0 1 0 .708l-6 6a.5.5 0 0 1-.708-.708L10.293 8 4.646 2.354a.5.5 0 0 1 0-.708z" /></svg>
        </button>
        {submenu === 'task' && hasContent && terminals.length > 0 && (
          <div
            ref={submenuRef}
            className="prompt-editor-context-submenu"
            style={submenuStyle}
            role="menu"
            onMouseEnter={() => openSubmenu('task')}
            onMouseLeave={scheduleCloseSubmenu}
            onMouseDown={(e) => e.stopPropagation()}
            data-testid="pecm-send-to-task-submenu"
          >
            {terminals.map((terminal) => (
              <button
                key={terminal.id}
                className="prompt-editor-context-item"
                role="menuitem"
                onClick={() => handleSendToTaskClick(terminal.id)}
              >
                <span className="prompt-editor-context-label">{terminal.title}</span>
              </button>
            ))}
          </div>
        )}
      </div>

      <div className="prompt-editor-context-separator" role="separator" />

      {/* Group 1: undo last menu mutation */}
      <button
        className="prompt-editor-context-item"
        role="menuitem"
        onClick={handleUndo}
        disabled={!canUndo}
        data-testid="pecm-undo"
      >
        <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path fillRule="evenodd" d="M8 3a5 5 0 1 1-4.546 2.914.5.5 0 0 0-.908-.417A6 6 0 1 0 8 2v1z" /><path d="M8 4.466V.534a.25.25 0 0 0-.41-.192L5.23 2.308a.25.25 0 0 0 0 .384l2.36 1.966A.25.25 0 0 0 8 4.466z" /></svg>
        <span className="prompt-editor-context-label">{t('promptNotebook.editor.contextMenu.undo')}</span>
      </button>

      <div className="prompt-editor-context-separator" role="separator" />

      {/* Group 2: clipboard primitives */}
      <button
        className="prompt-editor-context-item"
        role="menuitem"
        onClick={handleCut}
        disabled={!hasSelection}
        data-testid="pecm-cut"
      >
        <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M3.5 3.5c-.614-.884-.074-1.962.858-2.5L8 7.226 11.642 1c.932.538 1.472 1.616.858 2.5L8.81 8.61l1.556 2.661a2.5 2.5 0 1 1-.794.637L8 9.73l-1.572 2.177a2.5 2.5 0 1 1-.794-.637L7.19 8.61 3.5 3.5zm2.5 10a1.5 1.5 0 1 0-3 0 1.5 1.5 0 0 0 3 0zm7 0a1.5 1.5 0 1 0-3 0 1.5 1.5 0 0 0 3 0z" /></svg>
        <span className="prompt-editor-context-label">{t('promptNotebook.editor.contextMenu.cut')}</span>
        {renderShortcut(cutLabel)}
      </button>
      <button
        className="prompt-editor-context-item"
        role="menuitem"
        onClick={handleCopy}
        disabled={!hasSelection}
        data-testid="pecm-copy"
      >
        <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M4 2a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V2zm2-1a1 1 0 0 0-1 1v8a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1V2a1 1 0 0 0-1-1H6z" /><path d="M2 6a2 2 0 0 1 2-2v1a1 1 0 0 0-1 1v8a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1h1a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V6z" /></svg>
        <span className="prompt-editor-context-label">{t('promptNotebook.editor.contextMenu.copy')}</span>
        {renderShortcut(copyLabel)}
      </button>
      <button
        className="prompt-editor-context-item"
        role="menuitem"
        onClick={handlePaste}
        data-testid="pecm-paste"
      >
        <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M10 1.5a.5.5 0 0 0-.5-.5h-3a.5.5 0 0 0-.5.5v1a.5.5 0 0 0 .5.5h3a.5.5 0 0 0 .5-.5v-1zM5 1a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v1a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V1z" /><path d="M3 2.5A1.5 1.5 0 0 1 4.5 1h.585A1.98 1.98 0 0 0 5 2v1a2 2 0 0 0 2 2h2a2 2 0 0 0 2-2V2c0-.068-.004-.135-.011-.2H11.5A1.5 1.5 0 0 1 13 3.5v10a1.5 1.5 0 0 1-1.5 1.5h-7A1.5 1.5 0 0 1 3 13.5v-11z" /></svg>
        <span className="prompt-editor-context-label">{t('promptNotebook.editor.contextMenu.paste')}</span>
        {renderShortcut(pasteLabel)}
      </button>
      <button
        className="prompt-editor-context-item danger"
        role="menuitem"
        onClick={handleClearContent}
        disabled={!hasContent}
        data-testid="pecm-clear"
      >
        <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M5.5 5.5A.5.5 0 0 1 6 6v6a.5.5 0 0 1-1 0V6a.5.5 0 0 1 .5-.5zm2.5 0a.5.5 0 0 1 .5.5v6a.5.5 0 0 1-1 0V6a.5.5 0 0 1 .5-.5zm3 .5a.5.5 0 0 0-1 0v6a.5.5 0 0 0 1 0V6z" /><path d="M14.5 3a1 1 0 0 1-1 1H13v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V4h-.5a1 1 0 0 1-1-1V2a1 1 0 0 1 1-1H6a1 1 0 0 1 1-1h2a1 1 0 0 1 1 1h3.5a1 1 0 0 1 1 1v1zM4.118 4L4 4.059V13a1 1 0 0 0 1 1h6a1 1 0 0 0 1-1V4.059L11.882 4H4.118zM2.5 3V2h11v1h-11z" /></svg>
        <span className="prompt-editor-context-label">{t('promptNotebook.editor.contextMenu.clearAll')}</span>
      </button>

      <div className="prompt-editor-context-separator" role="separator" />

      {/* Group 3: Pin Prompt closed loop */}
      <div
        className="prompt-editor-context-submenu-wrapper"
        onMouseEnter={() => openSubmenu('pinPrimary')}
        onMouseLeave={scheduleCloseSubmenu}
      >
        <button
          className={`prompt-editor-context-item has-submenu ${submenu === 'pinPrimary' ? 'submenu-open' : ''}`}
          role="menuitem"
          aria-haspopup="menu"
          aria-expanded={submenu === 'pinPrimary'}
          onClick={() => openSubmenu('pinPrimary')}
          data-testid="pecm-import-pin"
        >
          <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M9.828.722a.5.5 0 0 1 .354.146l4.95 4.95a.5.5 0 0 1-.707.708l-.812-.813-3.05 3.05a.746.746 0 0 1-.11.143L8.95 10.41a.5.5 0 0 1-.354.147h-.002a.5.5 0 0 1-.353-.146L5.657 7.826a.5.5 0 0 1 0-.708L7.16 5.615a.746.746 0 0 1 .143-.11l3.05-3.05-.813-.812a.5.5 0 0 1 .288-.92zM7.864 6.354L6.414 7.804l2.782 2.782 1.45-1.45-2.782-2.782z" /><path d="M1.5 15a.5.5 0 0 1-.354-.854l4.5-4.5a.5.5 0 0 1 .708.708l-4.5 4.5A.5.5 0 0 1 1.5 15z" /></svg>
          <span className="prompt-editor-context-label">{t('promptNotebook.editor.contextMenu.importPin')}</span>
          <svg className="prompt-editor-context-chevron" width="10" height="10" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M4.646 1.646a.5.5 0 0 1 .708 0l6 6a.5.5 0 0 1 0 .708l-6 6a.5.5 0 0 1-.708-.708L10.293 8 4.646 2.354a.5.5 0 0 1 0-.708z" /></svg>
        </button>
        {submenu === 'pinPrimary' && (
          <div
            ref={submenuRef}
            className="prompt-editor-context-submenu"
            style={submenuStyle}
            role="menu"
            onMouseEnter={() => openSubmenu('pinPrimary')}
            onMouseLeave={scheduleCloseSubmenu}
            onMouseDown={(e) => e.stopPropagation()}
            data-testid="pecm-import-pin-submenu"
          >
            {sortedPinned.length === 0 ? (
              <div className="prompt-editor-context-empty">
                {t('promptNotebook.editor.contextMenu.noPinnedPrompts')}
              </div>
            ) : (
              <>
                {renderPinnedItems(visiblePinned)}
                {!showAllPinned && sortedPinned.length > PINNED_PRIMARY_LIMIT && (
                  <>
                    <div className="prompt-editor-context-separator" role="separator" />
                    <button
                      className="prompt-editor-context-item"
                      role="menuitem"
                      onClick={() => setShowAllPinned(true)}
                      data-testid="pecm-import-pin-show-all"
                    >
                      <span className="prompt-editor-context-label">
                        {t('promptNotebook.editor.contextMenu.viewAll', { count: sortedPinned.length })}
                      </span>
                    </button>
                  </>
                )}
              </>
            )}
          </div>
        )}
      </div>

      <button
        className="prompt-editor-context-item"
        role="menuitem"
        onClick={handleSaveAsPinned}
        disabled={!hasSelection}
        data-testid="pecm-save-as-pin"
      >
        <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M9 1H3.5A1.5 1.5 0 0 0 2 2.5v11A1.5 1.5 0 0 0 3.5 15h9a1.5 1.5 0 0 0 1.5-1.5V6h-4a1 1 0 0 1-1-1V1zm1 0v4h4L10 1zM8 8.75a.75.75 0 0 0-1.5 0V10H5.25a.75.75 0 0 0 0 1.5H6.5v1.25a.75.75 0 0 0 1.5 0V11.5h1.25a.75.75 0 0 0 0-1.5H8V8.75z" /></svg>
        <span className="prompt-editor-context-label">{t('promptNotebook.editor.contextMenu.saveAsPin')}</span>
      </button>

      <div className="prompt-editor-context-separator" role="separator" />

      {/* Group 4: project / branch / task title inserts */}
      <button
        className="prompt-editor-context-item"
        role="menuitem"
        onClick={handleInsertCwd}
        disabled={!currentCwd}
        title={currentCwd ?? undefined}
        data-testid="pecm-insert-cwd"
      >
        <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M14.5 3H7.71l-.85-.85A.5.5 0 0 0 6.5 2h-5a.5.5 0 0 0-.5.5v11a.5.5 0 0 0 .5.5h13a.5.5 0 0 0 .5-.5v-10a.5.5 0 0 0-.5-.5zM14 13H2V3h4.29l.85.85a.5.5 0 0 0 .36.15H14v9z" /></svg>
        <span className="prompt-editor-context-label">{t('promptNotebook.editor.contextMenu.insertProjectPath')}</span>
      </button>
      <button
        className="prompt-editor-context-item"
        role="menuitem"
        onClick={handleInsertBranch}
        disabled={!currentBranch}
        title={currentBranch ?? undefined}
        data-testid="pecm-insert-branch"
      >
        <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M11.75 2.5a.75.75 0 1 1 0 1.5.75.75 0 0 1 0-1.5zm-2.25.75a2.25 2.25 0 1 0 3 2.122V6A2.5 2.5 0 0 1 10 8.5H6a4 4 0 0 0-2.25.694v-5.34a2.25 2.25 0 1 0-1.5 0v5.388a2.25 2.25 0 1 0 1.5.028V9a2.5 2.5 0 0 1 2.5-2.5h4A4 4 0 0 0 14 5.6V5.372A2.25 2.25 0 0 0 9.5 3.25zM2.5 13.75a.75.75 0 1 1 1.5 0 .75.75 0 0 1-1.5 0z" /></svg>
        <span className="prompt-editor-context-label">{t('promptNotebook.editor.contextMenu.insertGitBranch')}</span>
      </button>
      <button
        className="prompt-editor-context-item"
        role="menuitem"
        onClick={handleInsertTaskTitle}
        disabled={!currentTaskTitle}
        title={currentTaskTitle ?? undefined}
        data-testid="pecm-insert-task-title"
      >
        <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M2.5 2a.5.5 0 0 0 0 1h11a.5.5 0 0 0 0-1h-11zM5 5.5a.5.5 0 0 1 .5-.5h5a.5.5 0 0 1 0 1H8.5v7a.5.5 0 0 1-1 0V6H5.5a.5.5 0 0 1-.5-.5z" /></svg>
        <span className="prompt-editor-context-label">{t('promptNotebook.editor.contextMenu.insertTaskTitle')}</span>
      </button>

    </div>,
    document.body
  )
}
