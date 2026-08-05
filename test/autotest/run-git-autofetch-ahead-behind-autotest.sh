#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2026 OPPO
# SPDX-License-Identifier: Apache-2.0
#
# Git ahead/behind + background auto-fetch suite (AB-*). Locks the "local ahead
# / remote behind" Task-badge feature end-to-end against REAL git repos (a local
# bare remote + clones, no network): the mirror snapshot carries the `# branch.ab`
# ahead/behind counts (AB-01..05), and a background fetch (the autotest-only force
# hook) refreshes a stale behind (AB-06). The automatic fetch loop is DISABLED
# (ONWARD_DISABLE_GIT_AUTOFETCH=1) so only the explicit force-fetch flips behind —
# the assertion stays deterministic and cannot race the scheduler's timer.
set -euo pipefail

DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$DIR/../.." && pwd)"
SUITE=git-autofetch-ahead-behind
LOG_FILE="${2:-$REPO_ROOT/traces/test-logs/${SUITE}.log}"
mkdir -p "$(dirname "$LOG_FILE")"

APP_BIN="${1:-$("$DIR/resolve-dev-app-bin.sh")}"
if [[ -z "$APP_BIN" || ! -e "$APP_BIN" ]]; then
  echo "App binary not found — run 'pnpm dist:dev' first (got: '$APP_BIN')" >&2
  exit 1
fi

# 240 (not 180): AB-08 spends the manager's full 20 s fetch ceiling BY DESIGN —
# it asserts the timeout branch — and AB-07/09/10 add convergence polling on top.
# Still well inside the 300 s per-runner regression ceiling; if this suite ever
# needs more, split it rather than widening further (test/README.md § 3).
WATCHDOG_SEC="${WATCHDOG_SEC:-240}"
RUN_TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/onward-${SUITE}-XXXXXX")"
USER_DATA_DIR="$RUN_TMP_DIR/user-data"
mkdir -p "$USER_DATA_DIR"

# Build the bare-remote + clones fixture OUTSIDE the Onward repo tree so the
# no-upstream repo is genuinely upstream-less and clones do not resolve up to
# Onward's own .git.
mkdir -p "$RUN_TMP_DIR/fixture"
FIXTURE_JSON="$(ONWARD_AB_FIXTURE_DIR="$RUN_TMP_DIR/fixture" node "$REPO_ROOT/test/autotest/create-git-autofetch-ahead-behind-fixture.mjs")"
NEUTRAL_CWD="$(node -e 'process.stdout.write(JSON.parse(process.argv[1]).neutralCwd)' "$FIXTURE_JSON")"
MANIFEST_PATH="$(node -e 'process.stdout.write(JSON.parse(process.argv[1]).manifestPath)' "$FIXTURE_JSON")"

cleanup() {
  rm -rf "$RUN_TMP_DIR" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

rm -f "$LOG_FILE"

echo "Starting git ahead/behind + auto-fetch autotest..."
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
ONWARD_AUTOTEST_SUITE=git-autofetch-ahead-behind \
ONWARD_AUTOTEST_CWD="$NEUTRAL_CWD" \
ONWARD_AUTOTEST_FIXTURE_EXTRA="$MANIFEST_PATH" \
ONWARD_AUTOTEST_EXIT=1 \
ONWARD_DISABLE_GIT_AUTOFETCH=1 \
node "$REPO_ROOT/test/autotest/run-with-timeout.mjs" "$WATCHDOG_SEC" "$APP_BIN" > "$LOG_FILE" 2>&1 || APP_EXIT=$?

echo ""
echo "=== Test log (last 60 lines) ==="
tail -n 60 "$LOG_FILE"
echo ""

if grep -q "\[AutoTest\] FAIL" "$LOG_FILE"; then
  echo "git ahead/behind + auto-fetch autotest failed" >&2
  echo ""
  echo "=== Failure details ==="
  grep "\[AutoTest\] FAIL" "$LOG_FILE" >&2
  exit 1
fi

if [[ "$APP_EXIT" -ne 0 ]]; then
  echo "git ahead/behind + auto-fetch autotest exited with code $APP_EXIT" >&2
  exit "$APP_EXIT"
fi

# Completion markers: every AB assertion must be present (a truncated run — the
# app died mid-suite — fails here even without a FAIL line).
require_marker() {
  if ! grep -q "$1" "$LOG_FILE"; then
    echo "Missing $1 marker; the suite may not have completed" >&2
    tail -n 40 "$LOG_FILE" >&2
    exit 1
  fi
}

require_marker "AB-00-fixture-loaded"
require_marker "AB-01-up-to-date"
require_marker "AB-02-ahead-only"
require_marker "AB-03-behind-only"
require_marker "AB-04-diverged"
require_marker "AB-05-no-upstream-undefined"
require_marker "AB-06-background-fetch-flips-behind"

echo ""
echo "git ahead/behind + auto-fetch autotest passed"
echo "  Log: $LOG_FILE"
