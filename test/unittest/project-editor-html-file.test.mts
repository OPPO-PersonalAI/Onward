/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  deriveHtmlPreviewNavButtonState,
  formatHtmlPreviewZoomPercent,
  getHtmlFileExtension,
  isHtmlPreviewRefreshShortcut,
  isHtmlPath,
  isSameHtmlPreviewDocument,
  normalizeHtmlPreviewDocumentUrl,
  normalizeHtmlPreviewScrollState,
  normalizeHtmlPreviewZoomFactor,
  stepHtmlPreviewZoomFactor,
  withHtmlPreviewReloadKey
} from '../../src/utils/html-file.ts'

test('PEHTML-U-01 detects supported HTML extensions case-insensitively', () => {
  assert.equal(isHtmlPath('index.html'), true)
  assert.equal(isHtmlPath('INDEX.HTM'), true)
  assert.equal(isHtmlPath('docs/page.xhtml'), true)
  assert.equal(isHtmlPath('docs/page.md'), false)
  assert.equal(isHtmlPath('docs/html'), false)
})

test('PEHTML-U-02 extracts extensions across slash styles', () => {
  assert.equal(getHtmlFileExtension('docs/page.HTML'), 'html')
  assert.equal(getHtmlFileExtension('docs\\page.htm'), 'htm')
  assert.equal(getHtmlFileExtension('docs/page'), '')
  assert.equal(getHtmlFileExtension(null), '')
})

test('PEHTML-U-03 adds a reload key while preserving existing query params', () => {
  const next = withHtmlPreviewReloadKey('file:///tmp/page.html?mtime=123', 456)
  assert.equal(next, 'file:///tmp/page.html?mtime=123&onwardHtmlReload=456')
})

test('PEHTML-U-04 adds a reload key to plain URLs', () => {
  const next = withHtmlPreviewReloadKey('file:///tmp/page.html', 7)
  assert.equal(next, 'file:///tmp/page.html?onwardHtmlReload=7')
})

test('PEHTML-U-05 normalizes HTML preview scroll state from browser data', () => {
  assert.deepEqual(normalizeHtmlPreviewScrollState({
    x: 12.5,
    y: 480,
    scrollWidth: 900,
    scrollHeight: 1800,
    clientWidth: 700,
    clientHeight: 500
  }), {
    x: 12.5,
    y: 480,
    scrollWidth: 900,
    scrollHeight: 1800,
    clientWidth: 700,
    clientHeight: 500
  })
})

test('PEHTML-U-06 clamps invalid HTML preview scroll state fields', () => {
  assert.equal(normalizeHtmlPreviewScrollState(null), null)
  assert.deepEqual(normalizeHtmlPreviewScrollState({
    x: -10,
    y: Number.POSITIVE_INFINITY,
    scrollWidth: 'bad',
    scrollHeight: 200,
    clientWidth: undefined,
    clientHeight: 120
  }), {
    x: 0,
    y: 0,
    scrollWidth: 0,
    scrollHeight: 200,
    clientWidth: 0,
    clientHeight: 120
  })
})

test('PEHTML-U-07 normalizes HTML preview zoom factor', () => {
  assert.equal(normalizeHtmlPreviewZoomFactor(1.234), 1.23)
  assert.equal(normalizeHtmlPreviewZoomFactor(0.1), 0.5)
  assert.equal(normalizeHtmlPreviewZoomFactor(3), 2)
  assert.equal(normalizeHtmlPreviewZoomFactor(Number.NaN), 1)
  assert.equal(normalizeHtmlPreviewZoomFactor('bad'), 1)
})

test('PEHTML-U-08 steps HTML preview zoom factor within bounds', () => {
  assert.equal(stepHtmlPreviewZoomFactor(1, 'in'), 1.1)
  assert.equal(stepHtmlPreviewZoomFactor(1, 'out'), 0.9)
  assert.equal(stepHtmlPreviewZoomFactor(1.95, 'in'), 2)
  assert.equal(stepHtmlPreviewZoomFactor(0.55, 'out'), 0.5)
  assert.equal(stepHtmlPreviewZoomFactor(1.5, 'reset'), 1)
})

