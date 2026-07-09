#!/usr/bin/env bash
set -euo pipefail

# SPDX-FileCopyrightText: 2026 OPPO
# SPDX-License-Identifier: Apache-2.0

# Prompt input long-tail latency autotest runner (macOS/Linux)
# For Windows, use run-prompt-input-longtail-autotest.ps1

REPO_ROOT="${REPO_ROOT:-$(cd "$(dirname "$0")/../.." && pwd)}"
ROOT_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
source "$ROOT_DIR/test/autotest/resolve-dev-app-bin.sh"

APP_BIN="${1:-$(resolve_dev_app_bin "$ROOT_DIR")}"
LOG_FILE="${2:-$REPO_ROOT/traces/test-logs/prompt-input-longtail-autotest.log}"
mkdir -p "$(dirname "$LOG_FILE")"
RESULT_DIR="$ROOT_DIR/test/autotest/results/prompt-input-longtail"
mkdir -p "$RESULT_DIR"
RESULT_FILE="${3:-$RESULT_DIR/baseline-$(date +%Y%m%d-%H%M%S).json}"
COMPARE_BASELINE="${4:-${ONWARD_PERF_COMPARE_BASELINE:-}}"
COMPARE_PROFILE="${5:-${ONWARD_PERF_COMPARE_PROFILE:-optimization}}"

if [[ -z "${APP_BIN:-}" || ! -x "$APP_BIN" ]]; then
  echo "App binary not found: ${APP_BIN:-<empty>}" >&2
  echo "Run a development build first: rm -rf out release && pnpm dist:dev" >&2
  exit 1
fi

# Portable Python interpreter: macOS/Linux ship `python3`, Windows ships the `py`
# launcher (Git Bash has no `python3`). Resolve once so the result-parsing steps
# below run on every platform (the bare `python3` here failed full regression on
# Windows with `python3: command not found`).
PYBIN="$(command -v python3 || command -v py || command -v python || true)"
if [[ -z "$PYBIN" ]]; then
  echo "ERROR: no Python interpreter found (need python3 / py / python on PATH)" >&2
  exit 1
fi

echo "Preparing prompt input longtail fixture..."
node "$ROOT_DIR/test/autotest/prepare-prompt-input-longtail-fixture.mjs"

WORK_DIR="$ROOT_DIR/test/autotest/fixtures/prompt-input-longtail/workdir"
USER_DATA_DIR="$ROOT_DIR/test/autotest/fixtures/prompt-input-longtail/user-data"
case "$USER_DATA_DIR" in
  "$ROOT_DIR"/test/autotest/fixtures/prompt-input-longtail/user-data)
    onward_robust_rm "$USER_DATA_DIR"
    mkdir -p "$USER_DATA_DIR"
    ;;
  *)
    echo "Refusing to delete userData outside repo: $USER_DATA_DIR" >&2
    exit 1
    ;;
esac
rm -f "$LOG_FILE"

echo "Starting Prompt Input Longtail autotest..."
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
ONWARD_PERF_TRACE=1 \
ONWARD_AUTOTEST=1 \
ONWARD_AUTOTEST_SUITE=prompt-input-longtail \
ONWARD_AUTOTEST_CWD="$WORK_DIR" \
ONWARD_AUTOTEST_EXIT=1 \
ONWARD_USER_DATA_DIR="$USER_DATA_DIR" \
"$APP_BIN" >"$LOG_FILE" 2>&1 &
APP_PID=$!

MARKER="[PromptInputLongtail:RESULT]"
FOUND_MARKER=0
DEADLINE=$((SECONDS + 360))
while (( SECONDS < DEADLINE )); do
  if [[ -f "$LOG_FILE" ]] && grep -Fq "$MARKER" "$LOG_FILE"; then
    FOUND_MARKER=1
    break
  fi
  if ! kill -0 "$APP_PID" 2>/dev/null; then
    break
  fi
  sleep 2
done

if (( FOUND_MARKER == 1 )); then
  GRACE_DEADLINE=$((SECONDS + 15))
  while (( SECONDS < GRACE_DEADLINE )); do
    if ! kill -0 "$APP_PID" 2>/dev/null; then
      break
    fi
    if [[ -f "$LOG_FILE" ]] && tail -n 80 "$LOG_FILE" | grep -Eq '\[AutoTest\] (PASS|FAIL)|\[AutoTest\] done'; then
      break
    fi
    sleep 0.5
  done
fi

