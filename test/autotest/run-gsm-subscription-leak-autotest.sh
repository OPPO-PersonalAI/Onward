#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2026 OPPO
# SPDX-License-Identifier: Apache-2.0
#
# GitStateMirror subscription-leak suite (SL-*). Reproduces + locks the
# dead-repo-churn class from the 2026-07-04 diagnostic bundle: a renderer
# RELOAD fires no webContents 'destroyed' event, so pre-reload mirror
# subscriptions used to survive in the router forever (3 of 5 mirrored repos
# with no live terminal, ~950 background recomputes each). The TS suite
# reloads the real window mid-run (sessionStorage phases) and asserts the
# router's refCount table via the autotest-only debug-inspect IPC.
set -euo pipefail

DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$DIR/../.." && pwd)"
SUITE=gsm-subscription-leak
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

FIXTURE_JSON="$(node "$REPO_ROOT/test/autotest/create-gsm-subscription-leak-fixture.mjs")"
NEUTRAL_CWD="$(node -e 'process.stdout.write(JSON.parse(process.argv[1]).neutralCwd)' "$FIXTURE_JSON")"
MANIFEST_PATH="$(node -e 'process.stdout.write(JSON.parse(process.argv[1]).manifestPath)' "$FIXTURE_JSON")"

cleanup() {
  rm -rf "$RUN_TMP_DIR" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

rm -f "$LOG_FILE"

echo "Starting GitStateMirror subscription-leak autotest..."
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
ONWARD_AUTOTEST_SUITE=git-state-mirror-subscription-leak \
ONWARD_AUTOTEST_CWD="$NEUTRAL_CWD" \
ONWARD_AUTOTEST_FIXTURE_EXTRA="$MANIFEST_PATH" \
ONWARD_AUTOTEST_EXIT=1 \
node "$REPO_ROOT/test/autotest/run-with-timeout.mjs" "$WATCHDOG_SEC" "$APP_BIN" > "$LOG_FILE" 2>&1 || APP_EXIT=$?

echo ""
echo "=== Test log (last 60 lines) ==="
tail -n 60 "$LOG_FILE"
echo ""

if grep -q "\[AutoTest\] FAIL" "$LOG_FILE"; then
  echo "GSM subscription-leak autotest failed" >&2
  echo ""
  echo "=== Failure details ==="
  grep "\[AutoTest\] FAIL" "$LOG_FILE" >&2
  exit 1
fi

if [[ "$APP_EXIT" -ne 0 ]]; then
  echo "GSM subscription-leak autotest exited with code $APP_EXIT" >&2
  exit "$APP_EXIT"
fi

# Completion markers: BOTH phases must have run (the reload really happened)
# and every SL assertion must be present. A phase-1-only log (reload broken)
# or a phase-2-only log (suite not re-entered) fails here even if no FAIL
# line was printed.
require_marker() {
  if ! grep -q "$1" "$LOG_FILE"; then
    echo "Missing $1 marker; the suite may not have run both phases" >&2
    tail -n 40 "$LOG_FILE" >&2
    exit 1
  fi
}

require_marker "SL-01-subscribe-unsubscribe-releases"
require_marker "SL-02a-pre-reload-subscribed"
require_marker "gsm-subscription-leak:reloading"
require_marker "SL-02b-post-reload-purged"
require_marker "SL-03-post-reload-round-releases"

echo ""
echo "GitStateMirror subscription-leak autotest passed"
echo "  Log: $LOG_FILE"
