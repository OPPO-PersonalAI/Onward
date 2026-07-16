/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Shared autotest probe utilities for the GitStateMirror refactor.
 *
 * The implementations are written as a "red baseline": fixture loading and
 * DOM colour reads work today, but anything that requires the worker / OSC
 * parser / mirror IPC throws PENDING_COMMIT_<N> until the corresponding
 * commit lands. The naming makes the trace log self-documenting — a failed
 * assertion's `reason` field tells the reader exactly which commit is the
 * gating dependency.
 *
 * Consumers:
 *   - src/autotest/test-git-state-mirror-latency.ts (GSM-01..31)
 *   - src/autotest/test-git-diff-staleness-and-submodule.ts (GDS-31..42)
 *
 * NOTE: `mutate` deliberately does NOT touch the user's home / desktop /
 * system paths — every state-change helper expects a path that already lives
 * inside `manifest.tempRoot`. The runner extracts each fixture tarball into
 * a `mktemp -d` dir per run; tests consume those copies and treat the
 * committed tarballs in `test/autotest/fixtures/git-state-mirror-latency/`
 * as read-only source of truth.
 */

// Sentinel error class so test sources can distinguish "deferred — wait for
// commit N" from a genuine assertion failure when interpreting the trace.
export class PendingCommitError extends Error {
  constructor(public readonly commit: number, public readonly note: string) {
    super(`PENDING_COMMIT_${commit}: ${note}`)
    this.name = 'PendingCommitError'
  }
}

export interface MirrorFixtureRepo {
  name: string
  branch: string | null
  expectedStatus: 'clean' | 'modified' | 'added' | 'deleted' | 'mixed' | 'unknown'
}

export interface MirrorFixtureManifest {
  tempRoot: string
  repos: MirrorFixtureRepo[]
}

interface ManifestRaw {
  tempRoot?: string
  repos?: MirrorFixtureRepo[]
}

function dirname(path: string): string {
  const cleaned = path.replace(/[\\/]+$/, '')
  const idx = Math.max(cleaned.lastIndexOf('/'), cleaned.lastIndexOf('\\'))
  return idx >= 0 ? cleaned.slice(0, idx) : cleaned
}

function lastSegment(path: string): string {
  const cleaned = path.replace(/[\\/]+$/, '')
  const idx = Math.max(cleaned.lastIndexOf('/'), cleaned.lastIndexOf('\\'))
  return idx >= 0 ? cleaned.slice(idx + 1) : cleaned
}

/**
 * Read the per-run manifest the runner injected into the fixture temp dir.
 * The runner copies the committed manifest, adds `tempRoot`, and writes back
 * to the staging dir. We read THAT version so every repo entry is reachable
 * via `${tempRoot}/${repo.name}/`.
 */
export async function loadMirrorFixtureManifest(): Promise<MirrorFixtureManifest | null> {
  const extraPath = window.electronAPI.debug.autotestFixtureExtra
  if (!extraPath) return null
  const root = dirname(extraPath)
  const file = lastSegment(extraPath)
  const result = await window.electronAPI.project.readFile(root, file)
  if (!result.success || typeof result.content !== 'string') return null
  try {
    const raw = JSON.parse(result.content) as ManifestRaw
    if (typeof raw.tempRoot !== 'string' || !Array.isArray(raw.repos)) return null
    return { tempRoot: raw.tempRoot, repos: raw.repos as MirrorFixtureRepo[] }
  } catch {
    return null
  }
}

/**
 * Resolve a repo entry from the manifest by canonical name.
 */
export function resolveFixtureRepo(
  manifest: MirrorFixtureManifest,
  name: string
): { abs: string; entry: MirrorFixtureRepo } | null {
  const entry = manifest.repos.find((r) => r.name === name)
  if (!entry) return null
  const sep = manifest.tempRoot.includes('\\') ? '\\' : '/'
  const abs = `${manifest.tempRoot.replace(/[\\/]+$/, '')}${sep}${entry.name}`
  return { abs, entry }
}

