#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2026 OPPO
# SPDX-License-Identifier: Apache-2.0
#
# Cmd+P arrow-key navigation: per-press latency (one-frame budget), selected-row
# visibility, page-boundary continuity, and hover/keyboard arbitration.

set -euo pipefail

REPO_ROOT="${REPO_ROOT:-$(cd "$(dirname "$0")/../.." && pwd)}"
ROOT_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
source "$ROOT_DIR/test/autotest/resolve-dev-app-bin.sh"
APP_BIN="${1:-$(resolve_dev_app_bin "$ROOT_DIR" || true)}"
LOG_FILE="${2:-$REPO_ROOT/traces/test-logs/quick-open-key-latency.log}"
mkdir -p "$(dirname "$LOG_FILE")"
if [[ -z "$APP_BIN" || ! -x "$APP_BIN" ]]; then
  echo "ERROR: app binary not found or not executable: ${APP_BIN:-<empty>}" >&2
  echo "Run a development build first: rm -rf out release && pnpm dist:dev" >&2
  exit 1
fi

# Reuse the committed file-index fixture: it is large enough to produce a
# multi-page candidate list, which is what the paging assertions need.
FIXTURE_DIR="$ROOT_DIR/test/autotest/fixtures/file-index-cache"
if [[ ! -d "$FIXTURE_DIR" ]]; then
  echo "ERROR: fixture directory missing: $FIXTURE_DIR" >&2
  echo "Expected committed test asset — do not delete." >&2
  exit 1
fi

USER_DATA_DIR="$(mktemp -d "/tmp/onward-qokl-userdata.XXXXXX")"
cleanup() {
  rm -rf "$USER_DATA_DIR"
  find "$FIXTURE_DIR" -name "onward-fic-*" -delete 2>/dev/null || true
}
trap cleanup EXIT

rm -f "$LOG_FILE"

# The repo root (not the small fixture) is the cwd here: the paging assertions
# need more candidates than one page, and the repo has ~1.5k indexed files.
ONWARD_DEBUG=1 \
ONWARD_AUTOTEST=1 \
ONWARD_AUTOTEST_SUITE=quick-open-key-latency \
ONWARD_AUTOTEST_CWD="$ROOT_DIR" \
ONWARD_AUTOTEST_EXIT=1 \
ONWARD_USER_DATA_DIR="$USER_DATA_DIR" \
ONWARD_TELEMETRY_RESET_CONSENT=1 \
"$APP_BIN" > "$LOG_FILE" 2>&1 || true

if grep -q "\[AutoTest\] FAIL" "$LOG_FILE"; then
  echo "Quick Open key latency autotest failed. Log: $LOG_FILE" >&2
  grep -n "\[AutoTest\] \(PASS\|FAIL\)" "$LOG_FILE" | tail -n 40 >&2 || true
  tail -n 60 "$LOG_FILE" >&2
  exit 1
fi

required_markers=(
  "QOKL-04-every-press-lands"
  "QOKL-05-latency-within-budget"
  "QOKL-06-selected-row-always-visible"
  "QOKL-07-page-boundary-press-not-swallowed"
  "QOKL-08-hover-does-not-hijack-keyboard-selection"
  "QOKL-10-keyboard-hints-visible"
)
for marker in "${required_markers[@]}"; do
  if ! grep -q "$marker" "$LOG_FILE"; then
    echo "Missing required assertion marker in log: $marker" >&2
    tail -n 60 "$LOG_FILE" >&2
    exit 1
  fi
done

echo "Quick Open key latency autotest passed. Log: $LOG_FILE"
grep -E "\[AutoTest\] (PASS|FAIL) " "$LOG_FILE" | tail -n 20 || true
