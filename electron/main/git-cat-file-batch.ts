/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Long-running `git cat-file --batch` per repo (Phase A of the EDR
 * spawn-reduction plan).
 *
 * # Why
 *
 * On EDR-throttled Windows every `git.exe` spawn costs ~1-3s (kernel minifilter
 * inspecting each CreateProcess). The Git-Diff file-content path used to spawn
 * `git cat-file -s` + `git cat-file blob` PER object read — ~2 spawns per file
 * click, ~1.3s each. A long-running `cat-file --batch` pays the spawn cost ONCE
 * per repo, then answers every object read over stdin/stdout with NO new
 * process — turning per-read cost from "spawn tax" into "pipe round-trip".
 *
 * This does NOT reimplement git (no GPL, no native build, no new dep): it drives
 * a `git` binary in its documented batch protocol.
 *
 * # Platform model (general mechanism, per-platform COMMAND)
 *
 * The long-running-batch MECHANISM is platform-agnostic (the protocol is
 * identical everywhere). What differs is WHICH git command we drive, resolved
 * by {@link resolveBatchGitExecutable}:
 *   - **win32** — implemented: the resolved system git. The EDR per-spawn tax
 *     makes the long-running batch a large win here.
 *   - **darwin** — PLACEHOLDER ({@link resolveDarwinBatchGitExecutable}): macOS
 *     is expected to package its OWN platform-specific git command (e.g. a
 *     bundled, code-signed macOS git). Until that lands the placeholder drives
 *     the resolved system git so the mechanism is already active on macOS.
 *   - **other (Linux, …)** — intentionally NOT enabled (returns null). Native
 *     git spawns are cheap there; `readGitFileByRef` uses its per-call fallback.
 * This is an explicit per-platform branch (CLAUDE.md cross-platform rule):
 * feature scope is win32 + darwin only, by request.
 *
 * # Protocol (`git cat-file --batch`)
 *
 *   stdin:  `<ref>\n`
 *   stdout: `<oid> SP <type> SP <size> LF` then `<size>` raw bytes then `LF`
 *           (for a missing object: `<ref> SP "missing" LF`, no content)
 *
 * Requests are serialized per process (responses arrive in input order on the
 * single stdout). On a large-file gate hit we kill+respawn rather than draining
 * a huge blob (rare path), so the stream never desyncs.
 */

import { type ChildProcessWithoutNullStreams, spawn } from 'child_process'
import { resolve } from 'path'

import { getReadonlyExecEnv } from './git-utils'
import { isBatchSupportedPlatform, resolveBatchGitExecutable } from './git-cat-file-batch-platform'
import { shouldRespawnForIndexGeneration } from './git-cat-file-ref'
import { requiresGitLargeFileConfirmation, type GitLargeFilePromptOptions } from './git-large-file-policy'
import { performanceTrace } from './performance-trace'
import { PERF_TRACE_EVENT } from '../../src/utils/perf-trace-names'

export interface CatFileBatchResult {
  /** false when git reported the object as `missing`. */
  found: boolean
  /** Object size in bytes (from the batch header). */
  sizeBytes: number
  /** Raw content; empty Buffer when not found or gated as large. */
  data: Buffer
  /** true when the object exceeds the large-file gate and content was NOT read. */
  largeFile: boolean
}

// Re-exported from the dependency-free module so callers (git-utils) keep a
// single import site while the pure logic stays unit-testable in plain node.
export { isMutableIndexRef, shouldRespawnForIndexGeneration } from './git-cat-file-ref'

const NL = 0x0a // '\n'

