/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

import type { AutotestContext, TestResult } from './types'

/**
 * Lightweight DOM-only sanity for the Task layout extension. Checks that:
 *   - Sidebar exposes the new 8-grid button.
 *   - Sidebar exposes the Custom button.
 *   - Clicking the 8-grid button flips data-layout="8" on the active grid.
 *   - Clicking the Custom button mounts the preset popover.
 * Drag-to-create + downsize semantics are unit-tested in
 * `test/unittest/task-layout-utils.test.mts` because mouse-event simulation
 * across our atomic-cell mesh is fragile in headless Electron. This e2e
 * verifies the integration wiring (Sidebar → AppState → TerminalGrid CSS
 * hook), which is where regressions would actually break the UI.
 */
function findSidebarLayoutButton(matchTitleSubstrings: readonly string[]): HTMLButtonElement | null {
  // Sidebar buttons carry the i18n string in `title=`. The autotest
  // harness boots the app in the default English locale, so matching on
  // English title substrings is sufficient. Add localized fallbacks via
  // the i18n dictionary if a future locale-coverage suite needs them.
  const buttons = Array.from(document.querySelectorAll<HTMLButtonElement>('.sidebar .sidebar-btn'))
  for (const btn of buttons) {
    const title = (btn.getAttribute('title') ?? '').toLowerCase()
    if (matchTitleSubstrings.some(needle => title.includes(needle.toLowerCase()))) {
      return btn
    }
  }
  return null
}

function activeGridLayoutAttr(): string | null {
  // Multiple TerminalGrid instances live in the DOM (one per tab). The
  // visible one is the wrapper without the `terminal-grid-hidden` modifier.
  const grids = Array.from(document.querySelectorAll<HTMLElement>('.terminal-grid-wrapper'))
  const visible = grids.find(g => !g.classList.contains('terminal-grid-hidden'))
  if (!visible) return null
  const inner = visible.querySelector<HTMLElement>('.terminal-grid')
  return inner?.getAttribute('data-layout') ?? null
}

