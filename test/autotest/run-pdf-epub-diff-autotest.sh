#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2026 OPPO
# SPDX-License-Identifier: Apache-2.0
#
# Run the PDF/EPUB Git Diff + Git History autotest suite.
#
# Round-6 fix: the throwaway fixture repo is built DETERMINISTICALLY by
# create-pdf-epub-diff-fixture.mjs (Node, execFileSync, no PTY,
# core.autocrlf=false) into a runner-owned temp dir, and its manifest path is
# handed to the app via ONWARD_AUTOTEST_FIXTURE_EXTRA. The previous version
# built the repo by writing a multi-step PowerShell/bash mega-command into the
# live PTY; on an EDR-throttled Windows host the fixture .git was never created
# inside the renderer's wait window (round-5 log: repo-ready:setup:timeout
# { attempts: 109, isGitRepo: false, files: [] }), failing git-diff-repo-ready
# and aborting the suite. Building the repo here removes that failure class —
# the product's getDiff is fine; the PTY fixture build was not robust under EDR.
#
# Usage:
#   test/autotest/run-pdf-epub-diff-autotest.sh [APP_BIN] [LOG_FILE] [USER_DATA_DIR]

set -euo pipefail

REPO_ROOT="${REPO_ROOT:-$(cd "$(dirname "$0")/../.." && pwd)}"
ROOT_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
source "$ROOT_DIR/test/autotest/resolve-dev-app-bin.sh"
APP_BIN="${1:-}"
LOG_FILE="${2:-$REPO_ROOT/traces/test-logs/pdf-epub-diff-autotest.log}"
mkdir -p "$(dirname "$LOG_FILE")"
USER_DATA_DIR="${3:-}"

# Track whether this script created the user-data dir, so cleanup only removes
# self-created directories and never a caller-supplied path that may hold real data.
TMP_ROOT_OWNED=0
# Runner-owned temp dir for the deterministically-built fixture repo + manifest.
FIXTURE_TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/onward-pdf-epub-fixture.XXXXXXXX")"
FIXTURE_REPO="$FIXTURE_TMP_DIR/pdf-epub-repo"

cleanup() {
  if [[ "$TMP_ROOT_OWNED" -eq 1 && -n "${USER_DATA_DIR:-}" && -d "$USER_DATA_DIR" ]]; then
    if [[ "${ONWARD_AUTOTEST_KEEP_TMP:-0}" == "1" ]]; then
      echo "[autotest] retained tmp for debugging: $USER_DATA_DIR"
    else
      onward_robust_rm "$USER_DATA_DIR"
    fi
  fi
  rm -rf "$FIXTURE_TMP_DIR" 2>/dev/null || true
  # Defence-in-depth: sweep any legacy __autotest_* leftover the TS may have
  # written into ONWARD_AUTOTEST_CWD (the repo root) on a mid-run crash.
  shopt -s nullglob
  local leftovers=("$REPO_ROOT"/__autotest_*)
  shopt -u nullglob
  if [[ ${#leftovers[@]} -gt 0 ]]; then
    onward_robust_rm "${leftovers[@]}"
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
  USER_DATA_DIR="$(mktemp -d "${TMPDIR:-/tmp}/onward-autotest-pdf-epub-diff.XXXXXXXX")"
  TMP_ROOT_OWNED=1
fi

if [[ ! -x "$APP_BIN" ]]; then
  echo "ERROR: app binary not found or not executable: $APP_BIN" >&2
  exit 1
fi

# The annotated pair (annotation-diff panel assertions) must match its
# builder byte-for-byte before it enters the fixture repo.
echo "Verifying the annotated PDF fixture pair..."
node "$REPO_ROOT/test/autotest/fixtures/pdf-annotation-diff-fixture-builder.mjs" --check

# Build the one-commit + alt-working-tree fixture repo (execFileSync; no PTY).
FIXTURE_JSON="$(node "$REPO_ROOT/test/autotest/create-pdf-epub-diff-fixture.mjs" "$FIXTURE_REPO")"
MANIFEST_PATH="$(node -e 'process.stdout.write(JSON.parse(process.argv[1]).manifestPath)' "$FIXTURE_JSON")"

rm -f "$LOG_FILE"

echo "Starting PDF/EPUB diff+history autotest..."
echo "[autotest] tmp dir:     $USER_DATA_DIR"
echo "[autotest] fixture repo: $FIXTURE_REPO"
echo "[autotest] manifest:     $MANIFEST_PATH"
echo "App bin: $APP_BIN"

ONWARD_DEBUG=1 \
ONWARD_REPO_ROOT="$REPO_ROOT" \
ONWARD_AUTOTEST=1 \
ONWARD_AUTOTEST_SUITE=pdf-epub-diff \
ONWARD_AUTOTEST_CWD="$ROOT_DIR" \
ONWARD_AUTOTEST_FIXTURE_EXTRA="$MANIFEST_PATH" \
ONWARD_AUTOTEST_EXIT=1 \
ONWARD_TELEMETRY_RESET_CONSENT=1 \
ONWARD_USER_DATA_DIR="$USER_DATA_DIR" \
"$APP_BIN" > "$LOG_FILE" 2>&1 || true

if grep -q "\[AutoTest\] FAIL" "$LOG_FILE"; then
  echo "PDF/EPUB diff autotest failed. Log: $LOG_FILE" >&2
  tail -n 250 "$LOG_FILE" >&2
  exit 1
fi

if ! grep -q "suite-done:PdfEpubDiff" "$LOG_FILE"; then
  echo "PDF/EPUB diff autotest did not complete. Log: $LOG_FILE" >&2
  tail -n 250 "$LOG_FILE" >&2
  exit 1
fi

echo "PDF/EPUB diff autotest passed. Log: $LOG_FILE"
