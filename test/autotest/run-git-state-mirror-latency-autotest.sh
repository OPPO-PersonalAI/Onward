#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2026 OPPO
# SPDX-License-Identifier: Apache-2.0

set -euo pipefail

REPO_ROOT="${REPO_ROOT:-$(cd "$(dirname "$0")/../.." && pwd)}"
ROOT_DIR="$REPO_ROOT"
source "$ROOT_DIR/test/autotest/resolve-dev-app-bin.sh"
# LATENCY_SUITE lets the split wrappers (static / gsm17 / gsm18 / injection) write
# distinct log files reusing this body; LATENCY_MODE selects which passes run.
# Defaults keep this runnable whole (baseline all-groups + the 3 injection passes).
LATENCY_SUITE="${LATENCY_SUITE:-git-state-mirror-latency}"
LATENCY_MODE="${LATENCY_MODE:-}"
APP_BIN="${1:-$(resolve_dev_app_bin "$ROOT_DIR" || true)}"
LOG_FILE="${2:-$REPO_ROOT/traces/test-logs/${LATENCY_SUITE}-autotest.log}"
mkdir -p "$(dirname "$LOG_FILE")"

if [[ -z "$APP_BIN" || ! -x "$APP_BIN" ]]; then
  echo "ERROR: app binary not found or not executable: ${APP_BIN:-<empty>}" >&2
  echo "Run a development build first: rm -rf out release && pnpm dist:dev" >&2
  exit 1
fi

# ---------------------------------------------------------------------------
# CLAUDE.md "Test fixture isolation": every runner gets a fresh user-data
# scratch dir and unpacks its own copy of the committed fixture tarballs into
# a per-run staging dir under ${TMPDIR:-/tmp}. The fixture tarballs themselves
# are committed under test/autotest/fixtures/git-state-mirror-latency/ and
# treated as read-only — we never write back into them.
# ---------------------------------------------------------------------------
USER_DATA_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/onward-gsm-userdata.XXXXXX")"
FIXTURE_TMP="$(mktemp -d "${TMPDIR:-/tmp}/onward-gsm-fixture.XXXXXX")"
FIXTURE_SRC="$REPO_ROOT/test/autotest/fixtures/git-state-mirror-latency"

cleanup() {
  rm -rf "$USER_DATA_ROOT" 2>/dev/null || true
  rm -rf "$FIXTURE_TMP" 2>/dev/null || true
  # Defence-in-depth: sweep any __autotest_* leftover at the repo root per
  # CLAUDE.md "__autotest_* sweep" hard rule.
  find "$REPO_ROOT" -maxdepth 1 -name '__autotest_*' -exec rm -rf {} \; 2>/dev/null || true
}
trap cleanup EXIT INT TERM

