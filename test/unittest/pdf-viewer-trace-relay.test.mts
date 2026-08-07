/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 *
 * Unit tests for two things that guard the boundary between the embedded PDF
 * viewer and the rest of Onward:
 *
 *   1. `src/components/ProjectEditor/pdfViewerTrace.ts` — the relay that turns
 *      postMessage traffic from a sandboxed `file://` iframe into registered
 *      trace events. The iframe is a separate realm; everything it sends is
 *      untrusted input, and this is the only place that is enforced.
 *
 *   2. `infra/pdfjs-patches/patches.mjs` — the private patches on the vendored
 *      pdf.js build. They are what make hidden/OCR text detectable and keep
 *      Arabic in logical order. A pdf.js version bump silently reverts them,
 *      and the resulting text-selection regression is subtle enough to ship
 *      unnoticed, so "are they still applied?" is asserted here rather than
 *      left to a human remembering.
 *
 * Usage: node --experimental-strip-types --test test/unittest/pdf-viewer-trace-relay.test.mts
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'

import {
  VIEWER_TRACE_EVENTS,
  resolveViewerTraceEvent,
  sanitizeTracePayload
} from '../../src/components/ProjectEditor/pdfViewerTrace.ts'

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')

// ─────────────── PVT-U-01..05 event-name resolution ───────────────

test('PVT-U-01 known viewer events resolve to registered trace names', () => {
  const event = resolveViewerTraceEvent('text-selection.drag-committed')
  assert.equal(event, 'renderer:pdf-text-selection.drag-committed')
})

test('PVT-U-02 unknown names resolve to null instead of passing through', () => {
  // The whole reason the table exists. A stale iframe — or one serving a
  // tampered file:// document — must not be able to name its own events.
  assert.equal(resolveViewerTraceEvent('totally.made.up'), null)
  assert.equal(resolveViewerTraceEvent('renderer:terminal.pty-write'), null, 'no cross-surface spoofing')
  assert.equal(resolveViewerTraceEvent('__proto__'), null, 'prototype keys are not events')
  assert.equal(resolveViewerTraceEvent('constructor'), null)
})

test('PVT-U-03 non-string names resolve to null', () => {
  for (const bad of [null, undefined, 42, {}, [], true]) {
    assert.equal(resolveViewerTraceEvent(bad), null, `rejected: ${String(bad)}`)
  }
})

test('PVT-U-04 every mapped name follows the surface:feature.verb-noun convention', () => {
  // The project's registry convention is `<surface>:<feature>.<verb-noun>`,
  // lowercase-kebab. Enforced here rather than by review because a malformed
  // name is invisible until someone greps a trace and finds nothing.
  for (const [short, full] of Object.entries(VIEWER_TRACE_EVENTS)) {
    assert.match(full, /^renderer:pdf-[a-z-]+\.[a-z0-9-]+$/, `${short} -> ${full}`)
    assert.match(short, /^[a-z-]+\.[a-z0-9-]+$/, `${short} should be <feature>.<verb-noun>`)
  }
})

test('PVT-U-04b short names and registered names do not collide', () => {
  // Two viewer-side names mapping to the same registered event would make a
  // trace ambiguous about which code path fired.
  const registered = Object.values(VIEWER_TRACE_EVENTS)
  assert.equal(new Set(registered).size, registered.length, 'duplicate registered event name')
})

