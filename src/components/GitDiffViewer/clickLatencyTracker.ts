/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

// Click → render latency tracker.
//
// Goal: when the user (or an autotest harness) clicks a file in the diff
// list, capture the entire chain that follows so we can attribute latency
// to specific phases. The phases mirror the JadeTree diagnosis we sketched
// for the diff viewer:
//
//   click → ipc → state → model bind → editor mount → diff computed
//     → DOM commit → paint → tokenize settle
//
// Each measurement is keyed by the file's stable cache key so concurrent
// clicks (the user impatiently clicks A then B before A completes) are
// resolved by cancelling A's transaction. We do not try to fan-out to
// multiple files in flight — the renderer only renders one selection at a
// time, so a single in-flight measurement is enough.

import type {
  GitDiffContentCacheMissReason,
  GitDiffContentCacheSource
} from '../../types/electron'

export type ClickLatencyPhase =
  | 'clickAt'
  | 'ipcStartAt'
  | 'ipcEndAt'
  | 'stateSetAt'
  | 'modelBoundAt'
  | 'editorReadyAt'
  | 'diffComputedAt'
  | 'domCommittedAt'
  | 'paintReadyAt'
  | 'tokenizeSettleAt'

export type ClickLatencySettleReason =
  | 'tokens-quiet'
  | 'dom-quiet'
  | 'timeout'
  | 'no-editor'
  | 'non-text'
  | 'test'
  // Tracker's own watchdog: ensures stuck measurements (Monaco never fired
  // because new content matched the placeholder, etc.) eventually land in
  // history so the aggregator's hit-rate isn't biased by silent renders.
  // The diagnostics-panel pill no longer waits for this — listeners fire
  // at markIpcEnd so the pill displays instantly.
  | 'start-timeout'
  | 'unknown'

export interface ClickLatencyMeasurement {
  fileKey: string
  filename: string
  cacheState: 'hit' | 'miss'
  cacheSource: GitDiffContentCacheSource | null
  cacheMissReason: GitDiffContentCacheMissReason | null
  /** All phase timestamps in ms, monotonic clock (performance.now). */
  clickAt: number
  ipcStartAt: number | null
  ipcEndAt: number | null
  stateSetAt: number | null
  modelBoundAt: number | null
  editorReadyAt: number | null
  diffComputedAt: number | null
  domCommittedAt: number | null
  paintReadyAt: number | null
  tokenizeSettleAt: number | null
  /** First paint latency in ms. Filled after paintReadyAt. */
  firstPaintMs: number | null
  /** Total click → settled latency in ms. Filled after tokenizeSettleAt. */
  totalMs: number | null
  settleReason: ClickLatencySettleReason | null
  coldMountMs: number | null
  /** Indicates the measurement was cancelled (user clicked another file). */
  cancelled: boolean
}

export interface ClickLatencyCacheInfo {
  source?: GitDiffContentCacheSource | null
  missReason?: GitDiffContentCacheMissReason | null
}

interface ActiveMeasurement extends ClickLatencyMeasurement {
  // Mutable working copy used until the measurement is sealed.
}

const MAX_HISTORY = 100

export class GitDiffClickLatencyTracker {
  private active: ActiveMeasurement | null = null
  private history: ClickLatencyMeasurement[] = []
  private listeners = new Set<(m: ClickLatencyMeasurement) => void>()
  private readonly now: () => number
  /**
   * Watchdog timer: every active measurement gets a hard upper bound. If
   * markTokenizeSettled never fires (Monaco didn't see a model-content
   * change because new and old contents matched — empty untracked file is
   * the canonical trigger), this watchdog seals the measurement so the
   * diagnostics panel still reflects this click.
   *
   * 5s is generous: real clicks settle in ~30-300ms; anything past 5s is
   * a stuck render, not a slow one.
   */
  private startWatchdogTimerId: ReturnType<typeof setTimeout> | null = null
  private static readonly START_WATCHDOG_MS = 5000

  constructor(now?: () => number) {
    this.now = now ?? (() => performance.now())
  }

