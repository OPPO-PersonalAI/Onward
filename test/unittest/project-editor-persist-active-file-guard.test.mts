/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 *
 * Unit tests for the cross-Task persist guard: the single shared editor
 * instance may still display Task X's file while Task Y persists; the guard
 * refuses to write a foreign active file into Y's state key.
 * Paired autotest: run-project-editor-multi-terminal-scope-autotest.sh
 * (PEMS-26 same-root no-contamination scenario).
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { resolvePersistableActiveFile } from '../../src/components/ProjectEditor/projectEditorRestoreUtils.ts'

const FILE = '/repo/doc.md'
const SCOPE_A = JSON.stringify(['t1', '/repo'])
const SCOPE_B = JSON.stringify(['t2', '/repo'])

test('PPAF-U-01 persists when the active file was opened under the persisting scope', () => {
  assert.equal(
    resolvePersistableActiveFile({ activeFilePath: FILE, activeFileScopeKey: SCOPE_A, persistScopeKey: SCOPE_A }),
    FILE
  )
})

test('PPAF-U-02 refuses a file owned by another scope (same-root Task switch)', () => {
  assert.equal(
    resolvePersistableActiveFile({ activeFilePath: FILE, activeFileScopeKey: SCOPE_A, persistScopeKey: SCOPE_B }),
    null
  )
})

test('PPAF-U-03 no active file → nothing to persist', () => {
  assert.equal(
    resolvePersistableActiveFile({ activeFilePath: null, activeFileScopeKey: SCOPE_A, persistScopeKey: SCOPE_A }),
    null
  )
})

test('PPAF-U-04 unknown ownership is refused (strict: every activation path tags the owner)', () => {
  assert.equal(
    resolvePersistableActiveFile({ activeFilePath: FILE, activeFileScopeKey: null, persistScopeKey: SCOPE_A }),
    null
  )
})

test('PPAF-U-05 unkeyable persist scope is refused', () => {
  assert.equal(
    resolvePersistableActiveFile({ activeFilePath: FILE, activeFileScopeKey: SCOPE_A, persistScopeKey: null }),
    null
  )
})
