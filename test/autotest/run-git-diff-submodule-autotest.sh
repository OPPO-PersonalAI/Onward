#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2026 OPPO
# SPDX-License-Identifier: Apache-2.0
#
# Split runner: the 'submodule' SIXTH of the Git Diff staleness+submodule suite —
# parent/sub c/m/u filter + nested/uninitialized submodule + staged-pointer +
# closed-parent submodule freshness (GDS-01..05, 13, 14, 46 + its submodule-group
# trace markers). One of the SIX sub-220s runners the whole suite was split into.
# History: the whole suite TIMED OUT; the 4-way split ALSO timed out (round-4: all
# four sub-runners hit ~283-284s, their 280s watchdog) because the dominant cost is
# the diff LOAD itself (~7-35s/scenario, measured), and diff-ux summed ~235s /
# model-sync ~154s of irreducible diff work alone. Re-cut SIX ways balanced BY
# MEASURED PER-CASE COST so every slice is confidently < 220s. This group is ~113s
# of case-work + ~45s overhead = ~158s (62s margin to 220s). The split's goal is
# BUDGET, not green-on-this-EDR-host. Shared body in
# run-git-diff-staleness-and-submodule-autotest.sh (runnable WHOLE via GDS_GROUP='').
set -euo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
GDS_SUITE=git-diff-submodule GDS_GROUP=submodule \
  exec "$DIR/run-git-diff-staleness-and-submodule-autotest.sh" "$@"
