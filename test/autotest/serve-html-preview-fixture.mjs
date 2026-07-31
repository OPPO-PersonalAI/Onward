/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

import http from 'node:http'
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const [fixtureDirArg, readyJsonArg] = process.argv.slice(2)

if (!fixtureDirArg || !readyJsonArg) {
  console.error('Usage: node serve-html-preview-fixture.mjs <fixture-dir> <ready-json>')
  process.exit(2)
}

const fixtureDir = path.resolve(fixtureDirArg)
const readyJsonPath = path.resolve(readyJsonArg)

const contentTypes = new Map([
  ['.css', 'text/css; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8']
])

// Mock "external site" pages. Served with `frame-ancestors 'none'` so they
// reproduce the exact condition that blanks a sandboxed iframe (GitHub-style
// framing refusal) while remaining loadable in the Open Browser webview,
// which is a top-level frame. No public-network dependency in assertions.
const EXTERNAL_PAGES = new Map([
  ['/external-site', {
    title: 'Mock External Site',
    body: `
      <h1>EXTERNAL_SITE_MARKER</h1>
      <p><a id="ext-next" href="/external-second">go to second external page</a></p>
    `
  }],
  ['/external-second', {
    title: 'Mock External Second',
    body: '<h1>EXTERNAL_SECOND_MARKER</h1>'
  }]
])

const server = http.createServer(async (req, res) => {
  try {
    const requestUrl = new URL(req.url ?? '/', 'http://127.0.0.1')
    const externalPage = EXTERNAL_PAGES.get(requestUrl.pathname)
    if (externalPage) {
      res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'content-security-policy': "frame-ancestors 'none'",
        'x-frame-options': 'DENY',
        'cache-control': 'no-store'
      })
      res.end(`<!doctype html><html><head><title>${externalPage.title}</title></head><body>${externalPage.body}</body></html>`)
      return
    }
    const name = path.basename(requestUrl.pathname)
    if (!['external.js', 'external.css'].includes(name)) {
      res.writeHead(404)
      res.end('not found')
      return
    }
    const fullPath = path.join(fixtureDir, name)
    const bytes = await readFile(fullPath)
    res.writeHead(200, {
      'content-type': contentTypes.get(path.extname(name)) ?? 'application/octet-stream',
      'cache-control': 'no-store'
    })
    res.end(bytes)
  } catch (error) {
    res.writeHead(500)
    res.end(String(error))
  }
})

server.listen(0, '127.0.0.1', async () => {
  const address = server.address()
  if (!address || typeof address === 'string') {
    console.error('Failed to resolve fixture server address')
    process.exit(1)
  }
  const baseUrl = `http://127.0.0.1:${address.port}`
  // Runtime-only substitutions: absolute file:// URLs cannot live in a
  // committed fixture, so templates carry placeholders resolved here.
  const substitutions = new Map([
    ['__HTML_PREVIEW_SERVER_URL__', baseUrl],
    ['__FIXTURE_FILE_URL_MD__', pathToFileURL(path.join(fixtureDir, 'linked-notes.md')).href],
    // Two levels up: the editor root is the PARENT of fixtureDir, so escaping
    // the project requires leaving that parent too.
    ['__FIXTURE_OUTSIDE_FILE_URL__', pathToFileURL(path.join(fixtureDir, '..', '..', 'outside-preview-root.md')).href]
  ])
  const templates = [
    ['regularization_landscape.template.html', 'regularization_landscape.html'],
    ['link-matrix.template.html', 'link-matrix.html']
  ]
  for (const [templateName, outputName] of templates) {
    const templatePath = path.join(fixtureDir, templateName)
    let template
    try {
      template = await readFile(templatePath, 'utf-8')
    } catch {
      continue
    }
    let materialized = template
    for (const [placeholder, value] of substitutions) {
      materialized = materialized.replaceAll(placeholder, value)
    }
    await writeFile(path.join(fixtureDir, outputName), materialized, 'utf-8')
  }
  await writeFile(readyJsonPath, JSON.stringify({
    baseUrl,
    htmlPath: path.join(fixtureDir, 'regularization_landscape.html')
  }), 'utf-8')
})

const shutdown = () => {
  server.close(() => {
    process.exit(0)
  })
}

process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)
