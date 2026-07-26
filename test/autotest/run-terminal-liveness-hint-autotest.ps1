# SPDX-FileCopyrightText: 2026 OPPO
# SPDX-License-Identifier: Apache-2.0
#
# Windows parity of run-terminal-liveness-hint-autotest.sh — G3/G4 liveness
# silent hint + storm E2E with integration disabled and a 1.5 s window.

param(
  [string]$AppBin = "",
  [string]$LogFile = ""
)

$RootDir = Split-Path -Parent (Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path))
$AppDir = Join-Path $RootDir "release\win-unpacked"

if (-not $AppBin) {
  $Candidates = Get-ChildItem -Path $AppDir -Filter "*.exe" -ErrorAction SilentlyContinue | Sort-Object Name
  if (-not $Candidates -or $Candidates.Count -eq 0) {
    Write-Error "No packaged .exe was found. Run: rm -rf out release && pnpm dist:dev"
    exit 1
  }
  $AppBin = $Candidates[0].FullName
}

if (-not $LogFile) {
  $RepoRoot = Split-Path -Parent (Split-Path -Parent (Split-Path -Parent $PSCommandPath))
  $LogFile = Join-Path $RepoRoot "traces/test-logs/terminal-liveness-hint-autotest.log"
  New-Item -ItemType Directory -Force (Split-Path -Parent $LogFile) | Out-Null
}

if (-not (Test-Path $AppBin)) {
  Write-Error "App binary not found: $AppBin"
  exit 1
}

if (Test-Path $LogFile) {
  Remove-Item $LogFile -Force
}

Write-Host "Starting terminal liveness-hint autotest..."

$env:ONWARD_DEBUG = "1"
$env:ONWARD_AUTOTEST = "1"
$env:ONWARD_AUTOTEST_SUITE = "terminal-liveness-hint"
$env:ONWARD_AUTOTEST_CWD = $RootDir
$env:ONWARD_AUTOTEST_EXIT = "1"
$env:ONWARD_SHELL_INTEGRATION = "0"
$env:ONWARD_LIVENESS_WINDOW_MS = "1500"
$env:NO_COLOR = "1"
$env:FORCE_COLOR = "0"
$env:CLICOLOR = "0"
$env:COLORTERM = ""

try {
  & $AppBin *> $LogFile
} catch {
}

$logContent = Get-Content $LogFile -Raw -ErrorAction SilentlyContinue

if ($logContent -match "\[AutoTest\] FAIL") {
  Write-Error "Terminal liveness-hint autotest failed. Log: $LogFile"
  Get-Content $LogFile -Tail 120
  exit 1
}

# LVH-03 is emitted on both the full path and the documented environmental
# skip, so it is the honest completion floor (see the .sh counterpart).
if ($logContent -notmatch "LVH-03-six-silent-hints") {
  Write-Error "Terminal liveness-hint autotest did not complete. Log: $LogFile"
  Get-Content $LogFile -Tail 120
  exit 1
}

Write-Host "Terminal liveness-hint autotest passed. Log: $LogFile"
