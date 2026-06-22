/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

import { OutlineItem, OutlineSymbolKind } from './types'
// Markdown heading parsing lives in a pure, monaco-free module so it can be
// unit-tested in plain Node (CRLF-safety regression coverage).
import { parseMarkdownOutline } from './outlineMarkdownHeadings'

// Monaco internal imports for document symbol access (Monaco 0.32+)
// These are undocumented but stable across 0.32–0.52+.
// @ts-expect-error — internal Monaco module
import { StandaloneServices } from 'monaco-editor/esm/vs/editor/standalone/browser/standaloneServices.js'
// @ts-expect-error — internal Monaco module
import { ILanguageFeaturesService } from 'monaco-editor/esm/vs/editor/common/services/languageFeatures.js'
// @ts-expect-error — internal Monaco module
import { OutlineModel } from 'monaco-editor/esm/vs/editor/contrib/documentSymbols/browser/outlineModel.js'

// ---------------------------------------------------------------------------
// Strategy 2: Monaco OutlineModel (language-agnostic, provider-based)
// ---------------------------------------------------------------------------

function monacoSymbolKindToOutline(kind: number): OutlineSymbolKind {
  // monaco.languages.SymbolKind mapping
  const map: Record<number, OutlineSymbolKind> = {
    0: OutlineSymbolKind.File,
    1: OutlineSymbolKind.Module,
    2: OutlineSymbolKind.Namespace,
    3: OutlineSymbolKind.Package,
    4: OutlineSymbolKind.Class,
    5: OutlineSymbolKind.Method,
    6: OutlineSymbolKind.Property,
    7: OutlineSymbolKind.Field,
    8: OutlineSymbolKind.Constructor,
    9: OutlineSymbolKind.Enum,
    10: OutlineSymbolKind.Interface,
    11: OutlineSymbolKind.Function,
    12: OutlineSymbolKind.Variable,
    13: OutlineSymbolKind.Constant,
    14: OutlineSymbolKind.String,
    15: OutlineSymbolKind.Number,
    16: OutlineSymbolKind.Boolean,
    17: OutlineSymbolKind.Array,
    18: OutlineSymbolKind.Object,
    19: OutlineSymbolKind.Key,
    20: OutlineSymbolKind.Null,
    21: OutlineSymbolKind.EnumMember,
    22: OutlineSymbolKind.Struct,
    23: OutlineSymbolKind.Event,
    24: OutlineSymbolKind.Operator,
    25: OutlineSymbolKind.TypeParameter,
  }
  return map[kind] ?? OutlineSymbolKind.Variable
}

function convertMonacoSymbols(
  symbols: import('monaco-editor').languages.DocumentSymbol[],
  depth: number
): OutlineItem[] {
  return symbols.map((sym) => ({
    name: sym.name,
    detail: sym.detail || undefined,
    kind: monacoSymbolKindToOutline(sym.kind),
    startLine: sym.range.startLineNumber,
    startColumn: sym.range.startColumn,
    endLine: sym.range.endLineNumber,
    endColumn: sym.range.endColumn,
    children: sym.children ? convertMonacoSymbols(sym.children, depth + 1) : [],
    depth,
  }))
}

/**
 * Use Monaco's OutlineModel service to get document symbols.
 * This works for ANY language that has a registered DocumentSymbolProvider
 * (TypeScript, JavaScript, JSON, CSS, HTML, etc.) — no hardcoded whitelist needed.
 */
