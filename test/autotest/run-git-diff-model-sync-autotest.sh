#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2026 OPPO
# SPDX-License-Identifier: Apache-2.0
#
# Split runner: the 'model-sync' SIXTH of the Git Diff staleness+submodule suite —
# open-view selected-body refresh (GDS-19) + repeated same-file refresh keeps model
# fresh (GDS-43) + external stable-status edits refresh diff (GDS-44) + its
# model-sync-group trace markers. One of the SIX sub-220s runners the whole suite
# was split into. GDS-43 (~45s, the single heaviest case) and GDS-19 (~35.8s) are
# isolated here so they do not cluster with the other heavy singles. History: the
# whole suite TIMED OUT, and so did the 4-way split (round-4: model-sync alone
# summed ~154s of irreducible diff work and hit ~283s), because the dominant cost is
# the diff LOAD itself (~7-35s/scenario, measured); GDS-20 was therefore moved out
# to the reentry group. Re-cut SIX ways balanced BY MEASURED PER-CASE COST so every
# slice is confidently < 220s. This group is ~119s of case-work + ~45s overhead =
# ~164s (56s margin to 220s). The split's goal is BUDGET, not green-on-this-EDR-host.
# Shared body in run-git-diff-staleness-and-submodule-autotest.sh (runnable WHOLE
# via GDS_GROUP='').
set -euo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
GDS_SUITE=git-diff-model-sync GDS_GROUP=model-sync \
  exec "$DIR/run-git-diff-staleness-and-submodule-autotest.sh" "$@"
