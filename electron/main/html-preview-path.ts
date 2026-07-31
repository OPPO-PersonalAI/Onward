/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

import path from 'node:path'

export const HTML_PREVIEW_SCHEME = 'onward-html-preview'

export type HtmlPreviewPathPlatform = 'posix' | 'win32'

export interface HtmlPreviewRequestOptions {
  sessionId: string
  rootPath: string
  platform?: HtmlPreviewPathPlatform
}

export type HtmlPreviewRequestResult =
  | { success: true; filePath: string }
  | { success: false; reason: string }

function pathApi(platform: HtmlPreviewPathPlatform): typeof path.posix | typeof path.win32 {
  return platform === 'win32' ? path.win32 : path.posix
}

function normalizePlatform(platform?: HtmlPreviewPathPlatform): HtmlPreviewPathPlatform {
  return platform ?? (process.platform === 'win32' ? 'win32' : 'posix')
}

function encodeAbsolutePath(filePath: string, platform: HtmlPreviewPathPlatform): string {
  if (platform === 'win32') {
    const normalized = path.win32.resolve(filePath).replace(/\\/g, '/')
    return `/${normalized.split('/').map(encodeURIComponent).join('/')}`
  }
  return path.posix.resolve(filePath).split('/').map(encodeURIComponent).join('/') || '/'
}

