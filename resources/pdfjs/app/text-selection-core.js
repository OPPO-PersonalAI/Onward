/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 *
 * Pure decision logic for the PDF text-selection engine.
 *
 * Everything here is a total function of its arguments: no `document`, no
 * `window`, no timers, no module state. DOM-shaped parameters are duck-typed
 * (an "annotation section" is anything with `querySelector` / `getAttribute`;
 * a "rect" is anything with left/top/right/bottom), which is what lets these
 * run under plain Node in `test/unittest/` with no Electron build.
 *
 * The split is deliberate. These functions answer questions like "is `ffi` one
 * selectable unit or three?" and "does this annotation block selection?" —
 * questions with a right answer that a unit test can pin down permanently.
 * text-selection.js keeps the parts that only mean something against a live
 * DOM (caret probing, drag state, auto-scroll), which is autotest territory.
 * A bug that only the unit tests catch means the maths is wrong; a bug that
 * only the autotest catches means the wiring is wrong.
 *
 * Adapted from the Dark_PDF_Reader reference viewer (ISC-licensed, same
 * authors); reorganised, not rewritten.
 */

"use strict";

(function (root, factory) {
  const api = factory();
  // Browser: the viewer loads this with a plain <script> tag.
  if (typeof window !== "undefined") {
    window.OnwardPdfTextSelectionCore = api;
  }
  // Node: unit tests require() it directly.
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function () {

  function getTextNodeGraphemeSegments(text) {
    let segments = null;
    if (typeof Intl?.Segmenter === "function") {
      const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
      segments = Array.from(segmenter.segment(text), segment => ({
        startOffset: segment.index,
        endOffset: segment.index + segment.segment.length
      }));
      return mergeCommonArabicLigatureSegments(
        text,
        mergeCommonLigatureSegments(text, mergeLeadingPrefixMarkSegments(text, segments))
      );
    }
  
    segments = [];
    for (let index = 0; index < text.length;) {
      const startOffset = index;
      const codePoint = text.codePointAt(index);
      index += codePoint > 0xffff ? 2 : 1;
      while (index < text.length && isCombiningCodePoint(text.codePointAt(index))) {
        const mark = text.codePointAt(index);
        index += mark > 0xffff ? 2 : 1;
      }
      segments.push({ startOffset, endOffset: index });
    }
    return mergeCommonArabicLigatureSegments(
      text,
      mergeCommonLigatureSegments(text, mergeLeadingPrefixMarkSegments(text, segments))
    );
  }
  
  function mergeLeadingPrefixMarkSegments(text, segments) {
    const merged = [];
    for (let index = 0; index < segments.length;) {
      let segment = segments[index];
      if (!isTextSelectionPrefixMarkText(text.slice(segment.startOffset, segment.endOffset))) {
        merged.push(segment);
        index += 1;
        continue;
      }
  
      const startOffset = segment.startOffset;
      while (
        index + 1 < segments.length &&
        isTextSelectionPrefixMarkText(text.slice(segment.startOffset, segment.endOffset)) &&
        segment.endOffset === segments[index + 1].startOffset
      ) {
        const nextSegment = segments[index + 1];
        if (!isValidPrefixMarkBaseText(text.slice(nextSegment.startOffset, nextSegment.endOffset))) {
          break;
        }
        segment = {
          startOffset,
          endOffset: nextSegment.endOffset
        };
        index += 1;
      }
      merged.push(segment);
      index += 1;
    }
    return merged;
  }
  
  function mergeCommonLigatureSegments(text, segments) {
    const wordInternalLigatures = ["ffi", "ffl"];
    const boundedLigatures = ["ff", "fi", "fl"];
    const ligatures = [...wordInternalLigatures, ...boundedLigatures];
    const merged = [];
    for (let index = 0; index < segments.length;) {
      const startOffset = segments[index].startOffset;
      const match = ligatures.find(sequence => {
        const endOffset = startOffset + sequence.length;
        return (
          text.slice(startOffset, endOffset) === sequence &&
          ligatureSequenceAlignsWithSegments(segments, index, endOffset) &&
          (
            wordInternalLigatures.includes(sequence) ||
            isLigatureTokenBoundary(text, startOffset, endOffset)
          )
        );
      });
      if (match) {
        merged.push({
          startOffset,
          endOffset: startOffset + match.length
        });
        index += match.length;
        continue;
      }
      merged.push(segments[index]);
      index += 1;
    }
    return merged;
  }
  
  function ligatureSequenceAlignsWithSegments(segments, startIndex, endOffset) {
    const endIndex = segments.findIndex(segment => segment.endOffset === endOffset);
    return endIndex >= startIndex && segments
      .slice(startIndex, endIndex + 1)
      .every((segment, index, slicedSegments) => {
        if (index === 0) {
          return true;
        }
        return segment.startOffset === slicedSegments[index - 1].endOffset;
      });
  }
  
  function isLigatureTokenBoundary(text, startOffset, endOffset) {
    return isLigatureBoundaryCharacter(text[startOffset - 1]) && isLigatureBoundaryCharacter(text[endOffset]);
  }
  
  function isLigatureBoundaryCharacter(character) {
    return !character || /[\s.,;:!?()[\]{}"'“”‘’]/.test(character);
  }
  
  function mergeCommonArabicLigatureSegments(text, segments) {
    const ligatures = ["\u0644\u0627", "\u0644\u0623", "\u0644\u0625", "\u0644\u0622"];
    const merged = [];
    for (let index = 0; index < segments.length;) {
      const startOffset = segments[index].startOffset;
      const match = ligatures.find(sequence => {
        const endOffset = startOffset + sequence.length;
        return (
          text.slice(startOffset, endOffset) === sequence &&
          ligatureSequenceAlignsWithSegments(segments, index, endOffset)
        );
      });
      if (match) {
        merged.push({
          startOffset,
          endOffset: startOffset + match.length
        });
        index += match.length;
        continue;
      }
      merged.push(segments[index]);
      index += 1;
    }
    return merged;
  }
  
  function isCombiningCodePoint(codePoint) {
    return (
      (codePoint >= 0x0610 && codePoint <= 0x061a) ||
      (codePoint >= 0x064b && codePoint <= 0x065f) ||
      codePoint === 0x0670 ||
      (codePoint >= 0x06d6 && codePoint <= 0x06dc) ||
      (codePoint >= 0x06df && codePoint <= 0x06e4) ||
      (codePoint >= 0x06e7 && codePoint <= 0x06e8) ||
      (codePoint >= 0x06ea && codePoint <= 0x06ed) ||
      (codePoint >= 0x08d3 && codePoint <= 0x08ff) ||
      (codePoint >= 0x0300 && codePoint <= 0x036f) ||
      (codePoint >= 0x1ab0 && codePoint <= 0x1aff) ||
      (codePoint >= 0x1dc0 && codePoint <= 0x1dff) ||
      (codePoint >= 0x20d0 && codePoint <= 0x20ff) ||
      (codePoint >= 0xfe20 && codePoint <= 0xfe2f)
    );
  }
  
  function isTextSelectionPrefixMarkText(text) {
    const value = String(text || "");
    if (!value) {
      return false;
    }
    return Array.from(value).every(character => {
      const codePoint = character.codePointAt(0);
      return isCombiningCodePoint(codePoint) || isTextSelectionPrefixModifierCodePoint(codePoint);
    });
  }
  
  function isValidPrefixMarkBaseText(text) {
    const first = Array.from(String(text || ""))[0];
    if (!first || /\s/.test(first)) {
      return false;
    }
    const codePoint = first.codePointAt(0);
    return !isCombiningCodePoint(codePoint) && !isTextSelectionPrefixModifierCodePoint(codePoint);
  }
  
  function isTextSelectionPrefixModifierCodePoint(codePoint) {
    return codePoint === 0x02c6;
  }
  
  function getTextCodePointBeforeOffset(text, offset) {
    if (offset <= 0 || offset > text.length) {
      return null;
    }
    let start = offset - 1;
    const unit = text.charCodeAt(start);
    if (unit >= 0xdc00 && unit <= 0xdfff && start > 0) {
      const previousUnit = text.charCodeAt(start - 1);
      if (previousUnit >= 0xd800 && previousUnit <= 0xdbff) {
        start -= 1;
      }
    }
    const codePoint = text.codePointAt(start);
    if (!Number.isInteger(codePoint)) {
      return null;
    }
    const end = start + (codePoint > 0xffff ? 2 : 1);
    return {
      start,
      end,
      text: text.slice(start, end)
    };
  }
  
  function getTextCodePointAtOffset(text, offset) {
    if (offset < 0 || offset >= text.length) {
      return null;
    }
    const codePoint = text.codePointAt(offset);
    if (!Number.isInteger(codePoint)) {
      return null;
    }
    const end = offset + (codePoint > 0xffff ? 2 : 1);
    return {
      start: offset,
      end,
      text: text.slice(offset, end)
    };
  }
  
  function isWhitespaceTextSelectionSegment(text) {
    return String(text || "").trim() === "";
  }
  
  function getRectAxisOverlap(aStart, aEnd, bStart, bEnd) {
    return Math.max(0, Math.min(aEnd, bEnd) - Math.max(aStart, bStart));
  }
  
  function isInvisibleTextRectCoveredByVisibleText(invisibleRect, visibleRect) {
    const verticalOverlap = getRectAxisOverlap(
      invisibleRect.top,
      invisibleRect.bottom,
      visibleRect.top,
      visibleRect.bottom
    );
    const minHeight = Math.min(invisibleRect.height, visibleRect.height);
    if (minHeight <= 0 || verticalOverlap < minHeight * 0.6) {
      return false;
    }
  
    const horizontalOverlap = getRectAxisOverlap(
      invisibleRect.left,
      invisibleRect.right,
      visibleRect.left,
      visibleRect.right
    );
    const minWidth = Math.min(invisibleRect.width, visibleRect.width);
    if (minWidth <= 0 || horizontalOverlap < minWidth * 0.5) {
      return false;
    }
  
    const overlapArea = horizontalOverlap * verticalOverlap;
    const smallerArea = Math.min(
      invisibleRect.width * invisibleRect.height,
      visibleRect.width * visibleRect.height
    );
    return smallerArea > 0 && overlapArea >= smallerArea * 0.35;
  }
  
  function clientRectsMeaningfullyOverlap(a, b) {
    const overlapX = getRectAxisOverlap(a.left, a.right, b.left, b.right);
    const overlapY = getRectAxisOverlap(a.top, a.bottom, b.top, b.bottom);
    if (overlapX <= 0 || overlapY <= 0) {
      return false;
    }
    const overlapArea = overlapX * overlapY;
    const smallerArea = Math.min(a.width * a.height, b.width * b.height);
    return smallerArea > 0 && overlapArea >= Math.min(8, smallerArea * 0.05);
  }
  
  function textRectsOverlapOnAxis(a, b, axis) {
    const tolerance = 3;
    const aStart = axis === "y" ? a.top : a.left;
    const aEnd = axis === "y" ? a.bottom : a.right;
    const bStart = axis === "y" ? b.top : b.left;
    const bEnd = axis === "y" ? b.bottom : b.right;
    return aEnd >= bStart - tolerance && bEnd >= aStart - tolerance;
  }
  
  function textRectsAreCloseOnAxis(a, b, axis) {
    const tolerance = 12;
    const aStart = axis === "y" ? a.top : a.left;
    const aEnd = axis === "y" ? a.bottom : a.right;
    const bStart = axis === "y" ? b.top : b.left;
    const bEnd = axis === "y" ? b.bottom : b.right;
    return aStart <= bEnd + tolerance && bStart <= aEnd + tolerance;
  }
  
  function textSelectionRectsShareLine(a, b) {
    const overlap = getRectAxisOverlap(a.top, a.bottom, b.top, b.bottom);
    const minHeight = Math.min(a.height, b.height);
    return minHeight > 0 && overlap >= minHeight * 0.5;
  }
  
  // 26 is AnnotationType.REDACT. It is spelled out rather than read from
  // pdfjsLib so this module stays loadable outside the viewer (unit tests run
  // it under plain Node, where pdf.js is not present); the symbolic lookup is
  // still attempted first when pdf.js happens to be around, so a future
  // renumbering in pdf.js is picked up automatically.
  const REDACT_ANNOTATION_TYPE = 26;

  function isRedactAnnotationData(annotation) {
    const symbolicRedact =
      typeof pdfjsLib !== "undefined" ? pdfjsLib?.AnnotationType?.REDACT : undefined;
    return (
      String(annotation?.subtype || "").toLowerCase() === "redact" ||
      (symbolicRedact !== undefined && annotation?.annotationType === symbolicRedact) ||
      annotation?.annotationType === REDACT_ANNOTATION_TYPE
    );
  }
  
  function getTextSelectionAnnotationRole(annotation, section) {
    if (isRedactAnnotationData(annotation)) {
      return "blocking";
    }
    if (
      section?.matches(
        ".highlightAnnotation, .underlineAnnotation, .squigglyAnnotation, .strikeoutAnnotation"
      )
    ) {
      return "passthrough";
    }
    if (
      section?.matches(
        ".squareAnnotation, .circleAnnotation, .lineAnnotation, .inkAnnotation, .polygonAnnotation, .polylineAnnotation"
      )
    ) {
      if (annotation?.hasAppearance || annotation?.hasOwnCanvas) {
        return "blocking";
      }
      if (annotationSectionHasOnlyTransparentSvgPaint(section)) {
        return "passthrough";
      }
    }
    if (annotation?.hasAppearance || annotation?.hasOwnCanvas) {
      return "blocking";
    }
    if (section) {
      return "default";
    }
    return "none";
  }
  
  function annotationRectToPageRect(rect, viewport) {
    if (!Array.isArray(rect) || rect.length < 4 || !viewport?.convertToViewportRectangle) {
      return null;
    }
    const viewportRect = viewport.convertToViewportRectangle(rect);
    const left = Math.min(viewportRect[0], viewportRect[2]);
    const right = Math.max(viewportRect[0], viewportRect[2]);
    const top = Math.min(viewportRect[1], viewportRect[3]);
    const bottom = Math.max(viewportRect[1], viewportRect[3]);
    if (right <= left || bottom <= top) {
      return null;
    }
    return {
      left,
      right,
      top,
      bottom
    };
  }
  
  function annotationSectionHasOnlyTransparentSvgPaint(annotationSection) {
    if (annotationSection.querySelector("canvas")) {
      return false;
    }
    const paintedElements = Array.from(
      annotationSection.querySelectorAll("svg line, svg rect, svg ellipse, svg polyline, svg polygon, svg path")
    );
    return (
      paintedElements.length > 0 &&
      paintedElements.every(element =>
        isTransparentSvgPaint(element.getAttribute("stroke"), element.getAttribute("stroke-opacity")) &&
        isTransparentSvgPaint(element.getAttribute("fill"), element.getAttribute("fill-opacity"))
      )
    );
  }
  
  function isTransparentSvgPaint(value, opacity) {
    const normalizedOpacity = String(opacity || "").trim();
    if (normalizedOpacity === "0" || normalizedOpacity === "0.0") {
      return true;
    }
    const normalizedValue = String(value || "").trim().toLowerCase();
    return (
      normalizedValue === "" ||
      normalizedValue === "none" ||
      normalizedValue === "transparent" ||
      normalizedValue === "rgba(0, 0, 0, 0)"
    );
  }
  
  function normalizeTextLayerCopiedText(text) {
    const value = String(text || "");
    const withoutLeadingLineBreaks = value.replace(/^\n+/, "");
    const firstCharacter = Array.from(withoutLeadingLineBreaks)[0] || "";
    if (withoutLeadingLineBreaks !== value && isTextSelectionPrefixMarkText(firstCharacter)) {
      return withoutLeadingLineBreaks;
    }
    return value;
  }
  
  function getTextGeometryFlowSign(delta) {
    const tolerance = 0.5;
    if (!Number.isFinite(delta) || Math.abs(delta) <= tolerance) {
      return 0;
    }
    return delta > 0 ? 1 : -1;
  }
  
  return {
    getTextNodeGraphemeSegments: getTextNodeGraphemeSegments,
    mergeLeadingPrefixMarkSegments: mergeLeadingPrefixMarkSegments,
    mergeCommonLigatureSegments: mergeCommonLigatureSegments,
    ligatureSequenceAlignsWithSegments: ligatureSequenceAlignsWithSegments,
    isLigatureTokenBoundary: isLigatureTokenBoundary,
    isLigatureBoundaryCharacter: isLigatureBoundaryCharacter,
    mergeCommonArabicLigatureSegments: mergeCommonArabicLigatureSegments,
    isCombiningCodePoint: isCombiningCodePoint,
    isTextSelectionPrefixMarkText: isTextSelectionPrefixMarkText,
    isValidPrefixMarkBaseText: isValidPrefixMarkBaseText,
    isTextSelectionPrefixModifierCodePoint: isTextSelectionPrefixModifierCodePoint,
    getTextCodePointBeforeOffset: getTextCodePointBeforeOffset,
    getTextCodePointAtOffset: getTextCodePointAtOffset,
    isWhitespaceTextSelectionSegment: isWhitespaceTextSelectionSegment,
    getRectAxisOverlap: getRectAxisOverlap,
    isInvisibleTextRectCoveredByVisibleText: isInvisibleTextRectCoveredByVisibleText,
    clientRectsMeaningfullyOverlap: clientRectsMeaningfullyOverlap,
    textRectsOverlapOnAxis: textRectsOverlapOnAxis,
    textRectsAreCloseOnAxis: textRectsAreCloseOnAxis,
    textSelectionRectsShareLine: textSelectionRectsShareLine,
    isRedactAnnotationData: isRedactAnnotationData,
    getTextSelectionAnnotationRole: getTextSelectionAnnotationRole,
    annotationRectToPageRect: annotationRectToPageRect,
    annotationSectionHasOnlyTransparentSvgPaint: annotationSectionHasOnlyTransparentSvgPaint,
    isTransparentSvgPaint: isTransparentSvgPaint,
    normalizeTextLayerCopiedText: normalizeTextLayerCopiedText,
    getTextGeometryFlowSign: getTextGeometryFlowSign
  };
});
