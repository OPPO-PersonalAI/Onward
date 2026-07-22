<!--
SPDX-FileCopyrightText: 2026 OPPO
SPDX-License-Identifier: Apache-2.0
-->

# BUG-0001: codex (full-screen TUI) — scroll-up shows no complete history

| Field | Value |
|---|---|
| Status | Instrumentation landed; awaiting next bundle to settle the sub-mechanism |
| Reported | 2026-07-21 (bundle generated 17:36:04 local, UTC+8) |
| Analyzed | 2026-07-22 |
| Code baseline | master @ 865f122 (all `file:line` references below are pinned to it; the instrumentation landed on top of it) |
| App version in bundle | 2.1.0-daily.20260713.1 (win32 x64, Electron 39.8.5) |
| Diagnostic bundle | `Logs/lanxi-terminal1 中的内容有刷新，但是上划的时候没办法看到完整的信息-onward-diagnostic-2026-07-21_17-36-04.zip` (gitignored, kept locally) |
| HTML report | `Logs/reports/…-tui-repaint-stream-no-scrollback.html` (gitignored, next to the bundle) |
| Confidence | Root cause = high-confidence inference; "data pipeline lossless" = confirmed (byte conservation) |

## 1. Symptom (user's own words, kept verbatim as evidence)

- Zip filename: "lanxi-terminal1 中的内容有刷新，但是上划的时候没办法看到完整的信息"
  (content refreshes, but scrolling up cannot reveal the complete history)
- Session follow-up: codex runs in Terminal 1; scrolling up to read history
  shows a severely limited content height — there should be much more
  content, but nothing more exists above.
- Decisive follow-up answers (AskUserQuestion): scrolling was done with the
  **mouse wheel**; the observed behaviour was **"the whole content scrolls,
  but tops out almost immediately"** (a short stub of old content appears,
  then the top).

## 2. Root-cause conclusion

**codex's full-screen TUI output is a viewport-repaint stream**: ~13 MB of
PTY output is almost entirely repeated overwriting (cursor addressing +
erase + redraw) of the same 80×23 visible region, so the **bytes →
scrollback-lines conversion factor ≈ 0**. The 10,000-line xterm scrollback
holds only the residue from before codex started (a few dozen lines); the
full conversation transcript exists only inside the codex process's own
memory. **Onward's data pipeline loses nothing** (§ 4 byte conservation) —
this is not a scrollback-capacity issue, not a cleared buffer, and not a
renderer rebuild.

Two sub-mechanisms (identical user-facing effect and identical fix
directions; the bundle could not decide between them):

- **A: alternate-screen episodes (DECSET 1049).** The alternate screen has
  no scrollback by VT semantics. Supporting evidence: while the user
  wheel-scrolled, the PTY received 3-byte arrow-key sequences — xterm 5.5
  only converts wheel to arrows on the "alt buffer + no mouse protocol"
  path. Weakening evidence: the user could also scroll a short stub (a pure
  alt-screen viewport cannot scroll at all) → at most episodic alt-screen.
- **B: in-place repaint on the normal buffer (ConPTY synthesis).** On
  Windows every PTY stream passes through ConPTY, which keeps an internal
  screen exactly the PTY size and re-synthesizes VT output; for full-screen
  TUIs its typical product is cursor-addressed full/partial repaints, so new
  lines never cross the top of the screen into scrollback. Fully consistent
  with "scrolls but only a stub".

## 3. Full analysis walk (including falsified paths — kept for reuse)

### 3.1 Integrity and baseline

8 trace chunks / 54 MB / 122,310 events / 0 corrupt lines, spanning
2026-07-20T19:19:46Z → 07-21T09:36:10Z (14.27 h). No `ONWARD_*` variables →
renderer data-path events (opt-in tier) structurally absent — the reason
every renderer-side claim below had to be argued indirectly. Rate-limit
drops: 543 `pty.output` + 449 `terminal.task.state` trace events (those
counts are floors only). App state: one tab, six terminals in a 6-pane
grid; Terminal 1 (`…9428-0`) focused.

### 3.2 Key observations (all times UTC)

1. **codex online the whole time**: all 26,250 `pty.output` events for
   Terminal 1 carried `bracketedPasteMode:true`; no `pty.spawn` in 14.3 h.
2. **Overnight burst**: 19:19–19:36, 8.21 MB output (peak second 175 KB/s —
   exactly the trace store's 100 events/s ceiling; chunk size p50 = 222 B —
   the timing fingerprint of high-frequency small repaints). Document was
   hidden the entire night.
