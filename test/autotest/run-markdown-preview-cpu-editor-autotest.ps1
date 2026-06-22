# SPDX-FileCopyrightText: 2026 OPPO
# SPDX-License-Identifier: Apache-2.0

# Windows mirror of run-markdown-preview-cpu-editor-autotest.sh.
# Phase-split runner: the EDITOR CPU phases -- split editor/preview mode + editor-only
# mode (each: settle + sample + assert helper CPU within budget). One of the
# phase-split sub-5-min runners (the whole 4-phase suite overran 300s -- class-2).
$ErrorActionPreference = 'Stop'
$env:MPC_SUITE = 'markdown-preview-cpu-editor'
$env:MPC_ONLY_PHASE = 'editor'
& (Join-Path $PSScriptRoot 'run-markdown-preview-cpu-autotest.ps1') @args
exit $LASTEXITCODE
