/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { canonicalizeTerminalCwdForPersist } from '../../src/utils/terminal-cwd-osc.ts'

// `canonicalizeTerminalCwdForPersist` IS the production canonicalizer that
// AppStateContext.normalizePersistedTerminalCwd calls (no mirror — same code).
// It locks the convergence invariant behind the idle-CPU fix: without it the
// OSC writer and the git-watcher writer disagree on the persisted cwd string
// and ping-pong terminal.lastCwd forever, re-rendering the whole tree.
const win = (v: string | null | undefined) => canonicalizeTerminalCwdForPersist(v, 'win32')
const mac = (v: string | null | undefined) => canonicalizeTerminalCwdForPersist(v, 'darwin')
const linux = (v: string | null | undefined) => canonicalizeTerminalCwdForPersist(v, 'linux')

test('Windows: forward-slash and backslash forms converge to ONE string', () => {
  // The exact pair the original production trace showed ping-ponging.
  assert.equal(win('D:/Users/Documents/Onward'), 'D:/Users/Documents/Onward')
  assert.equal(win('D:\\Users\\Documents\\Onward'), 'D:/Users/Documents/Onward')
  assert.equal(win('D:/Users/Documents/Onward'), win('D:\\Users\\Documents\\Onward'))
  assert.equal(win('E:/RTOS-stablity/x'), win('E:\\RTOS-stablity\\x'))
})

test('Windows: a UNC leading "//" is preserved (not collapsed to "/")', () => {
  assert.equal(win('\\\\server\\share\\proj'), '//server/share/proj')
  assert.equal(win('//server/share/proj'), '//server/share/proj')
})

test('Windows: a drive root keeps its trailing slash', () => {
  assert.equal(win('C:/'), 'C:/')
  assert.equal(win('C:\\'), 'C:/')
})

test('macOS: /private firmlink and user-facing form converge to ONE string', () => {
  // The exact macOS divergence: OSC 7 reports the user-facing path, the git
  // watcher the realpath. Both are the SAME directory (synthetic firmlink).
  assert.equal(mac('/private/var/folders/31/T/proj'), '/var/folders/31/T/proj')
  assert.equal(mac('/var/folders/31/T/proj'), '/var/folders/31/T/proj')
  assert.equal(mac('/private/var/folders/31/T/proj'), mac('/var/folders/31/T/proj'))
  assert.equal(mac('/private/tmp/x'), '/tmp/x')
  assert.equal(mac('/private/etc/y'), '/etc/y')
  // Bare firmlink roots (no trailing segment) also reconcile.
  assert.equal(mac('/private/var'), '/var')
})

test('macOS: a stray double slash from a $TMPDIR ending in "/" is collapsed', () => {
  // mktemp -d "$TMPDIR/child" with $TMPDIR='/var/folders/.../T/' yields '…/T//child'.
  assert.equal(mac('/var/folders/31/T//onward-fixture'), '/var/folders/31/T/onward-fixture')
  assert.equal(
    mac('/var/folders/31/T//onward-fixture'),
    mac('/private/var/folders/31/T/onward-fixture')
  )
})

test('macOS: does NOT strip /private from a real non-firmlink directory', () => {
  // `/private/variant` must stay intact — only var/tmp/etc are firmlinks.
  assert.equal(mac('/private/variant/x'), '/private/variant/x')
  assert.equal(mac('/private/data/x'), '/private/data/x')
})

test('Linux: the macOS firmlink rule does NOT apply', () => {
  // On Linux a real /private/var directory must be preserved verbatim.
  assert.equal(linux('/private/var/x'), '/private/var/x')
  assert.equal(linux('/var/x'), '/var/x')
})

test('canonicalization is idempotent (no second-pass drift), all platforms', () => {
  const cases: Array<[(v: string | null | undefined) => string | null, string]> = [
    [win, 'D:\\Users\\80253146'], [win, 'D:/Users/80253146'], [win, '\\\\srv\\sh\\c'],
    [mac, '/private/var/folders/31/T//proj'], [mac, '/var/folders/31/T/proj/'],
    [mac, '~/projects/repo'], [linux, '/private/var/x'],
    // '.'-segment inputs must also be idempotent (collapse once, then stable).
    [win, 'D:\\x\\repo\\.'], [mac, '/Users/x/./repo/.'], [win, 'C:\\.']
  ]
  for (const [fn, input] of cases) {
    const once = fn(input)
    const twice = fn(once)
    assert.equal(twice, once, `not idempotent for ${input}`)
    assert.ok(once === null || !once.includes('\\'), `still contains a backslash: ${once}`)
  }
})

test('trailing slash is stripped (but root "/" is kept)', () => {
  assert.equal(mac('/Users/x/repo/'), '/Users/x/repo')
  assert.equal(mac('/'), '/')
  assert.equal(mac('~/Projects/repo/'), '~/Projects/repo')
})

test('a trailing "/." (current-dir alias) collapses and converges with the bare path', () => {
  // Regression: the GSM two-task test feeds terminal B `makeEquivalentCwdAlias`
  // = `path.join(repo, '.')` -> `<repo>/.`, while the other writer emits
  // `<repo>`. canonicalize MUST collapse `/.`, or terminal.lastCwd ping-pongs
  // and storms the renderer (setTerminalLastCwd hit 1707/s, renders 569/s in
  // the failing run). This is the exact gap that shipped the storm.
  assert.equal(win('D:/x/repo/.'), 'D:/x/repo')
  assert.equal(win('D:/x/repo/.'), win('D:/x/repo'))
  // The exact divergence: backslash-with-dot vs forward-slash bare.
  assert.equal(win('D:\\x\\repo\\.'), 'D:/x/repo')
  assert.equal(win('D:\\x\\repo\\.'), win('D:/x/repo'))
  assert.equal(mac('/Users/x/repo/.'), '/Users/x/repo')
  assert.equal(mac('/Users/x/repo/.'), mac('/Users/x/repo'))
  assert.equal(linux('/home/x/repo/.'), '/home/x/repo')
})

test('interior "/./" segments collapse (and combine with a trailing "/.")', () => {
  assert.equal(win('D:/x/./repo'), 'D:/x/repo')
  assert.equal(mac('/Users/x/./repo'), '/Users/x/repo')
  assert.equal(win('D:/x/./repo/.'), 'D:/x/repo')
})

test('a "/." at a root keeps the root', () => {
  assert.equal(win('C:/.'), 'C:/')
  assert.equal(win('C:\\.'), 'C:/')
  assert.equal(mac('/.'), '/')
})

test('POSIX paths and home-relative paths stay intact', () => {
  assert.equal(mac('/Users/example/repo'), '/Users/example/repo')
  assert.equal(mac('~/Projects/repo'), '~/Projects/repo')
  assert.equal(mac('~'), '~')
})

test('invalid candidates are rejected (unchanged validation contract)', () => {
  assert.equal(mac('relative/path'), null)
  assert.equal(mac('Claude is waiting for your input'), null)
  assert.equal(mac(null), null)
  assert.equal(mac(undefined), null)
})
