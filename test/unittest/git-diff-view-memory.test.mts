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
  resolveDiffRestoreDecision,
  resolveGitDiffSnapshotScrollTop,
  resolveGitDiffRestoredSelection,
  resolveGitDiffSnapshotSelection,
  resolveRevealReconcile,
  shouldCompleteWarmReveal,
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

// Restore-vs-reveal decision table for the render-then-reveal cycle
// (2026-07-18 warm-reopen staleness fix). Lockstep with the wiring in
// GitDiffViewer.tsx's `restoring-scroll` layout effect. Precedence:
// no entry < deleted < content-changed < saved scroll < saved anchor < reveal.
describe('git diff restore-vs-reveal decision (DRD)', () => {
  const entry = (over: Partial<Pick<import('../../src/components/GitDiffViewer/diffViewMemory.ts').DiffViewMemoryEntry, 'scrollTop' | 'anchor' | 'signature'>> = {}) => ({
    scrollTop: 0,
    anchor: null,
    signature: null,
    ...over
  })

  it('DRD-01: no memory entry reveals the first change', () => {
    assert.deepEqual(
      resolveDiffRestoreDecision({ entry: null, isDeletedFile: false, currentSignature: 'sig' }),
      { action: 'reveal-first-change', reason: 'no-entry' }
    )
  })

  it('DRD-02: a deleted file never restores, even with a saved position', () => {
    assert.deepEqual(
      resolveDiffRestoreDecision({
        entry: entry({ scrollTop: 800, signature: 'old' }),
        isDeletedFile: true,
        currentSignature: 'old'
      }),
      { action: 'reveal-first-change', reason: 'deleted-file' }
    )
  })

  it('DRD-03: content changed since last view beats the saved scroll (regression lock — the branch used to abort WITHOUT revealing)', () => {
    assert.deepEqual(
      resolveDiffRestoreDecision({
        entry: entry({ scrollTop: 800, signature: 'seen-before' }),
        isDeletedFile: false,
        currentSignature: 'changed-now'
      }),
      { action: 'reveal-first-change', reason: 'content-changed' }
    )
  })

  it('DRD-04: unchanged content restores the saved scroll (VS Code view-state precedence)', () => {
    assert.deepEqual(
      resolveDiffRestoreDecision({
        entry: entry({ scrollTop: 800, signature: 'same' }),
        isDeletedFile: false,
        currentSignature: 'same'
      }),
      { action: 'restore-scroll', scrollTop: 800 }
    )
  })

  it('DRD-05: zero scroll falls back to the saved anchor line', () => {
    assert.deepEqual(
      resolveDiffRestoreDecision({
        entry: entry({ anchor: { line: 42, scrollTop: 0 }, signature: 'same' }),
        isDeletedFile: false,
        currentSignature: 'same'
      }),
      { action: 'restore-anchor', line: 42 }
    )
  })

  it('DRD-06: an entry with no saved position reveals the first change', () => {
    assert.deepEqual(
      resolveDiffRestoreDecision({ entry: entry(), isDeletedFile: false, currentSignature: 'sig' }),
      { action: 'reveal-first-change', reason: 'no-saved-position' }
    )
  })

  it('DRD-07: an entry without a saved signature cannot prove change — restore wins', () => {
    assert.deepEqual(
      resolveDiffRestoreDecision({
        entry: entry({ scrollTop: 300, signature: null }),
        isDeletedFile: false,
        currentSignature: 'anything'
      }),
      { action: 'restore-scroll', scrollTop: 300 }
    )
  })

  it('DRD-08: unknown current signature (binary / not comparable) skips the comparison — restore wins', () => {
    assert.deepEqual(
      resolveDiffRestoreDecision({
        entry: entry({ scrollTop: 300, signature: 'seen' }),
        isDeletedFile: false,
        currentSignature: null
      }),
      { action: 'restore-scroll', scrollTop: 300 }
    )
  })

  it('DRD-09: content changed beats a saved anchor too', () => {
    assert.deepEqual(
      resolveDiffRestoreDecision({
        entry: entry({ anchor: { line: 42, scrollTop: 0 }, signature: 'seen-before' }),
        isDeletedFile: false,
        currentSignature: 'changed-now'
      }),
      { action: 'reveal-first-change', reason: 'content-changed' }
    )
  })

  it('DRD-10: a non-positive anchor line does not count as a saved position', () => {
    assert.deepEqual(
      resolveDiffRestoreDecision({
        entry: entry({ anchor: { line: 0, scrollTop: 0 }, signature: 'same' }),
        isDeletedFile: false,
        currentSignature: 'same'
      }),
      { action: 'reveal-first-change', reason: 'no-saved-position' }
    )
  })
})

