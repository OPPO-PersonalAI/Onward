/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 *
 * Structural guards on the embedded PDF viewer's module boundaries.
 *
 * These exist because of two real defects found while building the highlight
 * layer, both of which type-checked, linted and syntax-checked cleanly and
 * only surfaced when a full app build actually ran the code:
 *
 *   1. `highlight.js` read `textSelectionDragState`, a private variable of
 *      `text-selection.js`. In the browser that is a ReferenceError that kills
 *      the whole selection path — the autotest suite silently produced zero
 *      assertions.
 *   2. `highlight.js` did `store.annotations = store.annotations.filter(...)`.
 *      The store exposes `annotations` as a getter over the array it owns, so
 *      the assignment throws in strict mode AND would have handed the store a
 *      different array than the one it fingerprints for save decisions —
 *      meaning deletions could never be persisted.
 *
 * Both are the same shape of mistake: code lifted from a single-file reference
 * implementation, where everything was a file-level global, into modules that
 * each own their state.
 *
 * PMB-U-01 runs on REAL scope analysis (acorn + js-scope-analysis.mts):
 * "module B references a name that is private factory state of module A and
 * free (unbound) in B". The original regex/indentation heuristic needed a
 * name-length blocklist to stay quiet and could both miss leaks and cry wolf
 * on locals; the analyzer needs neither, and PMB-U-06/07 keep IT honest with
 * a built-in positive/negative control.
 *
 * Usage: node --experimental-strip-types --test test/unittest/pdf-viewer-module-boundaries.test.mts
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'
import { analyzeModule } from './js-scope-analysis.mts'

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const APP_DIR = join(REPO_ROOT, 'resources/pdfjs/app')

const MODULES = [
  'text-selection.js',
  'text-selection-core.js',
  'highlight.js',
  'highlight-core.js',
  'annotation-file.js',
  'annotation-merge-core.js',
  'annotation-store.js',
  'outline-follow-core.js',
  'reload-core.js'
] as const

/** Strip comments and string literals so matches come from code, not prose.
 *  Still used by the string-level checks (PMB-U-02..04). */
function codeOf(file: string): string {
  return readFileSync(join(APP_DIR, file), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '')
    .replace(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`/g, '""')
}

const sources = new Map(MODULES.map((file) => [file, codeOf(file)]))
const rawSources = new Map(MODULES.map((file) => [file, readFileSync(join(APP_DIR, file), 'utf8')]))

/**
 * Cross-module leak detection over real scope analysis: names that are
 * factory-private mutable state of one module AND appear as free (unbound)
 * identifiers in another. No blocklists needed — a same-named local in the
 * other module is bound there and never reaches the free set.
 */
function findCrossModuleLeaks(
  analyses: Map<string, { freeIdentifiers: Set<string>; factoryState: Set<string> }>
): string[] {
  const violations: string[] = []
  for (const [owner, ownerAnalysis] of analyses) {
    if (ownerAnalysis.factoryState.size === 0) continue
    for (const [other, otherAnalysis] of analyses) {
      if (other === owner) continue
      for (const name of ownerAnalysis.factoryState) {
        if (otherAnalysis.freeIdentifiers.has(name)) {
          violations.push(`${other} references ${owner}'s private state \`${name}\``)
        }
      }
    }
  }
  return violations.sort()
}

const analyses = new Map(
  MODULES.map((file) => [file as string, analyzeModule(rawSources.get(file)!)])
)

// ─────────────── PMB-U-01 no cross-module state reads ───────────────

test('PMB-U-01 no module reads another module\'s private state', () => {
  assert.deepEqual(
    findCrossModuleLeaks(analyses),
    [],
    'cross-module state leak — pass it through the injected dependency surface instead'
  )
})

// ─────────────── PMB-U-02 the store's array is never reassigned ───────────────

test('PMB-U-02 nobody reassigns store.annotations', () => {
  // The store hands out its own array via a getter and fingerprints THAT array
  // to decide whether a save is needed. Replacing it throws in strict mode, and
  // even if it did not, the store would keep watching an array nobody mutates
  // any more — edits would stop being persisted with no error anywhere.
  for (const file of MODULES) {
    const code = sources.get(file)!
    const matches = [...code.matchAll(/store\.annotations\s*=(?!=)/g)]
    assert.equal(
      matches.length,
      0,
      `${file} assigns to store.annotations; mutate the array in place instead`
    )
  }
})

// ─────────────── PMB-U-03 modules only reach out through their deps ───────────────

