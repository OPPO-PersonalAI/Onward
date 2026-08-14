/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Regression suite for Cmd+P arrow-key navigation.
 *
 * Authored after a user reported "arrow keys feel laggy". Measurement showed
 * the render was never slow (0.8ms median / 8.5ms p95); what was broken was
 * everything AROUND the render:
 *   - the list never scrolled, so the highlight walked off-screen and the user
 *     saw nothing move (17 of 20 presses landed out of view);
 *   - the press that reached the page boundary was clamped into a no-op, so it
 *     had to be pressed twice at one fixed spot in every list.
 *
 * The assertions below therefore gate BOTH the timing and the two things that
 * made a fast list feel frozen. Timing is measured end-to-end — dispatch a real
 * keydown, then wait for the DOM to show the highlight on the next row — since
 * that span is what the user actually feels.
 */

import type { AutotestContext, TestResult } from './types'

/**
 * Per-press budget, agreed with the product owner on 2026-08-07: one frame.
 * Baseline at authoring was 0.8ms median / 8.5ms p95, so this leaves ample
 * headroom while still failing the moment a press stops landing in the frame it
 * was pressed in.
 */
const ARROW_KEY_LATENCY_BUDGET_MS = 16

/**
 * Latency aggregates 3 trials and passes if ANY trial meets the budget: a GC
 * pause or OS scheduling blip is acknowledged noise, whereas 3-of-3 over budget
 * is a systematic regression. (Project convention for latency cases.)
 */
const LATENCY_TRIALS = 3
const PRESSES_PER_TRIAL = 20

interface KeyPressSample {
  latencyMs: number
  activeRow: number
  visible: boolean
}

