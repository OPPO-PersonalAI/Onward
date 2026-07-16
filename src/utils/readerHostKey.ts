/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Shared host-key forwarding for reader surfaces that render document content
 * inside a nested iframe (pdf.js viewer, epub.js renditions). Keydown events
 * inside those iframes never bubble across the frame boundary, so the host's
 * document-level handlers (useSubpageEscape, ProjectEditor shortcuts) would be
 * blind to them. Each reader forwards an allowlisted subset of keys and the
 * host re-dispatches them as a synthetic KeyboardEvent on its own document.
 *
 * The synthetic event has `isTrusted=false` but native document-level
 * `addEventListener('keydown', ...)` listeners still fire, which is what the
 * host handlers use.
 */

export type ReaderHostKeyInit = {
  key: string
  code?: string
  metaKey?: boolean
  ctrlKey?: boolean
  shiftKey?: boolean
  altKey?: boolean
}

/**
 * Pure allowlist shared by every reader surface. Mirrors
 * `resources/pdfjs/app/viewer.js`: only Cmd/Ctrl+P (project Quick Open) and
 * Escape (close subpage, return to terminal) are host-level keys; everything
 * else stays local to the reader content.
 */
export function shouldForwardReaderHostKey(init: ReaderHostKeyInit): boolean {
  if (init.key === 'Escape') return true
  const isCmd = Boolean(init.metaKey || init.ctrlKey)
  return isCmd && typeof init.key === 'string' && init.key.toLowerCase() === 'p'
}

/** Re-dispatch a forwarded reader key as a synthetic host-document keydown. */
export function redispatchReaderHostKey(init: ReaderHostKeyInit): void {
  document.dispatchEvent(new KeyboardEvent('keydown', {
    key: String(init.key ?? ''),
    code: String(init.code ?? ''),
    metaKey: Boolean(init.metaKey),
    ctrlKey: Boolean(init.ctrlKey),
    shiftKey: Boolean(init.shiftKey),
    altKey: Boolean(init.altKey),
    bubbles: true,
    cancelable: true
  }))
}
