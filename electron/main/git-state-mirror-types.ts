/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Shared types for the GitStateMirror refactor.
 *
 * The mirror is the single source of truth for branch / repo name / status
 * colour / file list / per-file diff body. Lives in a Worker Thread (so
 * `git status --porcelain=v2 -z` and `@parcel/watcher` callbacks never run
 * on main / renderer), and reaches consumers via a thin pub/sub router on
 * main.
 *
 * Wire shape:
 *   Renderer ── (subscribe/unsubscribe/push-cwd) ──→ Main router
 *                                                      │
 *   Renderer ←── (mirror-update broadcast) ────────────┘
 *                       ▲
 *                       │ (delta postMessage)
 *                       │
 *                  Worker Thread
 *                       │ (parcel-watcher fs events)
 *                       │ (git status reruns)
 *                       ▼
 *
 * Every cross-thread message is one of `MainToMirrorMessage` / `MirrorToMainMessage`.
 * The two unions stay deliberately small: pub/sub is the only model.
 */

import type { GitFileStatus, GitRepoContext, TerminalGitStatus } from './git-utils'

/**
 * Immutable snapshot of a single repo's state. Computed in the worker each
 * time `git status --porcelain=v2 -z` is run; the renderer renders it
 * read-only.
 */
export interface MirrorState {
  cwd: string
  /** Resolved `rev-parse --show-toplevel`; null when cwd is not in a git repo. */
  repoRoot: string | null
  /** Last segment of `repoRoot`. Null when not a repo. */
  repoName: string | null
  /** Current branch name, or null on detached HEAD / non-repo. */
  branch: string | null
  /**
   * Full HEAD object id (`# branch.oid` from porcelain v2 `--branch`). Third
   * freshness signal, orthogonal to `changeFingerprint` (which tracks the
   * working tree): branchOid moves on commit / amend / checkout, so the
   * History list cache (keyed `repoRoot::branchOid::limit::skip`) and the
   * prewarm commit set invalidate the moment a new commit lands — without an
   * extra git spawn, since it is parsed from the same status call. Undefined
   * on non-repo / unknown state.
   */
  branchOid?: string
  /**
   * Order-independent SHA-1 of EVERY decoration-bearing ref: local branches
   * (refs/heads) + remote-tracking refs (refs/remotes) + tags (refs/tags).
   * Sibling freshness signal to branchOid:
   * a `git push` advances origin/<branch> WITHOUT moving HEAD, so branchOid is
   * unchanged but refsDigest moves — feeding the History list cache key (keyed
   * `repoRoot::branchOid::refsDigest::limit::skip`) so the `%D` ref decorations
   * recompute instead of going stale for the 30-min TTL (the "phantom fork after
   * push" bug). Computed by a spawn-free `.git/refs` read in the worker.
   * Undefined on non-repo / git-status failure.
   */
  refsDigest?: string
  /** Status colour bucket — drives the terminal-grid-branch--{status} className. */
  status: TerminalGitStatus | null
  /** File list (unstaged + staged + untracked). Empty array when clean. */
  files: GitFileStatus[]
  /** Multi-repo outline (parent + submodules) when present. */
  repos?: GitRepoContext[]
  /** Set when submodule discovery is still running (staged load). */
  submodulesLoading?: boolean
  /** Captured `Date.now()` when the worker generated this state. */
  capturedAt: number
  /**
   * Fingerprint of changed resources, including tracked working-tree file
   * stat tokens and durable index metadata. This changes when a file that is
   * already `M` is edited again, even if `git status` keeps the same shape.
   */
  changeFingerprint: string
  /**
   * Monotonic generation counter, incremented by the Worker on every
   * recompute that produces a state change. Renderer uses this as a
   * lifecycle key (DiffEditor `key` prop, fileContentsRef cache bucket)
   * so a Refresh Changes click — or any other "force-refresh" path —
   * cascades through to a clean re-mount of every layer below.
   *
   * Phase 2 of the GitState refactor: identity-keyed propagation. Same
   * cwd + same content + same generation → renderer treats it as the
   * same view; bumping generation forces remount even when underlying
   * data is byte-identical.
   */
  generation: number
}

/**
 * Per-file working-tree + index body. Streamed lazily on subscriber
 * request. The worker keeps a `Map<fileKey, { body, statToken }>` and
 * skips re-reading when the on-disk stat token matches the cached one.
 */
