#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2026 OPPO
# SPDX-License-Identifier: Apache-2.0
#
# Wake-park GPU-crash SOAK sessions — the evidence-derived reproducer
# (BUG-0003): park hidden 15-45 s with live PTY output, wake with focus,
# stop-on-first-crash. STANDALONE measurement instrument: NOT registered in
# run-full-regression.py SCRIPTS (a session runs many minutes by design; the
# park time IS the operation under test, so the 300 s gate ceiling does not
# apply — see test/README.md row).
#
# A/B procedure (39.8.5 baseline vs 43.2.0 candidate): build each version,
# run this script with IDENTICAL env params, interleave sessions on the SAME
# machine (thermal/uptime control), compare sessions-crashed via one-sided
# Fisher exact (4/5 vs 0/5 -> p≈0.024). Results accumulate as JSONL rows in
# traces/test-logs/gpu-wake-park-soak-results.jsonl.
#
# Env: ONWARD_GPU_SOAK_SESSIONS (default 5), ONWARD_GPU_SOAK_CYCLES (20),
#      ONWARD_GPU_SOAK_PARK_MIN_SEC (15), ONWARD_GPU_SOAK_PARK_MAX_SEC (45),
#      ONWARD_GPU_SOAK_THROTTLE_FLIP (1), ONWARD_GPU_SOAK_STOP_ON_FIRST_CRASH (1)

set -euo pipefail

REPO_ROOT="${REPO_ROOT:-$(cd "$(dirname "$0")/../.." && pwd)}"
ROOT_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
APP_BIN="${1:-}"
LOG_FILE="${2:-$REPO_ROOT/traces/test-logs/gpu-wake-park-soak-autotest.log}"
RESULTS_JSONL="$REPO_ROOT/traces/test-logs/gpu-wake-park-soak-results.jsonl"
SESSIONS="${ONWARD_GPU_SOAK_SESSIONS:-5}"
# Per-session hard cap so a wedged app (e.g. an autotest bootstrap that never
# reaches the suite because the ProjectEditor auto-open did not fire) is killed
# instead of hanging forever. Default sized for a full soak session; the
# smoke run passes a small value.
SESSION_TIMEOUT_SEC="${ONWARD_GPU_SOAK_SESSION_TIMEOUT_SEC:-1200}"
DIAG_DIR="$HOME/Library/Logs/DiagnosticReports"
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
[[ -x "$APP_BIN" ]] || { echo "ERROR: app binary not executable: $APP_BIN" >&2; exit 1; }
APP_NAME="$(basename "$APP_BIN")"
ELECTRON_VERSION="$(defaults read "$(dirname "$(dirname "$APP_BIN")")/Info.plist" NSHumanReadableCopyright 2>/dev/null || true)"
# More reliable: read the Electron Framework version directly.
# APP_BIN is <app>.app/Contents/MacOS/<stem>; two dirnames up is Contents/.
FRAMEWORK_PLIST="$(dirname "$(dirname "$APP_BIN")")/Frameworks/Electron Framework.framework/Resources/Info.plist"
if [[ -f "$FRAMEWORK_PLIST" ]]; then
  ELECTRON_VERSION="$(defaults read "${FRAMEWORK_PLIST%.plist}" CFBundleVersion 2>/dev/null || echo unknown)"
else
  ELECTRON_VERSION="unknown"
fi

rm -f "$LOG_FILE"

SESSION_USER_DATA=""
cleanup() {
  pkill -x "$APP_NAME" 2>/dev/null || true
  [ -n "$SESSION_USER_DATA" ] && rm -rf "$SESSION_USER_DATA" 2>/dev/null || true
  find "$ROOT_DIR" -maxdepth 1 -name '__autotest_*' -exec rm -rf {} + 2>/dev/null || true
}
trap cleanup EXIT

# Launch the app with a hard per-session timeout (portable: no GNU timeout on
# macOS). Backgrounds the app, arms a watchdog that SIGKILLs it after
# SESSION_TIMEOUT_SEC, and waits. Returns even if the app wedges.
run_app_with_timeout() {
  local out_log="$1"
  "$APP_BIN" > "$out_log" 2>&1 &
  local app_pid=$!
  ( sleep "$SESSION_TIMEOUT_SEC"; kill -9 "$app_pid" 2>/dev/null; pkill -x "$APP_NAME" 2>/dev/null ) &
  local watchdog=$!
  wait "$app_pid" 2>/dev/null || true
  kill "$watchdog" 2>/dev/null || true
}

echo "Starting gpu-wake-park-soak: $SESSIONS session(s), electron=$ELECTRON_VERSION" | tee -a "$LOG_FILE"

