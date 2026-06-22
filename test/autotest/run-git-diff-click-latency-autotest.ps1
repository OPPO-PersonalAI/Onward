# SPDX-FileCopyrightText: 2026 OPPO
# SPDX-License-Identifier: Apache-2.0

$ErrorActionPreference = "Stop"

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$RootDir = Split-Path -Parent (Split-Path -Parent $ScriptDir)
. (Join-Path $RootDir "test\autotest\Resolve-DevAppBin.ps1")

$DefaultExe = Resolve-DevAppBin -RootDir $RootDir
$AppExe = if ($args.Count -ge 1 -and $args[0]) { $args[0] } else { $DefaultExe }
$LogFile = if ($args.Count -ge 2 -and $args[1]) { $args[1] } else { Join-Path $RootDir "traces\test-logs\git-diff-click-latency-autotest.log" }
$LogDir = Split-Path -Parent $LogFile
New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
$SuiteName = "git-diff-click-latency"
if ($env:GDCL_CAP) {
  $SuiteName = "$SuiteName;cap=$($env:GDCL_CAP)"
}
$WatchdogSec = if ($env:GDCL_WATCHDOG_SEC) { [int]$env:GDCL_WATCHDOG_SEC } else { 180 }

if (-not $AppExe -or -not (Test-Path $AppExe)) {
  Write-Error "App executable not found: $AppExe`nRun a development build first: remove the out and release directories, then run pnpm dist:dev"
}

