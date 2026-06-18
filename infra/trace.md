<!--
SPDX-FileCopyrightText: 2026 OPPO
SPDX-License-Identifier: Apache-2.0
-->

# Onward Trace System Index

The authoritative index of Onward's performance / behaviour tracing
infrastructure. **Before any performance optimisation or experience
tweak, register an event here, capture a trace, and look at data.**
This is how `CLAUDE.md` Hard rule § 3 ("data-first") is enforced.

**Upstream reference**: https://perfetto.dev/docs/ — Perfetto's
trace_processor, Chrome Trace Event Format spec, SQL table model,
and TrackEvent schema.

Document layout:
1. System architecture
2. Implemented trace events
3. Planned trace events (gaps to fill)
4. On-disk format (Chrome Trace Event Format, JSON subset Onward uses)
5. Toolchain usage
6. Extension rules — how to add an event

---

## 1. System architecture

```
┌────────────── Electron main (pid=1, tid=1) ─────────────────┐
│  electron/main/performance-trace.ts                          │
│    · canonical singleton `performanceTrace`                  │
│    · record(name, data, source?)   — generic emitter         │
│      (resolvePhase auto-routes ph='X' / 'i'; per-Task tid;   │
│       worker→main forwarding via parentPort.postMessage)     │
│    · recordInstant / recordCounter / recordComplete /        │
│      recordFlowStart/Step/End / markTask* / timeAsync /      │
│      summarizeText (PII-redacted lineage)                    │
│    · startEventLoopMonitor()   — 250 ms sample; drift ≥ 100  │
│      ms → main:event-loop-stall                              │
│    · startGitRuntimeMonitor()  — 1 s tick → main:git-runtime-│
│      summary + main:gitwatch-summary                         │
│        ↓                                                     │
│  electron/main/trace-store.ts                                │
│    · append-only NDJSON chunks (one Chrome Trace Event       │
│      object per line)                                        │
│    · 8 MB / chunk → rotate; 64 MB total cap (8 chunks);      │
│      enforceBudget evicts oldest with 8 MB headroom          │
│    · sync writeSync(fd, line) — kernel buffer survives       │
│      SIGKILL; statSync sees real-time chunk size for         │
│      eviction accounting                                     │
│    · per-emitter-name 100 events/sec rate limit; dropped     │
│      summaries flushed every 5 s as                          │
│      `trace-store:dropped-summary`                           │
│        ↓                                                     │
│    <repoRoot>/traces/perf/perf-NNNN-<ISO>-<pid>.jsonl  (dev) │
│    <userData>/traces/perf-NNNN-<ISO>-<pid>.jsonl       (prod)│
│    + latest.txt   (points at the dir containing the chunks)  │
│                                                              │
│  Workers (Node Worker threads):                              │
│    · app-state / git-ipc / git-status / project-fs / sqlite  │
│      / ripgrep                                               │
│    · `performanceTrace.record(...)` inside a worker auto-    │
│      detects `!isMainThread` and forwards a                  │
│      `PerfTraceWorkerEvent` envelope via                     │
│      `parentPort.postMessage(...)`                           │
│    · Each worker-client in electron/main/*-worker-client.ts  │
│      replays the envelope through `replayPerfTraceWorker-    │
│      Event(msg, { tid: WORKER_TID.X, threadName: 'X' })` so  │
│      the worker shows up as its own thread row in Perfetto   │
│                                                              │
┌────────────── Electron renderer (pid=2, tid=<wc.id>) ────────┐
│  src/utils/perf-trace.ts                                     │
│    · perfTrace(name, data) — hot-path, one-shot              │
│    · perfTraceTask(name, data, terminalId) — Task-scoped tid │
│    · installPromptInputTrace() — input → rAF → rAF → paint,  │
│      emits renderer:prompt-input-paint                       │
│    · installRendererStallTrace() — 250 ms + per-frame rAF    │
│    · PerformanceObserver('longtask') → renderer:longtask     │
│  src/utils/performance-trace.ts                              │
│    · richer renderer-side helper for flow correlation        │
│      (recordFlowStart/Step/End, timeAsync, summarizeText —   │
│       PII-safe length / line-count / salted hash)            │
│  src/utils/perf-monitor.ts                                   │
│    · 1 s aggregation → renderer:perf-snapshot                │
│        ↓ IPC DEBUG_PERF_TRACE (sender.id → tid)              │
│    main-side performanceTrace.record(event, data, {          │
│      process: 'renderer', tid })                             │
│                                                              │
└──────────────┬───────────────────────────────────────────────┘
               │
               ▼
┌─ infra/scripts/open_trace.sh ────────────────────────────────┐
│  · Auto-detects input form: chunk dir / single .jsonl /      │
│    legacy .json. NDJSON inputs are wrapped on demand into    │
│    `{"traceEvents":[…]}` so trace_processor_shell loads      │
│    them unchanged.                                           │
│  · Bootstrap + start trace_processor_shell --httpd :9001,    │
│    load newest chunks from traces/perf/                      │
│  · Pin UI URL to tp_shell build:                             │
│    https://ui.perfetto.dev/v<ver>-<sha>/#!/?rpc_port=9001    │
│  · Open browser automatically — trace never leaves localhost │
└──────────────┬───────────────────────────────────────────────┘
               │
               ├─► Perfetto UI (slice / instant / counter tracks)
               └─► SQL queries (Python `perfetto.trace_processor`
                   against the wrapped envelope, no schema diff)
```

Key design decisions:

| Decision | Choice | Rationale |
|---|---|---|
| Wire format (per record) | Chrome Trace Event Format object | Perfetto UI and `trace_processor_shell` consume it natively; zero extra dependency; Node's built-in `JSON.stringify` is enough |
| On-disk format | **NDJSON** (one event per line, no surrounding `{traceEvents:[…]}` array) | A SIGKILL / OOM / power-loss leaves at most ONE half-written tail line; everything before is intact and parseable. The legacy array form lost the entire file when the closing `]}` was never written. NDJSON is also append-friendly across rotations and process restarts. `open_trace.sh` wraps the chunks back into the `{traceEvents:[…]}` envelope on demand for tp_shell. |
| Chunked rotation | 8 MB per chunk (`CHUNK_BYTE_LIMIT`); 64 MB total dir cap (`TOTAL_BYTE_LIMIT`); eviction with 8 MB headroom so closed-bytes ≤ 56 MB and (closed + active) ≤ 64 MB at any moment | Keeps user-reportable diagnostic state bounded (~2-4 hours of typical usage) while preserving append-only semantics. |
| Sync `fs.writeSync(fd, line)` (no Node WriteStream) | Each event hits the kernel buffer immediately | Two reasons: (a) `WriteStream` queues writes inside the process and only drains when the event loop runs — in a tight stress loop the queue grows unbounded and `statSync` returns lagged sizes that defeat eviction accounting; (b) bytes already in the kernel buffer survive process death, so SIGKILL no longer loses recent events. |
| Output path | `<repoRoot>/traces/perf/` (dev + autotest), `<userData>/traces/` (packaged production) | Dev-time chunks are diff-friendly and CI-collectable; end users without a checkout still get local diagnostics under one fixed path that user-reporting tools can ZIP. |
| Default-on capture | Trace store enabled unless `ONWARD_PERF_TRACE=0` | Always-on diagnostic capture. The 64 MB total cap is finite, so an idle store is cheap; the value of having yesterday's trace when a user reports today's bug is high. |
| Single-instance lock | `app.requestSingleInstanceLock()` keys on resolved userData; second-instance event focuses the existing main window | Two Onward processes against the same `<userData>/traces/` would race on chunk rotation seqs and on `latest.txt`. The lock guarantees one writer per userData. Different builds (dev vs autotest vs production) keep their own userData and their own lock — no cross-build contention. |
| Event-name registry | `src/utils/perf-trace-names.ts` single const enum | Perfetto SQL queries key on event names — a centralised registry makes renames visible and prevents drift. |
| Phase mapping | `resolvePhase()` routes by name: stall / longtask / input-paint default to `X` with auto-derived `dur` from `driftMs` / `durationMs` / `eventToPaintMs` / `elapsedMs` / `workerDurationMs` | Callers pass `(name, data)` without worrying about Chrome Trace Event Format phases. |
| Per-name rate limit | 100 events/sec/name; bursts are dropped and summarised every 5 s as `trace-store:dropped-summary` | Protects disk and Perfetto's parser from a runaway emitter. The autotest stress harness can opt-out via `bypassRateLimit: true` to drive 64 MB of synthetic events through one name in seconds. |
| PII redaction | Two lineages — `record()` length-truncates only; `recordRendererEvent / markTask* / recordFlow* / summarizeText` apply a `SENSITIVE_KEY_RE` blacklist + `ALLOWED_STRING_KEYS` allowlist; raw content captured only when `ONWARD_PERF_TRACE_CAPTURE_CONTENT=1` | Perf events keep all metadata; user-content paths default to length / line-count / salted hash, with optional bounded preview. |
| UI build pinning | Grep `tp_shell --version` → `ui.perfetto.dev/v<ver>-<sha>/` path | Avoids the "different build" warning banner that fires when the cloud UI leads or lags tp_shell. |
| Per-Task tid lanes | `assignTaskTid(terminalId, side)` — main tids start at 10000, renderer at 20000; thread_name = `task-<shortId>` (main) / `task-<shortId>-rnd` (renderer); auto-emitted on first event | Lets every hop in the PTY data-flow pipeline (onData → buffer → IPC send → renderer recv → scheduler enqueue → scheduler flush → xterm.write) line up on one Perfetto row per Task, on both processes. Real `tid=1` / `tid=WebContents.id` rows retained unchanged for everything not task-scoped. |

### PTY data flow — end-to-end, per Task row

Every hop below is emitted onto the same `task-<shortId>` tid (renderer
side has `-rnd` suffix; time axis aligned). Reading left-to-right in
Perfetto UI tells the full story: when the PTY fired, when main
flushed IPC, when the renderer received it, when the scheduler got to
it, and when xterm actually wrote. Reverse direction (user input) is
symmetric.

```
Task track (per terminalId)                                         Event name
────────────────────────────────────────────────────────────────    ─────────────────────────────────────
  (output)  ptyProcess.onData                                        — aggregated in main:terminal-data-ipc-summary
      │
      ▼
  ipc-handlers.ts:635  TerminalDataBuffer.push
      │ (buffer:  fast≤128B direct / boost flush / batched 100 ms)
      ▼
  ipc-handlers.ts:600  webContents.send(TERMINAL_DATA)               main:terminal-data.ipc-send  (X, path=fast|boost|batched, bufferAgeMs, bytes)
════════════════════════════════════════════════════════════════════════ IPC boundary
  preload/index.ts:1082   ipcRenderer.on(TERMINAL_DATA)
      │
      ▼
  terminal-session-manager.ts:207  onData listener                   renderer:terminal-data.ipc-recv  (i, bytes)
      │
      ├─ fast path (≤128B / boost active, no pending):              renderer:terminal-data.fast-path  (i, bytes, interactiveBoost)
      │      ─► writeTerminalData                                    renderer:terminal-data.xterm-write (X, bytes, durationMs)
      │
      └─ slow path (bufferred):
             pendingData.push + markDirty                             renderer:terminal-data.scheduler-enqueue  (i, bytes, pendingBytes)
             OutputScheduler.flush (frame-budget loop)                renderer:terminal-data.scheduler-flush  (X, bytes, durationMs)
                 ─► target.writeData → session.terminal.write         renderer:terminal-data.xterm-write  (X, bytes, durationMs)

  (input)   xterm onData → electronAPI.terminal.write                renderer:terminal.send-input  (i, kind, bytes)
      │                                                               renderer:ipc.terminal.write  (X, durationMs)
      ▼
  ipc-handlers.ts  ipcMain.handle(TERMINAL_WRITE)                     main:ipc.terminal.write  (X)
      │
      ▼
  pty-manager.ts  ptyManager.write                                     main:pty.write  (X, path=small|large, bytes, durationMs)
      │
      ▼
  record.pty.write(data)
```

`renderer:terminal-data.scheduler-flush` is **also** emitted on the
default renderer tid (no terminalId) — the scheduler heartbeat carries
`processed` count, `durationMs`, `frameBudgetMs` so its cost is
visible even when no single Task dominates.

---

## 2. Implemented trace events

Registered in `src/utils/perf-trace-names.ts` and emitted by the code
listed under each section. Event names MUST NOT change once in use —
append new names, never rename existing ones.

### 2.1 Main process (pid=1, tid=1)

#### Lifecycle

