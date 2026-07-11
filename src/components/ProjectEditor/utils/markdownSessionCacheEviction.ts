/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

export type MarkdownSessionCacheEvictionEntry = {
  key: string
  dwellMs: number
  openCount: number
  lastAccessedAt: number
}

export function getMarkdownSessionCacheEvictionScore(
  entry: MarkdownSessionCacheEvictionEntry,
  maxDwellMs: number,
  maxOpenCount: number,
  now: number,
  recencyHalfLifeMs: number
): number {
  const dwellScore = maxDwellMs > 0 ? entry.dwellMs / maxDwellMs : 0
  const openScore = maxOpenCount > 0 ? entry.openCount / maxOpenCount : 0
  const activityScore = dwellScore * 0.7 + openScore * 0.3
  const ageMs = Math.max(0, now - entry.lastAccessedAt)
  const recencyDecay = 1 / (1 + ageMs / recencyHalfLifeMs)
  return activityScore * recencyDecay
}

/**
 * Pick which cache keys to evict so the store fits its budget, never touching
 * protected keys (each active Task's last markdown file). The effective limit
 * grows to protected.size + 1 so a crowd of protected entries can still admit
 * the entry being written; when only protected entries remain, nothing is
 * evicted (temporary overshoot beats evicting another Task's instant-reopen
 * cache).
 */
export function selectMarkdownSessionCacheEvictions(
  entries: MarkdownSessionCacheEvictionEntry[],
  opts: {
    limit: number
    protectedKeys: ReadonlySet<string>
    now: number
    recencyHalfLifeMs: number
  }
): string[] {
  const effectiveLimit = Math.max(opts.limit, opts.protectedKeys.size + 1)
  const evictions: string[] = []
  const remaining = entries.slice()
  while (remaining.length - evictions.length > effectiveLimit) {
    const candidates = remaining.filter(
      (entry) => !opts.protectedKeys.has(entry.key) && !evictions.includes(entry.key)
    )
    if (candidates.length === 0) break
    const maxDwellMs = Math.max(0, ...remaining.map((entry) => entry.dwellMs))
    const maxOpenCount = Math.max(0, ...remaining.map((entry) => entry.openCount))
    let evictKey: string | null = null
    let evictScore = Number.POSITIVE_INFINITY
    for (const entry of candidates) {
      const score = getMarkdownSessionCacheEvictionScore(
        entry,
        maxDwellMs,
        maxOpenCount,
        opts.now,
        opts.recencyHalfLifeMs
      )
      if (score < evictScore) {
        evictScore = score
        evictKey = entry.key
      }
    }
    if (!evictKey) break
    evictions.push(evictKey)
  }
  return evictions
}
