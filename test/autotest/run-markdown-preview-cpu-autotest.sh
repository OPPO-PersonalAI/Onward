#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2026 OPPO
# SPDX-License-Identifier: Apache-2.0

set -euo pipefail

REPO_ROOT="${REPO_ROOT:-$(cd "$(dirname "$0")/../.." && pwd)}"
ROOT_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
source "$ROOT_DIR/test/autotest/resolve-dev-app-bin.sh"

# MPC_SUITE lets the phase-split wrappers (idle / scroll / editor) write distinct
# log/result files reusing this single body; MPC_ONLY_PHASE (read by the driver)
# selects which CPU phase runs. Defaults keep this runnable whole (all phases).
MPC_SUITE="${MPC_SUITE:-markdown-preview-cpu}"
MPC_ONLY_PHASE="${MPC_ONLY_PHASE:-}"
APP_BIN="${1:-$(resolve_dev_app_bin "$ROOT_DIR" || true)}"
LOG_FILE="${2:-$REPO_ROOT/traces/test-logs/${MPC_SUITE}-autotest.log}"
RESULT_FILE="${3:-$REPO_ROOT/traces/analysis/${MPC_SUITE}-autotest.json}"
APP_NAME="$(detect_dev_product_name "$ROOT_DIR")"
CDP_PORT="${CDP_PORT:-9339}"
TARGET_RELATIVE_PATH="${TARGET_RELATIVE_PATH:-heavy-preview.md}"

USER_DATA_DIR="$(mktemp -d "${TMPDIR:-/tmp}/onward-md-preview-cpu-userdata-XXXXXX")"
FIXTURE_ROOT_WAS_CREATED=0
if [[ $# -ge 4 && -n "${4:-}" ]]; then
  FIXTURE_ROOT="$4"
else
  FIXTURE_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/onward-md-preview-cpu-XXXXXX")"
  FIXTURE_ROOT_WAS_CREATED=1
fi
APP_PID=""

mkdir -p "$(dirname "$LOG_FILE")" "$(dirname "$RESULT_FILE")"

if [[ -z "$APP_BIN" || ! -x "$APP_BIN" ]]; then
  echo "ERROR: app binary not found or not executable: ${APP_BIN:-<empty>}" >&2
  echo "Run a development build first: rm -rf out release && pnpm dist:dev" >&2
  exit 1
fi

if [[ ! -d "$FIXTURE_ROOT" ]]; then
  if [[ $# -ge 4 ]]; then
    echo "ERROR: fixture root not found: $FIXTURE_ROOT" >&2
    exit 1
  fi
  mkdir -p "$FIXTURE_ROOT"
fi

cleanup() {
  if [[ -n "$APP_PID" ]] && kill -0 "$APP_PID" 2>/dev/null; then
    kill "$APP_PID" 2>/dev/null || true
    sleep 0.5
    if kill -0 "$APP_PID" 2>/dev/null; then
      kill -KILL "$APP_PID" 2>/dev/null || true
    fi
    wait "$APP_PID" 2>/dev/null || true
  fi
  if [[ "$FIXTURE_ROOT_WAS_CREATED" -eq 1 && -d "$FIXTURE_ROOT" ]]; then
    rm -rf "$FIXTURE_ROOT" 2>/dev/null || true
  fi
  if [[ -d "$USER_DATA_DIR" ]]; then
    rm -rf "$USER_DATA_DIR" 2>/dev/null || true
  fi
}
trap cleanup EXIT

rm -f "$LOG_FILE" "$RESULT_FILE"
cp -R "$ROOT_DIR/test/autotest/fixtures/markdown-preview-cpu/." "$FIXTURE_ROOT/"

echo "Starting Markdown preview CPU autotest..."
echo "  Binary:       $APP_BIN"
echo "  App name:     $APP_NAME"
echo "  Fixture CWD:  $FIXTURE_ROOT"
echo "  User data:    $USER_DATA_DIR"
echo "  CDP port:     $CDP_PORT"
echo "  Target:       $TARGET_RELATIVE_PATH"
echo "  Log:          $LOG_FILE"
echo "  Result:       $RESULT_FILE"
echo ""

pkill -x "$APP_NAME" 2>/dev/null || true
if [[ "$(uname -s)" == "Darwin" ]]; then
  osascript -e "tell application \"$APP_NAME\" to quit" >/dev/null 2>&1 || true
fi
sleep 0.5

ONWARD_REPO_ROOT="$ROOT_DIR" \
ONWARD_PERF_TRACE="${ONWARD_PERF_TRACE:-0}" \
ONWARD_USER_DATA_DIR="$USER_DATA_DIR" \
ONWARD_AUTOTEST=1 \
ONWARD_AUTOTEST_SUITE=markdown-preview-cpu-cdp \
ONWARD_AUTOTEST_CWD="$FIXTURE_ROOT" \
ONWARD_AUTOTEST_SKIP_CONSENT=1 \
"$APP_BIN" --remote-debugging-port="$CDP_PORT" > "$LOG_FILE" 2>&1 &
APP_PID=$!

set +e
APP_NAME="$APP_NAME" \
APP_MAIN_PID="$APP_PID" \
CDP_PORT="$CDP_PORT" \
TARGET_RELATIVE_PATH="$TARGET_RELATIVE_PATH" \
RESULT_PATH="$RESULT_FILE" \
MPC_ONLY_PHASE="$MPC_ONLY_PHASE" \
node "$ROOT_DIR/test/autotest/test-markdown-preview-cpu-cdp.mjs"
TEST_EXIT=$?
set -e

echo ""
echo "=== App log (last 120 lines) ==="
tail -n 120 "$LOG_FILE" 2>/dev/null || true
echo ""

if [[ -f "$RESULT_FILE" ]]; then
  echo "=== CPU result ==="
  cat "$RESULT_FILE"
  echo ""
else
  echo "ERROR: missing result file: $RESULT_FILE" >&2
  exit 1
fi

if [[ "$TEST_EXIT" -ne 0 ]]; then
  echo "Markdown preview CPU autotest failed" >&2
  exit "$TEST_EXIT"
fi

echo "Markdown preview CPU autotest passed"
echo "  Log:    $LOG_FILE"
echo "  Result: $RESULT_FILE"
