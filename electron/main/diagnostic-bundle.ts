/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

// Diagnostic bundle creator.
//
// Streams the trace store's NDJSON chunks plus a curated set of userData
// state files into a single ZIP at a caller-provided output path. Used by
// the FeedbackModal "Generate diagnostic bundle" button so a user
// reporting a problem can hand back the trace + state in one file.
//
// Pure Node — does NOT depend on `electron` at runtime, so it is unit-
// testable against a synthetic userData directory without launching the
// app. The IPC layer (electron/main/ipc-handlers.ts) is the only caller
// that pulls in electron-specific bits (the showSaveDialog).

import { ZipFile } from 'yazl'
import yauzl from 'yauzl'
import { copyFileSync, createWriteStream, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'
import { tmpdir } from 'os'
import { createHash } from 'crypto'
import { inflateRawSync } from 'zlib'
import { execFileSync } from 'child_process'

export interface DiagnosticBundleAppInfo {
  version: string
  buildChannel?: string
  branch?: string | null
  tag?: string | null
  productName?: string
  electronVersion?: string
}

/**
 * Marker shape used by V10 (autotest semantic-loop check).
 *
 * Autotest emits this exact marker via `debug:emit-bundle-marker` and
 * passes the same `{uuid, label}` here as `expectedMarker`. The verifier
 * scans every bundled chunk for an event with `name ===
 * 'autotest:bundle-marker'` whose `args.uuid` and `args.label` match
 * byte-for-byte. The marker stays out of the production verifier path:
 * when omitted, V10 records `passed:true, detail:'skipped (no marker
 * provided)'` so the prod runtime never relies on autotest plumbing.
 */
export interface DiagnosticBundleExpectedMarker {
  uuid: string
  label?: string
}

export interface CreateDiagnosticBundleOptions {
  /** Absolute path of the userData directory (the source for state files + traces). */
  userDataDir: string
  /** Absolute path where the output ZIP should be written. Caller resolves via showSaveDialog. */
  outputPath: string
  /**
   * Override for the trace chunk directory. Defaults to `<userDataDir>/traces`.
   * Tests pass an explicit path so they can build a fixture outside userData.
   */
  traceDir?: string
  /** App identity tagged into README + system-info. */
  appInfo?: DiagnosticBundleAppInfo
  /**
   * Optional ISO timestamp string. Defaults to the current wall-clock UTC
   * time. Tests pass a fixed value so README content is reproducible.
   */
  timestamp?: string
  /**
   * Live terminal cwds (terminalId → cwd) so system-info can classify the
   * volume each terminal sits on (2026-07 RC-2: network drives explain the
   * git probe timeouts). Optional — tests and headless callers omit it.
   */
  terminalCwds?: Array<{ terminalId: string; cwd: string | null }>
  /**
   * Autotest-only: drives V10. Production callers must not pass it; the
   * IPC handler refuses to forward this field unless `ONWARD_AUTOTEST=1`.
   */
  expectedMarker?: DiagnosticBundleExpectedMarker
  /**
   * Archive strategy. 'zip' (default) streams through yazl — which rides
   * the libuv threadpool (zlib + createWriteStream) and therefore
   * deadlocks forever when the pool is stalled (2026-07-20 incident: the
   * "generate log" feature hung at exactly the moment it was needed).
   * 'sync-directory' delivers the same content as a plain directory using
   * only synchronous fs — immune to the stall. Callers pass
   * 'sync-directory' when the threadpool watchdog reports the pool dead;
   * 'zip' mode also self-downgrades to the sync directory when the
   * archive step exceeds `archiveTimeoutMs`.
   */
  archiveMode?: 'zip' | 'sync-directory'
  /** Ceiling for the zip streaming step before self-downgrading. Default 15 s. */
  archiveTimeoutMs?: number
}

export interface DiagnosticBundleVerificationCheck {
  name: string
  passed: boolean
  detail?: string
}

export interface DiagnosticBundleVerification {
  /** True when every check in `checks` passed. Drives the top-level `success`. */
  ok: boolean
  checks: DiagnosticBundleVerificationCheck[]
}

export interface DiagnosticBundleResult {
  /**
   * True only when (a) the ZIP was written without error AND (b) every
   * post-write self-verification check passed. Callers reporting "saved
   * successfully" must look at this exact field, not just the existence
   * of `path`.
   */
  success: boolean
  path?: string
  /** Size of the produced ZIP in bytes; useful for renderer-side toast. */
  bytes?: number
  error?: string
  /**
   * How the bundle was actually delivered. 'sync-directory' means the
   * threadpool-immune fallback ran (requested, or the zip step timed out)
   * and `path` points at a directory, not a .zip.
   */
  archiveMode?: 'zip' | 'sync-directory'
  /** Manifest of what landed inside the ZIP — used by tests + telemetry. */
  manifest?: {
    chunkCount: number
    chunkBytes: number
    stateFiles: string[]
    missingFiles: string[]
  }
  /**
   * Closed-loop self-verification. After the ZIP is written we open it
   * again with yauzl and confirm every claimed entry is present and
   * parseable. Failures here surface in the renderer status line so the
   * user knows the on-disk file is suspect even if the write step
   * succeeded.
   */
  verification?: DiagnosticBundleVerification
}

/**
 * Set of small state files we always try to bundle. Each is optional —
 * a fresh install may not have all of them yet, and we silently skip
 * missing ones rather than abort.
 */
const STATE_FILES = [
  'app-state.json',
  'telemetry-events.jsonl',
  'settings.json',
  'window-state.json',
  'feedback.json'
] as const

const README_FILENAME = 'README.txt'
const SYSTEM_INFO_FILENAME = 'system-info.txt'
const AGENT_GUIDE_FILENAME = 'AGENT-GUIDE.md'

export async function createDiagnosticBundle(
  opts: CreateDiagnosticBundleOptions
): Promise<DiagnosticBundleResult> {
  const isoTs = opts.timestamp ?? new Date().toISOString()
  const traceDir = opts.traceDir ?? join(opts.userDataDir, 'traces')

  // Stage state files in a process-temp directory so a write race in the
  // app-state storage layer doesn't corrupt the bundled snapshot. Trace
  // chunks are append-only and rotated, so they stream directly from the
  // live directory.
  let stagingDir: string | null = null
  try {
    stagingDir = mkdtempSync(join(tmpdir(), 'onward-diagnostic-stage-'))
  } catch (error) {
    return { success: false, error: `staging-mkdir-failed: ${String(error)}` }
  }

  const stagedStateFiles: Array<{ src: string; entry: string }> = []
  const missingFiles: string[] = []
  for (const filename of STATE_FILES) {
    const src = join(opts.userDataDir, filename)
    if (!existsSync(src)) {
      missingFiles.push(filename)
      continue
    }
    const stagedPath = join(stagingDir, filename)
    try {
      copyFileSync(src, stagedPath)
      stagedStateFiles.push({ src: stagedPath, entry: filename })
    } catch (error) {
      // Treat copy failure as "missing" rather than aborting the whole
      // bundle — partial diagnostic data is still useful, and the README
      // will surface the gap.
      missingFiles.push(`${filename} (copy failed: ${String(error)})`)
    }
  }

  // Enumerate trace chunks (latest.txt + every perf-*.jsonl).
  //
  // CRITICAL: Trace chunks may still be receiving writes from the trace
  // store at the moment we scan (the IPC handler should call
  // `traceStore.rotate()` BEFORE invoking us, but we cannot rely on
  // every caller doing so). We `readFileSync` the chunk into a Buffer
  // here and pass that Buffer to yazl via `addBuffer` later. This
  // captures the chunk's bytes at one synchronous instant — yazl
  // measures the size from `buffer.length` (not from a later `fs.stat`
  // race against `fs.createReadStream`), so the "file data stream has
  // unexpected number of bytes" failure mode is structurally
  // impossible. Memory cost: peak ≤ 8 MB per chunk while in flight.
  const traceChunks: Array<{ entry: string; bytes: number; data: Buffer }> = []
  let chunkBytesTotal = 0
  let traceLatestPointer: string | null = null
  if (existsSync(traceDir)) {
    let entries: string[] = []
    try {
      entries = readdirSync(traceDir)
    } catch {
      entries = []
    }
    for (const f of entries) {
      const full = join(traceDir, f)
      if (f === 'latest.txt') {
        traceLatestPointer = full
        continue
      }
      if (!f.endsWith('.jsonl')) continue
      try {
        const data = readFileSync(full)
        traceChunks.push({ entry: `traces/${f}`, bytes: data.length, data })
        chunkBytesTotal += data.length
      } catch {
        // chunk vanished mid-scan — rotation may have unlinked it; ignore.
      }
    }
    // Sort chunks by filename so the ZIP listing is deterministic and
    // mirrors the seq order on disk.
    traceChunks.sort((a, b) => a.entry.localeCompare(b.entry))
  }

  // Compose README + system-info + AGENT-GUIDE content in memory.
  // The AGENT-GUIDE is generated dynamically here — co-located with
  // the bundling pipeline so it always reflects exactly which files
  // we packaged this run (chunks present? state files missing?
  // content-capture env on?). A separate AI agent reading the bundle
  // uses it as the entry point: file inventory + format / schema
  // pointers + cross-file correlation recipes + known anti-patterns.
  const readmeContent = renderReadme({
    isoTs,
    appInfo: opts.appInfo,
    chunkCount: traceChunks.length,
    chunkBytes: chunkBytesTotal,
    missingStateFiles: missingFiles
  })
  const systemInfoContent = renderSystemInfo({ isoTs, appInfo: opts.appInfo, terminalCwds: opts.terminalCwds })
  const agentGuideContent = renderAgentGuide({
    isoTs,
    appInfo: opts.appInfo,
    chunkEntries: traceChunks.map((c) => ({ entry: c.entry, bytes: c.bytes })),
    chunkBytesTotal,
    stateFiles: stagedStateFiles.map((e) => e.entry),
    missingStateFiles: missingFiles,
    hasLatestTxt: traceLatestPointer !== null,
    captureContentActive: process.env.ONWARD_PERF_TRACE_CAPTURE_CONTENT === '1'
  })

  // ── Pre-write source SHA-256 capture (V7/V8/V9 inputs) ──
  //
  // Hash every byte we are about to hand to yazl. The verifier later
  // re-hashes the bytes it gets back from yauzl and demands an exact
  // match. This is the hard-rule "byte-equivalence at the yazl I/O
  // boundary" check that supersedes the old `>0` length sanity.
  const expectedChunkEntries = new Map<string, ExpectedEntryHash>()
  for (const chunk of traceChunks) {
    expectedChunkEntries.set(chunk.entry, {
      sha256: sha256OfBuffer(chunk.data),
      length: chunk.data.length
    })
  }
  const expectedStateFileEntries = new Map<string, ExpectedEntryHash>()
  for (const entry of stagedStateFiles) {
    // Re-read the staged copy. The staging dir is owned by this
    // process, so this read is race-free against the userData
    // writers. The staged bytes here are exactly what `addFile`
    // streams into the ZIP.
    let buf: Buffer
    try {
      buf = readFileSync(entry.src)
    } catch (error) {
      cleanupStaging(stagingDir)
      return { success: false, error: `staged-read-failed: ${entry.entry}: ${String(error)}` }
    }
    expectedStateFileEntries.set(entry.entry, {
      sha256: sha256OfBuffer(buf),
      length: buf.length
    })
  }
  const readmeBuffer = Buffer.from(readmeContent, 'utf8')
  const systemInfoBuffer = Buffer.from(systemInfoContent, 'utf8')
  const agentGuideBuffer = Buffer.from(agentGuideContent, 'utf8')
  const expectedReadme: ExpectedEntryHash = {
    sha256: sha256OfBuffer(readmeBuffer),
    length: readmeBuffer.length
  }
  const expectedSystemInfo: ExpectedEntryHash = {
    sha256: sha256OfBuffer(systemInfoBuffer),
    length: systemInfoBuffer.length
  }
  const expectedAgentGuide: ExpectedEntryHash = {
    sha256: sha256OfBuffer(agentGuideBuffer),
    length: agentGuideBuffer.length
  }
  let expectedLatestTxt: ExpectedEntryHash | null = null
  if (traceLatestPointer) {
    try {
      const buf = readFileSync(traceLatestPointer)
      expectedLatestTxt = {
        sha256: sha256OfBuffer(buf),
        length: buf.length
      }
    } catch {
      // latest.txt vanished — verifier will report V8 fail with a clear
      // detail since the entry is expected.
      expectedLatestTxt = { sha256: '', length: 0 }
    }
  }

  const archiveInput: StreamArchiveInput = {
    outputPath: opts.outputPath,
    readmeContent,
    systemInfoContent,
    agentGuideContent,
    stagedStateFiles,
    traceChunks,
    traceLatestPointer
  }

  // Archive step. 'zip' rides the libuv threadpool (yazl zlib +
  // createWriteStream) and therefore self-downgrades to the synchronous
  // directory writer on timeout; 'sync-directory' skips the pool entirely.
  let archiveMode: 'zip' | 'sync-directory' = opts.archiveMode ?? 'zip'
  let producedBytes = 0
  if (archiveMode === 'zip') {
    try {
      await streamArchiveWithTimeout(archiveInput, opts.archiveTimeoutMs ?? DEFAULT_ARCHIVE_TIMEOUT_MS)
      try {
        producedBytes = statSync(opts.outputPath).size
      } catch {
        producedBytes = 0
      }
    } catch {
      // Timeout or stream error: fall through to the threadpool-immune
      // sync-directory delivery instead of failing log generation at the
      // exact moment it is most needed.
      archiveMode = 'sync-directory'
    }
  }

  if (archiveMode === 'sync-directory') {
    const fallback = writeBundleDirectorySync(archiveInput)
    cleanupStaging(stagingDir)
    return {
      success: fallback.verification.ok,
      path: fallback.path,
      bytes: fallback.bytes,
      archiveMode,
      error: fallback.verification.ok ? undefined : 'sync-fallback-verification-failed',
      manifest: {
        chunkCount: traceChunks.length,
        chunkBytes: chunkBytesTotal,
        stateFiles: stagedStateFiles.map((entry) => entry.entry),
        missingFiles
      },
      verification: fallback.verification
    }
  }

  cleanupStaging(stagingDir)

  const manifest = {
    chunkCount: traceChunks.length,
    chunkBytes: chunkBytesTotal,
    stateFiles: stagedStateFiles.map((entry) => entry.entry),
    missingFiles
  }

  // Closed-loop self-verification: open the ZIP we just wrote and
  // demand byte-equivalence against the sources we hashed above.
  // Hard-rule fail on any mismatch; no `>0` / `>=` tolerance.
  const verification = await verifyBundleArchive(opts.outputPath, {
    expectedStateFileEntries,
    expectedChunkEntries,
    expectedReadme,
    expectedSystemInfo,
    expectedAgentGuide,
    expectedLatestTxt,
    expectedMarker: opts.expectedMarker
  })

  if (!verification.ok) {
    const failedNames = verification.checks
      .filter((c) => !c.passed)
      .map((c) => c.name)
      .join(', ')
    return {
      success: false,
      path: opts.outputPath,
      bytes: producedBytes,
      error: `verification-failed: ${failedNames}`,
      manifest,
      verification
    }
  }

  return {
    success: true,
    path: opts.outputPath,
    bytes: producedBytes,
    archiveMode: 'zip',
    manifest,
    verification
  }
}

const DEFAULT_ARCHIVE_TIMEOUT_MS = 15_000

function streamArchiveWithTimeout(input: StreamArchiveInput, timeoutMs: number): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      reject(new Error(`archive-timeout-${timeoutMs}ms`))
    }, timeoutMs)
    timer.unref()
    streamArchive(input).then(
      () => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve()
      },
      (err) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        reject(err)
      }
    )
  })
}

