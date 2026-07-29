<!--
SPDX-FileCopyrightText: 2026 OPPO
SPDX-License-Identifier: Apache-2.0
-->

# BUG-0004 — Git Diff reopen reveals the STALE diff's first change (and leaves the file fully expanded)

| Field | Value |
|---|---|
| **Status** | **FIXED and verified 2026-07-27.** Full regression 108 passed / 0 failed / 0 flaky. The formerly-unverified link is closed: `renderer:git-diff.model-sync` now rides the diagnostic tier. Three sibling defects of the same family were found and fixed alongside (see § 9). |
| **Reported** | 2026-07-26 (bundle generated 2026-07-26T12:02:46.456Z) |
| **Analyzed** | 2026-07-27 |
| **Code baseline** | `470a003` (master) · app 2.0.1 dev · Electron 43.2.0 · **monaco-editor 0.55.1** |
| **Platform observed** | macOS arm64 (mechanism is platform-independent — pure renderer/Monaco logic) |
| **Bundle** | `Logs/git diff 进入的时候并没有直接定位到差异点，而是全内容展开了 -onward-diagnostic-2026-07-26_20-02-46.zip` |
| **Report** | `Logs/reports/…-warm-model-stale-diff-reveal.html` |
| **Regression origin** | The `warm-ready` fast path introduced by `4891fc9` (2026-07-18) — the fix for the PREVIOUS warm-reopen bug created this failure mode. |

---

## 1. Symptom (user's own words)

> git diff 进入的时候并没有直接定位到差异点，而是全内容展开了
>
> 类似的问题我们之前修复过，但是还是出现了。

The sentence carries **two independent facts** — do not merge them:

- **Fact A** — the viewport did NOT land on the first change; it sat at the top of the file.
- **Fact B** — `hideUnchangedRegions` did NOT collapse anything; the whole file rendered expanded.

**On-screen state confirmed with the user afterwards** (the bundle cannot record this):

| Question | Answer | Why it mattered |
|---|---|---|
| What did the file look like on screen? | **Normal modification colors (red/green), but not collapsed and not scrolled to the change** | Falsified the first reading ("the stale diff was what got rendered"). The fresh diff DID paint; the defect is in the decision moment plus the collapse state. |
| When does it happen? | **Only when the file's git state changed between the two views** | Matches a deterministic "models re-synced but old diff/collapse state carried over" defect, not a probabilistic race. |

---

## 2. Root cause

**Git Diff reuses ONE Monaco `DiffEditor` and ONE pair of models across close/reopen AND across a change in the file's git identity.** The model URI is built from *repo hash + side + path only* — it carries **no `changeType` and no content signature**. When new content is written into those warm models via `setValue`, Monaco deliberately keeps two things and carries them into the next round:

1. **the previous `_diff` result** — `getLineChanges()` reads it and returns a STALE value for at least the 200 ms debounce window;
2. **the previous unchanged-region visibility state** — `updateUnchangedRegions()` explicitly transfers it ("Transfer state from cur state").

Onward's `warm-ready` fast path reads (1) 47 ms later as if it were current → **Fact A**. Monaco's own carry-over of (2) marks every newly-computed collapse region as already-expanded → **Fact B**. **Two symptoms, one root cause.**

### The concrete defect, in one line

`buildGitDiffFileKey()` includes `changeType`; `buildGitDiffModelPath()` does not. The file-identity layer correctly treats "untracked SKILL.md" and "unstaged/M SKILL.md" as two different things; the Monaco model layer thinks they are the same.

