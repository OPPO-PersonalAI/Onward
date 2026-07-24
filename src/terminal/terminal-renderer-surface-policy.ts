/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 *
 * Pure decision table for what a host-surface event (document-visible /
 * window-focus / page-show) should do to a terminal's renderer. Kept free
 * of xterm / DOM imports so the Node unit-test layer can exercise every
 * branch directly (see test/unittest/terminal-renderer-surface-policy.test.mts).
 *
 * Design contract (peer-aligned, 2026-07-13): WebGL contexts are KEPT ALIVE
 * across window occlusion — matching VS Code and native GPU terminals
 * (Alacritty / WezTerm / Ghostty / iTerm2), which pause rendering but never
 * tear down GPU resources on occlusion. A surface event on a live addon
 * therefore only needs a viewport refresh; it must NOT clear the shared
 * glyph texture atlas. clearTextureAtlas() on restore was the amplifier
 * behind the "all terminals white for 1-3s after Space switch-back"
 * regression: 6 panes share one atlas, and the per-owner model-epoch patch
 * (f05fe9b) correctly broadcasts every clear to every owner — so N clears
 * per restore batch forced O(N^2) full-viewport rebuilds while the
 * compositor had no committed frame to show.
 */

export type SurfaceRestoreAction =
  | 'refresh-only'
  | 'recreate-webgl'
  | 'defer-context-lost'
  | 'defer-cooldown'

export interface SurfaceRestoreState {
  /** A WebglAddon instance is currently loaded on the terminal. */
  webglActive: boolean
  /** Our webglcontextlost listener fired and the loss is still unresolved. */
  contextLost: boolean
  /** Repeated WebGL failures put this terminal in the fallback cooldown window. */
  cooldownActive: boolean
}

/**
 * Decide the restore action for one terminal on a host-surface event.
 *
 * - Live addon → refresh only. The GL context and glyph atlas are intact;
 *   re-issuing draw calls recommits the compositor tile. Never clear the
 *   shared atlas here.
 * - Addon gone + context still lost → defer. A brand-new addon handed a
 *   dead context silently no-ops every draw call (lessons 2026-04-30).
 * - Addon gone + cooldown active → defer. The context-loss fallback keeps
 *   DOM rendering until the cooldown expires.
 * - Addon gone, healthy → recreate WebGL and refresh so the new canvas
 *   paints the live buffer instead of staying empty.
 */
export function decideSurfaceRestoreAction(state: SurfaceRestoreState): SurfaceRestoreAction {
  if (state.webglActive) return 'refresh-only'
  if (state.contextLost) return 'defer-context-lost'
  if (state.cooldownActive) return 'defer-cooldown'
  return 'recreate-webgl'
}

/**
 * Decide what document-hidden (window occluded / Space switched away) does
 * to visible terminals' renderers. Always 'keep-alive': rendering pauses via
 * Chromium's own background rAF throttling; GPU resources stay owned so the
 * switch-back has a warm atlas and an intact context. Genuine GPU
 * reclamation while hidden surfaces as webglcontextlost and takes the
 * context-loss fallback path instead.
 *
 * Kept as a function (not a constant) so the contract has a single named,
 * unit-tested decision point the lifecycle wires against — and so a future
 * platform-conditional exception has exactly one place to land.
 */
export function decideDocumentHiddenAction(): 'keep-alive' {
  return 'keep-alive'
}

/**
 * Session-scoped GPU-crash fuse (BUG-0003 batch 2, VS Code-aligned
 * WebGL→DOM ladder): after this many GPU-process crashes in one app
 * session, terminals stick to the DOM renderer for the rest of the
 * session. One crash gets the automatic WebGL recovery a chance to work;
 * a second crash means this GPU/driver session is hostile — trading
 * scroll throughput for "never garbles again" is the right default.
 * N=2 was an explicit product decision (2026-07-23); Chromium's own
 * crash-limit fallback (~3 crashes → software raster) sits behind it.
 */
export const GPU_CRASH_STICKY_FALLBACK_THRESHOLD = 2

export function shouldStickToDomAfterGpuCrash(sessionCrashCount: number): boolean {
  return sessionCrashCount >= GPU_CRASH_STICKY_FALLBACK_THRESHOLD
}
