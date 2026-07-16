/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Unified modal dismiss policy — pure decision logic.
 *
 * Policy (2026-07-16, user-confirmed):
 * - Modal dialogs (dimmed backdrop + explicit buttons) NEVER dismiss on
 *   backdrop click. Backdrop clicks are inert so a stray click cannot
 *   discard in-progress input (e.g. a half-typed file name).
 * - ESC is the one keyboard path that safely cancels a modal, except
 *   for blocking dialogs that require an explicit choice (ConsentDialog).
 * - Transient surfaces (context menus, dropdowns, popovers, quick-search
 *   palettes) keep the platform convention of closing on outside click.
 */

/** Minimal shape of a keyboard event the cancel predicate needs. */
export interface ModalCancelKeyEvent {
  key: string
  /** True while an IME composition session is active. */
  isComposing?: boolean
}

/**
 * Whether a keydown event should cancel an open modal dialog.
 *
 * ESC pressed during an IME composition only cancels the composition;
 * it must not also cancel the dialog, so composing events are ignored.
 */
export function isModalCancelKey(event: ModalCancelKeyEvent): boolean {
  if (event.isComposing) return false
  return event.key === 'Escape'
}

/**
 * Open-modal registry — ESC layering between modals and subpages.
 *
 * Subpage hosts (Project Editor, Git Diff, Git History, Browser) listen
 * for Escape on the document in the CAPTURE phase (useSubpageEscape), so
 * an app-level modal (tab-close confirm, downsize confirm, …) cannot win
 * by listener ordering: without this registry one ESC would cancel the
 * modal AND close the subpage underneath it. Modals register while open;
 * useSubpageEscape yields as long as any modal is registered.
 */
let openModalCount = 0

export function registerOpenModal(): void {
  openModalCount += 1
}

export function unregisterOpenModal(): void {
  openModalCount = Math.max(0, openModalCount - 1)
}

export function isAnyModalOpen(): boolean {
  return openModalCount > 0
}

/** Test-only: reset the counter between unit-test cases. */
export function resetOpenModalRegistryForTest(): void {
  openModalCount = 0
}
