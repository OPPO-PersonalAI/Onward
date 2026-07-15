/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

import { HTML_FILE_EXTENSIONS } from '../../utils/html-file.ts'

export type SubpageReturnSource = 'diff' | 'history'

export type NavigationDiffTarget = {
  filename: string
  repoRoot: string | null
  changeType: string
}

export type SubpageReturnBarState = {
  visible: boolean
  source: SubpageReturnSource | null
  backEnabled: boolean
  jumpEnabled: boolean
  checking: boolean
  activeFilePath: string | null
}

export function buildSubpageReturnBarState(params: {
  source: SubpageReturnSource | null
  jumpTarget: NavigationDiffTarget | null
  jumpChecking: boolean
  activeFilePath: string | null
}): SubpageReturnBarState {
  const visible = params.source !== null
  const checking = params.source === 'diff' && params.jumpChecking
  return {
    visible,
    source: params.source,
    backEnabled: visible,
    jumpEnabled: params.source === 'diff' && Boolean(params.jumpTarget) && !checking,
    checking,
    activeFilePath: params.activeFilePath
  }
}

// Keep this renderer-safe mirror aligned with electron/main/image-utils.ts.
// Importing the main-process module here would pull Node-only dependencies into the renderer.
const RESOURCE_BACKED_IMAGE_EXTENSIONS = [
  'png',
  'apng',
  'jpg',
  'jpeg',
  'jfif',
  'pjpeg',
  'pjp',
  'gif',
  'webp',
  'avif',
  'bmp',
  'ico',
  'cur',
  'tif',
  'tiff',
  'svg'
] as const

const RESOURCE_BACKED_EXTENSIONS = new Set([
  'pdf',
  'epub',
  ...HTML_FILE_EXTENSIONS,
  ...RESOURCE_BACKED_IMAGE_EXTENSIONS,
  'sqlite',
  'sqlite3',
  'db',
  'db3',
  's3db'
])

function fileExtension(path: string): string {
  const name = path.replace(/\\/g, '/').split('/').pop() ?? ''
  const dot = name.lastIndexOf('.')
  return dot >= 0 ? name.slice(dot + 1).toLowerCase() : ''
}

export function shouldReloadResourceBackedViewer(params: {
  activeFilePath: string | null
  requestedFilePath: string
  hasUsablePreviewResource: boolean
}): boolean {
  if (!params.activeFilePath || params.activeFilePath !== params.requestedFilePath) return false
  if (!RESOURCE_BACKED_EXTENSIONS.has(fileExtension(params.requestedFilePath))) return false
  return !params.hasUsablePreviewResource
}

export function shouldForceHtmlPreviewForNavigation(params: {
  isHtml: boolean
  forceReload: boolean
  previewOpen: boolean
}): boolean {
  return params.isHtml && params.forceReload && !params.previewOpen
}

function normalizeComparableRoot(value: string, platform: string): string {
  let normalized = value.replace(/\\/g, '/').replace(/\/+$/, '')
  if (platform === 'win32') normalized = normalized.toLowerCase()
  return normalized
}

export function canConsumeProjectEditorOpenRequest(params: {
  isOpen: boolean
  alreadyHandled: boolean
  requestTerminalId: string
  editorTerminalId: string | null
  currentRoot: string | null
  expectedRoot: string | null
  hasFileTarget: boolean
  scopeReady: boolean
  platform: 'darwin' | 'linux' | 'win32' | string
}): boolean {
  if (!params.isOpen || params.alreadyHandled) return false
  if (!params.editorTerminalId || params.requestTerminalId !== params.editorTerminalId) return false
  if (!params.hasFileTarget) return true
  if (!params.scopeReady) return false
  if (!params.currentRoot) return false
  if (!params.expectedRoot) return true
  return normalizeComparableRoot(params.currentRoot, params.platform)
    === normalizeComparableRoot(params.expectedRoot, params.platform)
}

export function isResourceBackedSoftSnapshot(snapshot: {
  isBinary: boolean
  isImage: boolean
  isSqlite: boolean
  isPdf: boolean
  isEpub: boolean
  isHtml: boolean
  isLargeFile?: boolean
}): boolean {
  return snapshot.isBinary
    || snapshot.isImage
    || snapshot.isSqlite
    || snapshot.isPdf
    || snapshot.isEpub
    || snapshot.isHtml
    || snapshot.isLargeFile === true
}
