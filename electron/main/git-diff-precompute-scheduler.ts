/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

// Eager-prefetch scheduler that fills the per-project diff content cache
// **before** the user clicks any specific file. Driven by the existing
// `gitDiffCacheInvalidator` events (GitStateMirror deltas + manual refresh), so a
// burst of file changes triggers exactly one rebuild rather than a flood.
//
// Lifecycle:
//   - `onProjectInvalidated(project)` is called from the cache invalidator's
//     listener. The scheduler debounces (200ms by default), then asks for
//     the current working set, sorts by `additions + deletions` descending
//     (large files first — biggest perceived win on cache miss), and walks
//     through them with bounded concurrency (3 at a time). Files that
//     exceed the single-file cap are skipped at this stage so they don't
//     starve smaller candidates.
//   - HEAD-change is just another invalidation event from the same source;
//     on receipt we wipe the project bucket (the cache layer does this) and
//     re-precompute the new working set.
//
// What this is NOT: an exhaustive replacement for the renderer's on-click
// fetch. The renderer still goes through the IPC path; this scheduler just
// makes sure that IPC almost always returns a cache hit.

export interface DiffFile {
  filename: string
  additions: number
  deletions: number
  changeType: string
  status: string
  /**
   * Set for renames (status === 'R') and copies (status === 'C'); empty
   * otherwise. Must be propagated through the scheduler so the prewarmed
   * cache key matches the renderer-click cache key — the click path always
   * carries the original filename it received from `getDiff`.
   */
  originalFilename?: string
  isSubmoduleEntry?: boolean
  /** Full path of the repo this file belongs to. May differ from `project`
   * when a parent diff includes submodule files. */
  repoRoot?: string
}

export interface PrecomputeSchedulerOptions {
  /** Max files fetched in parallel. Default 3. */
  concurrency?: number
  /** Debounce window before a precompute burst kicks off. Default 200ms. */
  debounceMs?: number
  /** Hard cap on candidates per burst. Default 50. */
  maxCandidatesPerBurst?: number
  /**
   * How many leading files (in working-set / list order) to warm FIRST, before
   * the size-descending bulk. The Git Diff viewer auto-selects and loads the
   * first file in list order on open, so warming the top-of-list files first
   * makes that first click a cache HIT (and spawns the cat-file batch early)
   * instead of racing the size-sorted bulk that warms small top files last.
   * Default 8 (roughly the first visible page). 0 = pure size-descending.
   */
  viewportPriorityCount?: number
  /**
   * Decides whether a file is eligible (e.g. excludes binary-ish extensions).
   * Mirrors the renderer's `shouldPrefetchFileBody` filter.
   */
  isEligible?: (file: DiffFile) => boolean
  /** Async hook injected by callers — fetches one file's content. */
  fetchFile: (project: string, file: DiffFile) => Promise<void>
  /** Async hook that returns the current working set for a project. */
  loadWorkingSet: (project: string) => Promise<DiffFile[]>
  /** Pluggable timer/clock so tests stay deterministic. */
  timer?: {
    setTimeout: (cb: () => void, ms: number) => unknown
    clearTimeout: (handle: unknown) => void
  }
  /**
   * Optional trace hook fired once per `onProjectInvalidated` call, at the
   * moment a debounced burst is (re)scheduled. Injected — instead of
   * importing performanceTrace — so the scheduler stays a pure,
   * unit-testable leaf. `pendingForMs` is how long the project has already
   * been waiting in the current debounce window (0 on the first schedule,
   * grows across collapsed re-schedules).
   */
  trace?: (payload: { project: string; generation: number; debounceMs: number; pendingForMs: number }) => void
}

interface PendingProject {
  project: string
  /** Timer handle for the debounce window. */
  debounceHandle: unknown
  /** Monotonic burst id used to invalidate any in-flight wave. */
  generation: number
}

const DEFAULT_CONCURRENCY = 3
const DEFAULT_DEBOUNCE_MS = 200
const DEFAULT_MAX_CANDIDATES = 50
const DEFAULT_VIEWPORT_PRIORITY_COUNT = 8

/**
 * Extensions whose diff bodies the viewer renders specially (image/pdf/binary)
 * rather than as text — no point precompute-warming their content.
 */
const PREFETCH_SKIP_EXTENSIONS = new Set<string>([
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'ico', 'bmp', 'tiff',
  'pdf', 'epub',
  'zip', 'tar', 'gz', 'bz2', 'xz', '7z', 'rar',
  'mp3', 'mp4', 'mov', 'avi', 'wav', 'ogg', 'flac',
  'so', 'dll', 'dylib', 'exe', 'class', 'jar',
  'woff', 'woff2', 'ttf', 'otf', 'eot',
  'wasm'
])

