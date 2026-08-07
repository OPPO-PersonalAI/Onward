/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 *
 * Pure string surgery on the PDF viewer URL. The viewer shell URL carries the
 * target document as an encoded `file` query param
 * (`viewer.html?file=<file-url>&name=...`), and the file URL itself carries a
 * `v` version token (mtimeMs) that serves as cache-buster and reload-dedup
 * identity. These helpers exist so the host can derive the *new* file URL for
 * an external-change reload without ever touching the filesystem — and so the
 * logic is unit-testable (PPU-U-*) across POSIX and Windows path shapes.
 */

/** Strip any existing query string from a file URL, keeping the bare target. */
function bareFileUrl(fileUrl: string): string {
  const queryIndex = fileUrl.indexOf('?')
  return queryIndex < 0 ? fileUrl : fileUrl.slice(0, queryIndex)
}

/**
 * Extract the decoded `file` param from a viewer URL and stamp it with a new
 * `v` version token. Returns null when the URL has no `file` param (a viewer
 * shell URL without a document — nothing to reload).
 */
export function extractVersionedPdfFileUrl(viewerUrl: string, mtimeMs: number): string | null {
  if (typeof viewerUrl !== 'string' || !viewerUrl) return null
  const queryIndex = viewerUrl.indexOf('?')
  if (queryIndex < 0) return null
  const params = new URLSearchParams(viewerUrl.slice(queryIndex + 1))
  const fileUrl = params.get('file')
  if (!fileUrl) return null
  const version = Number.isFinite(mtimeMs) ? Math.trunc(mtimeMs) : 0
  return `${bareFileUrl(fileUrl)}?v=${version}`
}

/** The version token currently embedded in a viewer URL's file param, or null. */
export function readPdfFileVersion(viewerUrl: string): string | null {
  if (typeof viewerUrl !== 'string') return null
  const queryIndex = viewerUrl.indexOf('?')
  if (queryIndex < 0) return null
  const params = new URLSearchParams(viewerUrl.slice(queryIndex + 1))
  const fileUrl = params.get('file')
  if (!fileUrl) return null
  const fileQueryIndex = fileUrl.indexOf('?')
  if (fileQueryIndex < 0) return null
  const fileParams = new URLSearchParams(fileUrl.slice(fileQueryIndex + 1))
  return fileParams.get('v')
}
