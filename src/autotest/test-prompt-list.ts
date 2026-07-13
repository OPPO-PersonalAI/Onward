/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

import type { AutotestContext, TestResult } from './types'

function parseTaskNumber(title: string): number | null {
  const match = title.match(/\bTask\s+(\d+)\b/i)
  if (!match) return null
  const value = Number.parseInt(match[1], 10)
  return Number.isFinite(value) && value > 0 ? value : null
}

export async function testPromptList(ctx: AutotestContext): Promise<TestResult[]> {
  const { assert, cancelled, log, sleep, waitFor } = ctx
  const results: TestResult[] = []
  const record = (name: string, ok: boolean, detail?: Record<string, unknown>) => {
    assert(name, ok, detail)
    results.push({ name, ok, detail })
  }

  log('phase1.05:start', { suite: 'PromptList' })

  const notebookApi = () => window.__onwardPromptNotebookDebug
  const senderApi = () => window.__onwardPromptSenderDebug

  const apisReady = await waitFor('prompt-list-apis', () => {
    return Boolean(notebookApi() && senderApi())
  }, 8000, 120)
  if (!apisReady) {
    record('PL-00-api-available', false, { reason: 'Prompt list debug API not mounted' })
    return results
  }

  const cards = senderApi()!.getTerminalCards()
  record('PL-01-terminal-cards-available', cards.length > 0, {
    count: cards.length,
    titles: cards.map(card => card.title)
  })
  if (cards.length === 0 || cancelled()) return results

  const colorState = notebookApi()!.getColorFilterState?.()
  const taskState = notebookApi()!.getTaskFilterState?.()
  record('PL-02-filter-state-readable', Boolean(colorState && taskState && notebookApi()!.isFilterEnabled), {
    colorState,
    taskState,
    filterEnabled: notebookApi()!.isFilterEnabled?.()
  })

  const filterStartsDisabled = notebookApi()!.isFilterEnabled?.() === false
  record('PL-03-filter-default-disabled', filterStartsDisabled, {
    filterEnabled: notebookApi()!.isFilterEnabled?.(),
    colorState,
    taskState
  })

  const targetsStartsDisabled = notebookApi()!.isTargetsEnabled?.() === false
  record('PL-04-targets-default-disabled', targetsStartsDisabled, {
    targetsEnabled: notebookApi()!.isTargetsEnabled?.()
  })

  const promptContent = `PL-${Date.now()} prompt history marker`
  const beforeIds = new Set(notebookApi()!.getPrompts().map(prompt => prompt.id))
  senderApi()!.deselectAllTerminals()
  await sleep(100)
  senderApi()!.selectTerminal(cards[0].id)
  await sleep(120)
  notebookApi()!.setEditorContent(promptContent)
  const editorReady = await waitFor('pl-editor-content', () => {
    return notebookApi()!.getEditorContent() === promptContent
  }, 3000, 80)
  const clickedSend = await senderApi()!.clickAction('send')
  const idleAfterSend = await waitFor('pl-send-idle', () => {
    return !senderApi()!.isSubmitting()
  }, 5000, 80)
  const newPromptReady = await waitFor('pl-new-prompt', () => {
    return notebookApi()!.getPrompts().some(prompt => !beforeIds.has(prompt.id) && prompt.taskNumbers.length > 0)
  }, 5000, 80)

  const createdPrompt = notebookApi()!.getPrompts().find(prompt => !beforeIds.has(prompt.id)) ?? null
  const expectedFirstTaskNumber = parseTaskNumber(cards[0].title)
  const hiddenTaskHistoryElement = createdPrompt
    ? document.querySelector(`[data-prompt-id="${createdPrompt.id}"] .prompt-item-task-history`)
    : null
  record('PL-05-send-history-task-badge-data', Boolean(
    editorReady &&
    clickedSend &&
    idleAfterSend &&
    newPromptReady &&
    createdPrompt &&
    createdPrompt.taskNumbers.length >= 1 &&
    hiddenTaskHistoryElement === null &&
    (expectedFirstTaskNumber === null || createdPrompt.taskNumbers.includes(expectedFirstTaskNumber))
  ), {
    editorReady,
    clickedSend,
    idleAfterSend,
    newPromptReady,
    createdPrompt,
    hiddenTaskHistoryVisible: hiddenTaskHistoryElement !== null,
    expectedFirstTaskNumber
  })

  if (!createdPrompt || cancelled()) {
    return results
  }

  const targetsOpened = notebookApi()!.setTargetsEnabled?.(true) ?? false
  await sleep(120)
  const visibleTaskHistoryElement = document.querySelector(`[data-prompt-id="${createdPrompt.id}"] .prompt-item-task-history`) as HTMLElement | null
  record('PL-06-targets-toggle-shows-history', Boolean(
    targetsOpened &&
    visibleTaskHistoryElement &&
    visibleTaskHistoryElement.dataset.taskHistory &&
    createdPrompt.taskNumbers.every((taskNum) => visibleTaskHistoryElement.dataset.taskHistory?.includes(String(taskNum)))
  ), {
    targetsOpened,
    targetsEnabled: notebookApi()!.isTargetsEnabled?.(),
    taskHistory: visibleTaskHistoryElement?.dataset.taskHistory ?? null,
    taskNumbers: createdPrompt.taskNumbers
  })

  const filterOpened = notebookApi()!.setFilterEnabled?.(true) ?? false
  await sleep(120)
  const painted = notebookApi()!.setPromptColor?.(createdPrompt.id, 'red') ?? false
  await sleep(120)
  const colorApplied = notebookApi()!.getPrompts().find(prompt => prompt.id === createdPrompt.id)?.color === 'red'
  const colorFilterEnabled = notebookApi()!.setColorFilter?.('red') ?? false
  await sleep(120)
  const colorVisibleIds = notebookApi()!.getVisiblePromptItems?.().map(prompt => prompt.id) ?? []
  record('PL-07-color-filter', filterOpened && painted && colorApplied && colorFilterEnabled && colorVisibleIds.includes(createdPrompt.id), {
    filterOpened,
    painted,
    colorApplied,
    colorVisibleIds,
    colorState: notebookApi()!.getColorFilterState?.()
  })

  const taskNumber = createdPrompt.taskNumbers[0] ?? null
  const taskFilterEnabled = taskNumber !== null && (notebookApi()!.setTaskFilter?.(taskNumber) ?? false)
  await sleep(120)
  const taskVisibleItems = notebookApi()!.getVisiblePromptItems?.() ?? []
  record('PL-08-task-filter', Boolean(
    taskNumber !== null &&
    taskFilterEnabled &&
    taskVisibleItems.some(prompt => prompt.id === createdPrompt.id && prompt.taskNumbers.includes(taskNumber))
  ), {
    taskNumber,
    taskFilterEnabled,
    taskVisibleItems,
    taskState: notebookApi()!.getTaskFilterState?.()
  })

  const copied = await (notebookApi()!.copyPrompt?.(createdPrompt.id) ?? Promise.resolve(false))
  const clipboardText = await (
    window.electronAPI?.clipboard?.readText?.() ??
    navigator.clipboard.readText()
  ).catch(() => null)
  record('PL-09-copy-prompt-content', copied && clipboardText === promptContent, {
    copied,
    clipboardText,
    promptContent
  })

  const filterDisabled = notebookApi()!.setFilterEnabled?.(false) ?? false
  await sleep(120)
  const filterResetState = {
    filterEnabled: notebookApi()!.isFilterEnabled?.(),
    colorState: notebookApi()!.getColorFilterState?.(),
    taskState: notebookApi()!.getTaskFilterState?.(),
    visiblePromptIds: notebookApi()!.getVisiblePromptItems?.().map(prompt => prompt.id) ?? []
  }
  record('PL-10-filter-disable-resets-state', Boolean(
    filterDisabled &&
    filterResetState.filterEnabled === false &&
    filterResetState.colorState?.activeColor === null &&
    filterResetState.taskState?.activeTaskNumber === null &&
    filterResetState.visiblePromptIds.includes(createdPrompt.id)
  ), filterResetState)

  if (!cancelled()) {
    const promptElement = document.querySelector(`[data-prompt-id="${createdPrompt.id}"]`) as HTMLElement | null
    promptElement?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true, view: window }))
    const saveAsNewLabelReady = await waitFor('pl-save-as-new-label', () => {
      const labels = Array.from(document.querySelectorAll(
        '.prompt-notebook:not(.prompt-notebook-hidden) .prompt-editor[data-prompt-editing="true"] .prompt-editor-btn'
      )).map((button) => button.textContent?.trim() ?? '')
      return (
        (labels.includes('Add') || labels.includes('\u6dfb\u52a0')) &&
        !labels.includes('Save as new item') &&
        !labels.includes('\u4fdd\u5b58\u4e3a\u65b0\u6761\u76ee')
      )
    }, 3000, 80)
    const editButtonLabels = Array.from(document.querySelectorAll(
      '.prompt-notebook:not(.prompt-notebook-hidden) .prompt-editor[data-prompt-editing="true"] .prompt-editor-btn'
    )).map((button) => button.textContent?.trim() ?? '')
    record('PL-11-save-as-new-button-label', Boolean(promptElement && saveAsNewLabelReady), {
      buttonLabels: editButtonLabels
    })
    const cancelButton = Array.from(document.querySelectorAll(
      '.prompt-notebook:not(.prompt-notebook-hidden) .prompt-editor[data-prompt-editing="true"] .prompt-editor-btn'
    )).find((button) => {
      const label = button.textContent?.trim()
      return label === 'Cancel' || label === '\u53d6\u6d88'
    }) as HTMLButtonElement | undefined
    cancelButton?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }))
    await sleep(120)

    const selectPrompt = notebookApi()!.selectPrompt
    if (cards.length > 1 && selectPrompt) {
      senderApi()!.deselectAllTerminals()
      await sleep(100)
      senderApi()!.selectTerminal(cards[1].id)
      await sleep(100)
      selectPrompt(createdPrompt.id)
      await sleep(120)
      const clickedSecondSend = await senderApi()!.clickAction('send')
      const secondIdle = await waitFor('pl-second-send-idle', () => {
        return !senderApi()!.isSubmitting()
      }, 5000, 80)
      const multiTaskReady = await waitFor('pl-multi-task-history', () => {
        const prompt = notebookApi()!.getPrompts().find(item => item.id === createdPrompt.id)
        return Boolean(prompt && prompt.taskNumbers.length >= 2)
      }, 5000, 80)
      const updatedPrompt = notebookApi()!.getPrompts().find(prompt => prompt.id === createdPrompt.id) ?? null
      record('PL-12-multi-task-history', Boolean(clickedSecondSend && secondIdle && multiTaskReady), {
        clickedSecondSend,
        secondIdle,
        multiTaskReady,
        updatedPrompt,
        secondTaskTitle: cards[1].title
      })
    } else {
      record('PL-12-multi-task-history', true, {
        reason: 'single terminal layout or prompt selection debug API unavailable'
      })
    }
  }

  // ---- PL-13/14/15: draft auto-preservation on history double-click ----
  // Contract (2026-07-13): double-clicking a history prompt while the editor
  // holds content must FIRST auto-save that content into history, THEN load
  // the double-clicked prompt — unless the editor still holds the untouched
  // original of the entry being edited (no duplicate spam), or is empty.
  if (!cancelled()) {
    const dispatchRowDoubleClick = (promptId: string): boolean => {
      const row = document.querySelector<HTMLElement>(
        `.prompt-list-item[data-prompt-id="${CSS.escape(promptId)}"]`
      )
      if (!row) return false
      row.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }))
      return true
    }
    const promptByContent = (content: string) =>
      notebookApi()!.getPrompts().find(prompt => prompt.content === content) ?? null

    // Seed a target history entry T to double-click on.
    const targetContent = `PL13-target ${Date.now()}`
    notebookApi()!.setEditorContent(targetContent)
    await waitFor('pl13-target-typed', () => notebookApi()!.getEditorContent() === targetContent, 4000, 80)
    notebookApi()!.submitEditor()
    const targetSeeded = await waitFor('pl13-target-seeded', () => Boolean(promptByContent(targetContent)), 4000, 80)
    const targetPrompt = promptByContent(targetContent)

    // PL-13: fresh draft in the editor → double-click T → draft saved as a
    // new entry AND T loaded into the editor, with the save toast visible.
    const draftContent = `PL13-draft ${Date.now()}`
    notebookApi()!.setEditorContent(draftContent)
    const draftTyped = await waitFor('pl13-draft-typed', () => notebookApi()!.getEditorContent() === draftContent, 4000, 80)
    const dblClicked = Boolean(targetSeeded && targetPrompt && dispatchRowDoubleClick(targetPrompt.id))
    const draftSaved = await waitFor('pl13-draft-saved', () => Boolean(promptByContent(draftContent)), 4000, 80)
    const targetLoaded = await waitFor('pl13-target-loaded', () => notebookApi()!.getEditorContent() === targetContent, 4000, 80)
    const toastSeen = await waitFor('pl13-toast', () => {
      const toast = document.querySelector<HTMLElement>('.prompt-editor-draft-toast')
      return Boolean(toast && toast.textContent && toast.textContent.length > 0)
    }, 2500, 80)
    record('PL-13-double-click-preserves-editor-draft', targetSeeded && draftTyped && dblClicked && draftSaved && targetLoaded && toastSeen, {
      targetSeeded, draftTyped, dblClicked, draftSaved, targetLoaded, toastSeen
    })

    // PL-14: editor now holds T untouched (loaded by PL-13's double-click).
    // Double-click the preserved draft entry D → NO new history entry.
    const draftPrompt = promptByContent(draftContent)
    const countBeforeUntouched = notebookApi()!.getPrompts().length
    const dblClickedDraft = Boolean(draftPrompt && dispatchRowDoubleClick(draftPrompt.id))
    const draftLoaded = await waitFor('pl14-draft-loaded', () => notebookApi()!.getEditorContent() === draftContent, 4000, 80)
    await sleep(300)
    const countAfterUntouched = notebookApi()!.getPrompts().length
    record('PL-14-untouched-source-not-duplicated', dblClickedDraft && draftLoaded && countAfterUntouched === countBeforeUntouched, {
      dblClickedDraft, draftLoaded, countBeforeUntouched, countAfterUntouched
    })

    // PL-15: empty editor → double-click T → no new entry, T loads.
    notebookApi()!.setEditorContent('')
    await waitFor('pl15-cleared', () => notebookApi()!.getEditorContent() === '', 4000, 80)
    const countBeforeEmpty = notebookApi()!.getPrompts().length
    const dblClickedEmpty = Boolean(targetPrompt && dispatchRowDoubleClick(targetPrompt!.id))
    const targetReloaded = await waitFor('pl15-target-loaded', () => notebookApi()!.getEditorContent() === targetContent, 4000, 80)
    await sleep(300)
    const countAfterEmpty = notebookApi()!.getPrompts().length
    record('PL-15-empty-editor-adds-nothing', dblClickedEmpty && targetReloaded && countAfterEmpty === countBeforeEmpty, {
      dblClickedEmpty, targetReloaded, countBeforeEmpty, countAfterEmpty
    })
  }

  notebookApi()!.setTargetsEnabled?.(false)
  notebookApi()!.setFilterEnabled?.(false)
  notebookApi()!.setColorFilter?.(null)
  notebookApi()!.setTaskFilter?.(null)
  notebookApi()!.setEditorContent('')
  await sleep(120)

  log('phase1.05:done', {
    total: results.length,
    passed: results.filter(result => result.ok).length,
    failed: results.filter(result => !result.ok).length
  })

  return results
}
