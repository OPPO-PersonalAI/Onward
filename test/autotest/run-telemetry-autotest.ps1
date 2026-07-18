# SPDX-FileCopyrightText: 2026 OPPO
# SPDX-License-Identifier: Apache-2.0
#
# Windows parity runner for run-telemetry-autotest.sh — keep the two in
# logical lockstep (same launches, same assertion IDs, same log contracts).
#   Launch A (TEL-01..17 + runner TEL-11/14b/15/17c): local pipeline with the
#     `disabled` sentinel key. Zero network.
#   Launch B (TEL-12a..c, TEL-16): outbox remediation + live lane against a
#     local mock ingest server (127.0.0.1 only).
#   Launch C (TEL-13a..b): unreachable ingest host — backlog must survive.

param(
  [string]$AppBin = "",
  [string]$LogFile = ""
)

$RootDir = Split-Path -Parent (Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path))
. (Join-Path $RootDir "test\autotest\Resolve-DevAppBin.ps1")

if (-not $AppBin) { $AppBin = Resolve-DevAppBin -RootDir $RootDir }
if (-not $AppBin -or -not (Test-Path $AppBin)) {
  Write-Error "App binary not found. Run: rm -rf out release && pnpm dist:dev"
  exit 1
}

if (-not $LogFile) {
  $LogFile = Join-Path $RootDir "traces/test-logs/telemetry-autotest.log"
}
$LogFileB = $LogFile -replace '\.log$', '-remediation-ack.log'
$LogFileC = $LogFile -replace '\.log$', '-remediation-nack.log'
New-Item -ItemType Directory -Force (Split-Path -Parent $LogFile) | Out-Null
Remove-Item $LogFile, $LogFileB, $LogFileC -Force -ErrorAction SilentlyContinue

$Scratch = Join-Path $env:TEMP ("onward-telemetry-autotest-" + [guid]::NewGuid().ToString())
New-Item -ItemType Directory -Force -Path $Scratch | Out-Null
$MockProcess = $null
$script:Failed = $false

function Fail-Case([string]$CaseId, [string[]]$Messages) {
  Write-Host "[AutoTest] FAIL $CaseId"
  foreach ($m in $Messages) { Write-Host "  $m" }
  $script:Failed = $true
}

# Telemetry-specific env is set per launch and MUST be cleared between
# launches — PowerShell env vars persist for the whole script process.
function Clear-LaunchEnv {
  foreach ($name in @(
    "ONWARD_DEBUG", "ONWARD_AUTOTEST", "ONWARD_AUTOTEST_SUITE", "ONWARD_AUTOTEST_CWD",
    "ONWARD_AUTOTEST_EXIT", "ONWARD_USER_DATA_DIR", "ONWARD_TELEMETRY_RESET_CONSENT",
    "ONWARD_AUTOTEST_TELEMETRY_KEEP_OUTBOX", "ONWARD_TELEMETRY_FAST_HEARTBEAT",
    "ONWARD_TELEMETRY_FORCE_UPLOAD", "ONWARD_TELEMETRY_POSTHOG_KEY", "ONWARD_TELEMETRY_POSTHOG_HOST"
  )) {
    Remove-Item "Env:$name" -ErrorAction SilentlyContinue
  }
}

function Set-CommonEnv([string]$UserData) {
  $env:ONWARD_DEBUG = "1"
  $env:ONWARD_AUTOTEST = "1"
  $env:ONWARD_AUTOTEST_SUITE = "telemetry"
  $env:ONWARD_AUTOTEST_CWD = $RootDir
  $env:ONWARD_AUTOTEST_EXIT = "1"
  $env:ONWARD_USER_DATA_DIR = $UserData
  $env:ONWARD_TELEMETRY_RESET_CONSENT = "1"
  $env:ONWARD_TELEMETRY_FAST_HEARTBEAT = "1"
}

