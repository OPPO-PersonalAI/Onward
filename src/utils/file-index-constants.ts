/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Single source of truth for the file-index cache's sizing knobs.
 *
 * These used to be duplicated as bare literals across four call sites, which
 * let them drift: Cmd+P asked for 50 results while the sidebar asked for 80 and
 * the IPC default was another 80, so the same query produced different result
 * counts depending on which entry point the user came from. Import from here
 * instead of re-typing a number.
 *
 * Imported by BOTH the renderer mirror (`GlobalSearch/fileIndexCache.ts`) and
 * the authoritative main-process worker (`project-fs-worker-entry.ts`), so the
 * two sides cannot disagree about capacity.
 */

/**
 * How many distinct project roots keep a materialised index in memory.
 *
 * Applies independently to the renderer mirror and to the worker's
 * authoritative store, so both evict at the same point and a project that
 * falls out of one does not linger in the other. The worker previously had NO
 * bound at all: every project visited in a session leaked a full path list
 * (~38k strings on a repo with dependencies installed) that was never released.
 */
export const FILE_INDEX_MAX_CACHED_PROJECTS = 8

/**
 * Results returned per filename-search page.
 *
 * The UI pages through larger result sets with `offset`, so this is a page
 * size, not a hard ceiling on what the user can reach.
 */
export const FILE_INDEX_SEARCH_PAGE_SIZE = 50

/**
 * Upper bound accepted for a single `searchFilenames` page.
 *
 * Guards the IPC boundary: a caller asking for a million rows would force the
 * worker to serialise the entire index into one message and stall the channel.
 */
export const FILE_INDEX_SEARCH_MAX_PAGE_SIZE = 500

/** Clamp an untrusted page size into the supported range. */
export function clampSearchPageSize(value: unknown): number {
  const numeric = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(numeric) || numeric <= 0) return FILE_INDEX_SEARCH_PAGE_SIZE
  return Math.min(Math.floor(numeric), FILE_INDEX_SEARCH_MAX_PAGE_SIZE)
}

/** Clamp an untrusted page offset to a non-negative integer. */
export function clampSearchOffset(value: unknown): number {
  const numeric = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(numeric) || numeric <= 0) return 0
  return Math.floor(numeric)
}
