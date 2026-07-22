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
