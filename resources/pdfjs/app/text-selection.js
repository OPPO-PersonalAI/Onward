/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 *
 * Onward PDF text-selection engine.
 *
 * Adapted from the Dark_PDF_Reader reference viewer (ISC-licensed, same authors)
 * and reshaped from file-level globals into an injectable module so the host
 * viewer keeps a single, explicit dependency surface.
 *
 * Why this exists at all: pdf.js ships a text layer, but the browser's native
 * caret mapping over that layer is not accurate enough to drive highlighting.
 * A highlight is stored as the PDF-user-space QuadPoints of every line rect in
 * the selection, so "the selection is one character off" becomes "the saved
 * annotation geometry is one character off" — permanently, inside the file.
 * This module is therefore a correctness dependency of the annotation feature,
 * not a comfort feature.
 *
 * The acceptance axiom it exists to satisfy (see the reference project's
 * TEXT_SELECTION_ADVERSARIAL notes):
 *
 *     visual highlight === Selection.toString() === clipboard text === expected
 *
 * Anything weaker is a smoke test, not acceptance.
 */

"use strict";

(function () {
  // Pure decision logic lives in text-selection-core.js so it can be unit
  // tested under plain Node. Destructured once here so the ported code below
  // keeps calling the functions by their bare names.
  const {
    getTextNodeGraphemeSegments,
    mergeLeadingPrefixMarkSegments,
    mergeCommonLigatureSegments,
    ligatureSequenceAlignsWithSegments,
    isLigatureTokenBoundary,
    isLigatureBoundaryCharacter,
    mergeCommonArabicLigatureSegments,
    isCombiningCodePoint,
    isTextSelectionPrefixMarkText,
    isValidPrefixMarkBaseText,
    isTextSelectionPrefixModifierCodePoint,
    getTextCodePointBeforeOffset,
    getTextCodePointAtOffset,
    isWhitespaceTextSelectionSegment,
    getRectAxisOverlap,
    isInvisibleTextRectCoveredByVisibleText,
    clientRectsMeaningfullyOverlap,
    textRectsOverlapOnAxis,
    textRectsAreCloseOnAxis,
    textSelectionRectsShareLine,
    isRedactAnnotationData,
    getTextSelectionAnnotationRole,
    annotationRectToPageRect,
    annotationSectionHasOnlyTransparentSvgPaint,
    isTransparentSvgPaint,
    normalizeTextLayerCopiedText,
    getTextGeometryFlowSign
  } = window.OnwardPdfTextSelectionCore;

  // Pixels of pointer travel before a mousedown becomes a drag-selection.
  const TEXT_SELECTION_DRAG_THRESHOLD_PX = 2;
  // Higher threshold over annotation links: a link click jitters a few pixels,
  // and turning that into a selection would break navigation.
  const ANNOTATION_LINK_DRAG_THRESHOLD_PX = 6;
  // Distance from the viewport edge at which drag-selection starts scrolling.
  const TEXT_SELECTION_AUTOSCROLL_EDGE_PX = 56;
  const TEXT_SELECTION_AUTOSCROLL_MAX_STEP_PX = 24;
  // Window during which the synthetic click produced by a drag is swallowed.
  const TEXT_SELECTION_CLICK_SUPPRESSION_MS = 300;
  const TEXT_SELECTION_CLICK_SUPPRESSION_RADIUS_PX = 8;
  // Slack when hit-testing annotations that have no DOM section of their own.
  const TEXT_SELECTION_VIRTUAL_ANNOTATION_TOLERANCE_PX = 16;

  const NOOP = function () {};

  /**
   * @param {object} deps
   * @param {HTMLElement} deps.viewer            `#viewer` (the .pdfViewer element)
   * @param {HTMLElement} deps.viewerContainer   `#viewerContainer` (the scroller)
   * @param {(index: number) => any} deps.getPageView   pdf.js page view by 0-based index
   * @param {() => any} deps.getDocument         current PDFDocumentProxy, or null
   * @param {object} [deps.hooks]                optional integration points
   */
  function create(deps) {
    const viewerEl = deps.viewer;
    const containerEl = deps.viewerContainer;
    const getPageView = deps.getPageView;
    const getDocument = deps.getDocument;

    const hooks = Object.assign(
      {
        // Annotation ownership — filled in once highlight persistence lands.
        // Until then no annotation is "ours", so nothing gets suppressed.
        isOwnAnnotation: function () { return false; },
        onOwnAnnotationSection: NOOP,
        onPageAnnotationsIndexed: NOOP,
        // Selection palette — filled in by the highlight layer.
        setPalettePointerAnchor: NOOP,
        updatePaletteFromSelection: NOOP,
        hidePalette: NOOP,
        // Diagnostics. Must stay cheap: only called on control-flow
        // inflection points, never inside mousemove / rAF bodies.
        trace: NOOP
      },
      deps.hooks || {}
    );

    let textSelectionDragState = null;
    let textSelectionAutoScrollFrame = null;
    let suppressedTextSelectionClick = null;
    let suppressTextSelectionClickTimer = null;
    let textSelectionAnnotationIndex = new Map();
    // Owned here rather than by the palette so the engine can null it on
    // mousedown without a round trip through the host.
    let selectionHighlightPalettePointerAnchor = null;
    let autoScrollTraced = false;

    /* ==== palette shims (real implementation arrives with the highlight layer) ==== */

    function setSelectionHighlightPalettePointerAnchor(clientX, clientY) {
      selectionHighlightPalettePointerAnchor = { clientX: clientX, clientY: clientY };
      hooks.setPalettePointerAnchor(clientX, clientY);
    }

    function updateSelectionHighlightPaletteFromSelection(selection) {
      hooks.updatePaletteFromSelection(selection || window.getSelection());
    }

    function hideSelectionHighlightPalette(options) {
      selectionHighlightPalettePointerAnchor = null;
      hooks.hidePalette(options || {});
    }

    /* ==================== diagnostics ====================
     * Deliberately coarse. These fire on commit boundaries only — never per
     * mousemove, per rAF frame, or per caret probe. Selected text is never
     * put in a payload; only its length, so a bug report stays readable
     * without leaking the document's contents. */

    function traceDragCommitted(path) {
      const selection = window.getSelection();
      const text = selection && !selection.isCollapsed ? String(selection.toString()) : "";
      hooks.trace("text-selection.drag-committed", {
        path: path,
        chars: text.length,
        lines: text ? text.split("\n").length : 0
      });
    }

    /* ==== R1 annotation indexing (DPR viewer.js 1643-1701) ==== */
    async function indexTextSelectionAnnotations(event) {
      const pageNumber = Number(event?.pageNumber);
      if (!Number.isInteger(pageNumber) || pageNumber < 1 || !getDocument()) {
        return;
      }

      const documentAtStart = getDocument();
      const pageView = getPageView(pageNumber - 1);
      const page =
        event?.source?.div ||
        pageView?.div ||
        viewerEl.querySelector(`.page[data-page-number="${pageNumber}"]`);
      const viewport = event?.source?.viewport || pageView?.viewport;
      if (!page || !viewport) {
        return;
      }

      try {
        const pdfPage = await documentAtStart.getPage(pageNumber);
        const annotations = await pdfPage.getAnnotations({ intent: "any" });
        if (getDocument() !== documentAtStart) {
          return;
        }

        const virtualBlockers = [];
        for (const annotation of annotations) {
          const section = findAnnotationSection(page, annotation.id);
          const role = getTextSelectionAnnotationRole(annotation, section);
          const isOwnAnnotation = hooks.isOwnAnnotation(annotation);
          if (section) {
            section.dataset.textSelectionRole = role;
            if (isOwnAnnotation) {
              hooks.onOwnAnnotationSection(page, section, annotation.id);
            }
          } else if (role === "blocking") {
            const rect = annotationRectToPageRect(annotation.rect, viewport);
            if (rect) {
              virtualBlockers.push({
                id: String(annotation.id || ""),
                subtype: String(annotation.subtype || ""),
                rect
              });
            }
          }
        }
        hooks.onPageAnnotationsIndexed(page);
        textSelectionAnnotationIndex.set(pageNumber, { virtualBlockers });
        hooks.trace("text-selection.annotations-indexed", {
          page: pageNumber,
          total: annotations.length,
          virtualBlockers: virtualBlockers.length
        });
      } catch (error) {
        // A page whose annotations failed to index still renders, but its
        // blocking annotations are invisible to the caret engine — the user
        // would be able to select text hidden under a form widget. Surface it.
        console.warn("Failed to index text-selection annotations.", error);
        hooks.trace("text-selection.annotation-index-failed", {
          page: pageNumber,
          error: String(error && error.message ? error.message : error).slice(0, 120)
        });
      }
    }

    function findAnnotationSection(page, annotationId) {
      const id = String(annotationId || "");
      return Array.from(
        page.querySelectorAll(".annotationLayer section[data-annotation-id]")
      ).find(section => section.getAttribute("data-annotation-id") === id) || null;
    }


    /* ==== R2 annotation role + invisible text (DPR viewer.js 1827-1963) ==== */
    function filterCoveredInvisibleTextLayerSpans(event) {
      const page =
        event?.source?.div ||
        viewerEl.querySelector(`.page[data-page-number="${event?.pageNumber}"]`);
      const textLayer = page?.querySelector?.(".textLayer");
      if (!textLayer) {
        return;
      }

      const invisibleSpans = Array.from(
        textLayer.querySelectorAll("span[data-pdf-invisible-text='1']")
      ).filter(isVisibleTextLayerSpan);
      if (!invisibleSpans.length) {
        return;
      }

      const visibleRects = Array.from(textLayer.querySelectorAll("span"))
        .filter(span => !span.dataset.pdfInvisibleText)
        .filter(isVisibleTextLayerSpan)
        .flatMap(getElementClientRects);
      if (!visibleRects.length) {
        return;
      }

      for (const span of invisibleSpans) {
        const invisibleRects = getElementClientRects(span);
        const isCovered = invisibleRects.some(invisibleRect =>
          visibleRects.some(visibleRect =>
            isInvisibleTextRectCoveredByVisibleText(invisibleRect, visibleRect)
          )
        );
        if (isCovered) {
          span.remove();
        }
      }
    }

    function getElementClientRects(element) {
      return Array.from(element.getClientRects()).filter(
        rect => rect.width > 0 && rect.height > 0
      );
    }

    /* ==== R3 selection engine (DPR viewer.js 6970-9636) ==== */
    function handleTextLayerClickThrough(event) {
      if (suppressedTextSelectionClick) {
        return;
      }
      const targetElement = getEventElement(event);
      const textLayer = targetElement?.closest(".textLayer");
      if (!textLayer) {
        return;
      }

      const selection = window.getSelection();
      if (selectionIntersectsElement(selection, textLayer)) {
        return;
      }

      const link = getAnnotationLinkAtPoint(event.clientX, event.clientY, textLayer);
      if (link) {
        event.preventDefault();
        event.stopPropagation();
        dispatchForwardedClick(link, event);
      }
    }

    function handleTextSelectionClearClick(event) {
      if (suppressedTextSelectionClick) {
        return;
      }
      if (event.detail > 1) {
        return;
      }
      const targetElement = getEventElement(event);
      if (!targetElement || !targetElement.closest(".page")) {
        return;
      }
      if (targetElement.closest("input, textarea, select, button, [contenteditable='true']")) {
        return;
      }
      clearTextLayerSelection();
    }

    function handleTextSelectionDragClickSuppression(event) {
      if (!suppressedTextSelectionClick) {
        return;
      }

      const suppression = suppressedTextSelectionClick;
      clearSuppressedTextSelectionClick();

      const targetElement = getEventElement(event);
      if (!targetElement || !containerEl.contains(targetElement) || !targetElement.closest(".page")) {
        return;
      }

      const elapsed = performance.now() - suppression.time;
      const distance = Math.max(
        Math.abs(event.clientX - suppression.clientX),
        Math.abs(event.clientY - suppression.clientY)
      );
      if (
        elapsed > TEXT_SELECTION_CLICK_SUPPRESSION_MS ||
        distance > TEXT_SELECTION_CLICK_SUPPRESSION_RADIUS_PX
      ) {
        return;
      }

      event.preventDefault();
      event.stopPropagation();
    }

    function handleTextSelectionMouseDown(event) {
      if (event.button !== 0 || event.detail > 1) {
        clearTextSelectionDragState();
        return;
      }

      const targetElement = getEventElement(event);
      if (targetElement?.closest("input, textarea, select, button, [contenteditable='true']")) {
        clearTextSelectionDragState();
        return;
      }
      selectionHighlightPalettePointerAnchor = null;

      const pageAtPoint =
        targetElement?.closest(".page") ||
        document.elementFromPoint(event.clientX, event.clientY)?.closest(".page");
      if (
        pageAtPoint &&
        getVirtualTextSelectionBlockingAnnotationAtPoint(event.clientX, event.clientY, pageAtPoint)
      ) {
        clearTextSelectionDragState();
        event.preventDefault();
        event.stopPropagation();
        // Refused to start a selection because an annotation with no DOM
        // section of its own covers this point. If a user ever reports
        // "I can't select this paragraph", this is the first thing to check.
        hooks.trace("text-selection.blocked-at-anchor", {
          page: Number(pageAtPoint.dataset.pageNumber) || 0
        });
        return;
      }

      const anchorRange = getTextLayerCaretRange(event.clientX, event.clientY, {
        allowLineEdge: true,
        maxLineEdgeDistancePx: 8
      });
      if (!anchorRange) {
        clearTextSelectionDragState();
        return;
      }

      const textLayer = targetElement?.closest(".textLayer") || null;
      const startsOnTextLayer = Boolean(textLayer);
      const startedOnAnnotationLink = Boolean(
        targetElement?.closest(".annotationLayer a[href]") ||
        getAnnotationLinkAtPoint(event.clientX, event.clientY, textLayer)
      );
      event.preventDefault();

      autoScrollTraced = false;
      textSelectionDragState = {
        anchorRange,
        startX: event.clientX,
        startY: event.clientY,
        lastClientX: event.clientX,
        lastClientY: event.clientY,
        autoScrollSpeedX: 0,
        autoScrollSpeedY: 0,
        startedOnAnnotationLink,
        dragging: false
      };
    }

    function handleTextSelectionMouseMove(event) {
      if (!textSelectionDragState) {
        return;
      }
      if ((event.buttons & 1) === 0) {
        clearTextSelectionDragState();
        return;
      }

      const state = textSelectionDragState;
      state.lastClientX = event.clientX;
      state.lastClientY = event.clientY;

      const distanceX = Math.abs(event.clientX - state.startX);
      const distanceY = Math.abs(event.clientY - state.startY);
      const dragThreshold = state.startedOnAnnotationLink
        ? ANNOTATION_LINK_DRAG_THRESHOLD_PX
        : TEXT_SELECTION_DRAG_THRESHOLD_PX;
      if (!state.dragging && Math.max(distanceX, distanceY) < dragThreshold) {
        return;
      }

      state.dragging = true;
      event.preventDefault();
      event.stopPropagation();
      updateTextSelectionAutoScroll(event.clientX, event.clientY);

      const focusRange =
        getAnchorConstrainedVerticalCaretRange(
          state.anchorRange,
          event.clientX,
          event.clientY
        ) ||
        getTextLayerCaretRange(event.clientX, event.clientY, { allowLineEdge: true }) ||
        getBlockingAnnotationEdgeFocusRange(state.anchorRange, event.clientX, event.clientY) ||
        getAnchorLineEdgeCaretRange(state.anchorRange, event.clientX, event.clientY);
      if (!focusRange) {
        return;
      }

      const adjustedFocusRange = getWhitespaceAdjustedTextSelectionDragFocusRange(
        state.anchorRange,
        state.startX,
        state.startY,
        focusRange,
        event.clientX,
        event.clientY
      ) || focusRange;
      const anchorRange = getWhitespaceAdjustedTextSelectionDragAnchorRange(
        state.anchorRange,
        state.startX,
        state.startY,
        adjustedFocusRange
      ) || state.anchorRange;
      setTextLayerSelection(anchorRange, adjustedFocusRange);
    }

    function handleTextSelectionMouseUp(event) {
      if (!textSelectionDragState) {
        return;
      }

      const state = textSelectionDragState;
      stopTextSelectionAutoScroll();
      textSelectionDragState = null;
      if (!state.dragging) {
        clearTextLayerSelection();
        return;
      }

      event.preventDefault();
      event.stopPropagation();

      const focusRange =
        getAnchorConstrainedVerticalCaretRange(state.anchorRange, event.clientX, event.clientY) ||
        getTextLayerCaretRange(event.clientX, event.clientY, { allowLineEdge: true }) ||
        getBlockingAnnotationEdgeFocusRange(state.anchorRange, event.clientX, event.clientY) ||
        getAnchorLineEdgeCaretRange(state.anchorRange, event.clientX, event.clientY);
      const adjustedFocusRange = focusRange
        ? (getWhitespaceAdjustedTextSelectionDragFocusRange(
            state.anchorRange,
            state.startX,
            state.startY,
            focusRange,
            event.clientX,
            event.clientY
          ) || focusRange)
        : focusRange;
      const anchorRange = adjustedFocusRange
        ? (getWhitespaceAdjustedTextSelectionDragAnchorRange(
            state.anchorRange,
            state.startX,
            state.startY,
            adjustedFocusRange
          ) || state.anchorRange)
        : state.anchorRange;
      if (adjustedFocusRange && setTextLayerSelection(anchorRange, adjustedFocusRange)) {
        setSelectionHighlightPalettePointerAnchor(event.clientX, event.clientY);
        updateSelectionHighlightPaletteFromSelection();
        suppressNextTextSelectionClick(event);
        traceDragCommitted("engine");
      } else if (selectionHasTextLayerText(window.getSelection())) {
        setSelectionHighlightPalettePointerAnchor(event.clientX, event.clientY);
        updateSelectionHighlightPaletteFromSelection();
        suppressNextTextSelectionClick(event);
        traceDragCommitted("native-fallback");
      }
    }

    function handleSelectionHighlightPaletteMouseUpAnchor(event) {
      if (event.button !== 0) {
        return;
      }
      const targetElement = getEventElement(event);
      if (
        targetElement?.closest("#selectionHighlightPalette") ||
        targetElement?.closest("input, textarea, select, button, [contenteditable='true']")
      ) {
        return;
      }
      const clientX = event.clientX;
      const clientY = event.clientY;
      requestAnimationFrame(() => {
        const selection = window.getSelection();
        if (!selectionHasTextLayerText(selection)) {
          return;
        }
        setSelectionHighlightPalettePointerAnchor(clientX, clientY);
        updateSelectionHighlightPaletteFromSelection(selection);
      });
    }

    function updateTextSelectionAutoScroll(clientX, clientY) {
      const state = textSelectionDragState;
      if (!state?.dragging) {
        stopTextSelectionAutoScroll();
        return;
      }

      state.lastClientX = clientX;
      state.lastClientY = clientY;
      state.autoScrollSpeedX = getTextSelectionHorizontalAutoScrollSpeed(clientX);
      state.autoScrollSpeedY = getTextSelectionVerticalAutoScrollSpeed(clientY);
      // Emit once per drag, not once per mousemove — this runs on the hot
      // pointer path and the interesting fact is "autoscroll engaged at all".
      if (
        !autoScrollTraced &&
        (state.autoScrollSpeedX !== 0 || state.autoScrollSpeedY !== 0)
      ) {
        autoScrollTraced = true;
        hooks.trace("text-selection.autoscroll-engaged", {
          horizontal: state.autoScrollSpeedX !== 0,
          vertical: state.autoScrollSpeedY !== 0
        });
      }
      if (state.autoScrollSpeedX === 0 && state.autoScrollSpeedY === 0) {
        stopTextSelectionAutoScroll();
        return;
      }
      startTextSelectionAutoScroll();
    }

    function getTextSelectionVerticalAutoScrollSpeed(clientY) {
      const container = containerEl;
      const rect = container.getBoundingClientRect();
      const maxScrollTop = container.scrollHeight - container.clientHeight;
      if (maxScrollTop <= 0) {
        return 0;
      }

      if (clientY < rect.top + TEXT_SELECTION_AUTOSCROLL_EDGE_PX && container.scrollTop > 0) {
        const distance = Math.min(TEXT_SELECTION_AUTOSCROLL_EDGE_PX, rect.top + TEXT_SELECTION_AUTOSCROLL_EDGE_PX - clientY);
        const ratio = distance / TEXT_SELECTION_AUTOSCROLL_EDGE_PX;
        return -Math.max(1, Math.ceil(TEXT_SELECTION_AUTOSCROLL_MAX_STEP_PX * ratio));
      }

      if (clientY > rect.bottom - TEXT_SELECTION_AUTOSCROLL_EDGE_PX && container.scrollTop < maxScrollTop) {
        const distance = Math.min(TEXT_SELECTION_AUTOSCROLL_EDGE_PX, clientY - (rect.bottom - TEXT_SELECTION_AUTOSCROLL_EDGE_PX));
        const ratio = distance / TEXT_SELECTION_AUTOSCROLL_EDGE_PX;
        return Math.max(1, Math.ceil(TEXT_SELECTION_AUTOSCROLL_MAX_STEP_PX * ratio));
      }

      return 0;
    }

    function getTextSelectionHorizontalAutoScrollSpeed(clientX) {
      const container = containerEl;
      const rect = container.getBoundingClientRect();
      const maxScrollLeft = container.scrollWidth - container.clientWidth;
      if (maxScrollLeft <= 0) {
        return 0;
      }

      if (clientX < rect.left + TEXT_SELECTION_AUTOSCROLL_EDGE_PX && container.scrollLeft > 0) {
        const distance = Math.min(TEXT_SELECTION_AUTOSCROLL_EDGE_PX, rect.left + TEXT_SELECTION_AUTOSCROLL_EDGE_PX - clientX);
        const ratio = distance / TEXT_SELECTION_AUTOSCROLL_EDGE_PX;
        return -Math.max(1, Math.ceil(TEXT_SELECTION_AUTOSCROLL_MAX_STEP_PX * ratio));
      }

      if (clientX > rect.right - TEXT_SELECTION_AUTOSCROLL_EDGE_PX && container.scrollLeft < maxScrollLeft) {
        const distance = Math.min(TEXT_SELECTION_AUTOSCROLL_EDGE_PX, clientX - (rect.right - TEXT_SELECTION_AUTOSCROLL_EDGE_PX));
        const ratio = distance / TEXT_SELECTION_AUTOSCROLL_EDGE_PX;
        return Math.max(1, Math.ceil(TEXT_SELECTION_AUTOSCROLL_MAX_STEP_PX * ratio));
      }

      return 0;
    }

    function startTextSelectionAutoScroll() {
      if (textSelectionAutoScrollFrame !== null) {
        return;
      }
      textSelectionAutoScrollFrame = requestAnimationFrame(stepTextSelectionAutoScroll);
    }

    function stopTextSelectionAutoScroll() {
      if (textSelectionAutoScrollFrame !== null) {
        cancelAnimationFrame(textSelectionAutoScrollFrame);
        textSelectionAutoScrollFrame = null;
      }
      if (textSelectionDragState) {
        textSelectionDragState.autoScrollSpeedX = 0;
        textSelectionDragState.autoScrollSpeedY = 0;
      }
    }

    function stepTextSelectionAutoScroll() {
      textSelectionAutoScrollFrame = null;
      const state = textSelectionDragState;
      if (!state?.dragging || (state.autoScrollSpeedX === 0 && state.autoScrollSpeedY === 0)) {
        return;
      }

      const container = containerEl;
      const previousScrollLeft = container.scrollLeft;
      const previousScrollTop = container.scrollTop;
      container.scrollLeft = previousScrollLeft + state.autoScrollSpeedX;
      container.scrollTop = previousScrollTop + state.autoScrollSpeedY;
      if (container.scrollLeft !== previousScrollLeft || container.scrollTop !== previousScrollTop) {
        updateTextSelectionDragFocusFromLastPoint();
      }

      state.autoScrollSpeedX = getTextSelectionHorizontalAutoScrollSpeed(state.lastClientX);
      state.autoScrollSpeedY = getTextSelectionVerticalAutoScrollSpeed(state.lastClientY);
      if (state.autoScrollSpeedX !== 0 || state.autoScrollSpeedY !== 0) {
        startTextSelectionAutoScroll();
      }
    }

    function updateTextSelectionDragFocusFromLastPoint() {
      const state = textSelectionDragState;
      if (!state?.dragging) {
        return;
      }

      const focusRange =
        getAnchorConstrainedVerticalCaretRange(
          state.anchorRange,
          state.lastClientX,
          state.lastClientY
        ) ||
        getTextLayerCaretRange(state.lastClientX, state.lastClientY, { allowLineEdge: true }) ||
        getBlockingAnnotationEdgeFocusRange(state.anchorRange, state.lastClientX, state.lastClientY) ||
        getAnchorLineEdgeCaretRange(state.anchorRange, state.lastClientX, state.lastClientY);
      if (focusRange) {
        setTextLayerSelection(state.anchorRange, focusRange);
      }
    }

    function handleTextLayerCopy(event) {
      const selection = window.getSelection();
      if (!selectionHasTextLayerText(selection)) {
        return;
      }

      const selectedText = normalizeTextLayerCopiedText(selection.toString());
      if (!selectedText || !event.clipboardData) {
        return;
      }

      event.clipboardData.clearData();
      event.clipboardData.setData("text/plain", selectedText);
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
      // We took the clipboard away from pdf.js on purpose: its default copy
      // path rewrites ligatures and can produce text that differs from what
      // the user sees highlighted. If clipboard content is ever reported as
      // wrong, this event says whether our override actually ran.
      hooks.trace("text-selection.copy-overridden", { chars: selectedText.length });
    }

    function getEventElement(event) {
      const target = event?.target;
      if (target instanceof Element) {
        return target;
      }
      return target?.parentElement || null;
    }

    function getAnnotationLinkAtPoint(clientX, clientY, ignoredTextLayer = null) {
      const previousPointerEvents = ignoredTextLayer?.style.pointerEvents;
      try {
        if (ignoredTextLayer) {
          ignoredTextLayer.style.pointerEvents = "none";
        }
        const elements = document.elementsFromPoint
          ? document.elementsFromPoint(clientX, clientY)
          : [document.elementFromPoint(clientX, clientY)].filter(Boolean);
        for (const element of elements) {
          const linkSection = element?.closest?.(
            ".annotationLayer section.linkAnnotation:not(.buttonWidgetAnnotation)"
          );
          const link = element?.closest?.("a[href]") || linkSection?.querySelector?.("a[href]");
          if (link && linkSection) {
            return link;
          }
        }
        return null;
      } finally {
        if (ignoredTextLayer) {
          ignoredTextLayer.style.pointerEvents = previousPointerEvents;
        }
      }
    }

    function dispatchForwardedClick(link, sourceEvent) {
      link.dispatchEvent(
        new MouseEvent("click", {
          bubbles: true,
          cancelable: true,
          view: window,
          detail: sourceEvent.detail,
          screenX: sourceEvent.screenX,
          screenY: sourceEvent.screenY,
          clientX: sourceEvent.clientX,
          clientY: sourceEvent.clientY,
          ctrlKey: sourceEvent.ctrlKey,
          altKey: sourceEvent.altKey,
          shiftKey: sourceEvent.shiftKey,
          metaKey: sourceEvent.metaKey,
          button: sourceEvent.button,
          buttons: sourceEvent.buttons
        })
      );
    }

    function selectionIntersectsElement(selection, element) {
      if (!selection || selection.isCollapsed || selection.rangeCount === 0 || !element) {
        return false;
      }

      for (let index = 0; index < selection.rangeCount; index += 1) {
        const range = selection.getRangeAt(index);
        if (!range.startContainer.isConnected || !range.endContainer.isConnected) {
          continue;
        }
        try {
          if (range.intersectsNode(element)) {
            return true;
          }
        } catch (error) {
          if (nodeBelongsToElement(range.startContainer, element) || nodeBelongsToElement(range.endContainer, element)) {
            return true;
          }
        }
      }
      return false;
    }

    function selectionHasTextLayerText(selection) {
      return (
        selection &&
        !selection.isCollapsed &&
        (nodeClosest(selection.anchorNode, ".textLayer") || nodeClosest(selection.focusNode, ".textLayer"))
      );
    }

    function nodeBelongsToElement(node, element) {
      const nodeElement = node?.nodeType === Node.ELEMENT_NODE ? node : node?.parentElement;
      return Boolean(nodeElement && element.contains(nodeElement));
    }

    function nodeClosest(node, selector) {
      const nodeElement = node?.nodeType === Node.ELEMENT_NODE ? node : node?.parentElement;
      return nodeElement?.closest?.(selector) || null;
    }

    function getTextLayerCaretRange(clientX, clientY, options = {}) {
      const range = getCaretRangeAtPoint(clientX, clientY);
      const pageAtPoint = document.elementFromPoint(clientX, clientY)?.closest(".page");
      if (pageAtPoint && getTextSelectionBlockingAnnotationAtPoint(clientX, clientY, pageAtPoint)) {
        return null;
      }
      const outerLineEdgeRange = options.allowLineEdge
        ? getNearestLineEdgeCaretRange(clientX, clientY, pageAtPoint, {
            ...options,
            onlyOuterEdges: true,
            lineEdgeSnapTolerancePx: 4
          })
        : null;
      if (outerLineEdgeRange) {
        return outerLineEdgeRange;
      }
      const refinedRange = refineUsableTextLayerCaretRange(range, clientX, clientY);
      if (refinedRange) {
        return refinedRange;
      }

      const page = pageAtPoint;
      if (!page) {
        return options.allowLineEdge ? getNearestLineEdgeCaretRange(clientX, clientY, null, options) : null;
      }

      if (getTextSelectionBlockingAnnotationAtPoint(clientX, clientY, page)) {
        return null;
      }

      const geometryRange = getTextSpanGeometryCaretRangeAtPoint(clientX, clientY, page);
      if (geometryRange) {
        return geometryRange;
      }

      return getTextLayerCaretRangeBypassingAnnotationLayer(clientX, clientY, page, options);
    }

    /**
     * Axis-adjust + whitespace-snap a raw caret range when it is usable at
     * this point. The shared refinement for both the direct hit path and the
     * annotation-layer bypass path; null when the raw range is unusable.
     */
    function refineUsableTextLayerCaretRange(range, clientX, clientY) {
      if (!isUsableTextLayerCaretRange(range, clientX, clientY)) {
        return null;
      }
      const adjustedRange = (
        getVerticalTextLayerCaretRange(range.startContainer, clientX, clientY) ||
        getHorizontalTextLayerCaretRange(range.startContainer, clientX, clientY) ||
        range
      );
      return getWhitespaceSnappedTextLayerCaretRange(adjustedRange, clientX, clientY) || adjustedRange;
    }

    /**
     * Non-blocking annotation elements swallow elementFromPoint/caret hits for
     * the text beneath them. Temporarily disable their pointer events, retry
     * the caret resolution, and always restore the styles.
     */
    function getTextLayerCaretRangeBypassingAnnotationLayer(clientX, clientY, page, options) {
      const annotationElements = Array.from(page.querySelectorAll(".annotationLayer, .annotationLayer *"));
      if (!annotationElements.length) {
        return options.allowLineEdge ? getNearestLineEdgeCaretRange(clientX, clientY, page, options) : null;
      }

      const previousPointerEvents = annotationElements.map(element => ({
        element,
        pointerEvents: element.style.pointerEvents
      }));
      try {
        for (const { element } of previousPointerEvents) {
          element.style.pointerEvents = "none";
        }
        const refinedRange = refineUsableTextLayerCaretRange(
          getCaretRangeAtPoint(clientX, clientY),
          clientX,
          clientY
        );
        if (refinedRange) {
          return refinedRange;
        }
        const annotationGeometryRange = getTextSpanGeometryCaretRangeAtPoint(clientX, clientY, page);
        if (annotationGeometryRange) {
          return annotationGeometryRange;
        }
        return options.allowLineEdge ? getNearestLineEdgeCaretRange(clientX, clientY, page, options) : null;
      } finally {
        for (const { element, pointerEvents } of previousPointerEvents) {
          element.style.pointerEvents = pointerEvents;
        }
      }
    }

    function getTextSelectionBlockingAnnotationAtPoint(clientX, clientY, page) {
      const virtualBlocker = getVirtualTextSelectionBlockingAnnotationAtPoint(clientX, clientY, page);
      if (virtualBlocker) {
        return virtualBlocker;
      }

      const elements = document.elementsFromPoint
        ? document.elementsFromPoint(clientX, clientY)
        : [document.elementFromPoint(clientX, clientY)].filter(Boolean);
      for (const element of elements) {
        if (!element || !page.contains(element)) {
          continue;
        }
        const annotationElement = element.closest?.(".annotationLayer *");
        if (!annotationElement) {
          continue;
        }
        const annotationSection = annotationElement.closest(".annotationLayer section");
        const textSpan = getTextLayerSpanAtPoint(clientX, clientY, page);
        if (annotationSection && isInvisibleTextLayerSpan(textSpan)) {
          return annotationSection;
        }
        if (annotationSection?.dataset.textSelectionRole === "blocking") {
          return annotationSection;
        }
        const sectionIsLink = Boolean(
          annotationSection?.matches(".linkAnnotation:not(.buttonWidgetAnnotation)")
        );
        const annotationLink =
          sectionIsLink
            ? annotationElement.closest("a[href]") || annotationSection?.querySelector?.("a[href]")
            : null;
        if (sectionIsLink) {
          continue;
        }
        const interactiveFormElement = annotationElement.closest(
          "input, textarea, select, button, [contenteditable='true']"
        );
        if (interactiveFormElement) {
          return interactiveFormElement;
        }
        if (annotationSection && !isTextSelectionPassthroughAnnotationSection(annotationSection)) {
          return annotationSection;
        }
      }
      return null;
    }

    function getVirtualTextSelectionBlockingAnnotationAtPoint(clientX, clientY, page) {
      const pageNumber = Number(page?.dataset?.pageNumber);
      if (!Number.isInteger(pageNumber)) {
        return null;
      }
      const virtualBlockers = textSelectionAnnotationIndex.get(pageNumber)?.virtualBlockers || [];
      if (!virtualBlockers.length) {
        return null;
      }
      const pageRect = page.getBoundingClientRect();
      const pageX = clientX - pageRect.left;
      const pageY = clientY - pageRect.top;
      const tolerance = TEXT_SELECTION_VIRTUAL_ANNOTATION_TOLERANCE_PX;
      return virtualBlockers.find(blocker =>
        pageX >= blocker.rect.left - tolerance &&
          pageX <= blocker.rect.right + tolerance &&
          pageY >= blocker.rect.top - tolerance &&
          pageY <= blocker.rect.bottom + tolerance
      ) || null;
    }

    function isTextSelectionPassthroughAnnotationSection(annotationSection) {
      if (annotationSection.dataset.textSelectionRole === "passthrough") {
        return true;
      }
      if (annotationSection.dataset.textSelectionRole === "blocking") {
        return false;
      }
      if (
        annotationSection.matches(
          ".highlightAnnotation, .underlineAnnotation, .squigglyAnnotation, .strikeoutAnnotation"
        )
      ) {
        return true;
      }
      if (
        annotationSection.matches(
          ".squareAnnotation, .circleAnnotation, .lineAnnotation, .inkAnnotation, .polygonAnnotation, .polylineAnnotation"
        )
      ) {
        return annotationSectionHasOnlyTransparentSvgPaint(annotationSection);
      }
      return false;
    }

    function getNearestLineEdgeCaretRange(clientX, clientY, page = null, options = {}) {
      const pageElement = page || document.elementFromPoint(clientX, clientY)?.closest(".page");
      if (!pageElement) {
        return null;
      }

      const lineSpans = collectVisibleLineSpansAtY(pageElement, clientY);
      if (!lineSpans.length) {
        return null;
      }

      const target = resolveLineEdgeCaretTarget(lineSpans, clientX, options);
      if (!target || !target.targetNode) {
        return null;
      }

      return createPrefixAdjustedCollapsedRange(target.targetNode, target.offset);
    }

    /** Visible text-layer spans whose vertical extent covers clientY (±4px). */
    function collectVisibleLineSpansAtY(pageElement, clientY) {
      const textSpans = Array.from(pageElement.querySelectorAll(".textLayer span")).filter(isVisibleTextLayerSpan);
      const yTolerance = 4;
      return textSpans.filter(span => {
        const rect = span.getBoundingClientRect();
        return clientY >= rect.top - yTolerance && clientY <= rect.bottom + yTolerance;
      });
    }

    /**
     * Decide which span edge the pointer snaps to on this line: outside the
     * line's left/right extremes, inside a between-span gap, or — in
     * onlyOuterEdges mode — within the snap tolerance of an outer edge.
     * Distance gating comes from isLineEdgeDistanceAllowed throughout.
     */
    function resolveLineEdgeCaretTarget(lineSpans, clientX, options) {
      const firstSpan = lineSpans.reduce((currentFirst, span) => {
        return span.getBoundingClientRect().left < currentFirst.getBoundingClientRect().left
          ? span
          : currentFirst;
      }, lineSpans[0]);
      const lastSpan = lineSpans.reduce((currentLast, span) => {
        return span.getBoundingClientRect().right > currentLast.getBoundingClientRect().right
          ? span
          : currentLast;
      }, lineSpans[0]);
      const firstRect = firstSpan.getBoundingClientRect();
      const lastRect = lastSpan.getBoundingClientRect();
      const edgeSnapTolerance = Number.isFinite(options.lineEdgeSnapTolerancePx)
        ? Math.max(0, options.lineEdgeSnapTolerancePx)
        : 0;

      if (options.onlyOuterEdges) {
        if (clientX <= firstRect.left + edgeSnapTolerance) {
          if (clientX < firstRect.left && !isLineEdgeDistanceAllowed(firstRect.left - clientX, options)) {
            return null;
          }
          return getTextSpanVisualEdgeCaret(firstSpan, "left");
        }
        if (clientX >= lastRect.right - edgeSnapTolerance) {
          if (clientX > lastRect.right && !isLineEdgeDistanceAllowed(clientX - lastRect.right, options)) {
            return null;
          }
          return getTextSpanVisualEdgeCaret(lastSpan, "right");
        }
        return null;
      }
      if (clientX <= firstRect.left) {
        if (!isLineEdgeDistanceAllowed(firstRect.left - clientX, options)) {
          return null;
        }
        return getTextSpanVisualEdgeCaret(firstSpan, "left");
      }
      if (clientX >= lastRect.right) {
        if (!isLineEdgeDistanceAllowed(clientX - lastRect.right, options)) {
          return null;
        }
        return getTextSpanVisualEdgeCaret(lastSpan, "right");
      }

      let nearest = null;
      for (const span of lineSpans) {
        const rect = span.getBoundingClientRect();
        if (clientX >= rect.left && clientX <= rect.right) {
          continue;
        }
        const distance = clientX < rect.left ? rect.left - clientX : clientX - rect.right;
        if (!nearest || distance < nearest.distance) {
          nearest = { span, rect, distance };
        }
      }
      if (!nearest) {
        return null;
      }
      if (!isLineEdgeDistanceAllowed(nearest.distance, options)) {
        return null;
      }
      return getTextSpanVisualEdgeCaret(nearest.span, clientX < nearest.rect.left ? "left" : "right");
    }

    /** Collapsed caret Range at a text node offset, pushed past any prefix
     *  combining mark so a caret never lands between a base and its mark. */
    function createPrefixAdjustedCollapsedRange(targetNode, offset) {
      const axis = isVisuallyVerticalTextNode(targetNode) ? "y" : "x";
      const boundary = adjustTextLayerCaretBoundaryForPrefixMark(targetNode, offset, axis);
      const range = document.createRange();
      range.setStart(boundary.textNode, boundary.offset);
      range.collapse(true);
      return range;
    }

    function getTextSpanGeometryCaretRangeAtPoint(clientX, clientY, page = null) {
      const span = getTextLayerSpanAtPoint(clientX, clientY, page);
      if (!span) {
        return null;
      }
      return getTextSpanGeometryCaretRange(span, clientX, clientY);
    }

    function getTextLayerSpanAtPoint(clientX, clientY, page = null) {
      const elementAtPoint = document.elementFromPoint(clientX, clientY);
      const directSpan = getOutermostTextLayerSpan(elementAtPoint);
      if (isVisibleTextLayerSpan(directSpan)) {
        return directSpan;
      }

      const pageElement = page || elementAtPoint?.closest?.(".page");
      if (!pageElement) {
        return null;
      }

      const tolerance = 1;
      return Array.from(pageElement.querySelectorAll(".textLayer span"))
        .filter(isVisibleTextLayerSpan)
        .find(span => {
          const rect = span.getBoundingClientRect();
          return (
            clientX >= rect.left - tolerance &&
            clientX <= rect.right + tolerance &&
            clientY >= rect.top - tolerance &&
            clientY <= rect.bottom + tolerance
          );
        }) || null;
    }

    function getTextSpanGeometryCaretRange(span, clientX, clientY) {
      let nearest = null;
      for (const textNode of getTextNodes(span)) {
        const rect = getTextNodeBoundingRect(textNode);
        if (!rect || rect.width <= 0 || rect.height <= 0) {
          continue;
        }
        const distance = getPointToRectDistance(clientX, clientY, rect);
        if (!nearest || distance < nearest.distance) {
          nearest = { textNode, distance };
        }
      }
      if (!nearest) {
        return null;
      }

      const axis = isVisuallyVerticalTextNode(nearest.textNode) ? "y" : "x";
      const offset = getNearestTextNodeOffsetByGeometry(nearest.textNode, clientX, clientY, axis);
      if (!Number.isInteger(offset)) {
        return null;
      }

      const boundary = adjustTextLayerCaretBoundaryForPrefixMark(nearest.textNode, offset, axis);
      const range = document.createRange();
      range.setStart(boundary.textNode, boundary.offset);
      range.collapse(true);
      return getWhitespaceSnappedTextLayerCaretRange(range, clientX, clientY) || range;
    }

    function getWhitespaceSnappedTextLayerCaretRange(range, clientX, clientY) {
      if (!range?.collapsed || !isTextLayerTextNode(range.startContainer)) {
        return null;
      }

      const axis = isVisuallyVerticalTextNode(range.startContainer) ? "y" : "x";
      const offset = getWhitespaceSnappedTextLayerCaretOffset(
        range.startContainer,
        range.startOffset,
        clientX,
        clientY,
        axis
      );
      if (!Number.isInteger(offset) || offset === range.startOffset) {
        return null;
      }

      const boundary = adjustTextLayerCaretBoundaryForPrefixMark(range.startContainer, offset, axis);
      const snappedRange = document.createRange();
      snappedRange.setStart(boundary.textNode, boundary.offset);
      snappedRange.collapse(true);
      return snappedRange;
    }

    function getWhitespaceSnappedTextLayerCaretOffset(textNode, offset, clientX, clientY, axis) {
      const coordinate = axis === "y" ? clientY : clientX;
      const entries = getTextNodeGeometryEntries(textNode, axis);
      if (entries.length < 3) {
        return null;
      }

      const first = entries[0];
      const last = entries[entries.length - 1];
      const forward = first.center <= last.center;
      const coordinateTolerance = 0.75;
      for (let index = 0; index < entries.length; index += 1) {
        const entry = entries[index];
        if (
          !isWhitespaceTextSelectionSegment(entry.text) ||
          (offset !== entry.startOffset && offset !== entry.endOffset) ||
          coordinate < entry.start - coordinateTolerance ||
          coordinate > entry.end + coordinateTolerance
        ) {
          continue;
        }

        const snappedOffset = getWhitespaceGeometryEntryOffsetForCoordinate(
          entries,
          index,
          coordinate,
          forward
        );
        return Number.isInteger(snappedOffset) ? snappedOffset : null;
      }
      return null;
    }

    function getWhitespaceAdjustedTextSelectionDragAnchorRange(anchorRange, startX, startY, focusRange) {
      if (
        !anchorRange?.collapsed ||
        !focusRange?.collapsed ||
        !isTextLayerTextNode(anchorRange.startContainer)
      ) {
        return null;
      }

      const textNode = anchorRange.startContainer;
      const axis = isVisuallyVerticalTextNode(textNode) ? "y" : "x";
      const anchorCoordinate = axis === "y" ? startY : startX;
      const focusCoordinate = getTextLayerCaretCoordinate(focusRange, axis);
      if (!Number.isFinite(anchorCoordinate) || !Number.isFinite(focusCoordinate)) {
        return null;
      }

      const entries = getTextNodeGeometryEntries(textNode, axis);
      if (entries.length < 3) {
        return null;
      }
      const first = entries[0];
      const last = entries[entries.length - 1];
      const forward = first.center <= last.center;
      const dragMovesInTextOrder = (focusCoordinate > anchorCoordinate) === forward;
      const coordinateTolerance = 1.25;

      for (let index = 0; index < entries.length; index += 1) {
        const entry = entries[index];
        if (
          !isWhitespaceTextSelectionSegment(entry.text) ||
          anchorCoordinate < entry.start - coordinateTolerance ||
          anchorCoordinate > entry.end + coordinateTolerance
        ) {
          continue;
        }

        let offset = null;
        if (
          dragMovesInTextOrder &&
          anchorRange.startOffset === entry.startOffset &&
          hasAdjacentNonWhitespaceTextGeometryEntry(entries, index, 1)
        ) {
          offset = entry.endOffset;
        } else if (
          !dragMovesInTextOrder &&
          anchorRange.startOffset === entry.endOffset &&
          hasAdjacentNonWhitespaceTextGeometryEntry(entries, index, -1)
        ) {
          offset = entry.startOffset;
        }

        if (!Number.isInteger(offset) || offset === anchorRange.startOffset) {
          return null;
        }

        const boundary = adjustTextLayerCaretBoundaryForPrefixMark(textNode, offset, axis);
        const range = document.createRange();
        range.setStart(boundary.textNode, boundary.offset);
        range.collapse(true);
        return range;
      }
      return null;
    }

    function getWhitespaceAdjustedTextSelectionDragFocusRange(
      anchorRange,
      startX,
      startY,
      focusRange,
      focusX,
      focusY
    ) {
      if (
        !anchorRange?.collapsed ||
        !focusRange?.collapsed ||
        !isTextLayerTextNode(focusRange.startContainer)
      ) {
        return null;
      }

      const textNode = focusRange.startContainer;
      const axis = isVisuallyVerticalTextNode(textNode) ? "y" : "x";
      const anchorCoordinate = axis === "y" ? startY : startX;
      const focusCoordinate = axis === "y" ? focusY : focusX;
      if (!Number.isFinite(anchorCoordinate) || !Number.isFinite(focusCoordinate)) {
        return null;
      }

      const entries = getTextNodeGeometryEntries(textNode, axis);
      if (entries.length < 3) {
        return null;
      }
      const first = entries[0];
      const last = entries[entries.length - 1];
      const forward = first.center <= last.center;
      const dragMovesInTextOrder = (focusCoordinate > anchorCoordinate) === forward;
      const coordinateTolerance = 1.25;

      for (let index = 0; index < entries.length; index += 1) {
        const entry = entries[index];
        if (
          !isWhitespaceTextSelectionSegment(entry.text) ||
          focusCoordinate < entry.start - coordinateTolerance ||
          focusCoordinate > entry.end + coordinateTolerance
        ) {
          continue;
        }

        let offset = null;
        if (
          dragMovesInTextOrder &&
          focusRange.startOffset === entry.endOffset &&
          hasAdjacentNonWhitespaceTextGeometryEntry(entries, index, -1)
        ) {
          offset = entry.startOffset;
        } else if (
          !dragMovesInTextOrder &&
          focusRange.startOffset === entry.startOffset &&
          hasAdjacentNonWhitespaceTextGeometryEntry(entries, index, 1)
        ) {
          offset = entry.endOffset;
        }

        if (!Number.isInteger(offset) || offset === focusRange.startOffset) {
          return null;
        }

        const boundary = adjustTextLayerCaretBoundaryForPrefixMark(textNode, offset, axis);
        const range = document.createRange();
        range.setStart(boundary.textNode, boundary.offset);
        range.collapse(true);
        return range;
      }
      return null;
    }

    function hasAdjacentNonWhitespaceTextGeometryEntry(entries, index, direction) {
      const entry = entries[index + direction];
      return Boolean(entry && !isWhitespaceTextSelectionSegment(entry.text));
    }

    function getTextNodes(element) {
      const nodes = [];
      const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
      while (walker.nextNode()) {
        if (walker.currentNode.nodeValue) {
          nodes.push(walker.currentNode);
        }
      }
      return nodes;
    }

    function getFirstTextNode(element) {
      return getTextNodes(element)[0] || null;
    }

    function getLastTextNode(element) {
      const nodes = getTextNodes(element);
      return nodes[nodes.length - 1] || null;
    }

    function getTextSpanVisualEdgeCaret(span, visualEdge) {
      const isRtl = isHorizontalRtlTextSpan(span);
      if ((visualEdge === "left" && isRtl) || (visualEdge === "right" && !isRtl)) {
        const targetNode = getLastTextNode(span);
        return {
          targetNode,
          offset: targetNode?.nodeValue.length || 0
        };
      }

      return {
        targetNode: getFirstTextNode(span),
        offset: 0
      };
    }

    function isLineEdgeDistanceAllowed(distancePx, options) {
      if (distancePx < 0) {
        return false;
      }
      if (!Number.isFinite(options.maxLineEdgeDistancePx)) {
        return true;
      }
      return distancePx <= options.maxLineEdgeDistancePx;
    }

    function getCaretRangeAtPoint(clientX, clientY) {
      let range = null;
      if (document.caretRangeFromPoint) {
        range = document.caretRangeFromPoint(clientX, clientY);
      } else if (document.caretPositionFromPoint) {
        const position = document.caretPositionFromPoint(clientX, clientY);
        if (position?.offsetNode) {
          range = document.createRange();
          range.setStart(position.offsetNode, position.offset);
          range.collapse(true);
        }
      }
      return range;
    }

    function getTextNodeBoundingRect(textNode) {
      if (!isTextLayerTextNode(textNode)) {
        return null;
      }
      const range = document.createRange();
      range.selectNodeContents(textNode);
      const rect = range.getBoundingClientRect();
      range.detach();
      return rect;
    }

    function getPointToRectDistance(clientX, clientY, rect) {
      const distanceX = clientX < rect.left ? rect.left - clientX : Math.max(clientX - rect.right, 0);
      const distanceY = clientY < rect.top ? rect.top - clientY : Math.max(clientY - rect.bottom, 0);
      return Math.max(distanceX, distanceY);
    }

    function getVerticalTextLayerCaretRange(textNode, clientX, clientY) {
      if (!isTextLayerTextNode(textNode) || !isVisuallyVerticalTextNode(textNode)) {
        return null;
      }

      const offset = getNearestTextNodeOffsetByGeometry(textNode, clientX, clientY, "y");
      if (!Number.isInteger(offset)) {
        return null;
      }

      const boundary = adjustTextLayerCaretBoundaryForPrefixMark(textNode, offset, "y");
      const range = document.createRange();
      range.setStart(boundary.textNode, boundary.offset);
      range.collapse(true);
      return range;
    }

    function getHorizontalTextLayerCaretRange(textNode, clientX, clientY) {
      if (!isTextLayerTextNode(textNode) || isVisuallyVerticalTextNode(textNode)) {
        return null;
      }

      const offset = getNearestTextNodeOffsetByGeometry(textNode, clientX, clientY, "x");
      if (!Number.isInteger(offset)) {
        return null;
      }

      const boundary = adjustTextLayerCaretBoundaryForPrefixMark(textNode, offset, "x");
      const range = document.createRange();
      range.setStart(boundary.textNode, boundary.offset);
      range.collapse(true);
      return range;
    }

    function getAnchorConstrainedVerticalCaretRange(anchorRange, clientX, clientY) {
      const anchorNode = anchorRange?.startContainer;
      if (!isTextLayerTextNode(anchorNode) || !isVisuallyVerticalTextNode(anchorNode)) {
        return null;
      }
      if (!isPointInsideTextNodeCrossAxis(anchorNode, clientX, "y")) {
        return null;
      }
      return getVerticalTextLayerCaretRange(anchorNode, clientX, clientY);
    }

    function getAnchorLineEdgeCaretRange(anchorRange, clientX, clientY) {
      const anchorPage = nodeClosest(anchorRange?.startContainer, ".page");
      if (!anchorPage) {
        return null;
      }
      return getNearestLineEdgeCaretRange(clientX, clientY, anchorPage, {
        onlyOuterEdges: true,
        lineEdgeSnapTolerancePx: 4
      });
    }

    function getBlockingAnnotationEdgeFocusRange(anchorRange, clientX, clientY) {
      const anchorPage = nodeClosest(anchorRange?.startContainer, ".page");
      if (!anchorPage) {
        return null;
      }

      const blockerRect = getTextSelectionBlockingAnnotationClientRectAtPoint(anchorPage, clientX, clientY);
      if (!blockerRect) {
        return null;
      }

      const anchorLineRect =
        getCollapsedRangeClientRect(anchorRange) ||
        getTextNodeBoundingRect(anchorRange.startContainer);
      if (!anchorLineRect) {
        return null;
      }

      const anchorX = getTextLayerCaretCoordinate(anchorRange, "x");
      const side = Number.isFinite(anchorX) && clientX < anchorX ? "after" : "before";
      return getHorizontalTextLayerSelectionBlockerEdgeRange(
        anchorPage,
        blockerRect,
        anchorLineRect,
        side
      );
    }

    function isPointInsideTextNodeCrossAxis(textNode, clientX, axis) {
      const span = getOutermostTextLayerSpan(textNode);
      const rect = span?.getBoundingClientRect();
      if (!rect || rect.width <= 0 || rect.height <= 0) {
        return false;
      }

      const tolerance = 3;
      if (axis === "y") {
        return clientX >= rect.left - tolerance && clientX <= rect.right + tolerance;
      }
      return false;
    }

    function getOutermostTextLayerSpan(node) {
      const element = node?.nodeType === Node.ELEMENT_NODE ? node : node?.parentElement;
      let span = element?.closest?.(".textLayer span") || null;
      while (span) {
        if (isVisibleTextLayerSpan(span)) {
          return span;
        }
        span = span.parentElement?.closest?.(".textLayer span") || null;
      }
      return null;
    }

    function isVisuallyVerticalTextNode(textNode) {
      const flow = getTextNodeCharacterFlow(textNode);
      if (flow) {
        return Math.abs(flow.deltaY) > Math.abs(flow.deltaX) * 1.25;
      }

      const text = textNode?.nodeValue || "";
      if (getTextNodeGraphemeSegments(text).length < 2) {
        return false;
      }

      const range = document.createRange();
      range.selectNodeContents(textNode);
      const rect = range.getBoundingClientRect();
      range.detach();
      if (!rect || rect.width <= 0 || rect.height <= 0) {
        return false;
      }
      return rect.height > rect.width * 1.25;
    }

    function getTextNodeCharacterFlow(textNode) {
      const entries = getTextNodeGeometryEntries(textNode, "x");
      if (entries.length < 2) {
        return null;
      }

      let first = null;
      let last = null;
      for (const entry of entries) {
        const center = {
          x: entry.centerX,
          y: entry.centerY
        };
        first ||= center;
        last = center;
      }

      if (!first || !last || (first.x === last.x && first.y === last.y)) {
        return null;
      }
      return {
        deltaX: last.x - first.x,
        deltaY: last.y - first.y
      };
    }

    function isHorizontalRtlTextSpan(span) {
      if (!isVisibleTextLayerSpan(span)) {
        return false;
      }
      const rect = span.getBoundingClientRect();
      if (rect.height > rect.width * 1.25) {
        return false;
      }
      return getComputedStyle(span).direction === "rtl";
    }

    function isVisibleTextLayerSpan(span) {
      if (!span?.matches?.(".textLayer span")) {
        return false;
      }
      const rect = span.getBoundingClientRect();
      return (
        getTextNodes(span).length > 0 &&
        rect.width > 0 &&
        rect.height > 0
      );
    }

    function isInvisibleTextLayerSpan(span) {
      return Boolean(span?.dataset?.pdfInvisibleText);
    }

    function getNearestTextNodeOffsetByGeometry(textNode, clientX, clientY, axis) {
      const text = textNode.nodeValue || "";
      if (!text.length) {
        return null;
      }

      const coordinate = axis === "y" ? clientY : clientX;
      const entries = getTextNodeGeometryEntries(textNode, axis);
      if (!entries.length) {
        return null;
      }

      const first = entries[0];
      const last = entries[entries.length - 1];
      const forward = first.center <= last.center;
      if (forward) {
        if (coordinate <= first.start) {
          return 0;
        }
        if (coordinate >= last.end) {
          return text.length;
        }
      } else {
        if (coordinate >= first.end) {
          return 0;
        }
        if (coordinate <= last.start) {
          return text.length;
        }
      }

      for (let index = 0; index < entries.length; index += 1) {
        const entry = entries[index];
        if (coordinate < entry.start || coordinate > entry.end) {
          continue;
        }
        if (isWhitespaceTextSelectionSegment(entry.text)) {
          const whitespaceOffset = getWhitespaceGeometryEntryOffsetForCoordinate(
            entries,
            index,
            coordinate,
            forward
          );
          if (Number.isInteger(whitespaceOffset)) {
            return whitespaceOffset;
          }
        }
        return getTextGeometryEntryOffsetForCoordinate(
          entry,
          coordinate,
          getTextGeometryEntryForward(entries, index, forward)
        );
      }

      let nearestIndex = 0;
      let nearest = entries[nearestIndex];
      let nearestDistance = Math.abs(coordinate - nearest.center);
      for (let index = 1; index < entries.length; index += 1) {
        const entry = entries[index];
        const distance = Math.abs(coordinate - entry.center);
        if (distance < nearestDistance) {
          nearestIndex = index;
          nearest = entry;
          nearestDistance = distance;
        }
      }
      return getTextGeometryEntryOffsetForCoordinate(
        nearest,
        coordinate,
        getTextGeometryEntryForward(entries, nearestIndex, forward)
      );
    }

    function getWhitespaceGeometryEntryOffsetForCoordinate(entries, index, coordinate, forward) {
      const entry = entries[index];
      const beforeEntry = forward ? entries[index - 1] : entries[index + 1];
      const afterEntry = forward ? entries[index + 1] : entries[index - 1];
      if (!entry || !beforeEntry || !afterEntry) {
        return null;
      }

      const beforeEdge = forward ? beforeEntry.end : beforeEntry.start;
      const afterEdge = forward ? afterEntry.start : afterEntry.end;
      const beforeDistance = Math.abs(coordinate - beforeEdge);
      const afterDistance = Math.abs(coordinate - afterEdge);
      return afterDistance < beforeDistance ? entry.endOffset : entry.startOffset;
    }

    function getTextGeometryEntryOffsetForCoordinate(entry, coordinate, forward) {
      if (forward) {
        return coordinate <= entry.center ? entry.startOffset : entry.endOffset;
      }
      return coordinate >= entry.center ? entry.startOffset : entry.endOffset;
    }

    function getTextGeometryEntryForward(entries, index, fallbackForward) {
      const previousDelta = index > 0
        ? entries[index].center - entries[index - 1].center
        : null;
      const nextDelta = index < entries.length - 1
        ? entries[index + 1].center - entries[index].center
        : null;
      const previousSign = getTextGeometryFlowSign(previousDelta);
      const nextSign = getTextGeometryFlowSign(nextDelta);

      if (previousSign && nextSign && previousSign === nextSign) {
        return previousSign > 0;
      }
      if (previousSign && nextSign) {
        return Math.abs(previousDelta) <= Math.abs(nextDelta)
          ? previousSign > 0
          : nextSign > 0;
      }
      if (previousSign || nextSign) {
        return (previousSign || nextSign) > 0;
      }
      return fallbackForward;
    }

    function getTextNodeGeometryEntries(textNode, axis) {
      const text = textNode?.nodeValue || "";
      if (!text.length) {
        return [];
      }

      const entries = [];
      for (const segment of getTextNodeGraphemeSegments(text)) {
        const range = document.createRange();
        range.setStart(textNode, segment.startOffset);
        range.setEnd(textNode, segment.endOffset);
        const rect = range.getBoundingClientRect();
        range.detach();
        if (!rect || rect.width <= 0 || rect.height <= 0) {
          continue;
        }
        const start = axis === "y" ? rect.top : rect.left;
        const end = axis === "y" ? rect.bottom : rect.right;
        entries.push({
          startOffset: segment.startOffset,
          endOffset: segment.endOffset,
          start: Math.min(start, end),
          end: Math.max(start, end),
          center: (start + end) / 2,
          left: rect.left,
          right: rect.right,
          top: rect.top,
          bottom: rect.bottom,
          width: rect.width,
          height: rect.height,
          centerX: (rect.left + rect.right) / 2,
          centerY: (rect.top + rect.bottom) / 2,
          text: text.slice(segment.startOffset, segment.endOffset)
        });
      }

      return mergeSameGlyphGeometryEntries(entries);
    }

    function adjustTextLayerCaretBoundaryForPrefixMark(textNode, offset, axis) {
      if (!isTextLayerTextNode(textNode)) {
        return { textNode, offset };
      }

      const sameNodeBoundary = getSameTextNodePrefixMarkCaretBoundary(textNode, offset, axis);
      if (sameNodeBoundary) {
        return sameNodeBoundary;
      }

      if (offset !== 0) {
        return { textNode, offset };
      }

      const previousTextNode = getPreviousTextLayerTextNode(textNode);
      if (
        !previousTextNode ||
        !isTextSelectionPrefixMarkText(previousTextNode.nodeValue || "") ||
        !prefixMarkTextNodeBelongsToTextNode(previousTextNode, textNode, axis)
      ) {
        return { textNode, offset };
      }

      return getPrefixMarkBoundaryBeforeTextNode(previousTextNode);
    }

    function getPrefixMarkBoundaryBeforeTextNode(prefixTextNode) {
      let firstPrefixTextNode = prefixTextNode;
      for (;;) {
        const previousTextNode = getPreviousTextLayerTextNode(firstPrefixTextNode);
        if (!previousTextNode || !isTextSelectionPrefixMarkText(previousTextNode.nodeValue || "")) {
          if (previousTextNode && isTextLayerTextNode(previousTextNode)) {
            return {
              textNode: previousTextNode,
              offset: previousTextNode.nodeValue.length
            };
          }
          return {
            textNode: firstPrefixTextNode,
            offset: 0
          };
        }
        firstPrefixTextNode = previousTextNode;
      }
    }

    function getSameTextNodePrefixMarkCaretBoundary(textNode, offset, axis) {
      const text = textNode?.nodeValue || "";
      if (offset <= 0 || offset >= text.length) {
        return null;
      }
      if (getTextNodeGraphemeSegments(text).some(segment =>
        offset === segment.startOffset || offset === segment.endOffset
      )) {
        return null;
      }

      let prefixStart = offset;
      for (;;) {
        const previous = getTextCodePointBeforeOffset(text, prefixStart);
        if (!previous || !isTextSelectionPrefixMarkText(previous.text)) {
          break;
        }
        prefixStart = previous.start;
      }
      if (prefixStart === offset) {
        return null;
      }

      const base = getTextCodePointAtOffset(text, offset);
      if (
        !base ||
        !isValidPrefixMarkBaseText(base.text) ||
        !prefixMarkTextRangeBelongsToBaseRange(textNode, prefixStart, offset, base.end, axis)
      ) {
        return null;
      }

      return { textNode, offset: prefixStart };
    }

    function prefixMarkTextRangeBelongsToBaseRange(textNode, prefixStart, prefixEnd, baseEnd, axis) {
      return Boolean(textNode && prefixStart < prefixEnd && prefixEnd < baseEnd);
    }

    function getPreviousTextLayerTextNode(textNode) {
      const textLayer = textNode?.parentElement?.closest(".textLayer");
      if (!textLayer) {
        return null;
      }

      const walker = document.createTreeWalker(textLayer, NodeFilter.SHOW_TEXT);
      let previous = null;
      while (walker.nextNode()) {
        if (walker.currentNode === textNode) {
          return previous;
        }
        if (walker.currentNode.nodeValue) {
          previous = walker.currentNode;
        }
      }
      return null;
    }

    function prefixMarkTextNodeBelongsToTextNode(prefixTextNode, textNode, axis) {
      const base = getTextCodePointAtOffset(textNode?.nodeValue || "", 0);
      if (!base || !isValidPrefixMarkBaseText(base.text)) {
        return false;
      }
      return Boolean(prefixTextNode && textNode);
    }

    function mergeSameGlyphGeometryEntries(entries) {
      const merged = [];
      for (const entry of entries) {
        const current = merged.at(-1);
        if (current && textGeometryEntriesShareGlyph(current, entry)) {
          current.endOffset = entry.endOffset;
          current.start = Math.min(current.start, entry.start);
          current.end = Math.max(current.end, entry.end);
          current.center = (current.start + current.end) / 2;
          current.left = Math.min(current.left, entry.left);
          current.right = Math.max(current.right, entry.right);
          current.top = Math.min(current.top, entry.top);
          current.bottom = Math.max(current.bottom, entry.bottom);
          current.width = current.right - current.left;
          current.height = current.bottom - current.top;
          current.centerX = (current.centerX + entry.centerX) / 2;
          current.centerY = (current.centerY + entry.centerY) / 2;
          current.text = `${current.text || ""}${entry.text || ""}`;
          continue;
        }
        merged.push({ ...entry });
      }
      return merged;
    }

    function textGeometryEntriesShareGlyph(a, b) {
      const tolerance = 0.75;
      return (
        Math.abs(a.start - b.start) <= tolerance &&
        Math.abs(a.end - b.end) <= tolerance &&
        Math.abs(a.center - b.center) <= tolerance &&
        Math.abs(a.centerX - b.centerX) <= tolerance &&
        Math.abs(a.centerY - b.centerY) <= tolerance
      );
    }

    function isUsableTextLayerCaretRange(range, clientX, clientY) {
      return (
        range &&
        isTextLayerTextNode(range.startContainer) &&
        isPointInsideTextLayerText(range.startContainer, clientX, clientY) &&
        isCaretRangeNearPoint(range, clientX, clientY)
      );
    }

    function isTextLayerTextNode(node) {
      return node?.nodeType === Node.TEXT_NODE && Boolean(node.parentElement?.closest(".textLayer"));
    }

    function isPointInsideTextLayerText(node, clientX, clientY) {
      const rect = node.parentElement?.getBoundingClientRect();
      if (!rect) {
        return false;
      }
      const tolerance = 2;
      return (
        clientX >= rect.left - tolerance &&
        clientX <= rect.right + tolerance &&
        clientY >= rect.top - tolerance &&
        clientY <= rect.bottom + tolerance
      );
    }

    function isCaretRangeNearPoint(range, clientX, clientY) {
      const probe = range.cloneRange();
      probe.collapse(true);
      const rect = probe.getClientRects()[0] || probe.getBoundingClientRect();
      probe.detach();
      if (!rect || (rect.width === 0 && rect.height === 0)) {
        return true;
      }

      const xTolerance = 8;
      const yTolerance = 4;
      return (
        clientX >= rect.left - xTolerance &&
        clientX <= rect.right + xTolerance &&
        clientY >= rect.top - yTolerance &&
        clientY <= rect.bottom + yTolerance
      );
    }

    function setTextLayerSelection(anchorRange, focusRange) {
      if (!anchorRange || !focusRange) {
        return false;
      }

      try {
        if (!anchorRange.startContainer.isConnected || !focusRange.startContainer.isConnected) {
          clearTextSelectionDragState({ clearTextLayerSelection: true });
          return false;
        }

        const anchorBeforeFocus = anchorRange.compareBoundaryPoints(
          Range.START_TO_START,
          focusRange
        ) <= 0;
        anchorRange = getGraphemeBoundaryAdjustedTextLayerCaretRange(
          anchorRange,
          !anchorBeforeFocus
        ) || anchorRange;
        focusRange = getGraphemeBoundaryAdjustedTextLayerCaretRange(
          focusRange,
          anchorBeforeFocus
        ) || focusRange;

        const preserveSingleBoundaryWhitespace = Boolean(focusRange.__preserveSingleBoundaryWhitespace);
        const clamped = clampTextLayerSelectionToBlockingAnnotations(anchorRange, focusRange);
        if (!clamped) {
          return false;
        }

        return installTextLayerSelection(anchorRange, clamped.focusRange, clamped.range, {
          wasClamped: clamped.wasClamped,
          preserveSingleBoundaryWhitespace
        });
      } catch (error) {
        clearTextSelectionDragState();
        return false;
      }
    }

    /**
     * Blocking-annotation clamp: when the drag range crosses an annotation
     * that must not leak the text beneath it, pull the focus back to the
     * annotation edge. Returns { range, focusRange, wasClamped } with any
     * intermediate ranges detached, or null when no legal selection remains.
     */
    function clampTextLayerSelectionToBlockingAnnotations(anchorRange, focusRange) {
      let range = createTextLayerSelectionRange(anchorRange, focusRange);
      const blockingIntersection = getTextLayerSelectionBlockingIntersection(range);
      if (!blockingIntersection) {
        return { range, focusRange, wasClamped: false };
      }

      const clampedFocusRange = getTextLayerSelectionClampedFocusRange(
        anchorRange,
        focusRange,
        blockingIntersection
      );
      if (!clampedFocusRange) {
        range.detach();
        return null;
      }

      const clampedRange = createTextLayerSelectionRange(anchorRange, clampedFocusRange);
      if (textLayerSelectionRangeIntersectsBlockingAnnotation(clampedRange)) {
        range.detach();
        clampedRange.detach();
        return null;
      }

      range.detach();
      return { range: clampedRange, focusRange: clampedFocusRange, wasClamped: true };
    }

    /**
     * Install the resolved selection into the DOM: directional
     * setBaseAndExtent when possible, document-order Range fallback, plus the
     * whitespace trim + overlay refresh both paths share.
     */
    function installTextLayerSelection(anchorRange, focusRange, range, options) {
      const trimAfterInstall = Boolean(options.wasClamped || options.preserveSingleBoundaryWhitespace);
      const selection = window.getSelection();
      const anchorPage = nodeClosest(anchorRange.startContainer, ".page");
      const focusPage = nodeClosest(focusRange.startContainer, ".page");
      const crossesPages = Boolean(anchorPage && focusPage && anchorPage !== focusPage);
      // Chromium inserts spurious blank lines into Selection.toString() when
      // setBaseAndExtent runs backwards across block-level page elements. So
      // for cross-page selections we always install a document-order Range;
      // the actual drag direction stays recorded in textSelectionDragState.
      if (selection.setBaseAndExtent && !crossesPages) {
        try {
          selection.removeAllRanges();
          selection.setBaseAndExtent(
            anchorRange.startContainer,
            anchorRange.startOffset,
            focusRange.startContainer,
            focusRange.startOffset
          );
          if (trimAfterInstall) {
            trimCurrentTextLayerSelectionWhitespace(selection, {
              preserveSingleBoundaryWhitespace: true
            });
          }
          updateTextSelectionOverlayFromSelection(selection);
          range.detach();
          return true;
        } catch (error) {
          selection.removeAllRanges();
        }
      }

      selection.removeAllRanges();
      selection.addRange(range);
      if (trimAfterInstall) {
        trimCurrentTextLayerSelectionWhitespace(selection, {
          preserveSingleBoundaryWhitespace: true
        });
      }
      updateTextSelectionOverlayFromSelection(selection);
      return true;
    }

    function getGraphemeBoundaryAdjustedTextLayerCaretRange(range, preferEnd) {
      if (!range || !isTextLayerTextNode(range.startContainer)) {
        return null;
      }

      const textNode = range.startContainer;
      const text = textNode.nodeValue || "";
      const offset = range.startOffset;
      const secondaryOffset = range.endContainer === textNode ? range.endOffset : offset;
      const segments = getTextNodeGraphemeSegments(text);
      const segment = segments.find(item =>
        textLayerCaretRangeTouchesGraphemeInterior(item, offset, secondaryOffset)
      );
      if (!segment) {
        return null;
      }

      const boundaryOffset = preferEnd ? segment.endOffset : segment.startOffset;
      const axis = isVisuallyVerticalTextNode(textNode) ? "y" : "x";
      const boundary = adjustTextLayerCaretBoundaryForPrefixMark(textNode, boundaryOffset, axis);
      const adjustedRange = document.createRange();
      adjustedRange.setStart(boundary.textNode, boundary.offset);
      adjustedRange.collapse(true);
      return adjustedRange;
    }

    function textLayerCaretRangeTouchesGraphemeInterior(segment, offset, secondaryOffset) {
      return (
        (offset > segment.startOffset && offset < segment.endOffset) ||
        (secondaryOffset > segment.startOffset && secondaryOffset < segment.endOffset)
      );
    }

    function trimCurrentTextLayerSelectionWhitespace(selection = window.getSelection(), options = {}) {
      if (!selection || selection.rangeCount !== 1 || selection.isCollapsed) {
        return false;
      }

      const range = selection.getRangeAt(0);
      if (!selectionRangeHasTextLayerText(range)) {
        return false;
      }

      const trimmedRange = getTrimmedTextLayerSelectionRange(range, options);
      if (!trimmedRange || trimmedRange.collapsed) {
        trimmedRange?.detach();
        return false;
      }

      selection.removeAllRanges();
      selection.addRange(trimmedRange);
      return true;
    }

    function getTrimmedTextLayerSelectionRange(sourceRange, options = {}) {
      const range = sourceRange.cloneRange();
      const textNodes = getTextNodesInRange(range);
      if (!textNodes.length) {
        range.detach();
        return null;
      }

      let startSet = false;
      for (const textNode of textNodes) {
        const text = textNode.nodeValue || "";
        const startOffset = range.startContainer === textNode ? range.startOffset : 0;
        const endOffset = range.endContainer === textNode ? range.endOffset : text.length;
        let offset = startOffset;
        while (offset < endOffset && /\s/.test(text[offset])) {
          offset += 1;
        }
        if (options.preserveSingleBoundaryWhitespace && offset > startOffset) {
          offset -= 1;
        }
        if (offset < endOffset) {
          range.setStart(textNode, offset);
          startSet = true;
          break;
        }
      }

      let endSet = false;
      for (let index = textNodes.length - 1; index >= 0; index -= 1) {
        const textNode = textNodes[index];
        const text = textNode.nodeValue || "";
        const startOffset = range.startContainer === textNode ? range.startOffset : 0;
        const endOffset = range.endContainer === textNode ? range.endOffset : text.length;
        let offset = endOffset;
        while (offset > startOffset && /\s/.test(text[offset - 1])) {
          offset -= 1;
        }
        if (options.preserveSingleBoundaryWhitespace && offset < endOffset) {
          offset += 1;
        }
        if (offset > startOffset) {
          range.setEnd(textNode, offset);
          endSet = true;
          break;
        }
      }

      if (!startSet || !endSet) {
        range.detach();
        return null;
      }
      return range;
    }

    function getTextNodesInRange(range) {
      const root = range.commonAncestorContainer.nodeType === Node.ELEMENT_NODE
        ? range.commonAncestorContainer
        : range.commonAncestorContainer.parentElement;
      if (!root) {
        return [];
      }

      const nodes = [];
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      while (walker.nextNode()) {
        const node = walker.currentNode;
        if (!isTextLayerTextNode(node)) {
          continue;
        }
        try {
          if (range.intersectsNode(node)) {
            nodes.push(node);
          }
        } catch (error) {
          if (node === range.startContainer || node === range.endContainer) {
            nodes.push(node);
          }
        }
      }
      return nodes;
    }

    function createTextLayerSelectionRange(anchorRange, focusRange) {
      const range = document.createRange();
      const isForward = anchorRange.compareBoundaryPoints(Range.START_TO_START, focusRange) <= 0;
      if (isForward) {
        range.setStart(anchorRange.startContainer, anchorRange.startOffset);
        range.setEnd(focusRange.startContainer, focusRange.startOffset);
      } else {
        range.setStart(focusRange.startContainer, focusRange.startOffset);
        range.setEnd(anchorRange.startContainer, anchorRange.startOffset);
      }
      return range;
    }

    function textLayerSelectionRangeIntersectsBlockingAnnotation(range) {
      return Boolean(getTextLayerSelectionBlockingIntersection(range));
    }

    function getTextLayerSelectionBlockingIntersection(range) {
      if (!range || range.collapsed) {
        return null;
      }

      const rangeRectEntries = getTextLayerSelectionRangeRectEntries(range);
      if (!rangeRectEntries.length) {
        return null;
      }

      for (const { page, rect: rangeRect } of rangeRectEntries) {
        const blockerRects = getTextSelectionBlockingAnnotationClientRects(page);
        if (!blockerRects.length) {
          continue;
        }
        for (const blockerRect of blockerRects) {
          if (clientRectsMeaningfullyOverlap(rangeRect, blockerRect)) {
            return { page, rangeRect, blockerRect };
          }
        }
      }
      return null;
    }

    function getTextLayerSelectionRangeRectEntries(range) {
      const crossPageSegments = getCrossPageTextSelectionSegmentsFromRange(range);
      if (crossPageSegments.length) {
        const entries = [];
        for (const segment of crossPageSegments) {
          entries.push(
            ...Array.from(segment.range.getClientRects())
              .filter(rect => rect.width > 0 && rect.height > 0)
              .map(rect => ({ page: segment.page, rect }))
          );
          segment.range.detach();
        }
        return entries;
      }

      const page = nodeClosest(range.startContainer, ".page") || nodeClosest(range.endContainer, ".page");
      if (!page) {
        return [];
      }
      return Array.from(range.getClientRects())
        .filter(rect => rect.width > 0 && rect.height > 0)
        .map(rect => ({ page, rect }));
    }

    function getTextLayerSelectionRangePages(range) {
      return Array.from(viewerEl.querySelectorAll(".page")).filter(page => {
        const textLayer = page.querySelector(".textLayer");
        if (!textLayer) {
          return false;
        }
        try {
          return range.intersectsNode(textLayer);
        } catch (error) {
          return nodeBelongsToElement(range.startContainer, textLayer) ||
            nodeBelongsToElement(range.endContainer, textLayer);
        }
      });
    }

    function getTextSelectionBlockingAnnotationClientRects(page) {
      const sectionRects = Array.from(
        page.querySelectorAll(".annotationLayer section[data-text-selection-role='blocking']")
      )
        .map(section => section.getBoundingClientRect())
        .filter(rect => rect.width > 0 && rect.height > 0);

      const pageNumber = Number(page.dataset.pageNumber);
      const pageRect = page.getBoundingClientRect();
      const virtualRects = (textSelectionAnnotationIndex.get(pageNumber)?.virtualBlockers || [])
        .map(blocker => ({
          left: pageRect.left + blocker.rect.left,
          right: pageRect.left + blocker.rect.right,
          top: pageRect.top + blocker.rect.top,
          bottom: pageRect.top + blocker.rect.bottom,
          width: blocker.rect.right - blocker.rect.left,
          height: blocker.rect.bottom - blocker.rect.top
        }))
        .filter(rect => rect.width > 0 && rect.height > 0);

      return [
        ...sectionRects,
        ...virtualRects,
        ...getAnnotationCoveredInvisibleTextClientRects(page)
      ];
    }

    function getTextSelectionBlockingAnnotationClientRectAtPoint(page, clientX, clientY) {
      const tolerance = 1;
      return getTextSelectionBlockingAnnotationClientRects(page).find(rect =>
        clientX >= rect.left - tolerance &&
          clientX <= rect.right + tolerance &&
          clientY >= rect.top - tolerance &&
          clientY <= rect.bottom + tolerance
      ) || null;
    }

    function getTextSelectionBlockingAnnotationSectionClientRectAtPoint(page, clientX, clientY) {
      const tolerance = 1;
      return Array.from(page.querySelectorAll(".annotationLayer section[data-text-selection-role='blocking']"))
        .map(section => section.getBoundingClientRect())
        .filter(rect => rect.width > 0 && rect.height > 0)
        .find(rect =>
          clientX >= rect.left - tolerance &&
            clientX <= rect.right + tolerance &&
            clientY >= rect.top - tolerance &&
            clientY <= rect.bottom + tolerance
        ) || null;
    }

    function getAnnotationCoveredInvisibleTextClientRects(page) {
      const annotationRects = Array.from(page.querySelectorAll(".annotationLayer section"))
        .map(section => section.getBoundingClientRect())
        .filter(rect => rect.width > 0 && rect.height > 0);
      if (!annotationRects.length) {
        return [];
      }

      return Array.from(page.querySelectorAll(".textLayer span[data-pdf-invisible-text='1']"))
        .filter(isVisibleTextLayerSpan)
        .flatMap(span => getElementClientRects(span))
        .filter(textRect =>
          annotationRects.some(annotationRect =>
            clientRectsMeaningfullyOverlap(textRect, annotationRect)
          )
        );
    }

    function getTextLayerSelectionClampedFocusRange(anchorRange, focusRange, intersection) {
      const axis = getTextLayerSelectionClampAxis(anchorRange, focusRange);
      if (axis !== "x") {
        return null;
      }

      const direction = getTextLayerSelectionVisualDirection(anchorRange, focusRange, axis);
      if (!direction) {
        return null;
      }

      return getHorizontalTextLayerSelectionBlockerEdgeRange(
        intersection.page,
        intersection.blockerRect,
        intersection.rangeRect,
        direction > 0 ? "before" : "after"
      );
    }

    function getTextLayerSelectionClampAxis(anchorRange, focusRange) {
      if (
        isVisuallyVerticalTextNode(anchorRange?.startContainer) ||
        isVisuallyVerticalTextNode(focusRange?.startContainer)
      ) {
        return "y";
      }
      return "x";
    }

    function getTextLayerSelectionVisualDirection(anchorRange, focusRange, axis) {
      const anchorCoordinate = getTextLayerCaretCoordinate(anchorRange, axis);
      const focusCoordinate = getTextLayerCaretCoordinate(focusRange, axis);
      if (Number.isFinite(anchorCoordinate) && Number.isFinite(focusCoordinate)) {
        const delta = focusCoordinate - anchorCoordinate;
        if (Math.abs(delta) > 0.5) {
          return delta > 0 ? 1 : -1;
        }
      }

      return anchorRange.compareBoundaryPoints(Range.START_TO_START, focusRange) <= 0 ? 1 : -1;
    }

    function getTextLayerCaretCoordinate(range, axis) {
      const rect = getCollapsedRangeClientRect(range);
      if (!rect) {
        return null;
      }
      return axis === "y"
        ? (rect.top + rect.bottom) / 2
        : (rect.left + rect.right) / 2;
    }

    function getCollapsedRangeClientRect(range) {
      if (!range) {
        return null;
      }

      const probe = range.cloneRange();
      probe.collapse(true);
      const rect = probe.getClientRects()[0] || probe.getBoundingClientRect();
      probe.detach();
      if (!rect || (rect.width === 0 && rect.height === 0)) {
        return null;
      }
      return rect;
    }

    function getHorizontalTextLayerSelectionBlockerEdgeRange(page, blockerRect, lineRect, side) {
      const candidates = [];
      const tolerance = 1;
      const textNodes = Array.from(page.querySelectorAll(".textLayer span"))
        .filter(span => isVisibleTextLayerSpan(span) && !isInvisibleTextLayerSpan(span))
        .flatMap(getTextNodes);
      for (const textNode of textNodes) {
        const entries = getTextNodeGeometryEntries(textNode, "x");
        const fallbackForward = (entries[0]?.center || 0) <= (entries.at(-1)?.center || 0);
        for (let index = 0; index < entries.length; index += 1) {
          const entry = entries[index];
          const rect = getTextGeometryEntryClientRect(entry);
          if (
            !textSelectionRectsShareLine(rect, lineRect) ||
            clientRectsMeaningfullyOverlap(rect, blockerRect)
          ) {
            continue;
          }
          const isCandidate = side === "before"
            ? entry.end <= blockerRect.left + tolerance
            : entry.start >= blockerRect.right - tolerance;
          if (!isCandidate) {
            continue;
          }
          const coordinate = side === "before" ? entry.end : entry.start;
          const forward = getTextGeometryEntryForward(entries, index, fallbackForward);
          candidates.push({
            textNode,
            offset: getTextGeometryEntryOffsetForCoordinate(entry, coordinate, forward),
            startOffset: entry.startOffset,
            endOffset: entry.endOffset,
            text: entry.text || "",
            coordinate,
            isWhitespace: isWhitespaceTextSelectionSegment(entry.text)
          });
        }
      }
      if (!candidates.length) {
        return null;
      }

      const target = getTextLayerSelectionBlockerEdgeCandidate(candidates, side);
      const range = createCollapsedTextLayerRange(
        target.textNode,
        getTextLayerSelectionBlockerEdgeCandidateOffset(target, side)
      );
      if (range) {
        range.__preserveSingleBoundaryWhitespace = true;
      }
      return range;
    }

    function getTextLayerSelectionBlockerEdgeCandidate(candidates, side) {
      const sorted = [...candidates].sort((a, b) => a.coordinate - b.coordinate);
      if (side === "before") {
        const lastTextIndex = findLastIndex(sorted, candidate => !candidate.isWhitespace);
        if (lastTextIndex >= 0) {
          const nextWhitespace = sorted.slice(lastTextIndex + 1)
            .find(candidate => candidate.isWhitespace);
          return nextWhitespace || sorted[lastTextIndex];
        }
        return sorted[sorted.length - 1];
      }

      const firstTextIndex = sorted.findIndex(candidate => !candidate.isWhitespace);
      if (firstTextIndex >= 0) {
        const previousWhitespace = sorted.slice(0, firstTextIndex)
          .reverse()
          .find(candidate => candidate.isWhitespace);
        return previousWhitespace || sorted[firstTextIndex];
      }
      return sorted[0];
    }

    function getTextLayerSelectionBlockerEdgeCandidateOffset(candidate, side) {
      if (!candidate) {
        return null;
      }

      if (side === "before") {
        const trailingWhitespaceLength = (candidate.text.match(/\s+$/)?.[0] || "").length;
        if (trailingWhitespaceLength > 1 && candidate.offset === candidate.endOffset) {
          return Math.max(candidate.startOffset, candidate.offset - (trailingWhitespaceLength - 1));
        }
        return candidate.offset;
      }

      const leadingWhitespaceLength = (candidate.text.match(/^\s+/)?.[0] || "").length;
      if (leadingWhitespaceLength > 1 && candidate.offset === candidate.startOffset) {
        return Math.min(candidate.endOffset, candidate.offset + (leadingWhitespaceLength - 1));
      }
      return candidate.offset;
    }

    function findLastIndex(items, predicate) {
      for (let index = items.length - 1; index >= 0; index -= 1) {
        if (predicate(items[index], index, items)) {
          return index;
        }
      }
      return -1;
    }

    function getTextGeometryEntryClientRect(entry) {
      return {
        left: entry.left,
        right: entry.right,
        top: entry.top,
        bottom: entry.bottom,
        width: entry.width,
        height: entry.height
      };
    }

    function createCollapsedTextLayerRange(textNode, offset) {
      if (!isTextLayerTextNode(textNode) || !Number.isInteger(offset)) {
        return null;
      }

      const range = document.createRange();
      range.setStart(textNode, Math.max(0, Math.min(offset, textNode.nodeValue.length)));
      range.collapse(true);
      return range;
    }

    function updateTextSelectionOverlay(anchorRange, focusRange) {
      if (!anchorRange || !focusRange) {
        clearTextSelectionOverlay();
        return;
      }

      let range = null;
      try {
        range = createTextLayerSelectionRange(anchorRange, focusRange);
        updateTextSelectionOverlayFromRange(range);
      } finally {
        range?.detach();
      }
    }

    function updateTextSelectionOverlayFromSelection(selection = window.getSelection()) {
      if (!selection || selection.isCollapsed || selection.rangeCount !== 1) {
        clearTextSelectionOverlay();
        return;
      }

      const range = selection.getRangeAt(0);
      if (!selectionRangeHasTextLayerText(range)) {
        clearTextSelectionOverlay();
        return;
      }

      updateTextSelectionOverlayFromRange(range);
    }

    function updateTextSelectionOverlayFromRange(range) {
      clearTextSelectionOverlay();
      const segments = getCrossPageTextSelectionSegmentsFromRange(range);
      if (!segments.length) {
        return;
      }

      let drawnRectCount = 0;
      for (const segment of segments) {
        drawnRectCount += drawTextSelectionOverlaySegment(segment.page, segment.range);
        segment.range.detach();
      }
      if (drawnRectCount > 0) {
        viewerEl.classList.add("cross-page-text-selection");
      } else {
        clearTextSelectionOverlay();
      }
    }

    function getCrossPageTextSelectionSegmentsFromRange(sourceRange) {
      if (!sourceRange || sourceRange.collapsed) {
        return [];
      }

      const startPage = nodeClosest(sourceRange.startContainer, ".page");
      const endPage = nodeClosest(sourceRange.endContainer, ".page");
      if (!startPage || !endPage || startPage === endPage) {
        return [];
      }

      const pages = Array.from(viewerEl.querySelectorAll(".page"));
      const startIndex = pages.indexOf(startPage);
      const endIndex = pages.indexOf(endPage);
      if (startIndex === -1 || endIndex === -1 || startIndex > endIndex) {
        return [];
      }

      const segments = [];
      for (let index = startIndex; index <= endIndex; index += 1) {
        const page = pages[index];
        const boundary = getPageTextBoundary(page);
        if (!boundary) {
          continue;
        }

        const range = document.createRange();
        if (index === startIndex) {
          range.setStart(sourceRange.startContainer, sourceRange.startOffset);
        } else {
          range.setStart(boundary.startNode, 0);
        }

        if (index === endIndex) {
          range.setEnd(sourceRange.endContainer, sourceRange.endOffset);
        } else {
          range.setEnd(boundary.endNode, boundary.endNode.nodeValue.length);
        }

        if (!range.collapsed) {
          segments.push({ page, range });
        } else {
          range.detach();
        }
      }
      return segments;
    }

    function getPageTextBoundary(page) {
      const textLayer = page?.querySelector?.(".textLayer");
      if (!textLayer) {
        return null;
      }

      const textNodes = getTextNodes(textLayer).filter(node => node.nodeValue);
      const startNode = textNodes[0] || null;
      const endNode = textNodes[textNodes.length - 1] || null;
      if (!startNode || !endNode) {
        return null;
      }
      return { startNode, endNode };
    }

    function drawTextSelectionOverlaySegment(page, range) {
      const rects = Array.from(range.getClientRects())
        .filter(rect => rect.width > 0 && rect.height > 0);
      if (!rects.length) {
        return 0;
      }

      const textLayer = page.querySelector(".textLayer");
      if (!textLayer) {
        return 0;
      }

      const textLayerRect = textLayer.getBoundingClientRect();
      let overlay = textLayer.querySelector(".textSelectionOverlay");
      if (!overlay) {
        overlay = document.createElement("div");
        overlay.className = "textSelectionOverlay";
        textLayer.appendChild(overlay);
      }

      for (const rect of rects) {
        const item = document.createElement("div");
        item.className = "textSelectionOverlayRect";
        item.style.left = `${rect.left - textLayerRect.left}px`;
        item.style.top = `${rect.top - textLayerRect.top}px`;
        item.style.width = `${rect.width}px`;
        item.style.height = `${rect.height}px`;
        overlay.appendChild(item);
      }
      return rects.length;
    }

    function clearTextSelectionOverlay() {
      viewerEl.classList.remove("cross-page-text-selection");
      for (const overlay of viewerEl.querySelectorAll(".textSelectionOverlay")) {
        overlay.remove();
      }
      hideSelectionHighlightPalette();
    }

    /* ==== R4 drag state cleanup (DPR viewer.js 10102-10158) ==== */
    function clearTextSelectionDragState(options = {}) {
      const hadActiveDragSelection = Boolean(textSelectionDragState?.dragging);
      stopTextSelectionAutoScroll();
      textSelectionDragState = null;
      if (options.clearTextLayerSelection || (options.clearActiveDragSelection && hadActiveDragSelection)) {
        clearTextLayerSelection();
      }
    }

    function clearTextLayerSelection() {
      const selection = window.getSelection();
      if (selectionHasTextLayerText(selection)) {
        selection.removeAllRanges();
      }
      clearTextSelectionOverlay();
    }

    function handleTextLayerSelectionChange() {
      const selection = window.getSelection();
      if (!selectionHasTextLayerText(selection)) {
        clearTextSelectionOverlay();
        return;
      }

      updateTextSelectionOverlayFromSelection(selection);
      updateSelectionHighlightPaletteFromSelection(selection);
    }

    function selectionRangeHasTextLayerText(range) {
      return Boolean(
        range &&
        !range.collapsed &&
        (nodeClosest(range.startContainer, ".textLayer") || nodeClosest(range.endContainer, ".textLayer"))
      );
    }

    function suppressNextTextSelectionClick(event) {
      suppressedTextSelectionClick = {
        clientX: event.clientX,
        clientY: event.clientY,
        time: performance.now()
      };
      if (suppressTextSelectionClickTimer) {
        clearTimeout(suppressTextSelectionClickTimer);
      }
      suppressTextSelectionClickTimer = setTimeout(() => {
        clearSuppressedTextSelectionClick();
      }, TEXT_SELECTION_CLICK_SUPPRESSION_MS);
    }

    function clearSuppressedTextSelectionClick() {
      suppressedTextSelectionClick = null;
      if (suppressTextSelectionClickTimer) {
        clearTimeout(suppressTextSelectionClickTimer);
        suppressTextSelectionClickTimer = null;
      }
    }

    /* ==================== lifecycle ==================== */

    // Capture-phase listeners on window are what let the engine win over
    // pdf.js's own text-layer handling; order matters, so binding lives here
    // rather than being spread across the host viewer.
    const bindings = [
      [containerEl, "click", handleTextSelectionDragClickSuppression, true],
      [containerEl, "click", handleTextLayerClickThrough, false],
      [containerEl, "click", handleTextSelectionClearClick, false],
      [containerEl, "mousedown", handleTextSelectionMouseDown, true],
      [document, "selectionchange", handleTextLayerSelectionChange, false],
      [document, "copy", handleTextLayerCopy, true],
      [window, "mousemove", handleTextSelectionMouseMove, true],
      [window, "mouseup", handleTextSelectionMouseUp, true],
      [window, "mouseup", handleSelectionHighlightPaletteMouseUpAnchor, true]
    ];

    function handleWindowBlur() {
      clearTextSelectionDragState({ clearActiveDragSelection: true });
    }

    function handleVisibilityChange() {
      if (document.hidden) {
        clearTextSelectionDragState({ clearActiveDragSelection: true });
      }
    }

    let attached = false;

    function attach() {
      if (attached) return;
      attached = true;
      for (const [target, type, handler, capture] of bindings) {
        target.addEventListener(type, handler, capture);
      }
      window.addEventListener("blur", handleWindowBlur);
      document.addEventListener("visibilitychange", handleVisibilityChange);
    }

    function detach() {
      if (!attached) return;
      attached = false;
      for (const [target, type, handler, capture] of bindings) {
        target.removeEventListener(type, handler, capture);
      }
      window.removeEventListener("blur", handleWindowBlur);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      clearTextSelectionDragState({ clearTextLayerSelection: true });
    }

    return {
      attach: attach,
      detach: detach,

      /** Wire to pdf.js `textlayerrendered`. Drops hidden OCR text that sits
       *  underneath visible text, so it can never enter a selection or the
       *  clipboard. OCR-only pages keep their text layer. */
      onTextLayerRendered: function (event) {
        const before = countInvisibleSpans(event);
        filterCoveredInvisibleTextLayerSpans(event);
        const after = countInvisibleSpans(event);
        if (before !== after) {
          hooks.trace("text-selection.invisible-spans-dropped", {
            page: Number(event?.pageNumber) || 0,
            dropped: before - after
          });
        }
      },

      /** Wire to pdf.js `annotationlayerrendered`. Classifies every annotation
       *  on the page as blocking / passthrough so the caret engine knows where
       *  it may not go. */
      onAnnotationLayerRendered: function (event) {
        return indexTextSelectionAnnotations(event);
      },

      /** Wire to `scalechanging`. Zoom invalidates every cached client rect. */
      onScaleChanging: function () {
        clearTextSelectionDragState({ clearTextLayerSelection: true });
      },

      /** Call before loading a different document. */
      reset: function () {
        // Emitted before the state is dropped so the payload still describes
        // what was being discarded. Without this, "selection stopped working
        // after I opened another PDF" has no breadcrumb showing whether the
        // engine was reset at all, or reset while a drag was still live.
        hooks.trace("text-selection.engine-reset", {
          indexedPages: textSelectionAnnotationIndex.size,
          dragActive: Boolean(textSelectionDragState)
        });
        clearTextSelectionDragState({ clearTextLayerSelection: true });
        textSelectionAnnotationIndex = new Map();
        selectionHighlightPalettePointerAnchor = null;
        autoScrollTraced = false;
      },

      clearSelection: clearTextLayerSelection,
      hasTextLayerSelection: function () {
        return Boolean(selectionHasTextLayerText(window.getSelection()));
      },

      // Surface consumed by the highlight layer. Deliberately a narrow,
      // explicit contract rather than letting that module reach into this
      // one: both need the same notion of "is this a text-layer selection",
      // and two independent answers to that question would drift.
      clearOverlay: clearTextSelectionOverlay,
      selectionHasTextLayerText: selectionHasTextLayerText,
      isTextLayerTextNode: isTextLayerTextNode,
      getEventElement: getEventElement,
      /** True while a drag-selection is actively growing. The highlight layer
       *  uses this to keep its palette hidden until the selection is final. */
      isDragging: function () {
        return Boolean(textSelectionDragState && textSelectionDragState.dragging);
      },
      getPointerAnchor: function () {
        return selectionHighlightPalettePointerAnchor;
      },

      /** Exposed so the highlight layer (P1) can reuse the same caret engine
       *  instead of growing a second, subtly different copy. */
      internals: {
        getTextLayerCaretRange: getTextLayerCaretRange,
        setTextLayerSelection: setTextLayerSelection,
        selectionHasTextLayerText: selectionHasTextLayerText,
        nodeClosest: nodeClosest,
        getTextSelectionBlockingAnnotationAtPoint: getTextSelectionBlockingAnnotationAtPoint
      }
    };

    function countInvisibleSpans(event) {
      const page =
        event?.source?.div ||
        viewerEl.querySelector(`.page[data-page-number="${event?.pageNumber}"]`);
      const textLayer = page?.querySelector?.(".textLayer");
      if (!textLayer) return 0;
      return textLayer.querySelectorAll("span[data-pdf-invisible-text='1']").length;
    }
  }

  window.OnwardPdfTextSelection = { create: create };
})();
