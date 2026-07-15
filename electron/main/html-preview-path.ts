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
