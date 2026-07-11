/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Root-containment path helpers shared by the main-process project-editor
 * utils and the project FS worker — previously two hand-synced private
 * copies whose drift risk was called out in project docs.
 *
 * The `*With` variants take explicit path semantics so unit tests can
 * exercise BOTH win32 and POSIX behavior from any host
 * (test/unittest/path-containment.test.mts); the bare exports bind the
 * current process's native semantics.
 */

import { normalize, resolve, sep } from 'path'

export interface PathSemantics {
  sep: string
  caseInsensitive: boolean
  normalize: (value: string) => string
  resolve: (...segments: string[]) => string
}

const nativeSemantics: PathSemantics = {
  sep,
  caseInsensitive: process.platform === 'win32',
  normalize,
  resolve
}

export function normalizeForCompareWith(value: string, semantics: PathSemantics): string {
  const normalized = semantics.normalize(value)
  return semantics.caseInsensitive ? normalized.toLowerCase() : normalized
}

export function isSubPathWith(root: string, target: string, semantics: PathSemantics): boolean {
  const rootNormalized = normalizeForCompareWith(root, semantics)
  const targetNormalized = normalizeForCompareWith(target, semantics)
  if (targetNormalized === rootNormalized) return true
  // Filesystem-root workspaces ('/', 'C:\', UNC share roots) — and any root
  // passed with a trailing separator — normalize WITH that separator, so
  // blindly appending another builds a double-separator prefix no child
  // path ever starts with (every entry would be rejected forever).
  const prefix = rootNormalized.endsWith(semantics.sep)
    ? rootNormalized
    : rootNormalized + semantics.sep
  if (prefix.length > 1 && targetNormalized === prefix.slice(0, -1)) return true
  return targetNormalized.startsWith(prefix)
}

export function resolveInRootWith(
  root: string,
  relativePath: string,
  semantics: PathSemantics
): string | null {
  const safeRelative = relativePath ? relativePath.split('/').join(semantics.sep) : ''
  const fullPath = semantics.resolve(root, safeRelative)
  if (!isSubPathWith(root, fullPath, semantics)) return null
  return fullPath
}

export function normalizeForCompare(value: string): string {
  return normalizeForCompareWith(value, nativeSemantics)
}

export function isSubPath(root: string, target: string): boolean {
  return isSubPathWith(root, target, nativeSemantics)
}

export function resolveInRoot(root: string, relativePath: string): string | null {
  return resolveInRootWith(root, relativePath, nativeSemantics)
}
