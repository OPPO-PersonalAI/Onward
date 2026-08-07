# SPDX-FileCopyrightText: 2026 OPPO
# SPDX-License-Identifier: Apache-2.0

# PDF external-change auto-refresh autotest (Windows parity of
# run-pdf-external-refresh-autotest.sh).
#
# Logical parity with the .sh runner is mandatory: any change to one — fixture
# preparation (mktemp project root + sample.pdf copy), patch verification, env
# vars, exit-code handling, cleanup — must be mirrored in the other in the
# same change set. A drifted .ps1 is an invisible Windows-only regression.

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
  $LogFile = Join-Path $RepoRoot 'traces/test-logs/pdf-external-refresh-autotest.log'
}
New-Item -ItemType Directory -Force (Split-Path -Parent $LogFile) | Out-Null

if (-not $AppBin -or -not (Test-Path $AppBin)) {
  Write-Error "App binary not found: $AppBin`nRun a development build first: rm -rf out release; pnpm dist:dev"
  exit 1
}

Write-Host "Verifying the text-selection PDF fixture..."
& node (Join-Path $RootDir 'test\autotest\fixtures\pdf-text-selection-fixture-builder.mjs') --check
if ($LASTEXITCODE -ne 0) { exit 1 }

Write-Host "Verifying pdf.js patches..."
& node (Join-Path $RootDir 'scripts\apply-pdfjs-patches.mjs') --check
if ($LASTEXITCODE -ne 0) { exit 1 }

$RunTmpDir = Join-Path ([IO.Path]::GetTempPath()) ("onward-pdf-extrefresh-" + [Guid]::NewGuid().ToString('N'))
$UserDataDir = Join-Path $RunTmpDir 'user-data'
# The throwaway project root the app opens. The suite mutates sample.pdf
# "externally" through the debug write channel; nothing touches the repo.
$ProjectRoot = Join-Path $RunTmpDir 'project-root'
New-Item -ItemType Directory -Force $UserDataDir | Out-Null
New-Item -ItemType Directory -Force $ProjectRoot | Out-Null
Copy-Item -LiteralPath (Join-Path $RootDir 'test\autotest\fixtures\pdf-text-selection\onward-textsel.pdf') `
  -Destination (Join-Path $ProjectRoot 'sample.pdf') -Force

try {
  if (Test-Path $LogFile) {
    Remove-Item $LogFile -Force
  }

  Write-Host "Starting PDF external-refresh autotest..."
  Write-Host "  Binary:        $AppBin"
  Write-Host "  Project root:  $ProjectRoot"
  Write-Host "  User data dir: $UserDataDir"
  Write-Host "  Log:           $LogFile"
  Write-Host ""

  $env:ONWARD_DEBUG = '1'
  $env:ONWARD_REPO_ROOT = $RepoRoot
  $env:ONWARD_USER_DATA_DIR = $UserDataDir
  $env:ONWARD_AUTOTEST = '1'
  $env:ONWARD_AUTOTEST_SUITE = 'pdf-external-refresh'
  $env:ONWARD_AUTOTEST_CWD = $ProjectRoot
  $env:ONWARD_AUTOTEST_EXIT = '1'
  $env:ONWARD_TELEMETRY_RESET_CONSENT = '1'

  Start-Process -FilePath $AppBin -PassThru -RedirectStandardOutput $LogFile -RedirectStandardError "$LogFile.err" -NoNewWindow -Wait | Out-Null
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
  Remove-Item Env:\ONWARD_AUTOTEST_EXIT -ErrorAction SilentlyContinue
  Remove-Item Env:\ONWARD_TELEMETRY_RESET_CONSENT -ErrorAction SilentlyContinue

  Write-Host ""
  Write-Host "=== Test log (last 80 lines) ==="
  Get-Content $LogFile -Tail 80
  Write-Host ""

  $content = Get-Content $LogFile -Raw

  if ($content -match '\[AutoTest\] FAIL') {
    Write-Host "PDF external-refresh autotest FAILED" -ForegroundColor Red
    Write-Host ""
    Write-Host "=== Failure details ==="
    Select-String -Path $LogFile -Pattern '\[AutoTest\] FAIL' | ForEach-Object { Write-Host $_.Line -ForegroundColor Red }
    exit 1
  }

  if ($content -notmatch 'suite-done:PdfExternalRefresh') {
    Write-Host "PDF external-refresh autotest did not complete" -ForegroundColor Yellow
    Get-Content $LogFile -Tail 40
    exit 1
  }

  if ($content -match 'totalFailed:\s+[1-9]') {
    Write-Host "PDF external-refresh autotest reported failed cases in the summary" -ForegroundColor Red
    exit 1
  }

  Write-Host "PDF external-refresh autotest PASSED" -ForegroundColor Green
  Write-Host "  Log: $LogFile"
} finally {
  # Defence-in-depth: this suite is designed not to touch the repo root, but a
  # regression that does must never leak into the working tree.
  Get-ChildItem -Path $RepoRoot -Filter '__autotest_*' -Force -ErrorAction SilentlyContinue |
    Remove-Item -Recurse -Force -ErrorAction SilentlyContinue

  if (Test-Path $RunTmpDir) {
    if ($env:ONWARD_AUTOTEST_KEEP_TMP -eq '1') {
      Write-Host "[autotest] retained tmp for debugging: $RunTmpDir"
    } else {
      Remove-Item $RunTmpDir -Recurse -Force -ErrorAction SilentlyContinue
    }
  }
}
