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
  - 5-minute hard timeout per runner, enforced via test/autotest/run-with-timeout.mjs.
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
import time
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import List, Optional

REPO_ROOT = Path(__file__).resolve().parent.parent.parent

# Mirrors test/full-regression-checklist.md § 7 SCRIPTS array.
SCRIPTS: List[str] = [
    "test/autotest/run-change-log-autotest.sh",
    "test/autotest/run-feedback-autotest.sh",
    "test/autotest/run-feedback-persistence-autotest.sh",
    "test/autotest/run-file-index-cache-ui-autotest.sh",
    "test/autotest/run-file-watch-autotest.sh",
    "test/autotest/run-git-cross-platform-autotest.sh",
    "test/autotest/run-git-diff-recursive-submodules-autotest.sh",
    "test/autotest/run-git-diff-staleness-and-submodule-autotest.sh",
    "test/autotest/run-git-diff-subdir-autotest.sh",
    "test/autotest/run-git-diff-submodules-autotest.sh",
    "test/autotest/run-git-history-multi-terminal-scope-autotest.sh",
    "test/autotest/run-git-nested-submodules-autotest.sh",
    "test/autotest/run-global-search-autotest.sh",
    "test/autotest/run-image-diff-autotest.sh",
    "test/autotest/run-markdown-latex-preview-autotest.sh",
    "test/autotest/run-mermaid-panzoom-autotest.sh",
    "test/autotest/run-pdf-epub-diff-autotest.sh",
    "test/autotest/run-pdf-epub-full-autotest.sh",
    "test/autotest/run-pdf-epub-preview-autotest.sh",
    "test/autotest/run-performance-trace-autotest.sh",
    "test/autotest/run-preview-search-autotest.sh",
    "test/autotest/run-project-editor-file-memory-autotest.sh",
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
    "test/autotest/run-subpage-navigation-autotest.sh",
    "test/autotest/run-subpage-viewstate-restore-autotest.sh",
    "test/autotest/run-telemetry-autotest.sh",
    "test/autotest/run-terminal-architecture-baseline-autotest.sh",
    "test/autotest/run-terminal-autofollow-autotest.sh",
    "test/autotest/run-terminal-cr-progress-autotest.sh",
    "test/autotest/run-terminal-focus-activation-autotest.sh",
    "test/autotest/run-terminal-perf-autotest.sh",
    "test/autotest/run-terminal-stress-autotest.sh",
    "test/autotest/run-task-layout-autotest.sh",
    "test/autotest/run-terminal-title-rename-autotest.sh",
    "test/autotest/run-trace-infra-self-check-autotest.sh",
    "test/autotest/run-perf-trace-rotation-autotest.sh",
    "test/autotest/run-working-directory-copy-autotest.sh",
]

WINDOWS_ONLY_SKIP = "test/autotest/run-auto-update-windows-e2e.sh"

PER_SCRIPT_TIMEOUT_SEC = 300
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
    cmd = [
        node, "test/autotest/run-with-timeout.mjs", str(PER_SCRIPT_TIMEOUT_SEC),
        bash, script, str(app_bin),
    ] + extra_args

    env = os.environ.copy()
    env["ONWARD_USER_DATA_DIR"] = user_data_dir
    env["ONWARD_REPO_ROOT"] = str(REPO_ROOT)

    start = time.monotonic()
    log_fh = log_path.open("w", encoding="utf-8")
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
        try:
            for line in proc.stdout:
                sys.stdout.write(line)
                sys.stdout.flush()
                log_fh.write(line)
                summary_fh.write(line)
            rc = proc.wait()
        except KeyboardInterrupt:
            proc.terminate()
            try:
                proc.wait(timeout=10)
            except subprocess.TimeoutExpired:
                proc.kill()
            raise
    finally:
        log_fh.close()

    return rc, time.monotonic() - start


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

    # Apply --only / --skip filters.
    scripts = list(SCRIPTS)
    if args.only:
        scripts = [s for s in scripts if any(o in s for o in args.only)]
    if args.skip:
        scripts = [s for s in scripts if not any(sk in s for sk in args.skip)]

    if args.list:
        print(f"Planned runners ({len(scripts)}):")
        for s in scripts:
            print(f"  {s}")
        print(f"Skipped (Windows-only): {WINDOWS_ONLY_SKIP}")
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
    emit(f"Per-script timeout: {PER_SCRIPT_TIMEOUT_SEC}s, inter-script sleep: {INTER_SCRIPT_SLEEP_SEC}s")
    emit(f"Bash: {bash}")
    emit(f"Node: {node}")
    emit("")

    dsm_repo = generate_recursive_submodule_fixture(node, emit)
    emit("")

    results: List[RunResult] = []

    # Mirror bash: log the Windows-only skip up front.
    emit(f"SKIP {WINDOWS_ONLY_SKIP} (Windows-only)")
    results.append(RunResult(
        script=WINDOWS_ONLY_SKIP, status="SKIP", exit_code=None,
        elapsed_sec=0.0, log_file="",
        note="Windows-only follow-up; intentionally skipped on every platform's full pass.",
    ))

    user_data_temp_dirs: List[str] = []
    interrupted = False

    try:
        for script in scripts:
            emit("")
            emit(f"=== RUN {script} ===")

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

            results.append(RunResult(
                script=script, status=status, exit_code=rc,
                elapsed_sec=round(elapsed, 1),
                log_file=str(log_path.relative_to(out_dir)),
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
