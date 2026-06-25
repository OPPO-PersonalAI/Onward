#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2026 OPPO
# SPDX-License-Identifier: Apache-2.0
#
# Split runner: the 'submodule' slice of the Git Diff staleness+submodule suite —
# parent/sub c/m/u filter + nested/uninitialized submodule + staged-pointer
# (GDS-01..05, 13, 14 + the submodule-group trace markers GDS-11/16). GDS-46
# (closed-parent submodule freshness) was MOVED OUT to its own runner
# run-git-diff-submodule-refresh-autotest.sh, because its cold v1 submodule diff
# runs ~94s+ under EDR and, folded in here, overran the 280s watchdog (TIMEOUT 283s).
# History: the whole suite TIMED OUT; a 4-way split ALSO timed out; re-cut SIX ways
# by MEASURED PER-CASE COST; then GDS-46 carved off as a SEVENTH slice. Shared body
# in run-git-diff-staleness-and-submodule-autotest.sh (runnable WHOLE via GDS_GROUP='').
set -euo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
GDS_SUITE=git-diff-submodule GDS_GROUP=submodule \
  exec "$DIR/run-git-diff-staleness-and-submodule-autotest.sh" "$@"
