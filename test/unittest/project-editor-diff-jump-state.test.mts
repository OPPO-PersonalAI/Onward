/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 *
 * Usage: node --experimental-strip-types --test test/unittest/project-editor-diff-jump-state.test.mts
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  buildDiffLocateRouteTarget,
  buildDiffReturnBarState,
  findDiffFileForEditorPath,
  resolveNavigationFilePath
} from '../../src/components/ProjectEditor/diffJumpState.ts'

import type { GitDiffResult, GitFileStatus } from '../../src/types/electron.ts'

function file(filename: string, repoRoot: string | null = '/repo'): GitFileStatus {
  return {
    filename,
    status: 'M',
    additions: 1,
    deletions: 0,
    changeType: 'unstaged',
    resourceGroup: 'workingTree',
    originalRef: 'index',
    modifiedRef: 'workingTree',
    repoRoot: repoRoot ?? undefined
  }
}

function diff(files: GitFileStatus[], cwd = '/repo'): GitDiffResult {
  return {
    success: true,
    cwd,
    isGitRepo: true,
    gitInstalled: true,
    files
  }
}

test('resolveNavigationFilePath maps submodule repo paths back into the editor root', () => {
  assert.equal(resolveNavigationFilePath({
    editorRoot: '/repo',
    repoRoot: '/repo/modules/sub',
    filePath: 'README.md',
    platform: 'darwin'
  }), 'modules/sub/README.md')
})

test('resolveNavigationFilePath rejects root and outside-root targets', () => {
  assert.equal(resolveNavigationFilePath({
    editorRoot: '/repo',
    repoRoot: '/repo',
    filePath: '',
    platform: 'darwin'
  }), null)
  assert.equal(resolveNavigationFilePath({
    editorRoot: '/repo',
    repoRoot: '/outside',
    filePath: 'README.md',
    platform: 'darwin'
  }), null)
})

test('resolveNavigationFilePath uses case-insensitive comparison on Windows', () => {
  assert.equal(resolveNavigationFilePath({
    editorRoot: 'C:\\Work\\Repo',
    repoRoot: 'c:\\work\\repo\\packages\\app',
    filePath: 'src\\index.ts',
    platform: 'win32'
  }), 'packages/app/src/index.ts')
})

test('findDiffFileForEditorPath matches files across nested repo roots', () => {
  const match = findDiffFileForEditorPath({
    diff: diff([
      file('src/app.ts', '/repo'),
      file('README.md', '/repo/modules/sub')
    ]),
    editorRoot: '/repo',
    editorFilePath: 'modules/sub/README.md',
    platform: 'darwin'
  })

  assert.equal(match?.filename, 'README.md')
  assert.equal(match?.repoRoot, '/repo/modules/sub')
})

test('findDiffFileForEditorPath returns null for non-diff editor files', () => {
  const match = findDiffFileForEditorPath({
    diff: diff([file('src/app.ts')]),
    editorRoot: '/repo',
    editorFilePath: 'docs/guide.md',
    platform: 'darwin'
  })

  assert.equal(match, null)
})

test('findDiffFileForEditorPath compares case-insensitively on Windows', () => {
  const match = findDiffFileForEditorPath({
    diff: diff([file('SRC/App.ts', 'C:/Work/Repo')], 'C:/Work/Repo'),
    editorRoot: 'c:/work/repo',
    editorFilePath: 'src/app.ts',
    platform: 'win32'
  })

  assert.equal(match?.filename, 'SRC/App.ts')
})

test('findDiffFileForEditorPath uses changeType to disambiguate staged and unstaged rows', () => {
  const staged = {
    ...file('src/app.ts'),
    changeType: 'staged' as const,
    resourceGroup: 'index' as const,
    originalRef: 'HEAD' as const,
    modifiedRef: 'index' as const
  }
  const unstaged = file('src/app.ts')
  const match = findDiffFileForEditorPath({
    diff: diff([staged, unstaged]),
    editorRoot: '/repo',
    editorFilePath: 'src/app.ts',
    platform: 'darwin',
    changeType: 'unstaged'
  } as Parameters<typeof findDiffFileForEditorPath>[0] & { changeType: 'unstaged' })

  assert.equal(match?.changeType, 'unstaged')
})

test('buildDiffReturnBarState disables jump while checking or when target is absent', () => {
  assert.deepEqual(buildDiffReturnBarState({
    hasDiffReturnContext: true,
    diffJumpTarget: null,
    diffJumpChecking: false,
    activeFilePath: 'docs/guide.md'
  }), {
    visible: true,
    backEnabled: true,
    jumpEnabled: false,
    checking: false,
    activeFilePath: 'docs/guide.md'
  })

  assert.deepEqual(buildDiffReturnBarState({
    hasDiffReturnContext: true,
    diffJumpTarget: {
      filename: 'src/app.ts',
      repoRoot: '/repo',
      changeType: 'unstaged'
    },
    diffJumpChecking: true,
    activeFilePath: 'src/app.ts'
  }), {
    visible: true,
    backEnabled: true,
    jumpEnabled: false,
    checking: true,
    activeFilePath: 'src/app.ts'
  })

  assert.equal(buildDiffReturnBarState({
    hasDiffReturnContext: true,
    diffJumpTarget: {
      filename: 'src/app.ts',
      repoRoot: '/repo',
      changeType: 'unstaged'
    },
    diffJumpChecking: false,
    activeFilePath: 'src/app.ts'
  }).jumpEnabled, true)
})

test('buildDiffLocateRouteTarget preserves the source panel root for nested repositories', () => {
  assert.deepEqual(buildDiffLocateRouteTarget({
    filename: 'nested-target.ts',
    repoRoot: '/repo/nested-repo',
    changeType: 'unstaged'
  }, '/repo'), {
    filePath: 'nested-target.ts',
    repoRoot: '/repo/nested-repo',
    panelRoot: '/repo',
    changeType: 'unstaged'
  })

  assert.equal(buildDiffLocateRouteTarget(null, '/repo'), null)
})
