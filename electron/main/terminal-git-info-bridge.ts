/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Terminal Git Info Bridge.
 *
 * Replaces the polling GitWatchManager. Subscribes each terminal to the
 * GitStateMirror authority for its current cwd, translates MirrorState
 * deltas into TerminalGitInfo, and pushes them to the renderer via
 * IPC.GIT_TERMINAL_INFO.
 *
 * No polling, no time-based TTL. Three event sources drive every emission:
 *   1) IPC.GIT_SUBSCRIBE_TERMINAL_INFO — renderer attaches a terminal
 *   2) GitStateMirrorRouter cwd-change listener — terminal cwd shifted
 *   3) GitStateMirrorRouter mirror-update listener — git state changed
 *
 * Cold-start: when a terminal subscribes before OSC has pushed its cwd,
 * we do ONE lsof-style probe via `getTerminalCwd`. This is event-driven
 * (the subscribe IS the event), not periodic.
 */

import { gitStateMirrorRouter } from './git-state-mirror-router'
import { performanceTrace } from './performance-trace'
import { PERF_TRACE_EVENT } from '../../src/utils/perf-trace-names'
import { getTerminalCwd, type TerminalGitInfo } from './git-utils'
import {
  emptyTerminalGitInfo,
  fingerprintTerminalGitInfo,
  mirrorStateToTerminalGitInfo
} from './terminal-git-info-helpers'
import type { MirrorState } from './git-state-mirror-types'
import type { RepoPrewarmReason, RepoPrewarmRequest } from './git-repo-prewarm'

export type TerminalInfoEmitter = (terminalId: string, info: TerminalGitInfo) => void

/**
 * Repo prewarm hooks the bridge invokes on its two trigger edges. Kept as a
 * thin facade (not a direct import of the coordinator) so the bridge stays
 * decoupled and the wiring in ipc-handlers owns the coordinator instance.
 */
export interface BridgePrewarmHooks {
  /**
   * Leading edge of a NEW cwd — terminal subscribe (cold start) or `cd` into
   * another repo. Warms Diff (once per cwd) + History (once per cwd::branchOid).
   */
  onCwdAttached(req: RepoPrewarmRequest): void
  /**
   * Every mirror-update for a subscribed cwd. Warms History ONLY (and only when
   * branchOid actually moved — the coordinator's cwd::branchOid dedup makes the
   * common working-tree-edit update a no-op). The Diff lane is never re-warmed
   * here (decision ⑥).
   */
  onMirrorUpdated(req: RepoPrewarmRequest): void
  /**
   * A terminal left `cwd` (cd away / terminal closed) and no OTHER live terminal
   * still subscribes it. The coordinator schedules a grace-windowed cancel of the
   * abandoned cwd's background precompute (a quick return aborts it). Optional so
   * tests / callers without the scheduler wired can omit it.
   */
  onCwdDetached?(cwd: string): void
}

interface TerminalEntry {
  terminalId: string
  cwd: string | null
  subscribedCwd: string | null
  lastInfoFingerprint: string | null
}

// Internal short aliases keep existing call sites intact.
const fingerprint = fingerprintTerminalGitInfo
const stateToInfo = mirrorStateToTerminalGitInfo
const emptyInfo = emptyTerminalGitInfo

// Re-export so call sites that already imported from this file keep
// working AND the unit test can import from either location.
export { fingerprintTerminalGitInfo, mirrorStateToTerminalGitInfo, emptyTerminalGitInfo }

export class TerminalGitInfoBridge {
  private entries = new Map<string, TerminalEntry>()
  private disposed = false
  private offMirrorUpdate: (() => void) | null = null
  private offCwdChange: (() => void) | null = null
  // The terminal the renderer last reported as focused. Tracked so a `cd` into a
  // different repo IN the focused terminal re-points the reconcile heartbeat's
  // 1 s focused cadence at the new repo — focus events alone do not fire on `cd`.
  private focusedTerminalId: string | null = null

