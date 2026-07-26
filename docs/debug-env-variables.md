<!-- SPDX-FileCopyrightText: 2026 OPPO -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Debug Environment Variables

Onward uses `ONWARD_*` environment variables as feature-level debug switches. Each variable controls a single, isolated behavior — enabling verbose logging, simulating a specific state, or disabling a subsystem. This design keeps debug logic out of UI menus and build flags, and makes it trivially reproducible across machines.

## Design Principles

1. **One variable, one concern.** Each env var toggles exactly one debug behavior. Never overload a single variable to control multiple unrelated features.
2. **Prefix `ONWARD_`.** All debug variables share the `ONWARD_` namespace so they are easy to discover and unlikely to collide with system env vars.
3. **Value convention.** Use `1` to enable, absence or any other value to disable. Example: `ONWARD_DEBUG=1`. A small number of legacy variables deviate from this — `ONWARD_GIT_POLLING` uses `0` to disable (default enabled), and `ONWARD_GIT_MAX_*` are numeric tunables rather than `0`/`1` toggles. Each deviation is called out per row in the reference table below.
4. **Read at startup.** Variables are read once from `process.env` during main-process initialization. They are not watched for changes at runtime.
5. **No side effects when absent.** The application must behave identically to a normal build when no debug variables are set.
6. **Log when active.** When a debug variable takes effect, log a message to the console so the developer knows it is active. Example: `[Telemetry] Consent reset for debugging (ONWARD_TELEMETRY_RESET_CONSENT=1)`.

## How to Launch with Environment Variables

### macOS / Linux

Set the variable before the `open` command (packaged build):

```bash
ONWARD_TELEMETRY_RESET_CONSENT=1 open "release/mac-arm64/Under Development <version>-<branch>.app"
```

Multiple variables:

```bash
ONWARD_DEBUG=1 ONWARD_TELEMETRY_RESET_CONSENT=1 open "release/mac-arm64/Under Development <version>-<branch>.app"
```

Development mode (electron-vite):

```bash
ONWARD_DEBUG=1 pnpm dev
```

### Windows (PowerShell)

```powershell
$env:ONWARD_TELEMETRY_RESET_CONSENT = "1"
& "release\win-unpacked\Onward 2.exe"
```

### Windows (cmd)

```cmd
set ONWARD_TELEMETRY_RESET_CONSENT=1
"release\win-unpacked\Onward 2.exe"
```

## Variable Reference