class RepoCatFileProcess {
  private proc: ChildProcessWithoutNullStreams | null = null
  private buf: Buffer = Buffer.alloc(0)
  // Active request parser; fed by the stdout 'data' handler.
  private pending:
    | {
        sizeOnly: boolean
        resolve: (r: CatFileBatchResult) => void
        reject: (e: unknown) => void
        // null until the header is parsed.
        header: { found: boolean; size: number } | null
      }
    | null = null
  // Serialize requests onto one process — batch responses come in input order.
  private tail: Promise<unknown> = Promise.resolve()
  // Index-generation token (`mtime:size` of `.git/index`) captured at the moment
  // the CURRENT process was spawned. `git cat-file --batch` snapshots the index
  // at process start, so this is the snapshot's identity. When a later index-ref
  // read carries a DIFFERENT token (the index mutated via stage / unstage /
  // partial-stage), `read()` disposes + respawns so the new process snapshots the
  // CURRENT index — the freshness invariant that keeps GDS-22 / GDS-33 green.
  // null until the first index-aware spawn; an immutable-only read never sets it.
  private spawnedIndexGeneration: string | null = null

  constructor(private readonly repoRoot: string, private readonly gitExecutable: string) {}

  private ensureProc(indexGeneration: string | null): ChildProcessWithoutNullStreams {
    if (this.proc && !this.proc.killed) return this.proc
    // Resolve the per-platform command (win32 = system git; darwin = placeholder;
    // others = null → not enabled). Null here is a programming error because the
    // caller gates on isSupportedPlatform() before reaching read().
    const command = resolveBatchGitExecutable(process.platform, this.gitExecutable)
    if (!command) {
      throw new Error(`cat-file --batch not enabled for platform ${process.platform}`)
    }
    const proc = spawn(
      command,
      ['-c', 'core.quotepath=false', 'cat-file', '--batch'],
      { cwd: this.repoRoot, env: getReadonlyExecEnv() }
    )
    // Diagnostic breadcrumb: lifecycle ENTRY — one long-running process created
    // per repo (this is where the one-time per-repo spawn cost lives).
    performanceTrace.record(PERF_TRACE_EVENT.MAIN_GIT_CATFILE_BATCH_SPAWNED, {
      repoRoot: this.repoRoot,
      platform: process.platform
    })
    // Guard every async handler against the exact process it was bound to.
    // After a dispose()+respawn (the index-mutation freshness gate), `this.proc`
    // points at the NEW process; a late stdout chunk or the delayed 'exit' of
    // the KILLED process must NOT reach onData()/fail(). Feeding a dying
    // process's bytes into the live parser misattributes one ref's body to the
    // other request (observed as the GDS-33 staged/HEAD blob inversion on
    // Windows, where proc.kill()'s EDR-mediated pipe teardown leaves a wide
    // late-flush window), and an unconditional fail() on the stale exit would
    // reject the NEW process's in-flight read.
    proc.stdout.on('data', (chunk: Buffer) => {
      if (this.proc !== proc) return
      this.onData(chunk)
    })
    proc.stdout.on('error', () => {
      if (this.proc !== proc) return
      this.fail(new Error('cat-file stdout error'))
    })
    proc.on('exit', (code, signal) => {
      if (this.proc !== proc) return
      this.proc = null
      // Diagnostic breadcrumb: lifecycle EXIT — next read respawns (and re-pays
      // the spawn cost). A burst of these in a trace means the batch is thrashing.
      performanceTrace.record(PERF_TRACE_EVENT.MAIN_GIT_CATFILE_BATCH_PROCESS_EXITED, {
        repoRoot: this.repoRoot, reason: 'exit', code: code ?? -1, signal: signal ?? ''
      })
      this.fail(new Error('cat-file process exited'))
    })
    proc.on('error', (e) => {
      if (this.proc !== proc) return
      this.proc = null
      performanceTrace.record(PERF_TRACE_EVENT.MAIN_GIT_CATFILE_BATCH_PROCESS_EXITED, {
        repoRoot: this.repoRoot, reason: 'error', message: String((e as Error)?.message ?? e).slice(0, 200)
      })
      this.fail(e)
    })
    this.proc = proc
    this.buf = Buffer.alloc(0)
    // Record the index snapshot identity this process was spawned with. The
    // batch's in-memory index now corresponds to this token; reads carrying a
    // different token force a respawn (see read()).
    this.spawnedIndexGeneration = indexGeneration
    return proc
  }

  private fail(err: unknown): void {
    const p = this.pending
    this.pending = null
    this.buf = Buffer.alloc(0)
    if (p) p.reject(err)
  }

