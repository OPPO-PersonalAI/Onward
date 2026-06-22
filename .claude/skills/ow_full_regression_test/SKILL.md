---
name: ow_full_regression_test
description: Run the Onward full automated-test regression. Invoked explicitly by the user. Test mode (default): clean dev build (`--build` mandatory), runs `python3 test/autotest/run-full-regression.py --build`, then reports pass/fail/skip counts and failing-runner names. No analysis, no edits to fix contract failures. Environment / toolchain blockers that stop test cases from executing (missing interpreter or pnpm, absent node_modules, ABI mismatch, stale build artefacts, leftover processes, full disk) are auto-healed and the run retried — bounded per symptom — so every test case actually runs; this self-heal never edits source, test, or fixture files to flip a red assertion. Repair mode (`--repair`): clusters FAIL/TIMEOUT entries from the newest `test/full-regression-results/<timestamp>/` by root cause, then per-cluster Plan-Mode → fix → `--build --only run-<suite>` verify loop tracked in `repair-progress.json`, finishing with one final `--build` full pass. Clean mode (`--clean`): wipes accumulated test artefacts (traces, regression results, autotest scratch) by delegating to `scripts/clean-test-data.py` so the user can reset before a fresh run without leaving the skill. The three modes do not chain.
---

# ow_full_regression_test

Three independent modes, picked explicitly by the user:

- **Test mode** (default) — clean build → run regression → report
  pass/fail counts. Stops there. No analysis, no edits.
- **Repair mode** (`--repair`) — work on the failures from the most
  recent test run. Cluster → Plan Mode → fix → targeted verify →
  final full pass.
- **Clean mode** (`--clean`) — wipe gitignored test artefacts and
  report the reclaim. No tests run, no fixes applied.

They do not chain. A normal regression run never auto-triggers
repair or clean. `--repair` never auto-runs a fresh regression or a
clean first; it operates on the existing case file on disk.
`--clean` never runs tests. If the user passes more than one mode
flag at once (e.g. `--build --clean`, `--repair --clean`), ask which
they meant before doing anything. The user picks each transition.

---

## Environment self-heal (every run-bearing step)

Mode A's regression run and Mode B's per-cluster verify / final pass
all depend on a healthy toolchain. Before and during any `--build`
invocation you MUST separate two failure classes and treat them in
opposite ways:

- **Environment / toolchain failure** — the run cannot *reach* or
  *finish* the test assertions because a prerequisite is missing or
  broken: the build never produces a package, a runner can't launch
  the app, the interpreter / package manager isn't found,
  dependencies aren't installed, a leftover process holds a lock, the
  disk is full. The orchestrator aborts (or a runner errors out)
  **before the test contract is actually exercised**. These are yours
  to fix automatically — heal the environment, then re-run, looping
  until every test case actually executes. No Plan Mode, no user
  approval; these are environment chores, not contract changes.

- **Test-contract failure** — a runner launched, drove the app, and an
  assertion went red (`[AutoTest] FAIL`, `AssertionError`, a
  `FAIL` / `TIMEOUT` entry with assertion markers). The environment
  was healthy; the app behaviour drifted. Self-heal must **never**
  touch these. Mode A reports them as counts and stops; fixing them
  is Mode B (`--repair`) behind its Plan-Mode + approval gate.

The dividing question is always: **did every test case get to run?**
If a case never executed because the toolchain choked, self-heal and
retry. If it executed and disagreed with the app, that is a contract
failure — leave it for the user / repair mode. The goal of this
section is narrow and literal: get every test case to *execute*
(pass, fail, or legitimately skip), not to make any case pass.

### Pre-flight env check (fail fast, before the build)

