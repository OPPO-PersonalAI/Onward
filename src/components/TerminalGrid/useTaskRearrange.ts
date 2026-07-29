/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import {
  clampGhostPosition,
  computeShiftOffsets,
  hitTestSlot,
  isEffectiveReorder,
  shiftToTransform,
  type SlotRect
} from '../../utils/task-reorder'
import { perfTrace } from '../../utils/perf-trace'
import { PERF_TRACE_EVENT } from '../../utils/perf-trace-names'

/** How the grid entered rearrange mode. */
export type RearrangeTrigger = 'long-press' | 'menu'

/** Why rearrange mode ended. Mirrored into the mode-exit trace payload. */
export type RearrangeExitReason =
  | 'esc'
  | 'outside-click'
  | 'drop'
  | 'layout-change'
  | 'tab-switch'
  | 'terminal-count-change'
  | 'disabled'

/**
 * Press-and-hold threshold before a header-bar press becomes a drag. Below
 * this a press is still a plain click, which keeps the existing click
 * behaviours on that bar intact (rename, copy branch, copy path).
 */
export const REARRANGE_LONG_PRESS_MS = 300

/** Ghost geometry, in viewport coordinates. Null while no drag is in flight. */
export interface RearrangeGhost {
  left: number
  top: number
  width: number
  height: number
}

export interface TaskRearrangeState {
  /**
   * True while the grid is in rearrange mode: cells carry a grab affordance
   * and a transparent pointer shield. Terminal content stays visible — the
   * user is choosing which Task goes where and needs to read them.
   */
  active: boolean
  trigger: RearrangeTrigger | null
  /** Index of the Task being dragged, or null when armed but idle. */
  draggingIndex: number | null
  /** Slot the drag currently previews dropping into. */
  targetIndex: number | null
  ghost: RearrangeGhost | null
  /**
   * Slot a Task just landed in, held briefly so the UI can flash it. Lets the
   * eye follow where the thing went after the ghost disappears.
   */
  settledIndex: number | null
}

/** How long the post-drop confirmation flash stays on the landing slot. */
export const REARRANGE_SETTLE_FLASH_MS = 700

export interface UseTaskRearrangeOptions {
  /** Visible terminal ids in render order. Length defines the slot count. */
  terminalIds: readonly string[]
  /** The `.terminal-grid` element; slot rectangles are measured from its cells. */
  getGridElement: () => HTMLElement | null
  /** False while the grid is hidden or covered by a global overlay. */
  enabled: boolean
  /** Identity of the current layout — a change force-exits the mode. */
  layoutKey: string
  /** Commit an insert-shift move into AppState. */
  onCommit: (fromIndex: number, toIndex: number) => void
  /** Called after a committed move so the caller can re-fit affected PTYs. */
  onAfterCommit?: (fromIndex: number, toIndex: number) => void
}

/**
 * Drag-to-rearrange controller for the Task grid.
 *
 * Design constraint that shapes everything here: the drag NEVER mutates the
 * terminal list. Reordering the array mid-drag would remount xterm DOM nodes
 * and re-run `fit()` on every pointermove, which under a custom (non-uniform)
 * layout means a `terminal.resize` IPC per frame and a shell repaint storm.
 * So the gesture runs entirely as a visual preview — CSS transforms over a
 * rectangle snapshot taken once at drag start — and the array is written
 * exactly once, on drop.
 *
 * Taking the rectangle snapshot once also fixes the reference frame: the
 * drop target is a pure function of the pointer position, so a pointer
 * resting on a slot seam cannot oscillate the preview back and forth.
 */
