---
name: ow_log_analysis
description: Analyze an Onward diagnostic bundle (onward-diagnostic-*.zip) exported by the in-app Feedback → "Generate diagnostic bundle" button, root-cause the user's reported problem, and produce a dark-theme HTML report covering the evidence-backed root cause, a reproduction plan, and an "which trace events must be added to confirm this" instrumentation plan. Reads from the project's `Logs/` directory by default; also accepts any absolute path to a .zip or an already-extracted `-bundle/` directory (which is then copied into `Logs/`). Use when the user says "analyze this log / look at this diagnostic bundle / 分析日志 / 看下这个诊断包" or supplies an onward-diagnostic archive path. Read-only analysis — never modifies product code.
---

# ow_log_analysis — Onward diagnostic-bundle analysis

## 0. What this skill is for

When a user hits a problem in Onward, they open the Feedback modal and click
**"Generate diagnostic bundle"**, producing an
`onward-diagnostic-YYYY-MM-DD_HH-MM-SS.zip`. Users frequently type the problem
description into the save dialog, so the filename looks like:

```
lanxi-terminal1 中的内容有刷新，但是上划的时候没办法看到完整的信息-onward-diagnostic-2026-07-21_17-36-04.zip
```

**The leading part of the filename is the user's own first-hand description of
the problem. It is the single most important input — read it first.**

This skill's job: open the bundle, understand it, argue the root cause from the
evidence inside it, and write an HTML report.

---

## 1. Hard constraints (violating any of these = failure)

1. **Read-only analysis. Never modify product code.** Do not edit anything under
   `src/**`, `electron/**`, or `test/**`. The only artifacts this skill writes
   are the copied bundle under `Logs/` and the report under `Logs/reports/`.
   If the analysis concludes that a code change is needed, put the proposed
   change in the report's "Fix recommendations" section and let the user decide
   whether to open a separate round of work for it.
2. **Never commit to git.** Do not run `git commit` / `git push` / `git reset` /
   `git checkout`.
3. **Extract to a temp directory; never pollute the repo working tree.** Use the
   OS temp dir (Windows `$env:TEMP`, macOS/Linux `${TMPDIR:-/tmp}`) with an
   `onward-diag-` prefix, and delete it when the analysis finishes.
4. **The bundle contains unredacted data.** `app-state.json`, `settings.json`,
   `feedback.json`, and `telemetry-events.jsonl` have **no redaction at all**,
   and trace `args` can carry real absolute paths. When quoting any of it in the
   report, mask it (keep only the last 1–2 path segments; write `[redacted]` for
   emails / tokens / IDs). **Never upload bundle contents to any external
   service.**
5. **Every conclusion must be backed by evidence.** Each root-cause claim must
   point at a specific `file:line` or a specific trace event name + timestamp. A
   claim you cannot evidence goes in the report's "unverified hypotheses"
   section with an explicit confidence label.

---

## 2. Locating and staging the input

### 2.1 Resolution order

1. The user gave an absolute path (a `.zip`, or an already-extracted
   `*-bundle/` directory) → use it.
2. The user said "analyze the log" with no path → scan `<repoRoot>/Logs/` for
   `*onward-diagnostic-*.zip` and `*-bundle/`, newest first.
   - Exactly one → use it.
   - Several → use `AskUserQuestion` to let the user pick; put the filename
     (which carries the problem description) and the timestamp in each option.
3. `Logs/` is missing or empty → `Logs/` is gitignored in full, so a fresh clone
   won't have it. **Create `Logs/` and `Logs/reports/` first**, then tell the
   user the directory is empty and explain how to get a bundle: *open Onward →
   sidebar "Feedback" → click "Generate diagnostic bundle" → type the problem
   description into the filename when saving → drop the zip into `Logs/`.*
   Do not guess at an analysis without input.

### 2.2 Hard rule — stage external inputs into `Logs/`

**If the resolved input lives anywhere outside `<repoRoot>/Logs/`, copy it into
`Logs/` before doing anything else, and analyze the copy.**

