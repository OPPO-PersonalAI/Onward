/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Phase 0.9: ProjectEditor SQLite preview and special test of adding, deleting, modifying and checking
 */
import type { AutotestContext, TestResult } from './types'
import { createTranslator, DEFAULT_LOCALE } from '../i18n/core'

type EditableElement = HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement
const t = createTranslator(DEFAULT_LOCALE)

function dispatchClick(element: HTMLElement) {
  element.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
}

function dispatchContextMenu(element: HTMLElement) {
  const rect = element.getBoundingClientRect()
  element.dispatchEvent(new MouseEvent('contextmenu', {
    bubbles: true,
    cancelable: true,
    button: 2,
    clientX: Math.max(1, rect.left + 8),
    clientY: Math.max(1, rect.top + 8)
  }))
}

function setFormValue(element: EditableElement, value: string) {
  const prototype = Object.getPrototypeOf(element) as Record<string, unknown>
  const descriptor = Object.getOwnPropertyDescriptor(prototype, 'value')
  const setter = descriptor?.set
  if (typeof setter === 'function') {
    setter.call(element, value)
  } else {
    element.value = value
  }
  element.dispatchEvent(new Event('input', { bubbles: true }))
  element.dispatchEvent(new Event('change', { bubbles: true }))
}

function findRowIndexByKeyword(keyword: string): number {
  const rows = Array.from(document.querySelectorAll<HTMLElement>('[data-testid^="sqlite-row-"]'))
  return rows.findIndex((row) => (row.textContent || '').includes(keyword))
}

function getTableText(): string {
  return document.querySelector('[data-testid="sqlite-data-table"]')?.textContent || ''
}

function getContextMenuLabels(): string[] {
  return Array.from(document.querySelectorAll<HTMLButtonElement>('.project-editor-context-menu .project-editor-context-item'))
    .map(button => (button.textContent || '').trim())
    .filter(Boolean)
}

function closeContextMenu() {
  document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }))
}

function isVisibleElement(element: HTMLElement): boolean {
  const rect = element.getBoundingClientRect()
  const style = window.getComputedStyle(element)
  return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden'
}

function findTreeItemByLabel(label: string): HTMLElement | null {
  const treeNames = Array.from(document.querySelectorAll<HTMLElement>('.project-editor-tree-item .project-editor-tree-name'))
  const matches = treeNames
    .filter((node) => (node.textContent || '').trim() === label)
    .map((node) => node.closest<HTMLElement>('.project-editor-tree-item'))
    .filter((node): node is HTMLElement => Boolean(node))
  return matches.find(isVisibleElement) ?? matches[0] ?? null
}

function findTreeItemByPath(path: string): HTMLElement | null {
  const matches = Array.from(document.querySelectorAll<HTMLElement>(
    `.project-editor-tree-item[data-path="${CSS.escape(path)}"]`
  ))
  return matches.find(isVisibleElement) ?? matches[0] ?? null
}

