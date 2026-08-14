/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 *
 * Onward PDF viewer. Adapted from the Dark_PDF_Reader Chrome extension reference
 * (ISC-licensed) and stripped of all chrome.* / GitHub Issue / options-page code.
 * Loaded inside an <iframe> by the renderer; receives theme + i18n via postMessage.
 */

"use strict";

pdfjsLib.GlobalWorkerOptions.workerSrc = "../build/pdf.worker.js";

const DEFAULT_SCALE_VALUE = "page-width";
const MIN_SCALE = 0.25;
const MAX_SCALE = 5;
const SCALE_STEP = 1.1;

const I18N_DEFAULTS = {
  annotationsToggle: "Annotations",
  prevPage: "Previous page",
  nextPage: "Next page",
  zoomOut: "Zoom out",
  zoomIn: "Zoom in",
  zoom: "Zoom",
  customZoom: "Custom zoom (25%\u2013500%)",
  fitWidth: "Fit Width",
  fitPage: "Fit Page",
  searchPlaceholder: "Search text (Enter for next)",
  prevMatch: "Previous match",
  nextMatch: "Next match",
  colorToggleOn: "Temporarily disable dark",
  colorToggleOff: "Restore dark rendering",
  colorToggleTitleOn: "Temporarily view original colors",
  colorToggleTitleOff: "Restore Dark Mode rendering",
  close: "Close",
  cancel: "Cancel",
  confirm: "Confirm",
  passwordTitle: "Enter PDF password",
  passwordPrompt: "This PDF is encrypted. Please enter the password.",
  passwordIncorrect: "Incorrect password. Please try again.",
  emptyState: "No PDF loaded",
  errorInvalid: "The PDF file is corrupted or invalid.",
  errorMissing: "Unable to read the PDF file.",
  errorPassword: "The PDF requires a password; load was not completed.",
  errorUnexpected: "Unexpected response while reading the PDF.",
  errorGeneric: "Failed to open PDF."
};

const els = {
  fileName: document.getElementById("fileName"),
  prevPageBtn: document.getElementById("prevPageBtn"),
  nextPageBtn: document.getElementById("nextPageBtn"),
  pageNumberInput: document.getElementById("pageNumberInput"),
  pageCountLabel: document.getElementById("pageCountLabel"),
  zoomOutBtn: document.getElementById("zoomOutBtn"),
  zoomInBtn: document.getElementById("zoomInBtn"),
  zoomSelect: document.getElementById("zoomSelect"),
  customZoomOption: document.getElementById("customZoomOption"),
  customZoomInput: document.getElementById("customZoomInput"),
  searchInput: document.getElementById("searchInput"),
  searchPrevBtn: document.getElementById("searchPrevBtn"),
  searchNextBtn: document.getElementById("searchNextBtn"),
  searchResult: document.getElementById("searchResult"),
  colorToggleBtn: document.getElementById("colorToggleBtn"),
  annotationsToggleBtn: document.getElementById("annotationsToggleBtn"),
  annotationsToggleGroup: document.getElementById("annotationsToggleGroup"),
  annotationsToggleCount: document.getElementById("annotationsToggleCount"),
  viewerSection: document.getElementById("viewerSection"),
  viewerContainer: document.getElementById("viewerContainer"),
  viewer: document.getElementById("viewer"),
  errorBanner: document.getElementById("errorBanner"),
  errorMessage: document.getElementById("errorMessage"),
  errorCloseBtn: document.getElementById("errorCloseBtn"),
  passwordDialogBackdrop: document.getElementById("passwordDialogBackdrop"),
  passwordPrompt: document.getElementById("passwordPrompt"),
  passwordInput: document.getElementById("passwordInput"),
  passwordCancelBtn: document.getElementById("passwordCancelBtn"),
  passwordConfirmBtn: document.getElementById("passwordConfirmBtn"),
  selectionHighlightPalette: document.getElementById("selectionHighlightPalette"),
  notePopup: document.getElementById("notePopup"),
  notePopupLabel: document.getElementById("notePopupLabel"),
  notePopupSnippet: document.getElementById("notePopupSnippet"),
  noteText: document.getElementById("noteText"),
  noteDeleteBtn: document.getElementById("noteDeleteBtn"),
  noteCloseBtn: document.getElementById("noteCloseBtn"),
  highlightHoverMarker: document.getElementById("highlightHoverMarker")
};

const eventBus = new pdfjsViewer.EventBus();
const linkService = new pdfjsViewer.PDFLinkService({ eventBus });
const findController = new pdfjsViewer.PDFFindController({ eventBus, linkService });
const pdfViewer = new pdfjsViewer.PDFViewer({
  container: els.viewerContainer,
  viewer: els.viewer,
  eventBus,
  linkService,
  findController,
  removePageBorders: false,
  imageResourcesPath: "../web/images/"
});

linkService.setViewer(pdfViewer);

let currentLoadingTask = null;
let currentDocument = null;
let pagesInitialized = false;
let currentScaleSetting = DEFAULT_SCALE_VALUE;
let searchDebounceTimer = null;
let readingStatePostTimer = null;
let openToken = 0;
let pendingPasswordUpdate = null;
let passwordCancelledLoad = false;
let colorEnhancementEnabled = true;
let i18nDict = { ...I18N_DEFAULTS };
// Outline auto-follow. Entries carry their destination's position so the
// active section can be resolved from the scroll offset, not just the page.
let outlineFollowEntries = [];
let lastOutlineActiveOrder = null;
// External-change reload (file modified on disk while open). The active file
// URL carries a `v` version token that doubles as the reload-dedup identity;
// see reload-core.js for the decision logic.
let currentFileUrl = null;
let externalReloadInFlightUrl = null;
let externalReloadRetryTimer = null;
const reloadCore = window.OnwardPdfReloadCore;

// Annotation persistence. The file module turns records into PDF bytes and
// reads them back; the store decides when that happens. Neither touches the
// filesystem — the host does, over postMessage, so the write can be made
// atomic and can announce itself to the file watcher.
const annotationFile = window.OnwardPdfAnnotationFile.create({
  viewer: els.viewer,
  getDocument: () => currentDocument,
  getAnnotations: () => annotationStore.annotations,
  getLabels: () => annotationStore.getLabels(),
  getRevision: () => annotationStore.getRevision(),
  trace: postTraceToHost
});

let pendingSaveId = 0;
const pendingSaves = new Map();

const annotationStore = window.OnwardPdfAnnotationStore.create({
  file: annotationFile,
  mergeCore: window.OnwardPdfAnnotationMergeCore,
  trace: postTraceToHost,
  requestSave: (bytes, meta) => new Promise(resolve => {
    // Transferring the buffer avoids a copy of what can be a 100 MB document.
    const id = ++pendingSaveId;
    pendingSaves.set(id, resolve);
    try {
      window.parent.postMessage(
        { type: "onward:pdf:saveAnnotations", id, bytes: bytes.buffer, mode: meta.mode },
        "*",
        [bytes.buffer]
      );
    } catch (error) {
      pendingSaves.delete(id);
      resolve({ ok: false, reason: String(error && error.message ? error.message : error) });
    }
  }),
  onDirtyChange: isDirty => postToHost({ type: "onward:pdf:annotationsDirty", dirty: isDirty }),
  onSaveResult: result => postToHost({ type: "onward:pdf:saveResult", ...result }),
  onAnnotationsReplaced: () => {
    highlight.onAnnotationsReplaced();
    postAnnotationsToHost();
  }
});

// Text selection runs through our own caret engine rather than the browser's
// default handling of the pdf.js text layer. See text-selection.js for why
// that is a correctness requirement rather than polish.
//
// The two modules are mutually dependent by nature — selection decides what to
// highlight, the palette lives on the selection — so the selection engine's
// palette hooks delegate lazily through the `highlight` binding below rather
// than either module importing the other.
const textSelection = window.OnwardPdfTextSelection.create({
  viewer: els.viewer,
  viewerContainer: els.viewerContainer,
  getPageView: index => pdfViewer.getPageView(index),
  getDocument: () => currentDocument,
  hooks: {
    trace: postTraceToHost,
    setPalettePointerAnchor: (x, y) => highlight?.setPalettePointerAnchor(x, y),
    updatePaletteFromSelection: selection => highlight?.updatePaletteFromSelection(selection),
    hidePalette: options => highlight?.hidePalette(options),
    // Our own highlights, once saved into the PDF, come back as native
    // annotations. pdf.js would paint them a second time on top of our layer,
    // so they are recognised here and suppressed.
    isOwnAnnotation: annotation => annotationFile.isOwnAnnotation(annotation),
    onOwnAnnotationSection: (page, section, id) =>
      annotationFile.onOwnAnnotationSection(page, section, id),
    onPageAnnotationsIndexed: page => annotationFile.onPageAnnotationsIndexed(page)
  }
});

