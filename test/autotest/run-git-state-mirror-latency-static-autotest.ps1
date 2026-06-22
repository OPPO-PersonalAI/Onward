# SPDX-FileCopyrightText: 2026 OPPO
# SPDX-License-Identifier: Apache-2.0

# Windows mirror of run-git-state-mirror-latency-static-autotest.sh.
# Split runner: the 'static' baseline group (GSM-00..14 badge matrix). Same
# EDR-timing caveat as gsm17/gsm18 -- the GSM-03/04/05* badge steps wait for
# `git status` convergence, so on an EDR-throttled host they can miss the wait
# window and fail (pass on a fast/CI host); the split's goal is budget (< 300s).
$ErrorActionPreference = 'Stop'
$env:LATENCY_SUITE = 'git-state-mirror-latency-static'
$env:LATENCY_MODE = 'static'
& (Join-Path $PSScriptRoot 'run-git-state-mirror-latency-autotest.ps1') @args
exit $LASTEXITCODE
