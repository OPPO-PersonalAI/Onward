/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 *
 * OVW-U-*: decision table for the outline virtualization math — flatten
 * (collapse-aware), window computation, and active-row centering used by the
 * OutlinePanel windowed-rendering path.
 *
 * Usage: node --experimental-strip-types test/unittest/outline-virtual-window.test.mts
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import {
  flattenVisibleOutline,
  computeOutlineWindow,
  centerScrollTopForIndex,
  outlineItemKey,
  OUTLINE_VIRTUAL_ROW_HEIGHT,
  OUTLINE_VIRTUAL_OVERSCAN
} from '../../src/components/ProjectEditor/Outline/outlineVirtualization.ts'
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

test('OVW-U-01: flatten preserves document order and depth-first expansion', () => {
  const childA = item(1, [], 'a1')
  const childB = item(1, [], 'b1')
  const tree = [item(0, [childA], 'a'), item(0, [childB], 'b')]
  const rows = flattenVisibleOutline(tree, new Set())
  assert.deepEqual(rows.map((row) => row.item.name), ['a', 'a1', 'b', 'b1'])
  assert.deepEqual(rows.map((row) => row.hasChildren), [true, false, true, false])
})

test('OVW-U-02: children of a collapsed node are skipped, siblings are not', () => {
  const tree = [
    item(0, [item(1, [], 'hidden')], 'collapsed-root'),
    item(0, [item(1, [], 'visible')], 'open-root')
  ]
  const collapsedKey = outlineItemKey(tree[0], '')
  const rows = flattenVisibleOutline(tree, new Set([collapsedKey]))
  assert.deepEqual(rows.map((row) => row.item.name), ['collapsed-root', 'open-root', 'visible'])
  assert.equal(rows[0].isCollapsed, true)
})

test('OVW-U-03: flat keys match the recursive renderItem key format', () => {
  const child = item(1, [], 'child')
  const root = item(0, [child], 'root')
  const rows = flattenVisibleOutline([root], new Set())
  const rootKey = outlineItemKey(root, '')
  assert.equal(rows[0].key, rootKey)
  assert.equal(rows[1].key, outlineItemKey(child, rootKey))
  assert.equal(rootKey, `/root:ln:${root.startLine}`)
})

test('OVW-U-04: window covers the viewport plus overscan on both edges', () => {
  const rowH = OUTLINE_VIRTUAL_ROW_HEIGHT
  const rowWindow = computeOutlineWindow(100 * rowH, 10 * rowH, 1000)
  assert.equal(rowWindow.startIndex, 100 - OUTLINE_VIRTUAL_OVERSCAN)
  assert.equal(rowWindow.endIndex, 100 + 10 + OUTLINE_VIRTUAL_OVERSCAN)
  assert.equal(rowWindow.totalHeight, 1000 * rowH)
})

test('OVW-U-05: window clamps at the list edges', () => {
  const rowH = OUTLINE_VIRTUAL_ROW_HEIGHT
  const top = computeOutlineWindow(0, 5 * rowH, 100)
  assert.equal(top.startIndex, 0)
  const bottom = computeOutlineWindow(98 * rowH, 5 * rowH, 100)
  assert.equal(bottom.endIndex, 100)
  const negative = computeOutlineWindow(-50, 5 * rowH, 100)
  assert.equal(negative.startIndex, 0)
})

test('OVW-U-06: tiny viewport still renders at least one row plus overscan', () => {
  const rowWindow = computeOutlineWindow(0, 0, 100)
  assert.ok(rowWindow.endIndex >= 1)
})

test('OVW-U-07: centering puts the row mid-viewport and clamps to scroll range', () => {
  const rowH = OUTLINE_VIRTUAL_ROW_HEIGHT
  const viewport = 11 * rowH
  const centered = centerScrollTopForIndex(50, viewport, 1000)
  assert.equal(centered, 50 * rowH - (viewport - rowH) / 2)
  assert.equal(centerScrollTopForIndex(0, viewport, 1000), 0)
  const maxScrollTop = 1000 * rowH - viewport
  assert.equal(centerScrollTopForIndex(999, viewport, 1000), maxScrollTop)
})

test('OVW-U-08: flatten of a 40k-node collapsed forest only walks visible rows', () => {
  const roots = Array.from({ length: 200 }, (_v, index) =>
    item(0, Array.from({ length: 200 }, () => item(1)), `root-${index}`)
  )
  const collapsedKeys = new Set(roots.map((root) => outlineItemKey(root, '')))
  const rows = flattenVisibleOutline(roots, collapsedKeys)
  assert.equal(rows.length, 200)
})
