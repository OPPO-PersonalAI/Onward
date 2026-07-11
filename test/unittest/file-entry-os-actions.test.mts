/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 *
 * Usage: node --experimental-strip-types --test test/unittest/file-entry-os-actions.test.mts
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import {
  fileEntryOsItemState,
  isWindowsStyleRoot,
  normalizeEntryRelativePath,
  resolveEntryAbsolutePath,
  revealLabelKey
} from '../../src/utils/file-entry-path.ts'

test('resolveEntryAbsolutePath returns null without a usable root', () => {
  assert.equal(resolveEntryAbsolutePath(null, 'a.ts'), null)
  assert.equal(resolveEntryAbsolutePath(undefined, 'a.ts'), null)
  assert.equal(resolveEntryAbsolutePath('', 'a.ts'), null)
})

test('resolveEntryAbsolutePath joins POSIX roots with forward slashes', () => {
  assert.equal(resolveEntryAbsolutePath('/repo', 'a b.ts'), '/repo/a b.ts')
  assert.equal(resolveEntryAbsolutePath('/repo/', 'docs/x.md'), '/repo/docs/x.md')
  assert.equal(resolveEntryAbsolutePath('/repo', '/leading.ts'), '/repo/leading.ts')
  assert.equal(resolveEntryAbsolutePath('/', 'a.ts'), '/a.ts')
})

test('resolveEntryAbsolutePath follows the root separator style on Windows roots', () => {
  assert.equal(resolveEntryAbsolutePath('C:\\repo', 'docs/x.md'), 'C:\\repo\\docs\\x.md')
  assert.equal(resolveEntryAbsolutePath('C:\\repo\\', 'a.ts'), 'C:\\repo\\a.ts')
  assert.equal(resolveEntryAbsolutePath('C:/repo', 'docs/x.md'), 'C:/repo/docs/x.md')
  assert.equal(
    resolveEntryAbsolutePath('\\\\server\\share', 'dir/file.txt'),
    '\\\\server\\share\\dir\\file.txt'
  )
})

test('resolveEntryAbsolutePath with an empty relative path returns the trimmed root', () => {
  assert.equal(resolveEntryAbsolutePath('/repo/', ''), '/repo')
  assert.equal(resolveEntryAbsolutePath('/repo', null), '/repo')
  assert.equal(resolveEntryAbsolutePath('C:\\repo\\', undefined), 'C:\\repo')
})

test('resolveEntryAbsolutePath keeps drive-root workspaces win32-absolute (audit xplat-02)', () => {
  // A bare 'C:' is drive-RELATIVE (path.win32.isAbsolute('C:') === false) —
  // the drive-root row must resolve to 'C:\' so the main-handler gate passes.
  assert.equal(resolveEntryAbsolutePath('C:\\', ''), 'C:\\')
  assert.equal(resolveEntryAbsolutePath('C:', ''), 'C:\\')
  assert.equal(resolveEntryAbsolutePath('C:\\\\', ''), 'C:\\')
  // Children under a drive root must not get a doubled separator.
  assert.equal(resolveEntryAbsolutePath('C:\\', 'src/a.ts'), 'C:\\src\\a.ts')
})

test('resolveEntryAbsolutePath collapses "." and ".." segments lexically (audit path-02)', () => {
  // Mirrors the containment-checked existence gate so enable state and the
  // open target agree even when git emits dot segments.
  assert.equal(resolveEntryAbsolutePath('/repo', 'gone/../file.txt'), '/repo/file.txt')
  assert.equal(resolveEntryAbsolutePath('/repo', 'a/./b.ts'), '/repo/a/b.ts')
  assert.equal(resolveEntryAbsolutePath('C:\\repo', 'docs\\..\\x.md'), 'C:\\repo\\x.md')
})