/**
 * Threadpool-immune bundle delivery: write the exact same content the ZIP
 * would have carried as a plain directory tree, using only synchronous fs.
 * Verification is a sync existence + byte-length sweep (the zip path's
 * yauzl-based byte-equivalence check also rides the threadpool and is
 * unavailable in this mode).
 */
function writeBundleDirectorySync(input: StreamArchiveInput): {
  path: string
  bytes: number
  verification: DiagnosticBundleVerification
} {
  const dirPath = input.outputPath.replace(/\.zip$/i, '') + '-bundle'
  const checks: DiagnosticBundleVerificationCheck[] = []
  let totalBytes = 0

  const writeEntry = (entry: string, data: Buffer): void => {
    const target = join(dirPath, entry)
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, data)
    const actual = statSync(target).size
    totalBytes += actual
    checks.push({
      name: `sync-entry:${entry}`,
      passed: actual === data.length,
      detail: actual === data.length ? undefined : `size ${actual} != ${data.length}`
    })
  }

  try {
    mkdirSync(dirPath, { recursive: true })
    writeEntry(README_FILENAME, Buffer.from(input.readmeContent, 'utf8'))
    writeEntry(SYSTEM_INFO_FILENAME, Buffer.from(input.systemInfoContent, 'utf8'))
    writeEntry(AGENT_GUIDE_FILENAME, Buffer.from(input.agentGuideContent, 'utf8'))
    for (const staged of input.stagedStateFiles) {
      writeEntry(staged.entry, readFileSync(staged.src))
    }
    if (input.traceLatestPointer) {
      writeEntry('traces/latest.txt', readFileSync(input.traceLatestPointer))
    }
    for (const chunk of input.traceChunks) {
      writeEntry(chunk.entry, chunk.data)
    }
  } catch (error) {
    checks.push({ name: 'sync-directory-write', passed: false, detail: String(error) })
  }

  return {
    path: dirPath,
    bytes: totalBytes,
    verification: { ok: checks.every((c) => c.passed), checks }
  }
}

