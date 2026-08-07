/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 *
 * Dialog for adding a highlight label.
 *
 * Replaces the reference project's two chained `window.prompt` calls. Not a
 * cosmetic upgrade: `prompt` blocks the renderer, cannot validate as you type,
 * has no colour picker, and in Electron looks nothing like the rest of the
 * app. It also gave no way to reject a duplicate name, which matters because
 * the label name is written into every PDF the label is used in.
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import { useI18n } from '../../../i18n/useI18n'
import { normalizeNewLabel, type HighlightLabel } from './annotationListModel'

interface AddLabelDialogProps {
  existing: HighlightLabel[]
  onCancel: () => void
  onConfirm: (label: HighlightLabel) => void
}

/** Starting colours. Distinct hues rather than a gradient, so two labels are
 *  told apart at a glance in a page margin, not just side by side. */
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

export function AddLabelDialog({ existing, onCancel, onConfirm }: AddLabelDialogProps) {
  const { t } = useI18n()
  const [name, setName] = useState('')
  const [color, setColor] = useState(() => {
    const unused = COLOR_CHOICES.find((choice) => !existing.some((label) => label.color === choice))
    return unused ?? COLOR_CHOICES[0]
  })
  const inputRef = useRef<HTMLInputElement | null>(null)

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  // Validate as the user types so the confirm button's state explains itself,
  // rather than failing only after they commit.
  const candidate = useMemo(
    () => normalizeNewLabel(name, color, existing, String(Date.now().toString(36))),
    [color, existing, name]
  )
  const duplicate = useMemo(
    () =>
      Boolean(name.trim()) &&
      existing.some((label) => label.name.trim().toLowerCase() === name.trim().toLowerCase()),
    [existing, name]
  )

  const submit = () => {
    if (candidate) onConfirm(candidate)
  }

  return (
    <div
      className="pdf-annotation-dialog-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onCancel()
      }}
    >
      <div
        className="pdf-annotation-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="pdfAddLabelTitle"
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.stopPropagation()
            onCancel()
          }
          if (event.key === 'Enter' && candidate) {
            event.preventDefault()
            submit()
          }
        }}
      >
        <h2 id="pdfAddLabelTitle">{t('projectEditor.pdfReader.annotations.addLabelTitle')}</h2>

        <label className="pdf-annotation-dialog-field">
          <span>{t('projectEditor.pdfReader.annotations.labelName')}</span>
          <input
            ref={inputRef}
            type="text"
            value={name}
            maxLength={40}
            spellCheck={false}
            onChange={(event) => setName(event.target.value)}
            placeholder={t('projectEditor.pdfReader.annotations.labelNamePlaceholder')}
          />
        </label>

        <div className="pdf-annotation-dialog-field">
          <span>{t('projectEditor.pdfReader.annotations.labelColor')}</span>
          <div className="pdf-annotation-color-choices" role="radiogroup">
            {COLOR_CHOICES.map((choice) => (
              <button
                key={choice}
                type="button"
                role="radio"
                aria-checked={color === choice}
                className={`pdf-annotation-color-choice${color === choice ? ' selected' : ''}`}
                style={{ background: choice }}
                title={choice}
                onClick={() => setColor(choice)}
              />
            ))}
          </div>
        </div>

        {duplicate && (
          <p className="pdf-annotation-dialog-error">
            {t('projectEditor.pdfReader.annotations.labelDuplicate')}
          </p>
        )}

        <div className="pdf-annotation-dialog-actions">
          <button type="button" onClick={onCancel}>
            {t('projectEditor.pdfReader.cancel')}
          </button>
          <button type="button" className="primary" disabled={!candidate} onClick={submit}>
            {t('projectEditor.pdfReader.confirm')}
          </button>
        </div>
      </div>
    </div>
  )
}
