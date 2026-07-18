/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

import { app, BrowserWindow } from 'electron'
import { createHash } from 'crypto'
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { basename, dirname, isAbsolute, join } from 'path'
import { spawn, execFileSync } from 'child_process'
import { performanceTrace } from './performance-trace'
import { PERF_TRACE_EVENT } from '../../src/utils/perf-trace-names'
import { getAppInfo, type ReleaseChannel, type ReleaseOs } from './app-info'
import { compareVersions, parseVersion } from './update-version'
import { getTelemetryService } from './telemetry/telemetry-service'
import { IPC } from '../shared/ipc-channels'
import {
  DownloadError,
  type DownloadErrorCode,
  type DownloadProgress,
  downloadFileWithRetry,
  fetchUpdateResource,
  formatDownloadBytes,
  getPartialDownloadPath
} from './update-download'

export type UpdatePhase = 'idle' | 'checking' | 'available' | 'downloading' | 'downloaded' | 'up-to-date' | 'unsupported' | 'error'

export interface UpdateStatus {
  phase: UpdatePhase
  supported: boolean
  currentVersion: string
  currentTag: string | null
  currentChannel: ReleaseChannel
  currentReleaseOs: ReleaseOs
  targetVersion: string | null
  targetTag: string | null
  downloadedFileName: string | null
  lastCheckedAt: number | null
  error: string | null
  errorCode: DownloadErrorCode | null
  bannerDismissed: boolean
  downloadProgress: DownloadProgress | null
}

interface UpdateManifest {
  channel: ReleaseChannel
  version: string
  tag: string
  platform: ReleaseOs
  arch: 'arm64' | 'x64'
  artifactName: string
  artifactUrl: string
  sha256: string
  releaseNotes: string | null
  publishedAt: string
}

interface DownloadedUpdate {
  manifest: UpdateManifest
  artifactPath: string
}

const DEFAULT_UPDATE_CHECK_INTERVAL_MS = 60 * 60 * 1000
const DEFAULT_UPDATE_REQUEST_TIMEOUT_MS = 60 * 1000
const LOG_PREFIX = '[UpdateService]'
const PENDING_UPDATE_MARKER_SCHEMA_VERSION = 2
const MAX_PENDING_UPDATE_MARKER_AGE_MS = 60 * 60 * 1000
const MAX_PENDING_UPDATE_STARTUP_ATTEMPTS = 1

const RELAUNCH_ENV_KEYS = [
  'ONWARD_USER_DATA_DIR',
  'ONWARD_DEBUG',
  'ONWARD_UPDATE_CHECK_INTERVAL_MS',
  'ONWARD_UPDATE_BASE_URL',
  'ONWARD_AUTOTEST',
  'ONWARD_AUTOTEST_CWD',
  'ONWARD_AUTOTEST_EXIT',
  'ONWARD_DEBUG_CAPTURE',
  'ONWARD_FEATURE_GIT_DIFF_PERFORMANCE_DIAGNOSTICS'
] as const

/** Pending update marker written before launching the installer script. */
interface PendingUpdateInfo {
  schemaVersion: 2
  artifactPath: string
  artifactSha256: string
  artifactName: string
  installDir: string
  execPath: string
  logPath: string
  timestamp: number
  targetVersion: string
  attempts: number
}

/** Append a timestamped line to the install log (non-blocking, never throws). */
function appendToInstallLog(logPath: string, message: string): void {
  try {
    const dir = dirname(logPath)
    mkdirSync(dir, { recursive: true })
    const ts = new Date().toISOString().replace('T', ' ').replace(/\.\d+Z$/, '')
    appendFileSync(logPath, `${ts} ${message}\n`, 'utf-8')
  } catch { /* non-critical */ }
}

function safeRemoveFile(filePath: string): void {
  try { rmSync(filePath, { force: true }) } catch {}
}

function resolveCurrentInstallPath(): string | null {
  const exePath = app.getPath('exe')
  if (process.platform === 'darwin') {
    // macOS: exe is at Foo.app/Contents/MacOS/Foo, install path is Foo.app.
    return dirname(dirname(dirname(exePath)))
  }
  if (process.platform === 'win32') {
    // Windows NSIS per-user: exe is at %LOCALAPPDATA%\Programs\Onward 2\Onward 2.exe.
    return dirname(exePath)
  }
  return null
}

function shellEscape(value: string): string {
  return `'${value.replace(/'/g, `'\"'\"'`)}'`
}

function powershellEscape(value: string): string {
  return `'${value.replace(/'/g, "''")}'`
}