const highlight = window.OnwardPdfHighlight.create({
  viewer: els.viewer,
  viewerContainer: els.viewerContainer,
  viewerSection: els.viewerSection,
  palette: els.selectionHighlightPalette,
  notePopup: els.notePopup,
  notePopupLabel: els.notePopupLabel,
  notePopupSnippet: els.notePopupSnippet,
  noteText: els.noteText,
  hoverMarker: els.highlightHoverMarker,
  getPageView: index => pdfViewer.getPageView(index),
  getDocument: () => currentDocument,
  getCurrentScale: () => pdfViewer.currentScale,
  setPageNumber: page => { pdfViewer.currentPageNumber = page; },
  scrollPageIntoView: options => pdfViewer.scrollPageIntoView(options),
  selectionApi: textSelection,
  store: annotationStore,
  hooks: {
    trace: postTraceToHost,
    onAnnotationsChanged: () => postAnnotationsToHost(),
    onFirstAnnotationCreated: () => postAnnotationsToHost(),
    persistNotePopupSize: (width, height) => {
      postToHost({ type: "onward:pdf:notePopupSize", width, height });
    }
  }
});

init();

function init() {
  textSelection.attach();
  highlight.attach();
  bindNoteEditorButtons();
  bindUiEvents();
  bindViewerEvents();
  bindHostMessages();
  bindResizeObserver();
  updatePageControls(1, 0);
  updateZoomUi({ scale: 1, presetValue: DEFAULT_SCALE_VALUE });
  applyI18nToDom();
  applyColorEnhancementState();
  loadFromQueryParam();
}

function bindHostMessages() {
  window.addEventListener("message", event => {
    const data = event.data;
    if (!data || typeof data !== "object") return;
    if (data.type === "onward:pdf:requestReady") {
      postReadyToHost();
    } else if (data.type === "onward:pdf:theme") {
      applyThemeFromHost(data.vars || {});
    } else if (data.type === "onward:pdf:i18n") {
      i18nDict = { ...I18N_DEFAULTS, ...(data.strings || {}) };
      applyI18nToDom();
    } else if (data.type === "onward:pdf:saveAnnotationsResult") {
      const resolve = pendingSaves.get(data.id);
      if (resolve) {
        pendingSaves.delete(data.id);
        resolve({ ok: Boolean(data.ok), reason: data.reason });
      }
    } else if (data.type === "onward:pdf:highlightLabels") {
      const labels = Array.isArray(data.labels) ? data.labels : [];
      highlight.setLabels(labels);
      annotationStore.setLabels(highlight.getLabels());
    } else if (data.type === "onward:pdf:highlightI18n") {
      highlight.setI18n(data.strings || {});
    } else if (data.type === "onward:pdf:notePopupSize") {
      highlight.setNotePopupSize(data.width, data.height);
    } else if (data.type === "onward:pdf:goToAnnotation") {
      highlight.scrollToAnnotation(String(data.annotationId || ""));
    } else if (data.type === "onward:pdf:annotationPanelState") {
      applyAnnotationPanelState(Boolean(data.visible), Number(data.count) || 0);
    } else if (data.type === "onward:pdf:emphasizeAnnotations") {
      highlight.setEmphasizedAnnotations(Array.isArray(data.ids) ? data.ids : []);
    } else if (data.type === "onward:pdf:deleteAnnotation") {
      highlight.deleteAnnotationById(String(data.annotationId || ""));
    } else if (data.type === "onward:pdf:saveAnnotationsNow") {
      void annotationStore.saveNow();
    } else if (data.type === "onward:pdf:acknowledgeSignature") {
      annotationStore.acknowledgeSignature();
      void annotationStore.saveNow();
    } else if (data.type === "onward:pdf:colorEnhancement") {
      colorEnhancementEnabled = Boolean(data.enabled);
      applyColorEnhancementState();
    } else if (data.type === "onward:pdf:restoreState") {
      pendingRestoreState = {
        page: Number(data.page),
        scrollTop: Number(data.scrollTop),
        scale: typeof data.scale === "string" ? data.scale : null
      };
      applyRestoreStateIfReady();
    } else if (data.type === "onward:pdf:reloadDocument") {
      // The file changed on disk (external writer). Load-then-swap with
      // rebase-merge of any unsaved local annotations; the old document
      // stays up if the replacement fails to load.
      void externalReloadPdf(String(data.fileUrl || ""), Number(data.generation) || 0, 1);
    } else if (data.type === "onward:pdf:goToPage") {
      if (!currentDocument) return;
      const page = Number(data.page);
      if (!Number.isFinite(page)) return;
      pdfViewer.currentPageNumber = clamp(page, 1, currentDocument.numPages);
    } else if (data.type === "onward:pdf:goToDest") {
      // Preserve full PDF destinations so outline entries that target a
      // specific coordinate (/XYZ, /FitH, etc.) or a named location keep
      // working. pdf.js's LinkService handles both array and string forms.
      if (!currentDocument || data.dest == null) return;
      try {
        linkService.goToDestination(data.dest);
      } catch (_err) {
        /* ignore — fall back to staying on the current page */
      }
    }
  });
  postReadyToHost();
}

function postReadyToHost() {
  try {
    window.parent.postMessage({ type: "onward:pdf:ready" }, "*");
  } catch (_error) {
    // Ignore if no parent (standalone dev).
  }
}

function applyThemeFromHost(vars) {
  const root = document.documentElement;
  for (const [name, value] of Object.entries(vars)) {
    if (typeof value !== "string") continue;
    // Only accept keys that look like CSS custom properties.
    if (!/^--[\w-]+$/.test(name)) continue;
    root.style.setProperty(name, value);
  }
}

/**
 * Reflect the host-owned annotation panel state onto the toolbar button:
 * pressed state (panel open) and the record count badge.
 *
 * Receiving this message is also what REVEALS the button. Only a host that
 * actually owns an annotation panel sends it; the git-compare panes embed the
 * same viewer but have no panel, and a button that does nothing when clicked
 * is worse than no button.
 */
function applyAnnotationPanelState(visible, count) {
  const button = els.annotationsToggleBtn;
  if (!button) return;
  button.hidden = false;
  if (els.annotationsToggleGroup) els.annotationsToggleGroup.hidden = false;
  button.setAttribute("aria-pressed", visible ? "true" : "false");
  button.classList.toggle("active", visible);
  const badge = els.annotationsToggleCount;
  if (!badge) return;
  if (count > 0) {
    badge.textContent = String(count);
    badge.hidden = false;
  } else {
    badge.hidden = true;
  }
}

function applyI18nToDom() {
  document.querySelectorAll("[data-i18n]").forEach(el => {
    const key = el.getAttribute("data-i18n");
    if (key && i18nDict[key]) el.textContent = i18nDict[key];
  });
  document.querySelectorAll("[data-i18n-title]").forEach(el => {
    const key = el.getAttribute("data-i18n-title");
    if (key && i18nDict[key]) el.title = i18nDict[key];
  });
  document.querySelectorAll("[data-i18n-aria-label]").forEach(el => {
    const key = el.getAttribute("data-i18n-aria-label");
    if (key && i18nDict[key]) el.setAttribute("aria-label", i18nDict[key]);
  });
  document.querySelectorAll("[data-i18n-placeholder]").forEach(el => {
    const key = el.getAttribute("data-i18n-placeholder");
    if (key && i18nDict[key]) el.setAttribute("placeholder", i18nDict[key]);
  });
  // The color toggle has separate copy for enabled/disabled states; let
  // applyColorEnhancementState pick the right variant every time translations
  // arrive so it doesn't get stuck with stale English text.
  applyColorEnhancementState();
}

