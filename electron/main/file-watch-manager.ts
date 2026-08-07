/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 *
 * Single-file watcher behind the Project Editor's "refresh when the file
 * changes on disk" behaviour. Two modes per watched path:
 *
 *   text    — baseline is the file's UTF-8 content; change events ship the
 *             new content inline so the renderer never re-reads the disk.
 *   binary  — baseline is a size+mtime+sha256 fingerprint; change events ship
 *             a {size, mtimeMs} meta instead of content. Used for PDFs, where
 *             a UTF-8 read is both lossy and expensive.
 *
 * Self-write suppression is fingerprint-based, not time-based: writers
 * register the exact bytes they persisted via suppressNext(path, {size, hash})
 * and the settle path decides emit/skip through the pure core in
 * file-watch-core.ts. This covers the rename-rebuild path (atomic replace)
 * that the old time-window never gated. All decision logic is unit-tested in
 * test/unittest/file-watch-binary-core.test.mts; this file is deliberately a
 * thin I/O shell.
 */

import { watch, readFile, stat, createReadStream } from 'fs'
import { createHash } from 'crypto'
import type { FSWatcher } from 'fs'
import type { BrowserWindow } from 'electron'
import { normalize } from 'path'
import { IPC } from '../shared/ipc-channels'
import { performanceTrace } from './performance-trace'
import { PERF_TRACE_EVENT } from '../../src/utils/perf-trace-names'
import {
  EXPECTED_WRITE_TTL_MS,
  HASH_MAX_BYTES,
  binaryBaselineChanged,
  classifyStat,
  isExpectedWriteLive,
  resolveSettle,
  shouldComputeHash
} from './file-watch-core'
import type { DiskFingerprint, ExpectedWrite, WatchMode } from './file-watch-core'

export interface FileChangeMeta {
  mtimeMs: number
  size: number
}

interface WatchEntry {
  mode: WatchMode
  watcher: FSWatcher | null
  debounceTimer: NodeJS.Timeout | null
  rebuildTimer: NodeJS.Timeout | null
  expected: ExpectedWrite | null
  lastContent: string | null
  fingerprint: DiskFingerprint | null
  disposed: boolean
  settleInFlight: boolean
  settleQueued: boolean
}

const DEBOUNCE_MS = 400
const REBUILD_DELAY_MS = 500
const REBUILD_MAX_RETRIES = 5

function sha256OfBuffer(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex')
}

export function sha256OfUtf8(content: string): string {
  return sha256OfBuffer(Buffer.from(content, 'utf8'))
}

function sha256OfFile(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256')
    const stream = createReadStream(path)
    stream.on('error', reject)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('end', () => resolve(hash.digest('hex')))
  })
}

function statAsync(path: string): Promise<{ size: number; mtimeMs: number } | null> {
  return new Promise((resolve) => {
    stat(path, (error, stats) => {
      if (error) {
        resolve(null)
        return
      }
      resolve({ size: stats.size, mtimeMs: stats.mtimeMs })
    })
  })
}

export class FileWatchManager {
  private entries = new Map<string, WatchEntry>()

  constructor(private readonly mainWindow: BrowserWindow) {}

  watch(fullPath: string, mode: WatchMode = 'text'): void {
    const normalizedPath = normalize(fullPath)
    if (this.entries.has(normalizedPath)) {
      return
    }

    const entry: WatchEntry = {
      mode,
      watcher: null,
      debounceTimer: null,
      rebuildTimer: null,
      expected: null,
      lastContent: null,
      fingerprint: null,
      disposed: false,
      settleInFlight: false,
      settleQueued: false
    }
    this.entries.set(normalizedPath, entry)
    performanceTrace.record(PERF_TRACE_EVENT.MAIN_FILE_WATCH_REGISTERED, {
      mode,
      pathLen: normalizedPath.length
    })

    if (mode === 'binary') {
      void this.captureBinaryBaseline(normalizedPath, entry).then(() => {
        if (!entry.disposed) this.createWatcher(normalizedPath, entry, 0)
      })
      return
    }

    readFile(normalizedPath, 'utf-8', (error, content) => {
      if (entry.disposed) return
      if (!error) {
        entry.lastContent = content
      }
      this.createWatcher(normalizedPath, entry, 0)
    })
  }

  unwatch(fullPath: string): void {
    const normalizedPath = normalize(fullPath)
    const entry = this.entries.get(normalizedPath)
    if (!entry) return
    entry.disposed = true
    this.cleanupEntry(entry)
    this.entries.delete(normalizedPath)
  }