3. **Window became visible at 03:14:28Z (11:14 local)**: pid=2 itself
   emitted `visibility-change: visible`; all six terminals refit
   59×24 → 80×24 → 80×23; three main-process event-loop stalls
   (281/313/424 ms) and a 2.04 MB repaint burst (SIGWINCH-triggered full TUI
   redraw + overnight backlog catch-up).
4. **Focus-report decode**: the 3-byte write hash pair `2217e7`/`a0757d`
   aligned with `window.focus`/`visibility` events at millisecond precision
   (03:14:52.109→.111; 09:35:55.685↔.678) → identified as `ESC[I`/`ESC[O`
   (codex enabled DECSET 1004), proving codex is a mode-managing full-screen
   TUI.
5. **User interaction reconstruction (17:25:51–17:26:09 local)**: focus-in →
   4 slow 3-byte inputs (direction A) → 6 fast ~150 ms 3-byte inputs
   (direction B) → ~13 typed characters → Enter (the only
   `includesEnter:true` in the whole trace) → codex burst 643 KB in
   response. I.e. "scrolled for history → found none → asked codex instead".
6. **xterm 5.5 wheel chain (verified in the bundled artifact)**:
   `wheel → no mouse protocol → !buffer.hasScrollback (true only in the alt
   buffer) → emit 3-byte ESC O/[ A/B per line`.

### 3.3 Hypotheses and falsifications (the dead ends — most reusable part)

| Hypothesis (a main line of attack at the time) | Disproving evidence |
|---|---|
| ① Renderer reloaded / window rebuilt → fresh xterm replayed only a truncated tail | The `visible` event was emitted by pid=2 itself (only a live process has a hidden→visible transition); all 74 surface-restore batches had `recreatedCount:0`; main PID constant across chunks; no `pty.spawn`. `clear()/reset()` exist only in `restartShell` (requires PTY rebuild — never happened) |
| ② Pure alternate screen ("cannot scroll at all" variant) | User confirmed "whole content scrolls but tops out quickly" — an alt-screen viewport cannot scroll. Downgraded to episodic alt-screen (sub-mechanism A) |
| ③ Main process dropped output while the document was hidden | Byte conservation: overnight pty 8.21 MB ≈ IPC sent 8.51 MB; whole window `terminal.ipc.send` 13.06 MB ≈ `terminal.buffer.flush` 13.01 MB |
| ④ Renderer hidden-path 512 KB ring (`PENDING_DATA_MAX_BYTES`) trimmed the night's output | `isOutputActive = session.visible && session.outputVisible` — does NOT consider document-level hidden; all six grid panes were output-visible (`visibleSessions:6` in restore batches, no layout actions overnight) → the visible 8 MB path + the scheduler's `setTimeout` fallback pump applied. And even if trimming had occurred it cannot explain "only pre-codex residue remains" |
| ⑤ Scrollback capacity too small | Both instantiation sites configure `scrollback: 10000`; a capacity problem would let the user scroll through 10,000 lines before topping out |
| ⑥ WebGL context loss hid the content | Zero context-lost events; and the content was visibly refreshing — contradiction |

### 3.4 The decisive arithmetic (unit-conversion validation, § 5.2b method)

Counter-assumption: if the overnight 8.21 MB had been line-appending output
(100–200 B/line) it would produce 40k–80k lines, filling the 10,000-line
scrollback ring ⇒ the user could scroll through ~435 screens. Observed:
"tops out almost immediately" ⇒ line-appending falsified ⇒ repaint stream
confirmed. **Lesson: for any "quantity X exceeded capacity C therefore data
was lost" argument, validate the X→C unit conversion first — here the
conversion factor was 0, not 1.**

### 3.5 Method lessons

