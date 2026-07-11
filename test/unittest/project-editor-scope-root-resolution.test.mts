/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 *
 * Unit tests for the Project Editor per-Task state-key scheme: the canonical
 * [terminalId, repo-root] key plus the legacy-entry adoption that rescues
 * state persisted under an older cwd-based key (pre repo-root normalization).
 * Paired autotest: run-project-editor-multi-terminal-scope-autotest.sh
 * (PEMS-27..29 cwd-drift scenario).
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  buildProjectEditorStateKey,
  collectLegacyProjectEditorStateKeys,
  findLegacyProjectEditorStateEntry,
  findStickyProjectEditorRoot
} from '../../src/utils/projectEditorStateKey.ts'
import type { ProjectEditorState } from '../../src/types/tab.d.ts'

function makeState(rootPath: string | null, savedAt: number): ProjectEditorState {
  return {
    rootPath,
    activeFilePath: rootPath ? `${rootPath}/README.md` : null,
    expandedDirs: [],
    savedAt
  }
}

test('PSRK-U-01 canonical key is [terminalId, slash-normalized cwd]', () => {
  assert.equal(
    buildProjectEditorStateKey({ terminalId: 't1', cwd: 'C:\\repo\\sub' }),
    JSON.stringify(['t1', 'C:/repo/sub'])
  )
})

test('PSRK-U-02 key is null without terminalId or cwd', () => {
  assert.equal(buildProjectEditorStateKey({ terminalId: null, cwd: '/repo' }), null)
  assert.equal(buildProjectEditorStateKey({ terminalId: 't1', cwd: null }), null)
  assert.equal(buildProjectEditorStateKey({ terminalId: '  ', cwd: '/repo' }), null)
})

test('PSRK-U-03 legacy adoption matches same terminal + same rootPath under an old cwd key', () => {
  const states: Record<string, ProjectEditorState> = {
    [JSON.stringify(['t1', '/repo/subdir'])]: makeState('/repo', 100)
  }
  const hit = findLegacyProjectEditorStateEntry(states, 't1', '/repo', 'darwin')
  assert.ok(hit)
  assert.equal(hit.state.rootPath, '/repo')
})

test('PSRK-U-04 legacy adoption never matches another terminal', () => {
  const states: Record<string, ProjectEditorState> = {
    [JSON.stringify(['t2', '/repo/subdir'])]: makeState('/repo', 100)
  }
  assert.equal(findLegacyProjectEditorStateEntry(states, 't1', '/repo', 'darwin'), null)
})

test('PSRK-U-05 legacy adoption ignores entries whose rootPath differs', () => {
  const states: Record<string, ProjectEditorState> = {
    [JSON.stringify(['t1', '/other'])]: makeState('/other', 100)
  }
  assert.equal(findLegacyProjectEditorStateEntry(states, 't1', '/repo', 'darwin'), null)
})

test('PSRK-U-06 newest savedAt wins when several legacy entries qualify', () => {
  const states: Record<string, ProjectEditorState> = {
    [JSON.stringify(['t1', '/repo/a'])]: makeState('/repo', 100),
    [JSON.stringify(['t1', '/repo/b'])]: makeState('/repo', 300),
    [JSON.stringify(['t1', '/repo/c'])]: makeState('/repo', 200)
  }
  const hit = findLegacyProjectEditorStateEntry(states, 't1', '/repo', 'darwin')
  assert.equal(hit?.state.savedAt, 300)
})

test('PSRK-U-07 win32 matching folds case and separators; posix stays case-sensitive', () => {
  const states: Record<string, ProjectEditorState> = {
    [JSON.stringify(['t1', 'c:/Repo/sub'])]: makeState('C:\\Repo', 100)
  }
  assert.ok(findLegacyProjectEditorStateEntry(states, 't1', 'c:/repo', 'win32'))
  const posixStates: Record<string, ProjectEditorState> = {
    [JSON.stringify(['t1', '/Repo/sub'])]: makeState('/Repo', 100)
  }
  assert.equal(findLegacyProjectEditorStateEntry(posixStates, 't1', '/repo', 'darwin'), null)
})