function loadFromQueryParam() {
  const params = new URLSearchParams(window.location.search);
  const fileParam = params.get("file");
  if (!fileParam) {
    setDocumentVisible(false);
    return;
  }
  // `file` is expected to be a fully-formed file:// URL or an absolute path the
  // renderer has already URL-encoded. pdf.js getDocument handles both.
  void openPdfUrl(fileParam, params.get("name") || basenameFromUrl(fileParam));
}

function bindUiEvents() {
  els.prevPageBtn.addEventListener("click", () => {
    if (!currentDocument) return;
    pdfViewer.currentPageNumber = clamp(pdfViewer.currentPageNumber - 1, 1, currentDocument.numPages);
  });

  els.nextPageBtn.addEventListener("click", () => {
    if (!currentDocument) return;
    pdfViewer.currentPageNumber = clamp(pdfViewer.currentPageNumber + 1, 1, currentDocument.numPages);
  });

  els.pageNumberInput.addEventListener("change", () => {
    jumpToPage(els.pageNumberInput.value);
  });

  els.customZoomInput.addEventListener("keydown", event => {
    if (event.key === "Enter") {
      event.preventDefault();
      commitCustomZoomInput();
    } else if (event.key === "Escape") {
      event.preventDefault();
      syncCustomZoomInput(pdfViewer.currentScale);
      els.customZoomInput.blur();
    }
  });
  els.customZoomInput.addEventListener("blur", () => commitCustomZoomInput());

  els.zoomOutBtn.addEventListener("click", () => adjustZoom(1 / SCALE_STEP));
  els.zoomInBtn.addEventListener("click", () => adjustZoom(SCALE_STEP));

  els.zoomSelect.addEventListener("change", () => {
    if (!currentDocument) return;
    const value = els.zoomSelect.value;
    if (value === "page-width" || value === "page-fit") {
      pdfViewer.currentScaleValue = value;
      return;
    }
    const numeric = Number.parseFloat(value);
    if (!Number.isFinite(numeric)) return;
    pdfViewer.currentScaleValue = String(clamp(numeric, MIN_SCALE, MAX_SCALE));
  });

  els.searchInput.addEventListener("keydown", event => {
    if (event.key !== "Enter") return;
    event.preventDefault();
    runFind({ type: "again", findPrevious: event.shiftKey });
  });

  els.searchInput.addEventListener("input", () => {
    clearTimeout(searchDebounceTimer);
    searchDebounceTimer = setTimeout(() => runFind({ type: "" }), 200);
  });

  els.searchPrevBtn.addEventListener("click", () => runFind({ type: "again", findPrevious: true }));
  els.searchNextBtn.addEventListener("click", () => runFind({ type: "again", findPrevious: false }));

  els.colorToggleBtn.addEventListener("click", () => {
    colorEnhancementEnabled = !colorEnhancementEnabled;
    applyColorEnhancementState();
  });

  // The panel itself lives on the host side, so the toolbar button only
  // reports intent; the host answers with the new state via
  // `onward:pdf:annotationPanelState`, keeping one source of truth.
  if (els.annotationsToggleBtn) {
    els.annotationsToggleBtn.addEventListener("click", () => {
      postToHost({ type: "onward:pdf:toggleAnnotationPanel" });
    });
  }

  els.errorCloseBtn.addEventListener("click", () => clearError());

  els.passwordCancelBtn.addEventListener("click", () => {
    closePasswordDialog();
    if (currentLoadingTask) {
      passwordCancelledLoad = true;
      currentLoadingTask.destroy();
    }
    showError(i18nDict.errorPassword);
  });

  els.passwordConfirmBtn.addEventListener("click", submitPassword);
  els.passwordInput.addEventListener("keydown", event => {
    if (event.key === "Enter") {
      event.preventDefault();
      submitPassword();
    }
  });

  window.addEventListener("keydown", event => {
    const isCmd = event.ctrlKey || event.metaKey;
    if (isCmd && event.key.toLowerCase() === "f") {
      event.preventDefault();
      els.searchInput.focus();
      els.searchInput.select();
      return;
    }
    // Cmd/Ctrl+S writes annotations into the PDF immediately, bypassing the
    // quiet window. Handled locally rather than forwarded: the host has no
    // notion of an unsaved PDF, and forwarding would hit the editor's own save.
    if (isCmd && event.key.toLowerCase() === "s") {
      event.preventDefault();
      void annotationStore.saveNow();
      return;
    }
    // Forward host-level shortcuts so the iframe boundary doesn't swallow them.
    // Only Cmd/Ctrl+P (project Quick Open) and Escape (close subpage) — these
    // are the keys the host actually handles. Cmd+F stays local (above).
    if (isCmd && event.key.toLowerCase() === "p") {
      event.preventDefault();
      forwardHostKey(event);
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      forwardHostKey(event);
      return;
    }
  });
}

// The viewer runs in a sandboxed iframe with no access to the renderer's
// perf-trace API, so diagnostics are relayed to the host, which records them
// through the normal `perfTrace` path. Kept deliberately thin: callers only
// fire on control-flow inflection points, never inside pointer or rAF loops.
function postToHost(message) {
  try {
    window.parent.postMessage(message, "*");
  } catch (_err) {
    // Parent gone or postMessage blocked.
  }
}

// The host owns the annotation list UI, so it needs the records whenever they
// change. Sent as plain data (no quads) — the list only needs what it renders,
// and quads for a heavily annotated book would be a large payload on every
// keystroke in a note.
function postAnnotationsToHost() {
  postToHost({
    type: "onward:pdf:annotations",
    items: annotationStore.annotations.map(annot => ({
      id: annot.id,
      groupId: annot.groupId,
      labelId: annot.labelId,
      labelName: annot.labelName,
      color: annot.color,
      page: annot.page,
      note: annot.note || "",
      textSnapshot: annot.textSnapshot || "",
      createdAt: annot.createdAt,
      updatedAt: annot.updatedAt
    }))
  });
}

function bindNoteEditorButtons() {
  els.noteDeleteBtn.addEventListener("click", () => {
    highlight.deleteCurrentAnnotation();
  });
  els.noteCloseBtn.addEventListener("click", () => {
    highlight.closeNoteEditor();
  });
}

function postTraceToHost(name, payload) {
  try {
    window.parent.postMessage({
      type: "onward:pdf:trace",
      name: String(name),
      payload: payload && typeof payload === "object" ? payload : {}
    }, "*");
  } catch (_err) {
    // Parent gone or postMessage blocked; diagnostics are best-effort.
  }
}

function forwardHostKey(event) {
  try {
    window.parent.postMessage({
      type: "onward:pdf:hostKey",
      key: event.key,
      code: event.code,
      metaKey: event.metaKey,
      ctrlKey: event.ctrlKey,
      shiftKey: event.shiftKey,
      altKey: event.altKey
    }, "*");
  } catch (_err) {
    // Parent gone or postMessage blocked; nothing useful to do.
  }
}

function bindResizeObserver() {
  if (typeof ResizeObserver === "undefined") return;
  let timer = null;
  const observer = new ResizeObserver(() => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      if (!currentDocument) return;
      try {
        // Self-assignment retriggers pdf.js's page-width / page-fit recompute
        // against the new container width. Numeric scales become a no-op.
        pdfViewer.currentScaleValue = pdfViewer.currentScaleValue;
      } catch (_err) {
        /* ignore */
      }
    }, 120);
  });
  observer.observe(els.viewerContainer);
}

function bindViewerEvents() {
  eventBus.on("pagechanging", event => {
    updatePageControls(event.pageNumber, currentDocument?.numPages || 0);
    queueReadingStatePost();
  });
  eventBus.on("scalechanging", event => {
    // Every cached client rect the caret engine holds is invalidated by a
    // zoom, and a selection mid-drag would resolve against stale geometry.
    textSelection.onScaleChanging();
    updateZoomUi(event);
    queueReadingStatePost();
  });

  // Hidden text (a scanned page's OCR layer, or text painted with Tr=3 /
  // alpha 0) is dropped from the text layer once it is confirmed to sit under
  // visible text, so it can never enter a selection or the clipboard. Pages
  // that are OCR-only keep their layer — there the invisible text IS the text.
  eventBus.on("textlayerrendered", event => {
    textSelection.onTextLayerRendered(event);
    // A re-rendered page has an empty highlight layer until we repaint it.
    highlight.onPageRendered(event.pageNumber);
  });
  // Classifies each annotation as blocking (form widgets, stamps, redactions)
  // or passthrough (highlights, underlines) for the caret engine.
  eventBus.on("annotationlayerrendered", event => {
    void textSelection.onAnnotationLayerRendered(event);
  });
  eventBus.on("updatefindmatchescount", event => updateSearchCount(event.matchesCount));
  eventBus.on("updatefindcontrolstate", event => updateSearchCount(event.matchesCount));

  // Scroll persistence: debounce a "state" message back to the host when the
  // user scrolls the viewer, so the host can remember where they were.
  els.viewerContainer.addEventListener(
    "scroll",
    () => { queueReadingStatePost(); },
    { passive: true }
  );
}

