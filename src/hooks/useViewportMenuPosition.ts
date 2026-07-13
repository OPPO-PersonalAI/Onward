/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 *
 * Shared hook wrapping the pure popup placement math in
 * src/utils/popup-position.ts for cursor-anchored context menus.
 *
 * Usage: render the menu at the returned position (initially the raw
 * cursor point); the useLayoutEffect below measures the committed menu box
 * BEFORE the browser paints and rewrites the position in the same frame,
 * so the user never sees the uncorrected placement (no flicker) — the same
 * mechanism PromptEditorContextMenu pioneered.
 */

import { useLayoutEffect, useState } from 'react'
import {
  computeMenuPosition,
  POPUP_VIEWPORT_MARGIN,
  type PopupPoint
} from '../utils/popup-position'
import { perfTraceDiagnostic } from '../utils/perf-trace'
import { PERF_TRACE_EVENT } from '../utils/perf-trace-names'

export interface ViewportMenuPositionOptions {
  /**
   * Short identifier of the owning surface (e.g. 'git-history-file',
   * 'project-editor-tree') carried in the diagnostic breadcrumb emitted
   * when the position had to be adjusted.
   */
  surface: string
  margin?: number
  /**
   * When the menu is positioned absolutely inside a container (anchor in
   * container-local coordinates), pass the container ref: its box size
   * replaces the window viewport as the clamping bounds.
   */
  boundsRef?: React.RefObject<HTMLElement | null>
}

/**
 * Keep a cursor-anchored menu inside the viewport (flip above the cursor
 * when the bottom edge overflows, clamp otherwise).
 *
 * @param menuRef  ref of the rendered menu element (measured post-commit)
 * @param anchor   raw right-click point in viewport coordinates, or null
 *                 while the menu is closed
 * @returns        the effective position to render at (falls back to the
 *                 raw anchor until measured; null while closed)
 */
export function useViewportMenuPosition(
  menuRef: React.RefObject<HTMLElement | null>,
  anchor: PopupPoint | null,
  options: ViewportMenuPositionOptions
): PopupPoint | null {
  const [effective, setEffective] = useState<PopupPoint | null>(anchor)
  const [viewportVersion, setViewportVersion] = useState(0)
  const { surface, boundsRef } = options
  const margin = options.margin ?? POPUP_VIEWPORT_MARGIN
  // Callers pass fresh `{ x, y }` literals every render; depend on the
  // primitives so identical coordinates never re-run the effect.
  const anchorX = anchor?.x ?? null
  const anchorY = anchor?.y ?? null

  // Re-clamp on window resize while a menu is open (rare, but a shrinking
  // window must not strand the menu off-screen).
  useLayoutEffect(() => {
    if (anchorX === null) return
    const onResize = () => setViewportVersion(v => v + 1)
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [anchorX === null])

  useLayoutEffect(() => {
    if (anchorX === null || anchorY === null) {
      setEffective(prev => (prev === null ? prev : null))
      return
    }
    const el = menuRef.current
    if (!el) {
      setEffective(prev => (prev?.x === anchorX && prev?.y === anchorY ? prev : { x: anchorX, y: anchorY }))
      return
    }
    const rect = el.getBoundingClientRect()
    const boundsRect = boundsRef?.current?.getBoundingClientRect()
    const result = computeMenuPosition({
      anchor: { x: anchorX, y: anchorY },
      menu: { width: rect.width, height: rect.height },
      viewport: boundsRect
        ? { width: boundsRect.width, height: boundsRect.height }
        : { width: window.innerWidth, height: window.innerHeight },
      margin
    })
    if (result.adjusted) {
      perfTraceDiagnostic(PERF_TRACE_EVENT.RENDERER_POPUP_POSITION_ADJUSTED, {
        surface,
        flippedY: result.flippedY,
        clampedX: result.clampedX,
        clampedY: result.clampedY,
        anchorX: Math.round(anchorX),
        anchorY: Math.round(anchorY),
        menuWidth: Math.round(rect.width),
        menuHeight: Math.round(rect.height)
      })
    }
    setEffective(prev =>
      prev?.x === result.x && prev?.y === result.y ? prev : { x: result.x, y: result.y }
    )
  }, [anchorX, anchorY, menuRef, surface, margin, boundsRef, viewportVersion])

  return anchor ? (effective ?? anchor) : null
}