- Preserve the original filename exactly (it carries the problem description).
- **Copy, never move** — the user's original file must stay where it was.
- If a file with the same name already exists in `Logs/`, compare sizes: same
  size → reuse the existing copy, say so, and skip the copy; different size →
  append ` (2)` (before the extension) rather than overwriting.
- Report the destination path to the user in the final summary.

Why: `Logs/` is the durable, gitignored home for diagnostic input. Staging every
bundle there means the report and the evidence it was derived from sit side by
side, and a later re-analysis doesn't depend on a path outside the repo that may
have moved or been cleaned up.

Windows (PowerShell):
```powershell
$Src = "<absolute path the user gave>"
$LogsDir = Join-Path $RepoRoot "Logs"
New-Item -ItemType Directory -Force $LogsDir | Out-Null
$Dest = Join-Path $LogsDir (Split-Path $Src -Leaf)
if (-not (Test-Path -LiteralPath $Dest)) { Copy-Item -LiteralPath $Src -Destination $Dest }
```

macOS / Linux (bash):
```bash
SRC="<absolute path the user gave>"
LOGS_DIR="$REPO_ROOT/Logs"
mkdir -p "$LOGS_DIR"
DEST="$LOGS_DIR/$(basename "$SRC")"
[ -e "$DEST" ] || cp "$SRC" "$DEST"
```

For an already-extracted `*-bundle/` directory, copy it recursively
(`Copy-Item -Recurse` / `cp -R`).

---

## 3. Phase 1 — extract and check integrity

### 3.1 Extraction (cross-platform)

Filenames can contain CJK characters, spaces, and full-width punctuation.
**Quote every path.**

Windows (PowerShell):
```powershell
$Bundle = "<repoRoot>\Logs\<filename>.zip"
$Work = Join-Path $env:TEMP ("onward-diag-" + [guid]::NewGuid().ToString('N').Substring(0,8))
New-Item -ItemType Directory -Force $Work | Out-Null
Expand-Archive -LiteralPath $Bundle -DestinationPath $Work -Force
Get-ChildItem -Recurse $Work | Select-Object FullName, Length
```

macOS / Linux (bash):
```bash
BUNDLE="<repoRoot>/Logs/<filename>.zip"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/onward-diag-XXXXXX")"
unzip -q "$BUNDLE" -d "$WORK"
find "$WORK" -type f -exec ls -la {} \;
```

**If the input is already a `*-bundle/` directory** (meaning the app took the
sync-directory fallback path — see 3.3), skip extraction and point `$WORK` at
the staged copy under `Logs/`. Do not delete that copy at the end; it is staged
evidence, not scratch.

When the analysis finishes — pass or fail — delete the temp dir you created:
`Remove-Item -Recurse -Force $Work` / `rm -rf "$WORK"`.

### 3.2 Expected layout

```
README.txt                                  # always: generated-at / version / platform / missing list / privacy
AGENT-GUIDE.md                              # always: the bundle's own machine-readable spec
system-info.txt                             # always: platform / versions / ONWARD_* env vars
app-state.json                              # optional: app state snapshot (unredacted)
telemetry-events.jsonl                      # optional: telemetry outbox (NDJSON, un-ACKed events only)
settings.json                               # optional: user settings (unredacted)
window-state.json                           # optional: window geometry
feedback.json                               # optional: feedback records (incl. GitHub issue links)
traces/latest.txt                           # optional: absolute path of the trace dir (one line)
traces/perf-NNNN-<ISO>-<pid>.jsonl          # 0..N: the core evidence, NDJSON
```

### 3.3 Integrity gate (mandatory, and before any analysis)

Run these in order. Any anomaly must be stated up front in the report, because
it caps how much the conclusions can be trusted.

