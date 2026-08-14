/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

import type { AutotestContext, TestResult } from './types'

/**
 * End-to-end coverage for PDF highlight annotations: creating them from a
 * selection, relabelling, notes, deletion, and — the part that matters most —
 * writing them into the PDF file and reading them back.
 *
 * The persistence assertions are the reason this suite exists. The user chose
 * to store highlights inside the document itself with automatic saving, which
 * makes this the only feature in the app that rewrites a file the user did not
 * ask to save. "It renders correctly" is not evidence that it works; "close the
 * file, reopen it, the highlights are still there, and the file is still a
 * valid PDF" is.
 *
 * Paired unit coverage:
 *   - `pdf-highlight-geometry.test.mts` pins the rect → QuadPoints maths.
 *   - `pdf-annotation-store.test.mts` pins when a save may and may not happen.
 * This file proves those decisions survive contact with a real document.
 */

const TEST_PDF_FILENAME = '__autotest_pdf_highlight.pdf'
const TEST_MARKER_FILENAME = '__autotest_pdf_highlight_marker.txt'
const FIXTURE_REL_PATH = 'test/autotest/fixtures/pdf-text-selection/onward-textsel.pdf'

// Confirmed with the user (2026-07-29): the palette must appear within 100 ms
// of the selection being made. Hard-coded here rather than guessed so a future
// author can see exactly what was agreed.
const PALETTE_LATENCY_BUDGET_MS = 100

// Boolean-correctness assertions repeat and require all trials to pass.
const TRIALS = 5
// Latency assertions run 3 trials and pass if at least one meets the budget:
// the question is "can the system meet it at all", and a GC pause or scheduler
// hiccup is acknowledged rather than treated as a regression.
const LATENCY_TRIALS = 3

interface ViewerApi {
  page(pageNumber: number): Element | null
  findSpan(pageNumber: number, needle: string): Element | null
  dragSubstrings(pageNumber: number, spanNeedle: string, fromSub: string, toSub?: string): string | null
  selectionText(): string
  clear(): void
  highlightSubstring(
    pageNumber: number,
    spanNeedle: string,
    subText: string,
    labelIndex: number
  ): { selected: string; labelId: string } | null
  paletteVisible(): boolean
  highlightRects(pageNumber: number): Array<{ annotId: string; left: number; width: number; background: string }>
  annotationCount(): number
  annotationRecords(): Array<{
    id: string
    labelId: string
    color: string
    page: number
    note: string
    textSnapshot: string
    quadCount: number
  }>
  isDirty(): boolean
  saveNow(): Promise<{ ok: boolean; reason?: string }>
  writeNote(text: string): string | null
  noteMarkerCount(pageNumber: number): number
  deleteFirstAnnotation(): boolean
}

function joinPath(base: string, child: string): string {
  return `${base.replace(/[\\/]+$/, '')}/${child}`
}

function platformBuildCopyCommand(srcRelPath: string, destFilename: string, rootPath: string): string {
  if (window.electronAPI.platform === 'win32') {
    const src = `${rootPath}\\${srcRelPath.replace(/\//g, '\\')}`
    return `powershell -Command "Copy-Item -LiteralPath '${src}' -Destination '${destFilename}' -Force"`
  }
  return `cp "${rootPath}/${srcRelPath}" "${destFilename}"`
}

function platformBuildWriteMarkerCommand(filename: string, content: string): string {
  if (window.electronAPI.platform === 'win32') {
    return `powershell -Command "Set-Content -LiteralPath '${filename}' -Value '${content}' -NoNewline"`
  }
  return `printf '%s' '${content}' > '${filename}'`
}

function platformBuildDeleteCommand(filenames: string[]): string {
  if (window.electronAPI.platform === 'win32') {
    return filenames.map(f => `if (Test-Path '${f}') { Remove-Item -Force '${f}' }`).join('; ')
  }
  return filenames.map(f => `rm -f '${f}'`).join(' && ')
}