# ---------------------------------------------------------------------------
# Extract every fixture tarball from the committed fixture dir into the
# per-run staging dir. Tarballs were produced by
# `node test/autotest/build-git-state-mirror-latency-fixture.mjs` once at
# fixture-authoring time and are committed verbatim — extraction here is
# deterministic and side-effect-free.
# ---------------------------------------------------------------------------
for tarball in "$FIXTURE_SRC"/*.tar.gz; do
  if [[ ! -f "$tarball" ]]; then continue; fi
  tar xzf "$tarball" -C "$FIXTURE_TMP"
done

if [[ ! -d "$FIXTURE_TMP/repo-A" ]]; then
  echo "ERROR: fixture extraction failed; expected $FIXTURE_TMP/repo-A to exist" >&2
  echo "Source dir: $FIXTURE_SRC" >&2
  ls "$FIXTURE_SRC" >&2 || true
  exit 1
fi

# Pass the staging dir + manifest path to the autotest TS via env. The
# autotest reads ONWARD_AUTOTEST_FIXTURE_EXTRA as the manifest path (already
# bridged through the existing debug API) and walks repos relative to its
# `tempRoot` field.
MANIFEST_PATH="$FIXTURE_TMP/manifest.json"
# Hand NATIVE (forward-slash Windows) paths to native-node and the Electron app.
# Through Git Bash on Windows, $FIXTURE_SRC / $FIXTURE_TMP are MSYS paths
# (/d/Users/...); native node resolves those against the CWD drive
# (-> D:\d\Users\... -> ENOENT), which is exactly what sank this suite in full
# regression. `cygpath -m` yields `D:/Users/...` — JS-string-safe (no backslash
# escapes) AND accepted by native Windows node/Electron. cygpath is absent on
# macOS/Linux, so to_native is a no-op pass-through there. Bash filesystem ops
# above keep using the MSYS variants; only node/app consumers get the native form.
to_native() { if command -v cygpath >/dev/null 2>&1; then cygpath -m "$1"; else printf '%s' "$1"; fi; }
FIXTURE_SRC_N="$(to_native "$FIXTURE_SRC")"
FIXTURE_TMP_N="$(to_native "$FIXTURE_TMP")"
MANIFEST_PATH_N="$(to_native "$MANIFEST_PATH")"
node -e "
  const { readFileSync, writeFileSync } = require('fs')
  const src = require('path').join('$FIXTURE_SRC_N', 'manifest.json')
  const m = JSON.parse(readFileSync(src, 'utf8'))
  m.tempRoot = '$FIXTURE_TMP_N'
  writeFileSync('$MANIFEST_PATH_N', JSON.stringify(m, null, 2))
"

rm -f "$LOG_FILE"

{
  echo "Starting Git State Mirror latency autotest..."
  echo "  Binary:         $APP_BIN"
  echo "  Fixture src:    $FIXTURE_SRC"
  echo "  Fixture tmp:    $FIXTURE_TMP"
  echo "  Manifest:       $MANIFEST_PATH"
  echo "  User data root: $USER_DATA_ROOT"
  echo "  Log:            $LOG_FILE"
  echo ""
} >> "$LOG_FILE"

run_pass() {
  local label="$1"
  shift
  local user_data_dir="$USER_DATA_ROOT/$label"
  mkdir -p "$user_data_dir"
  {
    echo ""
    echo "=== Git State Mirror latency pass: $label ==="
  } >> "$LOG_FILE"
  env \
    ONWARD_DEBUG=1 \
    ONWARD_PERF_TRACE=1 \
    ONWARD_REPO_ROOT="$REPO_ROOT" \
    ONWARD_USER_DATA_DIR="$user_data_dir" \
    ONWARD_AUTOTEST=1 \
    ONWARD_AUTOTEST_SUITE=git-state-mirror-latency \
    ONWARD_AUTOTEST_CWD="$(to_native "$FIXTURE_TMP/repo-A")" \
    ONWARD_AUTOTEST_FIXTURE_EXTRA="$MANIFEST_PATH_N" \
    ONWARD_AUTOTEST_EXIT=1 \
    "$@" \
    "$APP_BIN" >> "$LOG_FILE" 2>&1 || true
}

# LATENCY_MODE selects which passes run so the baseline (which overran the 300s
# budget) can be split: 'static' / 'gsm17' / 'gsm18' run only that baseline group
# (via ONWARD_AUTOTEST_GSM_LATENCY_GROUP); 'injection' runs the 3 watcher-failure
# passes; '' (default) runs the whole suite. GSM-00 (fixture) + GSM-13 (trace
# marker) bracket every baseline group; the injection passes return before GSM-13.
case "$LATENCY_MODE" in
  static|gsm17|gsm18)
    run_pass "baseline-$LATENCY_MODE" ONWARD_AUTOTEST_GSM_LATENCY_GROUP="$LATENCY_MODE" ;;
  injection)
    run_pass "subscribe-failure" ONWARD_AUTOTEST_GSM_WATCHER_FAIL_SUBSCRIBE_ONCE=1
    run_pass "callback-failure" ONWARD_AUTOTEST_GSM_WATCHER_FAIL_CALLBACK_ONCE=1
    run_pass "silent-watcher" ONWARD_AUTOTEST_GSM_WATCHER_SILENT=1 ;;
  *)
    run_pass "baseline"
    run_pass "subscribe-failure" ONWARD_AUTOTEST_GSM_WATCHER_FAIL_SUBSCRIBE_ONCE=1
    run_pass "callback-failure" ONWARD_AUTOTEST_GSM_WATCHER_FAIL_CALLBACK_ONCE=1
    # Silent watcher (subscribed, no error, drops every event) — the production
    # failure mode. Proves the always-on reconcile heartbeat still refreshes (GSM-19).
    run_pass "silent-watcher" ONWARD_AUTOTEST_GSM_WATCHER_SILENT=1 ;;
esac

echo ""
echo "=== Test log (last 60 lines) ==="
tail -n 60 "$LOG_FILE"
echo ""

if grep -q "\[AutoTest\] FAIL" "$LOG_FILE"; then
  echo "Git State Mirror latency autotest failed ($LATENCY_SUITE)" >&2
  echo ""
  echo "=== Failure details ==="
  grep "\[AutoTest\] FAIL" "$LOG_FILE" >&2
  exit 1
fi

require_marker() {
  if ! grep -q "$1" "$LOG_FILE"; then
    echo "Missing $1 marker; $LATENCY_SUITE may not have run to completion" >&2
    tail -n 40 "$LOG_FILE" >&2
    exit 1
  fi
}

# Completion markers, gated by mode so each split runner only requires the
# markers its own group emits (a split runner that demanded every group's marker
# would always fail). GSM-00 + :done bracket every mode; the watcher-injection
# markers only exist when the injection passes run.
require_marker "GSM-00-fixture-loaded"
require_marker "git-state-mirror-latency:done"
case "$LATENCY_MODE" in
  static)
    require_marker "GSM-13-trace-marker-mirror-events-expected"
    require_marker "GSM-14-force-refresh-bumps-generation" ;;
  gsm17)
    require_marker "GSM-13-trace-marker-mirror-events-expected"
    require_marker "GSM-17-two-tasks-same-repo-consistent-status-cycles"
    require_marker "GSM-17-0-clean-after-real-commit" ;;
  gsm18)
    require_marker "GSM-13-trace-marker-mirror-events-expected"
    require_marker "GSM-18-cross-tab-two-tabs-commit-to-clean" ;;
  injection)
    require_marker "GSM-15-watcher-subscribe-failure-recovers"
    require_marker "GSM-16-watcher-callback-failure-recovers"
    require_marker "GSM-19-silent-watcher-reconcile-refresh"
    require_marker "autotest watcher failure injection active" ;;
  *)
    require_marker "GSM-13-trace-marker-mirror-events-expected"
    require_marker "GSM-14-force-refresh-bumps-generation"
    require_marker "GSM-17-two-tasks-same-repo-consistent-status-cycles"
    require_marker "GSM-17-0-clean-after-real-commit"
    require_marker "GSM-18-cross-tab-two-tabs-commit-to-clean"
    require_marker "GSM-15-watcher-subscribe-failure-recovers"
    require_marker "GSM-16-watcher-callback-failure-recovers"
    require_marker "GSM-19-silent-watcher-reconcile-refresh"
    require_marker "autotest watcher failure injection active" ;;
esac

echo "Git State Mirror latency autotest passed ($LATENCY_SUITE)"
echo "  Log: $LOG_FILE"