function resolveUpdateLogPath(): string {
  return join(app.getPath('userData'), 'updates', 'install.log')
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

function getExpectedArtifactExtension(platform: ReleaseOs): '.zip' | '.exe' | null {
  if (platform === 'windows') return '.exe'
  if (platform === 'macos' || platform === 'linux') return '.zip'
  return null
}

function isSafeArtifactFileName(value: string): boolean {
  return value === basename(value) &&
    !value.includes('/') &&
    !value.includes('\\')
}

function isSafeArtifactName(value: string, platform: ReleaseOs): boolean {
  const expectedExtension = getExpectedArtifactExtension(platform)
  return isSafeArtifactFileName(value) &&
    expectedExtension !== null &&
    value.toLowerCase().endsWith(expectedExtension)
}

function isSafeLegacyWindowsZipArtifactName(value: string): boolean {
  return isSafeArtifactFileName(value) && value.toLowerCase().endsWith('.zip')
}

function parseGitHubReleaseDownloadUrl(rawUrl: string): {
  owner: string
  repo: string
  tag: string
  assetName: string
} | null {
  try {
    const url = new URL(rawUrl)
    if (url.protocol !== 'https:' || url.hostname.toLowerCase() !== 'github.com') {
      return null
    }

    const parts = url.pathname.split('/').filter(Boolean).map((part) => decodeURIComponent(part))
    if (parts.length < 6 || parts[2] !== 'releases' || parts[3] !== 'download') {
      return null
    }

    return {
      owner: parts[0],
      repo: parts[1],
      tag: parts[4],
      assetName: parts.slice(5).join('/')
    }
  } catch {
    return null
  }
}

function buildGitHubReleaseDownloadUrl(
  release: {
    owner: string
    repo: string
    tag: string
  },
  assetName: string
): string {
  const parts = [
    release.owner,
    release.repo,
    'releases',
    'download',
    release.tag,
    assetName
  ].map((part) => encodeURIComponent(part))
  return `https://github.com/${parts.join('/')}`
}

function buildGitHubExpandedAssetsUrl(release: {
  owner: string
  repo: string
  tag: string
}): string {
  const parts = [
    release.owner,
    release.repo,
    'releases',
    'expanded_assets',
    release.tag
  ].map((part) => encodeURIComponent(part))
  return `https://github.com/${parts.join('/')}`
}

function findGitHubExpandedAssetSha256(html: string, assetName: string): string | null {
  let searchFrom = 0
  while (searchFrom < html.length) {
    const assetIndex = html.indexOf(assetName, searchFrom)
    if (assetIndex === -1) return null

    const rowStart = html.lastIndexOf('<li', assetIndex)
    const rowEnd = html.indexOf('</li>', assetIndex)
    searchFrom = assetIndex + assetName.length

    if (rowStart === -1 || rowEnd === -1 || rowEnd <= rowStart) {
      continue
    }

    const row = html.slice(rowStart, rowEnd)
    if (!row.includes('/releases/download/') || !row.includes(assetName)) {
      continue
    }

    const match = /sha256:([a-f0-9]{64})/i.exec(row)
    if (match) {
      return match[1].toLowerCase()
    }
  }

  return null
}

function normalizeWindowsPathForCompare(value: string): string {
  return value.replace(/[\\/]+$/, '').toLowerCase()
}

function validatePendingUpdateInfo(raw: unknown): { info: PendingUpdateInfo | null; error: string | null } {
  if (!raw || typeof raw !== 'object') {
    return { info: null, error: 'marker is not an object' }
  }

  const value = raw as Partial<PendingUpdateInfo>
  const requiredStrings: Array<keyof Pick<PendingUpdateInfo, 'artifactPath' | 'artifactSha256' | 'artifactName' | 'installDir' | 'execPath' | 'logPath' | 'targetVersion'>> = [
    'artifactPath',
    'artifactSha256',
    'artifactName',
    'installDir',
    'execPath',
    'logPath',
    'targetVersion'
  ]

  if (value.schemaVersion !== PENDING_UPDATE_MARKER_SCHEMA_VERSION) {
    return { info: null, error: `unsupported marker schema version: ${String(value.schemaVersion)}` }
  }
  for (const key of requiredStrings) {
    if (!isNonEmptyString(value[key])) {
      return { info: null, error: `missing or invalid marker field: ${key}` }
    }
  }
  if (!Number.isFinite(value.timestamp) || typeof value.timestamp !== 'number') {
    return { info: null, error: 'missing or invalid marker timestamp' }
  }
  if (!Number.isInteger(value.attempts) || typeof value.attempts !== 'number' || value.attempts < 0) {
    return { info: null, error: 'missing or invalid marker attempts' }
  }
  if (!/^[a-f0-9]{64}$/i.test(value.artifactSha256!)) {
    return { info: null, error: 'invalid artifact checksum in marker' }
  }
  if (!isSafeArtifactName(value.artifactName!, 'windows')) {
    return { info: null, error: 'invalid artifact name in marker' }
  }
  for (const key of ['artifactPath', 'installDir', 'execPath', 'logPath'] as const) {
    if (!isAbsolute(value[key]!)) {
      return { info: null, error: `marker path must be absolute: ${key}` }
    }
  }

  return { info: value as PendingUpdateInfo, error: null }
}

function writePendingUpdateInfo(markerPath: string, info: PendingUpdateInfo): void {
  mkdirSync(dirname(markerPath), { recursive: true })
  writeFileSync(markerPath, `${JSON.stringify(info, null, 2)}\n`, 'utf-8')
}

/** Build PowerShell $env:KEY = 'VALUE' statements for preserved env vars. */
function buildEnvSetStatements(): string {
  return RELAUNCH_ENV_KEYS
    .map((key) => {
      const value = process.env[key]
      if (!value) return null
      return `$env:${key} = ${powershellEscape(value)}`
    })
    .filter((value): value is string => Boolean(value))
    .join('\n')
}

/**
 * Generate the Windows installer runner. Windows updates are applied by the
 * NSIS installer instead of renaming the live installation directory, because
 * Electron child processes and security tools can keep files locked after quit.
 */
function buildWindowsUpdateScript(params: {
  installDir: string
  execPath: string
  installerPath: string
  installerSha256: string
  parentPid: number
  stagingRoot: string
  logPath: string
  markerPath: string
  lockPath: string
  targetVersion: string
  envSetStatements: string
}): string {
  return [
    '$ErrorActionPreference = "Stop"',
    `$installDir = ${powershellEscape(params.installDir)}`,
    `$execPath = ${powershellEscape(params.execPath)}`,
    `$installerPath = ${powershellEscape(params.installerPath)}`,
    `$installerSha256 = ${powershellEscape(params.installerSha256)}`,
    `$parentPid = ${params.parentPid}`,
    `$stagingRoot = ${powershellEscape(params.stagingRoot)}`,
    `$logPath = ${powershellEscape(params.logPath)}`,
    `$markerPath = ${powershellEscape(params.markerPath)}`,
    `$lockPath = ${powershellEscape(params.lockPath)}`,
    `$targetVersion = ${powershellEscape(params.targetVersion)}`,
    '$exeName = Split-Path $execPath -Leaf',
    '$appProcessNameForQuery = $exeName.Replace("\'", "\'\'")',
    '$lockCreated = $false',
    '$parentExited = $false',
    '',
    'function Write-Log($msg) {',
    '    $dir = Split-Path $logPath -Parent',
    '    if (-not (Test-Path -LiteralPath $dir)) { New-Item -Path $dir -ItemType Directory -Force | Out-Null }',
    '    $ts = Get-Date -Format "yyyy-MM-dd HH:mm:ss"',
    '    Add-Content -LiteralPath $logPath -Value "$ts $msg" -ErrorAction SilentlyContinue',
    '}',
    '',
    'function Clear-Marker {',
    '    Remove-Item -LiteralPath $markerPath -Force -ErrorAction SilentlyContinue',
    '}',
    '',
    'function Normalize-PathForCompare($value) {',
    '    try {',
    '        return [System.IO.Path]::GetFullPath([string]$value).TrimEnd([System.IO.Path]::DirectorySeparatorChar, [System.IO.Path]::AltDirectorySeparatorChar).ToLowerInvariant()',
    '    } catch {',
    '        return ([string]$value).TrimEnd([System.IO.Path]::DirectorySeparatorChar, [System.IO.Path]::AltDirectorySeparatorChar).ToLowerInvariant()',
    '    }',
    '}',
    '',
    'function Get-AppProcesses {',
    '    $targetPath = Normalize-PathForCompare -value $execPath',
    '    $items = @(Get-CimInstance -ClassName Win32_Process -Filter ("Name = \'{0}\'" -f $appProcessNameForQuery) -ErrorAction SilentlyContinue)',
    '    return @($items | Where-Object { $_.ProcessId -ne $PID -and $_.ExecutablePath -and (Normalize-PathForCompare -value $_.ExecutablePath) -eq $targetPath })',
    '}',
    '',
    'function Wait-ForAppProcessesToExit($timeoutSeconds) {',
    '    $deadline = (Get-Date).AddSeconds($timeoutSeconds)',
    '    $lastLogAt = [datetime]::MinValue',
    '    while ((Get-Date) -lt $deadline) {',
    '        $processes = @(Get-AppProcesses)',
    '        if ($processes.Count -eq 0) { return $true }',
    '        if (((Get-Date) - $lastLogAt).TotalSeconds -ge 5) {',
    '            $ids = (($processes | ForEach-Object { $_.ProcessId }) -join ",")',
    '            Write-Log "Waiting for app process(es) to exit: $ids"',
    '            $lastLogAt = Get-Date',
    '        }',
    '        Start-Sleep -Seconds 1',
    '    }',
    '    return $false',
    '}',
    '',
    'function Relaunch-CurrentApp($reason) {',
    '    if (-not (Test-Path -LiteralPath $execPath)) {',
    '        Write-Log "Cannot relaunch ${reason}: executable not found at $execPath"',
    '        return',
    '    }',
    '    try {',
    params.envSetStatements,
    '        Write-Log "Relaunching ${reason}."',
    '        Start-Process -FilePath $execPath',
    '    } catch {',
    '        Write-Log "Failed to relaunch ${reason}: $_"',
    '    }',
    '}',
    '',
    'try {',
    '    Write-Log "Starting Windows installer helper. PID=$PID Target=$targetVersion"',
    '',
    '    $lockDir = Split-Path $lockPath -Parent',
    '    if (-not (Test-Path -LiteralPath $lockDir)) { New-Item -Path $lockDir -ItemType Directory -Force | Out-Null }',
    '    if (Test-Path -LiteralPath $lockPath) {',
    '        try {',
    '            $lockItem = Get-Item -LiteralPath $lockPath -ErrorAction Stop',
    '            if (((Get-Date) - $lockItem.LastWriteTime).TotalMinutes -gt 30) {',
    '                Write-Log "Removing stale install lock: $lockPath"',
    '                Remove-Item -LiteralPath $lockPath -Force -ErrorAction Stop',
    '            }',
    '        } catch {',
    '            Write-Log "Failed to inspect stale install lock: $_"',
    '        }',
    '    }',
    '    try {',
    '        New-Item -Path $lockPath -ItemType File -Value "$PID" -ErrorAction Stop | Out-Null',
    '        $lockCreated = $true',
    '    } catch {',
    '        Write-Log "Another update install helper is already active: $_"',
    '        exit 0',
    '    }',
    '',
    '    # Wait for parent process to exit',
    '    try {',
    '        $proc = Get-Process -Id $parentPid -ErrorAction SilentlyContinue',
    '        if ($proc) {',
    '            Write-Log "Waiting for parent process ($parentPid) to exit."',
    '            $parentExited = $proc.WaitForExit(120000)',
    '            if (-not $parentExited) { throw "Parent process $parentPid did not exit within 120s." }',
    '        } else {',
    '            $parentExited = $true',
    '        }',
    '    } catch { throw }',
    '    Write-Log "Parent process exited."',
    '',
    '    if (-not (Wait-ForAppProcessesToExit 120)) {',
    '        $remaining = ((@(Get-AppProcesses) | ForEach-Object { $_.ProcessId }) -join ",")',
    '        throw "Timed out waiting for app processes to exit. Remaining PIDs: $remaining"',
    '    }',
    '    Write-Log "No matching app processes remain."',
    '',
    '    # Wait briefly for Windows to release file handles held by exited processes.',
    '    Start-Sleep -Seconds 2',
    '',
    '    # Verify installer before running code downloaded from the network.',
    '    Write-Log "Verifying Windows installer checksum."',
    '    $actualSha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $installerPath).Hash.ToLowerInvariant()',
    '    if ($actualSha256 -ne $installerSha256.ToLowerInvariant()) {',
    '        throw "Installer checksum mismatch: expected=$installerSha256 actual=$actualSha256"',
    '    }',
    '',
    '    Write-Log "Running Windows installer silently: $installerPath"',
    '    $installerArguments = @("/S", "/D=$installDir")',
    '    $installerProcess = Start-Process -FilePath $installerPath -ArgumentList $installerArguments -Wait -PassThru',
    '    $exitCode = $installerProcess.ExitCode',
    '    Write-Log "Windows installer exited with code $exitCode."',
    '    if ($null -ne $exitCode -and $exitCode -ne 0) {',
    '        throw "Windows installer exited with code $exitCode."',
    '    }',
    '    if (-not (Test-Path -LiteralPath $execPath)) {',
    '        throw "Installed app is missing expected executable: $execPath"',
    '    }',
    '',
    '    # Mark success BEFORE relaunching, because the new app reads and',
    '    # clears install.log on startup (reportPreviousInstallResult).',
    '    Write-Log "Update installed successfully."',
    '    Clear-Marker',
    '',
    '    # Relaunch the updated app.',
    '    Relaunch-CurrentApp "updated app"',
    '',
    '    # Cleanup (non-critical, runs after relaunch).',
    '    Remove-Item -LiteralPath $installerPath -Force -ErrorAction SilentlyContinue',
    '} catch {',
    '    Write-Log "Update install failed: $_"',
    '    Clear-Marker',
    '    $remainingProcesses = @(Get-AppProcesses)',
    '    if ($parentExited -and $remainingProcesses.Count -eq 0) {',
    '        Relaunch-CurrentApp "existing app after update failure"',
    '    } else {',
    '        Write-Log "Skipping relaunch because an app process may still be running."',
    '    }',
    '} finally {',
    '    if ($lockCreated) {',
    '        Remove-Item -LiteralPath $lockPath -Force -ErrorAction SilentlyContinue',
    '    }',
    '}'
  ].join('\n')
}

function windowsCommandQuote(value: string): string {
  return `"${value.replace(/"/g, '\\"')}"`
}

function launchWindowsUpdateScript(params: {
  stagingRoot: string
  scriptPath: string
  logPath: string
}): boolean {
  const psPath = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')

  // Strategy 1: WMI process creation.
  // Win32_Process.Create() spawns the process through the WMI service, outside
  // the caller's Job Object. This helps the helper survive Electron shutdown.
  const workerCmd = [
    windowsCommandQuote(psPath),
    '-ExecutionPolicy Bypass',
    '-NoProfile',
    '-WindowStyle Hidden',
    '-File',
    windowsCommandQuote(params.scriptPath)
  ].join(' ')
  const launcherPath = join(params.stagingRoot, 'launch.ps1')
  const launcherContent = [
    '$ErrorActionPreference = "Stop"',
    `$result = ([wmiclass]'Win32_Process').Create(${powershellEscape(workerCmd)})`,
    'if ($result.ReturnValue -ne 0) {',
    `    Add-Content -LiteralPath ${powershellEscape(params.logPath)} -Value "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') WMI Create failed: ReturnValue=$($result.ReturnValue)" -ErrorAction SilentlyContinue`,
    '    exit 1',
    '}'
  ].join('\n')
  writeFileSync(launcherPath, launcherContent, { encoding: 'utf-8' })

  try {
    const wmiStart = Date.now()
    execFileSync(psPath, ['-ExecutionPolicy', 'Bypass', '-NoProfile', '-File', launcherPath], {
      windowsHide: true,
      stdio: 'ignore',
      timeout: 15000
    })
    performanceTrace.record(PERF_TRACE_EVENT.MAIN_UPDATER_SPAWN, {
      strategy: 'wmi',
      platform: 'win32',
      ok: true,
      durationMs: Date.now() - wmiStart
    })
    appendToInstallLog(params.logPath, 'Node.js: WMI launch succeeded.')
    return true
  } catch (err) {
    performanceTrace.record(PERF_TRACE_EVENT.MAIN_UPDATER_SPAWN, {
      strategy: 'wmi',
      platform: 'win32',
      ok: false,
      error: String(err)
    })
    appendToInstallLog(params.logPath, `Node.js: WMI launch failed: ${err}. Trying batch launcher.`)
  }

  // Strategy 2: Batch file with cmd.exe /c start (legacy fallback).
  const batPath = join(params.stagingRoot, 'up.bat')
  const batContent = `@echo off\r\nstart "" /min "${psPath}" -ExecutionPolicy Bypass -NoProfile -File "${params.scriptPath}"\r\n`
  writeFileSync(batPath, batContent, { encoding: 'utf-8' })

  try {
    const batStart = Date.now()
    execFileSync(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', batPath], {
      windowsHide: true,
      stdio: 'ignore',
      timeout: 5000
    })
    performanceTrace.record(PERF_TRACE_EVENT.MAIN_UPDATER_SPAWN, {
      strategy: 'batch',
      platform: 'win32',
      ok: true,
      durationMs: Date.now() - batStart
    })
    appendToInstallLog(params.logPath, 'Node.js: Batch launcher succeeded.')
    return true
  } catch (err) {
    performanceTrace.record(PERF_TRACE_EVENT.MAIN_UPDATER_SPAWN, {
      strategy: 'batch',
      platform: 'win32',
      ok: false,
      error: String(err)
    })
    appendToInstallLog(params.logPath, `Node.js: Batch launcher failed: ${err}. Trying detached spawn.`)
  }

  // Strategy 3: Direct detached spawn (least reliable during will-quit).
  try {
    const child = spawn(psPath, ['-ExecutionPolicy', 'Bypass', '-NoProfile', '-WindowStyle', 'Hidden', '-File', params.scriptPath], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true
    })
    performanceTrace.record(PERF_TRACE_EVENT.MAIN_UPDATER_SPAWN, {
      strategy: 'detached-spawn',
      platform: 'win32',
      ok: true,
      pid: child.pid ?? null
    })
    child.on('error', (err) => {
      appendToInstallLog(params.logPath, `Node.js: Detached spawn emitted error: ${err}`)
    })
    child.unref()
    appendToInstallLog(params.logPath, 'Node.js: Detached spawn succeeded (fire-and-forget).')
    return true
  } catch (err) {
    performanceTrace.record(PERF_TRACE_EVENT.MAIN_UPDATER_SPAWN, {
      strategy: 'detached-spawn',
      platform: 'win32',
      ok: false,
      error: String(err)
    })
    appendToInstallLog(params.logPath, `Node.js: All launch strategies failed: ${err}`)
    return false
  }
}

