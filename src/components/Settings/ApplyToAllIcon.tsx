/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Icon for the "apply this value to all terminals" action.
 *
 * Geometry: a downward arrow pressing into a two-bar stack. The arrow supplies the
 * direction ("push this outward"), the stack supplies the plurality ("into every
 * terminal"). Both signals are needed — an arrow alone reads as download/import, and
 * a stack alone reads as a list.
 *
 * Why not a circle: the previous icon was a circle with a partial fill, which lands
 * squarely in radio-button / checkbox shape space. Concentric-circle geometry is the
 * defining form of a radio button, and mature icon sets reserve "shape + centered dot"
 * for STATE encoding (Adobe XD marks an overridden component instance exactly that way)
 * rather than for actions. Center-anchored radiating arcs fail the same way: lucide's
 * `radio` and `target` share identical radii (10/6/2) and differ only by arc gaps that
 * disappear to anti-aliasing at our 14px render size. The offset/stack family carries
 * the lowest confusion risk for "one value propagated to many" — the same family VS
 * Code draws from for its `replace-all` codicon, where "all" is expressed by adding an
 * offset frame behind the base glyph.
 *
 * Sized by the caller (14px in the row buttons, 12px in the section hint) and inherits
 * `currentColor` so it picks up the button's hover/accent transition.
 */
export function ApplyToAllIcon({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      <path d="M8 1.1c.47 0 .85.38.85.85v3.83l1.2-1.2a.85.85 0 1 1 1.2 1.2L8 9.03 4.75 5.78a.85.85 0 0 1 1.2-1.2l1.2 1.2V1.95c0-.47.38-.85.85-.85z" />
      <rect x="1.9" y="10.5" width="12.2" height="1.75" rx="0.87" />
      <rect x="1.9" y="13.15" width="12.2" height="1.75" rx="0.87" />
    </svg>
  )
}
