#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2026 OPPO
# SPDX-License-Identifier: Apache-2.0
#
# Git Diff mutation-timing matrix — shared runner body (BUG-0004).
#
# Asks the question the 2026-07-26 diagnostic bundle exposed, generalised:
# when a coding agent rewrites a file at an ARBITRARY moment relative to the
# Git Diff lifecycle, does the viewport and the collapse state still describe
# what is on disk?
#
# The matrix walks eight phases, partitioned into three groups by
# ONWARD_AUTOTEST_MT_GROUP so each runner stays inside the 300 s per-runner
# ceiling (see test/README.md § 3):
#
#   closed       P1 never-opened            P2 closed round-trip (both directions)
#   load-reveal  P3 during-load             P4 during-select (the 47 ms window)
#   viewing      P5 while-viewing  P6 after-scroll  P7 during-close  P8 burst
#
# Run WHOLE (all three groups in one app session) by leaving MT_GROUP empty —
# useful locally, too slow for the gate.
#
# Cross-platform note: this runner is bash (macOS / Linux). The driver it
# invokes (src/autotest/test-git-diff-mutation-timing.ts) and the fixture
# builder (create-git-diff-mutation-timing-fixture.mjs) are platform-neutral —
# Node fs/path APIs only, no POSIX shell — so a .ps1 sibling can be added
# without touching either. The fixture pins core.autocrlf=false so a Windows
# checkout cannot re-normalise the committed LF blobs and fake dirty state.

set -euo pipefail

REPO_ROOT="${REPO_ROOT:-$(cd "$(dirname "$0")/../.." && pwd)}"
ROOT_DIR="$REPO_ROOT"
source "$ROOT_DIR/test/autotest/resolve-dev-app-bin.sh"
APP_BIN="${1:-$(resolve_dev_app_bin "$ROOT_DIR" || true)}"

MT_SUITE="${MT_SUITE:-git-diff-mutation-timing}"
MT_GROUP="${MT_GROUP:-}"
LOG_FILE="${2:-$REPO_ROOT/traces/test-logs/${MT_SUITE}-autotest.log}"
mkdir -p "$(dirname "$LOG_FILE")"
WATCHDOG_SEC="${MT_WATCHDOG_SEC:-280}"

if [[ -z "$APP_BIN" || ! -x "$APP_BIN" ]]; then
  echo "ERROR: app binary not found or not executable: ${APP_BIN:-<empty>}" >&2
  echo "Run a development build first: rm -rf out release && pnpm dist:dev" >&2
  exit 1
fi

# Per CLAUDE.md "Test fixture isolation": fresh user-data dir per run, fixture
# repo in the OS temp dir, everything removed on EXIT (pass, fail or signal).
RUN_TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/onward-git-diff-mt-run.XXXXXX")"
USER_DATA_DIR="$RUN_TMP_DIR/user-data"
mkdir -p "$USER_DATA_DIR"

FIXTURE_JSON="$(node "$REPO_ROOT/test/autotest/create-git-diff-mutation-timing-fixture.mjs")"
FIXTURE_TEMP_ROOT="$(node -e 'process.stdout.write(JSON.parse(process.argv[1]).tempRoot)' "$FIXTURE_JSON")"
REPO_FIXTURE="$(node -e 'process.stdout.write(JSON.parse(process.argv[1]).repoRoot)' "$FIXTURE_JSON")"
MANIFEST_PATH="$(node -e 'process.stdout.write(JSON.parse(process.argv[1]).manifestPath)' "$FIXTURE_JSON")"

cleanup() {
  rm -rf "$RUN_TMP_DIR" "$FIXTURE_TEMP_ROOT" 2>/dev/null || true
  # Legacy autotests still write __autotest_* entries into the repo root; sweep
  # direct children so a crash mid-run cannot leave the working tree dirty.
  find "$REPO_ROOT" -maxdepth 1 -name '__autotest_*' -exec rm -rf {} + 2>/dev/null || true
}
trap cleanup EXIT INT TERM

rm -f "$LOG_FILE"

echo "Starting Git Diff mutation-timing autotest..."
echo "  Binary:        $APP_BIN"
echo "  Suite:         $MT_SUITE"
echo "  Phase group:   ${MT_GROUP:-<all>}"
echo "  Fixture repo:  $REPO_FIXTURE"
echo "  User data dir: $USER_DATA_DIR"
echo "  Watchdog:      ${WATCHDOG_SEC}s"
echo "  Log:           $LOG_FILE"
echo ""

APP_EXIT=0
TMPDIR="$RUN_TMP_DIR" \
ONWARD_DEBUG=1 \
ONWARD_PERF_TRACE=1 \
ONWARD_REPO_ROOT="$REPO_ROOT" \
ONWARD_USER_DATA_DIR="$USER_DATA_DIR" \
ONWARD_AUTOTEST=1 \
ONWARD_AUTOTEST_SUITE=git-diff-mutation-timing \
ONWARD_AUTOTEST_MT_GROUP="$MT_GROUP" \
ONWARD_AUTOTEST_CWD="$REPO_FIXTURE" \
ONWARD_AUTOTEST_FIXTURE_EXTRA="$MANIFEST_PATH" \
ONWARD_AUTOTEST_EXIT=1 \
node "$REPO_ROOT/test/autotest/run-with-timeout.mjs" "$WATCHDOG_SEC" "$APP_BIN" > "$LOG_FILE" 2>&1 || APP_EXIT=$?

echo ""
echo "=== Test log (last 60 lines) ==="
tail -n 60 "$LOG_FILE"
echo ""

if grep -q "\[AutoTest\] FAIL" "$LOG_FILE"; then
  echo "Git Diff mutation-timing autotest failed (group=${MT_GROUP:-<all>})" >&2
  echo ""
  echo "=== Failure details ===" >&2
  grep "\[AutoTest\] FAIL" "$LOG_FILE" >&2
  exit 1
fi

if [[ "$APP_EXIT" -ne 0 ]]; then
  echo "Git Diff mutation-timing autotest exited with code $APP_EXIT (watchdog or crash)" >&2
  exit "$APP_EXIT"
fi

# Marker check: a suite that silently skipped its group would otherwise pass by
# producing no FAIL lines at all.
case "$MT_GROUP" in
  closed)      MARKERS=(MT-00-fixture-loaded MT-01-cold-open-after-change-reveals-current-line MT-02-forward-closed-round-trip-reveals-current-line MT-02-backward-closed-round-trip-reveals-current-line) ;;
  load-reveal) MARKERS=(MT-00-fixture-loaded MT-03-change-during-load-settles-on-current-models MT-04-change-during-select-window-settles-current) ;;
  viewing)     MARKERS=(MT-00-fixture-loaded MT-05-change-while-viewing-keeps-models-current MT-06-change-after-scroll-away-keeps-models-current MT-07-change-during-close-reveals-current-on-reopen MT-08-rapid-burst-stays-current-and-bounded) ;;
  *)           MARKERS=(MT-00-fixture-loaded MT-01-cold-open-after-change-reveals-current-line MT-08-rapid-burst-stays-current-and-bounded) ;;
esac
for marker in "${MARKERS[@]}"; do
  if ! grep -q "$marker" "$LOG_FILE"; then
    echo "Missing $marker; the suite may not have executed correctly" >&2
    tail -n 40 "$LOG_FILE" >&2
    exit 1
  fi
done

echo "Git Diff mutation-timing autotest passed (group=${MT_GROUP:-<all>})"
echo "  Log: $LOG_FILE"
