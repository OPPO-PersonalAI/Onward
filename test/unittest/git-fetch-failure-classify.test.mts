/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 *
 * Usage: node --experimental-strip-types --test test/unittest/git-fetch-failure-classify.test.mts
 *
 * Locks the pure classification + redaction tables used to make a background
 * `git fetch` failure diagnosable from a user-attached trace (BUG-0005 R4).
 *
 * Context: a fetch killed by the 20 s ceiling used to report `reason: 'timeout'`
 * and nothing else — stderr was captured and immediately discarded. In the field
 * bundle, 6 of 9 failures were `timeout` with zero further evidence, so "auth
 * wall", "unreachable remote" and "genuinely slow transport" were
 * indistinguishable. These tables turn that stderr into something both useful
 * and safe to ship in a diagnostic bundle.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  classifyFetchFailure,
  classifyRemoteScheme,
  sanitizeGitStderr,
  STDERR_TAIL_MAX
} from '../../electron/main/git-fetch-failure-classify.ts'

// ---------------------------------------------------------------------------
// classifyFetchFailure — the table that now also runs on the timeout path
// ---------------------------------------------------------------------------

test('classify: SSH key rejection → auth', () => {
  assert.equal(classifyFetchFailure('git@github.com: Permission denied (publickey).'), 'auth')
  assert.equal(classifyFetchFailure('fatal: Authentication failed for https://example/x.git'), 'auth')
  assert.equal(
    classifyFetchFailure('could not read Username for https://example: terminal prompts disabled'),
    'auth'
  )
})

test('classify: unreachable host / transport → network', () => {
  assert.equal(classifyFetchFailure('ssh: Could not resolve hostname git.internal'), 'network')
  assert.equal(classifyFetchFailure('ssh: connect to host git.internal port 22: Connection timed out'), 'network')
  assert.equal(classifyFetchFailure('fatal: unable to access https://example/: Failed to connect'), 'network')
})

test('classify: missing remote → no-remote', () => {
  assert.equal(classifyFetchFailure("fatal: 'origin' does not appear to be a git repository"), 'no-remote')
  assert.equal(classifyFetchFailure('fatal: No such remote: origin'), 'no-remote')
})

test('classify: unrecognised text → other, never throws', () => {
  assert.equal(classifyFetchFailure(''), 'other')
  assert.equal(classifyFetchFailure('something entirely new'), 'other')
})

test('classify: case-insensitive (git casing varies by version/locale)', () => {
  assert.equal(classifyFetchFailure('PERMISSION DENIED (PUBLICKEY)'), 'auth')
  assert.equal(classifyFetchFailure('Connection Timed Out'), 'network')
})

// ---------------------------------------------------------------------------
// sanitizeGitStderr — must stay useful while never leaking a credential
// ---------------------------------------------------------------------------

test('redact: strips URL userinfo but keeps scheme + host', () => {
  const out = sanitizeGitStderr('fatal: unable to access https://alice:ghp_secret@github.com/o/r.git/')
  assert.ok(!out.includes('alice'), 'username must not survive')
  assert.ok(!out.includes('ghp_secret'), 'token must not survive')
  assert.ok(out.includes('[redacted]@'), 'the redaction marker is kept so the shape is legible')
  assert.ok(out.includes('https://'), 'scheme is the diagnostic value — keep it')
  assert.ok(out.includes('github.com'), 'host distinguishes public vs internal — keep it')
})

test('redact: collapses long token-shaped runs', () => {
  const token = 'A'.repeat(40)
  const out = sanitizeGitStderr(`remote: rejected token ${token} end`)
  assert.ok(!out.includes(token))
  assert.ok(out.includes('[redacted]'))
  assert.ok(out.includes('end'), 'surrounding text survives')
})

test('redact: short identifiers are NOT collapsed (keeps messages readable)', () => {
  const out = sanitizeGitStderr('fatal: refusing to merge unrelated histories on main')
  assert.equal(out, 'fatal: refusing to merge unrelated histories on main')
})