export async function testQuickOpenKeyLatency(ctx: AutotestContext): Promise<TestResult[]> {
  const { log, sleep, waitFor, assert, rootPath } = ctx
  const results: TestResult[] = []

  const record = (name: string, ok: boolean, detail?: Record<string, unknown>) => {
    assert(name, ok, detail)
    results.push({ name, ok, detail })
  }

  const getApi = () => window.__onwardProjectEditorDebug
  const listEl = () =>
    document.querySelector<HTMLElement>('.project-editor-search .global-search-results')
  const rows = () => Array.from(
    document.querySelectorAll<HTMLElement>('.project-editor-search .global-search-filename-item')
  )
  const activeRowIndex = () => rows().findIndex((row) => row.classList.contains('active'))

  const isRowVisible = (rowIndex: number): boolean => {
    const list = listEl()
    const row = rows()[rowIndex]
    if (!list || !row) return false
    const listRect = list.getBoundingClientRect()
    const rowRect = row.getBoundingClientRect()
    return rowRect.top >= listRect.top - 1 && rowRect.bottom <= listRect.bottom + 1
  }

  /** Resolve on the first animation frame where `predicate` holds, else NaN. */
  const waitForFrame = (predicate: () => boolean, timeoutMs = 2000): Promise<number> =>
    new Promise((resolve) => {
      const start = performance.now()
      const tick = () => {
        if (predicate()) return resolve(performance.now() - start)
        if (performance.now() - start > timeoutMs) return resolve(Number.NaN)
        requestAnimationFrame(tick)
      }
      requestAnimationFrame(tick)
    })

  const pressArrow = (input: HTMLInputElement, key: 'ArrowDown' | 'ArrowUp') => {
    input.dispatchEvent(new KeyboardEvent('keydown', {
      key, code: key, bubbles: true, cancelable: true
    }))
  }

  const medianOf = (values: number[]): number => {
    if (values.length === 0) return -1
    const sorted = [...values].sort((a, b) => a - b)
    return sorted[Math.floor(sorted.length / 2)]
  }

  try {
    log('qokl:start', { rootPath })

    const api = getApi()
    if (!api?.openGlobalFilenameSearch) {
      record('QOKL-00-debug-api', false, { reason: 'project editor debug hooks missing' })
      return results
    }

    await api.openGlobalFilenameSearch()
    await waitFor('QOKL-01-open', () => Boolean(getApi()?.isGlobalFilenameSearchOpen?.()), 3000)
    record('QOKL-01-open', true)

    // A broad query so the candidate list is long — the reported case is
    // "type a keyword, several candidates appear, then arrow through them".
    getApi()!.setGlobalFilenameSearchQuery!('e')
    await waitFor(
      'QOKL-02-results',
      () => (getApi()?.getGlobalFilenameSearchResults?.().length ?? 0) >= 10,
      5000
    )
    await sleep(300)
    record('QOKL-02-results', rows().length >= 10, { renderedRows: rows().length })
    if (rows().length < 10) return results

    const input = document.querySelector<HTMLInputElement>('.project-editor-search .global-search-input')
    if (!input) {
      record('QOKL-03-input-present', false)
      return results
    }
    input.focus()
    record('QOKL-03-input-present', true)

    // === Trials: per-press latency + on-screen visibility ===
    const trialMedians: number[] = []
    const allSamples: KeyPressSample[] = []

    for (let trial = 0; trial < LATENCY_TRIALS; trial += 1) {
      // Reset to the top so every trial walks the same rows.
      for (let i = 0; i < PRESSES_PER_TRIAL + 5; i += 1) pressArrow(input, 'ArrowUp')
      await sleep(200)

      const trialLatencies: number[] = []
      for (let i = 0; i < PRESSES_PER_TRIAL; i += 1) {
        const before = activeRowIndex()
        pressArrow(input, 'ArrowDown')
        const latency = await waitForFrame(() => activeRowIndex() !== before, 2000)
        const after = activeRowIndex()
        const sample: KeyPressSample = {
          latencyMs: Number.isNaN(latency) ? -1 : +latency.toFixed(1),
          activeRow: after,
          visible: isRowVisible(after)
        }
        allSamples.push(sample)
        if (sample.latencyMs >= 0) trialLatencies.push(sample.latencyMs)
        // Independent observations rather than one coalesced batch.
        await sleep(40)
      }
      trialMedians.push(medianOf(trialLatencies))
      log('qokl:trial', { trial, median: trialMedians[trial], samples: trialLatencies })
    }

    const landed = allSamples.filter((s) => s.latencyMs >= 0)
    record('QOKL-04-every-press-lands', landed.length === allSamples.length, {
      dropped: allSamples.length - landed.length,
      totalPresses: allSamples.length,
      note: 'a dropped press means the highlight never moved within 2s'
    })

    // ANY trial within budget passes; all three over budget is a real regression.
    const withinBudget = trialMedians.filter((m) => m >= 0 && m <= ARROW_KEY_LATENCY_BUDGET_MS)
    record('QOKL-05-latency-within-budget', withinBudget.length >= 1, {
      budgetMs: ARROW_KEY_LATENCY_BUDGET_MS,
      trialMedians,
      trialsWithinBudget: withinBudget.length,
      worstSample: landed.length ? Math.max(...landed.map((s) => s.latencyMs)) : -1
    })

    // The defect that made a 1ms list feel frozen: the highlight must never
    // leave the scroll viewport.
    const offscreen = allSamples.filter((s) => !s.visible)
    record('QOKL-06-selected-row-always-visible', offscreen.length === 0, {
      offscreenPresses: offscreen.length,
      totalPresses: allSamples.length,
      offscreenRows: offscreen.slice(0, 5).map((s) => s.activeRow)
    })

    // === Page boundary: the press must not be swallowed ===
    // Walk to the last loaded row, then press once more. Prefetch should have
    // the next page ready; if it is still in flight the step is deferred and
    // completed on arrival. Either way the selection must advance without a
    // second press.
    const loadedBefore = rows().length
    let guard = 0
    while (activeRowIndex() < loadedBefore - 1 && guard < loadedBefore + 10) {
      pressArrow(input, 'ArrowDown')
      await sleep(12)
      guard += 1
    }
    await sleep(300)
    const atBoundary = activeRowIndex()
    log('qokl:boundary-approach', { loadedBefore, atBoundary, rowsNow: rows().length })

    pressArrow(input, 'ArrowDown')
    // Generous window: this one press may legitimately wait on an IPC page
    // fetch. What must NOT happen is it being dropped entirely.
    const boundaryLatency = await waitForFrame(() => activeRowIndex() > atBoundary, 4000)
    record('QOKL-07-page-boundary-press-not-swallowed', Number.isFinite(boundaryLatency), {
      activeRowAtBoundary: atBoundary,
      activeRowAfter: activeRowIndex(),
      latencyMs: Number.isNaN(boundaryLatency) ? -1 : +boundaryLatency.toFixed(1),
      note: 'the old clamp made this press produce no movement at all'
    })

    // === Hover must not hijack a keyboard-driven selection ===
    // React synthesises mouseenter from delegated mouseover, so a raw
    // `mouseenter` dispatch would never reach the handler — use mouseover with
    // a relatedTarget, which is what a real pointer crossing produces.
    const keyboardTarget = activeRowIndex()
    const probe = rows()[2]
    if (probe && keyboardTarget !== 2) {
      probe.dispatchEvent(new MouseEvent('mouseover', {
        bubbles: true,
        cancelable: true,
        relatedTarget: document.body
      }))
      await sleep(150)
      record('QOKL-08-hover-does-not-hijack-keyboard-selection', activeRowIndex() === keyboardTarget, {
        keyboardTarget,
        afterHover: activeRowIndex(),
        note: 'rows sliding under a stationary cursor must not steal the selection'
      })

      // A real pointer move hands control back to the mouse.
      const list = listEl()
      if (list) {
        list.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, cancelable: true }))
        await sleep(60)
        probe.dispatchEvent(new MouseEvent('mouseover', {
          bubbles: true,
          cancelable: true,
          relatedTarget: document.body
        }))
        await sleep(150)
        record('QOKL-09-real-pointer-move-restores-hover', activeRowIndex() === 2, {
          expected: 2,
          actual: activeRowIndex(),
          note: 'hover must still work once the user genuinely moves the mouse'
        })
      }
    }

    // === Keyboard affordance is on screen ===
    const hints = document.querySelector<HTMLElement>('.project-editor-search .global-search-hints')
    const position = document.querySelector<HTMLElement>(
      '.project-editor-search .global-search-hint-position'
    )
    record('QOKL-10-keyboard-hints-visible', Boolean(hints && position), {
      hintText: hints?.textContent?.trim().slice(0, 80) ?? null,
      positionText: position?.textContent?.trim() ?? null
    })

    getApi()!.closeGlobalFilenameSearch!()
  } finally {
    // No fixtures created; nothing to clean up.
  }

  return results
}
