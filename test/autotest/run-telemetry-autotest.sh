#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2026 OPPO
# SPDX-License-Identifier: Apache-2.0
#
# Telemetry end-to-end autotest — three isolated app launches:
#   Launch A (TEL-01..11): local pipeline with the `disabled` sentinel key —
#     events, aggregation, consent, and the upload-client not-configured
#     fallback. Zero network.
#   Launch B (TEL-12a..c): outbox remediation ACK path — a seeded backlog of
#     old-dated events is re-uploaded to a local mock ingest server
#     (historical_migration) and cleared from the outbox only after the
#     acknowledgement. Network stays on 127.0.0.1.
#   Launch C (TEL-13a..b): outbox remediation NACK path — the ingest host is
#     unreachable, so the backlog MUST survive on disk (no delete without ack).

set -euo pipefail

REPO_ROOT="${REPO_ROOT:-$(cd "$(dirname "$0")/../.." && pwd)}"
ROOT_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
APP_BIN="${1:-}"
LOG_FILE="${2:-$REPO_ROOT/traces/test-logs/telemetry-autotest.log}"
LOG_FILE_B="${LOG_FILE%.log}-remediation-ack.log"
LOG_FILE_C="${LOG_FILE%.log}-remediation-nack.log"
mkdir -p "$(dirname "$LOG_FILE")"
if [[ -z "$APP_BIN" ]]; then
  APP_PATH="$(find "$ROOT_DIR/release" -maxdepth 2 -type d -name '*.app' | sort | head -1)"
  if [[ -z "$APP_PATH" ]]; then
    echo "ERROR: no packaged .app was found. Run: rm -rf out release && pnpm dist:dev" >&2
    exit 1
  fi

  APP_STEM="$(basename "${APP_PATH%.app}")"
  APP_BIN="$APP_PATH/Contents/MacOS/$APP_STEM"
fi

if [[ ! -x "$APP_BIN" ]]; then
  echo "ERROR: app binary not found or not executable: $APP_BIN" >&2
  exit 1
fi

rm -f "$LOG_FILE" "$LOG_FILE_B" "$LOG_FILE_C"

SCRATCH="$(mktemp -d "${TMPDIR:-/tmp}/onward-telemetry-autotest.XXXXXX")"
MOCK_PID=""
cleanup() {
  [[ -n "$MOCK_PID" ]] && kill "$MOCK_PID" 2>/dev/null || true
  if [[ "${ONWARD_AUTOTEST_KEEP_TMP:-0}" == "1" ]]; then
    echo "ONWARD_AUTOTEST_KEEP_TMP=1 — keeping scratch dir: $SCRATCH"
  else
    rm -rf "$SCRATCH"
  fi
}
trap cleanup EXIT

fail() {
  echo "[AutoTest] FAIL $1" >&2
  shift
  for msg in "$@"; do echo "  $msg" >&2; done
  exit 1
}

# ---------------------------------------------------------------------------
# Launch A — local pipeline + not-configured fallback (no network)
# ---------------------------------------------------------------------------
echo "Starting telemetry end-to-end autotest (launch A: local pipeline)..."

ONWARD_DEBUG=1 \
ONWARD_AUTOTEST=1 \
ONWARD_AUTOTEST_SUITE=telemetry \
ONWARD_AUTOTEST_CWD="$ROOT_DIR" \
ONWARD_AUTOTEST_EXIT=1 \
ONWARD_USER_DATA_DIR="$SCRATCH/userdata-a" \
ONWARD_TELEMETRY_RESET_CONSENT=1 \
ONWARD_TELEMETRY_FAST_HEARTBEAT=1 \
ONWARD_TELEMETRY_FORCE_UPLOAD=1 \
ONWARD_TELEMETRY_POSTHOG_KEY=disabled \
"$APP_BIN" > "$LOG_FILE" 2>&1 || true

# Check for failures
if grep -q "\[AutoTest\] FAIL" "$LOG_FILE"; then
  echo "Telemetry autotest FAILED." >&2
  grep "\[AutoTest\]" "$LOG_FILE" >&2
  exit 1
fi

if ! grep -q "telemetry-test:done" "$LOG_FILE"; then
  echo "Telemetry autotest did not complete." >&2
  tail -n 60 "$LOG_FILE" >&2
  exit 1
