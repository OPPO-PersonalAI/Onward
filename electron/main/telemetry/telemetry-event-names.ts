/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Central registry for product-telemetry event names and property
 * allowlists — the telemetry counterpart of `src/utils/perf-trace-names.ts`.
 *
 * Metric-system rules (decision doc:
 * docs/html/telemetry-metrics-system-redesign.html, approved 2026-07-18):
 * - Names follow the existing `<domain>/<object>.<verb>` house style;
 *   legacy names (session/start, prompt/use, ...) stay unchanged so the
 *   historical series remains continuous.
 * - Enum-typed properties are ALLOWLIST-validated (JetBrains FUS
 *   discipline): a value outside the list is replaced with 'invalid',
 *   never dropped silently and never passed through as free text.
 * - Pure module: no Electron imports, unit-testable in plain Node.
 */

/** All product-telemetry event names. Append, never rename. */
export const TELEMETRY_EVENT = {
  // Legacy names (January-era) — kept verbatim for series continuity
  SESSION_START: 'session/start',
  SESSION_END: 'session/end',
  SESSION_HEARTBEAT: 'session/heartbeat',
  PROMPT_USE: 'prompt/use',
  DROPDOWN_WORKSPACE: 'dropdown/workspace',
  DROPDOWN_DEVELOPMENT: 'dropdown/development',
  DROPDOWN_TOOLS: 'dropdown/tools',
  ERROR_RENDERER_CRASH: 'error/rendererCrash',
  ERROR_GPU_PROCESS_CRASH: 'error/gpuProcessCrash',
  UPDATE_CHECK: 'update/check',
  UPDATE_DOWNLOADED: 'update/downloaded',
  UPDATE_INSTALL_START: 'update/installStart',
  UPDATE_INSTALL_COMPLETE: 'update/installComplete',
  UPDATE_ERROR: 'update/error',
  DAILY_SUMMARY: 'daily/summary',
  // New in the 2026-07 metric redesign (P1)
  FEATURE_FIRST_USE: 'feature/first-use',
  ERROR_RECOVERED: 'error/recovered',
  // 2026-07-23 GPU-crash observability: outcome of every crash-recovery pass
  // (renderer-emitted; never for simulated autotest crashes). 'sticky-fallback'
  // = the N=2 session fuse blew and terminals stick to the DOM renderer.
  ERROR_GPU_CRASH_RECOVERY: 'error/gpuCrashRecovery',
  // 2026-07-25 session-ledger: the previous instance ended WITHOUT a
  // clean-shutdown mark — the death class that leaves no crash report
  // (SIGKILL, power loss, freeze force-quit). 'corrupt' = ledger unreadable
  // (torn write mid-death).
  ERROR_ABNORMAL_EXIT: 'error/abnormalExit',
  CONSENT_GRANTED: 'consent/granted',
  CONSENT_REVOKED: 'consent/revoked',
  // New in P2: the generic per-feature usage counter event. Tier-1
  // aggregate-only — each occurrence increments one keyed counter in the
  // daily stats; the raw lines never upload individually.
  FEATURE_USE: 'feature/use'
} as const

export type TelemetryEventName = (typeof TELEMETRY_EVENT)[keyof typeof TELEMETRY_EVENT]

/**
 * Feature IDs for `feature/first-use` (adoption + activation funnel).
 * Fired at most once per feature per install. P1 wires the funnel-critical
 * subset (derived from existing track calls, see deriveFirstUseFeature);
 * P2 instruments the rest directly at their UI call sites.
 */
export const TELEMETRY_FEATURE_IDS = [
  // P1 — derivable from existing events
  'prompt-send',
  'code-agent',
  'browser',
  'git-diff',
  'git-history',
  'project-editor',
  // P2 — direct instrumentation pending
  'tab-create',
  'layout-preset',
  'custom-layout',
  'schedule',
  'prompt-pin',
  'prompt-search',
  'git-diff-stage',
  'image-diff',
  'pdf-diff',
  'epub-diff',
  'outline',
  'global-search',
  'quick-open',
  'reader-mode',
  'markdown-preview',
  'pdf-reader',
  'epub-reader',
  'html-preview',
  'sqlite-viewer',
  'mermaid',
  'feedback',
  'diagnostic-bundle',
  'changelog',
  'shortcut-edit',
  'theme-custom'
] as const

export type TelemetryFeatureId = (typeof TELEMETRY_FEATURE_IDS)[number]

/**
 * Feature-usage IDs for `feature/use` (P2, Tier-1 daily counters). One ID
 * per user-meaningful action; finer-grained than the first-use set. Adding
 * a feature = append the ID here + one track call at the UI action site —
 * the aggregator map, summary flattening (`fu_` prefix), and report model
 * pick it up automatically.
 */
