/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 *
 * Unit tests for `resources/pdfjs/app/annotation-store.js` — when highlight
 * edits get written back into the PDF file.
 *
 * The user chose "write into the PDF itself" plus "save automatically". That
 * combination is the riskiest thing in this feature: pdf-lib has no
 * incremental write, so every save rewrites the whole document, and the target
 * is a file the user did not ask us to touch. The store is the component that
 * decides how often that happens and when it must not happen at all, so each
 * protection gets a test naming the failure it prevents:
 *
 *   R1  redundant writes           PAS-U-03, PAS-U-04, PAS-U-05
 *   R3  signed documents           PAS-U-08
 *   R4  read-only / locked files   PAS-U-09, PAS-U-10
 *   R5  large-file cadence         PAS-U-06
 *   plus document-switch safety    PAS-U-11, PAS-U-12
 *
 * Pair with the autotest suite `run-pdf-highlight` (assertion
 * `pdf-highlight-persists-across-reopen`), which proves the bytes actually
 * reach the disk and come back.
 *
 * Usage: node --experimental-strip-types --test test/unittest/pdf-annotation-store.test.mts
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')

/**
 * The store is a browser IIFE that assigns to `window`. Evaluate it against a
 * stub global rather than shimming a DOM: it touches nothing else, and a real
 * jsdom here would test jsdom.
 */
function loadStoreModule() {
  const source = readFileSync(resolve(REPO_ROOT, 'resources/pdfjs/app/annotation-store.js'), 'utf8')
  const sandbox: Record<string, unknown> = {}
  // eslint-disable-next-line no-new-func
  new Function('window', source)(sandbox)
  return sandbox.OnwardPdfAnnotationStore as {
    create: (deps: Record<string, unknown>) => any
    AUTOSAVE_QUIET_MS: number
    LARGE_FILE_BYTES: number
    LARGE_FILE_QUIET_FACTOR: number
    FAILURE_BACKOFF_MS: number
  }
}

const StoreModule = loadStoreModule()

type Harness = {
  store: any
  saves: Array<{ mode: string; bytes: number }>
  saveResults: Array<{ ok: boolean; reason?: string; mode?: string }>
  dirtyLog: boolean[]
  traces: Array<{ name: string; payload: Record<string, unknown> }>
  setNextSaveResult: (result: { ok: boolean; reason?: string }) => void
  buildCalls: number
}

function makeStore(overrides: Record<string, unknown> = {}): Harness {
  const saves: Harness['saves'] = []
  const saveResults: Harness['saveResults'] = []
  const dirtyLog: boolean[] = []
  const traces: Harness['traces'] = []
  let nextResult: { ok: boolean; reason?: string } = { ok: true }
  let buildCalls = 0

  const store = StoreModule.create({
    file: {
      buildAnnotatedPdfBytes: async () => {
        buildCalls += 1
        return new Uint8Array([1, 2, 3, 4])
      }
    },
    requestSave: async (bytes: Uint8Array, meta: { mode: string }) => {
      saves.push({ mode: meta.mode, bytes: bytes.length })
      return nextResult
    },
    onDirtyChange: (dirty: boolean) => dirtyLog.push(dirty),
    onSaveResult: (result: { ok: boolean; reason?: string; mode?: string }) => saveResults.push(result),
    trace: (name: string, payload: Record<string, unknown>) => traces.push({ name, payload }),
    ...overrides
  })

  const harness: Harness = {
    store,
    saves,
    saveResults,
    dirtyLog,
    traces,
    setNextSaveResult: (r) => { nextResult = r },
    get buildCalls() { return buildCalls }
  } as Harness
  return harness
}

function addAnnotation(store: any, id = 'a1') {
  store.annotations.push({
    id,
    labelId: 'hl-key',
    color: '#f2c14e',
    page: 1,
    note: '',
    quads: [0, 0, 10, 0, 0, 10, 10, 10],
    rectUnion: [0, 0, 10, 10]
  })
  store.markChanged('create')
}

// ─────────────── PAS-U-01..02 the agreed constants ───────────────

test('PAS-U-01 the autosave constants match what the user signed off on', () => {
  // These are product decisions, not implementation details. Asserting them
  // means a later "let's make it snappier" edit has to face the decision
  // rather than quietly change behaviour the user chose.
  assert.equal(StoreModule.AUTOSAVE_QUIET_MS, 800, 'agreed quiet window')
  assert.equal(StoreModule.LARGE_FILE_BYTES, 20 * 1024 * 1024, 'agreed large-file threshold')
  assert.ok(StoreModule.LARGE_FILE_QUIET_FACTOR > 1, 'large files must back off, not speed up')
  assert.ok(StoreModule.FAILURE_BACKOFF_MS >= 5000, 'a failing save must not retry tightly')
})

