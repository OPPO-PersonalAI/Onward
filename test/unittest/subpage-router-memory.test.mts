/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import {
  buildSubpageRouteCommand,
  isSubpageSwitch,
  legacyNavigateDetailToRouteCommand,
  routeCommandToNavigateDetail,
  shouldApplySubpageTargetFile
} from '../../src/components/TerminalGrid/subpageRouter.ts'
import {
  buildSubpageMemoryScopeKey,
  createSubpageStateMemory,
  normalizeSubpageMemoryScope,
  resolveSubpageMemoryRoot,
  type EditorSubpageSnapshot
} from '../../src/components/TerminalGrid/subpageStateMemory.ts'
import { createSubpageLifecycleRegistry } from '../../src/components/TerminalGrid/subpageLifecycle.ts'

describe('subpage route command semantics', () => {
  it('keeps switch separate from jump even when source and target are known', () => {
    const command = buildSubpageRouteCommand({
      intent: 'switch',
      entryPoint: 'subpage-switcher',
      terminalId: 'term-1',
      from: 'diff',
      target: 'editor',
      filePath: 'src/App.tsx',
      repoRoot: '/repo'
    })

    assert.equal(isSubpageSwitch(command), true)
    assert.equal(shouldApplySubpageTargetFile(command), false)
    assert.equal(routeCommandToNavigateDetail(command).filePath, null)
  })

  it('allows jump commands to carry a target file', () => {
    const command = buildSubpageRouteCommand({
      intent: 'jump',
      entryPoint: 'deep-link',
      terminalId: 'term-1',
      from: 'diff',
      target: 'editor',
      filePath: 'src/App.tsx',
      repoRoot: '/repo',
      returnTarget: 'diff'
    })

    assert.equal(shouldApplySubpageTargetFile(command), true)
    const detail = routeCommandToNavigateDetail(command)
    assert.equal(detail.filePath, 'src/App.tsx')
    assert.equal(detail.repoRoot, '/repo')
    assert.equal(detail.intent, 'jump')
    assert.equal(detail.entryPoint, 'deep-link')
  })

  it('preserves changeType in a jump target built from the public route input', () => {
    const command = buildSubpageRouteCommand({
      intent: 'jump',
      entryPoint: 'deep-link',
      terminalId: 'term-1',
      from: 'editor',
      target: 'diff',
      filePath: 'src/App.tsx',
      repoRoot: '/repo',
      changeType: 'staged'
    } as Parameters<typeof buildSubpageRouteCommand>[0] & { changeType: 'staged' })

    assert.equal(
      (command.targetFile as typeof command.targetFile & { changeType?: string | null })?.changeType,
      'staged'
    )
  })

  it('serializes changeType into the navigation event for an exact diff jump', () => {
    const command = buildSubpageRouteCommand({
      intent: 'jump',
      entryPoint: 'deep-link',
      terminalId: 'term-1',
      from: 'editor',
      target: 'diff',
      filePath: 'src/App.tsx',
      repoRoot: '/repo'
    })
    const commandWithIdentity = {
      ...command,
      targetFile: command.targetFile
        ? { ...command.targetFile, changeType: 'unstaged' as const }
        : null
    }

    const detail = routeCommandToNavigateDetail(commandWithIdentity)
    assert.equal(
      (detail as typeof detail & { changeType?: string | null }).changeType,
      'unstaged'
    )
  })

  it('restores changeType when adapting a legacy jump event back into a route command', () => {
    const command = legacyNavigateDetailToRouteCommand(
      {
        terminalId: 'term-1',
        target: 'diff',
        filePath: 'src/App.tsx',
        repoRoot: '/repo',
        changeType: 'staged'
      } as Parameters<typeof legacyNavigateDetailToRouteCommand>[0] & { changeType: 'staged' },
      'editor'
    )

    assert.ok(command)
    assert.equal(
      (command.targetFile as typeof command.targetFile & { changeType?: string | null })?.changeType,
      'staged'
    )
  })

  it('clears every file identity field, including changeType, for a plain switch', () => {
    const command = buildSubpageRouteCommand({
      intent: 'switch',
      entryPoint: 'subpage-switcher',
      terminalId: 'term-1',
      from: 'editor',
      target: 'diff',
      filePath: 'src/App.tsx',
      repoRoot: '/repo'
    })
    const commandWithIdentity = {
      ...command,
      targetFile: command.targetFile
        ? { ...command.targetFile, changeType: 'unstaged' as const }
        : null
    }

    const detail = routeCommandToNavigateDetail(commandWithIdentity)
    assert.equal(detail.filePath, null)
    assert.equal(detail.repoRoot, null)
    assert.equal(
      (detail as typeof detail & { changeType?: string | null }).changeType,
      null
    )
  })

  it('preserves the source panel root for Back without turning the route into a file jump', () => {
    const command = buildSubpageRouteCommand({
      intent: 'switch',
      entryPoint: 'subpage-switcher',
      terminalId: 'term-1',
      from: 'editor',
      target: 'diff',
      panelRoot: '/source-repo'
    })

    assert.equal(shouldApplySubpageTargetFile(command), false)
    assert.equal(command.targetFile, null)
    assert.equal(command.panelRoot, '/source-repo')
    assert.equal(routeCommandToNavigateDetail(command).panelRoot, '/source-repo')
  })

  it('keeps History as a generic return source without Diff-only assumptions', () => {
    const detail = routeCommandToNavigateDetail(buildSubpageRouteCommand({
      intent: 'jump',
      entryPoint: 'deep-link',
      terminalId: 'term-1',
      from: 'history',
      target: 'editor',
      source: 'history',
      returnTarget: 'history',
      filePath: 'docs/report.html',
      repoRoot: '/repo'
    }))

    assert.equal(detail.source, 'history')
    assert.equal(detail.returnTarget, 'history')
    assert.equal(detail.filePath, 'docs/report.html')
    assert.equal(detail.repoRoot, '/repo')
  })

  it('infers legacy navigation without a file target as a switch', () => {
    const command = legacyNavigateDetailToRouteCommand(
      { terminalId: 'term-1', target: 'history' },
      'editor'
    )

    assert.ok(command)
    assert.equal(command.intent, 'switch')
    assert.equal(command.entryPoint, 'legacy-event')
    assert.equal(command.from, 'editor')
    assert.equal(command.target, 'history')
  })

  it('infers legacy navigation with a file target as a jump', () => {
    const command = legacyNavigateDetailToRouteCommand(
      { terminalId: 'term-1', target: 'editor', filePath: 'README.md', repoRoot: '/repo' },
      'diff'
    )

    assert.ok(command)
    assert.equal(command.intent, 'jump')
    assert.equal(command.targetFile?.filePath, 'README.md')
    assert.equal(command.targetFile?.repoRoot, '/repo')
  })
})