if kill -0 "$APP_PID" 2>/dev/null; then
  CURRENT_NAME=""
  case "$(uname -s)" in
    Darwin)
      CURRENT_NAME="$(ps -p "$APP_PID" -o comm= 2>/dev/null | xargs basename 2>/dev/null || true)"
      ;;
    *)
      CURRENT_NAME="$(ps -p "$APP_PID" -o comm= 2>/dev/null | tr -d '[:space:]' || true)"
      ;;
  esac
  if [[ "$CURRENT_NAME" == "$PROCESS_NAME" || "$CURRENT_NAME" == "$(basename "$PROCESS_NAME" .app)" ]]; then
    kill "$APP_PID" 2>/dev/null || true
  fi
fi
if command -v pkill >/dev/null 2>&1; then
  pkill -x "$PROCESS_NAME" 2>/dev/null || true
fi

echo
echo "=== Test log (last 180 lines) ==="
tail -n 180 "$LOG_FILE" | awk -v marker="$MARKER" '
  {
    marker_index = index($0, marker)
    if (marker_index == 0) {
      print
      next
    }
    prefix_end = marker_index + length(marker) - 1
    prefix_start = prefix_end > 220 ? prefix_end - 219 : 1
    print substr($0, prefix_start, prefix_end - prefix_start + 1) " ... <truncated prompt input longtail JSON>"
  }
' || true
echo

if ! "$PYBIN" - "$LOG_FILE" "$MARKER" "$RESULT_FILE" <<'PY'
import json
import sys

log_file, marker, result_file = sys.argv[1:4]

with open(log_file, 'r', encoding='utf-8', errors='replace') as handle:
    text = handle.read()

marker_index = text.rfind(marker)
if marker_index < 0:
    raise SystemExit(2)

start = text.find('{', marker_index + len(marker))
if start < 0:
    raise SystemExit(2)

depth = 0
in_string = False
escape = False
end = None
for index in range(start, len(text)):
    char = text[index]
    if in_string:
        if escape:
            escape = False
        elif char == '\\':
            escape = True
        elif char == '"':
            in_string = False
        continue

    if char == '"':
        in_string = True
    elif char == '{':
        depth += 1
    elif char == '}':
        depth -= 1
        if depth == 0:
            end = index + 1
            break

if end is None:
    raise SystemExit(2)

payload = json.loads(text[start:end])
with open(result_file, 'w', encoding='utf-8') as handle:
    json.dump(payload, handle, indent=2)
    handle.write('\n')
PY
then
  echo "Missing prompt input longtail result marker." >&2
  grep "\[AutoTest\] FAIL" "$LOG_FILE" >&2 || true
  exit 1
fi

echo "Prompt Input Longtail result captured"
echo "  Log:    $LOG_FILE"
echo "  Result: $RESULT_FILE"
echo
echo "=== Longtail summary ==="
"$PYBIN" - "$RESULT_FILE" <<'PY'
import json
import sys

with open(sys.argv[1], 'r', encoding='utf-8') as handle:
    data = json.load(handle)

for scenario in data.get('scenarios', []):
    prompt = scenario.get('promptInput', {})
    latency = prompt.get('inputLatency', {})
    perf = scenario.get('perf', {})
    print(
        f"  {scenario.get('id')}: "
        f"avg={latency.get('avgMs')}ms "
        f"stddev={latency.get('stddevMs')}ms "
        f"p95={latency.get('p95Ms')}ms "
        f"p99={latency.get('p99Ms')}ms "
        f"p999={latency.get('p999Ms')}ms "
        f"max={latency.get('maxMs')}ms "
        f"over250={prompt.get('over250Ms')} "
        f"over500={prompt.get('over500Ms')} "
        f"fps={perf.get('avgFps')} "
        f"ipc/s={perf.get('avgIpcMsgPerSec')}"
    )

derived = data.get('derived', {})
print(f"  stall windows: {derived.get('stallWindowCount')}")
print(f"  worst outlier: {json.dumps(derived.get('worstOutlier'), separators=(',', ':'))}")
print(f"  worst bucket:  {json.dumps(derived.get('worstBucket'), separators=(',', ':'))}")
print(f"  main loop:     {json.dumps(derived.get('mainEventLoop'), separators=(',', ':'))}")
print(f"  trace:         {data.get('perfTrace', {}).get('logPath')}")
PY

if [[ -n "$COMPARE_BASELINE" ]]; then
  echo
  echo "=== Performance comparison gate ==="
  node "$ROOT_DIR/test/autotest/compare-performance-baseline.mjs" \
    --suite prompt-input-longtail \
    --profile "$COMPARE_PROFILE" \
    --before "$COMPARE_BASELINE" \
    --after "$RESULT_FILE"
fi

if grep -q "\[AutoTest\] FAIL" "$LOG_FILE"; then
  echo "Prompt Input Longtail autotest FAILED" >&2
  grep "\[AutoTest\] FAIL" "$LOG_FILE" >&2 || true
  exit 1
fi

echo "Prompt Input Longtail autotest PASSED"
