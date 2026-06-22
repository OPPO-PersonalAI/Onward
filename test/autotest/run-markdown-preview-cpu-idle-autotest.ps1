# SPDX-FileCopyrightText: 2026 OPPO
# SPDX-License-Identifier: Apache-2.0

# Windows mirror of run-markdown-preview-cpu-idle-autotest.sh.
# Phase-split runner: the IDLE-preview CPU phase (15s settle + idle samples) -- the
# heaviest of the 4 phases. 40 idle samples (vs the whole-suite default 60) keeps it
# under budget on an EDR host (each CPU sample spawns a process taxed 1-13s); still
# far above the N>=5 the timing-sensitive rule needs. The whole suite overran the
# 300s budget (class-2), so each phase is its own sub-5-min runner.
$ErrorActionPreference = 'Stop'
$env:MPC_SUITE = 'markdown-preview-cpu-idle'
$env:MPC_ONLY_PHASE = 'idle'
$env:MPC_IDLE_SAMPLE_COUNT = '40'
& (Join-Path $PSScriptRoot 'run-markdown-preview-cpu-autotest.ps1') @args
exit $LASTEXITCODE
