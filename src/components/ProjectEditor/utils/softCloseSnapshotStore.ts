/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Per-scope soft-close snapshot store (VS Code-style two-level keying: the
 * caller keys by editor scope, so one Task's snapshot can never be clobbered
 * by another Task opening the editor). LRU with a small cap — snapshots hold
 * rendered/loaded file content strings, so the budget stays bounded.
 */
export const SOFT_CLOSE_SNAPSHOT_CAP = 4

export class LruSnapshotStore<T> {
  private readonly cap: number
  private readonly entries = new Map<string, T>()

  constructor(cap: number) {
    this.cap = Math.max(1, Math.floor(cap))
  }

  /** Lookup that refreshes the key's recency. */
  get(scopeKey: string | null): T | null {
    if (!scopeKey) return null
    const value = this.entries.get(scopeKey)
    if (value === undefined) return null
    this.entries.delete(scopeKey)
    this.entries.set(scopeKey, value)
    return value
  }

  /** Lookup without touching recency. */
  peek(scopeKey: string | null): T | null {
    if (!scopeKey) return null
    const value = this.entries.get(scopeKey)
    return value === undefined ? null : value
  }

  /** Insert/replace; returns the keys evicted by the cap (oldest first). */
  set(scopeKey: string | null, value: T): string[] {
    if (!scopeKey) return []
    this.entries.delete(scopeKey)
    this.entries.set(scopeKey, value)
    const evicted: string[] = []
    while (this.entries.size > this.cap) {
      const oldestKey = this.entries.keys().next().value
      if (oldestKey === undefined) break
      this.entries.delete(oldestKey)
      evicted.push(oldestKey)
    }
    return evicted
  }

  delete(scopeKey: string | null): boolean {
    if (!scopeKey) return false
    return this.entries.delete(scopeKey)
  }

  /** Delete every entry matching the predicate; returns the removed keys. */
  deleteWhere(predicate: (scopeKey: string, value: T) => boolean): string[] {
    const removed: string[] = []
    for (const [key, value] of this.entries) {
      if (predicate(key, value)) removed.push(key)
    }
    for (const key of removed) {
      this.entries.delete(key)
    }
    return removed
  }

  clear(): void {
    this.entries.clear()
  }

  get size(): number {
    return this.entries.size
  }
}