interface StreamArchiveInput {
  outputPath: string
  readmeContent: string
  systemInfoContent: string
  agentGuideContent: string
  stagedStateFiles: Array<{ src: string; entry: string }>
  // Trace chunks are read into Buffers upstream so yazl's addBuffer
  // captures their size at submit time and cannot race the live trace
  // store's writeSync. Do NOT switch back to addFile for chunks.
  traceChunks: Array<{ entry: string; bytes: number; data: Buffer }>
  traceLatestPointer: string | null
}

function streamArchive(input: StreamArchiveInput): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const output = createWriteStream(input.outputPath)
    // yazl pre-compresses Buffer adds in memory; for our small generated
    // text payloads (README, system-info, AGENT-GUIDE) and modest
    // source files (~64 MB max from traces) this is a non-issue.
    // addFile streams from disk so big trace chunks do not load into
    // memory beyond the readFileSync staging upstream.
    const zipfile = new ZipFile()

    let settled = false
    const settle = (cb: () => void) => {
      if (settled) return
      settled = true
      cb()
    }

    output.on('close', () => settle(() => resolve()))
    output.on('error', (err) => settle(() => reject(err)))
    zipfile.outputStream.on('error', (err) => settle(() => reject(err)))
    zipfile.outputStream.pipe(output)

    zipfile.addBuffer(Buffer.from(input.readmeContent, 'utf8'), README_FILENAME)
    zipfile.addBuffer(Buffer.from(input.systemInfoContent, 'utf8'), SYSTEM_INFO_FILENAME)
    zipfile.addBuffer(Buffer.from(input.agentGuideContent, 'utf8'), AGENT_GUIDE_FILENAME)

    for (const entry of input.stagedStateFiles) {
      zipfile.addFile(entry.src, entry.entry)
    }
    if (input.traceLatestPointer) {
      zipfile.addFile(input.traceLatestPointer, 'traces/latest.txt')
    }
    for (const chunk of input.traceChunks) {
      // addBuffer: size + bytes captured atomically. Race-free against
      // a live trace store still writing to the chunk on disk.
      zipfile.addBuffer(chunk.data, chunk.entry)
    }

    zipfile.end()
  })
}

function cleanupStaging(stagingDir: string | null): void {
  if (!stagingDir) return
  try {
    rmSync(stagingDir, { recursive: true, force: true })
  } catch {
    // The OS will reap the temp dir eventually; cleanup failure is not
    // worth surfacing to the user.
  }
}

interface ReadmeContext {
  isoTs: string
  appInfo?: DiagnosticBundleAppInfo
  chunkCount: number
  chunkBytes: number
  missingStateFiles: string[]
}

function renderReadme(ctx: ReadmeContext): string {
  const versionLine = ctx.appInfo?.version ?? 'unknown'
  const buildLine = ctx.appInfo?.buildChannel
    ? `${ctx.appInfo.buildChannel}${ctx.appInfo.branch ? ` (${ctx.appInfo.branch})` : ''}${ctx.appInfo.tag ? ` tag=${ctx.appInfo.tag}` : ''}`
    : 'unknown'
  const platformLine = `${process.platform} (${process.arch})`
  const tracesDescriptor = ctx.chunkCount === 0
    ? '(empty — no chunks captured this session)'
    : `${ctx.chunkCount} chunk(s), ${formatBytes(ctx.chunkBytes)} total`
  const missingLine = ctx.missingStateFiles.length === 0
    ? '(none)'
    : ctx.missingStateFiles.join(', ')

  return [
    'Onward Diagnostic Bundle',
    '========================',
    `Generated  : ${ctx.isoTs}`,
    `App version: ${versionLine}`,
    `Build      : ${buildLine}`,
    `Platform   : ${platformLine}`,
    '',
    'Contents',
    '========',
    `traces/                  NDJSON perf trace chunks ${tracesDescriptor}.`,
    '                         Chrome Trace Event Format per line; rotated 8',
    '                         MB / chunk; 64 MB total cap. Open with',
    '                         Onward\'s infra/scripts/open_trace.sh which',
    '                         wraps the chunks into the {"traceEvents":[…]}',
    '                         envelope tp_shell expects.',
    'app-state.json           Tab / terminal / cwd / project-editor state.',
    'telemetry-events.jsonl   Session heartbeats, dropdown clicks, prompt',
    '                         use, update checks (NDJSON).',
    'settings.json            Theme / language / preferences.',
    'window-state.json        Last window bounds.',
    'feedback.json            Local feedback history.',
    'system-info.txt          OS / arch / Electron / runtime details.',
    '',
    `Missing files: ${missingLine}`,
    '',
    'Privacy',
    '=======',
    'This bundle contains LOCAL PATHS from your machine — file paths in',
    'app-state.json and telemetry-events.jsonl (e.g. /Users/<you>/...).',
    'Trace events go through field-name PII redaction inside the running',
    'app, but the JSON state files do not. Review before sharing',
    'externally.',
    ''
  ].join('\n')
}

interface SystemInfoContext {
  isoTs: string
  appInfo?: DiagnosticBundleAppInfo
  /** Live terminal cwds (terminalId → cwd) for volume classification. */
  terminalCwds?: Array<{ terminalId: string; cwd: string | null }>
}

/**
 * Read a PowerShell ExecutionPolicy value straight from the registry via
 * `reg.exe` — an ordinary executable, so this NEVER trips the very script
 * policies it is diagnosing (2026-07 bundles: the analysis could not tell
 * Restricted from AllSigned-via-GPO from AppLocker without asking the user).
 */
function readRegistryExecutionPolicy(keyPath: string): string {
  try {
    const out = execFileSync('reg.exe', ['query', keyPath, '/v', 'ExecutionPolicy'], {
      timeout: 2000,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore']
    }).toString()
    const match = /ExecutionPolicy\s+REG_SZ\s+(\S+)/i.exec(out)
    return match ? match[1] : '(value missing)'
  } catch {
    return '(not set)'
  }
}

/**
 * Classify the volume a terminal cwd lives on. UNC is a prefix check;
 * mapped network drives are detected via `net.exe use X:` (exit 0 only for
 * mapped drives). Both are plain executables — no script policy exposure.
 */
function classifyWindowsCwdVolume(
  cwd: string,
  mappedDriveCache: Map<string, boolean>
): 'unc' | 'mapped-network' | 'local-or-unknown' {
  if (/^\\\\/.test(cwd)) return 'unc'
  const driveMatch = /^([A-Za-z]):[\\/]/.exec(cwd)
  if (!driveMatch) return 'local-or-unknown'
  const drive = driveMatch[1].toUpperCase()
  let mapped = mappedDriveCache.get(drive)
  if (mapped === undefined) {
    try {
      execFileSync('net.exe', ['use', `${drive}:`], {
        timeout: 2000,
        windowsHide: true,
        stdio: ['ignore', 'ignore', 'ignore']
      })
      mapped = true
    } catch {
      mapped = false
    }
    mappedDriveCache.set(drive, mapped)
  }
  return mapped ? 'mapped-network' : 'local-or-unknown'
}

