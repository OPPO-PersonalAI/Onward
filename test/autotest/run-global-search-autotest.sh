#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2026 OPPO
# SPDX-License-Identifier: Apache-2.0

set -euo pipefail

REPO_ROOT="${REPO_ROOT:-$(cd "$(dirname "$0")/../.." && pwd)}"
ROOT_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
source "$ROOT_DIR/test/autotest/resolve-dev-app-bin.sh"
APP_BIN="${1:-$(resolve_dev_app_bin "$ROOT_DIR" || true)}"
LOG_FILE="${2:-$REPO_ROOT/traces/test-logs/global-search-autotest.log}"
mkdir -p "$(dirname "$LOG_FILE")"
WORK_DIR="$ROOT_DIR/test/autotest/fixtures/global-search/workdir"
USER_DATA_DIR="$ROOT_DIR/test/autotest/fixtures/global-search/user-data"

if [[ -z "$APP_BIN" || ! -x "$APP_BIN" ]]; then
  echo "ERROR: app binary not found or not executable: ${APP_BIN:-<empty>}" >&2
  echo "Run a development build first: rm -rf out release && pnpm dist:dev" >&2
  exit 1
fi

mkdir -p "$WORK_DIR"
# Seed the workdir with a placeholder file so the ProjectEditor file tree is
# non-empty. The autotest useEffect in ProjectEditor.tsx is gated on
# `tree.length > 0`; an empty workdir would leave the autotest waiting forever
# and produce a silent 5-minute timeout. The seed file is unrelated to the
# search query (`ONWARD_GS_MARKER_*`) so it does not pollute assertions, and
# the runner re-creates it each invocation because `test/autotest/fixtures/*/workdir/`
# is gitignored as an ephemeral directory.
if [[ ! -f "$WORK_DIR/seed.md" ]]; then
  printf 'global-search autotest seed file\n' > "$WORK_DIR/seed.md"
fi
case "$USER_DATA_DIR" in
  "$ROOT_DIR"/test/autotest/fixtures/global-search/user-data)
    onward_robust_rm "$USER_DATA_DIR"
    mkdir -p "$USER_DATA_DIR"
    ;;
  *)
    echo "Refusing to delete userData outside repo: $USER_DATA_DIR" >&2
    exit 1
    ;;
esac
rm -f "$LOG_FILE"

echo "Starting global search autotest..."
echo "  Binary:   $APP_BIN"
echo "  CWD:      $WORK_DIR"
echo "  UserData: $USER_DATA_DIR"
echo "  Log:      $LOG_FILE"

PROCESS_NAME="$(basename "$APP_BIN")"
if command -v pkill >/dev/null 2>&1; then
  pkill -x "$PROCESS_NAME" 2>/dev/null || true
  sleep 0.5
fi

ONWARD_DEBUG=1 \
ONWARD_AUTOTEST=1 \
ONWARD_AUTOTEST_SUITE=global-search \
ONWARD_AUTOTEST_CWD="$WORK_DIR" \
ONWARD_AUTOTEST_EXIT=1 \
ONWARD_AUTOTEST_SKIP_CONSENT=1 \
ONWARD_USER_DATA_DIR="$USER_DATA_DIR" \
"$APP_BIN" > "$LOG_FILE" 2>&1 || true

if grep -q "\[AutoTest\] FAIL" "$LOG_FILE"; then
  echo "Global search autotest failed. Log: $LOG_FILE" >&2
  tail -n 120 "$LOG_FILE" >&2
  exit 1
fi

if ! grep -q "GS-11-search-cancel" "$LOG_FILE"; then
  echo "Global search autotest did not complete. Log: $LOG_FILE" >&2
  tail -n 120 "$LOG_FILE" >&2
  exit 1
fi

echo "Global search autotest passed. Log: $LOG_FILE"
