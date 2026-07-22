/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Group filter for the pdf-epub-preview autotest.
 *
 * The preview suite covers BOTH the PDF reader (open / iframe / shortcuts /
 * outline / view-state) and the EPUB reader (toc / content / outline / font /
 * search) in one long sequential flow. Its regression override sat at 900 s —
 * far above the 5-minute per-runner budget — purely as line-count paranoia
 * (measured 2026-07-22: 30.7 s locally). Per the split-on-budget hard rule
 * the suite is partitioned into a `group=pdf` runner and a `group=epub`
 * runner; `all` preserves the original combined behaviour for standalone /
 * umbrella runs.
 *
 * The token rides the same `ONWARD_AUTOTEST_SUITE` string convention as the
 * subpage-navigation split (e.g. `pdf-epub-preview;group=pdf`).
 */

/**
 * Three-way partition (not two): the historical override comment records the
 * EDR-taxed host completing only 88 assertions in 600 s — a ~20× tax over the
 * local 30.7 s. Halving would leave the PDF half at ~300+ s on that host;
 * thirds land each group at a comfortable ≤ ~240 s worst case.
 *   'pdf'         PDF preview + iframe + keyboard-shortcut forwarding
 *   'pdf-outline' outlined-PDF fixture + OutlinePanel + view-state memory
 *   'epub'        the EPUB reader sections
 */
export type PdfEpubPreviewGroup = 'pdf' | 'pdf-outline' | 'epub' | 'all'

/** Parse the `group=` token from the autotest suite string. Defaults to `all`. */
export function parsePdfEpubPreviewGroup(suite: string | null | undefined): PdfEpubPreviewGroup {
  // Alternation is longest-first so 'pdf' cannot prefix-match 'pdf-outline'.
  const match = (suite ?? '').match(/(?:^|;|,)group=(pdf-outline|pdf|epub|all)(?:;|,|$)/i)?.[1]?.toLowerCase()
  if (match === 'pdf' || match === 'pdf-outline' || match === 'epub') return match
  return 'all'
}
