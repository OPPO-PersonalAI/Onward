#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2026 OPPO
# SPDX-License-Identifier: Apache-2.0
#
# Git Diff chaos-convergence autotest — the USER-PERSPECTIVE contract runner
# for the Agent Coding First workload.
#
# Spawns TWO processes, exactly like a real session:
#   1. the chaos writer (git-diff-chaos-writer.mjs) — an external "coding
#      agent" mutating the fixture repo in seed-deterministic random bursts
#      (atomic tmp+rename rewrites, new files, appends, deletes, git add),
#      then quiescing and capturing the ON-DISK truth outside the app;
#   2. the app, whose in-app suite (test-git-diff-chaos-convergence.ts) acts
#      as the user — opening Git Diff, clicking files, backing out to the
#      terminal and returning WHILE the writer runs — and asserts after each
#      quiesce that the UI converges to disk truth (file set + bodies) within
#      the convergence SLO, without a manual refresh.
#
# It intentionally does not care WHICH mechanism broke (watcher, cache,
# renderer memory): any user-visible staleness fails a cycle. The serialized
# mechanism suites (GDS-*) cannot construct write-during-read interleavings;
# this runner exists to make them routine.
#
# Reproducibility: writer op stream is fixed-seed (CHAOS_SEED env to explore
# other interleavings; failures always log the seed for exact replay).
# Budget: cycles×(burst+SLO+ack) ≈ 3×(12s+≤25s+2s) + boot ≈ ~150s worst case,
# inside the 280s watchdog / 300s orchestrator ceiling.

set -euo pipefail

REPO_ROOT="${REPO_ROOT:-$(cd "$(dirname "$0")/../.." && pwd)}"
ROOT_DIR="$REPO_ROOT"
source "$ROOT_DIR/test/autotest/resolve-dev-app-bin.sh"
APP_BIN="${1:-$(resolve_dev_app_bin "$ROOT_DIR" || true)}"
LOG_FILE="${2:-$REPO_ROOT/traces/test-logs/git-diff-chaos-convergence-autotest.log}"
mkdir -p "$(dirname "$LOG_FILE")"
WATCHDOG_SEC="${CHAOS_WATCHDOG_SEC:-280}"
CHAOS_SEED="${CHAOS_SEED:-20260712}"
CHAOS_CYCLES="${CHAOS_CYCLES:-3}"
CHAOS_BURST_MS="${CHAOS_BURST_MS:-12000}"

if [[ -z "$APP_BIN" || ! -x "$APP_BIN" ]]; then
  echo "ERROR: app binary not found or not executable: ${APP_BIN:-<empty>}" >&2
  echo "Run a development build first: rm -rf out release && pnpm dist:dev" >&2
  exit 1
fi

# Per CLAUDE.md "Test fixture isolation": fresh user-data dir per run.
RUN_TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/onward-git-diff-chaos-run.XXXXXX")"
USER_DATA_DIR="$RUN_TMP_DIR/user-data"
mkdir -p "$USER_DATA_DIR"

FIXTURE_JSON="$(node "$REPO_ROOT/test/autotest/create-git-diff-chaos-fixture.mjs")"
FIXTURE_TEMP_ROOT="$(node -e 'process.stdout.write(JSON.parse(process.argv[1]).tempRoot)' "$FIXTURE_JSON")"
REPO_FIXTURE="$(node -e 'process.stdout.write(JSON.parse(process.argv[1]).repoRoot)' "$FIXTURE_JSON")"
STATE_DIR="$(node -e 'process.stdout.write(JSON.parse(process.argv[1]).stateDir)' "$FIXTURE_JSON")"
MANIFEST_PATH="$(node -e 'process.stdout.write(JSON.parse(process.argv[1]).manifestPath)' "$FIXTURE_JSON")"

