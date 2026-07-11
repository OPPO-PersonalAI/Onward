/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Phase 0.7: ProjectEditor multi-terminal isolation recovery test in the same directory
 */
import type { AutotestContext, TestResult } from './types'
import { buildChangeDirectoryCommand, type TerminalShellKind } from '../utils/terminal-command'

function normalizePath(value: string): string {
  return value.replace(/\\/g, '/')
}

function getVisibleTerminalIds(): string[] {
  const nodes = Array.from(document.querySelectorAll<HTMLElement>('[data-terminal-id]'))
  const ids = nodes
    .map((node) => node.dataset.terminalId ?? '')
    .filter(Boolean)
  return Array.from(new Set(ids))
}

function dispatchEscape(): void {
  document.dispatchEvent(new KeyboardEvent('keydown', {
    key: 'Escape',
    code: 'Escape',
    bubbles: true,
    cancelable: true
  }))
}

async function resolveTerminalShellKind(terminalId: string): Promise<TerminalShellKind | undefined> {
  try {
    return (await window.electronAPI.terminal.getInputCapabilities(terminalId)).shellKind
  } catch {
    return undefined
  }
}

async function waitForTerminalCwd(
  terminalId: string,
  expectedCwd: string,
  sleep: (ms: number) => Promise<void>,
  timeoutMs = 10000
): Promise<string | null> {
  const startedAt = performance.now()
  const normalizedExpected = normalizePath(expectedCwd)
  while (performance.now() - startedAt < timeoutMs) {
    const cwd = await window.electronAPI.git.getTerminalCwd(terminalId)
    if (cwd && normalizePath(cwd) === normalizedExpected) {
      return cwd
    }
    await sleep(150)
  }
  return null
}

async function waitForPersistedState(
  stateKey: string,
  expectedFilePath: string,
  sleep: (ms: number) => Promise<void>,
  timeoutMs = 10000
) {
  const startedAt = performance.now()
  while (performance.now() - startedAt < timeoutMs) {
    const appState = await window.electronAPI.appState.load()
    const entry = appState.projectEditorStates?.[stateKey] ?? null
    if (entry?.activeFilePath === expectedFilePath) {
      return entry
    }
    await sleep(160)
  }
  return null
}

