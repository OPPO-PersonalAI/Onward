/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Pure memory-pressure decision logic for the MemoryWatcher (Tier 2 of the
 * memory diagnostics closed loop — docs/html/memory-diagnostics-closed-loop-design.html).
 *
 * This module MUST stay free of `electron` / side-effectful imports so the
 * unit suite (test/unittest/memory-pressure-detector.test.mts) can exercise
 * the full decision table in plain Node. Follows the
 * gpu-process-metrics.ts ↔ gpu-process-kill-target.test.mts precedent.
 *
 * Unit discipline: every field name carries its unit (Kb / Ms / Ratio).
 * Electron reports KB for process metrics while Node's v8/process APIs
 * report bytes — the VS Code `code --status` double-conversion defect
 * (~2 years of 10-orders-of-magnitude-wrong output) is the cautionary
 * precedent for leaving units implicit.
 */

export type MemoryPressureLevel = 'none' | 'warn' | 'critical'

/** One renderer-focused observation appended by MemoryWatcher per tick. */
export interface RendererMemorySample {
  atMs: number
  /** Renderer process working set (KB) from app.getAppMetrics(); null when the pid was not matched this tick. */
  workingSetKb: number | null
  /** Renderer V8 used heap (KB) from the preload self-report; null when the report is stale or missing. */
  heapUsedKb: number | null
  /** Renderer V8 heap limit (KB) from the preload self-report. */
  heapLimitKb: number | null
}

export interface MemoryPressureConfig {
  /** Sustained renderer working-set threshold (KB). Default 1.5 GB. */
  footprintWarnKb: number
  /** Sustained V8 used/limit ratio threshold (0..1). Default 0.6. */
  heapRatioWarn: number
  /** Escalation multiplier: warn thresholds × this = critical. Default 1.4 (footprint) — ratio escalates at 0.85 absolute. */
  criticalFootprintMultiplier: number
  /** Absolute used/limit ratio that always classifies as critical. Default 0.85. */
  heapRatioCritical: number
  /** Sliding-window length (ms) a condition must hold across. Default 120 000. */
  windowMs: number
  /** Minimum samples inside the window before any verdict != none. Default 3. */
  minSamplesInWindow: number
  /** App uptime (ms) before the user may be prompted. Default 300 000. */
  minUptimeMs: number
  /** Cooldown (ms) between user prompts. Default 1 800 000 (30 min). */
  promptCooldownMs: number
  /** Max user prompts per app session. Default 1. */
  maxPromptsPerSession: number
}

export const DEFAULT_MEMORY_PRESSURE_CONFIG: MemoryPressureConfig = {
  footprintWarnKb: 1536 * 1024,
  heapRatioWarn: 0.6,
  criticalFootprintMultiplier: 1.4,
  heapRatioCritical: 0.85,
  windowMs: 120_000,
  minSamplesInWindow: 3,
  minUptimeMs: 300_000,
  promptCooldownMs: 1_800_000,
  maxPromptsPerSession: 1
}

export type MemoryPressureReason =
  | 'footprint-sustained'
  | 'heap-ratio-sustained'
  | 'below-threshold'
  | 'insufficient-samples'

export interface MemoryPressureVerdict {
  level: MemoryPressureLevel
  reason: MemoryPressureReason
  /** Latest renderer working set (KB) considered, null when unknown. */
  footprintKb: number | null
  /** Latest used/limit ratio considered (0..1), null when unknown. */
  heapRatio: number | null
  /** Number of samples that fell inside the evaluation window. */
  windowSamples: number
}

/** Convert a byte count from Node APIs (process.memoryUsage, v8.getHeapStatistics) to whole KB. */
export function bytesToKb(bytes: number): number {
  if (!Number.isFinite(bytes) || bytes <= 0) return 0
  return Math.round(bytes / 1024)
}

/**
 * Coerce an Electron KB-denominated metric field to a finite non-negative
 * number, else null. Absence (null/undefined/'') maps to null, NOT 0 —
 * `Number(null) === 0` would silently turn "missing" into "zero memory".
 */
export function toFiniteKb(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null
  const n = Number(value)
  if (!Number.isFinite(n) || n < 0) return null
  return Math.round(n)
}

function heapRatioOf(sample: RendererMemorySample): number | null {
  if (sample.heapUsedKb === null || sample.heapLimitKb === null || sample.heapLimitKb <= 0) return null
  return sample.heapUsedKb / sample.heapLimitKb
}

