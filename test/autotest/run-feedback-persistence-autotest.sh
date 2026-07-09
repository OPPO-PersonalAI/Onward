#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2026 OPPO
# SPDX-License-Identifier: Apache-2.0

set -euo pipefail

REPO_ROOT="${REPO_ROOT:-$(cd "$(dirname "$0")/../.." && pwd)}"
ROOT_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
source "$ROOT_DIR/test/autotest/resolve-dev-app-bin.sh"
APP_BIN="${1:-}"
SEED_LOG_FILE="${2:-$REPO_ROOT/traces/test-logs/feedback-persistence-seed.log}"
mkdir -p "$(dirname "$SEED_LOG_FILE")"
VERIFY_LOG_FILE="${3:-$REPO_ROOT/traces/test-logs/feedback-persistence-verify.log}"
mkdir -p "$(dirname "$VERIFY_LOG_FILE")"
USER_DATA_DIR="${4:-}"

# Track whether this script created the user-data dir, so cleanup only removes
# self-created directories and never a caller-supplied path that may hold real data.
TMP_ROOT_OWNED=0

cleanup() {
  if [[ "$TMP_ROOT_OWNED" -eq 1 && -n "${USER_DATA_DIR:-}" && -d "$USER_DATA_DIR" ]]; then
    if [[ "${ONWARD_AUTOTEST_KEEP_TMP:-0}" == "1" ]]; then
      echo "[autotest] retained tmp for debugging: $USER_DATA_DIR"
    else
      onward_robust_rm "$USER_DATA_DIR"
    fi
  fi
}
trap cleanup EXIT
# Signal trap must exit (not just return) so an interrupted run does not fall
# through to the post-app log checks and report a stale success.
trap 'exit 130' INT
trap 'exit 143' TERM

if [[ -z "$APP_BIN" ]]; then
  APP_BIN="$("$ROOT_DIR/test/autotest/resolve-dev-app-bin.sh" "$ROOT_DIR")"
fi

if [[ -z "$USER_DATA_DIR" ]]; then
  USER_DATA_DIR="$(mktemp -d "${TMPDIR:-/tmp}/onward-autotest-feedback-persistence.XXXXXXXX")"
  TMP_ROOT_OWNED=1
fi

if [[ ! -x "$APP_BIN" ]]; then
  echo "ERROR: app binary not found or not executable: $APP_BIN" >&2
  exit 1
fi

rm -f "$SEED_LOG_FILE" "$VERIFY_LOG_FILE"

run_suite() {
  local suite_id="$1"
  local log_file="$2"
  local marker="$3"

  ONWARD_DEBUG=1 \
  ONWARD_AUTOTEST=1 \
  ONWARD_AUTOTEST_SUITE="$suite_id" \
  ONWARD_AUTOTEST_CWD="$ROOT_DIR" \
  ONWARD_AUTOTEST_EXIT=1 \
  ONWARD_USER_DATA_DIR="$USER_DATA_DIR" \
  "$APP_BIN" > "$log_file" 2>&1 || true

  if grep -q "\[AutoTest\] FAIL" "$log_file"; then
    echo "Feedback persistence autotest failed in suite '$suite_id'. Log: $log_file" >&2
    tail -n 160 "$log_file" >&2
    exit 1
  fi

  if ! grep -q "$marker" "$log_file"; then
    echo "Feedback persistence autotest did not complete suite '$suite_id'. Log: $log_file" >&2
    tail -n 160 "$log_file" >&2
    exit 1
  fi
}

echo "Starting feedback persistence autotest..."
echo "[autotest] tmp dir: $USER_DATA_DIR"

run_suite "feedback-persistence-seed" "$SEED_LOG_FILE" "FBP-SEED-03-create-pending-history-record"
run_suite "feedback-persistence-verify" "$VERIFY_LOG_FILE" "FBP-VERIFY-04-history-record-removable"

echo "Feedback persistence autotest passed."
echo "Seed log: $SEED_LOG_FILE"
echo "Verify log: $VERIFY_LOG_FILE"
