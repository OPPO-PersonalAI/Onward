# SPDX-FileCopyrightText: 2026 OPPO
# SPDX-License-Identifier: Apache-2.0
#
# Windows parity for run-open-browser-autotest.sh. Keep both in logical parity: any change to
# fixture layout, env vars, the OB-01 sentinel grep, or exit handling must be mirrored here.

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
  $RepoRoot = Split-Path -Parent (Split-Path -Parent (Split-Path -Parent $PSCommandPath))
  $LogFile = Join-Path $RepoRoot "traces/test-logs/open-browser-autotest.log"
}
New-Item -ItemType Directory -Force (Split-Path -Parent $LogFile) | Out-Null

$TmpRoot = Join-Path $env:TEMP ("onward-open-browser-" + [guid]::NewGuid().ToString())
New-Item -ItemType Directory -Force -Path $TmpRoot | Out-Null
Copy-Item (Join-Path $RootDir "test\autotest\fixtures\open-browser\*") -Destination $TmpRoot -Force

if (Test-Path $LogFile) {
  Remove-Item $LogFile -Force
}

Write-Host "Starting Open Browser autotest..."
Write-Host "[autotest] tmp dir: $TmpRoot"

$env:ONWARD_DEBUG = "1"
$env:ONWARD_AUTOTEST = "1"
$env:ONWARD_AUTOTEST_SUITE = "open-browser"
$env:ONWARD_AUTOTEST_CWD = $TmpRoot
$env:ONWARD_AUTOTEST_EXIT = "1"

try {
  try {
    & $AppBin *> $LogFile
  } catch {
  }

  if (Select-String -Path $LogFile -Pattern "\[AutoTest\] FAIL" -Quiet) {
    Write-Error "Open Browser autotest failed. Log: $LogFile"
    Get-Content $LogFile -Tail 160
    exit 1
  }

  if (Select-String -Path $LogFile -Pattern "totalFailed: [1-9]" -Quiet) {
    Write-Error "Open Browser autotest reported failed cases. Log: $LogFile"
    Get-Content $LogFile -Tail 160
    exit 1
  }

  if (-not (Select-String -Path $LogFile -Pattern "OB-01-local-file-opens-and-renders" -Quiet)) {
    Write-Error "Open Browser autotest did not complete. Log: $LogFile"
    Get-Content $LogFile -Tail 160
    exit 1
  }

  Write-Host "Open Browser autotest passed. Log: $LogFile"
} finally {
  if (Test-Path $TmpRoot) {
    if ($env:ONWARD_AUTOTEST_KEEP_TMP -eq '1') {
      Write-Host "[autotest] retained tmp for debugging: $TmpRoot"
    } else {
      Remove-Item -Recurse -Force $TmpRoot
    }
  }
}
