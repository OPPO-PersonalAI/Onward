# SPDX-FileCopyrightText: 2026 OPPO
# SPDX-License-Identifier: Apache-2.0
#
# Windows parity runner for run-memory-watch-autotest.sh (MW-01..MW-09).
# Any logic fix there MUST be mirrored here in the same change set.

param(
  [string]$AppBin = "",
  [string]$LogFile = "",
  [string]$UserDataDir = ""
)

$RootDir = Split-Path -Parent (Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path))
. (Join-Path $RootDir "test\autotest\Resolve-DevAppBin.ps1")

if (-not $AppBin) {
  $AppBin = Resolve-DevAppBin -RootDir $RootDir
}

if (-not $AppBin -or -not (Test-Path $AppBin)) {
  Write-Error "App binary not found. Run: rm -rf out release && pnpm dist:dev"
  exit 1
}

if (-not $LogFile) {
  $LogFile = Join-Path $RootDir "traces\test-logs\memory-watch-autotest.log"
}
New-Item -ItemType Directory -Force -Path (Split-Path -Parent $LogFile) | Out-Null

# Track whether this script created the user-data dir, so cleanup only removes
# self-created directories and never a caller-supplied path that may hold real data.
$TmpRootOwned = $false
if (-not $UserDataDir) {
  $UserDataDir = Join-Path $env:TEMP ("onward-autotest-memory-watch-" + [guid]::NewGuid().ToString())
  $TmpRootOwned = $true
}
New-Item -ItemType Directory -Force -Path $UserDataDir | Out-Null

$BundleOutDir = Join-Path $UserDataDir "bundle-out"
New-Item -ItemType Directory -Force -Path $BundleOutDir | Out-Null

if (Test-Path $LogFile) { Remove-Item -Force $LogFile }

Write-Host "Starting memory-watch autotest..."
Write-Host "[autotest] tmp dir: $UserDataDir"

$ExitCode = 1
try {
  $env:ONWARD_DEBUG = "1"
  $env:ONWARD_AUTOTEST = "1"
  $env:ONWARD_AUTOTEST_SUITE = "memory-watch"
  $env:ONWARD_AUTOTEST_CWD = $RootDir
  $env:ONWARD_AUTOTEST_EXIT = "1"
  $env:ONWARD_AUTOTEST_FIXTURE_EXTRA = $BundleOutDir
  $env:ONWARD_USER_DATA_DIR = $UserDataDir
  # Isolated trace capture inside the scratch dir (mirrors the .sh runner).
  $env:ONWARD_REPO_ROOT = $UserDataDir
  $env:ONWARD_MEM_WATCH_INTERVAL_SEC = "1"
  $env:ONWARD_MEM_WATCH_MIN_UPTIME_SEC = "0"

  & $AppBin *> $LogFile

  $LogText = Get-Content -Raw -ErrorAction SilentlyContinue $LogFile
  if (-not $LogText) {
    Write-Error "Memory-watch autotest produced no log output. Log: $LogFile"
    exit 1
  }
  if ($LogText -match "\[AutoTest\] FAIL") {
    Write-Error "Memory-watch autotest failed. Log: $LogFile"
    Get-Content $LogFile -Tail 160 | Write-Host
    exit 1
  }
  if ($LogText -notmatch "MW-09-heap-snapshot-sidecars-attached") {
    Write-Error "Memory-watch autotest did not complete. Log: $LogFile"
    Get-Content $LogFile -Tail 160 | Write-Host
    exit 1
  }

  $TraceDir = Join-Path $UserDataDir "traces\perf"
  if (-not (Test-Path $TraceDir)) {
    Write-Error "Memory-watch autotest trace assertion failed: trace dir missing: $TraceDir"
    exit 1
  }
  $Chunks = Get-ChildItem -Path $TraceDir -Filter "perf-*.jsonl" -ErrorAction SilentlyContinue
  if (-not $Chunks) {
    Write-Error "Memory-watch autotest trace assertion failed: no perf-*.jsonl chunks"
    exit 1
  }
  $Events = @(
    "main:mem-watch.sample",
    "worker:mem-watch.sample",
    "renderer:mem-watch.sample",
    "main:mem-watch.pressure-detected",
    "main:mem-watch.report-written",
    "main:mem-watch.dump-written",
    "main:diagnostic-bundle.heap-snapshot-attached"
  )
  foreach ($eventName in $Events) {
    $found = $Chunks | Where-Object { (Select-String -Path $_.FullName -SimpleMatch $eventName -Quiet) }
    if (-not $found) {
      Write-Error "Memory-watch autotest trace assertion failed: event '$eventName' not found in any trace chunk"
      exit 1
    }
  }
  $Reports = Get-ChildItem -Path $TraceDir -Filter "memory-report-*.jsonl" -ErrorAction SilentlyContinue
  if (-not $Reports) {
    Write-Error "Memory-watch autotest trace assertion failed: memory-report-*.jsonl missing from trace dir"
    exit 1
  }

  Write-Host "Memory-watch autotest passed. Log: $LogFile"
  $ExitCode = 0
} finally {
  # Defence-in-depth sweep per the autotest hard rule.
  Get-ChildItem -Path $RootDir -Filter "__autotest_*" -ErrorAction SilentlyContinue |
    Remove-Item -Recurse -Force -ErrorAction SilentlyContinue
  if ($TmpRootOwned -and (Test-Path $UserDataDir)) {
    if ($env:ONWARD_AUTOTEST_KEEP_TMP -eq "1") {
      Write-Host "[autotest] retained tmp for debugging: $UserDataDir"
    } else {
      Remove-Item -Recurse -Force -ErrorAction SilentlyContinue $UserDataDir
    }
  }
}

exit $ExitCode
