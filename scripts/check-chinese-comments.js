#!/usr/bin/env node
/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

const { execFileSync } = require('child_process')
const { existsSync, readFileSync } = require('fs')
const { resolve } = require('path')

const ROOT = resolve(__dirname, '..')
const HAN_RE = /\p{Script=Han}/u
const BINARY_RE = /\0/
const ALLOWLIST = new Set([
  'src/i18n/core.ts',
  // Test files may contain Chinese strings as test data (not comments)
  'test/autotest/test-full-e2e.ts',
  'test/autotest/test-prompt-integrity.ts',
  // CDP prompt-editor drivers type real Chinese IME input / assert on Chinese
  // round-trips, so the Han characters are required test data, not comments.
  'test/autotest/prompt-ime-latency-driver.mjs',
  'test/autotest/prompt-contenteditable-editing-driver.mjs',
  // Project instruction files may quote Chinese phrases from user usage.
  'CLAUDE.md',
  'AGENTS.md'
])
const TEXT_EXTENSIONS = new Set([
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.css',
  '.html',
  '.md',
  '.svg',
  '.sh',
  '.ps1',
  '.json',
  '.yml',
  '.yaml',
  '.d.ts'
])
const EXTRA_TEXT_FILES = new Set([
  'CLAUDE.md',
  'AGENTS.md',
  '.gitignore',
  '.npmrc',
  'pnpm-lock.yaml'
])

function isAllowlistedPath(relPath) {
  if (ALLOWLIST.has(relPath)) return true
  // Local skill definitions are project documentation, not product copy.
  if (relPath.startsWith('.claude/skills/')) return true
  // Vendored pdf.js ships Unicode normalization ranges that include Han
  // script blocks; it is third-party code we don't modify.
  if (relPath.startsWith('resources/pdfjs/')) return true
  // Regression reports are engineering logs that may quote Chinese from
  // CLAUDE.md / AGENTS.md or user-facing failure snapshots.
  if (relPath.startsWith('test/report/')) return true
  // Engineering / architecture docs may be authored bilingually; the
  // single-language constraint that applies to product UI copy is
  // intentionally relaxed here so design write-ups can use the natural
  // language for the audience. This also covers docs/html/ — the canonical
  // output dir for user-requested HTML interpretation docs (see CLAUDE.md).
  if (relPath.startsWith('docs/')) return true
  // The metrics report renderer embeds the reader-facing Chinese report
  // template (the generated HTML is the same document category as
  // docs/html/, it just lives in gitignored traces/metrics/). Code comments
  // in this file remain English per the repo rule; only the template
  // literals carry Chinese copy.
  if (relPath === 'scripts/metrics/build-metrics-report.mjs') return true
  return false
}

function getTrackedFiles() {
  return execFileSync('git', ['ls-files'], {
    cwd: ROOT,
    encoding: 'utf-8'
  })
    .split('\n')
    .map((value) => value.trim())
    .filter(Boolean)
}

function isTextFile(relPath) {
  if (EXTRA_TEXT_FILES.has(relPath)) return true
  const lastDot = relPath.lastIndexOf('.')
  if (lastDot === -1) return false
  return TEXT_EXTENSIONS.has(relPath.slice(lastDot))
}

function isBinaryText(content) {
  return BINARY_RE.test(content.slice(0, 4096))
}

function scanText(relPath) {
  if (isAllowlistedPath(relPath)) {
    return []
  }

  const absolutePath = resolve(ROOT, relPath)
  if (!existsSync(absolutePath)) {
    return []
  }

  const content = readFileSync(absolutePath, 'utf-8')
  if (isBinaryText(content)) {
    return []
  }

  const hits = []
  const lines = content.split('\n')
  lines.forEach((lineText, index) => {
    if (!HAN_RE.test(lineText)) return
    hits.push({
      file: relPath,
      line: index + 1,
      snippet: lineText.trim()
    })
  })
  return hits
}

function main() {
  const files = getTrackedFiles().filter(isTextFile)
  const hits = files.flatMap(scanText)

  if (hits.length === 0) {
    console.log('[project-text-lint] Passed: no Simplified Chinese text found outside the locale dictionary allowlist.')
    return
  }

  console.error('[project-text-lint] Failed: Simplified Chinese text is only allowed in src/i18n/core.ts.')
  for (const hit of hits) {
    console.error(`${hit.file}:${hit.line}: ${hit.snippet}`)
  }
  process.exit(1)
}

main()
