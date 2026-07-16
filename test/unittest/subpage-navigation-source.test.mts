/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  parseNavigationSourceFilter,
  navigationSourcesFor
} from '../../src/autotest/subpage-navigation-source.ts'

describe('subpage-navigation source filter (split html by source to fit the 180s budget)', () => {
  it('parses source=diff / source=history from the suite string', () => {
    assert.equal(parseNavigationSourceFilter('subpage-navigation;group=html;source=diff'), 'diff')
    assert.equal(parseNavigationSourceFilter('subpage-navigation;group=html;source=history'), 'history')
  })

  it('is case-insensitive and order-independent', () => {
    assert.equal(parseNavigationSourceFilter('subpage-navigation;source=DIFF;group=html'), 'diff')
    assert.equal(parseNavigationSourceFilter('source=history'), 'history')
  })

  it('defaults to all when the token is absent, empty, or unknown', () => {
    assert.equal(parseNavigationSourceFilter('subpage-navigation;group=html'), 'all')
    assert.equal(parseNavigationSourceFilter('subpage-navigation;group=html;source=all'), 'all')
    assert.equal(parseNavigationSourceFilter(''), 'all')
    assert.equal(parseNavigationSourceFilter(null), 'all')
    assert.equal(parseNavigationSourceFilter(undefined), 'all')
    assert.equal(parseNavigationSourceFilter('source=both'), 'all')
  })

  it('does NOT match a partial token (source=diffx must not read as diff)', () => {
    assert.equal(parseNavigationSourceFilter('source=diffx'), 'all')
    assert.equal(parseNavigationSourceFilter('group=historyish'), 'all')
  })

  it('expands each filter to the sources the runner iterates', () => {
    assert.deepEqual(navigationSourcesFor('diff'), ['diff'])
    assert.deepEqual(navigationSourcesFor('history'), ['history'])
    assert.deepEqual(navigationSourcesFor('all'), ['diff', 'history'])
  })

  it('each single-source filter yields exactly one block-pair (COLD+WARM), halving the runtime', () => {
    assert.equal(navigationSourcesFor('diff').length, 1)
    assert.equal(navigationSourcesFor('history').length, 1)
    assert.equal(navigationSourcesFor('all').length, 2)
  })
})
