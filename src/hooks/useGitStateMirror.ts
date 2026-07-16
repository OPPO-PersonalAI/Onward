/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * useGitStateMirror — single hook every consumer of GitStateMirror should use.
 *
 * Subscribes to mirror updates for a given cwd; returns the latest snapshot
 * (or null if the worker hasn't computed one yet). Internally it:
 *
 *   1. Calls `subscribeMirror(cwd)` which returns the current snapshot if
 *      the router already has one cached, else null.
 *   2. Listens to `onMirrorUpdate(cb)` and merges incoming deltas into local
 *      state.
 *   3. Calls `unsubscribeMirror(cwd)` on unmount / cwd-change so the worker
 *      can drop its watcher when no consumer remains.
 *
 * Consumers (commit 6/7+):
 *   - Terminal title chip   → `TerminalGrid.tsx`
 *   - GitDiffViewer         → eventual replacement for the bespoke
 *                             `lastDiffRef` / `fileContents` plumbing.
 *   - Project Editor sidebar (future)
 *   - Git History (future)
 */

import { useEffect, useState, useRef, useCallback } from 'react'
import type { GitStateMirrorSnapshot, GitStateMirrorDelta, GitStateMirrorSubscribeResult } from '../types/electron'
import { perfTrace } from '../utils/perf-trace'
import { PERF_TRACE_EVENT } from '../utils/perf-trace-names'
type PerfTraceEventName = typeof PERF_TRACE_EVENT[keyof typeof PERF_TRACE_EVENT]

function normalizeMirrorCwd(cwd: string): string {
  let normalized = cwd.replace(/\\/g, '/')
  if (normalized.startsWith('/private/')) normalized = normalized.slice('/private'.length)
  if (normalized.length > 1 && normalized.endsWith('/')) normalized = normalized.slice(0, -1)
  return normalized
}

export interface UseGitStateMirrorResult {
  /** Latest snapshot, or null until the first delta lands. */
  snapshot: GitStateMirrorSnapshot | null
  /**
   * Imperative refetch — fires `focus-resync` on the worker. Useful for
   * debug actions / manual refresh buttons. The mirror normally stays
   * fresh on its own via watcher events.
   */
  refresh: () => void
  /**
   * Get a per-file diff body (originalContent + modifiedContent) through
   * the mirror's stat-token cache. Returns null when the worker can't
   * resolve the file (binary > 1MB, file deleted, etc.). `force` bypasses
   * the worker cache.
   */
  requestFileBody: (fileKey: string, force?: boolean) => Promise<unknown | null>
}

function mergeDelta(prev: GitStateMirrorSnapshot | null, cwd: string, delta: GitStateMirrorDelta): GitStateMirrorSnapshot {
  const base: GitStateMirrorSnapshot = prev ?? {
    cwd,
    repoRoot: null,
    repoName: null,
    branch: null,
    status: null,
    files: [],
    capturedAt: 0,
    changeFingerprint: '',
    generation: 0
  }
  return {
    ...base,
    ...delta,
    cwd,
    capturedAt: delta.capturedAt
  }
}

export function useGitStateMirror(cwd: string | null): UseGitStateMirrorResult {
  const [snapshot, setSnapshot] = useState<GitStateMirrorSnapshot | null>(null)
  const cwdRef = useRef<string | null>(null)
  // Canonical (realpath) key the router resolved for `cwd`. Deltas are
  // broadcast under this key; when the consumer's cwd goes through a
  // symlink/junction the string-normalized forms never match, so updates
  // must ALSO be matched against the canonical key (2026-07-16 fix).
  const canonicalCwdRef = useRef<string | null>(null)

  useEffect(() => {
    cwdRef.current = cwd
    canonicalCwdRef.current = null
    if (!cwd) {
      setSnapshot(null)
      return
    }

    let cancelled = false
    let dispose: (() => void) | null = null

    const api = (window as unknown as { electronAPI: { git: Record<string, unknown> } }).electronAPI?.git as
      | undefined
      | {
          subscribeMirror?: (cwd: string) => Promise<GitStateMirrorSubscribeResult | null>
          unsubscribeMirror?: (cwd: string) => void
          onMirrorUpdate?: (cb: (cwd: string, delta: GitStateMirrorDelta) => void) => () => void
        }

    if (!api?.subscribeMirror || !api?.onMirrorUpdate) {
      // Mirror not available (older preload / autotest harness without bridges).
      // Hook is a graceful no-op in that case.
      return
    }

    const listenerDispose = api.onMirrorUpdate((updateCwd, delta) => {
      if (cancelled) return
      const currentCwd = cwdRef.current
      if (!currentCwd) return
      const normalizedUpdate = normalizeMirrorCwd(updateCwd)
      const matchesRaw = normalizedUpdate === normalizeMirrorCwd(currentCwd)
      const canonical = canonicalCwdRef.current
      const matchesCanonical = Boolean(canonical && normalizedUpdate === normalizeMirrorCwd(canonical))
      if (!matchesRaw && !matchesCanonical) return
      setSnapshot((prev) => mergeDelta(prev, updateCwd, delta))
    })

    void api.subscribeMirror(cwd).then((initial) => {
      if (cancelled || !initial) return
      canonicalCwdRef.current = initial.canonicalCwd || null
      if (initial.snapshot) setSnapshot(initial.snapshot)
    }).catch(() => { /* tolerate transient subscribe failure; deltas will catch up */ })

    dispose = () => {
      try { listenerDispose() } catch { /* ignore */ }
      try { api.unsubscribeMirror?.(cwd) } catch { /* ignore */ }
    }

    return () => {
      cancelled = true
      dispose?.()
    }
  }, [cwd])

  const refresh = useCallback(() => {
    const api = (window as unknown as { electronAPI: { git: Record<string, unknown> } }).electronAPI?.git as
      | undefined
      | { forceRefresh?: (cwd: string) => Promise<boolean> }
    if (cwd && api?.forceRefresh) {
      void api.forceRefresh(cwd)
    }
  }, [cwd])

  const requestFileBody = useCallback(async (fileKey: string, force = false): Promise<unknown | null> => {
    if (!cwd) return null
    const start = performance.now()
    const api = (window as unknown as { electronAPI: { git: Record<string, unknown> } }).electronAPI?.git as
      | undefined
      | { requestFileBody?: (cwd: string, fileKey: string, force: boolean) => Promise<unknown | null> }
    if (!api?.requestFileBody) return null
    try {
      const body = await api.requestFileBody(cwd, fileKey, force)
      perfTrace(PERF_TRACE_EVENT.RENDERER_GIT_DIFF_BODY_RENDERED satisfies PerfTraceEventName, {
        cwd,
        fileKey,
        durationMs: Math.round(performance.now() - start)
      })
      return body
    } catch {
      return null
    }
  }, [cwd])

  return { snapshot, refresh, requestFileBody }
}
