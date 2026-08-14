/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Pure keyboard-navigation and scroll-follow math for paged result lists.
 *
 * Extracted from the component because both rules below are easy to get subtly
 * wrong and impossible to inspect once tangled into JSX:
 *
 *   1. What happens when the selection reaches the last LOADED row while more
 *      rows exist on the server. The naive `Math.min(index + 1, length - 1)`
 *      silently clamps, so the keypress produces no visible movement at all —
 *      measured as a dead key at exactly one spot in every list.
 *   2. Whether the selected row is inside the scroll viewport. Without this the
 *      highlight walks off-screen and the user, seeing nothing move, reads a
 *      perfectly fast list as a frozen one.
 */

export interface NavStepInput {
  activeIndex: number
  /** Rows currently loaded and rendered. */
  itemCount: number
  /** Whether the server has more rows beyond `itemCount`. */
  hasMore: boolean
  /** +1 for ArrowDown, -1 for ArrowUp. */
  delta: number
  /**
   * Start fetching the next page once the selection is within this many rows of
   * the end, so the rows are already there by the time the user arrives.
   */
  prefetchDistance: number
}

export interface NavStepResult {
  nextIndex: number
  /** The caller should request another page now. */
  shouldLoadMore: boolean
  /**
   * The move could not complete because the needed row is not loaded yet. The
   * caller must remember this and advance once more rows arrive, otherwise the
   * keypress is swallowed and the user has to press again.
   */
  deferred: boolean
}

/**
 * Resolve one arrow-key step.
 *
 * Ordering note: prefetch is evaluated against the row we are moving TO, not
 * the one we are on, so a fast-repeating key still triggers the fetch early
 * enough to matter.
 */
export function stepActiveIndex({
  activeIndex,
  itemCount,
  hasMore,
  delta,
  prefetchDistance
}: NavStepInput): NavStepResult {
  if (itemCount <= 0) {
    return { nextIndex: 0, shouldLoadMore: false, deferred: false }
  }

  const desired = activeIndex + delta

  // Moving up, or moving down into an already-loaded row: plain clamped move.
  if (desired < 0) {
    return { nextIndex: 0, shouldLoadMore: false, deferred: false }
  }

  if (desired < itemCount) {
    const remaining = itemCount - 1 - desired
    return {
      nextIndex: desired,
      shouldLoadMore: hasMore && remaining <= prefetchDistance,
      deferred: false
    }
  }

  // Past the last loaded row.
  if (hasMore) {
    // Hold position and fetch. `deferred` tells the caller to complete this
    // step when the page lands, so the press is not lost.
    return { nextIndex: itemCount - 1, shouldLoadMore: true, deferred: true }
  }

  // Genuinely the end of the list.
  return { nextIndex: itemCount - 1, shouldLoadMore: false, deferred: false }
}

export interface ScrollFollowInput {
  /** Current scrollTop of the scrolling container. */
  scrollTop: number
  /** Visible height of the scrolling container (clientHeight). */
  viewportHeight: number
  /** offsetTop of the target row relative to the scroll content. */
  itemTop: number
  itemHeight: number
  /**
   * Keep this much of a margin above/below the row so the user can see there is
   * more list in the direction they are travelling.
   */
  margin?: number
}

/**
 * Compute the scrollTop needed to bring a row into view, or return the current
 * scrollTop unchanged when the row is already comfortably visible.
 *
 * Deliberately "scroll the minimum": jumping the row to the centre on every
 * keypress makes the list lurch under the user. This mirrors
 * `scrollIntoView({ block: 'nearest' })` but is computed against ONE known
 * container, so it can never scroll an ancestor (the modal, the page) as a
 * side effect.
 */
export function computeScrollFollowTop({
  scrollTop,
  viewportHeight,
  itemTop,
  itemHeight,
  margin = 0
}: ScrollFollowInput): number {
  if (viewportHeight <= 0) return scrollTop

  const itemBottom = itemTop + itemHeight
  const viewTop = scrollTop
  const viewBottom = scrollTop + viewportHeight

  // Above the viewport: pull it down to the top edge (plus margin).
  if (itemTop - margin < viewTop) {
    return Math.max(0, itemTop - margin)
  }

  // Below the viewport: pull it up to the bottom edge (plus margin).
  if (itemBottom + margin > viewBottom) {
    return Math.max(0, itemBottom + margin - viewportHeight)
  }

  return scrollTop
}

/**
 * Should a pointer-enter event be allowed to change the selection?
 *
 * When the list scrolls under a stationary cursor, the browser fires enter
 * events for rows that slid beneath the pointer. Honouring those would yank the
 * selection away from where the keyboard just put it, making the arrow keys
 * look broken. Only a real pointer MOVE hands control back to the mouse.
 */
export function shouldHoverClaimSelection(keyboardIsDriving: boolean): boolean {
  return !keyboardIsDriving
}