`run-full-regression.py` runs a cross-platform **environment pre-flight**
before `--build` (and before the runner list on a no-build run). It asserts
the installed `node_modules` matches the committed dependency spec for the
highest-signal drift classes — the **Electron binary** (`path.txt` + the
referenced `dist/` binary present), the **`@xterm/addon-webgl` patch**
(the global-monotonic `_nv` sentinel present, enforced only while
`package.json` still declares that patch), and the **app native module**
(`better_sqlite3.node` present, i.e. the project's `electron-rebuild`
postinstall actually ran). On drift it aborts in ~1 s
(exit 3) with the exact remedy (`pnpm install`,
`node node_modules/electron/install.js`) instead of failing 30 min into a
build+run cycle as a red WebGL-atlas assertion or a runner that can't resolve
Electron. It is pure `pathlib` + byte-search in the Python orchestrator, so it
runs identically under `py` on Windows and `python3` on macOS/Linux. Bypass
with `--skip-env-check` (or `ONWARD_SKIP_ENV_PREFLIGHT=1`) only after a
deliberate version bump that changed a sentinel; `--list` skips it. This is a
structural front-stop for the same drift the *Heal-and-retry loop* below
heals — the loop still applies to anything the pre-flight does not cover.

### Heal-and-retry loop

When a run-bearing step fails for an environment reason:

1. **Read the actual error** from the orchestrator output / build log
   — never guess. Name the missing or broken prerequisite.
2. **Apply the narrowest heal** that addresses exactly that
   prerequisite (table below). Scope is strictly
   environment / toolchain / process / dependency / disk — never
   source, test, fixture, or orchestrator files.
3. **Re-run** the same `--build` invocation from the top (the clean
   `out/` + `release/` wipe still applies).
4. **Bound it.** At most ~3 heal attempts per distinct symptom. If the
   identical error survives its targeted heal, stop thrashing — report
   what you tried and the remaining blocker, and hand back to the
   user. Do not loop forever and do not escalate to broader,
   more destructive actions.
5. **Report every heal you applied** (what was missing, what command
   fixed it) in the final summary, so the environment drift is visible
   and the user can decide whether to make it permanent (e.g. add a
   genuinely-missing dependency to `package.json` themselves).

### Common environment symptoms → heal

Cross-platform applies throughout (macOS / Linux / Windows); pick the
host-appropriate command.

| Symptom in the log                                            | Likely cause                                  | Heal, then re-run                                                                                  |
|---------------------------------------------------------------|-----------------------------------------------|----------------------------------------------------------------------------------------------------|
| `python3: command not found` / `python3` not recognized       | wrong interpreter name for this host          | use `py` on Windows, `python3` on macOS / Linux to launch the orchestrator                          |
| `pnpm: command not found` / not recognized                    | package manager not on PATH                   | `corepack enable pnpm` (fallback `npm i -g pnpm`), confirm with `pnpm -v`                            |
| build / runner: `Cannot find module …`, `ERR_MODULE_NOT_FOUND`| `node_modules` absent or stale                | `pnpm install`, then rebuild                                                                         |
| `electron … ENOENT` / Electron binary missing                 | install incomplete / postinstall skipped      | `pnpm install` (re-runs the electron download); if still missing, `node node_modules/electron/install.js` |
| native module `NODE_MODULE_VERSION` / ABI mismatch            | electron version changed vs prebuilt binary   | `pnpm rebuild`, or `pnpm electron-builder install-app-deps`                                          |
| app won't launch / `EADDRINUSE` / debug port held             | leftover dev-app or helper process            | kill by **EXACT** name only, then re-run                                                            |
| `ENOSPC` / no space left on device                            | gitignored scratch piled up                   | `python3 scripts/clean-test-data.py --traces --autotest-results` (scratch only — never the regression-results dir, which may hold an active case file), then re-run; if still full, report |
| runner `.sh`: `Permission denied` (POSIX)                     | lost the executable bit                       | `chmod +x test/autotest/run-*.sh`                                                                   |
| stale package despite source edits                            | `out/` / `release/` not wiped                 | confirm `--build` ran its clean wipe; if it was bypassed, wipe both and rebuild                     |

### Cross-platform & process-safety notes

- **Interpreter name.** This skill writes `python3` for POSIX. On
  Windows launch the orchestrator with the platform's Python (`py`,
  per the global rule). A bare `python3: not found` on Windows is
  itself an environment symptom — switch to `py`, don't report defeat.