describe('subpage state memory', () => {
  it('uses the live panel root before the owner and terminal fallback roots', () => {
    assert.equal(resolveSubpageMemoryRoot('/repo-b', '/repo-a', '/terminal-repo'), '/repo-b')
    assert.equal(resolveSubpageMemoryRoot(null, '/repo-a/', '/terminal-repo'), '/repo-a')
    assert.equal(resolveSubpageMemoryRoot(null, null, '\\terminal-repo\\'), '/terminal-repo')
  })

  it('normalizes scope keys across path separators and trailing slashes', () => {
    const a = buildSubpageMemoryScopeKey({ terminalId: 'term-1', root: '/repo/root/' }, 'editor')
    const b = buildSubpageMemoryScopeKey({ terminalId: 'term-1', root: '/repo/root' }, 'editor')
    const c = buildSubpageMemoryScopeKey({ terminalId: 'term-1', root: '\\repo\\root\\' }, 'editor')

    assert.equal(a, b)
    assert.equal(c.includes('/repo/root'), true)
  })

  it('treats Windows root casing as the same memory scope', () => {
    const memory = createSubpageStateMemory()
    memory.save({ terminalId: 'term-1', root: 'C:\\Repo\\Project' }, {
      subpage: 'diff',
      selectedFilePath: 'src/App.tsx',
      selectedFileKey: 'unstaged:src/App.tsx',
      scrollTop: 144
    }, 1)

    const equivalentScope = { terminalId: 'term-1', root: 'c:/repo/project/' }
    assert.equal(
      buildSubpageMemoryScopeKey({ terminalId: 'term-1', root: 'C:\\Repo\\Project' }, 'diff'),
      buildSubpageMemoryScopeKey(equivalentScope, 'diff')
    )
    assert.equal(
      buildSubpageMemoryScopeKey({ terminalId: 'term-1', root: '\\\\Server\\Share\\Repo' }, 'history'),
      buildSubpageMemoryScopeKey({ terminalId: 'term-1', root: '//server/share/repo/' }, 'history')
    )
    assert.equal(memory.read(equivalentScope, 'diff')?.snapshot.selectedFilePath, 'src/App.tsx')
    assert.equal(memory.list(equivalentScope).length, 1)
    memory.clear(equivalentScope)
    assert.equal(memory.list().length, 0)
  })

  it('stores independent snapshots per subpage under the same scope', () => {
    const memory = createSubpageStateMemory()
    const scope = normalizeSubpageMemoryScope({ terminalId: 'term-1', root: '/repo' })
    const editorSnapshot: EditorSubpageSnapshot = {
      subpage: 'editor',
      activeFilePath: 'docs/a.md',
      markdownPreviewOpen: true,
      markdownEditorVisible: true,
      markdownRenderedHtmlLength: 128,
      previewRestorePhase: 'idle'
    }

    memory.save(scope, editorSnapshot, 1)
    memory.save(scope, {
      subpage: 'diff',
      selectedFilePath: 'src/App.tsx',
      selectedFileKey: 'key-1',
      scrollTop: 80,
      splitRatio: 0.55
    }, 2)

    assert.equal(memory.read(scope, 'editor')?.snapshot.activeFilePath, 'docs/a.md')
    assert.equal(memory.read(scope, 'diff')?.snapshot.selectedFilePath, 'src/App.tsx')
    assert.equal(memory.list(scope).length, 2)
  })

  it('preserves all History scroll positions in the subpage snapshot', () => {
    const memory = createSubpageStateMemory()
    const scope = normalizeSubpageMemoryScope({ terminalId: 'term-1', root: '/repo' })
    memory.save(scope, {
      subpage: 'history',
      selectedShas: ['abc123'],
      selectionAnchor: 'abc123',
      selectedFilePath: 'scroll-state.ts',
      commitScrollTop: 40,
      fileScrollTop: 80,
      diffScrollTop: 320
    }, 1)

    const snapshot = memory.read(scope, 'history')?.snapshot
    assert.equal(snapshot?.subpage, 'history')
    if (snapshot?.subpage !== 'history') assert.fail('expected History snapshot')
    assert.equal(snapshot.commitScrollTop, 40)
    assert.equal(snapshot.fileScrollTop, 80)
    assert.equal(snapshot.diffScrollTop, 320)
  })

  it('separates snapshots by tab when tab scope is supplied', () => {
    const memory = createSubpageStateMemory()
    memory.save({ terminalId: 'term-1', root: '/repo', tabId: 'tab-a' }, {
      subpage: 'history',
      selectedShas: ['a'],
      selectionAnchor: 'a',
      selectedFilePath: 'a.md'
    }, 1)
    memory.save({ terminalId: 'term-1', root: '/repo', tabId: 'tab-b' }, {
      subpage: 'history',
      selectedShas: ['b'],
      selectionAnchor: 'b',
      selectedFilePath: 'b.md'
    }, 2)

    assert.deepEqual(memory.read({ terminalId: 'term-1', root: '/repo', tabId: 'tab-a' }, 'history')?.snapshot.selectedShas, ['a'])
    assert.deepEqual(memory.read({ terminalId: 'term-1', root: '/repo', tabId: 'tab-b' }, 'history')?.snapshot.selectedShas, ['b'])
  })
})

describe('subpage lifecycle registry', () => {
  it('runs registered beforeLeave and afterEnter hooks', async () => {
    const registry = createSubpageLifecycleRegistry()
    let entered = false
    registry.register('editor', {
      beforeLeave: () => ({
        subpage: 'editor',
        activeFilePath: 'README.md',
        markdownPreviewOpen: true,
        markdownEditorVisible: true
      }),
      afterEnter: () => {
        entered = true
      }
    })
    const command = buildSubpageRouteCommand({
      intent: 'switch',
      entryPoint: 'subpage-switcher',
      terminalId: 'term-1',
      from: 'editor',
      target: 'diff'
    })

    const snapshot = await registry.beforeLeave('editor', { command })
    await registry.afterEnter('editor', { command })

    assert.equal(snapshot?.subpage, 'editor')
    assert.equal(entered, true)
  })
})