/**
 * Mutate fixtures via the existing project / git IPCs. Each helper takes
 * an absolute repo path (resolved through the manifest) so the test can
 * never accidentally write outside the staging dir.
 */
export const mutate = {
  async modifyFile(repoAbs: string, relPath: string, content: string): Promise<void> {
    await window.electronAPI.git.saveFileContent(repoAbs, relPath, content)
  },
  async createUntrackedFile(repoAbs: string, relPath: string, content: string): Promise<void> {
    await window.electronAPI.project.createFile(repoAbs, relPath, content)
  },
  async deleteFile(repoAbs: string, relPath: string): Promise<void> {
    await window.electronAPI.project.deletePath(repoAbs, relPath)
  }
}

/**
 * Read the colour-class encoded on the active terminal's branch chip.
 * Returns one of the six canonical states; null when the chip is absent
 * (e.g. cwd outside a git repo / overlay subpage covering the terminal).
 * The chip carries exactly one state class, so the checks are mutually
 * exclusive and the order is only a fall-through to 'clean'.
 */
export function captureColorClass(
  terminalId: string
): 'clean' | 'modified' | 'added' | 'deleted' | 'mixed' | 'unknown' | null {
  const cell = document.querySelector(`.terminal-grid-cell[data-terminal-id="${terminalId}"]`)
  if (!cell) return null
  const chip = cell.querySelector('.terminal-grid-branch')
  if (!chip) return null
  if (chip.classList.contains('terminal-grid-branch--modified')) return 'modified'
  if (chip.classList.contains('terminal-grid-branch--added')) return 'added'
  if (chip.classList.contains('terminal-grid-branch--deleted')) return 'deleted'
  if (chip.classList.contains('terminal-grid-branch--mixed')) return 'mixed'
  if (chip.classList.contains('terminal-grid-branch--unknown')) return 'unknown'
  return 'clean'
}

/**
 * Read the visible branch text on the active terminal's chip.
 */
export function captureBranchText(terminalId: string): string | null {
  const cell = document.querySelector(`.terminal-grid-cell[data-terminal-id="${terminalId}"]`)
  if (!cell) return null
  const chip = cell.querySelector('.terminal-grid-branch')
  return chip?.textContent?.trim() || null
}

/**
 * Read the cwd displayed above a Task. The title attribute carries the full
 * cwd even when the adaptive header collapses the visible label.
 */
export function captureCwdTitle(terminalId: string): string | null {
  const cell = document.querySelector(`.terminal-grid-cell[data-terminal-id="${terminalId}"]`)
  if (!cell) return null
  const cwd = cell.querySelector('.terminal-grid-adaptive-cwd') as HTMLElement | null
  return cwd?.getAttribute('title')?.trim() || cwd?.textContent?.trim() || null
}

// ---------------------------------------------------------------------------
// Below this line: pending implementations that depend on commits 3 / 4 / 8 /
// 9 / 10. They throw PendingCommitError so the GSM / GDS test sources can
// catch and record `{ reason: 'PENDING_COMMIT_<N>' }` in the failing
// assertion's detail. This makes the red baseline self-explanatory.
// ---------------------------------------------------------------------------

export interface LatencySampleOptions {
  startEvent: string
  endEvent: string
  thresholdMs: number
  samples?: number
  /** Filter trace events by this terminalId / cwd if applicable. */
  match?: (payload: Record<string, unknown>) => boolean
}

/**
 * Sample N latency observations from the perf-trace stream and return the
 * p95 between matching `startEvent` and `endEvent` markers.
 *
 * Pending: needs commit 2 (perf-trace event registration) + a renderer-side
 * trace reader that doesn't go back through main IPC for sub-50ms accuracy.
 */
export async function waitForLatency(_opts: LatencySampleOptions): Promise<{ p95Ms: number; samples: number[] }> {
  throw new PendingCommitError(2, 'waitForLatency requires perf-trace event registration (commit 2) + renderer-fast-path recorder (commit 6).')
}

