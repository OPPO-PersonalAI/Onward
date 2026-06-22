/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * End-to-end reproduction of the auto-update-restart "renames reverted" bug.
 *
 * Unlike `test-terminal-title-rename.ts` (single process, mock git-info via
 * setTerminalGitInfoOverride), this suite exercises the FULL real chain across
 * a genuine OS process restart:
 *
 *   Phase 1 (seed):   real terminal cwd in a real git repo → real manual rename
 *                     (stamps manualNameRepoRoot) → real AppStateStorage persist
 *                     to a dedicated ONWARD_USER_DATA_DIR → app exits.
 *   Phase 2 (verify): app relaunches against the SAME userData → real boot
 *                     hydration → real GitStateMirror resolves the repo/branch →
 *                     the boot-time auto-follow pass runs (the clobber window) →
 *                     assert the manual name AND its marker SURVIVED.
 *
 * This is the test that would have caught the production bug at the layer it
 * actually occurred: the main-process serializer dropping manualNameRepoRoot on
 * persist. If either the persistence round-trip (`persisted-terminal.ts`) OR the
 * boot auto-follow guard (`auto-follow-name.ts`) regresses, Phase 2 fails.
 *
 * The runner (`run-terminal-rename-restart-survival-autotest.sh`) provides the
 * git fixture as ONWARD_AUTOTEST_CWD and a throwaway ONWARD_USER_DATA_DIR.
 */

import type { AutotestContext, TerminalDebugApi, TestResult } from './types'

// The custom name the user "types". Deliberately NOT a git branch name, so a
// regression that reverts to the live branch is unambiguously detectable.
const KEPT_NAME = 'kept-across-restart'

function debugApi(): TerminalDebugApi | undefined {
  return window.__onwardTerminalDebug as TerminalDebugApi | undefined
}

async function awaitReadyApi(ctx: AutotestContext): Promise<TerminalDebugApi | null> {
  const { waitFor, terminalId } = ctx
  const ready = await waitFor('trs-debug-api', () => Boolean(debugApi()), 8000)
  if (!ready) return null
  const api = debugApi()!
  await waitFor(
    'trs-session-ready',
    () => Boolean(api.getSessionState(terminalId)?.status === 'ready'),
    12000,
    120
  )
  return api
}

/**
 * Wait until the GitStateMirror has resolved the terminal's repo root AND
 * branch from its real cwd. This is the precondition for both:
 *   - seed: the manual rename can only stamp a non-null marker once repoRoot
 *     is known;
 *   - verify: the auto-follow clobber can only fire once the branch resolves,
 *     so we MUST wait for it before asserting survival (otherwise the dangerous
 *     window has not happened yet and the test would falsely pass).
 */
async function waitForGitResolved(
  api: TerminalDebugApi,
  ctx: AutotestContext
): Promise<{ repoRoot: string | null; branch: string | null }> {
  await ctx.waitFor(
    'trs-git-resolved',
    () => {
      const info = api.getTerminalGitInfo(ctx.terminalId)
      return Boolean(info?.repoRoot) && Boolean(info?.branch)
    },
    15000,
    150
  )
  const info = api.getTerminalGitInfo(ctx.terminalId)
  return { repoRoot: info?.repoRoot ?? null, branch: info?.branch ?? null }
}

