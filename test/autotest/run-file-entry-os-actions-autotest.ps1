# SPDX-FileCopyrightText: 2026 OPPO
# SPDX-License-Identifier: Apache-2.0
#
# FEOS (file-entry OS actions) regression gate — Windows counterpart of
# run-file-entry-os-actions-autotest.sh. Keep the two runners in logical
# parity (fixture builder, suite name, completion/failure grep patterns).

param(
  [string]$AppBin = "",
  [string]$LogFile = ""
)

$ErrorActionPreference = "Stop"

$RootDir = (Resolve-Path (Join-Path $PSScriptRoot "../..")).Path
$SuiteName = "file-entry-os-actions"

if (-not $LogFile) {
  $LogFile = Join-Path $RootDir "traces\test-logs\file-entry-os-actions-autotest.log"
}
New-Item -ItemType Directory -Path (Split-Path $LogFile -Parent) -Force | Out-Null

if (-not $AppBin) {
  . (Join-Path $RootDir "test\autotest\Resolve-DevAppBin.ps1")
  $AppBin = Resolve-DevAppBin -RootDir $RootDir
}

if (-not $AppBin -or -not (Test-Path $AppBin)) {
  throw "App binary not found or not executable: $AppBin"
}

$FixtureJson = node (Join-Path $RootDir "test\autotest\create-file-entry-os-actions-fixture.mjs")
$FixtureRoot = node -e 'const data = JSON.parse(process.argv[1]); process.stdout.write(data.root)' $FixtureJson
if (-not $FixtureRoot -or -not (Test-Path (Join-Path $FixtureRoot ".git"))) {
  throw "Failed to create FEOS fixture. Fixture JSON: $FixtureJson"
}

$tempUserData = Join-Path $env:TEMP ("onward-feos-userdata-" + [guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Path $tempUserData -Force | Out-Null

try {
  if (Test-Path $LogFile) {
    Remove-Item $LogFile -Force
  }

  Write-Host "Starting file-entry OS actions autotest..."
  Write-Host "  Binary:        $AppBin"
  Write-Host "  Fixture repo:  $FixtureRoot"
  Write-Host "  Suite:         $SuiteName"
  Write-Host "  Log:           $LogFile"

  $env:ONWARD_DEBUG = "1"
  $env:ONWARD_REPO_ROOT = $RootDir
  $env:ONWARD_USER_DATA_DIR = $tempUserData
  $env:ONWARD_AUTOTEST = "1"
  $env:ONWARD_AUTOTEST_SUITE = $SuiteName
  $env:ONWARD_AUTOTEST_CWD = $FixtureRoot
  $env:ONWARD_AUTOTEST_EXIT = "1"

  node (Join-Path $RootDir "test\autotest\run-with-timeout.mjs") 240 $AppBin *>> $LogFile

  if (-not (Select-String -Path $LogFile -Pattern "\[AutoTest\] === Autotest Completed ===" -Quiet)) {
    Get-Content $LogFile -Tail 160 | Write-Host
    throw "FEOS autotest did not reach the completion marker. Log: $LogFile"
  }

  if (-not (Select-String -Path $LogFile -Pattern "FEOS-12-toctou-failure-toast-visible" -Quiet)) {
    Get-Content $LogFile -Tail 160 | Write-Host
    throw "FEOS autotest missing the final FEOS-12 assertion (suite truncated?). Log: $LogFile"
  }

  if ((Select-String -Path $LogFile -Pattern "\[AutoTest\] FAIL" -Quiet) -or
      (Select-String -Path $LogFile -Pattern "totalFailed: [1-9][0-9]*" -Quiet)) {
    Get-Content $LogFile -Tail 160 | Write-Host
    throw "FEOS autotest reported FAIL. Log: $LogFile"
  }

  Write-Host "FEOS autotest PASS. Log: $LogFile"
} finally {
  Remove-Item Env:ONWARD_DEBUG -ErrorAction SilentlyContinue
  Remove-Item Env:ONWARD_REPO_ROOT -ErrorAction SilentlyContinue
  Remove-Item Env:ONWARD_USER_DATA_DIR -ErrorAction SilentlyContinue
  Remove-Item Env:ONWARD_AUTOTEST -ErrorAction SilentlyContinue
  Remove-Item Env:ONWARD_AUTOTEST_SUITE -ErrorAction SilentlyContinue
  Remove-Item Env:ONWARD_AUTOTEST_CWD -ErrorAction SilentlyContinue
  Remove-Item Env:ONWARD_AUTOTEST_EXIT -ErrorAction SilentlyContinue

  # Defensive sweep of any leftover __autotest_* debris at repo root
  # (per the autotest cleanup hard rule).
  Get-ChildItem -Path $RootDir -Filter "__autotest_*" -ErrorAction SilentlyContinue |
    Remove-Item -Recurse -Force -ErrorAction SilentlyContinue

  if (Test-Path $tempUserData) {
    Remove-Item $tempUserData -Recurse -Force -ErrorAction SilentlyContinue
  }
  if ($FixtureRoot -and (Test-Path $FixtureRoot)) {
    Remove-Item $FixtureRoot -Recurse -Force -ErrorAction SilentlyContinue
  }
}
