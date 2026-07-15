/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { GitFileStatus } from '../../src/types/electron.ts'
import {
  buildGitDiffFileKey,
  buildGitDiffSelectionSnapshot,
  clearGitDiffMemorySelection,
  clearGitDiffMemorySelectionWhenEmpty,
  mergeGitDiffSnapshotScroll,
  resolveGitDiffSnapshotScrollTop,
  resolveGitDiffRestoredSelection,
  resolveGitDiffSnapshotSelection,
  shouldRestoreGitDiffSnapshotScroll,
  type DiffViewMemory
} from '../../src/components/GitDiffViewer/diffViewMemory.ts'

function gitFile(
  filename: string,
  changeType: GitFileStatus['changeType'] = 'unstaged',
  status: GitFileStatus['status'] = 'M',
  repoRoot = '/repo'
): GitFileStatus {
  return {
    filename,
    status,
    changeType,
    repoRoot
  } as GitFileStatus
}

describe('git diff view memory', () => {
  it('keeps the current active selection when it is still present', () => {
    const files = [gitFile('a.md'), gitFile('b.md')]
    const restored = resolveGitDiffRestoredSelection(files, '/repo', null, gitFile('b.md'))
    assert.equal(restored?.filename, 'b.md')
  })

  it('restores the selected file from memory when the active selection was cleared', () => {
    const files = [gitFile('a.md'), gitFile('existing.md')]
    const key = buildGitDiffFileKey('/repo', files[1])
    const memory: DiffViewMemory = {
      selectedFileKey: key,
      entries: {
        [key]: {
          fileKey: key,
          filePath: 'existing.md',
          anchor: { line: 1, scrollTop: 0 },
          scrollTop: 0,
          signature: null,
          updatedAt: 1
        }
      }
    }

    const restored = resolveGitDiffRestoredSelection(files, '/repo', memory, null)
    assert.equal(restored?.filename, 'existing.md')
  })

  it('restores the exact staged or unstaged entry when both share one path', () => {
    const files = [
      gitFile('dual-state.ts', 'unstaged'),
      gitFile('dual-state.ts', 'staged')
    ]
    const stagedKey = buildGitDiffFileKey('/repo', files[1])
    const memory: DiffViewMemory = {
      selectedFileKey: stagedKey,
      entries: {}
    }

    const restored = resolveGitDiffRestoredSelection(files, '/repo', memory, null)
    assert.equal(restored?.changeType, 'staged')
  })

  it('builds path and key atomically from the same live staged selection', () => {
    const liveFile = gitFile('dual-state.ts', 'staged')
    const snapshot = buildGitDiffSelectionSnapshot('/repo', liveFile)

    assert.equal(snapshot.selectedFilePath, 'dual-state.ts')
    assert.equal(snapshot.selectedFileKey, buildGitDiffFileKey('/repo', liveFile))
    assert.match(snapshot.selectedFileKey ?? '', /::staged::/)
  })

  it('rejects a stale key that points to a different path before falling back to the snapshot path', () => {
    const navigate = gitFile('navigate.ts', 'unstaged')
    const stagedDualState = gitFile('dual-state.ts', 'staged')
    const restored = resolveGitDiffSnapshotSelection(
      [navigate, stagedDualState],
      '/repo',
      {
        selectedFilePath: 'dual-state.ts',
        selectedFileKey: buildGitDiffFileKey('/repo', navigate)
      }
    )

    assert.equal(restored?.filename, 'dual-state.ts')
    assert.equal(restored?.changeType, 'staged')
  })

  it('does not fall back from a missing staged snapshot identity to the unstaged entry at the same path', () => {
    const stagedDualState = gitFile('dual-state.ts', 'staged')
    const restored = resolveGitDiffSnapshotSelection(
      [gitFile('dual-state.ts', 'unstaged')],
      '/repo',
      buildGitDiffSelectionSnapshot('/repo', stagedDualState)
    )

    assert.equal(restored, null)
  })

  it('does not fall back from a missing unstaged snapshot identity to the staged entry at the same path', () => {
    const unstagedDualState = gitFile('dual-state.ts', 'unstaged')
    const restored = resolveGitDiffSnapshotSelection(
      [gitFile('dual-state.ts', 'staged')],
      '/repo',
      buildGitDiffSelectionSnapshot('/repo', unstagedDualState)
    )

    assert.equal(restored, null)
  })

  it('keeps path-only legacy snapshots compatible', () => {
    const restored = resolveGitDiffSnapshotSelection(
      [gitFile('legacy.ts', 'unstaged')],
      '/repo',
      {
        selectedFilePath: 'legacy.ts',
        selectedFileKey: null
      }
    )

    assert.equal(restored?.filename, 'legacy.ts')
    assert.equal(restored?.changeType, 'unstaged')
  })

  it('falls back to memory entry path matching when the stored key is stale', () => {
    const files = [gitFile('renamed.md', 'unstaged', 'R')]
    const memory: DiffViewMemory = {
      selectedFileKey: '/old-repo::unstaged::R::old.md::renamed.md',
      entries: {
        '/old-repo::unstaged::R::old.md::renamed.md': {
          fileKey: '/old-repo::unstaged::R::old.md::renamed.md',
          filePath: 'renamed.md',
          originalFilename: 'old.md',
          anchor: null,
          scrollTop: 0,
          signature: null,
          updatedAt: 1
        }
      }
    }

    const restored = resolveGitDiffRestoredSelection(files, '/repo', memory, null)
    assert.equal(restored?.filename, 'renamed.md')
  })

  it('returns null when no active or remembered selection matches', () => {
    const files = [gitFile('a.md')]
    const memory: DiffViewMemory = {
      selectedFileKey: '/repo::unstaged::M::::missing.md',
      entries: {}
    }

    const restored = resolveGitDiffRestoredSelection(files, '/repo', memory, null)
    assert.equal(restored, null)
  })

  it('clears remembered selection when a repo has no diff files', () => {
    const file = gitFile('a.md')
    const key = buildGitDiffFileKey('/repo', file)
    const memory: DiffViewMemory = {
      selectedFileKey: key,
      entries: {
        [key]: {
          fileKey: key,
          filePath: 'a.md',
          anchor: null,
          scrollTop: 0,
          signature: null,
          updatedAt: 1
        }
      }
    }

    clearGitDiffMemorySelectionWhenEmpty(memory, [])
    assert.equal(memory.selectedFileKey, null)
    assert.ok(memory.entries[key])
  })

  it('clears only the selected pointer while preserving scroll entries', () => {
    const file = gitFile('a.md')
    const key = buildGitDiffFileKey('/repo', file)
    const memory: DiffViewMemory = {
      selectedFileKey: key,
      entries: {
        [key]: {
          fileKey: key,
          filePath: 'a.md',
          anchor: { line: 8, scrollTop: 120 },
          scrollTop: 120,
          signature: 'sig',
          updatedAt: 1
        }
      }
    }

    clearGitDiffMemorySelection(memory)
    assert.equal(memory.selectedFileKey, null)
    assert.deepEqual(memory.entries[key]?.anchor, { line: 8, scrollTop: 120 })
  })

  it('merges an authoritative subpage snapshot scroll into the exact file entry', () => {
    const file = gitFile('long.ts')
    const key = buildGitDiffFileKey('/repo', file)
    const memory: DiffViewMemory = {
      selectedFileKey: null,
      entries: {
        [key]: {
          fileKey: key,
          filePath: file.filename,
          anchor: { line: 64, scrollTop: 80 },
          scrollTop: 80,
          signature: 'same-content',
          updatedAt: 1
        }
      }
    }

    assert.equal(mergeGitDiffSnapshotScroll(memory, file, key, 2402, 2), true)
    assert.equal(memory.selectedFileKey, key)
    assert.deepEqual(memory.entries[key], {
      fileKey: key,
      filePath: file.filename,
      originalFilename: undefined,
      anchor: { line: 64, scrollTop: 2402 },
      scrollTop: 2402,
      signature: 'same-content',
      updatedAt: 2
    })
  })

  it('rejects invalid subpage snapshot scroll values without changing memory', () => {
    const file = gitFile('long.ts')
    const key = buildGitDiffFileKey('/repo', file)
    const memory: DiffViewMemory = { selectedFileKey: null, entries: {} }

    assert.equal(mergeGitDiffSnapshotScroll(memory, file, key, Number.NaN), false)
    assert.equal(mergeGitDiffSnapshotScroll(memory, file, key, -1), false)
    assert.deepEqual(memory, { selectedFileKey: null, entries: {} })
  })

  it('does not reuse staged memory when merging an unstaged snapshot for the same path', () => {
    const staged = gitFile('dual-state.ts', 'staged')
    const unstaged = gitFile('dual-state.ts', 'unstaged')
    const stagedKey = buildGitDiffFileKey('/repo', staged)
    const unstagedKey = buildGitDiffFileKey('/repo', unstaged)
    const memory: DiffViewMemory = {
      selectedFileKey: stagedKey,
      entries: {
        [stagedKey]: {
          fileKey: stagedKey,
          filePath: staged.filename,
          anchor: { line: 50, scrollTop: 900 },
          scrollTop: 900,
          signature: 'staged-content',
          updatedAt: 1
        }
      }
    }

    assert.equal(mergeGitDiffSnapshotScroll(memory, unstaged, unstagedKey, 120, 2), true)
    assert.equal(memory.entries[unstagedKey]?.signature, null)
    assert.deepEqual(memory.entries[unstagedKey]?.anchor, { line: null, scrollTop: 120 })
    assert.equal(memory.entries[stagedKey]?.signature, 'staged-content')
  })

  it('restores pixels only while the diff content signature remains unchanged', () => {
    assert.equal(shouldRestoreGitDiffSnapshotScroll(null, 'current'), true)
    assert.equal(shouldRestoreGitDiffSnapshotScroll('same', 'same'), true)
    assert.equal(shouldRestoreGitDiffSnapshotScroll('before', 'after'), false)
  })

  it('clamps a snapshot scroll when the viewport grows and rejects invalid geometry', () => {
    assert.equal(resolveGitDiffSnapshotScrollTop(2400, 3000, 500), 2400)
    assert.equal(resolveGitDiffSnapshotScrollTop(2400, 3000, 900), 2100)
    assert.equal(resolveGitDiffSnapshotScrollTop(Number.NaN, 3000, 500), null)
    assert.equal(resolveGitDiffSnapshotScrollTop(10, 3000, -1), null)
  })
})
