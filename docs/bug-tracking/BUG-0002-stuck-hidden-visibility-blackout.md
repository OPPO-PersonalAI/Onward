<!--
SPDX-FileCopyrightText: 2026 OPPO
SPDX-License-Identifier: Apache-2.0
-->

# BUG-0002 — Terminal/window black-on-foreground: stuck-hidden visibility + watchdog nudge amplification

## Metadata

| Field | Value |
|---|---|
| Status | Root-caused (High-confidence); fix pending user decision on strategy (R1–R5) |
| First analyzed | 2026-07-23 |
| Code baseline | tag `v2.1.0-daily.20260722.1` (commit 93e5f60); watchdog introduced in `2ef7a87` |
| Platform | macOS arm64 (Mac Studio), Electron 39.8.5, prod daily channel |
| Evidence | Live traces staged at `Logs/onward-live-trace-2026-07-23_13-03-terminal-black-on-foreground/` (8 chunks, 236,522 events, 0 bad lines, 101.9 min, 2026-07-23 11:21–13:03 local) |
| Report | `Logs/reports/onward-live-trace-2026-07-23_13-03-terminal-black-on-foreground-stuck-hidden-watchdog-nudge.html` |

## Symptom (user's own words)

> 「当前运行的 onward 版本为 07.22,出现了 terminal 中的内容花屏的问题。这个我们在上一个版本中修复过,但是还是出现了。每次升级完之后 + 从后台不可见时拉到前台,就会触发这种问题。」

Clarified via AskUserQuestion (decisive):

- On-screen appearance: 「界面变黑了,但是使用鼠标选择文本的时候是可以选中的,但是没办法显示出来。」 → whole-window black, DOM/input alive, zero frames presented. **NOT glyph-level garble.**
- Recovery: 「必须重启应用」.
- Upgrade link: 「升到 07.22 后开始」 (started with 07.22, not tied to each upgrade restart).

## Root cause (graded)

1. **Direct cause (Confirmed)** — renderer `document.visibilityState` strands at `'hidden'` with rAF frozen while the window is frontmost and focused (the 2026-07-20 incident class; Chromium/Electron 39 macOS occlusion desync). Probe evidence: `hasFocus:true + visibilityState:'hidden' + rafAlive:false` × 15 consecutive checks, 12:02:02→12:07:32 local. No BeginFrame → compositor presents nothing → black window; hit-testing/selection still work. User typed into a black terminal twice during the window (`renderer:ipc.terminal.write` ×2); pipeline kept flowing invisibly (`pty.output` ×1590 floor).
2. **Amplifier A — false-positive verdict model (High-confidence)** — `judgeVisibilityProbe` (`electron/main/visibility-health-model.ts:36-55`) uses only `win.isVisible() && !isMinimized()` as main-side truth (`visibility-watchdog.ts:147`). On macOS a fully-occluded window keeps `isVisible()===true` while Chromium legitimately marks the document hidden → every routine "covered by another app ≥60 s" background period is judged `mismatch` and runs the nudge ladder. 3 ladders fired in 1 h of normal use (12:02, 12:57, 13:01), all with probe `hasFocus:false` at first mismatch.
3. **Amplifier B — hide-show nudge unsafe while occluded (High-confidence)** — `applyHideShowNudge` (`visibility-watchdog.ts:115-127`) does `win.hide()` (→ WasHidden → compositor frame eviction) + `show()/showInactive()`. Failure fingerprint observed twice (12:02:02, 13:01:32): renderer flaps `visible→hidden` within 14 ms and then stays hidden. The confirmed 5.5-min stuck window began immediately after the first hide-show. Two readings (nudge *induced* the strand via occlusion-recompute race, vs user foregrounded at that instant and Chromium stranded spontaneously) — indistinguishable with current instrumentation (no main-side window lifecycle events); either way hide-show on a non-frontmost window is at best a no-op with an evicted frame, at worst the trigger. Side effect confirmed at 12:57: `showInactive()` pops the occluded window above the user's active app uninvited.
4. **Amplifier C — gave-up cooldown with no focus-triggered recheck (Confirmed)** — after a failed 5 s ladder, `VISIBILITY_NUDGE_COOLDOWN_MS = 300_000` (`visibility-health-model.ts:85`); watchdog wake sources are only 30 s interval + powerMonitor + screen events (`visibility-watchdog.ts:210-224`). A user foregrounding during cooldown stares at a black-but-alive window for up to ~5.5 min; the second ladder recovered in 2 s (12:07:30–34), proving recovery works but arrives far too late. Users restart instead — hence "必须重启".
5. **Why "started with 07.22" (High-confidence)** — the watchdog is new in 07.22 (`2ef7a87`, 07.13→07.22 range). Pre-07.22 nothing hide-shows the window during background periods; the underlying Chromium strand needed rare boundaries (display sleep / remote desktop). Post-07.22 every ≥60 s full-occlusion background runs a hide-show, converting a rare edge case into a routine hazard.