- **Killing leftover processes** uses EXACT-name matching only
  (`pkill -x "<exact>"` / `taskkill /IM "<exact>.exe"` /
  `Get-Process -Name "<exact>"`). Never wildcard or substring — the
  same hard rule as `CLAUDE.md`; a loose selector can kill the user's
  Claude Code session and other builds.
- **Dependency heals are install / rebuild only** (`pnpm install`,
  `corepack enable`, `pnpm rebuild`). Never hand-edit `package.json`
  or the lockfile to force a build green. If a dependency is genuinely
  missing from the manifest, report it — do not silently add it.
- **The `ENOSPC` heal is not Mode C.** It shells out to the cleanup
  script for *scratch* categories only and never enters the
  user-facing `--clean` mode; it must skip `test/full-regression-results/`
  so an in-progress `repair-progress.json` case file is never
  destroyed.

---

## Per-runner 5-minute budget (the "no test case over 5 min" rule)

Every runner MUST complete within **5 minutes** (`RUNNER_BUDGET_SEC = 300`
in `run-full-regression.py`). This is a **design ceiling**, not just a
timeout: a suite that needs longer is doing too much in one process and
**must be SPLIT into multiple sub-5-minute runners** — never given a
bigger timeout.

### What the orchestrator does (monitor + check — already wired)

1. **Elapsed-time monitor.** Every runner's wall time is recorded
   (`elapsed_sec` per result) and printed slowest-first in a
   **`DURATION AUDIT`** block at the end of every run.
2. **Over-budget check (the >5-min trigger).** Any runner whose elapsed
   time exceeds 300 s is flagged `⚠ OVER 5-MIN BUDGET` inline (the moment
   it overruns) AND collected into an **`OVER 5-MIN BUDGET`** review list
   + `summary.json`'s top-level `over_budget` array. That flag is the
   signal to SPLIT the suite — it is not a pass/fail change (a PASS that
   ran 6 min is still over budget and still must be split).
3. **Over-budget backlog at startup.** Any `PER_SCRIPT_TIMEOUT_OVERRIDES_SEC`
   value above 300 s is listed up front as `⚠ OVER-BUDGET BACKLOG` — a
   suite already known to violate the rule and pending a split. **Do not
   add new >300 s overrides; split the suite instead.**

The check **flags, it does not hard-fail** — on an EDR / anti-malware host
every process spawn is taxed 1.3–12.9 s, so a well-designed suite can still
overrun there. The budget is enforced at **authoring time** (keep each
suite small) and verified on a healthy host / CI; the flag surfaces suites
to review.

### Authoring rule (applies to every new / amended runner)

- Design each runner to finish well under 300 s on a healthy host.
- If a suite's cases collectively approach 5 min, **split by logical
  group** into multiple `run-<suite>-<group>-autotest.sh` runners, each
  registered in `SCRIPTS` and indexed in `test/README.md` § 2. Splitting
  by group (not by arbitrary case count) keeps each runner's fixture /
  setup coherent and its failure attributable.
- A runner that must temporarily exceed the budget gets an override **with
  a `# TODO(split): ...` comment naming the planned split** — it is
  backlog, not a permanent exemption.

### When the check triggers (over-budget runner observed)

Treat it as a **split task**, not a timeout bump:
1. Read the suite's case list; group the cases by fixture / subsystem.
2. Create one sub-5-min runner per group (+ `SCRIPTS` + README § 2 rows).
3. Remove the over-budget override once every split runner is under 300 s.
4. Verify each new runner with `--build --only run-<suite>-<group>`.

Current over-budget backlog (split targets), worst-first — keep this list
in sync with `PER_SCRIPT_TIMEOUT_OVERRIDES_SEC`:
`run-git-state-mirror-latency` (1500 s; split the 3 passes), `run-pdf-epub-full`
(1200 s), `run-pdf-epub-preview` (900 s), `run-git-diff-staleness-and-submodule`
(600 s), `run-prompt-input-longtail` (360 s).

---

## Mode A — Test mode (default)

The user wants to run the regression and see what state the codebase
is in. Nothing more. Three steps, then stop.

### Step 1 — Mandatory clean dev build

