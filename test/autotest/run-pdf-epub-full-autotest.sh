#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2026 OPPO
# SPDX-License-Identifier: Apache-2.0
#
# Run the complete PDF/EPUB autotest suite (preview + diff + history).
#
# MANUAL UMBRELLA (out of the regression gate since 2026-07-22): everything
# here is covered in the gate by the three preview group runners
# (run-pdf-epub-preview-{pdf,pdf-outline,epub}-autotest.sh) plus
# run-pdf-epub-diff-autotest.sh. Keep for one-session cross-suite runs; its
# 1200 s requirement cannot fit the 5-minute per-runner budget.
#
# Usage:
#   test/autotest/run-pdf-epub-full-autotest.sh [APP_BIN] [LOG_FILE] [USER_DATA_DIR]

set -euo pipefail

REPO_ROOT="${REPO_ROOT:-$(cd "$(dirname "$0")/../.." && pwd)}"
ROOT_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
source "$ROOT_DIR/test/autotest/resolve-dev-app-bin.sh"
APP_BIN="${1:-}"
LOG_FILE="${2:-$REPO_ROOT/traces/test-logs/pdf-epub-full-autotest.log}"
mkdir -p "$(dirname "$LOG_FILE")"
USER_DATA_DIR="${3:-}"

# Track whether this script created the user-data dir, so cleanup only removes
# self-created directories and never a caller-supplied path that may hold real data.
TMP_ROOT_OWNED=0
# Runner-owned temp dir for the deterministically-built PDF/EPUB fixture repo +
# manifest (shared with run-pdf-epub-diff-autotest.sh). Round-6: the diff suite
# now reads its repo from a Node-built fixture (no PTY) handed in via
# ONWARD_AUTOTEST_FIXTURE_EXTRA, so the full runner must build it too.
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
  # The TS autotests in this suite write __autotest_pdf_preview.pdf,
  # __autotest_epub_preview.epub, __autotest_pdf_epub_diff_repo/, etc. into
  # ONWARD_AUTOTEST_CWD (the repo root). Sweep direct repo-root children
  # matching `__autotest_*` so a mid-run crash never leaks into the tree.
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
  USER_DATA_DIR="$(mktemp -d "${TMPDIR:-/tmp}/onward-autotest-pdf-epub-full.XXXXXXXX")"
  TMP_ROOT_OWNED=1
fi

if [[ ! -x "$APP_BIN" ]]; then
  echo "ERROR: app binary not found or not executable: $APP_BIN" >&2
  exit 1
fi

# Build the one-commit + alt-working-tree diff fixture repo (execFileSync; no PTY).
FIXTURE_JSON="$(node "$REPO_ROOT/test/autotest/create-pdf-epub-diff-fixture.mjs" "$FIXTURE_REPO")"
MANIFEST_PATH="$(node -e 'process.stdout.write(JSON.parse(process.argv[1]).manifestPath)' "$FIXTURE_JSON")"

rm -f "$LOG_FILE"

echo "Starting PDF/EPUB full autotest (preview + diff + history)..."
echo "[autotest] tmp dir:      $USER_DATA_DIR"
echo "[autotest] fixture repo: $FIXTURE_REPO"
echo "[autotest] manifest:     $MANIFEST_PATH"
echo "App bin: $APP_BIN"

ONWARD_DEBUG=1 \
ONWARD_REPO_ROOT="$REPO_ROOT" \
ONWARD_AUTOTEST=1 \
ONWARD_AUTOTEST_SUITE=pdf-epub-preview,pdf-epub-diff \
ONWARD_AUTOTEST_CWD="$ROOT_DIR" \
ONWARD_AUTOTEST_FIXTURE_EXTRA="$MANIFEST_PATH" \
ONWARD_AUTOTEST_EXIT=1 \
ONWARD_TELEMETRY_RESET_CONSENT=1 \
ONWARD_USER_DATA_DIR="$USER_DATA_DIR" \
"$APP_BIN" > "$LOG_FILE" 2>&1 || true

if grep -q "\[AutoTest\] FAIL" "$LOG_FILE"; then
  echo "PDF/EPUB full autotest failed. Log: $LOG_FILE" >&2
  grep -A1 "\[AutoTest\] FAIL" "$LOG_FILE" | tail -n 80 >&2
  exit 1
fi

if ! grep -q "suite-done:PdfEpubPreview" "$LOG_FILE"; then
  echo "PDF/EPUB preview suite did not complete. Log: $LOG_FILE" >&2
  tail -n 200 "$LOG_FILE" >&2
  exit 1
fi

if ! grep -q "suite-done:PdfEpubDiff" "$LOG_FILE"; then
  echo "PDF/EPUB diff suite did not complete. Log: $LOG_FILE" >&2
  tail -n 200 "$LOG_FILE" >&2
  exit 1
fi

echo "PDF/EPUB full autotest passed. Log: $LOG_FILE"