| Constant | Name | Phase | Emitted at |
|---|---|---|---|
| `MAIN_TRACE_START` | `main:trace-start` | `i` (g) | `performance-trace.ts::initialize()` first call |
| `MAIN_TRACE_STOP` | `main:trace-stop` | `i` (t) | `performance-trace.ts::stop()` |
| `MAIN_APP_BEFORE_QUIT` | `main:app.before-quit` | `i` | `electron/main/index.ts` `app.on('before-quit')` |
| `MAIN_APP_WILL_QUIT` | `main:app.will-quit` | `i` | `electron/main/index.ts` `app.on('will-quit')` |

#### Monitors (1 s tick)

| Constant | Name | Phase | Emitted at |
|---|---|---|---|
| `MAIN_EVENT_LOOP_STALL` | `main:event-loop-stall` | `X` (`dur`=driftMs) | `startEventLoopMonitor()` — 250 ms sample, ≥ 100 ms threshold |
| `MAIN_EVENT_LOOP_METRICS_RESET` | `main:event-loop-metrics-reset` | `i` | `resetEventLoopMetrics()` |
| `MAIN_GIT_RUNTIME_SUMMARY` | `main:git-runtime-summary` | `i` (t) | `startGitRuntimeMonitor()` — 1 s |
| `MAIN_GIT_RUNTIME_SUMMARY_ERROR` | `main:git-runtime-summary-error` | `i` | same, on exception |
| `MAIN_GITWATCH_SUMMARY` | `main:gitwatch-summary` | `i` (t) | `git-watch-manager.ts` 1 s roll-up |
| `MAIN_TERMINAL_DATA_IPC_SUMMARY` | `main:terminal-data-ipc-summary` | `i` (t) | `ipc-handlers.ts` terminal IPC counter sampler |

#### Git Diff cache & freshness (Bug 1 / Bug 2)

| Constant | Name | Phase | Emitted at |
|---|---|---|---|
| `MAIN_GIT_DIFF_CACHE_HIT` | `main:git.diff.cache-hit` | `i` | `electron/main/git-utils.ts::getGitDiff` — request-level cache served without spawning git. Tagged `cwd`, `scope`, `ageMs`. |
| `MAIN_GIT_DIFF_CACHE_INVALIDATE` | `main:git.diff.cache-invalidate` | `i` | Same file — cleared on Mirror delta, watcher-error, force=true entry, manual refresh, or project queue eviction. Tagged `cwd`, `reason: 'watcher-error' \| 'force' \| 'lru' \| 'manual' \| 'mirror'`, `entriesCleared`. |
| `MAIN_GIT_DIFF_FS_WATCH_EVENT` | `main:git.diff.fs-watch-event` | `i` | Retired historical event. The main-process diff invalidator no longer owns a Parcel watcher; use `worker:git-state-mirror.watcher-fire` plus `main:git-state-mirror.fanout` for the Authority path. |
| `MAIN_GIT_DIFF_SUBMODULE_FILTER` | `main:git.diff.submodule-filter` | `i` | `electron/main/git-utils.ts::filterMeaninglessSubmoduleEntries` — one event per submodule entry decision (kept iff `<c>=C` OR `changeType==='staged'`). Tagged `repoRoot`, `repoLabel`, `path`, `flags`, `changeType`, `kept`. |
| `MAIN_IPC_GIT_GET_FILE_CONTENT` | `main:ipc.git.get-file-content` | `X` (duration) | `electron/main/ipc-handlers.ts` — wraps the Git Diff per-file body IPC request, including worker queue + Git read time. Tagged `cwd`, `repoRoot`, `filename`, `status`, `changeType`, `cacheState`, `cacheSource`, `cacheMissReason`, `result`, `durationMs`. |

#### Git Repository Snapshot Service (lesson #13 phase 1)

The snapshot service is the canonical answer to "what are the parent +
submodule structural facts for this cwd?" Phase 1 migrates `loadGitDiff`
through it; History / Editor scope / Quick Open continue to call
`detectSubmodulesRecursive`, which is now a thin compatibility wrapper
that derives the legacy `GitSubmoduleInfo[]` shape from the snapshot.

| Constant | Name | Phase | Emitted at |
|---|---|---|---|
| `MAIN_GIT_SNAPSHOT_CAPTURE` | `main:git.snapshot.capture` | `i` | `electron/main/git-repository-snapshot-service.ts` — recompute (no cached entry, `.gitmodules` token changed, or `force: true`). Submodule discovery is now pure filesystem (`git-submodule-disk-discovery.ts`), so this spawns NO `git submodule status`. Tagged `cwd`, `isRepo`, `submoduleCount`, `validSubmoduleCount`, `fingerprint`. |
| `MAIN_GIT_SNAPSHOT_CACHE_HIT` | `main:git.snapshot.cache-hit` | `i` | Same file — cached snapshot returned without re-discovering. Validity is the repo's `.gitmodules` `mtimeMs:size` token (one `fs.stat`), NOT a TTL. Tagged `cwd`, `fingerprint`, `ageMs`, `submoduleCount`, `validity: 'gitmodules-token'`. |
| `MAIN_GIT_SNAPSHOT_INVALIDATE` | `main:git.snapshot.invalidate` | `i` | Same file — entry dropped because `invalidateGitDiffCache(cwd)` was called (Mirror fanout, force, manual). Tagged `cwd`. |
| `MAIN_GIT_SNAPSHOT_GITLINK_DISCOVERED` | `main:git.snapshot.gitlink-discovered` | `i` | Same file (`captureGitRepositorySnapshot`) — the index's gitlink set (one `git ls-files -s`, mode 160000) surfaced nested repos the parent tracks but never declared in `.gitmodules` (the no-`.gitmodules` gitlink class Diff/History previously could not see; winWatchRTOS-Build symptom). Only fires when count > 0, so it is silent + zero-cost for the common no-gitlink repo. Tagged `cwd`, `repoRoot`, `undeclaredGitlinkCount`, `gitlinkCandidateCount`, `submoduleCount`. |

