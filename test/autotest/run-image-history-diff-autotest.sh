#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2026 OPPO
# SPDX-License-Identifier: Apache-2.0

# Git History image-diff suite. Split out of run-image-diff-autotest.sh because
# its per-run throwaway git repo fixture (init + 4 commits) is heavily taxed by
# EDR and pushed the combined image-diff suite past the 180s per-runner budget
# (observed TIMEOUT at 181s). This runner exercises ONLY the Git History image
# preview portion (former ID-13..ID-18); the GitDiff working-tree actions +
# editor preview portion stays in run-image-diff-autotest.sh.
#
# Round-4 fix: the fixture repo is built deterministically by
# create-image-history-diff-fixture.mjs (Node, execFileSync, no PTY) into a
# runner-owned temp dir, and its manifest path is handed to the app via
# ONWARD_AUTOTEST_FIXTURE_EXTRA. The previous version wrote a `git init &&
# commit && commit` mega-command into the live PTY, which on an EDR-throttled
# Windows host got swallowed by a shell "Press any key to continue" pause (a
# failed `watchman` startup command), so the repo was never created and ID-13
# failed with "not a Git repository", cascading every downstream ID to timeout.

set -euo pipefail

REPO_ROOT="${REPO_ROOT:-$(cd "$(dirname "$0")/../.." && pwd)}"
ROOT_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
source "$ROOT_DIR/test/autotest/resolve-dev-app-bin.sh"
APP_BIN="${1:-$(resolve_dev_app_bin "$ROOT_DIR" || true)}"
LOG_FILE="${2:-$REPO_ROOT/traces/test-logs/image-history-diff-autotest.log}"
mkdir -p "$(dirname "$LOG_FILE")"
# Generous upper bound only — caps a hang, NOT a slow-test crutch. Stays under
# the 300s per-runner ceiling.
WATCHDOG_SEC="${IMAGE_HISTORY_WATCHDOG_SEC:-200}"

if [[ -z "$APP_BIN" || ! -x "$APP_BIN" ]]; then
  echo "ERROR: app binary not found or not executable: ${APP_BIN:-<empty>}" >&2
  echo "Run a development build first: rm -rf out release && pnpm dist:dev" >&2
  exit 1
fi

# Per CLAUDE.md "Test fixture isolation": runner-owned temp dirs for both the
# fixture repo and a fresh user-data dir, removed on every exit path.
RUN_TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/onward-image-history-run.XXXXXX")"
USER_DATA_DIR="$RUN_TMP_DIR/user-data"
FIXTURE_REPO="$RUN_TMP_DIR/image-history-repo"
mkdir -p "$USER_DATA_DIR"

cleanup() {
  rm -rf "$RUN_TMP_DIR" 2>/dev/null || true
  # Defence-in-depth: sweep any legacy __autotest_* leftover in the repo root.
  shopt -s nullglob
  local leftovers=("$REPO_ROOT"/__autotest_*)
  shopt -u nullglob
  if [[ ${#leftovers[@]} -gt 0 ]]; then
    rm -rf "${leftovers[@]}"
  fi
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

# Build the two-commit image-diff repo (execFileSync; no PTY, no shell init).
FIXTURE_JSON="$(node "$REPO_ROOT/test/autotest/create-image-history-diff-fixture.mjs" "$FIXTURE_REPO")"
MANIFEST_PATH="$(node -e 'process.stdout.write(JSON.parse(process.argv[1]).manifestPath)' "$FIXTURE_JSON")"

rm -f "$LOG_FILE"

echo "Starting image history diff autotest..."
echo "  Binary:        $APP_BIN"
echo "  CWD:           $ROOT_DIR"
echo "  Fixture repo:  $FIXTURE_REPO"
echo "  Manifest:      $MANIFEST_PATH"
echo "  User data dir: $USER_DATA_DIR"
echo "  Watchdog:      ${WATCHDOG_SEC}s"
echo "  Log:           $LOG_FILE"
echo ""

APP_EXIT=0
TMPDIR="$RUN_TMP_DIR" \
ONWARD_DEBUG=1 \
ONWARD_REPO_ROOT="$REPO_ROOT" \
ONWARD_USER_DATA_DIR="$USER_DATA_DIR" \
ONWARD_AUTOTEST=1 \
ONWARD_AUTOTEST_SUITE=image-history-diff \
ONWARD_AUTOTEST_CWD="$ROOT_DIR" \
ONWARD_AUTOTEST_FIXTURE_EXTRA="$MANIFEST_PATH" \
ONWARD_AUTOTEST_EXIT=1 \
node "$REPO_ROOT/test/autotest/run-with-timeout.mjs" "$WATCHDOG_SEC" "$APP_BIN" > "$LOG_FILE" 2>&1 || APP_EXIT=$?

echo ""
echo "=== Test log (last 80 lines) ==="
tail -n 80 "$LOG_FILE"
echo ""

if grep -q "\[AutoTest\] FAIL" "$LOG_FILE"; then
  echo "Image history diff autotest failed" >&2
  grep "\[AutoTest\] FAIL" "$LOG_FILE" >&2
  exit 1
fi

if [[ "$APP_EXIT" -ne 0 ]]; then
  echo "Image history diff autotest exited with code $APP_EXIT (watchdog or crash)" >&2
  exit "$APP_EXIT"
fi

if grep -Eq "totalFailed: [1-9]" "$LOG_FILE"; then
  echo "Image history diff autotest reported failed cases in the summary" >&2
  grep -E "totalFailed: [1-9]" "$LOG_FILE" >&2
  exit 1
fi

if ! grep -q "ID-18b-cleanup" "$LOG_FILE"; then
  echo "Missing ID-18b result; the test may not have executed correctly" >&2
  tail -n 40 "$LOG_FILE" >&2
  exit 1
fi

echo "Image history diff autotest passed"
echo "  Log: $LOG_FILE"