fi

echo ""
echo "=== AutoTest Results (launch A) ==="
grep "\[AutoTest\] PASS\|FAIL\|suite-done\|Completed" "$LOG_FILE" | grep -o '\[AutoTest\].*' | head -20
echo ""

# Check upload log
echo "=== Upload Log (launch A) ==="
grep "\[Telemetry\]" "$LOG_FILE" || echo "(no telemetry log messages)"
echo ""

# TEL-11: with the `disabled` sentinel key the upload client must take the
# not-configured fallback (local pipeline active, nothing sent) and log it.
# This pins the PostHog wiring without any network traffic from CI.
if grep -q "\[Telemetry\] PostHog API key not configured" "$LOG_FILE"; then
  echo "[AutoTest] PASS TEL-11-upload-client-not-configured-fallback"
else
  fail "TEL-11-upload-client-not-configured-fallback" \
    "Expected '[Telemetry] PostHog API key not configured' in $LOG_FILE"
fi

# TEL-15: the persisted daily stats must carry the 2026-07 metric-redesign
# counter domains (stability + update), and the unified codeAgent action the
# suite drove twice must actually be counted (the January-era aggregator
# silently dropped it). Launch A has no upload client (disabled sentinel),
# so the persisted accumulator is the correct observable, not the upload log.
DAILY_JSON="$SCRATCH/userdata-a/telemetry-daily.json"
if grep -q '"gpuCrashCount"' "$DAILY_JSON" 2>/dev/null && \
   grep -q '"updateCheckCount"' "$DAILY_JSON" 2>/dev/null && \
   grep -q '"dropdownToolsCodeAgent":2' "$DAILY_JSON" 2>/dev/null; then
  echo "[AutoTest] PASS TEL-15-daily-summary-extended-domains"
else
  fail "TEL-15-daily-summary-extended-domains" \
    "Expected gpuCrashCount/updateCheckCount keys and dropdownToolsCodeAgent:2 in $DAILY_JSON" \
    "$(head -c 600 "$DAILY_JSON" 2>/dev/null || echo '(missing file)')"
fi

# TEL-14b: strict adoption count for launch A — with the disabled sentinel
# there is no upload client, so the outbox retains ALL lines: 6 P1-derived
# features + 3 derived from the P2 feature/use drives (git-diff-stage,
# outline, schedule) must have fired first-use exactly once each.
OUTBOX_A="$SCRATCH/userdata-a/telemetry-events.jsonl"
FIRSTUSE_COUNT="$(grep -c '"name":"feature/first-use"' "$OUTBOX_A" 2>/dev/null || echo 0)"
if [[ "$FIRSTUSE_COUNT" == "9" ]]; then
  echo "[AutoTest] PASS TEL-14b-first-use-exact-count"
else
  fail "TEL-14b-first-use-exact-count" \
    "Expected exactly 9 feature/first-use lines in $OUTBOX_A, got $FIRSTUSE_COUNT" \
    "$(grep '"name":"feature/first-use"' "$OUTBOX_A" 2>/dev/null | head -12)"
fi

# TEL-17c: the persisted daily stats must carry the P2 featureUse counter
# map with the exact counts the suite drove, including the clamped
# 'invalid' bucket (schema-drift visibility).
if grep -q '"git-diff-stage":3' "$DAILY_JSON" 2>/dev/null && \
   grep -q '"outline":2' "$DAILY_JSON" 2>/dev/null && \
   grep -q '"schedule-create":1' "$DAILY_JSON" 2>/dev/null && \
   grep -q '"invalid":1' "$DAILY_JSON" 2>/dev/null; then
  echo "[AutoTest] PASS TEL-17c-feature-use-aggregated"
else
  fail "TEL-17c-feature-use-aggregated" \
    "Expected featureUse counts git-diff-stage:3/outline:2/schedule-create:1/invalid:1 in $DAILY_JSON" \
    "$(head -c 800 "$DAILY_JSON" 2>/dev/null || echo '(missing file)')"
fi