Every invocation MUST start with `--build`. The flag wipes `out/` and
`release/` then runs `pnpm dist:dev` before the runner list executes,
so the autotest is provably running against a package built from the
current source tree. A stale `release/mac-arm64/Under Development …
.app` is the single biggest source of "fixed it but the test still
fails" / "didn't touch it but the test now fails" confusion in this
project, so this is non-negotiable — even if you "just rebuilt" five
minutes ago, build again. The only exception is `--list`, which
doesn't run any test.

### Step 2 — Run the orchestrator

`test/autotest/run-full-regression.py` is the single source of truth
for the runner list, the per-runner 5-minute timeout, the exact-name
kill / cleanup contract, and the output layout. Do not invoke
individual `.sh` runners by hand or wrap the orchestrator in another
driver.

```bash
python3 test/autotest/run-full-regression.py --build
```

Common scopes the user might want (each keeps `--build`):

| User intent                                  | Invocation                                                                                  |
|----------------------------------------------|---------------------------------------------------------------------------------------------|
| Full pass                                    | `python3 test/autotest/run-full-regression.py --build`                                      |
| Re-run a specific suite                      | `python3 test/autotest/run-full-regression.py --build --only run-<suite>`                   |
| Skip a known-broken runner this round        | `python3 test/autotest/run-full-regression.py --build --skip run-<suite>`                   |
| List planned scripts only (no build, no run) | `python3 test/autotest/run-full-regression.py --list`                                       |
| Include the update-channel E2E suites        | `python3 test/autotest/run-full-regression.py --build --include-update-e2e`                 |

The update-channel E2E suites (`UPDATE_E2E_SCRIPTS` in the orchestrator —
currently the Windows installer + relaunch test, with the macOS counterpart
slotting in via the same list when authored) are **excluded from every
default regression pass on every platform**. They each build multiple full
release packages and exercise the real installer / relaunch path, so they
take 10–30 minutes on a cache miss and never belong in a routine `--build`
run. Pass `--include-update-e2e` only when the user explicitly asked to run
the update tests; on the wrong host platform those entries still SKIP with
reason `<platform>-only`. The design is symmetric — never invoke the
Windows suite by hand to "simulate" the flag, and never silently include
the macOS suite either.

A full pass typically takes 25–70 minutes (≈ 5–10 min build + 20–60
min runners). **Run it in the FOREGROUND with live output** so the user
can watch which case is running and spot a stall — have them run it via
the `!` prefix (`! py test/autotest/run-full-regression.py --build`); the
orchestrator streams every runner + key step + a silent-runner heartbeat
live into the conversation. See *Running with live progress* below for why
the `!` prefix (not a background Bash call) is the mechanism. If
`pnpm dist:dev` itself fails — or a
runner can't launch the app — the orchestrator stops before (or
mid-way through) the runner list. That is an **environment / toolchain
failure**, not a test result: first work the *Environment self-heal*
loop above (fix the missing prerequisite, re-run, bounded to ~3
attempts per symptom) so every test case actually gets to execute.
Only after self-heal is exhausted do you report the remaining blocker
to the user. Self-heal stays inside the environment / dependency /
process / disk scope — it never edits source, test, or fixture files
to get past a failure.

### Step 3 — Report counts only

Outputs land in `test/full-regression-results/<local-timestamp>/`
(directory name format `YYYYMMDDTHHMMSS`):

- `summary.log` — full streamed output + final pass/fail summary
- `summary.json` — machine-readable per-runner result
- `logs/<suite>.log` — per-runner stdout/stderr, one file each

Read `summary.json` and report to the user:

1. The numeric tally — `passed`, `failed`, `skipped`, `errored` —
   quoted verbatim.
2. The names of failing runners (`script` field for any entry whose
   `status` is `FAIL` or `TIMEOUT`). Just names. No log excerpts,
   no theories.
3. The full path to the run directory so the user can inspect it.
4. If failures > 0, end with one line: "Run `--repair` to enter
   repair mode for these failures."

**Do not** open `logs/<suite>.log`, do not search for assertion
markers, do not group by root cause, do not enter Plan Mode, do not
propose fixes. Test mode stops at "here's the score." The user picks
the next move.

---

## Mode B — Repair mode (`--repair`)

