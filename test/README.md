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
| Auto-follow checkbox toggles preference, menu stays open | `run-terminal-title-rename` (TTM-28) |
| Bug fix: title double-click no longer enters rename | `run-terminal-title-rename` (TTM-11, TTM-14) |
| Trace events emit on click / snapshot / rename | `run-terminal-title-rename` (TTM-20) |
| Outside-click / Escape closes the title menu | `run-terminal-title-rename` (TTM-18, TTM-19) |
| Per-task ESC routes to terminal, not subpages | `run-subpage-navigation` (SN-*) |
| Terminal viewport keeps bottom-follow during refresh | `run-terminal-autofollow` (TA-02, TA-04, TA-06) |
| Wheel / PageUp scroll detaches viewport from bottom | `run-terminal-autofollow` (TA-03, TA-05) |
| Fit / remount preserves viewport position | `run-terminal-autofollow` (TA-07, TA-08, TA-09, TA-10, TA-11) |
| Bug fix: focus does not jump viewport (preventScroll) | `run-terminal-autofollow` (TA-12) |
| Terminal focus / activation across shortcuts and restore | `run-terminal-focus-activation` (TFA-01..TFA-08) |
| Renderer surface restored after a `simulateRendererSurfaceLoss` deactivate (legacy code path) | `run-terminal-focus-activation` (TFA-09) |
| Bug fix: blank Task + broken-image after macOS Spaces / Win virtual desktop swipe — phantom-blank canvas re-rendered after a host surface event (path B `clearTextureAtlas` + `terminal.refresh`) and real WebGL context loss follows VS Code-aligned DOM fallback semantics | `run-terminal-focus-activation` (TFA-10..TFA-18) |
| Bug fix: xterm `webglcontextlost` handling calls `event.preventDefault()`, then `WebglAddon.onContextLoss` disposes WebGL and keeps terminal content visible through DOM rendering | `run-terminal-focus-activation` (TFA-13, TFA-14, TFA-15) |
| Bug fix: host surface events and later old-canvas restore events do not recreate or disturb WebGL while cooldown-backed DOM fallback is active | `run-terminal-focus-activation` (TFA-16, TFA-17, TFA-18) |
| Terminal output rendering perf (frame budget, longtask) | `run-terminal-perf` (TP-*) |
| Multi-task terminal stress under concurrent output | `run-terminal-stress` (ST-*) |
| PTY pipeline: high-volume `<text>\x1b[K\r` redraw burst (the `git clone --progress` pattern) collapses to one line per phase in the xterm buffer (smoke test for the VS Code-aligned flow-control + 5 ms batching pipeline; the original visual scrolling regression is verified manually, see `electron/main/ipc-handlers.ts`) | `run-terminal-cr-progress` (TCR-00..02) |
| Off-renderer scheduling architecture invariants | `run-terminal-architecture-baseline` (TAB-00, TAB-01) |
| Terminal layout / state restore across app restart | (`shouldRun('terminal-state-persistence')`, no shell runner) |
| Per-Task font override (style settings) | (`shouldRun('per-agent-font')`, no shell runner) |
| Renderer + main work scheduler unit tests | `test/unittest/main-work-scheduler-unit.mjs`, `renderer-work-scheduler-unit.mjs`, `terminal-output-scheduler-unit.mjs` |
| 8-grid (2x4) preset, Custom layout popover, downsize confirm dialog, focusTerminal 7/8 shortcuts | `run-task-layout` (TLM-00..05) + `test/unittest/task-layout-utils.test.mts` (TLM-U-01..41) |
| Terminal content right-click menu sends a manually ordered pinned Prompt to the clicked Task without touching Prompt history metadata | `run-prompt-editor-context-menu` (TPCM-01..03) |

### 2.2 Tab / Subpage navigation / Settings UI

| Feature / Bug | Tests |
|---|---|
| Editor ↔ Diff ↔ History navigation memory | `run-subpage-navigation` (SN-07, SN-10, SN-12) |
| Cursor / scroll position restored across subpage switches | `run-subpage-viewstate-restore` (SVR-01..15) |
| Auto-updater UI state machine (idle / checking / downloading / restart) | `run-settings-update` (SU-01..10) |
| Bug fix: error-code falls back to localized detail string | `run-settings-update` (SU-06b) |

### 2.3 Git Diff

| Feature / Bug | Tests |
|---|---|
| Diff for terminal cwd at a subdir of the repo | `run-git-diff-subdir` (SD-*) |
| Submodule entries surface in parent diff list | `run-git-diff-submodules` (DSM-*) |
| Recursive submodule traversal | `run-git-diff-recursive-submodules` (RSM-*) |
| Bug fix: parent diff hides "internal-only" dirty submodule entries | `run-git-diff-staleness-and-submodule` (GDS-01..05, GDS-13, GDS-14) |
| Bug fix: 3-second request cache invalidated by FS watcher | `run-git-diff-staleness-and-submodule` (GDS-06..10, GDS-12, GDS-15) |
| Snapshot service caches submodule meta (cache-hit / capture / invalidate) | `run-git-diff-staleness-and-submodule` (GDS-11, GDS-16) |
| Trace markers emitted on watcher / freshness / snapshot paths | `run-git-diff-staleness-and-submodule` (GDS-12, GDS-16) |
| Image diff (PNG / SVG) in Diff modes 2up / swipe / onion | `run-image-diff` (ID-01, ID-02, ID-03, ID-19) |
| Image diff in Git History (PNG / SVG) | `run-image-diff` (ID-13..18) |
| PDF / EPUB compare in Diff (added / deleted / modified) | `run-pdf-epub-diff` (`git-diff-pdf-*`, `git-diff-epub-*`) |
| Cross-platform Git behaviour (CRLF / paths / locale) | `run-git-cross-platform` (XP-*) |