/**
 * Whether a changed file should be precompute-warmed. Pure + exported for unit
 * testing.
 *
 * Coverage policy (user directive): pre-cache EVERY visible modification under
 * the project, INCLUDING submodule files. Submodule entries route to their own
 * per-repoRoot bucket and warm just like parent files — so the first click into
 * a submodule file is a cache hit, not a cold read. We still skip files with no
 * readable text body to warm: deleted (`D`) / ignored-removed (`!`), and
 * binary-ish extensions the diff viewer renders specially rather than as text.
 */
export function isPrecomputeEligible(file: DiffFile): boolean {
  if (file.status === 'D' || file.status === '!') return false
  const leaf = file.filename.split(/[\\/]/).pop() ?? file.filename
  const dot = leaf.lastIndexOf('.')
  if (dot <= 0 || dot === leaf.length - 1) return true
  const extension = leaf.slice(dot + 1).toLowerCase()
  return !PREFETCH_SKIP_EXTENSIONS.has(extension)
}

/**
 * Order precompute candidates so the files the user sees first are warmed first.
 *
 * The Git Diff viewer auto-selects and loads the FIRST file (list order) on
 * open. Pure size-descending warming put small top-of-list files LAST, so that
 * first auto-selected file raced (and usually lost to) the user's click → a
 * cold content-cache miss (and the one-time `cat-file --batch` spawn) on the
 * first file every time. Warming the leading `viewportPriorityCount` files in
 * LIST ORDER first, then the rest size-descending, makes the first click a hit
 * while still front-loading the largest remaining diffs (worst-case win).
 *
 * Pure + non-mutating (input array untouched) so it is unit-testable.
 */
export function orderPrecomputeCandidates(eligible: DiffFile[], viewportPriorityCount: number): DiffFile[] {
  const k = Math.max(0, Math.min(viewportPriorityCount, eligible.length))
  const head = eligible.slice(0, k) // list order — the likely first-viewed files
  const tail = eligible
    .slice(k)
    .sort((a, b) => (b.additions + b.deletions) - (a.additions + a.deletions))
  return [...head, ...tail]
}

export interface PrecomputeBurstSummary {
  /** ms epoch when this burst finished. */
  finishedAt: number
  /** Wall-clock cost of the burst, including loadWorkingSet + all fetches. */
  durationMs: number
  /** Total files in the project's changed-file list at burst time. */
  workingSetSize: number
  /** How many of those passed `isEligible` (text, present, non-submodule). */
  eligibleCount: number
  /** min(eligibleCount, maxCandidatesPerBurst) — what actually fed into fetch. */
  candidateCount: number
  /** fetchFile resolved successfully for this many files. */
  completed: number
  /** fetchFile threw (or generation aborted) for this many. */
  skipped: number
}

export interface PrecomputeProjectMeta {
  /** ms epoch the active debounce window started for this project; null if no pending burst. */
  pendingSince: number | null
  /** ms epoch the active burst started; null if no in-flight burst. */
  inFlightSince: number | null
  /** Most recent COMPLETED burst summary; null if the project has never had one. */
  lastBurst: PrecomputeBurstSummary | null
}

export interface PrecomputeStats {
  totalBursts: number
  totalCancelled: number
  totalCompleted: number
  totalSkipped: number
  pendingProjects: string[]
  inFlightProjects: string[]
  /** Per-project debug detail keyed by project root. Only "live" projects appear. */
  perProject: Record<string, PrecomputeProjectMeta>
}

export class GitDiffPrecomputeScheduler {
  private readonly pending = new Map<string, PendingProject>()
  private readonly inFlight = new Map<string, number>()
  private readonly perProjectMeta = new Map<string, PrecomputeProjectMeta>()
  private readonly options: Required<Omit<PrecomputeSchedulerOptions, 'isEligible' | 'timer' | 'trace'>>
    & Pick<PrecomputeSchedulerOptions, 'isEligible' | 'timer' | 'trace'>
  private readonly timer: NonNullable<PrecomputeSchedulerOptions['timer']>
  private readonly stats: Omit<PrecomputeStats, 'pendingProjects' | 'inFlightProjects' | 'perProject'> = {
    totalBursts: 0,
    totalCancelled: 0,
    totalCompleted: 0,
    totalSkipped: 0
  }

