/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 *
 * Pure decision logic for the PDF annotation list: ordering, filtering, label
 * management, and which copy actions are available for a given entry.
 *
 * Split out of the component for the usual reason — a list that silently drops
 * an entry, or orders two highlights from the same page wrongly, is a bug the
 * user notices before any test does. Keeping the decisions here makes them
 * pinnable without rendering React.
 */

import type { PdfAnnotationSummary } from '../PdfReader'

export type AnnotationSortMode = 'created' | 'page'
export type AnnotationDensity = 'comfortable' | 'compact'

/** A user-defined highlight label. `id` is written into the PDF, so it is
 *  stable for the lifetime of every document that carries it. */
export interface HighlightLabel {
  id: string
  name: string
  color: string
}

/** Filter value meaning "every label". Kept as a sentinel rather than
 *  `null | undefined` so it round-trips through persisted settings cleanly. */
export const ALL_LABELS = 'all'

const HEX_COLOR = /^#[0-9a-f]{6}$/i

/**
 * Order the list for display.
 *
 * `created` puts newest last, matching the order the user made them — the list
 * reads like a running log, which is why it pairs with scroll-to-bottom.
 * `page` follows the document, so the list reads like a table of contents.
 *
 * Ties are broken by `createdAt` then `id` so the order is total: an unstable
 * comparator makes entries appear to jump around when the list re-renders.
 */
export function sortAnnotations(
  items: readonly PdfAnnotationSummary[],
  mode: AnnotationSortMode
): PdfAnnotationSummary[] {
  const sorted = [...items]
  sorted.sort((a, b) => {
    if (mode === 'page') {
      if (a.page !== b.page) return a.page - b.page
    }
    if (a.createdAt !== b.createdAt) return a.createdAt - b.createdAt
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
  })
  return sorted
}

/** Keep only entries carrying the given label; `ALL_LABELS` keeps everything. */
export function filterAnnotations(
  items: readonly PdfAnnotationSummary[],
  labelId: string
): PdfAnnotationSummary[] {
  if (!labelId || labelId === ALL_LABELS) return [...items]
  return items.filter((item) => item.labelId === labelId)
}

/**
 * Options for the label filter dropdown: "all", then every label that is
 * actually present, in the palette's own order.
 *
 * Derived from the annotations rather than the palette so a document written
 * by an older version — or by the reference project, whose label set differs —
 * still offers a usable filter instead of an empty one.
 */
export function buildLabelFilterOptions(
  items: readonly PdfAnnotationSummary[],
  labels: readonly HighlightLabel[]
): Array<{ id: string; name: string; color: string | null; count: number }> {
  const counts = new Map<string, number>()
  const names = new Map<string, string>()
  for (const item of items) {
    counts.set(item.labelId, (counts.get(item.labelId) ?? 0) + 1)
    if (!names.has(item.labelId)) names.set(item.labelId, item.labelName)
  }

  const out: Array<{ id: string; name: string; color: string | null; count: number }> = []
  for (const label of labels) {
    const count = counts.get(label.id)
    if (count) out.push({ id: label.id, name: label.name, color: label.color, count })
  }
  // Labels present in the document but absent from the palette come last, using
  // the name stored alongside the annotation.
  for (const [id, count] of counts) {
    if (labels.some((label) => label.id === id)) continue
    out.push({ id, name: names.get(id) ?? id, color: null, count })
  }
  return out
}

/**
 * Whether a newly-arrived list should scroll to the bottom.
 *
 * Only under `created` ordering: there, a new highlight really is at the
 * bottom. Under `page` ordering it can land anywhere, and yanking the viewport
 * to the end would lose the user's place for no reason.
 */
export function shouldScrollToBottom(options: {
  enabled: boolean
  mode: AnnotationSortMode
  previousCount: number
  nextCount: number
}): boolean {
  if (!options.enabled) return false
  if (options.mode !== 'created') return false
  return options.nextCount > options.previousCount
}

/**
 * Resolve which notes are expanded.
 *
 * `expandedByDefault` is the global preference; `overrides` holds per-entry
 * choices the user made by hand. The override wins, and — this is the part
 * that was a defect in the reference project — an override survives editing
 * the note, re-sorting, re-filtering and saving, because it is keyed by
 * annotation id rather than by list position.
 */
export function isNoteExpanded(
  annotationId: string,
  expandedByDefault: boolean,
  overrides: ReadonlyMap<string, boolean>
): boolean {
  const override = overrides.get(annotationId)
  return override === undefined ? expandedByDefault : override
}

/**
 * Drop overrides for annotations that no longer exist.
 *
 * Without this the map grows for the lifetime of the session, and — worse — a
 * deleted-then-recreated annotation could inherit a stale expansion state if
 * ids were ever reused.
 */
export function pruneNoteOverrides(
  overrides: ReadonlyMap<string, boolean>,
  items: readonly PdfAnnotationSummary[]
): Map<string, boolean> {
  const live = new Set(items.map((item) => item.id))
  const next = new Map<string, boolean>()
  for (const [id, value] of overrides) {
    if (live.has(id)) next.set(id, value)
  }
  return next
}

/** Which copy actions make sense for an entry. An empty note means "copy note"
 *  and "copy both" would silently produce the same thing as "copy highlight". */
