/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 *
 * Pure-logic coverage for the HTML Preview protocol boundary. The paired
 * renderer autotests verify that the resulting iframe is composited with the
 * host UI and can be covered by menus and dialogs.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  buildHtmlPreviewUrl,
  classifyHtmlPreviewLink,
  isInPageAnchorHref,
  resolveHtmlPreviewRequest
} from '../../electron/main/html-preview-path.ts'
import { isHtmlPreviewBridgeMessage } from '../../src/utils/html-preview-bridge.ts'

test('HPP-U-01 POSIX paths survive a protocol URL round-trip', () => {
  const rootPath = '/tmp/preview root'
  const filePath = '/tmp/preview root/页面/index file.html'
  const url = buildHtmlPreviewUrl('session-a', filePath, 17, 'posix')
  const result = resolveHtmlPreviewRequest(url, {
    sessionId: 'session-a',
    rootPath,
    platform: 'posix'
  })

  assert.equal(result.success, true)
  assert.equal(result.filePath, filePath)
  assert.equal(new URL(url).searchParams.get('onwardHtmlReload'), '17')
})

test('HPP-U-02 sibling assets inside the project root are allowed', () => {
  const result = resolveHtmlPreviewRequest(
    buildHtmlPreviewUrl('session-a', '/workspace/site/assets/app.js', 0, 'posix'),
    { sessionId: 'session-a', rootPath: '/workspace/site', platform: 'posix' }
  )

  assert.deepEqual(result, {
    success: true,
    filePath: '/workspace/site/assets/app.js'
  })
})

test('HPP-U-03 traversal and prefix-sibling paths are rejected', () => {
  const traversal = resolveHtmlPreviewRequest(
    'onward-html-preview://session-a/tmp/project/../secret.html',
    { sessionId: 'session-a', rootPath: '/tmp/project', platform: 'posix' }
  )
  const prefixSibling = resolveHtmlPreviewRequest(
    buildHtmlPreviewUrl('session-a', '/tmp/project-copy/secret.html', 0, 'posix'),
    { sessionId: 'session-a', rootPath: '/tmp/project', platform: 'posix' }
  )

  assert.equal(traversal.success, false)
  assert.equal(prefixSibling.success, false)
})

test('HPP-U-04 requests cannot cross preview sessions or schemes', () => {
  const validUrl = buildHtmlPreviewUrl('session-a', '/tmp/project/index.html', 0, 'posix')
  const wrongSession = resolveHtmlPreviewRequest(validUrl, {
    sessionId: 'session-b',
    rootPath: '/tmp/project',
    platform: 'posix'
  })
  const wrongScheme = resolveHtmlPreviewRequest(validUrl.replace('onward-html-preview:', 'file:'), {
    sessionId: 'session-a',
    rootPath: '/tmp/project',
    platform: 'posix'
  })

  assert.equal(wrongSession.success, false)
  assert.equal(wrongScheme.success, false)
})

test('HPP-U-05 Windows drive paths use the same containment rules', () => {
  const filePath = 'C:\\work tree\\site\\页面\\index.html'
  const allowed = resolveHtmlPreviewRequest(
    buildHtmlPreviewUrl('win-session', filePath, 3, 'win32'),
    { sessionId: 'win-session', rootPath: 'C:\\work tree\\site', platform: 'win32' }
  )
  const outside = resolveHtmlPreviewRequest(
    buildHtmlPreviewUrl('win-session', 'C:\\work tree\\secret.html', 3, 'win32'),
    { sessionId: 'win-session', rootPath: 'C:\\work tree\\site', platform: 'win32' }
  )

  assert.equal(allowed.success, true)
  assert.equal(allowed.filePath, filePath)
  assert.equal(outside.success, false)
})

test('HPP-U-06 bridge messages require the marker, version, and session token', () => {
  const valid = {
    marker: 'onward-html-preview',
    version: 1,
    sessionId: 'session-a',
    type: 'state',
    payload: { title: 'Preview' }
  }

  assert.equal(isHtmlPreviewBridgeMessage(valid, 'session-a'), true)
  assert.equal(isHtmlPreviewBridgeMessage({ ...valid, sessionId: 'session-b' }, 'session-a'), false)
  assert.equal(isHtmlPreviewBridgeMessage({ ...valid, marker: 'forged' }, 'session-a'), false)
  assert.equal(isHtmlPreviewBridgeMessage(null, 'session-a'), false)
})

