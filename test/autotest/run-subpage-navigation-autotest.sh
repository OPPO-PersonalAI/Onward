#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2026 OPPO
# SPDX-License-Identifier: Apache-2.0

set -euo pipefail

REPO_ROOT="${REPO_ROOT:-$(cd "$(dirname "$0")/../.." && pwd)}"
ROOT_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
GROUP="${ONWARD_SUBPAGE_NAVIGATION_GROUP:-core}"
case "$GROUP" in
  core|html|pdf|epub) ;;
  *)
    echo "ERROR: unsupported subpage navigation group: $GROUP" >&2
    exit 2
    ;;
esac
source "$ROOT_DIR/test/autotest/resolve-dev-app-bin.sh"
APP_NAME="$(detect_dev_product_name "$ROOT_DIR")"
if [[ -n "${1:-}" ]]; then
  APP_BIN="$1"
elif ! APP_BIN="$(resolve_dev_app_bin "$ROOT_DIR")"; then
  APP_BIN=""
fi
LOG_FILE="${2:-$REPO_ROOT/traces/test-logs/subpage-navigation-${GROUP}-autotest.log}"
mkdir -p "$(dirname "$LOG_FILE")"
if [[ -z "$APP_BIN" || ! -x "$APP_BIN" ]]; then
  echo "ERROR: app binary not found or not executable: ${APP_BIN:-<empty>}" >&2
  echo "Run a development build first: rm -rf out release && pnpm dist:dev" >&2
  exit 1
fi

rm -f "$LOG_FILE"

# Per the CLAUDE.md "Test fixture isolation" hard rule, every runner
# must point ONWARD_USER_DATA_DIR at a fresh mktemp dir so persisted state
# (active tab/subpage, ProjectEditor scope state, prompt notebook, etc.)
# from a previous run can't leak in. Without isolation the SubpageSwitcher
# autotest ends up restoring `activeSubpage='diff'` from the previous run
# while the autotest auto-open of the Editor races against it — surfacing
# false negatives that aren't actually app regressions.
USER_DATA_DIR=""
FIXTURE_BASE=""
cleanup() {
  if command -v pgrep >/dev/null 2>&1 && pgrep -lx "$APP_NAME" >/dev/null 2>&1; then
    pkill -x "$APP_NAME" 2>/dev/null || true
  fi
  if [[ -n "$USER_DATA_DIR" ]] && ! rm -rf "$USER_DATA_DIR" 2>/dev/null; then
    echo "WARNING: failed to remove user data directory: $USER_DATA_DIR" >&2
  fi
  if [[ -n "$FIXTURE_BASE" ]] && ! rm -rf "$FIXTURE_BASE" 2>/dev/null; then
    echo "WARNING: failed to remove fixture directory: $FIXTURE_BASE" >&2
  fi
}
on_exit() {
  local exit_code=$?
  trap - EXIT INT TERM
  cleanup
  exit "$exit_code"
}
on_interrupt() {
  exit 130
}
on_terminate() {
  exit 143
}
trap on_exit EXIT
trap on_interrupt INT
trap on_terminate TERM

USER_DATA_DIR="$(mktemp -d "${TMPDIR:-/tmp}/onward-subpage-nav.XXXXXX")"
FIXTURE_BASE="$(mktemp -d "${TMPDIR:-/tmp}/onward-subpage-nav-fixtures.XXXXXX")"
USER_DATA_DIR="$(cd "$USER_DATA_DIR" && pwd -P)"
FIXTURE_BASE="$(cd "$FIXTURE_BASE" && pwd -P)"

node "$ROOT_DIR/test/autotest/create-subpage-navigation-fixture.mjs" \
  --output "$FIXTURE_BASE"

if command -v pgrep >/dev/null 2>&1 && pgrep -lx "$APP_NAME" >/dev/null 2>&1; then
  pkill -x "$APP_NAME" 2>/dev/null || true
  sleep 0.5
fi

case "$GROUP" in
  core) EXPECTED_RESULT="SNJ-CODE-HISTORY-WARM" ;;
  html) EXPECTED_RESULT="SNJ-HTML-HISTORY-WARM-5X" ;;
  pdf) EXPECTED_RESULT="SNJ-PDF-HISTORY-WARM-5X" ;;
  epub) EXPECTED_RESULT="SNJ-EPUB-HISTORY-WARM-5X" ;;
esac

echo "Starting subpage navigation autotest..."
echo "  Group:         $GROUP"
echo "  Binary:        $APP_BIN"
echo "  CWD:           $ROOT_DIR"
echo "  User data dir: $USER_DATA_DIR"
echo "  Fixture base:  $FIXTURE_BASE"
echo "  Log:           $LOG_FILE"
echo ""

APP_EXIT_CODE=0
if ONWARD_DEBUG=1 \
  ONWARD_AUTOTEST=1 \
  ONWARD_AUTOTEST_SUITE="subpage-navigation;group=$GROUP" \
  ONWARD_AUTOTEST_CWD="$ROOT_DIR" \
  ONWARD_AUTOTEST_FIXTURE_EXTRA="$FIXTURE_BASE" \
  ONWARD_AUTOTEST_EXIT=1 \
  ONWARD_USER_DATA_DIR="$USER_DATA_DIR" \
  "$APP_BIN" > "$LOG_FILE" 2>&1; then
  APP_EXIT_CODE=0
else
  APP_EXIT_CODE=$?
fi

echo ""
echo "=== Test log (last 100 lines) ==="
tail -n 100 "$LOG_FILE"
echo ""

if [[ "$APP_EXIT_CODE" -ne 0 ]]; then
  echo "Subpage navigation app exited with code $APP_EXIT_CODE" >&2
  exit "$APP_EXIT_CODE"
fi

if ! grep -q "\[AutoTest\] === Autotest Completed ===" "$LOG_FILE"; then
  echo "Subpage navigation autotest did not reach its completion summary" >&2
  tail -n 60 "$LOG_FILE" >&2
  exit 1
fi

if grep -q "\[AutoTest\] FAIL" "$LOG_FILE"; then
  echo "Subpage navigation autotest failed" >&2
  grep "\[AutoTest\] FAIL" "$LOG_FILE" >&2
  exit 1
fi

if grep -Eq "totalFailed: [1-9]" "$LOG_FILE"; then
  echo "Subpage navigation autotest reported failed cases in the summary" >&2
  grep -E "totalFailed: [1-9]" "$LOG_FILE" >&2
  exit 1
fi

if ! grep -q "$EXPECTED_RESULT" "$LOG_FILE"; then
  echo "Missing $EXPECTED_RESULT result; the $GROUP group may not have executed correctly" >&2
  tail -n 60 "$LOG_FILE" >&2
  exit 1
fi

echo "Subpage navigation autotest passed ($GROUP)"
echo "  Log: $LOG_FILE"
