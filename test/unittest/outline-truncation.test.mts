/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 *
 * OTR-U-*: decision table for truncateOutlineSymbols — the parse-time cap
 * that keeps pathological outlines (Monaco HTML symbols: one per DOM
 * element) from entering React state at full size.
 *
 * Usage: node --experimental-strip-types test/unittest/outline-truncation.test.mts
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import {
  truncateOutlineSymbols,
  OUTLINE_SYMBOL_CAP
} from '../../src/components/ProjectEditor/Outline/outlineTruncation.ts'
import type { OutlineItem } from '../../src/components/ProjectEditor/Outline/types.ts'

let nextLine = 1
function item(depth: number, children: OutlineItem[] = [], name?: string): OutlineItem {
  const line = nextLine++
  return {
    name: name ?? `sym-${line}`,
    kind: 0,
    startLine: line,
    startColumn: 1,
    endLine: line,
    endColumn: 10,
    children,
    depth
  }
}

function countAll(items: OutlineItem[]): number {
  let count = 0
  for (const entry of items) count += 1 + countAll(entry.children)
  return count
}

function maxDepth(items: OutlineItem[]): number {
  let deepest = -1
  for (const entry of items) {
    deepest = Math.max(deepest, entry.depth, maxDepth(entry.children))
  }
  return deepest
}

test('OTR-U-01: under the cap returns the ORIGINAL array reference, untruncated', () => {
  const tree = [item(0, [item(1), item(1)]), item(0)]
  const result = truncateOutlineSymbols(tree, 10)
  assert.equal(result.truncated, false)
  assert.equal(result.items, tree)
  assert.equal(result.totalCount, 4)
  assert.equal(result.keptCount, 4)
})

test('OTR-U-02: exactly at the cap is NOT truncated', () => {
  const tree = [item(0, [item(1)]), item(0)]
  const result = truncateOutlineSymbols(tree, 3)
  assert.equal(result.truncated, false)
  assert.equal(result.keptCount, 3)
})

test('OTR-U-03: over the cap drops the deepest level first, keeps shallow levels whole', () => {
  // 2 roots, each with 2 children, each child with 2 grandchildren = 2+4+8 = 14
  const tree = [
    item(0, [item(1, [item(2), item(2)]), item(1, [item(2), item(2)])]),
    item(0, [item(1, [item(2), item(2)]), item(1, [item(2), item(2)])])
  ]
  const result = truncateOutlineSymbols(tree, 6)
  assert.equal(result.truncated, true)
  assert.equal(result.totalCount, 14)
  // depth 0 (2) + depth 1 (4) fit; depth 2 budget = 0
  assert.equal(result.keptCount, 6)
  assert.equal(maxDepth(result.items), 1)
  assert.equal(countAll(result.items), 6)
})

test('OTR-U-04: partial level is filled in document order', () => {
  const tree = [
    item(0, [item(1, [], 'first-child'), item(1, [], 'second-child')]),
    item(0, [item(1, [], 'third-child'), item(1, [], 'fourth-child')])
  ]
  const result = truncateOutlineSymbols(tree, 5)
  assert.equal(result.truncated, true)
  assert.equal(result.keptCount, 5)
  const keptChildNames = result.items.flatMap((root) => root.children.map((child) => child.name))
  assert.deepEqual(keptChildNames, ['first-child', 'second-child', 'third-child'])
})

test('OTR-U-05: a kept node never loses its ancestors (structure stays a tree)', () => {
  const tree = [item(0, [item(1, [item(2, [item(3)])])]), item(0)]
  const result = truncateOutlineSymbols(tree, 3)
  assert.equal(result.truncated, true)
  // roots kept whole (2), then depth-1 budget = 1 in document order
  assert.equal(result.items.length, 2)
  assert.equal(result.items[0].children.length, 1)
  assert.equal(result.items[0].children[0].children.length, 0)
})

test('OTR-U-06: cap smaller than the root level partially keeps roots', () => {
  const tree = [item(0), item(0), item(0), item(0)]
  const result = truncateOutlineSymbols(tree, 2)
  assert.equal(result.truncated, true)
  assert.equal(result.items.length, 2)
  assert.equal(result.keptCount, 2)
  assert.equal(result.totalCount, 4)
})

test('OTR-U-07: original tree is never mutated', () => {
  const grandchild = item(2)
  const child = item(1, [grandchild])
  const root = item(0, [child])
  const result = truncateOutlineSymbols([root], 2)
  assert.equal(result.truncated, true)
  assert.equal(root.children.length, 1)
  assert.equal(child.children.length, 1)
  assert.equal(child.children[0], grandchild)
})

test('OTR-U-08: default cap constant is the confirmed product decision (5000)', () => {
  assert.equal(OUTLINE_SYMBOL_CAP, 5000)
})

test('OTR-U-09: flat 40k-style outline truncates to exactly the cap', () => {
  const tree = [item(0, Array.from({ length: 8000 }, () => item(1)))]
  const result = truncateOutlineSymbols(tree)
  assert.equal(result.truncated, true)
  assert.equal(result.totalCount, 8001)
  assert.equal(result.keptCount, OUTLINE_SYMBOL_CAP)
  assert.equal(countAll(result.items), OUTLINE_SYMBOL_CAP)
})