  /**
   * Register the fingerprint of bytes this app just wrote to a watched path,
   * so the resulting watcher events are recognised as our own write instead
   * of an external change. Covers both plain writes and atomic replaces.
   */
  suppressNext(fullPath: string, expected: { size: number; hash: string }): void {
    const normalizedPath = normalize(fullPath)
    const entry = this.entries.get(normalizedPath)
    if (!entry) return
    entry.expected = {
      size: expected.size,
      hash: expected.hash,
      expiresAt: Date.now() + EXPECTED_WRITE_TTL_MS
    }
  }

  dispose(): void {
    for (const [path, entry] of this.entries) {
      entry.disposed = true
      this.cleanupEntry(entry)
      this.entries.delete(path)
    }
  }

  private async captureBinaryBaseline(normalizedPath: string, entry: WatchEntry): Promise<void> {
    const stats = await statAsync(normalizedPath)
    if (entry.disposed || !stats) return
    let hash: string | null = null
    if (stats.size <= HASH_MAX_BYTES) {
      try {
        hash = await sha256OfFile(normalizedPath)
      } catch {
        hash = null
      }
    }
    if (entry.disposed) return
    entry.fingerprint = { size: stats.size, mtimeMs: stats.mtimeMs, hash }
  }

  private createWatcher(normalizedPath: string, entry: WatchEntry, retryCount: number): void {
    if (entry.disposed) return

    if (entry.watcher) {
      try {
        entry.watcher.close()
      } catch {
        // Ignore close failures during watcher replacement.
      }
      entry.watcher = null
    }

    try {
      entry.watcher = watch(normalizedPath, { persistent: true }, (eventType) => {
        if (eventType === 'rename') {
          this.scheduleRebuild(normalizedPath, entry, 0)
          return
        }
        this.handleEvent(normalizedPath, entry)
      })

      entry.watcher.on('error', () => {
        this.scheduleRebuild(normalizedPath, entry, 0)
      })
    } catch {
      if (retryCount < REBUILD_MAX_RETRIES) {
        this.scheduleRebuild(normalizedPath, entry, retryCount)
      }
    }
  }

  private scheduleRebuild(normalizedPath: string, entry: WatchEntry, retryCount: number): void {
    if (entry.disposed) return

    if (entry.watcher) {
      try {
        entry.watcher.close()
      } catch {
        // Ignore close failures during rebuild.
      }
      entry.watcher = null
    }

    if (entry.rebuildTimer) {
      clearTimeout(entry.rebuildTimer)
    }
    performanceTrace.record(PERF_TRACE_EVENT.MAIN_FILE_WATCH_REBUILD_SCHEDULED, {
      mode: entry.mode,
      retry: retryCount
    })

    entry.rebuildTimer = setTimeout(() => {
      entry.rebuildTimer = null
      if (entry.disposed) return

      stat(normalizedPath, (error) => {
        if (entry.disposed) return

        if (error) {
          this.recordSettled(entry, 'emit-deleted')
          this.emitChange(normalizedPath, 'deleted')
          if (retryCount < REBUILD_MAX_RETRIES) {
            this.scheduleRebuild(normalizedPath, entry, retryCount + 1)
          }
          return
        }

        this.createWatcher(normalizedPath, entry, retryCount + 1)
        // The settle path (not a raw emit) runs here on purpose: after an
        // atomic replace this is the first — and only — signal, and it must
        // still distinguish our own save from an external writer.
        void this.settle(normalizedPath, entry)
      })
    }, REBUILD_DELAY_MS)
  }

  private handleEvent(normalizedPath: string, entry: WatchEntry): void {
    if (entry.disposed) return

    if (entry.debounceTimer) {
      clearTimeout(entry.debounceTimer)
    }

    entry.debounceTimer = setTimeout(() => {
      entry.debounceTimer = null
      if (!entry.disposed) {
        void this.settle(normalizedPath, entry)
      }
    }, DEBOUNCE_MS)
  }

  /**
   * Observe the disk state once the events have quieted down and decide
   * emit / skip through the pure core. Serialised per entry: a settle that
   * arrives while one is running is coalesced into a single follow-up run.
   */
  private async settle(normalizedPath: string, entry: WatchEntry): Promise<void> {
    if (entry.settleInFlight) {
      entry.settleQueued = true
      return
    }
    entry.settleInFlight = true
    try {
      do {
        entry.settleQueued = false
        if (entry.mode === 'binary') {
          await this.settleBinary(normalizedPath, entry)
        } else {
          await this.settleText(normalizedPath, entry)
        }
      } while (entry.settleQueued && !entry.disposed)
    } finally {
      entry.settleInFlight = false
    }
  }