# ---------------------------------------------------------------------------
# Shared fixtures for launches B and C: a backlog seeder + a mock ingest server
# ---------------------------------------------------------------------------
seed_backlog() {
  # Seed two well-formed events dated 2 days ago into a fresh userData dir.
  node -e '
    const fs = require("fs"), path = require("path")
    const dir = process.argv[1]
    const base = Date.now() - 2 * 24 * 60 * 60 * 1000
    const mk = (offsetMs, name) => JSON.stringify({
      timestamp: new Date(base + offsetMs).toISOString(),
      name,
      properties: { action: "backlog" },
      common: {
        instanceId: "autotest-backlog-instance",
        sessionId: "autotest-backlog-session",
        appVersion: "0.0.0-autotest",
        platform: process.platform
      }
    })
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, "telemetry-events.jsonl"),
      mk(0, "prompt/use") + "\n" + mk(1000, "session/start") + "\n")
  ' "$1"
}

MOCK_RECEIVED="$SCRATCH/mock-received.jsonl"
MOCK_PORT_FILE="$SCRATCH/mock-port"
node -e '
  const http = require("http"), zlib = require("zlib"), fs = require("fs")
  const outFile = process.argv[1], portFile = process.argv[2]
  const server = http.createServer((req, res) => {
    const chunks = []
    req.on("data", (c) => chunks.push(c))
    req.on("end", () => {
      let body = Buffer.concat(chunks)
      try {
        if (req.headers["content-encoding"] === "gzip") body = zlib.gunzipSync(body)
      } catch {}
      fs.appendFileSync(outFile,
        JSON.stringify({ url: req.url, body: body.toString("utf8").slice(0, 20000) }) + "\n")
      res.writeHead(200, { "Content-Type": "application/json" })
      res.end(JSON.stringify({ status: "Ok" }))
    })
  })
  server.listen(0, "127.0.0.1", () => fs.writeFileSync(portFile, String(server.address().port)))
' "$MOCK_RECEIVED" "$MOCK_PORT_FILE" &
MOCK_PID=$!
disown "$MOCK_PID" 2>/dev/null || true

for _ in $(seq 1 50); do
  [[ -s "$MOCK_PORT_FILE" ]] && break
  sleep 0.1
done
[[ -s "$MOCK_PORT_FILE" ]] || fail "mock-ingest-server-start" "mock server did not report a port"
MOCK_PORT="$(cat "$MOCK_PORT_FILE")"

# ---------------------------------------------------------------------------
# Launch B — remediation ACK path: backlog uploaded to the mock, then cleared
# ---------------------------------------------------------------------------
echo "Starting telemetry autotest (launch B: outbox remediation, acknowledged)..."
seed_backlog "$SCRATCH/userdata-b"

ONWARD_DEBUG=1 \
ONWARD_AUTOTEST=1 \
ONWARD_AUTOTEST_SUITE=telemetry \
ONWARD_AUTOTEST_CWD="$ROOT_DIR" \
ONWARD_AUTOTEST_EXIT=1 \
ONWARD_USER_DATA_DIR="$SCRATCH/userdata-b" \
ONWARD_TELEMETRY_RESET_CONSENT=1 \
ONWARD_AUTOTEST_TELEMETRY_KEEP_OUTBOX=1 \
ONWARD_TELEMETRY_FAST_HEARTBEAT=1 \
ONWARD_TELEMETRY_POSTHOG_KEY=phc_autotest_local_mock \
ONWARD_TELEMETRY_POSTHOG_HOST="http://127.0.0.1:$MOCK_PORT" \
"$APP_BIN" > "$LOG_FILE_B" 2>&1 || true

if grep -q "\[AutoTest\] FAIL" "$LOG_FILE_B"; then
  echo "Telemetry autotest (launch B) suite FAILED." >&2
  grep "\[AutoTest\]" "$LOG_FILE_B" >&2
  exit 1
fi

OUTBOX_B="$SCRATCH/userdata-b/telemetry-events.jsonl"
if grep -q "autotest-backlog-instance" "$OUTBOX_B" 2>/dev/null; then
  fail "TEL-12a-backlog-cleared-after-ack" \
    "seeded backlog lines still present in $OUTBOX_B" \
    "$(grep '\[Telemetry\]' "$LOG_FILE_B" | tail -5)"
fi
echo "[AutoTest] PASS TEL-12a-backlog-cleared-after-ack"

