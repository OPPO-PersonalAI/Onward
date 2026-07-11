/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 *
 * Usage: node --experimental-strip-types --test test/unittest/ipc-handler-symmetry.test.mts
 *
 * Static lock for audit finding lifecycle-01: every ipcMain.handle(...)
 * registered by electron/main/ipc-handlers.ts must have a matching
 * ipcMain.removeHandler(...) in the same file. A missing removal makes the
 * macOS window-all-closed -> cleanup -> Dock-reopen -> re-register cycle
 * throw "Attempted to register a second handler for '<channel>'".
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const source = readFileSync(
  join(here, '..', '..', 'electron', 'main', 'ipc-handlers.ts'),
  'utf8'
  // Collapse multi-line registrations (ipcMain.handle(\n  IPC.X, ...) so the
  // channel token always follows the call on one line.
).replace(/ipcMain\.handle\(\s*\n\s*/g, 'ipcMain.handle(')

function channelSet(pattern: RegExp): Set<string> {
  const found = new Set<string>()
  let match: RegExpExecArray | null
  while ((match = pattern.exec(source)) !== null) {
    found.add(match[1])
  }
  return found
}

const handles = channelSet(/ipcMain\.handle\((IPC\.[A-Z_0-9]+|'[^']+')/g)
const removals = channelSet(/ipcMain\.removeHandler\((IPC\.[A-Z_0-9]+|'[^']+')/g)

test('ipc-handlers.ts parses a plausible number of registrations', () => {
  // Guard against the regexes silently matching nothing after a refactor.
  assert.ok(handles.size > 100, `expected >100 ipcMain.handle registrations, parsed ${handles.size}`)
  assert.ok(removals.size > 100, `expected >100 removeHandler calls, parsed ${removals.size}`)
})

test('every ipcMain.handle channel has a paired removeHandler (audit lifecycle-01)', () => {
  const missing = [...handles].filter((channel) => !removals.has(channel)).sort()
  assert.deepEqual(
    missing,
    [],
    `channels registered without a removeHandler in cleanup: ${missing.join(', ')}`
  )
})
