/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 *
 * Usage: node --experimental-strip-types --test test/unittest/modal-dismiss.test.mts
 *
 * Locks the pure cancel-key predicate of the unified modal dismiss policy
 * (`isModalCancelKey`): which keydown events may cancel an open modal.
 * This is the "math" half of the paired deliverable; the "wiring" half
 * (backdrop clicks stay inert, ESC cancels each dialog) is locked by
 * run-modal-dismiss-autotest (MDM-*).
 */

import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

import {
  isModalCancelKey,
  isAnyModalOpen,
  registerOpenModal,
  unregisterOpenModal,
  resetOpenModalRegistryForTest
} from '../../src/utils/modal-dismiss.ts'

test('MDP-U-01 Escape cancels', () => {
  assert.equal(isModalCancelKey({ key: 'Escape' }), true)
})

test('MDP-U-02 Escape with explicit isComposing=false cancels', () => {
  assert.equal(isModalCancelKey({ key: 'Escape', isComposing: false }), true)
})

test('MDP-U-03 Escape during IME composition must NOT cancel', () => {
  // ESC inside an active IME session only cancels the composition;
  // swallowing the dialog as well would double-act one keypress.
  assert.equal(isModalCancelKey({ key: 'Escape', isComposing: true }), false)
})

test('MDP-U-04 Enter never cancels', () => {
  assert.equal(isModalCancelKey({ key: 'Enter' }), false)
})

test('MDP-U-05 plain characters never cancel', () => {
  for (const key of ['a', 'q', ' ', 'Backspace', 'Delete', 'Tab']) {
    assert.equal(isModalCancelKey({ key }), false, `key=${JSON.stringify(key)}`)
  }
})

test('MDP-U-06 legacy/lookalike key names never cancel', () => {
  // Chromium always reports 'Escape'; 'Esc' (legacy IE/Edge) and the
  // IME-intermediate 'Process' name must not be treated as cancel.
  for (const key of ['Esc', 'escape', 'Process', 'Unidentified']) {
    assert.equal(isModalCancelKey({ key }), false, `key=${JSON.stringify(key)}`)
  }
})

// Open-modal registry: subpage-host ESC (capture-phase) yields while any
// modal is registered — the layering half of the unified dismiss policy.

beforeEach(() => {
  resetOpenModalRegistryForTest()
})

test('MDP-U-07 registry starts empty', () => {
  assert.equal(isAnyModalOpen(), false)
})

test('MDP-U-08 register/unregister round-trip', () => {
  registerOpenModal()
  assert.equal(isAnyModalOpen(), true)
  unregisterOpenModal()
  assert.equal(isAnyModalOpen(), false)
})

test('MDP-U-09 nested modals stay open until the last unregisters', () => {
  registerOpenModal()
  registerOpenModal()
  unregisterOpenModal()
  assert.equal(isAnyModalOpen(), true, 'one of two modals still open')
  unregisterOpenModal()
  assert.equal(isAnyModalOpen(), false)
})

test('MDP-U-10 unbalanced unregister clamps at zero (no negative leak)', () => {
  unregisterOpenModal()
  assert.equal(isAnyModalOpen(), false)
  registerOpenModal()
  assert.equal(isAnyModalOpen(), true, 'a later register must still count after an unbalanced unregister')
  unregisterOpenModal()
  assert.equal(isAnyModalOpen(), false)
})
