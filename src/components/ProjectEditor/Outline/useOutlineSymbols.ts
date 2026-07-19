/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import type { OutlineItem } from './types'
import { parseOutlineSymbols } from './outlineParser'
import { resolveOutlineParseSource } from './outlineParseSource'
import { truncateOutlineSymbols, type OutlineTruncation } from './outlineTruncation'
import { perfTrace } from '../../../utils/perf-trace'
import { PERF_TRACE_EVENT } from '../../../utils/perf-trace-names'

const DEBOUNCE_MS = 400

const EMPTY_TRUNCATION: OutlineTruncation = { totalCount: 0, keptCount: 0, truncated: false }

export interface UseOutlineSymbolsOptions {
  editor: import('monaco-editor').editor.IStandaloneCodeEditor | null
  filePath: string | null
  contentPath?: string | null
  content: string
  isVisible: boolean
}

export interface UseOutlineSymbolsResult {
  symbols: OutlineItem[]
  activeItem: OutlineItem | null
  isLoading: boolean
  truncation: OutlineTruncation
}

function findDeepestContaining(items: OutlineItem[], line: number): OutlineItem | null {
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i]
    if (line >= item.startLine && line <= item.endLine) {
      const childMatch = findDeepestContaining(item.children, line)
      return childMatch ?? item
    }
  }
  return null
}

function findNearestSymbolForLine(items: OutlineItem[], line: number): OutlineItem | null {
  let best: OutlineItem | null = null
  for (const item of items) {
    if (item.startLine <= line) {
      best = item
    }
  }
  if (!best) return null
  if (best.children.length > 0) {
    const childMatch = findNearestSymbolForLine(best.children, line)
    if (childMatch) return childMatch
  }
  return best
}

export function useOutlineSymbols({
  editor,
  filePath,
  contentPath,
  content,
  isVisible,
}: UseOutlineSymbolsOptions): UseOutlineSymbolsResult {
  const [symbols, setSymbols] = useState<OutlineItem[]>([])
  const [activeItem, setActiveItem] = useState<OutlineItem | null>(null)
  const [isLoading, setIsLoading] = useState(false)
  const [truncation, setTruncation] = useState<OutlineTruncation>(EMPTY_TRUNCATION)

  const tokenRef = useRef(0)
  const timerRef = useRef<number | null>(null)
  const symbolsRef = useRef<OutlineItem[]>([])
  const lastFilePathRef = useRef<string | null>(null)

  // Parse symbols with debounce
  const triggerParse = useCallback(() => {
    if (!isVisible || !filePath) {
      setSymbols([])
      symbolsRef.current = []
      setTruncation(EMPTY_TRUNCATION)
      setIsLoading(false)
      return
    }

    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current)
    }

    // Immediate parse on file switch
    const isFileSwitch = filePath !== lastFilePathRef.current
    lastFilePathRef.current = filePath

    const delay = isFileSwitch ? 0 : DEBOUNCE_MS

    setIsLoading(true)
    const currentToken = ++tokenRef.current

    timerRef.current = window.setTimeout(() => {
      timerRef.current = null
      const model = editor?.getModel() ?? null
      const source = resolveOutlineParseSource({
        filePath,
        contentPath: contentPath ?? filePath,
        content,
        model
      })
      if (!source.ready) {
        if (currentToken !== tokenRef.current) return
        setSymbols([])
        symbolsRef.current = []
        setTruncation(EMPTY_TRUNCATION)
        setIsLoading(true)
        return
      }

      void parseOutlineSymbols(
        source.content,
        filePath,
        source.model as import('monaco-editor').editor.ITextModel | null
      ).then((result) => {
        if (currentToken !== tokenRef.current) return
        const capped = truncateOutlineSymbols(result)
        if (capped.truncated) {
          perfTrace(PERF_TRACE_EVENT.RENDERER_PROJECT_EDITOR_OUTLINE_TRUNCATED, {
            ph: 'i',
            totalCount: capped.totalCount,
            keptCount: capped.keptCount,
            filePath: filePath.slice(-128)
          })
        }
        setSymbols(capped.items)
        symbolsRef.current = capped.items
        // Preserve identity when values are unchanged: a fresh object per
        // debounced reparse would re-render every truncation consumer on
        // every keystroke settle even though nothing changed.
        setTruncation((previous) =>
          previous.totalCount === capped.totalCount &&
          previous.keptCount === capped.keptCount &&
          previous.truncated === capped.truncated
            ? previous
            : { totalCount: capped.totalCount, keptCount: capped.keptCount, truncated: capped.truncated }
        )
        setIsLoading(false)
      })
    }, delay)
  }, [isVisible, filePath, contentPath, content, editor])

  // Keep a ref to the latest triggerParse so the model-content listener
  // always calls the current version without needing it as a dependency.
  const triggerParseRef = useRef(triggerParse)
  triggerParseRef.current = triggerParse

  // Trigger parse on content/file/visibility change
  useEffect(() => {
    triggerParse()
    return () => {
      if (timerRef.current !== null) {
        window.clearTimeout(timerRef.current)
        timerRef.current = null
      }
    }
  }, [triggerParse])

  // Re-parse when the editor model content changes (e.g., user deletes a heading).
  // This complements the `content` prop dependency which only updates on file
  // open/switch, not during live editing.
  useEffect(() => {
    if (!editor) return
    const disposable = editor.onDidChangeModelContent(() => {
      triggerParseRef.current()
    })
    return () => disposable.dispose()
  }, [editor])

  useEffect(() => {
    if (!editor) return
    const disposable = editor.onDidChangeModel(() => {
      triggerParseRef.current()
    })
    return () => disposable.dispose()
  }, [editor])

  // Reset on file switch
  useEffect(() => {
    setSymbols([])
    symbolsRef.current = []
    setActiveItem(null)
    setTruncation(EMPTY_TRUNCATION)
  }, [filePath])

  useEffect(() => {
    if (!isVisible) {
      setActiveItem(null)
    }
  }, [isVisible])

  // Cursor tracking follows explicit editor interaction.
  useEffect(() => {
    if (!editor || !isVisible) return

    const disposable = editor.onDidChangeCursorPosition((e) => {
      const line = e.position.lineNumber
      const match = findDeepestContaining(symbolsRef.current, line)
      setActiveItem(match)
    })

    // Initial sync
    const pos = editor.getPosition()
    if (pos) {
      const match = findDeepestContaining(symbolsRef.current, pos.lineNumber)
      setActiveItem(match)
    }

    return () => disposable.dispose()
  }, [editor, isVisible, symbols])

  // Refresh the active item after reparsing to avoid stale references.
  useEffect(() => {
    if (!editor || !isVisible || symbolsRef.current.length === 0) return
    const ranges = editor.getVisibleRanges()
    if (ranges.length === 0) return
    const topLine = ranges[0].startLineNumber
    const match = findNearestSymbolForLine(symbolsRef.current, topLine)
    setActiveItem(match)
  }, [editor, isVisible, symbols])

  // Scroll tracking keeps the outline aligned with the visible code region.
  useEffect(() => {
    if (!editor || !isVisible) return

    const disposable = editor.onDidScrollChange(() => {
      const ranges = editor.getVisibleRanges()
      if (ranges.length === 0) return
      const topLine = ranges[0].startLineNumber
      const match = findNearestSymbolForLine(symbolsRef.current, topLine)
      setActiveItem(match)
    })

    return () => disposable.dispose()
  }, [editor, isVisible, symbols])

  return { symbols, activeItem, isLoading, truncation }
}
