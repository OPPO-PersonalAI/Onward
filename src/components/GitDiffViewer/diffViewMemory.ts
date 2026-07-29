/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

import type { GitFileStatus } from '../../types/electron'

export type DiffViewAnchor = {
  line: number | null
  scrollTop: number
}

export type DiffViewMemoryEntry = {
  fileKey: string
  filePath: string
  originalFilename?: string
  anchor: DiffViewAnchor | null
  scrollTop: number
  signature: string | null
  updatedAt: number
}

export type DiffViewMemory = {
  selectedFileKey: string | null
  entries: Record<string, DiffViewMemoryEntry>
}

export type GitDiffSelectionSnapshot = {
  selectedFilePath: string | null
  selectedFileKey: string | null
}

export function buildGitDiffFileKey(repoRoot: string, file: GitFileStatus): string {
  const original = file.originalFilename ?? ''
  return `${repoRoot}::${file.changeType}::${file.status}::${original}::${file.filename}`
}

export function buildGitDiffSelectionSnapshot(
  repoRoot: string,
  file: GitFileStatus | null
): GitDiffSelectionSnapshot {
  return {
    selectedFilePath: file?.filename ?? null,
    selectedFileKey: file ? buildGitDiffFileKey(file.repoRoot || repoRoot, file) : null
  }
}

export function resolveGitDiffSnapshotSelection(
  files: GitFileStatus[],
  repoRoot: string,
  snapshot: GitDiffSelectionSnapshot | null
): GitFileStatus | null {
  const wantedPath = snapshot?.selectedFilePath
  if (!wantedPath) return null

  const selectedFileKey = snapshot.selectedFileKey
  const keyed = selectedFileKey
    ? files.find((file) => (
        buildGitDiffFileKey(file.repoRoot || repoRoot, file) === selectedFileKey
      )) ?? null
    : null
  if (keyed && (keyed.filename === wantedPath || keyed.originalFilename === wantedPath)) {
    return keyed
  }
  if (selectedFileKey && !keyed) return null

  return files.find((file) => file.filename === wantedPath || file.originalFilename === wantedPath) ?? null
}

function findMatchingFile(
  files: GitFileStatus[],
  candidate: Pick<GitFileStatus, 'filename' | 'changeType' | 'originalFilename'>
): GitFileStatus | null {
  const exact = files.find((file) =>
    file.filename === candidate.filename &&
    file.changeType === candidate.changeType
  )
  if (exact) return exact
  return files.find((file) =>
    file.filename === candidate.filename &&
    (file.originalFilename ?? '') === (candidate.originalFilename ?? '')
  ) ?? null
}

export function resolveGitDiffRestoredSelection(
  files: GitFileStatus[],
  repoRoot: string,
  memory: DiffViewMemory | null,
  activeSelection: GitFileStatus | null
): GitFileStatus | null {
  if (files.length === 0) return null
  if (activeSelection) {
    const match = findMatchingFile(files, activeSelection)
    if (match) return match
  }
  const selectedFileKey = memory?.selectedFileKey
  if (!selectedFileKey) return null
  const direct = files.find((file) =>
    buildGitDiffFileKey(file.repoRoot || repoRoot, file) === selectedFileKey
  )
  if (direct) return direct
  const entry = memory?.entries[selectedFileKey]
  if (!entry) return null
  return files.find((file) =>
    file.filename === entry.filePath &&
    (file.originalFilename ?? '') === (entry.originalFilename ?? '')
  ) ?? files.find((file) => file.filename === entry.filePath) ?? null
}

export function clearGitDiffMemorySelectionWhenEmpty(
  memory: DiffViewMemory,
  files: GitFileStatus[]
): void {
  if (files.length === 0) {
    clearGitDiffMemorySelection(memory)
  }
}

export function clearGitDiffMemorySelection(memory: DiffViewMemory): void {
  memory.selectedFileKey = null
}

export function mergeGitDiffSnapshotScroll(
  memory: DiffViewMemory,
  file: GitFileStatus,
  fileKey: string,
  scrollTop: number | null | undefined,
  now = Date.now()
): boolean {
  if (typeof scrollTop !== 'number' || !Number.isFinite(scrollTop) || scrollTop < 0) {
    return false
  }

  const previous = memory.entries[fileKey]
  memory.entries[fileKey] = {
    fileKey,
    filePath: file.filename,
    originalFilename: file.originalFilename,
    anchor: {
      line: previous?.anchor?.line ?? null,
      scrollTop
    },
    scrollTop,
    signature: previous?.signature ?? null,
    updatedAt: now
  }
  memory.selectedFileKey = fileKey
  return true
}

export function shouldRestoreGitDiffSnapshotScroll(
  previousSignature: string | null | undefined,
  currentSignature: string
): boolean {
  return !previousSignature || previousSignature === currentSignature
}

