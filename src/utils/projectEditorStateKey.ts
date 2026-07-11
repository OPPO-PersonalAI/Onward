/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

import { normalizeProjectCwd } from './pathNormalize.ts'
import { canonicalizeTerminalCwdForPersist } from './terminal-cwd-osc.ts'
import type { ProjectEditorState } from '../types/tab.d.ts'

export type ProjectEditorScopeLike = {
  terminalId: string | null
  cwd: string | null
}

export function buildProjectEditorStateKey(scope: ProjectEditorScopeLike): string | null {
  const terminalId = typeof scope.terminalId === 'string' ? scope.terminalId.trim() : ''
  const cwd = typeof scope.cwd === 'string' ? scope.cwd.trim() : ''
  if (!terminalId || !cwd) return null
  return JSON.stringify([terminalId, normalizeProjectCwd(cwd)])
}

function foldPathCase(path: string, platform: string): string {
  return platform === 'win32' ? path.toLowerCase() : path
}

/**
 * Comparison form for root/cwd matching. Reuses the terminal-cwd persistence
 * canonicalizer (separators, duplicate slashes, '.' segments, macOS
 * /private/{var,tmp,etc} firmlink aliases, trailing slash) so paths reported
 * by different writers — OSC-7 user-facing form vs realpath form — match.
 * PHTML regression class: a TMPDIR project root persisted as '/var/…' must
 * match a terminal cwd reported as '/private/var/…'.
 */
function canonicalizeForMatch(path: string, platform: string): string {
  const canonical = canonicalizeTerminalCwdForPersist(path, platform) ?? normalizeProjectCwd(path.trim())
  return foldPathCase(canonical, platform)
}

/**
 * Locate a persisted editor-state entry written under a legacy scope key
 * (same terminal, but keyed by a cwd that no longer matches — e.g. a subdir
 * the terminal sat in before the scope cwd was normalized to the repo root).
 * Matches on the entry's own rootPath rather than the key cwd so entries
 * saved before the repo-root normalization can be adopted. Newest savedAt
 * wins when several qualify.
 */
export function findLegacyProjectEditorStateEntry(
  states: Record<string, ProjectEditorState> | undefined,
  terminalId: string,
  resolvedRootCwd: string,
  platform: string
): { stateKey: string; state: ProjectEditorState } | null {
  if (!states || !terminalId || !resolvedRootCwd) return null
  const wantedRoot = canonicalizeForMatch(resolvedRootCwd, platform)
  if (!wantedRoot) return null
  let best: { stateKey: string; state: ProjectEditorState } | null = null
  for (const [stateKey, state] of Object.entries(states)) {
    if (!state || typeof state !== 'object') continue
    let keyTerminalId: unknown = null
    try {
      const parsed = JSON.parse(stateKey)
      if (!Array.isArray(parsed) || parsed.length < 2) continue
      keyTerminalId = parsed[0]
    } catch {
      continue
    }
    if (keyTerminalId !== terminalId) continue
    const rootPath = typeof state.rootPath === 'string' ? state.rootPath.trim() : ''
    if (!rootPath) continue
    if (canonicalizeForMatch(rootPath, platform) !== wantedRoot) continue
    const savedAt = typeof state.savedAt === 'number' ? state.savedAt : 0
    const bestSavedAt = best && typeof best.state.savedAt === 'number' ? best.state.savedAt : 0
    if (!best || savedAt >= bestSavedAt) {
      best = { stateKey, state }
    }
  }
  return best
}

/**
 * Sticky project root: the newest persisted editor session of this terminal
 * whose rootPath EQUALS the terminal's current cwd (canonical comparison:
 * separators, macOS firmlink aliases, case on win32) keeps providing the
 * editor root in its ORIGINAL string form. This keeps an established session
 * stable when different writers report alias variants of the same directory
 * ('/var/…' vs '/private/var/…'). Deliberately NOT an ancestor-contains
 * match — a nested project (its own git repo, or a tool-created workspace
 * inside a bigger repo) must become its own root, not inherit an ancestor
 * session; `cd`s inside a git repo are handled by repo-root resolution.
 */
export function findStickyProjectEditorRoot(
  states: Record<string, ProjectEditorState> | undefined,
  terminalId: string,
  terminalCwd: string,
  platform: string
): string | null {
  if (!states || !terminalId || !terminalCwd) return null
  const cwdFolded = canonicalizeForMatch(terminalCwd, platform)
  if (!cwdFolded) return null
  let best: { rootPath: string; savedAt: number } | null = null
  for (const [stateKey, state] of Object.entries(states)) {
    if (!state || typeof state !== 'object') continue
    let keyTerminalId: unknown = null
    try {
      const parsed = JSON.parse(stateKey)
      if (!Array.isArray(parsed) || parsed.length < 2) continue
      keyTerminalId = parsed[0]
    } catch {
      continue
    }
    if (keyTerminalId !== terminalId) continue
    const rootPath = typeof state.rootPath === 'string' ? state.rootPath.trim() : ''
    if (!rootPath) continue
    if (canonicalizeForMatch(rootPath, platform) !== cwdFolded) continue
    const savedAt = typeof state.savedAt === 'number' ? state.savedAt : 0
    if (!best || savedAt >= best.savedAt) {
      best = { rootPath, savedAt }
    }
  }
  return best?.rootPath ?? null
}

/**
 * Keys (other than canonicalKey) that hold state for the same terminal and
 * the same resolved root — i.e. legacy duplicates that should be dropped when
 * the canonical key is written, so adopted entries migrate instead of forking.
 */
export function collectLegacyProjectEditorStateKeys(
  states: Record<string, ProjectEditorState> | undefined,
  terminalId: string,
  resolvedRootCwd: string,
  canonicalKey: string,
  platform: string
): string[] {
  if (!states || !terminalId || !resolvedRootCwd) return []
  const wantedRoot = canonicalizeForMatch(resolvedRootCwd, platform)
  if (!wantedRoot) return []
  const legacyKeys: string[] = []
  for (const [stateKey, state] of Object.entries(states)) {
    if (stateKey === canonicalKey) continue
    if (!state || typeof state !== 'object') continue
    let keyTerminalId: unknown = null
    try {
      const parsed = JSON.parse(stateKey)
      if (!Array.isArray(parsed) || parsed.length < 2) continue
      keyTerminalId = parsed[0]
    } catch {
      continue
    }
    if (keyTerminalId !== terminalId) continue
    const rootPath = typeof state.rootPath === 'string' ? state.rootPath.trim() : ''
    if (!rootPath) continue
    if (canonicalizeForMatch(rootPath, platform) !== wantedRoot) continue
    legacyKeys.push(stateKey)
  }
  return legacyKeys
}