function renderSystemInfo(ctx: SystemInfoContext): string {
  const onwardEnv: Array<[string, string]> = []
  for (const [key, value] of Object.entries(process.env)) {
    if (!key.startsWith('ONWARD_')) continue
    if (value === undefined) continue
    onwardEnv.push([key, value])
  }
  onwardEnv.sort(([a], [b]) => a.localeCompare(b))

  const lines: string[] = []
  lines.push(`generatedAt=${ctx.isoTs}`)
  lines.push(`platform=${process.platform}`)
  lines.push(`arch=${process.arch}`)
  lines.push(`nodeVersion=${process.versions.node}`)
  lines.push(`v8Version=${process.versions.v8}`)
  lines.push(`electronVersion=${process.versions.electron ?? ctx.appInfo?.electronVersion ?? 'unknown'}`)
  lines.push(`appVersion=${ctx.appInfo?.version ?? 'unknown'}`)
  lines.push(`buildChannel=${ctx.appInfo?.buildChannel ?? 'unknown'}`)
  lines.push(`branch=${ctx.appInfo?.branch ?? 'unknown'}`)
  lines.push(`tag=${ctx.appInfo?.tag ?? 'unknown'}`)
  lines.push(`productName=${ctx.appInfo?.productName ?? 'unknown'}`)
  lines.push(`pid=${process.pid}`)
  lines.push('')
  lines.push('# ONWARD_* environment variables (one per line)')
  if (onwardEnv.length === 0) {
    lines.push('# (none set)')
  } else {
    for (const [key, value] of onwardEnv) {
      // Redact obvious secrets even though we are pinky-promise local —
      // the bundle may be shared, and ONWARD_TELEMETRY_POSTHOG_KEY
      // can carry an ingestion key.
      const redacted = isLikelySecretEnv(key) ? '[redacted]' : value
      lines.push(`${key}=${redacted}`)
    }
  }
  if (process.platform === 'win32') {
    // 2026-07 bundle-analysis P1: the shell-integration RC-1 diagnosis
    // needed the machine's script-policy environment and the cwd's volume
    // class (network drives drive the RC-2 timeout) — neither was captured.
    // All reads go through plain executables (reg.exe / net.exe); no
    // PowerShell script is ever executed here.
    lines.push('')
    lines.push('# PowerShell execution policy (registry read; no script executed)')
    lines.push(`psPolicy.MachinePolicy=${readRegistryExecutionPolicy('HKLM\\SOFTWARE\\Policies\\Microsoft\\Windows\\PowerShell')}`)
    lines.push(`psPolicy.UserPolicy=${readRegistryExecutionPolicy('HKCU\\SOFTWARE\\Policies\\Microsoft\\Windows\\PowerShell')}`)
    lines.push(`psPolicy.CurrentUser=${readRegistryExecutionPolicy('HKCU\\SOFTWARE\\Microsoft\\PowerShell\\1\\ShellIds\\Microsoft.PowerShell')}`)
    lines.push(`psPolicy.LocalMachine=${readRegistryExecutionPolicy('HKLM\\SOFTWARE\\Microsoft\\PowerShell\\1\\ShellIds\\Microsoft.PowerShell')}`)
    if (ctx.terminalCwds && ctx.terminalCwds.length > 0) {
      lines.push('')
      lines.push('# Terminal cwd volume classes (unc | mapped-network | local-or-unknown)')
      const mappedDriveCache = new Map<string, boolean>()
      for (const { terminalId, cwd } of ctx.terminalCwds) {
        if (!cwd) {
          lines.push(`cwdVolume.${terminalId}=(no cwd)`)
          continue
        }
        lines.push(`cwdVolume.${terminalId}=${classifyWindowsCwdVolume(cwd, mappedDriveCache)}`)
      }
    }
  }
  lines.push('')
  return lines.join('\n')
}

