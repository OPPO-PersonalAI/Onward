# SPDX-FileCopyrightText: 2026 OPPO
# SPDX-License-Identifier: Apache-2.0
#
# Onward fish shell integration. Auto-loaded via the
# `XDG_DATA_DIRS=<our>:$XDG_DATA_DIRS` injection pty-manager performs at
# spawn — fish picks up the `vendor_conf.d` entry under our data dir.
#
# Emits both OSC 633 (VS Code-proprietary) and OSC 7 (cross-emulator
# standard) on every fish_prompt event.

if test "$ONWARD_SHELL_INTEGRATION" = "0"
    exit 0
end

function __onward_emit_cwd --on-event fish_prompt
    set -l pwd_url (string replace -a ' ' '%20' $PWD)
    printf '\e]633;P;Cwd=%s\a\e]7;file://%s%s\e\\' $PWD $hostname $pwd_url
    # Watcher-independent git-state freshness (2026-07-05 spinner bundles):
    # re-emit the last command via OSC 633;E ONLY when it is a `git` invocation,
    # so Onward reconciles the mirror even if the FS watcher dropped the `.git`
    # write. Only git command lines leave the shell (privacy); deduped by text.
    set -l __hcmd $history[1]
    if test -n "$__hcmd"; and test "$__hcmd" != "$__onward_last_cmd"
        set -g __onward_last_cmd $__hcmd
        set -l __first (string split -m 1 ' ' -- (string trim -- $__hcmd))[1]
        set -l __leaf (string split -r -m 1 '/' -- $__first)[-1]
        if test "$__leaf" = 'git'; or test "$__leaf" = 'git.exe'
            printf '\e]633;E;%s\a' (string replace -ra '[[:cntrl:]]' ' ' -- $__hcmd)
        end
    end
end

# Suppress a spurious emit for the previous session's last command on the very
# first prompt (fish persists history, so $history[1] is already populated).
set -g __onward_last_cmd $history[1]