test('redact: normalises whitespace and keeps the TAIL when over budget', () => {
  // Ordinary words, each under the token-collapse threshold, so this exercises
  // the length budget rather than the token rule.
  const long = `${'remote: counting objects '.repeat(30)} THE-IMPORTANT-ENDING`
  const out = sanitizeGitStderr(long)
  assert.ok(out.length <= STDERR_TAIL_MAX + 1, 'budget respected (+1 for the ellipsis)')
  assert.ok(out.startsWith('…'), 'truncation is marked')
  assert.ok(
    out.endsWith('THE-IMPORTANT-ENDING'),
    'git prints the actionable line LAST, so the tail is what must survive'
  )
})

test('redact: multi-line stderr collapses to one line', () => {
  const out = sanitizeGitStderr('line one\n  line two\n\nline three')
  assert.equal(out, 'line one line two line three')
})

test('redact: empty / whitespace input yields an empty string, never throws', () => {
  assert.equal(sanitizeGitStderr(''), '')
  assert.equal(sanitizeGitStderr('   \n  '), '')
})

// ---------------------------------------------------------------------------
// classifyRemoteScheme — records the transport CLASS only, never the URL
// ---------------------------------------------------------------------------

test('remote scheme: explicit schemes', () => {
  assert.equal(classifyRemoteScheme('https://github.com/o/r.git'), 'https')
  assert.equal(classifyRemoteScheme('http://internal/o/r.git'), 'http')
  assert.equal(classifyRemoteScheme('ssh://git@github.com/o/r.git'), 'ssh')
  assert.equal(classifyRemoteScheme('git://example/o/r.git'), 'git')
  assert.equal(classifyRemoteScheme('file:///srv/mirror/r.git'), 'file')
})

test('remote scheme: scp-like syntax is SSH despite looking path-shaped', () => {
  // This is the case worth a dedicated test: `git@host:path` has no scheme and
  // contains a colon, so a naive parser reads it as a Windows drive or a port.
  assert.equal(classifyRemoteScheme('git@github.com:owner/repo.git'), 'scp-like')
  assert.equal(classifyRemoteScheme('deploy@10.0.0.5:/srv/r.git'), 'scp-like')
})

test('remote scheme: local paths on both platform conventions', () => {
  assert.equal(classifyRemoteScheme('/srv/mirrors/repo.git'), 'file')
  assert.equal(classifyRemoteScheme('C:\\mirrors\\repo.git'), 'file')
  assert.equal(classifyRemoteScheme('D:/mirrors/repo.git'), 'file')
})

test('remote scheme: absent / blank → none (a repo with no origin at all)', () => {
  assert.equal(classifyRemoteScheme(null), 'none')
  assert.equal(classifyRemoteScheme(undefined), 'none')
  assert.equal(classifyRemoteScheme(''), 'none')
  assert.equal(classifyRemoteScheme('   \n'), 'none')
})

test('remote scheme: trailing newline from `git config` output is tolerated', () => {
  // resolveRemoteScheme feeds raw stdout straight in.
  assert.equal(classifyRemoteScheme('git@github.com:owner/repo.git\n'), 'scp-like')
  assert.equal(classifyRemoteScheme('https://github.com/o/r.git\n'), 'https')
})

test('remote scheme: an unrecognised scheme degrades to other, never throws', () => {
  assert.equal(classifyRemoteScheme('weird+transport://host/x'), 'other')
  assert.equal(classifyRemoteScheme('not a url at all'), 'other')
})

test('remote scheme: no field of the result can carry the URL itself', () => {
  // A guard against a future "just include the URL, it is more useful" change:
  // the return type is a fixed union, so this test fails loudly if it widens.
  const allowed = new Set(['ssh', 'scp-like', 'https', 'http', 'file', 'git', 'none', 'other'])
  for (const url of [
    'https://alice:token@github.com/o/r.git',
    'git@internal.corp:team/secret.git',
    '/Users/someone/private/repo'
  ]) {
    assert.ok(allowed.has(classifyRemoteScheme(url)), `${url} → a class, not the URL`)
  }
})
