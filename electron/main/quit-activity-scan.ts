/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 *
 * Wiring for the activity-aware quit confirmation: one-shot process-table
 * snapshot + terminal-label lookup + pure classification. Fail-open by
 * design — any error or slow scan yields null and the caller shows the
 * plain quit dialog; activity detection must never block quitting.
 */

import { performanceTrace } from './performance-trace'
import { PERF_TRACE_EVENT } from '../../src/utils/perf-trace-names'
import { getAppStateStorage } from './app-state-storage'
import { listProcessTable } from './process-table'
import {
  classifyTerminalActivity,
  summarizeQuitActivity,
  type QuitActivitySummary,
  type TerminalShellRef
} from './quit-activity'

const SCAN_BUDGET_MS = 800
const MAX_DIALOG_NAMES = 3

/**
 * Prime the platform process-table path once after startup so the first
 * real scan runs hot. Matters on Windows, where PowerShell/CIM cold-start
 * can exceed the scan budget and needlessly degrade the quit dialog to the
 * generic copy; harmless elsewhere (`ps` is already fast). Platform-neutral
 * by construction — same call on all three platforms, result discarded.
 */
export function warmQuitActivityScanner(): void {
  void listProcessTable().catch(() => {})
}

interface ShellRefProvider {
  listShellRefs(): Array<{ terminalId: string; shellPid: number }>
}

/** Map terminalId -> user-facing custom name from the app-state snapshot. */
export function readTerminalLabels(): Map<string, string> {
  const labels = new Map<string, string>()
  try {
    const state = getAppStateStorage().get() as {
      tabs?: Array<{ terminals?: Array<{ id?: string; customName?: string }> }>
    }
    for (const tab of state.tabs ?? []) {
      for (const term of tab.terminals ?? []) {
        if (term.id && term.customName && term.customName.trim()) {
          labels.set(term.id, term.customName.trim())
        }
      }
    }
  } catch {
    // Label lookup is cosmetic; classification works without it.
  }
  return labels
}

/**
 * Collect the quit-dialog activity summary, or null when there is nothing
 * to warn about (no terminals, scan failure, or scan over budget).
 */
export async function collectQuitActivitySummary(
  ptyManager: ShellRefProvider
): Promise<QuitActivitySummary | null> {
  const startedAt = Date.now()
  let error: string | null = null
  try {
    const labels = readTerminalLabels()
    const shells: TerminalShellRef[] = ptyManager
      .listShellRefs()
      .map((ref) => ({ ...ref, label: labels.get(ref.terminalId) }))
    if (shells.length === 0) {
      performanceTrace.record(PERF_TRACE_EVENT.MAIN_QUIT_ACTIVITY_SCAN, {
        terminalCount: 0,
        activeCount: 0,
        jobs: [],
        durationMs: Date.now() - startedAt,
        outcome: 'no-terminals'
      })
      return null
    }
    const timeout = new Promise<never>((_, reject) => {
      const t = setTimeout(() => reject(new Error('quit-activity scan over budget')), SCAN_BUDGET_MS)
      t.unref()
    })
    const table = await Promise.race([listProcessTable(), timeout])
    const summary = summarizeQuitActivity(classifyTerminalActivity(shells, table), MAX_DIALOG_NAMES)
    performanceTrace.record(PERF_TRACE_EVENT.MAIN_QUIT_ACTIVITY_SCAN, {
      terminalCount: summary.terminalCount,
      activeCount: summary.activeCount,
      jobs: summary.jobNames,
      durationMs: Date.now() - startedAt,
      outcome: 'ok'
    })
    return summary
  } catch (scanError) {
    error = String(scanError).slice(0, 200)
    performanceTrace.record(PERF_TRACE_EVENT.MAIN_QUIT_ACTIVITY_SCAN, {
      terminalCount: -1,
      activeCount: -1,
      jobs: [],
      durationMs: Date.now() - startedAt,
      outcome: 'error',
      error
    })
    return null
  }
}
