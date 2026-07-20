#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2026 OPPO
# SPDX-License-Identifier: Apache-2.0
#
# Infrastructure-watchdog autotest (2026-07-20 incident class): simulated
# threadpool stall -> /api/health flip + degradation banner + recovery, and
# the visibility-watchdog probe transport. The genuine POSIX lost-wakeup
# stall is locked at the unit layer (threadpool-stall-probe.test.mts); this
# runner exercises the platform-neutral downstream wiring.

set -euo pipefail

REPO_ROOT="${REPO_ROOT:-$(cd "$(dirname "$0")/../.." && pwd)}"
ROOT_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
APP_BIN="${1:-}"
LOG_FILE="${2:-$REPO_ROOT/traces/test-logs/infra-watchdog-autotest.log}"
mkdir -p "$(dirname "$LOG_FILE")"

if [[ -z "$APP_BIN" ]]; then
  APP_PATH="$(find "$ROOT_DIR/release" -maxdepth 2 -type d -name '*.app' | sort | head -1)"
  if [[ -z "$APP_PATH" ]]; then
    echo "ERROR: no packaged .app was found. Run: rm -rf out release && pnpm dist:dev" >&2
    exit 1
  fi
  APP_STEM="$(basename "${APP_PATH%.app}")"
  APP_BIN="$APP_PATH/Contents/MacOS/$APP_STEM"
fi

if [[ ! -x "$APP_BIN" ]]; then
  echo "ERROR: app binary not found or not executable: $APP_BIN" >&2
  exit 1
fi

rm -f "$LOG_FILE"

cleanup() {
  # Sweep any legacy __autotest_* fixtures from the repo root (defence-in-depth;
  # this suite creates none itself).
  find "$ROOT_DIR" -maxdepth 1 -name '__autotest_*' -exec rm -rf {} + 2>/dev/null || true
}
trap cleanup EXIT

echo "Starting infra-watchdog autotest..."

ONWARD_DEBUG=1 \
ONWARD_AUTOTEST=1 \
ONWARD_AUTOTEST_SUITE=infra-watchdog \
ONWARD_AUTOTEST_CWD="$ROOT_DIR" \
ONWARD_AUTOTEST_EXIT=1 \
"$APP_BIN" > "$LOG_FILE" 2>&1 || true

if grep -q "\[AutoTest\] FAIL" "$LOG_FILE"; then
  echo "Infra-watchdog autotest FAILED." >&2
  grep "\[AutoTest\]" "$LOG_FILE" >&2
  exit 1
fi

if ! grep -q "infra-watchdog-test:done" "$LOG_FILE"; then
  echo "Infra-watchdog autotest did not complete." >&2
  tail -n 60 "$LOG_FILE" >&2
  exit 1
fi

echo ""
echo "=== AutoTest Results ==="
grep -o '\[AutoTest\] PASS.*\|\[AutoTest\] FAIL.*' "$LOG_FILE" | head -20
echo ""
echo "Infra-watchdog autotest PASSED."
