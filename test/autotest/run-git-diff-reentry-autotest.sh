#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2026 OPPO
# SPDX-License-Identifier: Apache-2.0
#
# Split runner: the 'reentry' SIXTH of the Git Diff staleness+submodule suite —
# subdir-scope watch + re-entry-content body refresh + re-entry-latency trend +
# draft-preserved-during-external-refresh (GDS-15, 17, 18, 20 + its reentry-group
# trace markers). One of the SIX sub-220s runners the whole suite was split into.
# This group exists because the 4-way split timed out: it absorbs two of the
# heaviest singles (GDS-17 ~34.6s, GDS-20 ~34.6s) deliberately spread one-per-group
# so no slice clusters the expensive cases. History: the whole suite TIMED OUT, and
# so did the 4-way split (round-4: all four hit ~283-284s, their 280s watchdog),
# because the dominant cost is the diff LOAD itself (~7-35s/scenario, measured).
# Re-cut SIX ways balanced BY MEASURED PER-CASE COST so every slice is confidently
# < 220s. This group is ~114s of case-work + ~45s overhead = ~159s (61s margin to
# 220s). The split's goal is BUDGET, not green-on-this-EDR-host. Shared body in
# run-git-diff-staleness-and-submodule-autotest.sh (runnable WHOLE via GDS_GROUP='').
set -euo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
GDS_SUITE=git-diff-reentry GDS_GROUP=reentry \
  exec "$DIR/run-git-diff-staleness-and-submodule-autotest.sh" "$@"