test('resolveEntryAbsolutePath returns null when ".." climbs above the root (audit sec-03)', () => {
  assert.equal(resolveEntryAbsolutePath('/repo', '../secret'), null)
  assert.equal(resolveEntryAbsolutePath('/repo', 'a/../../etc/hosts'), null)
  assert.equal(resolveEntryAbsolutePath('C:\\repo', '..\\..\\Windows\\system32'), null)
})

test('normalizeEntryRelativePath canonicalizes the existence-gate input (audit path-03)', () => {
  assert.equal(normalizeEntryRelativePath('/readme.md'), 'readme.md')
  assert.equal(normalizeEntryRelativePath('\\\\docs\\guide.md'), 'docs\\guide.md')
  assert.equal(normalizeEntryRelativePath('docs/guide.md'), 'docs/guide.md')
  assert.equal(normalizeEntryRelativePath(null), '')
  assert.equal(normalizeEntryRelativePath(undefined), '')
})

test('POSIX filenames containing backslashes stay intact (audit xplat-09)', () => {
  // Backslash is a legal name character on macOS/Linux — under a POSIX root
  // it must never be treated as a separator, or the enable gate and the open
  // target act on different files.
  assert.equal(normalizeEntryRelativePath('\\weird.txt', false), '\\weird.txt')
  assert.equal(resolveEntryAbsolutePath('/repo', '\\weird.txt'), '/repo/\\weird.txt')
  assert.equal(resolveEntryAbsolutePath('/repo', 'a\\b.txt'), '/repo/a\\b.txt')
  // Under Windows-style roots both slashes are separators, as before.
  assert.equal(resolveEntryAbsolutePath('C:\\repo', 'a\\b.txt'), 'C:\\repo\\a\\b.txt')
})

test('isWindowsStyleRoot classifies separator style by the root', () => {
  assert.equal(isWindowsStyleRoot('C:\\repo'), true)
  assert.equal(isWindowsStyleRoot('C:'), true)
  assert.equal(isWindowsStyleRoot('C:/'), true)
  assert.equal(isWindowsStyleRoot('\\\\server\\share'), true)
  assert.equal(isWindowsStyleRoot('/repo'), false)
  assert.equal(isWindowsStyleRoot(null), false)
})

test('revealLabelKey picks the platform-specific label', () => {
  assert.equal(revealLabelKey('darwin'), 'common.revealInFinder')
  assert.equal(revealLabelKey('win32'), 'common.revealInFileExplorer')
  assert.equal(revealLabelKey('linux'), 'common.revealInFileManager')
  assert.equal(revealLabelKey('freebsd'), 'common.revealInFileManager')
  assert.equal(revealLabelKey(undefined), 'common.revealInFileManager')
})

test('fileEntryOsItemState disables deleted entries without an existence check', () => {
  assert.deepEqual(fileEntryOsItemState('deleted', null), { disabled: true, needsCheck: false })
  assert.deepEqual(fileEntryOsItemState('deleted', true), { disabled: true, needsCheck: false })
  // Git porcelain single-letter code used by GitFileStatus / GitHistoryFile rows.
  assert.deepEqual(fileEntryOsItemState('D', null), { disabled: true, needsCheck: false })
  assert.deepEqual(fileEntryOsItemState('D', true), { disabled: true, needsCheck: false })
})

test('fileEntryOsItemState keeps the item disabled until existence is confirmed', () => {
  assert.deepEqual(fileEntryOsItemState(undefined, null), { disabled: true, needsCheck: true })
  assert.deepEqual(fileEntryOsItemState('modified', null), { disabled: true, needsCheck: true })
  assert.deepEqual(fileEntryOsItemState('modified', false), { disabled: true, needsCheck: true })
})

test('fileEntryOsItemState enables entries confirmed on disk', () => {
  assert.deepEqual(fileEntryOsItemState(undefined, true), { disabled: false, needsCheck: true })
  assert.deepEqual(fileEntryOsItemState('modified', true), { disabled: false, needsCheck: true })
  assert.deepEqual(fileEntryOsItemState('untracked', true), { disabled: false, needsCheck: true })
})
