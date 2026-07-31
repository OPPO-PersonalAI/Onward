/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

import { BrowserWindow, dialog, shell, type MessageBoxOptions } from 'electron'
import { tMain } from './localization'

// http(s) plus the OS-handled contact protocols the previews may surface.
// Every launch stays behind the confirm dialog below.
const ALLOWED_EXTERNAL_PROTOCOLS = new Set(['http:', 'https:', 'mailto:', 'tel:'])

export interface OpenExternalResult {
  success: boolean
  canceled?: boolean
  blocked?: boolean
  error?: string
}

function parseUrl(rawUrl: string): URL | null {
  try {
    return new URL(rawUrl)
  } catch {
    return null
  }
}

export function isHttpOrHttpsUrl(rawUrl: string): boolean {
  const parsed = parseUrl(rawUrl)
  if (!parsed) return false
  return parsed.protocol === 'http:' || parsed.protocol === 'https:'
}

function isAllowedExternalUrl(rawUrl: string): boolean {
  const parsed = parseUrl(rawUrl)
  if (!parsed) return false
  return ALLOWED_EXTERNAL_PROTOCOLS.has(parsed.protocol)
}

export function isSameAppNavigation(currentUrl: string, nextUrl: string): boolean {
  const current = parseUrl(currentUrl)
  const next = parseUrl(nextUrl)
  if (!current || !next) return false
  return (
    current.protocol === next.protocol &&
    current.host === next.host &&
    current.pathname === next.pathname
  )
}

export async function openExternalUrlWithConfirm(
  parentWindow: BrowserWindow | null,
  rawUrl: string
): Promise<OpenExternalResult> {
  if (!isAllowedExternalUrl(rawUrl)) {
    return {
      success: false,
      blocked: true,
      error: 'Only http/https/mailto/tel links are allowed'
    }
  }

  try {
    const options: MessageBoxOptions = {
      type: 'question',
      buttons: [tMain('dialog.externalLink.open'), tMain('dialog.externalLink.cancel')],
      defaultId: 1,
      cancelId: 1,
      noLink: true,
      title: tMain('dialog.externalLink.title'),
      message: tMain('dialog.externalLink.message'),
      detail: rawUrl
    }
    const { response } = parentWindow
      ? await dialog.showMessageBox(parentWindow, options)
      : await dialog.showMessageBox(options)

    if (response !== 0) {
      return {
        success: false,
        canceled: true,
        error: 'Open external link canceled by user'
      }
    }

    await shell.openExternal(rawUrl)
    return { success: true }
  } catch (error) {
    return { success: false, error: String(error) }
  }
}
