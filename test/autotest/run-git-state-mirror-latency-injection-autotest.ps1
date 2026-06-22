# SPDX-FileCopyrightText: 2026 OPPO
# SPDX-License-Identifier: Apache-2.0

# Windows mirror of run-git-state-mirror-latency-injection-autotest.sh.
# Split runner: the watcher-failure-injection passes -- subscribe-failure (GSM-15),
# callback-failure (GSM-16), silent-watcher (GSM-19). Each is a separate short app
# launch; together well under the 300s budget.
$ErrorActionPreference = 'Stop'
$env:LATENCY_SUITE = 'git-state-mirror-latency-injection'
$env:LATENCY_MODE = 'injection'
& (Join-Path $PSScriptRoot 'run-git-state-mirror-latency-autotest.ps1') @args
exit $LASTEXITCODE
