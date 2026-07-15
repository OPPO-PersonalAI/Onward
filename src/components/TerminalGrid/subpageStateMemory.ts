/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

import type { SubpageId } from '../../types/subpage'

export interface SubpageMemoryScope {
  terminalId: string
  root: string | null
  tabId?: string | null
}

export interface EditorSubpageSnapshot {
  subpage: 'editor'
  activeFilePath: string | null
  markdownPreviewOpen: boolean | null
  markdownEditorVisible: boolean | null
  markdownRenderedHtmlLength?: number | null
  previewRestorePhase?: string | null
  scrollTop?: number | null
}

export interface DiffSubpageSnapshot {
  subpage: 'diff'
  selectedFilePath: string | null
  selectedFileKey: string | null
  scrollTop?: number | null
  splitRatio?: number | null
}

export interface HistorySubpageSnapshot {
  subpage: 'history'
  selectedShas: string[]
  selectionAnchor: string | null
  selectedFilePath: string | null
  commitScrollTop?: number | null
  fileScrollTop?: number | null
  diffScrollTop?: number | null
}

export type SubpageSnapshot =
  | EditorSubpageSnapshot
  | DiffSubpageSnapshot
  | HistorySubpageSnapshot

export interface StoredSubpageSnapshot<TSnapshot extends SubpageSnapshot = SubpageSnapshot> {
  scopeKey: string
  scope: SubpageMemoryScope
  subpage: TSnapshot['subpage']
  snapshot: TSnapshot
  updatedAt: number
}

export interface SubpageStateMemory {
  save<TSnapshot extends SubpageSnapshot>(scope: SubpageMemoryScope, snapshot: TSnapshot, now?: number): StoredSubpageSnapshot<TSnapshot>
  read<TSubpage extends SubpageId>(scope: SubpageMemoryScope, subpage: TSubpage): StoredSubpageSnapshot<Extract<SubpageSnapshot, { subpage: TSubpage }>> | null
  clear(scope: SubpageMemoryScope, subpage?: SubpageId): void
  list(scope?: SubpageMemoryScope): StoredSubpageSnapshot[]
}

function normalizeScopePart(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (!trimmed) return null
  return trimmed.replace(/\\/g, '/').replace(/\/+$/, '')
}

function normalizeScopeRoot(value: string | null | undefined): string | null {
  const normalized = normalizeScopePart(value)
  if (!normalized) return null
  const isWindowsRoot = /^[A-Za-z]:(?:\/|$)/.test(normalized) || normalized.startsWith('//')
  return isWindowsRoot ? normalized.toLowerCase() : normalized
}

export function resolveSubpageMemoryRoot(
  panelRoot: string | null | undefined,
  ownedRoot: string | null | undefined,
  fallbackRoot: string | null | undefined
): string | null {
  return normalizeScopeRoot(panelRoot)
    ?? normalizeScopeRoot(ownedRoot)
    ?? normalizeScopeRoot(fallbackRoot)
}

export function normalizeSubpageMemoryScope(scope: SubpageMemoryScope): SubpageMemoryScope {
  return {
    terminalId: scope.terminalId,
    root: normalizeScopeRoot(scope.root),
    tabId: normalizeScopePart(scope.tabId)
  }
}

export function buildSubpageMemoryScopeKey(scope: SubpageMemoryScope, subpage: SubpageId): string {
  const normalized = normalizeSubpageMemoryScope(scope)
  return JSON.stringify([
    normalized.tabId ?? '',
    normalized.terminalId,
    normalized.root ?? '',
    subpage
  ])
}

export function createSubpageStateMemory(): SubpageStateMemory {
  const entries = new Map<string, StoredSubpageSnapshot>()

  return {
    save(scope, snapshot, now = Date.now()) {
      const normalizedScope = normalizeSubpageMemoryScope(scope)
      const scopeKey = buildSubpageMemoryScopeKey(normalizedScope, snapshot.subpage)
      const entry: StoredSubpageSnapshot<typeof snapshot> = {
        scopeKey,
        scope: normalizedScope,
        subpage: snapshot.subpage,
        snapshot,
        updatedAt: now
      }
      entries.set(scopeKey, entry)
      return entry
    },
    read(scope, subpage) {
      return (entries.get(buildSubpageMemoryScopeKey(scope, subpage)) ?? null) as StoredSubpageSnapshot<Extract<SubpageSnapshot, { subpage: typeof subpage }>> | null
    },
    clear(scope, subpage) {
      if (subpage) {
        entries.delete(buildSubpageMemoryScopeKey(scope, subpage))
        return
      }
      const normalizedScope = normalizeSubpageMemoryScope(scope)
      for (const [key, entry] of entries) {
        if (
          entry.scope.terminalId === normalizedScope.terminalId &&
          entry.scope.root === normalizedScope.root &&
          entry.scope.tabId === normalizedScope.tabId
        ) {
          entries.delete(key)
        }
      }
    },
    list(scope) {
      const all = Array.from(entries.values())
      if (!scope) return all
      const normalizedScope = normalizeSubpageMemoryScope(scope)
      return all.filter((entry) =>
        entry.scope.terminalId === normalizedScope.terminalId &&
        entry.scope.root === normalizedScope.root &&
        entry.scope.tabId === normalizedScope.tabId
      )
    }
  }
}
