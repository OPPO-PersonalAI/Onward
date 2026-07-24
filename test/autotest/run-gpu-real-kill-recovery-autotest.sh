#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2026 OPPO
# SPDX-License-Identifier: Apache-2.0
#
# GPU REAL-kill recovery gate (GRK-01..07): SIGKILLs the actual GPU helper by
# pid and asserts Chromium respawn -> two-phase recovery -> renderable WebGL,
# then a second kill -> session fuse -> sticky DOM + banner, degraded but
# alive. Exactly two kills per app session (fuse is one-way; Chromium's
# ~3-crash ladder would degrade further), so trial aggregation happens at the
# LAUNCH level: K=3 full app launches, gate = all three green.
# GPU-helper crash reports produced by the kills are expected — this runner
# is allowlisted in run-full-regression.py's quit-crash sweep for
# 'Helper (GPU)' reports (the MAIN process is never allowlisted).

set -euo pipefail

REPO_ROOT="${REPO_ROOT:-$(cd "$(dirname "$0")/../.." && pwd)}"
ROOT_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
APP_BIN="${1:-}"
LOG_FILE="${2:-$REPO_ROOT/traces/test-logs/gpu-real-kill-recovery-autotest.log}"
LAUNCHES="${ONWARD_GRK_LAUNCHES:-3}"
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

cleanup() {
  find "$ROOT_DIR" -maxdepth 1 -name '__autotest_*' -exec rm -rf {} + 2>/dev/null || true
}
trap cleanup EXIT

overall_pass=1
for launch in $(seq 1 "$LAUNCHES"); do
  echo "=== GRK launch $launch/$LAUNCHES ===" | tee -a "$LOG_FILE"
  LAUNCH_LOG="$(mktemp "${TMPDIR:-/tmp}/grk-launch-XXXXXX.log")"

  ONWARD_DEBUG=1 \
  ONWARD_AUTOTEST=1 \
  ONWARD_AUTOTEST_SUITE=gpu-real-kill-recovery \
  ONWARD_AUTOTEST_CWD="$ROOT_DIR" \
  ONWARD_AUTOTEST_EXIT=1 \
  "$APP_BIN" > "$LAUNCH_LOG" 2>&1 || true

  cat "$LAUNCH_LOG" >> "$LOG_FILE"
  if grep -q "\[AutoTest\] FAIL" "$LAUNCH_LOG"; then
    echo "GRK launch $launch FAILED." | tee -a "$LOG_FILE"
    grep -o '\[AutoTest\] \(PASS\|FAIL\) [A-Za-z0-9-]*' "$LAUNCH_LOG" | tee -a "$LOG_FILE" >&2
    overall_pass=0
  elif ! grep -q "gpu-real-kill-recovery-test:done" "$LAUNCH_LOG"; then
    echo "GRK launch $launch did not complete." | tee -a "$LOG_FILE"
    tail -n 40 "$LAUNCH_LOG" >&2
    overall_pass=0
  else
    echo "GRK launch $launch PASSED." | tee -a "$LOG_FILE"
  fi
  rm -f "$LAUNCH_LOG"
done

echo ""
echo "=== AutoTest Results (last launch) ==="
# Cosmetic summary only — assertion names live inside serialized detail
# objects, so match loosely and never let an empty grep fail the runner.
grep -oE "(PASS|FAIL) GRK-[0-9a-z-]+" "$LOG_FILE" | sort | uniq -c || true

if [[ "$overall_pass" -ne 1 ]]; then
  echo "gpu-real-kill-recovery autotest FAILED (one or more launches red)." >&2
  exit 1
fi
echo "gpu-real-kill-recovery autotest PASSED ($LAUNCHES/$LAUNCHES launches green)."