| Check | How | What an anomaly means |
|---|---|---|
| **Schema version** | `grep 'agent-guide.v1' AGENT-GUIDE.md` | Not found → the bundle came from a newer/older app version and this document's field assumptions may not hold. Read `AGENT-GUIDE.md` fully and parse from that; **do not blindly reuse the field names below**. |
| **Missing files** | Read the `Missing files:` block in `README.txt` | Those files didn't exist at collection time. Missing `traces/*.jsonl` is crippling — with no temporal evidence you can only reason statically. |
| **Fallback path taken** | Input is a `-bundle/` directory, or the trace contains `main:diagnostic-bundle.sync-fallback-used` | The threadpool was stalled, or zip streaming blew the 15 s timeout. **This is itself a strong signal**: the main process was already unhealthy at the moment the user reported the problem. |
| **Sensitive-content capture** | `grep 'Sensitive content capture' AGENT-GUIDE.md` | If `ACTIVE`, `ONWARD_PERF_TRACE_CAPTURE_CONTENT=1` was set and raw PTY / prompt text is present. Richer evidence, but mask it when quoting. |
| **Trace tail integrity** | Use the parser in 4.1 and count unparseable lines | By design **at most ONE unparseable line per chunk, and only at the tail** (the in-flight write at SIGKILL). A bad line in the middle means corruption — downgrade the conclusions. |
| **Rate-limit drops** | Search for `trace-store:dropped-summary` | Present → some event name exceeded 100 events/sec and was dropped. `args.dropped` is the count, `args.originalName` the event. **Heavy dropping is often itself direct evidence that some path is spinning.** Also note which counters become undercounts as a result. |

---

## 4. Phase 2 — reading the evidence

### 4.1 Parsing trace chunks (the core skill)

Each `traces/perf-*.jsonl` is **NDJSON**: one Chrome Trace Event object per
line, **no enclosing array**, and **no timestamp prefix, no log level, no text
tag**. The line *is* a JSON object.

Field semantics (authoritative definition: `infra/trace.md` § 4):

| Field | Meaning |
|---|---|
| `ph` | `X`=duration slice / `i`=instant / `C`=counter / `M`=metadata / `s`,`t`,`f`=flow |
| `name` | Event name; registry lives in `src/utils/perf-trace-names.ts` |
| `ts` | **Microseconds** since epoch, wall-clock anchored (`Date.now()*1000`, ms granularity) |
| `dur` | `ph='X'` only, **microseconds** |
| `pid` | `1`=main / `2`=renderer / `3`=virtual "Tasks" process |
| `tid` | main `1`; workers `5001–5006`; per-Task lanes `10000+` (main) / `20000+` (renderer) |
| `cat` | Category. **Note: the `record()` lineage does NOT emit `cat`** — only `recordInstant`/`recordCounter`/`recordComplete`/`recordFlow*`/`markTask*` do. Never filter on the presence of `cat`. |
| `args` | Payload. Strings carry one of two truncation markers: `...` (240-char cap, strict redaction lineage) or `...[truncated:N]` (4000-char cap, loose lineage) |

**Cross-platform parser**: use Node (the repo already has it, and it avoids
shell differences). Write the script into the temp dir; never into the repo.

```js
// <tempdir>/scan.mjs
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const traceDir = process.argv[2]
const events = []
let badLines = 0, lastLineBad = false

for (const f of readdirSync(traceDir).filter(f => f.endsWith('.jsonl')).sort()) {
  const lines = readFileSync(join(traceDir, f), 'utf8').split('\n')
  lines.forEach((line, i) => {
    const t = line.trim()
    if (!t) return
    try { events.push(JSON.parse(t)) }
    catch { badLines++; lastLineBad = (i >= lines.length - 2) }
  })
}
events.sort((a, b) => (a.ts ?? 0) - (b.ts ?? 0))
console.log(JSON.stringify({
  total: events.length, badLines, lastLineBad,
  tSpanMs: events.length ? ((events.at(-1).ts - events[0].ts) / 1000) : 0,
  firstIso: events.length ? new Date(events[0].ts / 1000).toISOString() : null,
  lastIso:  events.length ? new Date(events.at(-1).ts / 1000).toISOString() : null,
}, null, 2))
```

Build on that for frequency counts, time-window slicing, and `dur` p50/p95/max.
**Put numbers in the report, not adjectives** — write
"`renderer:terminal-data.xterm-write` fired 3,412 times in 12 s, p95 = 8.4 ms",
never "writes were frequent".

