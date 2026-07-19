/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useI18n } from '../../../i18n/useI18n'
import type { OutlineItem } from './types'
import { OutlineSymbolKind } from './types'
import { countSymbols } from './outlineParser'
import { alignElementCenter } from '../utils/scrollCenter'
import type { OutlineTruncation } from './outlineTruncation'
import {
  OUTLINE_VIRTUALIZE_THRESHOLD,
  OUTLINE_VIRTUAL_ROW_HEIGHT,
  computeOutlineWindow,
  centerScrollTopForIndex,
  flattenVisibleOutline,
  outlineItemKey
} from './outlineVirtualization'
import { perfTrace } from '../../../utils/perf-trace'
import { PERF_TRACE_EVENT } from '../../../utils/perf-trace-names'
import './OutlinePanel.css'

export type OutlineTarget = 'editor' | 'preview'

interface OutlinePanelProps {
  symbols: OutlineItem[]
  activeItem: OutlineItem | null
  isLoading: boolean
  filePath: string | null
  editor: import('monaco-editor').editor.IStandaloneCodeEditor | null
  isMarkdown?: boolean
  previewRef?: React.RefObject<HTMLDivElement | null>
  outlineTarget?: OutlineTarget
  isEditorVisible?: boolean
  isPreviewVisible?: boolean
  onOutlineTargetChange?: (target: OutlineTarget) => void
  previewActiveSlug?: string | null
  onScrollCapture?: (scrollTop: number) => void
  initialScrollTop?: number
  /** Override for non-text readers (PDF / EPUB). When set, takes precedence
   * over the default editor cursor jump for items that carry a `target`. */
  onItemNavigate?: (item: OutlineItem) => void
  /** Parse-time cap info; when truncated, the header shows a kept/total hint. */
  truncation?: OutlineTruncation
}

const FILTER_THRESHOLD = 8
// Brief window after the outline's own scroll restoration during which we
// don't re-center, so the restored scroll position is visible for a beat
// before any active-item update smooth-scrolls away from it.
const INITIAL_SCROLL_ACTIVE_REVEAL_SUPPRESS_MS = 500
const USER_SCROLL_PAUSE_MS = 3000
const PROGRAMMATIC_SCROLL_SETTLE_MS = 1000

