#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2026 OPPO
# SPDX-License-Identifier: Apache-2.0
#
# Phase-split runner: the IDLE-preview CPU phase of the markdown-preview-cpu suite
# (the heaviest — 15s settle + 60×1s idle samples). The whole 4-phase suite overran
# the 300s budget (class-2), so each phase is its own sub-5-min runner. Shared body
# in run-markdown-preview-cpu-autotest.sh (runnable whole via MPC_ONLY_PHASE='').
set -euo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
# 40 idle samples (vs the whole-suite default 60) keeps this comfortably under
# budget on this EDR host — each CPU sample spawns a process taxed 1-13s, so 60
# samples ran ~236s. 40 is still far above the N>=5 the timing-sensitive rule
# needs for a stable idle-CPU avg/p95. CI (fast spawns) is unaffected.
MPC_SUITE=markdown-preview-cpu-idle MPC_ONLY_PHASE=idle MPC_IDLE_SAMPLE_COUNT=40 \
  exec "$DIR/run-markdown-preview-cpu-autotest.sh" "$@"