**Prefer un-rate-limited events for any quantitative claim.** If
`trace-store:dropped-summary` names an event you're counting, that count is a
floor, not a value — say so, and find an unaffected event to carry the argument.

### 4.2 Time alignment (easy to get wrong)

Three different time formats live in one bundle. Convert to a common axis before
comparing anything:

| Source | Format | Conversion |
|---|---|---|
| Zip filename `onward-diagnostic-2026-07-21_17-36-04` | **local wall-clock** | Apply the machine's UTC offset before comparing with the two below |
| `README.txt` `Generated` / `system-info.txt` `generatedAt` | ISO-8601 **UTC** | Baseline |
| Trace `ts` | **microseconds** since epoch | `new Date(ts / 1000).toISOString()` |
| `telemetry-events.jsonl` `timestamp` | ISO-8601 **UTC** | Compare directly |

The filename timestamp is "when the user clicked Generate", so **the problem
always happened before it**. Use it as the right edge of the window and walk back
30–120 s; that usually brackets the scene.

### 4.3 How to read each file

- **`system-info.txt`** — plain `key=value`. Confirm `platform` / `arch` /
  `appVersion` / `buildChannel` / `branch` first. **Read the `ONWARD_*` env block
  line by line**: a debug switch may have changed product behaviour (cross-check
  `docs/debug-env-variables.md`). Values whose key matches
  `SECRET|TOKEN|PASSWORD|KEY|CONNECTION_STRING` are already `[redacted]`.
  **`# (none set)` is itself a finding**: it means every opt-in
  (`ONWARD_PERF_TRACE=1`) trace tier was off, so any event routed through
  `perfTrace()` / `perfTraceTask()` is structurally absent from this bundle.
- **`telemetry-events.jsonl`** — NDJSON of
  `{timestamp, name, properties, common}`. **This is an outbox, not a history**:
  a line present only means "not yet acknowledged by the backend"; successfully
  uploaded events are gone. So **"event X is absent" is NOT evidence that X did
  not happen.**
- **`app-state.json`** — the app-state snapshot at collection time. Use it for
  structural questions: how many Tasks were open, which project, what layout.
- **`feedback.json`** — `records[]` holds past feedback, each with `title` /
  `description` / `createdAt` / `issueUrl`. **If this problem has a record, the
  `description` is the user's full account and beats the filename — read it.**
  An empty `records` array means the filename is your only description.
- **`window-state.json`** — window geometry. Strongly relevant to display,
  scrolling, and sizing problems.
- **`README.txt`** — collection metadata + missing list.
- **`AGENT-GUIDE.md`** — the bundle's own spec, including Perfetto
  `trace_processor` SQL recipes. **For any field this document doesn't cover, it
  is authoritative.**

### 4.4 What the bundle does NOT contain (don't go looking)

No console/log ring buffer, no git state dump, no terminal session transcripts,
no standalone error-stack file, no native crash reports, no heap snapshots or
CPU profiles. Terminal, git, and error information exist **only as trace event
`args`**. If the analysis needs any of it, that is input for § 6.

---

## 5. Phase 3 — from symptom to root cause

### 5.1 Translate the user's words into observable signals

Take the description (filename + `feedback.json` `description`) and decompose it
into **"which subsystem + which action + expected what + got what"**, then map
that onto concrete event names via `src/utils/perf-trace-names.ts`:

| What the user describes | Event prefixes to check first |
|---|---|
| Terminal output stutters / loses content / scrollback incomplete | `renderer:terminal-data.*`, `renderer:xterm.renderer.*`, `main:terminal-data-ipc-summary`, `terminal.buffer.flush` |
| Terminal corruption / black screen / lost rendering | `renderer:xterm.webgl-context-init`, `renderer:xterm.renderer.context-lost` / `.context-restored` / `.context-loss-fallback` / `.gpu-crash-recovery` |
| Git Diff / Git History slow or stale | `main:git-state-mirror.*`, `renderer:git-diff.*`, `main:gitwatch-summary` |
| General lag / unresponsive UI | `main:event-loop-stall` (only logged at drift ≥ 100 ms), `main:git-runtime-summary` |
| Input latency | `renderer:terminal.send-input`, `renderer:ipc.terminal.write`, `renderer:prompt.*` |
| Project Editor | `renderer:project-editor.*` |

