/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 *
 * Relay layer for diagnostics coming out of the embedded PDF viewer.
 *
 * The viewer runs in a sandboxed iframe loaded from `file://`. It cannot
 * import the renderer's trace registry, so it posts short event names over
 * `postMessage` and this module turns them into registered event names with a
 * payload that is safe to record.
 *
 * Both halves are deliberate. The name table means a stale — or tampered —
 * iframe cannot inject arbitrary event names into the trace stream; anything
 * unrecognised is dropped rather than passed through. The payload sanitiser
 * treats the message as untrusted cross-realm data and enforces the project's
 * ~1 KB payload budget no matter what the sender does.
 */

// Explicit `.ts` extension so this module also resolves under plain Node's
// type-stripping loader, which the unit tests use (same convention as
// pdfReaderState.ts).
import { PERF_TRACE_EVENT } from '../../utils/perf-trace-names.ts'

/** Maximum keys kept from a viewer payload. Well above what any current event
 *  sends (3), low enough that a runaway sender cannot bloat the trace. */
const MAX_PAYLOAD_KEYS = 8

/** Strings are truncated rather than dropped so a short error message still
 *  survives, while no payload can carry document text. */
const MAX_STRING_LENGTH = 120

export const VIEWER_TRACE_EVENTS: Readonly<Record<string, string>> = {
  'text-selection.blocked-at-anchor': PERF_TRACE_EVENT.RENDERER_PDF_TEXT_SELECTION_BLOCKED_AT_ANCHOR,
  'text-selection.drag-committed': PERF_TRACE_EVENT.RENDERER_PDF_TEXT_SELECTION_DRAG_COMMITTED,
  'text-selection.copy-overridden': PERF_TRACE_EVENT.RENDERER_PDF_TEXT_SELECTION_COPY_OVERRIDDEN,
  'text-selection.autoscroll-engaged': PERF_TRACE_EVENT.RENDERER_PDF_TEXT_SELECTION_AUTOSCROLL_ENGAGED,
  'text-selection.annotations-indexed': PERF_TRACE_EVENT.RENDERER_PDF_TEXT_SELECTION_ANNOTATIONS_INDEXED,
  'text-selection.annotation-index-failed': PERF_TRACE_EVENT.RENDERER_PDF_TEXT_SELECTION_ANNOTATION_INDEX_FAILED,
  'text-selection.invisible-spans-dropped': PERF_TRACE_EVENT.RENDERER_PDF_TEXT_SELECTION_INVISIBLE_SPANS_DROPPED,
  'text-selection.engine-reset': PERF_TRACE_EVENT.RENDERER_PDF_TEXT_SELECTION_ENGINE_RESET,

  'annotation.changed': PERF_TRACE_EVENT.RENDERER_PDF_ANNOTATION_CHANGED,
  'annotation.adopted': PERF_TRACE_EVENT.RENDERER_PDF_ANNOTATION_ADOPTED,
  'annotation.save-start': PERF_TRACE_EVENT.RENDERER_PDF_ANNOTATION_SAVE_START,
  'annotation.save-done': PERF_TRACE_EVENT.RENDERER_PDF_ANNOTATION_SAVE_DONE,
  'annotation.save-failed': PERF_TRACE_EVENT.RENDERER_PDF_ANNOTATION_SAVE_FAILED,
  'annotation.save-cancelled': PERF_TRACE_EVENT.RENDERER_PDF_ANNOTATION_SAVE_CANCELLED,
  'annotation.save-blocked-signature': PERF_TRACE_EVENT.RENDERER_PDF_ANNOTATION_SAVE_BLOCKED_SIGNATURE,
  'annotation.read-failed': PERF_TRACE_EVENT.RENDERER_PDF_ANNOTATION_READ_FAILED,
  'annotation.native-cleanup': PERF_TRACE_EVENT.RENDERER_PDF_ANNOTATION_NATIVE_CLEANUP,
  'annotation.rebase-merged': PERF_TRACE_EVENT.RENDERER_PDF_ANNOTATION_REBASE_MERGED,
  'highlight.deleted': PERF_TRACE_EVENT.RENDERER_PDF_HIGHLIGHT_DELETED,
  'highlight.note-edited': PERF_TRACE_EVENT.RENDERER_PDF_HIGHLIGHT_NOTE_EDITED,

  'document.external-reload-start': PERF_TRACE_EVENT.RENDERER_PDF_VIEWER_EXTERNAL_RELOAD_START,
  'document.external-reload-done': PERF_TRACE_EVENT.RENDERER_PDF_VIEWER_EXTERNAL_RELOAD_DONE,
  'document.external-reload-deferred': PERF_TRACE_EVENT.RENDERER_PDF_VIEWER_EXTERNAL_RELOAD_DEFERRED
}

/**
 * Resolve a viewer-side event name to a registered trace event name.
 * Returns null for anything not in the table — the caller must not emit.
 *
 * `Object.hasOwn` rather than a plain lookup: a bare object literal inherits
 * from Object.prototype, so `table['constructor']` returns a function — a
 * truthy value that would sail past a `?? null` guard and reach the trace
 * stream as an event name. The whole point of this table is that only names
 * it explicitly lists get through.
 */
export function resolveViewerTraceEvent(name: unknown): string | null {
  if (typeof name !== 'string') return null
  if (!Object.hasOwn(VIEWER_TRACE_EVENTS, name)) return null
  const resolved = VIEWER_TRACE_EVENTS[name]
  return typeof resolved === 'string' ? resolved : null
}

/**
 * Reduce an untrusted cross-realm payload to finite numbers, booleans and
 * short strings. Nested objects, arrays, functions and non-finite numbers are
 * dropped rather than serialised: none of them belong in a trace payload, and
 * all of them are ways to make one arbitrarily large.
 */
export function sanitizeTracePayload(raw: unknown): Record<string, unknown> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const out: Record<string, unknown> = {}
  let kept = 0
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (kept >= MAX_PAYLOAD_KEYS) break
    if (typeof value === 'number') {
      if (!Number.isFinite(value)) continue
      out[key] = value
    } else if (typeof value === 'boolean') {
      out[key] = value
    } else if (typeof value === 'string') {
      out[key] = value.slice(0, MAX_STRING_LENGTH)
    } else {
      continue
    }
    kept += 1
  }
  return out
}
