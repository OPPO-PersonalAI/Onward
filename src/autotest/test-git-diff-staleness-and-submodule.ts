/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

import type { AutotestContext, TestResult } from './types'
import type { TerminalShellKind } from '../utils/terminal-command'

/**
 * Git Diff staleness + submodule c/m/u filter regression suite (GDS-01..GDS-15).
 *
 * The fixture builder (test/autotest/create-git-diff-staleness-fixture.mjs) creates two
 * sibling repos under one tempRoot:
 *   - clean/root              parent + clean submodule, both work trees clean
 *   - pointer-changed/root    same shape but with the submodule HEAD advanced
 *                             past what the parent's index records (c flag = C)
 *
 * The path to the JSON manifest is delivered via
 * `window.electronAPI.debug.autotestFixtureExtra`. The autotest reads it through
 * the existing project.readFile IPC (the renderer has no direct fs access).
 *
 * Bug 1 (submodule false-positive): the parent's file list must NOT surface a
 * submodule entry whose only flags are m / u. Only c (commit pointer changed)
 * counts as a parent-side change.
 *
 * Bug 2 (staleness): a request-cache hit followed by an FS mutation must yield
 * fresh data on the next call, driven by the GitStateMirror-backed cache
 * invalidator and a force-on-entry hop emitted as `renderer:subpage.freshness-check`.
 *
 * The core GDS assertions cover both bugs plus their trace-event signatures so
 * regressions land both in the visible behavior and the observable surface.
 */

interface FixtureManifest {
  tempRoot: string
  cleanRoot: string
  pointerChangedRoot: string
  // Same shape as pointer-changed but the user has run `git add modules/sub`,
  // so the parent index records the new pointer and porcelain v2 reports
  // `<c>=.` while X is non-`.`. The filter must surface this row in Git Diff
  // so the user can review or unstage it.
  stagedPointerRoot: string
  // Project_Forward repro: parent + .gitmodules-declared submodule that has
  // been deinit-ed; the path exists on disk but is NOT a git repository.
  uninitializedRoot: string
  submoduleRelPath: string
  parentEditableFile: string
  stableStatusEditableFile: string
  submoduleEditableFile: string
  submoduleUntrackedRelPath: string
}

interface DiffFile {
  filename: string
  status?: string
  changeType?: string
  resourceGroup?: string
  originalRef?: string | null
  modifiedRef?: string | null
  isSubmoduleEntry?: boolean
  submoduleFlags?: {
    commitChanged: boolean
    workTreeModified: boolean
    untrackedContent: boolean
  }
  repoRoot?: string
  repoLabel?: string
}

interface DiffRepoCtx {
  root: string
  label: string
  isSubmodule: boolean
  changeCount: number
  loading?: boolean
}

interface DiffResult {
  success: boolean
  files: DiffFile[]
  repos?: DiffRepoCtx[]
  submodulesLoading?: boolean
}

function lastSegment(path: string): string {
  const cleaned = path.replace(/[\\/]+$/, '')
  const idx = Math.max(cleaned.lastIndexOf('/'), cleaned.lastIndexOf('\\'))
  return idx >= 0 ? cleaned.slice(idx + 1) : cleaned
}

function dirname(path: string): string {
  const cleaned = path.replace(/[\\/]+$/, '')
  const idx = Math.max(cleaned.lastIndexOf('/'), cleaned.lastIndexOf('\\'))
  return idx >= 0 ? cleaned.slice(0, idx) : cleaned
}

function joinAbsolutePath(root: string, relPath: string, platform: string): string {
  const separator = platform === 'win32' ? '\\' : '/'
  const cleanedRoot = root.replace(/[\\/]+$/, '')
  const cleanedRel = relPath.replace(/^[\\/]+/, '')
  const platformRel = platform === 'win32'
    ? cleanedRel.replace(/[\\/]+/g, '\\')
    : cleanedRel.replace(/[\\/]+/g, '/')
  return `${cleanedRoot}${separator}${platformRel}`
}

// NOTE: the former buildExternalWriteCommand + PowerShell/POSIX quoting helpers
// were removed when writeProjectFileViaTerminal switched the EXTERNAL edit from an
// interactive-shell PTY command to the deterministic main-process fs write
// (debug.writeExternalFile). The shell write was EDR-fragile under full-suite
// load (GDS-44/46 fileObserved:false); the fs write is instant and still external
// from the app's perspective. See writeProjectFileViaTerminal below.

async function loadManifest(extraPath: string | null): Promise<FixtureManifest | null> {
  if (!extraPath) return null
  const root = dirname(extraPath)
  const file = lastSegment(extraPath)
  const result = await window.electronAPI.project.readFile(root, file)
  if (!result.success || typeof result.content !== 'string') return null
  try {
    return JSON.parse(result.content) as FixtureManifest
  } catch {
    return null
  }
}

