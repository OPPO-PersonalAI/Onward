/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Model-identity decision table (2026-07-26 diagnostic bundle, BUG-0004).
 *
 * Monaco resolves models by URI and, when one already exists for that URI,
 * returns it and DISCARDS the content handed to createModel. A URI that does
 * not encode the body it stands for therefore resurrects a stale model, and
 * Monaco computes the mount-time diff — and the unchanged-region visibility
 * state that drives hideUnchangedRegions — from that stale body.
 *
 * These cases pin the two properties the identity must have:
 *   1. it CHANGES whenever the base the diff is taken against changes, and
 *   2. it does NOT change for anything that must not rebuild the model
 *      (a live draft edit, in particular).
 *
 * MID-* is the case class that motivated moving off `buildTextSignature`:
 * head + tail + length sampling collides exactly when a coding agent rewrites
 * one line into another line of the same length, and a collision silently
 * reinstates the model the identity exists to retire.
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  buildGitDiffBaseIdentity,
  buildGitDiffContentSignature,
  hashTextStrong
} from '../../src/components/GitDiffViewer/diffViewMemory.ts'

const base = (over: Partial<Parameters<typeof buildGitDiffBaseIdentity>[0]> = {}) =>
  buildGitDiffBaseIdentity({
    changeType: 'unstaged',
    status: 'M',
    originalContent: 'line one\nline two\nline three\n',
    ...over
  })

describe('git diff model identity', () => {
  it('MID-01: identical input yields an identical identity', () => {
    assert.equal(base(), base())
  })

  it('MID-02: a changeType transition changes the identity', () => {
    // The reported bundle's exact transition: the file was viewed while
    // untracked, then `git add`-ed, then viewed again.
    assert.notEqual(
      base({ changeType: 'untracked', status: '?', originalContent: '' }),
      base({ changeType: 'unstaged', status: 'M', originalContent: '' })
    )
  })

  it('MID-03: a status change alone changes the identity', () => {
    assert.notEqual(base({ status: 'M' }), base({ status: 'A' }))
  })

  it('MID-04: a different base body changes the identity', () => {
    assert.notEqual(
      base({ originalContent: 'alpha\n' }),
      base({ originalContent: 'beta\n' })
    )
  })

  it('MID-05: an empty base is distinct from a non-empty one', () => {
    assert.notEqual(base({ originalContent: '' }), base({ originalContent: 'x' }))
  })

  it('MID-06: identity is a pure function of its declared inputs only', () => {
    // No hidden dependency on call order / accumulated state: interleaving two
    // different inputs must not perturb either result.
    const a1 = base({ originalContent: 'a' })
    const b1 = base({ originalContent: 'b' })
    const a2 = base({ originalContent: 'a' })
    const b2 = base({ originalContent: 'b' })
    assert.equal(a1, a2)
    assert.equal(b1, b2)
    assert.notEqual(a1, b1)
  })

  it('MID-07: the identity carries no raw content, only bounded scalars', () => {
    const secretish = 'TOKEN-abcdefghijklmnop\n'.repeat(50)
    const identity = base({ originalContent: secretish })
    assert.ok(!identity.includes('TOKEN'), 'identity must not embed body text')
    assert.ok(identity.length < 80, `identity should stay short, got ${identity.length}`)
  })

  it('MID-08: a same-length middle-only rewrite changes the identity', () => {
    // The collision class that made head+tail+length sampling unusable here.
    // An agent replacing `const timeout = 1000` with `const timeout = 2000`
    // keeps length, head and tail identical.
    const head = 'H'.repeat(300)
    const tail = 'T'.repeat(300)
    const left = `${head}const timeout = 1000${tail}`
    const right = `${head}const timeout = 2000${tail}`
    assert.equal(left.length, right.length, 'fixture must hold length constant')
    assert.equal(left.slice(0, 256), right.slice(0, 256), 'fixture must hold head constant')
    assert.equal(left.slice(-256), right.slice(-256), 'fixture must hold tail constant')
    assert.notEqual(base({ originalContent: left }), base({ originalContent: right }))
  })

  it('MID-09: a transposition inside the body changes the identity', () => {
    // Two accumulators, one order-sensitive in a different way from the other,
    // so a pure reordering cannot cancel out.
    assert.notEqual(
      base({ originalContent: 'alpha\nbeta\n' }),
      base({ originalContent: 'beta\nalpha\n' })
    )
  })

  it('MID-10: a one-character body change changes the identity', () => {
    const body = 'x'.repeat(5000)
    assert.notEqual(
      base({ originalContent: body }),
      base({ originalContent: `${body.slice(0, 2500)}y${body.slice(2501)}` })
    )
  })
})

