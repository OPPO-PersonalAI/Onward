/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 *
 * Unit tests for `resources/pdfjs/app/reload-core.js` — the pure decisions
 * behind the external-change in-place reload (dedup by version token, retry
 * schedule, view-state snapshot/restore with page clamping).
 *
 * Usage: node --experimental-strip-types --test test/unittest/pdf-reload-core.test.mts
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const require = createRequire(import.meta.url)
const core = require(resolve(REPO_ROOT, 'resources/pdfjs/app/reload-core.js'))

// ─────────────── PRC-U-01..03 version token parsing ───────────────

test('PRC-U-01 parses the v token from a file URL query', () => {
  assert.equal(core.parseVersionToken('file:///a/b.pdf?v=123'), '123')
  assert.equal(core.parseVersionToken('file:///a/b.pdf?name=x&v=9'), '9')
})

test('PRC-U-02 no query, no v, or empty v all read as null', () => {
  assert.equal(core.parseVersionToken('file:///a/b.pdf'), null)
  assert.equal(core.parseVersionToken('file:///a/b.pdf?name=x'), null)
  assert.equal(core.parseVersionToken('file:///a/b.pdf?v='), null)
  assert.equal(core.parseVersionToken(undefined), null)
})

test('PRC-U-03 v is matched as a whole key, not a suffix', () => {
  // A `?rev=5` must not be read as `v=5`.
  assert.equal(core.parseVersionToken('file:///a/b.pdf?rev=5'), null)
})

// ─────────────── PRC-U-04..06 reload dedup ───────────────

test('PRC-U-04 identical version to the active document is a no-op', () => {
  const decision = core.shouldStartReload({
    requestedUrl: 'file:///a/b.pdf?v=100',
    activeUrl: 'file:///a/b.pdf?v=100',
    inFlightUrl: null
  })
  assert.equal(decision.start, false)
  assert.equal(decision.reason, 'same-version')
})

test('PRC-U-05 identical version to an in-flight reload is a no-op', () => {
  const decision = core.shouldStartReload({
    requestedUrl: 'file:///a/b.pdf?v=200',
    activeUrl: 'file:///a/b.pdf?v=100',
    inFlightUrl: 'file:///a/b.pdf?v=200'
  })
  assert.equal(decision.start, false)
  assert.equal(decision.reason, 'already-loading')
})

test('PRC-U-06 a new version — or an unknown one — always reloads', () => {
  assert.equal(
    core.shouldStartReload({
      requestedUrl: 'file:///a/b.pdf?v=300',
      activeUrl: 'file:///a/b.pdf?v=100',
      inFlightUrl: null
    }).start,
    true
  )
  // Unknown tokens on either side: better one redundant load than a stale
  // document.
  assert.equal(
    core.shouldStartReload({
      requestedUrl: 'file:///a/b.pdf',
      activeUrl: 'file:///a/b.pdf?v=100',
      inFlightUrl: null
    }).start,
    true
  )
})

// ─────────────── PRC-U-07 retry schedule ───────────────

test('PRC-U-07 one retry after 1 s, then give up silently (SumatraPDF semantics)', () => {
  assert.deepEqual(core.nextRetryDecision(1), { retry: true, delayMs: 1000 })
  assert.deepEqual(core.nextRetryDecision(2), { retry: false, delayMs: 0 })
  assert.deepEqual(core.nextRetryDecision(0), { retry: false, delayMs: 0 })
  assert.deepEqual(core.nextRetryDecision(Number.NaN), { retry: false, delayMs: 0 })
})

// ─────────────── PRC-U-08..12 view-state snapshot + restore ───────────────

test('PRC-U-08 snapshot keeps finite values and drops garbage', () => {
  const state = core.captureViewState({ pageNumber: 7, scrollTop: 1234.5, scaleSetting: 'page-width' })
  assert.deepEqual(state, { page: 7, scrollTop: 1234.5, scale: 'page-width' })
  assert.deepEqual(core.captureViewState({ pageNumber: Number.NaN, scrollTop: -5, scaleSetting: 0 }), {})
})

test('PRC-U-09 numeric custom zoom survives as its string form', () => {
  // pdf.js accepts numeric strings for currentScaleValue; a 137% custom zoom
  // must come back as 137%, not fall back to auto.
  const state = core.captureViewState({ pageNumber: 1, scrollTop: 0, scaleSetting: 1.37 })
  assert.equal(state.scale, '1.37')
})

test('PRC-U-10 restore clamps the page when the new version is shorter', () => {
  const restore = core.buildRestoreState({ page: 40, scrollTop: 9999, scale: 'auto' }, 12)
  assert.equal(restore.page, 12)
  // The scroll offset belonged to page 40's layout; carrying it to a clamped
  // page would land somewhere arbitrary.
  assert.equal(restore.scrollTop, undefined)
})

test('PRC-U-11 restore keeps page + scroll + scale when the page still exists', () => {
  const restore = core.buildRestoreState({ page: 7, scrollTop: 1234, scale: '1.37' }, 30)
  assert.deepEqual(restore, { page: 7, scrollTop: 1234, scale: '1.37' })
})

test('PRC-U-12 restore tolerates an empty snapshot (falls back to page 1)', () => {
  const restore = core.buildRestoreState({}, 5)
  assert.equal(restore.page, 1)
  assert.equal(restore.scrollTop, undefined)
  assert.equal(restore.scale, undefined)
})
