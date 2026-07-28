#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2026 OPPO
# SPDX-License-Identifier: Apache-2.0
#
# Git Diff mutation-timing matrix — 'viewing' phase group (BUG-0004).
#
# P5 while-viewing + P6 after-scroll + P7 during-close + P8 rapid burst. The worktree side updates in place here, so this group is carried by the diff-currency gate rather than the URI identity; P8 is also the model-leak bound.
#
# One of THREE sub-runners the matrix is split across. The split is by PHASE,
# not by cost alone: when a phase group goes red you know immediately which
# moment in the Git Diff lifecycle the tree-change broke, instead of staring at
# one opaque box. Each group keeps its own app session and fixture repo, so a
# failure in one cannot contaminate the next. Shared body in
# run-git-diff-mutation-timing-autotest.sh (runnable WHOLE via MT_GROUP='').
set -euo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
MT_SUITE=git-diff-mutation-timing-viewing MT_GROUP=viewing \
  exec "$DIR/run-git-diff-mutation-timing-autotest.sh" "$@"
