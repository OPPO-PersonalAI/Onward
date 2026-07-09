#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2026 OPPO
# SPDX-License-Identifier: Apache-2.0

set -euo pipefail

REPO_ROOT="${REPO_ROOT:-$(cd "$(dirname "$0")/../.." && pwd)}"
ROOT_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
source "$ROOT_DIR/test/autotest/resolve-dev-app-bin.sh"
APP_BIN="${1:-$(resolve_dev_app_bin "$ROOT_DIR" || true)}"
LOG_FILE="${2:-$REPO_ROOT/traces/test-logs/project-editor-html-preview-autotest.log}"
TMP_ROOT=""
SERVER_PID=""

cleanup() {
  if [[ -n "$SERVER_PID" ]]; then
    kill "$SERVER_PID" 2>/dev/null || true
    wait "$SERVER_PID" 2>/dev/null || true
  fi
  find "$ROOT_DIR" -maxdepth 1 -name '__autotest_*' -exec rm -rf {} + 2>/dev/null || true
  if [[ -n "$TMP_ROOT" && "${ONWARD_AUTOTEST_KEEP_TMP:-0}" != "1" ]]; then
    onward_robust_rm "$TMP_ROOT"
  fi
}
trap cleanup EXIT

mkdir -p "$(dirname "$LOG_FILE")"
if [[ -z "$APP_BIN" || ! -x "$APP_BIN" ]]; then
  echo "ERROR: app binary not found or not executable: ${APP_BIN:-<empty>}" >&2
  echo "Run a development build first: rm -rf out release && pnpm dist:dev" >&2
  exit 1
fi

TMP_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/onward-html-preview.XXXXXX")"
mkdir -p "$TMP_ROOT/html-preview"
cp "$ROOT_DIR"/test/autotest/fixtures/html-preview/* "$TMP_ROOT/html-preview/"
READY_JSON="$TMP_ROOT/server-ready.json"
node "$ROOT_DIR/test/autotest/serve-html-preview-fixture.mjs" "$TMP_ROOT/html-preview" "$READY_JSON" &
SERVER_PID="$!"

for _ in {1..50}; do
  if [[ -f "$READY_JSON" ]]; then
    break
  fi
  sleep 0.1
done

if [[ ! -f "$READY_JSON" ]]; then
  echo "ERROR: HTML preview fixture server did not become ready" >&2
  exit 1
fi

rm -f "$LOG_FILE"

echo "Starting Project Editor HTML preview autotest..."
echo "  Binary: $APP_BIN"
echo "  CWD:    $TMP_ROOT"
echo "  Log:    $LOG_FILE"
echo ""

ONWARD_DEBUG=1 \
ONWARD_AUTOTEST=1 \
ONWARD_AUTOTEST_SUITE=project-editor-html-preview \
ONWARD_AUTOTEST_CWD="$TMP_ROOT" \
ONWARD_AUTOTEST_EXIT=1 \
"$APP_BIN" > "$LOG_FILE" 2>&1 || true

echo ""
echo "=== Test log (last 80 lines) ==="
tail -n 80 "$LOG_FILE"
echo ""

if grep -q "\[AutoTest\] FAIL" "$LOG_FILE"; then
  echo "Project Editor HTML preview autotest failed" >&2
  grep "\[AutoTest\] FAIL" "$LOG_FILE" >&2
  exit 1
fi

if grep -Eq "totalFailed: [1-9]" "$LOG_FILE"; then
  echo "Project Editor HTML preview autotest reported failed cases in the summary" >&2
  grep -E "totalFailed: [1-9]" "$LOG_FILE" >&2
  exit 1
fi

if ! grep -q "PHTML-15-save-rerenders-fresh-document-and-restores-scroll" "$LOG_FILE"; then
  echo "Missing PHTML-15 result; the test may not have executed correctly" >&2
  tail -n 40 "$LOG_FILE" >&2
  exit 1
fi

echo "Project Editor HTML preview autotest passed"
echo "  Log: $LOG_FILE"
