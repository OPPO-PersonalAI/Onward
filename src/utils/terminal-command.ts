/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

export type TerminalShellKind = 'posix' | 'powershell' | 'cmd' | 'unknown'

function quotePosixPath(value: string): string {
  return "'" + value.replace(/'/g, "'\\''") + "'"
}

function quotePowerShellLiteral(value: string): string {
  return "'" + value.replace(/'/g, "''") + "'"
}

function quoteCmdPath(value: string): string {
  return '"' + value.replace(/([%^&|<>!])/g, '^$1').replace(/"/g, '""') + '"'
}

export function buildChangeDirectoryCommand(
  platform: string,
  directory: string,
  shellKind?: TerminalShellKind
): string {
  if (platform === 'win32') {
    if (shellKind === 'cmd') {
      return `cd /d ${quoteCmdPath(directory)}\r`
    }
    return `Set-Location -LiteralPath ${quotePowerShellLiteral(directory)}\r`
  }
  return `cd ${quotePosixPath(directory)}\r`
}

/**
 * Verified variant (RC-3 fix, 2026-07 bundles): the cd command carries its
 * own proof emitter — after the directory change the SHELL itself reports
 * the resulting cwd via an OSC 633;P;Cwd= sequence, which the existing OSC
 * parse → pushCwd → GitStateMirror chain turns into the confirmation signal
 * the main-process transaction awaits. Design properties:
 *
 *   - Works with shell integration BLOCKED: the emitter is part of the typed
 *     command (command mode), not a script file, so ExecutionPolicy /
 *     AppLocker cannot stop it — same exemption the inline -Command
 *     integration relies on.
 *   - Honest on failure: PowerShell's `Set-Location` error is
 *     non-terminating, so the emitter still runs and reports the OLD cwd —
 *     a mismatch, which the transaction correctly treats as failure. The
 *     POSIX form chains with `&&`, so a failed cd emits nothing and the
 *     transaction times out — also failure.
 *   - cmd.exe emits no inline proof (no way to print ESC from a one-liner);
 *     its PROMPT env integration (OSC 9;9, unblockable) reports the cwd on
 *     the next prompt, which serves as the proof.
 *   - The POSIX form works unchanged in bash / zsh / dash / fish (all
 *     support `&&`, single-quote literals, `"$PWD"`, and printf `\033`).
 */
export function buildVerifiedChangeDirectoryCommand(
  platform: string,
  directory: string,
  shellKind?: TerminalShellKind
): string {
  if (platform === 'win32') {
    if (shellKind === 'cmd') {
      return `cd /d ${quoteCmdPath(directory)}\r`
    }
    // Convert-Path (cmdlet) over $PWD.Path (property read): cmdlets stay
    // usable under Constrained Language Mode, matching the inline
    // integration's CLM posture.
    return `Set-Location -LiteralPath ${quotePowerShellLiteral(directory)}; ` +
      `Write-Host -NoNewline ([char]27 + ']633;P;Cwd=' + (Convert-Path -LiteralPath .) + [char]7)\r`
  }
  return `cd ${quotePosixPath(directory)} && printf '\\033]633;P;Cwd=%s\\007' "$PWD"\r`
}
