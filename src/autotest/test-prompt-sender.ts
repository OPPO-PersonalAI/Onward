/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Phase 1: PromptSender UI test (agent_selector branch)
 */
import type { AutotestContext, TestResult } from './types'

/** The Task grid of the currently visible Tab. */
function visibleTaskGridElement(): HTMLElement | null {
  const wrappers = Array.from(document.querySelectorAll<HTMLElement>('.terminal-grid-wrapper'))
  const visible = wrappers.find(w => !w.classList.contains('terminal-grid-hidden')) ?? wrappers[0] ?? null
  return visible?.querySelector<HTMLElement>('.terminal-grid') ?? null
}

/** The Task selector inside the Prompt panel. */
function senderGridElement(): HTMLElement | null {
  const notebooks = Array.from(document.querySelectorAll<HTMLElement>('.prompt-notebook'))
  const notebook = notebooks.find(n => !n.classList.contains('prompt-notebook-hidden')) ?? notebooks[0] ?? null
  return notebook?.querySelector<HTMLElement>('.prompt-sender-terminals') ?? null
}

/**
 * Track counts as the engine actually resolved them. `grid-template-*`
 * computes to used pixel sizes ("70px 70px 70px 70px"), so counting the
 * entries reads the real rendered shape rather than the authored shorthand.
 */
function readGridTracks(element: HTMLElement): { columns: number; rows: number } {
  const style = window.getComputedStyle(element)
  const count = (value: string) => value.trim().split(/\s+/).filter(part => part && part !== 'none').length
  return {
    columns: count(style.gridTemplateColumns),
    rows: count(style.gridTemplateRows)
  }
}

/** 1-based grid rectangle an element occupies, read back from computed style. */
function readGridArea(element: HTMLElement): { colStart: number; colSpan: number; rowStart: number; rowSpan: number } {
  const style = window.getComputedStyle(element)
  const parse = (start: string, end: string) => {
    const startLine = Number.parseInt(start, 10)
    const spanMatch = /span\s+(\d+)/.exec(end)
    return {
      start: Number.isFinite(startLine) ? startLine : Number.NaN,
      span: spanMatch ? Number(spanMatch[1]) : 1
    }
  }
  const col = parse(style.gridColumnStart, style.gridColumnEnd)
  const row = parse(style.gridRowStart, style.gridRowEnd)
  return { colStart: col.start, colSpan: col.span, rowStart: row.start, rowSpan: row.span }
}

