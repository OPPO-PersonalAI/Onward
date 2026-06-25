#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2026 OPPO
# SPDX-License-Identifier: Apache-2.0
#
# End-to-end "manual rename survives a restart" autotest.
#
# Two real launches against ONE throwaway userData dir, with a throwaway git
# fixture repo as the terminal cwd:
#   seed   : rename a Task → real AppStateStorage persist → exit
#   verify : relaunch → real boot hydration + GitStateMirror + auto-follow pass
#            → assert the name AND its manualNameRepoRoot marker survived.
#
# Catches BOTH regressions of this bug class: (a) the serializer dropping the
# marker on persist, and (b) the boot auto-follow pass clobbering the name.

set -euo pipefail

REPO_ROOT="${REPO_ROOT:-$(cd "$(dirname "$0")/../.." && pwd)}"
ROOT_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
APP_BIN="${1:-}"
SEED_LOG_FILE="${2:-$REPO_ROOT/traces/test-logs/terminal-rename-restart-survival-seed.log}"
VERIFY_LOG_FILE="${3:-$REPO_ROOT/traces/test-logs/terminal-rename-restart-survival-verify.log}"
mkdir -p "$(dirname "$SEED_LOG_FILE")" "$(dirname "$VERIFY_LOG_FILE")"

# Scratch dirs we own and remove on exit (never a caller-supplied path).
USER_DATA_DIR=""
FIXTURE_REPO=""
OWNED_USER_DATA=0
OWNED_FIXTURE=0

# Best-effort recursive remove that tolerates transient Windows EDR/AV file locks
# ("Device or resource busy" / EPERM): retry with backoff, and NEVER fail the run
# on a cleanup error. A passed test must not be flipped to FAIL just because a
# cleanup rm lost a race with a lingering git/conpty handle (the original
# false-FAIL here: the test printed "passed", then `rm -rf` hit a busy lock and,
# under `set -e`, propagated exit 1 from the EXIT trap).
robust_rm() {
  local target="$1"
  [[ -z "$target" || ! -e "$target" ]] && return 0
  local attempt
  for attempt in 1 2 3 4 5 6 7 8 9 10; do
    if rm -rf "$target" 2>/dev/null; then
      return 0
    fi
    sleep 0.3
  done
  echo "[autotest] WARN: could not remove $target after retries (left for the OS to release)" >&2
  return 0
}

cleanup() {
  if [[ "$OWNED_USER_DATA" -eq 1 && -n "$USER_DATA_DIR" && -d "$USER_DATA_DIR" ]]; then
    if [[ "${ONWARD_AUTOTEST_KEEP_TMP:-0}" == "1" ]]; then
      echo "[autotest] retained userData for debugging: $USER_DATA_DIR"
    else
      robust_rm "$USER_DATA_DIR"
    fi
  fi
  if [[ "$OWNED_FIXTURE" -eq 1 && -n "$FIXTURE_REPO" && -d "$FIXTURE_REPO" ]]; then
    if [[ "${ONWARD_AUTOTEST_KEEP_TMP:-0}" == "1" ]]; then
      echo "[autotest] retained git fixture for debugging: $FIXTURE_REPO"
    else
      robust_rm "$FIXTURE_REPO"
    fi
  fi
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

if [[ -z "$APP_BIN" ]]; then
  APP_BIN="$("$ROOT_DIR/test/autotest/resolve-dev-app-bin.sh" "$ROOT_DIR")"
fi
if [[ ! -x "$APP_BIN" ]]; then
  echo "ERROR: app binary not found or not executable: ${APP_BIN:-<empty>}" >&2
  echo "Run a development build first: rm -rf out release && pnpm dist:dev" >&2
  exit 1
fi

USER_DATA_DIR="$(mktemp -d "${TMPDIR:-/tmp}/onward-autotest-rename-restart-userdata.XXXXXXXX")"
OWNED_USER_DATA=1
FIXTURE_REPO="$(mktemp -d "${TMPDIR:-/tmp}/onward-autotest-rename-restart-repo.XXXXXXXX")"
OWNED_FIXTURE=1
# Canonicalise the fixture path (macOS /tmp -> /private/tmp symlink) so the OSC
# cwd, the git toplevel, and the stamped marker all agree on ONE form — a
# mismatch would make auto-follow's "cwd moved to another repo" guard misfire.
FIXTURE_REPO="$(cd "$FIXTURE_REPO" && pwd -P)"

# Build a deterministic git repo: one commit on a branch whose name is clearly
# NOT the custom name the test types, so a clobber-to-branch regression is
# unambiguous. Use -c flags so the fixture does not depend on global git config.
FIXTURE_BRANCH="restart-fixture-branch"
git -C "$FIXTURE_REPO" init -q
git -C "$FIXTURE_REPO" checkout -q -b "$FIXTURE_BRANCH"
git -C "$FIXTURE_REPO" -c user.email="autotest@onward.local" -c user.name="Onward Autotest" \
  commit -q --allow-empty -m "fixture init"
echo "[autotest] git fixture: $FIXTURE_REPO (branch=$FIXTURE_BRANCH)"
echo "[autotest] userData:    $USER_DATA_DIR"

rm -f "$SEED_LOG_FILE" "$VERIFY_LOG_FILE"

run_suite() {
  local suite_id="$1"
  local log_file="$2"
  local marker="$3"

  ONWARD_DEBUG=1 \
  ONWARD_AUTOTEST=1 \
  ONWARD_AUTOTEST_SUITE="$suite_id" \
  ONWARD_AUTOTEST_CWD="$FIXTURE_REPO" \
  ONWARD_AUTOTEST_EXIT=1 \
  ONWARD_USER_DATA_DIR="$USER_DATA_DIR" \
  "$APP_BIN" > "$log_file" 2>&1 || true

  if grep -q "\[AutoTest\] FAIL" "$log_file"; then
    echo "Rename-restart-survival autotest FAILED in suite '$suite_id'. Log: $log_file" >&2
    grep -n "\[AutoTest\] FAIL" "$log_file" >&2 || true
    tail -n 160 "$log_file" >&2
    exit 1
  fi

  if ! grep -q "$marker" "$log_file"; then
    echo "Rename-restart-survival autotest did not complete suite '$suite_id'. Log: $log_file" >&2
    tail -n 160 "$log_file" >&2
    exit 1
  fi
}

echo "Starting terminal rename restart-survival autotest..."

run_suite "terminal-rename-restart-survival-seed" "$SEED_LOG_FILE" \
  "suite-done:TerminalRenameRestartSurvivalSeed"
run_suite "terminal-rename-restart-survival-verify" "$VERIFY_LOG_FILE" \
  "suite-done:TerminalRenameRestartSurvivalVerify"

echo "Terminal rename restart-survival autotest passed."
echo "Seed log:   $SEED_LOG_FILE"
echo "Verify log: $VERIFY_LOG_FILE"
