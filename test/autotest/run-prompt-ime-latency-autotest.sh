#!/usr/bin/env bash
set -uo pipefail

# SPDX-FileCopyrightText: 2026 OPPO
# SPDX-License-Identifier: Apache-2.0

# Prompt IME-composition latency autotest runner (macOS/Linux).
#
# Locks the contenteditable fix: real Chinese IME composition on a large draft
# must stay fast (input->paint p95 <= 40ms), independent of caret position.
# A textarea's IME composition is O(text-before-caret) (~47-263ms at 78KB), so
# a regression to a textarea editor fails this gate.
#
# Unlike the in-renderer autotests, IME composition can only be driven through
# CDP (Input.imeSetComposition), so this runner launches the dev app with a
# remote-debugging port and drives it with prompt-ime-latency-driver.mjs.

ROOT_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
REPO_ROOT="${REPO_ROOT:-$ROOT_DIR}"
source "$ROOT_DIR/test/autotest/resolve-dev-app-bin.sh"

APP_BIN="${1:-$(resolve_dev_app_bin "$ROOT_DIR")}"
LOG_FILE="${2:-$REPO_ROOT/traces/test-logs/prompt-ime-latency-autotest.log}"
mkdir -p "$(dirname "$LOG_FILE")"

if [[ -z "${APP_BIN:-}" || ! -x "$APP_BIN" ]]; then
  echo "App binary not found: ${APP_BIN:-<empty>}" >&2
  echo "Run a development build first: rm -rf out release && pnpm dist:dev" >&2
  exit 1
fi

PROCESS_NAME="$(basename "$APP_BIN")"
DRIVER="$ROOT_DIR/test/autotest/prompt-ime-latency-driver.mjs"

# Robust kill: an app instance that lingers past a plain pkill can hold the
# debug port, causing CDP to connect to a stale build. Wait for exit, then -9.
kill_all() {
  pkill -x "$PROCESS_NAME" 2>/dev/null || true
  for _ in $(seq 1 20); do pgrep -x "$PROCESS_NAME" >/dev/null 2>&1 || break; sleep 0.5; done
  pkill -9 -x "$PROCESS_NAME" 2>/dev/null || true
  sleep 2
}

WORK_DIR="$(mktemp -d "${TMPDIR:-/tmp}/onward-ime-work.XXXXXX")"
USER_DATA_DIR="$(mktemp -d "${TMPDIR:-/tmp}/onward-ime-ud.XXXXXX")"
printf 'ime latency fixture\n' > "$WORK_DIR/README.md"
printf 'a\n' > "$WORK_DIR/a.txt"

cleanup() { kill "$APP_PID" 2>/dev/null || true; kill_all; onward_robust_rm "$WORK_DIR" "$USER_DATA_DIR"; }
trap cleanup EXIT

rm -f "$LOG_FILE"
kill_all

# Pick a free debug port.
PORT=9333
while lsof -iTCP:$PORT -sTCP:LISTEN >/dev/null 2>&1; do PORT=$((PORT+1)); done

echo "Starting Prompt IME Latency autotest..."
echo "  Binary:   $APP_BIN"
echo "  CDP port: $PORT"
echo "  Log:      $LOG_FILE"
echo

# ONWARD_AUTOTEST=1 installs the debug control the driver uses; a bogus suite +
# no ONWARD_AUTOTEST_EXIT keeps the app open for CDP. Anti-throttle flags keep
# requestAnimationFrame running while the window is backgrounded.
ONWARD_DEBUG=1 \
ONWARD_AUTOTEST=1 \
ONWARD_AUTOTEST_SUITE=ime-latency-cdp \
ONWARD_AUTOTEST_CWD="$WORK_DIR" \
ONWARD_USER_DATA_DIR="$USER_DATA_DIR" \
"$APP_BIN" --remote-debugging-port=$PORT \
  --disable-backgrounding-occluded-windows \
  --disable-renderer-backgrounding \
  --disable-background-timer-throttling \
  >"$LOG_FILE" 2>&1 &
APP_PID=$!

for _ in $(seq 1 40); do curl -s "http://localhost:$PORT/json/version" >/dev/null 2>&1 && break; sleep 0.5; done
sleep 4

CDP_PORT=$PORT node "$DRIVER"
RC=$?

echo
if [[ $RC -eq 0 ]]; then
  echo "Prompt IME Latency autotest PASSED"
else
  echo "Prompt IME Latency autotest FAILED (rc=$RC)" >&2
fi
exit $RC
