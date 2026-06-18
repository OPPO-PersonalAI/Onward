#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2026 OPPO
# SPDX-License-Identifier: Apache-2.0
#
# Open Browser (address-bar in-app browser) autotest:
#   - local HTML file open + sibling file:// subresources (any-file policy)
#   - plain reload, address-bar resolver scheme rules (file:// / localhost http / domain https)
#   - zoom in/reset/out + renderer sync
#   - Esc keep-alive (cache) vs ✕ destroy
#   - auto-refresh tick + scroll restore, popover toggle + interval clamp
#
# The localhost/local-IP scheme rule is asserted in-process via the pure resolver (OB-05) and
# the browser-url unit test; we do not stand up a live HTTP server here (the view's network
# loading is already exercised by the pre-existing https path).

set -euo pipefail

REPO_ROOT="${REPO_ROOT:-$(cd "$(dirname "$0")/../.." && pwd)}"
ROOT_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
source "$ROOT_DIR/test/autotest/resolve-dev-app-bin.sh"
APP_BIN="${1:-$(resolve_dev_app_bin "$ROOT_DIR" || true)}"
LOG_FILE="${2:-$REPO_ROOT/traces/test-logs/open-browser-autotest.log}"
TMP_ROOT=""

cleanup() {
  find "$ROOT_DIR" -maxdepth 1 -name '__autotest_*' -exec rm -rf {} + 2>/dev/null || true
  if [[ -n "$TMP_ROOT" && "${ONWARD_AUTOTEST_KEEP_TMP:-0}" != "1" ]]; then
    rm -rf "$TMP_ROOT"
  fi
}
trap cleanup EXIT

mkdir -p "$(dirname "$LOG_FILE")"
if [[ -z "$APP_BIN" || ! -x "$APP_BIN" ]]; then
  echo "ERROR: app binary not found or not executable: ${APP_BIN:-<empty>}" >&2
  echo "Run a development build first: rm -rf out release && pnpm dist:dev" >&2
  exit 1
fi

TMP_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/onward-open-browser.XXXXXX")"
cp "$ROOT_DIR"/test/autotest/fixtures/open-browser/* "$TMP_ROOT/"

rm -f "$LOG_FILE"

echo "Starting Open Browser autotest..."
echo "  Binary: $APP_BIN"
echo "  CWD:    $TMP_ROOT"
echo "  Log:    $LOG_FILE"
echo ""

ONWARD_DEBUG=1 \
ONWARD_AUTOTEST=1 \
ONWARD_AUTOTEST_SUITE=open-browser \
ONWARD_AUTOTEST_CWD="$TMP_ROOT" \
ONWARD_AUTOTEST_EXIT=1 \
"$APP_BIN" > "$LOG_FILE" 2>&1 || true

echo ""
echo "=== Test log (last 80 lines) ==="
tail -n 80 "$LOG_FILE"
echo ""

if grep -q "\[AutoTest\] FAIL" "$LOG_FILE"; then
  echo "Open Browser autotest failed" >&2
  grep "\[AutoTest\] FAIL" "$LOG_FILE" >&2
  exit 1
fi

if grep -Eq "totalFailed: [1-9]" "$LOG_FILE"; then
  echo "Open Browser autotest reported failed cases in the summary" >&2
  grep -E "totalFailed: [1-9]" "$LOG_FILE" >&2
  exit 1
fi

if ! grep -q "OB-01-local-file-opens-and-renders" "$LOG_FILE"; then
  echo "Missing OB-01 result; the test may not have executed correctly" >&2
  tail -n 40 "$LOG_FILE" >&2
  exit 1
fi

echo "Open Browser autotest passed"
echo "  Log: $LOG_FILE"
