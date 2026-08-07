/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

import type { AutotestContext, TestResult } from './types'

/**
 * End-to-end coverage for the PDF external-change auto-refresh: an agent tool
 * rewrites the open PDF on disk, and the reader must follow — reloading in
 * place with view state preserved, adopting externally added annotations,
 * NEVER reloading in response to its own annotation autosave, surviving a
 * half-written file, and rebase-merging unsaved local edits instead of
 * clobbering either side.
 *
 * Paired unit coverage:
 *   - `file-watch-binary-core.test.mts` pins the emit/skip decisions
 *     (fingerprint-based self-write suppression incl. the rename path).
 *   - `pdf-reload-core.test.mts` pins dedup, retry and view-state restore.
 *   - `pdf-annotation-merge-core.test.mts` pins the three-way rebase table.
 *   - `pdf-annotation-store.test.mts` (PAS-U-16..20) pins the store's rebase
 *     entry point and the external-modified save-gate reaction.
 * This file proves the whole pipeline — fs.watch → main-process settle → IPC
 * → host → iframe swap → merge → autosave retry — against a real document.
 *
 * Fixture isolation: the runner owns a mktemp project root and copies the
 * committed fixture in as `sample.pdf` BEFORE launch, so this suite never
 * writes into the repo working tree at all (no `__autotest_*` sweep needed).
 */

const PDF_NAME = 'sample.pdf'
const OTHER_NAME = 'notes.md'

// Confirmed with the user (2026-08-01): an external modification must be
// visible in the reader within 3 s end-to-end (watcher debounce 400 ms +
// rename rebuild 500 ms + document reload). Latency rule: 3 trials, pass if
// at least one meets the budget.
const REFRESH_LATENCY_BUDGET_MS = 3000
const LATENCY_TRIALS = 3

// Boolean-correctness aggregate: the self-save suppression check performs
// this many save cycles and requires ZERO resulting reloads across all of
// them.
const SELF_SAVE_TRIALS = 5

interface ReloadMergeStats {
  localAdds: number
  localMods: number
  localDels: number
  conflicts: number
}

interface ExternalReloadProbe {
  results: Array<{ generation: number; ok: boolean; reason: string | null; merge: ReloadMergeStats | null }>
  count(): number
  last(): { ok: boolean; reason: string | null; merge: ReloadMergeStats | null } | null
}

interface ViewerTestApi {
  externalReload: ExternalReloadProbe
  documentInfo(): { numPages: number; fileUrl: string | null; scale: unknown; scrollTop: number }
  textSelection: {
    findSpan(pageNumber: number, needle: string): Element | null
    highlightSubstring(pageNumber: number, spanNeedle: string, subText: string, labelIndex: number): { selected: string } | null
    annotationCount(): number
    annotationRecords(): Array<{ id: string; note: string }>
    isDirty(): boolean
    saveNow(): Promise<{ ok: boolean; reason?: string }>
    writeNote(text: string): string | null
    deleteFirstAnnotation(): boolean
    clear(): void
  }
}