**No matching event ≠ no problem** — very often that path simply has no
instrumentation, which is exactly what § 6 exists to produce.

### 5.2 Five usable lines of argument

1. **Frequency anomaly** — an event fires far more than plausible in the window
   (or shows up in `trace-store:dropped-summary`) → spinning / re-entrancy /
   missing dedup.
2. **Duration anomaly** — `ph='X'` `dur` has a long tail (p95 or max far from
   p50) → a blocking point. Check whether `main:event-loop-stall` overlaps.
3. **Missing pairing** — an event that should come in pairs only shows one half:
   `context-lost` without `context-restored`, `scheduler-enqueue` without
   `scheduler-flush`, flow `s` without `f` → the path broke at some branch.
   **This is the strongest class of evidence; look for it first.**
4. **Order inversion / race** — two events occur in the opposite order from the
   design intent (restore before capture, rollback before detect) → a race.
5. **Timing fingerprint** — when payload *content* is unavailable (the default:
   sensitive-content capture is off), the **inter-arrival distribution plus the
   payload-size distribution** still identify what produced a stream. Compute
   inter-arrival p10/p25/p50/p75/p90 and a bucketed histogram, plus the byte-size
   percentiles, over a sustained active window. Machine-generated periodic work
   and human/command-driven work look nothing alike:

   | Signature | Reads as |
   |---|---|
   | Inter-arrival tightly clustered (e.g. 60 % in one 20 ms-wide bucket), almost no long gaps, uniform small payloads, sustained for minutes | A **timer-driven loop** — animation / redraw / polling. Cross-check the implied frequency against a plausible frame rate. |
   | Bursty and irregular — long silences punctuated by large payloads | Genuine command output or user-driven activity. |
   | A tight cluster whose period matches a known interval in the code (250 ms monitor, 100 ms flush, 50 ms throttle) | That specific timer; confirm by finding the constant. |

   Compare two windows of the *same* stream: if the inter-arrival p50 is
   identical while the density differs, it is one mechanism under different load,
   not two mechanisms.

### 5.2b Validate the conversion model before arguing about capacity

Whenever the argument has the shape *"quantity X exceeded capacity C, therefore
data was lost"*, X and C are usually in **different units**, and there is an
implicit conversion between them. **Verify the conversion holds before trusting
the comparison.** Concretely:

- bytes on a PTY → lines in a scrollback buffer *(conversion can be **zero**:
  in-place redraw overwrites instead of appending)*
- events emitted → events persisted *(rate limiting; check
  `trace-store:dropped-summary`)*
- bytes sent over IPC → bytes written to the consumer *(buffering, trimming)*
- items enqueued → items processed *(dropped/coalesced work)*

**A parameter sweep does not validate a model.** Showing that a conclusion holds
across every plausible bytes-per-line value proves the arithmetic is robust; it
says nothing about whether bytes-per-line is the right relationship at all. If
the model is wrong, a robust sweep just repeats the same error N times with
false confidence. Find a **direct or independent measurement of the target
unit** — or, if the bundle cannot provide one, say so plainly, label the
conclusion accordingly, and put the missing measurement at the top of § 6.

### 5.3 Actively try to falsify your own leading hypothesis

Before writing the report, take the hypothesis you believe most and ask: **what
observation would prove it wrong?** Then go look for that observation.
Concretely: if you suspect a capped buffer dropped data, find the cap's value in
the code and check the largest observed value against it; if you suspect a
hidden-path behaviour, find the counter that path emits and check whether it
appears at all.

**Include observations the user can make but the bundle cannot record.** Trace
data covers the data pipeline; it does not cover what the UI looked like.
Scrollbar extent, whether a panel was blank vs. stale, whether a spinner was
spinning, whether scrolling was possible at all — these are decisive, cheap to
ask about, and frequently settle in one sentence what no amount of byte-counting
can. **Treat the user's description of on-screen state as first-class
evidence**, and when a hypothesis hinges on it, use `AskUserQuestion` with
options phrased so each answer maps to a *different root cause* (not to a
severity rating). Do it **before** writing the report, not after.

