/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 *
 * Usage: node --experimental-strip-types --test test/unittest/powershell-inline-integration.test.mts
 *
 * Locks the structural invariants of the inline PowerShell integration
 * payload (RC-1 fix). The dot-sourced pwsh.ps1 was blocked by script
 * execution policy on locked-down machines (2026-07-17 bundles); the fix
 * passes the whole prompt wrapper as a `-Command` string, which no
 * file-execution gate applies to. These tests pin the payload properties
 * that make the CreateProcess → powershell.exe CLI round-trip unambiguous
 * and keep parity with resources/shell-integration/pwsh.ps1.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  buildPowerShellInlineIntegrationCommand,
  PS_INLINE_OSC_633_CWD_PREFIX,
  PS_INLINE_OSC_7_PREFIX,
  PS_INLINE_OSC_633_COMMAND_PREFIX
} from '../../electron/main/powershell-inline-integration.ts'

const payload = buildPowerShellInlineIntegrationCommand()

test('payload contains NO double quotes (argv quoting invariant)', () => {
  assert.equal(payload.includes('"'), false)
})

test('payload is a single line (no embedded newlines)', () => {
  assert.equal(/\r|\n/.test(payload), false)
})

test('payload emits all three OSC dialect prefixes (parity with pwsh.ps1)', () => {
  assert.ok(payload.includes(PS_INLINE_OSC_633_CWD_PREFIX), 'OSC 633;P;Cwd= missing')
  assert.ok(payload.includes(PS_INLINE_OSC_7_PREFIX), 'OSC 7 file:// missing')
  assert.ok(payload.includes(PS_INLINE_OSC_633_COMMAND_PREFIX), 'OSC 633;E; (git command re-emit) missing')
})

test('payload captures and chains the user original prompt', () => {
  assert.ok(payload.includes('$Global:__OnwardOriginalPrompt = $function:Prompt'))
  assert.ok(payload.includes('& $Global:__OnwardOriginalPrompt'))
})

test('payload defines a global Prompt function exactly once', () => {
  const occurrences = payload.split('function global:Prompt').length - 1
  assert.equal(occurrences, 1)
})

test('cwd resolution prefers the CLM-safe Convert-Path cmdlet', () => {
  assert.ok(payload.includes('Convert-Path -LiteralPath .'))
  // The $PWD.Path property fallback must be inside its own try/catch —
  // property reads can be denied under Constrained Language Mode.
  assert.ok(payload.includes('catch { try { $p = $PWD.Path } catch { $p = $null } }'))
})

test('git-command re-emit branch is fully try/catch-wrapped (CLM degradation)', () => {
  // Get-History property reads may be CLM-denied; a throw there must never
  // break the user prompt.
  assert.ok(/try \{ \$hi = Get-History[\s\S]*\} catch \{ \}/.test(payload))
})

test('payload keeps the 2048-char command-line cap (privacy budget parity)', () => {
  assert.ok(payload.includes('$s.Length -gt 2048'))
})

test('payload stays comfortably under the Windows command-line limit', () => {
  // CreateProcess caps the full command line at 32767 chars; leave a wide
  // margin for the shell path + fixed flags the caller prepends.
  assert.ok(payload.length < 4000, `payload unexpectedly long: ${payload.length}`)
})
