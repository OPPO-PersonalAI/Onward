<!--
SPDX-FileCopyrightText: 2026 OPPO
SPDX-License-Identifier: Apache-2.0
-->

# Bug Tracking Index (docs/bug-tracking/)

This directory is the **knowledge base for diagnostic-bundle analysis**: every
root-caused bug has its own Markdown file recording the symptom, the full
analysis walk as it actually happened, the falsified hypotheses, the trace
instrumentation added for it, and "what to check first the next time a user
reproduces this".

## Usage rules

1. **Before analyzing any diagnostic bundle, read this index first**: match
   the user's symptom against the "Symptom keywords" column row by row. On a
   hit → open the bug file and follow its *Repro triage playbook* — check the
   already-landed trace events in the new bundle directly instead of
   re-deriving the analysis from scratch.
2. **No hit (new bug)** → after the analysis completes, create
   `BUG-NNNN-<slug>.md` (incrementing number, ASCII kebab-case slug) and
   **append** one row to the table below.
3. **Incremental, append-only updates**: when an old conclusion is
   overturned, append a new entry to the bug file's *Update history* and keep
   the original reasoning chain (wrong reasoning is the most reusable part —
   it records a path that looked correct and wasn't). Index columns
   (status / root cause) may be updated, but the revision trail must remain
   in the bug file.
4. `file:line` references inside a bug file are pinned to the commit named in
   its metadata table; the code baseline must always be stated there.
5. This directory is governed by the `ow_log_analysis` skill (see
   `.claude/skills/ow_log_analysis/SKILL.md` § 0.5). HTML reports stay under
   `Logs/reports/` (gitignored); this directory is the committed knowledge
   distillate. **Never** write unredacted bundle content here (real absolute
   paths, raw user input, tokens).

## Index

| ID | Status | Symptom keywords | Root cause | Related trace events (check these) | Files involved | Bug file |
|---|---|---|---|---|---|---|
| BUG-0001 | Instrumentation landed; awaiting next bundle to settle sub-mechanism | Terminal scroll-up shows no history / scrollback tops out quickly / content refreshes but no history above / codex, full-screen TUI | A full-screen TUI's output is a viewport-repaint stream: bytes→scrollback-lines conversion ≈ 0; the transcript exists only inside the TUI process, never in xterm scrollback. Data pipeline proven lossless via byte conservation (NOT an Onward defect) | `main:terminal.screen-mode-changed`, `renderer:terminal.scrollback-extent`, `renderer:terminal.wheel-to-arrows`, `renderer:terminal.pending-data-trimmed` | `electron/main/terminal-screen-mode.ts`, `electron/main/ipc-handlers.ts`, `src/terminal/terminal-session-manager.ts`, `src/utils/perf-trace-names.ts` | [BUG-0001](BUG-0001-codex-tui-scrollback-invisible.md) |
| BUG-0002 | Root-caused (High-confidence); fix pending user strategy decision; false-positive defect cross-validated on machine 2; "L1 throttle-toggle is safe" assumption falsified 2026-07-23 pm (L1 on occluded window preceded a GPU crash by 14 ms — see update history) | Window/terminal goes black after background→foreground / 花屏 reported but actually full black / text selectable but invisible / must restart app / started with 07.22 | Renderer visibilityState strands 'hidden' + rAF frozen while frontmost (Chromium/Electron 39 macOS occlusion desync, 2026-07-20 incident class) → zero frames composited (black, DOM alive). Amplified by 07.22's new visibility watchdog: verdict model false-positives on legitimate macOS full-occlusion, hide-show nudge unsafe while occluded (14 ms visible→hidden flap fingerprint, frame eviction), 300 s gave-up cooldown with no focus-triggered recheck → user stares at black up to 5.5 min and restarts | `main:visibility-watchdog.mismatch-detected` / `.nudge-applied` / `.recovered`, `renderer:visibility.recovery-push-received`, `renderer:window.visibility-change`, `renderer:xterm.renderer.refresh-after-restore` / `.surface-restore-batch` | `electron/main/visibility-health-model.ts`, `electron/main/visibility-watchdog.ts`, `electron/preload/index.ts`, `src/terminal/terminal-renderer-lifecycle.ts` | [BUG-0002](BUG-0002-stuck-hidden-visibility-blackout.md) |
| BUG-0003 | Root-caused (High-confidence); confirmed on BOTH machines 2026-07-23 pm; **defect origin dated pm3: imported by the 2026-04-08 Electron 35.7.5→39.8.5 bump (`532fe49`)**, trigger rate multiplied ~10× by the 07.22 watchdog; batch-1 trigger removal landed, Electron 43 upgrade = defect removal (stress-A/B gated) | Terminal content rendering corrupted after background→foreground wake / garble persists across tab switches / tab-switch remedy stopped working / started with 07.22 / 花屏 | GPU process crashes 30 ms into wake-from-background (ANGLE-Metal, electron#49904 class, no webglcontextlost). 07.22's new auto-recovery (`ac5c295`) rebuilds all WebGL surfaces successfully but rebuilt renderers re-attach to the SAME module-level shared glyph TextureAtlas left with stale/unbound references (known unfixed RCS-STAG-01 defect) → persistent garble; tab switches re-attach to the same poisoned atlas so the pre-07.22 folk remedy no longer works | `main:gpu.process-gone`, `renderer:xterm.renderer.gpu-crash-recovery` / `.dispose-webgl` / `.ensure-webgl`, tab round-trips seconds after recovery (behavioral fingerprint) | `electron/main/gpu-crash-recovery.ts`, `src/terminal/terminal-session-manager.ts`, `src/terminal/terminal-renderer-lifecycle.ts`, `patches/@xterm__addon-webgl@0.18.0.patch` | [BUG-0003](BUG-0003-gpu-crash-rebuild-atlas-dirty-refs.md) |
| BUG-0004 | **FIXED + verified 2026-07-27** (full regression 108/0, zero flaky; new mutation-timing matrix MT-01..08 locks tree-changes-at-any-moment). Regression origin: the `warm-ready` fast path added by `4891fc9` (2026-07-18). See § 9 of the bug file for the four production changes, two sibling defects found en route, and the eight defects introduced-and-caught while building it | Git Diff opened but didn't jump to the change / viewport stuck at top of file / whole file expanded, unchanged regions not collapsed / 没定位到差异点 / 全内容展开 / 没折叠 / only after the file's git state changed between two views | Warm Monaco models are reused across a content-identity change (model URI = repo hash + side + path, **no `changeType`, no content signature** — unlike `buildGitDiffFileKey` which does carry it; and panel mode never disposes models). On `setValue` Monaco keeps BOTH the previous `_diff` (200 ms debounce, `_diff` untouched) and the previous unchanged-region visibility state. The `warm-ready` gate tests `getLineChanges() !== null` — "a diff was computed once", not "this diff matches current content" — and reads it 47 ms later → reveals the OLD first-change line (1); Monaco's own collapse-state carry-over marks every new region already-expanded → whole file expanded. Two symptoms, one cause. Both self-heal paths dead (`requestDiffRevealRestore` early-returns once phase is `idle`; the park branch is skipped because the stale array is non-empty) | `renderer:git-diff.restore-decision` (`trigger==='warm-ready'` + `revealTargetLine`), `renderer:git-diff.file-load-memory-hit` (`changeType` transition + lengths), `renderer:git-diff.viewport-goal` (**absence** rules out the self-heal hypothesis); proposed P0: `renderer:git-diff.model-sync` (promote to diagnostic tier), `renderer:git-diff.warm-ready-gate`, `renderer:git-diff.collapse-state` | `src/components/GitDiffViewer/GitDiffViewer.tsx` (1212 URI, 1801 gate, 1744 early-return, 2928 isPanel, 4082-4091 sync, 5434-5490 reveal), `src/components/GitDiffViewer/diffViewMemory.ts`, `src/components/TerminalGrid/TerminalGrid.tsx:3288`, `node_modules/monaco-editor@0.55.1` (`diffEditorViewModel.js:86/125-186/346`, `diffEditorWidget.js:340`), `src/autotest/test-git-diff-staleness-and-submodule.ts` (GDS-52 blind spot) | [BUG-0004](BUG-0004-git-diff-warm-model-stale-diff-reveal.md) |
