#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2026 OPPO
# SPDX-License-Identifier: Apache-2.0
#
# Split runner: the 'diff-ux-tree' SIXTH of the Git Diff staleness+submodule suite —
# the tree icons / flat-tree-mode / groups / editor-jump atomic block (GDS-35..39,
# kept whole because its cases reuse one multi-file tree fixture + open diff session)
# + prefetch-body cache (GDS-32) + partial-stage selected ranges (GDS-33) + its
# tree-group trace markers. One of the SIX sub-220s runners the whole suite was
# split into. History: the whole suite TIMED OUT, and so did the 4-way split
# (round-4: diff-ux alone summed ~235s of irreducible diff work and hit ~283s),
# because the dominant cost is the diff LOAD itself (~7-35s/scenario, measured).
# Re-cut SIX ways balanced BY MEASURED PER-CASE COST so every slice is confidently
# < 220s. This group is ~113s of case-work + ~45s overhead = ~158s (62s margin to
# 220s). The split's goal is BUDGET, not green-on-this-EDR-host. Shared body in
# run-git-diff-staleness-and-submodule-autotest.sh (runnable WHOLE via GDS_GROUP='').
set -euo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
GDS_SUITE=git-diff-ux-tree GDS_GROUP=diff-ux-tree \
  exec "$DIR/run-git-diff-staleness-and-submodule-autotest.sh" "$@"
