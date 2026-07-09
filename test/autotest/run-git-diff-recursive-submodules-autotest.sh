#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2026 OPPO
# SPDX-License-Identifier: Apache-2.0

set -euo pipefail

REPO_ROOT="${REPO_ROOT:-$(cd "$(dirname "$0")/../.." && pwd)}"
ROOT_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
source "$ROOT_DIR/test/autotest/resolve-dev-app-bin.sh"
APP_BIN="${1:-$(resolve_dev_app_bin "$ROOT_DIR" || true)}"
LOG_FILE="${2:-$REPO_ROOT/traces/test-logs/git-diff-recursive-submodules-autotest.log}"
mkdir -p "$(dirname "$LOG_FILE")"
if [[ -z "$APP_BIN" || ! -x "$APP_BIN" ]]; then
  echo "ERROR: app binary not found or not executable: ${APP_BIN:-<empty>}" >&2
  echo "Run a development build first: rm -rf out release && pnpm dist:dev" >&2
  exit 1
fi

FIXTURE_JSON="$(node "$ROOT_DIR/test/autotest/create-recursive-git-submodule-fixture.mjs")"
FIXTURE_ROOT="$(printf '%s' "$FIXTURE_JSON" | node -e 'let data="";process.stdin.on("data",c=>data+=c).on("end",()=>process.stdout.write(JSON.parse(data).repoRoot))')"
FIXTURE_TEMP_ROOT="$(printf '%s' "$FIXTURE_JSON" | node -e 'let data="";process.stdin.on("data",c=>data+=c).on("end",()=>process.stdout.write(JSON.parse(data).tempRoot))')"
trap 'onward_robust_rm "$FIXTURE_TEMP_ROOT"' EXIT

rm -f "$LOG_FILE"

echo "Starting Git Diff recursive-submodule autotest..."
echo "  Binary:      $APP_BIN"
echo "  Target repo: $FIXTURE_ROOT"
echo "  Log:         $LOG_FILE"
echo ""

ONWARD_DEBUG=1 \
ONWARD_AUTOTEST=1 \
ONWARD_AUTOTEST_SUITE=git-diff-recursive-submodules \
ONWARD_AUTOTEST_CWD="$FIXTURE_ROOT" \
ONWARD_AUTOTEST_EXIT=1 \
"$APP_BIN" > "$LOG_FILE" 2>&1 || true

echo ""
echo "=== Test log (last 80 lines) ==="
tail -n 80 "$LOG_FILE"
echo ""

if grep -q "\[AutoTest\] FAIL" "$LOG_FILE"; then
  echo "Git Diff recursive-submodule autotest failed" >&2
  echo ""
  echo "=== Failure details ==="
  grep "\[AutoTest\] FAIL" "$LOG_FILE" >&2
  exit 1
fi

if ! grep -q "RSM-01-root-only-discovers-nested-submodules" "$LOG_FILE"; then
  echo "Missing RSM-01 result; the test may not have executed correctly" >&2
  tail -n 40 "$LOG_FILE" >&2
  exit 1
fi

echo "Git Diff recursive-submodule autotest passed"
echo "  Log: $LOG_FILE"
