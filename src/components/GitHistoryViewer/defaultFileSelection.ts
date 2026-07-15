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
