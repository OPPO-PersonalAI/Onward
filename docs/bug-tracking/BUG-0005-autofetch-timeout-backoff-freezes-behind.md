<!--
SPDX-FileCopyrightText: 2026 OPPO
SPDX-License-Identifier: Apache-2.0
-->

# BUG-0005 — Task status-bar `↓behind` frozen: autofetch times out, backs off to 1 h, and pauses while hidden

| Field | Value |
|---|---|
| **Status** | **FIXED 2026-08-04** — strategy decisions R1 (A+B), R2 (no change), R3 (A) confirmed by the user against `docs/html/git-autofetch-recovery-strategy-options.html`; all five changes landed with paired unit + autotest coverage. Awaiting a field bundle to confirm WHY the user's two repos time out (§ 8 remains open — that is a data question the fix now makes answerable, not a code question) |
| **Reported** | 2026-08-01 (bundle generated 2026-08-01T15:40:17.954Z) |
| **Analyzed** | 2026-08-03 |
| **Code baseline** | `5ea30c6` (all `file:line` references below are pinned to this commit) |
| **App version in bundle** | `2.1.0-daily.20260722.1` (prod, `tag=v2.1.0-daily.20260722.1`), darwin arm64, Electron 39.8.5 |
| **Bundle** | `Logs/task 状态栏显示 git 分支跟远端的差异功能的似乎更新有延迟 - onward-diagnostic-2026-08-01_23-40-17.zip` |
| **Report** | `Logs/reports/…-autofetch-timeout-backoff-freezes-behind.html` |
| **Affected repos in bundle** | `Project_Books_Translation` (user-identified), `Project_Forward` — both 0/2 fetch success. `BattleProject` 3/5 success, unaffected |

---

## 1. Symptom (user's own words)

Bundle filename, typed by the user into the save dialog:

> `task 状态栏显示 git 分支跟远端的差异功能的似乎更新有延迟`

`feedback.json` `records` is empty, so the filename is the only written account. Three
follow-up questions were asked during analysis (on-screen state the bundle cannot record):

| Question | Answer | Effect on the analysis |
|---|---|---|
| Which number looked stale — `↑ahead` or `↓behind`? | Can't recall, just "out of sync overall" | Cannot lean on user memory; the trace has to decide |
| How did it eventually become correct? | **"Only after I ran `git pull` / `git fetch` myself"** | Decisive — points straight at "the app's own refresh never fired" |
| Which project? | **`Project_Books_Translation`** | **Corrected the initial read.** The manual `git pull` visible in the trace happened in `Project_Forward`, which had biased the first pass toward that repo |

---

## 2. Root cause (Confirmed)

Three mechanisms compound. None alone would be this bad.

### Semantic premise

`↓behind` is measured against the **local** `refs/remotes/origin/<branch>`. It cannot change
until something moves that ref — i.e. until a `git fetch` runs. This is stated in the source
itself (`electron/main/git-autofetch-scheduler.ts:10-13`). The app has **exactly one**
`git fetch` (`electron/main/git-autofetch-manager.ts:260`) and **no user-facing manual
fetch/pull button**. So: autofetch stalls ⇒ `↓behind` freezes permanently.

### Factor ① — every fetch hits the 20 s timeout, and the reason is discarded

- `FETCH_TIMEOUT_MS = 20_000` (`git-autofetch-manager.ts:54`).
- Observed durations: 20,007 / 20,009 / 20,010 / 20,013 ms — flush against the ceiling, i.e.
  **killed**, not naturally failed.
- `git-autofetch-manager.ts:268-272`: when `killedByTimeout` is true, `reason` is hard-coded to
  `'timeout'` and the existing `classifyFetchFailure(stderr)` is **short-circuited**;
  `:227-231` never puts stderr in the event payload. Auth-wall, unreachable remote and
  huge-payload all look identical in the trace.

### Factor ② — failure backs off to the 1 h ceiling and only a success resets it

- `computeAutofetchBackoffMs = min(base × 2^streak, maxMs)`
  (`git-autofetch-scheduler.ts:56-67`); base 10 min (`:43`), max 1 h (`:45`).
- `state.failureStreak = success ? 0 : state.failureStreak + 1` (`:138`).
- Observed `backoff.nextGapMs = 3_600_000` on the *first* logged failure of each repo → the
  streak was already saturated before the trace window (chunk numbering starts at 0212, so
  earlier history rotated out).
