#!/usr/bin/env python3
# SPDX-FileCopyrightText: 2026 OPPO
# SPDX-License-Identifier: Apache-2.0
"""
Full Regression Runner — cross-platform Python orchestrator.

Mirrors the bash command in test/full-regression-checklist.md § 7, but uses
only the Python standard library so it runs identically on macOS / Linux /
Windows. On Windows the .sh runners are executed through Git Bash; if Git Bash
is not installed the script aborts with a clear error message rather than
silently skipping anything.

Behaviour highlights:
  - Same SCRIPTS list as the bash version, in the same order.
  - 3-minute default timeout per runner (per-script overrides allowed), enforced
    in two independent layers so the configured budget ALWAYS takes effect:
      1. test/autotest/run-with-timeout.mjs — inner wall-clock timer that kills
         the child tree at timeout_sec (force-kill 10s later).
      2. An orchestrator-side watchdog in run_one() — the main thread waits on the
         PROCESS (not on stdout reaching EOF), so a surviving/detached grandchild
         holding the stdout pipe can no longer stall the runner; and if the inner
         layer fails to make the wrapper exit, the watchdog force-kills the tree by
         PID + reaps the dev app by EXACT name at timeout_sec + grace and marks the
         runner TIMEOUT. Any runner exceeding its wall-clock budget is a failure.
  - 2-second inter-script gap; the dev app is killed by EXACT process name
    before and after every runner (CLAUDE.md hard rule — no wildcards).
  - Per-runner ONWARD_USER_DATA_DIR under the OS temp root, removed at the end.
  - Generates the recursive-git-submodule fixture once and threads its
    repoRoot into run-git-diff-submodules-autotest.sh.

Outputs (gitignored — local-only, share excerpts not the artefacts):
  test/full-regression-results/<local-timestamp>/
    summary.log              full streamed output + final pass/fail summary
    summary.json             machine-readable result of every runner
    logs/<suite>.log         per-runner stdout/stderr, one file each
  Timestamp format is the host's local time `YYYYMMDDTHHMMSS` (no UTC `Z`
  suffix) so directory names line up with what the developer sees on the
  wall clock.

Usage:
  python3 test/autotest/run-full-regression.py
  python3 test/autotest/run-full-regression.py --build           build dev package first
  python3 test/autotest/run-full-regression.py --only run-foo    filter by substring
  python3 test/autotest/run-full-regression.py --skip run-bar    exclude by substring
  python3 test/autotest/run-full-regression.py --app-bin <path>
  python3 test/autotest/run-full-regression.py --list            print SCRIPTS and exit
  python3 test/autotest/run-full-regression.py --repeat 3        run the same set N times
                                                                 in succession (stability gate
                                                                 for timing-sensitive runners
                                                                 such as PTY / WebGL / debounce
                                                                 / rAF / focus). Subsequent
                                                                 iterations skip --build.
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import platform
import re
import shutil
import signal
import subprocess
import sys
import tempfile
import threading
import time
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import List, Optional

# Live-progress heartbeat: while a runner produces NO output for this many
# seconds, the orchestrator emits a "still running" pulse so a hung / silently-
# stuck runner is visible in real time (instead of looking dead). Chatty runners
# never trigger it; it only fires during genuine output gaps.
HEARTBEAT_SEC = 30

# Force UTF-8 output so runner logs containing Unicode characters (e.g. ANSI
# escape sequences or non-ASCII identifiers) do not crash the orchestrator on
# Windows where the console code page may default to GBK / CP936.
# `reconfigure` is Python 3.7+; the `hasattr` guard keeps this safe on older
# interpreters that might be found on minimal CI images.
for _stream in [sys.stdout, sys.stderr]:
    if hasattr(_stream, 'reconfigure'):
        _stream.reconfigure(encoding='utf-8', errors='replace')

REPO_ROOT = Path(__file__).resolve().parent.parent.parent

# Mirrors test/full-regression-checklist.md § 7 SCRIPTS array.
SCRIPTS: List[str] = [
    "test/autotest/run-appstate-render-loop-autotest.sh",
    "test/autotest/run-change-log-autotest.sh",
    "test/autotest/run-feedback-autotest.sh",
    "test/autotest/run-feedback-persistence-autotest.sh",
    "test/autotest/run-file-index-cache-ui-autotest.sh",
    "test/autotest/run-file-watch-autotest.sh",
    "test/autotest/run-git-cross-platform-autotest.sh",
    "test/autotest/run-git-diff-click-latency-autotest.sh",
    "test/autotest/run-git-diff-identical-blob-autotest.sh",
    "test/autotest/run-git-diff-recursive-submodules-autotest.sh",
    # Split into 6 cost-balanced sub-5-min runners: the whole ~46-case GDS suite
    # ran ~890s under EDR (each diff forks ~69 git procs, taxed 1.3-12.9s/spawn;
    # the dominant cost is the diff LOAD itself, not restoreBaseline). A 4-way
    # still hit ~283s/group, so it was re-split 6 ways balanced by measured
    # per-case cost, each ~141-167s work + ~45s overhead (< 220). Shared body
    # run-git-diff-staleness-and-submodule-autotest.sh runs the whole suite via
    # GDS_GROUP='' / ONWARD_AUTOTEST_GDS_GROUP=''.
    "test/autotest/run-git-diff-submodule-autotest.sh",
    "test/autotest/run-git-diff-staleness-autotest.sh",
    "test/autotest/run-git-diff-reentry-autotest.sh",
    "test/autotest/run-git-diff-ux-presentation-autotest.sh",
    "test/autotest/run-git-diff-ux-tree-autotest.sh",
    "test/autotest/run-git-diff-model-sync-autotest.sh",
    "test/autotest/run-git-diff-nested-gitlink-autotest.sh",
    "test/autotest/run-git-large-file-confirmation-autotest.sh",
    # Split into -a (3 trials) + -b (2 trials): the whole 5-trial quit suite
    # overran its 180s budget under full-regression load (class-2). Shared body
    # stays in run-git-state-mirror-quit-autotest.sh (runnable whole, default 5).
    "test/autotest/run-git-state-mirror-quit-a-autotest.sh",
    "test/autotest/run-git-state-mirror-quit-b-autotest.sh",
    # Split into 4 sub-5-min runners: the whole suite overran 1500s (class-2).
    # static (fast, EDR-independent) + gsm17 + gsm18 baseline groups + the 3
    # watcher-failure-injection passes. gsm17/gsm18 can still fail on an EDR host
    # (slow git-status misses the convergence wait) — that is a pre-existing
    # EDR-timing issue, not budget; they pass on CI. Shared body stays in
    # run-git-state-mirror-latency-autotest.sh (runnable whole via LATENCY_MODE='').
    "test/autotest/run-git-state-mirror-latency-static-autotest.sh",
    "test/autotest/run-git-state-mirror-latency-gsm17-autotest.sh",
    "test/autotest/run-git-state-mirror-latency-gsm18-autotest.sh",
    "test/autotest/run-git-state-mirror-latency-injection-autotest.sh",
    "test/autotest/run-git-diff-subdir-autotest.sh",
    "test/autotest/run-git-diff-submodules-autotest.sh",
    "test/autotest/run-repo-prewarm-autotest.sh",
    "test/autotest/run-git-history-multi-terminal-scope-autotest.sh",
    "test/autotest/run-git-nested-submodules-autotest.sh",
    "test/autotest/run-global-search-autotest.sh",
    "test/autotest/run-image-diff-autotest.sh",
    "test/autotest/run-image-history-diff-autotest.sh",
    "test/autotest/run-markdown-latex-preview-autotest.sh",
    # Split by CPU phase (idle / post-scroll / editor): the whole 4-phase suite's
    # settle+sampling overran the 300s budget (class-2). Shared body stays in
    # run-markdown-preview-cpu-autotest.sh (runnable whole via MPC_ONLY_PHASE='').
    "test/autotest/run-markdown-preview-cpu-idle-autotest.sh",
    "test/autotest/run-markdown-preview-cpu-scroll-autotest.sh",
    "test/autotest/run-markdown-preview-cpu-editor-autotest.sh",
    "test/autotest/run-markdown-preview-latency-autotest.sh",
    "test/autotest/run-mermaid-panzoom-autotest.sh",
    "test/autotest/run-pdf-epub-diff-autotest.sh",
    "test/autotest/run-pdf-epub-full-autotest.sh",
    "test/autotest/run-pdf-epub-preview-autotest.sh",
    "test/autotest/run-performance-trace-autotest.sh",
    "test/autotest/run-preview-search-autotest.sh",
    "test/autotest/run-project-editor-file-memory-autotest.sh",
    "test/autotest/run-project-editor-large-file-autotest.sh",
    "test/autotest/run-project-editor-html-preview-autotest.sh",
    "test/autotest/run-project-editor-markdown-navigation-autotest.sh",
    "test/autotest/run-project-editor-markdown-session-restore-autotest.sh",
    "test/autotest/run-project-editor-multi-terminal-scope-autotest.sh",
    "test/autotest/run-project-editor-open-position-autotest.sh",
    "test/autotest/run-project-editor-restore-autotest.sh",
    "test/autotest/run-project-editor-restore-unit-autotest.sh",
    "test/autotest/run-project-editor-sqlite-autotest.sh",
    "test/autotest/run-prompt-editor-context-menu-autotest.sh",
    "test/autotest/run-prompt-input-latency-autotest.sh",
    "test/autotest/run-prompt-input-longtail-autotest.sh",
    "test/autotest/run-prompt-integrity-autotest.sh",
    "test/autotest/run-prompt-list-autotest.sh",
    "test/autotest/run-prompt-sender-autotest.sh",
    "test/autotest/run-schedule-autotest.sh",
    "test/autotest/run-settings-update-autotest.sh",
    "test/autotest/run-shell-integration-cwd-autotest.sh",
    "test/autotest/run-subpage-cdp-clicks-autotest.sh",
    "test/autotest/run-subpage-navigation-autotest.sh",
    "test/autotest/run-subpage-viewstate-restore-autotest.sh",
    "test/autotest/run-telemetry-autotest.sh",
    "test/autotest/run-terminal-architecture-baseline-autotest.sh",
    "test/autotest/run-terminal-autofollow-autotest.sh",
    "test/autotest/run-terminal-focus-activation-autotest.sh",
    "test/autotest/run-terminal-perf-autotest.sh",
    "test/autotest/run-terminal-stress-autotest.sh",
    "test/autotest/run-render-corruption-stress-autotest.sh",
    "test/autotest/run-task-layout-autotest.sh",
    "test/autotest/run-terminal-title-rename-autotest.sh",
    "test/autotest/run-terminal-rename-restart-survival-autotest.sh",
    "test/autotest/run-trace-infra-self-check-autotest.sh",
    "test/autotest/run-orchestrator-watchdog-autotest.sh",
    "test/autotest/run-perf-trace-rotation-autotest.sh",
    "test/autotest/run-unittest-suite-autotest.sh",
    "test/autotest/run-working-directory-copy-autotest.sh",
]

# Update-channel end-to-end suites. These build multiple full release packages
# (300+ MB each), spin up a local HTTP server, exercise the real installer /
# relaunch path, and take 10-30 minutes on a cache miss. They are intentionally
# excluded from the default regression run on every platform — opt in
# explicitly with --include-update-e2e.
#
# Each entry is (script_path, required platform.system() value). On the wrong
# platform the entry is still SKIP'd even when --include-update-e2e is passed
# (a Windows installer test cannot run on macOS). The design is symmetric: a
# macOS counterpart drops in by adding e.g.
#     ("test/autotest/run-auto-update-macos-e2e.sh", "Darwin"),
# below — no other code changes needed.
UPDATE_E2E_SCRIPTS: List["tuple[str, str]"] = [
    ("test/autotest/run-auto-update-windows-e2e.sh", "Windows"),
]

PER_SCRIPT_TIMEOUT_SEC = 180

# Orchestrator-side independent-watchdog grace. The inner run-with-timeout.mjs
# fires at timeout_sec and force-kills its child tree 10s later, so for a normal
# overrun that inner layer reaps the tree first and the watchdog never fires.
# Only if the inner layer FAILS to make the wrapper exit (a surviving/detached
# grandchild holding the stdout pipe, run-with-timeout itself wedged, or taskkill
# unable to reach a reparented process) does the orchestrator step in at
# timeout_sec + this grace, force-kill the tree by PID, reap the dev app by EXACT
# name, and mark the runner TIMEOUT. Keep this strictly larger than run-with-
# timeout's 10s internal force-kill gap so the inner layer always gets first crack.
ORCHESTRATOR_WATCHDOG_GRACE_SEC = 30

# ---------------------------------------------------------------------------
# Per-runner time budget (the "no test case over 5 minutes" rule).
#
# Every runner MUST complete within RUNNER_BUDGET_SEC. This is a DESIGN ceiling,
# not just a timeout: a suite that needs longer is doing too much in one process
# and must be SPLIT into multiple sub-5-minute runners (one logical group each),
# never given a bigger timeout. The orchestrator MONITORS every runner's wall
# time, and any runner whose elapsed time exceeds this budget is flagged
# OVER-BUDGET in the duration audit + summary.json (`over_budget`) so it triggers
# a split review — see the ow_full_regression_test skill § "5-minute budget".
#
# Note on EDR/anti-malware hosts: process spawns are taxed 1.3-12.9s, so a
# well-designed suite can still blow the budget on such a host. The audit FLAGS
# rather than hard-fails for this reason; the budget is enforced at AUTHORING
# time (keep each suite small) and verified on a healthy host / CI.
RUNNER_BUDGET_SEC = 300

# Per-script timeout overrides for runners whose end-to-end flow exceeds the 180s
# default. Add entries here (not by patching the runner) so the orchestrator's
# authority remains the single source of truth.
#
# HARD RULE: a new override MUST be <= RUNNER_BUDGET_SEC (300s). Any value ABOVE
# 300 is an OVER-BUDGET BACKLOG entry — a suite that violates the 5-minute rule
# and is pending a SPLIT into smaller runners. Such entries are listed at startup
# as "over-budget backlog" so they stay visible until split. Do NOT add new
# >300s entries; split the suite instead.
PER_SCRIPT_TIMEOUT_OVERRIDES_SEC = {
    # GitDiff staleness+submodule was split 6-way (the whole suite ran ~890s under
    # EDR — class-2, no longer a >300 backlog). Each group is cost-balanced to
    # ~141-167s work + ~45s overhead on this EDR host (the dominant cost is the
    # diff load itself, ~69 git procs/diff). 280 override keeps headroom above the
    # 180s default for the few estimate-only cases while staying < 300 (NOT backlog);
    # measured groups land well under, so this can tighten to ~200 once confirmed.
    "test/autotest/run-git-diff-submodule-autotest.sh": 280,
    "test/autotest/run-git-diff-staleness-autotest.sh": 280,
    "test/autotest/run-git-diff-reentry-autotest.sh": 280,
    "test/autotest/run-git-diff-ux-presentation-autotest.sh": 280,
    "test/autotest/run-git-diff-ux-tree-autotest.sh": 280,
    "test/autotest/run-git-diff-model-sync-autotest.sh": 280,
    # Nested-gitlink (no .gitmodules) suite: one app session + 3 IPC calls over a
    # tiny 1-parent + 2-gitlink fixture. Kept deliberately small/fast (NOT amended
    # into the 600s staleness suite); the 150s in-app watchdog caps a hang.
    "test/autotest/run-git-diff-nested-gitlink-autotest.sh": 180,
    # GitDiff click-latency suite measures multi-trial first-click vs
    # cache-warm latencies; needs more headroom than 180s allows.
    "test/autotest/run-git-diff-click-latency-autotest.sh": 300,
    # PDF / EPUB suites render large binary fixtures through PDF.js; the test
    # source for pdf-epub-preview alone is 1000+ lines covering font, outline,
    # search, and state-restore.  Measured: 88 assertions completed in 600s
    # (pdf-state-scale-changed, near end of suite) — needs ~120s more headroom.
    "test/autotest/run-pdf-epub-preview-autotest.sh": 900,
    # pdf-epub-full adds diff + history on top of preview.
    "test/autotest/run-pdf-epub-full-autotest.sh": 1200,
    "test/autotest/run-preview-search-autotest.sh": 300,
    # Longtail suite simulates many keystrokes across 5+ latency scenarios;
    # 180s default is not enough on Windows dev boxes.
    "test/autotest/run-prompt-input-longtail-autotest.sh": 360,
    # markdown-preview-cpu was split by phase. -scroll / -editor fit the default
    # 180s. The -idle phase (15s settle + idle CPU samples, each sample spawns a
    # process taxed 1-13s by EDR on this host) is the heaviest; its wrapper trims
    # the sample count to 40 so it lands ~180s here with headroom. 240s < 300s
    # (NOT over-budget backlog); ~80s on a healthy CI host.
    "test/autotest/run-markdown-preview-cpu-idle-autotest.sh": 240,
    # GitStateMirror latency was split by group (static / gsm17 / gsm18 /
    # injection). injection fits the default 180s. static (badge matrix), gsm17
    # (same-tab two-task) and gsm18 (cross-tab) are the heavy convergence groups; on
    # this EDR host each badge-convergence step waits out its budget before the slow
    # `git status` lands, so they need headroom — still < 300s (NOT over-budget
    # backlog), and far faster on a healthy CI host. static completes ~130-175s but
    # swings with EDR load, so 240s protects its 180s default from a spurious TIMEOUT.
    # gsm17 trims to 2 trials when run as the isolated split (group='gsm17') — on EDR
    # each trial is ~65s (every step waits the full convergence timeout), so 5 trials
    # overran 290s and 3 overran 240s; 2 trials (~210s) fit the 270s override. The
    # whole-suite run keeps 5 trials.
    "test/autotest/run-git-state-mirror-latency-static-autotest.sh": 240,
    "test/autotest/run-git-state-mirror-latency-gsm17-autotest.sh": 270,
    "test/autotest/run-git-state-mirror-latency-gsm18-autotest.sh": 240,
    # Repo prewarm WIRING suite: a single app launch + ~35s dwell to let the
    # default terminal attach and fire the prewarm trigger event, then a trace
    # assertion. EDR-independent (the event fires before any git spawn), but the
    # app start itself can be slow on EDR-throttled hosts — give it headroom.
    "test/autotest/run-repo-prewarm-autotest.sh": 180,
    # Nested-submodule suite builds a 5-deep recursive-submodule fixture before
    # the app launches. The build is ~50 git spawns (init/add/commit + one
    # `submodule update --init` per level + a final root `--recursive`); on this
    # EDR/anti-malware host each git spawn is taxed 1.3-12.9s, so the COLD build
    # alone measures ~172s (down from ~294s after dropping the O(depth^2)
    # intermediate `--recursive` updates — see create-nested-git-submodule-
    # fixture.mjs). No single git op hangs (build completes exit 0); this is pure
    # EDR-tax accumulation. Build (~172s) + the app session's history/diff IPC
    # walks (~60-90s under EDR) sum past the 180s default but stay under 300s, so
    # this is a budget override (NOT over-budget backlog / NOT a split).
    "test/autotest/run-git-nested-submodules-autotest.sh": 280,
    # Image HISTORY diff was split out of run-image-diff (the deadlock-fixed
    # remainder fits the 180s default). The history half owns the EDR-expensive
    # throwaway history repo (git init + 4 commits ~8 spawns taxed 1.3-12.9s each)
    # plus the image-history diff/swipe/onion walks, summing past 180s but under
    # 300s on this EDR host — budget override, NOT over-budget backlog.
    "test/autotest/run-image-history-diff-autotest.sh": 280,
    # Image (working-tree) diff exercises Keep/Deny against the LIVE Onward repo
    # (101 changed files + submodules). The discardFile git op is deterministic,
    # but the post-deny `force` full-diff RELOAD is racey under EDR: if a worker
    # getDiff reply is lost, the worker's concurrency-1 lane stays occupied until
    # the worker-side request timeout (90s) frees it, so the list cannot refresh
    # to `untracked` until then. The test absorbs this with an internally
    # aggregated recovery loop (DENY_RESTORE_RECOVERY_BUDGET_MS = 105s, re-driving
    # refreshChanges) instead of a single 12s sample. Baseline ~77s + a worst-case
    # ~105s recovery sums past the 180s default but stays well under 300s — budget
    # override for the documented worker-lane-recovery cost, NOT a hidden hang.
    "test/autotest/run-image-diff-autotest.sh": 240,
}
INTER_SCRIPT_SLEEP_SEC = 2

IS_WINDOWS = platform.system() == "Windows"


@dataclass
class RunResult:
    script: str
    status: str  # PASS / FAIL / TIMEOUT / SKIP / ERROR
    exit_code: Optional[int]
    elapsed_sec: float
    log_file: str
    note: str = ""
    # True when elapsed_sec exceeded RUNNER_BUDGET_SEC (the 5-min design ceiling).
    # Independent of pass/fail: a PASS that ran 6 min is still over budget and
    # must be split. Surfaced in the duration audit + summary.json.
    over_budget: bool = False


# ---------------------------------------------------------------------------
# Environment detection
# ---------------------------------------------------------------------------

def _read_branch() -> str:
    try:
        out = subprocess.check_output(
            ["git", "rev-parse", "--abbrev-ref", "HEAD"],
            cwd=str(REPO_ROOT),
            stderr=subprocess.DEVNULL,
        ).decode("utf-8", errors="replace").strip()
    except Exception:
        out = "detached"
    if not out or out == "HEAD":
        out = "detached"
    out = re.sub(r"[^a-zA-Z0-9._-]+", "-", out)
    out = re.sub(r"-+", "-", out).strip("-")
    return out or "detached"


def _read_version() -> str:
    pkg_path = REPO_ROOT / "package.json"
    try:
        return json.loads(pkg_path.read_text(encoding="utf-8"))["version"]
    except Exception:
        return "0.0.0"


def detect_app_name() -> str:
    return f"Under Development {_read_version()}-{_read_branch()}"


def resolve_app_bin(app_name: str) -> Optional[Path]:
    candidates = [
        REPO_ROOT / "release" / "mac-arm64" / f"{app_name}.app" / "Contents" / "MacOS" / app_name,
        REPO_ROOT / "release" / "mac" / f"{app_name}.app" / "Contents" / "MacOS" / app_name,
        REPO_ROOT / "release" / "linux-unpacked" / app_name,
        REPO_ROOT / "release" / "win-unpacked" / f"{app_name}.exe",
    ]
    for c in candidates:
        if c.exists():
            if IS_WINDOWS or os.access(str(c), os.X_OK):
                return c
    return None


def find_bash() -> str:
    bash = shutil.which("bash")
    if bash:
        return bash
    if IS_WINDOWS:
        for candidate in (
            r"C:\Program Files\Git\bin\bash.exe",
            r"C:\Program Files (x86)\Git\bin\bash.exe",
            os.path.expandvars(r"%LOCALAPPDATA%\Programs\Git\bin\bash.exe"),
        ):
            if Path(candidate).exists():
                return candidate
        sys.exit(
            "ERROR: bash not found. The .sh runners require Git Bash on Windows.\n"
            "  Install Git for Windows from https://git-scm.com/download/win\n"
            "  and ensure 'bash' is on PATH (or installed at the default location)."
        )
    sys.exit("ERROR: bash not found on PATH.")


def find_node() -> str:
    node = shutil.which("node")
    if not node:
        sys.exit("ERROR: node not found on PATH. Install Node.js (>=18) and retry.")
    return node


# ---------------------------------------------------------------------------
# Process helpers — exact-name match only, per CLAUDE.md hard rule.
# ---------------------------------------------------------------------------

def sweep_autotest_root_leftovers(emit) -> int:
    """Remove direct REPO_ROOT children matching `__autotest_*`.

    The TS autotest suites (test-image-diff, test-pdf-epub-{preview,diff},
    test-git-diff-subdir) write fixtures into ONWARD_AUTOTEST_CWD which the
    runners set to the repo root. When a runner crashes mid-run those fixtures
    leak into the working tree. The runner-level EXIT trap is the primary
    defence; this sweep is a belt-and-braces safety net at the orchestrator
    layer in case a future runner forgets the trap.

    Returns the count of paths removed (0 on a clean run).
    """
    removed = 0
    for entry in REPO_ROOT.iterdir():
        if entry.name.startswith("__autotest_"):
            try:
                if entry.is_dir() and not entry.is_symlink():
                    shutil.rmtree(str(entry), ignore_errors=True)
                else:
                    entry.unlink()
                emit(f"[cleanup] removed leftover {entry.name}")
                removed += 1
            except Exception as e:  # noqa: BLE001
                emit(f"[cleanup] failed to remove {entry.name}: {e}")
    return removed


def kill_app(app_name: str) -> None:
    """Kill the dev app by EXACT process name. Wildcards are forbidden."""
    if IS_WINDOWS:
        # /IM matches the image (process) name exactly. Add .exe suffix.
        subprocess.run(
            ["taskkill", "/F", "/IM", f"{app_name}.exe"],
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        )
    else:
        # `pkill -x` requires an exact match against the comm name.
        subprocess.run(
            ["pkill", "-x", app_name],
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        )


def force_kill_tree(proc: "subprocess.Popen") -> None:
    """Force-kill a spawned runner process tree by PID (watchdog escalation).

    Used ONLY when the orchestrator's independent deadline fires, i.e. the inner
    run-with-timeout.mjs failed to reap the tree in time. On Windows, taskkill /T
    /F walks the live PPID tree (python -> node-wrapper -> bash -> node-launcher
    -> app), which is intact because the launcher keeps the app non-detached
    (check-renderer-idle-churn.mjs uses stdio 'ignore', detached:false on win32).
    On POSIX the orchestrator only owns the node-wrapper pid; bash runs in its own
    session, so kill the wrapper pid here and rely on the caller's kill_app(EXACT
    name) to reap a surviving dev app. Exact PID / exact name only — never a
    wildcard or substring (CLAUDE.md hard rule)."""
    if proc.poll() is not None:
        return
    if IS_WINDOWS:
        subprocess.run(
            ["taskkill", "/F", "/T", "/PID", str(proc.pid)],
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        )
    else:
        try:
            proc.kill()
        except Exception:  # noqa: BLE001 — already exited between poll and kill
            pass


# ---------------------------------------------------------------------------
# Environment pre-flight — fail fast when the installed node_modules has
# drifted from the committed dependency spec.
#
# This is the structural form of the skill's self-heal "install incomplete"
# rows: instead of discovering a stale / unpatched dependency 30 minutes into a
# build+run cycle (a red WebGL-atlas assertion, or a runner that can't resolve
# the Electron binary at runtime), assert the two highest-signal invariants up
# front and abort in ~1 second with an actionable fix.
#
# Scope is deliberately honest: this catches THIS class of drift — the Electron
# binary and the @xterm/addon-webgl global-monotonic patch — NOT every possible
# dependency-integrity problem. Add a new (name, fn) row to `preflight_env_check`
# when a future "the install must look like X" signal is discovered.
#
# Cross-platform by construction: pure pathlib + byte search, no shell, no
# platform branch. Runs identically under `py` on Windows and `python3` on
# macOS / Linux, so Windows gets the same fast-fail with zero extra wiring.
# ---------------------------------------------------------------------------

# Sentinel emitted by the global-monotonic AtlasPage version backport
# (PR #5883) that the @xterm/addon-webgl patch applies: every page version is
# drawn from a single ever-increasing counter via `constructor._nv`. The
# UNPATCHED 0.18.0 bundle contains zero occurrences; the patched bundle has
# several. If the addon is version-bumped and the patch's mechanism changes,
# update this token to whatever marker the new patch introduces.
WEBGL_PATCH_SENTINEL = b"_nv"


def _check_electron_binary(repo_root: Path) -> Optional[str]:
    """Failure detail, or None when the Electron binary is present.

    `electron`'s postinstall writes path.txt (the relative path to the platform
    binary inside dist/) and downloads dist/. pnpm's default "ignored build
    scripts" can skip that download, leaving require('electron') unresolvable —
    which silently breaks any runner that resolves the binary at runtime.
    Platform-neutral: path.txt content differs per OS (Electron.app/… vs
    electron.exe vs electron) but the "referenced file exists" check is identical.
    """
    electron_dir = repo_root / "node_modules" / "electron"
    if not electron_dir.is_dir():
        return "node_modules/electron is absent (dependencies not installed)"
    path_txt = electron_dir / "path.txt"
    if not path_txt.is_file():
        return "node_modules/electron/path.txt is missing (electron postinstall did not run)"
    try:
        rel = path_txt.read_text(encoding="utf-8").strip()
    except OSError as e:  # noqa: BLE001
        return f"could not read node_modules/electron/path.txt: {e}"
    if not rel:
        return "node_modules/electron/path.txt is empty"
    binary = electron_dir / "dist" / rel
    if not binary.exists():
        return f"electron binary missing at node_modules/electron/dist/{rel} (postinstall download skipped)"
    return None


def _check_webgl_patch(repo_root: Path) -> Optional[str]:
    """Failure detail, or None when the addon-webgl patch is applied.

    Only enforced while package.json still declares the @xterm/addon-webgl patch
    under pnpm.patchedDependencies — removing the patch from the spec therefore
    retires this invariant automatically, leaving no stale check behind.
    """
    pkg = repo_root / "package.json"
    try:
        data = json.loads(pkg.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None  # cannot read the spec — do not block on a parse error here
    patched = (data.get("pnpm") or {}).get("patchedDependencies") or {}
    if not any(k.startswith("@xterm/addon-webgl@") for k in patched):
        return None  # spec no longer patches the addon — invariant retired
    bundle = repo_root / "node_modules" / "@xterm" / "addon-webgl" / "lib" / "addon-webgl.js"
    if not bundle.is_file():
        return "node_modules/@xterm/addon-webgl/lib/addon-webgl.js is missing (dependency not installed)"
    try:
        blob = bundle.read_bytes()
    except OSError as e:  # noqa: BLE001
        return f"could not read the addon-webgl bundle: {e}"
    if WEBGL_PATCH_SENTINEL not in blob:
        return (
            "addon-webgl bundle is UNPATCHED — the global-monotonic atlas "
            "page-version fix is absent (this ships WebGL terminal corruption "
            "under multi-task render load)"
        )
    return None


def _check_native_modules(repo_root: Path) -> Optional[str]:
    """Failure detail, or None when the app's compiled native module is present.

    The project's own postinstall (`electron-rebuild -w node-pty,better-sqlite3`)
    rebuilds these against Electron's ABI. If that postinstall was interrupted —
    or never ran because an earlier dependency build aborted the install — the
    .node is absent and every SQLite suite fails at runtime with a module-load
    error. better_sqlite3's output path (build/Release/) is stable across
    platforms, so a presence check is platform-neutral. Only enforced when
    better-sqlite3 is actually installed (else the project no longer uses it).
    """
    installed = list(repo_root.glob("node_modules/.pnpm/better-sqlite3@*"))
    if not installed:
        return None  # dependency absent from this tree — nothing to assert
    built = list(repo_root.glob(
        "node_modules/.pnpm/better-sqlite3@*/node_modules/better-sqlite3/build/Release/better_sqlite3.node"
    ))
    if not built:
        return (
            "better_sqlite3.node is missing — the project postinstall "
            "(electron-rebuild) did not produce the Electron-ABI native module "
            "(SQLite suites will fail at runtime with a module-load error)"
        )
    return None


def preflight_env_check(emit) -> bool:
    """Assert the installed node_modules matches the committed dependency spec.

    Returns True when healthy. On failure, emits an actionable report and
    returns False so the caller can abort before the expensive build+run cycle.
    """
    invariants = [
        ("Electron binary installed", _check_electron_binary),
        ("WebGL addon-webgl patch applied", _check_webgl_patch),
        ("App native module built", _check_native_modules),
    ]
    failures: List["tuple[str, str]"] = []
    for name, fn in invariants:
        detail = fn(REPO_ROOT)
        if detail:
            failures.append((name, detail))
    if not failures:
        return True
    emit("ERROR: environment pre-flight failed — node_modules has drifted from the committed dependency spec.")
    for name, detail in failures:
        emit(f"  ✗ {name}: {detail}")
    emit("")
    emit("  Fix (reconcile node_modules to the spec, then re-run):")
    emit("    pnpm install                              # applies pnpm.patchedDependencies")
    emit("    node node_modules/electron/install.js     # if the Electron binary is missing")
    emit("")
    emit("  Bypass (only after a deliberate version bump that changed a sentinel):")
    emit("    --skip-env-check   (or set ONWARD_SKIP_ENV_PREFLIGHT=1)")
    return False


# ---------------------------------------------------------------------------
# Optional pre-build
# ---------------------------------------------------------------------------

def run_dev_build(emit) -> int:
    emit("Running pnpm dist:dev (this may take several minutes) …")
    out_dir = REPO_ROOT / "out"
    release_dir = REPO_ROOT / "release"
    for d in (out_dir, release_dir):
        if d.exists():
            shutil.rmtree(str(d), ignore_errors=True)
    env = os.environ.copy()
    env["ONWARD_DIST_DEV_OPEN"] = "0"
    pnpm = shutil.which("pnpm")
    if pnpm is None:
        emit("ERROR: pnpm not found on PATH.")
        return 127
    rc = subprocess.call([pnpm, "dist:dev"], cwd=str(REPO_ROOT), env=env)
    if rc != 0:
        emit(f"ERROR: pnpm dist:dev exited with {rc}")
    return rc


# ---------------------------------------------------------------------------
# Fixture for git-diff-submodules
# ---------------------------------------------------------------------------

def generate_recursive_submodule_fixture(node: str, emit) -> Optional[str]:
    emit("Generating recursive-git-submodule fixture …")
    proc = subprocess.run(
        [node, "test/autotest/create-recursive-git-submodule-fixture.mjs"],
        cwd=str(REPO_ROOT),
        capture_output=True,
        text=True,
    )
    if proc.returncode != 0:
        emit(f"ERROR: fixture generation failed (rc={proc.returncode})")
        if proc.stderr:
            emit(proc.stderr.rstrip())
        return None
    try:
        data = json.loads(proc.stdout)
        repo_root = data["repoRoot"]
    except Exception as e:  # noqa: BLE001
        emit(f"ERROR: cannot parse fixture JSON: {e}\nRaw: {proc.stdout!r}")
        return None
    emit(f"Submodule fixture repo root: {repo_root}")
    return repo_root


# ---------------------------------------------------------------------------
# Single runner execution
# ---------------------------------------------------------------------------

def run_one(
    *,
    script: str,
    bash: str,
    node: str,
    app_bin: Path,
    app_name: str,
    user_data_dir: str,
    log_path: Path,
    summary_fh,
    extra_args: List[str],
) -> "tuple[int, float]":
    timeout_sec = PER_SCRIPT_TIMEOUT_OVERRIDES_SEC.get(script, PER_SCRIPT_TIMEOUT_SEC)
    cmd = [
        node, "test/autotest/run-with-timeout.mjs", str(timeout_sec),
        bash, script, str(app_bin),
    ] + extra_args

    env = os.environ.copy()
    env["ONWARD_USER_DATA_DIR"] = user_data_dir
    env["ONWARD_REPO_ROOT"] = str(REPO_ROOT)

    # Inject the orchestrator's own Python as PYTHON3 so .sh runners can use
    # ${PYTHON3:-python3} portably.  On Windows, 'python3' is not a recognized
    # command alias, but sys.executable always points to the running interpreter.
    env["PYTHON3"] = sys.executable

    # On Windows, Python spawns bash with the raw Windows PATH, so POSIX tools
    # such as find(1) and sort(1) resolve to System32 built-ins (DOS find.exe,
    # DOS sort.exe) rather than the GNU versions bundled with Git for Windows.
    # Prepend Git Bash's usr/bin (GNU coreutils) and mingw64/bin so every
    # runner sees the correct tools regardless of the invoking shell's PATH.
    if IS_WINDOWS:
        bash_path = Path(bash).resolve()
        for candidate_root in [
            bash_path.parent,
            bash_path.parent.parent,
            bash_path.parent.parent.parent,
        ]:
            if (candidate_root / "usr" / "bin" / "find.exe").exists():
                prepend = os.pathsep.join([
                    str(candidate_root / "usr" / "bin"),
                    str(candidate_root / "mingw64" / "bin"),
                    str(candidate_root / "bin"),
                ])
                env["PATH"] = prepend + os.pathsep + env.get("PATH", "")
                break

    start = time.monotonic()
    hard_deadline_sec = timeout_sec + ORCHESTRATOR_WATCHDOG_GRACE_SEC
    log_fh = log_path.open("w", encoding="utf-8")
    timed_out = False
    rc: Optional[int] = None
    try:
        proc = subprocess.Popen(
            cmd,
            cwd=str(REPO_ROOT),
            env=env,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            bufsize=1,
            text=True,
            errors="replace",
        )
        assert proc.stdout is not None
        # Serialize console/log writes; the shared mutable last_output[0] lets the
        # heartbeat observe the reader thread's progress.
        io_lock = threading.Lock()
        last_output = [time.monotonic()]
        stop_hb = threading.Event()
        stem = Path(script).stem

        # Drain the runner's stdout on a DAEMON thread so the main thread can
        # enforce a hard deadline INDEPENDENTLY of whether proc.stdout ever reaches
        # EOF. A surviving/detached grandchild can hold the pipe write-end open
        # forever; blocking the main loop on that read (the old `for line in
        # proc.stdout`) is exactly the bug that let the configured timeout never
        # take effect. As a daemon, this thread is abandoned cleanly if a held pipe
        # keeps it blocked after the process has already exited.
        def reader() -> None:
            try:
                for line in proc.stdout:
                    with io_lock:
                        sys.stdout.write(line)
                        sys.stdout.flush()
                        log_fh.write(line)
                        summary_fh.write(line)
                    last_output[0] = time.monotonic()
            except Exception:  # noqa: BLE001 — pipe torn down by a kill; benign
                pass

        # Heartbeat: during any gap with NO runner output >= HEARTBEAT_SEC, print a
        # "still running" pulse so a silently-stuck runner is visible live. The lock
        # serializes writes so the pulse never interleaves mid-line with output.
        def heartbeat() -> None:
            while not stop_hb.wait(HEARTBEAT_SEC):
                now = time.monotonic()
                silent = now - last_output[0]
                if silent >= HEARTBEAT_SEC:
                    pulse = (f"  … {stem} still running "
                             f"{now - start:.0f}s (no output for {silent:.0f}s; "
                             f"timeout {timeout_sec}s, watchdog {hard_deadline_sec:.0f}s)\n")
                    with io_lock:
                        sys.stdout.write(pulse)
                        sys.stdout.flush()
                        summary_fh.write(pulse)
                        summary_fh.flush()

        reader_thread = threading.Thread(target=reader, daemon=True)
        hb_thread = threading.Thread(target=heartbeat, daemon=True)
        reader_thread.start()
        hb_thread.start()

        # Main thread waits on the PROCESS, not the pipe. proc.wait() returns the
        # instant the run-with-timeout.mjs wrapper exits — even if a grandchild
        # still holds the stdout pipe — so a wedged pipe can no longer stall the
        # runner. If the inner timeout layer ALSO fails to make the wrapper exit,
        # the orchestrator's own deadline force-kills the tree by PID and reaps the
        # dev app by EXACT name, guaranteeing the configured budget takes effect.
        try:
            while True:
                try:
                    rc = proc.wait(timeout=1.0)
                    break
                except subprocess.TimeoutExpired:
                    if time.monotonic() - start >= hard_deadline_sec:
                        timed_out = True
                        msg = (f"  ⚠ WATCHDOG: {stem} exceeded {hard_deadline_sec:.0f}s "
                               f"(timeout {timeout_sec}s + {ORCHESTRATOR_WATCHDOG_GRACE_SEC}s "
                               f"grace) without exiting — force-killing the runner tree.\n")
                        with io_lock:
                            sys.stdout.write(msg)
                            sys.stdout.flush()
                            log_fh.write(msg)
                            summary_fh.write(msg)
                            summary_fh.flush()
                        force_kill_tree(proc)
                        kill_app(app_name)
                        try:
                            rc = proc.wait(timeout=10)
                        except subprocess.TimeoutExpired:
                            rc = 124
                        break
        except KeyboardInterrupt:
            force_kill_tree(proc)
            kill_app(app_name)
            try:
                proc.wait(timeout=10)
            except subprocess.TimeoutExpired:
                pass
            raise
        finally:
            stop_hb.set()
            hb_thread.join(timeout=2)
            # Daemon reader: give it a beat to flush the final buffered lines after
            # the process exited; abandon it if a held pipe keeps it blocked.
            reader_thread.join(timeout=2)
    finally:
        log_fh.close()

    if timed_out:
        return 124, time.monotonic() - start
    return (rc if rc is not None else 1), time.monotonic() - start


# ---------------------------------------------------------------------------
# Stability-mode wrapper: --repeat N
# ---------------------------------------------------------------------------

def run_repeated(args) -> int:
    """
    Re-spawn this same script N times. Each iteration is a fully isolated
    child process with its own timestamped output directory; only iteration
    1 inherits --build (subsequent iterations re-use the package).

    Why subprocess re-spawn rather than an in-process loop: it gives each
    iteration the cleanest possible state — no leaked module-level singletons,
    no subprocess-tracking accumulation across iterations, and the exact
    same code path as a single run, so flakes that only appear after many
    iterations of accumulated state stay reproducible.

    Exit 0 only if every iteration passes; otherwise 1. Iterations are NOT
    short-circuited on first failure — we want the per-iteration histogram
    so the author sees "fails 1 / 3" vs "fails 3 / 3" patterns.
    """
    base_args = [a for a in sys.argv[1:]]
    # Strip --repeat <N> from the child args; the child should run a single
    # iteration each time.
    cleaned: List[str] = []
    skip_next = False
    for arg in base_args:
        if skip_next:
            skip_next = False
            continue
        if arg == "--repeat":
            skip_next = True
            continue
        if arg.startswith("--repeat="):
            continue
        cleaned.append(arg)

    iteration_summaries: List[dict] = []
    overall_start = time.monotonic()
    for i in range(1, args.repeat + 1):
        # First iteration honours --build if requested; later iterations
        # re-use the package built in iteration 1.
        if i == 1:
            child_args = list(cleaned)
        else:
            child_args = [a for a in cleaned if a != "--build"]
        print("", flush=True)
        print(f"=== ITERATION {i}/{args.repeat} ===", flush=True)
        iter_start = time.monotonic()
        proc = subprocess.run(
            [sys.executable, str(Path(__file__).resolve()), *child_args],
            cwd=str(REPO_ROOT),
        )
        elapsed = time.monotonic() - iter_start
        # Best-effort: pick up the most recent timestamped output dir the
        # child just produced so the stability summary can point at it.
        results_root = REPO_ROOT / "test" / "full-regression-results"
        ts_dir: Optional[str] = None
        if results_root.is_dir():
            entries = sorted(
                (p for p in results_root.iterdir() if p.is_dir()),
                key=lambda p: p.stat().st_mtime,
                reverse=True,
            )
            if entries:
                ts_dir = entries[0].name
        iteration_summaries.append({
            "iteration": i,
            "exit_code": proc.returncode,
            "elapsed_sec": round(elapsed, 1),
            "timestamp_dir": ts_dir,
        })

    total_elapsed = time.monotonic() - overall_start
    failed_iterations = [s for s in iteration_summaries if s["exit_code"] != 0]
    print("", flush=True)
    print(f"=== STABILITY SUMMARY (--repeat {args.repeat}) ===", flush=True)
    for s in iteration_summaries:
        verdict = "PASS" if s["exit_code"] == 0 else f"FAIL (exit={s['exit_code']})"
        ts = s["timestamp_dir"] or "(unknown dir)"
        print(f"  Iteration {s['iteration']}: {verdict} — {s['elapsed_sec']:.0f}s — {ts}", flush=True)
    print(f"Total elapsed: {total_elapsed:.0f}s", flush=True)
    if failed_iterations:
        print(
            f"Verdict: NOT STABLE — {len(failed_iterations)} / {args.repeat} iterations failed.",
            flush=True,
        )
        print(
            "Inspect each failing iteration's logs/<suite>.log under "
            f"{REPO_ROOT}/test/full-regression-results/<timestamp>/.",
            flush=True,
        )
        return 1
    print(
        f"Verdict: STABLE — {args.repeat} / {args.repeat} iterations passed.",
        flush=True,
    )
    return 0


# ---------------------------------------------------------------------------
# Main orchestrator
# ---------------------------------------------------------------------------

def main() -> int:
    parser = argparse.ArgumentParser(
        description="Run the full Onward regression suite (cross-platform).",
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument(
        "--build", action="store_true",
        help="Run `rm -rf out release && pnpm dist:dev` before regression.",
    )
    parser.add_argument(
        "--only", action="append", default=[], metavar="SUBSTR",
        help="Only run scripts whose path contains SUBSTR (repeatable).",
    )
    parser.add_argument(
        "--skip", action="append", default=[], metavar="SUBSTR",
        help="Skip scripts whose path contains SUBSTR (repeatable).",
    )
    parser.add_argument(
        "--app-bin", default=None,
        help="Override the resolved dev app binary path.",
    )
    parser.add_argument(
        "--list", action="store_true",
        help="Print the planned script list (post-filter) and exit.",
    )
    parser.add_argument(
        "--skip-env-check", action="store_true",
        help=(
            "Skip the node_modules-vs-spec pre-flight. Use only after a "
            "deliberate version bump that changed a checked sentinel."
        ),
    )
    parser.add_argument(
        "--include-update-e2e", action="store_true",
        help=(
            "Include the update-channel E2E suites (UPDATE_E2E_SCRIPTS) in the "
            "run list. Default: every entry is SKIP'd. Each entry only runs on "
            "its required platform; on the wrong platform it still SKIPs with "
            "reason '<platform>-only'. Designed symmetric across macOS and "
            "Windows — add a Darwin entry to UPDATE_E2E_SCRIPTS to enable the "
            "same opt-in path for macOS."
        ),
    )
    parser.add_argument(
        "--repeat", type=int, default=1, metavar="N",
        help=(
            "Run the (filtered) regression set N times back-to-back. "
            "Each iteration gets its own timestamped output directory and "
            "summary; only iteration 1 honours --build. "
            "Exit 0 only if every iteration passes; otherwise 1. "
            "Use this to validate timing-sensitive runners — single-run "
            "stability is not real stability."
        ),
    )
    args = parser.parse_args()
    if args.repeat < 1:
        sys.stderr.write("ERROR: --repeat must be >= 1.\n")
        return 2

    # Environment pre-flight: abort in ~1s if node_modules drifted from the
    # committed spec, instead of failing 30 min into a build+run cycle. Skipped
    # for --list (pure inspection) and when explicitly bypassed. Runs once here
    # for both the single-run and --repeat paths (the latter spawns children
    # that would re-check anyway, but failing before any spawn is cheaper).
    if (
        not args.list
        and not args.skip_env_check
        and os.environ.get("ONWARD_SKIP_ENV_PREFLIGHT") != "1"
    ):
        if not preflight_env_check(lambda m: print(m, flush=True)):
            return 3

    if args.repeat > 1:
        return run_repeated(args)

    bash = find_bash()
    node = find_node()

    if args.build:
        # We don't have summary_fh yet — emit goes straight to stdout.
        rc = run_dev_build(lambda m: print(m, flush=True))
        if rc != 0:
            return rc

    app_name = detect_app_name()
    app_bin = Path(args.app_bin) if args.app_bin else resolve_app_bin(app_name)
    if app_bin is None:
        sys.stderr.write(
            f"ERROR: cannot locate dev app binary for '{app_name}'.\n"
            f"  Looked under {REPO_ROOT / 'release'}.\n"
            f"  Build it first: `rm -rf out release && pnpm dist:dev`,\n"
            f"  or rerun this script with --build.\n"
        )
        return 2

    # Classify update-e2e entries: opt-in (default SKIP), or platform-matched
    # when --include-update-e2e is set. Non-matching entries SKIP with a
    # "<plat>-only" reason so the summary still records their existence.
    host_plat = platform.system()
    update_e2e_to_run: List[str] = []
    update_e2e_skipped: List["tuple[str, str]"] = []  # (script, reason)
    for script, required_plat in UPDATE_E2E_SCRIPTS:
        if not args.include_update_e2e:
            update_e2e_skipped.append((script, "opt-in via --include-update-e2e"))
        elif required_plat != host_plat:
            update_e2e_skipped.append((script, f"{required_plat}-only"))
        else:
            update_e2e_to_run.append(script)

    # Apply --only / --skip filters across SCRIPTS + opted-in update-e2e
    # entries so power users can do e.g. `--include-update-e2e --only auto-update`.
    scripts = list(SCRIPTS) + update_e2e_to_run
    if args.only:
        scripts = [s for s in scripts if any(o in s for o in args.only)]
    if args.skip:
        scripts = [s for s in scripts if not any(sk in s for sk in args.skip)]

    if args.list:
        print(f"Planned runners ({len(scripts)}):")
        for s in scripts:
            print(f"  {s}")
        if update_e2e_skipped:
            print("Skipped update-e2e:")
            for s, reason in update_e2e_skipped:
                print(f"  {s} ({reason})")
        return 0

    # Output dir sits under test/ next to the runners it drives. It's
    # gitignored — runs stay local; share excerpts back to the user instead
    # of committing the artefacts.
    # Local time, not UTC, so the directory name matches the developer's
    # wall clock when they go looking for a recent run.
    now_local = dt.datetime.now().astimezone()
    ts = now_local.strftime("%Y%m%dT%H%M%S")
    out_dir = REPO_ROOT / "test" / "full-regression-results" / ts
    logs_dir = out_dir / "logs"
    logs_dir.mkdir(parents=True, exist_ok=True)
    summary_log_path = out_dir / "summary.log"
    summary_json_path = out_dir / "summary.json"
    summary_fh = summary_log_path.open("w", encoding="utf-8")

    def emit(msg: str) -> None:
        print(msg, flush=True)
        summary_fh.write(msg + "\n")
        summary_fh.flush()

    emit(f"Full regression timestamp (local): {ts} ({now_local.strftime('%z %Z').strip()})")
    emit(f"Repo root: {REPO_ROOT}")
    emit(f"Platform: {platform.system()} {platform.release()} ({platform.machine()})")
    emit(f"App name: {app_name}")
    emit(f"App binary: {app_bin}")
    emit(f"Output dir: {out_dir}")
    emit(f"Per-script timeout: {PER_SCRIPT_TIMEOUT_SEC}s default, "
         f"5-min budget: {RUNNER_BUDGET_SEC}s, inter-script sleep: {INTER_SCRIPT_SLEEP_SEC}s")
    if PER_SCRIPT_TIMEOUT_OVERRIDES_SEC:
        emit("Per-script timeout overrides:")
        for script, timeout_sec in sorted(PER_SCRIPT_TIMEOUT_OVERRIDES_SEC.items()):
            emit(f"  {script}: {timeout_sec}s")
    # Surface the over-budget backlog up front: any configured override above the
    # 5-min budget is a suite that violates the rule and is pending a SPLIT.
    backlog = sorted(
        ((s, t) for s, t in PER_SCRIPT_TIMEOUT_OVERRIDES_SEC.items() if t > RUNNER_BUDGET_SEC),
        key=lambda x: x[1], reverse=True,
    )
    if backlog:
        emit(f"⚠ OVER-BUDGET BACKLOG: {len(backlog)} runner(s) have a timeout above the "
             f"{RUNNER_BUDGET_SEC}s budget and MUST be split into sub-5-min runners:")
        for script, timeout_sec in backlog:
            emit(f"  {script}: {timeout_sec}s")
    emit(f"Bash: {bash}")
    emit(f"Node: {node}")
    emit("")

    dsm_repo = generate_recursive_submodule_fixture(node, emit)
    emit("")

    results: List[RunResult] = []

    # Record update-e2e SKIPs up front so summary.json always reflects their
    # existence — whether opted out (default) or platform-mismatched.
    for script, reason in update_e2e_skipped:
        emit(f"SKIP {script} ({reason})")
        results.append(RunResult(
            script=script, status="SKIP", exit_code=None,
            elapsed_sec=0.0, log_file="",
            note=reason,
        ))

    user_data_temp_dirs: List[str] = []
    interrupted = False

    try:
        total = len(scripts)
        for idx, script in enumerate(scripts, 1):
            timeout_sec = PER_SCRIPT_TIMEOUT_OVERRIDES_SEC.get(script, PER_SCRIPT_TIMEOUT_SEC)
            over = "  ⚠ over 5-min budget" if timeout_sec > RUNNER_BUDGET_SEC else ""
            emit("")
            emit(f"=== RUN [{idx}/{total}] {script} (timeout {timeout_sec}s){over} ===")

            # Skip git-diff-submodules cleanly if the fixture generation failed.
            if (
                script == "test/autotest/run-git-diff-submodules-autotest.sh"
                and dsm_repo is None
            ):
                emit("SKIP — recursive-git-submodule fixture unavailable")
                results.append(RunResult(
                    script=script, status="SKIP", exit_code=None,
                    elapsed_sec=0.0, log_file="",
                    note="fixture generation failed",
                ))
                continue

            kill_app(app_name)
            time.sleep(INTER_SCRIPT_SLEEP_SEC)

            user_data = tempfile.mkdtemp(prefix="onward-regression-userdata.")
            user_data_temp_dirs.append(user_data)

            log_path = logs_dir / (Path(script).stem + ".log")

            extra_args: List[str] = []
            if script == "test/autotest/run-git-diff-submodules-autotest.sh":
                # Runner takes (APP_BIN, LOG_FILE, REPO_ROOT_FOR_FIXTURE).
                # Point its internal log inside traces/test-logs/ to satisfy
                # the trace-artefact location rule.
                runner_internal_log = REPO_ROOT / "traces" / "test-logs" / "git-diff-submodules-autotest.log"
                runner_internal_log.parent.mkdir(parents=True, exist_ok=True)
                extra_args = [str(runner_internal_log), dsm_repo or ""]

            try:
                rc, elapsed = run_one(
                    script=script,
                    bash=bash,
                    node=node,
                    app_bin=app_bin,
                    app_name=app_name,
                    user_data_dir=user_data,
                    log_path=log_path,
                    summary_fh=summary_fh,
                    extra_args=extra_args,
                )
            except KeyboardInterrupt:
                emit("")
                emit("INTERRUPTED — stopping after current runner.")
                interrupted = True
                kill_app(app_name)
                results.append(RunResult(
                    script=script, status="ERROR", exit_code=None,
                    elapsed_sec=0.0,
                    log_file=str(log_path.relative_to(out_dir)),
                    note="interrupted by user (SIGINT)",
                ))
                break

            over_budget = elapsed > RUNNER_BUDGET_SEC
            if rc == 0:
                status = "PASS"
                emit(f"PASS {script} ({elapsed:.0f}s)")
            elif rc in (124, 137):
                status = "TIMEOUT"
                emit(f"FAIL {script} (timeout after {elapsed:.0f}s)")
                kill_app(app_name)
            else:
                status = "FAIL"
                emit(f"FAIL {script} (exit={rc}, {elapsed:.0f}s)")

            # 5-minute budget check (the "no test case over 5 min" rule): flag
            # the instant a runner overruns, so a slow suite is visible inline,
            # not just in the end-of-run audit.
            if over_budget:
                emit(f"  ⚠ OVER 5-MIN BUDGET: {script} ran {elapsed:.0f}s "
                     f"(> {RUNNER_BUDGET_SEC}s) — split this suite into smaller runners.")

            results.append(RunResult(
                script=script, status=status, exit_code=rc,
                elapsed_sec=round(elapsed, 1),
                log_file=str(log_path.relative_to(out_dir)),
                over_budget=over_budget,
            ))

            kill_app(app_name)
            # Defence-in-depth: even with the per-runner EXIT traps, sweep
            # `__autotest_*` from the repo root after each script so a crash
            # before the trap fires (or a missing trap in a future runner)
            # cannot pollute the working tree.
            sweep_autotest_root_leftovers(emit)
            time.sleep(INTER_SCRIPT_SLEEP_SEC)
    finally:
        for d in user_data_temp_dirs:
            shutil.rmtree(d, ignore_errors=True)

    passed = sum(1 for r in results if r.status == "PASS")
    failed = sum(1 for r in results if r.status in ("FAIL", "TIMEOUT"))
    skipped = sum(1 for r in results if r.status == "SKIP")
    errored = sum(1 for r in results if r.status == "ERROR")

    emit("")
    emit("=== FULL REGRESSION SUMMARY ===")
    emit(f"Passed:  {passed}")
    emit(f"Failed:  {failed}")
    emit(f"Skipped: {skipped}")
    if errored:
        emit(f"Errored: {errored}")
    if failed:
        emit("Failed scripts:")
        for r in results:
            if r.status in ("FAIL", "TIMEOUT"):
                tag = "TIMEOUT" if r.status == "TIMEOUT" else f"exit={r.exit_code}"
                emit(f"  {r.script} ({tag})")

    # ---- Elapsed-time monitor + 5-minute budget check (the "no test case over
    # 5 min" rule). The duration audit lists every runner slowest-first so slow
    # suites are always visible; the over-budget list is the split-review trigger.
    ran = [r for r in results if r.status != "SKIP"]
    over_budget_results = [r for r in ran if r.over_budget]
    if ran:
        emit("")
        emit(f"=== DURATION AUDIT (slowest first; 5-min budget = {RUNNER_BUDGET_SEC}s) ===")
        for r in sorted(ran, key=lambda x: x.elapsed_sec, reverse=True):
            flag = "  ⚠ OVER BUDGET" if r.over_budget else ""
            emit(f"  {r.elapsed_sec:7.0f}s  {r.status:7s} {Path(r.script).stem}{flag}")
    if over_budget_results:
        emit("")
        emit(f"⚠ OVER 5-MIN BUDGET: {len(over_budget_results)} runner(s) exceeded "
             f"{RUNNER_BUDGET_SEC}s and MUST be split into smaller sub-5-min runners "
             "(see the ow_full_regression_test skill § '5-minute budget'):")
        for r in sorted(over_budget_results, key=lambda x: x.elapsed_sec, reverse=True):
            emit(f"  {r.elapsed_sec:7.0f}s  {r.script}")

    if interrupted:
        emit("Run was interrupted before completion.")
    emit("")
    emit(f"Per-runner logs: {logs_dir}")
    emit(f"Summary JSON:    {summary_json_path}")

    summary_json_path.write_text(json.dumps({
        "timestamp_local": ts,
        "timestamp_local_iso": now_local.isoformat(timespec="seconds"),
        "repo_root": str(REPO_ROOT),
        "platform": platform.system(),
        "app_name": app_name,
        "app_bin": str(app_bin),
        "interrupted": interrupted,
        "passed": passed,
        "failed": failed,
        "skipped": skipped,
        "errored": errored,
        "budget_sec": RUNNER_BUDGET_SEC,
        "over_budget": [
            {"script": r.script, "elapsed_sec": r.elapsed_sec, "status": r.status}
            for r in sorted(over_budget_results, key=lambda x: x.elapsed_sec, reverse=True)
        ],
        "results": [asdict(r) for r in results],
    }, indent=2) + "\n", encoding="utf-8")

    summary_fh.close()

    if interrupted:
        return 130
    return 1 if failed else 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        sys.exit(130)