/**
 * Inject raw OSC bytes directly into a terminal's PTY data path so tests can
 * cover OSC 1337 / OSC 9;9 etc. without needing the corresponding shell
 * available in CI.
 *
 * Pending: needs commit 9 (xterm.js OSC parser addon + an autotest-only IPC
 * to splice bytes into the renderer's terminal stream).
 */
export const mockPty = {
  async emitRaw(_terminalId: string, _bytes: Uint8Array | string): Promise<void> {
    throw new PendingCommitError(9, 'mockPty.emitRaw requires the OSC parser addon and an autotest splice IPC.')
  }
}

/**
 * Force-kill the git-state-mirror Worker Thread and verify main respawns it
 * within `withinMs`. Pending until commit 3 ships the worker entry.
 */
export async function killWorkerAndWaitForRespawn(_withinMs: number): Promise<{ recoveredMs: number }> {
  throw new PendingCommitError(3, 'killWorkerAndWaitForRespawn requires the git-state-mirror worker (commit 3) and respawn supervisor.')
}

/**
 * Renderer-side fast-path perf record (does NOT go through main IPC). Used
 * by tests that need accurate sub-frame latency measurements.
 *
 * Pending: needs commit 2 to wire up the renderer-side ring buffer the
 * runner can drain at the end of a session.
 */
export function recordRendererPerf(_name: string, _payload?: Record<string, unknown>): void {
  // Soft-fail: no-op until commit 2 wires the recorder. Tests that need it
  // will still observe the missing data and FAIL with PENDING_COMMIT_2.
}

/**
 * Subscribe to the GitStateMirror via the IPC bridge. Returns the initial
 * snapshot (or null) AND an `unsubscribe` function so the caller can stop
 * receiving deltas. Use `onMirrorUpdate(...)` separately to listen for the
 * stream of incremental updates.
 *
 * This is the real implementation now that commit 3+ have shipped the
 * router and IPC channels.
 */
export async function subscribeMirror(cwd: string): Promise<{
  initial: unknown | null
  unsubscribe: () => void
  onUpdate: (cb: (cwd: string, delta: unknown) => void) => () => void
}> {
  const api = window.electronAPI?.git
  if (!api?.subscribeMirror || !api?.unsubscribeMirror || !api?.onMirrorUpdate) {
    throw new PendingCommitError(3, 'GitAPI.subscribeMirror / onMirrorUpdate missing — preload bridge not yet exposed.')
  }
  const result = await api.subscribeMirror(cwd)
  const initial = (result as { snapshot?: unknown } | null)?.snapshot ?? null
  const onUpdate = (cb: (cwd: string, delta: unknown) => void) => api.onMirrorUpdate(cb)
  return {
    initial,
    onUpdate,
    unsubscribe: () => {
      try { api.unsubscribeMirror(cwd) } catch { /* tolerate */ }
    }
  }
}

/**
 * Synthesise an OSC cwd push as if a real shell had just emitted OSC 633 /
 * OSC 7. Dispatches BOTH the local `'onward:terminal-cwd-detected'` event
 * (so TerminalGrid's local map updates synchronously) AND the IPC push
 * (so the worker switches its watcher root + recomputes).
 */
export async function pushOscCwd(terminalId: string, newCwd: string): Promise<void> {
  const api = window.electronAPI?.git
  if (!api?.pushCwd) {
    throw new PendingCommitError(3, 'GitAPI.pushCwd missing — preload bridge not yet exposed.')
  }
  try {
    window.dispatchEvent(new CustomEvent('onward:terminal-cwd-detected', {
      detail: { terminalId, cwd: newCwd }
    }))
  } catch { /* ignore */ }
  api.pushCwd(terminalId, newCwd)
}

/**
 * Imperative one-shot read of the latest mirror snapshot for a cwd, no
 * subscription required. Useful for "current state" assertions where the
 * test doesn't need to listen to subsequent deltas.
 */
export async function getMirror(cwd: string): Promise<unknown | null> {
  const api = window.electronAPI?.git
  if (!api?.getMirror) {
    throw new PendingCommitError(3, 'GitAPI.getMirror missing — preload bridge not yet exposed.')
  }
  return api.getMirror(cwd)
}
