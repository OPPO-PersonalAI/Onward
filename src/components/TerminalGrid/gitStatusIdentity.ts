/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

import type { GitStateMirrorDelta, GitStateMirrorSnapshot, TerminalGitStatus } from '../../types/electron'

export type MirrorSnapshotMap = Record<string, GitStateMirrorSnapshot>
export type MirrorAliasMap = Record<string, string>

export interface TerminalGitInfoLike {
  cwd: string | null
  repoRoot: string | null
  branch: string | null
  repoName: string | null
  status: TerminalGitStatus | null
}

export interface TerminalGitDisplayState {
  normalizedCwd: string | null
  mirror: GitStateMirrorSnapshot | null
  legacyMatchesCwd: boolean
  branch: string | null
  repoName: string | null
  status: TerminalGitStatus | null
  /**
   * Commits ahead of / behind the upstream. Sourced ONLY from the mirror
   * snapshot — the legacy `TerminalGitInfo` RPC path has no ahead/behind, so
   * these are `null` until a mirror snapshot resolves. Undefined-in-snapshot
   * (no upstream) also collapses to `null` here.
   */
  ahead: number | null
  behind: number | null
  /**
   * Background-fetch timing for this repo, stamped onto the snapshot by the
   * main-process router. Drives the stale-sync treatment: `behind` is only as
   * fresh as `lastFetchOkAt`, so an old (or absent-despite-attempts) timestamp
   * means the count must not be presented as authoritative. Null until a mirror
   * snapshot resolves, or when the fetch loop has not reported yet.
   */
  lastFetchOkAt: number | null
  lastFetchAttemptAt: number | null
}

function collapsePathSegments(value: string): string {
  const driveMatch = value.match(/^([A-Za-z]:)(\/?)(.*)$/)
  const prefix = driveMatch ? driveMatch[1].toLowerCase() : ''
  const absolute = driveMatch ? driveMatch[2] === '/' : value.startsWith('/')
  const body = driveMatch ? driveMatch[3] : value.replace(/^\//, '')
  const segments: string[] = []

  for (const part of body.split('/')) {
    if (!part || part === '.') continue
    if (part === '..') {
      if (segments.length > 0) {
        segments.pop()
      }
      continue
    }
    segments.push(part)
  }

  const joined = segments.join('/')
  const normalized = `${prefix}${absolute ? '/' : ''}${joined}`
  if (!normalized && absolute) return '/'
  if (!normalized && prefix) return `${prefix}${absolute ? '/' : ''}`
  return normalized
}

export function normalizeTerminalGitPath(cwd: string | null | undefined): string | null {
  if (!cwd) return null
  let normalized = cwd.replace(/\\/g, '/').replace(/\/{2,}/g, '/')
  if (normalized.startsWith('/private/')) {
    normalized = normalized.slice('/private'.length)
  }
  normalized = collapsePathSegments(normalized)
  const isPosixRoot = normalized === '/'
  const isWindowsDriveRoot = /^[a-z]:\/$/i.test(normalized)
  if (!isPosixRoot && !isWindowsDriveRoot && normalized.length > 1 && normalized.endsWith('/')) {
    normalized = normalized.slice(0, -1)
  }
  return normalized
}

function defaultMirrorSnapshot(cwd: string): GitStateMirrorSnapshot {
  return {
    cwd,
    repoRoot: null,
    repoName: null,
    branch: null,
    status: null,
    files: [],
    capturedAt: 0,
    changeFingerprint: '',
    generation: 0
  }
}

export function mergeMirrorSnapshot(
  snapshots: MirrorSnapshotMap,
  snapshot: GitStateMirrorSnapshot
): MirrorSnapshotMap {
  const key = normalizeTerminalGitPath(snapshot.cwd) ?? snapshot.cwd
  return {
    ...snapshots,
    [key]: { ...snapshot, cwd: key }
  }
}

export function mergeMirrorDeltaSnapshot(
  snapshots: MirrorSnapshotMap,
  cwd: string,
  delta: GitStateMirrorDelta
): MirrorSnapshotMap {
  const key = normalizeTerminalGitPath(cwd) ?? cwd
  const base = snapshots[key] ?? defaultMirrorSnapshot(key)
  return {
    ...snapshots,
    [key]: {
      ...base,
      ...delta,
      cwd: key,
      capturedAt: delta.capturedAt ?? base.capturedAt
    }
  }
}

export function mergeMirrorAlias(
  aliases: MirrorAliasMap,
  rawCwd: string | null | undefined,
  snapshotCwd: string | null | undefined
): MirrorAliasMap {
  const rawKey = normalizeTerminalGitPath(rawCwd)
  const snapshotKey = normalizeTerminalGitPath(snapshotCwd)
  if (!rawKey || !snapshotKey || rawKey === snapshotKey) {
    return aliases
  }
  if (aliases[rawKey] === snapshotKey) {
    return aliases
  }
  return { ...aliases, [rawKey]: snapshotKey }
}

export function removeMirrorAlias(aliases: MirrorAliasMap, rawCwd: string | null | undefined): MirrorAliasMap {
  const rawKey = normalizeTerminalGitPath(rawCwd)
  if (!rawKey || !(rawKey in aliases)) {
    return aliases
  }
  const next = { ...aliases }
  delete next[rawKey]
  return next
}

export function resolveMirrorSnapshotForCwd(
  snapshots: MirrorSnapshotMap,
  aliases: MirrorAliasMap,
  cwd: string | null | undefined
): GitStateMirrorSnapshot | null {
  const key = normalizeTerminalGitPath(cwd)
  if (!key) return null
  const direct = snapshots[key]
  if (direct) return direct
  const canonicalKey = aliases[key]
  return canonicalKey ? snapshots[canonicalKey] ?? null : null
}

export function resolveTerminalGitDisplayState(input: {
  cwd: string | null
  terminalInfo?: TerminalGitInfoLike | null
  mirrorSnapshots: MirrorSnapshotMap
  mirrorAliases: MirrorAliasMap
}): TerminalGitDisplayState {
  const normalizedCwd = normalizeTerminalGitPath(input.cwd)
  const mirror = resolveMirrorSnapshotForCwd(input.mirrorSnapshots, input.mirrorAliases, input.cwd)
  const legacyCwd = normalizeTerminalGitPath(input.terminalInfo?.cwd)
  const legacyMatchesCwd = Boolean(normalizedCwd && legacyCwd && normalizedCwd === legacyCwd)
  return {
    normalizedCwd,
    mirror,
    legacyMatchesCwd,
    branch: mirror?.branch ?? (legacyMatchesCwd ? input.terminalInfo?.branch : null) ?? null,
    repoName: mirror?.repoName ?? (legacyMatchesCwd ? input.terminalInfo?.repoName : null) ?? null,
    status: mirror?.status ?? (legacyMatchesCwd ? input.terminalInfo?.status : null) ?? null,
    ahead: mirror?.ahead ?? null,
    behind: mirror?.behind ?? null,
    lastFetchOkAt: mirror?.lastFetchOkAt ?? null,
    lastFetchAttemptAt: mirror?.lastFetchAttemptAt ?? null
  }
}
