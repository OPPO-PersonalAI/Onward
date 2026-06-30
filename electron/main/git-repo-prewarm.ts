/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Repo prewarm coordinator (prewarm-on-cwd-switch architecture, decisions ⑥/⑦).
 *
 * Principle (user directive): every expensive git fork the UI would pay on
 * open — the Git Diff list + per-file content, the History list + commit diffs
 * — is done AHEAD of time, the moment the main process resolves a terminal's
 * cwd to a git repo. When the user later opens Diff / History the UI only READS
 * the warm caches; it never recomputes (except a genuine cache miss).
 *
 * Two triggers, two dedup scopes:
 *   - Diff (decision ⑥): warmed on the LEADING edge of `attachMirror` only
 *     (terminal subscribe cold start, or `cd` into a different repo), NEVER on
 *     `handleMirrorUpdate`. Deduped by `cwd` so the diff list + content warm
 *     exactly once per repo per session.
 *   - History (decision ⑦): warmed on attach AND whenever `branchOid` moves (a
 *     new commit / amend / checkout). Deduped by `cwd::branchOid`, so the
 *     coordinator can be pinged on every mirror-update cheaply — it is a no-op
 *     unless branchOid actually changed, which IS the "new commit → recompute
 *     the prewarm set" signal. History needs branchOid for its cache key, so a
 *     cold attach with no branchOid yet skips; the first mirror-update that
 *     carries branchOid warms it.
 *
 * Lanes: the diff-list warm runs in the worker's low-priority `::diff-precompute`
 * lane, the per-file content burst in `::precompute-burst`, and the History
 * prewarm in `::history-precompute` (see `git-ipc-worker-client-helpers.ts` and
 * the worker client), so a foreground enter never queues behind any prewarm.
 *
 * Dependency-injected so the dedup + orchestration logic is unit-testable in
 * plain node without an Electron build or a live worker.
 */

// Explicit `.ts` extension (sanctioned by tsconfig `allowImportingTsExtensions`)
// so the `node --experimental-strip-types` unit-test loader can resolve this
// import; esbuild / electron-vite bundle it the same as any extensionless import.
import { PERF_TRACE_EVENT } from '../../src/utils/perf-trace-names.ts'

export type RepoPrewarmReason = 'attach' | 'cwd-change' | 'branch-change' | 'renderer-fallback'

export interface RepoPrewarmRequest {
  /** Canonicalised cwd the bridge resolved. Doubles as the dedup + content-cache project key. */
  cwd: string
  /** Resolved repo root when the mirror snapshot already had it; null on cold attach. Diagnostic only. */
  repoRoot: string | null
  /**
   * Full HEAD object id from the mirror snapshot. The History cache's freshness
   * key — undefined on a cold attach (mirror not computed yet), in which case
   * the History prewarm is skipped until the first mirror-update carries it.
   */
  branchOid?: string
  /**
   * The mirror snapshot's refsDigest — the History cache's SECOND freshness key
   * (a ref-only move: push/fetch advancing origin/<branch> with HEAD unchanged).
   * Threaded through so the prewarmed key matches the on-demand handler's key
   * exactly (both read the same snapshot); a ref-only move re-warms via the
   * dedup key below. Undefined on a cold attach → `'norefs'` fallback.
   */
  refsDigest?: string
  reason: RepoPrewarmReason
}

export interface RepoPrewarmDeps {
  /** Warm the Diff LIST caches (both `root-only` + `full` scopes) in the worker's low lane. */
  warmDiffList: (cwd: string) => Promise<{ success: boolean }>
  /** Kick the per-file content precompute burst for the given content-cache project key. */
  kickContentPrecompute: (project: string) => void
  /**
   * Cancel the per-file content precompute BURST for a project (the aggressive
   * `::precompute-burst` lane only — the diff-list warm is left alone). Called
   * after a cwd is abandoned for longer than the grace window so a rapid-switch
   * session stops burning EDR-taxed git spawns on repos the user already left.
   * Optional so callers without the scheduler wired keep working.
   */
  cancelContentPrecompute?: (project: string) => void
  /**
   * Warm the History caches (L8 list first page + L9 commit-diff set) for a
   * known branchOid. Optional so callers without History wiring can omit it.
   * Must never reject (the coordinator guards it anyway).
   */
  prewarmHistory?: (cwd: string, repoRoot: string | null, branchOid: string, refsDigest: string | undefined) => Promise<void>
  /** Emit a perf/diagnostic trace event. No-op in tests that don't assert on traces. */
  trace?: (event: string, payload: Record<string, unknown>) => void
  /**
   * Yield-to-foreground delay (ms) inserted AFTER the dedup mark but BEFORE the
   * actual warm, so a foreground Diff/History open in the moments right after a
   * terminal attaches wins the worker (and the EDR-taxed git spawns) instead of
   * racing — and coalescing onto — the low-priority background warm. Default 0
   * (tests run instantly). Production injects a real delay.
   */
  attachDelayMs?: number
  /** Sleep primitive (injected so tests stay instant + deterministic). */
  sleep?: (ms: number) => Promise<void>
  /**
   * Grace window (ms) between a cwd being abandoned (no live terminal subscribes
   * it) and its background precompute being cancelled. A quick A→B→A return
   * within this window aborts the pending cancel, so back-and-forth switching
   * does NOT discard A's half-warmed work. Default 0 (tests cancel synchronously
   * on timer fire); production injects ~2500 ms.
   */
  detachGraceMs?: number
  /** Timer primitives (injected so tests drive the grace window deterministically). */
  setGraceTimer?: (fn: () => void, ms: number) => unknown
  clearGraceTimer?: (handle: unknown) => void
}

