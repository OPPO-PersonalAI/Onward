# SPDX-FileCopyrightText: 2026 OPPO
# SPDX-License-Identifier: Apache-2.0
#
# Windows counterpart of run-modal-dismiss-autotest.sh — unified modal
# dismiss policy regression (backdrop clicks inert; ESC safely cancels;
# open-modal registry layering). Assertion set MDM-00..15; the shared
# in-renderer driver lives in src/autotest/test-modal-dismiss.ts and is
# platform-neutral. Keep this file in logical parity with the .sh runner.
#
# Usage:
#   powershell -File test/autotest/run-modal-dismiss-autotest.ps1 [-AppBin <exe>] [-LogFile <path>]

param(
  [string]$AppBin = "",
  [string]$LogFile = ""
)

$ErrorActionPreference = "Stop"

$RootDir = (Resolve-Path (Join-Path $PSScriptRoot "../..")).Path
if (-not $LogFile) {
  $LogFile = Join-Path $RootDir "traces\test-logs\modal-dismiss-autotest.log"
}
New-Item -ItemType Directory -Path (Split-Path $LogFile -Parent) -Force | Out-Null

if (-not $AppBin) {
  . (Join-Path $RootDir "test\autotest\Resolve-DevAppBin.ps1")
  $AppBin = Resolve-DevAppBin -RootDir $RootDir
}

if (-not $AppBin -or -not (Test-Path $AppBin)) {
  throw "App binary not found or not executable: $AppBin (run: rm -rf out release; pnpm dist:dev)"
}

$AppName = [System.IO.Path]::GetFileName($AppBin)
# Exact-name kill only (never wildcards) — see CLAUDE.md process-management rule.
taskkill /IM "$AppName" /F 2>$null | Out-Null
Start-Sleep -Milliseconds 500

$UserDataDir = Join-Path $env:TEMP ("onward-modal-dismiss-" + [guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Path $UserDataDir -Force | Out-Null

if (Test-Path $LogFile) {
  Remove-Item $LogFile -Force
}

try {
  Write-Host "Starting modal dismiss autotest..."
  $env:ONWARD_DEBUG = "1"
  $env:ONWARD_AUTOTEST = "1"
  $env:ONWARD_AUTOTEST_SUITE = "modal-dismiss"
  $env:ONWARD_AUTOTEST_CWD = $RootDir
  $env:ONWARD_AUTOTEST_EXIT = "1"
  $env:ONWARD_AUTOTEST_SKIP_CONSENT = "1"
  $env:ONWARD_USER_DATA_DIR = $UserDataDir

  & $AppBin *>> $LogFile

  if (Select-String -Path $LogFile -Pattern "\[AutoTest\] FAIL" -Quiet) {
    Get-Content $LogFile -Tail 120 | Write-Host
    throw "Modal dismiss autotest failed. Log: $LogFile"
  }

  if (-not (Select-String -Path $LogFile -Pattern "Autotest Completed" -Quiet)) {
    Get-Content $LogFile -Tail 120 | Write-Host
    throw "Modal dismiss autotest did not complete. Log: $LogFile"
  }

  if (-not (Select-String -Path $LogFile -Pattern "PASS MDM-00-project-editor-debug-api-available" -Quiet)) {
    Get-Content $LogFile -Tail 120 | Write-Host
    throw "Modal dismiss autotest produced no MDM assertions. Log: $LogFile"
  }

  Write-Host "Modal dismiss autotest passed. Log: $LogFile"
} finally {
  Remove-Item Env:ONWARD_DEBUG -ErrorAction SilentlyContinue
  Remove-Item Env:ONWARD_AUTOTEST -ErrorAction SilentlyContinue
  Remove-Item Env:ONWARD_AUTOTEST_SUITE -ErrorAction SilentlyContinue
  Remove-Item Env:ONWARD_AUTOTEST_CWD -ErrorAction SilentlyContinue
  Remove-Item Env:ONWARD_AUTOTEST_EXIT -ErrorAction SilentlyContinue
  Remove-Item Env:ONWARD_AUTOTEST_SKIP_CONSENT -ErrorAction SilentlyContinue
  Remove-Item Env:ONWARD_USER_DATA_DIR -ErrorAction SilentlyContinue
  Remove-Item -Recurse -Force $UserDataDir -ErrorAction SilentlyContinue
  # Sweep any __autotest_* fixtures leaked into the repo root (legacy contract).
  Get-ChildItem -Path $RootDir -Filter "__autotest_*" -ErrorAction SilentlyContinue |
    Remove-Item -Recurse -Force -ErrorAction SilentlyContinue
}
