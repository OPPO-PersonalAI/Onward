/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 *
 * Pure decision tables for explicit Diff/History -> Editor navigation.
 * The paired autotest must prove the React/router wiring with real files;
 * these tests pin the state transitions that caused same-file rich viewers
 * and cross-root requests to be lost.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

type DiffJumpTarget = {
  filename: string
  repoRoot: string | null
  changeType: 'staged' | 'unstaged' | 'untracked' | 'conflict'
}

type ReturnBarInput = {
  source: 'diff' | 'history' | null
  jumpTarget: DiffJumpTarget | null
  jumpChecking: boolean
  activeFilePath: string | null
}

type ReturnBarState = {
  visible: boolean
  backEnabled: boolean
  jumpEnabled: boolean
  checking: boolean
  activeFilePath: string | null
}

type ResourceViewerReloadInput = {
  activeFilePath: string | null
  requestedFilePath: string
  hasUsablePreviewResource: boolean
}

type OpenRequestConsumptionInput = {
  isOpen: boolean
  alreadyHandled: boolean
  requestTerminalId: string
  editorTerminalId: string | null
  currentRoot: string | null
  expectedRoot: string | null
  hasFileTarget: boolean
  scopeReady: boolean
  platform: 'darwin' | 'linux' | 'win32'
}

type ResourceBackedSoftSnapshotInput = {
  isBinary: boolean
  isImage: boolean
  isSqlite: boolean
  isPdf: boolean
  isEpub: boolean
  isHtml: boolean
  isLargeFile?: boolean
}

type NavigationStateModule = {
  buildSubpageReturnBarState: (input: ReturnBarInput) => ReturnBarState
  shouldReloadResourceBackedViewer: (input: ResourceViewerReloadInput) => boolean
  shouldForceHtmlPreviewForNavigation: (input: {
    isHtml: boolean
    forceReload: boolean
    previewOpen: boolean
  }) => boolean
  canConsumeProjectEditorOpenRequest: (input: OpenRequestConsumptionInput) => boolean
  isResourceBackedSoftSnapshot: (input: ResourceBackedSoftSnapshotInput) => boolean
}

async function loadNavigationState(): Promise<NavigationStateModule> {
  return await import('../../src/components/ProjectEditor/navigationState.ts') as NavigationStateModule
}

async function loadSupportedImageExtensions(): Promise<Set<string>> {
  const imageUtils = await import('../../electron/main/image-utils.ts') as {
    SUPPORTED_IMAGE_EXTENSIONS: Set<string>
  }
  return imageUtils.SUPPORTED_IMAGE_EXTENSIONS
}

const diffTarget: DiffJumpTarget = {
  filename: 'docs/report.html',
  repoRoot: '/repo',
  changeType: 'unstaged'
}

test('PENS-U-01 no return source hides the return bar', async () => {
  const { buildSubpageReturnBarState } = await loadNavigationState()
  const state = buildSubpageReturnBarState({
    source: null,
    jumpTarget: diffTarget,
    jumpChecking: false,
    activeFilePath: 'docs/report.html'
  })

  assert.equal(state.visible, false)
  assert.equal(state.backEnabled, false)
  assert.equal(state.jumpEnabled, false)
})

test('PENS-U-02 Diff return exposes Back and an available exact-file Jump', async () => {
  const { buildSubpageReturnBarState } = await loadNavigationState()
  const state = buildSubpageReturnBarState({
    source: 'diff',
    jumpTarget: diffTarget,
    jumpChecking: false,
    activeFilePath: 'docs/report.html'
  })

  assert.equal(state.visible, true)
  assert.equal(state.backEnabled, true)
  assert.equal(state.jumpEnabled, true)
  assert.equal(state.checking, false)
})

test('PENS-U-03 Diff Jump stays disabled while its exact target is unresolved', async () => {
  const { buildSubpageReturnBarState } = await loadNavigationState()

  assert.equal(buildSubpageReturnBarState({
    source: 'diff',
    jumpTarget: null,
    jumpChecking: false,
    activeFilePath: 'docs/report.html'
  }).jumpEnabled, false)

  assert.equal(buildSubpageReturnBarState({
    source: 'diff',
    jumpTarget: diffTarget,
    jumpChecking: true,
    activeFilePath: 'docs/report.html'
  }).jumpEnabled, false)
})

