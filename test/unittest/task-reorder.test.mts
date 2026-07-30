/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 *
 * Unit tests for the Task drag-to-rearrange decision surface:
 *   - reorderByInsert: insert-shift (NOT swap) list math + no-op identity.
 *   - hitTestSlot: which grid slot the pointer is over, gutters included.
 *   - resolveTargetSlot / computeShiftOffsets: where every non-dragged cell
 *     has to slide during the live preview, including the scale term that
 *     only custom (non-uniform) layouts exercise.
 *   - clampGhostPosition: the floating ghost stays reachable on screen.
 *
 * These are the pure half of the feature. They lock the math; the wiring
 * (long-press arming, pointer capture, DOM order, PTY survival) is locked by
 * the Electron-side runner `run-task-layout-autotest.sh` (TLM-06..12).
 *
 * Usage: node --experimental-strip-types --test test/unittest/task-reorder.test.mts
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  IDENTITY_SHIFT,
  clampGhostPosition,
  computeShiftOffsets,
  hitTestSlot,
  isEffectiveReorder,
  reorderByInsert,
  resolveTargetSlot,
  shiftToTransform,
  type SlotRect
} from '../../src/utils/task-reorder.ts'

const SIX = ['A', 'B', 'C', 'D', 'E', 'F'] as const

/** Uniform 3x2 preset grid: 200x100 slots laid out left-to-right, top-to-bottom. */
function uniformRects(): SlotRect[] {
  const rects: SlotRect[] = []
  for (let row = 0; row < 2; row += 1) {
    for (let col = 0; col < 3; col += 1) {
      rects.push({ left: col * 200, top: row * 100, width: 200, height: 100 })
    }
  }
  return rects
}

/** Custom layout: one 2x2 big cell plus two stacked 1x1 cells. */
function nonUniformRects(): SlotRect[] {
  return [
    { left: 0, top: 0, width: 400, height: 200 },
    { left: 400, top: 0, width: 200, height: 100 },
    { left: 400, top: 100, width: 200, height: 100 }
  ]
}

// ─────────────── reorderByInsert ───────────────

test('TRO-U-01 dragging index 0 onto index 3 shifts the passed-over items back by one', () => {
  // This is THE semantic decision: insert-shift, not swap. A swap would give
  // [D,B,C,A,E,F]; insert-shift preserves the relative order of B,C,D.
  assert.deepEqual(reorderByInsert(SIX, 0, 3), ['B', 'C', 'D', 'A', 'E', 'F'])
})

test('TRO-U-02 dragging backwards shifts the passed-over items forward by one', () => {
  assert.deepEqual(reorderByInsert(SIX, 4, 1), ['A', 'E', 'B', 'C', 'D', 'F'])
})

test('TRO-U-03 adjacent moves in both directions behave as a plain swap', () => {
  // With exactly one item in between, insert-shift and swap coincide. This is
  // why the two semantics look identical in a 2-Task layout.
  assert.deepEqual(reorderByInsert(SIX, 0, 1), ['B', 'A', 'C', 'D', 'E', 'F'])
  assert.deepEqual(reorderByInsert(SIX, 1, 0), ['B', 'A', 'C', 'D', 'E', 'F'])
})

test('TRO-U-04 first-to-last and last-to-first rotate the whole list', () => {
  assert.deepEqual(reorderByInsert(SIX, 0, 5), ['B', 'C', 'D', 'E', 'F', 'A'])
  assert.deepEqual(reorderByInsert(SIX, 5, 0), ['F', 'A', 'B', 'C', 'D', 'E'])
})

test('TRO-U-05 a no-op move returns the SAME array reference', () => {
  // Callers use referential equality to skip the AppState write entirely.
  assert.equal(reorderByInsert(SIX, 2, 2), SIX)
})

test('TRO-U-06 out-of-range indices return the SAME array reference', () => {
  assert.equal(reorderByInsert(SIX, -1, 2), SIX)
  assert.equal(reorderByInsert(SIX, 2, 6), SIX)
  assert.equal(reorderByInsert(SIX, 6, 0), SIX)
  assert.equal(reorderByInsert(SIX, 1.5, 0), SIX)
  const empty: readonly string[] = []
  assert.equal(reorderByInsert(empty, 0, 0), empty)
})

test('TRO-U-07 reorder never mutates the input list', () => {
  const input = [...SIX]
  reorderByInsert(input, 0, 4)
  assert.deepEqual(input, ['A', 'B', 'C', 'D', 'E', 'F'])
})

test('TRO-U-08 every element survives the reorder exactly once', () => {
  for (let from = 0; from < SIX.length; from += 1) {
    for (let to = 0; to < SIX.length; to += 1) {
      const result = reorderByInsert(SIX, from, to)
      assert.equal(result.length, SIX.length, `length changed for ${from}->${to}`)
      assert.deepEqual([...result].sort(), [...SIX].sort(), `set changed for ${from}->${to}`)
    }
  }
})

