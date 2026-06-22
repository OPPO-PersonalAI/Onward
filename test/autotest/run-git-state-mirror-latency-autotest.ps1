# SPDX-FileCopyrightText: 2026 OPPO
# SPDX-License-Identifier: Apache-2.0

# Windows / PowerShell mirror of run-git-state-mirror-latency-autotest.sh.
# Extracts the committed fixture tarballs into a per-run temp dir, launches
# the dev build with autotest env wiring, and surfaces the same pass/fail
# semantics. Only PowerShell 5.1+ / pwsh 7+ is supported (per CLAUDE.md).

$ErrorActionPreference = 'Stop'

$RepoRoot = if ($env:REPO_ROOT) { $env:REPO_ROOT } else { (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path }
. (Join-Path $RepoRoot 'test\autotest\Resolve-DevAppBin.ps1')

# LATENCY_SUITE lets the split wrappers (static / gsm17 / gsm18 / injection) write
# distinct log files reusing this body; LATENCY_MODE selects which passes run.
# Defaults keep this runnable whole (baseline all-groups + the 3 injection passes).
# Mirror of run-git-state-mirror-latency-autotest.sh's LATENCY_SUITE / LATENCY_MODE.
$LatencySuite = if ($env:LATENCY_SUITE) { $env:LATENCY_SUITE } else { 'git-state-mirror-latency' }
$LatencyMode  = if ($env:LATENCY_MODE)  { $env:LATENCY_MODE }  else { '' }

$AppBin = if ($args.Count -ge 1 -and $args[0]) { $args[0] } else { Resolve-DevAppBin -RootDir $RepoRoot }
$LogFile = if ($args.Count -ge 2 -and $args[1]) { $args[1] } else { Join-Path $RepoRoot ('traces\test-logs\' + $LatencySuite + '-autotest.log') }

$LogDir = Split-Path -Parent $LogFile
if (-not (Test-Path $LogDir)) {
  New-Item -ItemType Directory -Path $LogDir -Force | Out-Null
}

if (-not $AppBin -or -not (Test-Path $AppBin)) {
  Write-Host "ERROR: app binary not found or not executable: $AppBin"
  Write-Host "Run a development build first: rm -rf out release; pnpm dist:dev"
  exit 1
}

$UserDataRoot = Join-Path $env:TEMP ("onward-gsm-userdata-" + [guid]::NewGuid())
$FixtureTmp  = Join-Path $env:TEMP ("onward-gsm-fixture-"  + [guid]::NewGuid())
$FixtureSrc  = Join-Path $RepoRoot 'test\autotest\fixtures\git-state-mirror-latency'

New-Item -ItemType Directory -Path $UserDataRoot -Force | Out-Null
New-Item -ItemType Directory -Path $FixtureTmp  -Force | Out-Null

try {
  # Extract every committed fixture tarball into the per-run staging dir.
  Get-ChildItem -Path $FixtureSrc -Filter '*.tar.gz' | ForEach-Object {
    & tar.exe -xzf $_.FullName -C $FixtureTmp
    if ($LASTEXITCODE -ne 0) {
      throw "tar -xzf failed for $($_.Name)"
    }
  }

  if (-not (Test-Path (Join-Path $FixtureTmp 'repo-A'))) {
    Write-Host 'ERROR: fixture extraction failed; expected repo-A directory'
    Get-ChildItem $FixtureSrc | Out-String | Write-Host
    exit 1
  }

  # Inject `tempRoot` into the manifest copy used by the autotest TS.
  $ManifestPath = Join-Path $FixtureTmp 'manifest.json'
  $manifest = Get-Content (Join-Path $FixtureSrc 'manifest.json') | ConvertFrom-Json
  $manifest | Add-Member -NotePropertyName tempRoot -NotePropertyValue $FixtureTmp -Force
  $manifestJson = $manifest | ConvertTo-Json -Depth 5
  # Windows PowerShell 5.1's `Set-Content -Encoding UTF8` prepends a UTF-8 BOM,
  # which Node's JSON.parse rejects (-> GSM-00 'manifest absent or unparseable').
  # Write UTF-8 WITHOUT a BOM so the autotest TS can parse it on every platform.
  [System.IO.File]::WriteAllText($ManifestPath, $manifestJson, (New-Object System.Text.UTF8Encoding $false))

  if (Test-Path $LogFile) { Remove-Item $LogFile -Force }

  @(
    'Starting Git State Mirror latency autotest...'
    "  Binary:         $AppBin"
    "  Fixture src:    $FixtureSrc"
    "  Fixture tmp:    $FixtureTmp"
    "  Manifest:       $ManifestPath"
    "  User data root: $UserDataRoot"
    "  Log:            $LogFile"
    ''
  ) | Add-Content -Path $LogFile

  # Per-pass watchdog: ONWARD_AUTOTEST_EXIT=1 makes the suite exit on its own,
  # but EDR-slow git can stretch a pass; kill if it overruns so the runner can't
  # hang. Generous because each pass drives many real git ops on a fixture repo.
  $PassTimeoutSec = if ($env:GSM_PASS_TIMEOUT_SEC) { [int]$env:GSM_PASS_TIMEOUT_SEC } else { 300 }

  function Invoke-GsmPass {
    param(
      [string]$Label,
      [string]$FailureEnvName = '',
      [string]$Group = ''
    )
    $UserDataDir = Join-Path $UserDataRoot $Label
    New-Item -ItemType Directory -Path $UserDataDir -Force | Out-Null

    Add-Content -Path $LogFile -Value ''
    Add-Content -Path $LogFile -Value "=== Git State Mirror latency pass: $Label ==="

    $env:ONWARD_DEBUG = '1'
    $env:ONWARD_PERF_TRACE = '1'
    $env:ONWARD_REPO_ROOT = $RepoRoot
    $env:ONWARD_USER_DATA_DIR = $UserDataDir
    $env:ONWARD_AUTOTEST = '1'
    $env:ONWARD_AUTOTEST_SUITE = 'git-state-mirror-latency'
    $env:ONWARD_AUTOTEST_CWD = (Join-Path $FixtureTmp 'repo-A')
    $env:ONWARD_AUTOTEST_FIXTURE_EXTRA = $ManifestPath
    $env:ONWARD_AUTOTEST_EXIT = '1'
    Remove-Item Env:\ONWARD_AUTOTEST_GSM_WATCHER_FAIL_SUBSCRIBE_ONCE -ErrorAction SilentlyContinue
    Remove-Item Env:\ONWARD_AUTOTEST_GSM_WATCHER_FAIL_CALLBACK_ONCE -ErrorAction SilentlyContinue
    Remove-Item Env:\ONWARD_AUTOTEST_GSM_WATCHER_SILENT -ErrorAction SilentlyContinue
    Remove-Item Env:\ONWARD_AUTOTEST_GSM_LATENCY_GROUP -ErrorAction SilentlyContinue
    if ($Group) {
      $env:ONWARD_AUTOTEST_GSM_LATENCY_GROUP = $Group
    }
    if ($FailureEnvName) {
      Set-Item -Path "Env:\$FailureEnvName" -Value '1'
    }

    # A native WINDOWS-subsystem (GUI) Electron exe detaches from the console when
    # launched via '&', so '& $AppBin *>> $LogFile' captures NOTHING (the prior
    # bug: zero GSM markers in the log). Start-Process -RedirectStandard* forces a
    # pipe even for a GUI app (parity with the working repo-prewarm .ps1 runner).
    $passOut = Join-Path $UserDataDir 'pass-stdout.log'
    $passErr = Join-Path $UserDataDir 'pass-stderr.log'
    $proc = Start-Process -FilePath $AppBin -PassThru -RedirectStandardOutput $passOut -RedirectStandardError $passErr
    $exited = $proc.WaitForExit($PassTimeoutSec * 1000)
    if (-not $exited) {
      Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
      Add-Content -Path $LogFile -Value "(pass '$Label' exceeded ${PassTimeoutSec}s watchdog and was killed)"
    }
    Get-Content $passOut -ErrorAction SilentlyContinue | Add-Content -Path $LogFile
    Get-Content $passErr -ErrorAction SilentlyContinue | Add-Content -Path $LogFile
  }

  # LATENCY_MODE selects which passes run (mirror of the .sh case): a baseline
  # group ('static'/'gsm17'/'gsm18') runs one baseline pass with the group env;
  # 'injection' runs the 3 watcher-failure passes; '' (default) runs everything.
  switch ($LatencyMode) {
    { $_ -in 'static', 'gsm17', 'gsm18' } {
      Invoke-GsmPass -Label "baseline-$LatencyMode" -Group $LatencyMode
    }
    'injection' {
      Invoke-GsmPass -Label 'subscribe-failure' -FailureEnvName 'ONWARD_AUTOTEST_GSM_WATCHER_FAIL_SUBSCRIBE_ONCE'
      Invoke-GsmPass -Label 'callback-failure' -FailureEnvName 'ONWARD_AUTOTEST_GSM_WATCHER_FAIL_CALLBACK_ONCE'
      Invoke-GsmPass -Label 'silent-watcher' -FailureEnvName 'ONWARD_AUTOTEST_GSM_WATCHER_SILENT'
    }
    default {
      Invoke-GsmPass -Label 'baseline'
      Invoke-GsmPass -Label 'subscribe-failure' -FailureEnvName 'ONWARD_AUTOTEST_GSM_WATCHER_FAIL_SUBSCRIBE_ONCE'
      Invoke-GsmPass -Label 'callback-failure' -FailureEnvName 'ONWARD_AUTOTEST_GSM_WATCHER_FAIL_CALLBACK_ONCE'
      # Silent watcher (subscribed, no error, drops every event) -- the production
      # failure mode. Proves the always-on reconcile heartbeat still refreshes (GSM-19).
      Invoke-GsmPass -Label 'silent-watcher' -FailureEnvName 'ONWARD_AUTOTEST_GSM_WATCHER_SILENT'
    }
  }

  Write-Host ''
  Write-Host '=== Test log (last 60 lines) ==='
  Get-Content $LogFile -Tail 60 | Out-Host

  if (Select-String -Path $LogFile -Pattern '\[AutoTest\] FAIL' -Quiet) {
    Write-Host 'Git State Mirror latency autotest failed'
    Write-Host ''
    Write-Host '=== Failure details ==='
    Select-String -Path $LogFile -Pattern '\[AutoTest\] FAIL' | ForEach-Object { Write-Host $_.Line }
    exit 1
  }

  function Require-Marker {
    param([string]$Pattern, [string]$Message)
    # -SimpleMatch: the markers contain '-'/':' which are harmless in regex, but a
    # literal match is clearer and avoids any future regex-special surprise.
    if (-not (Select-String -Path $LogFile -Pattern $Pattern -SimpleMatch -Quiet)) {
      Write-Host $Message
      Get-Content $LogFile -Tail 40 | Out-Host
      exit 1
    }
  }

  # Completion markers, gated by mode so each split runner only requires the
  # markers its own group emits (mirror of the .sh case). GSM-00 + :done bracket
  # every mode; the watcher-injection markers only exist when the injection passes run.
  Require-Marker 'GSM-00-fixture-loaded' 'Missing GSM-00 marker; the test may not have executed correctly'
  Require-Marker 'git-state-mirror-latency:done' 'Missing git-state-mirror-latency:done marker; the suite did not finish cleanly'
  switch ($LatencyMode) {
    'static' {
      Require-Marker 'GSM-13-trace-marker-mirror-events-expected' 'Missing GSM-13 marker; the mirror trace coverage test did not run to completion'
      Require-Marker 'GSM-14-force-refresh-bumps-generation' 'Missing GSM-14 marker; the generation refresh test did not run to completion'
    }
    'gsm17' {
      Require-Marker 'GSM-13-trace-marker-mirror-events-expected' 'Missing GSM-13 marker; the mirror trace coverage test did not run to completion'
      Require-Marker 'GSM-17-two-tasks-same-repo-consistent-status-cycles' 'Missing GSM-17 marker; the two-Task same-repo status consistency test did not run to completion'
      Require-Marker 'GSM-17-0-clean-after-real-commit' 'Missing GSM-17 commit-clean marker; the real commit transition coverage did not run to completion'
    }
    'gsm18' {
      Require-Marker 'GSM-13-trace-marker-mirror-events-expected' 'Missing GSM-13 marker; the mirror trace coverage test did not run to completion'
      Require-Marker 'GSM-18-cross-tab-two-tabs-commit-to-clean' 'Missing GSM-18 marker; the cross-tab two-tabs commit-to-clean coverage did not run to completion'
    }
    'injection' {
      Require-Marker 'GSM-15-watcher-subscribe-failure-recovers' 'Missing GSM-15 marker; the subscribe failure recovery test did not run to completion'
      Require-Marker 'GSM-16-watcher-callback-failure-recovers' 'Missing GSM-16 marker; the callback failure recovery test did not run to completion'
      Require-Marker 'GSM-19-silent-watcher-reconcile-refresh' 'Missing GSM-19 marker; the silent-watcher reconcile-heartbeat test did not run to completion'
      Require-Marker 'autotest watcher failure injection active' 'Missing watcher failure injection log marker'
    }
    default {
      Require-Marker 'GSM-13-trace-marker-mirror-events-expected' 'Missing GSM-13 marker; the mirror trace coverage test did not run to completion'
      Require-Marker 'GSM-14-force-refresh-bumps-generation' 'Missing GSM-14 marker; the generation refresh test did not run to completion'
      Require-Marker 'GSM-17-two-tasks-same-repo-consistent-status-cycles' 'Missing GSM-17 marker; the two-Task same-repo status consistency test did not run to completion'
      Require-Marker 'GSM-17-0-clean-after-real-commit' 'Missing GSM-17 commit-clean marker; the real commit transition coverage did not run to completion'
      Require-Marker 'GSM-18-cross-tab-two-tabs-commit-to-clean' 'Missing GSM-18 marker; the cross-tab two-tabs commit-to-clean coverage did not run to completion'
      Require-Marker 'GSM-15-watcher-subscribe-failure-recovers' 'Missing GSM-15 marker; the subscribe failure recovery test did not run to completion'
      Require-Marker 'GSM-16-watcher-callback-failure-recovers' 'Missing GSM-16 marker; the callback failure recovery test did not run to completion'
      Require-Marker 'GSM-19-silent-watcher-reconcile-refresh' 'Missing GSM-19 marker; the silent-watcher reconcile-heartbeat test did not run to completion'
      Require-Marker 'autotest watcher failure injection active' 'Missing watcher failure injection log marker'
    }
  }

  Write-Host "Git State Mirror latency autotest passed ($LatencySuite)"
  Write-Host "  Log: $LogFile"

} finally {
  if (Test-Path $UserDataRoot) { Remove-Item $UserDataRoot -Recurse -Force -ErrorAction SilentlyContinue }
  if (Test-Path $FixtureTmp)  { Remove-Item $FixtureTmp  -Recurse -Force -ErrorAction SilentlyContinue }
  Get-ChildItem -Path $RepoRoot -Filter '__autotest_*' -Force | ForEach-Object {
    Remove-Item $_.FullName -Recurse -Force -ErrorAction SilentlyContinue
  }
}