export async function testProjectEditorMultiTerminalScope(ctx: AutotestContext): Promise<TestResult[]> {
  const { log, sleep, waitFor, assert, cancelled, rootPath, openFileInEditor } = ctx
  const results: TestResult[] = []
  const _assert = (name: string, ok: boolean, detail?: Record<string, unknown>) => {
    assert(name, ok, detail)
    results.push({ name, ok, detail })
  }

  const getApi = () => window.__onwardProjectEditorDebug
  const waitForEditorClosedOrReset = async (label: string) => {
    return await waitFor(
      label,
      () => {
        const api = getApi()
        if (!api?.isOpen) return true
        if (!api.isOpen()) return true
        return (api.getActiveFilePath?.() ?? null) === null
      },
      8000
    )
  }
  const tempPathA = `onward-autotest-multi-terminal-a-${Date.now()}.md`
  const tempPathB = `onward-autotest-multi-terminal-b-${Date.now()}.md`
  let driftSubdirName: string | null = null
  const contentA = Array.from({ length: 40 }, (_, idx) => `terminal-a-line-${idx + 1}`).join('\n')
  const contentB = Array.from({ length: 40 }, (_, idx) => `terminal-b-line-${idx + 1}`).join('\n')

  log('phase0.7:start', { suite: 'ProjectEditorMultiTerminalScope', rootPath, tempPathA, tempPathB })

  const layoutButton = document.querySelector<HTMLButtonElement>('button[title="Two terminals"]')
  layoutButton?.click()
  const hasTwoTerminals = await waitFor(
    'phase0.7-layout-two-terminals',
    () => getVisibleTerminalIds().length >= 2,
    10000
  )
  _assert('PEMS-01-layout-two-terminals', hasTwoTerminals, {
    visibleTerminalIds: getVisibleTerminalIds()
  })
  if (!hasTwoTerminals || cancelled()) return results

  const terminalIds = getVisibleTerminalIds()
  const terminalA = terminalIds[0] ?? null
  const terminalB = terminalIds[1] ?? null
  const terminalPairValid = Boolean(terminalA && terminalB && terminalA !== terminalB)
  _assert('PEMS-02-terminal-pair-valid', terminalPairValid, { terminalA, terminalB, terminalIds })
  if (!terminalPairValid || !terminalA || !terminalB || cancelled()) return results

  const createA = await window.electronAPI.project.createFile(rootPath, tempPathA, contentA)
  _assert('PEMS-03-create-file-a', createA.success, { error: createA.error, tempPathA })
  if (!createA.success || cancelled()) return results
  const createB = await window.electronAPI.project.createFile(rootPath, tempPathB, contentB)
  _assert('PEMS-04-create-file-b', createB.success, { error: createB.error, tempPathB })
  if (!createB.success || cancelled()) return results

  const platform = window.electronAPI.platform
  const shellKindA = await resolveTerminalShellKind(terminalA)
  const shellKindB = await resolveTerminalShellKind(terminalB)
  const cdCommandA = buildChangeDirectoryCommand(platform, rootPath, shellKindA)
  const cdCommandB = buildChangeDirectoryCommand(platform, rootPath, shellKindB)

  await window.electronAPI.terminal.write(terminalA, cdCommandA)
  await window.electronAPI.terminal.write(terminalB, cdCommandB)
  await window.electronAPI.git.notifyTerminalActivity(terminalA)
  await window.electronAPI.git.notifyTerminalActivity(terminalB)

  const cwdA = await waitForTerminalCwd(terminalA, rootPath, sleep)
  _assert('PEMS-05-terminal-a-cwd-ready', Boolean(cwdA), {
    terminalId: terminalA,
    expected: normalizePath(rootPath),
    actual: cwdA ? normalizePath(cwdA) : null
  })
  if (!cwdA || cancelled()) return results

  const cwdB = await waitForTerminalCwd(terminalB, rootPath, sleep)
  _assert('PEMS-06-terminal-b-cwd-ready', Boolean(cwdB), {
    terminalId: terminalB,
    expected: normalizePath(rootPath),
    actual: cwdB ? normalizePath(cwdB) : null
  })
  if (!cwdB || cancelled()) return results

  try {
    window.dispatchEvent(new CustomEvent('project-editor:open', { detail: { terminalId: terminalA } }))
    const openedA = await waitFor(
      'phase0.7-open-editor-a',
      () => Boolean(getApi()?.isOpen?.()),
      8000
    )
    _assert('PEMS-07-open-editor-a', openedA, { terminalId: terminalA })
    if (!openedA || cancelled()) return results

    await openFileInEditor(tempPathA)
    const openedFileA = await waitFor(
      'phase0.7-open-file-a',
      () => getApi()?.getActiveFilePath?.() === tempPathA,
      8000
    )
    _assert('PEMS-08-open-file-a', openedFileA, {
      expected: tempPathA,
      actual: getApi()?.getActiveFilePath?.() ?? null
    })
    if (!openedFileA || cancelled()) return results

    await sleep(240)
    dispatchEscape()
    const closedA = await waitForEditorClosedOrReset('phase0.7-close-editor-a')
    _assert('PEMS-09-close-editor-a', closedA, { closedA })
    if (!closedA || cancelled()) return results

    window.dispatchEvent(new CustomEvent('project-editor:open', { detail: { terminalId: terminalB } }))
    const openedB = await waitFor(
      'phase0.7-open-editor-b',
      () => Boolean(getApi()?.isOpen?.()),
      8000
    )
    _assert('PEMS-10-open-editor-b', openedB, { terminalId: terminalB })
    if (!openedB || cancelled()) return results

    await openFileInEditor(tempPathB)
    const openedFileB = await waitFor(
      'phase0.7-open-file-b',
      () => getApi()?.getActiveFilePath?.() === tempPathB,
      8000
    )
    _assert('PEMS-11-open-file-b', openedFileB, {
      expected: tempPathB,
      actual: getApi()?.getActiveFilePath?.() ?? null
    })
    if (!openedFileB || cancelled()) return results

    await sleep(240)
    dispatchEscape()
    const closedB = await waitForEditorClosedOrReset('phase0.7-close-editor-b')
    _assert('PEMS-12-close-editor-b', closedB, { closedB })
    if (!closedB || cancelled()) return results

    window.dispatchEvent(new CustomEvent('project-editor:open', { detail: { terminalId: terminalA } }))
    const reopenedA = await waitFor(
      'phase0.7-reopen-editor-a',
      () => Boolean(getApi()?.isOpen?.()),
      8000
    )
    _assert('PEMS-13-reopen-editor-a', reopenedA, { terminalId: terminalA })
    if (!reopenedA || cancelled()) return results

    const restoredA = await waitFor(
      'phase0.7-restore-a-file',
      () => getApi()?.getActiveFilePath?.() === tempPathA,
      8000
    )
    _assert('PEMS-14-restore-a-file', restoredA, {
      expected: tempPathA,
      actual: getApi()?.getActiveFilePath?.() ?? null
    })
    if (!restoredA || cancelled()) return results

    const notCrossRestored = getApi()?.getActiveFilePath?.() !== tempPathB
    _assert('PEMS-15-no-cross-restore-a-to-b', Boolean(notCrossRestored), {
      disallowed: tempPathB,
      actual: getApi()?.getActiveFilePath?.() ?? null
    })

    await sleep(240)
    dispatchEscape()
    const closedAfterAReopen = await waitForEditorClosedOrReset('phase0.7-close-editor-after-a-reopen')
    _assert('PEMS-16-close-editor-after-a-reopen', closedAfterAReopen, { closedAfterAReopen })
    if (!closedAfterAReopen || cancelled()) return results

    window.dispatchEvent(new CustomEvent('project-editor:open', { detail: { terminalId: terminalB } }))
    const reopenedB = await waitFor(
      'phase0.7-reopen-editor-b',
      () => Boolean(getApi()?.isOpen?.()),
      8000
    )
    _assert('PEMS-17-reopen-editor-b', reopenedB, { terminalId: terminalB })
    if (!reopenedB || cancelled()) return results

    const restoredB = await waitFor(
      'phase0.7-restore-b-file',
      () => getApi()?.getActiveFilePath?.() === tempPathB,
      8000
    )
    _assert('PEMS-18-restore-b-file', restoredB, {
      expected: tempPathB,
      actual: getApi()?.getActiveFilePath?.() ?? null
    })

    const normalizedRoot = normalizePath(rootPath)
    const stateKeyA = JSON.stringify([terminalA, normalizedRoot])
    const stateKeyB = JSON.stringify([terminalB, normalizedRoot])
    const stateA = await waitForPersistedState(stateKeyA, tempPathA, sleep)
    const stateB = await waitForPersistedState(stateKeyB, tempPathB, sleep)
    _assert('PEMS-19-state-key-a-persisted', Boolean(stateA), {
      stateKeyA,
      activeFilePath: stateA?.activeFilePath ?? null
    })
    _assert('PEMS-20-state-key-b-persisted', Boolean(stateB), {
      stateKeyB,
      activeFilePath: stateB?.activeFilePath ?? null
    })

    // ── Per-Task POSITION restore (not just file identity) ──
    // Editor is currently open for terminal B showing file B. Seed B's
    // cursor, close, then seed A's cursor + preview scroll, and verify each
    // Task restores its OWN position after the other Task used the editor.
    const cursorB = { lineNumber: 10, column: 2 }
    const cursorA = { lineNumber: 25, column: 3 }
    const previewScrollTolerance = 80

    const seededCursorB = Boolean(getApi()?.setCursorPosition?.(cursorB.lineNumber, cursorB.column))
    _assert('PEMS-21-seed-cursor-b', seededCursorB, { cursorB })
    if (!seededCursorB || cancelled()) return results

    await sleep(240)
    dispatchEscape()
    const closedBAfterSeed = await waitForEditorClosedOrReset('phase0.7-close-b-after-seed')
    if (!closedBAfterSeed || cancelled()) return results

    window.dispatchEvent(new CustomEvent('project-editor:open', { detail: { terminalId: terminalA } }))
    await waitFor('phase0.7-reopen-a-for-seed', () => getApi()?.getActiveFilePath?.() === tempPathA, 8000)
    const seededCursorA = Boolean(getApi()?.setCursorPosition?.(cursorA.lineNumber, cursorA.column))
    getApi()?.scrollPreviewToFraction?.(0.6)
    const previewSeededA = await waitFor(
      'phase0.7-seed-preview-a',
      () => (getApi()?.getPreviewScrollTop?.() ?? 0) > 0,
      8000
    )
    const savedPreviewScrollA = getApi()?.getPreviewScrollTop?.() ?? 0
    _assert('PEMS-22-seed-position-a', seededCursorA && previewSeededA, {
      cursorA,
      savedPreviewScrollA: Math.round(savedPreviewScrollA)
    })
    if (!seededCursorA || cancelled()) return results

    await sleep(240)
    dispatchEscape()
    const closedAAfterSeed = await waitForEditorClosedOrReset('phase0.7-close-a-after-seed')
    if (!closedAAfterSeed || cancelled()) return results

    // Reopen B: its own cursor must come back, not A's (same-root two-Task
    // position isolation — the D5 contamination detector).
    window.dispatchEvent(new CustomEvent('project-editor:open', { detail: { terminalId: terminalB } }))
    await waitFor('phase0.7-reopen-b-position', () => getApi()?.getActiveFilePath?.() === tempPathB, 8000)
    const cursorBRestored = await waitFor(
      'phase0.7-restore-b-cursor',
      () => Math.abs((getApi()?.getCursorPosition?.()?.lineNumber ?? -1) - cursorB.lineNumber) <= 1,
      8000
    )
    _assert('PEMS-23-reopen-b-cursor-restored', cursorBRestored, {
      expected: cursorB.lineNumber,
      actual: getApi()?.getCursorPosition?.()?.lineNumber ?? null
    })
    const bCursorNotContaminated =
      Math.abs((getApi()?.getCursorPosition?.()?.lineNumber ?? -1) - cursorA.lineNumber) > 1
    _assert('PEMS-24-b-cursor-not-contaminated-by-a', bCursorNotContaminated, {
      disallowed: cursorA.lineNumber,
      actual: getApi()?.getCursorPosition?.()?.lineNumber ?? null
    })

    await sleep(240)
    dispatchEscape()
    const closedBAfterCheck = await waitForEditorClosedOrReset('phase0.7-close-b-after-check')
    if (!closedBAfterCheck || cancelled()) return results

    // Reopen A after B interleaved: cursor + preview scroll restore, and the
    // reopen must take the retained-view fast path (the old single-slot
    // snapshot was destroyed by B's open and forced 'persisted-state').
    window.dispatchEvent(new CustomEvent('project-editor:open', { detail: { terminalId: terminalA } }))
    await waitFor('phase0.7-reopen-a-position', () => getApi()?.getActiveFilePath?.() === tempPathA, 8000)
    const cursorARestored = await waitFor(
      'phase0.7-restore-a-cursor',
      () => Math.abs((getApi()?.getCursorPosition?.()?.lineNumber ?? -1) - cursorA.lineNumber) <= 1,
      8000
    )
    _assert('PEMS-25-reopen-a-cursor-restored', cursorARestored, {
      expected: cursorA.lineNumber,
      actual: getApi()?.getCursorPosition?.()?.lineNumber ?? null
    })
    const previewARestored = await waitFor(
      'phase0.7-restore-a-preview-scroll',
      () => Math.abs((getApi()?.getPreviewScrollTop?.() ?? -10_000) - savedPreviewScrollA) <= previewScrollTolerance,
      8000
    )
    _assert('PEMS-26-reopen-a-preview-scroll-restored', previewARestored, {
      expected: Math.round(savedPreviewScrollA),
      actual: Math.round(getApi()?.getPreviewScrollTop?.() ?? -1),
      tolerance: previewScrollTolerance
    })
    const reopenRestoreA = getApi()?.getLastProjectEditorReopenRestore?.() ?? null
    _assert(
      'PEMS-27-reopen-a-retained-view-after-interleave',
      reopenRestoreA?.cause === 'retained-view',
      {
        cause: reopenRestoreA?.cause ?? null,
        markdownCacheMode: reopenRestoreA?.markdownCacheMode ?? null,
        durationMs: reopenRestoreA?.durationMs ?? null
      }
    )

    // ── cwd drift: `cd` into a subdir between two editor visits must not
    // change the per-Task state key (scope is normalized to the repo root) ──
    await sleep(240)
    dispatchEscape()
    const closedBeforeDrift = await waitForEditorClosedOrReset('phase0.7-close-before-drift')
    if (!closedBeforeDrift || cancelled()) return results

    driftSubdirName = `onward-autotest-pems-subdir-${Date.now()}`
    const subdirName = driftSubdirName
    const createSubdir = await window.electronAPI.project.createFolder(rootPath, subdirName)
    if (createSubdir.success) {
      const subdirAbs = `${rootPath.replace(/[\\/]+$/, '')}/${subdirName}`
      const cdSubdirCommand = buildChangeDirectoryCommand(platform, subdirAbs, shellKindA)
      await window.electronAPI.terminal.write(terminalA, cdSubdirCommand)
      await window.electronAPI.git.notifyTerminalActivity(terminalA)
      const driftedCwd = await waitForTerminalCwd(terminalA, subdirAbs, sleep)
      if (driftedCwd) {
        window.dispatchEvent(new CustomEvent('project-editor:open', { detail: { terminalId: terminalA } }))
        await waitFor('phase0.7-reopen-a-after-drift', () => Boolean(getApi()?.isOpen?.()), 8000)
        const rootStable = await waitFor(
          'phase0.7-drift-root-stable',
          () => normalizePath(getApi()?.getRootPath?.() ?? '') === normalizedRoot,
          8000
        )
        _assert('PEMS-28-cwd-drift-root-stable', rootStable, {
          expected: normalizedRoot,
          actual: getApi()?.getRootPath?.() ?? null
        })
        const fileRestoredAfterDrift = await waitFor(
          'phase0.7-drift-file-restored',
          () => getApi()?.getActiveFilePath?.() === tempPathA,
          8000
        )
        _assert('PEMS-29-cwd-drift-file-restored', fileRestoredAfterDrift, {
          expected: tempPathA,
          actual: getApi()?.getActiveFilePath?.() ?? null
        })
        await sleep(240)
        dispatchEscape()
        await waitForEditorClosedOrReset('phase0.7-close-after-drift')
        const appStateAfterDrift = await window.electronAPI.appState.load()
        const subdirKey = JSON.stringify([terminalA, normalizePath(subdirAbs)])
        const hasSubdirKey = Boolean(appStateAfterDrift.projectEditorStates?.[subdirKey])
        _assert('PEMS-30-cwd-drift-no-subdir-key', !hasSubdirKey, {
          subdirKey,
          presentKeys: Object.keys(appStateAfterDrift.projectEditorStates ?? {}).filter((key) => key.includes(terminalA))
        })
        // Restore terminal A's cwd for any later suites sharing the session.
        const cdBackCommand = buildChangeDirectoryCommand(platform, rootPath, shellKindA)
        await window.electronAPI.terminal.write(terminalA, cdBackCommand)
        await window.electronAPI.git.notifyTerminalActivity(terminalA)
        await waitForTerminalCwd(terminalA, rootPath, sleep)
      } else {
        _assert('PEMS-28-cwd-drift-root-stable', false, { reason: 'terminal A never reported the subdir cwd' })
      }
    } else {
      _assert('PEMS-28-cwd-drift-root-stable', false, { reason: 'subdir fixture creation failed', error: createSubdir.error })
    }
  } finally {
    dispatchEscape()
    await sleep(200)
    await window.electronAPI.project.deletePath(rootPath, tempPathA)
    await window.electronAPI.project.deletePath(rootPath, tempPathB)
    if (driftSubdirName) {
      await window.electronAPI.project.deletePath(rootPath, driftSubdirName)
    }
    const singleLayoutButton = document.querySelector<HTMLButtonElement>('button[title="Single terminal"]')
    singleLayoutButton?.click()
    log('phase0.7:cleanup', { tempPathA, tempPathB, resetLayout: true })
  }

  return results
}
