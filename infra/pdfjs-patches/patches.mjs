/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 *
 * Private patches applied on top of the vendored pdf.js build under
 * `resources/pdfjs/`.
 *
 * Why anchored find/replace instead of a unified diff: the targets are webpack
 * build artefacts, not hand-maintained sources. `patch(1)` is not present by
 * default on Windows, and line-number-based hunks go stale the moment the
 * bundle is regenerated. Exact-string anchors either match or fail loudly, and
 * they behave identically on macOS, Linux and Windows.
 *
 * Applying is idempotent: a hunk whose replacement text is already present is
 * reported as `already-applied` rather than failing.
 *
 * When bumping pdf.js: run `node scripts/apply-pdfjs-patches.mjs --check`.
 * Every hunk that no longer matches must be re-derived by hand against the new
 * bundle before the bump can land.
 *
 * pdf.js is Apache-2.0, the same licence as this project.
 */

export const PDFJS_VERSION = '3.11.174'

export const PATCH_GROUPS = {
  "crash-fix": "Unconditional crash fix. Always applied.",
  "hidden-text": "Required by the text-selection engine: without it, text hidden under visible text (scanned pages with an OCR layer, watermark tricks) can be selected and copied even though the user cannot see it.",
  "arabic": "Keeps Arabic/CID text in logical order so selection offsets match what is rendered. Hebrew keeps pdf.js's original bidi handling."
}

