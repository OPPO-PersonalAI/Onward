/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { PointerEvent as ReactPointerEvent } from 'react'
import { createPortal } from 'react-dom'
import { useI18n } from '../../i18n/useI18n'
import { useViewportMenuPosition } from '../../hooks/useViewportMenuPosition'
import {
  CUSTOM_GRID_COLS,
  CUSTOM_GRID_ROWS,
  CUSTOM_GRID_TOTAL_CELLS
} from '../../utils/layout-mode'
import {
  validateCustomLayout,
  type CustomLayoutValidationError
} from '../../utils/custom-layout-validator'
import type { CustomLayoutCell } from '../../types/prompt'
import { perfTrace } from '../../utils/perf-trace'
import { PERF_TRACE_EVENT } from '../../utils/perf-trace-names'
import './CustomLayoutEditor.css'

interface AtomCoord {
  row: number // 1-based
  col: number // 1-based
}

interface CandidateRect {
  rowStart: number
  rowEnd: number
  colStart: number
  colEnd: number
}

interface DragState {
  pointerId: number
  origin: AtomCoord
  current: AtomCoord
}

interface EditorCell {
  id: string
  rect: CandidateRect
  taskIndex: number | null
}

let cellIdSeq = 0
const newCellId = () => `cell-${Date.now().toString(36)}-${++cellIdSeq}`

function rectToCell(rect: CandidateRect): CustomLayoutCell {
  return {
    rowStart: rect.rowStart as 1 | 2,
    rowSpan: (rect.rowEnd - rect.rowStart + 1) as 1 | 2,
    colStart: rect.colStart as 1 | 2 | 3 | 4,
    colSpan: (rect.colEnd - rect.colStart + 1) as 1 | 2 | 3 | 4
  }
}

function cellToRect(cell: CustomLayoutCell): CandidateRect {
  return {
    rowStart: cell.rowStart,
    rowEnd: cell.rowStart + cell.rowSpan - 1,
    colStart: cell.colStart,
    colEnd: cell.colStart + cell.colSpan - 1
  }
}

function rectFromAtoms(a: AtomCoord, b: AtomCoord): CandidateRect {
  return {
    rowStart: Math.min(a.row, b.row),
    rowEnd: Math.max(a.row, b.row),
    colStart: Math.min(a.col, b.col),
    colEnd: Math.max(a.col, b.col)
  }
}

function rectIntersectsRect(a: CandidateRect, b: CandidateRect): boolean {
  return !(
    a.rowEnd < b.rowStart || a.rowStart > b.rowEnd ||
    a.colEnd < b.colStart || a.colStart > b.colEnd
  )
}

function rectContainsAtom(rect: CandidateRect, atom: AtomCoord): boolean {
  return (
    atom.row >= rect.rowStart && atom.row <= rect.rowEnd &&
    atom.col >= rect.colStart && atom.col <= rect.colEnd
  )
}

const ERROR_KEY: Record<CustomLayoutValidationError, string> = {
  empty: 'sidebar.layout.custom.editor.error.empty',
  overlap: 'sidebar.layout.custom.editor.error.overlap',
  'out-of-bounds': 'sidebar.layout.custom.editor.error.outOfBounds',
  'incomplete-coverage': 'sidebar.layout.custom.editor.error.coverage',
  'too-many-cells': 'sidebar.layout.custom.editor.error.tooMany'
}

/**
 * Editor-side validation errors that don't apply to the persisted
 * CustomLayoutCell shape (which only carries geometry). Kept narrow on
 * purpose so the i18n key map stays exhaustive.
 */
type EditorValidationError = 'unassigned' | 'non-contiguous'

/**
 * Map a viewport pointer (clientX/Y) into the 2x4 atomic mesh by pure
 * geometry — no DOM hit testing, no third-party gesture library.
 *
 * Why geometry instead of `elementFromPoint`:
 *   1. elementFromPoint depends on every ancestor's pointer-events,
 *      z-index, transform stacking and live DOM state. A single
 *      `pointer-events: auto` accident on an overlay flips hit
 *      results to the wrong layer.
 *   2. Geometry is O(1) arithmetic and has no race window with React
 *      re-renders — the value depends only on the live grid rect.
 *   3. We can clamp the pointer onto the nearest grid edge for free,
 *      so a user who drags slightly outside the grid still snaps the
 *      candidate rectangle to the boundary cell instead of the drag
 *      "freezing".
 *
 * This is the same approach react-grid-layout, react-resizable and
 * react-selectable use for their marquee maths.
 */
