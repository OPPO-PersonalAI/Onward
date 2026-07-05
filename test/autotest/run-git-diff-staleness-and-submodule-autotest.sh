#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2026 OPPO
# SPDX-License-Identifier: Apache-2.0

set -euo pipefail

REPO_ROOT="${REPO_ROOT:-$(cd "$(dirname "$0")/../.." && pwd)}"
ROOT_DIR="$REPO_ROOT"
source "$ROOT_DIR/test/autotest/resolve-dev-app-bin.sh"
# ---------------------------------------------------------------------------
# Class-2 split (oversized case). The whole GDS-* suite forks ~69 git processes
# per Git Diff round-trip and is EDR-taxed to ~6-11 s/diff; the dominant cost is
# the diff LOAD itself (~7-35 s/scenario — measured sincePreviousRecordMs ran
# 6.8/7.6/9.2/13/16/17/18/34.6 s). The full suite TIMED OUT, and so did the 4-way
# split (round-4: all four sub-runners hit ~283-284 s, their 280 s watchdog),
# because diff-ux summed ~235 s and model-sync ~154 s of irreducible diff work
# alone. The suite is now cut SIX ways, balanced BY MEASURED PER-CASE COST so every
# sub-runner is confidently < 220 s (each group ~96-122 s of case-work + ~45 s
# fixed overhead = ~141-167 s; ≥53 s margin to 220 s, ≥73 s to the 290 s watchdog).
# This body is parameterised by GDS_GROUP so the six thin wrappers select a
# balanced slice each, mirroring the GitStateMirror-latency LATENCY_MODE split.
# GDS_SUITE gives each wrapper a distinct log/suite name; defaults keep this
# runnable WHOLE (GDS_GROUP='' = all). The heaviest singles are spread one-per-group
# so no group clusters them (GDS-17→reentry, GDS-31→presentation, GDS-19/43→model-
# sync, GDS-20→reentry), and the two atomic UI blocks (BlockA=GDS-21..29,
# BlockE=GDS-35..39) each own their own ux group.
#   GDS_GROUP='submodule'           — parent/sub c/m/u filter + nested/uninitialized
#                                     + staged-pointer (GDS-01..05,13,14). ~20s work.
#   GDS_GROUP='submodule-refresh'   — closed-parent submodule freshness, GDS-46 only
#                                     (cold v1 + warm v2 submodule diff). Carved off
#                                     because cold v1 runs ~94s+ under EDR and overran
#                                     the watchdog folded into 'submodule'.
#   GDS_GROUP='staleness'           — request-cache invalidation / watcher-driven
#                                     freshness / concurrent converge + Project-
#                                     Editor-save freshness (GDS-06..10,45). ~122s.
#   GDS_GROUP='reentry'             — subdir-scope watch + re-entry-content body
#                                     refresh + re-entry-latency trend + draft-
#                                     preserved-on-refresh (GDS-15,17,18,20). ~114s.
#   GDS_GROUP='diff-ux-presentation'— VS Code resource / split / hunk / refresh
#                                     atomic UI block + blank-until-file-selected
#                                     (GDS-21..29 block, 31). ~96s work.
#   GDS_GROUP='diff-ux-tree'        — tree icons / flat-tree / groups / editor-jump
#                                     atomic block + prefetch-body + partial-stage
#                                     (GDS-35..39 block, 32, 33). ~113s work.
#   GDS_GROUP='model-sync'          — open-view selected-body refresh + repeated
#                                     same-file refresh + external stable-status
#                                     Monaco model sync (GDS-19,43,44). ~119s work.
#   GDS_GROUP=''                    — default: run every group (whole suite).
# ---------------------------------------------------------------------------
GDS_SUITE="${GDS_SUITE:-git-diff-staleness-and-submodule}"
GDS_GROUP="${GDS_GROUP:-}"
APP_BIN="${1:-$(resolve_dev_app_bin "$ROOT_DIR" || true)}"
LOG_FILE="${2:-$REPO_ROOT/traces/test-logs/${GDS_SUITE}-autotest.log}"
mkdir -p "$(dirname "$LOG_FILE")"
# Watchdog: each split slice must finish inside the orchestrator's 300 s budget,
# so the wrappers run with a 280 s in-app watchdog (just under 300 s, leaving the
# orchestrator's own kill as the outer fence). Each slice is sized to ~141-167 s of
# real work, so the 280 s watchdog is a backstop, not the design target — a slice
# that approaches 280 s is a regression to root-cause, not a budget to widen. The
# WHOLE-suite default stays 570 s
# (the suite is over-budget when run whole and is meant to be run split in the
# gate; the 570 s default only keeps the runnable-whole path from self-killing
# before the historical 600 s orchestrator override). Overridable via GDS_WATCHDOG_SEC.
if [[ -n "$GDS_GROUP" ]]; then
  WATCHDOG_SEC="${GDS_WATCHDOG_SEC:-280}"
