#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2026 OPPO
# SPDX-License-Identifier: Apache-2.0
#
# Signal-initiated quit acceptance (POSIX-only by design).
#
# Locks the 2026-07-31 SIGTERM fix: a termination signal must drive the
# bounded no-confirm graceful quit instead of parking forever on the
# confirmQuit modal (-[NSAlert runModal]). Five SIGTERM trials + one SIGINT
# trial; EVERY trial must exit with code 0 within the design-derived budget
# (boolean-correctness repetition per the timing-sensitive authoring rule).
#
# Windows note (cross-platform rule): SIGTERM does not exist there — graceful
# termination is WM_CLOSE via /F-less taskkill, a different code path outside
# this fix's scope. This suite is platform-conditional like
# run-auto-update-windows-e2e is on Windows.

set -euo pipefail

REPO_ROOT="${REPO_ROOT:-$(cd "$(dirname "$0")/../.." && pwd)}"
ROOT_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
source "$ROOT_DIR/test/autotest/resolve-dev-app-bin.sh"
APP_BIN="${1:-$(resolve_dev_app_bin "$ROOT_DIR" || true)}"
LOG_FILE="${2:-$REPO_ROOT/traces/test-logs/signal-quit-autotest.log}"

# Design-derived exit budget: the quit hard-exit floor is 12s in production
# and 20s under ONWARD_AUTOTEST=1 (HARD_EXIT_MS in electron/main/index.ts
# requestQuitForDebug); a floor-fired exit is a designed bounded exit, so the
# assertion line must clear the 20s autotest floor with margin instead of
# straddling it. The happy path exits in a few seconds regardless.
EXIT_BUDGET_SECS=25
WARMUP_SECS=8

APP_NAME="$(basename "$APP_BIN")"
TMP_CWD=""
APP_PID=""

cleanup() {
  if [[ -n "$APP_PID" ]] && kill -0 "$APP_PID" 2>/dev/null; then
    kill -KILL "$APP_PID" 2>/dev/null || true
  fi
  pkill -9 -x "$APP_NAME" 2>/dev/null || true
  find "$ROOT_DIR" -maxdepth 1 -name '__autotest_*' -exec rm -rf {} + 2>/dev/null || true
  if [[ -n "$TMP_CWD" ]]; then
    rm -rf "$TMP_CWD" 2>/dev/null || true
  fi
}
trap cleanup EXIT

mkdir -p "$(dirname "$LOG_FILE")"
rm -f "$LOG_FILE"

if [[ -z "$APP_BIN" || ! -x "$APP_BIN" ]]; then
  echo "ERROR: app binary not found or not executable: ${APP_BIN:-<empty>}" >&2
  echo "Run a development build first: rm -rf out release && pnpm dist:dev" >&2
  exit 1
fi

TMP_CWD="$(mktemp -d "${TMPDIR:-/tmp}/onward-signal-quit.XXXXXX")"

echo "Starting signal-quit autotest..."
echo "  Binary: $APP_BIN"
echo "  Budget: ${EXIT_BUDGET_SECS}s per trial (12s prod hard-exit floor + margin)"
echo "  Log:    $LOG_FILE"
echo ""

PASS=0
FAIL=0
RESULTS=()

run_trial() {
  local trial_name="$1"
  local sig="$2"

  # A fresh instance per trial: the graceful-quit path must work from a cold
  # start every time, not only for the first signal ever received.
  ONWARD_AUTOTEST=1 \
  ONWARD_AUTOTEST_CWD="$TMP_CWD" \
  "$APP_BIN" >> "$LOG_FILE" 2>&1 &
  APP_PID=$!

  local waited=0
  while (( waited < WARMUP_SECS )); do
    if ! kill -0 "$APP_PID" 2>/dev/null; then
      RESULTS+=("FAIL $trial_name: app exited during warmup")
      FAIL=$((FAIL + 1))
      APP_PID=""
      return
    fi
    sleep 1
    waited=$((waited + 1))
  done

  local start_secs=$SECONDS
  kill "-$sig" "$APP_PID" 2>/dev/null || true

  local exited=0
  local half_ticks=$((EXIT_BUDGET_SECS * 2))
  for (( i = 0; i < half_ticks; i++ )); do
    if ! kill -0 "$APP_PID" 2>/dev/null; then
      exited=1
      break
    fi
    sleep 0.5
  done

  if (( exited == 0 )); then
    RESULTS+=("FAIL $trial_name: SURVIVED_${sig} past ${EXIT_BUDGET_SECS}s budget")
    FAIL=$((FAIL + 1))
    kill -KILL "$APP_PID" 2>/dev/null || true
    wait "$APP_PID" 2>/dev/null || true
    APP_PID=""
    return
  fi

  local exit_code=0
  wait "$APP_PID" 2>/dev/null || exit_code=$?
  local elapsed=$((SECONDS - start_secs))
  APP_PID=""

  # SIGINT maps to 130 when the default handler wins — the graceful path must
  # end in app.quit()/app.exit(0), so ONLY code 0 passes for both signals.
  if (( exit_code == 0 )); then
    RESULTS+=("PASS $trial_name: exit=0 in ${elapsed}s")
    PASS=$((PASS + 1))
  else
    RESULTS+=("FAIL $trial_name: exit=${exit_code} in ${elapsed}s")
    FAIL=$((FAIL + 1))
  fi
}

for trial in 1 2 3 4 5; do
  run_trial "SQ-0${trial}-sigterm-graceful-exit-trial-${trial}" "TERM"
done
run_trial "SQ-06-sigint-graceful-exit" "INT"

{
  echo ""
  echo "=== Result List ==="
  for line in "${RESULTS[@]}"; do
    echo "$line"
  done
  echo "signal-quit summary: passed=${PASS} failed=${FAIL}"
} | tee -a "$LOG_FILE"

if (( FAIL > 0 )); then
  echo "Signal-quit autotest failed" >&2
  exit 1
fi

echo "Signal-quit autotest passed"
echo "  Log: $LOG_FILE"