export function useTaskRearrange(options: UseTaskRearrangeOptions) {
  const { terminalIds, getGridElement, enabled, layoutKey, onCommit, onAfterCommit } = options

  const [state, setState] = useState<TaskRearrangeState>({
    active: false,
    trigger: null,
    draggingIndex: null,
    targetIndex: null,
    ghost: null,
    settledIndex: null
  })
  const settleTimerRef = useRef<number | null>(null)

  // Everything the pointer handlers need, kept in refs so the frame-rate path
  // never re-subscribes listeners or re-creates callbacks.
  const slotRectsRef = useRef<SlotRect[]>([])
  const dragRef = useRef<{
    pointerId: number
    captureEl: HTMLElement
    fromIndex: number
    targetIndex: number
    grabOffsetX: number
    grabOffsetY: number
    ghostWidth: number
    ghostHeight: number
  } | null>(null)
  const longPressRef = useRef<{
    timer: number
    pointerId: number
    captureEl: HTMLElement
    index: number
    clientX: number
    clientY: number
  } | null>(null)
  const activeRef = useRef(false)
  const triggerRef = useRef<RearrangeTrigger | null>(null)
  const suppressClickRef = useRef(false)
  const ghostElRef = useRef<HTMLElement | null>(null)
  const rafRef = useRef<number | null>(null)
  const pendingPointRef = useRef<{ x: number; y: number } | null>(null)
  const terminalIdsRef = useRef<readonly string[]>(terminalIds)
  const onCommitRef = useRef(onCommit)
  const onAfterCommitRef = useRef(onAfterCommit)

  useEffect(() => { terminalIdsRef.current = terminalIds }, [terminalIds])
  useEffect(() => { onCommitRef.current = onCommit }, [onCommit])
  useEffect(() => { onAfterCommitRef.current = onAfterCommit }, [onAfterCommit])
  useEffect(() => { activeRef.current = state.active }, [state.active])

  const cancelLongPress = useCallback(() => {
    const pending = longPressRef.current
    if (!pending) return
    window.clearTimeout(pending.timer)
    longPressRef.current = null
  }, [])

  const cancelFrame = useCallback(() => {
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current)
      rafRef.current = null
    }
    pendingPointRef.current = null
  }, [])

  const releaseCapture = useCallback(() => {
    const drag = dragRef.current
    if (!drag) return
    try {
      if (drag.captureEl.hasPointerCapture?.(drag.pointerId)) {
        drag.captureEl.releasePointerCapture(drag.pointerId)
      }
    } catch {
      // The element can already be gone (terminal closed mid-drag); the
      // capture dies with it, so there is nothing to release.
    }
  }, [])

  /** Measure every visible cell once. Called at drag start only. */
  const snapshotSlotRects = useCallback((): SlotRect[] => {
    const grid = getGridElement()
    if (!grid) return []
    const cells = grid.querySelectorAll<HTMLElement>('.terminal-grid-cell')
    const rects: SlotRect[] = []
    cells.forEach((cell) => {
      const rect = cell.getBoundingClientRect()
      rects.push({ left: rect.left, top: rect.top, width: rect.width, height: rect.height })
    })
    return rects
  }, [getGridElement])

  const endDrag = useCallback((commit: boolean): void => {
    const drag = dragRef.current
    if (!drag) return
    cancelFrame()
    releaseCapture()
    dragRef.current = null

    const { fromIndex, targetIndex } = drag
    const count = slotRectsRef.current.length
    const effective = commit && isEffectiveReorder(fromIndex, targetIndex, count)

    // The click-suppression flag (armed in beginDrag) MUST expire on its own.
    // A click is only synthesised when pointerdown and pointerup share a
    // target, so a drag that landed on a DIFFERENT cell produces no click at
    // all — leaving a sticky flag that would swallow the user's next unrelated
    // click (observed as the dropdown refusing to open right after a
    // successful reorder). Two frames is comfortably longer than the same-tick
    // pointerup → click sequence and far shorter than any human follow-up.
    requestAnimationFrame(() => {
      requestAnimationFrame(() => { suppressClickRef.current = false })
    })

    if (effective) {
      const startedAt = performance.now()
      onCommitRef.current(fromIndex, targetIndex)
      perfTrace(PERF_TRACE_EVENT.RENDERER_TASK_REORDER_COMMIT, {
        fromIndex,
        toIndex: targetIndex,
        count,
        durationMs: Number((performance.now() - startedAt).toFixed(3))
      })
      onAfterCommitRef.current?.(fromIndex, targetIndex)
    } else {
      perfTrace(PERF_TRACE_EVENT.RENDERER_TASK_REORDER_CANCEL, {
        fromIndex,
        toIndex: targetIndex,
        reason: commit ? 'same-slot' : 'aborted'
      })
    }

    setState((prev) => ({
      ...prev,
      draggingIndex: null,
      targetIndex: null,
      ghost: null,
      settledIndex: effective ? targetIndex : null
    }))

    if (effective) {
      if (settleTimerRef.current !== null) window.clearTimeout(settleTimerRef.current)
      settleTimerRef.current = window.setTimeout(() => {
        settleTimerRef.current = null
        setState((prev) => (prev.settledIndex === null ? prev : { ...prev, settledIndex: null }))
      }, REARRANGE_SETTLE_FLASH_MS)
    }
  }, [cancelFrame, releaseCapture])

  const exitMode = useCallback((reason: RearrangeExitReason) => {
    cancelLongPress()
    if (dragRef.current) endDrag(false)
    if (!activeRef.current) return
    activeRef.current = false
    triggerRef.current = null
    perfTrace(PERF_TRACE_EVENT.RENDERER_TASK_REORDER_MODE_EXIT, { reason })
    setState({ active: false, trigger: null, draggingIndex: null, targetIndex: null, ghost: null, settledIndex: null })
  }, [cancelLongPress, endDrag])

  const enterMode = useCallback((trigger: RearrangeTrigger) => {
    if (activeRef.current) return
    activeRef.current = true
    triggerRef.current = trigger
    perfTrace(PERF_TRACE_EVENT.RENDERER_TASK_REORDER_MODE_ENTER, { trigger })
    setState({ active: true, trigger, draggingIndex: null, targetIndex: null, ghost: null, settledIndex: null })
  }, [])

  /**
   * Position the ghost by writing directly to the element's style rather than
   * through React state. This runs on every pointermove; a setState here would
   * reconcile the whole grid 60+ times a second for a purely visual effect.
   */
  const flushGhostPosition = useCallback(() => {
    rafRef.current = null
    const point = pendingPointRef.current
    const drag = dragRef.current
    const ghostEl = ghostElRef.current
    if (!point || !drag || !ghostEl) return

    const { left, top } = clampGhostPosition(
      point.x - drag.grabOffsetX,
      point.y - drag.grabOffsetY,
      drag.ghostWidth,
      drag.ghostHeight,
      window.innerWidth,
      window.innerHeight
    )
    ghostEl.style.transform = `translate(${left}px, ${top}px)`
  }, [])

  const handlePointerMove = useCallback((event: PointerEvent) => {
    const drag = dragRef.current
    if (!drag || event.pointerId !== drag.pointerId) return

    pendingPointRef.current = { x: event.clientX, y: event.clientY }
    if (rafRef.current === null) {
      rafRef.current = requestAnimationFrame(flushGhostPosition)
    }

    // Hit-test against the ghost's CENTRE, not the raw pointer: grabbing a
    // cell by its top-left corner should still drop where the cell visually
    // sits, which is what the user is aiming with.
    const centreX = event.clientX - drag.grabOffsetX + drag.ghostWidth / 2
    const centreY = event.clientY - drag.grabOffsetY + drag.ghostHeight / 2
    const hit = hitTestSlot({ x: centreX, y: centreY }, slotRectsRef.current)
    // Outside every slot (gutter / off-grid): keep the last valid target so
    // crossing a seam never snaps the preview back to the origin.
    if (hit === null || hit === drag.targetIndex) return

    drag.targetIndex = hit
    setState((prev) => (prev.targetIndex === hit ? prev : { ...prev, targetIndex: hit }))
  }, [flushGhostPosition])

  const handlePointerUp = useCallback((event: PointerEvent) => {
    const drag = dragRef.current
    if (!drag || event.pointerId !== drag.pointerId) return
    endDrag(true)
    // A long-press drag is a one-shot gesture: releasing ends the mode. A
    // menu-armed session stays open so the user can keep rearranging.
    if (triggerRef.current === 'long-press') {
      activeRef.current = false
      triggerRef.current = null
      perfTrace(PERF_TRACE_EVENT.RENDERER_TASK_REORDER_MODE_EXIT, { reason: 'drop' })
      setState({ active: false, trigger: null, draggingIndex: null, targetIndex: null, ghost: null, settledIndex: null })
    }
  }, [endDrag])

  const handlePointerCancel = useCallback((event: PointerEvent) => {
    const drag = dragRef.current
    if (!drag || event.pointerId !== drag.pointerId) return
    endDrag(false)
  }, [endDrag])

  const beginDrag = useCallback((
    index: number,
    pointerId: number,
    captureEl: HTMLElement,
    clientX: number,
    clientY: number
  ) => {
    const rects = snapshotSlotRects()
    if (index < 0 || index >= rects.length) return
    slotRectsRef.current = rects

    const own = rects[index]
    try {
      captureEl.setPointerCapture(pointerId)
    } catch {
      // Capture can be refused if the pointer already went up between the
      // long-press timer firing and this call; the drag then ends on the
      // pointerup we still receive on window.
    }

    // Any drag suppresses the click that the release would otherwise fire.
    // Set it HERE, not only on a successful reorder: the handle now covers the
    // branch / repo / cwd chips, whose click copies to the clipboard, so a
    // hold-then-release that did not reorder must not silently copy a path.
    suppressClickRef.current = true

    dragRef.current = {
      pointerId,
      captureEl,
      fromIndex: index,
      targetIndex: index,
      grabOffsetX: clientX - own.left,
      grabOffsetY: clientY - own.top,
      ghostWidth: own.width,
      ghostHeight: own.height
    }

    setState((prev) => ({
      ...prev,
      active: true,
      draggingIndex: index,
      targetIndex: index,
      ghost: { left: own.left, top: own.top, width: own.width, height: own.height }
    }))
  }, [snapshotSlotRects])

  /**
   * Single entry point for pointer presses on a Task cell.
   *
   * While armed, any press anywhere on the cell starts a drag immediately —
   * the terminal is masked in that state, so the whole cell is the handle.
   * While idle, only a press on the title arms the long-press timer, so a
   * press inside the terminal body still selects text as usual.
   */
  const handleCellPointerDown = useCallback((index: number, event: ReactPointerEvent) => {
    if (!enabled) return
    if (event.button !== 0) return
    if (dragRef.current) return

    const target = event.target as HTMLElement | null
    const captureEl = event.currentTarget as HTMLElement

    if (activeRef.current) {
      event.preventDefault()
      beginDrag(index, event.pointerId, captureEl, event.clientX, event.clientY)
      return
    }

    // Idle: the drag handle is the WHOLE header bar, not just the title text.
    // The title is a short run of characters inside a 24px strip that also
    // carries the dropdown button and the branch / repo / cwd chips — scoping
    // the handle to the text alone gives the user a target they cannot
    // realistically aim at ("holding the title bar does nothing").
    //
    // A press inside the terminal body is still left alone so text selection
    // keeps working; short presses anywhere on the bar keep their existing
    // click behaviour (rename, copy branch, copy path) because the timer only
    // fires after the hold threshold.
    if (!target?.closest('.terminal-grid-header')) return
    // The dropdown trigger owns its own press; arming a drag from it would
    // make the menu impossible to open with a slow click.
    if (target.closest('.terminal-dropdown')) return
    // An in-progress inline rename must keep its caret and text selection.
    if (target.closest('.terminal-grid-title-input')) return

    const { pointerId, clientX, clientY } = event
    const timer = window.setTimeout(() => {
      const pending = longPressRef.current
      longPressRef.current = null
      if (!pending) return
      enterMode('long-press')
      beginDrag(pending.index, pending.pointerId, pending.captureEl, pending.clientX, pending.clientY)
    }, REARRANGE_LONG_PRESS_MS)

    longPressRef.current = { timer, pointerId, captureEl, index, clientX, clientY }
  }, [beginDrag, enabled, enterMode])

  // Track the pointer while the long-press timer is pending so the drag, once
  // armed, starts from where the finger actually is. Movement deliberately
  // does NOT cancel the timer: "press, start moving, then feel it take hold"
  // is the natural gesture, and cancelling on movement makes a deliberate
  // drag feel broken.
  useEffect(() => {
    if (!enabled) return
    const handleWindowPointerMove = (event: PointerEvent) => {
      const pending = longPressRef.current
      if (!pending || pending.pointerId !== event.pointerId) return
      pending.clientX = event.clientX
      pending.clientY = event.clientY
    }
    const handleWindowPointerUp = () => cancelLongPress()

    window.addEventListener('pointermove', handleWindowPointerMove)
    window.addEventListener('pointerup', handleWindowPointerUp)
    window.addEventListener('pointercancel', handleWindowPointerUp)
    return () => {
      window.removeEventListener('pointermove', handleWindowPointerMove)
      window.removeEventListener('pointerup', handleWindowPointerUp)
      window.removeEventListener('pointercancel', handleWindowPointerUp)
    }
  }, [cancelLongPress, enabled])

  // Drag lifecycle listeners live on window so a pointer that leaves the grid
  // (or crosses a terminal's canvas) still completes the gesture.
  useEffect(() => {
    if (state.draggingIndex === null) return
    window.addEventListener('pointermove', handlePointerMove)
    window.addEventListener('pointerup', handlePointerUp)
    window.addEventListener('pointercancel', handlePointerCancel)
    return () => {
      window.removeEventListener('pointermove', handlePointerMove)
      window.removeEventListener('pointerup', handlePointerUp)
      window.removeEventListener('pointercancel', handlePointerCancel)
    }
  }, [handlePointerCancel, handlePointerMove, handlePointerUp, state.draggingIndex])

  // Click suppression: consume exactly one click after a committed drag so the
  // release does not also open the title menu.
  useEffect(() => {
    const handleClickCapture = (event: MouseEvent) => {
      if (!suppressClickRef.current) return
      suppressClickRef.current = false
      event.preventDefault()
      event.stopPropagation()
    }
    window.addEventListener('click', handleClickCapture, true)
    return () => window.removeEventListener('click', handleClickCapture, true)
  }, [])

  // Outside click ends a menu-armed session.
  useEffect(() => {
    if (!state.active) return
    const handleOutsideDown = (event: MouseEvent) => {
      if (dragRef.current) return
      const grid = getGridElement()
      if (grid && grid.contains(event.target as Node)) return
      exitMode('outside-click')
    }
    window.addEventListener('mousedown', handleOutsideDown)
    return () => window.removeEventListener('mousedown', handleOutsideDown)
  }, [exitMode, getGridElement, state.active])

  // Force-exit whenever the ground shifts under the mode: the layout changed,
  // Tasks were added/removed, or the grid was disabled (hidden / overlaid).
  useEffect(() => {
    if (!state.active) return
    if (!enabled) exitMode('disabled')
  }, [enabled, exitMode, state.active])

  const terminalCount = terminalIds.length
  const firstRunRef = useRef(true)
  useEffect(() => {
    if (firstRunRef.current) {
      firstRunRef.current = false
      return
    }
    // Slot rectangles were snapshotted against the OLD layout, so any
    // in-flight preview is now measuring a grid that no longer exists.
    if (activeRef.current) exitMode('layout-change')
  }, [exitMode, layoutKey])

  useEffect(() => {
    if (activeRef.current && dragRef.current === null) exitMode('terminal-count-change')
  }, [exitMode, terminalCount])

  useEffect(() => () => {
    cancelLongPress()
    cancelFrame()
    if (settleTimerRef.current !== null) window.clearTimeout(settleTimerRef.current)
  }, [cancelFrame, cancelLongPress])

  /** Per-cell preview transforms for the current drag. */
  const cellTransforms = useMemo(() => {
    if (state.draggingIndex === null || state.targetIndex === null) return []
    return computeShiftOffsets(state.draggingIndex, state.targetIndex, slotRectsRef.current)
      .map(shiftToTransform)
  }, [state.draggingIndex, state.targetIndex])

  const getCellTransform = useCallback((index: number): string | undefined => {
    return cellTransforms[index] || undefined
  }, [cellTransforms])

  const setGhostElement = useCallback((el: HTMLElement | null) => {
    ghostElRef.current = el
    if (el && state.ghost) {
      el.style.transform = `translate(${state.ghost.left}px, ${state.ghost.top}px)`
    }
  }, [state.ghost])

  return {
    state,
    enterMode,
    exitMode,
    handleCellPointerDown,
    getCellTransform,
    setGhostElement
  }
}
