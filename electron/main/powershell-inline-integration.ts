/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Inline PowerShell shell-integration payload (RC-1 fix, 2026-07 diagnostic
 * bundles: locked-down machines block the `pwsh.ps1` dot-source).
 *
 * WHY INLINE: PowerShell ExecutionPolicy (Restricted / AllSigned via GPO),
 * AppLocker script rules, and Mark-of-the-Web all gate the execution of
 * SCRIPT FILES (.ps1). A `-Command <string>` payload is not a script file
 * and is exempt from every one of those gates — Restricted explicitly
 * permits interactive commands and `-Command` strings. VS Code cannot take
 * this route because its integration script is far too large to inline
 * (command detection + env reporting + Authenticode signing pipeline); ours
 * only has to emit cwd/git-command OSC, which fits in ~1.2 KB.
 *
 * The remaining failure layer is Constrained Language Mode (AppLocker /
 * WDAC). The payload stays inside CLM-permitted constructs where possible
 * and degrades gracefully where it cannot:
 *   - cmdlets only (`Convert-Path`, `Write-Host`, `Get-History`) on the
 *     critical path — cmdlets are fully allowed in CLM;
 *   - allowed-type operations only for the cwd emit (string concat,
 *     `[char]` casts, `-replace` on strings);
 *   - the risky pieces (`$PWD.Path` property fallback, `HistoryInfo`
 *     property reads for the git-command re-emit) are wrapped in
 *     try/catch so a CLM denial silently degrades to "no OSC from that
 *     branch" instead of breaking the user's prompt. VS Code's script
 *     exits entirely under CLM; this payload keeps the cwd channel alive.
 *
 * HARD CONSTRAINTS on the generated text:
 *   1. NO double-quote characters — the payload travels as one argv element
 *      through node-pty's Windows command-line quoting; keeping it free of
 *      `"` makes the CreateProcess → powershell.exe CLI round-trip
 *      unambiguous on both Windows PowerShell 5.1 and pwsh 7.
 *   2. Single line — statements separate with `;`; no embedded newlines.
 *   3. Behaviour parity with `resources/shell-integration/pwsh.ps1`
 *      (kept for manual installation): OSC 633;P;Cwd= + OSC 7 on every
 *      prompt, OSC 633;E re-emit for git command lines (deduped by history
 *      id), chaining the user's original prompt function.
 *
 * Pure module (no Electron, no I/O) so the payload is unit-testable in
 * `test/unittest/powershell-inline-integration.test.mts`.
 */

/** OSC dialect fragments the payload emits; exported for unit assertions. */
export const PS_INLINE_OSC_633_CWD_PREFIX = ']633;P;Cwd='
export const PS_INLINE_OSC_7_PREFIX = ']7;file://'
export const PS_INLINE_OSC_633_COMMAND_PREFIX = ']633;E;'

/**
 * Build the `-Command` payload string that installs the Onward prompt
 * wrapper. The caller passes it as ONE argv element after
 * `-NoLogo -NoExit -Command`.
 */
export function buildPowerShellInlineIntegrationCommand(): string {
  // Assembled from small PowerShell statements. Every string below is the
  // FINAL PowerShell text (TS escaping already resolved) — reviewers should
  // read the .join output, which the unit test snapshots structurally.
  const promptBody = [
    '$e = [char]27',
    '$b = [char]7',
    '$p = $null',
    // Convert-Path (a cmdlet — CLM-safe) resolves the current provider
    // location to a filesystem path. Fallback: $PWD.Path property read,
    // which SOME CLM policies deny — hence its own try/catch.
    'try { $p = Convert-Path -LiteralPath . -ErrorAction Stop } catch { try { $p = $PWD.Path } catch { $p = $null } }',
    'if ($p) { ' + [
      `Write-Host -NoNewline ($e + '${PS_INLINE_OSC_633_CWD_PREFIX}' + $p + $b)`,
      // OSC 7 needs the file:// URI form: '\' -> '/', space -> %20, and a
      // '/' between host and the drive-lettered path.
      "$u = ($p -replace '\\\\', '/') -replace ' ', '%20'",
      '$h = $env:COMPUTERNAME',
      "if (-not $h) { $h = 'localhost' }",
      `Write-Host -NoNewline ($e + '${PS_INLINE_OSC_7_PREFIX}' + $h + '/' + $u + $e + '\\')`
    ].join('; ') + ' }',
    // Watcher-independent git-state freshness: re-emit the last command via
    // OSC 633;E ONLY when it is a git invocation (privacy: non-git command
    // lines never leave the shell). HistoryInfo property reads may be
    // CLM-denied — the try/catch degrades to "no 633;E".
    'try { ' + [
      '$hi = Get-History -Count 1 -ErrorAction SilentlyContinue | Select-Object -Last 1',
      'if ($hi -and $hi.Id -ne $Global:__OnwardLastHistoryId) { ' + [
        '$Global:__OnwardLastHistoryId = $hi.Id',
        "$f = ($hi.CommandLine.TrimStart() -split '\\s+', 2)[0]",
        "$l = ($f -split '[\\\\/]')[-1]",
        "if ($l -eq 'git' -or $l -eq 'git.exe') { " + [
          "$s = ($hi.CommandLine -replace '[\\x00-\\x1f]', ' ')",
          'if ($s.Length -gt 2048) { $s = $s.Substring(0, 2048) }',
          `Write-Host -NoNewline ($e + '${PS_INLINE_OSC_633_COMMAND_PREFIX}' + $s + $b)`
        ].join('; ') + ' }'
      ].join('; ') + ' }'
    ].join('; ') + ' } catch { }',
    // Chain the captured prompt; minimal fallback if none existed.
    "if ($Global:__OnwardOriginalPrompt) { & $Global:__OnwardOriginalPrompt } else { 'PS ' + $p + '> ' }"
  ].join('; ')

  return [
    // Capture the user's prompt exactly once. -Command runs AFTER profiles,
    // so oh-my-posh / starship / posh-git customisations are already in
    // place and get chained, not clobbered.
    '$Global:__OnwardOriginalPrompt = $function:Prompt',
    `function global:Prompt { ${promptBody} }`
  ].join('; ')
}