function Seed-Backlog([string]$UserData) {
  $seedScript = @'
const fs = require("fs"), path = require("path")
const dir = process.argv[1]
const base = Date.now() - 2 * 24 * 60 * 60 * 1000
const mk = (offsetMs, name) => JSON.stringify({
  timestamp: new Date(base + offsetMs).toISOString(),
  name,
  properties: { action: "backlog" },
  common: {
    instanceId: "autotest-backlog-instance",
    sessionId: "autotest-backlog-session",
    appVersion: "0.0.0-autotest",
    platform: process.platform
  }
})
fs.mkdirSync(dir, { recursive: true })
fs.writeFileSync(path.join(dir, "telemetry-events.jsonl"),
  mk(0, "prompt/use") + "\n" + mk(1000, "session/start") + "\n")
'@
  & node -e $seedScript $UserData
}

try {
  # -------------------------------------------------------------------
  # Launch A — local pipeline + not-configured fallback (no network)
  # -------------------------------------------------------------------
  Write-Host "Starting telemetry end-to-end autotest (launch A: local pipeline)..."
  $UserDataA = Join-Path $Scratch "userdata-a"
  New-Item -ItemType Directory -Force -Path $UserDataA | Out-Null
  Clear-LaunchEnv
  Set-CommonEnv $UserDataA
  $env:ONWARD_TELEMETRY_FORCE_UPLOAD = "1"
  $env:ONWARD_TELEMETRY_POSTHOG_KEY = "disabled"
  try { & $AppBin *> $LogFile } catch {}

  if (Select-String -Path $LogFile -Pattern "\[AutoTest\] FAIL" -Quiet) {
    Write-Error "Telemetry autotest FAILED (launch A suite). Log: $LogFile"
    Get-Content $LogFile -Tail 120
    exit 1
  }
  if (-not (Select-String -Path $LogFile -Pattern "telemetry-test:done" -Quiet)) {
    Write-Error "Telemetry autotest did not complete (launch A). Log: $LogFile"
    Get-Content $LogFile -Tail 120
    exit 1
  }

  if (Select-String -Path $LogFile -Pattern "\[Telemetry\] PostHog API key not configured" -Quiet) {
    Write-Host "[AutoTest] PASS TEL-11-upload-client-not-configured-fallback"
  } else {
    Fail-Case "TEL-11-upload-client-not-configured-fallback" @("Expected not-configured log in $LogFile")
  }

  $DailyJson = Join-Path $UserDataA "telemetry-daily.json"
  $dailyOk = (Test-Path $DailyJson) -and
    (Select-String -Path $DailyJson -Pattern '"gpuCrashCount"' -Quiet) -and
    (Select-String -Path $DailyJson -Pattern '"updateCheckCount"' -Quiet) -and
    (Select-String -Path $DailyJson -Pattern '"dropdownToolsCodeAgent":2' -Quiet)
  if ($dailyOk) {
    Write-Host "[AutoTest] PASS TEL-15-daily-summary-extended-domains"
  } else {
    Fail-Case "TEL-15-daily-summary-extended-domains" @("Expected extended counter domains in $DailyJson")
  }

  $OutboxA = Join-Path $UserDataA "telemetry-events.jsonl"
  $firstUseCount = 0
  if (Test-Path $OutboxA) {
    $firstUseCount = (Select-String -Path $OutboxA -Pattern '"name":"feature/first-use"' -AllMatches | Measure-Object).Count
  }
  if ($firstUseCount -eq 9) {
    Write-Host "[AutoTest] PASS TEL-14b-first-use-exact-count"
  } else {
    Fail-Case "TEL-14b-first-use-exact-count" @("Expected exactly 9 feature/first-use lines in $OutboxA, got $firstUseCount")
  }

  $featureUseOk = (Test-Path $DailyJson) -and
    (Select-String -Path $DailyJson -Pattern '"git-diff-stage":3' -Quiet) -and
    (Select-String -Path $DailyJson -Pattern '"outline":2' -Quiet) -and
    (Select-String -Path $DailyJson -Pattern '"schedule-create":1' -Quiet) -and
    (Select-String -Path $DailyJson -Pattern '"invalid":1' -Quiet)
  if ($featureUseOk) {
    Write-Host "[AutoTest] PASS TEL-17c-feature-use-aggregated"
  } else {
    Fail-Case "TEL-17c-feature-use-aggregated" @("Expected featureUse counts in $DailyJson")
  }

  # -------------------------------------------------------------------
  # Mock ingest server shared by launches B and C
  # -------------------------------------------------------------------
  $MockReceived = Join-Path $Scratch "mock-received.jsonl"
  $MockPortFile = Join-Path $Scratch "mock-port"
  $mockScript = @'
const http = require("http"), zlib = require("zlib"), fs = require("fs")
const outFile = process.argv[1], portFile = process.argv[2]
const server = http.createServer((req, res) => {
  const chunks = []
  req.on("data", (c) => chunks.push(c))
  req.on("end", () => {
    let body = Buffer.concat(chunks)
    try {
      if (req.headers["content-encoding"] === "gzip") body = zlib.gunzipSync(body)
    } catch {}
    fs.appendFileSync(outFile,
      JSON.stringify({ url: req.url, body: body.toString("utf8").slice(0, 20000) }) + "\n")
    res.writeHead(200, { "Content-Type": "application/json" })
    res.end(JSON.stringify({ status: "Ok" }))
  })
})
server.listen(0, "127.0.0.1", () => fs.writeFileSync(portFile, String(server.address().port)))
'@
  $MockProcess = Start-Process -FilePath "node" -ArgumentList @("-e", $mockScript, $MockReceived, $MockPortFile) -NoNewWindow -PassThru

  $portReady = $false
  for ($i = 0; $i -lt 50; $i++) {
    if ((Test-Path $MockPortFile) -and (Get-Item $MockPortFile).Length -gt 0) { $portReady = $true; break }
    Start-Sleep -Milliseconds 100
  }
  if (-not $portReady) {
    Write-Error "mock ingest server did not report a port"
    exit 1
  }
  $MockPort = (Get-Content $MockPortFile -Raw).Trim()

  # -------------------------------------------------------------------
  # Launch B — remediation ACK path
  # -------------------------------------------------------------------
  Write-Host "Starting telemetry autotest (launch B: outbox remediation, acknowledged)..."
  $UserDataB = Join-Path $Scratch "userdata-b"
  Seed-Backlog $UserDataB
  Clear-LaunchEnv
  Set-CommonEnv $UserDataB
  $env:ONWARD_AUTOTEST_TELEMETRY_KEEP_OUTBOX = "1"
  $env:ONWARD_TELEMETRY_POSTHOG_KEY = "phc_autotest_local_mock"
  $env:ONWARD_TELEMETRY_POSTHOG_HOST = "http://127.0.0.1:$MockPort"
  try { & $AppBin *> $LogFileB } catch {}

  if (Select-String -Path $LogFileB -Pattern "\[AutoTest\] FAIL" -Quiet) {
    Write-Error "Telemetry autotest (launch B) suite FAILED. Log: $LogFileB"
    exit 1
  }

  $OutboxB = Join-Path $UserDataB "telemetry-events.jsonl"
  if ((Test-Path $OutboxB) -and (Select-String -Path $OutboxB -Pattern "autotest-backlog-instance" -Quiet)) {
    Fail-Case "TEL-12a-backlog-cleared-after-ack" @("seeded backlog lines still present in $OutboxB")
  } else {
    Write-Host "[AutoTest] PASS TEL-12a-backlog-cleared-after-ack"
  }

  if (Select-String -Path $LogFileB -Pattern "Outbox remediation: 2 backlog event\(s\) uploaded and cleared" -Quiet) {
    Write-Host "[AutoTest] PASS TEL-12b-remediation-log-line"
  } else {
    Fail-Case "TEL-12b-remediation-log-line" @("expected remediation success log in $LogFileB")
  }

  $mockOk = (Test-Path $MockReceived) -and
    (Select-String -Path $MockReceived -Pattern "historical_migration" -Quiet) -and
    (Select-String -Path $MockReceived -Pattern "autotest-backlog-instance" -Quiet)
  if ($mockOk) {
    Write-Host "[AutoTest] PASS TEL-12c-mock-received-historical-batch"
  } else {
    Fail-Case "TEL-12c-mock-received-historical-batch" @("mock did not receive the historical_migration batch")
  }

  $liveOk = (Select-String -Path $LogFileB -Pattern "Outbox live lane:" -Quiet) -and
    (Select-String -Path $MockReceived -Pattern "session/start" -Quiet) -and
    (Select-String -Path $MockReceived -Pattern "feature/first-use" -Quiet)
  if ($liveOk) {
    Write-Host "[AutoTest] PASS TEL-16-live-lane-uploaded"
  } else {
    Fail-Case "TEL-16-live-lane-uploaded" @("live lane did not upload/clear against the mock")
  }

  # -------------------------------------------------------------------
  # Launch C — remediation NACK path (unreachable host)
  # -------------------------------------------------------------------
  Write-Host "Starting telemetry autotest (launch C: outbox remediation, not acknowledged)..."
  $UserDataC = Join-Path $Scratch "userdata-c"
  Seed-Backlog $UserDataC
  Clear-LaunchEnv
  Set-CommonEnv $UserDataC
  $env:ONWARD_AUTOTEST_TELEMETRY_KEEP_OUTBOX = "1"
  $env:ONWARD_TELEMETRY_POSTHOG_KEY = "phc_autotest_unreachable"
  $env:ONWARD_TELEMETRY_POSTHOG_HOST = "http://127.0.0.1:1"
  try { & $AppBin *> $LogFileC } catch {}

  if (Select-String -Path $LogFileC -Pattern "\[AutoTest\] FAIL" -Quiet) {
    Write-Error "Telemetry autotest (launch C) suite FAILED. Log: $LogFileC"
    exit 1
  }

  $OutboxC = Join-Path $UserDataC "telemetry-events.jsonl"
  if ((Test-Path $OutboxC) -and (Select-String -Path $OutboxC -Pattern "autotest-backlog-instance" -Quiet)) {
    Write-Host "[AutoTest] PASS TEL-13a-backlog-retained-without-ack"
  } else {
    Fail-Case "TEL-13a-backlog-retained-without-ack" @("seeded backlog vanished from $OutboxC without an acknowledgement")
  }

  if (Select-String -Path $LogFileC -Pattern "uploaded and cleared" -Quiet) {
    Fail-Case "TEL-13b-no-false-ack" @("launch C logged a success against an unreachable host")
  } else {
    Write-Host "[AutoTest] PASS TEL-13b-no-false-ack"
  }

  if ($script:Failed) {
    Write-Error "Telemetry autotest FAILED. Logs: $LogFile $LogFileB $LogFileC"
    exit 1
  }
  Write-Host ""
  Write-Host "Telemetry autotest PASSED. Logs: $LogFile $LogFileB $LogFileC"
} finally {
  Clear-LaunchEnv
  if ($MockProcess -and -not $MockProcess.HasExited) {
    Stop-Process -Id $MockProcess.Id -Force -ErrorAction SilentlyContinue
  }
  if ($env:ONWARD_AUTOTEST_KEEP_TMP -eq "1") {
    Write-Host "ONWARD_AUTOTEST_KEEP_TMP=1 - keeping scratch dir: $Scratch"
  } else {
    Remove-Item $Scratch -Recurse -Force -ErrorAction SilentlyContinue
  }
}
