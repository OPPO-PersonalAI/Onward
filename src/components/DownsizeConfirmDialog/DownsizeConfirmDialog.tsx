/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import { useI18n } from '../../i18n/useI18n'
import { useModalEscape } from '../../hooks/useModalEscape'
import { perfTrace } from '../../utils/perf-trace'
import { PERF_TRACE_EVENT } from '../../utils/perf-trace-names'
import './DownsizeConfirmDialog.css'

export interface DownsizeTerminalEntry {
  id: string
  /** Display position (1-based) — matches "Task N" labels in the grid. */
  position: number
  customName: string | null
  cwd: string | null
}

interface DownsizeConfirmDialogProps {
  open: boolean
  terminals: readonly DownsizeTerminalEntry[]
  requiredCount: number
  onConfirm: (keepIds: string[]) => void
  onCancel: () => void
}

/**
 * Format a cwd for compact display. Keeps last 2 path segments to avoid a
 * giant /Users/.../foo/bar/baz string in the dialog.
 */
function compactCwd(cwd: string | null): string {
  if (!cwd) return ''
  const parts = cwd.split(/[\\/]/).filter(Boolean)
  if (parts.length <= 2) return cwd
  return '…/' + parts.slice(-2).join('/')
}

export function DownsizeConfirmDialog({
  open,
  terminals,
  requiredCount,
  onConfirm,
  onCancel
}: DownsizeConfirmDialogProps) {
  const { t } = useI18n()
  // Default selection: first N (matches the legacy "drop tail" semantics so
  // muscle memory keeps working when users just hit Apply).
  const [selectedIds, setSelectedIds] = useState<string[]>(() =>
    terminals.slice(0, requiredCount).map(term => term.id)
  )

  // When the underlying terminal list changes (e.g. user removes a tab and
  // re-opens the dialog), reset the default selection.
  useEffect(() => {
    if (!open) return
    setSelectedIds(terminals.slice(0, requiredCount).map(term => term.id))
    perfTrace(PERF_TRACE_EVENT.RENDERER_DOWNSIZE_DIALOG_OPEN, {
      currentCount: terminals.length,
      requiredCount
    })
  }, [open, terminals, requiredCount])

  const toggle = useCallback((id: string) => {
    setSelectedIds(prev => {
      if (prev.includes(id)) return prev.filter(x => x !== id)
      if (prev.length >= requiredCount) {
        // Slot full — drop the earliest-selected, push the newest.
        return [...prev.slice(1), id]
      }
      return [...prev, id]
    })
  }, [requiredCount])

  // ESC safely cancels the downsize (unified modal dismiss); backdrop
  // clicks stay inert so the keep-selection cannot be lost by a stray click.
  useModalEscape(open, onCancel, 'downsize-confirm')

  const ordered = useMemo(() => {
    // Confirm callback receives the ids in the user-selected display order
    // (which matches the "Task N" sequence). This keeps Task numbering stable
    // across the resize.
    const set = new Set(selectedIds)
    return terminals.filter(term => set.has(term.id)).map(term => term.id)
  }, [selectedIds, terminals])

  if (!open) return null

  const canConfirm = ordered.length === requiredCount

  return createPortal(
    <div className="downsize-confirm-backdrop" role="presentation">
      <div className="downsize-confirm-dialog" role="dialog" aria-modal="true">
        <h2 className="downsize-confirm-title">{t('dialog.downsize.title')}</h2>
        <p className="downsize-confirm-body">{t('dialog.downsize.body', { count: requiredCount })}</p>
        <div className="downsize-confirm-list">
          {terminals.map(term => {
            const checked = selectedIds.includes(term.id)
            return (
              <label
                key={term.id}
                className={`downsize-confirm-row ${checked ? 'is-selected' : ''}`}
              >
                <input
                  type="checkbox"
                  checked={checked}
                  onChange={() => toggle(term.id)}
                />
                <span className="downsize-confirm-row-name">
                  Task {term.position}
                  {term.customName ? `: ${term.customName}` : ''}
                </span>
                <span className="downsize-confirm-row-cwd" title={term.cwd ?? ''}>
                  {term.cwd ? compactCwd(term.cwd) : t('dialog.downsize.cwdNone')}
                </span>
              </label>
            )
          })}
        </div>
        <div className="downsize-confirm-warning">{t('dialog.downsize.warning')}</div>
        <div className="downsize-confirm-footer">
          <span className="downsize-confirm-counter">
            {t('dialog.downsize.selection', { selected: selectedIds.length, required: requiredCount })}
          </span>
          <div className="downsize-confirm-actions">
            <button type="button" className="downsize-confirm-secondary" onClick={onCancel}>
              {t('dialog.downsize.cancel')}
            </button>
            <button
              type="button"
              className="downsize-confirm-primary"
              onClick={() => onConfirm(ordered)}
              disabled={!canConfirm}
            >
              {t('dialog.downsize.confirm')}
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body
  )
}
