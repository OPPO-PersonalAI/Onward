/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { resolveDefaultSelectedFile } from '../../src/components/GitHistoryViewer/defaultFileSelection.ts'

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
