/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Pure screen-buffer-mode classifier for the PTY output stream.
 *
 * Motivation (BUG-0001, docs/bug-tracking/): a full-screen TUI (codex) held
 * the terminal for 14 hours and the diagnostic bundle could not answer the
 * single decisive question — "was the alternate screen active, and did the
 * app ever wipe the scrollback?" — because the main process only tracked
 * DECSET 2004 (bracketed paste). This module tracks the two VT state
 * families that decide whether output can ever reach the scrollback:
 *
 *  - alternate screen: DECSET/DECRST 1049 / 1047 / 47  → alt-enter / alt-exit
 *  - scrollback wipes: CSI 3 J (ED3) and ESC c (RIS)   → ed3 / ris
 *
 * Pure function over (state, chunk) so it is unit-testable in plain Node
 * (same pattern as `terminal-env.ts` / `persisted-terminal.ts`). The caller
 * (ipc-handlers pty onData) emits ONE trace event per transition entry —
 * transitions are state changes or per-chunk aggregated counts, never
 * per-byte, so the hot-path cost stays one regex scan per chunk (the same
 * cost class as the existing bracketed-paste tracker at the same site).
 */

export interface TerminalScreenModeState {
  /** True while the alternate screen buffer is active. */
  altScreen: boolean
  /**
   * Unmatched tail (< SEQ_CARRY_MAX chars) of the previous chunk, prepended
   * to the next scan so DECSET sequences split across PTY chunk boundaries
   * (e.g. "\x1b[?10" + "49h") are still recognised. The carry never
   * contains a completed match, so re-scanning it cannot double-emit.
   */
  carry: string
}

export type ScreenModeTransitionKind = 'alt-enter' | 'alt-exit' | 'ed3' | 'ris'

export interface ScreenModeTransition {
  kind: ScreenModeTransitionKind
  /** Occurrences aggregated within this chunk (ED3 repaint storms stay 1 event/chunk). */
  count: number
}

export interface ScreenModeScanResult {
  state: TerminalScreenModeState
  transitions: ScreenModeTransition[]
}

// Longest sequence we must bridge across a chunk boundary is "\x1b[?1049h"
// (8 chars); 15 leaves headroom without letting the carry grow.
const SEQ_CARRY_MAX = 15

// One combined alternation so matches are visited in stream order — the
// order matters because RIS resets the alt-screen flag while a later
// DECSET 1049h re-enters it.
//   group 1: DECSET/DECRST private mode number (1049 | 1047 | 47)
//   group 2: 'h' (set) | 'l' (reset)
//   group 3: ED3  — CSI 3 J erase-scrollback
//   group 4: RIS  — ESC c full reset (also leaves the alternate screen)
const SCREEN_MODE_RE = /\x1b\[\?(1049|1047|47)([hl])|(\x1b\[3J)|(\x1bc)/g

export function createScreenModeState(): TerminalScreenModeState {
  return { altScreen: false, carry: '' }
}

/**
 * Gate decision for the verified change-workdir transaction (G1 hardening,
 * 2026-07-24 review): while a full-screen TUI holds the ALTERNATE screen,
 * writing `cd …\r` into the PTY types the command INTO the TUI (e.g. a
 * running coding agent's composer) and presses Enter — the proof OSC never
 * arrives, and the side effect on the inner program is unguarded.
 *
 * Deliberately keyed on `altScreen` ONLY — NOT on bracketed paste: zsh /
 * fish / readline enable DECSET 2004 at every ordinary prompt, so gating on
 * it would block every legitimate manual cwd switch on POSIX shells. The
 * residual risk (a TUI repainting the NORMAL buffer in place, e.g. the
 * ConPTY-synthesized variant from BUG-0001) is accepted: the transaction's
 * verify-timeout still guarantees nothing is persisted.
 */
export function shouldBlockChangeWorkdirForTui(
  state: TerminalScreenModeState | undefined
): boolean {
  return state?.altScreen === true
}

export function scanScreenMode(
  state: TerminalScreenModeState,
  data: string
): ScreenModeScanResult {
  const text = state.carry + data
  let altScreen = state.altScreen
  let altEnter = 0
  let altExit = 0
  let ed3 = 0
  let ris = 0
  let lastMatchEnd = 0

  SCREEN_MODE_RE.lastIndex = 0
  for (let m = SCREEN_MODE_RE.exec(text); m !== null; m = SCREEN_MODE_RE.exec(text)) {
    lastMatchEnd = m.index + m[0].length
    if (m[1] !== undefined) {
      const set = m[2] === 'h'
      if (set && !altScreen) {
        altScreen = true
        altEnter += 1
      } else if (!set && altScreen) {
        altScreen = false
        altExit += 1
      }
    } else if (m[3] !== undefined) {
      ed3 += 1
    } else if (m[4] !== undefined) {
      ris += 1
      // RIS resets the terminal to the normal buffer; count the implicit
      // exit as part of the 'ris' transition rather than a separate one.
      altScreen = false
    }
  }

  // Carry only the unmatched tail so a completed match is never re-scanned.
  const tailStart = Math.max(text.length - SEQ_CARRY_MAX, lastMatchEnd)
  const carry = text.slice(tailStart)

  const transitions: ScreenModeTransition[] = []
  if (altEnter > 0) transitions.push({ kind: 'alt-enter', count: altEnter })
  if (altExit > 0) transitions.push({ kind: 'alt-exit', count: altExit })
  if (ed3 > 0) transitions.push({ kind: 'ed3', count: ed3 })
  if (ris > 0) transitions.push({ kind: 'ris', count: ris })

  return { state: { altScreen, carry }, transitions }
}
