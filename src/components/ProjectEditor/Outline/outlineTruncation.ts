/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

import type { OutlineItem } from './types'

/**
 * Hard cap on the number of outline symbols kept after parsing.
 *
 * Rationale: Monaco's HTML DocumentSymbolProvider emits one symbol per DOM
 * element, so a multi-megabyte HTML document can yield 40k+ symbols. Keeping
 * them all makes every downstream pass (filtering, slug maps, flattening,
 * React reconciliation) scale with document size instead of with what a user
 * can meaningfully navigate. 5000 was confirmed as the product decision.
 */
export const OUTLINE_SYMBOL_CAP = 5000

export interface OutlineTruncation {
  totalCount: number
  keptCount: number
  truncated: boolean
}

export interface OutlineTruncationResult extends OutlineTruncation {
  items: OutlineItem[]
}

function countItems(items: OutlineItem[]): number {
  let count = 0
  for (const item of items) {
    count += 1 + countItems(item.children)
  }
  return count
}

function countPerDepth(items: OutlineItem[], counts: number[]): void {
  for (const item of items) {
    counts[item.depth] = (counts[item.depth] ?? 0) + 1
    countPerDepth(item.children, counts)
  }
}

/**
 * Truncate an outline tree to at most `cap` symbols, breadth-first by depth:
 * shallow levels are kept whole; the first level that would overflow the cap
 * is filled partially in document order; everything deeper is dropped. A kept
 * node's ancestors are always kept (ancestors have smaller depth), so the
 * tree structure stays intact.
 *
 * Under the cap the ORIGINAL array reference is returned so callers can rely
 * on identity equality to skip work.
 */
export function truncateOutlineSymbols(
  items: OutlineItem[],
  cap: number = OUTLINE_SYMBOL_CAP
): OutlineTruncationResult {
  const totalCount = countItems(items)
  if (totalCount <= cap || cap <= 0) {
    return { items, totalCount, keptCount: totalCount, truncated: false }
  }

  const perDepth: number[] = []
  countPerDepth(items, perDepth)

  // fullDepth = deepest level that still fits entirely; partialBudget = how
  // many nodes of level fullDepth+1 may be kept in document order.
  let cumulative = 0
  let fullDepth = -1
  for (let depth = 0; depth < perDepth.length; depth += 1) {
    const levelCount = perDepth[depth] ?? 0
    if (cumulative + levelCount > cap) break
    cumulative += levelCount
    fullDepth = depth
  }
  let partialBudget = cap - cumulative
  const partialDepth = fullDepth + 1

  const rebuild = (list: OutlineItem[]): OutlineItem[] => {
    const kept: OutlineItem[] = []
    for (const item of list) {
      if (item.depth > partialDepth) continue
      if (item.depth === partialDepth) {
        if (partialBudget <= 0) continue
        partialBudget -= 1
        kept.push(item.children.length > 0 ? { ...item, children: [] } : item)
        continue
      }
      const children = rebuild(item.children)
      kept.push(children === item.children ? item : { ...item, children })
    }
    return kept
  }

  const truncatedItems = rebuild(items)
  return {
    items: truncatedItems,
    totalCount,
    keptCount: countItems(truncatedItems),
    truncated: true
  }
}
