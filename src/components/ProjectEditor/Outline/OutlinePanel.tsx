/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useI18n } from '../../../i18n/useI18n'
import { trackFeatureUse } from '../../../telemetry/track-feature-use'
import type { OutlineItem } from './types'
import { OutlineSymbolKind } from './types'
import { countSymbols } from './outlineParser'
import { alignElementCenter } from '../utils/scrollCenter'
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

export function OutlinePanel({
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
    if (!initialScrollAppliedRef.current && typeof initial === 'number' && initial > 0) {
      diag.skippedInitial += 1
      diag.lastSkipReason = 'initial'
      return
    }
    const tree = treeRef.current
    const active = activeRef.current
    if (!tree || !active) {
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
    alignElementCenter(tree, active, { behavior: 'smooth' })
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
    let attempts = 0
    const targetScrollTop = Math.max(0, snapshot)
    const maxAttempts = 300

    const applyInitialScroll = () => {
      const tree = treeRef.current
      if (!tree) return

      const maxScrollTop = Math.max(0, tree.scrollHeight - tree.clientHeight)
      if (targetScrollTop > 0 && maxScrollTop <= 0) {
        attempts += 1
        if (attempts < maxAttempts) {
          frameId = requestAnimationFrame(applyInitialScroll)
        }
        return
      }

      const clampedTarget = Math.min(targetScrollTop, maxScrollTop)
      programmaticScrollUntilRef.current = performance.now() + PROGRAMMATIC_SCROLL_SETTLE_MS
      tree.scrollTop = clampedTarget
      lastUserScrollAtRef.current = performance.now()
      const isApplied = Math.abs(tree.scrollTop - clampedTarget) <= 2

      if (isApplied || attempts >= maxAttempts) {
        initialScrollAppliedRef.current = true
        onScrollCapture?.(tree.scrollTop)
        suppressActiveRevealUntilRef.current = performance.now() + INITIAL_SCROLL_ACTIVE_REVEAL_SUPPRESS_MS
        return
      }

      attempts += 1
      frameId = requestAnimationFrame(applyInitialScroll)
    }

    frameId = requestAnimationFrame(applyInitialScroll)
    return () => {
      if (frameId) {
        cancelAnimationFrame(frameId)
      }
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
      // Product telemetry: count each outline heading/symbol jump click.
      trackFeatureUse('outline')
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

  const renderItem = useCallback(
    (item: OutlineItem, parentKey: string, _index: number) => {
      const targetKey = item.target
        ? item.target.kind === 'pdf-page'
          ? `pdf:${item.target.page}`
          : `epub:${item.target.href}`
        : `ln:${item.startLine}`
      const key = `${parentKey}/${item.name}:${targetKey}`
      const hasChildren = item.children.length > 0
      const isCollapsed = collapsed.has(key)
      const matchesByTarget = (a: OutlineItem, b: OutlineItem): boolean => {
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
      const isActive =
        effectiveActiveItem !== null &&
        (item.target
          ? matchesByTarget(effectiveActiveItem, item)
          : effectiveActiveItem.startLine === item.startLine &&
            effectiveActiveItem.name === item.name)
      const icon = getIconInfo(item.kind)
      const indent = item.depth * 16

      return (
        <div key={key}>
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
          {hasChildren && !isCollapsed && (
            item.children.map((child, i) => renderItem(child, key, i))
          )}
        </div>
      )
    },
    [collapsed, effectiveActiveItem, handleItemClick, toggleCollapse]
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
      <div className="outline-panel-tree" ref={treeRef}>
        {!isLoading && filteredSymbols.length === 0 ? (
          <div className="outline-panel-empty">
            {normalizedFilter ? t('outlinePanel.empty.noMatch') : t('outlinePanel.empty.noSymbols')}
          </div>
        ) : (
          filteredSymbols.map((item, i) => renderItem(item, '', i))
        )}
      </div>
    </div>
  )
}
