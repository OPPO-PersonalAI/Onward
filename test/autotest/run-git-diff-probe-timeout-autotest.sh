#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2026 OPPO
# SPDX-License-Identifier: Apache-2.0
#
# G5 (2026-07-24 review): RC-2 "Git timed out" UI state + retry-escapes-
# backoff E2E. The timeout classification is seeded via the autotest-gated
# `debug:autotest-poison-repo-probe` hook — a real hanging volume has no
# deterministic fixture (test/README.md § 3 timeout-triage).

set -euo pipefail

REPO_ROOT="${REPO_ROOT:-$(cd "$(dirname "$0")/../.." && pwd)}"
ROOT_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
source "$ROOT_DIR/test/autotest/resolve-dev-app-bin.sh"
APP_BIN="${1:-$(resolve_dev_app_bin "$ROOT_DIR" || true)}"
LOG_FILE="${2:-$REPO_ROOT/traces/test-logs/git-diff-probe-timeout-autotest.log}"
mkdir -p "$(dirname "$LOG_FILE")"
if [[ -z "$APP_BIN" || ! -x "$APP_BIN" ]]; then
  echo "ERROR: app binary not found or not executable: ${APP_BIN:-<empty>}" >&2
  echo "Run a development build first: rm -rf out release && pnpm dist:dev" >&2
  exit 1
fi

rm -f "$LOG_FILE"
USER_DATA_DIR="$(mktemp -d "${TMPDIR:-/tmp}/onward-probe-timeout-user-data.XXXXXX")"

cleanup() {
  rm -rf "$USER_DATA_DIR" 2>/dev/null || true
  find "$ROOT_DIR" -maxdepth 1 -name '__autotest_*' -exec rm -rf {} + 2>/dev/null || true
}
trap cleanup EXIT INT TERM

APP_ENV=(
  ONWARD_DEBUG=1
  ONWARD_AUTOTEST=1
  ONWARD_AUTOTEST_SUITE=git-diff-probe-timeout
  ONWARD_AUTOTEST_CWD="$ROOT_DIR"
  ONWARD_AUTOTEST_EXIT=1
  ONWARD_USER_DATA_DIR="$USER_DATA_DIR"
  NO_COLOR=1
  FORCE_COLOR=0
  CLICOLOR=0
  COLORTERM=
)

echo "Starting git-diff probe-timeout autotest..."

env "${APP_ENV[@]}" "$APP_BIN" > "$LOG_FILE" 2>&1 || true

if grep -q "\[AutoTest\] FAIL" "$LOG_FILE"; then
  echo "Git-diff probe-timeout autotest FAILED. Log: $LOG_FILE" >&2
  tail -n 120 "$LOG_FILE" >&2
  exit 1
fi

if ! grep -q "GPT-04-retry-escapes-backoff" "$LOG_FILE"; then
  echo "Git-diff probe-timeout autotest did not complete. Log: $LOG_FILE" >&2
  tail -n 120 "$LOG_FILE" >&2
  exit 1
fi

echo "Git-diff probe-timeout autotest passed. Log: $LOG_FILE"