test('TRO-U-09 the dragged item always lands exactly on the target index', () => {
  for (let from = 0; from < SIX.length; from += 1) {
    for (let to = 0; to < SIX.length; to += 1) {
      const result = reorderByInsert(SIX, from, to)
      assert.equal(result[to], SIX[from], `wrong landing slot for ${from}->${to}`)
    }
  }
})

// ─────────────── hitTestSlot ───────────────

test('TRO-U-10 a point inside a slot resolves to that slot index', () => {
  const rects = uniformRects()
  assert.equal(hitTestSlot({ x: 100, y: 50 }, rects), 0)
  assert.equal(hitTestSlot({ x: 300, y: 50 }, rects), 1)
  assert.equal(hitTestSlot({ x: 500, y: 150 }, rects), 5)
})

test('TRO-U-11 slot bounds are half-open: left/top inclusive, right/bottom exclusive', () => {
  const rects = uniformRects()
  // The seam between slot 0 and slot 1 belongs to slot 1, never to both.
  assert.equal(hitTestSlot({ x: 0, y: 0 }, rects), 0)
  assert.equal(hitTestSlot({ x: 199.9, y: 50 }, rects), 0)
  assert.equal(hitTestSlot({ x: 200, y: 50 }, rects), 1)
})

test('TRO-U-12 a point outside every slot returns null', () => {
  const rects = uniformRects()
  assert.equal(hitTestSlot({ x: -10, y: 50 }, rects), null)
  assert.equal(hitTestSlot({ x: 700, y: 50 }, rects), null)
  assert.equal(hitTestSlot({ x: 100, y: 250 }, rects), null)
})

test('TRO-U-13 zero-area slots are never hit', () => {
  // A collapsed cell (mid layout transition) must not swallow the pointer.
  const rects: SlotRect[] = [
    { left: 0, top: 0, width: 0, height: 0 },
    { left: 0, top: 0, width: 100, height: 100 }
  ]
  assert.equal(hitTestSlot({ x: 0, y: 0 }, rects), 1)
})

test('TRO-U-14 hit testing works on non-uniform custom slots', () => {
  const rects = nonUniformRects()
  assert.equal(hitTestSlot({ x: 200, y: 100 }, rects), 0)
  assert.equal(hitTestSlot({ x: 500, y: 50 }, rects), 1)
  assert.equal(hitTestSlot({ x: 500, y: 150 }, rects), 2)
})

// ─────────────── resolveTargetSlot ───────────────

test('TRO-U-15 the dragged index maps onto the drop target', () => {
  assert.equal(resolveTargetSlot(0, 0, 3), 3)
  assert.equal(resolveTargetSlot(4, 4, 1), 1)
})

test('TRO-U-16 forward drag shifts the span (from, to] back by one', () => {
  assert.equal(resolveTargetSlot(1, 0, 3), 0)
  assert.equal(resolveTargetSlot(2, 0, 3), 1)
  assert.equal(resolveTargetSlot(3, 0, 3), 2)
})

test('TRO-U-17 backward drag shifts the span [to, from) forward by one', () => {
  assert.equal(resolveTargetSlot(1, 4, 1), 2)
  assert.equal(resolveTargetSlot(2, 4, 1), 3)
  assert.equal(resolveTargetSlot(3, 4, 1), 4)
})

test('TRO-U-18 indices outside the moved span stay put', () => {
  assert.equal(resolveTargetSlot(4, 0, 3), 4)
  assert.equal(resolveTargetSlot(5, 0, 3), 5)
  assert.equal(resolveTargetSlot(0, 4, 1), 0)
  assert.equal(resolveTargetSlot(5, 4, 1), 5)
})

test('TRO-U-19 resolveTargetSlot agrees with reorderByInsert for every pair', () => {
  // Cross-check the preview math against the commit math: the slot the
  // preview slides item i into MUST be the index it actually lands on.
  for (let from = 0; from < SIX.length; from += 1) {
    for (let to = 0; to < SIX.length; to += 1) {
      const committed = reorderByInsert(SIX, from, to)
      for (let i = 0; i < SIX.length; i += 1) {
        const slot = resolveTargetSlot(i, from, to)
        assert.equal(
          committed[slot],
          SIX[i],
          `preview/commit disagree: item ${i} for ${from}->${to} previewed slot ${slot}`
        )
      }
    }
  }
})

// ─────────────── computeShiftOffsets ───────────────

test('TRO-U-20 the dragged cell itself is pinned to identity', () => {
  // Its on-screen stand-in is the floating ghost, so translating the real
  // cell too would double-move it.
  const shifts = computeShiftOffsets(0, 3, uniformRects())
  assert.deepEqual(shifts[0], IDENTITY_SHIFT)
})

test('TRO-U-21 uniform slots shift by exactly one slot with no scaling', () => {
  const shifts = computeShiftOffsets(0, 2, uniformRects())
  assert.deepEqual(shifts[1], { dx: -200, dy: 0, scaleX: 1, scaleY: 1 })
  assert.deepEqual(shifts[2], { dx: -200, dy: 0, scaleX: 1, scaleY: 1 })
  assert.deepEqual(shifts[3], IDENTITY_SHIFT)
})

