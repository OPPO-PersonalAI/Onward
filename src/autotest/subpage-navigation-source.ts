/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Source filter for the subpage-navigation autotest.
 *
 * The HTML group runs a COLD and a WARM round-trip for BOTH the git-diff and
 * git-history entry points (4 heavy 5-trial blocks). Run end-to-end that
 * exceeds the regression's 180 s per-suite budget (~242 s observed), so the
 * suite is split by source: a `source=diff` runner and a `source=history`
 * runner each execute one COLD + one WARM block (~120 s), landing well under
 * budget. `all` preserves the original combined behaviour for a standalone run.
 *
 * The token rides the same `ONWARD_AUTOTEST_SUITE` string as `group=`
 * (e.g. `subpage-navigation;group=html;source=diff`).
 */

export type NavigationSourceFilter = 'diff' | 'history' | 'all'
export type NavigationSource = 'diff' | 'history'

/** Parse the `source=` token from the autotest suite string. Defaults to `all`. */
export function parseNavigationSourceFilter(suite: string | null | undefined): NavigationSourceFilter {
  const match = (suite ?? '').match(/(?:^|;)source=(diff|history|all)(?:;|$)/i)?.[1]?.toLowerCase()
  if (match === 'diff' || match === 'history') return match
  return 'all'
}

/** Expand a source filter into the concrete list of sources to iterate. */
export function navigationSourcesFor(filter: NavigationSourceFilter): NavigationSource[] {
  if (filter === 'diff') return ['diff']
  if (filter === 'history') return ['history']
  return ['diff', 'history']
}