test('PENS-U-04 History return exposes Back but never a Diff-style Jump', async () => {
  const { buildSubpageReturnBarState } = await loadNavigationState()
  const state = buildSubpageReturnBarState({
    source: 'history',
    jumpTarget: diffTarget,
    jumpChecking: false,
    activeFilePath: 'docs/report.html'
  })

  assert.equal(state.visible, true)
  assert.equal(state.backEnabled, true)
  assert.equal(state.jumpEnabled, false)
})

test('PENS-U-05 same-file PDF, EPUB, HTML and HTM reload when their preview resource was cleared', async () => {
  const { shouldReloadResourceBackedViewer } = await loadNavigationState()
  for (const path of ['docs/report.pdf', 'books/manual.epub', 'web/index.html', 'web/help.HTM']) {
    assert.equal(shouldReloadResourceBackedViewer({
      activeFilePath: path,
      requestedFilePath: path,
      hasUsablePreviewResource: false
    }), true, path)
  }
})

test('PENS-U-06 a still-usable rich preview does not trigger a redundant reload', async () => {
  const { shouldReloadResourceBackedViewer } = await loadNavigationState()
  for (const path of ['docs/report.pdf', 'books/manual.epub', 'web/index.html']) {
    assert.equal(shouldReloadResourceBackedViewer({
      activeFilePath: path,
      requestedFilePath: path,
      hasUsablePreviewResource: true
    }), false, path)
  }
})

test('PENS-U-07 normal text files and different-path opens stay on the existing open path', async () => {
  const { shouldReloadResourceBackedViewer } = await loadNavigationState()
  assert.equal(shouldReloadResourceBackedViewer({
    activeFilePath: 'README.md',
    requestedFilePath: 'README.md',
    hasUsablePreviewResource: false
  }), false)
  assert.equal(shouldReloadResourceBackedViewer({
    activeFilePath: 'docs/old.pdf',
    requestedFilePath: 'docs/new.pdf',
    hasUsablePreviewResource: false
  }), false)
})

test('PENS-U-08 a file-target request waits until the requested root is active', async () => {
  const { canConsumeProjectEditorOpenRequest } = await loadNavigationState()
  const base: OpenRequestConsumptionInput = {
    isOpen: true,
    alreadyHandled: false,
    requestTerminalId: 'term-1',
    editorTerminalId: 'term-1',
    currentRoot: '/repo/old',
    expectedRoot: '/repo/new',
    hasFileTarget: true,
    scopeReady: true,
    platform: 'darwin'
  }

  assert.equal(canConsumeProjectEditorOpenRequest(base), false)
  assert.equal(canConsumeProjectEditorOpenRequest({ ...base, currentRoot: '/repo/new', scopeReady: false }), false)
  assert.equal(canConsumeProjectEditorOpenRequest({ ...base, currentRoot: '/repo/new' }), true)
})

test('PENS-U-09 consumption rejects closed, duplicate, wrong-terminal and rootless requests', async () => {
  const { canConsumeProjectEditorOpenRequest } = await loadNavigationState()
  const ready: OpenRequestConsumptionInput = {
    isOpen: true,
    alreadyHandled: false,
    requestTerminalId: 'term-1',
    editorTerminalId: 'term-1',
    currentRoot: '/repo',
    expectedRoot: '/repo',
    hasFileTarget: true,
    scopeReady: true,
    platform: 'darwin'
  }

  assert.equal(canConsumeProjectEditorOpenRequest({ ...ready, isOpen: false }), false)
  assert.equal(canConsumeProjectEditorOpenRequest({ ...ready, alreadyHandled: true }), false)
  assert.equal(canConsumeProjectEditorOpenRequest({ ...ready, editorTerminalId: 'term-2' }), false)
  assert.equal(canConsumeProjectEditorOpenRequest({ ...ready, currentRoot: null }), false)
})

