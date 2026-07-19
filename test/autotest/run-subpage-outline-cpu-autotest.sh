#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2026 OPPO
# SPDX-License-Identifier: Apache-2.0
#
# Subpage outline CPU gate (SOC-*): huge-HTML outline cap + windowed outline
# DOM + renderer CPU decay within 5s of exiting editor / git diff subpages.

set -euo pipefail

REPO_ROOT="${REPO_ROOT:-$(cd "$(dirname "$0")/../.." && pwd)}"
ROOT_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
source "$ROOT_DIR/test/autotest/resolve-dev-app-bin.sh"

APP_BIN="${1:-$(resolve_dev_app_bin "$ROOT_DIR" || true)}"
LOG_FILE="${2:-$REPO_ROOT/traces/test-logs/subpage-outline-cpu-autotest.log}"
RESULT_FILE="${3:-$REPO_ROOT/traces/analysis/subpage-outline-cpu-autotest.json}"
APP_NAME="$(detect_dev_product_name "$ROOT_DIR")"
CDP_PORT="${CDP_PORT:-9343}"

USER_DATA_DIR="$(mktemp -d "${TMPDIR:-/tmp}/onward-subpage-outline-cpu-userdata-XXXXXX")"
FIXTURE_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/onward-subpage-outline-cpu-XXXXXX")"
APP_PID=""

mkdir -p "$(dirname "$LOG_FILE")" "$(dirname "$RESULT_FILE")"

if [[ -z "$APP_BIN" || ! -x "$APP_BIN" ]]; then
  echo "ERROR: app binary not found or not executable: ${APP_BIN:-<empty>}" >&2
  echo "Run a development build first: rm -rf out release && pnpm dist:dev" >&2
  exit 1
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
  rm -rf "$FIXTURE_ROOT" "$USER_DATA_DIR" 2>/dev/null || true
  # Defence-in-depth: sweep stray autotest sentinels from the repo root.
  find "$ROOT_DIR" -maxdepth 1 -name '__autotest_*' -exec rm -rf {} + 2>/dev/null || true
}
trap cleanup EXIT

rm -f "$LOG_FILE" "$RESULT_FILE"

node "$ROOT_DIR/test/autotest/create-subpage-outline-cpu-fixture.mjs" "$FIXTURE_ROOT/repo"

echo "Starting subpage outline CPU autotest..."
echo "  Binary:      $APP_BIN"
echo "  App name:    $APP_NAME"
echo "  Fixture:     $FIXTURE_ROOT/repo"
echo "  User data:   $USER_DATA_DIR"
echo "  CDP port:    $CDP_PORT"
echo "  Log:         $LOG_FILE"
echo "  Result:      $RESULT_FILE"

pkill -x "$APP_NAME" 2>/dev/null || true
sleep 0.5

ONWARD_REPO_ROOT="$ROOT_DIR" \
ONWARD_PERF_TRACE="${ONWARD_PERF_TRACE:-0}" \
ONWARD_USER_DATA_DIR="$USER_DATA_DIR" \
ONWARD_AUTOTEST=1 \
ONWARD_AUTOTEST_SUITE=subpage-outline-cpu-cdp \
ONWARD_AUTOTEST_CWD="$FIXTURE_ROOT/repo" \
ONWARD_AUTOTEST_SKIP_CONSENT=1 \
"$APP_BIN" --remote-debugging-port="$CDP_PORT" > "$LOG_FILE" 2>&1 &
APP_PID=$!

set +e
APP_NAME="$APP_NAME" \
APP_MAIN_PID="$APP_PID" \
CDP_PORT="$CDP_PORT" \
RESULT_PATH="$RESULT_FILE" \
node "$ROOT_DIR/test/autotest/test-subpage-outline-cpu-cdp.mjs" 2>&1 | tee -a "$LOG_FILE"
TEST_EXIT=${PIPESTATUS[0]}
set -e

if [[ -f "$RESULT_FILE" ]]; then
  echo "=== Result JSON ==="
  cat "$RESULT_FILE"
fi

if [[ "$TEST_EXIT" -ne 0 ]]; then
  echo "Subpage outline CPU autotest FAILED" >&2
  exit "$TEST_EXIT"
fi

echo "Subpage outline CPU autotest passed"