## Falsified hypotheses (keep — the reusable part)

| Hypothesis | Disproving evidence |
|---|---|
| Recurrence of the atlas-merge garble fixed in `022e3f2` (prior "花屏" fix) | Symptom is persistent full-window black with restart, not sub-second self-healing colored fragments; all 4 prior fix commits verified as tag ancestors (`git merge-base --is-ancestor`) |
| Leftover shared-atlas dirty-reference defect (dispose/rebuild cycle, ~0.35% red sampling) | All `surface-restore-batch` events in the incident window show `recreatedCount:0` (refresh-only, no rebuild churn); no mass dispose before onset; black ≠ glyph corruption |
| ANGLE-Metal GPU process crash (white-canvas class) | Zero `main:gpu.process-gone` in 101.9 min of trace |
| WebGL context lost without restore | Zero `context-lost`/`context-loss-fallback` events; keepalive shows 6 WebGL sessions alive throughout |
| Upgrade installation itself corrupts renderer state (per-upgrade-restart trigger) | User clarified "started with 07.22"; today's episodes occurred ~20 h after install in a manually restarted session |
| Fixes missing from the 07.22 package | Ancestor check passed for all four |

## Trace events involved (all existed pre-analysis; gaps drove the § instrumentation plan)

`main:visibility-watchdog.mismatch-detected` / `.nudge-applied` / `.recovered`, `renderer:visibility.recovery-push-received`, `renderer:window.visibility-change` / `.focus` / `.blur`, `renderer:xterm.renderer.document-hidden-keepalive` / `.refresh-after-restore` / `.surface-restore-batch`, probe responder `electron/preload/index.ts:2631-2653` (rafAlive = 2 rAF ticks within 250 ms).

