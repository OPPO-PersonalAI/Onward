#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2026 OPPO
# SPDX-License-Identifier: Apache-2.0

set -euo pipefail

REPO_ROOT="${REPO_ROOT:-$(cd "$(dirname "$0")/../.." && pwd)}"
ROOT_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
source "$ROOT_DIR/test/autotest/resolve-dev-app-bin.sh"
APP_BIN="${1:-$(resolve_dev_app_bin "$ROOT_DIR" || true)}"
LOG_FILE="${2:-$REPO_ROOT/traces/test-logs/git-history-ref-decoration-autotest.log}"
mkdir -p "$(dirname "$LOG_FILE")"
TARGET_REPO="${3:-${ONWARD_AUTOTEST_TARGET_CWD:-$ROOT_DIR}}"
USER_DATA_DIR="$(mktemp -d "${TMPDIR:-/tmp}/onward-refdec-userdata.XXXXXX")"
RESULTS_DIR="$REPO_ROOT/test/autotest/results"
mkdir -p "$RESULTS_DIR"
FIXTURE_BASE="$(mktemp -d "$RESULTS_DIR/git-history-ref-decoration-fixtures.XXXXXX")"

cleanup() {
  rm -rf "$USER_DATA_DIR" 2>/dev/null || true
  rm -rf "$FIXTURE_BASE" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

if [[ -z "$APP_BIN" || ! -x "$APP_BIN" ]]; then
  echo "ERROR: app binary not found or not executable: ${APP_BIN:-<empty>}" >&2
  echo "Run a development build first: rm -rf out release && pnpm dist:dev" >&2
  exit 1
fi

rm -f "$LOG_FILE"

ONWARD_DEBUG=1 \
ONWARD_USER_DATA_DIR="$USER_DATA_DIR" \
ONWARD_AUTOTEST=1 \
ONWARD_AUTOTEST_SUITE=git-history-ref-decoration \
ONWARD_AUTOTEST_CWD="$TARGET_REPO" \
ONWARD_AUTOTEST_FIXTURE_EXTRA="$FIXTURE_BASE" \
ONWARD_AUTOTEST_EXIT=1 \
"$APP_BIN" > "$LOG_FILE" 2>&1 || true

if grep -q "\[AutoTest\] FAIL" "$LOG_FILE"; then
  echo "Git History ref-decoration autotest failed. Log: $LOG_FILE" >&2
  tail -n 200 "$LOG_FILE" >&2
  exit 1
fi

# Sentinel: the suite must have run through the unconditional tag steps (RD-07 is
# the last unconditional assertion before the optional worktree capstone).
if ! grep -q "RD-07-tag-delete-clears" "$LOG_FILE"; then
  echo "Missing RD-07-tag-delete-clears result (suite did not run to completion). Log: $LOG_FILE" >&2
  tail -n 200 "$LOG_FILE" >&2
  exit 1
fi

echo "Git History ref-decoration autotest passed. Log: $LOG_FILE"
