/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

import type { GitFileStatus } from '../../types/electron'

export type DiffViewAnchor = {
  line: number | null
  scrollTop: number
}

export type DiffViewMemoryEntry = {
  fileKey: string
  filePath: string
  originalFilename?: string
  anchor: DiffViewAnchor | null
  scrollTop: number
  signature: string | null
  updatedAt: number
}

export type DiffViewMemory = {
  selectedFileKey: string | null
  entries: Record<string, DiffViewMemoryEntry>
}

export type GitDiffSelectionSnapshot = {
  selectedFilePath: string | null
  selectedFileKey: string | null
}

export function buildGitDiffFileKey(repoRoot: string, file: GitFileStatus): string {
  const original = file.originalFilename ?? ''
  return `${repoRoot}::${file.changeType}::${file.status}::${original}::${file.filename}`
}

export function buildGitDiffSelectionSnapshot(
  repoRoot: string,
  file: GitFileStatus | null
): GitDiffSelectionSnapshot {
  return {
    selectedFilePath: file?.filename ?? null,
    selectedFileKey: file ? buildGitDiffFileKey(file.repoRoot || repoRoot, file) : null
  }
}

export function resolveGitDiffSnapshotSelection(
  files: GitFileStatus[],
  repoRoot: string,
  snapshot: GitDiffSelectionSnapshot | null
): GitFileStatus | null {
  const wantedPath = snapshot?.selectedFilePath
  if (!wantedPath) return null

  const selectedFileKey = snapshot.selectedFileKey
  const keyed = selectedFileKey
    ? files.find((file) => (
        buildGitDiffFileKey(file.repoRoot || repoRoot, file) === selectedFileKey
      )) ?? null
    : null
  if (keyed && (keyed.filename === wantedPath || keyed.originalFilename === wantedPath)) {
    return keyed
  }
  if (selectedFileKey && !keyed) return null

  return files.find((file) => file.filename === wantedPath || file.originalFilename === wantedPath) ?? null
}

function findMatchingFile(
  files: GitFileStatus[],
  candidate: Pick<GitFileStatus, 'filename' | 'changeType' | 'originalFilename'>
): GitFileStatus | null {
  const exact = files.find((file) =>
    file.filename === candidate.filename &&
    file.changeType === candidate.changeType
  )
  if (exact) return exact
  return files.find((file) =>
    file.filename === candidate.filename &&
    (file.originalFilename ?? '') === (candidate.originalFilename ?? '')
  ) ?? null
}

export function resolveGitDiffRestoredSelection(
  files: GitFileStatus[],
  repoRoot: string,
  memory: DiffViewMemory | null,
  activeSelection: GitFileStatus | null
): GitFileStatus | null {
  if (files.length === 0) return null
  if (activeSelection) {
    const match = findMatchingFile(files, activeSelection)
    if (match) return match
  }
  const selectedFileKey = memory?.selectedFileKey
  if (!selectedFileKey) return null
  const direct = files.find((file) =>
    buildGitDiffFileKey(file.repoRoot || repoRoot, file) === selectedFileKey
  )
  if (direct) return direct
  const entry = memory?.entries[selectedFileKey]
  if (!entry) return null
  return files.find((file) =>
    file.filename === entry.filePath &&
    (file.originalFilename ?? '') === (entry.originalFilename ?? '')
  ) ?? files.find((file) => file.filename === entry.filePath) ?? null
}

export function clearGitDiffMemorySelectionWhenEmpty(
  memory: DiffViewMemory,
  files: GitFileStatus[]
): void {
  if (files.length === 0) {
    clearGitDiffMemorySelection(memory)
  }
}

export function clearGitDiffMemorySelection(memory: DiffViewMemory): void {
  memory.selectedFileKey = null
}

export function mergeGitDiffSnapshotScroll(
  memory: DiffViewMemory,
  file: GitFileStatus,
  fileKey: string,
  scrollTop: number | null | undefined,
  now = Date.now()
): boolean {
  if (typeof scrollTop !== 'number' || !Number.isFinite(scrollTop) || scrollTop < 0) {
    return false
  }

  const previous = memory.entries[fileKey]
  memory.entries[fileKey] = {
    fileKey,
    filePath: file.filename,
    originalFilename: file.originalFilename,
    anchor: {
      line: previous?.anchor?.line ?? null,
      scrollTop
    },
    scrollTop,
    signature: previous?.signature ?? null,
    updatedAt: now
  }
  memory.selectedFileKey = fileKey
  return true
}

export function shouldRestoreGitDiffSnapshotScroll(
  previousSignature: string | null | undefined,
  currentSignature: string
): boolean {
  return !previousSignature || previousSignature === currentSignature
}

export function resolveGitDiffSnapshotScrollTop(
  scrollTop: number | null | undefined,
  scrollHeight: number,
  viewportHeight: number
): number | null {
  if (
    typeof scrollTop !== 'number'
    || !Number.isFinite(scrollTop)
    || scrollTop < 0
    || !Number.isFinite(scrollHeight)
    || scrollHeight < 0
    || !Number.isFinite(viewportHeight)
    || viewportHeight < 0
  ) {
    return null
  }
  return Math.min(scrollTop, Math.max(0, scrollHeight - viewportHeight))
}