test('HPP-U-07 in-page anchor classification reads the RAW href attribute', () => {
  // Pure-hash links are handled inside the bridge as programmatic scrolls.
  assert.equal(isInPageAnchorHref('#section-1'), true)
  assert.equal(isInPageAnchorHref('#'), true)
  assert.equal(isInPageAnchorHref('#%E4%B8%AD%E6%96%87'), true)
  // Anything that is not a bare fragment stays on the navigate-request path.
  assert.equal(isInPageAnchorHref(''), false)
  assert.equal(isInPageAnchorHref('page.html#section'), false)
  assert.equal(isInPageAnchorHref('./page.html'), false)
  assert.equal(isInPageAnchorHref('?query#hash'), false)
  assert.equal(isInPageAnchorHref('https://example.com/#hash'), false)
  // The resolved DOM `href` property (absolute URL) must classify as NOT an
  // anchor — feeding it instead of the raw attribute is the historical bug.
  assert.equal(isInPageAnchorHref('onward-html-preview://s/a.html#section'), false)
  // Non-string attribute reads (null when the attribute is absent).
  assert.equal(isInPageAnchorHref(null), false)
  assert.equal(isInPageAnchorHref(undefined), false)
})

test('HPP-U-08 link classification routes http(s) to external', () => {
  const options = { sessionId: 'session-a', rootPath: '/tmp/project', platform: 'posix' as const }
  assert.deepEqual(classifyHtmlPreviewLink('https://example.com/doc.md', options), { kind: 'external' })
  assert.deepEqual(classifyHtmlPreviewLink('http://localhost:8000/', options), { kind: 'external' })
})

test('HPP-U-09 link classification keeps in-root HTML documents in the iframe', () => {
  const options = { sessionId: 'session-a', rootPath: '/tmp/project', platform: 'posix' as const }
  for (const name of ['sub/page.html', 'sub/page.htm', 'sub/page.xhtml']) {
    const url = buildHtmlPreviewUrl('session-a', `/tmp/project/${name}`, 0, 'posix')
    const result = classifyHtmlPreviewLink(url, options)
    assert.equal(result.kind, 'in-frame', name)
  }
})

test('HPP-U-10 link classification dispatches other in-root files with a slash-relative path', () => {
  const options = { sessionId: 'session-a', rootPath: '/tmp/project', platform: 'posix' as const }
  const cases: Array<[string, string]> = [
    ['/tmp/project/docs/notes.md', 'docs/notes.md'],
    ['/tmp/project/src/main.py', 'src/main.py'],
    ['/tmp/project/manual.pdf', 'manual.pdf'],
    ['/tmp/project/LICENSE', 'LICENSE'],
    ['/tmp/project/图 片/说明.md', '图 片/说明.md']
  ]
  for (const [absolute, expectedRelative] of cases) {
    const url = buildHtmlPreviewUrl('session-a', absolute, 0, 'posix')
    const result = classifyHtmlPreviewLink(url, options)
    assert.equal(result.kind, 'project-file', absolute)
    assert.equal(result.kind === 'project-file' ? result.relativePath : null, expectedRelative)
    assert.equal(result.kind === 'project-file' ? result.filePath : null, absolute)
  }
})

