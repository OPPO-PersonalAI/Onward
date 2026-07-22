/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 *
 * Usage: node --experimental-strip-types --test test/unittest/terminal-command-verified-cd.test.mts
 *
 * Locks the verified change-directory command builder (RC-3 fix). The
 * command must carry its own directory-proof emitter so the main-process
 * transaction can confirm the switch from the shell's OWN report — and the
 * proof must stay honest on failure (PowerShell emits the OLD cwd after a
 * failed Set-Location; POSIX `&&` emits nothing).
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { buildVerifiedChangeDirectoryCommand, buildChangeDirectoryCommand } from '../../src/utils/terminal-command.ts'

test('win32 powershell: Set-Location + inline OSC 633 proof emitter', () => {
  const cmd = buildVerifiedChangeDirectoryCommand('win32', 'D:\\work\\repo', 'powershell')
  assert.ok(cmd.startsWith("Set-Location -LiteralPath 'D:\\work\\repo'"), cmd)
  assert.ok(cmd.includes("']633;P;Cwd='"), 'proof emitter missing')
  assert.ok(cmd.includes('Convert-Path -LiteralPath .'), 'CLM-safe cwd read missing')
  assert.ok(cmd.endsWith('\r'))
  // Statement separator `;` (not &&): the emitter must run EVEN IF the cd
  // fails, so a failed switch reports the old cwd → an honest mismatch.
  assert.ok(cmd.includes('; Write-Host -NoNewline'))
})

test('win32 powershell: single quotes in the path are doubled', () => {
  const cmd = buildVerifiedChangeDirectoryCommand('win32', "D:\\it's here", 'powershell')
  assert.ok(cmd.includes("'D:\\it''s here'"), cmd)
})

test('win32 cmd: plain cd /d (proof rides the PROMPT OSC 9;9 env integration)', () => {
  const cmd = buildVerifiedChangeDirectoryCommand('win32', 'D:\\work\\repo', 'cmd')
  assert.equal(cmd, 'cd /d "D:\\work\\repo"\r')
})

test('posix: cd && printf OSC 633 proof — a failed cd emits nothing', () => {
  const cmd = buildVerifiedChangeDirectoryCommand('darwin', '/Users/dev/repo', 'posix')
  assert.ok(cmd.startsWith("cd '/Users/dev/repo' && printf"), cmd)
  assert.ok(cmd.includes('\\033]633;P;Cwd=%s\\007'), 'OSC 633 printf template missing')
  assert.ok(cmd.includes('"$PWD"'))
  assert.ok(cmd.endsWith('\r'))
})

test('posix: single quotes in the path use the standard close-escape-reopen form', () => {
  const cmd = buildVerifiedChangeDirectoryCommand('linux', "/tmp/it's", 'posix')
  assert.ok(cmd.includes("'/tmp/it'\\''s'"), cmd)
})

test('legacy builder is unchanged (other call sites keep their behaviour)', () => {
  assert.equal(buildChangeDirectoryCommand('win32', 'D:\\x', 'cmd'), 'cd /d "D:\\x"\r')
  assert.equal(buildChangeDirectoryCommand('win32', 'D:\\x', 'powershell'), "Set-Location -LiteralPath 'D:\\x'\r")
  assert.equal(buildChangeDirectoryCommand('linux', '/x', 'posix'), "cd '/x'\r")
})
