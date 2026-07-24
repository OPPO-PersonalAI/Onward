# SPDX-FileCopyrightText: 2026 OPPO
# SPDX-License-Identifier: Apache-2.0
#
# Wake-park GPU-crash SOAK — Windows structural twin of
# run-gpu-wake-park-soak.sh. The ANGLE-Metal crash class is macOS-only, so
# Windows sessions are expected to measure zero crashes — running the twin
# still validates the harness wiring cross-platform (window hide/park/wake
# and the PTY emitter path are platform-neutral). No DiagnosticReports on
# Windows; signatureMatched is always false here (crash evidence, if any,
# would come from the crashDumps sweep in the orchestrator gate).

param(
  [string]$AppBin = "",
  [string]$LogFile = ""
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
  $LogFile = Join-Path $RootDir "traces/test-logs/gpu-wake-park-soak-autotest.log"
}
$ResultsJsonl = Join-Path $RootDir "traces/test-logs/gpu-wake-park-soak-results.jsonl"
New-Item -ItemType Directory -Force (Split-Path -Parent $LogFile) | Out-Null
if (Test-Path $LogFile) { Remove-Item $LogFile -Force }

$Sessions = if ($env:ONWARD_GPU_SOAK_SESSIONS) { [int]$env:ONWARD_GPU_SOAK_SESSIONS } else { 5 }

$env:ONWARD_DEBUG = "1"
$env:ONWARD_AUTOTEST = "1"
$env:ONWARD_AUTOTEST_SUITE = "gpu-wake-park-soak"
$env:ONWARD_AUTOTEST_CWD = $RootDir
$env:ONWARD_AUTOTEST_EXIT = "1"

try {
  for ($session = 1; $session -le $Sessions; $session++) {
    Add-Content $LogFile "=== SOAK session $session/$Sessions ==="
    $sessionLog = Join-Path $env:TEMP ("soak-session-" + [guid]::NewGuid().ToString('N').Substring(0,8) + ".log")
    $started = Get-Date
    try {
      & $AppBin *> $sessionLog
    } catch {
    }
    Get-Content $sessionLog | Add-Content $LogFile
    $measure = (Select-String -Path $sessionLog -Pattern "MEASURE gpu-wake-park-soak.*" | Select-Object -First 1).Matches.Value
    $cycles = if ($measure -match 'cycles=(\d+)') { $Matches[1] } else { "0" }
    $crashes = if ($measure -match 'crashes=(\d+)') { $Matches[1] } else { "0" }
    $firstCrash = if ($measure -match 'firstCrashAtCycle=(\w+)') { $Matches[1] } else { "none" }
    $durationSec = [int]((Get-Date) - $started).TotalSeconds
    $row = '{"electronVersion":"unknown","session":' + $session + ',"cycles":' + $cycles + ',"crashes":' + $crashes + ',"firstCrashAtCycle":"' + $firstCrash + '","parkMsAtCrash":"none","signatureMatched":false,"durationSec":' + $durationSec + '}'
    Add-Content $ResultsJsonl $row
    Write-Host "  session ${session}: cycles=$cycles crashes=$crashes firstCrashAtCycle=$firstCrash"
    Remove-Item $sessionLog -Force -ErrorAction SilentlyContinue
    Start-Sleep -Seconds 2
  }
  Write-Host "gpu-wake-park-soak finished. Results: $ResultsJsonl"
} finally {
  Get-ChildItem -Path $RootDir -Filter "__autotest_*" -ErrorAction SilentlyContinue |
    Remove-Item -Recurse -Force -ErrorAction SilentlyContinue
}