// Restore-vs-reveal decision for the render-then-reveal cycle (the
// `restoring-scroll` phase). Mirrors VS Code's textDiffEditor precedence —
// restored view state wins, `revealFirstDiff()` is the fallback — with one
// deliberate extension: a saved position belongs to the content the user last
// SAW (`entry.signature`); when the current content no longer matches it, the
// stale position is meaningless and the cycle must land on the first change
// instead (the seam VS Code exposes as an explicit open-option override).
export type DiffRestoreDecision =
  | { action: 'restore-scroll'; scrollTop: number }
  | { action: 'restore-anchor'; line: number }
  | { action: 'reveal-first-change'; reason: 'no-entry' | 'deleted-file' | 'content-changed' | 'no-saved-position' }

export function resolveDiffRestoreDecision(input: {
  entry: Pick<DiffViewMemoryEntry, 'scrollTop' | 'anchor' | 'signature'> | null
  isDeletedFile: boolean
  /** Signature of the content currently loaded; null = unknown (binary / still loading). */
  currentSignature: string | null
}): DiffRestoreDecision {
  const { entry, isDeletedFile, currentSignature } = input
  if (!entry) return { action: 'reveal-first-change', reason: 'no-entry' }
  if (isDeletedFile) return { action: 'reveal-first-change', reason: 'deleted-file' }
  if (
    entry.signature &&
    currentSignature !== null &&
    entry.signature !== currentSignature
  ) {
    return { action: 'reveal-first-change', reason: 'content-changed' }
  }
  if (entry.scrollTop > 0) return { action: 'restore-scroll', scrollTop: entry.scrollTop }
  const anchorLine = entry.anchor?.line
  if (typeof anchorLine === 'number' && anchorLine > 0) {
    return { action: 'restore-anchor', line: anchorLine }
  }
  return { action: 'reveal-first-change', reason: 'no-saved-position' }
}

// ── Monaco model identity ────────────────────────────────────────────────────
//
// A Monaco model is looked up by URI (@monaco-editor/react's getOrCreateModel
// does `editor.getModel(uri) ?? editor.createModel(value, lang, uri)`), so a
// URI that does NOT encode the content it stands for silently resurrects a
// model whose body belongs to an earlier version of the file — and the value
// passed to createModel is discarded. Monaco then computes the mount-time diff
// against that stale body, and keeps BOTH the stale `_diff` and the stale
// unchanged-region visibility state when the body is later corrected in place.
//
// The remedy mirrors VS Code's git extension, whose `toGitUri()` puts a
// REQUIRED `ref` in the URI query: the base side's identity IS its URI, so a
// different base is a different document and can never share a model. The
// worktree side stays a stable URI and mutates in place (VS Code keeps it a
// plain `file:` document) — model freshness there is owned by the disposal
// sweep plus the diff-currency gate, not by the URI.
//
// Deliberately NOT part of the identity: `draftContent`. The identity keys a
// model; folding a live draft into it would rebuild the model on every
// keystroke.

const STRONG_HASH_RADIX = 36

// Full-content hash. `buildTextSignature` above samples head + tail + length,
// which is adequate for "is this the content the user last SAW" but far too
// weak to key a model on: an agent rewriting one line into another line of the
// same length keeps length, head and tail identical, and the collision
// resurrects exactly the stale model this identity exists to retire. Two
// independent 32-bit accumulators (djb2 forward, sdbm reverse) give ~64 bits
// over the whole string, which is what makes the "same length, same head, same
// tail, different middle" case a different identity.
export function hashTextStrong(text: string): string {
  let djb2 = 5381
  let sdbm = 0
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i)
    djb2 = (((djb2 << 5) + djb2) ^ code) >>> 0
    sdbm = (code + (sdbm << 6) + (sdbm << 16) - sdbm) >>> 0
  }
  return `${text.length.toString(STRONG_HASH_RADIX)}` +
    `-${djb2.toString(STRONG_HASH_RADIX)}` +
    `-${sdbm.toString(STRONG_HASH_RADIX)}`
}

export type GitDiffBaseIdentityInput = {
  changeType: GitFileStatus['changeType']
  status: GitFileStatus['status']
  /** Git-provided base content for this entry (empty for an untracked file). */
  originalContent: string
}

// Identity of the diff's BASE. `changeType` + `status` are included even
// though the content hash alone would usually differ, because they are what
// makes the identity self-describing in a trace and because an empty base is
// legitimately shared by "untracked" and "added" entries.
export function buildGitDiffBaseIdentity(input: GitDiffBaseIdentityInput): string {
  return `${input.changeType}.${input.status || 'x'}.${hashTextStrong(input.originalContent)}`
}

// Signature of "the content the user last SAW", used by
// resolveDiffRestoreDecision to choose between restoring a saved position and
// revealing the first change. It runs over the full text for the same reason
// the model identity does: the head+tail+length sampling it replaced reports
// "unchanged" for a same-length middle-only rewrite, which is precisely the
// edit a coding agent makes (one line swapped for another of equal length).
// A false "unchanged" here restores a scroll offset that belongs to content
// the user has never seen — the presentation-layer half of the same defect
// family as the stale-model identity above.
export function buildGitDiffContentSignature(original: string, modified: string): string {
  return `${hashTextStrong(original)}|${hashTextStrong(modified)}`
}

