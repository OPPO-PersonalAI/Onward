#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2026 OPPO
# SPDX-License-Identifier: Apache-2.0
#
# Split runner: the 'gsm17' baseline group — GSM-17 same-tab two-Task same-repo
# status consistency. Trimmed to 2 trials when run isolated (the TS keys off
# ONWARD_AUTOTEST_GSM_LATENCY_GROUP='gsm17') so it fits budget — on EDR each trial
# is ~65s as every step waits the full convergence timeout; the whole-suite run
# keeps 5. One of the baseline sub-5-min runners (the whole baseline overran the
# 300s budget — class-2). NB: on an EDR-throttled host this group's
# badge-convergence assertions can fail (slow `git status` misses the wait) — that
# is the pre-existing EDR-timing issue, not this split; it passes on a fast/CI
# host. Shared body in run-git-state-mirror-latency-autotest.sh.
set -euo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
LATENCY_SUITE=git-state-mirror-latency-gsm17 LATENCY_MODE=gsm17 \
  exec "$DIR/run-git-state-mirror-latency-autotest.sh" "$@"
