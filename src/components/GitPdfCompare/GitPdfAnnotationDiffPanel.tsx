/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 *
 * Sidebar listing how the highlight annotations differ between the two sides
 * of a PDF git comparison. Purely presentational: the diff itself comes from
 * annotationDiffModel.ts (unit-tested), the data from the two viewer iframes'
 * `onward:pdf:annotations` broadcasts, and navigation goes back through the
 * host's onJump callback.
 */

import type { AnnotationDiffEntry, AnnotationDiffResult } from './annotationDiffModel'
import './GitPdfAnnotationDiffPanel.css'

export interface GitPdfAnnotationDiffLabels {
  title: string
  added: string
  removed: string
  changed: string
  fieldLabelId: string
  fieldColor: string
  fieldPage: string
  fieldNote: string
  fieldTextSnapshot: string
}

interface GitPdfAnnotationDiffPanelProps {
  result: AnnotationDiffResult
  labels: GitPdfAnnotationDiffLabels
  onJump: (entry: AnnotationDiffEntry) => void
}

const FIELD_LABEL_KEY: Record<string, keyof GitPdfAnnotationDiffLabels> = {
  labelId: 'fieldLabelId',
  color: 'fieldColor',
  page: 'fieldPage',
  note: 'fieldNote',
  textSnapshot: 'fieldTextSnapshot'
}

function entrySnippet(entry: AnnotationDiffEntry): string {
  const note = entry.annotation.note.trim()
  if (note) return note
  return entry.annotation.textSnapshot.trim()
}

export function GitPdfAnnotationDiffPanel({ result, labels, onJump }: GitPdfAnnotationDiffPanelProps) {
  const groups: Array<{ kind: AnnotationDiffEntry['kind']; label: string }> = [
    { kind: 'added', label: labels.added },
    { kind: 'removed', label: labels.removed },
    { kind: 'changed', label: labels.changed }
  ]

  return (
    <aside
      className="git-pdf-annotation-diff"
      data-added-count={result.counts.added}
      data-removed-count={result.counts.removed}
      data-changed-count={result.counts.changed}
    >
      <div className="git-pdf-annotation-diff-title">{labels.title}</div>
      {groups.map(({ kind, label }) => {
        const entries = result.entries.filter((entry) => entry.kind === kind)
        if (entries.length === 0) return null
        return (
          <section key={kind} className="git-pdf-annotation-diff-group" data-kind={kind}>
            <div className="git-pdf-annotation-diff-group-header">
              <span className={`git-pdf-annotation-diff-badge is-${kind}`}>{label}</span>
              <span className="git-pdf-annotation-diff-count">{entries.length}</span>
            </div>
            <ul className="git-pdf-annotation-diff-list">
              {entries.map((entry) => (
                <li key={`${kind}-${entry.annotation.id}`}>
                  <button
                    type="button"
                    className="git-pdf-annotation-diff-row"
                    data-annotation-id={entry.annotation.id}
                    onClick={() => onJump(entry)}
                    title={entrySnippet(entry)}
                  >
                    <span
                      className="git-pdf-annotation-diff-dot"
                      style={{ background: entry.annotation.color }}
                    />
                    <span className="git-pdf-annotation-diff-main">
                      <span className="git-pdf-annotation-diff-label-line">
                        <span className="git-pdf-annotation-diff-label">{entry.annotation.labelName}</span>
                        <span className="git-pdf-annotation-diff-page">p.{entry.annotation.page}</span>
                      </span>
                      <span className="git-pdf-annotation-diff-snippet">{entrySnippet(entry)}</span>
                      {entry.kind === 'changed' && entry.changedFields && (
                        <span className="git-pdf-annotation-diff-fields">
                          {entry.changedFields.map((field) => (
                            <span key={field} className="git-pdf-annotation-diff-field-pill">
                              {labels[FIELD_LABEL_KEY[field]] ?? field}
                            </span>
                          ))}
                        </span>
                      )}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </section>
        )
      })}
    </aside>
  )
}
