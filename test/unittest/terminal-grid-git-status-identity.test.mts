/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { GitStateMirrorSnapshot } from '../../src/types/electron.d.ts'
import {
  mergeMirrorAlias,
  mergeMirrorDeltaSnapshot,
  mergeMirrorSnapshot,
  normalizeTerminalGitPath,
  removeMirrorAlias,
  resolveMirrorSnapshotForCwd,
  resolveTerminalGitDisplayState
} from '../../src/components/TerminalGrid/gitStatusIdentity.ts'

function snapshot(
  cwd: string,
  status: GitStateMirrorSnapshot['status'],
  sync?: { ahead?: number; behind?: number }
): GitStateMirrorSnapshot {
  return {
    cwd,
    repoRoot: cwd,
    repoName: 'repo',
    branch: 'feature/status',
    status,
    files: [],
    capturedAt: 100,
    changeFingerprint: status ?? 'none',
    generation: 1,
    ...(sync?.ahead !== undefined ? { ahead: sync.ahead } : {}),
    ...(sync?.behind !== undefined ? { behind: sync.behind } : {})
  }
}

test('normalizes renderer Git cwd keys across equivalent path spellings', () => {
  assert.equal(
    normalizeTerminalGitPath('/private/var/tmp//repo-A/./nested/../'),
    '/var/tmp/repo-A'
  )
  assert.equal(
    normalizeTerminalGitPath('C:\\Temp\\repo-A\\.\\nested\\..\\'),
    'c:/Temp/repo-A'
  )
  assert.equal(normalizeTerminalGitPath('/'), '/')
  assert.equal(normalizeTerminalGitPath('C:\\'), 'c:/')
})

test('resolves raw cwd aliases to canonical mirror snapshots', () => {
  let snapshots = mergeMirrorSnapshot({}, snapshot('/private/var/tmp/repo-A', 'modified'))
  let aliases = mergeMirrorAlias({}, '/Volumes/link-to-repo-A', '/private/var/tmp/repo-A')

  assert.equal(resolveMirrorSnapshotForCwd(snapshots, aliases, '/Volumes/link-to-repo-A')?.status, 'modified')

  snapshots = mergeMirrorDeltaSnapshot(snapshots, '/private/var/tmp/repo-A', {
    status: 'clean',
    files: [],
    changeFingerprint: 'clean',
    capturedAt: 200,
    generation: 2
  })

  assert.equal(resolveMirrorSnapshotForCwd(snapshots, aliases, '/Volumes/link-to-repo-A')?.status, 'clean')

  aliases = removeMirrorAlias(aliases, '/Volumes/link-to-repo-A')
  assert.equal(resolveMirrorSnapshotForCwd(snapshots, aliases, '/Volumes/link-to-repo-A'), null)
})

test('prefers mirror state over stale legacy terminal info for equivalent cwd aliases', () => {
  const snapshots = mergeMirrorSnapshot({}, snapshot('/private/var/tmp/repo-A', 'added'))
  const aliases = mergeMirrorAlias({}, '/var/tmp/repo-A/.', '/private/var/tmp/repo-A')
  const resolved = resolveTerminalGitDisplayState({
    cwd: '/var/tmp/repo-A/.',
    terminalInfo: {
      cwd: '/private/var/tmp/repo-A',
      repoRoot: '/private/var/tmp/repo-A',
      branch: 'feature/status',
      repoName: 'repo',
      status: 'clean'
    },
    mirrorSnapshots: snapshots,
    mirrorAliases: aliases
  })

  assert.equal(resolved.branch, 'feature/status')
  assert.equal(resolved.repoName, 'repo')
  assert.equal(resolved.status, 'added')
})

