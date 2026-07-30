/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

import type { PresetCount } from '../types/prompt.ts'
import type { ResolvedLayout } from './layout-mode.ts'
import { CUSTOM_GRID_COLS, CUSTOM_GRID_ROWS } from './layout-mode.ts'

/**
 * A Task's footprint inside the mirrored mesh. 1-based, spans inclusive —
 * the same coordinate convention as CustomLayoutCell so a custom preset's
 * cells map across without translation.
 */
export interface TaskSelectorSlot {
  colStart: number
  colSpan: number
  rowStart: number
  rowSpan: number
}

export interface TaskSelectorGeometry {
  columns: number
  rows: number
  /** One entry per Task, in render order. Index i belongs to Task i. */
  slots: TaskSelectorSlot[]
}

/**
 * Track counts for every preset layout. This table MUST stay in lockstep
 * with the `.terminal-grid[data-layout="N"]` rules in
 * `src/components/TerminalGrid/TerminalGrid.css` — the whole point of the
 * Task selector is that its shape is the grid's shape. Drift is caught by
 * `test/unittest/task-selector-geometry.test.mts`, which parses that CSS
 * file and compares it against this table rather than trusting a comment.
 */
const PRESET_TRACKS: Readonly<Record<PresetCount, { columns: number; rows: number }>> = {
  1: { columns: 1, rows: 1 },
  2: { columns: 2, rows: 1 },
  4: { columns: 2, rows: 2 },
  6: { columns: 3, rows: 2 },
  8: { columns: 4, rows: 2 }
}

/**
 * Map a resolved Task layout onto the Prompt panel's selector grid.
 *
 * Preset layouts distribute uniform cells in row-major DOM order, exactly
 * like the CSS on the right-hand grid, so the slot list is derived rather
 * than stored. Custom layouts carry their rectangles explicitly, so index i
 * of the Task array claims cell i of the preset — the same index-to-cell
 * binding TerminalGrid uses. That binding is what makes drag-to-rearrange
 * show up here for free: reordering rewrites the Task array, and both grids
 * re-derive their placement from the new order.
 *
 * `taskCount` normally equals the layout's effective count; the overflow and
 * underflow branches exist only so a transient mismatch (Tasks still being
 * spawned after a layout grow) renders something sane instead of collapsing.
 */
export function getTaskSelectorGeometry(
  layout: ResolvedLayout,
  taskCount: number
): TaskSelectorGeometry {
  const count = Number.isFinite(taskCount) ? Math.max(0, Math.floor(taskCount)) : 0

  if (layout.kind === 'custom') {
    const slots = layout.cells.slice(0, count).map(cell => ({
      colStart: cell.colStart,
      colSpan: cell.colSpan,
      rowStart: cell.rowStart,
      rowSpan: cell.rowSpan
    }))
    // Surplus Tasks (more Tasks than the preset has rectangles) get no
    // explicit slot and fall through to auto-placement, so reserve rows for
    // them instead of letting them silently overlay the stored rectangles.
    const overflow = Math.max(0, count - layout.cells.length)
    const extraRows = Math.ceil(overflow / CUSTOM_GRID_COLS)
    return {
      columns: CUSTOM_GRID_COLS,
      rows: CUSTOM_GRID_ROWS + extraRows,
      slots
    }
  }

  const tracks = PRESET_TRACKS[layout.count]
  const columns = tracks.columns
  const rows = Math.max(tracks.rows, Math.ceil(count / columns))
  const slots = Array.from({ length: count }, (_unused, index) => ({
    colStart: (index % columns) + 1,
    colSpan: 1,
    rowStart: Math.floor(index / columns) + 1,
    rowSpan: 1
  }))
  return { columns, rows, slots }
}

/**
 * Compact identity of a geometry. Two geometries with the same signature
 * render identically — used as the diagnostic trace payload and as the
 * effect dependency that decides when to emit it.
 */
export function taskSelectorGeometrySignature(geometry: TaskSelectorGeometry): string {
  const slots = geometry.slots
    .map(slot => `${slot.colStart}.${slot.colSpan}.${slot.rowStart}.${slot.rowSpan}`)
    .join('_')
  return `${geometry.columns}x${geometry.rows}#${geometry.slots.length}[${slots}]`
}
