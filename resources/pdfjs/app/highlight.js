/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 *
 * PDF highlight layer: creating, rendering, relabelling, annotating and
 * deleting highlights over the pdf.js text layer.
 *
 * Split from the text-selection engine on purpose. Selection answers "which
 * characters does the user mean"; this module answers "what durable artefact
 * do we make out of that". It consumes the selection engine through a small
 * injected surface (`selectionApi`) rather than reaching into it, so neither
 * side can quietly grow a second copy of the other's logic.
 *
 * Persistence is likewise injected (`store`). This module never touches the
 * filesystem or pdf-lib; it produces and mutates plain annotation records and
 * tells the store when they changed. That keeps "is the geometry right" and
 * "did it reach the disk" as two independently testable questions.
 *
 * Highlights render into a `.highlightLayer` appended to each pdf.js page
 * element, NOT into pdf.js's own annotationLayer. Quads are stored in PDF user
 * space and re-projected through the page viewport on every render, so zoom
 * and rotation stay correct without re-deriving anything from screen pixels.
 *
 * Adapted from the Dark_PDF_Reader reference viewer (ISC-licensed, same
 * authors); reorganised, not rewritten.
 */

"use strict";

(function () {
  const {
    mergeRectsByLine,
    rectsToQuadPoints,
    quadsToUnionPdfRect,
    quadsToViewportRects,
    hexToRgbaString,
    getReadableTextColorForHex,
    normalizeHexColor,
    normalizeNotePopupWidth,
    normalizeNotePopupHeight,
    clamp,
    HIGHLIGHT_FILL_OPACITY,
    NOTE_POPUP_WIDTH_DEFAULT,
    NOTE_POPUP_HEIGHT_DEFAULT
  } = window.OnwardPdfHighlightCore;

  // A drag far enough from the palette's anchor page dismisses it, so the
  // panel never floats over unrelated content.
  const SELECTION_PALETTE_SCROLL_DISMISS_PX = 96;
  const PDF_TO_CSS_UNITS = 96 / 72;

  const NOOP = function () {};

  /**
   * Default label set. Names are placeholders — the host replaces them with
   * translated strings via `setLabels`, so the viewer never ships
   * single-language user-visible copy.
   */
  const DEFAULT_HIGHLIGHT_LABELS = [
    { id: "hl-key", name: "Key claim", color: "#f2c14e" },
    { id: "hl-question", name: "Questionable", color: "#5aa9e6" },
    { id: "hl-method", name: "Method", color: "#7bd88f" },
    { id: "hl-cite", name: "Citation", color: "#e58fb2" }
  ];

  function create(deps) {
    const viewerEl = deps.viewer;
    const containerEl = deps.viewerContainer;
    const viewerSectionEl = deps.viewerSection;
    const paletteEl = deps.palette;
    const notePopupEl = deps.notePopup;
    const getPageView = deps.getPageView;
    const getDocument = deps.getDocument;
    const getCurrentScale = deps.getCurrentScale;
    const selectionApi = deps.selectionApi;

    const els = {
      highlightHoverMarker: deps.hoverMarker,
      notePopupLabel: deps.notePopupLabel,
      notePopupSnippet: deps.notePopupSnippet,
      noteText: deps.noteText
    };

    // The annotation store owns the records and their persistence. Until the
    // store lands, an in-memory stub keeps the highlight layer fully usable
    // (highlights work, they just do not survive a reload).
    const store = deps.store || {
      annotations: [],
      markChanged: NOOP,
      scheduleSave: NOOP
    };

    const hooks = Object.assign(
      {
        onAnnotationsChanged: NOOP,
        onFirstAnnotationCreated: NOOP,
        persistNotePopupSize: NOOP,
        trace: NOOP
      },
      deps.hooks || {}
    );

    const trace = function (name, payload) { hooks.trace(name, payload); };

    // User-visible copy inside the highlight layer. English defaults only so
    // the viewer is usable standalone; the host overwrites them with the
    // active locale via setI18n(), same contract as the viewer toolbar.
    const I18N_DEFAULTS = {
      highlightChipHint: "Highlight the selected text with this label",
      highlightChipShortcut: ", shortcut {key}",
      hasNote: "Has a note",
      annotationFallbackLabel: "Annotation"
    };
    let i18n = { ...I18N_DEFAULTS };

    let highlightLabels = DEFAULT_HIGHLIGHT_LABELS.map(item => ({ ...item }));
    let activeHighlightLabelId = null;
    // Records the host wants outlined (git-compare diff emphasis). Rendered
    // as an extra class on the annotation rects; cleared on reset.
    let emphasizedAnnotationIds = new Set();
    let noteEditingAnnotId = null;
    let highlightSingleClickTimer = null;
    let pendingSelectionSnapshot = null;
    let selectionHighlightPaletteAnchor = null;
    let selectionHighlightPalettePointerAnchor = null;
    let selectionHighlightPaletteAnnotTarget = null;
    let selectionHighlightPaletteScrollFrame = null;
    let notePopupWidth = NOTE_POPUP_WIDTH_DEFAULT;
    let notePopupHeight = NOTE_POPUP_HEIGHT_DEFAULT;
    let notePopupResizeStarted = false;

    /* ==== label lookup (DPR 3343-3346) ==== */
    function getHighlightLabel(labelId) {
      return highlightLabels.find(label => label.id === labelId) || null;
    }


    /* ==== selection palette chips (DPR 3359-3443) ==== */
    function renderSelectionHighlightPalette() {
      if (!paletteEl) {
        return;
      }
      renderHighlightChipGroup(paletteEl, {
        itemClassName: "selection-highlight-chip",
        titleSuffix: i18n.highlightChipHint,
        includeShortcutHint: true,
        onClick: onSelectionHighlightChipClick
      });
    }

    function renderHighlightChipGroup(container, options) {
      container.textContent = "";
      const fragment = document.createDocumentFragment();

      for (let index = 0; index < highlightLabels.length; index += 1) {
        fragment.appendChild(createHighlightChip(highlightLabels[index], options, index));
      }

      container.appendChild(fragment);
    }

    function createHighlightChip(label, options, index) {
      const shortcut = options.includeShortcutHint && index < 9 ? String(index + 1) : "";
      const shortcutText = shortcut ? i18n.highlightChipShortcut.replace("{key}", shortcut) : "";
      const chip = document.createElement("button");
      chip.type = "button";
      chip.className = ["highlight-chip", options.itemClassName].filter(Boolean).join(" ");
      chip.dataset.labelId = label.id;
      chip.dataset.labelName = label.name;
      chip.title = label.name + " — " + options.titleSuffix + shortcutText;
      chip.setAttribute("aria-label", `${label.name}${shortcutText}`);
      if (label.id === activeHighlightLabelId) {
        chip.classList.add("active");
      }

      const dot = document.createElement("span");
      dot.className = "chip-dot";
      dot.style.background = label.color;
      dot.setAttribute("aria-hidden", "true");

      const name = document.createElement("span");
      name.className = "chip-name";
      name.textContent = label.name;
      name.setAttribute("aria-hidden", "true");

      chip.appendChild(dot);
      chip.appendChild(name);
      chip.addEventListener("mousedown", event => {
        captureSelectionSnapshot();
        event.preventDefault();
      }, true);
      chip.addEventListener("click", event => {
        event.preventDefault();
        options.onClick(label.id);
      });
      return chip;
    }

    function onSelectionHighlightChipClick(labelId) {
      if (applyLabelToSelectionHighlightTarget(labelId)) {
        return;
      }

      const segments =
        pendingSelectionSnapshot && pendingSelectionSnapshot.segments.length
          ? pendingSelectionSnapshot
          : collectSelectionQuadsByPage();
      pendingSelectionSnapshot = null;

      if (segments && segments.segments.length) {
        applyHighlightFromSegments(labelId, segments);
        return;
      }
      hideSelectionHighlightPalette({ clearSnapshot: true });
      activeHighlightLabelId = labelId;
      
    }

    // A chip mousedown takes focus and can collapse the selection before the
    // click handler runs, so snapshot the quads first.
    function captureSelectionSnapshot() {
      pendingSelectionSnapshot = collectSelectionQuadsByPage();
    }


    /* ==== selection -> annotation (DPR 3488-3545) ==== */
    function collectSelectionQuadsByPage() {
      const selection = window.getSelection();
      if (!selection || selection.isCollapsed || selection.rangeCount === 0) {
        return { segments: [], text: "" };
      }
      const range = selection.getRangeAt(0);
      const text = String(selection.toString() || "").trim();
      const rects = Array.from(range.getClientRects()).filter(
        rect => rect.width > 0 && rect.height > 0
      );
      if (!rects.length) {
        return { segments: [], text };
      }

      const pages = Array.from(viewerEl.querySelectorAll(".page"));
      const byPage = new Map();
      for (const rect of rects) {
        const cx = rect.left + rect.width / 2;
        const cy = rect.top + rect.height / 2;
        const pageEl = pages.find(page => {
          const box = page.getBoundingClientRect();
          return cx >= box.left && cx <= box.right && cy >= box.top && cy <= box.bottom;
        });
        if (!pageEl) {
          continue;
        }
        const pageNumber = Number.parseInt(pageEl.dataset.pageNumber, 10);
        if (!Number.isFinite(pageNumber)) {
          continue;
        }
        if (!byPage.has(pageNumber)) {
          byPage.set(pageNumber, { pageEl, rects: [] });
        }
        byPage.get(pageNumber).rects.push(rect);
      }

      const segments = [];
      for (const [pageNumber, entry] of byPage) {
        const pageView = getPageView(pageNumber - 1);
        const viewport = pageView?.viewport;
        const textLayer = entry.pageEl.querySelector(".textLayer");
        if (!viewport || !textLayer) {
          continue;
        }
        const origin = textLayer.getBoundingClientRect();
        const merged = mergeRectsByLine(
          entry.rects.map(rect => ({ left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom }))
        );
        const quads = rectsToQuadPoints(merged, origin, viewport);
        if (!quads.length) {
          continue;
        }
        segments.push({ pageNumber, quads, rectUnion: quadsToUnionPdfRect(quads) });
      }
      return { segments, text };
    }

    // Merge the selection's many small rects into one rect per line. Without
    // this, overlapping translucent blocks stack and the highlight comes out
    // visibly darker wherever two rects meet.

    /* ==== apply highlight (DPR 3604-3700) ==== */
    function applyHighlightFromSegments(labelId, selectionResult) {
      const label = getHighlightLabel(labelId);
      if (!label) {
        return;
      }
      const annotationCountBefore = store.annotations.length;
      const groupId = `hl-${Date.now().toString(36)}-${Math.floor(store.annotations.length)}`;
      const createdAt = Date.now();
      const affectedPages = new Set();
      const paletteAnchor = getSelectionHighlightPaletteAnchorRecord();

      for (const segment of selectionResult.segments) {
        store.annotations.push({
          id: `${groupId}-p${segment.pageNumber}`,
          groupId,
          labelId: label.id,
          labelName: label.name,
          color: label.color,
          page: segment.pageNumber,
          quads: segment.quads,
          rectUnion: segment.rectUnion,
          note: "",
          textSnapshot: selectionResult.text,
          paletteAnchor: paletteAnchor?.page === segment.pageNumber ? paletteAnchor : null,
          createdAt,
          updatedAt: createdAt
        });
        affectedPages.add(segment.pageNumber);
      }

      activeHighlightLabelId = label.id;
      
      for (const pageNumber of affectedPages) {
        renderHighlightLayerForPage(pageNumber);
      }
      clearNativeSelection();
      hideSelectionHighlightPalette({ clearSnapshot: true });
      hooks.onAnnotationsChanged();
      if (annotationCountBefore === 0 && store.annotations.length > 0) {
        hooks.onFirstAnnotationCreated();
      }
      store.markChanged("create");
      store.scheduleSave();
    }

    function applyLabelToSelectionHighlightTarget(labelId) {
      const target = selectionHighlightPaletteAnnotTarget;
      if (!target) {
        return false;
      }
      const label = getHighlightLabel(labelId);
      if (!label) {
        hideSelectionHighlightPalette({ clearSnapshot: true });
        return true;
      }

      const updatedAt = Date.now();
      const affectedPages = new Set();
      let changed = false;
      for (const annot of store.annotations) {
        const sameGroup = target.groupId
          ? annot.groupId === target.groupId
          : annot.id === target.annotId;
        if (!sameGroup) {
          continue;
        }
        annot.labelId = label.id;
        annot.labelName = label.name;
        annot.color = label.color;
        annot.updatedAt = updatedAt;
        affectedPages.add(annot.page);
        changed = true;
      }

      activeHighlightLabelId = label.id;
      
      hideSelectionHighlightPalette({ clearSnapshot: true });
      if (!changed) {
        return true;
      }
      for (const pageNumber of affectedPages) {
        renderHighlightLayerForPage(pageNumber);
      }
      hooks.onAnnotationsChanged();
      store.markChanged("relabel");
      store.scheduleSave();
      return true;
    }

    function clearNativeSelection() {
      const selection = window.getSelection();
      if (selection && !selection.isCollapsed) {
        selection.removeAllRanges();
      }
      selectionApi.clearOverlay();
    }


    /* ==== page highlight layer (DPR 3703-3765) ==== */
    function renderHighlightLayerForPage(pageNumber) {
      const pageView = getPageView(pageNumber - 1);
      const pageEl = pageView?.div;
      const viewport = pageView?.viewport;
      if (!pageEl || !viewport) {
        return;
      }

      let layer = pageEl.querySelector(":scope > .highlightLayer");
      if (!layer) {
        layer = document.createElement("div");
        layer.className = "highlightLayer";
        pageEl.appendChild(layer);
      }
      layer.textContent = "";

      const annotations = store.annotations.filter(annot => annot.page === pageNumber);
      if (!annotations.length) {
        return;
      }

      const fragment = document.createDocumentFragment();
      for (const annot of annotations) {
        const rawRects = quadsToViewportRects(annot.quads, viewport).map(rect => ({
          left: rect.left,
          top: rect.top,
          right: rect.left + rect.width,
          bottom: rect.top + rect.height
        }));
        // Merge by line again at render time, so records written by an older
        // version (whose quads may overlap) still paint evenly.
        const rects = mergeRectsByLine(rawRects);
        for (const rect of rects) {
          const el = document.createElement("div");
          el.className = "highlightAnnotRect";
          if (emphasizedAnnotationIds.has(annot.id)) {
            // Git-compare emphasis: the host outlines the records its diff
            // panel lists so a jump lands on something visually distinct.
            el.classList.add("highlightAnnotRect-emphasized");
          }
          el.style.left = `${rect.left}px`;
          el.style.top = `${rect.top}px`;
          el.style.width = `${rect.right - rect.left}px`;
          el.style.height = `${rect.bottom - rect.top}px`;
          el.style.background = hexToRgbaString(annot.color, HIGHLIGHT_FILL_OPACITY);
          el.dataset.annotId = annot.id;
          fragment.appendChild(el);
        }
        if (String(annot.note || "").trim() && rects.length) {
          const firstRect = rects[0];
          const marker = document.createElement("button");
          marker.type = "button";
          marker.className = "highlight-note-marker";
          marker.textContent = "◆";
          marker.title = i18n.hasNote;
          marker.dataset.annotId = annot.id;
          marker.style.left = `${Math.max(0, firstRect.right - 12)}px`;
          marker.style.top = `${Math.max(0, firstRect.top - 18)}px`;
          marker.addEventListener("click", event => {
            event.preventDefault();
            event.stopPropagation();
            openNoteEditor(annot.id, event.clientX, event.clientY);
          });
          fragment.appendChild(marker);
        }
      }
      layer.appendChild(fragment);
    }


    /* ==== refresh layers (DPR 3790-3799) ==== */
    function refreshAllHighlightLayers() {
      if (!getDocument()) {
        return;
      }
      const pages = new Set(store.annotations.map(annot => annot.page));
      for (const pageNumber of pages) {
        renderHighlightLayerForPage(pageNumber);
      }
    }


    /* ==== annotation interaction + note editor (DPR 5403-5606) ==== */
    function getAnnotationById(annotId) {
      return store.annotations.find(annot => annot.id === annotId) || null;
    }

    function handleHighlightSingleClick(event) {
      if (!getDocument() || !store.annotations.length || event.detail !== 1) {
        return;
      }
      const targetElement = selectionApi.getEventElement(event);
      if (
        targetElement?.closest("#selectionHighlightPalette") ||
        targetElement?.closest(".highlight-note-marker") ||
        targetElement?.closest("input, textarea, select, button, [contenteditable='true']")
      ) {
        return;
      }
      const annot = findAnnotationAtClientPoint(event.clientX, event.clientY);
      if (!annot) {
        return;
      }

      event.preventDefault();
      const clientX = event.clientX;
      const clientY = event.clientY;
      clearHighlightSingleClickTimer();
      highlightSingleClickTimer = setTimeout(() => {
        highlightSingleClickTimer = null;
        showSelectionHighlightPaletteForAnnotation(annot, clientX, clientY);
      }, 180);
    }

    function handleHighlightDblClick(event) {
      if (!getDocument() || !store.annotations.length) {
        return;
      }
      clearHighlightSingleClickTimer();
      const annot = findAnnotationAtClientPoint(event.clientX, event.clientY);
      if (!annot) {
        return;
      }
      // A double click selects a word; clear it so it does not interfere with
      // the next select-then-colour gesture.
      const selection = window.getSelection();
      if (selection && !selection.isCollapsed) {
        selection.removeAllRanges();
      }
      selectionApi.clearOverlay();
      hideSelectionHighlightPalette({ clearSnapshot: true });
      openNoteEditor(annot.id, event.clientX, event.clientY);
    }

    function clearHighlightSingleClickTimer() {
      if (highlightSingleClickTimer) {
        clearTimeout(highlightSingleClickTimer);
        highlightSingleClickTimer = null;
      }
    }

    function findAnnotationAtClientPoint(clientX, clientY) {
      const pages = Array.from(viewerEl.querySelectorAll(".page"));
      const pageEl = pages.find(page => {
        const box = page.getBoundingClientRect();
        return clientX >= box.left && clientX <= box.right && clientY >= box.top && clientY <= box.bottom;
      });
      if (!pageEl) {
        return null;
      }
      const pageNumber = Number.parseInt(pageEl.dataset.pageNumber, 10);
      const pageView = getPageView(pageNumber - 1);
      const viewport = pageView?.viewport;
      const textLayer = pageEl.querySelector(".textLayer");
      if (!viewport || !textLayer) {
        return null;
      }
      const origin = textLayer.getBoundingClientRect();
      const [px, py] = viewport.convertToPdfPoint(clientX - origin.left, clientY - origin.top);
      for (const annot of store.annotations) {
        if (annot.page !== pageNumber) {
          continue;
        }
        for (let i = 0; i + 7 < annot.quads.length; i += 8) {
          const xs = [annot.quads[i], annot.quads[i + 2], annot.quads[i + 4], annot.quads[i + 6]];
          const ys = [annot.quads[i + 1], annot.quads[i + 3], annot.quads[i + 5], annot.quads[i + 7]];
          if (
            px >= Math.min(...xs) &&
            px <= Math.max(...xs) &&
            py >= Math.min(...ys) &&
            py <= Math.max(...ys)
          ) {
            return annot;
          }
        }
      }
      return null;
    }

    function handleHighlightHoverMarker(event) {
      if (!els.highlightHoverMarker || !store.annotations.length) {
        return;
      }
      const annot = findAnnotationAtClientPoint(event.clientX, event.clientY);
      if (!annot || !String(annot.note || "").trim()) {
        hideHighlightHoverMarker();
        return;
      }
      els.highlightHoverMarker.textContent = i18n.hasNote;
      els.highlightHoverMarker.hidden = false;
      const left = Math.min(event.clientX + 12, window.innerWidth - 76);
      const top = Math.min(event.clientY + 12, window.innerHeight - 28);
      els.highlightHoverMarker.style.left = `${Math.max(8, left)}px`;
      els.highlightHoverMarker.style.top = `${Math.max(8, top)}px`;
    }

    function hideHighlightHoverMarker() {
      if (els.highlightHoverMarker) {
        els.highlightHoverMarker.hidden = true;
      }
    }

    function closeNoteEditorFromOutsideClick(event) {
      if (notePopupEl.hidden) {
        return;
      }
      const target = selectionApi.getEventElement(event);
      if (
        !target ||
        notePopupEl.contains(target) ||
        target.closest(".highlight-note-marker") ||
        target.closest(".floating-highlight-toolbar")
      ) {
        return;
      }
      closeNoteEditor();
    }

    function openNoteEditor(annotId, clientX, clientY) {
      const annot = getAnnotationById(annotId);
      if (!annot) {
        return;
      }
      noteEditingAnnotId = annotId;
      els.notePopupLabel.textContent = annot.labelName || i18n.annotationFallbackLabel;
      els.notePopupLabel.style.background = hexToRgbaString(annot.color, 0.9);
      els.notePopupLabel.style.color = getReadableTextColorForHex(annot.color);
      els.notePopupSnippet.textContent = annot.textSnapshot || "";
      els.noteText.value = annot.note || "";

      notePopupEl.hidden = false;
      applyNotePopupSize();
      const popupRect = notePopupEl.getBoundingClientRect();
      const popupWidth = Math.min(popupRect.width, window.innerWidth - 24);
      const popupHeight = Math.min(popupRect.height, window.innerHeight - 76);
      const px = typeof clientX === "number" ? clientX : window.innerWidth / 2;
      const py = typeof clientY === "number" ? clientY : window.innerHeight / 2;
      const left = Math.max(12, Math.min(px, window.innerWidth - popupWidth - 12));
      const top = Math.max(64, Math.min(py + 12, window.innerHeight - popupHeight - 12));
      notePopupEl.style.left = `${left}px`;
      notePopupEl.style.top = `${top}px`;
      els.noteText.focus();
    }

    function closeNoteEditor() {
      noteEditingAnnotId = null;
      notePopupEl.hidden = true;
    }

    function onNoteTextInput() {
      const annot = getAnnotationById(noteEditingAnnotId);
      if (!annot) {
        return;
      }
      const previousNote = annot.note || "";
      annot.note = els.noteText.value;
      annot.updatedAt = Date.now();
      if (previousNote.trim() !== annot.note.trim()) {
        renderHighlightLayerForPage(annot.page);
      }
      store.markChanged("note-edit");
      store.scheduleSave();
      trace("highlight.note-edited", { page: annot.page, chars: String(annot.note || "").length });
      hooks.onAnnotationsChanged();
    }

    function deleteCurrentAnnotation() {
      const annot = getAnnotationById(noteEditingAnnotId);
      if (!annot) {
        return;
      }
      const page = annot.page;
      const countBefore = store.annotations.length;
      // Splice rather than reassign: the store exposes `annotations` as a
      // getter over the array it owns, so an assignment would throw in strict
      // mode — and would also hand the store a different array than the one it
      // fingerprints for save decisions.
      for (let index = store.annotations.length - 1; index >= 0; index -= 1) {
        if (store.annotations[index].id === annot.id) {
          store.annotations.splice(index, 1);
        }
      }
      closeNoteEditor();
      renderHighlightLayerForPage(page);
      hooks.onAnnotationsChanged();
      store.markChanged("delete");
      store.scheduleSave();
      trace("highlight.deleted", {
        page: annot.page,
        removed: countBefore - store.annotations.length,
        remaining: store.annotations.length
      });
    }

    /* ==== note popup sizing (DPR 5648-5690) ==== */
    function applyNotePopupSize() {
      const width = normalizeNotePopupWidth(notePopupWidth);
      notePopupEl.style.width = `${width}px`;
      if (notePopupHeight > 0) {
        notePopupEl.style.height = `${normalizeNotePopupHeight(notePopupHeight)}px`;
      } else {
        notePopupEl.style.removeProperty("height");
      }
    }

    function persistVisibleNotePopupSize() {
      if (!notePopupResizeStarted) {
        return;
      }
      notePopupResizeStarted = false;
      if (!notePopupEl || notePopupEl.hidden) {
        return;
      }
      const rect = notePopupEl.getBoundingClientRect();
      const nextWidth = normalizeNotePopupWidth(Math.round(rect.width));
      const nextHeight = normalizeNotePopupHeight(Math.round(rect.height));
      if (nextWidth === notePopupWidth && nextHeight === notePopupHeight) {
        return;
      }
      notePopupWidth = nextWidth;
      notePopupHeight = nextHeight;
      hooks.persistNotePopupSize(notePopupWidth, notePopupHeight);
    }

    function markNotePopupResizeStart(event) {
      if (!notePopupEl || notePopupEl.hidden) {
        notePopupResizeStarted = false;
        return;
      }
      const point = event.touches?.[0] || event;
      const rect = notePopupEl.getBoundingClientRect();
      notePopupResizeStarted =
        point.clientX >= rect.right - 28 &&
        point.clientY >= rect.bottom - 28 &&
        point.clientX <= rect.right + 4 &&
        point.clientY <= rect.bottom + 4;
    }


    /* ==== palette positioning (DPR 9638-10101) ==== */
    function hideSelectionHighlightPalette(options = {}) {
      if (!paletteEl) {
        return;
      }
      paletteEl.hidden = true;
      paletteEl.style.left = "";
      paletteEl.style.top = "";
      paletteEl.style.visibility = "";
      selectionHighlightPaletteAnchor = null;
      selectionHighlightPalettePointerAnchor = null;
      selectionHighlightPaletteAnnotTarget = null;
      if (selectionHighlightPaletteScrollFrame) {
        cancelAnimationFrame(selectionHighlightPaletteScrollFrame);
        selectionHighlightPaletteScrollFrame = null;
      }
      if (viewerSectionEl && paletteEl.parentElement !== viewerSectionEl) {
        viewerSectionEl.appendChild(paletteEl);
      }
      if (options.clearSnapshot) {
        pendingSelectionSnapshot = null;
      }
    }

    function showSelectionHighlightPaletteForAnnotation(annot, clientX, clientY) {
      const anchor = getSelectionPaletteAnchorFromAnnotation(annot, clientX, clientY);
      if (!anchor) {
        return;
      }
      const selection = window.getSelection();
      if (selection && !selection.isCollapsed) {
        selection.removeAllRanges();
      }
      selectionApi.clearOverlay();
      pendingSelectionSnapshot = null;
      selectionHighlightPaletteAnnotTarget = {
        annotId: annot.id,
        groupId: annot.groupId || null
      };
      activeHighlightLabelId = annot.labelId || activeHighlightLabelId;
      renderSelectionHighlightPalette();
      positionSelectionHighlightPalette(anchor);
    }

    function isSelectionHighlightPaletteVisible() {
      return Boolean(paletteEl && !paletteEl.hidden);
    }

    function updateSelectionHighlightPaletteFromSelection(selection = window.getSelection()) {
      if (!paletteEl || !selectionApi.selectionHasTextLayerText(selection) || selection.rangeCount !== 1) {
        hideSelectionHighlightPalette();
        return;
      }
      // Mid-drag the selection is still growing, so a palette would jump
      // around under the cursor. It appears on mouseup, once the selection is
      // final. Drag state belongs to the selection engine, so ask it rather
      // than keeping a second copy here.
      if (selectionApi.isDragging()) {
        hideSelectionHighlightPalette();
        return;
      }

      const snapshot = collectSelectionQuadsByPage();
      if (!snapshot.segments.length) {
        hideSelectionHighlightPalette();
        return;
      }

      const anchor = getSelectionPaletteAnchor(selection);
      if (!anchor) {
        hideSelectionHighlightPalette();
        return;
      }

      pendingSelectionSnapshot = snapshot;
      renderSelectionHighlightPalette();
      positionSelectionHighlightPalette(anchor);
    }

    function getSelectionViewportRect(selection) {
      if (!selection || selection.rangeCount !== 1) {
        return null;
      }
      const range = selection.getRangeAt(0);
      const rects = Array.from(range.getClientRects()).filter(rect => rect.width > 0 && rect.height > 0);
      if (!rects.length) {
        return null;
      }
      const bounds = rects.reduce(
        (acc, rect) => ({
          left: Math.min(acc.left, rect.left),
          right: Math.max(acc.right, rect.right),
          top: Math.min(acc.top, rect.top),
          bottom: Math.max(acc.bottom, rect.bottom)
        }),
        { left: Infinity, right: -Infinity, top: Infinity, bottom: -Infinity }
      );
      return {
        left: bounds.left,
        right: bounds.right,
        top: bounds.top,
        bottom: bounds.bottom,
        width: bounds.right - bounds.left,
        height: bounds.bottom - bounds.top
      };
    }

    function getSelectionPaletteAnchor(selection) {
      if (!selection || selection.rangeCount !== 1) {
        return null;
      }
      const pointAnchor = getSelectionPaletteAnchorFromPointer(selection) ||
        getSelectionPaletteAnchorFromFocus(selection);
      if (pointAnchor) {
        return pointAnchor;
      }

      const range = selection.getRangeAt(0);
      const rects = Array.from(range.getClientRects()).filter(rect => rect.width > 0 && rect.height > 0);
      if (!rects.length) {
        return null;
      }
      const anchorRect = rects[0];
      const centerX = anchorRect.left + anchorRect.width / 2;
      const centerY = anchorRect.top + anchorRect.height / 2;
      const pageEl = Array.from(viewerEl.querySelectorAll(".page")).find(page => {
        const rect = page.getBoundingClientRect();
        return centerX >= rect.left && centerX <= rect.right && centerY >= rect.top && centerY <= rect.bottom;
      });
      if (!pageEl) {
        return null;
      }
      return { pageEl, selectionRect: anchorRect };
    }

    function setSelectionHighlightPalettePointerAnchor(clientX, clientY) {
      if (!Number.isFinite(clientX) || !Number.isFinite(clientY)) {
        selectionHighlightPalettePointerAnchor = null;
        return;
      }
      selectionHighlightPalettePointerAnchor = {
        clientX,
        clientY,
        time: performance.now()
      };
    }

    function getSelectionPaletteAnchorFromPointer(selection) {
      const anchor = selectionHighlightPalettePointerAnchor;
      if (!anchor || performance.now() - anchor.time > 2000) {
        selectionHighlightPalettePointerAnchor = null;
        return null;
      }
      const paletteAnchor = getSelectionPaletteAnchorFromClientPoint(anchor.clientX, anchor.clientY, selection);
      if (!paletteAnchor) {
        selectionHighlightPalettePointerAnchor = null;
        return null;
      }
      return paletteAnchor;
    }

    function getSelectionPaletteAnchorFromFocus(selection) {
      const focusPoint = getSelectionFocusClientPoint(selection);
      if (!focusPoint) {
        return null;
      }
      return getSelectionPaletteAnchorFromClientPoint(focusPoint.clientX, focusPoint.clientY, selection);
    }

    function getSelectionPaletteAnchorFromClientPoint(clientX, clientY, selection) {
      const pageEl = getPageElementForPaletteClientPoint(clientX, clientY, selection);
      if (!pageEl) {
        return null;
      }
      const selectionRect = getSelectionViewportRect(selection);
      if (!selectionRect) {
        return null;
      }
      return {
        pageEl,
        selectionRect,
        anchorPoint: { clientX, clientY }
      };
    }

    function getSelectionPaletteAnchorFromAnnotation(annot, clientX, clientY) {
      if (!annot) {
        return null;
      }
      const pageEl = viewerEl.querySelector(`.page[data-page-number="${annot.page}"]`);
      if (!pageEl) {
        return null;
      }
      const selectionRect = getAnnotationViewportUnionRect(annot);
      if (!selectionRect) {
        return null;
      }
      const storedAnchor = getStoredPaletteAnchorForAnnotation(annot);
      if (storedAnchor) {
        return {
          pageEl,
          selectionRect,
          anchorLocalPoint: storedAnchor
        };
      }
      return {
        pageEl,
        selectionRect,
        anchorPoint: { clientX, clientY }
      };
    }

    function getStoredPaletteAnchorForAnnotation(annot) {
      const groupId = annot.groupId || "";
      const source = store.annotations.find(item => {
        if (item.page !== annot.page) {
          return false;
        }
        if (groupId && item.groupId !== groupId) {
          return false;
        }
        if (!groupId && item.id !== annot.id) {
          return false;
        }
        return Boolean(normalizePaletteAnchorRecord(item.paletteAnchor));
      });
      return normalizePaletteAnchorRecord(source?.paletteAnchor || annot.paletteAnchor);
    }

    function getAnnotationViewportUnionRect(annot) {
      const pageView = getPageView(annot.page - 1);
      const viewport = pageView?.viewport;
      if (!viewport) {
        return null;
      }
      const rects = mergeRectsByLine(quadsToViewportRects(annot.quads, viewport).map(rect => ({
        left: rect.left,
        top: rect.top,
        right: rect.left + rect.width,
        bottom: rect.top + rect.height
      })));
      if (!rects.length) {
        return null;
      }
      const pageEl = pageView.div;
      const pageRect = pageEl.getBoundingClientRect();
      const bounds = rects.reduce(
        (acc, rect) => ({
          left: Math.min(acc.left, pageRect.left + rect.left),
          top: Math.min(acc.top, pageRect.top + rect.top),
          right: Math.max(acc.right, pageRect.left + rect.right),
          bottom: Math.max(acc.bottom, pageRect.top + rect.bottom)
        }),
        { left: Infinity, top: Infinity, right: -Infinity, bottom: -Infinity }
      );
      return {
        left: bounds.left,
        top: bounds.top,
        right: bounds.right,
        bottom: bounds.bottom,
        width: bounds.right - bounds.left,
        height: bounds.bottom - bounds.top
      };
    }

    function getSelectionHighlightPaletteAnchorRecord() {
      return normalizePaletteAnchorRecord(selectionHighlightPaletteAnchor?.anchorLocalPoint);
    }

    function normalizePaletteAnchorRecord(value) {
      const page = Number.parseInt(value?.page, 10);
      const x = Number(value?.x);
      const y = Number(value?.y);
      if (!Number.isFinite(page) || page <= 0 || !Number.isFinite(x) || !Number.isFinite(y)) {
        return null;
      }
      return { page, x, y };
    }

    function getPageElementForPaletteClientPoint(clientX, clientY, selection) {
      const pageAtPoint = document.elementFromPoint(clientX, clientY)?.closest(".page");
      if (pageAtPoint && viewerEl.contains(pageAtPoint)) {
        return pageAtPoint;
      }

      const range = selection?.rangeCount === 1 ? selection.getRangeAt(0) : null;
      const rects = range
        ? Array.from(range.getClientRects()).filter(rect => rect.width > 0 && rect.height > 0)
        : [];
      const containingRect = rects.find(rect =>
        clientX >= rect.left - 12 &&
          clientX <= rect.right + 12 &&
          clientY >= rect.top - 12 &&
          clientY <= rect.bottom + 12
      );
      if (containingRect) {
        const centerX = containingRect.left + containingRect.width / 2;
        const centerY = containingRect.top + containingRect.height / 2;
        return document.elementFromPoint(centerX, centerY)?.closest(".page") || null;
      }

      return null;
    }

    function getSelectionFocusClientPoint(selection) {
      if (!selection || !selectionApi.isTextLayerTextNode(selection.focusNode)) {
        return null;
      }
      try {
        const range = document.createRange();
        range.setStart(selection.focusNode, selection.focusOffset);
        range.collapse(true);
        let rect = range.getBoundingClientRect();
        if (!rect || rect.height <= 0) {
          rect = getSelectionFocusFallbackRect(selection);
        }
        range.detach();
        if (!rect || rect.height <= 0) {
          return null;
        }
        return {
          clientX: rect.left + rect.width / 2,
          clientY: rect.top + rect.height / 2
        };
      } catch (error) {
        return null;
      }
    }

    function getSelectionFocusFallbackRect(selection) {
      const range = selection?.rangeCount === 1 ? selection.getRangeAt(0) : null;
      if (!range) {
        return null;
      }
      const focusNode = selection.focusNode;
      const rects = Array.from(range.getClientRects()).filter(rect => rect.width > 0 && rect.height > 0);
      if (!rects.length) {
        return null;
      }
      if (focusNode === range.endContainer) {
        return rects[rects.length - 1];
      }
      if (focusNode === range.startContainer) {
        return rects[0];
      }
      return rects[rects.length - 1];
    }

    function positionSelectionHighlightPalette(anchor) {
      const palette = paletteEl;
      const pageEl = anchor?.pageEl;
      const selectionRect = anchor?.selectionRect;
      if (!palette || !pageEl || !selectionRect) {
        return;
      }

      palette.style.visibility = "hidden";
      palette.hidden = false;
      if (palette.parentElement !== pageEl) {
        pageEl.appendChild(palette);
      }

      const geometry = measurePagePaletteGeometry(pageEl, palette);
      const anchorLocal = resolvePaletteAnchorLocal(anchor, selectionRect, geometry);
      const preferredLeft = anchorLocal.anchorX - geometry.paletteWidth / 2;
      const preferredTop = anchorLocal.anchorTop - geometry.paletteHeight - geometry.gapY;
      const fallbackTop = anchorLocal.anchorBottom + geometry.gapY;
      const top = preferredTop >= geometry.minTop ? preferredTop : fallbackTop;

      palette.style.left = `${Math.round(clamp(preferredLeft, geometry.minLeft, geometry.maxLeft))}px`;
      palette.style.top = `${Math.round(clamp(top, geometry.minTop, geometry.maxTop))}px`;
      palette.style.visibility = "";
      selectionHighlightPaletteAnchor = {
        pageEl,
        initialSelectionRect: {
          left: selectionRect.left,
          top: selectionRect.top,
          right: selectionRect.right,
          bottom: selectionRect.bottom
        },
        anchorLocalPoint: {
          page: Number.parseInt(pageEl.dataset.pageNumber, 10),
          x: anchorLocal.anchorX,
          y: anchorLocal.anchorTop
        }
      };
    }

    /**
     * Page-local coordinate system for palette placement: content-box origin
     * in client space, CSS-transform scale factors, and the clamped movement
     * bounds for the palette inside the page.
     */
    function measurePagePaletteGeometry(pageEl, palette) {
      const pageRect = pageEl.getBoundingClientRect();
      const paletteRect = palette.getBoundingClientRect();
      const borderLeft = pageEl.clientLeft || 0;
      const borderTop = pageEl.clientTop || 0;
      const offsetWidth = pageEl.offsetWidth || pageRect.width;
      const offsetHeight = pageEl.offsetHeight || pageRect.height;
      const localWidth = pageEl.clientWidth || offsetWidth;
      const localHeight = pageEl.clientHeight || offsetHeight;
      const scaleX = pageRect.width > 0 && offsetWidth > 0 ? pageRect.width / offsetWidth : 1;
      const scaleY = pageRect.height > 0 && offsetHeight > 0 ? pageRect.height / offsetHeight : 1;
      const margin = 8;
      const gap = 10;
      const marginX = margin / scaleX;
      const marginY = margin / scaleY;
      const paletteWidth = palette.offsetWidth || paletteRect.width / scaleX;
      const paletteHeight = palette.offsetHeight || paletteRect.height / scaleY;
      const minLeft = marginX;
      const minTop = marginY;
      return {
        contentLeft: pageRect.left + borderLeft * scaleX,
        contentTop: pageRect.top + borderTop * scaleY,
        scaleX,
        scaleY,
        gapY: gap / scaleY,
        paletteWidth,
        paletteHeight,
        minLeft,
        maxLeft: Math.max(minLeft, localWidth - paletteWidth - marginX),
        minTop,
        maxTop: Math.max(minTop, localHeight - paletteHeight - marginY)
      };
    }

    /**
     * Anchor priority: a persisted page-local point (restored highlights) >
     * the live pointer position > the selection rect itself.
     */
    function resolvePaletteAnchorLocal(anchor, selectionRect, geometry) {
      const anchorPoint = anchor.anchorPoint;
      const anchorLocalPoint = normalizePaletteAnchorRecord(anchor.anchorLocalPoint);
      const anchorX = anchorLocalPoint
        ? anchorLocalPoint.x
        : anchorPoint
        ? (anchorPoint.clientX - geometry.contentLeft) / geometry.scaleX
        : (selectionRect.left - geometry.contentLeft + selectionRect.width / 2) / geometry.scaleX;
      const anchorTop = anchorLocalPoint
        ? anchorLocalPoint.y
        : anchorPoint
        ? (anchorPoint.clientY - geometry.contentTop) / geometry.scaleY
        : (selectionRect.top - geometry.contentTop) / geometry.scaleY;
      const anchorBottom = anchorLocalPoint
        ? anchorLocalPoint.y
        : anchorPoint
        ? (anchorPoint.clientY - geometry.contentTop) / geometry.scaleY
        : (selectionRect.bottom - geometry.contentTop) / geometry.scaleY;
      return { anchorX, anchorTop, anchorBottom };
    }

    function scheduleSelectionHighlightPaletteScrollCheck() {
      if (!isSelectionHighlightPaletteVisible()) {
        return;
      }
      if (selectionHighlightPaletteScrollFrame) {
        cancelAnimationFrame(selectionHighlightPaletteScrollFrame);
      }
      selectionHighlightPaletteScrollFrame = requestAnimationFrame(() => {
        selectionHighlightPaletteScrollFrame = null;
        handleSelectionHighlightPaletteScroll();
      });
    }

    function handleSelectionHighlightPaletteScroll() {
      if (!isSelectionHighlightPaletteVisible() || !selectionHighlightPaletteAnchor) {
        return;
      }
      const selection = window.getSelection();
      if (!selectionApi.selectionHasTextLayerText(selection)) {
        hideSelectionHighlightPalette({ clearSnapshot: true });
        return;
      }
      const rect = getSelectionViewportRect(selection);
      if (!rect || !selectionRectIntersectsViewer(rect)) {
        hideSelectionHighlightPalette({ clearSnapshot: true });
        return;
      }
      const initial = selectionHighlightPaletteAnchor.initialSelectionRect;
      if (Math.abs(rect.top - initial.top) > SELECTION_PALETTE_SCROLL_DISMISS_PX) {
        hideSelectionHighlightPalette({ clearSnapshot: true });
      }
    }

    function selectionRectIntersectsViewer(rect) {
      const viewerRect = containerEl.getBoundingClientRect();
      return (
        rect.bottom >= viewerRect.top + 12 &&
        rect.top <= viewerRect.bottom - 12 &&
        rect.right >= viewerRect.left + 12 &&
        rect.left <= viewerRect.right - 12
      );
    }


    /* ==================== host-driven navigation ==================== */

    /**
     * Scroll to a highlight using pdf.js's own destination machinery, with an
     * /XYZ destination built from the annotation's bounding box.
     *
     * Deliberately the same call the outline uses. Two navigation paths that
     * land a target at different offsets feel like two different products, and
     * the reference project fixed exactly that complaint by unifying them.
     * `ignoreDestinationZoom` keeps the user's zoom rather than resetting it.
     */
    function scrollToAnnotation(annotationId) {
      const annot = getAnnotationById(annotationId);
      if (!annot) return;
      const destination = getAnnotationPdfDestination(annot);
      if (!destination) {
        // No usable geometry (a record written before quads were stored, say).
        // Landing on the right page still beats doing nothing.
        const document = getDocument();
        if (document && Number.isInteger(annot.page)) {
          deps.setPageNumber(annot.page);
        }
        return;
      }
      deps.scrollPageIntoView({
        pageNumber: annot.page,
        destArray: destination,
        ignoreDestinationZoom: true
      });
    }

    function getAnnotationPdfDestination(annot) {
      if (!Number.isInteger(annot && annot.page) || annot.page < 1) return null;
      const rect = Array.isArray(annot.rectUnion) && annot.rectUnion.length >= 4
        ? annot.rectUnion
        : quadsToUnionPdfRect(annot.quads || []);
      const left = rect[0];
      const top = rect[3];
      if (!Number.isFinite(left) || !Number.isFinite(top)) return null;
      return [annot.page - 1, { name: "XYZ" }, Math.max(0, left), top, null];
    }

    function deleteAnnotationById(annotationId) {
      const annot = getAnnotationById(annotationId);
      if (!annot) return;
      // Route through the note editor's delete path so there is one place that
      // knows how to remove a record, repaint its page and notify the store.
      openNoteEditor(annot.id, 0, 0);
      deleteCurrentAnnotation();
    }

    /* ==================== lifecycle ==================== */

    const bindings = [
      // Single click relabels an existing highlight; double click opens its
      // note. The single-click handler defers on a timer so a double click
      // does not also fire the relabel path.
      [containerEl, "click", handleHighlightSingleClick, false],
      [containerEl, "dblclick", handleHighlightDblClick, false],
      [containerEl, "mousemove", handleHighlightHoverMarker, false],
      [containerEl, "mouseleave", hideHighlightHoverMarker, false],
      [document, "click", closeNoteEditorFromOutsideClick, true],
      [document, "mousedown", markNotePopupResizeStart, true],
      [document, "mouseup", persistVisibleNotePopupSize, true]
    ];

    function handlePaletteMouseDown(event) {
      // The palette steals focus on mousedown, which collapses the selection
      // before the click handler runs. Snapshot the quads first.
      captureSelectionSnapshot();
      event.preventDefault();
      event.stopPropagation();
    }

    function handlePaletteClick(event) {
      event.stopPropagation();
    }

    function handleContainerScroll() {
      scheduleSelectionHighlightPaletteScrollCheck();
    }

    function handleNoteInput() {
      onNoteTextInput();
    }

    let attached = false;

    function attach() {
      if (attached) return;
      attached = true;
      for (const [target, type, handler, capture] of bindings) {
        target.addEventListener(type, handler, capture);
      }
      paletteEl.addEventListener("mousedown", handlePaletteMouseDown, true);
      paletteEl.addEventListener("click", handlePaletteClick);
      containerEl.addEventListener("scroll", handleContainerScroll, { passive: true });
      els.noteText.addEventListener("input", handleNoteInput);
      document.addEventListener("keydown", handleHighlightKeyDown, true);
      renderSelectionHighlightPalette();
    }

    function detach() {
      if (!attached) return;
      attached = false;
      for (const [target, type, handler, capture] of bindings) {
        target.removeEventListener(type, handler, capture);
      }
      paletteEl.removeEventListener("mousedown", handlePaletteMouseDown, true);
      paletteEl.removeEventListener("click", handlePaletteClick);
      containerEl.removeEventListener("scroll", handleContainerScroll);
      els.noteText.removeEventListener("input", handleNoteInput);
      document.removeEventListener("keydown", handleHighlightKeyDown, true);
      clearHighlightSingleClickTimer();
      closeNoteEditor();
      hideSelectionHighlightPalette({ clearSnapshot: true });
    }

    /**
     * Digit 1-9 applies the Nth label to the current selection; Escape
     * dismisses. Bound at document level in capture so it wins over the
     * viewer's own shortcuts, but only while the palette is actually up and
     * the user is not typing.
     */
    function handleHighlightKeyDown(event) {
      if (!isSelectionHighlightPaletteVisible()) return;
      if (event.altKey || event.ctrlKey || event.metaKey) return;
      const active = document.activeElement;
      const tag = active && active.tagName ? active.tagName.toLowerCase() : "";
      if (tag === "input" || tag === "textarea" || tag === "select" || (active && active.isContentEditable)) {
        return;
      }

      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        selectionApi.clearSelection();
        hideSelectionHighlightPalette({ clearSnapshot: true });
        return;
      }

      if (/^[1-9]$/.test(event.key)) {
        const label = highlightLabels[Number(event.key) - 1];
        if (!label) return;
        event.preventDefault();
        event.stopPropagation();
        onSelectionHighlightChipClick(label.id);
      }
    }

    /** Repaint every page that currently carries a highlight. */
    function refreshAll() {
      refreshAllHighlightLayers();
    }

    return {
      attach: attach,
      detach: detach,

      /** Host-supplied translations for the highlight layer's own copy. */
      setI18n: function (strings) {
        i18n = { ...I18N_DEFAULTS, ...(strings || {}) };
        renderSelectionHighlightPalette();
      },

      /** Host-supplied label set (translated names + colours). */
      setLabels: function (labels) {
        if (!Array.isArray(labels) || labels.length === 0) return;
        const normalized = labels
          .map(label => ({
            id: String(label && label.id ? label.id : ""),
            name: String(label && label.name ? label.name : ""),
            color: normalizeHexColor(label && label.color) || "#f2c14e"
          }))
          .filter(label => label.id && label.name);
        if (!normalized.length) return;
        highlightLabels = normalized;
        renderSelectionHighlightPalette();
        // Existing annotations keep their own stored colour; only the palette
        // and future highlights follow the new set.
      },
      getLabels: function () {
        return highlightLabels.map(label => ({ ...label }));
      },

      /** Note-popup size restored from host settings. */
      setNotePopupSize: function (width, height) {
        notePopupWidth = normalizeNotePopupWidth(width);
        notePopupHeight = normalizeNotePopupHeight(height);
        applyNotePopupSize();
      },

      /** Wire to pdf.js `textlayerrendered` — a re-rendered page has an empty
       *  highlight layer until we repaint it. */
      onPageRendered: function (pageNumber) {
        renderHighlightLayerForPage(pageNumber);
      },

      refreshAll: refreshAll,

      /** Called after the store loads or replaces the annotation set. */
      onAnnotationsReplaced: function () {
        closeNoteEditor();
        hideSelectionHighlightPalette({ clearSnapshot: true });
        refreshAllHighlightLayers();
      },

      /**
       * Host-selected records to outline (git-compare diff panel). Replaces
       * the whole set; an empty array clears the emphasis.
       */
      setEmphasizedAnnotations: function (ids) {
        emphasizedAnnotationIds = new Set(
          (Array.isArray(ids) ? ids : []).map(id => String(id)).filter(Boolean)
        );
        refreshAllHighlightLayers();
      },

      /** Drop all per-document UI state before another PDF loads. */
      reset: function () {
        clearHighlightSingleClickTimer();
        closeNoteEditor();
        hideSelectionHighlightPalette({ clearSnapshot: true });
        hideHighlightHoverMarker();
        activeHighlightLabelId = null;
        emphasizedAnnotationIds = new Set();
        for (const layer of viewerEl.querySelectorAll(".highlightLayer")) {
          layer.textContent = "";
        }
      },

      /** Test/host probes. */
      scrollToAnnotation: scrollToAnnotation,
      deleteAnnotationById: deleteAnnotationById,
      isPaletteVisible: isSelectionHighlightPaletteVisible,
      getActiveLabelId: function () { return activeHighlightLabelId; },
      applyLabelToSelection: onSelectionHighlightChipClick,
      openNoteEditor: openNoteEditor,
      closeNoteEditor: closeNoteEditor,
      deleteCurrentAnnotation: deleteCurrentAnnotation,
      getAnnotationCount: function () { return store.annotations.length; },
      updatePaletteFromSelection: updateSelectionHighlightPaletteFromSelection,
      setPalettePointerAnchor: setSelectionHighlightPalettePointerAnchor,
      hidePalette: hideSelectionHighlightPalette
    };
  }

  window.OnwardPdfHighlight = { create: create, DEFAULT_HIGHLIGHT_LABELS: DEFAULT_HIGHLIGHT_LABELS };
})();
