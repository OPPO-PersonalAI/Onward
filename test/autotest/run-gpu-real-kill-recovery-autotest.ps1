# SPDX-FileCopyrightText: 2026 OPPO
# SPDX-License-Identifier: Apache-2.0
#
# GPU REAL-kill recovery gate — Windows twin of
# run-gpu-real-kill-recovery-autotest.sh. process.kill(pid,'SIGKILL') is a
# hard TerminateProcess on Windows, so the same suite exercises the real
# child-process-gone -> respawn -> recovery chain. K=3 launch-level trials,
# gate = all launches green.

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
  $LogFile = Join-Path $RootDir "traces/test-logs/gpu-real-kill-recovery-autotest.log"
}
New-Item -ItemType Directory -Force (Split-Path -Parent $LogFile) | Out-Null
if (Test-Path $LogFile) {
  Remove-Item $LogFile -Force
}

$Launches = if ($env:ONWARD_GRK_LAUNCHES) { [int]$env:ONWARD_GRK_LAUNCHES } else { 3 }

$env:ONWARD_DEBUG = "1"
$env:ONWARD_AUTOTEST = "1"
$env:ONWARD_AUTOTEST_SUITE = "gpu-real-kill-recovery"
$env:ONWARD_AUTOTEST_CWD = $RootDir
$env:ONWARD_AUTOTEST_EXIT = "1"

$overallPass = $true
try {
  for ($launch = 1; $launch -le $Launches; $launch++) {
    Add-Content $LogFile "=== GRK launch $launch/$Launches ==="
    $launchLog = Join-Path $env:TEMP ("grk-launch-" + [guid]::NewGuid().ToString('N').Substring(0,8) + ".log")
    try {
      & $AppBin *> $launchLog
    } catch {
    }
    Get-Content $launchLog | Add-Content $LogFile
    if (Select-String -Path $launchLog -Pattern "\[AutoTest\] FAIL" -Quiet) {
      Write-Host "GRK launch $launch FAILED."
      $overallPass = $false
    } elseif (-not (Select-String -Path $launchLog -Pattern "gpu-real-kill-recovery-test:done" -Quiet)) {
      Write-Host "GRK launch $launch did not complete."
      $overallPass = $false
    } else {
      Write-Host "GRK launch $launch PASSED."
    }
    Remove-Item $launchLog -Force -ErrorAction SilentlyContinue
  }

  if (-not $overallPass) {
    Write-Error "gpu-real-kill-recovery autotest FAILED (one or more launches red). Log: $LogFile"
    exit 1
  }
  Write-Host "gpu-real-kill-recovery autotest PASSED ($Launches/$Launches launches green). Log: $LogFile"
} finally {
  Get-ChildItem -Path $RootDir -Filter "__autotest_*" -ErrorAction SilentlyContinue |
    Remove-Item -Recurse -Force -ErrorAction SilentlyContinue
}
