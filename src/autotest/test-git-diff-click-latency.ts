/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

import type { AutotestContext, ClickLatencyMeasurementForAutotest, TestResult } from './types'

// JadeTree click → render latency localisation suite.
//
// The diagnosis tree:
//
//   total = tokenizeSettleAt - clickAt
//   ├── A. ipc       = ipcEndAt    - ipcStartAt
//   ├── B. ready→ipc = ipcStartAt  - clickAt
//   ├── C. apply     = stateSetAt  - ipcEndAt
//   ├── D. bind      = modelBoundAt - stateSetAt
//   ├── E. monaco    = diffComputedAt - modelBoundAt
//   └── F. settle    = tokenizeSettleAt - paintReadyAt
//
// For every file in the current working set we record one measurement with
// the breakdown above. The suite asserts every file settles within the
// current click-to-settle cap. Failures dump the dominant phase per file
// so the next-iteration fix has a concrete target.

const CLICK_TO_SETTLE_TARGET_MS = 7000
// Per-file measurement-collection ceiling (was 8s). Under EDR, Monaco's
// tokenize-settle for a clicked file can exceed 8s, so the per-file measurement
// loop gave up and the suite collected ZERO samples (observed: samples:0 in
// gdcl:tracker-vs-external). 12s lets the measurement settle under EDR so samples
// are actually gathered; the loop still exits early the instant a measurement lands.
const PER_FILE_TIMEOUT_MS = 12000
const SUITE_WATCHDOG_MS = 180_000
// Generous inter-file dwell so Monaco's previous diff-computed + rAF cycle
// fully settles before the next tracker.start cancels it. Without this
// dwell ~16 files per run end up with `cancelled=true` and the autotest
// has fewer measurements to draw conclusions from. Real users dwell far
// longer than this.
const SETTLE_BETWEEN_FILES_MS = 1200

interface PerFileResult {
  filename: string
  /** Click → tracker settled. Renderer-controlled. */
  totalMs: number | null
  /** Click → next browser paint (rAF). Includes 0-17 ms vsync overhead the
   * renderer cannot influence; recorded for diagnostics only. */
  paintTotalMs: number | null
  /**
   * Externally observed click → DOM settle. Captured by a MutationObserver
   * on the Monaco diff editor's view-lines container; waits for a quiet
   * window (no mutations for `EXTERNAL_SETTLE_QUIET_MS`) before declaring
   * settle. This is the closest renderer-side proxy for "user can see the
   * fully-rendered colored diff" because Monaco's tokenizer keeps mutating
   * the DOM after `onDidUpdateDiff` fires.
   */
  externalTotalMs: number | null
  /** Tracker.totalMs - externalTotalMs. Negative ⇒ tracker under-reports. */
  trackerVsExternalDeltaMs: number | null
  cacheState: ClickLatencyMeasurementForAutotest['cacheState']
  cacheSource: ClickLatencyMeasurementForAutotest['cacheSource']
  cacheMissReason: ClickLatencyMeasurementForAutotest['cacheMissReason']
  phases: {
    readyToIpcMs: number | null
    ipcMs: number | null
    applyMs: number | null
    modelBindMs: number | null
    monacoMs: number | null
    domCommitMs: number | null
    paintMs: number | null
    settleMs: number | null
  }
  cancelled: boolean
}

// External settle uses the same quiet-window idea as the in-app tracker but
// remains independent: it only watches Monaco DOM mutations.
const EXTERNAL_SETTLE_QUIET_MS = 200
const EXTERNAL_SETTLE_CAP_MS = 7000
// Quiescence window: how long with no DOM mutation before the external settle is
// declared done (was 600ms). Under EDR the first paint mutation can arrive late,
// so 600ms occasionally fired BEFORE any mutation, yielding a null external
// measurement (an unpaired sample that drops out → contributes to samples:0).
// 1500ms gives the delayed first mutation room to arrive; still bounded by
// EXTERNAL_SETTLE_CAP_MS so a genuinely-static view does not hang.
const EXTERNAL_SETTLE_NO_MUTATION_MS = 1500
const SUITE_WATCHDOG_RESERVE_MS = PER_FILE_TIMEOUT_MS + EXTERNAL_SETTLE_CAP_MS + 1000
// Minimum mutations that must arrive before we trust lastMutationAt.
// Below this, we treat the file as having no observable repaint (cached
// content with identical text both sides, or render skipped entirely)
// and report null so the comparison row drops the file.
const EXTERNAL_SETTLE_MIN_MUTATIONS = 1

function phase(start: number | null, end: number | null): number | null {
  if (start === null || end === null) return null
  return +(end - start).toFixed(2)
}

