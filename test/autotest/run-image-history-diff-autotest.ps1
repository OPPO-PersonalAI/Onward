# SPDX-FileCopyrightText: 2026 OPPO
# SPDX-License-Identifier: Apache-2.0

# Git History image-diff suite (Windows parity of run-image-history-diff-autotest.sh).
# Split out of run-image-diff-autotest.ps1 because its per-run throwaway git repo
# fixture (init + 4 commits) is heavily taxed by EDR and pushed the combined
# image-diff suite past the 180s per-runner budget.
#
# Round-4 fix: the fixture repo is built deterministically by
# create-image-history-diff-fixture.mjs (Node, execFileSync, no PTY) into a
# runner-owned temp dir, and its manifest path is handed to the app via
# ONWARD_AUTOTEST_FIXTURE_EXTRA. The previous version wrote a `git init &&
# commit && commit` mega-command into the live PTY, which on an EDR-throttled
# Windows host got swallowed by a shell "Press any key to continue" pause (a
# failed `watchman` startup command), so the repo was never created and ID-13
# failed with "not a Git repository", cascading every downstream ID to timeout.

param(
  [string]$AppBin,
  [string]$LogFile
)

$ErrorActionPreference = 'Stop'

$RootDir = Split-Path -Parent (Split-Path -Parent (Split-Path -Parent $PSCommandPath))
. (Join-Path $RootDir 'test\autotest\Resolve-DevAppBin.ps1')

if (-not $AppBin) {
  $AppBin = Resolve-DevAppBin -RootDir $RootDir
}

$RepoRoot = $RootDir
if (-not $LogFile) {
  $LogFile = Join-Path $RepoRoot 'traces/test-logs/image-history-diff-autotest.log'
}
New-Item -ItemType Directory -Force (Split-Path -Parent $LogFile) | Out-Null

if (-not $AppBin -or -not (Test-Path $AppBin)) {
  Write-Error "App binary not found: $AppBin`nRun a development build first: rm -rf out release && pnpm dist:dev"
  exit 1
}

# Runner-owned temp dirs for both the fixture repo and a fresh user-data dir.
$RunTmpDir = Join-Path ([IO.Path]::GetTempPath()) ("onward-image-history-run-" + [Guid]::NewGuid().ToString('N'))
$UserDataDir = Join-Path $RunTmpDir 'user-data'
$FixtureRepo = Join-Path $RunTmpDir 'image-history-repo'
New-Item -ItemType Directory -Force $UserDataDir | Out-Null

try {
  # Build the two-commit image-diff repo (execFileSync; no PTY, no shell init).
  $fixture = node (Join-Path $RootDir 'test\autotest\create-image-history-diff-fixture.mjs') $FixtureRepo | ConvertFrom-Json
  $ManifestPath = $fixture.manifestPath

  if (Test-Path $LogFile) {
    Remove-Item $LogFile -Force
  }

  Write-Host "Starting image history diff autotest..."
  Write-Host "  Binary:        $AppBin"
  Write-Host "  CWD:           $RootDir"
  Write-Host "  Fixture repo:  $FixtureRepo"
  Write-Host "  Manifest:      $ManifestPath"
  Write-Host "  User data dir: $UserDataDir"
  Write-Host "  Log:           $LogFile"
  Write-Host ""

  $env:ONWARD_DEBUG = '1'
  $env:ONWARD_REPO_ROOT = $RepoRoot
  $env:ONWARD_USER_DATA_DIR = $UserDataDir
  $env:ONWARD_AUTOTEST = '1'
  $env:ONWARD_AUTOTEST_SUITE = 'image-history-diff'
  $env:ONWARD_AUTOTEST_CWD = $RootDir
  $env:ONWARD_AUTOTEST_FIXTURE_EXTRA = $ManifestPath
  $env:ONWARD_AUTOTEST_EXIT = '1'

  $proc = Start-Process -FilePath $AppBin -PassThru -RedirectStandardOutput $LogFile -RedirectStandardError "$LogFile.err" -NoNewWindow -Wait
  if (Test-Path "$LogFile.err") {
    Get-Content "$LogFile.err" | Add-Content $LogFile
    Remove-Item "$LogFile.err" -Force -ErrorAction SilentlyContinue
  }

  Remove-Item Env:\ONWARD_DEBUG -ErrorAction SilentlyContinue
  Remove-Item Env:\ONWARD_REPO_ROOT -ErrorAction SilentlyContinue
  Remove-Item Env:\ONWARD_USER_DATA_DIR -ErrorAction SilentlyContinue
  Remove-Item Env:\ONWARD_AUTOTEST -ErrorAction SilentlyContinue
  Remove-Item Env:\ONWARD_AUTOTEST_SUITE -ErrorAction SilentlyContinue
  Remove-Item Env:\ONWARD_AUTOTEST_CWD -ErrorAction SilentlyContinue
  Remove-Item Env:\ONWARD_AUTOTEST_FIXTURE_EXTRA -ErrorAction SilentlyContinue
  Remove-Item Env:\ONWARD_AUTOTEST_EXIT -ErrorAction SilentlyContinue

  Write-Host ""
  Write-Host "=== Test log (last 80 lines) ==="
  Get-Content $LogFile -Tail 80
  Write-Host ""

  $content = Get-Content $LogFile -Raw

  if ($content -match '\[AutoTest\] FAIL') {
    Write-Host "Image history diff autotest FAILED" -ForegroundColor Red
    Write-Host ""
    Write-Host "=== Failure details ==="
    Select-String -Path $LogFile -Pattern '\[AutoTest\] FAIL' | ForEach-Object { Write-Host $_.Line -ForegroundColor Red }
    exit 1
  }

  if ($content -match 'totalFailed:\s+[1-9]') {
    Write-Host "Image history diff autotest reported failed cases in the summary" -ForegroundColor Red
    exit 1
  }

  if ($content -notmatch 'ID-18b-cleanup') {
    Write-Host "Missing ID-18b result; the test may not have executed correctly" -ForegroundColor Yellow
    Get-Content $LogFile -Tail 40
    exit 1
  }

  Write-Host "Image history diff autotest PASSED" -ForegroundColor Green
  Write-Host "  Log: $LogFile"
} finally {
  if ($RunTmpDir -and (Test-Path $RunTmpDir)) {
    Remove-Item -Recurse -Force $RunTmpDir -ErrorAction SilentlyContinue
  }
}