/**
 * WRG-* — the warm-reopen reveal gate (2026-07-26 diagnostic bundle, BUG-0004).
 *
 * The gate used to ask `editor.getLineChanges() !== null`, which answers "has a
 * diff ever been computed on this widget" rather than "does the computed diff
 * describe what the models hold now". Monaco keeps its previous `_diff` across
 * a content change and only flips `_isDiffUpToDate` while a 200 ms debouncer is
 * pending, so the old gate stayed open through the entire window in which its
 * answer was wrong — and the reveal landed on the PREVIOUS content's first
 * change (line 1, for a base that used to be an untracked empty file).
 *
 * WRG-05 is the case that must never regress; WRG-06 is the 4891fc9 win the
 * fix has to preserve.
 */
describe('warm reveal gate', () => {
  const gate = (over: Partial<Parameters<typeof shouldCompleteWarmReveal>[0]> = {}) =>
    shouldCompleteWarmReveal({
      contentReady: true,
      staleMarked: false,
      modelsMatch: true,
      diffComputedForBoundModels: true,
      ...over
    })

  it('WRG-01: a body still loading never opens the gate', () => {
    assert.equal(gate({ contentReady: false }), false)
  })

  it('WRG-02: a stale-marked key never opens the gate', () => {
    // A forced refetch is already on its way; deciding now reads a doomed body.
    assert.equal(gate({ staleMarked: true }), false)
  })

  it('WRG-03: models that do not match the selection never open the gate', () => {
    assert.equal(gate({ modelsMatch: false }), false)
  })

  it('WRG-04: everything settled and the diff current opens the gate', () => {
    assert.equal(gate(), true)
  })

  it('WRG-05: a diff that does not describe the bound models keeps it shut', () => {
    // The defect: `getLineChanges()` would have returned a non-empty array here
    // (Monaco retains the previous result), and the old gate opened on it.
    assert.equal(gate({ diffComputedForBoundModels: false }), false)
  })

  it('WRG-06: currency alone is not enough — every precondition still applies', () => {
    assert.equal(gate({ diffComputedForBoundModels: true, contentReady: false }), false)
    assert.equal(gate({ diffComputedForBoundModels: true, staleMarked: true }), false)
    assert.equal(gate({ diffComputedForBoundModels: true, modelsMatch: false }), false)
  })

  it('WRG-07: the unchanged-content warm reopen still takes the fast path', () => {
    // 4891fc9's win: when nothing was written into the models, the diff Monaco
    // already holds IS current, so the reopen must not idle into the 2 s
    // safety timeout.
    assert.equal(gate({ diffComputedForBoundModels: true }), true)
  })
})

/**
 * RRC-* — the reveal reconciliation decision table.
 *
 * This is the whole table. Four rows, exhaustively enumerated here, replacing
 * a condition that used to be split across four trigger sites thousands of
 * lines apart — two of which could not honour it (`timeout` decides on a
 * clock; `model-bound` decides off an in-flight click-latency measurement).
 *
 * Read RRC-06 and RRC-07 together: they are the reason this model exists. A
 * position applied by a trigger that had no business deciding is no longer a
 * defect, because staleness is a state that converges rather than an instant
 * that must be got right.
 */
