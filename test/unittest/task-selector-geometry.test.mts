/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 *
 * Unit tests for the Prompt panel's Task selector geometry — the pure map
 * from "which Task layout is active" to "what shape the selector draws".
 *
 * Two things are locked here:
 *   1. The mapping itself (preset track counts, custom rectangle pass-through,
 *      overflow / underflow behaviour, signature identity).
 *   2. Anti-drift: the preset track table is compared against the ACTUAL CSS
 *      in `src/components/TerminalGrid/TerminalGrid.css`. The selector's whole
 *      purpose is to be the same shape as the grid, so "someone changed the
 *      6-grid from 3x2 to 2x3 and forgot the selector" has to be a test
 *      failure, not something a reviewer is expected to notice.
 *
 * The wiring half (React render, container-query degradation, reorder
 * follow-through) is locked by `run-prompt-sender-autotest.sh` (PS-02,
 * PS-34..PS-38) and `run-task-layout-autotest.sh` (TLM-14).
 *
 * Usage: node --experimental-strip-types --test test/unittest/task-selector-geometry.test.mts
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  getTaskSelectorGeometry,
  taskSelectorGeometrySignature
} from '../../src/utils/task-selector-geometry.ts'
import {
  CUSTOM_GRID_COLS,
  CUSTOM_GRID_ROWS,
  resolveLayout,
  type ResolvedLayout
} from '../../src/utils/layout-mode.ts'
import type { CustomLayoutCell, CustomLayoutPreset, PresetCount } from '../../src/types/prompt.ts'

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(__dirname, '..', '..')
const TERMINAL_GRID_CSS = resolve(REPO_ROOT, 'src', 'components', 'TerminalGrid', 'TerminalGrid.css')

const PRESET_COUNTS: readonly PresetCount[] = [1, 2, 4, 6, 8]

function preset(count: PresetCount): ResolvedLayout {
  return { kind: 'preset', count, effectiveCount: count }
}

function custom(cells: CustomLayoutCell[]): ResolvedLayout {
  return {
    kind: 'custom',
    effectiveCount: cells.length,
    presetId: 'p1',
    presetName: 'Test preset',
    cells
  }
}

/**
 * "One big cell on the left, two stacked on the right" — the canonical
 * non-uniform layout, and the one where a naive row-major selector would be
 * visibly wrong.
 */
const L_SHAPED_CELLS: CustomLayoutCell[] = [
  { rowStart: 1, rowSpan: 2, colStart: 1, colSpan: 2 },
  { rowStart: 1, rowSpan: 1, colStart: 3, colSpan: 2 },
  { rowStart: 2, rowSpan: 1, colStart: 3, colSpan: 2 }
]

// ───────────────────────── CSS anti-drift ─────────────────────────

