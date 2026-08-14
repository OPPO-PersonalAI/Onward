/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 *
 * Guards the CSS custom-property contract: every `var(--x)` a stylesheet
 * references must actually be defined somewhere.
 *
 * This exists because of a real, user-visible defect. `--panel-elevated`,
 * `--line`, `--muted`, `--text` and `--background` were referenced ~130 times
 * across component stylesheets and defined ZERO times. An unresolvable
 * `var()` makes the entire declaration invalid at computed-value time, so
 * those rules lost their background / border / colour outright — the label
 * management dialog rendered fully transparent, and it shipped because
 * nothing in the pipeline reads CSS: TypeScript doesn't, the linters don't,
 * and the autotests assert on DOM structure rather than on painted colour.
 *
 * A typo'd variable name is exactly the same failure, is equally invisible,
 * and is caught here in milliseconds.
 *
 * Usage: node --experimental-strip-types --test test/unittest/css-variable-contract.test.mts
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join, relative, resolve } from 'node:path'

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const SRC_DIR = join(REPO_ROOT, 'src')

function collectCssFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) collectCssFiles(full, out)
    else if (entry.endsWith('.css')) out.push(full)
  }
  return out
}

const cssFiles = collectCssFiles(SRC_DIR)

/** Names declared as `--x: …` anywhere in the renderer's stylesheets. */
function collectDefinedInCss(): Set<string> {
  const defined = new Set<string>()
  for (const file of cssFiles) {
    const source = readFileSync(file, 'utf8')
    for (const match of source.matchAll(/(--[\w-]+)\s*:/g)) defined.add(match[1])
  }
  return defined
}

/**
 * Names written onto documentElement at runtime by the theme applier. These
 * are the authoritative themeable set; a stylesheet may rely on them even
 * though no CSS file declares them.
 */
function collectThemeInjected(): Set<string> {
  const source = readFileSync(join(SRC_DIR, 'utils', 'theme-applier.ts'), 'utf8')
  // Anchor on the array literal's `= [`, not on the first `]` after the
  // identifier: the declaration reads `const THEME_VARS: (keyof ThemeColors)[]
  // = [ … ]`, so the type annotation's own brackets come first and slicing to
  // them yields an empty block (which is exactly what CSSV-U-01 exists to
  // catch — a silently empty injected set would make CSSV-U-02 vacuous).
  const declaration = source.indexOf('THEME_VARS')
  const literalStart = source.indexOf('= [', declaration)
  const block = source.slice(literalStart, source.indexOf(']', literalStart))
  const injected = new Set<string>()
  for (const match of block.matchAll(/'(--[\w-]+)'/g)) injected.add(match[1])
  return injected
}

/**
 * Variables set programmatically on elements (element.style.setProperty) or
 * forwarded into the sandboxed PDF viewer iframe. Referenced from CSS but
 * legitimately not declared in any stylesheet.
 */
const RUNTIME_PROVIDED = new Set<string>([
  // Forwarded into resources/pdfjs/app/viewer.css by PdfReader / GitPdfCompare.
  '--onward-pdf-bg',
  '--onward-pdf-panel',
  '--onward-pdf-panel-elevated',
  '--onward-pdf-line',
  '--onward-pdf-text',
  '--onward-pdf-muted',
  '--onward-pdf-accent',
  '--onward-pdf-shadow',
  '--onward-pdf-page-tint',
  // Set per-element from TSX (style={{ '--x': … }} / setProperty). Each was
  // verified to have a matching writer in src/**/*.tsx before being listed —
  // an entry added without one would re-open the very hole this file closes.
  '--filter-color',
  '--task-filter-color',
  '--task-pill-color',
  '--t-color',
  '--color',
  '--terminal-rows',
  '--selection-indicator-rows',
  '--project-editor-font-size'
])

test('CSSV-U-01 the theme applier injects the variables App.css documents', () => {
  const injected = collectThemeInjected()
  // Sanity: the parse actually found the list rather than silently yielding
  // an empty set, which would make CSSV-U-02 vacuous.
  assert.ok(injected.size >= 10, `expected the themeable set, parsed ${injected.size}`)
  for (const required of ['--panel', '--border', '--text-1', '--accent', '--shadow-1']) {
    assert.ok(injected.has(required), `${required} must be theme-injected`)
  }
})

test('CSSV-U-02 every var() referenced in src/**/*.css resolves to a defined variable', () => {
  const defined = collectDefinedInCss()
  const injected = collectThemeInjected()
  const missing: string[] = []

  for (const file of cssFiles) {
    const source = readFileSync(file, 'utf8')
    for (const match of source.matchAll(/var\(\s*(--[\w-]+)/g)) {
      const name = match[1]
      if (defined.has(name) || injected.has(name) || RUNTIME_PROVIDED.has(name)) continue
      const line = source.slice(0, match.index).split('\n').length
      missing.push(`${relative(REPO_ROOT, file)}:${line} → ${name}`)
    }
  }

  assert.deepEqual(
    [...new Set(missing)].sort(),
    [],
    'undefined CSS variable(s): an unresolvable var() voids the whole declaration, '
      + 'so the rule silently loses its background / border / colour'
  )
})

test('CSSV-U-03 the aliases that caused the transparent-dialog defect stay defined', () => {
  // Named explicitly so a future cleanup that drops them fails loudly here
  // instead of re-introducing invisible dialogs.
  const defined = collectDefinedInCss()
  for (const alias of ['--background', '--line', '--text', '--muted', '--panel-elevated']) {
    assert.ok(defined.has(alias), `${alias} must stay defined (regression: transparent label dialog)`)
  }
})
