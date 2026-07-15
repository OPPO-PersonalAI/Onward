# SPDX-FileCopyrightText: 2026 OPPO
# SPDX-License-Identifier: Apache-2.0

$ErrorActionPreference = "Stop"

$RootDir = Split-Path -Parent (Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path))
$Group = if ($env:ONWARD_SUBPAGE_NAVIGATION_GROUP) { $env:ONWARD_SUBPAGE_NAVIGATION_GROUP } else { "core" }
if ($Group -notin @("core", "html", "pdf", "epub")) {
  Write-Error "Unsupported subpage navigation group: $Group"
}
. (Join-Path $RootDir "test\autotest\Resolve-DevAppBin.ps1")
$DefaultExe = Resolve-DevAppBin -RootDir $RootDir
$AppExe = if ($args.Count -ge 1 -and $args[0]) { $args[0] } else { $DefaultExe }
$AppProcessName = [System.IO.Path]::GetFileNameWithoutExtension($AppExe)
$LogFile = if ($args.Count -ge 2 -and $args[1]) {
  $args[1]
} else {
  Join-Path $RootDir "traces\test-logs\subpage-navigation-$Group-autotest.log"
}

if (-not $AppExe -or -not (Test-Path $AppExe)) {
  Write-Error "App executable not found: $AppExe`nRun a development build first: remove the out and release directories, then run pnpm dist:dev"
}

if (Test-Path $LogFile) {
  Remove-Item $LogFile -Force
}
New-Item -ItemType Directory -Force -Path (Split-Path -Parent $LogFile) | Out-Null

$UserDataDir = Join-Path $env:TEMP ("onward-subpage-nav-userdata-" + [guid]::NewGuid().ToString("N"))
$FixtureBase = Join-Path $env:TEMP ("onward-subpage-nav-fixtures-" + [guid]::NewGuid().ToString("N"))

$ExpectedResult = switch ($Group) {
  "core" { "SNJ-CODE-HISTORY-WARM" }
  "html" { "SNJ-HTML-HISTORY-WARM-5X" }
  "pdf" { "SNJ-PDF-HISTORY-WARM-5X" }
  "epub" { "SNJ-EPUB-HISTORY-WARM-5X" }
}

try {
  New-Item -ItemType Directory -Force -Path $UserDataDir, $FixtureBase | Out-Null
  $UserDataDir = (Resolve-Path -LiteralPath $UserDataDir).Path
  $FixtureBase = (Resolve-Path -LiteralPath $FixtureBase).Path

  & node (Join-Path $RootDir "test\autotest\create-subpage-navigation-fixture.mjs") --output $FixtureBase
  if ($LASTEXITCODE -ne 0) {
    throw "Subpage navigation fixture builder failed with exit code $LASTEXITCODE"
  }

  $env:ONWARD_DEBUG = "1"
  $env:ONWARD_USER_DATA_DIR = $UserDataDir
  $env:ONWARD_AUTOTEST = "1"
  $env:ONWARD_AUTOTEST_SUITE = "subpage-navigation;group=$Group"
  $env:ONWARD_AUTOTEST_CWD = $RootDir
  $env:ONWARD_AUTOTEST_FIXTURE_EXTRA = $FixtureBase
  $env:ONWARD_AUTOTEST_EXIT = "1"

  Get-Process -Name $AppProcessName -ErrorAction SilentlyContinue |
    Where-Object { $_.Path -eq $AppExe } |
    Stop-Process -Force -ErrorAction SilentlyContinue
  Start-Sleep -Milliseconds 500

  & $AppExe *> $LogFile
  $AppExitCode = $LASTEXITCODE

  $content = Get-Content $LogFile -Raw
  if ($AppExitCode -ne 0) {
    Get-Content $LogFile -Tail 120 | Write-Host
    throw "Subpage navigation app exited with code $AppExitCode. Log: $LogFile"
  }

  if ($content -notmatch "\[AutoTest\] === Autotest Completed ===") {
    Get-Content $LogFile -Tail 120 | Write-Host
    throw "Subpage navigation autotest did not reach its completion summary. Log: $LogFile"
  }

  if ($content -match "\[AutoTest\] FAIL") {
    Get-Content $LogFile -Tail 120 | Write-Host
    Write-Error "Subpage navigation autotest failed. Log: $LogFile"
  }

  if ($content -match "totalFailed: [1-9]") {
    Get-Content $LogFile -Tail 120 | Write-Host
    Write-Error "Subpage navigation autotest reported failed cases in the summary. Log: $LogFile"
  }

  if ($content -notmatch [regex]::Escape($ExpectedResult)) {
    Get-Content $LogFile -Tail 120 | Write-Host
    Write-Error "Missing $ExpectedResult result; the $Group group may not have executed correctly. Log: $LogFile"
  }

  Write-Host "Subpage navigation autotest passed ($Group). Log: $LogFile"
}
finally {
  Get-Process -Name $AppProcessName -ErrorAction SilentlyContinue |
    Where-Object { $_.Path -eq $AppExe } |
    Stop-Process -Force -ErrorAction SilentlyContinue
  Remove-Item Env:\ONWARD_DEBUG -ErrorAction SilentlyContinue
  Remove-Item Env:\ONWARD_USER_DATA_DIR -ErrorAction SilentlyContinue
  Remove-Item Env:\ONWARD_AUTOTEST -ErrorAction SilentlyContinue
  Remove-Item Env:\ONWARD_AUTOTEST_SUITE -ErrorAction SilentlyContinue
  Remove-Item Env:\ONWARD_AUTOTEST_CWD -ErrorAction SilentlyContinue
  Remove-Item Env:\ONWARD_AUTOTEST_FIXTURE_EXTRA -ErrorAction SilentlyContinue
  Remove-Item Env:\ONWARD_AUTOTEST_EXIT -ErrorAction SilentlyContinue
  Remove-Item -Recurse -Force $UserDataDir, $FixtureBase -ErrorAction SilentlyContinue
}
