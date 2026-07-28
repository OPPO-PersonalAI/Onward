#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2026 OPPO
# SPDX-License-Identifier: Apache-2.0
#
# Git Diff mutation-timing matrix — 'load-reveal' phase group (BUG-0004).
#
# P3 during-load + P4 during-select. The write lands while the view is coming up — P4 drops it into the same few frames where the bundle's decision was taken 47 ms after the body was bound. Invariant-gated, not line-gated: either body may legitimately win the race, but the view must come to rest describing the one that did.
#
# One of THREE sub-runners the matrix is split across. The split is by PHASE,
# not by cost alone: when a phase group goes red you know immediately which
# moment in the Git Diff lifecycle the tree-change broke, instead of staring at
# one opaque box. Each group keeps its own app session and fixture repo, so a
# failure in one cannot contaminate the next. Shared body in
# run-git-diff-mutation-timing-autotest.sh (runnable WHOLE via MT_GROUP='').
set -euo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
MT_SUITE=git-diff-mutation-timing-load-reveal MT_GROUP=load-reveal \
  exec "$DIR/run-git-diff-mutation-timing-autotest.sh" "$@"