/**
 * Work out which outline section the reader is currently inside and tell the
 * host when it changes.
 *
 * Runs off the same debounce as reading-state persistence rather than on every
 * scroll event: the answer only changes at section boundaries, and resolving
 * it touches page-view geometry.
 */
function publishOutlineActive() {
  if (!currentDocument || outlineFollowEntries.length === 0) return;
  const pageNumber = pdfViewer.currentPageNumber || 1;
  const pageView = pdfViewer.getPageView(pageNumber - 1);
  const viewport = pageView && pageView.viewport;

  let readingTop = null;
  if (viewport && pageView.div) {
    // How far into the current page the viewport's top edge has travelled,
    // converted into PDF user space so it is comparable with the destination
    // coordinates stored above (which are zoom-independent).
    const containerTop = els.viewerContainer.getBoundingClientRect().top;
    const pageTop = pageView.div.getBoundingClientRect().top;
    const intoPageCss = Math.max(0, containerTop - pageTop);
    try {
      readingTop = viewport.convertToPdfPoint(0, intoPageCss)[1];
    } catch (_err) {
      readingTop = null;
    }
  }

  // PDF y grows upward, the comparator expects "distance from the page top"
  // growing downward, so flip both sides onto that axis.
  const pageHeight = viewport ? viewport.viewBox[3] : 0;
  const entries = outlineFollowEntries.map(entry => ({
    order: entry.order,
    page: entry.page,
    top: entry.top === null || !Number.isFinite(entry.top) ? null : pageHeight - entry.top
  }));
  const location = {
    page: pageNumber,
    top: readingTop === null ? 0 : pageHeight - readingTop
  };

  const active = window.OnwardPdfOutlineFollowCore.pickActiveOutlineOrder(entries, location);
  if (active === lastOutlineActiveOrder) return;
  lastOutlineActiveOrder = active;
  postToHost({ type: "onward:pdf:outlineActive", order: active });
}

function queueReadingStatePost() {
  if (readingStatePostTimer) clearTimeout(readingStatePostTimer);
  readingStatePostTimer = setTimeout(() => {
    readingStatePostTimer = null;
    postReadingState();
    publishOutlineActive();
  }, 250);
}

function readReadingState() {
  return {
    page: pdfViewer.currentPageNumber,
    scrollTop: els.viewerContainer.scrollTop,
    scale: currentScaleSetting
  };
}

function postReadingStateMessage(type) {
  if (!currentDocument) return;
  try {
    window.parent.postMessage({
      type,
      ...readReadingState()
    }, "*");
  } catch (_err) {
    /* ignore */
  }
}

function postReadingState() {
  postReadingStateMessage("onward:pdf:state");
}

function postReadingStateReady() {
  postReadingStateMessage("onward:pdf:stateReady");
}

let pendingRestoreState = null;
function applyRestoreStateIfReady() {
  if (!pendingRestoreState || !currentDocument || !pagesInitialized) return false;
  const state = pendingRestoreState;
  pendingRestoreState = null;
  const restoreOpenToken = openToken;
  try {
    if (typeof state.scale === "string" && state.scale.length > 0) {
      pdfViewer.currentScaleValue = state.scale;
    }
  } catch (_err) {
    /* ignore */
  }
  if (Number.isFinite(state.page)) {
    pdfViewer.currentPageNumber = clamp(Number(state.page), 1, currentDocument.numPages);
  }
  requestAnimationFrame(() => {
    if (restoreOpenToken !== openToken || !currentDocument || !pagesInitialized) return;
    if (Number.isFinite(state.scrollTop)) {
      els.viewerContainer.scrollTop = Math.max(0, Number(state.scrollTop));
    }
    requestAnimationFrame(() => {
      if (restoreOpenToken !== openToken || !currentDocument || !pagesInitialized) return;
      postReadingStateReady();
    });
  });
  return true;
}

async function openPdfUrl(url, displayName) {
  const token = ++openToken;
  pagesInitialized = false;
  clearError();
  els.fileName.textContent = displayName || "";
  els.fileName.title = displayName || "";
  cancelExternalReloadRetry();
  externalReloadInFlightUrl = null;

  await resetCurrentDocument();
  if (token !== openToken) return;

  const loadingTask = pdfjsLib.getDocument(buildGetDocumentOptions(url));
  currentLoadingTask = loadingTask;
  passwordCancelledLoad = false;

  loadingTask.onPassword = (updatePassword, reason) => {
    if (token !== openToken) return;
    showPasswordDialog(updatePassword, reason);
  };

  let pdfDocument;
  try {
    pdfDocument = await loadingTask.promise;
  } catch (error) {
    currentLoadingTask = null;
    if (passwordCancelledLoad) {
      passwordCancelledLoad = false;
      return;
    }
    if (token !== openToken) return;
    handlePdfOpenError(error);
    return;
  }

  if (token !== openToken) {
    try {
      await pdfDocument.destroy();
    } catch (_error) {
      /* ignore */
    }
    return;
  }

  currentFileUrl = url;
  await attachLoadedDocument(pdfDocument, token, { rebase: false });
}

function buildGetDocumentOptions(url) {
  return {
    url,
    cMapUrl: "../cmaps/",
    cMapPacked: true,
    standardFontDataUrl: "../standard_fonts/",
    isEvalSupported: false,
    enableXfa: false
  };
}

/**
 * Wire an already-loaded PDFDocumentProxy into the viewer: page setup,
 * annotation adoption (or external rebase), outline broadcast. Shared by the
 * initial open and the external-change reload so the two paths cannot drift.
 * Returns { mergeStats } (null when adopting normally).
 */
async function attachLoadedDocument(pdfDocument, token, options) {
  const rebase = Boolean(options && options.rebase);
  currentDocument = pdfDocument;
  currentLoadingTask = null;
  closePasswordDialog();

  eventBus.on(
    "pagesinit",
    () => {
      // Default-then-restore: set the baseline scale/page first, then apply
      // any host-provided state on top so the user returns to their last
      // reading spot. Missing/partial state falls back to the baseline.
      pdfViewer.currentScaleValue = DEFAULT_SCALE_VALUE;
      pdfViewer.currentPageNumber = 1;
      els.viewerContainer.scrollTop = 0;
      pagesInitialized = true;
      applyRestoreStateIfReady();
    },
    { once: true }
  );

  pdfViewer.setDocument(pdfDocument);
  linkService.setDocument(pdfDocument, null);

  updatePageControls(1, pdfDocument.numPages);
  updateSearchCount({ current: 0, total: 0 });
  setDocumentVisible(true);

  let mergeStats = null;
  // Load any annotations the file already carries. Done after setDocument so
  // pages that render early still get their highlights once this resolves.
  try {
    const state = await annotationFile.readAnnotationStateFromPdf(pdfDocument);
    if (token !== openToken) return { mergeStats: null };
    if (state?.nativeIds?.length) {
      // Keep our own highlights out of the page canvas as well as the DOM —
      // CSS alone cannot stop pdf.js painting them into the raster.
      annotationFile.suppressOwnNativeAnnotationsInCanvas(pdfDocument, state.nativeIds);
      annotationFile.applyKnownOwnNativeAnnotationVisibility();
    }
    const adoptState = {
      annotations: state?.annotations ?? [],
      revision: state?.revision ?? 0,
      documentBytes: await getDocumentByteLength(pdfDocument),
      hasSignature: await documentHasSignature(pdfDocument)
    };
    if (token !== openToken) return { mergeStats: null };
    if (rebase) {
      mergeStats = annotationStore.rebaseOnExternal(adoptState);
    } else {
      annotationStore.adopt(adoptState);
    }
  } catch (error) {
    if (token !== openToken) return { mergeStats: null };
    // A document whose annotations cannot be read is still perfectly readable;
    // start from an empty set rather than refusing to open it. On a rebase
    // the store keeps its local records — adopting empty here would turn a
    // read hiccup into a mass deletion on the next save.
    postTraceToHost("annotation.read-failed", {
      error: String(error && error.message ? error.message : error).slice(0, 120)
    });
    if (!rebase) {
      annotationStore.adopt({ annotations: [], revision: 0, documentBytes: 0, hasSignature: false });
    }
  }

  try {
    const items = await buildOutlineTreeForHost(pdfDocument);
    try {
      window.parent.postMessage({ type: "onward:pdf:outline", items }, "*");
    } catch (_err) {
      /* ignore */
    }
  } catch (_error) {
    try {
      window.parent.postMessage({ type: "onward:pdf:outline", items: [] }, "*");
    } catch (_err) {
      /* ignore */
    }
  }
  return { mergeStats };
}

