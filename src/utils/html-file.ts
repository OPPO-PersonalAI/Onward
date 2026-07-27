/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

export const HTML_FILE_EXTENSIONS = new Set(['html', 'htm', 'xhtml'])
export const HTML_PREVIEW_DEFAULT_ZOOM_FACTOR = 1
export const HTML_PREVIEW_MIN_ZOOM_FACTOR = 0.5
export const HTML_PREVIEW_MAX_ZOOM_FACTOR = 2
export const HTML_PREVIEW_ZOOM_STEP = 0.1

export interface HtmlPreviewShortcutEventLike {
  key: string
  metaKey?: boolean
  ctrlKey?: boolean
  altKey?: boolean
  shiftKey?: boolean
}

export interface HtmlPreviewScrollState {
  x: number
  y: number
  scrollWidth: number
  scrollHeight: number
  clientWidth: number
  clientHeight: number
}

export function getHtmlFileExtension(path: string | null | undefined): string {
  if (!path) return ''
  const normalized = path.replace(/\\/g, '/')
  const name = normalized.split('/').pop() ?? ''
  const dot = name.lastIndexOf('.')
  if (dot < 0 || dot === name.length - 1) return ''
  return name.slice(dot + 1).toLowerCase()
}

export function isHtmlPath(path: string | null | undefined): boolean {
  return HTML_FILE_EXTENSIONS.has(getHtmlFileExtension(path))
}

export function isHtmlPreviewRefreshShortcut(event: HtmlPreviewShortcutEventLike): boolean {
  return event.key.toLowerCase() === 'r' &&
    Boolean(event.metaKey || event.ctrlKey) &&
    !event.altKey &&
    !event.shiftKey
}

export function withHtmlPreviewReloadKey(previewUrl: string | null | undefined, reloadKey: number): string | null {
  if (!previewUrl) return null
  try {
    const url = new URL(previewUrl)
    url.searchParams.set('onwardHtmlReload', String(Math.max(0, Math.floor(reloadKey))))
    return url.toString()
  } catch {
    const separator = previewUrl.includes('?') ? '&' : '?'
    return `${previewUrl}${separator}onwardHtmlReload=${encodeURIComponent(String(Math.max(0, Math.floor(reloadKey))))}`
  }
}

/**
 * Query params that are cache-busting/reload plumbing rather than part of the
 * document identity. Stripped when comparing "is the preview still on the
 * originally opened file" for the Home button's disabled state.
 */
export const HTML_PREVIEW_TRANSIENT_QUERY_PARAMS = ['mtime', 'onwardHtmlReload'] as const

export function normalizeHtmlPreviewDocumentUrl(rawUrl: string | null | undefined): string | null {
  if (!rawUrl) return null
  let url: URL
  try {
    url = new URL(rawUrl)
  } catch {
    return null
  }
  for (const param of HTML_PREVIEW_TRANSIENT_QUERY_PARAMS) {
    url.searchParams.delete(param)
  }
  url.searchParams.sort()
  // Use the parser's already-percent-encoded pathname verbatim: it canonicalises
  // equivalent spellings (a raw space and %20 both encode to %20, a raw unicode
  // char and its %-escapes to the same bytes) while keeping a '#'/'?' that is part
  // of a FILE NAME encoded as %23/%3F — so it can never collide with a structural
  // hash/query delimiter.
  // Decoding the segments (the previous approach) made 'a.html%23sec' (a real file)
  // compare equal to 'a.html#sec' (a different file at an anchor).
  const segments = url.pathname.split('/')
  // Windows drive letters are case-insensitive (file:///C:/ === file:///c:/);
  // every other segment keeps its case because POSIX paths are case-sensitive.
  if (segments.length > 1 && /^[a-zA-Z]:$/.test(segments[1])) {
    segments[1] = segments[1].toLowerCase()
  }
  const pathname = segments.join('/')
  const search = url.searchParams.toString()
  // The hash is kept: DOCUMENT identity distinguishes anchors. Callers that
  // need FILE identity (nav buttons, scroll capture — in-page anchors are a
  // pure scroll, not a navigation) go through normalizeHtmlPreviewFileUrl.
  return `${url.protocol}//${url.host}${pathname}${search ? `?${search}` : ''}${url.hash}`
}

export function isSameHtmlPreviewDocument(
  currentUrl: string | null | undefined,
  homeUrl: string | null | undefined
): boolean {
  const normalizedCurrent = normalizeHtmlPreviewDocumentUrl(currentUrl)
  const normalizedHome = normalizeHtmlPreviewDocumentUrl(homeUrl)
  if (normalizedCurrent === null || normalizedHome === null) return false
  return normalizedCurrent === normalizedHome
}

export function normalizeHtmlPreviewFileUrl(rawUrl: string | null | undefined): string | null {
  if (!rawUrl) return null
  try {
    const url = new URL(rawUrl)
    url.hash = ''
    return normalizeHtmlPreviewDocumentUrl(url.toString())
  } catch {
    return null
  }
}