A hypothesis that survives a genuine falsification attempt is worth far more
than one that merely fits. **Record the ruled-out hypotheses and their
disproving evidence in the report** (§ 6.3 table) — that is what stops the next
person from re-walking the same dead end.

### 5.3b If a conclusion is later overturned, keep the wrong reasoning

When a revision invalidates an earlier root cause, **do not silently replace
it.** Add a revision section that states the superseded conclusion, the reasoning
chain that produced it, and the specific observation that falsified it. Append a
new row to the update-history table rather than editing the old one, and update
the report's root-cause slug in the filename (§ 6.1) so the name matches the
current conclusion.

Rationale: the discarded reasoning is the most reusable artifact of the whole
analysis. It records a path that *looked* correct and wasn't — which is exactly
what a future reader (or a future you) needs in order to not walk it again. A
report that only ever shows its final answer teaches nothing about how to avoid
the wrong one.

### 5.4 Grade every conclusion

Label each conclusion in the report. Never present a guess as a fact.

- **Confirmed** — trace event + timestamp + matching code `file:line`, causal
  chain closed.
- **High-confidence inference** — indirect evidence (missing pairing, frequency
  anomaly) and a code path that explains it, but no directly matching event.
  Prefer arguments that are **insensitive to the assumed parameters** — if the
  conclusion holds across every plausible value, say so explicitly; that is what
  separates this tier from a guess.
- **Unverified hypothesis** — reasoning from code reading only, with no
  corresponding signal in the log. **These MUST come with an entry in § 6 saying
  what instrumentation would falsify them.**

---

## 6. Phase 4 — produce the HTML report

### 6.1 Location and naming

Write to `<repoRoot>/Logs/reports/` (gitignored along with `Logs/`).

**Naming rule — the report name is the log's own filename plus a root-cause
slug:**

```
<original log filename, extension stripped>-<root-cause-slug>.html
```

- Keep the original filename **verbatim**, including CJK characters and spaces.
  It carries the user's problem description, and preserving it makes the report
  trivially traceable back to its source bundle.
- `<root-cause-slug>` is a short ASCII kebab-case identifier for the root cause
  you landed on — e.g. `scrollback-capacity-overflow`,
  `watcher-missed-git-event`, `webgl-context-lost-no-restore`.
- If the root cause is inconclusive, use `inconclusive-<subsystem>`
  (e.g. `inconclusive-terminal-scrollback`) so the filename stays honest.

Example:
```
lanxi-terminal1 中的内容有刷新，但是上划的时候没办法看到完整的信息-onward-diagnostic-2026-07-21_17-36-04-scrollback-capacity-overflow.html
```

After writing it, deliver the report with `SendUserFile` (`display: "render"`).

### 6.2 Format conventions the report must follow (from the project CLAUDE.md)

- SPDX header at the top: `SPDX-FileCopyrightText: 2026 OPPO` /
  `SPDX-License-Identifier: Apache-2.0`
- **Dark theme** with readable contrast
- **Fixed left ToC** (`position: fixed`), one anchor link per section, content
  area offset so it is never overlapped, current-section highlighting on scroll
- **Instant jump, no animation**: `scroll-behavior: auto`; never
  `scrollIntoView({behavior:'smooth'})`
- **Self-contained**: all CSS/JS inline, no external deps or CDNs
- **Component-rich**: cards, callouts, comparison tables, before/after panels,
  badges, code blocks, simple CSS/SVG diagrams (timelines, capacity bars, flow).
  Do not write walls of prose.
- Bottom: **document metadata + an append-only update history** (branch, app
  version, doc version; each revision appends a dated row — **never rewrite or
  delete past rows**)
- `docs/html/infra-failure-resilience-design.html` is a good style skeleton to
  crib from.
- Report prose may be written in Simplified Chinese (matching how the user
  writes); this skill file itself is English.

### 6.3 Sections the report must contain

