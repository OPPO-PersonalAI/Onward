/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 *
 * Usage: node --experimental-strip-types --test test/unittest/quit-activity.test.mts
 *
 * Locks the pure activity-classification decision table behind the
 * activity-aware quit confirmation (electron/main/quit-activity.ts):
 * descendant enumeration + ignore-list (the iTerm2/VS Code/WezTerm-style
 * criterion), idle-shell zero-false-positive, multi-level descendants,
 * cycle guarding, and the dialog summary shaping.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  DEFAULT_IGNORED_JOB_NAMES,
  buildChildrenIndex,
  classifyTerminalActivity,
  collectDescendantJobs,
  normalizeJobName,
  summarizeQuitActivity,
  type ProcessTableRow
} from '../../electron/main/quit-activity.ts'

const row = (pid: number, ppid: number, name: string): ProcessTableRow => ({ pid, ppid, name })

test('QAC-U-01: idle shell (no descendants) is never active', () => {
  const table = [row(100, 1, 'zsh')]
  const [a] = classifyTerminalActivity([{ terminalId: 't1', shellPid: 100 }], table)
  assert.equal(a.active, false)
  assert.deepEqual(a.jobs, [])
})

test('QAC-U-02: shell with only ignored helpers (login/starship/self-fork) stays idle', () => {
  const table = [
    row(100, 1, '-zsh'),
    row(101, 100, 'starship'),
    row(102, 100, '/usr/bin/login'),
    row(103, 100, 'zsh')
  ]
  const [a] = classifyTerminalActivity([{ terminalId: 't1', shellPid: 100 }], table)
  assert.equal(a.active, false)
})

test('QAC-U-03: a real job (codex) marks the terminal active and is named', () => {
  const table = [row(100, 1, 'zsh'), row(200, 100, 'codex')]
  const [a] = classifyTerminalActivity([{ terminalId: 't1', shellPid: 100 }], table)
  assert.equal(a.active, true)
  assert.deepEqual(a.jobs, ['codex'])
})

test('QAC-U-04: multi-level descendants are found (zsh -> npm -> node)', () => {
  const table = [row(100, 1, 'zsh'), row(200, 100, 'npm'), row(300, 200, 'node')]
  const index = buildChildrenIndex(table)
  assert.deepEqual(collectDescendantJobs(index, 100), ['npm', 'node'])
})

test('QAC-U-05: backgrounded job still counts (no foreground-group blindness)', () => {
  // A `sleep 999 &` child: not in the foreground group, but a descendant.
  const table = [row(100, 1, 'zsh'), row(200, 100, 'sleep')]
  const [a] = classifyTerminalActivity([{ terminalId: 't1', shellPid: 100 }], table)
  assert.equal(a.active, true)
})

test('QAC-U-06: name normalization strips path, login dash, .exe, case', () => {
  assert.equal(normalizeJobName('/usr/local/bin/Codex'), 'codex')
  assert.equal(normalizeJobName('-zsh'), 'zsh')
  assert.equal(normalizeJobName('C:\\Windows\\System32\\conhost.exe'), 'conhost')
  assert.equal(normalizeJobName('PWSH.EXE'), 'pwsh')
})

test('QAC-U-07: cycle in a torn process-table snapshot terminates', () => {
  const table = [row(100, 1, 'zsh'), row(200, 100, 'vim'), row(100, 200, 'zsh')]
  const index = buildChildrenIndex(table)
  assert.deepEqual(collectDescendantJobs(index, 100), ['vim'])
})

test('QAC-U-08: summary counts, dedupes and caps names; labels fall back to ids', () => {
  const table: ProcessTableRow[] = [
    row(100, 1, 'zsh'),
    row(110, 100, 'codex'),
    row(200, 1, 'zsh'),
    row(210, 200, 'codex'),
    row(220, 200, 'vim'),
    row(300, 1, 'zsh'),
    row(400, 1, 'zsh'),
    row(410, 400, 'make')
  ]
  const activities = classifyTerminalActivity(
    [
      { terminalId: 't1', shellPid: 100, label: 'api-server' },
      { terminalId: 't2', shellPid: 200, label: '  ' },
      { terminalId: 't3', shellPid: 300 },
      { terminalId: 't4', shellPid: 400, label: 'build' }
    ],
    table
  )
  const s = summarizeQuitActivity(activities, 2)
  assert.equal(s.terminalCount, 4)
  assert.equal(s.activeCount, 3)
  assert.deepEqual(s.jobNames, ['codex', 'vim'])
  assert.deepEqual(s.activeTerminalLabels, ['api-server', 't2'])
})

test('QAC-U-10: ps output parser handles padding and command paths with spaces', async () => {
  const { parsePsTable } = await import('../../electron/main/process-table.ts')
  const out = '  100     1 /bin/zsh\n  200   100 /Applications/My App/Contents/MacOS/codex cli\n bad line\n'
  assert.deepEqual(parsePsTable(out), [
    { pid: 100, ppid: 1, name: '/bin/zsh' },
    { pid: 200, ppid: 100, name: '/Applications/My App/Contents/MacOS/codex cli' }
  ])
})

test('QAC-U-11: PowerShell CIM CSV parser handles quoted rows and CRLF', async () => {
  const { parseCimCsv } = await import('../../electron/main/process-table.ts')
  const out = '"4","0","System"\r\n"1234","4","conhost.exe"\r\nnot,a,row-x\r\n'
  assert.deepEqual(parseCimCsv(out), [
    { pid: 4, ppid: 0, name: 'System' },
    { pid: 1234, ppid: 4, name: 'conhost.exe' }
  ])
})

test('QAC-U-09: default ignore list covers shells and prompt decorators', () => {
  for (const name of ['bash', 'zsh', 'fish', 'starship', 'oh-my-posh', 'pwsh', 'conhost']) {
    assert.ok(DEFAULT_IGNORED_JOB_NAMES.has(name), `${name} should be ignored`)
  }
  assert.ok(!DEFAULT_IGNORED_JOB_NAMES.has('codex'))
  assert.ok(!DEFAULT_IGNORED_JOB_NAMES.has('tmux'))
})
