/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 *
 * Pure decision: given the PDF outline and where the reader currently is,
 * which outline entry are they inside?
 *
 * Sounds trivial, and is not. The interesting cases are all about *not*
 * jumping the highlight around:
 *
 *   - Several sections can start on one page. Picking by page number alone
 *     would snap to the first of them and stay there for the whole page.
 *   - Scrolling into a page whose first section heading is still below the
 *     viewport means the reader is still in the PREVIOUS section, even though
 *     the page already has entries of its own.
 *   - Outline entries are not guaranteed to be in document order, and a
 *     destination may not resolve to a position at all.
 *
 * Same contract as the other `-core` modules: no DOM, no state, so it runs
 * under plain Node in `test/unittest/`.
 */

"use strict";

(function (root, factory) {
  const api = factory();
  if (typeof window !== "undefined") {
    window.OnwardPdfOutlineFollowCore = api;
  }
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function () {

  // A heading whose top sits within this many pixels of the viewport top counts
  // as reached. Without the slack, landing exactly on a heading (which is what
  // clicking that heading does) would resolve to the PREVIOUS section.
  const REACHED_EPSILON_PX = 0.5;

  /**
   * @typedef {{order: number, page: number, top: number|null}} OutlineEntry
   *   `order` is the entry's pre-order index in the outline tree — the stable
   *   handle the host uses to map back to a rendered row. `top` is the
   *   destination's distance from the top of its page, in the same units as
   *   `location.top`; null when the destination carries no position.
   *
   * @typedef {{page: number, top: number}} ReadingLocation
   *
   * @param {ReadonlyArray<OutlineEntry>} entries
   * @param {ReadingLocation|null} location
   * @returns {number|null} the active entry's `order`, or null
   */
  function pickActiveOutlineOrder(entries, location) {
    if (!Array.isArray(entries) || entries.length === 0) return null;
    if (!location || !Number.isFinite(location.page)) return null;

    let previous = null;
    const samePage = [];
    for (const entry of entries) {
      if (!entry || !Number.isFinite(entry.page)) continue;
      if (entry.page < location.page) {
        // Entries are not necessarily sorted, so keep the latest-in-document
        // one rather than assuming the last seen is the nearest.
        if (previous === null || comparePosition(entry, previous) > 0) previous = entry;
      } else if (entry.page === location.page) {
        samePage.push(entry);
      }
    }

    if (samePage.length === 0) {
      return previous ? previous.order : null;
    }

    const positioned = samePage
      .filter(entry => Number.isFinite(entry.top))
      .sort((a, b) => a.top - b.top || a.order - b.order);

    if (positioned.length === 0) {
      // No destination on this page resolved to a position. Falling back to the
      // page's first entry is better than falling back to the previous page's:
      // the reader is demonstrably on this page.
      return samePage.reduce((best, entry) => (entry.order < best.order ? entry : best)).order;
    }

    let reached = null;
    const readingTop = Number.isFinite(location.top) ? location.top : 0;
    for (const entry of positioned) {
      if (entry.top > readingTop + REACHED_EPSILON_PX) break;
      reached = entry;
    }
    if (reached) return reached.order;

    // The page's first heading is still below the viewport, so the reader is
    // in whatever section was running before it. Only when there is no such
    // section does the page's own first entry win.
    return previous ? previous.order : positioned[0].order;
  }

  /** Document order: page first, then position on the page, then tree order. */
  function comparePosition(a, b) {
    if (a.page !== b.page) return a.page - b.page;
    const aTop = Number.isFinite(a.top) ? a.top : -Infinity;
    const bTop = Number.isFinite(b.top) ? b.top : -Infinity;
    if (aTop !== bTop) return aTop - bTop;
    return a.order - b.order;
  }

  return {
    pickActiveOutlineOrder: pickActiveOutlineOrder,
    REACHED_EPSILON_PX: REACHED_EPSILON_PX
  };
});