for session in $(seq 1 "$SESSIONS"); do
  echo "=== SOAK session $session/$SESSIONS ===" | tee -a "$LOG_FILE"
  # Snapshot existing GPU-helper crash reports before the session.
  BEFORE_LIST="$(mktemp "${TMPDIR:-/tmp}/soak-ips-before-XXXXXX")"
  ls "$DIAG_DIR" 2>/dev/null | grep -F "$APP_NAME Helper (GPU)" > "$BEFORE_LIST" || true

  SESSION_LOG="$(mktemp "${TMPDIR:-/tmp}/soak-session.XXXXXX")"
  SESSION_START="$(date +%s)"
  # Fresh per-session userData (matches the orchestrator's isolation): a stale
  # default userData can leave no restorable tab/terminal, so the autotest
  # ProjectEditor auto-open never fires and the suite never starts.
  SESSION_USER_DATA="$(mktemp -d "${TMPDIR:-/tmp}/soak-userdata.XXXXXX")"

  ONWARD_DEBUG=1 \
  ONWARD_AUTOTEST=1 \
  ONWARD_AUTOTEST_SUITE=gpu-wake-park-soak \
  ONWARD_AUTOTEST_CWD="$ROOT_DIR" \
  ONWARD_USER_DATA_DIR="$SESSION_USER_DATA" \
  ONWARD_AUTOTEST_EXIT=1 \
  run_app_with_timeout "$SESSION_LOG"
  rm -rf "$SESSION_USER_DATA" 2>/dev/null || true
  SESSION_USER_DATA=""

  cat "$SESSION_LOG" >> "$LOG_FILE"
  MEASURE_LINE="$(grep -o 'MEASURE gpu-wake-park-soak.*' "$SESSION_LOG" | head -1 || true)"
  CYCLES="$(echo "$MEASURE_LINE" | grep -o 'cycles=[0-9]*' | cut -d= -f2 || echo 0)"
  CRASHES="$(echo "$MEASURE_LINE" | grep -o 'crashes=[0-9]*' | cut -d= -f2 || echo 0)"
  FIRST_CRASH="$(echo "$MEASURE_LINE" | grep -o 'firstCrashAtCycle=[0-9a-z]*' | cut -d= -f2 || echo none)"
  PARK_AT_CRASH="$(echo "$MEASURE_LINE" | grep -o 'parkMsAtCrash=[0-9a-z]*' | cut -d= -f2 || echo none)"

  # .ips signature verification: give ReportCrash up to 10 s to land, then
  # diff for NEW GPU-helper reports and grep the ANGLE frames. Match on
  # frames (CommandEncoder / mtl_command_buffer / insertObject), never on
  # the signal name — reports may show SIGABRT or SIGTRAP.
  SIGNATURE_MATCHED=false
  if [[ "$CRASHES" != "0" && "$CRASHES" != "" ]]; then
    sleep 10
    AFTER_LIST="$(mktemp "${TMPDIR:-/tmp}/soak-ips-after-XXXXXX")"
    ls "$DIAG_DIR" 2>/dev/null | grep -F "$APP_NAME Helper (GPU)" > "$AFTER_LIST" || true
    NEW_REPORTS="$(comm -13 "$BEFORE_LIST" "$AFTER_LIST" || true)"
    while IFS= read -r report; do
      [[ -z "$report" ]] && continue
      if grep -q -e "CommandEncoder" -e "mtl_command_buffer" -e "insertObject" "$DIAG_DIR/$report" 2>/dev/null; then
        SIGNATURE_MATCHED=true
        echo "  ANGLE signature matched in $report" | tee -a "$LOG_FILE"
      else
        echo "  crash report WITHOUT ANGLE signature (excluded from A/B): $report" | tee -a "$LOG_FILE"
      fi
    done <<< "$NEW_REPORTS"
    rm -f "$AFTER_LIST"
  fi
  rm -f "$BEFORE_LIST" "$SESSION_LOG"

  printf '{"electronVersion":"%s","session":%d,"cycles":%s,"crashes":%s,"firstCrashAtCycle":"%s","parkMsAtCrash":"%s","signatureMatched":%s,"durationSec":%d,"parkMinSec":"%s","parkMaxSec":"%s","throttleFlip":"%s"}\n' \
    "$ELECTRON_VERSION" "$session" "${CYCLES:-0}" "${CRASHES:-0}" "$FIRST_CRASH" "$PARK_AT_CRASH" "$SIGNATURE_MATCHED" \
    "$(( $(date +%s) - SESSION_START ))" \
    "${ONWARD_GPU_SOAK_PARK_MIN_SEC:-15}" "${ONWARD_GPU_SOAK_PARK_MAX_SEC:-45}" "${ONWARD_GPU_SOAK_THROTTLE_FLIP:-1}" \
    >> "$RESULTS_JSONL"
  echo "  session $session: cycles=$CYCLES crashes=$CRASHES firstCrashAtCycle=$FIRST_CRASH signatureMatched=$SIGNATURE_MATCHED" | tee -a "$LOG_FILE"

  pkill -x "$APP_NAME" 2>/dev/null || true
  sleep 2
done

echo ""
echo "=== SOAK COMPLETE — per-session results appended to $RESULTS_JSONL ==="
tail -n "$SESSIONS" "$RESULTS_JSONL"
echo "gpu-wake-park-soak finished."