  private async settleBinary(normalizedPath: string, entry: WatchEntry): Promise<void> {
    const stats = await statAsync(normalizedPath)
    if (entry.disposed) return
    if (!stats) {
      this.recordSettled(entry, 'emit-deleted')
      this.emitChange(normalizedPath, 'deleted')
      return
    }

    const nowMs = Date.now()
    const expected = isExpectedWriteLive(entry.expected, nowMs) ? entry.expected : null
    const baseline = entry.fingerprint

    if (baseline) {
      const statClass = classifyStat(baseline, stats)
      if (statClass === 'unchanged' && !expected) {
        this.recordSettled(entry, 'skip-unchanged')
        return
      }
    }

    let hash: string | null = null
    if (shouldComputeHash({ size: stats.size, expected, nowMs })) {
      try {
        hash = await sha256OfFile(normalizedPath)
      } catch {
        hash = null
      }
      if (entry.disposed) return
    }

    const disk: DiskFingerprint = { size: stats.size, mtimeMs: stats.mtimeMs, hash }
    const baselineChanged = baseline ? binaryBaselineChanged(baseline, disk) : true
    const action = resolveSettle({
      nowMs,
      expected,
      disk: { size: disk.size, hash: disk.hash },
      baselineChanged
    })

    if (action === 'skip-own-write') {
      entry.fingerprint = disk
      entry.expected = null
      this.recordSettled(entry, action)
      return
    }
    if (action === 'skip-unchanged') {
      // Refresh the mtime so a bare touch does not force a hash on every
      // subsequent event.
      entry.fingerprint = baseline ? { ...baseline, mtimeMs: disk.mtimeMs } : disk
      this.recordSettled(entry, action)
      return
    }

    entry.fingerprint = disk
    entry.expected = null
    this.recordSettled(entry, action)
    this.emitChange(normalizedPath, 'changed', undefined, {
      mtimeMs: disk.mtimeMs,
      size: disk.size
    })
  }

  private async settleText(normalizedPath: string, entry: WatchEntry): Promise<void> {
    let content: string
    try {
      content = await new Promise<string>((resolve, reject) => {
        readFile(normalizedPath, 'utf-8', (error, data) => {
          if (error) {
            reject(error)
            return
          }
          resolve(data)
        })
      })
    } catch (error) {
      if (
        error &&
        typeof error === 'object' &&
        'code' in error &&
        (error as { code?: string }).code === 'ENOENT'
      ) {
        this.recordSettled(entry, 'emit-deleted')
        this.emitChange(normalizedPath, 'deleted')
      }
      return
    }
    if (entry.disposed) return

    const nowMs = Date.now()
    const expected = isExpectedWriteLive(entry.expected, nowMs) ? entry.expected : null
    const contentBuffer = Buffer.from(content, 'utf8')
    const action = resolveSettle({
      nowMs,
      expected,
      disk: {
        size: contentBuffer.byteLength,
        // Hash only when a self-write registration is pending; the plain
        // string comparison already answers "changed?" for text.
        hash: expected ? sha256OfBuffer(contentBuffer) : null
      },
      baselineChanged: content !== entry.lastContent
    })

    if (action === 'skip-own-write') {
      entry.lastContent = content
      entry.expected = null
      this.recordSettled(entry, action)
      return
    }
    if (action === 'skip-unchanged') {
      this.recordSettled(entry, action)
      return
    }

    entry.lastContent = content
    entry.expected = null
    this.recordSettled(entry, action)
    this.emitChange(normalizedPath, 'changed', content)
  }

  private recordSettled(entry: WatchEntry, action: string): void {
    performanceTrace.record(PERF_TRACE_EVENT.MAIN_FILE_WATCH_SETTLED, {
      mode: entry.mode,
      action
    })
  }

  private emitChange(
    fullPath: string,
    changeType: 'changed' | 'deleted',
    content?: string,
    meta?: FileChangeMeta
  ): void {
    if (this.mainWindow.isDestroyed()) return
    this.mainWindow.webContents.send(IPC.PROJECT_FILE_CHANGED, fullPath, changeType, content, meta)
  }

  private cleanupEntry(entry: WatchEntry): void {
    if (entry.debounceTimer) {
      clearTimeout(entry.debounceTimer)
      entry.debounceTimer = null
    }
    if (entry.rebuildTimer) {
      clearTimeout(entry.rebuildTimer)
      entry.rebuildTimer = null
    }
    if (entry.watcher) {
      try {
        entry.watcher.close()
      } catch {
        // Ignore close failures during cleanup.
      }
      entry.watcher = null
    }
  }
}