Proposed additions (see HTML report § 6 for full rows incl. rate control): P0 `main:visibility-watchdog.check-verdict` (every non-healthy check, not just nudge time), P0 `main:window.lifecycle` (main-side show/hide/focus/blur with `trigger: user|watchdog-nudge` — the discriminator for Amplifier B's two readings), P1 `renderer:compositor.frame-heartbeat` (emit only when visible && rafTicks==0), P1 `refresh-after-restore` args += `{visibilityState, rafAlive}`, P1 `main:updater.state-changed`, P1 `main:visibility-watchdog.nudge-outcome`.

## Repro triage playbook (next same-symptom report)

1. Pull `main:visibility-watchdog.*` from the bundle first. `mismatch-detected` with `hasFocus:true + visibilityState:'hidden'` = the confirmed stuck state; note duration until `recovered` (or absence → user restarted).
2. Check the first mismatch of each ladder: `hasFocus:false` right after a `renderer:window.blur`/`visibility-change hidden` = the false-positive-on-occlusion path (Amplifier A) still firing.
3. Look for the 14 ms `visible→hidden` flap immediately after `nudge-applied {kind:'hide-show'}` = Amplifier B fingerprint.
4. `refresh-after-restore` bursts with zero visible recovery + `surface-restore-batch recreatedCount:0` = refresh landing on a frozen rAF pipeline (expected in the stuck state; do NOT misread as atlas churn).
5. Rule out the neighbor classes fast: `main:gpu.process-gone` (GPU crash class), `context-lost` (context-loss class), `recreatedCount>0` storms (atlas/dispose class).
6. If `main:window.lifecycle` / `check-verdict` events have landed by then, use them to settle the induced-vs-coincident question (open question #1).

## Open questions

1. Causality direction of Amplifier B (nudge-induced vs coincident user foreground) — blocked on `main:window.lifecycle` instrumentation.
2. Residual upgrade correlation beyond the watchdog's arrival — blocked on updater instrumentation + a 07.13 control run.
3. Windows/Linux exposure: occlusion→hidden semantics differ per platform; verdict-model fix must be reasoned per platform (Windows native occlusion tracking; most Linux WMs never set hidden).

## Update history (append-only)

| Date | Change |
|---|---|
| 2026-07-23 | Initial analysis from live prod traces; root cause graded; fix directions R1–R5 pending user strategy decision; HTML report v1.0 delivered. |
| 2026-07-23 | Cross-validated on a second machine (BUG-0003's bundle): two watchdog ladders at 05:10/05:12 local fired right after routine occlusion (probe `hasFocus:false`), one ending in `gave-up` — Amplifier A (false-positive verdict on legitimate macOS occlusion) confirmed machine-independent. That machine's user-visible failure went through a different chain (GPU crash → atlas, see BUG-0003); the two bugs share only the trigger surface (post-07.22 background→foreground wake). |
| 2026-07-23 (pm2) | **Upstream corroboration for Amplifiers A/B and the L1 hazard.** (1) electron#50250 + PR #39223 document that `setBackgroundThrottling(false)` on a minimized/occluded window causes an internal visibility-state desync in Electron — our L1 nudge toggles exactly that on exactly such windows, i.e. **the watchdog's own L1 rung is a known desync-bug trigger**, independent of (and in addition to) its GPU-crash adjacency. (2) The prod GPU-helper cmdline shows Electron itself ships `--disable-features=MacWebContentsOcclusion` (not set by us) — macOS window-stacking occlusion tracking is disabled, so the observed hidden states on this machine come from Space switches / app hide (window off-screen), which are unambiguously legitimate hidden states; the verdict model treating them as mismatches is thereby confirmed a false positive by construction. Fix directions R1 (occluded/legit-hidden = not-applicable) and R3 (no nudges on non-frontmost windows) are now upstream-corroborated, not just empirically motivated. |
| 2026-07-23 (pm) | **Revision — the "L1 throttle-toggle is cheap/invisible/safe" assumption is FALSIFIED** (bundle `onward-diagnostic-2026-07-23_14-31-01.zip`, same machine/session as the original analysis). 14 ms after an Amplifier-A false-positive ladder applied L1 `setBackgroundThrottling(false)` to an occluded window (14:27:01.526 local), the GPU process crashed (`gpu.process-gone {crashed, exitCode:5}`, .540) — window hidden throughout, no wake involved; hourly-scale crash rate makes coincidental 14 ms adjacency negligible, mechanism plausible (un-throttling a parked/occluded surface forces BeginFrame/surface activity on the ANGLE-Metal-fragile path). Graded High-confidence for this instance; general trigger rate unquantified (≥6 observed toggles across 2 machines, 1 crash). Original reasoning kept per revision rule: L1 was designed as the safe rung precisely because it avoids hide(); the flaw is that BOTH rungs mutate render-pipeline state of an occluded window. Also: second confirmed stuck window 14:27:03→14:30:27 (~3.5 min, focus+hidden, ended by user interaction during cooldown — Amplifier C re-confirmed), and the same 14 ms visible→hidden hide-show flap (third occurrence). Fix R1/R3 gains double payoff: removing occluded-window nudges also removes a GPU-crash trigger source. Compound-episode analysis: `Logs/reports/onward-diagnostic-2026-07-23_14-31-01-watchdog-nudge-then-gpu-crash-compound.html`. |
