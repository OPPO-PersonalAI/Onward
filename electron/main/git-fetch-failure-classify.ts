/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Pure classification + redaction helpers for background `git fetch` failures.
 *
 * Split out of `git-autofetch-manager.ts` (which imports Electron and the mirror
 * router, and so cannot be loaded by `test/unittest`) so the decision tables here
 * are locked by `test/unittest/git-fetch-failure-classify.test.mts` with no
 * Electron build — the same pure/impure split the scheduler already uses.
 *
 * Why this exists at all (BUG-0005): a fetch killed by the 20 s ceiling used to
 * report `reason: 'timeout'` and nothing else — stderr was captured and then
 * discarded. In a 98.8 h field bundle, 6 of 9 failures were `timeout` with zero
 * further evidence, making "auth wall", "unreachable remote" and "genuinely slow
 * transport" indistinguishable. These helpers turn that stderr into something
 * safe to put in a user-attached trace.
 */

/** What git was actually complaining about, as far as stderr reveals. */
export type FetchFailureReason = 'timeout' | 'auth' | 'no-remote' | 'network' | 'other'

/**
 * Transport class of a repo's `origin`.
 *
 * Recorded on failure so a timeout can be triaged without going back to the
 * user: an SSH timeout points at key/agent/host reachability, an HTTPS timeout at
 * proxy or credential-helper behaviour, and `scp-like` catches
 * `git@host:owner/repo` which looks path-shaped but is SSH. Only the CLASS is
 * ever retained — never the URL, host, or user.
 */
export type RemoteScheme = 'ssh' | 'scp-like' | 'https' | 'http' | 'file' | 'git' | 'none' | 'other'

/** Redacted stderr tail budget, well inside the ~1 KB per-event payload rule. */
export const STDERR_TAIL_MAX = 240

/** Classify a fetch failure from git's stderr so the diagnostic trace is actionable. */
export function classifyFetchFailure(stderr: string): FetchFailureReason {
  const s = stderr.toLowerCase()
  if (/authentication failed|could not read username|could not read password|permission denied|publickey|invalid username or password|terminal prompts disabled/.test(s)) {
    return 'auth'
  }
  if (/no remote repository|does not appear to be a git repository|no such remote|no configured push destination|'origin' does not appear/.test(s)) {
    return 'no-remote'
  }
  if (/could not resolve host|connection timed out|connection refused|unable to access|network is unreachable|failed to connect|timed out/.test(s)) {
    return 'network'
  }
  return 'other'
}

/**
 * Redact a git stderr blob down to a short, safe, still-diagnostic tail.
 *
 * Keeps the scheme and host — that is where the diagnostic value lives — but
 * strips URL userinfo, which is the single highest-risk secret git prints
 * (`https://user:token@host/...` appears verbatim in several failure messages),
 * and collapses long opaque identifier-shaped runs (tokens, object IDs).
 */
export function sanitizeGitStderr(raw: string): string {
  if (!raw) return ''
  const redacted = raw
    .replace(/([a-z][a-z0-9+.-]*:\/\/)[^/@\s]*@/gi, '$1[redacted]@')
    .replace(/\b[A-Za-z0-9_-]{32,}\b/g, '[redacted]')
    .replace(/\s+/g, ' ')
    .trim()
  return redacted.length > STDERR_TAIL_MAX ? `…${redacted.slice(-STDERR_TAIL_MAX)}` : redacted
}

/** Classify a remote URL into its transport class. */
export function classifyRemoteScheme(url: string | null | undefined): RemoteScheme {
  const trimmed = typeof url === 'string' ? url.trim() : ''
  if (!trimmed) return 'none'
  const schemeMatch = /^([a-z][a-z0-9+.-]*):\/\//i.exec(trimmed)
  if (schemeMatch) {
    switch (schemeMatch[1].toLowerCase()) {
      case 'ssh':
        return 'ssh'
      case 'https':
        return 'https'
      case 'http':
        return 'http'
      case 'file':
        return 'file'
      case 'git':
        return 'git'
      default:
        return 'other'
    }
  }
  // `git@github.com:owner/repo.git` — scp-like syntax, always an SSH transport.
  if (/^[^/\s]+@[^/\s]+:/.test(trimmed)) return 'scp-like'
  if (trimmed.startsWith('/') || /^[a-z]:[\\/]/i.test(trimmed)) return 'file'
  return 'other'
}
