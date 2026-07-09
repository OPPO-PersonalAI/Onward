#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2026 OPPO
# SPDX-License-Identifier: Apache-2.0
#
# Render Corruption Stress Autotest
#
# Drives the testRenderCorruptionStress suite (RCS-* assertions) which opens
# six terminal Tasks, captures a baseline WebGL pixel checksum per Task with
# a known checkpoint frame, then blasts atlas-hostile glyph load (CJK +
# emoji + box-drawing + 256-color ANSI) across all six in parallel for
# multiple iterations and re-checks the checksum.
#
# RCS-04 fails when post-stress checksums diverge from the baseline for the
# same content — that divergence IS the renderer corruption bug being
# investigated. On the first run against an un-fixed build this script is
# expected to exit non-zero.
#
# ONWARD_PERF_TRACE=1 is set so renderer:xterm.renderer.* lifecycle events
# land in traces/perf/ for post-hoc analysis.

set -euo pipefail

REPO_ROOT="${REPO_ROOT:-$(cd "$(dirname "$0")/../.." && pwd)}"
ROOT_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
source "$ROOT_DIR/test/autotest/resolve-dev-app-bin.sh"
APP_BIN="${1:-}"
LOG_FILE="${2:-$REPO_ROOT/traces/test-logs/render-corruption-stress-autotest.log}"
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
  # Sweep __autotest_* artefacts left in repo root by the test, per the
  # project-wide autotest cleanup contract.
  find "$ROOT_DIR" -maxdepth 1 -name '__autotest_*' -exec rm -rf {} + 2>/dev/null || true
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

if [[ -z "$APP_BIN" ]]; then
  APP_BIN="$("$ROOT_DIR/test/autotest/resolve-dev-app-bin.sh" "$ROOT_DIR")"
fi

if [[ -z "$USER_DATA_DIR" ]]; then
  USER_DATA_DIR="$(mktemp -d "${TMPDIR:-/tmp}/onward-autotest-render-corruption-stress.XXXXXXXX")"
  TMP_ROOT_OWNED=1
fi

if [[ ! -x "$APP_BIN" ]]; then
  echo "ERROR: app binary not found or not executable: $APP_BIN" >&2
  exit 1
fi

rm -f "$LOG_FILE"

echo "Starting render-corruption-stress autotest..."
echo "[autotest] tmp dir: $USER_DATA_DIR"
echo "[autotest] log: $LOG_FILE"

ONWARD_DEBUG=1 \
ONWARD_PERF_TRACE=1 \
ONWARD_REPO_ROOT="$ROOT_DIR" \
ONWARD_AUTOTEST=1 \
ONWARD_AUTOTEST_SUITE=render-corruption-stress \
ONWARD_AUTOTEST_CWD="$ROOT_DIR" \
ONWARD_AUTOTEST_EXIT=1 \
ONWARD_AUTOTEST_KEEP_TMP="${ONWARD_AUTOTEST_KEEP_TMP:-1}" \
ONWARD_USER_DATA_DIR="$USER_DATA_DIR" \
"$APP_BIN" > "$LOG_FILE" 2>&1 || true

if ! grep -q "RCS-05-suite-completed" "$LOG_FILE"; then
  echo "Render-corruption-stress autotest did not complete. Log: $LOG_FILE" >&2
  tail -n 200 "$LOG_FILE" >&2
  exit 1
fi

if grep -q "\[AutoTest\] FAIL" "$LOG_FILE"; then
  echo "Render-corruption-stress autotest reported FAIL — extracting details. Log: $LOG_FILE" >&2
  grep -E "FAIL RCS-|RCS:iter-result|suite-done:RenderCorruptionStress" "$LOG_FILE" | head -n 80 >&2
  exit 1
fi

echo "Render-corruption-stress autotest passed (no divergence detected). Log: $LOG_FILE"