  constructor(
    private emit: TerminalInfoEmitter,
    /**
     * Repo prewarm hooks. `onCwdAttached` fires on the leading edge of a new cwd
     * (attach); `onMirrorUpdated` fires on every mirror-update (History re-warm
     * on branchOid change). Optional so tests / callers that don't want prewarm
     * can omit it. Fire-and-forget; the coordinator owns dedup + error guards,
     * so neither hook throws back into the emit path.
     */
    private prewarm?: BridgePrewarmHooks
  ) {
    this.offMirrorUpdate = gitStateMirrorRouter.onMirrorUpdate((cwd, state) => {
      this.handleMirrorUpdate(cwd, state)
    })
    this.offCwdChange = gitStateMirrorRouter.onCwdChange((terminalId, _prevCwd, nextCwd) => {
      this.handleCwdChange(terminalId, nextCwd)
    })
  }

  async subscribe(terminalId: string): Promise<void> {
    if (this.disposed) return
    if (this.entries.has(terminalId)) return

    const entry: TerminalEntry = {
      terminalId,
      cwd: null,
      subscribedCwd: null,
      lastInfoFingerprint: null
    }
    this.entries.set(terminalId, entry)

    // Use the cwd OSC has already pushed if available (free, no spawn).
    const cwdFromOsc = gitStateMirrorRouter.getTerminalCwd(terminalId)
    if (cwdFromOsc) {
      entry.cwd = cwdFromOsc
      this.attachMirror(entry, cwdFromOsc)
      return
    }

    // Cold start: terminal exists but OSC hasn't fired yet (raw PTY data
    // not parsed, or shell-integration not installed). One-shot probe —
    // never repeated, never polled. The terminal-cwd cache inside
    // git-utils dedups concurrent callers.
    const cwd = await getTerminalCwd(terminalId).catch(() => null)
    if (this.disposed || !this.entries.has(terminalId)) return
    entry.cwd = cwd
    if (cwd) {
      this.attachMirror(entry, cwd)
    } else {
      // No cwd → emit empty info so renderer state-machine resolves.
      this.tryEmit(entry, emptyInfo(null))
    }
  }

  unsubscribe(terminalId: string): void {
    const entry = this.entries.get(terminalId)
    if (!entry) return
    this.entries.delete(terminalId)
    this.detachMirror(entry)
    // The focused terminal went away — drop the stale focus so the reconcile
    // heartbeat doesn't keep a removed repo on the fast 1 s cadence.
    if (terminalId === this.focusedTerminalId) {
      this.focusedTerminalId = null
      gitStateMirrorRouter.setReconcileFocus(null)
    }
  }

  /**
   * Manual refresh request (e.g. user clicked "refresh" or invoked the
   * GIT_NOTIFY_TERMINAL_GIT_UPDATE IPC). Forces a recompute for the
   * terminal's current cwd. Event-driven — the user's click IS the event.
   */
  notifyTerminalGitUpdate(terminalId: string): void {
    const entry = this.entries.get(terminalId)
    if (!entry || !entry.subscribedCwd) return
    gitStateMirrorRouter.internalForceRecompute(entry.subscribedCwd)
  }

  /**
   * A state-mutating git command (commit / checkout / pull / init / …) just
   * completed in this terminal — the watcher-independent freshness path
   * (2026-07-05 spinner bundles; VS Code's terminal-shell-integration model).
   * Revalidate the terminal's cwd WITHOUT the focus-resync generation bump, so
   * a `git commit` the FS watcher dropped still refreshes the diff list + tab
   * status. `subcommand` is diagnostic; `createsRepo` (init/clone) is served by
   * the worker's recompute-then-reattach path, so no extra flag is needed here.
   */
  notifyTerminalGitCommand(terminalId: string, subcommand: string, createsRepo: boolean): void {
    const entry = this.entries.get(terminalId)
    if (!entry || !entry.subscribedCwd) return
    performanceTrace.record(PERF_TRACE_EVENT.MAIN_GIT_STATE_MIRROR_TERMINAL_GIT_COMMAND, {
      terminalId,
      subcommand,
      createsRepo,
      cwd: entry.subscribedCwd
    })
    gitStateMirrorRouter.revalidateCwd(entry.subscribedCwd, 'terminal-command')
  }

