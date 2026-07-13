/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

import { PERF_TRACE_EVENT } from './perf-trace-names'

const INPUT_TRACE_RATE_LIMIT_PER_SECOND = 60

let installed = false
let inputTraceWindowStart = 0
let inputTraceCount = 0

type TracePayload = Record<string, unknown>

function isPerfTraceEnabled(): boolean {
  return Boolean(window.electronAPI?.debug?.perfTraceEnabled)
}

export function perfTrace(event: string, data?: TracePayload): void {
  if (!isPerfTraceEnabled()) return
  try {
    window.electronAPI.debug.perfTrace(event, data)
  } catch {
    // ignore
  }
}

/**
 * Diagnostic-tier trace emit — default-ON in production (opt-out via
 * ONWARD_PERF_TRACE=0), unlike perfTrace() above which is opt-in
 * (ONWARD_PERF_TRACE=1) because component-level tracing can flood the
 * renderer. Reserve this for low-frequency, user-action-scale breadcrumbs
 * (page opens, open-phase spans) that a user's production diagnostic
 * bundle must contain: the 2026-07-04 "Git Diff spins 16 s" bundle had
 * zero renderer-side git-diff events precisely because everything rode
 * the opt-in channel. The preload side enforces the gate.
 */
export function perfTraceDiagnostic(event: string, data?: TracePayload): void {
  try {
    window.electronAPI?.debug?.perfTraceDiagnostic?.(event, data)
  } catch {
    // ignore
  }
}

/**
 * Record a trace event on the per-Task virtual tid. Use this for every
 * hop in the PTY input/output data flow so the same `terminalId` lines
 * up on one Perfetto row across scheduler, xterm, and xterm-write
 * events. Main-side peers (pty-manager, ipc-handlers) emit onto the
 * mirror `tid` on pid=1, so a Task's lifetime is readable end-to-end
 * without cross-referencing.
 */
export function perfTraceTask(event: string, data: TracePayload | undefined, terminalId: string): void {
  if (!isPerfTraceEnabled()) return
  try {
    window.electronAPI.debug.perfTrace(event, data, terminalId)
  } catch {
    // ignore
  }
}

function canTraceInput(now: number): boolean {
  if (now - inputTraceWindowStart >= 1000) {
    inputTraceWindowStart = now
    inputTraceCount = 0
  }
  inputTraceCount += 1
  return inputTraceCount <= INPUT_TRACE_RATE_LIMIT_PER_SECOND
}

function normalizeEventTimestamp(eventTimestamp: number, now: number): number {
  if (!Number.isFinite(eventTimestamp)) return now
  if (eventTimestamp > 1_000_000_000_000) {
    return eventTimestamp - performance.timeOrigin
  }
  return eventTimestamp
}

function getPromptInputTarget(target: EventTarget | null): HTMLInputElement | HTMLTextAreaElement | null {
  if (!(target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement)) return null
  if (target.classList.contains('prompt-editor-content')) return target
  if (target.classList.contains('prompt-editor-title')) return target
  return null
}

function getPromptInputKind(target: HTMLElement): string {
  if (target.classList.contains('prompt-editor-content')) return 'content'
  if (target.classList.contains('prompt-editor-title')) return 'title'
  return target.tagName.toLowerCase()
}

function installPromptInputTrace(): void {
  document.addEventListener('input', (event) => {
    const target = getPromptInputTarget(event.target)
    if (!target) return

    const receivedAt = performance.now()
    if (!canTraceInput(receivedAt)) return

    const eventTimestamp = normalizeEventTimestamp(event.timeStamp, receivedAt)
    const eventQueueMs = Math.max(0, receivedAt - eventTimestamp)
    const targetKind = getPromptInputKind(target)
    const valueLength = target.value.length
    const selectionStart = target.selectionStart
    const hasContextMenu = Boolean(document.querySelector('.prompt-context-menu'))

    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        const paintedAt = performance.now()
        perfTrace(PERF_TRACE_EVENT.RENDERER_PROMPT_INPUT_PAINT, {
          targetKind,
          valueLength,
          selectionStart,
          hasContextMenu,
          eventQueueMs: +eventQueueMs.toFixed(1),
          handlerToPaintMs: +(paintedAt - receivedAt).toFixed(1),
          eventToPaintMs: +(paintedAt - eventTimestamp).toFixed(1)
        })
      })
    })
  }, true)
}

