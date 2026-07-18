/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

import { featureUseSummaryKey } from './telemetry-event-names.ts'

/**
 * Pure daily-stats logic for the telemetry aggregator: the DailyStats
 * shape, defaults, and the summary builder. Extracted from
 * telemetry-aggregator.ts (which owns the Electron/fs side effects) so the
 * roll-up math is unit-testable in plain Node.
 *
 * 2026-07 metric redesign (P1) extends the January-era counter set with
 * the stability and update domains, and fixes two aggregation defects:
 * - `dropdown/tools` emits `codeAgent` since the unified launcher landed,
 *   but only the legacy claudeCode/codex keys were counted — codeAgent
 *   clicks were silently dropped.
 * - `error/gpuProcessCrash` and the five `update/*` events reached the raw
 *   outbox but never the uploaded aggregate.
 */

export interface DailyStats {
  /** Date string YYYY-MM-DD for which this data applies */
  date: string
  /** Timestamp of last upload (0 = never uploaded) */
  lastUploadedAt: number

  // --- Session ---
  /** Number of app sessions started today */
  sessionCount: number
  /** Array of individual session active durations (ms) for min/max/avg/p50/p95 */
  sessionDurations: number[]

  // --- Heartbeat snapshots (for tab/terminal/layout analysis) ---
  /** Sampled tabCount values from heartbeats */
  tabCounts: number[]
  /** Sampled terminalCount values from heartbeats */
  terminalCounts: number[]
  /** Sampled layoutMode values from heartbeats */
  layoutModes: number[]

  // --- Feature usage counts ---
  /** prompt/use action counts */
  promptSend: number
  promptExecute: number
  promptSendAndExecute: number

  /** dropdown feature click counts (menu + shortcut) */
  dropdownWorkspaceOpenDir: number
  dropdownWorkspaceChangeDir: number
  dropdownDevelopmentEditor: number
  dropdownDevelopmentGitDiff: number
  dropdownDevelopmentGitHistory: number
  /** Legacy counters — the split launcher entries retired in spring 2026 */
  dropdownToolsClaudeCode: number
  dropdownToolsCodex: number
  /** Unified Coding Agent launcher (replaces the claudeCode/codex split) */
  dropdownToolsCodeAgent: number
  dropdownToolsBrowser: number

  // --- Stability ---
  rendererCrashCount: number
  gpuCrashCount: number
  unresponsiveCount: number
  webglFallbackCount: number
  watcherDegradedCount: number

  // --- Update lifecycle ---
  updateCheckCount: number
  updateDownloadedCount: number
  updateInstallStartCount: number
  updateInstallCompleteCount: number
  updateErrorCount: number

  /**
   * P2 generic feature-usage counters, keyed by allowlisted feature-use ID
   * (registry: telemetry-event-names.ts TELEMETRY_FEATURE_USE_IDS). Keyed
   * map instead of one flat field per feature so adding a feature never
   * touches this schema again.
   */
  featureUse: Record<string, number>
}

export function createEmptyStats(date: string): DailyStats {
  return {
    date,
    lastUploadedAt: 0,
    sessionCount: 0,
    sessionDurations: [],
    tabCounts: [],
    terminalCounts: [],
    layoutModes: [],
    promptSend: 0,
    promptExecute: 0,
    promptSendAndExecute: 0,
    dropdownWorkspaceOpenDir: 0,
    dropdownWorkspaceChangeDir: 0,
    dropdownDevelopmentEditor: 0,
    dropdownDevelopmentGitDiff: 0,
    dropdownDevelopmentGitHistory: 0,
    dropdownToolsClaudeCode: 0,
    dropdownToolsCodex: 0,
    dropdownToolsCodeAgent: 0,
    dropdownToolsBrowser: 0,
    rendererCrashCount: 0,
    gpuCrashCount: 0,
    unresponsiveCount: 0,
    webglFallbackCount: 0,
    watcherDegradedCount: 0,
    updateCheckCount: 0,
    updateDownloadedCount: 0,
    updateInstallStartCount: 0,
    updateInstallCompleteCount: 0,
    updateErrorCount: 0,
    featureUse: {}
  }
}

/**
 * Merge a persisted (possibly older-schema) stats object over fresh
 * defaults so counters added by later app versions load as 0 instead of
 * undefined. Unknown extra keys from the future are preserved.
 */