The snapshot service emits these events from BOTH main and the
git-ipc-worker — the worker's events forward through the existing
`PerfTraceWorkerEvent` envelope and land in the main trace on the
`git-ipc-worker` tid lane (per lesson #10).

#### GitStateMirror (single-source-of-truth refactor)

The mirror replaces the legacy 5-watcher / 11-cache layout with one Worker
Thread that owns branch / status / file list / per-file diff body for every
active cwd. The events below bracket the two latency-critical paths the
GSM autotest suite (`run-git-state-mirror-latency-autotest.sh`) and the
extended GDS suite assert on.

**Path A — cwd switch** (functional gate + timing trend):
`renderer:terminal.osc-cwd-detected` → `main:git-state-mirror.cwd-switched` →
`worker:git-state-mirror.recompute-status-done` →
`main:git-state-mirror.fanout` → `renderer:terminal-title.{branch,color}-rendered`.

**Path B — fs mutation** (functional gate + timing trend):
`worker:git-state-mirror.watcher-fire` (or `.watcher-filtered` when the .git
whitelist drops it) → `recompute-status-done` → `fanout` →
`renderer:git-diff.body-rendered` and/or the terminal-title render markers.

| Constant | Name | Phase | Emitted at |
|---|---|---|---|
| `RENDERER_TERMINAL_OSC_CWD_DETECTED` | `renderer:terminal.osc-cwd-detected` | `i` | `src/components/Terminal/oscCwdAddon.ts` — xterm.js `parser.registerOscHandler(7\|633\|1337\|9, ...)` callback fires after parsing a cwd-bearing OSC. Tagged `terminalId`, `cwd`, `dialect` (`osc7` / `osc633` / `osc1337` / `osc9`). |
| `MAIN_GIT_STATE_MIRROR_CWD_SWITCHED` | `main:git-state-mirror.cwd-switched` | `i` | `electron/main/git-state-mirror-router.ts` — main forwards the cwd push from renderer to the worker. Tagged `terminalId`, `prevCwd`, `nextCwd`. |
| `MAIN_GIT_STATE_MIRROR_CWD_IGNORED` | `main:git-state-mirror.cwd-ignored` | `i` | `electron/main/git-state-mirror-router.ts` / `electron/main/pty-manager.ts` — rejected a malformed or non-directory terminal cwd before it could update GitStateMirror or persisted terminal state. Tagged `terminalId`, `reason`, `rawCwd`. |
| `MAIN_GIT_STATE_MIRROR_CWD_REJECTED_BROADCAST` | `main:git-state-mirror.cwd-rejected-broadcast` | `i` | `electron/main/git-state-mirror-router.ts` — diagnostic breadcrumb for the Bug A reject channel. Fires inside `broadcastCwdRejected` AFTER `cwd-ignored`, recording how many live renderers received the reject IPC. Pair with `renderer:terminal.osc-cwd-rolled-back` to verify the full main-reject → renderer-rollback round-trip. Tagged `terminalId`, `rawCwd`, `recipientCount`, `sendFailures`. |
| `RENDERER_TERMINAL_OSC_CWD_ROLLED_BACK` | `renderer:terminal.osc-cwd-rolled-back` | `i` | `src/components/TerminalGrid/TerminalGrid.tsx` — renderer-side counterpart of the reject broadcast. `action` distinguishes the three outcomes: `'rolled-back'` (speculative cleared + persisted cwd cleared), `'skipped-no-speculative'` (renderer never held this id), `'skipped-value-mismatch'` (a newer valid OSC push already replaced the phantom). Tagged `terminalId`, `rawCwd`, `action`; `'rolled-back'` adds `persisted`, `'skipped-value-mismatch'` adds `speculative`. |
| `WORKER_GIT_STATE_MIRROR_WATCHER_FIRE` | `worker:git-state-mirror.watcher-fire` | `i` | `electron/main/git-state-mirror-worker-entry.ts` — `@parcel/watcher` event passed the .git whitelist filter. Tagged `cwd`, `path`, `kind` (`update` / `create` / `delete`). |
| `WORKER_GIT_STATE_MIRROR_WATCHER_FILTERED` | `worker:git-state-mirror.watcher-filtered` | `i` | Same file — event dropped by the .git whitelist. Tagged `cwd`, `path`, `reason` (`gitObjects` / `lockfile` / `tmpfile`). Used by GDS-39 to assert the feedback-loop guard. |
| `WORKER_GIT_STATE_MIRROR_WATCHER_SKIPPED` | `worker:git-state-mirror.watcher-skipped` | `i` | Same file — non-Git cwd produced a snapshot but deliberately did not arm `@parcel/watcher`. Tagged `cwd`, `reason: 'non-git-cwd'`. |
| `WORKER_GIT_STATE_MIRROR_WATCHER_STATUS_CHANGED` | `worker:git-state-mirror.watcher-status-changed` | `i` | Same file — watcher supervisor health transition. Tagged `repoRoot`, `health` (`attaching` / `healthy` / `recovering` / `degraded-polling` / `suspended` / `failed`), `failureKind`, `failureCount`, `polling`. |
| `WORKER_GIT_STATE_MIRROR_WATCHER_RESTART_SCHEDULED` | `worker:git-state-mirror.watcher-restart-scheduled` | `i` | Same file — a Parcel watcher restart was scheduled with exponential backoff. Tagged `repoRoot`, `health`, `failureKind`, `failureCount`, `delayMs`, `polling`. |
| `WORKER_GIT_STATE_MIRROR_WATCHER_RESTART_RESULT` | `worker:git-state-mirror.watcher-restart-result` | `X` (duration) | Same file — watcher restart attach attempt completed. Tagged `repoRoot`, `reason` (`initial` / `restart` / `suspended-probe`), `result`, `durationMs`, and `error` on failure. |
| `WORKER_GIT_STATE_MIRROR_WATCHER_POLL` | `worker:git-state-mirror.watcher-poll` | `X` or `i` | Same file — degraded-mode fallback Git-status polling. Tagged `repoRoot`, `result` (`success` / `error` / `skip-in-flight`), `entryCount`, `failureCount`, `durationMs`. |
| `WORKER_GIT_STATE_MIRROR_WATCHER_SUSPENDED_PROBE` | `worker:git-state-mirror.watcher-suspended-probe` | `X` (duration) | Same file — 5s path probe while a watched repo root is missing. Tagged `repoRoot`, `result` (`missing` / `found`), `durationMs`, and `error` when missing. |
| `WORKER_GIT_STATE_MIRROR_CHANGE_FINGERPRINT` | `worker:git-state-mirror.change-fingerprint` | `X` (duration) | Same file — hashes porcelain-v2 status plus working-tree file stats for changed resources so repeated edits to an already-modified file still produce a mirror delta without depending on `.git/index` stat churn. Tagged `repoRoot`, `fileCount`, `statCount`, `missingCount`, `durationMs`. |
| `WORKER_GIT_STATE_MIRROR_RECOMPUTE_DONE` | `worker:git-state-mirror.recompute-status-done` | `X` (duration) | `git-state-mirror-worker-entry.ts` — wraps a single `git status --porcelain=v2 -z` run plus delta computation. Payload: `cwd`, `repoRoot`, `reason` (`attach` / `watcher` / `polling` / `osc-switch` / `focus-resync` / `reconcile`), `fileCount`, `branch`, `status`, `durationMs`. |
| `WORKER_GIT_STATE_MIRROR_RECONCILE_TICK` | `worker:git-state-mirror.reconcile-tick` | `i` | Same file — one always-on reconcile heartbeat tick that had ≥1 due repo (parallel safety net to the watcher; see `docs/git-status-reconcile-design.md`). Tagged `dueCount`, `focused`, `reasons`. |
| `WORKER_GIT_STATE_MIRROR_RECONCILE_FOUND_DRIFT` | `worker:git-state-mirror.reconcile-found-drift` | `i` | Same file — a heartbeat reconcile produced a real delta while NO `watcher-fire` had occurred for that repo recently ⇒ the `@parcel/watcher` silently missed the change. Turns the silent-watcher-failure class into a greppable signal. Tagged `repoRoot`, `reason`, `sinceWatcherFireMs`. |
| `WORKER_GIT_STATE_MIRROR_RECONCILE_BACKOFF` | `worker:git-state-mirror.reconcile-backoff` | `i` | `git-state-mirror-worker-entry.ts::runGroupReconcile` (finally) — adaptive backoff engaged: the last `git status` was slow enough (EDR spawn tax) that the next heartbeat gap stretched to `lastStatusMs × factor` (capped at 60 s) instead of the base 1 s/3 s, pinning the git-spawn duty cycle so the heartbeat can't run status back-to-back and starve the foreground Diff. Off the hot path: at most once per reconcile COMPLETION, only when the gap stretched past base. Tagged `repoRoot`, `lastStatusMs`, `baseIntervalMs`, `nextIntervalMs`, `factor`. |
| `WORKER_GIT_STATE_MIRROR_GITIGNORE_GLOBS` | `worker:git-state-mirror.gitignore-globs` | `i` | `git-state-mirror-worker-entry.ts::startWatcherForGroup` — emitted once per watcher subscribe; how many parcel ignore globs were derived from the repo's `.gitignore` directory patterns to suppress churning ignored-dir events (kar-qemu emulator `build/` storm). Tagged `repoRoot`, `globCount`. A non-zero count should correlate with fewer `watcher-fire` / `recompute-status-done` for that repo. |
| `MAIN_GIT_STATE_MIRROR_FANOUT` | `main:git-state-mirror.fanout` | `i` | `git-state-mirror-router.ts` — fanout to N subscribers. Tagged `cwd`, `subscriberCount`, `status` (the authoritative 5-state badge status the worker COMPUTED — pair with `renderer:terminal-title.color-rendered` to localise a classification bug vs a render bug), `deltaKeys` (e.g. `['fileList','branch']`). |
| `MAIN_GIT_STATE_MIRROR_WORKER_SHUTDOWN` | `main:git-state-mirror.worker-shutdown` | `X` (duration) | `git-state-mirror-router.ts` — graceful worker shutdown during app quit. Tagged `result` (`clean-exit` / `nonzero-exit` / `terminated-after-timeout`), `code`, `durationMs`. |
| `WORKER_GIT_STATE_MIRROR_SHUTDOWN_QUIESCED` | `worker:git-state-mirror.shutdown-quiesced` | `i` | `git-state-mirror-worker-entry.ts:shutdownWorker` — emitted after the real native-quiesce barrier (zero live @parcel/watcher subscriptions + zero pending unsubscribes, then settle) just before `parentPort.close()`. Tagged `activeSubscriptions`, `pendingUnsubscribes`, `settledMs`, `deadlineHit`. The teardown-SIGABRT fix: proves native quiescence before the env is freed. |
| `MAIN_GIT_STATE_MIRROR_WORKER_SHUTDOWN_ACK` | `main:git-state-mirror.worker-shutdown-ack` | `i` | `git-state-mirror-router.ts:handleWorkerMessage` — receipt of `shutdown-complete`. Defuses the unsafe terminate timer (terminate becomes ack-gated) and schedules a short safe-terminate grace. Tagged `quiesce` (the worker's breadcrumb). |
| `MAIN_GIT_STATE_MIRROR_RESPAWN_CANCELLED` | `main:git-state-mirror.respawn-cancelled` | `i` | `git-state-mirror-router.ts:dispose` — a pending worker respawn was cancelled because the router is disposing (quit), so no fresh watcher-bearing worker spawns into a quitting app. Tagged `reason`. |
| `MAIN_APP_QUIT_GSM_DRAINED` | `main:app.quit-gsm-drained` | `i` | `ipc-handlers.ts:cleanupIpcHandlers` — the GitStateMirror worker fully drained + exited on the cooperative quit path BEFORE the runtime froze worker isolates. Absence in a teardown-crash trace flags an unguarded quit edge that skipped the awaited dispose. |
| `RENDERER_TERMINAL_TITLE_BRANCH_RENDERED` | `renderer:terminal-title.branch-rendered` | `i` | `src/components/TerminalGrid/TerminalGrid.tsx` — DOM commit landed with new branch text. Tagged `terminalId`, `cwd`, `branch`. |
| `RENDERER_TERMINAL_TITLE_COLOR_RENDERED` | `renderer:terminal-title.color-rendered` | `i` | Same file — DOM `terminal-grid-branch--{status}` className committed. Tagged `terminalId`, `status` (`clean` / `modified` / `added` / `unknown`). |
| `RENDERER_GIT_DIFF_MANUAL_REFRESH` | `renderer:git-diff.manual-refresh` | `X` (duration) | `src/components/GitDiffViewer/GitDiffViewer.tsx` — user invoked Refresh Changes, clearing renderer diff caches and re-reading list/body with `force: true`. Tagged `cwd`, `terminalId`, `result`, `durationMs`. |
| `RENDERER_GIT_DIFF_HUNK_NAVIGATE` | `renderer:git-diff.hunk-navigate` | `i` | Same file — user jumped to previous/next diff hunk. Tagged `cwd`, `terminalId`, `direction`, `index`, `changeCount`, `line`. |
| `RENDERER_GIT_DIFF_HUNK_ACTION` | `renderer:git-diff.hunk-action` | `X` (duration) | Same file — user staged, reverted, or unstaged an individual diff hunk from the inline hunk controls. Tagged `cwd`, `terminalId`, `filename`, `changeType`, `action`, `hunkIndex`, `result`, `durationMs`. |
| `RENDERER_GIT_DIFF_HUNK_WIDGET_INSTALL` | `renderer:git-diff.hunk-widget-install` | `X` (duration) | Same file — renderer installed or retried the always-visible per-hunk action widgets after Monaco model/diff updates. Tagged `cwd`, `terminalId`, `filename`, `changeType`, `result`, `reason`, `attempt`, `lineChangeCount`, `widgetCount`, `durationMs`. |
| `RENDERER_GIT_DIFF_BODY_PREFETCH` | `renderer:git-diff.body-prefetch` | `i` | Same file — Git Diff scheduled / completed a lightweight 4-file renderer-side prefetch so the first selection lands on a warm `fileContentsRef`. Backed by the main-process per-project content cache, so each call is nearly free. Tagged `cwd`, `terminalId`, `phase`, `candidateCount`, `completed`, `durationMs`. |
| `RENDERER_GIT_DIFF_FILE_LOAD` | `renderer:git-diff.file-load` | `X` (duration) | `src/components/GitDiffViewer/GitDiffViewer.tsx` — selected file changed and the renderer awaited the per-file body IPC before feeding Monaco. Tagged `cwd`, `terminalId`, `fileKey`, `filename`, `changeType`, `cacheState`, `cacheSource`, `cacheMissReason`, `result`, `durationMs`. |
| `RENDERER_GIT_DIFF_FILE_LOAD_MEMORY_HIT` | `renderer:git-diff.file-load-memory-hit` | `i` | `src/components/GitDiffViewer/GitDiffViewer.tsx` (`ensureFileContent` cache-hit early-return) — a selected file was served from the renderer in-memory `fileContents` cache WITHOUT a fetch. Makes "Git Diff shows stale/base content for a staged entry" reports (GDS-22/33) root-causable: a `staged` hit whose `modifiedLen` equals its `originalLen` (both == HEAD/base length) is a stale-slot hit. Tagged `terminalId`, `fileKey`, `filename`, `changeType`, `reason`, `originalLen`, `modifiedLen`. |
| `RENDERER_GIT_DIFF_MODEL_SYNC` | `renderer:git-diff.model-sync` | `X` (duration) | Same file — selected-file content, editor mount, or state change reconciled the live Monaco original/modified models against renderer `fileContentsRef` so stable model URIs cannot show stale bodies. Tagged `cwd`, `terminalId`, `fileKey`, `filename`, `changeType`, `reason`, `result`, `originalChanged`, `modifiedChanged`, `originalLen`, `modifiedLen`, `durationMs`. |
| `RENDERER_GIT_DIFF_CACHE_INVALIDATION` | `renderer:git-diff.cache-invalidation` | `i` | Same file — renderer received a backend Git Diff cache invalidation and either marked visible file bodies stale for background refresh or cleared closed-view caches. Tagged `cwd`, `terminalId`, `invalidatedCwd`, `reason`, `isOpen`, `retainedEntries`, `staleEntries`. |
| `MAIN_GIT_DIFF_CONTENT_CACHE_HIT` | `main:git.diff.content-cache.hit` | `i` | `electron/main/git-diff-content-cache-wiring.ts` — the per-project file content cache served `getFileContent` from memory, no worker round-trip. Tagged `project`, `filename`, `changeType`, `source`. |
| `MAIN_GIT_DIFF_CONTENT_CACHE_MISS` | `main:git.diff.content-cache.miss` | `i` | Same file — cache lookup missed; the worker IPC was invoked and the result stored back into the cache. Tagged `project`, `filename`, `changeType`, `reason`, `force`. |
| `MAIN_GIT_DIFF_CONTENT_CACHE_SKIP_STALE_GENERATION` | `main:git.diff.content-cache.skip-stale-generation` | `i` | Same file — an in-flight worker result returned after the project cache generation changed, so the result was returned to its caller but not stored back into the shared content cache. Tagged `project`, `filename`, `changeType`. |
| `MAIN_GIT_DIFF_CONTENT_CACHE_INVALIDATE_PROJECT` | `main:git.diff.content-cache.invalidate-project` | `i` | Same file — `gitDiffCacheInvalidator` fired. For `reason='mirror'` (FS-watcher churn) the bucket is re-validated per file (`scoped:true`, also tags `keptEntries`) — only files whose working-tree stat changed are evicted, keeping unrelated files warm (kar-qemu content-cache thrash fix). Other reasons (force / mutation / LRU) wipe the whole bucket (`scoped:false`). Tagged `project`, `reason`, `droppedEntries`, `scoped`, `keptEntries`. |
| `MAIN_GIT_DIFF_CONTENT_CACHE_INVALIDATE_LRU` | `main:git.diff.content-cache.invalidate-lru` | `i` | Same file — the recent-project queue evicted a project, so the corresponding content cache bucket was dropped too. Tagged `project`, `reason: 'project-queue-evicted'`. |
| `MAIN_GIT_DIFF_PRECOMPUTE_SCHEDULE` | `main:git.diff.precompute.schedule` | `i` | Same file — precompute scheduler began a burst for a project (after debounce). Tagged `project`, `candidateCount`. |
| `MAIN_GIT_DIFF_PRECOMPUTE_SKIP_TOO_LARGE` | `main:git.diff.precompute.skip-too-large` | `i` | Same file — a candidate was skipped because its content exceeded the single-file cap. Tagged `project`, `filename`, `bytes`, `reason`. |
| `MAIN_GIT_PREWARM_REPO_TRIGGERED` | `main:git.prewarm.repo-triggered` | `i` | `electron/main/git-repo-prewarm.ts::RepoPrewarmCoordinator.prewarm` — a new cwd resolved by `TerminalGitInfoBridge.attachMirror` started a Diff prewarm (lifecycle entry). Tagged `cwd`, `repoRoot`, `reason` (`attach`/`cwd-change`/`branch-change`/`renderer-fallback`). |
| `MAIN_GIT_PREWARM_REPO_SKIPPED_DEDUP` | `main:git.prewarm.repo-skipped-dedup` | `i` | Same file — the cwd was already prewarmed this session (`lastPrewarmedCwds` Set hit); the diff warm was skipped. The breadcrumb a "why didn't my repo re-warm after I cd'd back?" report needs. Tagged `cwd`, `reason`. |
| `MAIN_GIT_PREWARM_HISTORY_DONE` | `main:git.prewarm.history-done` | `i` | `electron/main/ipc-handlers.ts` (coordinator `prewarmHistory` dep) — the History prewarm (L8 list first page + L9 commit-diff set: top-10 ∪ last-7-days) finished. Tagged `cwd`, `repoRoot`, `branchOid`, `commitsWarmed`, `durationMs`. |
| `MAIN_GIT_PREWARM_DETACH_CANCELLED` | `main:git.prewarm.detach-cancelled` | `i` | `electron/main/git-repo-prewarm.ts::RepoPrewarmCoordinator.runDetachCancel` — a cwd was abandoned (no live terminal subscribes it) past the grace window, so its wasted background content-precompute burst was cancelled (`gitDiffPrecomputeScheduler.cancelProject`) to free the EDR git-spawn budget for the cwd the user landed on. Fires only if the user did NOT return within `detachGraceMs` (a return aborts it, no event). Tagged `cwd`. |
| `MAIN_GIT_HISTORY_LIST_CACHE_HIT` | `main:git.history.list-cache.hit` | `i` | `electron/main/git-utils.ts::getGitHistory` — the L8 list cache (`repoRoot::branchOid::limit::skip`) served History open from memory; no `git log` / `rev-list` spawn. Tagged `cwd`, `branchOid`, `limit`, `skip`, `ageMs`. |
| `MAIN_GIT_HISTORY_LIST_CACHE_MISS` | `main:git.history.list-cache.miss` | `i` | Same function — L8 missed (key absent / branchOid moved on a new commit); the worker ran the multi-spawn `git log` and the SUCCESSFUL result was cached. Tagged `cwd`, `branchOid`, `limit`, `skip`. |
| `MAIN_GIT_HISTORY_COMMIT_DIFF_CACHE_HIT` | `main:git.history.commit-diff-cache.hit` | `i` | `electron/main/git-utils.ts::getGitHistoryDiff` — the L9 immutable commit-diff cache (`repoRoot::<options>`) served a commit's diff from memory. Tagged `cwd`, `base`, `head`, `ageMs`. |
| `MAIN_GIT_HISTORY_COMMIT_DIFF_CACHE_MISS` | `main:git.history.commit-diff-cache.miss` | `i` | Same function — L9 missed; the worker ran `git diff`/`show` and the SUCCESSFUL (immutable) result was cached. Tagged `cwd`, `base`, `head`. |
| `MAIN_GIT_CATFILE_BATCH_SPAWNED` | `main:git.cat-file-batch.spawned` | `i` | `electron/main/git-cat-file-batch.ts::RepoCatFileProcess.ensureProc` — long-running `git cat-file --batch` created for a repo (lifecycle entry; one-time per-repo spawn cost, enabled on win32 + darwin). Tagged `repoRoot`, `platform`. |
| `MAIN_GIT_CATFILE_BATCH_PROCESS_EXITED` | `main:git.cat-file-batch.process-exited` | `i` | Same file — the long-running process exited/errored (lifecycle exit; next read respawns). A burst means the batch is thrashing. Tagged `repoRoot`, `reason` (`exit`/`error`), `code`/`signal` or `message`. |
| `MAIN_GIT_CATFILE_BATCH_FALLBACK` | `main:git.cat-file-batch.fallback` | `i` | `electron/main/git-utils.ts::readGitFileByRef` — a file-content read could NOT use the batch and degraded to per-call `cat-file -s` + `cat-file blob` (spawn-taxed). The silent-perf-regression signal. Tagged `repoRoot`, `platform`, `reason*` (summarized). |
| `RENDERER_GIT_DIFF_BODY_RENDERED` | `renderer:git-diff.body-rendered` | `i` | `src/components/GitDiffViewer/GitDiffViewer.tsx` — Monaco received the new `originalContent` / `modifiedContent` for the selected file. Tagged `cwd`, `fileKey`, `originalLen`, `modifiedLen`. |
| `RENDERER_GIT_DIFF_FILE_LIST_MODE_CHANGE` | `renderer:git-diff.file-list-mode-change` | `i` | `src/components/GitDiffViewer/GitDiffViewer.tsx` — user switched the changed-file sidebar between Tree and Flat modes. Tagged `cwd`, `terminalId`, `mode`. |
| `RENDERER_GIT_DIFF_JUMP_TO_EDITOR` | `renderer:git-diff.jump-to-editor` | `i` | Same file — user opened the selected diff file in Project Editor. Tagged `cwd`, `terminalId`, `filename`, `repoRoot`. |
| `RENDERER_GIT_DIFF_SPLIT_MODE_TOGGLE` | `renderer:git-diff.split-mode-toggle` | `i` | Same file — user switched the diff display between Auto, Side-by-side, and Inline using the toggle in the working-directory bar. Tagged `cwd`, `terminalId`, `mode`. |
| `RENDERER_GIT_DIFF_AUX_MIRROR_SUBSCRIPTION` | `renderer:git-diff.aux-mirror-subscription` | `i` | Same file — Git Diff subscribed / unsubscribed auxiliary Mirror roots for submodule repos shown inside the parent diff, so closed-view submodule edits still invalidate the parent view. Tagged `cwd`, `terminalId`, `repoRoot`, `action`. |
| `RENDERER_CLIPBOARD_PATH_COPY` | `renderer:clipboard.path-copy` | `i` | `src/hooks/usePathCopy.ts` — a working-directory / file path copy resolved through the tiered clipboard write. Tagged `tier` (`native`/`async`/`legacy`/`none`), `ok`, `textLen`. `tier:'none'` (ok:false) means every clipboard tier failed — root-causes a "Copy failed" toast (WDC-01/02/03); `tier:'legacy'` or `'native'` shows the focus-gated async API was bypassed. |
| `RENDERER_GIT_DIFF_SUBMODULE_OUTLINE_OBSERVED` | `renderer:git-diff.submodule-outline-observed` | `i` | `src/components/GitDiffViewer/GitDiffViewer.tsx` (`applyLoadedDiffResult`) — the root-only outline was applied while submodules were still loading (the two-stage submodule load's intermediate state). Latches the peak loading-repo counts so the "outline visible before full load" guarantee (DSM-03 / RSM-03) is observable without racing the transient. Tagged `terminalId`, `maxLoadingRepoCount`, `maxNestedLoadingRepoCount`, `fileCount`. |
| `RENDERER_GIT_DIFF_SUBPAGE_RESTORE` | `renderer:git-diff.subpage-restore` | `i` | `src/components/GitDiffViewer/GitDiffViewer.tsx` (lifecycle `afterEnter`) — fires when the Git Diff subpage is RE-ENTERED via a subpage switch and the saved `DiffSubpageSnapshot` is applied (restores the previously selected file). A fresh `git-diff:open` opens blank and emits no restore (GDS-31). Makes "Git Diff didn't restore my file on switch-back" reports (SN-07 / CDP-06) root-causable. Tagged `hadSnapshot`, `restoredFile`, `fileFoundInList`, `fileCount`. |
| `RENDERER_PROJECT_EDITOR_JUMP_TO_DIFF` | `renderer:project-editor.jump-to-diff` | `i` | `src/components/ProjectEditor/ProjectEditor.tsx` — Project Editor routed the current file back to Git Diff. Tagged `terminalId`, `filename`, `repoRoot`, `changeType`. |
| `RENDERER_GIT_DIFF_CLICK_PHASE_IPC` | `renderer:git-diff.click-phase.ipc` | `X` | `src/components/GitDiffViewer/clickLatencyTracker.ts` — span covering `getFileContent` IPC round-trip (`ipcEnd - ipcStart`). Payload: `durationMs`, `fileKey`, `filename`, `cacheState`, `totalMs`. Auto-routed to `ph='X'` by `perf-trace-logger::resolvePhase` because of `durationMs`. |
| `RENDERER_GIT_DIFF_CLICK_PHASE_STATE_SET` | `renderer:git-diff.click-phase.state-set` | `X` | Same emitter — span between IPC end and React `setState` actually applied (`stateSet - ipcEnd`). Payload identical to the IPC phase. |
| `RENDERER_GIT_DIFF_CLICK_PHASE_MODEL_BIND` | `renderer:git-diff.click-phase.model-bind` | `X` | Same emitter — span between React state availability and the DiffEditor model binding (`modelBound - stateSet`). |
| `RENDERER_GIT_DIFF_CLICK_PHASE_MOUNT` | `renderer:git-diff.click-phase.mount` | `X` | Same emitter — span between model binding and Monaco DiffEditor `editorReady` (`editorReady - modelBound`) when the editor cold-mounts. |
| `RENDERER_GIT_DIFF_CLICK_PHASE_DIFF_COMPUTE` | `renderer:git-diff.click-phase.diff-compute` | `X` | Same emitter — span between editor/model readiness and Monaco's `onDidUpdateDiff` (`diffComputed - ready`). |
| `RENDERER_GIT_DIFF_CLICK_PHASE_DOM_COMMIT` | `renderer:git-diff.click-phase.dom-commit` | `X` | Same emitter — span between `onDidUpdateDiff` and the first observed Monaco DOM mutation (`domCommitted - diffComputed`). |
| `RENDERER_GIT_DIFF_CLICK_PHASE_PAINT` | `renderer:git-diff.click-phase.paint` | `X` | Same emitter — span between DOM commit and the rAF callback that proxies for first paint (`paintReady - domCommitted`). |
| `RENDERER_GIT_DIFF_CLICK_PHASE_TOKENIZE_SETTLE` | `renderer:git-diff.click-phase.tokenize-settle` | `X` | Same emitter — span between first paint and Monaco token/decorations/DOM quiet (`tokenizeSettle - paintReady`). This is the user-visible settled total used by the debug panel. |
| `RENDERER_GIT_DIFF_CLICK_PHASE_COLD_MOUNT` | `renderer:git-diff.click-phase.cold-mount` | `X` | `src/components/GitDiffViewer/GitDiffViewer.tsx` — first DiffEditor mount after opening Git Diff (`handleEditorDidMount - git-diff open`). |
| `RENDERER_GIT_DIFF_CLICK_PHASE_REVEAL_TIMEOUT` | `renderer:git-diff.click-phase.reveal-timeout` | `X` | Same file — abnormal fallback when neither model binding nor `onDidUpdateDiff` releases the reveal cycle before the cap. |
| `RENDERER_GIT_DIFF_CLICK_TOTAL` | `renderer:git-diff.click-phase.total` | `X` | Same emitter — total click→settled span (`tokenizeSettle - clickAt`). Use this for percentile / regression queries; the per-phase events are for attribution. |

These events are registered in `src/utils/perf-trace-names.ts` (commit 2 of
the GitStateMirror PR). The autotest gates on the final visible branch /
status state within a generous timeout and records elapsed times in assertion
details plus trace events for trend analysis.

#### Renderer lifecycle

| Constant | Name | Phase | Emitted at |
|---|---|---|---|
| `MAIN_RENDERER_PROCESS_GONE` | `main:renderer-process-gone` | `i` | `electron/main/index.ts` `render-process-gone` |
| `MAIN_RENDERER_UNRESPONSIVE` | `main:renderer-unresponsive` | `i` | Same, `unresponsive` event |

#### AppState persistence

| Constant | Name | Phase | Emitted at |
|---|---|---|---|
| `MAIN_APP_STATE_SAVE` | `main:app-state-save` | `X` (has `durationMs`) | `app-state-storage.ts` save completion |
| `MAIN_APP_STATE_SAVE_ERROR` | `main:app-state-save-error` | `i` | same, error path |

#### IPC hot paths

| Constant | Name | Phase | Call site |
|---|---|---|---|
| `MAIN_IPC_PROJECT_READ_FILE` | `main:ipc.project.read-file` | `X` | `ipc-handlers.ts` readFile handler |
| `MAIN_IPC_PROJECT_READ_FILE_CHUNK` | `main:ipc.project.read-file-chunk` | `X` | `ipc-handlers.ts` readFileChunk handler |
| `MAIN_IPC_PROJECT_SAVE_FILE` | `main:ipc.project.save-file` | `X` | saveFile handler |
| `MAIN_IPC_GIT_GET_DIFF` | `main:ipc.git.get-diff` | `X` | getDiff handler |
| `MAIN_IPC_GIT_GET_FILE_CONTENT` | `main:ipc.git.get-file-content` | `X` | Git Diff per-file body handler |
| `MAIN_IPC_GIT_GET_HISTORY` | `main:ipc.git.get-history` | `X` | getHistory handler |
| `MAIN_IPC_TERMINAL_SPAWN` | `main:ipc.terminal.spawn` | `X` | terminal create handler |

#### Child processes — PTY / Git CLI / Ripgrep / Updater

Every subprocess Onward fires off is emitted so a trace shows the
operation in the same timeline as the renderer/user input that
triggered it (see `CLAUDE.md` § "Hard rule — Per-feature perf
instrumentation"). Git emits one slice per `execFile`; PTY / Ripgrep /
Updater emit on spawn + exit/kill.

| Constant | Name | Phase | Call site |
|---|---|---|---|
| `MAIN_PTY_SPAWN` | `main:pty.spawn` | `X` | `electron/main/pty-manager.ts` `PtyManager.create()` |
| `MAIN_PTY_EXIT` | `main:pty.exit` | `i` | Same, `pty.onExit` handler |
| `MAIN_PTY_KILL` | `main:pty.kill` | `i` | `PtyManager.killRecord()` |
| `MAIN_GIT_EXEC` | `main:git.exec` | `X` (has `durationMs`) | `electron/main/git-utils.ts` shared `execFileAsync` wrapper — **only** emitted when the executed binary's basename is `git` (routing via `classifyExecBinary`). Tagged with `subcommand`, `repoKey`, `ok`, `argsLen`, `priority`. `subcommand` is the REAL subcommand (`status` / `diff` / `log` / `cat-file` / `rev-parse` …) via `extractGitSubcommand(args)` — it skips leading global-option pairs (`-c core.quotepath=false`, `-C <path>`) instead of recording `args[0]`, which previously collapsed every config-prefixed spawn into a single `-c` bucket. |
| `MAIN_PROC_EXEC` | `main:proc.exec` | `X` (has `durationMs`) | Same wrapper, **non-git** exec path (lsof cwd probes, etc.) — tagged with `binary`. Separated from `main:git.exec` so git-pressure percentiles are not diluted by unrelated spawns. |
| `WORKER_RIPGREP_PROCESS_SPAWN` | `worker.ripgrep:process.spawn` | `X` | `electron/main/ripgrep-search-worker-entry.ts` — forwarded via `parentPort.postMessage({event:'trace', …})` and replayed by `ripgrep-search.ts::handleWorkerEvent` |
| `WORKER_RIPGREP_PROCESS_EXIT` | `worker.ripgrep:process.exit` | `X` (has `durationMs`) | Same, on ripgrep process `close`/`error` |
| `MAIN_UPDATER_SPAWN` | `main:updater.spawn` | `i` / `X` | `electron/main/update-service.ts` — one emission per strategy (`wmi` / `batch` / `detached-spawn` on win32, `macos-sh` on darwin) |
| `MAIN_PTY_WRITE` | `main:pty.write` | `X` (has `durationMs`) | `electron/main/pty-manager.ts::write` — one span per PTY write (`path=small` direct or `large` chunked). Task-scoped tid. |

#### Task-scoped data flow (PTY pipeline)

Routed onto per-Task virtual tid (`task-<shortId>` on main, `-rnd` suffix on renderer). See diagram in § 1.

| Constant | Name | Phase | Call site |
|---|---|---|---|
| `MAIN_TERMINAL_DATA_IPC_SEND` | `main:terminal-data.ipc-send` | `X` (has `bufferAgeMs`; dur unused) | `electron/main/ipc-handlers.ts` — every merged send; tagged `path=fast|boost|batched` |
| `RENDERER_TERMINAL_DATA_IPC_RECV` | `renderer:terminal-data.ipc-recv` | `i` | `src/terminal/terminal-session-manager.ts::registerGlobalDataListener` |
| `RENDERER_TERMINAL_DATA_FAST_PATH` | `renderer:terminal-data.fast-path` | `i` | Same file, fast-path branch (small chunk or interactive boost) |
| `RENDERER_TERMINAL_DATA_SCHEDULER_ENQUEUE` | `renderer:terminal-data.scheduler-enqueue` | `i` | Slow-path branch — bytes entered the per-task queue |
| `RENDERER_TERMINAL_DATA_SCHEDULER_FLUSH` | `renderer:terminal-data.scheduler-flush` | `X` (has `durationMs`) | `src/terminal/terminal-output-scheduler.ts::flush` — aggregate slice (no terminalId) + per-Task slice (with bytes consumed) |
| `RENDERER_TERMINAL_DATA_XTERM_WRITE` | `renderer:terminal-data.xterm-write` | `X` (has `durationMs`) | `src/terminal/terminal-session-manager.ts::writeTerminalData` — actual `session.terminal.write()` cost |
| `MAIN_BROWSER_ZOOM_CHANGED` | `main:browser.zoom-changed` | `i` | `electron/main/browser-view-manager.ts` — Open Browser Ctrl/Cmd+wheel (and macOS pinch) zoom. Fires inside the `zoom-changed` handler after re-clamping to the 50–200%/10% ladder. Tags `direction`, `zoomPercent`. |
| `MAIN_BROWSER_LOCAL_FILE_RESOLVE` | `main:browser.local-file-resolve` | `i` | `electron/main/browser-view-manager.ts::normalizeUrl` — a typed address-bar path/host was resolved to a local `file://` URL. Breadcrumb for "did my local file open?". Tags `inputLen` only (no path content). |
| `MAIN_BROWSER_URL_REJECTED` | `main:browser.url-rejected` | `i` | `electron/main/browser-view-manager.ts` — `will-navigate` blocked a URL via `isAllowedUrlForInfo`. Tags `protocol`, `allowFile`, `allowAnyFile`. Off-hot-path (not the per-subresource `onBeforeRequest`). |

### 2.2 Worker threads (pid=1, dedicated tid lane per worker)

Each Node Worker thread writes through the **same** main-side
`performanceTrace` singleton via a `parentPort.postMessage` envelope —
there is exactly **one** trace stream per process, and each worker
shows up as its own `thread_name` track in Perfetto UI. The previous
"per-worker tmpdir trace file + race for `latest.txt`" design was
removed in 2026-04-25; the unified `electron/main/trace-store.ts`
backend (NDJSON chunks under one shared dir) replaced the legacy
JSON-array writer in 2026-05-05.

Wire format (worker → main):

```ts
{ event: 'trace', name: string, data?: object, source?: { tid?, terminalId? } }
```

The shape mirrors the long-standing ripgrep precedent
(`ripgrep-search-worker-entry.ts::postTrace`), generalised so every
worker uses it transparently — `performanceTrace.record(...)` inside a
worker context auto-detects `!isMainThread` and forwards via
`parentPort.postMessage(...)` instead of touching disk.

Receivers in each `*-worker-client.ts`:

```ts
this.worker.on('message', (message) => {
  if (isPerfTraceWorkerEvent(message)) {
    replayPerfTraceWorkerEvent(message, {
      tid: WORKER_TID.GIT_IPC,           // stable per-worker tid
      threadName: 'git-ipc-worker'       // human label for Perfetto UI
    })
    return
  }
  this.handleMessage(message as WorkerResponse)
})
```

Worker tid lanes (defined in `electron/main/performance-trace.ts`,
exported as `WORKER_TID.*`). Main tid stays at `1`; per-task tids start
at `MAIN_TASK_TID_BASE = 10000`; renderer per-task at `20000`. Worker
tids occupy the gap 5000-5999 so all three coexist without overlap.

| Constant | tid | thread_name in trace |
|---|---|---|
| `WORKER_TID.GIT_IPC` | 5001 | `git-ipc-worker` |
| `WORKER_TID.GIT_STATUS` | 5002 | `git-status-worker` |
| `WORKER_TID.PROJECT_FS` | 5003 | `project-fs-worker` |
| `WORKER_TID.SQLITE` | 5004 | `sqlite-worker` |
| `WORKER_TID.APP_STATE` | 5005 | `app-state-worker` |
| `WORKER_TID.RIPGREP_SEARCH` | 5006 | (ripgrep already used its own pre-existing lane) |

Worker-client latency / timeout / error / exit events still come from
the main-thread side after a worker IPC round-trip, and stay on
`tid=1`:

| Constant | Name |
|---|---|
| `WORKER_APP_STATE_{LATENCY,TIMEOUT,ERROR,EXIT}` | `main:app-state-worker-{latency,timeout,error,exit}` |
| `WORKER_GIT_IPC_{LATENCY,TIMEOUT,ERROR,EXIT}` | `main:git-ipc-worker-…` |
| `WORKER_GIT_STATUS_{LATENCY,TIMEOUT,ERROR,EXIT}` | `main:git-status-worker-…` |
| `WORKER_PROJECT_FS_{LATENCY,TIMEOUT,ERROR,EXIT}` | `main:project-fs-worker-…` |
| `WORKER_SQLITE_{LATENCY,TIMEOUT,ERROR,EXIT}` | `main:sqlite-worker-…` |
| `WORKER_RIPGREP_{LATENCY,TIMEOUT,ERROR,EXIT}` | `main:ripgrep-worker-…` |
| `WORKER_RIPGREP_BINARY_MISSING` | `main:ripgrep-binary-missing` |
| `WORKER_RIPGREP_START_ERROR` | `main:ripgrep-worker-start-error` |

All worker-client events are emitted in `electron/main/*-worker-client.ts`.
Exact file:line stays in the git log rather than pasted here (faster
to trust `git grep PERF_TRACE_EVENT.WORKER_` than a stale markdown table).

Important: do NOT static-import `electron` from `performance-trace.ts`
/ `trace-store.ts` or any of their transitive importers
(`git-utils.ts`, `git-runtime-manager.ts`, etc.). Worker threads inside
Electron cannot resolve `require('electron')`, and a top-of-file
import crashes the worker before any uncaughtException handler can
register. Lazy-load via `require('electron')` gated on
`worker_threads.isMainThread`.

### 2.3 Renderer (pid=2, tid=<WebContents.id>)

#### Built-in observers

| Constant | Name | Phase | Emitted at |
|---|---|---|---|
| `RENDERER_TRACE_START` | `renderer:trace-start` | `i` | First `installRendererPerfTrace()` |
| `RENDERER_EVENT_LOOP_STALL` | `renderer:event-loop-stall` | `X` (`dur`=driftMs) | 250 ms sampler |
| `RENDERER_FRAME_STALL` | `renderer:frame-stall` | `X` (`dur`=frameDeltaMs) | Per-rAF |
| `RENDERER_LONGTASK` | `renderer:longtask` | `X` (`dur`=durationMs) | `PerformanceObserver('longtask')` |
| `RENDERER_PROMPT_INPUT_PAINT` | `renderer:prompt-input-paint` | `X` (`dur`=eventToPaintMs) | Prompt textarea `input` → rAF → rAF |
| `RENDERER_PERF_SNAPSHOT` | `renderer:perf-snapshot` | `i` (t) | `perf-monitor.ts` 1 s tick |
| `RENDERER_APPSTATE_SUMMARY` | `renderer:appstate-summary` | `i` (t) | `AppStateContext` 1 s tick |

#### Web events — wired

| Constant | Name | Phase | Call site |
|---|---|---|---|
| `RENDERER_WINDOW_VISIBILITY_CHANGE` | `renderer:window.visibility-change` | `i` | `src/utils/perf-trace.ts::installWindowEventTrace()` — `document.addEventListener('visibilitychange', …)` |
| `RENDERER_WINDOW_FOCUS` | `renderer:window.focus` | `i` | Same, `window.addEventListener('focus', …)` |
| `RENDERER_WINDOW_BLUR` | `renderer:window.blur` | `i` | Same, `blur` |
| `RENDERER_WINDOW_PAGEHIDE` | `renderer:window.pagehide` | `i` | Same, `pagehide` |

#### IPC bridge latency (renderer→main→renderer round trip)

Wrapped at the preload boundary (`electron/preload/index.ts::traceIpc`),
so every call through `window.electronAPI.<domain>.<method>()` gets a
`ph='X'` span with `durationMs` in its payload.

| Constant | Name | Phase | Call site |
|---|---|---|---|
| `RENDERER_IPC_PROJECT_READ_FILE` | `renderer:ipc.project.read-file` | `X` | `project.readFile()` wrapper |
| `RENDERER_IPC_PROJECT_READ_FILE_CHUNK` | `renderer:ipc.project.read-file-chunk` | `X` | `project.readFileChunk()` wrapper |
| `RENDERER_IPC_GIT_GET_DIFF` | `renderer:ipc.git.get-diff` | `X` | `git.getDiff()` wrapper |
| `RENDERER_IPC_TERMINAL_WRITE` | `renderer:ipc.terminal.write` | `X` | `terminal.write()` wrapper |

#### Async rendering hot paths

| Constant | Name | Phase | Call site |
|---|---|---|---|
| `RENDERER_MARKDOWN_RENDER` | `renderer:markdown.render` | `X` | `ProjectEditor.tsx::scheduleMarkdownApply` — end-to-end span from `postMessage` send to sanitized HTML commit |
| `RENDERER_MARKDOWN_SANITIZE` | `renderer:markdown.dompurify-sanitize` | `X` | Same, DOMPurify call |
| `RENDERER_MARKDOWN_MERMAID` | `renderer:markdown.mermaid-render` | `i`/`X` | `src/utils/mermaidRenderer.ts` |
| `RENDERER_MARKDOWN_PREVIEW_REVEAL` | `renderer:markdown.preview-reveal` | `i` | `ProjectEditor.tsx::queuePreviewReveal::finalize` — duration of the preview-restore phase machine (from `queuePreviewReveal` entry to `phase:idle`). Payload: `cause` (`fast-path`), `hadWork` (bool), `durationMs`. The user-perceived loading window when entering Markdown preview. |
| `RENDERER_MARKDOWN_SESSION_CACHE_CAPTURE` | `renderer:markdown.session-cache-capture` | `X` | `ProjectEditor.tsx::captureMarkdownSessionCache` — captures rendered Markdown preview state without serializing the live DOM when `markdownRenderedHtmlRef` is available. Payload: `reason`, `durationMs`, `htmlLength`, `source`. |
| `WORKER_MARKDOWN_RENDER_COMPLETE` | `worker.markdown:render-complete` | `X` | Worker-measured duration reported to renderer via `worker.onmessage` — parse + katex + highlight |
| `RENDERER_MONACO_VIEWSTATE_RESTORE` | `renderer:monaco.viewstate-restore` | `X` | `ProjectEditor.tsx::editor.restoreViewState` |
| `RENDERER_XTERM_WEBGL_INIT` | `renderer:xterm.webgl-context-init` | `X` | `src/components/Terminal/Terminal.tsx` WebGL addon attach |

#### Terminal renderer surface lifecycle

| Constant | Name | Phase | Call site |
|---|---|---|---|
| `RENDERER_XTERM_RENDERER_CONTEXT_LOST` | `renderer:xterm.renderer.context-lost` | `i` | `terminal-renderer-lifecycle.ts` xterm `WebglAddon.onContextLoss` callback; enters the VS Code-aligned DOM fallback path |
| `RENDERER_XTERM_RENDERER_RESTORE_DEFERRED` | `renderer:xterm.renderer.restore-deferred` | `i` | Same file, `ensureWebgl()` defers while cooldown makes WebGL unsafe |
| `RENDERER_XTERM_RENDERER_CONTEXT_LOSS_FALLBACK` | `renderer:xterm.renderer.context-loss-fallback` | `i` | Same file, DOM fallback path after xterm reports an unrecovered context loss; tagged with `trigger`, `changedRenderer`, `cooldownMs` |
| `RENDERER_XTERM_RENDERER_ENSURE_WEBGL` | `renderer:xterm.renderer.ensure-webgl` | `i` | Same file, WebGL addon attach / attach failure |
| `RENDERER_XTERM_RENDERER_DISPOSE_WEBGL` | `renderer:xterm.renderer.dispose-webgl` | `i` | Same file, WebGL addon dispose; `reason=document-hidden` means host page visibility released GPU ownership |
| `RENDERER_XTERM_RENDERER_FAILURE` | `renderer:xterm.renderer.failure` | `i` | Same file, WebGL attach failures and cooldown accounting |

#### User-input hot paths (wired)

| Constant | Name | Phase | Call site |
|---|---|---|---|
| `RENDERER_PROMPT_EDITOR_SUBMIT` | `renderer:prompt.editor.submit` | `i` | `PromptEditor.tsx::handleSubmit` |
| `RENDERER_PROMPT_EDITOR_CANCEL` | `renderer:prompt.editor.cancel-edit` | `i` | `PromptEditor.tsx::handleCancel` |
| `RENDERER_PROMPT_EDITOR_CTX_MENU_OPEN` | `renderer:prompt.editor.ctx-menu-open` | `i` | `PromptEditorContextMenu.tsx` — fires once per right-click on `.prompt-editor-content`. Payload tags `hasSelection`, `pinnedCount`, `historyCount`, `taskCount`. Lets traces show how often users discover the menu and which submenus carry data. |
| `RENDERER_PROMPT_EDITOR_CTX_SUBMENU_LAYOUT` | `renderer:prompt.editor.ctx-submenu-layout` | `X` | `PromptEditorContextMenu.tsx` submenu layout pass for Send-to-Task and Import Pin. Payload tags `submenu`, natural/applied size, viewport size, chosen side, and `clampedX` / `clampedY`; no prompt or pinned-prompt content. |
| `RENDERER_PROMPT_INPUT_MODE_CHANGE` | `renderer:prompt.input-mode-change` | `i` | `App.tsx::handlePromptInputModeChange` — fires when the title-row selector changes the global Prompt input mode preference. Payload tags `mode` and `tabCount`; no prompt content. |
| `RENDERER_PROMPT_EDITOR_VIRTUAL_CARET` | `renderer:prompt.editor.virtual-caret` | `X` (when `durationMs` present, else `i`) | `PromptNotebook.tsx::handleCanvasMouseDown` — fires when a mousedown past EOL/EOF physically pads the textarea value with spaces / newlines so the native caret can land at the virtual (row, col). Args carry input-paint pipeline breakdown: `measureMs` (one-shot cell metrics), `handlerMs` (sync work), `caretMs` (outer rAF + setSelectionRange), `paintMs` (inner rAF, paint commit), `durationMs` (end-to-end, span dur), plus `metricsCached`, `row`, `col`, `padded`. SQL `slice.dur` is the direct latency signal. |
| `RENDERER_PROMPT_SENDER_DISPATCH` | `renderer:prompt.sender.dispatch` | `i` | `PromptSender.tsx::handleSend*` + `handleExecute` — tagged `action=send|execute|sendAndExecute|sendAllAndExecute` |
| `RENDERER_TERMINAL_FOCUS_CHANGE` | `renderer:terminal.focus-change` | `i` | `src/App.tsx::handleTerminalFocus` — Task-scoped tid |
| `RENDERER_TERMINAL_CTX_MENU_OPEN` | `renderer:terminal.ctx-menu-open` | `i` | `TerminalGrid.tsx` terminal content right-click menu open — Task-scoped tid; payload tags `hasSelection` and `pinnedCount` only. |
| `RENDERER_TERMINAL_CTX_PINNED_PROMPT_SEND` | `renderer:terminal.ctx-pinned-prompt-send` | `i` | `TerminalGrid.tsx` pinned Prompt selected from the terminal context menu — Task-scoped tid; payload tags `bytes` and `pinnedCount`, never Prompt content. |
| `RENDERER_TERMINAL_SEND_INPUT` | `renderer:terminal.send-input` | `i` | `src/App.tsx` sendInputSequence — Task-scoped tid |
| `RENDERER_PROJECT_FILE_OPEN` | `renderer:project.file-open` | `i` | `ProjectEditor.tsx::openFile` |
| `RENDERER_PROJECT_HTML_PREVIEW_RELOAD` | `renderer:project.html-preview-reload` | `i` | `ProjectEditor.tsx::requestHtmlPreviewReload` — fires when an HTML preview is forced to remount after save, external file change, or manual refresh. Payload tags `reason`, `pathLen`, `reloadKey`, and preserved scroll Y; no file content is recorded. |
| `RENDERER_PROJECT_HTML_PREVIEW_SEARCH` | `renderer:project.html-preview-search` | `i` | `ProjectEditor.tsx::runHtmlPreviewSearch` — fires when the HTML preview search query or next/previous navigation is sent to the WebContents. Payload tags query length and navigation direction only; no search text is recorded. |
| `RENDERER_PROJECT_HTML_PREVIEW_ZOOM` | `renderer:project.html-preview-zoom` | `i` | `ProjectEditor.tsx::setHtmlPreviewZoomFactorState` — fires when the HTML Preview zoom factor changes through toolbar, renderer shortcut, WebContents shortcut, restore, or debug path. Payload tags `source`, zoom percent, and active path length only. |
| `RENDERER_BROWSER_ZOOM` | `renderer:browser.zoom` | `i` | `BrowserPanel.tsx::stepZoom` — Open Browser toolbar/debug zoom step. Tags `source`, `direction`, `zoomPercent`. |
| `RENDERER_BROWSER_CACHE_HIDE` | `renderer:browser.cache-hide` | `i` | `BrowserPanel.tsx` unmount cleanup — Esc/toggle exit hid and KEPT the view cached (path memory). No payload. |
| `RENDERER_BROWSER_REATTACH` | `renderer:browser.reattach` | `i` | `BrowserPanel.tsx` mount — reattached a cached view on reopen. Tags `urlLen`. |
| `RENDERER_BROWSER_DESTROY` | `renderer:browser.destroy` | `i` | `BrowserPanel.tsx` unmount cleanup — the ✕ button fully destroyed the view. No payload. |
| `RENDERER_BROWSER_AUTO_REFRESH_TOGGLE` | `renderer:browser.auto-refresh-toggle` | `i` | `BrowserPanel.tsx::handleShowAutoRefreshMenu` — auto-refresh interval changed via the native preset menu. Tags `intervalMs` (null = off). |
| `RENDERER_BROWSER_AUTO_REFRESH_TICK` | `renderer:browser.auto-refresh-tick` | `i` | `BrowserPanel.tsx::runAutoRefreshTick` — one auto reload (≥5s cadence); captures scroll then reloads. No payload. |
| `RENDERER_PROJECT_FILE_BROWSER_COLLAPSE` | `renderer:project.file-browser-collapse` | `i` | `ProjectEditor.tsx::setFileBrowserCollapsedState` — fires when the left File Browser sidebar is collapsed or expanded. Payload tags collapsed state, source, sidebar mode, and prior width. |
| `RENDERER_PROJECT_EDITOR_REOPEN_RESTORE` | `renderer:project.editor-reopen-restore` | `X` | `ProjectEditor.tsx` close/reopen restore path — duration from Project Editor reopening to either retained-view reuse or persisted-state restore completion. Payload: `cause`, `durationMs`, `filePathLen`, `markdownCacheMode`. |
| `RENDERER_PROJECT_SUBPAGE_NAVIGATE` | `renderer:project.subpage-navigate` | `i` | Two sites in `ProjectEditor.tsx` dispatching `subpage:navigate` for diff / history |
| `RENDERER_PROJECT_SEARCH_GLOBAL` | `renderer:project.search.global` | `i` | `useGlobalSearch.ts::executeSearch` — fires once per debounced query commit |
| `RENDERER_TASK_NAME_RESOLVE` | `renderer:task-name.resolve` | `i` | `TerminalGrid.tsx::applyTerminalInfoUpdate` — fires on every `GIT_TERMINAL_INFO` IPC update once `notifyTerminalGitInfo` records the new info. The keep / clear / adopt rule now lives in the pure `decideTaskNameAutoFollow` (`TerminalGrid/auto-follow-name.ts`); this site maps its result onto the trace. Payload tags `source: 'manual' \| 'auto-branch' \| 'cleared-by-repo-switch' \| 'skipped-initial-hydration' \| 'fallback' \| 'skipped-disabled'`. `'skipped-initial-hydration'` is the boot hydration barrier: the first post-mount git-info sync declined to overwrite a just-loaded customName (the "renames reverted after restart" guard, complementing the `manualNameRepoRoot` persistence round-trip in `persisted-terminal.ts`). |
| `RENDERER_TASK_NAME_MANUAL_CLEAR` | `renderer:task-name.manual-clear` | `i` | Same site, fires only when the cwd has just moved to a different repo and the previous manual rename has been erased. Payload tags `prevRepoRoot` / `newRepoRoot` / `newBranch`. Pairs with the immediately following `RENDERER_TASK_NAME_RESOLVE { source: 'cleared-by-repo-switch' }`. |

#### GUI entries (new)

| Constant | Name | Phase | Call site |
|---|---|---|---|
| `RENDERER_TAB_CREATE` | `renderer:tab.create` | `i` | `TabBar.tsx` new-tab button |
| `RENDERER_TAB_SWITCH` | `renderer:tab.switch` | `i` | `TabBar.tsx` tab `onSelect` |
| `RENDERER_TERMINAL_SPLIT_ADD` | `renderer:terminal.split-add` | `i` | `src/App.tsx` split-layout auto-fill — Task-scoped tid |
| `RENDERER_GITDIFF_OPEN` | `renderer:gitdiff.open` | `i` | `src/App.tsx` dropdown + shortcut dispatches |
| `RENDERER_GITHISTORY_OPEN` | `renderer:githistory.open` | `i` | `src/App.tsx` dropdown `terminalGitHistory` branch |
| `RENDERER_SETTINGS_OPEN` | `renderer:settings.open` | `i` | `src/App.tsx` panel switcher |
| `RENDERER_CHANGELOG_OPEN` | `renderer:changelog.open` | `i` | `src/App.tsx::handleToggleChangeLog` |
| `RENDERER_SUBPAGE_FRESHNESS_CHECK` | `renderer:subpage.freshness-check` | `i` | `src/components/TerminalGrid/TerminalGrid.tsx::handleViewGitDiff` / `handleViewGitHistory` / Project Editor shortcut open path — fires once per subpage activation. Tagged `subpage: 'diff' \| 'history' \| 'editor'`, `cwd`, `reason: 'open' \| 'switch'`. Pairs with `MAIN_GIT_DIFF_CACHE_INVALIDATE { reason: 'force' }` on the main side for Git Diff. |
| `RENDERER_CUSTOM_LAYOUT_APPLY` | `renderer:custom-layout.apply` | `i` (carries `durationMs`) | `TerminalGrid.tsx` layout-transition `useEffect` — fires once per `layoutMode` change after `displayLayoutMode` flips, or immediately when downsizing. Tagged `kind: 'preset' \| 'custom'`, `effectiveCount`, `previousCount`, `durationMs` so SQL queries can compare custom-apply latency to preset-apply latency. |
| `RENDERER_CUSTOM_LAYOUT_EDITOR_OPEN` | `renderer:custom-layout.editor-open` | `i` | `CustomLayoutEditor.tsx` mount effect — fires when the editor opens (popover "+ New layout" or "Edit"). Tagged `mode: 'create' \| 'edit'`, `seedCellCount`. |
| `RENDERER_DOWNSIZE_DIALOG_OPEN` | `renderer:downsize-dialog.open` | `i` | `DownsizeConfirmDialog.tsx` open-effect — fires when the user picks a smaller layout (preset or custom) and the keep-Tasks dialog appears. Tagged `currentCount`, `requiredCount`. |
| `RENDERER_TERMINAL_DESTROY_BY_DOWNSIZE` | `renderer:terminal.destroy-by-downsize` | `i` | `App.tsx::handleDownsizeConfirm` — emitted on the per-Task tid lane just before `terminalSessionManager.dispose(id)`, so a Task's lifetime ends visibly on its own Perfetto row. Tagged `tabId`, `terminalId`. |

#### Background ops

| Constant | Name | Phase | Call site |
|---|---|---|---|
| `MAIN_FILE_INDEX_BUILD` | `main:file-index.build` | `X` (has `durationMs`) | `electron/main/ipc-handlers.ts` `PROJECT_BUILD_FILE_INDEX` handler |
| `MAIN_FILE_INDEX_UPDATE` | `main:file-index.update` | `i` | Same, `PROJECT_INVALIDATE_FILE_INDEX` handler |
| `MAIN_PROJECT_TREE_WATCH_EVENT` | `main:project-tree-watch.event` | `i` | `project-tree-watch-manager.ts::scheduleFlush` — one per debounce-window start (not per raw FSEvent) |
| `MAIN_PROJECT_TREE_WATCH_BATCH` | `main:project-tree-watch.batch` | `i` | Same, `flush()` — coalesced batch shipped to renderer |
| `MAIN_PROJECT_TREE_WATCH_IGNORED_SUMMARY` | `main:project-tree-watch.ignored-summary` | `i` | Same, `recordIgnoredEvent()` — 1 s aggregate of high-frequency watcher events dropped at the boundary (`.git`, `node_modules`, cache dirs, `.DS_Store`) |
| `MAIN_PROJECT_TREE_WATCH_SUBSCRIBE` | `main:project-tree-watch.subscribe` | `i` | `project-tree-watch-manager.ts::subscribe()` — @parcel/watcher subscribe outcome (`ok` / `failed` / `disposed-race`); primary breadcrumb for "Cmd+P never sees new files" |
| `MAIN_PROJECT_TREE_WATCH_INAPP_MUTATION` | `main:project-tree-watch.inapp-mutation` | `i` | `project-tree-watch-manager.ts::notifyMutation()` — in-app `project.createFile`/`renamePath`/`deletePath` direct-notify to the file index, bypassing the OS watcher so the app's own edits propagate even with zero native FS events |

---

## 3. Planned coverage gaps

Remaining opportunities, in priority order. Not blockers — § 2 now
covers PTY data flow end-to-end, all user-input hot paths, GUI entries
and the known background ops.

1. **Main-side IPC payload enrichment** — `MAIN_IPC_*` slices exist and
   fire, but carry minimal payload. Adding file size / repo key /
   result row count would let SQL queries join renderer-side
   `RENDERER_IPC_*` spans against main-side execution time for
   bandwidth analysis.
2. **Raw FSEvent sampling** — `MAIN_PROJECT_TREE_WATCH_EVENT` emits at
   debounce-window start and `MAIN_PROJECT_TREE_WATCH_IGNORED_SUMMARY`
   aggregates dropped high-frequency paths. If a deeper analysis
   of non-ignored FSEvent storms is ever needed, add a separate `.raw-event` span
   inside `handleRawEvent` with a 1/N sampler to keep volume bounded.
3. **Monaco dispose / mount** — restoreViewState is covered; the heavy
   Monaco model attach/detach around subpage navigation is not. Adding
   a span around `editor.dispose()` + `createEditor()` would close the
   gap on "why did this tab switch stutter?".

When moving an event from this list to § 2, add the file:line to the
corresponding `PERF_TRACE_EVENT` block comment in `perf-trace-names.ts`
so the authoritative source stays unambiguous.

---

## 4. On-disk format — NDJSON of Chrome Trace Event Format records

Each chunk file (`perf-NNNN-<ISO>-<pid>.jsonl`) is **NDJSON**: one line
per event, no surrounding `{traceEvents:[…]}` array, no trailing
commas. Each line is a standard Chrome Trace Event Format object:

```ts
{
  ph: 'X' | 'i' | 'C' | 'M' | 's' | 't' | 'f'   // slice / instant / counter / metadata / flow
  name: string                  // from PERF_TRACE_EVENT
  ts: number                    // microseconds since epoch
  pid: 1 | 2 | 3                // 1 = main, 2 = renderer, 3 = virtual Tasks process (markTask*)
  tid: number                   // main: 1 (or worker 5001+); renderer: WebContents.id; per-Task: 10000+ (main) / 20000+ (renderer)
  dur?: number                  // ph='X' only, microseconds
  cat?: string                  // category (used by recordX / markTask* / recordFlow* paths)
  id?: string                   // ph='s'/'t'/'f' flow id
  s?: 'g' | 'p' | 't'           // ph='i' scope
  args?: Record<string, unknown>
}
```

Upstream Chrome Trace Event Format spec:
https://docs.google.com/document/d/1CvAClvFfyA5R-PhYUmn5OOQtYMH4h6I0nSsKchNAySU/preview

Perfetto's ingestion into SQL tables is documented at
https://perfetto.dev/docs/analysis/trace-processor — the per-line
shape is identical to the inline-array form, so the SQL mapping does
not change:
- `ph='X'` → `slice` table (queryable by `name`, `ts`, `dur`,
  `track_id`)
- `ph='i'` → `slice` with `dur=0` (still in the same table)
- `ph='C'` → `counter` table
- `ph='s' / 't' / 'f'` → flow events on `slice`
- `ph='M'` (process_name / thread_name / process_sort_index) →
  metadata for `process` / `thread` tables

### Why NDJSON instead of the legacy `{traceEvents:[…]}` array

A SIGKILL / OOM / power loss / hard reboot leaves at most one
half-written tail line in the active chunk; everything before is
intact and parseable. The legacy array form lost the entire file when
the closing `]}` was never written, defeating the whole point of
always-on capture.

The downside — Perfetto UI and `trace_processor_shell` want the array
form — is paid only when a human opens the trace, not when the
process dies. `infra/scripts/open_trace.sh` and the T02 / T03
autotests both wrap the chunks back into `{"traceEvents":[…]}` on
demand using `node -e` (see § 5.3).

### Reading NDJSON in Node

```js
const fs = require('fs')
const lines = fs.readFileSync(chunkPath, 'utf8').split('\n')
for (const line of lines) {
  const trimmed = line.trim()
  if (!trimmed) continue
  let event
  try { event = JSON.parse(trimmed) } catch { continue /* tail-partial */ }
  // event is a Chrome Trace Event Format object
}
```

Skip any line that fails to parse — the design accepts at most ONE
unparseable line per chunk, and only at the tail (the in-flight write
at the moment of SIGKILL). The T03 rotation autotest enforces this
budget. Multiple invalid lines, or an invalid line in the middle of
a chunk, indicate corruption and should fail loudly.

### Storage layout

```
<dir>/                            ← <repoRoot>/traces/perf/ (dev) or <userData>/traces/ (prod)
├── latest.txt                    ← contains absolute path of <dir>; user tooling reads ALL chunks
├── perf-0000-…-<pid>.jsonl       ← oldest chunk; deleted first when total > 64 MB
├── perf-0001-…-<pid>.jsonl
├── …
└── perf-NNNN-…-<pid>.jsonl       ← active chunk currently being written
```

Chunk seq numbers are monotonic across the lifetime of the dir
(scanned on `initialize()` so a session resumes counting forward
across process restarts).

---

## 5. Toolchain usage

### 5.1 First-time setup

```bash
pip install perfetto                     # Only if you want SQL in Python.
# trace_processor_shell is downloaded on demand by `open_trace.sh`
# into ~/.local/share/perfetto/prebuilts/. No manual step needed.
```

### 5.2 Capture a trace

The trace store is **always-on** by default — every dev run, every
autotest, every packaged production launch writes chunks under its
trace directory automatically. To explicitly disable for a baseline
benchmark: `ONWARD_PERF_TRACE=0`.

**Dev mode** (most common):

```bash
pnpm dev
# reproduce the operation you want to observe, then Cmd+Q
# chunks land in <repoRoot>/traces/perf/perf-NNNN-<ISO>-<pid>.jsonl
```

**Packaged dev build**:

```bash
rm -rf out release && pnpm dist:dev
# the auto-launched app starts capturing; chunks at the same dev path
```

**Production**: chunks land at `<userData>/traces/`. End users need
only ZIP that directory when reporting a problem.

**From an autotest**: nothing extra to set — `ONWARD_AUTOTEST=1`
inherits the default-on capture. The legacy `ONWARD_PERF_TRACE=1`
setting still works (anything other than `=0` enables). Example
template: `test/autotest/run-trace-infra-self-check-autotest.sh`.

Artefact: `<dir>/perf-NNNN-<ISO>-<pid>.jsonl` (multiple chunks per
session); `<dir>/latest.txt` contains the absolute path of `<dir>`
itself so user-reporting tools can find every chunk in one read.

### 5.3 Open in Perfetto UI

```bash
bash infra/scripts/open_trace.sh                      # newest chunk under traces/perf/
bash infra/scripts/open_trace.sh <chunk.jsonl>        # specific NDJSON chunk
bash infra/scripts/open_trace.sh <traces/perf/>       # entire chunk dir, merged
bash infra/scripts/open_trace.sh <legacy.json>        # legacy single-file Chrome trace
```

The script auto-detects the input form. For NDJSON inputs it wraps the
chunks into a Chrome Trace Event Format envelope on the fly (a
temporary `.json` that tp_shell loads), then starts
`trace_processor_shell --httpd --http-port=9001` locally and opens the
browser to a pinned
`https://ui.perfetto.dev/v<tp_ver>-<sha>/#!/?rpc_port=9001` — the
trace never leaves localhost. To stop the HTTPD, `kill <pid>` using
the PID printed at the end of the script.

### 5.4 SQL queries

Trace processor normalises Chrome trace JSON, `.pftrace`, and the
NDJSON chunks (after `open_trace.sh` wraps them) into the same SQL
schema. The Python queries below take the wrapped envelope; pass it
the path printed by `open_trace.sh` (the temporary `.json` that
tp_shell already loaded).

Python:
```python
from perfetto.trace_processor import TraceProcessor
tp = TraceProcessor(trace='/tmp/onward-trace-merged.XXXX.json')  # printed by open_trace.sh

# Every event-loop stall, worst-first.
for row in tp.query("""
    SELECT ts, dur, name
    FROM slice
    WHERE name = 'main:event-loop-stall'
    ORDER BY dur DESC
    LIMIT 20
"""):
    print(f"{row.ts/1e9:.3f}s dur={row.dur/1e3:.1f}us")

# Count by event name (top 10).
for row in tp.query("""
    SELECT name, COUNT(*) cnt
    FROM slice
    GROUP BY name
    ORDER BY cnt DESC
    LIMIT 10
"""):
    print(row.name, row.cnt)

# Worker-side latency percentiles.
for row in tp.query("""
    SELECT
      name,
      CAST(PERCENTILE(dur, 50) AS INT) AS p50_us,
      CAST(PERCENTILE(dur, 95) AS INT) AS p95_us,
      MAX(dur) AS max_us
    FROM slice
    WHERE name LIKE 'main:%-worker-latency'
    GROUP BY name
"""):
    print(row)
```

`trace_processor_shell -q <file.sql> <wrapped.json>` — CSV output,
good for CI. Wrap the NDJSON chunks first; the script
`open_trace.sh` shows the inline wrapper logic. Example one-liner
(replace the wrap step with `bash infra/scripts/open_trace.sh` if
you also want the UI):
```bash
node -e '
  const fs = require("fs"), path = require("path");
  const dir = process.argv[1];
  const chunks = fs.readdirSync(dir).filter(f=>f.endsWith(".jsonl")).sort();
  const out = fs.createWriteStream(process.argv[2]);
  out.write("{\"traceEvents\":[\n");
  let first = true;
  for (const c of chunks) for (const line of fs.readFileSync(path.join(dir,c),"utf8").split("\n")) {
    const t = line.trim(); if (!t) continue;
    try { JSON.parse(t); } catch { continue; }
    if (!first) out.write(",\n"); out.write("  " + t); first = false;
  }
  out.write("\n]}\n"); out.end();
' traces/perf/ /tmp/wrapped.json
printf 'SELECT name, COUNT(*) FROM slice GROUP BY name;\n' > /tmp/q.sql
~/.local/share/perfetto/prebuilts/trace_processor_shell -q /tmp/q.sql /tmp/wrapped.json
```

### 5.5 T02 self-check (regression)

`test/autotest/run-trace-infra-self-check-autotest.sh` runs as part of
the full regression (`SCRIPTS` in
`test/autotest/run-full-regression.py`). It launches Onward for ~6 s,
collects every `perf-*.jsonl` chunk in `traces/perf/`, parses each
line, asserts at most one tail-partial line per chunk, asserts at
least one `main:*` slice across all chunks, and (when
`trace_processor_shell` is locally installed) wraps the chunks into a
Chrome Trace Event Format envelope and parse-verifies via tp_shell.

### 5.6 T03 rotation + SIGKILL self-check (regression)

`test/autotest/run-perf-trace-rotation-autotest.sh` exercises the
chunked-NDJSON store directly:

- **Phase A** sets `ONWARD_TRACE_ROTATION_STRESS_MB=80` and asserts
  the dev app rotates chunks at the 8 MB cap, evicts oldest at the
  64 MB total cap, and lands ≤ 64 MB on disk after stress completes.
- **Phase B** sets `ONWARD_TRACE_ROTATION_STRESS_MB=400` (so the
  stress harness runs for ~1.5 s on a typical dev box), polls until at
  least one chunk lands, then SIGKILLs the app. Asserts every flushed
  line in every chunk parses as JSON, with at most ONE trailing
  partial line per chunk (the in-flight write at the moment of
  SIGKILL — kernel `writeSync` discipline guarantees no more is
  possible).

---

## 6. Extension rules

Adding a new trace event — five steps, no step skipped:

1. Register the name in `src/utils/perf-trace-names.ts` as a new
   `PERF_TRACE_EVENT.FOO_BAR` constant. No string literals in
   business code (enforced by grep in code review).
2. Instrument at the call site:
   - main-side: `performanceTrace.record(PERF_TRACE_EVENT.FOO_BAR,
     { …args })`
     (or `performanceTrace.recordInstant / recordCounter /
     recordComplete / recordFlowStart/Step/End` for the PII-redacted
     lineage; `markTaskInput / markTaskRunning / markTaskOutput /
     markTaskExited / markTaskIdle` for terminal lifecycle on pid=3)
   - renderer-side hot path: `perfTrace(PERF_TRACE_EVENT.FOO_BAR,
     { …args })` from `src/utils/perf-trace.ts`
   - renderer-side flow correlation: `performanceTrace.recordFlow* /
     timeAsync / summarizeText` from `src/utils/performance-trace.ts`
   - worker thread: `performanceTrace.record(...)` works transparently
     — it auto-detects `!isMainThread` and forwards a
     `PerfTraceWorkerEvent` envelope through `parentPort.postMessage`.
     The worker-client must dispatch via
     `replayPerfTraceWorkerEvent` (see § 2.2).
3. If the event carries a duration, put it in the payload as
   `driftMs` / `durationMs` / `eventToPaintMs` / `elapsedMs` /
   `workerDurationMs`. `resolvePhase()` in `performance-trace.ts`
   converts to `ph='X', dur=<µs>` automatically. Otherwise it stays a
   `ph='i'` instant.
4. Update § 2 of this file — move rows from § 3 "Planned" to the
   appropriate § 2 subsection, or append a new row if it's brand new.
5. If the event represents a user-visible performance signal, add a
   corresponding runner under `test/autotest/run-<suite>-autotest.sh`
   and append it to the `SCRIPTS` list in
   `test/autotest/run-full-regression.py` so the signal is protected
   by regression.

Forbidden:

- Renaming an existing event — breaks historical SQL / UI queries.
  Add a new name instead.
- `performanceTrace.record("foo", …)` with a literal string in code —
  bypasses the registry and breaks `CLAUDE.md` Hard rule § 3.
- Writing traces outside `<repoRoot>/traces/` on dev / autotest builds
  or outside `<userData>/traces/` on production builds (`CLAUDE.md`
  Hard rule § 1).
- Reporting perf results without an `open_trace.sh` follow-up
  command (`CLAUDE.md` Hard rule § 2).
- `traceStore.writeEvent({…}, { bypassRateLimit: true })` from any
  production code path. The bypass exists exclusively for the T03
  rotation autotest's stress harness.

---

## Design research (per skill §5.0 Rule A)

Subagent research of https://perfetto.dev/docs/ conducted 2026-04-24
before the original revision. Summary and citations:

- **Format choice for Node / Electron — Chrome Trace Event Format is
  the official recommended path.** Perfetto's Track Event SDK is
  C++17-only (https://perfetto.dev/docs/instrumentation/track-events).
  For non-C++ hosts, the documented route is
  https://perfetto.dev/docs/getting-started/other-formats which
  explicitly covers Chrome trace JSON ingestion. No first-party
  JavaScript SDK exists. Onward therefore **stays on Chrome Trace
  Event Format records**, zero deps, no migration to protobufjs.
- **SQL table mapping** — confirmed that `ph='X'` events populate
  `slice.name` / `slice.ts` / `slice.dur`, `ph='C'` populates
  `counter`, `ph='M'` populates `process` / `thread`. Queries such as
  `SELECT name, dur FROM slice WHERE name LIKE 'main:%'` work without
  any conversion step. Source:
  https://perfetto.dev/docs/analysis/sql-tables.
- **Local UI workflow unchanged** — `trace_processor --httpd
  --http-port=<N>` + `https://ui.perfetto.dev/#!/?rpc_port=<N>` is
  still the pattern. We pin to `/v<tp_ver>-<sha>/` to avoid the
  "different build" banner. Source:
  https://perfetto.dev/docs/visualization/large-traces.
- **Example percentile SQL from docs** — `SELECT name,
  PERCENTILE_CONT(dur, 0.95) FROM slice GROUP BY name` is canonical
  (https://perfetto.dev/docs/analysis/sql-tables). §5.4 above adapts
  it for Onward's worker-latency family.

### 2026-05-05 revision: NDJSON on disk

The original 2026-04-24 design wrote `{"traceEvents":[…]}` arrays
directly to disk. The 2026-05-05 revision replaced that with **NDJSON
chunks** (each line is still a Chrome Trace Event Format record;
chunks land under one shared dir; `open_trace.sh` and the autotests
wrap chunks back into the array form on demand).

Three motivations:

1. **Always-on capture.** Production needs a fixed user-data path
   that's bounded in size and survives ungraceful termination so
   end-user bug reports include yesterday's trace. The legacy
   array form lost the entire file when the closing `]}` was never
   written; NDJSON loses at most one tail line.
2. **Chunk rotation accuracy.** A `WriteStream` queues writes in the
   process and only drains on event-loop ticks; in a tight emit loop
   the queue grows unbounded, `statSync` returns lagged sizes, and
   chunk-size-based eviction stops working. Switching to synchronous
   `fs.writeSync(fd, line)` makes the kernel's view authoritative —
   eviction accounting works under stress, and bytes already in the
   kernel buffer survive process death.
3. **Single-file user-report bundle.** ZIP `<userData>/traces/` and
   you have everything: every chunk, their timestamps, and
   `latest.txt`. No need to merge per-process or per-worker files.

The Chrome Trace Event Format record format is unchanged; only the
container changed. Perfetto's SQL ingestion is unaffected once the
chunks are wrapped (see § 5.3 / § 5.4).

Decision: Onward continues to emit Chrome Trace Event Format records,
now stored as NDJSON chunks. Re-open this section and re-run the
research when Perfetto publishes a JavaScript SDK or a protobuf
alternative that is declared "recommended" for non-C++ hosts.

---

## Related files

| Path | Purpose |
|---|---|
| `src/utils/perf-trace-names.ts` | Event-name registry (single source of truth) |
| `electron/main/performance-trace.ts` | Main-side canonical singleton — `record()`, recordX, recordFlow*, markTask*, worker forwarding (`WORKER_TID`, `isPerfTraceWorkerEvent`, `replayPerfTraceWorkerEvent`), event-loop / git-runtime monitors, PII-redaction |
| `electron/main/trace-store.ts` | NDJSON chunked store — append-only, 8 MB / 64 MB caps, sync `writeSync` for SIGKILL durability, per-name rate limit, autotest stress harness (`runRotationStressForAutotest`) |
| `src/utils/perf-trace.ts` | Renderer hot-path helper — `perfTrace()`, `perfTraceTask()` (IPC to main) |
| `src/utils/performance-trace.ts` | Renderer flow / time / summarize helper (PII-safe path) |
| `src/utils/perf-monitor.ts` | Renderer 1 s snapshot aggregator |
| `infra/scripts/open_trace.sh` | One-liner trace opener; auto-wraps NDJSON chunks for tp_shell |
| `test/autotest/run-trace-infra-self-check-autotest.sh` | T02 — trace baseline self-check (NDJSON validation) |
| `test/autotest/run-perf-trace-rotation-autotest.sh` | T03 — chunk rotation + 64 MB budget + SIGKILL resilience |
| `electron/main/diagnostic-bundle.ts` | ZIP packager for the FeedbackModal "Generate diagnostic bundle" button. The IPC handler calls `traceStore.rotate()` first to seal the active chunk, then bundles via yazl `addBuffer` (race-free against the live trace store). Closes the loop with a yauzl-based self-verification that confirms every entry parses + at least one `main:*` event was captured. Unit tests in `test/unittest/diagnostic-bundle.test.mts` (DB-01..07) |
| `test/autotest/run-full-regression.py` | Regression orchestrator + canonical runner list |
| `docs/debug-env-variables.md` | `ONWARD_PERF_TRACE`, `ONWARD_REPO_ROOT`, `ONWARD_PERF_TRACE_CAPTURE_CONTENT`, `ONWARD_TRACE_ROTATION_STRESS_MB` flags |
| `docs/Off-Renderer Threaded Design - Electron Refactor.md` | Architectural constraint for any perf change |
| `scripts/migrate-perf-trace-literals.mjs` | One-shot helper promoting literals to registry constants (kept for audit) |
