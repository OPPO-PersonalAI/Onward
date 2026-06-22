# SPDX-FileCopyrightText: 2026 OPPO
# SPDX-License-Identifier: Apache-2.0

# Windows mirror of run-git-state-mirror-latency-gsm18-autotest.sh.
# Split runner: the 'gsm18' baseline group -- GSM-18 cross-tab two-Task consistency
# + real commit-to-clean across two tabs. Same EDR-timing caveat as gsm17: the
# convergence assertions can fail on an EDR host, pass on CI; the split's goal is
# budget (< 300s).
$ErrorActionPreference = 'Stop'
$env:LATENCY_SUITE = 'git-state-mirror-latency-gsm18'
$env:LATENCY_MODE = 'gsm18'
& (Join-Path $PSScriptRoot 'run-git-state-mirror-latency-autotest.ps1') @args
exit $LASTEXITCODE
