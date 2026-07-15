/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

import type { BrowserFindInPageOptions, BrowserFoundInPageResult, BrowserScrollState } from '../types/electron'

export const HTML_PREVIEW_BRIDGE_MARKER = 'onward-html-preview'
export const HTML_PREVIEW_BRIDGE_VERSION = 1

export interface HtmlPreviewBridgeMessage {
  marker: typeof HTML_PREVIEW_BRIDGE_MARKER
  version: typeof HTML_PREVIEW_BRIDGE_VERSION
  sessionId: string
  type: string
  requestId?: string
  command?: string
  payload?: unknown
  success?: boolean
  value?: unknown
  error?: string
}

export function isHtmlPreviewBridgeMessage(value: unknown, sessionId: string): value is HtmlPreviewBridgeMessage {
  if (!value || typeof value !== 'object') return false
  const message = value as Record<string, unknown>
  return message.marker === HTML_PREVIEW_BRIDGE_MARKER &&
    message.version === HTML_PREVIEW_BRIDGE_VERSION &&
    message.sessionId === sessionId &&
    typeof message.type === 'string'
}

export interface HtmlPreviewController {
  goBack: () => Promise<boolean>
  goForward: () => Promise<boolean>
  reload: () => Promise<boolean>
  home: () => Promise<boolean>
  getScrollState: () => Promise<{ success: boolean; state?: BrowserScrollState; error?: string }>
  restoreScrollState: (state: BrowserScrollState) => Promise<{ success: boolean; state?: BrowserScrollState; error?: string }>
  findInPage: (text: string, options?: BrowserFindInPageOptions) => Promise<{ success: boolean; requestId?: number; error?: string }>
  stopFindInPage: () => Promise<boolean>
  getZoomFactor: () => Promise<{ success: boolean; zoomFactor?: number; error?: string }>
  setZoomFactor: (zoomFactor: number) => Promise<{ success: boolean; zoomFactor?: number; error?: string }>
  evaluateForTest: (script: string) => Promise<{ success: boolean; value?: unknown; error?: string }>
}

export interface HtmlPreviewControllerEvents {
  onFoundInPage: (result: BrowserFoundInPageResult) => void
  onFindShortcut: () => void
  onReloadShortcut: () => void
  onZoomShortcut: (direction: 'in' | 'out' | 'reset') => void
}

const controllers = new Map<string, HtmlPreviewController>()

export function registerHtmlPreviewController(id: string, controller: HtmlPreviewController): () => void {
  controllers.set(id, controller)
  return () => {
    if (controllers.get(id) === controller) controllers.delete(id)
  }
}

export function getHtmlPreviewController(id: string | null | undefined): HtmlPreviewController | null {
  return id ? controllers.get(id) ?? null : null
}