function pointToAtom(gridEl: HTMLDivElement | null, clientX: number, clientY: number): AtomCoord | null {
  if (!gridEl) return null
  const rect = gridEl.getBoundingClientRect()
  if (rect.width <= 0 || rect.height <= 0) return null
  const cellW = rect.width / CUSTOM_GRID_COLS
  const cellH = rect.height / CUSTOM_GRID_ROWS
  const localX = clientX - rect.left
  const localY = clientY - rect.top
  const col = Math.max(1, Math.min(CUSTOM_GRID_COLS, Math.floor(localX / cellW) + 1))
  const row = Math.max(1, Math.min(CUSTOM_GRID_ROWS, Math.floor(localY / cellH) + 1))
  return { row, col }
}

interface CustomLayoutEditorProps {
  initialName?: string
  initialCells?: CustomLayoutCell[]
  onSave: (payload: { name: string; cells: CustomLayoutCell[] }) => void
  onCancel: () => void
}

export function CustomLayoutEditor({
  initialName,
  initialCells,
  onSave,
  onCancel
}: CustomLayoutEditorProps) {
  const { t } = useI18n()
  const [name, setName] = useState<string>(initialName ?? '')

  const [cells, setCells] = useState<EditorCell[]>(() => {
    if (!initialCells) return []
    return initialCells.map((cell, index) => ({
      id: newCellId(),
      rect: cellToRect(cell),
      taskIndex: index + 1
    }))
  })
  const [drag, setDrag] = useState<DragState | null>(null)
  const [contextMenu, setContextMenu] = useState<{ cellId: string; x: number; y: number } | null>(null)
  const [serverError, setServerError] = useState<CustomLayoutValidationError | null>(null)

  const gridRef = useRef<HTMLDivElement | null>(null)
  const cellsRef = useRef<EditorCell[]>(cells)
  cellsRef.current = cells
  const opened = useRef(false)

  useEffect(() => {
    if (opened.current) return
    opened.current = true
    perfTrace(PERF_TRACE_EVENT.RENDERER_CUSTOM_LAYOUT_EDITOR_OPEN, {
      mode: initialCells ? 'edit' : 'create',
      seedCellCount: initialCells?.length ?? 0
    })
  }, [initialCells])

  const usedTaskIndexes = useMemo(() => {
    const set = new Set<number>()
    for (const c of cells) if (c.taskIndex !== null) set.add(c.taskIndex)
    return set
  }, [cells])

  // ── Native PointerEvents drag ──
  // setPointerCapture on the grid element keeps every move/up event
  // routed back to the grid even if the pointer leaves the element's
  // box mid-drag. Combined with the geometry-based `pointToAtom`
  // helper, this gives a marquee selection that feels like the system
  // file manager: continuous, no skipped cells, no gesture-library
  // surprises.
  const handlePointerDown = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return // left button only
    if (contextMenu) return
    const atom = pointToAtom(gridRef.current, event.clientX, event.clientY)
    if (!atom) return
    if (cellsRef.current.some(c => rectContainsAtom(c.rect, atom))) return
    event.preventDefault()
    try {
      event.currentTarget.setPointerCapture(event.pointerId)
    } catch {
      // setPointerCapture can throw if the element was unmounted
      // mid-event; bail silently — drag won't start, no harm done.
      return
    }
    setServerError(null)
    setDrag({ pointerId: event.pointerId, origin: atom, current: atom })
  }, [contextMenu])

  const handlePointerMove = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (!drag || drag.pointerId !== event.pointerId) return
    const atom = pointToAtom(gridRef.current, event.clientX, event.clientY)
    if (!atom) return
    if (atom.row === drag.current.row && atom.col === drag.current.col) return
    setDrag({ ...drag, current: atom })
  }, [drag])

  const finishDrag = useCallback((event: ReactPointerEvent<HTMLDivElement>, commit: boolean) => {
    if (!drag || drag.pointerId !== event.pointerId) return
    try {
      event.currentTarget.releasePointerCapture(event.pointerId)
    } catch {
      // Already released by the browser (e.g. element unmounting); nop.
    }
    if (commit) {
      const rect = rectFromAtoms(drag.origin, drag.current)
      const conflicts = cellsRef.current.some(c => rectIntersectsRect(rect, c.rect))
      const exhausted = cellsRef.current.length >= CUSTOM_GRID_TOTAL_CELLS
      if (!conflicts && !exhausted) {
        setCells(prev => [...prev, { id: newCellId(), rect, taskIndex: null }])
      }
    }
    setDrag(null)
  }, [drag])

  const handlePointerUp = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    finishDrag(event, true)
  }, [finishDrag])

  const handlePointerCancel = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    finishDrag(event, false)
  }, [finishDrag])

  const candidate = useMemo<{ rect: CandidateRect; conflicts: boolean } | null>(() => {
    if (!drag) return null
    const rect = rectFromAtoms(drag.origin, drag.current)
    const conflicts = cells.some(c => rectIntersectsRect(rect, c.rect))
    return { rect, conflicts }
  }, [drag, cells])

  const removeCell = useCallback((cellId: string) => {
    setCells(prev => prev.filter(c => c.id !== cellId))
    setServerError(null)
  }, [])

  const clearAll = useCallback(() => {
    setCells([])
    setDrag(null)
    setContextMenu(null)
    setServerError(null)
  }, [])

  const assignNumber = useCallback((cellId: string, taskIndex: number | null) => {
    setCells(prev => {
      const stripped = prev.map(c =>
        c.id !== cellId && c.taskIndex === taskIndex ? { ...c, taskIndex: null } : c
      )
      return stripped.map(c => c.id === cellId ? { ...c, taskIndex } : c)
    })
    setServerError(null)
  }, [])

  const sortedCells = useMemo(() => {
    return [...cells].sort((a, b) => {
      if (a.taskIndex === null) return 1
      if (b.taskIndex === null) return -1
      return a.taskIndex - b.taskIndex
    })
  }, [cells])

  const allAssigned = useMemo(() => cells.every(c => c.taskIndex !== null), [cells])

  /**
   * Task numbers must be exactly 1..cells.length. The persisted
   * CustomLayoutCell carries no taskIndex field — cells are read back
   * by array order — so the editor needs to enforce contiguity here or
   * a "Task 1 + Task 8" layout would silently render as "Task 1 + Task
   * 2" after reload.
   */
  const isContiguous = useMemo(() => {
    if (!allAssigned) return false
    const seen = new Set<number>()
    for (const c of cells) {
      const idx = c.taskIndex as number
      if (idx < 1 || idx > cells.length) return false
      if (seen.has(idx)) return false
      seen.add(idx)
    }
    return seen.size === cells.length
  }, [allAssigned, cells])

  const validation = useMemo<
    | { valid: true; error: null }
    | { valid: false; error: EditorValidationError | CustomLayoutValidationError }
  >(() => {
    if (!allAssigned) return { valid: false, error: 'unassigned' }
    if (!isContiguous) return { valid: false, error: 'non-contiguous' }
    const geom = validateCustomLayout(sortedCells.map(c => rectToCell(c.rect)))
    if (!geom.valid && geom.error) return { valid: false, error: geom.error }
    return { valid: true, error: null }
  }, [allAssigned, isContiguous, sortedCells])

  const handleSave = useCallback(() => {
    if (!validation.valid) {
      setServerError(null)
      return
    }
    const exportCells = sortedCells.map(c => rectToCell(c.rect))
    const geom = validateCustomLayout(exportCells)
    if (!geom.valid && geom.error) {
      setServerError(geom.error)
      return
    }
    const trimmed = name.trim()
    onSave({
      name: trimmed.length > 0 ? trimmed : t('sidebar.layout.custom.untitled'),
      cells: exportCells
    })
  }, [validation.valid, sortedCells, name, onSave, t])

  const errorMessageKey = useMemo(() => {
    if (serverError) return ERROR_KEY[serverError]
    if (validation.valid) return null
    const err = validation.error
    if (err === 'unassigned') return 'sidebar.layout.custom.editor.error.unassigned'
    if (err === 'non-contiguous') return 'sidebar.layout.custom.editor.error.nonContiguous'
    return ERROR_KEY[err]
  }, [serverError, validation])

  const contextMenuTarget = contextMenu ? cells.find(c => c.id === contextMenu.cellId) ?? null : null

  return (
    <div className="custom-layout-editor" role="dialog" aria-modal="true">
      <div className="custom-layout-editor-header">
        <span className="custom-layout-editor-title">{t('sidebar.layout.custom.editor.title')}</span>
      </div>

      <input
        type="text"
        className="custom-layout-editor-name"
        value={name}
        placeholder={t('sidebar.layout.custom.editor.namePlaceholder')}
        onChange={(e) => setName(e.target.value)}
        maxLength={40}
      />

      <p className="custom-layout-editor-hint">{t('sidebar.layout.custom.editor.hint')}</p>

      <div
        ref={gridRef}
        className={`custom-layout-editor-grid ${drag ? 'is-dragging' : ''}`}
        style={{
          gridTemplateColumns: `repeat(${CUSTOM_GRID_COLS}, 1fr)`,
          gridTemplateRows: `repeat(${CUSTOM_GRID_ROWS}, 1fr)`,
          touchAction: 'none'
        }}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerCancel}
      >
        {Array.from({ length: CUSTOM_GRID_ROWS }, (_, r) =>
          Array.from({ length: CUSTOM_GRID_COLS }, (_, c) => {
            const row = r + 1
            const col = c + 1
            return (
              <div
                key={`atom-${row}-${col}`}
                className="custom-layout-editor-atom"
                data-atom-row={row}
                data-atom-col={col}
              />
            )
          })
        )}

        {cells.map((cell) => {
          const assigned = cell.taskIndex !== null
          return (
            <div
              key={cell.id}
              className={`custom-layout-editor-cell ${assigned ? 'is-assigned' : 'is-unassigned'}`}
              style={{
                gridColumn: `${cell.rect.colStart} / span ${cell.rect.colEnd - cell.rect.colStart + 1}`,
                gridRow: `${cell.rect.rowStart} / span ${cell.rect.rowEnd - cell.rect.rowStart + 1}`
              }}
              onClick={(e) => {
                // Single click on a settled region opens the Task-number
                // picker. We stop propagation so the click never bubbles
                // to the grid container — only the close-on-outside
                // listener inside CellContextMenu should observe further
                // clicks while the menu is open.
                e.stopPropagation()
                setContextMenu({ cellId: cell.id, x: e.clientX, y: e.clientY })
              }}
              onContextMenu={(e) => {
                // Suppress the OS context menu on right-click — assignment
                // is now a left-click action and showing the system menu
                // here would distract.
                e.preventDefault()
              }}
            >
              <span className={`custom-layout-editor-cell-label ${assigned ? '' : 'is-unassigned-label'}`}>
                {assigned
                  ? t('sidebar.layout.custom.editor.cellLabel', { index: cell.taskIndex! })
                  : t('sidebar.layout.custom.editor.unassigned')}
              </span>
              <button
                type="button"
                className="custom-layout-editor-cell-remove"
                onPointerDown={(e) => e.stopPropagation()}
                onClick={(e) => {
                  e.stopPropagation()
                  removeCell(cell.id)
                }}
                aria-label={t('sidebar.layout.custom.delete')}
              >
                ×
              </button>
            </div>
          )
        })}

        {candidate && (
          <div
            className={`custom-layout-editor-candidate ${candidate.conflicts ? 'is-invalid' : ''}`}
            style={{
              gridColumn: `${candidate.rect.colStart} / span ${candidate.rect.colEnd - candidate.rect.colStart + 1}`,
              gridRow: `${candidate.rect.rowStart} / span ${candidate.rect.rowEnd - candidate.rect.rowStart + 1}`
            }}
          />
        )}
      </div>

      {errorMessageKey && (
        <div className="custom-layout-editor-error">
          {/* All keys come from the editor's own subtree; cast widens to t's typed union for the lookup. */}
          {t(errorMessageKey as Parameters<typeof t>[0])}
        </div>
      )}

      <div className="custom-layout-editor-actions">
        <button type="button" className="custom-layout-editor-secondary" onClick={clearAll}>
          {t('sidebar.layout.custom.editor.reset')}
        </button>
        <div className="custom-layout-editor-actions-end">
          <button type="button" className="custom-layout-editor-secondary" onClick={onCancel}>
            {t('sidebar.layout.custom.editor.cancel')}
          </button>
          <button
            type="button"
            className="custom-layout-editor-primary"
            onClick={handleSave}
            disabled={!validation.valid}
          >
            {t('sidebar.layout.custom.editor.save')}
          </button>
        </div>
      </div>

      {contextMenuTarget && contextMenu && (
        <CellContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          targetCell={contextMenuTarget}
          usedIndexes={usedTaskIndexes}
          totalCells={cells.length}
          onAssign={(taskIndex) => {
            assignNumber(contextMenuTarget.id, taskIndex)
            setContextMenu(null)
          }}
          onResetIndex={() => {
            assignNumber(contextMenuTarget.id, null)
            setContextMenu(null)
          }}
          onDelete={() => {
            removeCell(contextMenuTarget.id)
            setContextMenu(null)
          }}
          onClose={() => setContextMenu(null)}
        />
      )}
    </div>
  )
}