- **No user action resets it.** Tab switch, Task click, window focus — none shortens the gap.

### Factor ③ — autofetch fully pauses while the window is hidden

- `git-autofetch-scheduler.ts:149` `if (!this.enabled || !this.appVisible) return []`;
  `git-autofetch-manager.ts:177-180` records an empty-payload event and returns early.
- Observed: 935 × `main:git-autofetch.skipped-hidden` across
  `2026-07-28 22:12:28` → `2026-08-01 23:26:55` local (4.05 days); **0 fetch attempts** for the
  affected repos in that span.
- **The pause itself is correct behaviour** and the catch-up works (visible at 23:26:55 →
  fetch started 23:27:12, 17.8 s later, within the 30 s tick). The damage comes from stacking
  with factor ②: the single catch-up attempt times out and buys another hour of silence.

### Net effect for `Project_Books_Translation`

| Metric | Value |
|---|---|
| fetch attempts in 98.8 h of trace | 2 |
| fetch successes | **0** |
| gap between the two attempts | **97.7 h** (window hidden) |
| `behind` value changes in the whole trace | **0** |
| time to next scheduled attempt when the user reported | **47 min** (23:27 fail → 00:27) |

---

## 3. Key observations (what to look at first next time)

1. **`main:git-state-mirror.fanout` `deltaKeys` is the only default-on evidence that
   ahead/behind moved.** In this bundle 66 fanouts exist; only **2** carried a genuine `behind`
   change (`Project_Forward`, 23:40:14.473 and 23:40:18.768), both caused by the user's manual
   `git pull`. `Project_Books_Translation` had **zero**.
2. **Beware the eviction artefact.** 20 fanouts list `ahead`+`behind` in `deltaKeys` but are
   *not* value changes: they come in `status:"unknown"` → `status:"clean"` pairs ~1.3 s apart,
   each preceded by a `main:event-loop-stall` with `driftMs ≈ 925,864` (= system sleep). The
   mirror entry is rebuilt from empty on wake, so every field counts as "changed". Filter these
   out by requiring `deltaKeys` to contain `behind` **without** `ahead`.
3. **The delivery pipeline is fast, not slow.**
   `worker:git-state-mirror.refs-digest-changed` and the `behind`-carrying
   `main:git-state-mirror.fanout` share the **same millisecond** (23:40:14.473). Any hypothesis
   of "propagation latency" is dead on arrival.
4. **A same-second control exists.** At 23:27:12 all three repos started a fetch;
   `BattleProject` succeeded in 1,346 ms while the other two hit 20 s. Same machine, same
   network, same instant → the cause is repo-specific, not environmental.

---

## 4. Falsified hypotheses (the reusable part — do not re-walk these)

| Hypothesis | Verdict | Disproving evidence |
|---|---|---|
| The update pipeline is slow (worker computed it, UI got it late) | **Refuted** | `refs-digest-changed` and the `behind` fanout carry the identical timestamp 23:40:14.473 — sub-millisecond |
| The 4-day `hidden` was a BUG-0002-class visibility strand, wrongly suppressing autofetch | **Refuted** | Exhaustive scan of the hidden window: `pty.output`, `pty.write`, `renderer:ipc.terminal.write`, `pty.resize` **all 0**; 0 of 97 hours had terminal output; 0 window/visibility events. The app was genuinely idle in the background — the pause was correct |
| Network was down | **Refuted** | `BattleProject` fetched successfully in 1,346 ms at the same second (23:27:12) |
| The user meant `Project_Forward` (the repo with the visible `git pull`) | **Corrected** | User identified `Project_Books_Translation`. This *strengthened* the case: Forward's `behind` at least moved twice; Books_Translation's never moved at all |
| Rate limiting dropped autofetch events, so it may have succeeded unrecorded | **Refuted** | All 8 `trace-store:dropped-summary` records name terminal/watcher events. `main:git-autofetch.*` is not in the drop list — its counts are exact |
| Local recompute throttling dragged `behind` down with it | **Refuted** | Throttling is real (see § 5) but cannot affect `behind`: its only input is a move of `refs/remotes/origin/*`, which did not happen in 98.8 h. `git status` ran 8,256 times and read the same stale ref every time |

