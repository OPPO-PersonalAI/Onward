# SPDX-FileCopyrightText: 2026 OPPO
# SPDX-License-Identifier: Apache-2.0

$ErrorActionPreference = "Stop"

$RootDir = Resolve-Path (Join-Path $PSScriptRoot "../..")
. (Join-Path $RootDir "test\autotest\Resolve-DevAppBin.ps1")
$DefaultApp = Resolve-DevAppBin -RootDir $RootDir
$AppBin = if ($args.Count -ge 1 -and $args[0]) { $args[0] } else { $DefaultApp }
$LogFile = if ($args.Count -ge 2 -and $args[1]) { $args[1] } else { "$env:TEMP\onward-project-editor-multi-terminal-scope-autotest.log" }

if (-not $AppBin -or -not (Test-Path $AppBin)) {
  throw "ERROR: app binary not found: $AppBin`nRun a development build first: remove the out and release directories, then run pnpm dist:dev"
}

if (Test-Path $LogFile) {
  Remove-Item $LogFile -Force
}

$env:ONWARD_DEBUG = "1"
$env:ONWARD_AUTOTEST = "1"
$env:ONWARD_AUTOTEST_SUITE = "project-editor-multi-terminal-scope"
$env:ONWARD_AUTOTEST_CWD = $RootDir
$env:ONWARD_AUTOTEST_EXIT = "1"

& $AppBin *> $LogFile

$content = Get-Content $LogFile -Raw
if ($content -match "\[AutoTest\] FAIL") {
  Write-Host "ProjectEditor same-directory multi-terminal isolation test failed. Log: $LogFile" -ForegroundColor Red
  Get-Content $LogFile -Tail 160
  exit 1
}

if ($content -notmatch "PEMS-30-cwd-drift-no-subdir-key") {
  Write-Host "Missing PEMS-30-cwd-drift-no-subdir-key result. Log: $LogFile" -ForegroundColor Red
  Get-Content $LogFile -Tail 160
  exit 1
}

Write-Host "ProjectEditor same-directory multi-terminal isolation test passed. Log: $LogFile" -ForegroundColor Green