  private clearStartWatchdog(): void {
    if (this.startWatchdogTimerId !== null) {
      clearTimeout(this.startWatchdogTimerId)
      this.startWatchdogTimerId = null
    }
  }

  private armStartWatchdog(fileKey: string): void {
    this.clearStartWatchdog()
    this.startWatchdogTimerId = setTimeout(() => {
      this.startWatchdogTimerId = null
      // Only fire if THIS measurement is still the active one. If a newer
      // start() already replaced it, we have nothing to do.
      if (!this.active || this.active.fileKey !== fileKey) return
      this.active.cancelled = true
      this.active.settleReason = 'start-timeout'
      // Seal whatever progress was made. cacheState / cacheSource carry the
      // values markIpcEnd recorded (typically valid) so the panel pills
      // still display the actual cache outcome of this click.
      const sealed = { ...this.active }
      this.history.push(sealed)
      this.trim()
      for (const listener of this.listeners) {
        try { listener(sealed) } catch { /* listener failures must not break tracking */ }
      }
      this.active = null
    }, GitDiffClickLatencyTracker.START_WATCHDOG_MS)
  }

  start(fileKey: string, filename: string): void {
    if (this.active && this.active.fileKey !== fileKey) {
      // Cancel the previous in-flight measurement: caller switched files.
      this.active.cancelled = true
      this.history.push(this.active)
      this.trim()
    }
    this.clearStartWatchdog()
    this.active = {
      fileKey,
      filename,
      // Defensive default: assume cold (miss) until markIpcEnd reports back.
      // If the measurement seals before markIpcEnd fires, the worst-case
      // assumption is "we had to fetch", which keeps hit-rate honest.
      cacheState: 'miss',
      cacheSource: null,
      cacheMissReason: null,
      clickAt: this.now(),
      ipcStartAt: null,
      ipcEndAt: null,
      stateSetAt: null,
      modelBoundAt: null,
      editorReadyAt: null,
      diffComputedAt: null,
      domCommittedAt: null,
      paintReadyAt: null,
      tokenizeSettleAt: null,
      firstPaintMs: null,
      totalMs: null,
      settleReason: null,
      coldMountMs: null,
      cancelled: false
    }
    this.armStartWatchdog(fileKey)
  }

  markIpcStart(fileKey: string): void {
    if (this.active && this.active.fileKey === fileKey && this.active.ipcStartAt === null) {
      this.active.ipcStartAt = this.now()
    }
  }

  markIpcEnd(
    fileKey: string,
    cacheState: 'hit' | 'miss' = 'miss',
    cacheInfo: ClickLatencyCacheInfo = {}
  ): void {
    if (this.active && this.active.fileKey === fileKey && this.active.ipcEndAt === null) {
      this.active.ipcEndAt = this.now()
      // Back-fill ipcStartAt when it is still null at end time. Under EDR a
      // re-click of the same fileKey between markIpcStart and markIpcEnd
      // allocates a fresh active with ipcStartAt=null; without this the sealed
      // measurement would carry ipcEndAt but no ipcStartAt and the emitter
      // would drop the IPC span. Collapsing the span to zero width keeps the
      // phase chain complete and is honest (the true start was lost).
      if (this.active.ipcStartAt === null) this.active.ipcStartAt = this.active.ipcEndAt
      this.active.cacheState = cacheState
      this.active.cacheSource = cacheInfo.source ?? null
      this.active.cacheMissReason = cacheInfo.missReason ?? null
      // The diagnostics panel's pill data is fully known at this point —
      // cacheState and cacheSource have been set. Notify listeners so the
      // panel re-renders immediately, rather than waiting for the full
      // tokenize-settle seal (which can be 50-300ms later, or never for
      // silent-Monaco renders). Total time still appears only on seal.
      for (const listener of this.listeners) {
        try { listener({ ...this.active }) } catch { /* listener errors must not break tracking */ }
      }
    }
  }

