/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

import { invalidate, recordAuthoritativeCount, setFileIndexWatcherAdapter } from './fileIndexCache'
import { perfTrace } from '../../../utils/perf-trace'
import { PERF_TRACE_EVENT } from '../../../utils/perf-trace-names'

let initialized = false

export function initializeFileIndexCacheBridge(): void {
  if (initialized) return
  if (typeof window === 'undefined') return
  const api = window.electronAPI?.project
  if (!api || typeof api.treeWatchStart !== 'function') return

  const debugLog = (...args: unknown[]) => {
    if (!window.electronAPI?.debug?.enabled) return
    const message = args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ')
    // Route via console AND the main-process debug log so autotest log files capture it.
    console.log('[FileIndexCacheBridge]', message)
    window.electronAPI?.debug?.log?.(`[FileIndexCacheBridge] ${message}`)
  }

  setFileIndexWatcherAdapter({
    start: (cwd: string) => {
      debugLog('start', cwd)
      void api.treeWatchStart(cwd)
    },
    stop: (cwd: string) => {
      debugLog('stop', cwd)
      void api.treeWatchStop(cwd)
    }
  })

  api.onTreeWatchEvent((event) => {
    if (!event || typeof event.cwd !== 'string') return
    const added = Array.isArray(event.added) ? event.added : []
    const removed = Array.isArray(event.removed) ? event.removed : []
    const resync = Boolean((event as { resync?: boolean }).resync)
    debugLog('event', JSON.stringify({ cwd: event.cwd, added: added.length, removed: removed.length, resync }))
    if (resync) {
      // The main-process watcher could not determine what changed (typically
      // a null-filename fs.watch event). Drop the entry so the next search
      // rebuilds from disk, rather than leaving removed paths stale. This is
      // the ONLY branch where a full invalidation is the correct response —
      // everywhere else the exact diff is known and must be patched instead.
      invalidate(event.cwd)
      void api.invalidateFileIndex?.(event.cwd)
      perfTrace(PERF_TRACE_EVENT.RENDERER_FILE_INDEX_MIRROR_SYNC, {
        reason: 'resync-invalidate',
        added: 0,
        removed: 0
      })
      return
    }

    if (added.length === 0 && removed.length === 0) return

    // Send the exact diff to the authoritative worker index. This replaces the
    // previous `invalidateFileIndex` call, which threw away the whole index on
    // ANY event — including the `update` event that a plain Cmd+S produces —
    // and so made every save cost a full recursive re-walk on the next search.
    //
    // The renderer does NOT decide what changed: the worker applies the diff
    // and reports back. Mirroring its `fileCount` rather than recomputing one
    // locally is what removed the second (drift-prone) patch implementation.
    void api.patchFileIndex?.(event.cwd, { added, removed })
      .then((result) => {
        if (!result?.applied) return
        recordAuthoritativeCount(event.cwd, result.fileCount)
        perfTrace(PERF_TRACE_EVENT.RENDERER_FILE_INDEX_MIRROR_SYNC, {
          reason: result.changed ? 'patch-applied' : 'patch-noop',
          added: added.length,
          removed: removed.length,
          fileCount: result.fileCount
        })
      })
      .catch(() => {
        // The authority is unreachable; leave the mirror's last known count in
        // place. The next build reconciles it.
        perfTrace(PERF_TRACE_EVENT.RENDERER_FILE_INDEX_MIRROR_SYNC, {
          reason: 'patch-failed',
          added: added.length,
          removed: removed.length
        })
      })
  })

  debugLog('initialized')
  initialized = true
}