test('canonical-key invariant: multiple raw cwds collapse to one mirrorSnapshots entry', () => {
  // This invariant is the load-bearing contract for the renderer's
  // subscription bookkeeping. The mirror map stores ONE entry per
  // canonical key, regardless of how many raw forms produced it.
  // The subscribe/unsubscribe machinery in TerminalGrid must therefore
  // also book-keep by canonical key, not raw cwd — otherwise a single
  // unsubscribe IPC tears down the SAME canonical that multiple
  // raw-form subscriptions were keeping alive (the cross-tab phantom
  // staleness root cause locked in by GSM-17/18). The renderer-side
  // dedupe by `normalizeTerminalGitPath` plus the router-side per-
  // (wcId, canonical) refCount are the two halves of this contract.
  const rawForms = [
    '/var/tmp/repo-A',
    '/private/var/tmp/repo-A',
    '/var/tmp/repo-A/.',
    '/var/tmp/repo-A/',
    '/private/var/tmp/repo-A/nested/..',
    '/var/tmp//repo-A'
  ]
  const canonical = '/var/tmp/repo-A'
  for (const raw of rawForms) {
    assert.equal(normalizeTerminalGitPath(raw), canonical, `expected ${raw} to normalize to ${canonical}`)
  }

  // Subscribing each raw form via mergeMirrorSnapshot collapses to ONE map entry.
  let snapshots: Record<string, GitStateMirrorSnapshot> = {}
  for (const raw of rawForms) {
    snapshots = mergeMirrorSnapshot(snapshots, snapshot(raw, 'clean'))
  }
  assert.equal(Object.keys(snapshots).length, 1)
  assert.equal(Object.keys(snapshots)[0], canonical)

  // The delta merge path keys identically — a worker emit with the
  // canonical form writes back into the same entry the renderer
  // populated via the legacy `/var/...` form (and vice versa).
  const post = mergeMirrorDeltaSnapshot(snapshots, '/private/var/tmp/repo-A', {
    status: 'modified',
    files: [],
    changeFingerprint: 'modified',
    capturedAt: 300,
    generation: 7
  })
  assert.equal(Object.keys(post).length, 1)
  assert.equal(post[canonical].status, 'modified')
  assert.equal(post[canonical].generation, 7)
})

test('surfaces mirror ahead/behind through the display state', () => {
  const snapshots = mergeMirrorSnapshot({}, snapshot('/private/var/tmp/repo-A', 'clean', { ahead: 2, behind: 1 }))
  const aliases = mergeMirrorAlias({}, '/var/tmp/repo-A/.', '/private/var/tmp/repo-A')
  const resolved = resolveTerminalGitDisplayState({
    cwd: '/var/tmp/repo-A/.',
    terminalInfo: null,
    mirrorSnapshots: snapshots,
    mirrorAliases: aliases
  })
  assert.equal(resolved.ahead, 2)
  assert.equal(resolved.behind, 1)
})

test('ahead/behind are null when only legacy info exists (no mirror snapshot)', () => {
  // The legacy TerminalGitInfo RPC has no ahead/behind — the display state must
  // report null rather than inventing a count, so no arrows render.
  const resolved = resolveTerminalGitDisplayState({
    cwd: '/var/tmp/repo-A',
    terminalInfo: {
      cwd: '/var/tmp/repo-A',
      repoRoot: '/var/tmp/repo-A',
      branch: 'feature/status',
      repoName: 'repo',
      status: 'clean'
    },
    mirrorSnapshots: {},
    mirrorAliases: {}
  })
  assert.equal(resolved.status, 'clean')
  assert.equal(resolved.ahead, null)
  assert.equal(resolved.behind, null)
})

test('delta merge carries ahead/behind into the snapshot (badge refresh signal)', () => {
  let snapshots = mergeMirrorSnapshot({}, snapshot('/private/var/tmp/repo-A', 'clean', { ahead: 0, behind: 0 }))
  // A background fetch advanced origin → behind becomes 1 via a delta.
  snapshots = mergeMirrorDeltaSnapshot(snapshots, '/private/var/tmp/repo-A', {
    behind: 1,
    capturedAt: 200
  })
  const resolved = resolveTerminalGitDisplayState({
    cwd: '/private/var/tmp/repo-A',
    terminalInfo: null,
    mirrorSnapshots: snapshots,
    mirrorAliases: {}
  })
  assert.equal(resolved.behind, 1)
  assert.equal(resolved.ahead, 0)
})

test('does not fall back to legacy info when cwd identity differs and mirror is absent', () => {
  const resolved = resolveTerminalGitDisplayState({
    cwd: '/var/tmp/repo-B',
    terminalInfo: {
      cwd: '/var/tmp/repo-A',
      repoRoot: '/var/tmp/repo-A',
      branch: 'feature/status',
      repoName: 'repo',
      status: 'modified'
    },
    mirrorSnapshots: {},
    mirrorAliases: {}
  })

  assert.equal(resolved.branch, null)
  assert.equal(resolved.repoName, null)
  assert.equal(resolved.status, null)
  assert.equal(resolved.legacyMatchesCwd, false)
})

