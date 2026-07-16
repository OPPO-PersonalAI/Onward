#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2026 OPPO
# SPDX-License-Identifier: Apache-2.0
#
# Git Diff revert-scope suite (GRS-*). Reproduces + locks the "single-file
# revert triggers a GLOBAL refresh" bug (2026-07-16): one discard used to fire
# 2-3 whole-repo diff recomputes, wipe the whole content-cache bucket, and
# remount the entire Monaco DiffEditor (mirror generation sat in its React
# key). The suite asserts refresh SCOPE, not just functionality: editor DOM
# identity survives unrelated changes, warm files stay cache-hits through a
# discard, and the discard window contains at most one list reconcile.
set -euo pipefail

DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$DIR/../.." && pwd)"
SUITE=git-diff-revert-scope
LOG_FILE="${2:-$REPO_ROOT/traces/test-logs/${SUITE}.log}"
mkdir -p "$(dirname "$LOG_FILE")"

APP_BIN="${1:-$("$DIR/resolve-dev-app-bin.sh")}"
if [[ -z "$APP_BIN" || ! -e "$APP_BIN" ]]; then
  echo "App binary not found — run 'pnpm dist:dev' first (got: '$APP_BIN')" >&2
  exit 1
fi

WATCHDOG_SEC="${WATCHDOG_SEC:-180}"
RUN_TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/onward-${SUITE}-XXXXXX")"
USER_DATA_DIR="$RUN_TMP_DIR/user-data"
mkdir -p "$USER_DATA_DIR"

# Build the fixture INSIDE the runner's temp dir (outside the Onward repo) so
# the fixture repo is standalone and never pollutes the working tree.
mkdir -p "$RUN_TMP_DIR/fixture"
FIXTURE_JSON="$(ONWARD_GRS_FIXTURE_DIR="$RUN_TMP_DIR/fixture" node "$REPO_ROOT/test/autotest/create-git-diff-revert-scope-fixture.mjs")"
REPO_CWD="$(node -e 'process.stdout.write(JSON.parse(process.argv[1]).repo)' "$FIXTURE_JSON")"
MANIFEST_PATH="$(node -e 'process.stdout.write(JSON.parse(process.argv[1]).manifestPath)' "$FIXTURE_JSON")"

cleanup() {
  rm -rf "$RUN_TMP_DIR" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

rm -f "$LOG_FILE"

echo "Starting Git Diff revert-scope autotest..."
echo "  Binary:        $APP_BIN"
echo "  Repo cwd:      $REPO_CWD"
echo "  Manifest:      $MANIFEST_PATH"
echo "  User data dir: $USER_DATA_DIR"
echo "  Watchdog:      ${WATCHDOG_SEC}s"
echo "  Log:           $LOG_FILE"
echo ""

APP_EXIT=0
TMPDIR="$RUN_TMP_DIR" \
ONWARD_DEBUG=1 \
ONWARD_PERF_TRACE=1 \
ONWARD_REPO_ROOT="$REPO_ROOT" \
ONWARD_USER_DATA_DIR="$USER_DATA_DIR" \
ONWARD_AUTOTEST=1 \
ONWARD_AUTOTEST_SUITE=git-diff-revert-scope \
ONWARD_AUTOTEST_CWD="$REPO_CWD" \
ONWARD_AUTOTEST_FIXTURE_EXTRA="$MANIFEST_PATH" \
ONWARD_AUTOTEST_EXIT=1 \
node "$REPO_ROOT/test/autotest/run-with-timeout.mjs" "$WATCHDOG_SEC" "$APP_BIN" > "$LOG_FILE" 2>&1 || APP_EXIT=$?

echo ""
echo "=== Test log (last 60 lines) ==="
tail -n 60 "$LOG_FILE"
echo ""

if grep -q "\[AutoTest\] FAIL" "$LOG_FILE"; then
  echo "Git Diff revert-scope autotest failed" >&2
  echo ""
  echo "=== Failure details ==="
  grep "\[AutoTest\] FAIL" "$LOG_FILE" >&2
  exit 1
fi

if [[ "$APP_EXIT" -ne 0 ]]; then
  echo "Git Diff revert-scope autotest exited with code $APP_EXIT" >&2
  exit "$APP_EXIT"
fi

# Completion markers: every GRS assertion must be present (a truncated run — the
# app died mid-suite — fails here even without a FAIL line).
require_marker() {
  if ! grep -q "$1" "$LOG_FILE"; then
    echo "Missing $1 marker; the suite may not have completed" >&2
    tail -n 40 "$LOG_FILE" >&2
    exit 1
  fi
}

require_marker "GRS-00-fixture-loaded"
require_marker "GRS-00b-diff-open-with-three-rows"
require_marker "GRS-01-discard-restores-and-removes-row"
require_marker "GRS-02-external-change-does-not-remount-editor"
require_marker "GRS-02b-probe-detects-real-remount"
require_marker "GRS-03-unrelated-file-cache-stays-warm"
require_marker "GRS-04-single-reconcile-after-discard"

echo ""
echo "Git Diff revert-scope autotest passed"
echo "  Log: $LOG_FILE"
