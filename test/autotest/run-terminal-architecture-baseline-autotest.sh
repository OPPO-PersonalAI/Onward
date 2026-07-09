#!/usr/bin/env bash
set -euo pipefail

# SPDX-FileCopyrightText: 2026 OPPO
# SPDX-License-Identifier: Apache-2.0

# Terminal architecture baseline autotest runner (macOS/Linux)
# For Windows, use run-terminal-architecture-baseline-autotest.ps1

REPO_ROOT="${REPO_ROOT:-$(cd "$(dirname "$0")/../.." && pwd)}"
ROOT_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
source "$ROOT_DIR/test/autotest/resolve-dev-app-bin.sh"

APP_BIN="${1:-$(resolve_dev_app_bin "$ROOT_DIR")}"
LOG_FILE="${2:-$REPO_ROOT/traces/test-logs/terminal-architecture-baseline-autotest.log}"
mkdir -p "$(dirname "$LOG_FILE")"
RESULT_DIR="$ROOT_DIR/test/autotest/results/terminal-architecture-baseline"
mkdir -p "$RESULT_DIR"
RESULT_FILE="${3:-$RESULT_DIR/baseline-$(date +%Y%m%d-%H%M%S).json}"
COMPARE_BASELINE="${4:-${ONWARD_PERF_COMPARE_BASELINE:-}}"
COMPARE_PROFILE="${5:-${ONWARD_PERF_COMPARE_PROFILE:-optimization}}"

if [[ -z "${APP_BIN:-}" || ! -x "$APP_BIN" ]]; then
  echo "App binary not found: ${APP_BIN:-<empty>}" >&2
  echo "Run a development build first: rm -rf out release && pnpm dist:dev" >&2
  exit 1
fi

echo "Preparing terminal architecture baseline fixture..."
node "$ROOT_DIR/test/autotest/prepare-terminal-architecture-baseline-fixture.mjs"

WORK_DIR="$ROOT_DIR/test/autotest/fixtures/terminal-architecture-baseline/workdir"
USER_DATA_DIR="$ROOT_DIR/test/autotest/fixtures/terminal-architecture-baseline/user-data"
case "$USER_DATA_DIR" in
  "$ROOT_DIR"/test/autotest/fixtures/terminal-architecture-baseline/user-data)
    onward_robust_rm "$USER_DATA_DIR"
    mkdir -p "$USER_DATA_DIR"
    ;;
  *)
    echo "Refusing to delete userData outside repo: $USER_DATA_DIR" >&2
    exit 1
    ;;
esac
rm -f "$LOG_FILE"

echo "Starting Terminal Architecture Baseline autotest..."
echo "  Binary:   $APP_BIN"
echo "  CWD:      $WORK_DIR"
echo "  UserData: $USER_DATA_DIR"
echo "  Platform: $(uname -s)"
echo "  Log:      $LOG_FILE"
echo "  Result:   $RESULT_FILE"
echo

PROCESS_NAME="$(basename "$APP_BIN")"
if command -v pkill >/dev/null 2>&1; then
  pkill -x "$PROCESS_NAME" 2>/dev/null || true
  sleep 0.5
fi

ONWARD_DEBUG=1 \
ONWARD_AUTOTEST=1 \
ONWARD_AUTOTEST_SUITE=terminal-architecture-baseline \
ONWARD_AUTOTEST_CWD="$WORK_DIR" \
ONWARD_AUTOTEST_EXIT=1 \
ONWARD_USER_DATA_DIR="$USER_DATA_DIR" \
"$APP_BIN" >"$LOG_FILE" 2>&1

echo
echo "=== Test log (last 160 lines) ==="
tail -n 160 "$LOG_FILE" || true
echo

MARKER="[TerminalArchitectureBaseline:RESULT]"
LINE="$(grep -F "$MARKER" "$LOG_FILE" | tail -n 1 || true)"
if [[ -n "$LINE" ]]; then
  # Quote MARKER inside the parameter expansion so bash 3.x (the macOS system
  # bash) treats it as a literal string. Without the quotes, the `[..]` in the
  # marker is parsed as a glob character class and strips the wrong prefix
  # ("[R" is dropped because R is in the class), corrupting JSON_PAYLOAD.
  JSON_PAYLOAD="${LINE#*"$MARKER"}"
  # Use json.dumps instead of json.tool: Python 3.13+ json.tool emits ANSI
  # colour codes even when writing to a plain file, which breaks the later
  # json.load() call in the baseline-summary step.
  printf '%s\n' "$JSON_PAYLOAD" | "${PYTHON3:-python3}" -c \
    "import json,sys; sys.stdout.write(json.dumps(json.loads(sys.stdin.read()),indent=2)+'\n')" \
    > "$RESULT_FILE"
fi

if grep -q "\[AutoTest\] FAIL" "$LOG_FILE"; then
  echo "Terminal Architecture Baseline autotest FAILED" >&2
  if [[ -s "$RESULT_FILE" ]]; then
    echo "  Result: $RESULT_FILE" >&2
  fi
  grep "\[AutoTest\] FAIL" "$LOG_FILE" >&2 || true
  exit 1
fi

if [[ ! -s "$RESULT_FILE" ]]; then
  echo "Missing terminal architecture baseline result marker." >&2
  exit 1
fi

echo "Terminal Architecture Baseline autotest PASSED"
echo "  Log:    $LOG_FILE"
echo "  Result: $RESULT_FILE"
echo
echo "=== Baseline summary ==="
"${PYTHON3:-python3}" - "$RESULT_FILE" <<'PY'
import json
import sys

with open(sys.argv[1], 'r', encoding='utf-8') as handle:
    data = json.load(handle)

for scenario in data.get('scenarios', []):
    latency = scenario.get('inputLatency', {})
    perf = scenario.get('perf', {})
    print(
        f"  {scenario.get('id')}: "
        f"input p95={latency.get('p95Ms')}ms "
        f"max={latency.get('maxMs')}ms "
        f"avgFps={perf.get('avgFps')} "
        f"ipc/s={perf.get('avgIpcMsgPerSec')}"
    )

derived = data.get('derived', {})
print(f"  visible output p95 delta vs idle: {derived.get('visibleOutputP95DeltaVsIdleMs')}ms")
print(f"  git pressure p95 delta vs output: {derived.get('visibleGitP95DeltaVsOutputMs')}ms")
print(f"  hidden git p95 delta vs visible git: {derived.get('hiddenGitP95DeltaVsVisibleGitMs')}ms")
print(f"  search pressure p95 delta vs output: {derived.get('visibleSearchP95DeltaVsOutputMs')}ms")
PY

if [[ -n "$COMPARE_BASELINE" ]]; then
  echo
  echo "=== Performance comparison gate ==="
  node "$ROOT_DIR/test/autotest/compare-performance-baseline.mjs" \
    --suite terminal-architecture-baseline \
    --profile "$COMPARE_PROFILE" \
    --before "$COMPARE_BASELINE" \
    --after "$RESULT_FILE"
fi