describe('strong text hash', () => {
  it('MID-H1: empty text hashes to a stable value', () => {
    assert.equal(hashTextStrong(''), hashTextStrong(''))
  })

  it('MID-H2: length is part of the hash, so padding changes it', () => {
    assert.notEqual(hashTextStrong('abc'), hashTextStrong('abc '))
  })

  it('MID-H3: distinct bodies of equal length hash apart', () => {
    const seen = new Set<string>()
    for (let i = 0; i < 2000; i += 1) {
      // Same length for every sample, so only the content distinguishes them.
      seen.add(hashTextStrong(`line-${String(i).padStart(6, '0')}-payload`))
    }
    assert.equal(seen.size, 2000, 'equal-length bodies must not collide')
  })

  it('MID-H4: hashing is stable across repeated calls on large input', () => {
    const big = 'the quick brown fox\n'.repeat(20_000)
    assert.equal(hashTextStrong(big), hashTextStrong(big))
  })

  it('MID-H5: single-bit-ish changes deep inside a large body are detected', () => {
    const big = 'the quick brown fox\n'.repeat(20_000)
    const mutated = `${big.slice(0, 200_000)}X${big.slice(200_001)}`
    assert.equal(big.length, mutated.length)
    assert.notEqual(hashTextStrong(big), hashTextStrong(mutated))
  })
})

/**
 * CSG-* — the "content the user last SAW" signature that
 * resolveDiffRestoreDecision compares against.
 *
 * Found by GDS-54, not by review: five trials edited line 950 / 850 / 750 / …
 * of the same file, and the sampled head+tail+length signature reported all
 * five as identical, so the decision restored a saved position instead of
 * revealing the change. That is the presentation-layer twin of the stale-model
 * identity defect — an agent swapping one line for another of equal length is
 * the single most common edit in this workload, and it was invisible.
 */
describe('git diff content signature', () => {
  const tall = (editLine: number | null) => {
    const lines = Array.from({ length: 1200 }, (_, i) => `transition line ${i + 1}`)
    if (editLine !== null) lines[editLine - 1] = `transition line ${editLine} EDITED-AFTER-STAGE`
    return lines.join('\n') + '\n'
  }

  it('CSG-01: identical content yields an identical signature', () => {
    assert.equal(buildGitDiffContentSignature('a', 'b'), buildGitDiffContentSignature('a', 'b'))
  })

  it('CSG-02: the two sides are not interchangeable', () => {
    assert.notEqual(buildGitDiffContentSignature('a', 'b'), buildGitDiffContentSignature('b', 'a'))
  })

  it('CSG-03: GDS-54 regression — equal-length middle edits at different lines differ', () => {
    const base = tall(null)
    const sigs = [950, 850, 750, 650, 550].map((line) => {
      const body = tall(line)
      // The property that defeated the sampled signature: identical length,
      // identical first 256 chars, identical last 256 chars.
      assert.equal(body.length, tall(950).length)
      assert.equal(body.slice(0, 256), tall(950).slice(0, 256))
      assert.equal(body.slice(-256), tall(950).slice(-256))
      return buildGitDiffContentSignature(base, body)
    })
    assert.equal(new Set(sigs).size, sigs.length, 'each edited line must produce a distinct signature')
  })

  it('CSG-04: an unchanged body keeps its signature stable across calls', () => {
    const base = tall(null)
    const edited = tall(600)
    assert.equal(
      buildGitDiffContentSignature(base, edited),
      buildGitDiffContentSignature(base, edited)
    )
  })
})
