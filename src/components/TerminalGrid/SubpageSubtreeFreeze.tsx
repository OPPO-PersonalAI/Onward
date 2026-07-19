/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

import { useRef, type ReactElement } from 'react'
import { perfTrace } from '../../utils/perf-trace'
import { PERF_TRACE_EVENT } from '../../utils/perf-trace-names'

interface SubpageSubtreeFreezeProps {
  /** Panel identity for the freeze/unfreeze trace breadcrumb. */
  panel: 'editor' | 'diff' | 'history'
  /** Freeze while the panel is soft-closed (mounted but hidden). */
  frozen: boolean
  children: ReactElement
}

/**
 * Element-identity freeze for soft-closed subpage panels.
 *
 * The three subpage panels (Project Editor / Git Diff / Git History) stay
 * mounted after close so reopen is instant. The cost: every TerminalGrid
 * re-render reconciles their full subtree — for a Project Editor holding a
 * huge outline that is seconds of wasted work per pass. While `frozen`, this
 * wrapper returns the SAME element it captured when the panel closed; React
 * bails out of reconciling a child whose element identity (and therefore
 * props identity) is unchanged, so the hidden subtree is skipped entirely.
 * The panel's own internal state updates and context changes still render it
 * — only parent-driven churn is cut.
 *
 * On unfreeze the freshly-passed children (with current props) are used, so
 * the reopening render sees the latest open request / navigation target.
 */
export function SubpageSubtreeFreeze({ panel, frozen, children }: SubpageSubtreeFreezeProps) {
  const cachedRef = useRef<ReactElement | null>(null)
  const lastFrozenRef = useRef<boolean | null>(null)

  const frozenFlipped = lastFrozenRef.current !== frozen
  if (frozenFlipped) {
    lastFrozenRef.current = frozen
    perfTrace(PERF_TRACE_EVENT.RENDERER_TERMINAL_GRID_SUBPAGE_FREEZE, {
      ph: 'i',
      panel,
      frozen
    })
  }

  // The render on which `frozen` flips true MUST pass the fresh children
  // through: that element carries the closing props (isOpen=false), and the
  // panel needs to see them to run its soft-close path. Only renders AFTER
  // the flip reuse the cached element and bail out reconciliation.
  if (!frozen || frozenFlipped || cachedRef.current === null) {
    cachedRef.current = children
  }
  return cachedRef.current
}
