# SPDX-FileCopyrightText: 2026 OPPO
# SPDX-License-Identifier: Apache-2.0
#
# GPU occlusion-flip stress — Windows twin of
# run-gpu-occlusion-flip-stress-autotest.sh. Drives N real window
# hide/showInactive cycles + periodic backgroundThrottling toggles and
# counts GPU child-process-gone events. MEASUREMENT harness: the gate is
# "harness completed", never the crash count. The ANGLE-Metal crash class
# is macOS-specific, so Windows runs are expected to measure zero — they
# still validate the harness wiring cross-platform. Override cycles with
# ONWARD_GPU_FLIP_STRESS_CYCLES.

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
  $LogFile = Join-Path $RootDir "traces/test-logs/gpu-occlusion-flip-stress-autotest.log"
}
New-Item -ItemType Directory -Force (Split-Path -Parent $LogFile) | Out-Null
if (Test-Path $LogFile) {
  Remove-Item $LogFile -Force
}

Write-Host "Starting gpu-occlusion-flip-stress autotest..."

$env:ONWARD_DEBUG = "1"
$env:ONWARD_AUTOTEST = "1"
$env:ONWARD_AUTOTEST_SUITE = "gpu-occlusion-flip-stress"
$env:ONWARD_AUTOTEST_CWD = $RootDir
$env:ONWARD_AUTOTEST_EXIT = "1"

try {
  try {
    & $AppBin *> $LogFile
  } catch {
  }

  if (Select-String -Path $LogFile -Pattern "\[AutoTest\] FAIL" -Quiet) {
    Write-Error "gpu-occlusion-flip-stress autotest FAILED. Log: $LogFile"
    Get-Content $LogFile -Tail 120
    exit 1
  }

  if (-not (Select-String -Path $LogFile -Pattern "gpu-occlusion-flip-stress-test:done" -Quiet)) {
    Write-Error "gpu-occlusion-flip-stress autotest did not complete. Log: $LogFile"
    Get-Content $LogFile -Tail 120
    exit 1
  }

  Write-Host "=== Measurement ==="
  Select-String -Path $LogFile -Pattern "MEASURE gpu-flip-stress" | ForEach-Object { $_.Line }
  Write-Host "gpu-occlusion-flip-stress autotest PASSED. Log: $LogFile"
} finally {
  # Sweep any legacy __autotest_* fixtures from the repo root
  # (defence-in-depth; this suite creates none itself).
  Get-ChildItem -Path $RootDir -Filter "__autotest_*" -ErrorAction SilentlyContinue |
    Remove-Item -Recurse -Force -ErrorAction SilentlyContinue
}
