/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

import { app } from 'electron'
import { join } from 'path'
import { readFileSync, writeFileSync, existsSync } from 'fs'
import { TELEMETRY_FORCE_UPLOAD } from './telemetry-constants'
import {
  buildDailySummary,
  createEmptyStats,
  getTodayDate,
  mergeStatsWithDefaults,
  type DailyStats
} from './telemetry-daily-stats'

/**
 * Daily telemetry aggregator.
 *
 * Accumulates usage statistics in memory and persists to disk periodically.
 * Once per day, the aggregated summary is uploaded to the telemetry backend
 * and counters are reset. The stats shape and roll-up math live in
 * `telemetry-daily-stats.ts` (pure, unit-tested); this module owns the
 * Electron/fs side effects only.
 */

export { buildDailySummary, type DailyStats }

class DailyAggregator {
  private stats: DailyStats
  private storagePath: string

  constructor() {
    this.storagePath = join(app.getPath('userData'), 'telemetry-daily.json')
    this.stats = this.load()
    // If the date rolled over, the old stats should have been uploaded.
    // If they weren't (e.g. app wasn't running), we reset for today.
    if (this.stats.date !== getTodayDate()) {
      this.stats = createEmptyStats(getTodayDate())
    }
  }

  // --- Recording methods ---

  recordSessionStart(): void {
    this.stats.sessionCount++
    this.persist()
  }

  recordSessionEnd(activeMs: number): void {
    this.stats.sessionDurations.push(activeMs)
    this.persist()
  }

  recordHeartbeat(tabCount: number, terminalCount: number, layoutMode: number): void {
    this.stats.tabCounts.push(tabCount)
    this.stats.terminalCounts.push(terminalCount)
    this.stats.layoutModes.push(layoutMode)
    this.persist()
  }

  recordPrompt(action: string): void {
    switch (action) {
      case 'send': this.stats.promptSend++; break
      case 'execute': this.stats.promptExecute++; break
      case 'sendAndExecute': this.stats.promptSendAndExecute++; break
    }
    this.persist()
  }

  recordDropdown(event: string, action: string): void {
    const key = `${event}/${action}`
    switch (key) {
      case 'dropdown/workspace/openDir': this.stats.dropdownWorkspaceOpenDir++; break
      case 'dropdown/workspace/changeDir': this.stats.dropdownWorkspaceChangeDir++; break
      case 'dropdown/development/editor': this.stats.dropdownDevelopmentEditor++; break
      case 'dropdown/development/gitDiff': this.stats.dropdownDevelopmentGitDiff++; break
      case 'dropdown/development/gitHistory': this.stats.dropdownDevelopmentGitHistory++; break
      case 'dropdown/tools/claudeCode': this.stats.dropdownToolsClaudeCode++; break
      case 'dropdown/tools/codex': this.stats.dropdownToolsCodex++; break
      // Unified launcher key emitted since the claudeCode/codex split retired
      case 'dropdown/tools/codeAgent': this.stats.dropdownToolsCodeAgent++; break
      case 'dropdown/tools/browser': this.stats.dropdownToolsBrowser++; break
    }
    this.persist()
  }

  recordRendererCrash(): void {
    this.stats.rendererCrashCount++
    this.persist()
  }

  recordGpuCrash(): void {
    this.stats.gpuCrashCount++
    this.persist()
  }

  recordRecovered(kind: string): void {
    switch (kind) {
      case 'unresponsive': this.stats.unresponsiveCount++; break
      case 'webgl-fallback': this.stats.webglFallbackCount++; break
      case 'watcher-degraded': this.stats.watcherDegradedCount++; break
    }
    this.persist()
  }

  recordFeatureUse(featureUseId: string): void {
    if (!featureUseId) return
    this.stats.featureUse[featureUseId] = (this.stats.featureUse[featureUseId] ?? 0) + 1
    this.persist()
  }

  recordUpdateEvent(eventName: string): void {
    switch (eventName) {
      case 'update/check': this.stats.updateCheckCount++; break
      case 'update/downloaded': this.stats.updateDownloadedCount++; break
      case 'update/installStart': this.stats.updateInstallStartCount++; break
      case 'update/installComplete': this.stats.updateInstallCompleteCount++; break
      case 'update/error': this.stats.updateErrorCount++; break
    }
    this.persist()
  }

  // --- Upload check ---

  /**
   * UTC date the in-memory stats currently accumulate for. Outbox lines
   * strictly older than this date belong to the remediation pipeline;
   * this date itself is still owned by the daily-summary pipeline.
   */
  getStatsDate(): string {
    return this.stats.date
  }

  /**
   * Check if a daily upload is due. Returns the aggregated summary if yes, null if no.
   * After a successful upload, call `markUploaded()`.
   */
  getUploadPayloadIfDue(): Record<string, string | number> | null {
    // Debug: force upload on every check when ONWARD_TELEMETRY_FORCE_UPLOAD=1
    if (TELEMETRY_FORCE_UPLOAD && this.stats.sessionCount > 0 && this.stats.lastUploadedAt === 0) {
      return buildDailySummary(this.stats)
    }

    const today = getTodayDate()

    // If the date rolled over and we have yesterday's data that wasn't uploaded
    if (this.stats.date !== today && this.stats.lastUploadedAt === 0 && this.stats.sessionCount > 0) {
      return buildDailySummary(this.stats)
    }

    return null
  }

  /**
   * Force get the current stats for upload (used at app quit to not lose data).
   */
  getCurrentSummary(): Record<string, string | number> | null {
    if (this.stats.sessionCount === 0) return null
    return buildDailySummary(this.stats)
  }

  /**
   * Mark the current day's data as uploaded and reset for the next period.
   */
  markUploaded(): void {
    this.stats.lastUploadedAt = Date.now()
    this.persist()
    // Reset to a fresh day
    this.stats = createEmptyStats(getTodayDate())
    this.persist()
  }

  /** Get raw stats for local inspection. */
  getStats(): DailyStats {
    return { ...this.stats }
  }

  // --- Persistence ---

  private load(): DailyStats {
    try {
      if (existsSync(this.storagePath)) {
        const raw = readFileSync(this.storagePath, 'utf-8')
        const parsed = JSON.parse(raw) as Partial<DailyStats>
        if (parsed.date && typeof parsed.sessionCount === 'number') {
          // Merge over defaults so counters added by newer app versions
          // load as 0 instead of undefined (NaN after ++).
          return mergeStatsWithDefaults(parsed, getTodayDate())
        }
      }
    } catch {}
    return createEmptyStats(getTodayDate())
  }

  private persist(): void {
    try {
      writeFileSync(this.storagePath, JSON.stringify(this.stats), 'utf-8')
    } catch {}
  }
}

// Singleton
let instance: DailyAggregator | null = null

export function getDailyAggregator(): DailyAggregator {
  if (!instance) {
    instance = new DailyAggregator()
  }
  return instance
}