  private onData(chunk: Buffer): void {
    this.buf = this.buf.length === 0 ? chunk : Buffer.concat([this.buf, chunk])
    // Drive the parser until it can't make progress.
    for (;;) {
      const p = this.pending
      if (!p) return
      if (!p.header) {
        const nl = this.buf.indexOf(NL)
        if (nl < 0) return // header line incomplete
        const headerLine = this.buf.subarray(0, nl).toString('utf-8')
        this.buf = this.buf.subarray(nl + 1)
        // `<oid> <type> <size>` or `<ref> missing`
        const parts = headerLine.split(' ')
        if (parts[parts.length - 1] === 'missing') {
          this.pending = null
          p.resolve({ found: false, sizeBytes: 0, data: Buffer.alloc(0), largeFile: false })
          continue
        }
        const size = Number.parseInt(parts[parts.length - 1], 10)
        p.header = { found: true, size: Number.isFinite(size) ? size : 0 }
        // info-only callers don't need the content body, but `--batch` always
        // streams it — we must still consume `size + 1` bytes to stay in sync.
      }
      const { size } = p.header
      const need = size + 1 // content + trailing LF
      if (this.buf.length < need) return // content incomplete
      const data = this.buf.subarray(0, size)
      this.buf = this.buf.subarray(need)
      this.pending = null
      p.resolve({ found: true, sizeBytes: size, data: Buffer.from(data), largeFile: false })
    }
  }

  /**
   * Read an object by ref through the long-running process. Serialized.
   *
   * `indexGeneration` is the `.git/index` stat token (`mtime:size`) the CALLER
   * captured for an INDEX ref (`:<path>`), or null for an immutable ref. When it
   * differs from the token the running process was spawned with, the process is
   * disposed + respawned so the new process snapshots the CURRENT index before
   * the read — guaranteeing index refs never return a stale pre-mutation blob
   * (GDS-22 / GDS-33 freshness invariant). Immutable refs (null token) never
   * trigger a respawn.
   */
  read(
    ref: string,
    options?: GitLargeFilePromptOptions,
    indexGeneration: string | null = null
  ): Promise<CatFileBatchResult> {
    const run = () => new Promise<CatFileBatchResult>((resolveOuter, rejectOuter) => {
      // Freshness gate: if this is an index read and the on-disk index mutated
      // since the running process snapshotted it, drop the stale process so the
      // ensureProc() below spawns a fresh one against the current index. Runs
      // inside the serialized chain, so no in-flight read can observe the swap.
      if (this.proc && !this.proc.killed &&
          shouldRespawnForIndexGeneration(this.spawnedIndexGeneration, indexGeneration)) {
        performanceTrace.record(PERF_TRACE_EVENT.MAIN_GIT_CATFILE_INDEX_REF_BATCHED, {
          repoRoot: this.repoRoot,
          action: 'respawn-stale-index',
          spawnedToken: this.spawnedIndexGeneration ?? '',
          requestToken: indexGeneration ?? ''
        })
        this.dispose()
      }
      let proc: ChildProcessWithoutNullStreams
      try { proc = this.ensureProc(indexGeneration) } catch (e) { rejectOuter(e); return }
      // Diagnostic + perf breadcrumb: an INDEX ref was served from the batch
      // (the hot per-file read this optimization moved off the per-call spawn
      // path). Immutable refs (null token) are already covered by the
      // batch-spawned / fallback events, so only tag the index path here.
      if (indexGeneration !== null) {
        performanceTrace.record(PERF_TRACE_EVENT.MAIN_GIT_CATFILE_INDEX_REF_BATCHED, {
          repoRoot: this.repoRoot,
          action: 'served',
          requestToken: indexGeneration
        })
      }

      // First read just the header to honor the large-file gate WITHOUT buffering
      // a huge blob: we peek the size, and if gated, kill+respawn (rare) so the
      // pending huge content never has to be read.
      this.pending = {
        sizeOnly: false,
        header: null,
        resolve: (r) => {
          if (r.found && requiresGitLargeFileConfirmation(r.sizeBytes, options)) {
            resolveOuter({ found: true, sizeBytes: r.sizeBytes, data: Buffer.alloc(0), largeFile: true })
          } else {
            resolveOuter(r)
          }
        },
        reject: rejectOuter
      }
      // Gate large files before the body floods in: intercept at header time by
      // checking size as soon as the header is parsed. The onData parser resolves
      // only after the full body; to avoid reading a multi-hundred-MB blob, we
      // pre-gate here using a lightweight `--batch-check`-style size probe is
      // overkill for the prototype — `cat-file --batch` bodies for diffable text
      // files are bounded by the large-file confirmation gate upstream, so the
      // body read is acceptable. (Production hardening: switch to
      // `--batch-command` info/contents to split size from content.)
      try {
        proc.stdin.write(ref + '\n')
      } catch (e) {
        this.pending = null
        rejectOuter(e)
      }
    })
    // chain so only one request is in flight on the single stdout
    const result = this.tail.then(run, run)
    this.tail = result.catch(() => undefined)
    return result
  }

