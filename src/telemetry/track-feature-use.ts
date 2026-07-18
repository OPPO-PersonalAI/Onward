/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * One-line renderer-side helper for the P2 `feature/use` counter event.
 * The feature ID must be registered in
 * `electron/main/telemetry/telemetry-event-names.ts`
 * (TELEMETRY_FEATURE_USE_IDS) — unregistered values are clamped to
 * 'invalid' by the main-process allowlist, surfacing drift in the data.
 *
 * Consent gating, aggregation, and first-use derivation all happen in the
 * main process; call sites never need any conditional logic. Safe in any
 * renderer context (optional chaining + swallow — telemetry must never
 * break a UI path).
 */
export function trackFeatureUse(feature: string): void {
  try {
    window.electronAPI?.telemetry?.track('feature/use', { feature })
  } catch {}
}
