/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

import { existsSync } from 'fs'
import { createRequire } from 'module'
import { app } from 'electron'
import { performanceTrace } from './performance-trace'
import { PERF_TRACE_EVENT } from '../../src/utils/perf-trace-names'

/**
 * Shared resolution of the bundled ripgrep binary.
 *
 * Extracted from `ripgrep-search.ts` when the project file index became a
 * second consumer (`rg --files` is how the index honours `.gitignore`). The
 * resolution chain below is load-bearing and hard-won — pnpm's strict layout,
 * asar unpacking, and `require(ESM)` support all bite here — so it must exist
 * exactly once. A second copy would drift the moment one of those constraints
 * changes.
 */

/**
 * Resolve the absolute path of the bundled ripgrep binary.
 *
 * `@vscode/ripgrep` >= 1.18.0 ships the binary inside a per-platform package
 * (`@vscode/ripgrep-<platform>-<arch>/bin/rg[.exe]`), pre-extracted and
 * SHA256-verified at publish time — there is no install-time download/unzip
 * step left to corrupt it (the old yauzl streaming-inflate path that truncated
 * rg.exe on Node 24 is gone). We resolve that platform package's binary file
 * directly so this CJS main-process bundle never has to `require()` the
 * wrapper's ESM `lib/index.js` (avoids any dependency on the Electron runtime
 * supporting `require(ESM)`). The wrapper export stays as a fallback.
 */
function resolveRipgrepBinaryPath(): string {
  const arch = process.arch
  const binaryName = process.platform === 'win32' ? 'rg.exe' : 'rg'
  const platformSpecifier = `@vscode/ripgrep-${process.platform}-${arch}/bin/${binaryName}`

  // (1) Direct resolve — works in a hoisted/flat node_modules (npm, or pnpm
  // with shamefully-hoist). Cheapest path.
  try {
    return require.resolve(platformSpecifier)
  } catch {
    // fall through
  }

  // (2) Resolve via the wrapper's own location. Under pnpm's strict layout the
  // per-platform package is NOT hoisted to top-level node_modules — it is only
  // resolvable from WITHIN @vscode/ripgrep (which declares it). createRequire
  // scoped to the wrapper's manifest mirrors exactly what the wrapper's ESM
  // lib/index.js does, but stays in CJS so this main-process bundle never has to
  // require(ESM). The wrapper itself is a direct dependency, so it resolves.
  try {
    // require.resolve only RESOLVES the path (it does not load the ESM module),
    // so this is safe from CJS. 1.18.0's `exports` map blocks `/package.json`,
    // so resolve the package entry itself and scope createRequire to it.
    const wrapperEntry = require.resolve('@vscode/ripgrep')
    return createRequire(wrapperEntry).resolve(platformSpecifier)
  } catch {
    // fall through
  }

  // (3) Last resort: the wrapper's exported rgPath (needs the runtime to support
  // require(ESM), e.g. Node >= 22.12). Emit a breadcrumb so a global-search bug
  // report shows the resolution degraded to this path.
  performanceTrace.record(PERF_TRACE_EVENT.WORKER_RIPGREP_PLATFORM_RESOLVE_FALLBACK, {
    platformSpecifier
  })
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  return (require('@vscode/ripgrep') as { rgPath: string }).rgPath
}

/**
 * Resolve a ripgrep path that is actually executable in this build, accounting
 * for asar unpacking in packaged apps. Returns a bare `'rg'` (PATH lookup) as a
 * last resort so a missing bundle degrades instead of hard-failing.
 */
export function resolveRipgrepPath(): string {
  try {
    const rgPath = resolveRipgrepBinaryPath()
    const unpackedPath = app.isPackaged ? rgPath.replace('app.asar', 'app.asar.unpacked') : rgPath
    if (existsSync(unpackedPath)) return unpackedPath
    if (existsSync(rgPath)) return rgPath
    performanceTrace.record(PERF_TRACE_EVENT.WORKER_RIPGREP_BINARY_MISSING, {
      rgPath,
      unpackedPath,
      fallback: 'rg'
    })
    return 'rg'
  } catch {
    // Neither the platform package nor the wrapper could be resolved. Fall back
    // to a bare 'rg' on PATH and leave a breadcrumb for incident triage.
    performanceTrace.record(PERF_TRACE_EVENT.WORKER_RIPGREP_BINARY_MISSING, {
      reason: 'resolve-threw',
      fallback: 'rg'
    })
    return 'rg'
  }
}