---

## 5. Secondary defect found en route (Confirmed, independent)

**System sleep contaminates the wall-clock duration measurement and pins the local reconcile
heartbeat at its 60 s ceiling.**

- Adaptive backoff: `effective = max(base, min(lastDurationMs × 4, 60_000))`
  (`git-reconcile-scheduler.ts:84-93`; factor at `:70`, cap at `:74`). Design intent (documented
  at `:56-69`) is to engage only when `git status` is genuinely slow (EDR spawn tax).
- Defect: the duration is wall-clock —
  `git-state-mirror-worker-entry.ts:630` `const startedAt = Date.now()`, `:650`
  `Date.now() - startedAt`. A system sleep between those two points is counted as status time.
- Evidence: `reconcile-backoff` `lastStatusMs` median **925,089 ms** (BattleProject) /
  **904,795 ms** (Books_Translation), matching `main:event-loop-stall` `driftMs` median
  **920,138 ms**. Resulting `nextIntervalMs` = **60,000 ms** (the cap). Healthy baseline for
  Books_Translation is only **79 ms** median (p90 85 ms).
- Impact: for at least one cycle after every wake, the affected repo's local status refreshes
  once a minute instead of once a second. Self-heals on the next clean measurement. Plausibly a
  small contributor to the user's "out of sync overall" impression, but **cannot** explain
  `behind`.

**Also noted (unverified):** `main:git-state-mirror.terminal-git-command` fired **once** in
98.8 h. The OSC 633 `E;` command-completion refresh trigger appears to be effectively inert —
either shell integration is not installed, or detection is broken. Low impact (the watcher on
`.git/refs/**` still catches ref moves) but worth a separate round.

---

## 6. Trace events — landed vs proposed

### Already landed (default-on; usable in any bundle)

| Event | What it tells you |
|---|---|
| `main:git-autofetch.scheduled` / `.started` / `.succeeded` / `.failed` / `.backoff` | The fetch lifecycle. `failed.reason` + `failed.durationMs` and `backoff.nextGapMs` are the core signal |
| `main:git-autofetch.skipped-hidden` | Autofetch paused. **Empty payload** — count only |
| `main:git-autofetch.triggered-recompute` | A success actually kicked a revalidate |
| `main:git-state-mirror.fanout` | `deltaKeys` — the only default-on proof that `ahead`/`behind` moved (never their values) |
| `worker:git-state-mirror.refs-digest-changed` | A ref actually moved (fetch/push landed) |
| `worker:git-state-mirror.reconcile-backoff` | `lastStatusMs` / `nextIntervalMs` — exposes the sleep-contamination defect in § 5 |
| `main:event-loop-stall` | `driftMs` ≫ 100 s means system sleep, not a stall. Use it to explain wake artefacts |

### Proposed (P0 first — see the HTML report § 6 for full args + rate control)

| Priority | Event | Question it answers |
|---|---|---|
| **P0** | extend `main:git-autofetch.failed` with `stderrTail` / `exitCode` / `killedByTimeout` / `classified` / `remoteScheme` | **Why** does the fetch time out? Today: unanswerable |
| **P0** | extend `worker:git-state-mirror.recompute-status-done` with `ahead` / `behind` / `hasUpstream` | What are the actual numbers? Today: only "it changed" |
| **P0** | extend `main:git-autofetch.skipped-hidden` with `repoCount` / `overdueCount` / `maxOverdueMs`, **and emit on state transition instead of every 30 s** | How much fetch work is owed? Today: 935 empty records |
| P1 | `renderer:git-state-mirror.update-received` (new, diagnostic tier) | Did the renderer receive the push? Today: **zero instrumentation** at `TerminalGrid.tsx:733-741` |
| P1 | `renderer:terminal-title.sync-rendered` (new, diagnostic tier) | What was actually painted? Today the existing `branch-rendered` is opt-in tier **and** only fires on branch-name change |
| P1 | `worker:git-state-mirror.duration-suspect` (new, threshold-crossing only) | Was this status duration sleep-contaminated? |

---

## 7. Repro triage playbook (next same-symptom bundle)

Run these in order. Steps 1–3 usually settle it in under five minutes.

