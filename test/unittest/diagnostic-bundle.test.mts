/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 *
 * Unit tests for the diagnostic-bundle module.
 *
 * Usage:
 *   node --experimental-strip-types --test test/unittest/diagnostic-bundle.test.mts
 *
 * Coverage:
 *   DB-01  happy path           full userData + 2 trace chunks → ZIP
 *                                contains README, system-info, all state
 *                                files, both chunks, latest.txt
 *   DB-02  empty traces         no traces dir → ZIP still produced;
 *                                README marks traces as empty; no error
 *   DB-03  missing optional     no feedback.json on disk → ZIP produced
 *                                without it; missingFiles surfaces it
 *   DB-04  large traces stream  64 MB of synthetic chunks → ZIP completes
 *                                within 30 s, reasonable compression,
 *                                process memory does not balloon
 *
 * Cross-platform note: unzip is used for archive inspection. macOS and
 * most Linux distros ship it; Windows users running this unit test
 * locally need to add it to PATH (Git for Windows includes it). CI runs
 * on macOS where it is preinstalled.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createDiagnosticBundle } from '../../electron/main/diagnostic-bundle.ts'

interface UserDataFixture {
  userDataDir: string
  outputPath: string
  cleanup: () => void
}

function makeFixture(opts?: {
  withTraces?: boolean
  traceChunkBytes?: number
  traceChunkCount?: number
  omitFiles?: string[]
}): UserDataFixture {
  const root = mkdtempSync(join(tmpdir(), 'onward-bundle-test-'))
  const userDataDir = join(root, 'userData')
  const outputPath = join(root, 'bundle.zip')
  mkdirSync(userDataDir, { recursive: true })

  const omit = new Set(opts?.omitFiles ?? [])
  const stateFiles: Record<string, string> = {
    'app-state.json': JSON.stringify({ activeTabId: 't1', tabs: [] }),
    'telemetry-events.jsonl': '{"timestamp":"2026-05-05T00:00:00Z","name":"session/start"}\n',
    'settings.json': '{"theme":"dark","language":"en"}',
    'window-state.json': '{"x":0,"y":0,"width":1280,"height":800}',
    'feedback.json': '{"records":[]}'
  }
  for (const [name, body] of Object.entries(stateFiles)) {
    if (omit.has(name)) continue
    writeFileSync(join(userDataDir, name), body, 'utf8')
  }

  if (opts?.withTraces ?? true) {
    const traceDir = join(userDataDir, 'traces')
    mkdirSync(traceDir, { recursive: true })
    writeFileSync(join(traceDir, 'latest.txt'), traceDir, 'utf8')
    const chunkCount = opts?.traceChunkCount ?? 2
    const chunkBytes = opts?.traceChunkBytes ?? 0
    for (let i = 0; i < chunkCount; i += 1) {
      const seq = i.toString().padStart(4, '0')
      const filename = `perf-${seq}-2026-05-05T00-00-00-${seq}Z-12345.jsonl`
      const path = join(traceDir, filename)
      // Always lead with a real `main:*` event so V5 can confirm the
      // chunks contain Onward events. Production chunks always start
      // with main:trace-start; the test fixture mirrors that.
      const headerLine = `{"ph":"i","name":"main:trace-start","ts":${i},"pid":1,"tid":1,"s":"g"}\n`
      if (chunkBytes > 0) {
        // Synthetic large chunk: ~1 KB lines so an 8 MB chunk is
        // ~8000 lines and stays in line with production chunk shape.
        const filler = 'x'.repeat(900)
        const oneLine = `{"ph":"i","name":"autotest:fill","ts":${i},"pid":1,"tid":1,"args":{"filler":"${filler}"}}\n`
        const linesPerChunk = Math.ceil(chunkBytes / oneLine.length)
        const buf = Buffer.alloc(headerLine.length + oneLine.length * linesPerChunk)
        buf.write(headerLine, 0, 'utf8')
        buf.fill(oneLine, headerLine.length, headerLine.length + oneLine.length * linesPerChunk, 'utf8')
        writeFileSync(path, buf)
      } else {
        writeFileSync(path, headerLine + `{"ph":"i","name":"chunk-${i}","ts":${i},"pid":1,"tid":1}\n`, 'utf8')
      }
    }
  }

  return {
    userDataDir,
    outputPath,
    cleanup: () => {
      try { rmSync(root, { recursive: true, force: true }) } catch { /* OS reaps */ }
    }
  }
}

