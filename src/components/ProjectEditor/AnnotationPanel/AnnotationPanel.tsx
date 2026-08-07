/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 *
 * Annotation list for the PDF reader.
 *
 * Lives on the React host side rather than inside the viewer iframe (the
 * user's decision, 2026-07-28). The cost is that the highlight records have to
 * be mirrored across postMessage; the benefit is that the list reuses Onward's
 * context-menu conventions, i18n and theme tokens instead of growing a second
 * visual language inside the iframe.
 *
 * The panel is read-mostly: it renders records the viewer owns and asks the
 * viewer to act (jump, delete). It never mutates annotation state itself, so
 * there is exactly one source of truth for what a document's highlights are.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useI18n } from '../../../i18n/useI18n'
import type { PdfAnnotationSummary } from '../PdfReader'
import {
  ALL_LABELS,
  availableCopyActions,
  buildCopyText,
  buildLabelFilterOptions,
  filterAnnotations,
  isNoteExpanded,
  pruneNoteOverrides,
  shouldScrollToBottom,
  sortAnnotations,
  type AnnotationDensity,
  type AnnotationSortMode,
  type HighlightLabel
} from './annotationListModel'
import './AnnotationPanel.css'

interface AnnotationPanelProps {
  items: PdfAnnotationSummary[]
  labels: HighlightLabel[]
  sortMode: AnnotationSortMode
  onSortModeChange: (mode: AnnotationSortMode) => void
  density: AnnotationDensity
  onDensityChange: (density: AnnotationDensity) => void
  notesExpanded: boolean
  onNotesExpandedChange: (expanded: boolean) => void
  autoScroll: boolean
  onAutoScrollChange: (enabled: boolean) => void
  onJump: (annotationId: string) => void
  onDelete: (annotationId: string) => void
  onClose: () => void
  onAddLabel: () => void
  onManageLabels: () => void
}

/** Copy-menu icons. The project requires every context-menu action to carry a
 *  14x14 currentColor SVG, so they are inlined rather than imported. */
const ICON_COPY_HIGHLIGHT = (
  <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
    <path d="M3 2h7l3 3v9a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1zm6 1v3h3L9 3z" />
  </svg>
)
const ICON_COPY_NOTE = (
  <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
    <path d="M2 3h12v2H2V3zm0 4h12v2H2V7zm0 4h8v2H2v-2z" />
  </svg>
)
const ICON_COPY_BOTH = (
  <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
    <path d="M5 1h6a1 1 0 0 1 1 1v1h1a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1v-1H3a1 1 0 0 1-1-1V2a1 1 0 0 1 1-1h2zm0 2H3v9h1V4a1 1 0 0 1 1-1zm0 1v10h8V4H5z" />
  </svg>
)
const ICON_DELETE = (
  <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
    <path d="M6 2h4l1 1h3v2H2V3h3l1-1zm-3 4h10l-1 8a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1L3 6z" />
  </svg>
)

interface MenuState {
  annotationId: string
  x: number
  y: number
}

export function AnnotationPanel({
  items,
  labels,
  sortMode,
  onSortModeChange,
  density,
  onDensityChange,
  notesExpanded,
  onNotesExpandedChange,
  autoScroll,
  onAutoScrollChange,
  onJump,
  onDelete,
  onClose,
  onAddLabel,
  onManageLabels
}: AnnotationPanelProps) {
  const { t } = useI18n()
  const [labelFilter, setLabelFilter] = useState<string>(ALL_LABELS)
  const [noteOverrides, setNoteOverrides] = useState<Map<string, boolean>>(new Map())
  const [menu, setMenu] = useState<MenuState | null>(null)
  const [copyStatus, setCopyStatus] = useState<string | null>(null)
  const listRef = useRef<HTMLDivElement | null>(null)
  const previousCountRef = useRef(items.length)
  const copyStatusTimerRef = useRef<number | null>(null)

  // Per-entry expansion state is keyed by annotation id, so it survives
  // re-sorting, re-filtering and note edits. Pruning keeps the map from
  // growing across a long session.
  useEffect(() => {
    setNoteOverrides((current) => {
      const pruned = pruneNoteOverrides(current, items)
      return pruned.size === current.size ? current : pruned
    })
  }, [items])

  const visible = useMemo(
    () => sortAnnotations(filterAnnotations(items, labelFilter), sortMode),
    [items, labelFilter, sortMode]
  )

  const filterOptions = useMemo(() => buildLabelFilterOptions(items, labels), [items, labels])

  // A filter that no longer matches anything (its last annotation was deleted)
  // would leave the user staring at an empty list with no obvious cause.
  useEffect(() => {
    if (labelFilter === ALL_LABELS) return
    if (!filterOptions.some((option) => option.id === labelFilter)) {
      setLabelFilter(ALL_LABELS)
    }
  }, [filterOptions, labelFilter])

  useEffect(() => {
    const previous = previousCountRef.current
    previousCountRef.current = items.length
    if (!shouldScrollToBottom({ enabled: autoScroll, mode: sortMode, previousCount: previous, nextCount: items.length })) {
      return
    }
    const node = listRef.current
    if (node) node.scrollTop = node.scrollHeight
  }, [autoScroll, items.length, sortMode])

  useEffect(() => () => {
    if (copyStatusTimerRef.current !== null) window.clearTimeout(copyStatusTimerRef.current)
  }, [])

  const closeMenu = useCallback(() => setMenu(null), [])

  useEffect(() => {
    if (!menu) return
    const dismiss = () => closeMenu()
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation()
        closeMenu()
      }
    }
    window.addEventListener('mousedown', dismiss)
    window.addEventListener('keydown', onKey, true)
    return () => {
      window.removeEventListener('mousedown', dismiss)
      window.removeEventListener('keydown', onKey, true)
    }
  }, [closeMenu, menu])

  const flashCopyStatus = useCallback((message: string) => {
    setCopyStatus(message)
    if (copyStatusTimerRef.current !== null) window.clearTimeout(copyStatusTimerRef.current)
    copyStatusTimerRef.current = window.setTimeout(() => setCopyStatus(null), 1800)
  }, [])

  const handleCopy = useCallback(
    async (item: PdfAnnotationSummary, kind: 'highlight' | 'note' | 'both') => {
      closeMenu()
      const text = buildCopyText(item, kind)
      if (!text) return
      try {
        await navigator.clipboard.writeText(text)
        flashCopyStatus(t('projectEditor.pdfReader.annotations.copied'))
      } catch {
        flashCopyStatus(t('projectEditor.pdfReader.annotations.copyFailed'))
      }
    },
    [closeMenu, flashCopyStatus, t]
  )

  const menuItem = menu ? visible.find((item) => item.id === menu.annotationId) ?? null : null
  const menuActions = menuItem ? availableCopyActions(menuItem) : null

  return (
    <div className={`pdf-annotation-panel density-${density}`}>
      <div className="pdf-annotation-panel-header">
        <span className="pdf-annotation-panel-title">
          {t('projectEditor.pdfReader.annotations.title')}
          <span className="pdf-annotation-panel-count">{visible.length}</span>
        </span>
        <div className="pdf-annotation-panel-header-actions">
          <button
            type="button"
            className="pdf-annotation-panel-icon-btn"
            aria-pressed={notesExpanded}
            title={
              notesExpanded
                ? t('projectEditor.pdfReader.annotations.collapseNotes')
                : t('projectEditor.pdfReader.annotations.expandNotes')
            }
            onClick={() => {
              // Toggling the global default also clears per-entry overrides:
              // otherwise "expand all" would visibly skip the entries the user
              // had collapsed by hand, which reads as the button not working.
              setNoteOverrides(new Map())
              onNotesExpandedChange(!notesExpanded)
            }}
          >
            {notesExpanded ? '⌃' : '⌄'}
          </button>
          <button
            type="button"
            className="pdf-annotation-panel-icon-btn"
            title={t('projectEditor.pdfReader.annotations.close')}
            onClick={onClose}
          >
            ✕
          </button>
        </div>
      </div>

      <div className="pdf-annotation-panel-controls">
        <label className="pdf-annotation-control">
          <span>{t('projectEditor.pdfReader.annotations.sort')}</span>
          <select
            value={sortMode}
            onChange={(event) => onSortModeChange(event.target.value as AnnotationSortMode)}
          >
            <option value="created">{t('projectEditor.pdfReader.annotations.sortCreated')}</option>
            <option value="page">{t('projectEditor.pdfReader.annotations.sortPage')}</option>
          </select>
        </label>

        <label className="pdf-annotation-control">
          <span>{t('projectEditor.pdfReader.annotations.filter')}</span>
          <select value={labelFilter} onChange={(event) => setLabelFilter(event.target.value)}>
            <option value={ALL_LABELS}>{t('projectEditor.pdfReader.annotations.filterAll')}</option>
            {filterOptions.map((option) => (
              <option key={option.id} value={option.id}>
                {option.name} ({option.count})
              </option>
            ))}
          </select>
        </label>

        <label className="pdf-annotation-control">
          <span>{t('projectEditor.pdfReader.annotations.density')}</span>
          <select
            value={density}
            onChange={(event) => onDensityChange(event.target.value as AnnotationDensity)}
          >
            <option value="comfortable">{t('projectEditor.pdfReader.annotations.densityComfortable')}</option>
            <option value="compact">{t('projectEditor.pdfReader.annotations.densityCompact')}</option>
          </select>
        </label>

        <label className="pdf-annotation-control pdf-annotation-checkbox">
          <input
            type="checkbox"
            checked={autoScroll}
            onChange={(event) => onAutoScrollChange(event.target.checked)}
          />
          <span>{t('projectEditor.pdfReader.annotations.autoScroll')}</span>
        </label>
      </div>

      <div className="pdf-annotation-list" ref={listRef}>
        {visible.length === 0 ? (
          <div className="pdf-annotation-empty">
            {items.length === 0
              ? t('projectEditor.pdfReader.annotations.empty')
              : t('projectEditor.pdfReader.annotations.emptyFiltered')}
          </div>
        ) : (
          visible.map((item) => {
            const expanded = isNoteExpanded(item.id, notesExpanded, noteOverrides)
            const hasNote = Boolean(item.note.trim())
            return (
              <div
                key={item.id}
                className="pdf-annotation-item"
                onContextMenu={(event) => {
                  event.preventDefault()
                  setMenu({ annotationId: item.id, x: event.clientX, y: event.clientY })
                }}
              >
                <div className="pdf-annotation-item-head">
                  <span className="pdf-annotation-dot" style={{ background: item.color }} aria-hidden="true" />
                  <span className="pdf-annotation-label">{item.labelName}</span>
                  <span className="pdf-annotation-page">
                    {t('projectEditor.pdfReader.annotations.page').replace('{page}', String(item.page))}
                  </span>
                  <button
                    type="button"
                    className="pdf-annotation-menu-trigger"
                    aria-haspopup="menu"
                    title={t('projectEditor.pdfReader.annotations.actions')}
                    onClick={(event) => {
                      event.stopPropagation()
                      const rect = (event.currentTarget as HTMLElement).getBoundingClientRect()
                      setMenu({ annotationId: item.id, x: rect.left, y: rect.bottom + 4 })
                    }}
                  >
                    ⋯
                  </button>
                </div>

                <button
                  type="button"
                  className="pdf-annotation-snippet"
                  title={t('projectEditor.pdfReader.annotations.jump')}
                  onClick={() => onJump(item.id)}
                >
                  {item.textSnapshot || t('projectEditor.pdfReader.annotations.noText')}
                </button>

                {hasNote && (
                  <div className="pdf-annotation-note">
                    <button
                      type="button"
                      className="pdf-annotation-note-toggle"
                      aria-expanded={expanded}
                      onClick={() =>
                        setNoteOverrides((current) => {
                          const next = new Map(current)
                          next.set(item.id, !expanded)
                          return next
                        })
                      }
                    >
                      {expanded ? '▾' : '▸'} {t('projectEditor.pdfReader.annotations.note')}
                    </button>
                    {expanded && <div className="pdf-annotation-note-body">{item.note}</div>}
                  </div>
                )}
              </div>
            )
          })
        )}
      </div>

      <div className="pdf-annotation-panel-footer">
        <button type="button" className="pdf-annotation-add-label" onClick={onAddLabel}>
          + {t('projectEditor.pdfReader.annotations.addLabel')}
        </button>
        <button type="button" className="pdf-annotation-manage-labels" onClick={onManageLabels}>
          {t('projectEditor.pdfReader.annotations.manageLabels')}
        </button>
      </div>

      {copyStatus && (
        <div className="pdf-annotation-copy-status" role="status" aria-live="polite">
          {copyStatus}
        </div>
      )}

      {menu && menuItem && menuActions && (
        <div
          className="pdf-annotation-context-menu"
          role="menu"
          style={{ left: menu.x, top: menu.y }}
          onMouseDown={(event) => event.stopPropagation()}
        >
          <button
            type="button"
            role="menuitem"
            disabled={!menuActions.highlight}
            onClick={() => void handleCopy(menuItem, 'highlight')}
          >
            {ICON_COPY_HIGHLIGHT}
            <span>{t('projectEditor.pdfReader.annotations.copyHighlight')}</span>
          </button>
          <button
            type="button"
            role="menuitem"
            disabled={!menuActions.note}
            onClick={() => void handleCopy(menuItem, 'note')}
          >
            {ICON_COPY_NOTE}
            <span>{t('projectEditor.pdfReader.annotations.copyNote')}</span>
          </button>
          <button
            type="button"
            role="menuitem"
            disabled={!menuActions.both}
            onClick={() => void handleCopy(menuItem, 'both')}
          >
            {ICON_COPY_BOTH}
            <span>{t('projectEditor.pdfReader.annotations.copyBoth')}</span>
          </button>
          <div className="pdf-annotation-context-separator" />
          <button
            type="button"
            role="menuitem"
            className="danger"
            onClick={() => {
              closeMenu()
              onDelete(menuItem.id)
            }}
          >
            {ICON_DELETE}
            <span>{t('projectEditor.pdfReader.annotations.delete')}</span>
          </button>
        </div>
      )}
    </div>
  )
}