test('PEHTML-U-09 formats HTML preview zoom percent', () => {
  assert.equal(formatHtmlPreviewZoomPercent(1), '100%')
  assert.equal(formatHtmlPreviewZoomPercent(1.25), '125%')
  assert.equal(formatHtmlPreviewZoomPercent(0.5), '50%')
})

test('PEHTML-U-10 detects browser-aligned HTML preview refresh shortcuts', () => {
  assert.equal(isHtmlPreviewRefreshShortcut({ key: 'r', metaKey: true }), true)
  assert.equal(isHtmlPreviewRefreshShortcut({ key: 'R', ctrlKey: true }), true)
  assert.equal(isHtmlPreviewRefreshShortcut({ key: 'r', metaKey: true, shiftKey: true }), false)
  assert.equal(isHtmlPreviewRefreshShortcut({ key: 'r', ctrlKey: true, altKey: true }), false)
  assert.equal(isHtmlPreviewRefreshShortcut({ key: 'r' }), false)
  assert.equal(isHtmlPreviewRefreshShortcut({ key: 'f', metaKey: true }), false)
})

test('PEHTML-U-11 same document regardless of transient query params', () => {
  assert.equal(isSameHtmlPreviewDocument(
    'file:///p/a.html?mtime=1&onwardHtmlReload=5',
    'file:///p/a.html?mtime=999&onwardHtmlReload=0'
  ), true)
  assert.equal(isSameHtmlPreviewDocument(
    'file:///p/a.html?onwardHtmlReload=5',
    'file:///p/a.html'
  ), true)
})

test('PEHTML-U-12 different paths and POSIX case differences are different documents', () => {
  assert.equal(isSameHtmlPreviewDocument('file:///p/a.html?mtime=1', 'file:///p/b.html?mtime=1'), false)
  assert.equal(isSameHtmlPreviewDocument('file:///tmp/A.html', 'file:///tmp/a.html'), false)
})

test('PEHTML-U-13 hash counts as a different location', () => {
  // An in-page anchor click pushes a history entry and enables Back, so Home
  // must stay enabled (i.e. #hash is treated as navigated away from home).
  assert.equal(isSameHtmlPreviewDocument('file:///p/a.html?mtime=1#section', 'file:///p/a.html?mtime=2'), false)
  assert.equal(isSameHtmlPreviewDocument('file:///p/a.html#s', 'file:///p/a.html#s'), true)
})

test('PEHTML-U-14 windows drive letter case is insensitive', () => {
  assert.equal(isSameHtmlPreviewDocument(
    'file:///C:/Proj/a.html?mtime=1',
    'file:///c:/Proj/a.html?onwardHtmlReload=2'
  ), true)
  assert.equal(isSameHtmlPreviewDocument('file:///C:/Proj/a.html', 'file:///c:/proj/a.html'), false)
})

test('PEHTML-U-15 encoded path characters compare decoded and malformed escapes never throw', () => {
  assert.equal(isSameHtmlPreviewDocument('file:///tmp/my%20page.html?mtime=1', 'file:///tmp/my page.html'), true)
  assert.equal(isSameHtmlPreviewDocument('file:///tmp/%E4%B8%AD.html', 'file:///tmp/中.html'), true)
  assert.doesNotThrow(() => normalizeHtmlPreviewDocumentUrl('file:///tmp/bad%zz.html'))
  assert.equal(isSameHtmlPreviewDocument('file:///tmp/bad%zz.html', 'file:///tmp/bad%zz.html'), true)
})

test('PEHTML-U-16 null, empty, and unparseable inputs normalize to null and never match', () => {
  assert.equal(normalizeHtmlPreviewDocumentUrl(null), null)
  assert.equal(normalizeHtmlPreviewDocumentUrl(undefined), null)
  assert.equal(normalizeHtmlPreviewDocumentUrl(''), null)
  assert.equal(normalizeHtmlPreviewDocumentUrl('not a url at all'), null)
  assert.equal(isSameHtmlPreviewDocument(null, 'file:///p/a.html'), false)
  assert.equal(isSameHtmlPreviewDocument('file:///p/a.html', null), false)
  assert.equal(isSameHtmlPreviewDocument(null, null), false)
})

