#!/usr/bin/env node
/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 *
 * Post-processes the license-checker output (ThirdPartyNotices.txt) into a
 * platform-INDEPENDENT form so the file is byte-identical no matter which OS
 * ran the build.
 *
 * Two passes:
 *   1. Whitespace: normalise CRLF/CR -> LF and strip trailing whitespace.
 *   2. Platform-variant collapse: license-checker walks the *installed*
 *      node_modules, which on any single build host only contains that host's
 *      arch slice of a platform-fanned-out native package (e.g. only
 *      `@parcel/watcher-win32-x64` on Windows, only `@parcel/watcher-darwin-arm64`
 *      on macOS, only `@vscode/ripgrep-linux-x64` on Linux). That makes the
 *      generated notices diverge per platform and ping-pong in git. We drop such
 *      a per-platform sub-package block when its platform-neutral base package is
 *      already listed with the SAME version AND the SAME license id -- the base
 *      entry then acknowledges the whole family. The same-license guard is
 *      deliberate: a sub-package can carry a different license than its parent
 *      (e.g. a parent under Apache-2.0 with an LGPL arch child), and in that case
 *      the variant block is KEPT so a license is never silently dropped.
 *
 * Peer reference: VS Code's `build/azure-pipelines/oss/scan-licenses.ts` solves
 * the same per-arch parity gap and only reuses a parent's license text across
 * arch siblings when the SPDX license ids match exactly.
 */

'use strict'

const fs = require('fs')
const path = require('path')

// Per-platform native sub-package suffix: `-<os>-<arch>` with an optional ABI
// tag, e.g. `-darwin-arm64`, `-win32-x64`, `-linux-x64-glibc`, `-linux-arm64-musl`.
const PLATFORM_SUFFIX_RE = /-(?:darwin|win32|linux)-(?:arm64|x64|ia32|arm)(?:-(?:glibc|musl|eabi|eabihf))?$/

// A notices block header line: "<package-name> <semver>". Anchored to the whole
// line so license prose never matches.
const HEADER_RE = /^(@?[a-z0-9][\w.-]*(?:\/[\w.-]+)?)[ ]+(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)$/

function normalizeWhitespace(input) {
  return input.replace(/\r\n?/g, '\n').replace(/[ \t]+$/gm, '')
}

// Split plainVertical notices text into blocks. A block runs from one header
// line up to (but not including) the next header line, so its body (license id +
// text + the trailing blank-line separator) is preserved verbatim. Rejoining the
// kept blocks with a single "\n" reproduces the original two-blank-line layout.
// `licenseId` is the first body line after the header.
function parseBlocks(text) {
  const lines = text.split('\n')
  const blocks = []
  let current = null
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const prevBlank = i === 0 || lines[i - 1].trim() === ''
    const headerMatch = prevBlank ? line.match(HEADER_RE) : null
    if (headerMatch) {
      if (current) blocks.push(current)
      current = { name: headerMatch[1], version: headerMatch[2], lines: [line] }
    } else if (current) {
      current.lines.push(line)
    } else {
      // Any preamble before the first header (none expected) is kept verbatim.
      current = { name: null, version: null, lines: [line] }
    }
  }
  if (current) blocks.push(current)
  return blocks.map((block) => ({
    name: block.name,
    version: block.version,
    licenseId: block.name ? (block.lines[1] || '').trim() : null,
    text: block.lines.join('\n'),
  }))
}

function dropPlatformVariantBlocks(text) {
  const blocks = parseBlocks(text)
  // Map "name@version" -> licenseId for every block present so a variant can
  // look up its platform-neutral base.
  const licenseByKey = new Map()
  for (const block of blocks) {
    if (block.name) licenseByKey.set(`${block.name}@${block.version}`, block.licenseId)
  }
  let dropped = false
  const kept = blocks.filter((block) => {
    if (!block.name || !PLATFORM_SUFFIX_RE.test(block.name)) return true
    const base = block.name.replace(PLATFORM_SUFFIX_RE, '')
    if (base === block.name) return true
    const baseLicense = licenseByKey.get(`${base}@${block.version}`)
    // Collapse onto the base only when it exists at the same version AND the
    // license ids match; otherwise keep the variant (fail-safe).
    if (baseLicense !== undefined && baseLicense === block.licenseId) {
      dropped = true
      return false
    }
    return true
  })
  // No-op when nothing was dropped so an already-clean file round-trips byte-for-byte.
  if (!dropped) return text
  return kept.map((block) => block.text).join('\n')
}

function normalizeNotices(input) {
  const whitespaceNormalized = normalizeWhitespace(input)
  const collapsed = dropPlatformVariantBlocks(whitespaceNormalized)
  // Guarantee exactly one trailing newline.
  return collapsed.replace(/\n*$/, '\n')
}

function main() {
  const target = path.join(__dirname, '..', 'ThirdPartyNotices.txt')
  const before = fs.readFileSync(target, 'utf8')
  const after = normalizeNotices(before)
  if (before !== after) {
    fs.writeFileSync(target, after)
  }
}

if (require.main === module) {
  main()
}

module.exports = {
  normalizeNotices,
  dropPlatformVariantBlocks,
  parseBlocks,
  normalizeWhitespace,
}