function isLikelySecretEnv(key: string): boolean {
  return /CONNECTION_STRING|SECRET|TOKEN|PASSWORD|KEY/i.test(key)
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`
}

interface AgentGuideContext {
  isoTs: string
  appInfo?: DiagnosticBundleAppInfo
  chunkEntries: Array<{ entry: string; bytes: number }>
  chunkBytesTotal: number
  stateFiles: string[]
  missingStateFiles: string[]
  hasLatestTxt: boolean
  captureContentActive: boolean
}

/**
 * Generate the `AGENT-GUIDE.md` content as a string. Co-located with
 * the bundling pipeline so the doc reflects EXACTLY what this run is
 * packaging — chunk count + state-file presence + content-capture
 * mode are stamped into the doc, not assumed from a static template.
 *
 * Audience: another AI agent that has been handed this bundle by the
 * user and is asked to triage. The guide gives it (a) a file-by-file
 * inventory, (b) format / schema pointers, (c) cross-file correlation
 * recipes, (d) known anti-pattern signatures.
 *
 * English-only on purpose — easier for any LLM to parse vs.
 * mixed-script content. The user-facing renderer status text is
 * still i18n.
 */
function renderAgentGuide(ctx: AgentGuideContext): string {
  const versionLine = ctx.appInfo?.version ?? 'unknown'
  const buildLine = ctx.appInfo?.buildChannel
    ? `${ctx.appInfo.buildChannel}${ctx.appInfo.branch ? ` (${ctx.appInfo.branch})` : ''}${ctx.appInfo.tag ? ` tag=${ctx.appInfo.tag}` : ''}`
    : 'unknown'
  const localTs = formatLocalTimestampLabel(ctx.isoTs)
  const platformLine = `${process.platform} ${process.arch} (Electron ${ctx.appInfo?.electronVersion ?? process.versions.electron ?? 'unknown'})`
  const chunkRows = ctx.chunkEntries.length === 0
    ? '_(no chunks bundled — trace store had nothing this session)_'
    : ctx.chunkEntries
      .map((c) => `- \`${c.entry}\` — ${formatBytes(c.bytes)}`)
      .join('\n')
  const stateRows = ctx.stateFiles.length === 0
    ? '_(no state files staged)_'
    : ctx.stateFiles.map((f) => `- \`${f}\``).join('\n')
  const missingRows = ctx.missingStateFiles.length === 0
    ? '_(none)_'
    : ctx.missingStateFiles.map((f) => `- \`${f}\``).join('\n')

  const lines: string[] = []
  lines.push('# Onward Diagnostic Bundle — Agent Analysis Guide')
  lines.push('')
  lines.push('> You are an AI agent triaging an Onward (Electron + React desktop terminal) bug report. This bundle was captured locally on the user\'s machine and handed to you for analysis. Use this guide as the entry point: it lists the exact files in this bundle, their formats, and recipes for correlating signals across them.')
  lines.push('')
  lines.push('## Bundle metadata')
  lines.push('')
  lines.push(`- **Generated (local)**: ${localTs}`)
  lines.push(`- **Generated (UTC)**: ${ctx.isoTs}`)
  lines.push(`- **App version**: ${versionLine}`)
  lines.push(`- **Build**: ${buildLine}`)
  lines.push(`- **Platform**: ${platformLine}`)
  lines.push(`- **Trace chunks**: ${ctx.chunkEntries.length} file(s), ${formatBytes(ctx.chunkBytesTotal)} total`)
  lines.push(`- **Sensitive content capture**: ${ctx.captureContentActive ? '**ACTIVE** (`ONWARD_PERF_TRACE_CAPTURE_CONTENT=1` was set — chunks may contain raw PTY / prompt text)' : 'inactive (default — only length / line-count / salted hashes for free-text fields)'}`)
  lines.push('')
  lines.push('## Inventory')
  lines.push('')
  lines.push('### Generated metadata (this bundle)')
  lines.push('')
  lines.push('| File | Format | Purpose |')
  lines.push('|---|---|---|')
  lines.push('| `README.txt` | plain text | Human-friendly bundle overview + privacy notice. Open this first if a human is triaging. |')
  lines.push('| `AGENT-GUIDE.md` | Markdown | This file — your reading guide. Generated dynamically per bundle to match what was actually packaged. |')
  lines.push('| `system-info.txt` | `key=value` lines | OS / arch / Electron / runtime versions and a snapshot of `ONWARD_*` environment variables (secrets pre-redacted to `[redacted]`). |')
  lines.push('')
  lines.push('### State files (copied from userData)')
  lines.push('')
  lines.push(stateRows)
  lines.push('')
  if (ctx.missingStateFiles.length > 0) {
    lines.push('Missing on this run (the user simply hadn\'t generated them yet — not an error):')
    lines.push('')
    lines.push(missingRows)
    lines.push('')
  }
  lines.push('### Trace chunks (`traces/`)')
  lines.push('')
  lines.push(chunkRows)
  lines.push('')
  if (ctx.hasLatestTxt) {
    lines.push('Plus `traces/latest.txt` — pointer file storing the absolute trace directory path on the user\'s machine at bundle time.')
    lines.push('')
  }
  lines.push('## File schemas')
  lines.push('')
  lines.push('### `traces/perf-NNNN-*.jsonl` — NDJSON of Chrome Trace Event Format')
  lines.push('')
  lines.push('Each line is one JSON object. The bundle creator calls `traceStore.rotate()` before snapshotting, so the chunks here are sealed — no race against a live writer.')
  lines.push('')
  lines.push('```json')
  lines.push('{')
  lines.push('  "ph": "X" | "i" | "C" | "M" | "s" | "t" | "f",')
  lines.push('  "name": "<event-name>",')
  lines.push('  "ts": <microseconds since epoch>,')
  lines.push('  "pid": 1 | 2 | 3,')
  lines.push('  "tid": <number>,')
  lines.push('  "dur": <microseconds, ph=\'X\' only>,')
  lines.push('  "cat": "<category>",')
  lines.push('  "args": { ... }')
  lines.push('}')
  lines.push('```')
  lines.push('')
  lines.push('PID convention:')
  lines.push('- `pid=1` Onward main process')
  lines.push('- `pid=2` Onward renderer process')
  lines.push('- `pid=3` virtual "Tasks" process — markTaskInput / markTaskRunning / markTaskOutput / markTaskExited / markTaskIdle lifecycle events. One tid per terminalId.')
  lines.push('')
  lines.push('TID convention (within pid=1 or pid=2):')
  lines.push('- `tid=1` main thread / canonical renderer thread')
  lines.push('- `tid=5001..5006` worker threads (`git-ipc-worker`, `git-status-worker`, `project-fs-worker`, `sqlite-worker`, `app-state-worker`, `ripgrep-search-worker`)')
  lines.push('- `tid=10000+` per-Task lanes on main side, `tid=20000+` per-Task lanes on renderer side. The `M` (metadata) records emit a `thread_name` payload `task-<shortId>` so Perfetto labels these rows.')
  lines.push('')
  lines.push('Tail tolerance: at most ONE non-empty trailing line per chunk may be unparseable JSON. That is the in-flight write at the moment of SIGKILL. Treat any earlier parse failure as corruption.')
  lines.push('')
  lines.push('> **Do not parse this file line-by-line as raw text.** That works for spot-checks but is the wrong tool for analysis. Load the chunks into Perfetto `trace_processor` and use SQL — see § "Querying the trace data" below. The file is NDJSON (a JSON variant), it is **not** Parquet despite Parquet\'s SQL-friendly reputation; the Parquet conversion path is documented in the same section if a downstream pipeline requires it.')
  lines.push('')
  lines.push('### `telemetry-events.jsonl` — NDJSON of session-level events')
  lines.push('')
  lines.push('```json')
  lines.push('{')
  lines.push('  "timestamp": "<ISO 8601 UTC>",')
  lines.push('  "name": "<event/name>",')
  lines.push('  "properties": { ... },')
  lines.push('  "common": {')
  lines.push('    "instanceId": "<uuid>",')
  lines.push('    "sessionId": "<uuid>",')
  lines.push('    "appVersion": "<X.Y.Z[-channel.date.N]>",')
  lines.push('    "buildChannel": "dev | prod",')
  lines.push('    "releaseChannel": "daily | stable",')
  lines.push('    "platform": "darwin | win32 | linux",')
  lines.push('    "arch": "x64 | arm64",')
  lines.push('    "electronVersion": "<X.Y.Z>"')
  lines.push('  }')
  lines.push('}')
  lines.push('```')
  lines.push('')
  lines.push('High-signal event names to look for:')
  lines.push('- `session/start` — app boot. The very first one in a chunk.')
  lines.push('- `session/heartbeat` — every 5 minutes; carries `activeMs`, `tabCount`, `terminalCount`, `layoutMode`. Sudden gap > 5 min ⇒ the app was unresponsive or killed.')
  lines.push('- `session/end` — clean shutdown. Absence ⇒ the app exited abruptly (crash, force-quit, OS-level kill).')
  lines.push('- `prompt/use` with `properties.action` ∈ `send` / `execute` / `sendAndExecute` / `sendAllAndExecute` — user pressed the prompt action button.')
  lines.push('- `dropdown/development` with `properties.action` ∈ `editor` / `gitDiff` / `gitHistory` — user opened a development sub-page.')
  lines.push('- `update/check` — periodic update poll; `properties.result` says `up-to-date` / `update-available` / `error`.')
  lines.push('')
  lines.push('### `app-state.json` — UI state')
  lines.push('')
  lines.push('Fields most relevant to triage:')
  lines.push('- `activeTabId` — the tab that was focused at the last save')
  lines.push('- `tabs[*].terminals[*].lastCwd` — each terminal\'s last working directory')
  lines.push('- `tabs[*].activeTerminalId` — focused terminal in each tab')
  lines.push('- `projectEditorStates` — keyed by `[terminalId, cwd]`; non-empty means the user opened the project editor at least once for that combo')
  lines.push('- `tabs[*].activeSubpage` / `subpageTerminalId` — set when a Git Diff / History / Editor sub-page is open at save time')
  lines.push('')
  lines.push('### `system-info.txt` — runtime metadata + ONWARD_* env')
  lines.push('')
  lines.push('Plain `key=value` lines. Secrets matched by `/CONNECTION_STRING|SECRET|TOKEN|PASSWORD|KEY/i` are pre-redacted to `[redacted]` before bundling — the unredacted values never leave the user\'s machine.')
  lines.push('')
  lines.push('## Querying the trace data (primary path: SQL via Perfetto `trace_processor`)')
  lines.push('')
  lines.push('**This section is for you, the agent.** Do not pure-text-parse the chunk files — at scale (multiple sessions, ~50 MB / bundle) line-by-line scanning is slow, brittle, and miscounts events that span chunk boundaries. The right tool is Perfetto\'s `trace_processor`: it ingests Chrome JSON traces, normalizes them into a relational SQL schema (Perfetto\'s internal columnar storage; NOT Parquet, but functionally similar — fast aggregate queries on millions of events), and exposes a standard SQL query interface used by the Onward team\'s own scripts.')
  lines.push('')
  lines.push('### Format facts')
  lines.push('')
  lines.push('| Question | Answer |')
  lines.push('|---|---|')
  lines.push('| Is `traces/*.jsonl` Parquet? | **No.** It is NDJSON (one JSON object per line) of [Chrome Trace Event Format](https://docs.google.com/document/d/1CvAClvFfyA5R-PhYUmn5OOQtYMH4h6I0nSsKchNAySU). Do not point a Parquet reader at it — the file extension and content are JSON. |')
  lines.push('| Then how do I run SQL on it? | Wrap the chunks into a `{"traceEvents":[…]}` JSON envelope (Step A below), then load into `trace_processor` (Step B). After ingestion, every event becomes a row in tables like `slice`, `thread`, `process`, `args`, `counter` — query with standard SQL. |')
  lines.push('| Can I get actual Parquet files? | Yes, derived. Run a SQL query → pandas DataFrame → `.to_parquet()` — recipe in Step C. Useful only if a downstream pipeline (DuckDB, BigQuery, Spark) needs columnar input. For ad-hoc analysis the SQL-on-`trace_processor` path is faster and skips a conversion step. |')
  lines.push('| Can I visualize? | Yes — same envelope file (Step A) loads into the [Perfetto UI](https://ui.perfetto.dev/) directly. Step D below. |')
  lines.push('')
  lines.push('### Step A — combine chunks into one ingestable file')
  lines.push('')
  lines.push('All paths below (SQL ingestion, UI visualization, Parquet conversion) start from a single `trace.json` file in the canonical Chrome envelope shape. Build it once:')
  lines.push('')
  lines.push('```bash')
  lines.push('node -e \'')
  lines.push('  const fs = require("fs"), path = require("path");')
  lines.push('  const dir = process.argv[1];')
  lines.push('  const out = process.argv[2];')
  lines.push('  const chunks = fs.readdirSync(dir).filter(f => f.endsWith(".jsonl")).sort();')
  lines.push('  const ws = fs.createWriteStream(out);')
  lines.push('  ws.write("{\\"traceEvents\\":[\\n");')
  lines.push('  let first = true;')
  lines.push('  for (const c of chunks) {')
  lines.push('    for (const line of fs.readFileSync(path.join(dir, c), "utf8").split("\\n")) {')
  lines.push('      const t = line.trim(); if (!t) continue;')
  lines.push('      try { JSON.parse(t); } catch { continue; }')
  lines.push('      if (!first) ws.write(",\\n");')
  lines.push('      ws.write("  " + t);')
  lines.push('      first = false;')
  lines.push('    }')
  lines.push('  }')
  lines.push('  ws.write("\\n]}\\n"); ws.end();')
  lines.push('\' ./traces ./trace.json')
  lines.push('```')
  lines.push('')
  lines.push('Tolerates partial tail lines (the in-flight write at SIGKILL) and bad-JSON lines (always skip rather than abort). Output is a single Chrome JSON trace.')
  lines.push('')
  lines.push('### Step B — load into `trace_processor` and run SQL')
  lines.push('')
  lines.push('```bash')
  lines.push('# Install once. Pure-pip, no native deps.')
  lines.push('pip install perfetto')
  lines.push('```')
  lines.push('')
  lines.push('```python')
  lines.push('from perfetto.trace_processor import TraceProcessor')
  lines.push('tp = TraceProcessor(trace="trace.json")  # ingests + normalizes; ~1s per 100 MB')
  lines.push('')
  lines.push('# Discover the schema once')
  lines.push('print(tp.query("SELECT name FROM perfetto_tables").as_pandas_dataframe())')
  lines.push('# Common tables: slice, thread, process, args, counter, sched, raw')
  lines.push('```')
  lines.push('')
  lines.push('Onward-specific schema notes (after `trace_processor` ingests our Chrome JSON):')
  lines.push('- `slice.name` — the event name we registered in `perf-trace-names.ts` (e.g. `main:event-loop-stall`, `renderer:frame-stall`, `main:terminal-data.ipc-send`).')
  lines.push('- `slice.ts` — start time in nanoseconds (Perfetto rescales from our microseconds-since-epoch). For span events (`ph="X"`) `slice.dur` is set; for instant events (`ph="i"`) `slice.dur = 0`.')
  lines.push('- `slice.category` — the `cat` field. Most Onward events are categorized `onward` or by subsystem (`onward.git`, `onward.terminal`).')
  lines.push('- `args` table — the `args` payload of each event, exposed as `(arg_set_id, key, int_value, string_value, real_value)`. Join `slice` with `args` on `slice.arg_set_id = args.arg_set_id` to inspect payloads.')
  lines.push('- `thread.name` — the metadata-emitted label like `task-<shortId>` (per-Task lanes), `git-status-worker`, etc. Use to filter slices to a specific lane.')
  lines.push('')
  lines.push('### Canonical SQL recipes')
  lines.push('')
  lines.push('Copy / paste / adapt — these are the queries you should reach for FIRST when analyzing an Onward bundle:')
  lines.push('')
  lines.push('```sql')
  lines.push('-- 1. Top-20 longest spans across all of Onward main process')
  lines.push('SELECT name, ts, dur')
  lines.push('FROM slice')
  lines.push('WHERE category LIKE \'onward%\'')
  lines.push('ORDER BY dur DESC')
  lines.push('LIMIT 20;')
  lines.push('')
  lines.push('-- 2. Event-loop stalls > 100 ms (UI freeze evidence)')
  lines.push('SELECT name, ts, dur / 1e6 AS dur_ms')
  lines.push('FROM slice')
  lines.push('WHERE name = \'main:event-loop-stall\' AND dur > 100 * 1e6')
  lines.push('ORDER BY ts;')
  lines.push('')
  lines.push('-- 3. Frame stalls in the renderer, bucketed per second')
  lines.push('SELECT (ts / 1e9)::INT AS sec_since_epoch,')
  lines.push('       COUNT(*) AS frames_dropped,')
  lines.push('       MAX(dur) / 1e6 AS worst_frame_ms')
  lines.push('FROM slice')
  lines.push('WHERE name = \'renderer:frame-stall\'')
  lines.push('GROUP BY 1')
  lines.push('ORDER BY frames_dropped DESC')
  lines.push('LIMIT 20;')
  lines.push('')
  lines.push('-- 4. PTY data flood: ipc-send rate per second per terminal')
  lines.push('SELECT (s.ts / 1e9)::INT AS sec, t.name AS terminal_lane, COUNT(*) AS ipc_per_sec')
  lines.push('FROM slice s JOIN thread t ON s.thread_id = t.id')
  lines.push('WHERE s.name = \'main:terminal-data.ipc-send\'')
  lines.push('GROUP BY 1, 2')
  lines.push('HAVING ipc_per_sec > 100')
  lines.push('ORDER BY ipc_per_sec DESC')
  lines.push('LIMIT 20;')
  lines.push('')
  lines.push('-- 5. GitWatch poll rate: how often the adaptive poller fired')
  lines.push('SELECT name, ts, dur, a.string_value AS repo')
  lines.push('FROM slice s LEFT JOIN args a ON s.arg_set_id = a.arg_set_id AND a.key = \'repo\'')
  lines.push('WHERE name = \'main:gitwatch-summary\'')
  lines.push('ORDER BY ts;')
  lines.push('')
  lines.push('-- 6. Find the LAST trace event before a given user wall-clock time')
  lines.push('--    (use to bracket "what was happening when the user clicked X").')
  lines.push('--    Replace 1714905923000000 with telemetry-event timestamp converted to')
  lines.push('--    microseconds-since-epoch.')
  lines.push('SELECT name, ts, dur, category')
  lines.push('FROM slice')
  lines.push('WHERE ts <= 1714905923000000 * 1000  -- ns')
  lines.push('ORDER BY ts DESC')
  lines.push('LIMIT 20;')
  lines.push('```')
  lines.push('')
  lines.push('### Step C — derived Parquet (optional, only when a downstream pipeline requires it)')
  lines.push('')
  lines.push('Skip this unless you are exporting to BigQuery / DuckDB / Spark / a long-term store. For interactive triage `trace_processor` SQL alone is the fast path.')
  lines.push('')
  lines.push('```python')
  lines.push('# Materialize one query result as a Parquet file.')
  lines.push('df = tp.query("""')
  lines.push('  SELECT name, ts, dur, category')
  lines.push('  FROM slice')
  lines.push('  WHERE category LIKE \'onward%\'')
  lines.push('""").as_pandas_dataframe()')
  lines.push('df.to_parquet("onward-slices.parquet")  # requires pyarrow')
  lines.push('# Now query with DuckDB / pandas / etc.')
  lines.push('```')
  lines.push('')
  lines.push('### Step D — visualize in Perfetto UI (when a human will look)')
  lines.push('')
  lines.push('Drag-and-drop `trace.json` (the file from Step A) into [`https://ui.perfetto.dev/`](https://ui.perfetto.dev/). The data stays in the browser tab — Perfetto explicitly does not upload. Use the timeline to confirm a hypothesis you formed via SQL queries.')
  lines.push('')
  lines.push('If you have access to the Onward repo, `bash infra/scripts/open_trace.sh trace.json` boots a local `trace_processor_shell --httpd` + a version-pinned Perfetto UI URL (zero cloud dependency, no version drift).')
  lines.push('')
  lines.push('## How to perform problem analysis')
  lines.push('')
  lines.push('### Step 1 — establish the timeline')
  lines.push('')
  lines.push('1. Open `telemetry-events.jsonl`. Tail the last few `session/heartbeat` events to find the wall-clock window before the issue.')
  lines.push('2. Look for the LAST user-driven event before the gap or `session/end`: `prompt/use`, `dropdown/development`, etc. That is the operation the user remembers.')
  lines.push('3. Note its `timestamp` (UTC) and convert to the same local timezone the user is in (see `system-info.txt`).')
  lines.push('')
  lines.push('### Step 2 — correlate trace events (SQL recipe #6 above)')
  lines.push('')
  lines.push('Trace `ts` is microseconds since Unix epoch (UTC). Convert the telemetry timestamp to micros and run the "last events before user time" query (recipe #6 in the previous section). Then join with `args` for payload context. Do not grep the chunk files manually.')
  lines.push('')
  lines.push('### Step 3 — match state to the timeline')
  lines.push('')
  lines.push('Cross-reference `app-state.json` against the user\'s narrative:')
  lines.push('- "I clicked editor" → check `tabs[i].activeTerminalId`, then look up `projectEditorStates[<that-terminal>:<that-cwd>]`. A heavy `fileStates` map indicates many recently opened files; a deep `expandedDirs` indicates a large project.')
  lines.push('- "Editor was slow" → cross-reference the active cwd with running agents (other `terminals[*].lastCwd` may be writing files into the editor\'s view via filesystem watcher).')
  lines.push('')
  lines.push('### Step 4 — look for known anti-patterns')
  lines.push('')
  lines.push('| Symptom | Trace signal | Likely cause |')
  lines.push('|---|---|---|')
  lines.push('| UI freeze, force-quit | `main:event-loop-stall` events with `dur > 250ms` clustered on one second | Blocking sync work in main process (heavy IPC handler, fs.readSync of huge file, etc.) |')
  lines.push('| Choppy animation / typing lag | `renderer:frame-stall` with `frameDeltaMs > 100` clustered | CPU-heavy render or layout thrash |')
  lines.push('| Window flicker / popup loop | OS-level NSWindow / X11 events at ~7-10 Hz steady (visible in macOS unified log; **not** in trace chunks) | HTML tooltip flicker, `<select>` re-open loop, autocomplete popup loop |')
  lines.push('| Git polling appearing endless | `main:gitwatch-summary` with `pollRuns/s` rising over 10 | Adaptive polling escalated to fast tier; check whether `ONWARD_GIT_POLLING=0` would help |')
  lines.push('| PTY data flood | `main:terminal-data.ipc-send` rate > 100/s sustained, `bufferAgeMs > 100` | Background agent writing huge output; renderer scheduler is the bottleneck |')
  lines.push('| Crash without `session/end` | Telemetry shows last `session/heartbeat` then a fresh `session/start` < 1 min later | Hard crash: check `~/Library/Logs/DiagnosticReports/` (macOS), Event Viewer (Windows), or core dump for the native crash report. The bundle does NOT include those — ask the user to attach. |')
  lines.push('')
  lines.push('## Privacy guardrails')
  lines.push('')
  lines.push('This bundle was saved locally and the user explicitly chose to share it. Even so:')
  lines.push('- `app-state.json` and `telemetry-events.jsonl` carry **local file paths** like `/Users/<name>/...`. Do not quote them verbatim in any externally-visible response — replace with `<user-home>/...` or `~/...`.')
  lines.push('- Trace event `args` go through field-name PII redaction inside the running app (free-text fields are summarized to length / line-count / salted hash). This redaction is documented at `electron/main/performance-trace.ts::sanitizeArgs` if you have access to the source.')
  lines.push(`- Sensitive-content capture is currently ${ctx.captureContentActive ? '**ACTIVE** for this bundle — assume PTY content + prompt content + file content may appear verbatim in trace `args`. Treat the entire bundle as confidential.' : 'inactive — content fields are present only as length / hash, not raw bytes.'}`)
  lines.push('')
  lines.push('## Authoritative source pointers')
  lines.push('')
  lines.push('If you have access to the Onward repository (`OPPO-PersonalAI/Onward-Agent-Workbench`), the canonical references are:')
  lines.push('- `infra/trace.md` — § 1 architecture, § 2 every implemented event name, § 4 on-disk format')
  lines.push('- `src/utils/perf-trace-names.ts` — single source of truth for event names; never renamed, only appended')
  lines.push('- `electron/main/diagnostic-bundle.ts` — this bundle\'s producer; the function `renderAgentGuide` is what generated this very document')
  lines.push('- `electron/main/trace-store.ts` — the chunked NDJSON writer (8 MB / chunk, 64 MB total cap, sync `writeSync` for SIGKILL durability)')
  lines.push('')
  lines.push('---')
  lines.push('')
  lines.push('_End of guide. Schema version: `onward.diagnostic-bundle.agent-guide.v1`._')
  lines.push('')
  return lines.join('\n')
}