1. **Count the autofetch outcomes per repo.**
   Filter `main:git-autofetch.*`, group by `args.repoRoot`. Tally `succeeded` vs
   `failed`. *Zero successes for the repo the user names ⇒ this bug, stop here.*
   Check `failed.reason` and `failed.durationMs`: a value flush against 20,000 ms means the
   process was killed at `FETCH_TIMEOUT_MS`, not that git returned an error.
2. **Check `backoff.nextGapMs`.** `3_600_000` on the first observed failure means the streak
   was already saturated before the trace window — the repo has been failing far longer than
   the bundle shows.
3. **Prove `behind` never moved.** List every `main:git-state-mirror.fanout` and keep only those
   whose `deltaKeys` contains `behind` **but not** `ahead` (the `ahead`-bearing ones are wake
   rebuild artefacts, see § 3.2). Zero surviving entries for the user's repo = confirmed.
4. **Rule out a wrongly-suppressed pause.** If `skipped-hidden` is large, verify the app was
   genuinely idle: `pty.output` / `pty.write` / `renderer:ipc.terminal.write` must all be **0**
   inside the hidden window. Non-zero ⇒ a different bug (visibility strand, BUG-0002 class).
5. **Look for the same-second control.** If several repos fetch at the same timestamp and some
   succeed, the network is fine and the cause is repo-specific.
6. **If P0 instrumentation has landed**, read `failed.stderrTail` / `classified` /
   `remoteScheme` directly — that is what this bug file exists to make possible.

---

## 8. Open questions

- **Why do these specific repos time out while `BattleProject` completes in 1.3 s?** Not
  answerable from this bundle. Cheapest next step: ask the user to run
  `time git fetch --quiet` in that repo and report the output.
- Remote type / scheme / credential method for the affected repos — not in the bundle.
- Whether the user's "out of sync overall" also covered local state (§ 5's defect) — user
  couldn't recall.
- Whether the near-total absence of `terminal-git-command` is missing shell integration or a
  detection bug.
- Who issued the 23:40 `git pull` — last keystroke was 23:37:57, effect at 23:40:1x, so likely
  an agent in the terminal rather than the user. Does not affect the conclusion either way.

---

## 8b. The fix as landed (2026-08-04)

