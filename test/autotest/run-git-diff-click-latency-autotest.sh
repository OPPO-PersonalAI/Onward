#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2026 OPPO
# SPDX-License-Identifier: Apache-2.0
#
# Click → render latency localisation suite. Walks every file in the host
# repo's working set, simulates a click, and asserts the click→paint
# duration stays under the target. Output lands in
# <repoRoot>/traces/test-logs/git-diff-click-latency-autotest.log so a
# post-mortem can read it without rerunning the build.

set -euo pipefail

REPO_ROOT="${REPO_ROOT:-$(cd "$(dirname "$0")/../.." && pwd)}"
ROOT_DIR="$REPO_ROOT"
source "$ROOT_DIR/test/autotest/resolve-dev-app-bin.sh"
APP_BIN="${1:-$(resolve_dev_app_bin "$ROOT_DIR" || true)}"
LOG_FILE="${2:-$REPO_ROOT/traces/test-logs/git-diff-click-latency-autotest.log}"
mkdir -p "$(dirname "$LOG_FILE")"
SUITE_NAME="git-diff-click-latency"
if [[ -n "${GDCL_CAP:-}" ]]; then
  SUITE_NAME="${SUITE_NAME};cap=${GDCL_CAP}"
fi
WATCHDOG_SEC="${GDCL_WATCHDOG_SEC:-180}"

if [[ -z "$APP_BIN" || ! -x "$APP_BIN" ]]; then
  echo "ERROR: app binary not found or not executable: ${APP_BIN:-<empty>}" >&2
  echo "Run a development build first: rm -rf out release && pnpm dist:dev" >&2
  exit 1
fi

USER_DATA_DIR="$(mktemp -d "${TMPDIR:-/tmp}/onward-gdcl-userdata.XXXXXX")"
FIXTURE_ROOT=""

cleanup() {
  # Sweep `__autotest_*` debris at the repo root left over by other suites
  # we did NOT run (defensive, per CLAUDE.md autotest cleanup contract).
  find "$REPO_ROOT" -maxdepth 1 -name "__autotest_*" -exec rm -rf {} + 2>/dev/null || true
  rm -rf "$USER_DATA_DIR" 2>/dev/null || true
  if [[ -n "$FIXTURE_ROOT" ]]; then
    rm -rf "$FIXTURE_ROOT" 2>/dev/null || true
  fi
}
trap cleanup EXIT INT TERM

rm -f "$LOG_FILE"

FIXTURE_JSON="$(node "$REPO_ROOT/test/autotest/create-git-diff-click-latency-fixture.mjs")"
FIXTURE_ROOT="$(node -e 'const data = JSON.parse(process.argv[1]); process.stdout.write(data.root)' "$FIXTURE_JSON")"
if [[ -z "$FIXTURE_ROOT" || ! -d "$FIXTURE_ROOT/.git" ]]; then
  echo "ERROR: failed to create isolated Git Diff click-latency fixture" >&2
  echo "Fixture JSON: $FIXTURE_JSON" >&2
  exit 1
fi

echo "Starting Git Diff click→render latency autotest..."
echo "  Binary:        $APP_BIN"
echo "  Repo:          $REPO_ROOT"
echo "  Fixture repo:  $FIXTURE_ROOT"
echo "  User data dir: $USER_DATA_DIR"
echo "  Suite:         $SUITE_NAME"
echo "  Watchdog:      ${WATCHDOG_SEC}s"
echo "  Log:           $LOG_FILE"
echo ""

APP_EXIT=0
ONWARD_DEBUG=1 \
ONWARD_PERF_TRACE=1 \
ONWARD_REPO_ROOT="$REPO_ROOT" \
ONWARD_USER_DATA_DIR="$USER_DATA_DIR" \
ONWARD_AUTOTEST=1 \
ONWARD_AUTOTEST_SUITE="$SUITE_NAME" \
ONWARD_AUTOTEST_CWD="$FIXTURE_ROOT" \
ONWARD_AUTOTEST_EXIT=1 \
node "$REPO_ROOT/test/autotest/run-with-timeout.mjs" "$WATCHDOG_SEC" "$APP_BIN" > "$LOG_FILE" 2>&1 || APP_EXIT=$?

echo ""
echo "=== Test log (last 120 lines) ==="
tail -n 120 "$LOG_FILE"
echo ""

if [[ "$APP_EXIT" -eq 124 ]]; then
  echo "Click→render latency autotest exceeded ${WATCHDOG_SEC}s watchdog" >&2
  exit 124
fi

if [[ "$APP_EXIT" -ne 0 ]]; then
  echo "Click→render latency autotest app exited with code $APP_EXIT" >&2
  exit "$APP_EXIT"
fi

