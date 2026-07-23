<!--
SPDX-FileCopyrightText: 2026 OPPO
SPDX-License-Identifier: Apache-2.0
-->

# BUG-0003 — Wake-triggered GPU crash → auto-rebuild lands in shared-atlas dirty refs; garble immune to tab switching

## Metadata

| Field | Value |
|---|---|
| Status | Root-caused (High-confidence); fix pending user decision (R1 surgical vs R2 root fix); P0 atlas instrumentation proposed |
| First analyzed | 2026-07-23 |
| Code baseline | tag `v2.1.0-daily.20260722.1` (93e5f60); recovery mechanism introduced in `ac5c295` (new in 07.13→07.22) |
| Platform | macOS arm64 (machine 2, distinct from BUG-0002's Mac Studio), Electron 39.8.5, prod daily |
| Evidence | In-app diagnostic bundle staged at `Logs/terminal中的内容渲染有问题，即使切换 tab 也无法恢复，近期的改动引入的-onward-diagnostic-2026-07-23_05-57-40.zip` (8 chunks, 226,812 events, 0 bad lines, 191.1 min) |
| Report | `Logs/reports/terminal中的内容渲染有问题，即使切换 tab 也无法恢复，近期的改动引入的-onward-diagnostic-2026-07-23_05-57-40-gpu-crash-rebuild-atlas-dirty-refs.html` |
| Sibling | BUG-0002 (same trigger surface — post-07.22 background→foreground wake — different fault chain) |

## Symptom (user's own words, zip filename)

> 「terminal中的内容渲染有问题,即使切换 tab 也无法恢复,近期的改动引入的」

Context (chat): second machine, same repro recipe as BUG-0002 — "升级完后从后台唤醒 onward,出现了问题".

## Root cause (graded)

1. **Trigger (Confirmed)** — 30 ms after wake-from-background (`visibility-change visible` 05:52:45.426 local → `focus` .444 → crash .456), the GPU process crashed: `main:gpu.process-gone {reason:"crashed", exitCode:5, simulated:false}`. No app-side WebGL activity in the 12 ms gap (first refresh batch ~600 ms later) → the crash is in Chromium's own unocclusion/wake path (ANGLE-Metal class, electron#49904; known: does NOT dispatch `webglcontextlost`). Two wakes at 05:50:56/05:50:59 survived; the third crashed — probabilistic, wake-correlated.
2. **Recovery ran as designed (Confirmed)** — `ac5c295`'s broadcast → 6× `dispose-webgl`+`ensure-webgl` (reason `gpu-process-gone`) → `renderer:xterm.renderer.gpu-crash-recovery {sessionCount:6, recreatedCount:6, failedCount:0}` at .984.
3. **But the rebuild lands in the KNOWN unfixed shared-atlas dirty-reference defect (High-confidence)** — the module-level shared glyph `TextureAtlas` survives the mass dispose→rebuild with stale/unbound references (defect previously proven by RCS-STAG-01: post-warmup ~0.35% red unbound-slot sampling per frame, 5/5 trials, documented in `test/README.md` § 2 RCS row as a REAL production defect; suspect surface: atlas `ownedBy` bookkeeping / rebuilt renderer `_atlasTextures` version rebinding in `patches/@xterm__addon-webgl@0.18.0.patch`). After a real GPU crash all GPU-side textures are dead, so any rebinding gap is maximally exposed → rendering resumes but content is corrupted.
4. **Why tab switching cannot fix it (High-confidence)** — the atlas is shared across all config-identical terminals (RCS-ATLAS-01); a tab switch disposes/recreates addon instances which re-attach to the SAME poisoned atlas object. Behavioral fingerprint in trace: user did two tab round-trips at 05:52:50 (5 s after recovery!) and 05:53:01 — both ineffective — then blur/focus churn, then generated the bundle at 05:57:40.
5. **Why "recent changes introduced it" — user is right (High-confidence)** — `ac5c295` is new in 07.22. Pre-07.22 the same crash produced a permanently white canvas and opening/switching tabs DID recover it (manual rebuild). Post-07.22 the auto-rebuild converts white→garble and disables the folk remedy. The three atlas fixes (`022e3f2`/`f05fe9b`/`e8ba656`) were already in 07.13 (merge-base verified) — not a lost-fix regression.

## Falsified hypotheses

| Hypothesis | Disproving evidence |
|---|---|
| Same chain as BUG-0002 (stuck-hidden black window) | Document flipped visible normally post-crash (.985); zero watchdog mismatches in the incident window; symptom is corrupted content, not zero-paint black |
| context-lost path failed | Zero `context-lost` events — expected for this crash class (no event dispatched); recovery went via child-process-gone broadcast and completed |
| Atlas-merge transient garble recurrence (022e3f2 class) | That class is sub-second self-healing under heavy output; this one is persistent, crash-triggered, tab-switch-immune; fix is a 07.13 ancestor |
| Partial rebuild failure | `recreatedCount:6, failedCount:0`, all ensure `ok:true` |
| Watchdog nudge involvement | Last watchdog activity 05:15, 37 min before the crash |

Note: this bundle also independently re-validates BUG-0002's watchdog false-positive defect on a second machine (two ladders at 05:10/05:12 with probe `hasFocus:false` right after routine occlusion; one `gave-up`).

## Trace events involved

Existing: `main:gpu.process-gone`, `renderer:xterm.renderer.gpu-crash-recovery` / `.dispose-webgl` / `.ensure-webgl` / `.deactivate-staggered` / `.refresh-after-restore` / `.surface-restore-batch`, `renderer:window.visibility-change`.

Proposed (HTML report § 7): P0 `renderer:xterm.atlas.post-rebuild-integrity` (sparse pixel readback once per rebuild/tab batch — red-placeholder percentage; NEVER in the frame loop), P0 `renderer:xterm.atlas.lifecycle` (created|reused|released + ownerCount), P1 `gpu.process-gone` args += `msSinceLastWindowShow`/`msSinceLastUnocclude`, P1 `main:updater.state-changed` (shared with BUG-0002).

## Repro triage playbook (next same-symptom report)

1. Search `main:gpu.process-gone` first. Present → this bug's chain; check `msSince*` args (once landed) for wake correlation, and `gpu-crash-recovery` for `recreatedCount/failedCount`.
2. Look for the self-rescue fingerprint: `deactivate-staggered`/`dispose(hidden)`/`ensure(visible)` tab round-trips within seconds after `gpu-crash-recovery` = user saw corruption and tab-switching didn't help.
3. Once `renderer:xterm.atlas.post-rebuild-integrity` lands: a non-zero red-placeholder pct right after rebuild is the direct confirmation; zero pct with user-reported garble falsifies the atlas hypothesis → escalate to per-cell ground truth.
4. No `gpu.process-gone` but same symptom → check BUG-0002's chain (watchdog events) before assuming this one.
5. Deterministic repro: autotest simulate hook in `electron/main/gpu-crash-recovery.ts` (simulated gpu-process-gone) + RCS ground-truth cell checks; true-defect repro: run RCS-STAG-01 block BEFORE RCS-TRANSIENT in `run-render-corruption-stress` (documented "perfect reproducer" ordering). Caveat: the simulate path does not actually kill GPU textures — divergence between simulated and real outcomes localizes the defect (bookkeeping vs dead-texture re-upload).

## Open questions

1. Direct quantitative proof of atlas poisoning (blocked on P0 readback event).
2. Simulated vs real crash divergence (two sub-mechanisms, different fixes).
3. Machine-2 upgrade timestamp (blocked on updater instrumentation).
4. Crash-frequency baseline across machines — pull `error/gpuProcessCrash` telemetry distribution.

## Update history (append-only)

| Date | Change |
|---|---|
| 2026-07-23 | Initial analysis from in-app diagnostic bundle (machine 2); chain graded; fix directions R1 (fresh atlas on crash recovery) / R2 (root-fix patch bookkeeping) / R3 (post-rebuild self-check) / R4 (upstream bump) pending user decision; HTML report v1.0 delivered. |
| 2026-07-23 (pm3) | **Defect origin dated — the crash class was imported by OUR dependency bump (user's challenge confirmed).** Git archaeology: the repo ran Electron **35.7.5** from init (2026-03-26) until commit `532fe49` (2026-04-08, "Upgrade runtime and toolchain dependencies for security fixes") jumped straight to **39.8.5** — the only Electron change in repo history. The ANGLE-Metal nil-signal-event defect ships with the Electron 39 line (upstream reports: 39.2.7/39.3.0/39.4.0, Feb 2026); Electron 35 (Chromium ~134) predates it. Corroboration: zero white-screen/garble/GPU-crash records before April; the first render-corruption reports date from May (render-messy screenshot 2026-05-28), and the Space/tab white-screen investigations ran May→July. Escalation history after import: occlusion-instant-dispose era (Apr–Jul 13) = dispose-burst triggers; keep-alive `e8ba656` (07-13) removed dispose bursts but left parked-context wake flips; auto-recovery `ac5c295` (07-15) made crashes visible as garble; watchdog `2ef7a87` (07-22) multiplied trigger rate ~10× (local .ips: 1 crash/~6 days on 07.13 → 2 crashes/24 h on 07.22). Prior analyses treated "Electron 39 has this bug" as ambient fact without asking when WE started running 39 — the dead end worth recording. Consequence: the Electron 43 upgrade (batch 3) is not routine hygiene but the removal of the imported defect; its acceptance gate MUST be the occlusion-flip stress A/B (a version bump is exactly how the defect arrived — never ship one against this surface unstressed again). |
| 2026-07-23 (pm2) | **Upstream-status correction + backend verification (falsifies two prior assumptions).** (1) electron#49904 was NOT "closed without fix" (prior memory/BUG record wrong): closed 2026-03-04 as Completed — Cursor's fix = Electron ≥39.5.2 (we run 39.8.5 ✓) + drop `--disable-skia-graphite`, because their crash sat on the Skia-Ganesh IOSurface EndAccess path; root cause per thread = nil entries in ANGLE Metal `mPendingSignalEvents` → NSArray insert throws in `CommandEncoder::reset` (`mtl_command_buffer.mm:1158`) (github.com/electron/electron/issues/49904). (2) We verified our backend: bare Electron 39.8.5 on the incident machine reports `skia_graphite: enabled_on`, `skiaBackendType: "GraphiteDawnMetal"`, and the running prod app's GPU-process cmdline contains NO Graphite-disabling switch → **we already run Graphite; the #49904 prescription does not transfer**. Our crashes reach the same ANGLE nil-signal-event defect via the WebGL *producer*-side `eglReleaseTexImage`/IOSurface access (6 terminal WebGL canvases), which Graphite does not bypass. Head-on levers therefore: Electron major upgrade (39 is EOL since 2026-05-05; latest 39.x=39.8.10, supported=41/42/43, Chromium 146–150 — no explicit upstream ANGLE fix CL found, upgrade = probabilistic + mandatory hygiene), custom ANGLE patch + self-built Electron (heavy), or removing/reducing the WebGL crash surface app-side. Also noted: Chromium GPU crash-limit auto-fallback ladder (~3 crashes → software; content/browser/gpu/fallback.md) interacts with our recovery design. Electron ships `--disable-features=MacWebContentsOcclusion` by default (seen in prod GPU helper cmdline) — background context for the sibling BUG-0002. |
| 2026-07-23 (pm) | **Chain confirmed NOT machine-specific**: machine 1 (Mac Studio, BUG-0002's machine) hit the same-signature crash (`exitCode:5`) at 14:27:01 local (bundle `onward-diagnostic-2026-07-23_14-31-01.zip`), followed by the same recovery (`recreatedCount:6, failedCount:0`) and the same tab-round-trip-within-seconds self-rescue fingerprint (14:30:38) — two machines, same day, one crash each. Two new observations: (a) crash antecedent class widened — this crash followed a watchdog L1 `throttle-toggle` on an occluded window by 14 ms (see BUG-0002 pm revision), not a wake; the common denominator is "render-pipeline state flip at an occlusion boundary". (b) **The recovery rebuild executed entirely on a hidden document** (rAF frozen) — rebuild-while-invisible cannot be paint-verified; fix R1 should either defer rebuild to next document-visible or re-verify then. P1 crash-correlation args promoted to P0 with fields msSinceLastThrottleToggle/msSinceLastNudge added. Compound-episode analysis: `Logs/reports/onward-diagnostic-2026-07-23_14-31-01-watchdog-nudge-then-gpu-crash-compound.html`. |
