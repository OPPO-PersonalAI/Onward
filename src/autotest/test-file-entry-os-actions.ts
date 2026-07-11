/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * FEOS: file-entry OS actions — "Open with Default Application" + "Reveal in
 * Finder / File Explorer / File Manager" context-menu items across all six
 * surfaces (Project Editor tree / quick bars / search / outline / Monaco,
 * Git Diff file list, Git History file list).
 *
 * Runs against the temp git fixture built by
 * test/autotest/create-file-entry-os-actions-fixture.mjs. Under
 * ONWARD_AUTOTEST=1 the main-process shell handlers record the target path
 * instead of launching external apps; assertions read the recorded paths via
 * window.electronAPI.debug.shellGetLast{Opened,Revealed}Path().
 */
import type { AutotestContext, TestResult } from './types'
import { createTranslator, DEFAULT_LOCALE } from '../i18n/core'

const t = createTranslator(DEFAULT_LOCALE)

const OPEN_TESTID = 'file-entry-open-default'
const REVEAL_TESTID = 'file-entry-reveal'

function normalizePath(value: string): string {
  return value.replace(/\\/g, '/').replace(/\/+$/, '')
}

function pathBasename(value: string): string {
  const normalized = normalizePath(value)
  return normalized.slice(normalized.lastIndexOf('/') + 1)
}

/**
 * Recorded paths may differ from ctx.rootPath by symlink resolution (macOS
 * /var vs /private/var), so assert on the unique fixture-basename suffix
 * instead of full-string equality.
 */
function recordedPathMatches(recorded: string | null, rootPath: string, relPath: string): boolean {
  if (!recorded) return false
  return normalizePath(recorded).endsWith(`/${pathBasename(rootPath)}/${relPath}`)
}

function isVisibleElement(element: Element | null): element is HTMLElement {
  if (!(element instanceof HTMLElement)) return false
  if (element.getClientRects().length === 0) return false
  const style = window.getComputedStyle(element)
  return style.visibility !== 'hidden' && style.display !== 'none'
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

function dispatchClick(element: HTMLElement) {
  element.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
}

function closeAnyContextMenu() {
  document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }))
}

function dispatchEscape() {
  document.dispatchEvent(new KeyboardEvent('keydown', {
    key: 'Escape', code: 'Escape', bubbles: true, cancelable: true
  }))
}

/** menuRoot: '.project-editor-context-menu' | '.git-diff-context-menu' | '.git-history-context-menu' */
function getMenuActionButton(menuRoot: string, testid: string): HTMLButtonElement | null {
  const el = document.querySelector<HTMLButtonElement>(`${menuRoot} [data-testid="${testid}"]`)
  return el && isVisibleElement(el) ? el : null
}

function getMenuLabels(menuRoot: string): string[] {
  return Array.from(document.querySelectorAll<HTMLElement>(`${menuRoot} button`))
    .map((el) => (el.textContent || '').trim())
    .filter(Boolean)
}