test('HPP-U-11 link classification refuses escapes and foreign schemes', () => {
  const options = { sessionId: 'session-a', rootPath: '/tmp/project', platform: 'posix' as const }
  const outside = classifyHtmlPreviewLink(
    buildHtmlPreviewUrl('session-a', '/tmp/other/readme.md', 0, 'posix'),
    options
  )
  assert.deepEqual(outside, { kind: 'outside-root' })
  const traversal = classifyHtmlPreviewLink(
    'onward-html-preview://session-a/tmp/project/../secret.md',
    options
  )
  assert.deepEqual(traversal, { kind: 'outside-root' })
  // file:// is no longer foreign — it resolves against the root (HPP-U-14);
  // genuinely unknown schemes stay refused.
  const foreignScheme = classifyHtmlPreviewLink('vscode://file/tmp/project/readme.md', options)
  assert.equal(foreignScheme.kind, 'invalid')
  const wrongSession = classifyHtmlPreviewLink(
    buildHtmlPreviewUrl('session-b', '/tmp/project/readme.md', 0, 'posix'),
    options
  )
  assert.equal(wrongSession.kind, 'invalid')
})

test('HPP-U-12 link classification handles Windows drive paths', () => {
  const options = { sessionId: 'win-session', rootPath: 'C:\\work tree\\site', platform: 'win32' as const }
  const mdUrl = buildHtmlPreviewUrl('win-session', 'C:\\work tree\\site\\docs\\说明.md', 0, 'win32')
  const md = classifyHtmlPreviewLink(mdUrl, options)
  assert.equal(md.kind, 'project-file')
  assert.equal(md.kind === 'project-file' ? md.relativePath : null, 'docs/说明.md')
  const htmlUrl = buildHtmlPreviewUrl('win-session', 'C:\\work tree\\site\\sub\\page.html', 0, 'win32')
  assert.equal(classifyHtmlPreviewLink(htmlUrl, options).kind, 'in-frame')
  const outsideUrl = buildHtmlPreviewUrl('win-session', 'C:\\work tree\\secret.md', 0, 'win32')
  assert.deepEqual(classifyHtmlPreviewLink(outsideUrl, options), { kind: 'outside-root' })
})

test('HPP-U-13 link classification routes mailto/tel to the OS handler and refuses danger protocols', () => {
  const options = { sessionId: 'session-a', rootPath: '/tmp/project', platform: 'posix' as const }
  assert.deepEqual(classifyHtmlPreviewLink('mailto:a@b.c', options), { kind: 'external-protocol' })
  assert.deepEqual(classifyHtmlPreviewLink('tel:+8610000000', options), { kind: 'external-protocol' })
  assert.equal(classifyHtmlPreviewLink('data:text/plain,hi', options).kind, 'invalid')
  assert.equal(classifyHtmlPreviewLink('javascript:alert(1)', options).kind, 'invalid')
})

test('HPP-U-14 absolute file:// links resolve against the project root', () => {
  const options = { sessionId: 'session-a', rootPath: '/tmp/project', platform: 'posix' as const }
  // In-root HTML → iframe route, rebuilt onto the preview protocol with the
  // author's fragment preserved.
  const inRootHtml = classifyHtmlPreviewLink('file:///tmp/project/docs/page.html#section-2', options)
  assert.equal(inRootHtml.kind, 'in-frame')
  if (inRootHtml.kind === 'in-frame') {
    assert.equal(inRootHtml.filePath, '/tmp/project/docs/page.html')
    assert.ok(inRootHtml.url.startsWith('onward-html-preview://session-a/'))
    assert.ok(inRootHtml.url.endsWith('#section-2'))
  }
  // In-root non-HTML → viewer dispatch.
  assert.deepEqual(classifyHtmlPreviewLink('file:///tmp/project/docs/notes.md', options), {
    kind: 'project-file',
    filePath: '/tmp/project/docs/notes.md',
    relativePath: 'docs/notes.md'
  })
  // Outside root / UNC-host file URLs are refused.
  assert.deepEqual(classifyHtmlPreviewLink('file:///tmp/other/readme.md', options), { kind: 'outside-root' })
  assert.deepEqual(classifyHtmlPreviewLink('file://server/share/readme.md', options), { kind: 'outside-root' })
  // Windows drive form.
  const winOptions = { sessionId: 'win-session', rootPath: 'C:\\proj', platform: 'win32' as const }
  assert.deepEqual(classifyHtmlPreviewLink('file:///C:/proj/docs/notes.md', winOptions), {
    kind: 'project-file',
    filePath: 'C:\\proj\\docs\\notes.md',
    relativePath: 'docs/notes.md'
  })
})

