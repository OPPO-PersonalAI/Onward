/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Routing decision for a link clicked inside the Markdown preview.
 *
 * The markdown worker (markdownPreviewWorker.ts) rewrites hrefs before this
 * classifier ever sees them: local project links become absolute file:// URLs,
 * in-page anchors stay '#...', external URLs stay untouched, and a relative
 * href that escaped the project root survives as-is (the worker refuses to
 * resolve it). The classifier maps that post-rewrite href to what the host
 * should do — it never touches the DOM or the filesystem, so the decision
 * table is unit-testable.
 */
export type MarkdownPreviewLinkRoute =
  | { kind: 'anchor'; anchorId: string }
  | { kind: 'external'; url: string }
  | { kind: 'external-protocol'; url: string }
  | { kind: 'project-file'; relativePath: string }
  | { kind: 'outside-root' }
  | { kind: 'unresolvable'; reason: string }

// Collapse duplicate separators ('/a/T//proj' — a TMPDIR ending in '/'
// produces such roots) while preserving a leading '//' (Windows UNC server
// prefix). The markdown worker collapses its side when building file:// URLs;
// without matching collapsing here the containment prefix test misfires.
function collapseSlashes(value: string): string {
  const collapsed = value.replace(/\/{2,}/g, '/')
  return /^\/\/(?!\/)/.test(value) ? `/${collapsed}` : collapsed
}

function normalizeComparablePath(value: string, isWindows: boolean): string {
  let normalized = collapseSlashes(value.replace(/\\/g, '/')).replace(/\/+$/, '')
  if (isWindows) normalized = normalized.toLowerCase()
  return normalized
}

function decodeFileUrlPath(pathname: string, isWindows: boolean): string | null {
  let decoded: string
  try {
    decoded = decodeURIComponent(pathname)
  } catch {
    return null
  }
  if (isWindows && /^\/[A-Za-z]:\//.test(decoded)) {
    return decoded.slice(1)
  }
  return decoded
}

export function classifyMarkdownPreviewHref(params: {
  href: string
  rootPath: string
  platform: 'darwin' | 'win32' | 'linux' | string
}): MarkdownPreviewLinkRoute {
  const href = params.href.trim()
  if (!href) return { kind: 'unresolvable', reason: 'empty' }
  const isWindows = params.platform === 'win32'

  if (href.startsWith('#')) {
    let anchorId: string
    try {
      anchorId = decodeURIComponent(href.slice(1))
    } catch {
      anchorId = href.slice(1)
    }
    return { kind: 'anchor', anchorId }
  }

  const lower = href.toLowerCase()
  if (lower.startsWith('http://') || lower.startsWith('https://') || lower.startsWith('//')) {
    return { kind: 'external', url: href.startsWith('//') ? `https:${href}` : href }
  }

  if (lower.startsWith('file:')) {
    let url: URL
    try {
      url = new URL(href)
    } catch {
      return { kind: 'unresolvable', reason: 'invalid-file-url' }
    }
    const filePath = decodeFileUrlPath(url.pathname, isWindows)
    if (!filePath) return { kind: 'unresolvable', reason: 'invalid-path-encoding' }
    const comparableRoot = normalizeComparablePath(params.rootPath, isWindows)
    const comparableFile = normalizeComparablePath(filePath, isWindows)
    if (!comparableRoot || comparableFile === comparableRoot) {
      return { kind: 'unresolvable', reason: 'not-a-file' }
    }
    if (!comparableFile.startsWith(`${comparableRoot}/`)) {
      return { kind: 'outside-root' }
    }
    // Slice from the collapsed case-preserving path so the editor opens the
    // file under its real name even on case-insensitive filesystems; the
    // collapsed form keeps offsets aligned with comparableRoot.
    const relativePath = collapseSlashes(filePath.replace(/\\/g, '/')).replace(/\/+$/, '').slice(comparableRoot.length + 1)
    if (!relativePath) return { kind: 'unresolvable', reason: 'not-a-file' }
    return { kind: 'project-file', relativePath }
  }

  // mailto:/tel: route to the OS default handler (with the external-link
  // confirm); other non-http(s) protocols (data:, javascript:, vscode:, ...)
  // are refused explicitly rather than letting the click fall through to a
  // renderer-window navigation attempt.
  if (/^(?:mailto|tel):/.test(lower)) {
    return { kind: 'external-protocol', url: href }
  }
  if (/^[a-z][a-z0-9+.-]*:/.test(lower)) {
    return { kind: 'unresolvable', reason: 'unsupported-protocol' }
  }

  // A surviving relative href means the worker's root-bounded resolver
  // refused it (it escaped the project root via ../).
  return { kind: 'outside-root' }
}