if ! grep -q "\[AutoTest\] === Autotest Completed ===" "$LOG_FILE"; then
  echo "Click→render latency autotest did not reach the completion marker" >&2
  exit 1
fi

if grep -q "\[AutoTest\] FAIL" "$LOG_FILE" \
  || grep -Eq "totalFailed: [1-9][0-9]*" "$LOG_FILE" \
  || grep -q "runtime-errors-detected" "$LOG_FILE" \
  || grep -q "FAIL gdcl-" "$LOG_FILE"; then
  echo "Click→render latency autotest reported FAIL" >&2
  echo ""
  echo "=== Failure details ==="
  grep "\[AutoTest\] FAIL\|totalFailed: [1-9]\|runtime-errors-detected\|FAIL gdcl-\|gdcl:" "$LOG_FILE" >&2 || true
  exit 1
fi

# Phase-chain trace assertion. The in-app debug panel surfaces a
# JadeTree-style breakdown that's also emitted as perf-trace spans
# every time a click measurement seals (see clickLatencyTraceEmitter.ts
# and src/utils/click-phase-event-names.ts). After clicking through the
# whole working set, every one of those event names should appear at
# least once in the perf trace log — otherwise the chain regressed
# silently and the panel's stats / Perfetto SQL queries would lie.
TRACE_DIR="$REPO_ROOT/traces/perf"
LATEST_POINTER="$TRACE_DIR/latest.txt"
# Resolve the directory that actually holds this run's perf chunks. The pointer
# (`latest.txt`) normally holds the trace DIRECTORY path; older runs may have
# left a single chunk-file path, or the pointer may be missing/stale. In every
# case we resolve a directory and then scan ALL chunks inside it — a single run
# with ONWARD_PERF_TRACE=1 rotates output across many `perf-*.jsonl` chunks, so
# any one chunk is an unreliable sample of the phase-chain events.
PERF_SCAN_DIR="$TRACE_DIR"
if [[ -f "$LATEST_POINTER" ]]; then
  POINTER_VALUE="$(cat "$LATEST_POINTER")"
  if [[ -n "$POINTER_VALUE" && -d "$POINTER_VALUE" ]]; then
    PERF_SCAN_DIR="$POINTER_VALUE"
  elif [[ -n "$POINTER_VALUE" && -f "$POINTER_VALUE" ]]; then
    PERF_SCAN_DIR="$(dirname "$POINTER_VALUE")"
  fi
fi

# Collect every perf chunk in the resolved directory. Perf chunks are
# ndjson-chunked `perf-*.jsonl` (older runs may have `*.json`).
shopt -s nullglob
PERF_CHUNKS=("$PERF_SCAN_DIR"/perf-*.jsonl "$PERF_SCAN_DIR"/*.json)
shopt -u nullglob

if [[ "${#PERF_CHUNKS[@]}" -eq 0 ]]; then
  echo "ERROR: cannot locate any perf trace chunk under $PERF_SCAN_DIR" >&2
  exit 1
fi

PHASE_EVENTS=(
  'renderer:git-diff.click-phase.ipc'
  'renderer:git-diff.click-phase.state-set'
  'renderer:git-diff.click-phase.model-bind'
  'renderer:git-diff.click-phase.mount'
  'renderer:git-diff.click-phase.diff-compute'
  'renderer:git-diff.click-phase.dom-commit'
  'renderer:git-diff.click-phase.paint'
  'renderer:git-diff.click-phase.tokenize-settle'
  'renderer:git-diff.click-phase.total'
  'renderer:git-diff.cache-invalidation'
)
MISSING_EVENTS=()
for evt in "${PHASE_EVENTS[@]}"; do
  # Grep the CONCATENATION of every perf chunk, not just the newest one.
  # A single ONWARD_PERF_TRACE run fans events out across rotating chunks, so
  # an event (e.g. renderer:git-diff.click-phase.ipc) routinely lands in a
  # different chunk than the one the pointer/newest-by-mtime would pick.
  if ! grep -hq "$evt" "${PERF_CHUNKS[@]}"; then
    MISSING_EVENTS+=("$evt")
  fi
done

if [[ "${#MISSING_EVENTS[@]}" -gt 0 ]]; then
  echo "ERROR: phase chain regression — these events never reached the trace chunks:" >&2
  for evt in "${MISSING_EVENTS[@]}"; do
    echo "  - $evt" >&2
  done
  echo "  trace dir: $PERF_SCAN_DIR (${#PERF_CHUNKS[@]} chunks scanned)" >&2
  exit 1
fi

echo "Phase chain assertion PASS — all expected RENDERER_GIT_DIFF_CLICK_PHASE_* events present"
echo "Click→render latency autotest PASS"
