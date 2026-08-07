/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 *
 * Pure three-state diff over the highlight-annotation sets of two PDF
 * versions, keyed by the stable per-record id (CYY_MARK_Id). This is the
 * record-set model every mature annotation-collaboration product converges on
 * (PSPDFKit Instant JSON's create/update/delete encoding is the closest
 * shipped artifact); pixel- or byte-level PDF diffing cannot answer "which
 * highlight changed".
 *
 * Inputs are the summaries the embedded viewer already broadcasts to its host
 * (`onward:pdf:annotations`) — no PDF parsing happens here, which is what
 * makes the git-diff annotation panel free of any new parsing code.
 *
 * No DOM, no state: unit-tested in test/unittest/pdf-annotation-diff.test.mts
 * (PAD-U-*).
 */

export interface PdfDiffAnnotation {
  id: string
  labelId: string
  labelName: string
  color: string
  page: number
  note: string
  textSnapshot: string
  createdAt: number
  updatedAt: number
}

/**
 * Fields whose change turns an id-stable record into a "changed" entry.
 * labelName is deliberately excluded: renaming a label rewords every record
 * that carries it without any annotation having been edited.
 */
export type AnnotationDiffField = 'labelId' | 'color' | 'page' | 'note' | 'textSnapshot'

const COMPARED_FIELDS: readonly AnnotationDiffField[] = [
  'labelId',
  'color',
  'page',
  'note',
  'textSnapshot'
]

export type AnnotationDiffKind = 'added' | 'removed' | 'changed'

export interface AnnotationDiffEntry {
  kind: AnnotationDiffKind
  /** The record to display and jump to: modified side for added/changed, original side for removed. */
  annotation: PdfDiffAnnotation
  /** Original-side version, present on 'changed' entries only. */
  before?: PdfDiffAnnotation
  /** Which compared fields differ, present on 'changed' entries only. */
  changedFields?: AnnotationDiffField[]
  /** Which compare pane a click should navigate. */
  jumpPane: 'original' | 'modified'
}

export interface AnnotationDiffResult {
  entries: AnnotationDiffEntry[]
  counts: {
    added: number
    removed: number
    changed: number
    unchanged: number
    /** Same id appearing twice within one side (corrupt input); last wins. */
    duplicateIds: number
  }
}

function normalize(record: PdfDiffAnnotation): PdfDiffAnnotation {
  return {
    id: String(record.id ?? ''),
    labelId: String(record.labelId ?? ''),
    labelName: String(record.labelName ?? ''),
    color: String(record.color ?? ''),
    page: Number(record.page) || 0,
    note: String(record.note ?? ''),
    textSnapshot: String(record.textSnapshot ?? ''),
    createdAt: Number(record.createdAt) || 0,
    updatedAt: Number(record.updatedAt) || 0
  }
}

function indexById(records: PdfDiffAnnotation[]): { map: Map<string, PdfDiffAnnotation>; duplicates: number } {
  const map = new Map<string, PdfDiffAnnotation>()
  let duplicates = 0
  for (const raw of records) {
    if (!raw || typeof raw.id !== 'string' || !raw.id) continue
    if (map.has(raw.id)) duplicates += 1
    map.set(raw.id, normalize(raw))
  }
  return { map, duplicates }
}

function changedFieldsBetween(before: PdfDiffAnnotation, after: PdfDiffAnnotation): AnnotationDiffField[] {
  const fields: AnnotationDiffField[] = []
  for (const field of COMPARED_FIELDS) {
    if (before[field] !== after[field]) fields.push(field)
  }
  return fields
}

function compareEntries(a: AnnotationDiffEntry, b: AnnotationDiffEntry): number {
  if (a.annotation.page !== b.annotation.page) return a.annotation.page - b.annotation.page
  if (a.annotation.createdAt !== b.annotation.createdAt) return a.annotation.createdAt - b.annotation.createdAt
  return a.annotation.id < b.annotation.id ? -1 : a.annotation.id > b.annotation.id ? 1 : 0
}

/**
 * Three-state diff of two record sets. Deterministic: entries come back
 * sorted by page, then creation time, then id.
 */
export function diffAnnotationSets(
  original: PdfDiffAnnotation[],
  modified: PdfDiffAnnotation[]
): AnnotationDiffResult {
  const left = indexById(Array.isArray(original) ? original : [])
  const right = indexById(Array.isArray(modified) ? modified : [])

  const entries: AnnotationDiffEntry[] = []
  let unchanged = 0

  for (const [id, after] of right.map) {
    const before = left.map.get(id)
    if (!before) {
      entries.push({ kind: 'added', annotation: after, jumpPane: 'modified' })
      continue
    }
    const changedFields = changedFieldsBetween(before, after)
    if (changedFields.length === 0) {
      unchanged += 1
      continue
    }
    entries.push({ kind: 'changed', annotation: after, before, changedFields, jumpPane: 'modified' })
  }

  for (const [id, before] of left.map) {
    if (!right.map.has(id)) {
      entries.push({ kind: 'removed', annotation: before, jumpPane: 'original' })
    }
  }

  entries.sort(compareEntries)

  return {
    entries,
    counts: {
      added: entries.filter(e => e.kind === 'added').length,
      removed: entries.filter(e => e.kind === 'removed').length,
      changed: entries.filter(e => e.kind === 'changed').length,
      unchanged,
      duplicateIds: left.duplicates + right.duplicates
    }
  }
}

/**
 * File-status-aware entry point. For file-level added/deleted the compare
 * view shows a single pane, and every annotation on the existing side is
 * trivially added/removed — the absent side is an empty set by definition,
 * whatever a stale caller passes for it.
 */
export function diffForFileStatus(
  status: 'added' | 'deleted' | 'modified',
  original: PdfDiffAnnotation[],
  modified: PdfDiffAnnotation[]
): AnnotationDiffResult {
  if (status === 'added') return diffAnnotationSets([], modified)
  if (status === 'deleted') return diffAnnotationSets(original, [])
  return diffAnnotationSets(original, modified)
}

/**
 * Emphasis sets for the two panes: each pane outlines the records that this
 * diff says are interesting on ITS side of the comparison.
 */
export function emphasisIdsForPanes(result: AnnotationDiffResult): {
  original: string[]
  modified: string[]
} {
  const original: string[] = []
  const modified: string[] = []
  for (const entry of result.entries) {
    if (entry.kind === 'added') modified.push(entry.annotation.id)
    else if (entry.kind === 'removed') original.push(entry.annotation.id)
    else {
      modified.push(entry.annotation.id)
      original.push(entry.annotation.id)
    }
  }
  return { original, modified }
}
