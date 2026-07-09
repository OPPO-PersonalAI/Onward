#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2026 OPPO
# SPDX-License-Identifier: Apache-2.0

set -euo pipefail

REPO_ROOT="${REPO_ROOT:-$(cd "$(dirname "$0")/../.." && pwd)}"
ROOT_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
source "$ROOT_DIR/test/autotest/resolve-dev-app-bin.sh"
APP_BIN="${1:-$(resolve_dev_app_bin "$ROOT_DIR" || true)}"
LOG_FILE="${2:-$REPO_ROOT/traces/test-logs/terminal-autofollow-autotest.log}"
mkdir -p "$(dirname "$LOG_FILE")"
if [[ -z "$APP_BIN" || ! -x "$APP_BIN" ]]; then
  echo "ERROR: app binary not found or not executable: ${APP_BIN:-<empty>}" >&2
  echo "Run a development build first: rm -rf out release && pnpm dist:dev" >&2
  exit 1
fi

rm -f "$LOG_FILE"
USER_DATA_DIR="$(mktemp -d "${TMPDIR:-/tmp}/onward-terminal-autofollow-user-data.XXXXXX")"
cleanup() {
  onward_robust_rm "$USER_DATA_DIR"
  find "$ROOT_DIR" -maxdepth 1 -name '__autotest_*' -exec rm -rf {} + 2>/dev/null || true
}
trap cleanup EXIT INT TERM

ZSH_BIN=""
if [[ -n "${SHELL:-}" && -x "${SHELL:-}" && "$(basename "$SHELL")" == "zsh" ]]; then
  ZSH_BIN="$SHELL"
elif command -v zsh >/dev/null 2>&1; then
  ZSH_BIN="$(command -v zsh)"
elif [[ -x /bin/zsh ]]; then
  ZSH_BIN="/bin/zsh"
fi

APP_ENV=(
  ONWARD_DEBUG=1
  ONWARD_AUTOTEST=1
  ONWARD_AUTOTEST_SUITE=terminal-autofollow
  ONWARD_AUTOTEST_CWD="$ROOT_DIR"
  ONWARD_AUTOTEST_EXIT=1
  ONWARD_USER_DATA_DIR="$USER_DATA_DIR"
  NO_COLOR=1
  FORCE_COLOR=0
  CLICOLOR=0
  COLORTERM=
)

if [[ -n "$ZSH_BIN" ]]; then
  APP_ENV+=(
    SHELL="$ZSH_BIN"
    ZDOTDIR="$ROOT_DIR/resources/shell-integration/zsh-zdotdir"
    USER_ZDOTDIR="$ROOT_DIR/test/autotest/fixtures/terminal-zsh-user-zdotdir"
    ONWARD_AUTOTEST_FIXTURE_EXTRA=terminal-zsh-chain
  )
fi

echo "Starting terminal autofollow autotest..."

env "${APP_ENV[@]}" "$APP_BIN" > "$LOG_FILE" 2>&1 || true

if grep -q "\[AutoTest\] FAIL" "$LOG_FILE"; then
  echo "Terminal autofollow autotest failed. Log: $LOG_FILE" >&2
  tail -n 120 "$LOG_FILE" >&2
  exit 1
fi

if ! grep -q "TA-15-ansi-color-output-preserved" "$LOG_FILE"; then
  echo "Terminal autofollow autotest did not complete. Log: $LOG_FILE" >&2
  tail -n 120 "$LOG_FILE" >&2
  exit 1
fi

echo "Terminal autofollow autotest passed. Log: $LOG_FILE"
