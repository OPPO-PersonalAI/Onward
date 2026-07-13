/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 *
 * Unit tests for the shared viewport-aware popup placement math
 * (src/utils/popup-position.ts) behind every context menu (Project Editor
 * tree / Git Diff / Git History copy-path menus, terminal menu, prompt
 * menus, custom-layout cell menu). Pairs with the autotest layer:
 * `run-file-entry-os-actions` (FEOS viewport-containment assertions) which
 * exercises the real DOM menus near window edges.
 *
 * Usage: node --experimental-strip-types --test test/unittest/popup-position.test.mts
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  computeMenuPosition,
  computeSubmenuLayout,
  POPUP_VIEWPORT_MARGIN
} from '../../src/utils/popup-position.ts'

const VIEWPORT = { width: 1200, height: 800 }
const MENU = { width: 220, height: 300 }
const M = POPUP_VIEWPORT_MARGIN

// ─────────────── PP-U-01..08 main menu placement table ───────────────

test('PP-U-01 fits at cursor → unchanged, not adjusted', () => {
  const r = computeMenuPosition({ anchor: { x: 100, y: 100 }, menu: MENU, viewport: VIEWPORT })
  assert.equal(r.x, 100)
  assert.equal(r.y, 100)
  assert.equal(r.adjusted, false)
  assert.equal(r.flippedY, false)
})

test('PP-U-02 right-edge overflow → clamped inside margin, no flip', () => {
  const r = computeMenuPosition({ anchor: { x: 1100, y: 100 }, menu: MENU, viewport: VIEWPORT })
  assert.equal(r.x, VIEWPORT.width - MENU.width - M)
  assert.equal(r.clampedX, true)
  assert.equal(r.y, 100)
  assert.equal(r.flippedY, false)
})

test('PP-U-03 bottom-edge overflow with room above → flips above the cursor', () => {
  const r = computeMenuPosition({ anchor: { x: 100, y: 700 }, menu: MENU, viewport: VIEWPORT })
  assert.equal(r.y, 700 - MENU.height)
  assert.equal(r.flippedY, true)
  assert.equal(r.clampedY, false)
})

test('PP-U-04 bottom overflow, NO room above → clamps against bottom edge', () => {
  // Anchor near the top but menu taller than remaining space both ways.
  const tall = { width: 220, height: 780 }
  const r = computeMenuPosition({ anchor: { x: 100, y: 400 }, menu: tall, viewport: VIEWPORT })
  assert.equal(r.flippedY, false)
  assert.equal(r.clampedY, true)
  assert.equal(r.y, Math.max(M, VIEWPORT.height - tall.height - M))
  assert.ok(r.y >= M)
})

test('PP-U-05 bottom-right corner → clamps X and flips Y simultaneously', () => {
  const r = computeMenuPosition({ anchor: { x: 1190, y: 790 }, menu: MENU, viewport: VIEWPORT })
  assert.equal(r.x, VIEWPORT.width - MENU.width - M)
  assert.equal(r.y, 790 - MENU.height)
  assert.equal(r.clampedX, true)
  assert.equal(r.flippedY, true)
  assert.ok(r.x + MENU.width <= VIEWPORT.width - M)
  assert.ok(r.y + MENU.height <= VIEWPORT.height)
})

test('PP-U-06 menu larger than viewport → pinned to margin, never negative', () => {
  const huge = { width: 2000, height: 2000 }
  const r = computeMenuPosition({ anchor: { x: 600, y: 400 }, menu: huge, viewport: VIEWPORT })
  assert.equal(r.x, M)
  assert.equal(r.y, M)
  assert.equal(r.adjusted, true)
})

test('PP-U-07 anchor left of / above the margin → nudged to the margin', () => {
  const r = computeMenuPosition({ anchor: { x: 2, y: 3 }, menu: MENU, viewport: VIEWPORT })
  assert.equal(r.x, M)
  assert.equal(r.y, M)
  assert.equal(r.clampedX, true)
  assert.equal(r.clampedY, true)
})

test('PP-U-08 custom margin is honored on every edge', () => {
  const margin = 20
  const r = computeMenuPosition({
    anchor: { x: 1195, y: 795 },
    menu: MENU,
    viewport: VIEWPORT,
    margin
  })
  assert.equal(r.x, VIEWPORT.width - MENU.width - margin)
  assert.equal(r.y, 795 - MENU.height)
})

// ─────────────── PP-U-09..14 submenu placement table ───────────────

const ANCHOR_ITEM = { left: 300, top: 200, right: 520, bottom: 232 }

test('PP-U-09 room on the right → opens right at anchor.right + gap', () => {
  const r = computeSubmenuLayout({
    anchorRect: ANCHOR_ITEM,
    natural: { width: 200, height: 150 },
    viewport: VIEWPORT
  })
  assert.equal(r.openRight, true)
  assert.equal(r.viewportLeft, ANCHOR_ITEM.right + 2)
  assert.equal(r.left, r.viewportLeft - ANCHOR_ITEM.left)
  assert.equal(r.clampedX, false)
})

test('PP-U-10 no room right, more room left → opens left', () => {
  const nearRight = { left: 1000, top: 200, right: 1180, bottom: 232 }
  const r = computeSubmenuLayout({
    anchorRect: nearRight,
    natural: { width: 300, height: 150 },
    viewport: VIEWPORT
  })
  assert.equal(r.openRight, false)
  assert.equal(r.viewportLeft, nearRight.left - 2 - 300)
})

test('PP-U-11 cramped both sides → right-biased and clamped inside viewport', () => {
  const wide = { left: 40, top: 200, right: 1160, bottom: 232 }
  const r = computeSubmenuLayout({
    anchorRect: wide,
    natural: { width: 300, height: 150 },
    viewport: VIEWPORT
  })
  assert.equal(r.openRight, true)
  assert.ok(r.viewportLeft >= M)
  assert.ok(r.viewportLeft + r.width <= VIEWPORT.width - M)
  assert.equal(r.clampedX, true)
})

test('PP-U-12 submenu taller than viewport → height capped to available space', () => {
  const r = computeSubmenuLayout({
    anchorRect: ANCHOR_ITEM,
    natural: { width: 200, height: 2000 },
    viewport: VIEWPORT
  })
  assert.equal(r.maxHeight, VIEWPORT.height - M * 2)
  assert.ok(r.viewportTop >= M)
})

test('PP-U-13 anchor near bottom → submenu clamped upward to stay inside', () => {
  const bottomAnchor = { left: 300, top: 760, right: 520, bottom: 792 }
  const r = computeSubmenuLayout({
    anchorRect: bottomAnchor,
    natural: { width: 200, height: 400 },
    viewport: VIEWPORT
  })
  assert.ok(r.viewportTop + Math.min(400, r.maxHeight) <= VIEWPORT.height - M + 0.5)
  assert.equal(r.clampedY, true)
})

test('PP-U-14 local offsets are viewport coords minus the anchor corner', () => {
  const r = computeSubmenuLayout({
    anchorRect: ANCHOR_ITEM,
    natural: { width: 200, height: 150 },
    viewport: VIEWPORT
  })
  assert.equal(r.left, r.viewportLeft - ANCHOR_ITEM.left)
  assert.equal(r.top, r.viewportTop - ANCHOR_ITEM.top)
})
