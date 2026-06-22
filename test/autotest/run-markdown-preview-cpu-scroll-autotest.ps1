# SPDX-FileCopyrightText: 2026 OPPO
# SPDX-License-Identifier: Apache-2.0

# Windows mirror of run-markdown-preview-cpu-scroll-autotest.sh.
# Phase-split runner: the POST-SCROLL CPU-recovery phase (scroll the preview, then
# assert helper CPU settles). One of the phase-split sub-5-min runners (the whole
# 4-phase suite overran 300s -- class-2).
$ErrorActionPreference = 'Stop'
$env:MPC_SUITE = 'markdown-preview-cpu-scroll'
$env:MPC_ONLY_PHASE = 'scroll'
& (Join-Path $PSScriptRoot 'run-markdown-preview-cpu-autotest.ps1') @args
exit $LASTEXITCODE
