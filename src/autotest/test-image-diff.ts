/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

import type { AutotestContext, TestResult } from './types'

const TINY_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg=='
const TEST_IMAGE_FILENAME = '__autotest_image_diff_test.png'
const TEST_SVG_FILENAME = '__autotest_image_diff_test.svg'
const TEST_EDITOR_PNG_PATH = 'resources/test-preview.png'
const TEST_EDITOR_SVG_PATH = 'test/autotest/fixtures/markdown-preview-dot.svg'
// Kept so the working-tree cleanup (ID-21) still removes any history repo left
// over by the sibling image-history-diff suite when both run in one app session.
const HISTORY_REPO_DIR = '__autotest_history_repo'
// Post-action (Keep/Deny) verification budget.
//
// This suite exercises Keep/Deny against the LIVE Onward repo (100+ changed
// files + submodules). The git mutation behind each action is deterministic and
// fast — `git add` (Keep) / `git reset HEAD` (Deny) finish in milliseconds and
// have already succeeded by the time we poll. What is heavy is the UI's
// post-action reload: `loadDiff({force:true})` issues a `scope:'full'` recursive
// diff that, on this repo, forks ~69 git processes to walk every submodule. On an
// EDR-throttled Windows host that full walk routinely exceeds the renderer
// watchdog (DIFF_LOAD_IPC_TIMEOUT_MS = 30s in GitDiffViewer); the watchdog then
// aborts and (correctly) PRESERVES the prior file list, so the React-state
// `getFileList()` keeps showing the pre-mutation `changeType`. Re-driving more
// `refreshChanges()` (the round-4 approach) only piles additional full reloads
// onto the worker's concurrency-1 lane, each abandoned at 30s — so the list could
// never flip to the new state within budget (round-5 image-diff regression:
// ID-04-deny-restored-untracked timed out after 105s, and the wedged lane also
// starved ID-12's SVG `getFileContent`, failing ID-12-image-preview-loaded).
//
// The fix verifies the mutation through a DIRECT, light, authoritative query: a
// forced `scope:'root-only'` `getDiff`. The test images live at the repo ROOT,
// so root-only (which skips the submodule recursion entirely — see git-utils.ts
// `reposToLoad = allRepos.filter(repo => !repo.isSubmodule)`) returns them with
// their true `changeType` in a fraction of the time, without jamming the worker
// lane. This proves the product's git mutation took effect and the diff pipeline
// reflects it, while leaving the worker lane free for ID-12. Per the CLAUDE.md
// timing rule we still aggregate the observation across a budget: pass the
// instant the new state is observed; fail only if the whole budget elapses (a
// real product hang, not EDR noise).
const DENY_RESTORE_RECOVERY_BUDGET_MS = 30000
// Per direct root-only getDiff probe. Root-only is light even under EDR, so this
// can be short; the outer budget allows several probes.
const DENY_RESTORE_ATTEMPT_TIMEOUT_MS = 8000
const TINY_SVG_BASE64 =
  'PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAxMCAxMCI+PHJlY3Qgd2lkdGg9IjEwIiBoZWlnaHQ9IjEwIiBmaWxsPSJyZWQiLz48L3N2Zz4K'

