/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 *
 * Pure decisions for the external-change in-place document reload
 * (SumatraPDF semantics: load the replacement first, swap only on success,
 * fail silently and keep the old document otherwise).
 *
 * Same contract as the other `-core` modules: no DOM, no pdf.js, no state —
 * runs under plain Node in test/unittest/ (PRC-U-*).
 */

"use strict";

(function (root, factory) {
  const api = factory();
  if (typeof window !== "undefined") {
    window.OnwardPdfReloadCore = api;
  }
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
})(this, function () {
  /** One retry, one second later; then keep the old document and stay quiet. */
  const RELOAD_RETRY_DELAY_MS = 1000;
  const RELOAD_MAX_ATTEMPTS = 2;

  /**
   * Extract the `v` version token from a file URL's query string. Returns
   * null when the URL has no token — callers treat null as "unknown, always
   * reload".
   */
  function parseVersionToken(url) {
    if (typeof url !== "string") return null;
    const queryIndex = url.indexOf("?");
    if (queryIndex < 0) return null;
    const query = url.slice(queryIndex + 1);
    for (const pair of query.split("&")) {
      const eq = pair.indexOf("=");
      const key = eq < 0 ? pair : pair.slice(0, eq);
      if (key === "v") {
        const value = eq < 0 ? "" : pair.slice(eq + 1);
        return value || null;
      }
    }
    return null;
  }

  /**
   * Reload-dedup: an identical version token to the already-active document
   * (or to a reload already in flight) is a no-op. Unknown tokens on either
   * side always reload — better one redundant load than a stale document.
   */
  function shouldStartReload(input) {
    const requested = parseVersionToken(input && input.requestedUrl);
    const active = parseVersionToken(input && input.activeUrl);
    const inFlight = parseVersionToken(input && input.inFlightUrl) ;
    if (requested !== null && inFlight !== null && requested === inFlight) {
      return { start: false, reason: "already-loading" };
    }
    if (requested !== null && active !== null && requested === active) {
      return { start: false, reason: "same-version" };
    }
    return { start: true, reason: "version-differs" };
  }

  /**
   * Whether a failed attempt should be retried, and after how long.
   * `attempt` is 1-based (the attempt that just failed).
   */
  function nextRetryDecision(attempt) {
    if (!Number.isFinite(attempt) || attempt < 1) {
      return { retry: false, delayMs: 0 };
    }
    if (attempt < RELOAD_MAX_ATTEMPTS) {
      return { retry: true, delayMs: RELOAD_RETRY_DELAY_MS };
    }
    return { retry: false, delayMs: 0 };
  }

  /**
   * Snapshot of the reader's position taken before the swap. Tolerates
   * missing/garbage inputs by omitting the field rather than storing NaN.
   */
  function captureViewState(input) {
    const state = {};
    const page = Number(input && input.pageNumber);
    if (Number.isFinite(page) && page >= 1) state.page = Math.trunc(page);
    const scrollTop = Number(input && input.scrollTop);
    if (Number.isFinite(scrollTop) && scrollTop >= 0) state.scrollTop = scrollTop;
    const scale = input && input.scaleSetting;
    if (typeof scale === "string" && scale) {
      state.scale = scale;
    } else if (typeof scale === "number" && Number.isFinite(scale) && scale > 0) {
      // Custom numeric zoom survives as its string form — pdf.js accepts
      // numeric strings for currentScaleValue.
      state.scale = String(scale);
    }
    return state;
  }

  /**
   * Restore plan against the replacement document. The page clamp is the
   * load-bearing part: the new version may have fewer pages than where the
   * reader was.
   */
  function buildRestoreState(snapshot, numPages) {
    const total = Number.isFinite(numPages) && numPages >= 1 ? Math.trunc(numPages) : 1;
    const state = {};
    const page = Number(snapshot && snapshot.page);
    state.page = Number.isFinite(page) && page >= 1 ? Math.min(Math.trunc(page), total) : 1;
    const scrollTop = Number(snapshot && snapshot.scrollTop);
    // A scroll offset from a longer document cannot be validated against the
    // new layout here (no DOM); it is carried through and clamped by the
    // container at apply time, which caps scrollTop at scrollHeight anyway.
    if (Number.isFinite(scrollTop) && scrollTop >= 0 && state.page === (snapshot && snapshot.page)) {
      state.scrollTop = scrollTop;
    }
    if (snapshot && typeof snapshot.scale === "string" && snapshot.scale) {
      state.scale = snapshot.scale;
    }
    return state;
  }

  return {
    RELOAD_RETRY_DELAY_MS: RELOAD_RETRY_DELAY_MS,
    RELOAD_MAX_ATTEMPTS: RELOAD_MAX_ATTEMPTS,
    parseVersionToken: parseVersionToken,
    shouldStartReload: shouldStartReload,
    nextRetryDecision: nextRetryDecision,
    captureViewState: captureViewState,
    buildRestoreState: buildRestoreState
  };
});