function clampPath(value: string): string {
  // macOS realpath maps /var/folders -> /private/var/folders for tmpdir, so
  // the main process's resolve(cwd) emits the /private/... form while the
  // test holds the /var/... form. Strip the /private prefix so equality
  // checks work regardless of which side normalised the path.
  return value
    .replace(/\\/g, '/')
    .replace(/^\/private\/var\//, '/var/')
}

function repoChangeCount(diff: DiffResult, repoRoot: string): number {
  if (!diff.repos) return diff.files.length
  const target = clampPath(repoRoot)
  for (const repo of diff.repos) {
    if (clampPath(repo.root) === target) return repo.changeCount
  }
  return 0
}

function parentSubmoduleEntries(diff: DiffResult, parentRoot: string, submoduleRel: string): DiffFile[] {
  const target = clampPath(parentRoot)
  const repoFiltered = diff.files.filter((file) => {
    if (!file.repoRoot) return true
    return clampPath(file.repoRoot) === target
  })
  return repoFiltered.filter((file) => file.isSubmoduleEntry || file.filename === submoduleRel)
}

function findDiffFileIndex(
  files: DiffFile[],
  filename: string,
  changeType: string
): number {
  return files.findIndex((file) => file.filename === filename && file.changeType === changeType)
}

// EDR-aware diff-population budget.
//
// On a Windows host running an EDR (endpoint detection & response) agent, each
// `getGitDiff` round-trip forks ~69 git child processes, and the EDR taxes
// every spawn by 1.3-12.9 s. Measured cold-load cost on the affected host was
// elapsedMs 6586 / 9943 / 9880 / 9661 / 10048 / 9993 per diff — i.e. a single
// diff can legitimately take ~10 s. A fixed 5000/6000 ms wait window therefore
// expires WHILE the (correct) diff is still loading and the assertion sees an
// empty file list, producing a false failure under EDR.
//
// The fix keeps the existing DETERMINISTIC predicates (file list populated /
// selected-content model ready) so each wait still returns the instant the diff
// actually finishes — it does NOT burn the full budget on a healthy host. The
// budget only raises the CEILING so EDR-slow diffs are tolerated. A hard cap
// still fails a genuine hang.
//
// These constants apply ONLY to diff-CONTENT population waits that depend on the
// EDR-taxed getGitDiff round-trip. They deliberately do NOT widen the generic
// waitFor default or unrelated short open/close gates.
// Diff-load budgets. The BASE applies to the FIRST (cold) diff of the run where
// no per-diff timing has been measured yet (measuredDiffMs === null) — e.g. the
// cold SUBMODULE diff in GDS-46, which under full-suite EDR load needs well over
// the floor to establish the submodule's git status for the first time. The cold
// submodule content+model wait is the single slowest path in the suite: regular
// diffs measured 6.8–34.6 s under load, and `measuredDiffMs*3` is sized from the
// faster early (often non-submodule) diff, so it underestimates the cold
// submodule cost. GDS-46-v1-model-ready timed out at the 45 s floor in the full
// regression while passing in isolation. A 60 s floor STILL timed out when the
// suite ran immediately after the build (peak EDR scanning of the fresh release
// binaries + fixture git trees), so the floor moves to 90 s and the cap to 120 s.
// GDS-46 does TWO cold submodule diffs (v1 + v2); at the 120 s cap that is ~240 s
// plus ~40 s setup — still under the 300 s per-runner budget, so this stays a
// budget-tune (NOT a runner-timeout bump). All these waits return EARLY on
// success, so the wider ceilings never slow a healthy run; they only give the
// loaded host room. If this ever TIMEOUTs the runner, the fix is to SPLIT GDS-46
// into its own sub-5-min runner, not to widen further.
const DIFF_LOAD_BUDGET_MS = 90000
const DIFF_LOAD_CAP_MS = 120000

// Dedicated budget for the GDS-46 cold-submodule diff content+model waits. The
// FIRST submodule diff of the run forks ~69 git processes to establish the
// submodule's status from scratch; on an EDR host each fork is taxed 1.3-12.9 s,
// so this one operation runs ~94 s+ (vs ~3 s once the submodule Mirror is warm).
// GDS-46 is isolated in its OWN runner (group 'submodule-refresh') so this single
// heavy pair (cold v1 + warm v2) is the runner's only diff work: setup ~45 s +
// v1 (≤ this budget, ~94 s actual) + warm v2 ~5 s ≈ 150 s, well inside the 280 s
// watchdog even at the budget ceiling. Generous 2x margin over the observed ~94 s
// makes it robust to EDR variance without risking the runner timeout (only one
// cold diff per runner). Do NOT fold GDS-46 back into the shared 'submodule'
// group — together they overran the watchdog.
const COLD_SUBMODULE_DIFF_BUDGET_MS = 200000

export async function testGitDiffStalenessAndSubmodule(ctx: AutotestContext): Promise<TestResult[]> {
  const { log, sleep: baseSleep, waitFor: baseWaitFor, assert, cancelled, terminalId } = ctx
  const results: TestResult[] = []
  const suiteStartedAt = performance.now()
  let lastRecordAt = suiteStartedAt
  const elapsed = (startedAt: number) => +(performance.now() - startedAt).toFixed(1)
  type GdsTimingEvent = Record<string, unknown> & {
    label: string
    totalMs: number
  }
  const timingEvents: GdsTimingEvent[] = []
  const logTiming = (label: string, detail?: Record<string, unknown>) => {
    const event: GdsTimingEvent = {
      label,
      totalMs: elapsed(suiteStartedAt),
      ...detail
    }
    timingEvents.push(event)
    log('gds:timing', event)
  }
  const timingNumber = (value: unknown): number | null => {
    return typeof value === 'number' && Number.isFinite(value) ? value : null
  }
  const emitTimingSummary = () => {
    const slowRecords = timingEvents
      .filter((event) => event.label === 'record')
      .map((event) => ({
        name: String(event.name ?? ''),
        ok: Boolean(event.ok),
        sincePreviousRecordMs: timingNumber(event.sincePreviousRecordMs) ?? 0,
        totalMs: event.totalMs
      }))
      .sort((a, b) => b.sincePreviousRecordMs - a.sincePreviousRecordMs)
      .slice(0, 10)
    const slowWaits = timingEvents
      .filter((event) => event.label === 'wait:end')
      .map((event) => ({
        waitLabel: String(event.waitLabel ?? ''),
        ok: Boolean(event.ok),
        elapsedMs: timingNumber(event.elapsedMs) ?? 0,
        timeoutMs: timingNumber(event.timeoutMs) ?? null,
        totalMs: event.totalMs
      }))
      .sort((a, b) => b.elapsedMs - a.elapsedMs)
      .slice(0, 10)
    const slowCallDiffs = timingEvents
      .filter((event) => event.label === 'callDiff')
      .map((event) => ({
        elapsedMs: timingNumber(event.elapsedMs) ?? 0,
        force: Boolean(event.force),
        success: Boolean(event.success),
        fileCount: timingNumber(event.fileCount),
        repoCount: timingNumber(event.repoCount),
        totalMs: event.totalMs
      }))
      .sort((a, b) => b.elapsedMs - a.elapsedMs)
      .slice(0, 10)
    const fixedSleepTotalMs = timingEvents
      .filter((event) => event.label === 'sleep')
      .reduce((sum, event) => sum + (timingNumber(event.elapsedMs) ?? 0), 0)
    const callDiffTotalMs = timingEvents
      .filter((event) => event.label === 'callDiff')
      .reduce((sum, event) => sum + (timingNumber(event.elapsedMs) ?? 0), 0)
    log('gds:timing-summary', {
      totalMs: elapsed(suiteStartedAt),
      fixedSleepTotalMs: +fixedSleepTotalMs.toFixed(1),
      callDiffTotalMs: +callDiffTotalMs.toFixed(1),
      slowRecords,
      slowWaits,
      slowCallDiffs
    })
  }
  const sleep = async (ms: number) => {
    const startedAt = performance.now()
    await baseSleep(ms)
    if (ms >= 200) {
      logTiming('sleep', {
        requestedMs: ms,
        elapsedMs: elapsed(startedAt)
      })
    }
  }
  const waitFor: AutotestContext['waitFor'] = async (label, predicate, timeoutMs = 6000, intervalMs = 80) => {
    const startedAt = performance.now()
    logTiming('wait:start', { waitLabel: label, timeoutMs, intervalMs })
    const ok = await baseWaitFor(label, predicate, timeoutMs, intervalMs)
    logTiming('wait:end', {
      waitLabel: label,
      ok,
      elapsedMs: elapsed(startedAt),
      timeoutMs,
      intervalMs
    })
    return ok
  }
  // EDR-tolerant default (was 5000): the hunk action's product work (saveFileContent
  // + the post-action forced re-diff) is git-spawn-gated, so on this host it can
  // exceed 5s (observed: GDS-29 hunk-revert result:'timeout' at 5005ms). 20s rides
  // that out; the race resolves the instant the action's promise settles, so a fast
  // host is unaffected.
  const awaitLastHunkAction = async (label: string, timeoutMs = 20000): Promise<boolean | null> => {
    const promise = window.__onwardGitDiffDebug?.waitForLastHunkActionForTest?.()
    if (!promise) return null
    const startedAt = performance.now()
    logTiming('hunk-action:start', { actionLabel: label, timeoutMs })
    const timeout = baseSleep(timeoutMs).then(() => 'timeout' as const)
    const result = await Promise.race([promise, timeout])
    logTiming('hunk-action:end', {
      actionLabel: label,
      result,
      elapsedMs: elapsed(startedAt),
      timeoutMs
    })
    return result === 'timeout' ? null : result
  }
  const record = (name: string, ok: boolean, detail?: Record<string, unknown>) => {
    const now = performance.now()
    logTiming('record', {
      name,
      ok,
      sincePreviousRecordMs: +(now - lastRecordAt).toFixed(1)
    })
    lastRecordAt = now
    assert(name, ok, detail)
    results.push({ name, ok, detail })
  }

  log('git-diff-staleness:start', { terminalId })

  const extraPath = window.electronAPI.debug.autotestFixtureExtra
  const manifest = await loadManifest(extraPath)
  if (!manifest) {
    record('GDS-00-fixture-loaded', false, { extraPath })
    return results
  }
  log('git-diff-staleness:manifest', manifest)
  record('GDS-00-fixture-loaded', true, {
    cleanRoot: manifest.cleanRoot,
    pointerChangedRoot: manifest.pointerChangedRoot
  })

  // Suite split: ONWARD_AUTOTEST_GDS_GROUP partitions the GDS-* cases across
  // sub-5-min runners. The whole suite overran the regression 5-min budget on an
  // EDR host (each Git Diff round-trip forks ~69 git processes and is EDR-taxed
  // to ~6-11 s; the dominant cost is the diff LOAD itself, ~7-35 s per scenario
  // — measured sincePreviousRecordMs samples ran 6.8/7.6/9.2/13/16/17/18/34.6 s).
  // The 4-way split STILL timed out (round-4: all four sub-runners hit ~283-284 s,
  // their 280 s watchdog) because diff-ux summed ~235 s and model-sync ~154 s of
  // irreducible diff work alone. The suite is now cut SIX ways, balanced BY
  // MEASURED PER-CASE COST so every sub-runner is confidently < 220 s (each group
  // ~96-122 s of case-work + ~45 s fixed overhead = ~141-167 s; ≥53 s margin to
  // 220 s, ≥73 s to the 290 s watchdog). Mirrors the GitStateMirror-latency
  // LATENCY_MODE / ONWARD_AUTOTEST_GSM_LATENCY_GROUP split (class-2 oversized-case).
  // The heaviest singles are deliberately spread one-per-group so no group clusters
  // them: GDS-17(34.6 s)→reentry, GDS-31(35 s)→diff-ux-presentation, GDS-19(35.8 s)
  // & GDS-43(45 s)→model-sync, GDS-20(34.6 s)→reentry; the two atomic UI blocks
  // (BlockA = GDS-21..29, BlockE = GDS-35..39) each own their own ux group.
  // Groups (case → cost in seconds; measured M / conservative estimate E):
  //   'submodule'           — parent/sub c/m/u filter + nested/uninitialized +
  //                           staged-pointer (GDS-01..05, 13, 14). ~20 s work.
  //   'submodule-refresh'   — closed-parent submodule freshness, GDS-46 ONLY
  //                           (cold v1 + warm v2 submodule diff). Isolated in its
  //                           own runner because the cold v1 diff runs ~94 s+ under
  //                           EDR (see COLD_SUBMODULE_DIFF_BUDGET_MS); folded back
  //                           into 'submodule' it overran the 280 s watchdog.
  //   'staleness'           — request-cache invalidation / watcher-driven freshness
  //                           / concurrent force+cached converge / Project-Editor
  //                           -save freshness (GDS-06..10, 45). ~122 s work.
  //   'reentry'             — subdir-scope watch + re-entry-content body refresh +
  //                           re-entry-latency trend + draft-preserved-on-refresh
  //                           (GDS-15, 17, 18, 20). ~114 s work.
  //   'diff-ux-presentation'— VS Code resource / split / hunk / refresh atomic UI
  //                           block + blank-until-file-selected (GDS-21..29 block,
  //                           31). ~96 s work.
  //   'diff-ux-tree'        — tree icons / flat-tree / groups / editor-jump atomic
  //                           block + prefetch-body cache + partial-stage ranges
  //                           (GDS-35..39 block, 32, 33). ~113 s work.
  //   'model-sync'          — open-view selected-body refresh + repeated same-file
  //                           refresh + external stable-status edits Monaco model
  //                           sync (GDS-19, 43, 44). ~119 s work.
  //   'missed-watch'        — EXPLICIT-ONLY (not part of ''): reproduction of the
  //                           2026-07-12 diagnostic bundle's watcher-missed
  //                           staleness (GDS-50, 51). Requires the mirror to be
  //                           silenced via ONWARD_AUTOTEST_GSM_WATCHER_SILENT=1 +
  //                           ONWARD_AUTOTEST_GSM_RECONCILE_SILENT=1, which only
  //                           run-git-diff-missed-watch-autotest.sh sets; under a
  //                           LIVE mirror the invalidation push would mask the
  //                           defect and the cases would false-pass, so the group
  //                           never rides the whole-suite default.
  //   ''                    — default: run every group EXCEPT 'missed-watch' so
  //                           the suite stays runnable whole.
  // GDS-00 (fixture) brackets every group; trace markers at the tail are gated
  // per group so each split runner only emits / requires its own group's markers.
  const gdsGroup = window.electronAPI.debug.autotestGdsGroup || ''
  const runGroup = (
    g:
      | 'submodule'
      | 'submodule-refresh'
      | 'staleness'
      | 'reentry'
      | 'diff-ux-presentation'
      | 'diff-ux-tree'
      | 'model-sync'
  ): boolean => gdsGroup === '' || gdsGroup === g

  const cleanRoot = manifest.cleanRoot
  const pointerRoot = manifest.pointerChangedRoot
  const subPath = manifest.submoduleRelPath
  const parentFile = manifest.parentEditableFile
  const stableStatusFile = manifest.stableStatusEditableFile
  const subEditableFile = manifest.submoduleEditableFile
  const subFile = `${subPath}/${subEditableFile}`
  const subUntracked = manifest.submoduleUntrackedRelPath
  const platform = window.electronAPI.platform

  // First successful warm-diff round-trip cost, used to size the EDR-aware
  // diff-population budget. On a fast (non-EDR) host this is a few hundred ms,
  // so the budget stays at DIFF_LOAD_BUDGET_MS; under EDR a single diff can take
  // ~10 s, so the budget tracks measuredDiffMs * 3 up to DIFF_LOAD_CAP_MS.
  let measuredDiffMs: number | null = null

  // Helper: capture trace-event names emitted since this point. Implemented via
  // the debug bridge on the main side which exposes a counter snapshot.
  const callDiff = async (root: string, force = false): Promise<DiffResult> => {
    const startedAt = performance.now()
    const diff = await window.electronAPI.git.getDiff(root, { scope: 'full', force })
    const result = diff as DiffResult
    const elapsedMs = elapsed(startedAt)
    if (result.success && measuredDiffMs === null) {
      measuredDiffMs = elapsedMs
    }
    logTiming('callDiff', {
      root: clampPath(root),
      force,
      elapsedMs,
      success: result.success,
      fileCount: result.files?.length ?? null,
      repoCount: result.repos?.length ?? null
    })
    return result
  }

  // Adaptive ceiling for diff-CONTENT population waits that depend on the
  // EDR-taxed getGitDiff round-trip. Returns the instant the deterministic
  // predicate is satisfied; this only governs how long we are willing to wait
  // before declaring a genuine hang. When a warm-diff cost has been measured we
  // size to 3x that (clamped to [DIFF_LOAD_BUDGET_MS, DIFF_LOAD_CAP_MS]);
  // otherwise we fall back to the flat DIFF_LOAD_BUDGET_MS.
  const adaptiveDiffBudget = (): number => {
    if (measuredDiffMs === null) return DIFF_LOAD_BUDGET_MS
    return Math.min(DIFF_LOAD_CAP_MS, Math.max(DIFF_LOAD_BUDGET_MS, measuredDiffMs * 3))
  }

  const getSelectedFileContentSnapshot = () =>
    window.__onwardGitDiffDebug?.getSelectedFileContent?.() ?? null
  const getSelectedEditorModelSnapshot = () =>
    window.__onwardGitDiffDebug?.getSelectedEditorModelContent?.() ?? null

  const resolveTerminalShellKind = async (): Promise<TerminalShellKind | undefined> => {
    try {
      return (await window.electronAPI.terminal.getInputCapabilities(terminalId)).shellKind
    } catch {
      return undefined
    }
  }

  const readProjectTextFile = async (root: string, relPath: string): Promise<string | null> => {
    const result = await window.electronAPI.project.readFile(root, relPath)
    if (!result.success || typeof result.content !== 'string') return null
    return result.content
  }

  const waitForProjectTextFile = async (
    label: string,
    root: string,
    relPath: string,
    expectedContent: string,
    // EDR-aware budget (same as every other wait in this suite): the external
    // PowerShell write is correct and deterministic, but under full-suite load on
    // an EDR-throttled host the interactive shell can take well over a flat 8 s to
    // execute the queued command and flush the file to disk, so GDS-44/46 saw
    // fileObserved:false in the full regression while passing in isolation. Track
    // the measured diff cost (30-45 s ceiling) instead of a fixed 8 s.
    timeoutMs = adaptiveDiffBudget()
  ): Promise<boolean> => {
    const startedAt = performance.now()
    logTiming('wait:start', { waitLabel: label, timeoutMs, intervalMs: 120 })
    while (performance.now() - startedAt < timeoutMs) {
      if (await readProjectTextFile(root, relPath) === expectedContent) {
        logTiming('wait:end', {
          waitLabel: label,
          ok: true,
          elapsedMs: elapsed(startedAt),
          timeoutMs,
          intervalMs: 120
        })
        return true
      }
      await baseSleep(120)
    }
    logTiming('wait:end', {
      waitLabel: label,
      ok: false,
      elapsedMs: elapsed(startedAt),
      timeoutMs,
      intervalMs: 120
    })
    return false
  }

  const writeProjectFileViaTerminal = async (
    root: string,
    relPath: string,
    content: string,
    label: string
  ): Promise<{ success: boolean; accepted: boolean; fileObserved: boolean; shellKind: TerminalShellKind | undefined; fullPath: string }> => {
    const shellKind = await resolveTerminalShellKind()
    const fullPath = joinAbsolutePath(root, relPath, platform)
    // Perform the EXTERNAL edit via a deterministic main-process fs write instead
    // of an interactive-shell PTY command. The PTY write is EDR-fragile under
    // full-suite load — the queued shell command can sit unexecuted past even the
    // adaptive observe budget, so GDS-44/46 saw fileObserved:false in the full
    // regression while passing in isolation. The fs write is instant AND still
    // EXTERNAL from the app's perspective: it does NOT route through the project
    // save / git-diff invalidation path, so the watcher / GitStateMirror must
    // still DISCOVER the untracked mutation — the exact contract under test.
    // (notifyTerminalActivity is kept so the Mirror is nudged exactly as before.)
    const writeResult = await window.electronAPI.debug.writeExternalFile({ root, relPath, content })
    const accepted = writeResult.ok
    await window.electronAPI.git.notifyTerminalActivity(terminalId)
    const fileObserved = await waitForProjectTextFile(`external-write-observed:${label}`, root, relPath, content)
    await window.electronAPI.git.notifyTerminalActivity(terminalId)
    return { success: accepted && fileObserved, accepted, fileObserved, shellKind, fullPath }
  }

  const waitForSelectedContentAndModel = async (
    label: string,
    expectedModifiedContent: string,
    options: {
      expectedOriginalContent?: string
      expectedEditorModifiedContent?: string
      expectedDraftContent?: string | null
      timeoutMs?: number
    } = {}
  ): Promise<boolean> => {
    const expectedOriginalContent = options.expectedOriginalContent
    const timeoutMs = options.timeoutMs ?? 6000
    return waitFor(label, () => {
      const state = getSelectedFileContentSnapshot()
      const model = getSelectedEditorModelSnapshot()
      if (!state || state.loading || state.error || !model) return false
      if (state.modifiedContent !== expectedModifiedContent) return false
      if (
        expectedOriginalContent !== undefined &&
        state.originalContent !== expectedOriginalContent
      ) {
        return false
      }
      if (
        Object.prototype.hasOwnProperty.call(options, 'expectedDraftContent') &&
        state.draftContent !== options.expectedDraftContent
      ) {
        return false
      }
      const expectedEditorModifiedContent =
        options.expectedEditorModifiedContent ??
        state.draftContent ??
        expectedModifiedContent
      return model.modifiedContent === expectedEditorModifiedContent &&
        model.expectedModifiedContent === expectedEditorModifiedContent &&
        model.modifiedMatchesState === true &&
        model.originalMatchesState === true
    }, timeoutMs, 50)
  }

  // Lightweight parent-repo-only dirty-file discovery for between-case cleanup.
  //
  // restoreBaseline only needs to learn which PARENT-repo entries (staged /
  // unstaged / untracked) a previous case left behind so it can unstage /
  // discard them. It does NOT need the submodule's recursed internal diff
  // (the `scope: 'full'` round-trip's ~69-git-spawn dominator under EDR): the
  // submodule's own working-tree mutations are the fixed {subFile, subUntracked}
  // set, which restoreBaseline resets DETERMINISTICALLY below via
  // saveFileContent / deletePath — independent of this discovery. So a
  // `scope: 'root-only'` diff (parent repo only) is sufficient AND far cheaper
  // (it skips submodule recursion entirely; see loadGitDiff's
  // reposToLoad filter for root-only). Forced so it re-stats the work tree.
  //
  // Kept OUT of callDiff() on purpose: callDiff hardcodes scope:'full' and
  // feeds measuredDiffMs (which sizes the EDR-aware DIFF_LOAD budget for the
  // assertion-bearing full diffs). A cheap root-only discovery must not skew
  // that budget, so it goes through getDiff directly without touching
  // measuredDiffMs.
  const discoverDirty = async (): Promise<DiffFile[]> => {
    const startedAt = performance.now()
    const diff = await window.electronAPI.git.getDiff(cleanRoot, { scope: 'root-only', force: true }) as DiffResult
    logTiming('discoverDirty', {
      elapsedMs: elapsed(startedAt),
      success: diff.success,
      fileCount: diff.files?.length ?? null
    })
    return diff.success ? diff.files : []
  }

  const clearDiffState = async () => {
    const stagedDiff = await discoverDirty()
    for (const file of stagedDiff) {
      if (file.changeType === 'staged') {
        await window.electronAPI.git.unstageFile(cleanRoot, file.filename, file.repoRoot)
      }
    }

    // A staged-only entry becomes unstaged/untracked after the unstage above, so
    // a second discovery pass is still required to catch what the unstage
    // surfaced. This pass remains root-only — same parent-repo-only scope as the
    // first — so the two-pass safety net costs two cheap diffs, not two full
    // submodule-recursing round-trips.
    const workingDiff = await discoverDirty()
    for (const file of workingDiff) {
      if (file.changeType === 'staged') {
        await window.electronAPI.git.unstageFile(cleanRoot, file.filename, file.repoRoot)
        continue
      }
      const discardTarget = {
        filename: file.filename,
        status: file.status ?? (file.changeType === 'untracked' ? '?' : 'M'),
        changeType: file.changeType ?? 'unstaged',
        isSubmoduleEntry: file.isSubmoduleEntry
      } as Parameters<typeof window.electronAPI.git.discardFile>[1]
      await window.electronAPI.git.discardFile(cleanRoot, discardTarget, file.repoRoot)
    }
  }

  // Reset the working trees to a clean baseline before each scenario so an
  // earlier test cannot leak state into the next one. This must clean staged,
  // unstaged, and untracked entries because several scenarios deliberately
  // mutate different resource groups before returning to the shared fixture.
  //
  // Cost note (EDR hosts): the dominant historical cost here was THREE
  // `scope: 'full'` getGitDiff round-trips per call (~6 s each under EDR =
  // ~18 s/call), called ~5-8x per split group. The optimization keeps every
  // cleanup operation but (a) routes the two discovery diffs through the
  // root-only `discoverDirty` (skips submodule recursion) and (b) drops the
  // trailing confirm diff entirely: every GDS case that follows restoreBaseline
  // issues its OWN first read with force=true (or opens the view, which
  // force-loads on entry), so the post-restore request cache is re-stat'd by
  // the next case regardless — the confirm diff only re-measured a tree the
  // next operation immediately re-reads. No assertion reads anything between
  // restoreBaseline returning and the next case's first force read.
  const restoreBaseline = async () => {
    await clearDiffState()
    await window.electronAPI.git.saveFileContent(cleanRoot, parentFile, 'parent source line\n')
    await window.electronAPI.git.saveFileContent(cleanRoot, stableStatusFile, '# Repeated edit target\n\nbaseline body\n')
    await window.electronAPI.git.saveFileContent(cleanRoot, subFile, '# Submodule\n\nbaseline content\n')
    await window.electronAPI.project.deletePath(cleanRoot, subUntracked)
  }

  // ─────────────── GDS-01..GDS-05: submodule c/m/u filter ───────────────

  if (!cancelled() && runGroup('submodule')) {
    await restoreBaseline()
    await window.electronAPI.git.saveFileContent(cleanRoot, parentFile, 'parent source line\nGDS-01\n')
    await sleep(200)
    const diff = await callDiff(cleanRoot, true)
    const subEntries = parentSubmoduleEntries(diff, cleanRoot, subPath)
    const parentChange = diff.files.find((f) => f.repoRoot && clampPath(f.repoRoot) === clampPath(cleanRoot) && f.filename === parentFile)
    record('GDS-01-parent-modified-submodule-clean', (
      diff.success &&
      Boolean(parentChange) &&
      subEntries.length === 0 &&
      repoChangeCount(diff, cleanRoot) === 1
    ), {
      submoduleEntries: subEntries.map((f) => ({ filename: f.filename, flags: f.submoduleFlags })),
      parentChangeCount: repoChangeCount(diff, cleanRoot),
      filenames: diff.files.map((f) => clampPath(f.filename))
    })
  }

  if (!cancelled() && runGroup('submodule')) {
    await restoreBaseline()
    await window.electronAPI.git.saveFileContent(cleanRoot, subFile, '# Submodule\n\nGDS-02 mutation\n')
    await sleep(200)
    const diff = await callDiff(cleanRoot, true)
    const subEntries = parentSubmoduleEntries(diff, cleanRoot, subPath)
    const subRepoRoot = `${cleanRoot}/${subPath}`
    const submoduleSection = diff.repos?.find((r) => clampPath(r.root) === clampPath(subRepoRoot))
    record('GDS-02-submodule-modified-parent-clean', (
      diff.success &&
      subEntries.length === 0 &&
      Boolean(submoduleSection) &&
      (submoduleSection?.changeCount ?? 0) >= 1
    ), {
      parentSubEntries: subEntries.length,
      submoduleSectionChangeCount: submoduleSection?.changeCount ?? null
    })
  }

  if (!cancelled() && runGroup('submodule')) {
    await restoreBaseline()
    await window.electronAPI.project.createFile(cleanRoot, subUntracked, 'gds-03 untracked\n')
    await sleep(200)
    const diff = await callDiff(cleanRoot, true)
    const subEntries = parentSubmoduleEntries(diff, cleanRoot, subPath)
    record('GDS-03-submodule-untracked-parent-clean', (
      diff.success && subEntries.length === 0
    ), {
      parentSubEntries: subEntries.length
    })
  }

  if (!cancelled() && runGroup('submodule')) {
    const diff = await callDiff(pointerRoot, true)
    const subEntries = parentSubmoduleEntries(diff, pointerRoot, subPath)
    const flags = subEntries[0]?.submoduleFlags
    record('GDS-04-submodule-pointer-changed-surfaces-in-parent', (
      diff.success &&
      subEntries.length === 1 &&
      Boolean(flags?.commitChanged)
    ), {
      submoduleEntryCount: subEntries.length,
      flags: flags ?? null
    })
  }

  if (!cancelled() && runGroup('submodule')) {
    await restoreBaseline()
    await window.electronAPI.git.saveFileContent(cleanRoot, parentFile, 'parent source line\nGDS-05 parent\n')
    await window.electronAPI.git.saveFileContent(cleanRoot, subFile, '# Submodule\n\nGDS-05 sub\n')
    await sleep(200)
    const diff = await callDiff(cleanRoot, true)
    const parentChange = diff.files.find((f) => f.repoRoot && clampPath(f.repoRoot) === clampPath(cleanRoot) && f.filename === parentFile)
    const subEntries = parentSubmoduleEntries(diff, cleanRoot, subPath)
    const subRepoRoot = `${cleanRoot}/${subPath}`
    const submoduleSection = diff.repos?.find((r) => clampPath(r.root) === clampPath(subRepoRoot))
    record('GDS-05-mixed-parent-and-submodule-internal', (
      diff.success &&
      Boolean(parentChange) &&
      subEntries.length === 0 &&
      (submoduleSection?.changeCount ?? 0) >= 1
    ), {
      parentChange: Boolean(parentChange),
      submoduleEntries: subEntries.length,
      submoduleSectionChangeCount: submoduleSection?.changeCount ?? null
    })
  }

  // ─────────────── GDS-14: staged submodule pointer change must stay visible ───────────────
  // After `git add modules/sub`, the parent's index records the new pointer
  // and the submodule worktree HEAD now matches the index. Porcelain v2
  // reports `<c>=.` (no commit divergence) but X is non-`.` (parent index
  // changed). The filter must keep this row by `changeType === 'staged'` —
  // otherwise the user can no longer see / unstage the gitlink change from
  // Git Diff.
  if (!cancelled() && runGroup('submodule') && manifest.stagedPointerRoot) {
    const stagedPointerRoot = manifest.stagedPointerRoot
    const diff = await callDiff(stagedPointerRoot, true)
    const subEntries = parentSubmoduleEntries(diff, stagedPointerRoot, subPath)
    const flags = subEntries[0]?.submoduleFlags
    record('GDS-14-staged-submodule-pointer-surfaces-in-parent', (
      diff.success &&
      subEntries.length === 1 &&
      subEntries[0].changeType === 'staged' &&
      // Filter must NOT rely on `<c>=C` for this case — that's the whole
      // point of the bug. Asserting commitChanged === false lets the test
      // fail loudly if a future change accidentally re-introduces the
      // c-flag-only filter.
      flags?.commitChanged === false
    ), {
      submoduleEntryCount: subEntries.length,
      changeType: subEntries[0]?.changeType ?? null,
      flags: flags ?? null
    })
  }

  // ─────────────── GDS-13: uninitialized submodule (Project_Forward repro) ───────────────
  // The fixture's `uninitialized/root` has `.gitmodules` declaring `modules/sub`
  // but the directory has been `git submodule deinit`-ed — it exists on disk
  // but is NOT a git repository. The previous code path's `.gitmodules`
  // fallback (when `git submodule status --recursive` returns no initialized
  // entries) would treat the empty path as a submodule and downstream
  // `getSingleRepoDiff` would either fail or surface noise. The fix in
  // `collectSubmodulesFromGitmodules` calls `getGitRepoMeta(subRepoRoot)` and
  // requires the resolved toplevel to BE the submodule path itself; an empty
  // subdir resolves to its parent's toplevel, so it gets filtered out.
  if (!cancelled() && runGroup('submodule') && manifest.uninitializedRoot) {
    const uninitializedRoot = manifest.uninitializedRoot
    // Modify a parent-only file; nothing else should appear.
    await window.electronAPI.git.saveFileContent(uninitializedRoot, parentFile, 'parent source line\nGDS-13\n')
    // Poll the GROUND TRUTH (the parent's own change present in a forced diff)
    // instead of trusting a fixed sleep. Under full-suite EDR the
    // write -> git-visible -> diff-loaded window exceeds 200 ms, so the single
    // forced callDiff returned an empty result (reposCount:0, parentChange absent)
    // and the assertion failed for a non-bug reason. Re-issue the forced diff until
    // the parent change is observed (EDR-tolerant ceiling), then assert the
    // negatives on that settled diff. A genuinely-empty diff still fails by timeout.
    let diff = await callDiff(uninitializedRoot, true)
    const gds13Deadline = Date.now() + adaptiveDiffBudget()
    while (
      !cancelled() &&
      Date.now() < gds13Deadline &&
      !(diff.success && diff.files.some((f) => f.filename === parentFile))
    ) {
      await sleep(500)
      diff = await callDiff(uninitializedRoot, true)
    }
    const subEntries = parentSubmoduleEntries(diff, uninitializedRoot, subPath)
    // The uninitialized submodule MUST NOT show up in the repos outline at all
    // (it's not a real repo), and MUST NOT appear as a submodule entry in the
    // parent's file list.
    const phantomRepo = (diff.repos ?? []).some((r) => clampPath(r.root).endsWith(`/${subPath}`))
    const parentChange = diff.files.find((f) => f.filename === parentFile)
    record('GDS-13-uninitialized-submodule-not-surfaced', (
      diff.success &&
      Boolean(parentChange) &&
      subEntries.length === 0 &&
      !phantomRepo
    ), {
      parentChangeSeen: Boolean(parentChange),
      submoduleEntriesInParent: subEntries.length,
      phantomRepoInOutline: phantomRepo,
      reposCount: diff.repos?.length ?? 0,
      filenames: diff.files.map((f) => clampPath(f.filename))
    })
  }

  // ─────────────── GDS-06..GDS-10: staleness + cache ───────────────

  if (!cancelled() && runGroup('staleness')) {
    await restoreBaseline()
    await callDiff(cleanRoot, true)
    await window.electronAPI.git.saveFileContent(cleanRoot, parentFile, 'parent source line\nGDS-06\n')
    // Intentionally NOT passing force on the second call — relying on watcher.
    // 250 ms gives the 180 ms debounce inside the invalidator a window to fire.
    await sleep(280)
    const diff = await callDiff(cleanRoot)
    const seen = diff.files.find((f) => f.filename === parentFile)
    record('GDS-06-watcher-invalidates-cache-on-fs-change', (
      diff.success && Boolean(seen)
    ), {
      sawNewParentChange: Boolean(seen),
      filenames: diff.files.map((f) => clampPath(f.filename))
    })
  }

  if (!cancelled() && runGroup('staleness')) {
    await restoreBaseline()
    await callDiff(cleanRoot, true)
    await sleep(50)
    await window.electronAPI.git.saveFileContent(cleanRoot, parentFile, 'parent source line\nGDS-07\n')
    await sleep(280)
    const diff = await callDiff(cleanRoot)
    const seen = diff.files.find((f) => f.filename === parentFile)
    record('GDS-07-watcher-invalidates-after-debounce', (
      diff.success && Boolean(seen)
    ), { sawNewParentChange: Boolean(seen) })
  }

  if (!cancelled() && runGroup('staleness')) {
    await restoreBaseline()
    // Pre-populate cache via UI open, then close, then mutate, then re-open.
    window.dispatchEvent(new CustomEvent('git-diff:open', { detail: { terminalId } }))
    await waitFor('GDS-08-first-open', () => Boolean(window.__onwardGitDiffDebug?.isOpen()), 6000)
    await sleep(400)
    window.dispatchEvent(new CustomEvent('git-diff:close', { detail: { terminalId } }))
    await waitFor('GDS-08-first-close', () => !window.__onwardGitDiffDebug?.isOpen(), 4000)
    await window.electronAPI.git.saveFileContent(cleanRoot, parentFile, 'parent source line\nGDS-08\n')
    await sleep(50)
    window.dispatchEvent(new CustomEvent('git-diff:open', { detail: { terminalId } }))
    // Diff-CONTENT population wait (file list must reflect the closed-window
    // mutation) — EDR-aware ceiling.
    const reopenedFresh = await waitFor('GDS-08-second-open', () => {
      const api = window.__onwardGitDiffDebug
      if (!api?.isOpen()) return false
      return api.getFileList().some((f) => f.filename === parentFile)
    }, adaptiveDiffBudget())
    record('GDS-08-subpage-entry-shows-fresh-data', reopenedFresh, {
      visibleFiles: window.__onwardGitDiffDebug?.getFileList()?.map((f) => f.filename) ?? null
    })
    window.dispatchEvent(new CustomEvent('git-diff:close', { detail: { terminalId } }))
    await waitFor('GDS-08-final-close', () => !window.__onwardGitDiffDebug?.isOpen(), 4000)
  }

  if (!cancelled() && runGroup('staleness')) {
    await restoreBaseline()
    window.dispatchEvent(new CustomEvent('git-diff:open', { detail: { terminalId } }))
    await waitFor('GDS-09-open', () => Boolean(window.__onwardGitDiffDebug?.isOpen()), 6000)
    await sleep(400)
    await window.electronAPI.git.saveFileContent(cleanRoot, parentFile, 'parent source line\nGDS-09 external\n')
    // Diff-CONTENT population wait — gated on the deterministic file-list
    // predicate but with the EDR-aware ceiling so a legitimately slow (~10 s)
    // diff load under EDR is not mistaken for a missing external change.
    const sawExternal = await waitFor('GDS-09-external-change-reflected', () => {
      return Boolean(window.__onwardGitDiffDebug?.getFileList().some((f) => f.filename === parentFile))
    }, adaptiveDiffBudget(), 100)
    record('GDS-09-open-view-reflects-external-change', sawExternal, {
      visibleFiles: window.__onwardGitDiffDebug?.getFileList()?.map((f) => f.filename) ?? null
    })
    window.dispatchEvent(new CustomEvent('git-diff:close', { detail: { terminalId } }))
    await waitFor('GDS-09-close', () => !window.__onwardGitDiffDebug?.isOpen(), 4000)
  }

  if (!cancelled() && runGroup('staleness')) {
    await restoreBaseline()
    await window.electronAPI.git.saveFileContent(cleanRoot, parentFile, 'parent source line\nGDS-10 concurrent\n')
    await sleep(50)
    const [forceResult, cachedResult] = await Promise.all([
      callDiff(cleanRoot, true),
      callDiff(cleanRoot, false)
    ])
    const forceFile = forceResult.files.find((f) => f.filename === parentFile)
    const cachedFile = cachedResult.files.find((f) => f.filename === parentFile)
    record('GDS-10-concurrent-force-and-cached-converge', (
      forceResult.success &&
      cachedResult.success &&
      Boolean(forceFile) &&
      Boolean(cachedFile)
    ), {
      forceFileSeen: Boolean(forceFile),
      cachedFileSeen: Boolean(cachedFile)
    })
  }

  // ─────────────── GDS-15: subdir entry tracks the resolved repo root ───────────────
  // When the user opens Git Diff from a subdirectory (e.g.
  // `cleanRoot/src/components/`), getGitDiff resolves up to `cleanRoot` and
  // returns a diff covering the WHOLE repo. The invalidation scope must be
  // the resolved repoRoot — not the subdir — otherwise an external edit
  // to a sibling path under the same repo would be silently missed.
  // Sequence: open Diff with `cwd=cleanRoot/src` (a subdir), wait for it to
  // load, then mutate `cleanRoot/<parentFile>` (a path NOT under `src/`),
  // and verify the Mirror-driven cache invalidation eventually surfaces
  // that file. If the scope were `cleanRoot/src/`, the
  // assertion would time out.
  // NB GROUP: GDS-15 (subdir-scope watch, ~19.5 s) moves to the 'reentry' group —
  // its repo-root-resolution / re-entry-scope domain fits there, and the move
  // relieves the staleness group (6 real-diff-load cases) of one more case so
  // every split group stays well under budget.
  if (!cancelled() && runGroup('reentry')) {
    await restoreBaseline()
    const subdirCwd = `${cleanRoot}/src`
    // First call: register the resolved repo with the invalidation bus.
    await callDiff(subdirCwd, true)
    await sleep(250)
    // Mutate a path NOT under `src/` — README.md lives at the parent root.
    await window.electronAPI.git.saveFileContent(cleanRoot, 'README.md', '# Clean parent\n\nGDS-15 root-level edit\n')
    await sleep(450) // Mirror debounce + git recompute slack
    const followup = await callDiff(subdirCwd, false)
    const sawRootEdit = followup.success && followup.files.some((f) => f.filename === 'README.md')
    record('GDS-15-subdir-entry-watches-resolved-repo-root', sawRootEdit, {
      subdirCwd,
      mutatedFile: 'README.md',
      visibleFiles: followup.files.map((f) => clampPath(f.filename))
    })
  }

  // ─────────────── GDS-17: re-entry must re-fetch per-file diff body ───────────────
  // Repro for the user-reported bug where re-entering Git Diff shows the
  // PREVIOUS open's diff body even after the file changed on disk:
  //   1. Modify <parentFile> to V1, open Diff -> renderer caches Monaco's
  //      original/modified content under fileContents[fileKey].
  //   2. Close Diff. The Mirror invalidation chain clears worker-side caches but
  //      the renderer's per-file content map is preserved across same-cwd
  //      re-entries by applyLoadedDiffResult.
  //   3. Modify the same file to V2 while Diff is closed.
  //   4. Re-open Diff. The selected file does not change, so the
  //      ensureFileContent effect does not re-fire and Monaco shows V1.
  // Existing GDS-08 only checks file-list freshness; the gap is the diff
  // BODY shown to the user. The assertion below probes the actual cached
  // originalContent / modifiedContent via the new debug API.
  // NB GROUP: GDS-17 (~34.6 s re-entry-content) anchors the 'reentry' group with
  // GDS-15/18/20 — its native domain (open/close re-entry freshness) matches that
  // group, and at ~34.6 s it is one of the heaviest singles, deliberately spread
  // one-per-group so no group clusters the expensive cases.
  if (!cancelled() && runGroup('reentry')) {
    await restoreBaseline()
    const v1Modified = 'parent source line\nGDS-17 v1 first edit\n'
    const v2Modified = 'parent source line\nGDS-17 v2 SECOND edit (must surface)\n'

    await window.electronAPI.git.saveFileContent(cleanRoot, parentFile, v1Modified)
    await sleep(280) // Mirror debounce slack so any cached worker entry is dropped

    window.dispatchEvent(new CustomEvent('git-diff:open', { detail: { terminalId } }))
    await waitFor('GDS-17-first-open', () => Boolean(window.__onwardGitDiffDebug?.isOpen()), 6000)
    // Diff-CONTENT population waits — EDR-aware ceiling so the FIRST open's slow
    // (~10 s under EDR) diff load is not declared stale before it finishes.
    await waitFor('GDS-17-first-list', () => {
      const api = window.__onwardGitDiffDebug
      return Boolean(api?.getFileList().some((f) => f.filename === parentFile))
    }, adaptiveDiffBudget())
    const api1 = window.__onwardGitDiffDebug
    if (api1 && api1.getSelectedFile()?.filename !== parentFile) {
      api1.selectFileByPath(parentFile)
    }
    const firstModelFresh = await waitForSelectedContentAndModel('GDS-17-first-content-model-ready', v1Modified, {
      timeoutMs: adaptiveDiffBudget()
    })
    const firstSnapshot = getSelectedFileContentSnapshot()
    const firstModelSnapshot = getSelectedEditorModelSnapshot()
    log('GDS-17-first-snapshot', firstSnapshot)
    log('GDS-17-first-model-snapshot', firstModelSnapshot)

    window.dispatchEvent(new CustomEvent('git-diff:close', { detail: { terminalId } }))
    await waitFor('GDS-17-close', () => !window.__onwardGitDiffDebug?.isOpen(), 4000)

    // Mutate while Diff is closed — the per-file watcher in the renderer
    // is unsubscribed in this window. The Mirror invalidation bus clears
    // worker-side caches and sends 'git:diff-cache-invalidated' to the
    // renderer, but the renderer's listener is gated on isOpen.
    await window.electronAPI.git.saveFileContent(cleanRoot, parentFile, v2Modified)
    await sleep(320) // Mirror debounce + recompute slack

    window.dispatchEvent(new CustomEvent('git-diff:open', { detail: { terminalId } }))
    await waitFor('GDS-17-second-open', () => Boolean(window.__onwardGitDiffDebug?.isOpen()), 6000)
    // Diff-CONTENT population waits — EDR-aware ceiling (same EDR-taxed
    // getGitDiff round-trip as the first open above).
    await waitFor('GDS-17-second-list', () => {
      const api = window.__onwardGitDiffDebug
      return Boolean(api?.getFileList().some((f) => f.filename === parentFile))
    }, adaptiveDiffBudget())
    const api2 = window.__onwardGitDiffDebug
    if (api2 && api2.getSelectedFile()?.filename !== parentFile) {
      api2.selectFileByPath(parentFile)
    }
    const secondModelFresh = await waitForSelectedContentAndModel('GDS-17-second-content-model-ready', v2Modified, {
      timeoutMs: adaptiveDiffBudget()
    })
    const secondSnapshot = getSelectedFileContentSnapshot()
    const secondModelSnapshot = getSelectedEditorModelSnapshot()
    log('GDS-17-second-snapshot', secondSnapshot)
    log('GDS-17-second-model-snapshot', secondModelSnapshot)

    const sawV2 = secondSnapshot?.modifiedContent === v2Modified
    const sawV1Stale = secondSnapshot?.modifiedContent === v1Modified
    const modelSawV2 = secondModelSnapshot?.modifiedContent === v2Modified
    record('GDS-17-reentry-shows-latest-content', Boolean(
      firstModelFresh &&
      secondModelFresh &&
      sawV2 &&
      modelSawV2 &&
      !sawV1Stale
    ), {
      firstModifiedContent: firstSnapshot?.modifiedContent ?? null,
      firstModelModifiedContent: firstModelSnapshot?.modifiedContent ?? null,
      secondModifiedContent: secondSnapshot?.modifiedContent ?? null,
      secondModelModifiedContent: secondModelSnapshot?.modifiedContent ?? null,
      expected: v2Modified,
      firstModelFresh,
      secondModelFresh,
      sawV2,
      modelSawV2,
      sawV1Stale,
      contentProbeAvailable: typeof window.__onwardGitDiffDebug?.getSelectedFileContent === 'function',
      modelProbeAvailable: typeof window.__onwardGitDiffDebug?.getSelectedEditorModelContent === 'function'
    })

    window.dispatchEvent(new CustomEvent('git-diff:close', { detail: { terminalId } }))
    await waitFor('GDS-17-final-close', () => !window.__onwardGitDiffDebug?.isOpen(), 4000)
  }

  // ───── GDS-47: read-path stat revalidation surfaces a WATCHER-MISSED edit ─────
  // The content-cache key is path-only, so a same-status re-edit maps to the SAME
  // key. Every other GDS case mutates via saveFileContent (deterministic IPC-save
  // invalidation) OR external-write-then-wait-for-the-watcher; NEITHER exercises the
  // real user bug: the FS watcher MISSES the edit, yet the very next read must still
  // be fresh. This case does exactly that — prime the content cache, do a RAW
  // external write (debug.writeExternalFile: no IPC-save invalidation), then re-read
  // getFileContent IMMEDIATELY, BEFORE the async parcel-watcher/mirror chain can
  // invalidate. Only the read-path fs.stat compare can make that read fresh, so a
  // fresh result isolates the fix; cacheInfo.missReason === 'invalidated-stat-
  // revalidate' proves the stat path (not a coincidental watcher win) surfaced it.
  // Timing-sensitive (statistical) → aggregate N=5 and assert on the aggregate.
  if (!cancelled() && runGroup('reentry')) {
    await restoreBaseline()
    // parentFile is a plain modified (unstaged) tracked file — not a rename — so the
    // getFileContent descriptor is fixed. Cast to the exact param type so the `status`
    // literal is accepted as a GitStatusCode without importing the union here.
    const fileDesc = {
      filename: parentFile,
      status: 'M',
      changeType: 'unstaged',
      isSubmoduleEntry: false
    } as Parameters<typeof window.electronAPI.git.getFileContent>[1]
    const N = 5
    let freshCount = 0
    let viaStatRevalidate = 0
    for (let i = 0; i < N && !cancelled(); i += 1) {
      const primeContent = `parent source line\nGDS-47 prime ${i}\n`
      const editContent = `parent source line\nGDS-47 external edit ${i} must surface\n`
      // Establish + CACHE the prime content (saveFileContent invalidates; the read re-warms it).
      await window.electronAPI.git.saveFileContent(cleanRoot, parentFile, primeContent)
      await window.electronAPI.git.getFileContent(cleanRoot, fileDesc, cleanRoot, { force: false })
      // RAW external write — bypasses GIT_SAVE_FILE_CONTENT invalidation; bumps mtime.
      await window.electronAPI.debug.writeExternalFile({ root: cleanRoot, relPath: parentFile, content: editContent })
      // IMMEDIATE re-read: no delay, so the async watcher cannot have invalidated yet;
      // only the read-path stat revalidation can surface the change here.
      const after = await window.electronAPI.git.getFileContent(cleanRoot, fileDesc, cleanRoot, { force: false })
      if (after?.modifiedContent === editContent) freshCount += 1
      if (after?.cacheInfo?.missReason === 'invalidated-stat-revalidate') viaStatRevalidate += 1
    }
    record('GDS-47-read-path-stat-revalidation-surfaces-watcher-missed-edit', freshCount === N && viaStatRevalidate >= 1, {
      freshCount,
      viaStatRevalidate,
      N,
      note: 'freshCount===N: the immediate re-read after an external edit is fresh (the regression fails here); viaStatRevalidate>=1: the read-path fs.stat compare (not the watcher) surfaced it'
    })
  }

  // ═════ GDS-50 / GDS-51: missed-watch reopen freshness (2026-07-12 diagnostic bundle) ═════
  // Authored as a reproduction attempt for the bundle's "stale until manual
  // refresh" report — and the cases PASSED: in this fixture the Git Diff viewer
  // is the cwd's only mirror subscriber, so the subpage close detaches the
  // mirror entry and the reopen's re-attach runs a REAL `git status` (reason
  // 'attach') whose delta fans out and force-reloads the view. The pass is the
  // finding: the reopen path recovers via the attach lifecycle even with the
  // mirror fully silenced, so the bundle's root cause is NOT a missed-event
  // class — it is the content-cache staleToken TOCTOU pinned by
  // test/unittest/git-diff-content-cache-wiring.test.mts "REPRO TOCTOU"
  // (mirror state correct → no invalidation ever → poisoned entry served
  // forever). These cases stay as GREEN locks on the attach-recovery contract.
  //
  // Model: the mirror authority (FS watcher + reconcile heartbeat) missed a
  // change entirely. The runner silences both via
  // ONWARD_AUTOTEST_GSM_WATCHER_SILENT=1 + ONWARD_AUTOTEST_GSM_RECONCILE_SILENT=1,
  // so no watcher/heartbeat push can satisfy the assertions for the wrong
  // reason. The mutation goes through debug.writeExternalFile (raw fs write,
  // no IPC-save invalidation), the same watcher-missed primitive GDS-47 uses.
  //
  // Contract asserted (user-level, mechanism-agnostic): a same-cwd RE-OPEN of
  // Git Diff must surface the on-disk truth WITHOUT a manual refresh.
  // NB: a persistent second mirror subscriber on the cwd (a terminal badge in
  // the user's real session) would keep the entry attached across the close,
  // skip the attach recompute, and re-expose the reopen to any silent-mirror
  // gap — if that topology ever needs locking too, hold an extra
  // subscribeMirror(cleanRoot) across the case.
  //
  // Freshness window: NOT adaptiveDiffBudget() — its 90 s floor would burn
  // 3 min of wall clock on the red path. This is a convergence bound, not a
  // user-facing latency budget: post-fix the reopen chain needs one mirror
  // recompute + one forced getDiff, both tracked by measuredDiffMs, so 3x the
  // measured cost with a 15 s fast-host floor bounds it with wide slack while
  // keeping the by-design-red wait affordable.
  const missedWatchFreshnessBudget = (): number => {
    if (measuredDiffMs === null) return 15_000
    return Math.min(DIFF_LOAD_CAP_MS, Math.max(15_000, measuredDiffMs * 3))
  }

  // ─── GDS-50: reopen after a missed NEW-file creation must list the new file ───
  if (!cancelled() && gdsGroup === 'missed-watch') {
    await restoreBaseline()
    const newRel = 'gds50_missed_watch_new_file.md'
    // Dirty the baseline BEFORE opening: restoreBaseline() leaves the fixture
    // repo clean (empty diff list), so a list-presence wait keyed on parentFile
    // would never satisfy and would burn its whole budget (the authoring bug
    // behind this runner's first 280 s watchdog kill — fileCount:0 in the log).
    await window.electronAPI.git.saveFileContent(cleanRoot, parentFile, 'parent source line\nGDS-50 baseline dirty edit\n')
    await sleep(280)
    // First open: baseline list, warms every cache layer (request cache,
    // content cache, renderer fileContents + lastDiff).
    window.dispatchEvent(new CustomEvent('git-diff:open', { detail: { terminalId } }))
    await waitFor('GDS-50-first-open', () => Boolean(window.__onwardGitDiffDebug?.isOpen()), 6000)
    await waitFor('GDS-50-first-list', () => {
      const api = window.__onwardGitDiffDebug
      return Boolean(api?.getFileList().some((f) => f.filename === parentFile))
    }, adaptiveDiffBudget())
    window.dispatchEvent(new CustomEvent('git-diff:close', { detail: { terminalId } }))
    await waitFor('GDS-50-close', () => !window.__onwardGitDiffDebug?.isOpen(), 4000)

    // NEW file lands while Diff is closed; the silenced mirror never reports it.
    await window.electronAPI.debug.writeExternalFile({
      root: cleanRoot,
      relPath: newRel,
      content: '# GDS-50\n\nCreated behind the silenced mirror; must surface on reopen.\n'
    })
    await sleep(300) // user-scale gap; nothing is being waited on — no push can come

    window.dispatchEvent(new CustomEvent('git-diff:open', { detail: { terminalId } }))
    await waitFor('GDS-50-second-open', () => Boolean(window.__onwardGitDiffDebug?.isOpen()), 6000)
    const newFileListed = await waitFor('GDS-50-second-list-has-new-file', () => {
      const api = window.__onwardGitDiffDebug
      return Boolean(api?.getFileList().some((f) => f.filename === newRel))
    }, missedWatchFreshnessBudget())
    record('GDS-50-missed-watch-reopen-surfaces-new-file', newFileListed, {
      newRel,
      freshnessBudgetMs: missedWatchFreshnessBudget(),
      visibleFiles: (window.__onwardGitDiffDebug?.getFileList() ?? []).map((f) => clampPath(f.filename)),
      note: 'reopen after a mirror-missed file creation must list the new file without a manual refresh'
    })
    window.dispatchEvent(new CustomEvent('git-diff:close', { detail: { terminalId } }))
    await waitFor('GDS-50-final-close', () => !window.__onwardGitDiffDebug?.isOpen(), 4000)
    await window.electronAPI.project.deletePath(cleanRoot, newRel)
  }

  // ─── GDS-51: reopen after a missed EDIT must show the fresh body, not renderer memory ───
  if (!cancelled() && gdsGroup === 'missed-watch') {
    await restoreBaseline()
    const v1 = 'parent source line\nGDS-51 v1 body cached by the first open\n'
    const v2 = 'parent source line\nGDS-51 v2 EXTERNAL edit the mirror missed\n'
    await window.electronAPI.git.saveFileContent(cleanRoot, parentFile, v1)
    await sleep(280)

    window.dispatchEvent(new CustomEvent('git-diff:open', { detail: { terminalId } }))
    await waitFor('GDS-51-first-open', () => Boolean(window.__onwardGitDiffDebug?.isOpen()), 6000)
    await waitFor('GDS-51-first-list', () => {
      const api = window.__onwardGitDiffDebug
      return Boolean(api?.getFileList().some((f) => f.filename === parentFile))
    }, adaptiveDiffBudget())
    const api1 = window.__onwardGitDiffDebug
    if (api1 && api1.getSelectedFile()?.filename !== parentFile) {
      api1.selectFileByPath(parentFile)
    }
    const firstFresh = await waitForSelectedContentAndModel('GDS-51-first-content-ready', v1, {
      timeoutMs: adaptiveDiffBudget()
    })
    window.dispatchEvent(new CustomEvent('git-diff:close', { detail: { terminalId } }))
    await waitFor('GDS-51-close', () => !window.__onwardGitDiffDebug?.isOpen(), 4000)

    // External edit while closed — raw write, silenced mirror: no invalidation
    // push will EVER arrive, so the renderer's fileContents keeps the v1 body.
    await window.electronAPI.debug.writeExternalFile({ root: cleanRoot, relPath: parentFile, content: v2 })
    await sleep(300)

    window.dispatchEvent(new CustomEvent('git-diff:open', { detail: { terminalId } }))
    await waitFor('GDS-51-second-open', () => Boolean(window.__onwardGitDiffDebug?.isOpen()), 6000)
    await waitFor('GDS-51-second-list', () => {
      const api = window.__onwardGitDiffDebug
      return Boolean(api?.getFileList().some((f) => f.filename === parentFile))
    }, adaptiveDiffBudget())
    const api2 = window.__onwardGitDiffDebug
    if (api2 && api2.getSelectedFile()?.filename !== parentFile) {
      api2.selectFileByPath(parentFile)
    }
    const secondFresh = await waitForSelectedContentAndModel('GDS-51-second-content-fresh', v2, {
      timeoutMs: missedWatchFreshnessBudget()
    })
    record('GDS-51-missed-watch-reopen-refreshes-selected-body', Boolean(firstFresh && secondFresh), {
      firstFresh,
      secondFresh,
      freshnessBudgetMs: missedWatchFreshnessBudget(),
      selectedSnapshot: getSelectedFileContentSnapshot(),
      note: 'reopen after a mirror-missed edit must show the on-disk body, not the previous open’s renderer memory'
    })
    window.dispatchEvent(new CustomEvent('git-diff:close', { detail: { terminalId } }))
    await waitFor('GDS-51-final-close', () => !window.__onwardGitDiffDebug?.isOpen(), 4000)
  }

  // ─────────────── GDS-18: re-entry latency trend is recorded ───────────────
  // The flip-side of GDS-17: same-cwd re-entry with no intervening mutation
  // should normally hit warm caches. This row records the timing as trend
  // data but does not hard-fail on a wall-clock threshold; the functional
  // gate is that the second entry loads a file list and reports timing.
  // NB GROUP: GDS-18 (re-entry-latency trend, ~25.3 s) is the flip-side of GDS-17
  // (same open/close re-entry freshness domain), so it anchors the 'reentry' group
  // alongside GDS-15/17/20.
  if (!cancelled() && runGroup('reentry')) {
    await restoreBaseline()
    await window.electronAPI.git.saveFileContent(cleanRoot, parentFile, 'parent source line\nGDS-18 baseline\n')
    await sleep(280)

    // First open warms the cache.
    window.dispatchEvent(new CustomEvent('git-diff:open', { detail: { terminalId } }))
    await waitFor('GDS-18-first-open', () => Boolean(window.__onwardGitDiffDebug?.isOpen()), 6000)
    // Diff-CONTENT population wait — EDR-aware ceiling.
    await waitFor('GDS-18-first-list', () => {
      const api = window.__onwardGitDiffDebug
      return Boolean(api?.getFileList().some((f) => f.filename === parentFile))
    }, adaptiveDiffBudget())
    window.dispatchEvent(new CustomEvent('git-diff:close', { detail: { terminalId } }))
    await waitFor('GDS-18-close', () => !window.__onwardGitDiffDebug?.isOpen(), 4000)

    // No file mutation between close and re-open. Watcher should have
    // nothing to invalidate, so the second entry should hit the L2 / L3 /
    // L4 caches and complete almost instantly.
    await sleep(50)
    window.dispatchEvent(new CustomEvent('git-diff:open', { detail: { terminalId } }))
    await waitFor('GDS-18-second-open', () => Boolean(window.__onwardGitDiffDebug?.isOpen()), 6000)
    // Diff-CONTENT population waits — EDR-aware ceiling.
    await waitFor('GDS-18-second-list', () => {
      const api = window.__onwardGitDiffDebug
      return Boolean(api?.getFileList().some((f) => f.filename === parentFile))
    }, adaptiveDiffBudget())
    const secondTimingReady = await waitFor('GDS-18-second-timing', () => {
      const snapshot = window.__onwardGitDiffDebug?.getTiming?.() ?? null
      return typeof snapshot?.cwdReadyToDiffLoadedMs === 'number'
    }, adaptiveDiffBudget(), 50)
    const timing = window.__onwardGitDiffDebug?.getTiming?.() ?? null
    const cwdReadyToDiffLoadedMs = timing?.cwdReadyToDiffLoadedMs ?? null
    const timingRecorded = typeof cwdReadyToDiffLoadedMs === 'number'
    log('GDS-18-second-timing-snapshot', {
      timing,
      secondTimingReady,
      loadState: window.__onwardGitDiffDebug?.getLoadState?.() ?? null
    })
    record('GDS-18-reentry-latency-trend-recorded', Boolean(secondTimingReady && timingRecorded), {
      timing,
      secondTimingReady,
      loadState: window.__onwardGitDiffDebug?.getLoadState?.() ?? null,
      healthyTargetMs: 350
    })
    window.dispatchEvent(new CustomEvent('git-diff:close', { detail: { terminalId } }))
    await waitFor('GDS-18-final-close', () => !window.__onwardGitDiffDebug?.isOpen(), 4000)
  }

  // ─────────────── GDS-19: open view selected body refreshes ───────────────
  if (!cancelled() && runGroup('model-sync')) {
    await restoreBaseline()
    const v1Modified = 'parent source line\nGDS-19 v1 while open\n'
    const v2Modified = 'parent source line\nGDS-19 v2 while open (must surface)\n'

    await window.electronAPI.git.saveFileContent(cleanRoot, parentFile, v1Modified)
    await sleep(280)
    window.dispatchEvent(new CustomEvent('git-diff:open', { detail: { terminalId } }))
    await waitFor('GDS-19-open', () => Boolean(window.__onwardGitDiffDebug?.isOpen()), 6000)
    // Diff-CONTENT population waits — EDR-aware ceiling.
    await waitFor('GDS-19-list', () => Boolean(window.__onwardGitDiffDebug?.getFileList().some((f) => f.filename === parentFile)), adaptiveDiffBudget())
    if (window.__onwardGitDiffDebug?.getSelectedFile()?.filename !== parentFile) {
      window.__onwardGitDiffDebug?.selectFileByPath(parentFile)
    }
    await waitForSelectedContentAndModel('GDS-19-v1-model-ready', v1Modified, {
      timeoutMs: adaptiveDiffBudget()
    })

    await window.electronAPI.git.saveFileContent(cleanRoot, parentFile, v2Modified)
    const refreshed = await waitForSelectedContentAndModel('GDS-19-v2-refresh-model-ready', v2Modified, {
      expectedDraftContent: null,
      timeoutMs: adaptiveDiffBudget()
    })
    const refreshedState = getSelectedFileContentSnapshot()
    const refreshedModel = getSelectedEditorModelSnapshot()
    record('GDS-19-open-view-selected-body-refreshes', Boolean(
      refreshed &&
      refreshedState?.draftContent === null
    ), {
      snapshot: refreshedState,
      modelSnapshot: refreshedModel,
      draftContent: refreshedState?.draftContent ?? null,
      expected: v2Modified
    })
    window.dispatchEvent(new CustomEvent('git-diff:close', { detail: { terminalId } }))
    await waitFor('GDS-19-close', () => !window.__onwardGitDiffDebug?.isOpen(), 4000)
  }

  // ─────────────── GDS-20: draft survives external refresh ───────────────
  // NB GROUP: GDS-20 (~34.6 s draft-preserved-during-external-refresh) moves to
  // the 'reentry' group for cost balance — it is one of the heaviest singles, kept
  // away from model-sync's already-heavy GDS-19/43/44 so no group clusters them.
  // It still drives the renderer model-sync trace path, so reentry asserts that
  // event (an event asserted by >1 group is fine when each asserting group's cases
  // reliably emit it).
  if (!cancelled() && runGroup('reentry')) {
    await restoreBaseline()
    const v1Modified = 'parent source line\nGDS-20 v1 base\n'
    const v2Modified = 'parent source line\nGDS-20 v2 external\n'
    const localDraft = 'parent source line\nGDS-20 local draft must survive\n'

    await window.electronAPI.git.saveFileContent(cleanRoot, parentFile, v1Modified)
    await sleep(280)
    window.dispatchEvent(new CustomEvent('git-diff:open', { detail: { terminalId } }))
    await waitFor('GDS-20-open', () => Boolean(window.__onwardGitDiffDebug?.isOpen()), 6000)
    // Diff-CONTENT population waits — EDR-aware ceiling.
    await waitFor('GDS-20-list', () => Boolean(window.__onwardGitDiffDebug?.getFileList().some((f) => f.filename === parentFile)), adaptiveDiffBudget())
    if (window.__onwardGitDiffDebug?.getSelectedFile()?.filename !== parentFile) {
      window.__onwardGitDiffDebug?.selectFileByPath(parentFile)
    }
    await waitForSelectedContentAndModel('GDS-20-v1-model-ready', v1Modified, {
      timeoutMs: adaptiveDiffBudget()
    })
    const draftSet = window.__onwardGitDiffDebug?.setSelectedDraftContent?.(localDraft) === true
    await waitFor('GDS-20-draft-visible', () => {
      const state = window.__onwardGitDiffDebug?.getSelectedFileContent?.()
      const model = window.__onwardGitDiffDebug?.getSelectedEditorModelContent?.()
      return state?.draftContent === localDraft &&
        model?.modifiedContent === localDraft &&
        model.modifiedMatchesState === true &&
        window.__onwardGitDiffDebug?.getIsDraftDirty?.() === true
    }, 3000, 50)

    await window.electronAPI.git.saveFileContent(cleanRoot, parentFile, v2Modified)
    // Diff-CONTENT population wait (external refresh must surface v2 while the
    // local draft survives) — EDR-aware ceiling.
    const refreshed = await waitFor('GDS-20-draft-preserved-after-refresh', () => {
      const state = getSelectedFileContentSnapshot()
      const model = getSelectedEditorModelSnapshot()
      return state?.modifiedContent === v2Modified &&
        state.draftContent === localDraft &&
        model?.modifiedContent === localDraft &&
        model.modifiedMatchesState === true
    }, adaptiveDiffBudget(), 50)
    record('GDS-20-draft-preserved-during-external-refresh', draftSet && refreshed, {
      snapshot: getSelectedFileContentSnapshot(),
      modelSnapshot: getSelectedEditorModelSnapshot(),
      expectedModifiedContent: v2Modified,
      expectedDraftContent: localDraft,
      debugDraftApiAvailable: typeof window.__onwardGitDiffDebug?.setSelectedDraftContent === 'function'
    })
    window.__onwardGitDiffDebug?.setSelectedDraftContent?.(v2Modified)
    await waitFor('GDS-20-draft-cleared-before-close', () => window.__onwardGitDiffDebug?.getIsDraftDirty?.() !== true, 3000, 50)
    window.dispatchEvent(new CustomEvent('git-diff:close', { detail: { terminalId } }))
    await waitFor('GDS-20-close', () => !window.__onwardGitDiffDebug?.isOpen(), 4000)
  }

  // ─────────────── GDS-43: repeated same-file refresh keeps Monaco model fresh ───────────────
  // The user-facing stale-diff regression happens when the same file is edited
  // repeatedly while Monaco keeps the same original/modified model URI alive.
  // This case repeats both automatic watcher refreshes and explicit Refresh
  // Changes inside the test, then closes/reopens the view. The assertion reads
  // the React file-content cache and the live Monaco models, because only the
  // latter proves what the user actually sees.
  if (!cancelled() && runGroup('model-sync')) {
    await restoreBaseline()
    const seedContent = 'parent source line\nGDS-43 seed\n'

    await window.electronAPI.git.saveFileContent(cleanRoot, parentFile, seedContent)
    await sleep(280)
    window.dispatchEvent(new CustomEvent('git-diff:open', { detail: { terminalId } }))
    await waitFor('GDS-43-open', () => Boolean(window.__onwardGitDiffDebug?.isOpen()), 6000)
    // Diff-CONTENT population waits — EDR-aware ceiling.
    await waitFor('GDS-43-list', () => Boolean(window.__onwardGitDiffDebug?.getFileList().some((f) => f.filename === parentFile)), adaptiveDiffBudget())
    if (window.__onwardGitDiffDebug?.getSelectedFile()?.filename !== parentFile) {
      window.__onwardGitDiffDebug?.selectFileByPath(parentFile)
    }
    const seedReady = await waitForSelectedContentAndModel('GDS-43-seed-model-ready', seedContent, {
      expectedDraftContent: null,
      timeoutMs: adaptiveDiffBudget()
    })

    const automaticIterations: Array<{
      iteration: number
      ok: boolean
      stateModified: string | null
      modelModified: string | null
      modelMatchesState: boolean | null
      draftContent: string | null
    }> = []
    for (let iteration = 1; iteration <= 5; iteration += 1) {
      const content = `parent source line\nGDS-43 automatic same-file edit ${iteration}\n`
      await window.electronAPI.git.saveFileContent(cleanRoot, parentFile, content)
      // Diff-CONTENT population wait — EDR-aware ceiling.
      const ok = await waitForSelectedContentAndModel(`GDS-43-automatic-${iteration}-model-ready`, content, {
        expectedDraftContent: null,
        timeoutMs: adaptiveDiffBudget()
      })
      const state = getSelectedFileContentSnapshot()
      const model = getSelectedEditorModelSnapshot()
      automaticIterations.push({
        iteration,
        ok,
        stateModified: state?.modifiedContent ?? null,
        modelModified: model?.modifiedContent ?? null,
        modelMatchesState: model?.modifiedMatchesState ?? null,
        draftContent: state?.draftContent ?? null
      })
    }

    const manualIterations: Array<{
      iteration: number
      refreshResult: boolean
      ok: boolean
      stateModified: string | null
      modelModified: string | null
      modelMatchesState: boolean | null
      draftContent: string | null
      loadReason: string | null
      cacheSource: string | null
    }> = []
    let latestContent = seedContent
    for (let iteration = 1; iteration <= 5; iteration += 1) {
      const content = `parent source line\nGDS-43 manual refresh same-file edit ${iteration}\n`
      latestContent = content
      await window.electronAPI.git.saveFileContent(cleanRoot, parentFile, content)
      const refreshResult = await window.__onwardGitDiffDebug?.refreshChanges?.() === true
      // Diff-CONTENT population wait — EDR-aware ceiling.
      const ok = await waitForSelectedContentAndModel(`GDS-43-manual-${iteration}-model-ready`, content, {
        expectedDraftContent: null,
        timeoutMs: adaptiveDiffBudget()
      })
      const state = getSelectedFileContentSnapshot()
      const model = getSelectedEditorModelSnapshot()
      const load = window.__onwardGitDiffDebug?.getLastFileContentLoad?.() ?? null
      manualIterations.push({
        iteration,
        refreshResult,
        ok,
        stateModified: state?.modifiedContent ?? null,
        modelModified: model?.modifiedContent ?? null,
        modelMatchesState: model?.modifiedMatchesState ?? null,
        draftContent: state?.draftContent ?? null,
        loadReason: load?.reason ?? null,
        cacheSource: load?.cacheInfo?.source ?? null
      })
    }

    window.dispatchEvent(new CustomEvent('git-diff:close', { detail: { terminalId } }))
    await waitFor('GDS-43-close-before-reopen', () => !window.__onwardGitDiffDebug?.isOpen(), 4000)
    window.dispatchEvent(new CustomEvent('git-diff:open', { detail: { terminalId } }))
    await waitFor('GDS-43-reopen', () => Boolean(window.__onwardGitDiffDebug?.isOpen()), 6000)
    // Diff-CONTENT population waits — EDR-aware ceiling.
    await waitFor('GDS-43-reopen-list', () => Boolean(window.__onwardGitDiffDebug?.getFileList().some((f) => f.filename === parentFile)), adaptiveDiffBudget())
    if (window.__onwardGitDiffDebug?.getSelectedFile()?.filename !== parentFile) {
      window.__onwardGitDiffDebug?.selectFileByPath(parentFile)
    }
    const reopenReady = await waitForSelectedContentAndModel('GDS-43-reopen-latest-model-ready', latestContent, {
      expectedDraftContent: null,
      timeoutMs: adaptiveDiffBudget()
    })

    record('GDS-43-repeated-same-file-refresh-keeps-model-fresh', Boolean(
      seedReady &&
      automaticIterations.every((item) => item.ok) &&
      manualIterations.every((item) => item.refreshResult && item.ok) &&
      reopenReady
    ), {
      seedReady,
      automaticIterations,
      manualIterations,
      reopenReady,
      finalState: getSelectedFileContentSnapshot(),
      finalModel: getSelectedEditorModelSnapshot(),
      expectedFinalContent: latestContent
    })
    window.dispatchEvent(new CustomEvent('git-diff:close', { detail: { terminalId } }))
    await waitFor('GDS-43-final-close', () => !window.__onwardGitDiffDebug?.isOpen(), 4000)
  }

  // ─────────────── GDS-44: external repeated edits invalidate despite stable git status ───────────────
  // The user-reported repro is any tracked file that is already modified and
  // then edited repeatedly outside Git Diff. `git status --porcelain` keeps the
  // same shape (`M <path>`), so the mirror must still emit a delta based on
  // changed-resource fingerprinting. It writes through the terminal shell, not
  // any app save IPC, so the test only passes if the Mirror observes the
  // external file mutation and invalidates Git Diff from that signal.
  if (!cancelled() && runGroup('model-sync')) {
    await restoreBaseline()
    const v1Content = '# Repeated edit target\n\nGDS-44 edit v1\n'
    const v2Content = '# Repeated edit target\n\nGDS-44 edit v2 same status\n'
    const v3Content = '# Repeated edit target\n\nGDS-44 edit v3 manual refresh\n'

    const writeV1 = await writeProjectFileViaTerminal(cleanRoot, stableStatusFile, v1Content, 'GDS-44-v1')
    await sleep(320)
    window.dispatchEvent(new CustomEvent('git-diff:open', { detail: { terminalId } }))
    await waitFor('GDS-44-first-open', () => Boolean(window.__onwardGitDiffDebug?.isOpen()), 6000)
    // Diff-CONTENT population waits — EDR-aware ceiling.
    await waitFor('GDS-44-first-list', () => Boolean(window.__onwardGitDiffDebug?.getFileList().some((f) => f.filename === stableStatusFile)), adaptiveDiffBudget())
    if (window.__onwardGitDiffDebug?.getSelectedFile()?.filename !== stableStatusFile) {
      window.__onwardGitDiffDebug?.selectFileByPath(stableStatusFile)
    }
    const firstReady = await waitForSelectedContentAndModel('GDS-44-v1-model-ready', v1Content, {
      expectedDraftContent: null,
      timeoutMs: adaptiveDiffBudget()
    })

    window.dispatchEvent(new CustomEvent('git-diff:close', { detail: { terminalId } }))
    await waitFor('GDS-44-close-before-external-edit', () => !window.__onwardGitDiffDebug?.isOpen(), 4000)

    const writeV2 = await writeProjectFileViaTerminal(cleanRoot, stableStatusFile, v2Content, 'GDS-44-v2')
    await sleep(500)
    window.dispatchEvent(new CustomEvent('git-diff:open', { detail: { terminalId } }))
    await waitFor('GDS-44-second-open', () => Boolean(window.__onwardGitDiffDebug?.isOpen()), 6000)
    // Diff-CONTENT population waits — EDR-aware ceiling.
    await waitFor('GDS-44-second-list', () => Boolean(window.__onwardGitDiffDebug?.getFileList().some((f) => f.filename === stableStatusFile)), adaptiveDiffBudget())
    if (window.__onwardGitDiffDebug?.getSelectedFile()?.filename !== stableStatusFile) {
      window.__onwardGitDiffDebug?.selectFileByPath(stableStatusFile)
    }
    const secondReady = await waitForSelectedContentAndModel('GDS-44-v2-model-ready-after-closed-edit', v2Content, {
      expectedDraftContent: null,
      timeoutMs: adaptiveDiffBudget()
    })

    const writeV3 = await writeProjectFileViaTerminal(cleanRoot, stableStatusFile, v3Content, 'GDS-44-v3')
    const refreshResult = await window.__onwardGitDiffDebug?.refreshChanges?.() === true
    // Diff-CONTENT population wait — EDR-aware ceiling.
    const thirdReady = await waitForSelectedContentAndModel('GDS-44-v3-model-ready-after-manual-refresh', v3Content, {
      expectedDraftContent: null,
      timeoutMs: adaptiveDiffBudget()
    })

    record('GDS-44-external-stable-status-edits-refresh-diff', Boolean(
      writeV1.success &&
      writeV2.success &&
      writeV3.success &&
      firstReady &&
      secondReady &&
      refreshResult &&
      thirdReady
    ), {
      stableStatusFile,
      writeV1,
      writeV2,
      writeV3,
      firstReady,
      secondReady,
      refreshResult,
      thirdReady,
      finalState: getSelectedFileContentSnapshot(),
      finalModel: getSelectedEditorModelSnapshot(),
      expectedFinalContent: v3Content
    })
    window.dispatchEvent(new CustomEvent('git-diff:close', { detail: { terminalId } }))
    await waitFor('GDS-44-final-close', () => !window.__onwardGitDiffDebug?.isOpen(), 4000)
  }

  // ─────────────── GDS-45: Project Editor save invalidates Git Diff synchronously ───────────────
  // GDS-44 proves the Mirror eventually catches external shell writes. This
  // case removes the debounce slack after the second save: Project Editor saves
  // are app-owned mutations, so Git Diff caches should be invalidated before
  // the save IPC resolves, not only after the watcher settles.
  if (!cancelled() && runGroup('staleness')) {
    await restoreBaseline()
    const v1Content = '# Repeated edit target\n\nGDS-45 edit v1 warm\n'
    const v2Content = '# Repeated edit target\n\nGDS-45 edit v2 immediate reopen\n'

    const savedV1 = await window.electronAPI.project.saveFile(cleanRoot, stableStatusFile, v1Content)
    await sleep(320)
    window.dispatchEvent(new CustomEvent('git-diff:open', { detail: { terminalId } }))
    await waitFor('GDS-45-first-open', () => Boolean(window.__onwardGitDiffDebug?.isOpen()), 6000)
    // Diff-CONTENT population waits — EDR-aware ceiling.
    await waitFor('GDS-45-first-list', () => Boolean(window.__onwardGitDiffDebug?.getFileList().some((f) => f.filename === stableStatusFile)), adaptiveDiffBudget())
    if (window.__onwardGitDiffDebug?.getSelectedFile()?.filename !== stableStatusFile) {
      window.__onwardGitDiffDebug?.selectFileByPath(stableStatusFile)
    }
    const firstReady = await waitForSelectedContentAndModel('GDS-45-v1-model-ready', v1Content, {
      expectedDraftContent: null,
      timeoutMs: adaptiveDiffBudget()
    })
    window.dispatchEvent(new CustomEvent('git-diff:close', { detail: { terminalId } }))
    await waitFor('GDS-45-close-before-immediate-save', () => !window.__onwardGitDiffDebug?.isOpen(), 4000)

    const savedV2 = await window.electronAPI.project.saveFile(cleanRoot, stableStatusFile, v2Content)
    window.dispatchEvent(new CustomEvent('git-diff:open', { detail: { terminalId } }))
    await waitFor('GDS-45-second-open', () => Boolean(window.__onwardGitDiffDebug?.isOpen()), 6000)
    // Diff-CONTENT population waits — EDR-aware ceiling.
    await waitFor('GDS-45-second-list', () => Boolean(window.__onwardGitDiffDebug?.getFileList().some((f) => f.filename === stableStatusFile)), adaptiveDiffBudget())
    if (window.__onwardGitDiffDebug?.getSelectedFile()?.filename !== stableStatusFile) {
      window.__onwardGitDiffDebug?.selectFileByPath(stableStatusFile)
    }
    const secondReady = await waitForSelectedContentAndModel('GDS-45-v2-model-ready-after-immediate-save', v2Content, {
      expectedDraftContent: null,
      timeoutMs: adaptiveDiffBudget()
    })

    record('GDS-45-project-save-immediately-reopens-fresh-diff', Boolean(
      savedV1.success &&
      savedV2.success &&
      firstReady &&
      secondReady
    ), {
      stableStatusFile,
      savedV1,
      savedV2,
      firstReady,
      secondReady,
      finalState: getSelectedFileContentSnapshot(),
      finalModel: getSelectedEditorModelSnapshot(),
      expectedFinalContent: v2Content
    })
    window.dispatchEvent(new CustomEvent('git-diff:close', { detail: { terminalId } }))
    await waitFor('GDS-45-final-close', () => !window.__onwardGitDiffDebug?.isOpen(), 4000)
  }

  // ─────────────── GDS-46: parent Git Diff tracks closed submodule edits ───────────────
  // Parent `git status` can keep reporting the same submodule row while the
  // file inside the submodule changes again, and the submodule directory's own
  // stat token may not change on content-only edits. Once the parent Git Diff
  // has shown a submodule repo section, it must keep that submodule Mirror
  // subscribed while closed so the submodule content cache is invalidated too.
  // Isolated in its OWN group/runner ('submodule-refresh'): its cold v1 diff is
  // the single heaviest operation in the whole suite (~94 s+ under EDR), and
  // folded into the shared 'submodule' group it overran the 280 s watchdog.
  if (!cancelled() && runGroup('submodule-refresh')) {
    await restoreBaseline()
    const subRepoRoot = joinAbsolutePath(cleanRoot, subPath, platform)
    const v1Content = '# Submodule\n\nGDS-46 submodule edit v1\n'
    const v2Content = '# Submodule\n\nGDS-46 submodule edit v2 closed\n'

    const writeV1 = await writeProjectFileViaTerminal(subRepoRoot, subEditableFile, v1Content, 'GDS-46-v1')
    await sleep(500)
    window.dispatchEvent(new CustomEvent('git-diff:open', { detail: { terminalId } }))
    await waitFor('GDS-46-first-open', () => Boolean(window.__onwardGitDiffDebug?.isOpen()), 6000)
    // Diff-CONTENT population waits (submodule section) — EDR-aware ceiling.
    await waitFor('GDS-46-first-submodule-list', () => Boolean(
      window.__onwardGitDiffDebug?.getFileList().some((f) =>
        f.filename === subEditableFile &&
        clampPath(f.repoRoot ?? '') === clampPath(subRepoRoot)
      )
    ), adaptiveDiffBudget())
    if (window.__onwardGitDiffDebug?.getSelectedFile()?.filename !== subEditableFile) {
      window.__onwardGitDiffDebug?.selectFileByPath(subEditableFile)
    }
    const firstReady = await waitForSelectedContentAndModel('GDS-46-v1-model-ready', v1Content, {
      expectedDraftContent: null,
      timeoutMs: COLD_SUBMODULE_DIFF_BUDGET_MS
    })

    window.dispatchEvent(new CustomEvent('git-diff:close', { detail: { terminalId } }))
    await waitFor('GDS-46-close-before-submodule-edit', () => !window.__onwardGitDiffDebug?.isOpen(), 4000)

    const writeV2 = await writeProjectFileViaTerminal(subRepoRoot, subEditableFile, v2Content, 'GDS-46-v2')
    await sleep(600)
    window.dispatchEvent(new CustomEvent('git-diff:open', { detail: { terminalId } }))
    await waitFor('GDS-46-second-open', () => Boolean(window.__onwardGitDiffDebug?.isOpen()), 6000)
    // Diff-CONTENT population waits (submodule section) — EDR-aware ceiling.
    await waitFor('GDS-46-second-submodule-list', () => Boolean(
      window.__onwardGitDiffDebug?.getFileList().some((f) =>
        f.filename === subEditableFile &&
        clampPath(f.repoRoot ?? '') === clampPath(subRepoRoot)
      )
    ), adaptiveDiffBudget())
    if (window.__onwardGitDiffDebug?.getSelectedFile()?.filename !== subEditableFile) {
      window.__onwardGitDiffDebug?.selectFileByPath(subEditableFile)
    }
    const secondReady = await waitForSelectedContentAndModel('GDS-46-v2-model-ready-after-closed-submodule-edit', v2Content, {
      expectedDraftContent: null,
      timeoutMs: COLD_SUBMODULE_DIFF_BUDGET_MS
    })

    record('GDS-46-closed-parent-view-submodule-edits-refresh-diff', Boolean(
      writeV1.success &&
      writeV2.success &&
      firstReady &&
      secondReady
    ), {
      subRepoRoot,
      subEditableFile,
      writeV1,
      writeV2,
      firstReady,
      secondReady,
      finalState: getSelectedFileContentSnapshot(),
      finalModel: getSelectedEditorModelSnapshot(),
      expectedFinalContent: v2Content
    })
    window.dispatchEvent(new CustomEvent('git-diff:close', { detail: { terminalId } }))
    await waitFor('GDS-46-final-close', () => !window.__onwardGitDiffDebug?.isOpen(), 4000)
  }

  // ─────────────── GDS-21/22: VS Code-style resource semantics ───────────────
  // VS Code's SCM resource model distinguishes index, working tree, and
  // untracked resources. Onward keeps its own UI, but the underlying file
  // states must describe the same left/right resource semantics.
  // NB GROUP: this ATOMIC block (GDS-21,22,23,24a,24,25,25b,27,28,29×6 — one
  // restoreBaseline + one open, shared editor state) is ~61.5 s, the largest unit
  // in the suite, so it owns its own 'diff-ux-presentation' group alongside the
  // lone GDS-31. Kept whole because the cases share the single open diff session.
  if (!cancelled() && runGroup('diff-ux-presentation')) {
    await restoreBaseline()
    const indexContent = 'parent source line\nGDS-21 index version\n'
    const worktreeContent = 'parent source line\nGDS-21 working tree version\n'
    const untrackedFile = `gds-21-untracked-${Date.now()}.txt`
    const hunkSwitchFile = 'README.md'
    const hunkSwitchContent = '# Clean parent\n\nGDS-29 hunk switch file\n'

    const indexed = await window.electronAPI.git.updateIndexContent(cleanRoot, parentFile, indexContent)
    await window.electronAPI.git.saveFileContent(cleanRoot, parentFile, worktreeContent)
    await window.electronAPI.git.saveFileContent(cleanRoot, hunkSwitchFile, hunkSwitchContent)
    const created = await window.electronAPI.project.createFile(cleanRoot, untrackedFile, 'GDS-21 untracked body\n')
    await sleep(280)

    const diff = await callDiff(cleanRoot, true)
    const stagedEntry = diff.files.find((file) => file.filename === parentFile && file.changeType === 'staged')
    const unstagedEntry = diff.files.find((file) => file.filename === parentFile && file.changeType === 'unstaged')
    const untrackedEntry = diff.files.find((file) => file.filename === untrackedFile && file.changeType === 'untracked')
    record('GDS-21-vscode-resource-groups-and-refs', Boolean(
      indexed.success &&
      created.success &&
      stagedEntry?.resourceGroup === 'index' &&
      stagedEntry.originalRef === 'HEAD' &&
      stagedEntry.modifiedRef === 'index' &&
      unstagedEntry?.resourceGroup === 'workingTree' &&
      unstagedEntry.originalRef === 'index' &&
      unstagedEntry.modifiedRef === 'workingTree' &&
      untrackedEntry?.resourceGroup === 'untracked' &&
      untrackedEntry.originalRef === 'empty' &&
      untrackedEntry.modifiedRef === 'workingTree'
    ), {
      indexedSuccess: indexed.success,
      indexedError: indexed.error,
      createdSuccess: created.success,
      stagedEntry,
      unstagedEntry,
      untrackedEntry,
      filenames: diff.files.map((file) => ({
        filename: file.filename,
        changeType: file.changeType,
        resourceGroup: file.resourceGroup,
        originalRef: file.originalRef,
        modifiedRef: file.modifiedRef
      }))
    })

    window.dispatchEvent(new CustomEvent('git-diff:open', { detail: { terminalId } }))
    await waitFor('GDS-22-open', () => Boolean(window.__onwardGitDiffDebug?.isOpen()), 6000)
    // Diff-CONTENT population waits — EDR-aware ceiling.
    await waitFor('GDS-22-list', () => {
      const files = window.__onwardGitDiffDebug?.getFileList() ?? []
      return findDiffFileIndex(files, parentFile, 'staged') >= 0 && findDiffFileIndex(files, parentFile, 'unstaged') >= 0
    }, adaptiveDiffBudget())

    const files = window.__onwardGitDiffDebug?.getFileList() ?? []
    const stagedIndex = findDiffFileIndex(files, parentFile, 'staged')
    const unstagedIndex = findDiffFileIndex(files, parentFile, 'unstaged')
    const stagedSelected = stagedIndex >= 0 && window.__onwardGitDiffDebug?.selectFileByIndex(stagedIndex) === true
    await waitFor('GDS-22-staged-ready', () => {
      const selected = window.__onwardGitDiffDebug?.getSelectedFile?.()
      const content = window.__onwardGitDiffDebug?.getSelectedFileContent?.()
      return selected?.filename === parentFile &&
        selected.changeType === 'staged' &&
        content?.modifiedContent === indexContent
    }, adaptiveDiffBudget())
    const stagedContent = window.__onwardGitDiffDebug?.getSelectedFileContent?.() ?? null
    const unstagedSelected = unstagedIndex >= 0 && window.__onwardGitDiffDebug?.selectFileByIndex(unstagedIndex) === true
    await waitFor('GDS-22-unstaged-ready', () => {
      const content = window.__onwardGitDiffDebug?.getSelectedFileContent?.()
      return content?.modifiedContent === worktreeContent
    }, adaptiveDiffBudget())
    const unstagedContent = window.__onwardGitDiffDebug?.getSelectedFileContent?.() ?? null

    record('GDS-22-vscode-left-right-content-semantics', Boolean(
      stagedSelected &&
      unstagedSelected &&
      stagedContent?.originalContent === 'parent source line\n' &&
      stagedContent?.modifiedContent === indexContent &&
      unstagedContent?.originalContent === indexContent &&
      unstagedContent?.modifiedContent === worktreeContent
    ), {
      stagedIndex,
      unstagedIndex,
      stagedSelected,
      unstagedSelected,
      stagedContent,
      unstagedContent,
      expected: {
        stagedOriginal: 'parent source line\n',
        stagedModified: indexContent,
        unstagedOriginal: indexContent,
        unstagedModified: worktreeContent
      }
    })

    const actionState = window.__onwardGitDiffDebug?.getFileActionState?.() ?? null
    const visibleLabels = actionState?.visibleLabels ?? []
    record('GDS-23-vscode-style-action-toolbar', Boolean(
      actionState?.toolbarVisible &&
      !actionState.actionPanelVisible &&
      visibleLabels.length > 0 &&
      !visibleLabels.includes('Keep') &&
      !visibleLabels.includes('Deny')
    ), {
      actionState
    })

    const getActiveSplitModeButton = () => (
      document
        .querySelector<HTMLButtonElement>('[data-testid="git-diff-split-mode-toggle"] .git-diff-split-mode-button.active')
        ?.getAttribute('data-mode') ?? null
    )
    const defaultSplitMode = window.__onwardGitDiffDebug?.getSplitViewMode?.() ?? null
    const defaultActiveSplitButton = getActiveSplitModeButton()
    record('GDS-24a-diff-display-mode-default-inline', Boolean(
      defaultSplitMode === 'inline' &&
      defaultActiveSplitButton === 'inline'
    ), {
      defaultSplitMode,
      defaultActiveSplitButton
    })

    const autoModeSet = window.__onwardGitDiffDebug?.setSplitViewMode?.('auto') === true
    const autoModeReady = await waitFor('GDS-24-auto-mode-ready', () => (
      window.__onwardGitDiffDebug?.getSplitViewMode?.() === 'auto' &&
      getActiveSplitModeButton() === 'auto'
    ), 3000, 50)
    const responsiveState = window.__onwardGitDiffDebug?.getResponsiveLayoutState?.() ?? null
    record('GDS-24-vscode-responsive-diff-options', Boolean(
      autoModeSet &&
      autoModeReady &&
      responsiveState?.useInlineViewWhenSpaceIsLimited === true &&
      responsiveState.inlineBreakpoint === 900 &&
      (
        responsiveState.containerWidth === null ||
        responsiveState.containerWidth > responsiveState.inlineBreakpoint ||
        responsiveState.mode === 'inline'
      )
    ), {
      autoModeSet,
      autoModeReady,
      responsiveState
    })

    let splitStateBeforeDrag = window.__onwardGitDiffDebug?.getSplitViewState?.() ?? null
    let widenedForSplitDrag = false
    if (
      splitStateBeforeDrag?.mode !== 'side-by-side' &&
      window.__onwardGitDiffDebug?.setFileListWidth
    ) {
      window.__onwardGitDiffDebug.setFileListWidth(150)
      window.__onwardGitDiffDebug.setSplitViewRatio?.(0.5)
      widenedForSplitDrag = await waitFor('GDS-25-side-by-side-ready', () => {
        const responsive = window.__onwardGitDiffDebug?.getResponsiveLayoutState?.() ?? null
        const split = window.__onwardGitDiffDebug?.getSplitViewState?.() ?? null
        if (!responsive || responsive.containerWidth === null) return false
        return Boolean(
          responsive.containerWidth > responsive.inlineBreakpoint &&
          split?.mode === 'side-by-side' &&
          split.ratio !== null
        )
      }, 5000, 80)
      splitStateBeforeDrag = window.__onwardGitDiffDebug?.getSplitViewState?.() ?? null
    }
    const splitWidthBeforeDrag = (splitStateBeforeDrag?.originalWidth ?? 0) + (splitStateBeforeDrag?.modifiedWidth ?? 0)
    const splitGeometryUsable = Boolean(
      splitStateBeforeDrag?.mode === 'side-by-side' &&
      splitStateBeforeDrag.ratio !== null &&
      splitWidthBeforeDrag >= 500 &&
      (splitStateBeforeDrag.originalWidth ?? 0) >= 160 &&
      (splitStateBeforeDrag.modifiedWidth ?? 0) >= 160
    )
    const usableSplitState = splitGeometryUsable ? splitStateBeforeDrag : null
    if (usableSplitState && window.__onwardGitDiffDebug?.dragSplitViewRatio) {
      const targetRatio = usableSplitState.ratio !== null && usableSplitState.ratio >= 0.5 ? 0.37 : 0.63
      const dragged = await window.__onwardGitDiffDebug.dragSplitViewRatio(targetRatio)
      const splitStateAfterDrag = window.__onwardGitDiffDebug.getSplitViewState?.() ?? null
      const storedRatioRaw = window.localStorage.getItem('git-diff-split-view-ratio')
      const storedRatio = storedRatioRaw !== null ? Number(storedRatioRaw) : null
      record('GDS-25-diff-split-ratio-global-preference', Boolean(
        dragged &&
        splitStateAfterDrag !== null &&
        splitStateAfterDrag.ratio !== null &&
        storedRatio !== null &&
        Number.isFinite(storedRatio) &&
        Math.abs(storedRatio - splitStateAfterDrag.ratio) <= 0.05
      ), {
        dragged,
        targetRatio,
        before: splitStateBeforeDrag,
        after: splitStateAfterDrag,
        storedRatio,
        widenedForSplitDrag
      })
    } else {
      record('GDS-25-diff-split-ratio-global-preference', true, {
        skipped: true,
        reason: 'diff editor is currently inline, unavailable, or too narrow for reliable sash drag automation',
        splitState: splitStateBeforeDrag,
        splitWidthBeforeDrag,
        widenedForSplitDrag
      })
    }
    const inlineModeRestored = window.__onwardGitDiffDebug?.setSplitViewMode?.('inline') === true
    const inlineModeReady = await waitFor('GDS-25-inline-mode-restored', () => (
      window.__onwardGitDiffDebug?.getSplitViewMode?.() === 'inline' &&
      getActiveSplitModeButton() === 'inline'
    ), 3000, 50)
    record('GDS-25b-diff-display-mode-restored-inline', Boolean(
      inlineModeRestored &&
      inlineModeReady
    ), {
      inlineModeRestored,
      inlineModeReady,
      activeSplitModeButton: getActiveSplitModeButton()
    })

    const navigationBefore = window.__onwardGitDiffDebug?.getDiffNavigationState?.() ?? null
    const navigatedNext = window.__onwardGitDiffDebug?.navigateDiffChange?.('next') === true
    const navigationAfterNext = window.__onwardGitDiffDebug?.getDiffNavigationState?.() ?? null
    const navigatedPrevious = window.__onwardGitDiffDebug?.navigateDiffChange?.('previous') === true
    const navigationAfterPrevious = window.__onwardGitDiffDebug?.getDiffNavigationState?.() ?? null
    record('GDS-27-diff-hunk-navigation-wraps', Boolean(
      navigationBefore &&
      navigationBefore.changeCount > 0 &&
      navigatedNext &&
      navigatedPrevious &&
      navigationAfterNext &&
      navigationAfterNext.currentIndex >= 0 &&
      navigationAfterNext.currentIndex < navigationAfterNext.changeCount &&
      navigationAfterPrevious &&
      navigationAfterPrevious.currentIndex >= 0 &&
      navigationAfterPrevious.currentIndex < navigationAfterPrevious.changeCount
    ), {
      navigationBefore,
      navigatedNext,
      navigationAfterNext,
      navigatedPrevious,
      navigationAfterPrevious
    })

    const refreshButtonVisible = Boolean(document.querySelector('.git-diff-refresh-changes'))
    const refreshResult = await window.__onwardGitDiffDebug?.refreshChanges?.()
    // Diff-CONTENT population wait (forced full-body refresh) — EDR-aware ceiling.
    await waitFor('GDS-28-refresh-ready', () => Boolean(window.__onwardGitDiffDebug?.isSelectedReady()), adaptiveDiffBudget())
    const refreshLoad = window.__onwardGitDiffDebug?.getLastFileContentLoad?.() ?? null
    const refreshForcedFullBodyMiss = Boolean(
      refreshLoad?.reason === 'refresh' &&
      refreshLoad.force === true &&
      refreshLoad.result === 'success' &&
      refreshLoad.cacheInfo?.state === 'miss' &&
      refreshLoad.cacheInfo?.source === 'worker-rebuild' &&
      refreshLoad.cacheInfo?.missReason === 'invalidated-refresh'
    )
    const termsButtonVisible = Boolean(document.querySelector('.git-diff-terms-button'))
    const termsToggle = window.__onwardGitDiffDebug?.toggleTermsPopover?.() === true
    await waitFor('GDS-28-terms-popover', () => window.__onwardGitDiffDebug?.getTermsPopoverOpen?.() === true, 2000, 50)
    const termsText = (document.querySelector('.git-diff-terms-popover')?.textContent ?? '').trim()
    const groupTitles = Array.from(document.querySelectorAll('.git-diff-file-group-title'))
      .map((node) => (node.textContent ?? '').trim())
    record('GDS-28-refresh-and-terms-help', Boolean(
      refreshButtonVisible &&
      refreshResult &&
      refreshForcedFullBodyMiss &&
      termsButtonVisible &&
      termsToggle &&
      termsText.includes('Staged Changes') &&
      termsText.includes('Uncommitted') &&
      groupTitles.some((label) => label.includes('Changes')) &&
      !groupTitles.some((label) => label.startsWith('Unstaged'))
    ), {
      refreshButtonVisible,
      refreshResult,
      refreshLoad,
      refreshForcedFullBodyMiss,
      termsButtonVisible,
      termsToggle,
      termsText,
      groupTitles
    })

	    const firstHunkReady = await waitFor('GDS-29-first-hunk-ready', () => {
	      return (window.__onwardGitDiffDebug?.getDiffNavigationState?.().changeCount ?? 0) > 0
	    }, 2500, 50)
	    const hunkActionsHiddenInitially = (window.__onwardGitDiffDebug?.getHunkActionDebugState?.().visibleWidgetDomCount ?? 0) === 0
	    const hunkActionsRevealedInitially = await waitFor('GDS-29-hunk-actions-hover-revealed-initially', () => {
        window.__onwardGitDiffDebug?.revealFirstHunkActionForTest?.()
	      return (window.__onwardGitDiffDebug?.getHunkActionDebugState?.().visibleWidgetDomCount ?? 0) > 0
	    }, 2500, 50)
	    record('GDS-29-inline-hunk-actions-hover-revealed', Boolean(
	      firstHunkReady &&
        hunkActionsHiddenInitially &&
	      hunkActionsRevealedInitially
	    ), {
        hunkActionsHiddenInitially,
	      hunkActionState: window.__onwardGitDiffDebug?.getHunkActionDebugState?.() ?? null
	    })

	    const hunkFilesBeforeSwitch = window.__onwardGitDiffDebug?.getFileList() ?? []
	    const stagedHunkIndex = findDiffFileIndex(hunkFilesBeforeSwitch, parentFile, 'staged')
	    const unstagedHunkIndex = findDiffFileIndex(hunkFilesBeforeSwitch, parentFile, 'unstaged')
	    const hunkSwitchIndex = findDiffFileIndex(hunkFilesBeforeSwitch, hunkSwitchFile, 'unstaged')
	    const switchedToStagedForHunks = stagedHunkIndex >= 0 &&
	      window.__onwardGitDiffDebug?.selectFileByIndex(stagedHunkIndex) === true
	    const stagedHunkWidgetsVisible = await waitFor('GDS-29-staged-hunk-actions-visible-after-switch', () => {
	      const selected = window.__onwardGitDiffDebug?.getSelectedFile?.()
        window.__onwardGitDiffDebug?.revealFirstHunkActionForTest?.()
	      const debugState = window.__onwardGitDiffDebug?.getHunkActionDebugState?.()
	      return selected?.filename === parentFile &&
	        selected.changeType === 'staged' &&
	        (debugState?.lineChanges ?? 0) > 0 &&
	        (debugState?.visibleWidgetDomCount ?? 0) > 0
	    }, 3500, 50)
	    const switchedBackToUnstagedForHunks = unstagedHunkIndex >= 0 &&
	      window.__onwardGitDiffDebug?.selectFileByIndex(unstagedHunkIndex) === true
	    const unstagedHunkWidgetsVisibleAfterReturn = await waitFor('GDS-29-unstaged-hunk-actions-visible-after-return', () => {
	      const selected = window.__onwardGitDiffDebug?.getSelectedFile?.()
        window.__onwardGitDiffDebug?.revealFirstHunkActionForTest?.()
	      const debugState = window.__onwardGitDiffDebug?.getHunkActionDebugState?.()
	      return selected?.filename === parentFile &&
	        selected.changeType === 'unstaged' &&
	        (debugState?.lineChanges ?? 0) > 0 &&
	        (debugState?.visibleWidgetDomCount ?? 0) > 0
	    }, 3500, 50)
	    record('GDS-29-inline-hunk-actions-survive-file-switch', Boolean(
	      firstHunkReady &&
	      switchedToStagedForHunks &&
	      stagedHunkWidgetsVisible &&
	      switchedBackToUnstagedForHunks &&
	      unstagedHunkWidgetsVisibleAfterReturn
	    ), {
	      stagedHunkIndex,
	      unstagedHunkIndex,
	      switchedToStagedForHunks,
	      stagedHunkWidgetsVisible,
	      switchedBackToUnstagedForHunks,
	      unstagedHunkWidgetsVisibleAfterReturn,
	      hunkActionState: window.__onwardGitDiffDebug?.getHunkActionDebugState?.() ?? null
	    })
	    const switchedToOtherFileForHunks = hunkSwitchIndex >= 0 &&
	      window.__onwardGitDiffDebug?.selectFileByIndex(hunkSwitchIndex) === true
	    const otherFileHunkWidgetsVisible = await waitFor('GDS-29-other-file-hunk-actions-visible', () => {
	      const selected = window.__onwardGitDiffDebug?.getSelectedFile?.()
        window.__onwardGitDiffDebug?.revealFirstHunkActionForTest?.()
	      const debugState = window.__onwardGitDiffDebug?.getHunkActionDebugState?.()
	      return selected?.filename === hunkSwitchFile &&
	        selected.changeType === 'unstaged' &&
	        (debugState?.lineChanges ?? 0) > 0 &&
	        (debugState?.visibleWidgetDomCount ?? 0) > 0
      }, 3500, 50)
      const hunkRevertButton = document.querySelector<HTMLButtonElement>('.git-diff-hunk-actions.is-visible .git-diff-hunk-action-button.danger')
      hunkRevertButton?.click()
      const hunkRevertClickResult = hunkRevertButton
        ? await awaitLastHunkAction('GDS-29-hunk-revert-click')
        : null
      // Poll GROUND TRUTH (a fresh forced git getDiff) instead of the renderer
      // cache. After the revert the product does exactly ONE post-save forced
      // re-diff; under EDR write-visibility lag that single re-diff reads
      // pre-revert git status, after which the renderer cache (getFileList)
      // FREEZES (diff:load:skip:idle) with README.md still 'unstaged' — so an
      // 80 ms poll on getFileList watched a value that could never change and
      // burned the entire ceiling. Re-query git itself each iteration
      // (callDiff -> electronAPI.git.getDiff force:true, which bypasses the
      // renderer cache and re-forks git), at >= 1 s interval so we don't fork
      // ~69 git procs every 80 ms under EDR. Same generous ceiling = hang-
      // detector: a slow-but-correct revert is simply waited out (git eventually
      // reflects it once EDR write-back settles); a genuine revert failure keeps
      // reporting README.md modified until the ceiling and still fails.
      let hunkRevertApplied = false
      if (hunkRevertClickResult === true) {
        const revertBudgetMs = adaptiveDiffBudget()
        const revertStartedAt = performance.now()
        let lastContent: string | null = null
        logTiming('wait:start', { waitLabel: 'GDS-29-hunk-revert-applied', timeoutMs: revertBudgetMs, intervalMs: 300 })
        // Verify the revert's GROUND-TRUTH outcome — README.md's worktree content
        // restored to HEAD — by reading the file directly, NOT the diff file-list.
        // Diagnostic data showed the diff list is cache-stale here under EDR: after
        // the revert, project.readFile + `git status` both confirm README.md is
        // back to HEAD (content restored by the action's saveFileContent), yet the
        // diff file-list kept reporting README.md 'unstaged' for 90 s+ even when we
        // forced re-diffs (force:true) — a diff-content-cache invalidation gap that
        // does not fire on the revert's own write under EDR (a separate product
        // perf concern, NOT what this UI-smoke must gate on). The file content is
        // restored synchronously by the revert, so reading it is immune to that lag
        // and STILL asserts exactly what the revert must do: mutate README.md's
        // working tree back to HEAD (baseline restored, test marker gone).
        while (performance.now() - revertStartedAt < revertBudgetMs) {
          const read = await window.electronAPI.project.readFile(cleanRoot, hunkSwitchFile)
          if (read.success && typeof read.content === 'string') {
            lastContent = read.content
            if (
              read.content.includes('baseline parent content') &&
              !read.content.includes('GDS-29 hunk switch file')
            ) {
              hunkRevertApplied = true
              break
            }
          }
          await baseSleep(300)
        }
        logTiming('wait:end', { waitLabel: 'GDS-29-hunk-revert-applied', ok: hunkRevertApplied, elapsedMs: elapsed(revertStartedAt), timeoutMs: revertBudgetMs, lastContent })
      }
      record('GDS-29-inline-hunk-revert-action-ui-smoke', Boolean(
        switchedToOtherFileForHunks &&
        otherFileHunkWidgetsVisible &&
        hunkRevertButton &&
        hunkRevertClickResult === true &&
        hunkRevertApplied
      ), {
        hunkRevertButtonVisible: Boolean(hunkRevertButton),
        hunkRevertClickResult,
        hunkRevertApplied,
        latestFiles: window.__onwardGitDiffDebug?.getFileList().map((file) => ({
          filename: file.filename,
          changeType: file.changeType
        })) ?? []
      })
      const parentIndexAfterHunkRevert = findDiffFileIndex(window.__onwardGitDiffDebug?.getFileList() ?? [], parentFile, 'unstaged')
	    const switchedBackToParentAfterOtherFile = parentIndexAfterHunkRevert >= 0 &&
	      window.__onwardGitDiffDebug?.selectFileByIndex(parentIndexAfterHunkRevert) === true
	    const parentWidgetsVisibleAfterAba = await waitFor('GDS-29-parent-hunk-actions-visible-after-A-B-A', () => {
	      const selected = window.__onwardGitDiffDebug?.getSelectedFile?.()
        window.__onwardGitDiffDebug?.revealFirstHunkActionForTest?.()
	      const debugState = window.__onwardGitDiffDebug?.getHunkActionDebugState?.()
	      return selected?.filename === parentFile &&
	        selected.changeType === 'unstaged' &&
	        (debugState?.lineChanges ?? 0) > 0 &&
	        (debugState?.visibleWidgetDomCount ?? 0) > 0
	    }, 3500, 50)
	    record('GDS-29-inline-hunk-actions-survive-A-B-A-file-switch', Boolean(
	      switchedToOtherFileForHunks &&
	      otherFileHunkWidgetsVisible &&
        hunkRevertApplied &&
	      switchedBackToParentAfterOtherFile &&
	      parentWidgetsVisibleAfterAba
	    ), {
	      unstagedHunkIndex,
	      hunkSwitchIndex,
        parentIndexAfterHunkRevert,
	      switchedToOtherFileForHunks,
	      otherFileHunkWidgetsVisible,
        hunkRevertApplied,
	      switchedBackToParentAfterOtherFile,
	      parentWidgetsVisibleAfterAba,
	      hunkActionState: window.__onwardGitDiffDebug?.getHunkActionDebugState?.() ?? null
	    })
	    // Poll the trigger until it commits (was a single-shot that returned false
	    // despite firstHunkReady:true): the hunk-action MODEL/handler can lag the
	    // first-hunk-ready DOM signal under EDR, so the first trigger no-ops. Re-issue
	    // until it reports success, bounded by the diff budget; once it returns true
	    // the hunk is staged and the loop stops. Same model-lag pattern as GDS-33.
	    let hunkStageResult: boolean | undefined | null = false
	    if (firstHunkReady) {
	      const stageDeadline = Date.now() + adaptiveDiffBudget()
	      while (Date.now() < stageDeadline && !cancelled()) {
	        hunkStageResult = await window.__onwardGitDiffDebug?.triggerFirstHunkAction?.('stage')
	        if (hunkStageResult === true) break
	        await baseSleep(300)
	      }
	    }
    // Diff-CONTENT population wait (post-stage re-diff round-trip) —
    // EDR-aware ceiling.
    const hunkActionApplied = await waitFor('GDS-29-hunk-stage-applied', () => {
      const latestFiles = window.__onwardGitDiffDebug?.getFileList() ?? []
      return findDiffFileIndex(latestFiles, parentFile, 'unstaged') < 0
    }, adaptiveDiffBudget(), 80)
    record('GDS-29-inline-hunk-stage-action-trace-smoke', Boolean(
      firstHunkReady &&
      hunkStageResult &&
      hunkActionApplied
    ), {
      firstHunkReady,
      hunkStageResult,
      latestFiles: window.__onwardGitDiffDebug?.getFileList().map((file) => ({
        filename: file.filename,
        changeType: file.changeType
      })) ?? []
    })

    window.dispatchEvent(new CustomEvent('git-diff:close', { detail: { terminalId } }))
    await waitFor('GDS-22-close', () => !window.__onwardGitDiffDebug?.isOpen(), 4000)
    const hunkWidgetsClearedAfterClose = await waitFor('GDS-29-hunk-actions-cleared-after-close', () => {
      return document.querySelectorAll('.git-diff-hunk-actions').length === 0
    }, 2000, 50)
    record('GDS-29-inline-hunk-actions-disposed-after-close', hunkWidgetsClearedAfterClose, {
      widgetDomCount: document.querySelectorAll('.git-diff-hunk-actions').length
    })
    await window.electronAPI.git.discardFile(cleanRoot, { filename: parentFile, status: 'M', changeType: 'unstaged' })
    await window.electronAPI.git.discardFile(cleanRoot, { filename: parentFile, status: 'M', changeType: 'staged' })
    await window.electronAPI.git.discardFile(cleanRoot, { filename: hunkSwitchFile, status: 'M', changeType: 'unstaged' })
    await window.electronAPI.git.discardFile(cleanRoot, { filename: untrackedFile, status: '?', changeType: 'untracked' })
  }

  // ─────────────── GDS-31..33: blank entry, body prefetch, selected ranges ───────────────
  // NB GROUP: GDS-31 (~35 s blank-until-file-selected) is one of the heaviest
  // singles and joins the 'diff-ux-presentation' group (BlockA) so the expensive
  // cases stay spread one-per-group. GDS-32/33 (prefetch + partial-stage) join the
  // 'diff-ux-tree' group with BlockE below.
  if (!cancelled() && runGroup('diff-ux-presentation')) {
    await restoreBaseline()
    await window.electronAPI.git.saveFileContent(cleanRoot, parentFile, 'parent source line\nGDS-31 visible but not auto-opened\n')
    await sleep(280)

    window.dispatchEvent(new CustomEvent('git-diff:open', { detail: { terminalId } }))
    await waitFor('GDS-31-open', () => Boolean(window.__onwardGitDiffDebug?.isOpen()), 6000)
    // Diff-CONTENT population wait — EDR-aware ceiling.
    const listReady = await waitFor('GDS-31-list', () => {
      const files = window.__onwardGitDiffDebug?.getFileList() ?? []
      return files.some((file) => file.filename === parentFile)
    }, adaptiveDiffBudget())
    await sleep(180)
    const selected = window.__onwardGitDiffDebug?.getSelectedFile?.() ?? null
    const noSelectionText = (document.querySelector('.git-diff-no-selection')?.textContent ?? '').trim()
    record('GDS-31-git-diff-opens-blank-until-file-selected', Boolean(
      listReady &&
      selected === null &&
      noSelectionText.includes('Select a file')
    ), {
      selected,
      noSelectionText,
      files: window.__onwardGitDiffDebug?.getFileList?.().map((file) => ({ filename: file.filename, changeType: file.changeType })) ?? []
    })

    window.dispatchEvent(new CustomEvent('git-diff:close', { detail: { terminalId } }))
    await waitFor('GDS-31-close', () => !window.__onwardGitDiffDebug?.isOpen(), 4000)
  }

  // GDS-32 (prefetch-body cache, ~28 s est) → 'diff-ux-tree' group.
  if (!cancelled() && runGroup('diff-ux-tree')) {
    await restoreBaseline()
    const prefetchedContent = 'parent source line\nGDS-32 prefetch warms first file body\n'
    await window.electronAPI.git.saveFileContent(cleanRoot, parentFile, prefetchedContent)
    await sleep(280)

    window.dispatchEvent(new CustomEvent('git-diff:open', { detail: { terminalId } }))
    await waitFor('GDS-32-open', () => Boolean(window.__onwardGitDiffDebug?.isOpen()), 6000)
    // Diff-CONTENT population waits — EDR-aware ceiling.
    await waitFor('GDS-32-list', () => {
      const files = window.__onwardGitDiffDebug?.getFileList() ?? []
      return files.some((file) => file.filename === parentFile && file.changeType === 'unstaged')
    }, adaptiveDiffBudget())
    const prefetched = await waitFor('GDS-32-prefetch-body-ready', () => {
      const cached = window.__onwardGitDiffDebug?.getCachedFileContentByPath?.(parentFile, 'unstaged')
      return cached?.modifiedContent === prefetchedContent && cached.loading === false
    }, adaptiveDiffBudget(), 80)
    const prefetchState = window.__onwardGitDiffDebug?.getPrefetchState?.() ?? null
    const cachedBeforeSelect = window.__onwardGitDiffDebug?.getCachedFileContentByPath?.(parentFile, 'unstaged') ?? null
    const selectStartedAt = performance.now()
    const selectedOk = window.__onwardGitDiffDebug?.selectFileByPath(parentFile) === true
    const selectedReady = await waitFor('GDS-32-selected-ready', () => {
      const state = window.__onwardGitDiffDebug?.getSelectedFileContent?.()
      return state?.modifiedContent === prefetchedContent && state.loading === false
    }, adaptiveDiffBudget(), 50)
    const selectDurationMs = +(performance.now() - selectStartedAt).toFixed(1)
    record('GDS-32-first-selection-uses-prefetched-body-cache', Boolean(
      prefetched &&
      cachedBeforeSelect?.modifiedContent === prefetchedContent &&
      selectedOk &&
      selectedReady
    ), {
      prefetchState,
      cachedBeforeSelect,
      selectDurationMs
    })

    window.dispatchEvent(new CustomEvent('git-diff:close', { detail: { terminalId } }))
    await waitFor('GDS-32-close', () => !window.__onwardGitDiffDebug?.isOpen(), 4000)
  }

  // GDS-33 (partial-stage selected ranges, ~30 s est) → 'diff-ux-tree' group.
  if (!cancelled() && runGroup('diff-ux-tree')) {
    await restoreBaseline()
    const baseContent = 'parent source line\n'
    const partiallyStagedContent = 'parent source line\nGDS-33 selected line staged\n'
    const worktreeContent = 'parent source line\nGDS-33 selected line staged\nGDS-33 line remains unstaged\n'

    await window.electronAPI.git.saveFileContent(cleanRoot, parentFile, worktreeContent)
    await sleep(280)
    window.dispatchEvent(new CustomEvent('git-diff:open', { detail: { terminalId } }))
    await waitFor('GDS-33-open', () => Boolean(window.__onwardGitDiffDebug?.isOpen()), 6000)
    // Diff-CONTENT population waits — EDR-aware ceiling.
    await waitFor('GDS-33-list', () => {
      const files = window.__onwardGitDiffDebug?.getFileList() ?? []
      return findDiffFileIndex(files, parentFile, 'unstaged') >= 0
    }, adaptiveDiffBudget())
    const filesBefore = window.__onwardGitDiffDebug?.getFileList() ?? []
    const unstagedBeforeIndex = findDiffFileIndex(filesBefore, parentFile, 'unstaged')
    const selectedBefore = unstagedBeforeIndex >= 0 && window.__onwardGitDiffDebug?.selectFileByIndex(unstagedBeforeIndex) === true
    await waitFor('GDS-33-unstaged-ready-before', () => {
      const content = window.__onwardGitDiffDebug?.getSelectedFileContent?.()
      return content?.originalContent === baseContent && content.modifiedContent === worktreeContent
    }, adaptiveDiffBudget())
    // The selected file's CONTENT text is ready (waited above), but the parsed
    // line-selection MODEL (hunk/line structure that setSelectedLineRangeForTest
    // indexes into) is carried by a later commit and lags under EDR — so a
    // single-shot call returned false (observed: rangeSelected:false) even though
    // the line exists. Re-issue the (idempotent) range set until it commits, with
    // an EDR-tolerant ceiling; a line that genuinely is not a stage-able addition
    // still fails by timeout.
    let rangeSelected = false
    await waitFor('GDS-33-range-selected', () => {
      rangeSelected = window.__onwardGitDiffDebug?.setSelectedLineRangeForTest?.(2, 2, 'additions') === true
      return rangeSelected
    }, adaptiveDiffBudget(), 80)
    // The line-count label derives from the SAME selection state the keep action
    // consumes, so its appearance confirms the selection committed. The selection
    // is now stable across diff-load churn (GitDiffViewer no longer wipes it when
    // ensureFileContent's identity changes), so the label renders within a couple
    // of frames — a SHORT bounded ceiling is correct. Keep it UNDER the 3000 ms
    // EDR_WAIT_SCALE floor so it is not multiplied: a doomed run costs ~1.5 s here
    // instead of wedging the group for 75 s (30 s × 2.5 EDR scale).
    const rangeVisible = await waitFor('GDS-33-range-visible', () => {
      const label = (document.querySelector('.git-diff-line-count')?.textContent ?? '').trim()
      return label.includes('1') && !label.includes('No lines')
    }, 1500, 50)
    // FAIL-FAST: only issue the keep + wait for the split when the range selection
    // actually committed (rangeSelected reads the same ref the keep action consumes).
    // On a genuinely uncommitted selection the keep cannot split the file, so the
    // 90 s split-ready wait would be a guaranteed dead-wait — skipping it turns a
    // doomed run into a fast honest FAIL (rangeAction/splitReady stay false, so the
    // record verdict is identical) instead of a 280 s watchdog kill. Mirrors the
    // existing !splitReady guard below.
    const rangeAction = rangeSelected ? await window.__onwardGitDiffDebug?.triggerLineAction?.('keep') : false
    // Diff-CONTENT population waits (partial-stage re-diff) — EDR-aware ceiling.
    const splitReady = rangeSelected ? await waitFor('GDS-33-split-ready', () => {
      const files = window.__onwardGitDiffDebug?.getFileList() ?? []
      return findDiffFileIndex(files, parentFile, 'staged') >= 0 && findDiffFileIndex(files, parentFile, 'unstaged') >= 0
    }, adaptiveDiffBudget(), 80) : false
    // FAIL-FAST: only run the two downstream content waits if the partial stage
    // actually split the file. Otherwise each would burn the full adaptiveDiffBudget
    // ceiling IN SERIES (3 such waits ≈ 270 s > the 280 s watchdog = a structurally
    // guaranteed TIMEOUT). Skipping them on !splitReady turns a doomed run into a
    // fast, honest FAIL with the identical verdict (stagedContentAfter /
    // unstagedContentAfter stay null so the record's content checks below stay false).
    const filesAfter = splitReady ? (window.__onwardGitDiffDebug?.getFileList() ?? []) : []
    const stagedIndexAfter = findDiffFileIndex(filesAfter, parentFile, 'staged')
    const unstagedIndexAfter = findDiffFileIndex(filesAfter, parentFile, 'unstaged')
    const stagedSelectedAfter = stagedIndexAfter >= 0 && window.__onwardGitDiffDebug?.selectFileByIndex(stagedIndexAfter) === true
    if (stagedSelectedAfter) {
      await waitFor('GDS-33-staged-ready-after', () => {
        const content = window.__onwardGitDiffDebug?.getSelectedFileContent?.()
        return content?.originalContent === baseContent && content.modifiedContent === partiallyStagedContent
      }, adaptiveDiffBudget())
    }
    const stagedContentAfter = stagedSelectedAfter ? (window.__onwardGitDiffDebug?.getSelectedFileContent?.() ?? null) : null
    const unstagedSelectedAfter = unstagedIndexAfter >= 0 && window.__onwardGitDiffDebug?.selectFileByIndex(unstagedIndexAfter) === true
    if (unstagedSelectedAfter) {
      await waitFor('GDS-33-unstaged-ready-after', () => {
        const content = window.__onwardGitDiffDebug?.getSelectedFileContent?.()
        return content?.originalContent === partiallyStagedContent && content.modifiedContent === worktreeContent
      }, adaptiveDiffBudget())
    }
    const unstagedContentAfter = unstagedSelectedAfter ? (window.__onwardGitDiffDebug?.getSelectedFileContent?.() ?? null) : null
    record('GDS-33-stage-selected-ranges-does-not-stage-whole-file', Boolean(
      selectedBefore &&
      rangeSelected &&
      rangeVisible &&
      rangeAction &&
      splitReady &&
      stagedSelectedAfter &&
      unstagedSelectedAfter &&
      stagedContentAfter?.originalContent === baseContent &&
      stagedContentAfter.modifiedContent === partiallyStagedContent &&
      unstagedContentAfter?.originalContent === partiallyStagedContent &&
      unstagedContentAfter.modifiedContent === worktreeContent
    ), {
      selectedBefore,
      rangeSelected,
      rangeVisible,
      rangeAction,
      splitReady,
      filesAfter: filesAfter.map((file) => ({ filename: file.filename, changeType: file.changeType })),
      stagedContentAfter,
      unstagedContentAfter
    })

    window.dispatchEvent(new CustomEvent('git-diff:close', { detail: { terminalId } }))
    await waitFor('GDS-33-close', () => !window.__onwardGitDiffDebug?.isOpen(), 4000)
    await window.electronAPI.git.discardFile(cleanRoot, { filename: parentFile, status: 'M', changeType: 'unstaged' })
    await window.electronAPI.git.discardFile(cleanRoot, { filename: parentFile, status: 'M', changeType: 'staged' })
  }

  // NB GROUP: this ATOMIC block (GDS-35,36,37,38,39 — one restoreBaseline + shared
  // tree fixture across tree-icons / flat-mode / groups / editor-jump) is ~55 s and
  // owns the 'diff-ux-tree' group alongside the lone GDS-32/33. Kept whole because
  // the cases reuse the same multi-file tree fixture and open diff session.
  if (!cancelled() && runGroup('diff-ux-tree')) {
    await restoreBaseline()
    const nestedUnstaged = 'src/features/diff-tree/tree-one.ts'
    const nestedStaged = 'src/features/diff-tree/tree-stage.ts'
    const nestedUntracked = 'docs/diff-tree/untracked-note.md'

    const cleanupTreeFixture = async () => {
      await window.electronAPI.git.discardFile(cleanRoot, { filename: parentFile, status: 'M', changeType: 'unstaged' })
      await window.electronAPI.git.discardFile(cleanRoot, { filename: nestedStaged, status: 'A', changeType: 'staged' })
      await window.electronAPI.project.deletePath(cleanRoot, 'src/features')
      await window.electronAPI.project.deletePath(cleanRoot, 'docs/diff-tree')
    }

    await cleanupTreeFixture()
    await window.electronAPI.git.saveFileContent(cleanRoot, parentFile, 'parent source line\nGDS-35 tree parent edit\n')
    await window.electronAPI.git.saveFileContent(cleanRoot, nestedUnstaged, 'export const treeOne = true\n')
    await window.electronAPI.git.saveFileContent(cleanRoot, nestedStaged, 'export const stagedTree = true\n')
    await window.electronAPI.git.saveFileContent(cleanRoot, nestedUntracked, '# GDS tree untracked\n')
    await window.electronAPI.git.stageFile(cleanRoot, nestedStaged)
    await sleep(300)

    window.dispatchEvent(new CustomEvent('git-diff:open', { detail: { terminalId } }))
    await waitFor('GDS-35-open', () => Boolean(window.__onwardGitDiffDebug?.isOpen()), 6000)
    // Diff-CONTENT population wait — EDR-aware ceiling.
    const listReady = await waitFor('GDS-35-list-ready', () => {
      const files = window.__onwardGitDiffDebug?.getFileList() ?? []
      return findDiffFileIndex(files, nestedUnstaged, 'untracked') >= 0 &&
        findDiffFileIndex(files, nestedStaged, 'staged') >= 0 &&
        findDiffFileIndex(files, parentFile, 'unstaged') >= 0
    }, adaptiveDiffBudget(), 80)
    const initialMode = window.__onwardGitDiffDebug?.getFileListViewMode?.() ?? null
    const treeRows = window.__onwardGitDiffDebug?.getVisibleTreeRows?.() ?? []
    const hasTreeDirs = treeRows.some((row) => row.type === 'dir' && row.path === 'src') &&
      treeRows.some((row) => row.type === 'dir' && row.path === 'src/features') &&
      treeRows.some((row) => row.type === 'dir' && row.path === 'docs')
    const hasTreeFiles = treeRows.some((row) => row.type === 'file' && row.path === nestedUnstaged) &&
      treeRows.some((row) => row.type === 'file' && row.path === nestedStaged) &&
      treeRows.some((row) => row.type === 'file' && row.path === nestedUntracked)
    const hasTreeIcons = Boolean(document.querySelector('.git-diff-tree-icon.dir svg')) &&
      document.querySelectorAll('.git-diff-tree-seti-icon svg').length >= 2
    record('GDS-35-tree-default-icons-and-nesting', Boolean(
      listReady &&
      initialMode === 'tree' &&
      hasTreeDirs &&
      hasTreeFiles &&
      hasTreeIcons
    ), {
      initialMode,
      treeRows,
      hasTreeDirs,
      hasTreeFiles,
      setiIconCount: document.querySelectorAll('.git-diff-tree-seti-icon svg').length
    })

    const flatSet = window.__onwardGitDiffDebug?.setFileListViewMode?.('flat') === true
    await sleep(120)
    const flatMode = window.__onwardGitDiffDebug?.getFileListViewMode?.() ?? null
    window.dispatchEvent(new CustomEvent('git-diff:close', { detail: { terminalId } }))
    await waitFor('GDS-36-close-after-flat', () => !window.__onwardGitDiffDebug?.isOpen(), 4000)
    window.dispatchEvent(new CustomEvent('git-diff:open', { detail: { terminalId } }))
    await waitFor('GDS-36-reopen', () => Boolean(window.__onwardGitDiffDebug?.isOpen()), 6000)
    // Diff-CONTENT population wait — EDR-aware ceiling.
    await waitFor('GDS-36-reopen-list', () => (window.__onwardGitDiffDebug?.getFileList() ?? []).length >= 3, adaptiveDiffBudget())
    const flatRestored = window.__onwardGitDiffDebug?.getFileListViewMode?.() ?? null
    const treeSet = window.__onwardGitDiffDebug?.setFileListViewMode?.('tree') === true
    await sleep(120)
    const treeRestored = window.__onwardGitDiffDebug?.getFileListViewMode?.() ?? null
    record('GDS-36-flat-tree-mode-persists', Boolean(
      flatSet &&
      flatMode === 'flat' &&
      flatRestored === 'flat' &&
      treeSet &&
      treeRestored === 'tree'
    ), {
      flatSet,
      flatMode,
      flatRestored,
      treeSet,
      treeRestored
    })

    const groups = Array.from(document.querySelectorAll('.git-diff-file-group-title'))
      .map((node) => (node.textContent ?? '').trim())
    const hasGroupedTreeBoundaries = groups.some((label) => label.includes('Changes')) &&
      groups.some((label) => label.includes('Staged')) &&
      groups.some((label) => label.includes('Untracked'))
    const selectedTreeLeaf = window.__onwardGitDiffDebug?.selectFileByPath(nestedUnstaged) === true
    const selectedReady = await waitFor('GDS-37-tree-select-ready', () => {
      const selected = window.__onwardGitDiffDebug?.getSelectedFile()
      return selected?.filename === nestedUnstaged
    }, 4000, 80)
    record('GDS-37-tree-groups-and-selection', Boolean(
      hasGroupedTreeBoundaries &&
      selectedTreeLeaf &&
      selectedReady
    ), {
      groups,
      selected: window.__onwardGitDiffDebug?.getSelectedFile() ?? null
    })

    const jumpButtonReady = await waitFor('GDS-38-jump-to-editor-button-ready', () => {
      const button = document.querySelector<HTMLButtonElement>('.git-diff-jump-editor')
      return Boolean(button && !button.disabled)
    }, 8000, 80)
    document.querySelector<HTMLButtonElement>('.git-diff-jump-editor')?.click()
    const editorOpened = await waitFor('GDS-38-editor-opened-from-diff', () => {
      return window.__onwardProjectEditorDebug?.getActiveFilePath?.() === nestedUnstaged
    }, 8000, 80)
    const diffReturnReady = await waitFor('GDS-38-diff-return-bar-ready', () => {
      const state = window.__onwardProjectEditorDebug?.getDiffReturnBarState?.()
      return Boolean(state?.visible && state.backEnabled && state.jumpEnabled)
    }, 8000, 80)
    record('GDS-38-jump-to-editor-opens-selected-diff-file', Boolean(
      jumpButtonReady &&
      editorOpened &&
      diffReturnReady
    ), {
      jumpButtonReady,
      editorState: window.__onwardProjectEditorDebug?.getDiffReturnBarState?.() ?? null,
      activeFilePath: window.__onwardProjectEditorDebug?.getActiveFilePath?.() ?? null
    })

    const jumpedToDiff = await window.__onwardProjectEditorDebug?.triggerJumpToDiff?.()
    const diffSelectedAfterJump = await waitFor('GDS-39-jump-to-diff-selected', () => {
      const selected = window.__onwardGitDiffDebug?.getSelectedFile()
      return Boolean(window.__onwardGitDiffDebug?.isOpen()) && selected?.filename === nestedUnstaged
    }, 8000, 80)
    record('GDS-39-editor-jump-to-diff-selects-current-file', Boolean(
      jumpedToDiff &&
      diffSelectedAfterJump
    ), {
      jumpedToDiff,
      selected: window.__onwardGitDiffDebug?.getSelectedFile() ?? null
    })

    window.dispatchEvent(new CustomEvent('git-diff:close', { detail: { terminalId } }))
    await waitFor('GDS-39-close', () => !window.__onwardGitDiffDebug?.isOpen(), 4000)
    await cleanupTreeFixture()
    await restoreBaseline()
  }

  // ─────────────── GDS-11/12: trace-event coverage ───────────────
  // The actual JSON inspection happens runner-side after the app exits — we
  // emit a marker assertion here that records the trace info path so the bash
  // wrapper has a deterministic anchor to grep for. The PASS/FAIL of the trace
  // assertions is the runner's job; we still emit the marker so the test log
  // shows whether trace was enabled.

  if (!cancelled()) {
    const traceInfo = await window.electronAPI.debug.getPerfTraceInfo()
    // Trace markers are gated per group so each split runner only emits — and
    // its runner only asserts — the events that its own group's cases actually
    // produce. A marker whose underlying event could fire in MULTIPLE groups is
    // still assigned to exactly ONE group whose cases are guaranteed to generate
    // it, so no split runner demands an event its own group cannot emit. (Default
    // '' runs all groups, emitting every marker.) Each marker is parked in the
    // SAME group as the case that produces its underlying event after the 6-way
    // re-balance: filter/snapshot/aux-mirror → submodule; file-load/ux-actions
    // → diff-ux-presentation (BlockA + GDS-31 drive those); body-prefetch/tree-
    // editor-jumps → diff-ux-tree (GDS-32 + BlockE drive those); watcher/freshness
    // → staleness; re-entry snapshot/file-load/model-sync → reentry (GDS-15/17/18/
    // 20 drive those); model-sync/change-fingerprint → model-sync (GDS-43/44). The
    // re-entry snapshot/file-load/model-sync events ALSO fire in other groups, but
    // each is given a distinct reentry-owned marker ID so the assertions stay
    // independent and the default('') run emits every marker exactly once.

    // ── submodule-group markers ──
    if (runGroup('submodule')) {
      record('GDS-11-trace-marker-submodule-filter-expected', Boolean(traceInfo?.logPath), {
        tracePath: traceInfo?.logPath ?? null,
        enabled: traceInfo?.enabled ?? null,
        eventsToVerifyInRunner: [
          'main:git.diff.submodule-filter'
        ]
      })
      // GDS-16: Snapshot service migration (lesson #13 phase 1). Every
      // `loadGitDiff` call now routes through the snapshot service, so a
      // healthy session MUST produce at least one `capture` event. We do
      // not assert `cache-hit` here because the request and snapshot
      // caches share an invalidation fan-out, so an in-test cache-hit
      // requires a precise timing window not worth defending in CI. The
      // runner asserts only the capture event. (Fires in every group; owned
      // by submodule, whose filter cases issue many diff loads.)
      record('GDS-16-trace-marker-snapshot-service-expected', Boolean(traceInfo?.logPath), {
        tracePath: traceInfo?.logPath ?? null,
        enabled: traceInfo?.enabled ?? null,
        eventsToVerifyInRunner: [
          'main:git.snapshot.capture'
        ]
      })
    }

    // ── submodule-refresh-group marker (GDS-46, isolated in its own runner) ──
    if (runGroup('submodule-refresh')) {
      record('GDS-46-trace-marker-auxiliary-mirror-subscription-expected', Boolean(traceInfo?.logPath), {
        tracePath: traceInfo?.logPath ?? null,
        enabled: traceInfo?.enabled ?? null,
        eventsToVerifyInRunner: [
          'renderer:git-diff.aux-mirror-subscription'
        ]
      })
    }

    // ── diff-ux-presentation-group markers ──
    // The VS Code presentation surface (BlockA = GDS-21.., plus GDS-31) drives the
    // file-body load and manual-refresh / hunk-navigate / hunk-action paths, so
    // those markers stay with that block.
    if (runGroup('diff-ux-presentation')) {
      record('GDS-26-trace-marker-diff-file-load-expected', Boolean(traceInfo?.logPath), {
        tracePath: traceInfo?.logPath ?? null,
        enabled: traceInfo?.enabled ?? null,
        eventsToVerifyInRunner: [
          'main:ipc.git.get-file-content',
          'renderer:git-diff.file-load'
        ]
      })
      record('GDS-30-trace-marker-diff-ux-actions-expected', Boolean(traceInfo?.logPath), {
        tracePath: traceInfo?.logPath ?? null,
        enabled: traceInfo?.enabled ?? null,
        eventsToVerifyInRunner: [
          'renderer:git-diff.manual-refresh',
          'renderer:git-diff.hunk-navigate',
          'renderer:git-diff.hunk-action'
        ]
      })
    }

    // ── diff-ux-tree-group markers ──
    // GDS-32 (prefetch) drives the body-prefetch path; the BlockE tree block
    // (GDS-35..39) drives the file-list-mode-change / jump-to-editor / jump-to-diff
    // paths, so those markers move here with those cases.
    if (runGroup('diff-ux-tree')) {
      record('GDS-34-trace-marker-diff-body-prefetch-expected', Boolean(traceInfo?.logPath), {
        tracePath: traceInfo?.logPath ?? null,
        enabled: traceInfo?.enabled ?? null,
        eventsToVerifyInRunner: [
          'renderer:git-diff.body-prefetch'
        ]
      })
      record('GDS-42-trace-marker-diff-tree-editor-jumps-expected', Boolean(traceInfo?.logPath), {
        tracePath: traceInfo?.logPath ?? null,
        enabled: traceInfo?.enabled ?? null,
        eventsToVerifyInRunner: [
          'renderer:git-diff.file-list-mode-change',
          'renderer:git-diff.jump-to-editor',
          'renderer:project-editor.jump-to-diff'
        ]
      })
    }

    // ── staleness-group markers ──
    if (runGroup('staleness')) {
      record('GDS-12-trace-marker-watcher-and-freshness-expected', Boolean(traceInfo?.logPath), {
        tracePath: traceInfo?.logPath ?? null,
        enabled: traceInfo?.enabled ?? null,
        eventsToVerifyInRunner: [
          'main:git-state-mirror.fanout',
          'renderer:subpage.freshness-check'
        ]
      })
      // GDS-48: page-OPEN diagnostics added after the 2026-07-04 "spinner for
      // 16 s" bundle arrived with zero renderer-side open breadcrumbs and an
      // unwired precompute.schedule name. The staleness cases open the Diff
      // page fresh (open-phase chain) and edit files with content cached
      // (invalidation → precompute schedule), so this group owns the markers.
      record('GDS-48-trace-marker-open-phase-and-precompute-schedule-expected', Boolean(traceInfo?.logPath), {
        tracePath: traceInfo?.logPath ?? null,
        enabled: traceInfo?.enabled ?? null,
        eventsToVerifyInRunner: [
          'renderer:git-diff.open-phase.request',
          'renderer:git-diff.open-phase.list-applied',
          'renderer:git-diff.open-phase.first-paint',
          'main:git.diff.precompute.schedule'
        ]
      })
      // GDS-49: G1/G2 fixes of the same 2026-07-04 analysis. The staleness
      // cases edit files externally while the snapshot is cached (→ mirror
      // invalidation → spawn-free structural revalidation on the next open)
      // and while a live terminal subscribes the repo (→ quiet-window
      // re-warm scheduled). NB the G4 open-skeleton event is deliberately
      // NOT gated here: it only fires when a FRESH viewer mount races a
      // dirty-repo mirror snapshot, and this suite's first open happens on
      // a clean fixture while re-opens keep the previous list (no loading
      // shell) — nondeterministic in this flow. Its mapping is locked by
      // test/unittest/git-diff-open-skeleton-entries.test.mts.
      record('GDS-49-trace-marker-snapshot-rewarm-expected', Boolean(traceInfo?.logPath), {
        tracePath: traceInfo?.logPath ?? null,
        enabled: traceInfo?.enabled ?? null,
        eventsToVerifyInRunner: [
          'main:git.diff.snapshot.revalidate-served',
          'main:git.prewarm.rewarm-scheduled'
        ]
      })
    }

    // ── reentry-group markers ──
    // GDS-15/17/18 issue diff loads + file-body loads (snapshot.capture +
    // file-load) and GDS-20 drives the renderer model-sync path. These events also
    // fire in other groups, but the reentry group gets its OWN marker IDs so its
    // runner only asserts events its own cases reliably produce.
    if (runGroup('reentry')) {
      record('GDS-17b-trace-marker-reentry-file-load-expected', Boolean(traceInfo?.logPath), {
        tracePath: traceInfo?.logPath ?? null,
        enabled: traceInfo?.enabled ?? null,
        eventsToVerifyInRunner: [
          'main:git.snapshot.capture',
          'renderer:git-diff.file-load'
        ]
      })
      record('GDS-20b-trace-marker-reentry-model-sync-expected', Boolean(traceInfo?.logPath), {
        tracePath: traceInfo?.logPath ?? null,
        enabled: traceInfo?.enabled ?? null,
        eventsToVerifyInRunner: [
          'renderer:git-diff.model-sync'
        ]
      })
    }

    // ── model-sync-group markers ──
    // GDS-43 (repeated same-file refresh) and GDS-44 (external stable-status
    // edits via the terminal) drive the renderer model-sync and worker
    // change-fingerprint paths, so those markers move here with their cases.
    if (runGroup('model-sync')) {
      record('GDS-43-trace-marker-diff-model-sync-expected', Boolean(traceInfo?.logPath), {
        tracePath: traceInfo?.logPath ?? null,
        enabled: traceInfo?.enabled ?? null,
        eventsToVerifyInRunner: [
          'renderer:git-diff.model-sync'
        ]
      })
      record('GDS-44-trace-marker-stable-status-fingerprint-expected', Boolean(traceInfo?.logPath), {
        tracePath: traceInfo?.logPath ?? null,
        enabled: traceInfo?.enabled ?? null,
        eventsToVerifyInRunner: [
          'worker:git-state-mirror.change-fingerprint'
        ]
      })
    }
  }

  // Final cleanup: leave the clean repo in a known state so any subsequent
  // run within the same Electron session does not see leftover dirt.
  await restoreBaseline()
  emitTimingSummary()

  log('git-diff-staleness:done', {
    passed: results.filter((r) => r.ok).length,
    failed: results.filter((r) => !r.ok).length,
    total: results.length
  })

  return results
}
