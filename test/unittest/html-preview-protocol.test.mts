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
