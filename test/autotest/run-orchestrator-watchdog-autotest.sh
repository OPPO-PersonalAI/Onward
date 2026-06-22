#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2026 OPPO
# SPDX-License-Identifier: Apache-2.0
#
# OWD — orchestrator watchdog self-check (test-infra regression).
#
# Locks the full-regression orchestrator's TIMEOUT enforcement: a runner that
# overruns its configured budget MUST be force-killed and reported TIMEOUT, even
# when (a) a surviving/detached grandchild holds the stdout pipe open (the read
# loop would otherwise block forever) or (b) the inner run-with-timeout.mjs fails
# to reap the tree. Delegates to check-orchestrator-watchdog.py, which drives the
# REAL run_one() from run-full-regression.py against three injected-hang fixtures.
#
# App-independent: the dev app is NOT launched. APP_BIN ($1) is accepted for
# runner-signature parity with the orchestrator and ignored.
#
# Usage:
#   bash test/autotest/run-orchestrator-watchdog-autotest.sh [APP_BIN] [LOG_FILE]

set -uo pipefail

REPO_ROOT="${ONWARD_REPO_ROOT:-${REPO_ROOT:-$(cd "$(dirname "$0")/../.." && pwd)}}"
LOG_FILE="${2:-$REPO_ROOT/traces/test-logs/orchestrator-watchdog-autotest.log}"
mkdir -p "$(dirname "$LOG_FILE")"

# Resolve a Python interpreter portably. The orchestrator injects PYTHON3
# (sys.executable); a standalone run falls back to `py` (Windows) then `python3`
# (macOS / Linux). A bare `python3` is NOT valid on Windows, hence the ladder.
PY="${PYTHON3:-}"
if [[ -z "$PY" ]]; then
  if command -v py >/dev/null 2>&1; then PY="py"
  elif command -v python3 >/dev/null 2>&1; then PY="python3"
  else PY="python"; fi
fi

echo "OWD orchestrator watchdog self-check (PY=$PY, REPO_ROOT=$REPO_ROOT)" | tee "$LOG_FILE"

# The check self-cleans its OS-temp fixtures in `finally`; stream its output to
# both the orchestrator (live progress) and the per-suite log.
"$PY" "$REPO_ROOT/test/autotest/check-orchestrator-watchdog.py" 2>&1 | tee -a "$LOG_FILE"
rc=${PIPESTATUS[0]}

if [[ "$rc" == "0" ]]; then
  echo "OWD orchestrator watchdog self-check: PASS" | tee -a "$LOG_FILE"
else
  echo "OWD orchestrator watchdog self-check: FAIL (rc=$rc)" | tee -a "$LOG_FILE"
fi
exit "$rc"