async function parseViaMonaco(
  model: import('monaco-editor').editor.ITextModel
): Promise<OutlineItem[] | null> {
  try {
    const { documentSymbolProvider } = StandaloneServices.get(ILanguageFeaturesService)
    if (!documentSymbolProvider) return null

    // Check if any provider is registered for this model's language
    if (!documentSymbolProvider.has(model)) return null

    const outline = await OutlineModel.create(
      documentSymbolProvider,
      model,
      { isCancellationRequested: false, onCancellationRequested: () => ({ dispose() {} }) }
    )

    const symbols = outline.getTopLevelSymbols()
    if (!symbols || symbols.length === 0) return null
    return convertMonacoSymbols(symbols, 0)
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// Strategy 3: Regex fallback for languages without Monaco providers
// ---------------------------------------------------------------------------

interface RegexPattern {
  pattern: RegExp
  kind: OutlineSymbolKind
  nameGroup: number
  detailGroup?: number
}

const LANGUAGE_PATTERNS: Record<string, RegexPattern[]> = {
  python: [
    { pattern: /^(\s*)class\s+(\w+)/, kind: OutlineSymbolKind.Class, nameGroup: 2 },
    { pattern: /^(\s*)async\s+def\s+(\w+)/, kind: OutlineSymbolKind.Function, nameGroup: 2 },
    { pattern: /^(\s*)def\s+(\w+)/, kind: OutlineSymbolKind.Function, nameGroup: 2 },
  ],
  go: [
    { pattern: /^func\s+\((\w+)\s+\*?\w+\)\s+(\w+)/, kind: OutlineSymbolKind.Method, nameGroup: 2 },
    { pattern: /^func\s+(\w+)/, kind: OutlineSymbolKind.Function, nameGroup: 1 },
    { pattern: /^type\s+(\w+)\s+struct\b/, kind: OutlineSymbolKind.Struct, nameGroup: 1 },
    { pattern: /^type\s+(\w+)\s+interface\b/, kind: OutlineSymbolKind.Interface, nameGroup: 1 },
  ],
  rust: [
    { pattern: /^\s*pub\s+fn\s+(\w+)|^\s*fn\s+(\w+)/, kind: OutlineSymbolKind.Function, nameGroup: 1 },
    { pattern: /^\s*pub\s+struct\s+(\w+)|^\s*struct\s+(\w+)/, kind: OutlineSymbolKind.Struct, nameGroup: 1 },
    { pattern: /^\s*pub\s+enum\s+(\w+)|^\s*enum\s+(\w+)/, kind: OutlineSymbolKind.Enum, nameGroup: 1 },
    { pattern: /^\s*pub\s+trait\s+(\w+)|^\s*trait\s+(\w+)/, kind: OutlineSymbolKind.Interface, nameGroup: 1 },
    { pattern: /^\s*impl(?:<[^>]*>)?\s+(\w+)/, kind: OutlineSymbolKind.Class, nameGroup: 1 },
  ],
  c: [
    { pattern: /^\s*(?:class|struct)\s+(\w+)/, kind: OutlineSymbolKind.Class, nameGroup: 1 },
    { pattern: /^(?:[\w*]+\s+)+(\w+)\s*\([^)]*\)\s*\{?\s*$/, kind: OutlineSymbolKind.Function, nameGroup: 1 },
  ],
  cpp: [
    { pattern: /^\s*(?:class|struct)\s+(\w+)/, kind: OutlineSymbolKind.Class, nameGroup: 1 },
    { pattern: /^\s*namespace\s+(\w+)/, kind: OutlineSymbolKind.Namespace, nameGroup: 1 },
    { pattern: /^(?:[\w*:&]+\s+)+(\w+)\s*\([^)]*\)\s*(?:const\s*)?\{?\s*$/, kind: OutlineSymbolKind.Function, nameGroup: 1 },
  ],
  java: [
    { pattern: /^\s*(?:public|private|protected)?\s*(?:static\s+)?class\s+(\w+)/, kind: OutlineSymbolKind.Class, nameGroup: 1 },
    { pattern: /^\s*(?:public|private|protected)?\s*interface\s+(\w+)/, kind: OutlineSymbolKind.Interface, nameGroup: 1 },
    { pattern: /^\s*(?:public|private|protected)?\s*enum\s+(\w+)/, kind: OutlineSymbolKind.Enum, nameGroup: 1 },
    { pattern: /^\s*(?:public|private|protected)\s+(?:static\s+)?(?:[\w<>\[\]]+)\s+(\w+)\s*\(/, kind: OutlineSymbolKind.Method, nameGroup: 1 },
  ],
  shell: [
    { pattern: /^\s*function\s+(\w+)/, kind: OutlineSymbolKind.Function, nameGroup: 1 },
    { pattern: /^(\w+)\s*\(\)\s*\{/, kind: OutlineSymbolKind.Function, nameGroup: 1 },
  ],
  ruby: [
    { pattern: /^\s*class\s+(\w+)/, kind: OutlineSymbolKind.Class, nameGroup: 1 },
    { pattern: /^\s*module\s+(\w+)/, kind: OutlineSymbolKind.Module, nameGroup: 1 },
    { pattern: /^\s*def\s+(\w+[!?=]?)/, kind: OutlineSymbolKind.Method, nameGroup: 1 },
  ],
  yaml: [
    { pattern: /^(\w[\w.-]*):\s*$/, kind: OutlineSymbolKind.Key, nameGroup: 1 },
    { pattern: /^(\w[\w.-]*):\s+\S/, kind: OutlineSymbolKind.Key, nameGroup: 1 },
  ],
  toml: [
    { pattern: /^\[([^\]]+)\]/, kind: OutlineSymbolKind.Key, nameGroup: 1 },
  ],
}

// Map file extensions to regex language keys
const EXTENSION_TO_REGEX_LANG: Record<string, string> = {
  py: 'python',
  pyw: 'python',
  go: 'go',
  rs: 'rust',
  c: 'c',
  h: 'c',
  cpp: 'cpp',
  cc: 'cpp',
  cxx: 'cpp',
  hpp: 'cpp',
  hxx: 'cpp',
  java: 'java',
  sh: 'shell',
  bash: 'shell',
  zsh: 'shell',
  rb: 'ruby',
  yml: 'yaml',
  yaml: 'yaml',
  toml: 'toml',
}

function getExtension(path: string): string {
  const parts = path.split('.')
  return parts.length >= 2 ? parts[parts.length - 1].toLowerCase() : ''
}

function parseViaRegex(lines: string[], path: string): OutlineItem[] | null {
  const ext = getExtension(path)
  const lang = EXTENSION_TO_REGEX_LANG[ext]
  if (!lang) return null

  const patterns = LANGUAGE_PATTERNS[lang]
  if (!patterns) return null

  const items: OutlineItem[] = []
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    for (const { pattern, kind, nameGroup } of patterns) {
      const match = pattern.exec(line)
      if (match) {
        // For rust-style patterns with alternation, check both groups
        const name = match[nameGroup] || match[nameGroup + 1]
        if (!name) continue
        items.push({
          name,
          kind,
          startLine: i + 1,
          startColumn: 1,
          endLine: i + 1,
          endColumn: line.length + 1,
          children: [],
          depth: 0,
        })
        break
      }
    }
  }

  // Attempt to build parent-child for Python (indentation-based)
  if (lang === 'python') {
    return buildPythonHierarchy(items, lines)
  }

  return items.length > 0 ? items : null
}

function buildPythonHierarchy(items: OutlineItem[], lines: string[]): OutlineItem[] {
  if (items.length === 0) return []

  // Calculate indentation for each item
  const indents = items.map((item) => {
    const line = lines[item.startLine - 1]
    const leadingSpaces = line.match(/^(\s*)/)?.[1].length ?? 0
    return leadingSpaces
  })

  const root: OutlineItem[] = []
  const stack: { indent: number; item: OutlineItem }[] = []

  for (let i = 0; i < items.length; i++) {
    const indent = indents[i]
    const item = items[i]

    while (stack.length > 0 && stack[stack.length - 1].indent >= indent) {
      stack.pop()
    }

    item.depth = stack.length

    if (stack.length > 0) {
      stack[stack.length - 1].item.children.push(item)
    } else {
      root.push(item)
    }
    stack.push({ indent, item })
  }

  return root
}

// ---------------------------------------------------------------------------
// Main dispatcher
// ---------------------------------------------------------------------------

const MARKDOWN_EXTENSIONS = new Set(['md', 'markdown', 'mdx'])
const MAX_LINES = 100_000

export async function parseOutlineSymbols(
  content: string,
  filePath: string,
  model: import('monaco-editor').editor.ITextModel | null,
): Promise<OutlineItem[]> {
  // Split on all line-ending styles (\r\n, \r, \n) so a CRLF-checked-out file
  // (the Windows default with core.autocrlf=true) does not leave a trailing '\r'
  // on every line, which would break the line-anchored regex fallbacks below.
  // The markdown strategy does its own CRLF-safe split inside parseMarkdownOutline.
  const lines = content.split(/\r\n|\r|\n/)
  if (lines.length > MAX_LINES) return []

  const ext = getExtension(filePath)

  // Strategy 1: Markdown
  if (MARKDOWN_EXTENSIONS.has(ext)) {
    return parseMarkdownOutline(content)
  }

  // Strategy 2: Monaco OutlineModel — works for any language with a registered provider
  // (TS, JS, JSON, CSS, HTML, etc.) No hardcoded language whitelist needed.
  if (model) {
    const monacoResult = await parseViaMonaco(model)
    if (monacoResult && monacoResult.length > 0) return monacoResult
  }

  // Strategy 3: Regex fallback for languages without Monaco providers
  const regexResult = parseViaRegex(lines, filePath)
  if (regexResult) return regexResult

  return []
}

export function countSymbols(items: OutlineItem[]): number {
  let count = items.length
  for (const item of items) {
    count += countSymbols(item.children)
  }
  return count
}