export class RepoPrewarmCoordinator {
  // Diff dedup: one warm per cwd per session (decision ⑥).
  private readonly diffPrewarmedCwds = new Set<string>()
  // History dedup: one warm per (cwd, branchOid) — a new commit moves branchOid
  // and re-warms (decision ⑦).
  private readonly historyPrewarmedKeys = new Set<string>()
  private readonly deps: RepoPrewarmDeps
  private readonly attachDelayMs: number
  private readonly sleep: (ms: number) => Promise<void>
  private readonly detachGraceMs: number
  private readonly setGraceTimer: (fn: () => void, ms: number) => unknown
  private readonly clearGraceTimer: (handle: unknown) => void
  // cwd -> grace-timer handle for an abandoned cwd awaiting precompute cancel.
  private readonly pendingDetach = new Map<string, unknown>()

  // NB: explicit field assignment, NOT a TS parameter property — the
  // `node --experimental-strip-types` unit-test loader rejects parameter
  // properties (`constructor(private deps)`) in strip-only mode.
  constructor(deps: RepoPrewarmDeps) {
    this.deps = deps
    this.attachDelayMs = deps.attachDelayMs ?? 0
    this.sleep = deps.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)))
    this.detachGraceMs = deps.detachGraceMs ?? 0
    this.setGraceTimer = deps.setGraceTimer ?? ((fn, ms) => setTimeout(fn, ms))
    this.clearGraceTimer = deps.clearGraceTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>))
  }

  /**
   * Full prewarm for a freshly-resolved cwd (attach). Warms the Diff list +
   * content burst (deduped by cwd) AND the History caches (deduped by
   * cwd::branchOid). Idempotent; never rejects.
   */
  async prewarm(req: RepoPrewarmRequest): Promise<void> {
    const { cwd, repoRoot, reason } = req
    if (!cwd) return

    // The user (re-)entered this cwd — abort any pending grace-cancel so a quick
    // A→B→A return keeps A's in-flight warm instead of discarding then re-warming.
    this.cancelPendingDetach(cwd)

    if (this.diffPrewarmedCwds.has(cwd)) {
      // Dedup hit — this cwd's diff was already warmed this session. Recorded so
      // a "why didn't my repo re-warm after I cd'd back?" trace shows the skip.
      this.deps.trace?.(PERF_TRACE_EVENT.MAIN_GIT_PREWARM_REPO_SKIPPED_DEDUP, { cwd, reason })
    } else {
      this.diffPrewarmedCwds.add(cwd)
      this.deps.trace?.(PERF_TRACE_EVENT.MAIN_GIT_PREWARM_REPO_TRIGGERED, { cwd, repoRoot, reason })
      // Yield to any foreground open racing the attach (see attachDelayMs).
      if (this.attachDelayMs > 0) await this.sleep(this.attachDelayMs)
      // 1. Diff list (both scopes) → low `::diff-precompute` lane.
      const warm = await this.deps.warmDiffList(cwd).catch(() => ({ success: false }))
      // 2. Per-file content burst → low `::precompute-burst` lane. Only when the
      //    list warm succeeded (a non-repo / error cwd has nothing to precompute).
      if (warm.success) {
        this.deps.kickContentPrecompute(cwd)
      }
    }

    // 3. History list + commit-diff set (deduped by cwd::branchOid).
    await this.warmHistory(req)
  }

  /**
   * History-only prewarm. Fired on every mirror-update; the cwd::branchOid
   * dedup makes it a no-op unless a new commit moved branchOid (decision ⑦).
   * Idempotent; never rejects.
   */
  async prewarmHistory(req: RepoPrewarmRequest): Promise<void> {
    if (!req.cwd) return
    await this.warmHistory(req)
  }

  private async warmHistory(req: RepoPrewarmRequest): Promise<void> {
    const { cwd, repoRoot, branchOid, refsDigest } = req
    // History caches key on branchOid; without it we cannot build a freshness-
    // correct key, so skip (a later mirror-update will carry branchOid).
    if (!branchOid || !this.deps.prewarmHistory) return
    // Dedup on cwd::branchOid::refsDigest so a ref-only move (push/fetch → new
    // refsDigest, same HEAD) re-warms the page the on-demand handler will request,
    // instead of being deduped away as already-warm.
    const key = `${cwd}::${branchOid}::${refsDigest ?? 'norefs'}`
    if (this.historyPrewarmedKeys.has(key)) return
    this.historyPrewarmedKeys.add(key)
    // Yield to any foreground History/Diff open racing the attach / branch
    // change before warming (the History prewarm is pure latency optimisation).
    if (this.attachDelayMs > 0) await this.sleep(this.attachDelayMs)
    // Guarded: a History prewarm failure must not abort or surface — the UI
    // falls back to a cache-miss recompute on open.
    await this.deps.prewarmHistory(cwd, repoRoot ?? null, branchOid, refsDigest).catch(() => {})
  }

  /**
   * A terminal LEFT this cwd and no other live terminal still subscribes it, so
   * its background precompute is now wasted work competing for the EDR-taxed git
   * spawn budget. Schedule a grace-windowed cancel: if the user returns within
   * `detachGraceMs`, prewarm() aborts it (no thrash); otherwise the burst is
   * cancelled and the diff dedup is dropped so a later return re-warms cleanly.
   * Idempotent: a second detach for an already-pending cwd is a no-op.
   *
   * "Boost latest cwd" is delivered HERE by contention removal: on an EDR host
   * the bottleneck is total concurrent git spawns through the kernel minifilter,
   * so cancelling the abandoned competitors is what lets the cwd the user landed
   * on warm fastest — the right lever on a spawn-bound host (vs queue reordering).
   */
  onCwdDetached(cwd: string): void {
    if (!cwd) return
    if (this.pendingDetach.has(cwd)) return
    if (this.detachGraceMs <= 0) {
      // No grace window (test default): cancel immediately.
      this.runDetachCancel(cwd)
      return
    }
    const handle = this.setGraceTimer(() => this.runDetachCancel(cwd), this.detachGraceMs)
    this.pendingDetach.set(cwd, handle)
  }

  private runDetachCancel(cwd: string): void {
    this.pendingDetach.delete(cwd)
    this.deps.cancelContentPrecompute?.(cwd)
    // Drop the diff dedup so a later return to this cwd re-warms (the cancelled
    // burst left the content cache partial / cold).
    this.diffPrewarmedCwds.delete(cwd)
    this.deps.trace?.(PERF_TRACE_EVENT.MAIN_GIT_PREWARM_DETACH_CANCELLED, { cwd })
  }

  private cancelPendingDetach(cwd: string): void {
    const handle = this.pendingDetach.get(cwd)
    if (handle === undefined) return
    this.clearGraceTimer(handle)
    this.pendingDetach.delete(cwd)
  }

  /** Test / introspection hook — is a grace-cancel pending for this cwd? */
  hasPendingDetach(cwd: string): boolean {
    return this.pendingDetach.has(cwd)
  }

  /** Test / introspection hook — has this cwd's diff already been prewarmed? */
  hasPrewarmed(cwd: string): boolean {
    return this.diffPrewarmedCwds.has(cwd)
  }

  /** Test / introspection hook — has (cwd, branchOid, refsDigest)'s History already been prewarmed? */
  hasPrewarmedHistory(cwd: string, branchOid: string, refsDigest?: string): boolean {
    return this.historyPrewarmedKeys.has(`${cwd}::${branchOid}::${refsDigest ?? 'norefs'}`)
  }

  /** Drop all dedup state. Called on bridge dispose so a fresh session re-warms. */
  reset(): void {
    this.diffPrewarmedCwds.clear()
    this.historyPrewarmedKeys.clear()
    for (const handle of this.pendingDetach.values()) this.clearGraceTimer(handle)
    this.pendingDetach.clear()
  }
}