test('PENS-U-10 no-file subpage restore can consume without waiting for a root transition', async () => {
  const { canConsumeProjectEditorOpenRequest } = await loadNavigationState()
  assert.equal(canConsumeProjectEditorOpenRequest({
    isOpen: true,
    alreadyHandled: false,
    requestTerminalId: 'term-1',
    editorTerminalId: 'term-1',
    currentRoot: '/repo/old',
    expectedRoot: '/repo/new',
    hasFileTarget: false,
    scopeReady: false,
    platform: 'darwin'
  }), true)
})

test('PENS-U-11 Windows root readiness folds path separators and case', async () => {
  const { canConsumeProjectEditorOpenRequest } = await loadNavigationState()
  assert.equal(canConsumeProjectEditorOpenRequest({
    isOpen: true,
    alreadyHandled: false,
    requestTerminalId: 'term-1',
    editorTerminalId: 'term-1',
    currentRoot: 'C:\\Work\\Repo',
    expectedRoot: 'c:/work/repo/',
    hasFileTarget: true,
    scopeReady: true,
    platform: 'win32'
  }), true)
})

test('PENS-U-12 every supported image extension reloads a cleared same-file preview resource', async () => {
  const { shouldReloadResourceBackedViewer } = await loadNavigationState()
  const supportedImageExtensions = await loadSupportedImageExtensions()

  for (const extension of supportedImageExtensions) {
    const path = `images/sample${extension}`
    assert.equal(shouldReloadResourceBackedViewer({
      activeFilePath: path,
      requestedFilePath: path,
      hasUsablePreviewResource: false
    }), true, extension)
  }

  assert.equal(shouldReloadResourceBackedViewer({
    activeFilePath: 'images/sample.TIFF',
    requestedFilePath: 'images/sample.TIFF',
    hasUsablePreviewResource: false
  }), true)
})

test('PENS-U-13 all HTML and SQLite extensions reload a cleared same-file viewer resource', async () => {
  const { shouldReloadResourceBackedViewer } = await loadNavigationState()
  for (const path of [
    'web/index.html',
    'web/index.htm',
    'web/index.xhtml',
    'data/app.sqlite',
    'data/app.sqlite3',
    'data/app.db',
    'data/app.db3',
    'data/app.s3db'
  ]) {
    assert.equal(shouldReloadResourceBackedViewer({
      activeFilePath: path,
      requestedFilePath: path,
      hasUsablePreviewResource: false
    }), true, path)
  }
})

test('PENS-U-14 every resource-backed soft snapshot category requires a reload', async () => {
  const { isResourceBackedSoftSnapshot } = await loadNavigationState()
  const emptySnapshot: ResourceBackedSoftSnapshotInput = {
    isBinary: false,
    isImage: false,
    isSqlite: false,
    isPdf: false,
    isEpub: false,
    isHtml: false,
    isLargeFile: false
  }

  for (const key of [
    'isBinary',
    'isImage',
    'isSqlite',
    'isPdf',
    'isEpub',
    'isHtml',
    'isLargeFile'
  ] as const) {
    assert.equal(isResourceBackedSoftSnapshot({
      ...emptySnapshot,
      [key]: true
    }), true, key)
  }
})

test('PENS-U-15 a normal text soft snapshot does not require a resource reload', async () => {
  const { isResourceBackedSoftSnapshot } = await loadNavigationState()
  assert.equal(isResourceBackedSoftSnapshot({
    isBinary: false,
    isImage: false,
    isSqlite: false,
    isPdf: false,
    isEpub: false,
    isHtml: false
  }), false)
})

test('PENS-U-16 an explicit HTML navigation reload opens Preview without changing ordinary opens', async () => {
  const { shouldForceHtmlPreviewForNavigation } = await loadNavigationState()
  assert.equal(shouldForceHtmlPreviewForNavigation({
    isHtml: true,
    forceReload: true,
    previewOpen: false
  }), true)
  assert.equal(shouldForceHtmlPreviewForNavigation({
    isHtml: true,
    forceReload: false,
    previewOpen: false
  }), false)
  assert.equal(shouldForceHtmlPreviewForNavigation({
    isHtml: false,
    forceReload: true,
    previewOpen: false
  }), false)
  assert.equal(shouldForceHtmlPreviewForNavigation({
    isHtml: true,
    forceReload: true,
    previewOpen: true
  }), false)
})