  /**
   * Renderer reported the focused terminal changed. Forward the focused
   * terminal's cwd to the GitStateMirror worker so its always-on reconcile
   * heartbeat polls that repo at the fast (1 s) cadence and the rest at 3 s.
   * Event-driven; no git work here (the worker owns the reconcile).
   */
  notifyFocus(terminalId: string): void {
    this.focusedTerminalId = terminalId
    const entry = this.entries.get(terminalId)
    gitStateMirrorRouter.setReconcileFocus(entry?.subscribedCwd ?? entry?.cwd ?? null)
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    for (const entry of this.entries.values()) {
      this.detachMirror(entry)
    }
    this.entries.clear()
    this.focusedTerminalId = null
    this.offMirrorUpdate?.()
    this.offCwdChange?.()
    this.offMirrorUpdate = null
    this.offCwdChange = null
  }

  // ---------------------------------------------------------------------
  // Internal
  // ---------------------------------------------------------------------

  private attachMirror(entry: TerminalEntry, cwd: string, reason: RepoPrewarmReason = 'attach'): void {
    const subscribedCwd = gitStateMirrorRouter.canonicaliseCwd(cwd)
    const snapshot = gitStateMirrorRouter.internalSubscribe(subscribedCwd)
    entry.subscribedCwd = subscribedCwd
    // Prewarm-on-cwd-switch: the moment a terminal resolves a (new) cwd, front-
    // run the Git Diff + History work the UI would otherwise pay on open. Fired
    // here — the leading edge of attach. The coordinator dedups Diff by cwd and
    // History by cwd::branchOid; if the snapshot has no branchOid yet (cold
    // attach), History waits for the first mirror-update below to carry it.
    this.prewarm?.onCwdAttached({
      cwd: subscribedCwd,
      repoRoot: snapshot?.repoRoot ?? null,
      branchOid: snapshot?.branchOid,
      refsDigest: snapshot?.refsDigest,
      reason
    })
    // Emit immediately if router already had the latest snapshot for this
    // cwd (e.g. another terminal at the same cwd is already subscribed).
    if (snapshot) {
      this.tryEmit(entry, stateToInfo(snapshot, entry.cwd ?? cwd))
    } else {
      // No snapshot yet — emit minimal placeholder so the renderer's
      // subscription resolves rather than hanging on "loading".
      this.tryEmit(entry, emptyInfo(cwd))
    }
  }

  private detachMirror(entry: TerminalEntry): void {
    const detachedCwd = entry.subscribedCwd
    if (detachedCwd) {
      gitStateMirrorRouter.internalUnsubscribe(detachedCwd)
      entry.subscribedCwd = null
      // If no OTHER live terminal is still subscribed to this cwd, it is now
      // abandoned — let the coordinator schedule a grace-period cancel of its
      // background precompute. Skipped on full dispose (reset() handles teardown)
      // and when another terminal keeps the cwd alive (its warm is still useful).
      if (!this.disposed && !this.anyEntrySubscribed(detachedCwd)) {
        this.prewarm?.onCwdDetached?.(detachedCwd)
      }
    }
  }

  /** True when any live terminal entry is currently subscribed to `cwd`. */
  private anyEntrySubscribed(cwd: string): boolean {
    for (const e of this.entries.values()) {
      if (e.subscribedCwd === cwd) return true
    }
    return false
  }

  /**
   * Public liveness probe for the prewarm coordinator (G1): does any live
   * terminal currently subscribe `cwd`? Canonicalises the input so the
   * invalidator's `resolve()`-normalized form matches the bridge's
   * realpath-canonical form on Windows.
   */
  hasSubscribedCwd(rawCwd: string): boolean {
    if (!rawCwd) return false
    return this.anyEntrySubscribed(gitStateMirrorRouter.canonicaliseCwd(rawCwd))
  }