function decodeAbsolutePath(pathname: string, platform: HtmlPreviewPathPlatform): string {
  const decoded = decodeURIComponent(pathname)
  if (platform === 'win32') {
    return path.win32.normalize(decoded.replace(/^\/(?=[A-Za-z]:\/)/, '').replace(/\//g, '\\'))
  }
  return path.posix.normalize(decoded)
}

function isPathInsideRoot(filePath: string, rootPath: string, platform: HtmlPreviewPathPlatform): boolean {
  const api = pathApi(platform)
  const normalizedRoot = api.resolve(rootPath)
  const normalizedFile = api.resolve(filePath)
  const relative = api.relative(normalizedRoot, normalizedFile)
  return relative === '' || (!relative.startsWith(`..${api.sep}`) && relative !== '..' && !api.isAbsolute(relative))
}

export function buildHtmlPreviewUrl(
  sessionId: string,
  absoluteFilePath: string,
  reloadKey = 0,
  platform?: HtmlPreviewPathPlatform
): string {
  if (!/^[A-Za-z0-9_-]+$/.test(sessionId)) {
    throw new Error('Invalid HTML Preview session id')
  }
  const resolvedPlatform = normalizePlatform(platform)
  const url = new URL(`${HTML_PREVIEW_SCHEME}://${sessionId}${encodeAbsolutePath(absoluteFilePath, resolvedPlatform)}`)
  url.searchParams.set('onwardHtmlReload', String(Math.max(0, Math.floor(reloadKey))))
  return url.toString()
}

/**
 * Classify a link's RAW `href` attribute as an in-page anchor. Must be fed
 * `getAttribute('href')`, never the resolved `href` DOM property — the
 * property expands to an absolute URL and defeats the prefix test.
 * Serialized verbatim into the HTML Preview bridge script via toString(),
 * so it must stay self-contained (no captured bindings, no helpers).
 */
export function isInPageAnchorHref(rawHref: unknown): boolean {
  return typeof rawHref === 'string' && rawHref.startsWith('#')
}

// Keep aligned with HTML_FILE_EXTENSIONS in src/utils/html-file.ts. Duplicated
// here because main-process modules must not import renderer utilities.
const IN_FRAME_HTML_EXTENSIONS = new Set(['html', 'htm', 'xhtml'])

export type HtmlPreviewLinkClassification =
  | { kind: 'external' }
  | { kind: 'external-protocol' }
  | { kind: 'in-frame'; filePath: string; url: string }
  | { kind: 'project-file'; filePath: string; relativePath: string }
  | { kind: 'outside-root' }
  | { kind: 'invalid'; reason: string }

// Extension routing for a file already proven to live inside the project
// root: HTML documents keep iframe navigation (served through the preview
// protocol), everything else goes to the Project Editor's viewer dispatch.
function routeInRootFile(
  filePath: string,
  navigableUrl: string,
  options: HtmlPreviewRequestOptions,
  platform: HtmlPreviewPathPlatform
): HtmlPreviewLinkClassification {
  const api = pathApi(platform)
  const name = filePath.split(/[\\/]/).pop() ?? ''
  const dot = name.lastIndexOf('.')
  const extension = dot > 0 && dot < name.length - 1 ? name.slice(dot + 1).toLowerCase() : ''
  if (IN_FRAME_HTML_EXTENSIONS.has(extension)) {
    return { kind: 'in-frame', filePath, url: navigableUrl }
  }
  const relative = api.relative(api.resolve(options.rootPath), filePath)
  return {
    kind: 'project-file',
    filePath,
    relativePath: relative.split(api.sep).join('/')
  }
}

/**
 * Classify a link URL clicked inside the HTML Preview into a navigation route.
 * 'in-frame' keeps browser-style iframe navigation (HTML documents only;
 * `url` is the preview-protocol URL to load); 'project-file' hands the target
 * to the Project Editor's viewer dispatch; 'external' is http(s) (hosted by
 * the Open Browser panel); 'external-protocol' is mailto:/tel: (system
 * default app); everything the session must not reach is 'outside-root' /
 * 'invalid'. Absolute file:// links are resolved against the project root and
 * re-routed like relative ones. Pure — no filesystem access.
 */
export function classifyHtmlPreviewLink(
  rawUrl: string,
  options: HtmlPreviewRequestOptions
): HtmlPreviewLinkClassification {
  if (/^https?:/i.test(rawUrl)) {
    return { kind: 'external' }
  }
  if (/^(?:mailto|tel):/i.test(rawUrl)) {
    return { kind: 'external-protocol' }
  }
  const platform = normalizePlatform(options.platform)
  if (/^file:/i.test(rawUrl)) {
    let fileUrl: URL
    try {
      fileUrl = new URL(rawUrl)
    } catch {
      return { kind: 'invalid', reason: 'invalid-url' }
    }
    // A file URL with a host is a UNC form this preview never serves.
    if (fileUrl.hostname) {
      return { kind: 'outside-root' }
    }
    let filePath: string
    try {
      filePath = decodeAbsolutePath(fileUrl.pathname, platform)
    } catch {
      return { kind: 'invalid', reason: 'invalid-path-encoding' }
    }
    if (!isPathInsideRoot(filePath, options.rootPath, platform)) {
      return { kind: 'outside-root' }
    }
    // Rebuild the navigable preview-protocol URL for HTML targets, keeping
    // the author's fragment so in-page anchors still land.
    const navigableUrl = `${buildHtmlPreviewUrl(options.sessionId, filePath, 0, platform)}${fileUrl.hash ?? ''}`
    return routeInRootFile(filePath, navigableUrl, options, platform)
  }
  const resolved = resolveHtmlPreviewRequest(rawUrl, options)
  if (!resolved.success) {
    return resolved.reason === 'outside-root'
      ? { kind: 'outside-root' }
      : { kind: 'invalid', reason: resolved.reason }
  }
  return routeInRootFile(resolved.filePath, rawUrl, options, platform)
}

export function resolveHtmlPreviewRequest(
  rawUrl: string,
  options: HtmlPreviewRequestOptions
): HtmlPreviewRequestResult {
  const platform = normalizePlatform(options.platform)
  let url: URL
  try {
    url = new URL(rawUrl)
  } catch {
    return { success: false, reason: 'invalid-url' }
  }
  if (url.protocol !== `${HTML_PREVIEW_SCHEME}:`) {
    return { success: false, reason: 'invalid-scheme' }
  }
  if (url.hostname !== options.sessionId) {
    return { success: false, reason: 'invalid-session' }
  }
  let filePath: string
  try {
    filePath = decodeAbsolutePath(url.pathname, platform)
  } catch {
    return { success: false, reason: 'invalid-path-encoding' }
  }
  if (!isPathInsideRoot(filePath, options.rootPath, platform)) {
    return { success: false, reason: 'outside-root' }
  }
  return { success: true, filePath }
}