function listZipEntries(zipPath: string): string[] {
  // unzip -Z1 prints one entry per line, no header. Falls through to
  // unzip -l on systems without -Z1 (rare; macOS / Linux unzip both
  // support -Z1 as of v6.0).
  let stdout: string
  try {
    stdout = execSync(`unzip -Z1 "${zipPath}"`, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  } catch (error) {
    throw new Error(`unzip -Z1 failed (is unzip installed?): ${String(error)}`)
  }
  return stdout.split('\n').map((line) => line.trim()).filter((line) => line.length > 0)
}

function readZipEntry(zipPath: string, entryName: string): string {
  return execSync(`unzip -p "${zipPath}" "${entryName}"`, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
}

const APP_INFO = {
  version: '2.0.1',
  buildChannel: 'dev',
  branch: 'master',
  productName: 'Onward 2',
  electronVersion: '39.8.5'
}

test('DB-01 happy path: full userData + 2 trace chunks → ZIP contains everything', async () => {
  const fix = makeFixture()
  try {
    const result = await createDiagnosticBundle({
      userDataDir: fix.userDataDir,
      outputPath: fix.outputPath,
      appInfo: APP_INFO,
      timestamp: '2026-05-05T12:00:00.000Z'
    })
    assert.equal(result.success, true, `createDiagnosticBundle failed: ${result.error ?? '(no error)'}`)
    assert.equal(result.path, fix.outputPath)
    assert.ok((result.bytes ?? 0) > 0, 'ZIP should have non-zero size')
    assert.equal(result.manifest?.chunkCount, 2)
    assert.equal(result.manifest?.missingFiles.length, 0)
    assert.deepEqual(result.manifest?.stateFiles.sort(), [
      'app-state.json',
      'feedback.json',
      'settings.json',
      'telemetry-events.jsonl',
      'window-state.json'
    ])

    const entries = listZipEntries(fix.outputPath)
    const expected = [
      'README.txt',
      'AGENT-GUIDE.md',
      'system-info.txt',
      'app-state.json',
      'telemetry-events.jsonl',
      'settings.json',
      'window-state.json',
      'feedback.json',
      'traces/latest.txt'
    ]
    for (const name of expected) {
      assert.ok(entries.includes(name), `expected entry ${name} missing from ZIP. Got: ${entries.join(', ')}`)
    }
    assert.equal(entries.filter((name) => name.startsWith('traces/perf-')).length, 2, 'expected 2 perf chunks')

    const readme = readZipEntry(fix.outputPath, 'README.txt')
    assert.match(readme, /Onward Diagnostic Bundle/, 'README should have header')
    assert.match(readme, /Generated\s*:\s*2026-05-05T12:00:00\.000Z/, 'README should carry the timestamp')
    assert.match(readme, /App version: 2\.0\.1/, 'README should carry version')
    assert.match(readme, /2 chunk\(s\)/, 'README should report chunk count')
    assert.match(readme, /Privacy/, 'README should call out privacy')

    // AGENT-GUIDE.md is the AI-agent-readable analysis guide. Co-located
    // with the bundling pipeline so its content reflects exactly what
    // was packaged this run. Assert the canonical sections + dynamic
    // fields (chunk count, version, build channel) round-trip.
    const agentGuide = readZipEntry(fix.outputPath, 'AGENT-GUIDE.md')
    assert.match(agentGuide, /^# Onward Diagnostic Bundle — Agent Analysis Guide/m, 'AGENT-GUIDE should start with the canonical title')
    assert.match(agentGuide, /## Bundle metadata/, 'AGENT-GUIDE missing Bundle metadata section')
    assert.match(agentGuide, /## Inventory/, 'AGENT-GUIDE missing Inventory section')
    assert.match(agentGuide, /## File schemas/, 'AGENT-GUIDE missing File schemas section')
    assert.match(agentGuide, /## Querying the trace data \(primary path: SQL via Perfetto `trace_processor`\)/, 'AGENT-GUIDE missing SQL-querying section')
    assert.match(agentGuide, /Is `traces\/\*\.jsonl` Parquet\?/, 'AGENT-GUIDE format-facts table missing Parquet question')
    assert.match(agentGuide, /SELECT name, ts, dur/, 'AGENT-GUIDE should ship canonical SQL recipes')
    assert.match(agentGuide, /pip install perfetto/, 'AGENT-GUIDE should mention perfetto python install')
    assert.match(agentGuide, /df\.to_parquet/, 'AGENT-GUIDE should document the optional Parquet export path')
    assert.match(agentGuide, /## How to perform problem analysis/, 'AGENT-GUIDE missing analysis section')
    assert.match(agentGuide, /## Privacy guardrails/, 'AGENT-GUIDE missing Privacy section')
    assert.match(agentGuide, /\*\*Generated \(UTC\)\*\*: 2026-05-05T12:00:00\.000Z/, 'AGENT-GUIDE missing UTC timestamp')
    assert.match(agentGuide, /\*\*Generated \(local\)\*\*:/, 'AGENT-GUIDE missing local timestamp label')
    assert.match(agentGuide, /\*\*App version\*\*: 2\.0\.1/, 'AGENT-GUIDE missing app version')
    assert.match(agentGuide, /\*\*Trace chunks\*\*: 2 file\(s\)/, 'AGENT-GUIDE should report 2 chunks dynamically')
    assert.match(agentGuide, /onward\.diagnostic-bundle\.agent-guide\.v1/, 'AGENT-GUIDE missing schema version footer')

    const sysinfo = readZipEntry(fix.outputPath, 'system-info.txt')
    assert.match(sysinfo, /platform=/)
    assert.match(sysinfo, /electronVersion=/)
    assert.match(sysinfo, /buildChannel=dev/)

    // Closed-loop verification: every V* check must pass and the
    // checks list must include all six (V1..V6).
    assert.equal(result.verification?.ok, true, `verification not ok: ${JSON.stringify(result.verification)}`)
    const checkNames = result.verification?.checks.map((c) => c.name) ?? []
    for (const expectedCheck of [
      'V1-zip-opens',
      'V2-expected-entries-present',
      'V4-trace-chunks-parse-as-ndjson',
      'V7-chunk-bytes-equal',
      'V8-state-files-bytes-equal',
      'V9-generated-content-bytes-equal',
      'V10-autotest-marker'
    ]) {
      assert.ok(checkNames.includes(expectedCheck), `verification missing check: ${expectedCheck}`)
    }
    for (const c of result.verification?.checks ?? []) {
      assert.equal(c.passed, true, `verification check ${c.name} failed: ${c.detail ?? ''}`)
    }
    // Without expectedMarker, V10 is skipped (passed:true with skip detail).
    const v10 = result.verification?.checks.find((c) => c.name === 'V10-autotest-marker')
    assert.equal(v10?.passed, true)
    assert.match(v10?.detail ?? '', /skipped/)

    // Round-trip parse a chunk via shell-out to confirm it is valid
    // NDJSON the way open_trace.sh expects. Independent of the V4 check
    // baked into createDiagnosticBundle's verifier — this proves a
    // separate consumer reaches the same conclusion.
    const firstChunk = entries.find((name) => name.startsWith('traces/perf-'))
    assert.ok(firstChunk, 'expected at least one perf-*.jsonl chunk')
    const chunkText = readZipEntry(fix.outputPath, firstChunk!)
    const lines = chunkText.split('\n').map((l) => l.trim()).filter(Boolean)
    assert.ok(lines.length >= 1, 'chunk should have at least one line')
    for (const line of lines) {
      JSON.parse(line)
    }
  } finally {
    fix.cleanup()
  }
})

test('DB-02 empty traces: no traces dir → ZIP produced, README marks empty', async () => {
  const fix = makeFixture({ withTraces: false })
  try {
    const result = await createDiagnosticBundle({
      userDataDir: fix.userDataDir,
      outputPath: fix.outputPath,
      appInfo: APP_INFO,
      timestamp: '2026-05-05T12:00:00.000Z'
    })
    assert.equal(result.success, true, `createDiagnosticBundle failed: ${result.error ?? '(no error)'}`)
    assert.equal(result.manifest?.chunkCount, 0)
    assert.equal(result.manifest?.chunkBytes, 0)

    const entries = listZipEntries(fix.outputPath)
    assert.ok(entries.includes('app-state.json'), 'state files should still be bundled')
    assert.equal(entries.filter((name) => name.startsWith('traces/')).length, 0, 'no traces/ entries when source dir absent')

    const readme = readZipEntry(fix.outputPath, 'README.txt')
    assert.match(readme, /no chunks captured this session/, 'README should explicitly mark empty traces')

    // No chunks → V7 has empty input, passes trivially. State files +
    // README + system-info all still byte-equal-checked.
    assert.equal(result.verification?.ok, true)
    const v7 = result.verification?.checks.find((c) => c.name === 'V7-chunk-bytes-equal')
    assert.equal(v7?.passed, true, `V7 failed: ${v7?.detail ?? ''}`)
    const v8 = result.verification?.checks.find((c) => c.name === 'V8-state-files-bytes-equal')
    assert.equal(v8?.passed, true, `V8 failed: ${v8?.detail ?? ''}`)
    const v9 = result.verification?.checks.find((c) => c.name === 'V9-generated-content-bytes-equal')
    assert.equal(v9?.passed, true, `V9 failed: ${v9?.detail ?? ''}`)
  } finally {
    fix.cleanup()
  }
})

test('DB-03 missing optional file: no feedback.json → bundle still succeeds', async () => {
  const fix = makeFixture({ omitFiles: ['feedback.json'] })
  try {
    const result = await createDiagnosticBundle({
      userDataDir: fix.userDataDir,
      outputPath: fix.outputPath,
      appInfo: APP_INFO
    })
    assert.equal(result.success, true, `createDiagnosticBundle failed: ${result.error ?? '(no error)'}`)
    assert.deepEqual(result.manifest?.missingFiles, ['feedback.json'])

    const entries = listZipEntries(fix.outputPath)
    assert.ok(!entries.includes('feedback.json'), 'feedback.json should be absent from ZIP')
    assert.ok(entries.includes('app-state.json'), 'other state files should still be bundled')

    const readme = readZipEntry(fix.outputPath, 'README.txt')
    assert.match(readme, /Missing files: feedback\.json/, 'README should list missing files')

    // V2 should NOT fail here — feedback.json was never staged, so it
    // is not in expectedStateFiles. Verifying the verifier respects
    // that distinction.
    assert.equal(result.verification?.ok, true)
  } finally {
    fix.cleanup()
  }
})

test('DB-04 large traces (32 MB): streaming completes without OOM, output reasonable', async () => {
  // 4 chunks × 8 MB = 32 MB. Smaller than the 64 MB production cap to
  // keep the unit test fast (CI budget) while still proving the streaming
  // path under realistic chunk sizes. Production rotation is exercised
  // separately by the T03 autotest.
  const chunkBytes = 8 * 1024 * 1024
  const chunkCount = 4
  const fix = makeFixture({ withTraces: true, traceChunkBytes: chunkBytes, traceChunkCount: chunkCount })
  try {
    const memBefore = process.memoryUsage().heapUsed
    const startedAt = Date.now()
    const result = await createDiagnosticBundle({
      userDataDir: fix.userDataDir,
      outputPath: fix.outputPath,
      appInfo: APP_INFO
    })
    const elapsedMs = Date.now() - startedAt
    const memAfter = process.memoryUsage().heapUsed
    const memDeltaMb = (memAfter - memBefore) / (1024 * 1024)

    assert.equal(result.success, true, `createDiagnosticBundle failed: ${result.error ?? '(no error)'}`)
    assert.equal(result.manifest?.chunkCount, chunkCount)
    assert.ok(elapsedMs < 30_000, `bundle took ${elapsedMs} ms (>30s); streaming may have stalled`)

    // The synthetic filler is highly compressible (single character
    // repeated). Expect ZIP < 5 MB. If compression broke or we accidentally
    // copied the buffer into memory, this would balloon.
    const sizeMb = statSync(fix.outputPath).size / (1024 * 1024)
    assert.ok(sizeMb < 5, `bundle is ${sizeMb.toFixed(2)} MB (>5 MB); compression may be off`)

    // Memory should not balloon by more than ~64 MB even though the
    // total source is 32 MB — anything above this is a streaming
    // regression. We allow generous headroom for V8's allocator
    // bookkeeping so this does not flake.
    assert.ok(memDeltaMb < 64, `heap grew by ${memDeltaMb.toFixed(1)} MB; streaming may have buffered everything`)
  } finally {
    fix.cleanup()
  }
})

// ---------------------------------------------------------------------
// DB-05 — race regression: live trace writes during bundle creation.
//
// This is the regression test for the user-reported yazl crash:
//   "file data stream has unexpected number of bytes"
// triggered because the trace store kept writeSync-ing into a chunk
// while yazl was in the addFile→stream gap. The fix uses
// readFileSync + addBuffer for chunks, so size is captured atomically
// and yazl can no longer race the live writer.
// ---------------------------------------------------------------------
test('DB-05 race regression: live writes to trace chunk during bundle creation', async () => {
  const { openSync, writeSync, closeSync } = await import('node:fs')
  const fix = makeFixture()
  // Open the FIRST chunk for appending and keep the fd alive across
  // the entire createDiagnosticBundle call. The bundle reads the chunk
  // via readFileSync (synchronous, atomic) but yazl's stream-out path
  // could still be racing if we had not switched to addBuffer.
  const traceDir = join(fix.userDataDir, 'traces')
  const chunkFiles = (await import('node:fs')).readdirSync(traceDir).filter((f: string) => f.endsWith('.jsonl')).sort()
  assert.ok(chunkFiles.length >= 1, 'fixture should have at least one chunk')
  const chunkPath = join(traceDir, chunkFiles[0])
  const fd = openSync(chunkPath, 'a')
  try {
    // Fire writes on each microtask while createDiagnosticBundle runs.
    // Without the addBuffer fix this triggers the yazl byte-count
    // mismatch reliably.
    let injectedBytes = 0
    let stop = false
    const pump = () => {
      if (stop) return
      const line = `{"ph":"i","name":"main:race-injection","ts":${Date.now()},"pid":1,"tid":1}\n`
      try {
        writeSync(fd, line)
        injectedBytes += line.length
      } catch {
        // fd may be closed by the time pump tail executes; safe to drop.
      }
      setImmediate(pump)
    }
    pump()

    const result = await createDiagnosticBundle({
      userDataDir: fix.userDataDir,
      outputPath: fix.outputPath,
      appInfo: APP_INFO
    })
    stop = true
    assert.equal(
      result.success,
      true,
      `createDiagnosticBundle failed under live-write race: ${result.error ?? ''}`
    )
    assert.equal(result.verification?.ok, true)
    assert.ok(injectedBytes > 0, 'sanity: race fixture should have written something')
    // The bundled chunk should have the bytes captured at readFileSync
    // time (≤ post-injection size). V6 has already verified the
    // round-trip; here we just sanity-check that the bundled chunk's
    // bytes ≤ live-on-disk bytes after the bundle finished.
    const chunkOnDisk = (await import('node:fs')).statSync(chunkPath).size
    assert.ok(
      (result.manifest?.chunkBytes ?? 0) <= chunkOnDisk,
      `bundled chunkBytes=${result.manifest?.chunkBytes} > on-disk size=${chunkOnDisk} after race`
    )
  } finally {
    try { closeSync(fd) } catch { /* ignore */ }
    fix.cleanup()
  }
})

// ---------------------------------------------------------------------
// DB-06 — verifier catches an in-chunk NDJSON corruption.
//
// Plant a chunk on disk that has a valid header line + a non-JSON
// middle line + a valid tail. createDiagnosticBundle bundles it; V4
// must reject (mid-file invalid line, not a tolerated tail).
// ---------------------------------------------------------------------
test('DB-06 verifier: rejects archive with mid-file invalid JSON line', async () => {
  const fix = makeFixture()
  try {
    const traceDir = join(fix.userDataDir, 'traces')
    const corruptChunkPath = join(traceDir, 'perf-9999-2026-05-05T00-00-00-9999Z-12345.jsonl')
    const validHeader = '{"ph":"i","name":"main:trace-start","ts":0,"pid":1,"tid":1}\n'
    const corruptBody = 'XXX-not-json\n'
    const validTail = '{"ph":"i","name":"main:event-loop-stall","ts":1,"pid":1,"tid":1,"dur":50000}\n'
    ;(await import('node:fs')).writeFileSync(corruptChunkPath, validHeader + corruptBody + validTail)

    const corrupt = await createDiagnosticBundle({
      userDataDir: fix.userDataDir,
      outputPath: fix.outputPath,
      appInfo: APP_INFO
    })
    assert.equal(corrupt.success, false, `expected verification fail; got success=true (manifest: ${JSON.stringify(corrupt.manifest)})`)
    assert.match(corrupt.error ?? '', /verification-failed/)
    const v4 = corrupt.verification?.checks.find((c) => c.name === 'V4-trace-chunks-parse-as-ndjson')
    assert.equal(v4?.passed, false, 'V4 should flag the mid-file invalid line')
    assert.match(v4?.detail ?? '', /perf-9999/)
    // The byte-equivalence check (V7) should still PASS — the bytes
    // round-tripped through yazl/yauzl unchanged. V4 is the only
    // failing check; this confirms the corruption signal is correctly
    // attributed to "trace store wrote bad NDJSON" not "yazl mangled
    // the bytes".
    const v7 = corrupt.verification?.checks.find((c) => c.name === 'V7-chunk-bytes-equal')
    assert.equal(v7?.passed, true, `V7 should still pass (bytes faithful through yazl); detail: ${v7?.detail ?? ''}`)
  } finally {
    fix.cleanup()
  }
})

// ---------------------------------------------------------------------
// DB-07 — verifier catches a missing declared entry.
//
// Build a normal bundle, then call verifyBundleArchive directly with
// a fictitious extra state-file expectation. V2 must flag the gap.
// ---------------------------------------------------------------------
test('DB-07 verifier: rejects archive missing a declared entry', async () => {
  const { verifyBundleArchive, createDiagnosticBundle: createBundle } = await import(
    '../../electron/main/diagnostic-bundle.ts'
  )
  const fix = makeFixture()
  try {
    const result = await createBundle({
      userDataDir: fix.userDataDir,
      outputPath: fix.outputPath,
      appInfo: APP_INFO
    })
    assert.equal(result.success, true)

    // Inject a fictitious extra state file into expectedStateFileEntries
    // (with a known SHA-256 length combo) and confirm V2 flags it as
    // missing from the actual ZIP.
    const expectedStateFileEntries = new Map<string, { sha256: string; length: number }>()
    for (const name of result.manifest?.stateFiles ?? []) {
      // We don't know the original source SHA from outside; the verifier
      // will fail V8 for these too, but we only assert V2 here.
      expectedStateFileEntries.set(name, { sha256: 'unknown', length: 0 })
    }
    expectedStateFileEntries.set('this-file-was-not-bundled.json', { sha256: 'fake', length: 1 })

    const verification = await verifyBundleArchive(fix.outputPath, {
      expectedStateFileEntries,
      expectedChunkEntries: new Map(),
      expectedReadme: { sha256: 'unknown', length: 0 },
      expectedSystemInfo: { sha256: 'unknown', length: 0 },
      expectedAgentGuide: { sha256: 'unknown', length: 0 },
      expectedLatestTxt: null
    })
    assert.equal(verification.ok, false)
    const v2 = verification.checks.find((c) => c.name === 'V2-expected-entries-present')
    assert.equal(v2?.passed, false)
    assert.match(v2?.detail ?? '', /this-file-was-not-bundled\.json/)
  } finally {
    fix.cleanup()
  }
})

// ---------------------------------------------------------------------
// DB-08 — verifier rejects mismatched expected SHA-256.
//
// Build a real bundle. Then call verifyBundleArchive with ALTERED
// expected SHA-256s (one bit flipped) for a chunk, a state file, and
// the README. V7/V8/V9 must each report a byte-level mismatch with a
// helpful diff string. This proves byte-equivalence is enforced as a
// hard rule, not a `>0` sanity.
//
// Direct probe of the verifier — independent of the bundle creator's
// hashing path, so a regression in either side fails its own check.
// ---------------------------------------------------------------------
test('DB-08 verifier: byte-equivalence checks reject any SHA-256 mismatch', async () => {
  const { verifyBundleArchive } = await import('../../electron/main/diagnostic-bundle.ts')
  const fs = await import('node:fs')
  const { createHash } = await import('node:crypto')

  const sha256OfBuf = (b: Buffer) => createHash('sha256').update(b).digest('hex')
  // Flip the last hex char so the hash is guaranteed to differ from the
  // real one (no ambiguity, no "≠ but happens to collide" worry).
  const corruptHex = (h: string) => h.slice(0, -1) + (h.endsWith('0') ? '1' : '0')

  const fix = makeFixture()
  try {
    const result = await createDiagnosticBundle({
      userDataDir: fix.userDataDir,
      outputPath: fix.outputPath,
      appInfo: APP_INFO,
      timestamp: '2026-05-05T12:00:00.000Z'
    })
    assert.equal(result.success, true, 'baseline bundle should succeed')

    // Compute REAL source hashes from disk (mirroring what the bundle
    // creator did). Then build a "corrupted-expectations" object where
    // ONE chunk's hash, ONE state file's hash, and the README's hash
    // are deliberately wrong.
    const traceDir = join(fix.userDataDir, 'traces')
    const chunkFiles = fs.readdirSync(traceDir).filter((f: string) => f.endsWith('.jsonl')).sort()
    const expectedChunkEntries = new Map<string, { sha256: string; length: number }>()
    let firstChunkName = ''
    for (const f of chunkFiles) {
      const buf = fs.readFileSync(join(traceDir, f))
      const entry = `traces/${f}`
      const real = sha256OfBuf(buf)
      if (firstChunkName === '') {
        firstChunkName = entry
        // Corrupt the first chunk's expected hash.
        expectedChunkEntries.set(entry, { sha256: corruptHex(real), length: buf.length })
      } else {
        expectedChunkEntries.set(entry, { sha256: real, length: buf.length })
      }
    }
    assert.notEqual(firstChunkName, '', 'fixture must have at least one chunk')

    const stateFileNames = ['app-state.json', 'telemetry-events.jsonl', 'settings.json', 'window-state.json', 'feedback.json']
    const expectedStateFileEntries = new Map<string, { sha256: string; length: number }>()
    let firstStateFileName = ''
    for (const name of stateFileNames) {
      const path = join(fix.userDataDir, name)
      if (!fs.existsSync(path)) continue
      const buf = fs.readFileSync(path)
      const real = sha256OfBuf(buf)
      if (firstStateFileName === '') {
        firstStateFileName = name
        expectedStateFileEntries.set(name, { sha256: corruptHex(real), length: buf.length })
      } else {
        expectedStateFileEntries.set(name, { sha256: real, length: buf.length })
      }
    }
    assert.notEqual(firstStateFileName, '', 'fixture must have at least one state file')

    const latestTxtBuf = fs.readFileSync(join(traceDir, 'latest.txt'))
    const expectedLatestTxt = {
      sha256: sha256OfBuf(latestTxtBuf),
      length: latestTxtBuf.length
    }

    const readmeBytes = Buffer.from(readZipEntry(fix.outputPath, 'README.txt'), 'utf8')
    const sysinfoBytes = Buffer.from(readZipEntry(fix.outputPath, 'system-info.txt'), 'utf8')
    const agentGuideBytes = Buffer.from(readZipEntry(fix.outputPath, 'AGENT-GUIDE.md'), 'utf8')
    // Corrupt README's expected hash; leave system-info's and
    // agent-guide's correct so V9 isolates the README mismatch.
    const expectedReadme = { sha256: corruptHex(sha256OfBuf(readmeBytes)), length: readmeBytes.length }
    const expectedSystemInfo = { sha256: sha256OfBuf(sysinfoBytes), length: sysinfoBytes.length }
    const expectedAgentGuide = { sha256: sha256OfBuf(agentGuideBytes), length: agentGuideBytes.length }

    const verification = await verifyBundleArchive(fix.outputPath, {
      expectedStateFileEntries,
      expectedChunkEntries,
      expectedReadme,
      expectedSystemInfo,
      expectedAgentGuide,
      expectedLatestTxt
    })
    assert.equal(verification.ok, false, 'verifier should reject when expected hashes do not match actuals')

    const v7 = verification.checks.find((c) => c.name === 'V7-chunk-bytes-equal')
    assert.equal(v7?.passed, false, 'V7 must catch the corrupted chunk hash')
    assert.match(v7?.detail ?? '', new RegExp(firstChunkName.replace(/[/.]/g, '\\$&')), 'V7 detail should name the failing chunk')

    const v8 = verification.checks.find((c) => c.name === 'V8-state-files-bytes-equal')
    assert.equal(v8?.passed, false, 'V8 must catch the corrupted state-file hash')
    assert.match(v8?.detail ?? '', new RegExp(firstStateFileName.replace(/\./g, '\\.')), 'V8 detail should name the failing state file')

    const v9 = verification.checks.find((c) => c.name === 'V9-generated-content-bytes-equal')
    assert.equal(v9?.passed, false, 'V9 must catch the corrupted README hash')
    assert.match(v9?.detail ?? '', /README\.txt/, 'V9 detail should mention README.txt')
  } finally {
    fix.cleanup()
  }
})

// ---------------------------------------------------------------------
// DB-09 — V10 fails when expectedMarker is set but no marker is in
// the bundled chunks. This is the "operation-not-performed" negative.
// ---------------------------------------------------------------------
test('DB-09 V10: missing autotest marker fails verification', async () => {
  const fix = makeFixture()
  try {
    const result = await createDiagnosticBundle({
      userDataDir: fix.userDataDir,
      outputPath: fix.outputPath,
      appInfo: APP_INFO,
      expectedMarker: { uuid: 'test-uuid-no-emit', label: 'never-emitted' }
    })
    assert.equal(result.success, false, 'V10 should fail when marker absent')
    const v10 = result.verification?.checks.find((c) => c.name === 'V10-autotest-marker')
    assert.equal(v10?.passed, false)
    assert.match(v10?.detail ?? '', /not found in any bundled chunk/)
  } finally {
    fix.cleanup()
  }
})

// ---------------------------------------------------------------------
// DB-10 — V10 passes when the marker IS in a chunk and expectedMarker
// matches its args byte-equally. This is the "operation-performed"
// positive: simulate the autotest flow by writing a marker line into
// a chunk fixture, then bundle, then assert V10 passes.
// ---------------------------------------------------------------------
test('DB-10 V10: autotest marker present + args match → pass', async () => {
  const fs = await import('node:fs')
  const fix = makeFixture()
  try {
    // Stamp the marker into the first chunk before bundling. The
    // marker shape mirrors what
    // `performanceTrace.record('autotest:bundle-marker', {uuid, label})`
    // would produce on disk.
    const uuid = 'test-uuid-9c3b4a8e'
    const label = 'DB-10-fixture'
    const traceDir = join(fix.userDataDir, 'traces')
    const chunkFile = fs.readdirSync(traceDir).filter((f: string) => f.endsWith('.jsonl')).sort()[0]
    const markerLine = JSON.stringify({
      ph: 'i',
      name: 'autotest:bundle-marker',
      ts: 1700000000000000,
      pid: 1,
      tid: 1,
      args: { uuid, label }
    }) + '\n'
    fs.appendFileSync(join(traceDir, chunkFile), markerLine)

    const result = await createDiagnosticBundle({
      userDataDir: fix.userDataDir,
      outputPath: fix.outputPath,
      appInfo: APP_INFO,
      expectedMarker: { uuid, label }
    })
    assert.equal(result.success, true, `expected V10 pass; got error=${result.error ?? ''}, checks=${JSON.stringify(result.verification?.checks)}`)
    const v10 = result.verification?.checks.find((c) => c.name === 'V10-autotest-marker')
    assert.equal(v10?.passed, true)
    assert.equal(v10?.detail, undefined)
  } finally {
    fix.cleanup()
  }
})

// ─────────── DB-11/DB-12: threadpool-immune sync-directory fallback ───────────
// (2026-07-20 incident: the yazl/zlib zip path rides the libuv threadpool and
// deadlocked forever while the pool was stalled — "generate log" hung during
// the exact failure it existed to capture. 'sync-directory' delivers the same
// content with only synchronous fs.)

test('DB-11 sync-directory mode: bundle delivered as a plain directory with full content', async () => {
  const fs = await import('node:fs')
  const fix = makeFixture()
  try {
    const result = await createDiagnosticBundle({
      userDataDir: fix.userDataDir,
      outputPath: fix.outputPath,
      appInfo: APP_INFO,
      timestamp: '2026-07-20T03:00:00.000Z',
      archiveMode: 'sync-directory'
    })
    assert.equal(result.success, true, `sync fallback failed: ${result.error ?? '(no error)'}`)
    assert.equal(result.archiveMode, 'sync-directory')
    assert.ok(result.path, 'fallback path missing')
    assert.notEqual(result.path, fix.outputPath, 'fallback must not claim the .zip path')
    assert.ok(fs.statSync(result.path!).isDirectory(), 'fallback path must be a directory')
    assert.ok((result.bytes ?? 0) > 0, 'fallback should report non-zero bytes')

    for (const entry of [
      'README.txt',
      'AGENT-GUIDE.md',
      'system-info.txt',
      'app-state.json',
      'telemetry-events.jsonl',
      'settings.json',
      'window-state.json',
      'feedback.json',
      'traces/latest.txt'
    ]) {
      assert.ok(
        fs.existsSync(join(result.path!, entry)),
        `expected fallback entry ${entry} missing`
      )
    }
    const chunks = fs.readdirSync(join(result.path!, 'traces')).filter((f: string) => f.startsWith('perf-'))
    assert.equal(chunks.length, 2, 'expected 2 perf chunks in fallback directory')
    // Every per-entry sync verification check must have passed.
    assert.equal(result.verification?.ok, true)
    assert.ok((result.verification?.checks.length ?? 0) > 0)
    fs.rmSync(result.path!, { recursive: true, force: true })
  } finally {
    fix.cleanup()
  }
})

test('DB-12 sync-directory README content matches the zip-mode README byte-for-byte', async () => {
  const fs = await import('node:fs')
  const fix = makeFixture()
  try {
    const ts = '2026-07-20T03:00:00.000Z'
    const zipResult = await createDiagnosticBundle({
      userDataDir: fix.userDataDir,
      outputPath: fix.outputPath,
      appInfo: APP_INFO,
      timestamp: ts
    })
    assert.equal(zipResult.success, true)
    const zipReadme = readZipEntry(fix.outputPath, 'README.txt')

    const dirResult = await createDiagnosticBundle({
      userDataDir: fix.userDataDir,
      outputPath: join(fix.userDataDir, 'again.zip'),
      appInfo: APP_INFO,
      timestamp: ts,
      archiveMode: 'sync-directory'
    })
    assert.equal(dirResult.success, true)
    const dirReadme = fs.readFileSync(join(dirResult.path!, 'README.txt'), 'utf-8')
    assert.equal(dirReadme, zipReadme, 'fallback README must be identical to zip-mode README')
    fs.rmSync(dirResult.path!, { recursive: true, force: true })
  } finally {
    fix.cleanup()
  }
})