function trackUpdateEvent(
  name: string,
  properties: Record<string, string | number | boolean | null>
): void {
  const telemetry = getTelemetryService()
  telemetry.track(name, { ...properties, platform: process.platform })
}

function trackUpdateFailure(
  phase: string,
  error: string,
  properties: Record<string, string | number | boolean | null> = {}
): void {
  // Single tracked event: the Tier-2 live lane uploads it ack-gated within
  // one heartbeat (deduplicated per phase per day at upload selection), so
  // the old immediate-send path and its once-a-day throttle are gone.
  getTelemetryService().track('update/error', {
    phase,
    error,
    platform: process.platform,
    ...properties
  })
}

function readPackageMetadata(): Record<string, unknown> | null {
  try {
    const pkgPath = join(app.getAppPath(), 'package.json')
    return JSON.parse(readFileSync(pkgPath, 'utf-8')) as Record<string, unknown>
  } catch {
    return null
  }
}

function normalizeArch(value: string): 'arm64' | 'x64' | null {
  if (value === 'arm64' || value === 'x64') return value
  return null
}

function parseRepositoryOwnerAndName(pkg: Record<string, unknown> | null): { owner: string; name: string } | null {
  const repositoryValue = pkg?.repository
  const repositoryObject = typeof repositoryValue === 'object' && repositoryValue !== null
    ? repositoryValue as { url?: unknown }
    : null
  const url =
    typeof repositoryValue === 'string'
      ? repositoryValue
      : repositoryObject && typeof repositoryObject.url === 'string'
        ? repositoryObject.url
        : ''

  const match = /github\.com[/:]([^/]+)\/([^/.]+)(?:\.git)?$/.exec(url)
  if (!match) return null
  return { owner: match[1], name: match[2] }
}