describe('reveal reconciliation', () => {
  const at = (over: Partial<Parameters<typeof resolveRevealReconcile>[0]> = {}) =>
    resolveRevealReconcile({
      appliedSignature: 'sig-A',
      currentSignature: 'sig-A',
      diffCurrentForBoundModels: true,
      userOwnsViewport: false,
      ...over
    })

  it('RRC-01: nothing applied yet is not reconciliation\'s business', () => {
    // The ordinary reveal cycle owns a file until it has applied something.
    assert.equal(at({ appliedSignature: null }), 'none')
    assert.equal(at({ appliedSignature: null, currentSignature: 'sig-Z' }), 'none')
  })

  it('RRC-02: unknown current content never counts as stale', () => {
    // null = binary, or a body still in flight. Comparing against it would be
    // comparing against a placeholder.
    assert.equal(at({ currentSignature: null }), 'none')
    assert.equal(at({ appliedSignature: 'sig-A', currentSignature: null, userOwnsViewport: true }), 'none')
  })

  it('RRC-03: matching signatures need no work', () => {
    assert.equal(at(), 'none')
    // ...and stay 'none' regardless of the other two inputs.
    assert.equal(at({ diffCurrentForBoundModels: false }), 'none')
    assert.equal(at({ userOwnsViewport: true }), 'none')
  })

  it('RRC-04: stale with a diff that does not describe the bound models waits', () => {
    assert.equal(at({ currentSignature: 'sig-B', diffCurrentForBoundModels: false }), 'wait')
    // Waiting does not depend on who owns the viewport — there is nothing
    // trustworthy to reconcile TO yet.
    assert.equal(
      at({ currentSignature: 'sig-B', diffCurrentForBoundModels: false, userOwnsViewport: true }),
      'wait'
    )
  })

  it('RRC-05: stale, diff current, viewport unowned reconciles silently', () => {
    assert.equal(at({ currentSignature: 'sig-B' }), 'reconcile-silent')
  })

  it('RRC-06: stale, diff current, viewport OWNED notifies instead of moving it', () => {
    // The one loss silent convergence could cause: yanking the viewport away
    // from someone who scrolled there deliberately.
    assert.equal(at({ currentSignature: 'sig-B', userOwnsViewport: true }), 'notify')
  })

  it('RRC-07: a position applied from ANY signature converges the same way', () => {
    // Why `timeout` and `model-bound` no longer need to be correct: whatever
    // content they computed from, the outcome is decided by whether it still
    // matches — not by which trigger applied it.
    for (const applied of ['sig-stale-1', 'sig-stale-2', 'sig-from-a-doomed-timeout']) {
      assert.equal(at({ appliedSignature: applied, currentSignature: 'sig-live' }), 'reconcile-silent')
      assert.equal(
        at({ appliedSignature: applied, currentSignature: 'sig-live', userOwnsViewport: true }),
        'notify'
      )
    }
  })

  it('RRC-08: the table is total — every input combination has an action', () => {
    const actions = new Set<string>()
    for (const applied of [null, 'sig-A', 'sig-B']) {
      for (const current of [null, 'sig-A', 'sig-B']) {
        for (const diffCurrent of [true, false]) {
          for (const owns of [true, false]) {
            const a = resolveRevealReconcile({
              appliedSignature: applied,
              currentSignature: current,
              diffCurrentForBoundModels: diffCurrent,
              userOwnsViewport: owns
            })
            assert.ok(
              ['none', 'wait', 'reconcile-silent', 'notify'].includes(a),
              `unmapped combination: ${applied}/${current}/${diffCurrent}/${owns} -> ${a}`
            )
            actions.add(a)
          }
        }
      }
    }
    // All four actions must be reachable, or a row is dead code.
    assert.deepEqual([...actions].sort(), ['none', 'notify', 'reconcile-silent', 'wait'])
  })
})