export const TELEMETRY_FEATURE_USE_IDS = [
  // workspace
  'tab-create',
  'tab-close',
  'layout-preset',
  'custom-layout',
  'downsize-confirm',
  // prompt workflow
  'prompt-pin',
  'prompt-color',
  'prompt-search',
  'prompt-history-reuse',
  'prompt-editor-menu',
  'schedule-create',
  'schedule-run',
  // git diff subpage
  'git-diff-stage',
  'git-diff-discard',
  'git-diff-partial-stage',
  'git-diff-hunk',
  'git-diff-mode-toggle',
  'image-diff',
  'pdf-diff',
  'epub-diff',
  // git history subpage
  'git-history-range',
  'git-history-file-diff',
  // project editor + readers
  'editor-file-open',
  'outline',
  'global-search',
  'quick-open',
  'reader-mode',
  'markdown-preview',
  'pdf-reader',
  'epub-reader',
  'html-preview',
  'sqlite-viewer',
  'mermaid',
  // tools
  'agent-config-save',
  'browser-auto-refresh',
  // terminal shell surround
  'terminal-rename',
  'auto-follow',
  'title-from-branch',
  'send-pinned-prompt',
  'shortcut-fired',
  // meta surfaces
  'settings-open',
  'setting-change',
  'feedback',
  'diagnostic-bundle',
  'changelog',
  'shortcut-edit',
  'theme-custom'
] as const

export type TelemetryFeatureUseId = (typeof TELEMETRY_FEATURE_USE_IDS)[number]

/**
 * Map a feature-use ID to its adoption (first-use) feature ID. Identity
 * where the two sets share an ID; explicit entries where the use ID is
 * finer-grained; null result = the action carries no adoption signal.
 */
const FEATURE_USE_TO_FIRST_USE: Partial<Record<TelemetryFeatureUseId, TelemetryFeatureId>> = {
  'tab-create': 'tab-create',
  'layout-preset': 'layout-preset',
  'custom-layout': 'custom-layout',
  'schedule-create': 'schedule',
  'prompt-pin': 'prompt-pin',
  'prompt-search': 'prompt-search',
  'git-diff-stage': 'git-diff-stage',
  'image-diff': 'image-diff',
  'pdf-diff': 'pdf-diff',
  'epub-diff': 'epub-diff',
  outline: 'outline',
  'global-search': 'global-search',
  'quick-open': 'quick-open',
  'reader-mode': 'reader-mode',
  'markdown-preview': 'markdown-preview',
  'pdf-reader': 'pdf-reader',
  'epub-reader': 'epub-reader',
  'html-preview': 'html-preview',
  'sqlite-viewer': 'sqlite-viewer',
  mermaid: 'mermaid',
  feedback: 'feedback',
  'diagnostic-bundle': 'diagnostic-bundle',
  changelog: 'changelog',
  'shortcut-edit': 'shortcut-edit',
  'theme-custom': 'theme-custom'
}

/** Replacement value for enum properties that fail allowlist validation. */
export const TELEMETRY_INVALID_ENUM_VALUE = 'invalid'

/**
 * Enum-typed property allowlists, keyed by event name → property name.
 * Properties not listed here are left to the generic sanitizer
 * (string-truncation only); listed ones are clamped to the allowed set.
 */
export const TELEMETRY_ENUM_ALLOWLIST: Record<string, Record<string, readonly string[]>> = {
  [TELEMETRY_EVENT.PROMPT_USE]: { action: ['send', 'execute', 'sendAndExecute'] },
  [TELEMETRY_EVENT.DROPDOWN_WORKSPACE]: { action: ['openDir', 'changeDir'] },
  [TELEMETRY_EVENT.DROPDOWN_DEVELOPMENT]: { action: ['editor', 'gitDiff', 'gitHistory'] },
  [TELEMETRY_EVENT.DROPDOWN_TOOLS]: { action: ['codeAgent', 'browser'] },
  [TELEMETRY_EVENT.FEATURE_FIRST_USE]: { feature: TELEMETRY_FEATURE_IDS },
  [TELEMETRY_EVENT.FEATURE_USE]: { feature: TELEMETRY_FEATURE_USE_IDS },
  [TELEMETRY_EVENT.ERROR_RECOVERED]: {
    kind: ['unresponsive', 'webgl-fallback', 'watcher-degraded']
  },
  [TELEMETRY_EVENT.ERROR_GPU_CRASH_RECOVERY]: {
    outcome: ['recreated', 'partial', 'failed', 'deferred', 'sticky-fallback']
  },
  [TELEMETRY_EVENT.ERROR_ABNORMAL_EXIT]: {
    kind: ['abnormal', 'corrupt']
  }
}

