/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import {
  stepActiveIndex,
  computeScrollFollowTop,
  shouldHoverClaimSelection
} from '../../src/utils/list-keyboard-nav.ts'

/**
 * These pin the two rules behind a measured user complaint of "arrow keys are
 * laggy" in Cmd+P. Measurement showed the render was 0.8ms median / 8.5ms p95 —
 * not slow at all. The list simply never scrolled to follow the selection
 * (17 of 20 keypresses left the highlight off-screen), and the press that
 * landed on the page boundary was silently clamped into a no-op.
 *
 * Both are decision-table logic, which is exactly what a unit test can pin
 * precisely and a DOM test can only observe indirectly.
 */

const D = 10 // prefetchDistance used across cases

describe('LKN-U-1 stepActiveIndex — ordinary movement', () => {
  it('moves down one row within the loaded range', () => {
    const r = stepActiveIndex({ activeIndex: 3, itemCount: 50, hasMore: false, delta: 1, prefetchDistance: D })
    assert.deepEqual(r, { nextIndex: 4, shouldLoadMore: false, deferred: false })
  })

  it('moves up one row', () => {
    const r = stepActiveIndex({ activeIndex: 3, itemCount: 50, hasMore: false, delta: -1, prefetchDistance: D })
    assert.deepEqual(r, { nextIndex: 2, shouldLoadMore: false, deferred: false })
  })

  it('clamps at the top instead of going negative', () => {
    const r = stepActiveIndex({ activeIndex: 0, itemCount: 50, hasMore: true, delta: -1, prefetchDistance: D })
    assert.deepEqual(r, { nextIndex: 0, shouldLoadMore: false, deferred: false })
  })

  it('clamps at the very end when there is genuinely nothing more', () => {
    const r = stepActiveIndex({ activeIndex: 49, itemCount: 50, hasMore: false, delta: 1, prefetchDistance: D })
    assert.deepEqual(r, { nextIndex: 49, shouldLoadMore: false, deferred: false })
  })

  it('is a no-op on an empty list rather than producing -1', () => {
    const r = stepActiveIndex({ activeIndex: 0, itemCount: 0, hasMore: false, delta: 1, prefetchDistance: D })
    assert.deepEqual(r, { nextIndex: 0, shouldLoadMore: false, deferred: false })
  })
})

describe('LKN-U-2 stepActiveIndex — paging', () => {
  it('starts prefetching once the selection is within the prefetch window', () => {
    // Landing on row 39 of 50 leaves 10 rows — exactly the trigger distance.
    const r = stepActiveIndex({ activeIndex: 38, itemCount: 50, hasMore: true, delta: 1, prefetchDistance: D })
    assert.equal(r.nextIndex, 39)
    assert.equal(r.shouldLoadMore, true, 'the fetch must start BEFORE the user reaches the end')
    assert.equal(r.deferred, false, 'movement continues normally while prefetching')
  })

  it('does not prefetch while still far from the end', () => {
    const r = stepActiveIndex({ activeIndex: 10, itemCount: 50, hasMore: true, delta: 1, prefetchDistance: D })
    assert.equal(r.shouldLoadMore, false)
  })

  it('does not prefetch when the server has nothing more', () => {
    const r = stepActiveIndex({ activeIndex: 48, itemCount: 50, hasMore: false, delta: 1, prefetchDistance: D })
    assert.equal(r.shouldLoadMore, false)
  })

  it('defers instead of swallowing the press when it outruns the loaded rows', () => {
    // The exact defect: at the last loaded row with more available, the old
    // `Math.min(index + 1, length - 1)` returned the same index, so the
    // keypress produced no visible movement and the user pressed again.
    const r = stepActiveIndex({ activeIndex: 49, itemCount: 50, hasMore: true, delta: 1, prefetchDistance: D })
    assert.equal(r.nextIndex, 49, 'position holds until the row exists')
    assert.equal(r.shouldLoadMore, true, 'and the fetch is requested')
    assert.equal(r.deferred, true, 'the press is remembered, not dropped')
  })

  it('completing a deferred step lands on the first row of the new page', () => {
    // What the caller replays once results grew 50 -> 100.
    const r = stepActiveIndex({ activeIndex: 49, itemCount: 100, hasMore: false, delta: 1, prefetchDistance: D })
    assert.equal(r.nextIndex, 50)
    assert.equal(r.deferred, false)
  })
})

describe('LKN-U-3 computeScrollFollowTop', () => {
  const view = { viewportHeight: 200, itemHeight: 40 }

  it('leaves scrollTop untouched when the row is already fully visible', () => {
    const top = computeScrollFollowTop({ scrollTop: 0, itemTop: 80, ...view })
    assert.equal(top, 0, 'scrolling an already-visible row would make the list lurch')
  })

  it('scrolls down the minimum needed when the row is below the fold', () => {
    // Row occupies 200..240; viewport shows 0..200. Bottom-align it.
    const top = computeScrollFollowTop({ scrollTop: 0, itemTop: 200, ...view })
    assert.equal(top, 40)
  })

  it('scrolls up the minimum needed when the row is above the fold', () => {
    const top = computeScrollFollowTop({ scrollTop: 200, itemTop: 120, ...view })
    assert.equal(top, 120)
  })

  it('honours a margin so the neighbouring row stays peeking', () => {
    const top = computeScrollFollowTop({ scrollTop: 0, itemTop: 200, margin: 10, ...view })
    assert.equal(top, 50)
  })

  it('never returns a negative scrollTop', () => {
    const top = computeScrollFollowTop({ scrollTop: 5, itemTop: 0, margin: 20, ...view })
    assert.equal(top, 0)
  })

  it('is a no-op before layout, when the viewport has no height yet', () => {
    const top = computeScrollFollowTop({ scrollTop: 7, itemTop: 999, itemHeight: 40, viewportHeight: 0 })
    assert.equal(top, 7)
  })

  it('is idempotent — following twice does not drift', () => {
    const first = computeScrollFollowTop({ scrollTop: 0, itemTop: 200, ...view })
    const second = computeScrollFollowTop({ scrollTop: first, itemTop: 200, ...view })
    assert.equal(second, first)
  })
})

describe('LKN-U-4 shouldHoverClaimSelection', () => {
  it('ignores pointer-enter while the keyboard is driving', () => {
    // Rows sliding under a stationary cursor fire enter events. Honouring them
    // yanks the selection back and makes the arrow keys look broken.
    assert.equal(shouldHoverClaimSelection(true), false)
  })

  it('lets the pointer take over once it genuinely moves', () => {
    assert.equal(shouldHoverClaimSelection(false), true)
  })
})
