/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

import type { AutotestContext, TestResult } from './types'

/**
 * Unified modal dismiss policy (2026-07-16) — cross-surface wiring checks.
 *
 * Policy under test:
 * - Backdrop (blank-space) clicks on modal dialogs are INERT: the dialog
 *   stays open and in-progress input is preserved.
 * - ESC is the one keyboard path that safely cancels a modal.
 *
 * Surfaces here are the representatives of each mechanism class that has
 * no dedicated dialog-dismiss coverage elsewhere:
 * - ProjectEditor prompt dialog (the reported "new file naming" case)
 * - TabBar close-tab confirm (shared `.confirm-dialog-overlay` pattern +
 *   newly added useModalEscape)
 * - PromptNotebook send-history panel (newly added useModalEscape)
 * Companion coverage: CL-09/CL-09b (ChangeLog), GLF-14..17 (large-file
 * confirm inside GitDiff/GitHistory), TLM-04b/04c (DownsizeConfirmDialog).
 */
export async function testModalDismiss(ctx: AutotestContext): Promise<TestResult[]> {
  const { assert, cancelled, log, sleep, waitFor } = ctx
  const results: TestResult[] = []
  const record = (name: string, ok: boolean, detail?: Record<string, unknown>) => {
    assert(name, ok, detail)
    results.push({ name, ok, detail })
  }

  const peApi = () => window.__onwardProjectEditorDebug
  const notebookApi = () => window.__onwardPromptNotebookDebug

  const pressEscape = () => {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
  }
  const clickBackdrop = (selector: string) => {
    const overlay = document.querySelector(selector)
    if (!overlay) return false
    overlay.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
    overlay.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    return true
  }
  // A would-be dismiss runs synchronously in the dispatched event; the wait
  // only lets React flush a state change before the "still open" check.
  const settleDelay = () => sleep(300)

  log('modal-dismiss:start')

  // ── ProjectEditor new-file prompt dialog ──
  const hasPeApi = await waitFor('mdm-pe-api', () => Boolean(
    peApi()?.openNewFileDialog && peApi()?.getDialogState && peApi()?.getDialogInput && peApi()?.setDialogInputValue
  ), 8000, 100)
  record('MDM-00-project-editor-debug-api-available', hasPeApi, {
    hasOpenNewFileDialog: Boolean(peApi()?.openNewFileDialog)
  })
  if (!hasPeApi || cancelled()) return results

  peApi()!.openNewFileDialog!()
  const dialogOpened = await waitFor('mdm-pe-dialog-open', () => {
    return peApi()?.getDialogState?.()?.type === 'prompt'
  }, 5000, 80)
  record('MDM-01-new-file-dialog-opens', dialogOpened, {
    dialog: peApi()?.getDialogState?.() ?? null
  })
  if (!dialogOpened || cancelled()) return results

  const typedName = 'modal-dismiss-half-typed-name'
  peApi()!.setDialogInputValue!(typedName)
  const inputApplied = await waitFor('mdm-pe-dialog-input', () => {
    return peApi()?.getDialogInput?.() === typedName
  }, 3000, 80)

  const peBackdropClicked = clickBackdrop('.project-editor-dialog-overlay')
  await settleDelay()
  const peDialogStillOpen = peApi()?.getDialogState?.()?.type === 'prompt'
  const peInputPreserved = peApi()?.getDialogInput?.() === typedName
  record('MDM-02-new-file-backdrop-click-keeps-dialog-and-input', Boolean(
    inputApplied && peBackdropClicked && peDialogStillOpen && peInputPreserved
  ), {
    inputApplied,
    backdropClicked: peBackdropClicked,
    dialogStillOpen: peDialogStillOpen,
    inputPreserved: peInputPreserved,
    input: peApi()?.getDialogInput?.() ?? null
  })
  if (cancelled()) return results

  pressEscape()
  const peDialogClosed = await waitFor('mdm-pe-dialog-esc-closed', () => {
    return peApi()?.getDialogState?.() === null
  }, 5000, 80)
  record('MDM-03-new-file-escape-cancels-dialog', peDialogClosed, {
    dialog: peApi()?.getDialogState?.() ?? null
  })
  if (cancelled()) return results

  // Setup for the remaining sections: close the Project Editor subpage so
  // its capture-phase escape cannot interfere cross-tab (non-assertion).
  pressEscape()
  await waitFor('mdm-pe-closed', () => peApi()?.isOpen() !== true, 5000, 100)
  log('modal-dismiss:project-editor-closed', { stillOpen: peApi()?.isOpen() ?? false })

  // ── TabBar close-tab confirm ──
  const tabCount = () => document.querySelectorAll('.tab-list .tab-item').length
  const initialTabCount = tabCount()
  const addBtn = document.querySelector<HTMLButtonElement>('.tab-add-btn')
  let tabCreated = false
  if (addBtn && !addBtn.disabled) {
    addBtn.click()
    tabCreated = await waitFor('mdm-tab-created', () => tabCount() === initialTabCount + 1, 5000, 100)
  }
  record('MDM-04-second-tab-created-for-confirm', tabCreated, {
    initialTabCount,
    tabCount: tabCount()
  })

  if (tabCreated && !cancelled()) {
    // Give the new tab's PTY a beat so tab 1 close prompts deterministically.
    await sleep(800)
    const firstTabClose = document.querySelector<HTMLButtonElement>('.tab-list .tab-item .tab-close-btn')
    firstTabClose?.click()
    const confirmShown = await waitFor('mdm-tab-confirm-open', () => {
      return document.querySelector('.confirm-dialog-overlay') !== null
    }, 5000, 80)
    record('MDM-05-close-tab-confirm-opens', confirmShown, {
      overlayPresent: document.querySelector('.confirm-dialog-overlay') !== null
    })

    if (confirmShown) {
      const backdropClicked = clickBackdrop('.confirm-dialog-overlay')
      await settleDelay()
      const confirmStillOpen = document.querySelector('.confirm-dialog-overlay') !== null
      record('MDM-06-close-tab-confirm-backdrop-click-keeps-dialog', backdropClicked && confirmStillOpen, {
        backdropClicked,
        confirmStillOpen
      })

      pressEscape()
      const confirmClosed = await waitFor('mdm-tab-confirm-esc-closed', () => {
        return document.querySelector('.confirm-dialog-overlay') === null
      }, 5000, 80)
      const tabsUnchanged = tabCount() === initialTabCount + 1
      record('MDM-07-close-tab-confirm-escape-cancels', confirmClosed && tabsUnchanged, {
        confirmClosed,
        tabCount: tabCount()
      })
    } else {
      record('MDM-06-close-tab-confirm-backdrop-click-keeps-dialog', false, { reason: 'confirm-not-shown' })
      record('MDM-07-close-tab-confirm-escape-cancels', false, { reason: 'confirm-not-shown' })
    }

    // Cleanup: remove the extra tab (confirm if the dialog appears).
    const tabs = document.querySelectorAll<HTMLElement>('.tab-list .tab-item')
    const lastTabClose = tabs[tabs.length - 1]?.querySelector<HTMLButtonElement>('.tab-close-btn')
    lastTabClose?.click()
    const confirmForCleanup = await waitFor('mdm-tab-cleanup-confirm', () => {
      return document.querySelector('.confirm-dialog-overlay') !== null || tabCount() === initialTabCount
    }, 3000, 80)
    if (confirmForCleanup && document.querySelector('.confirm-dialog-overlay')) {
      document.querySelector<HTMLButtonElement>('.confirm-dialog-overlay .confirm-dialog-btn.confirm')?.click()
    }
    const cleanupDone = await waitFor('mdm-tab-cleanup-done', () => tabCount() === initialTabCount, 5000, 100)
    record('MDM-08-extra-tab-cleaned-up', cleanupDone, { tabCount: tabCount() })
  } else {
    record('MDM-05-close-tab-confirm-opens', false, { reason: 'tab-not-created' })
    record('MDM-06-close-tab-confirm-backdrop-click-keeps-dialog', false, { reason: 'tab-not-created' })
    record('MDM-07-close-tab-confirm-escape-cancels', false, { reason: 'tab-not-created' })
    record('MDM-08-extra-tab-cleaned-up', false, { reason: 'tab-not-created' })
  }
  if (cancelled()) return results

  // ── ESC layering (open-modal registry): ChangeLog modal + tab-close
  //    confirm stacked — one ESC must cancel ONLY the topmost modal. ──
  const clApi = () => window.__onwardChangeLogDebug
  const changeLogButton = document.querySelector<HTMLButtonElement>('[data-testid="sidebar-change-log-button"]')
  let changeLogOpened = false
  if (changeLogButton) {
    changeLogButton.click()
    changeLogOpened = await waitFor('mdm-change-log-open', () => clApi()?.isOpen() === true, 5000, 80)
  }
  record('MDM-09-change-log-opens-for-layering', changeLogOpened, {
    buttonFound: changeLogButton !== null
  })

  if (changeLogOpened && !cancelled()) {
    const layerTabCount = tabCount()
    const layerAddBtn = document.querySelector<HTMLButtonElement>('.tab-add-btn')
    let layerTabCreated = false
    if (layerAddBtn && !layerAddBtn.disabled) {
      layerAddBtn.click()
      layerTabCreated = await waitFor('mdm-layer-tab-created', () => tabCount() === layerTabCount + 1, 5000, 100)
    }
    let confirmShownForLayering = false
    if (layerTabCreated) {
      document.querySelector<HTMLButtonElement>('.tab-list .tab-item .tab-close-btn')?.click()
      confirmShownForLayering = await waitFor('mdm-layer-confirm-open', () => {
        return document.querySelector('.confirm-dialog-overlay') !== null
      }, 5000, 80)
    }

    if (confirmShownForLayering) {
      pressEscape()
      const confirmGone = await waitFor('mdm-layer-confirm-esc-closed', () => {
        return document.querySelector('.confirm-dialog-overlay') === null
      }, 5000, 80)
      await settleDelay()
      const changeLogSurvived = clApi()?.isOpen() === true
      record('MDM-10-esc-cancels-confirm-keeps-change-log', confirmGone && changeLogSurvived, {
        confirmGone,
        changeLogSurvived
      })

      pressEscape()
      const changeLogClosed = await waitFor('mdm-change-log-esc-closed', () => clApi()?.isOpen() !== true, 5000, 80)
      record('MDM-11-second-esc-closes-change-log', changeLogClosed, {
        open: clApi()?.isOpen() ?? null
      })
    } else {
      record('MDM-10-esc-cancels-confirm-keeps-change-log', false, { reason: 'layer-confirm-not-shown', layerTabCreated })
      record('MDM-11-second-esc-closes-change-log', false, { reason: 'layer-confirm-not-shown' })
      if (clApi()?.isOpen()) clApi()?.clickCloseButton()
    }

    // Cleanup: drop the extra tab created for the layering scenario.
    if (layerTabCreated) {
      const tabs = document.querySelectorAll<HTMLElement>('.tab-list .tab-item')
      tabs[tabs.length - 1]?.querySelector<HTMLButtonElement>('.tab-close-btn')?.click()
      const confirmForCleanup = await waitFor('mdm-layer-cleanup-confirm', () => {
        return document.querySelector('.confirm-dialog-overlay') !== null || tabCount() === layerTabCount
      }, 3000, 80)
      if (confirmForCleanup && document.querySelector('.confirm-dialog-overlay')) {
        document.querySelector<HTMLButtonElement>('.confirm-dialog-overlay .confirm-dialog-btn.confirm')?.click()
      }
      const layerCleanupDone = await waitFor('mdm-layer-cleanup-done', () => tabCount() === layerTabCount, 5000, 100)
      record('MDM-12-layering-extra-tab-cleaned-up', layerCleanupDone, { tabCount: tabCount() })
    } else {
      record('MDM-12-layering-extra-tab-cleaned-up', true, { reason: 'no-extra-tab' })
    }
  } else {
    record('MDM-10-esc-cancels-confirm-keeps-change-log', false, { reason: 'change-log-not-opened' })
    record('MDM-11-second-esc-closes-change-log', false, { reason: 'change-log-not-opened' })
    record('MDM-12-layering-extra-tab-cleaned-up', false, { reason: 'change-log-not-opened' })
  }
  if (cancelled()) return results

  // ── PromptNotebook send-history panel ──
  // Requires the notebook visible: the App treats activePanel===null as
  // 'prompt' for this suite (promptNotebookAutotestSuites allowlist).
  const hasNotebookApi = await waitFor('mdm-notebook-api', () => Boolean(
    notebookApi()?.openSendHistory && notebookApi()?.isSendHistoryOpen
  ), 5000, 100)
  if (!hasNotebookApi) {
    record('MDM-13-send-history-opens', false, { reason: 'notebook-api-unavailable' })
    return results
  }

  const marker = `MDM send-history ${Math.floor(performance.now())}`
  notebookApi()!.setEditorContent(marker)
  // setEditorContent commits via state; submitEditor reads the ref that only
  // syncs on re-render — wait for the committed content before submitting.
  const editorReady = await waitFor('mdm-editor-content', () => {
    return notebookApi()!.getEditorContent() === marker
  }, 3000, 80)
  if (editorReady) {
    notebookApi()!.submitEditor()
  }
  const promptCreated = editorReady && await waitFor('mdm-prompt-created', () => {
    return notebookApi()!.getPrompts().some((prompt) => prompt.content === marker)
  }, 5000, 100)
  const promptId = notebookApi()!.getPrompts().find((prompt) => prompt.content === marker)?.id ?? null

  let historyOpened = false
  if (promptCreated && promptId) {
    notebookApi()!.openSendHistory!(promptId)
    historyOpened = await waitFor('mdm-send-history-open', () => notebookApi()!.isSendHistoryOpen!() === true, 5000, 80)
  }
  record('MDM-13-send-history-opens', historyOpened, { promptCreated, promptId })

  if (historyOpened && !cancelled()) {
    const backdropClicked = clickBackdrop('.prompt-send-history-overlay')
    await settleDelay()
    const stillOpen = notebookApi()!.isSendHistoryOpen!() === true
    record('MDM-14-send-history-backdrop-click-keeps-panel', backdropClicked && stillOpen, {
      backdropClicked,
      stillOpen
    })

    pressEscape()
    const closedByEscape = await waitFor('mdm-send-history-esc-closed', () => {
      return notebookApi()!.isSendHistoryOpen!() === false
    }, 5000, 80)
    record('MDM-15-send-history-escape-closes', closedByEscape, {
      open: notebookApi()!.isSendHistoryOpen!()
    })
  } else {
    record('MDM-14-send-history-backdrop-click-keeps-panel', false, { reason: 'send-history-not-opened' })
    record('MDM-15-send-history-escape-closes', false, { reason: 'send-history-not-opened' })
  }

  return results
}
