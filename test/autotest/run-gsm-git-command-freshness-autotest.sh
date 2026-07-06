#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2026 OPPO
# SPDX-License-Identifier: Apache-2.0
#
# GitStateMirror git-command / revalidate freshness suite (GCF-*). Reproduces +
# locks the watcher-independent-freshness fix for the 2026-07-05 diagnostic
# bundles: the FS watcher silently drops `.git/**` events on EDR Windows, so a
# `git commit` / `git init` / edit left the diff list + tab status stale until a
# manual refresh. The fix revalidates on Git Diff open + on completed terminal
# git commands, and re-attaches the watcher when a cwd becomes a git repo. The
# TS suite drives the router via the real IPC surface + an autotest-only
# `git init` IPC; a non-git cwd has NO watcher, so a fresh detection is uniquely
# attributable to the fix.
set -euo pipefail

DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$DIR/../.." && pwd)"
SUITE=gsm-git-command-freshness
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
# `later-git` is a genuinely non-git dir — a subdir under the Onward working tree
# would resolve up to Onward's own `.git` and defeat the non-git → git assertion.
mkdir -p "$RUN_TMP_DIR/fixture"
FIXTURE_JSON="$(ONWARD_GCF_FIXTURE_DIR="$RUN_TMP_DIR/fixture" node "$REPO_ROOT/test/autotest/create-gsm-git-command-freshness-fixture.mjs")"
NEUTRAL_CWD="$(node -e 'process.stdout.write(JSON.parse(process.argv[1]).neutralCwd)' "$FIXTURE_JSON")"
MANIFEST_PATH="$(node -e 'process.stdout.write(JSON.parse(process.argv[1]).manifestPath)' "$FIXTURE_JSON")"

cleanup() {
  rm -rf "$RUN_TMP_DIR" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

rm -f "$LOG_FILE"

echo "Starting GitStateMirror git-command-freshness autotest..."
echo "  Binary:        $APP_BIN"
echo "  Neutral cwd:   $NEUTRAL_CWD"
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
ONWARD_AUTOTEST_SUITE=git-state-mirror-git-command-freshness \
ONWARD_AUTOTEST_CWD="$NEUTRAL_CWD" \
ONWARD_AUTOTEST_FIXTURE_EXTRA="$MANIFEST_PATH" \
ONWARD_AUTOTEST_EXIT=1 \
node "$REPO_ROOT/test/autotest/run-with-timeout.mjs" "$WATCHDOG_SEC" "$APP_BIN" > "$LOG_FILE" 2>&1 || APP_EXIT=$?

echo ""
echo "=== Test log (last 60 lines) ==="
tail -n 60 "$LOG_FILE"
echo ""

if grep -q "\[AutoTest\] FAIL" "$LOG_FILE"; then
  echo "GSM git-command-freshness autotest failed" >&2
  echo ""
  echo "=== Failure details ==="
  grep "\[AutoTest\] FAIL" "$LOG_FILE" >&2
  exit 1
fi

if [[ "$APP_EXIT" -ne 0 ]]; then
  echo "GSM git-command-freshness autotest exited with code $APP_EXIT" >&2
  exit "$APP_EXIT"
fi

# Completion markers: every GCF assertion must be present (a truncated run — the
# app died mid-suite — fails here even without a FAIL line).
require_marker() {
  if ! grep -q "$1" "$LOG_FILE"; then
    echo "Missing $1 marker; the suite may not have completed" >&2
    tail -n 40 "$LOG_FILE" >&2
    exit 1
  fi
}

require_marker "GCF-00-fixture-loaded"
require_marker "GCF-01-non-git-to-git-detected-via-revalidate"
require_marker "GCF-02-reattached-watcher-is-live"
require_marker "GCF-03-revalidate-surfaces-worktree-change"

echo ""
echo "GitStateMirror git-command-freshness autotest passed"
echo "  Log: $LOG_FILE"