if ! grep -q "\[Telemetry\] Outbox remediation: 2 backlog event(s) uploaded and cleared" "$LOG_FILE_B"; then
  fail "TEL-12b-remediation-log-line" \
    "expected remediation success log in $LOG_FILE_B" \
    "$(grep '\[Telemetry\]' "$LOG_FILE_B" | tail -5)"
fi
echo "[AutoTest] PASS TEL-12b-remediation-log-line"

# NOTE: the mock wraps each request body as a JSON string, so quotes inside
# the body are escaped (\"historical_migration\":true). Match the bare key
# name — it only ever appears when the SDK sends historical-migration mode.
if ! grep -q "historical_migration" "$MOCK_RECEIVED" || \
   ! grep -q "autotest-backlog-instance" "$MOCK_RECEIVED"; then
  fail "TEL-12c-mock-received-historical-batch" \
    "mock ingest server did not receive the historical_migration batch" \
    "received: $(head -c 500 "$MOCK_RECEIVED" 2>/dev/null || echo '(empty)')"
fi
echo "[AutoTest] PASS TEL-12c-mock-received-historical-batch"

# TEL-16: the Tier-2 live lane must have uploaded today's discrete events
# (session/start at minimum) to the mock with an acknowledged clear.
if ! grep -q "Outbox live lane:" "$LOG_FILE_B"; then
  fail "TEL-16-live-lane-uploaded" \
    "expected '[Telemetry] Outbox live lane: N event(s) uploaded and cleared' in $LOG_FILE_B" \
    "$(grep '\[Telemetry\]' "$LOG_FILE_B" | tail -5)"
fi
if ! grep -q "session/start" "$MOCK_RECEIVED"; then
  fail "TEL-16-live-lane-uploaded" \
    "mock ingest server did not receive the live session/start event"
fi
if ! grep -q "feature/first-use" "$MOCK_RECEIVED"; then
  fail "TEL-16-live-lane-uploaded" \
    "mock ingest server did not receive the live feature/first-use events"
fi
echo "[AutoTest] PASS TEL-16-live-lane-uploaded"

# ---------------------------------------------------------------------------
# Launch C — remediation NACK path: unreachable host, backlog must survive
# ---------------------------------------------------------------------------
echo "Starting telemetry autotest (launch C: outbox remediation, not acknowledged)..."
seed_backlog "$SCRATCH/userdata-c"

ONWARD_DEBUG=1 \
ONWARD_AUTOTEST=1 \
ONWARD_AUTOTEST_SUITE=telemetry \
ONWARD_AUTOTEST_CWD="$ROOT_DIR" \
ONWARD_AUTOTEST_EXIT=1 \
ONWARD_USER_DATA_DIR="$SCRATCH/userdata-c" \
ONWARD_TELEMETRY_RESET_CONSENT=1 \
ONWARD_AUTOTEST_TELEMETRY_KEEP_OUTBOX=1 \
ONWARD_TELEMETRY_FAST_HEARTBEAT=1 \
ONWARD_TELEMETRY_POSTHOG_KEY=phc_autotest_unreachable \
ONWARD_TELEMETRY_POSTHOG_HOST="http://127.0.0.1:1" \
"$APP_BIN" > "$LOG_FILE_C" 2>&1 || true

if grep -q "\[AutoTest\] FAIL" "$LOG_FILE_C"; then
  echo "Telemetry autotest (launch C) suite FAILED." >&2
  grep "\[AutoTest\]" "$LOG_FILE_C" >&2
  exit 1
fi

OUTBOX_C="$SCRATCH/userdata-c/telemetry-events.jsonl"
if ! grep -q "autotest-backlog-instance" "$OUTBOX_C" 2>/dev/null; then
  fail "TEL-13a-backlog-retained-without-ack" \
    "seeded backlog lines vanished from $OUTBOX_C without an acknowledgement" \
    "$(grep '\[Telemetry\]' "$LOG_FILE_C" | tail -5)"
fi
echo "[AutoTest] PASS TEL-13a-backlog-retained-without-ack"

if grep -q "uploaded and cleared" "$LOG_FILE_C"; then
  fail "TEL-13b-no-false-ack" \
    "launch C logged a remediation success against an unreachable host"
fi
echo "[AutoTest] PASS TEL-13b-no-false-ack"

echo ""
echo "Telemetry autotest PASSED. Logs: $LOG_FILE $LOG_FILE_B $LOG_FILE_C"
