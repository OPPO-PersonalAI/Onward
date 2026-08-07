#!/usr/bin/env node
/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 *
 * Cross-platform driver that runs every unit test under `test/unittest/`.
 *
 * Why a custom driver instead of `node --test test/unittest/`:
 *   - 5 files use the `node:test` runner (`*.test.mts`).
 *   - 3 files are standalone scripts that call `assert(...)` at top level
 *     (`*-unit.mjs`).
 *   - 2 files (`coding-agent-*.test.mjs`) define their own collector or
 *     spawn child processes.
 * `node --test` only auto-discovers files matching specific patterns, so
 * the standalone scripts would be silently skipped. Running each file
 * with plain `node --experimental-strip-types <file>` works for all four
 * styles uniformly: a `node:test` import still self-runs in this mode.
 *
 * Usage:
 *   node test/autotest/run-unittest-suite.mjs
 *   pnpm test:unit
 */

import { spawn } from 'node:child_process'
import { readdir } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(__dirname, '..', '..')
const UNITTEST_DIR = resolve(REPO_ROOT, 'test', 'unittest')
const PER_FILE_TIMEOUT_MS = 60_000
const requireFromRunner = createRequire(import.meta.url)
const RUNTIME_TEST_PACKAGES = [
  {
    name: 'typescript',
    usedBy: [
      'main-work-scheduler-unit.mjs',
      'renderer-work-scheduler-unit.mjs',
      'terminal-output-scheduler-unit.mjs',
    ],
  },
  {
    // Real scope analysis behind the viewer module-boundary guard
    // (js-scope-analysis.mts). devDependency; a checkout without it should
    // fail the preflight with a clear message, not a resolution stack.
    name: 'acorn',
    usedBy: ['pdf-viewer-module-boundaries.test.mts'],
  },
]

async function discoverUnitTests() {
  const entries = await readdir(UNITTEST_DIR, { withFileTypes: true })
  return entries
    .filter((e) => e.isFile() && (e.name.endsWith('.mjs') || e.name.endsWith('.mts')))
    .map((e) => e.name)
    .sort()
}

function packageInstalled(packageName) {
  try {
    requireFromRunner.resolve(`${packageName}/package.json`)
    return true
  } catch {
    return false
  }
}

function runPreflight(files) {
  const missing = []
  for (const pkg of RUNTIME_TEST_PACKAGES) {
    if (!pkg.usedBy.some((file) => files.includes(file))) continue
    if (!packageInstalled(pkg.name)) missing.push(pkg)
  }
  if (missing.length === 0) return

  console.error('ERROR: unit-test runtime dependencies are not installed.')
  console.error(`Working dir: ${REPO_ROOT}`)
  for (const pkg of missing) {
    console.error(`  - Missing package "${pkg.name}" required by ${pkg.usedBy.join(', ')}`)
  }
  console.error('')
  console.error('Install project dependencies first:')
  console.error('  pnpm install --frozen-lockfile')
  process.exit(1)
}

function runOne(file) {
  return new Promise((resolveResult) => {
    const start = Date.now()
    const filePath = resolve(UNITTEST_DIR, file)
    const child = spawn(
      process.execPath,
      ['--experimental-strip-types', '--no-warnings=ExperimentalWarning', filePath],
      { cwd: REPO_ROOT, stdio: 'inherit' },
    )
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGTERM')
      setTimeout(() => child.kill('SIGKILL'), 3000).unref()
    }, PER_FILE_TIMEOUT_MS)
    child.on('exit', (code, signal) => {
      clearTimeout(timer)
      const elapsed = ((Date.now() - start) / 1000).toFixed(2)
      resolveResult({
        file,
        ok: !timedOut && code === 0,
        code,
        signal,
        timedOut,
        elapsed,
      })
    })
  })
}

async function main() {
  const files = await discoverUnitTests()
  if (files.length === 0) {
    console.error(`ERROR: no unit-test files found under ${UNITTEST_DIR}`)
    process.exit(1)
  }
  runPreflight(files)

  console.log(`=== Unit-test suite: ${files.length} file(s) ===`)
  console.log(`Working dir: ${REPO_ROOT}`)
  console.log(`Per-file timeout: ${PER_FILE_TIMEOUT_MS / 1000}s`)
  console.log('')

  const results = []
  for (const file of files) {
    console.log(`--- ${file} ---`)
    const r = await runOne(file)
    results.push(r)
    const tag = r.ok
      ? 'PASS'
      : r.timedOut
        ? 'TIMEOUT'
        : `FAIL(exit=${r.code}${r.signal ? `, signal=${r.signal}` : ''})`
    console.log(`[${tag}] ${file} (${r.elapsed}s)`)
    console.log('')
  }

  const passed = results.filter((r) => r.ok).length
  const failed = results.length - passed
  console.log('=== Result List ===')
  for (const r of results) {
    const tag = r.ok ? 'PASS' : r.timedOut ? 'TIMEOUT' : 'FAIL'
    console.log(`  [${tag}] ${r.file} (${r.elapsed}s)`)
  }
  console.log('')
  console.log(`Summary: ${passed}/${results.length} passed, ${failed} failed`)

  process.exit(failed === 0 ? 0 : 1)
}

main().catch((err) => {
  console.error('FATAL:', err)
  process.exit(1)
})