export function mergeStatsWithDefaults(parsed: Partial<DailyStats>, fallbackDate: string): DailyStats {
  const merged = { ...createEmptyStats(parsed.date || fallbackDate), ...parsed }
  // A malformed persisted featureUse (from a corrupt file) must not break ++
  if (typeof merged.featureUse !== 'object' || merged.featureUse === null || Array.isArray(merged.featureUse)) {
    merged.featureUse = {}
  }
  return merged
}

export function getTodayDate(): string {
  return new Date().toISOString().slice(0, 10)
}

export function computePercentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0
  const idx = Math.ceil((p / 100) * sorted.length) - 1
  return sorted[Math.max(0, idx)]
}

/**
 * Build an aggregated summary from daily stats for upload.
 */
export function buildDailySummary(stats: DailyStats): Record<string, string | number> {
  const durations = [...stats.sessionDurations].sort((a, b) => a - b)
  const totalActiveMs = durations.reduce((sum, d) => sum + d, 0)

  const tabSorted = [...stats.tabCounts].sort((a, b) => a - b)
  const termSorted = [...stats.terminalCounts].sort((a, b) => a - b)
  const layoutSorted = [...stats.layoutModes].sort((a, b) => a - b)

  return {
    date: stats.date,

    // Session statistics
    sessionCount: stats.sessionCount,
    totalActiveMs,
    sessionDurationMin: durations[0] ?? 0,
    sessionDurationMax: durations[durations.length - 1] ?? 0,
    sessionDurationAvg: durations.length > 0 ? Math.round(totalActiveMs / durations.length) : 0,
    sessionDurationP50: computePercentile(durations, 50),
    sessionDurationP95: computePercentile(durations, 95),

    // Workspace scale (from heartbeat snapshots)
    tabCountMax: tabSorted[tabSorted.length - 1] ?? 0,
    tabCountAvg: tabSorted.length > 0 ? Math.round(tabSorted.reduce((s, v) => s + v, 0) / tabSorted.length) : 0,
    terminalCountMax: termSorted[termSorted.length - 1] ?? 0,
    terminalCountAvg: termSorted.length > 0 ? Math.round(termSorted.reduce((s, v) => s + v, 0) / termSorted.length) : 0,
    layoutModeMax: layoutSorted[layoutSorted.length - 1] ?? 0,

    // Feature usage counts
    promptSend: stats.promptSend,
    promptExecute: stats.promptExecute,
    promptSendAndExecute: stats.promptSendAndExecute,
    dropdownWorkspaceOpenDir: stats.dropdownWorkspaceOpenDir,
    dropdownWorkspaceChangeDir: stats.dropdownWorkspaceChangeDir,
    dropdownDevelopmentEditor: stats.dropdownDevelopmentEditor,
    dropdownDevelopmentGitDiff: stats.dropdownDevelopmentGitDiff,
    dropdownDevelopmentGitHistory: stats.dropdownDevelopmentGitHistory,
    dropdownToolsClaudeCode: stats.dropdownToolsClaudeCode,
    dropdownToolsCodex: stats.dropdownToolsCodex,
    dropdownToolsCodeAgent: stats.dropdownToolsCodeAgent,
    dropdownToolsBrowser: stats.dropdownToolsBrowser,

    // Stability
    rendererCrashCount: stats.rendererCrashCount,
    gpuCrashCount: stats.gpuCrashCount,
    unresponsiveCount: stats.unresponsiveCount,
    webglFallbackCount: stats.webglFallbackCount,
    watcherDegradedCount: stats.watcherDegradedCount,

    // Update lifecycle
    updateCheckCount: stats.updateCheckCount,
    updateDownloadedCount: stats.updateDownloadedCount,
    updateInstallStartCount: stats.updateInstallStartCount,
    updateInstallCompleteCount: stats.updateInstallCompleteCount,
    updateErrorCount: stats.updateErrorCount,

    // P2 feature-use counters, flattened to fu_* numeric keys
    ...Object.fromEntries(
      Object.entries(stats.featureUse ?? {}).map(([id, count]) => [
        featureUseSummaryKey(id),
        Number(count) || 0
      ])
    )
  }
}