test('PVT-U-05 the viewer only emits names this table knows', () => {
  // Cross-check against the actual emit sites, so adding a `hooks.trace(...)`
  // call in the engine without registering it fails here rather than silently
  // producing an event that is dropped at runtime.
  const engine = readFileSync(join(REPO_ROOT, 'resources/pdfjs/app/text-selection.js'), 'utf8')
  const emitted = new Set(
    [...engine.matchAll(/hooks\.trace\(\s*"([^"]+)"/g)].map((match) => match[1])
  )
  assert.ok(emitted.size > 0, 'expected the engine to emit at least one trace event')
  for (const name of emitted) {
    assert.ok(
      Object.hasOwn(VIEWER_TRACE_EVENTS, name),
      `engine emits "${name}" but pdfViewerTrace.ts does not map it`
    )
  }
})

// ─────────────── PVT-U-06..11 payload sanitisation ───────────────

test('PVT-U-06 primitives survive intact', () => {
  assert.deepEqual(
    sanitizeTracePayload({ page: 3, horizontal: true, path: 'engine' }),
    { page: 3, horizontal: true, path: 'engine' }
  )
})

test('PVT-U-07 non-primitives are dropped, not serialised', () => {
  // Nested structures are how a payload becomes unbounded. Dropping beats
  // stringifying: a trace is a breadcrumb, not a data dump.
  assert.deepEqual(
    sanitizeTracePayload({ ok: 1, nested: { a: 1 }, list: [1, 2, 3], fn: () => {}, missing: null }),
    { ok: 1 }
  )
})

test('PVT-U-08 non-finite numbers are dropped', () => {
  // NaN / Infinity survive structured clone but break trace consumers.
  assert.deepEqual(
    sanitizeTracePayload({ good: 1, nan: NaN, inf: Infinity, negInf: -Infinity }),
    { good: 1 }
  )
})

test('PVT-U-09 long strings are truncated to the payload budget', () => {
  const result = sanitizeTracePayload({ error: 'x'.repeat(5000) })
  assert.equal((result.error as string).length, 120)
})

test('PVT-U-10 key count is capped', () => {
  const wide: Record<string, number> = {}
  for (let i = 0; i < 50; i += 1) wide[`k${i}`] = i
  assert.equal(Object.keys(sanitizeTracePayload(wide)).length, 8)
})

test('PVT-U-11 non-object payloads yield an empty object', () => {
  for (const bad of [null, undefined, 'string', 42, true, [1, 2, 3]]) {
    assert.deepEqual(sanitizeTracePayload(bad), {}, `rejected: ${String(bad)}`)
  }
})

test('PVT-U-12 a worst-case payload stays inside the ~1 KB budget', () => {
  // The project's diagnostic-trace rule caps payloads at roughly 1 KB after
  // JSON.stringify. 8 keys x 120 chars is the theoretical maximum this
  // sanitiser can emit; assert it rather than trusting the arithmetic.
  const hostile: Record<string, string> = {}
  for (let i = 0; i < 50; i += 1) hostile[`key-${i}`] = 'y'.repeat(5000)
  const size = JSON.stringify(sanitizeTracePayload(hostile)).length
  assert.ok(size <= 1200, `worst-case payload was ${size} bytes`)
})

// ─────────────── PVT-U-13..16 pdf.js patch integrity ───────────────

test('PVT-U-13 every declared pdf.js patch is present in the vendored build', async () => {
  const { PATCHES } = await import(join(REPO_ROOT, 'infra/pdfjs-patches/patches.mjs'))
  const cache = new Map<string, string>()
  const missing: string[] = []

  for (const patch of PATCHES) {
    if (!cache.has(patch.file)) {
      cache.set(patch.file, readFileSync(join(REPO_ROOT, 'resources/pdfjs', patch.file), 'utf8'))
    }
    if (!cache.get(patch.file)!.includes(patch.replace)) missing.push(`${patch.file} :: ${patch.id}`)
  }

  assert.deepEqual(
    missing,
    [],
    'pdf.js patches are missing — run: node scripts/apply-pdfjs-patches.mjs'
  )
})

test('PVT-U-14 the hidden-text patches are what the engine depends on', () => {
  // The engine keys off `data-pdf-invisible-text`, which only ever appears if
  // both halves of the hidden-text patch are in place: the worker computing
  // the flag and pdf.js writing it onto the span. Assert the DOM contract
  // directly, independent of the patch list.
  const viewerBuild = readFileSync(join(REPO_ROOT, 'resources/pdfjs/build/pdf.js'), 'utf8')
  const workerBuild = readFileSync(join(REPO_ROOT, 'resources/pdfjs/build/pdf.worker.js'), 'utf8')
  const engine = readFileSync(join(REPO_ROOT, 'resources/pdfjs/app/text-selection.js'), 'utf8')

  assert.ok(workerBuild.includes('isInvisibleText'), 'worker must compute the flag')
  assert.ok(viewerBuild.includes('pdfInvisibleText'), 'pdf.js must write it to the dataset')
  assert.ok(engine.includes('data-pdf-invisible-text'), 'the engine must read it back')
})

test('PVT-U-15 the altTextManager crash guard is in place', () => {
  // Without it, opening a second PDF in the same viewer throws and the load
  // is aborted — a hard, user-visible failure rather than a subtle one.
  const viewerBuild = readFileSync(join(REPO_ROOT, 'resources/pdfjs/build/pdf.js'), 'utf8')
  assert.ok(
    viewerBuild.includes('this.#altTextManager?.destroy()'),
    'expected the optional-chaining guard on altTextManager.destroy()'
  )
  assert.ok(
    !viewerBuild.includes('this.#altTextManager.destroy()'),
    'the unguarded call must be gone, not merely duplicated'
  )
})

test('PVT-U-16 patch metadata is complete enough to re-derive after a bump', async () => {
  // When a pdf.js upgrade breaks a hunk, whoever picks it up has only this
  // metadata to work from. An entry without a stated reason is a hunk that
  // will be dropped instead of re-derived.
  const { PATCHES, PATCH_GROUPS, PDFJS_VERSION } = await import(
    join(REPO_ROOT, 'infra/pdfjs-patches/patches.mjs')
  )
  assert.match(PDFJS_VERSION, /^\d+\.\d+\.\d+$/)
  const ids = new Set<string>()
  for (const patch of PATCHES) {
    assert.ok(patch.id && !ids.has(patch.id), `duplicate or missing id: ${patch.id}`)
    ids.add(patch.id)
    assert.ok(patch.why && patch.why.length > 30, `${patch.id} needs a real rationale`)
    assert.ok(Object.hasOwn(PATCH_GROUPS, patch.group), `${patch.id} has an unknown group`)
    assert.notEqual(patch.find, patch.replace, `${patch.id} is a no-op`)
  }
})