test('PEHTML-U-17 real query params are preserved and order-insensitive', () => {
  assert.equal(isSameHtmlPreviewDocument(
    'file:///p/a.html?x=1&y=2&mtime=3',
    'file:///p/a.html?y=2&x=1'
  ), true)
  assert.equal(isSameHtmlPreviewDocument('file:///p/a.html?x=1', 'file:///p/a.html?x=2'), false)
})

test('PEHTML-U-18 derives nav button state', () => {
  const atHome = {
    ready: true,
    canGoBack: false,
    canGoForward: false,
    currentUrl: 'file:///p/a.html?mtime=1&onwardHtmlReload=2',
    homeUrl: 'file:///p/a.html?mtime=9&onwardHtmlReload=0'
  }
  assert.deepEqual(deriveHtmlPreviewNavButtonState(atHome), {
    backEnabled: false,
    forwardEnabled: false,
    reloadEnabled: true,
    homeEnabled: false
  })
  assert.deepEqual(deriveHtmlPreviewNavButtonState({ ...atHome, ready: false }), {
    backEnabled: false,
    forwardEnabled: false,
    reloadEnabled: false,
    homeEnabled: false
  })
  assert.deepEqual(deriveHtmlPreviewNavButtonState({
    ...atHome,
    canGoBack: true,
    canGoForward: true,
    currentUrl: 'file:///p/other.html'
  }), {
    backEnabled: true,
    forwardEnabled: true,
    reloadEnabled: true,
    homeEnabled: true
  })
  assert.deepEqual(deriveHtmlPreviewNavButtonState({ ...atHome, canGoBack: true, homeUrl: null }), {
    backEnabled: true,
    forwardEnabled: false,
    reloadEnabled: true,
    homeEnabled: false
  })
})

test('PEHTML-U-19 a decoded delimiter in a filename never collides with a structural hash/query', () => {
  // A file literally named 'a.html#sec' (URL 'a.html%23sec') is a DIFFERENT
  // document from 'a.html' viewed at the '#sec' anchor. Same for '?'.
  assert.equal(isSameHtmlPreviewDocument('file:///tmp/a.html%23sec', 'file:///tmp/a.html#sec'), false)
  assert.equal(isSameHtmlPreviewDocument('file:///tmp/a.html%3Fx=1', 'file:///tmp/a.html?x=1'), false)
  // ...but a file named 'a.html#sec' still equals itself across transient params.
  assert.equal(isSameHtmlPreviewDocument('file:///tmp/a.html%23sec?mtime=1', 'file:///tmp/a.html%23sec?mtime=2'), true)
})

test('PEHTML-U-20 duplicated query keys are handled deterministically', () => {
  // Transient keys are deleted even when repeated.
  assert.equal(isSameHtmlPreviewDocument('file:///p/a.html?mtime=1&mtime=2&x=9', 'file:///p/a.html?x=9'), true)
  // Repeated real keys keep their value order, so a re-ordered pair differs.
  assert.equal(isSameHtmlPreviewDocument('file:///p/a.html?x=1&x=2', 'file:///p/a.html?x=1&x=2'), true)
  assert.equal(isSameHtmlPreviewDocument('file:///p/a.html?x=1&x=2', 'file:///p/a.html?x=2&x=1'), false)
})

test('PEHTML-U-21 pathological URLs normalize without throwing', () => {
  const longUrl = 'file:///tmp/' + 'x'.repeat(9000) + '.html?' +
    Array.from({ length: 400 }, (_, i) => `k${i}=1`).join('&')
  assert.doesNotThrow(() => normalizeHtmlPreviewDocumentUrl(longUrl))
  assert.equal(typeof normalizeHtmlPreviewDocumentUrl(longUrl), 'string')
  assert.equal(isSameHtmlPreviewDocument(longUrl, longUrl), true)
  assert.equal(isSameHtmlPreviewDocument(longUrl, 'file:///tmp/a.html'), false)
})