function cancelExternalReloadRetry() {
  if (externalReloadRetryTimer !== null) {
    clearTimeout(externalReloadRetryTimer);
    externalReloadRetryTimer = null;
  }
}

function postReloadResult(generation, ok, reason, extra) {
  // Autotest probe: reload outcomes are otherwise only observable as host
  // postMessages, which a test cannot intercept without racing the host's own
  // listener. Recording them here (autotest builds only) gives assertions a
  // deterministic in-realm signal.
  if (window.__onwardPdfTest && window.__onwardPdfTest.externalReload) {
    window.__onwardPdfTest.externalReload.results.push({
      generation: generation,
      ok: Boolean(ok),
      reason: reason || null,
      merge: (extra && extra.merge) || null
    });
  }
  try {
    window.parent.postMessage(
      Object.assign(
        { type: "onward:pdf:reloadResult", generation, ok: Boolean(ok), reason: reason || null },
        extra || {}
      ),
      "*"
    );
  } catch (_err) {
    /* ignore */
  }
}

/**
 * Tear down the page-facing modules for an in-place document swap. Unlike
 * resetCurrentDocument this deliberately does NOT flush or reset the
 * annotation store: its live records and base snapshot are the ingredients of
 * the rebase merge that runs after the replacement attaches, and flushing
 * here would write pre-change bytes over the very external edit this path
 * exists to adopt.
 */
async function resetForExternalSwap() {
  closePasswordDialog();
  highlight.reset();
  annotationFile.reset();
  textSelection.reset();
  pagesInitialized = false;
  currentScaleSetting = DEFAULT_SCALE_VALUE;
  passwordCancelledLoad = false;

  if (readingStatePostTimer) {
    clearTimeout(readingStatePostTimer);
    readingStatePostTimer = null;
  }

  pdfViewer.setDocument(null);
  linkService.setDocument(null, null);

  const oldDocument = currentDocument;
  currentDocument = null;
  if (oldDocument) {
    try {
      await oldDocument.destroy();
    } catch (_error) {
      /* ignore */
    }
  }
}

/**
 * External-change reload: SumatraPDF semantics. Load the replacement first;
 * swap only once it parsed; on failure keep the old document, retry once
 * after a beat (a writer may have been caught mid-write), then stay quiet.
 */
async function externalReloadPdf(fileUrl, generation, attempt) {
  if (!fileUrl || !reloadCore) return;
  cancelExternalReloadRetry();

  const decision = reloadCore.shouldStartReload({
    requestedUrl: fileUrl,
    activeUrl: currentFileUrl,
    inFlightUrl: externalReloadInFlightUrl
  });
  if (!decision.start) {
    postReloadResult(generation, false, decision.reason);
    return;
  }

  externalReloadInFlightUrl = fileUrl;
  const token = openToken;
  const startedAt = Date.now();
  postTraceToHost("document.external-reload-start", { generation, attempt });

  let newDocument;
  try {
    const loadingTask = pdfjsLib.getDocument(buildGetDocumentOptions(fileUrl));
    // A password prompt has no place in a background refresh; cancel the load
    // and let the deferred path keep the old (already unlocked) document.
    loadingTask.onPassword = () => {
      try {
        void loadingTask.destroy();
      } catch (_err) {
        /* ignore */
      }
    };
    newDocument = await loadingTask.promise;
  } catch (error) {
    const retry = reloadCore.nextRetryDecision(attempt);
    postTraceToHost("document.external-reload-deferred", {
      generation,
      attempt,
      willRetry: retry.retry,
      reason: String(error && error.message ? error.message : error).slice(0, 120)
    });
    externalReloadInFlightUrl = null;
    if (retry.retry && token === openToken) {
      externalReloadRetryTimer = setTimeout(() => {
        externalReloadRetryTimer = null;
        void externalReloadPdf(fileUrl, generation, attempt + 1);
      }, retry.delayMs);
    } else {
      postReloadResult(generation, false, "load-failed");
    }
    return;
  }

  if (token !== openToken) {
    // The user opened a different document while the replacement was loading.
    try {
      await newDocument.destroy();
    } catch (_error) {
      /* ignore */
    }
    externalReloadInFlightUrl = null;
    postReloadResult(generation, false, "superseded");
    return;
  }

  const snapshot = reloadCore.captureViewState({
    pageNumber: pdfViewer.currentPageNumber,
    scrollTop: els.viewerContainer.scrollTop,
    scaleSetting: currentScaleSetting
  });

  const swapToken = ++openToken;
  await resetForExternalSwap();
  if (swapToken !== openToken) {
    try {
      await newDocument.destroy();
    } catch (_error) {
      /* ignore */
    }
    externalReloadInFlightUrl = null;
    postReloadResult(generation, false, "superseded");
    return;
  }

  currentFileUrl = fileUrl;
  clearError();
  const attachResult = await attachLoadedDocument(newDocument, swapToken, { rebase: true });
  externalReloadInFlightUrl = null;

  // Restore AFTER the rebase settled: rebaseOnExternal bumps openToken, and
  // applyRestoreStateIfReady's rAF guard compares against it — arming the
  // restore earlier would lose the scroll position to that token bump.
  const restore = reloadCore.buildRestoreState(snapshot, newDocument.numPages);
  pendingRestoreState = restore;
  applyRestoreStateIfReady();

  postTraceToHost("document.external-reload-done", {
    generation,
    numPages: newDocument.numPages,
    restoredPage: restore.page,
    durationMs: Date.now() - startedAt
  });
  postReloadResult(generation, true, null, {
    numPages: newDocument.numPages,
    merge: attachResult && attachResult.mergeStats ? attachResult.mergeStats : null
  });
}

async function resetCurrentDocument() {
  closePasswordDialog();
  // Write out anything unsaved before the document this belongs to goes away.
  // Awaited on purpose: dropping it would lose the last edit whenever the user
  // switches files quickly, which is exactly when they are least likely to
  // have pressed Cmd+S.
  try {
    await annotationStore.flushBeforeUnload();
  } catch (_err) {
    /* a failed flush is reported through onSaveResult; do not block the switch */
  }
  annotationStore.reset();
  highlight.reset();
  annotationFile.reset();
  // Drop any in-flight drag, the cross-page overlay and the per-page
  // annotation classification before the pages they point at are torn down.
  textSelection.reset();
  pagesInitialized = false;
  currentScaleSetting = DEFAULT_SCALE_VALUE;
  passwordCancelledLoad = false;

  if (readingStatePostTimer) {
    clearTimeout(readingStatePostTimer);
    readingStatePostTimer = null;
  }

  pdfViewer.setDocument(null);
  linkService.setDocument(null, null);

  const loadingTask = currentLoadingTask;
  currentLoadingTask = null;
  if (loadingTask) {
    try {
      await loadingTask.destroy();
    } catch (_error) {
      /* ignore */
    }
  }

  const oldDocument = currentDocument;
  currentDocument = null;
  if (oldDocument) {
    try {
      await oldDocument.destroy();
    } catch (_error) {
      /* ignore */
    }
  }

  try {
    window.parent.postMessage({ type: "onward:pdf:outline", items: [] }, "*");
  } catch (_err) {
    /* ignore */
  }
  updatePageControls(1, 0);
  updateSearchCount({ current: 0, total: 0 });
  setDocumentVisible(false);
}

