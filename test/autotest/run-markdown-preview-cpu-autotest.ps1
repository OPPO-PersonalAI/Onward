# SPDX-FileCopyrightText: 2026 OPPO
# SPDX-License-Identifier: Apache-2.0

$ErrorActionPreference = 'Stop'

$RepoRoot = if ($env:REPO_ROOT) { $env:REPO_ROOT } else { (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path }
. (Join-Path $RepoRoot 'test\autotest\Resolve-DevAppBin.ps1')

# MPC_SUITE lets the phase-split wrappers (idle / scroll / editor) write distinct
# log/result files reusing this single body; MPC_ONLY_PHASE (read by the driver)
# selects which phase runs. Defaults keep this runnable whole (all phases).
# Mirror of run-markdown-preview-cpu-autotest.sh's MPC_SUITE / MPC_ONLY_PHASE.
$McpSuite = if ($env:MPC_SUITE) { $env:MPC_SUITE } else { 'markdown-preview-cpu' }
$McpOnlyPhase = if ($env:MPC_ONLY_PHASE) { $env:MPC_ONLY_PHASE } else { '' }

$AppBin = if ($args.Count -ge 1 -and $args[0]) { $args[0] } else { Resolve-DevAppBin -RootDir $RepoRoot }
$LogFile = if ($args.Count -ge 2 -and $args[1]) { $args[1] } else { Join-Path $RepoRoot ('traces\test-logs\' + $McpSuite + '-autotest.log') }
$ResultFile = if ($args.Count -ge 3 -and $args[2]) { $args[2] } else { Join-Path $RepoRoot ('traces\analysis\' + $McpSuite + '-autotest.json') }
$FixtureRootWasCreated = $false
if ($args.Count -ge 4 -and $args[3]) {
  $FixtureRoot = $args[3]
} else {
  $FixtureRoot = Join-Path $env:TEMP ("onward-md-preview-cpu-" + [guid]::NewGuid())
  $FixtureRootWasCreated = $true
}
$UserDataDir = Join-Path $env:TEMP ("onward-md-preview-cpu-userdata-" + [guid]::NewGuid())
$CdpPort = if ($env:CDP_PORT) { $env:CDP_PORT } else { '9339' }
$TargetRelativePath = if ($env:TARGET_RELATIVE_PATH) { $env:TARGET_RELATIVE_PATH } else { 'heavy-preview.md' }

$Branch = Get-SanitizedBranchName -RootDir $RepoRoot
$Version = try { (Get-Content -Raw (Join-Path $RepoRoot 'package.json') | ConvertFrom-Json).version } catch { '0.0.0' }
$AppName = "Under Development $Version-$Branch"

$LogDir = Split-Path -Parent $LogFile
$ResultDir = Split-Path -Parent $ResultFile
$StdErrLogFile = "$LogFile.stderr"
New-Item -ItemType Directory -Path $LogDir -Force | Out-Null
New-Item -ItemType Directory -Path $ResultDir -Force | Out-Null

if (-not $AppBin -or -not (Test-Path $AppBin)) {
  Write-Host "ERROR: app binary not found or not executable: $AppBin"
  Write-Host 'Run a development build first: rm -rf out release && pnpm dist:dev'
  exit 1
}

if (-not (Test-Path $FixtureRoot)) {
  New-Item -ItemType Directory -Path $FixtureRoot -Force | Out-Null
}
New-Item -ItemType Directory -Path $UserDataDir -Force | Out-Null

$AppProcess = $null

try {
  if (Test-Path $LogFile) { Remove-Item $LogFile -Force }
  if (Test-Path $StdErrLogFile) { Remove-Item $StdErrLogFile -Force }
  if (Test-Path $ResultFile) { Remove-Item $ResultFile -Force }

  Copy-Item -Path (Join-Path $RepoRoot 'test\autotest\fixtures\markdown-preview-cpu\*') -Destination $FixtureRoot -Recurse -Force

  Write-Host 'Starting Markdown preview CPU autotest...'
  Write-Host "  Binary:      $AppBin"
  Write-Host "  App name:    $AppName"
  Write-Host "  Fixture CWD: $FixtureRoot"
  Write-Host "  User data:   $UserDataDir"
  Write-Host "  CDP port:    $CdpPort"
  Write-Host "  Target:      $TargetRelativePath"
  Write-Host "  Log:         $LogFile"
  Write-Host "  Result:      $ResultFile"
  Write-Host ''

  Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.ProcessName -eq $AppName } | Stop-Process -ErrorAction SilentlyContinue
  Start-Sleep -Milliseconds 500

  $env:ONWARD_REPO_ROOT = $RepoRoot
  $env:ONWARD_PERF_TRACE = if ($env:ONWARD_PERF_TRACE) { $env:ONWARD_PERF_TRACE } else { '0' }
  $env:ONWARD_USER_DATA_DIR = $UserDataDir
  $env:ONWARD_AUTOTEST = '1'
  $env:ONWARD_AUTOTEST_SUITE = 'markdown-preview-cpu-cdp'
  $env:ONWARD_AUTOTEST_CWD = $FixtureRoot
  $env:ONWARD_AUTOTEST_SKIP_CONSENT = '1'

  $AppProcess = Start-Process -FilePath $AppBin -ArgumentList "--remote-debugging-port=$CdpPort" -RedirectStandardOutput $LogFile -RedirectStandardError $StdErrLogFile -PassThru

  $env:APP_NAME = $AppName
  $env:APP_MAIN_PID = [string]$AppProcess.Id
  $env:CDP_PORT = $CdpPort
  $env:TARGET_RELATIVE_PATH = $TargetRelativePath
  $env:RESULT_PATH = $ResultFile
  # Phase selector (idle / scroll / editor / '' = all); the driver reads it. Set
  # explicitly so the whole-suite run clears any inherited value (parity with .sh).
  $env:MPC_ONLY_PHASE = $McpOnlyPhase

  & node (Join-Path $RepoRoot 'test\autotest\test-markdown-preview-cpu-cdp.mjs')
  $TestExit = $LASTEXITCODE

  Write-Host ''
  Write-Host '=== App log (last 120 lines) ==='
  if (Test-Path $LogFile) { Get-Content $LogFile -Tail 120 | Out-Host }
  if (Test-Path $StdErrLogFile) { Get-Content $StdErrLogFile -Tail 120 | Out-Host }
  Write-Host ''

  if (Test-Path $ResultFile) {
    Write-Host '=== CPU result ==='
    Get-Content $ResultFile | Out-Host
    Write-Host ''
  } else {
    Write-Host "ERROR: missing result file: $ResultFile"
    exit 1
  }

  if ($TestExit -ne 0) {
    Write-Host 'Markdown preview CPU autotest failed'
    exit $TestExit
  }

  Write-Host 'Markdown preview CPU autotest passed'
  Write-Host "  Log:    $LogFile"
  Write-Host "  Result: $ResultFile"
} finally {
  if ($AppProcess -and -not $AppProcess.HasExited) {
    Stop-Process -Id $AppProcess.Id -ErrorAction SilentlyContinue
  }
  if ((Test-Path $FixtureRoot) -and $FixtureRootWasCreated) {
    Remove-Item $FixtureRoot -Recurse -Force -ErrorAction SilentlyContinue
  }
  if (Test-Path $UserDataDir) {
    Remove-Item $UserDataDir -Recurse -Force -ErrorAction SilentlyContinue
  }
}