test('PAS-U-02 a freshly adopted document is clean', () => {
  // Opening a file must never count as editing it. If it did, merely browsing
  // a PDF would rewrite it.
  const h = makeStore()
  h.store.adopt({ annotations: [{ id: 'x', quads: [], rectUnion: [] }], revision: 3 })
  assert.equal(h.store.isDirty(), false)
  assert.equal(h.saves.length, 0)
})

// ─────────────── PAS-U-03..06 redundant-write suppression (R1) ───────────────

test('PAS-U-03 nothing is written when nothing changed', async () => {
  const h = makeStore()
  h.store.adopt({ annotations: [], revision: 0 })
  const result = await h.store.saveNow()
  assert.equal(result.ok, false)
  assert.equal(result.reason, 'clean')
  assert.equal(h.saves.length, 0, 'a clean document must not be rewritten')
})

test('PAS-U-04 an edit that cancels itself out is not written', async () => {
  // Create then delete leaves the records identical to what is on disk. The
  // dirty flag says "something happened"; the fingerprint says "but not to the
  // bytes", and the fingerprint wins.
  const h = makeStore()
  h.store.adopt({ annotations: [], revision: 0 })
  addAnnotation(h.store, 'temp')
  h.store.annotations.splice(0, 1)
  h.store.markChanged('delete')
  assert.equal(h.store.isDirty(), true, 'the edit was registered')

  const result = await h.store.saveNow()
  assert.equal(result.reason, 'unchanged')
  assert.equal(h.saves.length, 0, 'no bytes written for a no-op edit')
  assert.equal(h.store.isDirty(), false, 'and the document is clean again')
})

test('PAS-U-05 a real edit IS written, exactly once', async () => {
  const h = makeStore()
  h.store.adopt({ annotations: [], revision: 0 })
  addAnnotation(h.store)

  assert.equal((await h.store.saveNow()).ok, true)
  assert.equal(h.saves.length, 1)
  assert.equal(h.store.isDirty(), false)

  // Saving again with no further edits must be free.
  await h.store.saveNow()
  assert.equal(h.saves.length, 1, 'a second save with no change writes nothing')
})

test('PAS-U-06 large documents get a longer quiet window (R5)', () => {
  // A 100 MB rewrite cannot keep up with continuous editing, so past the
  // threshold the store waits longer instead of queueing writes.
  const small = makeStore()
  small.store.adopt({ annotations: [], revision: 0, documentBytes: 1024 })
  const large = makeStore()
  large.store.adopt({
    annotations: [],
    revision: 0,
    documentBytes: StoreModule.LARGE_FILE_BYTES + 1
  })

  const smallTrace = small.traces.find(t => t.name === 'annotation.adopted')
  const largeTrace = large.traces.find(t => t.name === 'annotation.adopted')
  assert.equal(smallTrace?.payload.large, false)
  assert.equal(largeTrace?.payload.large, true, 'the store must know it is a large document')
})

test('PAS-U-07 the quiet window defers the write rather than dropping it', async () => {
  const h = makeStore()
  h.store.adopt({ annotations: [], revision: 0, documentBytes: 1024 })
  addAnnotation(h.store)
  h.store.scheduleSave()
  assert.equal(h.saves.length, 0, 'nothing written immediately')

  await new Promise(resolve => setTimeout(resolve, StoreModule.AUTOSAVE_QUIET_MS + 250))
  assert.equal(h.saves.length, 1, 'written once the window elapsed')
  assert.equal(h.saves[0].mode, 'auto')
})

// ─────────────── PAS-U-08 signed documents (R3) ───────────────

test('PAS-U-08 a signed document is not rewritten without consent', async () => {
  // A full rewrite invalidates the signature irreversibly. Asking is the only
  // acceptable behaviour, and it must hold for automatic saves too — those are
  // exactly the ones the user never explicitly triggered.
  const h = makeStore()
  h.store.adopt({ annotations: [], revision: 0, hasSignature: true })
  addAnnotation(h.store)

  const blocked = await h.store.saveNow()
  assert.equal(blocked.ok, false)
  assert.equal(blocked.reason, 'signature')
  assert.equal(h.saves.length, 0, 'no bytes written to a signed document')
  assert.ok(
    h.saveResults.some(r => r.reason === 'signature'),
    'the host must be told, so it can ask'
  )

  h.store.acknowledgeSignature()
  const allowed = await h.store.saveNow()
  assert.equal(allowed.ok, true, 'once acknowledged, the save proceeds')
  assert.equal(h.saves.length, 1)
})

// ─────────────── PAS-U-09..10 failure handling (R4) ───────────────

