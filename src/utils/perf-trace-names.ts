/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

import { CLICK_PHASE_EVENT_NAMES } from './click-phase-event-names.ts'

/**
 * Single source of truth for perf-trace event names.
 *
 * CLAUDE.md Hard rule § 3 requires every trace event to register its
 * name here before instrumenting. The writer side (main or renderer)
 * imports these constants instead of writing string literals so the
 * name set can be grepped / refactored centrally and the Perfetto SQL
 * queries in `infra/trace.md` have a stable vocabulary.
 *
 * The full trace system index — including which events are emitted
 * today, which are planned, and how to extend — lives in
 * `infra/trace.md`. Keep both in sync when adding events.
 *
 * Naming convention:
 *   main:<dotted.subject>        — main process
 *   renderer:<dotted.subject>    — renderer process
 *   worker.<kind>:<dotted.subject> — Node Worker thread or utility proc
 *
 * Values are the literal strings written into Chrome trace JSON `name`
 * fields. Downstream tools (Perfetto UI, trace_processor_shell SQL)
 * match on these. Do NOT change an existing string — append new
 * constants instead.
 */
export const PERF_TRACE_EVENT = {
  // ───────── Main process — lifecycle ─────────
  MAIN_TRACE_START: 'main:trace-start',
  MAIN_TRACE_STOP: 'main:trace-stop',
  MAIN_APP_BEFORE_QUIT: 'main:app.before-quit',
  MAIN_APP_WILL_QUIT: 'main:app.will-quit',

  // ───────── Main process — event-loop + stall monitor ─────────
  MAIN_EVENT_LOOP_STALL: 'main:event-loop-stall',
  MAIN_EVENT_LOOP_METRICS_RESET: 'main:event-loop-metrics-reset',

  // ───────── Main process — Git subsystem ─────────
  MAIN_GIT_RUNTIME_SUMMARY: 'main:git-runtime-summary',
  MAIN_GIT_RUNTIME_SUMMARY_ERROR: 'main:git-runtime-summary-error',
  MAIN_GITWATCH_SUMMARY: 'main:gitwatch-summary',

  // ───────── Main process — renderer process lifecycle ─────────
  MAIN_RENDERER_PROCESS_GONE: 'main:renderer-process-gone',
  MAIN_RENDERER_UNRESPONSIVE: 'main:renderer-unresponsive',

  // ───────── Main process — terminal IPC summary ─────────
  MAIN_TERMINAL_DATA_IPC_SUMMARY: 'main:terminal-data-ipc-summary',

  // ───────── Main process — AppState persistence ─────────
  MAIN_APP_STATE_SAVE: 'main:app-state-save',
  MAIN_APP_STATE_SAVE_ERROR: 'main:app-state-save-error',

  // ───────── Main process — IPC hot paths (latency ph='X') ─────────
  // Newly instrumented; see `electron/main/ipc-handlers.ts`.
  MAIN_IPC_PROJECT_READ_FILE: 'main:ipc.project.read-file',
  MAIN_IPC_PROJECT_READ_FILE_CHUNK: 'main:ipc.project.read-file-chunk',
  MAIN_IPC_PROJECT_SAVE_FILE: 'main:ipc.project.save-file',
  MAIN_IPC_GIT_GET_DIFF: 'main:ipc.git.get-diff',
  MAIN_IPC_GIT_GET_FILE_CONTENT: 'main:ipc.git.get-file-content',
  MAIN_IPC_GIT_GET_HISTORY: 'main:ipc.git.get-history',
  MAIN_IPC_TERMINAL_SPAWN: 'main:ipc.terminal.spawn',

  // ───────── Main process — PTY child process lifecycle ─────────
  // Covers every node-pty spawn, so terminal-startup cost and abnormal
  // exits are visible per terminalId instead of only the 1s aggregate.
  MAIN_PTY_SPAWN: 'main:pty.spawn',
  MAIN_PTY_EXIT: 'main:pty.exit',
  MAIN_PTY_KILL: 'main:pty.kill',

  // ───────── Main process — Git CLI per-exec latency ─────────
  // One ph='X' slice per execFile(git ...) call; tagged with the first
  // arg as `subcommand` so Perfetto SQL can group by `status`/`diff`/etc.
  MAIN_GIT_EXEC: 'main:git.exec',

  // ───────── Main process — non-git child-process exec ─────────
  // `git-utils.ts::execFileAsync` is also used for adjacent probes
  // (lsof for terminal cwd, future helpers). Routing those to a
  // distinct event name keeps `main:git.exec` honest — so percentile
  // queries on git pressure do not accidentally include lsof spawns.
  MAIN_PROC_EXEC: 'main:proc.exec',

  // ───────── Main process — updater/installer child-process spawns ─────────
  // Downloads/installers that Onward fires off via child_process.
  MAIN_UPDATER_SPAWN: 'main:updater.spawn',

  // ───────── Workers — ripgrep process lifecycle (inside rg worker) ─────────
  // Runs on the ripgrep Node Worker Thread; forwarded to the main
  // trace file through parentPort -> performanceTrace.
  WORKER_RIPGREP_PROCESS_SPAWN: 'worker.ripgrep:process.spawn',
  WORKER_RIPGREP_PROCESS_EXIT: 'worker.ripgrep:process.exit',

  // ───────── Workers — markdown preview (renderer Web Worker) ─────────
  // Emitted by the renderer-side client when a postMessage response
  // returns; carries the worker-measured parse+highlight+katex duration.
  WORKER_MARKDOWN_RENDER_COMPLETE: 'worker.markdown:render-complete',

  // ───────── PTY data flow — per-Task tid lane ─────────
  // Every event in this block is emitted on the per-terminal virtual
  // tid managed by `performance-trace::assignTaskTid`. Main-side task
  // lanes are `pid=1 tid>=10000`; renderer-side are `pid=2 tid>=20000`.
  // The first emission for a terminalId auto-writes a thread_name
  // metadata packet `task-<shortId>` so Perfetto UI shows each Task
  // as its own row.
  MAIN_TERMINAL_DATA_IPC_SEND: 'main:terminal-data.ipc-send',
  MAIN_PTY_WRITE: 'main:pty.write',
  RENDERER_TERMINAL_DATA_IPC_RECV: 'renderer:terminal-data.ipc-recv',
  RENDERER_TERMINAL_DATA_FAST_PATH: 'renderer:terminal-data.fast-path',
  RENDERER_TERMINAL_DATA_SCHEDULER_ENQUEUE: 'renderer:terminal-data.scheduler-enqueue',
  RENDERER_TERMINAL_DATA_SCHEDULER_FLUSH: 'renderer:terminal-data.scheduler-flush',
  RENDERER_TERMINAL_DATA_XTERM_WRITE: 'renderer:terminal-data.xterm-write',

  // ───────── GUI entries (new) ─────────
  RENDERER_TAB_CREATE: 'renderer:tab.create',
  RENDERER_TAB_SWITCH: 'renderer:tab.switch',
  RENDERER_TERMINAL_SPLIT_ADD: 'renderer:terminal.split-add',
  RENDERER_GITDIFF_OPEN: 'renderer:gitdiff.open',
  RENDERER_GITHISTORY_OPEN: 'renderer:githistory.open',
  RENDERER_SETTINGS_OPEN: 'renderer:settings.open',
  RENDERER_CHANGELOG_OPEN: 'renderer:changelog.open',

  // ───────── Background — project file index + tree watch ─────────
  MAIN_FILE_INDEX_BUILD: 'main:file-index.build',
  MAIN_FILE_INDEX_UPDATE: 'main:file-index.update',
  MAIN_PROJECT_TREE_WATCH_EVENT: 'main:project-tree-watch.event',
  MAIN_PROJECT_TREE_WATCH_BATCH: 'main:project-tree-watch.batch',
  MAIN_PROJECT_TREE_WATCH_IGNORED_SUMMARY: 'main:project-tree-watch.ignored-summary',
  // @parcel/watcher subscribe outcome (lifecycle entry + fallback branch). Off the
  // hot path, but the primary breadcrumb for "Cmd+P never sees new files": shows
  // whether the watcher subscribed (ok), failed to (failed), or was torn down by a
  // stop() that raced subscribe() resolving (disposed-race).
  MAIN_PROJECT_TREE_WATCH_SUBSCRIBE: 'main:project-tree-watch.subscribe',
  // In-app mutation direct-notify (project.createFile/renamePath/deletePath →
  // file index), bypassing the OS watcher so the app's own edits propagate even
  // when the platform delivers zero native FS events. Breadcrumb for "Cmd+P
  // missed a file I just created in-app".
  MAIN_PROJECT_TREE_WATCH_INAPP_MUTATION: 'main:project-tree-watch.inapp-mutation',

  // ───────── Workers — app-state ─────────
  WORKER_APP_STATE_LATENCY: 'main:app-state-worker-latency',
  WORKER_APP_STATE_TIMEOUT: 'main:app-state-worker-timeout',
  WORKER_APP_STATE_ERROR: 'main:app-state-worker-error',
  WORKER_APP_STATE_EXIT: 'main:app-state-worker-exit',

  // ───────── Workers — git-ipc ─────────
  WORKER_GIT_IPC_LATENCY: 'main:git-ipc-worker-latency',
  WORKER_GIT_IPC_TIMEOUT: 'main:git-ipc-worker-timeout',
  WORKER_GIT_IPC_ERROR: 'main:git-ipc-worker-error',
  WORKER_GIT_IPC_EXIT: 'main:git-ipc-worker-exit',

  // ───────── Workers — git-status ─────────
  WORKER_GIT_STATUS_LATENCY: 'main:git-status-worker-latency',
  WORKER_GIT_STATUS_TIMEOUT: 'main:git-status-worker-timeout',
  WORKER_GIT_STATUS_ERROR: 'main:git-status-worker-error',
  WORKER_GIT_STATUS_EXIT: 'main:git-status-worker-exit',

  // ───────── Workers — project-fs ─────────
  WORKER_PROJECT_FS_LATENCY: 'main:project-fs-worker-latency',
  WORKER_PROJECT_FS_TIMEOUT: 'main:project-fs-worker-timeout',
  WORKER_PROJECT_FS_ERROR: 'main:project-fs-worker-error',
  WORKER_PROJECT_FS_EXIT: 'main:project-fs-worker-exit',

  // ───────── Workers — sqlite ─────────
  WORKER_SQLITE_LATENCY: 'main:sqlite-worker-latency',
  WORKER_SQLITE_TIMEOUT: 'main:sqlite-worker-timeout',
  WORKER_SQLITE_ERROR: 'main:sqlite-worker-error',
  WORKER_SQLITE_EXIT: 'main:sqlite-worker-exit',

  // ───────── Workers — ripgrep (global search) ─────────
  WORKER_RIPGREP_LATENCY: 'main:ripgrep-worker-latency',
  WORKER_RIPGREP_TIMEOUT: 'main:ripgrep-worker-timeout',
  WORKER_RIPGREP_ERROR: 'main:ripgrep-worker-error',
  WORKER_RIPGREP_EXIT: 'main:ripgrep-worker-exit',
  WORKER_RIPGREP_BINARY_MISSING: 'main:ripgrep-binary-missing',
  WORKER_RIPGREP_PLATFORM_RESOLVE_FALLBACK: 'main:ripgrep-platform-resolve-fallback',
  WORKER_RIPGREP_START_ERROR: 'main:ripgrep-worker-start-error',

  // ───────── Main — app shutdown ─────────
  MAIN_APP_QUIT_WINDOWS_DESTROYED: 'main:app.quit.windows-destroyed',

  // ───────── Renderer — lifecycle ─────────
  RENDERER_TRACE_START: 'renderer:trace-start',

  // ───────── Renderer — perf observers (existing) ─────────
  RENDERER_EVENT_LOOP_STALL: 'renderer:event-loop-stall',
  RENDERER_FRAME_STALL: 'renderer:frame-stall',
  RENDERER_LONGTASK: 'renderer:longtask',
  RENDERER_PROMPT_INPUT_PAINT: 'renderer:prompt-input-paint',
  RENDERER_PERF_SNAPSHOT: 'renderer:perf-snapshot',
  RENDERER_APPSTATE_SUMMARY: 'renderer:appstate-summary',

  // ───────── Renderer — Web events (window level) ─────────
  // Coverage per user request: "Web events + user input response".
  RENDERER_WINDOW_VISIBILITY_CHANGE: 'renderer:window.visibility-change',
  RENDERER_WINDOW_FOCUS: 'renderer:window.focus',
  RENDERER_WINDOW_BLUR: 'renderer:window.blur',
  RENDERER_WINDOW_PAGEHIDE: 'renderer:window.pagehide',

  // ───────── Renderer — user input: prompt ─────────
  RENDERER_PROMPT_EDITOR_SUBMIT: 'renderer:prompt.editor.submit',
  RENDERER_PROMPT_EDITOR_CANCEL: 'renderer:prompt.editor.cancel-edit',
  RENDERER_PROMPT_SENDER_DISPATCH: 'renderer:prompt.sender.dispatch',
  // Right-click on the prompt input textarea opens a custom context menu
  // (cut/copy/paste/paste-plain, import pinned, save-as-pinned, insert
  // cwd/branch/task title, history, format tools, send-to-task, clear).
  // Instant marker (ph='i') with payload counts so usage frequency and
  // populated submenus are observable without leaking content.
  RENDERER_PROMPT_EDITOR_CTX_MENU_OPEN: 'renderer:prompt.editor.ctx-menu-open',
  // Measures the renderer-side layout pass that keeps Send-to-Task and
  // Import Pin submenus inside the viewport. Args contain only geometry
  // and clamp metadata; no prompt or pinned-prompt content is recorded.
  RENDERER_PROMPT_EDITOR_CTX_SUBMENU_LAYOUT: 'renderer:prompt.editor.ctx-submenu-layout',
  // User changed the global Prompt input mode preference from the title-row
  // selector. Args carry the target mode and tab count only.
  RENDERER_PROMPT_INPUT_MODE_CHANGE: 'renderer:prompt.input-mode-change',
  // Mousedown past EOL/EOF physically pads the textarea value with spaces
  // and newlines, then setSelectionRange to the target. Args carry a
  // breakdown of the input → paint pipeline:
  //   measureMs / handlerMs — synchronous work (cell metrics + value mutate)
  //   caretMs / paintMs / durationMs — outer rAF (caret) + inner rAF (paint)
  // resolvePhase() promotes events with `durationMs` to ph='X' span, so
  // slice.dur SQL queries work directly. row/col/padded retained for
  // outlier hunting (wild clicks generating KB-scale padding).
  RENDERER_PROMPT_EDITOR_VIRTUAL_CARET: 'renderer:prompt.editor.virtual-caret',

  // ───────── Renderer — user input: terminal ─────────
  RENDERER_TERMINAL_FOCUS_CHANGE: 'renderer:terminal.focus-change',
  // Right-click on a Task terminal content area opens the custom terminal
  // context menu. Args carry only selection and pinned-prompt counts.
  RENDERER_TERMINAL_CTX_MENU_OPEN: 'renderer:terminal.ctx-menu-open',
  // Selecting a pinned Prompt from the terminal context menu dispatches it
  // to the right-clicked Task. Args carry payload byte count, never content.
  RENDERER_TERMINAL_CTX_PINNED_PROMPT_SEND: 'renderer:terminal.ctx-pinned-prompt-send',
  RENDERER_TERMINAL_SEND_INPUT: 'renderer:terminal.send-input',

  // ───────── Renderer — user input: project editor ─────────
  RENDERER_PROJECT_FILE_OPEN: 'renderer:project.file-open',
  RENDERER_PROJECT_HTML_PREVIEW_RELOAD: 'renderer:project.html-preview-reload',
  RENDERER_PROJECT_HTML_PREVIEW_SEARCH: 'renderer:project.html-preview-search',
  RENDERER_PROJECT_HTML_PREVIEW_ZOOM: 'renderer:project.html-preview-zoom',
  RENDERER_PROJECT_HTML_PREVIEW_NAV: 'renderer:project.html-preview-nav',
  RENDERER_PROJECT_FILE_BROWSER_COLLAPSE: 'renderer:project.file-browser-collapse',
  RENDERER_PROJECT_EDITOR_REOPEN_RESTORE: 'renderer:project.editor-reopen-restore',
  RENDERER_PROJECT_SUBPAGE_NAVIGATE: 'renderer:project.subpage-navigate',
  RENDERER_PROJECT_SEARCH_GLOBAL: 'renderer:project.search.global',

  // ───────── Open Browser (address-bar in-app browser) ─────────
  // Renderer-side BrowserPanel toolbar actions + view lifecycle.
  RENDERER_BROWSER_ZOOM: 'renderer:browser.zoom',
  RENDERER_BROWSER_CACHE_HIDE: 'renderer:browser.cache-hide',
  RENDERER_BROWSER_REATTACH: 'renderer:browser.reattach',
  RENDERER_BROWSER_DESTROY: 'renderer:browser.destroy',
  RENDERER_BROWSER_AUTO_REFRESH_TOGGLE: 'renderer:browser.auto-refresh-toggle',
  RENDERER_BROWSER_AUTO_REFRESH_TICK: 'renderer:browser.auto-refresh-tick',
  // Main-process breadcrumbs for the WebContentsView backend.
  MAIN_BROWSER_ZOOM_CHANGED: 'main:browser.zoom-changed',
  MAIN_BROWSER_LOCAL_FILE_RESOLVE: 'main:browser.local-file-resolve',
  MAIN_BROWSER_URL_REJECTED: 'main:browser.url-rejected',

  // ───────── Renderer — IPC bridge latency (end-to-end) ─────────
  // Wrap `window.electronAPI.*` hot-path calls with a `ph:'X'` span so
  // renderer→main→renderer round trips show up on the renderer thread
  // track alongside the input events that triggered them.
  RENDERER_IPC_PROJECT_READ_FILE: 'renderer:ipc.project.read-file',
  RENDERER_IPC_PROJECT_READ_FILE_CHUNK: 'renderer:ipc.project.read-file-chunk',
  RENDERER_IPC_GIT_GET_DIFF: 'renderer:ipc.git.get-diff',
  RENDERER_IPC_TERMINAL_WRITE: 'renderer:ipc.terminal.write',

  // ───────── Renderer — async rendering hot paths ─────────
  RENDERER_MARKDOWN_RENDER: 'renderer:markdown.render',
  RENDERER_MARKDOWN_SANITIZE: 'renderer:markdown.dompurify-sanitize',
  RENDERER_MARKDOWN_MERMAID: 'renderer:markdown.mermaid-render',
  // Instant event emitted when preview restore reaches phase:idle. Payload:
  // cause, hadWork (whether any markdown/worker/mermaid signal was pending
  // during this restore cycle), durationMs.
  RENDERER_MARKDOWN_PREVIEW_REVEAL: 'renderer:markdown.preview-reveal',
  RENDERER_MARKDOWN_SESSION_CACHE_CAPTURE: 'renderer:markdown.session-cache-capture',
  // ph='i'. Emitted by the worker-owner-switch effect when, on a
  // shortcut-reopen via the retained-view fast path, the markdown HTML would
  // otherwise be blanked + re-rendered, but the persistent session cache holds
  // a CONTENT-IDENTICAL render for the reopened file. Instead of clearing the
  // HTML and waiting on the EDR-throttled markdown worker (which can land after
  // the 20s reopen-restore budget), the rendered HTML + scroll are restored
  // SYNCHRONOUSLY from the cache. The breadcrumb lets a future "reopened preview
  // is blank" bug report show whether this synchronous restore fired. Payload =
  // { filePath (basename), htmlLength }.
  RENDERER_PROJECT_EDITOR_MD_REOPEN_CACHE_RESTORED: 'renderer:project-editor.md-reopen-cache-restored',
  // Retained-view shortcut reopen took the ZERO-FLASH path: the rendered HTML
  // (and the already-rendered mermaid DOM) was still on screen, so the restore
  // re-armed the pending scroll restore + bumped the render nonce WITHOUT calling
  // applyMarkdownSessionCacheHit / beginPreviewRestore, keeping previewRestorePhase
  // at 'idle' for the whole reopen (no waiting-html opacity fade). This breadcrumb
  // lets a future "reopen still flashes" bug report show whether the zero-flash
  // branch was reached or whether the heavier re-apply path ran instead. Payload =
  // { filePath (basename), htmlLength }.
  RENDERER_PROJECT_EDITOR_MD_REOPEN_PRESERVED_NO_FLASH: 'renderer:project-editor.md-reopen-preserved-no-flash',
  // Retained-view shortcut reopen FELL THROUGH the zero-flash path because the
  // live `.project-editor-preview-content` DOM node was actually empty even
  // though `markdownRenderedHtmlRef.current` read truthy (a stale ref on the
  // very first reopen: the state->ref sync effect had not yet propagated the
  // deactivate-branch blank). The restore re-applied the content-identical
  // session cache instead, repopulating the ref + DOM. This breadcrumb lets a
  // future "blank preview on the FIRST reopen is back" bug report show whether
  // the DOM-empty fall-through fired (the re-apply ran) versus the zero-flash
  // branch trusting a stale ref. Payload = { filePath (basename) }.
  RENDERER_PROJECT_EDITOR_MD_REOPEN_DOM_EMPTY_REAPPLY: 'renderer:project-editor.md-reopen-dom-empty-reapply',
  // The preview-reveal WATCHDOG force-finalized a reveal that was stuck in the
  // 'waiting-html' phase even though the render is fully settled (renderAllowed +
  // HTML present + no pending work). This happens when a deep-link "Jump to
  // Editor" triggers a root reload whose unmount cleanup (cancelPreviewRevealFrames)
  // cleared the queued reveal AFTER it was queued, and no React dep changed to
  // re-run the settled-reveal effect — leaving the preview permanently faded out
  // (opacity 0). The watchdog reveals it so the preview is never stranded
  // (CDP-10 deep-link jump on EDR-throttled Windows). A burst of these means the
  // reveal-cancellation race is firing often and the root cause should be fixed.
  // Payload = { filePath (basename), htmlLength, waitedMs }.
  RENDERER_PROJECT_EDITOR_MD_REVEAL_WATCHDOG_FORCED: 'renderer:project-editor.md-reveal-watchdog-forced',
  // The render-recovery watchdog re-issued a markdown worker render because the
  // preview should show content (render gate on, preview pane open, file content
  // present) but the rendered-HTML buffer was stuck EMPTY with no render in
  // flight. This happens on a cold reopen whose worker render was issued but its
  // result was discarded by the reopen churn (a worker-deactivate / owner-switch
  // bumped markdownApplyRequestIdRef between request and response), after which
  // no React dep changed to re-send — leaving the preview permanently blank
  // (PMSR-09/10/11 cold first reopen on EDR-throttled Windows). The watchdog only
  // fires when no render is in flight, so it never duplicates an in-progress
  // render. A burst means the discard race is firing often. Payload =
  // { filePath (basename), contentLen }.
  RENDERER_PROJECT_EDITOR_MD_RENDER_RECOVERY_FORCED: 'renderer:project-editor.md-render-recovery-forced',
  // A markdown REOPEN (hadViewState) with a saved preview scroll above the
  // tolerance started the bounded preview-scroll-reconcile loop. The loop corrects
  // a LATE root-reload / preview re-mount that strands the preview at the top after
  // the restore, nudging it back to the saved section (PMSR-10/11). This is the
  // off-hot-path DECISION breadcrumb (emitted once when the reconcile is triggered,
  // NOT per reconcile tick — the per-tick detail stays on the debug-only mdpTrace).
  // A user "reopened preview jumps to / sticks at the top" report whose trace LACKS
  // this event means the reconcile guard never fired (saved scroll within tolerance
  // or the reopen path was not taken). Payload = { reconcileTarget (saved scrollTop) }.
  RENDERER_PROJECT_EDITOR_MD_PREVIEW_SCROLL_RECONCILE: 'renderer:project-editor.md-preview-scroll-reconcile',
  // openFile self-healed a stale `isMarkdownPreviewOpen` snapshot for an explicit
  // markdown open (user/debug/restore). After a project-editor reopen the openFile
  // call could latch a racing snapshot where the preview-open flag was still
  // false, leaving the reopened markdown file with the preview never enabled and
  // the render never started. This breadcrumb lets a future "reopened markdown
  // file shows no preview" bug report show whether the self-heal fired. Payload =
  // { filePath (basename), source }.
  RENDERER_PROJECT_EDITOR_MD_PREVIEW_OPEN_SELF_HEALED: 'renderer:project-editor.md-preview-open-self-healed',
  // openFile re-enabled the markdown render gate on its already-active-file
  // early-return. A deep-link "Jump to Editor" from Git Diff re-opens the file
  // that is already the active editor file; on the way into Diff
  // `resetActiveFileState` cleared `isMarkdownRenderEnabled` while preserving the
  // rendered HTML, and the early-return never re-enabled it, leaving the preview
  // pane reporting `isMarkdownPreviewVisible() === false`. This breadcrumb lets a
  // future "preview dead after Diff jump-to-editor" bug report show whether the
  // render gate was re-enabled. Payload = { filePath (basename), source }.
  RENDERER_PROJECT_EDITOR_MD_RENDER_GATE_REENABLED: 'renderer:project-editor.md-render-gate-reenabled',
  RENDERER_MONACO_VIEWSTATE_RESTORE: 'renderer:monaco.viewstate-restore',
  RENDERER_XTERM_WEBGL_INIT: 'renderer:xterm.webgl-context-init',

  // ───────── Renderer — terminal renderer surface lifecycle ─────────
  // Tracks the WebGL renderer lifecycle behind the "blank Task after
  // desktop swipe" failure mode. The VS Code-aligned path lets xterm's
  // WebglAddon report unrecovered context loss, then disposes WebGL so
  // xterm's DOM renderer can keep the live terminal buffer visible.
  RENDERER_XTERM_RENDERER_CONTEXT_LOST: 'renderer:xterm.renderer.context-lost',
  RENDERER_XTERM_RENDERER_CONTEXT_RESTORED: 'renderer:xterm.renderer.context-restored',
  RENDERER_XTERM_RENDERER_RESTORE_DEFERRED: 'renderer:xterm.renderer.restore-deferred',
  RENDERER_XTERM_RENDERER_REFRESH_AFTER_RESTORE: 'renderer:xterm.renderer.refresh-after-restore',
  RENDERER_XTERM_RENDERER_CONTEXT_LOSS_FALLBACK: 'renderer:xterm.renderer.context-loss-fallback',
  RENDERER_XTERM_RENDERER_ENSURE_WEBGL: 'renderer:xterm.renderer.ensure-webgl',
  RENDERER_XTERM_RENDERER_DISPOSE_WEBGL: 'renderer:xterm.renderer.dispose-webgl',
  RENDERER_XTERM_RENDERER_FAILURE: 'renderer:xterm.renderer.failure',

  // ───────── Main process — Git Diff cache & freshness ─────────
  // Bug 1: parent-repo file list erroneously surfaces submodule entries when
  // only the submodule's internal worktree (m/u flags) is dirty — the parent
  // index has nothing to show. The filter event records each submodule entry
  // decision at parse time so SQL can verify "kept iff c=C" against a trace.
  // Bug 2: the 3-second request cache returned stale data after FS mutations
  // because invalidation was time-based. The GitStateMirror authority now
  // emits the FS-driven freshness signal; this layer records cache-hit /
  // cache-invalidate plus subpage.freshness-check on Diff/Editor/History entry.
  MAIN_GIT_DIFF_CACHE_HIT: 'main:git.diff.cache-hit',
  MAIN_GIT_DIFF_CACHE_INVALIDATE: 'main:git.diff.cache-invalidate',
  // Retired: kept so old trace readers can parse historical captures.
  MAIN_GIT_DIFF_FS_WATCH_EVENT: 'main:git.diff.fs-watch-event',
  MAIN_GIT_DIFF_SUBMODULE_FILTER: 'main:git.diff.submodule-filter',
  MAIN_GIT_DIFF_CONTENT_CACHE_HIT: 'main:git.diff.content-cache.hit',
  MAIN_GIT_DIFF_CONTENT_CACHE_MISS: 'main:git.diff.content-cache.miss',
  MAIN_GIT_DIFF_CONTENT_CACHE_SKIP_STALE_GENERATION: 'main:git.diff.content-cache.skip-stale-generation',
  MAIN_GIT_DIFF_CONTENT_CACHE_INVALIDATE_PROJECT: 'main:git.diff.content-cache.invalidate-project',
  MAIN_GIT_DIFF_CONTENT_CACHE_INVALIDATE_LRU: 'main:git.diff.content-cache.invalidate-lru',
  // Read-path stat revalidation dropped a content-cache HIT because the working-tree
  // file's stat token no longer matched the token captured at store time (the file
  // changed since it was cached, yet no watcher/mirror invalidation fired for it).
  // This is the freshness backstop that makes the FS-watcher a latency optimization
  // rather than the sole correctness authority for stale-diff-after-edit. ph='i'.
  MAIN_GIT_DIFF_CONTENT_CACHE_STAT_REVALIDATE_STALE: 'main:git.diff.content-cache.stat-revalidate-stale',
  MAIN_GIT_DIFF_PRECOMPUTE_SCHEDULE: 'main:git.diff.precompute.schedule',
  MAIN_GIT_DIFF_PRECOMPUTE_SKIP_TOO_LARGE: 'main:git.diff.precompute.skip-too-large',
  RENDERER_SUBPAGE_FRESHNESS_CHECK: 'renderer:subpage.freshness-check',

  // ───────── Main — repo prewarm coordinator (prewarm-on-cwd-switch, decision ⑥/⑦) ─────────
  // Fired when TerminalGitInfoBridge resolves a NEW cwd and the prewarm
  // coordinator front-runs the Git Diff + History work the UI would otherwise
  // pay on open. `triggered` = a prewarm started (lifecycle entry; carries the
  // dedup reason attach/cwd-change/renderer-fallback); `skipped-dedup` = the cwd
  // was already prewarmed this session (lastPrewarmedCwds Set hit — the branch a
  // "why didn't my repo re-warm?" report needs); `history-done` = the History
  // list + commit-diff prewarm finished (duration-bearing, ph='X'). All
  // off-hot-path → diagnostic coverage, not perf.
  MAIN_GIT_PREWARM_REPO_TRIGGERED: 'main:git.prewarm.repo-triggered',
  MAIN_GIT_PREWARM_REPO_SKIPPED_DEDUP: 'main:git.prewarm.repo-skipped-dedup',
  MAIN_GIT_PREWARM_HISTORY_DONE: 'main:git.prewarm.history-done',
  // A merge commit was primed into the L9 commit-diff cache with its FIRST-PARENT
  // diff (`git log --diff-merges=first-parent`). Without that flag git omits merge
  // diffs entirely, so the prewarm primed an EMPTY file list and the on-click cache
  // HIT showed zero files for every merge commit (a real Git History bug). This
  // breadcrumb lets a future "merge file list empty again" report show whether the
  // prewarm actually primed a non-empty merge result. Off-hot-path → diagnostic.
  MAIN_GIT_PREWARM_HISTORY_MERGE_PRIMED: 'main:git.prewarm.history-merge-primed',
  // A cwd was abandoned (no live terminal) past the grace window, so its wasted
  // background content-precompute burst was cancelled to free the EDR git-spawn
  // budget for the cwd the user actually landed on. Off-hot-path → diagnostic.
  MAIN_GIT_PREWARM_DETACH_CANCELLED: 'main:git.prewarm.detach-cancelled',

  // ───────── Main — History list (L8) + commit-diff (L9) request caches ─────────
  // L8 list cache keyed `repoRoot::branchOid::limit::skip` (invalidated when a
  // new commit moves branchOid). L9 commit-diff cache keyed `repoRoot::commitOid`
  // (immutable — a commit's diff never changes, so it only evicts on capacity).
  // hit/miss let a user trace show whether History open was a cache hit or paid
  // the multi-spawn `git log` / `git show` on EDR-throttled hosts.
  MAIN_GIT_HISTORY_LIST_CACHE_HIT: 'main:git.history.list-cache.hit',
  MAIN_GIT_HISTORY_LIST_CACHE_MISS: 'main:git.history.list-cache.miss',
  MAIN_GIT_HISTORY_COMMIT_DIFF_CACHE_HIT: 'main:git.history.commit-diff-cache.hit',
  MAIN_GIT_HISTORY_COMMIT_DIFF_CACHE_MISS: 'main:git.history.commit-diff-cache.miss',

  // ───────── Main/worker — long-running `git cat-file --batch` (Phase A) ─────────
  // Diagnostic breadcrumbs for the file-content read path. The batch eliminates
  // the per-read spawn (EDR tax) on win32 + darwin; these events let a
  // user-attached trace answer "was the fast path used, or did it fall back?":
  //   - spawned: a repo's long-running process was created (lifecycle entry; the
  //     one-time per-repo spawn cost lives here).
  //   - process-exited: the process died/exited (lifecycle exit; next read respawns).
  //   - fallback: a read could not use the batch and degraded to per-call
  //     `cat-file -s` + `cat-file blob` (recovery branch — the silent-perf-regression
  //     signal a bug report needs). All ph='i' (instantaneous).
  MAIN_GIT_CATFILE_BATCH_SPAWNED: 'main:git.cat-file-batch.spawned',
  MAIN_GIT_CATFILE_BATCH_PROCESS_EXITED: 'main:git.cat-file-batch.process-exited',
  MAIN_GIT_CATFILE_BATCH_FALLBACK: 'main:git.cat-file-batch.fallback',
  // INDEX ref (`:<path>`, the staged/index side of a changed file) served from
  // the long-running batch instead of the old per-call `cat-file -s` +
  // `cat-file blob` spawn pair (the single biggest reducible EDR cost — 2
  // spawns/file eliminated). Tagged `action`:
  //   - 'served'              — an index ref answered over the batch pipe (hot
  //                             per-file read; the spawn-pair this removed).
  //   - 'respawn-stale-index' — `.git/index` mutated since the batch spawned, so
  //                             the process was disposed + respawned to snapshot
  //                             the CURRENT index (the GDS-22/33 freshness gate
  //                             firing). A burst means heavy stage/unstage churn.
  // ph='i' (instantaneous). The freshness decision is unit-locked by
  // git-cat-file-index-freshness.test.mts.
  MAIN_GIT_CATFILE_INDEX_REF_BATCHED: 'main:git.cat-file.index-ref-batched',

  // ───────── Main process — Git Repository Snapshot Service ─────────
  // Lesson #13 follow-up: the read-side surface (Diff / History / Editor
  // scope / Quick Open) had three independent code paths that each carried
  // partial submodule semantics — `parseStatusPorcelainV2Z`,
  // `collectSubmodulesFromGitmodules`, and `filterMeaninglessSubmoduleEntries`.
  // The snapshot service is the canonical place where ".gitmodules + git
  // submodule status + getGitRepoMeta validation" converge into one
  // immutable structural answer. Every consumer that needs "what are the
  // submodules of this cwd?" goes through this service.
  //
  // Phase 1 (this round) migrates loadGitDiff. Later phases will migrate
  // History, Editor scope + Quick Open. The trace events let us observe
  // cache health (capture vs hit) and detect stale-cache regressions long
  // before they become user-visible bugs.
  MAIN_GIT_SNAPSHOT_CAPTURE: 'main:git.snapshot.capture',
  MAIN_GIT_SNAPSHOT_CACHE_HIT: 'main:git.snapshot.cache-hit',
  MAIN_GIT_SNAPSHOT_INVALIDATE: 'main:git.snapshot.invalidate',
  // ph='i'. Emitted by captureGitRepositorySnapshot when the index's gitlink
  // set (`git ls-files -s`, mode 160000) yields nested repos the parent tracks
  // but never declared in `.gitmodules` — the no-`.gitmodules` gitlink class
  // that Diff / History previously could not see (winWatchRTOS-Build symptom).
  // payload = { cwd, repoRoot, undeclaredGitlinkCount, gitlinkCandidateCount,
  // submoduleCount }. A bug report's trace then shows whether discovery reached
  // and surfaced these repos without re-running the bug. Only fires when the
  // count is > 0, so it is silent (zero cost) for the common no-gitlink repo.
  MAIN_GIT_SNAPSHOT_GITLINK_DISCOVERED: 'main:git.snapshot.gitlink-discovered',

  // ───────── Renderer — Task name auto-follow Git branch ─────────
  // (a) RENDERER_TASK_NAME_RESOLVE: ph='i' instant marker emitted whenever
  // the auto-follow rule decides what to do for a given terminal on a
  // GIT_TERMINAL_INFO update. payload = { taskId, source: 'manual'|
  // 'auto-branch'|'cleared-by-repo-switch'|'fallback'|'skipped-disabled',
  // autoFollow, repoRoot, branch }. Lets traces explain *why* a name
  // changed (or didn't).
  // (b) RENDERER_TASK_NAME_MANUAL_CLEAR: ph='i' fired when the cwd has
  // moved to a different repo and the previous manual override has just
  // been erased by the rule. payload = { taskId, prevRepoRoot, newRepoRoot,
  // newBranch }. Useful for verifying user-visible "manual name expired"
  // moments line up with what the SQL queries expect.
  RENDERER_TASK_NAME_RESOLVE: 'renderer:task-name.resolve',
  RENDERER_TASK_NAME_MANUAL_CLEAR: 'renderer:task-name.manual-clear',

  // ───────── Renderer — Task layout (8-grid + Custom) ─────────
  // Layout transitions ride the renderer thread because TerminalGrid has
  // to recompute grid-column / grid-row for every Task cell and run
  // FitAddon resizes. All four events are emitted as ph='i' instants
  // (the existing renderer perfTrace wrapper only emits instants) and
  // carry a `durationMs` payload field on transitions so SQL queries can
  // still build latency histograms via `args.durationMs`.
  // (a) APPLY: every layoutMode → displayLayoutMode transition that
  //     completes (ensureReady resolved). Captures transitionMs.
  // (b) EDITOR_OPEN: when CustomLayoutEditor mounts.
  // (c) DOWNSIZE_DIALOG_OPEN: when DownsizeConfirmDialog mounts.
  // (d) TERMINAL_DESTROY_BY_DOWNSIZE: per-Task destroy emitted before
  //     terminalSessionManager.dispose; tagged with the per-Task tid via
  //     perfTraceTask so it lines up on the Task's row in Perfetto.
  RENDERER_CUSTOM_LAYOUT_APPLY: 'renderer:custom-layout.apply',
  RENDERER_CUSTOM_LAYOUT_EDITOR_OPEN: 'renderer:custom-layout.editor-open',
  RENDERER_DOWNSIZE_DIALOG_OPEN: 'renderer:downsize-dialog.open',
  RENDERER_TERMINAL_DESTROY_BY_DOWNSIZE: 'renderer:terminal.destroy-by-downsize',

  // ───────── Autotest bundle-marker (V10 closed-loop check) ─────────
  // Emitted ONLY by the `debug:emit-bundle-marker` IPC, which is
  // gated on ONWARD_AUTOTEST=1. The diagnostic-bundle verifier's V10
  // check searches for an event with this exact name + matching args
  // in the bundled chunks, proving the operation→write→bundle→verify
  // closed loop is intact end-to-end. Production code paths must not
  // emit this name. The string is duplicated as a literal in
  // `electron/main/diagnostic-bundle.ts::AUTOTEST_BUNDLE_MARKER_NAME`
  // so the bundler stays decoupled from the registry; if you rename
  // here, also update there (and forever after — registry contract).
  AUTOTEST_BUNDLE_MARKER: 'autotest:bundle-marker',

  // ────────────────────────────────────────────────────────────────────
  // GitStateMirror refactor (worker-thread mirror + pub/sub IPC).
  //
  // The mirror is the single source of truth for branch / repo name /
  // status colour / file list / per-file diff body. These events bracket
  // the four critical paths the GSM autotest suite asserts on:
  //
  //   1. cwd switch:
  //        renderer:terminal.osc-cwd-detected   (xterm.js parses OSC)
  //          → main:git-state-mirror.cwd-ignored   (malformed/non-directory cwd)
  //          OR
  //          → main:git-state-mirror.cwd-switched   (router routes to worker)
  //          → worker:git-state-mirror.recompute-status-done   (git status)
  //          → main:git-state-mirror.fanout   (delta to subscribers)
  //          → renderer:terminal-title.{branch,color}-rendered   (DOM)
  //
  //   2. file mutation:
  //        worker:git-state-mirror.watcher-fire (or .watcher-filtered)
  //          → worker:git-state-mirror.recompute-status-done
  //          → main:git-state-mirror.fanout
  //          → renderer:git-diff.body-rendered (or terminal-title.*)
  //
  // The two `renderer:terminal-title.*` markers feed the GSM-01..09 latency
  // assertions; `worker:git-state-mirror.watcher-filtered` lets GDS-39
  // assert the .git whitelist is doing its job.
  RENDERER_TERMINAL_OSC_CWD_DETECTED: 'renderer:terminal.osc-cwd-detected',
  MAIN_GIT_STATE_MIRROR_CWD_SWITCHED: 'main:git-state-mirror.cwd-switched',
  MAIN_GIT_STATE_MIRROR_CWD_IGNORED: 'main:git-state-mirror.cwd-ignored',
  // Diagnostic breadcrumb for the Bug A reject channel: emitted INSIDE
  // `broadcastCwdRejected` when main fans out the reject IPC to every live
  // renderer. Pair with `renderer:terminal.osc-cwd-rolled-back` to verify the
  // full main-reject → renderer-rollback round-trip from a perf trace.
  MAIN_GIT_STATE_MIRROR_CWD_REJECTED_BROADCAST: 'main:git-state-mirror.cwd-rejected-broadcast',
  // Renderer-side counterpart: emitted by TerminalGrid's onMirrorCwdRejected
  // listener with `action` = 'rolled-back' | 'skipped-no-speculative' |
  // 'skipped-value-mismatch' so the trace distinguishes "rollback happened"
  // from "rollback was a no-op because speculative was already replaced".
  RENDERER_TERMINAL_OSC_CWD_ROLLED_BACK: 'renderer:terminal.osc-cwd-rolled-back',
  WORKER_GIT_STATE_MIRROR_WATCHER_FIRE: 'worker:git-state-mirror.watcher-fire',
  WORKER_GIT_STATE_MIRROR_WATCHER_FILTERED: 'worker:git-state-mirror.watcher-filtered',
  WORKER_GIT_STATE_MIRROR_WATCHER_SKIPPED: 'worker:git-state-mirror.watcher-skipped',
  WORKER_GIT_STATE_MIRROR_WATCHER_STATUS_CHANGED: 'worker:git-state-mirror.watcher-status-changed',
  WORKER_GIT_STATE_MIRROR_WATCHER_RESTART_SCHEDULED: 'worker:git-state-mirror.watcher-restart-scheduled',
  WORKER_GIT_STATE_MIRROR_WATCHER_RESTART_RESULT: 'worker:git-state-mirror.watcher-restart-result',
  WORKER_GIT_STATE_MIRROR_WATCHER_POLL: 'worker:git-state-mirror.watcher-poll',
  WORKER_GIT_STATE_MIRROR_WATCHER_SUSPENDED_PROBE: 'worker:git-state-mirror.watcher-suspended-probe',
  WORKER_GIT_STATE_MIRROR_CHANGE_FINGERPRINT: 'worker:git-state-mirror.change-fingerprint',
  // A ref-only change (push/fetch advancing origin/<branch> without moving HEAD)
  // flipped refsDigest, the History list cache's second freshness signal. ph='i'.
  // Off-hot-path → diagnostic coverage: a future "phantom fork after push is back"
  // trace shows whether the mirror surfaced the ref move (and thus whether the
  // History cache re-keyed) vs. swallowed it like the original ref-blind bug did.
  WORKER_GIT_STATE_MIRROR_REFS_DIGEST_CHANGED: 'worker:git-state-mirror.refs-digest-changed',
  WORKER_GIT_STATE_MIRROR_RECOMPUTE_DONE: 'worker:git-state-mirror.recompute-status-done',
  // Always-on reconcile heartbeat (parallel to the watcher; see
  // docs/git-status-reconcile-design.md). reconcile-tick fires each worker-local
  // heartbeat that has due repos; reconcile-found-drift fires when a heartbeat
  // reconcile produced a change while no watcher-fire had occurred recently —
  // i.e. the watcher silently missed it (the failure mode behind the
  // green-badge-with-untracked-file bug).
  WORKER_GIT_STATE_MIRROR_RECONCILE_TICK: 'worker:git-state-mirror.reconcile-tick',
  WORKER_GIT_STATE_MIRROR_RECONCILE_FOUND_DRIFT: 'worker:git-state-mirror.reconcile-found-drift',
  // Adaptive backoff engaged: the last `git status` was slow enough (EDR spawn
  // tax) that the next heartbeat gap is stretched to lastStatusMs × factor
  // (capped) instead of the base 1 s/3 s — pinning the git-spawn duty cycle so
  // the heartbeat can't run status back-to-back and starve the foreground Diff.
  // Off the hot path: fires at most once per reconcile COMPLETION (a rate the
  // backoff itself reduces), only when the gap actually stretched past base.
  WORKER_GIT_STATE_MIRROR_RECONCILE_BACKOFF: 'worker:git-state-mirror.reconcile-backoff',
  // Emitted once per watcher subscribe: how many parcel ignore globs were
  // derived from the repo's .gitignore directory patterns (kar-qemu emulator
  // storm suppression). globCount=0 means no .gitignore dirs were converted
  // (watcher behaves as before); a non-zero count should correlate with a drop
  // in watcher-fire/recompute-status-done for that repo.
  WORKER_GIT_STATE_MIRROR_GITIGNORE_GLOBS: 'worker:git-state-mirror.gitignore-globs',
  MAIN_GIT_STATE_MIRROR_FANOUT: 'main:git-state-mirror.fanout',
  MAIN_GIT_STATE_MIRROR_WORKER_SHUTDOWN: 'main:git-state-mirror.worker-shutdown',
  // Teardown-quiesce diagnostics (the @parcel/watcher worker-teardown SIGABRT fix).
  // Worker emits when it has proven native quiescence before closing its port;
  // main records receipt of that ack (which defuses the unsafe terminate timer);
  // the respawn-cancel breadcrumb fires when dispose() suppresses a pending
  // respawn so no fresh worker is spawned into a quitting app.
  WORKER_GIT_STATE_MIRROR_SHUTDOWN_QUIESCED: 'worker:git-state-mirror.shutdown-quiesced',
  MAIN_GIT_STATE_MIRROR_WORKER_SHUTDOWN_ACK: 'main:git-state-mirror.worker-shutdown-ack',
  MAIN_GIT_STATE_MIRROR_RESPAWN_CANCELLED: 'main:git-state-mirror.respawn-cancelled',
  // App-quit drained the GitStateMirror cooperatively before the runtime froze
  // the worker isolate (the will-quit fire-and-forget fix).
  MAIN_APP_QUIT_GSM_DRAINED: 'main:app.quit-gsm-drained',
  RENDERER_TERMINAL_TITLE_BRANCH_RENDERED: 'renderer:terminal-title.branch-rendered',
  RENDERER_TERMINAL_TITLE_COLOR_RENDERED: 'renderer:terminal-title.color-rendered',
  RENDERER_GIT_DIFF_MANUAL_REFRESH: 'renderer:git-diff.manual-refresh',
  RENDERER_GIT_DIFF_HUNK_NAVIGATE: 'renderer:git-diff.hunk-navigate',
  RENDERER_GIT_DIFF_HUNK_ACTION: 'renderer:git-diff.hunk-action',
  RENDERER_GIT_DIFF_HUNK_WIDGET_INSTALL: 'renderer:git-diff.hunk-widget-install',
  RENDERER_GIT_DIFF_BODY_PREFETCH: 'renderer:git-diff.body-prefetch',
  RENDERER_GIT_DIFF_FILE_LOAD: 'renderer:git-diff.file-load',
  RENDERER_GIT_DIFF_FILE_LOAD_MEMORY_HIT: 'renderer:git-diff.file-load-memory-hit',
  RENDERER_GIT_DIFF_MODEL_SYNC: 'renderer:git-diff.model-sync',
  RENDERER_GIT_DIFF_BODY_RENDERED: 'renderer:git-diff.body-rendered',
  RENDERER_GIT_DIFF_CACHE_INVALIDATION: 'renderer:git-diff.cache-invalidation',
  RENDERER_GIT_DIFF_FILE_LIST_MODE_CHANGE: 'renderer:git-diff.file-list-mode-change',
  RENDERER_GIT_DIFF_JUMP_TO_EDITOR: 'renderer:git-diff.jump-to-editor',
  RENDERER_GIT_DIFF_SPLIT_MODE_TOGGLE: 'renderer:git-diff.split-mode-toggle',
  RENDERER_GIT_DIFF_AUX_MIRROR_SUBSCRIPTION: 'renderer:git-diff.aux-mirror-subscription',
  RENDERER_GIT_DIFF_SUBPAGE_RESTORE: 'renderer:git-diff.subpage-restore',
  // Emitted when a renderer-side `getDiff` invoke is force-released by the
  // loadDiff IPC watchdog because the main-process worker reply never settled
  // (EDR-throttled host / wedged git worker). Without this the in-flight lock
  // would leak and freeze Keep/Deny + every later load forever; the watchdog
  // releases the lock and this breadcrumb shows the release in a user trace.
  RENDERER_GIT_DIFF_LOAD_IPC_TIMEOUT: 'renderer:git-diff.load-ipc-timeout',
  // Emitted when the renderer IPC watchdog fires on a getDiff invoke but the
  // viewer already holds a non-empty file list. Rather than blanking the diff to
  // an empty error result (which silently destroyed the user's file list and
  // broke Keep/Deny + sibling lookups on an EDR-throttled host), the catch
  // PRESERVES the prior list. This breadcrumb shows in a user trace that a slow
  // reload was abandoned but the visible list was kept intact.
  RENDERER_GIT_DIFF_LOAD_WATCHDOG_PRESERVED: 'renderer:git-diff.load-watchdog-preserved',
  RENDERER_GIT_DIFF_SUBMODULE_OUTLINE_OBSERVED: 'renderer:git-diff.submodule-outline-observed',
  // Emitted when Git Diff opens against an explicit cwd supplied in the
  // `git-diff:open` event detail, bypassing terminalInfo / persisted / OSC cwd
  // resolution. Autotest-only path today; the trace makes "diff opened against
  // an overridden cwd" visible in a user-attached trace if the detail ever
  // carries a cwd in production.
  RENDERER_GIT_DIFF_CWD_OVERRIDE: 'renderer:git-diff.cwd-override',
  RENDERER_CLIPBOARD_PATH_COPY: 'renderer:clipboard.path-copy',
  RENDERER_PROJECT_EDITOR_JUMP_TO_DIFF: 'renderer:project-editor.jump-to-diff',

  // ───────── Renderer — Git Diff click → paint phase chain ─────────
  // Settled spans (ph='X') emitted once a click measurement seals. They
  // reproduce the JadeTree phase decomposition the in-app debug panel
  // surfaces, so a Perfetto trace contains the same diagnostic chain
  // without extracting it from `__onwardGitDiffDebug.getHistory()`.
  // Payload always carries `durationMs` (auto-routed to ph='X' by
  // performance-trace::resolvePhase) plus `fileKey` / `filename` /
  // `cacheState` / `totalMs` for joinability. The literal strings live
  // in `./click-phase-event-names.ts` (a leaf module imported by the
  // emitter and the registry alike) so renaming an event only happens
  // in one place.
  RENDERER_GIT_DIFF_CLICK_PHASE_IPC: CLICK_PHASE_EVENT_NAMES.IPC,
  RENDERER_GIT_DIFF_CLICK_PHASE_STATE_SET: CLICK_PHASE_EVENT_NAMES.STATE_SET,
  RENDERER_GIT_DIFF_CLICK_PHASE_MODEL_BIND: CLICK_PHASE_EVENT_NAMES.MODEL_BIND,
  RENDERER_GIT_DIFF_CLICK_PHASE_MOUNT: CLICK_PHASE_EVENT_NAMES.MOUNT,
  RENDERER_GIT_DIFF_CLICK_PHASE_DIFF_COMPUTE: CLICK_PHASE_EVENT_NAMES.DIFF_COMPUTE,
  RENDERER_GIT_DIFF_CLICK_PHASE_DOM_COMMIT: CLICK_PHASE_EVENT_NAMES.DOM_COMMIT,
  RENDERER_GIT_DIFF_CLICK_PHASE_PAINT: CLICK_PHASE_EVENT_NAMES.PAINT,
  RENDERER_GIT_DIFF_CLICK_PHASE_TOKENIZE_SETTLE: CLICK_PHASE_EVENT_NAMES.TOKENIZE_SETTLE,
  RENDERER_GIT_DIFF_CLICK_PHASE_COLD_MOUNT: CLICK_PHASE_EVENT_NAMES.COLD_MOUNT,
  RENDERER_GIT_DIFF_CLICK_PHASE_REVEAL_TIMEOUT: CLICK_PHASE_EVENT_NAMES.REVEAL_TIMEOUT,
  RENDERER_GIT_DIFF_CLICK_TOTAL: CLICK_PHASE_EVENT_NAMES.TOTAL,

  // ───────── Renderer — Git Diff PAGE-OPEN phase chain ─────────
  // The click-phase chain above times a FILE click inside an already-open
  // viewer; nothing timed the page open itself, so the 2026-07-04 "spinner
  // for 16 s" diagnostic bundle contained a single opaque
  // renderer:ipc.git.get-diff span and no renderer-side breadcrumbs at all
  // (component perfTrace is opt-in via ONWARD_PERF_TRACE=1 and off in prod
  // bundles). These three events ride the DIAGNOSTIC channel
  // (perfTraceDiagnostic → default-on, opt-out via ONWARD_PERF_TRACE=0):
  // they fire at user-click frequency, far under the trace budget.
  //   request      — ph='i', loadDiff entered with reset=true (a page open)
  //   list-applied — ph='X' via durationMs; the file list landed (ok=false
  //                  on the error/watchdog path — the rejection branch is
  //                  the diagnostically interesting one)
  //   first-paint  — ph='X' via durationMs; double-rAF after the list
  //                  applied, i.e. the spinner is actually gone
  RENDERER_GIT_DIFF_OPEN_PHASE_REQUEST: 'renderer:git-diff.open-phase.request',
  RENDERER_GIT_DIFF_OPEN_PHASE_LIST_APPLIED: 'renderer:git-diff.open-phase.list-applied',
  RENDERER_GIT_DIFF_OPEN_PHASE_FIRST_PAINT: 'renderer:git-diff.open-phase.first-paint',

  // ───────── 2026-07-04 G1-G5 spinner fixes (see docs/html/git-diff-cold-open-edr-spinner-analysis.html) ─────────
  // G5 — router purges a renderer's mirror subscriptions when its
  // webContents navigates (reload) or is destroyed. Reload never fires
  // 'destroyed', so pre-reload subscriptions (e.g. Git Diff aux submodule
  // roots) used to survive until app quit — the dead-repo churn.
  MAIN_GIT_STATE_MIRROR_RENDERER_SUBS_PURGED: 'main:git-state-mirror.renderer-subs-purged',
  // G1 — re-warm after invalidation (Option A): the prewarm coordinator's
  // dedup is per-invalidation-generation, and a mirror invalidation for a
  // live-subscribed cwd schedules a quiet-window re-warm on the low lane.
  MAIN_GIT_PREWARM_REWARM_SCHEDULED: 'main:git.prewarm.rewarm-scheduled',
  MAIN_GIT_PREWARM_REWARM_RUN: 'main:git.prewarm.rewarm-run',
  MAIN_GIT_PREWARM_REWARM_SKIPPED: 'main:git.prewarm.rewarm-skipped',
  // G2/Q1 — the git-ipc-worker respawned, so its in-memory caches (meta,
  // request, snapshot) are empty while main-side prewarm dedup survives;
  // the coordinator resets its dedup so live cwds re-warm.
  MAIN_GIT_PREWARM_DEDUP_RESET_WORKER_RESPAWN: 'main:git.prewarm.dedup-reset-worker-respawn',
  // G2 — structural snapshot survives a mirror invalidation and is served
  // after a cheap stat revalidation (.git/index + .gitmodules mtimes)
  // instead of respawning `git ls-files`; `stale` = mtimes moved, full
  // recapture ran.
  MAIN_GIT_DIFF_SNAPSHOT_REVALIDATE_SERVED: 'main:git.diff.snapshot.revalidate-served',
  MAIN_GIT_DIFF_SNAPSHOT_REVALIDATE_STALE: 'main:git.diff.snapshot.revalidate-stale',
  // G2 C-i (warm path only) — a background diff warm reused the mirror
  // worker's porcelain status after fingerprint re-stat validation
  // (result: 'hit' | 'stale' | 'unavailable'). Foreground getDiff never
  // takes this path — it always spawns its own status.
  MAIN_GIT_DIFF_WARM_STATUS_REUSE: 'main:git.diff.warm-status-reuse',
  // G3 — mirror worker load governance: a recompute was deferred by the
  // watcher duty-cycle floor / foreground-yield / cross-repo budget, and
  // the foreground-yield lifecycle itself.
  WORKER_GIT_STATE_MIRROR_RECOMPUTE_DEFERRED: 'worker:git-state-mirror.recompute-deferred',
  WORKER_GIT_STATE_MIRROR_FOREGROUND_YIELD: 'worker:git-state-mirror.foreground-yield',
  // G4 — the open skeleton painted from the mirror snapshot while the
  // real list was still loading (diagnostic channel, default-on).
  RENDERER_GIT_DIFF_OPEN_SKELETON_RENDERED: 'renderer:git-diff.open-skeleton-rendered',

  // ───────── 2026-07-05 watcher-independent freshness (revalidate-on-open + terminal-command trigger) ─────────
  // Root cause (two diagnostic bundles): the GitStateMirror FS watcher is the
  // SOLE freshness authority for the diff list + tab status, and on Windows
  // under EDR it silently drops `.git/**` events, so a `git commit` / edit
  // leaves the view stale until manual refresh; a `git init` in a non-git cwd
  // is never detected (that cwd has no watcher). Fix mirrors VS Code: revalidate
  // on Git Diff open, reconcile on completed terminal git commands, and
  // re-attach the watcher when a cwd becomes a git repo.
  //
  // Renderer: Git Diff page-open asked the mirror to revalidate its cwd (ph=i).
  RENDERER_GIT_DIFF_OPEN_REVALIDATE: 'renderer:git-diff.open-revalidate',
  // Renderer: a completed terminal command classified as a state-mutating git
  // invocation (ph=i). Payload carries ONLY the subcommand keyword + flags —
  // never the raw command line (privacy).
  RENDERER_TERMINAL_GIT_COMMAND_DETECTED: 'renderer:terminal.git-command-detected',
  // Main: router received a revalidate request (source=diff-open|terminal-command).
  MAIN_GIT_STATE_MIRROR_REVALIDATE_REQUESTED: 'main:git-state-mirror.revalidate-requested',
  // Main: the bridge mapped a terminal git command to a cwd revalidate.
  MAIN_GIT_STATE_MIRROR_TERMINAL_GIT_COMMAND: 'main:git-state-mirror.terminal-git-command',
  // Worker: revalidate recompute ran (no generation bump, delta-gated emit).
  WORKER_GIT_STATE_MIRROR_REVALIDATE: 'worker:git-state-mirror.revalidate',
  // Worker: a recompute detected a non-git → git transition and re-attached the
  // FS watcher for the newly-created repo (the BattleProject class).
  WORKER_GIT_STATE_MIRROR_WATCHER_REATTACHED: 'worker:git-state-mirror.watcher-reattached',

  // ───────── 2026-07-10 per-Task Project Editor view memory (multi-terminal cache-loss fix) ─────────
  // Root cause cluster: the editor scope key drifted with the terminal's live
  // cwd, the soft-close "instant reopen" snapshot was a single slot cleared by
  // any other Task's open, the markdown session cache had a 7-entry global
  // budget with no per-Task protection, and HTML scroll was never persisted.
  //
  // Renderer: editor open resolved the terminal cwd to a repo root (ph=X,
  // durationMs; payload: drifted=cwd!=root, fellBack=resolve failed).
  RENDERER_PROJECT_EDITOR_SCOPE_ROOT_RESOLVED: 'renderer:project-editor.scope-root-resolved',
  // Renderer: exact state-key miss adopted a legacy [terminalId, old-cwd] entry.
  RENDERER_PROJECT_EDITOR_SCOPE_STATE_LEGACY_ADOPTED: 'renderer:project-editor.scope-state-legacy-adopted',
  // Renderer: soft-close snapshot stored into the per-scope LRU map (ph=i).
  RENDERER_PROJECT_EDITOR_SNAPSHOT_STORED: 'renderer:project-editor.snapshot-stored',
  // Renderer: reopen found (and applied) this scope's soft-close snapshot.
  RENDERER_PROJECT_EDITOR_SNAPSHOT_APPLIED: 'renderer:project-editor.snapshot-applied',
  // Renderer: reopen had no snapshot for this scope (falls to persisted state).
  RENDERER_PROJECT_EDITOR_SNAPSHOT_MISSED: 'renderer:project-editor.snapshot-missed',
  // Renderer: LRU cap evicted another scope's snapshot on store.
  RENDERER_PROJECT_EDITOR_SNAPSHOT_EVICTED: 'renderer:project-editor.snapshot-evicted',
  // Renderer: markdown session cache evicted an entry (payload: size, limit,
  // protectedCount; file basename only).
  RENDERER_PROJECT_EDITOR_MD_CACHE_EVICTED: 'renderer:project-editor.md-cache-evicted',
  // Renderer: a scope's protected markdown-cache key was set/cleared.
  RENDERER_PROJECT_EDITOR_MD_CACHE_PROTECTED_SET_UPDATED: 'renderer:project-editor.md-cache-protected-set-updated',
  // Renderer: HTML preview scroll captured into FileViewMemory (ph=i).
  RENDERER_PROJECT_EDITOR_HTML_SCROLL_CAPTURED: 'renderer:project-editor.html-scroll-captured',
  // Renderer: persisted HTML scroll seeded back into the preview on reopen.
  RENDERER_PROJECT_EDITOR_HTML_SCROLL_RESTORED: 'renderer:project-editor.html-scroll-restored',
  // Renderer: persist refused to write an active file that was opened under a
  // different scope (cross-Task contamination guard; site=snapshot|restore-null).
  RENDERER_PROJECT_EDITOR_PERSIST_ACTIVE_FILE_GUARDED: 'renderer:project-editor.persist-active-file-guarded',
  // Renderer: a token-cancelled (non-user) restore was re-run for the still-open scope.
  RENDERER_PROJECT_EDITOR_RESTORE_RERUN_AFTER_CANCEL: 'renderer:project-editor.restore-rerun-after-cancel',

  // ───────── 2026-07-10 file-entry OS actions (open with default app / reveal in file manager) ─────────
  // Main: SHELL_OPEN_PATH handler outcome (success | error | stubbed under
  // ONWARD_AUTOTEST), path sliced to 256 chars, durationMs.
  MAIN_IPC_SHELL_OPEN_PATH: 'main:ipc.shell.open-path',
  // Main: SHELL_SHOW_ITEM_IN_FOLDER handler outcome (same payload shape).
  MAIN_IPC_SHELL_SHOW_ITEM_IN_FOLDER: 'main:ipc.shell.show-item-in-folder',
  // Renderer: a context-menu OS action was invoked on a file entry (ph=i).
  // Payload: surface (tree|quick-pin|quick-recent|search|outline|monaco|
  // git-diff|git-history), action (open-default|reveal), ok, error?.
  RENDERER_FILE_ENTRY_OS_ACTION: 'renderer:file-entry.os-action',
  // Renderer: on-disk existence check gating the OS-action menu items.
  // Payload: surface, exists, skipped (deleted entries skip the IPC), durationMs.
  RENDERER_FILE_ENTRY_EXIST_CHECK: 'renderer:file-entry.exist-check',
  // Renderer: Monaco context-action registration was skipped because the
  // editor instance was already disposed (locale change while the <Editor>
  // conditional is unmounted). Breadcrumb for "Monaco menu items missing"
  // reports; the next onMount re-registers cleanly.
  RENDERER_FILE_ENTRY_MONACO_ACTIONS_SKIPPED: 'renderer:file-entry.monaco-actions-skipped'
} as const

export type PerfTraceEventName = typeof PERF_TRACE_EVENT[keyof typeof PERF_TRACE_EVENT]
