/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

export type TerminalCwdOscDialect = 'osc7' | 'osc633' | 'osc1337' | 'osc9'

const MAX_TERMINAL_CWD_LENGTH = 4096
const CONTROL_CHARACTER_RE = /[\u0000-\u001f\u007f]/
const WINDOWS_DRIVE_ABSOLUTE_RE = /^[A-Za-z]:[\\/]/
const WINDOWS_UNC_RE = /^\\\\[^\\]+\\[^\\]+/

export function normalizeTerminalCwdCandidate(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (!trimmed || trimmed.length > MAX_TERMINAL_CWD_LENGTH) return null
  if (CONTROL_CHARACTER_RE.test(trimmed)) return null
  if (
    trimmed === '~' ||
    trimmed.startsWith('~/') ||
    trimmed.startsWith('~\\') ||
    trimmed.startsWith('/') ||
    WINDOWS_DRIVE_ABSOLUTE_RE.test(trimmed) ||
    WINDOWS_UNC_RE.test(trimmed)
  ) {
    return trimmed
  }
  return null
}

/**
 * Canonicalize a terminal cwd for persistence so the two independent writers —
 * the OSC-7 writer (renderer, emits '/') and the git-watcher writer (main,
 * emits native '\' on Windows AND the realpath on macOS) — always converge on
 * ONE string. Divergence defeats `setTerminalLastCwd`'s idempotency check and
 * makes `terminal.lastCwd` ping-pong, which re-renders the whole React tree
 * thousands of times a second and pins the renderer JS thread (idle-CPU storm).
 *
 * Four platform-independent steps plus one macOS-only step, in order:
 *   1. Separators -> '/'  (Windows git watcher emits '\').
 *   2. Collapse duplicate slashes -> single '/'  (a parent dir ending in '/',
 *      e.g. macOS `$TMPDIR`, makes one source emit `…/T//child` and the other
 *      `…/T/child`). A single leading '//' is preserved on win32 for UNC shares.
 *   2b. Drop redundant '.' path segments. A '/.' segment means "current
 *      directory" (a semantic no-op): one writer reporting `path.join(repo, '.')`
 *      emits `<repo>/.` while the other emits `<repo>`, and the two MUST converge
 *      or `terminal.lastCwd` ping-pongs (same idle-CPU storm class as the '/' vs
 *      '\' divergence above — seen via the GSM two-task "equivalent cwd alias").
 *      A root eaten by this step ('/.' -> '', 'C:/.' -> 'C:') is restored.
 *   3. macOS firmlink reconciliation: `/private/{var,tmp,etc}` and
 *      `/{var,tmp,etc}` are the SAME directory (synthetic firmlinks). The OSC
 *      writer reports the user-facing form (`/var/…`), the git watcher the
 *      realpath (`/private/var/…`). Canonicalize to the user-facing form.
 *   4. Strip a trailing '/' (keep root '/' and a Windows drive root 'C:/').
 *
 * Pure: no side effects, no `Date.now()`, no `window`. `platform` is passed in
 * so the macOS-only firmlink rule is testable on any host. Unit-tested in
 * `test/unittest/terminal-cwd-persist-canonical.test.mts`.
 */
export function canonicalizeTerminalCwdForPersist(
  value: string | null | undefined,
  platform: string
): string | null {
  const validated = normalizeTerminalCwdCandidate(value)
  if (validated === null) return null
  // 1. Separators -> '/'.
  let p = validated.replace(/\\/g, '/')
  // 2. Collapse duplicate slashes, preserving a single leading '//' (win32 UNC).
  const uncLead = platform === 'win32' && /^\/\//.test(p)
  p = p.replace(/\/{2,}/g, '/')
  if (uncLead) p = `/${p}`
  // 2b. Drop redundant '.' path segments ('/.' = current dir, a no-op). Removes
  //     every '/.' followed by '/' or end-of-string, so interior '/./' and a
  //     trailing '/.' both collapse and `<repo>/.` converges with `<repo>`.
  p = p.replace(/\/\.(?=\/|$)/g, '')
  // 2c. Restore a root the step above ate: '/.' -> '' (root '/'); 'C:/.' -> 'C:'
  //     (drive root 'C:/').
  if (p === '') p = '/'
  else if (/^[A-Za-z]:$/.test(p)) p = `${p}/`
  // 3. macOS firmlink reconciliation (the `(?:\/|$)` guard stops it matching
  //    a real dir like `/private/variant`).
  if (platform === 'darwin') {
    p = p.replace(/^\/private(\/(?:var|tmp|etc)(?:\/|$))/, '$1')
  }
  // 4. Strip a single trailing slash, except for root '/' or a drive root 'C:/'.
  if (p.length > 1 && p.endsWith('/') && !/^[A-Za-z]:\/$/.test(p)) {
    p = p.slice(0, -1)
  }
  return p
}

export function parseOsc7Cwd(data: string): string | null {
  if (!data.startsWith('file://')) return null
  const rest = data.slice('file://'.length)
  const slash = rest.indexOf('/')
  let path = slash >= 0 ? rest.slice(slash) : rest
  if (/^\/[A-Za-z]:/.test(path)) {
    path = path.slice(1)
  }
  try {
    return normalizeTerminalCwdCandidate(decodeURIComponent(path))
  } catch {
    return normalizeTerminalCwdCandidate(path)
  }
}

export function parseOsc633Cwd(data: string): string | null {
  if (!data.startsWith('P;Cwd=')) return null
  return normalizeTerminalCwdCandidate(data.slice('P;Cwd='.length))
}

/**
 * Extract the completed command line from an OSC 633 `E` payload
 * (`E;<command-line>`), emitted by Onward shell integration ONLY when the last
 * command's word is `git` (privacy: non-git command lines never leave the
 * shell). Everything after the first `E;` is the command line verbatim — it may
 * contain `;` (e.g. `git commit -m "a; b"`), so do NOT split on `;`. Returns
 * null for a non-`E` payload or an empty line. Capped defensively; the shell
 * already strips control chars.
 */
const MAX_OSC633_COMMAND_LENGTH = 2048
export function parseOsc633Command(data: string): string | null {
  if (!data.startsWith('E;')) return null
  const cmd = data.slice('E;'.length)
  if (!cmd || cmd.length > MAX_OSC633_COMMAND_LENGTH) return null
  return cmd
}

export function parseOsc1337Cwd(data: string): string | null {
  if (!data.startsWith('CurrentDir=')) return null
  return normalizeTerminalCwdCandidate(data.slice('CurrentDir='.length))
}

export function parseOsc9Cwd(data: string): string | null {
  if (!data.startsWith('9;')) return null
  return normalizeTerminalCwdCandidate(data.slice('9;'.length))
}

export function parseTerminalCwdOsc(dialect: TerminalCwdOscDialect, data: string): string | null {
  switch (dialect) {
    case 'osc7':
      return parseOsc7Cwd(data)
    case 'osc633':
      return parseOsc633Cwd(data)
    case 'osc1337':
      return parseOsc1337Cwd(data)
    case 'osc9':
      return parseOsc9Cwd(data)
  }
}
