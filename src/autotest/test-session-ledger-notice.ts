/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 *
 * Session-ledger abnormal-exit notice (SLN-01..03). Runner-orchestrated:
 * the infra-watchdog runner SIGKILLs a prior app instance against the same
 * scratch userData, then launches this suite — so the ledger judged at THIS
 * startup must read 'abnormal' and the TabBar must show the notice banner.
 * (The clean path is implicitly locked by every other autotest: a graceful
 * debug-quit marks the ledger clean, so this suite launched WITHOUT a prior
 * kill would fail SLN-01 — which is exactly the regression we want caught.)
 */

import type { AutotestContext, TestResult } from './types'

export async function testSessionLedgerNotice(ctx: AutotestContext): Promise<TestResult[]> {
  const { assert, log, sleep } = ctx
  const results: TestResult[] = []
  const record = (name: string, ok: boolean, detail?: Record<string, unknown>) => {
    assert(name, ok, detail)
    results.push({ name, ok, detail })
  }

  log('session-ledger-notice-test:start')

  // SLN-01: the previous (SIGKILLed) instance is judged abnormal.
  const notice = await window.electronAPI.system.getPreviousSessionNotice()
  record('SLN-01-abnormal-detected', notice !== null && notice.kind === 'abnormal', { notice })

  // SLN-02: the TabBar shows the notice banner with the en copy.
  let banner: Element | null = null
  for (let i = 0; i < 20 && !banner; i++) {
    banner = document.querySelector('[data-testid="previous-session-banner"]')
    if (!banner) await sleep(100)
  }
  const bannerText = banner?.textContent ?? ''
  record('SLN-02-banner-visible', Boolean(banner) && bannerText.includes('ended unexpectedly'), {
    bannerText: bannerText.slice(0, 120)
  })

  // SLN-03: dismiss removes the banner.
  const dismiss = banner?.querySelector('button.tab-bar-update-close') as HTMLButtonElement | null
  dismiss?.click()
  let gone = false
  for (let i = 0; i < 10 && !gone; i++) {
    gone = document.querySelector('[data-testid="previous-session-banner"]') === null
    if (!gone) await sleep(100)
  }
  record('SLN-03-banner-dismissed', gone)

  log('session-ledger-notice-test:done')
  return results
}