test('TRO-U-22 shifting across a row wraps to the previous row-end position', () => {
  const shifts = computeShiftOffsets(0, 3, uniformRects())
  // Slot 3 sits at (0,100); it must slide up to slot 2 at (400,0).
  assert.deepEqual(shifts[3], { dx: 400, dy: -100, scaleX: 1, scaleY: 1 })
})

test('TRO-U-23 a no-op or out-of-range drag yields all-identity shifts', () => {
  const rects = uniformRects()
  for (const shifts of [
    computeShiftOffsets(2, 2, rects),
    computeShiftOffsets(-1, 2, rects),
    computeShiftOffsets(2, 99, rects)
  ]) {
    assert.equal(shifts.length, rects.length)
    assert.ok(shifts.every((s) => s === IDENTITY_SHIFT))
  }
})

test('TRO-U-24 non-uniform custom slots carry a scale term', () => {
  // Big 400x200 cell at index 0 moving to the 200x100 slot at index 1: the
  // preview must shrink it, otherwise it overhangs its neighbours and lies
  // about the drop result.
  const shifts = computeShiftOffsets(1, 0, nonUniformRects())
  assert.deepEqual(shifts[0], { dx: 400, dy: 0, scaleX: 0.5, scaleY: 0.5 })
  assert.deepEqual(shifts[1], IDENTITY_SHIFT)
})

test('TRO-U-25 every shift lands the cell on its resolved target rectangle', () => {
  for (const rects of [uniformRects(), nonUniformRects()]) {
    for (let from = 0; from < rects.length; from += 1) {
      for (let to = 0; to < rects.length; to += 1) {
        const shifts = computeShiftOffsets(from, to, rects)
        for (let i = 0; i < rects.length; i += 1) {
          if (i === from || from === to) continue
          const target = rects[resolveTargetSlot(i, from, to)]
          const shift = shifts[i]
          assert.equal(rects[i].left + shift.dx, target.left, `left mismatch i=${i} ${from}->${to}`)
          assert.equal(rects[i].top + shift.dy, target.top, `top mismatch i=${i} ${from}->${to}`)
          assert.equal(
            rects[i].width * shift.scaleX,
            target.width,
            `width mismatch i=${i} ${from}->${to}`
          )
          assert.equal(
            rects[i].height * shift.scaleY,
            target.height,
            `height mismatch i=${i} ${from}->${to}`
          )
        }
      }
    }
  }
})

// ─────────────── shiftToTransform ───────────────

test('TRO-U-26 identity serialises to an empty transform', () => {
  assert.equal(shiftToTransform(IDENTITY_SHIFT), '')
})

test('TRO-U-27 a pure translation omits the scale term', () => {
  assert.equal(
    shiftToTransform({ dx: -200, dy: 0, scaleX: 1, scaleY: 1 }),
    'translate(-200px, 0px)'
  )
})

test('TRO-U-28 a scaling shift emits translate followed by scale', () => {
  assert.equal(
    shiftToTransform({ dx: 400, dy: 0, scaleX: 0.5, scaleY: 0.5 }),
    'translate(400px, 0px) scale(0.5, 0.5)'
  )
})

// ─────────────── isEffectiveReorder ───────────────

test('TRO-U-29 only an in-range move to a different index counts as effective', () => {
  assert.equal(isEffectiveReorder(0, 3, 6), true)
  assert.equal(isEffectiveReorder(2, 2, 6), false)
  assert.equal(isEffectiveReorder(0, 6, 6), false)
  assert.equal(isEffectiveReorder(-1, 0, 6), false)
  assert.equal(isEffectiveReorder(0, 1, 0), false)
})

// ─────────────── clampGhostPosition ───────────────

test('TRO-U-30 a ghost fully inside the viewport is left alone', () => {
  assert.deepEqual(clampGhostPosition(100, 100, 200, 100, 1000, 800), { left: 100, top: 100 })
})

test('TRO-U-31 a ghost dragged past an edge keeps a margin on screen', () => {
  // Off the left/top: at most (width - margin) / (height - margin) may leave.
  assert.deepEqual(clampGhostPosition(-999, -999, 200, 100, 1000, 800), {
    left: 24 - 200,
    top: 24 - 100
  })
  // Off the right/bottom: the ghost's own left/top stops at viewport - margin.
  assert.deepEqual(clampGhostPosition(9999, 9999, 200, 100, 1000, 800), {
    left: 1000 - 24,
    top: 800 - 24
  })
})

test('TRO-U-32 the clamp keeps at least `margin` px of the ghost visible', () => {
  for (const [x, y] of [[-5000, -5000], [5000, 5000], [-5000, 5000], [5000, -5000]]) {
    const { left, top } = clampGhostPosition(x, y, 240, 120, 1440, 900, 24)
    assert.ok(left + 240 >= 24, `ghost fully off the left edge at x=${x}`)
    assert.ok(left <= 1440 - 24, `ghost fully off the right edge at x=${x}`)
    assert.ok(top + 120 >= 24, `ghost fully off the top edge at y=${y}`)
    assert.ok(top <= 900 - 24, `ghost fully off the bottom edge at y=${y}`)
  }
})
