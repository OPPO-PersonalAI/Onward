#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2026 OPPO
# SPDX-License-Identifier: Apache-2.0
#
# Memory diagnostics closed-loop autotest (MW-01..MW-09).
# Drives: Tier-1 sampling (main + workers + renderer) → synthetic
# over-threshold injection → pressure detection + memory report →
# notification → Feedback modal → consented heap-snapshot bundle export.
# Post-exit, asserts the diagnostic-tier trace chunks actually carry the
# mem-watch breadcrumbs a user bundle would ship.

set -euo pipefail

REPO_ROOT="${REPO_ROOT:-$(cd "$(dirname "$0")/../.." && pwd)}"
ROOT_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
source "$ROOT_DIR/test/autotest/resolve-dev-app-bin.sh"
APP_BIN="${1:-}"
LOG_FILE="${2:-$REPO_ROOT/traces/test-logs/memory-watch-autotest.log}"
mkdir -p "$(dirname "$LOG_FILE")"
USER_DATA_DIR="${3:-}"

# Track whether this script created the user-data dir, so cleanup only removes
# self-created directories and never a caller-supplied path that may hold real data.
TMP_ROOT_OWNED=0

cleanup() {
  # Defence-in-depth sweep: forced bundle paths are pointed at the scratch
  # dir, but sweep repo-root __autotest_* anyway per the autotest hard rule.
  find "$ROOT_DIR" -maxdepth 1 -name '__autotest_*' -exec rm -rf {} + 2>/dev/null || true
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
  USER_DATA_DIR="$(mktemp -d "${TMPDIR:-/tmp}/onward-autotest-memory-watch.XXXXXXXX")"
  TMP_ROOT_OWNED=1
fi

if [[ ! -x "$APP_BIN" ]]; then
  echo "ERROR: app binary not found or not executable: $APP_BIN" >&2
  exit 1
fi

rm -f "$LOG_FILE"

BUNDLE_OUT_DIR="$USER_DATA_DIR/bundle-out"
mkdir -p "$BUNDLE_OUT_DIR"

echo "Starting memory-watch autotest..."
echo "[autotest] tmp dir: $USER_DATA_DIR"

# ONWARD_REPO_ROOT points the trace store INSIDE the scratch dir so the
# post-exit chunk assertions read an isolated capture (and cleanup removes
# it), instead of interleaving with the repo's own traces/perf history.
ONWARD_DEBUG=1 \
ONWARD_AUTOTEST=1 \
ONWARD_AUTOTEST_SUITE=memory-watch \
ONWARD_AUTOTEST_CWD="$ROOT_DIR" \
ONWARD_AUTOTEST_EXIT=1 \
ONWARD_AUTOTEST_FIXTURE_EXTRA="$BUNDLE_OUT_DIR" \
ONWARD_USER_DATA_DIR="$USER_DATA_DIR" \
ONWARD_REPO_ROOT="$USER_DATA_DIR" \
ONWARD_MEM_WATCH_INTERVAL_SEC=1 \
ONWARD_MEM_WATCH_MIN_UPTIME_SEC=0 \
"$APP_BIN" > "$LOG_FILE" 2>&1 || true

if grep -q "\[AutoTest\] FAIL" "$LOG_FILE"; then
  echo "Memory-watch autotest failed. Log: $LOG_FILE" >&2
  tail -n 160 "$LOG_FILE" >&2
  exit 1
fi

if ! grep -q "MW-09-heap-snapshot-sidecars-attached" "$LOG_FILE"; then
  echo "Memory-watch autotest did not complete. Log: $LOG_FILE" >&2
  tail -n 160 "$LOG_FILE" >&2
  exit 1
fi

# ---- Post-exit trace-chunk assertions (the closed loop's durable output) ----
TRACE_DIR="$USER_DATA_DIR/traces/perf"
fail_trace() {
  echo "Memory-watch autotest trace assertion failed: $1" >&2
  ls -la "$TRACE_DIR" >&2 || true
  exit 1
}

[[ -d "$TRACE_DIR" ]] || fail_trace "trace dir missing: $TRACE_DIR"

for event in \
  "main:mem-watch.sample" \
  "worker:mem-watch.sample" \
  "renderer:mem-watch.sample" \
  "main:mem-watch.pressure-detected" \
  "main:mem-watch.report-written" \
  "main:mem-watch.dump-written" \
  "main:diagnostic-bundle.heap-snapshot-attached"
do
  grep -l -- "$event" "$TRACE_DIR"/perf-*.jsonl > /dev/null 2>&1 \
    || fail_trace "event '$event' not found in any trace chunk"
done

# The lightweight memory report must sit next to the chunks (that is what
# ships inside a user diagnostic bundle with zero bundler changes).
ls "$TRACE_DIR"/memory-report-*.jsonl > /dev/null 2>&1 \
  || fail_trace "memory-report-*.jsonl missing from trace dir"

echo "Memory-watch autotest passed. Log: $LOG_FILE"
