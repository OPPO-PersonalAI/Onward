/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

const { existsSync, mkdirSync, readFileSync, writeFileSync } = require('fs')
const { dirname, extname, join, relative } = require('path')
const { marked } = require('marked')

function ensureDir(path) {
  mkdirSync(path, { recursive: true })
}

function writeFile(path, content) {
  ensureDir(dirname(path))
  // Idempotent write: skip when the on-disk content is already byte-identical, so an
  // unchanged rebuild does not bump the file mtime and spuriously mark it modified in
  // git. The compiler runs on every build, so most rebuilds regenerate byte-identical
  // HTML; without this guard every build re-touches every changelog file (cross-platform,
  // but most visible on Windows where the stat-dirty entries tend to linger in git status).
  if (existsSync(path)) {
    try {
      if (readFileSync(path, 'utf-8') === content) return
    } catch {
      // fall through to write on any read error
    }
  }
  writeFileSync(path, content, 'utf-8')
}

function readJsonFile(path) {
  const parsed = JSON.parse(readFileSync(path, 'utf-8'))
  return parsed && typeof parsed === 'object' ? parsed : {}
}

function toHtmlRelativePath(markdownRelativePath) {
  const normalized = String(markdownRelativePath || '').replace(/\\/g, '/').replace(/^\//, '')
  const extension = extname(normalized)
  const withoutExtension = extension ? normalized.slice(0, -extension.length) : normalized
  return join('html', `${withoutExtension}.html`).replace(/\\/g, '/')
}

function renderMarkdownToHtml(markdown) {
  return marked.parse(markdown, {
    async: false,
    gfm: true
  })
}

function compileChangelogAssets(changelogRoot) {
  const indexPath = join(changelogRoot, 'index.json')
  if (!existsSync(indexPath)) {
    throw new Error(`Missing changelog index: ${indexPath}`)
  }

  const index = readJsonFile(indexPath)
  const entries = Array.isArray(index.entries) ? index.entries : []
  let compiledCount = 0

  for (const entry of entries) {
    if (!entry || typeof entry !== 'object') continue
    const markdown = entry.markdown && typeof entry.markdown === 'object' ? entry.markdown : null
    if (!markdown || typeof markdown.en !== 'string') continue

    const nextHtml = {}
    for (const [locale, markdownRelativePath] of Object.entries(markdown)) {
      if (typeof markdownRelativePath !== 'string' || !markdownRelativePath.trim()) continue
      const markdownPath = join(changelogRoot, markdownRelativePath)
      if (!existsSync(markdownPath)) {
        throw new Error(`Missing changelog markdown: ${markdownPath}`)
      }
      const htmlRelativePath = toHtmlRelativePath(markdownRelativePath)
      const htmlPath = join(changelogRoot, htmlRelativePath)
      const markdownContent = readFileSync(markdownPath, 'utf-8')
      const htmlContent = renderMarkdownToHtml(markdownContent)
      writeFile(htmlPath, `${htmlContent.trim()}\n`)
      nextHtml[locale] = relative(changelogRoot, htmlPath).replace(/\\/g, '/')
      compiledCount += 1
    }

    if (Object.keys(nextHtml).length > 0) {
      entry.html = nextHtml
    }
  }

  writeFile(indexPath, `${JSON.stringify({ entries }, null, 2)}\n`)
  return { compiledCount, entries: entries.length, indexPath }
}

module.exports = {
  compileChangelogAssets,
  toHtmlRelativePath
}