test('PSRK-U-08 malformed keys are tolerated, not fatal', () => {
  const states: Record<string, ProjectEditorState> = {
    'not-json': makeState('/repo', 100),
    '{"weird":true}': makeState('/repo', 200),
    [JSON.stringify(['t1', '/repo/sub'])]: makeState('/repo', 50)
  }
  const hit = findLegacyProjectEditorStateEntry(states, 't1', '/repo', 'darwin')
  assert.equal(hit?.state.savedAt, 50)
})

test('PSRK-U-09 write-time migration collects sibling legacy keys but never the canonical key', () => {
  const canonicalKey = JSON.stringify(['t1', '/repo'])
  const states: Record<string, ProjectEditorState> = {
    [canonicalKey]: makeState('/repo', 400),
    [JSON.stringify(['t1', '/repo/sub'])]: makeState('/repo', 100),
    [JSON.stringify(['t2', '/repo/sub'])]: makeState('/repo', 100),
    [JSON.stringify(['t1', '/other'])]: makeState('/other', 100)
  }
  const legacyKeys = collectLegacyProjectEditorStateKeys(states, 't1', '/repo', canonicalKey, 'darwin')
  assert.deepEqual(legacyKeys, [JSON.stringify(['t1', '/repo/sub'])])
})

test('PSRK-U-10 sticky root: newest prior session whose root EQUALS the cwd wins', () => {
  const states: Record<string, ProjectEditorState> = {
    [JSON.stringify(['t1', '/repo/fixture'])]: makeState('/repo/fixture', 200),
    [JSON.stringify(['t1', '/repo'])]: makeState('/repo', 100)
  }
  assert.equal(findStickyProjectEditorRoot(states, 't1', '/repo/fixture', 'darwin'), '/repo/fixture')
  assert.equal(findStickyProjectEditorRoot(states, 't1', '/repo/fixture/', 'darwin'), '/repo/fixture')
})

test('PSRK-U-11 sticky root: deliberately NOT ancestor-contains — a nested project must re-root', () => {
  const states: Record<string, ProjectEditorState> = {
    [JSON.stringify(['t1', '/repo'])]: makeState('/repo', 100)
  }
  // A nested dir (its own git repo / tool workspace) falls through to
  // repo-root resolution instead of inheriting the ancestor session.
  assert.equal(findStickyProjectEditorRoot(states, 't1', '/repo/fixture/deep/sub', 'darwin'), null)
  assert.equal(findStickyProjectEditorRoot(states, 't1', '/elsewhere/project', 'darwin'), null)
  assert.equal(findStickyProjectEditorRoot(states, 't1', '/repo2', 'darwin'), null)
})

test('PSRK-U-12 sticky root: other terminals never contribute', () => {
  const states: Record<string, ProjectEditorState> = {
    [JSON.stringify(['t2', '/repo'])]: makeState('/repo', 100)
  }
  assert.equal(findStickyProjectEditorRoot(states, 't1', '/repo/sub', 'darwin'), null)
})

test('PSRK-U-13 sticky root: win32 folds case and separators', () => {
  const states: Record<string, ProjectEditorState> = {
    [JSON.stringify(['t1', 'c:/Repo'])]: makeState('C:\\Repo', 100)
  }
  assert.equal(findStickyProjectEditorRoot(states, 't1', 'c:\\repo', 'win32'), 'C:\\Repo')
  assert.equal(findStickyProjectEditorRoot(states, 't1', 'c:\\repo\\SUB', 'win32'), null)
})

test('PSRK-U-14 macOS firmlink aliases match (/var vs /private/var — TMPDIR fixture roots)', () => {
  const states: Record<string, ProjectEditorState> = {
    [JSON.stringify(['t1', '/var/folders/ab/scratch'])]: makeState('/var/folders/ab/scratch', 100)
  }
  // Sticky: terminal reports the realpath form, stored root is user-facing.
  assert.equal(
    findStickyProjectEditorRoot(states, 't1', '/private/var/folders/ab/scratch', 'darwin'),
    '/var/folders/ab/scratch'
  )
  // Legacy adoption crosses the alias too.
  assert.ok(findLegacyProjectEditorStateEntry(states, 't1', '/private/var/folders/ab/scratch', 'darwin'))
  // Linux must NOT alias /private paths.
  assert.equal(findStickyProjectEditorRoot(states, 't1', '/private/var/folders/ab/scratch', 'linux'), null)
})
