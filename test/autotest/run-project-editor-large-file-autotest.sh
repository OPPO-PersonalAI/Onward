#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2026 OPPO
# SPDX-License-Identifier: Apache-2.0

set -euo pipefail

REPO_ROOT="${REPO_ROOT:-$(cd "$(dirname "$0")/../.." && pwd)}"
ROOT_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
source "$ROOT_DIR/test/autotest/resolve-dev-app-bin.sh"
APP_BIN="${1:-$(resolve_dev_app_bin "$ROOT_DIR" || true)}"
LOG_FILE="${2:-$REPO_ROOT/traces/test-logs/project-editor-large-file-autotest.log}"
SCRATCH_DIR="$ROOT_DIR/test/autotest/results/project-editor-large-file"
LARGE_GIF_FIXTURE="$SCRATCH_DIR/large-preview.gif"

cleanup() {
  onward_robust_rm "$SCRATCH_DIR"
  find "$ROOT_DIR" -maxdepth 1 -name '__autotest_*' -exec rm -rf {} +
}
trap cleanup EXIT

mkdir -p "$(dirname "$LOG_FILE")"
if [[ -z "$APP_BIN" || ! -x "$APP_BIN" ]]; then
  echo "ERROR: app binary not found or not executable: ${APP_BIN:-<empty>}" >&2
  echo "Run a development build first: rm -rf out release && pnpm dist:dev" >&2
  exit 1
fi

rm -f "$LOG_FILE"
node "$ROOT_DIR/test/autotest/create-large-gif-fixture.mjs" "$LARGE_GIF_FIXTURE" $((12 * 1024 * 1024)) >/dev/null

ONWARD_DEBUG=1 \
ONWARD_AUTOTEST=1 \
ONWARD_AUTOTEST_SUITE=project-editor-large-file \
ONWARD_AUTOTEST_CWD="$ROOT_DIR" \
ONWARD_AUTOTEST_EXIT=1 \
ONWARD_AUTOTEST_REAL_FILE_CHOICE=1 \
"$APP_BIN" > "$LOG_FILE" 2>&1 || true

if grep -Eq "\[AutoTest\] FAIL|totalFailed: [1-9][0-9]*|FAIL AT-RT-no-runtime-errors" "$LOG_FILE"; then
  echo "ProjectEditor large-file autotest failed. Log: $LOG_FILE" >&2
  tail -n 200 "$LOG_FILE" >&2
  exit 1
fi

if ! grep -q "PLF-20-large-gif-preview-uses-file-url" "$LOG_FILE"; then
  echo "Missing PLF-20-large-gif-preview-uses-file-url result. Log: $LOG_FILE" >&2
  tail -n 200 "$LOG_FILE" >&2
  exit 1
fi

echo "ProjectEditor large-file autotest passed. Log: $LOG_FILE"