export async function testPromptSender(ctx: AutotestContext): Promise<TestResult[]> {
  const { log, sleep, waitFor, assert, cancelled } = ctx
  const results: TestResult[] = []
  const _assert = (name: string, ok: boolean, detail?: Record<string, unknown>) => {
    assert(name, ok, detail)
    results.push({ name, ok, detail })
  }

  log('phase1:start', { suite: 'PromptSender' })

  const getApi = () => window.__onwardPromptSenderDebug
  const getPromptNotebookApi = () => window.__onwardPromptNotebookDebug
  const getTerminalDebugApi = () => window.__onwardTerminalDebug
  const apiReady = await waitFor('prompt-sender-api', () => Boolean(getApi()), 8000)
  if (!apiReady) {
    log('phase1:skip', { reason: 'PromptSender Debug API not available' })
    results.push({ name: 'PS-00-api-available', ok: false, detail: { reason: 'API not mounted' } })
    return results
  }

  // PS-01: Terminal card rendering
  if (!cancelled()) {
    const api = getApi()!
    const cards = api.getTerminalCards()
    _assert('PS-01-terminal-cards', cards.length > 0, {
      count: cards.length,
      sample: cards.slice(0, 3).map(c => ({ id: c.id, title: c.title }))
    })
  }

  // PS-02: the Task selector is the same shape as the Task grid.
  // Read BOTH sides from real computed CSS rather than from the expected
  // mapping: a table that agrees with itself proves nothing, and the failure
  // mode we care about ("the grid moved to 4x2 and the selector stayed 2xN")
  // only shows up when the two are compared directly.
  if (!cancelled()) {
    const api = getApi()!
    const layout = api.getGridLayout()
    const senderGrid = senderGridElement()
    const taskGrid = visibleTaskGridElement()
    const senderTracks = senderGrid ? readGridTracks(senderGrid) : null
    const taskTracks = taskGrid ? readGridTracks(taskGrid) : null
    const gridAutoFlow = senderGrid ? window.getComputedStyle(senderGrid).gridAutoFlow : null
    const isRowFlow = typeof gridAutoFlow === 'string' && gridAutoFlow.startsWith('row')
    const mirrored = senderTracks !== null
      && taskTracks !== null
      && senderTracks.columns === taskTracks.columns
      && senderTracks.rows === taskTracks.rows
    const apiAgrees = senderTracks !== null
      && layout.columns === senderTracks.columns
      && layout.rows === senderTracks.rows
    _assert('PS-02-grid-layout-mirrors-task-grid', mirrored && apiAgrees && isRowFlow, {
      dataLayout: taskGrid?.getAttribute('data-layout') ?? null,
      layoutKind: layout.layoutKind,
      senderTracks,
      taskTracks,
      apiColumns: layout.columns,
      apiRows: layout.rows,
      totalCards: layout.totalCards,
      gridAutoFlow
    })
  }

  // PS-03: Click to select the terminal
  if (!cancelled()) {
    const cards = getApi()!.getTerminalCards()
    if (cards.length > 0) {
      getApi()!.deselectAllTerminals()
      await sleep(200)
      const targetId = cards[0].id
      const selected = getApi()!.selectTerminal(targetId)
      await sleep(200)
      const selectedIds = getApi()!.getSelectedTerminalIds()
      _assert('PS-03-select-terminal', selected && selectedIds.includes(targetId), {
        targetId,
        selected,
        selectedIds
      })
    } else {
      results.push({ name: 'PS-03-select-terminal', ok: false, detail: { reason: 'no terminals' } })
    }
  }

  // PS-04: Click to uncheck
  if (!cancelled()) {
    const cards = getApi()!.getTerminalCards()
    if (cards.length > 0) {
      const targetId = cards[0].id
      getApi()!.selectTerminal(targetId)
      await sleep(200)
      getApi()!.deselectTerminal(targetId)
      await sleep(200)
      const selectedIds = getApi()!.getSelectedTerminalIds()
      _assert('PS-04-deselect-terminal', !selectedIds.includes(targetId), {
        targetId,
        selectedIds
      })
    } else {
      results.push({ name: 'PS-04-deselect-terminal', ok: false, detail: { reason: 'no terminals' } })
    }
  }

  // PS-05: Selection summary tracks the selected count
  if (!cancelled()) {
    const api = getApi()!
    const cards = api.getTerminalCards()
    if (cards.length > 0) {
      api.deselectAllTerminals()
      await sleep(100)
      api.selectTerminal(cards[0].id)
      if (cards[1]) {
        api.selectTerminal(cards[1].id)
      }
      await sleep(200)
      const selectedIds = api.getSelectedTerminalIds()
      const selectedCount = api.getSelectedCount()
      const indicatorStates = api.getSelectionIndicatorStates()
      const indicatorCellIds = Array.from(document.querySelectorAll('.prompt-sender-selection-cell'))
        .map(cell => (cell as HTMLElement).dataset.terminalId ?? '')
      const expectedCount = Math.min(cards.length, 2)
      const expectedActiveIds = cards.slice(0, expectedCount).map(card => card.id)
      const activeIndicatorIds = indicatorStates.filter(state => state.isActive).map(state => state.id)
      _assert(
        'PS-05-selection-summary',
        selectedCount === expectedCount
          && selectedIds.length === expectedCount
          && indicatorStates.length === cards.length
          && indicatorCellIds.join('|') === cards.map(card => card.id).join('|')
          && activeIndicatorIds.join('|') === expectedActiveIds.join('|'),
        {
        selectedIds,
        selectedCount,
        indicatorStates,
        indicatorCellIds,
        expectedActiveIds,
        activeIndicatorIds,
        expectedCount
      })
      api.deselectAllTerminals()
      await sleep(100)
    } else {
      results.push({ name: 'PS-05-selection-summary', ok: false, detail: { reason: 'no terminals' } })
    }
  }

  // PS-06: 4 operation buttons
  if (!cancelled()) {
    const api = getApi()!
    const buttons = api.getActionButtons()
    const expectedLabels = ['Send and execute', 'Execute', 'Send', 'Send all and execute']
    const labelsMatch = buttons.length === 4 &&
      buttons.every((btn, i) => btn.label.includes(expectedLabels[i].substring(0, 2)))
    _assert('PS-06-action-buttons', buttons.length === 4 && labelsMatch, {
      count: buttons.length,
      labels: buttons.map(b => b.label),
      expected: expectedLabels
    })
  }

  // PS-07: Button disabled when unselected
  if (!cancelled()) {
    const api = getApi()!
    api.deselectAllTerminals()
    await sleep(100)
    const buttons = api.getActionButtons()
    // The first 3 buttons (Send and Execute, Execute, Send) should be disabled
    const first3Disabled = buttons.slice(0, 3).every(b => b.disabled)
    _assert('PS-07-buttons-disabled', first3Disabled, {
      buttonStates: buttons.map(b => ({ label: b.label, disabled: b.disabled }))
    })
  }

  // PS-08: Quickly select/cancel 20 times
  if (!cancelled()) {
    const api = getApi()!
    const cards = api.getTerminalCards()
    if (cards.length > 0) {
      const targetId = cards[0].id
      api.deselectAllTerminals()
      let lastState = false
      for (let i = 0; i < 20; i++) {
        if (cancelled()) break
        if (i % 2 === 0) {
          api.selectTerminal(targetId)
          lastState = true
        } else {
          api.deselectTerminal(targetId)
          lastState = false
        }
        await sleep(50)
      }
      const finalIds = api.getSelectedTerminalIds()
      const expected = lastState
      const actual = finalIds.includes(targetId)
      _assert('PS-08-rapid-toggle', actual === expected, {
        iterations: 20,
        expected,
        actual,
        finalIds
      })
    } else {
      results.push({ name: 'PS-08-rapid-toggle', ok: false, detail: { reason: 'no terminals' } })
    }
  }

  // PS-09: Multi-terminal layout detection (depends on the current number of terminals)
  if (!cancelled()) {
    const api = getApi()!
    const cards = api.getTerminalCards()
    const layout = api.getGridLayout()
    _assert('PS-09-layout-consistency', layout.totalCards === cards.length, {
      totalCards: layout.totalCards,
      actualCards: cards.length,
      columns: layout.columns,
      rows: layout.rows
    })
  }

  // PS-10: Single-line send-and-execute still runs end to end
  if (!cancelled()) {
    const notebookApi = getPromptNotebookApi()
    const terminalApi = getTerminalDebugApi()
    const cards = getApi()?.getTerminalCards() ?? []
    if (getApi() && notebookApi && terminalApi && cards.length > 0) {
      const platform = window.electronAPI.platform
      const targetId = cards[0].id
      const marker = `PS09-${Date.now()}`
      const command = platform === 'win32'
        ? `Write-Output '${marker}'`
        : `printf '${marker}\\n'`

      getApi()!.deselectAllTerminals()
      await sleep(100)
      getApi()!.selectTerminal(targetId)
      await sleep(100)
      notebookApi.setEditorContent(command)
      const editorSynced = await waitFor('ps09-editor-sync', () => {
        return getPromptNotebookApi()?.getEditorContent() === command
      }, 3000, 80)
      const senderPromptReady = await waitFor('ps09-sender-ready', () => {
        const buttons = getApi()?.getActionButtons() ?? []
        return buttons[3]?.disabled === false
      }, 3000, 80)

      const clicked = await getApi()!.clickAction('sendAndExecute')
      const idle = await waitFor('ps09-send-and-execute-idle', () => {
        return Boolean(getApi() && !getApi()!.isSubmitting())
      }, platform === 'win32' ? 10000 : 6000, 100)
      const executed = await waitFor('ps09-send-and-execute', () => {
        const tail = terminalApi.getTailText(targetId, 40) ?? ''
        return tail.includes(marker)
      }, platform === 'win32' ? 8000 : 5000, 100)

      _assert('PS-10-send-and-execute-single-line', editorSynced && senderPromptReady && clicked && idle && executed, {
        targetId,
        marker,
        editorSynced,
        senderPromptReady,
        clicked,
        idle,
        platform,
        selectedIds: getApi()?.getSelectedTerminalIds() ?? [],
        notice: getApi()?.getNotice() ?? null,
        buttonStates: getApi()?.getActionButtons() ?? [],
        editorContent: getPromptNotebookApi()?.getEditorContent() ?? null,
        tail: terminalApi.getTailText(targetId, 40)
      })

      notebookApi.setEditorContent('')
      await sleep(100)
    } else {
      results.push({
        name: 'PS-10-send-and-execute-single-line',
        ok: false,
        detail: { reason: 'debug api unavailable or no terminals' }
      })
    }
  }

  const getLayoutNotebook = () => {
    const notebooks = Array.from(document.querySelectorAll<HTMLElement>('.prompt-notebook'))
    return notebooks.find(notebook => !notebook.classList.contains('prompt-notebook-hidden')) ?? notebooks[0] ?? null
  }

  // PS-31: Terminals grid no longer has the legacy 140px hard cap
  if (!cancelled()) {
    const notebook = getLayoutNotebook()
    const grid = notebook?.querySelector('.prompt-sender-terminals') as HTMLElement | null
    if (grid) {
      const style = window.getComputedStyle(grid)
      const maxHeight = style.maxHeight
      const overflowY = style.overflowY
      const isUncapped = maxHeight === 'none' || maxHeight === '' || !maxHeight.endsWith('140px')
      _assert('PS-31-terminals-no-hard-cap', isUncapped && overflowY === 'auto', {
        maxHeight,
        overflowY
      })
    } else {
      _assert('PS-31-terminals-no-hard-cap', false, { reason: 'grid element not found' })
    }
  }

  // PS-32: Sender container enforces the 50% ceiling of the notebook
  if (!cancelled()) {
    const notebook = getLayoutNotebook()
    const sender = notebook?.querySelector('.prompt-sender') as HTMLElement | null
    if (sender && notebook) {
      const senderHeight = sender.getBoundingClientRect().height
      const notebookHeight = notebook.getBoundingClientRect().height
      const ceiling = notebookHeight * 0.5
      // 2px tolerance for sub-pixel rounding
      const withinCeiling = senderHeight <= ceiling + 2
      const senderMaxHeight = window.getComputedStyle(sender).maxHeight
      // Electron/Chromium may return the literal '50%' or a resolved px value.
      // Accept either: string ending with '%' and equals '50%', OR a px value
      // that is approximately half of the notebook height.
      const maxHeightRule = senderMaxHeight === '50%'
      const maxHeightPx = parseFloat(senderMaxHeight)
      const maxHeightPxHalf = senderMaxHeight.endsWith('px')
        && Number.isFinite(maxHeightPx)
        && Math.abs(maxHeightPx - ceiling) <= 2
      const maxHeightOk = maxHeightRule || maxHeightPxHalf
      _assert('PS-32-sender-respects-50-percent-cap', withinCeiling && maxHeightOk, {
        senderHeight,
        notebookHeight,
        ceiling,
        senderMaxHeight,
        maxHeightPx
      })
    } else {
      _assert('PS-32-sender-respects-50-percent-cap', false, { reason: 'sender or notebook not found' })
    }
  }

  // PS-33: Editor is compressible (flex-shrink: 1) with a 180px floor
  if (!cancelled()) {
    const notebook = getLayoutNotebook()
    const editor = notebook?.querySelector('.prompt-editor') as HTMLElement | null
    if (editor) {
      const style = window.getComputedStyle(editor)
      const minHeight = style.minHeight
      const flexShrink = style.flexShrink
      const minHeightPx = parseFloat(minHeight)
      const minHeightOk = Number.isFinite(minHeightPx) && Math.abs(minHeightPx - 180) <= 1
      const shrinkOk = flexShrink === '1'
      _assert('PS-33-editor-compressible-with-floor', minHeightOk && shrinkOk, {
        minHeight,
        flexShrink
      })
    } else {
      _assert('PS-33-editor-compressible-with-floor', false, { reason: 'editor element not found' })
    }
  }

  // PS-34: every card sits on the rectangle its Task occupies in the grid,
  // in the same DOM order as the Task array. This is the assertion that keeps
  // drag-to-rearrange honest: reordering rewrites the Task array, and BOTH
  // grids re-derive placement from it, so card N and grid cell N must always
  // name the same terminal.
  if (!cancelled()) {
    const api = getApi()!
    const layout = api.getGridLayout()
    const senderGrid = senderGridElement()
    const cards = senderGrid
      ? Array.from(senderGrid.querySelectorAll<HTMLElement>('.prompt-sender-terminal'))
      : []
    const cardIds = cards.map(card => card.dataset.terminalId ?? '')
    const slotIds = layout.slots.map(slot => slot.terminalId)
    const gridCellIds = Array.from(
      visibleTaskGridElement()?.querySelectorAll<HTMLElement>('.terminal-grid-cell') ?? []
    ).map(cell => cell.dataset.terminalId ?? '')
    const areas = cards.map(readGridArea)
    const areasMatch = areas.every((area, index) => {
      const slot = layout.slots[index]
      return slot
        && area.colStart === slot.colStart
        && area.colSpan === slot.colSpan
        && area.rowStart === slot.rowStart
        && area.rowSpan === slot.rowSpan
    })
    // The grid can hold MORE cells than the selector shows only if the two
    // disagree about the effective Task count, so compare the shared prefix
    // and require the selector to cover every visible grid cell.
    const orderMatchesGrid = cardIds.length === gridCellIds.length
      && cardIds.every((id, index) => id === gridCellIds[index])
    _assert(
      'PS-34-cards-mirror-grid-slots',
      cards.length > 0 && areasMatch && orderMatchesGrid && cardIds.join('|') === slotIds.join('|'),
      { cardIds, slotIds, gridCellIds, areas, slots: layout.slots }
    )
  }

  // PS-35: the selection swatch beside the action buttons uses the same
  // scale model — same tracks, same rectangles — so it reads as a miniature
  // of the layout rather than a second, contradictory one.
  if (!cancelled()) {
    const api = getApi()!
    const layout = api.getGridLayout()
    const notebook = getLayoutNotebook()
    const indicator = notebook?.querySelector<HTMLElement>('.prompt-sender-selection-indicator') ?? null
    const cells = indicator
      ? Array.from(indicator.querySelectorAll<HTMLElement>('.prompt-sender-selection-cell'))
      : []
    const tracks = indicator ? readGridTracks(indicator) : null
    const areasMatch = cells.every((cell, index) => {
      const slot = layout.slots[index]
      const area = readGridArea(cell)
      return slot
        && area.colStart === slot.colStart
        && area.colSpan === slot.colSpan
        && area.rowStart === slot.rowStart
        && area.rowSpan === slot.rowSpan
    })
    _assert(
      'PS-35-selection-indicator-mirrors-layout',
      tracks !== null
        && tracks.columns === layout.columns
        && tracks.rows === layout.rows
        && cells.length === layout.slots.length
        && areasMatch,
      { tracks, apiColumns: layout.columns, apiRows: layout.rows, cells: cells.length }
    )
  }

  // PS-36: a slot too narrow for a name shows the Task's position number
  // instead. Both branches are asserted from a real layout pass — the grid is
  // temporarily forced narrow and then wide, because the panel width alone
  // cannot reach both sides of the threshold in one run. The override is
  // reverted before the assertion returns.
  if (!cancelled()) {
    const senderGrid = senderGridElement()
    const firstCard = senderGrid?.querySelector<HTMLElement>('.prompt-sender-terminal') ?? null
    const name = firstCard?.querySelector<HTMLElement>('.prompt-sender-terminal-name') ?? null
    const index = firstCard?.querySelector<HTMLElement>('.prompt-sender-terminal-index') ?? null
    if (senderGrid && firstCard && name && index) {
      const originalWidth = senderGrid.style.width
      const measure = async (width: string) => {
        senderGrid.style.width = width
        // Two frames: one for the style change to land, one for the container
        // query to re-evaluate against the new layout.
        await sleep(120)
        return {
          cardWidth: Math.round(firstCard.getBoundingClientRect().width),
          nameShown: window.getComputedStyle(name).display !== 'none',
          indexShown: window.getComputedStyle(index).display !== 'none'
        }
      }
      // 40px is under the 44px content-box threshold even for a ONE-column
      // layout (6px padding + 1px border each side), so the narrow branch is
      // reachable whatever layout the suite inherited; 640px clears it for
      // every layout up to 4 columns.
      const narrow = await measure('40px')
      const wide = await measure('640px')
      senderGrid.style.width = originalWidth
      await sleep(80)

      const narrowOk = !narrow.nameShown && narrow.indexShown
      const wideOk = wide.nameShown && !wide.indexShown
      _assert('PS-36-narrow-slot-shows-position-number', narrowOk && wideOk, {
        narrow,
        wide
      })
      // The override must leave nothing behind: a stuck inline width would
      // silently break every later suite that reads this panel.
      _assert('PS-36b-width-override-reverted', senderGrid.style.width === originalWidth, {
        inlineWidth: senderGrid.style.width,
        originalWidth,
        widthAfterRestore: Math.round(firstCard.getBoundingClientRect().width)
      })
    } else {
      _assert('PS-36-narrow-slot-shows-position-number', false, { reason: 'card or labels not found' })
    }
  }

  log('phase1:done', {
    total: results.length,
    passed: results.filter(r => r.ok).length,
    failed: results.filter(r => !r.ok).length
  })

  return results
}
