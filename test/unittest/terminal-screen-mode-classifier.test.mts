/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 *
 * Unit tests for the pure screen-buffer-mode classifier behind the
 * `main:terminal.screen-mode-changed` diagnostic event (BUG-0001,
 * docs/bug-tracking/BUG-0001-codex-tui-scrollback-invisible.md). Locks the
 * transition table: alt-screen enter/exit via DECSET/DECRST 1049/1047/47,
 * scrollback wipes via ED3 / RIS, per-chunk aggregation, and the
 * chunk-boundary carry that must never double-emit.
 *
 * Usage: node --experimental-strip-types --test test/unittest/terminal-screen-mode-classifier.test.mts
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  createScreenModeState,
  scanScreenMode,
  shouldBlockChangeWorkdirForTui
} from '../../electron/main/terminal-screen-mode.ts'

test('TSM-U-01 DECSET 1049 enters the alternate screen exactly once', () => {
  const r = scanScreenMode(createScreenModeState(), 'before\x1b[?1049hafter')
  assert.equal(r.state.altScreen, true)
  assert.deepEqual(r.transitions, [{ kind: 'alt-enter', count: 1 }])
})

test('TSM-U-02 DECRST 1049 exits the alternate screen', () => {
  const enter = scanScreenMode(createScreenModeState(), '\x1b[?1049h')
  const exit = scanScreenMode(enter.state, 'tui frame\x1b[?1049l$ ')
  assert.equal(exit.state.altScreen, false)
  assert.deepEqual(exit.transitions, [{ kind: 'alt-exit', count: 1 }])
})

test('TSM-U-03 legacy variants 47 and 1047 drive the same state', () => {
  const a = scanScreenMode(createScreenModeState(), '\x1b[?47h')
  assert.equal(a.state.altScreen, true)
  assert.deepEqual(a.transitions, [{ kind: 'alt-enter', count: 1 }])

  const b = scanScreenMode(a.state, '\x1b[?1047l')
  assert.equal(b.state.altScreen, false)
  assert.deepEqual(b.transitions, [{ kind: 'alt-exit', count: 1 }])
})

test('TSM-U-04 re-entering an already-active alt screen is not a transition', () => {
  const enter = scanScreenMode(createScreenModeState(), '\x1b[?1049h')
  const again = scanScreenMode(enter.state, '\x1b[?1049h\x1b[?47h')
  assert.equal(again.state.altScreen, true)
  assert.deepEqual(again.transitions, [])
})

test('TSM-U-05 ED3 occurrences aggregate to one transition per chunk', () => {
  const r = scanScreenMode(createScreenModeState(), '\x1b[3J\x1b[2J\x1b[3J\x1b[3J')
  assert.equal(r.state.altScreen, false)
  assert.deepEqual(r.transitions, [{ kind: 'ed3', count: 3 }])
})

test('TSM-U-06 RIS resets the alt-screen flag and reports ris only', () => {
  const enter = scanScreenMode(createScreenModeState(), '\x1b[?1049h')
  const reset = scanScreenMode(enter.state, '\x1bc')
  assert.equal(reset.state.altScreen, false)
  assert.deepEqual(reset.transitions, [{ kind: 'ris', count: 1 }])
})

test('TSM-U-07 in-stream ordering wins: RIS then 1049h ends alt-active', () => {
  const enter = scanScreenMode(createScreenModeState(), '\x1b[?1049h')
  const r = scanScreenMode(enter.state, '\x1bc\x1b[?1049h')
  assert.equal(r.state.altScreen, true)
  assert.deepEqual(r.transitions, [
    { kind: 'alt-enter', count: 1 },
    { kind: 'ris', count: 1 }
  ])
})

test('TSM-U-08 a DECSET split across two chunks is bridged by the carry', () => {
  const first = scanScreenMode(createScreenModeState(), 'output\x1b[?10')
  assert.equal(first.state.altScreen, false)
  assert.deepEqual(first.transitions, [])

  const second = scanScreenMode(first.state, '49hmore output')
  assert.equal(second.state.altScreen, true)
  assert.deepEqual(second.transitions, [{ kind: 'alt-enter', count: 1 }])
})

test('TSM-U-09 the carry never re-scans a completed match (no double ED3)', () => {
  // Chunk ends exactly with a full ED3 — shorter than the carry window, so a
  // naive tail-carry would rescan and double-count it on the next chunk.
  const first = scanScreenMode(createScreenModeState(), '\x1b[3J')
  assert.deepEqual(first.transitions, [{ kind: 'ed3', count: 1 }])

  const second = scanScreenMode(first.state, 'plain output')
  assert.deepEqual(second.transitions, [])
})

test('TSM-U-10 plain TUI repaint output produces no transitions', () => {
  const frame = '\x1b[H\x1b[2J\x1b[1;1Hcodex \x1b[38;5;208mworking\x1b[0m\r\n'.repeat(50)
  const r = scanScreenMode(createScreenModeState(), frame)
  assert.equal(r.state.altScreen, false)
  assert.deepEqual(r.transitions, [])
})

test('TSM-U-11 carry stays bounded on pathological ESC-free streams', () => {
  const r = scanScreenMode(createScreenModeState(), 'x'.repeat(100_000))
  assert.ok(r.state.carry.length <= 15)
})

test('TSM-U-13 change-workdir gate blocks ONLY while the alt screen is active', () => {
  // Normal buffer → allowed (including the fresh-state and unknown cases).
  assert.equal(shouldBlockChangeWorkdirForTui(undefined), false)
  assert.equal(shouldBlockChangeWorkdirForTui(createScreenModeState()), false)

  // TUI entered the alternate screen → blocked.
  const alt = scanScreenMode(createScreenModeState(), '\x1b[?1049h').state
  assert.equal(shouldBlockChangeWorkdirForTui(alt), true)

  // TUI exited → allowed again.
  const back = scanScreenMode(alt, '\x1b[?1049l').state
  assert.equal(shouldBlockChangeWorkdirForTui(back), false)
})

test('TSM-U-14 gate ignores bracketed-paste-style prompts (normal buffer stays allowed)', () => {
  // zsh/fish enable DECSET 2004 at every ordinary prompt; the classifier
  // does not track 2004 and the gate must not block a plain prompt stream.
  const state = scanScreenMode(createScreenModeState(), '\x1b[?2004h$ ').state
  assert.equal(state.altScreen, false)
  assert.equal(shouldBlockChangeWorkdirForTui(state), false)
})

test('TSM-U-12 full life cycle: enter, wipe attempts inside alt, exit', () => {
  let state = createScreenModeState()
  const log: string[] = []
  for (const chunk of ['\x1b[?1049h\x1b[2J', 'frame\x1b[3Jframe', '\x1b[?1049l\x1b[3J']) {
    const r = scanScreenMode(state, chunk)
    state = r.state
    for (const t of r.transitions) log.push(`${t.kind}:${t.count}`)
  }
  assert.deepEqual(log, ['alt-enter:1', 'ed3:1', 'alt-exit:1', 'ed3:1'])
  assert.equal(state.altScreen, false)
})