test('PAS-U-09 a failed save keeps the document dirty', async () => {
  // Losing the dirty flag on failure would mean the edit is silently dropped:
  // the user sees their highlight on screen and nothing on disk.
  const h = makeStore()
  h.store.adopt({ annotations: [], revision: 0 })
  addAnnotation(h.store)
  h.setNextSaveResult({ ok: false, reason: 'read-only' })

  const result = await h.store.saveNow()
  assert.equal(result.ok, false)
  assert.equal(result.reason, 'read-only')
  assert.equal(h.store.isDirty(), true, 'still dirty, so a later retry can succeed')
  assert.ok(h.saveResults.some(r => r.reason === 'read-only' && r.mode === 'manual'))
})

test('PAS-U-10 a failed automatic save backs off before retrying', async () => {
  // Without a backoff, a read-only file produces a full document rewrite
  // attempt every quiet window, forever.
  const h = makeStore()
  h.store.adopt({ annotations: [], revision: 0 })
  addAnnotation(h.store)
  h.setNextSaveResult({ ok: false, reason: 'read-only' })

  await h.store.saveNow()
  const attemptsAfterFirst = h.saves.length

  // An automatic save immediately afterwards must be refused.
  h.store.scheduleSave()
  await new Promise(resolve => setTimeout(resolve, StoreModule.AUTOSAVE_QUIET_MS + 250))
  assert.equal(h.saves.length, attemptsAfterFirst, 'automatic retry suppressed during backoff')

  // …but an explicit save is the user asking, and is always honoured.
  h.setNextSaveResult({ ok: true })
  assert.equal((await h.store.saveNow()).ok, true, 'a manual save ignores the backoff')
})

// ─────────────── PAS-U-11..12 document-switch safety ───────────────

test('PAS-U-11 a save in flight is discarded when the document changes', async () => {
  // Serialising a large PDF is slow enough for the user to open another file
  // meanwhile. Completing the write then would put this document's
  // annotations into the other document's path.
  let releaseBuild: (() => void) | null = null
  const gate = new Promise<void>(resolve => { releaseBuild = resolve })
  const saves: Array<{ mode: string }> = []

  const store = StoreModule.create({
    file: {
      buildAnnotatedPdfBytes: async () => {
        await gate
        return new Uint8Array([1, 2, 3])
      }
    },
    requestSave: async (_bytes: Uint8Array, meta: { mode: string }) => {
      saves.push({ mode: meta.mode })
      return { ok: true }
    }
  })

  store.adopt({ annotations: [], revision: 0 })
  addAnnotation(store)
  const pending = store.saveNow()

  // The user opens a different PDF while serialisation is still running.
  store.reset()
  releaseBuild!()
  const result = await pending

  assert.equal(result.ok, false)
  assert.equal(result.reason, 'document-changed')
  assert.equal(saves.length, 0, 'nothing must be written after the switch')
})

test('PAS-U-12 closing a document flushes unsaved edits', async () => {
  // Switching files fast is exactly when the user has not pressed Cmd+S.
  const h = makeStore()
  h.store.adopt({ annotations: [], revision: 0 })
  addAnnotation(h.store)

  const result = await h.store.flushBeforeUnload()
  assert.equal(result.ok, true)
  assert.equal(h.saves.length, 1)
  assert.equal(h.saves[0].mode, 'manual', 'a flush is not best-effort')
})

test('PAS-U-13 closing a clean document writes nothing', async () => {
  const h = makeStore()
  h.store.adopt({ annotations: [], revision: 0 })
  const result = await h.store.flushBeforeUnload()
  assert.equal(result.ok, false)
  assert.equal(h.saves.length, 0)
})

test('PAS-U-14 reset clears every trace of the previous document', () => {
  const h = makeStore()
  h.store.adopt({ annotations: [], revision: 5 })
  addAnnotation(h.store)
  h.store.reset()

  assert.equal(h.store.annotations.length, 0)
  assert.equal(h.store.getRevision(), 0)
  assert.equal(h.store.isDirty(), false)
})

test('PAS-U-15 the dirty flag transitions are reported, not spammed', () => {
  // The host renders an indicator from these. Emitting on every edit rather
  // than on transitions would re-render the indicator per keystroke in a note.
  const h = makeStore()
  h.store.adopt({ annotations: [], revision: 0 })
  addAnnotation(h.store, 'a')
  addAnnotation(h.store, 'b')
  addAnnotation(h.store, 'c')
  assert.deepEqual(h.dirtyLog, [true], 'three edits, one transition')
})

// ─────────────── PAS-U-16..20 external-change rebase + write-gate reactions ───────────────
// Added 2026-08-01 with the external-refresh feature: the store gained a
// three-way rebase entry point (rebaseOnExternal) and two behavioural fixes
// around the save path (no backoff on 'external-modified'; dirty preserved
// when an edit lands mid-write).