The user has already run the regression at least once and now wants
to fix the failures. Triggered by `--repair`, "fix / repair the
failures from the last full regression".

### Why production code, not tests

Every runner under `test/autotest/` and harness under `test/unittest/`
codifies a contract the application must satisfy from the user's
point of view. When a runner fails, the default assumption is that
the production code drifted from the contract, NOT that the test is
wrong:

> Treat the test as ground truth. Read the failure log carefully.
> Form a hypothesis about the production code path. Modify the
> production code until the test passes again.

Touching a test file is reserved for two narrow exceptions, both of
which require user confirmation before any edit:

1. The test itself contains a verifiable bug (wrong selector,
   off-by-one, stale fixture path).
2. The user has since intentionally removed the behaviour the test
   pinned.

When in doubt: leave the test alone, fix production.

### Hard precondition

Repair mode requires that a previous full regression run already
exists on disk. If `test/full-regression-results/` contains no
timestamped run directory, or the newest run directory has no
`summary.json` (the run was interrupted before write), STOP and tell
the user verbatim:

> `--repair` needs at least one prior full-regression run. Please
> run `python3 test/autotest/run-full-regression.py --build` first,
> then re-issue `--repair`.

Do **not** silently fall back to running a fresh regression — the
user said "repair", not "run".

### Step 1 — Locate the newest run

List `test/full-regression-results/` and pick the directory whose
name (format `YYYYMMDDTHHMMSS`) sorts last. Quote its full path back
to the user so they can confirm you're operating on the run they
had in mind — if they meant an older one they can redirect before
any work starts.

### Step 2 — Extract failures

Read `<run-dir>/summary.json`. Build the work list from every entry
whose `status` is `FAIL` or `TIMEOUT`. If the list is empty, report

> Previous run (`<run-dir>`) was already green — nothing to repair.

and exit. Do not run anything else.

### Step 3 — Initialise the progress file

Create `<run-dir>/repair-progress.json` (or reopen if a prior repair
pass against this run was interrupted). The original `summary.json`
and `summary.log` are the case file for the failing run and must
remain untouched — all repair-mode progress lives in this side-car
so the original evidence is preserved.

```json
{
  "source_run_dir": "test/full-regression-results/<YYYYMMDDTHHMMSS>",
  "started_at": "<ISO-8601 local>",
  "clusters": [
    {
      "id": "cluster-1",
      "hypothesis": "<one-sentence root-cause guess>",
      "scripts": ["test/autotest/run-<suite>-autotest.sh", "..."],
      "status": "pending",
      "verify_run_dir": null,
      "notes": ""
    }
  ],
  "final_full_run": null,
  "final_status": "in_progress"
}
```

Per-cluster `status`: `pending` (not started), `fixed` (production
change applied, not yet re-verified), `verified` (targeted re-run
green), `deferred` (user explicitly asked to skip this cluster this
round). Top-level `final_status`: `in_progress`, `all_green`,
`new_failures`.

### Step 4 — Cluster by root cause

Failures in the same subsystem most likely share one bug. For each
failing entry, open `logs/<suite>.log` and scan in this order for
markers: `[AutoTest] FAIL`, `AssertionError`, then `Error:` /
`error occurred in handler`. Scroll back from the marker to find the
test id (e.g. `PFM-42-…`, `SN-13-…`) and the observed-vs-expected
delta.

Group failures whose log evidence points at the same subsystem (e.g.
ProjectEditor markdown outline restore, Git Diff submodule discovery)
into one cluster. Order clusters by the size of the script set they
cover (largest first): fixing a shared root cause early often turns
several runners green in one cycle and keeps the verify-rebuild count
down. Write the clusters into `repair-progress.json`.

If a failure log is opaque, use the Explore subagent (or Grep / Read
directly) to walk the suspect code path before forming a hypothesis;
guessing wastes the user's time more than research does.

### Step 5 — Per-cluster fix loop

For each cluster whose `status` is `pending`:

**5a. Enter Plan Mode** with `EnterPlanMode`. Plan Mode blocks file
edits while you're still hypothesising; it surfaces your reasoning
to the user up front so they can redirect before code changes
happen. The plan must contain:

1. **Failure signature** — runner name(s), test id(s), ≤ 5 key log
   lines per runner.
2. **Root-cause hypothesis** — which production file / function /
   IPC contract drifted, and why that drift produces the observed
   failure. Cite specific `file:line` references.
3. **Proposed fix** — exact change, why it restores the contract
   without violating other guarantees in `CLAUDE.md` (input
   responsiveness, off-renderer threading, perf-trace instrumentation,
   multilingual i18n, cross-platform parity).
4. **Test-touch declaration** — state plainly **"no test files will
   be modified"**. If an exception applies (see "Why production code,
   not tests" above), name the test file, the line, the suspected
   bug in the test, and ask the user to confirm.
5. **Verification scope** — every script the cluster covers, listed
   so the re-run command is unambiguous.

Wait for `ExitPlanMode` (user approval). If the plan needs adjustment
after their feedback, stay in Plan Mode and revise — do not exit and
re-enter.

**5b. Apply the fix** after approval:

- Edit only the production files named in the plan. No adjacent
  refactors, no "while I'm here" cleanups.
- Do not modify any file under `test/autotest/**`, `test/unittest/**`,
  or `src/autotest/**` unless the plan declared a test-fix exception
  and the user approved it.
- Do not run `pnpm dist:dev` manually here — step 5c always uses
  `--build`, which performs the clean dev build immediately before
  the targeted re-run. Doing it twice wastes 5–10 minutes per cycle.
- Set the cluster's `status` to `fixed` in `repair-progress.json`
  immediately after edits, before running anything, so the file
  mirrors disk state even if 5c crashes.

**5c. Verify** with the orchestrator:

```bash
python3 test/autotest/run-full-regression.py --build --only run-<suite>
```

This rebuilds the dev package from your fix (clean `out/` +
`release/`, then `pnpm dist:dev`) and runs **only** the cluster's
scripts against the fresh package. If the cluster covers multiple
scripts, pass `--only` once per script (the orchestrator accepts
repeated `--only` filters).

- **Green**: set `status` to `verified`, record the new run
  directory in `verify_run_dir`, move on to the next `pending`
  cluster.
- **Still red**: return to step 5a for the **same** cluster — do
  not move on, do not silently iterate fixes. One plan, one
  approval, one fix; if the first attempt missed, the second gets
  its own plan and its own user approval.