| Variable | Value | Effect |
|----------|-------|--------|
| `ONWARD_DEBUG` | `1` | Enable verbose console logging in main process, IPC, and git-watch |
| `ONWARD_PERF_TRACE` | `0` to disable (default: enabled) | Write append-only **NDJSON** chunks (Chrome Trace Event Format, one event per line) to `<repoRoot>/traces/perf/` (dev) or `userData/traces/` (prod). Chunks rotate at 8 MB; total folder cap 64 MB with oldest-first eviction; survives SIGKILL with at most one tail-partial line per chunk. Captures main/renderer event-loop stalls, Prompt input paint latency, terminal IPC summaries, GitWatch/Git runtime summaries, longtask / frame stalls. Event names are defined in `src/utils/perf-trace-names.ts` and indexed in `infra/trace.md` § 2. Open via `bash infra/scripts/open_trace.sh` (auto-detects single chunk, full chunk dir, or legacy `.json`). Note: inverted convention — `0` disables, anything else (including unset) enables. |
| `ONWARD_REPO_ROOT` | path | Repo-root override used by `perf-trace-logger` and autotest runners to resolve where `traces/` lives. Set automatically by the regression harness; only needed manually when launching a packaged build outside the checkout. |
| `ONWARD_DEBUG_CAPTURE` | `1` | Auto-capture renderer screenshots to temp dir after load |
| `ONWARD_DISABLE_GPU` | `1` | Disable hardware acceleration and GPU compositing |
| `ONWARD_USER_DATA_DIR` | path | Override the userData directory (settings, state, telemetry) |
| `ONWARD_BUILD` | `dev` / `prod` | Override build channel detection |
| `ONWARD_BRANCH` | string | Override branch name in app identity |
| `ONWARD_TAG` | string | Override release tag in app identity |
| `ONWARD_TELEMETRY_POSTHOG_KEY` | `phc_...` / `disabled` | Override the PostHog project API key (write-only ingestion key). Empty or the literal `disabled` keeps the upload client off while the local telemetry pipeline (JSONL log + daily aggregator) stays active. Autotests use `disabled` to force the not-configured path deterministically. |
| `ONWARD_TELEMETRY_POSTHOG_HOST` | URL (default: `https://us.i.posthog.com`) | Override the PostHog ingestion host (EU cloud or a self-managed reverse proxy) |
| `ONWARD_TELEMETRY_DISABLED` | `1` | Completely disable telemetry at build level (SDK never loaded) |
| `ONWARD_TELEMETRY_RESET_CONSENT` | `1` | Reset telemetry consent on launch (autotest: set to true; manual: set to null for consent dialog) |
| `ONWARD_AUTOTEST_SKIP_CONSENT` | `1` | Suppress the first-run telemetry consent dialog. When set and no consent has been recorded yet, `getConsent()` reports `false` (declined) to the renderer so the modal never mounts and blocks test clicks. No persisted state is touched — explicit user-stored values (true/false) are still honored. `ONWARD_AUTOTEST=1` implicitly enables the same behavior, so the dialog is suppressed automatically in every autotest harness; set this flag explicitly only when you want the skip without full autotest mode. Override with `ONWARD_TELEMETRY_RESET_CONSENT=1` to force consent = true instead of declined. |
| `ONWARD_TELEMETRY_FAST_HEARTBEAT` | `1` | Reduce heartbeat interval from 5 minutes to 5 seconds for telemetry testing |
| `ONWARD_TELEMETRY_FORCE_UPLOAD` | `1` | Force daily summary upload on the next heartbeat cycle (skip 24h wait) |
| `ONWARD_PERF_TRACE_CAPTURE_CONTENT` | `1` | Include bounded raw Prompt / terminal / render content previews in trace events. Sensitive content is omitted by default; opt-in only. Inactive when `ONWARD_PERF_TRACE=0` (the trace store itself is off). |
| `ONWARD_PERF_TRACE_FLUSH_SEC` | (deprecated, no-op) | Retained for compatibility — the chunked store writes synchronously, no periodic flush is needed. The variable is ignored. |
| `ONWARD_PERF_TRACE_MAX_MB` | (deprecated, no-op) | Retained for compatibility — superseded by the per-chunk 8 MB / total 64 MB caps in `electron/main/trace-store.ts`. The variable is ignored. |
| `ONWARD_TRACE_ROTATION_STRESS_MB` | positive integer | Autotest-only: when set, the main process writes that many MB of synthetic events through the trace store on app-ready and quits. Used by `run-perf-trace-rotation-autotest.sh` to exercise chunk rotation, budget eviction, and SIGKILL resilience. Has no production code path. |
| `ONWARD_LIVENESS_WINDOW_MS` | `250`–`600000` (default: `15000`) | Override the shell-integration liveness window (the delay before a default-shell terminal with no shell-derived cwd OSC is declared "integration silent" and shows the recovery hint). Read once at startup in `electron/main/ipc-handlers.ts`; out-of-range values are ignored. Primarily lets autotests exercise the silent → hint → recovered chain deterministically without a 15 s wall-clock wait. |
| `ONWARD_DIST_DEV_OPEN` | `0` / `1` / unset | Controls whether `pnpm dist:dev` opens the packaged app after a successful build: **unset** = open on local machines (skipped when `CI` is truthy); **`1`** = always open (including in CI); **`0`** = never open. |
| `ONWARD_SMOKE_LAUNCH` | `1` | Smoke-launch mode: once the main window's renderer finishes loading, write the ready marker (see `ONWARD_SMOKE_READY_FILE`) and self-quit with exit code 0. CI uses this to assert the packaged app starts cleanly. |
| `ONWARD_SMOKE_READY_FILE` | path | Absolute path where the smoke-launch ready marker JSON should be written. Only honored when `ONWARD_SMOKE_LAUNCH=1`. |
| `ONWARD_GIT_POLLING` | `0` to disable (default: enabled) | Disables adaptive Git polling (`400` / `1200` / `3000` ms tiers in `git-watch-manager.ts`) and falls back to fixed-interval polling. Note: inverted convention — `0` disables, anything else (including unset) enables. |
| `ONWARD_GIT_MAX_CONCURRENCY` | integer (default: `6`) | Global cap on the number of concurrent in-flight Git operations across all repositories. Read in `git-runtime-manager.ts`. Numeric tunable, not a `0`/`1` toggle. |
| `ONWARD_GIT_MAX_PER_REPO` | integer (default: `3`) | Per-repository cap on concurrent in-flight Git operations. Read in `git-runtime-manager.ts`. Numeric tunable, not a `0`/`1` toggle. |
| `ONWARD_DIFF_CACHE_MAX_PROJECTS` | integer 1–256 (default: `24`) | Per-process ceiling on how many project buckets the Git Diff content cache keeps resident before evicting the least-recently-used. 24 is sized above a nested-submodule superproject's per-repoRoot bucket count (kar-qemu ≈ 20 submodules + superproject) so one Diff open does not thrash its own buckets. Read once at module load in `git-diff-content-cache-wiring.ts`; logs `ONWARD_DIFF_CACHE_MAX_PROJECTS active: maxProjects=N` when a valid override is present (invalid values are warned and ignored). Numeric tunable, not a `0`/`1` toggle. |
| `ONWARD_DISABLE_REPO_PREWARM` | `1` | Turn off the prewarm-on-cwd-switch coordinator (`git-repo-prewarm.ts`): the TerminalGitInfoBridge gets no prewarm hooks, so Git Diff / History are warmed lazily on open + via the renderer-fallback warm only (the pre-prewarm behaviour). Read once at handler setup in `ipc-handlers.ts`; logs `[git-repo-prewarm] disabled (...)` when active. For A/B isolation when diagnosing whether the background prewarm competes with a foreground open on EDR-throttled hosts. |
| `ONWARD_DISABLE_RECONCILE_HEARTBEAT` | `1` | Turn off the GitStateMirror always-on reconcile heartbeat (the parallel safety net that polls focused repos every 1 s and visible repos every 3 s so the Task git badge self-corrects even when `@parcel/watcher` fails silently). Read once at worker start in `git-state-mirror-worker-entry.ts`; logs `reconcile heartbeat disabled (...)` when active. The watcher fast path is unaffected. For A/B isolation / debugging only — leaving it set lets a silent watcher leave the badge stale. See `docs/git-status-reconcile-design.md`. |
| `ONWARD_GSM_MAX_CONCURRENT_RECOMPUTES` | integer (default: `2`) | Cross-repo cap on concurrently-running GitStateMirror status recomputes (the G3 governor in `git-state-mirror-recompute-governor.ts`, read once at worker start in `git-state-mirror-worker-entry.ts`). On EDR-taxed Windows hosts, 5 repos recomputing in parallel stacked ~10 concurrent `git.exe` against the same minifilter; the budget bounds that fan-out. User-driven recomputes (attach / Refresh Changes) bypass the governor. Numeric tunable, not a `0`/`1` toggle. |
| `ONWARD_DISABLE_GIT_AUTOFETCH` | `1` | Kill switch for the background git auto-fetch that keeps the Task badge's `↓behind` count fresh. When set, `git-autofetch-manager.ts` starts disabled (no timer, no `git fetch`) and logs `disabled via ONWARD_DISABLE_GIT_AUTOFETCH=1`. Ahead (`↑`) is unaffected — it is always local-accurate and needs no fetch. Read once at startup. The auto-fetch is hardened to never prompt or hang (`GIT_TERMINAL_PROMPT=0`, SSH `BatchMode`, 20 s timeout), so it is safe to leave on by default; this is for A/B isolation or offline/metered use. |
| `ONWARD_GIT_AUTOFETCH_INTERVAL_MS` | integer ms (default: `600000` = 10 min; floor `60000`) | Override the background auto-fetch period. Values below the 60 s production floor are ignored (clamped to the default) unless `ONWARD_AUTOTEST=1`, where any positive value is honored so a test can drive the loop fast. Read once at startup in `git-autofetch-manager.ts`. Numeric tunable, not a `0`/`1` toggle. See `docs/html/git-ahead-behind-fetch-strategy.html`. |
| `ONWARD_AUTOTEST_KEEP_TMP` | `1` | Preserve a test's scratch directory on exit instead of deleting it, for failure debugging. Honored by the converted runners that build a tmp dir and register cleanup: the 5 `.sh` runners (`run-feedback-autotest.sh`, `run-feedback-persistence-autotest.sh`, `run-pdf-epub-{preview,full,diff}-autotest.sh`), the 2 `.ps1` runners (`run-feedback-autotest.ps1`, `run-feedback-persistence-autotest.ps1`), and the `mkTempDir` helper in `test/unittest/project-tree-watch-manager.test.mts`. Other legacy runners that unconditionally `rm -rf` their tmp roots (for example `test/autotest/run-git-diff-recursive-submodules-autotest.sh`) still ignore the variable. CI must not set this. |
| `ONWARD_AUTOTEST_TELEMETRY_KEEP_OUTBOX` | `1` | Autotest-only and only meaningful with `ONWARD_AUTOTEST=1` + `ONWARD_TELEMETRY_RESET_CONSENT=1`: skip the consent-reset branch's truncation of `telemetry-events.jsonl` so a runner-seeded outbox backlog survives startup. Used by `run-telemetry-autotest.sh` launches B/C (TEL-12/13) to prove the remediation pass uploads the backlog and deletes it only after the flush acknowledgement. Logs `Keeping seeded outbox` when active. |
| `ONWARD_AUTOTEST_GSM_WATCHER_FAIL_SUBSCRIBE_ONCE` | `1` | Autotest-only and only active with `ONWARD_AUTOTEST=1`: inject one GitStateMirror Parcel watcher subscribe failure so `run-git-state-mirror-latency-autotest.sh` can assert watcher recovery, degraded polling, and automatic return to healthy. |
| `ONWARD_AUTOTEST_GSM_WATCHER_FAIL_CALLBACK_ONCE` | `1` | Autotest-only and only active with `ONWARD_AUTOTEST=1`: inject one GitStateMirror Parcel watcher callback failure so `run-git-state-mirror-latency-autotest.sh` can assert callback-fault recovery without emitting the hard stale watcher-error banner. |
| `ONWARD_AUTOTEST_GSM_WATCHER_SILENT` | `1` | Autotest-only and only active with `ONWARD_AUTOTEST=1`: the GitStateMirror Parcel watcher stays subscribed and reports no error but drops every event it would deliver — the production silent-failure mode (parcel-bundler/watcher#187). Used by `run-git-state-mirror-latency-injection-autotest.sh` (GSM-19) to prove the reconcile heartbeat alone still refreshes the badge. |
| `ONWARD_AUTOTEST_GSM_RECONCILE_SILENT` | `1` | Autotest-only and only active with `ONWARD_AUTOTEST=1`: silences the GitStateMirror always-on reconcile heartbeat (scheduler bookkeeping keeps ticking; the per-repo `git status` recompute is skipped). Paired with `ONWARD_AUTOTEST_GSM_WATCHER_SILENT=1` this models "the mirror authority missed the change entirely" — the watcher-missed staleness class from the 2026-07-12 diagnostic bundle — so the git-diff missed-watch reproduction cases assert freshness deterministically instead of racing the 1–3 s heartbeat. Explicit `revalidate` / focus-resync / attach recomputes stay functional. |
| `ONWARD_DISABLE_VIRTUAL_CURSOR` | `1` to disable (default: enabled) | Disables the Prompt textarea's click-anywhere virtual-cursor feature and falls back to the legacy line-by-line input model. Read once at startup by the preload and exposed to the renderer as `window.electronAPI.debug.virtualCursorDisabled`. The mousedown handler in `PromptNotebook.tsx` short-circuits when this is true. Emergency revert switch only — there is no settings-pane toggle. |
| `ONWARD_AUTOTEST` (interaction) | (existing flag) | Autotest-only: when set, the FeedbackModal diagnostic-bundle IPC (`feedback:export-diagnostic-bundle`) honors an optional `forceOutputPath` payload, bypassing the native Save As dialog. Production callers always go through the dialog regardless of this flag. Used by `run-feedback-autotest.sh` (FB-DB-01) to drive the export deterministically. |

## Feature Flags

Feature flags use the `ONWARD_FEATURE_*` namespace. They control product surfaces rather than developer-only diagnostics, and may default to enabled while a feature is being validated before release hardening. They are still read once at startup.

| Variable | Default | Disable value | Effect |
|----------|---------|---------------|--------|
| `ONWARD_FEATURE_GIT_DIFF_PERFORMANCE_DIAGNOSTICS` | enabled | `0` | Hard-gates the Git Diff Performance Diagnostics surface. The panel is still hidden by default and must be enabled in Settings → Diagnostics → Performance Diagnostics; this flag only removes the feature from the build when set to `0`. |

## Adding a New Debug Variable

When implementing a new debug switch:

1. **Define the constant** in the relevant module file (e.g., `telemetry-constants.ts`, or inline in `index.ts`):
   ```typescript
   export const MY_DEBUG_FLAG = process.env.ONWARD_MY_FEATURE === '1'
   ```
2. **Use it** at the point of effect with a guarded block and a console log:
   ```typescript
   if (MY_DEBUG_FLAG) {
     console.log('[MyFeature] Debug mode active (ONWARD_MY_FEATURE=1)')
     // debug-only logic
   }
   ```
3. **Document it** by adding a row to the table above.
4. **Never ship user-facing behavior** behind a debug variable — these are developer-only switches.

## Trace Event Reference

Structured trace events emitted via `debugLog(...)` from the renderer when `ONWARD_DEBUG=1` is set. They land in both the browser console (prefixed `[TerminalGrid]`) and the main-process log via the `debug:log` IPC channel. Event names are append-only — never rename existing keys, only add new ones.

### Title menu events

Emitted from `src/components/TerminalGrid/TerminalGrid.tsx` for the Task Terminal title interaction (single-click dropdown + double-click rename + branch/folder snapshots).

| Event | When | Payload |
|-------|------|---------|
| `titleMenu:open` | Single-click on the title commits to opening the menu (after the 220ms double-click guard) | `{ terminalId, source: 'click', branch, repoName, canUseBranch, canUseRepo }` |
| `titleMenu:snapshot` | A quick-name menu item is chosen and the snapshot is written to `customName` | `{ terminalId, source: 'branch' \| 'repo', value, previousCustomName }` |
| `titleMenu:rename` | Inline rename lifecycle | `{ stage: 'start', terminalId, source: 'menu' \| 'doubleClick', currentCustomName }` <br> `{ stage: 'commit', terminalId, newValue, previousCustomName }` <br> `{ stage: 'cancel', terminalId }` |

Quick filter:

```bash
ONWARD_DEBUG=1 open "release/mac/Under Development <version>-<branch>.app" 2>&1 | grep "titleMenu:"
```