function resolveUpdateBaseUrl(pkg: Record<string, unknown> | null, repository: { owner: string; name: string } | null): string | null {
  const envBaseUrl = String(process.env.ONWARD_UPDATE_BASE_URL || '').trim()
  if (envBaseUrl) return envBaseUrl.replace(/\/+$/, '')

  const onwardValue = pkg?.onward
  const onwardObject = typeof onwardValue === 'object' && onwardValue !== null
    ? onwardValue as { updateManifestBaseUrl?: unknown }
    : null
  if (onwardObject && typeof onwardObject.updateManifestBaseUrl === 'string') {
    return onwardObject.updateManifestBaseUrl.replace(/\/+$/, '')
  }

  if (!repository) return null
  return `https://raw.githubusercontent.com/${repository.owner}/${repository.name}/gh-pages/updates`
}

function hashFileSha256(filePath: string): string {
  const hash = createHash('sha256')
  const buffer = readFileSync(filePath)
  hash.update(buffer)
  return hash.digest('hex')
}

function resolveUpdatesRootPath(): string {
  return join(app.getPath('userData'), 'updates')
}

function resolveUpdateCheckIntervalMs(): number {
  const rawValue = String(process.env.ONWARD_UPDATE_CHECK_INTERVAL_MS || '').trim()
  if (!rawValue) return DEFAULT_UPDATE_CHECK_INTERVAL_MS

  const parsedValue = Number(rawValue)
  if (!Number.isInteger(parsedValue) || parsedValue < 1000) {
    return DEFAULT_UPDATE_CHECK_INTERVAL_MS
  }

  return parsedValue
}

async function resolveWindowsInstallerManifestFromLegacyZip(manifest: UpdateManifest): Promise<UpdateManifest> {
  const parsedZipUrl = parseGitHubReleaseDownloadUrl(manifest.artifactUrl)
  if (!parsedZipUrl || parsedZipUrl.assetName !== manifest.artifactName || parsedZipUrl.tag !== manifest.tag) {
    throw new Error('Windows legacy ZIP manifest cannot be resolved to an installer artifact.')
  }

  const installerName = manifest.artifactName.replace(/\.zip$/i, '.exe')
  if (!isSafeArtifactName(installerName, 'windows')) {
    throw new Error(`Resolved Windows installer artifact name is invalid: ${installerName}`)
  }

  const expandedAssetsUrl = buildGitHubExpandedAssetsUrl(parsedZipUrl)
  const response = await fetchUpdateResource(expandedAssetsUrl, {
    headers: {
      Accept: 'text/html',
      'User-Agent': 'Onward-UpdateService'
    },
    timeoutMs: DEFAULT_UPDATE_REQUEST_TIMEOUT_MS
  })
  if (!response.ok) {
    throw new Error(`GitHub release asset digest request failed: ${response.status} ${response.statusText}`)
  }

  const html = await response.text()
  const installerSha256 = findGitHubExpandedAssetSha256(html, installerName)
  if (!installerSha256) {
    throw new Error(`GitHub release installer artifact is missing a SHA-256 digest: ${installerName}`)
  }

  const installerUrl = buildGitHubReleaseDownloadUrl(parsedZipUrl, installerName)
  const parsedInstallerUrl = parseGitHubReleaseDownloadUrl(installerUrl)
  if (!parsedInstallerUrl ||
      parsedInstallerUrl.owner !== parsedZipUrl.owner ||
      parsedInstallerUrl.repo !== parsedZipUrl.repo ||
      parsedInstallerUrl.tag !== parsedZipUrl.tag ||
      parsedInstallerUrl.assetName !== installerName) {
    throw new Error(`GitHub release installer download URL is not consistent with the manifest tag: ${installerName}`)
  }

  console.log(`${LOG_PREFIX} Resolved legacy Windows ZIP manifest to installer artifact: ${installerName}`)
  return {
    ...manifest,
    artifactName: installerName,
    artifactUrl: installerUrl,
    sha256: installerSha256
  }
}

function canInstallUpdatesOnCurrentPlatform(): boolean {
  return process.platform === 'darwin' || process.platform === 'win32'
}

export class UpdateService {
  private status: UpdateStatus = this.createInitialStatus()
  private mainWindow: BrowserWindow | null = null
  private checkingPromise: Promise<UpdateStatus> | null = null
  private intervalHandle: NodeJS.Timeout | null = null
  private downloadedUpdate: DownloadedUpdate | null = null
  private pendingManifest: UpdateManifest | null = null
  private installRequested = false
  private readonly checkIntervalMs = resolveUpdateCheckIntervalMs()

  private createInitialStatus(): UpdateStatus {
    const appInfo = getAppInfo()
    const pkg = readPackageMetadata()
    const repository = parseRepositoryOwnerAndName(pkg)
    const baseUrl = resolveUpdateBaseUrl(pkg, repository)
    const arch = normalizeArch(process.arch)
    const releaseOsMatchesPlatform =
      (process.platform === 'darwin' && appInfo.releaseOs === 'macos') ||
      (process.platform === 'win32' && appInfo.releaseOs === 'windows') ||
      (process.platform === 'linux' && appInfo.releaseOs === 'linux')
    const installSupported = canInstallUpdatesOnCurrentPlatform()
    const supported =
      appInfo.isPackaged &&
      appInfo.buildChannel === 'prod' &&
      releaseOsMatchesPlatform &&
      installSupported &&
      (appInfo.releaseChannel === 'daily' || appInfo.releaseChannel === 'dev' || appInfo.releaseChannel === 'stable') &&
      arch !== null &&
      Boolean(baseUrl)

    return {
      phase: supported ? 'idle' : 'unsupported',
      supported,
      currentVersion: appInfo.version,
      currentTag: appInfo.tag,
      currentChannel: appInfo.releaseChannel,
      currentReleaseOs: appInfo.releaseOs,
      targetVersion: null,
      targetTag: null,
      downloadedFileName: null,
      lastCheckedAt: null,
      error: null,
      errorCode: null,
      bannerDismissed: false,
      downloadProgress: null
    }
  }

  private emitStatus(): void {
    if (!this.mainWindow || this.mainWindow.isDestroyed()) return
    this.mainWindow.webContents.send(IPC.UPDATER_STATUS_CHANGED, this.getStatus())
  }

  private setStatus(patch: Partial<UpdateStatus>): UpdateStatus {
    this.status = {
      ...this.status,
      ...patch
    }
    this.emitStatus()
    return this.getStatus()
  }

  private getManifestUrl(): string | null {
    const pkg = readPackageMetadata()
    const repository = parseRepositoryOwnerAndName(pkg)
    const baseUrl = resolveUpdateBaseUrl(pkg, repository)
    const arch = normalizeArch(process.arch)
    if (!baseUrl || !arch) return null
    return `${baseUrl}/${this.status.currentChannel}/${this.status.currentReleaseOs}/${arch}/latest.json`
  }

  private async fetchManifest(): Promise<UpdateManifest> {
    const manifestUrl = this.getManifestUrl()
    if (!manifestUrl) {
      throw new Error('Update manifest URL is not configured.')
    }

    const response = await fetchUpdateResource(manifestUrl, {
      headers: {
        Accept: 'application/json'
      },
      timeoutMs: DEFAULT_UPDATE_REQUEST_TIMEOUT_MS
    })
    if (!response.ok) {
      throw new Error(`Manifest request failed: ${response.status} ${response.statusText}`)
    }

    const manifest = await response.json() as Partial<UpdateManifest>
    const arch = normalizeArch(process.arch)
    if (!manifest.version || !manifest.tag || !manifest.artifactUrl || !manifest.sha256 || !manifest.artifactName) {
      throw new Error('Manifest is missing required fields.')
    }
    if (!/^[a-f0-9]{64}$/i.test(manifest.sha256)) {
      throw new Error('Manifest SHA-256 is invalid.')
    }
    if (manifest.channel !== this.status.currentChannel) {
      throw new Error(`Manifest channel mismatch: expected ${this.status.currentChannel}, got ${String(manifest.channel)}`)
    }
    if (manifest.platform !== this.status.currentReleaseOs) {
      throw new Error(`Manifest platform mismatch: expected ${this.status.currentReleaseOs}, got ${String(manifest.platform)}`)
    }
    if (!arch || manifest.arch !== arch) {
      throw new Error(`Manifest architecture mismatch: expected ${arch || 'unknown'}, got ${String(manifest.arch)}`)
    }

    const normalizedManifest: UpdateManifest = {
      channel: manifest.channel,
      version: manifest.version,
      tag: manifest.tag,
      platform: manifest.platform,
      arch: manifest.arch,
      artifactName: manifest.artifactName,
      artifactUrl: manifest.artifactUrl,
      sha256: manifest.sha256,
      releaseNotes: manifest.releaseNotes ?? null,
      publishedAt: manifest.publishedAt ?? new Date().toISOString()
    }

    if (isSafeArtifactName(normalizedManifest.artifactName, normalizedManifest.platform)) {
      return normalizedManifest
    }
    if (normalizedManifest.platform === 'windows' && isSafeLegacyWindowsZipArtifactName(normalizedManifest.artifactName)) {
      return resolveWindowsInstallerManifestFromLegacyZip(normalizedManifest)
    }

    throw new Error(`Manifest artifact name is invalid for ${normalizedManifest.platform}: ${normalizedManifest.artifactName}`)
  }