function measurementToResult(
  m: ClickLatencyMeasurementForAutotest,
  externalTotalMs: number | null
): PerFileResult {
  const trackerVsExternalDeltaMs = externalTotalMs !== null && m.totalMs !== null
    ? +(m.totalMs - externalTotalMs).toFixed(2)
    : null
  return {
    filename: m.filename,
    totalMs: m.totalMs,
    paintTotalMs: m.firstPaintMs,
    externalTotalMs,
    trackerVsExternalDeltaMs,
    cacheState: m.cacheState,
    cacheSource: m.cacheSource,
    cacheMissReason: m.cacheMissReason,
    phases: {
      readyToIpcMs: phase(m.clickAt, m.ipcStartAt),
      ipcMs: phase(m.ipcStartAt, m.ipcEndAt),
      applyMs: phase(m.ipcEndAt, m.stateSetAt),
      modelBindMs: phase(m.stateSetAt, m.modelBoundAt),
      monacoMs: phase(m.modelBoundAt ?? m.editorReadyAt, m.diffComputedAt),
      domCommitMs: phase(m.diffComputedAt, m.domCommittedAt),
      paintMs: phase(m.domCommittedAt ?? m.diffComputedAt, m.paintReadyAt),
      settleMs: phase(m.paintReadyAt ?? m.domCommittedAt ?? m.diffComputedAt, m.tokenizeSettleAt)
    },
    cancelled: m.cancelled
  }
}

/**
 * Independent click→paint observer. Plants a MutationObserver on the diff
 * editor's view-lines container, then waits for a quiet window
 * (`EXTERNAL_SETTLE_QUIET_MS` of zero mutations), capped at
 * `EXTERNAL_SETTLE_CAP_MS`. Returns the timestamp of the last observed
 * mutation (i.e. the moment the DOM stopped changing). The caller's click
 * start minus this gives the externally-observed total.
 *
 * Why this exists: tracker.totalMs is set inside an rAF after Monaco's
 * `onDidUpdateDiff`, but Monaco continues mutating the DOM as the
 * tokenizer streams tokens in. The autotest needs a measurement that
 * reflects what the user actually perceives ("I can see the colored
 * diff now"); the MutationObserver is the closest renderer-side proxy.
 */
function observeMonacoSettle(): Promise<number | null> {
  return new Promise((resolve) => {
    // Pick the first Monaco diff-editor visible. Both panes' view-lines
    // live inside .monaco-diff-editor; we observe the whole subtree for
    // childList mutations only (cursor blink uses attributes, which we
    // skip below). On panes that don't repaint at all the observer falls
    // through to its cap branch and the caller records null.
    const target =
      document.querySelector('.git-diff-monaco') ??
      document.querySelector('.monaco-diff-editor')
    if (!target) {
      resolve(null)
      return
    }
    const observerStart = performance.now()
    let mutationCount = 0
    let lastMutationAt = observerStart
    let quietTimer: number | null = null
    let capTimer: number | null = null
    let noMutationTimer: number | null = null
    const finish = () => {
      if (quietTimer !== null) window.clearTimeout(quietTimer)
      if (capTimer !== null) window.clearTimeout(capTimer)
      if (noMutationTimer !== null) window.clearTimeout(noMutationTimer)
      observer.disconnect()
      resolve(mutationCount < EXTERNAL_SETTLE_MIN_MUTATIONS ? null : lastMutationAt)
    }
    const observer = new MutationObserver((records) => {
      if (noMutationTimer !== null) {
        window.clearTimeout(noMutationTimer)
        noMutationTimer = null
      }
      mutationCount += records.length
      lastMutationAt = performance.now()
      if (quietTimer !== null) window.clearTimeout(quietTimer)
      quietTimer = window.setTimeout(finish, EXTERNAL_SETTLE_QUIET_MS)
    })
    // Only structural changes — view-line node additions / removals as
    // tokens stream in. Skip attribute changes (cursor blink toggles
    // `cursor-blinking` repeatedly) and character data (in-place text
    // edits, which a click-to-render measurement does not see).
    observer.observe(target, { childList: true, subtree: true })
    noMutationTimer = window.setTimeout(finish, EXTERNAL_SETTLE_NO_MUTATION_MS)
    capTimer = window.setTimeout(finish, EXTERNAL_SETTLE_CAP_MS)
  })
}

function dominantPhase(p: PerFileResult['phases']): { name: string; ms: number } | null {
  const entries: Array<{ name: string; ms: number }> = []
  if (p.readyToIpcMs !== null) entries.push({ name: 'ready→ipc', ms: p.readyToIpcMs })
  if (p.ipcMs !== null) entries.push({ name: 'ipc', ms: p.ipcMs })
  if (p.applyMs !== null) entries.push({ name: 'apply', ms: p.applyMs })
  if (p.modelBindMs !== null) entries.push({ name: 'model-bind', ms: p.modelBindMs })
  if (p.monacoMs !== null) entries.push({ name: 'monaco', ms: p.monacoMs })
  if (p.domCommitMs !== null) entries.push({ name: 'dom-commit', ms: p.domCommitMs })
  if (p.paintMs !== null) entries.push({ name: 'paint', ms: p.paintMs })
  if (p.settleMs !== null) entries.push({ name: 'settle', ms: p.settleMs })
  if (entries.length === 0) return null
  entries.sort((a, b) => b.ms - a.ms)
  return entries[0]
}

