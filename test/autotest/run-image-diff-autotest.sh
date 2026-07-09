#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2026 OPPO
# SPDX-License-Identifier: Apache-2.0

set -euo pipefail

REPO_ROOT="${REPO_ROOT:-$(cd "$(dirname "$0")/../.." && pwd)}"
ROOT_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
source "$ROOT_DIR/test/autotest/resolve-dev-app-bin.sh"
APP_BIN="${1:-$(resolve_dev_app_bin "$ROOT_DIR" || true)}"
LOG_FILE="${2:-$REPO_ROOT/traces/test-logs/image-diff-autotest.log}"
mkdir -p "$(dirname "$LOG_FILE")"

# The TS autotest writes fixtures (__autotest_image_diff_test.{png,svg},
# __autotest_history_repo/) into ONWARD_AUTOTEST_CWD which is the repo root.
# When the app crashes mid-run those files leak into the working tree. Sweep
# direct repo-root children matching the `__autotest_*` prefix on EXIT, no
# matter pass / fail / signal.
cleanup_autotest_root_leftovers() {
  shopt -s nullglob
  local leftovers=("$REPO_ROOT"/__autotest_*)
  shopt -u nullglob
  if [[ ${#leftovers[@]} -gt 0 ]]; then
    onward_robust_rm "${leftovers[@]}"
  fi
}
trap cleanup_autotest_root_leftovers EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
if [[ -z "$APP_BIN" || ! -x "$APP_BIN" ]]; then
  echo "ERROR: app binary not found or not executable: ${APP_BIN:-<empty>}" >&2
  echo "Run a development build first: rm -rf out release && pnpm dist:dev" >&2
  exit 1
fi

rm -f "$LOG_FILE"

echo "Starting image diff autotest..."
echo "  Binary: $APP_BIN"
echo "  CWD:    $ROOT_DIR"
echo "  Log:    $LOG_FILE"
echo ""

ONWARD_DEBUG=1 \
ONWARD_AUTOTEST=1 \
ONWARD_AUTOTEST_SUITE=image-diff \
ONWARD_AUTOTEST_CWD="$ROOT_DIR" \
ONWARD_AUTOTEST_EXIT=1 \
"$APP_BIN" > "$LOG_FILE" 2>&1 || true

echo ""
echo "=== Test log (last 80 lines) ==="
tail -n 80 "$LOG_FILE"
echo ""

# Gate on the framework's AUTHORITATIVE per-suite tally ("=== Test Summary ===
# totalFailed: N"), NOT on a grep for the volatile per-assertion "[AutoTest] FAIL"
# lines. The substring gate was a false-positive trap: every TRUE failure already
# bumps totalFailed, so the substring gate added only false positives (a single
# transient per-assertion miss hijacking the verdict), never a real-failure signal.
# This matches run-image-diff-autotest.ps1, which already gates only on totalFailed.
if grep -Eq "totalFailed: [1-9]" "$LOG_FILE"; then
  echo "Image diff autotest reported failed cases in the summary" >&2
  grep -E "totalFailed: [1-9]" "$LOG_FILE" >&2
  exit 1
fi

if ! grep -q "ID-21-cleanup" "$LOG_FILE"; then
  echo "Missing ID-21 result; the test may not have executed correctly" >&2
  tail -n 40 "$LOG_FILE" >&2
  exit 1
fi

echo "Image diff autotest passed"
echo "  Log: $LOG_FILE"