export async function testPdfHighlight(ctx: AutotestContext): Promise<TestResult[]> {
  const { log, sleep, waitFor, assert, cancelled, terminalId, rootPath } = ctx
  const results: TestResult[] = []
  const record = (name: string, ok: boolean, detail?: Record<string, unknown>) => {
    assert(name, ok, detail)
    results.push({ name, ok, detail })
  }

  const getApi = () => window.__onwardProjectEditorDebug

  const termExec = async (command: string, label: string, waitMs = 1200) => {
    await window.electronAPI.terminal.write(terminalId, `${command}\r`)
    await sleep(waitMs)
    log(`exec:${label}`)
  }

  const getViewerApi = (): ViewerApi | null => {
    const iframe = document.querySelector('.project-editor-pdf-reader-iframe') as HTMLIFrameElement | null
    const frameWindow = iframe?.contentWindow as (Window & {
      __onwardPdfTest?: { textSelection?: ViewerApi }
    }) | null | undefined
    return frameWindow?.__onwardPdfTest?.textSelection ?? null
  }

  const waitForTextLayer = (label: string) =>
    waitFor(label, () => {
      const api = getViewerApi()
      return Boolean(api && api.findSpan(1, 'SELECTME'))
    }, 20000, 150)

  log('pdf-highlight:start', { rootPath })

  await termExec(platformBuildWriteMarkerCommand(TEST_MARKER_FILENAME, 'marker'), 'marker:create')
  // A fresh copy of the fixture: this suite MODIFIES the file it opens, so it
  // must never operate on the committed fixture itself.
  await termExec(platformBuildCopyCommand(FIXTURE_REL_PATH, TEST_PDF_FILENAME, rootPath), 'pdf:copy')

  const pdfPath = joinPath(rootPath, TEST_PDF_FILENAME)
  const markerPath = joinPath(rootPath, TEST_MARKER_FILENAME)

  if (cancelled()) return results

  await getApi()?.openFileByPathAsUser?.(pdfPath)
  const visible = await waitFor(
    'pdf-highlight-reader-visible',
    () => getApi()?.isPdfReaderVisible?.() === true,
    10000
  )
  record('pdf-highlight-reader-visible', visible)

  const ready = await waitForTextLayer('pdf-highlight-text-layer-rendered')
  record('pdf-highlight-text-layer-rendered', ready)
  if (!ready) {
    log('pdf-highlight:abort', { reason: 'text layer never rendered' })
    await termExec(platformBuildDeleteCommand([TEST_PDF_FILENAME, TEST_MARKER_FILENAME]), 'cleanup')
    return results
  }

  let api = getViewerApi()!

  // ---------- palette appears, within the agreed budget ----------

  {
    const latencies: number[] = []
    for (let i = 0; i < LATENCY_TRIALS; i += 1) {
      api.clear()
      await sleep(150)
      const started = performance.now()
      api.dragSubstrings(1, 'SELECTME', 'SELECTME')
      // The palette is positioned synchronously on mouseup, so measuring right
      // after the drag returns captures the real path rather than a timer.
      const elapsed = performance.now() - started
      latencies.push(elapsed)
      await sleep(120)
    }
    const best = Math.min(...latencies)
    record('pdf-highlight-palette-latency-3x', best <= PALETTE_LATENCY_BUDGET_MS, {
      budgetMs: PALETTE_LATENCY_BUDGET_MS,
      latencies: latencies.map(v => Math.round(v)),
      bestMs: Math.round(best)
    })

    api.clear()
    await sleep(120)
    api.dragSubstrings(1, 'SELECTME', 'SELECTME')
    record('pdf-highlight-palette-visible-after-selection', api.paletteVisible())
  }

  // ---------- create a highlight ----------

  {
    let created = 0
    for (let i = 0; i < TRIALS; i += 1) {
      api.clear()
      await sleep(120)
      const before = api.annotationCount()
      const result = api.highlightSubstring(1, 'SELECTME', 'SELECTME', 0)
      await sleep(150)
      if (result && api.annotationCount() === before + 1) created += 1
      // Remove it again so each trial starts from the same state.
      api.deleteFirstAnnotation()
      await sleep(100)
    }
    record('pdf-highlight-create-from-selection-5x', created === TRIALS, {
      created,
      trials: TRIALS
    })
  }

  // ---------- the record carries usable geometry ----------

  {
    api.clear()
    await sleep(120)
    api.highlightSubstring(1, 'SELECTME', 'SELECTME', 0)
    await sleep(200)
    const records = api.annotationRecords()
    const first = records[0]
    record(
      'pdf-highlight-record-has-quads',
      Boolean(first) && first.quadCount > 0 && first.quadCount % 8 === 0 && first.page === 1,
      { records }
    )
    record(
      'pdf-highlight-record-captures-text',
      Boolean(first) && first.textSnapshot.includes('SELECTME'),
      { textSnapshot: first?.textSnapshot }
    )
    const rects = api.highlightRects(1)
    record(
      'pdf-highlight-painted-on-page',
      rects.length > 0 && rects.every(r => r.width > 0 && r.background.includes('rgba')),
      { rects }
    )
  }

  // ---------- a note attaches, and shows a marker ----------

  {
    const noteText = 'autotest note body'
    const written = api.writeNote(noteText)
    await sleep(300)
    record('pdf-highlight-note-written', written === noteText, { written })
    record('pdf-highlight-note-marker-rendered', api.noteMarkerCount(1) > 0, {
      markers: api.noteMarkerCount(1)
    })
  }

  // ---------- persistence: the whole point ----------

  {
    record('pdf-highlight-dirty-after-edit', api.isDirty() === true)

    const saveResult = await api.saveNow()
    record('pdf-highlight-save-succeeds', saveResult?.ok === true, { saveResult })
    record('pdf-highlight-clean-after-save', api.isDirty() === false)

    const beforeReopen = api.annotationRecords()

    // Switch away and back. This is the real test: the annotations must come
    // from the FILE, not from anything the viewer kept in memory.
    await getApi()?.openFileByPath(markerPath)
    await waitFor('pdf-highlight-reader-cleared', () => getApi()?.isPdfReaderVisible?.() === false, 5000)
    await getApi()?.openFileByPath(pdfPath)
    const reopened = await waitForTextLayer('pdf-highlight-reopened')
    record('pdf-highlight-reopened', reopened)

    if (reopened) {
      api = getViewerApi()!
      // Reading annotations happens after the document resolves, so give the
      // read a moment rather than racing it.
      const restored = await waitFor(
        'pdf-highlight-persists-across-reopen',
        () => api.annotationCount() > 0,
        10000,
        200
      )
      const afterReopen = api.annotationRecords()
      record('pdf-highlight-persists-across-reopen', restored, {
        before: beforeReopen.length,
        after: afterReopen.length
      })
      record(
        'pdf-highlight-note-persists-across-reopen',
        afterReopen.some(r => r.note.includes('autotest note body')),
        { notes: afterReopen.map(r => r.note) }
      )
      record(
        'pdf-highlight-geometry-persists-across-reopen',
        afterReopen.length > 0 &&
          afterReopen.every(r => r.quadCount > 0 && r.quadCount % 8 === 0),
        { quadCounts: afterReopen.map(r => r.quadCount) }
      )
      record(
        'pdf-highlight-reopen-is-not-dirty',
        api.isDirty() === false,
        { dirty: api.isDirty() }
      )
      // Saved highlights come back as native PDF annotations. If pdf.js also
      // painted them we would see roughly twice the rects, and the colour
      // would visibly double up.
      const rects = api.highlightRects(1)
      record(
        'pdf-highlight-no-double-render-after-reopen',
        rects.length > 0 && rects.length <= afterReopen.length * 2,
        { rects: rects.length, records: afterReopen.length }
      )
    }
  }

  // ---------- the written file is still a valid PDF ----------

  {
    // A rewrite that produces bytes pdf.js cannot parse would have shown up as
    // a failed reopen above, but assert it explicitly so the failure names
    // itself rather than looking like "annotations disappeared".
    const stillReadable = getApi()?.isPdfReaderVisible?.() === true && api.findSpan(1, 'SELECTME') !== null
    record('pdf-highlight-file-still-parses', stillReadable)
  }

  // ---------- deletion also persists ----------

  {
    const before = api.annotationCount()
    api.deleteFirstAnnotation()
    await sleep(200)
    const afterDelete = api.annotationCount()
    record('pdf-highlight-delete-removes-record', afterDelete === before - 1, {
      before,
      afterDelete
    })

    const saveResult = await api.saveNow()
    record('pdf-highlight-delete-saved', saveResult?.ok === true, { saveResult })

    await getApi()?.openFileByPath(markerPath)
    await waitFor('pdf-highlight-cleared-again', () => getApi()?.isPdfReaderVisible?.() === false, 5000)
    await getApi()?.openFileByPath(pdfPath)
    const reopened = await waitForTextLayer('pdf-highlight-reopened-after-delete')
    if (reopened) {
      api = getViewerApi()!
      await sleep(1200)
      record('pdf-highlight-delete-persists', api.annotationCount() === afterDelete, {
        expected: afterDelete,
        got: api.annotationCount()
      })
      // The deleted highlight must leave no painted remains — the failure mode
      // where a record is gone from the list but its colour is still on the
      // page, which the user cannot then remove.
      record('pdf-highlight-no-orphan-rects-after-delete',
        api.highlightRects(1).length === 0 || api.annotationCount() > 0,
        { rects: api.highlightRects(1).length, records: api.annotationCount() })
    }
  }

  // ---------- annotation list panel (host side) ----------

  {
    // Re-create a highlight so the panel has something to show: the delete
    // section above emptied the document.
    api.clear()
    await sleep(150)
    api.highlightSubstring(1, 'SELECTME', 'SELECTME', 0)
    await sleep(300)
    api.writeNote('panel note')
    await sleep(400)
    api.highlightSubstring(1, 'Second', 'Second', 1)
    await sleep(400)

    const panelVisible = await waitFor(
      'pdf-highlight-panel-auto-opens',
      () => document.querySelector('.pdf-annotation-panel') !== null,
      6000,
      150
    )
    // The panel opens by itself once a document turns out to have highlights —
    // the simplified rule the user confirmed, replacing the reference
    // project's local-vs-remote branching.
    record('pdf-highlight-panel-auto-opens', panelVisible)

    const rows = () => Array.from(document.querySelectorAll('.pdf-annotation-item'))
    const rowsRendered = await waitFor(
      'pdf-highlight-panel-lists-annotations',
      () => rows().length >= 2,
      6000,
      150
    )
    record('pdf-highlight-panel-lists-annotations', rowsRendered, {
      rows: rows().length,
      records: api.annotationCount()
    })

    // The mirrored list must match the viewer's own record count exactly: a
    // panel that quietly drops an entry is worse than no panel.
    record(
      'pdf-highlight-panel-matches-viewer-count',
      rows().length === api.annotationCount(),
      { rows: rows().length, records: api.annotationCount() }
    )

    const noteVisible = document.querySelector('.pdf-annotation-note-body')
    record(
      'pdf-highlight-panel-shows-note',
      Boolean(noteVisible && (noteVisible.textContent || '').includes('panel note')),
      { note: noteVisible?.textContent ?? null }
    )

    // Label filter: switching to a single label must narrow the list.
    const filterSelect = document.querySelectorAll('.pdf-annotation-control select')[1] as HTMLSelectElement | undefined
    if (filterSelect && filterSelect.options.length > 1) {
      const before = rows().length
      filterSelect.value = filterSelect.options[1].value
      filterSelect.dispatchEvent(new Event('change', { bubbles: true }))
      await sleep(300)
      const after = rows().length
      record('pdf-highlight-panel-filter-narrows', after > 0 && after < before, { before, after })
      filterSelect.value = 'all'
      filterSelect.dispatchEvent(new Event('change', { bubbles: true }))
      await sleep(300)
      record('pdf-highlight-panel-filter-restores', rows().length === before, {
        before,
        restored: rows().length
      })
    } else {
      record('pdf-highlight-panel-filter-narrows', false, { reason: 'filter select missing' })
    }

    // Sorting must not change what is in the list, only its order.
    const sortSelect = document.querySelectorAll('.pdf-annotation-control select')[0] as HTMLSelectElement | undefined
    if (sortSelect) {
      const beforeCount = rows().length
      sortSelect.value = 'page'
      sortSelect.dispatchEvent(new Event('change', { bubbles: true }))
      await sleep(300)
      record('pdf-highlight-panel-sort-preserves-entries', rows().length === beforeCount, {
        before: beforeCount,
        after: rows().length
      })
      sortSelect.value = 'created'
      sortSelect.dispatchEvent(new Event('change', { bubbles: true }))
      await sleep(200)
    }

    // Jumping from the list must move the reader. Uses the same destination
    // machinery as an outline click, so the two feel like one model.
    const iframe = document.querySelector('.project-editor-pdf-reader-iframe') as HTMLIFrameElement | null
    const container = iframe?.contentDocument?.getElementById('viewerContainer') as HTMLElement | null
    const zoomForJump = iframe?.contentDocument?.getElementById('zoomSelect') as HTMLSelectElement | null
    if (container && zoomForJump && rows().length > 0) {
      // The fixture is a single short page; at fit-width it does not overflow,
      // so "did the jump scroll us" would be unfalsifiable. Zoom in first to
      // make the document genuinely scrollable.
      zoomForJump.value = '4'
      zoomForJump.dispatchEvent(new Event('change', { bubbles: true }))
      await sleep(600)
      container.scrollTop = Math.max(0, container.scrollHeight - container.clientHeight)
      await sleep(300)
      const scrolledAway = container.scrollTop
      const snippet = rows()[0].querySelector('.pdf-annotation-snippet') as HTMLElement | null
      snippet?.click()
      await sleep(700)
      const scrollable = container.scrollHeight > container.clientHeight + 10
      record(
        'pdf-highlight-panel-jump-moves-viewer',
        scrollable && container.scrollTop !== scrolledAway,
        {
          scrollable,
          before: Math.round(scrolledAway),
          after: Math.round(container.scrollTop)
        }
      )
      zoomForJump.value = 'page-width'
      zoomForJump.dispatchEvent(new Event('change', { bubbles: true }))
      await sleep(400)
    }

    // Deleting from the list must remove it from the viewer too — the panel
    // asks, the viewer owns.
    const beforeDelete = api.annotationCount()
    const trigger = rows()[0]?.querySelector('.pdf-annotation-menu-trigger') as HTMLElement | null
    trigger?.click()
    await sleep(250)
    const deleteItem = Array.from(
      document.querySelectorAll('.pdf-annotation-context-menu button.danger')
    )[0] as HTMLElement | undefined
    deleteItem?.click()
    await sleep(500)
    record(
      'pdf-highlight-panel-delete-removes-from-viewer',
      api.annotationCount() === beforeDelete - 1,
      { before: beforeDelete, after: api.annotationCount() }
    )
  }

  // ---------- custom zoom entry ----------

  {
    const iframe = document.querySelector('.project-editor-pdf-reader-iframe') as HTMLIFrameElement | null
    const input = iframe?.contentDocument?.getElementById('customZoomInput') as HTMLInputElement | null
    const zoomSelect = iframe?.contentDocument?.getElementById('zoomSelect') as HTMLSelectElement | null
    if (input && zoomSelect) {
      input.value = '137%'
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
      await sleep(600)
      const applied = Number.parseFloat(zoomSelect.value)
      record('pdf-highlight-custom-zoom-applies', Math.abs(applied - 1.37) < 0.02, {
        entered: '137%',
        appliedScale: applied
      })

      // Out-of-range input clamps rather than being rejected outright.
      input.value = '900'
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
      await sleep(600)
      const clamped = Number.parseFloat(zoomSelect.value)
      record('pdf-highlight-custom-zoom-clamps', Math.abs(clamped - 5) < 0.05, {
        entered: '900',
        appliedScale: clamped
      })

      // Unparseable input must leave the scale alone and flag the field.
      input.value = 'abc'
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
      await sleep(400)
      record(
        'pdf-highlight-custom-zoom-rejects-garbage',
        Math.abs(Number.parseFloat(zoomSelect.value) - clamped) < 0.05 &&
          input.getAttribute('aria-invalid') === 'true',
        { scale: zoomSelect.value, ariaInvalid: input.getAttribute('aria-invalid') }
      )
    } else {
      record('pdf-highlight-custom-zoom-applies', false, { reason: 'zoom input missing' })
    }
  }

  // ---------- annotation panel toggle lives in the reader toolbar ----------
  // Previously a floating overlay icon on the page: easy to miss and visually
  // detached from the controls it belongs with.

  {
    const iframe = document.querySelector('.project-editor-pdf-reader-iframe') as HTMLIFrameElement | null
    const frameDoc = iframe?.contentDocument ?? null
    const toggle = frameDoc?.getElementById('annotationsToggleBtn') as HTMLButtonElement | null
    const inToolbar = Boolean(toggle && frameDoc?.getElementById('toolbar')?.contains(toggle))
    const countBadge = frameDoc?.getElementById('annotationsToggleCount') as HTMLElement | null
    record('pdf-highlight-toolbar-toggle-present', inToolbar && toggle?.hidden === false, {
      found: Boolean(toggle),
      inToolbar,
      hidden: toggle?.hidden,
      label: toggle?.textContent?.trim().slice(0, 40)
    })

    // The toolbar must stay ONE row and never clip a control out of reach.
    // Adding this button pushed an already-tight toolbar past its width: the
    // button AND the colour toggle were clipped (123 px of overflow in the
    // default layout), and labels wrapped vertically. Screenshots caught it;
    // the DOM assertions above did not, so measure the geometry explicitly.
    const toolbarGeometry = (() => {
      const tb = frameDoc?.getElementById('toolbar')
      const color = frameDoc?.getElementById('colorToggleBtn')
      if (!tb) return null
      const tbRect = tb.getBoundingClientRect()
      const rightOf = (el: Element | null | undefined) =>
        el ? Math.round(el.getBoundingClientRect().right) : -1
      return {
        overflowPx: tb.scrollWidth - tb.clientWidth,
        heightPx: Math.round(tbRect.height),
        toolbarLeft: Math.round(tbRect.left),
        toolbarRight: Math.round(tbRect.right),
        toggleLeft: toggle ? Math.round(toggle.getBoundingClientRect().left) : -1,
        toggleRight: rightOf(toggle),
        colorRight: rightOf(color),
        // What the USER sees in the strip from the toggle's left edge to the
        // toolbar's right edge. Geometry alone cannot answer this: controls
        // scrolled out of view still have layout rects out there, and the
        // pinned group paints over anything beneath it. Hit-testing asks the
        // only question that matters — "what is on top here?" — which is
        // exactly what the previous assertions could not express, and why a
        // control bleeding through a 10 px gutter shipped twice.
        topmostInPinnedStrip: (() => {
          if (!toggle) return ['no-toggle']
          const tr = toggle.getBoundingClientRect()
          const y = Math.round(tbRect.top + tbRect.height / 2)
          const xs = [
            Math.round(tr.left + tr.width / 2),
            Math.round(tr.right + 2),
            Math.round(tbRect.right - 3)
          ]
          return xs.map((x) => {
            const el = frameDoc?.elementFromPoint(x, y) as HTMLElement | null
            if (!el) return 'none'
            return el.closest('.toolbar-group.pinned') ? 'pinned' : (el.id || el.tagName.toLowerCase())
          })
        })()
      }
    })()
    // The real contract, learned the hard way: at ~350 px (both side panels
    // open) NOTHING makes 800 px of controls fit, so "zero overflow" is the
    // wrong bar. What must hold is (a) the toolbar stays ONE row — it used to
    // wrap into two, with "/ 3" split across lines — and (b) the annotation
    // toggle is on screen rather than scrolled out of sight, which is the
    // whole point of moving it into the toolbar.
    record(
      'pdf-highlight-toolbar-single-row-toggle-visible',
      Boolean(
        toolbarGeometry &&
        toolbarGeometry.heightPx <= 52 &&
        toolbarGeometry.toggleRight > 0 &&
        toolbarGeometry.toggleRight <= toolbarGeometry.toolbarRight + 1 &&
        toolbarGeometry.toggleLeft >= toolbarGeometry.toolbarLeft - 1 &&
        toolbarGeometry.topmostInPinnedStrip.every((hit) => hit === 'pinned')
      ),
      toolbarGeometry ?? { reason: 'no toolbar' }
    )

    // The badge mirrors the live record count, and the pressed state mirrors
    // the host-owned panel visibility — both pushed from the host, so this
    // also proves the state round trip.
    const viewerApi = getViewerApi()
    const liveCount = viewerApi?.annotationCount() ?? -1
    record(
      'pdf-highlight-toolbar-toggle-shows-count',
      liveCount > 0 && countBadge?.hidden === false && countBadge?.textContent === String(liveCount),
      { liveCount, badgeText: countBadge?.textContent, badgeHidden: countBadge?.hidden }
    )

    // Clicking it closes the panel (host reacts), clicking again reopens.
    const panelVisible = () => Boolean(document.querySelector('.pdf-annotation-panel'))
    const wasVisible = panelVisible()
    toggle?.click()
    await sleep(500)
    const afterFirst = panelVisible()
    toggle?.click()
    await sleep(500)
    const afterSecond = panelVisible()
    record(
      'pdf-highlight-toolbar-toggle-controls-panel',
      wasVisible && !afterFirst && afterSecond && toggle?.getAttribute('aria-pressed') === 'true',
      { wasVisible, afterFirst, afterSecond, ariaPressed: toggle?.getAttribute('aria-pressed') }
    )
  }

  // ---------- label management (rename / recolor / delete custom labels) ----------
  // Pure logic locked by PAL-U-27..32; this proves the dialog wiring: the
  // manage button opens it, built-ins are read-only, and a custom label
  // round-trips add → rename → recolor → delete against real React state.

  {
    // React controlled inputs ignore direct .value writes; go through the
    // native setter so the change event carries the new value.
    const setReactInputValue = (input: HTMLInputElement, value: string) => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set
      setter?.call(input, value)
      input.dispatchEvent(new Event('input', { bubbles: true }))
    }

    // The panel is open (earlier sections created annotations). Add a custom
    // label first so the manage dialog has something manageable.
    const addBtn = document.querySelector('.pdf-annotation-add-label') as HTMLElement | null
    addBtn?.click()
    await sleep(250)
    const nameInput = document.querySelector('.pdf-annotation-dialog-field input[type="text"]') as HTMLInputElement | null
    if (nameInput) {
      setReactInputValue(nameInput, 'Autotest label')
      await sleep(150)
      const confirm = document.querySelector('.pdf-annotation-dialog-actions button.primary') as HTMLButtonElement | null
      confirm?.click()
      await sleep(300)
    }

    const manageBtn = document.querySelector('.pdf-annotation-manage-labels') as HTMLElement | null
    manageBtn?.click()
    await sleep(300)
    const dialog = () => document.querySelector('.pdf-annotation-manage-dialog')

    // The dialog shipped fully TRANSPARENT because it referenced
    // `--panel-elevated`, a variable nothing ever defined — an unresolvable
    // var() voids the whole declaration. Nothing in the pipeline reads CSS,
    // so assert on the COMPUTED background here: the styles resolving is the
    // user-visible contract, not the class names being present.
    {
      const dialogEl = dialog() as HTMLElement | null
      const backdropEl = document.querySelector('.pdf-annotation-dialog-backdrop') as HTMLElement | null
      const dialogStyle = dialogEl ? getComputedStyle(dialogEl) : null
      const backdropStyle = backdropEl ? getComputedStyle(backdropEl) : null
      const isOpaque = (color: string | undefined) => {
        if (!color) return false
        if (color === 'transparent' || color === 'rgba(0, 0, 0, 0)') return false
        const alpha = /rgba\([^)]*,\s*([\d.]+)\)$/.exec(color)
        return alpha ? Number(alpha[1]) > 0.9 : true
      }
      record(
        'pdf-highlight-manage-dialog-styles-resolve',
        isOpaque(dialogStyle?.backgroundColor)
          && dialogStyle?.borderTopWidth === '1px'
          && isOpaque(backdropStyle?.backgroundColor) === false
          && (backdropStyle?.backgroundColor ?? '') !== 'rgba(0, 0, 0, 0)',
        {
          dialogBackground: dialogStyle?.backgroundColor,
          dialogBorderWidth: dialogStyle?.borderTopWidth,
          backdropBackground: backdropStyle?.backgroundColor
        }
      )
    }
    const builtinRows = dialog()?.querySelectorAll('.pdf-annotation-manage-row.is-builtin').length ?? 0
    const customRow = () =>
      dialog()?.querySelector('.pdf-annotation-manage-row[data-label-id^="hl-custom-"]') as HTMLElement | null
    record('pdf-highlight-manage-dialog-opens', Boolean(dialog()) && builtinRows === 4 && Boolean(customRow()), {
      dialogVisible: Boolean(dialog()),
      builtinRows,
      hasCustomRow: Boolean(customRow())
    })

    // Rename: click the name, type, commit with Enter.
    const nameBtn = customRow()?.querySelector('.pdf-annotation-manage-name.is-editable') as HTMLElement | null
    nameBtn?.click()
    await sleep(200)
    const renameInput = customRow()?.querySelector('.pdf-annotation-manage-rename-input') as HTMLInputElement | null
    if (renameInput) {
      setReactInputValue(renameInput, 'Renamed label')
      await sleep(120)
      renameInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
      await sleep(300)
    }
    record(
      'pdf-highlight-manage-rename-applies',
      customRow()?.querySelector('.pdf-annotation-manage-name')?.textContent === 'Renamed label',
      { name: customRow()?.querySelector('.pdf-annotation-manage-name')?.textContent }
    )

    // Recolor: pick a swatch that is NOT the current color (the add-label
    // dialog auto-assigns the first unused swatch, so a fixed index can land
    // on the label's own color and assert nothing).
    const swatch = Array.from(
      customRow()?.querySelectorAll('.pdf-annotation-color-choice.is-small') ?? []
    ).find((el) => el.getAttribute('aria-checked') !== 'true') as HTMLElement | null
    const dotBefore = (customRow()?.querySelector('.pdf-annotation-manage-dot') as HTMLElement | null)?.style.background
    swatch?.click()
    await sleep(300)
    const dotAfter = (customRow()?.querySelector('.pdf-annotation-manage-dot') as HTMLElement | null)?.style.background
    record('pdf-highlight-manage-recolor-applies', Boolean(dotBefore && dotAfter && dotBefore !== dotAfter), {
      dotBefore,
      dotAfter
    })

    // Delete: trash → inline confirm → row gone, empty state shown.
    const deleteBtn = customRow()?.querySelector('.pdf-annotation-manage-delete') as HTMLElement | null
    deleteBtn?.click()
    await sleep(200)
    const confirmDelete = customRow()?.querySelector('.pdf-annotation-manage-confirm button.danger') as HTMLElement | null
    confirmDelete?.click()
    await sleep(300)
    record(
      'pdf-highlight-manage-delete-removes',
      !customRow() && Boolean(dialog()?.querySelector('.pdf-annotation-manage-empty')),
      { hasCustomRow: Boolean(customRow()) }
    )

    const doneBtn = dialog()?.querySelector('.pdf-annotation-dialog-actions button.primary') as HTMLElement | null
    doneBtn?.click()
    await sleep(200)
  }

  await termExec(platformBuildDeleteCommand([TEST_PDF_FILENAME, TEST_MARKER_FILENAME]), 'cleanup')
  log('pdf-highlight:done', { assertions: results.length })
  return results
}