// ── Symlink alias-gap block (2026-07-16 "symlinked repo shows no git status"
// fix). Snapshots and deltas are keyed by the canonical REAL path; a Task
// whose OSC cwd goes through a user symlink (macOS/Linux) or junction
// (Windows) can only reach them via the alias map. The fix guarantees the
// alias exists even when `subscribeMirror` resolved COLD (snapshot null) —
// these tests pin both the failure mode and the repaired path. ──

test('symlink cwd with NO alias cannot reach a realpath-keyed snapshot (the pre-fix failure mode)', () => {
  const snapshots = mergeMirrorSnapshot({}, snapshot('/Users/dev/real-repo', 'clean'))
  // Direct lookup misses (keys differ) and no alias exists — exactly the
  // cold-subscribe gap: the badge resolves to null everywhere.
  assert.equal(resolveMirrorSnapshotForCwd(snapshots, {}, '/Users/dev/link-to-repo'), null)
  const resolved = resolveTerminalGitDisplayState({
    cwd: '/Users/dev/link-to-repo',
    terminalInfo: {
      cwd: '/Users/dev/real-repo',
      repoRoot: '/Users/dev/real-repo',
      branch: 'feature/status',
      repoName: 'repo',
      status: 'clean'
    },
    mirrorSnapshots: snapshots,
    mirrorAliases: {}
  })
  // Legacy fallback cannot save it either: symlink form ≠ realpath form
  // under the pure-string normalizer.
  assert.equal(resolved.branch, null)
  assert.equal(resolved.status, null)
  assert.equal(resolved.legacyMatchesCwd, false)
})

test('a cold-subscribe alias (raw symlink → canonicalCwd) bridges the badge before any snapshot exists', () => {
  // Step 1: subscribeMirror resolves COLD — { canonicalCwd, snapshot: null }.
  // The fix registers the alias from canonicalCwd alone.
  let aliases = mergeMirrorAlias({}, '/Users/dev/link-to-repo', '/Users/dev/real-repo')
  let snapshots = {}
  // Nothing to show yet, but the resolve path must not throw / mis-resolve.
  assert.equal(resolveMirrorSnapshotForCwd(snapshots, aliases, '/Users/dev/link-to-repo'), null)
  // Step 2: the first mirror-update delta lands under the REAL path.
  snapshots = mergeMirrorDeltaSnapshot(snapshots, '/Users/dev/real-repo', {
    repoRoot: '/Users/dev/real-repo',
    repoName: 'repo',
    branch: 'main',
    status: 'clean',
    files: [],
    capturedAt: 200,
    changeFingerprint: 'fp-1',
    generation: 1
  })
  // Step 3: the symlink cwd now resolves through the alias.
  const viaLink = resolveMirrorSnapshotForCwd(snapshots, aliases, '/Users/dev/link-to-repo')
  assert.equal(viaLink?.branch, 'main')
  const resolved = resolveTerminalGitDisplayState({
    cwd: '/Users/dev/link-to-repo',
    terminalInfo: null,
    mirrorSnapshots: snapshots,
    mirrorAliases: aliases
  })
  assert.equal(resolved.branch, 'main')
  assert.equal(resolved.status, 'clean')
})

test('mergeMirrorAlias is a no-op when raw and canonical normalize to the same key', () => {
  const base = {}
  // /private strip: macOS firmlink forms collapse without needing an alias.
  assert.equal(mergeMirrorAlias(base, '/private/var/tmp/repo-A', '/var/tmp/repo-A'), base)
  // Identical spelling.
  assert.equal(mergeMirrorAlias(base, '/Users/dev/repo', '/Users/dev/repo'), base)
  // Windows junction form: backslash raw vs forward-slash canonical of the
  // SAME path is separator-only difference — no alias entry needed.
  assert.equal(mergeMirrorAlias(base, 'C:\\Temp\\repo', 'C:/Temp/repo'), base)
  // A genuinely different junction target DOES create one.
  const withAlias = mergeMirrorAlias(base, 'C:\\links\\repo', 'D:/real/repo')
  assert.equal(withAlias['c:/links/repo'], 'd:/real/repo')
})
