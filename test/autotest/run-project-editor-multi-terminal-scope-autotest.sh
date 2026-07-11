#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2026 OPPO
# SPDX-License-Identifier: Apache-2.0

set -euo pipefail

REPO_ROOT="${REPO_ROOT:-$(cd "$(dirname "$0")/../.." && pwd)}"
ROOT_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
source "$ROOT_DIR/test/autotest/resolve-dev-app-bin.sh"
APP_BIN="${1:-$(resolve_dev_app_bin "$ROOT_DIR" || true)}"
LOG_FILE="${2:-$REPO_ROOT/traces/test-logs/project-editor-multi-terminal-scope-autotest.log}"
mkdir -p "$(dirname "$LOG_FILE")"
if [[ -z "$APP_BIN" || ! -x "$APP_BIN" ]]; then
  echo "ERROR: app binary not found or not executable: ${APP_BIN:-<empty>}" >&2
  echo "Run a development build first: rm -rf out release && pnpm dist:dev" >&2
  exit 1
fi

rm -f "$LOG_FILE"

ONWARD_DEBUG=1 \
ONWARD_AUTOTEST=1 \
ONWARD_AUTOTEST_SUITE=project-editor-multi-terminal-scope \
ONWARD_AUTOTEST_CWD="$ROOT_DIR" \
ONWARD_AUTOTEST_EXIT=1 \
"$APP_BIN" > "$LOG_FILE" 2>&1 || true

if grep -q "\[AutoTest\] FAIL" "$LOG_FILE"; then
  echo "ProjectEditor same-directory multi-terminal isolation test failed. Log: $LOG_FILE" >&2
  tail -n 160 "$LOG_FILE" >&2
  exit 1
fi

if ! grep -q "PEMS-30-cwd-drift-no-subdir-key" "$LOG_FILE"; then
  echo "Missing PEMS-30-cwd-drift-no-subdir-key result. Log: $LOG_FILE" >&2
  tail -n 160 "$LOG_FILE" >&2
  exit 1
fi

echo "ProjectEditor same-directory multi-terminal isolation test passed. Log: $LOG_FILE"
