#!/usr/bin/env bash
set -uo pipefail

# SPDX-FileCopyrightText: 2026 OPPO
# SPDX-License-Identifier: Apache-2.0

# Prompt contenteditable editing-correctness autotest runner (macOS/Linux).
#
# Locks the user-perspective behaviours the <textarea> -> contenteditable
# migration introduces: real key typing, Enter->newline (innerText value model),
# IME commit, plaintext-only paste (rich formatting stripped), hasContent button
# flip, save-to-list + editor clear, context-menu clear, and double-click edit.
#
# These need REAL trusted input (keyboard / mouse / IME / paste) which the
# in-renderer autotest harness cannot produce, so this runner launches the dev
# app with a remote-debugging port and drives it with the CDP driver. The driver
# is platform-neutral (Node http + WebSocket + CDP); a .ps1 mirror can be added
# without rewriting it (Windows parity is a tracked follow-up shared with
# run-prompt-ime-latency-autotest).

ROOT_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
REPO_ROOT="${REPO_ROOT:-$ROOT_DIR}"
source "$ROOT_DIR/test/autotest/resolve-dev-app-bin.sh"

APP_BIN="${1:-$(resolve_dev_app_bin "$ROOT_DIR")}"
LOG_FILE="${2:-$REPO_ROOT/traces/test-logs/prompt-contenteditable-editing-autotest.log}"
mkdir -p "$(dirname "$LOG_FILE")"

if [[ -z "${APP_BIN:-}" || ! -x "$APP_BIN" ]]; then
  echo "App binary not found: ${APP_BIN:-<empty>}" >&2
  echo "Run a development build first: rm -rf out release && pnpm dist:dev" >&2
  exit 1
fi

PROCESS_NAME="$(basename "$APP_BIN")"
DRIVER="$ROOT_DIR/test/autotest/prompt-contenteditable-editing-driver.mjs"

# Robust kill: an app instance that lingers past a plain pkill can hold the
# debug port, causing CDP to connect to a stale build. Wait for exit, then -9.
kill_all() {
  pkill -x "$PROCESS_NAME" 2>/dev/null || true
  for _ in $(seq 1 20); do pgrep -x "$PROCESS_NAME" >/dev/null 2>&1 || break; sleep 0.5; done
  pkill -9 -x "$PROCESS_NAME" 2>/dev/null || true
  sleep 2
}

WORK_DIR="$(mktemp -d "${TMPDIR:-/tmp}/onward-ce-edit-work.XXXXXX")"
USER_DATA_DIR="$(mktemp -d "${TMPDIR:-/tmp}/onward-ce-edit-ud.XXXXXX")"
printf 'ce editing fixture\n' > "$WORK_DIR/README.md"
printf 'a\n' > "$WORK_DIR/a.txt"

cleanup() { kill "$APP_PID" 2>/dev/null || true; kill_all; onward_robust_rm "$WORK_DIR" "$USER_DATA_DIR"; }
trap cleanup EXIT

rm -f "$LOG_FILE"
kill_all

# Pick a free debug port.
PORT=9341
while lsof -iTCP:$PORT -sTCP:LISTEN >/dev/null 2>&1; do PORT=$((PORT+1)); done

echo "Starting Prompt contenteditable editing autotest..."
echo "  Binary:   $APP_BIN"
echo "  CDP port: $PORT"
echo "  Log:      $LOG_FILE"
echo

# ONWARD_AUTOTEST=1 installs the debug control the driver uses; a bogus suite +
# no ONWARD_AUTOTEST_EXIT keeps the app open for CDP. Anti-throttle flags keep
# requestAnimationFrame running while the window is backgrounded.
ONWARD_DEBUG=1 \
ONWARD_AUTOTEST=1 \
ONWARD_AUTOTEST_SUITE=ce-editing-cdp \
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

CDP_PORT=$PORT node "$DRIVER" | tee -a "$LOG_FILE"
RC=${PIPESTATUS[0]}

echo
if [[ $RC -eq 0 ]]; then
  echo "Prompt contenteditable editing autotest PASSED"
else
  echo "Prompt contenteditable editing autotest FAILED (rc=$RC)" >&2
fi
exit $RC
