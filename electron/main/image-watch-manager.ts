/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

import { watch, stat } from 'fs'
import type { FSWatcher, Stats } from 'fs'
import { resolve, normalize } from 'path'
import type { BrowserWindow } from 'electron'
import { IPC } from '../shared/ipc-channels'
import { performanceTrace } from './performance-trace'
import { PERF_TRACE_EVENT } from '../../src/utils/perf-trace-names'

interface ImageWatchEntry {
  watcher: FSWatcher | null
  debounceTimer: NodeJS.Timeout | null
  rebuildTimer: NodeJS.Timeout | null
  lastMtimeMs: number
  lastSize: number
  relativePath: string
  disposed: boolean
}

const DEBOUNCE_MS = 400
const REBUILD_DELAY_MS = 500
const REBUILD_MAX_RETRIES = 5
const MAX_IMAGE_WATCHERS = 50

export class ImageWatchManager {
  private entries = new Map<string, ImageWatchEntry>()
  private root = ''

  constructor(private readonly mainWindow: BrowserWindow) {}

  watchImages(root: string, relativePaths: string[]): void {
    this.root = root
    for (const relPath of relativePaths) {
      if (this.entries.size >= MAX_IMAGE_WATCHERS) break
      const fullPath = normalize(resolve(root, relPath))
      if (this.entries.has(fullPath)) continue

      const entry: ImageWatchEntry = {
        watcher: null,
        debounceTimer: null,
        rebuildTimer: null,
        lastMtimeMs: 0,
        lastSize: -1,
        relativePath: relPath,
        disposed: false
      }
      this.entries.set(fullPath, entry)

      stat(fullPath, (error, stats) => {
        if (entry.disposed) return
        if (!error) {
          entry.lastMtimeMs = stats.mtimeMs
          entry.lastSize = stats.size
        }
        this.createWatcher(fullPath, entry, 0)
      })
    }
  }

  unwatchImages(root: string, relativePaths: string[]): void {
    for (const relPath of relativePaths) {
      const fullPath = normalize(resolve(root, relPath))
      const entry = this.entries.get(fullPath)
      if (!entry) continue
      entry.disposed = true
      this.cleanupEntry(entry)
      this.entries.delete(fullPath)
    }
  }

  unwatchAll(): void {
    for (const [key, entry] of this.entries) {
      entry.disposed = true
      this.cleanupEntry(entry)
      this.entries.delete(key)
    }
  }

  dispose(): void {
    this.unwatchAll()
  }

  private createWatcher(fullPath: string, entry: ImageWatchEntry, retryCount: number): void {
    if (entry.disposed) return

    if (entry.watcher) {
      try { entry.watcher.close() } catch { /* ignore */ }
      entry.watcher = null
    }

    try {
      entry.watcher = watch(fullPath, { persistent: false }, (eventType) => {
        if (eventType === 'rename') {
          this.scheduleRebuild(fullPath, entry, 0)
          return
        }
        this.handleEvent(fullPath, entry)
      })

      entry.watcher.on('error', () => {
        this.scheduleRebuild(fullPath, entry, 0)
      })
    } catch {
      if (retryCount < REBUILD_MAX_RETRIES) {
        this.scheduleRebuild(fullPath, entry, retryCount)
      }
    }
  }

  private scheduleRebuild(fullPath: string, entry: ImageWatchEntry, retryCount: number): void {
    if (entry.disposed) return

    if (entry.watcher) {
      try { entry.watcher.close() } catch { /* ignore */ }
      entry.watcher = null
    }

    if (entry.rebuildTimer) {
      clearTimeout(entry.rebuildTimer)
    }

    entry.rebuildTimer = setTimeout(() => {
      entry.rebuildTimer = null
      if (entry.disposed) return

      stat(fullPath, (error, stats) => {
        if (entry.disposed) return

        if (error) {
          this.emitChange(entry.relativePath)
          if (retryCount < REBUILD_MAX_RETRIES) {
            this.scheduleRebuild(fullPath, entry, retryCount + 1)
          }
          return
        }

        this.createWatcher(fullPath, entry, retryCount + 1)
        this.checkAndEmit(entry, stats)
      })
    }, REBUILD_DELAY_MS)
  }

  private handleEvent(fullPath: string, entry: ImageWatchEntry): void {
    if (entry.disposed) return

    if (entry.debounceTimer) {
      clearTimeout(entry.debounceTimer)
    }

    entry.debounceTimer = setTimeout(() => {
      entry.debounceTimer = null
      if (entry.disposed) return

      stat(fullPath, (error, stats) => {
        if (entry.disposed) return
        if (error) {
          this.emitChange(entry.relativePath)
          return
        }
        this.checkAndEmit(entry, stats)
      })
    }, DEBOUNCE_MS)
  }

  private checkAndEmit(entry: ImageWatchEntry, stats: Stats): void {
    if (stats.mtimeMs === entry.lastMtimeMs && stats.size === entry.lastSize) return
    entry.lastMtimeMs = stats.mtimeMs
    entry.lastSize = stats.size
    this.emitChange(entry.relativePath)
  }

  private emitChange(relativePath: string): void {
    if (this.mainWindow.isDestroyed()) return
    performanceTrace.record(PERF_TRACE_EVENT.MAIN_IMAGE_WATCH_CHANGE_EMITTED, {
      relativePathLen: relativePath.length
    })
    this.mainWindow.webContents.send(IPC.PROJECT_IMAGE_FILE_CHANGED, relativePath)
  }

  private cleanupEntry(entry: ImageWatchEntry): void {
    if (entry.debounceTimer) {
      clearTimeout(entry.debounceTimer)
      entry.debounceTimer = null
    }
    if (entry.rebuildTimer) {
      clearTimeout(entry.rebuildTimer)
      entry.rebuildTimer = null
    }
    if (entry.watcher) {
      try { entry.watcher.close() } catch { /* ignore */ }
      entry.watcher = null
    }
  }
}
