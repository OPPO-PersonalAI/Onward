/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

import type { AutotestContext, TestResult } from './types'

/**
 * Infrastructure-watchdog end-to-end autotest (2026-07-20 incident class).
 *
 * Drives the simulated threadpool-stall path (the genuine lost-wakeup
 * stall is only reproducible on POSIX and is locked at the unit layer by
 * threadpool-stall-probe.test.mts) and asserts the downstream wiring that
 * must fire on every platform:
 *   IWD-01  baseline health snapshot: threadpool ok + pty write mode
 *   IWD-02  simulate stall → snapshot flips to 'stalled'
 *   IWD-03  degradation banner appears with the i18n copy
 *   IWD-04  simulate recovery → banner clears
 *   IWD-05  snapshot flips back to ok
 *   IWD-06  visibility watchdog probe transport healthy (visibility 'ok')
 *
 * Health is read via the DEBUG_GET_INFRA_HEALTH IPC — the exact snapshot
 * /api/health serializes. The renderer cannot fetch the local HTTP
 * endpoint directly (file:// origin; CORS is deliberately NOT enabled on
 * the api server — allowing it would let arbitrary web pages probe the
 * local port).
 */
export async function testInfraWatchdog(ctx: AutotestContext): Promise<TestResult[]> {
  const { assert, log, sleep } = ctx
  const results: TestResult[] = []
  const record = (name: string, ok: boolean, detail?: Record<string, unknown>) => {
    assert(name, ok, detail)
    results.push({ name, ok, detail })
  }

  log('infra-watchdog-test:start')

  const health = () => window.electronAPI.debug.getInfraHealth()

  // IWD-01: baseline snapshot carries the watchdog fields.
  const baseline = await health()
  record('IWD-01-health-baseline', baseline.threadpool.status === 'ok' && typeof baseline.ptyWriteMode === 'string', {
    threadpool: baseline.threadpool.status,
    ptyWriteMode: baseline.ptyWriteMode,
    visibility: baseline.visibility.status
  })

  // IWD-02: simulated stall flips the snapshot.
  const stallReply = await window.electronAPI.debug.simulateThreadpoolStall(true)
  await sleep(300)
  const stalled = await health()
  record('IWD-02-health-stalled', stallReply.success === true && stalled.threadpool.status === 'stalled', {
    stallReply,
    threadpool: stalled.threadpool.status
  })

  // IWD-03: degradation banner appears with the expected copy. Autotests run
  // under the default `en` locale only, so assert the English string; the
  // zh-CN key parity is locked by the i18n dictionary itself.
  // The broadcast is push-based; poll the DOM briefly instead of one sleep.
  let banner: Element | null = null
  for (let i = 0; i < 20 && !banner; i++) {
    banner = document.querySelector('.tab-bar-stall-banner')
    if (!banner) await sleep(100)
  }
  const bannerText = banner?.textContent ?? ''
  record('IWD-03-banner-visible', Boolean(banner), { bannerText: bannerText.slice(0, 120) })
  record(
    'IWD-03b-banner-copy',
    bannerText.includes('internal service'),
    { bannerText: bannerText.slice(0, 120) }
  )

  // IWD-04: recovery clears the banner.
  await window.electronAPI.debug.simulateThreadpoolStall(false)
  let bannerGone = false
  for (let i = 0; i < 20 && !bannerGone; i++) {
    bannerGone = document.querySelector('.tab-bar-stall-banner') === null
    if (!bannerGone) await sleep(100)
  }
  record('IWD-04-banner-cleared', bannerGone)

  // IWD-05: health returns to ok.
  const recovered = await health()
  record('IWD-05-health-recovered', recovered.threadpool.status === 'ok', { threadpool: recovered.threadpool.status })

  // IWD-06: visibility watchdog probe transport. The main-side watchdog
  // probes the preload responder; in a healthy visible autotest window the
  // snapshot must be 'ok' (a wedged transport would surface 'nudging' /
  // 'gave-up' after its checks). This locks the probe plumbing end-to-end;
  // the mismatch/nudge ladder itself is locked by the unit decision table.
  record('IWD-06-visibility-transport', recovered.visibility.status === 'ok', { visibility: recovered.visibility.status })

  log('infra-watchdog-test:done')
  return results
}