| # | Section | Requirements |
|---|---|---|
| 1 | Problem statement | Quote the user verbatim (filename + `feedback.json` description), then restate it as "subsystem + action + expected vs actual". If the user's sentence contains two independent facts, split them — merging them loses information. |
| 2 | Evidence baseline | Bundle metadata table: app version / platform / branch / generated-at / trace chunk count and bytes / event count / time span. **Plus every result from the § 3.3 integrity gate.** This section sets the ceiling on how much the rest can be trusted; it cannot be skipped. Include an explicit **"absent events"** table — what is missing and why (not instrumented vs. gated off vs. genuinely never happened). |
| 3 | Timeline | A CSS/SVG timeline of the key events in the problem window, with anomalies marked. Plus a table: timestamp (UTC + relative offset ms) / event name / pid:tid / key args. |
| 4 | Root-cause analysis | Each conclusion labelled **Confirmed / High-confidence inference / Unverified hypothesis**, with evidence (event name + timestamp + `file:line`). Use a before/after panel for "designed path" vs "path the log shows". **Include a ruled-out-hypotheses table** with the disproving evidence for each. |
| 5 | **Reproduction plan** | See 6.4 |
| 6 | **Instrumentation plan** | See 6.5 |
| 7 | Fix recommendations | Directions and trade-offs only — **no patches** (this skill does not modify code). Where the change touches cache strategy, watcher semantics, IPC/threading models, or concurrency/scheduling, mark it **"requires user confirmation before implementation"** per the project's hard rule. |
| 8 | Open questions | What the evidence cannot settle. State it honestly, and list the concrete questions worth asking the user. |

### 6.4 Writing the "Reproduction plan" section

Not "open the app and try it". Give an executable path:

1. **Environment preconditions** — copy them out of the bundle: platform, app
   version, required `ONWARD_*` switches, window size (`window-state.json`),
   project/Task count and layout (`app-state.json`).
2. **Trigger steps** — numbered, each saying "do X → expect trace event Y".
3. **Pass/fail criteria** — what counts as reproduced. Prefer
   **automatically assertable signals** (an event appears/doesn't, a `dur`
   exceeds a threshold, a pairing is missing) over "it looks laggy".
4. **Where it lands in automation** — check `test/README.md` § 2 *Feature × Test
   Index* first and say whether this should **amend an existing runner**
   (preferred) or **create a new one** (only when it crosses a subsystem
   boundary). Then, per the project's "unit test + autotest as a paired
   deliverable" rule, list separately: which pure logic belongs in
   `test/unittest/`, and which user-visible behaviour belongs in
   `test/autotest/`. If one layer genuinely has nothing to test, say so
   explicitly — silent omission is not allowed.
   **State plainly whether the case is timing-sensitive.** If it is, the test
   must aggregate N trials internally (boolean correctness N=5, all must pass;
   latency N=3, pass if ≥1 of 3 meets budget — and the latency budget must be
   confirmed with the user, not guessed). If it is deterministic, say that too,
   so nobody adds pointless repetition.
5. **If it can't be reproduced** — say so and explain why (missing the user's
   specific data, hardware/GPU dependent, depends on state drift after long
   uptime), then push the weight onto § 6.

### 6.5 Writing the "Instrumentation plan" section (this skill's highest-value output)

Premise: **the user-uploaded trace is this project's only production diagnostic
input** (no ELK, no Sentry, no remote logging). So the correct output of "we
couldn't confirm it this time" is the instrumentation list that makes it
confirmable next time.

For every **unverified hypothesis** and every **break in the evidence chain**,
give a row:

| Column | Content |
|---|---|
| Question to answer | One sentence, e.g. "did the renderer actually receive this rollback broadcast?" |
| Proposed event name | Project convention `<surface>:<feature>.<verb>-<noun>`, lowercase kebab, e.g. `renderer:terminal.scrollback-evicted` |
| Instrumentation site | `file:line`, down to the function |
| Event type | `ph='X'` (duration) or `ph='i'` (instant) |
| Key args | Field names + types. **Must respect the payload budget**: ≤ ~5 µs CPU per event, ≤ ~1 KB after JSON-stringify, long strings summarized via `summarizeText()` (length / line count / hash), never raw user content |
| **Rate control** | **Mandatory column.** State explicitly how often the site fires and how the event will be kept cheap: emit once on a state transition, debounce to 250 ms, aggregate per second, or emit only on threshold crossing. A row without this is not actionable. |
| Why it's missing today | Why this path is currently invisible in the trace: not instrumented at all, or instrumented but routed through an opt-in tier |

