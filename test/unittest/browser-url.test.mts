/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  clampAutoRefreshIntervalMs,
  formatAutoRefreshInterval,
  isLocalOrPrivateHost,
  localPathToFileUrl,
  looksLikeLocalPath,
  resolveBrowserInputToUrl
} from '../../src/utils/browser-url.ts'

test('OBURL-U-01 resolves explicit and empty input', () => {
  assert.equal(resolveBrowserInputToUrl(''), null)
  assert.equal(resolveBrowserInputToUrl('   '), null)
  assert.equal(resolveBrowserInputToUrl('about:blank'), 'about:blank')
  assert.equal(resolveBrowserInputToUrl('https://example.com'), 'https://example.com/')
  assert.equal(resolveBrowserInputToUrl('http://example.com/x'), 'http://example.com/x')
  assert.equal(resolveBrowserInputToUrl('file:///tmp/a.html'), 'file:///tmp/a.html')
})

test('OBURL-U-02 scheme-less public domains default to https', () => {
  assert.equal(resolveBrowserInputToUrl('example.com'), 'https://example.com/')
  assert.equal(resolveBrowserInputToUrl('docs.example.co.uk/path'), 'https://docs.example.co.uk/path')
})

test('OBURL-U-03 scheme-less localhost / local IP default to http', () => {
  assert.equal(resolveBrowserInputToUrl('localhost'), 'http://localhost/')
  assert.equal(resolveBrowserInputToUrl('localhost:3000/x'), 'http://localhost:3000/x')
  assert.equal(resolveBrowserInputToUrl('127.0.0.1:8080'), 'http://127.0.0.1:8080/')
  assert.equal(resolveBrowserInputToUrl('192.168.1.5'), 'http://192.168.1.5/')
  assert.equal(resolveBrowserInputToUrl('10.0.0.2'), 'http://10.0.0.2/')
  assert.equal(resolveBrowserInputToUrl('0.0.0.0:8000'), 'http://0.0.0.0:8000/')
  assert.equal(resolveBrowserInputToUrl('[::1]:3000'), 'http://[::1]:3000/')
  assert.equal(resolveBrowserInputToUrl('169.254.1.1'), 'http://169.254.1.1/')
})

test('OBURL-U-04 explicit scheme on a local host is respected', () => {
  assert.equal(resolveBrowserInputToUrl('https://localhost'), 'https://localhost/')
  assert.equal(resolveBrowserInputToUrl('http://example.com'), 'http://example.com/')
})

test('OBURL-U-05 absolute local paths become file:// URLs', () => {
  assert.equal(resolveBrowserInputToUrl('/Users/me/x.html'), 'file:///Users/me/x.html')
  assert.equal(resolveBrowserInputToUrl('C:\\Users\\me\\x.html'), 'file:///C:/Users/me/x.html')
  assert.equal(resolveBrowserInputToUrl('C:/Users/me/x.html'), 'file:///C:/Users/me/x.html')
  assert.equal(resolveBrowserInputToUrl('\\\\server\\share\\x.html'), 'file://server/share/x.html')
})

test('OBURL-U-06 expands ~ using the injected home directory', () => {
  assert.equal(resolveBrowserInputToUrl('~/notes/x.html', { homeDir: '/Users/me' }), 'file:///Users/me/notes/x.html')
  assert.equal(resolveBrowserInputToUrl('~', { homeDir: '/Users/me' }), 'file:///Users/me')
  // Without homeDir, "~" is not a path -> falls through to search.
  assert.equal(resolveBrowserInputToUrl('~/notes'), 'https://www.google.com/search?q=~%2Fnotes')
})

test('OBURL-U-07 non-URL input falls back to a search query', () => {
  assert.equal(resolveBrowserInputToUrl('hello world'), 'https://www.google.com/search?q=hello%20world')
  assert.equal(resolveBrowserInputToUrl('just-text'), 'https://www.google.com/search?q=just-text')
})

test('OBURL-U-08 localPathToFileUrl encodes per segment', () => {
  assert.equal(localPathToFileUrl('/Users/me/x.html'), 'file:///Users/me/x.html')
  assert.equal(localPathToFileUrl('/Users/me/my file.html'), 'file:///Users/me/my%20file.html')
  assert.equal(localPathToFileUrl('C:\\Users\\me\\x.html'), 'file:///C:/Users/me/x.html')
  assert.equal(localPathToFileUrl('\\\\server\\share\\x'), 'file://server/share/x')
  assert.equal(localPathToFileUrl('C:\\'), 'file:///C:/')
  assert.equal(localPathToFileUrl('relative/path'), null)
  assert.equal(localPathToFileUrl(''), null)
})

test('OBURL-U-09 looksLikeLocalPath distinguishes paths from URLs', () => {
  assert.equal(looksLikeLocalPath('/Users/x'), true)
  assert.equal(looksLikeLocalPath('C:\\x'), true)
  assert.equal(looksLikeLocalPath('C:/x'), true)
  assert.equal(looksLikeLocalPath('\\\\server\\share'), true)
  assert.equal(looksLikeLocalPath('//example.com'), false) // protocol-relative, not a path
  assert.equal(looksLikeLocalPath('relative'), false)
  assert.equal(looksLikeLocalPath('http://x'), false)
})

test('OBURL-U-10 isLocalOrPrivateHost classifies hosts', () => {
  for (const h of ['localhost', 'foo.localhost', '127.0.0.1', '10.1.2.3', '172.16.0.1', '192.168.0.1', '169.254.0.1', '0.0.0.0', '::1', '[::1]', 'fd00::1']) {
    assert.equal(isLocalOrPrivateHost(h), true, `${h} should be local`)
  }
  for (const h of ['example.com', '8.8.8.8', '172.32.0.1', '256.1.1.1', '']) {
    assert.equal(isLocalOrPrivateHost(h), false, `${h} should not be local`)
  }
})

test('OBURL-U-11 clampAutoRefreshIntervalMs: null/invalid -> null, else floored to 5s', () => {
  assert.equal(clampAutoRefreshIntervalMs(null), null)
  assert.equal(clampAutoRefreshIntervalMs(undefined), null)
  assert.equal(clampAutoRefreshIntervalMs(0), null)
  assert.equal(clampAutoRefreshIntervalMs(-10), null)
  assert.equal(clampAutoRefreshIntervalMs(Number.NaN), null)
  assert.equal(clampAutoRefreshIntervalMs(1000), 5_000) // floor
  assert.equal(clampAutoRefreshIntervalMs(5_000), 5_000)
  assert.equal(clampAutoRefreshIntervalMs(30_000), 30_000)
  assert.equal(clampAutoRefreshIntervalMs(300_000), 300_000)
})

test('OBURL-U-12 formatAutoRefreshInterval: compact s/m label', () => {
  assert.equal(formatAutoRefreshInterval(5_000), '5s')
  assert.equal(formatAutoRefreshInterval(30_000), '30s')
  assert.equal(formatAutoRefreshInterval(60_000), '1m')
  assert.equal(formatAutoRefreshInterval(300_000), '5m')
  assert.equal(formatAutoRefreshInterval(1_800_000), '30m')
})