  private getDownloadPath(manifest: UpdateManifest): string {
    return join(app.getPath('userData'), 'updates', manifest.version, manifest.artifactName)
  }

  private saveManifestFile(manifest: UpdateManifest): void {
    const versionDir = join(resolveUpdatesRootPath(), manifest.version)
    mkdirSync(versionDir, { recursive: true })
    writeFileSync(join(versionDir, 'manifest.json'), JSON.stringify(manifest), 'utf-8')
  }

  private loadManifestFile(version: string): UpdateManifest | null {
    const manifestPath = join(resolveUpdatesRootPath(), version, 'manifest.json')
    if (!existsSync(manifestPath)) return null
    try {
      return JSON.parse(readFileSync(manifestPath, 'utf-8')) as UpdateManifest
    } catch {
      return null
    }
  }

  /**
   * Clean up stale downloads and recover the latest pending update on startup.
   *
   * Expiration rules:
   * 1. Versions <= currentVersion are expired (already installed or older), then deleted
   * 2. Among versions > currentVersion, try to recover from newest to oldest
   * 3. On first successful recovery, delete all remaining older candidates
   * 4. Each candidate is verified (channel/platform/arch + manifest + checksum);
   *    corrupt/incomplete/incompatible files are removed.
   *
   * The verify-before-delete order ensures that a corrupt newest version does
   * not cause valid older versions to be discarded prematurely.
   */
  private cleanupAndRecoverPendingUpdate(): void {
    const updatesRoot = resolveUpdatesRootPath()
    if (!existsSync(updatesRoot)) return

    const currentVersion = this.status.currentVersion
    const pendingVersions: string[] = []
    let cleanedCount = 0

    for (const entry of readdirSync(updatesRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const version = entry.name

      // Skip directories that are not valid version strings
      try {
        parseVersion(version)
      } catch {
        rmSync(join(updatesRoot, version), { recursive: true, force: true })
        cleanedCount++
        continue
      }

      if (compareVersions(version, currentVersion) <= 0) {
        rmSync(join(updatesRoot, version), { recursive: true, force: true })
        console.log(`${LOG_PREFIX} Cleaned up expired download: ${version}`)
        cleanedCount++
      } else {
        pendingVersions.push(version)
      }
    }

    if (pendingVersions.length === 0) {
      if (cleanedCount > 0) {
        console.log(`${LOG_PREFIX} Startup cleanup: removed ${cleanedCount} stale download(s), no pending updates`)
      }
      return
    }

    // Sort descending: try newest first, fall back to older candidates.
    pendingVersions.sort((a, b) => compareVersions(b, a))

    // Try candidates in descending order. Only delete superseded versions
    // AFTER a successful recovery (verify-before-delete).
    let recoveredIndex = -1
    for (let i = 0; i < pendingVersions.length; i++) {
      if (this.recoverPendingUpdate(pendingVersions[i])) {
        recoveredIndex = i
        break
      }
      // Count as cleaned only if the directory was actually removed
      // (partial downloads are preserved for cross-session resume)
      if (!existsSync(join(updatesRoot, pendingVersions[i]))) {
        cleanedCount++
      }
    }

    // Delete remaining untried candidates that are older than the recovered one
    if (recoveredIndex >= 0) {
      for (let i = recoveredIndex + 1; i < pendingVersions.length; i++) {
        rmSync(join(updatesRoot, pendingVersions[i]), { recursive: true, force: true })
        console.log(`${LOG_PREFIX} Cleaned up superseded download: ${pendingVersions[i]}`)
        cleanedCount++
      }
    }

    if (cleanedCount > 0) {
      const recovered = recoveredIndex >= 0 ? pendingVersions[recoveredIndex] : 'none'
      console.log(`${LOG_PREFIX} Startup cleanup: removed ${cleanedCount} stale download(s), recovered: ${recovered}`)
    }
  }

  /**
   * Attempt to recover a previously downloaded update from disk.
   * Validates channel/platform/arch compatibility, manifest integrity, and
   * artifact checksum. Removes the version directory on any failure.
   * @returns true if recovery succeeded, false if the candidate was invalid.
   */
  private recoverPendingUpdate(version: string): boolean {
    const versionDir = join(resolveUpdatesRootPath(), version)
    const manifest = this.loadManifestFile(version)

    if (!manifest) {
      rmSync(versionDir, { recursive: true, force: true })
      console.log(`${LOG_PREFIX} Removed unverifiable download (no manifest): ${version}`)
      return false
    }

    // Reject artifacts from a different channel, platform, or architecture.
    // Prod builds across release channels (daily/dev/stable) share the same
    // userData directory, so a channel switch can leave foreign artifacts behind.
    const arch = normalizeArch(process.arch)
    if (manifest.channel !== this.status.currentChannel ||
        manifest.platform !== this.status.currentReleaseOs ||
        !arch || manifest.arch !== arch) {
      rmSync(versionDir, { recursive: true, force: true })
      console.log(
        `${LOG_PREFIX} Removed incompatible download: ${version}` +
        ` (channel=${String(manifest.channel)}, platform=${String(manifest.platform)}, arch=${String(manifest.arch)})`)
      return false
    }
    if (!isSafeArtifactName(manifest.artifactName, manifest.platform) || !/^[a-f0-9]{64}$/i.test(manifest.sha256)) {
      rmSync(versionDir, { recursive: true, force: true })
      console.log(`${LOG_PREFIX} Removed invalid download manifest: ${version}`)
      return false
    }

    const artifactPath = join(versionDir, manifest.artifactName)
    if (!existsSync(artifactPath)) {
      // Preserve directories with a .partial file so they can be resumed.
      const partialPath = getPartialDownloadPath(artifactPath)
      if (existsSync(partialPath)) {
        const partialSize = statSync(partialPath).size
        console.log(`${LOG_PREFIX} Found resumable partial download: ${version} (${formatDownloadBytes(partialSize)})`)
        return false
      }
      rmSync(versionDir, { recursive: true, force: true })
      console.log(`${LOG_PREFIX} Removed incomplete download (artifact missing): ${version}`)
      return false
    }

    try {
      const checksum = hashFileSha256(artifactPath)
      if (checksum.toLowerCase() !== manifest.sha256.toLowerCase()) {
        rmSync(versionDir, { recursive: true, force: true })
        console.log(`${LOG_PREFIX} Removed corrupted download (checksum mismatch): ${version}`)
        return false
      }
    } catch {
      rmSync(versionDir, { recursive: true, force: true })
      console.log(`${LOG_PREFIX} Removed unreadable download: ${version}`)
      return false
    }

    this.downloadedUpdate = { manifest, artifactPath }
    this.setStatus({
      phase: 'downloaded',
      targetVersion: manifest.version,
      targetTag: manifest.tag,
      downloadedFileName: manifest.artifactName,
      error: null,
      errorCode: null,
      downloadProgress: null
    })
    console.log(`${LOG_PREFIX} Recovered pending update: ${version} (${manifest.artifactName})`)
    return true
  }

  private async ensureDownloaded(
    manifest: UpdateManifest,
    onProgress?: (progress: DownloadProgress) => void
  ): Promise<DownloadedUpdate> {
    const artifactPath = this.getDownloadPath(manifest)

    // Persist manifest before download so partial files can be resumed across sessions.
    this.saveManifestFile(manifest)

    if (!existsSync(artifactPath)) {
      console.log(`${LOG_PREFIX} Downloading: ${manifest.artifactUrl}`)
      await downloadFileWithRetry(manifest.artifactUrl, artifactPath, {
        onProgress,
        onRetry: ({ attempt, maxAttempts, delayMs, error }) => {
          console.log(`${LOG_PREFIX} Retry ${attempt}/${maxAttempts} in ${delayMs}ms: ${error.message}`)
        },
        log: (message) => console.log(`${LOG_PREFIX} ${message}`)
      })
      console.log(`${LOG_PREFIX} Download saved to: ${artifactPath}`)
    } else {
      console.log(`${LOG_PREFIX} Artifact already exists, verifying checksum: ${artifactPath}`)
    }

    const checksum = hashFileSha256(artifactPath)
    if (checksum.toLowerCase() !== manifest.sha256.toLowerCase()) {
      console.error(`${LOG_PREFIX} Checksum mismatch: expected=${manifest.sha256}, got=${checksum}`)
      rmSync(artifactPath, { force: true })
      rmSync(getPartialDownloadPath(artifactPath), { force: true })
      throw new DownloadError('checksum-mismatch', 'Downloaded update failed checksum verification.')
    }
    console.log(`${LOG_PREFIX} Checksum verified: ${checksum}`)

    // Clean up partial file after successful verification.
    rmSync(getPartialDownloadPath(artifactPath), { force: true })

    return {
      manifest,
      artifactPath
    }
  }

  start(mainWindow: BrowserWindow): void {
    this.mainWindow = mainWindow
    this.status = this.createInitialStatus()
    this.cleanupAndRecoverPendingUpdate()
    this.emitStatus()

    console.log(`${LOG_PREFIX} Initialized: supported=${this.status.supported}, version=${this.status.currentVersion}, os=${this.status.currentReleaseOs}, channel=${this.status.currentChannel}`)

    // Check install log from previous update attempt and report result via telemetry
    this.reportPreviousInstallResult()

    if (!this.status.supported) return

    // DEV channel updates are manual only: Check Now, then Download, then Restart.
    if (this.status.currentChannel === 'dev') return

    void this.checkNow()
    this.intervalHandle = setInterval(() => {
      void this.checkNow()
    }, this.checkIntervalMs)
  }

  /**
   * Read the install log left by the previous update helper script.
   * If the log indicates a failure, report it via telemetry.
   * The log is cleared after reading to avoid duplicate reports.
   */
  private reportPreviousInstallResult(): void {
    const logPath = resolveUpdateLogPath()
    if (!existsSync(logPath)) return

    try {
      const content = readFileSync(logPath, 'utf-8').trim()
      if (!content) return

      const lines = content.split('\n').filter(Boolean)
      let lastSuccessIndex = -1
      let lastFailureIndex = -1
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i]
        if (line.includes('installed successfully')) lastSuccessIndex = i
        if (line.includes('install failed')) lastFailureIndex = i
      }
      const success = lastSuccessIndex >= 0 && lastSuccessIndex > lastFailureIndex
      const failed = lastFailureIndex >= 0 && lastFailureIndex > lastSuccessIndex

      if (success) {
        console.log(`${LOG_PREFIX} Previous update installed successfully`)
        trackUpdateEvent('update/installComplete', { result: 'success' })
      } else if (failed) {
        const failedLine = lines[lastFailureIndex] || ''
        // Extract error from the log line: "YYYY-MM-DD HH:MM:SS Update install failed: <error>"
        const errorMatch = /install failed:\s*(.+)$/i.exec(failedLine)
        const errorDetail = errorMatch ? errorMatch[1] : 'unknown'
        console.error(`${LOG_PREFIX} Previous update install failed: ${errorDetail}`)
        trackUpdateFailure('install', errorDetail, {
          installLog: lines.slice(-5).join('\n')
        })
      }

      // Clear the log after reading
      writeFileSync(logPath, '', 'utf-8')
    } catch {
      // Non-blocking: log read failure is not critical
    }
  }

  stop(): void {
    if (this.intervalHandle) {
      clearInterval(this.intervalHandle)
      this.intervalHandle = null
    }
  }

  getStatus(): UpdateStatus {
    return { ...this.status }
  }

  async checkNow(): Promise<UpdateStatus> {
    if (!this.status.supported) {
      return this.getStatus()
    }
    if (this.checkingPromise) {
      return this.checkingPromise
    }

    this.checkingPromise = this.checkNowInternal()
    try {
      return await this.checkingPromise
    } finally {
      this.checkingPromise = null
    }
  }

  private async checkNowInternal(): Promise<UpdateStatus> {
    console.log(`${LOG_PREFIX} Starting update check (current: ${this.status.currentVersion})`)
    this.setStatus({
      phase: 'checking',
      error: null,
      errorCode: null,
      downloadProgress: null
    })

    try {
      const manifest = await this.fetchManifest()
      const lastCheckedAt = Date.now()
      const isNewer = compareVersions(manifest.version, this.status.currentVersion) > 0
      console.log(`${LOG_PREFIX} Manifest fetched: version=${manifest.version}, isNewer=${isNewer}`)

      if (!isNewer) {
        if (this.downloadedUpdate && this.downloadedUpdate.manifest.version === manifest.version) {
          return this.setStatus({
            phase: 'downloaded',
            targetVersion: manifest.version,
            targetTag: manifest.tag,
            downloadedFileName: this.downloadedUpdate.manifest.artifactName,
            lastCheckedAt,
            error: null,
            errorCode: null,
            downloadProgress: null
          })
        }

        this.downloadedUpdate = null
        console.log(`${LOG_PREFIX} Already up-to-date`)
        trackUpdateEvent('update/check', { result: 'up-to-date', currentVersion: this.status.currentVersion })
        return this.setStatus({
          phase: 'up-to-date',
          targetVersion: null,
          targetTag: null,
          downloadedFileName: null,
          bannerDismissed: false,
          lastCheckedAt,
          error: null,
          errorCode: null,
          downloadProgress: null
        })
      }

      console.log(`${LOG_PREFIX} New version available: ${manifest.version}`)
      trackUpdateEvent('update/check', {
        result: 'new-version',
        currentVersion: this.status.currentVersion,
        targetVersion: manifest.version
      })

      // If we already have this version downloaded and verified (e.g., recovered
      // from a previous session), skip re-download and confirm downloaded state.
      if (this.downloadedUpdate && this.downloadedUpdate.manifest.version === manifest.version) {
        console.log(`${LOG_PREFIX} Update already downloaded, skipping re-download: ${manifest.version}`)
        return this.setStatus({
          phase: 'downloaded',
          targetVersion: manifest.version,
          targetTag: manifest.tag,
          downloadedFileName: this.downloadedUpdate.manifest.artifactName,
          bannerDismissed: false,
          lastCheckedAt,
          error: null,
          errorCode: null,
          downloadProgress: null
        })
      }

      // DEV channel: stop at 'available' and wait for user to manually trigger download.
      if (this.status.currentChannel === 'dev') {
        // Clear any stale downloaded update superseded by the newer available version.
        // Without this, downloadedUpdate would reference an older version while
        // the UI shows the newer version as "available", causing an inconsistency
        // where requestRestartToUpdate() could install the wrong version.
        if (this.downloadedUpdate) {
          this.downloadedUpdate = null
        }
        this.pendingManifest = manifest
        console.log(`${LOG_PREFIX} Dev channel: waiting for manual download`)
        return this.setStatus({
          phase: 'available',
          targetVersion: manifest.version,
          targetTag: manifest.tag,
          downloadedFileName: null,
          bannerDismissed: false,
          lastCheckedAt,
          error: null,
          errorCode: null,
          downloadProgress: null
        })
      }

      // Daily/Stable channel: auto-download immediately.
      return this.downloadUpdate(manifest, lastCheckedAt)
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error)
      const errorCode = error instanceof DownloadError ? error.code : null
      const failedPhase = this.status.phase === 'downloading' ? 'download' : 'check'
      console.error(`${LOG_PREFIX} Update ${failedPhase} failed: ${errorMessage}`)
      trackUpdateFailure(failedPhase, errorMessage, {
        currentVersion: this.status.currentVersion,
        targetVersion: this.status.targetVersion
      })
      // If a previously downloaded update is still valid on disk, restore its
      // state so the UI shows the correct (actually downloaded) version, not
      // the version whose download just failed.
      if (this.downloadedUpdate) {
        return this.setStatus({
          phase: 'downloaded',
          targetVersion: this.downloadedUpdate.manifest.version,
          targetTag: this.downloadedUpdate.manifest.tag,
          downloadedFileName: this.downloadedUpdate.manifest.artifactName,
          lastCheckedAt: Date.now(),
          error: errorMessage,
          errorCode,
          downloadProgress: null
        })
      }
      return this.setStatus({
        phase: 'error',
        lastCheckedAt: Date.now(),
        error: errorMessage,
        errorCode,
        downloadProgress: null
      })
    }
  }

  private async downloadUpdate(manifest: UpdateManifest, lastCheckedAt: number): Promise<UpdateStatus> {
    this.setStatus({
      phase: 'downloading',
      targetVersion: manifest.version,
      targetTag: manifest.tag,
      downloadedFileName: manifest.artifactName,
      bannerDismissed: false,
      lastCheckedAt,
      error: null,
      errorCode: null,
      downloadProgress: null
    })

    const onProgress = (progress: DownloadProgress): void => {
      this.setStatus({ downloadProgress: progress })
    }

    this.downloadedUpdate = await this.ensureDownloaded(manifest, onProgress)
    console.log(`${LOG_PREFIX} Download complete: ${manifest.artifactName}`)
    trackUpdateEvent('update/downloaded', {
      targetVersion: manifest.version,
      artifactName: manifest.artifactName
    })

    return this.setStatus({
      phase: 'downloaded',
      targetVersion: manifest.version,
      targetTag: manifest.tag,
      downloadedFileName: manifest.artifactName,
      bannerDismissed: false,
      lastCheckedAt,
      error: null,
      errorCode: null,
      downloadProgress: null
    })
  }

  /**
   * Manually trigger download of the available update (DEV channel only).
   * Only valid when phase is 'available' and a pending manifest exists.
   */
  async downloadNow(): Promise<UpdateStatus> {
    if (this.status.phase !== 'available' || !this.pendingManifest) {
      return this.getStatus()
    }

    const manifest = this.pendingManifest
    this.pendingManifest = null

    try {
      return await this.downloadUpdate(manifest, this.status.lastCheckedAt ?? Date.now())
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error)
      const errorCode = error instanceof DownloadError ? error.code : null
      console.error(`${LOG_PREFIX} Download failed: ${errorMessage}`)
      trackUpdateFailure('download', errorMessage, {
        currentVersion: this.status.currentVersion,
        targetVersion: manifest.version
      })
      return this.setStatus({
        phase: 'error',
        error: errorMessage,
        errorCode,
        downloadProgress: null
      })
    }
  }

  dismissBanner(): UpdateStatus {
    if (this.status.phase !== 'downloaded') {
      return this.getStatus()
    }
    return this.setStatus({ bannerDismissed: true })
  }

  canInstallDownloadedUpdate(): boolean {
    return canInstallUpdatesOnCurrentPlatform() && Boolean(this.downloadedUpdate)
  }

  requestRestartToUpdate(): { success: boolean; error?: string } {
    if (!this.canInstallDownloadedUpdate()) {
      return { success: false, error: 'No downloaded update is ready to install.' }
    }
    this.installRequested = true
    return { success: true }
  }

  shouldInstallOnQuit(): boolean {
    return this.installRequested
  }

  installDownloadedUpdateOnQuit(): void {
    if (!this.downloadedUpdate) return

    const targetVersion = this.downloadedUpdate.manifest.version
    console.log(`${LOG_PREFIX} Installing update on quit: ${this.status.currentVersion} -> ${targetVersion}`)
    trackUpdateEvent('update/installStart', {
      currentVersion: this.status.currentVersion,
      targetVersion
    })

    if (process.platform === 'darwin') {
      this.installDownloadedUpdateOnQuitMacOS()
    } else if (process.platform === 'win32') {
      this.installDownloadedUpdateOnQuitWindows()
    }
  }

  private installDownloadedUpdateOnQuitMacOS(): void {
    const bundlePath = resolveCurrentInstallPath()
    if (!bundlePath) return

    const stagingRoot = join(tmpdir(), `onward-update-${Date.now()}`)
    mkdirSync(stagingRoot, { recursive: true })
    const scriptPath = join(stagingRoot, 'install-update.sh')
    const logPath = resolveUpdateLogPath()
    const relaunchEnvAssignments = RELAUNCH_ENV_KEYS
      .map((key) => {
        const value = process.env[key]
        if (!value) return null
        return `${key}=${shellEscape(value)}`
      })
      .filter((value): value is string => Boolean(value))
      .join(' ')
    const scriptContent = [
      '#!/bin/sh',
      'set -eu',
      `APP_PATH=${shellEscape(bundlePath)}`,
      `EXEC_PATH=${shellEscape(app.getPath('exe'))}`,
      `ARCHIVE_PATH=${shellEscape(this.downloadedUpdate!.artifactPath)}`,
      `PARENT_PID=${process.pid}`,
      `STAGING_ROOT=${shellEscape(stagingRoot)}`,
      `LOG_PATH=${shellEscape(logPath)}`,
      `RELAUNCH_ENV_ASSIGNMENTS=${shellEscape(relaunchEnvAssignments)}`,
      'EXTRACT_ROOT="$STAGING_ROOT/extracted"',
      'BACKUP_PATH="$APP_PATH.onward-backup"',
      'mkdir -p "$(dirname "$LOG_PATH")"',
      'log() {',
      '  printf "%s %s\\n" "$(date \'+%Y-%m-%d %H:%M:%S\')" "$1" >> "$LOG_PATH"',
      '}',
      'restore_backup() {',
      '  if [ ! -d "$APP_PATH" ] && [ -d "$BACKUP_PATH" ]; then',
      '    mv "$BACKUP_PATH" "$APP_PATH"',
      '  fi',
      '}',
      'handle_error() {',
      '  local exit_code=$?',
      '  log "Update install failed: exit code $exit_code (last command at line $1)"',
      '  restore_backup',
      '}',
      'trap \'handle_error $LINENO\' EXIT',
      'log "Starting update install helper."',
      'for _ in $(seq 1 120); do',
      '  if ! kill -0 "$PARENT_PID" 2>/dev/null; then',
      '    log "Detected parent process exit."',
      '    break',
      '  fi',
      '  sleep 1',
      'done',
      'rm -rf "$EXTRACT_ROOT" "$BACKUP_PATH"',
      'mkdir -p "$EXTRACT_ROOT"',
      'log "Extracting update archive."',
      'ditto -x -k "$ARCHIVE_PATH" "$EXTRACT_ROOT"',
      'NEW_APP_PATH="$(find "$EXTRACT_ROOT" -maxdepth 1 -name \'*.app\' -print -quit)"',
      'if [ -z "$NEW_APP_PATH" ]; then',
      '  log "No .app bundle found in extracted archive."',
      '  exit 1',
      'fi',
      'log "Replacing app bundle with downloaded update."',
      'mv "$APP_PATH" "$BACKUP_PATH"',
      'mv "$NEW_APP_PATH" "$APP_PATH"',
      'trap - EXIT',
      'rm -rf "$BACKUP_PATH" "$EXTRACT_ROOT"',
      'log "Update installed successfully."',
      'log "Relaunching updated app."',
      'if [ -n "$RELAUNCH_ENV_ASSIGNMENTS" ]; then',
      '  eval "/usr/bin/env $RELAUNCH_ENV_ASSIGNMENTS \\"$EXEC_PATH\\"" >/dev/null 2>&1 &',
      'else',
      '  open -n "$APP_PATH"',
      'fi',
      'rm -f "$ARCHIVE_PATH" "$0"',
      'rmdir "$STAGING_ROOT" 2>/dev/null || true'
    ].join('\n')

    writeFileSync(scriptPath, `${scriptContent}\n`, { encoding: 'utf-8', mode: 0o755 })
    const child = spawn('/bin/sh', [scriptPath], {
      detached: true,
      stdio: 'ignore'
    })
    performanceTrace.record(PERF_TRACE_EVENT.MAIN_UPDATER_SPAWN, {
      strategy: 'macos-sh',
      platform: process.platform,
      pid: child.pid ?? null,
      ok: true
    })
    child.unref()
  }

  private installDownloadedUpdateOnQuitWindows(): void {
    const installDir = resolveCurrentInstallPath()
    if (!installDir) return

    // Use a short staging path for the detached runner script.
    const stagingId = Date.now().toString(36)
    const stagingRoot = join(process.env.TEMP || tmpdir(), `ou-${stagingId}`)
    mkdirSync(stagingRoot, { recursive: true })
    const scriptPath = join(stagingRoot, 'up.ps1')
    const logPath = resolveUpdateLogPath()
    const execPath = app.getPath('exe')
    const markerPath = join(resolveUpdatesRootPath(), 'pending-update.json')
    const lockPath = join(resolveUpdatesRootPath(), 'install.lock')

    // Pre-flight logging from Node.js side (appears in install.log)
    appendToInstallLog(logPath, `Node.js: Preparing update install helper. PID=${process.pid}`)
    appendToInstallLog(logPath, `Node.js: installDir=${installDir}`)
    appendToInstallLog(logPath, `Node.js: installerPath=${this.downloadedUpdate!.artifactPath}`)
    appendToInstallLog(logPath, `Node.js: stagingRoot=${stagingRoot}`)

    // Write pending-update marker for startup recovery fallback.
    // If the helper script fails to launch or is killed during Electron's
    // shutdown, the next app startup will detect this marker and retry.
    try {
      const marker: PendingUpdateInfo = {
        schemaVersion: PENDING_UPDATE_MARKER_SCHEMA_VERSION,
        artifactPath: this.downloadedUpdate!.artifactPath,
        artifactSha256: this.downloadedUpdate!.manifest.sha256,
        artifactName: this.downloadedUpdate!.manifest.artifactName,
        installDir,
        execPath,
        logPath,
        timestamp: Date.now(),
        targetVersion: this.downloadedUpdate!.manifest.version,
        attempts: 0
      }
      writePendingUpdateInfo(markerPath, marker)
      appendToInstallLog(logPath, 'Node.js: Wrote pending-update marker.')
    } catch (err) {
      appendToInstallLog(logPath, `Node.js: Failed to write pending-update marker: ${err}`)
    }

    const envSetStatements = buildEnvSetStatements()
    const scriptContent = buildWindowsUpdateScript({
      installDir,
      execPath,
      installerPath: this.downloadedUpdate!.artifactPath,
      installerSha256: this.downloadedUpdate!.manifest.sha256,
      parentPid: process.pid,
      stagingRoot,
      logPath,
      markerPath,
      lockPath,
      targetVersion: this.downloadedUpdate!.manifest.version,
      envSetStatements
    })

    writeFileSync(scriptPath, scriptContent, { encoding: 'utf-8' })
    if (!launchWindowsUpdateScript({ stagingRoot, scriptPath, logPath })) {
      safeRemoveFile(markerPath)
    }
  }
}

