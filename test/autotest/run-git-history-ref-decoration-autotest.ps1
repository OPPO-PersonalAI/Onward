# SPDX-FileCopyrightText: 2026 OPPO
# SPDX-License-Identifier: Apache-2.0

param(
  [string]$AppBin,
  [string]$LogFile,
  [string]$TargetRepo
)

$ErrorActionPreference = "Stop"

$RootDir = Split-Path -Parent (Split-Path -Parent (Split-Path -Parent $PSCommandPath))
. (Join-Path $RootDir "test\autotest\Resolve-DevAppBin.ps1")

if (-not $AppBin) {
  $AppBin = Resolve-DevAppBin -RootDir $RootDir
}

if (-not $LogFile) {
  $RepoRoot = Split-Path -Parent (Split-Path -Parent (Split-Path -Parent $PSCommandPath))
  $LogFile = Join-Path $RepoRoot "traces/test-logs/onward-git-history-ref-decoration-autotest.log"
  New-Item -ItemType Directory -Force (Split-Path -Parent $LogFile) | Out-Null
}

if (-not $TargetRepo) {
  $TargetRepo = if ($env:ONWARD_AUTOTEST_TARGET_CWD) { $env:ONWARD_AUTOTEST_TARGET_CWD } else { $RootDir }
}

if (-not $AppBin -or -not (Test-Path $AppBin)) {
  Write-Error "App binary not found: $AppBin`nRun a development build first: rm -rf out release && pnpm dist:dev"
  exit 1
}

if (Test-Path $LogFile) {
  Remove-Item $LogFile -Force
}

$UserDataDir = Join-Path $env:TEMP ("onward-refdec-userdata-" + [guid]::NewGuid().ToString("N"))
$ResultsDir = Join-Path $RootDir "test\autotest\results"
$FixtureBase = Join-Path $ResultsDir ("git-history-ref-decoration-fixtures-" + [guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Force -Path $ResultsDir | Out-Null
New-Item -ItemType Directory -Force -Path $UserDataDir, $FixtureBase | Out-Null

try {
  $env:ONWARD_DEBUG = "1"
  $env:ONWARD_USER_DATA_DIR = $UserDataDir
  $env:ONWARD_AUTOTEST = "1"
  $env:ONWARD_AUTOTEST_SUITE = "git-history-ref-decoration"
  $env:ONWARD_AUTOTEST_CWD = $TargetRepo
  $env:ONWARD_AUTOTEST_FIXTURE_EXTRA = $FixtureBase
  $env:ONWARD_AUTOTEST_EXIT = "1"

  $proc = Start-Process -FilePath $AppBin -PassThru -RedirectStandardOutput $LogFile -RedirectStandardError "$LogFile.err" -NoNewWindow -Wait
  if (Test-Path "$LogFile.err") {
    Get-Content "$LogFile.err" | Add-Content $LogFile
    Remove-Item "$LogFile.err" -Force -ErrorAction SilentlyContinue
  }

  $content = Get-Content $LogFile -Raw

  if ($content -match "\[AutoTest\] FAIL") {
    Write-Host "Git History ref-decoration autotest FAILED" -ForegroundColor Red
    Select-String -Path $LogFile -Pattern "\[AutoTest\] FAIL" | ForEach-Object { Write-Host $_.Line -ForegroundColor Red }
    exit 1
  }

  # Sentinel: the suite must have run through the unconditional tag steps (RD-07 is
  # the last unconditional assertion before the optional worktree capstone).
  if ($content -notmatch "RD-07-tag-delete-clears") {
    Write-Host "Missing RD-07-tag-delete-clears result (suite did not run to completion). Log: $LogFile" -ForegroundColor Yellow
    Get-Content $LogFile -Tail 160
    exit 1
  }

  Write-Host "Git History ref-decoration autotest PASSED" -ForegroundColor Green
  Write-Host "  Log: $LogFile"
}
finally {
  Remove-Item Env:\ONWARD_DEBUG -ErrorAction SilentlyContinue
  Remove-Item Env:\ONWARD_USER_DATA_DIR -ErrorAction SilentlyContinue
  Remove-Item Env:\ONWARD_AUTOTEST -ErrorAction SilentlyContinue
  Remove-Item Env:\ONWARD_AUTOTEST_SUITE -ErrorAction SilentlyContinue
  Remove-Item Env:\ONWARD_AUTOTEST_CWD -ErrorAction SilentlyContinue
  Remove-Item Env:\ONWARD_AUTOTEST_FIXTURE_EXTRA -ErrorAction SilentlyContinue
  Remove-Item Env:\ONWARD_AUTOTEST_EXIT -ErrorAction SilentlyContinue
  Remove-Item -Recurse -Force $UserDataDir, $FixtureBase -ErrorAction SilentlyContinue
}
