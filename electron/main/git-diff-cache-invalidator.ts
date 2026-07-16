/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

import { resolve } from 'path'

/**
 * Git Diff cache invalidation bus.
 *
 * The old implementation owned a second Parcel watcher per active Git Diff
 * cwd. That made GitStateMirror and GitDiffViewer observe the same file-system
 * stream through two independent authority paths. The Mirror Worker is now the
 * only FS-event authority: this module only fans out invalidation reasons that
 * are already known by a caller (mirror delta, manual refresh, force reload,
 * watcher-error, or LRU bookkeeping).
 */

const RECENT_PROJECT_LIMIT = 8

export type GitDiffInvalidationReason =
  | 'watcher'
  | 'watcher-error'
  | 'force'
  | 'lru'
  | 'manual'
  | 'mirror'

/**
 * Optional scope refinement carried with an invalidation. When `files` is a
 * non-empty list of repo-relative paths, the caller asserts the mutation
 * touched ONLY those files (single-file stage/discard/save), so downstream
 * layers may evict per-file instead of wiping the whole project bucket and
 * the renderer may keep every other file's warm state. Callers that cannot
 * enumerate the affected files simply omit it — the conservative whole-bucket
 * semantics remain the default (2026-07-16 revert-scope fix).
 */
export interface GitDiffInvalidationDetail {
  files?: string[]
}

export interface GitDiffWatcherHealthStats {
  backend: 'mirror'
  active: number
  maxProjects: number
  projects: Array<{
    cwd: string
    status: 'registered' | 'disposed'
    eventCount: number
    resyncCount: number
    lastEventAt: number | null
    lastError: string | null
    pending: boolean
  }>
}

interface InvalidationListener {
  /**
   * `reason` provenance:
   *   - `mirror` — GitStateMirror worker reported a real state delta.
   *   - `watcher-error` — GitStateMirror worker watcher failed.
   *   - `force` / `manual` — explicit caller request.
   *   - `lru` — project registration fell out of the diagnostic LRU.
   *
   * `watcher` remains in the public union for backward-compatible renderer
   * diagnostics from older bundles, but this module no longer emits it.
   *
   * `detail` is present only for file-scoped invalidations (see
   * `GitDiffInvalidationDetail`).
   */
  (cwd: string, reason: GitDiffInvalidationReason, detail?: GitDiffInvalidationDetail): void
}

interface RegisteredProject {
  cwd: string
  lastTouchedAt: number
  lastInvalidatedAt: number | null
  lastReason: GitDiffInvalidationReason | null
}

class GitDiffCacheInvalidator {
  private projects = new Map<string, RegisteredProject>()
  private recentProjectQueue: string[] = []
  private listeners = new Set<InvalidationListener>()

  /**
   * Register a project for diagnostics / LRU visibility only. No watcher is
   * created here; the GitStateMirror Worker owns FS events for the same cwd.
   */
  registerWatch(cwd: string): void {
    const normalized = resolve(cwd)
    const existing = this.projects.get(normalized)
    if (existing) {
      existing.lastTouchedAt = Date.now()
      this.moveProjectToFront(normalized)
      return
    }
    this.projects.set(normalized, {
      cwd: normalized,
      lastTouchedAt: Date.now(),
      lastInvalidatedAt: null,
      lastReason: null
    })
    this.moveProjectToFront(normalized)
    this.evictIfOverLimit()
  }

  unregisterWatch(cwd: string): void {
    const normalized = resolve(cwd)
    this.projects.delete(normalized)
    const queueIndex = this.recentProjectQueue.indexOf(normalized)
    if (queueIndex >= 0) this.recentProjectQueue.splice(queueIndex, 1)
  }

  invalidate(cwd: string, reason: 'force' | 'manual' | 'mirror' = 'manual', detail?: GitDiffInvalidationDetail): void {
    this.fireListeners(resolve(cwd), reason, detail)
  }

  notifyWatcherError(cwd: string): void {
    this.fireListeners(resolve(cwd), 'watcher-error')
  }

  addListener(listener: InvalidationListener): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  dispose(): void {
    this.projects.clear()
    this.listeners.clear()
    this.recentProjectQueue.length = 0
  }

  inspectHealth(): GitDiffWatcherHealthStats {
    return {
      backend: 'mirror',
      active: this.projects.size,
      maxProjects: RECENT_PROJECT_LIMIT,
      projects: this.recentProjectQueue
        .map((cwd) => this.projects.get(cwd))
        .filter((entry): entry is RegisteredProject => Boolean(entry))
        .map((entry) => ({
          cwd: entry.cwd,
          status: 'registered',
          eventCount: entry.lastInvalidatedAt === null ? 0 : 1,
          resyncCount: 0,
          lastEventAt: entry.lastInvalidatedAt,
          lastError: entry.lastReason === 'watcher-error' ? 'GitStateMirror watcher error' : null,
          pending: false
        }))
    }
  }

  private fireListeners(cwd: string, reason: GitDiffInvalidationReason, detail?: GitDiffInvalidationDetail): void {
    const normalized = resolve(cwd)
    const entry = this.projects.get(normalized)
    if (entry) {
      entry.lastTouchedAt = Date.now()
      entry.lastInvalidatedAt = Date.now()
      entry.lastReason = reason
      this.moveProjectToFront(normalized)
    }
    for (const listener of this.listeners) {
      try {
        listener(normalized, reason, detail)
      } catch (error) {
        console.warn('[git-diff-cache-invalidator] listener failed:', error)
      }
    }
  }

  private moveProjectToFront(cwd: string): void {
    const existingIndex = this.recentProjectQueue.indexOf(cwd)
    if (existingIndex >= 0) this.recentProjectQueue.splice(existingIndex, 1)
    this.recentProjectQueue.unshift(cwd)
  }

  private evictIfOverLimit(): void {
    while (this.recentProjectQueue.length > RECENT_PROJECT_LIMIT) {
      const evicted = this.recentProjectQueue.pop()
      if (!evicted) return
      this.projects.delete(evicted)
      this.fireListeners(evicted, 'lru')
    }
  }
}

export const gitDiffCacheInvalidator = new GitDiffCacheInvalidator()