function setInputValue(element: HTMLInputElement, value: string) {
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

function findTreeItemByPath(path: string): HTMLElement | null {
  const matches = Array.from(document.querySelectorAll<HTMLElement>(
    `.project-editor-tree-item[data-path="${CSS.escape(path)}"]`
  ))
  return matches.find((el) => isVisibleElement(el)) ?? matches[0] ?? null
}

export async function testFileEntryOsActions(ctx: AutotestContext): Promise<TestResult[]> {
  const { log, sleep, waitFor, assert, cancelled, terminalId, rootPath } = ctx
  const results: TestResult[] = []
  const _assert = (name: string, ok: boolean, detail?: Record<string, unknown>) => {
    assert(name, ok, detail)
    results.push({ name, ok, detail })
  }

  const debugApi = () => window.electronAPI.debug
  const editorApi = () => window.__onwardProjectEditorDebug
  const diffApi = () => window.__onwardGitDiffDebug
  const historyApi = () => window.__onwardGitHistoryDebug

  log('feos:start', { suite: 'FileEntryOsActions', rootPath })

  const resetRecorded = async () => { await debugApi().shellReset() }

  /**
   * Menu-open with retry (repeat-inside-the-test for the flaky sub-operation,
   * mirroring test-project-editor-sqlite's openContextMenuWithRetry).
   */
  const openMenuWithRetry = async (
    label: string,
    trigger: () => void,
    menuRoot: string,
    attempts = 4
  ): Promise<boolean> => {
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      closeAnyContextMenu()
      await waitFor(`${label}-closed-${attempt}`, () => !document.querySelector(menuRoot), 1000)
      trigger()
      const opened = await waitFor(
        `${label}-open-${attempt}`,
        () => Boolean(getMenuActionButton(menuRoot, OPEN_TESTID)),
        1500
      )
      if (opened) return true
      await sleep(200)
    }
    return false
  }

  /** Waits for the existence check to enable the item, then clicks it. */
  const clickMenuActionWhenEnabled = async (
    label: string,
    menuRoot: string,
    testid: string
  ): Promise<boolean> => {
    const enabled = await waitFor(`${label}-enabled`, () => {
      const button = getMenuActionButton(menuRoot, testid)
      return Boolean(button && !button.disabled)
    }, 4000)
    if (!enabled) return false
    const button = getMenuActionButton(menuRoot, testid)
    if (!button) return false
    dispatchClick(button)
    return true
  }

  const waitForRecordedOpen = (label: string, relPath: string) =>
    (async () => {
      let recorded: string | null = null
      const ok = await waitFor(`${label}-recorded`, () => {
        void debugApi().shellGetLastOpenedPath().then((value) => { recorded = value })
        return recorded !== null && recordedPathMatches(recorded, rootPath, relPath)
      }, 5000)
      return { ok, recorded }
    })()

  const waitForRecordedReveal = (label: string, relPath: string) =>
    (async () => {
      let recorded: string | null = null
      const ok = await waitFor(`${label}-recorded`, () => {
        void debugApi().shellGetLastRevealedPath().then((value) => { recorded = value })
        return recorded !== null && recordedPathMatches(recorded, rootPath, relPath)
      }, 5000)
      return { ok, recorded }
    })()

  const PE_MENU = '.project-editor-context-menu'
  const GD_MENU = '.git-diff-context-menu'
  const GH_MENU = '.git-history-context-menu'

  // ---- FEOS-01: open Project Editor ----
  window.dispatchEvent(new CustomEvent('project-editor:open', { detail: { terminalId } }))
  const editorOpen = await waitFor('feos-editor-open', () => Boolean(editorApi()?.isOpen?.()), 8000)
  _assert('FEOS-01-project-editor-open', editorOpen)
  if (!editorOpen || cancelled()) return results

  // ---- FEOS-02/03/04: file tree (surface A) ----
  const treeReady = await waitFor('feos-tree-ready', () => Boolean(findTreeItemByPath('readme.md')), 8000)
  _assert('FEOS-02A-tree-row-visible', treeReady)
  if (treeReady && !cancelled()) {
    const treeMenuOpen = await openMenuWithRetry(
      'feos-tree-menu',
      () => { const row = findTreeItemByPath('readme.md'); if (row) dispatchContextMenu(row) },
      PE_MENU
    )
    const labels = getMenuLabels(PE_MENU)
    _assert('FEOS-02B-tree-menu-has-os-items', treeMenuOpen && Boolean(getMenuActionButton(PE_MENU, REVEAL_TESTID)), { labels })

    await resetRecorded()
    const clickedOpen = treeMenuOpen && await clickMenuActionWhenEnabled('feos-tree-open', PE_MENU, OPEN_TESTID)
    const openResult = await waitForRecordedOpen('feos-tree-open', 'readme.md')
    _assert('FEOS-03-tree-open-default-records-path', clickedOpen && openResult.ok, {
      clickedOpen, recorded: openResult.recorded
    })

    const treeMenuOpen2 = await openMenuWithRetry(
      'feos-tree-menu-2',
      () => { const row = findTreeItemByPath('readme.md'); if (row) dispatchContextMenu(row) },
      PE_MENU
    )
    const clickedReveal = treeMenuOpen2 && await clickMenuActionWhenEnabled('feos-tree-reveal', PE_MENU, REVEAL_TESTID)
    const revealResult = await waitForRecordedReveal('feos-tree-reveal', 'readme.md')
    _assert('FEOS-04-tree-reveal-records-path', clickedReveal && revealResult.ok, {
      clickedReveal, recorded: revealResult.recorded
    })
  }

  // ---- FEOS-05: quick-recent bar (surface A, source quick-recent) ----
  if (!cancelled()) {
    await editorApi()?.openFileByPathAsUser?.('docs/guide.md', { trackRecent: true })
    const recentRowSelector = '.project-editor-quick-row.recent .project-editor-quick-item'
    const recentReady = await waitFor('feos-recent-ready', () => {
      return Array.from(document.querySelectorAll<HTMLElement>(recentRowSelector))
        .some((el) => isVisibleElement(el) && (el.textContent || '').includes('guide.md'))
    }, 6000)
    let recentRecorded: { ok: boolean; recorded: string | null } = { ok: false, recorded: null }
    let recentClicked = false
    if (recentReady) {
      await resetRecorded()
      const menuOpened = await openMenuWithRetry(
        'feos-recent-menu',
        () => {
          const row = Array.from(document.querySelectorAll<HTMLElement>(recentRowSelector))
            .find((el) => isVisibleElement(el) && (el.textContent || '').includes('guide.md'))
          if (row) dispatchContextMenu(row)
        },
        PE_MENU
      )
      recentClicked = menuOpened && await clickMenuActionWhenEnabled('feos-recent-open', PE_MENU, OPEN_TESTID)
      recentRecorded = await waitForRecordedOpen('feos-recent-open', 'docs/guide.md')
    }
    _assert('FEOS-05-quick-recent-open-default-records-path', recentReady && recentClicked && recentRecorded.ok, {
      recentReady, recentClicked, recorded: recentRecorded.recorded
    })
  }

  // ---- FEOS-06: global search results (surface D, source search) ----
  if (!cancelled()) {
    editorApi()?.setSidebarMode?.('search')
    const inputReady = await waitFor('feos-search-input', () => {
      const input = document.querySelector<HTMLInputElement>('.global-search-input')
      return Boolean(input && isVisibleElement(input))
    }, 5000)
    let searchRowReady = false
    let searchClicked = false
    let searchRecorded: { ok: boolean; recorded: string | null } = { ok: false, recorded: null }
    let searchMenuLabels: string[] = []
    if (inputReady) {
      const input = document.querySelector<HTMLInputElement>('.global-search-input')
      if (input) setInputValue(input, 'FEOSMARK')
      searchRowReady = await waitFor('feos-search-rows', () => {
        return Array.from(document.querySelectorAll<HTMLElement>('.global-search-file-header'))
          .some((el) => isVisibleElement(el) && (el.textContent || '').includes('readme.md'))
      }, 10000)
      if (searchRowReady) {
        await resetRecorded()
        const menuOpened = await openMenuWithRetry(
          'feos-search-menu',
          () => {
            const row = Array.from(document.querySelectorAll<HTMLElement>('.global-search-file-header'))
              .find((el) => isVisibleElement(el) && (el.textContent || '').includes('readme.md'))
            if (row) dispatchContextMenu(row)
          },
          PE_MENU
        )
        searchMenuLabels = getMenuLabels(PE_MENU)
        const hasCopyTrio = searchMenuLabels.includes(t('common.copyName'))
          && searchMenuLabels.includes(t('common.copyRelativePath'))
          && searchMenuLabels.includes(t('common.copyAbsolutePath'))
        _assert('FEOS-06A-search-menu-has-copy-trio-and-os-items', menuOpened && hasCopyTrio, { searchMenuLabels })
        searchClicked = menuOpened && await clickMenuActionWhenEnabled('feos-search-open', PE_MENU, OPEN_TESTID)
        searchRecorded = await waitForRecordedOpen('feos-search-open', 'readme.md')
      }
    }
    _assert('FEOS-06-search-open-default-records-path', inputReady && searchRowReady && searchClicked && searchRecorded.ok, {
      inputReady, searchRowReady, searchClicked, recorded: searchRecorded.recorded
    })
    editorApi()?.setSidebarMode?.('files')
    await sleep(300)
  }

  // ---- FEOS-07: outline pane (surface F, source outline; pin item must be absent) ----
  if (!cancelled()) {
    await editorApi()?.openFileByPathAsUser?.('readme.md')
    editorApi()?.setOutlineVisible?.(true)
    const outlineReady = await waitFor('feos-outline-ready', () => {
      const pane = document.querySelector<HTMLElement>('.project-editor-outline-pane')
      return Boolean(pane && isVisibleElement(pane))
    }, 6000)
    let outlineClicked = false
    let outlineRecorded: { ok: boolean; recorded: string | null } = { ok: false, recorded: null }
    let pinAbsent = false
    if (outlineReady) {
      await resetRecorded()
      const menuOpened = await openMenuWithRetry(
        'feos-outline-menu',
        () => {
          const pane = document.querySelector<HTMLElement>('.project-editor-outline-pane')
          if (pane) dispatchContextMenu(pane)
        },
        PE_MENU
      )
      const labels = getMenuLabels(PE_MENU)
      pinAbsent = menuOpened
        && !labels.includes(t('projectEditor.context.pin'))
        && !labels.includes(t('projectEditor.context.unpin'))
      _assert('FEOS-07A-outline-menu-hides-pin', pinAbsent, { labels })
      outlineClicked = menuOpened && await clickMenuActionWhenEnabled('feos-outline-open', PE_MENU, OPEN_TESTID)
      outlineRecorded = await waitForRecordedOpen('feos-outline-open', 'readme.md')
    }
    _assert('FEOS-07-outline-open-default-records-path', outlineReady && outlineClicked && outlineRecorded.ok, {
      outlineReady, outlineClicked, recorded: outlineRecorded.recorded
    })
  }

  // ---- FEOS-08: Monaco editor content area (surface E) ----
  if (!cancelled()) {
    await editorApi()?.openFileByPathAsUser?.('notes.txt')
    const monacoReady = await waitFor('feos-monaco-ready', () => {
      const lines = document.querySelector<HTMLElement>('.monaco-editor .view-lines')
      return Boolean(lines && isVisibleElement(lines))
    }, 8000)
    // Structural assertion on the Monaco action registry instead of driving
    // the rendered overlay with a synthetic contextmenu event (which Monaco's
    // ContextMenuController ignores in this harness): an action registered
    // with a contextMenuGroupId is shown by Monaco itself, so registration +
    // label is the invariant that belongs to our code.
    const registeredActions = await waitFor('feos-monaco-actions', () => {
      const actions = editorApi()?.getMonacoContextActions?.() ?? []
      return actions.some((action) => action.id.includes('onward.openWithDefaultApp'))
    }, 4000)
    const actionList = editorApi()?.getMonacoContextActions?.() ?? []
    const openAction = actionList.find((action) => action.id.includes('onward.openWithDefaultApp'))
    const revealAction = actionList.find((action) => action.id.includes('onward.revealInFileManager'))
    const copyActionCount = actionList.filter((action) => action.id.includes('onward.copy')).length
    _assert('FEOS-08A-monaco-actions-registered', Boolean(
      monacoReady && registeredActions
      && openAction?.label === t('common.openWithDefaultApp')
      && revealAction && copyActionCount === 3
    ), { monacoReady, actionList })

    await resetRecorded()
    const triggered = await editorApi()?.triggerMonacoContextAction?.('onward.openWithDefaultApp') ?? false
    const monacoRecorded = await waitForRecordedOpen('feos-monaco-open', 'notes.txt')
    _assert('FEOS-08-monaco-open-default-records-path', triggered && monacoRecorded.ok, {
      triggered, recorded: monacoRecorded.recorded
    })
  }

  // Close the Project Editor before the git surfaces.
  dispatchEscape()
  await waitFor('feos-editor-closed', () => !editorApi()?.isOpen?.(), 4000)
  await sleep(300)

  // ---- FEOS-09/10: Git Diff file list (surface B) ----
  if (!cancelled()) {
    window.dispatchEvent(new CustomEvent('git-diff:open', { detail: { terminalId, source: 'debug' } }))
    const diffOpen = await waitFor('feos-diff-open', () => Boolean(diffApi()?.isOpen?.()), 8000)
    _assert('FEOS-09A-git-diff-open', diffOpen)
    if (diffOpen) {
      const findDiffRow = (needle: string) =>
        Array.from(document.querySelectorAll<HTMLElement>('.git-diff-file-item'))
          .find((el) => isVisibleElement(el) && (el.textContent || '').includes(needle)) ?? null
      const rowsReady = await waitFor('feos-diff-rows', () => Boolean(findDiffRow('notes.txt') && findDiffRow('todelete.txt')), 10000)
      _assert('FEOS-09B-git-diff-rows-visible', rowsReady)

      if (rowsReady) {
        await resetRecorded()
        const menuOpened = await openMenuWithRetry(
          'feos-diff-menu',
          () => { const row = findDiffRow('notes.txt'); if (row) dispatchContextMenu(row) },
          GD_MENU
        )
        const clicked = menuOpened && await clickMenuActionWhenEnabled('feos-diff-open-action', GD_MENU, OPEN_TESTID)
        const recorded = await waitForRecordedOpen('feos-diff-open-action', 'notes.txt')
        _assert('FEOS-09-git-diff-open-default-records-path', clicked && recorded.ok, {
          clicked, recorded: recorded.recorded
        })

        // Deleted row: the open/reveal items must stay disabled.
        const deletedMenuOpened = await openMenuWithRetry(
          'feos-diff-deleted-menu',
          () => { const row = findDiffRow('todelete.txt'); if (row) dispatchContextMenu(row) },
          GD_MENU
        )
        // Give any (incorrect) async enable a beat to land before asserting.
        await sleep(600)
        const openButton = getMenuActionButton(GD_MENU, OPEN_TESTID)
        const revealButton = getMenuActionButton(GD_MENU, REVEAL_TESTID)
        _assert('FEOS-10-git-diff-deleted-row-disabled', Boolean(
          deletedMenuOpened && openButton?.disabled && revealButton?.disabled
        ), {
          deletedMenuOpened,
          openDisabled: openButton?.disabled ?? null,
          revealDisabled: revealButton?.disabled ?? null
        })
        closeAnyContextMenu()
      }
    }
    if (diffApi()?.isOpen?.()) {
      dispatchEscape()
      await sleep(400)
    }
  }

  // ---- FEOS-11: Git History file list (surface C) ----
  if (!cancelled()) {
    window.dispatchEvent(new CustomEvent('git-history:open', { detail: { terminalId } }))
    const historyOpen = await waitFor('feos-history-open', () => Boolean(historyApi()?.isOpen?.()), 8000)
    _assert('FEOS-11A-git-history-open', historyOpen)
    if (historyOpen) {
      const commitsLoaded = await waitFor('feos-history-commits', () => (historyApi()?.getCommitCount?.() ?? 0) > 0, 10000)
      if (commitsLoaded) historyApi()?.selectCommitByIndex?.(0)
      const findHistoryRow = () =>
        Array.from(document.querySelectorAll<HTMLElement>('.git-history-file-item'))
          .find((el) => isVisibleElement(el) && (el.textContent || '').includes('readme.md')) ?? null
      const rowsReady = await waitFor('feos-history-rows', () => Boolean(findHistoryRow()), 8000)
      let clicked = false
      let recorded: { ok: boolean; recorded: string | null } = { ok: false, recorded: null }
      if (rowsReady) {
        await resetRecorded()
        const menuOpened = await openMenuWithRetry(
          'feos-history-menu',
          () => { const row = findHistoryRow(); if (row) dispatchContextMenu(row) },
          GH_MENU
        )
        clicked = menuOpened && await clickMenuActionWhenEnabled('feos-history-open-action', GH_MENU, OPEN_TESTID)
        recorded = await waitForRecordedOpen('feos-history-open-action', 'readme.md')
      }
      _assert('FEOS-11-git-history-open-default-records-path', commitsLoaded && rowsReady && clicked && recorded.ok, {
        commitsLoaded, rowsReady, clicked, recorded: recorded.recorded
      })

      // ---- FEOS-12: TOCTOU failure toast stays visible (audit toast-01) ----
      // The existence check enables the item, the file disappears before the
      // click, the main handler fails — the openEntryFailed toast must render
      // even though no file row is left-click selected.
      if (commitsLoaded) {
        const findEphemeralRow = () =>
          Array.from(document.querySelectorAll<HTMLElement>('.git-history-file-item'))
            .find((el) => isVisibleElement(el) && (el.textContent || '').includes('ephemeral.txt')) ?? null
        const ephemeralReady = await waitFor('feos-toctou-row', () => Boolean(findEphemeralRow()), 8000)
        let toastVisible = false
        let deleted = false
        let clickedGone = false
        if (ephemeralReady) {
          const menuOpened = await openMenuWithRetry(
            'feos-toctou-menu',
            () => { const row = findEphemeralRow(); if (row) dispatchContextMenu(row) },
            GH_MENU
          )
          if (menuOpened) {
            const enabled = await waitFor('feos-toctou-enabled', () => {
              const button = getMenuActionButton(GH_MENU, OPEN_TESTID)
              return Boolean(button && !button.disabled)
            }, 4000)
            if (enabled) {
              const result = await window.electronAPI.project.deletePath(rootPath, 'ephemeral.txt')
              deleted = result?.success !== false
              const button = getMenuActionButton(GH_MENU, OPEN_TESTID)
              if (button) {
                dispatchClick(button)
                clickedGone = true
              }
              toastVisible = await waitFor('feos-toctou-toast', () => {
                const toast = document.querySelector<HTMLElement>('.path-copy-toast.error')
                return Boolean(toast && isVisibleElement(toast))
              }, 5000)
            }
          }
        }
        _assert('FEOS-12-toctou-failure-toast-visible', ephemeralReady && deleted && clickedGone && toastVisible, {
          ephemeralReady, deleted, clickedGone, toastVisible
        })
      }
    }
    if (historyApi()?.isOpen?.()) {
      dispatchEscape()
      await sleep(400)
    }
  }

  log('feos:done', { total: results.length, failed: results.filter((r) => !r.ok).length })
  return results
}
