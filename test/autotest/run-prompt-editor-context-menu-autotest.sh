#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2026 OPPO
# SPDX-License-Identifier: Apache-2.0

set -euo pipefail

REPO_ROOT="${REPO_ROOT:-$(cd "$(dirname "$0")/../.." && pwd)}"
ROOT_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
source "$ROOT_DIR/test/autotest/resolve-dev-app-bin.sh"
APP_BIN="${1:-$(resolve_dev_app_bin "$ROOT_DIR" || true)}"
LOG_FILE="${2:-$REPO_ROOT/traces/test-logs/prompt-editor-context-menu-autotest.log}"
mkdir -p "$(dirname "$LOG_FILE")"
RESULTS_DIR="$ROOT_DIR/test/autotest/results"
mkdir -p "$RESULTS_DIR"
USER_DATA_DIR="$(mktemp -d "$RESULTS_DIR/prompt-editor-context-menu-user-data.XXXXXX")"

# Sweep any leftover __autotest_* fixtures in the repo root before starting.
# Defence-in-depth — orchestrator does the same, runner-level trap is the
# authoritative cleanup contract per CLAUDE.md autotest rules.
cleanup_autotest_fixtures() {
  find "$ROOT_DIR" -maxdepth 1 -name '__autotest_*' -exec rm -rf {} + 2>/dev/null || true
  rm -rf "$USER_DATA_DIR" 2>/dev/null || true
}
trap cleanup_autotest_fixtures EXIT

if [[ -z "$APP_BIN" || ! -x "$APP_BIN" ]]; then
  echo "ERROR: app binary not found or not executable: ${APP_BIN:-<empty>}" >&2
  echo "Run a development build first: rm -rf out release && pnpm dist:dev" >&2
  exit 1
fi

rm -f "$LOG_FILE"

echo "Starting prompt editor context-menu autotest..."
echo "  Binary: $APP_BIN"
echo "  CWD:    $ROOT_DIR"
echo "  Log:    $LOG_FILE"
echo ""

ONWARD_DEBUG=1 \
ONWARD_AUTOTEST=1 \
ONWARD_AUTOTEST_SUITE=prompt-editor-context-menu \
ONWARD_AUTOTEST_CWD="$ROOT_DIR" \
ONWARD_AUTOTEST_EXIT=1 \
ONWARD_USER_DATA_DIR="$USER_DATA_DIR" \
"$APP_BIN" > "$LOG_FILE" 2>&1 || true

echo ""
echo "=== Test log (last 160 lines) ==="
tail -n 160 "$LOG_FILE"
echo ""

if grep -q "\[AutoTest\] FAIL" "$LOG_FILE"; then
  echo "Prompt editor context-menu autotest failed" >&2
  echo ""
  echo "=== Failure details ==="
  grep "\[AutoTest\] FAIL" "$LOG_FILE" >&2
  exit 1
fi

# Final sentinel assertion id — if we never see it, the suite did not run
# end-to-end. TPCM-03 is the last record() call in the suite (the terminal
# pinned-prompt menu group runs after all PECM cases); the former PECM-37
# mode-dropdown sentinel was removed with the contenteditable migration.
if ! grep -q "TPCM-03-terminal-pin-menu-does-not-touch-prompt-history" "$LOG_FILE"; then
  echo "Missing TPCM-03 result; the test may not have executed correctly" >&2
  tail -n 80 "$LOG_FILE" >&2
  exit 1
fi

echo "Prompt editor context-menu autotest passed"
echo "  Log: $LOG_FILE"