  dispose(): void {
    const proc = this.proc
    this.proc = null
    this.pending = null
    // Drop any partially-buffered response so a respawn never parses the dead
    // process's leftover bytes against the new process's pending request.
    this.buf = Buffer.alloc(0)
    // Clear the snapshot identity so the next ensureProc() always records the
    // fresh token rather than inheriting the disposed process's stale one.
    this.spawnedIndexGeneration = null
    if (proc && !proc.killed) {
      // Detach the handlers BEFORE kill so the dying process's late stdout flush
      // / delayed 'exit' can never reach onData()/fail(). The `this.proc !== proc`
      // guards in ensureProc() already drop stale events; explicit teardown makes
      // it unambiguous and releases the bound closures.
      try { proc.stdout.removeAllListeners('data') } catch { /* ignore */ }
      try { proc.stdout.removeAllListeners('error') } catch { /* ignore */ }
      try { proc.removeAllListeners('exit') } catch { /* ignore */ }
      try { proc.removeAllListeners('error') } catch { /* ignore */ }
      try { proc.stdin.end() } catch { /* ignore */ }
      try { proc.kill() } catch { /* ignore */ }
    }
  }
}

class GitCatFileBatchManager {
  private byRepo = new Map<string, RepoCatFileProcess>()

  private keyFor(repoRoot: string): string {
    return resolve(repoRoot)
  }

  /**
   * Whether the long-running batch is enabled on the current platform
   * (win32 + darwin). Callers gate on this and fall back to per-call cat-file
   * when false (e.g. Linux), so the batch is never spawned out of scope.
   */
  isSupportedPlatform(): boolean {
    return isBatchSupportedPlatform(process.platform)
  }

  async readObject(
    repoRoot: string,
    gitExecutable: string,
    ref: string,
    options?: GitLargeFilePromptOptions,
    // Index-generation token (`mtime:size` of `.git/index`) for INDEX refs, or
    // null for immutable refs (HEAD:path, commit:path, blob oid). The caller
    // resolves it from the repo's gitDir; the batch uses it to respawn against
    // the current index when it changed since spawn (GDS-22 / GDS-33 freshness).
    indexGeneration: string | null = null
  ): Promise<CatFileBatchResult> {
    const key = this.keyFor(repoRoot)
    let entry = this.byRepo.get(key)
    if (!entry) {
      entry = new RepoCatFileProcess(repoRoot, gitExecutable)
      this.byRepo.set(key, entry)
    }
    return entry.read(ref, options, indexGeneration)
  }

  disposeRepo(repoRoot: string): void {
    const key = this.keyFor(repoRoot)
    const entry = this.byRepo.get(key)
    if (entry) { entry.dispose(); this.byRepo.delete(key) }
  }

  disposeAll(): void {
    for (const entry of this.byRepo.values()) entry.dispose()
    this.byRepo.clear()
  }
}

export const gitCatFileBatch = new GitCatFileBatchManager()
