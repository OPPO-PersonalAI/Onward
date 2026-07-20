/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 *
 * Patch-integrity lock for the node-pty posix sync-write change
 * (2026-07-20 incident: keystrokes ride CustomWriteStream, whose upstream
 * implementation flushes via callback `fs.write(fd)` on the libuv
 * threadpool — a stalled pool silently strands every keystroke while the
 * API keeps reporting success). Our patch replaces the flush with
 * `fs.writeSync` + EAGAIN requeue.
 *
 * The patched code lives inside node_modules (applied by pnpm from
 * patches/node-pty@1.1.0.patch), where its logic cannot be imported into
 * a plain-Node test without loading the native binding. This test locks
 * the two things that CAN silently regress:
 *   1. the installed lib actually carries the sync flush (a node-pty
 *      version bump that drops the patch fails loudly here, not at the
 *      next display-sleep incident);
 *   2. the patch file itself keeps both the Windows conpty hunks and the
 *      posix sync-write hunks.
 * Behaviour is locked end-to-end by the terminal autotest suites (every
 * terminal case types through the patched path) and `run-infra-watchdog`.
 *
 * Usage: node --experimental-strip-types --test test/unittest/node-pty-sync-write-patch.test.mts
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const installedLib = join(repoRoot, 'node_modules', 'node-pty', 'lib', 'unixTerminal.js')
const patchFile = join(repoRoot, 'patches', 'node-pty@1.1.0.patch')

test('NPS-U-01 installed node-pty lib flushes the pty write queue synchronously', () => {
  assert.ok(existsSync(installedLib), `missing ${installedLib} — run pnpm install`)
  const source = readFileSync(installedLib, 'utf-8')
  const processQueue = source.slice(source.indexOf('_processWriteQueue'))
  assert.match(processQueue, /fs\.writeSync\(this\._fd/, 'sync flush missing — patch not applied')
  assert.doesNotMatch(
    processQueue,
    /fs\.write\(this\._fd/,
    'threadpool-routed fs.write flush is back — the 2026-07-20 keystroke black hole would return'
  )
})

test('NPS-U-02 installed lib keeps the EAGAIN requeue semantics', () => {
  const source = readFileSync(installedLib, 'utf-8')
  const processQueue = source.slice(source.indexOf('_processWriteQueue'))
  assert.match(processQueue, /EAGAIN/, 'EAGAIN handling missing from sync flush')
  assert.match(processQueue, /setImmediate/, 'setImmediate requeue missing from sync flush')
})

test('NPS-U-03 patch file carries both the Windows conpty and the posix sync-write hunks', () => {
  const patch = readFileSync(patchFile, 'utf-8')
  assert.match(patch, /conpty_console_list_agent/, 'Windows conpty hunk lost from the patch')
  assert.match(patch, /writeSync/, 'posix sync-write hunk lost from the patch')
  assert.match(patch, /unixTerminal/, 'unixTerminal hunk missing from the patch')
})
