#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2026 OPPO
# SPDX-License-Identifier: Apache-2.0
#
# Unified modal dismiss policy regression (2026-07-16). Locks the app-wide
# rule that modal dialogs never dismiss on backdrop (blank-space) clicks
# and that ESC is the one keyboard path that safely cancels them:
#   MDM-00     ProjectEditor dialog debug hooks are exposed.
#   MDM-01..03 New-file prompt dialog: opens; backdrop click keeps the
#              dialog AND the half-typed filename; ESC cancels.
#   MDM-04..08 TabBar close-tab confirm: backdrop click keeps the dialog;
#              ESC cancels without closing the tab; cleanup restores tabs.
#   MDM-09..12 ESC layering (open-modal registry): ChangeLog modal + tab-
#              close confirm stacked — one ESC cancels ONLY the confirm,
#              the ChangeLog survives; a second ESC closes the ChangeLog.
#   MDM-13..15 PromptNotebook send-history panel: backdrop click keeps the
#              panel; ESC (new useModalEscape wiring) closes it.
# Companion coverage lives in run-change-log (CL-09/09b), the large-file
# suite (GLF-14..17) and run-task-layout (TLM-04b/04c). The pure cancel-key
# predicate is unit-locked by test/unittest/modal-dismiss.test.mts.
#
# Usage:
#   bash test/autotest/run-modal-dismiss-autotest.sh [APP_BIN] [LOG_FILE]

set -uo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
source "$ROOT_DIR/test/autotest/resolve-dev-app-bin.sh"
APP_BIN="${1:-$(resolve_dev_app_bin "$ROOT_DIR" || true)}"
LOG_FILE="${2:-$ROOT_DIR/traces/test-logs/modal-dismiss-autotest.log}"
USER_DATA_DIR="$(mktemp -d "${TMPDIR:-/tmp}/onward-modal-dismiss.XXXXXX")"
mkdir -p "$(dirname "$LOG_FILE")"

# Cleanup shield — even on SIGINT the mktemp scratch is removed and every
# __autotest_* fixture potentially leaked into the repo root is swept
# (legacy autotest contract, see CLAUDE.md hard rule on autotest fixtures).
cleanup() {
  rm -rf "$USER_DATA_DIR" 2>/dev/null || true
  find "$ROOT_DIR" -maxdepth 1 -name '__autotest_*' -prune -exec rm -rf {} + 2>/dev/null || true
}
trap cleanup EXIT

if [[ -z "$APP_BIN" || ! -x "$APP_BIN" ]]; then
  echo "ERROR: app binary not found or not executable: ${APP_BIN:-<empty>}" >&2
  echo "Run a development build first: rm -rf out release && pnpm dist:dev" >&2
  exit 1
fi

APP_NAME="$(basename "$APP_BIN")"
pkill -x "$APP_NAME" 2>/dev/null || true
sleep 0.5

rm -f "$LOG_FILE"

ONWARD_DEBUG=1 \
ONWARD_AUTOTEST=1 \
ONWARD_AUTOTEST_SUITE=modal-dismiss \
ONWARD_AUTOTEST_CWD="$ROOT_DIR" \
ONWARD_AUTOTEST_EXIT=1 \
ONWARD_AUTOTEST_SKIP_CONSENT=1 \
ONWARD_USER_DATA_DIR="$USER_DATA_DIR" \
"$APP_BIN" > "$LOG_FILE" 2>&1 || true

if grep -q "\[AutoTest\] FAIL" "$LOG_FILE"; then
  echo "Modal dismiss autotest failed. Log: $LOG_FILE" >&2
  tail -n 120 "$LOG_FILE" >&2
  exit 1
fi

if ! grep -q "Autotest Completed" "$LOG_FILE"; then
  echo "Modal dismiss autotest did not complete. Log: $LOG_FILE" >&2
  tail -n 120 "$LOG_FILE" >&2
  exit 1
fi

# Defensive: require the suite to have actually run (a suite-registration
# miss would otherwise pass on an empty log).
if ! grep -q "PASS MDM-00-project-editor-debug-api-available" "$LOG_FILE"; then
  echo "Modal dismiss autotest produced no MDM assertions. Log: $LOG_FILE" >&2
  tail -n 120 "$LOG_FILE" >&2
  exit 1
fi

echo "Modal dismiss autotest passed. Log: $LOG_FILE"
