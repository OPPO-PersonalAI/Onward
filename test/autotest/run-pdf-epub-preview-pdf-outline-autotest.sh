#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2026 OPPO
# SPDX-License-Identifier: Apache-2.0
#
# pdf-outline group of the PDF/EPUB preview autotest (budget split).
#
# See run-pdf-epub-preview-pdf-autotest.sh for the split rationale. This
# runner covers the outlined-PDF fixture + unified OutlinePanel integration +
# PDF view-state memory + recent-files sections.
#
# Usage:
#   test/autotest/run-pdf-epub-preview-pdf-outline-autotest.sh [APP_BIN] [LOG_FILE] [USER_DATA_DIR]

set -euo pipefail

REPO_ROOT="${REPO_ROOT:-$(cd "$(dirname "$0")/../.." && pwd)}"
ROOT_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
source "$ROOT_DIR/test/autotest/resolve-dev-app-bin.sh"
APP_BIN="${1:-}"
LOG_FILE="${2:-$REPO_ROOT/traces/test-logs/pdf-epub-preview-pdf-outline-autotest.log}"
mkdir -p "$(dirname "$LOG_FILE")"
USER_DATA_DIR="${3:-}"

# Track whether this script created the user-data dir, so cleanup only removes
# self-created directories and never a caller-supplied path that may hold real data.
TMP_ROOT_OWNED=0

cleanup() {
  if [[ "$TMP_ROOT_OWNED" -eq 1 && -n "${USER_DATA_DIR:-}" && -d "$USER_DATA_DIR" ]]; then
    if [[ "${ONWARD_AUTOTEST_KEEP_TMP:-0}" == "1" ]]; then
      echo "[autotest] retained tmp for debugging: $USER_DATA_DIR"
    else
      onward_robust_rm "$USER_DATA_DIR"
    fi
  fi
  # The TS autotest writes __autotest_pdf_preview_outlined.pdf and
  # __autotest_pdf_epub_marker.txt into ONWARD_AUTOTEST_CWD (the repo root).
  # Sweep direct repo-root children matching `__autotest_*` so a mid-run
  # crash never leaks into the tree.
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
  USER_DATA_DIR="$(mktemp -d "${TMPDIR:-/tmp}/onward-autotest-pdf-epub-preview-pdf-outline.XXXXXXXX")"
  TMP_ROOT_OWNED=1
fi

if [[ ! -x "$APP_BIN" ]]; then
  echo "ERROR: app binary not found or not executable: $APP_BIN" >&2
  exit 1
fi

rm -f "$LOG_FILE"

echo "Starting PDF/EPUB preview autotest (group=pdf-outline)..."
echo "[autotest] tmp dir: $USER_DATA_DIR"
echo "App bin: $APP_BIN"

ONWARD_DEBUG=1 \
ONWARD_AUTOTEST=1 \
ONWARD_AUTOTEST_SUITE='pdf-epub-preview;group=pdf-outline' \
ONWARD_AUTOTEST_CWD="$ROOT_DIR" \
ONWARD_AUTOTEST_EXIT=1 \
ONWARD_TELEMETRY_RESET_CONSENT=1 \
ONWARD_USER_DATA_DIR="$USER_DATA_DIR" \
"$APP_BIN" > "$LOG_FILE" 2>&1 || true

if grep -q "\[AutoTest\] FAIL" "$LOG_FILE"; then
  echo "PDF/EPUB preview (group=pdf-outline) autotest failed. Log: $LOG_FILE" >&2
  tail -n 200 "$LOG_FILE" >&2
  exit 1
fi

if ! grep -q "suite-done:PdfEpubPreview" "$LOG_FILE"; then
  echo "PDF/EPUB preview (group=pdf-outline) autotest did not complete. Log: $LOG_FILE" >&2
  tail -n 200 "$LOG_FILE" >&2
  exit 1
fi

echo "PDF/EPUB preview (group=pdf-outline) autotest passed. Log: $LOG_FILE"
