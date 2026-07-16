/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { resolveDefaultSelectedFile, resolveSelectionAfterReload } from '../../src/components/GitHistoryViewer/defaultFileSelection.ts'

interface File {
  filename: string
}

const f = (filename: string): File => ({ filename })

describe('git history default file selection (no auto-expand on entry)', () => {
  it('returns null for an empty file list', () => {
    assert.equal(resolveDefaultSelectedFile<File>([], null), null)
    assert.equal(resolveDefaultSelectedFile<File>([], f('a.ts')), null)
  })

  it('does NOT auto-select the first file when there is no prior selection', () => {
    // This is the core behaviour change: entering Git History (previous === null)
    // must resolve to the placeholder, never files[0].
    const files = [f('a.ts'), f('b.ts'), f('c.ts')]
    assert.equal(resolveDefaultSelectedFile(files, null), null)
  })

  it('preserves an in-session selection that still exists in the new list', () => {
    const prev = f('b.ts')
    const files = [f('a.ts'), f('b.ts'), f('c.ts')]
    assert.equal(resolveDefaultSelectedFile(files, prev), prev)
  })

  it('drops to the placeholder when the previous file is gone from the new list', () => {
    // e.g. switching to another commit that never touched b.ts — do not fall
    // back to files[0]; show the placeholder instead.
    const prev = f('b.ts')
    const files = [f('x.ts'), f('y.ts')]
    assert.equal(resolveDefaultSelectedFile(files, prev), null)
  })

  it('matches by filename, not object identity', () => {
    // The freshly loaded list contains a different object with the same path;
    // we still consider it "the same selection" and keep the previous object.
    const prev = f('src/big.tsx')
    const files = [f('src/big.tsx'), f('src/small.tsx')]
    const result = resolveDefaultSelectedFile(files, prev)
    assert.equal(result, prev)
    assert.equal(result?.filename, 'src/big.tsx')
  })
})

describe('git history selection after async reload (explicit intent survives)', () => {
  const files = [f('a.ts'), f('large.py'), f('c.ts')]

  it('keeps the live selection when it still exists (no explicit intent needed)', () => {
    const prev = f('a.ts')
    assert.equal(resolveSelectionAfterReload(files, prev, null), prev)
  })

  it('honours the explicit selection when the live ref was transiently cleared', () => {
    // The core GLF-09c regression: switchRepo's async reload cleared the live
    // ref to null, but the user explicitly selected large.py. It must survive.
    const result = resolveSelectionAfterReload(files, null, 'large.py')
    assert.equal(result?.filename, 'large.py')
  })

  it('does NOT restore an explicit selection that is gone from the new list', () => {
    // Explicit intent points at a file the new repo/commit does not contain.
    assert.equal(resolveSelectionAfterReload(files, null, 'deleted.md'), null)
  })

  it('resolves to the placeholder on a fresh entry (no live, no explicit)', () => {
    // Entry / close / repo-switch clear the explicit intent, so a fresh open
    // still shows the placeholder — C's "no auto-expand on entry" is preserved.
    assert.equal(resolveSelectionAfterReload(files, null, null), null)
  })

  it('prefers the live selection over a stale explicit filename', () => {
    const prev = f('c.ts')
    const result = resolveSelectionAfterReload(files, prev, 'large.py')
    assert.equal(result, prev)
  })

  it('returns null for an empty list regardless of explicit intent', () => {
    assert.equal(resolveSelectionAfterReload<File>([], null, 'large.py'), null)
  })
})