else
  WATCHDOG_SEC="${GDS_WATCHDOG_SEC:-570}"
fi

if [[ -z "$APP_BIN" || ! -x "$APP_BIN" ]]; then
  echo "ERROR: app binary not found or not executable: ${APP_BIN:-<empty>}" >&2
  echo "Run a development build first: rm -rf out release && pnpm dist:dev" >&2
  exit 1
fi

# ---------------------------------------------------------------------------
# Per the CLAUDE.md "Test fixture isolation" hard rule, every runner
# must point ONWARD_USER_DATA_DIR at a fresh mktemp dir so persisted state
# (active subpage, terminal cwds, ProjectEditor scope state, etc.) from a
# previous run can't leak in and turn unrelated PRs into "test broke things"
# investigations.
# ---------------------------------------------------------------------------
RUN_TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/onward-${GDS_SUITE}-run.XXXXXX")"
USER_DATA_DIR="$RUN_TMP_DIR/user-data"
mkdir -p "$USER_DATA_DIR"

# Snapshot pre-existing trace chunks so post-mortem checks only accept events
# produced by this runner invocation. `latest.txt` points at the chunk
# directory, and shutdown can create tiny final chunks after the useful event
# chunks, so checking only the newest file is not reliable.
TRACE_DIR="$REPO_ROOT/traces/perf"
TRACE_BEFORE_FILE="$RUN_TMP_DIR/main-traces-before.txt"
TRACE_START_MARKER="$RUN_TMP_DIR/trace-start.marker"
mkdir -p "$TRACE_DIR"
find "$TRACE_DIR" -maxdepth 1 -type f -name 'perf-*.jsonl' -print | sort > "$TRACE_BEFORE_FILE"
: > "$TRACE_START_MARKER"

# ---------------------------------------------------------------------------
# Build the fixture under test/autotest/fixtures/git-diff-staleness-and-submodule/runtime/
# (wipe-and-recreate semantics — see the fixture builder header). The runtime
# dir is gitignored and regenerated on every run, so we don't add it to the
# cleanup trap; only the per-run user-data scratch dir gets removed below.
# ---------------------------------------------------------------------------
FIXTURE_JSON="$(node "$REPO_ROOT/test/autotest/create-git-diff-staleness-fixture.mjs")"
TEMP_ROOT="$(node -e 'process.stdout.write(JSON.parse(process.argv[1]).tempRoot)' "$FIXTURE_JSON")"
CLEAN_ROOT="$(node -e 'process.stdout.write(JSON.parse(process.argv[1]).cleanRoot)' "$FIXTURE_JSON")"
MANIFEST_PATH="$(node -e 'process.stdout.write(JSON.parse(process.argv[1]).manifestPath)' "$FIXTURE_JSON")"

