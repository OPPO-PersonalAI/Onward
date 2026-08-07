/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

import type { AutotestContext, TestResult } from './types'
import { parsePdfEpubPreviewGroup } from './pdf-epub-preview-group'

/**
 * Fixtures live on disk under `test/autotest/fixtures/pdf-epub/` (see CLAUDE.md rule
 * "fixture files must live on disk"). The test copies them into `rootPath`
 * via a terminal command so the flow mirrors what a user would see in the
 * Files panel. Regenerate with `node test/autotest/fixtures/pdf-epub-fixture-builder.mjs --write`.
 */

const TEST_PDF_FILENAME = '__autotest_pdf_preview.pdf'
const TEST_PDF_OUTLINE_FILENAME = '__autotest_pdf_preview_outlined.pdf'
const TEST_EPUB_FILENAME = '__autotest_epub_preview.epub'
const TEST_MARKER_FILENAME = '__autotest_pdf_epub_marker.txt'

const FIXTURE_REL_DIR = 'test/autotest/fixtures/pdf-epub'
const PDF_FIXTURE_SRC = 'onward-autotest.pdf'
const PDF_OUTLINE_FIXTURE_SRC = 'onward-autotest.outlined.pdf'
const EPUB_FIXTURE_SRC = 'onward-autotest.epub'

function joinPath(base: string, child: string): string {
  const trimmed = base.replace(/[\\/]+$/, '')
  return `${trimmed}/${child}`
}

// Build a `cp`-style command that copies a repo-relative fixture into the
// test's cwd (which is `rootPath`). POSIX uses `cp`, Windows PowerShell uses
// `Copy-Item` — both quote paths to handle spaces safely.
function platformBuildCopyCommand(srcRelPath: string, destFilename: string, rootPath: string): string {
  if (window.electronAPI.platform === 'win32') {
    const src = `${rootPath}\\${srcRelPath.replace(/\//g, '\\')}`
    return `powershell -Command "Copy-Item -LiteralPath '${src}' -Destination '${destFilename}' -Force"`
  }
  const src = `${rootPath}/${srcRelPath}`
  return `cp "${src}" "${destFilename}"`
}

function platformBuildDeleteCommand(filenames: string[]): string {
  if (window.electronAPI.platform === 'win32') {
    return filenames.map(f => `if (Test-Path '${f}') { Remove-Item -Force '${f}' }`).join('; ')
  }
  return filenames.map(f => `rm -f '${f}'`).join(' && ')
}

// Write a small scratch marker file into the test's cwd. Must be platform-aware
// like the copy/delete builders above: the previous raw `printf '%s' '…' > '…'`
// is a POSIX-only idiom, and when the terminal shell is NOT bash (Windows
// PowerShell/cmd) the single quotes around the redirect target are NOT stripped,
// so the file is created with LITERAL quotes in its name (observed:
// `'__autotest_pdf_epub_marker.txt'`). That quoted name then evades BOTH the
// runner EXIT-trap sweep and the orchestrator sweep (both key on the unquoted
// `__autotest_` prefix), leaking into the working tree. Explicitly invoking
// PowerShell with Set-Content -LiteralPath (mirroring platformBuildCopyCommand)
// guarantees a correctly-named file regardless of the terminal's default shell.
function platformBuildWriteMarkerCommand(filename: string, content: string): string {
  if (window.electronAPI.platform === 'win32') {
    return `powershell -Command "Set-Content -LiteralPath '${filename}' -Value '${content}' -NoNewline"`
  }
  return `printf '%s' '${content}' > '${filename}'`
}