Strategy decisions were put to the user as an explicit options document
(`docs/html/git-autofetch-recovery-strategy-options.html`, current-vs-proposed with
a timeline simulation driven by this bundle's real numbers) before any strategy
code was written, per the project's confirm-before-implementing rule. The user
chose R1 = A+B, R2 = no change, R3 = A.

| # | Change | Where | Note |
|---|---|---|---|
| R1-A | Focusing a Task grants its backed-off repo ONE backoff-bypassing fetch: requires `failureStreak > 0`, ≥60 s since the last attempt, and a 5 min per-repo cooldown. The streak is NOT reset, so an unattended dead repo keeps its 1 h cadence; worst case for the focused repo is 20 s per 5 min ≈ 6.7 % duty cycle | `git-autofetch-scheduler.ts::requestPriorityRetry`, `git-autofetch-manager.ts::handleRepoFocused`, routed via a new `git-state-mirror-router.ts::setRepoFocusListener` (inverted dependency — the manager already imports the router) | Deliberately NOT a streak reset: that would make the backoff vacuous |
| R1-B | A hidden → visible edge HALVES every failure streak | `git-autofetch-scheduler.ts::setAppVisible` (returns the affected count so the transition is traceable without the pure module tracing) | Idempotent on repeated same-value calls — the host fires it on show/hide/minimize/restore |
| R2 | **No change to `FETCH_TIMEOUT_MS`** | — | Deliberate. The cause of the timeouts is still unknown, and auth-hang vs slow-transport want opposite adjustments. R4 makes the next bundle answer it; tuning first would be guessing |
| R3 | `↓M` is de-emphasised (muted, normal weight) when a fetch has been attempted for that repo and **none has ever succeeded**. When `behind === 0` and stale it renders `↓?` instead of vanishing, because "no arrow" reads as "you are up to date", which is the exact false statement that produced this report. Tooltip gains a second line | `gitSyncDisplay.ts::resolveGitSyncFreshness` (pure), `TerminalGrid.tsx`, `TerminalGrid.css`, `src/i18n/core.ts` (en + zh-CN) | Fed by `lastFetchOkAt` / `lastFetchAttemptAt`, stamped onto the snapshot by the router and carried on the EXISTING mirror-delta channel — no new IPC surface. **Narrowed 2026-08-05** (see update history v1.2): staleness is attempt-based only, never time-based |
| R4 | The timeout branch now classifies stderr instead of discarding it. Failure events carry `killedByTimeout`, `classified`, `exitCode`, `remoteScheme` (transport CLASS only) and a redacted `stderrTail` | `git-fetch-failure-classify.ts` (new pure module), `git-autofetch-manager.ts::recordFailure` | The single highest-value change: it is what turns "we know it failed" into "we know why" |
| R5 | Recompute / status durations are sanity-checked before driving the adaptive backoff; a sample spanning a system sleep is discarded (reported as 0 = "no measurement") | `git-reconcile-scheduler.ts::sanitizeMeasuredDurationMs` (pure), `git-state-mirror-worker-entry.ts::settleDurationProbe` | Both clocks are sampled and the smaller believed, because whether `performance.now()` excludes suspend is platform-dependent; the 30 s ceiling catches the rest |

### Instrumentation landed

`main:git-autofetch.priority-retry`, `main:git-autofetch.streak-halved`,
`worker:git-state-mirror.duration-suspect`,
`renderer:git-state-mirror.update-received`,
`renderer:terminal-title.sync-rendered` (all registered in
`src/utils/perf-trace-names.ts`, indexed in `infra/trace.md` § 2). Enriched
payloads on `main:git-autofetch.failed`, `main:git-autofetch.skipped-hidden`
(now emitted on a change of the owed-work signature or every 10 min, instead of
every 30 s with an empty body) and
`worker:git-state-mirror.recompute-status-done` (now carries the ahead/behind
VALUES, not just the fact that they changed).

A second gap was closed during the same audit: `setFetchFreshness` silently
returned when no subscribed cwd matched the repo, so "published to nobody" and
"published but the renderer never applied it" were indistinguishable in a bundle
— the very ambiguity this bug is about. Rather than add a sixth event, the
router now returns its fanout count and the manager folds `freshnessFanoutCount`
into the `succeeded` / `failed` events it already emits.

**A rate-control defect was found and fixed by reading a real trace of the fix**:
`priority-retry` initially emitted on `unknown-repo` refusals, which fire on every
Task focus for any repo not yet synced — a 30 s slice of a test run produced 36
such records and zero useful ones. Both steady-state refusals
(`not-backed-off`, `unknown-repo`) are now suppressed.

### Verification

- `pnpm test:unit` — **148/148**, including 26 autofetch-scheduler cases
  (priority-retry grant/refusal matrix, halving idempotence, `overdueSnapshot`
  finiteness), 28 reconcile cases (duration sanity: smaller-clock preference,
  ceiling boundary, rejected sample → base cadence not the cap, EDR-slow host
  still stretches), 20 sync-display cases (stale table incl. the
  attempted-but-never-succeeded field case), and a new
  `git-fetch-failure-classify` file (18 cases: classification, userinfo/token
  redaction with tail preservation, scp-like transport).
- `run-git-autofetch-ahead-behind` — **11/11**. AB-08 measured `durationMs:
  20005`, `killedByTimeout: true`, and — the regression guard — a non-empty
  `stderrTail` plus a `classified` value on the branch that used to discard both.
  AB-07 `exitCode: 128`, `classified: no-remote`. AB-09/AB-10 confirm the
  freshness timestamps reach the renderer snapshot.
- `run-git-state-mirror*` / `run-gsm*` — **9/9**, no regression from the shared
  TerminalGrid render path or the router fanout change.
- Startup test: main process, renderer helper, clean shutdown all verified on the
  packaged dev build.
- Windows was validated **structurally, not executed**: the `.ps1` runner keeps
  full env/watchdog parity with the `.sh`, both drive the same fixture builder,
  and the new fixture repos use git's own shell (`ext::sleep`) and `path`-built
  paths. It has not been run on a Windows host.

## 9. Update history (append-only — never rewrite or delete a row)

| Version | Date | Branch | Summary |
|---|---|---|---|
| v1.0 | 2026-08-03 | master | Initial entry. Root cause Confirmed: autofetch 20 s timeout + 1 h backoff ceiling + hidden-window pause compound so `↓behind` never updated in 98.8 h (0/2 fetch success for `Project_Books_Translation`). Six hypotheses falsified with evidence (§ 4). Repo attribution corrected mid-analysis from `Project_Forward` to `Project_Books_Translation` per user identification. One independent secondary defect confirmed: wall-clock duration measurement contaminated by system sleep pins the reconcile heartbeat at its 60 s cap (§ 5). No product code modified. |
| v1.1 | 2026-08-04 | master | **Fixed.** Strategy options presented and confirmed by the user (R1=A+B, R2=no change, R3=A) before any strategy code was written. Five changes landed (§ 8b) with five new trace events, three enriched payloads, and paired unit + autotest coverage: unit 148/148, `run-git-autofetch-ahead-behind` 11/11 (new AB-07..AB-10; AB-08 exercises a real 20 s timeout kill and asserts the previously-discarded `classified` + `stderrTail`), `run-git-state-mirror*`/`run-gsm*` 9/9. A rate-control defect in the NEW `priority-retry` event was caught by inspecting a real trace of the fix and corrected before completion. The original root-cause analysis in § 2 is unchanged and was not overturned. § 8's first open question (why those two repos time out) remains open BY DESIGN — R4 is precisely what makes the next bundle able to answer it. |
| v1.2 | 2026-08-05 | master | **R3 narrowed on user decision.** The stale treatment had TWO triggers: (a) attempted-but-never-succeeded, and (b) the last success aged past 20 min. Trigger (b) is removed. Reason: it fired on every upstream-bearing repo within ~30 s of going offline, and re-fired after any sleep longer than the threshold, so the common case for seeing `↓?` would have been "user is offline" rather than "this repo is broken". **Accepted cost, now pinned by a unit test named `DELIBERATE NARROWING`: a repo that succeeds once and then fails for the rest of the session stays silent.** Re-covering that case needs a consecutive-failure count on the snapshot — it is NOT a matter of re-adding a threshold. Knock-on simplification: staleness became purely event-driven (it only changes when a fetch settles, which already produces a mirror delta), so the renderer's 60 s re-evaluation timer, its tick state, the `syncFreshnessNow` memo, the `now` parameter and the `GIT_SYNC_STALE_AFTER_MS` constant were all deleted, along with the now-unreachable `terminalGrid.syncStaleTitle` copy in both locales. Unit 148/148 after the change. |
| v1.3 | 2026-08-07 | master | **R3 reworked after peer research; the `↓?` marker is gone.** User feedback: the marker was conceptually confusing and offered no recovery path. Research across 7 products (git itself, GitHub Desktop, GitLens, GitKraken, Fork, Sublime Merge, Tower, VS Code, JetBrains) produced three findings that together condemned it: (a) **no product marks staleness on the ahead/behind count itself** — the two that signal anything put it elsewhere (GitKraken's REMOTES header icon, Fork's Activity Manager); (b) `?` already means something in git (`??` untracked, submodule `?`, git-prompt.sh sparse-checkout), so the confusion was a real symbol collision, not vagueness; (c) the recovery convention is that **the indicator IS the action** (VS Code status bar, Sublime Merge's clickable ahead/behind, GitHub Desktop's button) — and we were the only one of nine with no manual fetch anywhere. Landed: count left untouched; badge single-click → new `git.fetchNow` IPC (first manual fetch in the app; copy-branch moved to a right-click menu to free the click slot); always-present tooltip freshness line (`Last synced just now / N min / N h / date past 24 h` / `Not synced yet`), matching GitHub Desktop + GitLens incl. their relative→absolute switch. Per a follow-up user decision the ONLY failure detail surfaced is `Remote unreachable` (classified `network`) — auth / no-remote / bare-timeout stay in the perf trace because they are not actionable from a tooltip. Removed: `↓?`, the `--stale` styling, `behindUnknownAria`. New events `main:git-fetch.user-requested` + `renderer:git-sync.fetch-clicked`. Also corrected in the decision doc: an earlier claim that peers "generally" show a last-synced timestamp — only 2 of 7 do. Verified: unit 148/148 (incl. an `ipc-handler-symmetry` catch of a missing `removeHandler`), AB-01..13. See `docs/html/git-sync-staleness-ux-options.html`. |
