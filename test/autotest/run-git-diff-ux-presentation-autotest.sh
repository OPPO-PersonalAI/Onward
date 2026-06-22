#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2026 OPPO
# SPDX-License-Identifier: Apache-2.0
#
# Split runner: the 'diff-ux-presentation' SIXTH of the Git Diff staleness+submodule
# suite — the VS Code resource / split-view / hunk-navigation / refresh atomic UI
# block (GDS-21..29: GDS-21,22,23,24a,24,25,25b,27,28,29×6) + blank-until-file-
# selected (GDS-31) + its presentation-group trace markers. One of the SIX
# sub-220s runners the whole suite was split into. The huge BlockA UI block (~61.5s,
# kept whole because its cases share a single open diff session) plus the heavy
# GDS-31 single (~35s) own this slice. History: the whole suite TIMED OUT, and so
# did the 4-way split (round-4: diff-ux alone summed ~235s of irreducible diff work
# and hit ~283s), because the dominant cost is the diff LOAD itself (~7-35s/scenario,
# measured). Re-cut SIX ways balanced BY MEASURED PER-CASE COST so every slice is
# confidently < 220s. This group is ~96s of case-work + ~45s overhead = ~141s (79s
# margin to 220s). The split's goal is BUDGET, not green-on-this-EDR-host. Shared
# body in run-git-diff-staleness-and-submodule-autotest.sh (runnable WHOLE via
# GDS_GROUP='').
set -euo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
GDS_SUITE=git-diff-ux-presentation GDS_GROUP=diff-ux-presentation \
  exec "$DIR/run-git-diff-staleness-and-submodule-autotest.sh" "$@"