/**
 * Evaluate the sliding window. A condition trips only when EVERY sample in
 * the window that carries the relevant field exceeds the threshold AND at
 * least `minSamplesInWindow` such samples exist — a single GC-timing spike
 * can never fire the loop (repeat-inside-the-test discipline applied to
 * production detection).
 */
export function evaluateMemoryPressure(
  samples: readonly RendererMemorySample[],
  config: MemoryPressureConfig,
  nowMs: number
): MemoryPressureVerdict {
  const windowStart = nowMs - config.windowMs
  const inWindow = samples.filter((s) => s.atMs >= windowStart && s.atMs <= nowMs)
  const latest = inWindow.length > 0 ? inWindow[inWindow.length - 1] : null
  const base: Omit<MemoryPressureVerdict, 'level' | 'reason'> = {
    footprintKb: latest?.workingSetKb ?? null,
    heapRatio: latest ? heapRatioOf(latest) : null,
    windowSamples: inWindow.length
  }

  const footprintSamples = inWindow.filter((s) => s.workingSetKb !== null)
  const ratioSamples = inWindow.filter((s) => heapRatioOf(s) !== null)
  if (footprintSamples.length < config.minSamplesInWindow && ratioSamples.length < config.minSamplesInWindow) {
    return { level: 'none', reason: 'insufficient-samples', ...base }
  }

  const footprintSustained =
    footprintSamples.length >= config.minSamplesInWindow &&
    footprintSamples.every((s) => (s.workingSetKb as number) >= config.footprintWarnKb)
  const ratioSustained =
    ratioSamples.length >= config.minSamplesInWindow &&
    ratioSamples.every((s) => (heapRatioOf(s) as number) >= config.heapRatioWarn)

  if (!footprintSustained && !ratioSustained) {
    return { level: 'none', reason: 'below-threshold', ...base }
  }

  const footprintCritical =
    footprintSustained &&
    footprintSamples.every(
      (s) => (s.workingSetKb as number) >= config.footprintWarnKb * config.criticalFootprintMultiplier
    )
  const ratioCritical =
    ratioSustained && ratioSamples.every((s) => (heapRatioOf(s) as number) >= config.heapRatioCritical)

  return {
    level: footprintCritical || ratioCritical ? 'critical' : 'warn',
    reason: footprintSustained ? 'footprint-sustained' : 'heap-ratio-sustained',
    ...base
  }
}

export interface PromptGuardState {
  appStartedAtMs: number
  promptedCount: number
  lastPromptAtMs: number | null
}

export type PromptSkipReason = 'below-threshold' | 'uptime' | 'session-cap' | 'cooldown'

export interface PromptDecision {
  prompt: boolean
  skipReason?: PromptSkipReason
}

/**
 * Discord-precedent guardrails: a memory number alone never triggers a
 * user-visible action. Uptime floor, per-session cap, and cooldown must all
 * pass before the notification fires.
 */
export function shouldPromptUser(
  verdict: MemoryPressureVerdict,
  state: PromptGuardState,
  config: MemoryPressureConfig,
  nowMs: number
): PromptDecision {
  if (verdict.level === 'none') return { prompt: false, skipReason: 'below-threshold' }
  if (nowMs - state.appStartedAtMs < config.minUptimeMs) return { prompt: false, skipReason: 'uptime' }
  if (state.promptedCount >= config.maxPromptsPerSession) return { prompt: false, skipReason: 'session-cap' }
  if (state.lastPromptAtMs !== null && nowMs - state.lastPromptAtMs < config.promptCooldownMs) {
    return { prompt: false, skipReason: 'cooldown' }
  }
  return { prompt: true }
}

export interface HeadroomInput {
  /** Free physical memory (KB) — Electron process.getSystemMemoryInfo().free. */
  systemFreeKb: number | null
  /** Current JS heap used (KB) of the process about to be snapshotted. */
  targetHeapUsedKb: number | null
}

/**
 * A V8 heap snapshot needs roughly 2× the live heap while being built
 * (Node docs' standing warning; captures near the limit routinely produce
 * 0-byte files). Require free memory ≥ 1.2 × target heap before allowing a
 * capture; unknown numbers fail open ONLY for the heap size (a missing
 * self-report must not permanently disable consent-gated capture) but fail
 * closed for missing system info.
 */
export function hasSnapshotHeadroom(input: HeadroomInput): boolean {
  if (input.systemFreeKb === null) return false
  const targetKb = input.targetHeapUsedKb ?? 0
  return input.systemFreeKb >= targetKb * 1.2
}
