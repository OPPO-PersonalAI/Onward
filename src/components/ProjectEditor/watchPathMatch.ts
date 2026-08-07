/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 *
 * Pure path matching between the main-process file watcher's event path and
 * the renderer's notion of the active file.
 *
 * Two hard-won facts drive the shape of this module (both cost a debugging
 * round against the external-refresh autotest):
 *
 *   1. `activeFilePath` is NOT always root-relative. Files opened through an
 *      absolute path (autotest drivers, deep links) store the absolute path
 *      verbatim, and blindly prefixing the root builds a garbage compare
 *      target that silently drops every watcher event for that file.
 *   2. Separator RUNS must collapse, not just flip: the main process sends
 *      path.normalize()d paths while the renderer's root can carry doubled
 *      separators (a TMPDIR ending in '/').
 *
 * Unit-tested in test/unittest/watch-path-match.test.mts (WPM-U-*).
 */

/** Windows drive-letter or UNC or POSIX-rooted — anything not root-relative. */
export function isAbsolutePathLike(value: string): boolean {
  return /^([a-zA-Z]:[\\/]|[\\/])/.test(value)
}

/**
 * The absolute path the watcher will report for the active file: the file's
 * own path when it is already absolute, else the root-joined form.
 */
export function expectedWatchPath(root: string, filePath: string): string {
  if (isAbsolutePathLike(filePath)) return filePath
  const separator = root.includes('\\') ? '\\' : '/'
  return root.endsWith(separator) ? `${root}${filePath}` : `${root}${separator}${filePath}`
}

/** Separator-run-collapsing equality; direction-agnostic. */
export function watchPathsEqual(a: string, b: string): boolean {
  const normalize = (value: string) => value.replace(/[\\/]+/g, '/')
  return normalize(a) === normalize(b)
}
