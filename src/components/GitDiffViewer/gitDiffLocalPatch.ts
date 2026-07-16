/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Optimistic local patching of the Git Diff file list after a KNOWN mutation
 * (single-file stage / unstage / discard), so the UI updates instantly without
 * a whole-repo `loadDiff({force:true})` round-trip (2026-07-16 revert-scope
 * fix; VS Code's optimistic-then-reconcile model — the silent reconcile that
 * follows every mutation remains the authority, this patch only covers the
 * sub-second window until it lands).
 *
 * Every transform here is CONSERVATIVE: any input the table does not fully
 * understand (renames, conflicts, submodule entries, duplicate rows) returns
 * `null`, telling the caller to fall back to a full reload. A wrong optimistic
 * row would render a wrong diff body until reconcile; a `null` merely costs
 * one list recompute.
 */

import type { GitDiffResult, GitFileStatus, GitChangeType, GitStatusCode } from '../../types/electron'

export type GitFileLocalAction = 'discard' | 'stage'

/** Renderer-side copy of the main parser's group/ref decision table
 * (`git-porcelain-parse.ts::buildGitResourceFields`) — the renderer bundle
 * cannot import main-process modules. The unit layer (GLP-03/04/06/07)
 * cross-checks the two stay in lockstep. */
function resolveGroupAndRefs(
  changeType: GitChangeType,
  status: GitStatusCode
): Pick<GitFileStatus, 'resourceGroup' | 'originalRef' | 'modifiedRef'> {
  if (changeType === 'conflict') {
    return { resourceGroup: 'merge', originalRef: null, modifiedRef: 'workingTree' }
  }
  if (changeType === 'staged') {
    return {
      resourceGroup: 'index',
      originalRef: status === 'A' || status === '?' ? 'empty' : 'HEAD',
      modifiedRef: status === 'D' ? 'empty' : 'index'
    }
  }
  if (changeType === 'untracked') {
    return { resourceGroup: 'untracked', originalRef: 'empty', modifiedRef: 'workingTree' }
  }
  return {
    resourceGroup: 'workingTree',
    originalRef: status === 'A' || status === '?' ? 'empty' : 'index',
    modifiedRef: status === 'D' ? 'empty' : 'workingTree'
  }
}

function sameRow(a: GitFileStatus, b: GitFileStatus): boolean {
  return (
    a.filename === b.filename &&
    a.changeType === b.changeType &&
    a.status === b.status &&
    (a.originalFilename ?? '') === (b.originalFilename ?? '') &&
    (a.repoRoot ?? '') === (b.repoRoot ?? '')
  )
}

/**
 * Apply a successful single-file action to an in-memory diff result.
 * Returns the patched result, or `null` when the case is not safely
 * patchable and the caller must reconcile with a real reload instead.
 */
export function applyFileActionToDiffResult(
  result: GitDiffResult | null,
  file: GitFileStatus,
  action: GitFileLocalAction
): GitDiffResult | null {
  if (!result || !result.success) return null
  // Cases whose post-action list shape depends on state we cannot see from
  // here (nested trees, merge resolution, rename pairs) — reconcile instead.
  if (file.isSubmoduleEntry) return null
  if (file.changeType === 'conflict') return null
  if (file.status === 'R' || file.status === 'C' || file.originalFilename) return null

  const index = result.files.findIndex((row) => sameRow(row, file))
  if (index < 0) return null
  const row = result.files[index]

  if (action === 'discard') {
    if (row.changeType === 'unstaged' || row.changeType === 'untracked') {
      // Worktree discard / untracked delete: the change ceases to exist.
      const files = result.files.slice()
      files.splice(index, 1)
      return { ...result, files }
    }
    if (row.changeType === 'staged') {
      // Unstage: the change moves back to the worktree side. If a worktree
      // row for the same path already exists the two collapse into one row
      // whose combined shape only git can compute — reconcile.
      const hasWorktreeTwin = result.files.some(
        (other, i) =>
          i !== index &&
          other.filename === row.filename &&
          (other.repoRoot ?? '') === (row.repoRoot ?? '') &&
          other.changeType !== 'staged'
      )
      if (hasWorktreeTwin) return null
      const nextChangeType: GitChangeType = row.status === 'A' ? 'untracked' : 'unstaged'
      const nextStatus: GitStatusCode = row.status === 'A' ? '?' : row.status
      const files = result.files.slice()
      files[index] = {
        ...row,
        changeType: nextChangeType,
        status: nextStatus,
        ...resolveGroupAndRefs(nextChangeType, nextStatus)
      }
      return { ...result, files }
    }
    return null
  }

  // action === 'stage'
  if (row.changeType === 'staged') {
    // Keep on an already-staged row is a no-op for the list.
    return result
  }
  if (row.changeType === 'unstaged' || row.changeType === 'untracked') {
    const hasStagedTwin = result.files.some(
      (other, i) =>
        i !== index &&
        other.filename === row.filename &&
        (other.repoRoot ?? '') === (row.repoRoot ?? '') &&
        other.changeType === 'staged'
    )
    // Merging into an existing staged row needs git's combined status —
    // reconcile.
    if (hasStagedTwin) return null
    const nextStatus: GitStatusCode = row.changeType === 'untracked' ? 'A' : row.status
    const files = result.files.slice()
    files[index] = {
      ...row,
      changeType: 'staged',
      status: nextStatus,
      ...resolveGroupAndRefs('staged', nextStatus)
    }
    return { ...result, files }
  }
  return null
}
