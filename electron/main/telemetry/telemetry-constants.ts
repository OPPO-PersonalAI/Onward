/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * PostHog project API key (write-only ingestion key, `phc_...`).
 * This is NOT a secret — it identifies the ingestion project only.
 * An empty value or the literal string `disabled` keeps the upload client
 * off while the local pipeline (JSONL log + daily aggregator) stays active.
 * Override at runtime via ONWARD_TELEMETRY_POSTHOG_KEY.
 */
export const TELEMETRY_POSTHOG_API_KEY =
  process.env.ONWARD_TELEMETRY_POSTHOG_KEY ||
  'phc_nPQFxSfqQZ2qM9S7jr2CoJjxMn5hm36zybwDYnVvFu9y'

/**
 * PostHog ingestion host. Defaults to PostHog Cloud US.
 * Override via ONWARD_TELEMETRY_POSTHOG_HOST (EU cloud or a self-managed
 * reverse proxy).
 */
export const TELEMETRY_POSTHOG_HOST =
  process.env.ONWARD_TELEMETRY_POSTHOG_HOST || 'https://us.i.posthog.com'

/**
 * True when the PostHog upload client has a usable key. The `disabled`
 * sentinel lets autotests force the not-configured path deterministically
 * even after a real default key ships in this file.
 */
export const TELEMETRY_POSTHOG_CONFIGURED =
  TELEMETRY_POSTHOG_API_KEY !== '' && TELEMETRY_POSTHOG_API_KEY !== 'disabled'

/**
 * Whether telemetry is fully disabled at build time.
 * Set ONWARD_TELEMETRY_DISABLED=1 to completely disable telemetry in a build.
 */
export const TELEMETRY_BUILD_DISABLED = process.env.ONWARD_TELEMETRY_DISABLED === '1'

/**
 * Debug: reset telemetry consent to simulate a first-time install.
 * Set ONWARD_TELEMETRY_RESET_CONSENT=1 to force the consent dialog on next launch.
 */
export const TELEMETRY_RESET_CONSENT = process.env.ONWARD_TELEMETRY_RESET_CONSENT === '1'

/**
 * Autotest: suppress the first-run telemetry consent dialog without writing
 * any persisted state. When in autotest mode (`ONWARD_AUTOTEST=1`) or when
 * `ONWARD_AUTOTEST_SKIP_CONSENT=1` is set explicitly, a stored consent of
 * `null` is reported to the renderer as `false` (declined), so the
 * ConsentDialog never mounts and autotest clicks are not intercepted by a
 * modal overlay on fresh `ONWARD_USER_DATA_DIR` runs. No telemetry data is
 * sent because the effective consent is declined. Explicit stored values
 * (true/false) are always honored as-is.
 *
 * Two env vars feed this flag so the behavior is automatic in the full
 * autotest harness (covers every `test/run-*-autotest.sh`) while still
 * letting manual test drivers opt in without full autotest mode.
 */
export const TELEMETRY_AUTOTEST_SKIP_CONSENT =
  process.env.ONWARD_AUTOTEST_SKIP_CONSENT === '1' ||
  process.env.ONWARD_AUTOTEST === '1'

/**
 * Debug: use a fast heartbeat interval (5 seconds) for telemetry testing.
 * Set ONWARD_TELEMETRY_FAST_HEARTBEAT=1 to accelerate heartbeat for testing.
 */
export const TELEMETRY_FAST_HEARTBEAT = process.env.ONWARD_TELEMETRY_FAST_HEARTBEAT === '1'

/**
 * Debug: force daily upload on the next heartbeat cycle (skip 24h wait).
 * Set ONWARD_TELEMETRY_FORCE_UPLOAD=1 to trigger upload immediately.
 */
export const TELEMETRY_FORCE_UPLOAD = process.env.ONWARD_TELEMETRY_FORCE_UPLOAD === '1'

/**
 * Outbox (`telemetry-events.jsonl`) size cap. Records are only deleted
 * after a confirmed upload, so long offline stretches grow the file;
 * past the cap the OLDEST records are dropped down to the trim target
 * (hysteresis keeps full-file rewrites rare). ~5 MB/month at current
 * event volume, so 20 MB ≈ 4 months of backlog.
 */
export const TELEMETRY_OUTBOX_MAX_BYTES = 20 * 1024 * 1024
export const TELEMETRY_OUTBOX_TRIM_TARGET_BYTES = 16 * 1024 * 1024

/** Session heartbeat interval (ms) */
export const TELEMETRY_HEARTBEAT_INTERVAL_MS = 5 * 60 * 1000 // 5 minutes

/** Maximum characters for string property values */
export const TELEMETRY_MAX_PROPERTY_LENGTH = 1024

/** Maximum characters for stack traces */
export const TELEMETRY_MAX_STACK_LENGTH = 4096