export function availableCopyActions(item: PdfAnnotationSummary): {
  highlight: boolean
  note: boolean
  both: boolean
} {
  const hasHighlight = Boolean(item.textSnapshot.trim())
  const hasNote = Boolean(item.note.trim())
  return {
    highlight: hasHighlight,
    note: hasNote,
    both: hasHighlight && hasNote
  }
}

/** Text placed on the clipboard for each copy action. */
export function buildCopyText(
  item: PdfAnnotationSummary,
  kind: 'highlight' | 'note' | 'both'
): string {
  const highlight = item.textSnapshot.trim()
  const note = item.note.trim()
  if (kind === 'highlight') return highlight
  if (kind === 'note') return note
  if (!note) return highlight
  if (!highlight) return note
  // Blank line between the two so a paste into notes reads as quote + comment
  // rather than one run-on paragraph.
  return `${highlight}\n\n${note}`
}

/**
 * Whether the panel should be open when a document finishes loading.
 *
 * The reference project branched on local-vs-remote PDFs, which has no meaning
 * here — every file is local. Simplified to what the user confirmed: show the
 * panel when there is something in it, and otherwise respect the last explicit
 * choice, so opening a plain PDF does not steal reading width.
 */
export function shouldOpenPanelOnLoad(options: {
  annotationCount: number
  userChoice: boolean | null
}): boolean {
  if (options.userChoice !== null) return options.userChoice
  return options.annotationCount > 0
}

/**
 * Validate and normalise a user-supplied label.
 *
 * Returns `null` for anything unusable. Ids are generated, never taken from
 * user input: an id collides across documents and is written into the file, so
 * letting the user pick one invites silent data mix-ups.
 */
export function normalizeNewLabel(
  name: string,
  color: string,
  existing: readonly HighlightLabel[],
  idSuffix: string
): HighlightLabel | null {
  const trimmed = name.trim()
  if (!trimmed) return null
  if (trimmed.length > 40) return null
  const normalizedColor = color.trim().toLowerCase()
  if (!HEX_COLOR.test(normalizedColor)) return null
  if (existing.some((label) => label.name.trim().toLowerCase() === trimmed.toLowerCase())) {
    return null
  }
  const suffix = idSuffix.replace(/[^a-z0-9]/gi, '').slice(0, 12) || 'x'
  return { id: `hl-custom-${suffix}`, name: trimmed, color: normalizedColor }
}

/**
 * Only user-created labels are managed (renamed / recolored / deleted). The
 * four built-ins have translated names driven by the locale and serve as the
 * fallback palette, so mutating or removing them would leave a fresh profile
 * with nothing to highlight with.
 */
export function isCustomLabelId(id: string): boolean {
  return id.startsWith('hl-custom-')
}

/**
 * Rename a custom label. Palette-only semantics (matching the viewer's
 * setLabels contract): existing highlights keep the name stored in their own
 * records; the palette and future highlights follow the new one. Returns null
 * when the target is not renameable or the name is unusable/duplicate.
 */
export function renameLabel(
  labels: readonly HighlightLabel[],
  id: string,
  newName: string
): HighlightLabel[] | null {
  if (!isCustomLabelId(id)) return null
  const trimmed = newName.trim()
  if (!trimmed || trimmed.length > 40) return null
  if (!labels.some((label) => label.id === id)) return null
  const duplicate = labels.some(
    (label) => label.id !== id && label.name.trim().toLowerCase() === trimmed.toLowerCase()
  )
  if (duplicate) return null
  return labels.map((label) => (label.id === id ? { ...label, name: trimmed } : label))
}

/** Recolor a custom label. Same palette-only semantics as renameLabel. */
export function recolorLabel(
  labels: readonly HighlightLabel[],
  id: string,
  color: string
): HighlightLabel[] | null {
  if (!isCustomLabelId(id)) return null
  const normalized = color.trim().toLowerCase()
  if (!HEX_COLOR.test(normalized)) return null
  if (!labels.some((label) => label.id === id)) return null
  return labels.map((label) => (label.id === id ? { ...label, color: normalized } : label))
}

/**
 * Delete a custom label from the palette. Safe by construction: records store
 * their own labelName + color, and buildLabelFilterOptions already surfaces
 * document labels that are absent from the palette, so existing highlights
 * keep working — the label just stops being offered for new ones.
 */
export function deleteLabel(
  labels: readonly HighlightLabel[],
  id: string
): HighlightLabel[] | null {
  if (!isCustomLabelId(id)) return null
  if (!labels.some((label) => label.id === id)) return null
  return labels.filter((label) => label.id !== id)
}

/** Reject a persisted label list that has been corrupted or hand-edited. */
export function normalizeStoredLabels(
  value: unknown,
  fallback: readonly HighlightLabel[]
): HighlightLabel[] {
  if (!Array.isArray(value)) return [...fallback]
  const seen = new Set<string>()
  const out: HighlightLabel[] = []
  for (const entry of value) {
    if (!entry || typeof entry !== 'object') continue
    const id = String((entry as HighlightLabel).id ?? '').trim()
    const name = String((entry as HighlightLabel).name ?? '').trim()
    const color = String((entry as HighlightLabel).color ?? '').trim().toLowerCase()
    if (!id || !name || !HEX_COLOR.test(color) || seen.has(id)) continue
    seen.add(id)
    out.push({ id, name, color })
  }
  // An empty or fully-invalid list would leave the user with no way to
  // highlight anything, so fall back rather than honouring it.
  return out.length > 0 ? out : [...fallback]
}