function headingSlug(text: string): string {
  return text
    .toLowerCase()
    .replace(/<[^>]*>/g, '')
    .replace(/&[^;]+;/g, '')
    .trim()
    .replace(/[^\p{L}\p{N}\s-]/gu, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
}

function getIconInfo(kind: OutlineSymbolKind): { label: string; className: string } {
  switch (kind) {
    case OutlineSymbolKind.Class:
      return { label: 'C', className: 'kind-class' }
    case OutlineSymbolKind.Interface:
      return { label: 'I', className: 'kind-interface' }
    case OutlineSymbolKind.Function:
      return { label: 'f', className: 'kind-function' }
    case OutlineSymbolKind.Method:
      return { label: 'm', className: 'kind-method' }
    case OutlineSymbolKind.Constructor:
      return { label: 'c', className: 'kind-constructor' }
    case OutlineSymbolKind.Variable:
      return { label: 'v', className: 'kind-variable' }
    case OutlineSymbolKind.Property:
      return { label: 'p', className: 'kind-property' }
    case OutlineSymbolKind.Field:
      return { label: 'f', className: 'kind-field' }
    case OutlineSymbolKind.Constant:
      return { label: 'K', className: 'kind-constant' }
    case OutlineSymbolKind.Enum:
      return { label: 'E', className: 'kind-enum' }
    case OutlineSymbolKind.EnumMember:
      return { label: 'e', className: 'kind-enum-member' }
    case OutlineSymbolKind.Struct:
      return { label: 'S', className: 'kind-struct' }
    case OutlineSymbolKind.Namespace:
      return { label: 'N', className: 'kind-namespace' }
    case OutlineSymbolKind.Module:
      return { label: 'M', className: 'kind-module' }
    case OutlineSymbolKind.Package:
      return { label: 'P', className: 'kind-package' }
    case OutlineSymbolKind.Key:
      return { label: 'K', className: 'kind-key' }
    case OutlineSymbolKind.Object:
      return { label: 'O', className: 'kind-object' }
    case OutlineSymbolKind.Heading1:
    case OutlineSymbolKind.Heading2:
    case OutlineSymbolKind.Heading3:
    case OutlineSymbolKind.Heading4:
    case OutlineSymbolKind.Heading5:
    case OutlineSymbolKind.Heading6:
      return { label: 'H', className: 'kind-heading' }
    default:
      return { label: '·', className: 'kind-other' }
  }
}

function matchesByTarget(a: OutlineItem, b: OutlineItem): boolean {
  if (!a.target || !b.target) return false
  if (a.target.kind !== b.target.kind) return false
  if (a.target.kind === 'pdf-page' && b.target.kind === 'pdf-page') {
    return a.target.page === b.target.page
  }
  if (a.target.kind === 'epub-href' && b.target.kind === 'epub-href') {
    return a.target.href === b.target.href
  }
  return false
}

function matchesFilter(item: OutlineItem, query: string): boolean {
  if (item.name.toLowerCase().includes(query)) return true
  return item.children.some((child) => matchesFilter(child, query))
}

function filterItems(items: OutlineItem[], query: string): OutlineItem[] {
  if (!query) return items
  return items
    .filter((item) => matchesFilter(item, query))
    .map((item) => ({
      ...item,
      children: filterItems(item.children, query),
    }))
}

function collectHeadings(items: OutlineItem[]): OutlineItem[] {
  const result: OutlineItem[] = []
  const walk = (list: OutlineItem[]) => {
    for (const item of list) {
      if (item.kind >= OutlineSymbolKind.Heading1 && item.kind <= OutlineSymbolKind.Heading6) {
        result.push(item)
      }
      if (item.children.length > 0) {
        walk(item.children)
      }
    }
  }
  walk(items)
  return result
}

function buildSlugMap(allHeadings: OutlineItem[]): Map<OutlineItem, string> {
  const slugCounts = new Map<string, number>()
  const map = new Map<OutlineItem, string>()
  for (const heading of allHeadings) {
    let slug = headingSlug(heading.name)
    const count = slugCounts.get(slug) ?? 0
    slugCounts.set(slug, count + 1)
    if (count > 0) {
      slug = `${slug}-${count}`
    }
    map.set(heading, slug)
  }
  return map
}

function OutlinePanelImpl({
  symbols,
  activeItem,
  isLoading,
  filePath,
  editor,
  isMarkdown = false,
  previewRef,
  outlineTarget = 'editor',
  isEditorVisible = true,
  isPreviewVisible = false,
  onOutlineTargetChange,
  previewActiveSlug,
  onScrollCapture,
  initialScrollTop,
  onItemNavigate,
  truncation,
}: OutlinePanelProps) {
  const { t } = useI18n()
  const [filter, setFilter] = useState('')
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  const filterInputRef = useRef<HTMLInputElement>(null)
  const activeRef = useRef<HTMLDivElement>(null)
  const treeRef = useRef<HTMLDivElement>(null)
  const initialScrollAppliedRef = useRef(false)
  const suppressActiveRevealUntilRef = useRef<number>(
    typeof initialScrollTop === 'number' ? Number.POSITIVE_INFINITY : 0
  )
  // Capture the initial scroll target once per file switch. `initialScrollTop`
  // is re-derived by the parent on every render (it reads from a live map),
  // so we must not let effects react to every change — otherwise every
  // user-driven scroll is immediately "restored" back to the saved value.
  const initialScrollTargetRef = useRef<number | undefined>(initialScrollTop)
  const lastUserScrollAtRef = useRef<number>(0)
  const programmaticScrollUntilRef = useRef<number>(0)

  const totalCount = useMemo(() => countSymbols(symbols), [symbols])
  const showFilter = totalCount > FILTER_THRESHOLD

  const normalizedFilter = filter.trim().toLowerCase()
  const filteredSymbols = useMemo(
    () => filterItems(symbols, normalizedFilter),
    [symbols, normalizedFilter]
  )

  // Windowed rendering for pathological outlines (e.g. Monaco's HTML symbol
  // provider emits one symbol per DOM element — 40k+ for a large HTML file).
  // Small outlines keep the fully-materialised recursive DOM path untouched.
  const flatRows = useMemo(
    () => flattenVisibleOutline(filteredSymbols, collapsed),
    [filteredSymbols, collapsed]
  )
  const isVirtualized = flatRows.length > OUTLINE_VIRTUALIZE_THRESHOLD
  const [virtualScrollTop, setVirtualScrollTop] = useState(0)
  const [viewportHeight, setViewportHeight] = useState(0)
  const isVirtualizedRef = useRef(isVirtualized)
  isVirtualizedRef.current = isVirtualized

  useEffect(() => {
    if (!isVirtualized) return
    const tree = treeRef.current
    if (!tree) return
    setVirtualScrollTop(tree.scrollTop)
    setViewportHeight(tree.clientHeight)
    const handleVirtualScroll = () => setVirtualScrollTop(tree.scrollTop)
    const resizeObserver = new ResizeObserver(() => setViewportHeight(tree.clientHeight))
    tree.addEventListener('scroll', handleVirtualScroll, { passive: true })
    resizeObserver.observe(tree)
    return () => {
      tree.removeEventListener('scroll', handleVirtualScroll)
      resizeObserver.disconnect()
    }
  }, [isVirtualized, filePath])

  const lastVirtualizedModeRef = useRef<boolean | null>(null)
  useEffect(() => {
    if (flatRows.length === 0) return
    if (lastVirtualizedModeRef.current === isVirtualized) return
    // The common small-outline case never virtualizes; only mode FLIPS (and
    // the first genuinely-virtualized mount) are diagnostic signal.
    if (lastVirtualizedModeRef.current === null && !isVirtualized) {
      lastVirtualizedModeRef.current = false
      return
    }
    lastVirtualizedModeRef.current = isVirtualized
    perfTrace(PERF_TRACE_EVENT.RENDERER_PROJECT_EDITOR_OUTLINE_VIRTUALIZATION, {
      ph: 'i',
      rowCount: flatRows.length,
      virtualized: isVirtualized
    })
  }, [isVirtualized, flatRows.length])

  const slugMap = useMemo(() => {
    if (!isMarkdown) return new Map<OutlineItem, string>()
    return buildSlugMap(collectHeadings(symbols))
  }, [isMarkdown, symbols])

  const effectiveOutlineTarget = useMemo<OutlineTarget>(() => {
    if (!isMarkdown) return 'editor'
    if (isPreviewVisible && !isEditorVisible) return 'preview'
    if (isEditorVisible && !isPreviewVisible) return 'editor'
    return outlineTarget
  }, [isEditorVisible, isMarkdown, isPreviewVisible, outlineTarget])

  const isOutlineTargetLocked = useMemo(() => {
    if (!isMarkdown) return false
    return isPreviewVisible !== isEditorVisible
  }, [isEditorVisible, isMarkdown, isPreviewVisible])

  const reverseSlugMap = useMemo(() => {
    const map = new Map<string, OutlineItem>()
    for (const [item, slug] of slugMap.entries()) {
      map.set(slug, item)
    }
    return map
  }, [slugMap])

  const effectiveActiveItem = useMemo(() => {
    if (isMarkdown && effectiveOutlineTarget === 'preview' && previewActiveSlug) {
      return reverseSlugMap.get(previewActiveSlug) ?? null
    }
    return activeItem
  }, [activeItem, effectiveOutlineTarget, isMarkdown, previewActiveSlug, reverseSlugMap])

  const isActiveOutlineItem = useCallback((item: OutlineItem): boolean => {
    if (effectiveActiveItem === null) return false
    if (item.target) return matchesByTarget(effectiveActiveItem, item)
    return (
      effectiveActiveItem.startLine === item.startLine &&
      effectiveActiveItem.name === item.name
    )
  }, [effectiveActiveItem])

  const activeFlatIndex = useMemo(() => {
    if (!isVirtualized || effectiveActiveItem === null) return -1
    return flatRows.findIndex((row) => isActiveOutlineItem(row.item))
  }, [isVirtualized, effectiveActiveItem, flatRows, isActiveOutlineItem])
  const activeFlatIndexRef = useRef(activeFlatIndex)
  activeFlatIndexRef.current = activeFlatIndex
  const flatRowCountRef = useRef(flatRows.length)
  flatRowCountRef.current = flatRows.length

  // Reset filter on file switch
  useEffect(() => {
    setFilter('')
    setCollapsed(new Set())
  }, [filePath])

  // Smooth-center active item into the middle band of the outline panel
  // when the highlighted heading / symbol changes. Pauses while the user is
  // interacting with the outline themselves (3 s after the last user scroll).
  useEffect(() => {
    const diag = ((window as unknown) as { __onwardOutlineAutoCenterDiag?: {
      effectFires: number; skippedInitial: number; skippedSuppress: number;
      skippedUserScroll: number; skippedNoActive: number; scrolled: number;
      lastTriggerName: string | null; lastSkipReason: string | null
    } }).__onwardOutlineAutoCenterDiag ??= {
      effectFires: 0, skippedInitial: 0, skippedSuppress: 0,
      skippedUserScroll: 0, skippedNoActive: 0, scrolled: 0,
      lastTriggerName: null, lastSkipReason: null
    }
    diag.effectFires += 1
    diag.lastTriggerName = effectiveActiveItem?.name ?? null
    const initial = initialScrollTargetRef.current
    // A pending initial-scroll restore must win over active-item centering.
    // The snapshot ref alone is not enough: the saved scrollTop can arrive
    // LATE (the parent's scope key resolves asynchronously, so the first
    // post-switch renders read a map miss). Consulting the live prop closes
    // that window — otherwise the smooth centering animation drags the tree
    // to the first active item and its intermediate frames get captured as
    // the file's scroll memory, destroying the saved position.
    const pendingInitialFromProp = typeof initialScrollTop === 'number' && initialScrollTop > 0
    if (
      !initialScrollAppliedRef.current &&
      ((typeof initial === 'number' && initial > 0) || pendingInitialFromProp)
    ) {
      diag.skippedInitial += 1
      diag.lastSkipReason = 'initial'
      return
    }
    const tree = treeRef.current
    const active = activeRef.current
    const virtualized = isVirtualizedRef.current
    if (!tree || (!virtualized && !active) || (virtualized && activeFlatIndexRef.current < 0)) {
      diag.skippedNoActive += 1
      diag.lastSkipReason = 'no-active-ref'
      return
    }
    const now = performance.now()
    if (now < suppressActiveRevealUntilRef.current) {
      diag.skippedSuppress += 1
      diag.lastSkipReason = 'suppress-window'
      return
    }
    if (now - lastUserScrollAtRef.current < USER_SCROLL_PAUSE_MS) {
      diag.skippedUserScroll += 1
      diag.lastSkipReason = 'user-scroll-pause'
      return
    }
    programmaticScrollUntilRef.current = now + PROGRAMMATIC_SCROLL_SETTLE_MS
    diag.scrolled += 1
    diag.lastSkipReason = null
    if (virtualized) {
      // The active row may be outside the rendered window; center it by row
      // index math instead of via the (possibly unmounted) DOM node.
      tree.scrollTo({
        top: centerScrollTopForIndex(activeFlatIndexRef.current, tree.clientHeight, flatRowCountRef.current),
        behavior: 'smooth'
      })
      return
    }
    alignElementCenter(tree, active!, { behavior: 'smooth' })
  }, [effectiveActiveItem])

  useEffect(() => {
    const tree = treeRef.current
    if (!tree) return
    const handleScroll = () => {
      if (performance.now() >= programmaticScrollUntilRef.current) {
        lastUserScrollAtRef.current = performance.now()
      }
      const initialRestorePending =
        !initialScrollAppliedRef.current &&
        typeof initialScrollTargetRef.current === 'number' &&
        initialScrollTargetRef.current > 0
      if (initialRestorePending) return
      onScrollCapture?.(tree.scrollTop)
    }
    tree.addEventListener('scroll', handleScroll, { passive: true })
    return () => tree.removeEventListener('scroll', handleScroll)
  }, [onScrollCapture])

  useEffect(() => {
    // Snapshot the currently-exposed initialScrollTop as the one-shot target
    // for this file; ignore subsequent `initialScrollTop` prop churn caused
    // by parent re-renders reading from a live scroll map.
    initialScrollTargetRef.current = initialScrollTop
    initialScrollAppliedRef.current = false
    suppressActiveRevealUntilRef.current =
      typeof initialScrollTop === 'number' ? Number.POSITIVE_INFINITY : 0
    lastUserScrollAtRef.current = 0
    programmaticScrollUntilRef.current = 0
    // initialScrollTop intentionally excluded from deps; see comment above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filePath])

  useEffect(() => {
    if (initialScrollAppliedRef.current) return
    if (
      typeof initialScrollTargetRef.current !== 'number' &&
      typeof initialScrollTop === 'number'
    ) {
      initialScrollTargetRef.current = initialScrollTop
      suppressActiveRevealUntilRef.current = Number.POSITIVE_INFINITY
    }
    const snapshot = initialScrollTargetRef.current
    if (typeof snapshot !== 'number') return
    if (!treeRef.current || symbols.length === 0) return
    let frameId = 0
    let timerId = 0
    let attempts = 0
    let done = false
    const targetScrollTop = Math.max(0, snapshot)
    const maxAttempts = 300

    // Occlusion-proof retry: rAF is throttled to ~1Hz (or paused entirely)
    // while the window is occluded / on a hidden Space, which starved this
    // loop for minutes and made saved positions appear "lost". Race each rAF
    // against a timer so the restore still progresses without frames.
    const scheduleNextAttempt = () => {
      frameId = requestAnimationFrame(applyInitialScroll)
      timerId = window.setTimeout(applyInitialScroll, 120)
    }
    const cancelScheduled = () => {
      if (frameId) cancelAnimationFrame(frameId)
      if (timerId) window.clearTimeout(timerId)
      frameId = 0
      timerId = 0
    }

    function applyInitialScroll() {
      if (done) return
      cancelScheduled()
      const tree = treeRef.current
      if (!tree) return

      const maxScrollTop = Math.max(0, tree.scrollHeight - tree.clientHeight)
      if (targetScrollTop > 0 && maxScrollTop <= 0) {
        attempts += 1
        if (attempts < maxAttempts) {
          scheduleNextAttempt()
        }
        return
      }

      const clampedTarget = Math.min(targetScrollTop, maxScrollTop)
      programmaticScrollUntilRef.current = performance.now() + PROGRAMMATIC_SCROLL_SETTLE_MS
      tree.scrollTop = clampedTarget
      lastUserScrollAtRef.current = performance.now()
      const isApplied = Math.abs(tree.scrollTop - clampedTarget) <= 2

      if (isApplied || attempts >= maxAttempts) {
        done = true
        initialScrollAppliedRef.current = true
        onScrollCapture?.(tree.scrollTop)
        suppressActiveRevealUntilRef.current = performance.now() + INITIAL_SCROLL_ACTIVE_REVEAL_SUPPRESS_MS
        return
      }

      attempts += 1
      scheduleNextAttempt()
    }

    scheduleNextAttempt()
    return () => {
      done = true
      cancelScheduled()
    }
  }, [filePath, initialScrollTop, onScrollCapture, symbols.length])

  const scrollPreviewToHeading = useCallback((item: OutlineItem) => {
    const container = previewRef?.current
    if (!container) return false
    const slug = slugMap.get(item)
    if (!slug) return false
    const target = container.querySelector(`#${CSS.escape(slug)}`) as HTMLElement | null
    if (!target) return false
    const containerRect = container.getBoundingClientRect()
    const targetRect = target.getBoundingClientRect()
    const offsetTop = targetRect.top - containerRect.top + container.scrollTop
    container.scrollTop = offsetTop
    return true
  }, [previewRef, slugMap])

  const handleItemClick = useCallback(
    (item: OutlineItem) => {
      if (item.target && onItemNavigate) {
        onItemNavigate(item)
        return
      }
      const isHeading = item.kind >= OutlineSymbolKind.Heading1 && item.kind <= OutlineSymbolKind.Heading6
      if (isMarkdown && effectiveOutlineTarget === 'preview' && isHeading && scrollPreviewToHeading(item)) {
        return
      }
      if (!editor) return
      editor.setPosition({ lineNumber: item.startLine, column: item.startColumn })
      editor.revealLineInCenter(item.startLine)
      editor.focus()
    },
    [editor, effectiveOutlineTarget, isMarkdown, onItemNavigate, scrollPreviewToHeading]
  )

  const handleOutlineTargetButtonClick = useCallback(
    (target: OutlineTarget) => {
      if (!onOutlineTargetChange) return
      if (isOutlineTargetLocked) return
      onOutlineTargetChange(target)
    },
    [isOutlineTargetLocked, onOutlineTargetChange]
  )

  const toggleCollapse = useCallback((key: string, e: React.MouseEvent) => {
    e.stopPropagation()
    setCollapsed((prev) => {
      const next = new Set(prev)
      if (next.has(key)) {
        next.delete(key)
      } else {
        next.add(key)
      }
      return next
    })
  }, [])

  const handleFilterKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        if (filter) {
          setFilter('')
        } else {
          editor?.focus()
        }
      }
    },
    [filter, editor]
  )

  const renderRowInner = useCallback(
    (item: OutlineItem, key: string, hasChildren: boolean, isCollapsed: boolean) => {
      const isActive = isActiveOutlineItem(item)
      const icon = getIconInfo(item.kind)
      const indent = item.depth * 16

      return (
        <div
          ref={isActive ? activeRef : undefined}
          className={`outline-panel-item ${isActive ? 'active' : ''}`}
          style={{ paddingLeft: 10 + indent }}
          onClick={() => handleItemClick(item)}
        >
          {hasChildren ? (
            <span
              className={`outline-panel-item-toggle ${isCollapsed ? 'collapsed' : ''}`}
              onClick={(e) => toggleCollapse(key, e)}
            >
              ▾
            </span>
          ) : (
            <span className="outline-panel-item-spacer" />
          )}
          <span className={`outline-panel-item-icon ${icon.className}`}>
            {icon.label}
          </span>
          <span className="outline-panel-item-name">{item.name}</span>
          {item.detail && (
            <span className="outline-panel-item-detail">{item.detail}</span>
          )}
        </div>
      )
    },
    [isActiveOutlineItem, handleItemClick, toggleCollapse]
  )

  const renderItem = useCallback(
    (item: OutlineItem, parentKey: string, _index: number) => {
      const key = outlineItemKey(item, parentKey)
      const hasChildren = item.children.length > 0
      const isCollapsed = collapsed.has(key)

      return (
        <div key={key}>
          {renderRowInner(item, key, hasChildren, isCollapsed)}
          {hasChildren && !isCollapsed && (
            item.children.map((child, i) => renderItem(child, key, i))
          )}
        </div>
      )
    },
    [collapsed, renderRowInner]
  )

  if (!filePath) {
    return (
      <div className="outline-panel">
        <div className="outline-panel-header">
          <span className="outline-panel-title">{t('outlinePanel.title')}</span>
        </div>
        <div className="outline-panel-empty">{t('outlinePanel.empty.selectFile')}</div>
      </div>
    )
  }

  return (
    <div className="outline-panel">
      <div className="outline-panel-header">
        <span className="outline-panel-title">{t('outlinePanel.title')}</span>
        {isLoading && <span className="outline-panel-loading">{t('outlinePanel.loading')}</span>}
        {truncation?.truncated && (
          <span
            className="outline-panel-truncated"
            title={t('outlinePanel.truncated.tooltip', {
              kept: String(truncation.keptCount),
              total: String(truncation.totalCount)
            })}
          >
            {t('outlinePanel.truncated', {
              kept: String(truncation.keptCount),
              total: String(truncation.totalCount)
            })}
          </span>
        )}
      </div>
      {isMarkdown && onOutlineTargetChange && (
        <div className="outline-panel-target-bar">
          <span className="outline-panel-target-label">{t('outlinePanel.target.label')}</span>
          <div className="outline-panel-target-seg" data-active={effectiveOutlineTarget}>
            <span className="outline-panel-target-indicator" />
            <button
              type="button"
              className={`outline-panel-target-btn${effectiveOutlineTarget === 'editor' ? ' active' : ''}`}
              onClick={() => handleOutlineTargetButtonClick('editor')}
              disabled={isOutlineTargetLocked}
              title={t('outlinePanel.target.editor.tooltip')}
            >
              {t('outlinePanel.target.editor')}
            </button>
            <button
              type="button"
              className={`outline-panel-target-btn${effectiveOutlineTarget === 'preview' ? ' active' : ''}`}
              onClick={() => handleOutlineTargetButtonClick('preview')}
              disabled={isOutlineTargetLocked}
              title={t('outlinePanel.target.preview.tooltip')}
            >
              {t('outlinePanel.target.preview')}
            </button>
          </div>
        </div>
      )}
      {showFilter && (
        <div className="outline-panel-filter">
          <input
            ref={filterInputRef}
            className="outline-panel-filter-input"
            value={filter}
            placeholder={t('outlinePanel.filterPlaceholder')}
            onChange={(e) => setFilter(e.target.value)}
            onKeyDown={handleFilterKeyDown}
          />
        </div>
      )}
      <div className={`outline-panel-tree${isVirtualized ? ' virtualized' : ''}`} ref={treeRef}>
        {!isLoading && filteredSymbols.length === 0 ? (
          <div className="outline-panel-empty">
            {normalizedFilter ? t('outlinePanel.empty.noMatch') : t('outlinePanel.empty.noSymbols')}
          </div>
        ) : isVirtualized ? (
          (() => {
            const rowWindow = computeOutlineWindow(
              virtualScrollTop,
              viewportHeight || 600,
              flatRows.length
            )
            return (
              <div
                className="outline-panel-virtual-spacer"
                style={{ height: rowWindow.totalHeight }}
              >
                {flatRows.slice(rowWindow.startIndex, rowWindow.endIndex).map((row, i) => (
                  <div
                    key={row.key}
                    className="outline-panel-virtual-row"
                    style={{ top: (rowWindow.startIndex + i) * OUTLINE_VIRTUAL_ROW_HEIGHT }}
                  >
                    {renderRowInner(row.item, row.key, row.hasChildren, row.isCollapsed)}
                  </div>
                ))}
              </div>
            )
          })()
        ) : (
          filteredSymbols.map((item, i) => renderItem(item, '', i))
        )}
      </div>
    </div>
  )
}

export const OutlinePanel = memo(OutlinePanelImpl)
