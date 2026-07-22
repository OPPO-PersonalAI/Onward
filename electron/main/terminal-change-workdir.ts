/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Verified "change working directory" transaction (RC-3 fix, 2026-07
 * bundles).
 *
 * The legacy renderer flow was optimistic: type a `cd` into the PTY, then
 * persist the picked path immediately — no verification, no rollback, no
 * trace. When the cd silently failed (shell busy under a coding agent,
 * blocked integration hiding the real cwd, dead drive), the persisted state
 * and Git authority split from the shell's actual directory — the exact
 * "directory state split" the merged bundle analysis identified.
 *
 * This module makes the switch a transaction:
 *   1. validate the target exists (main-side fs check);
 *   2. write the shell-appropriate cd command WITH a proof emitter
 *      (`buildVerifiedChangeDirectoryCommand`) into the PTY;
 *   3. await the shell's own cwd report (OSC → pushTerminalCwd with a
 *      shell-derived source) matching the target, with a hard timeout;
 *   4. resolve success ONLY on a confirmed match — the caller persists
 *      nothing otherwise.
 *
 * The proof signal rides the existing OSC parse → pushCwd → router chain,
 * so no new protocol is introduced and the verification works identically
 * whether shell integration is alive (prompt re-emits cwd) or blocked (the
 * typed command itself emits one OSC in command mode, which no script
 * policy can block).
 */

import { platform } from 'os'
import { PERF_TRACE_EVENT } from '../../src/utils/perf-trace-names'
import { buildVerifiedChangeDirectoryCommand } from '../../src/utils/terminal-command'
import { performanceTrace } from './performance-trace'
import { resolveExistingTerminalCwd } from './terminal-cwd-validation'
import { gitStateMirrorRouter, type TerminalCwdPushSource } from './git-state-mirror-router'
import { ptyManager } from './pty-manager'

export const CHANGE_WORKDIR_VERIFY_TIMEOUT_MS = 5_000

/** Sources that count as shell-derived proof of the actual directory. */
const SHELL_PROOF_SOURCES: ReadonlySet<TerminalCwdPushSource> = new Set([
  'osc-renderer',
  'osc-main'
])

export type ChangeWorkDirFailureReason =
  | 'target-not-found'
  | 'terminal-not-found'
  | 'write-failed'
  | 'verify-timeout'

export interface ChangeWorkDirResult {
  success: boolean
  /** The canonicalised cwd the shell actually confirmed (success only). */
  cwd?: string
  reason?: ChangeWorkDirFailureReason
}

export async function executeVerifiedChangeWorkDir(
  terminalId: string,
  targetPath: string
): Promise<ChangeWorkDirResult> {
  performanceTrace.record(PERF_TRACE_EVENT.MAIN_TERMINAL_CHANGE_WORKDIR_REQUESTED, {
    terminalId,
    path: String(targetPath ?? '').slice(0, 512)
  })

  const resolvedTarget = resolveExistingTerminalCwd(targetPath)
  if (!resolvedTarget) {
    performanceTrace.record(PERF_TRACE_EVENT.MAIN_TERMINAL_CHANGE_WORKDIR_FAILED, {
      terminalId,
      reason: 'target-not-found',
      path: String(targetPath ?? '').slice(0, 512)
    })
    return { success: false, reason: 'target-not-found' }
  }

  if (!ptyManager.get(terminalId)) {
    performanceTrace.record(PERF_TRACE_EVENT.MAIN_TERMINAL_CHANGE_WORKDIR_FAILED, {
      terminalId,
      reason: 'terminal-not-found'
    })
    return { success: false, reason: 'terminal-not-found' }
  }

  const canonicalTarget = gitStateMirrorRouter.canonicaliseCwd(resolvedTarget)
  const shellKind = ptyManager.getShellKind(terminalId)
  const command = buildVerifiedChangeDirectoryCommand(platform(), resolvedTarget, shellKind)

  // Register the waiter BEFORE writing so a fast shell (proof OSC arriving
  // within one tick of the write) cannot race past us.
  let resolveVerified!: (value: string | null) => void
  const verified = new Promise<string | null>((r) => { resolveVerified = r })
  const disposeListener = gitStateMirrorRouter.onCwdChange((id, _prev, next, source) => {
    if (id !== terminalId || !next) return
    if (!SHELL_PROOF_SOURCES.has(source)) return
    if (gitStateMirrorRouter.canonicaliseCwd(next) !== canonicalTarget) return
    resolveVerified(next)
  })
  const timeoutHandle = setTimeout(() => resolveVerified(null), CHANGE_WORKDIR_VERIFY_TIMEOUT_MS)

  try {
    const wrote = await ptyManager.write(terminalId, command)
    if (!wrote) {
      performanceTrace.record(PERF_TRACE_EVENT.MAIN_TERMINAL_CHANGE_WORKDIR_FAILED, {
        terminalId,
        reason: 'write-failed'
      })
      return { success: false, reason: 'write-failed' }
    }
    performanceTrace.record(PERF_TRACE_EVENT.MAIN_TERMINAL_CHANGE_WORKDIR_WRITTEN, {
      terminalId,
      shellKind,
      path: resolvedTarget.slice(0, 512)
    })

    const confirmedCwd = await verified
    if (confirmedCwd === null) {
      // No shell-derived confirmation inside the window. Deliberately NO
      // rollback write into the shell: the cd may still land later (slow
      // prompt) — the OSC chain will then update the mirror organically.
      // What the timeout guarantees is that Onward persists nothing it has
      // not seen confirmed.
      performanceTrace.record(PERF_TRACE_EVENT.MAIN_TERMINAL_CHANGE_WORKDIR_FAILED, {
        terminalId,
        reason: 'verify-timeout',
        waitedMs: CHANGE_WORKDIR_VERIFY_TIMEOUT_MS,
        path: resolvedTarget.slice(0, 512)
      })
      return { success: false, reason: 'verify-timeout' }
    }

    performanceTrace.record(PERF_TRACE_EVENT.MAIN_TERMINAL_CHANGE_WORKDIR_VERIFIED, {
      terminalId,
      path: confirmedCwd.slice(0, 512)
    })
    return { success: true, cwd: confirmedCwd }
  } finally {
    clearTimeout(timeoutHandle)
    try {
      disposeListener()
    } catch {
      // Listener disposal is best-effort.
    }
  }
}