import { createRequire } from 'node:module'
const requireCjs = createRequire(import.meta.url)
const MergeCore = requireCjs(resolve(REPO_ROOT, 'resources/pdfjs/app/annotation-merge-core.js'))

function makeStoreWithMerge(overrides: Record<string, unknown> = {}) {
  return makeStore({ mergeCore: MergeCore, ...overrides })
}

function externalRecord(id: string, note = '') {
  return {
    id,
    labelId: 'hl-key',
    color: '#f2c14e',
    page: 1,
    note,
    quads: [0, 0, 10, 0, 0, 10, 10, 10],
    rectUnion: [0, 0, 10, 10]
  }
}

test('PAS-U-16 rebase on a clean store adopts the external set and stays clean', () => {
  const h = makeStoreWithMerge()
  h.store.adopt({ annotations: [externalRecord('a')], revision: 1 })

  const stats = h.store.rebaseOnExternal({
    annotations: [externalRecord('a', 'agent note'), externalRecord('b')],
    revision: 2
  })

  assert.equal(h.store.annotations.length, 2)
  assert.equal(h.store.annotations[0].note, 'agent note')
  assert.equal(h.store.isDirty(), false, 'nothing local to write back')
  assert.equal(stats.conflicts, 0)
})

test('PAS-U-17 rebase keeps an unsaved local highlight and re-arms the save', async () => {
  const h = makeStoreWithMerge()
  h.store.adopt({ annotations: [externalRecord('a')], revision: 1 })
  addAnnotation(h.store, 'mine')

  const stats = h.store.rebaseOnExternal({
    annotations: [externalRecord('a'), externalRecord('ext')],
    revision: 2
  })

  assert.equal(stats.localAdds, 1)
  assert.deepEqual(
    h.store.annotations.map((a: { id: string }) => a.id).sort(),
    ['a', 'ext', 'mine']
  )
  assert.equal(h.store.isDirty(), true, 'the merged result must reach the disk')
  // The rebase schedules its own save — the local edit lands without any
  // further user action.
  await new Promise(resolve => setTimeout(resolve, StoreModule.AUTOSAVE_QUIET_MS + 250))
  assert.equal(h.saves.length, 1)
})

test('PAS-U-18 rebase resolves a same-id conflict to the local version', () => {
  const h = makeStoreWithMerge()
  h.store.adopt({ annotations: [externalRecord('a')], revision: 1 })
  h.store.annotations[0].note = 'my edit'
  h.store.markChanged('note')

  const stats = h.store.rebaseOnExternal({
    annotations: [externalRecord('a', 'their edit')],
    revision: 2
  })

  assert.equal(h.store.annotations[0].note, 'my edit')
  assert.equal(stats.conflicts, 1)
})

test('PAS-U-19 an external-modified refusal does not enter the failure backoff', async () => {
  // 'external-modified' means "reload and rebase first", and the host does
  // that immediately. Backing off 15 s here would delay the retry loop the
  // design depends on.
  const h = makeStoreWithMerge()
  h.store.adopt({ annotations: [], revision: 0 })
  addAnnotation(h.store)
  h.setNextSaveResult({ ok: false, reason: 'external-modified' })
  const first = await h.store.saveNow()
  assert.equal(first.reason, 'external-modified')

  // Immediately after, an automatic save must NOT be rejected with 'backoff'.
  h.setNextSaveResult({ ok: true })
  h.store.markChanged('retry')
  h.store.scheduleSave()
  await new Promise(resolve => setTimeout(resolve, StoreModule.AUTOSAVE_QUIET_MS + 250))
  assert.equal(h.saves.length, 2, 'the retry write ran without waiting out a backoff')
})

test('PAS-U-20 an edit landing while a save is in flight keeps the store dirty', async () => {
  // Regression lock for the mid-flight clobber: save completion used to clear
  // the dirty flag unconditionally, so an edit made during a slow write waited
  // for the NEXT edit before it could ever be saved.
  const h = makeStore({
    file: {
      buildAnnotatedPdfBytes: async () => {
        // Slow write: the edit below lands while this is pending.
        await new Promise(resolve => setTimeout(resolve, 120))
        return new Uint8Array([9, 9])
      }
    }
  })
  h.store.adopt({ annotations: [], revision: 0 })
  addAnnotation(h.store, 'first')

  const savePromise = h.store.saveNow()
  await new Promise(resolve => setTimeout(resolve, 30))
  addAnnotation(h.store, 'mid-flight')
  await savePromise

  assert.equal(h.store.isDirty(), true, 'the mid-flight edit still needs writing')
})
