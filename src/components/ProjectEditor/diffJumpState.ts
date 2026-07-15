/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

import type { GitDiffResult, GitFileStatus } from '../../types/electron'

export type DiffJumpPlatform = 'darwin' | 'linux' | 'win32' | string

export type DiffJumpTarget = {
  filename: string
  repoRoot: string | null
  changeType: GitFileStatus['changeType']
}

export type DiffReturnBarState = {
  visible: boolean
  backEnabled: boolean
  jumpEnabled: boolean
  checking: boolean
  activeFilePath: string | null
}

export type DiffLocateRouteTarget = {
  filePath: string
  repoRoot: string | null
  panelRoot: string | null
  changeType: GitFileStatus['changeType']
}

export function normalizeProjectPath(value: string): string {
  return value.replace(/\\/g, '/')
}

export function trimTrailingPathSeparators(value: string): string {
  if (/^[A-Za-z]:\/$/.test(value)) return value
  return value.replace(/\/+$/, '')
}

export function normalizeComparableProjectPath(value: string, platform: DiffJumpPlatform): string {
  const normalized = trimTrailingPathSeparators(normalizeProjectPath(value))
  return platform === 'win32'
    ? normalized.toLowerCase()
    : normalized
}

export function resolveNavigationFilePath(params: {
  editorRoot: string
  filePath: string
  repoRoot: string | null
  platform: DiffJumpPlatform
}): string | null {
  const normalizedRoot = trimTrailingPathSeparators(normalizeProjectPath(params.editorRoot))
  const normalizedFilePath = normalizeProjectPath(params.filePath).replace(/^\/+/, '')
  const normalizedRepoRoot = params.repoRoot
    ? trimTrailingPathSeparators(normalizeProjectPath(params.repoRoot))
    : normalizedRoot
  if (!normalizedRoot || !normalizedFilePath || !normalizedRepoRoot) return null

  const absoluteTargetPath = trimTrailingPathSeparators(`${normalizedRepoRoot}/${normalizedFilePath}`)
  const comparableRoot = normalizeComparableProjectPath(normalizedRoot, params.platform)
  const comparableTarget = normalizeComparableProjectPath(absoluteTargetPath, params.platform)

  if (comparableTarget === comparableRoot) return null
  if (!comparableTarget.startsWith(`${comparableRoot}/`)) return null

  const relativePath = absoluteTargetPath.slice(normalizedRoot.length + 1)
  return relativePath || null
}

export function joinProjectPath(root: string | null | undefined, relativePath: string | null | undefined): string | null {
  if (!root || !relativePath) return null
  const normalizedRoot = trimTrailingPathSeparators(normalizeProjectPath(root))
  const normalizedRelative = normalizeProjectPath(relativePath).replace(/^\/+/, '')
  if (!normalizedRoot || !normalizedRelative) return null
  return `${normalizedRoot}/${normalizedRelative}`
}

export function findDiffFileForEditorPath(params: {
  diff: GitDiffResult | null
  editorRoot: string | null
  editorFilePath: string | null
  platform: DiffJumpPlatform
  changeType?: GitFileStatus['changeType'] | null
}): GitFileStatus | null {
  const { diff, editorRoot, editorFilePath, platform, changeType } = params
  if (!diff?.success || !editorRoot || !editorFilePath) return null
  const targetAbsolute = joinProjectPath(editorRoot, editorFilePath)
  if (!targetAbsolute) return null
  const comparableTarget = normalizeComparableProjectPath(targetAbsolute, platform)
  for (const file of diff.files) {
    const fileAbsolute = joinProjectPath(file.repoRoot || diff.cwd, file.filename)
    if (
      fileAbsolute
      && normalizeComparableProjectPath(fileAbsolute, platform) === comparableTarget
      && (!changeType || file.changeType === changeType)
    ) {
      return file
    }
  }
  return null
}

export function buildDiffReturnBarState(params: {
  hasDiffReturnContext: boolean
  diffJumpTarget: DiffJumpTarget | null
  diffJumpChecking: boolean
  activeFilePath: string | null
}): DiffReturnBarState {
  return {
    visible: params.hasDiffReturnContext,
    backEnabled: params.hasDiffReturnContext,
    jumpEnabled: Boolean(params.diffJumpTarget) && !params.diffJumpChecking,
    checking: params.diffJumpChecking,
    activeFilePath: params.activeFilePath
  }
}

export function buildDiffLocateRouteTarget(
  target: DiffJumpTarget | null,
  panelRoot: string | null
): DiffLocateRouteTarget | null {
  if (!target) return null
  return {
    filePath: target.filename,
    repoRoot: target.repoRoot,
    panelRoot,
    changeType: target.changeType
  }
}