export async function testTaskLayout(ctx: AutotestContext): Promise<TestResult[]> {
  const { assert, cancelled, sleep, waitFor } = ctx
  const results: TestResult[] = []
  const record = (name: string, ok: boolean, detail?: Record<string, unknown>) => {
    assert(name, ok, detail)
    results.push({ name, ok, detail })
  }

  // Wait for the sidebar to mount before probing buttons. The autotest
  // harness opens the project editor by default, but the sidebar is
  // rendered eagerly so this should resolve quickly.
  const sidebarReady = await waitFor('sidebar-mounted', () => {
    return document.querySelector('.sidebar') !== null
  }, 8000)
  record('TLM-00-sidebar-mounted', sidebarReady)
  if (!sidebarReady || cancelled()) return results

  // ── TLM-01: 8-grid button is reachable ──
  // Sidebar title for the 8-grid preset is "Eight terminals" in the
  // default English locale. Match the leading token so a future copy
  // tweak ("Eight panes" etc.) still hits.
  const eightBtn = findSidebarLayoutButton(['eight'])
  record('TLM-01-eight-grid-button-present', eightBtn !== null)

  // ── TLM-02: Custom button is reachable ──
  const customBtn = findSidebarLayoutButton(['custom layout'])
  record('TLM-02-custom-button-present', customBtn !== null)

  if (!eightBtn || !customBtn) return results

  // ── TLM-03: clicking the 8-grid button flips data-layout="8" ──
  // The user might already be on layout 8 (depends on prior persisted
  // state). To keep the assertion deterministic, click "Single" (1) first,
  // then click "8" and observe.
  const singleBtn = findSidebarLayoutButton(['single'])
  if (singleBtn) {
    singleBtn.click()
    await sleep(80)
  }
  eightBtn.click()
  // Clicking "Eight" grows the active tab to 8 terminals in AppState
  // (reducer-synchronous, fast), but TerminalGrid intentionally defers the
  // visible data-layout="8" flip until all 8 PTYs are ready (correct product
  // behaviour). Spawning ~7 PTYs is process-creation-bound; on an EDR host
  // each spawn can be taxed by several seconds, so a single fixed budget is
  // not deterministic. Split the wait into two steps: (1) confirm AppState
  // reached 8 terminals on the active tab (the deterministic, reducer-driven
  // signal; AppState is async so it is polled directly rather than through the
  // synchronous waitFor predicate), then (2) wait for the DOM data-layout flip
  // with a large EDR-aware budget covering ~7 PTY spawns at up to EDR peak each.
  const EIGHT_GRID_FLIP_BUDGET_MS = 60000
  let lastActiveTabTerminalCount = 0
  const appStateReachedEight = await (async () => {
    const startedAt = Date.now()
    while (Date.now() - startedAt < EIGHT_GRID_FLIP_BUDGET_MS) {
      if (cancelled()) return false
      const appState = await window.electronAPI.appState.load()
      const activeTab = appState.tabs.find(tab => tab.id === appState.activeTabId) ?? null
      lastActiveTabTerminalCount = activeTab?.terminals.length ?? 0
      if (lastActiveTabTerminalCount >= 8) return true
      await sleep(120)
    }
    return false
  })()
  record('TLM-03-grid-layout-eight-appstate-grew', appStateReachedEight, {
    terminals: lastActiveTabTerminalCount
  })
  const flippedToEight = await waitFor(
    'grid-layout-eight',
    () => activeGridLayoutAttr() === '8',
    EIGHT_GRID_FLIP_BUDGET_MS,
    120
  )
  record('TLM-03-grid-layout-eight-after-click', flippedToEight, {
    layout: activeGridLayoutAttr(),
    terminals: lastActiveTabTerminalCount
  })

  // ── TLM-04: switching back to single shrinks the grid ──
  // We just expanded to 8; clicking Single (1) requests a downsize from 8
  // current Tasks to 1. The downsize dialog should appear (because
  // requiredCount < currentCount). This validates the dialog mounts in the
  // right code path; the user can dismiss it because we don't run
  // confirm here (drag-to-confirm is unit-tested separately).
  if (singleBtn) {
    singleBtn.click()
    const dialogShown = await waitFor(
      'downsize-dialog-visible',
      () => document.querySelector('.downsize-confirm-dialog') !== null,
      4000,
      80
    )
    record('TLM-04-downsize-dialog-shown', dialogShown)
    if (dialogShown) {
      // Unified modal dismiss (2026-07-16): backdrop clicks are inert.
      const backdrop = document.querySelector('.downsize-confirm-backdrop')
      backdrop?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
      backdrop?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      await sleep(300)
      record('TLM-04b-downsize-backdrop-click-keeps-dialog',
        document.querySelector('.downsize-confirm-dialog') !== null, {
          backdropFound: backdrop !== null
        })

      // ESC safely cancels (newly added useModalEscape) without downsizing.
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
      const dialogClosedByEscape = await waitFor(
        'downsize-dialog-esc-closed',
        () => document.querySelector('.downsize-confirm-dialog') === null,
        4000,
        80
      )
      record('TLM-04c-downsize-escape-cancels-dialog', dialogClosedByEscape)
      if (!dialogClosedByEscape) {
        // Fallback dismiss so we don't leave the app in a modal state.
        const cancel = document.querySelector<HTMLButtonElement>('.downsize-confirm-secondary')
        cancel?.click()
        await sleep(100)
      }
    }
  } else {
    record('TLM-04-downsize-dialog-shown', false, { reason: 'single-button-not-found' })
  }

  // ── TLM-05: Custom button opens the popover ──
  customBtn.click()
  const popoverShown = await waitFor(
    'custom-popover-visible',
    () => document.querySelector('.custom-layout-popover') !== null,
    4000,
    80
  )
  record('TLM-05-custom-popover-opens', popoverShown)
  if (popoverShown) {
    // Click outside to close so subsequent suites have a clean DOM.
    document.body.click()
    await sleep(100)
  }

  // ── TLM-06..12: Task drag-to-rearrange ──
  await runRearrangeAssertions(ctx, record)

  return results
}

// ───────────────────────── Task drag-to-rearrange ─────────────────────────

/**
 * Dispatch a real PointerEvent. The rearrange gesture is driven end-to-end
 * through these rather than through a "just reorder it" debug hook, so the
 * long-press timer, the pointer-capture call and the centre-based hit test
 * are all genuinely exercised — a shortcut API would leave exactly the wiring
 * that breaks in production untested.
 */
function dispatchPointer(
  target: EventTarget,
  type: 'pointerdown' | 'pointermove' | 'pointerup' | 'pointercancel',
  x: number,
  y: number,
  pointerId = 0xa11
): void {
  target.dispatchEvent(new PointerEvent(type, {
    pointerId,
    bubbles: true,
    cancelable: true,
    composed: true,
    clientX: x,
    clientY: y,
    button: 0,
    buttons: type === 'pointerup' || type === 'pointercancel' ? 0 : 1,
    pointerType: 'mouse',
    isPrimary: true
  }))
}