// ── Warm-reopen reveal gate ──────────────────────────────────────────────────
//
// `editor.getLineChanges() !== null` answers "has a diff ever been computed on
// this widget", NOT "does the computed diff describe what the models currently
// hold". Monaco keeps `_diff` across a content change and only flips
// `_isDiffUpToDate` to false while a 200 ms debouncer is pending
// (`diffEditorViewModel.js`), so the null-check passes throughout the window in
// which the answer is wrong. Monaco guards its own diff-consuming APIs with
// `isDiffUpToDate` for exactly this reason.
//
// `diffComputedForBoundModels` is the honest signal: an `onDidUpdateDiff` has
// landed for the model pair currently bound, and no write into those models
// has happened since.

export type WarmRevealGateInput = {
  /** Selected body is present, settled, and renderable. */
  contentReady: boolean
  /** A forced refetch is pending for this key — deciding now reads a doomed body. */
  staleMarked: boolean
  /** The widget's bound model URIs equal the ones the selection expects. */
  modelsMatch: boolean
  /** Monaco has reported a diff for the CURRENTLY bound models, with no write since. */
  diffComputedForBoundModels: boolean
}

export function shouldCompleteWarmReveal(input: WarmRevealGateInput): boolean {
  if (!input.contentReady) return false
  if (input.staleMarked) return false
  if (!input.modelsMatch) return false
  return input.diffComputedForBoundModels
}

// ── Reveal reconciliation ────────────────────────────────────────────────────
//
// The problem this replaces: the reveal cycle can be advanced from four
// different places (`diff-computed`, `model-bound`, `warm-ready`, `timeout`),
// and each carried its own local notion of "am I allowed to decide now". Two
// of them could not honour the contract at all — `timeout` fires on a clock,
// and `model-bound` fires off an in-flight click-latency measurement — so
// whether the viewport landed correctly depended on which path happened to win
// a race. Reasoning about that requires reasoning about instants, which is
// exactly where defects kept coming from.
//
// The reconciliation model removes instants from the correctness argument.
// Every applied position records WHICH content it was computed from. A
// position whose recorded signature no longer matches the live content is
// stale — a pure state comparison, checkable at any moment, with no notion of
// "when". Staleness then converges: silently when the user has not taken
// ownership of the viewport, and by telling them when they have (moving the
// viewport out from under someone who scrolled there deliberately is the one
// loss silent convergence could cause).
//
// The consequence worth stating: `timeout` and `model-bound` no longer need to
// be correct. They may apply a provisional position and record whatever
// signature they computed from; reconciliation repairs it once a real diff
// lands. Which trigger won the race stops being a correctness question.
//
// Invariant, assertable continuously and without constructing any timing:
//   not stale  =>  the applied position was computed from the current content

export type RevealReconcileAction =
  /** Applied position still describes the live content (or nothing is applied). */
  | 'none'
  /** Stale, but Monaco's diff does not yet describe the bound models — try again on the next diff. */
  | 'wait'
  /** Stale and repairable without the user noticing. */
  | 'reconcile-silent'
  /** Stale, but the user owns the viewport — leave it alone and surface it instead. */
  | 'notify'

export type RevealReconcileInput = {
  /** Signature of the content the applied position was computed from; null = nothing applied yet. */
  appliedSignature: string | null
  /** Signature of the content currently loaded; null = unknown (binary / still loading). */
  currentSignature: string | null
  /** Monaco's computed diff describes the models bound right now. */
  diffCurrentForBoundModels: boolean
  /** The user scrolled since the position was applied, so the viewport is theirs. */
  userOwnsViewport: boolean
}

export function resolveRevealReconcile(input: RevealReconcileInput): RevealReconcileAction {
  // Nothing applied yet: the ordinary reveal cycle owns this file, not reconciliation.
  if (input.appliedSignature === null) return 'none'
  // Content identity unknown (binary, or a body still in flight) — comparing
  // against it would be comparing against a placeholder.
  if (input.currentSignature === null) return 'none'
  if (input.appliedSignature === input.currentSignature) return 'none'
  // Stale from here down.
  if (!input.diffCurrentForBoundModels) return 'wait'
  return input.userOwnsViewport ? 'notify' : 'reconcile-silent'
}

export function resolveGitDiffSnapshotScrollTop(
  scrollTop: number | null | undefined,
  scrollHeight: number,
  viewportHeight: number
): number | null {
  if (
    typeof scrollTop !== 'number'
    || !Number.isFinite(scrollTop)
    || scrollTop < 0
    || !Number.isFinite(scrollHeight)
    || scrollHeight < 0
    || !Number.isFinite(viewportHeight)
    || viewportHeight < 0
  ) {
    return null
  }
  return Math.min(scrollTop, Math.max(0, scrollHeight - viewportHeight))
}
