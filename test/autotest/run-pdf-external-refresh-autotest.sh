#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2026 OPPO
# SPDX-License-Identifier: Apache-2.0
#
# PDF external-change auto-refresh autotest (macOS / Linux).
#
# Covers the whole refresh pipeline: fs.watch (binary mode) → main-process
# fingerprint settle (self-write suppression incl. the atomic-replace rename
# path) → IPC → PdfReader → in-place viewer reload with view-state
# preservation → three-way rebase merge of unsaved local annotations →
# autosave retry convergence. Also: partial-write silent deferral and
# reopen-after-external-change freshness.
#
# Why a separate runner (5-step SOP Step 0): this suite crosses the
# watcher × viewer subsystem boundary — no existing PDF runner touches the
# main-process file watcher — and it owns a distinct fixture lifecycle (a
# throwaway project root in the OS tempdir, mutated externally mid-test).
#
# Fixture isolation: the project root the app opens IS a mktemp directory this
# runner owns; the committed fixture is copied in before launch. The TS suite
# therefore never writes into the repo working tree (no __autotest_* sweep
# against the repo root is needed, but we keep one as defence-in-depth).
#
# Windows parity: run-pdf-external-refresh-autotest.ps1. Any change here must
# be mirrored there in the same change set.
#
# Usage:
#   test/autotest/run-pdf-external-refresh-autotest.sh [APP_BIN] [LOG_FILE] [USER_DATA_DIR]

set -euo pipefail

REPO_ROOT="${REPO_ROOT:-$(cd "$(dirname "$0")/../.." && pwd)}"
ROOT_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
source "$ROOT_DIR/test/autotest/resolve-dev-app-bin.sh"
APP_BIN="${1:-}"
LOG_FILE="${2:-$REPO_ROOT/traces/test-logs/pdf-external-refresh-autotest.log}"
mkdir -p "$(dirname "$LOG_FILE")"
USER_DATA_DIR="${3:-}"

TMP_ROOT_OWNED=0
PROJECT_ROOT=""

cleanup() {
  if [[ -n "$PROJECT_ROOT" && -d "$PROJECT_ROOT" ]]; then
    onward_robust_rm "$PROJECT_ROOT"
  fi
  if [[ "$TMP_ROOT_OWNED" -eq 1 && -n "${USER_DATA_DIR:-}" && -d "$USER_DATA_DIR" ]]; then
    if [[ "${ONWARD_AUTOTEST_KEEP_TMP:-0}" == "1" ]]; then
      echo "[autotest] retained tmp for debugging: $USER_DATA_DIR"
    else
      onward_robust_rm "$USER_DATA_DIR"
    fi
  fi
  # Defence-in-depth: this suite is designed not to touch the repo root, but a
  # regression that does must never leak into the working tree.
  shopt -s nullglob
  local leftovers=("$REPO_ROOT"/__autotest_*)
  shopt -u nullglob
  if [[ ${#leftovers[@]} -gt 0 ]]; then
    onward_robust_rm "${leftovers[@]}"
  fi
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

if [[ -z "$APP_BIN" ]]; then
  APP_BIN="$("$ROOT_DIR/test/autotest/resolve-dev-app-bin.sh" "$ROOT_DIR")"
fi

# Strip a trailing slash from TMPDIR before composing paths: macOS ships
# TMPDIR with one, and the doubled separator it produces ('/T//onward-…')
# travels into ONWARD_AUTOTEST_CWD and every path comparison downstream.
TMP_BASE="${TMPDIR:-/tmp}"
TMP_BASE="${TMP_BASE%/}"

if [[ -z "$USER_DATA_DIR" ]]; then
  USER_DATA_DIR="$(mktemp -d "$TMP_BASE/onward-autotest-pdf-extrefresh.XXXXXXXX")"
  TMP_ROOT_OWNED=1
fi

if [[ ! -x "$APP_BIN" ]]; then
  echo "ERROR: app binary not found or not executable: $APP_BIN" >&2
  exit 1
fi

echo "Verifying the text-selection PDF fixture..."
node "$ROOT_DIR/test/autotest/fixtures/pdf-text-selection-fixture-builder.mjs" --check

echo "Verifying pdf.js patches..."
node "$ROOT_DIR/scripts/apply-pdfjs-patches.mjs" --check

# The throwaway project root the app opens. The suite mutates sample.pdf
# "externally" through the debug write channel; nothing here touches the repo.
PROJECT_ROOT="$(mktemp -d "$TMP_BASE/onward-autotest-pdf-extrefresh-root.XXXXXXXX")"
cp "$ROOT_DIR/test/autotest/fixtures/pdf-text-selection/onward-textsel.pdf" "$PROJECT_ROOT/sample.pdf"

rm -f "$LOG_FILE"

echo "Starting PDF external-refresh autotest..."
echo "[autotest] tmp dir: $USER_DATA_DIR"
echo "[autotest] project root: $PROJECT_ROOT"
echo "App bin: $APP_BIN"

ONWARD_DEBUG=1 \
ONWARD_AUTOTEST=1 \
ONWARD_AUTOTEST_SUITE='pdf-external-refresh' \
ONWARD_AUTOTEST_CWD="$PROJECT_ROOT" \
ONWARD_AUTOTEST_EXIT=1 \
ONWARD_TELEMETRY_RESET_CONSENT=1 \
ONWARD_USER_DATA_DIR="$USER_DATA_DIR" \
ONWARD_REPO_ROOT="$ROOT_DIR" \
"$APP_BIN" > "$LOG_FILE" 2>&1 || true

if grep -q "\[AutoTest\] FAIL" "$LOG_FILE"; then
  echo "PDF external-refresh autotest failed. Log: $LOG_FILE" >&2
  tail -n 200 "$LOG_FILE" >&2
  exit 1
fi

if ! grep -q "suite-done:PdfExternalRefresh" "$LOG_FILE"; then
  echo "PDF external-refresh autotest did not complete. Log: $LOG_FILE" >&2
  tail -n 200 "$LOG_FILE" >&2
  exit 1
fi

echo "PDF external-refresh autotest passed. Log: $LOG_FILE"