test('PMB-U-03 every module exposes itself on exactly one window global', () => {
  // The viewer loads these as plain <script> tags, so the only linkage is a
  // window property. Two modules claiming the same name, or a module claiming
  // none, both fail silently at load time.
  const claimed = new Map<string, string>()
  for (const file of MODULES) {
    const code = sources.get(file)!
    const names = [...code.matchAll(/window\.(Onward[A-Za-z]+)\s*=/g)].map((m) => m[1])
    assert.equal(names.length >= 1, true, `${file} does not export a window global`)
    for (const name of names) {
      assert.equal(claimed.has(name), false, `${name} claimed by both ${claimed.get(name)} and ${file}`)
      claimed.set(name, file)
    }
  }
})

test('PMB-U-04 core modules stay loadable outside a browser', () => {
  // The `-core` modules are the unit-testable layer. If one starts touching
  // `document`, it stops being loadable under plain Node and the tests that
  // depend on it quietly become impossible to write.
  for (const file of ['text-selection-core.js', 'highlight-core.js', 'outline-follow-core.js', 'annotation-merge-core.js', 'reload-core.js']) {
    const code = sources.get(file)!
    assert.equal(
      /(?<![.\w$])document(?![\w$])/.test(code),
      false,
      `${file} touches document; it must stay DOM-free`
    )
    // `window` appears only in the UMD-style export preamble.
    const windowRefs = [...code.matchAll(/(?<![.\w$])window(?![\w$])/g)].length
    assert.ok(windowRefs <= 2, `${file} references window ${windowRefs} times; expected only the export guard`)
  }
})

test('PMB-U-05 the viewer html loads every module, in dependency order', () => {
  // A module missing from the page is a runtime ReferenceError at startup; a
  // module loaded before its dependency is the same error, one line later.
  const html = readFileSync(join(APP_DIR, 'viewer.html'), 'utf8')
  const order = [...html.matchAll(/<script src="(?:\.\.\/vendor\/|\.\/)([^"]+)"/g)].map((m) => m[1])

  for (const file of MODULES) {
    assert.ok(order.includes(file), `${file} is never loaded by viewer.html`)
  }

  const positionOf = (name: string) => order.indexOf(name)
  assert.ok(positionOf('text-selection-core.js') < positionOf('text-selection.js'))
  assert.ok(positionOf('highlight-core.js') < positionOf('highlight.js'))
  assert.ok(positionOf('highlight-core.js') < positionOf('annotation-file.js'), 'annotation-file destructures the highlight core')
  assert.ok(positionOf('pdf-lib.min.js') < positionOf('annotation-file.js'), 'pdf-lib must load before the writer')
  assert.ok(positionOf('annotation-store.js') < positionOf('viewer.js'), 'viewer.js constructs the store')
  assert.ok(positionOf('annotation-merge-core.js') < positionOf('annotation-store.js'), 'the store consumes the merge core via deps')
  assert.ok(positionOf('reload-core.js') < positionOf('viewer.js'), 'viewer.js reads window.OnwardPdfReloadCore at load')
})

// ─────────────── PMB-U-06/07 the analyzer's own controls ───────────────
// A guard that silently stops guarding is worse than no guard. These two run
// the leak detector against synthetic modules with a KNOWN leak and a KNOWN
// benign name collision, so a regression in the scope analysis fails loudly
// here instead of quietly passing PMB-U-01 forever.

// Mirrors the REAL module architecture: state lives inside the exported
// create(deps) factory, not at the IIFE top level. The first version of these
// controls used a bare IIFE `let` — the analyzer passed them while computing
// an EMPTY state set for every real module, i.e. the guard was vacuously
// green. Controls must mirror the architecture they certify.
const LEAKY_OWNER = `
(function () {
  function create(deps) {
    let secretDragState = null;
    function attach() { secretDragState = { active: true }; }
    return { attach: attach };
  }
  window.OwnerModule = { create: create };
})();
`

const LEAKY_CONSUMER = `
(function () {
  function readOther() { return secretDragState.active; }
  window.ConsumerModule = { readOther: readOther };
})();
`

const CLEAN_CONSUMER = `
(function () {
  function readOwn() {
    let secretDragState = { active: false };
    for (const secretLoop of [secretDragState]) { void secretLoop; }
    return secretDragState.active;
  }
  window.CleanModule = { readOwn: readOwn };
})();
`

test('PMB-U-06 the analyzer catches the original leak shape (positive control)', () => {
  const controls = new Map([
    ['owner.js', analyzeModule(LEAKY_OWNER)],
    ['consumer.js', analyzeModule(LEAKY_CONSUMER)]
  ])
  assert.deepEqual(findCrossModuleLeaks(controls), [
    "consumer.js references owner.js's private state `secretDragState`"
  ])
})

test('PMB-U-07 a same-named LOCAL in another module is not a leak (negative control)', () => {
  const controls = new Map([
    ['owner.js', analyzeModule(LEAKY_OWNER)],
    ['clean.js', analyzeModule(CLEAN_CONSUMER)]
  ])
  assert.deepEqual(findCrossModuleLeaks(controls), [])
})
