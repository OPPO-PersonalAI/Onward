#!/usr/bin/env bash
set -euo pipefail

# SPDX-FileCopyrightText: 2026 OPPO
# SPDX-License-Identifier: Apache-2.0

sanitize_branch_name() {
  local value="${1:-}"
  value="$(printf '%s' "$value" | sed -E 's/[^a-zA-Z0-9._-]+/-/g; s/-+/-/g; s/^-+|-+$//g')"
  if [[ -z "$value" || "$value" == "HEAD" ]]; then
    value="detached"
  fi
  printf '%s\n' "$value"
}

detect_dev_product_name() {
  local root_dir="${1:?root_dir is required}"
  local branch
  branch="$(git -C "$root_dir" rev-parse --abbrev-ref HEAD 2>/dev/null || echo detached)"
  branch="$(sanitize_branch_name "$branch")"
  local version
  version="$(cd "$root_dir" && node -p "require('./package.json').version" 2>/dev/null || echo 0.0.0)"
  printf 'Under Development %s-%s\n' "$version" "$branch"
}

resolve_dev_app_bin() {
  local root_dir="${1:?root_dir is required}"
  local product_name="${2:-$(detect_dev_product_name "$root_dir")}"
  local candidates=(
    "$root_dir/release/mac-arm64/$product_name.app/Contents/MacOS/$product_name"
    "$root_dir/release/mac/$product_name.app/Contents/MacOS/$product_name"
    "$root_dir/release/linux-unpacked/$product_name"
    "$root_dir/release/win-unpacked/$product_name.exe"
  )
  local candidate
  for candidate in "${candidates[@]}"; do
    if [[ -x "$candidate" ]]; then
      printf '%s\n' "$candidate"
      return 0
    fi
  done

  local fallback
  fallback="$(find "$root_dir/release" \( -path "*/Contents/MacOS/Under Development *" -o -path "*/linux-unpacked/Under Development *" -o -name "Under Development *.exe" \) 2>/dev/null | head -n 1 || true)"
  if [[ -n "$fallback" ]]; then
    printf '%s\n' "$fallback"
    return 0
  fi

  return 1
}

# Best-effort, EBUSY/EPERM-tolerant removal for autotest EXIT-trap / cleanup use.
#
# WHY (2026-07-08 full-regression drift): on Windows an EDR real-time scan, a
# just-exited Electron helper, or the git worker can hold a handle on a runner's
# scratch dir for ~1 s AFTER the app exits, so a plain `rm -rf` in an EXIT trap
# fails with EBUSY/EPERM. Under `set -euo pipefail` that non-zero return became
# the SCRIPT's exit status, turning a run whose assertions ALL PASSED into a
# spurious FAIL — and since which runner is unlucky at teardown is probabilistic,
# the failing set SHIFTED run-to-run (the classic "shifting flake" that was
# really one shared cleanup bug across ~18 runners).
#
# The test verdict is decided by the assertions BEFORE cleanup runs; a leftover
# scratch dir is disk hygiene, never a test failure. So: retry with a short
# backoff to give the handle time to release (usually clears within ~1 s), then
# swallow any residual failure. ALWAYS returns 0 so it can never flip the
# runner's exit code. Accepts multiple paths (also covers `"${leftovers[@]}"`
# array sweeps); an empty arg list or a missing path is a no-op.
onward_robust_rm() {
  local target attempt
  for target in "$@"; do
    [ -n "$target" ] || continue
    [ -e "$target" ] || continue
    for attempt in 1 2 3 4 5; do
      rm -rf "$target" 2>/dev/null && break
      sleep 0.3
    done
  done
  return 0
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  root_dir="${1:-$(cd "$(dirname "$0")/../.." && pwd)}"
  resolve_dev_app_bin "$root_dir"
fi
