# SPDX-FileCopyrightText: 2026 OPPO
# SPDX-License-Identifier: Apache-2.0
#
# GitStateMirror symlink suite (GSY-*) — Windows runner.
# Logical parity with run-git-state-mirror-symlink-autotest.sh: the fixture
# builder creates an NTFS JUNCTION (no admin required) instead of a POSIX
# symlink; realpathSync resolves junctions the same way, so the alias-gap class
# under test is identical.

param(
  [string]$AppBin,
  [string]$LogFile
)

$ErrorActionPreference = "Stop"

$RepoRoot = Split-Path -Parent (Split-Path -Parent (Split-Path -Parent $PSCommandPath))
. (Join-Path $RepoRoot "test\autotest\Resolve-DevAppBin.ps1")

if (-not $AppBin) {
  $AppBin = Resolve-DevAppBin -RootDir $RepoRoot
}
if (-not $AppBin -or -not (Test-Path $AppBin)) {
  Write-Error "App binary not found: $AppBin`nRun a development build first: rm -rf out release && pnpm dist:dev"
  exit 1
}

$Suite = "git-state-mirror-symlink"
if (-not $LogFile) {
  $LogFile = Join-Path $RepoRoot "traces/test-logs/$Suite.log"
}
New-Item -ItemType Directory -Force (Split-Path -Parent $LogFile) | Out-Null
if (Test-Path $LogFile) { Remove-Item $LogFile -Force }

$WatchdogSec = if ($env:WATCHDOG_SEC) { $env:WATCHDOG_SEC } else { "180" }
$RunTmpDir = Join-Path ([System.IO.Path]::GetTempPath()) ("onward-$Suite-" + [System.Guid]::NewGuid().ToString("N").Substring(0, 8))
$UserDataDir = Join-Path $RunTmpDir "user-data"
$FixtureDir = Join-Path $RunTmpDir "fixture"
New-Item -ItemType Directory -Force $UserDataDir | Out-Null
New-Item -ItemType Directory -Force $FixtureDir | Out-Null

try {
  $env:ONWARD_GSY_FIXTURE_DIR = $FixtureDir
  $FixtureJson = & node (Join-Path $RepoRoot "test\autotest\create-gsm-symlink-fixture.mjs")
  Remove-Item Env:\ONWARD_GSY_FIXTURE_DIR -ErrorAction SilentlyContinue
  $Fixture = $FixtureJson | ConvertFrom-Json
  $NeutralCwd = $Fixture.neutralCwd
  $ManifestPath = $Fixture.manifestPath

  Write-Host "Starting GitStateMirror symlink autotest..."
  Write-Host "  Binary:        $AppBin"
  Write-Host "  Neutral cwd:   $NeutralCwd"
  Write-Host "  Manifest:      $ManifestPath"
  Write-Host "  User data dir: $UserDataDir"
  Write-Host "  Watchdog:      ${WatchdogSec}s"
  Write-Host "  Log:           $LogFile"
  Write-Host ""

  $env:TMPDIR = $RunTmpDir
  $env:ONWARD_DEBUG = "1"
  $env:ONWARD_PERF_TRACE = "1"
  $env:ONWARD_REPO_ROOT = $RepoRoot
  $env:ONWARD_USER_DATA_DIR = $UserDataDir
  $env:ONWARD_AUTOTEST = "1"
  $env:ONWARD_AUTOTEST_SUITE = "git-state-mirror-symlink"
  $env:ONWARD_AUTOTEST_CWD = $NeutralCwd
  $env:ONWARD_AUTOTEST_FIXTURE_EXTRA = $ManifestPath
  $env:ONWARD_AUTOTEST_EXIT = "1"

  $AppExit = 0
  & node (Join-Path $RepoRoot "test\autotest\run-with-timeout.mjs") $WatchdogSec $AppBin *> $LogFile
  if ($LASTEXITCODE -ne 0) { $AppExit = $LASTEXITCODE }

  foreach ($v in @("TMPDIR","ONWARD_DEBUG","ONWARD_PERF_TRACE","ONWARD_REPO_ROOT","ONWARD_USER_DATA_DIR","ONWARD_AUTOTEST","ONWARD_AUTOTEST_SUITE","ONWARD_AUTOTEST_CWD","ONWARD_AUTOTEST_FIXTURE_EXTRA","ONWARD_AUTOTEST_EXIT")) {
    Remove-Item "Env:\$v" -ErrorAction SilentlyContinue
  }

  Write-Host ""
  Write-Host "=== Test log (last 60 lines) ==="
  Get-Content $LogFile -Tail 60
  Write-Host ""

  $content = Get-Content $LogFile -Raw

  if ($content -match "\[AutoTest\] FAIL") {
    Write-Host "GitStateMirror symlink autotest FAILED" -ForegroundColor Red
    Select-String -Path $LogFile -Pattern "\[AutoTest\] FAIL" | ForEach-Object { Write-Host $_.Line -ForegroundColor Red }
    exit 1
  }
  if ($AppExit -ne 0) {
    Write-Host "GitStateMirror symlink autotest exited with code $AppExit" -ForegroundColor Red
    exit $AppExit
  }

  $markers = @(
    "GSY-00-fixture-loaded",
    "GSY-01-badge-renders-through-symlink-cwd",
    "GSY-02-dirty-flip-through-symlink-cwd",
    "GSY-03-badge-renders-through-real-cwd"
  )
  foreach ($m in $markers) {
    if ($content -notmatch [regex]::Escape($m)) {
      Write-Host "Missing $m marker; the suite may not have completed" -ForegroundColor Yellow
      Get-Content $LogFile -Tail 40
      exit 1
    }
  }

  Write-Host "GitStateMirror symlink autotest PASSED" -ForegroundColor Green
  Write-Host "  Log: $LogFile"
}
finally {
  Remove-Item -Recurse -Force $RunTmpDir -ErrorAction SilentlyContinue
}
