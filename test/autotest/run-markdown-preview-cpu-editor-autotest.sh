#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2026 OPPO
# SPDX-License-Identifier: Apache-2.0
#
# Phase-split runner: the EDITOR CPU phases of the markdown-preview-cpu suite —
# split editor/preview mode + editor-only mode (each: settle + sample + assert
# helper CPU within budget). One of the phase-split sub-5-min runners (the whole
# 4-phase suite overran 300s — class-2). Shared body in
# run-markdown-preview-cpu-autotest.sh (runnable whole via MPC_ONLY_PHASE='').
set -euo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
MPC_SUITE=markdown-preview-cpu-editor MPC_ONLY_PHASE=editor \
  exec "$DIR/run-markdown-preview-cpu-autotest.sh" "$@"
