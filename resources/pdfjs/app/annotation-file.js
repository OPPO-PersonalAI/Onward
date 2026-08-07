/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 *
 * Reading and writing highlight annotations inside the PDF file itself.
 *
 * Storage decision (confirmed with the user, 2026-07-28): annotations are
 * written into the document, not into a sidecar file or app state. The
 * consequence is that they travel with the PDF — another machine, another
 * reader, Zotero, Preview, or the project's own Python extraction script all
 * see them — and the cost is that Onward now modifies the user's source file.
 * Everything defensive about the write path exists because of that trade.
 *
 * On-disk format (unchanged from the Dark_PDF_Reader reference, deliberately —
 * the user chose full interoperability, so both tools read and write the same
 * bytes and the existing `extract_annotations.py` keeps working):
 *
 *   Standard keys, understood by any PDF reader:
 *     /Subtype /Highlight, /Rect, /QuadPoints, /C, /CA, /Contents, /T, /NM
 *   Private keys, how we recognise our own:
 *     /CYY_MARK        scan token, fixed string
 *     /CYY_MARK_Label  label name
 *     /CYY_MARK_Id     stable id
 *     /CYY_MARK_Data   the full record as JSON
 *
 * A document-level attachment `CYY_MARK-manifest.json` mirrors the whole set
 * plus the colour legend. It is a recovery path: re-saving through Preview or
 * Acrobat's "optimise" can strip private keys, and the manifest survives more
 * of those round trips than the per-annotation keys do.
 *
 * No appearance stream (`/AP`) is written. Our own viewer, Chrome's PDFium,
 * Adobe and pdf.js all render highlights from QuadPoints; macOS Preview may
 * not. That was the reference project's call and it carries over unchanged.
 *
 * Writing uses pdf-lib's full-document rewrite, which drops any existing
 * digital signature and linearisation. The store checks for signatures before
 * the first write and asks rather than silently invalidating one.
 */

"use strict";

