/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

// Single source of truth for all IPC channel names shared between the main
// and preload processes. Importing both sides from this registry turns any
// channel-name typo into a compile-time error instead of a silent runtime
// miss.

export const IPC = {
  // app / app-state
  APP_GET_INFO: 'app:get-info',
  APP_GET_PDF_VIEWER_URL: 'app:get-pdf-viewer-url',
  APP_READ_NOTICE: 'app:read-notice',
  APP_STATE_FLUSH: 'app-state:flush',
  APP_STATE_FLUSH_DONE: 'app-state:flush-done',
  APP_STATE_FLUSH_PENDING: 'app-state:flush-pending',
  APP_STATE_LOAD: 'app-state:load',
  APP_STATE_SAVE: 'app-state:save',
  APP_STATE_SAVE_PATCH: 'app-state:save-patch',

  // browser
  BROWSER_CLEAR_COOKIES: 'browser:clear-cookies',
  BROWSER_CREATE: 'browser:create',
  BROWSER_DESTROY: 'browser:destroy',
  BROWSER_ESCAPE_PRESSED: 'browser:escape-pressed',
  BROWSER_EVALUATE_FOR_TEST: 'browser:evaluate-for-test',
  BROWSER_FIND_IN_PAGE: 'browser:find-in-page',
  BROWSER_FIND_SHORTCUT_PRESSED: 'browser:find-shortcut-pressed',
  BROWSER_FOUND_IN_PAGE: 'browser:found-in-page',
  BROWSER_FULLSCREEN_CHANGED: 'browser:fullscreen-changed',
  BROWSER_GET_NAV_STATE: 'browser:get-nav-state',
  BROWSER_GET_SCROLL_STATE: 'browser:get-scroll-state',
  BROWSER_GET_ZOOM_FACTOR: 'browser:get-zoom-factor',
  BROWSER_GO_BACK: 'browser:go-back',
  BROWSER_GO_FORWARD: 'browser:go-forward',
  BROWSER_HIDE: 'browser:hide',
  BROWSER_LOADING_CHANGED: 'browser:loading-changed',
  BROWSER_NAV_STATE_CHANGED: 'browser:nav-state-changed',
  BROWSER_NAVIGATE: 'browser:navigate',
  BROWSER_RELOAD: 'browser:reload',
  BROWSER_RELOAD_SHORTCUT_PRESSED: 'browser:reload-shortcut-pressed',
  BROWSER_RESTORE_SCROLL_STATE: 'browser:restore-scroll-state',
  BROWSER_SET_BOUNDS: 'browser:set-bounds',
  BROWSER_SET_REMEMBER_COOKIES: 'browser:set-remember-cookies',
  BROWSER_SET_ZOOM_FACTOR: 'browser:set-zoom-factor',
  BROWSER_SHOW: 'browser:show',
  BROWSER_SHOW_AUTO_REFRESH_MENU: 'browser:show-auto-refresh-menu',
  BROWSER_SHOW_COOKIE_MENU: 'browser:show-cookie-menu',
  BROWSER_STOP: 'browser:stop',
  BROWSER_STOP_FIND_IN_PAGE: 'browser:stop-find-in-page',
  BROWSER_TITLE_CHANGED: 'browser:title-changed',
  BROWSER_URL_CHANGED: 'browser:url-changed',
  BROWSER_ZOOM_FACTOR_CHANGED: 'browser:zoom-factor-changed',
  BROWSER_WEBVIEW_INPUT: 'browser:webview-input',

  // HTML Preview custom-protocol sessions
  HTML_PREVIEW_CREATE_SESSION: 'html-preview:create-session',
  HTML_PREVIEW_RELEASE_SESSION: 'html-preview:release-session',
  HTML_PREVIEW_VALIDATE_NAVIGATION: 'html-preview:validate-navigation',

  // changelog / clipboard
  CHANGELOG_GET_CURRENT: 'changelog:get-current',
  CLIPBOARD_READ_TEXT: 'clipboard:read-text',
  CLIPBOARD_WRITE_TEXT: 'clipboard:write-text',

  // coding-agent / command-preset
  CODING_AGENT_CONFIG_DELETE: 'coding-agent-config:delete',
  CODING_AGENT_CONFIG_LOAD: 'coding-agent-config:load',
  CODING_AGENT_CONFIG_SAVE: 'coding-agent-config:save',
  CODING_AGENT_CONFIG_UPDATE: 'coding-agent-config:update',
  CODING_AGENT_LAUNCH: 'coding-agent:launch',
  CODING_AGENT_PREPARE: 'coding-agent:prepare',
  COMMAND_PRESET_DELETE: 'command-preset:delete',
  COMMAND_PRESET_LOAD: 'command-preset:load',
  COMMAND_PRESET_SAVE: 'command-preset:save',

  // debug / dialog
  DEBUG_EMIT_BUNDLE_MARKER: 'debug:emit-bundle-marker',
  DEBUG_FEEDBACK_GET_LAST_OPENED_URL: 'debug:feedback-get-last-opened-url',
  DEBUG_FEEDBACK_RESET: 'debug:feedback-reset',
  DEBUG_FEEDBACK_SET_MOCK_ISSUES: 'debug:feedback-set-mock-issues',
  DEBUG_FOCUS_WINDOW: 'debug:focus-window',
  DEBUG_GET_APP_METRICS: 'debug:get-app-metrics',
  DEBUG_GET_GIT_RUNTIME_METRICS: 'debug:get-git-runtime-metrics',
  DEBUG_GET_MAIN_WORK_METRICS: 'debug:get-main-work-metrics',
  DEBUG_GET_PERF_TRACE_INFO: 'debug:get-perf-trace-info',
  DEBUG_GIT_DIFF_GET_DEBUG_STATS: 'debug:git-diff.get-debug-stats',
  DEBUG_LOG: 'debug:log',
  DEBUG_PERF_TRACE: 'debug:perf-trace',
  DEBUG_QUIT: 'debug:quit',
  DEBUG_READ_TELEMETRY_LOG: 'debug:read-telemetry-log',
  // Autotest-only (ONWARD_AUTOTEST=1): reload the main window's
  // webContents. The subscription-leak suite uses a real renderer reload
  // to prove pre-reload mirror subscriptions are purged (Electron never
  // fires 'destroyed' on reload, so reload is its own leak class).
  DEBUG_RELOAD_WINDOW: 'debug:reload-window',
  DEBUG_RESET_PERF_TRACE_METRICS: 'debug:reset-perf-trace-metrics',
  // Autotest-only (ONWARD_AUTOTEST=1): read back / reset the paths recorded
  // by the shell open-path / show-item-in-folder stubs so the file-entry OS
  // action suite can assert IPC round-trips without launching external apps.
  DEBUG_SHELL_GET_LAST_OPENED_PATH: 'debug:shell-get-last-opened-path',
  DEBUG_SHELL_GET_LAST_REVEALED_PATH: 'debug:shell-get-last-revealed-path',
  DEBUG_SHELL_RESET: 'debug:shell-reset',
  DIALOG_OPEN_DIRECTORY: 'dialog:openDirectory',
  DIALOG_OPEN_TEXT_FILE: 'dialog:openTextFile',
  DIALOG_SAVE_TEXT_FILE: 'dialog:saveTextFile',

  // feedback
  FEEDBACK_CREATE_SUBMISSION: 'feedback:create-submission',
  FEEDBACK_EXPORT_DIAGNOSTIC_BUNDLE: 'feedback:export-diagnostic-bundle',
  FEEDBACK_LOAD: 'feedback:load',
  FEEDBACK_REMOVE_RECORD: 'feedback:remove-record',
  FEEDBACK_REOPEN_IN_BROWSER: 'feedback:reopen-in-browser',
  FEEDBACK_SYNC: 'feedback:sync',
  FEEDBACK_UPDATE_PREFERENCES: 'feedback:update-preferences',

  // git
  GIT_CHECK_INSTALLED: 'git:check-installed',
  GIT_DIFF_CACHE_INVALIDATED: 'git:diff-cache-invalidated',
  GIT_DISCARD_FILE: 'git:discard-file',
  GIT_GET_DIFF: 'git:get-diff',
  GIT_GET_FILE_CONTENT: 'git:get-file-content',
  GIT_GET_HISTORY: 'git:get-history',
  GIT_GET_HISTORY_DIFF: 'git:get-history-diff',
  GIT_GET_HISTORY_FILE_CONTENT: 'git:get-history-file-content',
  GIT_GET_SUBMODULES: 'git:get-submodules',
  GIT_GET_TERMINAL_CWD: 'git:get-terminal-cwd',
  GIT_GET_TERMINAL_INFO: 'git:get-terminal-info',
  GIT_NOTIFY_TERMINAL_ACTIVITY: 'git:notify-terminal-activity',
  GIT_NOTIFY_TERMINAL_FOCUS: 'git:notify-terminal-focus',
  GIT_NOTIFY_TERMINAL_GIT_UPDATE: 'git:notify-terminal-git-update',
  // Watcher-independent freshness (2026-07-05): a completed terminal command
  // classified as a state-mutating git invocation — reconcile the terminal's
  // cwd even when the FS watcher dropped the `.git` write. VS Code's
  // terminal-shell-integration refresh model, adapted to Onward's PTY.
  GIT_NOTIFY_TERMINAL_GIT_COMMAND: 'git:notify-terminal-git-command',
  GIT_RESOLVE_REPO_ROOT: 'git:resolve-repo-root',
  GIT_SAVE_FILE_CONTENT: 'git:save-file-content',
  GIT_STAGE_FILE: 'git:stage-file',
  GIT_SUBSCRIBE_TERMINAL_INFO: 'git:subscribe-terminal-info',
  GIT_TERMINAL_INFO: 'git:terminal-info',
  GIT_UNSTAGE_FILE: 'git:unstage-file',
  GIT_UNSUBSCRIBE_TERMINAL_INFO: 'git:unsubscribe-terminal-info',
  GIT_UPDATE_INDEX_CONTENT: 'git:update-index-content',
  GIT_WARM_DIFF_CACHE: 'git:warm-diff-cache',

  // git-state-mirror (worker-thread single-source-of-truth, pub/sub)
  GIT_STATE_MIRROR_SUBSCRIBE: 'git-state-mirror:subscribe',
  GIT_STATE_MIRROR_UNSUBSCRIBE: 'git-state-mirror:unsubscribe',
  GIT_STATE_MIRROR_GET: 'git-state-mirror:get',
  GIT_STATE_MIRROR_UPDATE: 'git-state-mirror:update',
  GIT_STATE_MIRROR_REQUEST_FILE_BODY: 'git-state-mirror:request-file-body',
  GIT_STATE_MIRROR_FILE_BODY_UPDATE: 'git-state-mirror:file-body-update',
  // Watcher-independent freshness (2026-07-05): revalidate a cwd's mirror state
  // without the focus-resync generation bump. Fired on Git Diff page-open so a
  // watcher-missed commit/edit self-heals on open (no forced DiffEditor re-mount
  // when nothing changed).
  GIT_STATE_MIRROR_REVALIDATE: 'git-state-mirror:revalidate',
  GIT_STATE_PUSH_CWD: 'git-state-mirror:push-cwd',
  // Autotest-only (ONWARD_AUTOTEST=1): read-only dump of the router's
  // subscription tables (refCounts / internalRefCounts / per-renderer),
  // used by the subscription-leak suite to prove watchers are released.
  GIT_STATE_MIRROR_DEBUG_INSPECT: 'git-state-mirror:debug-inspect',
  // Main → renderer: emitted when `pushTerminalCwd` rejects a raw cwd
  // (path does not exist, fails normalization, etc.). Renderer uses this
  // to roll back any speculative `oscDetectedCwds` entry it dispatched
  // before the main-side filesystem check ran. Closes the bug class where
  // an inner program emits `OSC 7 ; file:///<free-text>` and the renderer
  // commits the free text as a phantom cwd that never auto-recovers.
  GIT_STATE_MIRROR_CWD_REJECTED: 'git-state-mirror:cwd-rejected',
  // Worker thread → main → renderer watcher supervisor health. Hard
  // watcher-error is reserved for failed watcher + failed fallback refresh.
  GIT_STATE_MIRROR_WATCHER_STATUS: 'git-state-mirror:watcher-status',
  GIT_STATE_MIRROR_WATCHER_ERROR: 'git-state-mirror:watcher-error',
  // Phase 5 PART 2: Refresh Changes button → main → Worker. Forces a
  // recompute + bumps mirror generation so the renderer's DiffEditor
  // key changes and the full chain re-mounts cleanly.
  GIT_STATE_MIRROR_FORCE_REFRESH: 'git-state-mirror:force-refresh',

  // project
  PROJECT_BUILD_FILE_INDEX: 'project:build-file-index',
  PROJECT_CREATE_FILE: 'project:create-file',
  PROJECT_CREATE_FOLDER: 'project:create-folder',
  PROJECT_DELETE_PATH: 'project:delete-path',
  PROJECT_FILE_CHANGED: 'project:file-changed',
  PROJECT_IMAGE_FILE_CHANGED: 'project:image-file-changed',
  PROJECT_INVALIDATE_FILE_INDEX: 'project:invalidate-file-index',
  PROJECT_LIST_DIRECTORY: 'project:list-directory',
  PROJECT_READ_FILE: 'project:read-file',
  // Batch existence check. Used by quick-file list restore — avoids the
  // antipattern of `readFile` (full content) just to verify presence.
  PROJECT_FILES_EXIST: 'project:files-exist',
  PROJECT_READ_FILE_CHUNK: 'project:read-file-chunk',
  PROJECT_RENAME_PATH: 'project:rename-path',
  PROJECT_SAVE_FILE: 'project:save-file',
  PROJECT_SEARCH_CANCEL: 'project:search-cancel',
  PROJECT_SEARCH_DONE: 'project:search-done',
  PROJECT_SEARCH_FILENAMES: 'project:search-filenames',
  PROJECT_SEARCH_RESULT: 'project:search-result',
  PROJECT_SEARCH_START: 'project:search-start',
  PROJECT_SQLITE_DELETE_ROW: 'project:sqlite-delete-row',
  PROJECT_SQLITE_EXECUTE: 'project:sqlite-execute',
  PROJECT_SQLITE_GET_SCHEMA: 'project:sqlite-get-schema',
  PROJECT_SQLITE_INSERT_ROW: 'project:sqlite-insert-row',
  PROJECT_SQLITE_READ_TABLE_ROWS: 'project:sqlite-read-table-rows',
  PROJECT_SQLITE_UPDATE_ROW: 'project:sqlite-update-row',
  PROJECT_TREE_WATCH_EVENT: 'project:tree-watch:event',
  PROJECT_TREE_WATCH_START: 'project:tree-watch:start',
  PROJECT_TREE_WATCH_STOP: 'project:tree-watch:stop',
  PROJECT_UNWATCH_ALL_IMAGE_FILES: 'project:unwatch-all-image-files',
  PROJECT_UNWATCH_FILE: 'project:unwatch-file',
  PROJECT_UNWATCH_IMAGE_FILES: 'project:unwatch-image-files',
  PROJECT_WATCH_FILE: 'project:watch-file',
  PROJECT_WATCH_IMAGE_FILES: 'project:watch-image-files',

  // prompt
  PROMPT_BRIDGE_RESPONSE: 'prompt:bridge-response',
  PROMPT_BRIDGE_SEND: 'prompt:bridge-send',
  PROMPT_DELETE: 'prompt:delete',
  PROMPT_LOAD: 'prompt:load',
  PROMPT_SAVE: 'prompt:save',

  // settings / shell / shortcut
  SETTINGS_CHECK_SHORTCUT_AVAILABLE: 'settings:check-shortcut-available',
  SYSTEM_GPU_PROCESS_GONE: 'system:gpu-process-gone',
  DEBUG_SIMULATE_GPU_PROCESS_GONE: 'debug:simulate-gpu-process-gone',
  DEBUG_RUN_OCCLUSION_FLIP_STRESS: 'debug:run-occlusion-flip-stress',
  DEBUG_KILL_GPU_PROCESS: 'debug:kill-gpu-process',
  DEBUG_RUN_GPU_WAKE_PARK_SOAK: 'debug:run-gpu-wake-park-soak',
  SYSTEM_THREADPOOL_HEALTH: 'system:threadpool-health',
  SYSTEM_RELAUNCH_APP: 'system:relaunch-app',
  DEBUG_SIMULATE_THREADPOOL_STALL: 'debug:simulate-threadpool-stall',
  DEBUG_GET_INFRA_HEALTH: 'debug:get-infra-health',
  SYSTEM_VISIBILITY_PROBE: 'system:visibility-probe',
  SYSTEM_VISIBILITY_PROBE_RESULT: 'system:visibility-probe-result',
  SYSTEM_VISIBILITY_RECOVERY_PUSH: 'system:visibility-recovery-push',
  SYSTEM_VISIBILITY_INPUT_WHILE_HIDDEN: 'system:visibility-input-while-hidden',
  SETTINGS_CHECK_SHORTCUT_CONFLICT: 'settings:check-shortcut-conflict',
  SETTINGS_LOAD: 'settings:load',
  SETTINGS_REGISTER_SHORTCUTS: 'settings:register-shortcuts',
  SETTINGS_SAVE: 'settings:save',
  SETTINGS_UPDATE: 'settings:update',
  SHELL_OPEN_EXTERNAL: 'shell:open-external',
  SHELL_OPEN_PATH: 'shell:open-path',
  SHELL_SHOW_ITEM_IN_FOLDER: 'shell:show-item-in-folder',
  SHORTCUT_ACTIVATED: 'shortcut:activated',
  SHORTCUT_TRIGGERED: 'shortcut:triggered',
  SHORTCUT_WINDOW_TRIGGERED: 'shortcut:window-triggered',

  // telemetry / terminal / terminal-config
  TELEMETRY_GET_CONSENT: 'telemetry:get-consent',
  TELEMETRY_SET_CONSENT: 'telemetry:set-consent',
  TELEMETRY_TRACK: 'telemetry:track',
  TERMINAL_BUFFER_RESPONSE: 'terminal:buffer-response',
  // Verified manual "change working directory" transaction (RC-3 fix,
  // 2026-07 bundles): renderer invokes with (terminalId, targetPath); main
  // validates the path, writes the shell-appropriate cd + proof-OSC command
  // into the PTY, and resolves ONLY after the shell's own cwd report
  // confirms the switch (or a timeout). The renderer persists nothing until
  // success — the optimistic-persist state split is structurally gone.
  TERMINAL_CHANGE_WORKDIR_VERIFIED: 'terminal:change-workdir-verified',
  // Main → renderer: shell integration produced no cwd OSC within the
  // liveness window after spawn (blocked script / unsupported shell). The
  // renderer shows a per-terminal hint pointing at the manual switch.
  TERMINAL_INTEGRATION_SILENT: 'terminal:integration-silent',
  // Main → renderer: a shell-derived OSC arrived after the silent signal —
  // clear the hint.
  TERMINAL_INTEGRATION_RECOVERED: 'terminal:integration-recovered',
  TERMINAL_CONFIG_LOAD: 'terminal-config:load',
  TERMINAL_CONFIG_SAVE: 'terminal-config:save',
  TERMINAL_CONFIG_UPDATE: 'terminal-config:update',
  TERMINAL_CREATE: 'terminal:create',
  TERMINAL_DATA: 'terminal:data',
  TERMINAL_DISPOSE: 'terminal:dispose',
  TERMINAL_EXIT: 'terminal:exit',
  TERMINAL_GET_INPUT_CAPABILITIES: 'terminal:get-input-capabilities',
  TERMINAL_NOTIFY_INTERACTIVE_INPUT: 'terminal:notify-interactive-input',
  TERMINAL_REQUEST_BUFFER: 'terminal:request-buffer',
  TERMINAL_RESIZE: 'terminal:resize',
  TERMINAL_SEND_INPUT_SEQUENCE: 'terminal:send-input-sequence',
  TERMINAL_SET_BUFFER_FAST_PATH: 'terminal:set-buffer-fast-path',
  TERMINAL_SET_OUTPUT_VISIBILITY: 'terminal:set-output-visibility',
  TERMINAL_WRITE: 'terminal:write',

  // updater
  UPDATER_CHECK_NOW: 'updater:check-now',
  UPDATER_DISMISS_BANNER: 'updater:dismiss-banner',
  UPDATER_DOWNLOAD_NOW: 'updater:download-now',
  UPDATER_GET_STATUS: 'updater:get-status',
  UPDATER_RESTART_TO_UPDATE: 'updater:restart-to-update',
  UPDATER_STATUS_CHANGED: 'updater:status-changed'
} as const

export type IpcChannel = (typeof IPC)[keyof typeof IPC]