interface SelectOutcome {
  measurement: ClickLatencyMeasurementForAutotest | null
  externalTotalMs: number | null
}

async function selectAndAwaitPaint(
  ctx: AutotestContext,
  filename: string
): Promise<SelectOutcome> {
  const api = window.__onwardGitDiffDebug
  if (!api?.selectFileByPath || !api.getLastClickLatencyForFile) {
    return { measurement: null, externalTotalMs: null }
  }
  // Externally-observed click time. Captured before the click is
  // dispatched so the autotest's measurement is independent of the
  // tracker's `start()` call. Pair with the MutationObserver-based
  // settle below to get an end-to-end "user perceived" total that does
  // not rely on any of the tracker's instrumentation hooks.
  const externalClickAt = performance.now()
  const settlePromise = observeMonacoSettle()
  const ok = api.selectFileByPath(filename)
  if (!ok) {
    settlePromise.catch(() => {})
    return { measurement: null, externalTotalMs: null }
  }
  // The tracker keys by getFileKey(file). We do not have direct access to
  // that key from here, so we identify by filename match in the history
  // and wait for tokenizeSettleAt to be filled.
  const startedAt = performance.now()
  let measurement: ClickLatencyMeasurementForAutotest | null = null
  while (performance.now() - startedAt < PER_FILE_TIMEOUT_MS) {
    const history = api.getClickLatencyHistory?.() ?? []
    const match = [...history]
      .reverse()
      .find((m) => m.filename === filename && m.tokenizeSettleAt !== null && !m.cancelled)
    if (match) {
      measurement = match
      break
    }
    await ctx.sleep(20)
  }
  // Race the settle promise against a hard timeout so a stuck Monaco
  // editor cannot block the loop forever.
  const settleAt = await Promise.race<number | null>([
    settlePromise,
    new Promise<number | null>((resolve) => setTimeout(() => resolve(null), EXTERNAL_SETTLE_CAP_MS + 500))
  ])
  const externalTotalMs = settleAt !== null
    ? +(settleAt - externalClickAt).toFixed(2)
    : null
  return { measurement, externalTotalMs }
}

