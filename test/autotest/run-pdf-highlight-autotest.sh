#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2026 OPPO
# SPDX-License-Identifier: Apache-2.0
#
# PDF highlight annotation autotest (macOS / Linux).
#
# Covers the highlight layer end to end: creating a highlight from a selection,
# the palette latency budget the user signed off on, note editing, deletion,
# and — the assertions that matter most — writing annotations INTO the PDF and
# reading them back after a close/reopen cycle.
#
# This suite MODIFIES the PDF it opens. Highlights are stored inside the file
# (the storage strategy the user chose), so the runner works on a throwaway
# copy of the fixture and never the committed fixture itself.
#
# Why a separate runner from run-pdf-text-selection (5-step SOP Step 0): the
# failure modes are different and must not be confused. A corrupt write here is
# a persistence defect, not a selection defect, and giving it its own kill scope
# means a hang in the save path names itself.
#
# Windows parity: run-pdf-highlight-autotest.ps1. Any change here must be
# mirrored there in the same change set.
#
# Usage:
#   test/autotest/run-pdf-highlight-autotest.sh [APP_BIN] [LOG_FILE] [USER_DATA_DIR]

set -euo pipefail

REPO_ROOT="${REPO_ROOT:-$(cd "$(dirname "$0")/../.." && pwd)}"
ROOT_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
source "$ROOT_DIR/test/autotest/resolve-dev-app-bin.sh"
APP_BIN="${1:-}"
LOG_FILE="${2:-$REPO_ROOT/traces/test-logs/pdf-highlight-autotest.log}"
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
  USER_DATA_DIR="$(mktemp -d "${TMPDIR:-/tmp}/onward-autotest-pdf-highlight.XXXXXXXX")"
  TMP_ROOT_OWNED=1
fi

if [[ ! -x "$APP_BIN" ]]; then
  echo "ERROR: app binary not found or not executable: $APP_BIN" >&2
  exit 1
fi

# Shares the text-selection fixture: this suite needs the same known text at
# known positions, and a second near-identical PDF would be one more thing to
# keep in sync. A stale copy would silently change what the geometry
# assertions measure, so verify it here too.
echo "Verifying the shared PDF fixture..."
node "$ROOT_DIR/test/autotest/fixtures/pdf-text-selection-fixture-builder.mjs" --check

# The engine depends on private pdf.js patches (hidden-text marking, Arabic
# logical order). If a pdf.js bump dropped them, the hidden-text assertions
# below would fail with a confusing message; fail here with a clear one.
echo "Verifying pdf.js patches..."
node "$ROOT_DIR/scripts/apply-pdfjs-patches.mjs" --check

rm -f "$LOG_FILE"

echo "Starting PDF highlight autotest..."
echo "[autotest] tmp dir: $USER_DATA_DIR"
echo "App bin: $APP_BIN"

ONWARD_DEBUG=1 \
ONWARD_AUTOTEST=1 \
ONWARD_AUTOTEST_SUITE='pdf-highlight' \
ONWARD_AUTOTEST_CWD="$ROOT_DIR" \
ONWARD_AUTOTEST_EXIT=1 \
ONWARD_TELEMETRY_RESET_CONSENT=1 \
ONWARD_USER_DATA_DIR="$USER_DATA_DIR" \
"$APP_BIN" > "$LOG_FILE" 2>&1 || true

if grep -q "\[AutoTest\] FAIL" "$LOG_FILE"; then
  echo "PDF highlight autotest failed. Log: $LOG_FILE" >&2
  tail -n 200 "$LOG_FILE" >&2
  exit 1
fi

if ! grep -q "suite-done:PdfHighlight" "$LOG_FILE"; then
  echo "PDF highlight autotest did not complete. Log: $LOG_FILE" >&2
  tail -n 200 "$LOG_FILE" >&2
  exit 1
fi

echo "PDF highlight autotest passed. Log: $LOG_FILE"
