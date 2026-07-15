/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

import type { FileViewMemory } from '../../types/tab.d.ts'

export type PdfReaderState = {
  page: number
  scrollTop: number
  scale: string | null
}

export function shouldInitializePdfReadyHandshake(alreadyReady: boolean): boolean {
  return !alreadyReady
}

export function normalizePdfReaderState(input: {
  page: unknown
  scrollTop: unknown
  scale: unknown
}): PdfReaderState {
  const page = Number(input.page)
  const scrollTop = Number(input.scrollTop)
  const scale = typeof input.scale === 'string' && input.scale.trim()
    ? input.scale
    : null
  return {
    page: Number.isFinite(page) && page >= 1 ? Math.floor(page) : 1,
    scrollTop: Number.isFinite(scrollTop) && scrollTop > 0 ? scrollTop : 0,
    scale
  }
}

export function normalizePdfReaderStateIfReady(
  stateReady: boolean,
  input: {
    page: unknown
    scrollTop: unknown
    scale: unknown
  }
): PdfReaderState | null {
  return stateReady ? normalizePdfReaderState(input) : null
}

export function mergePdfReaderState(
  current: FileViewMemory | null | undefined,
  state: PdfReaderState
): FileViewMemory {
  return {
    ...(current ?? {}),
    pdfPageNumber: state.page,
    pdfScrollTop: state.scrollTop,
    ...(state.scale ? { pdfScale: state.scale } : {})
  }
}
