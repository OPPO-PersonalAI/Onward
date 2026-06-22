#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2026 OPPO
# SPDX-License-Identifier: Apache-2.0

set -euo pipefail

REPO_ROOT="${REPO_ROOT:-$(cd "$(dirname "$0")/../.." && pwd)}"
ROOT_DIR="$REPO_ROOT"
source "$ROOT_DIR/test/autotest/resolve-dev-app-bin.sh"

# QUIT_SUITE lets the two split wrappers (-a / -b) write distinct log/result
# files while reusing this single body; GSM_QUIT_TRIALS partitions the 5 stochastic
# quit trials across them (a=3, b=2). Defaults keep this runnable whole (5 trials).
QUIT_SUITE="${QUIT_SUITE:-git-state-mirror-quit}"
APP_BIN="${1:-$(resolve_dev_app_bin "$ROOT_DIR" || true)}"
LOG_FILE="${2:-$REPO_ROOT/traces/test-logs/${QUIT_SUITE}-autotest.log}"
RESULT_FILE="${3:-$REPO_ROOT/traces/analysis/${QUIT_SUITE}-autotest.json}"
APP_NAME="$(detect_dev_product_name "$ROOT_DIR")"
CDP_PORT="${CDP_PORT:-9343}"
GSM_QUIT_TRIALS="${GSM_QUIT_TRIALS:-5}"

USER_DATA_BASE="$(mktemp -d "${TMPDIR:-/tmp}/onward-gsm-quit-userdata.XXXXXX")"
FIXTURE_BASE="$(mktemp -d "${TMPDIR:-/tmp}/onward-gsm-quit-fixture.XXXXXX")"

cleanup() {
  if pgrep -lx "$APP_NAME" >/dev/null 2>&1; then
    pkill -x "$APP_NAME" 2>/dev/null || true
  fi
  rm -rf "$USER_DATA_BASE" 2>/dev/null || true
  rm -rf "$FIXTURE_BASE" 2>/dev/null || true
  find "$REPO_ROOT" -maxdepth 1 -name '__autotest_*' -exec rm -rf {} \; 2>/dev/null || true
}
trap cleanup EXIT INT TERM

mkdir -p "$(dirname "$LOG_FILE")" "$(dirname "$RESULT_FILE")"

if [[ -z "$APP_BIN" || ! -x "$APP_BIN" ]]; then
  echo "ERROR: app binary not found or not executable: ${APP_BIN:-<empty>}" >&2
  echo "Run a development build first: rm -rf out release && pnpm dist:dev" >&2
  exit 1
fi

rm -f "$LOG_FILE" "$RESULT_FILE"

if pgrep -lx "$APP_NAME" >/dev/null 2>&1; then
  pkill -x "$APP_NAME" 2>/dev/null || true
  sleep 0.5
fi

echo "Starting GitStateMirror quit autotest..."
echo "  Suite:          $QUIT_SUITE"
echo "  Trials:         $GSM_QUIT_TRIALS"
echo "  Binary:         $APP_BIN"
echo "  App name:       $APP_NAME"
echo "  User data base: $USER_DATA_BASE"
echo "  Fixture base:   $FIXTURE_BASE"
echo "  CDP base port:  $CDP_PORT"
echo "  Log:            $LOG_FILE"
echo "  Result:         $RESULT_FILE"
echo ""

set +e
APP_BIN="$APP_BIN" \
  APP_NAME="$APP_NAME" \
  REPO_ROOT="$ROOT_DIR" \
  USER_DATA_BASE="$USER_DATA_BASE" \
  FIXTURE_BASE="$FIXTURE_BASE" \
  LOG_FILE="$LOG_FILE" \
  RESULT_FILE="$RESULT_FILE" \
  CDP_PORT="$CDP_PORT" \
  GSM_QUIT_TRIALS="$GSM_QUIT_TRIALS" \
  node "$ROOT_DIR/test/autotest/test-git-state-mirror-quit-cdp.mjs"
TEST_EXIT=$?
set -e

echo ""
echo "=== App log (last 120 lines) ==="
tail -n 120 "$LOG_FILE" 2>/dev/null || true
echo ""

if [[ -f "$RESULT_FILE" ]]; then
  echo "=== Quit result ==="
  cat "$RESULT_FILE"
  echo ""
else
  echo "ERROR: missing result file: $RESULT_FILE" >&2
  exit 1
fi

node -e "
  const fs = require('fs')
  const result = JSON.parse(fs.readFileSync(process.argv[1], 'utf8'))
  if (!result.ok) process.exit(1)
" "$RESULT_FILE"

if [[ "$TEST_EXIT" -ne 0 ]]; then
  echo "GitStateMirror quit autotest failed" >&2
  exit "$TEST_EXIT"
fi

echo "GitStateMirror quit autotest passed"
echo "  Log:    $LOG_FILE"
echo "  Result: $RESULT_FILE"
