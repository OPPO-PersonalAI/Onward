# SPDX-FileCopyrightText: 2026 OPPO
# SPDX-License-Identifier: Apache-2.0

# Prompt input long-tail latency autotest runner (Windows)
# For macOS/Linux, use run-prompt-input-longtail-autotest.sh

param(
  [string]$AppBin,
  [string]$LogFile,
  [string]$ResultFile,
  [string]$CompareBaselineFile,
  [string]$CompareProfile
)

$ErrorActionPreference = "Stop"

$RootDir = Split-Path -Parent (Split-Path -Parent (Split-Path -Parent $PSCommandPath))
. (Join-Path $RootDir "test\autotest\Resolve-DevAppBin.ps1")

function Get-JsonPayloadAfterMarker {
  param(
    [Parameter(Mandatory = $true)][string]$Text,
    [Parameter(Mandatory = $true)][string]$Marker
  )

  $markerIndex = $Text.LastIndexOf($Marker, [System.StringComparison]::Ordinal)
  if ($markerIndex -lt 0) {
    return $null
  }

  $start = $Text.IndexOf("{", $markerIndex + $Marker.Length, [System.StringComparison]::Ordinal)
  if ($start -lt 0) {
    return $null
  }

  $depth = 0
  $inString = $false
  $escape = $false
  for ($index = $start; $index -lt $Text.Length; $index++) {
    $char = $Text[$index]
    if ($inString) {
      if ($escape) {
        $escape = $false
      } elseif ($char -eq '\') {
        $escape = $true
      } elseif ($char -eq '"') {
        $inString = $false
      }
      continue
    }

    if ($char -eq '"') {
      $inString = $true
    } elseif ($char -eq "{") {
      $depth += 1
    } elseif ($char -eq "}") {
      $depth -= 1
      if ($depth -eq 0) {
        return $Text.Substring($start, $index - $start + 1)
      }
    }
  }

  return $null
}

function Write-TruncatedLogTail {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)][string]$Marker,
    [int]$Lines = 180
  )

  Get-Content $Path -Tail $Lines | ForEach-Object {
    $line = $_
    $markerIndex = $line.IndexOf($Marker, [System.StringComparison]::Ordinal)
    if ($markerIndex -lt 0) {
      Write-Host $line
      return
    }

    $prefixEnd = [Math]::Min($line.Length, $markerIndex + $Marker.Length)
    $prefixStart = [Math]::Max(0, $prefixEnd - 220)
    $prefix = $line.Substring($prefixStart, $prefixEnd - $prefixStart)
    Write-Host "$prefix ... <truncated prompt input longtail JSON>"
  }
}

if (-not $AppBin) {
  $AppBin = Resolve-DevAppBin -RootDir $RootDir
}

$ResultDir = Join-Path $RootDir "test\autotest\results\prompt-input-longtail"
New-Item -ItemType Directory -Force $ResultDir | Out-Null

if (-not $LogFile) {
  $RepoRoot = Split-Path -Parent (Split-Path -Parent (Split-Path -Parent $PSCommandPath))
$LogFile = Join-Path $RepoRoot "traces/test-logs/onward-prompt-input-longtail-autotest.log"
New-Item -ItemType Directory -Force (Split-Path -Parent $LogFile) | Out-Null
}

if (-not $ResultFile) {
  $stamp = Get-Date -Format "yyyyMMdd-HHmmss"
  $ResultFile = Join-Path $ResultDir "baseline-$stamp.json"
}

if (-not $CompareBaselineFile -and $env:ONWARD_PERF_COMPARE_BASELINE) {
  $CompareBaselineFile = $env:ONWARD_PERF_COMPARE_BASELINE
}

if (-not $CompareProfile) {
  $CompareProfile = if ($env:ONWARD_PERF_COMPARE_PROFILE) { $env:ONWARD_PERF_COMPARE_PROFILE } else { "optimization" }
}

if (-not $AppBin -or -not (Test-Path $AppBin)) {
  Write-Error "App binary not found: $AppBin`nRun a development build first: rm -rf out release && pnpm dist:dev"
  exit 1
}

if (Test-Path $LogFile) {
  try {
    Remove-Item -LiteralPath $LogFile -Force -ErrorAction Stop
  } catch {
    $fallbackStamp = Get-Date -Format "yyyyMMdd-HHmmss"
    $LogFile = Join-Path $env:TEMP "onward-prompt-input-longtail-autotest-$fallbackStamp.log"
  }
}

