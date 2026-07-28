#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2026 OPPO
# SPDX-License-Identifier: Apache-2.0
#
# Git Diff mutation-timing matrix — 'closed' phase group (BUG-0004).
#
# P1 never-opened + P2 closed round-trip (both directions). The 2026-07-26 bundle's own phase: the tree changed while no diff view was on screen. P2 runs low->high AND high->low because a stale read only fails one direction depending on which line is smaller.
#
# One of THREE sub-runners the matrix is split across. The split is by PHASE,
# not by cost alone: when a phase group goes red you know immediately which
# moment in the Git Diff lifecycle the tree-change broke, instead of staring at
# one opaque box. Each group keeps its own app session and fixture repo, so a
# failure in one cannot contaminate the next. Shared body in
# run-git-diff-mutation-timing-autotest.sh (runnable WHOLE via MT_GROUP='').
set -euo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
MT_SUITE=git-diff-mutation-timing-closed MT_GROUP=closed \
  exec "$DIR/run-git-diff-mutation-timing-autotest.sh" "$@"