function adjustZoom(ratio) {
  if (!currentDocument) return;
  const nextScale = clamp(Number((pdfViewer.currentScale * ratio).toFixed(2)), MIN_SCALE, MAX_SCALE);
  pdfViewer.currentScaleValue = String(nextScale);
}

function jumpToPage(value) {
  if (!currentDocument) return;
  let page = Number.parseInt(value, 10);
  if (!Number.isFinite(page)) page = pdfViewer.currentPageNumber;
  pdfViewer.currentPageNumber = clamp(page, 1, currentDocument.numPages);
}

function runFind({ type = "", findPrevious = false }) {
  // The find controller rewrites the text layer to inject its match spans,
  // which orphans any Range currently pointing into it. Clearing first avoids
  // a stale selection whose overlay and clipboard content no longer agree.
  textSelection.clearSelection();
  const query = els.searchInput.value.trim();
  if (!query) {
    updateSearchCount({ current: 0, total: 0 });
    eventBus.dispatch("findbarclose", { source: window });
    return;
  }
  eventBus.dispatch("find", {
    source: window,
    type,
    query,
    phraseSearch: true,
    caseSensitive: false,
    entireWord: false,
    highlightAll: true,
    findPrevious,
    matchDiacritics: false
  });
}

// Serialize the PDF outline into a plain tree that the host's OutlinePanel can
// render. Each entry's `dest` is resolved to a 1-based page number up front so
// the host can both navigate and compare against the current page without
// needing pdf.js APIs on its side.
async function buildOutlineTreeForHost(pdfDocument) {
  const outline = await pdfDocument.getOutline();
  outlineFollowEntries = [];
  lastOutlineActiveOrder = null;
  if (!outline?.length) return [];

  async function resolvePage(dest) {
    if (!dest) return null;
    try {
      const resolvedDest = typeof dest === "string"
        ? await pdfDocument.getDestination(dest)
        : dest;
      if (!Array.isArray(resolvedDest) || resolvedDest.length === 0) return null;
      const pageRef = resolvedDest[0];
      // pdf.js destinations can use a zero-based page INDEX instead of a Ref
      // (valid per the PDF spec). getPageIndex(number) throws, so short-
      // circuit that form here or we'd lose click targets on such outlines.
      if (typeof pageRef === "number" && Number.isFinite(pageRef)) {
        return pageRef + 1;
      }
      const pageIndex = await pdfDocument.getPageIndex(pageRef);
      if (typeof pageIndex !== "number" || pageIndex < 0) return null;
      return pageIndex + 1;
    } catch (_err) {
      return null;
    }
  }

  // Pre-order index. The host renders the outline in the same order, so this
  // is a stable handle for "which row is active" that survives the tree being
  // flattened, filtered or virtualised on the other side.
  let order = 0;

  // The y coordinate of an explicit /XYZ or /FitH destination, in PDF user
  // space (origin bottom-left). Null for destination forms that carry no
  // position — /Fit, for instance, means "the whole page".
  async function resolveDestinationTop(dest) {
    if (!dest) return null;
    try {
      const resolved = typeof dest === "string" ? await pdfDocument.getDestination(dest) : dest;
      if (!Array.isArray(resolved) || resolved.length < 3) return null;
      const kind = resolved[1] && resolved[1].name ? resolved[1].name : String(resolved[1] || "");
      if (kind === "XYZ") {
        const top = resolved[3];
        return Number.isFinite(top) ? top : null;
      }
      if (kind === "FitH" || kind === "FitBH") {
        const top = resolved[2];
        return Number.isFinite(top) ? top : null;
      }
      return null;
    } catch (_err) {
      return null;
    }
  }

  async function walk(items) {
    const out = [];
    for (const item of items) {
      const page = await resolvePage(item.dest);
      const entryOrder = order++;
      // Record the destination's vertical position so scroll-following can
      // tell apart several sections that start on the same page.
      outlineFollowEntries.push({
        order: entryOrder,
        page: typeof page === "number" ? page : NaN,
        top: await resolveDestinationTop(item.dest)
      });
      const children = item.items?.length ? await walk(item.items) : [];
      // Keep the original `dest` on each node so the host can ask pdf.js to
      // navigate with full precision (fine-grained `/XYZ`, `/FitH`, etc.).
      // Falling back to `page` is only for the active-item highlight math.
      out.push({
        title: (item.title || "").trim(),
        page,
        dest: item.dest ?? null,
        children
      });
    }
    return out;
  }

  return walk(outline);
}

function updatePageControls(pageNumber, pageCount) {
  const hasDocument = pageCount > 0;
  els.pageNumberInput.max = String(Math.max(pageCount, 1));
  els.pageNumberInput.value = String(Math.max(pageNumber, 1));
  els.pageCountLabel.textContent = `/ ${pageCount}`;
  els.prevPageBtn.disabled = !hasDocument || pageNumber <= 1;
  els.nextPageBtn.disabled = !hasDocument || pageNumber >= pageCount;
}

function updateZoomUi({ scale, presetValue }) {
  // Keep the free-form field showing the scale actually in effect, whatever
  // changed it — preset, +/- buttons, fit-width recompute on resize.
  if (document.activeElement !== els.customZoomInput) {
    syncCustomZoomInput(scale);
  }
  const optionValues = new Set(Array.from(els.zoomSelect.options, option => option.value));
  if (presetValue && optionValues.has(String(presetValue))) {
    currentScaleSetting = String(presetValue);
    els.customZoomOption.hidden = true;
    els.zoomSelect.value = String(presetValue);
    return;
  }
  const numericScale = clamp(Number(scale) || 1, MIN_SCALE, MAX_SCALE);
  const value = String(Number(numericScale.toFixed(2)));
  currentScaleSetting = value;
  els.customZoomOption.hidden = false;
  els.customZoomOption.value = value;
  els.customZoomOption.textContent = `${Math.round(numericScale * 100)}%`;
  els.zoomSelect.value = value;
}

function updateSearchCount(matchesCount) {
  const current = Number(matchesCount?.current || 0);
  const total = Number(matchesCount?.total || 0);
  els.searchResult.textContent = `${current} / ${total}`;
}

function setDocumentVisible(visible) {
  els.viewerSection.classList.toggle("has-document", visible);
  els.customZoomInput.disabled = !visible;
}

function showPasswordDialog(updatePassword, reason) {
  pendingPasswordUpdate = updatePassword;
  const prompt =
    reason === pdfjsLib.PasswordResponses.INCORRECT_PASSWORD
      ? i18nDict.passwordIncorrect
      : i18nDict.passwordPrompt;
  els.passwordPrompt.textContent = prompt;
  els.passwordInput.value = "";
  els.passwordDialogBackdrop.hidden = false;
  els.passwordInput.focus();
}

function closePasswordDialog() {
  pendingPasswordUpdate = null;
  els.passwordDialogBackdrop.hidden = true;
  els.passwordInput.value = "";
}

function submitPassword() {
  const password = els.passwordInput.value;
  if (!pendingPasswordUpdate) {
    closePasswordDialog();
    return;
  }
  if (!password) {
    els.passwordInput.focus();
    return;
  }
  pendingPasswordUpdate(password);
  closePasswordDialog();
}

function showError(summary, detail = "") {
  els.errorMessage.textContent = "";
  const summaryNode = document.createElement("strong");
  summaryNode.textContent = summary;
  els.errorMessage.appendChild(summaryNode);
  if (detail) {
    const detailNode = document.createElement("span");
    detailNode.textContent = detail;
    els.errorMessage.appendChild(detailNode);
  }
  els.errorBanner.hidden = false;
}

function clearError() {
  els.errorBanner.hidden = true;
  els.errorMessage.textContent = "";
}

function handlePdfOpenError(error) {
  closePasswordDialog();
  const errorName = error?.name || "UnknownError";
  const errorMessage = error?.message || "";
  const details = errorMessage ? `${errorName}: ${errorMessage}` : errorName;
  switch (errorName) {
    case "InvalidPDFException":
      showError(i18nDict.errorInvalid, details);
      break;
    case "MissingPDFException":
      showError(i18nDict.errorMissing, details);
      break;
    case "PasswordException":
      showError(i18nDict.errorPassword, details);
      break;
    case "UnexpectedResponseException":
      showError(i18nDict.errorUnexpected, details);
      break;
    default:
      showError(i18nDict.errorGeneric, details);
      break;
  }
}