let updateService: UpdateService | null = null

export function getUpdateService(): UpdateService {
  if (!updateService) {
    updateService = new UpdateService()
  }
  return updateService
}

/**
 * Called early during app startup (after initializeAppIdentity but before
 * createWindow). If the previous quit-time update script failed to run,
 * this detects the pending-update marker and retries the update.
 *
 * Returns true if a recovery update was launched and the caller should
 * exit immediately (the helper script will relaunch the app).
 */
export function applyPendingUpdateOnStartup(): boolean {
  if (process.platform !== 'win32') return false

  const markerPath = join(resolveUpdatesRootPath(), 'pending-update.json')
  if (!existsSync(markerPath)) return false

  let info: PendingUpdateInfo
  let rawMarker: unknown
  try {
    rawMarker = JSON.parse(readFileSync(markerPath, 'utf-8')) as unknown
  } catch {
    safeRemoveFile(markerPath)
    return false
  }

  const validation = validatePendingUpdateInfo(rawMarker)
  if (!validation.info) {
    const rawLogPath = rawMarker && typeof rawMarker === 'object'
      ? (rawMarker as { logPath?: unknown }).logPath
      : null
    const fallbackLogPath = isNonEmptyString(rawLogPath) && isAbsolute(rawLogPath)
      ? rawLogPath
      : resolveUpdateLogPath()
    appendToInstallLog(fallbackLogPath, `Node.js: Removing invalid pending-update marker: ${validation.error}`)
    safeRemoveFile(markerPath)
    return false
  }
  info = validation.info

  const currentInstallDir = resolveCurrentInstallPath()
  const currentExecPath = app.getPath('exe')
  if (!currentInstallDir ||
      normalizeWindowsPathForCompare(currentInstallDir) !== normalizeWindowsPathForCompare(info.installDir) ||
      normalizeWindowsPathForCompare(currentExecPath) !== normalizeWindowsPathForCompare(info.execPath)) {
    appendToInstallLog(info.logPath, 'Node.js: Pending update marker install path no longer matches current app, removing marker.')
    safeRemoveFile(markerPath)
    return false
  }

  if (basename(info.artifactPath) !== info.artifactName) {
    appendToInstallLog(info.logPath, 'Node.js: Pending update marker artifact path does not match artifact name, removing marker.')
    safeRemoveFile(markerPath)
    return false
  }

  let isTargetNewer = false
  const { version: currentVersion } = getAppInfo()
  try {
    isTargetNewer = compareVersions(info.targetVersion, currentVersion) > 0
  } catch {
    appendToInstallLog(info.logPath, `Node.js: Pending update marker target version is invalid: ${info.targetVersion}`)
    safeRemoveFile(markerPath)
    return false
  }

  // If current version already matches or exceeds the target, the update was applied.
  if (!isTargetNewer) {
    console.log(`${LOG_PREFIX} Pending update target (${info.targetVersion}) is not newer than current (${currentVersion}), clearing marker.`)
    safeRemoveFile(markerPath)
    return false
  }

  // Skip if marker is too old (> 1 hour)
  if (Date.now() - info.timestamp > MAX_PENDING_UPDATE_MARKER_AGE_MS) {
    console.log(`${LOG_PREFIX} Pending update marker is stale (${new Date(info.timestamp).toISOString()}), removing.`)
    appendToInstallLog(info.logPath, 'Node.js: Pending update marker is stale, removing marker.')
    safeRemoveFile(markerPath)
    return false
  }

  if (info.attempts >= MAX_PENDING_UPDATE_STARTUP_ATTEMPTS) {
    console.log(`${LOG_PREFIX} Pending update startup recovery already attempted, removing marker.`)
    appendToInstallLog(info.logPath, 'Node.js: Startup recovery attempt limit reached, removing marker.')
    safeRemoveFile(markerPath)
    return false
  }

  // Skip if the installer is gone (already cleaned up or never downloaded).
  if (!existsSync(info.artifactPath)) {
    console.log(`${LOG_PREFIX} Pending update artifact not found: ${info.artifactPath}, removing marker.`)
    appendToInstallLog(info.logPath, `Node.js: Pending update artifact not found: ${info.artifactPath}`)
    safeRemoveFile(markerPath)
    return false
  }

  try {
    const checksum = hashFileSha256(info.artifactPath)
    if (checksum.toLowerCase() !== info.artifactSha256.toLowerCase()) {
      console.log(`${LOG_PREFIX} Pending update artifact checksum mismatch, removing marker and artifact.`)
      appendToInstallLog(info.logPath, `Node.js: Pending update artifact checksum mismatch: expected=${info.artifactSha256} actual=${checksum}`)
      safeRemoveFile(info.artifactPath)
      safeRemoveFile(markerPath)
      return false
    }
  } catch (err) {
    appendToInstallLog(info.logPath, `Node.js: Pending update artifact could not be verified: ${err}`)
    safeRemoveFile(markerPath)
    return false
  }

  console.log(`${LOG_PREFIX} Found pending update ${info.targetVersion}. Launching recovery update script.`)
  appendToInstallLog(info.logPath, `Node.js: Startup recovery: launching update script for ${info.targetVersion}. PID=${process.pid}`)

  try {
    writePendingUpdateInfo(markerPath, {
      ...info,
      attempts: info.attempts + 1
    })
  } catch (err) {
    appendToInstallLog(info.logPath, `Node.js: Startup recovery: failed to update marker attempt count: ${err}`)
    safeRemoveFile(markerPath)
    return false
  }

  // Create a new staging directory and PowerShell script with the CURRENT PID
  const stagingRoot = join(process.env.TEMP || tmpdir(), `ou-${Date.now().toString(36)}`)
  mkdirSync(stagingRoot, { recursive: true })
  const scriptPath = join(stagingRoot, 'up.ps1')
  const lockPath = join(resolveUpdatesRootPath(), 'install.lock')

  const scriptContent = buildWindowsUpdateScript({
    installDir: info.installDir,
    execPath: info.execPath,
    installerPath: info.artifactPath,
    installerSha256: info.artifactSha256,
    parentPid: process.pid,
    stagingRoot,
    logPath: info.logPath,
    markerPath,
    lockPath,
    targetVersion: info.targetVersion,
    envSetStatements: buildEnvSetStatements()
  })
  writeFileSync(scriptPath, scriptContent, 'utf-8')

  if (!launchWindowsUpdateScript({ stagingRoot, scriptPath, logPath: info.logPath })) {
    appendToInstallLog(info.logPath, 'Node.js: Startup recovery: failed to launch script.')
    console.error(`${LOG_PREFIX} Startup recovery failed to launch.`)
    safeRemoveFile(markerPath)
    return false
  }
  appendToInstallLog(info.logPath, 'Node.js: Startup recovery: script launched successfully.')
  return true
}