export const PATCHES = [
  {
    id: "alt-text-manager-null-guard",
    group: "crash-fix",
    file: "build/pdf.js",
    why: "AnnotationEditorUIManager.destroy() dereferences #altTextManager unconditionally. Onward reuses one PDFViewer across documents, so setDocument(null) hits this with the manager already gone and the throw aborts opening the next PDF.",
    find: "    this.#selectedEditors.clear();\n    this.#commandManager.destroy();\n    this.#altTextManager.destroy();\n  }\n  get hcmFilter() {",
    replace: "    this.#selectedEditors.clear();\n    this.#commandManager.destroy();\n    this.#altTextManager?.destroy();\n  }\n  get hcmFilter() {"
  },
  {
    id: "invisible-text-dom-marker",
    group: "hidden-text",
    file: "build/pdf.js",
    why: "Carry the worker's isInvisibleText flag onto the text-layer span so the viewer can tell covered hidden/OCR text apart from OCR-only scanned text at DOM level.",
    find: "  textDiv.textContent = geom.str;\n  textDiv.dir = geom.dir;\n  if (task._fontInspectorEnabled) {\n    textDiv.dataset.fontName = geom.fontName;",
    replace: "  textDiv.textContent = geom.str;\n  textDiv.dir = geom.dir;\n  if (geom.isInvisibleText) {\n    textDiv.dataset.pdfInvisibleText = \"1\";\n  }\n  if (task._fontInspectorEnabled) {\n    textDiv.dataset.fontName = geom.fontName;"
  },
  {
    id: "invisible-text-item-field",
    group: "hidden-text",
    file: "build/pdf.worker.js",
    why: "Add the isInvisibleText field to the text-content accumulator.",
    find: "      transform: null,\n      fontName: null,\n      hasEOL: false\n    };\n    const twoLastChars = [\" \", \" \"];",
    replace: "      transform: null,\n      fontName: null,\n      hasEOL: false,\n      isInvisibleText: false\n    };\n    const twoLastChars = [\" \", \" \"];"
  },
  {
    id: "invisible-text-item-set",
    group: "hidden-text",
    file: "build/pdf.worker.js",
    why: "Record text visibility at the moment a new text chunk starts.",
    find: "      }\n      textContentItem.fontName = loadedName;\n      const trm = textContentItem.transform = getCurrentTextTransform();\n      if (!font.vertical) {",
    replace: "      }\n      textContentItem.fontName = loadedName;\n      textContentItem.isInvisibleText = !isCurrentTextRenderingVisible();\n      const trm = textContentItem.transform = getCurrentTextTransform();\n      if (!font.vertical) {"
  },
  {
    id: "arabic-bidi-preserve-str",
    group: "arabic",
    file: "build/pdf.worker.js",
    why: "Use the original logical-order string for Arabic instead of the bidi-reordered one.",
    find: "      }\n      const bidiResult = (0, _bidi.bidi)(text, -1, textChunk.vertical);\n      return {\n        str: bidiResult.str,\n        dir: bidiResult.dir,\n        width: Math.abs(textChunk.totalWidth),",
    replace: "      }\n      const bidiResult = (0, _bidi.bidi)(text, -1, textChunk.vertical);\n      const str = shouldKeepOriginalArabicBidiText(text, bidiResult.str) ? text : bidiResult.str;\n      return {\n        str,\n        dir: bidiResult.dir,\n        width: Math.abs(textChunk.totalWidth),"
  },
  {
    id: "arabic-bidi-helpers",
    group: "arabic",
    file: "build/pdf.worker.js",
    why: "Emit isInvisibleText on the item and add the Arabic/Hebrew script probes used by the decision above.",
    find: "        transform: textChunk.transform,\n        fontName: textChunk.fontName,\n        hasEOL: textChunk.hasEOL\n      };\n    }\n    function handleSetFont(fontName, fontRef) {",
    replace: "        transform: textChunk.transform,\n        fontName: textChunk.fontName,\n        hasEOL: textChunk.hasEOL,\n        isInvisibleText: textChunk.isInvisibleText || undefined\n      };\n    }\n    function shouldKeepOriginalArabicBidiText(text, bidiText) {\n      if (text === bidiText || !hasArabicScript(text) || hasHebrewScript(text)) {\n        return false;\n      }\n      return true;\n    }\n    function hasArabicScript(text) {\n      return /[\\u0600-\\u06ff\\u0750-\\u077f\\u08a0-\\u08ff\\ufb50-\\ufdff\\ufe70-\\ufeff]/.test(text);\n    }\n    function hasHebrewScript(text) {\n      return /[\\u0590-\\u05ff]/.test(text);\n    }\n    function handleSetFont(fontName, fontRef) {"
  },
  {
    id: "text-rendering-visibility-probe",
    group: "hidden-text",
    file: "build/pdf.worker.js",
    why: "Decide visibility from the text rendering mode combined with fill/stroke alpha.",
    find: "      });\n    }\n    function applyInverseRotation(x, y, matrix) {\n      const scale = Math.hypot(matrix[0], matrix[1]);",
    replace: "      });\n    }\n    function isCurrentTextRenderingVisible() {\n      const fillStrokeMode = textState.textRenderingMode & _util.TextRenderingMode.FILL_STROKE_MASK;\n      switch (fillStrokeMode) {\n        case _util.TextRenderingMode.FILL:\n          return textState.fillAlpha > 0;\n        case _util.TextRenderingMode.STROKE:\n          return textState.strokeAlpha > 0;\n        case _util.TextRenderingMode.FILL_STROKE:\n          return textState.fillAlpha > 0 || textState.strokeAlpha > 0;\n        case _util.TextRenderingMode.INVISIBLE:\n          return false;\n      }\n      return true;\n    }\n    function applyInverseRotation(x, y, matrix) {\n      const scale = Math.hypot(matrix[0], matrix[1]);"
  },
  {
    id: "flush-on-invisible-transition",
    group: "hidden-text",
    file: "build/pdf.worker.js",
    why: "Flush the accumulated chunk when text crosses a visibility boundary, so one chunk never mixes visible and invisible glyphs.",
    find: "        return;\n      }\n      const glyphs = font.charsToGlyphs(chars);\n      const scale = textState.fontMatrix[0] * textState.fontSize;",
    replace: "        return;\n      }\n      const isTextRenderingVisible = isCurrentTextRenderingVisible();\n      if (!isTextRenderingVisible) {\n        resetLastChars();\n        flushTextContentItem();\n      }\n      const glyphs = font.charsToGlyphs(chars);\n      const scale = textState.fontMatrix[0] * textState.fontSize;"
  },
  {
    id: "track-set-text-rendering-mode",
    group: "hidden-text",
    file: "build/pdf.worker.js",
    why: "Track the Tr operator; Tr=3/7 draws nothing but still produces text content.",
    find: "            textState.textLineMatrix = _util.IDENTITY_MATRIX.slice();\n            break;\n          case _util.OPS.showSpacedText:\n            if (!stateManager.state.font) {",
    replace: "            textState.textLineMatrix = _util.IDENTITY_MATRIX.slice();\n            break;\n          case _util.OPS.setTextRenderingMode:\n            if (textState.textRenderingMode !== args[0]) {\n              flushTextContentItem();\n              resetLastChars();\n              textState.textRenderingMode = args[0];\n            }\n            break;\n          case _util.OPS.showSpacedText:\n            if (!stateManager.state.font) {"
  },
  {
    id: "track-extgstate-alpha",
    group: "hidden-text",
    file: "build/pdf.worker.js",
    why: "Track ExtGState /ca and /CA so alpha-0 text is classified as invisible, and stop caching such a gState as empty.",
    find: "                throw new _util.FormatError(\"GState should be a dictionary.\");\n              }\n              const gStateFont = gState.get(\"Font\");\n              if (!gStateFont) {\n                emptyGStateCache.set(name, gState.objId, true);\n                resolveGState();\n                return;",
    replace: "                throw new _util.FormatError(\"GState should be a dictionary.\");\n              }\n              let fillAlpha = null;\n              let strokeAlpha = null;\n              for (const key of gState.getKeys()) {\n                const value = gState.get(key);\n                if (key === \"ca\" && typeof value === \"number\" && value >= 0 && value <= 1) {\n                  fillAlpha = value;\n                } else if (key === \"CA\" && typeof value === \"number\" && value >= 0 && value <= 1) {\n                  strokeAlpha = value;\n                }\n              }\n              if (\n                (fillAlpha !== null && textState.fillAlpha !== fillAlpha) ||\n                (strokeAlpha !== null && textState.strokeAlpha !== strokeAlpha)\n              ) {\n                flushTextContentItem();\n                resetLastChars();\n                if (fillAlpha !== null) {\n                  textState.fillAlpha = fillAlpha;\n                }\n                if (strokeAlpha !== null) {\n                  textState.strokeAlpha = strokeAlpha;\n                }\n              }\n              const hasTextVisibilityState = fillAlpha !== null || strokeAlpha !== null;\n              const gStateFont = gState.get(\"Font\");\n              if (!gStateFont) {\n                if (!hasTextVisibilityState) {\n                  emptyGStateCache.set(name, gState.objId, true);\n                }\n                resolveGState();\n                return;"
  },
  {
    id: "text-state-visibility-fields",
    group: "hidden-text",
    file: "build/pdf.worker.js",
    why: "Initialise textRenderingMode / fillAlpha / strokeAlpha on TextState.",
    find: "    this.textHScale = 1;\n    this.textRise = 0;\n  }\n  setTextMatrix(a, b, c, d, e, f) {",
    replace: "    this.textHScale = 1;\n    this.textRise = 0;\n    this.textRenderingMode = _util.TextRenderingMode.FILL;\n    this.fillAlpha = 1;\n    this.strokeAlpha = 1;\n  }\n  setTextMatrix(a, b, c, d, e, f) {"
  }
]