Prioritize the rows (P0/P1). Distinguish the three kinds of gap, because they
have very different fix costs:

- **Instrumented but gated off** — the event exists but rides
  `perfTrace()` / `perfTraceTask()`, which require `ONWARD_PERF_TRACE=1`. Fixing
  it is a tiering change, not new code. **Cheapest and usually highest value.**
  Beware: promoting a hot-path event to the diagnostic tier requires aggregating
  it first (see the rate-control column).
- **Silent drop/failure paths with no instrumentation** — code that discards data
  or swallows an error with no counter and no event.
- **State that is never recorded** — the value you'd need to confirm the root
  cause is simply never read for diagnostic purposes.

Also remind the implementer of three project hard rules:

1. Register the new event name in `src/utils/perf-trace-names.ts` **first**, then
   instrument.
2. After instrumenting, update `infra/trace.md` § 2 "Implemented trace events"
   and move the item off the § 3 "Planned" list.
3. **Never put `perfTrace(…)` inside a tight loop body, an unbudgeted rAF body, a
   per-byte `onData` handler, or a per-keystroke handler** — aggregate first,
   then emit once per N or per tick.

---

## 7. Execution checklist

- [ ] Resolve the input (user-supplied absolute path wins, else scan `Logs/`)
- [ ] Read the problem description out of the filename
- [ ] **If the input is outside `Logs/`, copy it into `Logs/` and analyze the copy**
- [ ] Extract to a temp dir (quote all paths; expect CJK filenames)
- [ ] Run the § 3.3 integrity gate and record every result
- [ ] Read `AGENT-GUIDE.md` and confirm the schema version
- [ ] Read `README.txt` / `system-info.txt` to establish the factual baseline
      (note whether `ONWARD_*` is unset — it determines which trace tiers exist)
- [ ] Read `feedback.json` for the user's fuller account
- [ ] Parse every trace chunk; run the frequency / duration / pairing / ordering /
      timing-fingerprint scans
- [ ] Walk back from the filename timestamp to bracket the problem window
- [ ] **If the argument compares a quantity against a capacity, validate the unit
      conversion between them first (§ 5.2b)**
- [ ] **Try to falsify your leading hypothesis before committing to it — including
      by asking the user about on-screen state the bundle cannot record (§ 5.3)**
- [ ] Grade conclusions: Confirmed / High-confidence inference / Unverified hypothesis
- [ ] Write the report to `Logs/reports/<log filename>-<root-cause-slug>.html`
      (dark + fixed left ToC + no-animation jumps + self-contained + SPDX + update history)
- [ ] Deliver it with `SendUserFile` (`display: "render"`)
- [ ] Delete the temp dir you created (keep the staged copy under `Logs/`)
- [ ] Give a short summary in chat: one-line root cause + confidence + the single
      most important instrumentation recommendation + where the bundle was staged

---

## 8. Related documentation

- `infra/trace.md` — authoritative trace event index + on-disk format (§ 2 event table, § 4 format)
- `src/utils/perf-trace-names.ts` — event-name registry
- `src/utils/perf-trace.ts` — the renderer tiering split (`perfTrace` / `perfTraceTask` are opt-in; `perfTraceDiagnostic` is default-on)
- `electron/main/diagnostic-bundle.ts` — bundle assembly (what this skill parses)
- `electron/main/trace-store.ts` — NDJSON chunking / rotation / rate limiting
- `electron/main/performance-trace.ts` — redaction and truncation rules
- `docs/debug-env-variables.md` — `ONWARD_*` switch semantics
- `test/README.md` § 2 — Feature × Test Index (consult when writing the reproduction plan)
- `docs/lessons.md` — historical lessons; avoid repeating past misdiagnoses
