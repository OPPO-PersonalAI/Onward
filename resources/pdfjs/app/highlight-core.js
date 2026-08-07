/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 *
 * Pure geometry and colour maths for PDF highlight annotations.
 *
 * Same contract as text-selection-core.js: total functions of their arguments,
 * no DOM, no state, so they run under plain Node in `test/unittest/`.
 *
 * These functions are where a highlight becomes a durable artefact. A drag
 * produces browser client rects; this module turns them into the QuadPoints
 * that get written into the PDF file itself and read back by any other PDF
 * reader. An error here is not a rendering glitch — it is wrong geometry
 * persisted into the user's document, and it survives every later fix.
 *
 * Adapted from the Dark_PDF_Reader reference viewer (ISC-licensed, same
 * authors); reorganised, not rewritten.
 */

"use strict";

(function (root, factory) {
  const api = factory();
  if (typeof window !== "undefined") {
    window.OnwardPdfHighlightCore = api;
  }
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function () {

  // Fill opacity for a highlight. Shared because it is written into the PDF as
  // /CA *and* used for the on-screen rgba fill — if the two ever disagreed, a
  // highlight would change shade the moment it was saved and reopened.
  const HIGHLIGHT_FILL_OPACITY = 0.4;

  // Note-popup size bounds. Kept here (rather than in the DOM layer) so the
  // clamping is unit-testable and cannot drift from the CSS min/max.
  const NOTE_POPUP_WIDTH_MIN = 260;
  const NOTE_POPUP_WIDTH_MAX = 520;
  const NOTE_POPUP_WIDTH_DEFAULT = 320;
  const NOTE_POPUP_HEIGHT_MIN = 220;
  const NOTE_POPUP_HEIGHT_MAX = 620;
  // 0 means "let the content decide" — the user has not resized it yet.
  const NOTE_POPUP_HEIGHT_DEFAULT = 0;

  function normalizeNotePopupWidth(value) {
    const width = Number.parseInt(value, 10);
    if (!Number.isFinite(width)) {
      return NOTE_POPUP_WIDTH_DEFAULT;
    }
    return Math.min(NOTE_POPUP_WIDTH_MAX, Math.max(NOTE_POPUP_WIDTH_MIN, width));
  }

  function normalizeNotePopupHeight(value) {
    const height = Number.parseInt(value, 10);
    if (!Number.isFinite(height) || height <= 0) {
      return NOTE_POPUP_HEIGHT_DEFAULT;
    }
    return Math.min(NOTE_POPUP_HEIGHT_MAX, Math.max(NOTE_POPUP_HEIGHT_MIN, height));
  }

  /* ---- rect -> quad geometry (DPR 3546-3603) ---- */
  function mergeRectsByLine(rects) {
    const sorted = [...rects].sort((a, b) => a.top - b.top || a.left - b.left);
    const lines = [];
    for (const r of sorted) {
      const height = r.bottom - r.top;
      let target = null;
      for (const line of lines) {
        const overlap = Math.min(line.bottom, r.bottom) - Math.max(line.top, r.top);
        const minHeight = Math.min(line.bottom - line.top, height);
        if (minHeight > 0 && overlap > minHeight * 0.5) {
          target = line;
          break;
        }
      }
      if (target) {
        target.left = Math.min(target.left, r.left);
        target.right = Math.max(target.right, r.right);
        target.top = Math.min(target.top, r.top);
        target.bottom = Math.max(target.bottom, r.bottom);
      } else {
        lines.push({ left: r.left, top: r.top, right: r.right, bottom: r.bottom });
      }
    }
    return lines;
  }

  function rectsToQuadPoints(rects, origin, viewport) {
    const quads = [];
    for (const rect of rects) {
      const lx = rect.left - origin.left;
      const rx = rect.right - origin.left;
      const ty = rect.top - origin.top;
      const by = rect.bottom - origin.top;
      const [x1, y1] = viewport.convertToPdfPoint(lx, ty);
      const [x2, y2] = viewport.convertToPdfPoint(rx, ty);
      const [x3, y3] = viewport.convertToPdfPoint(lx, by);
      const [x4, y4] = viewport.convertToPdfPoint(rx, by);
      quads.push(x1, y1, x2, y2, x3, y3, x4, y4);
    }
    return quads;
  }

  function quadsToUnionPdfRect(quads) {
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (let i = 0; i < quads.length; i += 2) {
      const x = quads[i];
      const y = quads[i + 1];
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }
    // With no quads the accumulators are still ±Infinity, which serialises to
    // `null` in JSON and writes a malformed /Rect into the PDF — a defect that
    // travels with the file and can break it for every other reader. A
    // degenerate but well-formed rect is the safe degradation.
    if (!Number.isFinite(minX) || !Number.isFinite(minY) ||
        !Number.isFinite(maxX) || !Number.isFinite(maxY)) {
      return [0, 0, 0, 0];
    }
    return [minX, minY, maxX, maxY];
  }


  /* ---- quads -> viewport rects (DPR 3766-3789) ---- */
  function quadsToViewportRects(quads, viewport) {
    const rects = [];
    for (let i = 0; i + 7 < quads.length; i += 8) {
      const corners = [
        viewport.convertToViewportPoint(quads[i], quads[i + 1]),
        viewport.convertToViewportPoint(quads[i + 2], quads[i + 3]),
        viewport.convertToViewportPoint(quads[i + 4], quads[i + 5]),
        viewport.convertToViewportPoint(quads[i + 6], quads[i + 7])
      ];
      let minX = Infinity;
      let minY = Infinity;
      let maxX = -Infinity;
      let maxY = -Infinity;
      for (const [x, y] of corners) {
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
      }
      rects.push({ left: minX, top: minY, width: maxX - minX, height: maxY - minY });
    }
    return rects;
  }


  /* ---- colour helpers (DPR 3800-3808) ---- */
  function hexToRgbaString(hex, alpha) {
    const normalized = normalizeHexColor(hex) || "#f2c14e";
    const value = normalized.slice(1);
    const r = Number.parseInt(value.slice(0, 2), 16);
    const g = Number.parseInt(value.slice(2, 4), 16);
    const b = Number.parseInt(value.slice(4, 6), 16);
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
  }


  /* ---- colour helpers 2 (DPR 4887-4904) ---- */
  function hexToUnitRgb(hex) {
    const normalized = normalizeHexColor(hex) || "#f2c14e";
    const value = normalized.slice(1);
    return [
      Number.parseInt(value.slice(0, 2), 16) / 255,
      Number.parseInt(value.slice(2, 4), 16) / 255,
      Number.parseInt(value.slice(4, 6), 16) / 255
    ];
  }

  function getReadableTextColorForHex(hex) {
    const [r, g, b] = hexToUnitRgb(hex).map(component =>
      component <= 0.03928 ? component / 12.92 : ((component + 0.055) / 1.055) ** 2.4
    );
    const luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    return luminance > 0.48 ? "#101010" : "#f7f7f7";
  }


  /* ---- hex normalisation (DPR 6964-6968) ---- */
  function normalizeHexColor(value) {
    const text = String(value || "").trim().toLowerCase();
    const match = text.match(/^#?([0-9a-f]{6})$/i);
    return match ? `#${match[1]}` : null;
  }

  /* ---- clamp (DPR 6787-6789) ---- */
  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
  }

  return {
    mergeRectsByLine: mergeRectsByLine,
    rectsToQuadPoints: rectsToQuadPoints,
    quadsToUnionPdfRect: quadsToUnionPdfRect,
    quadsToViewportRects: quadsToViewportRects,
    hexToRgbaString: hexToRgbaString,
    hexToUnitRgb: hexToUnitRgb,
    getReadableTextColorForHex: getReadableTextColorForHex,
    normalizeHexColor: normalizeHexColor,
    normalizeNotePopupWidth: normalizeNotePopupWidth,
    normalizeNotePopupHeight: normalizeNotePopupHeight,
    clamp: clamp,
    HIGHLIGHT_FILL_OPACITY: HIGHLIGHT_FILL_OPACITY,
    NOTE_POPUP_WIDTH_DEFAULT: NOTE_POPUP_WIDTH_DEFAULT,
    NOTE_POPUP_HEIGHT_DEFAULT: NOTE_POPUP_HEIGHT_DEFAULT
  };
});