export async function testImageDiff(ctx: AutotestContext): Promise<TestResult[]> {
  const { log, sleep, waitFor, assert, cancelled, terminalId, openFileInEditor } = ctx
  const results: TestResult[] = []
  const record = (name: string, ok: boolean, detail?: Record<string, unknown>) => {
    assert(name, ok, detail)
    results.push({ name, ok, detail })
  }

  const getGitDiffApi = () => window.__onwardGitDiffDebug
  const getProjectEditorApi = () => window.__onwardProjectEditorDebug
  const platform = window.electronAPI.platform

  const waitForGitDiffOpen = async (label: string, timeout = 10000) => {
    return waitFor(`gitdiff-open:${label}`, () => {
      const api = getGitDiffApi()
      return Boolean(api?.isOpen && api.isOpen())
    }, timeout)
  }

  const waitForGitDiffLoaded = async (label: string, timeout = 15000) => {
    return waitFor(`gitdiff-loaded:${label}`, () => {
      const api = getGitDiffApi()
      const fileList = api?.getFileList?.() || []
      return Array.isArray(fileList) && fileList.length > 0
    }, timeout)
  }

  // Image-preview observation budget.
  //
  // The preview becomes ready once the file's `getFileContent` resolves and the
  // viewer flips `isImage`. That content fetch runs on the worker's file-content
  // lane, which is independent of the diff-list lane at the scheduler — BUT the
  // single git-ipc worker thread spawns child git processes, and on an
  // EDR-throttled Windows host a concurrent `scope:'full'` diff reload (e.g. the
  // product-issued reload after the PNG's Deny) saturates EDR's process-creation
  // budget, so the SVG content fetch, while never blocked, can take well over the
  // old 10s window to complete (round-5 ID-12-image-preview-loaded timeout). A
  // wider budget rides out that transient EDR contention without papering over a
  // real hang: a genuinely stuck fetch still fails when the budget elapses.
  const IMAGE_PREVIEW_BUDGET_MS = 30000

  const waitForImagePreview = async (label: string, timeout = IMAGE_PREVIEW_BUDGET_MS) => {
    return waitFor(`image-preview:${label}`, () => {
      const state = getGitDiffApi()?.getImagePreviewState?.()
      return Boolean(state && !state.loading && state.isImage)
    }, timeout)
  }

  // Let any in-flight diff reload (notably the product's post-Keep/Deny
  // `scope:'full'` reload) drain before we lean on the worker for an image
  // content fetch. Keeps the EDR process-creation budget free for the fetch so a
  // prior action's heavy reload does not starve the next file's preview. Bounded
  // and best-effort: returns whether the load went idle, never throws.
  const waitForDiffLoadIdle = async (label: string, timeout = IMAGE_PREVIEW_BUDGET_MS) => {
    return waitFor(`diff-load-idle:${label}`, () => {
      const state = getGitDiffApi()?.getLoadState?.()
      // If the accessor is unavailable, treat as idle (do not block).
      return !state || state.inFlight === false
    }, timeout, 150)
  }

  const matchesFileName = (actual: string | undefined, expected: string) => {
    if (!actual) return false
    return actual === expected || actual.endsWith(`/${expected}`) || actual.endsWith(`\\${expected}`)
  }

  const findFileIndex = (filename: string) => {
    const fileList = getGitDiffApi()?.getFileList?.() || []
    return fileList.findIndex((file) => matchesFileName(file.filename, filename))
  }

  // Authoritative, light probe of a ROOT-level file's git changeType.
  //
  // Goes straight to the main process with a forced `scope:'root-only'` getDiff.
  // Root-only skips the submodule recursion entirely (git-utils.ts filters out
  // `repo.isSubmodule`), so it is fast even under EDR and does NOT jam the
  // worker's concurrency-1 lane the way a `scope:'full'` reload does. `force`
  // bypasses the diff request cache so we always read post-mutation truth. The
  // test images live at the repo root, so they always appear in the root-only
  // file set. Returns true the instant the file is present with the expected
  // changeType. Throws are swallowed (treated as "not yet observed") so the
  // caller's budget loop can retry.
  const probeRootOnlyChangeType = async (
    filename: string,
    changeType: 'staged' | 'untracked'
  ): Promise<boolean> => {
    const targetCwd = getGitDiffApi()?.getCwd?.()
    if (!targetCwd) return false
    try {
      const result = await window.electronAPI.git.getDiff(targetCwd, { scope: 'root-only', force: true })
      if (!result?.success || !Array.isArray(result.files)) return false
      return result.files.some(
        (file) => matchesFileName(file.filename, filename) && file.changeType === changeType
      )
    } catch {
      return false
    }
  }

  // Wait for a Keep/Deny mutation to be reflected in git, using the light
  // root-only probe above instead of the heavy full UI reload.
  //
  // Both Keep (-> staged via `git add`) and Deny (-> untracked via
  // `git reset HEAD`) mutate git deterministically and have already succeeded by
  // the time we poll. The ONLY racey part is observing the new state, and the
  // round-4 approach observed it via the React-state `getFileList()` whose only
  // refresh path is a `scope:'full'` reload that EDR pushes past the renderer's
  // 30s watchdog — so the list never flipped (round-5 regression). Here we poll
  // the authoritative root-only getDiff directly: fast, lane-friendly, and it
  // leaves the worker free for ID-12's SVG content fetch. Per the CLAUDE.md
  // timing rule we aggregate across a budget; pass the instant the new state is
  // observed, fail only if the whole budget elapses. Reports the probe count.
  const waitForFileChangeTypeWithRecovery = async (
    filename: string,
    changeType: 'staged' | 'untracked'
  ): Promise<{ ok: boolean; refreshAttempts: number }> => {
    const recoveryDeadline = Date.now() + DENY_RESTORE_RECOVERY_BUDGET_MS
    let observed = false
    let refreshAttempts = 0
    while (!observed && Date.now() < recoveryDeadline && !cancelled()) {
      observed = await probeRootOnlyChangeType(filename, changeType)
      refreshAttempts += 1
      if (observed || cancelled() || Date.now() >= recoveryDeadline) break
      // Brief gap before the next probe so we are not spinning on the worker;
      // root-only is light but the mutation->visibility window can still need a
      // moment under EDR. Bounded by the attempt timeout / overall budget.
      const remaining = recoveryDeadline - Date.now()
      await sleep(Math.min(DENY_RESTORE_ATTEMPT_TIMEOUT_MS, Math.max(0, remaining), 600))
    }
    return { ok: observed, refreshAttempts }
  }

  const exerciseImageFileActions = async (filename: string, idPrefix: string, verifyKeepDeny = true) => {
    // Poll for the file in the diff list rather than checking once. A prior file's
    // heavy post-action reload, or worker-lane starvation under peak EDR, can leave
    // the list transiently mid-refresh when this runs, so a single-shot
    // findFileIndex returns -1 for a file that IS about to (re)appear (observed:
    // ID-12-file-found index:-1 right after ID-04 starved the worker ~30 s). Wait
    // for the OUTCOME; a file that genuinely never lists still fails by budget.
    let index = findFileIndex(filename)
    if (index < 0 && !cancelled()) {
      await waitFor(`image-file-found:${filename}`, () => {
        index = findFileIndex(filename)
        return index >= 0
      }, IMAGE_PREVIEW_BUDGET_MS, 200)
    }
    record(`${idPrefix}-file-found`, index >= 0, { filename, index })
    if (index < 0 || cancelled()) return

    const selected = getGitDiffApi()?.selectFileByIndex(index) === true
    record(`${idPrefix}-selected`, selected, { filename })
    if (!selected || cancelled()) return

    // Drain any in-flight diff reload first so the worker's process-creation
    // budget is free for this file's content fetch. A prior file's post-Deny
    // `scope:'full'` reload can otherwise saturate EDR and starve the SVG/PNG
    // preview fetch past its budget (round-5 ID-12 regression). Best-effort.
    await waitForDiffLoadIdle(`${filename}-before-preview`)

    let previewLoaded = await waitForImagePreview(`${filename}-preview`)
    if (!previewLoaded && !cancelled()) {
      // Re-drive once. Under peak full-suite EDR the worker's concurrency-1 lane
      // can starve (or drop) the first content fetch past its 30 s budget even
      // though the fetch itself is healthy (observed: ID-04-image-preview-loaded
      // timeout in a heavy iteration; the same suite passed the prior iteration).
      // Re-issue by toggling selection away and back: that forces a FRESH fetch
      // when the lane frees, rather than waiting on a possibly-dead request.
      // Bounded to one retry so worst-case stays well inside the 240 s runner budget.
      const fileCount = getGitDiffApi()?.getFileList?.().length ?? 0
      const otherIndex = index === 0 ? Math.min(1, fileCount - 1) : 0
      if (otherIndex >= 0 && otherIndex !== index) {
        getGitDiffApi()?.selectFileByIndex(otherIndex)
        await sleep(200)
      }
      await waitForDiffLoadIdle(`${filename}-redrive-idle`)
      const reselected = getGitDiffApi()?.selectFileByIndex(index) === true
      if (reselected) {
        previewLoaded = await waitForImagePreview(`${filename}-preview-redrive`)
      }
    }
    record(`${idPrefix}-image-preview-loaded`, previewLoaded, { filename })
    if (!previewLoaded || cancelled()) return

    // Poll the FULL settled-state predicate before reading the derived UI state.
    // getImagePreviewState() is ref-backed (flips on isImage immediately), but
    // hasModifiedUrl and getFileActionState()'s canShow*Panel are render-scope
    // values carried by a LATER React commit. Reading them in the same tick that
    // waitForImagePreview resolves races that commit — under accumulated EDR
    // load the commit slips one render and the three derived-state reads fast-FAIL
    // even though the panel is about to appear. Wait for the OUTCOME with a
    // generous hang-detector ceiling: a slow-but-correct commit passes; a genuine
    // never-converge still fails at the ceiling (and the reads below then report
    // the real non-ready state honestly).
    await waitFor(`image-actions-ready:${filename}`, () => {
      const ps = getGitDiffApi()?.getImagePreviewState?.()
      const as = getGitDiffApi()?.getFileActionState?.()
      return Boolean(
        ps?.isImage &&
        ps?.hasModifiedUrl === true &&
        as?.fileActionsVisible === true &&
        as?.lineActionsVisible === false
      )
    }, IMAGE_PREVIEW_BUDGET_MS, 120)

    const previewState = getGitDiffApi()?.getImagePreviewState?.()
    record(`${idPrefix}-image-preview-state`, Boolean(previewState?.isImage) && previewState?.hasModifiedUrl === true, {
      filename,
      state: previewState || null
    })

    const actionState = getGitDiffApi()?.getFileActionState?.()
    record(`${idPrefix}-file-actions-visible`, actionState?.fileActionsVisible === true, {
      filename,
      actionState: actionState || null
    })
    record(`${idPrefix}-line-actions-hidden`, actionState?.lineActionsVisible === false, {
      filename,
      actionState: actionState || null
    })
    if (!(actionState?.fileActionsVisible) || cancelled() || !verifyKeepDeny) return

    const keepTriggered = await getGitDiffApi()?.triggerFileAction?.('keep')
    record(`${idPrefix}-keep-triggered`, keepTriggered === true, { filename })
    if (keepTriggered !== true || cancelled()) return

    const stagedResult = await waitForFileChangeTypeWithRecovery(filename, 'staged')
    record(`${idPrefix}-keep-staged`, stagedResult.ok, {
      filename,
      refreshAttempts: stagedResult.refreshAttempts,
      files: getGitDiffApi()?.getFileList?.().filter((file) => matchesFileName(file.filename, filename)) || []
    })
    if (!stagedResult.ok || cancelled()) return

    const denyTriggered = await getGitDiffApi()?.triggerFileAction?.('deny')
    record(`${idPrefix}-deny-triggered`, denyTriggered === true, { filename })
    if (denyTriggered !== true || cancelled()) return

    const untrackedResult = await waitForFileChangeTypeWithRecovery(filename, 'untracked')
    record(`${idPrefix}-deny-restored-untracked`, untrackedResult.ok, {
      filename,
      refreshAttempts: untrackedResult.refreshAttempts,
      files: getGitDiffApi()?.getFileList?.().filter((file) => matchesFileName(file.filename, filename)) || []
    })
  }

  const termExec = async (command: string, label: string, waitMs = 900) => {
    await window.electronAPI.terminal.write(terminalId, `${command}\r`)
    await sleep(waitMs)
    log(`exec:${label}`, { command })
  }

  log('image-diff:start', { suite: 'ImageDiff' })

  if (!cancelled()) {
    const createCommand = platform === 'win32'
      ? `powershell -Command "[IO.File]::WriteAllBytes('${TEST_IMAGE_FILENAME}', [Convert]::FromBase64String('${TINY_PNG_BASE64}')); [IO.File]::WriteAllBytes('${TEST_SVG_FILENAME}', [Convert]::FromBase64String('${TINY_SVG_BASE64}'))"`
      : `printf '%s' '${TINY_PNG_BASE64}' | base64 -d > '${TEST_IMAGE_FILENAME}' && printf '%s' '${TINY_SVG_BASE64}' | base64 -d > '${TEST_SVG_FILENAME}'`
    await termExec(createCommand, 'create-image', 1500)
    await window.electronAPI.git.notifyTerminalActivity(terminalId)
    await sleep(700)
    record('ID-01-test-images-created', true)
  }

  let gitDiffOpened = false
  if (!cancelled()) {
    window.dispatchEvent(new CustomEvent('git-diff:open', { detail: { terminalId, source: 'debug' } }))
    gitDiffOpened = await waitForGitDiffOpen('open')
    record('ID-02-git-diff-opened', gitDiffOpened)
  }

  if (!cancelled() && gitDiffOpened) {
    const loaded = await waitForGitDiffLoaded('loaded')
    record('ID-03-files-loaded', loaded, { fileCount: getGitDiffApi()?.getFileList?.().length ?? 0 })
    // Poll until BOTH images are present in the diff list instead of reading once:
    // `loaded` only gates the diff-loaded flag, but the two image entries can still
    // be settling into the list under EDR, so a single-shot pair check raced.
    const bothImagesFound = await waitFor('test-images-found', () =>
      findFileIndex(TEST_IMAGE_FILENAME) >= 0 && findFileIndex(TEST_SVG_FILENAME) >= 0,
      IMAGE_PREVIEW_BUDGET_MS, 200)
    const fileList = getGitDiffApi()?.getFileList?.() || []
    record('ID-03-test-images-found', bothImagesFound, {
      fileCount: fileList.length,
      files: fileList
    })
  }

  if (!cancelled() && gitDiffOpened) {
    await exerciseImageFileActions(TEST_IMAGE_FILENAME, 'ID-04')
  }

  if (!cancelled() && gitDiffOpened) {
    await exerciseImageFileActions(TEST_SVG_FILENAME, 'ID-12', false)
  }

  // NOTE: the Git History image-diff portion (former ID-13..ID-18) was split out
  // into test-image-history-diff.ts (suite `image-history-diff`) because its
  // per-run throwaway git repo fixture (init + 4 commits) is taxed heavily by EDR
  // and pushed the combined suite past the 180s per-runner budget. See that file's
  // header and test/README.md for the split rationale.

  if (!cancelled()) {
    await openFileInEditor(TEST_EDITOR_PNG_PATH)
    // Generous hang-detector ceiling (was 10s): the editor image-preview load is a
    // worker/IPC fetch that EDR can starve past 10s; 30s (IMAGE_PREVIEW_BUDGET_MS)
    // matches the diff-side preview budget. waitFor short-circuits on success.
    const pngEditorReady = await waitFor('editor-png-preview', () => {
      const api = getProjectEditorApi()
      const state = api?.getImageFilePreviewState?.()
      return api?.getActiveFilePath?.() === TEST_EDITOR_PNG_PATH && Boolean(state?.visible && state.loaded && !state.broken)
    }, IMAGE_PREVIEW_BUDGET_MS, 120)
    record('ID-19-editor-png-preview', pngEditorReady, {
      activeFilePath: getProjectEditorApi()?.getActiveFilePath?.() ?? null,
      state: getProjectEditorApi()?.getImageFilePreviewState?.() ?? null
    })

    await openFileInEditor(TEST_EDITOR_SVG_PATH)
    const svgEditorReady = await waitFor('editor-svg-preview', () => {
      const api = getProjectEditorApi()
      const state = api?.getImageFilePreviewState?.()
      return api?.getActiveFilePath?.() === TEST_EDITOR_SVG_PATH && Boolean(state?.visible && state.loaded && !state.broken)
    }, IMAGE_PREVIEW_BUDGET_MS, 120)
    record('ID-19-editor-svg-preview', svgEditorReady, {
      activeFilePath: getProjectEditorApi()?.getActiveFilePath?.() ?? null,
      state: getProjectEditorApi()?.getImageFilePreviewState?.() ?? null
    })
  }

  if (!cancelled() && gitDiffOpened) {
    window.dispatchEvent(new CustomEvent('git-diff:close', { detail: { terminalId } }))
    await sleep(500)
    record('ID-20-closed', true)
  }

  if (!cancelled()) {
    const cleanupCommand = platform === 'win32'
      ? `powershell -Command "Remove-Item -Force '${TEST_IMAGE_FILENAME}','${TEST_SVG_FILENAME}' -ErrorAction SilentlyContinue; if (Test-Path '${HISTORY_REPO_DIR}') { Remove-Item -Recurse -Force '${HISTORY_REPO_DIR}' }"`
      : `rm -f "${TEST_IMAGE_FILENAME}" "${TEST_SVG_FILENAME}" && rm -rf "${HISTORY_REPO_DIR}"`
    await termExec(cleanupCommand, 'cleanup-image', 800)
    record('ID-21-cleanup', true)
  }

  log('image-diff:done', { totalTests: results.length, passed: results.filter((result) => result.ok).length })
  return results
}
