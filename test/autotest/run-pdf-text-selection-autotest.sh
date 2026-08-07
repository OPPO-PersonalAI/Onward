#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2026 OPPO
# SPDX-License-Identifier: Apache-2.0
#
# PDF text-selection engine autotest (macOS / Linux).
#
# Covers `resources/pdfjs/app/text-selection.js` end to end: drag selection,
# the selection/clipboard agreement axiom, ligature integrity, hidden-text
# suppression, blocking annotations, and lifecycle cleanup across zoom and
# document switches.
#
# Why a separate runner rather than another section inside
# `run-pdf-epub-preview-pdf-autotest.sh` (5-step SOP Step 0): the preview suite
# was already split into three group runners to fit the 300 s per-runner
# budget, it uses a different fixture, and drag assertions repeat 5x each. Its
# own kill scope also means a hang here names itself instead of showing up as
# an opaque timeout on the preview suite.
#
# Windows parity: run-pdf-text-selection-autotest.ps1. Any change here must be
# mirrored there in the same change set.
#
# Usage:
#   test/autotest/run-pdf-text-selection-autotest.sh [APP_BIN] [LOG_FILE] [USER_DATA_DIR]

set -euo pipefail

REPO_ROOT="${REPO_ROOT:-$(cd "$(dirname "$0")/../.." && pwd)}"
ROOT_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
source "$ROOT_DIR/test/autotest/resolve-dev-app-bin.sh"
APP_BIN="${1:-}"
LOG_FILE="${2:-$REPO_ROOT/traces/test-logs/pdf-text-selection-autotest.log}"
mkdir -p "$(dirname "$LOG_FILE")"
USER_DATA_DIR="${3:-}"

TMP_ROOT_OWNED=0

cleanup() {
  if [[ "$TMP_ROOT_OWNED" -eq 1 && -n "${USER_DATA_DIR:-}" && -d "$USER_DATA_DIR" ]]; then
    if [[ "${ONWARD_AUTOTEST_KEEP_TMP:-0}" == "1" ]]; then
      echo "[autotest] retained tmp for debugging: $USER_DATA_DIR"
    else
      onward_robust_rm "$USER_DATA_DIR"
    fi
  fi
  # The TS suite copies its fixture into ONWARD_AUTOTEST_CWD (the repo root) as
  # __autotest_pdf_textsel.*. Sweep direct repo-root children matching
  # `__autotest_*` so a mid-run crash never leaks into the working tree.
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

if [[ -z "$USER_DATA_DIR" ]]; then
  USER_DATA_DIR="$(mktemp -d "${TMPDIR:-/tmp}/onward-autotest-pdf-text-selection.XXXXXXXX")"
  TMP_ROOT_OWNED=1
fi

if [[ ! -x "$APP_BIN" ]]; then
  echo "ERROR: app binary not found or not executable: $APP_BIN" >&2
  exit 1
fi

# The fixture is committed, but a stale copy would silently change what the
# geometry assertions are measuring. Verifying costs milliseconds.
echo "Verifying the text-selection PDF fixture..."
node "$ROOT_DIR/test/autotest/fixtures/pdf-text-selection-fixture-builder.mjs" --check

# The engine depends on private pdf.js patches (hidden-text marking, Arabic
# logical order). If a pdf.js bump dropped them, the hidden-text assertions
# below would fail with a confusing message; fail here with a clear one.
echo "Verifying pdf.js patches..."
node "$ROOT_DIR/scripts/apply-pdfjs-patches.mjs" --check

rm -f "$LOG_FILE"

echo "Starting PDF text-selection autotest..."
echo "[autotest] tmp dir: $USER_DATA_DIR"
echo "App bin: $APP_BIN"

ONWARD_DEBUG=1 \
ONWARD_AUTOTEST=1 \
ONWARD_AUTOTEST_SUITE='pdf-text-selection' \
ONWARD_AUTOTEST_CWD="$ROOT_DIR" \
ONWARD_AUTOTEST_EXIT=1 \
ONWARD_TELEMETRY_RESET_CONSENT=1 \
ONWARD_USER_DATA_DIR="$USER_DATA_DIR" \
"$APP_BIN" > "$LOG_FILE" 2>&1 || true

if grep -q "\[AutoTest\] FAIL" "$LOG_FILE"; then
  echo "PDF text-selection autotest failed. Log: $LOG_FILE" >&2
  tail -n 200 "$LOG_FILE" >&2
  exit 1
fi

if ! grep -q "suite-done:PdfTextSelection" "$LOG_FILE"; then
  echo "PDF text-selection autotest did not complete. Log: $LOG_FILE" >&2
  tail -n 200 "$LOG_FILE" >&2
  exit 1
fi

echo "PDF text-selection autotest passed. Log: $LOG_FILE"
