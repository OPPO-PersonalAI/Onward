#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2026 OPPO
# SPDX-License-Identifier: Apache-2.0
#
# Split runner: the 'gsm18' baseline group — GSM-18 cross-tab two-Task consistency
# + real commit-to-clean across two tabs. One of the baseline sub-5-min runners
# (the whole baseline overran the 300s budget — class-2). Same EDR-timing caveat
# as the gsm17 split: convergence assertions can fail on an EDR host, pass on CI.
# Shared body in run-git-state-mirror-latency-autotest.sh (runnable whole).
set -euo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
LATENCY_SUITE=git-state-mirror-latency-gsm18 LATENCY_MODE=gsm18 \
  exec "$DIR/run-git-state-mirror-latency-autotest.sh" "$@"
