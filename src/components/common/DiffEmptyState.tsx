/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ReactNode } from 'react'
import './DiffEmptyState.css'

interface DiffEmptyStateProps {
  title: string
  description: string
  /** Extra class on the container (e.g. `git-diff-no-selection`) for existing
   *  CSS / test selectors. The shared `diff-empty-state` class owns the layout. */
  className?: string
  /** Optional extra content rendered below the description (e.g. a copy toast). */
  children?: ReactNode
}

/**
 * Shared "no file selected" empty state for the Git History and Git Diff diff
 * panes. Renders a double-document compare glyph (red "−" over green "+") plus a
 * title and description, inviting the user to click a file rather than paying a
 * heavy diff render on entry. Purely presentational (no state, no side effects)
 * so both surfaces stay a single, drift-free source of truth for the design.
 */
export function DiffEmptyState({ title, description, className, children }: DiffEmptyStateProps) {
  return (
    <div className={className ? `diff-empty-state ${className}` : 'diff-empty-state'}>
      <svg
        className="diff-empty-state-icon"
        viewBox="0 0 48 48"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.4"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <rect x="8" y="9" width="18" height="24" rx="3" opacity="0.55" />
        <rect x="20" y="15" width="18" height="24" rx="3" fill="var(--panel)" />
        <line x1="24.5" y1="24" x2="34" y2="24" stroke="var(--danger)" />
        <line x1="24.5" y1="31" x2="34" y2="31" stroke="var(--success)" />
        <line x1="29" y1="27.5" x2="29" y2="34.5" stroke="var(--success)" />
      </svg>
      <div className="diff-empty-state-title">{title}</div>
      <div className="diff-empty-state-desc">{description}</div>
      {children}
    </div>
  )
}