$UserDataDir = Join-Path $env:TEMP ("onward-gdcl-userdata-" + [guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Force -Path $UserDataDir | Out-Null
$FixtureRoot = $null

try {
  if (Test-Path $LogFile) {
    Remove-Item $LogFile -Force
  }

  $fixtureJson = & node (Join-Path $RootDir "test\autotest\create-git-diff-click-latency-fixture.mjs")
  $fixture = $fixtureJson | ConvertFrom-Json
  $FixtureRoot = [string]$fixture.root
  if (-not $FixtureRoot -or -not (Test-Path (Join-Path $FixtureRoot ".git"))) {
    Write-Error "Failed to create isolated Git Diff click-latency fixture. Fixture JSON: $fixtureJson"
  }

  $env:ONWARD_DEBUG = "1"
  $env:ONWARD_PERF_TRACE = "1"
  $env:ONWARD_REPO_ROOT = $RootDir
  $env:ONWARD_USER_DATA_DIR = $UserDataDir
  $env:ONWARD_AUTOTEST = "1"
  $env:ONWARD_AUTOTEST_SUITE = $SuiteName
  $env:ONWARD_AUTOTEST_CWD = $FixtureRoot
  $env:ONWARD_AUTOTEST_EXIT = "1"

  Write-Host "Starting Git Diff click latency autotest..."
  Write-Host "  Binary:       $AppExe"
  Write-Host "  Repo:         $RootDir"
  Write-Host "  Fixture repo: $FixtureRoot"
  Write-Host "  User data:    $UserDataDir"
  Write-Host "  Suite:        $SuiteName"
  Write-Host "  Watchdog:     ${WatchdogSec}s"
  Write-Host "  Log:          $LogFile"

  & node (Join-Path $RootDir "test\autotest\run-with-timeout.mjs") $WatchdogSec $AppExe *> $LogFile
  $AppExit = $LASTEXITCODE
  if ($AppExit -eq 124) {
    Get-Content $LogFile -Tail 120 | Write-Host
    Write-Error "Git Diff click latency autotest exceeded ${WatchdogSec}s watchdog. Log: $LogFile"
  }
  if ($AppExit -ne 0) {
    Get-Content $LogFile -Tail 120 | Write-Host
    Write-Error "Git Diff click latency autotest app exited with code $AppExit. Log: $LogFile"
  }

  $content = Get-Content $LogFile -Raw
  if ($content -notmatch "\[AutoTest\] === Autotest Completed ===") {
    Get-Content $LogFile -Tail 120 | Write-Host
    Write-Error "Git Diff click latency autotest did not reach the completion marker. Log: $LogFile"
  }
  if (
    $content -match "\[AutoTest\] FAIL" -or
    $content -match "totalFailed: [1-9][0-9]*" -or
    $content -match "runtime-errors-detected" -or
    $content -match "FAIL gdcl-"
  ) {
    Get-Content $LogFile -Tail 120 | Write-Host
    Write-Error "Git Diff click latency autotest failed. Log: $LogFile"
  }

  $TraceDir = Join-Path $RootDir "traces\perf"
  $LatestPointer = Join-Path $TraceDir "latest.txt"
  # Resolve the directory that actually holds this run's perf chunks (mirrors the
  # .sh). The pointer (latest.txt) normally holds the trace DIRECTORY path; older
  # runs may have left a single chunk-file path, or the pointer may be
  # missing/stale. In every case we resolve a directory and then scan ALL chunks
  # inside it — a single ONWARD_PERF_TRACE run rotates output across many
  # perf-*.jsonl chunks, so any one chunk is an unreliable sample of the events.
  $PerfScanDir = $TraceDir
  if (Test-Path $LatestPointer) {
    $pointerValue = (Get-Content $LatestPointer -Raw).Trim()
    if ($pointerValue -and (Test-Path $pointerValue -PathType Container)) {
      $PerfScanDir = $pointerValue
    } elseif ($pointerValue -and (Test-Path $pointerValue -PathType Leaf)) {
      $PerfScanDir = Split-Path -Parent $pointerValue
    }
  }

  # Collect every perf chunk in the resolved directory. Perf chunks are
  # ndjson-chunked perf-*.jsonl (older runs may have *.json).
  $perfChunks = @(
    Get-ChildItem -Path $PerfScanDir -File -ErrorAction SilentlyContinue |
      Where-Object { $_.Name -like "perf-*.jsonl" -or $_.Extension -eq ".json" }
  )
  if ($perfChunks.Count -eq 0) {
    Write-Error "Cannot locate any perf trace chunk under $PerfScanDir"
  }

  # Concatenate every chunk so an event landing in a non-newest chunk still
  # counts as present.
  $trace = ($perfChunks | ForEach-Object { Get-Content $_.FullName -Raw }) -join "`n"
  $phaseEvents = @(
    "renderer:git-diff.click-phase.ipc",
    "renderer:git-diff.click-phase.state-set",
    "renderer:git-diff.click-phase.model-bind",
    "renderer:git-diff.click-phase.mount",
    "renderer:git-diff.click-phase.diff-compute",
    "renderer:git-diff.click-phase.dom-commit",
    "renderer:git-diff.click-phase.paint",
    "renderer:git-diff.click-phase.tokenize-settle",
    "renderer:git-diff.click-phase.total",
    "renderer:git-diff.cache-invalidation"
  )
  $missing = @($phaseEvents | Where-Object { $trace -notmatch [regex]::Escape($_) })
  if ($missing.Count -gt 0) {
    Write-Error ("Phase chain regression; missing events: " + ($missing -join ", ") + " (trace dir: $PerfScanDir, $($perfChunks.Count) chunks scanned)")
  }

  Write-Host "Git Diff click latency autotest passed. Log: $LogFile"
} finally {
  Get-ChildItem -Path $RootDir -Filter "__autotest_*" -Force -ErrorAction SilentlyContinue |
    Remove-Item -Recurse -Force -ErrorAction SilentlyContinue
  if (Test-Path $UserDataDir) {
    Remove-Item $UserDataDir -Recurse -Force -ErrorAction SilentlyContinue
  }
  if ($FixtureRoot -and (Test-Path $FixtureRoot)) {
    Remove-Item $FixtureRoot -Recurse -Force -ErrorAction SilentlyContinue
  }
}
