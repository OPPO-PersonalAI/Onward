# SPDX-FileCopyrightText: 2026 OPPO
# SPDX-License-Identifier: Apache-2.0
#
# Windows parity of run-git-diff-probe-timeout-autotest.sh — RC-2 timed-out
# UI state + retry-escapes-backoff E2E via the autotest poison hook.

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
  $LogFile = Join-Path $RepoRoot "traces/test-logs/git-diff-probe-timeout-autotest.log"
  New-Item -ItemType Directory -Force (Split-Path -Parent $LogFile) | Out-Null
}

if (-not (Test-Path $AppBin)) {
  Write-Error "App binary not found: $AppBin"
  exit 1
}

if (Test-Path $LogFile) {
  Remove-Item $LogFile -Force
}

Write-Host "Starting git-diff probe-timeout autotest..."

$env:ONWARD_DEBUG = "1"
$env:ONWARD_AUTOTEST = "1"
$env:ONWARD_AUTOTEST_SUITE = "git-diff-probe-timeout"
$env:ONWARD_AUTOTEST_CWD = $RootDir
$env:ONWARD_AUTOTEST_EXIT = "1"
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
  Write-Error "Git-diff probe-timeout autotest failed. Log: $LogFile"
  Get-Content $LogFile -Tail 120
  exit 1
}

if ($logContent -notmatch "GPT-04-retry-escapes-backoff") {
  Write-Error "Git-diff probe-timeout autotest did not complete. Log: $LogFile"
  Get-Content $LogFile -Tail 120
  exit 1
}

Write-Host "Git-diff probe-timeout autotest passed. Log: $LogFile"