/**
 * Convert an ISO-8601 UTC timestamp into a human/AI-readable local
 * timestamp with the local timezone offset, e.g.
 * `2026-05-05 15:45:23 +0800`. Used by AGENT-GUIDE.md so a downstream
 * agent can correlate the user's narrative ("I clicked at 3:45 PM")
 * with the bundle without timezone math.
 */
function formatLocalTimestampLabel(isoTs: string): string {
  const d = new Date(isoTs)
  if (Number.isNaN(d.getTime())) return isoTs
  const pad = (n: number) => n.toString().padStart(2, '0')
  const yyyy = d.getFullYear()
  const mm = pad(d.getMonth() + 1)
  const dd = pad(d.getDate())
  const hh = pad(d.getHours())
  const mi = pad(d.getMinutes())
  const ss = pad(d.getSeconds())
  // Timezone offset in `±HHMM` form. getTimezoneOffset() returns
  // positive minutes WEST of UTC, so we negate to match the
  // standard "+0800" convention (8 hours east of UTC).
  const offsetMinTotal = -d.getTimezoneOffset()
  const sign = offsetMinTotal >= 0 ? '+' : '-'
  const absMin = Math.abs(offsetMinTotal)
  const offH = pad(Math.floor(absMin / 60))
  const offM = pad(absMin % 60)
  return `${yyyy}-${mm}-${dd} ${hh}:${mi}:${ss} ${sign}${offH}${offM}`
}

