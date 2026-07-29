/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Pure geometry + list math behind Task drag-to-rearrange.
 *
 * Everything here is deliberately DOM-free so the whole decision surface can
 * be locked by plain Node unit tests: the renderer measures real rectangles
 * once at drag start, hands them in as plain objects, and this module answers
 * "which slot is the pointer over" and "where does every other cell have to
 * slide to" without ever touching the document.
 *
 * Reorder semantics are INSERT-SHIFT (iPhone home screen / VS Code editor
 * groups), not swap: dragging index 0 onto index 3 of [A,B,C,D,E,F] yields
 * [B,C,D,A,E,F] — the passed-over items each shift back by one and their
 * relative order is preserved. See `reorderByInsert`.
 */

/**
 * Axis-aligned rectangle of one grid slot, in viewport coordinates.
 * Mirrors the useful subset of DOMRect so callers can pass a DOMRect
 * directly while tests pass object literals.
 */
export interface SlotRect {
  left: number
  top: number
  width: number
  height: number
}

/** A point in the same coordinate space as the slot rectangles. */
export interface SlotPoint {
  x: number
  y: number
}

/**
 * FLIP transform that moves a cell from its own slot onto another slot.
 * Applied with `transform-origin: 0 0` as `translate(dx, dy) scale(sx, sy)`.
 *
 * scaleX / scaleY are always 1 for preset layouts (every slot is the same
 * size) and only diverge under custom layouts, where a Task can shift from a
 * 2x2 rectangle onto a 1x1 one. Without the scale term the preview would let
 * a large cell overhang its neighbours and misrepresent the drop result.
 */
export interface SlotShift {
  dx: number
  dy: number
  scaleX: number
  scaleY: number
}

/** Identity transform — the cell stays exactly where it already is. */
export const IDENTITY_SHIFT: SlotShift = { dx: 0, dy: 0, scaleX: 1, scaleY: 1 }

function isIndexInRange(index: number, length: number): boolean {
  return Number.isInteger(index) && index >= 0 && index < length
}

/**
 * Insert-shift reorder: pull the item out of `fromIndex` and splice it back
 * in at `toIndex`, letting every item in between close the gap.
 *
 * Returns the SAME array reference when the move is a no-op (equal indices)
 * or when either index is out of range, so callers can use referential
 * equality as their "nothing changed, skip the state write" guard.
 */
export function reorderByInsert<T>(
  list: readonly T[],
  fromIndex: number,
  toIndex: number
): readonly T[] {
  if (!isIndexInRange(fromIndex, list.length)) return list
  if (!isIndexInRange(toIndex, list.length)) return list
  if (fromIndex === toIndex) return list

  const next = list.slice()
  const [moved] = next.splice(fromIndex, 1)
  next.splice(toIndex, 0, moved)
  return next
}

/**
 * Slot index whose rectangle contains `point`, or null when the pointer is
 * outside every slot (dragged into the gutter or off the grid).
 *
 * Callers are expected to keep their previous target when this returns null
 * rather than snapping back to the origin — a pointer crossing the 1px seam
 * between two cells must not cancel the in-flight preview.
 *
 * Later slots win on overlap. Custom layouts are authored on a
 * non-overlapping 4x2 mesh so this only matters for degenerate presets.
 */
export function hitTestSlot(point: SlotPoint, rects: readonly SlotRect[]): number | null {
  let found: number | null = null
  for (let i = 0; i < rects.length; i += 1) {
    const rect = rects[i]
    if (rect.width <= 0 || rect.height <= 0) continue
    const withinX = point.x >= rect.left && point.x < rect.left + rect.width
    const withinY = point.y >= rect.top && point.y < rect.top + rect.height
    if (withinX && withinY) found = i
  }
  return found
}

/**
 * Slot that item `index` ends up occupying once the drag from `fromIndex` to
 * `toIndex` commits. The dragged item itself maps to `toIndex`; everything
 * between the two indices shifts by exactly one slot; everything outside that
 * span stays put.
 */
export function resolveTargetSlot(index: number, fromIndex: number, toIndex: number): number {
  if (index === fromIndex) return toIndex
  if (fromIndex < toIndex) {
    return index > fromIndex && index <= toIndex ? index - 1 : index
  }
  if (fromIndex > toIndex) {
    return index >= toIndex && index < fromIndex ? index + 1 : index
  }
  return index
}

/**
 * Per-cell FLIP transforms for the live drag preview.
 *
 * The dragged cell is pinned to IDENTITY: it is represented on screen by a
 * floating ghost that tracks the pointer, so its real cell stays in place
 * (hidden) and must not also be translated.
 *
 * Rectangles are the drag-start snapshot and never re-measured mid-drag, so
 * this is a pure function of the two indices — which is what keeps the
 * preview from oscillating when the pointer sits on a slot boundary.
 */
export function computeShiftOffsets(
  fromIndex: number,
  toIndex: number,
  rects: readonly SlotRect[]
): SlotShift[] {
  const shifts: SlotShift[] = rects.map(() => IDENTITY_SHIFT)
  if (!isIndexInRange(fromIndex, rects.length)) return shifts
  if (!isIndexInRange(toIndex, rects.length)) return shifts
  if (fromIndex === toIndex) return shifts

  for (let index = 0; index < rects.length; index += 1) {
    if (index === fromIndex) continue
    const targetSlot = resolveTargetSlot(index, fromIndex, toIndex)
    if (targetSlot === index) continue

    const current = rects[index]
    const target = rects[targetSlot]
    if (!target || current.width <= 0 || current.height <= 0) continue

    shifts[index] = {
      dx: target.left - current.left,
      dy: target.top - current.top,
      scaleX: target.width / current.width,
      scaleY: target.height / current.height
    }
  }

  return shifts
}

/** Serialise a shift into a CSS transform. Identity yields an empty string. */
export function shiftToTransform(shift: SlotShift): string {
  if (shift.dx === 0 && shift.dy === 0 && shift.scaleX === 1 && shift.scaleY === 1) {
    return ''
  }
  const translate = `translate(${shift.dx}px, ${shift.dy}px)`
  if (shift.scaleX === 1 && shift.scaleY === 1) return translate
  return `${translate} scale(${shift.scaleX}, ${shift.scaleY})`
}

/**
 * True when a drop actually changes the order. Used to decide between
 * committing state (and emitting the commit trace event) and treating the
 * gesture as a cancel.
 */
export function isEffectiveReorder(
  fromIndex: number,
  toIndex: number,
  length: number
): boolean {
  if (!isIndexInRange(fromIndex, length)) return false
  if (!isIndexInRange(toIndex, length)) return false
  return fromIndex !== toIndex
}

/**
 * Clamp a ghost rectangle so it stays reachable inside the viewport while
 * still tracking the pointer. Keeps at least `margin` px of the ghost on
 * screen on every edge, which matters when a Task is dragged toward the
 * window chrome.
 */
export function clampGhostPosition(
  left: number,
  top: number,
  width: number,
  height: number,
  viewportWidth: number,
  viewportHeight: number,
  margin = 24
): { left: number; top: number } {
  const minLeft = margin - width
  const maxLeft = viewportWidth - margin
  const minTop = margin - height
  const maxTop = viewportHeight - margin
  return {
    left: Math.min(Math.max(left, minLeft), maxLeft),
    top: Math.min(Math.max(top, minTop), maxTop)
  }
}
