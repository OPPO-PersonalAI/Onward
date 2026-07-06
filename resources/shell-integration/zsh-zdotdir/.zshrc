# SPDX-FileCopyrightText: 2026 OPPO
# SPDX-License-Identifier: Apache-2.0
#
# Onward zsh shell integration — `.zshrc` half of the ZDOTDIR wrapper.
# See `.zshenv` in this directory for the wrapper-chain design.
#
# Two responsibilities:
#   1. Chain to the user's real `~/.zshrc` so themes, completions, prompts,
#      and aliases all behave as if Onward were not in the loop.
#   2. Register a precmd hook that emits OSC 633 / OSC 7 cwd sequences on
#      every prompt — the chain GitStateMirror's chip update relies on.

if [[ "${ONWARD_SHELL_INTEGRATION:-1}" == "0" ]]; then
  # User opted out: source their real .zshrc with the proper ZDOTDIR
  # restored so anything that inspects ZDOTDIR sees the user's value, then
  # bail without registering the precmd hook.
  if [[ -n "${USER_ZDOTDIR:-}" && -f "${USER_ZDOTDIR}/.zshrc" ]]; then
    ZDOTDIR="$USER_ZDOTDIR"
    source "$ZDOTDIR/.zshrc"
  fi
  return
fi

# Source user's real .zshrc through the ZDOTDIR-flip pattern. We deliberately
# do NOT unset USER_ZDOTDIR here — `.zlogin` runs after `.zshrc` and still
# needs USER_ZDOTDIR to find the user's `.zlogin`. The final unset lives in
# `.zlogin` so the env var stays consistent across the whole chain.
if [[ -n "${USER_ZDOTDIR:-}" && -f "${USER_ZDOTDIR}/.zshrc" ]]; then
  __ONWARD_ZDOTDIR_WRAPPER="$ZDOTDIR"
  ZDOTDIR="$USER_ZDOTDIR"
  source "$ZDOTDIR/.zshrc"
  ZDOTDIR="$__ONWARD_ZDOTDIR_WRAPPER"
  unset __ONWARD_ZDOTDIR_WRAPPER
fi

__onward_emit_cwd() {
  local pwd_url="${PWD// /%20}"
  print -nP -- $'\e]633;P;Cwd=%~\a\e]7;file://%m'"${pwd_url}"$'\e\\'
  # Watcher-independent git-state freshness (2026-07-05 spinner bundles):
  # re-emit the last command via OSC 633;E ONLY when it is a `git` invocation,
  # so Onward reconciles the mirror even if the FS watcher dropped the `.git`
  # write. Only git command lines leave the shell (privacy); deduped by the
  # history number. `__ONWARD_LAST_HIST` is a global (persists across prompts).
  local __hline __hcmd __first __leaf
  __hline="$(fc -l -1 2>/dev/null)"
  if [[ "$__hline" =~ '^[[:space:]]*([0-9]+)[[:space:]]+(.*)$' ]]; then
    if [[ "${match[1]}" != "${__ONWARD_LAST_HIST:-}" ]]; then
      __ONWARD_LAST_HIST="${match[1]}"
      __hcmd="${match[2]}"
      __first="${__hcmd%%[[:space:]]*}"
      __leaf="${__first##*/}"
      if [[ "$__leaf" == "git" || "$__leaf" == "git.exe" ]]; then
        print -rn -- $'\e]633;E;'"${__hcmd//[[:cntrl:]]/ }"$'\a'
      fi
    fi
  fi
}

autoload -Uz add-zsh-hook 2>/dev/null
if (( $+functions[add-zsh-hook] )); then
  add-zsh-hook precmd __onward_emit_cwd
else
  precmd_functions=(__onward_emit_cwd ${precmd_functions[@]})
fi