function applyColorEnhancementState() {
  const isEnabled = colorEnhancementEnabled !== false;
  els.viewer.classList.toggle("dark-invert", isEnabled);
  document.documentElement.classList.toggle("color-enhancement-off", !isEnabled);
  els.colorToggleBtn.classList.toggle("is-off", !isEnabled);
  els.colorToggleBtn.setAttribute("aria-pressed", !isEnabled ? "true" : "false");
  // Reflect the current mode in the label so the button reads as an action the
  // user can take from here (not the state they're currently in). When dark
  // rendering is ON, the action is "temporarily disable dark"; when OFF, the
  // action is "restore dark rendering". Matches the reference viewer's copy.
  const labelKey = isEnabled ? "colorToggleOn" : "colorToggleOff";
  const titleKey = isEnabled ? "colorToggleTitleOn" : "colorToggleTitleOff";
  els.colorToggleBtn.textContent = i18nDict[labelKey] ?? I18N_DEFAULTS[labelKey];
  els.colorToggleBtn.title = i18nDict[titleKey] ?? I18N_DEFAULTS[titleKey];
}

/**
 * Parse a free-form zoom entry: "137", "137%", " 1.5 % ". Returns null for
 * anything unparseable so the caller can mark the field invalid rather than
 * silently snapping to some default the user did not ask for.
 *
 * Out-of-range values are clamped instead of rejected: someone typing 900
 * clearly wants "as large as possible", and refusing the input teaches them
 * nothing about where the limit is.
 */
function parseCustomZoomInput(value) {
  const normalized = String(value ?? "").trim();
  const match = normalized.match(/^([+-]?(?:\d+(?:\.\d*)?|\.\d+))\s*%?$/);
  if (!match) return null;
  const parsedPercent = Number(match[1]);
  if (Number.isNaN(parsedPercent)) return null;
  const bounded = clamp(parsedPercent, MIN_SCALE * 100, MAX_SCALE * 100);
  return Number((bounded / 100).toFixed(4));
}

function formatZoomPercent(scale) {
  const numeric = Number(scale);
  const safe = Number.isFinite(numeric) && numeric > 0 ? numeric : 1;
  return `${Number((safe * 100).toFixed(2))}%`;
}

function syncCustomZoomInput(scale, invalid = false) {
  els.customZoomInput.value = formatZoomPercent(scale);
  els.customZoomInput.setAttribute("aria-invalid", invalid ? "true" : "false");
}

