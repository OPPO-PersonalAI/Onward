/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 *
 * Usage: node --experimental-strip-types --test test/unittest/path-containment.test.mts
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { win32, posix } from 'node:path'

import {
  isSubPathWith,
  resolveInRootWith,
  type PathSemantics
} from '../../electron/main/path-containment.ts'

const WIN: PathSemantics = {
  sep: win32.sep,
  caseInsensitive: true,
  normalize: win32.normalize,
  resolve: win32.resolve
}

const POSIX: PathSemantics = {
  sep: posix.sep,
  caseInsensitive: false,
  normalize: posix.normalize,
  resolve: posix.resolve
}

test('isSubPath accepts children of ordinary roots and rejects prefix siblings', () => {
  assert.equal(isSubPathWith('/repo', '/repo/a.ts', POSIX), true)
  assert.equal(isSubPathWith('/repo', '/repo', POSIX), true)
  assert.equal(isSubPathWith('/repo', '/repository/a.ts', POSIX), false)
  assert.equal(isSubPathWith('/repo', '/etc/hosts', POSIX), false)
})

test('isSubPath accepts children of filesystem-root workspaces (audit xplat-01)', () => {
  // '/' and 'C:\' normalize WITH their trailing separator; the old
  // prefix-building appended another one and rejected every child forever.
  assert.equal(isSubPathWith('/', '/etc/hosts', POSIX), true)
  assert.equal(isSubPathWith('/', '/etc', POSIX), true)
  assert.equal(isSubPathWith('C:\\', 'C:\\a.txt', WIN), true)
  assert.equal(isSubPathWith('C:\\', 'C:\\src\\deep\\a.ts', WIN), true)
  assert.equal(isSubPathWith('\\\\server\\share', '\\\\server\\share\\dir\\f.txt', WIN), true)
})

test('isSubPath tolerates roots passed with a trailing separator', () => {
  assert.equal(isSubPathWith('/repo/', '/repo/a.ts', POSIX), true)
  // Root-row case: target equals the root without its trailing separator.
  assert.equal(isSubPathWith('/repo/', '/repo', POSIX), true)
  assert.equal(isSubPathWith('C:\\repo\\', 'C:\\repo\\a.ts', WIN), true)
  assert.equal(isSubPathWith('C:\\repo\\', 'C:\\repo', WIN), true)
})

test('isSubPath compares case-insensitively on win32 semantics only', () => {
  assert.equal(isSubPathWith('C:\\Repo', 'c:\\repo\\A.TS', WIN), true)
  assert.equal(isSubPathWith('/Repo', '/repo/a.ts', POSIX), false)
})

test('resolveInRoot resolves in-root entries and rejects traversal escapes', () => {
  assert.equal(resolveInRootWith('/repo', 'a/b.ts', POSIX), '/repo/a/b.ts')
  assert.equal(resolveInRootWith('/repo', 'a/../b.ts', POSIX), '/repo/b.ts')
  assert.equal(resolveInRootWith('/repo', '../escape', POSIX), null)
  assert.equal(resolveInRootWith('/repo', 'a/../../escape', POSIX), null)
})

test('resolveInRoot works for filesystem-root workspaces (audit xplat-01)', () => {
  assert.equal(resolveInRootWith('/', 'etc/hosts', POSIX), '/etc/hosts')
  assert.equal(resolveInRootWith('C:\\', 'src/a.ts', WIN), 'C:\\src\\a.ts')
  assert.equal(resolveInRootWith('C:\\', '', WIN), 'C:\\')
})
