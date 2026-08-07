# SPDX-FileCopyrightText: 2026 OPPO
# SPDX-License-Identifier: Apache-2.0

# Run the PDF/EPUB Git Diff + Git History autotest suite (Windows parity of
# run-pdf-epub-diff-autotest.sh).
#
# Round-6 fix: the throwaway fixture repo is built DETERMINISTICALLY by
# create-pdf-epub-diff-fixture.mjs (Node, execFileSync, no PTY,
# core.autocrlf=false) into a runner-owned temp dir, and its manifest path is
# handed to the app via ONWARD_AUTOTEST_FIXTURE_EXTRA. The previous version built
# the repo by writing a multi-step PowerShell mega-command into the live PTY; on
# an EDR-throttled Windows host the fixture .git was never created inside the
# renderer's wait window (round-5 log: repo-ready:setup:timeout
# { attempts: 109, isGitRepo: false, files: [] }), failing git-diff-repo-ready
# and aborting the suite. Building the repo here removes that failure class.

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
  $LogFile = Join-Path $RepoRoot 'traces/test-logs/pdf-epub-diff-autotest.log'
}
New-Item -ItemType Directory -Force (Split-Path -Parent $LogFile) | Out-Null

if (-not $AppBin -or -not (Test-Path $AppBin)) {
  Write-Error "App binary not found: $AppBin`nRun a development build first: rm -rf out release && pnpm dist:dev"
  exit 1
}

# Runner-owned temp dirs for the fixture repo + a fresh user-data dir.
$RunTmpDir = Join-Path ([IO.Path]::GetTempPath()) ("onward-pdf-epub-run-" + [Guid]::NewGuid().ToString('N'))
$UserDataDir = Join-Path $RunTmpDir 'user-data'
$FixtureRepo = Join-Path $RunTmpDir 'pdf-epub-repo'
New-Item -ItemType Directory -Force $UserDataDir | Out-Null

try {
  # The annotated pair (annotation-diff panel assertions) must match its
  # builder byte-for-byte before it enters the fixture repo.
  Write-Host "Verifying the annotated PDF fixture pair..."
  & node (Join-Path $RootDir 'test\autotest\fixtures\pdf-annotation-diff-fixture-builder.mjs') --check
  if ($LASTEXITCODE -ne 0) { exit 1 }

  # Build the one-commit + alt-working-tree fixture repo (execFileSync; no PTY).
  $fixture = node (Join-Path $RootDir 'test\autotest\create-pdf-epub-diff-fixture.mjs') $FixtureRepo | ConvertFrom-Json
  $ManifestPath = $fixture.manifestPath

  if (Test-Path $LogFile) {
    Remove-Item $LogFile -Force
  }

  Write-Host "Starting PDF/EPUB diff+history autotest..."
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
  $env:ONWARD_AUTOTEST_SUITE = 'pdf-epub-diff'
  $env:ONWARD_AUTOTEST_CWD = $RootDir
  $env:ONWARD_AUTOTEST_FIXTURE_EXTRA = $ManifestPath
  $env:ONWARD_AUTOTEST_EXIT = '1'
  $env:ONWARD_TELEMETRY_RESET_CONSENT = '1'

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
  Remove-Item Env:\ONWARD_TELEMETRY_RESET_CONSENT -ErrorAction SilentlyContinue

  Write-Host ""
  Write-Host "=== Test log (last 80 lines) ==="
  Get-Content $LogFile -Tail 80
  Write-Host ""

  $content = Get-Content $LogFile -Raw

  if ($content -match '\[AutoTest\] FAIL') {
    Write-Host "PDF/EPUB diff autotest FAILED" -ForegroundColor Red
    Write-Host ""
    Write-Host "=== Failure details ==="
    Select-String -Path $LogFile -Pattern '\[AutoTest\] FAIL' | ForEach-Object { Write-Host $_.Line -ForegroundColor Red }
    exit 1
  }

  if ($content -notmatch 'suite-done:PdfEpubDiff') {
    Write-Host "PDF/EPUB diff autotest did not complete" -ForegroundColor Yellow
    Get-Content $LogFile -Tail 40
    exit 1
  }

  if ($content -match 'totalFailed:\s+[1-9]') {
    Write-Host "PDF/EPUB diff autotest reported failed cases in the summary" -ForegroundColor Red
    exit 1
  }

  Write-Host "PDF/EPUB diff autotest PASSED" -ForegroundColor Green
  Write-Host "  Log: $LogFile"
} finally {
  if ($RunTmpDir -and (Test-Path $RunTmpDir)) {
    Remove-Item -Recurse -Force $RunTmpDir -ErrorAction SilentlyContinue
  }
}
