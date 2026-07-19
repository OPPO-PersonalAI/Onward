/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

import type { OutlineItem } from './types'

/**
 * Above this many VISIBLE rows the outline switches to fixed-row-height
 * windowed rendering. Small outlines keep the fully-materialised DOM so the
 * existing interaction surface (tests, debug APIs, wrapping labels) is
 * untouched; only pathological outlines pay the single-line-row trade-off.
 */
export const OUTLINE_VIRTUALIZE_THRESHOLD = 300

/** Fixed row height (px) used in virtualized mode. Mirrored in OutlinePanel.css. */
export const OUTLINE_VIRTUAL_ROW_HEIGHT = 26

/** Rows rendered beyond each edge of the viewport to absorb scroll latency. */
export const OUTLINE_VIRTUAL_OVERSCAN = 10

export interface FlatOutlineEntry {
  item: OutlineItem
  key: string
  hasChildren: boolean
  isCollapsed: boolean
}

/** Stable per-item key; MUST stay in sync with the recursive renderItem path. */
export function outlineItemKey(item: OutlineItem, parentKey: string): string {
  const targetKey = item.target
    ? item.target.kind === 'pdf-page'
      ? `pdf:${item.target.page}`
      : `epub:${item.target.href}`
    : `ln:${item.startLine}`
  return `${parentKey}/${item.name}:${targetKey}`
}

/**
 * Flatten the outline tree into the list of rows a fully-expanded DOM walk
 * would paint: children of a collapsed node are skipped, document order is
 * preserved.
 */
export function flattenVisibleOutline(
  items: OutlineItem[],
  collapsed: ReadonlySet<string>
): FlatOutlineEntry[] {
  const rows: FlatOutlineEntry[] = []
  const walk = (list: OutlineItem[], parentKey: string) => {
    for (const item of list) {
      const key = outlineItemKey(item, parentKey)
      const hasChildren = item.children.length > 0
      const isCollapsed = collapsed.has(key)
      rows.push({ item, key, hasChildren, isCollapsed })
      if (hasChildren && !isCollapsed) {
        walk(item.children, key)
      }
    }
  }
  walk(items, '')
  return rows
}

export interface OutlineWindow {
  startIndex: number
  /** Exclusive end index. */
  endIndex: number
  totalHeight: number
}

/** Compute the [start, end) row window for a scroll position + viewport. */
export function computeOutlineWindow(
  scrollTop: number,
  viewportHeight: number,
  rowCount: number,
  rowHeight: number = OUTLINE_VIRTUAL_ROW_HEIGHT,
  overscan: number = OUTLINE_VIRTUAL_OVERSCAN
): OutlineWindow {
  const safeScrollTop = Math.max(0, scrollTop)
  const first = Math.floor(safeScrollTop / rowHeight)
  const visibleCount = Math.max(1, Math.ceil(viewportHeight / rowHeight))
  return {
    startIndex: Math.max(0, first - overscan),
    endIndex: Math.min(rowCount, first + visibleCount + overscan),
    totalHeight: rowCount * rowHeight
  }
}

/** scrollTop that vertically centers the given row inside the viewport. */
export function centerScrollTopForIndex(
  index: number,
  viewportHeight: number,
  rowCount: number,
  rowHeight: number = OUTLINE_VIRTUAL_ROW_HEIGHT
): number {
  const maxScrollTop = Math.max(0, rowCount * rowHeight - viewportHeight)
  const target = index * rowHeight - (viewportHeight - rowHeight) / 2
  return Math.min(maxScrollTop, Math.max(0, Math.round(target)))
}