function installRendererStallTrace(): void {
  const intervalMs = 250
  const stallThresholdMs = 100
  let expectedAt = performance.now() + intervalMs

  window.setInterval(() => {
    const now = performance.now()
    const driftMs = now - expectedAt
    expectedAt = now + intervalMs
    if (driftMs >= stallThresholdMs) {
      perfTrace(PERF_TRACE_EVENT.RENDERER_EVENT_LOOP_STALL, {
        driftMs: +driftMs.toFixed(1),
        intervalMs,
        hasPromptFocus: Boolean(document.activeElement?.classList.contains('prompt-editor-content')),
        hasContextMenu: Boolean(document.querySelector('.prompt-context-menu'))
      })
    }
  }, intervalMs)

  let lastFrameAt = performance.now()
  const frameThresholdMs = 100
  const tick = () => {
    const now = performance.now()
    const deltaMs = now - lastFrameAt
    lastFrameAt = now
    if (deltaMs >= frameThresholdMs) {
      perfTrace(PERF_TRACE_EVENT.RENDERER_FRAME_STALL, {
        frameDeltaMs: +deltaMs.toFixed(1),
        hasPromptFocus: Boolean(document.activeElement?.classList.contains('prompt-editor-content')),
        hasContextMenu: Boolean(document.querySelector('.prompt-context-menu'))
      })
    }
    requestAnimationFrame(tick)
  }
  requestAnimationFrame(tick)
}

function installLongTaskTrace(): void {
  if (!('PerformanceObserver' in window)) return
  const supportedEntryTypes = PerformanceObserver.supportedEntryTypes ?? []
  if (!supportedEntryTypes.includes('longtask')) return

  try {
    const observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        perfTrace(PERF_TRACE_EVENT.RENDERER_LONGTASK, {
          name: entry.name,
          startTimeMs: +entry.startTime.toFixed(1),
          durationMs: +entry.duration.toFixed(1),
          hasPromptFocus: Boolean(document.activeElement?.classList.contains('prompt-editor-content')),
          hasContextMenu: Boolean(document.querySelector('.prompt-context-menu'))
        })
      }
    })
    observer.observe({ entryTypes: ['longtask'] })
  } catch {
    // ignore
  }
}

// Window-level visibility/focus events ride the DIAGNOSTIC tier: they fire
// at user-action frequency (a handful per Space switch), and a production
// diagnostic bundle without them cannot answer "did the app see the
// occlusion, and when did it come back?" — the 2026-07-13 Space-switch
// white-flash bundle had zero renderer visibility breadcrumbs precisely
// because these rode the opt-in channel.
function installWindowEventTrace(): void {
  document.addEventListener('visibilitychange', () => {
    perfTraceDiagnostic(PERF_TRACE_EVENT.RENDERER_WINDOW_VISIBILITY_CHANGE, {
      state: document.visibilityState,
      hidden: document.hidden
    })
  })
  window.addEventListener('focus', () => {
    perfTraceDiagnostic(PERF_TRACE_EVENT.RENDERER_WINDOW_FOCUS, {
      hasContextMenu: Boolean(document.querySelector('.prompt-context-menu'))
    })
  })
  window.addEventListener('blur', () => {
    perfTraceDiagnostic(PERF_TRACE_EVENT.RENDERER_WINDOW_BLUR, {
      hasContextMenu: Boolean(document.querySelector('.prompt-context-menu'))
    })
  })
  window.addEventListener('pagehide', (event) => {
    perfTraceDiagnostic(PERF_TRACE_EVENT.RENDERER_WINDOW_PAGEHIDE, {
      persisted: event.persisted
    })
  })
}

export function installRendererPerfTrace(): void {
  if (installed) return
  installed = true
  // Diagnostic-tier listeners install unconditionally so production
  // bundles carry visibility/focus breadcrumbs; the preload side enforces
  // the ONWARD_PERF_TRACE=0 opt-out.
  installWindowEventTrace()
  if (!isPerfTraceEnabled()) return
  perfTrace(PERF_TRACE_EVENT.RENDERER_TRACE_START, {
    userAgent: navigator.userAgent,
    url: window.location.href
  })
  installPromptInputTrace()
  installRendererStallTrace()
  installLongTaskTrace()
}