WRITER_PID=""
cleanup() {
  if [[ -n "$WRITER_PID" ]] && kill -0 "$WRITER_PID" 2>/dev/null; then
    kill "$WRITER_PID" 2>/dev/null || true
  fi
  rm -rf "$RUN_TMP_DIR" "$FIXTURE_TEMP_ROOT" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

rm -f "$LOG_FILE"

echo "Starting Git Diff chaos-convergence autotest..."
echo "  Binary:        $APP_BIN"
echo "  Fixture repo:  $REPO_FIXTURE"
echo "  State dir:     $STATE_DIR"
echo "  Seed:          $CHAOS_SEED  (cycles=$CHAOS_CYCLES, burst=${CHAOS_BURST_MS}ms)"
echo "  User data dir: $USER_DATA_DIR"
echo "  Watchdog:      ${WATCHDOG_SEC}s"
echo "  Log:           $LOG_FILE"
echo ""

# The external "agent": waits for the in-app suite's ack-0 before cycle 1, so
# every burst overlaps live UI interaction.
node "$REPO_ROOT/test/autotest/git-diff-chaos-writer.mjs" \
  --repo "$REPO_FIXTURE" --state "$STATE_DIR" \
  --seed "$CHAOS_SEED" --cycles "$CHAOS_CYCLES" --burst-ms "$CHAOS_BURST_MS" \
  >> "$RUN_TMP_DIR/chaos-writer.out" 2>&1 &
WRITER_PID=$!

APP_EXIT=0
TMPDIR="$RUN_TMP_DIR" \
ONWARD_DEBUG=1 \
ONWARD_PERF_TRACE=1 \
ONWARD_REPO_ROOT="$REPO_ROOT" \
ONWARD_USER_DATA_DIR="$USER_DATA_DIR" \
ONWARD_AUTOTEST=1 \
ONWARD_AUTOTEST_SUITE=git-diff-chaos-convergence \
ONWARD_AUTOTEST_CWD="$REPO_FIXTURE" \
ONWARD_AUTOTEST_FIXTURE_EXTRA="$MANIFEST_PATH" \
ONWARD_AUTOTEST_EXIT=1 \
node "$REPO_ROOT/test/autotest/run-with-timeout.mjs" "$WATCHDOG_SEC" "$APP_BIN" > "$LOG_FILE" 2>&1 || APP_EXIT=$?

echo ""
echo "=== Test log (last 60 lines) ==="
tail -n 60 "$LOG_FILE"
echo ""
echo "=== Chaos writer output (tail) ==="
tail -n 20 "$RUN_TMP_DIR/chaos-writer.out" 2>/dev/null || true
if [[ -f "$STATE_DIR/ops-log.jsonl" ]]; then
  echo "=== Chaos ops (count) ==="
  wc -l < "$STATE_DIR/ops-log.jsonl" || true
fi
echo ""

if grep -q "\[AutoTest\] FAIL" "$LOG_FILE"; then
  echo "Git Diff chaos-convergence autotest failed (seed=$CHAOS_SEED — replay with CHAOS_SEED=$CHAOS_SEED)" >&2
  echo ""
  echo "=== Failure details ==="
  grep "\[AutoTest\] FAIL" "$LOG_FILE" >&2
  exit 1
fi

if [[ "$APP_EXIT" -ne 0 ]]; then
  echo "Git Diff chaos-convergence autotest exited with code $APP_EXIT (watchdog or crash)" >&2
  exit "$APP_EXIT"
fi

MARKERS=(CHAOS-00-fixture-and-handshake CHAOS-99-oracle-sanity-after-refresh)
for ((c = 1; c <= CHAOS_CYCLES; c += 1)); do
  MARKERS+=("CHAOS-0${c}-converges-after-quiesce")
done
for marker in "${MARKERS[@]}"; do
  if ! grep -q "$marker" "$LOG_FILE"; then
    echo "Missing $marker; the suite may not have executed correctly" >&2
    tail -n 40 "$LOG_FILE" >&2
    exit 1
  fi
done

echo "Git Diff chaos-convergence autotest passed (seed=$CHAOS_SEED)"
echo "  Log: $LOG_FILE"
