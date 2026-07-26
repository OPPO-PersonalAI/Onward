# SPDX-FileCopyrightText: 2026 OPPO
# SPDX-License-Identifier: Apache-2.0
#
# Infrastructure-watchdog autotest (2026-07-20 incident class) — Windows
# twin of run-infra-watchdog-autotest.sh. Exercises the simulated
# threadpool stall -> /api/health flip + degradation banner + recovery,
# the visibility-watchdog probe transport, and the activity-aware quit
# scan (IWD-07..09). The genuine POSIX lost-wakeup stall is locked at the
# unit layer (fifo harness); Windows drives the
# DEBUG_SIMULATE_THREADPOOL_STALL hook instead.
#
# Phases 2+3 lock the session ledger (clean-shutdown marker) end to end —
# same contract as the .sh: phase 1 graceful (clean), phase 2 hard-kill on
# the SAME scratch userData (clean=false left behind), phase 3 asserts the
# abnormal notice + TabBar banner (SLN-01..03).

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

$ScratchUserData = Join-Path $env:TEMP ("iwd-userdata-" + [guid]::NewGuid().ToString('N').Substring(0, 8))
New-Item -ItemType Directory -Force $ScratchUserData | Out-Null

Write-Host "Starting infra-watchdog autotest (phase 1: IWD suite)..."

$env:ONWARD_DEBUG = "1"
$env:ONWARD_AUTOTEST = "1"
$env:ONWARD_AUTOTEST_SUITE = "infra-watchdog"
$env:ONWARD_AUTOTEST_CWD = $RootDir
$env:ONWARD_USER_DATA_DIR = $ScratchUserData
$env:ONWARD_AUTOTEST_EXIT = "1"

try {
  try {
    & $AppBin *> $LogFile
  } catch {
  }

  if (Select-String -Path $LogFile -Pattern "\[AutoTest\] FAIL" -Quiet) {
    Write-Error "Infra-watchdog autotest FAILED (phase 1). Log: $LogFile"
    Get-Content $LogFile -Tail 120
    exit 1
  }

  if (-not (Select-String -Path $LogFile -Pattern "infra-watchdog-test:done" -Quiet)) {
    Write-Error "Infra-watchdog autotest did not complete (phase 1). Log: $LogFile"
    Get-Content $LogFile -Tail 120
    exit 1
  }

  Write-Host "Phase 2: hard-kill a plain instance to leave an unclean ledger..."
  $Phase2Log = Join-Path $env:TEMP ("iwd-phase2-" + [guid]::NewGuid().ToString('N').Substring(0, 8) + ".log")
  $env:ONWARD_AUTOTEST_SUITE = "none"
  Remove-Item Env:ONWARD_AUTOTEST_EXIT -ErrorAction SilentlyContinue
  $proc = Start-Process -FilePath $AppBin -PassThru -RedirectStandardOutput $Phase2Log -RedirectStandardError "$Phase2Log.err"
  $LedgerPath = Join-Path $ScratchUserData "session-ledger.json"
  for ($i = 0; $i -lt 60; $i++) {
    if ((Test-Path $LedgerPath) -and (Select-String -Path $LedgerPath -Pattern ('"pid": ' + $proc.Id) -Quiet)) {
      break
    }
    Start-Sleep -Milliseconds 500
  }
  # taskkill /F is the Windows equivalent of SIGKILL (exact-PID targeting).
  taskkill /PID $proc.Id /F 2>$null | Out-Null
  $proc.WaitForExit()
  Get-Content $Phase2Log -ErrorAction SilentlyContinue | Add-Content $LogFile
  Remove-Item $Phase2Log, "$Phase2Log.err" -Force -ErrorAction SilentlyContinue

  Write-Host "Phase 3: relaunch and assert the abnormal-exit notice (SLN suite)..."
  $Phase3Log = Join-Path $env:TEMP ("iwd-phase3-" + [guid]::NewGuid().ToString('N').Substring(0, 8) + ".log")
  $env:ONWARD_AUTOTEST_SUITE = "session-ledger-notice"
  $env:ONWARD_AUTOTEST_EXIT = "1"
  try {
    & $AppBin *> $Phase3Log
  } catch {
  }
  Get-Content $Phase3Log -ErrorAction SilentlyContinue | Add-Content $LogFile

  if (Select-String -Path $Phase3Log -Pattern "\[AutoTest\] FAIL" -Quiet) {
    Write-Error "Infra-watchdog autotest FAILED (phase 3: session-ledger notice)."
    Get-Content $Phase3Log -Tail 120
    Remove-Item $Phase3Log -Force -ErrorAction SilentlyContinue
    exit 1
  }
  if (-not (Select-String -Path $Phase3Log -Pattern "session-ledger-notice-test:done" -Quiet)) {
    Write-Error "Infra-watchdog autotest did not complete (phase 3)."
    Get-Content $Phase3Log -Tail 120
    Remove-Item $Phase3Log -Force -ErrorAction SilentlyContinue
    exit 1
  }
  Remove-Item $Phase3Log -Force -ErrorAction SilentlyContinue

  Write-Host "Infra-watchdog autotest PASSED (3 phases). Log: $LogFile"
} finally {
  Remove-Item -Recurse -Force $ScratchUserData -ErrorAction SilentlyContinue
  # Sweep any legacy __autotest_* fixtures from the repo root
  # (defence-in-depth; this suite creates none itself).
  Get-ChildItem -Path $RootDir -Filter "__autotest_*" -ErrorAction SilentlyContinue |
    Remove-Item -Recurse -Force -ErrorAction SilentlyContinue
}