```
// diffViewMemory.ts:33  — file identity: HAS changeType
`${repoRoot}::${file.changeType}::${file.status}::${original}::${file.filename}`

// GitDiffViewer.tsx:1212 — model URI: does NOT
`inmemory://model/onward-git-diff/${repoSegment}/${side}/${path}`
```

### Causal chain (each step evidenced)

| # | Step | Evidence |
|---|---|---|
| ① | Production ALWAYS runs panel mode, so the models are never disposed | `GitDiffViewer.tsx:2928` (`if (isPanel) { disposeDiffEditorBindings(); return }`) + `TerminalGrid.tsx:3288` hardcodes `displayMode="panel"` and is the ONLY production mount (wrapped in `SubpageSubtreeFreeze` = frozen, not unmounted) |
| ② | Model URI matches even though the file's git identity changed | `GitDiffViewer.tsx:1212-1223` vs `diffViewMemory.ts:33-36`; the `modelsMatch` gate at `1793-1795` compares URIs only |
| ③ | Reopen wipes the body cache, but the whole-list prefetch immediately refills it → the click is a cache HIT and syncs models in the same synchronous turn | `GitDiffViewer.tsx:3563-3568` (wipe) → `4451+` prefetch loop ("No top-N cap") → `4082-4091` (`file-load-memory-hit` emit immediately followed by `syncCurrentDiffEditorModels`) → `3973-3974` `setValue` |
| ④ | Monaco does NOT clear `_diff` on content change — it only flags `_isDiffUpToDate = false` and schedules a **200 ms** debouncer | monaco 0.55.1 `diffEditorViewModel.js:86` (debouncer=200), `:170-186` (content-change handler), `diffEditorWidget.js:340-346` (`getLineChanges()` reads `_diff`) |
| ⑤ | The warm-ready gate tests `getLineChanges() !== null`, which means "a diff was computed at some point", NOT "this diff matches the current content" | `GitDiffViewer.tsx:1801-1806`. Monaco itself guards its own diff-consuming APIs with `isDiffUpToDate.get()` at `diffEditorWidget.js:361/375/388`, and exposes `waitForDiff(): Promise<void>` publicly (`editor.api.d.ts:2567`) |
| ⑥ | Stale `changes[0]` → `revealTargetLine = 1`; because the stale array is non-empty, the "park a one-shot reveal" branch is skipped; phase goes `idle` | `GitDiffViewer.tsx:5434-5440` (reveal), `5459-5462` (park branch skipped), `5489-5490` (`idle`) |
| ⑦ | ~200 ms later the real diff lands and `onDidUpdateDiff` fires — but `requestDiffRevealRestore` early-returns because the phase is no longer `waiting-diff`. **Both self-heal paths are dead.** | `GitDiffViewer.tsx:1743-1744`; trace shows NO further decision until the user manually refreshed 10 s later |
| ⑧ | **Fact B**: the previous diff was of an UNTRACKED file (`originalLen = 0`) → `UnchangedRegion.fromDiffs()` returned `[]` → `_unchangedRegions = {regions: []}` (truthy!) → on recompute `hiddenRegions = []` → `visibleRegions = inverse([], wholeFile) = the whole file` → every new collapse region is marked fully visible | `diffEditorViewModel.js:125-168` ("Transfer state from cur state"), `:346-365` (`fromDiffs`), `:54` (`_unchangedRegions` initialised to `undefined`, but truthy once ever set) |

### It is deterministic, not a flaky race

`setValue` is synchronous and schedules the debouncer synchronously (+200 ms); `maybeCompleteWarmReveal`'s first rAF tick arrives ~16 ms later. **Whenever the warm-model + cache-hit path is taken, the gate necessarily reads a stale diff.** It usually goes unnoticed only because when the content did NOT change, the stale diff equals the correct diff.

---

## 3. Analysis walk (as it actually happened)

### Key observations from the bundle

- `renderer:git-diff.restore-decision` appears exactly **6 times across the entire 2-month / 104,509-event trace**. `trigger: "warm-ready"` appears **exactly once** — and that once is the reported failure.
- The failing record: `{action: "reveal-first-change", reason: "no-saved-position", trigger: "warm-ready", revealTargetLine: 1}` at `12:02:30.326Z`.
- The healthy records the same session: `revealTargetLine: 14` and `26`, both `trigger: "diff-computed"`.
- **The 47 ms gap.** `file-load-memory-hit` at `12:02:30.279Z` → decision at `12:02:30.326Z`. Monaco's debounce alone is 200 ms. The diff read at the decision cannot correspond to the content bound 47 ms earlier.
- **The changeType transition.** Same file 16 minutes earlier at `11:45:58.540Z`: `changeType=untracked, originalLen=0, modifiedLen=14321`. At failure: `changeType=unstaged/M, originalLen=15776, modifiedLen=17177`. The user had `git add`+committed it in between.
- **User behaviour corroborates the symptom**: manual `Refresh Changes` at `12:02:40.873Z` (945 ms), whose decision at `12:02:42.198Z` was `restore-scroll / trigger=timeout` — the refresh restored wherever the user had scrolled to, never re-revealed. Bundle generated 4 s later.
- Data layer was fully healthy: `get-diff` 13.5 ms, three `get-file-content` at 1–2 ms each, all cache hits; no `event-loop-stall` inside the window.
- Rate limiting: 7 `trace-store:dropped-summary` events, all on `terminal.task.state` / `pty.output` / `terminal.ipc.send` / `watcher-fire`. **No git-diff reveal-path event was dropped** — the counts above are exact, not floors.

### Falsified hypotheses (the reusable part)

| Hypothesis | Disproving evidence |
|---|---|
| **Line 1 really IS the first change; the feature worked** | If so, `hideUnchangedRegions` (`minimumLineCount: 3`, `GitDiffViewer.tsx:6203`) would still have collapsed the rest, and the user would not have seen the whole file expanded. Independently: 47 ms < 200 ms debounce makes the read provably not of the current content. |
| **The stale (untracked-era) diff is what the user SAW on screen — all green, whole file "added"** | **Falsified by the user**: they reported normal red/green modification colors. The stale frame exists for ~200 ms, below the threshold of noticing. This forced the correct explanation for Fact B (Monaco's collapse-state carry-over) instead of "the stale diff was rendered". *This was the most useful correction in the whole analysis.* |
| **The data layer was stale / served old content** | `file-load-memory-hit` shows `originalLen=15776 / modifiedLen=17177` — the post-`git add` state, not the untracked one (`0 / 14321`). Data layer converged correctly. |
| **4891fc9's viewport-goal self-heal failed** | `renderer:git-diff.viewport-goal` is **diagnostic tier, default-on**, and is entirely ABSENT from the bundle. Revealing line 1 lands at `scrollTop 0` with `delta = 0` — inside budget, so no park was ever needed. The self-heal was never involved. |
| **Manual Refresh Changes should recover it** | Trace: `12:02:42.198Z` decision is `restore-scroll / timeout`. Refresh restores the scrolled-to offset and never re-reveals. |
| **`hideUnchangedRegions` was turned off** | `GitDiffViewer.tsx:6203` is a static `useMemo` with `enabled: true`; there is no runtime toggle. |
| **Main-process / git slowness caused the timing anomaly** | All git work in the window was 1–14 ms and cache-hit; the 4 `event-loop-stall` events fall outside the window (the largest, drift 1679 ms, is the bundle-zipping itself at 12:03:19). |

### Why the existing regression test (GDS-52) could not catch it

`src/autotest/test-git-diff-staleness-and-submodule.ts:1126-1132` builds `v1` and `v2` that both edit **line 600**, and asserts `revealTargetLine ∈ [590, 610]`.

- **The stale first-change line equals the fresh first-change line.** The assertion is mathematically incapable of distinguishing "read the old diff" from "read the new diff".
- The case only exercises **tracked → tracked** content change; it never crosses the **untracked → unstaged** changeType transition that makes the two line numbers differ.
- It asserts **nothing about collapse state** — Fact B has zero coverage anywhere in the test suite.
- It calls `selectFileByPath` as soon as the list appears, racing the prefetch; a cache MISS routes through `loading` → the safe deferral path, so the warm-ready gate (which requires `!state.loading`) never even fires. **The user's real path is a cache hit; the test's common path is a cache miss.**

---

## 4. Trace events

### Already landed (used in this analysis)

| Event | Tier | What it gave us |
|---|---|---|
| `renderer:git-diff.restore-decision` | diagnostic (default-on) | The decisive record: `trigger`, `action`, `reason`, `revealTargetLine` |
| `renderer:git-diff.file-load-memory-hit` | diagnostic (default-on) | `changeType` + `originalLen`/`modifiedLen` at both views → proved the git-state transition and the cache hit |
| `renderer:gitdiff.open`, `renderer:git-diff.manual-refresh`, `renderer:git-diff.cache-invalidation` | diagnostic | Framed the window and proved refresh does not recover |
| `renderer:git-diff.viewport-goal` | diagnostic | **Its ABSENCE** ruled out the self-heal hypothesis |

### Proposed (see the HTML report § 6 for full arg/rate-control specs)

| P | Event | Status | Question it answers |
|---|---|---|---|
| P0 | `renderer:git-diff.model-sync` | **exists, gated off** — promote `perfTrace` → `perfTraceDiagnostic` | Did `setValue` actually run at the click, with what lengths? **Closes the one inferred link.** Cheapest, highest value. |
| P0 | `renderer:git-diff.warm-ready-gate` | new, `ph='i'` | Was `isDiffUpToDate` false when the gate passed? `diffUpToDate:false` turns the whole chain into Confirmed. Emit once per gate pass, never per rAF tick. |
| P0 | `renderer:git-diff.collapse-state` | new, `ph='i'` | Were unchanged regions actually collapsed? **Today completely invisible.** 250 ms debounce; never on `onDidContentSizeChange` directly. |
| P1 | `renderer:git-diff.model-identity-reused` | new, `ph='i'` | Was the model URI reused while `changeType`/signature changed? Emits only on the transition. |
| P1 | `renderer:git-diff.restore-decision` | extend args | Add `changeType`, `prevChangeType`, `diffUpToDate` so a state transition is self-evident in the record. |

---

## 5. Repro triage playbook (read this FIRST on the next same-symptom report)

**Symptom keywords that route here:** Git Diff opened but didn't jump to the change / viewport at top / whole file expanded / not collapsed / 没定位到差异点 / 全内容展开 / 没折叠.

Check in this order:

1. **`renderer:git-diff.restore-decision` in the failure window.**
   - `trigger === "warm-ready"` → **this bug**. Look at `revealTargetLine`; `1` (or any value that matches the file's PREVIOUS state rather than its current one) confirms it.
   - `trigger === "diff-computed"` / `"deferred-diff-computed"` → the reveal read a current diff. Different bug — look elsewhere.
   - `trigger === "timeout"` → the 2 s safety path; that is the **BUG-0001-era / 2026-07-18** signature, not this one.
2. **Measure the gap** between the preceding `renderer:git-diff.file-load-memory-hit` (or `model-sync`, once promoted) and the decision. **< 200 ms ⇒ the diff read was necessarily stale** (Monaco's debounce floor). This single arithmetic check is the fastest confirmation available.
3. **Compare `changeType` across the two most recent `file-load-memory-hit` records for the same filename.** A transition (`untracked → unstaged`, `unstaged → staged`, a commit in between) is the amplifier: it makes the stale and fresh first-change lines differ. Same `changeType` on both sides ⇒ the stale read is invisible and this is probably NOT the user's complaint.
4. **`renderer:git-diff.viewport-goal` absent?** Then the self-heal was never triggered — do not go down that path (it is default-on; absence is meaningful).
5. **Once P0 events land**: `warm-ready-gate.diffUpToDate === false` is the direct proof; `collapse-state.unchangedRegionCount === 0` on a file that clearly has unchanged stretches is the direct proof for Fact B.

**Do NOT** re-derive the Monaco semantics from scratch — they are pinned above with file:line against monaco-editor 0.55.1. Re-verify only if the monaco version in `package.json` has moved.

---

## 6. Fix directions (not implemented — see report § 7 for trade-offs)

- **A. Gate `warm-ready` on diff currency**, not on `getLineChanges() !== null`. Use `waitForDiff()` (public API) or a `modelSyncSeq` vs `lastDiffSeq` comparison. Ordinary bug fix. Fixes Fact A only. Must not regress 4891fc9's original win (unchanged content must still skip the 2 s timeout — it will, because `isDiffUpToDate` is already true there).
- **B. Make the model URI carry content identity** (align `buildGitDiffModelPath` with `buildGitDiffFileKey`). **The only direction that fixes Fact A and Fact B together**, because both stem from reusing one view model across a content-identity change. **Strategy-level (cache identity / invalidation granularity) → requires explicit user confirmation before implementation** per the project's hard rule.
- **C. Explicitly reset the collapse state** — Monaco exposes no public reset; the realistic implementation is recreating the models, i.e. it collapses back into B. Not recommended standalone.
- **D. Keep one corrective chance** — do not slam the phase to `idle` when the reveal was made while `diffUpToDate === false`; arm a one-shot re-reveal for the confirming `onDidUpdateDiff`. Cheap defence-in-depth, independent of A/B.

**Regardless of which lands, GDS-52's fixture blind spot must be fixed in the same change set**, or the gate stays blind to this defect class.

## 7. Test plan (paired deliverable)

- **Unit** — `test/unittest/git-diff-view-memory.test.mts` (**amend**): extract the warm-ready gate predicate into `diffViewMemory.ts` and pin it like the existing DRD-01..10 table. Core case: `diffUpToDate === false` ⇒ must return false regardless of `lineChanges` length.
- **Autotest** — `run-git-diff-reentry` (**amend**; GDS-52/53 already live there, so no `SCRIPTS` edit):
  (a) fix GDS-52's fixture so v1 and v2 change **different** lines;
  (b) GDS-54 — untracked → add+commit → edit a LATE line → reopen → **wait for the prefetch so the click is a memory hit** → assert `revealTargetLine` hits the real change line and ≠ 1;
  (c) GDS-55 — collapse-state assertion (depends on the P0-3 probe).
- **Timing sensitivity**: boolean-correctness class ⇒ **N=5 trials inside the test, all must pass**. `--repeat` is a secondary tool only. Waiting for the memory hit (not a sleep) is a structural requirement of the case — a cache miss silently routes to the safe path and reproduces GDS-52's blind spot.

---

## 8. Open questions

1. **Did `plan.needsSync` really evaluate true at the click?** The one inferred link. `renderer:git-diff.model-sync` is opt-in-tier and absent. Promoting it (P0) settles it.
2. **Was the reused model's previous diff genuinely the 11:45 untracked one?** The trace does not record Monaco model lifetimes; the model could in principle have been rebuilt in the intervening 16 minutes. `model-identity-reused` (P1) with `prevChangeType` answers it.
3. **Blast radius.** Source-wise, ANY content change takes the collapse-inheritance branch; the degradation is just less visible when the previous collapse topology was reasonable. Once P0 lands, measure the share of `warm-ready` events carrying `diffUpToDate:false` over a few days of real traces.
4. **Does Git History have the same defect?** `GitHistoryViewer.tsx:735` configures `hideUnchangedRegions` too. Whether it shares the model-reuse + reveal pattern was not audited in this round.

---

## 9. What the fix actually consists of (and the eight defects introduced while building it)

Four production changes, all in `src/components/GitDiffViewer/`:

1. **Base identity in the model URI AND the React key** — `buildGitDiffBaseIdentity()` (changeType + status + full-content hash of the base) rides `buildGitDiffModelPath()` and `diffEditorIdentityKey`. Both, because `DiffEditorWidget` derives its view model solely from its own `setModel` and does not observe the inner editors, so a re-path without a re-key would leave the widget diffing models it no longer displays.
2. **Diff-currency gate** — `isDiffCurrentForBoundModels()` (URI pair + write seq) replaces `getLineChanges() !== null`, extracted as the pure `shouldCompleteWarmReveal()` for unit pinning.
3. **Disposal sweep** — superseded `onward-git-diff` models are reclaimed; the widget's models are released (`setModel(null)`) before any disposal so Monaco's ordering invariant holds.
4. **View-model rebuild after a full-content write** — `setValue` takes TextModel's flush path and destroys the decorations Monaco tracks unchanged-region positions with, so `hideUnchangedRegions` silently stops collapsing; rebuilding resets that state. Guarded on "a diff had already been computed", because there is no region state to lose on first population.

Plus two sibling defects the work exposed:

- **The view-memory content signature was sampled** (head + tail + length). An agent swapping one line for another of equal length reported "unchanged", so the restore-vs-reveal decision restored a position belonging to content the user had never seen. Now a full-text hash (`buildGitDiffContentSignature`, pinned by CSG-01..04). Found BY GDS-54, not by review.
- **`git:warm-diff-cache` could throw at quit** — renderer used `void` (which suppresses the lint but attaches no rejection handler) and the main handler let the disposed-worker error escape. A cache warm must never throw. *Note: this was chased for two rounds as the cause of a subpage-navigation failure and was NOT that cause; the fixes are correct hardening but incidental to this bug.*

### The eight defects introduced while building the fix

Every one was caught by a test; none reached a commit. The pattern is uniform and worth more than the fix itself: **each came from asking "should I intervene here?" instead of "what is this defect's existence condition?"**

| # | Defect | The premise that was wrong |
|---|---|---|
| 1 | Sweep computed its retained set at schedule time, disposed 100 ms later | "the binding at schedule time is the binding at disposal time" — a detach→remount fits inside that window |
| 2 | An intermediate `onDidUpdateDiff` consumed the one-shot corrective reveal without applying it | "every diff event is a terminal state" — Monaco emits one per computation |
| 3 | Defensive "retain what the live widget holds" protected stale models on the detach path | "`diffEditorRef` non-null ⇒ the widget is alive" — panel mode deliberately keeps the ref past unmount |
| 4 | View-model rebuild fired on first population too, discarding the computation the reveal cycle was waiting on | "collapse state always needs resetting" — it only needs it when there IS state to inherit |
| 5 | GDS-54 sampled the decision at first-existence | "the first decision is the final decision" — true before a corrective pass existed |
| 6 | GDS-52 had the identical sampling flaw | changing a state machine's semantics invalidates assertions written against the old ones — **check every existing assertion that shares the assumption, not just the one you just wrote** |
| 7 | Renderer-side `.catch()` added; main-process handler still threw | "the symptom went quiet ⇒ the cause is gone" — one error had two independent exits |
| 8 | Sweep disposed models a live `DiffEditorWidget` still referenced | the whole `trustLiveEditor` question was the wrong question: the fix is not "decide whether to trust the ref" but "release the reference, then dispose" |

**Two of these (#7, #8) came from the same investigation failure**: reading a plausible-looking error out of surrounding log noise instead of reading what the guard actually captured. `AT-RT-no-runtime-errors` logs `runtime-issue-captured` with the full stack; reading it first would have pointed straight at `TextModel got disposed before DiffEditorWidget model got reset`. Two rounds were spent fixing an unrelated (real, but incidental) error. **When exact evidence is available, do not infer from circumstantial evidence.**

### Test-authoring lesson (twice-repeated)

GDS-52's original blind spot — v1 and v2 both editing line 600, so a stale read and a fresh read produce the same number — was reproduced by me twice more: in GDS-54's first draft (identical bytes per trial) and in the MT suite (same). **A case whose correct and incorrect answers are indistinguishable cannot fail.** Every fixture here now moves the edit between versions/trials so a stale read is a wrong ANSWER, not a coincidence.

## 10. Round 2 — the reconciliation model (2026-07-28/29)

The § 9 fix made the reveal *correct*; it did not make it *simple*. Four trigger
paths still each carried their own local answer to "may I decide now", two of
which structurally could not honour the contract (`timeout` decides on a clock;
`model-bound` decides off an in-flight click-latency measurement, i.e. the
viewport's correctness depended on whether performance instrumentation happened
to be running). Round 2 replaced that with a state that converges.

### The shape

Every applied position records WHICH content it was computed from. A record
that no longer matches the live content is **stale** — a pure comparison,
checkable at any instant, with no notion of "when". Staleness then converges,
silently unless the user owns the viewport.

    not stale  =>  the applied position was computed from the current content

`resolveRevealReconcile()` is the whole decision, four rows, unit-pinned
exhaustively (RRC-01..08, including a 36-combination totality check).

**What this deleted**: `REVEAL_CORRECTION_WINDOW_MS` (a 3 s deadline — pure
instant-reasoning), the entire `provisionalRevealRef` mechanism (it repaired one
case; staleness is the general condition), and the requirement that the four
triggers be correct at all. They may apply a provisional position and record
their own provenance; convergence repairs it. **Which trigger wins a race
stopped being a correctness question.**

### Three more defects, and the pattern behind all three

| # | Defect | The Monaco API I leaned on | What it actually guarantees | What I assumed |
|---|---|---|---|---|
| 9 | Our own reconciling reveal marked the viewport as user-owned, so only the FIRST convergence was silent and every later one degraded into a banner | `onDidScrollChange` | the scroll offset changed | the user scrolled |
| 10 | MT-06's premise ("user scrolled away") was unachievable on its own fixture — a 1200-line file with one edit collapses to ~9 laid-out lines, so `scrollToFraction(1)` left `scrollTop` at 0 | — | — | that a collapsed diff is scrollable |
| 11 | The view-model rebuild lost the user's scroll offset, 1212 px on a 6900 px document, 1 trial in 24 | `restoreViewState` | the view state is approximately restored | the scroll offset is preserved exactly |

**The pattern**: relying on a mechanism that is *nearly* what you need to carry a
meaning it does not promise. Round 1 had the same shape with
`getLineChanges() !== null` ("a diff was computed once" ≠ "this diff is
current"). Four instances across two rounds.

**The remedy is the same every time: stop inferring, carry the quantity
explicitly.** Content signature instead of "is the diff current". Real `wheel`
and navigation-key events instead of scroll-offset changes. `getScrollTop()`
captured and re-applied instead of `restoreViewState`.

### What found them — not assertion failures

Defect 9 was found by **branch-frequency analysis**, with every assertion green:
`notify` fired 49 times against `reconcile-silent` 4 across a regression run.
The assertions all checked that the *final state* was right, and it was — the
implementation reached a correct end state by a wrong route (banner instead of
silent convergence).

> Assertions check whether the result is right. Frequency distributions check
> whether the route is right. An implementation that reaches a correct result by
> the wrong route is invisible to the first and obvious to the second.

Defect 10 is worse than an uncovered path: MT-06 had complete assertions and had
been *passing*, but its precondition never held, so it was exercising a scenario
that did not exist. **A case whose premise cannot be established has zero
coverage while looking fully covered** — more dangerous than no test, because it
advertises protection that is not there.

Defect 11 showed as a **bimodal distribution**: 23 trials at 29 px drift, one at
1212 px. The bimodality was the signature; after the fix all 24 sit at 29 px.

### Coverage measured by execution, not by assertion count

Verified from trace-event counts over a regression run (a path that never
executes is uncovered no matter how many assertions name it):

| Path | Executions | |
|---|---|---|
| `model-sync` (promoted tier) | 111 | ✓ |
| `reveal-reconcile` | 132 silent + 10 notify | ✓ both live branches |
| `view-model-rebuilt` | 24 | ✓ |
| `collapse-state` | 24 | ✓ |
| `model-sweep` | 50 detach + 3 bind | ✓ |
| triggers | diff-computed 44 / model-bound 14 / deferred 9 / timeout 5 | ✓ all four |
| `wait` branch | 0 | label absent, but its only failure mode (never converging) is what INV-5 asserts — not manufacturing a case to light up a label |

### Assertions added

- **INV-5** in the mutation-timing matrix: `getRevealStaleState().stale === false`
  after settle. A pure state comparison, so it is meaningful at every instant of
  every case rather than only in the scenario it was written for.
- **MT-05**: two consecutive external writes with no user scroll between them —
  both must converge silently. The second is the defect-9 gate.
- **MT-06**: rewritten onto a scattered-edit fixture (collapsed view stays
  scrollable) and driven by a real `WheelEvent` through
  `simulateUserViewportIntent()`, so the test travels the listener a user
  travels rather than poking internal state. Gates ownership detection AND
  offset preservation, with the drift budget expressed at document scale plus an
  explicit "was not yanked to the reveal position".

## Update history (append-only)

| Date | Author | Change |
|---|---|---|
| 2026-07-27 (final) | implementation | **FIXED and verified.** Full regression 108/0/1-skip, zero flaky; `run-git-diff-reentry` 8/8 clean standalone runs after two test-sampling fixes; mutation-timing matrix MT-01..08 all 3/3 across 3 orchestrator iterations with zero duration drift. Added § 9 recording the four production changes, the two sibling defects the work exposed (sampled content signature; warm-diff-cache quit-throw), and the eight defects introduced while building the fix with the wrong premise behind each. |
| 2026-07-27 (later) | implementation | **Root-cause chain refined one step earlier, and it makes the fix cleaner.** The original write-up had the stale diff arising from `setValue` + Monaco's 200 ms debounce. That is real and still applies, but it is not where the staleness starts. `@monaco-editor/react@4.7.0` resolves models as `getModel(uri) ?? createModel(value, lang, uri)` — **when a model already exists for the URI it is returned and the content passed to createModel is DISCARDED** — and `keepCurrentOriginalModel/keepCurrentModifiedModel={true}` keep it alive across unmount. `selectedFileKey` carries `changeType`, so the reopen *did* re-key and remount the widget; the remount then resolved the same URI, got the model still holding the untracked-era body, and Monaco computed its **mount-time** diff (and its zero-unchanged-region state) from that body. `syncCurrentDiffEditorModels` then corrected the CONTENT but could not correct the already-computed diff. Superseded reasoning kept per § 5.3b: nothing in it was wrong, it just started one step downstream of the origin. Second finding, load-bearing for the fix design: `DiffEditorWidget` derives `_diffModel` solely from its own `setModel` (`_diffModelSrc`, `diffEditorWidget.js:69-71`) and does **not** observe the inner editors, while the library reacts to a changed model path by calling `setModel` on the INNER editor — so putting the identity in the URI *without* also putting it in the React key would leave the widget diffing models it no longer displays. Identity therefore rides both. |
| 2026-07-27 | ow_log_analysis | Initial entry. Root cause: warm Monaco models reused across a content-identity change, carrying BOTH the stale `_diff` (→ reveal targets the old first-change line) and the stale unchanged-region visibility state (→ whole file expanded). Confirmed: `warm-ready` + `revealTargetLine=1`, the 47 ms < 200 ms debounce arithmetic, panel-mode-always ⇒ models never disposed, the untracked→unstaged transition, both self-heal paths dead. Inferred: `setValue` executed (`model-sync` gated off). Identified GDS-52's structural blind spot (v1/v2 edit the same line, so the assertion cannot distinguish stale from fresh). Superseded during analysis: the initial reading that the user SAW the stale all-green diff — falsified by the user reporting normal red/green colors, which redirected Fact B to Monaco's collapse-state carry-over. |
