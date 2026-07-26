/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * RC-2 "Git timed out on this directory" UI state + retry-escapes-backoff
 * E2E (G5, 2026-07-24 review of the windows-powershell-bug merge).
 *
 * A real hanging volume has no deterministic fixture (see test/README.md § 3
 * timeout-triage), so the timeout classification is SEEDED via the
 * ONWARD_AUTOTEST-gated `debug:autotest-poison-repo-probe` hook: the repo
 * cwd's meta-cache entry is overwritten with a strike-3 timeout negative
 * (5-minute backoff TTL). Chain under test:
 *
 *   poisoned cache → git:getDiff → repoProbe='timeout' → dedicated warning
 *   state (NOT "not a repo") → Retry → loadGitDiff force clears the
 *   timeout entry (escape hatch, git-utils.ts::loadGitDiff) → real probe
 *   succeeds on the actual repo → normal diff renders.
 *
 * The pure ladder/classifier logic is locked by git-meta-cache-policy.test.mts;
 * THIS suite locks the renderer state machine and the escape hatch wiring.
 */

import type { AutotestContext, TestResult } from './types'

export async function testGitDiffProbeTimeout(ctx: AutotestContext): Promise<TestResult[]> {
  const { assert, cancelled, log, rootPath, sleep, terminalId, waitFor } = ctx
  const results: TestResult[] = []
  const record = (name: string, ok: boolean, detail?: Record<string, unknown>) => {
    assert(name, ok, detail)
    results.push({ name, ok, detail })
  }

  const getGitDiffApi = () => window.__onwardGitDiffDebug
  const warningTitle = () =>
    document.querySelector('.git-diff-warning-title')?.textContent ?? ''

  // Prefer the explicit ONWARD_AUTOTEST_CWD (Windows-native form) — under a
  // Git Bash runner `rootPath` can arrive in a shape whose resolve() differs
  // from the cwd the diff path actually queries with.
  const poisonTarget = window.electronAPI.debug.autotestCwd || rootPath
  log('git-diff-probe-timeout:start', { rootPath, poisonTarget })

  // Install the probe interceptor BEFORE opening: every probe for this cwd
  // classifies as 'timeout' for the next 30 s — surviving the force-path
  // escape hatch (clear + re-probe), exactly like a real hanging volume.
  const poisoned = await window.electronAPI.debug.poisonRepoProbeForAutotest({
    cwd: poisonTarget,
    durationMs: 30_000
  })
  record('GPT-00-poison-hook', poisoned.ok === true, { poisoned, poisonTarget })
  if (!poisoned.ok || cancelled()) return results

  window.dispatchEvent(new CustomEvent('git-diff:open', { detail: { terminalId, source: 'debug' } }))
  const opened = await waitFor('probe-timeout-diff-open', () => {
    const api = getGitDiffApi()
    return Boolean(api?.isOpen && api.isOpen())
  }, 8000)
  record('GPT-01-diff-opened', opened, {})
  if (!opened || cancelled()) return results

  // The dedicated timed-out state must render — and it must NOT be the
  // "not a git repository" misfile the RC-2 fix eliminated.
  const timedOutShown = await waitFor('probe-timeout-warning-visible', () => {
    return warningTitle().includes('Git timed out')
  }, 10_000, 150)
  record('GPT-02-timed-out-state-rendered', timedOutShown, {
    title: warningTitle(),
    repoRoot: getGitDiffApi()?.getRepoRoot?.() ?? null,
    fileCount: getGitDiffApi()?.getFileList?.()?.length ?? null,
    poisonTarget
  })
  if (!timedOutShown || cancelled()) return results

  // Lift the interceptor (the "volume recovered" moment), then Retry must
  // ESCAPE the backoff entry the forced timeouts cached: loadGitDiff force
  // clears it, the now-healthy probe succeeds, and the normal diff view
  // replaces the warning. A regression that drops the escape hatch leaves
  // the warning up for the remaining backoff TTL.
  const lifted = await window.electronAPI.debug.poisonRepoProbeForAutotest({
    cwd: poisonTarget,
    durationMs: 0
  })
  record('GPT-03a-interceptor-lifted', lifted.ok === true, { lifted })

  const retryButton = Array.from(document.querySelectorAll<HTMLButtonElement>('.git-diff-close-btn'))
    .find((btn) => btn.textContent?.trim() === 'Retry')
  record('GPT-03-retry-button-present', Boolean(retryButton), {})
  if (!retryButton || cancelled()) return results
  retryButton.click()

  const recovered = await waitFor('probe-timeout-retry-recovers', () => {
    const api = getGitDiffApi()
    if (!api?.getRepoRoot) return false
    return Boolean(api.getRepoRoot()) && !warningTitle().includes('Git timed out')
  }, 15_000, 200)
  record('GPT-04-retry-escapes-backoff', recovered, {
    repoRoot: getGitDiffApi()?.getRepoRoot?.() ?? null,
    title: warningTitle()
  })

  window.dispatchEvent(new CustomEvent('git-diff:close', { detail: { terminalId } }))
  await sleep(300)

  log('git-diff-probe-timeout:done', {
    total: results.length,
    passed: results.filter(result => result.ok).length,
    failed: results.filter(result => !result.ok).length
  })

  return results
}
