/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

import type { AutotestContext, TerminalDebugApi, TestResult } from './types'

const MENU_SELECTOR = '[data-testid="terminal-title-menu"]'

function menuElement(): HTMLElement | null {
  return document.querySelector(MENU_SELECTOR) as HTMLElement | null
}

function menuItems(): HTMLButtonElement[] {
  const root = menuElement()
  if (!root) return []
  // Includes both `menuitem` and `menuitemcheckbox` buttons.
  return Array.from(
    root.querySelectorAll('button[role="menuitem"], button[role="menuitemcheckbox"]')
  ) as HTMLButtonElement[]
}

function itemByAction(
  action: 'rename' | 'auto-follow-toggle' | 'use-branch' | 'use-repo'
): HTMLButtonElement | null {
  const items = menuItems()
  return items.find((el) => el.getAttribute('data-action') === action) ?? null
}

export async function testTerminalTitleRename(ctx: AutotestContext): Promise<TestResult[]> {
  const { assert, cancelled, log, sleep, terminalId, waitFor } = ctx
  const results: TestResult[] = []
  const record = (name: string, ok: boolean, detail?: Record<string, unknown>) => {
    assert(name, ok, detail)
    results.push({ name, ok, detail })
  }

  const debugApi = () => window.__onwardTerminalDebug as TerminalDebugApi | undefined

  const apiReady = await waitFor('terminal-debug-api', () => Boolean(debugApi()), 8000)
  record('TTM-00-terminal-debug-api', apiReady, { available: apiReady })
  if (!apiReady || cancelled()) return results

  const api = debugApi()!
  const sessionReady = await waitFor(
    'terminal-session-ready',
    () => Boolean(api.getSessionState(terminalId)?.status === 'ready'),
    12000,
    120
  )
  record('TTM-00a-terminal-session-ready', sessionReady, {
    sessionState: api.getSessionState(terminalId)
  })
  if (!sessionReady || cancelled()) return results

  const resetState = async () => {
    // Autotest mode auto-opens the Project Editor on boot, which makes
    // globalOverlayActive=true and force-closes the title menu. Close all
    // subpages first so the terminal grid header (and our menu) are visible.
    api.closeAllSubpages()
    api.closeTitleMenu()
    api.cancelInlineRename()
    // Clear any override so subsequent tests see a deterministic starting point
    api.setTerminalGitInfoOverride(terminalId, null)
    // Give React a tick to flush
    await sleep(60)
  }

  // ================= TTM-01: single click opens menu immediately (no 220ms delay) =================
  // The previous 220ms click-vs-double-click disambiguation timer has been
  // removed: single click should open the dropdown synchronously so users
  // perceive zero latency. The historical "delay then open" assertion is
  // gone; instead we verify the menu is open within a single React flush.
  await resetState()
  api.simulateTitleSingleClick(terminalId)
  // Allow one render cycle for setTitleMenuTerminalId(...) to commit.
  await sleep(30)
  const afterOpen = api.getTitleMenuState(terminalId)
  record('TTM-01-immediate-menu-open', afterOpen?.open === true, {
    after: afterOpen
  })

  // ================= TTM-02: menu contains four items in the expected order =================
  // Order: Rename → Auto-follow checkbox → Use Branch → Use Repo.
  // The auto-follow item is sandwiched between separators in the DOM but
  // shares the same focusable role list, so we check the four data-action
  // values directly.
  const itemsNow = menuItems()
  const actions = itemsNow.map((el) => el.getAttribute('data-action'))
  record(
    'TTM-02-menu-items-order',
    itemsNow.length === 4 &&
      actions[0] === 'rename' &&
      actions[1] === 'auto-follow-toggle' &&
      actions[2] === 'use-branch' &&
      actions[3] === 'use-repo',
    { actions }
  )

  // ================= TTM-03: rename item triggers inline edit =================
  const renameBefore = api.getTerminalCustomName(terminalId)
  api.clickTitleMenuItem('rename', terminalId)
  await sleep(30)
  const editingAfterRename = api.getInlineRenameState()
  const titleMenuClosed = api.getTitleMenuState(terminalId)?.open === false
  record(
    'TTM-03-rename-opens-inline-edit',
    editingAfterRename.editingId === terminalId && titleMenuClosed,
    { editingAfterRename, titleMenuClosed, nameBefore: renameBefore }
  )
  api.cancelInlineRename()
  await sleep(20)

  // ================= TTM-04: Use branch name sets customName to branch snapshot =================
  await resetState()
  api.setTerminalGitInfoOverride(terminalId, { branch: 'ttm-branch-snapshot', repoName: 'ttm-repo-snapshot' })
  await sleep(30)
  api.openTitleMenu(terminalId)
  await sleep(20)
  const clickedBranch = api.clickTitleMenuItem('use-branch', terminalId)
  await sleep(40)
  const customAfterBranch = api.getTerminalCustomName(terminalId)
  const titleAfterBranch = api.getTerminalTitle(terminalId)
  record('TTM-04-use-branch-snapshot', clickedBranch === true && customAfterBranch === 'ttm-branch-snapshot', {
    clickedBranch,
    customAfterBranch,
    titleAfterBranch
  })

  // ================= TTM-05: Use Git folder name sets customName to repoName snapshot =================
  await resetState()
  api.setTerminalGitInfoOverride(terminalId, { branch: 'ttm-branch-x', repoName: 'ttm-repo-y' })
  await sleep(30)
  api.openTitleMenu(terminalId)
  await sleep(20)
  const clickedRepo = api.clickTitleMenuItem('use-repo', terminalId)
  await sleep(40)
  const customAfterRepo = api.getTerminalCustomName(terminalId)
  const titleAfterRepo = api.getTerminalTitle(terminalId)
  record('TTM-05-use-repo-snapshot', clickedRepo === true && customAfterRepo === 'ttm-repo-y', {
    clickedRepo,
    customAfterRepo,
    titleAfterRepo
  })

  // ================= TTM-06: both null disables items + tooltip text =================
  await resetState()
  api.setTerminalGitInfoOverride(terminalId, { branch: null, repoName: null })
  await sleep(30)
  api.openTitleMenu(terminalId)
  await sleep(30)
  const branchItem = itemByAction('use-branch')
  const repoItem = itemByAction('use-repo')
  const branchTip = branchItem?.getAttribute('title') ?? ''
  const repoTip = repoItem?.getAttribute('title') ?? ''
  const branchDisabled = Boolean(branchItem?.disabled)
  const repoDisabled = Boolean(repoItem?.disabled)
  record(
    'TTM-06-no-git-items-disabled',
    branchDisabled && repoDisabled && branchTip.length > 0 && repoTip.length > 0,
    { branchDisabled, repoDisabled, branchTip, repoTip }
  )

  // ================= TTM-07: branch present, repoName empty — only branch item enabled =================
  await resetState()
  api.setTerminalGitInfoOverride(terminalId, { branch: 'only-branch', repoName: null })
  await sleep(30)
  api.openTitleMenu(terminalId)
  await sleep(30)
  const branchItem2 = itemByAction('use-branch')
  const repoItem2 = itemByAction('use-repo')
  record(
    'TTM-07-partial-git-info',
    Boolean(branchItem2) && branchItem2?.disabled === false && Boolean(repoItem2) && repoItem2?.disabled === true,
    { branchDisabled: branchItem2?.disabled, repoDisabled: repoItem2?.disabled }
  )

  // ================= TTM-08: snapshot survives post-click branch mutation =================
  await resetState()
  api.setTerminalGitInfoOverride(terminalId, { branch: 'snapshot-original', repoName: 'snapshot-repo' })
  await sleep(30)
  api.openTitleMenu(terminalId)
  api.clickTitleMenuItem('use-branch', terminalId)
  await sleep(40)
  const customSnapshot1 = api.getTerminalCustomName(terminalId)
  api.setTerminalGitInfoOverride(terminalId, { branch: 'snapshot-changed' })
  await sleep(40)
  const customSnapshot2 = api.getTerminalCustomName(terminalId)
  record(
    'TTM-08-snapshot-is-frozen',
    customSnapshot1 === 'snapshot-original' && customSnapshot2 === 'snapshot-original',
    { customSnapshot1, customSnapshot2 }
  )

  // ================= TTM-09: long branch name does not crash =================
  await resetState()
  const longBranch = 'ttm-' + 'x'.repeat(140)
  api.setTerminalGitInfoOverride(terminalId, { branch: longBranch, repoName: 'repo-for-long' })
  await sleep(30)
  api.openTitleMenu(terminalId)
  const clickedLong = api.clickTitleMenuItem('use-branch', terminalId)
  await sleep(40)
  const customLong = api.getTerminalCustomName(terminalId)
  record(
    'TTM-09-long-branch-name',
    clickedLong === true && customLong === longBranch,
    { customLength: customLong?.length ?? 0, clickedLong }
  )

  // ================= TTM-10: disabled items cannot be triggered via debug API =================
  await resetState()
  api.setTerminalGitInfoOverride(terminalId, { branch: null, repoName: null })
  await sleep(30)
  api.openTitleMenu(terminalId)
  const forcedBranch = api.clickTitleMenuItem('use-branch', terminalId)
  const forcedRepo = api.clickTitleMenuItem('use-repo', terminalId)
  const customDisabled = api.getTerminalCustomName(terminalId)
  record(
    'TTM-10-disabled-items-no-op',
    forcedBranch === false && forcedRepo === false,
    { forcedBranch, forcedRepo, customDisabled }
  )

  // ================= TTM-11: real DOM double-click on title does NOT enter rename =================
  // After the rewrite, the only entry to inline rename via the title bar is
  // the dropdown's "Rename" item (or PromptSender's task-card double-click,
  // which lives in a different component). Dispatching a real `dblclick` on
  // the title element must NOT start an inline edit.
  await resetState()
  const titleAnchor = document.querySelector(
    `[data-terminal-id="${terminalId}"] .terminal-grid-title`
  ) as HTMLElement | null
  if (titleAnchor) {
    titleAnchor.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }))
    await sleep(30)
  }
  const editingAfterTitleDbl = api.getInlineRenameState()
  record(
    'TTM-11-title-double-click-does-not-rename',
    editingAfterTitleDbl.editingId === null,
    { editingAfterTitleDbl, hadAnchor: titleAnchor !== null }
  )
  api.closeTitleMenu()
  await sleep(20)

  // ================= TTM-12: a single real click opens the menu within one frame =================
  await resetState()
  const anchorForSingleClick = document.querySelector(
    `[data-terminal-id="${terminalId}"] .terminal-grid-title`
  ) as HTMLElement | null
  if (anchorForSingleClick) {
    anchorForSingleClick.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
  }
  const menuOpenedFast = await waitFor(
    'ttm12-menu-open-fast',
    () => api.getTitleMenuState(terminalId)?.open === true,
    400,
    20
  )
  const menuOpenFast = api.getTitleMenuState(terminalId)?.open
  const menuDomAtFast = menuElement() !== null
  record(
    'TTM-12-real-single-click-opens',
    menuOpenedFast === true && menuOpenFast === true,
    { menuOpenedFast, menuOpenFast, menuDomAtFast }
  )
  api.closeTitleMenu()
  await sleep(20)

  // ================= TTM-13: click different terminals — only last opens =================
  const visibleIds = api.getVisibleTerminalIds()
  if (visibleIds.length >= 2) {
    await resetState()
    const a = visibleIds[0]
    const b = visibleIds[1]
    api.simulateTitleSingleClick(a)
    await sleep(40)
    api.simulateTitleSingleClick(b)
    // Both single-clicks now open the menu synchronously. Allow one render
    // flush so b's state.open=true takes effect.
    await sleep(60)
    const stateA = api.getTitleMenuState(a)
    const stateB = api.getTitleMenuState(b)
    record(
      'TTM-13-only-last-terminal-menu-opens',
      stateA?.open === false && stateB?.open === true,
      { stateA, stateB }
    )
  } else {
    record('TTM-13-only-last-terminal-menu-opens', true, { skipped: 'need 2+ terminals', visibleIds })
  }

  // ================= TTM-14: simulateTitleDoubleClick debug alias still drives inline rename =================
  // The production UX no longer reacts to double-click on the title, but the
  // debug-API alias is preserved so existing test fixtures that reach inline
  // edit via this shortcut keep working without going through the menu.
  await resetState()
  api.simulateTitleDoubleClick(terminalId)
  await sleep(30)
  const editingAfterAlias = api.getInlineRenameState()
  record(
    'TTM-14-double-click-alias-enters-rename',
    editingAfterAlias.editingId === terminalId,
    { editingAfterAlias }
  )
  api.cancelInlineRename()

  // ================= TTM-15: left TerminalDropdown trigger still present =================
  await resetState()
  const leftTrigger = document.querySelector('.terminal-dropdown-trigger') as HTMLElement | null
  record(
    'TTM-15-left-dropdown-trigger-present',
    leftTrigger !== null && typeof leftTrigger.click === 'function',
    { leftTriggerTag: leftTrigger?.tagName ?? null }
  )

  // ================= TTM-16: inline rename finish & cancel via debug API =================
  await resetState()
  api.setTerminalGitInfoOverride(terminalId, { branch: 'ttm-inline-rename', repoName: 'repo-inline' })
  await sleep(30)
  api.simulateTitleDoubleClick(terminalId)
  await sleep(20)
  const finishOk = api.finishInlineRename('ttm-inline-typed')
  await sleep(30)
  const customAfterFinish = api.getTerminalCustomName(terminalId)
  const editingAfterFinish = api.getInlineRenameState()

  api.simulateTitleDoubleClick(terminalId)
  await sleep(20)
  const cancelOk = api.cancelInlineRename()
  await sleep(30)
  const customAfterCancel = api.getTerminalCustomName(terminalId)
  const editingAfterCancel = api.getInlineRenameState()
  record(
    'TTM-16-inline-rename-finish-and-cancel',
    finishOk === true &&
      customAfterFinish === 'ttm-inline-typed' &&
      editingAfterFinish.editingId === null &&
      cancelOk === true &&
      customAfterCancel === 'ttm-inline-typed' &&
      editingAfterCancel.editingId === null,
    { finishOk, customAfterFinish, cancelOk, customAfterCancel }
  )

  // ================= TTM-17: closeTitleMenu API closes the menu (forceClose analogue) =================
  await resetState()
  api.openTitleMenu(terminalId)
  await sleep(20)
  const openedForClose = api.getTitleMenuState(terminalId)?.open
  api.closeTitleMenu()
  await sleep(20)
  const closedAfterApi = api.getTitleMenuState(terminalId)?.open
  record(
    'TTM-17-close-menu-api',
    openedForClose === true && closedAfterApi === false,
    { openedForClose, closedAfterApi }
  )

  // ================= TTM-18: pressing Escape closes the menu =================
  await resetState()
  api.openTitleMenu(terminalId)
  await sleep(30)
  const openedForEsc = api.getTitleMenuState(terminalId)?.open
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
  await sleep(30)
  const closedAfterEsc = api.getTitleMenuState(terminalId)?.open
  record(
    'TTM-18-escape-closes-menu',
    openedForEsc === true && closedAfterEsc === false,
    { openedForEsc, closedAfterEsc }
  )

  // ================= TTM-19: outside mousedown closes the menu =================
  await resetState()
  api.openTitleMenu(terminalId)
  await sleep(30)
  const openedForOutside = api.getTitleMenuState(terminalId)?.open
  document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
  await sleep(30)
  const closedAfterOutside = api.getTitleMenuState(terminalId)?.open
  record(
    'TTM-19-outside-click-closes-menu',
    openedForOutside === true && closedAfterOutside === false,
    { openedForOutside, closedAfterOutside }
  )

  // ================= TTM-20: trace events emit on click / snapshot / rename =================
  // Drive every step via real DOM events so we exercise the production
  // handlers that own the trace points (the debug API methods bypass those
  // handlers by design — they are state shortcuts for other tests).
  await resetState()
  api.setTerminalGitInfoOverride(terminalId, { branch: 'ttm-trace-branch', repoName: 'ttm-trace-repo' })
  await sleep(50)

  const captured: Array<{ message: string; data: unknown }> = []
  const originalConsoleLog = console.log
  console.log = (...args: unknown[]) => {
    if (
      typeof args[0] === 'string' &&
      args[0] === '[TerminalGrid]' &&
      typeof args[1] === 'string' &&
      args[1].startsWith('titleMenu:')
    ) {
      captured.push({ message: args[1], data: args[2] })
    }
    return originalConsoleLog.apply(console, args)
  }

  const getAnchor = () =>
    document.querySelector(`[data-terminal-id="${terminalId}"] .terminal-grid-title`) as HTMLElement | null
  const getInput = () =>
    document.querySelector(`[data-terminal-id="${terminalId}"] .terminal-grid-title-input`) as HTMLInputElement | null
  const getMenuButton = (action: 'rename' | 'auto-follow-toggle' | 'use-branch' | 'use-repo') =>
    document.querySelector(`[data-testid="terminal-title-menu"] [data-action="${action}"]`) as HTMLButtonElement | null

  let traceError: string | null = null
  try {
    // 1) Real single-click on the title — exercises handleTitleClick → setTitleMenuTerminalId → titleMenu:open.
    const anchor1 = getAnchor()
    if (!anchor1) throw new Error('initial title anchor not found')
    anchor1.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    await sleep(40)

    // 2) Real click on the "Use branch name" menu item — exercises handleTitleSnapshotRename → titleMenu:snapshot.
    const branchBtn = getMenuButton('use-branch')
    if (!branchBtn) throw new Error('use-branch menu button not found')
    branchBtn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    await sleep(50)

    // 3) Open the menu and click "Rename" — exercises handleStartEdit → titleMenu:rename stage:start (source=menu).
    const anchor3 = getAnchor()
    if (!anchor3) throw new Error('title anchor missing before menu rename')
    anchor3.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    await sleep(40)
    const renameBtn = getMenuButton('rename')
    if (!renameBtn) throw new Error('rename menu button not found')
    renameBtn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    await sleep(40)

    // 4) Enter on the inline input — exercises handleKeyDown → handleFinishEdit → titleMenu:rename stage:commit.
    const input4 = getInput()
    if (!input4) throw new Error('inline input missing after menu rename')
    input4.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
    await sleep(50)

    // 5) Open the menu again and click "Rename" — exercises titleMenu:rename stage:start a second time.
    const anchor5 = getAnchor()
    if (!anchor5) throw new Error('title anchor missing before second menu rename')
    anchor5.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    await sleep(40)
    const renameBtn2 = getMenuButton('rename')
    if (!renameBtn2) throw new Error('rename menu button not found (second)')
    renameBtn2.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    await sleep(40)

    // 6) Escape on the inline input — exercises handleCancelEdit → titleMenu:rename stage:cancel.
    const input6 = getInput()
    if (!input6) throw new Error('inline input missing after second menu rename')
    input6.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
    await sleep(50)
  } catch (err) {
    traceError = err instanceof Error ? err.message : String(err)
  } finally {
    console.log = originalConsoleLog
  }

  const opens = captured.filter((c) => c.message === 'titleMenu:open')
  const snapshots = captured.filter((c) => c.message === 'titleMenu:snapshot')
  const renames = captured.filter((c) => c.message === 'titleMenu:rename')
  const stages = renames.map((c) => (c.data as { stage?: string } | undefined)?.stage ?? null)
  const openSourceClick = opens.some((c) => (c.data as { source?: string } | undefined)?.source === 'click')
  const snapshotSourceBranch = snapshots.some((c) => (c.data as { source?: string } | undefined)?.source === 'branch')
  const startFromMenu = renames.some((c) => {
    const d = c.data as { stage?: string; source?: string } | undefined
    return d?.stage === 'start' && d?.source === 'menu'
  })
  record(
    'TTM-20-trace-events-emit',
    traceError === null &&
      openSourceClick &&
      snapshotSourceBranch &&
      startFromMenu &&
      stages.includes('commit') &&
      stages.includes('cancel'),
    {
      traceError,
      messages: captured.map((c) => c.message),
      stagesObserved: stages,
      openCount: opens.length,
      snapshotCount: snapshots.length,
      renameCount: renames.length
    }
  )

  // ================= TTM-21: auto-follow defaults to ON and tracks branch =================
  // Default install ships with autoFollowGitBranchForTaskName=true. Pushing a
  // branch via the git-info override should drive customName to that branch
  // automatically, with no manualNameRepoRoot stamp (so subsequent branch
  // changes can keep updating it).
  await resetState()
  api.setAutoFollowGitBranchForTaskName(true)
  await sleep(40)
  api.setTerminalGitInfoOverride(terminalId, {
    repoRoot: '/repo/A',
    branch: 'feat/auto-1',
    repoName: 'A'
  })
  // Wait for React to flush the auto-follow rename + persistence debounce.
  const followedAuto1 = await waitFor(
    'ttm21-followed-branch',
    () => api.getTerminalCustomName(terminalId) === 'feat/auto-1',
    1500,
    40
  )
  const manualRepoRootAfterAuto1 = api.getTerminalManualNameRepoRoot(terminalId)
  record(
    'TTM-21-auto-follow-default-on',
    followedAuto1 === true &&
      api.getTerminalCustomName(terminalId) === 'feat/auto-1' &&
      manualRepoRootAfterAuto1 === null,
    {
      customName: api.getTerminalCustomName(terminalId),
      manualRepoRootAfterAuto1
    }
  )

  // ================= TTM-22: same-repo branch change keeps tracking =================
  api.setTerminalGitInfoOverride(terminalId, {
    repoRoot: '/repo/A',
    branch: 'feat/auto-2',
    repoName: 'A'
  })
  const followedAuto2 = await waitFor(
    'ttm22-followed-branch',
    () => api.getTerminalCustomName(terminalId) === 'feat/auto-2',
    1500,
    40
  )
  record(
    'TTM-22-same-repo-branch-update',
    followedAuto2 === true && api.getTerminalCustomName(terminalId) === 'feat/auto-2',
    { customName: api.getTerminalCustomName(terminalId) }
  )

  // ================= TTM-23: dropdown Rename pins manual override in the current repo =================
  await resetState()
  api.setAutoFollowGitBranchForTaskName(true)
  await sleep(40)
  api.setTerminalGitInfoOverride(terminalId, {
    repoRoot: '/repo/B',
    branch: 'main',
    repoName: 'B'
  })
  await waitFor('ttm23-pre-auto', () => api.getTerminalCustomName(terminalId) === 'main', 1500, 40)
  api.openTitleMenu(terminalId)
  await sleep(20)
  api.clickTitleMenuItem('rename', terminalId)
  await sleep(20)
  api.finishInlineRename('manual-locked')
  await sleep(80)
  const customAfterManual = api.getTerminalCustomName(terminalId)
  const manualRepoRootAfter = api.getTerminalManualNameRepoRoot(terminalId)
  // Drive a branch change in the same repo. The manual name must NOT be
  // overwritten because the recorded manualNameRepoRoot still matches.
  api.setTerminalGitInfoOverride(terminalId, {
    repoRoot: '/repo/B',
    branch: 'feature/x',
    repoName: 'B'
  })
  await sleep(180)
  const customAfterSameRepoBranch = api.getTerminalCustomName(terminalId)
  record(
    'TTM-23-manual-pinned-within-repo',
    customAfterManual === 'manual-locked' &&
      manualRepoRootAfter === '/repo/B' &&
      customAfterSameRepoBranch === 'manual-locked',
    { customAfterManual, manualRepoRootAfter, customAfterSameRepoBranch }
  )

  // ================= TTM-24: cross-repo cwd change clears the manual override =================
  api.setTerminalGitInfoOverride(terminalId, {
    repoRoot: '/repo/C',
    branch: 'develop',
    repoName: 'C'
  })
  const customAfterCrossRepo = await waitFor(
    'ttm24-cross-repo',
    () => api.getTerminalCustomName(terminalId) === 'develop',
    1500,
    40
  )
  const manualRepoRootAfterCross = api.getTerminalManualNameRepoRoot(terminalId)
  record(
    'TTM-24-cross-repo-clears-manual',
    customAfterCrossRepo === true &&
      api.getTerminalCustomName(terminalId) === 'develop' &&
      manualRepoRootAfterCross === null,
    { customName: api.getTerminalCustomName(terminalId), manualRepoRootAfterCross }
  )

  // ================= TTM-25: auto-follow OFF freezes the displayed name =================
  // Existing customName at this point is 'develop' (auto-set in TTM-24).
  // Turning auto-follow off should leave it untouched even when the branch
  // changes.
  api.setAutoFollowGitBranchForTaskName(false)
  await sleep(40)
  api.setTerminalGitInfoOverride(terminalId, {
    repoRoot: '/repo/C',
    branch: 'develop-renamed',
    repoName: 'C'
  })
  await sleep(180)
  const customAfterOff = api.getTerminalCustomName(terminalId)
  record(
    'TTM-25-off-freezes-name',
    customAfterOff === 'develop',
    { customAfterOff }
  )

  // ================= TTM-26: OFF→ON re-adopts the current branch =================
  api.setAutoFollowGitBranchForTaskName(true)
  const customAfterOn = await waitFor(
    'ttm26-toggled-on',
    () => api.getTerminalCustomName(terminalId) === 'develop-renamed',
    1500,
    40
  )
  record(
    'TTM-26-toggle-on-resyncs-branch',
    customAfterOn === true && api.getTerminalCustomName(terminalId) === 'develop-renamed',
    { customName: api.getTerminalCustomName(terminalId) }
  )

  // ================= TTM-27: OFF→ON also clears a stale manual override =================
  // First, with auto-follow ON, the customName tracks the branch. Pin a
  // manual override in this same repo, turn the toggle OFF (manual stays
  // because no IPC update touches it), then turn it back ON. Per the design
  // contract, OFF→ON must clear the manual flag and adopt the current branch.
  await resetState()
  api.setAutoFollowGitBranchForTaskName(true)
  await sleep(40)
  api.setTerminalGitInfoOverride(terminalId, {
    repoRoot: '/repo/D',
    branch: 'master',
    repoName: 'D'
  })
  await waitFor('ttm27-pre-auto', () => api.getTerminalCustomName(terminalId) === 'master', 1500, 40)
  api.openTitleMenu(terminalId)
  await sleep(20)
  api.clickTitleMenuItem('rename', terminalId)
  await sleep(20)
  api.finishInlineRename('manual-stale')
  await sleep(80)
  const beforeToggle = api.getTerminalCustomName(terminalId)
  const beforeToggleManual = api.getTerminalManualNameRepoRoot(terminalId)
  api.setAutoFollowGitBranchForTaskName(false)
  await sleep(40)
  api.setAutoFollowGitBranchForTaskName(true)
  const afterToggleOn = await waitFor(
    'ttm27-toggle-on-clears-manual',
    () => api.getTerminalCustomName(terminalId) === 'master',
    1500,
    40
  )
  const afterToggleManual = api.getTerminalManualNameRepoRoot(terminalId)
  record(
    'TTM-27-on-clears-manual-and-resyncs',
    beforeToggle === 'manual-stale' &&
      beforeToggleManual === '/repo/D' &&
      afterToggleOn === true &&
      api.getTerminalCustomName(terminalId) === 'master' &&
      afterToggleManual === null,
    {
      beforeToggle,
      beforeToggleManual,
      afterToggle: api.getTerminalCustomName(terminalId),
      afterToggleManual
    }
  )

  // ================= TTM-28: dropdown auto-follow checkbox persists +
  //                              click-toggles via real DOM =================
  // The checkbox is the user-facing entry point for the preference. Clicking
  // it must (a) flip the persisted value, (b) NOT close the menu (per the
  // design spec), and (c) update the visible aria-checked attribute.
  await resetState()
  api.setAutoFollowGitBranchForTaskName(true)
  await sleep(30)
  api.openTitleMenu(terminalId)
  await sleep(30)
  const toggleBtn = document.querySelector(
    `[data-testid="terminal-title-menu"] [data-action="auto-follow-toggle"]`
  ) as HTMLButtonElement | null
  const ariaCheckedBefore = toggleBtn?.getAttribute('aria-checked')
  toggleBtn?.click()
  await sleep(40)
  const persistedAfterClick = api.getAutoFollowGitBranchForTaskName()
  const menuStillOpen = api.getTitleMenuState(terminalId)?.open
  const toggleBtn2 = document.querySelector(
    `[data-testid="terminal-title-menu"] [data-action="auto-follow-toggle"]`
  ) as HTMLButtonElement | null
  const ariaCheckedAfter = toggleBtn2?.getAttribute('aria-checked')
  record(
    'TTM-28-checkbox-toggles-and-stays-open',
    ariaCheckedBefore === 'true' &&
      persistedAfterClick === false &&
      menuStillOpen === true &&
      ariaCheckedAfter === 'false',
    { ariaCheckedBefore, persistedAfterClick, menuStillOpen, ariaCheckedAfter }
  )
  // Restore default for downstream tests / other suites.
  api.setAutoFollowGitBranchForTaskName(true)
  await sleep(20)
  api.closeTitleMenu()
  api.setTerminalGitInfoOverride(terminalId, null)

  // ================= TTM-29..32: OSC 0/1/2 title + OSC 7 phantom cwd
  //                                injection must NOT mutate the visible
  //                                Onward-managed task label =================
  // Peer-product context: VS Code 1.117 allowAgentCliTitle, Alacritty's
  // dynamic_title=false, WezTerm's format-tab-title — the host owns the
  // task label; OSC sequences from inner programs (Claude CLI, shells with
  // misbehaving prompt integration, etc.) must not silently replace the
  // visible Onward path / branch / customName / auto-follow output.
  //
  // Reproduction strategy: inject raw OSC bytes via the new debug-API
  // `injectPtyData` hook (which calls `xterm.write` on the same code path
  // PTY output flows through) and assert task title + customName +
  // adaptive-cwd value are byte-identical before / after the injection.
  // Each variant runs N=TTM_OSC_TRIALS trials and the assertion FAILS
  // unless ALL trials preserve the label (boolean aggregate per the
  // CLAUDE.md "Timing-sensitive autotest authoring" rule for boolean
  // correctness).
  const TTM_OSC_TRIALS = 5
  const OSC_INJECTION_PROBE_TEXT = 'Claude is waiting for your input'

  const adaptiveCwdLabel = (id: string): string | null => {
    const cell = document.querySelector(`.terminal-grid-cell[data-terminal-id="${id}"]`)
    if (!cell) return null
    const cwdEl = cell.querySelector('.terminal-grid-adaptive-cwd') as HTMLElement | null
    return cwdEl?.getAttribute('title') ?? null
  }

  type OscVariant = {
    id: 'TTM-29' | 'TTM-30' | 'TTM-31' | 'TTM-32'
    label: string
    bytes: string
    /** When set, also assert the adaptive-cwd label stays unchanged. */
    checkCwd: boolean
  }

  // OSC 0/1/2 use BEL terminator (\x07) — the most common in the wild
  // (Claude CLI per issue #15082, bash's default `printf '\033]0;...\007'`).
  // OSC 7 uses ST terminator (`ESC \\`) per the original xterm spec; some
  // emitters use BEL — we cover both via separate variants below if needed,
  // but the renderer's OSC handler is dialect-agnostic so one form suffices.
  const oscVariants: OscVariant[] = [
    {
      id: 'TTM-29',
      label: 'osc0-window-and-icon-title',
      bytes: `\x1b]0;${OSC_INJECTION_PROBE_TEXT}\x07`,
      checkCwd: true
    },
    {
      id: 'TTM-30',
      label: 'osc1-icon-title',
      bytes: `\x1b]1;${OSC_INJECTION_PROBE_TEXT}\x07`,
      checkCwd: true
    },
    {
      id: 'TTM-31',
      label: 'osc2-window-title',
      bytes: `\x1b]2;${OSC_INJECTION_PROBE_TEXT}\x07`,
      checkCwd: true
    },
    {
      // Defensive coverage of the same bug class on the renderer's OSC-cwd
      // surface. A malformed inner program emitting `OSC 7 ; file:///<text>`
      // (or shell integration that puts status text in the cwd channel)
      // would otherwise poison the task header's adaptive-cwd label with
      // free text that starts with `/`. The renderer must not commit that
      // path to its speculative OSC-detected cwd map unless main validates
      // it.
      id: 'TTM-32',
      label: 'osc7-phantom-file-uri-path',
      bytes: `\x1b]7;file:///${OSC_INJECTION_PROBE_TEXT}\x1b\\`,
      checkCwd: true
    }
  ]

  for (const variant of oscVariants) {
    await resetState()
    // Pin a known customName so the assertion has an unambiguous reference
    // — without this, the default `Task N` label has no chance of being
    // visibly clobbered (the bug is about overwriting, not adopting). The
    // pinned name doubles as the regression sentinel: if a future change
    // ever pipes OSC bytes through onTerminalAutoRename / customName, the
    // sentinel would flip and the assertion would catch it.
    const sentinelCustomName = `ttm-sentinel-${variant.id.toLowerCase()}`
    api.setAutoFollowGitBranchForTaskName(false)
    await sleep(40)
    api.openTitleMenu(terminalId)
    await sleep(20)
    api.clickTitleMenuItem('rename', terminalId)
    await sleep(20)
    api.finishInlineRename(sentinelCustomName)
    await sleep(60)

    const baselineTitle = api.getTerminalTitle(terminalId)
    const baselineCustomName = api.getTerminalCustomName(terminalId)
    const baselineCwd = adaptiveCwdLabel(terminalId)
    const baselineManualRepoRoot = api.getTerminalManualNameRepoRoot(terminalId)

    // Separator-agnostic cwd comparison: after an OSC-7 phantom rejection the
    // displayed cwd falls back to the legacy poll cwd, which on Windows is
    // '\\'-separated vs the baseline '/'-separated (path-equivalent, byte-different).
    // The security assertion stays intact: a phantom free-text cwd (e.g.
    // '/Claude is waiting...') still differs from the baseline regardless of separator.
    const sameCwd = (a?: string | null, b?: string | null) =>
      (a ?? '').replace(/\\/g, '/') === (b ?? '').replace(/\\/g, '/')

    const trialEvidence: Array<{
      trial: number
      titleAfter: string | null
      customAfter: string | null
      cwdAfter: string | null
      manualRepoRootAfter: string | null
      injectOk: boolean
    }> = []
    let aggregateOk = true

    for (let trial = 0; trial < TTM_OSC_TRIALS; trial += 1) {
      const injectOk = api.injectPtyData(variant.bytes, terminalId)
      // Give xterm one paint frame to dispatch any internal OSC handler,
      // plus a React flush so any consequent state update can land.
      await sleep(80)

      const titleAfter = api.getTerminalTitle(terminalId)
      const customAfter = api.getTerminalCustomName(terminalId)
      const cwdAfter = adaptiveCwdLabel(terminalId)
      const manualRepoRootAfter = api.getTerminalManualNameRepoRoot(terminalId)

      const titleOk = titleAfter === baselineTitle
      const customOk = customAfter === baselineCustomName
      const cwdOk = !variant.checkCwd || sameCwd(cwdAfter, baselineCwd)
      const manualOk = manualRepoRootAfter === baselineManualRepoRoot
      const trialOk = injectOk && titleOk && customOk && cwdOk && manualOk
      if (!trialOk) aggregateOk = false

      trialEvidence.push({
        trial,
        titleAfter,
        customAfter,
        cwdAfter,
        manualRepoRootAfter,
        injectOk
      })
    }

    record(
      `${variant.id}-${variant.label}-ignored-by-task-label`,
      aggregateOk,
      {
        description: `Injecting ${variant.label} via PTY must not change the Onward-managed task label or customName across ${TTM_OSC_TRIALS} trials`,
        oscBytesPreview: variant.bytes
          .replace(/\x1b/g, 'ESC ')
          .replace(/\x07/g, ' BEL')
          .replace(/\x5c/g, ' \\\\'),
        probeText: OSC_INJECTION_PROBE_TEXT,
        baseline: {
          title: baselineTitle,
          customName: baselineCustomName,
          cwd: baselineCwd,
          manualRepoRoot: baselineManualRepoRoot
        },
        trials: trialEvidence
      }
    )

    api.setTerminalGitInfoOverride(terminalId, null)
  }

  // ================= TTM-33: boot hydration barrier protects a loaded name with a null marker =================
  // Renderer-layer reproduction of the auto-update-restart regression: a Task
  // whose customName is set but whose manualNameRepoRoot is null (e.g. a name
  // restored from disk before its repoRoot resolved) must NOT be clobbered by
  // the FIRST git-info sync after mount. Without the hydration barrier, auto-
  // follow branch (c) would overwrite the user's name with the live branch.
  await resetState()
  api.setAutoFollowGitBranchForTaskName(true)
  // Stamp a customName while repoRoot is unresolved → marker is null.
  api.setTerminalGitInfoOverride(terminalId, { repoRoot: null, branch: null })
  await sleep(40)
  api.openTitleMenu(terminalId)
  await sleep(20)
  api.clickTitleMenuItem('rename', terminalId)
  await sleep(20)
  api.finishInlineRename('ttm33-loaded-name')
  await sleep(80)
  const ttm33NameStamped = api.getTerminalCustomName(terminalId)
  const ttm33MarkerNull = api.getTerminalManualNameRepoRoot(terminalId)
  // Simulate a fresh boot for this Task: forget its first-pass flag, then push
  // the first git-info sync carrying a real repo + a different branch.
  api.resetAutoFollowInitialPass(terminalId)
  api.setTerminalGitInfoOverride(terminalId, { repoRoot: '/ttm/repo33', branch: 'ttm33-branch' })
  await sleep(80)
  const ttm33NameAfterBoot = api.getTerminalCustomName(terminalId)
  record(
    'TTM-33-hydration-barrier-protects-loaded-name',
    ttm33NameStamped === 'ttm33-loaded-name'
      && ttm33MarkerNull === null
      && ttm33NameAfterBoot === 'ttm33-loaded-name',
    { ttm33NameStamped, ttm33MarkerNull, ttm33NameAfterBoot }
  )

  // ================= TTM-34: barrier is one-shot — a later real branch switch IS honoured =================
  // After the initial post-mount pass, a genuine branch change still drives
  // auto-follow (no manual override in scope), so the barrier cannot freeze a
  // name forever.
  api.setTerminalGitInfoOverride(terminalId, { repoRoot: '/ttm/repo33', branch: 'ttm34-next' })
  const ttm34Followed = await waitFor(
    'ttm34-auto-after-barrier',
    () => api.getTerminalCustomName(terminalId) === 'ttm34-next',
    1500,
    40
  )
  record('TTM-34-auto-follow-resumes-after-barrier', ttm34Followed === true, {
    customName: api.getTerminalCustomName(terminalId)
  })
  api.setTerminalGitInfoOverride(terminalId, null)

  await resetState()
  log('terminal-title-rename:complete', { total: results.length })

  return results
}
