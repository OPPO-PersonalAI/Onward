/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const cssPath = path.join(repoRoot, 'src/components/ProjectEditor/ProjectEditor.css')
const css = readFileSync(cssPath, 'utf8')

/**
 * These assertions guard a LAYOUT CONTRACT, not an implementation detail.
 *
 * The Cmd+P Quick Open panel used to cap its result list at a hard-coded
 * `max-height: 360px`. That constant is invisible from the component's markup
 * and has no relationship to the window size, so the panel stayed the same
 * short box on a 2160px-tall display as on a 600px one — the exact complaint
 * that produced this change.
 *
 * The replacement contract is a four-part chain, and it only works if ALL four
 * parts hold together:
 *
 *   1. the overlay reserves a symmetric vertical gutter, which is what turns
 *      "the editor's height" into "the panel's budget";
 *   2. the panel caps itself at `max-height: 100%` of that budget and lays its
 *      children out as a flex column;
 *   3. the query input is pinned (`flex: 0 0 auto`) so a tall list cannot
 *      squeeze it;
 *   4. the result list absorbs the remainder (`flex: 1 1 auto`) AND carries
 *      `min-height: 0`, without which a flex item refuses to shrink below its
 *      content and the panel overflows the editor's bottom edge instead of
 *      scrolling.
 *
 * Part 4's `min-height: 0` is the classic flexbox footgun: drop it and the
 * layout looks correct with three results and silently breaks with fifty. A
 * source-level assertion is the right tool because the regression we guard
 * against is a change to these declarations themselves. The paired autotest
 * (`run-file-index-cache-ui`, FIC-27..32) proves the rendered geometry; this
 * test explains and pins WHY each declaration is present so a future
 * "simplification" cannot quietly delete one.
 */

/**
 * Extract the declaration block of a CSS rule whose selector matches the given
 * line exactly. Exact-line matching is deliberate: a substring match for
 * `.project-editor-search` would also hit `.project-editor-search-overlay` and
 * `.project-editor-search-item`, silently asserting against the wrong rule.
 */
function extractRuleBody(source: string, selector: string): string | null {
  const lines = source.split('\n')
  const openIndex = lines.findIndex((line) => line.trim() === `${selector} {`)
  if (openIndex === -1) return null
  const collected: string[] = []
  for (let index = openIndex + 1; index < lines.length; index += 1) {
    if (lines[index].trim() === '}') return collected.join('\n')
    collected.push(lines[index])
  }
  return null
}

/** Strip `/* ... *​/` comments so a declaration mentioned in prose is not read as code. */
function stripComments(body: string): string {
  return body.replace(/\/\*[\s\S]*?\*\//g, '')
}

function requireRule(selector: string): string {
  const body = extractRuleBody(css, selector)
  assert.ok(body !== null, `rule "${selector}" is missing from ProjectEditor.css`)
  return stripComments(body as string)
}

describe('extractRuleBody helper', () => {
  it('matches the selector line exactly rather than by prefix', () => {
    const sample = [
      '.a-long {',
      '  color: red;',
      '}',
      '',
      '.a {',
      '  color: blue;',
      '}'
    ].join('\n')
    assert.match(extractRuleBody(sample, '.a') ?? '', /color: blue/)
    assert.match(extractRuleBody(sample, '.a-long') ?? '', /color: red/)
  })

  it('returns null for an unknown selector', () => {
    assert.equal(extractRuleBody('.a {\n  color: red;\n}', '.b'), null)
  })

  it('does not let a commented-out declaration count as real code', () => {
    const body = stripComments('  /* max-height: 360px; */\n  max-height: 100%;')
    assert.ok(!/max-height:\s*360px/.test(body))
    assert.match(body, /max-height:\s*100%/)
  })
})

describe('Quick Open (Cmd+P) panel height contract', () => {
  const overlay = requireRule('.project-editor-search-overlay')
  const panel = requireRule('.project-editor-search')
  const input = requireRule('.project-editor-search-input')
  const results = requireRule('.project-editor-search-results')

  it('overlay reserves a symmetric vertical gutter instead of a large top-only offset', () => {
    const padding = overlay.match(/padding:\s*(\d+)px\s+([^;]+);/)
    assert.ok(padding, 'overlay must declare a shorthand `padding: <v> <h>` gutter')
    const verticalGutter = Number(padding![1])
    assert.ok(
      verticalGutter > 0 && verticalGutter <= 40,
      `vertical gutter ${verticalGutter}px is outside the 1..40px design range; ` +
        'a large gutter re-shrinks the panel the same way the old 360px cap did'
    )
    assert.ok(
      !/padding-top:\s*80px/.test(overlay),
      'the legacy 80px top-only offset is back; it pushes the panel down and steals height'
    )
  })

  it('overlay does not stretch the panel, so a short list can stay short', () => {
    assert.match(
      overlay,
      /align-items:\s*flex-start/,
      'align-items must stay flex-start; `stretch` would force the panel to full height even with one match'
    )
  })

  it('panel caps at the overlay content box and lays out as a flex column', () => {
    assert.match(panel, /max-height:\s*100%/, 'panel must cap at 100% of the overlay content box')
    assert.match(panel, /display:\s*flex/, 'panel must be a flex container for the input/list split')
    assert.match(panel, /flex-direction:\s*column/, 'panel children must stack vertically')
  })

  it('panel does not reintroduce a viewport- or pixel-pinned height', () => {
    assert.ok(
      !/max-height:\s*\d+px/.test(panel),
      'a pixel max-height on the panel decouples it from the editor height again'
    )
    assert.ok(
      !/max-height:\s*\d+vh/.test(panel),
      'a vh max-height measures the whole window, not the Project Editor pane it lives in'
    )
  })

  it('query input is pinned so a tall result list cannot squeeze it', () => {
    assert.match(
      input,
      /flex:\s*0\s+0\s+auto/,
      'input must be `flex: 0 0 auto`; the flex default would let 50 results shrink it away'
    )
  })

  it('result list absorbs the remaining height and is allowed to shrink below its content', () => {
    assert.match(results, /flex:\s*1\s+1\s+auto/, 'result list must absorb the panel remainder')
    assert.match(
      results,
      /min-height:\s*0/,
      'without `min-height: 0` the flex item refuses to shrink and the panel overflows the editor'
    )
    assert.match(results, /overflow-y:\s*auto/, 'overflow beyond the cap must scroll, not clip')
  })

  it('result list no longer carries the hard-coded 360px cap that caused the bug', () => {
    assert.ok(
      !/max-height:\s*360px/.test(results),
      'the original `max-height: 360px` is back — the panel is pinned short again regardless of window size'
    )
    assert.ok(
      !/max-height:\s*\d+px/.test(results),
      'any pixel max-height on the result list re-pins the panel to a window-independent height'
    )
  })
})
