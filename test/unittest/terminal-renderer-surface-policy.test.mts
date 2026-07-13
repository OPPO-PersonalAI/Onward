/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 *
 * Unit tests for the pure surface-restore decision table backing the
 * "keep WebGL alive across occlusion" renderer contract (2026-07-13
 * Space-switch white-flash fix). Pairs with the autotest layer:
 * `run-terminal-focus-activation` (TFA-19/20 keep-alive roundtrip +
 * restore-latency budget) and `run-render-corruption-stress`
 * (RCS-EPOCH-03 restore does not clear the shared atlas).
 *
 * Usage: node --experimental-strip-types --test test/unittest/terminal-renderer-surface-policy.test.mts
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  decideSurfaceRestoreAction,
  decideDocumentHiddenAction,
  type SurfaceRestoreState
} from '../../src/terminal/terminal-renderer-surface-policy.ts'

const state = (
  webglActive: boolean,
  contextLost: boolean,
  cooldownActive: boolean
): SurfaceRestoreState => ({ webglActive, contextLost, cooldownActive })

// ─────────── TRSP-U-01..08 full (webglActive × contextLost × cooldown) table ───────────

test('TRSP-U-01 live addon, healthy → refresh-only (never clear the shared atlas)', () => {
  assert.equal(decideSurfaceRestoreAction(state(true, false, false)), 'refresh-only')
})

test('TRSP-U-02 live addon, cooldown flag stale → still refresh-only', () => {
  assert.equal(decideSurfaceRestoreAction(state(true, false, true)), 'refresh-only')
})

test('TRSP-U-03 live addon, contextLost flag racing → still refresh-only (loss path disposes first)', () => {
  assert.equal(decideSurfaceRestoreAction(state(true, true, false)), 'refresh-only')
})

test('TRSP-U-04 live addon, both flags set → still refresh-only', () => {
  assert.equal(decideSurfaceRestoreAction(state(true, true, true)), 'refresh-only')
})

test('TRSP-U-05 no addon, context lost → defer (new addon on a dead context no-ops silently)', () => {
  assert.equal(decideSurfaceRestoreAction(state(false, true, false)), 'defer-context-lost')
})

test('TRSP-U-06 no addon, context lost AND cooldown → context-lost wins (more specific defer)', () => {
  assert.equal(decideSurfaceRestoreAction(state(false, true, true)), 'defer-context-lost')
})

test('TRSP-U-07 no addon, cooldown active → defer-cooldown (DOM fallback holds until expiry)', () => {
  assert.equal(decideSurfaceRestoreAction(state(false, false, true)), 'defer-cooldown')
})

test('TRSP-U-08 no addon, healthy → recreate WebGL', () => {
  assert.equal(decideSurfaceRestoreAction(state(false, false, false)), 'recreate-webgl')
})

// ─────────── TRSP-U-09 document-hidden contract ───────────

test('TRSP-U-09 document-hidden → keep-alive (occlusion never tears down GPU resources)', () => {
  assert.equal(decideDocumentHiddenAction(), 'keep-alive')
})
