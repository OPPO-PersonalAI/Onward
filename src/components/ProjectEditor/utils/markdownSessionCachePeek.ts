/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Pure content-hit predicate for the markdown session cache.
 *
 * A cached render is reusable as-is ONLY when it is not stale, its captured
 * `content` is byte-identical to the file's CURRENT content (so the rendered
 * HTML cannot be stale relative to the file), and it actually carries rendered
 * HTML. This is the exact condition the side-effecting `readMarkdownSessionCache`
 * applies at its `hit` branch and the read-only `peekMarkdownSessionCacheHit`
 * applies at the worker-owner-switch fast path; sharing one predicate keeps the
 * two call sites from drifting.
 *
 * The input is a structural subset of `MarkdownSessionCacheEntry` (only the
 * three fields the decision reads) so this module has no dependency on the
 * heavyweight `ProjectEditor.tsx` and can be unit-tested in plain Node.
 *
 * Locked down by test/unittest/markdown-session-cache-peek.test.mts.
 */

export type MarkdownSessionCacheContentHitInput = {
  content: string
  renderedHtml: string
  stale: boolean
}

export function isMarkdownSessionCacheContentHit(
  entry: MarkdownSessionCacheContentHitInput | null | undefined,
  content: string
): boolean {
  if (!entry) return false
  if (entry.stale) return false
  if (entry.content !== content) return false
  if (entry.renderedHtml.length === 0) return false
  return true
}