export interface MirrorFileBody {
  cwd: string
  fileKey: string
  filename: string
  originalContent: string
  modifiedContent: string
  isBinary: boolean
  isImage?: boolean
  isSvg?: boolean
  isPdf?: boolean
  isEpub?: boolean
  /** `mtime:size` of the working-tree path at read time. */
  statToken: string
}

/**
 * Delta the worker emits when a recompute changes anything. Renderer
 * merges into its local copy of `MirrorState`.
 */
export type MirrorDelta = Partial<Omit<MirrorState, 'cwd' | 'capturedAt'>> & {
  capturedAt: number
}

export type MirrorWatcherHealth =
  | 'idle'
  | 'attaching'
  | 'healthy'
  | 'recovering'
  | 'degraded-polling'
  | 'suspended'
  | 'failed'
  | 'detached'

export type MirrorWatcherFailureKind =
  | 'subscribe-error'
  | 'callback-error'
  | 'path-missing'
  | 'polling-error'
  | 'unknown'

export interface MirrorWatcherStatus {
  cwd: string
  repoRoot: string | null
  health: MirrorWatcherHealth
  message: string | null
  failureKind: MirrorWatcherFailureKind | null
  failureCount: number
  polling: boolean
  pollingIntervalMs: number | null
  nextRetryAt: number | null
  updatedAt: number
}

// ---------------------------------------------------------------------------
// Wire messages
// ---------------------------------------------------------------------------

export type MainToMirrorMessage =
  | { kind: 'attach-watch'; cwd: string }
  | { kind: 'detach-watch'; cwd: string }
  | { kind: 'switch-cwd'; terminalId: string; newCwd: string | null }
  | { kind: 'request-file-body'; cwd: string; fileKey: string; force: boolean; replyId: number }
  | { kind: 'focus-resync'; cwd: string | null }
  // Watcher-independent revalidation (2026-07-05 spinner bundles): a Git Diff
  // open OR a completed terminal git command wants the mirror re-checked
  // WITHOUT the focus-resync generation bump (so an unchanged repo does not
  // force a DiffEditor re-mount / flicker on every open). Recompute + emit only
  // on a real delta, and (re)attach the watcher if the cwd became a git repo.
  // `source` is diagnostic only ('diff-open' | 'terminal-command').
  | { kind: 'revalidate'; cwd: string; source: string }
  // Always-on reconcile heartbeat input: the focused terminal's cwd, so the
  // worker polls that repo at 1 s and the rest of the visible repos at 3 s.
  | { kind: 'reconcile-focus'; cwd: string | null }
  // G3 foreground yield: a user-visible getDiff for this cwd/repoRoot is in
  // flight (busy=true) or just finished (busy=false → grace window). The
  // worker defers that repo's background recomputes so their git spawns stop
  // competing with the foreground load on the EDR process-creation lane.
  | { kind: 'foreground-yield'; cwd: string; repoRoot: string | null; busy: boolean }
  | { kind: 'shutdown' }

export type MirrorToMainMessage =
  | { kind: 'ready' }
  | {
      kind: 'shutdown-complete'
      // Native-quiesce breadcrumb so a future teardown-crash trace shows whether
      // the worker actually reached zero live watcher subscriptions before close.
      quiesce?: { activeSubscriptions: number; pendingUnsubscribes: number; settledMs: number; deadlineHit: boolean }
    }
  | { kind: 'mirror-update'; cwd: string; state: MirrorState; delta: MirrorDelta }
  | { kind: 'file-body-update'; replyId: number; body: MirrorFileBody | null; error?: string }
  | { kind: 'watcher-status'; status: MirrorWatcherStatus }
  // Hard watcher failure signal. Transient parcel-watcher faults use
  // watcher-status; this channel is emitted only when fallback refresh
  // also fails and Git state may be stale.
  | { kind: 'watcher-error'; cwd: string; message: string }
  | { kind: 'log'; level: 'info' | 'warn' | 'error'; message: string; data?: Record<string, unknown> }

/**
 * Renderer-facing snapshot type. Same shape as `MirrorState` — exported
 * separately so renderer code never imports from `electron/main/*`.
 */
export type RendererMirrorSnapshot = MirrorState
