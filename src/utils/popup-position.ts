/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 *
 * Pure viewport-aware placement math for cursor-anchored popups (context
 * menus) and their submenus. Extracted from PromptEditorContextMenu — the
 * one implementation that already did this right — so every menu shares a
 * single, unit-tested algorithm instead of five hand-rolled variants.
 *
 * Placement contract (matches VS Code's contextview layout and Floating
 * UI's flip+shift ordering):
 *  - Horizontal: keep the menu at the cursor; when it would overflow the
 *    right edge, clamp it inside the viewport (margin-padded).
 *  - Vertical: when the menu would overflow the bottom edge, FLIP it above
 *    the cursor first (the cursor is never covered, which reads naturally);
 *    only when there is no room above either, clamp against the bottom.
 *  - Submenus: measure the natural size, open toward the side with more
 *    room, clamp into the viewport, and report both viewport coordinates
 *    and anchor-local offsets (hosts that render the submenu nested inside
 *    the menu DOM need local offsets so parent transforms cannot capture a
 *    `position: fixed` child).
 *
 * No DOM access here — callers measure and pass sizes — so the Node unit
 * layer (test/unittest/popup-position.test.mts) can pin every branch.
 */

export interface PopupPoint {
  x: number
  y: number
}

export interface PopupSize {
  width: number
  height: number
}

export interface PopupViewport {
  width: number
  height: number
}

export interface PopupAnchorRect {
  left: number
  top: number
  right: number
  bottom: number
}

export const POPUP_VIEWPORT_MARGIN = 8
export const SUBMENU_GAP = 2
export const SUBMENU_VERTICAL_OFFSET = 6
export const SUBMENU_MIN_WIDTH_CAP = 220
/** Smallest usable content box a clamped submenu may shrink to. */
export const SUBMENU_MIN_AVAILABLE = 80

export interface MenuPositionResult {
  x: number
  y: number
  /** Menu was mirrored above the cursor because the bottom edge overflowed. */
  flippedY: boolean
  clampedX: boolean
  clampedY: boolean
  adjusted: boolean
}

/**
 * Place a cursor-anchored menu inside the viewport. Flip-then-clamp on the
 * vertical axis, clamp-only on the horizontal axis.
 */
export function computeMenuPosition(input: {
  anchor: PopupPoint
  menu: PopupSize
  viewport: PopupViewport
  margin?: number
}): MenuPositionResult {
  const margin = input.margin ?? POPUP_VIEWPORT_MARGIN
  const { anchor, menu, viewport } = input

  let x = anchor.x
  let clampedX = false
  if (x + menu.width > viewport.width - margin) {
    x = Math.max(margin, viewport.width - menu.width - margin)
    clampedX = true
  }
  if (x < margin) {
    x = margin
    clampedX = true
  }

  let y = anchor.y
  let flippedY = false
  let clampedY = false
  if (y + menu.height > viewport.height - margin) {
    const flipped = anchor.y - menu.height
    if (flipped >= margin) {
      y = flipped
      flippedY = true
    } else {
      y = Math.max(margin, viewport.height - menu.height - margin)
      clampedY = true
    }
  }
  if (y < margin) {
    y = margin
    clampedY = true
  }

  return {
    x,
    y,
    flippedY,
    clampedX,
    clampedY,
    adjusted: flippedY || clampedX || clampedY || x !== anchor.x || y !== anchor.y
  }
}

export interface SubmenuLayoutResult {
  /** Anchor-local offsets (viewport coordinate minus the anchor's corner). */
  left: number
  top: number
  /** Viewport-space coordinates for hosts that render `position: fixed`. */
  viewportLeft: number
  viewportTop: number
  width: number
  minWidth: number
  maxWidth: number
  maxHeight: number
  openRight: boolean
  clampedX: boolean
  clampedY: boolean
}

/**
 * Place a submenu beside its anchor item. Opens toward the side with more
 * room (right-biased on ties), clamps into the viewport, and caps the size
 * to what actually fits.
 */
export function computeSubmenuLayout(input: {
  anchorRect: PopupAnchorRect
  natural: PopupSize
  viewport: PopupViewport
  margin?: number
  gap?: number
  verticalOffset?: number
  minWidthCap?: number
}): SubmenuLayoutResult {
  const margin = input.margin ?? POPUP_VIEWPORT_MARGIN
  const gap = input.gap ?? SUBMENU_GAP
  const verticalOffset = input.verticalOffset ?? SUBMENU_VERTICAL_OFFSET
  const minWidthCap = input.minWidthCap ?? SUBMENU_MIN_WIDTH_CAP
  const { anchorRect, natural, viewport } = input

  const availableWidth = Math.max(SUBMENU_MIN_AVAILABLE, viewport.width - margin * 2)
  const availableHeight = Math.max(SUBMENU_MIN_AVAILABLE, viewport.height - margin * 2)
  const width = Math.min(Math.ceil(natural.width), availableWidth)
  const height = Math.min(Math.ceil(natural.height), availableHeight)

  const spaceRight = viewport.width - margin - anchorRect.right - gap
  const spaceLeft = anchorRect.left - margin - gap
  const openRight = spaceRight >= width || spaceRight >= spaceLeft
  const preferredLeft = openRight
    ? anchorRect.right + gap
    : anchorRect.left - gap - width
  const preferredTop = anchorRect.top - verticalOffset

  const viewportLeft = clampNumber(preferredLeft, margin, viewport.width - margin - width)
  const viewportTop = clampNumber(preferredTop, margin, viewport.height - margin - height)

  return {
    left: Math.round(viewportLeft - anchorRect.left),
    top: Math.round(viewportTop - anchorRect.top),
    viewportLeft: Math.round(viewportLeft),
    viewportTop: Math.round(viewportTop),
    width: Math.round(width),
    minWidth: Math.round(Math.min(minWidthCap, availableWidth)),
    maxWidth: Math.round(availableWidth),
    maxHeight: Math.round(availableHeight),
    openRight,
    clampedX: Math.abs(viewportLeft - preferredLeft) > 0.5,
    clampedY: Math.abs(viewportTop - preferredTop) > 0.5
  }
}

function clampNumber(value: number, min: number, max: number): number {
  if (max < min) return min
  return Math.min(Math.max(value, min), max)
}
