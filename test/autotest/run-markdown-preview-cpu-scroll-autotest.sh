#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2026 OPPO
# SPDX-License-Identifier: Apache-2.0
#
# Phase-split runner: the POST-SCROLL CPU-recovery phase of the markdown-preview-cpu
# suite (scroll the preview, then assert helper CPU settles). One of the phase-split
# sub-5-min runners (the whole 4-phase suite overran 300s — class-2). Shared body in
# run-markdown-preview-cpu-autotest.sh (runnable whole via MPC_ONLY_PHASE='').
set -euo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
MPC_SUITE=markdown-preview-cpu-scroll MPC_ONLY_PHASE=scroll \
  exec "$DIR/run-markdown-preview-cpu-autotest.sh" "$@"
