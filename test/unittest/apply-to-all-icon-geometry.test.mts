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
const iconSource = readFileSync(path.join(repoRoot, 'src/components/Settings/ApplyToAllIcon.tsx'), 'utf8')
const settingsSource = readFileSync(path.join(repoRoot, 'src/components/Settings/Settings.tsx'), 'utf8')

/**
 * These assertions guard a DESIGN constraint, not an implementation detail.
 *
 * The "apply to all terminals" button previously drew a circle with a partial fill,
 * which users read as a checkbox/radio rather than an action. Concentric-circle
 * geometry is the defining form of a radio button, and icon systems reserve
 * "shape + centered dot" for state encoding rather than actions — so any future
 * "simplification" back toward a circle silently reintroduces the original bug.
 *
 * Source-level assertions are deliberate here: the regression we are guarding against
 * is a change to the icon's GEOMETRY, which is exactly what lives in the source. A DOM
 * test would only prove "some svg rendered", which is the part that was never at risk.
 */
describe('ApplyToAllIcon geometry', () => {
  it('uses no circle element — circles are radio-button shape space', () => {
    assert.ok(!/<circle\b/.test(iconSource), 'icon reintroduced a <circle>; see the radio-button collision note')
    assert.ok(!/<ellipse\b/.test(iconSource), 'icon reintroduced an <ellipse>')
  })

  it('does not reintroduce the legacy pie-circle path anywhere in Settings', () => {
    const legacyPath = 'M8 1a7 7 0 1 0 0 14A7 7 0 0 0 8 1z'
    assert.ok(!iconSource.includes(legacyPath), 'legacy radio-like path is back in the icon')
    assert.ok(!settingsSource.includes(legacyPath), 'legacy radio-like path is back in Settings.tsx')
  })

  it('keeps the two-bar stack that carries the "all" plurality signal', () => {
    const rects = iconSource.match(/<rect\b/g) ?? []
    assert.equal(rects.length, 2, 'the stack must stay exactly two bars — one bar reads as a single target')
  })

  it('keeps exactly one arrow path that carries the direction signal', () => {
    const paths = iconSource.match(/<path\b/g) ?? []
    assert.equal(paths.length, 1, 'expected exactly one arrow path')
  })

  it('inherits currentColor so the button hover/accent transition applies', () => {
    assert.match(iconSource, /fill="currentColor"/)
    assert.ok(!/fill="#/.test(iconSource), 'icon hardcoded a hex fill and will not follow hover state')
  })
})

/**
 * The icon markup was previously copy-pasted six times inside Settings.tsx (one section
 * hint + five per-property apply buttons), so changing it meant editing six places and
 * any missed copy became a silent visual inconsistency. It now has a single definition
 * site; this locks that in.
 */
describe('ApplyToAllIcon single definition site', () => {
  it('is referenced by every apply-globally affordance', () => {
    const uses = settingsSource.match(/<ApplyToAllIcon\b/g) ?? []
    assert.equal(uses.length, 6, 'expected 6 usages: 1 section hint + 5 per-property apply buttons')
  })

  it('renders the section hint at the smaller 12px size', () => {
    assert.match(settingsSource, /<ApplyToAllIcon size=\{12\} \/>/)
  })

  it('leaves no inline apply-globally svg behind in Settings.tsx', () => {
    // Every remaining inline <svg> in Settings.tsx must belong to some other affordance;
    // none may carry the 16x16 currentColor signature this icon used to be pasted as.
    const applyButtonBlocks = settingsSource.match(/settings-apply-global-btn[\s\S]{0,400}?<\/button>/g) ?? []
    assert.equal(applyButtonBlocks.length, 5, 'expected 5 apply-globally buttons')
    for (const block of applyButtonBlocks) {
      assert.ok(!block.includes('<svg'), 'an apply-globally button went back to an inline <svg>')
    }
  })
})
