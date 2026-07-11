/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Pure helpers shared by every file-entry context-menu surface that offers
 * "Open with Default Application" / "Reveal in Finder|File Explorer|File Manager".
 *
 * Kept free of Electron / React imports so the decision tables can be locked
 * by test/unittest/file-entry-os-actions.test.mts.
 */

/** True when the root's separator style is Windows (backslash or bare drive). */
export function isWindowsStyleRoot(root: string | null | undefined): boolean {
  if (!root) return false
  return root.includes('\\') || /^[A-Za-z]:\/*$/.test(root)
}

/**
 * Strips leading separators from an entry's repo-relative path. Exported so
 * the existence-check caller (useFileEntryOsActions) and the joiner below
 * canonicalize the SAME way — a leading '/' fed only to the existence gate
 * used to false-disable entries the joiner would have opened fine.
 *
 * Backslash counts as a separator only under Windows-style roots: on POSIX
 * it is a legal filename character (a file literally named '\weird.txt'
 * must keep its backslash or the gate and the open target diverge).
 */
export function normalizeEntryRelativePath(
  relativePath: string | null | undefined,
  windowsStyle = true
): string {
  return (relativePath ?? '').replace(windowsStyle ? /^[\\/]+/ : /^\/+/, '')
}

/**
 * Join a surface root (project root, git repoRoot, or activeCwd) with a
 * repo-relative path into an absolute path suitable for shell.openPath /
 * shell.showItemInFolder.
 *
 * Separator style follows the root: a root containing a backslash (Windows
 * drive or UNC root) yields backslash-joined output; otherwise forward
 * slashes. '.' segments are dropped and '..' segments collapse lexically —
 * mirroring the containment-checked existence gate (resolveInRoot), so the
 * enable state and the open target can never diverge. Returns null when no
 * root is available or when '..' would climb above the root — callers treat
 * that as "action unavailable".
 */
export function resolveEntryAbsolutePath(
  root: string | null | undefined,
  relativePath: string | null | undefined
): string | null {
  if (!root) return null
  // Bare drive roots ('C:', 'C:/') carry no separator style of their own —
  // emit native Windows backslashes for them.
  const sep = root.includes('\\') || /^[A-Za-z]:\/*$/.test(root) ? '\\' : '/'
  let trimmedRoot = root.replace(/[\\/]+$/, '')
  // A root of "/" (or all separators) trims to empty — restore the bare separator.
  if (!trimmedRoot) trimmedRoot = sep
  // A bare drive letter ('C:') is drive-RELATIVE on Windows (isAbsolute('C:')
  // is false) — restore its separator so the drive-root row stays openable.
  else if (/^[A-Za-z]:$/.test(trimmedRoot)) trimmedRoot += sep
  const windowsStyle = sep === '\\'
  const collapsed: string[] = []
  for (const segment of normalizeEntryRelativePath(relativePath, windowsStyle)
    .split(windowsStyle ? /[\\/]+/ : /\/+/)) {
    if (!segment || segment === '.') continue
    if (segment === '..') {
      if (collapsed.length === 0) return null
      collapsed.pop()
      continue
    }
    collapsed.push(segment)
  }
  if (collapsed.length === 0) return trimmedRoot
  const nativeRel = collapsed.join(sep)
  return trimmedRoot.endsWith(sep) ? `${trimmedRoot}${nativeRel}` : `${trimmedRoot}${sep}${nativeRel}`
}

/**
 * Platform-dependent i18n key for the reveal menu item, mirroring
 * VS Code's per-platform naming.
 */
export function revealLabelKey(
  platform: string | null | undefined
): 'common.revealInFinder' | 'common.revealInFileExplorer' | 'common.revealInFileManager' {
  if (platform === 'darwin') return 'common.revealInFinder'
  if (platform === 'win32') return 'common.revealInFileExplorer'
  return 'common.revealInFileManager'
}

export interface FileEntryOsItemState {
  /** True when the menu item must render disabled (grey, not clickable). */
  disabled: boolean
  /** True when an on-disk existence check applies to this entry. */
  needsCheck: boolean
}

/**
 * Disabled-state decision table for the two OS actions.
 *
 * - git status deleted (`'D'` porcelain code or the spelled-out `'deleted'`)
 *   → disabled, no existence check needed
 * - existence unknown (null, check pending) → disabled until confirmed
 * - existence false → disabled
 * - existence true → enabled
 */
export function fileEntryOsItemState(
  status: string | undefined,
  exists: boolean | null
): FileEntryOsItemState {
  if (status === 'deleted' || status === 'D') return { disabled: true, needsCheck: false }
  return { disabled: exists !== true, needsCheck: true }
}
