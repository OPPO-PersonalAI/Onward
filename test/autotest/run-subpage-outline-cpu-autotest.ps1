# SPDX-FileCopyrightText: 2026 OPPO
# SPDX-License-Identifier: Apache-2.0
#
# Windows twin of run-subpage-outline-cpu-autotest.sh (SOC-*): huge-HTML
# outline cap + windowed outline DOM + renderer CPU decay within 5s of
# exiting editor / git diff subpages. Any behavioural fix here MUST be
# mirrored in the .sh runner and vice versa.

param(
  [string]$AppBin = "",
  [string]$LogFile = "",
  [string]$ResultFile = ""
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

$AppName = [IO.Path]::GetFileNameWithoutExtension($AppBin)
if (-not $LogFile) {
  $LogFile = Join-Path $RootDir "traces/test-logs/subpage-outline-cpu-autotest.log"
}
if (-not $ResultFile) {
  $ResultFile = Join-Path $RootDir "traces/analysis/subpage-outline-cpu-autotest.json"
}
New-Item -ItemType Directory -Force (Split-Path -Parent $LogFile) | Out-Null
New-Item -ItemType Directory -Force (Split-Path -Parent $ResultFile) | Out-Null
if (Test-Path $LogFile) { Remove-Item $LogFile -Force }
if (Test-Path $ResultFile) { Remove-Item $ResultFile -Force }

$CdpPort = if ($env:CDP_PORT) { $env:CDP_PORT } else { "9343" }
$FixtureRoot = Join-Path $env:TEMP ("onward-subpage-outline-cpu-" + [guid]::NewGuid().ToString())
$UserDataDir = Join-Path $env:TEMP ("onward-subpage-outline-cpu-userdata-" + [guid]::NewGuid().ToString())
New-Item -ItemType Directory -Force -Path $FixtureRoot, $UserDataDir | Out-Null

$AppProcess = $null
try {
  node (Join-Path $RootDir "test/autotest/create-subpage-outline-cpu-fixture.mjs") (Join-Path $FixtureRoot "repo")
  if ($LASTEXITCODE -ne 0) { throw "fixture builder failed" }

  Write-Host "Starting subpage outline CPU autotest..."
  Write-Host "  Binary:   $AppBin"
  Write-Host "  Fixture:  $FixtureRoot\repo"
  Write-Host "  CDP port: $CdpPort"

  # Exact-name kill only; never wildcard (process-management safety rule).
  taskkill /IM "$AppName.exe" /F 2>$null | Out-Null
  Start-Sleep -Milliseconds 500

  $env:ONWARD_REPO_ROOT = $RootDir
  $env:ONWARD_USER_DATA_DIR = $UserDataDir
  $env:ONWARD_AUTOTEST = "1"
  $env:ONWARD_AUTOTEST_SUITE = "subpage-outline-cpu-cdp"
  $env:ONWARD_AUTOTEST_CWD = (Join-Path $FixtureRoot "repo")
  $env:ONWARD_AUTOTEST_SKIP_CONSENT = "1"

  $AppProcess = Start-Process -FilePath $AppBin -ArgumentList "--remote-debugging-port=$CdpPort" `
    -RedirectStandardOutput $LogFile -RedirectStandardError "$LogFile.err" -PassThru

  $env:APP_NAME = $AppName
  $env:APP_MAIN_PID = "$($AppProcess.Id)"
  $env:CDP_PORT = $CdpPort
  $env:RESULT_PATH = $ResultFile
  node (Join-Path $RootDir "test/autotest/test-subpage-outline-cpu-cdp.mjs") 2>&1 | Tee-Object -FilePath $LogFile -Append
  $TestExit = $LASTEXITCODE

  if (Test-Path $ResultFile) {
    Write-Host "=== Result JSON ==="
    Get-Content $ResultFile
  }

  if ($TestExit -ne 0) {
    Write-Error "Subpage outline CPU autotest FAILED. Log: $LogFile"
    exit $TestExit
  }
  Write-Host "Subpage outline CPU autotest passed"
} finally {
  if ($AppProcess -and -not $AppProcess.HasExited) {
    Stop-Process -Id $AppProcess.Id -Force -ErrorAction SilentlyContinue
  }
  Remove-Item -Recurse -Force $FixtureRoot, $UserDataDir -ErrorAction SilentlyContinue
  Get-ChildItem -Path $RootDir -Filter "__autotest_*" -ErrorAction SilentlyContinue |
    Remove-Item -Recurse -Force -ErrorAction SilentlyContinue
}
