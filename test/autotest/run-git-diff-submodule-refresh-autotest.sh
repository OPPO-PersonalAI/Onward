#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2026 OPPO
# SPDX-License-Identifier: Apache-2.0
#
# Split runner: the 'submodule-refresh' slice of the Git Diff staleness+submodule
# suite — GDS-46 ONLY (closed-parent submodule freshness: cold v1 + warm v2
# submodule diff + its aux-mirror-subscription trace marker).
#
# Why its own runner: GDS-46's FIRST submodule diff (v1) forks ~69 git processes
# to establish the submodule status from scratch; on this EDR host each fork is
# taxed 1.3-12.9 s, so that ONE operation runs ~94 s+ (vs ~3 s once the submodule
# Mirror is warm). Folded into the shared 'submodule' group, GDS-46's cold v1 plus
# the rest of that group overran the 280 s watchdog (observed TIMEOUT at 283 s).
# Isolated here, the runner's only heavy work is v1 (≤ COLD_SUBMODULE_DIFF_BUDGET_MS,
# ~94 s actual) + warm v2 (~5 s) + ~45 s overhead ≈ 150 s — comfortably inside the
# watchdog with ~2x margin over the cold-diff cost. This is a class-2 oversized-case
# split (the program is healthy; the per-spawn EDR tax just makes one operation slow),
# NOT a hidden hang. Shared body in run-git-diff-staleness-and-submodule-autotest.sh
# (runnable WHOLE via GDS_GROUP='').
set -euo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
GDS_SUITE=git-diff-submodule-refresh GDS_GROUP=submodule-refresh \
  exec "$DIR/run-git-diff-staleness-and-submodule-autotest.sh" "$@"
