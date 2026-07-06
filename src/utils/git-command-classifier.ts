/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Pure classifier for a terminal command line: is it a state-mutating `git`
 * invocation whose completion should trigger a GitStateMirror reconcile?
 *
 * WHY THIS EXISTS (2026-07-05 diagnostic bundles): the GitStateMirror FS
 * watcher is the sole freshness authority for the diff list + terminal git
 * status, and on Windows under EDR/AV load it silently DROPS `.git/**` events.
 * A `git commit` (which only writes `.git/index` + `refs` + `logs`) then never
 * fires a recompute, so the diff list and tab colour stay stale until the user
 * manually refreshes. Peer precedent — VS Code's built-in Git extension does
 * NOT trust the watcher alone: it parses completed terminal commands via shell
 * integration (`onDidEndTerminalShellExecution`) and re-runs `git status` when
 * the command is one of add/branch/checkout/clean/commit/fetch/reset/revert/
 * pull/push/switch. This module is Onward's watcher-INDEPENDENT equivalent.
 *
 * The shell integration only re-emits a command line that starts with `git`
 * (privacy: non-git command lines never leave the shell), so the input here is
 * already git-scoped; this module's job is (a) confirm it and (b) decide whether
 * the subcommand mutates repo/working-tree state (→ reconcile) vs is read-only
 * (status/log/diff → no reconcile, so an agent spamming `git status` cannot
 * storm the reconcile lane).
 *
 * Leaf module: zero imports, no side effects, no Date.now / window — unit-tested
 * in plain Node (`test/unittest/git-command-classifier.test.mts`).
 */

export interface GitCommandClassification {
  /** The command parsed to a `git <subcommand>` invocation. */
  isGit: boolean
  /** Lower-cased subcommand (`commit`, `checkout`, …) or null when not git. */
  subcommand: string | null
  /**
   * True when the subcommand can change committed/working-tree/ref state that
   * the diff list or status badge reflects — the trigger for a reconcile.
   */
  mutatesState: boolean
  /**
   * True for `init` / `clone`: the cwd may transition non-git → git, so the
   * reconcile must also (re)attach the mirror watcher, not just recompute.
   */
  createsRepo: boolean
}

const NOT_GIT: GitCommandClassification = {
  isGit: false,
  subcommand: null,
  mutatesState: false,
  createsRepo: false
}

/**
 * Subcommands that mutate committed history, the index, the working tree, or
 * refs (ahead/behind) — i.e. anything a Git Diff list or a terminal status
 * badge would render differently after. Deliberately CONSERVATIVE: ambiguous
 * list-or-mutate subcommands (`branch`, `tag`, `remote`, `config`) are omitted
 * so a bare `git branch` (list) does not trigger a recompute; their genuine
 * mutations are caught by the following commit/checkout or the watcher.
 */
const MUTATING_SUBCOMMANDS = new Set<string>([
  'commit',
  'merge',
  'rebase',
  'reset',
  'revert',
  'cherry-pick',
  'checkout',
  'switch',
  'restore',
  'pull',
  'push',
  'fetch',
  'clone',
  'init',
  'add',
  'rm',
  'mv',
  'stash',
  'apply',
  'am',
  'clean',
  'worktree'
])

const REPO_CREATING_SUBCOMMANDS = new Set<string>(['init', 'clone'])

/**
 * Strip the shell noise that can precede the real command word:
 *   - leading `VAR=value ` environment assignments (`GIT_DIR=.git git status`)
 *   - a single `sudo` / `command` / `env` / `nice` / `time` wrapper
 * so `sudo git commit` and `GIT_DIR=x git add` still classify. Only ONE wrapper
 * is peeled (chained wrappers are rare enough to fall through as non-git).
 */
function stripLeadingNoise(tokens: string[]): string[] {
  let i = 0
  // Drop env assignments: `NAME=...` (NAME is a shell-identifier).
  while (i < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i])) i += 1
  // Drop a single wrapper.
  if (i < tokens.length && (tokens[i] === 'sudo' || tokens[i] === 'command' || tokens[i] === 'env' || tokens[i] === 'nice' || tokens[i] === 'time')) {
    i += 1
    // `env` may be followed by its own VAR=val assignments.
    while (i < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i])) i += 1
  }
  return tokens.slice(i)
}

/**
 * Classify a raw command line. Returns {@link NOT_GIT} unless the line resolves
 * to a `git <subcommand>` invocation. Tolerates leading env-assignments and a
 * single sudo/env wrapper; ignores global `git` flags (`-C <path>`, `--git-dir`,
 * `-c key=val`) before the subcommand.
 */
export function classifyGitCommandLine(rawLine: string): GitCommandClassification {
  if (typeof rawLine !== 'string') return NOT_GIT
  const line = rawLine.trim()
  if (!line) return NOT_GIT

  const tokens = stripLeadingNoise(line.split(/\s+/))
  if (tokens.length === 0) return NOT_GIT

  // The command word may be `git` or an absolute/relative path ending in `git`
  // (e.g. `/usr/bin/git`, `C:\Program Files\Git\cmd\git.exe`). Match the leaf.
  const cmd = tokens[0]
  const leaf = cmd.replace(/\\/g, '/').split('/').pop() ?? cmd
  if (leaf !== 'git' && leaf !== 'git.exe') return NOT_GIT

  // Skip git's GLOBAL options to find the subcommand. Global options that take
  // a value: -C <path>, --git-dir <dir>, --work-tree <dir>, -c <name=val>,
  // --namespace <ns>, --exec-path[=<path>]. Value-less: --paginate, --no-pager,
  // --bare, --literal-pathspecs, etc.
  const valueTaking = new Set(['-C', '--git-dir', '--work-tree', '-c', '--namespace', '--exec-path'])
  let i = 1
  while (i < tokens.length) {
    const t = tokens[i]
    if (t === '--') { i += 1; break }
    if (t.startsWith('-')) {
      // `--git-dir=foo` / `--exec-path=foo` carry their own value.
      if (t.includes('=')) { i += 1; continue }
      if (valueTaking.has(t)) { i += 2; continue }
      i += 1
      continue
    }
    break
  }
  if (i >= tokens.length) {
    // Bare `git` (or only options) — a help/usage print, not a mutation.
    return { isGit: true, subcommand: null, mutatesState: false, createsRepo: false }
  }

  const subcommand = tokens[i].toLowerCase()
  const mutatesState = MUTATING_SUBCOMMANDS.has(subcommand)
  const createsRepo = REPO_CREATING_SUBCOMMANDS.has(subcommand)
  return { isGit: true, subcommand, mutatesState, createsRepo }
}