/**
 * Daily-summary property key for one feature-use counter: `fu_` prefix,
 * dashes to underscores (HogQL-friendly flat numeric keys, e.g.
 * `fu_git_diff_stage`). The metrics model extracts every `fu_*` key
 * generically — no parallel ID list exists outside this registry.
 */
export function featureUseSummaryKey(featureUseId: string): string {
  return `fu_${featureUseId.replace(/-/g, '_')}`
}

/**
 * Clamp enum-typed properties to their allowlist. Non-enum properties pass
 * through untouched; enum values outside the list become
 * TELEMETRY_INVALID_ENUM_VALUE so schema drift is visible in the data
 * instead of silently polluting it.
 */
export function clampEnumProperties(
  eventName: string,
  properties: Record<string, string>
): Record<string, string> {
  const allowlist = TELEMETRY_ENUM_ALLOWLIST[eventName]
  if (!allowlist) return properties
  const result: Record<string, string> = { ...properties }
  for (const [prop, allowed] of Object.entries(allowlist)) {
    if (prop in result && !allowed.includes(result[prop])) {
      result[prop] = TELEMETRY_INVALID_ENUM_VALUE
    }
  }
  return result
}

/**
 * Tier-2 "live lane" events: low-frequency, high-signal discrete events
 * that upload raw (batched, acknowledgement-gated) instead of waiting to
 * be represented in the daily aggregate. Everything else in the outbox is
 * Tier-1: covered by daily/summary and cleared by the summary/remediation
 * acknowledgements.
 */
export const TELEMETRY_TIER2_LIVE_EVENTS: ReadonlySet<string> = new Set([
  TELEMETRY_EVENT.SESSION_START,
  TELEMETRY_EVENT.SESSION_END,
  TELEMETRY_EVENT.FEATURE_FIRST_USE,
  TELEMETRY_EVENT.ERROR_RENDERER_CRASH,
  TELEMETRY_EVENT.ERROR_GPU_PROCESS_CRASH,
  TELEMETRY_EVENT.ERROR_GPU_CRASH_RECOVERY,
  TELEMETRY_EVENT.ERROR_ABNORMAL_EXIT,
  TELEMETRY_EVENT.ERROR_RECOVERED,
  TELEMETRY_EVENT.UPDATE_CHECK,
  TELEMETRY_EVENT.UPDATE_DOWNLOADED,
  TELEMETRY_EVENT.UPDATE_INSTALL_START,
  TELEMETRY_EVENT.UPDATE_INSTALL_COMPLETE,
  TELEMETRY_EVENT.UPDATE_ERROR,
  TELEMETRY_EVENT.CONSENT_GRANTED,
  TELEMETRY_EVENT.CONSENT_REVOKED
])

/**
 * Live-lane daily deduplication: for these events only the FIRST
 * occurrence per (property value, UTC day) uploads as a discrete event;
 * later duplicates are covered by the daily aggregate counters. Keys are
 * event names, values are the discriminating property.
 */
export const TELEMETRY_LIVE_DAILY_DEDUP: Record<string, string> = {
  [TELEMETRY_EVENT.ERROR_RECOVERED]: 'kind',
  [TELEMETRY_EVENT.UPDATE_ERROR]: 'phase'
}

/**
 * Derive the adoption feature ID implied by an ordinary tracked event —
 * the P1 mechanism that emits `feature/first-use` without touching any UI
 * call site. Returns null when the event does not imply a P1 feature.
 */
export function deriveFirstUseFeature(
  eventName: string,
  properties?: Record<string, string>
): TelemetryFeatureId | null {
  switch (eventName) {
    case TELEMETRY_EVENT.PROMPT_USE:
      return 'prompt-send'
    case TELEMETRY_EVENT.DROPDOWN_TOOLS:
      if (properties?.action === 'codeAgent') return 'code-agent'
      if (properties?.action === 'browser') return 'browser'
      return null
    case TELEMETRY_EVENT.DROPDOWN_DEVELOPMENT:
      if (properties?.action === 'gitDiff') return 'git-diff'
      if (properties?.action === 'gitHistory') return 'git-history'
      if (properties?.action === 'editor') return 'project-editor'
      return null
    case TELEMETRY_EVENT.FEATURE_USE: {
      const feature = properties?.feature as TelemetryFeatureUseId | undefined
      return feature ? (FEATURE_USE_TO_FIRST_USE[feature] ?? null) : null
    }
    default:
      return null
  }
}

/**
 * Round a duration to 10-second buckets before upload (JetBrains-style
 * de-anonymization guard: coarse values cannot fingerprint an install).
 */
export function roundDurationMs(durationMs: number): number {
  if (!Number.isFinite(durationMs) || durationMs <= 0) return 0
  return Math.round(durationMs / 10_000) * 10_000
}