export async function testGitDiffClickLatency(ctx: AutotestContext): Promise<TestResult[]> {
  const { log, sleep, waitFor, terminalId, cancelled } = ctx
  const results: TestResult[] = []
  const startedAt = performance.now()
  let suiteWatchdogFailed = false

  const record = (name: string, ok: boolean, detail?: Record<string, unknown>) => {
    results.push({ name, ok, detail })
    log(`gdcl:record`, { name, ok, ...detail })
  }
  const elapsedMs = () => performance.now() - startedAt
  const hasSuiteBudget = (reserveMs = 0) => elapsedMs() + reserveMs <= SUITE_WATCHDOG_MS
  const failSuiteWatchdog = (stage: string, detail?: Record<string, unknown>) => {
    if (suiteWatchdogFailed) return
    suiteWatchdogFailed = true
    record('gdcl-suite-watchdog-180s', false, {
      stage,
      elapsedMs: +elapsedMs().toFixed(1),
      watchdogMs: SUITE_WATCHDOG_MS,
      ...detail
    })
  }
  const setPerformanceDiagnosticsSetting = async (enabled: boolean): Promise<boolean> => {
    const settingsButton = document.querySelector<HTMLButtonElement>('[data-testid="sidebar-settings-button"]')
    if (!settingsButton) return false
    if (!window.__onwardSettingsDebug?.isOpen?.()) {
      settingsButton.click()
      const opened = await waitFor(
        `gdcl-open-settings-for-diagnostics-${enabled ? 'on' : 'off'}`,
        () => Boolean(window.__onwardSettingsDebug?.isOpen?.()),
        4000,
        50
      )
      if (!opened) return false
    }
    const toggleReady = await waitFor(
      `gdcl-diagnostics-toggle-ready-${enabled ? 'on' : 'off'}`,
      () => Boolean(document.querySelector<HTMLInputElement>('[data-testid="settings-performance-diagnostics-toggle"]')),
      4000,
      50
    )
    if (!toggleReady) return false
    const toggle = document.querySelector<HTMLInputElement>('[data-testid="settings-performance-diagnostics-toggle"]')
    if (!toggle) return false
    if (toggle.checked !== enabled) {
      toggle.click()
      const updated = await waitFor(
        `gdcl-diagnostics-toggle-updated-${enabled ? 'on' : 'off'}`,
        () => document.querySelector<HTMLInputElement>('[data-testid="settings-performance-diagnostics-toggle"]')?.checked === enabled,
        2000,
        50
      )
      if (!updated) return false
    }
    settingsButton.click()
    return await waitFor(
      `gdcl-close-settings-for-diagnostics-${enabled ? 'on' : 'off'}`,
      () => !window.__onwardSettingsDebug,
      4000,
      50
    )
  }

  // Force the BrowserWindow to the foreground so the renderer is not
  // running in throttled / hidden-tab mode. Without this, requestAnimationFrame
  // is paused, which permanently stalls the click-latency tracker's
  // paint-seal step and turns every measurement into a `cancelled: true`
  // ghost. We log the visibility state so a regression is obvious.
  try {
    await window.electronAPI?.debug?.focusWindow?.()
  } catch {
    /* focusWindow failures are non-fatal — the autotest still proceeds */
  }
  log('gdcl:visibility', {
    visibilityState: typeof document !== 'undefined' ? document.visibilityState : 'unknown',
    hasFocus: typeof document !== 'undefined' ? document.hasFocus() : null
  })

  const diagnosticsDisabled = await setPerformanceDiagnosticsSetting(false)
  record('gdcl-performance-diagnostics-setting-can-disable', diagnosticsDisabled)

  // 1. Open Git Diff for the active terminal.
  window.dispatchEvent(new CustomEvent('git-diff:open', { detail: { terminalId } }))
  const opened = await waitFor(
    'gdcl-open',
    () => Boolean(window.__onwardGitDiffDebug?.isOpen?.()),
    15000 // EDR-tolerant readiness ceiling (was 8s): the diff panel mount is git-spawn-gated; waitFor short-circuits
  )
  record('gdcl-open', opened)
  if (!opened || cancelled()) return results

  const featureFlagOn =
    window.electronAPI?.debug?.featureFlags?.gitDiffPerformanceDiagnostics === true
  record('gdcl-performance-diagnostics-feature-flag-allows-setting', featureFlagOn)

  const panelHiddenWhenDisabled = !document.querySelector('.git-diff-debug-panel')
  record('gdcl-performance-diagnostics-hidden-when-setting-off', panelHiddenWhenDisabled)

  window.dispatchEvent(new CustomEvent('git-diff:close', { detail: { terminalId } }))
  await waitFor('gdcl-close-before-diagnostics-enable', () => !window.__onwardGitDiffDebug?.isOpen?.(), 4000, 50)
  const diagnosticsEnabled = await setPerformanceDiagnosticsSetting(true)
  record('gdcl-performance-diagnostics-setting-can-enable', diagnosticsEnabled)

  window.dispatchEvent(new CustomEvent('git-diff:open', { detail: { terminalId } }))
  const reopened = await waitFor(
    'gdcl-reopen-after-diagnostics-enable',
    () => Boolean(window.__onwardGitDiffDebug?.isOpen?.()),
    8000
  )
  record('gdcl-reopen-after-diagnostics-enable', reopened)
  if (!reopened || cancelled()) return results

  const panelDefaultCollapsed = Boolean(document.querySelector('.git-diff-debug-panel.is-collapsed')) &&
    !document.querySelector('.git-diff-debug-panel .gddp-body')
  record('gdcl-performance-diagnostics-default-collapsed', panelDefaultCollapsed)

  const panelToggle = document.querySelector<HTMLButtonElement>('.git-diff-debug-panel .gddp-toggle')
  panelToggle?.click()
  const panelExpanded = await waitFor(
    'gdcl-performance-diagnostics-expanded',
    () => Boolean(document.querySelector('.git-diff-debug-panel:not(.is-collapsed) .gddp-body')),
    2000
  )
  record('gdcl-performance-diagnostics-expanded', panelExpanded)

  const termsButton = document.querySelector<HTMLButtonElement>('.git-diff-debug-panel .gddp-header-button')
  termsButton?.click()
  const termsOpen = await waitFor(
    'gdcl-performance-diagnostics-terms-open',
    () => Boolean(document.querySelector('.git-diff-debug-panel .gddp-terms')),
    2000
  )
  const termsText = (document.querySelector('.git-diff-debug-panel .gddp-terms')?.textContent ?? '').trim()
  const normalizedTermsText = termsText.toLowerCase()
  record('gdcl-performance-diagnostics-terms-help', Boolean(
    termsOpen &&
    normalizedTermsText.includes('ipc fetch') &&
    normalizedTermsText.includes('settle') &&
    normalizedTermsText.includes('content cache strategy') &&
    normalizedTermsText.includes('recent-access queue')
  ), {
    termsOpen,
    termsText
  })
  panelToggle?.click()
  await waitFor(
    'gdcl-performance-diagnostics-recollapsed',
    () => Boolean(document.querySelector('.git-diff-debug-panel.is-collapsed')),
    2000
  )

  // 2. Wait for diff list to populate.
  const listReady = await waitFor(
    'gdcl-list-ready',
    () => {
      const api = window.__onwardGitDiffDebug
      if (!api?.isOpen?.()) return false
      const list = api.getFileList?.() ?? []
      return list.length > 0
    },
    15000 // EDR-tolerant readiness ceiling (was 8s): the file list is git-spawn-gated; waitFor short-circuits
  )
  record('gdcl-list-ready', listReady)
  if (!listReady) return results

  const api = window.__onwardGitDiffDebug
  if (!api) {
    record('gdcl-debug-api-present', false)
    return results
  }
  api.resetClickLatencyHistory?.()

  const fileList = api.getFileList?.() ?? []
  // Filter out files that the diff editor cannot meaningfully render
  // (binary blobs, deletions where there is no content to fetch).
  const candidates = fileList.filter((f) => {
    if (!f) return false
    const status = (f as { status?: string }).status
    if (status === 'D') return false
    return true
  })
  log('gdcl:candidates', { totalFiles: fileList.length, eligible: candidates.length })

  // Give Monaco's prewarm (mounted via the no-selection branch) time to
  // finish loading themes / language bundles / WASM before we start
  // measuring real clicks. Without this dwell the very first click pays a
  // chunk of the cold mount cost and the test result oscillates between
  // 0-3 over-target. A real user waits many hundreds of ms before clicking
  // anyway, so this is the click → render measurement they actually care
  // about.
  await sleep(800)

  // 3. Walk every file, record the measurement. Cap can be set via env for
  // local iteration; full regression walks the complete candidate set.
  const walkCap = (() => {
    const raw = (window.electronAPI?.debug as unknown as { autotestSuite?: string })?.autotestSuite ?? ''
    const m = raw.match(/cap=(\d+)/)
    if (m) return Math.max(1, Math.min(50, Number(m[1])))
    return candidates.length
  })()
  const perFile: PerFileResult[] = []
  let walkIndex = 0
  for (const file of candidates.slice(0, walkCap)) {
    walkIndex += 1
    if (cancelled()) break
    if (!hasSuiteBudget(SUITE_WATCHDOG_RESERVE_MS)) {
      failSuiteWatchdog('walk-budget-exhausted', {
        idx: walkIndex,
        total: Math.min(walkCap, candidates.length)
      })
      break
    }
    const filename = (file as { filename?: string }).filename
    if (!filename) continue
    try {
      await window.electronAPI?.debug?.focusWindow?.()
    } catch {
      /* focusWindow failures are non-fatal; per-file focus just avoids rAF throttling during long walks. */
    }
    log('gdcl:walk', { idx: walkIndex, total: candidates.length, filename })
    await sleep(SETTLE_BETWEEN_FILES_MS)
    const outcome = await selectAndAwaitPaint(ctx, filename)
    if (!outcome.measurement) {
      perFile.push({
        filename,
        totalMs: null,
        paintTotalMs: null,
        externalTotalMs: outcome.externalTotalMs,
        trackerVsExternalDeltaMs: null,
        cacheState: 'unknown',
        cacheSource: null,
        cacheMissReason: null,
        phases: {
          readyToIpcMs: null,
          ipcMs: null,
          applyMs: null,
          modelBindMs: null,
          monacoMs: null,
          domCommitMs: null,
          paintMs: null,
          settleMs: null
        },
        cancelled: true
      })
      continue
    }
    perFile.push(measurementToResult(outcome.measurement, outcome.externalTotalMs))
    log('gdcl:walk-done', {
      idx: walkIndex,
      filename,
      trackerMs: outcome.measurement?.totalMs ?? null,
      externalMs: outcome.externalTotalMs
    })
  }

  // Diagnostic: dump the tracker's full history so we can see whether
  // measurements were recorded but the polling missed them, or never
  // sealed at all (cancelled, missing tokenizeSettleAt, etc.).
	  log('gdcl:tracker-history-json',
	    JSON.stringify((api.getClickLatencyHistory?.() ?? []).map((m) => ({
	      filename: m.filename,
      cancelled: m.cancelled,
      cacheState: m.cacheState,
      cacheSource: m.cacheSource,
      cacheMissReason: m.cacheMissReason,
      hasIpcStart: m.ipcStartAt !== null,
      hasIpcEnd: m.ipcEndAt !== null,
      hasStateSet: m.stateSetAt !== null,
      hasModelBound: m.modelBoundAt !== null,
      hasEditorReady: m.editorReadyAt !== null,
      hasDiffComputed: m.diffComputedAt !== null,
      hasDomCommitted: m.domCommittedAt !== null,
      hasPaintReady: m.paintReadyAt !== null,
      hasTokenizeSettle: m.tokenizeSettleAt !== null,
      totalMs: m.totalMs
	    })))
	  )

	  const cachePanelToggle = document.querySelector<HTMLButtonElement>('.git-diff-debug-panel .gddp-toggle')
	  if (document.querySelector('.git-diff-debug-panel.is-collapsed')) {
	    cachePanelToggle?.click()
	  }
	  await waitFor(
	    'gdcl-performance-diagnostics-expanded-for-cache-hover',
	    () => Boolean(document.querySelector('.git-diff-debug-panel:not(.is-collapsed) .gddp-body')),
	    2000
	  )
	  const cacheRowReady = await waitFor(
	    'gdcl-performance-diagnostics-cache-row-ready',
	    () => Boolean(document.querySelector('.git-diff-debug-panel .gddp-cache-row .gddp-cache-path')),
	    4000,
	    100
	  )
	  const cachePathNode = document.querySelector<HTMLElement>('.git-diff-debug-panel .gddp-cache-row .gddp-cache-path')
	  cachePathNode?.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, clientX: 24, clientY: 24 }))
	  const cachePathHoverVisible = await waitFor(
	    'gdcl-performance-diagnostics-cache-path-hover',
	    () => {
	      const card = document.querySelector<HTMLElement>('.git-diff-debug-panel .gddp-cache-hover-card.is-path')
	      const text = card?.textContent ?? ''
	      return text.includes('Project path') && text.includes('/')
	    },
	    800,
	    25
	  )
	  const cacheNumbersNode = document.querySelector<HTMLElement>('.git-diff-debug-panel .gddp-cache-row .gddp-cache-numbers')
	  cacheNumbersNode?.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, clientX: 120, clientY: 24 }))
	  const cacheEntriesHoverVisible = await waitFor(
	    'gdcl-performance-diagnostics-cache-entries-hover',
	    () => {
	      const card = document.querySelector<HTMLElement>('.git-diff-debug-panel .gddp-cache-hover-card.is-entries')
	      const text = card?.textContent ?? ''
	      return text.includes('Cached entries') && (
	        Boolean(card?.querySelector('.gddp-cache-entry-list li')) ||
	        text.includes('No resident entries')
	      )
	    },
	    1200,
	    25
	  )
	  record('gdcl-performance-diagnostics-cache-hover-cards', Boolean(
	    cacheRowReady &&
	    cachePathHoverVisible &&
	    cacheEntriesHoverVisible
	  ), {
	    cacheRowReady,
	    cachePathHoverVisible,
	    cacheEntriesHoverVisible,
	    cacheHoverText: document.querySelector('.git-diff-debug-panel .gddp-cache-hover-card')?.textContent ?? ''
	  })

    const diagnosticsText = document.querySelector('.git-diff-debug-panel')?.textContent ?? ''
    // The list-cache help text (gitDiff.debug.terms.listCache in src/i18n/core.ts)
    // currently reads: "List cache ... Caches the changed-file list per project ...
    // when the list was last produced ...". Assert on those CURRENT copy markers,
    // not the long-retired "Last request" / "Resident lists" wording (the panel
    // copy was refactored; checking the old strings was test-vs-implementation drift).
    const listCacheExplained = diagnosticsText.includes('List cache') &&
      diagnosticsText.includes('changed-file list') &&
      diagnosticsText.includes('last produced')
    const watcherHealthHidden = !diagnosticsText.includes('Watcher health')
    record('gdcl-performance-diagnostics-list-cache-explained-watcher-hidden', Boolean(
      listCacheExplained &&
      watcherHealthHidden
    ), {
      listCacheExplained,
      watcherHealthHidden,
      diagnosticsText: diagnosticsText.slice(0, 1200)
    })

	  // Closed-loop validation: compare tracker's totalMs (what the in-app
  // debug panel surfaces) against the externally-observed settle time.
  // Negative deltas mean the tracker is reporting *less* than the user
  // perceives — the bug class we are explicitly hunting after the
  // placeholder-onDidUpdateDiff fix.
  const eligibleDeltas = perFile
    .filter((entry) =>
      typeof entry.trackerVsExternalDeltaMs === 'number' &&
      typeof entry.externalTotalMs === 'number' &&
      entry.externalTotalMs >= 1 // discard noise where both totals are essentially zero
    )
    .map((entry) => ({
      filename: entry.filename,
      trackerMs: entry.totalMs,
      externalMs: entry.externalTotalMs as number,
      deltaMs: entry.trackerVsExternalDeltaMs as number,
      absDeltaMs: Math.abs(entry.trackerVsExternalDeltaMs as number)
    }))
  const sortedByAbs = [...eligibleDeltas].sort((a, b) => b.absDeltaMs - a.absDeltaMs)
  const summary = {
    samples: eligibleDeltas.length,
    maxAbsDeltaMs: sortedByAbs[0]?.absDeltaMs ?? 0,
    p95AbsDeltaMs: sortedByAbs.length
      ? [...eligibleDeltas].sort((a, b) => a.absDeltaMs - b.absDeltaMs)[Math.min(eligibleDeltas.length - 1, Math.max(0, Math.ceil(eligibleDeltas.length * 0.95) - 1))]?.absDeltaMs ?? 0
      : 0,
    meanDeltaMs: eligibleDeltas.length
      ? +(eligibleDeltas.reduce((acc, e) => acc + e.deltaMs, 0) / eligibleDeltas.length).toFixed(2)
      : 0,
    worstUnderReportMs: eligibleDeltas.length
      ? Math.min(...eligibleDeltas.map(e => e.deltaMs))
      : 0,
    worst5: sortedByAbs.slice(0, 5)
  }
  log(`gdcl:tracker-vs-external-json ${JSON.stringify(summary)}`)
  // Pass when the tracker does not under-report external settle by more
  // than a generous window. Over-reporting is conservative for the debug
  // panel; the user-visible bug class is "panel says fast while the view
  // is still visibly settling".
  record('gdcl-tracker-vs-external-within-200ms', summary.worstUnderReportMs >= -200, {
    samples: summary.samples,
    maxAbsDeltaMs: summary.maxAbsDeltaMs,
    p95AbsDeltaMs: summary.p95AbsDeltaMs,
    worstUnderReportMs: summary.worstUnderReportMs,
    meanDeltaMs: summary.meanDeltaMs
  })

  // 4. Aggregate & emit a sorted breakdown. Use JSON.stringify so the
  // structured payload survives Node's util.inspect depth-2 truncation
  // when this log line lands in the runner shell output.
  const slowest = perFile
    .filter((entry) => typeof entry.totalMs === 'number')
    .sort((a, b) => (b.totalMs ?? 0) - (a.totalMs ?? 0))
    .slice(0, 10)
  log(`gdcl:slowest-10-json ${JSON.stringify(slowest)}`)
  log(`gdcl:per-file-json ${JSON.stringify(perFile)}`)

  const dominantHistogram = new Map<string, number>()
  for (const entry of perFile) {
    const dom = dominantPhase(entry.phases)
    if (dom) {
      dominantHistogram.set(dom.name, (dominantHistogram.get(dom.name) ?? 0) + 1)
    }
  }
  const histogram = [...dominantHistogram.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([name, count]) => ({ phase: name, count }))
  log(`gdcl:dominant-histogram-json ${JSON.stringify(histogram)}`)

  // 5. Assertion: every text-eligible file must settle within the cap window.
  const overTarget = perFile.filter(
    (entry) => entry.totalMs !== null && entry.totalMs > CLICK_TO_SETTLE_TARGET_MS
  )
  record(
    `gdcl-target-${CLICK_TO_SETTLE_TARGET_MS}ms`,
    overTarget.length === 0,
    {
      total: perFile.length,
      overTarget: overTarget.length,
      slowest: slowest[0] ?? null,
      dominantHistogram: histogram
    }
  )

  // 6. Cache invalidation verification (user spec point 3).
  //    Pick a small text file that is in the working set, snapshot its
  //    current content, mutate it via the saveFileContent IPC, wait for
  //    the Mirror invalidator chain to fire, then re-click
  //    and assert the new content reaches the renderer. We do not assert
  //    cache HIT/MISS state directly (that is a main-process concern);
  //    instead we verify the user-visible invariant: a background
  //    mutation lands in the next click without a stale read.
  if (!cancelled() && candidates.length > 0 && !suiteWatchdogFailed) {
    if (!hasSuiteBudget(SUITE_WATCHDOG_RESERVE_MS)) {
      failSuiteWatchdog('invalidation-budget-exhausted')
    }
  }

  if (!cancelled() && candidates.length > 0 && !suiteWatchdogFailed) {
    // Choose the smallest text file with a known status — easier to mutate
    // safely. Skip files we cannot stat / write back (untracked + deleted
    // paths give a flaky verification surface).
    const target = candidates.find((file) => {
      const status = (file as { status?: string }).status
      return status === 'M'
    })
    if (!target) {
      log('gdcl:invalidation:skip', { reason: 'no-modified-file' })
    } else {
      const targetName = (target as { filename?: string }).filename ?? ''
      try {
        // Read current content via a fresh click + getSelectedFileContent.
        try {
          await window.electronAPI?.debug?.focusWindow?.()
        } catch {
          /* best effort */
        }
        api.selectFileByPath(targetName)
        const targetReady = await waitFor(
          'gdcl-invalidation-target-ready',
          () => {
            const selected = api.getSelectedFile?.()
            return selected?.filename === targetName && Boolean(api.isSelectedReady?.())
          },
          5000
        )
        if (!targetReady) {
          log('gdcl:invalidation:skip', { reason: 'target-not-ready', target: targetName })
          record('gdcl-invalidation-on-background-mutation', false, {
            target: targetName,
            error: 'target-not-ready'
          })
          return results
        }
        const before = api.getSelectedFileContent?.() ?? null
        if (!before || typeof before.modifiedContent !== 'string') {
          log('gdcl:invalidation:skip', { reason: 'cannot-read-content', target: targetName })
        } else {
          // Append a sentinel line so the mutation is observable end-to-end.
          const sentinel = `\n// gdcl-invalidation-sentinel-${Date.now()}\n`
          const baseline = before.modifiedContent
          const mutated = baseline + sentinel
          const saveResult = await window.electronAPI.git.saveFileContent(ctx.rootPath, targetName, mutated)
          if (!saveResult?.success) {
            record('gdcl-invalidation-on-background-mutation', false, {
              target: targetName,
              error: saveResult?.error ?? 'save-failed'
            })
            return results
          }
          // Give the invalidator chain (Mirror debounce + cache wipe +
          // precompute requeue) time to
          // settle, then click again and confirm the renderer sees the
          // new content. This proves the cache invalidates on background
          // mutation rather than serving stale.
          // Poll for the sentinel to appear in the renderer's view of the
          // file. The invalidation chain is Mirror Worker debounce →
          // GIT_DIFF_CACHE_INVALIDATED IPC → renderer-side listener →
          // ensureFileContent(force=true) → fresh body lands in
          // fileContentsRef. The exact end-to-end latency varies with git
          // read time on the machine; poll up to 5 s and accept as soon
          // as the sentinel is observed.
          // Correctness signal = the mutated body becomes visible (the cache did
          // NOT serve stale). This is reliable; the cache MISS *reason* is not a
          // sound gate here: with the diff panel OPEN, an invalidation marks the
          // selected file STALE and the renderer re-resolves its body WITHOUT
          // always surfacing a captured force-load miss (see GitDiffViewer
          // `ensureFileContent` stale path), so a fixed-point `getLastFileContentLoad`
          // snapshot can read a later renderer-memory HIT even though invalidation
          // worked. We therefore gate on freshness (poll + re-click) and capture
          // any invalidation-miss load OPPORTUNISTICALLY as supporting evidence.
          const INVALIDATION_MISS_REASONS = ['invalidated-mutation', 'invalidated-watch', 'invalidated-mirror']
          const isInvalidationMiss = (load: ReturnType<NonNullable<typeof api.getLastFileContentLoad>>) => Boolean(
            load?.cacheInfo?.state === 'miss' &&
            load.cacheInfo.missReason != null &&
            INVALIDATION_MISS_REASONS.includes(load.cacheInfo.missReason)
          )
          let sentinelLanded = false
          let observedInvalidationMiss: ReturnType<NonNullable<typeof api.getLastFileContentLoad>> = null
          const sentinelDeadline = performance.now() + 5000
          while (performance.now() < sentinelDeadline) {
            // getSelectedFileContent is a pure read, so polling the last load
            // before it cannot be clobbered by the probe — catch the transient
            // invalidation miss whenever it lands.
            const load = api.getLastFileContentLoad?.() ?? null
            if (!observedInvalidationMiss && isInvalidationMiss(load)) observedInvalidationMiss = load
            const probe = api.getSelectedFileContent?.() ?? null
            if (probe && typeof probe.modifiedContent === 'string' && probe.modifiedContent.includes(sentinel.trim())) {
              sentinelLanded = true
              break
            }
            await sleep(100)
          }
          // Re-click and confirm the on-click path ALSO serves the fresh body
          // (not just the live poll). Two independent freshness observations.
          api.selectFileByPath(targetName)
          const reread = await selectAndAwaitPaint(ctx, targetName)
          const after = api.getSelectedFileContent?.() ?? null
          const postReadHasSentinel = Boolean(after && typeof after.modifiedContent === 'string' && after.modifiedContent.includes(sentinel.trim()))
          record('gdcl-invalidation-on-background-mutation', sentinelLanded && postReadHasSentinel, {
            target: targetName,
            sawSentinel: sentinelLanded,
            postReadHasSentinel,
            observedInvalidationMiss,
            cacheStateAfter: reread.measurement?.cacheState ?? null,
            cacheSourceAfter: reread.measurement?.cacheSource ?? null,
            cacheMissReasonAfter: reread.measurement?.cacheMissReason ?? null,
            totalMsAfter: reread.measurement?.totalMs ?? null,
            externalTotalMsAfter: reread.externalTotalMs
          })
          // Restore the file to its pre-test content so subsequent autotest
          // suites don't see an artificial sentinel diff.
          await window.electronAPI.git.saveFileContent(ctx.rootPath, targetName, baseline)
          await sleep(300)
        }
      } catch (error) {
        record('gdcl-invalidation-on-background-mutation', false, {
          target: targetName,
          error: String(error)
        })
      }
    }
  }

  // Close diff at the end so subsequent suites have a clean slate.
  window.dispatchEvent(new CustomEvent('git-diff:close', { detail: { terminalId } }))
  await waitFor('gdcl-close', () => !window.__onwardGitDiffDebug?.isOpen?.(), 4000)
  if (!suiteWatchdogFailed) {
    const totalElapsedMs = elapsedMs()
    record('gdcl-suite-watchdog-180s', totalElapsedMs <= SUITE_WATCHDOG_MS, {
      elapsedMs: +totalElapsedMs.toFixed(1),
      watchdogMs: SUITE_WATCHDOG_MS
    })
  }
  log('gdcl:done', { totalMs: +elapsedMs().toFixed(1) })

  return results
}