Write-Host "Preparing prompt input longtail fixture..."
$prepareScript = Join-Path $RootDir "test\autotest\prepare-prompt-input-longtail-fixture.mjs"
$fixtureSummary = node $prepareScript | Out-String
Write-Host $fixtureSummary

$WorkDir = Join-Path $RootDir "test\autotest\fixtures\prompt-input-longtail\workdir"
$UserDataDir = Join-Path $RootDir "test\autotest\fixtures\prompt-input-longtail\user-data"
$rootFullPath = [System.IO.Path]::GetFullPath($RootDir).TrimEnd('\')
$userDataFullPath = [System.IO.Path]::GetFullPath($UserDataDir)
$rootPrefix = "$rootFullPath\"
if (-not $userDataFullPath.StartsWith($rootPrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
  throw "Refusing to delete userData outside repo: $userDataFullPath"
}
if (Test-Path -LiteralPath $userDataFullPath) {
  Remove-Item -LiteralPath $userDataFullPath -Recurse -Force
}
New-Item -ItemType Directory -Force $userDataFullPath | Out-Null
$UserDataDir = $userDataFullPath

Write-Host "Starting Prompt Input Longtail autotest..."
Write-Host "  Binary:   $AppBin"
Write-Host "  CWD:      $WorkDir"
Write-Host "  UserData: $UserDataDir"
Write-Host "  Platform: Windows"
Write-Host "  Log:      $LogFile"
Write-Host "  Result:   $ResultFile"
Write-Host ""

$ProcessName = [System.IO.Path]::GetFileNameWithoutExtension($AppBin)
$StdErrFile = "$LogFile.err"
$existing = Get-Process | Where-Object { $_.ProcessName -eq $ProcessName }
if ($existing) {
  $existing | Stop-Process -Force
  Start-Sleep -Milliseconds 500
}

$env:ONWARD_DEBUG = "1"
$env:ONWARD_PERF_TRACE = "1"
$env:ONWARD_AUTOTEST = "1"
$env:ONWARD_AUTOTEST_SUITE = "prompt-input-longtail"
$env:ONWARD_AUTOTEST_CWD = $WorkDir
$env:ONWARD_AUTOTEST_EXIT = "1"
$env:ONWARD_USER_DATA_DIR = $UserDataDir

try {
  $marker = "[PromptInputLongtail:RESULT]"
  $proc = Start-Process -FilePath $AppBin -PassThru -RedirectStandardOutput $LogFile -RedirectStandardError $StdErrFile -NoNewWindow
  # 280 s (runner parity with the .sh): stays UNDER the regression override
  # (300 s budget ceiling) so a hung run fails here with a readable log
  # instead of an opaque orchestrator force-kill. Measured 152.7 s end-to-end
  # (2026-07-22, local Windows).
  $deadline = (Get-Date).AddSeconds(280)
  $foundMarker = $false
  while ((Get-Date) -lt $deadline) {
    if (Test-Path $LogFile) {
      $foundMarker = [bool](Select-String -Path $LogFile -Pattern ([Regex]::Escape($marker)) | Select-Object -Last 1)
      if ($foundMarker) {
        break
      }
    }
    if ($proc.HasExited) {
      break
    }
    Start-Sleep -Seconds 2
  }

  if ($foundMarker) {
    $graceDeadline = (Get-Date).AddSeconds(15)
    while ((Get-Date) -lt $graceDeadline -and -not $proc.HasExited) {
      if ((Test-Path $LogFile) -and ((Get-Content $LogFile -Tail 80) -match "\[AutoTest\] (PASS|FAIL)|\[AutoTest\] done")) {
        break
      }
      Start-Sleep -Milliseconds 500
    }
  }

  if (-not $proc.HasExited) {
    $running = Get-Process -Id $proc.Id -ErrorAction SilentlyContinue
    if ($running -and $running.ProcessName -eq $ProcessName) {
      Stop-Process -Id $proc.Id -Force
    }
  }

  try {
    $proc.WaitForExit(10000) | Out-Null
  } catch {
    Write-Host "Warning: failed to wait for autotest process exit: $_" -ForegroundColor Yellow
  }
} finally {
  Remove-Item Env:\ONWARD_DEBUG -ErrorAction SilentlyContinue
  Remove-Item Env:\ONWARD_PERF_TRACE -ErrorAction SilentlyContinue
  Remove-Item Env:\ONWARD_AUTOTEST -ErrorAction SilentlyContinue
  Remove-Item Env:\ONWARD_AUTOTEST_SUITE -ErrorAction SilentlyContinue
  Remove-Item Env:\ONWARD_AUTOTEST_CWD -ErrorAction SilentlyContinue
  Remove-Item Env:\ONWARD_AUTOTEST_EXIT -ErrorAction SilentlyContinue
  Remove-Item Env:\ONWARD_USER_DATA_DIR -ErrorAction SilentlyContinue
  $remaining = Get-Process | Where-Object { $_.ProcessName -eq $ProcessName }
  if ($remaining) {
    $remaining | Stop-Process -Force
    Start-Sleep -Milliseconds 500
  }
}

Write-Host ""
Write-Host "=== Test log (last 180 lines) ==="
$marker = "[PromptInputLongtail:RESULT]"
Write-TruncatedLogTail -Path $LogFile -Marker $marker -Lines 180
Write-Host ""
if (Test-Path $StdErrFile) {
  Write-Host "=== Test stderr log (last 80 lines) ==="
  Get-Content $StdErrFile -Tail 80
  Write-Host ""
}

$logRaw = Get-Content $LogFile -Raw
$json = Get-JsonPayloadAfterMarker -Text $logRaw -Marker $marker
if (-not $json) {
  Write-Host "Missing prompt input longtail result marker." -ForegroundColor Red
  if ($logRaw -match "\[AutoTest\] FAIL") {
    Select-String -Path $LogFile -Pattern "\[AutoTest\] FAIL" | ForEach-Object { Write-Host $_.Line -ForegroundColor Red }
  }
  exit 1
}

$parsed = $json | ConvertFrom-Json
$parsed | ConvertTo-Json -Depth 80 | Set-Content -Path $ResultFile -Encoding UTF8

Write-Host "Prompt Input Longtail result captured" -ForegroundColor Green
Write-Host "  Log:    $LogFile"
Write-Host "  Result: $ResultFile"
Write-Host ""
Write-Host "=== Longtail summary ==="
foreach ($scenario in $parsed.scenarios) {
  $latency = $scenario.promptInput.inputLatency
  Write-Host ("  {0}: avg={1}ms stddev={2}ms p95={3}ms p99={4}ms p999={5}ms max={6}ms over250={7} over500={8} fps={9} ipc/s={10}" -f `
    $scenario.id, `
    $latency.avgMs, `
    $latency.stddevMs, `
    $latency.p95Ms, `
    $latency.p99Ms, `
    $latency.p999Ms, `
    $latency.maxMs, `
    $scenario.promptInput.over250Ms, `
    $scenario.promptInput.over500Ms, `
    $scenario.perf.avgFps, `
    $scenario.perf.avgIpcMsgPerSec)
}
Write-Host ("  stall windows: {0}" -f $parsed.derived.stallWindowCount)
Write-Host ("  worst outlier: {0}" -f ($parsed.derived.worstOutlier | ConvertTo-Json -Compress))
Write-Host ("  worst bucket:  {0}" -f ($parsed.derived.worstBucket | ConvertTo-Json -Compress))
Write-Host ("  main loop:     {0}" -f ($parsed.derived.mainEventLoop | ConvertTo-Json -Compress))
Write-Host ("  trace:         {0}" -f $parsed.perfTrace.logPath)

if ($CompareBaselineFile) {
  Write-Host ""
  Write-Host "=== Performance comparison gate ==="
  node (Join-Path $RootDir "test\autotest\compare-performance-baseline.mjs") `
    --suite prompt-input-longtail `
    --profile $CompareProfile `
    --before $CompareBaselineFile `
    --after $ResultFile
}

if ($logRaw -match "\[AutoTest\] FAIL") {
  Write-Host "Prompt Input Longtail autotest FAILED" -ForegroundColor Red
  Select-String -Path $LogFile -Pattern "\[AutoTest\] FAIL" | ForEach-Object { Write-Host $_.Line -ForegroundColor Red }
  exit 1
}

Write-Host "Prompt Input Longtail autotest PASSED" -ForegroundColor Green
