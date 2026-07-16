/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

import './LargeFileConfirmDialog.css'

interface LargeFileConfirmDialogProps {
  title: string
  message: string
  confirmText: string
  cancelText: string
  onConfirm: () => void
  onCancel: () => void
}

export function LargeFileConfirmDialog({
  title,
  message,
  confirmText,
  cancelText,
  onConfirm,
  onCancel
}: LargeFileConfirmDialogProps) {
  return (
    <div
      className="large-file-confirm-overlay"
      data-testid="large-file-confirm-dialog"
    >
      <div
        className="large-file-confirm-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="large-file-confirm-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <h2 id="large-file-confirm-title" className="large-file-confirm-title">
          {title}
        </h2>
        <p className="large-file-confirm-message">
          {message}
        </p>
        <div className="large-file-confirm-actions">
          <button
            className="large-file-confirm-button cancel"
            data-testid="large-file-confirm-cancel"
            onClick={onCancel}
          >
            {cancelText}
          </button>
          <button
            className="large-file-confirm-button confirm"
            data-testid="large-file-confirm-confirm"
            onClick={onConfirm}
          >
            {confirmText}
          </button>
        </div>
      </div>
    </div>
  )
}
