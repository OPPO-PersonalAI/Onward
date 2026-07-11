#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2026 OPPO
# SPDX-License-Identifier: Apache-2.0
#
# FEOS (file-entry OS actions) regression gate. Verifies the "Open with
# Default Application" / "Reveal in Finder|File Explorer|File Manager"
# context-menu items across all six file-entry surfaces, asserting the
# ONWARD_AUTOTEST-stubbed shell handlers recorded the correct absolute paths
# (no external app is launched) and that a git-deleted row stays disabled.
#
# Output: <repoRoot>/traces/test-logs/file-entry-os-actions-autotest.log

set -euo pipefail

REPO_ROOT="${REPO_ROOT:-$(cd "$(dirname "$0")/../.." && pwd)}"
ROOT_DIR="$REPO_ROOT"
source "$ROOT_DIR/test/autotest/resolve-dev-app-bin.sh"
APP_BIN="${1:-$(resolve_dev_app_bin "$ROOT_DIR" || true)}"
LOG_FILE="${2:-$REPO_ROOT/traces/test-logs/file-entry-os-actions-autotest.log}"
mkdir -p "$(dirname "$LOG_FILE")"
SUITE_NAME="file-entry-os-actions"
WATCHDOG_SEC="${FEOS_WATCHDOG_SEC:-240}"

if [[ -z "$APP_BIN" || ! -x "$APP_BIN" ]]; then
  echo "ERROR: app binary not found or not executable: ${APP_BIN:-<empty>}" >&2
  echo "Run a development build first: rm -rf out release && pnpm dist:dev" >&2
  exit 1
fi

USER_DATA_DIR="$(mktemp -d "${TMPDIR:-/tmp}/onward-feos-userdata.XXXXXX")"
FIXTURE_ROOT=""

cleanup() {
  # Defensive sweep of any leftover __autotest_* debris at repo root
  # (per CLAUDE.md autotest cleanup hard rule).
  find "$REPO_ROOT" -maxdepth 1 -name "__autotest_*" -exec rm -rf {} + 2>/dev/null || true
  rm -rf "$USER_DATA_DIR" 2>/dev/null || true
  if [[ -n "$FIXTURE_ROOT" ]]; then
    rm -rf "$FIXTURE_ROOT" 2>/dev/null || true
  fi
}
trap cleanup EXIT INT TERM

rm -f "$LOG_FILE"

FIXTURE_JSON="$(node "$REPO_ROOT/test/autotest/create-file-entry-os-actions-fixture.mjs")"
FIXTURE_ROOT="$(node -e 'const data = JSON.parse(process.argv[1]); process.stdout.write(data.root)' "$FIXTURE_JSON")"
if [[ -z "$FIXTURE_ROOT" || ! -d "$FIXTURE_ROOT/.git" ]]; then
  echo "ERROR: failed to create FEOS fixture" >&2
  echo "Fixture JSON: $FIXTURE_JSON" >&2
  exit 1
fi

echo "Starting file-entry OS actions autotest..."
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
  echo "FEOS autotest exceeded ${WATCHDOG_SEC}s watchdog" >&2
  exit 124
fi

if [[ "$APP_EXIT" -ne 0 ]]; then
  echo "FEOS autotest app exited with code $APP_EXIT" >&2
  exit "$APP_EXIT"
fi

if ! grep -q "\[AutoTest\] === Autotest Completed ===" "$LOG_FILE"; then
  echo "FEOS autotest did not reach the completion marker" >&2
  exit 1
fi

if ! grep -q "FEOS-12-toctou-failure-toast-visible" "$LOG_FILE"; then
  echo "FEOS autotest missing the final FEOS-12 assertion (suite truncated?)" >&2
  exit 1
fi

if grep -q "\[AutoTest\] FAIL" "$LOG_FILE" \
  || grep -Eq "totalFailed: [1-9][0-9]*" "$LOG_FILE"; then
  echo "FEOS autotest reported FAIL" >&2
  echo ""
  echo "=== Failure details ==="
  grep "\[AutoTest\] FAIL\|totalFailed: [1-9]" "$LOG_FILE" >&2 || true
  exit 1
fi

echo "FEOS autotest PASS"