cleanup() {
  rm -rf "$RUN_TMP_DIR" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

rm -f "$LOG_FILE"

echo "Starting Git Diff staleness + submodule filter autotest..."
echo "  Binary:        $APP_BIN"
echo "  Suite:         $GDS_SUITE"
echo "  GDS group:     ${GDS_GROUP:-<all>}"
echo "  Clean repo:    $CLEAN_ROOT"
echo "  Manifest:      $MANIFEST_PATH"
echo "  User data dir: $USER_DATA_DIR"
echo "  Run temp dir:  $RUN_TMP_DIR"
echo "  Watchdog:      ${WATCHDOG_SEC}s"
echo "  Log:           $LOG_FILE"
echo ""

# NOTE: ONWARD_AUTOTEST_SUITE selects which autotest TS function the renderer
# runs and MUST stay 'git-diff-staleness-and-submodule' for every group — only
# the on-disk log / GDS_SUITE name changes. ONWARD_AUTOTEST_GDS_GROUP partitions
# the cases inside that single TS suite ('' = whole suite).
APP_EXIT=0
TMPDIR="$RUN_TMP_DIR" \
ONWARD_DEBUG=1 \
ONWARD_PERF_TRACE=1 \
ONWARD_REPO_ROOT="$REPO_ROOT" \
ONWARD_USER_DATA_DIR="$USER_DATA_DIR" \
ONWARD_AUTOTEST=1 \
ONWARD_AUTOTEST_SUITE=git-diff-staleness-and-submodule \
ONWARD_AUTOTEST_GDS_GROUP="$GDS_GROUP" \
ONWARD_AUTOTEST_CWD="$CLEAN_ROOT" \
ONWARD_AUTOTEST_FIXTURE_EXTRA="$MANIFEST_PATH" \
ONWARD_AUTOTEST_EXIT=1 \
node "$REPO_ROOT/test/autotest/run-with-timeout.mjs" "$WATCHDOG_SEC" "$APP_BIN" > "$LOG_FILE" 2>&1 || APP_EXIT=$?

echo ""
echo "=== Test log (last 80 lines) ==="
tail -n 80 "$LOG_FILE"
echo ""

if grep -q "\[AutoTest\] FAIL" "$LOG_FILE"; then
  echo "Git Diff staleness autotest failed (${GDS_SUITE}, group ${GDS_GROUP:-<all>})" >&2
  echo ""
  echo "=== Failure details ==="
  grep "\[AutoTest\] FAIL" "$LOG_FILE" >&2
  exit 1
fi

if [[ "$APP_EXIT" -ne 0 ]]; then
  echo "Git Diff staleness autotest exited with code $APP_EXIT (${GDS_SUITE}, group ${GDS_GROUP:-<all>})" >&2
  exit "$APP_EXIT"
fi

# ---------------------------------------------------------------------------
# Completion markers, gated by group so each split runner only requires the
# markers ITS OWN group emits (a split runner that demanded another group's
# marker would always fail). group_has <group> is true when the current
# GDS_GROUP IS that group or is empty ('' = whole suite = every group). The seven
# groups are: submodule | submodule-refresh | staleness | reentry |
# diff-ux-presentation | diff-ux-tree | model-sync.
# ---------------------------------------------------------------------------
group_has() {
  [[ -z "$GDS_GROUP" || "$GDS_GROUP" == "$1" ]]
}

require_marker() {
  if ! grep -q "$1" "$LOG_FILE"; then
    echo "Missing $1 marker; $GDS_SUITE may not have run to completion" >&2
    tail -n 40 "$LOG_FILE" >&2
    exit 1
  fi
}

if group_has submodule; then
  require_marker "GDS-05-mixed-parent-and-submodule-internal"
  require_marker "GDS-14-staged-submodule-pointer-surfaces-in-parent"
  require_marker "GDS-13-uninitialized-submodule-not-surfaced"
  require_marker "GDS-16-trace-marker-snapshot-service-expected"
fi

if group_has submodule-refresh; then
  # GDS-46 carved off to its own slice (its cold submodule diff runs ~94 s+ under
  # EDR and overran the watchdog folded into the 'submodule' group).
  require_marker "GDS-46-closed-parent-view-submodule-edits-refresh-diff"
  require_marker "GDS-46-trace-marker-auxiliary-mirror-subscription-expected"
fi

if group_has staleness; then
  require_marker "GDS-10-concurrent-force-and-cached-converge"
  require_marker "GDS-45-project-save-immediately-reopens-fresh-diff"
  require_marker "GDS-12-trace-marker-watcher-and-freshness-expected"
fi

if group_has reentry; then
  require_marker "GDS-15-subdir-entry-watches-resolved-repo-root"
  require_marker "GDS-17-reentry-shows-latest-content"
  require_marker "GDS-18-reentry-latency-trend-recorded"
  require_marker "GDS-20-draft-preserved-during-external-refresh"
  require_marker "GDS-17b-trace-marker-reentry-file-load-expected"
  require_marker "GDS-20b-trace-marker-reentry-model-sync-expected"
fi

if group_has diff-ux-presentation; then
  require_marker "GDS-24a-diff-display-mode-default-inline"
  require_marker "GDS-29-inline-hunk-stage-action-trace-smoke"
  require_marker "GDS-31-git-diff-opens-blank-until-file-selected"
  require_marker "GDS-26-trace-marker-diff-file-load-expected"
  require_marker "GDS-30-trace-marker-diff-ux-actions-expected"
fi

if group_has diff-ux-tree; then
  require_marker "GDS-32-first-selection-uses-prefetched-body-cache"
  require_marker "GDS-33-stage-selected-ranges-does-not-stage-whole-file"
  require_marker "GDS-35-tree-default-icons-and-nesting"
  require_marker "GDS-39-editor-jump-to-diff-selects-current-file"
  require_marker "GDS-34-trace-marker-diff-body-prefetch-expected"
  require_marker "GDS-42-trace-marker-diff-tree-editor-jumps-expected"
fi

if group_has model-sync; then
  require_marker "GDS-19-open-view-selected-body-refreshes"
  require_marker "GDS-43-repeated-same-file-refresh-keeps-model-fresh"
  require_marker "GDS-44-external-stable-status-edits-refresh-diff"
  require_marker "GDS-43-trace-marker-diff-model-sync-expected"
  require_marker "GDS-44-trace-marker-stable-status-fingerprint-expected"
fi

# ---------------------------------------------------------------------------
# GDS-11/12: post-mortem trace inspection. Verify the new trace events
# actually fired during the test session.
# ---------------------------------------------------------------------------
TRACE_LATEST_PATH="$REPO_ROOT/traces/perf/latest.txt"
if [[ ! -f "$TRACE_LATEST_PATH" ]]; then
  echo "GDS-11/12 FAIL: traces/perf/latest.txt missing" >&2
  exit 1
fi

TRACE_TARGET="$(cat "$TRACE_LATEST_PATH")"
TRACE_FILES=()
if [[ -d "$TRACE_TARGET" ]]; then
  while IFS= read -r trace_file; do
    if grep -Fxq "$trace_file" "$TRACE_BEFORE_FILE" && [[ ! "$trace_file" -nt "$TRACE_START_MARKER" ]]; then
      continue
    fi
    TRACE_FILES+=("$trace_file")
  done < <(find "$TRACE_TARGET" -maxdepth 1 -type f -name 'perf-*.jsonl' -print | sort)
elif [[ -f "$TRACE_TARGET" ]]; then
  if ! grep -Fxq "$TRACE_TARGET" "$TRACE_BEFORE_FILE" || [[ "$TRACE_TARGET" -nt "$TRACE_START_MARKER" ]]; then
    TRACE_FILES+=("$TRACE_TARGET")
  fi
fi
if [[ "${#TRACE_FILES[@]}" -eq 0 ]]; then
  echo "GDS-11/12 FAIL: no current-run main trace files found from latest.txt target: $TRACE_TARGET" >&2
  exit 1
fi

# Each Onward process writes its own trace file:
#   - main thread → <repoRoot>/traces/perf/  (pointed to by latest.txt)
#   - git-ipc worker thread → ${TMPDIR}/onward-traces-perf-worker/
# Some events fire only on one side (the worker emits submodule-filter when it
# parses git status; the main thread emits git-state-mirror.fanout when the
# Authority Worker reports a state delta). We accept either trace as long as
# the event lands somewhere.
#
# We delegate matching to test/autotest/check-trace-event.mjs so the parser handles
# Chrome Trace JSON's `{"traceEvents":[...]}` wrapper and partial / truncated
# files correctly — `grep -F` would false-positive on payloads whose `args`
# field happens to embed the literal `"name":"X"` byte sequence.
WORKER_TRACE_DIR="$RUN_TMP_DIR/onward-traces-perf-worker"

expect_event() {
  local label="$1"
  local needle="$2"
  local match
  local trace_file
  for trace_file in "${TRACE_FILES[@]}"; do
    if match="$(node "$REPO_ROOT/test/autotest/check-trace-event.mjs" \
      --main "$trace_file" \
      --worker-dir "$WORKER_TRACE_DIR" \
      --name "$needle")"; then
      if [[ "$match" == "main" ]]; then
        echo "PASS $label  ($needle in main trace $(basename "$trace_file"))"
      else
        echo "PASS $label  ($needle in $match trace)"
      fi
      return 0
    fi
  done
  echo "FAIL $label  (missing $needle in ${#TRACE_FILES[@]} main trace file(s) and worker traces)" >&2
  exit 1
}

echo ""
echo "=== Trace event coverage (group: ${GDS_GROUP:-<all>}) ==="
# expect_event calls are gated by group so each split runner only asserts the
# events its own group's cases actually produced; an event that could fire in
# MULTIPLE groups is owned by exactly ONE group whose cases are guaranteed to
# emit it (same 4-way partition as the TS-side markers).
if group_has submodule; then
  expect_event "GDS-11"  "main:git.diff.submodule-filter"
  # Snapshot service: capture is the meaningful "we routed through the
  # service" signal. We deliberately do NOT assert cache-hit here — the
  # request cache and snapshot cache are invalidated together by the
  # watcher fan-out, so during a test session the cache-hit path requires
  # a precise timing window (request cache TTL expired, watcher silent,
  # snapshot still warm) that is not worth defending against test-runner
  # flake. Cache health can still be inspected post-mortem in the trace.
  expect_event "GDS-16"  "main:git.snapshot.capture"
fi
if group_has submodule-refresh; then
  expect_event "GDS-46"  "renderer:git-diff.aux-mirror-subscription"
fi
if group_has staleness; then
  expect_event "GDS-12a" "main:git-state-mirror.fanout"
  expect_event "GDS-12b" "renderer:subpage.freshness-check"
  # GDS-48: page-open diagnostics (2026-07-04). The staleness cases open the
  # Diff page fresh, so the open-phase chain fires; their external edits
  # invalidate cached content, so the precompute scheduler emits its
  # (previously unwired) schedule breadcrumb.
  expect_event "GDS-48a" "renderer:git-diff.open-phase.request"
  expect_event "GDS-48b" "renderer:git-diff.open-phase.list-applied"
  expect_event "GDS-48c" "renderer:git-diff.open-phase.first-paint"
  expect_event "GDS-48d" "main:git.diff.precompute.schedule"
  # GDS-49: G1/G2 spinner fixes (2026-07-04). Same guarantee analysis as
  # GDS-48: the staleness cases re-open after external edits (snapshot
  # survives on its structural token — no ls-files respawn) and edit while a
  # live terminal subscribes (quiet-window re-warm scheduled). The G4
  # open-skeleton event is NOT gated here — it needs a fresh viewer mount
  # racing a dirty-repo mirror snapshot, which this suite's flow does not
  # guarantee (first open is on a clean fixture; re-opens keep the previous
  # list). Locked instead by git-diff-open-skeleton-entries unit tests.
  expect_event "GDS-49a" "main:git.diff.snapshot.revalidate-served"
  expect_event "GDS-49b" "main:git.prewarm.rewarm-scheduled"
fi
if group_has reentry; then
  # GDS-15/17/18 issue diff loads + file-body loads (snapshot.capture +
  # file-load); GDS-20 drives the renderer model-sync path. These events also
  # fire in other groups, but each is asserted here under the reentry group's
  # own marker IDs so the reentry runner only demands events its cases emit.
  expect_event "GDS-17b1" "main:git.snapshot.capture"
  expect_event "GDS-17b2" "renderer:git-diff.file-load"
  expect_event "GDS-20b"  "renderer:git-diff.model-sync"
fi
if group_has diff-ux-presentation; then
  # The VS Code presentation surface (BlockA = GDS-21.., plus GDS-31) drives the
  # file-body load and manual-refresh / hunk-navigate / hunk-action paths.
  expect_event "GDS-26a" "main:ipc.git.get-file-content"
  expect_event "GDS-26b" "renderer:git-diff.file-load"
  expect_event "GDS-30a" "renderer:git-diff.manual-refresh"
  expect_event "GDS-30b" "renderer:git-diff.hunk-navigate"
  expect_event "GDS-30c" "renderer:git-diff.hunk-action"
fi
if group_has diff-ux-tree; then
  # GDS-32 (prefetch) drives the body-prefetch path; BlockE (GDS-35..39) drives
  # the tree-mode / editor-jump paths.
  expect_event "GDS-34"  "renderer:git-diff.body-prefetch"
  expect_event "GDS-42a" "renderer:git-diff.file-list-mode-change"
  expect_event "GDS-42b" "renderer:git-diff.jump-to-editor"
  expect_event "GDS-42c" "renderer:project-editor.jump-to-diff"
fi
if group_has model-sync; then
  # GDS-43 (repeated same-file refresh) + GDS-44 (external stable-status edits)
  # drive the renderer model-sync and worker change-fingerprint paths.
  expect_event "GDS-43"  "renderer:git-diff.model-sync"
  expect_event "GDS-44"  "worker:git-state-mirror.change-fingerprint"
fi

echo ""
echo "Git Diff staleness + submodule filter autotest passed (${GDS_SUITE}, group ${GDS_GROUP:-<all>})"
echo "  Log:    $LOG_FILE"
echo "  Trace:  $TRACE_TARGET (${#TRACE_FILES[@]} main chunk(s))"