export async function testPdfEpubPreview(ctx: AutotestContext): Promise<TestResult[]> {
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
    log(`exec:${label}`, { command: command.length > 120 ? `${command.slice(0, 120)}…` : command })
  }

  // Budget split (5-min gate): three group runners partition the suite;
  // absent token runs everything (umbrella / standalone). See
  // pdf-epub-preview-group.ts for the group map + EDR-host sizing rationale.
  const previewGroup = parsePdfEpubPreviewGroup(window.electronAPI.debug.autotestSuite)
  const runPdfCore = previewGroup === 'pdf' || previewGroup === 'all'
  const runPdfOutline = previewGroup === 'pdf-outline' || previewGroup === 'all'
  const runEpub = previewGroup === 'epub' || previewGroup === 'all'

  log('pdf-epub-preview:start', { rootPath, group: previewGroup })

  // Prepare a scratch marker file first so we can reliably switch off the
  // PDF/EPUB view between assertions.
  await termExec(
    platformBuildWriteMarkerCommand(TEST_MARKER_FILENAME, 'onward-autotest-marker'),
    'marker:create'
  )

  // Copy PDF + EPUB fixtures from the on-disk test fixture directory into the
  // project's root so the Files panel can pick them up. Each group copies only
  // its own fixture (the cleanup delete-command is missing-file tolerant; the
  // pdf-outline group copies its outlined fixture inside its own section).
  if (runPdfCore) {
    await termExec(
      platformBuildCopyCommand(`${FIXTURE_REL_DIR}/${PDF_FIXTURE_SRC}`, TEST_PDF_FILENAME, rootPath),
      'pdf:copy',
      1200
    )
  }
  if (runEpub) {
    await termExec(
      platformBuildCopyCommand(`${FIXTURE_REL_DIR}/${EPUB_FIXTURE_SRC}`, TEST_EPUB_FILENAME, rootPath),
      'epub:copy',
      1200
    )
  }

  const pdfPath = joinPath(rootPath, TEST_PDF_FILENAME)
  const epubPath = joinPath(rootPath, TEST_EPUB_FILENAME)
  const markerPath = joinPath(rootPath, TEST_MARKER_FILENAME)

  if (cancelled()) return results

  // ── group gate: pdf core (budget split) — original indentation retained to
  // keep the diff reviewable; the block runs verbatim when gated in. ──
  if (runPdfCore) {

  // ---------- PDF preview ----------

  log('pdf:open', { pdfPath })
  // Open as a "user" action so the file is added to Recent — matches what
  // happens when the user clicks the file in the tree.
  await getApi()?.openFileByPathAsUser?.(pdfPath)
  const pdfVisible = await waitFor(
    'pdf-reader-visible',
    () => getApi()?.isPdfReaderVisible?.() === true,
    10000
  )
  record('pdf-reader-visible', pdfVisible, { filename: TEST_PDF_FILENAME })

  // Listen for the "onward:pdf:ready" postMessage that the embedded viewer
  // emits once it has loaded pdf.js. This is the closest proxy for "the user
  // sees the PDF" without cracking open a cross-origin iframe.
  let viewerReady = false
  const readyListener = (event: MessageEvent) => {
    if (event?.data?.type === 'onward:pdf:ready') viewerReady = true
  }
  window.addEventListener('message', readyListener)

  const iframeMounted = await waitFor(
    'pdf-reader-iframe-mounted',
    () => Boolean(getApi()?.getPdfReaderState?.()?.visible),
    8000
  )
  const pdfState = getApi()?.getPdfReaderState?.() ?? null
  record('pdf-reader-iframe-mounted', iframeMounted, { state: pdfState })
  record(
    'pdf-reader-src-points-to-viewer',
    Boolean(pdfState?.src && pdfState.src.includes('viewer.html') && pdfState.src.includes('file=')),
    { src: pdfState?.src ?? null }
  )
  // Verify the iframe and its split-layout ancestors actually have non-zero
  // dimensions. A layout collapse (height:0) is invisible via state probes
  // but would leave the user staring at a blank area — exactly the symptom
  // the 0418-wk1 user reported.
  {
    const iframe = document.querySelector('.project-editor-pdf-reader-iframe') as HTMLIFrameElement | null
    const reader = document.querySelector('.project-editor-pdf-reader') as HTMLElement | null
    const pane = document.querySelector('.project-editor-editor-pane') as HTMLElement | null
    const split = document.querySelector('.project-editor-split') as HTMLElement | null
    const dims = {
      iframe: iframe ? { w: iframe.offsetWidth, h: iframe.offsetHeight } : null,
      reader: reader ? { w: reader.offsetWidth, h: reader.offsetHeight } : null,
      pane: pane ? { w: pane.offsetWidth, h: pane.offsetHeight } : null,
      split: split ? { w: split.offsetWidth, h: split.offsetHeight } : null
    }
    record(
      'pdf-reader-iframe-has-nonzero-dimensions',
      Boolean(iframe && iframe.offsetWidth > 100 && iframe.offsetHeight > 100),
      dims
    )
  }
  record(
    'pdf-reader-src-points-to-fixture',
    Boolean(pdfState?.src && pdfState.src.includes(encodeURIComponent('__autotest_pdf_preview.pdf'))),
    { src: pdfState?.src ?? null }
  )

  const readyFired = await waitFor(
    'pdf-viewer-ready-message',
    () => viewerReady,
    15000,
    100
  )
  record('pdf-viewer-ready-message', readyFired, { received: viewerReady })
  window.removeEventListener('message', readyListener)

  // The PDF path should be marked as binary from the editor's point of view.
  record(
    'pdf-active-file-path-correct',
    getApi()?.getActiveFilePath() === pdfPath,
    { expected: pdfPath, got: getApi()?.getActiveFilePath() }
  )

  // Switching away should clear the PDF reader.
  await getApi()?.openFileByPath(markerPath)
  const pdfGone = await waitFor(
    'pdf-reader-cleared-after-switch',
    () => getApi()?.isPdfReaderVisible?.() === false,
    5000
  )
  record('pdf-reader-cleared-after-switch', pdfGone)

  // Re-open: regression check for state reset leaks.
  await getApi()?.openFileByPath(pdfPath)
  const pdfVisibleAgain = await waitFor(
    'pdf-reader-reopen',
    () => getApi()?.isPdfReaderVisible?.() === true,
    8000
  )
  record('pdf-reader-reopen', pdfVisibleAgain)

  // ---------- PDF: keyboard shortcut forwarding (iframe → host) ----------
  // Verifies that Cmd/Ctrl+P and Escape originating inside the sandboxed
  // pdf.js viewer iframe reach the host's existing keyboard handlers.
  // Boolean-correctness assertions run as N trials with all-must-succeed
  // (CLAUDE.md timing-sensitive autotest rule).
  //
  // Cross-realm dispatchEvent on iframe.contentWindow doesn't reliably
  // trigger window-level keydown listeners in Chromium, so we call into
  // the iframe's own realm via `window.__onwardPdfTest` (a viewer.js test
  // hook) to exercise the postMessage forwarding path.
  const dispatchOnIframe = (key: string, opts: { metaKey?: boolean; ctrlKey?: boolean } = {}) => {
    const iframe = document.querySelector('.project-editor-pdf-reader-iframe') as HTMLIFrameElement | null
    const helper = (iframe?.contentWindow as unknown as {
      __onwardPdfTest?: { forwardHostKey: (key: string, opts: { metaKey?: boolean; ctrlKey?: boolean }) => void }
    } | undefined)?.__onwardPdfTest
    if (!helper?.forwardHostKey) return false
    helper.forwardHostKey(key, opts)
    return true
  }

  // After the reopen above, ProjectEditor has just remounted the PdfReader
  // (since switching to the marker file unmounted it). The iframe element,
  // its contentWindow, and viewer.js's `__onwardPdfTest` helper all attach
  // asynchronously. Wait for the helper to be present before running any
  // forwarding-mechanism assertions, otherwise we'd race the iframe load.
  const helperReady = await waitFor(
    'pdf-reader-test-helper-attached',
    () => {
      const iframe = document.querySelector('.project-editor-pdf-reader-iframe') as HTMLIFrameElement | null
      const cw = iframe?.contentWindow as unknown as { __onwardPdfTest?: { forwardHostKey?: unknown } } | undefined
      return typeof cw?.__onwardPdfTest?.forwardHostKey === 'function'
    },
    15000,
    100
  )
  record('pdf-reader-test-helper-present',
    helperReady,
    (() => {
      const iframe = document.querySelector('.project-editor-pdf-reader-iframe') as HTMLIFrameElement | null
      const cw = iframe?.contentWindow as unknown as { __onwardPdfTest?: { forwardHostKey?: unknown } } | undefined
      return {
        hasIframe: Boolean(iframe),
        hasContentWindow: Boolean(iframe?.contentWindow),
        helperType: typeof cw?.__onwardPdfTest,
        forwardHostKeyType: typeof cw?.__onwardPdfTest?.forwardHostKey
      }
    })()
  )

  // (a) Cmd/Ctrl+P forwarded → ProjectEditor's Quick Open (file search) opens.
  // Quick Open does not close the editor, so we close it (Escape on the host
  // document, which Quick Open captures internally) and repeat 5 trials.
  {
    const TRIALS = 5
    let successes = 0
    let attempted = 0
    for (let i = 0; i < TRIALS; i++) {
      if (!getApi()?.isPdfReaderVisible?.()) break
      const dispatched = dispatchOnIframe('p', { metaKey: true, ctrlKey: true })
      if (!dispatched) break
      attempted++
      const opened = await waitFor(
        `pdf-reader-cmd-p-trial-${i}`,
        () => getApi()?.isGlobalFilenameSearchOpen?.() === true,
        2000,
        50
      )
      if (opened) {
        successes++
        // Close Quick Open by dispatching Escape on the host (Quick Open's
        // own listener consumes it). The PDF stays open.
        document.dispatchEvent(new KeyboardEvent('keydown', {
          key: 'Escape', bubbles: true, cancelable: true
        }))
        await waitFor(
          `pdf-reader-cmd-p-close-${i}`,
          () => getApi()?.isGlobalFilenameSearchOpen?.() === false,
          2000,
          50
        )
      }
    }
    record('pdf-reader-cmd-p-quick-open',
      successes === TRIALS && attempted === TRIALS,
      { successes, attempted, trials: TRIALS }
    )
  }

  // (b) Escape forwarded → useSubpageEscape closes the editor. Use a
  // postMessage probe to count host-side receipt of `onward:pdf:hostKey`
  // with key='Escape' across N=3 trials (lower than N=5 because each
  // trial is destructive — closes the editor — and re-opening between
  // trials adds substantial setup cost). 3 still detects intermittent
  // failures while keeping total runtime under the 300s suite budget.
  {
    let escForwardedCount = 0
    const probe = (e: MessageEvent) => {
      if (e?.data?.type === 'onward:pdf:hostKey' && e.data?.key === 'Escape') {
        escForwardedCount++
      }
    }
    window.addEventListener('message', probe)

    const TRIALS = 3
    let trials = 0
    const waitForHelper = (label: string) => waitFor(
      label,
      () => {
        const iframe = document.querySelector('.project-editor-pdf-reader-iframe') as HTMLIFrameElement | null
        const cw = iframe?.contentWindow as unknown as { __onwardPdfTest?: { forwardHostKey?: unknown } } | undefined
        return typeof cw?.__onwardPdfTest?.forwardHostKey === 'function'
      },
      15000,
      100
    )
    for (let i = 0; i < TRIALS; i++) {
      if (!getApi()?.isOpen?.()) {
        window.dispatchEvent(new CustomEvent('project-editor:open', { detail: { terminalId } }))
        await waitFor(`pdf-reader-esc-reopen-editor-${i}`, () => Boolean(getApi()?.isOpen?.()), 8000)
      }
      if (!getApi()?.isPdfReaderVisible?.()) {
        await getApi()?.openFileByPathAsUser?.(pdfPath)
        await waitFor(`pdf-reader-esc-reopen-pdf-${i}`, () => getApi()?.isPdfReaderVisible?.() === true, 8000)
      }
      // Wait for the iframe + viewer.js init so the test helper is attached
      // before each trial. Reopening the PDF remounts a fresh iframe.
      await waitForHelper(`pdf-reader-esc-helper-ready-${i}`)

      const dispatched = dispatchOnIframe('Escape')
      if (!dispatched) break
      trials++

      await waitFor(
        `pdf-reader-esc-msg-${i}`,
        () => escForwardedCount > i,
        2000,
        30
      )
      await waitFor(
        `pdf-reader-esc-closed-${i}`,
        () => !getApi()?.isPdfReaderVisible?.(),
        2000,
        50
      )
    }
    window.removeEventListener('message', probe)

    record('pdf-reader-escape-forwarded',
      escForwardedCount === TRIALS && trials === TRIALS,
      { received: escForwardedCount, trials: TRIALS }
    )
  }

  // (c) State integrity: after the burst of trials above, exactly one PDF
  // iframe should be present in the DOM (no zombie accumulation, no leak
  // of the previous iframe instance after re-opens).
  {
    if (!getApi()?.isOpen?.()) {
      window.dispatchEvent(new CustomEvent('project-editor:open', { detail: { terminalId } }))
      await waitFor('pdf-reader-leak-reopen-editor', () => Boolean(getApi()?.isOpen?.()), 8000)
    }
    if (!getApi()?.isPdfReaderVisible?.()) {
      await getApi()?.openFileByPathAsUser?.(pdfPath)
      await waitFor('pdf-reader-leak-reopen-pdf', () => getApi()?.isPdfReaderVisible?.() === true, 8000)
    }
    // Wait for the iframe to actually mount in the DOM before counting —
    // React state can flip ahead of the commit.
    await waitFor(
      'pdf-reader-leak-iframe-mounted',
      () => document.querySelectorAll('.project-editor-pdf-reader-iframe').length >= 1,
      5000,
      100
    )
    const iframeCount = document.querySelectorAll('.project-editor-pdf-reader-iframe').length
    record('pdf-reader-no-zombie-iframes',
      iframeCount === 1,
      { iframeCount }
    )
  }

  // (d) ESC + shortcut reopen — PdfReader must survive the close-retain →
  // reopen cycle WITHOUT remounting the iframe. If the iframe is recreated
  // every reopen, the user pays a full pdf.js viewer.js init (network +
  // worker boot + page render) and sees a blank flash. The retain-mode close
  // path keeps ProjectEditor mounted (panel mode `keepMountedInPanel=true`),
  // and `isPdf` / `pdfPreviewUrl` survive the close branch (the early return
  // at ProjectEditor.tsx:4213 skips the state-clear block), so the iframe
  // element should be the same DOM node + contentWindow before and after.
  // Per CLAUDE.md timing-sensitive autotest rule: N=5 trials, all-must-pass.
  {
    if (!getApi()?.isOpen?.()) {
      window.dispatchEvent(new CustomEvent('project-editor:open', { detail: { terminalId } }))
      await waitFor('pdf-reopen-baseline-editor', () => Boolean(getApi()?.isOpen?.()), 8000)
    }
    if (!getApi()?.isPdfReaderVisible?.()) {
      await getApi()?.openFileByPathAsUser?.(pdfPath)
      await waitFor('pdf-reopen-baseline-pdf', () => getApi()?.isPdfReaderVisible?.() === true, 8000)
    }
    await waitFor(
      'pdf-reopen-baseline-iframe-mounted',
      () => Boolean(document.querySelector('.project-editor-pdf-reader-iframe')),
      5000,
      100
    )

    const TRIALS = 5
    type PdfReopenObservation = {
      trial: number
      closed: boolean
      reopened: boolean
      pdfVisibleAfterReopen: boolean
      iframeIdentitySurvived: boolean
      contentWindowSurvived: boolean
    }
    const observations: PdfReopenObservation[] = []
    const canShortcut = Boolean(window.__onwardAppDebug?.triggerShortcutAction)
    for (let i = 1; i <= TRIALS; i += 1) {
      if (cancelled()) break
      const initialIframe = document.querySelector('.project-editor-pdf-reader-iframe') as HTMLIFrameElement | null
      const initialContentWindow = initialIframe?.contentWindow ?? null
      if (!initialIframe || !initialContentWindow || !canShortcut) {
        observations.push({
          trial: i,
          closed: false,
          reopened: false,
          pdfVisibleAfterReopen: false,
          iframeIdentitySurvived: false,
          contentWindowSurvived: false
        })
        break
      }

      // Close via host Escape — the user-reported flow. The iframe-side ESC
      // forwarding is exercised separately by `pdf-reader-escape-forwarded`;
      // here we want the host's own escape path so the close mirrors what a
      // user pressing ESC outside the iframe focus does.
      document.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'Escape',
        code: 'Escape',
        bubbles: true,
        cancelable: true
      }))
      const closed = await waitFor(
        `pdf-reopen-trial-${i}-closed`,
        () => !getApi()?.isOpen?.(),
        4000,
        80
      )

      const triggered = window.__onwardAppDebug?.triggerShortcutAction?.({ type: 'terminalProjectEditor' }) === true
      const reopened = triggered
        ? await waitFor(
            `pdf-reopen-trial-${i}-reopened`,
            () => Boolean(getApi()?.isOpen?.()),
            8000,
            80
          )
        : false
      const pdfVisibleAfterReopen = reopened
        ? await waitFor(
            `pdf-reopen-trial-${i}-visible`,
            () => getApi()?.isPdfReaderVisible?.() === true,
            8000,
            80
          )
        : false

      const finalIframe = document.querySelector('.project-editor-pdf-reader-iframe') as HTMLIFrameElement | null
      const finalContentWindow = finalIframe?.contentWindow ?? null
      const iframeIdentitySurvived = Boolean(finalIframe) && finalIframe === initialIframe
      const contentWindowSurvived = Boolean(finalContentWindow) && finalContentWindow === initialContentWindow

      observations.push({
        trial: i,
        closed,
        reopened,
        pdfVisibleAfterReopen,
        iframeIdentitySurvived,
        contentWindowSurvived
      })
      if (!closed || !reopened || !pdfVisibleAfterReopen) break
    }
    const allKeptIframe =
      observations.length === TRIALS &&
      observations.every((obs) =>
        obs.closed &&
        obs.reopened &&
        obs.pdfVisibleAfterReopen &&
        obs.iframeIdentitySurvived &&
        obs.contentWindowSurvived
      )
    record('pdf-reader-shortcut-reopen-keeps-iframe-mounted', allKeptIframe, {
      expectedTrials: TRIALS,
      observed: observations.length,
      perTrial: observations
    })
  }

  } // ── end group gate: pdf core ──

  // ── group gate: epub (budget split) ──
  if (runEpub) {

  // ---------- EPUB preview ----------

  log('epub:open', { epubPath })
  await getApi()?.openFileByPathAsUser?.(epubPath)
  const epubVisible = await waitFor(
    'epub-reader-visible',
    () => getApi()?.isEpubReaderVisible?.() === true,
    10000
  )
  record('epub-reader-visible', epubVisible, { filename: TEST_EPUB_FILENAME })

  // PDF and EPUB should be mutually exclusive (switching should have cleared PDF).
  record(
    'pdf-and-epub-mutually-exclusive',
    getApi()?.isPdfReaderVisible?.() !== true && getApi()?.isEpubReaderVisible?.() === true
  )

  // Wait for epub.js to populate the TOC + render chapter 1.
  const tocPopulated = await waitFor(
    'epub-toc-populated',
    () => {
      const state = getApi()?.getEpubReaderState?.()
      return Boolean(state && state.tocCount >= 2)
    },
    12000
  )
  record('epub-toc-populated', tocPopulated, { state: getApi()?.getEpubReaderState?.() ?? null })

  // epub.js mounts the chapter inside a nested <iframe> inside the content
  // pane. The exact DOM shape differs by epub.js ViewManager (default creates
  // a wrapper <div> + iframe; continuous manager inlines differently). Accept
  // any of: debug hasContent flag, an <iframe> anywhere under the content
  // pane, or any non-empty descendant. The timeout is generous because the
  // underlying epub.js DefaultViewManager sometimes stalls its first display
  // on our sandboxed file:// iframe — our EpubReader retries in that case.
  const contentRendered = await waitFor(
    'epub-content-rendered',
    () => {
      const state = getApi()?.getEpubReaderState?.()
      if (state?.hasContent) return true
      const reader = document.querySelector('.project-editor-epub-reader')
      const pane = reader?.querySelector('.project-editor-epub-content') as HTMLElement | null
      if (!pane) return false
      if (pane.querySelector('iframe')) return true
      if ((pane.textContent ?? '').trim().length > 0) return true
      return pane.querySelectorAll('*').length > 0
    },
    60000,
    200
  )
  const progress = (window as unknown as { __onwardEpubReaderProgress?: Record<string, unknown> }).__onwardEpubReaderProgress ?? null
  record('epub-content-rendered', contentRendered, {
    state: getApi()?.getEpubReaderState?.() ?? null,
    iframePresent: Boolean(document.querySelector('.project-editor-epub-content iframe')),
    paneDescendants: document.querySelector('.project-editor-epub-content')?.querySelectorAll('*').length ?? 0,
    paneText: (document.querySelector('.project-editor-epub-content')?.textContent ?? '').trim().slice(0, 80),
    progress
  })

  const epubState = getApi()?.getEpubReaderState?.() ?? null
  record(
    'epub-font-size-default-100pct',
    Boolean(epubState?.fontSizeLabel && epubState.fontSizeLabel.startsWith('100')),
    { fontSizeLabel: epubState?.fontSizeLabel ?? null }
  )

  // The EPUB's TOC is now rendered by the shared OutlinePanel. Assert that:
  //   (a) the old in-reader `<aside>` TOC has been removed,
  //   (b) OutlinePanel has ≥ 1 item for the current EPUB,
  //   (c) clicking a TOC entry navigates the reader via the new onItemNavigate
  //       channel (not a direct epub.js display() call from the sidebar).
  record(
    'epub-outline-panel-replaces-sidebar',
    !document.querySelector('.project-editor-epub-sidebar'),
    {}
  )
  const outlinePanelItemsBefore = await waitFor(
    'epub-outline-panel-populated',
    () => document.querySelectorAll('.outline-panel .outline-panel-item').length >= 2,
    8000
  )
  record('epub-outline-panel-populated', outlinePanelItemsBefore, {
    itemCount: document.querySelectorAll('.outline-panel .outline-panel-item').length
  })
  const outlineItems = Array.from(
    document.querySelectorAll('.outline-panel .outline-panel-item')
  ) as HTMLElement[]
  if (outlineItems.length >= 2) {
    ;(outlineItems[1] as HTMLElement).click()
    const navigated = await waitFor(
      'epub-outline-click-navigates',
      () => {
        const href = getApi()?.getEpubReaderState?.()?.currentLocationHref ?? null
        return typeof href === 'string' && href.toLowerCase().includes('chapter2')
      },
      4000,
      150
    )
    record('epub-outline-click-navigates', navigated, {
      href: getApi()?.getEpubReaderState?.()?.currentLocationHref ?? null
    })
    // Auto-center assertion: the active item's center should fall inside the
    // middle 60% band of the OutlinePanel tree. We check rect geometry rather
    // than scroll position so the test is independent of item height.
    await sleep(400)
    const tree = document.querySelector('.outline-panel .outline-panel-tree') as HTMLElement | null
    const active = document.querySelector('.outline-panel .outline-panel-item.active') as HTMLElement | null
    let centered = false
    if (tree && active) {
      // If the tree is too small to scroll (everything fits), we can't
      // physically center — treat that as "no centering needed" so the
      // assertion reflects intent rather than tautological fail for tiny
      // fixtures. For real scrollable trees, enforce the 60% band.
      if (tree.scrollHeight <= tree.clientHeight + 2) {
        centered = true
      } else {
        const c = tree.getBoundingClientRect()
        const a = active.getBoundingClientRect()
        const band = c.height * 0.6
        const topBand = c.top + (c.height - band) / 2
        const bottomBand = topBand + band
        centered = a.top >= topBand && a.bottom <= bottomBand
      }
    }
    record('epub-outline-active-centered', centered, {
      hasTree: Boolean(tree),
      hasActive: Boolean(active)
    })
  } else {
    record('epub-outline-click-navigates', false, { itemCount: outlineItems.length })
    record('epub-outline-active-centered', false, { itemCount: outlineItems.length })
  }

  // Capture which chapter the user is on BEFORE bumping the font. The TOC
  // click above navigated to chapter 2; if fontSize accidentally reset the
  // rendition to page 1 the `currentLocationHref` would flip back to
  // chapter 1 after A+.
  const preBumpHref = getApi()?.getEpubReaderState?.()?.currentLocationHref ?? null

  // Click the A+ button and verify the label changes.
  const biggerBtn = document.querySelector(
    '.project-editor-epub-fontsize .project-editor-epub-btn:last-child'
  ) as HTMLButtonElement | null
  biggerBtn?.click()
  await sleep(200)
  const bumpedFontOk = await waitFor(
    'epub-font-size-bumped',
    () => {
      const state = getApi()?.getEpubReaderState?.()
      const label = state?.fontSizeLabel ?? ''
      return label.startsWith('110')
    },
    3000
  )
  record('epub-font-size-bumped', bumpedFontOk, {
    fontSizeLabel: getApi()?.getEpubReaderState?.()?.fontSizeLabel ?? null
  })

  // Verify font-size change did NOT snap the user back to the cover page.
  // Give epub.js a moment to re-layout and re-seek.
  const locPreserved = await waitFor(
    'epub-font-size-preserves-location',
    () => {
      const cur = getApi()?.getEpubReaderState?.()?.currentLocationHref ?? null
      return Boolean(preBumpHref && cur && cur === preBumpHref)
    },
    5000,
    200
  )
  record('epub-font-size-preserves-location', locPreserved, {
    before: preBumpHref,
    after: getApi()?.getEpubReaderState?.()?.currentLocationHref ?? null
  })

  // Drive EPUB search exactly as a user would: type into the search input
  // (using the native value setter so React's synthetic event system picks
  // up the change) and click the search button. Then observe the DOM for
  // rendered hit entries. No backdoor.
  const searchInput = document.querySelector(
    '.project-editor-epub-search input[type="search"]'
  ) as HTMLInputElement | null
  const searchBtn = Array.from(
    document.querySelectorAll('.project-editor-epub-search .project-editor-epub-btn')
  ).find(btn => !(btn as HTMLButtonElement).classList.contains('is-disabled')) as HTMLButtonElement | undefined
  if (!searchInput || !searchBtn) {
    record('epub-search-controls-present', false)
  } else {
    record('epub-search-controls-present', true)
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set
    setter?.call(searchInput, 'searchable')
    searchInput.dispatchEvent(new Event('input', { bubbles: true }))
    await sleep(120)
    searchBtn.click()
    const hitFound = await waitFor(
      'epub-search-hit',
      () => document.querySelectorAll('.project-editor-epub-search-hit').length > 0,
      10000
    )
    const hits = document.querySelectorAll('.project-editor-epub-search-hit')
    record('epub-search-hit', hitFound, { domHitCount: hits.length })
    // Visual sanity: first hit excerpt should contain the query (case-insensitive).
    const firstHitText = (hits[0]?.textContent ?? '').toLowerCase()
    record('epub-search-hit-excerpt-matches-query', firstHitText.includes('searchable'), {
      firstHitText: firstHitText.slice(0, 80)
    })
    // Clicking a hit should navigate the rendition. We can at least confirm the
    // click does not throw and the reader still shows content after.
    ;(hits[0] as HTMLElement | undefined)?.click()
    await sleep(400)
    const stillHasContent = Boolean(getApi()?.getEpubReaderState?.()?.hasContent)
    record('epub-search-hit-click-keeps-content', stillHasContent)
  }

  // The outline toggle lives in the main ProjectEditor header ("Close / Open
  // Outline"), shared with Markdown and code files. When it's toggled off,
  // the unified .outline-panel disappears from the DOM for the EPUB reader
  // too. We also keep the assertion that the in-reader `<aside>` is gone.
  // The EPUB toolbar itself no longer renders any outline-related buttons
  // (we removed the inline sidebar entirely) — assert that none exist.
  record('epub-no-inline-toc-button',
    document.querySelectorAll('.project-editor-epub-sidebar, .project-editor-epub-toc-item').length === 0,
    {}
  )
  const outlineHeaderBtn = Array.from(
    document.querySelectorAll('.project-editor-action-btn.project-editor-preview-toggle')
  )[0] as HTMLButtonElement | undefined
  record('epub-outline-button-in-header', Boolean(outlineHeaderBtn), {
    label: outlineHeaderBtn?.textContent?.trim() ?? null
  })
  if (outlineHeaderBtn) {
    outlineHeaderBtn.click()
    await sleep(250)
    const outlineHidden = !document.querySelector('.outline-panel')
    record('epub-header-outline-toggle-hides-panel', outlineHidden)
    // Toggle back for remaining assertions (PDF outline checks below).
    outlineHeaderBtn.click()
    await sleep(200)
  }

  // Switching away clears the EPUB reader.
  await getApi()?.openFileByPath(markerPath)
  const epubGone = await waitFor(
    'epub-reader-cleared-after-switch',
    () => getApi()?.isEpubReaderVisible?.() === false,
    5000
  )
  record('epub-reader-cleared-after-switch', epubGone)

  // Reopen the SAME EPUB. Per-file persistence should restore the bumped
  // font-size (110%). This validates FileViewMemory wiring rather than a
  // global setting. We don't wait for hasContent here — just the label on
  // the font-size chip.
  await getApi()?.openFileByPath(epubPath)
  await waitFor(
    'epub-reader-reopened',
    () => getApi()?.isEpubReaderVisible?.() === true,
    8000
  )
  const persistedFontOk = await waitFor(
    'epub-font-size-persisted',
    () => {
      const label = getApi()?.getEpubReaderState?.()?.fontSizeLabel ?? ''
      return label.startsWith('110')
    },
    5000,
    150
  )
  record('epub-font-size-persisted', persistedFontOk, {
    fontSizeLabel: getApi()?.getEpubReaderState?.()?.fontSizeLabel ?? null
  })

  // ESC + shortcut reopen — EpubReader must survive the close-retain → reopen
  // cycle WITHOUT remounting. epub.js boots a heavy nested iframe that takes
  // multiple seconds to render the first chapter; remounting on every reopen
  // would burn that cost AND visually flash the user back to chapter 1
  // before jumping to the saved location. The retain-mode close keeps
  // ProjectEditor mounted (panel mode), and `isEpub` / `epubPreviewData`
  // survive the close branch's early-return guard, so the reader element
  // should be the same DOM node before and after.
  // Per CLAUDE.md timing-sensitive autotest rule: N=5 trials, all-must-pass.
  {
    if (!getApi()?.isOpen?.()) {
      window.dispatchEvent(new CustomEvent('project-editor:open', { detail: { terminalId } }))
      await waitFor('epub-reopen-baseline-editor', () => Boolean(getApi()?.isOpen?.()), 8000)
    }
    if (!getApi()?.isEpubReaderVisible?.()) {
      await getApi()?.openFileByPathAsUser?.(epubPath)
      await waitFor('epub-reopen-baseline-epub', () => getApi()?.isEpubReaderVisible?.() === true, 10000)
    }
    await waitFor(
      'epub-reopen-baseline-reader-mounted',
      () => Boolean(document.querySelector('.project-editor-epub-reader')),
      5000,
      100
    )

    const TRIALS = 5
    type EpubReopenObservation = {
      trial: number
      closed: boolean
      reopened: boolean
      epubVisibleAfterReopen: boolean
      readerIdentitySurvived: boolean
      contentPaneIdentitySurvived: boolean
      currentLocationHrefBefore: string | null
      currentLocationHrefAfter: string | null
      locationStable: boolean
    }
    const observations: EpubReopenObservation[] = []
    const canShortcut = Boolean(window.__onwardAppDebug?.triggerShortcutAction)
    for (let i = 1; i <= TRIALS; i += 1) {
      if (cancelled()) break
      const initialReader = document.querySelector('.project-editor-epub-reader') as HTMLElement | null
      const initialContentPane = initialReader?.querySelector('.project-editor-epub-content') as HTMLElement | null
      const beforeHref = getApi()?.getEpubReaderState?.()?.currentLocationHref ?? null
      if (!initialReader || !initialContentPane || !canShortcut) {
        observations.push({
          trial: i,
          closed: false,
          reopened: false,
          epubVisibleAfterReopen: false,
          readerIdentitySurvived: false,
          contentPaneIdentitySurvived: false,
          currentLocationHrefBefore: beforeHref,
          currentLocationHrefAfter: null,
          locationStable: false
        })
        break
      }

      document.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'Escape',
        code: 'Escape',
        bubbles: true,
        cancelable: true
      }))
      const closed = await waitFor(
        `epub-reopen-trial-${i}-closed`,
        () => !getApi()?.isOpen?.(),
        4000,
        80
      )

      const triggered = window.__onwardAppDebug?.triggerShortcutAction?.({ type: 'terminalProjectEditor' }) === true
      const reopened = triggered
        ? await waitFor(
            `epub-reopen-trial-${i}-reopened`,
            () => Boolean(getApi()?.isOpen?.()),
            8000,
            80
          )
        : false
      const epubVisibleAfterReopen = reopened
        ? await waitFor(
            `epub-reopen-trial-${i}-visible`,
            () => getApi()?.isEpubReaderVisible?.() === true,
            8000,
            80
          )
        : false

      const finalReader = document.querySelector('.project-editor-epub-reader') as HTMLElement | null
      const finalContentPane = finalReader?.querySelector('.project-editor-epub-content') as HTMLElement | null
      const readerIdentitySurvived = Boolean(finalReader) && finalReader === initialReader
      const contentPaneIdentitySurvived = Boolean(finalContentPane) && finalContentPane === initialContentPane
      const afterHref = getApi()?.getEpubReaderState?.()?.currentLocationHref ?? null
      // Either both were null or they match — guard against epub.js fluttering
      // through `null` while it re-binds the iframe.
      const locationStable = beforeHref === afterHref

      observations.push({
        trial: i,
        closed,
        reopened,
        epubVisibleAfterReopen,
        readerIdentitySurvived,
        contentPaneIdentitySurvived,
        currentLocationHrefBefore: beforeHref,
        currentLocationHrefAfter: afterHref,
        locationStable
      })
      if (!closed || !reopened || !epubVisibleAfterReopen) break
    }
    const allKeptReader =
      observations.length === TRIALS &&
      observations.every((obs) =>
        obs.closed &&
        obs.reopened &&
        obs.epubVisibleAfterReopen &&
        obs.readerIdentitySurvived &&
        obs.contentPaneIdentitySurvived &&
        obs.locationStable
      )
    record('epub-reader-shortcut-reopen-keeps-reader-mounted', allKeptReader, {
      expectedTrials: TRIALS,
      observed: observations.length,
      perTrial: observations
    })
  }

  // ESC pressed while focus is INSIDE the epub.js content iframe must close
  // the editor exactly like a host-side ESC (design rule: every terminal-entry
  // subpage returns to the terminal on ESC). Keydown events inside the nested
  // same-origin iframe do NOT bubble to the host document, so EpubReader must
  // forward them to the host — mirroring the pdf.js viewer hostKey forwarding
  // locked by `pdf-reader-escape-forwarded`.
  // Per CLAUDE.md timing-sensitive autotest rule: N=3 close/reopen trials,
  // all-must-pass (a single miss means the forwarding path has a real hole).
  {
    const TRIALS = 3
    type EpubEscObservation = {
      trial: number
      iframeReady: boolean
      dispatched: boolean
      closed: boolean
      reopened: boolean
    }
    const escObservations: EpubEscObservation[] = []
    const canShortcut = Boolean(window.__onwardAppDebug?.triggerShortcutAction)
    for (let i = 1; i <= TRIALS; i += 1) {
      if (cancelled()) break
      if (!getApi()?.isOpen?.()) {
        window.dispatchEvent(new CustomEvent('project-editor:open', { detail: { terminalId } }))
        await waitFor(`epub-content-esc-trial-${i}-editor`, () => Boolean(getApi()?.isOpen?.()), 8000)
      }
      if (!getApi()?.isEpubReaderVisible?.()) {
        await getApi()?.openFileByPathAsUser?.(epubPath)
        await waitFor(`epub-content-esc-trial-${i}-epub`, () => getApi()?.isEpubReaderVisible?.() === true, 10000)
      }
      const iframeReady = await waitFor(
        `epub-content-esc-trial-${i}-iframe`,
        () => {
          const frame = document.querySelector<HTMLIFrameElement>('.project-editor-epub-content iframe')
          return Boolean(frame?.contentDocument?.body)
        },
        10000,
        100
      )
      const contentDoc = document.querySelector<HTMLIFrameElement>('.project-editor-epub-content iframe')?.contentDocument ?? null
      let dispatched = false
      if (iframeReady && contentDoc) {
        contentDoc.dispatchEvent(new KeyboardEvent('keydown', {
          key: 'Escape',
          code: 'Escape',
          bubbles: true,
          cancelable: true
        }))
        dispatched = true
      }
      const closed = dispatched
        ? await waitFor(
            `epub-content-esc-trial-${i}-closed`,
            () => !getApi()?.isOpen?.(),
            4000,
            80
          )
        : false
      // Reopen for the next trial (and to leave the suite in the open state
      // the following PDF-outline assertions expect).
      const reopened = canShortcut && window.__onwardAppDebug?.triggerShortcutAction?.({ type: 'terminalProjectEditor' }) === true
        ? await waitFor(`epub-content-esc-trial-${i}-reopened`, () => Boolean(getApi()?.isOpen?.()), 8000, 80)
        : Boolean(getApi()?.isOpen?.())
      escObservations.push({ trial: i, iframeReady, dispatched, closed, reopened })
      if (!closed || !reopened) break
    }
    const allForwarded =
      escObservations.length === TRIALS &&
      escObservations.every((obs) => obs.iframeReady && obs.dispatched && obs.closed && obs.reopened)
    record('epub-escape-forwarded-from-content', allForwarded, {
      expectedTrials: TRIALS,
      observed: escObservations.length,
      perTrial: escObservations
    })
  }

  } // ── end group gate: epub ──

  // Hoisted above the pdf gate blocks: referenced by BOTH the outlined-PDF
  // section and the view-state section below (pure path string, no side
  // effect when the pdf group is skipped).
  const outlinedPdfPath = joinPath(rootPath, TEST_PDF_OUTLINE_FILENAME)

  // ── group gate: pdf-outline (outlined fixture + outline panel) ──
  if (runPdfOutline) {

  // ---------- Outlined PDF fixture: unified OutlinePanel integration ----------
  // Copy the outlined PDF fixture next to the other fixtures.
  await termExec(
    platformBuildCopyCommand(`${FIXTURE_REL_DIR}/${PDF_OUTLINE_FIXTURE_SRC}`, TEST_PDF_OUTLINE_FILENAME, rootPath),
    'outlined-pdf:copy',
    1200
  )
  await getApi()?.openFileByPathAsUser?.(outlinedPdfPath)
  await waitFor(
    'pdf-outlined-reader-visible',
    () => getApi()?.isPdfReaderVisible?.() === true,
    10000
  )
  // Unified OutlinePanel integration for PDF: after the outlined fixture
  // loads, the Onward .outline-panel on the page should contain ≥ 1 entry,
  // and the viewer iframe should NO LONGER have its own #outlinePanel (we
  // removed the in-iframe outline UI).
  const pdfOutlinePopulated = await waitFor(
    'pdf-outline-panel-populated',
    () => document.querySelectorAll('.outline-panel .outline-panel-item').length >= 1,
    15000,
    200
  )
  record('pdf-outline-panel-populated', pdfOutlinePopulated, {
    itemCount: document.querySelectorAll('.outline-panel .outline-panel-item').length
  })
  {
    const iframe = document.querySelector('.project-editor-pdf-reader-iframe') as HTMLIFrameElement | null
    const doc = iframe?.contentDocument
    record('pdf-outline-panel-replaces-iframe-outline',
      !doc?.getElementById('outlinePanel'),
      { hasIframePanel: Boolean(doc?.getElementById('outlinePanel')) }
    )
  }

  // Navigate the PDF to page 1 via the viewer's internal API and confirm the
  // outline entry for page 1 is marked active. This exercises the
  // onPageChange → pdfActiveItem computation in ProjectEditor.
  {
    const iframe = document.querySelector('.project-editor-pdf-reader-iframe') as HTMLIFrameElement | null
    const viewerWin = iframe?.contentWindow as (Window & {
      pdfViewer?: { currentPageNumber?: number }
    }) | null
    // Hop to an arbitrary page to force a `pagechanging` → onPageChange fire.
    // The outlined fixture is single-page, but just going to page 1 again is
    // enough to trigger the state post (same flow that the user's scroll
    // would hit).
    if (viewerWin?.pdfViewer) {
      try { viewerWin.pdfViewer.currentPageNumber = 1 } catch { /* ignore */ }
    }
    const activeMatches = await waitFor(
      'pdf-outline-highlights-current-page',
      () => Boolean(document.querySelector('.outline-panel .outline-panel-item.active')),
      4000,
      150
    )
    record('pdf-outline-highlights-current-page', activeMatches, {
      active: document.querySelector('.outline-panel .outline-panel-item.active')?.textContent?.trim() ?? null
    })
    // Same geometric center check as the EPUB case.
    const tree = document.querySelector('.outline-panel .outline-panel-tree') as HTMLElement | null
    const active = document.querySelector('.outline-panel .outline-panel-item.active') as HTMLElement | null
    let centered = false
    if (tree && active) {
      // If the tree is too small to scroll (everything fits), we can't
      // physically center — treat that as "no centering needed" so the
      // assertion reflects intent rather than tautological fail for tiny
      // fixtures. For real scrollable trees, enforce the 60% band.
      if (tree.scrollHeight <= tree.clientHeight + 2) {
        centered = true
      } else {
        const c = tree.getBoundingClientRect()
        const a = active.getBoundingClientRect()
        const band = c.height * 0.6
        const topBand = c.top + (c.height - band) / 2
        const bottomBand = topBand + band
        centered = a.top >= topBand && a.bottom <= bottomBand
      }
    }
    record('pdf-outline-active-centered', centered, {
      hasTree: Boolean(tree),
      hasActive: Boolean(active)
    })

    // ---- auto-follow: the active entry must track the SCROLL position, not
    // just the page. Page-number matching sits on the first heading of a page
    // for the whole page; scroll-following is what makes a long chapter list
    // usable. The viewer reports the entry via `onward:pdf:outlineActive`.
    {
      const container = viewerWin?.document?.getElementById('viewerContainer') as HTMLElement | null
      const activeText = () =>
        document.querySelector('.outline-panel .outline-panel-item.active')?.textContent?.trim() ?? null

      const beforeScroll = activeText()
      let changed = false
      if (container && container.scrollHeight > container.clientHeight + 10) {
        container.scrollTop = container.scrollHeight
        // The viewer debounces its reading-state post; give it more than one
        // window rather than racing it.
        await sleep(900)
        changed = activeText() !== beforeScroll
      }
      // A single-heading fixture legitimately cannot change entry, so the
      // assertion is "the active entry survived a scroll and is still a real
      // entry" — the regression it guards is auto-follow throwing or clearing
      // the highlight, which is what a bad comparator does.
      const afterScroll = activeText()
      record('pdf-outline-auto-follow-survives-scroll', Boolean(afterScroll), {
        before: beforeScroll,
        after: afterScroll,
        changed,
        scrollable: Boolean(container && container.scrollHeight > container.clientHeight + 10)
      })

      // The locate button exists for PDF outlines and re-centres on demand
      // after the user has browsed the list by hand.
      const locate = document.querySelector('.outline-panel-locate-btn') as HTMLButtonElement | null
      record('pdf-outline-locate-button-present', Boolean(locate), {
        disabled: locate?.disabled ?? null
      })
      if (locate && !locate.disabled) {
        const treeEl = document.querySelector('.outline-panel .outline-panel-tree') as HTMLElement | null
        if (treeEl) treeEl.scrollTop = 0
        locate.click()
        await sleep(600)
        record(
          'pdf-outline-locate-button-recenters',
          Boolean(document.querySelector('.outline-panel .outline-panel-item.active')),
          { active: activeText() }
        )
      }
    }
  }

  // Dark toggle button label/title should reflect the current state using
  // the new "restore the inverted background" copy, not "Dark".
  // Wait for viewer.js to apply i18n after the iframe remounts; a fresh
  // iframe may briefly have an empty button before applyColorEnhancementState
  // runs.
  await waitFor(
    'pdf-dark-toggle-ready',
    () => {
      const iframe = document.querySelector('.project-editor-pdf-reader-iframe') as HTMLIFrameElement | null
      const doc = iframe?.contentDocument
      const btn = doc?.getElementById('colorToggleBtn') as HTMLButtonElement | null
      return Boolean(btn && (btn.textContent?.trim().length ?? 0) > 0)
    },
    6000,
    150
  )
  {
    const iframe = document.querySelector('.project-editor-pdf-reader-iframe') as HTMLIFrameElement | null
    const doc = iframe?.contentDocument
    const btn = doc?.getElementById('colorToggleBtn') as HTMLButtonElement | null
    const label = btn?.textContent?.trim() ?? ''
    const title = btn?.title ?? ''
    record('pdf-dark-toggle-uses-descriptive-label',
      label.length > 0 && label.toLowerCase() !== 'dark' && title.length > 0,
      { label, title }
    )
    // Click once: should flip to the "restore" variant.
    btn?.click()
    await sleep(200)
    const labelAfter = btn?.textContent?.trim() ?? ''
    const titleAfter = btn?.title ?? ''
    record('pdf-dark-toggle-flips-label-on-click',
      labelAfter.length > 0 && labelAfter !== label && titleAfter !== title,
      { labelAfter, titleAfter }
    )
    // Restore for next runs.
    btn?.click()
    await sleep(150)
  }

  } // ── end group gate: pdf-outline (outlined fixture) ──

  // ---------- Pinned + Recent Files parity ----------
  // Recent list should contain every file the user opened above — because
  // ProjectEditor's openFile pushes to recents on user-sourced opens
  // regardless of type. Each record is gated to its group so the split
  // runners only assert on files their own group actually opened.
  const recentLabels = Array.from(document.querySelectorAll('.quick-file-measure-item')).map(el => el.textContent?.trim() ?? '')
  if (runPdfCore || runPdfOutline) {
    record('pdf-in-recent-files',
      recentLabels.some(l => l.toLowerCase().endsWith('.pdf')),
      { recent: recentLabels.slice(0, 10) }
    )
  }
  if (runEpub) {
    record('epub-in-recent-files',
      recentLabels.some(l => l.toLowerCase().endsWith('.epub')),
      { recent: recentLabels.slice(0, 10) }
    )
  }

  // ── group gate: pdf-outline (view-state memory rides the outlined fixture) ──
  if (runPdfOutline) {

  // ---------- PDF view-state memory ----------
  // Our fixture is single-page and small, so scroll-based memory is hard
  // to assert. Instead, change the zoom preset (the user-visible setting
  // that also flows through `onward:pdf:state`) and verify it's restored
  // after close + reopen. Same persistence channel as scroll/page.
  await getApi()?.openFileByPathAsUser?.(outlinedPdfPath)
  await waitFor(
    'pdf-position-reader-visible',
    () => getApi()?.isPdfReaderVisible?.() === true,
    8000
  )
  const getZoomSelect = () => {
    const iframe = document.querySelector('.project-editor-pdf-reader-iframe') as HTMLIFrameElement | null
    return iframe?.contentDocument?.getElementById('zoomSelect') as HTMLSelectElement | null
  }
  await waitFor('pdf-position-viewer-ready', () => Boolean(getZoomSelect()), 10000)
  const select = getZoomSelect()
  if (select) {
    select.value = '2'
    select.dispatchEvent(new Event('change', { bubbles: true }))
    // Viewer debounces state post at 250ms; give it a beat.
    await sleep(500)
  }
  record('pdf-state-scale-changed',
    getZoomSelect()?.value === '2',
    { value: getZoomSelect()?.value ?? null }
  )

  // Switch away, then reopen same PDF — memory should restore scale.
  await getApi()?.openFileByPathAsUser?.(markerPath)
  await waitFor('pdf-state-gone', () => getApi()?.isPdfReaderVisible?.() === false, 5000)
  await getApi()?.openFileByPathAsUser?.(outlinedPdfPath)
  const restored = await waitFor(
    'pdf-state-restored',
    () => getZoomSelect()?.value === '2',
    10000,
    200
  )
  record('pdf-state-restored', restored, {
    scaleAfter: getZoomSelect()?.value ?? null
  })

  } // ── end group gate: pdf-outline (view-state memory) ──

  // ---------- Cleanup ----------
  await termExec(
    platformBuildDeleteCommand([TEST_PDF_FILENAME, TEST_PDF_OUTLINE_FILENAME, TEST_EPUB_FILENAME, TEST_MARKER_FILENAME]),
    'cleanup',
    800
  )

  log('pdf-epub-preview:done', {
    pass: results.filter(r => r.ok).length,
    fail: results.filter(r => !r.ok).length
  })

  return results
}
