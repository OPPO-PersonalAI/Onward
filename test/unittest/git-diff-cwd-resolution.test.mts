/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { resolveGitDiffInitialCwd } from '../../src/utils/git-diff-cwd-resolution.ts'

describe('resolveGitDiffInitialCwd', () => {
  it('prefers a route root over a sticky debug override when returning to a source panel', () => {
    assert.equal(
      resolveGitDiffInitialCwd({
        routeRoot: '/source/repo',
        cwdOverride: '/debug/repo',
        repoRoot: '/terminal/repo',
        terminalCwd: '/terminal/repo/sub',
        persistedCwd: '/persisted'
      }),
      '/source/repo'
    )
  })

  it('prefers the explicit cwdOverride over every other source', () => {
    assert.equal(
      resolveGitDiffInitialCwd({
        cwdOverride: '/fixture/repo',
        repoRoot: '/main/repo',
        terminalCwd: '/main/repo/sub',
        persistedCwd: '/main/repo'
      }),
      '/fixture/repo'
    )
  })

  it('falls back to repoRoot when no override is set', () => {
    assert.equal(
      resolveGitDiffInitialCwd({
        cwdOverride: null,
        repoRoot: '/main/repo',
        terminalCwd: '/main/repo/sub',
        persistedCwd: '/persisted'
      }),
      '/main/repo'
    )
  })

  it('falls back to terminalCwd when override and repoRoot are absent', () => {
    assert.equal(
      resolveGitDiffInitialCwd({
        cwdOverride: null,
        repoRoot: null,
        terminalCwd: '/main/repo/sub',
        persistedCwd: '/persisted'
      }),
      '/main/repo/sub'
    )
  })

  it('falls back to persistedCwd when all higher sources are absent', () => {
    assert.equal(
      resolveGitDiffInitialCwd({
        cwdOverride: null,
        repoRoot: null,
        terminalCwd: null,
        persistedCwd: '/persisted'
      }),
      '/persisted'
    )
  })

  it('treats empty strings as absent and falls through to the next source', () => {
    // A blank override must not pin the diff to "" — it should fall through.
    assert.equal(
      resolveGitDiffInitialCwd({
        cwdOverride: '',
        repoRoot: '',
        terminalCwd: '/terminal',
        persistedCwd: '/persisted'
      }),
      '/terminal'
    )
  })

  it('returns null when no source provides a usable cwd', () => {
    assert.equal(
      resolveGitDiffInitialCwd({
        cwdOverride: null,
        repoRoot: undefined,
        terminalCwd: '',
        persistedCwd: null
      }),
      null
    )
  })

  it('honours a Windows drive-absolute override verbatim', () => {
    assert.equal(
      resolveGitDiffInitialCwd({
        cwdOverride: 'D:/Users/x/__autotest_pdf_epub_diff_repo',
        repoRoot: 'D:/Users/x',
        terminalCwd: 'D:/Users/x',
        persistedCwd: 'D:/Users/x'
      }),
      'D:/Users/x/__autotest_pdf_epub_diff_repo'
    )
  })
})