  markStateSet(fileKey: string): void {
    if (this.active && this.active.fileKey === fileKey && this.active.stateSetAt === null) {
      this.active.stateSetAt = this.now()
    }
  }

  markModelBound(fileKey: string): void {
    if (this.active && this.active.fileKey === fileKey && this.active.modelBoundAt === null) {
      this.active.modelBoundAt = this.now()
    }
  }

  markEditorReady(fileKey: string): void {
    if (this.active && this.active.fileKey === fileKey && this.active.editorReadyAt === null) {
      this.active.editorReadyAt = this.now()
    }
  }

  markColdMount(fileKey: string, durationMs: number): void {
    if (!this.active || this.active.fileKey !== fileKey || this.active.coldMountMs !== null) return
    if (!Number.isFinite(durationMs) || durationMs < 0) return
    this.active.coldMountMs = +durationMs.toFixed(2)
  }

  markDiffComputed(fileKey: string): void {
    if (!this.active || this.active.fileKey !== fileKey) return
    if (this.active.diffComputedAt !== null) return
    this.active.diffComputedAt = this.now()
    // Schedule paint signal on the next frame. requestAnimationFrame fires
    // right before paint, so capturing inside its callback is the closest
    // proxy we have for "the user can now see this content". A setTimeout
    // fallback covers the case where rAF is throttled (background window,
    // autotest harness running with the app off-screen, or a paused
    // compositor). Without the fallback those measurements stall forever
    // and the entire history collects as cancelled entries.
    const target = this.active
    let sealed = false
    const seal = () => {
      if (sealed) return
      sealed = true
      if (this.active === target && target.paintReadyAt === null) {
        target.paintReadyAt = this.now()
        target.firstPaintMs = +(target.paintReadyAt - target.clickAt).toFixed(2)
      }
    }
    requestAnimationFrame(seal)
    setTimeout(seal, 80)
  }

  markDomCommitted(fileKey: string): void {
    if (this.active && this.active.fileKey === fileKey && this.active.domCommittedAt === null) {
      this.active.domCommittedAt = this.now()
    }
  }

  markTokenizeSettled(fileKey: string, reason: ClickLatencySettleReason = 'unknown'): void {
    if (!this.active || this.active.fileKey !== fileKey) return
    if (this.active.tokenizeSettleAt !== null) return
    this.clearStartWatchdog()
    this.active.tokenizeSettleAt = this.now()
    this.active.settleReason = reason
    if (this.active.paintReadyAt === null) {
      this.active.paintReadyAt = this.active.tokenizeSettleAt
      this.active.firstPaintMs = +(this.active.paintReadyAt - this.active.clickAt).toFixed(2)
    }
    this.active.totalMs = +(this.active.tokenizeSettleAt - this.active.clickAt).toFixed(2)
    this.history.push({ ...this.active })
    this.trim()
    for (const listener of this.listeners) {
      try {
        listener({ ...this.active })
      } catch {
        /* listener errors must not break tracking */
      }
    }
    this.active = null
  }

  cancelActive(): void {
    if (!this.active) return
    this.clearStartWatchdog()
    this.active.cancelled = true
    this.history.push(this.active)
    this.trim()
    this.active = null
  }

  getActive(): ClickLatencyMeasurement | null {
    return this.active ? { ...this.active } : null
  }

  getLast(): ClickLatencyMeasurement | null {
    return this.history.length > 0 ? this.history[this.history.length - 1] : null
  }

  getLastForFile(fileKey: string): ClickLatencyMeasurement | null {
    for (let i = this.history.length - 1; i >= 0; i -= 1) {
      const entry = this.history[i]
      if (entry.fileKey === fileKey) return entry
    }
    return null
  }

  getHistory(): ClickLatencyMeasurement[] {
    return this.history.slice()
  }

  addListener(listener: (m: ClickLatencyMeasurement) => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  reset(): void {
    this.active = null
    this.history = []
  }

  private trim(): void {
    if (this.history.length > MAX_HISTORY) {
      this.history.splice(0, this.history.length - MAX_HISTORY)
    }
  }
}