  /** Distinct canonical cwds live terminals subscribe right now (Q1 re-warm). */
  getSubscribedCwds(): string[] {
    const cwds = new Set<string>()
    for (const e of this.entries.values()) {
      if (e.subscribedCwd) cwds.add(e.subscribedCwd)
    }
    return Array.from(cwds)
  }

  private handleMirrorUpdate(cwd: string, state: MirrorState): void {
    if (this.disposed) return
    let matched = false
    for (const entry of this.entries.values()) {
      if (entry.subscribedCwd === cwd) {
        matched = true
        this.tryEmit(entry, stateToInfo(state, entry.cwd ?? cwd))
      }
    }
    // History re-warm on branchOid OR refsDigest change (decision ⑦). The
    // coordinator dedups by cwd::branchOid::refsDigest, so this is a cheap no-op on
    // the common working-tree-edit update and only does real work when a new commit
    // moved HEAD (branchOid) or a push/fetch moved a ref (refsDigest). Gated on
    // `matched` so updates for repos no terminal watches are ignored, and on a
    // non-null branchOid (the History cache's primary freshness key).
    if (matched && state.branchOid) {
      this.prewarm?.onMirrorUpdated({
        cwd,
        repoRoot: state.repoRoot,
        branchOid: state.branchOid,
        refsDigest: state.refsDigest,
        reason: 'branch-change'
      })
    }
  }

  private handleCwdChange(terminalId: string, nextCwd: string | null): void {
    if (this.disposed) return
    const entry = this.entries.get(terminalId)
    if (!entry) return

    // Same cwd? Nothing to do — mirror subscription is unchanged.
    const nextSubscribedCwd = nextCwd ? gitStateMirrorRouter.canonicaliseCwd(nextCwd) : null
    if (entry.subscribedCwd === nextSubscribedCwd) {
      const previousCwd = entry.cwd
      entry.cwd = nextCwd
      if (nextCwd && previousCwd !== nextCwd) {
        const latest = gitStateMirrorRouter.getLatest(nextCwd)
        this.tryEmit(entry, latest ? stateToInfo(latest, nextCwd) : emptyInfo(nextCwd))
      }
      return
    }

    // Detach old, attach new (or empty-info if newCwd is null).
    this.detachMirror(entry)
    entry.cwd = nextCwd
    if (nextCwd) {
      this.attachMirror(entry, nextCwd, 'cwd-change')
    } else {
      this.tryEmit(entry, emptyInfo(null))
    }

    // If this IS the focused terminal, the `cd` just moved its repo. Focus
    // events do not fire on `cd`, so without this the new repo would fall back
    // to the 3 s visible reconcile cadence instead of the advertised 1 s
    // focused cadence. Re-point the heartbeat at the new (or null) repo.
    if (terminalId === this.focusedTerminalId) {
      gitStateMirrorRouter.setReconcileFocus(entry.subscribedCwd ?? entry.cwd ?? null)
    }
  }

  private tryEmit(entry: TerminalEntry, info: TerminalGitInfo): void {
    const fp = fingerprint(info)
    if (fp === entry.lastInfoFingerprint) return
    entry.lastInfoFingerprint = fp
    try {
      this.emit(entry.terminalId, info)
    } catch (error) {
      console.warn('[TerminalGitInfoBridge] emit threw:', error)
    }
  }

  // ---------------------------------------------------------------------
  // Test hooks (read-only)
  // ---------------------------------------------------------------------

  inspect(): { terminals: number; subscribedCwds: string[] } {
    const cwds = new Set<string>()
    for (const entry of this.entries.values()) {
      if (entry.subscribedCwd) cwds.add(entry.subscribedCwd)
    }
    return { terminals: this.entries.size, subscribedCwds: Array.from(cwds) }
  }
}
