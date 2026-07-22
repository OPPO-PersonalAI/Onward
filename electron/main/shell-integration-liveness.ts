/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Shell-integration liveness tracker (F2 of the 2026-07 bundle fixes).
 *
 * The 2026-07-17 diagnostic bundles showed a locked-down machine running
 * 8.7 hours with the PowerShell integration script blocked by policy —
 * and NOTHING in the product noticed: no trace signal, no user hint, cwd
 * frozen at the spawn directory the whole session. This tracker closes
 * that hole: every default-shell terminal gets a one-shot timer at spawn;
 * if no SHELL-DERIVED cwd OSC (renderer pushCwd or main-side detectCwd)
 * arrives within the window, the terminal is declared "integration
 * silent" — the callback layer (ipc-handlers) records the trace
 * breadcrumb and shows the user a recovery hint (the manual
 * change-workdir path).
 *
 * VS Code precedent: its shellIntegrationAddon starts a 10 s activation
 * timer and logs `shellIntegrationActivationTimeout`. We use 15 s to leave
 * headroom for EDR-taxed first prompts on corporate Windows machines.
 *
 * Pure + leaf (no Electron, no tracer imports) so the state machine is
 * unit-testable under `node --experimental-strip-types`; timers are
 * injected. Trace emission lives in the wiring site's callbacks.
 */

export const SHELL_INTEGRATION_LIVENESS_WINDOW_MS = 15_000

export type LivenessState = 'waiting' | 'proven' | 'silent' | 'recovered'

export interface LivenessCallbacks {
  /** Fired once when the window elapses with no shell-derived OSC. */
  onSilent: (terminalId: string, shellKind: string, waitedMs: number) => void
  /** Fired once if a shell-derived OSC arrives AFTER onSilent fired. */
  onRecovered: (terminalId: string, sinceSpawnMs: number) => void
}

interface Entry {
  state: LivenessState
  shellKind: string
  startedAtMs: number
  timer: ReturnType<typeof setTimeout> | null
}

type SetTimeoutFn = (fn: () => void, ms: number) => ReturnType<typeof setTimeout>
type ClearTimeoutFn = (t: ReturnType<typeof setTimeout>) => void

export class ShellIntegrationLivenessTracker {
  private entries = new Map<string, Entry>()
  private callbacks: LivenessCallbacks | null = null
  // NOTE: plain fields, not TS parameter properties — the unit test loads
  // this module under `node --experimental-strip-types`, which rejects
  // parameter-property syntax.
  private readonly setTimeoutFn: SetTimeoutFn
  private readonly clearTimeoutFn: ClearTimeoutFn
  private readonly nowFn: () => number

  constructor(
    setTimeoutFn: SetTimeoutFn = (fn, ms) => setTimeout(fn, ms),
    clearTimeoutFn: ClearTimeoutFn = (t) => clearTimeout(t),
    nowFn: () => number = () => Date.now()
  ) {
    this.setTimeoutFn = setTimeoutFn
    this.clearTimeoutFn = clearTimeoutFn
    this.nowFn = nowFn
  }

  setCallbacks(callbacks: LivenessCallbacks | null): void {
    this.callbacks = callbacks
  }

  /**
   * Arm the liveness window for a freshly spawned default-shell terminal.
   * Re-arming an existing id (terminal respawn) resets its state.
   */
  start(terminalId: string, shellKind: string, windowMs: number = SHELL_INTEGRATION_LIVENESS_WINDOW_MS): void {
    this.dispose(terminalId)
    const entry: Entry = {
      state: 'waiting',
      shellKind,
      startedAtMs: this.nowFn(),
      timer: null
    }
    entry.timer = this.setTimeoutFn(() => {
      entry.timer = null
      if (entry.state !== 'waiting') return
      entry.state = 'silent'
      const waitedMs = this.nowFn() - entry.startedAtMs
      try {
        this.callbacks?.onSilent(terminalId, shellKind, waitedMs)
      } catch {
        // Observability plumbing must never throw into the timer loop.
      }
    }, windowMs)
    this.entries.set(terminalId, entry)
  }

  /**
   * A shell-derived cwd OSC arrived for this terminal (renderer pushCwd with
   * an OSC source, or main-side detectCwd). Proves the integration is alive;
   * fires the recovery callback if the terminal had already been declared
   * silent.
   */
  markShellProof(terminalId: string): void {
    const entry = this.entries.get(terminalId)
    if (!entry) return
    if (entry.state === 'waiting') {
      entry.state = 'proven'
      if (entry.timer !== null) {
        this.clearTimeoutFn(entry.timer)
        entry.timer = null
      }
      return
    }
    if (entry.state === 'silent') {
      entry.state = 'recovered'
      try {
        this.callbacks?.onRecovered(terminalId, this.nowFn() - entry.startedAtMs)
      } catch {
        // See onSilent note.
      }
    }
  }

  getState(terminalId: string): LivenessState | null {
    return this.entries.get(terminalId)?.state ?? null
  }

  dispose(terminalId: string): void {
    const entry = this.entries.get(terminalId)
    if (!entry) return
    if (entry.timer !== null) this.clearTimeoutFn(entry.timer)
    this.entries.delete(terminalId)
  }

  disposeAll(): void {
    for (const id of Array.from(this.entries.keys())) this.dispose(id)
  }
}

export const shellIntegrationLiveness = new ShellIntegrationLivenessTracker()
