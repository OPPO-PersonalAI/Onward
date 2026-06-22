#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2026 OPPO
# SPDX-License-Identifier: Apache-2.0
#
# Split runner: the 'static' baseline group of the GitStateMirror latency suite —
# GSM-00..14, the single-terminal 5-state badge matrix over static fixtures. One of
# the baseline sub-5-min runners (the whole baseline overran the 300s budget —
# class-2). Same EDR-timing caveat as gsm17/gsm18: the GSM-03/04/05* badge steps
# wait for `git status` convergence, so on an EDR-throttled host they can miss the
# wait window and fail (pass on a fast/CI host); the split's goal here is budget
# (< 300s), not green-on-this-host. Shared body in
# run-git-state-mirror-latency-autotest.sh (runnable whole via LATENCY_MODE='').
set -euo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
LATENCY_SUITE=git-state-mirror-latency-static LATENCY_MODE=static \
  exec "$DIR/run-git-state-mirror-latency-autotest.sh" "$@"