function commitCustomZoomInput() {
  if (!currentDocument) {
    syncCustomZoomInput(pdfViewer.currentScale);
    return;
  }
  const nextScale = parseCustomZoomInput(els.customZoomInput.value);
  if (nextScale === null) {
    // Restore the real scale and flag the field: leaving the bad text in place
    // would make the viewer look like it had silently accepted it.
    syncCustomZoomInput(pdfViewer.currentScale, true);
    return;
  }
  pdfViewer.currentScaleValue = String(nextScale);
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

/**
 * Size of the open document in bytes. Feeds the store's large-file cadence
 * (R5) — past the threshold, automatic saves back off so a full rewrite of a
 * scanned book cannot queue up behind the next edit.
 */
async function getDocumentByteLength(pdfDocument) {
  try {
    const data = await pdfDocument.getData();
    return data ? data.byteLength : 0;
  } catch (_err) {
    // Unknown size is treated as small: better to save promptly than to
    // silently degrade a document we simply failed to measure.
    return 0;
  }
}

/**
 * Whether the document carries a digital signature (R3). pdf-lib rewrites the
 * whole file, which invalidates one, so the store asks before the first save
 * rather than breaking it silently.
 */
async function documentHasSignature(pdfDocument) {
  try {
    const fieldObjects = await pdfDocument.getFieldObjects();
    if (fieldObjects) {
      for (const entries of Object.values(fieldObjects)) {
        if (Array.isArray(entries) && entries.some(entry => entry?.type === "signature")) {
          return true;
        }
      }
    }
    // A signature can also exist as a plain widget annotation with no form
    // field entry, so check the first page's annotations as a fallback.
    const page = await pdfDocument.getPage(1);
    const annotations = await page.getAnnotations({ intent: "any" });
    return annotations.some(annotation =>
      String(annotation?.fieldType || "").toLowerCase() === "sig"
    );
  } catch (_err) {
    return false;
  }
}

function basenameFromUrl(url) {
  try {
    const parsed = new URL(url, "file:///");
    const parts = parsed.pathname.split("/").filter(Boolean);
    return decodeURIComponent(parts[parts.length - 1] || "");
  } catch (_error) {
    return "";
  }
}

// Test-only hook. Autotests cannot reliably trigger this iframe's window-level
// keydown listener via cross-realm dispatchEvent on iframe.contentWindow
// (Chromium does not propagate parent-realm synthetic KeyboardEvents to window
// listeners in a sandboxed iframe). Exposing a direct helper lets the autotest
// exercise the postMessage forwarding path from the iframe's own realm. Real
// keyboard input still goes through the keydown listener unchanged.
// Probe object for autotests. Installed ONLY when the main process passed
// `autotest=1` (it does that solely under ONWARD_AUTOTEST=1), so user builds
// carry no drag/copy simulation surface at all — the gate is structural, not
// a convention that nothing calls these.
if (new URLSearchParams(window.location.search).get("autotest") === "1") {
  window.__onwardPdfTest = {
    /**
     * External-change reload outcomes, appended by postReloadResult. `results`
     * only ever grows within one document session, so a test can assert both
     * "a reload happened" (length grew) and "NO reload happened" (length
     * unchanged after a self-save — the suppression regression lock).
     */
    externalReload: {
      results: [],
      count: function () {
        return this.results.length;
      },
      last: function () {
        return this.results.length ? this.results[this.results.length - 1] : null;
      }
    },

    /** Current document facts for reload assertions. */
    documentInfo: function () {
      return {
        numPages: currentDocument ? currentDocument.numPages : 0,
        fileUrl: currentFileUrl,
        scale: currentScaleSetting,
        scrollTop: els.viewerContainer.scrollTop
      };
    },

    forwardHostKey: function (key, opts) {
      opts = opts || {};
      forwardHostKey({
        key: key,
        code: key === "Escape" ? "Escape" : "Key" + String(key).toUpperCase(),
        metaKey: Boolean(opts.metaKey),
        ctrlKey: Boolean(opts.ctrlKey),
        shiftKey: Boolean(opts.shiftKey),
        altKey: Boolean(opts.altKey)
      });
    },

    // Text-selection probes. Same reason as forwardHostKey above: events
    // constructed in the host realm do not reliably reach listeners registered
    // inside this iframe's realm, and the selection engine's handlers are bound
    // to *this* window. Driving them from in here is the only way an autotest
    // can exercise the real code path rather than a re-implementation of it.
    //
    // Everything below is read-only or synthesises input; nothing changes viewer
    // behaviour when it is not called, which is why it can live unconditionally
    // alongside the existing hook rather than behind a build flag.
    textSelection: {
      /** Page element by 1-based page number, or null if not rendered yet. */
      page: function (pageNumber) {
        return els.viewer.querySelector('.page[data-page-number="' + pageNumber + '"]');
      },

      /** First text-layer span whose text contains `needle`. */
      findSpan: function (pageNumber, needle) {
        const page = window.__onwardPdfTest.textSelection.page(pageNumber);
        if (!page) return null;
        const spans = page.querySelectorAll(".textLayer span");
        for (const span of spans) {
          if (String(span.textContent || "").includes(needle)) return span;
        }
        return null;
      },

      /**
       * Drag-select from just inside the left edge of the span containing
       * `fromNeedle` to just inside the right edge of the span containing
       * `toNeedle`. Anchoring on rendered span rects rather than absolute
       * coordinates keeps the test independent of font metrics and zoom.
       *
       * Returns the resulting selection text, or null when a span is missing.
       */
      dragBetween: function (pageNumber, fromNeedle, toNeedle, options) {
        options = options || {};
        const api = window.__onwardPdfTest.textSelection;
        const fromSpan = api.findSpan(pageNumber, fromNeedle);
        const toSpan = api.findSpan(pageNumber, toNeedle === undefined ? fromNeedle : toNeedle);
        if (!fromSpan || !toSpan) return null;
        const a = fromSpan.getBoundingClientRect();
        const b = toSpan.getBoundingClientRect();
        const inset = typeof options.inset === "number" ? options.inset : 2;
        return api.dragPoints(
          { x: a.left + inset, y: a.top + a.height / 2 },
          { x: b.right - inset, y: b.top + b.height / 2 },
          options.steps
        );
      },

      /**
       * Client rect of a SUBSTRING inside a text-layer span.
       *
       * pdf.js emits one span per `Tj`, so a whole typeset line is usually a
       * single span. Dragging span-edge to span-edge would therefore always
       * select the entire line — an assertion that passes no matter how badly
       * caret mapping is broken. Measuring a substring's own rect is what lets a
       * test target a specific character boundary.
       */
      subRect: function (pageNumber, spanNeedle, subText) {
        const span = window.__onwardPdfTest.textSelection.findSpan(pageNumber, spanNeedle);
        if (!span) return null;
        const node = span.firstChild;
        if (!node || node.nodeType !== Node.TEXT_NODE) return null;
        const index = String(node.nodeValue || "").indexOf(subText);
        if (index < 0) return null;
        const range = document.createRange();
        range.setStart(node, index);
        range.setEnd(node, index + subText.length);
        const rect = range.getBoundingClientRect();
        range.detach();
        if (!rect || rect.width <= 0) return null;
        return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, height: rect.height };
      },

      /**
       * Drag across an exact substring: from just inside the left edge of
       * `fromSub` to just inside the right edge of `toSub`.
       */
      dragSubstrings: function (pageNumber, spanNeedle, fromSub, toSub) {
        const api = window.__onwardPdfTest.textSelection;
        const a = api.subRect(pageNumber, spanNeedle, fromSub);
        const b = api.subRect(pageNumber, spanNeedle, toSub === undefined ? fromSub : toSub);
        if (!a || !b) return null;
        return api.dragPoints(
          { x: a.left + 1, y: a.top + a.height / 2 },
          { x: b.right - 1, y: b.top + b.height / 2 }
        );
      },

      /**
       * Drag from the left edge of `fromSub` to the horizontal MIDDLE of
       * `targetSub`. Used to land a caret inside an indivisible cluster (a
       * ligature) and prove the engine snaps to a cluster boundary instead of
       * splitting the glyph.
       */
      dragIntoMiddleOf: function (pageNumber, spanNeedle, fromSub, targetSub) {
        const api = window.__onwardPdfTest.textSelection;
        const a = api.subRect(pageNumber, spanNeedle, fromSub);
        const b = api.subRect(pageNumber, spanNeedle, targetSub);
        if (!a || !b) return null;
        return api.dragPoints(
          { x: a.left + 1, y: a.top + a.height / 2 },
          { x: (b.left + b.right) / 2, y: b.top + b.height / 2 }
        );
      },

      /** Raw pointer drag between two viewport points, in this realm. */
      dragPoints: function (from, to, steps) {
        const stepCount = Math.max(2, Number(steps) || 6);
        const fire = (type, x, y, buttons) => {
          const target = document.elementFromPoint(x, y) || els.viewerContainer;
          target.dispatchEvent(new MouseEvent(type, {
            bubbles: true,
            cancelable: true,
            view: window,
            clientX: x,
            clientY: y,
            button: 0,
            buttons: buttons
          }));
        };
        fire("mousedown", from.x, from.y, 1);
        for (let i = 1; i <= stepCount; i += 1) {
          const t = i / stepCount;
          fire("mousemove", from.x + (to.x - from.x) * t, from.y + (to.y - from.y) * t, 1);
        }
        fire("mouseup", to.x, to.y, 0);
        return window.__onwardPdfTest.textSelection.selectionText();
      },

      selectionText: function () {
        const selection = window.getSelection();
        return selection && !selection.isCollapsed ? String(selection.toString()) : "";
      },

      clear: function () {
        textSelection.clearSelection();
      },

      /** Number of cross-page overlay rects currently drawn. */
      overlayRectCount: function () {
        return els.viewer.querySelectorAll(".textSelectionOverlayRect").length;
      },

      /** Text-layer content of a page, as the engine left it after filtering. */
      textLayerContent: function (pageNumber) {
        const page = window.__onwardPdfTest.textSelection.page(pageNumber);
        const layer = page && page.querySelector(".textLayer");
        return layer ? String(layer.textContent || "") : "";
      },

      /** Invisible spans still present after hidden-text filtering. */
      invisibleSpanCount: function (pageNumber) {
        const page = window.__onwardPdfTest.textSelection.page(pageNumber);
        if (!page) return -1;
        return page.querySelectorAll('.textLayer span[data-pdf-invisible-text="1"]').length;
      },

      /** Map of annotation id -> classified selection role for a page. */
      annotationRoles: function (pageNumber) {
        const page = window.__onwardPdfTest.textSelection.page(pageNumber);
        if (!page) return {};
        const out = {};
        const sections = page.querySelectorAll(".annotationLayer section[data-annotation-id]");
        for (const section of sections) {
          out[section.getAttribute("data-annotation-id")] =
            section.dataset.textSelectionRole || "";
        }
        return out;
      },

      /**
       * Run the real `copy` handler against a stub clipboard and report what it
       * wrote. This is the only way to assert the clipboard contract
       * (clipboard === visible selection) without touching the OS clipboard,
       * which an autotest must not do.
       */
      /* ---- highlight probes ---- */

    /** Drag-select a substring, then apply the Nth label via its chip. */
    highlightSubstring: function (pageNumber, spanNeedle, subText, labelIndex) {
      const api = window.__onwardPdfTest.textSelection;
      const selected = api.dragSubstrings(pageNumber, spanNeedle, subText);
      if (!selected) return null;
      const labels = highlight.getLabels();
      const label = labels[Number(labelIndex) || 0];
      if (!label) return null;
      highlight.applyLabelToSelection(label.id);
      return { selected: selected, labelId: label.id };
    },

    paletteVisible: function () {
      return highlight.isPaletteVisible();
    },

    /** Painted highlight rects on a page, with their resolved colours. */
    highlightRects: function (pageNumber) {
      const page = window.__onwardPdfTest.textSelection.page(pageNumber);
      if (!page) return [];
      return Array.from(page.querySelectorAll(".highlightAnnotRect")).map(el => ({
        annotId: el.dataset.annotId,
        left: Math.round(el.getBoundingClientRect().left),
        width: Math.round(el.getBoundingClientRect().width),
        background: el.style.background
      }));
    },

    annotationCount: function () {
      return highlight.getAnnotationCount();
    },

    annotationRecords: function () {
      return annotationStore.annotations.map(a => ({
        id: a.id,
        labelId: a.labelId,
        color: a.color,
        page: a.page,
        note: a.note || "",
        textSnapshot: a.textSnapshot || "",
        quadCount: Array.isArray(a.quads) ? a.quads.length : 0
      }));
    },

    isDirty: function () {
      return annotationStore.isDirty();
    },

    saveNow: function () {
      return annotationStore.saveNow();
    },

    /** Open the note editor for the first annotation and type into it. */
    writeNote: function (text) {
      const first = annotationStore.annotations[0];
      if (!first) return null;
      highlight.openNoteEditor(first.id, 100, 100);
      els.noteText.value = String(text);
      els.noteText.dispatchEvent(new Event("input", { bubbles: true }));
      const written = annotationStore.annotations[0].note;
      // Close it again, exactly as clicking Done would. Leaving the popup open
      // swallows the next drag on the page, which is not what a user sees.
      highlight.closeNoteEditor();
      return written;
    },

    noteMarkerCount: function (pageNumber) {
      const page = window.__onwardPdfTest.textSelection.page(pageNumber);
      return page ? page.querySelectorAll(".highlight-note-marker").length : 0;
    },

    deleteFirstAnnotation: function () {
      const first = annotationStore.annotations[0];
      if (!first) return false;
      highlight.openNoteEditor(first.id, 100, 100);
      highlight.deleteCurrentAnnotation();
      return true;
    },

    simulateCopy: function () {
        let written = null;
        const event = new Event("copy", { bubbles: true, cancelable: true });
        Object.defineProperty(event, "clipboardData", {
          value: {
            clearData: function () { written = null; },
            setData: function (type, value) { if (type === "text/plain") written = value; }
          }
        });
        document.dispatchEvent(event);
        return written;
      }
    }
  };
}