function visibleGridEl(): HTMLElement | null {
  const wrappers = Array.from(document.querySelectorAll<HTMLElement>('.terminal-grid-wrapper'))
  const visible = wrappers.find(w => !w.classList.contains('terminal-grid-hidden'))
  return visible?.querySelector<HTMLElement>('.terminal-grid') ?? null
}

function gridCells(): HTMLElement[] {
  const grid = visibleGridEl()
  if (!grid) return []
  return Array.from(grid.querySelectorAll<HTMLElement>('.terminal-grid-cell'))
}

/** Terminal ids in DOM order — the user-visible Task order. */
function domTerminalOrder(): string[] {
  return gridCells()
    .map(cell => cell.getAttribute('data-terminal-id') ?? '')
    .filter(Boolean)
}

function cellCentre(cell: HTMLElement): { x: number; y: number } {
  const rect = cell.getBoundingClientRect()
  return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }
}

function titleAnchor(cell: HTMLElement): { el: HTMLElement; x: number; y: number } | null {
  const title = cell.querySelector<HTMLElement>('.terminal-grid-title')
  if (!title) return null
  const rect = title.getBoundingClientRect()
  return { el: title, x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }
}

/**
 * A point on the header bar that is NOT the title text — the empty stretch to
 * the right of the branch / repo / cwd chips.
 *
 * This is what a user actually presses when they "hold the Task title bar":
 * the title text itself is a short run of characters in a 24px-tall strip that
 * also carries the dropdown button and three metadata chips. A drag handle
 * scoped to the text alone is invisible to aim for.
 */
function headerBlankAnchor(cell: HTMLElement): { el: HTMLElement; x: number; y: number } | null {
  const header = cell.querySelector<HTMLElement>('.terminal-grid-header')
  if (!header) return null
  const rect = header.getBoundingClientRect()
  if (rect.width <= 0) return null
  // 12px in from the right edge: past every chip, still inside the bar.
  const x = rect.right - 12
  const y = rect.top + rect.height / 2
  const el = (document.elementFromPoint(x, y) as HTMLElement | null) ?? header
  return { el, x, y }
}

/**
 * Press the Task title, hold for `holdMs`, then release without moving.
 * Returns whether rearrange mode was armed while the button was still down.
 */
async function pressAndHold(
  ctx: AutotestContext,
  cell: HTMLElement,
  holdMs: number,
  where: 'title' | 'header-blank' = 'title'
): Promise<boolean> {
  const anchor = where === 'title' ? titleAnchor(cell) : headerBlankAnchor(cell)
  if (!anchor) return false
  const debug = window.__onwardTerminalDebug
  dispatchPointer(anchor.el, 'pointerdown', anchor.x, anchor.y)
  await ctx.sleep(holdMs)
  const armedWhileDown = debug?.getTaskRearrangeState().active ?? false
  dispatchPointer(window, 'pointerup', anchor.x, anchor.y)
  await ctx.sleep(60)
  return armedWhileDown
}

/** Full long-press + drag + drop from one slot's title onto another slot. */
async function longPressDrag(
  ctx: AutotestContext,
  fromIndex: number,
  toIndex: number
): Promise<void> {
  const cells = gridCells()
  const from = cells[fromIndex]
  const to = cells[toIndex]
  if (!from || !to) return
  const anchor = titleAnchor(from)
  if (!anchor) return

  const target = cellCentre(to)
  dispatchPointer(anchor.el, 'pointerdown', anchor.x, anchor.y)
  // Hold past the arming threshold (REARRANGE_LONG_PRESS_MS = 300).
  await ctx.sleep(420)
  // Two moves: the first establishes the drag, the second settles the target
  // so the rAF-driven ghost and the target state have both flushed.
  dispatchPointer(window, 'pointermove', target.x, target.y)
  await ctx.sleep(60)
  dispatchPointer(window, 'pointermove', target.x, target.y)
  await ctx.sleep(60)
  dispatchPointer(window, 'pointerup', target.x, target.y)
  await ctx.sleep(220)
}

