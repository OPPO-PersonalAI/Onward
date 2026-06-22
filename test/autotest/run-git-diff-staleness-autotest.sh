#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2026 OPPO
# SPDX-License-Identifier: Apache-2.0
#
# Split runner: the 'staleness' SIXTH of the Git Diff staleness+submodule suite —
# request-cache invalidation / watcher-driven external-change freshness /
# concurrent force+cached converge + Project-Editor-save freshness
# (GDS-06..10, 45 + its staleness-group trace markers). One of the SIX sub-220s
# runners the whole suite was split into. History: the whole suite TIMED OUT; the
# 4-way split ALSO timed out (round-4: all four sub-runners hit ~283-284s, their
# 280s watchdog) because the dominant cost is the diff LOAD itself (~7-35s/scenario,
# measured). Re-cut SIX ways balanced BY MEASURED PER-CASE COST so every slice is
# confidently < 220s. This group is ~122s of case-work + ~45s overhead = ~167s (53s
# margin to 220s — the tightest of the six, still comfortable). The split's goal is
# BUDGET, not green-on-this-EDR-host. Shared body in
# run-git-diff-staleness-and-submodule-autotest.sh (runnable WHOLE via GDS_GROUP='').
set -euo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
GDS_SUITE=git-diff-staleness GDS_GROUP=staleness \
  exec "$DIR/run-git-diff-staleness-and-submodule-autotest.sh" "$@"
