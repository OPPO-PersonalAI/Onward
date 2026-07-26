#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2026 OPPO
# SPDX-License-Identifier: Apache-2.0
#
# G3/G4 (2026-07-24 review): shell-integration liveness → silent hint →
# verified-cd recovery E2E, plus the 6-terminal false-silent storm. Launches
# the app with integration DISABLED and a 1.5 s liveness window so the
# silent verdict fires deterministically (see docs/debug-env-variables.md,
# ONWARD_LIVENESS_WINDOW_MS).

set -euo pipefail

REPO_ROOT="${REPO_ROOT:-$(cd "$(dirname "$0")/../.." && pwd)}"
ROOT_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
source "$ROOT_DIR/test/autotest/resolve-dev-app-bin.sh"
APP_BIN="${1:-$(resolve_dev_app_bin "$ROOT_DIR" || true)}"
LOG_FILE="${2:-$REPO_ROOT/traces/test-logs/terminal-liveness-hint-autotest.log}"
mkdir -p "$(dirname "$LOG_FILE")"
if [[ -z "$APP_BIN" || ! -x "$APP_BIN" ]]; then
  echo "ERROR: app binary not found or not executable: ${APP_BIN:-<empty>}" >&2
  echo "Run a development build first: rm -rf out release && pnpm dist:dev" >&2
  exit 1
fi

rm -f "$LOG_FILE"
USER_DATA_DIR="$(mktemp -d "${TMPDIR:-/tmp}/onward-terminal-liveness-user-data.XXXXXX")"

cleanup() {
  rm -rf "$USER_DATA_DIR" 2>/dev/null || true
  find "$ROOT_DIR" -maxdepth 1 -name '__autotest_*' -exec rm -rf {} + 2>/dev/null || true
}
trap cleanup EXIT INT TERM

APP_ENV=(
  ONWARD_DEBUG=1
  ONWARD_AUTOTEST=1
  ONWARD_AUTOTEST_SUITE=terminal-liveness-hint
  ONWARD_AUTOTEST_CWD="$ROOT_DIR"
  ONWARD_AUTOTEST_EXIT=1
  ONWARD_USER_DATA_DIR="$USER_DATA_DIR"
  ONWARD_SHELL_INTEGRATION=0
  ONWARD_LIVENESS_WINDOW_MS=1500
  NO_COLOR=1
  FORCE_COLOR=0
  CLICOLOR=0
  COLORTERM=
)

echo "Starting terminal liveness-hint autotest..."

env "${APP_ENV[@]}" "$APP_BIN" > "$LOG_FILE" 2>&1 || true

if grep -q "\[AutoTest\] FAIL" "$LOG_FILE"; then
  echo "Terminal liveness-hint autotest FAILED. Log: $LOG_FILE" >&2
  tail -n 120 "$LOG_FILE" >&2
  exit 1
fi

# LVH-03 is emitted on both the full path and the documented environmental
# skip (a shell profile that emits its own cwd OSC), so it is the honest
# completion floor.
if ! grep -q "LVH-03-six-silent-hints" "$LOG_FILE"; then
  echo "Terminal liveness-hint autotest did not complete. Log: $LOG_FILE" >&2
  tail -n 120 "$LOG_FILE" >&2
  exit 1
fi

echo "Terminal liveness-hint autotest passed. Log: $LOG_FILE"
