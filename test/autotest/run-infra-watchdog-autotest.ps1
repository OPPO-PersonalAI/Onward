# SPDX-FileCopyrightText: 2026 OPPO
# SPDX-License-Identifier: Apache-2.0
#
# Infrastructure-watchdog autotest (2026-07-20 incident class) — Windows
# twin of run-infra-watchdog-autotest.sh. Exercises the simulated
# threadpool stall -> /api/health flip + degradation banner + recovery,
# and the visibility-watchdog probe transport. The genuine POSIX
# lost-wakeup stall is locked at the unit layer (fifo harness); Windows
# drives the DEBUG_SIMULATE_THREADPOOL_STALL hook instead.

param(
  [string]$AppBin = "",
  [string]$LogFile = ""
)

$RootDir = Split-Path -Parent (Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path))
. (Join-Path $RootDir "test\autotest\Resolve-DevAppBin.ps1")

if (-not $AppBin) {
  $AppBin = Resolve-DevAppBin -RootDir $RootDir
}

if (-not $AppBin -or -not (Test-Path $AppBin)) {
  Write-Error "App binary not found. Run: rm -rf out release && pnpm dist:dev"
  exit 1
}

if (-not $LogFile) {
  $LogFile = Join-Path $RootDir "traces/test-logs/infra-watchdog-autotest.log"
}
New-Item -ItemType Directory -Force (Split-Path -Parent $LogFile) | Out-Null
if (Test-Path $LogFile) {
  Remove-Item $LogFile -Force
}

Write-Host "Starting infra-watchdog autotest..."

$env:ONWARD_DEBUG = "1"
$env:ONWARD_AUTOTEST = "1"
$env:ONWARD_AUTOTEST_SUITE = "infra-watchdog"
$env:ONWARD_AUTOTEST_CWD = $RootDir
$env:ONWARD_AUTOTEST_EXIT = "1"

try {
  try {
    & $AppBin *> $LogFile
  } catch {
  }

  if (Select-String -Path $LogFile -Pattern "\[AutoTest\] FAIL" -Quiet) {
    Write-Error "Infra-watchdog autotest FAILED. Log: $LogFile"
    Get-Content $LogFile -Tail 120
    exit 1
  }

  if (-not (Select-String -Path $LogFile -Pattern "infra-watchdog-test:done" -Quiet)) {
    Write-Error "Infra-watchdog autotest did not complete. Log: $LogFile"
    Get-Content $LogFile -Tail 120
    exit 1
  }

  Write-Host "Infra-watchdog autotest PASSED. Log: $LogFile"
} finally {
  # Sweep any legacy __autotest_* fixtures from the repo root
  # (defence-in-depth; this suite creates none itself).
  Get-ChildItem -Path $RootDir -Filter "__autotest_*" -ErrorAction SilentlyContinue |
    Remove-Item -Recurse -Force -ErrorAction SilentlyContinue
}