export function isSameHtmlPreviewFile(
  currentUrl: string | null | undefined,
  targetUrl: string | null | undefined
): boolean {
  const normalizedCurrent = normalizeHtmlPreviewFileUrl(currentUrl)
  const normalizedTarget = normalizeHtmlPreviewFileUrl(targetUrl)
  if (normalizedCurrent === null || normalizedTarget === null) return false
  return normalizedCurrent === normalizedTarget
}

export interface HtmlPreviewNavButtonState {
  backEnabled: boolean
  forwardEnabled: boolean
  reloadEnabled: boolean
  homeEnabled: boolean
}

export function deriveHtmlPreviewNavButtonState(input: {
  ready: boolean
  canGoBack: boolean
  canGoForward: boolean
  currentUrl: string | null
  homeUrl: string | null
}): HtmlPreviewNavButtonState {
  const { ready, canGoBack, canGoForward, currentUrl, homeUrl } = input
  return {
    backEnabled: ready && canGoBack,
    forwardEnabled: ready && canGoForward,
    reloadEnabled: ready,
    // Hash-insensitive FILE comparison: an in-page anchor click is a pure
    // scroll handled inside the bridge (no history entry, Back stays put),
    // so a hash-only difference must not light Home up either.
    homeEnabled: ready && homeUrl !== null && !isSameHtmlPreviewFile(currentUrl, homeUrl)
  }
}

function readNonNegativeNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, value) : 0
}

export function normalizeHtmlPreviewScrollState(value: unknown): HtmlPreviewScrollState | null {
  if (!value || typeof value !== 'object') return null
  const raw = value as Record<string, unknown>
  return {
    x: readNonNegativeNumber(raw.x),
    y: readNonNegativeNumber(raw.y),
    scrollWidth: readNonNegativeNumber(raw.scrollWidth),
    scrollHeight: readNonNegativeNumber(raw.scrollHeight),
    clientWidth: readNonNegativeNumber(raw.clientWidth),
    clientHeight: readNonNegativeNumber(raw.clientHeight)
  }
}

export interface HtmlPreviewScrollRestoreGateInput {
  activeBrowserId: string | null
  expectedBrowserId: string
  activeReloadKey: number | null
  expectedReloadKey: number
  targetNavigationConfirmed: boolean
  loadSettled: boolean
  zoomApplied: boolean
  hasTargetState: boolean
  restoreInFlight: boolean
  restored: boolean
}

export function shouldAttemptHtmlPreviewScrollRestore(
  input: HtmlPreviewScrollRestoreGateInput
): boolean {
  return input.activeBrowserId === input.expectedBrowserId
    && input.activeReloadKey === input.expectedReloadKey
    && input.targetNavigationConfirmed
    && input.loadSettled
    && input.zoomApplied
    && input.hasTargetState
    && !input.restoreInFlight
    && !input.restored
}

export function resolveHtmlPreviewScrollRestoreTarget(
  requestedY: number,
  scrollHeight: number,
  clientHeight: number
): number {
  const targetY = readNonNegativeNumber(requestedY)
  const maxScrollTop = Math.max(
    0,
    readNonNegativeNumber(scrollHeight) - readNonNegativeNumber(clientHeight)
  )
  return Math.min(targetY, maxScrollTop)
}

export function isHtmlPreviewScrollRestoreVerified(
  requestedY: number,
  actualState: HtmlPreviewScrollState | null,
  tolerance = 2
): boolean {
  if (!actualState) return false
  const expectedY = resolveHtmlPreviewScrollRestoreTarget(
    requestedY,
    actualState.scrollHeight,
    actualState.clientHeight
  )
  return Math.abs(actualState.y - expectedY) <= Math.max(0, tolerance)
}

export function normalizeHtmlPreviewZoomFactor(value: unknown): number {
  const raw = typeof value === 'number' && Number.isFinite(value)
    ? value
    : HTML_PREVIEW_DEFAULT_ZOOM_FACTOR
  const clamped = Math.max(HTML_PREVIEW_MIN_ZOOM_FACTOR, Math.min(HTML_PREVIEW_MAX_ZOOM_FACTOR, raw))
  return Math.round(clamped * 100) / 100
}

export function stepHtmlPreviewZoomFactor(value: unknown, direction: 'in' | 'out' | 'reset'): number {
  if (direction === 'reset') return HTML_PREVIEW_DEFAULT_ZOOM_FACTOR
  const current = normalizeHtmlPreviewZoomFactor(value)
  const delta = direction === 'in' ? HTML_PREVIEW_ZOOM_STEP : -HTML_PREVIEW_ZOOM_STEP
  return normalizeHtmlPreviewZoomFactor(current + delta)
}

export function formatHtmlPreviewZoomPercent(value: unknown): string {
  return `${Math.round(normalizeHtmlPreviewZoomFactor(value) * 100)}%`
}
