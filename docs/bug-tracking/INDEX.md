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