interface CellContextMenuProps {
  x: number
  y: number
  targetCell: EditorCell
  usedIndexes: ReadonlySet<number>
  /** Total drawn regions (1..N). Numbers > N are disabled because the
   *  saved CustomLayoutCell[] is index-stable; a Task 8 in a 2-cell
   *  layout would render as Task 2 after reload. */
  totalCells: number
  onAssign: (taskIndex: number) => void
  onResetIndex: () => void
  onDelete: () => void
  onClose: () => void
}

function CellContextMenu({ x, y, targetCell, usedIndexes, totalCells, onAssign, onResetIndex, onDelete, onClose }: CellContextMenuProps) {
  const { t } = useI18n()
  const menuRef = useRef<HTMLDivElement | null>(null)
  // Shared viewport-aware placement (flip-then-clamp, measured pre-paint —
  // the old useEffect version corrected after paint, flashing one frame at
  // the raw cursor position).
  const effective = useViewportMenuPosition(menuRef, { x, y }, { surface: 'custom-layout-cell' })
  const position = { left: effective?.x ?? x, top: effective?.y ?? y }

  useEffect(() => {
    const handlePointerDown = (event: MouseEvent) => {
      if (!menuRef.current) return
      if (menuRef.current.contains(event.target as Node)) return
      onClose()
    }
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation()
        onClose()
      }
    }
    document.addEventListener('mousedown', handlePointerDown)
    document.addEventListener('keydown', handleKey, true)
    return () => {
      document.removeEventListener('mousedown', handlePointerDown)
      document.removeEventListener('keydown', handleKey, true)
    }
  }, [onClose])

  return createPortal(
    <div
      ref={menuRef}
      className="custom-layout-cell-context"
      style={{ left: position.left, top: position.top }}
      role="menu"
      onContextMenu={(e) => e.preventDefault()}
    >
      <div className="custom-layout-cell-context-title">{t('sidebar.layout.custom.picker.title')}</div>
      <div className="custom-layout-cell-context-grid">
        {Array.from({ length: CUSTOM_GRID_TOTAL_CELLS }, (_, i) => {
          const value = i + 1
          const usedByOther = usedIndexes.has(value) && targetCell.taskIndex !== value
          const current = targetCell.taskIndex === value
          // Numbers > totalCells are disabled to keep saved cells
          // index-stable (see comment on CellContextMenuProps.totalCells).
          // The cell's *current* taskIndex is always allowed so picking
          // it again is a confirm-style no-op, not a forced demotion.
          const outOfRange = value > totalCells && !current
          const reason = outOfRange
            ? 'sidebar.layout.custom.picker.outOfRange'
            : (usedByOther ? 'sidebar.layout.custom.picker.taken' : null)
          return (
            <button
              key={value}
              type="button"
              className={`custom-layout-cell-context-num ${current ? 'is-current' : ''}`}
              disabled={usedByOther || outOfRange}
              onClick={() => onAssign(value)}
              title={reason ? t(reason) : ''}
            >
              {value}
            </button>
          )
        })}
      </div>

      <div className="custom-layout-cell-context-divider" />

      <button
        type="button"
        className="custom-layout-cell-context-item"
        onClick={onResetIndex}
        disabled={targetCell.taskIndex === null}
      >
        <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
          <path d="M8 3.5c2.485 0 4.5 2.015 4.5 4.5S10.485 12.5 8 12.5 3.5 10.485 3.5 8c0-1.16.44-2.218 1.16-3.014l-.84-.84A5.48 5.48 0 0 0 2.5 8c0 3.038 2.462 5.5 5.5 5.5S13.5 11.038 13.5 8 11.038 2.5 8 2.5V1L5 3.5 8 6V3.5z" />
        </svg>
        <span>{t('sidebar.layout.custom.menu.reset')}</span>
      </button>

      <button
        type="button"
        className="custom-layout-cell-context-item is-danger"
        onClick={onDelete}
      >
        <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
          <path d="M6 2h4l1 1h3v1H2V3h3l1-1zm-2 3h8v8.5A1.5 1.5 0 0 1 10.5 15h-5A1.5 1.5 0 0 1 4 13.5V5zm2 2v6h1V7H6zm3 0v6h1V7H9z" />
        </svg>
        <span>{t('sidebar.layout.custom.menu.delete')}</span>
      </button>
    </div>,
    document.body
  )
}
