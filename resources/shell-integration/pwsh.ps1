# SPDX-FileCopyrightText: 2026 OPPO
# SPDX-License-Identifier: Apache-2.0
#
# Onward PowerShell shell integration. Loaded via `-NoExit -Command ". ..."`
# at terminal spawn. Wraps the user's existing prompt function so the
# original prompt text is preserved and our OSC emission happens on every
# new prompt, matching VS Code's strategy.

if ($env:ONWARD_SHELL_INTEGRATION -eq '0') { return }

# Capture the user's current prompt so we can call into it.
$Global:__OnwardOriginalPrompt = $function:Prompt

function global:Prompt {
    $cwd = $PWD.Path
    # Build a well-formed `file://<host>/<path>` URI:
    #   1. Backslashes → forward slashes (Windows paths use `\`; the URI form
    #      requires `/`). Without this the parser sees `file://HOSTC:\...`
    #      and reads back a malformed path that overwrites the OSC 633 cwd
    #      we just emitted with garbage.
    #   2. Percent-encode characters that are unsafe in a URI path — at minimum
    #      space → `%20`. We deliberately keep `:` (drive letter) and `/`
    #      readable; full RFC 3986 encoding is overkill for our parser.
    #   3. Insert a `/` between host and path so a Windows drive `C:\foo`
    #      becomes `file://localhost/C:/foo`, not `file://localhostC:/foo`.
    $cwdForUri = $cwd -replace '\\', '/'
    $cwdForUri = $cwdForUri -replace ' ', '%20'
    # MUST NOT be named `$host`: that is a read-only automatic variable in
    # Windows PowerShell 5.x. Assigning to it raises a non-terminating error
    # that the interactive prompt machinery treats as a failed prompt, so
    # PowerShell discards the whole prompt (including the OSC writes below)
    # and falls back to the bare `PS>` prompt — emitting ZERO cwd OSC. The
    # renderer's xterm OSC parser then never fires and the Task status bar
    # never reflects `cd`. Keep this as `$hostName` (or any non-reserved name).
    $hostName = if ($env:COMPUTERNAME) { $env:COMPUTERNAME } else { 'localhost' }
    $esc = [char]0x1b
    $bel = [char]0x07
    Write-Host -NoNewline ($esc + ']633;P;Cwd=' + $cwd + $bel)
    Write-Host -NoNewline ($esc + ']7;file://' + $hostName + '/' + $cwdForUri + $esc + '\')
    # Watcher-independent git-state freshness (2026-07-05 spinner bundles):
    # re-emit the last command via OSC 633;E ONLY when it is a `git` invocation,
    # so Onward can reconcile the mirror even if the FS watcher dropped the
    # `.git` write (VS Code's terminal-shell-integration model). Emitting only
    # git command lines keeps non-git command lines inside the shell (privacy).
    # Deduped by history Id so a bare Enter does not re-fire.
    try {
        $h = Get-History -Count 1 -ErrorAction SilentlyContinue | Select-Object -Last 1
        if ($h -and $h.Id -ne $Global:__OnwardLastHistoryId) {
            $Global:__OnwardLastHistoryId = $h.Id
            $first = ($h.CommandLine.TrimStart() -split '\s+', 2)[0]
            $leaf = ($first -split '[\\/]')[-1]
            if ($leaf -eq 'git' -or $leaf -eq 'git.exe') {
                $safe = ($h.CommandLine -replace '[\x00-\x1f]', ' ')
                if ($safe.Length -gt 2048) { $safe = $safe.Substring(0, 2048) }
                Write-Host -NoNewline ($esc + ']633;E;' + $safe + $bel)
            }
        }
    } catch { }
    & $Global:__OnwardOriginalPrompt
}
