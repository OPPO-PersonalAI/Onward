<!-- SPDX-FileCopyrightText: 2026 OPPO -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Onward test suite

This README is the **single source of truth** for "which feature is locked
by which automated test." Read § 2 *Feature × Test Index* before
authoring any new test runner, and update it in the same change set
when you add or modify a runner.

- § 1 — How to run the full regression
- § 2 — Feature × Test Index (read this first when designing tests)
- § 3 — Adding or modifying a test
- § 4 — Layout, fixtures, cleanup

---

## 1. How to run the full regression

```bash
python3 test/autotest/run-full-regression.py
```

Unit-only checks can be run without launching Electron:

```bash
pnpm test:unit
```

Output lands in `test/full-regression-results/<local-timestamp>/`
(host's local time, format `YYYYMMDDTHHMMSS`):

- `summary.log` — full streamed output + final pass/fail summary
- `summary.json` — machine-readable result of every runner
- `logs/<suite>.log` — per-runner stdout/stderr, one file each

That directory is gitignored — runs stay local; share the relevant
excerpts (PASS / FAIL summary, the failing per-runner log) with
reviewers instead of committing the artefacts.

Useful flags: `--build`, `--only <substr>`, `--skip <substr>`,
`--app-bin <path>`, `--list`. See
`python3 test/autotest/run-full-regression.py --help`.

---

## 2. Feature × Test Index

Each row maps a user-visible feature (or a fixed bug, written as
`Bug fix: <symptom>`) to the runner that locks it down. The
parenthesised tokens are assertion-ID prefixes inside the runner's
TypeScript source under `src/autotest/test-*.ts` — `grep` for them to
land on the exact assertion when something fails. Unit-only entries
point at files under `test/unittest/`.

> **5-step SOP § Step 0** (in `CLAUDE.md`): scan this table first. If a
> row already covers the feature surface you are touching, **amend**
> that runner. Only fall back to `ls test/autotest/run-*-autotest.sh`
> + `grep` when the index has no matching row, and add a row for the
> runner you settle on before reporting completion.

### 2.1 Terminal — title, focus, lifecycle, perf

| Feature / Bug | Tests |
|---|---|
| Single-click Task title opens dropdown menu (no debounce) | `run-terminal-title-rename` (TTM-01, TTM-12, TTM-13) |
| Title menu has 4 items: Rename / Auto-follow / Use Branch / Use Repo | `run-terminal-title-rename` (TTM-02) |
| Rename menu item drives inline edit; commit / cancel | `run-terminal-title-rename` (TTM-03, TTM-16, TTM-17) |
| Use Branch / Use Repo writes a frozen customName snapshot | `run-terminal-title-rename` (TTM-04, TTM-05, TTM-08, TTM-09) |
| Disabled menu items when no Git info present | `run-terminal-title-rename` (TTM-06, TTM-07, TTM-10) |
| Auto-follow Git branch (default ON) tracks branch on cwd / branch change | `run-terminal-title-rename` (TTM-21, TTM-22) |
| Manual rename pinned within same repo | `run-terminal-title-rename` (TTM-23) |
| Cross-repo cwd switch clears manual override and adopts new branch | `run-terminal-title-rename` (TTM-24) |
| Auto-follow OFF freezes name; OFF→ON resyncs branch | `run-terminal-title-rename` (TTM-25, TTM-26, TTM-27) |
| Bug fix: manual rename survives a restart — `manualNameRepoRoot` (the "this name is a manual override" marker) round-trips on every persist instead of being stripped by the serializer, AND the boot hydration barrier declines to overwrite a just-loaded customName on the first git-info sync even if its marker is transiently null. Without these, every manually-renamed Task on a git branch reverts to the live branch name after an auto-update restart. | **End-to-end real-restart**: `run-terminal-rename-restart-survival` (two real launches against one throwaway userData + git fixture: TRS-SEED-02 stamps marker through the production persist path, TRS-VERIFY-01 marker survived persist, TRS-VERIFY-03 name not reverted to branch, TRS-VERIFY-04 marker still matches repo) — catches BOTH the serializer-strip and boot-clobber regressions. **Renderer wiring**: `run-terminal-title-rename` (TTM-33 barrier, TTM-34 one-shot). **Pure logic**: `test/unittest/terminal-manual-name-roundtrip.test.mts` (serializer marker round-trip) + `test/unittest/auto-follow-name-decision.test.mts` (keep/clear/adopt + barrier decision table) + `test/unittest/terminal-name-state.test.mts` (authoritative name/marker lookup backing the ref-lag hardening: auto-follow reads customName + manualNameRepoRoot from the synchronous AppState, not the one-render-cycle-behind visibleTerminals copy). |
| Auto-follow checkbox toggles preference, menu stays open | `run-terminal-title-rename` (TTM-28) |
| Bug fix: title double-click no longer enters rename | `run-terminal-title-rename` (TTM-11, TTM-14) |
| Trace events emit on click / snapshot / rename | `run-terminal-title-rename` (TTM-20) |
| Outside-click / Escape closes the title menu | `run-terminal-title-rename` (TTM-18, TTM-19) |
| Bug fix: external OSC 0/1/2 title writes (Claude CLI, shell PROMPT_COMMAND, etc.) are ignored by the Task label — title / customName / cwd / manualNameRepoRoot stay byte-identical across 5 trials of PTY injection | `run-terminal-title-rename` (TTM-29, TTM-30, TTM-31) |
| Bug fix: OSC 7 with a phantom `file:///` path that does not exist on disk is rolled back from the renderer's speculative `oscDetectedCwds` once the main process rejects via `GIT_STATE_MIRROR_CWD_REJECTED`, so the Task header does not pin free text as its cwd indefinitely | `run-terminal-title-rename` (TTM-32) |
| Bug fix (Windows): the real default shell emits a cwd OSC (633 / 7 / 9;9) after every `cd` so the Task status bar tracks the working directory — guards the pwsh.ps1 `$host` read-only regression that silenced all cwd OSC on Windows PowerShell 5.x; spawns the host shell via node-pty under Electron ABI, 5 cd trials, all must emit | `run-shell-integration-cwd` (SIC-01..SIC-05) + `test/unittest/shell-integration-cwd-osc.test.mts` |
| Per-task ESC routes to terminal, not subpages | `run-subpage-navigation` (SN-*) |
| Terminal startup creates a packaged PTY, accepts shell input, and zsh integration chains back to the user ZDOTDIR | `run-terminal-autofollow` (TA-00a, TA-00b, TA-00c) |
| Terminal viewport keeps bottom-follow during refresh | `run-terminal-autofollow` (TA-02, TA-04, TA-06) |
| Wheel / PageUp scroll detaches viewport from bottom | `run-terminal-autofollow` (TA-03, TA-05) |
| Fit / remount preserves viewport position | `run-terminal-autofollow` (TA-07, TA-08, TA-09, TA-10, TA-11) |
| Bug fix: focus does not jump viewport (preventScroll) | `run-terminal-autofollow` (TA-12) |
| Bug fix: inherited no-color environment does not make Task / Coding Agent output monochrome | `run-terminal-autofollow` (TA-14, TA-15) + `test/unittest/terminal-color-env.test.mts` (TCE-U-*) |
| Terminal focus / activation across shortcuts and restore | `run-terminal-focus-activation` (TFA-01..TFA-08) |
| Renderer surface restored after a `simulateRendererSurfaceLoss` deactivate (legacy code path) | `run-terminal-focus-activation` (TFA-09) |
| Bug fix: blank Task + broken-image after macOS Spaces / Win virtual desktop swipe — phantom-blank canvas re-rendered after a host surface event (path B `clearTextureAtlas` + `terminal.refresh`) and real WebGL context loss follows VS Code-aligned DOM fallback semantics | `run-terminal-focus-activation` (TFA-10..TFA-18) |
| Bug fix: xterm `webglcontextlost` handling calls `event.preventDefault()`, then `WebglAddon.onContextLoss` disposes WebGL and keeps terminal content visible through DOM rendering | `run-terminal-focus-activation` (TFA-13, TFA-14, TFA-15) |
| Bug fix: host surface events and later old-canvas restore events do not recreate or disturb WebGL while cooldown-backed DOM fallback is active | `run-terminal-focus-activation` (TFA-16, TFA-17, TFA-18) |
| Terminal output rendering perf (frame budget, longtask) | `run-terminal-perf` (TP-*) |
| Multi-task terminal stress under concurrent output | `run-terminal-stress` (ST-*) |
| Bug fix: 6-task WebGL render corruption (garbled glyphs) root cause = xterm.js module-level shared texture atlas; all config-identical terminals share one TextureAtlas, and the per-page version counter collides on a _createNewPage merge re-index causing stale GPU texture rebinds to be skipped. RCS-ATLAS-01 proves 6 terminals share one atlas canvas; RCS-ATLAS-02 proves cross-terminal shared mutation (page-adds fire on siblings); RCS-ATLAS-03 guards the back-ported PR #5883 fix (global-monotonic page version). Drop patches/@xterm__addon-webgl@0.18.0.patch when upgrading to xterm.js >= 7.0.0 | `run-render-corruption-stress` (RCS-00, RCS-01, RCS-03, RCS-04, RCS-05, RCS-ATLAS-01, RCS-ATLAS-02, RCS-ATLAS-03) |
| Investigation: SINGLE-terminal TRANSIENT render corruption on macOS (color blocks / snow / noise + garbled glyphs, sub-second self-healing under heavy output) — survives the RCS-ATLAS-03 global-monotonic fix, so it targets the intra-frame atlas page-MERGE window (cells resolved before a mid-`_updateModel` merge keep the pre-merge page layout for one frame). Drives ONE terminal via the real renderer data path (`injectPtyDataForAutotest`) with bursty all-distinct-glyph full-screen frames, reads back EVERY render from the GL drawing buffer and scores three signatures: pure-red unbound-slot placeholder rects, flat+colored solid blocks, and isolated-contrast noise spikes (deviation from the trial's own median). RCS-TRANSIENT-02 is the honesty gate (load actually landed: renders + atlas page-adds); RCS-TRANSIENT-03 is the reproduce-or-rule-out signal (zero spikes under landed load == garble is BELOW the GL draw layer → compositor / ANGLE Metal). Worst frame dumped as a data-URL in the log. | `run-render-corruption-stress` (RCS-TRANSIENT-01, RCS-TRANSIENT-02, RCS-TRANSIENT-03) |
| Off-renderer scheduling architecture invariants | `run-terminal-architecture-baseline` (TAB-00, TAB-01) |
| Terminal layout / state restore across app restart | (`shouldRun('terminal-state-persistence')`, no shell runner) |
| Per-Task font override (style settings) | (`shouldRun('per-agent-font')`, no shell runner) |
| Renderer + main work scheduler unit tests | `test/unittest/main-work-scheduler-unit.mjs`, `renderer-work-scheduler-unit.mjs`, `terminal-output-scheduler-unit.mjs` (all executed by `run-unittest-suite`) |
| 8-grid (2x4) preset, Custom layout popover, downsize confirm dialog, focusTerminal 7/8 shortcuts | `run-task-layout` (TLM-00..05) + `test/unittest/task-layout-utils.test.mts` (TLM-U-01..41) |
| Terminal content right-click menu sends a manually ordered pinned Prompt to the clicked Task without touching Prompt history metadata | `run-prompt-editor-context-menu` (TPCM-01..03) |
| Bug fix: idle renderer ~8% CPU (Windows-only) = terminal cwd ping-ponged 'D:/x' ↔ 'D:\x' because the OSC writer ('/') and git-watcher writer ('\') disagreed on the path separator and the persistence layer didn't canonicalize, defeating setTerminalLastCwd's idempotency → whole-tree re-render storm. Fix: `normalizePersistedTerminalCwd` canonicalizes to '/' + `updateState` bails out on the resulting no-op. | `run-appstate-render-loop` (CDP idle-churn smoke test ARC-00/01 via `check-renderer-idle-churn.mjs` — hang-proof) + `test/unittest/terminal-cwd-persist-canonical.test.mts` + `test/unittest/appstate-update-bailout.test.mts` |

### 2.2 Tab / Subpage navigation / Settings UI

| Feature / Bug | Tests |
|---|---|
| Editor ↔ Diff ↔ History navigation memory | `run-subpage-navigation` (SN-07, SN-10, SN-12) + `run-subpage-cdp-clicks` (CDP-01..10) + `test/unittest/git-diff-view-memory.test.mts` |
| Cursor / scroll position restored across subpage switches | `run-subpage-viewstate-restore` (SVR-01..15) |
| Auto-updater UI state machine (idle / checking / downloading / restart) | `run-settings-update` (SU-01..10) |
| Bug fix: error-code falls back to localized detail string | `run-settings-update` (SU-06b) |

### 2.3 Git Diff

| Feature / Bug | Tests |
|---|---|
| Diff for terminal cwd at a subdir of the repo | `run-git-diff-subdir` (SD-*) |
| Submodule entries surface in parent diff list | `run-git-diff-submodules` (DSM-*) + `test/unittest/git-submodule-disk-discovery.test.mts` |
| Recursive submodule traversal | `run-git-diff-recursive-submodules` (RSM-*) + `test/unittest/git-submodule-disk-discovery.test.mts` |
| Pure-fs submodule discovery (zero git spawn): initialized vs deinit, depth/parentRoot, gitfile vs `.git` dir, `.gitmodules` parse | `test/unittest/git-submodule-disk-discovery.test.mts` (executed by `run-unittest-suite`) |
| Bug fix: parent diff hides "internal-only" dirty submodule entries | `run-git-diff-staleness-and-submodule` (GDS-01..05, GDS-13, GDS-14) |
| Bug fix: 3-second request cache invalidated by FS watcher | `run-git-diff-staleness-and-submodule` (GDS-06..10, GDS-12, GDS-15) |
| Bug fix: GitStateMirror @parcel/watcher worker-teardown SIGABRT. The worker's subscribe/unsubscribe are N-API async-work on its libuv loop; freeing the worker env while one is queued resolved a Deferred into a dead isolate → `napi_fatal_error` → `abort()`. Fix = a real native-quiesce barrier (wait until zero live subscriptions + zero pending unsubscribes, then settle past parcel's FSEvents debounce ceiling) before `parentPort.close()`, `shutdown-complete` as the router dispose gate with terminate ack-gated (never while subscriptions live), respawn-cancel on dispose, and single-flight idempotent `cleanupIpcHandlers`. GSMQ-04 drives SUSTAINED FS churn THROUGH graceful quit (native callbacks in-flight at teardown) and asserts clean exit + NO abort-class token in the app log across 5 trials. | `run-git-state-mirror-quit` (GSMQ-01..04) + `test/unittest/git-state-mirror-shutdown-quiesce.test.mts` (quiesce-ordering + respawn-suppression predicates) |
| GitStateMirror watcher supervisor recovery, degraded polling, and failure injection | `run-git-state-mirror-latency` (GSM-15, GSM-16) |
| GitStateMirror always-on reconcile heartbeat (parallel to the watcher; focused 1 s / visible 3 s) keeps the Task git badge fresh even when `@parcel/watcher` fails **silently** (subscribed, no error, drops every event — the production failure mode). Drives the badge to `added` and back to `clean` via the reconcile path with the watcher muted. See `docs/git-status-reconcile-design.md`. **Adaptive backoff**: when `git status` is slow (EDR spawn tax — measured 1.3 s median / 12.9 s peak), the next heartbeat gap stretches to `lastStatusMs × factor` (factor 4, capped 60 s) so the heartbeat can't run status back-to-back and starve the foreground Diff (root cause of "Diff not instant on big EDR repos"); a fast host keeps the base 1 s/3 s (zero regression). Real file changes (`markDirty`/watcher) bypass backoff so freshness is preserved. Diagnostic `worker:git-state-mirror.reconcile-backoff` fires per reconcile completion when the gap stretched. See `docs/html/git-reconcile-heartbeat-cadence-edr.html`. | `run-git-state-mirror-latency` (GSM-19, `ONWARD_AUTOTEST_GSM_WATCHER_SILENT=1` pass) + `test/unittest/git-reconcile-scheduler.test.mts` (pure 1 s/3 s/dirty/dedup decision table **+ adaptive-backoff table: `computeEffectiveIntervalMs` floor/stretch/cap, fast-host zero-regression, per-repo independence, dirty-bypass, recovery**) |
| Bug fix: two Tasks pointing at the same repo/worktree render the same Git status colour across clean/dirty cycles, including real commit-to-clean and post-commit dirty transitions (same-tab two-task layout AND cross-tab two-task each in its own TerminalGrid). Cross-tab path exercises router refCount + fanout to multiple subscribers and asserts both tabs converge to clean within the GitStateMirror budget after a real `git commit` | `run-git-state-mirror-latency` (GSM-17, GSM-18) + `test/unittest/terminal-grid-git-status-identity.test.mts` + `test/unittest/git-state-mirror-worker-core.test.mts` |
| Five-state Task git badge: working-tree changes classify into {add, del, mod} per file (two-sided XY like `MD` unions BOTH), then collapse to `clean` / `added` (purple) / `deleted` (red) / `modified` (yellow) / `mixed` (blue, ≥2 categories) / `unknown`. The pre-existing clean/added/modified semantics are unchanged; deleted + mixed split out of the old purple bucket. Single classifier (`electron/main/git-status-classify.ts`, `collectXyCategories` + `deriveTerminalGitStatus`) shared by all three porcelain parsers (mirror worker, legacy `git-utils` RPC, git-status worker). Computed status traced at `main:git-state-mirror.fanout` (vs rendered at `renderer:terminal-title.color-rendered`) to localise classify-vs-render bugs | `run-git-state-mirror-latency` **exhaustive badge matrix via static fixtures**: GSM-05 (add+mod), GSM-05a deleted-red, GSM-05b add+del, GSM-05c del+mod, GSM-05d add+del+mod triple, GSM-05e single-file two-sided `MD`→mixed — all asserted on the RENDERED colour; + GSM-09c/09d runtime delete→red flip+restore. `test/unittest/git-status-classify.test.mts` (exhaustive code→category→state incl `collectXyCategories` MD/AM) + `test/unittest/git-porcelain-parse.test.mts` (parser aggregation 5-state) |
| Snapshot service caches submodule meta (cache-hit / capture / invalidate; no-TTL `.gitmodules`-mtime validity, fs-only discovery) | `run-git-diff-staleness-and-submodule` (GDS-11, GDS-16) |
| No-`.gitmodules` gitlink: a nested repo the parent tracks as a bare gitlink (mode 160000) but never declared in `.gitmodules` surfaces in Diff AND History as a submodule repo with its internal changes (read from the index via `git ls-files -s`; winWatchRTOS-Build symptom). Pure parse + discovery-merge math is unit-pinned; end-to-end surfacing is a small focused autotest (one app session, 3 IPC calls — deliberately NOT amended into the 46-scenario staleness suite) | `run-git-diff-nested-gitlink` (NGL-00..03) + `test/unittest/git-submodule-disk-discovery.test.mts` (`parseGitlinkPathsFromLsFilesZ` + `extraGitlinkPaths` cases) |
| Bug fix (Windows invalidation storm): NESTED submodule `.git/` churn (`<sub>/.git/index.lock`, objects) must NOT survive the watcher filter (no recompute → no parent diff-cache invalidation), while a real submodule worktree edit must; and the change-fingerprint must exclude `ctimeNs` (NTFS metadata-only touches). | `test/unittest/git-state-mirror-worker-core.test.mts` (classifyEventPath nested-`.git` cases) + `test/unittest/git-state-mirror-submodule-watcher-filter.test.mts` (REAL `@parcel/watcher` + classifier, real-`.git`-dir submodule fixture) + `test/unittest/git-state-mirror-change-fingerprint.test.mts` (ctime-exclusion) |
| Trace markers emitted on watcher / freshness / snapshot paths | `run-git-diff-staleness-and-submodule` (GDS-12, GDS-16) |
| Files over 3 MB prompt in Git Diff, cancel shows a clear message, continue displays content | `run-git-large-file-confirmation` (GLF-01..06) + `test/unittest/git-large-file-policy.test.mts` |
| Image diff (PNG / SVG) in Diff modes 2up / swipe / onion | `run-image-diff` (ID-01, ID-02, ID-03, ID-19) |
| Image diff in Git History (PNG / SVG) | `run-image-diff` (ID-13..18) |
| PDF / EPUB compare in Diff + Git History (added / deleted / modified, single-pane collapse) | `run-pdf-epub-diff` (`git-diff-pdf-*`, `git-diff-epub-*`, `git-history-pdf-*`, `git-history-epub-*`) |
| Cross-platform Git behaviour (CRLF / paths / locale) | `run-git-cross-platform` (XP-*) |
| Prewarm-on-cwd-switch: when main resolves a NEW terminal cwd, a prewarm coordinator front-runs the Diff list + per-file content so opening Diff only reads warm caches. Three-lane isolation (foreground `cwd` / `::diff-precompute` / `::precompute-burst`) keeps a foreground click off the background warm; diff deduped by cwd. Content cache holds 24 project buckets (sized above kar-qemu's ~20 submodule buckets, env `ONWARD_DIFF_CACHE_MAX_PROJECTS`). Scoped FS-watcher revalidation pre-stats off the main thread (no O(n) `statSync` jank). Submodule two-stage load paints root-only immediately and merges `full` in-place instead of blocking on the slowest submodule. **Abandoned-cwd grace cancel (Strategy B)**: when a terminal leaves a cwd and no other live terminal still subscribes it, the coordinator schedules a `detachGraceMs` (~2.5s) cancel of that cwd's background precompute burst (`gitDiffPrecomputeScheduler.cancelProject`, burst lane only); a quick A→B→A return within the window aborts the cancel (no thrash). On an EDR spawn-bound host this is the "boost latest cwd" lever (contention removal). Diagnostic `main:git.prewarm.detach-cancelled`. | `run-repo-prewarm` (asserts `main:git.prewarm.repo-triggered` reaches the trace on a real terminal attach — EDR-independent wiring proof) + `test/unittest/git-repo-prewarm.test.mts` (coordinator dual dedup + diff/history orchestration + yield-delay + error-swallow **+ grace-cancel: schedule/elapse/return-aborts/A→B→A/grace=0-immediate/dup-noop/reset-clears**) + `test/unittest/git-ipc-worker-lane-keys.test.mts` (3-lane mutual isolation + submodule routing) + `test/unittest/git-diff-content-cache.test.mts` (24-bucket ceiling + `getProjectKeys`) + `test/unittest/git-porcelain-parse.test.mts` (branchOid parse). NB: `run-git-diff-click-latency` covers the cold-open latency budget but needs a host where git is fast — on an EDR-throttled host (`git rev-parse` measured at 3-7s) its 8s budget is unmeetable for reasons unrelated to this code. |
| Git-op aggregation (fewer git spawns per the "one call, many facts" principle): A1 — repo-root/git-dir `rev-parse` cached PERMANENTLY per cwd (immutable) + the two resolution paths merged, so a session stops re-spawning `rev-parse` (a real trace showed 85 spawns × ~3.5s). A2 — the History prewarm warms N commit-diffs in ONE `git log --raw --numstat` spawn (`prewarmHistoryDiffs`) instead of N×2 per-commit `git diff` spawns. | `run-repo-prewarm` (extended: asserts `main:git.prewarm.history-done` with `commitsWarmed > 0` — proves the single-`git log` batch warmed N commit-diffs; EDR-independent) + `test/unittest/git-meta-cache-policy.test.mts` (A1: positive=permanent / negative=TTL) + `test/unittest/git-log-diff-parse.test.mts` (A2: `git log --raw --numstat` parser — status from --raw + counts from --numstat merged by index, incl rename/binary) |

### 2.4 Git History

| Feature / Bug | Tests |
|---|---|
| Commit list, selection, file diff load | `run-git-history` (GH-*) |
| Diff options display mode labels, default inline, legacy preference migration | `run-git-history-multi-terminal-scope` (GHMS-13) + `run-git-diff-staleness-and-submodule` (GDS-24a, GDS-25b) + `test/unittest/git-history-diff-display-mode.test.mts` + `test/unittest/git-diff-split-view-mode.test.mts` |
| Files over 3 MB prompt in Git History, cancel shows a clear message, continue displays content | `run-git-large-file-confirmation` (GLF-07..13) + `test/unittest/git-large-file-policy.test.mts` |
| Per-terminal scope: history reflects active terminal cwd | `run-git-history-multi-terminal-scope` (GHMS-*) |
| Nested submodule history view | `run-git-nested-submodules` (GNS-*) |
| Prewarm-on-cwd-switch History caches: L8 commit-list cache keyed `repoRoot::branchOid::limit::skip` (a new commit moves branchOid → structural miss), L9 IMMUTABLE commit-diff cache keyed `repoRoot::<options>` (evicts only on capacity). Warmed for the first page + the top-10 ∪ last-7-days commit set in the low `::history-precompute` lane; branchOid supplied by main from the GitStateMirror snapshot (no extra spawn). | `test/unittest/git-history-cache.test.mts` (key builders + top-N ∪ last-week selection + renderer-matching base/head targets + failure-skips-cache) + `test/unittest/git-repo-prewarm.test.mts` (History dedup by cwd::branchOid; branch-change re-warm) |

### 2.5 Project Editor — file ops, layout, restore

| Feature / Bug | Tests |
|---|---|
| Per-file view memory (cursor / scroll / outline / preview anchor) | `run-project-editor-file-memory` (PFM-01..09) |
| File browser scroll persisted across switches and reopens | `run-project-editor-file-memory` (PFM-30..35) |
| Outline scroll persisted across switches and reopens | `run-project-editor-file-memory` (PFM-36..48) |
| Anchor file restored after recent-list eviction + app reopen | `run-project-editor-file-memory` (PFM-10..29) |
| Editor restore on app reopen (last file, cursor, scroll) | `run-project-editor-restore` (PE-*) |
| Restore unit logic (Set / Map serialisation, key normalization) | `run-project-editor-restore-unit` (PEU-*) |
| File open positions exact-line scroll | `run-project-editor-open-position` (POP-*) |
| Direct open with no file-size confirmation, read-only chunk viewer for very large text, unknown binary open choices, supported PNG/PDF/EPUB bypass binary prompt, large GIF + EPUB preview both use file:// URLs (no base64 IPC, no main-process buffer copy), supported file types (PDF / SQLite / EPUB) have no hard size cap | `run-project-editor-large-file` (PLF-*) + `test/unittest/project-editor-large-file-policy.test.mts` |
| Editor scope = active terminal (multi-terminal isolation) | `run-project-editor-multi-terminal-scope` (PEMS-*) |
| SQLite viewer (open `.db`, table list, paging) | `run-project-editor-sqlite` (PSQL-*) |
| File index cache + Quick Open behaviour, including ignored `.git/index.lock` / `node_modules/.cache` watcher noise | `run-file-index-cache-ui` (FIC-01..26) |
| File-index unit (cache eviction, dirty key tracking) | `test/unittest/file-index-cache.test.mts` (executed by `run-unittest-suite`) |
| Project-tree watcher event classification (@parcel/watcher create/update→classify, delete→remove) | `test/unittest/project-tree-watch-classify.test.mts` (executed by `run-unittest-suite`) |
| Editor auto-refresh on external file mutation | `run-file-watch` (FW-01..05) |
| Global ripgrep search across project | `run-global-search` (GS-01..11) |
| Working directory copy from terminal header | `run-working-directory-copy` (WDC-*) |
| Sidebar outline auto-scroll follows preview / editor | (`shouldRun('sidebar-autoscroll')`, no shell runner; SA-*) |
| Quick file open (unit harness) | (`shouldRun('quick-file-unit')`, no shell runner; QF-*) |

### 2.6 Project Editor — Markdown / preview

| Feature / Bug | Tests |
|---|---|
| Markdown preview renders highlight / image / outline | `run-project-editor-markdown-navigation` (PMN-01..09) |
| HTML source editing plus WebContents preview with local file assets, HTTP script access, persistent force refresh, splitter drag, WebContents search, HTML Preview zoom, browser-aligned refresh shortcut, and scroll-preserving fresh reload | `run-project-editor-html-preview` (PHTML-00..16) |
| Open Browser (address-bar in-app browser): local HTML file + sibling file:// subresources (any-file), resolver scheme rules (file:// / localhost+IP http / domain https), reload, zoom in/reset/out + renderer sync, Esc keep-alive vs ✕ destroy, auto-refresh tick + scroll restore, native preset menu + interval clamp | `run-open-browser` (OB-01..12) |
| Project Editor File Browser collapse / expand | `run-project-editor-markdown-navigation` (PMN-03b..03d) |
| Outline scroll memory across switches and reopens | `run-project-editor-markdown-navigation` (PMN-13..17, PMN-40..44) |
| Code-outline (TS / py) symbols + scroll memory | `run-project-editor-markdown-navigation` (PMN-18..23) |
| Read mode keeps preview open on edit toggle | `run-project-editor-markdown-navigation` (PMN-24) |
| Outline target falls back between editor / preview when one is hidden | `run-project-editor-markdown-navigation` (PMN-27..34) |
| Code-wrap preference (inline + block, persists across reopen) | `run-project-editor-markdown-navigation` (PMN-35..45) |
| Markdown session restore (last file + section + mode, ESC close + shortcut reopen shell/body sync, reopen reuses cached HTML without worker re-render flash, panel overlay toggles instantly with no fade afterimage) | `run-project-editor-markdown-session-restore` (PMSR-*) |
| Bug fix: Markdown preview / editor idle no longer keeps Helper CPU high from hidden/loading animations | `run-markdown-preview-cpu` (MPC-*) + unit `preview-restore-settle` (PRS-U-*) |
| Markdown preview reveal latency (cache-miss + cache-hit fast path, 3 fixture sizes) | `run-markdown-preview-latency` (MPL-*) + unit `preview-restore-settle` (PRS-U-*) |
| Markdown LaTeX (KaTeX) rendering in preview | `run-markdown-latex-preview` (MLP-*) |
| Mermaid pan / zoom / fullscreen in preview | `run-mermaid-panzoom` (MPZ-01..02) |
| Preview position restore across file switch (incl. Mermaid layout) | `run-preview-position-restore` (PPR-01..12) |
| In-preview search (next / prev / wrap, centering) | `run-preview-search` (PS-01..12) |
| PDF reader / EPUB reader inside editor (incl. iframe → host keyboard forwarding, ESC + shortcut reopen keeps iframe / reader mounted across N=5 close-retain cycles) | `run-pdf-epub-preview` (`pdf-reader-*`, `epub-*`) |
| PDF / EPUB full-mode read flow | `run-pdf-epub-full` (no fixed prefix) |

### 2.7 Prompt system

| Feature / Bug | Tests |
|---|---|
| Multiline send / execute with bracketed paste guard | `run-prompt-integrity` (PI-01..05) |
| Prompt input latency baseline (typing → paint p95) | `run-prompt-input-latency` (PIL-01, PIL-02) |
| Prompt input long-tail under terminal pressure | `run-prompt-input-longtail` (PILT-01, PILT-02) |
| Prompt list filter / color tag / task badge | `run-prompt-list` (PL-01..12) |
| Prompt editor right-click context menu — send-to-task order, undo / cut / copy / paste / clear-content / pinned-import / save-as-pinned / insert cwd / insert branch / insert task title / send-to-task; auto viewport flip + clamp, including oversized Send-to-Task and Import Pin submenus with internal scrolling. Also locks down the textarea's virtual-cursor behaviour: click-anywhere padding to (row, col), IME guard, paste at virtual position, undo of virtual padding, submit-time stripping of trailing whitespace / empty rows, real right-click ordering, modified-click no-op, caret/selection placement, repeated virtual clicks, scroll-offset row calculation, PromptSender send preview transform, and context-menu Send-to-Task transform; AND the global Canvas/Line input-mode dropdown in the title row (default Line, Line disables virtual click, Canvas restores it, Line still submits, user choice persists across Tabs). | `run-prompt-editor-context-menu` (PECM-01..37) |
| Prompt editor Import Pin submenu follows the manually reordered pinned Prompt order from Prompt History | `run-prompt-editor-context-menu` (PECM-38) |
| Send-transform pure function — strips per-line trailing whitespace and trailing empty rows so virtual-cursor placements with no input do not leak to the terminal. | `test/unittest/prompt-virtual-padding.test.mts` (PVP-U-01..08, 10..13), executed by `run-unittest-suite`. |
| Prompt sender grid layout, action buttons, send/execute | `run-prompt-sender` (PS-01..10) |
| Bug fix: terminal grid uncapped, sender respects 50% cap | `run-prompt-sender` (PS-31, PS-32, PS-33) |
| Prompt cleanup (auto / manual, color-aware retention) | (`shouldRun('prompt-cleanup')`, no shell runner; PC-*) |
| Scheduled prompt execution (relative / absolute / recurring) | `run-schedule` (SC-01..18) |

### 2.8 Cross-cutting infrastructure

| Feature / Bug | Tests |
|---|---|
| Trace JSON written and parseable on every dev launch | `run-trace-infra-self-check` (`first main event found`) |
| All `test/unittest/**` harnesses (pure-logic unit tests across every subsystem) | `run-unittest-suite` — driver `test/autotest/run-unittest-suite.mjs` discovers every `*.{mjs,mts}` and runs each in a fresh child process. Drop a new file under `test/unittest/` and it is picked up automatically — no `SCRIPTS` edit needed. Also reachable via `pnpm test:unit`. |
| Per-feature trace events emit and group by Task tid | `run-performance-trace` (PT-*) |
| NDJSON chunked store: 8 MB rotate, 64 MB total cap, oldest evicted, SIGKILL-resilient | `run-perf-trace-rotation` (T03 phases A+B) |
| Telemetry session start, properties, heartbeat | `run-telemetry` (TEL-01..10) |
| Feedback flow basic submit + browser draft | `run-feedback` (FB-*) |
| Feedback UI history list and resolve states | `run-feedback-persistence` (FBU-01..11), `run-feedback` |
| Diagnostic bundle export from FeedbackModal (ZIP of traces + state files; rotate-before-bundle; closed-loop verify) | `run-feedback` (FB-DB-01 + FB-DB-02 repeated bundle); unit `test/unittest/diagnostic-bundle.test.mts` (DB-01..04 happy path / streaming, DB-05 yazl race regression, DB-06/07 verifier negatives) |
| Change Log modal (sidebar entry, prefetch, EN fallback under zh-CN) | `run-change-log` (CL-01..11) |
| Coding agent env vars and storage | `test/unittest/coding-agent-env-vars.test.mjs`, `coding-agent-storage.test.mjs` (executed by `run-unittest-suite`) |
| General regression baseline | (`shouldRun('regression')`, no shell runner; RG-*) |
| Generic stress harness | (`shouldRun('stress')`, no shell runner; ST-*) |

---

## 3. Adding or modifying a test

When the user asks for a new automated test or for the test system to
change, edit `test/autotest/run-full-regression.py` directly. Reshape
the rest of the suite around it — do not introduce a separate driver
or checklist.

### Step 0 (mandatory): consult the index above

1. Scan § 2 for a row whose feature surface overlaps. If found, **amend
   that runner** instead of creating a sibling. Step 0 of the 5-step
   SOP in `CLAUDE.md` is satisfied by the index lookup; you do not
   need to `ls` / `grep` the whole `test/autotest/` directory.
2. If no row matches, fall back to
   `ls test/autotest/run-*-autotest.sh` + `grep -rl <keyword>
   test/autotest/`. Once you settle on a runner (new or amended),
   **add the corresponding row in § 2 of this file in the same change
   set**. The index is worse stale than missing — fix or remove rows
   on the same diff that touched the runner.

### Hard rule — English-only test selectors

Onward's automated test matrix covers **only the English locale**. When
you author or amend an autotest:

- Match buttons, menu items, dialog labels, etc. by their **English**
  `title` / text content only. Do not write a multilingual fallback set
  alongside the English needle (e.g. `['eight', '<other-locale>']`) —
  English alone is sufficient.
- Do **not** add a "read i18n dictionary" helper that imports
  `src/i18n/core.ts` and looks selectors up by key. That is over-design
  for a single-locale matrix.
- Do **not** put zh-CN strings in `src/autotest/test-*.ts`,
  `test/autotest/test-*.{ts,mjs,js}`, or any runner script. The
  project-level `scripts/check-chinese-comments.js` lint will reject
  them at `pnpm dist:dev` time, and test files are not allowlisted.
- Code comments inside test files must also be **English only** — same
  hard rule as the rest of the codebase (see `CLAUDE.md`).

If a future requirement ever demands zh-CN regression coverage, design
that as a dedicated locale-coverage suite at that point — do not
pre-emptively scaffold dual-language selectors in today's tests.

### Hard rule — Timing-sensitive autotest authoring

When an assertion's pass/fail depends on timing — PTY output rate,
WebGL context lifecycle, debounce / throttle windows,
requestAnimationFrame cadence, focus / visibility events, animation
transitions, async restoration paths — the **TEST CASE itself must
repeat the operation N times (default 5) and assert on the aggregate**,
not on a single sample. A single sample is one observation of a
stochastic process; one observation is not a measurement.

#### Pick the aggregator by what you're measuring

| Metric class | N | Aggregator | Example assertion |
|---|---|---|---|
| Boolean correctness (recovers / doesn't recover) | 5 | "all N trials succeeded" (or "≥ K of N", with K chosen against the failure cost) | After 5 lost+restored cycles, `webglActive=true` and `hasRenderablePixels` in all 5 |
| **Latency / response-time** (operation must complete within budget) | **3** | **≥ 1 of 3 meets the budget** (fail only if all 3 exceed) | Surface-restore latency: at least 1 of 3 trials completes within 200 ms (the budget the user signed off on) |
| Throughput / pixel intensity / sample count | 5 | Median (or p95), dropping top/bottom 10 % when the variance is bimodal | Median pixel-intensity over 5 frames > 80, variance > 0.05 |
| State integrity (no leak / no listener accumulation) | 5 | Snapshot before trial 1 vs after trial N; budget does NOT grow with N | After 5 lost+restored cycles, listener count equals baseline + 0 |

#### Latency-class assertions: ask the user for the budget first

Latency budgets are a **product decision**, not a test-author guess.
Before authoring a latency-class assertion, the budget must come from
the product owner / lead — never invented inside the test file.

When the test is being authored interactively (e.g. via Claude Code),
the test author MUST pause and ask the user for the budget — present
3–4 concrete options plus an "Other" escape so the user can supply a
custom value. Capture the operation context (which path, what user
action triggers it) so the choice is informed.

Once agreed, hard-code the budget as a named constant at the top of
the test:

```ts
// User signed off on 200 ms as the surface-restore budget on 2026-05-01.
// Re-confirm before changing the path or the assertion threshold.
const SURFACE_RESTORE_BUDGET_MS = 200
```

Why N=3 specifically (not 5) for latency: the assertion's question is
"can the system meet the budget *at all*?", not "what is the
distribution?". Three samples is enough to distinguish a transient
spike (1 sample over budget, 2 under → PASS, transient) from a
systematic regression (3 of 3 over budget → FAIL, real). Five samples
would make the test slower without changing the verdict shape.

#### Why repeat-inside-the-test, not retry-outside

A flaky test that the harness re-runs until it passes is a test that
lies. Internal aggregation makes the assertion statistically stable AND
keeps the failure signal honest — when the aggregate fails, the bug is
real, not a single bad frame. Compare with the alternative:

- **Retry-outside (bad)**: assertion checks 1 trial. Test fails 1-of-3
  iterations under `--repeat 3`. Author blames "flake", marks the test
  `.skip`, ships a regression nobody catches.
- **Repeat-inside (good)**: assertion checks median of 5 trials. Test
  passes deterministically when the system is correct, fails
  deterministically when the system regresses. No "flake" excuse.

#### What if a single trial isn't deterministic?

That's a smell. The test is racing real work. Bypass the racey
intermediate: call the manager / store / model directly instead of
dispatching a synthetic DOM event, IPC message, or focus event and
hoping the listener wins the debounce race. Sleeps paper over the
symptom; structural bypass (the test invokes the production handler
directly with the chosen reason / payload) is the durable fix.

#### Secondary harness gate: `--repeat N` for cross-runner state leaks

After the test itself is internally aggregated, you can sanity-check
the **harness** with:

```
python3 test/autotest/run-full-regression.py --build --repeat 3 \
    --only run-<your-suite>-autotest
```

Each iteration runs in its own timestamped output directory; the outer
process prints a `STABILITY SUMMARY` and exits non-zero if any
iteration failed. This catches a different bug class:

- **Same case fails the same way every iteration** → the test is still
  not internally aggregated; go back and fix the test, not the harness.
- **Different cases fail each iteration** → earlier runners in the
  `SCRIPTS` list are leaking focus / visibility / debounce / handle
  state into your runner. Harden cleanup in the leaking runner (EXIT
  trap, finally block, before/after listener-count assertion).
- **3 / 3 PASS** → both the test and the orchestrator order are healthy.

`--repeat N` is NOT a substitute for internal aggregation. A test that
relies on `--repeat` to mask single-trial flakes is a bug in the test.

#### Exemption

Pure non-timing runners (lint checks, snapshot diffs, deterministic
unit tests) are exempt — N=1 is correct for them.

### Authoring a new runner

1. Create the runner under `test/autotest/run-<suite>-autotest.sh`
   (and the `.ps1` mirror for Windows when applicable). Every runner
   must carry an SPDX header and write its log to
   `<repoRoot>/traces/test-logs/<suite>.log`.
2. Append the new runner to the `SCRIPTS` list inside
   `test/autotest/run-full-regression.py`. (If you amended an existing
   runner, no `SCRIPTS` change is needed.)
3. Reusable fixtures go under `test/autotest/fixtures/<suite>/`.
   Per-run scratch goes under the OS temp dir or
   `test/autotest/results/<suite>/` (gitignored).
4. Unit-only harnesses (Node `node --test` or `assert`-style) go under
   `test/unittest/`.
5. Pick an assertion-ID prefix (2–4 uppercase letters) that does not
   collide with an existing one in § 2. Use `<PREFIX>-NN-short-name`
   so traces and `grep` jumps cleanly to the assertion.

### Verifying

Run the trace self-check
(`test/autotest/run-trace-infra-self-check-autotest.sh <APP_BIN>`) plus
the affected runner via
`python3 test/autotest/run-full-regression.py --only run-<suite>`.
Confirm both are green before reporting the task complete.

---

## 4. Layout, fixtures, cleanup

The hard rules live in `CLAUDE.md` § "Automated tests". Quick reference:

- `test/autotest/` — runners (`.sh` / `.ps1`), orchestrator
  (`run-full-regression.py`), fixture builders (`create-*-fixture.mjs`,
  `prepare-*-fixture.mjs`), E2E sources (`test-*.ts` mounted via
  `src/autotest/autotest-runner.ts`).
- `test/autotest/fixtures/<suite>/` — committed reusable fixtures
  (real files, not base64 blobs in TS).
- `test/autotest/results/` — runner-internal scratch (gitignored).
- `test/unittest/` — Node test runner / `assert`-style unit harnesses
  (`*.test.{mjs,mts}`, `*-unit.mjs`).
- `test/full-regression-results/` — orchestrator output (gitignored).
- The `__autotest_*` filename prefix is reserved as a sentinel for
  "autotest-generated fixture, safe to delete on cleanup". Runners
  must install an `EXIT` trap (bash) / `finally` block (Python / Node)
  to sweep direct repo-root children matching `__autotest_*`.

`test/` top level holds **only** this `README.md` plus the four
directories above. Do not create new files at `test/` top level.

The full test-iteration loop convention (run → exit → read → fix →
rebuild → repeat, plus forbidden polling patterns) lives in
`CLAUDE.md` § *Hard rule — Test execution loop*. Follow it on every
fix-and-verify cycle.