1. **Ask about on-screen behaviour before fixing the root cause**: two
   hypotheses indistinguishable from the trace (② "cannot scroll" vs repaint
   stream's "scrolls a stub") were separated by one user answer. Ask with
   options that each map to a *different* root cause.
2. **The filename description + `feedback.json` are the primary input**;
   here `records` was empty, so the filename was everything.
3. **Salted hashes can still be decoded**: irreversible, but "the same hash
   recurring + time correlation with other events" identifies the payload
   (the focus-report pair).
4. **Rate-limited counts are floors only**; carry quantitative claims on an
   unaffected event (byte conservation used `terminal.ipc.send`, not
   `pty.output`).

## 4. Instrumentation added for this bug (landed 2026-07-22)

| Event | Tier | Site | Rate control | Question it answers |
|---|---|---|---|---|
| `main:terminal.screen-mode-changed` | main, default-on | `electron/main/ipc-handlers.ts` pty `onData` → pure classifier `electron/main/terminal-screen-mode.ts` (DECSET/DECRST 1049/1047/47, ED3, RIS; cross-chunk carry) | Transitions only / per-chunk aggregated counts | When did the app enter/leave the alternate screen? Did anything wipe the scrollback? (A/B verdict) |
| `renderer:terminal.scrollback-extent` | diagnostic, default-on | `terminal-session-manager.ts::emitScrollbackExtent` | Focused terminal 60 s heartbeat + once per surface-restore batch | Actual scrollback line count (`baseY`) and active buffer type — the one-shot measurement this case lacked |
| `renderer:terminal.wheel-to-arrows` | diagnostic, default-on | `terminal-session-manager.ts::noteWheelToArrows` (via `attachCustomWheelEventHandler`; xterm calls it only when no mouse protocol claimed the wheel) | 500 ms debounced aggregation per terminal | Was the user's wheel consumed by the TUI (direct alt-screen evidence)? |
| `renderer:terminal.pending-data-trimmed` | diagnostic, default-on | `terminal-session-manager.ts::noteTrimmedPendingData` (only when bytes were actually discarded) | First drop immediate + ≥1 s aggregation | Did the renderer buffer ever really drop data (hypothesis ④ becomes directly testable)? |

Unit tests: `test/unittest/terminal-screen-mode-classifier.test.mts`
(TSM-U-01..12 — locks the classifier state machine and carry semantics).
Behavioural autotest (amend `run-terminal-autofollow`: inject 1049 /
in-place-repaint / linear streams and assert `buffer.baseY`) is a tracked
follow-up.

## 5. Repro triage playbook (on the next "cannot see history" report, do this first)

1. **Query the landed events in the new bundle — do not re-do archaeology**:
   - `main:terminal.screen-mode-changed`: an `alt-enter` without a matching
     `alt-exit` inside the reported window → alternate screen active
     (sub-mechanism A confirmed); `ed3`/`ris` present → something wiped the
     scrollback (a DIFFERENT root-cause class: deliberate clears).
   - `renderer:terminal.scrollback-extent`: plot the terminal's `baseY` over
     time. `baseY` ≈ 0 for hours with `bufferType=normal` → repaint stream
     (sub-mechanism B); `bufferType=alternate` → sub-mechanism A; a large
     `baseY` that suddenly collapses → buffer was cleared (check ed3/ris/
     restartShell).
   - `renderer:terminal.wheel-to-arrows`: present at the moment the user
     "couldn't scroll" → the wheel was consumed by the TUI.
   - `renderer:terminal.pending-data-trimmed`: present → the renderer REALLY
     dropped data; branch to a data-loss investigation (different root cause
     from this bug!).
2. **One-minute live forensics** (when a repro machine is reachable): while
   the TUI runs, read the buffer via the Bridge API
   (`electron/main/api-server.ts` supports `?buffer=normal|alternate`) —
   check whether the alternate buffer is non-empty and whether the normal
   buffer's total line count grows with output.
3. **Control group**: run the same TUI in Windows Terminal on the same
   machine and compare scrolling — separates "TUI/ConPTY behaviour
   (consistent across terminals)" from "Onward-specific defect".
4. Only if all of the above look normal and history is still lost → walk the
   § 3.3 hypothesis list one by one (renderer rebuild, buffer clears,
   capacity, trimming).

## 6. Open questions

1. A/B sub-mechanism verdict: needs the next bundle with the new events, or
   one live Bridge-API forensics pass.
2. Whether the two 3-byte input groups at 17:25 were wheel conversions or
   keyboard arrows: the `wheel-to-arrows` event removes this ambiguity going
   forward.
3. The user has not yet run the Windows Terminal control; if WT scrolls the
   full history, the conclusion narrows to an Onward/xterm-side
   compatibility defect and must be revised per the incremental-update rule
   (keeping this version's reasoning chain).
4. Product-side improvements (scroll-hijack hint, transcript-snapshot
   feature) live in HTML report § 7; the transcript snapshot is
   cache-strategy-class work and requires explicit user sign-off before
   implementation.

## Update history (append-only)

| Date | Change |
|---|---|
| 2026-07-22 | File created. Root-cause analysis complete (HTML report v1.0); 4 trace events + 12 unit tests landed; awaiting next bundle to settle the sub-mechanism. |
| 2026-07-22 | Rewritten in English per repo-owner direction (bug-tracking docs are English; user-quoted symptom text stays verbatim). No factual changes. |
