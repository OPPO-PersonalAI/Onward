/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

import type { AutotestContext, TestResult } from './types'

/**
 * Right-click context menu on the prompt editor textarea.
 * Locks down: clipboard primitives, pinned-import / save-as-pin loop,
 * insert helpers (cwd / branch / task title), format tools, send-to-Task
 * submenu, clear-all, and platform-correct shortcut hints.
 */
export async function testPromptEditorContextMenu(ctx: AutotestContext): Promise<TestResult[]> {
  const { assert, cancelled, log, sleep, waitFor } = ctx
  const results: TestResult[] = []
  const record = (name: string, ok: boolean, detail?: Record<string, unknown>) => {
    assert(name, ok, detail)
    results.push({ name, ok, detail })
  }

  log('PECM:start', { suite: 'PromptEditorContextMenu' })

  const notebookApi = () => (window as unknown as {
    __onwardPromptNotebookDebug?: {
      getPrompts: () => Array<{ id: string; title: string; content: string; pinned: boolean; lastUsedAt: number; sendHistoryCount?: number }>
      setEditorContent: (content: string) => void
      getEditorContent: () => string
      getLastEditorSendToTask?: () => { content: string; terminalId: string } | null
      reorderPinnedPrompts?: (dragId: string, targetId: string, position: 'before' | 'after') => boolean
    }
  }).__onwardPromptNotebookDebug
  const senderApi = () => (window as unknown as {
    __onwardPromptSenderDebug?: {
      getTerminalCards: () => Array<{ id: string; title: string }>
      getPromptContent?: () => string
      selectTerminal?: (id: string) => boolean
      deselectAllTerminals?: () => void
      clickAction?: (action: 'sendAndExecute' | 'execute' | 'send' | 'sendAllAndExecute') => Promise<boolean>
    }
  }).__onwardPromptSenderDebug
  const terminalApi = () => (window as unknown as {
    __onwardTerminalDebug?: {
      getTailText: (terminalId?: string, lastLines?: number) => string | null
    }
  }).__onwardTerminalDebug

  const apisReady = await waitFor('pecm-apis', () => Boolean(notebookApi() && senderApi()), 8000, 120)
  if (!apisReady) {
    record('PECM-00-api-available', false, { reason: 'PromptNotebook debug API not mounted' })
    return results
  }

  const cards = senderApi()!.getTerminalCards()
  if (cards.length === 0) {
    record('PECM-00-terminal-cards', false, { reason: 'no terminals available' })
    return results
  }

  const isMac = (window as { electronAPI?: { platform?: string } }).electronAPI?.platform === 'darwin'

  const findTextarea = () => document.querySelector<HTMLElement>(
    '.prompt-notebook:not(.prompt-notebook-hidden) .prompt-editor-content'
  )

  const findMenu = () => document.querySelector('.prompt-editor-context-menu') as HTMLElement | null

  // The editor is a contenteditable div: value via innerText (layout-aware,
  // '\n' for line breaks), caret via the Selection/Range API mapped to flat
  // text offsets. Content is written as a single text node (via textContent /
  // the debug control), so Range offsets equal flat text offsets.
  const getContent = (): string => findTextarea()?.innerText ?? ''

  // Map a flat text offset to a (node, offset) DOM position by walking text
  // nodes; clamps past the end.
  const locateOffset = (el: HTMLElement, offset: number): { node: Node; off: number } => {
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT)
    let remaining = Math.max(0, offset)
    let last: Text | null = null
    let node = walker.nextNode() as Text | null
    while (node) {
      if (remaining <= node.length) return { node, off: remaining }
      remaining -= node.length
      last = node
      node = walker.nextNode() as Text | null
    }
    if (last) return { node: last, off: last.length }
    return { node: el, off: 0 }
  }

  const getDivSelection = (): { start: number; end: number } => {
    const el = findTextarea()
    const sel = window.getSelection()
    if (!el || !sel || sel.rangeCount === 0) return { start: -1, end: -1 }
    const range = sel.getRangeAt(0)
    const pre = document.createRange()
    pre.selectNodeContents(el)
    try {
      pre.setEnd(range.startContainer, range.startOffset)
      const start = pre.toString().length
      pre.setEnd(range.endContainer, range.endOffset)
      const end = pre.toString().length
      return { start, end }
    } catch {
      return { start: -1, end: -1 }
    }
  }

  const setText = async (text: string): Promise<boolean> => {
    notebookApi()?.setEditorContent(text)
    return waitFor('pecm-text-set', () => {
      if (getContent() === text) return true
      notebookApi()?.setEditorContent(text)
      return false
    }, 4000, 80)
  }

  const setSelection = (start: number, end: number) => {
    const el = findTextarea()
    if (!el) return false
    el.focus()
    const sel = window.getSelection()
    if (!sel) return false
    const s = locateOffset(el, start)
    const e = locateOffset(el, end)
    const range = document.createRange()
    try {
      range.setStart(s.node, s.off)
      range.setEnd(e.node, e.off)
    } catch {
      return false
    }
    sel.removeAllRanges()
    sel.addRange(range)
    const got = getDivSelection()
    return got.start === start && got.end === end
  }

  const openMenu = async (): Promise<HTMLElement | null> => {
    const ta = findTextarea()
    if (!ta) return null
    ta.focus()
    const rect = ta.getBoundingClientRect()
    const dispatch = () => {
      ta.dispatchEvent(new MouseEvent('contextmenu', {
        bubbles: true,
        cancelable: true,
        button: 2,
        clientX: rect.left + 10,
        clientY: rect.top + 10
      }))
    }
    dispatch()
    const ready = await waitFor('pecm-menu-open', () => {
      if (findMenu() !== null) return true
      dispatch()
      return false
    }, 2500, 40)
    if (!ready) return null
    return findMenu()
  }

  // Atomically set the textarea value+selection AND fire the contextmenu
  // event in a single synchronous chain — no awaits between the value-set
  // and the contextmenu dispatch. This guarantees the menu's snapshot
  // captures the freshly-set value, even if React reconciliation would
  // otherwise revert it on the next render. Use this whenever a PECM
  // block needs the menu to operate on a specific value/cursor pair.
  const openMenuWith = async (
    text: string,
    cursorStart: number,
    cursorEnd: number,
    point?: { clientX: number; clientY: number }
  ): Promise<HTMLElement | null> => {
    const ta = findTextarea()
    if (!ta) return null
    ta.focus()
    notebookApi()?.setEditorContent(text)
    setSelection(cursorStart, cursorEnd)
    const rect = ta.getBoundingClientRect()
    const menuPoint = point ?? { clientX: rect.left + 10, clientY: rect.top + 10 }
    const dispatch = () => {
      notebookApi()?.setEditorContent(text)
      setSelection(cursorStart, cursorEnd)
      ta.dispatchEvent(new MouseEvent('contextmenu', {
        bubbles: true,
        cancelable: true,
        button: 2,
        clientX: menuPoint.clientX,
        clientY: menuPoint.clientY
      }))
    }
    dispatch()
    const ready = await waitFor('pecm-menu-open', () => {
      if (findMenu() !== null) return true
      dispatch()
      return false
    }, 2500, 40)
    if (!ready) return null
    return findMenu()
  }

  const closeMenu = async () => {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
    document.body.dispatchEvent(new MouseEvent('mousedown', {
      bubbles: true,
      cancelable: true,
      clientX: 1,
      clientY: 1
    }))
    await waitFor('pecm-menu-closed', () => findMenu() === null, 1000, 40)
    // Give React a settle tick so any pending re-render from the previous
    // submenu/menu unmount + debounced parent notify completes before the
    // next openMenu dispatches a contextmenu event.
    await sleep(60)
  }

  const clickItem = (testId: string): boolean => {
    const root = findMenu()
    if (!root) return false
    const el = root.querySelector(`[data-testid="${testId}"]`) as HTMLButtonElement | null
    if (!el) return false
    if (el.disabled) return false
    el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    return true
  }

  const isItemDisabled = (testId: string): boolean => {
    const root = findMenu()
    if (!root) return false
    const el = root.querySelector(`[data-testid="${testId}"]`) as HTMLButtonElement | null
    return Boolean(el && el.disabled)
  }

  const openSubmenuByTestId = async (triggerId: string, submenuId: string): Promise<HTMLElement | null> => {
    const root = findMenu()
    const trigger = root?.querySelector(`[data-testid="${triggerId}"]`) as HTMLElement | null
    if (!trigger) return null
    trigger.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true, cancelable: true }))
    trigger.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    const ready = await waitFor(`pecm-${submenuId}`, () => {
      return document.querySelector(`[data-testid="${submenuId}"]`) !== null
    }, 1500, 40)
    if (!ready) return null
    await sleep(80)
    return document.querySelector(`[data-testid="${submenuId}"]`) as HTMLElement | null
  }

  const findTerminalContextMenu = () =>
    document.querySelector('.terminal-context-menu') as HTMLElement | null

  const findTerminalContainer = (terminalId: string) => {
    const cells = Array.from(document.querySelectorAll<HTMLElement>('.terminal-grid-cell[data-terminal-id]'))
    const cell = cells.find(el => el.getAttribute('data-terminal-id') === terminalId)
    return cell?.querySelector('.terminal-grid-container') as HTMLElement | null
  }

  const closeTerminalContextMenu = async () => {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
    document.body.dispatchEvent(new MouseEvent('mousedown', {
      bubbles: true,
      cancelable: true,
      clientX: 2,
      clientY: 2
    }))
    await waitFor('pecm-terminal-menu-closed', () => findTerminalContextMenu() === null, 1000, 40)
  }

  const openTerminalContextMenu = async (terminalId: string): Promise<HTMLElement | null> => {
    await closeTerminalContextMenu()
    const container = findTerminalContainer(terminalId)
    if (!container) return null
    const rect = container.getBoundingClientRect()
    const dispatch = () => {
      container.dispatchEvent(new MouseEvent('contextmenu', {
        bubbles: true,
        cancelable: true,
        button: 2,
        clientX: rect.left + Math.max(8, Math.min(24, rect.width / 2)),
        clientY: rect.top + Math.max(8, Math.min(24, rect.height / 2))
      }))
    }
    dispatch()
    const ready = await waitFor('pecm-terminal-context-menu-open', () => {
      if (findTerminalContextMenu() !== null) return true
      dispatch()
      return false
    }, 2500, 40)
    return ready ? findTerminalContextMenu() : null
  }

  const openTerminalPinnedSubmenu = async (): Promise<HTMLElement | null> => {
    const root = findTerminalContextMenu()
    const trigger = root?.querySelector('[data-testid="terminal-context-send-pinned"]') as HTMLElement | null
    if (!trigger) return null
    trigger.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true, cancelable: true }))
    trigger.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    const ready = await waitFor('pecm-terminal-pinned-submenu', () => {
      return document.querySelector('[data-testid="terminal-context-pinned-submenu"]') !== null
    }, 1500, 40)
    return ready
      ? document.querySelector('[data-testid="terminal-context-pinned-submenu"]') as HTMLElement | null
      : null
  }

  const savePinnedPromptViaMenu = async (content: string, marker: string) => {
    const beforePinIds = new Set(notebookApi()!.getPrompts().filter(p => p.pinned).map(p => p.id))
    const pinMenu = await openMenuWith(content, 0, content.length)
    if (!pinMenu) return null
    const clicked = clickItem('pecm-save-as-pin')
    const saved = await waitFor(`pecm-save-pin-${marker}`, () => {
      return notebookApi()!.getPrompts().some(p => p.pinned && p.title.includes(marker) && !beforePinIds.has(p.id))
    }, 3000, 80)
    await closeMenu()
    if (!clicked || !saved) return null
    return notebookApi()!.getPrompts().find(p => p.pinned && p.title.includes(marker) && !beforePinIds.has(p.id)) ?? null
  }

  const rectDetail = (el: HTMLElement | null) => {
    const rect = el?.getBoundingClientRect()
    return rect
      ? {
          left: Math.round(rect.left),
          top: Math.round(rect.top),
          right: Math.round(rect.right),
          bottom: Math.round(rect.bottom),
          width: Math.round(rect.width),
          height: Math.round(rect.height),
          viewportWidth: window.innerWidth,
          viewportHeight: window.innerHeight
        }
      : null
  }

  const rectWithinViewport = (el: HTMLElement | null, margin = 8): boolean => {
    const rect = el?.getBoundingClientRect()
    if (!rect) return false
    const epsilon = 1
    return rect.left >= margin - epsilon &&
      rect.top >= margin - epsilon &&
      rect.right <= window.innerWidth - margin + epsilon &&
      rect.bottom <= window.innerHeight - margin + epsilon
  }

  const installSubmenuBoundaryStressStyle = () => {
    const style = document.createElement('style')
    style.dataset.testid = 'pecm-submenu-boundary-stress-style'
    style.textContent = `
      .prompt-editor-context-submenu[data-testid="pecm-send-to-task-submenu"],
      .prompt-editor-context-submenu[data-testid="pecm-import-pin-submenu"] {
        width: calc(100vw + 160px);
        max-width: none;
        max-height: none;
      }
      .prompt-editor-context-submenu[data-testid="pecm-send-to-task-submenu"]::after,
      .prompt-editor-context-submenu[data-testid="pecm-import-pin-submenu"]::after {
        content: "";
        display: block;
        height: calc(100vh + 160px);
      }
    `
    document.head.appendChild(style)
    return () => style.remove()
  }

  const clipboardWrite = async (text: string) => {
    try {
      const electronWrite = (window as unknown as { electronAPI?: { clipboard?: { writeText?: (t: string) => Promise<unknown> } } })
        .electronAPI?.clipboard?.writeText
      if (electronWrite) {
        await electronWrite(text)
      } else {
        await navigator.clipboard.writeText(text)
      }
    } catch (err) {
      log('PECM:clipboard-write-failed', { err: String(err) })
    }
  }

  const clipboardRead = async (): Promise<string | null> => {
    try {
      const electronRead = (window as unknown as { electronAPI?: { clipboard?: { readText?: () => Promise<string> } } })
        .electronAPI?.clipboard?.readText
      if (electronRead) {
        return await electronRead()
      }
      return await navigator.clipboard.readText()
    } catch (err) {
      log('PECM:clipboard-read-failed', { err: String(err) })
      return null
    }
  }

  // ─────────── PECM-01: menu opens on contextmenu ───────────
  if (cancelled()) return results
  let menu = await openMenuWith('hello world', 0, 0)
  const itemCount = menu ? menu.querySelectorAll('[role="menuitem"]').length : 0
  record('PECM-01-menu-opens', menu !== null && itemCount > 0, {
    found: menu !== null,
    items: itemCount
  })
  if (!menu) return results

  // ─────────── PECM-04: Send to Task is the first top-level action ───────────
  const topLevelIds = Array.from(menu.querySelectorAll<HTMLElement>('[role="menuitem"]'))
    .map(el => el.getAttribute('data-testid') ?? '')
  const sendIndex04 = topLevelIds.indexOf('pecm-send-to-task')
  const undoIndex04 = topLevelIds.indexOf('pecm-undo')
  record('PECM-04-send-to-task-before-undo', sendIndex04 === 0 && undoIndex04 === 1, {
    topLevelIds,
    sendIndex: sendIndex04,
    undoIndex: undoIndex04
  })

  // ─────────── PECM-02: cut / copy disabled when no selection ───────────
  const cutDisabled = isItemDisabled('pecm-cut')
  const copyDisabled = isItemDisabled('pecm-copy')
  record('PECM-02-cut-copy-disabled-without-selection', cutDisabled && copyDisabled, {
    cutDisabled,
    copyDisabled
  })
  await closeMenu()

  // ─────────── PECM-03: paste inserts at cursor ───────────
  const pasteMarker = `pecm-paste-${Date.now()}`
  await clipboardWrite(pasteMarker)
  menu = await openMenuWith('AB', 1, 1)
  if (!menu) {
    record('PECM-03-paste', false, { reason: 'menu did not open before paste' })
  }
  const clickedPaste = clickItem('pecm-paste')
  await waitFor('pecm-paste-applied', () => {
    const v = getContent()
    return v === `A${pasteMarker}B`
  }, 2000, 40)
  record('PECM-03-paste-inserts-at-cursor', clickedPaste && getContent() === `A${pasteMarker}B`, {
    clickedPaste,
    actual: getContent(),
    expected: `A${pasteMarker}B`
  })
  await closeMenu()
  // ─────────── PECM-05: cut with selection updates clipboard + content ───────────
  menu = await openMenuWith('CUT-PRE-MARKER cut-target CUT-POST-MARKER', 'CUT-PRE-MARKER '.length, 'CUT-PRE-MARKER cut-target'.length)
  if (!menu) {
    record('PECM-05-cut', false, { reason: 'menu did not open' })
  }
  const clickedCut = clickItem('pecm-cut')
  await waitFor('pecm-cut-applied', () => {
    return getContent() === 'CUT-PRE-MARKER  CUT-POST-MARKER'
  }, 2000, 40)
  const cutClipboard = await clipboardRead()
  record('PECM-05-cut-with-selection', clickedCut && cutClipboard === 'cut-target' && getContent() === 'CUT-PRE-MARKER  CUT-POST-MARKER', {
    clickedCut,
    cutClipboard,
    content: getContent()
  })
  await closeMenu()

  // ─────────── PECM-06: save selection as pinned prompt ───────────
  const pinMarker = `PECM-pin-${Date.now()}`
  const pinSelection = `${pinMarker}-line-one\nline-two`
  menu = await openMenuWith(pinSelection, 0, pinSelection.length)
  if (!menu) {
    record('PECM-06-save-as-pin', false, { reason: 'menu did not open' })
  }
  const beforePinIds = new Set(notebookApi()!.getPrompts().filter(p => p.pinned).map(p => p.id))
  const clickedSavePin = clickItem('pecm-save-as-pin')
  await waitFor('pecm-save-pin-applied', () => {
    return notebookApi()!.getPrompts().some(p => p.pinned && p.title.includes(pinMarker) && !beforePinIds.has(p.id))
  }, 3000, 80)
  const savedPin = notebookApi()!.getPrompts().find(p => p.pinned && p.title.includes(pinMarker))
  record('PECM-06-save-selection-as-pinned', clickedSavePin && Boolean(savedPin), {
    clickedSavePin,
    savedPin
  })
  await closeMenu()

  // ─────────── PECM-07: import pinned submenu shows newly saved entry ───────────
  menu = await openMenuWith('', 0, 0)
  if (!menu) {
    record('PECM-07-import-pin', false, { reason: 'menu did not open' })
  }
  // Hover to open submenu
  const importTrigger = menu?.querySelector('[data-testid="pecm-import-pin"]') as HTMLElement | null
  importTrigger?.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true, cancelable: true }))
  importTrigger?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
  const submenuReady = await waitFor('pecm-import-pin-submenu', () => {
    return document.querySelector('[data-testid="pecm-import-pin-submenu"]') !== null
  }, 1500, 40)
  const submenuRoot = document.querySelector('[data-testid="pecm-import-pin-submenu"]') as HTMLElement | null
  const submenuItems = submenuRoot ? Array.from(submenuRoot.querySelectorAll('[role="menuitem"]')) : []
  const matchingPinItem = submenuItems.find(el => (el.textContent ?? '').includes(pinMarker)) as HTMLButtonElement | undefined
  matchingPinItem?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
  await waitFor('pecm-import-pin-applied', () => {
    return getContent().includes(pinMarker)
  }, 2000, 40)
  record('PECM-07-import-pinned-appends', submenuReady && Boolean(matchingPinItem) && getContent().includes(pinMarker), {
    submenuReady,
    foundItem: Boolean(matchingPinItem),
    afterContent: getContent()
  })
  await closeMenu()

  // ─────────── PECM-08: insert project path / branch / task title ───────────
  menu = await openMenuWith('PRE---POST', 'PRE'.length, 'PRE'.length)
  if (!menu) {
    record('PECM-08-insert-cwd', false, { reason: 'menu did not open' })
  }
  const cwdItem = menu?.querySelector('[data-testid="pecm-insert-cwd"]') as HTMLButtonElement | null
  const cwdAttr = cwdItem?.getAttribute('title') ?? ''
  const cwdEnabled = Boolean(cwdItem && !cwdItem.disabled)
  const clickedCwd = clickItem('pecm-insert-cwd')
  await waitFor('pecm-cwd-applied', () => {
    return getContent() !== 'PRE---POST' && getContent().startsWith('PRE')
  }, 2000, 40)
  const afterCwd = getContent()
  record('PECM-08-insert-project-path', cwdEnabled && clickedCwd && afterCwd.startsWith('PRE') && afterCwd.endsWith('---POST') && afterCwd.length > 'PRE---POST'.length, {
    cwdAttr,
    afterCwd
  })
  await closeMenu()

  menu = await openMenuWith('TT---ZZ', 'TT'.length, 'TT'.length)
  if (!menu) {
    record('PECM-09-insert-task-title', false, { reason: 'menu did not open' })
  }
  const taskTitleItem = menu?.querySelector('[data-testid="pecm-insert-task-title"]') as HTMLButtonElement | null
  const taskTitleEnabled = Boolean(taskTitleItem && !taskTitleItem.disabled)
  const clickedTaskTitle = clickItem('pecm-insert-task-title')
  await waitFor('pecm-task-title-applied', () => {
    return getContent() !== 'TT---ZZ' && getContent().startsWith('TT')
  }, 2000, 40)
  const afterTaskTitle = getContent()
  record('PECM-09-insert-task-title', taskTitleEnabled && clickedTaskTitle && afterTaskTitle.startsWith('TT') && afterTaskTitle.endsWith('---ZZ') && afterTaskTitle.length > 'TT---ZZ'.length, {
    afterTaskTitle
  })
  await closeMenu()

  // ─────────── PECM-13: send-to-task submenu lists active tasks ───────────
  menu = await openMenuWith('PECM dispatch payload', 0, 0)
  if (!menu) {
    record('PECM-13-send-to-task', false, { reason: 'menu did not open' })
  }
  const sendTrigger = menu?.querySelector('[data-testid="pecm-send-to-task"]') as HTMLElement | null
  sendTrigger?.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true, cancelable: true }))
  sendTrigger?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
  const sendSubmenuReady = await waitFor('pecm-send-submenu', () => {
    return document.querySelector('[data-testid="pecm-send-to-task-submenu"]') !== null
  }, 1500, 40)
  const sendSubmenuRoot = document.querySelector('[data-testid="pecm-send-to-task-submenu"]') as HTMLElement | null
  const sendSubmenuItems = sendSubmenuRoot ? Array.from(sendSubmenuRoot.querySelectorAll('[role="menuitem"]')) : []
  record('PECM-13-send-to-task-submenu-lists-tasks', sendSubmenuReady && sendSubmenuItems.length === cards.length, {
    expected: cards.length,
    actual: sendSubmenuItems.length,
    titles: sendSubmenuItems.map(el => el.textContent?.trim() ?? '')
  })
  await closeMenu()

  // ─────────── PECM-14: clear-all empties content ───────────
  menu = await openMenuWith('something to clear', 0, 0)
  if (!menu) {
    record('PECM-14-clear-all', false, { reason: 'menu did not open' })
  }
  const clickedClear = clickItem('pecm-clear')
  await waitFor('pecm-clear-applied', () => {
    return getContent() === ''
  }, 2000, 40)
  record('PECM-14-clear-all-empties-editor', clickedClear && getContent() === '', {
    clickedClear,
    after: getContent()
  })
  await closeMenu()

  // ─────────── PECM-15: platform-correct shortcut hint ───────────
  menu = await openMenuWith('shortcut-hint', 0, 0)
  const cutShortcut = menu?.querySelector('[data-testid="pecm-cut"] .prompt-editor-context-shortcut')?.textContent?.trim() ?? ''
  const pasteShortcut = menu?.querySelector('[data-testid="pecm-paste"] .prompt-editor-context-shortcut')?.textContent?.trim() ?? ''
  const expectedCut = isMac ? '⌘X' : 'Ctrl+X'
  const expectedPaste = isMac ? '⌘V' : 'Ctrl+V'
  record('PECM-15-platform-shortcut-hint', menu !== null && cutShortcut === expectedCut && pasteShortcut === expectedPaste, {
    menuFound: menu !== null,
    isMac,
    cutShortcut,
    pasteShortcut,
    expectedCut,
    expectedPaste
  })
  await closeMenu()

  // ─────────── PECM-35: Send-to-Task submenu clamps to the viewport ───────────
  // Stress the same failure mode as a tiny app window without resizing the
  // BrowserWindow: make the submenu wider and taller than the viewport, open
  // it at the bottom-right click point, and require the visible box to be
  // shifted/clamped inside the Onward viewport with internal scrolling.
  const removeStressStyle35 = installSubmenuBoundaryStressStyle()
  menu = await openMenuWith('PECM boundary payload', 0, 0, {
    clientX: window.innerWidth - 2,
    clientY: window.innerHeight - 2
  })
  const sendBoundarySubmenu35 = await openSubmenuByTestId('pecm-send-to-task', 'pecm-send-to-task-submenu')
  const sendStyle35 = sendBoundarySubmenu35 ? getComputedStyle(sendBoundarySubmenu35) : null
  const sendRect35 = rectDetail(sendBoundarySubmenu35)
  const sendWithin35 = rectWithinViewport(sendBoundarySubmenu35)
  const sendScrollable35 = Boolean(sendBoundarySubmenu35 && sendBoundarySubmenu35.scrollHeight > sendBoundarySubmenu35.clientHeight)
  record('PECM-35-send-to-task-submenu-clamps-to-viewport', Boolean(menu) && sendWithin35 && sendScrollable35, {
    menuFound: Boolean(menu),
    rect: sendRect35,
    maxWidth: sendStyle35?.maxWidth,
    maxHeight: sendStyle35?.maxHeight,
    scrollHeight: sendBoundarySubmenu35?.scrollHeight,
    clientHeight: sendBoundarySubmenu35?.clientHeight
  })
  removeStressStyle35()
  await closeMenu()

  // ─────────── PECM-36: Import Pin submenu uses the same viewport clamp ───────────
  const removeStressStyle36 = installSubmenuBoundaryStressStyle()
  menu = await openMenuWith('', 0, 0, {
    clientX: window.innerWidth - 2,
    clientY: window.innerHeight - 2
  })
  const pinBoundarySubmenu36 = await openSubmenuByTestId('pecm-import-pin', 'pecm-import-pin-submenu')
  const pinStyle36 = pinBoundarySubmenu36 ? getComputedStyle(pinBoundarySubmenu36) : null
  const pinRect36 = rectDetail(pinBoundarySubmenu36)
  const pinWithin36 = rectWithinViewport(pinBoundarySubmenu36)
  const pinScrollable36 = Boolean(pinBoundarySubmenu36 && pinBoundarySubmenu36.scrollHeight > pinBoundarySubmenu36.clientHeight)
  record('PECM-36-import-pin-submenu-clamps-to-viewport', Boolean(menu) && pinWithin36 && pinScrollable36, {
    menuFound: Boolean(menu),
    rect: pinRect36,
    maxWidth: pinStyle36?.maxWidth,
    maxHeight: pinStyle36?.maxHeight,
    scrollHeight: pinBoundarySubmenu36?.scrollHeight,
    clientHeight: pinBoundarySubmenu36?.clientHeight
  })
  removeStressStyle36()
  await closeMenu()

  // ─────────── PECM-16: Undo restores prior state from menu mutation ───────────
  // Apply a menu mutation (insert cwd at cursor of "before|after"), then undo,
  // and verify content is back to the pre-mutation snapshot.
  menu = await openMenuWith('before|after', 'before|'.length, 'before|'.length)
  if (!menu) {
    record('PECM-16-undo', false, { reason: 'menu did not open before insert' })
  }
  // Trigger a real, observable mutation: insert project path at cursor.
  const undoCwdItem = menu?.querySelector('[data-testid="pecm-insert-cwd"]') as HTMLButtonElement | null
  undoCwdItem?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
  await waitFor('pecm-undo-pre-state', () => getContent() !== 'before|after', 2000, 40)
  const afterInsert = getContent()
  await closeMenu()
  // Now reopen the menu — Undo should be enabled because we just pushed a mutation.
  menu = await openMenuWith(afterInsert, afterInsert.length, afterInsert.length)
  const undoItemEnabled = menu ? !(menu.querySelector('[data-testid="pecm-undo"]') as HTMLButtonElement | null)?.disabled : false
  const clickedUndo = clickItem('pecm-undo')
  await waitFor('pecm-undo-applied', () => getContent() === 'before|after', 2000, 40)
  record('PECM-16-undo-restores-prior-state', undoItemEnabled && clickedUndo && getContent() === 'before|after', {
    afterInsert,
    afterUndo: getContent(),
    undoItemEnabled,
    clickedUndo
  })
  await closeMenu()

  // ─────────── PECM-22: submit-time transform strips trailing whitespace + empty rows ───────────
  // Set textarea to "send-trim hi   \n\n   " then dispatch Cmd/Ctrl+Enter.
  // The new prompt that lands in the prompts list must have content trimmed
  // to "send-trim hi" — proves transformVirtualPaddingForSend is wired into
  // the submit path.
  const submitMarker = `send-trim-${Date.now()}`
  const submitInput = `${submitMarker}\n\n   `
  await setText(submitInput)
  const ta22 = findTextarea()
  const before22Ids = new Set(notebookApi()!.getPrompts().map(p => p.id))
  if (ta22) {
    ta22.focus()
    const ev = new KeyboardEvent('keydown', {
      key: 'Enter', code: 'Enter', bubbles: true, cancelable: true,
      ...(isMac ? { metaKey: true } : { ctrlKey: true })
    })
    ta22.dispatchEvent(ev)
  }
  await waitFor('pecm-22-prompt-saved', () => {
    return notebookApi()!.getPrompts().some(p => !before22Ids.has(p.id) && p.title === '' && p.content === submitMarker)
  }, 3000, 80).catch(() => false)
  const submitted22 = notebookApi()!.getPrompts().find(p => !before22Ids.has(p.id) && p.content === submitMarker)
  record('PECM-22-send-transform-strips-trailing', Boolean(submitted22), {
    foundContent: submitted22?.content,
    expected: submitMarker
  })
  await setText('')

  // ─────────── PECM-33: PromptSender receives stripped editor content ───────────
  const senderMarker33 = `sender-preview-${Date.now()}`
  await setText(`${senderMarker33}\n\n   `)
  const senderPreviewReady33 = await waitFor('pecm-33-sender-preview', () => {
    return senderApi()?.getPromptContent?.() === senderMarker33
  }, 4000, 80)
  record('PECM-33-prompt-sender-content-transform', senderPreviewReady33 && senderApi()?.getPromptContent?.() === senderMarker33, {
    actual: JSON.stringify(senderApi()?.getPromptContent?.() ?? null),
    expected: JSON.stringify(senderMarker33)
  })

  // ─────────── PECM-34: context-menu Send-to-Task sends the stripped snapshot ───────────
  await setText('')
  const ctxMarker34 = `ctx-send-${Date.now()}`
  await setText(`${ctxMarker34}\n\n   `)
  menu = await openMenu()
  const targetTerminal34 = cards[0]?.id ?? null
  const sendTrigger34 = menu?.querySelector('[data-testid="pecm-send-to-task"]') as HTMLElement | null
  sendTrigger34?.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true, cancelable: true }))
  sendTrigger34?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
  await waitFor('pecm-34-submenu', () => {
    return document.querySelector('[data-testid="pecm-send-to-task-submenu"]') !== null
  }, 1500, 40)
  const submenu34 = document.querySelector('[data-testid="pecm-send-to-task-submenu"]') as HTMLElement | null
  const firstTask34 = submenu34?.querySelector('[role="menuitem"]') as HTMLButtonElement | null
  firstTask34?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
  await waitFor('pecm-34-send-debug', () => {
    return notebookApi()?.getLastEditorSendToTask?.()?.content === ctxMarker34
  }, 3000, 80).catch(() => false)
  const tail34 = targetTerminal34 ? terminalApi()?.getTailText(targetTerminal34, 40) ?? '' : ''
  const sentDebug34 = notebookApi()?.getLastEditorSendToTask?.() ?? null
  record('PECM-34-context-send-to-task-transform', sentDebug34?.content === ctxMarker34 && sentDebug34.terminalId === targetTerminal34, {
    sentDebug: sentDebug34,
    expectedContent: ctxMarker34,
    expectedTerminalId: targetTerminal34,
    tailHasMarker: tail34.includes(ctxMarker34)
  })

  // ─────────── PECM-38: Import Pin follows manual Prompt History pin order ───────────
  const orderedFirstMarker38 = `pin-order-first-${Date.now()}`
  const orderedSecondMarker38 = `pin-order-second-${Date.now()}`
  const orderedFirstContent38 = `echo ${orderedFirstMarker38}`
  const orderedSecondContent38 = `echo ${orderedSecondMarker38}`
  const firstOrderPin38 = await savePinnedPromptViaMenu(orderedFirstContent38, orderedFirstMarker38)
  await sleep(30)
  const secondOrderPin38 = await savePinnedPromptViaMenu(orderedSecondContent38, orderedSecondMarker38)
  const reorderAvailable38 = typeof notebookApi()?.reorderPinnedPrompts === 'function'
  const reordered38 = Boolean(
    firstOrderPin38 &&
    secondOrderPin38 &&
    notebookApi()?.reorderPinnedPrompts?.(firstOrderPin38.id, secondOrderPin38.id, 'before')
  )
  await waitFor('pecm-38-pinned-order-applied', () => {
    const ids = notebookApi()!.getPrompts().filter(p => p.pinned).map(p => p.id)
    return Boolean(firstOrderPin38 && secondOrderPin38) &&
      ids.indexOf(firstOrderPin38!.id) >= 0 &&
      ids.indexOf(secondOrderPin38!.id) >= 0 &&
      ids.indexOf(firstOrderPin38!.id) < ids.indexOf(secondOrderPin38!.id)
  }, 2000, 80)
  menu = await openMenuWith('', 0, 0)
  const importSubmenu38 = await openSubmenuByTestId('pecm-import-pin', 'pecm-import-pin-submenu')
  const importLabels38 = importSubmenu38
    ? Array.from(importSubmenu38.querySelectorAll('[role="menuitem"]')).map(el => el.textContent ?? '')
    : []
  const firstImportIndex38 = importLabels38.findIndex(label => label.includes(orderedFirstMarker38))
  const secondImportIndex38 = importLabels38.findIndex(label => label.includes(orderedSecondMarker38))
  record('PECM-38-import-pin-manual-order', Boolean(firstOrderPin38) && Boolean(secondOrderPin38) && reorderAvailable38 && reordered38 && firstImportIndex38 >= 0 && secondImportIndex38 >= 0 && firstImportIndex38 < secondImportIndex38, {
    firstOrderPin: firstOrderPin38,
    secondOrderPin: secondOrderPin38,
    reorderAvailable: reorderAvailable38,
    reordered: reordered38,
    importLabels: importLabels38,
    firstImportIndex: firstImportIndex38,
    secondImportIndex: secondImportIndex38
  })
  await closeMenu()

  // ─────────── TPCM-01..03: terminal content menu sends pinned prompt to right-clicked Task ───────────
  const targetTerminalTpcm = cards[Math.min(1, cards.length - 1)]?.id ?? cards[0]?.id ?? null
  const beforeFirstPinTpcm = firstOrderPin38
    ? notebookApi()!.getPrompts().find(p => p.id === firstOrderPin38.id) ?? null
    : null
  const terminalMenuTpcm = targetTerminalTpcm ? await openTerminalContextMenu(targetTerminalTpcm) : null
  const terminalSubmenuTpcm = terminalMenuTpcm ? await openTerminalPinnedSubmenu() : null
  const terminalLabelsTpcm = terminalSubmenuTpcm
    ? Array.from(terminalSubmenuTpcm.querySelectorAll('[role="menuitem"]')).map(el => el.textContent ?? '')
    : []
  const firstTerminalIndexTpcm = terminalLabelsTpcm.findIndex(label => label.includes(orderedFirstMarker38))
  const secondTerminalIndexTpcm = terminalLabelsTpcm.findIndex(label => label.includes(orderedSecondMarker38))
  record('TPCM-01-terminal-pin-menu-manual-order', Boolean(targetTerminalTpcm) && terminalMenuTpcm !== null && terminalSubmenuTpcm !== null && firstTerminalIndexTpcm >= 0 && secondTerminalIndexTpcm >= 0 && firstTerminalIndexTpcm < secondTerminalIndexTpcm, {
    targetTerminal: targetTerminalTpcm,
    terminalLabels: terminalLabelsTpcm,
    firstTerminalIndex: firstTerminalIndexTpcm,
    secondTerminalIndex: secondTerminalIndexTpcm
  })

  const firstTerminalItemTpcm = terminalSubmenuTpcm
    ? Array.from(terminalSubmenuTpcm.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'))
      .find(el => (el.textContent ?? '').includes(orderedFirstMarker38)) ?? null
    : null
  firstTerminalItemTpcm?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
  const terminalReceivedTpcm = Boolean(targetTerminalTpcm) && await waitFor('tpcm-terminal-received-pinned-prompt', () => {
    return terminalApi()?.getTailText(targetTerminalTpcm!, 80)?.includes(orderedFirstMarker38) === true
  }, 5000, 120)
  const otherTerminalHasMarkerTpcm = cards
    .filter(card => card.id !== targetTerminalTpcm)
    .some(card => terminalApi()?.getTailText(card.id, 80)?.includes(orderedFirstMarker38) === true)
  record('TPCM-02-terminal-pin-menu-sends-to-right-clicked-task', Boolean(firstTerminalItemTpcm) && terminalReceivedTpcm && !otherTerminalHasMarkerTpcm, {
    targetTerminal: targetTerminalTpcm,
    clicked: Boolean(firstTerminalItemTpcm),
    terminalReceived: terminalReceivedTpcm,
    otherTerminalHasMarker: otherTerminalHasMarkerTpcm,
    targetTail: targetTerminalTpcm ? terminalApi()?.getTailText(targetTerminalTpcm, 80) ?? '' : ''
  })

  const afterFirstPinTpcm = firstOrderPin38
    ? notebookApi()!.getPrompts().find(p => p.id === firstOrderPin38.id) ?? null
    : null
  record('TPCM-03-terminal-pin-menu-does-not-touch-prompt-history', Boolean(beforeFirstPinTpcm) && Boolean(afterFirstPinTpcm) &&
    beforeFirstPinTpcm?.lastUsedAt === afterFirstPinTpcm?.lastUsedAt &&
    (beforeFirstPinTpcm?.sendHistoryCount ?? 0) === (afterFirstPinTpcm?.sendHistoryCount ?? 0), {
    beforeLastUsedAt: beforeFirstPinTpcm?.lastUsedAt,
    afterLastUsedAt: afterFirstPinTpcm?.lastUsedAt,
    beforeSendHistoryCount: beforeFirstPinTpcm?.sendHistoryCount ?? 0,
    afterSendHistoryCount: afterFirstPinTpcm?.sendHistoryCount ?? 0
  })
  await closeTerminalContextMenu()

  // Restore an empty editor so subsequent suites start clean.
  await setText('')

  log('PECM:done', {
    total: results.length,
    passed: results.filter(r => r.ok).length,
    failed: results.filter(r => !r.ok).length
  })

  return results
}