  constructor(options: PrecomputeSchedulerOptions) {
    this.options = {
      concurrency: options.concurrency ?? DEFAULT_CONCURRENCY,
      debounceMs: options.debounceMs ?? DEFAULT_DEBOUNCE_MS,
      maxCandidatesPerBurst: options.maxCandidatesPerBurst ?? DEFAULT_MAX_CANDIDATES,
      viewportPriorityCount: options.viewportPriorityCount ?? DEFAULT_VIEWPORT_PRIORITY_COUNT,
      isEligible: options.isEligible,
      timer: options.timer,
      trace: options.trace,
      fetchFile: options.fetchFile,
      loadWorkingSet: options.loadWorkingSet
    }
    this.timer = options.timer ?? {
      setTimeout: (cb, ms) => setTimeout(cb, ms),
      clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>)
    }
  }

  /**
   * Caller-facing entry point. Each call cancels any pending burst for the
   * same project and starts a fresh debounce window. Multiple invalidations
   * during the window collapse into one burst.
   */
  onProjectInvalidated(project: string): void {
    const existing = this.pending.get(project)
    if (existing) this.timer.clearTimeout(existing.debounceHandle)

    const meta = this.ensureMeta(project)
    if (meta.pendingSince === null) {
      meta.pendingSince = Date.now()
    }

    const generation = (existing?.generation ?? 0) + 1
    const handle = this.timer.setTimeout(() => {
      this.pending.delete(project)
      void this.runBurst(project, generation)
    }, this.options.debounceMs)
    this.pending.set(project, { project, debounceHandle: handle, generation })
    // Diagnostic breadcrumb: a user-reported trace must show that an
    // invalidation actually queued a precompute burst (or that it never
    // did). Cadence is bounded by the invalidation rate — well within the
    // trace budget.
    this.options.trace?.({
      project,
      generation,
      debounceMs: this.options.debounceMs,
      pendingForMs: meta.pendingSince === null ? 0 : Math.max(0, Date.now() - meta.pendingSince)
    })
  }

  /**
   * Cancel any pending or in-flight burst for the given project. Used when
   * the project is detached / cwd changes / the cache invalidator says the
   * watcher has been LRU-evicted. Returns true when something was cancelled.
   */
  cancelProject(project: string): boolean {
    let cancelled = false
    const pending = this.pending.get(project)
    if (pending) {
      this.timer.clearTimeout(pending.debounceHandle)
      this.pending.delete(project)
      cancelled = true
    }
    const inFlight = this.inFlight.get(project)
    if (inFlight !== undefined) {
      this.inFlight.set(project, inFlight + 1) // bump generation; runBurst checks this
      cancelled = true
    }
    if (cancelled) {
      this.stats.totalCancelled += 1
      const meta = this.perProjectMeta.get(project)
      if (meta) {
        meta.pendingSince = null
        meta.inFlightSince = null
      }
    }
    return cancelled
  }

  inspectStats(): PrecomputeStats {
    const perProject: Record<string, PrecomputeProjectMeta> = {}
    for (const [project, meta] of this.perProjectMeta) {
      perProject[project] = {
        pendingSince: meta.pendingSince,
        inFlightSince: meta.inFlightSince,
        lastBurst: meta.lastBurst
      }
    }
    return {
      ...this.stats,
      pendingProjects: [...this.pending.keys()],
      inFlightProjects: [...this.inFlight.keys()],
      perProject
    }
  }

  private ensureMeta(project: string): PrecomputeProjectMeta {
    let meta = this.perProjectMeta.get(project)
    if (!meta) {
      meta = { pendingSince: null, inFlightSince: null, lastBurst: null }
      this.perProjectMeta.set(project, meta)
    }
    return meta
  }

  // --- private ---

  private async runBurst(project: string, generation: number): Promise<void> {
    this.stats.totalBursts += 1
    this.inFlight.set(project, generation)
    const startedAt = Date.now()
    const meta = this.ensureMeta(project)
    meta.pendingSince = null
    meta.inFlightSince = startedAt
    let workingSetSize = 0
    let eligibleCount = 0
    let candidateCount = 0
    let burstCompleted = 0
    let burstSkipped = 0
    try {
      const workingSet = await this.options.loadWorkingSet(project)
      workingSetSize = workingSet.length
      if (!this.isCurrent(project, generation)) return

      const eligible = workingSet
        .filter((file) => (this.options.isEligible ? this.options.isEligible(file) : true))
      eligibleCount = eligible.length
      const candidates = orderPrecomputeCandidates(
        eligible,
        this.options.viewportPriorityCount
      ).slice(0, this.options.maxCandidatesPerBurst)
      candidateCount = candidates.length

      // Bounded-concurrency worker loop. Plain index pointer so we don't
      // need to allocate Promises per slot when concurrency is small.
      let cursor = 0
      const workers: Promise<void>[] = []
      const next = async () => {
        while (this.isCurrent(project, generation) && cursor < candidates.length) {
          const file = candidates[cursor++]
          try {
            await this.options.fetchFile(project, file)
            burstCompleted += 1
            this.stats.totalCompleted += 1
          } catch {
            burstSkipped += 1
            this.stats.totalSkipped += 1
          }
        }
      }
      for (let i = 0; i < this.options.concurrency; i += 1) {
        workers.push(next())
      }
      await Promise.all(workers)
    } finally {
      // Only clear in-flight marker if no newer generation has taken over.
      if (this.inFlight.get(project) === generation) {
        this.inFlight.delete(project)
      }
      meta.inFlightSince = null
      const finishedAt = Date.now()
      meta.lastBurst = {
        finishedAt,
        durationMs: Math.max(0, finishedAt - startedAt),
        workingSetSize,
        eligibleCount,
        candidateCount,
        completed: burstCompleted,
        skipped: burstSkipped
      }
    }
  }

  private isCurrent(project: string, generation: number): boolean {
    return this.inFlight.get(project) === generation
  }
}