// ---------- Closed-loop self-verification ----------

/**
 * Source-side hash + length captured BEFORE the bytes are handed to
 * yazl. The verifier later re-hashes the bytes it gets back from yauzl
 * and demands an exact match. This is the only acceptable contract:
 * byte-equivalence at the yazl I/O boundary, no `>0` tolerance.
 */
export interface ExpectedEntryHash {
  /** Hex SHA-256 of the source bytes. Empty string = the source went missing pre-write. */
  sha256: string
  length: number
}

export interface VerifyBundleExpectations {
  /**
   * State files (app-state.json, telemetry-events.jsonl, ...) keyed by
   * their entry name in the ZIP root. The verifier asserts byte-equal
   * extraction for each.
   */
  expectedStateFileEntries: Map<string, ExpectedEntryHash>
  /**
   * Trace chunks keyed by their `traces/perf-*.jsonl` entry name. The
   * verifier asserts byte-equal extraction AND parses each line as
   * NDJSON (V4).
   */
  expectedChunkEntries: Map<string, ExpectedEntryHash>
  /** SHA-256 + length of the in-memory README.txt string we passed to yazl. */
  expectedReadme: ExpectedEntryHash
  /** SHA-256 + length of the in-memory system-info.txt string. */
  expectedSystemInfo: ExpectedEntryHash
  /** SHA-256 + length of the in-memory AGENT-GUIDE.md string. */
  expectedAgentGuide: ExpectedEntryHash
  /**
   * SHA-256 + length of `traces/latest.txt` if the trace dir contained
   * one. Null when there was no latest.txt to bundle (e.g. the trace
   * store never initialized).
   */
  expectedLatestTxt: ExpectedEntryHash | null
  /**
   * Autotest-only: when set, V10 is enforced. Verifier scans every
   * bundled chunk for `name === AUTOTEST_BUNDLE_MARKER_NAME` whose
   * `args.uuid` and (optional) `args.label` match byte-for-byte. Pass
   * iff such an event exists. When omitted, V10 is recorded as
   * `passed: true, detail: 'skipped (no marker provided)'`.
   */
  expectedMarker?: DiagnosticBundleExpectedMarker
}

/**
 * Stable name we look for in V10. The autotest emits this exact name
 * via the dedicated debug IPC `debug:emit-bundle-marker`. Defined here
 * rather than imported from `perf-trace-names` so this module stays
 * dependency-free of the renderer-side registry — it is just a string
 * literal contract.
 */
export const AUTOTEST_BUNDLE_MARKER_NAME = 'autotest:bundle-marker'

/**
 * Read back the ZIP we just wrote and verify every declared entry
 * round-trips byte-for-byte. Exported so unit tests can fabricate
 * corrupt archives and confirm the verifier rejects them.
 *
 * Verification matrix (every check is a HARD rule; no `>0` tolerance):
 *
 *   V1  zip-opens                     yauzl parses the central directory.
 *   V2  expected-entries-present      every declared entry is in the ZIP.
 *   V4  trace-chunks-parse-as-ndjson  every line parses as JSON; ≤ 1
 *                                     partial tail line per chunk
 *                                     (SIGKILL tolerance, mirrors T02/T03).
 *   V7  chunk-bytes-equal             SHA-256 of source Buffer ===
 *                                     SHA-256 of yauzl-extracted bytes,
 *                                     for every chunk.
 *   V8  state-files-bytes-equal       SHA-256 of staged file bytes ===
 *                                     SHA-256 of yauzl-extracted bytes,
 *                                     for every state file + latest.txt.
 *   V9  generated-content-bytes-equal SHA-256 of in-memory README +
 *                                     system-info strings === SHA-256
 *                                     of yauzl-extracted bytes.
 *   V10 autotest-marker (optional)    when expectedMarker set: an event
 *                                     with name = AUTOTEST_BUNDLE_MARKER_NAME
 *                                     and args.uuid / args.label byte-equal
 *                                     to expectedMarker exists in some
 *                                     bundled chunk.
 */