export async function testTerminalRenameRestartSurvivalSeed(ctx: AutotestContext): Promise<TestResult[]> {
  const { assert, cancelled, sleep, terminalId, waitFor } = ctx
  const results: TestResult[] = []
  const record = (name: string, ok: boolean, detail?: Record<string, unknown>) => {
    assert(name, ok, detail)
    results.push({ name, ok, detail })
  }

  const api = await awaitReadyApi(ctx)
  record('TRS-SEED-00-debug-api-ready', Boolean(api), { available: Boolean(api) })
  if (!api || cancelled()) return results

  // Auto-follow ON throughout — the real, default configuration the production
  // bug needed. We do NOT toggle it: toggling races the (one-cycle-lagging)
  // visibleTerminals ref. Instead, determinism comes from waiting for the
  // rename to fully propagate (see waitFor below), after which the marker is in
  // the ref and guard (a) keeps the name against every subsequent git sync.
  api.setAutoFollowGitBranchForTaskName(true)
  await sleep(60)

  // Resolve git first so the manual rename can stamp a non-null marker.
  const git = await waitForGitResolved(api, ctx)
  record('TRS-SEED-01-git-info-resolved', Boolean(git.repoRoot) && Boolean(git.branch), {
    repoRoot: git.repoRoot,
    branch: git.branch
  })
  if (!git.repoRoot || !git.branch || cancelled()) return results

  // Real manual rename via the menu → inline edit → commit. This stamps
  // manualNameRepoRoot = the resolved repoRoot through the production path.
  api.closeAllSubpages()
  api.closeTitleMenu()
  api.openTitleMenu(terminalId)
  await sleep(20)
  api.clickTitleMenuItem('rename', terminalId)
  // Deterministic gate: clickTitleMenuItem('rename') sets React state, and
  // editingIdRef (which finishInlineRename reads) only updates after the React
  // commit + effect runs. Under EDR that commit can take far longer than a fixed
  // sleep(20), so firing finishInlineRename blind hits its null-id guard and the
  // rename silently no-ops. Wait until inline-edit mode is actually live before
  // committing (mirrors sibling test-terminal-title-rename.ts).
  await waitFor(
    'trs-seed-edit-mode',
    () => api.getInlineRenameState().editingId === terminalId,
    4000,
    50
  )
  api.finishInlineRename(KEPT_NAME)

  // Deterministic gate: poll until the rename has propagated to the ref that
  // auto-follow reads. Once true, name AND marker are both visible there, so the
  // next git sync hits guard (a) and keeps the name (no fixed-sleep race).
  const renamed = await waitFor(
    'trs-seed-rename-applied',
    () => api.getTerminalCustomName(terminalId) === KEPT_NAME,
    4000,
    60
  )
  const markerAfter = api.getTerminalManualNameRepoRoot(terminalId)
  record(
    'TRS-SEED-02-manual-rename-stamps-marker',
    renamed && markerAfter != null && markerAfter === git.repoRoot,
    { renamed, nameAfter: api.getTerminalCustomName(terminalId), markerAfter, repoRoot: git.repoRoot, branch: git.branch }
  )

  // In-session stability: let a couple of git reconcile cycles pass (1 s focused
  // / 3 s visible) and confirm guard (a) is still protecting the manual name
  // against live git syncs. (Auto-follow OFF→ON intentionally re-syncs to the
  // branch — see TTM-27 — so that toggle is deliberately NOT exercised here.)
  await sleep(2000)
  const stillKept = api.getTerminalCustomName(terminalId) === KEPT_NAME
  record('TRS-SEED-03-name-stable-against-live-sync', stillKept, {
    nameNow: api.getTerminalCustomName(terminalId),
    marker: api.getTerminalManualNameRepoRoot(terminalId),
    branch: git.branch
  })

  // Let the debounced AppStateStorage save land before we exit. The exit path
  // (ONWARD_AUTOTEST_EXIT) also flushes, but waiting makes the seed independent
  // of that flush so a regression there cannot mask the persistence bug.
  await sleep(1200)
  record('TRS-SEED-04-persist-window-elapsed', true, {
    note: 'debounced app-state save window (>500ms) elapsed before exit'
  })

  return results
}

export async function testTerminalRenameRestartSurvivalVerify(ctx: AutotestContext): Promise<TestResult[]> {
  const { assert, cancelled, sleep, terminalId } = ctx
  const results: TestResult[] = []
  const record = (name: string, ok: boolean, detail?: Record<string, unknown>) => {
    assert(name, ok, detail)
    results.push({ name, ok, detail })
  }

  const api = await awaitReadyApi(ctx)
  record('TRS-VERIFY-00-debug-api-ready', Boolean(api), { available: Boolean(api) })
  if (!api || cancelled()) return results

  api.setAutoFollowGitBranchForTaskName(true)
  await sleep(60)

  // The marker must already be present immediately after hydration, BEFORE git
  // resolves — this is the direct probe for the serializer strip bug. If the
  // persist round-trip dropped manualNameRepoRoot, it is null here.
  const markerOnBoot = api.getTerminalManualNameRepoRoot(terminalId)
  const nameOnBoot = api.getTerminalCustomName(terminalId)
  record('TRS-VERIFY-01-marker-survived-persist', markerOnBoot != null, {
    nameOnBoot,
    markerOnBoot,
    note: 'manualNameRepoRoot must round-trip through AppStateStorage; null here = serializer strip regression'
  })

  // Now let the boot-time GitStateMirror resolve the repo/branch and let the
  // auto-follow pass fire — this is the exact window that clobbered the name in
  // production. We MUST wait through it before asserting survival.
  const git = await waitForGitResolved(api, ctx)
  record('TRS-VERIFY-02-git-info-resolved', Boolean(git.repoRoot) && Boolean(git.branch), {
    repoRoot: git.repoRoot,
    branch: git.branch
  })
  // Extra settle beyond git-resolution so any debounced auto-rename + re-save
  // has time to (incorrectly) land if the guard regressed.
  await sleep(1500)
  if (cancelled()) return results

  const nameFinal = api.getTerminalCustomName(terminalId)
  const markerFinal = api.getTerminalManualNameRepoRoot(terminalId)

  // THE survival assertion: the user's name is intact and was NOT reverted to
  // the live branch by the boot auto-follow pass.
  record(
    'TRS-VERIFY-03-custom-name-survived-restart',
    nameFinal === KEPT_NAME && nameFinal !== git.branch,
    { nameFinal, expected: KEPT_NAME, branch: git.branch }
  )

  // The marker still matches the repo (this is WHY guard (a) protected the name).
  record(
    'TRS-VERIFY-04-marker-still-matches-repo',
    markerFinal != null && markerFinal === git.repoRoot,
    { markerFinal, repoRoot: git.repoRoot }
  )

  return results
}