/** Count the tracks a `grid-template-*` value declares. */
function countTracks(value: string): number {
  const repeatMatch = /^repeat\(\s*(\d+)\s*,/.exec(value.trim())
  if (repeatMatch) return Number(repeatMatch[1])
  return value.trim().split(/\s+/).filter(Boolean).length
}

/** Read the column / row track counts a `[data-layout="X"]` rule declares. */
function readLayoutRule(css: string, layoutAttr: string): { columns: number; rows: number } {
  const ruleMatch = new RegExp(
    `\\.terminal-grid\\[data-layout="${layoutAttr}"\\]\\s*\\{([^}]*)\\}`
  ).exec(css)
  assert.ok(ruleMatch, `TerminalGrid.css has no rule for [data-layout="${layoutAttr}"]`)
  const body = ruleMatch![1]
  const columnsMatch = /grid-template-columns:\s*([^;]+);/.exec(body)
  const rowsMatch = /grid-template-rows:\s*([^;]+);/.exec(body)
  assert.ok(columnsMatch, `[data-layout="${layoutAttr}"] declares no grid-template-columns`)
  assert.ok(rowsMatch, `[data-layout="${layoutAttr}"] declares no grid-template-rows`)
  return { columns: countTracks(columnsMatch![1]), rows: countTracks(rowsMatch![1]) }
}

test('TSG-U-01 preset track counts match the real TerminalGrid CSS', () => {
  const css = readFileSync(TERMINAL_GRID_CSS, 'utf8')
  for (const count of PRESET_COUNTS) {
    const fromCss = readLayoutRule(css, String(count))
    const geometry = getTaskSelectorGeometry(preset(count), count)
    assert.deepEqual(
      { columns: geometry.columns, rows: geometry.rows },
      fromCss,
      `selector geometry for preset ${count} drifted from TerminalGrid.css`
    )
    assert.equal(
      fromCss.columns * fromCss.rows,
      count,
      `preset ${count} CSS declares ${fromCss.columns}x${fromCss.rows} tracks`
    )
  }
})

test('TSG-U-02 custom mesh size matches the real TerminalGrid CSS', () => {
  const css = readFileSync(TERMINAL_GRID_CSS, 'utf8')
  const fromCss = readLayoutRule(css, 'custom')
  assert.equal(fromCss.columns, CUSTOM_GRID_COLS)
  assert.equal(fromCss.rows, CUSTOM_GRID_ROWS)

  const geometry = getTaskSelectorGeometry(custom(L_SHAPED_CELLS), L_SHAPED_CELLS.length)
  assert.equal(geometry.columns, fromCss.columns)
  assert.equal(geometry.rows, fromCss.rows)
})

// ───────────────────────── Preset mapping ─────────────────────────

test('TSG-U-03 preset slots are laid out row-major, one atomic cell each', () => {
  const geometry = getTaskSelectorGeometry(preset(6), 6)
  assert.equal(geometry.columns, 3)
  assert.equal(geometry.rows, 2)
  assert.deepEqual(geometry.slots, [
    { colStart: 1, colSpan: 1, rowStart: 1, rowSpan: 1 },
    { colStart: 2, colSpan: 1, rowStart: 1, rowSpan: 1 },
    { colStart: 3, colSpan: 1, rowStart: 1, rowSpan: 1 },
    { colStart: 1, colSpan: 1, rowStart: 2, rowSpan: 1 },
    { colStart: 2, colSpan: 1, rowStart: 2, rowSpan: 1 },
    { colStart: 3, colSpan: 1, rowStart: 2, rowSpan: 1 }
  ])
})

test('TSG-U-04 single-Task preset is a single full-width slot', () => {
  const geometry = getTaskSelectorGeometry(preset(1), 1)
  assert.equal(geometry.columns, 1)
  assert.equal(geometry.rows, 1)
  assert.deepEqual(geometry.slots, [{ colStart: 1, colSpan: 1, rowStart: 1, rowSpan: 1 }])
})

test('TSG-U-05 two-Task preset is one row of two, not two rows of one', () => {
  const geometry = getTaskSelectorGeometry(preset(2), 2)
  assert.equal(geometry.columns, 2)
  assert.equal(geometry.rows, 1)
  assert.deepEqual(geometry.slots.map(s => s.rowStart), [1, 1])
})

test('TSG-U-06 eight-Task preset is 4x2 (the old hardcoded 2-column model was 2x4)', () => {
  const geometry = getTaskSelectorGeometry(preset(8), 8)
  assert.equal(geometry.columns, 4)
  assert.equal(geometry.rows, 2)
  assert.deepEqual(geometry.slots.map(s => s.colStart), [1, 2, 3, 4, 1, 2, 3, 4])
  assert.deepEqual(geometry.slots.map(s => s.rowStart), [1, 1, 1, 1, 2, 2, 2, 2])
})

test('TSG-U-07 fewer Tasks than slots keeps the track counts (grid shape is the layout, not the Task count)', () => {
  // Transient state while a layout grow is still spawning PTYs.
  const geometry = getTaskSelectorGeometry(preset(8), 3)
  assert.equal(geometry.columns, 4)
  assert.equal(geometry.rows, 2)
  assert.equal(geometry.slots.length, 3)
})

test('TSG-U-08 zero Tasks still reports the layout shape', () => {
  const geometry = getTaskSelectorGeometry(preset(4), 0)
  assert.deepEqual(
    { columns: geometry.columns, rows: geometry.rows, slots: geometry.slots.length },
    { columns: 2, rows: 2, slots: 0 }
  )
})

test('TSG-U-09 more Tasks than the preset holds grows extra rows instead of overlapping', () => {
  const geometry = getTaskSelectorGeometry(preset(4), 6)
  assert.equal(geometry.columns, 2)
  assert.equal(geometry.rows, 3)
  assert.equal(geometry.slots.length, 6)
  assert.deepEqual(geometry.slots[5], { colStart: 2, colSpan: 1, rowStart: 3, rowSpan: 1 })
})

// ───────────────────────── Custom mapping ─────────────────────────

test('TSG-U-10 custom cells pass through unchanged, index for index', () => {
  const geometry = getTaskSelectorGeometry(custom(L_SHAPED_CELLS), 3)
  assert.deepEqual(geometry.slots, [
    { colStart: 1, colSpan: 2, rowStart: 1, rowSpan: 2 },
    { colStart: 3, colSpan: 2, rowStart: 1, rowSpan: 1 },
    { colStart: 3, colSpan: 2, rowStart: 2, rowSpan: 1 }
  ])
})

test('TSG-U-11 reordering Tasks re-binds them to slots by index (drag-to-rearrange contract)', () => {
  // The rearrange gesture rewrites the Task array; both grids re-derive
  // placement from the new order. Slot i therefore belongs to Task i BEFORE
  // and AFTER a move — which is exactly why no reorder-specific code is
  // needed in the selector.
  const before = ['A', 'B', 'C']
  const after = ['B', 'C', 'A']
  const geometry = getTaskSelectorGeometry(custom(L_SHAPED_CELLS), 3)
  const place = (order: readonly string[]) =>
    order.map((id, index) => ({ id, slot: geometry.slots[index] }))

  assert.deepEqual(place(before), [
    { id: 'A', slot: L_SHAPED_CELLS[0] },
    { id: 'B', slot: L_SHAPED_CELLS[1] },
    { id: 'C', slot: L_SHAPED_CELLS[2] }
  ])
  // After the move the BIG left rectangle belongs to B and A holds the
  // bottom-right one — the slot list itself never changed.
  assert.deepEqual(place(after), [
    { id: 'B', slot: L_SHAPED_CELLS[0] },
    { id: 'C', slot: L_SHAPED_CELLS[1] },
    { id: 'A', slot: L_SHAPED_CELLS[2] }
  ])
})

test('TSG-U-12 fewer Tasks than custom cells truncates the slot list, keeps the mesh', () => {
  const geometry = getTaskSelectorGeometry(custom(L_SHAPED_CELLS), 2)
  assert.equal(geometry.columns, CUSTOM_GRID_COLS)
  assert.equal(geometry.rows, CUSTOM_GRID_ROWS)
  assert.equal(geometry.slots.length, 2)
})

test('TSG-U-13 surplus Tasks beyond the custom cells reserve extra rows', () => {
  const geometry = getTaskSelectorGeometry(custom(L_SHAPED_CELLS), 8)
  assert.equal(geometry.columns, CUSTOM_GRID_COLS)
  // 5 surplus Tasks over a 4-wide mesh → 2 extra auto-placed rows.
  assert.equal(geometry.rows, CUSTOM_GRID_ROWS + 2)
  assert.equal(geometry.slots.length, 3, 'surplus Tasks get no explicit slot, they auto-place')
})

test('TSG-U-14 a custom layout referencing a deleted preset degrades to single, on both sides', () => {
  const presets: CustomLayoutPreset[] = []
  const resolved = resolveLayout({ kind: 'custom', presetId: 'gone' }, presets)
  const geometry = getTaskSelectorGeometry(resolved, 1)
  assert.equal(resolved.kind, 'preset')
  assert.deepEqual({ columns: geometry.columns, rows: geometry.rows }, { columns: 1, rows: 1 })
})

// ───────────────────────── Signature ─────────────────────────

test('TSG-U-15 signature is stable for identical shapes and differs across layouts', () => {
  const a = taskSelectorGeometrySignature(getTaskSelectorGeometry(preset(4), 4))
  const b = taskSelectorGeometrySignature(getTaskSelectorGeometry(preset(4), 4))
  const c = taskSelectorGeometrySignature(getTaskSelectorGeometry(preset(6), 6))
  const d = taskSelectorGeometrySignature(getTaskSelectorGeometry(custom(L_SHAPED_CELLS), 3))
  assert.equal(a, b, 'same layout + same Task count must not re-emit the sync trace')
  assert.notEqual(a, c)
  assert.notEqual(a, d)
})

test('TSG-U-16 signature moves when the Task count changes under a fixed layout', () => {
  const full = taskSelectorGeometrySignature(getTaskSelectorGeometry(preset(8), 8))
  const partial = taskSelectorGeometrySignature(getTaskSelectorGeometry(preset(8), 5))
  assert.notEqual(full, partial)
})

test('TSG-U-17 a non-finite Task count is treated as zero rather than crashing the panel', () => {
  const geometry = getTaskSelectorGeometry(preset(4), Number.NaN)
  assert.equal(geometry.slots.length, 0)
  assert.equal(geometry.columns, 2)
})