export function verifyBundleArchive(
  zipPath: string,
  expected: VerifyBundleExpectations
): Promise<DiagnosticBundleVerification> {
  return new Promise<DiagnosticBundleVerification>((resolve) => {
    yauzl.open(zipPath, { lazyEntries: true }, (openErr, zipfile) => {
      if (openErr || !zipfile) {
        resolve({
          ok: false,
          checks: [{
            name: 'V1-zip-opens',
            passed: false,
            detail: `yauzl.open failed: ${openErr ? String(openErr) : 'no zipfile'}`
          }]
        })
        return
      }

      const v1: DiagnosticBundleVerificationCheck = { name: 'V1-zip-opens', passed: true }
      // We hash every entry we read so V7/V8/V9 can compare against the
      // source SHA-256s; we also keep the chunk Buffers around for V4
      // (NDJSON parse) and V10 (marker search).
      const entriesByName = new Map<string, { uncompressedSize: number; sha256: string; data: Buffer | null }>()
      let pumpError: string | null = null

      const finish = () => {
        const checks: DiagnosticBundleVerificationCheck[] = [v1]

        // ── V2: every expected entry present ─────────────────────────
        const expectedEntries = new Set<string>()
        expectedEntries.add(README_FILENAME)
        expectedEntries.add(SYSTEM_INFO_FILENAME)
        expectedEntries.add(AGENT_GUIDE_FILENAME)
        for (const name of expected.expectedStateFileEntries.keys()) expectedEntries.add(name)
        if (expected.expectedLatestTxt) expectedEntries.add('traces/latest.txt')
        for (const name of expected.expectedChunkEntries.keys()) expectedEntries.add(name)
        const missing: string[] = []
        for (const name of expectedEntries) {
          if (!entriesByName.has(name)) missing.push(name)
        }
        checks.push({
          name: 'V2-expected-entries-present',
          passed: missing.length === 0,
          detail: missing.length === 0 ? undefined : `missing: ${missing.join(', ')}`
        })

        // ── V4: trace chunks parse as NDJSON; collect marker hits for V10 ─
        let v4Pass = true
        const v4Failures: string[] = []
        let v10MarkerEvent: { uuid?: unknown; label?: unknown } | null = null
        for (const entryName of expected.expectedChunkEntries.keys()) {
          const got = entriesByName.get(entryName)
          if (!got || !got.data) {
            v4Pass = false
            v4Failures.push(`${entryName}: no data`)
            continue
          }
          const text = got.data.toString('utf8')
          const lines = text.split('\n')
          let invalidLines = 0
          let hasInvalidNonTail = false
          for (let i = 0; i < lines.length; i += 1) {
            const trimmed = lines[i].trim()
            if (!trimmed) continue
            try {
              const event = JSON.parse(trimmed) as { name?: unknown; args?: { uuid?: unknown; label?: unknown } }
              if (event?.name === AUTOTEST_BUNDLE_MARKER_NAME && event?.args && typeof event.args === 'object') {
                v10MarkerEvent = {
                  uuid: event.args.uuid,
                  label: event.args.label
                }
              }
            } catch {
              invalidLines += 1
              const isTail = lines.slice(i + 1).every((l) => l.trim() === '')
              if (!isTail) hasInvalidNonTail = true
            }
          }
          if (invalidLines > 1 || hasInvalidNonTail) {
            v4Pass = false
            v4Failures.push(`${entryName}: ${invalidLines} unparseable line(s)${hasInvalidNonTail ? ' (mid-file)' : ''}`)
          }
        }
        checks.push({
          name: 'V4-trace-chunks-parse-as-ndjson',
          passed: v4Pass,
          detail: v4Pass ? undefined : v4Failures.join('; ')
        })

        // ── V7: chunk bytes byte-equal ────────────────────────────────
        const v7Failures: string[] = []
        for (const [name, expectedHash] of expected.expectedChunkEntries) {
          const got = entriesByName.get(name)
          if (!got) {
            v7Failures.push(`${name}: not in zip`)
            continue
          }
          if (!byteEqualHash(got, expectedHash)) {
            v7Failures.push(byteEqualDiff(name, got, expectedHash))
          }
        }
        checks.push({
          name: 'V7-chunk-bytes-equal',
          passed: v7Failures.length === 0,
          detail: v7Failures.length === 0 ? undefined : v7Failures.join('; ')
        })

        // ── V8: state files + latest.txt byte-equal ──────────────────
        const v8Failures: string[] = []
        for (const [name, expectedHash] of expected.expectedStateFileEntries) {
          const got = entriesByName.get(name)
          if (!got) {
            v8Failures.push(`${name}: not in zip`)
            continue
          }
          if (!byteEqualHash(got, expectedHash)) {
            v8Failures.push(byteEqualDiff(name, got, expectedHash))
          }
        }
        if (expected.expectedLatestTxt) {
          const got = entriesByName.get('traces/latest.txt')
          if (!got) {
            v8Failures.push('traces/latest.txt: not in zip')
          } else if (!byteEqualHash(got, expected.expectedLatestTxt)) {
            v8Failures.push(byteEqualDiff('traces/latest.txt', got, expected.expectedLatestTxt))
          }
        }
        checks.push({
          name: 'V8-state-files-bytes-equal',
          passed: v8Failures.length === 0,
          detail: v8Failures.length === 0 ? undefined : v8Failures.join('; ')
        })

        // ── V9: README + system-info + AGENT-GUIDE byte-equal ────────
        const v9Failures: string[] = []
        const readmeGot = entriesByName.get(README_FILENAME)
        const sysinfoGot = entriesByName.get(SYSTEM_INFO_FILENAME)
        const agentGuideGot = entriesByName.get(AGENT_GUIDE_FILENAME)
        if (!readmeGot) {
          v9Failures.push(`${README_FILENAME}: not in zip`)
        } else if (!byteEqualHash(readmeGot, expected.expectedReadme)) {
          v9Failures.push(byteEqualDiff(README_FILENAME, readmeGot, expected.expectedReadme))
        }
        if (!sysinfoGot) {
          v9Failures.push(`${SYSTEM_INFO_FILENAME}: not in zip`)
        } else if (!byteEqualHash(sysinfoGot, expected.expectedSystemInfo)) {
          v9Failures.push(byteEqualDiff(SYSTEM_INFO_FILENAME, sysinfoGot, expected.expectedSystemInfo))
        }
        if (!agentGuideGot) {
          v9Failures.push(`${AGENT_GUIDE_FILENAME}: not in zip`)
        } else if (!byteEqualHash(agentGuideGot, expected.expectedAgentGuide)) {
          v9Failures.push(byteEqualDiff(AGENT_GUIDE_FILENAME, agentGuideGot, expected.expectedAgentGuide))
        }
        checks.push({
          name: 'V9-generated-content-bytes-equal',
          passed: v9Failures.length === 0,
          detail: v9Failures.length === 0 ? undefined : v9Failures.join('; ')
        })

        // ── V10: autotest marker (optional, gated on expectedMarker) ──
        if (!expected.expectedMarker) {
          checks.push({
            name: 'V10-autotest-marker',
            passed: true,
            detail: 'skipped (no marker provided)'
          })
        } else {
          const want = expected.expectedMarker
          if (v10MarkerEvent === null) {
            checks.push({
              name: 'V10-autotest-marker',
              passed: false,
              detail: `marker '${AUTOTEST_BUNDLE_MARKER_NAME}' not found in any bundled chunk`
            })
          } else {
            const uuidMatch = v10MarkerEvent.uuid === want.uuid
            const labelMatch = want.label === undefined
              ? v10MarkerEvent.label === undefined
              : v10MarkerEvent.label === want.label
            if (uuidMatch && labelMatch) {
              checks.push({ name: 'V10-autotest-marker', passed: true })
            } else {
              checks.push({
                name: 'V10-autotest-marker',
                passed: false,
                detail: `marker found but args mismatch: want uuid=${JSON.stringify(want.uuid)}, label=${JSON.stringify(want.label)}; got uuid=${JSON.stringify(v10MarkerEvent.uuid)}, label=${JSON.stringify(v10MarkerEvent.label)}`
              })
            }
          }
        }

        if (pumpError) {
          checks.push({
            name: 'V0-pump-error',
            passed: false,
            detail: pumpError
          })
        }

        resolve({
          ok: checks.every((c) => c.passed),
          checks
        })
      }

      zipfile.on('error', (err) => {
        pumpError = `zipfile error: ${String(err)}`
        zipfile.close()
        finish()
      })
      zipfile.on('end', () => {
        finish()
      })
      zipfile.on('entry', (entry: yauzl.Entry) => {
        const fileName = entry.fileName
        // Skip directory entries — yauzl emits them with names ending in '/'.
        if (fileName.endsWith('/')) {
          zipfile.readEntry()
          return
        }
        // We hash every entry's bytes — V7/V8/V9 need the SHA-256 to
        // compare against the source. There is no "presence-only" path
        // anymore because shallow `>0` checks were intentionally removed.
        //
        // Read each entry as RAW (still-compressed) bytes via decompress:false,
        // then one-shot inflate, instead of yauzl's STREAMING inflate. yauzl
        // 3.x's openReadStream inflate path (fd-slicer -> zlib.createInflateRaw
        // -> AssertByteCountStream) DEADLOCKS on Node >= 24 once an entry's
        // uncompressed size exceeds ~5 MB: the inflate stream never emits
        // 'end', so this Promise never resolves (the DB-04 32 MB unit test
        // hangs; the same stall truncated the bundled rg.exe at install time).
        // zlib.inflateRawSync on the collected raw bytes avoids yauzl's stream
        // plumbing entirely — it decompresses an 8 MB entry in ~14 ms on Node
        // 24 — and is byte-identical, so V4/V7/V8/V9/V10 are unchanged. Stored
        // entries (compressionMethod 0) carry verbatim bytes (no inflate).
        const stored = entry.compressionMethod === 0
        // yauzl's ZipFileOptions requires all four fields. decompress:false
        // yields the RAW deflate bytes for a compressed entry (which we then
        // inflateRawSync); a STORED entry must use null (yauzl throws on a
        // non-null decompress for an uncompressed entry, and its bytes are
        // already verbatim). decrypt/start/end stay null (no encryption, whole
        // entry).
        const streamOpts: yauzl.ZipFileOptions = {
          decompress: stored ? null : false,
          decrypt: null,
          start: null,
          end: null
        }
        zipfile.openReadStream(entry, streamOpts, (streamErr, readStream) => {
          if (streamErr || !readStream) {
            pumpError = `openReadStream(${fileName}) failed: ${String(streamErr)}`
            zipfile.readEntry()
            return
          }
          const collected: Buffer[] = []
          readStream.on('data', (b: Buffer) => {
            collected.push(b)
          })
          readStream.on('end', () => {
            const raw = Buffer.concat(collected)
            let data: Buffer
            try {
              data = stored ? raw : inflateRawSync(raw)
            } catch (err) {
              pumpError = `inflate ${fileName} failed: ${String(err)}`
              zipfile.readEntry()
              return
            }
            entriesByName.set(fileName, {
              uncompressedSize: entry.uncompressedSize,
              sha256: createHash('sha256').update(data).digest('hex'),
              data
            })
            zipfile.readEntry()
          })
          readStream.on('error', (err) => {
            pumpError = `read ${fileName} failed: ${String(err)}`
            zipfile.readEntry()
          })
        })
      })
      zipfile.readEntry()
    })
  })
}

function sha256OfBuffer(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex')
}

function byteEqualHash(
  got: { uncompressedSize: number; sha256: string },
  want: ExpectedEntryHash
): boolean {
  return got.sha256 === want.sha256 && got.uncompressedSize === want.length
}

function byteEqualDiff(
  name: string,
  got: { uncompressedSize: number; sha256: string },
  want: ExpectedEntryHash
): string {
  return `${name}: source sha=${want.sha256.slice(0, 12)}/${want.length}B vs zip sha=${got.sha256.slice(0, 12)}/${got.uncompressedSize}B`
}
