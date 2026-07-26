#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2026 OPPO
# SPDX-License-Identifier: Apache-2.0
#
# Infrastructure-watchdog autotest (2026-07-20 incident class): simulated
# threadpool stall -> /api/health flip + degradation banner + recovery, the
# visibility-watchdog probe transport, and the activity-aware quit scan
# (IWD-07..09). The genuine POSIX lost-wakeup stall is locked at the unit
# layer (threadpool-stall-probe.test.mts); this runner exercises the
# platform-neutral downstream wiring.
#
# Phases 2+3 lock the session ledger (clean-shutdown marker) end to end:
#   phase 1: full IWD suite, graceful debug-quit -> ledger marked clean
#   phase 2: plain launch on the SAME scratch userData, SIGKILL mid-run
#            -> ledger left clean=false (the no-crash-report death class)
#   phase 3: session-ledger-notice suite -> abnormal verdict + TabBar
#            banner + dismiss (SLN-01..03)
# All phases share one mktemp userData so ledger state is deterministic and
# the user's real profile is never touched.

set -euo pipefail

REPO_ROOT="${REPO_ROOT:-$(cd "$(dirname "$0")/../.." && pwd)}"
ROOT_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
APP_BIN="${1:-}"
LOG_FILE="${2:-$REPO_ROOT/traces/test-logs/infra-watchdog-autotest.log}"
mkdir -p "$(dirname "$LOG_FILE")"

if [[ -z "$APP_BIN" ]]; then
  APP_PATH="$(find "$ROOT_DIR/release" -maxdepth 2 -type d -name '*.app' | sort | head -1)"
  if [[ -z "$APP_PATH" ]]; then
    echo "ERROR: no packaged .app was found. Run: rm -rf out release && pnpm dist:dev" >&2
    exit 1
  fi
  APP_STEM="$(basename "${APP_PATH%.app}")"
  APP_BIN="$APP_PATH/Contents/MacOS/$APP_STEM"
fi

if [[ ! -x "$APP_BIN" ]]; then
  echo "ERROR: app binary not found or not executable: $APP_BIN" >&2
  exit 1
fi

rm -f "$LOG_FILE"
SCRATCH_USER_DATA="$(mktemp -d "${TMPDIR:-/tmp}/iwd-userdata.XXXXXX")"

cleanup() {
  rm -rf "$SCRATCH_USER_DATA" 2>/dev/null || true
  # Sweep any legacy __autotest_* fixtures from the repo root (defence-in-depth;
  # this suite creates none itself).
  find "$ROOT_DIR" -maxdepth 1 -name '__autotest_*' -exec rm -rf {} + 2>/dev/null || true
}
trap cleanup EXIT

echo "Starting infra-watchdog autotest (phase 1: IWD suite)..."

ONWARD_DEBUG=1 \
ONWARD_AUTOTEST=1 \
ONWARD_AUTOTEST_SUITE=infra-watchdog \
ONWARD_AUTOTEST_CWD="$ROOT_DIR" \
ONWARD_USER_DATA_DIR="$SCRATCH_USER_DATA" \
ONWARD_AUTOTEST_EXIT=1 \
"$APP_BIN" > "$LOG_FILE" 2>&1 || true

if grep -q "\[AutoTest\] FAIL" "$LOG_FILE"; then
  echo "Infra-watchdog autotest FAILED (phase 1)." >&2
  grep "\[AutoTest\]" "$LOG_FILE" >&2
  exit 1
fi

if ! grep -q "infra-watchdog-test:done" "$LOG_FILE"; then
  echo "Infra-watchdog autotest did not complete (phase 1)." >&2
  tail -n 60 "$LOG_FILE" >&2
  exit 1
fi

echo "Phase 2: SIGKILL a plain instance to leave an unclean ledger..."
PHASE2_LOG="$(mktemp "${TMPDIR:-/tmp}/iwd-phase2.XXXXXX")"
ONWARD_DEBUG=1 \
ONWARD_AUTOTEST=1 \
ONWARD_AUTOTEST_SUITE=none \
ONWARD_AUTOTEST_CWD="$ROOT_DIR" \
ONWARD_USER_DATA_DIR="$SCRATCH_USER_DATA" \
"$APP_BIN" > "$PHASE2_LOG" 2>&1 &
PHASE2_PID=$!
# Wait until this instance has written its own (clean=false) ledger, then
# SIGKILL — the exact no-crash-report death the ledger exists to expose.
for _ in $(seq 1 60); do
  if [[ -f "$SCRATCH_USER_DATA/session-ledger.json" ]] \
    && grep -q "\"pid\": $PHASE2_PID" "$SCRATCH_USER_DATA/session-ledger.json" 2>/dev/null; then
    break
  fi
  sleep 0.5
done
kill -9 "$PHASE2_PID" 2>/dev/null || true
wait "$PHASE2_PID" 2>/dev/null || true
cat "$PHASE2_LOG" >> "$LOG_FILE"
rm -f "$PHASE2_LOG"

echo "Phase 3: relaunch and assert the abnormal-exit notice (SLN suite)..."
PHASE3_LOG="$(mktemp "${TMPDIR:-/tmp}/iwd-phase3.XXXXXX")"
ONWARD_DEBUG=1 \
ONWARD_AUTOTEST=1 \
ONWARD_AUTOTEST_SUITE=session-ledger-notice \
ONWARD_AUTOTEST_CWD="$ROOT_DIR" \
ONWARD_USER_DATA_DIR="$SCRATCH_USER_DATA" \
ONWARD_AUTOTEST_EXIT=1 \
"$APP_BIN" > "$PHASE3_LOG" 2>&1 || true
cat "$PHASE3_LOG" >> "$LOG_FILE"

if grep -q "\[AutoTest\] FAIL" "$PHASE3_LOG"; then
  echo "Infra-watchdog autotest FAILED (phase 3: session-ledger notice)." >&2
  grep "\[AutoTest\]" "$PHASE3_LOG" >&2
  rm -f "$PHASE3_LOG"
  exit 1
fi
if ! grep -q "session-ledger-notice-test:done" "$PHASE3_LOG"; then
  echo "Infra-watchdog autotest did not complete (phase 3)." >&2
  tail -n 60 "$PHASE3_LOG" >&2
  rm -f "$PHASE3_LOG"
  exit 1
fi
rm -f "$PHASE3_LOG"

echo ""
echo "=== AutoTest Results ==="
grep -o '\[AutoTest\] PASS.*\|\[AutoTest\] FAIL.*' "$LOG_FILE" | head -30
echo ""
echo "Infra-watchdog autotest PASSED (3 phases)."
