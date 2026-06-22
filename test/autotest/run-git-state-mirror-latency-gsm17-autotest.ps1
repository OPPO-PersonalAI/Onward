# SPDX-FileCopyrightText: 2026 OPPO
# SPDX-License-Identifier: Apache-2.0

# Windows mirror of run-git-state-mirror-latency-gsm17-autotest.sh.
# Split runner: the 'gsm17' baseline group -- GSM-17 same-tab two-Task same-repo
# status consistency. Trimmed to 2 trials when run isolated (the TS keys off
# ONWARD_AUTOTEST_GSM_LATENCY_GROUP='gsm17') so it fits the budget on an EDR host
# where each trial is ~65s. NB: on an EDR-throttled host the badge-convergence
# assertions can fail (slow `git status` misses the wait) -- pre-existing
# EDR-timing issue, not this split; passes on CI.
$ErrorActionPreference = 'Stop'
$env:LATENCY_SUITE = 'git-state-mirror-latency-gsm17'
$env:LATENCY_MODE = 'gsm17'
& (Join-Path $PSScriptRoot 'run-git-state-mirror-latency-autotest.ps1') @args
exit $LASTEXITCODE
