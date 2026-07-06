# SPDX-FileCopyrightText: 2026 OPPO
# SPDX-License-Identifier: Apache-2.0
#
# Onward bash shell integration. Injected via `bash --rcfile <wrapper>`.
# The wrapper sources the user's ~/.bashrc first, then sources this file
# so user prompts / aliases / completions still load normally.
#
# Emits two OSC sequences on every prompt:
#   OSC 633 ; P ; Cwd=<path> BEL    — VS Code-proprietary, primary parser path
#   OSC 7   ; file://host/path ESC\ — cross-emulator standard fallback
#
# Set ONWARD_SHELL_INTEGRATION=0 in the environment to disable.

if [ "${ONWARD_SHELL_INTEGRATION:-1}" = "0" ]; then
  return 0 2>/dev/null
fi

__onward_emit_cwd() {
  local pwd_url="${PWD// /%20}"
  printf '\e]633;P;Cwd=%s\a\e]7;file://%s%s\e\\' "$PWD" "${HOSTNAME:-localhost}" "$pwd_url"
  # Watcher-independent git-state freshness (2026-07-05 spinner bundles):
  # re-emit the last command via OSC 633;E ONLY when it is a `git` invocation,
  # so Onward reconciles the mirror even if the FS watcher dropped the `.git`
  # write. Only git command lines leave the shell (privacy); deduped by the
  # history number so a bare Enter does not re-fire. `__ONWARD_LAST_HIST` is a
  # global (persists across prompts) — deliberately NOT declared `local`.
  local __hline __hcmd __first __leaf
  __hline=$(HISTTIMEFORMAT='' builtin history 1 2>/dev/null)
  if [[ "$__hline" =~ ^[[:space:]]*([0-9]+)[[:space:]]+(.*)$ ]]; then
    if [ "${BASH_REMATCH[1]}" != "${__ONWARD_LAST_HIST:-}" ]; then
      __ONWARD_LAST_HIST="${BASH_REMATCH[1]}"
      __hcmd="${BASH_REMATCH[2]}"
      __first="${__hcmd%%[[:space:]]*}"
      __leaf="${__first##*/}"
      case "$__leaf" in
        git|git.exe)
          printf '\e]633;E;%s\a' "${__hcmd//[[:cntrl:]]/ }"
          ;;
      esac
    fi
  fi
}

# Compose with the user's existing PROMPT_COMMAND. Avoid double-registration
# when the shell rcfile is sourced more than once (some plugin managers do).
case ":${PROMPT_COMMAND:-}:" in
  *":__onward_emit_cwd:"*) ;;
  *)
    if [ -n "${PROMPT_COMMAND:-}" ]; then
      PROMPT_COMMAND="__onward_emit_cwd; ${PROMPT_COMMAND}"
    else
      PROMPT_COMMAND="__onward_emit_cwd"
    fi
    ;;
esac
export PROMPT_COMMAND