export async function testPdfExternalRefresh(ctx: AutotestContext): Promise<TestResult[]> {
  const { log, sleep, waitFor, assert, cancelled, rootPath } = ctx
  const results: TestResult[] = []
  const record = (name: string, ok: boolean, detail?: Record<string, unknown>) => {
    assert(name, ok, detail)
    results.push({ name, ok, detail })
  }

  const getApi = () => window.__onwardProjectEditorDebug

  const getViewer = (): ViewerTestApi | null => {
    const iframe = document.querySelector('.project-editor-pdf-reader-iframe') as HTMLIFrameElement | null
    const frameWindow = iframe?.contentWindow as (Window & { __onwardPdfTest?: ViewerTestApi }) | null | undefined
    return frameWindow?.__onwardPdfTest ?? null
  }

  const readPdfBase64 = async (): Promise<string | null> => {
    const probe = await window.electronAPI.project.readFileChunk(rootPath, PDF_NAME, 0, 1, 'binary')
    if (!probe?.success || !Number.isFinite(probe.sizeBytes)) return null
    const full = await window.electronAPI.project.readFileChunk(rootPath, PDF_NAME, 0, probe.sizeBytes, 'binary')
    if (!full?.success || full.bytesRead !== probe.sizeBytes) return null
    return (full as unknown as { base64?: string }).base64 ?? null
  }

  const writeExternal = (contentBase64: string, atomic: boolean) =>
    window.electronAPI.debug.writeExternalFile({ root: rootPath, relPath: PDF_NAME, contentBase64, atomic })

  const waitForReloads = (minCount: number, label: string, timeoutMs = 8000) =>
    waitFor(label, () => {
      const viewer = getViewer()
      return Boolean(viewer && viewer.externalReload.count() >= minCount)
    }, timeoutMs, 100)

  log('pdf-extrefresh:start', { rootPath })

  // ---------- open the document ----------

  await getApi()?.openFileByPathAsUser?.(`${rootPath.replace(/[\\/]+$/, '')}/${PDF_NAME}`)
  const visible = await waitFor(
    'pdf-extrefresh-reader-visible',
    () => getApi()?.isPdfReaderVisible?.() === true,
    10000
  )
  record('pdf-extrefresh-reader-visible', visible)

  const layerReady = await waitFor('pdf-extrefresh-text-layer', () => {
    const viewer = getViewer()
    return Boolean(viewer && viewer.textSelection.findSpan(1, 'SELECTME'))
  }, 20000, 150)
  record('pdf-extrefresh-text-layer-rendered', layerReady)
  if (!layerReady || cancelled()) {
    log('pdf-extrefresh:abort', { reason: 'text layer never rendered' })
    return results
  }

  let viewer = getViewer()!

  // ---------- build the byte variants this suite writes "externally" ----------
  // Produced through the app's own save path so they are guaranteed
  // CYY_MARK-compatible: annotated = one highlight, cleanSaved = zero.

  viewer.textSelection.highlightSubstring(1, 'SELECTME', 'SELECTME', 0)
  await sleep(200)
  const saveAnnotated = await viewer.textSelection.saveNow()
  const annotatedBase64 = saveAnnotated.ok ? await readPdfBase64() : null

  viewer.textSelection.deleteFirstAnnotation()
  await sleep(150)
  const saveClean = await viewer.textSelection.saveNow()
  const cleanBase64 = saveClean.ok ? await readPdfBase64() : null

  record('pdf-extrefresh-variants-prepared', Boolean(annotatedBase64 && cleanBase64), {
    saveAnnotated,
    saveClean,
    annotatedBytes: annotatedBase64 ? Math.round(annotatedBase64.length * 0.75) : 0,
    cleanBytes: cleanBase64 ? Math.round(cleanBase64.length * 0.75) : 0
  })
  if (!annotatedBase64 || !cleanBase64) {
    log('pdf-extrefresh:abort', { reason: 'variant preparation failed' })
    return results
  }

  // ---------- self-saves must NOT trigger a reload (5x aggregate) ----------
  // Each cycle rewrites the whole file through the annotation autosave path
  // (temp + fsync + rename — the watcher's rename/rebuild path). Fingerprint
  // suppression must classify every one as our own write.

  {
    const before = viewer.externalReload.count()
    let saveCycles = 0
    for (let i = 0; i < SELF_SAVE_TRIALS; i += 1) {
      viewer.textSelection.clear()
      viewer.textSelection.highlightSubstring(1, 'SELECTME', 'SELECTME', 0)
      await sleep(120)
      const created = await viewer.textSelection.saveNow()
      viewer.textSelection.deleteFirstAnnotation()
      await sleep(100)
      const removed = await viewer.textSelection.saveNow()
      if (created.ok && removed.ok) saveCycles += 1
    }
    // Give the watcher's debounce + rebuild + settle window time to misfire.
    await sleep(2500)
    const after = viewer.externalReload.count()
    record('pdf-extrefresh-selfsave-no-reload-5x', saveCycles === SELF_SAVE_TRIALS && after === before, {
      saveCycles,
      reloadsBefore: before,
      reloadsAfter: after
    })
  }

  // ---------- external change reloads in place, view state preserved ----------

  {
    // Make the single-page fixture scrollable and mark a distinctive view.
    const iframe = document.querySelector('.project-editor-pdf-reader-iframe') as HTMLIFrameElement | null
    const zoomInput = iframe?.contentDocument?.getElementById('customZoomInput') as HTMLInputElement | null
    if (zoomInput) {
      zoomInput.value = '400'
      zoomInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
      await sleep(600)
    }
    const container = iframe?.contentDocument?.getElementById('viewerContainer') as HTMLElement | null
    if (container) {
      container.scrollTop = 180
      await sleep(300)
    }
    const beforeInfo = viewer.documentInfo()

    const baseline = viewer.externalReload.count()
    const wrote = await writeExternal(annotatedBase64, true)
    const reloaded = await waitForReloads(baseline + 1, 'pdf-extrefresh-external-reload')
    const last = viewer.externalReload.last()
    const reloadSucceeded = Boolean(wrote.ok && reloaded && last?.ok)
    record('pdf-extrefresh-external-reload-succeeds', reloadSucceeded, {
      wrote,
      last
    })

    const adopted = await waitFor(
      'pdf-extrefresh-external-annotation',
      () => getViewer()!.textSelection.annotationCount() === 1,
      5000
    )
    record('pdf-extrefresh-external-annotation-appears', adopted, {
      count: getViewer()!.textSelection.annotationCount()
    })

    // View preservation: zoom survives exactly; the scroll offset is restored
    // through two rAFs after pagesinit, so allow slack for re-layout.
    // Gated on reloadSucceeded: with no reload the view is trivially
    // unchanged and the assertion would pass while the feature is broken.
    await sleep(600)
    const afterInfo = getViewer()!.documentInfo()
    record('pdf-extrefresh-view-state-preserved', reloadSucceeded
      && String(afterInfo.scale) === String(beforeInfo.scale)
      && Math.abs(afterInfo.scrollTop - beforeInfo.scrollTop) < 60, {
      reloadSucceeded,
      beforeInfo,
      afterInfo
    })
  }

  viewer = getViewer()!

  // ---------- end-to-end refresh latency (3 trials, 1-of-3 within budget) ----------

  {
    const latencies: number[] = []
    for (let i = 0; i < LATENCY_TRIALS; i += 1) {
      const target = i % 2 === 0 ? cleanBase64 : annotatedBase64
      const expectCount = i % 2 === 0 ? 0 : 1
      const baseline = viewer.externalReload.count()
      const started = performance.now()
      await writeExternal(target, true)
      const done = await waitFor(`pdf-extrefresh-latency-trial-${i}`, () => {
        const v = getViewer()
        return Boolean(
          v &&
          v.externalReload.count() >= baseline + 1 &&
          v.externalReload.last()?.ok &&
          v.textSelection.annotationCount() === expectCount
        )
      }, 10000, 50)
      latencies.push(done ? performance.now() - started : Number.POSITIVE_INFINITY)
      await sleep(400)
    }
    const best = Math.min(...latencies)
    record('pdf-extrefresh-latency-3x', best <= REFRESH_LATENCY_BUDGET_MS, {
      budgetMs: REFRESH_LATENCY_BUDGET_MS,
      latencies: latencies.map(v => (Number.isFinite(v) ? Math.round(v) : -1)),
      bestMs: Number.isFinite(best) ? Math.round(best) : -1
    })
  }

  viewer = getViewer()!

  // ---------- a half-written file defers silently, then recovers ----------
  // State entering here: last latency trial wrote annotatedBase64 (1 annot).

  {
    const docBefore = viewer.documentInfo()
    const countBefore = viewer.textSelection.annotationCount()
    const reloadsBefore = viewer.externalReload.count()

    // A truncated PDF: valid header, missing xref/trailer — exactly what a
    // writer caught mid-write looks like. In-place write (change event path).
    const garbageBase64 = annotatedBase64.slice(0, Math.max(64, Math.floor(annotatedBase64.length / 8)))
    await writeExternal(garbageBase64, false)

    // The reload attempt must fail, retry once, then give up silently.
    const deferred = await waitFor('pdf-extrefresh-defer', () => {
      const v = getViewer()
      const last = v?.externalReload.last()
      return Boolean(v && v.externalReload.count() > reloadsBefore && last && !last.ok)
    }, 10000, 100)

    const stillAlive = getViewer()!.documentInfo().numPages === docBefore.numPages
      && getViewer()!.textSelection.annotationCount() === countBefore
      && Boolean(getViewer()!.textSelection.findSpan(1, 'SELECTME'))
    record('pdf-extrefresh-partial-write-defers', deferred && stillAlive, {
      deferred,
      stillAlive,
      last: getViewer()!.externalReload.last()
    })

    // Completing the write recovers on the next watcher event.
    const reloadsMid = getViewer()!.externalReload.count()
    await writeExternal(cleanBase64, true)
    const recovered = await waitFor('pdf-extrefresh-recover', () => {
      const v = getViewer()
      return Boolean(v && v.externalReload.count() > reloadsMid && v.externalReload.last()?.ok
        && v.textSelection.annotationCount() === 0)
    }, 10000, 100)
    record('pdf-extrefresh-partial-write-recovers', recovered, {
      last: getViewer()!.externalReload.last()
    })
  }

  viewer = getViewer()!

  // ---------- dirty local edit + external rewrite → rebase merge ----------
  // Local: a new note on a fresh highlight (unsaved, inside the quiet
  // window). External: bytes with zero annotations (deletes it). The merge
  // must resurrect the locally edited record (local wins), count the
  // conflict, and the autosave retry must converge the file.

  {
    const reloadsBeforeMerge = viewer.externalReload.count()
    viewer.textSelection.clear()
    viewer.textSelection.highlightSubstring(1, 'SELECTME', 'SELECTME', 0)
    await sleep(150)
    const noteWritten = viewer.textSelection.writeNote('local-merge-note')
    // Immediately rewrite externally, racing the 800 ms autosave on purpose —
    // both orders (watcher first / save-gate first) must converge, and BOTH
    // route through a rebase reload, so the probe must gain an entry carrying
    // merge stats. Without that requirement this assertion once passed via an
    // unguarded direct write that silently clobbered the external bytes.
    await writeExternal(cleanBase64, true)

    const converged = await waitFor('pdf-extrefresh-merge', () => {
      const v = getViewer()
      if (!v) return false
      const records = v.textSelection.annotationRecords()
      return records.length === 1
        && records[0].note === 'local-merge-note'
        && !v.textSelection.isDirty()
        && v.externalReload.count() > reloadsBeforeMerge
    }, 15000, 200)

    const mergeStats = getViewer()!.externalReload.last()?.merge ?? null
    const localEditSurvivedMerge = Boolean(
      mergeStats && mergeStats.localAdds + mergeStats.localMods >= 1
    )
    record('pdf-extrefresh-dirty-merge-preserves-local', converged && localEditSurvivedMerge, {
      noteWritten,
      mergeStats,
      records: getViewer()!.textSelection.annotationRecords(),
      dirty: getViewer()!.textSelection.isDirty()
    })

    // Cleanup for the reopen check: drop the merged annotation.
    getViewer()!.textSelection.deleteFirstAnnotation()
    await sleep(150)
    await getViewer()!.textSelection.saveNow()
  }

  // ---------- reopening after an external change is never stale ----------

  {
    await window.electronAPI.debug.writeExternalFile({
      root: rootPath,
      relPath: OTHER_NAME,
      content: '# parked here while the PDF changes\n'
    })
    await getApi()?.openFileByPathAsUser?.(`${rootPath.replace(/[\\/]+$/, '')}/${OTHER_NAME}`)
    await waitFor('pdf-extrefresh-parked', () => getApi()?.isPdfReaderVisible?.() !== true, 8000)

    await writeExternal(annotatedBase64, true)
    await sleep(300)

    await getApi()?.openFileByPathAsUser?.(`${rootPath.replace(/[\\/]+$/, '')}/${PDF_NAME}`)
    const reopened = await waitFor('pdf-extrefresh-reopen', () => {
      const v = getViewer()
      return Boolean(v && v.textSelection.annotationCount() === 1)
    }, 15000, 200)
    record('pdf-extrefresh-reopen-not-stale', reopened, {
      count: getViewer()?.textSelection.annotationCount() ?? -1
    })
  }

  log('pdf-extrefresh:done', { total: results.length })
  return results
}