(function () {
  // Colour conversion is shared with the render layer — a highlight written to
  // the file and the same highlight painted on screen must agree on the colour,
  // so both read it from one place.
  const { hexToUnitRgb, HIGHLIGHT_FILL_OPACITY } = window.OnwardPdfHighlightCore;

  // Deliberately the reference project's identifiers, not Onward's. The user
  // chose full interoperability, so the bytes on disk stay byte-compatible with
  // Dark_PDF_Reader and with `scripts/extract_annotations.py`. Renaming these
  // would be a cosmetic win paid for with a silent data-compatibility break.
  const ANNOT_APP_ID = "DarkPDFReader";
  const ANNOT_MARK_KEY = "CYY_MARK";

  const NOOP = function () {};

  function create(deps) {
    const viewerEl = deps.viewer;
    const getDocument = deps.getDocument;
    const getAnnotations = deps.getAnnotations;
    const getLabels = deps.getLabels;
    const getRevision = deps.getRevision;
    const trace = deps.trace || NOOP;

    // Ids of annotations already inside the PDF that we wrote ourselves. They
    // must be suppressed in pdf.js's own rendering, or a saved-then-reopened
    // document shows every highlight twice: once from the file, once from our
    // layer.
    let ownNativeAnnotationIds = new Set();
    const nativeSuppressions = new WeakMap();

    // Stable id for the open document, carried in the embedded manifest so a
    // manifest can be recognised as belonging to this file after a third-party
    // re-save has stripped the per-annotation private keys.
    let currentDocumentId = "";

    function findAnnotationSectionIn(page, annotationId) {
      const id = String(annotationId || "");
      return Array.from(
        page.querySelectorAll(".annotationLayer section[data-annotation-id]")
      ).find(section => section.getAttribute("data-annotation-id") === id) || null;
    }

  /* ---- annotation record cloning (DPR 4091-4098) ---- */
  function cloneAnnotations(annotations) {
    return annotations.map(annot => ({
      ...annot,
      quads: Array.isArray(annot.quads) ? [...annot.quads] : [],
      rectUnion: Array.isArray(annot.rectUnion) ? [...annot.rectUnion] : [],
      paletteAnchor: annot.paletteAnchor ? { ...annot.paletteAnchor } : null
    }));
  }

  /* ---- document id normalisation (DPR 4240-4246) ---- */
  function normalizeAnnotationDocumentId(value) {
    const text = String(value || "").trim();
    if (text.length < 8 || text.length > 128 || !/^[a-zA-Z0-9._:-]+$/.test(text)) {
      return "";
    }
    return text;
  }

  /* ---- stable identifier hashing ---- */
  // FNV-1a. Not cryptographic — it exists so a trace payload can refer to an
  // annotation without carrying its id (which is derived from a timestamp and
  // would let two bug reports be correlated).
  function hashDiagnosticIdentifier(value) {
    const text = String(value || "");
    let hash = 2166136261;
    for (let index = 0; index < text.length; index += 1) {
      hash ^= text.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
    return `h${(hash >>> 0).toString(16).padStart(8, "0")}`;
  }

  /* ---- palette anchor normalisation (DPR 9902-9910) ---- */
  function normalizePaletteAnchorRecord(value) {
    const page = Number.parseInt(value?.page, 10);
    const x = Number(value?.x);
    const y = Number(value?.y);
    if (!Number.isFinite(page) || page <= 0 || !Number.isFinite(x) || !Number.isFinite(y)) {
      return null;
    }
    return { page, x, y };
  }

    /* ==== write annotations into PDF bytes (DPR 4713-4886) ==== */
    async function buildAnnotatedPdfBytes(snapshot = null) {
      // The store passes the records it intends to persist; anything it leaves
      // out falls back to live state. Taking the snapshot from the caller
      // matters: serialising a large document is slow enough that the user can
      // add another highlight while it runs, and a write must persist exactly
      // the set it was asked for, not a moving target.
      const buildState = {
        pdfDocument: (snapshot && snapshot.pdfDocument) || getDocument(),
        annotations: cloneAnnotations((snapshot && snapshot.annotations) || getAnnotations()),
        labels: ((snapshot && snapshot.labels) || getLabels()).map(label => ({ ...label })),
        revision: Number((snapshot && snapshot.revision) ?? getRevision()),
        documentId: (snapshot && snapshot.documentId) || currentDocumentId
      };
      if (!buildState.pdfDocument) {
        throw new Error("No PDF is open.");
      }
      if (!window.PDFLib) {
        throw new Error("The PDF writing library is not loaded.");
      }
      const { PDFDocument, PDFName, PDFArray, PDFString, PDFHexString } = window.PDFLib;
      const srcBytes = await buildState.pdfDocument.getData();
      const doc = await PDFDocument.load(srcBytes, { ignoreEncryption: true });
      const ctx = doc.context;
      const pages = doc.getPages();
      const markKey = PDFName.of(ANNOT_MARK_KEY);

      for (let pageIndex = 0; pageIndex < pages.length; pageIndex += 1) {
        const page = pages[pageIndex];
        stripOurAnnotations(page, ctx, PDFName, PDFArray, markKey);

        const pageAnnots = buildState.annotations.filter(annot => annot.page === pageIndex + 1);
        if (!pageAnnots.length) {
          continue;
        }
        let annotsArr = page.node.lookupMaybe(PDFName.of("Annots"), PDFArray);
        if (!annotsArr) {
          annotsArr = ctx.obj([]);
          page.node.set(PDFName.of("Annots"), annotsArr);
        }
        for (const annot of pageAnnots) {
          const [r, g, b] = hexToUnitRgb(annot.color);
          const dict = ctx.obj({
            Type: "Annot",
            Subtype: "Highlight",
            Rect: annot.rectUnion,
            QuadPoints: annot.quads,
            C: [r, g, b],
            CA: HIGHLIGHT_FILL_OPACITY,
            F: 4,
            T: PDFString.of(ANNOT_APP_ID),
            NM: PDFString.of(annot.id),
            CreationDate: PDFString.of(pdfDateString(annot.createdAt)),
            M: PDFString.of(pdfDateString(annot.updatedAt))
          });
          dict.set(PDFName.of("Contents"), PDFHexString.fromText(annot.note || ""));
          dict.set(markKey, PDFHexString.fromText(ANNOT_APP_ID));
          dict.set(PDFName.of(`${ANNOT_MARK_KEY}_Label`), PDFHexString.fromText(annot.labelName || ""));
          dict.set(PDFName.of(`${ANNOT_MARK_KEY}_Id`), PDFHexString.fromText(annot.id));
          dict.set(
            PDFName.of(`${ANNOT_MARK_KEY}_Data`),
            PDFHexString.fromText(JSON.stringify(annotToRecord(annot)))
          );
          annotsArr.push(ctx.register(dict));
        }
      }

      const manifest = buildManifestJson(buildState);
      await doc.attach(new TextEncoder().encode(manifest), `${ANNOT_MARK_KEY}-manifest.json`, {
        mimeType: "application/json",
        description: "Dark PDF Reader annotations manifest"
      });

      return doc.save();
    }

    function stripOurAnnotations(page, ctx, PDFName, PDFArray, markKey) {
      const annotsArr = page.node.lookupMaybe(PDFName.of("Annots"), PDFArray);
      if (!annotsArr) {
        return;
      }
      const kept = [];
      for (let i = 0; i < annotsArr.size(); i += 1) {
        const ref = annotsArr.get(i);
        let dict = null;
        try {
          dict = ctx.lookup(ref);
        } catch (error) {
          dict = null;
        }
        const marker = dict && typeof dict.get === "function" ? dict.get(markKey) : null;
        const isOurs = getPdfObjectText(marker) === ANNOT_APP_ID;
        if (!isOurs) {
          kept.push(ref);
        }
      }
      page.node.set(PDFName.of("Annots"), ctx.obj(kept));
    }

    function annotToRecord(annot) {
      return {
        id: annot.id,
        labelId: annot.labelId,
        labelName: annot.labelName,
        color: annot.color,
        page: annot.page,
        note: annot.note || "",
        textSnapshot: annot.textSnapshot || "",
        quads: annot.quads,
        rectUnion: annot.rectUnion,
        paletteAnchor: normalizePaletteAnchorRecord(annot.paletteAnchor),
        createdAt: annot.createdAt,
        updatedAt: annot.updatedAt
      };
    }

    function getPdfObjectText(value) {
      if (typeof value?.decodeText === "function") {
        try {
          return value.decodeText().trim();
        } catch (error) {
          return "";
        }
      }
      if (typeof value?.asString === "function") {
        try {
          return value.asString().trim();
        } catch (error) {
          return "";
        }
      }
      return String(value || "").trim();
    }

    function buildManifestJson(buildState = {}) {
      const annotations = Array.isArray(buildState.annotations) ? buildState.annotations : [];
      const labels = Array.isArray(buildState.labels) ? buildState.labels : [];
      return JSON.stringify({
        app: ANNOT_APP_ID,
        mark: ANNOT_MARK_KEY,
        version: 2,
        documentId: normalizeAnnotationDocumentId(buildState.documentId),
        revision: Number.isSafeInteger(buildState.revision) ? buildState.revision : 0,
        stateId: getAnnotationStateId(annotations),
        savedAt: Date.now(),
        labels,
        annotations: annotations.map(annotToRecord)
      });
    }

    function getAnnotationStateId(annotations) {
      const records = annotations
        .map(annot => annotToRecord(annot))
        .sort((a, b) => String(a.id).localeCompare(String(b.id)));
      return hashDiagnosticIdentifier(JSON.stringify(records));
    }

    function getAnnotationSourceSignature(state = {}) {
      const present = Boolean(state.present);
      if (!present) {
        return "plain-empty";
      }
      const annotations = Array.isArray(state.annotations) ? state.annotations : [];
      const revision = Number.isSafeInteger(state.revision) ? state.revision : 0;
      return hashDiagnosticIdentifier(JSON.stringify({
        present: true,
        revision,
        stateId: getAnnotationStateId(annotations)
      }));
    }

    function pdfDateString(ms) {
      const date = Number.isFinite(ms) ? new Date(ms) : new Date();
      const pad = value => String(value).padStart(2, "0");
      return (
        `D:${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}` +
        `${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}Z`
      );
    }


    /* ==== read annotations back from a PDF (DPR 5294-5400) ==== */
    async function readAnnotationStateFromPdf(pdfDocument) {
      const emptyState = {
        annotations: [],
        nativeIds: [],
        present: false,
        revision: 0,
        sourceSignature: "plain-empty",
        documentId: ""
      };
      if (!window.PDFLib) {
        return emptyState;
      }
      try {
        const { PDFDocument, PDFName, PDFArray } = window.PDFLib;
        const manifest = await readAnnotationManifest(pdfDocument);
        const bytes = await pdfDocument.getData();
        const doc = await PDFDocument.load(bytes, { ignoreEncryption: true });
        const ctx = doc.context;
        const markKey = PDFName.of(ANNOT_MARK_KEY);
        const dataKey = PDFName.of(`${ANNOT_MARK_KEY}_Data`);
        const out = [];
        const nativeIds = [];

        for (const page of doc.getPages()) {
          const annotsArr = page.node.lookupMaybe(PDFName.of("Annots"), PDFArray);
          if (!annotsArr) {
            continue;
          }
          for (let i = 0; i < annotsArr.size(); i += 1) {
            const ref = annotsArr.get(i);
            let dict = null;
            try {
              dict = ctx.lookup(ref);
            } catch (error) {
              dict = null;
            }
            if (!dict || typeof dict.get !== "function") {
              continue;
            }
            if (getPdfObjectText(dict.get(markKey)) !== ANNOT_APP_ID) {
              continue;
            }
            // The marker alone proves this annotation is ours. Even when the
            // private payload is missing or corrupt (an older version, or a
            // third-party re-save), the native pdf.js layer still has to be
            // hidden — otherwise the list shows no record while the page keeps
            // a coloured shadow the user cannot remove.
            const nativeId = pdfLibRefToPdfJsId(ref);
            if (nativeId) {
              nativeIds.push(nativeId);
            }
            const dataObj = dict.get(dataKey);
            if (!dataObj || typeof dataObj.decodeText !== "function") {
              continue;
            }
            try {
              const record = JSON.parse(dataObj.decodeText());
              if (record && Array.isArray(record.quads) && Number.isFinite(record.page)) {
                out.push(record);
              }
            } catch (error) {
              // Skip a corrupt record rather than failing the whole read.
            }
          }
        }
        const present = Boolean(nativeIds.length || manifest);
        const revision = Number.isSafeInteger(manifest?.revision) ? manifest.revision : 0;
        const sourceSignature = getAnnotationSourceSignature({
          present,
          revision,
          annotations: out
        });
        const documentId = normalizeAnnotationDocumentId(manifest?.documentId);
        return { annotations: out, nativeIds, present, revision, sourceSignature, documentId };
      } catch (error) {
        console.warn("Failed to read annotations from PDF.", error);
        return emptyState;
      }
    }

    async function readAnnotationsFromPdf(pdfDocument) {
      return (await readAnnotationStateFromPdf(pdfDocument)).annotations;
    }

    async function readAnnotationManifest(pdfDocument) {
      try {
        const attachments = await pdfDocument.getAttachments();
        const entry = attachments?.[`${ANNOT_MARK_KEY}-manifest.json`];
        if (!entry?.content) {
          return null;
        }
        const parsed = JSON.parse(new TextDecoder().decode(entry.content));
        if (parsed?.app !== ANNOT_APP_ID || parsed?.mark !== ANNOT_MARK_KEY) {
          return null;
        }
        return parsed;
      } catch (error) {
        return null;
      }
    }

    function pdfLibRefToPdfJsId(ref) {
      const objectNumber = Number(ref?.objectNumber);
      const generationNumber = Number(ref?.generationNumber || 0);
      if (!Number.isSafeInteger(objectNumber) || objectNumber <= 0) {
        return "";
      }
      return `${objectNumber}R${generationNumber > 0 ? generationNumber : ""}`;
    }


    /* ==== suppress our own native annotation rendering (DPR 1716-1826) ==== */
    function markOwnAnnotationSection(page, section, annotationId) {
      if (section.classList.contains("popupAnnotation")) {
        section.dataset.onwardAnnotationPopup = "true";
        section.hidden = true;
        return;
      }
      section.dataset.onwardAnnotation = "true";
      if (section.classList.contains("highlightAnnotation")) {
        section.hidden = true;
        section.setAttribute("aria-hidden", "true");
      }
      const popupSection = findAnnotationSectionIn(page, `popup_${annotationId}`);
      if (popupSection) {
        popupSection.dataset.onwardAnnotationPopup = "true";
        popupSection.hidden = true;
      }
    }

    function applyKnownOwnNativeAnnotationVisibility() {
      let renderedCount = 0;
      for (const page of viewerEl.querySelectorAll(".page")) {
        for (const annotationId of ownNativeAnnotationIds) {
          const section = findAnnotationSectionIn(page, annotationId);
          if (!section) {
            continue;
          }
          markOwnAnnotationSection(page, section, annotationId);
          renderedCount += 1;
        }
        markOwnPopupSections(page);
      }
      trace("annotation.native-cleanup", {
        nativeCount: ownNativeAnnotationIds.size,
        renderedCount: renderedCount
      });
    }

    function getNativeAnnotationRenderSuppression(pdfDocument) {
      const transport = pdfDocument?._transport;
      if (!transport || typeof transport.getRenderingIntent !== "function") {
        return null;
      }
      const existing = nativeSuppressions.get(transport);
      if (existing) {
        return existing;
      }

      // pdf.js 3.11 runs the PDFViewer in ENABLE_FORMS mode, which does not
      // hand the annotationStorage to the worker. CSS alone therefore cannot
      // stop a native /Highlight from being painted into the page canvas. So
      // we inject a throwaway storage containing only noView entries at the
      // rendering boundary: interactive forms keep working, and the document's
      // real storage is left untouched.
      const suppression = { annotationIds: new Set() };
      const getRenderingIntent = transport.getRenderingIntent;
      transport.getRenderingIntent = function (...args) {
        const result = getRenderingIntent.apply(this, args);
        if (
          args[1] !== pdfjsLib.AnnotationMode.ENABLE_FORMS ||
          suppression.annotationIds.size === 0
        ) {
          return result;
        }
        const annotationIds = Array.from(suppression.annotationIds).sort();
        const hash = `onward-no-view-${hashDiagnosticIdentifier(JSON.stringify(annotationIds))}`;
        const map = new Map(annotationIds.map(annotationId => [annotationId, { noView: true }]));
        const annotationStorageSerializable = { map, hash, transfers: [] };
        result.annotationStorageSerializable = annotationStorageSerializable;
        result.cacheKey = `${result.renderingIntent}_${hash}`;
        return result;
      };
      nativeSuppressions.set(transport, suppression);
      return suppression;
    }

    function suppressOwnNativeAnnotationsInCanvas(pdfDocument, annotationIds) {
      const ids = Array.from(annotationIds || []).filter(Boolean);
      if (!ids.length) {
        return false;
      }
      const suppression = getNativeAnnotationRenderSuppression(pdfDocument);
      if (!suppression) {
        return false;
      }
      for (const annotationId of ids) {
        suppression.annotationIds.add(annotationId);
      }
      return true;
    }

    function markOwnPopupSections(page) {
      const ownAnnotationIds = new Set(
        Array.from(page.querySelectorAll('.annotationLayer section[data-onward-annotation-annotation="true"]'))
          .map(section => section.getAttribute("data-annotation-id"))
          .filter(Boolean)
      );
      if (!ownAnnotationIds.size) {
        return;
      }
      for (const popupSection of page.querySelectorAll(".annotationLayer section.popupAnnotation")) {
        const popupId = popupSection.getAttribute("data-annotation-id") || "";
        const parentId = popupId.startsWith("popup_") ? popupId.slice("popup_".length) : "";
        const controls = popupSection.getAttribute("aria-controls") || "";
        const controlsOwnAnnotation = Array.from(ownAnnotationIds).some(id =>
          controls.includes(`pdfjs_internal_id_${id}`)
        );
        if (ownAnnotationIds.has(parentId) || controlsOwnAnnotation) {
          popupSection.dataset.onwardAnnotationPopup = "true";
          popupSection.hidden = true;
        }
      }
    }


    return {
      /** Serialise the current annotation set into new PDF bytes. */
      buildAnnotatedPdfBytes: buildAnnotatedPdfBytes,

      /** Read our annotations back out of a freshly opened document. */
      readAnnotationStateFromPdf: async function (pdfDocument) {
        const state = await readAnnotationStateFromPdf(pdfDocument);
        // Adopt the document id the file already carries, so a save preserves
        // it instead of minting a new one on every open.
        currentDocumentId = normalizeAnnotationDocumentId(state && state.documentId) || currentDocumentId;
        ownNativeAnnotationIds = new Set((state && state.nativeIds) || []);
        return state;
      },

      /** Ids of our annotations that already live inside the open document. */
      getOwnNativeAnnotationIds: function () {
        return new Set(ownNativeAnnotationIds);
      },
      setOwnNativeAnnotationIds: function (ids) {
        ownNativeAnnotationIds = new Set(ids || []);
      },

      /** True when the given pdf.js annotation is one of ours. */
      isOwnAnnotation: function (annotation) {
        return ownNativeAnnotationIds.has(String((annotation && annotation.id) || ""));
      },

      /** Hide a rendered section belonging to one of our annotations. */
      onOwnAnnotationSection: markOwnAnnotationSection,
      onPageAnnotationsIndexed: markOwnPopupSections,

      /** Re-apply suppression to pages that rendered before we knew the ids. */
      applyKnownOwnNativeAnnotationVisibility: applyKnownOwnNativeAnnotationVisibility,

      /** Keep our highlights out of the page canvas as well as the DOM. */
      suppressOwnNativeAnnotationsInCanvas: suppressOwnNativeAnnotationsInCanvas,

      reset: function () {
        ownNativeAnnotationIds = new Set();
      }
    };
  }

  window.OnwardPdfAnnotationFile = {
    create: create,
    ANNOT_APP_ID: ANNOT_APP_ID,
    ANNOT_MARK_KEY: ANNOT_MARK_KEY
  };
})();
