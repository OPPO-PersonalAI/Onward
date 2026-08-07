/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 *
 * Dialog for managing custom highlight labels: rename, recolor, delete.
 *
 * Scope is deliberate: only `hl-custom-*` labels are editable. The four
 * built-ins carry locale-driven names and act as the fallback palette, so
 * they are listed read-only for context. All mutations are palette-only
 * (matching the viewer's setLabels contract): existing highlights keep the
 * name and color stored in their own records — managing the palette never
 * rewrites a user's PDFs.
 */

import { useMemo, useState } from 'react'
import { useI18n } from '../../../i18n/useI18n'
import {
  deleteLabel,
  isCustomLabelId,
  recolorLabel,
  renameLabel,
  type HighlightLabel
} from './annotationListModel'

interface ManageLabelsDialogProps {
  /** Full effective palette (built-ins + custom), in display order. */
  labels: HighlightLabel[]
  /** Receives the next CUSTOM label list after any mutation. */
  onChange: (customLabels: HighlightLabel[]) => void
  onClose: () => void
}

const COLOR_CHOICES = [
  '#f2c14e',
  '#5aa9e6',
  '#7bd88f',
  '#e58fb2',
  '#c792ea',
  '#f78c6c',
  '#89ddff',
  '#ffcb6b'
]

export function ManageLabelsDialog({ labels, onChange, onClose }: ManageLabelsDialogProps) {
  const { t } = useI18n()
  const [editingId, setEditingId] = useState<string | null>(null)
  const [draftName, setDraftName] = useState('')
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null)

  const customLabels = useMemo(() => labels.filter((label) => isCustomLabelId(label.id)), [labels])
  const builtinLabels = useMemo(() => labels.filter((label) => !isCustomLabelId(label.id)), [labels])

  const commitCustom = (next: HighlightLabel[] | null) => {
    if (!next) return false
    onChange(next.filter((label) => isCustomLabelId(label.id)))
    return true
  }

  const commitRename = (id: string) => {
    if (commitTargetInvalid(id)) return
    if (commitCustom(renameLabel(labels, id, draftName))) {
      setEditingId(null)
    }
  }

  const commitTargetInvalid = (id: string) => editingId !== id

  const renameDraftValid = (id: string) =>
    renameLabel(labels, id, draftName) !== null

  return (
    <div
      className="pdf-annotation-dialog-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <div
        className="pdf-annotation-dialog pdf-annotation-manage-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="pdfManageLabelsTitle"
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.stopPropagation()
            if (editingId) setEditingId(null)
            else if (confirmDeleteId) setConfirmDeleteId(null)
            else onClose()
          }
        }}
      >
        <h2 id="pdfManageLabelsTitle">{t('projectEditor.pdfReader.annotations.manageLabelsTitle')}</h2>
        <p className="pdf-annotation-manage-hint">
          {t('projectEditor.pdfReader.annotations.manageLabelsHint')}
        </p>

        <ul className="pdf-annotation-manage-list">
          {builtinLabels.map((label) => (
            <li key={label.id} className="pdf-annotation-manage-row is-builtin">
              <span className="pdf-annotation-manage-dot" style={{ background: label.color }} />
              <span className="pdf-annotation-manage-name">{label.name}</span>
              <span className="pdf-annotation-manage-builtin-tag">
                {t('projectEditor.pdfReader.annotations.builtinLabel')}
              </span>
            </li>
          ))}
          {customLabels.map((label) => (
            <li key={label.id} className="pdf-annotation-manage-row" data-label-id={label.id}>
              <span className="pdf-annotation-manage-dot" style={{ background: label.color }} />
              {editingId === label.id ? (
                <input
                  className="pdf-annotation-manage-rename-input"
                  type="text"
                  value={draftName}
                  maxLength={40}
                  autoFocus
                  spellCheck={false}
                  aria-invalid={!renameDraftValid(label.id)}
                  onChange={(event) => setDraftName(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') {
                      event.preventDefault()
                      commitRename(label.id)
                    }
                  }}
                  onBlur={() => commitRename(label.id)}
                />
              ) : (
                <button
                  type="button"
                  className="pdf-annotation-manage-name is-editable"
                  title={t('projectEditor.pdfReader.annotations.renameLabel')}
                  onClick={() => {
                    setConfirmDeleteId(null)
                    setEditingId(label.id)
                    setDraftName(label.name)
                  }}
                >
                  {label.name}
                </button>
              )}
              <span className="pdf-annotation-color-choices is-inline" role="radiogroup">
                {COLOR_CHOICES.map((choice) => (
                  <button
                    key={choice}
                    type="button"
                    role="radio"
                    aria-checked={label.color === choice}
                    className={`pdf-annotation-color-choice is-small${label.color === choice ? ' selected' : ''}`}
                    style={{ background: choice }}
                    title={choice}
                    onClick={() => commitCustom(recolorLabel(labels, label.id, choice))}
                  />
                ))}
              </span>
              {confirmDeleteId === label.id ? (
                <span className="pdf-annotation-manage-confirm">
                  <span>{t('projectEditor.pdfReader.annotations.deleteLabelConfirm')}</span>
                  <button
                    type="button"
                    className="danger"
                    onClick={() => {
                      if (commitCustom(deleteLabel(labels, label.id))) setConfirmDeleteId(null)
                    }}
                  >
                    {t('projectEditor.pdfReader.annotations.deleteLabelYes')}
                  </button>
                  <button type="button" onClick={() => setConfirmDeleteId(null)}>
                    {t('projectEditor.pdfReader.cancel')}
                  </button>
                </span>
              ) : (
                <button
                  type="button"
                  className="pdf-annotation-manage-delete"
                  title={t('projectEditor.pdfReader.annotations.deleteLabel')}
                  onClick={() => {
                    setEditingId(null)
                    setConfirmDeleteId(label.id)
                  }}
                >
                  <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
                    <path d="M6 2h4l1 1h3v2H2V3h3l1-1zm-3 4h10l-1 8a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1L3 6z" />
                  </svg>
                </button>
              )}
            </li>
          ))}
          {customLabels.length === 0 && (
            <li className="pdf-annotation-manage-empty">
              {t('projectEditor.pdfReader.annotations.noCustomLabels')}
            </li>
          )}
        </ul>

        <div className="pdf-annotation-dialog-actions">
          <button type="button" className="primary" onClick={onClose}>
            {t('projectEditor.pdfReader.note.done')}
          </button>
        </div>
      </div>
    </div>
  )
}
