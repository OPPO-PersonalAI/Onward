/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 *
 * The same 11 private pdf.js patches as patches.mjs, expressed against the
 * UPSTREAM SOURCE TREE (mozilla/pdf.js at v3.11.174) instead of the webpack
 * build artefacts.
 *
 * Why both exist: patches.mjs guards the COMMITTED artefacts under
 * resources/pdfjs/build/ (users and CI never need the pdf.js toolchain).
 * This file is the UPGRADE path: source anchors survive a version bump far
 * better than anchors into webpack output, so bumping pdf.js becomes
 * "re-anchor against readable source where needed, rebuild, sync" instead of
 * "re-derive 11 hunks by hand against a regenerated bundle".
 *
 * Logic is identical hunk-for-hunk; the only differences are the source
 * spellings (plain `TextRenderingMode` for the bundle's `_util.
 * TextRenderingMode`, `bidi(...)` for `(0, _bidi.bidi)(...)`) and upstream's
 * comments/blank lines inside the anchors. Hunk ids match patches.mjs 1:1 so
 * the two files can be audited side by side.
 *
 * Driven by scripts/pdf/build-pdfjs-from-source.mjs. pdf.js is Apache-2.0,
 * the same licence as this project.
 */

export const PDFJS_VERSION = '3.11.174'
export const PDFJS_TAG = `v${PDFJS_VERSION}`
export const PDFJS_REPO = 'https://github.com/mozilla/pdf.js.git'

export const SOURCE_PATCHES = [
  {
    id: 'alt-text-manager-null-guard',
    group: 'crash-fix',
    file: 'src/display/editor/tools.js',
    why: 'AnnotationEditorUIManager.destroy() dereferences #altTextManager unconditionally. Onward reuses one PDFViewer across documents, so setDocument(null) hits this with the manager already gone and the throw aborts opening the next PDF.',
    find: '    this.#selectedEditors.clear();\n    this.#commandManager.destroy();\n    this.#altTextManager.destroy();\n  }',
    replace: '    this.#selectedEditors.clear();\n    this.#commandManager.destroy();\n    this.#altTextManager?.destroy();\n  }'
  },
  {
    id: 'invisible-text-dom-marker',
    group: 'hidden-text',
    file: 'src/display/text_layer.js',
    why: "Carry the worker's isInvisibleText flag onto the text-layer span so the viewer can tell covered hidden/OCR text apart from OCR-only scanned text at DOM level.",
    find: '  textDiv.textContent = geom.str;\n  // geom.dir may be \'ttb\' for vertical texts.\n  textDiv.dir = geom.dir;',
    replace: '  textDiv.textContent = geom.str;\n  // geom.dir may be \'ttb\' for vertical texts.\n  textDiv.dir = geom.dir;\n  if (geom.isInvisibleText) {\n    textDiv.dataset.pdfInvisibleText = "1";\n  }'
  },
  {
    id: 'invisible-text-item-field',
    group: 'hidden-text',
    file: 'src/core/evaluator.js',
    why: 'Add the isInvisibleText field to the text-content accumulator.',
    find: '      transform: null,\n      fontName: null,\n      hasEOL: false,\n    };\n\n    // Use a circular buffer',
    replace: '      transform: null,\n      fontName: null,\n      hasEOL: false,\n      isInvisibleText: false,\n    };\n\n    // Use a circular buffer'
  },
  {
    id: 'invisible-text-item-set',
    group: 'hidden-text',
    file: 'src/core/evaluator.js',
    why: 'Record text visibility at the moment a new text chunk starts.',
    find: '      textContentItem.fontName = loadedName;\n\n      const trm = (textContentItem.transform = getCurrentTextTransform());',
    replace: '      textContentItem.fontName = loadedName;\n      textContentItem.isInvisibleText = !isCurrentTextRenderingVisible();\n\n      const trm = (textContentItem.transform = getCurrentTextTransform());'
  },
  {
    id: 'arabic-bidi-preserve-str',
    group: 'arabic',
    file: 'src/core/evaluator.js',
    why: 'Use the original logical-order string for Arabic instead of the bidi-reordered one.',
    find: '      const bidiResult = bidi(text, -1, textChunk.vertical);\n      return {\n        str: bidiResult.str,\n        dir: bidiResult.dir,\n        width: Math.abs(textChunk.totalWidth),',
    replace: '      const bidiResult = bidi(text, -1, textChunk.vertical);\n      const str = shouldKeepOriginalArabicBidiText(text, bidiResult.str)\n        ? text\n        : bidiResult.str;\n      return {\n        str,\n        dir: bidiResult.dir,\n        width: Math.abs(textChunk.totalWidth),'
  },
  {
    id: 'arabic-bidi-helpers',
    group: 'arabic',
    file: 'src/core/evaluator.js',
    why: 'Emit isInvisibleText on the item and add the Arabic/Hebrew script probes used by the decision above.',
    find: '        transform: textChunk.transform,\n        fontName: textChunk.fontName,\n        hasEOL: textChunk.hasEOL,\n      };\n    }\n\n    function handleSetFont(fontName, fontRef) {',
    replace: '        transform: textChunk.transform,\n        fontName: textChunk.fontName,\n        hasEOL: textChunk.hasEOL,\n        isInvisibleText: textChunk.isInvisibleText || undefined,\n      };\n    }\n\n    function shouldKeepOriginalArabicBidiText(text, bidiText) {\n      if (text === bidiText || !hasArabicScript(text) || hasHebrewScript(text)) {\n        return false;\n      }\n      return true;\n    }\n\n    function hasArabicScript(text) {\n      return /[\\u0600-\\u06ff\\u0750-\\u077f\\u08a0-\\u08ff\\ufb50-\\ufdff\\ufe70-\\ufeff]/.test(\n        text\n      );\n    }\n\n    function hasHebrewScript(text) {\n      return /[\\u0590-\\u05ff]/.test(text);\n    }\n\n    function handleSetFont(fontName, fontRef) {'
  },
  {
    id: 'text-rendering-visibility-probe',
    group: 'hidden-text',
    file: 'src/core/evaluator.js',
    why: 'Decide visibility from the text rendering mode combined with fill/stroke alpha.',
    find: '    function applyInverseRotation(x, y, matrix) {\n      const scale = Math.hypot(matrix[0], matrix[1]);',
    replace: '    function isCurrentTextRenderingVisible() {\n      const fillStrokeMode =\n        textState.textRenderingMode & TextRenderingMode.FILL_STROKE_MASK;\n      switch (fillStrokeMode) {\n        case TextRenderingMode.FILL:\n          return textState.fillAlpha > 0;\n        case TextRenderingMode.STROKE:\n          return textState.strokeAlpha > 0;\n        case TextRenderingMode.FILL_STROKE:\n          return textState.fillAlpha > 0 || textState.strokeAlpha > 0;\n        case TextRenderingMode.INVISIBLE:\n          return false;\n      }\n      return true;\n    }\n\n    function applyInverseRotation(x, y, matrix) {\n      const scale = Math.hypot(matrix[0], matrix[1]);'
  },
  {
    id: 'flush-on-invisible-transition',
    group: 'hidden-text',
    file: 'src/core/evaluator.js',
    why: 'Flush the accumulated chunk when text crosses a visibility boundary, so one chunk never mixes visible and invisible glyphs.',
    find: '        return;\n      }\n\n      const glyphs = font.charsToGlyphs(chars);\n      const scale = textState.fontMatrix[0] * textState.fontSize;',
    replace: '        return;\n      }\n\n      const isTextRenderingVisible = isCurrentTextRenderingVisible();\n      if (!isTextRenderingVisible) {\n        resetLastChars();\n        flushTextContentItem();\n      }\n\n      const glyphs = font.charsToGlyphs(chars);\n      const scale = textState.fontMatrix[0] * textState.fontSize;'
  },
  {
    id: 'track-set-text-rendering-mode',
    group: 'hidden-text',
    file: 'src/core/evaluator.js',
    why: 'Track the Tr operator; Tr=3/7 draws nothing but still produces text content.',
    find: '            textState.textLineMatrix = IDENTITY_MATRIX.slice();\n            break;\n          case OPS.showSpacedText:',
    replace: '            textState.textLineMatrix = IDENTITY_MATRIX.slice();\n            break;\n          case OPS.setTextRenderingMode:\n            if (textState.textRenderingMode !== args[0]) {\n              flushTextContentItem();\n              resetLastChars();\n              textState.textRenderingMode = args[0];\n            }\n            break;\n          case OPS.showSpacedText:'
  },
  {
    id: 'track-extgstate-alpha',
    group: 'hidden-text',
    file: 'src/core/evaluator.js',
    why: 'Track ExtGState /ca and /CA so alpha-0 text is classified as invisible, and stop caching such a gState as empty.',
    find: '                const gStateFont = gState.get("Font");\n                if (!gStateFont) {\n                  emptyGStateCache.set(name, gState.objId, true);\n\n                  resolveGState();\n                  return;',
    replace: '                let fillAlpha = null;\n                let strokeAlpha = null;\n                for (const key of gState.getKeys()) {\n                  const value = gState.get(key);\n                  if (\n                    key === "ca" &&\n                    typeof value === "number" &&\n                    value >= 0 &&\n                    value <= 1\n                  ) {\n                    fillAlpha = value;\n                  } else if (\n                    key === "CA" &&\n                    typeof value === "number" &&\n                    value >= 0 &&\n                    value <= 1\n                  ) {\n                    strokeAlpha = value;\n                  }\n                }\n                if (\n                  (fillAlpha !== null && textState.fillAlpha !== fillAlpha) ||\n                  (strokeAlpha !== null && textState.strokeAlpha !== strokeAlpha)\n                ) {\n                  flushTextContentItem();\n                  resetLastChars();\n                  if (fillAlpha !== null) {\n                    textState.fillAlpha = fillAlpha;\n                  }\n                  if (strokeAlpha !== null) {\n                    textState.strokeAlpha = strokeAlpha;\n                  }\n                }\n                const hasTextVisibilityState =\n                  fillAlpha !== null || strokeAlpha !== null;\n                const gStateFont = gState.get("Font");\n                if (!gStateFont) {\n                  if (!hasTextVisibilityState) {\n                    emptyGStateCache.set(name, gState.objId, true);\n                  }\n\n                  resolveGState();\n                  return;'
  },
  {
    id: 'text-state-visibility-fields',
    group: 'hidden-text',
    file: 'src/core/evaluator.js',
    why: 'Initialise textRenderingMode / fillAlpha / strokeAlpha on TextState.',
    find: '    this.textHScale = 1;\n    this.textRise = 0;\n  }\n\n  setTextMatrix(a, b, c, d, e, f) {',
    replace: '    this.textHScale = 1;\n    this.textRise = 0;\n    this.textRenderingMode = TextRenderingMode.FILL;\n    this.fillAlpha = 1;\n    this.strokeAlpha = 1;\n  }\n\n  setTextMatrix(a, b, c, d, e, f) {'
  }
]
