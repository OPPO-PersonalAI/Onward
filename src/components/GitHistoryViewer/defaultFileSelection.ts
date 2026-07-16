/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

export interface DefaultFileSelectionCandidate {
  filename: string
}

/**
 * Decide which file (if any) should be selected by default when a commit's
 * file list becomes available in Git History.
 *
 * Design intent: entering Git History — or switching to another commit — must
 * NOT auto-expand any file's diff. A large file would otherwise trigger a heavy
 * diff render the instant the view opens, which is exactly the lag this change
 * removes. The diff pane instead falls through to its placeholder / empty state
 * until the user explicitly clicks a file.
 *
 * The only case we keep a file selected is an in-session selection that still
 * exists in the freshly loaded list (so switching a diff option, toggling
 * whitespace, or reloading the same commit does not blank the user's view).
 * We deliberately do NOT restore a previously persisted file here: that would
 * re-introduce the "auto-expand a big file on entry" lag through the back door.
 *
 * @param files    The freshly loaded file list for the current commit range.
 * @param previous The file currently selected in this session, or null.
 * @returns The file to keep selected, or null to show the placeholder.
 */
export function resolveDefaultSelectedFile<T extends DefaultFileSelectionCandidate>(
  files: readonly T[],
  previous: T | null
): T | null {
  if (files.length === 0) return null
  if (previous && files.some(file => file.filename === previous.filename)) {
    return previous
  }
  return null
}

/**
 * Resolve the selection to keep after a file list reloads, honouring an explicit
 * user selection that must survive an ASYNCHRONOUS reload.
 *
 * Why this exists: when the repo (or commit range) reloads, the live selection
 * ref is transiently cleared while the new list streams in. If the user just
 * clicked a file, the plain {@link resolveDefaultSelectedFile} would read that
 * transient null as `previous` and resolve to the placeholder — silently
 * dropping the click, so the diff never loads (and, for a large file, the
 * confirmation prompt never appears). `explicitFilename` is the user's stated
 * intent, tracked independently of the churny live ref, so it can be honoured
 * once the file reappears in the freshly loaded list.
 *
 * This does NOT re-introduce "auto-expand on entry": `explicitFilename` is set
 * only by an explicit user selection and cleared on entry / close / repo switch,
 * so a fresh entry has no intent to restore and still resolves to the placeholder.
 *
 * @param files           The freshly loaded file list.
 * @param currentSelection The live in-session selection (may be transiently null).
 * @param explicitFilename The filename the user explicitly selected, or null.
 * @returns The file to keep selected, or null to show the placeholder.
 */
export function resolveSelectionAfterReload<T extends DefaultFileSelectionCandidate>(
  files: readonly T[],
  currentSelection: T | null,
  explicitFilename: string | null
): T | null {
  const live = resolveDefaultSelectedFile(files, currentSelection)
  if (live) return live
  if (explicitFilename) {
    const match = files.find(file => file.filename === explicitFilename)
    if (match) return match
  }
  return null
}