If the user explicitly tells you to skip a cluster ("leave the EPUB
one for later"), set its status to `deferred` and continue.

### Step 6 — Final full-regression confirmation

Once every cluster is `verified` or `deferred`, run **one** final
full pass to catch cross-cluster regressions the targeted re-runs
could not see:

```bash
python3 test/autotest/run-full-regression.py --build
```

Record the new run directory in `final_full_run`.

- **All green** (`failed: 0`, ignoring scripts owned by `deferred`
  clusters which will still show red): set `final_status` to
  `all_green` and deliver the four-question task-completion report
  required by `CLAUDE.md`. End with: "Files staged: …, ready to
  commit when you are." DO NOT run `git commit`.
- **Something else regressed**: set `final_status` to
  `new_failures`, then re-enter repair mode against this newer run
  — a fresh repair pass starts, with its own `repair-progress.json`
  inside the newer timestamp dir, and its own per-cluster Plan-Mode
  approvals. Do not auto-loop without the user.

### Resumability

If repair is interrupted (the user closes the session, an edit
fails, a build dies), the next `--repair` invocation should:

1. Find the newest run dir.
2. If it has a `repair-progress.json` whose `final_status` is
   `in_progress`, reopen and continue from the first cluster whose
   status is not `verified` / `deferred`.
3. If the newest dir has *no* progress file but has FAIL entries,
   start fresh against it.
4. If a *newer* run dir exists than the one referenced by an older
   in-flight `repair-progress.json`, prefer the newer run — it
   supersedes the older case file. Tell the user so they know the
   older repair pass is being abandoned.

---

## Mode C — Clean mode (`--clean`)

The user wants to free disk space or get a clean slate before the
next `--build` run. Mode C is a thin wrapper that delegates to
`scripts/clean-test-data.py` — the single source of truth for which
gitignored test artefacts are safe to wipe.

### Sub-arguments

Accept exactly two pass-through tokens:

| User input                          | Script invocation                              |
|-------------------------------------|------------------------------------------------|
| `--clean` (no extra)                | dry-run preview, then `--yes` delete           |
| `--clean dry` / `--dry-run` / `-n`  | dry-run preview only; nothing deleted          |
| `--clean force` / `yes` / `-y`      | skip dry-run, run `--yes` immediately          |

For category-specific cleanup (`--traces`, `--regression`,
`--autotest-results`), invoke the script directly:
`python3 scripts/clean-test-data.py --traces` (etc.). Mode C
deliberately does not mirror the full flag matrix — duplicating it
would just create drift the next time the script gains a flag, and
power users can call the script with one extra word.

### Command flow

1. **Plan first.** Run

   ```bash
   python3 scripts/clean-test-data.py --dry-run
   ```

   and quote the output back to the user verbatim. The size column
   and per-category counts are the entire point of the preview — do
   not summarise them away.

2. **Confirm and delete.** If the user did not pass `force` / `yes`
   / `-y`, run the real command **with `--yes`**:

   ```bash
   python3 scripts/clean-test-data.py --yes
   ```

   The `--yes` bypasses the script's own TTY prompt because the
   harness cannot answer it; the user's chance to abort was reading
   the dry-run plan in step 1.

   If the user passed `dry` / `-n` in step 1, **stop here** — do not
   delete anything.

3. **Report the reclaim.** The script prints
   `Deleted N file(s), reclaimed X MB.` at the end — quote that line
   back as the closing summary.

### What gets deleted / preserved

Do **not** inline the target list here — it would drift. The
authoritative inventory lives in `scripts/clean-test-data.py`'s
`TARGETS` table (and its module docstring). In short: gitignored
test artefacts under `traces/` and `test/full-regression-results/`
and `test/autotest/results/` are removed; committed fixtures,
source code, and `.gitkeep` markers are preserved.

### Mid-repair safety

If a `<run-dir>/repair-progress.json` exists with `final_status:
in_progress`, Mode C is destructive to the active case file —
`test/full-regression-results/` is exactly what the repair loop
reads from. Before running anything, warn the user:

> A repair pass against `<run-dir>` is in progress
> (`repair-progress.json`, `final_status: in_progress`). Cleaning
> now will delete that case file. Confirm to proceed.

and require an explicit "yes, clean" before invoking the script.

---

## Boundaries

**Always:**

- Treat tests as the contract; production code is what drifts.
- Use `--build` on every regression invocation — Mode A's run, Mode
  B's per-cluster verify, and Mode B's final pass alike.
- Self-heal environment / toolchain blockers (missing interpreter or
  `pnpm`, absent `node_modules`, ABI mismatch, stale `out/` /
  `release/`, leftover app process, full disk) so every test case
  actually executes — bounded to ~3 attempts per symptom — then report
  exactly what you healed.

**Never:**

- Use environment self-heal as a backdoor to edit production, test,
  fixture, or orchestrator files. Self-heal is
  dependencies / processes / artefacts / interpreter only. A red
  assertion is a **contract** failure (Mode A reports it, Mode B fixes
  it with approval), never an "environment fix" — and a missing
  dependency is reported, not silently written into `package.json`.
- Auto-chain the three modes. Mode A reports counts and stops; Mode
  B operates on existing artefacts; Mode C only deletes. `--clean`
  never runs tests, never auto-runs `--build`, never auto-enters
  `--repair`. The user picks each transition.
- Modify files under `test/autotest/**`, `test/unittest/**`, or
  `src/autotest/**` without an explicit plan-stage acknowledgement
  AND user approval.
- Create commits automatically. Stage the change and report; the
  user calls the commit.
- Disable, skip, or comment out a failing test to "make the build
  green". That destroys the regression contract.
- Delete or edit `traces/` or `test/full-regression-results/`
  artefacts to mask a failure. `--clean` is the supported reset
  path; use it only when starting a fresh run is what the user
  wants.
- Reimplement deletion in Mode C. `--clean` MUST shell out to
  `scripts/clean-test-data.py`; do not call `rm`, `shutil.rmtree`,
  or maintain a parallel target list inline.
- Run `--clean` while a `repair-progress.json` with `final_status:
  in_progress` exists, without explicit user reconfirmation —
  wiping `test/full-regression-results/` mid-repair destroys the
  case file the repair loop reads from.
- Edit the original `summary.json` / `summary.log` of any prior
  regression run, even during `--repair`. Repair-mode progress goes
  into the side-car `repair-progress.json`.
- Wrap or substitute `run-full-regression.py`. The orchestrator
  owns the runner list, timeout, and kill contract; modifying its
  `SCRIPTS` list is a separate change reviewed on its own merits.
- Apply more than one fix cluster per Plan Mode pass. One plan, one
  approval, one fix.
- Start `--repair` when no prior run exists on disk. Refuse, point
  the user at `python3 test/autotest/run-full-regression.py --build`,
  and wait.

---

## Quick reference

| Output                                    | Use it to …                                                                  |
|-------------------------------------------|------------------------------------------------------------------------------|
| `summary.json`                            | Read pass/fail tally; in repair mode, loop over `status == "FAIL"` / `"TIMEOUT"` |
| `summary.log`                             | Quote the final PASS/FAIL block back to the user                             |
| `logs/<suite>.log`                        | (Repair mode only) find the assertion line and surrounding context           |
| `traces/test-logs/<suite>.log`            | Same as above, also live-tailable while a run is going                       |
| `repair-progress.json`                    | `--repair` side-car: cluster status (`pending` / `fixed` / `verified` / `deferred`) + final pass result |
| `python3 …/run-full-regression.py --list` | Pre-flight: confirm every runner is registered                               |
| `python3 scripts/clean-test-data.py --dry-run` | Mode C pre-flight: preview which artefacts `--clean` would delete       |

---

## Running with live progress (foreground via `!`, NOT background)

A full pass is long (≈ 5–10 min build + 20–60 min runners), so it is
tempting to background it — **don't, when the user wants to watch.**
Backgrounding sends the orchestrator's live output to a hidden task file,
so the user can't see which case is running or why it stalled. That is the
exact "卡住了都不知道原因" problem.

The orchestrator **already streams live** (no extra flag): it prints
`=== RUN [n/total] <suite> (timeout Ns) ===`, then each runner's output
line-by-line (flushed per line — every `[AutoTest] PASS/FAIL` and key
step), plus a `… <suite> still running Ns (no output for Ms)` **heartbeat**
during any output gap so a hung / silently-stuck runner is visible in real
time. The chain is fully live: runner →(stdio inherit) run-with-timeout
→(pipe) orchestrator →(flush per line) console.

The goal is to get that live stream into the **user's terminal**. The Bash
tool cannot: its foreground mode has a **10-minute hard cap** (far under the
run) and returns output only at the end, while its background mode hides
output in a file. The mechanism that streams a long-running command live
into the conversation is the **`!` prefix**.

**So: run the regression in the foreground via `!`.** Suggest this verbatim
and let the user run it — it executes in their session and the
orchestrator's live output lands directly in the conversation:

```
! py test/autotest/run-full-regression.py --build        # Windows
! python3 test/autotest/run-full-regression.py --build   # macOS/Linux
```

They will see, live: the per-runner `[n/total]` header, the streamed key
steps, the heartbeat for silent runners, and the final `DURATION AUDIT` +
over-budget list. (Add `--only run-<suite>` / `--skip run-<suite>` exactly
as in Mode A.)

**Do NOT** instead run it as a background Bash call when the user wants to
observe, and do NOT `tail -f` / poll a backgrounded run's log (it races the
writer and wastes context) — the live `!` stream IS the progress view. This
foreground-`!` rule is the regression-specific refinement of CLAUDE.md's
general background-and-notify test-execution loop: that loop optimises for
the Agent driving one runner unattended; this optimises for the **user
watching the whole suite live**, which is what they asked for.

If the user explicitly wants it driven unattended (not watching), the Agent
MAY background it and report counts at the end — but the default for a
user-invoked regression is the foreground `!` run.