async function runRearrangeAssertions(
  ctx: AutotestContext,
  record: (name: string, ok: boolean, detail?: Record<string, unknown>) => void
): Promise<void> {
  const { sleep, waitFor, cancelled } = ctx
  const debug = window.__onwardTerminalDebug
  if (!debug) {
    record('TLM-06-rearrange-debug-api', false, { reason: 'terminal-debug-api-missing' })
    return
  }

  // Rearrange is disabled while a subpage covers the grid (Git Diff, Git
  // History, Project Editor). Earlier suites — and the harness's own default
  // boot — can leave one mounted, which would make every assertion below fail
  // for a reason that has nothing to do with rearranging.
  debug.closeAllSubpages()
  await sleep(250)

  // Rearranging needs at least two slots. Land on the 2-grid preset: it is
  // the cheapest multi-slot layout and keeps this block well inside the
  // per-runner budget.
  const twoBtn = findSidebarLayoutButton(['two'])
  if (!twoBtn) {
    record('TLM-06-rearrange-two-grid-available', false, { reason: 'two-grid-button-not-found' })
    return
  }
  twoBtn.click()
  // TLM-03 left the grid on the 8-preset, so dropping to 2 is a downsize and
  // raises the keep-Tasks dialog (that is TLM-04's whole subject). Confirm it,
  // otherwise the layout never changes and every assertion below times out
  // against a grid that is still 8 cells wide.
  const downsizeShown = await waitFor(
    'downsize-dialog-for-two-grid',
    () => document.querySelector('.downsize-confirm-dialog') !== null,
    4000,
    80
  )
  if (downsizeShown) {
    // Confirm is gated on selecting EXACTLY the surviving count, so normalise
    // the checkboxes to the first two rather than assuming a default.
    const primary = document.querySelector<HTMLButtonElement>('.downsize-confirm-primary')
    if (primary?.disabled) {
      const boxes = Array.from(
        document.querySelectorAll<HTMLInputElement>('.downsize-confirm-row input[type="checkbox"]')
      )
      for (const box of boxes) {
        if (box.checked) { box.click(); await sleep(20) }
      }
      for (const box of boxes.slice(0, 2)) { box.click(); await sleep(20) }
      await sleep(80)
    }
    document.querySelector<HTMLButtonElement>('.downsize-confirm-primary')?.click()
    await sleep(250)
  }

  // Exactly two — `>= 2` would be satisfied by the leftover 8-grid, whose
  // cells are only a few rows tall and would let the scrollback assertion
  // below fail for wrapping reasons that have nothing to do with reordering.
  const twoReady = await waitFor(
    'two-grid-cells-ready',
    () => gridCells().length === 2 && domTerminalOrder().length === 2,
    20000,
    120
  )
  record('TLM-06-rearrange-two-grid-available', twoReady, {
    cells: gridCells().length,
    rearrangeState: debug.getTaskRearrangeState()
  })
  if (!twoReady || cancelled()) return

  // Gate the gesture assertions on the grid actually accepting gestures, and
  // say WHICH input blocked it. Without this a disabled grid reads as "the
  // long-press timer is broken", which is the wrong thing to go fix.
  const gate = debug.getTaskRearrangeState()
  record('TLM-06b-rearrange-enabled', gate.enabled, {
    hidden: gate.hidden,
    overlayActive: gate.overlayActive,
    slotCount: gate.slotCount
  })
  console.log('[AutoTest] rearrange gate', JSON.stringify(gate))
  if (!gate.enabled) return

  // ── TLM-07: a press SHORTER than the hold threshold stays a click ──
  // Timing-sensitive, so aggregate: all 5 trials must stay un-armed. One
  // false arm means a stray click could start dragging the user's Tasks.
  let shortPressArmed = 0
  for (let trial = 0; trial < 5; trial += 1) {
    const cells = gridCells()
    if (!cells[0]) break
    if (await pressAndHold(ctx, cells[0], 200)) shortPressArmed += 1
    // A short press opens the title menu; dismiss it before the next trial.
    debug.closeTitleMenu()
    await sleep(80)
  }
  record('TLM-07-short-press-does-not-arm', shortPressArmed === 0, {
    trials: 5,
    armed: shortPressArmed
  })

  // ── TLM-08: a press PAST the threshold arms rearrange mode ──
  let longPressArmed = 0
  for (let trial = 0; trial < 5; trial += 1) {
    const cells = gridCells()
    if (!cells[0]) break
    if (await pressAndHold(ctx, cells[0], 420)) longPressArmed += 1
    if (debug.getTaskRearrangeState().active) {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
      await sleep(80)
    }
  }
  record('TLM-08-long-press-arms-rearrange', longPressArmed === 5, {
    trials: 5,
    armed: longPressArmed
  })

  // ── TLM-08b: holding the header BAR (not the title text) also arms ──
  // Reported 2026-07-29: "holding the Task title bar does nothing". The title
  // text is a short run of characters inside a 24px strip that also holds the
  // dropdown button and the branch / repo / cwd chips, so a handle scoped to
  // the text alone is effectively un-aimable. The whole bar is the handle.
  let headerArmed = 0
  for (let trial = 0; trial < 5; trial += 1) {
    const cells = gridCells()
    if (!cells[0]) break
    if (await pressAndHold(ctx, cells[0], 420, 'header-blank')) headerArmed += 1
    if (debug.getTaskRearrangeState().active) {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
      await sleep(80)
    }
  }
  record('TLM-08b-header-bar-press-arms-rearrange', headerArmed === 5, {
    trials: 5,
    armed: headerArmed
  })

  // ── TLM-09: PTY survives a reorder ──
  // The marker is written through the real xterm write path before the drag
  // and read back after it. If the reorder remounted the terminal (or tore
  // the session down and rebuilt it), the scrollback would be gone.
  const orderBefore = domTerminalOrder()
  if (orderBefore.length < 2) {
    record('TLM-09-reorder-preserves-pty', false, { reason: 'need-two-terminals' })
    return
  }
  const markerId = orderBefore[0]
  // Deliberately short: getTailText joins the buffer line by line, so a
  // marker wide enough to soft-wrap would be split across two lines and
  // `includes()` would miss it for reasons unrelated to the PTY surviving.
  const marker = `__rmk${Date.now() % 1000000}__`
  const injected = debug.injectPtyData(`\r\n${marker}\r\n`, markerId)
  // xterm.write is asynchronous; wait for the marker to actually appear in
  // the buffer rather than assuming a fixed sleep was enough. If it never
  // lands, the failure is in the injection, not in the reorder.
  const markerLandedBefore = await waitFor(
    'rearrange-marker-visible',
    () => (debug.getTailText(markerId, 40) ?? '').includes(marker),
    4000,
    100
  )
  record('TLM-09a-marker-injected', injected && markerLandedBefore, {
    injected,
    markerLandedBefore
  })
  const sessionBefore = debug.getSessionState(markerId)

  await longPressDrag(ctx, 0, 1)

  const orderAfter = domTerminalOrder()
  const swapped = orderAfter[0] === orderBefore[1] && orderAfter[1] === orderBefore[0]
  record('TLM-10-drag-reorders-tasks', swapped, {
    before: orderBefore.slice(0, 2),
    after: orderAfter.slice(0, 2)
  })

  const tailAfter = debug.getTailText(markerId, 40) ?? ''
  const sessionAfter = debug.getSessionState(markerId)
  const ptyIntact = tailAfter.includes(marker)
    && sessionAfter?.status === sessionBefore?.status
    && sessionAfter?.open === true
  record('TLM-09-reorder-preserves-pty', ptyIntact, {
    markerFound: tailAfter.includes(marker),
    markerLandedBefore,
    tailLength: tailAfter.length,
    tailSample: tailAfter.slice(-160),
    statusBefore: sessionBefore?.status ?? null,
    statusAfter: sessionAfter?.status ?? null,
    openAfter: sessionAfter?.open ?? null
  })

  // ── TLM-11: Task numbers follow POSITION, not content ──
  // The confirmed product decision: after any reorder the first cell is
  // still "Task 1". A number that travelled with the terminal would break
  // the Cmd+1..8 shortcut contract.
  const firstTitle = gridCells()[0]?.querySelector('.terminal-grid-title')?.textContent ?? ''
  record('TLM-11-numbering-follows-position', firstTitle.startsWith('Task 1'), {
    firstCellTitle: firstTitle
  })

  // ── TLM-12: the dropdown arms a persistent (menu-triggered) session ──
  const trigger = gridCells()[0]?.querySelector<HTMLButtonElement>('[data-terminal-dropdown-trigger]')
  if (!trigger) {
    record('TLM-12-menu-arms-rearrange', false, { reason: 'dropdown-trigger-not-found' })
    return
  }
  trigger.click()
  await sleep(150)
  const menuItem = document.querySelector<HTMLButtonElement>('[data-terminal-dropdown-action="rearrange"]')
  if (!menuItem) {
    record('TLM-12-menu-arms-rearrange', false, { reason: 'rearrange-menu-item-not-found' })
    return
  }
  menuItem.click()
  const menuArmed = await waitFor(
    'menu-armed-rearrange',
    () => debug.getTaskRearrangeState().trigger === 'menu',
    3000,
    80
  )
  record('TLM-12-menu-arms-rearrange', menuArmed, {
    state: debug.getTaskRearrangeState()
  })

  // ESC must leave the mode (and must not leave the grid masked).
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
  const exited = await waitFor(
    'rearrange-mode-exited',
    () => !debug.getTaskRearrangeState().active && visibleGridEl()?.classList.contains('is-rearranging') !== true,
    3000,
    80
  )
  record('TLM-13-escape-exits-rearrange', exited, {
    state: debug.getTaskRearrangeState()
  })
}