export async function testProjectEditorSqlite(ctx: AutotestContext): Promise<TestResult[]> {
  const { log, waitFor, assert, cancelled, rootPath, openFileInEditor } = ctx
  const results: TestResult[] = []
  const _assert = (name: string, ok: boolean, detail?: Record<string, unknown>) => {
    assert(name, ok, detail)
    results.push({ name, ok, detail })
  }

  const getApi = () => window.__onwardProjectEditorDebug
  const dbPathA = `onward-autotest-sqlite-a-${Date.now()}.sqlite`
  const dbPathB = `onward-autotest-sqlite-b-${Date.now()}.db`
  const shopFixturePath = 'test/autotest/fixtures/sqlite/shop-orders.sqlite'
  const mixedFixturePath = 'test/autotest/fixtures/sqlite/mixed-types.sqlite3'
  const stressFixturePath = 'test/autotest/fixtures/sqlite/stress-large.db'

  const hasCopyMenuItems = (requirePinAction: boolean) => {
    const labels = getContextMenuLabels()
    const hasPinAction = labels.includes(t('projectEditor.context.pin')) || labels.includes(t('projectEditor.context.unpin'))
    const hasCoreItems = labels.includes(t('common.copyName')) && labels.includes(t('common.copyRelativePath')) && labels.includes(t('common.copyAbsolutePath'))
    return requirePinAction ? (hasCoreItems && hasPinAction) : hasCoreItems
  }

  const openContextMenuWithRetry = async (
    label: string,
    trigger: () => void,
    predicate: () => boolean,
    attempts = 4,
    perAttemptTimeoutMs = 1500
  ) => {
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      closeContextMenu()
      await waitFor(
        `${label}-close-before-${attempt}`,
        () => getContextMenuLabels().length === 0,
        1000
      )
      trigger()
      const ready = await waitFor(
        `${label}-attempt-${attempt}`,
        predicate,
        perAttemptTimeoutMs
      )
      if (ready) return true
      closeContextMenu()
      await waitFor(
        `${label}-close-after-${attempt}`,
        () => getContextMenuLabels().length === 0,
        1000
      )
    }
    return false
  }

  const createA = await window.electronAPI.project.sqliteExecute(
    rootPath,
    dbPathA,
    `
      CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        age INTEGER
      );
      DELETE FROM users;
      INSERT INTO users (name, age) VALUES ('Alice', 19), ('Carol', 25);
    `
  )
  _assert('PSQL-01-create-sqlite-a', createA.success, { error: createA.error ?? null })
  if (!createA.success || cancelled()) return results

  const createB = await window.electronAPI.project.sqliteExecute(
    rootPath,
    dbPathB,
    `
      CREATE TABLE IF NOT EXISTS items (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        title TEXT NOT NULL,
        price REAL
      );
      DELETE FROM items;
      INSERT INTO items (title, price) VALUES ('Keyboard', 129.5), ('Mouse', 59.9);
    `
  )
  _assert('PSQL-02-create-sqlite-b', createB.success, { error: createB.error ?? null })
  if (!createB.success || cancelled()) return results

  try {
    await openFileInEditor(dbPathA)
    const openA = await waitFor(
      'sqlite-open-a',
      () => getApi()?.getActiveFilePath?.() === dbPathA && Boolean(getApi()?.isSqliteViewerVisible?.()),
      12000
    )
    _assert('PSQL-03-open-sqlite-file-a', openA, {
      activeFilePath: getApi()?.getActiveFilePath?.() ?? null,
      sqliteVisible: getApi()?.isSqliteViewerVisible?.() ?? false
    })
    if (!openA || cancelled()) return results

    const tableLoaded = await waitFor(
      'sqlite-table-loaded-a',
      () => {
        const grid = document.querySelector<HTMLElement>('[data-testid="sqlite-table-grid"]')
        if (!grid) return false
        return (grid.textContent || '').includes('users')
      },
      10000
    )
    _assert('PSQL-04-table-list-visible-a', tableLoaded, {
      tableGridText: document.querySelector<HTMLElement>('[data-testid="sqlite-table-grid"]')?.textContent || ''
    })
    if (!tableLoaded || cancelled()) return results

    const initialRowsVisible = await waitFor(
      'sqlite-initial-rows-a',
      () => getTableText().includes('Alice') && getTableText().includes('Carol'),
      10000
    )
    _assert('PSQL-05-initial-data-visible-a', initialRowsVisible, { tableText: getTableText().slice(0, 300) })
    if (!initialRowsVisible || cancelled()) return results

    const actionsHiddenBeforeEdit = !document.querySelector('[data-testid="sqlite-edit-row-0"]')
    _assert('PSQL-05b-actions-hidden-before-edit-mode', actionsHiddenBeforeEdit)

    const editToggle = document.querySelector<HTMLElement>('[data-testid="sqlite-edit-toggle"]')
    if (editToggle) dispatchClick(editToggle)
    const editModeEntered = await waitFor(
      'sqlite-edit-mode-enter',
      () => {
        const status = document.querySelector('[data-testid="sqlite-status"]')?.textContent || ''
        return status.includes('Edit mode enabled')
      },
      4000
    )
    _assert('PSQL-06-enter-edit-mode', editModeEntered)
    if (!editModeEntered || cancelled()) return results

    const editFirstRowButton = document.querySelector<HTMLElement>('[data-testid="sqlite-edit-row-0"]')
    if (editFirstRowButton) dispatchClick(editFirstRowButton)
    const nameInput = await waitFor(
      'sqlite-edit-row-input',
      () => Boolean(document.querySelector<HTMLInputElement>('[data-testid="sqlite-edit-input-0-name"]')),
      5000
    )
    _assert('PSQL-07-open-row-editor', nameInput)
    if (!nameInput || cancelled()) return results

    const nameEditInput = document.querySelector<HTMLInputElement>('[data-testid="sqlite-edit-input-0-name"]')
    if (nameEditInput) {
      setFormValue(nameEditInput, 'Alice-Updated')
    }
    const saveRowButton = document.querySelector<HTMLElement>('[data-testid="sqlite-save-row-0"]')
    if (saveRowButton) dispatchClick(saveRowButton)

    const updatedVisible = await waitFor(
      'sqlite-updated-row',
      () => getTableText().includes('Alice-Updated'),
      8000
    )
    _assert('PSQL-08-update-row-value', updatedVisible, { tableText: getTableText().slice(0, 300) })
    if (!updatedVisible || cancelled()) return results

    const addRowButton = document.querySelector<HTMLElement>('[data-testid="sqlite-add-row-button"]')
    if (addRowButton) dispatchClick(addRowButton)
    const insertRowVisible = await waitFor(
      'sqlite-insert-row-visible',
      () => Boolean(document.querySelector('[data-testid="sqlite-insert-row"]')),
      5000
    )
    _assert('PSQL-09-open-insert-row', insertRowVisible)
    if (!insertRowVisible || cancelled()) return results

    const insertName = document.querySelector<HTMLInputElement>('[data-testid="sqlite-insert-input-name"]')
    const insertAge = document.querySelector<HTMLInputElement>('[data-testid="sqlite-insert-input-age"]')
    if (insertName) setFormValue(insertName, 'Bob')
    if (insertAge) setFormValue(insertAge, '31')
    const insertConfirm = document.querySelector<HTMLElement>('[data-testid="sqlite-insert-confirm"]')
    if (insertConfirm) dispatchClick(insertConfirm)

    const insertedVisible = await waitFor(
      'sqlite-inserted-row-visible',
      () => getTableText().includes('Bob'),
      8000
    )
    _assert('PSQL-10-insert-row-value', insertedVisible, { tableText: getTableText().slice(0, 300) })
    if (!insertedVisible || cancelled()) return results

    const originalConfirm = window.confirm
    window.confirm = () => true
    const bobIndex = findRowIndexByKeyword('Bob')
    if (bobIndex >= 0) {
      const deleteBobButton = document.querySelector<HTMLElement>(`[data-testid="sqlite-delete-row-${bobIndex}"]`)
      if (deleteBobButton) dispatchClick(deleteBobButton)
    }
    window.confirm = originalConfirm

    const bobDeleted = await waitFor(
      'sqlite-delete-row-visible',
      () => !getTableText().includes('Bob'),
      8000
    )
    _assert('PSQL-11-delete-row-value', bobDeleted, { tableText: getTableText().slice(0, 300) })
    if (!bobDeleted || cancelled()) return results

    const rowVerify = await window.electronAPI.project.sqliteReadTableRows(rootPath, dbPathA, 'users', 100, 0)
    const rowNames = rowVerify.success
      ? rowVerify.rows.map(row => String(row.values.name ?? ''))
      : []
    _assert('PSQL-12-data-layer-crud-verified', rowVerify.success && rowNames.includes('Alice-Updated') && !rowNames.includes('Bob'), {
      error: rowVerify.success ? null : rowVerify.error,
      rowNames
    })
    if (!rowVerify.success || cancelled()) return results

    const sqlConsoleHiddenByDefault = !document.querySelector('[data-testid="sqlite-sql-console"]')
    _assert('PSQL-13a-sql-console-hidden-by-default', sqlConsoleHiddenByDefault)

    const sqlConsoleToggle = document.querySelector<HTMLElement>('[data-testid="sqlite-sql-console-toggle"]')
    if (sqlConsoleToggle) dispatchClick(sqlConsoleToggle)
    const sqlConsoleVisible = await waitFor(
      'sqlite-sql-console-open',
      () => Boolean(document.querySelector('[data-testid="sqlite-sql-console"]')),
      5000
    )
    _assert('PSQL-13b-sql-console-opened', sqlConsoleVisible)
    if (!sqlConsoleVisible || cancelled()) return results

    const sqlInput = document.querySelector<HTMLTextAreaElement>('[data-testid="sqlite-sql-input"]')
    const sqlRunButton = document.querySelector<HTMLElement>('[data-testid="sqlite-sql-run"]')
    if (sqlInput && sqlRunButton) {
      setFormValue(sqlInput, "UPDATE users SET age = 42 WHERE name = 'Alice-Updated';")
      dispatchClick(sqlRunButton)
      await waitFor(
        'sqlite-sql-update-done',
        () => (document.querySelector('[data-testid="sqlite-status"]')?.textContent || '').includes('SQL executed successfully'),
        8000
      )

      setFormValue(sqlInput, "SELECT age FROM users WHERE name = 'Alice-Updated';")
      dispatchClick(sqlRunButton)
    }

    const sqlResultVisible = await waitFor(
      'sqlite-sql-result-visible',
      () => {
        const resultText = document.querySelector('[data-testid="sqlite-sql-result"]')?.textContent || ''
        return resultText.includes('42')
      },
      10000
    )
    _assert('PSQL-13-sql-console-query-and-update', sqlResultVisible, {
      result: document.querySelector('[data-testid="sqlite-sql-result"]')?.textContent?.slice(0, 300) || null
    })
    if (!sqlResultVisible || cancelled()) return results

    const sqlResultHideButton = document.querySelector<HTMLElement>('[data-testid="sqlite-result-hide"]')
    if (sqlResultHideButton) dispatchClick(sqlResultHideButton)
    const sqlResultHidden = await waitFor(
      'sqlite-sql-result-hidden',
      () => Boolean(document.querySelector('[data-testid="sqlite-sql-result-collapsed"]')),
      5000
    )
    _assert('PSQL-13c-sql-result-hidden', sqlResultHidden)
    if (!sqlResultHidden || cancelled()) return results

    const sqlResultShowButton = document.querySelector<HTMLElement>('[data-testid="sqlite-result-show"]')
    if (sqlResultShowButton) dispatchClick(sqlResultShowButton)
    const sqlResultRestored = await waitFor(
      'sqlite-sql-result-restored',
      () => Boolean(document.querySelector('[data-testid="sqlite-sql-result"]')),
      5000
    )
    _assert('PSQL-13d-sql-result-restored', sqlResultRestored)
    if (!sqlResultRestored || cancelled()) return results

    await openFileInEditor(dbPathB)
    const openB = await waitFor(
      'sqlite-open-b',
      () => getApi()?.getActiveFilePath?.() === dbPathB && Boolean(getApi()?.isSqliteViewerVisible?.()),
      12000
    )
    _assert('PSQL-14-open-sqlite-file-b', openB, {
      activeFilePath: getApi()?.getActiveFilePath?.() ?? null,
      sqliteVisible: getApi()?.isSqliteViewerVisible?.() ?? false
    })
    if (!openB || cancelled()) return results

    const secondFileVisible = await waitFor(
      'sqlite-second-file-data',
      () => getTableText().includes('Keyboard') && getTableText().includes('Mouse'),
      10000
    )
    _assert('PSQL-15-second-file-data-visible', secondFileVisible, {
      tableText: getTableText().slice(0, 300)
    })
    if (!secondFileVisible || cancelled()) return results

    const switchStatus = document.querySelector('[data-testid="sqlite-status"]')?.textContent || ''
    _assert('PSQL-16-switch-file-no-missing-table-error', !switchStatus.includes('Table does not exist'), {
      status: switchStatus || null
    })
    if (cancelled()) return results

    await openFileInEditor(shopFixturePath)
    const openShop = await waitFor(
      'sqlite-open-shop-fixture',
      () => getApi()?.getActiveFilePath?.() === shopFixturePath && Boolean(getApi()?.isSqliteViewerVisible?.()),
      12000
    )
    _assert('PSQL-17-open-shop-orders-fixture', openShop, {
      activeFilePath: getApi()?.getActiveFilePath?.() ?? null
    })
    if (!openShop || cancelled()) return results

    const orderItemsChipReady = await waitFor(
      'sqlite-order-items-chip-ready',
      () => Boolean(document.querySelector('[data-testid="sqlite-table-chip-order_items"]')),
      8000
    )
    _assert('PSQL-18-order-items-chip-visible', orderItemsChipReady)
    if (!orderItemsChipReady || cancelled()) return results

    const orderItemsChip = document.querySelector<HTMLElement>('[data-testid="sqlite-table-chip-order_items"]')
    if (orderItemsChip) dispatchClick(orderItemsChip)
    const orderItemsLoaded = await waitFor(
      'sqlite-order-items-loaded',
      () => getTableText().includes('unit_price') && getTableText().includes('129.5'),
      10000
    )
    _assert('PSQL-19-order-items-data-visible', orderItemsLoaded, {
      tableText: getTableText().slice(0, 300)
    })
    if (!orderItemsLoaded || cancelled()) return results

    await openFileInEditor(mixedFixturePath)
    const openMixed = await waitFor(
      'sqlite-open-mixed-fixture',
      () => getApi()?.getActiveFilePath?.() === mixedFixturePath && Boolean(getApi()?.isSqliteViewerVisible?.()),
      12000
    )
    _assert('PSQL-20-open-mixed-types-fixture', openMixed, {
      activeFilePath: getApi()?.getActiveFilePath?.() ?? null
    })
    if (!openMixed || cancelled()) return results

    const mixedLoaded = await waitFor(
      'sqlite-mixed-loaded',
      () => getTableText().includes('theme') && getTableText().includes('dark-blue'),
      10000
    )
    const mixedStatus = document.querySelector('[data-testid="sqlite-status"]')?.textContent || ''
    _assert('PSQL-21-switch-from-order-items-without-error', mixedLoaded && !mixedStatus.includes('Table does not exist'), {
      status: mixedStatus || null,
      tableText: getTableText().slice(0, 300)
    })
    if (!mixedLoaded || cancelled()) return results

    await openFileInEditor(stressFixturePath)
    const openStress = await waitFor(
      'sqlite-open-stress-fixture',
      () => getApi()?.getActiveFilePath?.() === stressFixturePath && Boolean(getApi()?.isSqliteViewerVisible?.()),
      12000
    )
    _assert('PSQL-22-open-stress-large-fixture', openStress, {
      activeFilePath: getApi()?.getActiveFilePath?.() ?? null
    })
    if (!openStress || cancelled()) return results

    const stressLoaded = await waitFor(
      'sqlite-stress-loaded',
      () => {
        const pageInfo = document.querySelector('[data-testid="sqlite-page-info"]')?.textContent || ''
        return pageInfo.includes('20000 rows') || pageInfo.includes('15000 rows')
      },
      12000
    )
    const stressStatus = document.querySelector('[data-testid="sqlite-status"]')?.textContent || ''
    _assert('PSQL-23-large-db-load-success', stressLoaded && !stressStatus.toLowerCase().includes('too large'), {
      status: stressStatus || null,
      pageInfo: document.querySelector('[data-testid="sqlite-page-info"]')?.textContent || null
    })
    if (!stressLoaded || cancelled()) return results

    const defaultRowsReady = await waitFor(
      'sqlite-default-rows-100',
      () => document.querySelectorAll('[data-testid^="sqlite-row-"]').length === 100,
      10000
    )
    _assert('PSQL-24-default-page-size-100-rows', defaultRowsReady, {
      renderedRows: document.querySelectorAll('[data-testid^="sqlite-row-"]').length
    })
    if (!defaultRowsReady || cancelled()) return results

    const nextPageButton = document.querySelector<HTMLElement>('[data-testid="sqlite-page-next"]')
    if (nextPageButton) dispatchClick(nextPageButton)
    const nextPageOk = await waitFor(
      'sqlite-next-page',
      () => (document.querySelector('[data-testid="sqlite-page-info"]')?.textContent || '').includes('Page 2 /'),
      8000
    )
    _assert('PSQL-25-next-page-works', nextPageOk, {
      pageInfo: document.querySelector('[data-testid="sqlite-page-info"]')?.textContent || null
    })
    if (!nextPageOk || cancelled()) return results

    const jumpInput = document.querySelector<HTMLInputElement>('[data-testid="sqlite-page-jump-input"]')
    if (jumpInput) {
      setFormValue(jumpInput, '3')
      jumpInput.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'Enter',
        code: 'Enter',
        bubbles: true,
        cancelable: true
      }))
    }
    const jumpPageOk = await waitFor(
      'sqlite-jump-page',
      () => (document.querySelector('[data-testid="sqlite-page-info"]')?.textContent || '').includes('Page 3 /'),
      8000
    )
    _assert('PSQL-26-jump-page-works', jumpPageOk, {
      pageInfo: document.querySelector('[data-testid="sqlite-page-info"]')?.textContent || null
    })
    if (!jumpPageOk || cancelled()) return results

    const folderMenuReady = await openContextMenuWithRetry(
      'sqlite-folder-context-menu-copy-items',
      () => {
        const rootFolder = document.querySelector<HTMLElement>('.project-editor-tree-root')
        if (rootFolder) {
          dispatchContextMenu(rootFolder)
        }
      },
      () => hasCopyMenuItems(false),
      4,
      1500
    )
    _assert('PSQL-27-folder-copy-menu-visible', folderMenuReady, {
      labels: getContextMenuLabels()
    })
    closeContextMenu()
    await waitFor(
      'sqlite-folder-context-menu-closed',
      () => getContextMenuLabels().length === 0,
      3000
    )
    if (!folderMenuReady || cancelled()) return results

    const stressFileInTreeReady = await waitFor(
      'sqlite-tree-stress-file-visible',
      () => {
        // The file context menu opens via a synthetic event on the row's DOM
        // node, which only requires the row to be RENDERED in the virtualized
        // tree — NOT scrolled to any particular (e.g. centered) offset. So gate
        // only on the row existing in the DOM, and re-trigger locate each poll
        // so a missed/interrupted first scroll self-heals instead of
        // dead-waiting the full timeout. The previous gate also required
        // bounds.found && |centerOffsetRatio| <= 0.6 (a scroll-settle race on
        // the ACTIVE row, not necessarily this file's row), which made the
        // assertion flaky under cold-cache first runs even though the menu —
        // the actual thing under test — opened fine regardless of scroll.
        if (findTreeItemByPath(stressFixturePath)) {
          return true
        }
        getApi()?.clickLocateFileButton?.()
        return false
      },
      8000
    )
    const fileMenuReady = await openContextMenuWithRetry(
      'sqlite-file-context-menu-copy-items',
      () => {
        const stressFileItem = findTreeItemByPath(stressFixturePath) ?? findTreeItemByLabel('stress-large.db')
        if (stressFileItem) {
          dispatchContextMenu(stressFileItem)
        }
      },
      () => hasCopyMenuItems(true),
      5,
      1500
    )
    const fileMenuLabels = getContextMenuLabels()
    _assert('PSQL-28-file-copy-menu-visible', stressFileInTreeReady && fileMenuReady, {
      labels: fileMenuLabels,
      hasPinAction: fileMenuLabels.includes(t('projectEditor.context.pin')) || fileMenuLabels.includes(t('projectEditor.context.unpin'))
    })
    closeContextMenu()
  } finally {
    const cleanupA = await window.electronAPI.project.deletePath(rootPath, dbPathA)
    const cleanupB = await window.electronAPI.project.deletePath(rootPath, dbPathB)
    log('phase0.9:cleanup', {
      dbPathA,
      dbPathB,
      cleanupA: cleanupA.success,
      cleanupB: cleanupB.success,
      errA: cleanupA.error,
      errB: cleanupB.error
    })
  }

  return results
}