### 2.4 Git History

| Feature / Bug | Tests |
|---|---|
| Commit list, selection, file diff load | `run-git-history` (GH-*) |
| Per-terminal scope: history reflects active terminal cwd | `run-git-history-multi-terminal-scope` (GHMS-*) |
| Nested submodule history view | `run-git-nested-submodules` (GNS-*) |

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
| Editor scope = active terminal (multi-terminal isolation) | `run-project-editor-multi-terminal-scope` (PEMS-*) |
| SQLite viewer (open `.db`, table list, paging) | `run-project-editor-sqlite` (PSQL-*) |
| File index cache + Quick Open behaviour | `run-file-index-cache-ui` (FIC-01..21) |
| File-index unit (cache eviction, dirty key tracking) | `test/unittest/file-index-cache.test.mts` |
| Project tree FS watcher (debounce, batch) | `test/unittest/project-tree-watch-manager.test.mts` |
| Editor auto-refresh on external file mutation | `run-file-watch` (FW-01..05) |
| Global ripgrep search across project | `run-global-search` (GS-01..11) |
| Working directory copy from terminal header | `run-working-directory-copy` (WDC-*) |
| Sidebar outline auto-scroll follows preview / editor | (`shouldRun('sidebar-autoscroll')`, no shell runner; SA-*) |
| Quick file open (unit harness) | (`shouldRun('quick-file-unit')`, no shell runner; QF-*) |

### 2.6 Project Editor — Markdown / preview

| Feature / Bug | Tests |
|---|---|
| Markdown preview renders highlight / image / outline | `run-project-editor-markdown-navigation` (PMN-01..09) |
| Outline scroll memory across switches and reopens | `run-project-editor-markdown-navigation` (PMN-13..17, PMN-39..43) |
| Code-outline (TS / py) symbols + scroll memory | `run-project-editor-markdown-navigation` (PMN-18..23) |
| Read mode keeps preview open on edit toggle | `run-project-editor-markdown-navigation` (PMN-24) |
| Outline target falls back between editor / preview when one is hidden | `run-project-editor-markdown-navigation` (PMN-27..33) |
| Code-wrap preference (inline + block, persists across reopen) | `run-project-editor-markdown-navigation` (PMN-34..44) |
| Markdown session restore (last file + section + mode) | `run-project-editor-markdown-session-restore` (PMSR-*) |
| Markdown LaTeX (KaTeX) rendering in preview | `run-markdown-latex-preview` (MLP-*) |
| Mermaid pan / zoom / fullscreen in preview | `run-mermaid-panzoom` (MPZ-01..02) |
| Preview position restore across file switch (incl. Mermaid layout) | `run-preview-position-restore` (PPR-01..12) |
| In-preview search (next / prev / wrap, centering) | `run-preview-search` (PS-01..12) |
| PDF reader / EPUB reader inside editor | `run-pdf-epub-preview` (`pdf-reader-*`, `epub-*`) |
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
| Send-transform pure function — strips per-line trailing whitespace and trailing empty rows so virtual-cursor placements with no input do not leak to the terminal. | `node --experimental-strip-types --test test/unittest/prompt-virtual-padding.test.mts` (PVP-U-01..08, 10..13). Out-of-band unit; not in `SCRIPTS`. |
| Prompt sender grid layout, action buttons, send/execute | `run-prompt-sender` (PS-01..10) |
| Bug fix: terminal grid uncapped, sender respects 50% cap | `run-prompt-sender` (PS-31, PS-32, PS-33) |
| Prompt cleanup (auto / manual, color-aware retention) | (`shouldRun('prompt-cleanup')`, no shell runner; PC-*) |
| Scheduled prompt execution (relative / absolute / recurring) | `run-schedule` (SC-01..18) |

### 2.8 Cross-cutting infrastructure

| Feature / Bug | Tests |
|---|---|
| Trace JSON written and parseable on every dev launch | `run-trace-infra-self-check` (`first main event found`) |
| Per-feature trace events emit and group by Task tid | `run-performance-trace` (PT-*) |
| NDJSON chunked store: 8 MB rotate, 64 MB total cap, oldest evicted, SIGKILL-resilient | `run-perf-trace-rotation` (T03 phases A+B) |
| Telemetry session start, properties, heartbeat | `run-telemetry` (TEL-01..10) |
| Feedback flow basic submit + browser draft | `run-feedback` (FB-*) |
| Feedback UI history list and resolve states | `run-feedback-persistence` (FBU-01..11), `run-feedback` |
| Diagnostic bundle export from FeedbackModal (ZIP of traces + state files; rotate-before-bundle; closed-loop verify) | `run-feedback` (FB-DB-01 + FB-DB-02 repeated bundle); unit `test/unittest/diagnostic-bundle.test.mts` (DB-01..04 happy path / streaming, DB-05 yazl race regression, DB-06/07 verifier negatives) |
| Change Log modal (sidebar entry, prefetch, EN fallback under zh-CN) | `run-change-log` (CL-01..11) |
| Coding agent env vars and storage | `test/unittest/coding-agent-env-vars.test.mjs`, `coding-agent-storage.test.mjs` |
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
